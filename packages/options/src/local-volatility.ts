/**
 * Dupire local volatility (spec §9.3, §10.1).
 *
 * Dupire's theorem: for any arbitrage-free implied-vol surface there is a unique *local* volatility
 * function σ_loc(S, t) under which the one-factor diffusion dS = (r−q)·S·dt + σ_loc(S,t)·S·dW
 * reprices that whole surface. We extract σ_loc from a caller-supplied implied-vol function using the
 * Gatheral total-variance form (numerically far steadier than the raw price-second-derivative
 * Dupire formula):
 *
 *   σ_loc² = ∂_T w / [ 1 − (k/w)·∂_k w + ¼·(−¼ − 1/w + k²/w²)·(∂_k w)² + ½·∂²_k w ]
 *
 * with total variance w(k, T) = σ_imp(K, T)²·T and log-moneyness k = ln(K / F_T), F_T = S₀·e^{(r−q)T}.
 *
 * `@insiderfinance/totalfinance/options` never depends on `@insiderfinance/totalfinance/volatility`, so the surface enters as a plain function
 * `(strike, t) ⇒ impliedVolatility` — pass a parametric fit, an interpolated grid, or a closed-form smile.
 *
 * A *flat* implied surface yields σ_loc ≡ σ, so local-volatility MC collapses to Black–Scholes — the anchor.
 */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  DEFAULT_GREEK_UNITS,
  type Diagnostics,
  ErrorCode,
  InputError,
  type OptionType,
  ensureFinite,
  ensurePositive,
  type ClosedRequestSpecification,
  validateClosedRequest,
  WarningCode,
} from '@totalfinance/core';
import { VALIDATION_SPECS } from './generated/validation-specs.js';
import { assertNoArbitrageBounds } from './engines/bounds.js';
import {
  type MonteCarloEstimate,
  type MonteCarloStatistics,
  type MonteCarloSamplingOptions,
  monteCarloEstimate,
} from './mc/core.js';
import { DEFAULT_LOCAL_VOLATILITY_STEPS } from './resource-validation-internal.js';
import type { PriceResult } from './types.js';

/** A market implied-volatility surface as a function of strike and time-to-expiry (years). */
export type ImpliedVolatilityFunction = (strike: number, timeToExpiryYears: number) => number;

/** Local volatility as a function of underlying level and time (years). */
export type LocalVolatilityFunction = (level: number, timeToExpiryYears: number) => number;

/** Market context the Dupire transform needs to convert strikes to moneyness. */
export interface LocalVolatilityMarket {
  spot: number;
  riskFreeRate: number;
  dividendYield?: number;
}

export interface DupireOptions {
  /** Log-moneyness finite-difference step (default 0.01). */
  logMoneynessStep?: number;
  /** Time finite-difference step in years (default 1/365). */
  timeStepYears?: number;
  /** Floor for local vol (default 1e-3) — also the clamp when a local arbitrage drives σ_loc² ≤ 0. */
  floorVolatility?: number;
}

/** Market inputs for a local-volatility MC price. */
export interface LocalVolatilityInput {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield?: number;
}

export interface LocalVolatilityMonteCarloOptions extends MonteCarloSamplingOptions {
  /** Time steps per path (default 100). */
  steps?: number;
}

/** A local-volatility MC result enriched with the Monte-Carlo error statistics. */
export interface LocalVolatilityMonteCarloResult extends PriceResult {
  monteCarlo: MonteCarloStatistics;
}

/** One cohesive request for construction of a Dupire local-volatility function. */
export interface DupireLocalVolatilityInput {
  impliedVolatility: ImpliedVolatilityFunction;
  market: LocalVolatilityMarket;
  options?: DupireOptions;
}

/** Complete, assumption-light inputs for one raw local-volatility Monte-Carlo estimate. */
export interface LocalVolatilityMonteCarloEstimateInput {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  localVolatility: LocalVolatilityFunction;
  options: LocalVolatilityMonteCarloOptions;
}

/** One cohesive request for the validated local-volatility Monte-Carlo pricer. */
export interface LocalVolatilityPriceMonteCarloRequest {
  type: OptionType;
  input: LocalVolatilityInput;
  localVolatility: LocalVolatilityFunction;
  options: LocalVolatilityMonteCarloOptions;
}

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations — the
 * surface/`localVolatility` callback slots validate as functions from the same projection. Resolved
 * at module load so a stale key fails at import. The `localVolatility.*` namespace aliases the same
 * implementations, so one validation head serves both spellings.
 */
function localVolatilitySpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `local-volatility: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const DUPIRE_SPEC = localVolatilitySpecOf('dupireLocalVolatility#0');
const LOCAL_VOL_GRID_SPEC = localVolatilitySpecOf('localVolatilityGrid#1');
const LOCAL_VOL_MC_ESTIMATE_SPEC = localVolatilitySpecOf('localVolatilityMonteCarloEstimate#0');
const LOCAL_VOL_MC_PRICE_SPEC = localVolatilitySpecOf('localVolatilityMonteCarloPrice#0');

const DUPIRE_EXAMPLE = (): string =>
  'localVolatility.fromImplied({ impliedVolatility: (strike, t) => 0.2, market: { spot: 100, riskFreeRate: 0.04 } })';

const LOCAL_VOL_GRID_EXAMPLE = (): string =>
  'localVolatility.grid(localVolatilityFunction, { levels: [50, 100, 150], times: [0.1, 0.5, 1] })';

const LOCAL_VOL_MC_EXAMPLE = (): string =>
  "localVolatility.monteCarloPrice({ type: 'call', input: { spot: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04 }, localVolatility: (level, t) => 0.2, options: { seed: 42, paths: 20000 } })";

/**
 * Build the Dupire local-volatility function σ_loc(level, t) from an implied-vol surface. The returned
 * function is pure and can be evaluated anywhere on the (level, t) plane; out-of-range or locally
 * arbitrageable points are floored at `floorVolatility` rather than returning NaN.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link localVolatility.fromImplied}.
 */
export function dupireLocalVolatility(input: DupireLocalVolatilityInput): LocalVolatilityFunction {
  validateClosedRequest('dupireLocalVolatility', input, DUPIRE_SPEC, {
    exampleCall: DUPIRE_EXAMPLE,
  });
  const { impliedVolatility, market, options: options = {} } = input;
  const functionName = 'dupireLocalVolatility';
  ensurePositive(market.spot, 'spot', functionName);
  ensureFinite(market.riskFreeRate, 'riskFreeRate', functionName);
  const q = market.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const S0 = market.spot;
  const r = market.riskFreeRate;
  const hk = options.logMoneynessStep ?? 0.01;
  const ht = options.timeStepYears ?? 1 / 365;
  const floor = options.floorVolatility ?? 1e-3;
  // The finite-difference steps divide the derivative denominators, so a zero/negative `logMoneynessStep`/`dt`
  // silently collapses every point to the floor (a flat 20% surface would read as 0.1%). Reject them.
  ensurePositive(hk, 'logMoneynessStep', functionName);
  ensurePositive(ht, 'timeStepYears', functionName);
  ensureFinite(floor, 'floorVolatility', functionName);
  if (floor < 0) {
    throw new InputError(`${functionName}: floorVolatility must be ≥ 0, got ${floor}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { floorVolatility: floor },
    });
  }

  // forward to time t and total variance w(k, t) = σ_imp(K, t)²·t with K = F_t·e^k
  const forward = (t: number): number => S0 * Math.exp((r - q) * t);
  const wOf = (k: number, t: number): number => {
    const K = forward(t) * Math.exp(k);
    const volatility = impliedVolatility(K, t);
    return volatility * volatility * t;
  };

  return (level: number, t: number): number => {
    if (!(level > 0) || !(t > 0)) return floor;
    const k0 = Math.log(level / forward(t));
    const w = wOf(k0, t);
    if (!(w > 0)) return impliedVolatility(level, t) > 0 ? impliedVolatility(level, t) : floor;

    const wkUp = wOf(k0 + hk, t);
    const wkDn = wOf(k0 - hk, t);
    const wk = (wkUp - wkDn) / (2 * hk);
    const wkk = (wkUp - 2 * w + wkDn) / (hk * hk);

    // ∂_T w at fixed k — forward difference near t = 0 so we never sample t ≤ 0.
    const tDn = t - ht;
    const wt = tDn > 0 ? (wOf(k0, t + ht) - wOf(k0, tDn)) / (2 * ht) : (wOf(k0, t + ht) - w) / ht;

    const denom =
      1 - (k0 / w) * wk + 0.25 * (-0.25 - 1 / w + (k0 * k0) / (w * w)) * wk * wk + 0.5 * wkk;
    const localVar = wt / denom;
    if (!(localVar > 0)) return floor;
    return Math.max(floor, Math.sqrt(localVar));
  };
}

/** Grid specification for {@link localVolatilityGrid}: strictly-ascending level and time knots. */
export interface LocalVolatilityGridSpecification {
  /** Underlying levels, ascending (e.g. 0.4·S₀ … 2.5·S₀). */
  levels: number[];
  /** Times in years, ascending (e.g. up to the longest expiry priced). */
  times: number[];
}

