import { ensureEnumWhenPresent, ensureFiniteWhenPresent } from './options-internal.js';
/**
 * Greek-based book VaR (spec §12.2, roadmap Tier 2) — a **delta-gamma** Value-at-Risk / Conditional-VaR
 * for a book of strategy positions, from each name's greeks and a risk-factor model (per-underlying spot
 * vol, cross-underlying correlation, optional vol-of-vol).
 *
 * Pure composition: it marks each position (`Position.value`), aggregates **raw** greeks + spot per
 * underlying (the same display→raw bridge `analyzeBook` uses), then reports a **parametric** (delta-normal,
 * closed-form) VaR, a **Cornish-Fisher** gamma-adjusted analytic VaR (the parametric quantile corrected for
 * the skewness/kurtosis the gamma induces, gated on the expansion's validity — see
 * `docs/specs/cornish-fisher-var.md`), and a **Monte-Carlo** (delta-gamma-exact, via `taylorPnl` over
 * correlated factor draws + `valueAtRiskReport`) VaR, with a per-underlying standalone / component decomposition.
 * VaR and CVaR are positive loss magnitudes; the expected-P&L drift (gamma convexity + theta) is disclosed
 * as `pnlMean`, never hidden. See `docs/specs/book-var.md`.
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensureKnownKeys,
  ensureNonNegative,
  requireArgumentArray,
  requireArgumentObject,
  warning,
} from '@totalfinance/core';
import {
  type Matrix,
  cholesky,
  correlatedNormalSampler,
  mulberry32,
  normalInverseCdf,
  normalPdf,
  normalSample,
} from '@totalfinance/math';
import type { StrategyPosition } from './strategy-shape.js';
import { matVec, quadForm } from './linalg.js';
import { type PnlMarket } from './pnl-explain.js';
import { type PositionGreeks, type Scenario, taylorPnl } from './scenario.js';
import { valueAtRiskReport } from './value-at-risk.js';

/** Hard cap on Monte-Carlo draws — reject an OOM-sized request before any work starts. */
const MAX_SAMPLES = 1_000_000;

/** One underlying's risk-factor parameters. */
export interface UnderlyingRiskFactor {
  /** Annualized spot RETURN volatility (e.g. `0.30` = 30%/yr). Required, ≥ 0. */
  spotReturnVolatility: number;
  /** Annualized stdev of IV changes (vol points per √year) → vega VaR. Default 0 (no vol risk). */
  volatilityOfVolatility?: number;
}

/** Options for {@link bookVaR}. */
export interface BookVaROptions {
  /** Per-underlying risk factors — MUST cover every underlying present in the book. */
  factors: Record<string, UnderlyingRiskFactor>;
  /** Confidence level in (0, 1). Default 0.95. */
  confidence?: number;
  /** VaR horizonPeriods in (trading) days. Default 1. */
  horizonDays?: number;
  /** Spot-return correlation matrix, rows/cols in `assumptions.underlyings` (sorted) order. Default I. */
  correlation?: readonly (readonly number[])[];
  /** Which method(s) to compute. Default `'both'`. */
  method?: 'both' | 'parametric' | 'monteCarlo';
  /** Monte-Carlo draws. Default 10,000; capped at 1,000,000. */
  samples?: number;
  /** Monte-Carlo PRNG seed (integer). Default 1; echoed for reproducibility. */
  seed?: number;
  /** Trading days per year for vol annualization. Default 252. */
  tradingDaysPerYear?: number;
}

/** The documented {@link BookVaROptions} keys — Law 12: an unknown option must throw, never no-op. */
const BOOK_VAR_OPTIONS_KEYS = [
  'factors',
  'confidence',
  'horizonDays',
  'correlation',
  'method',
  'samples',
  'seed',
  'tradingDaysPerYear',
] as const;

