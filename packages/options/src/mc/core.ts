/**
 * Shared Monte-Carlo machinery for the option path-pricers (spec §8.6, §9.3).
 *
 * This is the single estimator the European MC engine, the stochastic-vol models, and the exotic
 * engines all build on. It is model-agnostic: the caller supplies a `payoff(z)` over a vector of
 * `dimensions` standard normals and (optionally) a control variate with a known mean. The estimator owns
 * the sampling discipline:
 *
 *   • **pseudo** — a seeded PRNG (mulberry32 / xoshiro128**), optional antithetic variates;
 *   • **QMC** — Sobol / Halton low-discrepancy points mapped through the inverse normal CDF, with an
 *     optional Brownian-bridge re-ordering so the best-distributed dimensions carry the path's
 *     large-scale variance.
 *
 * Every estimate carries its standard error, confidence interval, path count, and the echoed seed —
 * Monte-Carlo uncertainty is reported, never hidden (design laws #4, and "all stochastic APIs accept
 * and echo seed").
 */

import {
  ErrorCode,
  InputError,
  type QuantWarning,
  warning,
  WarningCode,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import {
  type RandomNumberGenerator,
  SOBOL_MAX_DIMENSIONS,
  brownianBridge,
  haltonSequence,
  mulberry32,
  normalInverseCdf,
  normalSample,
  sobolSequence,
  xoshiro128ss,
} from '@totalfinance/math';

/** Sampling strategy for a Monte-Carlo estimate. */
export type MonteCarloMethod = 'pseudo' | 'sobol' | 'halton';

/** Pseudo-random generator choice for `method: 'pseudo'`. */
export type MonteCarloRandomNumberGenerator = 'mulberry32' | 'xoshiro128';

/** Halton supports the first 25 primes as bases. */
const HALTON_MAX_DIM = 25;
/** Keep mapped uniforms strictly inside (0, 1) so `normalInverseCdf` never returns ±∞ (Sobol emits exact 0). */
const U_EPS = 1e-12;

/**
 * The most paths one estimate will run (2026-08-23 review, P0 "unbounded work" — a reviewer-named
 * case): `Number.isInteger(1e308)` is `true`, so the old check admitted a path budget the loop could
 * never finish, and above 2^53 the loop counter stops advancing — a literal hang. Even at ONE
 * dimension a path costs a normal draw (~37 ns measured) plus the payoff, so 10^7 paths is already
 * ~0.5 s before any model work; standard error ∝ 1/√n gains only 3× per extra decade.
 */
const MAX_MC_PATHS = 10_000_000;

/**
 * The most path-dimensions (paths × dimensions normal draws) one estimate will run (2026-08-23
 * review, P0): the two factors multiply into the real workload — 10^7 paths of a 1,000-step path
 * simulation is 10^10 draws, hours — so each being under its own cap proves nothing. 5×10^7 draws is
 * ~2 s (measured ~37 ns/draw) before the payoff runs; the QMC methods also MATERIALIZE the whole
 * `(paths + 1) × dimensions` point matrix, which this cap keeps inside the low-discrepancy
 * generators' own 2^26-cell allocation bound.
 */
const MAX_MC_PATH_DIMENSIONS = 50_000_000;

/** Valid runtime enum values — unknown ones throw rather than silently defaulting. */
const MC_METHODS: readonly MonteCarloMethod[] = ['pseudo', 'sobol', 'halton'];
const MC_RNGS: readonly MonteCarloRandomNumberGenerator[] = ['mulberry32', 'xoshiro128'];

/** Variance-reduction techniques actually applied to an estimate (echoed for reproducibility). */
export interface VarianceReduction {
  antithetic: boolean;
  controlVariate: boolean;
  brownianBridge: boolean;
}

/** The diagnostics block shared by every Monte-Carlo result. */
export interface MonteCarloStatistics {
  /**
   * Standard error of the mean estimate — `null` for the QUASI-random methods (`sobol`, `halton`).
   *
   * The sample-variance formula `√(s²/n)` assumes independent draws. A low-discrepancy sequence is
   * deterministic and negatively correlated by construction, so that formula does not estimate its
   * error: at 16k Sobol points on a European call it overstated the true deviation by ~75×, and a
   * confidence interval built from it was neither a confidence nor an interval. QMC error is
   * estimated by RANDOMIZING the sequence (scrambling/shifting) and taking the variance ACROSS
   * independent randomizations — which this estimator does not do, so it reports `null` and says so.
   */
  standardError: number | null;
  /** Confidence interval at the requested level (default 95%); `null` whenever `standardError` is. */
  confidenceInterval: [number, number] | null;
  /** Number of paths actually evaluated (antithetic pairs count as one path). */
  paths: number;
  /** The seed, echoed for reproducibility. */
  seed: number;
  /** The sampling method actually used (may differ from the request if QMC fell back to pseudo). */
  method: MonteCarloMethod;
  /** Which variance-reduction techniques were applied. */
  varianceReduction: VarianceReduction;
}

/** Options shared by every Monte-Carlo pricer. */
export interface MonteCarloSamplingOptions {
  /** Number of paths (antithetic pairs when `antithetic`). Default 50_000. */
  paths?: number;
  /** Seed — required and echoed for reproducibility. */
  seed: number;
  /** Sampling method (default `'pseudo'`). */
  method?: MonteCarloMethod;
  /** Antithetic variates (pseudo only; ignored for QMC). Default `true`. */
  antithetic?: boolean;
  /** Brownian-bridge path ordering (QMC only; concentrates variance in the leading dimensions). */
  brownianBridge?: boolean;
  /** Confidence level for the interval (default 0.95). */
  confidence?: number;
  /** PRNG for `method: 'pseudo'` (default `'mulberry32'`). */
  randomNumberGenerator?: MonteCarloRandomNumberGenerator;
}

/** The raw estimate returned by {@link monteCarloEstimate}, before it is wrapped in a pricing envelope. */
export interface MonteCarloEstimate extends MonteCarloStatistics {
  value: number;
  /** Whether the estimate is trustworthy (finite value and standard error). */
  converged: boolean;
  /** Structured warnings (e.g. a QMC dimension fallback). */
  warnings: QuantWarning[];
}

/** A control variate: a per-path quantity `fn(z)` with a known expectation `mean`. */
export interface ControlVariate {
  estimate: (normalDraws: number[]) => number;
  mean: number;
}

/** One complete request to the model-agnostic Monte-Carlo estimator. */
export interface MonteCarloEstimateInput {
  dimensions: number;
  payoff: (normalDraws: number[]) => number;
  options: MonteCarloSamplingOptions;
  controlVariate?: ControlVariate | undefined;
  /** Diagnostic label used in validation errors. */
  label?: string | undefined;
}

function rngFactory(
  kind: MonteCarloRandomNumberGenerator | undefined,
): (seed: number) => RandomNumberGenerator {
  return kind === 'xoshiro128' ? xoshiro128ss : mulberry32;
}

/**
 * Validate a Monte-Carlo sampling budget before an engine or estimator captures it.
 *
 * Kept in the internal MC module so factory adapters and the estimator share one source of truth
 * for path, dimension, and product bounds without adding another public package export.
 */
export function validateMonteCarloSamplingOptions(
  dimensions: number,
  options: MonteCarloSamplingOptions,
  functionName: string,
): void {
  if (!Number.isFinite(options.seed)) {
    throw new InputError(`${functionName}: seed must be a finite number, got ${options.seed}.`, {
      code: ErrorCode.InputNotFinite,
      context: { seed: options.seed },
    });
  }
  // Safe integer (2026-08-23 review, P0): dimensions sizes the per-path draw arrays; its true scale
  // bound is the paths × dimensions product below.
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new InputError(
      `${functionName}: dimension must be a positive integer, got ${dimensions}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { dimensions },
      },
    );
  }
  const paths = options.paths ?? 50_000;
  // Safe integer AND a work cap (2026-08-23 review, P0, reviewer-named): see MAX_MC_PATHS.
  if (!Number.isSafeInteger(paths) || paths < 2 || paths > MAX_MC_PATHS) {
    throw new InputError(
      `${functionName}: paths must be an integer in [2, ${MAX_MC_PATHS.toLocaleString('en-US')}] — every path draws ${dimensions} normal(s) (~37 ns each) and evaluates the payoff, so the cap is already sub-second-to-seconds of synchronous work, and standard error ∝ 1/√n gains only 3× per extra decade. Received ${paths}.\n  e.g. { paths: 100_000, seed: 42 }`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { paths, max: MAX_MC_PATHS },
      },
    );
  }
  // The PRODUCT paths × dimensions is the number of normal draws — and, for the QMC methods, the
  // materialized point matrix — so bound it even when each factor alone is under its cap
  // (2026-08-23 review, P0: multiplying counts must be bounded together). See MAX_MC_PATH_DIMENSIONS.
  if (paths * dimensions > MAX_MC_PATH_DIMENSIONS) {
    throw new InputError(
      `${functionName}: paths × dimensions must not exceed ${MAX_MC_PATH_DIMENSIONS.toLocaleString('en-US')} — the product is the total normal-draw workload (~2 s at the cap, measured ~37 ns/draw) and, for QMC, the materialized point matrix. Received ${paths} × ${dimensions} = ${(paths * dimensions).toLocaleString('en-US')}; reduce paths or the path resolution (steps/averaging points) that sets dimensions.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { paths, dimensions, maxPathDimensions: MAX_MC_PATH_DIMENSIONS },
      },
    );
  }
  const confidence = options.confidence ?? 0.95;
  if (!(confidence > 0 && confidence < 1)) {
    throw new InputError(`${functionName}: confidence must be in (0, 1), got ${confidence}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { confidence },
    });
  }
  // Reject unknown enum values rather than silently treating them as Halton / mulberry32 — these
  // options often come from JSON/config, so a typo must fail loudly (design law #4).
  if (options.method !== undefined && !MC_METHODS.includes(options.method)) {
    throw new InputError(
      `${functionName}: method must be one of ${MC_METHODS.join(', ')}; got "${options.method}".`,
      { code: ErrorCode.InputInvalidEnum, context: { method: options.method } },
    );
  }
  if (
    options.randomNumberGenerator !== undefined &&
    !MC_RNGS.includes(options.randomNumberGenerator)
  ) {
    throw new InputError(
      `${functionName}: randomNumberGenerator must be one of ${MC_RNGS.join(', ')}; got "${options.randomNumberGenerator}".`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { randomNumberGenerator: options.randomNumberGenerator },
      },
    );
  }
  if (options.brownianBridge !== undefined && typeof options.brownianBridge !== 'boolean') {
    throw new InputError(
      `${functionName}: brownianBridge must be a boolean when provided. Received ${options.brownianBridge === null ? 'null' : typeof options.brownianBridge}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'brownianBridge' },
      },
    );
  }
  if (options.antithetic !== undefined && typeof options.antithetic !== 'boolean') {
    throw new InputError(
      `${functionName}: antithetic must be a boolean when provided. Received ${options.antithetic === null ? 'null' : typeof options.antithetic}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'antithetic' },
      },
    );
  }
}

/** Map a low-discrepancy point to standard normals, optionally Brownian-bridge re-ordered. */
function pointToNormals(point: number[], bridge: boolean): number[] {
  const z = new Array<number>(point.length);
  for (let i = 0; i < point.length; i++) {
    const u = Math.min(1 - U_EPS, Math.max(U_EPS, point[i]!));
    z[i] = normalInverseCdf(u);
  }
  if (!bridge || z.length === 1) return z;
  // Build a Brownian path on a unit grid from the (significance-ordered) normals, then return its
  // increments — these are the per-step N(0,1) draws in time order. The leading QMC dimensions now
  // control the path's coarse shape, which is where QMC's low discrepancy buys the most.
  const W = brownianBridge(z, 1);
  const inc = new Array<number>(z.length);
  for (let k = 0; k < z.length; k++) inc[k] = W[k + 1]! - W[k]!;
  return inc;
}

/**
 * Estimate `E[payoff(Z)]` where `Z` is a vector of `dimensions` standard normals, with online mean/variance,
 * optional antithetic sampling, an optional control variate, and pseudo or quasi-random sampling.
 */
export function monteCarloEstimate(input: MonteCarloEstimateInput): MonteCarloEstimate {
  const { dimensions, payoff, options, controlVariate: control, label: fn = 'monteCarlo' } = input;
  requireArgumentObject(fn, 'options', options);
  validateMonteCarloSamplingOptions(dimensions, options, fn);
  const paths = options.paths ?? 50_000;
  const confidence = options.confidence ?? 0.95;
  const z = normalInverseCdf(0.5 + confidence / 2);
  const warnings: QuantWarning[] = [];

  let method: MonteCarloMethod = options.method ?? 'pseudo';

  // QMC dimension limits: fall back to pseudo with a reported warning rather than silently degrade.
  if (method === 'sobol' && dimensions > SOBOL_MAX_DIMENSIONS) {
    warnings.push(
      warning(
        WarningCode.MonteCarloQuasiMonteCarloDimensionFallback,
        `Sobol supports at most ${SOBOL_MAX_DIMENSIONS} dimensions; ${dimensions} requested — falling back to pseudo-random sampling.`,
        'warn',
        { requested: 'sobol', dimensions, max: SOBOL_MAX_DIMENSIONS },
      ),
    );
    method = 'pseudo';
  } else if (method === 'halton' && dimensions > HALTON_MAX_DIM) {
    warnings.push(
      warning(
        WarningCode.MonteCarloQuasiMonteCarloDimensionFallback,
        `Halton supports at most ${HALTON_MAX_DIM} dimensions; ${dimensions} requested — falling back to pseudo-random sampling.`,
        'warn',
        { requested: 'halton', dimensions, max: HALTON_MAX_DIM },
      ),
    );
    method = 'pseudo';
  }

  // Resolve variance-reduction flags after any QMC fallback so diagnostics describe what actually ran.
  const bridge = method !== 'pseudo' && (options.brownianBridge ?? false);
  const antithetic = method === 'pseudo' && (options.antithetic ?? true);
  const hasControl = control !== undefined;

  // Online sums for the mean, variance, and (with a control) the control's variance and covariance.
  let n = 0;
  let sY = 0;
  let sYY = 0;
  let sX = 0;
  let sXX = 0;
  let sXY = 0;

  const accumulate = (y: number, x: number): void => {
    if (!Number.isFinite(y) || (hasControl && !Number.isFinite(x))) {
      throw new InputError(
        `${fn}: payoff produced a non-finite sample (${y}); a NaN/∞ draw must not surface as a successful estimate.`,
        { code: ErrorCode.InputNotFinite, context: { value: y } },
      );
    }
    n++;
    sY += y;
    sYY += y * y;
    if (hasControl) {
      sX += x;
      sXX += x * x;
      sXY += x * y;
    }
  };

  if (method === 'pseudo') {
    const randomNumberGenerator = rngFactory(options.randomNumberGenerator)(options.seed);
    const zv = new Array<number>(dimensions);
    const zn = new Array<number>(dimensions);
    for (let i = 0; i < paths; i++) {
      for (let d = 0; d < dimensions; d++) {
        zv[d] = normalSample(randomNumberGenerator);
        zn[d] = -zv[d]!;
      }
      if (antithetic) {
        accumulate(
          0.5 * (payoff(zv) + payoff(zn)),
          hasControl ? 0.5 * (control.estimate(zv) + control.estimate(zn)) : 0,
        );
      } else {
        accumulate(payoff(zv), hasControl ? control.estimate(zv) : 0);
      }
    }
  } else {
    const points =
      method === 'sobol'
        ? sobolSequence(paths + 1, dimensions).slice(1)
        : haltonSequence(paths, dimensions, { start: 1 });
    for (let i = 0; i < points.length; i++) {
      const zd = pointToNormals(points[i]!, bridge);
      accumulate(payoff(zd), hasControl ? control.estimate(zd) : 0);
    }
  }

  const meanY = sY / n;
  const varY = n > 1 ? (sYY - n * meanY * meanY) / (n - 1) : NaN;

  let value = meanY;
  let resVar = varY;
  let usedControl = false;
  if (hasControl && n > 1) {
    const meanX = sX / n;
    const varX = (sXX - n * meanX * meanX) / (n - 1);
    if (varX > 0) {
      const covXY = (sXY - n * meanX * meanY) / (n - 1);
      const c = covXY / varX;
      value = meanY - c * (meanX - control.mean);
      resVar = Math.max(0, varY - 2 * c * covXY + c * c * varX);
      usedControl = true;
    }
  }

  // An iid standard error is meaningless for a deterministic low-discrepancy sequence (see
  // MonteCarloStatistics.standardError): report null with the reason, never a 75×-overstated number.
  const quasiRandom = method !== 'pseudo';
  const se = quasiRandom ? null : Math.sqrt(resVar / n);
  if (quasiRandom) {
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `quasi-random sampling (${method}): an iid standard error is not applicable to a deterministic ` +
          'low-discrepancy sequence, so standardError and confidenceInterval are null rather than an ' +
          'overstated sample-variance figure. For a QMC error estimate, average independent RANDOMIZED ' +
          '(scrambled/shifted) replications and take the variance across them; for a reported error bar ' +
          "from this estimator, use method: 'pseudo'.",
        'info',
        { method },
      ),
    );
  }
  const converged = Number.isFinite(value) && (se === null || Number.isFinite(se));
  return {
    value,
    standardError: se,
    confidenceInterval: se === null ? null : [value - z * se, value + z * se],
    paths: n,
    seed: options.seed >>> 0,
    method,
    varianceReduction: {
      antithetic,
      controlVariate: usedControl,
      brownianBridge: bridge,
    },
    converged,
    warnings,
  };
}

/**
 * A geometric-Brownian-motion path from `steps` standard normals: `S[0..steps]` with
 * `S[k+1] = S[k]·exp((r − q − ½σ²)·dt + σ·√dt·z[k])`, `dt = T/steps`. Exact (no Euler discretisation
 * error) — GBM has lognormal increments at any step size.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link gbm.path}.
 */
export interface GbmPathInput {
  spot: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  timeToExpiryYears: number;
  shocks: number[];
}

const GBM_PATH_FIELDS = [
  'spot',
  'riskFreeRate',
  'dividendYield',
  'volatility',
  'timeToExpiryYears',
] as const;

/** The raw path math with NO ladder — see {@link gbmTerminalUnchecked} for why it exists. */
export function gbmPathUnchecked(input: GbmPathInput): Float64Array {
  const {
    spot: s0,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    timeToExpiryYears: T,
    shocks,
  } = input;
  const steps = shocks.length;
  const timeStepYears = T / steps;
  const drift = (r - q - 0.5 * sigma * sigma) * timeStepYears;
  const vol = sigma * Math.sqrt(timeStepYears);
  const S = new Float64Array(steps + 1);
  S[0] = s0;
  let logS = Math.log(s0);
  for (let k = 0; k < steps; k++) {
    logS += drift + vol * shocks[k]!;
    S[k + 1] = Math.exp(logS);
  }
  return S;
}

export function gbmPath(input: GbmPathInput): Float64Array {
  requireArgumentObject('gbmPath', 'input', input);
  requireFiniteFields('gbmPath', input, GBM_PATH_FIELDS, {
    exampleCall:
      'gbmPath({ spot: 100, riskFreeRate: 0.04, dividendYield: 0, volatility: 0.2, timeToExpiryYears: 1, shocks: [0.3, -0.1] })',
  });
  requireArgumentArray('gbmPath', 'shocks', input.shocks);
  return gbmPathUnchecked(input);
}

/**
 * The terminal GBM price from a single standard normal — `gbmPath` specialised to one step.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link gbm.terminal}.
 */
export interface GbmTerminalInput {
  spot: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  timeToExpiryYears: number;
  shock: number;
}

const GBM_TERMINAL_FIELDS = [
  'spot',
  'riskFreeRate',
  'dividendYield',
  'volatility',
  'timeToExpiryYears',
  'shock',
] as const;

/**
 * The raw GBM math with NO ladder — for callers that validated once at their own boundary and then
 * sample in a loop (`monteCarloEuropean`, the exotics path engines). Deliberately NOT re-exported
 * from any public entrypoint: per-sample validation in a Monte-Carlo loop is the exact cost spec
 * 3B.1b forbids, and an unchecked kernel on the public surface would be an API.
 */
export function gbmTerminalUnchecked(input: GbmTerminalInput): number {
  const { spot, riskFreeRate, dividendYield, volatility, timeToExpiryYears, shock } = input;
  return (
    spot *
    Math.exp(
      (riskFreeRate - dividendYield - 0.5 * volatility * volatility) * timeToExpiryYears +
        volatility * Math.sqrt(timeToExpiryYears) * shock,
    )
  );
}

export function gbmTerminal(input: GbmTerminalInput): number {
  requireArgumentObject('gbmTerminal', 'input', input);
  // Every leg runs the ladder: a null dividendYield used to coerce to 0 inside the drift and
  // return a price as if it had succeeded (first-touch law).
  requireFiniteFields('gbmTerminal', input, GBM_TERMINAL_FIELDS, {
    exampleCall:
      'gbmTerminal({ spot: 100, riskFreeRate: 0.04, dividendYield: 0, volatility: 0.2, timeToExpiryYears: 1, shock: 0.31 })',
  });
  return gbmTerminalUnchecked(input);
}

/**
 * The geometric-Brownian-motion namespace — the grouped surface over the flat `gbm*` kernels.
 * `gbm.path` / `gbm.terminal` are the same functions; prefer the namespace over the deprecated flats.
 */
export const gbm = {
  path: gbmPath,
  terminal: gbmTerminal,
} as const;