/**
 * Precompute a local-volatility function onto a (level × time) grid and return a fast bilinear-interpolating
 * `LocalVolatilityFunction`. The exact `dupireLocalVolatility` does ~4 surface evaluations per call — far too slow to run
 * inside a Monte-Carlo step loop — so cache it once on a grid and interpolate. Off-grid queries clamp
 * to the nearest edge (a documented, no-NaN extrapolation).
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link localVolatility.grid}.
 */
export function localVolatilityGrid(
  localVolatility: LocalVolatilityFunction,
  specification: LocalVolatilityGridSpecification,
): LocalVolatilityFunction {
  if (typeof localVolatility !== 'function') {
    throw new InputError(
      `localVolatilityGrid: localVolatility must be a local-volatility function (level, t) => sigma, got ${
        localVolatility === null ? 'null' : typeof localVolatility
      }.`,
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  // A specification missing (or mistyping) an axis must teach the two slot names, not crash on
  // `.length` — the generated spec owns the container shape (arg #1; arg #0 is the callback above).
  validateClosedRequest('localVolatilityGrid', specification, LOCAL_VOL_GRID_SPEC, {
    argumentName: 'specification',
    exampleCall: LOCAL_VOL_GRID_EXAMPLE,
  });
  const functionName = 'localVolatilityGrid';
  const { levels, times } = specification;
  if (levels.length < 2 || times.length < 2) {
    throw new InputError(`${functionName}: levels and times each need at least 2 knots.`, {
      code: ErrorCode.InputOutOfRange,
      context: { levels: levels.length, times: times.length },
    });
  }
  // The bilinear locate() assumes finite, strictly-ascending axes; unsorted or NaN knots would produce
  // silently wrong interpolation weights. Enforce the documented contract.
  const ensureAscending = (arr: number[], name: string): void => {
    for (let i = 0; i < arr.length; i++) {
      if (!Number.isFinite(arr[i]!)) {
        throw new InputError(`${functionName}: ${name}[${i}] must be finite, got ${arr[i]}.`, {
          code: ErrorCode.InputNotFinite,
          context: { [name]: arr[i], index: i },
        });
      }
      if (i > 0 && !(arr[i]! > arr[i - 1]!)) {
        throw new InputError(
          `${functionName}: ${name} must be strictly ascending; ${name}[${i}]=${arr[i]} ≤ ${name}[${i - 1}]=${
            arr[i - 1]
          }.`,
          { code: ErrorCode.InputOutOfRange, context: { name, index: i } },
        );
      }
    }
  };
  ensureAscending(levels, 'levels');
  ensureAscending(times, 'times');
  const grid: number[][] = levels.map((L) => times.map((t) => localVolatility(L, t)));

  const locate = (arr: number[], x: number): { i: number; w: number } => {
    if (x <= arr[0]!) return { i: 0, w: 0 };
    const last = arr.length - 1;
    if (x >= arr[last]!) return { i: last - 1, w: 1 };
    let i = 0;
    while (i < last && arr[i + 1]! < x) i++;
    const w = (x - arr[i]!) / (arr[i + 1]! - arr[i]!);
    return { i, w };
  };

  return (level: number, t: number): number => {
    const { i, w: wl } = locate(levels, level);
    const { i: j, w: wt } = locate(times, t);
    const v00 = grid[i]![j]!;
    const v01 = grid[i]![j + 1]!;
    const v10 = grid[i + 1]![j]!;
    const v11 = grid[i + 1]![j + 1]!;
    const a = v00 + (v01 - v00) * wt;
    const b = v10 + (v11 - v10) * wt;
    return a + (b - a) * wl;
  };
}

/** One local-volatility Euler terminal price from `steps` standard normals (log-Euler, vol at the step midpoint). */
function lvTerminal(input: {
  shocks: number[];
  spot: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  localVolatility: LocalVolatilityFunction;
  steps: number;
}): number {
  const {
    shocks: z,
    spot: S0,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    localVolatility,
    steps,
  } = input;
  const timeStepYears = T / steps;
  const sqdt = Math.sqrt(timeStepYears);
  let logS = Math.log(S0);
  for (let k = 0; k < steps; k++) {
    const S = Math.exp(logS);
    const tMid = (k + 0.5) * timeStepYears;
    const sig = localVolatility(S, tMid);
    logS += (r - q - 0.5 * sig * sig) * timeStepYears + sig * sqdt * z[k]!;
  }
  return Math.exp(logS);
}

/**
 * Low-level kernel: local-volatility Monte-Carlo estimate of the discounted European payoff.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link localVolatility.monteCarloEstimate}.
 */
export function localVolatilityMonteCarloEstimate(
  input: LocalVolatilityMonteCarloEstimateInput,
): MonteCarloEstimate {
  // `type` is a meaning-changing string: the generated spec's literal domain rejects garbage that
  // would silently price the other leg.
  validateClosedRequest('localVolatilityMonteCarloEstimate', input, LOCAL_VOL_MC_ESTIMATE_SPEC, {
    exampleCall: LOCAL_VOL_MC_EXAMPLE,
  });
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    localVolatility,
    options,
  } = input;
  const steps = options.steps ?? DEFAULT_LOCAL_VOLATILITY_STEPS;
  const df = Math.exp(-r * T);
  const payoff = (z: number[]): number => {
    const ST = lvTerminal({
      shocks: z,
      spot: S,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      localVolatility,
      steps,
    });
    return df * (type === 'call' ? Math.max(ST - K, 0) : Math.max(K - ST, 0));
  };
  const control = {
    estimate: (z: number[]) =>
      df *
      lvTerminal({
        shocks: z,
        spot: S,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
        localVolatility,
        steps,
      }),
    mean: S * Math.exp(-q * T),
  };
  return monteCarloEstimate({
    dimensions: steps,
    payoff,
    options,
    controlVariate: control,
    label: 'localVolatilityMonteCarloPrice',
  });
}

function assumptions(t: number, q: number): Assumptions {
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    timeToExpiryYears: t,
    dividendModel: q === 0 ? 'none' : 'continuousYield',
    units: DEFAULT_GREEK_UNITS,
    model: 'local-volatility',
    engine: 'local-volatility-mc',
  };
}

