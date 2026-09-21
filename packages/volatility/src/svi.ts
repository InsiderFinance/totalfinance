/**
 * Gatheral raw-SVI parameterization and calibration (spec §10.1).
 *
 * The raw SVI slice models total implied variance `w = σ²·t` as a function of log-moneyness
 * `k = ln(K/F)`:
 *
 *   w(k) = a + b·( ρ·(k − m) + √((k − m)² + σ²) )
 *
 * with `a` (vertical level), `b ≥ 0` (wing slope / ATM curvature), `ρ ∈ [−1, 1]` (skew),
 * `m` (horizontal shift) and `σ > 0` (smoothness). It is asymptotically linear in the wings — the
 * shape implied vol surfaces actually take — yet has only five intuitive parameters.
 *
 * Calibration uses the **Zeliade quasi-explicit** method (Martini & Jacquier): for a fixed `(m, σ)`
 * the fit is *linear* in the reduced variables `(a, d = bσρ, c = bσ)` and solved in closed form
 * (a 3×3 normal-equation system), so only the well-behaved 2-D `(m, σ)` problem is left for a
 * Nelder–Mead search. The reduced variables are projected onto the Zeliade box (which keeps the fit
 * well-posed) and the outer search is **penalized for butterfly violations**, so the result is driven
 * to the closest arbitrage-free SVI. Butterfly-freedom is then **verified and reported** on the result
 * (`butterflyFree` / `minButterflyG`) rather than assumed — {@link sviG} exposes Gatheral's `g(k)`
 * density function directly.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensureFinite,
  ensurePositive,
  validateClosedRequest,
  warning,
} from '@totalfinance/core';
import { cholesky, choleskySolve, nelderMead } from '@totalfinance/math';
import { requireCalibrationIterationBudget } from './calibration-limits.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/** Raw-SVI parameters (Gatheral). `a`,`b`,`σ` carry total-variance units; `m`,`k` are log-moneyness. */
export interface SVIParameters {
  /** Vertical level (minimum total variance is `a + b·σ·√(1−ρ²)`). */
  a: number;
  /** Wing slope / curvature, `≥ 0`. */
  b: number;
  /** Skew / rotation, `∈ [−1, 1]`. */
  rho: number;
  /** Horizontal shift (log-moneyness of the smile's centre). */
  m: number;
  /** Smoothness, `> 0`. */
  sigma: number;
}

/**
 * A warm start for {@link calibrateSvi}: the two FREE members of the outer search, in the canonical
 * SVI spelling (`m` is the smile's centre, `σ` its smoothness). `a`, `b`, and `ρ` are solved by the
 * inner normal equations and are therefore not part of a start.
 */
export interface SVIWarmStart {
  m: number;
  /** `> 0`. */
  sigma: number;
}

export interface SVICalibrationOptions {
  /** Outer-search iteration budget (default 400, maximum 10,000). */
  maximumIterations?: number;
  /** Outer-search tolerance (default 1e-12). */
  tolerance?: number;
  /**
   * The slice's maturity in years. Supplied ⇒ the fit-vs-data deviation check (see
   * {@link calibrateSvi}) is expressed in true implied-VOL points, `σ = √(w/t)`. Omitted ⇒ `t = 1`,
   * i.e. the check runs on `√w = σ√t` — still a vol scale, but shrunk by `√t` on a short slice.
   */
  timeToExpiryYears?: number;
  /**
   * Warm start for the outer `(m, σ)` search (Stage 4.5). Tried FIRST, ahead of the four built-in
   * starts — ties keep the first, so a warm start never loses to a cold fit. `a`, `b`, and `ρ` are
   * solved by the inner normal equations at every `(m, σ)` and are therefore not accepted as
   * starts (a member the search cannot honor is refused, never ignored).
   */
  initialParameters?: SVIWarmStart;
}