/** A position in the book: a strategy Position + its market (reuses the {@link PnlMarket} shape). */
export interface BookVaRPosition {
  position: StrategyPosition;
  market: PnlMarket;
  id?: string;
  /** Grouping key → shares one spot factor (default: `id` ?? `position-${i}`). */
  underlying?: string;
}

/** A VaR/CVaR read-out for one method (positive loss magnitudes, plus the disclosed P&L moments). */
export interface BookVaRMethodResult {
  /** Positive loss magnitude at `confidence`. */
  valueAtRisk: number;
  /** Conditional VaR / expected shortfall (mean loss beyond VaR); ≥ `var`. */
  conditionalValueAtRisk: number;
  /** Expected P&L over the horizonPeriods (gamma-convexity mean + theta drift) — disclosed, not hidden. */
  pnlMean: number;
  /** Stdev of the horizonPeriods P&L. */
  pnlStandardDeviation: number;
  /** P&L skewness the gamma induces — populated on the `cornishFisher` result only. */
  skewness?: number;
  /** P&L excess kurtosis the gamma induces — populated on the `cornishFisher` result only. */
  excessKurtosis?: number;
}

/** Per-underlying risk contribution. */
export interface BookVaRComponent {
  underlying: string;
  /** VaR of this name in isolation. */
  standaloneVaR: number;
  /**
   * Diversification-aware contribution to the FULL book VaR — its Euler dispersion share less its own
   * drift, so `Σ componentVaR = z·σ_L − μ` (the parametric VaR before the ≥0 floor). Can be negative for
   * a hedging name; `standaloneVaR ≥ componentVaR` always.
   */
  componentVaR: number;
  /** Sensitivities used (audit trail), in the one unit system — `vega` per volatility point. */
  delta: number;
  gamma: number;
  vega: number;
}

/** The full book-VaR read-out. */
export interface BookVaRResult {
  confidence: number;
  horizonDays: number;
  /** Delta-normal (linear) VaR — present unless `method: 'monteCarlo'`. */
  parametric?: BookVaRMethodResult;
  /**
   * Cornish-Fisher **gamma-adjusted** analytic VaR — the parametric quantile corrected for the P&L
   * skewness/kurtosis the gamma induces. Present unless `method: 'monteCarlo'` AND the CF expansion is
   * in its valid (monotone) domain; when a very convex book pushes it out of domain it is omitted and a
   * `risk.cornish_fisher_out_of_domain` warning points to `monteCarlo`.
   */
  cornishFisher?: BookVaRMethodResult;
  /** Delta-gamma (gamma-exact), seeded Monte-Carlo VaR — present unless `method: 'parametric'`. */
  monteCarlo?: BookVaRMethodResult;
  /** Per-underlying decomposition (from the linear risk), sorted by `componentVaR` desc. */
  components: BookVaRComponent[];
  assumptions: {
    conventionsVersion: string;
    confidence: number;
    horizonDays: number;
    tradingDaysPerYear: number;
    /** Sorted underlyings — the row/col order of `options.correlation`. */
    underlyings: string[];
    samples?: number;
    seed?: number;
  };
  diagnostics: Diagnostics;
}

/** A strategy Position built by `strategy(...)` / a named builder — not a raw object. */
function requirePosition(position: unknown, index: number): asserts position is StrategyPosition {
  const p = position as { value?: unknown; legs?: unknown } | null;
  if (
    p === null ||
    typeof p !== 'object' ||
    typeof p.value !== 'function' ||
    !Array.isArray(p.legs)
  ) {
    throw new InputError(
      `bookVaR: positions[${index}].position must be a strategy Position (from strategy(...) or a named builder).`,
      { code: ErrorCode.InputWrongType, context: { index } },
    );
  }
}

