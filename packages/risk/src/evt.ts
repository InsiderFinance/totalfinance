import { ensureEnumWhenPresent, ensureFiniteWhenPresent } from './options-internal.js';
/**
 * EVT tail-risk pack (spec: `docs/specs/evt-tail-risk.md`, roadmap Tier 2 → Tail machinery). The
 * honest fat-tail toolkit: normal and historical VaR under-state the left tail exactly where the risk
 * lives, so this fits the *shape of the tail itself* with a Generalized Pareto Distribution
 * (peaks-over-threshold, justified by the Pickands–Balkema–de Haan theorem) and reads extreme VaR / ES
 * off it — always shown beside the empirical and normal numbers so the fat-tail gap is explicit.
 *
 * - `fitGeneralizedParetoTail` — GPD fit of the loss tail (robust PWM by default, MLE optional with PWM fallback).
 * - `extremeValueTailRisk`  — EVT VaR + Expected Shortfall (MonteCarloNeil–Frey POT), vs empirical vs normal.
 * - `drawdownAtRisk` — Drawdown-at-Risk + Conditional Drawdown-at-Risk (Chekhlov–Uryasev).
 * - `spectralRisk` — a coherent spectral risk measure (Acerbi); ES is the flat-tail special case.
 *
 * Pure functions of a return series; nothing fetches data.
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { mean, nelderMead, normalInverseCdf, quantile, variance } from '@totalfinance/math';
import { maxDrawdownFromReturns, underwater } from '@totalfinance/performance';

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const normalPdf = (z: number): number => Math.exp(-0.5 * z * z) / SQRT_2PI;

/**
 * Hard cap on the mean-excess grid (2026-08-23 review, P0): `gridSize` sizes the threshold array
 * and each threshold rescans the entire loss sample, so an "integer" of 1e308 was an absurd
 * allocation and O(gridSize × n) of unbounded synchronous work. See the guard in meanExcessPlot.
 */
const MAX_MEAN_EXCESS_GRID_SIZE = 10_000;

// ─────────────────────────────── shared input handling ───────────────────────────────

/** Validate a return series and convert to losses `x = −r` (the left tail we care about). */
function toLosses(returns: ArrayLike<number>, functionName: string): number[] {
  requireArgumentArray(functionName, 'returns', returns);
  const n = returns.length;
  if (n < 2) {
    throw new InputError(`${functionName}: need ≥ 2 returns; got ${n}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { observations: n },
    });
  }
  const losses = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const r = returns[i]!;
    if (!Number.isFinite(r)) {
      throw new InputError(`${functionName}: returns must be finite; returns[${i}] = ${r}.`, {
        code: ErrorCode.InputNotFinite,
        context: { index: i, value: r },
      });
    }
    losses[i] = -r;
  }
  return losses;
}

function requireConfidence(c: number, functionName: string): void {
  if (!(c > 0 && c < 1)) {
    throw new InputError(`${functionName}: confidence must be in (0, 1); got ${c}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { confidence: c },
    });
  }
}

// ─────────────────────────────── GPD core ───────────────────────────────

/**
 * Probability-weighted-moment (Hosking & Wallis 1987) GPD estimator on the excesses `y > 0`:
 * `ξ = 2 − a₀/(a₀ − 2a₁)`, `β = 2·a₀·a₁/(a₀ − 2a₁)`, with `a₀ = mean(y)` and
 * `a₁ = (1/N)·Σ (1 − (i−0.35)/N)·y₍ᵢ₎` over ascending order statistics. Closed form, no convergence risk.
 */
function pwmFit(excesses: number[]): { shape: number; scale: number } | null {
  const nu = excesses.length;
  const sorted = [...excesses].sort((a, b) => a - b);
  let a0 = 0;
  let a1 = 0;
  for (let i = 0; i < nu; i++) {
    a0 += sorted[i]!;
    a1 += (1 - (i + 1 - 0.35) / nu) * sorted[i]!;
  }
  a0 /= nu;
  a1 /= nu;
  const denom = a0 - 2 * a1;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-15) return null; // degenerate — guarded
  const shape = 2 - a0 / denom;
  const scale = (2 * a0 * a1) / denom;
  if (!(scale > 0) || !Number.isFinite(shape)) return null;
  return { shape, scale };
}

