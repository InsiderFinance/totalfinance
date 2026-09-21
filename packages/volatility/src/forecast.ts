/**
 * Volatility forecasting (spec §10.2 — WS9.2).
 *
 * Two workhorse variance-forecasting models built on the returns / realized-variance series:
 *
 *   - GARCH(1,1) — the conditional-variance recursion `σ²ₜ = ω + α·r²ₜ₋₁ + β·σ²ₜ₋₁`, fit by Gaussian
 *     maximum likelihood. Optimization runs in an unconstrained reparameterization (ω = e^θ_ω, and a
 *     logistic split of the persistence `α+β` and the weight `α/(α+β)`), so every point the optimizer
 *     visits is a valid stationary GARCH (`ω>0, α≥0, β≥0, α+β<1`) — no penalty terms, no post-hoc
 *     clamping. The simplex is seeded by *variance targeting* (`ω = (1−α−β)·Var`). Convergence and the
 *     iteration count are reported straight from the {@link nelderMead} result; a degenerate,
 *     zero-variance series reports `converged: false` rather than a fabricated fit.
 *
 *   - HAR-RV (Corsi 2009) — an OLS regression of the realized variance on its daily / weekly / monthly
 *     lagged aggregates. The 4×4 normal system is solved by a numerically-stable QR least squares.
 *
 * Browser-safe; no clock reads. The seeded PRNG (`mulberry32`) drives only the deterministic
 * multi-start of the GARCH optimizer, so a given `seed` yields a bit-for-bit reproducible fit.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  type QuantWarning,
  UnsupportedError,
  WarningCode,
  ensureFinite,
  ensureNonNegative,
  ensurePositive,
  finalizeResult,
  isQuantError,
  requireArgumentArray,
  validateClosedRequest,
  warning,
} from '@totalfinance/core';
import { mean, mulberry32, nelderMead, qrSolve } from '@totalfinance/math';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import. The returns / realized-variance ARRAY
 * arguments carry no generated key (top-level arrays are not closed requests) and keep their
 * curated per-element checks.
 */
function forecastSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `forecast: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

/**
 * Hard cap on the multi-step forecast horizon (2026-08-23 review, P0): `horizonPeriods` sizes
 * three materialized path arrays and drives the forecast loop, so an "integer" of 1e308 was an
 * absurd allocation and above 2^53 a non-terminating loop. 100,000 daily periods ≈ 400 years —
 * GARCH mean reversion collapsed onto the long-run variance far earlier — and the three paths
 * stay ~2.4 MB, milliseconds of work.
 */
const MAX_FORECAST_HORIZON_PERIODS = 100_000;

const FIT_GARCH_OPTIONS_SPEC = forecastSpecOf('fitGarch#1');
const FIT_HAR_RV_OPTIONS_SPEC = forecastSpecOf('fitHarRv#1');
const GARCH_FORECAST_SPEC = forecastSpecOf('garchForecast#0');
const HAR_RV_FORECAST_FIT_SPEC = forecastSpecOf('harRvForecast#0');

const FIT_GARCH_EXAMPLE = (): string => "fitGarch(returns, { mean: 'zero', seed: 42 })";
const FIT_HAR_RV_EXAMPLE = (): string => 'fitHarRv(realizedVariances, { weekly: 5, monthly: 22 })';
const GARCH_FORECAST_EXAMPLE = (): string =>
  'garchForecast({ fit: fitGarch(returns), lastVariance: 0.0004, horizonPeriods: 10, ' +
  'options: { periodsPerYear: 252 } })';
const HAR_RV_FORECAST_EXAMPLE = (): string =>
  'harRvForecast(fitHarRv(realizedVariances), realizedVariances)';

// ───────────────────────────────────── GARCH(1,1) ─────────────────────────────────────

/** A fitted GARCH(1,1) model. `converged`/`iterations` mirror the optimizer result honestly. */
export interface GarchFit {
  /** Constant term of the variance recursion (`> 0`). */
  omega: number;
  /** ARCH coefficient on the lagged squared return (`≥ 0`). */
  alpha: number;
  /** GARCH coefficient on the lagged conditional variance (`≥ 0`). */
  beta: number;
  /** `α + β` — the variance half-life driver; `< 1` for a stationary fit. */
  persistence: number;
  /** Unconditional variance `ω / (1 − α − β)` the forecast mean-reverts to. */
  longRunVariance: number;
  /** Maximized Gaussian log-likelihood; `null` when the likelihood is degenerate (disclosed). */
  logLikelihood: number | null;
  /** Whether the optimizer converged (never fabricated). */
  converged: boolean;
  /** Optimizer iterations performed. */
  iterations: number;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    mean: 'zero' | 'sample';
    observations: number;
    /** Whether the primary start was caller-supplied (`initialParameters`) or the classic (0.05, 0.90). */
    initialParameters: 'supplied' | 'default';
  };
  /** Structured warnings; a degenerate / non-converged fit explains itself here. */
  diagnostics: { warnings: QuantWarning[] };
}

/** Options for {@link fitGarch}. */
export interface GarchFitOptions {
  /** Seed for the deterministic multi-start of the optimizer (default `0x61726368`). */
  seed?: number;
  /** `'zero'` (default) assumes a zero-mean series; `'sample'` de-means by the sample mean first. */
  mean?: 'zero' | 'sample';
  /**
   * Warm start for the `(α, β)` search (Stage 4.5): replaces the primary `(0.05, 0.90)` start; `ω`
   * is derived by variance targeting and is not a start. The seeded restarts still run.
   */
  initialParameters?: { alpha: number; beta: number };
}

/** The multi-step variance forecast produced by {@link garchForecast}. */
export interface GarchForecast {
  /** `σ²ₜ₊ₕ` for `h = 1..horizonPeriods`. */
  variancePath: number[];
  /** `√σ²ₜ₊ₕ` — the per-period volatility. */
  volatilityPath: number[];
  /** `√(σ²ₜ₊ₕ · periodsPerYear)` — the annualized volatility. */
  annualizedVolatility: number[];
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; periodsPerYear: number; horizonPeriods: number };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** Options for {@link garchForecast}. */
export interface GarchForecastOptions {
  /** Periods per year for annualization (default 252 trading days). */
  periodsPerYear?: number;
}

/** Minimum returns required for a meaningful GARCH MLE. */
const GARCH_MIN_OBS = 50;
/** Cap the persistence strictly below 1 so `longRunVariance` stays finite. */
const PERSISTENCE_CAP = 1 - 1e-6;

/** Numerically-stable logistic `1/(1+e^{−x})`. */
function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x));
}

/** Inverse logistic on `(0, 1)`. */
function logit(x: number): number {
  return Math.log(x / (1 - x));
}

/**
 * Fit a GARCH(1,1) model to a returns series by Gaussian MLE.
 *
 * The conditional variance follows `σ²ₜ = ω + α·r²ₜ₋₁ + β·σ²ₜ₋₁`, seeded with the sample second moment
 * `E[r²]`. The optimizer works in the unconstrained space `θ = (log ω, logit p, logit f)` where
 * `p = α+β` and `f = α/(α+β)`, so `ω>0, α≥0, β≥0, α+β<1` hold at every evaluation. A degenerate
 * (constant / zero-variance) series has no variance process to fit and returns `converged: false`.
 */
export function fitGarch(returns: number[], options: GarchFitOptions = {}): GarchFit {
  requireArgumentArray('fitGarch', 'returns', returns);
  const functionName = 'fitGarch';
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  validateClosedRequest(functionName, options, FIT_GARCH_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: FIT_GARCH_EXAMPLE,
  });
  if (returns.length < GARCH_MIN_OBS) {
    throw new InputError(
      `${functionName}: needs at least ${GARCH_MIN_OBS} returns to fit GARCH(1,1), got ${returns.length}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { length: returns.length, minimum: GARCH_MIN_OBS },
      },
    );
  }
  for (let i = 0; i < returns.length; i++) ensureFinite(returns[i]!, `returns[${i}]`, functionName);

  const meanMode = options.mean ?? 'zero';
  const start = options.initialParameters;
  if (start !== undefined) {
    ensureNonNegative(start.alpha, 'initialParameters.alpha', functionName);
    ensureNonNegative(start.beta, 'initialParameters.beta', functionName);
    if (!(start.alpha + start.beta < PERSISTENCE_CAP)) {
      throw new InputError(
        `${functionName}: initialParameters.alpha + beta must be below the stationarity cap ${PERSISTENCE_CAP} (got ${start.alpha + start.beta}) — a start at or past unit persistence has no stationary variance to target.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: 'initialParameters', alpha: start.alpha, beta: start.beta },
        },
      );
    }
  }
  const startKind = start !== undefined ? 'supplied' : 'default';
  const mu = meanMode === 'sample' ? mean(returns) : 0;
  const r = mu === 0 ? returns : returns.map((x) => x - mu);
  const n = r.length;

  // Unconditional variance seed = mean squared (de-meaned) return. If there is no variance to explain
  // (constant / zero series), the likelihood is degenerate: report an honest non-convergence.
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += r[i]! * r[i]!;
  const meanSq = sumSq / n;
  if (!(meanSq > 0) || !Number.isFinite(meanSq)) {
    return {
      omega: 0,
      alpha: 0,
      beta: 0,
      persistence: 0,
      longRunVariance: 0,
      // A degenerate series has no likelihood to maximize — null-with-reason, never NaN (Law 7).
      logLikelihood: null,
      converged: false,
      iterations: 0,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        mean: meanMode,
        observations: n,
        initialParameters: startKind,
      },
      diagnostics: {
        warnings: [
          warning(
            WarningCode.VolatilityCalibrationNotConverged,
            `${functionName}: the (de-meaned) return series has zero variance — there is no variance process to fit; parameters are zeros with converged: false.`,
            'warn',
            { observations: n },
          ),
        ],
      },
    };
  }
  const h0 = meanSq;
  const LOG2PI = Math.log(2 * Math.PI);

  // Negative Gaussian log-likelihood of the conditional-variance recursion (sum over t = 1..n-1).
  const negLogLik = (parameters: { omega: number; alpha: number; beta: number }): number => {
    const { omega, alpha, beta } = parameters;
    let h = h0;
    let nll = 0;
    for (let t = 1; t < n; t++) {
      const rp = r[t - 1]!;
      h = omega + alpha * rp * rp + beta * h;
      if (!(h > 0) || !Number.isFinite(h)) return Number.POSITIVE_INFINITY;
      const rt = r[t]!;
      nll += 0.5 * (LOG2PI + Math.log(h) + (rt * rt) / h);
    }
    return Number.isFinite(nll) ? nll : Number.POSITIVE_INFINITY;
  };

  // θ ↦ (ω, α, β). The logistic split guarantees a valid stationary GARCH for any θ ∈ ℝ³.
  const decode = (theta: number[]): { omega: number; alpha: number; beta: number } => {
    const omega = Math.exp(theta[0]!);
    const p = Math.min(sigmoid(theta[1]!), PERSISTENCE_CAP);
    const f = sigmoid(theta[2]!);
    return { omega, alpha: p * f, beta: p * (1 - f) };
  };
  const objective = (theta: number[]): number => {
    const { omega, alpha, beta } = decode(theta);
    return negLogLik({ omega, alpha, beta });
  };

  // Variance-targeting encode: ω = (1−p)·Var, with a floor so log ω stays finite.
  const encode = (alpha0: number, beta0: number): number[] => {
    const p0 = Math.min(Math.max(alpha0 + beta0, 1e-6), PERSISTENCE_CAP);
    const f0 = Math.min(Math.max(alpha0 / (alpha0 + beta0), 1e-6), 1 - 1e-6);
    const omega0 = Math.max((1 - p0) * h0, 1e-300);
    return [Math.log(omega0), logit(p0), logit(f0)];
  };

  // Primary start is the classic (α=0.05, β=0.90) variance-targeting seed; a few seeded restarts guard
  // against the shallow local optima GARCH likelihoods are prone to.
  const seed = options.seed ?? 0x61726368; // 'arch'
  const randomNumberGenerator = mulberry32(seed);
  const starts: Array<[number, number]> = [
    start !== undefined ? [start.alpha, start.beta] : [0.05, 0.9],
  ];
  for (let k = 0; k < 3; k++) {
    const a0 = 0.005 + 0.14 * randomNumberGenerator.next();
    const b0 = 0.8 + 0.19 * randomNumberGenerator.next();
    if (a0 + b0 < PERSISTENCE_CAP) starts.push([a0, b0]);
  }

  let best: ReturnType<typeof nelderMead> | null = null;
  for (const [a0, b0] of starts) {
    const res = nelderMead(objective, encode(a0, b0), {
      maximumIterations: 2000,
      tolerance: 1e-10,
    });
    if (best === null) {
      best = res;
    } else if (res.converged && !best.converged) {
      best = res; // prefer a converged run over a non-converged one
    } else if (res.converged === best.converged && res.minimum < best.minimum) {
      best = res; // among equal convergence status, the lower NLL wins
    }
  }

  const { omega, alpha, beta } = decode(best!.argMin);
  const persistence = alpha + beta;
  const warnings: QuantWarning[] = [];
  if (!best!.converged) {
    warnings.push(
      warning(
        WarningCode.VolatilityCalibrationNotConverged,
        `${functionName}: the MLE search stopped without converging — parameters are the best point found; gate on \`converged\` before trusting them.`,
        'warn',
        { iterations: best!.iterations },
      ),
    );
  }
  if (!Number.isFinite(best!.minimum)) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `${functionName}: the likelihood never evaluated finite along the search — logLikelihood is null (no finite maximum was found).`,
        'warn',
      ),
    );
  }
  return {
    omega,
    alpha,
    beta,
    persistence,
    longRunVariance: omega / (1 - persistence),
    logLikelihood: Number.isFinite(best!.minimum) ? -best!.minimum : null,
    converged: best!.converged,
    iterations: best!.iterations,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      mean: meanMode,
      observations: n,
      initialParameters: startKind,
    },
    diagnostics: { warnings },
  };
}