function requireConfidence(c: number): number {
  if (!(c > 0 && c < 1)) {
    throw new InputError(`bookVaR: confidence must be in (0, 1); got ${c}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { confidence: c },
    });
  }
  return c;
}

/** Validate a caller-supplied correlation matrix against the sorted underlyings (else identity). */
function resolveCorrelation(
  correlation: BookVaROptions['correlation'],
  n: number,
  names: string[],
): number[][] {
  if (correlation === undefined) {
    return names.map((_, i) => names.map((_2, j) => (i === j ? 1 : 0)));
  }
  if (!Array.isArray(correlation) || correlation.length !== n) {
    throw new InputError(
      `bookVaR: correlation must be a ${n}×${n} matrix (one row per underlying).`,
      {
        code: ErrorCode.InputWrongType,
        context: {
          expected: n,
          got: Array.isArray(correlation) ? correlation.length : typeof correlation,
        },
      },
    );
  }
  const rho = correlation.map((row, i) => {
    if (!Array.isArray(row) || row.length !== n) {
      throw new InputError(`bookVaR: correlation row ${i} must have ${n} entries.`, {
        code: ErrorCode.InputWrongType,
        context: { row: i },
      });
    }
    return row.map((v, j) => {
      ensureFinite(v, `correlation[${i}][${j}]`, 'bookVaR');
      if (v < -1 || v > 1) {
        throw new InputError(`bookVaR: correlation[${i}][${j}] must be in [-1, 1]; got ${v}.`, {
          code: ErrorCode.InputOutOfRange,
          context: { i, j, value: v },
        });
      }
      return v;
    });
  });
  for (let i = 0; i < n; i++) {
    if (Math.abs(rho[i]![i]! - 1) > 1e-9) {
      throw new InputError(
        `bookVaR: correlation diagonal must be 1; correlation[${i}][${i}] = ${rho[i]![i]}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { i },
        },
      );
    }
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(rho[i]![j]! - rho[j]![i]!) > 1e-9) {
        throw new InputError(`bookVaR: correlation must be symmetric (differs at [${i}][${j}]).`, {
          code: ErrorCode.InputOutOfRange,
          context: { i, j },
        });
      }
    }
  }
  return rho;
}

/**
 * Delta-gamma Value-at-Risk / CVaR for a book of strategy positions. Parametric (delta-normal) and
 * Monte-Carlo (delta-gamma), with a per-underlying standalone/component decomposition. See the spec.
 */
/** `A·B` for small dense SQUARE (n×n) matrices — the only shape the CF cumulant traces need. */
function matmul(a: Matrix, b: Matrix): number[][] {
  const n = a.length;
  return a.map((row) =>
    Array.from({ length: n }, (_, j) => {
      let s = 0;
      for (let t = 0; t < n; t++) s += row[t]! * b[t]![j]!;
      return s;
    }),
  );
}

/**
 * The Cornish-Fisher gamma-adjusted VaR of the delta-gamma(+vega+theta) horizonPeriods P&L. The cumulants of the
 * quadratic form `Σ[δᵢdSᵢ + ½γᵢdSᵢ²] + vega·dσ + θ·h` (dS ~ N(0, covS), Γ = diag(gamma)) are closed forms
 * in `covS`/`δ`/`Γ` (no eigendecomposition); the CF quantile expansion adjusts the normal quantile for the
 * induced skewness/kurtosis. Returns the result only when the expansion is a **valid (monotone) quantile
 * transform** — else `undefined` with the moments, so a too-convex book is disclosed, never mis-reported.
 */