export interface SVICalibrationResult {
  parameters: SVIParameters;
  /** Root-mean-square total-variance error of the fit. */
  rmse: number;
  /**
   * `false` when the outer search stopped early OR the fitted slice sits materially away from the
   * input smile (the arbitrage projection — see {@link calibrateSvi}); the reason is always a
   * `diagnostics.warnings` entry. Gate on it before trusting `parameters`.
   */
  converged: boolean;
  iterations: number;
  /** Whether the fitted slice is butterfly-arbitrage-free (`g(k) ≥ 0` across the check grid). */
  butterflyFree: boolean;
  /** The minimum Gatheral `g(k)` over the check grid (`≥ 0` ⇔ arbitrage-free). */
  minButterflyG: number;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    method: 'zeliade-quasi-explicit';
    points: number;
    /** Whether the outer search began from a caller-supplied `initialParameters` or the built-in starts. */
    initialParameters: 'supplied' | 'default';
  };
  /** Structured warnings; a non-converged or arbitrageable fit explains itself here. */
  diagnostics: Diagnostics;
}

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import.
 */
function sviSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `svi: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const SVI_TOTAL_VARIANCE_SPEC = sviSpecOf('sviTotalVariance#0');
const SVI_VOLATILITY_SPEC = sviSpecOf('sviVolatility#0');
const SVI_G_SPEC = sviSpecOf('sviG#0');
const SVI_MIN_G_SPEC = sviSpecOf('sviMinG#0');
const SVI_BUTTERFLY_FREE_SPEC = sviSpecOf('sviButterflyFree#0');
const CALIBRATE_SVI_INPUT_SPEC = sviSpecOf('calibrateSvi#0');
const CALIBRATE_SVI_OPTIONS_SPEC = sviSpecOf('calibrateSvi#1');

/**
 * Fit-vs-DATA tolerances, in implied-vol points (see {@link calibrateSvi}). The RMSE gate is
 * `max(0.005, 2% of the smile's mean IV)`: half a vol point is below the bid/ask of any real chain,
 * and the relative arm keeps the gate meaningful on a 100-vol crypto smile. The per-point gate is 5
 * vol points — a single quote that far from the fit is a different smile, not a fit residual.
 */
const FIT_DEVIATION_RMSE_FLOOR = 0.005;
const FIT_DEVIATION_RMSE_RELATIVE = 0.02;
const FIT_DEVIATION_MAX_POINT = 0.05;

/**
 * An example per FUNCTION, not per file.
 *
 * All four boundaries shared one constant naming `sviTotalVariance`, so a caller who omitted `b` on
 * `sviMinG` was answered with a worked call to a different function — authoritative-sounding
 * misdirection, and the exact class RV5's gate was supposed to have closed. The gate missed it
 * because it accepted any "alias" whose name appeared as a substring.
 */
const SVI_PARAMS = '{ a: 0.04, b: 0.4, rho: -0.3, m: 0, sigma: 0.1 }';
const SVI_EXAMPLE_CALL = `sviTotalVariance(${SVI_PARAMS}, 0)`;
const SVI_VOLATILITY_EXAMPLE_CALL = `sviVolatility(${SVI_PARAMS}, 0, 0.5)`;
const SVI_G_EXAMPLE_CALL = `sviG(${SVI_PARAMS}, 0)`;
const SVI_MIN_G_EXAMPLE_CALL = `sviMinG(${SVI_PARAMS})`;
const SVI_BUTTERFLY_FREE_EXAMPLE_CALL = `sviButterflyFree(${SVI_PARAMS})`;
const CALIBRATE_SVI_EXAMPLE_CALL =
  'calibrateSvi({ k: [-0.2, -0.1, 0, 0.1, 0.2], w: [0.045, 0.042, 0.04, 0.041, 0.044] }, ' +
  '{ timeToExpiryYears: 0.5 })';

const SVI_HINTS: Record<string, string> = {
  a: 'vertical level of the variance smile',
  b: 'wing slope, >= 0',
  rho: 'skew, in [-1, 1]',
  m: 'horizontal shift in log-moneyness',
  sigma: 'ATM curvature, > 0',
};

/**
 * The unchecked slice kernel.
 *
 * @internal Calibration evaluates this inside a least-squares objective — thousands of optimizer
 * iterations times every quoted strike — and the butterfly diagnostic sweeps an 81-point grid. Those
 * loops validate their parameter object ONCE at the entry point and then call this; putting five
 * field checks inside an optimizer's inner loop is exactly the per-row cost spec 3B.1b forbids.
 */
function totalVarianceUnchecked(parameters: SVIParameters, k: number): number {
  const d = k - parameters.m;
  return (
    parameters.a +
    parameters.b * (parameters.rho * d + Math.sqrt(d * d + parameters.sigma * parameters.sigma))
  );
}

/**
 * Total implied variance `w(k)` of a raw-SVI slice.
 *
 * Omitting any of the five parameters used to return `NaN` — a total variance that is not a number,
 * handed back as a success. Downstream that becomes a `NaN` implied vol, a `NaN` price, and a quote.
 */
export function sviTotalVariance(parameters: SVIParameters, k: number): number {
  validateClosedRequest('sviTotalVariance', parameters, SVI_TOTAL_VARIANCE_SPEC, {
    argumentName: 'parameters',
    exampleCall: SVI_EXAMPLE_CALL,
    hints: SVI_HINTS,
  });
  ensureFinite(k, 'k', 'sviTotalVariance');
  return totalVarianceUnchecked(parameters, k);
}

/** Implied volatility of a raw-SVI slice at log-moneyness `k` and maturity `t` (years). */
export function sviVolatility(
  parameters: SVIParameters,
  k: number,
  timeToExpiryYears: number,
): number {
  validateClosedRequest('sviVolatility', parameters, SVI_VOLATILITY_SPEC, {
    argumentName: 'parameters',
    exampleCall: SVI_VOLATILITY_EXAMPLE_CALL,
    hints: SVI_HINTS,
  });
  ensureFinite(k, 'k', 'sviVolatility');
  ensureFinite(timeToExpiryYears, 'timeToExpiryYears', 'sviVolatility');
  return Math.sqrt(Math.max(0, totalVarianceUnchecked(parameters, k)) / timeToExpiryYears);
}

/** First and second derivatives of `w(k)` (closed form). */
function sviDerivatives(p: SVIParameters, k: number): { w: number; wp: number; wpp: number } {
  const d = k - p.m;
  const root = Math.sqrt(d * d + p.sigma * p.sigma);
  const w = p.a + p.b * (p.rho * d + root);
  const wp = p.b * (p.rho + d / root);
  const wpp = (p.b * p.sigma * p.sigma) / (root * root * root);
  return { w, wp, wpp };
}

/** @internal The unchecked `g(k)`; see {@link totalVarianceUnchecked} for why the loops need it. */
function gUnchecked(parameters: SVIParameters, k: number): number {
  const { w, wp, wpp } = sviDerivatives(parameters, k);
  const a = 1 - (k * wp) / (2 * w);
  return a * a - ((wp * wp) / 4) * (1 / w + 0.25) + wpp / 2;
}

/**
 * Gatheral's `g(k)` density function. The risk-neutral density implied by an SVI slice is
 * proportional to `g(k)`, so `g(k) ≥ 0` everywhere ⇔ the slice is free of **butterfly** arbitrage.
 */
export function sviG(parameters: SVIParameters, k: number): number {
  validateClosedRequest('sviG', parameters, SVI_G_SPEC, {
    argumentName: 'parameters',
    exampleCall: SVI_G_EXAMPLE_CALL,
    hints: SVI_HINTS,
  });
  ensureFinite(k, 'k', 'sviG');
  return gUnchecked(parameters, k);
}

/** The default log-moneyness check grid (±1, 81 points) for the butterfly diagnostic. */
const DEFAULT_G_GRID = Array.from({ length: 81 }, (_, i) => -1 + (2 * i) / 80);

/**
 * A butterfly check/penalty grid that SPANS the calibrated slice (WS2.11): `[min(k) − 0.25·range,
 * max(k) + 0.25·range]` with at least 81 points, or 41 per unit of log-moneyness — whichever is more.
 * The fixed ±1 grid silently missed density troughs in the wings of wide or long-dated slices (quotes
 * out to |k| > 1), reporting `butterflyFree: true` when g(k) actually dipped negative at, say, k = 1.3.
 */
function butterflyGrid(k: readonly number[]): number[] {
  const lo = Math.min(...k);
  const hi = Math.max(...k);
  const range = hi - lo;
  const gLo = lo - 0.25 * range;
  const gHi = hi + 0.25 * range;
  const width = gHi - gLo; // = 1.5·range
  const points = Math.max(81, Math.ceil(41 * width));
  const step = width / (points - 1);
  return Array.from({ length: points }, (_, i) => gLo + i * step);
}

/** The minimum Gatheral `g(k)` over a log-moneyness grid (`≥ 0` ⇔ butterfly-arbitrage-free). */
export function sviMinG(parameters: SVIParameters, grid: number[] = DEFAULT_G_GRID): number {
  // Once, before the sweep — not once per grid point.
  validateClosedRequest('sviMinG', parameters, SVI_MIN_G_SPEC, {
    argumentName: 'parameters',
    exampleCall: SVI_MIN_G_EXAMPLE_CALL,
    hints: SVI_HINTS,
  });
  let min = Infinity;
  for (const k of grid) {
    const g = gUnchecked(parameters, k);
    if (g < min) min = g;
  }
  return min;
}

/** Whether the slice is butterfly-arbitrage-free across a log-moneyness grid (default ±1, 81 points). */
export function sviButterflyFree(
  parameters: SVIParameters,
  grid: number[] = DEFAULT_G_GRID,
): boolean {
  validateClosedRequest('sviButterflyFree', parameters, SVI_BUTTERFLY_FREE_SPEC, {
    argumentName: 'parameters',
    exampleCall: SVI_BUTTERFLY_FREE_EXAMPLE_CALL,
    hints: SVI_HINTS,
  });
  return sviMinG(parameters, grid) >= -1e-8;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

interface InnerFit {
  a: number;
  d: number;
  c: number;
  sse: number;
}

/**
 * Calibrate a raw-SVI slice to observed `(k, w)` total-variance points. Needs at least 5 distinct
 * strikes to identify the five parameters. The calibration is penalized for butterfly violations and
 * refined toward an arbitrage-free fit; the result carries its RMSE plus the verified
 * `butterflyFree` / `minButterflyG` diagnostics (it is *not* assumed arbitrage-free).
 *
 * **The fit is an arbitrage-free PROJECTION of the data, so it is also checked AGAINST the data.**
 * The butterfly penalty deliberately walks the fit away from an arbitrageable smile, and
 * `butterflyFree`/`minButterflyG` measure the FITTED slice's own density — they say nothing about how
 * far that slice ended up from the quotes. A smile that embeds butterfly arbitrage can therefore be
 * projected onto a clean SVI a hundred vol points away, which is a perfectly arbitrage-free answer to
 * a different question. So the result reports the fit-vs-data distance in implied-VOL points
 * (`σ = √(w/t)`, with `t` from `options.timeToExpiryYears`, default 1): when the RMSE exceeds
 * `max(0.005, 2% of mean IV)` or any single point is off by more than 5 vol points, `converged` is
 * `false` and a `volatility.calibration_fit_deviation` warning carries `{ rmse, maxDeviation }`.
 */
/** Total-variance smile input for {@link calibrateSvi}: log-moneyness `k` and total variance `w` points. */
export interface SVISmileInput {
  /** Log-moneyness `ln(K/F)` per observation. */
  k: number[];
  /** Total implied variance `σ²·t` aligned to `k`. */
  w: number[];
}

export function calibrateSvi(
  input: SVISmileInput,
  options: SVICalibrationOptions = {},
): SVICalibrationResult {
  validateClosedRequest('calibrateSvi', input, CALIBRATE_SVI_INPUT_SPEC, {
    exampleCall: CALIBRATE_SVI_EXAMPLE_CALL,
  });
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  validateClosedRequest('calibrateSvi', options, CALIBRATE_SVI_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: CALIBRATE_SVI_EXAMPLE_CALL,
  });
  requireCalibrationIterationBudget('calibrateSvi', options.maximumIterations);
  const { k, w } = input;
  const functionName = 'calibrateSvi';
  const start = options.initialParameters;
  if (start !== undefined) {
    ensureFinite(start.m, 'initialParameters.m', functionName);
    ensurePositive(start.sigma, 'initialParameters.sigma', functionName);
  }
  if (options.timeToExpiryYears !== undefined) {
    // A zero/negative/NaN maturity would turn the vol-space deviation check into ∞/NaN and silently
    // disable the disclosure it exists to make.
    ensurePositive(options.timeToExpiryYears, 'timeToExpiryYears', functionName);
  }
  const timeToExpiryYears = options.timeToExpiryYears ?? 1;
  const n = k.length;
  if (n !== w.length) {
    throw new InputError(
      `${functionName}: k and w must have the same length (${n} vs ${w.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { k: n, w: w.length },
      },
    );
  }
  if (n < 5) {
    throw new InputError(
      `${functionName}: need ≥ 5 points to identify the 5 SVI parameters, got ${n}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { points: n },
      },
    );
  }
  for (let i = 0; i < n; i++) {
    ensureFinite(k[i]!, `k[${i}]`, functionName);
    ensureFinite(w[i]!, `w[${i}]`, functionName);
    if (w[i]! < 0) {
      throw new InputError(`${functionName}: total variance w[${i}] must be ≥ 0, got ${w[i]}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { index: i, w: w[i] },
      });
    }
  }

  const maxW = Math.max(...w);

  // Inner problem: given (m, σ) the fit is linear in (a, d, c) → solve the 3×3 normal equations,
  // then project onto the Zeliade no-arbitrage box.
  const innerFit = (m: number, sigma: number): InnerFit => {
    const s = Math.max(sigma, 1e-8);
    let S1 = 0;
    let Sy = 0;
    let Sz = 0;
    let Syy = 0;
    let Syz = 0;
    let Szz = 0;
    let Sw = 0;
    let Syw = 0;
    let Szw = 0;
    for (let i = 0; i < n; i++) {
      const y = (k[i]! - m) / s;
      const z = Math.sqrt(y * y + 1);
      const wi = w[i]!;
      S1 += 1;
      Sy += y;
      Sz += z;
      Syy += y * y;
      Syz += y * z;
      Szz += z * z;
      Sw += wi;
      Syw += y * wi;
      Szw += z * wi;
    }
    const A = [
      [S1, Sy, Sz],
      [Sy, Syy, Syz],
      [Sz, Syz, Szz],
    ];
    const rhs = [Sw, Syw, Szw];
    let a: number;
    let d: number;
    let c: number;
    try {
      // normal equations A·[a,d,c] = rhs with A = XᵀX (SPD) → Cholesky factor then solve.
      [a, d, c] = choleskySolve(cholesky(A), rhs) as [number, number, number];
    } catch {
      return { a: 0, d: 0, c: 0, sse: Number.POSITIVE_INFINITY };
    }
    // Zeliade no-arbitrage box: 0 ≤ c ≤ 4σ, |d| ≤ c, |d| ≤ 4σ − c, 0 ≤ a ≤ max(w).
    c = clamp(c, 0, 4 * s);
    const dCap = Math.min(c, 4 * s - c);
    d = clamp(d, -dCap, dCap);
    a = clamp(a, 0, maxW);
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const y = (k[i]! - m) / s;
      const z = Math.sqrt(y * y + 1);
      const model = a + d * y + c * z;
      sse += (model - w[i]!) ** 2;
    }
    return { a, d, c, sse };
  };

  // Build the SVI parameters implied by an inner fit at (m, σ).
  const paramsAt = (inner: InnerFit, m: number, sigma: number): SVIParameters => ({
    a: inner.a,
    b: inner.c / sigma,
    rho: inner.c > 0 ? clamp(inner.d / inner.c, -1, 1) : 0,
    m,
    sigma,
  });

  // Penalty grid + weight: the Zeliade box keeps the fit well-posed but does NOT by itself guarantee
  // a non-negative density, so the outer search is penalized for butterfly violations (g(k) < 0).
  // This drives the optimizer to the closest arbitrage-free SVI; the penalty is 0 for an arb-free fit
  // (so clean-data recovery is unaffected), and dominates the tiny RMSE when a violation appears.
  // The penalty AND check grids span the calibrated slice (WS2.11) so wing troughs beyond ±1 are both
  // penalized during the fit and reflected in the reported butterflyFree/minButterflyG.
  const gGrid = butterflyGrid(k);
  const BUTTERFLY_PENALTY = 200;
  const butterflyPenalty = (p: SVIParameters): number => {
    let acc = 0;
    for (const kk of gGrid) {
      const wk = totalVarianceUnchecked(p, kk);
      if (wk <= 1e-8) {
        acc += 1; // a non-positive total variance is itself an arbitrage
        continue;
      }
      const g = gUnchecked(p, kk);
      if (g < 0) acc += g * g;
    }
    return acc;
  };
  const fullSse = (p: SVIParameters): number => {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += (totalVarianceUnchecked(p, k[i]!) - w[i]!) ** 2;
    return acc;
  };

  // Outer search over (m, log σ). Try several starts for robustness against local minima.
  const objective = (x: number[]): number => {
    const sigma = Math.exp(x[1]!);
    const inner = innerFit(x[0]!, sigma);
    if (!Number.isFinite(inner.sse)) return inner.sse;
    return inner.sse + BUTTERFLY_PENALTY * butterflyPenalty(paramsAt(inner, x[0]!, sigma));
  };
  const kMin = Math.min(...k);
  const kMax = Math.max(...k);
  const span = Math.max(kMax - kMin, 1e-3);
  const mAtMinW = k[w.indexOf(Math.min(...w))]!;
  const starts: number[][] = [
    // A supplied warm start goes first; the built-in starts still run, and a strict `<` on the
    // penalized objective keeps the first of equals — so a warm start is never worse than cold.
    ...(start !== undefined ? [[start.m, Math.log(start.sigma)]] : []),
    [mAtMinW, Math.log(span / 2)],
    [0, Math.log(0.1)],
    [(kMin + kMax) / 2, Math.log(span)],
    [mAtMinW, Math.log(0.05)],
  ];

  let best: {
    m: number;
    sigma: number;
    objective: number;
    iterations: number;
    converged: boolean;
  } | null = null;
  for (const start of starts) {
    const res = nelderMead(objective, start, {
      maximumIterations: options.maximumIterations ?? 400,
      tolerance: options.tolerance ?? 1e-12,
    });
    const value = objective(res.argMin);
    // Select on the penalized objective so an arbitrage-free fit wins over a lower-RMSE arb fit.
    if (best === null || value < best.objective) {
      best = {
        m: res.argMin[0]!,
        sigma: Math.exp(res.argMin[1]!),
        objective: value,
        iterations: res.iterations,
        converged: res.converged,
      };
    }
  }

  const f = best!;
  const inner = innerFit(f.m, f.sigma);
  let chosen = paramsAt(inner, f.m, f.sigma);
  let chosenMinG = sviMinG(chosen, gGrid);
  let chosenSse = inner.sse;
  let iterations = f.iterations;

  // If the Zeliade fit is butterfly-arbitrageable, the closed-form inner step is trapped in an
  // RMSE-optimal-but-arb region the outer (m, σ) penalty can't leave. Refine over all five
  // parameters (seeded from the Zeliade fit and a couple of smooth starts) and keep the best
  // arbitrage-free result; among arbitrage-free fits prefer the lower RMSE, otherwise the less-violating.
  if (chosenMinG < -1e-8) {
    const wMin = Math.min(...w);
    const refineSeeds: SVIParameters[] = [
      chosen,
      { a: Math.max(0, wMin * 0.8), b: 0.3, rho: -0.3, m: mAtMinW, sigma: Math.max(0.1, span / 2) },
      { a: Math.max(0, wMin * 0.5), b: 0.15, rho: -0.5, m: mAtMinW, sigma: Math.max(0.2, span) },
    ];
    const refineMaxIter = options.maximumIterations ?? 400;
    const refineTol = options.tolerance ?? 1e-12;
    for (const seed of refineSeeds) {
      const x0 = [
        seed.a,
        Math.log(Math.max(seed.b, 1e-6)),
        Math.atanh(clamp(seed.rho, -0.999, 0.999)),
        seed.m,
        Math.log(Math.max(seed.sigma, 1e-6)),
      ];
      const res = nelderMead(
        (x) => {
          const p: SVIParameters = {
            a: x[0]!,
            b: Math.exp(x[1]!),
            rho: Math.tanh(x[2]!),
            m: x[3]!,
            sigma: Math.exp(x[4]!),
          };
          return fullSse(p) + BUTTERFLY_PENALTY * butterflyPenalty(p);
        },
        x0,
        { maximumIterations: refineMaxIter, tolerance: refineTol },
      );
      iterations += res.iterations;
      const cand: SVIParameters = {
        a: res.argMin[0]!,
        b: Math.exp(res.argMin[1]!),
        rho: Math.tanh(res.argMin[2]!),
        m: res.argMin[3]!,
        sigma: Math.exp(res.argMin[4]!),
      };
      const candMinG = sviMinG(cand, gGrid);
      const candSse = fullSse(cand);
      const candFree = candMinG >= -1e-8;
      const chosenFree = chosenMinG >= -1e-8;
      const better = chosenFree
        ? candFree && candSse < chosenSse // both free → lower RMSE
        : candFree || candMinG > chosenMinG; // reach free, or be less-violating
      if (better) {
        chosen = cand;
        chosenMinG = candMinG;
        chosenSse = candSse;
      }
    }
  }

  // ── fit-vs-DATA gate ──────────────────────────────────────────────────────────────────────────
  // Measured in implied-vol points so the numbers mean something to a trader (a 0.02 total-variance
  // miss is unreadable; "the fit is 105 vol points off the quotes" is not).
  const ivOf = (variance: number): number => Math.sqrt(Math.max(0, variance) / timeToExpiryYears);
  let deviationSumSquared = 0;
  let maxDeviation = 0;
  let ivSum = 0;
  for (let i = 0; i < n; i++) {
    const ivData = ivOf(w[i]!);
    const deviation = ivOf(totalVarianceUnchecked(chosen, k[i]!)) - ivData;
    deviationSumSquared += deviation * deviation;
    ivSum += ivData;
    if (Math.abs(deviation) > maxDeviation) maxDeviation = Math.abs(deviation);
  }
  const deviationRmse = Math.sqrt(deviationSumSquared / n);
  const rmseTolerance = Math.max(
    FIT_DEVIATION_RMSE_FLOOR,
    FIT_DEVIATION_RMSE_RELATIVE * (ivSum / n),
  );
  const fitDeviates = deviationRmse > rmseTolerance || maxDeviation > FIT_DEVIATION_MAX_POINT;

  const searchConverged = f.converged && Number.isFinite(chosenSse);
  // A fit that is arbitrage-free but nowhere near the data has not "converged" to the smile it was
  // asked to fit — it converged to the projection. Say so on the flag the caller gates on.
  const converged = searchConverged && !fitDeviates;
  const butterflyFree = chosenMinG >= -1e-8;
  const warnings: QuantWarning[] = [];
  if (fitDeviates) {
    warnings.push(
      warning(
        // Registered in ErrorCode (the single source of truth for codes that are both a thrown
        // condition and an emitted warning — WS2.9), referenced here for the warning string.
        ErrorCode.VolatilityCalibrationFitDeviation,
        `calibrateSvi: the fitted slice deviates materially from the input smile (rmse ${(
          deviationRmse * 100
        ).toFixed(2)} vol pts vs a ${(rmseTolerance * 100).toFixed(2)} tolerance; worst point ${(
          maxDeviation * 100
        ).toFixed(
          2,
        )} vol pts) — the butterfly penalty drove the fit to the closest arbitrage-free slice, which is NOT the quoted smile.`,
        'warn',
        {
          rmse: deviationRmse,
          maxDeviation,
          rmseTolerance,
          maxDeviationTolerance: FIT_DEVIATION_MAX_POINT,
          timeToExpiryYears,
          hint: 'input smile is likely arbitrageable; the fit is the arbitrage-free projection',
        },
      ),
    );
  }
  if (!searchConverged) {
    warnings.push(
      warning(
        WarningCode.VolatilityCalibrationNotConverged,
        `calibrateSvi: the outer (m, σ) search stopped without converging — parameters are the best point found; gate on \`converged\` before trusting them.`,
        'warn',
        { iterations },
      ),
    );
  }
  if (!butterflyFree) {
    warnings.push(
      warning(
        WarningCode.VolatilityButterflyArbitrage,
        `calibrateSvi: the fitted slice is butterfly-arbitrageable (min Gatheral g = ${chosenMinG.toFixed(6)} < 0) — the market data likely embeds it; treat the wings with caution.`,
        'warn',
        { minButterflyG: chosenMinG },
      ),
    );
  }
  return {
    parameters: chosen,
    rmse: Math.sqrt(chosenSse / n),
    converged,
    iterations,
    butterflyFree,
    minButterflyG: chosenMinG,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: 'zeliade-quasi-explicit',
      points: n,
      initialParameters: start !== undefined ? 'supplied' : 'default',
    },
    diagnostics: {
      engine: 'svi',
      method: 'zeliade + nelder-mead',
      converged,
      iterations,
      warnings,
    },
  };
}