/**
 * Price a European option under a local-volatility diffusion by Monte-Carlo. Pass a `LocalVolatilityFunction`
 * (typically from {@link dupireLocalVolatility}); the result carries MC error statistics on `result.mc`.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link localVolatility.monteCarloPrice}.
 */
export function localVolatilityMonteCarloPrice(
  request: LocalVolatilityPriceMonteCarloRequest,
): LocalVolatilityMonteCarloResult {
  // `type: 'Call'` must teach, not silently price the other leg (design law #4) — the generated
  // spec's literal domain and callback kind carry that guard now.
  validateClosedRequest('localVolatilityMonteCarloPrice', request, LOCAL_VOL_MC_PRICE_SPEC, {
    argumentName: 'request',
    subject: true,
    exampleCall: LOCAL_VOL_MC_EXAMPLE,
  });
  const { type, input, localVolatility, options } = request;
  const functionName = 'localVolatilityMonteCarloPrice';
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);

  const est = localVolatilityMonteCarloEstimate({
    type,
    spot: input.spot,
    strike: input.strike,
    timeToExpiryYears: input.timeToExpiryYears,
    riskFreeRate: input.riskFreeRate,
    dividendYield: q,
    localVolatility,
    options,
  });
  const diagnostics: Diagnostics = {
    engine: 'local-volatility',
    method:
      est.method === 'pseudo'
        ? 'local-volatility-monte-carlo'
        : `local-volatility-monte-carlo-${est.method}`,
    converged: est.converged,
    iterations: est.paths,
    warnings: [
      ...est.warnings,
      {
        code: WarningCode.GreeksNotComputed,
        message: 'The local-volatility Monte-Carlo engine does not compute Greeks.',
        severity: 'info' as const,
      },
    ],
  };
  // Structural postcondition (defect-fix wave, finding 5), with the estimator's own sampling error
  // as slack — a surface that pushes the simulated price past the no-arbitrage ceiling is a defect.
  assertNoArbitrageBounds({
    engine: 'local-volatility',
    type,
    style: 'european',
    value: est.value,
    underlyingPresentValue: input.spot * Math.exp(-q * input.timeToExpiryYears),
    strikePresentValue: input.strike * Math.exp(-input.riskFreeRate * input.timeToExpiryYears),
    spot: input.spot,
    strike: input.strike,
    tolerance:
      5 *
      (est.standardError !== null && Number.isFinite(est.standardError) ? est.standardError : 0),
  });
  return {
    value: est.value,
    assumptions: assumptions(input.timeToExpiryYears, q),
    diagnostics,
    monteCarlo: {
      standardError: est.standardError,
      confidenceInterval: est.confidenceInterval,
      paths: est.paths,
      seed: est.seed,
      method: est.method,
      varianceReduction: est.varianceReduction,
    },
  };
}

/**
 * The local-volatility namespace — the grouped, discoverable surface over the flat local-volatility functions.
 * `localVolatility.fromImplied` / `localVolatility.grid` / `localVolatility.monteCarloPrice` / `localVolatility.monteCarloEstimate` are the same
 * functions; prefer the namespace over the deprecated flat exports.
 */
export const localVolatility = {
  fromImplied: dupireLocalVolatility,
  grid: localVolatilityGrid,
  monteCarloPrice: localVolatilityMonteCarloPrice,
  monteCarloEstimate: localVolatilityMonteCarloEstimate,
} as const;