/**
 * Multi-step GARCH(1,1) variance forecast. The `h`-step-ahead conditional variance mean-reverts
 * geometrically to the long-run variance: `σ²ₜ₊ₕ = LRV + (α+β)^h · (σ²ₜ − LRV)`. Because `0 < α+β < 1`,
 * the path moves monotonically toward `LRV`; a forecast started exactly at `LRV` stays flat.
 */
export interface GarchForecastInput {
  fit: GarchFit;
  lastVariance: number;
  horizonPeriods: number;
  options?: GarchForecastOptions;
}

export function garchForecast(input: GarchForecastInput): GarchForecast {
  const functionName = 'garchForecast';
  // A missing/scalar `fit` must teach ("pass the result of fitGarch()"), not die on a raw
  // `.longRunVariance` TypeError — the spec's nested `fit` contract names any missing field.
  validateClosedRequest(functionName, input, GARCH_FORECAST_SPEC, {
    exampleCall: GARCH_FORECAST_EXAMPLE,
  });
  const { fit, lastVariance, horizonPeriods, options: options = {} } = input;
  ensurePositive(lastVariance, 'lastVariance', functionName);
  // Safe integer AND a work cap (2026-08-23 review, P0): horizonPeriods sizes THREE materialized
  // path arrays and drives the forecast loop — `Number.isInteger(1e308)` is `true`, so the old
  // gate was an absurd-allocation license, and above 2^53 the loop counter stops advancing.
  // 100,000 daily periods is ~400 years; the forecast has geometrically collapsed onto the
  // long-run variance long before that, and the three paths stay ~2.4 MB — milliseconds of work.
  if (
    !Number.isSafeInteger(horizonPeriods) ||
    horizonPeriods < 1 ||
    horizonPeriods > MAX_FORECAST_HORIZON_PERIODS
  ) {
    throw new InputError(
      `${functionName}: horizonPeriods must be a positive integer ≤ ${MAX_FORECAST_HORIZON_PERIODS.toLocaleString('en-US')} (~400 years of daily periods — the forecast materializes three arrays of this length, and GARCH mean reversion has collapsed onto the long-run variance far earlier), got ${horizonPeriods}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { horizonPeriods, max: MAX_FORECAST_HORIZON_PERIODS },
      },
    );
  }
  const periodsPerYear = options.periodsPerYear ?? 252;
  ensurePositive(periodsPerYear, 'periodsPerYear', functionName);

  const lrv = fit.longRunVariance;
  const phi = fit.persistence;
  const variancePath = new Array<number>(horizonPeriods);
  const volatilityPath = new Array<number>(horizonPeriods);
  const annualizedVolatility = new Array<number>(horizonPeriods);
  for (let h = 1; h <= horizonPeriods; h++) {
    const raw = lrv + Math.pow(phi, h) * (lastVariance - lrv);
    const v = raw > 0 ? raw : 0; // guard against a rounding-driven sliver below zero
    variancePath[h - 1] = v;
    volatilityPath[h - 1] = Math.sqrt(v);
    annualizedVolatility[h - 1] = Math.sqrt(v * periodsPerYear);
  }
  return {
    variancePath,
    volatilityPath,
    annualizedVolatility,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, periodsPerYear, horizonPeriods },
    diagnostics: { warnings: [] },
  };
}

// ─────────────────────────────────── HAR-RV (Corsi) ───────────────────────────────────

/** OLS coefficients of the HAR-RV regression `RVₜ = const + daily·RVᵈ + weekly·RVʷ + monthly·RVᵐ`. */
export interface HarRvCoefficients {
  /** Intercept. */
  const: number;
  /** Loading on the previous day's realized variance. */
  daily: number;
  /** Loading on the trailing weekly-average realized variance. */
  weekly: number;
  /** Loading on the trailing monthly-average realized variance. */
  monthly: number;
}

/** A fitted HAR-RV model plus its in-sample fit diagnostics. */
export interface HarRvFit {
  coefficients: HarRvCoefficients;
  /** In-sample coefficient of determination (`null` for a flat response — disclosed, never NaN). */
  rSquared: number | null;
  /** In-sample residuals `RVₜ − ŘVₜ`, one per fitted observation. */
  residuals: number[];
  /** Number of fitted observations. */
  observationCount: number;
  /** The daily/weekly/monthly averaging windows used (also drives {@link harRvForecast}). */
  windows: { weekly: number; monthly: number };
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; method: 'ols-qr'; weekly: number; monthly: number };
  /** Structured warnings; a flat response (undefined R²) explains itself here. */
  diagnostics: { warnings: QuantWarning[] };
}

/** Options for {@link fitHarRv}. */
export interface HarRvOptions {
  /** Weekly averaging window in observations (default 5). */
  weekly?: number;
  /** Monthly averaging window in observations (default 22). */
  monthly?: number;
}

/** Predictors in the HAR-RV design matrix: `[1, daily, weekly, monthly]`. */
const HAR_PREDICTORS = 4;

/** Mean of the trailing `window` observations of `series` ending at index `end` (inclusive). */
function trailingMean(series: number[], end: number, window: number): number {
  let s = 0;
  for (let i = 0; i < window; i++) s += series[end - i]!;
  return s / window;
}

/**
 * Fit a HAR-RV (heterogeneous autoregressive) model to a realized-variance series by OLS.
 *
 * Regresses `RVₜ` on `[1, RVₜ₋₁, avg(last {@link HarRvOptions.weekly}), avg(last
 * {@link HarRvOptions.monthly})]`. The 4×4 least-squares system is solved by QR (stable — no
 * normal-equations conditioning penalty). Requires more than `monthly` observations, with at least
 * {@link HAR_PREDICTORS} fitted rows so the system is well-posed.
 */
export function fitHarRv(realizedVariances: number[], options: HarRvOptions = {}): HarRvFit {
  requireArgumentArray('fitHarRv', 'realizedVariances', realizedVariances);
  const functionName = 'fitHarRv';
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  validateClosedRequest(functionName, options, FIT_HAR_RV_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: FIT_HAR_RV_EXAMPLE,
  });
  const weekly = options.weekly ?? 5;
  const monthly = options.monthly ?? 22;
  // Safe integers (2026-08-23 review, P0): the windows drive the trailing-mean loops, but the
  // `length ≥ monthly + rows` requirement below keeps both data-bounded — the safe gate keeps the
  // counts exact before that comparison runs.
  if (!Number.isSafeInteger(weekly) || weekly < 1) {
    throw new InputError(
      `${functionName}: weekly window must be a positive integer, got ${weekly}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { weekly },
      },
    );
  }
  if (!Number.isSafeInteger(monthly) || monthly < weekly) {
    throw new InputError(
      `${functionName}: monthly window must be an integer ≥ weekly (${weekly}), got ${monthly}.`,
      { code: ErrorCode.InputOutOfRange, context: { weekly, monthly } },
    );
  }
  const rv = realizedVariances;
  const obs = rv.length - monthly;
  if (obs < HAR_PREDICTORS) {
    throw new InputError(
      `${functionName}: needs at least ${
        monthly + HAR_PREDICTORS
      } realized variances (monthly window ${monthly} + ${HAR_PREDICTORS} rows), got ${rv.length}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { length: rv.length, monthly, minimum: monthly + HAR_PREDICTORS },
      },
    );
  }
  for (let i = 0; i < rv.length; i++) {
    ensureFinite(rv[i]!, `realizedVariances[${i}]`, functionName);
    // Realized VARIANCE is non-negative by construction; a negative input is a data error, not a fit.
    if (rv[i]! < 0) {
      throw new InputError(
        `${functionName}: realized variances must be non-negative, got ${rv[i]} at index ${i}.`,
        { code: ErrorCode.InputOutOfRange, context: { index: i, value: rv[i] } },
      );
    }
  }

  const X: number[][] = [];
  const y: number[] = [];
  for (let t = monthly; t < rv.length; t++) {
    const daily = rv[t - 1]!;
    const w = trailingMean(rv, t - 1, weekly);
    const m = trailingMean(rv, t - 1, monthly);
    X.push([1, daily, w, m]);
    y.push(rv[t]!);
  }

  let coefficient: number[];
  try {
    coefficient = qrSolve(X, y); // [const, daily, weekly, monthly]
  } catch (e) {
    // A rank-deficient design (e.g. a constant/degenerate RV series makes the daily/weekly/monthly
    // predictors collinear) has no well-posed OLS fit — report that, don't emit blown-up coefficients.
    if (isQuantError(e, ErrorCode.LinalgSingular)) {
      throw new InputError(
        `${functionName}: the HAR-RV predictors are collinear (degenerate realized-variance series, e.g. constant); the least-squares fit is not identifiable.`,
        { code: ErrorCode.LinalgSingular, context: { observations: y.length } },
      );
    }
    throw e;
  }
  const c0 = coefficient[0]!;
  const c1 = coefficient[1]!;
  const c2 = coefficient[2]!;
  const c3 = coefficient[3]!;

  const yBar = mean(y);
  const residuals = new Array<number>(y.length);
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < y.length; i++) {
    const row = X[i]!;
    const fitted = c0 + c1 * row[1]! + c2 * row[2]! + c3 * row[3]!;
    const e = y[i]! - fitted;
    residuals[i] = e;
    ssRes += e * e;
    const dy = y[i]! - yBar;
    ssTot += dy * dy;
  }
  // A flat response has no variance to explain — R² is undefined; null-with-reason (Law 7).
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : null;
  const warnings: QuantWarning[] = [];
  if (rSquared === null) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `${functionName}: the realized-variance response is flat across the fitted rows — R² is undefined and reported null.`,
        'warn',
        { fittedRows: y.length },
      ),
    );
  }

  return {
    coefficients: { const: c0, daily: c1, weekly: c2, monthly: c3 },
    rSquared,
    residuals,
    observationCount: y.length,
    windows: { weekly, monthly },
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, method: 'ols-qr', weekly, monthly },
    diagnostics: { warnings },
  };
}

/** Everything `harRvForecast` computes on the way to the scalar — the `.explain` disclosure set. */
interface HarRvForecastComputation {
  windows: { weekly: number; monthly: number };
  /** The three predictors: last RV, trailing weekly mean, trailing monthly mean. */
  predictors: { daily: number; weekly: number; monthly: number };
  /** Per-term contributions `coefficient·predictor` (plus the intercept) that sum to the forecast. */
  contributions: { intercept: number; daily: number; weekly: number; monthly: number };
  value: number;
}

function harRvForecastComputation(
  functionName: string,
  fit: HarRvFit,
  history: number[],
): HarRvForecastComputation {
  // A hand-rolled `fit` without `windows`/`coefficients` must teach the expected shape (pass the
  // result of fitHarRv()), not die on a raw destructure TypeError — the spec names every field.
  validateClosedRequest(functionName, fit, HAR_RV_FORECAST_FIT_SPEC, {
    argumentName: 'fit',
    // The manifest declares this argument `open` (Law 12): a fit RESULT a user hands back is a
    // decorated structural artifact — consumed fields run their ladders, decoration is preserved.
    open: true,
    exampleCall: HAR_RV_FORECAST_EXAMPLE,
  });
  requireArgumentArray(functionName, 'history', history);
  // Metadata honesty (2026-08-23, fourth review): `observationCount` is a data echo the forecast
  // never loops on, but a fit whose count is fractional or beyond 2^53 is not a fit this library
  // produced — teach, don't propagate.
  if (!Number.isSafeInteger(fit.observationCount) || fit.observationCount < 1) {
    throw new InputError(
      `${functionName}: fit.observationCount must be a safe integer ≥ 1 (the number of fitted observations echoed by fitHarRv). Received ${String(fit.observationCount)}.\n  e.g. ${HAR_RV_FORECAST_EXAMPLE}`,
      { code: ErrorCode.InputOutOfRange, context: { observationCount: fit.observationCount } },
    );
  }
  const { weekly, monthly } = fit.windows;
  // Safe integers (2026-08-23 review, P0): the windows drive the trailing-mean loops, but the
  // `history.length ≥ monthly` requirement below keeps both data-bounded — the safe gate keeps the
  // counts exact before that comparison runs.
  if (!Number.isSafeInteger(weekly) || weekly < 1) {
    throw new InputError(
      `${functionName}: fit.windows.weekly must be a positive integer, got ${weekly}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { weekly },
      },
    );
  }
  if (!Number.isSafeInteger(monthly) || monthly < weekly) {
    throw new InputError(
      `${functionName}: fit.windows.monthly must be an integer ≥ weekly (${weekly}), got ${monthly}.`,
      { code: ErrorCode.InputOutOfRange, context: { weekly, monthly } },
    );
  }
  if (history.length < monthly) {
    throw new InputError(
      `${functionName}: history must have at least ${monthly} observations (monthly window), got ${history.length}.`,
      { code: ErrorCode.InputOutOfRange, context: { length: history.length, monthly } },
    );
  }
  for (let i = 0; i < history.length; i++) {
    ensureNonNegative(history[i]!, `history[${i}]`, functionName);
  }

  const last = history.length - 1;
  const daily = history[last]!;
  const w = trailingMean(history, last, weekly);
  const m = trailingMean(history, last, monthly);
  const c = fit.coefficients;
  const forecast = c.const + c.daily * daily + c.weekly * w + c.monthly * m;
  ensureFinite(forecast, 'forecast', functionName);
  if (forecast < 0) {
    // HAR-RV is a linear model, so a mean-reverting fit extrapolates straight through zero on a
    // quiet history. A negative VARIANCE cannot be consumed: √it is NaN, it annualizes to NaN, and
    // returned as a plain number it looked exactly like a valid forecast (ledger H24 — a negative
    // variance forecast throws a typed model-output error; it is never clamped or returned).
    throw new UnsupportedError(
      `${functionName}: the fitted HAR-RV model forecasts a NEGATIVE variance (${forecast}) from this history — a linear model extrapolated below zero, not a usable variance. The model output cannot be consumed as a variance: refit on a longer/richer history, or floor it yourself with an explicit, disclosed policy.`,
      {
        code: ErrorCode.VolatilityNegativeVarianceForecast,
        context: {
          forecast,
          daily,
          weekly: w,
          monthly: m,
          coefficients: { const: c.const, daily: c.daily, weekly: c.weekly, monthly: c.monthly },
        },
      },
    );
  }
  return {
    windows: { weekly, monthly },
    predictors: { daily, weekly: w, monthly: m },
    contributions: {
      intercept: c.const,
      daily: c.daily * daily,
      weekly: c.weekly * w,
      monthly: c.monthly * m,
    },
    value: forecast,
  };
}