/** GPD negative log-likelihood of the excesses at `(ξ, β)`; a large finite penalty on infeasible points. */
function gpdNegLogLik(excesses: number[], shape: number, scale: number): number {
  if (!(scale > 0)) return 1e300;
  const nu = excesses.length;
  let sumLog = 0;
  for (let i = 0; i < nu; i++) {
    const z = 1 + (shape * excesses[i]!) / scale;
    if (z <= 0) return 1e300; // outside the support — infeasible
    sumLog += Math.log(z);
  }
  if (Math.abs(shape) < 1e-8) {
    // Exponential limit: (1+1/ξ)·Σln(1+ξy/β) → Σ y/β.
    let sumY = 0;
    for (let i = 0; i < nu; i++) sumY += excesses[i]!;
    return nu * Math.log(scale) + sumY / scale;
  }
  return nu * Math.log(scale) + (1 + 1 / shape) * sumLog;
}

/**
 * Maximum-likelihood GPD fit via Nelder–Mead started at the PWM estimate. Returns `null` on
 * non-convergence or an infeasible optimum so the caller can fall back to PWM (never a silent bad fit).
 */
function mleFit(
  excesses: number[],
  start: { shape: number; scale: number },
): {
  shape: number;
  scale: number;
} | null {
  const res = nelderMead(
    ([xi, beta]) => gpdNegLogLik(excesses, xi!, beta!),
    [start.shape, start.scale],
    {
      tolerance: 1e-10,
      maximumIterations: 800,
    },
  );
  if (!res.converged) return null;
  const [shape, scale] = res.argMin as [number, number];
  if (!(scale > 0) || !Number.isFinite(shape) || res.minimum >= 1e299) return null;
  return { shape, scale };
}

/** Options for {@link fitGeneralizedParetoTail}. */
export interface GeneralizedParetoFitOptions {
  /** Worst fraction of losses used as exceedances; default 0.10. Ignored when `threshold` is set. */
  tailFraction?: number;
  /** Explicit loss threshold `u` (overrides `tailFraction`). */
  threshold?: number;
  /** Estimator; default `'pwm'` (closed-form, robust). */
  method?: 'pwm' | 'mle';
  /** Exceedance count below which the fit is warned as unreliable; default 10. */
  minExceedances?: number;
}

/** The documented {@link GeneralizedParetoFitOptions} keys — Law 12: an unknown option must throw, never no-op. */
const GPD_FIT_OPTIONS_KEYS = ['tailFraction', 'threshold', 'method', 'minExceedances'] as const;

/** {@link extremeValueTailRisk} adds `confidence` to the GPD-fit knobs. */
const EVT_TAIL_RISK_OPTIONS_KEYS = ['confidence', ...GPD_FIT_OPTIONS_KEYS] as const;

/** A fitted Generalized Pareto tail. */
export interface GeneralizedParetoFit {
  /** Tail index `ξ` — `> 0` heavy, `0` exponential, `< 0` finite endpoint. */
  shape: number;
  /** Scale `β > 0`. */
  scale: number;
  /** Loss threshold `u` above which the GPD is fitted. */
  threshold: number;
  /** Number of exceedances `Nu` over the threshold. */
  exceedances: number;
  /** Total number of losses. */
  observationCount: number;
  /** `Nu / observationCount` — the realized tail fraction. */
  tailFraction: number;
  /** The estimator that actually produced the fit (`'mle'` may fall back to `'pwm'`). */
  method: 'pwm' | 'mle';
  assumptions: { conventionsVersion: string; estimator: 'pwm' | 'mle' };
  diagnostics: Diagnostics;
}

interface ThresholdFit {
  fit: GeneralizedParetoFit;
  losses: number[];
  excesses: number[];
}