function cornishFisherResult(input: {
  spotCovariance: Matrix;
  delta: number[];
  gamma: number[];
  covarianceTimesDelta: number[];
  deltaVariance: number;
  vegaVariance: number;
  gammaMean: number;
  thetaDrift: number;
  alpha: number;
}): { result?: BookVaRMethodResult; skewness: number; excessKurtosis: number } {
  const {
    spotCovariance: covS,
    gamma,
    covarianceTimesDelta: covDelta,
    deltaVariance: deltaVar,
    vegaVariance: vegaVar,
    gammaMean,
    thetaDrift,
    alpha,
  } = input;
  const M = covS.map((row, i) => row.map((v) => gamma[i]! * v)); // ΓΣ_S
  const m2 = matmul(M, M);
  const m3 = matmul(m2, M);
  const m4 = matmul(m3, M);
  const tr = (A: number[][]): number => A.reduce((s, row, i) => s + row[i]!, 0);
  // δᵀΣ_SΓΣ_Sδ = (Σ_Sδ)ᵀΓ(Σ_Sδ) with p = Σ_Sδ = covDelta.
  const p = covDelta;
  const dSGSd = p.reduce((s, pi, i) => s + gamma[i]! * pi * pi, 0);
  // δᵀΣ_SΓΣ_SΓΣ_Sδ = gᵀΣ_Sg with g = Γ·(Σ_Sδ).
  const g = gamma.map((gi, i) => gi * p[i]!);
  const dSGSGSd = g.reduce(
    (s, gi, i) => s + gi * covS[i]!.reduce((ss, v, j) => ss + v * g[j]!, 0),
    0,
  );

  const k1 = gammaMean + thetaDrift;
  const k2 = deltaVar + 0.5 * tr(m2) + vegaVar;
  const k3 = 3 * dSGSd + tr(m3);
  const k4 = 12 * dSGSGSd + 3 * tr(m4);
  const sigma = Math.sqrt(Math.max(0, k2));
  const skewness = sigma > 0 ? k3 / Math.pow(k2, 1.5) : 0;
  const excessKurtosis = sigma > 0 ? k4 / (k2 * k2) : 0;

  const zAlpha = normalInverseCdf(alpha);
  // Cornish-Fisher is reliable while its quantile map is monotone over the TAIL region we use (down to a
  // deep 1e-4 tail for the ES integral, out to the VaR point). q'(z) = qa·z² + qb·z + qc; require its
  // minimum over [zLo, zHi] > 0. (A global ∀z test wrongly rejects mild skew, where qa dips slightly < 0.)
  const a = skewness / 6;
  const b = excessKurtosis / 24;
  const qa = 3 * b - 6 * a * a;
  const qb = 2 * a;
  const qc = 1 - 3 * b + 5 * a * a;
  const qprime = (z: number): number => qa * z * z + qb * z + qc;
  const zLo = Math.min(normalInverseCdf(1e-4), zAlpha);
  const zHi = -zLo;
  let qMin = Math.min(qprime(zLo), qprime(zHi));
  if (qa > 0) {
    const zVertex = -qb / (2 * qa);
    if (zVertex > zLo && zVertex < zHi) qMin = Math.min(qMin, qprime(zVertex));
  }
  if (!(qMin > 0)) return { skewness, excessKurtosis };

  const q =
    zAlpha +
    ((zAlpha * zAlpha - 1) / 6) * skewness +
    ((zAlpha * zAlpha * zAlpha - 3 * zAlpha) / 24) * excessKurtosis -
    ((2 * zAlpha * zAlpha * zAlpha - 5 * zAlpha) / 36) * skewness * skewness;
  const varCF = Math.max(0, -(k1 + sigma * q));
  // CF CVaR: the tail-average of the CF quantile, in closed form (reduces to the normal ES at S=K=0).
  const esRaw =
    -k1 +
    sigma *
      (normalPdf(zAlpha) / alpha) *
      (1 - 3 * b + 5 * a * a + a * zAlpha + (b - 2 * a * a) * (zAlpha * zAlpha + 2));
  return {
    result: {
      valueAtRisk: varCF,
      conditionalValueAtRisk: Math.max(varCF, esRaw),
      pnlMean: k1,
      pnlStandardDeviation: sigma,
      skewness,
      excessKurtosis,
    },
    skewness,
    excessKurtosis,
  };
}