/** The conventions `harRvForecast.explain` echoes: the fitted windows and the forecast horizon. */
export interface HarRvForecastAssumptions {
  conventionsVersion: string;
  /** Weekly averaging window in observations (from the fit). */
  weekly: number;
  /** Monthly averaging window in observations (from the fit). */
  monthly: number;
  /** The model forecasts exactly one step ahead. */
  horizonKind: 'one-step-ahead';
}

export type HarRvForecastFacade = ((fit: HarRvFit, history: number[]) => number) & {
  explain: (
    fit: HarRvFit,
    history: number[],
  ) => Omit<Computed<number>, 'assumptions'> & { assumptions: HarRvForecastAssumptions };
};

/**
 * One-step-ahead HAR-RV forecast from the latest daily/weekly/monthly aggregates of `history`,
 * using the same windows the model was fit with. Requires at least `monthly` observations.
 *
 * A NEGATIVE forecast throws (`volatility.negative_variance_forecast`): the linear model can
 * extrapolate below zero, and a negative variance is not a variance — it is never clamped, and never
 * returned as if it were a successful forecast. `.explain()` throws the same typed error — a failed
 * model output is never softened into an envelope.
 *
 * Facade (H24): the plain call returns the scalar; `.explain()` discloses the fitted windows in
 * `assumptions`, and the three predictors plus the per-term regression contributions (which sum to
 * the raw model output, i.e. the value) in `diagnostics.decomposition`. Hand-attached (not
 * `seriesFacade`) so the closed-request teaching error for a hand-rolled `fit` stays byte-identical.
 */