/** Shared: extract exceedances, fit the GPD, assemble the `GeneralizedParetoFit` with warnings. */
function fitTail(
  returns: ArrayLike<number>,
  options: GeneralizedParetoFitOptions,
  functionName: string,
): ThresholdFit {
  requireArgumentObject(functionName, 'options', options);
  ensureEnumWhenPresent(options.method, 'evt', 'method', ['pwm', 'mle']);
  const method = options.method ?? 'pwm';
  if (method !== 'pwm' && method !== 'mle') {
    throw new InputError(`${functionName}: method must be 'pwm' or 'mle'; got ${String(method)}.`, {
      code: ErrorCode.InputInvalidEnum,
      context: { method },
    });
  }
  ensureFiniteWhenPresent(options.minExceedances, 'minExceedances', 'evt');
  const minExceedances = options.minExceedances ?? 10;
  const losses = toLosses(returns, functionName);
  const n = losses.length;

  let threshold: number;
  if (options.threshold !== undefined) {
    if (!Number.isFinite(options.threshold)) {
      throw new InputError(`${functionName}: threshold must be finite; got ${options.threshold}.`, {
        code: ErrorCode.InputNotFinite,
        context: { threshold: options.threshold },
      });
    }
    threshold = options.threshold;
  } else {
    ensureFiniteWhenPresent(options.tailFraction, 'tailFraction', 'evt');
    const tailFraction = options.tailFraction ?? 0.1;
    if (!(tailFraction > 0 && tailFraction < 1)) {
      throw new InputError(
        `${functionName}: tailFraction must be in (0, 1); got ${tailFraction}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { tailFraction },
        },
      );
    }
    threshold = quantile(losses, 1 - tailFraction);
  }

  const excesses: number[] = [];
  for (let i = 0; i < n; i++) if (losses[i]! > threshold) excesses.push(losses[i]! - threshold);
  const nu = excesses.length;
  if (nu < 2) {
    throw new InputError(
      `${functionName}: only ${nu} loss(es) exceed the threshold — need ≥ 2 to fit a GPD. Raise tailFraction or provide more data.`,
      { code: ErrorCode.InputOutOfRange, context: { exceedances: nu, threshold } },
    );
  }

  const warnings: QuantWarning[] = [];
  const pwm = pwmFit(excesses);
  let fitted = pwm;
  let usedMethod: 'pwm' | 'mle' = 'pwm';
  if (method === 'mle') {
    const mle = pwm !== null ? mleFit(excesses, pwm) : null;
    if (mle !== null) {
      fitted = mle;
      usedMethod = 'mle';
    } else {
      warnings.push(
        warning(
          WarningCode.RiskExtremeValueMleFallback,
          `${functionName}: the MLE did not converge to a feasible GPD; falling back to the PWM estimate.`,
          'warn',
        ),
      );
    }
  }
  if (fitted === null) {
    throw new InputError(
      `${functionName}: the exceedances are degenerate (near-constant); the GPD is not identifiable.`,
      { code: ErrorCode.InputOutOfRange, context: { exceedances: nu } },
    );
  }

  if (nu < minExceedances) {
    warnings.push(
      warning(
        WarningCode.RiskExtremeValueFewExceedances,
        `${functionName}: only ${nu} exceedances (< ${minExceedances}); the tail fit is unreliable — use a larger sample or tailFraction.`,
        'warn',
      ),
    );
  }
  if (Math.abs(fitted.shape) > 10) {
    // No real financial tail has |ξ| this large; near-constant exceedances drive the estimator to an
    // absurd shape. Disclose rather than return it as a real tail (design law #4: no silent degradation).
    warnings.push(
      warning(
        WarningCode.RiskExtremeValueDegenerateFit,
        `${functionName}: |ξ| = ${Math.abs(fitted.shape).toFixed(1)} is implausibly large — the exceedances are near-degenerate (nearly constant), so the tail fit is meaningless. Treat the result as unusable.`,
        'warn',
      ),
    );
  }
  if (fitted.shape >= 1) {
    warnings.push(
      warning(
        WarningCode.RiskExtremeValueInfiniteMean,
        `${functionName}: fitted tail index ξ = ${fitted.shape.toFixed(3)} ≥ 1 — the tail mean diverges, so Expected Shortfall is infinite.`,
        'warn',
      ),
    );
  } else if (fitted.shape >= 0.5) {
    warnings.push(
      warning(
        WarningCode.RiskExtremeValueInfiniteVariance,
        `${functionName}: fitted tail index ξ = ${fitted.shape.toFixed(3)} ≥ 0.5 — the tail variance is infinite (extremely heavy tail).`,
        'info',
      ),
    );
  }

  const fit: GeneralizedParetoFit = {
    shape: fitted.shape,
    scale: fitted.scale,
    threshold,
    exceedances: nu,
    observationCount: n,
    tailFraction: nu / n,
    method: usedMethod,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, estimator: usedMethod },
    diagnostics: { engine: 'evt-gpd', method: usedMethod, converged: true, warnings },
  };
  return { fit, losses, excesses };
}

/**
 * Fit a Generalized Pareto Distribution to the **loss** tail (peaks-over-threshold). Returns the tail
 * index `ξ`, scale `β`, threshold, and exceedance count, with warnings for a thin sample or
 * infinite-moment tails. See `docs/specs/evt-tail-risk.md`.
 */
export function fitGeneralizedParetoTail(
  returns: ArrayLike<number>,
  options: GeneralizedParetoFitOptions = {},
): GeneralizedParetoFit {
  // Law 12: a misspelled knob (`tailfraction` running at the 10% default) must throw, never no-op.
  requireArgumentObject('fitGeneralizedParetoTail', 'options', options);
  ensureKnownKeys('fitGeneralizedParetoTail', 'options', options, GPD_FIT_OPTIONS_KEYS);
  return fitTail(returns, options, 'fitGeneralizedParetoTail').fit;
}

// ─────────────────────────────── EVT VaR / ES ───────────────────────────────

/** EVT tail-risk read-out. */
export interface ExtremeValueTailRisk {
  confidence: number;
  /** EVT VaR — a positive loss magnitude. */
  valueAtRisk: number;
  /** EVT Expected Shortfall (`≥ var`; `Infinity` when `ξ ≥ 1`). */
  conditionalValueAtRisk: number;
  /** The empirical (historical) VaR/ES at the same confidence, for comparison. */
  empirical: { valueAtRisk: number; conditionalValueAtRisk: number };
  /** The normal (Gaussian) VaR/ES at the same confidence, for comparison. */
  normal: { valueAtRisk: number; conditionalValueAtRisk: number };
  /** `evt.var / normal.var` — how much fatter the tail is than the Gaussian says. */
  tailFatnessRatio: number;
  /** The underlying GPD fit. */
  fit: GeneralizedParetoFit;
  assumptions: { conventionsVersion: string; confidence: number };
  diagnostics: Diagnostics;
}

/** Empirical (historical) VaR and ES of the loss series at confidence `p`. */
function empiricalTail(
  losses: number[],
  p: number,
): { valueAtRisk: number; conditionalValueAtRisk: number } {
  const v = quantile(losses, p);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < losses.length; i++) {
    if (losses[i]! >= v) {
      sum += losses[i]!;
      count++;
    }
  }
  return { valueAtRisk: v, conditionalValueAtRisk: count > 0 ? sum / count : v };
}

/** Gaussian VaR and ES of the loss series at confidence `p`. */
function normalTail(
  losses: number[],
  p: number,
): { valueAtRisk: number; conditionalValueAtRisk: number } {
  const mu = mean(losses); // mean LOSS (= −mean return)
  const sd = Math.sqrt(variance(losses, { population: false }));
  const z = normalInverseCdf(p);
  return { valueAtRisk: mu + sd * z, conditionalValueAtRisk: mu + (sd * normalPdf(z)) / (1 - p) };
}

/**
 * Extreme-tail VaR and Expected Shortfall via the MonteCarloNeil–Frey peaks-over-threshold method, shown beside
 * the empirical and normal numbers with a fat-tail ratio. When the confidence sits outside the fitted
 * tail (`1 − p ≥ Nu/n`) EVT cannot extrapolate, so the empirical quantile is reported with a warning
 * instead of a fabricated EVT number. See `docs/specs/evt-tail-risk.md`.
 */
export function extremeValueTailRisk(
  returns: ArrayLike<number>,
  options: { confidence?: number } & GeneralizedParetoFitOptions = {},
): ExtremeValueTailRisk {
  const functionName = 'extremeValueTailRisk';
  requireArgumentObject(functionName, 'options', options);
  // Law 12: a misspelled knob (`confdence` running at the 0.99 default) must throw, never no-op.
  ensureKnownKeys(functionName, 'options', options, EVT_TAIL_RISK_OPTIONS_KEYS);
  ensureFiniteWhenPresent(options.confidence, 'confidence', 'extremeValueTailRisk');
  const confidence = options.confidence ?? 0.99;
  requireConfidence(confidence, functionName);

  const { fit, losses } = fitTail(returns, options, functionName);
  const { shape: xi, scale: beta, threshold: u, exceedances: nu, observationCount } = fit;
  const warnings: QuantWarning[] = [...fit.diagnostics.warnings];

  const empirical = empiricalTail(losses, confidence);
  const normal = normalTail(losses, confidence);

  let extremeValueVar: number;
  let extremeValueCvar: number;
  const tailProb = 1 - confidence;
  if (tailProb >= nu / observationCount) {
    // Not deep enough to be in the fitted tail — do not extrapolate; report the empirical quantile.
    warnings.push(
      warning(
        WarningCode.RiskExtremeValueConfidenceOutsideTail,
        `${functionName}: confidence ${confidence} implies a tail probability ${tailProb.toFixed(4)} ≥ the fitted tail fraction ${(nu / observationCount).toFixed(4)}; EVT cannot extrapolate there, so the empirical VaR/ES is reported.`,
        'warn',
      ),
    );
    extremeValueVar = empirical.valueAtRisk;
    extremeValueCvar = empirical.conditionalValueAtRisk;
  } else {
    // MonteCarloNeil–Frey POT quantile + ES.
    extremeValueVar =
      xi === 0
        ? u + beta * Math.log(nu / (observationCount * tailProb))
        : u + (beta / xi) * (Math.pow((observationCount / nu) * tailProb, -xi) - 1);
    if (xi >= 1) {
      extremeValueCvar = Infinity; // tail mean diverges (already warned in the fit)
    } else {
      extremeValueCvar = extremeValueVar / (1 - xi) + (beta - xi * u) / (1 - xi);
    }
  }

  const tailFatnessRatio =
    normal.valueAtRisk !== 0 ? extremeValueVar / normal.valueAtRisk : Number.NaN;

  return {
    confidence,
    valueAtRisk: extremeValueVar,
    conditionalValueAtRisk: extremeValueCvar,
    empirical,
    normal,
    tailFatnessRatio,
    fit,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, confidence },
    diagnostics: { engine: 'evt-tail-risk', method: fit.method, converged: true, warnings },
  };
}

// ─────────────────────────────── Drawdown-at-Risk ───────────────────────────────

/** Drawdown-at-Risk read-out. */
export interface DrawdownAtRisk {
  confidence: number;
  /** `DaR_α` — the `α`-quantile of the fractional drawdown series (≥ 0). */
  drawdownAtRisk: number;
  /** `CDaR_α` — the mean drawdown beyond `DaR_α` (Chekhlov–Uryasev; ≥ `DaR_α`). */
  conditionalDrawdownAtRisk: number;
  /** The worst drawdown on the path (context). */
  maxDrawdown: number;
  observations: number;
  assumptions: { conventionsVersion: string; confidence: number };
  diagnostics: Diagnostics;
}

/**
 * Drawdown-at-Risk and Conditional Drawdown-at-Risk (Chekhlov–Uryasev) from a return series: the
 * `α`-quantile of the path's underwater (fractional-drawdown) curve, and the mean drawdown beyond it.
 * Deterministic; no simulation. See `docs/specs/evt-tail-risk.md`.
 */
export function drawdownAtRisk(
  returns: ArrayLike<number>,
  options: { confidence?: number } = {},
): DrawdownAtRisk {
  const functionName = 'drawdownAtRisk';
  requireArgumentObject(functionName, 'options', options);
  // Law 12: a misspelled knob (`confdence` running at the 0.95 default) must throw, never no-op.
  ensureKnownKeys(functionName, 'options', options, ['confidence']);
  ensureFiniteWhenPresent(options.confidence, 'confidence', 'drawdownAtRisk');
  const confidence = options.confidence ?? 0.95;
  requireConfidence(confidence, functionName);
  requireArgumentArray(functionName, 'returns', returns);
  const n = returns.length;
  if (n < 1) {
    throw new InputError(`${functionName}: need ≥ 1 return; got ${n}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { observations: n },
    });
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(returns[i]!)) {
      throw new InputError(
        `${functionName}: returns must be finite; returns[${i}] = ${returns[i]}.`,
        {
          code: ErrorCode.InputNotFinite,
          context: { index: i, value: returns[i] },
        },
      );
    }
  }

  // Growth-of-1 equity, then the underwater (fractional drawdown) series.
  const equity = new Array<number>(n + 1);
  equity[0] = 1;
  for (let i = 0; i < n; i++) equity[i + 1] = equity[i]! * (1 + returns[i]!);
  const dd = underwater(equity); // dₜ = 1 − equityₜ/peakₜ ≥ 0

  const dar = quantile(dd, confidence);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < dd.length; i++) {
    if (dd[i]! >= dar) {
      sum += dd[i]!;
      count++;
    }
  }
  const cdar = count > 0 ? sum / count : dar;
  const maxDd = maxDrawdownFromReturns(returns).maxDrawdown;

  return {
    confidence,
    drawdownAtRisk: dar,
    conditionalDrawdownAtRisk: cdar,
    maxDrawdown: maxDd,
    observations: n,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, confidence },
    diagnostics: {
      engine: 'drawdown-at-risk',
      method: 'chekhlov-uryasev',
      converged: true,
      warnings: [],
    },
  };
}