export function bookVaR(
  positions: readonly BookVaRPosition[],
  options: BookVaROptions,
): BookVaRResult {
  const functionName = 'bookVaR';
  requireArgumentArray(functionName, 'positions', positions);
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, BOOK_VAR_OPTIONS_KEYS);
  requireArgumentObject(functionName, 'options.factors', options.factors);
  ensureFiniteWhenPresent(options.confidence, 'confidence', 'bookVaR');
  const confidence = requireConfidence(options.confidence ?? 0.95);
  ensureFiniteWhenPresent(options.horizonDays, 'horizonDays', 'bookVaR');
  const horizonDays = options.horizonDays ?? 1;
  if (!(horizonDays > 0) || !Number.isFinite(horizonDays)) {
    throw new InputError(
      `${functionName}: horizonDays must be a positive finite number; got ${horizonDays}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { horizonDays },
      },
    );
  }
  ensureFiniteWhenPresent(options.tradingDaysPerYear, 'tradingDaysPerYear', 'bookVaR');
  const tradingDaysPerYear = options.tradingDaysPerYear ?? 252;
  if (!(tradingDaysPerYear > 0) || !Number.isFinite(tradingDaysPerYear)) {
    throw new InputError(`${functionName}: tradingDaysPerYear must be a positive finite number.`, {
      code: ErrorCode.InputOutOfRange,
      context: { tradingDaysPerYear },
    });
  }
  ensureEnumWhenPresent(options.method, 'bookVaR', 'method', ['both', 'parametric', 'monteCarlo']);
  const method = options.method ?? 'both';
  if (method !== 'both' && method !== 'parametric' && method !== 'monteCarlo') {
    throw new InputError(
      `${functionName}: method must be 'both' | 'parametric' | 'monteCarlo'; got "${method}".`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { method },
      },
    );
  }
  const h = horizonDays / tradingDaysPerYear;
  const sqrtH = Math.sqrt(h);

  // 1) Mark each position and aggregate raw greeks + spot per underlying.
  const warnings: QuantWarning[] = [];
  const agg = new Map<
    string,
    { delta: number; gamma: number; vega: number; theta: number; value: number; spot: number }
  >();
  for (let i = 0; i < positions.length; i++) {
    const item = positions[i]!;
    requireArgumentObject(functionName, `positions[${i}]`, item);
    requirePosition(item.position, i);
    requireArgumentObject(functionName, `positions[${i}].market`, item.market);
    const spot = item.market.spot;
    ensureFinite(spot, `positions[${i}].market.spot`, functionName);
    const marked = item.position.value(item.market);
    // Marked Greeks stay in the one unit system (per day / per vol point); the Taylor engine converts.
    const raw = marked.greeks;
    const key = item.underlying ?? item.id ?? `position-${i}`;
    const cur = agg.get(key);
    if (cur) {
      // Positions on one underlying share a single spot risk factor; a differing spot is a data
      // inconsistency — disclose it (the first spot is used for that name's factor).
      if (cur.spot !== spot) {
        warnings.push(
          warning(
            WarningCode.ModelLimitation,
            `underlying "${key}" has positions marked at different spots (${cur.spot} vs ${spot}); the first (${cur.spot}) is used for its risk factor.`,
            'warn',
            { underlying: key, spots: [cur.spot, spot] },
          ),
        );
      }
      cur.delta += raw.delta ?? 0;
      cur.gamma += raw.gamma ?? 0;
      cur.vega += raw.vega ?? 0;
      cur.theta += raw.theta ?? 0;
      cur.value += marked.value;
    } else {
      agg.set(key, {
        delta: raw.delta ?? 0,
        gamma: raw.gamma ?? 0,
        vega: raw.vega ?? 0,
        theta: raw.theta ?? 0,
        value: marked.value,
        spot,
      });
    }
  }

  const names = [...agg.keys()].sort();
  const n = names.length;

  // An empty book has no risk — return a valid zero envelope rather than run MC on nothing.
  if (n === 0) {
    const zero: BookVaRMethodResult = {
      valueAtRisk: 0,
      conditionalValueAtRisk: 0,
      pnlMean: 0,
      pnlStandardDeviation: 0,
    };
    return {
      confidence,
      horizonDays,
      ...(method !== 'monteCarlo' ? { parametric: zero, cornishFisher: { ...zero } } : {}),
      ...(method !== 'parametric' ? { monteCarlo: { ...zero } } : {}),
      components: [],
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        confidence,
        horizonDays,
        tradingDaysPerYear,
        underlyings: [],
      },
      diagnostics: { engine: 'book-var', method: 'delta-gamma', converged: true, warnings: [] },
    };
  }

  // Per-underlying vectors, in sorted order.
  const delta = names.map((k) => agg.get(k)!.delta);
  const gamma = names.map((k) => agg.get(k)!.gamma);
  // Display units (per vol point, per calendar day) are what the book carries and what the MC path
  // hands to the Taylor engine; the closed-form parametric moments need the raw per-1.00 / per-year
  // scale, converted here in one place.
  const vega = names.map((k) => agg.get(k)!.vega);
  const theta = names.map((k) => agg.get(k)!.theta);
  const vegaRaw = vega.map((v) => v * 100);
  const thetaRaw = theta.map((t) => t * 365);
  const spot = names.map((k) => agg.get(k)!.spot);
  const factor = names.map((k) => {
    const f = options.factors[k];
    if (f === undefined) {
      throw new InputError(
        `${functionName}: options.factors is missing a risk factor for underlying "${k}".`,
        {
          code: ErrorCode.InputMissingField,
          context: { underlying: k },
        },
      );
    }
    requireArgumentObject(functionName, `factors["${k}"]`, f);
    ensureNonNegative(f.spotReturnVolatility, `factors["${k}"].spotReturnVolatility`, functionName);
    if (f.volatilityOfVolatility !== undefined)
      ensureNonNegative(
        f.volatilityOfVolatility,
        `factors["${k}"].volatilityOfVolatility`,
        functionName,
      );
    return f;
  });

  // Horizon stdev of each dSᵢ (from spot) and each dσᵢ (from vol-of-vol).
  const sd = names.map((_, i) => factor[i]!.spotReturnVolatility * spot[i]! * sqrtH); // stdev of dSᵢ
  const vsd = names.map((_, i) => (factor[i]!.volatilityOfVolatility ?? 0) * sqrtH); // stdev of dσᵢ

  const rho = resolveCorrelation(options.correlation, n, names);
  // Both the parametric variance (δᵀΣ_Sδ) and the MC sampler need a positive-definite correlation.
  // Validate it here so a non-PSD ρ throws a typed error on EVERY method — otherwise a negative
  // parametric variance is silently clamped to 0 (a hidden, materially wrong VaR) on the parametric
  // path, since only the Monte-Carlo Cholesky would have caught it.
  try {
    cholesky(rho);
  } catch {
    throw new InputError(
      `${functionName}: correlation must be positive definite (Cholesky failed). A non-PSD correlation would otherwise yield a silently clamped, wrong variance.`,
      { code: ErrorCode.InputOutOfRange, context: { correlation: 'not-positive-definite' } },
    );
  }
  // The horizonPeriods dS covariance Σ_S,ij = ρ_ij·sdᵢ·sdⱼ (used by the parametric closed form).
  const covS: Matrix = names.map((_, i) => names.map((_2, j) => rho[i]![j]! * sd[i]! * sd[j]!));

  const alpha = 1 - confidence;
  const z = -normalInverseCdf(alpha); // positive tail multiplier

  // 2) Parametric (delta-normal) VaR + the linear risk decomposition (always computed — cheap + useful).
  const deltaVar = quadForm(covS, delta); // δᵀΣ_S δ
  const vegaVar = vegaRaw.reduce((a, v, i) => a + v * v * vsd[i]! * vsd[i]!, 0);
  const sigmaL = Math.sqrt(Math.max(0, deltaVar + vegaVar));
  const gammaMean = 0.5 * gamma.reduce((a, g, i) => a + g * covS[i]![i]!, 0); // ½Σ Γᵢ·Var(dSᵢ)
  const thetaDrift = thetaRaw.reduce((a, t) => a + t * h, 0);
  const mu = gammaMean + thetaDrift;
  const parametric: BookVaRMethodResult = {
    valueAtRisk: Math.max(0, z * sigmaL - mu),
    conditionalValueAtRisk: Math.max(
      Math.max(0, z * sigmaL - mu),
      (normalPdf(normalInverseCdf(alpha)) / alpha) * sigmaL - mu,
    ),
    pnlMean: mu,
    pnlStandardDeviation: sigmaL,
  };

  const covDelta = matVec(covS, delta); // Σ_S δ
  const components: BookVaRComponent[] = names
    .map((k, i) => {
      const varDS = covS[i]![i]!; // Var(dSᵢ)
      const standaloneDisp = Math.sqrt(
        Math.max(0, delta[i]! * delta[i]! * varDS + vegaRaw[i]! * vegaRaw[i]! * vsd[i]! * vsd[i]!),
      );
      const standaloneMu = 0.5 * gamma[i]! * varDS + thetaRaw[i]! * h;
      const contrib =
        sigmaL > 0
          ? (delta[i]! * covDelta[i]! + vegaRaw[i]! * vegaRaw[i]! * vsd[i]! * vsd[i]!) / sigmaL
          : 0;
      return {
        underlying: k,
        standaloneVaR: Math.max(0, z * standaloneDisp - standaloneMu),
        // The name's contribution to the FULL book VaR: its Euler dispersion share less its own drift.
        // `Σ componentVaR = z·σ_L − μ` (the book's parametric VaR before the ≥0 floor), and (since the
        // Euler dispersion share is ≤ the standalone dispersion) `standaloneVaR ≥ componentVaR`.
        componentVaR: z * contrib - standaloneMu,
        delta: delta[i]!,
        gamma: gamma[i]!,
        vega: vega[i]!,
      };
    })
    .sort((a, b) => b.componentVaR - a.componentVaR);

  // 3) Cornish-Fisher (delta-gamma, analytic): the parametric quantile corrected for the gamma-induced
  // skewness/kurtosis — populated only when the CF expansion is in its valid (monotone) domain.
  let cornishFisher: BookVaRMethodResult | undefined;
  if (method !== 'monteCarlo') {
    const cf = cornishFisherResult({
      spotCovariance: covS,
      delta,
      gamma,
      covarianceTimesDelta: covDelta,
      deltaVariance: deltaVar,
      vegaVariance: vegaVar,
      gammaMean,
      thetaDrift,
      alpha,
    });
    if (cf.result) {
      cornishFisher = cf.result;
    } else {
      warnings.push(
        warning(
          WarningCode.RiskCornishFisherOutOfDomain,
          `the book is too convex for a reliable Cornish-Fisher expansion (P&L skewness ${cf.skewness.toFixed(
            2,
          )}, excess kurtosis ${cf.excessKurtosis.toFixed(
            2,
          )}); use the monteCarlo VaR for this book.`,
          'warn',
          { skewness: cf.skewness, excessKurtosis: cf.excessKurtosis },
        ),
      );
    }
  }

  // 4) Monte-Carlo (delta-gamma) VaR: correlated dS + independent dσ draws → per-name taylorPnl → tail.
  let monteCarlo: BookVaRMethodResult | undefined;
  let usedSamples: number | undefined;
  let usedSeed: number | undefined;
  if (method !== 'parametric') {
    ensureFiniteWhenPresent(options.samples, 'samples', 'book-var');
    const samples = options.samples ?? 10_000;
    // Safe integer, not just integer (2026-08-23 review, P0): `Number.isInteger(1e308)` is `true`,
    // and above 2^53 the `s++` loop counter stops advancing — the MAX_SAMPLES cap below bounds the
    // work, and this gate keeps the count exact before it sizes the P&L array.
    if (!Number.isSafeInteger(samples) || samples < 1) {
      throw new InputError(`${functionName}: samples must be a positive integer; got ${samples}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { samples },
      });
    }
    if (samples > MAX_SAMPLES) {
      throw new InputError(
        `${functionName}: samples must be ≤ ${MAX_SAMPLES.toLocaleString('en-US')} — every sample draws correlated normals and re-prices the book's Taylor P&L per name, so the cap keeps the largest request a few seconds of synchronous work on a realistic book, and Monte-Carlo error at 10^6 samples (∝ 1/√n ≈ 0.1%) is already far below the model error of a delta-gamma expansion; got ${samples}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { samples, max: MAX_SAMPLES },
        },
      );
    }
    // Pre-coalesce null rejection; the integer guard below teaches for every present value.
    const seed = options.seed === null ? Number.NaN : (options.seed ?? 1);
    // Safe integer (2026-08-23 review, P0): above 2^53 adjacent integers collide, so two "different"
    // seeds silently reproduce the same stream — reproducibility is the whole point of the field.
    if (!Number.isSafeInteger(seed)) {
      throw new InputError(
        `${functionName}: seed must be an integer within ±(2^53 − 1) (a safe integer) for reproducibility; got ${seed}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { seed },
        },
      );
    }
    // Sample UNIT correlated normals from ρ (Cholesky, PSD-validated) then scale by each name's sd, so a
    // zero-spot-vol name contributes 0 rather than breaking the factorization.
    const draw = correlatedNormalSampler(rho);
    const randomNumberGenerator = mulberry32(seed);
    const greeks: PositionGreeks[] = names.map((_, i) => ({
      value: agg.get(names[i]!)!.value,
      spot: spot[i]!,
      delta: delta[i]!,
      gamma: gamma[i]!,
      vega: vega[i]!,
      theta: theta[i]!,
      rho: 0,
    }));
    const pnl = new Array<number>(samples);
    for (let s = 0; s < samples; s++) {
      const u = draw(randomNumberGenerator); // unit correlated normals, length n
      let total = 0;
      for (let i = 0; i < n; i++) {
        const dS = sd[i]! * u[i]!;
        const dVolatility = normalSample(randomNumberGenerator) * vsd[i]!; // independent of spot (v1); 0 when volatilityOfVolatility is 0
        const scenario: Scenario = {
          name: 'var',
          shocks: [
            { factor: 'spot', kind: 'absolute', value: dS },
            { factor: 'volatility', kind: 'absolute', value: dVolatility },
            { factor: 'time', kind: 'absolute', value: h },
          ],
        };
        total += taylorPnl(greeks[i]!, scenario).total;
      }
      pnl[s] = total;
    }
    const rep = valueAtRiskReport(pnl, { method: 'historical', confidence, horizonPeriods: 1 });
    let sum = 0;
    for (const p of pnl) sum += p;
    const pnlMean = sum / samples;
    let ss = 0;
    for (const p of pnl) ss += (p - pnlMean) * (p - pnlMean);
    const pnlStandardDeviation = Math.sqrt(ss / samples);
    monteCarlo = {
      valueAtRisk: rep.valueAtRisk,
      conditionalValueAtRisk: rep.conditionalValueAtRisk,
      pnlMean,
      pnlStandardDeviation,
    };
    usedSamples = samples;
    usedSeed = seed;
  }

  return {
    confidence,
    horizonDays,
    ...(method !== 'monteCarlo' ? { parametric } : {}),
    ...(cornishFisher !== undefined ? { cornishFisher } : {}),
    ...(monteCarlo !== undefined ? { monteCarlo } : {}),
    components,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      confidence,
      horizonDays,
      tradingDaysPerYear,
      underlyings: names,
      ...(usedSamples !== undefined ? { samples: usedSamples } : {}),
      ...(usedSeed !== undefined ? { seed: usedSeed } : {}),
    },
    diagnostics: { engine: 'book-var', method: 'delta-gamma', converged: true, warnings },
  };
}