export const harRvForecast: HarRvForecastFacade = Object.assign(
  (fit: HarRvFit, history: number[]): number =>
    harRvForecastComputation('harRvForecast', fit, history).value,
  {
    explain: (
      fit: HarRvFit,
      history: number[],
    ): Omit<Computed<number>, 'assumptions'> & { assumptions: HarRvForecastAssumptions } => {
      const c = harRvForecastComputation('harRvForecast.explain', fit, history);
      return finalizeResult('harRvForecast', {
        value: c.value,
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          weekly: c.windows.weekly,
          monthly: c.windows.monthly,
          horizonKind: 'one-step-ahead',
        },
        diagnostics: {
          method: 'har-rv-linear',
          // The arithmetic the forecast came from: value = interceptContribution +
          // dailyContribution + weeklyContribution + monthlyContribution, where each contribution is
          // the fitted coefficient times its disclosed predictor.
          decomposition: {
            dailyPredictor: c.predictors.daily,
            weeklyPredictor: c.predictors.weekly,
            monthlyPredictor: c.predictors.monthly,
            interceptContribution: c.contributions.intercept,
            dailyContribution: c.contributions.daily,
            weeklyContribution: c.contributions.weekly,
            monthlyContribution: c.contributions.monthly,
          },
          warnings: [],
        },
      });
    },
  },
);