// ─────────────────────────────── Spectral risk ───────────────────────────────

/** Spectral risk read-out. */
export interface SpectralRisk {
  /** The spectral risk measure — a positive loss magnitude. */
  value: number;
  spectrum: 'exponential' | 'expected-shortfall';
  /** Risk-aversion `k` for the exponential spectrum. */
  riskAversion?: number;
  /** Level `α` for the Expected-Shortfall spectrum. */
  alpha?: number;
  assumptions: { conventionsVersion: string };
  diagnostics: Diagnostics;
}

/**
 * A coherent spectral risk measure (Acerbi): a weighted average of the loss quantiles with a
 * non-decreasing weight on worse outcomes. Pass `{ riskAversion }` for the exponential spectrum
 * `φ(p) = k·e^(−k(1−p))/(1−e^(−k))` (default `k = 10`), or `{ alpha }` for the Expected-Shortfall
 * spectrum `φ(p) = 𝟙[p ≥ α]/(1−α)` — ES being the flat-tail special case. See the spec.
 */
export function spectralRisk(
  returns: ArrayLike<number>,
  options: { riskAversion?: number } | { alpha: number } = {},
): SpectralRisk {
  const functionName = 'spectralRisk';
  requireArgumentObject(functionName, 'options', options);
  // Law 12: a misspelled knob (`riskAverson` silently running the k=10 default) must throw.
  ensureKnownKeys(functionName, 'options', options, ['riskAversion', 'alpha']);
  const losses = toLosses(returns, functionName);
  const n = losses.length;
  const sorted = [...losses].sort((a, b) => a - b); // ascending: worst losses last

  const isES = 'alpha' in options && options.alpha !== undefined;
  let phi: (p: number) => number;
  let spectrum: SpectralRisk['spectrum'];
  let riskAversion: number | undefined;
  let alpha: number | undefined;
  if (isES) {
    alpha = (options as { alpha: number }).alpha;
    if (!(alpha > 0 && alpha < 1)) {
      throw new InputError(`${functionName}: alpha must be in (0, 1); got ${alpha}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { alpha },
      });
    }
    const a = alpha;
    phi = (p) => (p >= a ? 1 / (1 - a) : 0);
    spectrum = 'expected-shortfall';
  } else {
    ensureFiniteWhenPresent(
      (options as { riskAversion?: unknown }).riskAversion,
      'riskAversion',
      'spectralRisk',
    );
    riskAversion = (options as { riskAversion?: number }).riskAversion ?? 10;
    if (!(riskAversion > 0) || !Number.isFinite(riskAversion)) {
      throw new InputError(
        `${functionName}: riskAversion must be a positive finite number; got ${riskAversion}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { riskAversion },
        },
      );
    }
    const k = riskAversion;
    const denom = 1 - Math.exp(-k);
    phi = (p) => (k * Math.exp(-k * (1 - p))) / denom;
    spectrum = 'exponential';
  }

  // M_φ = Σ φ(pᵢ)·loss₍ᵢ₎·Δp with pᵢ the midpoint plotting position (i−0.5)/n and Δp = 1/n.
  let value = 0;
  for (let i = 0; i < n; i++) {
    const p = (i + 0.5) / n;
    value += phi(p) * sorted[i]!;
  }
  value /= n;

  return {
    value,
    spectrum,
    ...(riskAversion !== undefined ? { riskAversion } : {}),
    ...(alpha !== undefined ? { alpha } : {}),
    assumptions: { conventionsVersion: CONVENTIONS_VERSION },
    diagnostics: { engine: 'spectral-risk', method: spectrum, converged: true, warnings: [] },
  };
}

// ───────────────────────── mean-excess plot / threshold selection ─────────────────────────

/** Options for {@link meanExcessPlot}. */
export interface MeanExcessPlotOptions {
  /** Explicit candidate thresholds (loss units); else an auto grid. */
  thresholds?: number[];
  /** Auto-grid point count. Default 25. */
  gridSize?: number;
  /** Auto-grid lower bound as a loss quantile in (0, 1). Default 0.5 (the median loss). */
  startQuantile?: number;
  /** Minimum exceedances the top threshold retains (and the fit-reliability floor). Default 10. */
  minExceedances?: number;
  /** Normalized deviation below which the mean-excess counts as linear. Default 0.1. */
  linearTolerance?: number;
}

/** One point of the mean-excess plot. */
export interface MeanExcessPoint {
  threshold: number;
  /** `E[X − u | X > u]` — the mean of the excesses over `u`. */
  meanExcess: number;
  /** Number of losses above `u`. */
  exceedances: number;
  /** `sd(excesses)/√Nu` — the mean-excess standard error. */
  standardError: number;
}

/** The mean-excess plot and the threshold it suggests. */
export interface MeanExcessPlot {
  points: MeanExcessPoint[];
  /** Heuristic tail-onset threshold — the lowest `u` above which `e(·)` is ~linear. */
  suggestedThreshold: number;
  /** `ξ` from the slope over `[suggestedThreshold, uₘₐₓ]`: `ξ = slope/(1+slope)`. */
  tailIndexEstimate: number;
  /** `Nu(suggestedThreshold)/n` — hand to `fitGeneralizedParetoTail({ tailFraction })`. */
  suggestedTailFraction: number;
  assumptions: { conventionsVersion: string; observations: number; losses: number };
  diagnostics: Diagnostics;
}

/**
 * Exceedance-**weighted** least-squares line `y = slope·x + intercept` (x = threshold, y = mean-excess).
 * Weighting by the exceedance count lets the clean, data-rich low-threshold points drive the fit and keeps
 * the noisy high-threshold tail (few exceedances) from dominating — the standard way to read the plot.
 */
function meanExcessLineFit(points: MeanExcessPoint[]): { slope: number; intercept: number } {
  let sw = 0;
  let swx = 0;
  let swy = 0;
  let swxx = 0;
  let swxy = 0;
  for (const p of points) {
    const w = p.exceedances;
    sw += w;
    swx += w * p.threshold;
    swy += w * p.meanExcess;
    swxx += w * p.threshold * p.threshold;
    swxy += w * p.threshold * p.meanExcess;
  }
  const denom = sw * swxx - swx * swx;
  const slope = denom !== 0 ? (sw * swxy - swx * swy) / denom : 0;
  return { slope, intercept: (swy - slope * swx) / sw };
}

/**
 * The **mean-excess plot** — the standard tool for choosing the EVT peaks-over-threshold cutoff the rest of
 * the pack takes as an input. The mean-excess `e(u) = E[X − u | X > u]` is linear in `u` (slope `ξ/(1−ξ)`)
 * above the true tail threshold and non-linear below it, so the threshold is read off as where the curve
 * straightens. Returns the curve, a heuristic `suggestedThreshold`, the `tailIndexEstimate` from that
 * region's slope, and the `suggestedTailFraction` to hand to {@link fitGeneralizedParetoTail}. See
 * `docs/specs/mean-excess-plot.md`.
 */
export function meanExcessPlot(
  returns: ArrayLike<number>,
  options: MeanExcessPlotOptions = {},
): MeanExcessPlot {
  const functionName = 'meanExcessPlot';
  requireArgumentObject(functionName, 'options', options);
  // Law 12: a misspelled knob (`gridsize` running at the 25-point default) must throw, never no-op.
  ensureKnownKeys(functionName, 'options', options, [
    'thresholds',
    'gridSize',
    'startQuantile',
    'minExceedances',
    'linearTolerance',
  ]);
  const losses = toLosses(returns, functionName);
  const n = losses.length;

  ensureFiniteWhenPresent(options.minExceedances, 'minExceedances', 'meanExcessPlot');
  const minExceedances = options.minExceedances ?? 10;
  // Safe integer (2026-08-23 review, P0): it only positions the grid's top threshold via
  // `n − minExceedances − 1` (no loop of its own), but an inexact count silently misplaces it.
  if (!Number.isSafeInteger(minExceedances) || minExceedances < 1) {
    throw new InputError(
      `${functionName}: minExceedances must be a positive integer; got ${minExceedances}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { minExceedances },
      },
    );
  }
  ensureFiniteWhenPresent(options.linearTolerance, 'linearTolerance', 'meanExcessPlot');
  const linearTolerance = options.linearTolerance ?? 0.1;
  if (!(linearTolerance > 0)) {
    throw new InputError(`${functionName}: linearTolerance must be > 0; got ${linearTolerance}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { linearTolerance },
    });
  }

  // Candidate thresholds: explicit, or an even grid from the startQuantile loss to the loss leaving
  // ~minExceedances above.
  let thresholds: number[];
  if (options.thresholds !== undefined) {
    requireArgumentArray(functionName, 'thresholds', options.thresholds);
    thresholds = [...options.thresholds].sort((a, b) => a - b);
    thresholds.forEach((u, i) => {
      if (!Number.isFinite(u)) {
        throw new InputError(`${functionName}: thresholds[${i}] must be finite; got ${u}.`, {
          code: ErrorCode.InputNotFinite,
          context: { index: i, value: u },
        });
      }
    });
  } else {
    ensureFiniteWhenPresent(options.gridSize, 'gridSize', 'meanExcessPlot');
    const gridSize = options.gridSize ?? 25;
    // Safe integer AND a work cap (2026-08-23 review, P0): gridSize sizes the threshold array and
    // each threshold costs TWO full passes over the losses (mean excess, then its standard error),
    // so `Number.isInteger(1e308)` being `true` made the old gate an absurd-allocation license.
    // 10,000 thresholds × a 10^5-loss sample is ~4·10^9 cheap comparisons — single-digit seconds on
    // a laptop and 400× the 25-point default; a mean-excess PLOT gains nothing beyond that.
    if (!Number.isSafeInteger(gridSize) || gridSize < 2 || gridSize > MAX_MEAN_EXCESS_GRID_SIZE) {
      throw new InputError(
        `${functionName}: gridSize must be an integer in [2, ${MAX_MEAN_EXCESS_GRID_SIZE.toLocaleString('en-US')}] — each grid point scans the full loss sample twice, so the cap keeps the largest request single-digit seconds of synchronous work (the default is 25); got ${gridSize}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { gridSize, max: MAX_MEAN_EXCESS_GRID_SIZE },
        },
      );
    }
    ensureFiniteWhenPresent(options.startQuantile, 'startQuantile', 'meanExcessPlot');
    const startQuantile = options.startQuantile ?? 0.5;
    if (!(startQuantile > 0 && startQuantile < 1)) {
      throw new InputError(
        `${functionName}: startQuantile must be in (0, 1); got ${startQuantile}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { startQuantile },
        },
      );
    }
    const sorted = [...losses].sort((a, b) => a - b);
    const loIdx = Math.floor(startQuantile * (n - 1));
    const hiIdx = n - minExceedances - 1; // ~minExceedances losses lie strictly above sorted[hiIdx]
    if (hiIdx <= loIdx || !(sorted[hiIdx]! > sorted[loIdx]!)) {
      throw new InputError(
        `${functionName}: not enough loss data for a mean-excess grid (n = ${n}, startQuantile = ${startQuantile}, minExceedances = ${minExceedances}) — add observations or lower startQuantile/minExceedances.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { observations: n, startQuantile, minExceedances },
        },
      );
    }
    const uMin = sorted[loIdx]!;
    const uMax = sorted[hiIdx]!;
    thresholds = Array.from(
      { length: gridSize },
      (_, i) => uMin + ((uMax - uMin) * i) / (gridSize - 1),
    );
  }

  // The curve: e(u), Nu, standard error per threshold (skip thresholds with no exceedances).
  const points: MeanExcessPoint[] = [];
  for (const u of thresholds) {
    let sum = 0;
    let cnt = 0;
    for (const x of losses) {
      if (x > u) {
        sum += x - u;
        cnt++;
      }
    }
    if (cnt === 0) continue;
    const me = sum / cnt;
    let se = 0;
    if (cnt >= 2) {
      let ss = 0;
      for (const x of losses) if (x > u) ss += (x - u - me) * (x - u - me);
      se = Math.sqrt(ss / (cnt - 1)) / Math.sqrt(cnt);
    }
    points.push({ threshold: u, meanExcess: me, exceedances: cnt, standardError: se });
  }
  if (points.length === 0) {
    throw new InputError(
      `${functionName}: no threshold has any exceedances — every candidate exceeds all losses.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { thresholds: thresholds.length },
      },
    );
  }

  // Suggested threshold: the lowest u (with ≥ minExceedances above and ≥ 3 candidates above) whose
  // mean-excess over [u, uₘₐₓ] is linear within the tolerance.
  const normalizedDeviation = (startIdx: number): number => {
    const slice = points.slice(startIdx);
    const { slope, intercept } = meanExcessLineFit(slice);
    const es = slice.map((p) => p.meanExcess);
    const range = Math.max(...es) - Math.min(...es);
    if (!(range > 0)) return 0;
    // Exceedance-weighted RMS deviation from the fitted line — a single noisy high-threshold point (few
    // exceedances) can't fail the linearity test on its own; the data-rich region governs it.
    let sw = 0;
    let ss = 0;
    for (const p of slice) {
      const d = p.meanExcess - (intercept + slope * p.threshold);
      sw += p.exceedances;
      ss += p.exceedances * d * d;
    }
    return Math.sqrt(ss / sw) / range;
  };
  const warnings: QuantWarning[] = [];
  let suggestedIdx = -1;
  for (let i = 0; i < points.length; i++) {
    if (points[i]!.exceedances < minExceedances) continue;
    if (points.length - i < 3) break; // too few points above to judge linearity
    if (normalizedDeviation(i) <= linearTolerance) {
      suggestedIdx = i;
      break;
    }
  }
  if (suggestedIdx === -1) {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i]!.exceedances >= minExceedances) {
        suggestedIdx = i;
        break;
      }
    }
    if (suggestedIdx === -1) suggestedIdx = 0;
    warnings.push(
      warning(
        WarningCode.RiskMeanExcessNoLinearRegion,
        `${functionName}: no threshold produced a clearly-linear mean-excess region within the tolerance (${linearTolerance}) — the suggested threshold is the highest with ≥ ${minExceedances} exceedances; inspect the plot.`,
        'warn',
        { linearTolerance, minExceedances },
      ),
    );
  }
  const suggestedThreshold = points[suggestedIdx]!.threshold;
  const tailSlice = points.slice(suggestedIdx);
  const { slope } = tailSlice.length >= 2 ? meanExcessLineFit(tailSlice) : { slope: 0 };
  const tailIndexEstimate = slope / (1 + slope);
  const suggestedTailFraction = points[suggestedIdx]!.exceedances / n;

  return {
    points,
    suggestedThreshold,
    tailIndexEstimate,
    suggestedTailFraction,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, observations: n, losses: n },
    diagnostics: {
      engine: 'mean-excess-plot',
      method: 'peaks-over-threshold',
      converged: Number.isFinite(tailIndexEstimate),
      warnings,
    },
  };
}
