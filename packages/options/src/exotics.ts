/**
 * Exotic option engines (spec §9.3): barrier, Asian, and lookback options.
 *
 * Each family pairs a closed-form analytic price with a Monte-Carlo engine that converges to it, so
 * the analytic value and the simulation independently corroborate one another:
 *
 *   • **barrier** — Reiner–Rubinstein / Haug single-barrier formulas (continuous monitoring), and a
 *     Monte-Carlo engine with the **Brownian-bridge** crossing correction so discrete monitoring
 *     converges to the continuous price;
 *   • **asian** — the exact discrete *geometric*-average price, used both as a result and as the
 *     control variate for the *arithmetic*-average Monte-Carlo (correlation ≈ 0.99 ⇒ huge variance
 *     reduction);
 *   • **lookback** — Conze–Viswanathan / Goldman–Sosin–Gatto floating- and fixed-strike formulas,
 *     and a Monte-Carlo engine with the **Broadie–Glasserman–Kou** discrete-monitoring correction.
 *
 * Exotic results are value envelopes (`Computed<number>`); the Monte-Carlo variants add `result.mc`.
 */

import {
  type Assumptions,
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Computed,
  DEFAULT_GREEK_UNITS,
  type Diagnostics,
  ErrorCode,
  InputError,
  type OptionType,
  type QuantWarning,
  UnsupportedError,
  ensureEnum,
  ensureFinite,
  ensurePositive,
  validateClosedRequest,
  warning,
  requireArgumentArray,
  requireArgumentObject,
  wrongShapeError,
  finiteOrNull,
  WarningCode,
} from '@totalfinance/core';
import { VALIDATION_SPECS } from './generated/validation-specs.js';
import { cholesky, normalCdf, normalPdf } from '@totalfinance/math';
import { blackScholesGreeks, blackScholesPrice } from './bsm.js';
import { finiteDifferenceExtendedGreeks } from './engines/fd-greeks.js';
import type { ExtendedGreeks, Greeks } from './types.js';
import {
  type MonteCarloEstimate,
  type MonteCarloStatistics,
  type MonteCarloSamplingOptions,
  gbmPathUnchecked,
  gbmTerminal,
  monteCarloEstimate,
} from './mc/core.js';

const N = normalCdf;
const npdf = normalPdf;
const DAYS_PER_YEAR = 365;

/**
 * Generated closed-request specs (spec 3B.1b): the runtime allowlists are PROJECTED from the
 * checker-derived inventory, never hand-written, so declaration and enforcement cannot drift.
 * Resolved at module load — a stale key fails at import, not on the call that trips over it.
 */
function specOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `exotics: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

/** A plain exotic-pricing result: value + assumptions + diagnostics. */
export type ExoticResult = Computed<number>;

/** A Monte-Carlo exotic result, enriched with the error statistics. */
export interface ExoticMonteCarloResult extends Computed<number> {
  monteCarlo: MonteCarloStatistics;
}

function assumptions(t: number, q: number, model: string, engine: string): Assumptions {
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    timeToExpiryYears: t,
    dividendModel: q === 0 ? 'none' : 'continuousYield',
    model,
    engine,
  };
}

function monteCarloStatistics(est: MonteCarloEstimate): MonteCarloStatistics {
  return {
    standardError: est.standardError,
    confidenceInterval: est.confidenceInterval,
    paths: est.paths,
    seed: est.seed,
    method: est.method,
    varianceReduction: est.varianceReduction,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Barrier options
// ────────────────────────────────────────────────────────────────────────────

export type BarrierType = 'down-in' | 'down-out' | 'up-in' | 'up-out';

// The enum runtime domains (BARRIER_TYPES, OPTION_TYPES, …) used to live here as hand consts for
// `ensureEnum`; they now travel inside the GENERATED validation specs, so the declaration is the
// single source and a hand copy cannot drift.

export interface BarrierInput {
  spot: number;
  strike: number;
  /** Barrier level H. */
  barrier: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
}

export interface BarrierMonteCarloOptions extends MonteCarloSamplingOptions {
  /** Monitoring steps per path (default 100). */
  steps?: number;
}

function validateBarrier(input: BarrierInput, functionName: string): number {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.barrier, 'barrier', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  return q;
}

/** Reiner–Rubinstein / Haug single-barrier price (continuous monitoring, zero rebate). */
function barrierAnalytic(input: {
  type: OptionType;
  barrierType: BarrierType;
  spot: number;
  strike: number;
  barrier: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}): number {
  const {
    type,
    barrierType,
    spot: S,
    strike: K,
    barrier: H,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  const isDown = barrierType === 'down-in' || barrierType === 'down-out';
  const isOut = barrierType === 'down-out' || barrierType === 'up-out';
  const knocked = isDown ? S <= H : S >= H;
  const vanilla = blackScholesPrice({
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  });
  if (knocked) return isOut ? 0 : vanilla;

  const b = r - q;
  const sqrtT = Math.sqrt(T);
  const phi = type === 'call' ? 1 : -1;
  const eta = isDown ? 1 : -1;
  const mu = (b - 0.5 * sigma * sigma) / (sigma * sigma);
  const vol = sigma * sqrtT;

  const x1 = Math.log(S / K) / vol + (1 + mu) * vol;
  const x2 = Math.log(S / H) / vol + (1 + mu) * vol;
  const y1 = Math.log((H * H) / (S * K)) / vol + (1 + mu) * vol;
  const y2 = Math.log(H / S) / vol + (1 + mu) * vol;
  const eqr = Math.exp((b - r) * T);
  const er = Math.exp(-r * T);
  const HS2mu1 = Math.pow(H / S, 2 * (mu + 1));
  const HS2mu = Math.pow(H / S, 2 * mu);

  const A = phi * S * eqr * N(phi * x1) - phi * K * er * N(phi * x1 - phi * vol);
  const B = phi * S * eqr * N(phi * x2) - phi * K * er * N(phi * x2 - phi * vol);
  const C = phi * S * eqr * HS2mu1 * N(eta * y1) - phi * K * er * HS2mu * N(eta * y1 - eta * vol);
  const D = phi * S * eqr * HS2mu1 * N(eta * y2) - phi * K * er * HS2mu * N(eta * y2 - eta * vol);

  const kGtH = K > H;
  let knockIn: number;
  if (type === 'call' && isDown) knockIn = kGtH ? C : A - B + D;
  else if (type === 'call' && !isDown) knockIn = kGtH ? A : B - C + D;
  else if (type === 'put' && isDown) knockIn = kGtH ? B - C + D : A;
  else knockIn = kGtH ? A - B + D : C; // put, up

  return isOut ? Math.max(0, vanilla - knockIn) : Math.max(0, knockIn);
}

/** Survival probability of a discrete path against a continuous barrier (Brownian-bridge corrected). */
function barrierSurvival(input: {
  path: Float64Array;
  barrier: number;
  isDown: boolean;
  volatility: number;
  timeStepYears: number;
}): number {
  const { path, barrier: H, isDown, volatility: sigma, timeStepYears } = input;
  let surv = 1;
  const v = sigma * sigma * timeStepYears;
  for (let k = 0; k < path.length - 1; k++) {
    const a = path[k]!;
    const c = path[k + 1]!;
    if (isDown) {
      if (a <= H || c <= H) return 0;
      surv *= 1 - Math.exp((-2 * Math.log(a / H) * Math.log(c / H)) / v);
    } else {
      if (a >= H || c >= H) return 0;
      surv *= 1 - Math.exp((-2 * Math.log(H / a) * Math.log(H / c)) / v);
    }
  }
  return surv;
}

const BARRIER_PRICE_SPEC = specOf('barrier.price#0');
const BARRIER_MC_INPUT_SPEC = specOf('barrier.monteCarloPrice#0');
const BARRIER_MC_OPTIONS_SPEC = specOf('barrier.monteCarloPrice#1');

const BARRIER_EXAMPLE = (): string =>
  "barrier.price({ type: 'call', barrierType: 'up-out', spot: 100, strike: 105, barrier: 120, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 })";

export const barrier = {
  /** Continuous-monitoring single-barrier price (Reiner–Rubinstein / Haug, zero rebate). */
  price(input: BarrierInput & { type: OptionType; barrierType: BarrierType }): ExoticResult {
    const functionName = 'barrier.price';
    validateClosedRequest(functionName, input, BARRIER_PRICE_SPEC, {
      exampleCall: BARRIER_EXAMPLE,
    });
    const { type, barrierType } = input;
    const q = validateBarrier(input, functionName);
    const value = barrierAnalytic({
      type,
      barrierType,
      spot: input.spot,
      strike: input.strike,
      barrier: input.barrier,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      dividendYield: q,
      volatility: input.volatility,
    });
    const diagnostics: Diagnostics = {
      engine: `barrier-${barrierType}`,
      method: 'reiner-rubinstein',
      converged: Number.isFinite(value),
      warnings: [],
    };
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'barrier', `barrier-${barrierType}`),
      diagnostics,
    };
  },

  /** Brownian-bridge-corrected Monte-Carlo barrier price (converges to the continuous analytic). */
  monteCarloPrice(
    input: BarrierInput & { type: OptionType; barrierType: BarrierType },
    options: BarrierMonteCarloOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'barrier.monteCarloPrice';
    validateClosedRequest(functionName, input, BARRIER_MC_INPUT_SPEC, {
      exampleCall: BARRIER_EXAMPLE,
    });
    validateClosedRequest(functionName, options, BARRIER_MC_OPTIONS_SPEC, {
      exampleCall: BARRIER_EXAMPLE,
      argumentName: 'options',
    });
    const { type, barrierType } = input;
    const q = validateBarrier(input, functionName);
    const {
      spot: S,
      strike: K,
      barrier: H,
      timeToExpiryYears: T,
      riskFreeRate: r,
      volatility: sigma,
    } = input;
    const steps = options.steps ?? 100;
    const timeStepYears = T / steps;
    const df = Math.exp(-r * T);
    const isDown = barrierType === 'down-in' || barrierType === 'down-out';
    const isOut = barrierType === 'down-out' || barrierType === 'up-out';

    const payoff = (z: number[]): number => {
      const path = gbmPathUnchecked({
        spot: S,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        timeToExpiryYears: T,
        shocks: z,
      });
      const ST = path[steps]!;
      const intrinsic = type === 'call' ? Math.max(ST - K, 0) : Math.max(K - ST, 0);
      const surv = barrierSurvival({
        path,
        barrier: H,
        isDown,
        volatility: sigma,
        timeStepYears,
      });
      return df * intrinsic * (isOut ? surv : 1 - surv);
    };
    const est = monteCarloEstimate({
      dimensions: steps,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    const diagnostics: Diagnostics = {
      engine: `barrier-${barrierType}`,
      method:
        est.method === 'pseudo'
          ? 'monte-carlo-brownian-bridge'
          : `monte-carlo-${est.method}-brownian-bridge`,
      converged: est.converged,
      iterations: est.paths,
      warnings: est.warnings,
    };
    return {
      value: est.value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'barrier', `barrier-${barrierType}-mc`),
      diagnostics,
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Asian options (arithmetic via geometric control variate)
// ────────────────────────────────────────────────────────────────────────────

/** Market and contract inputs shared by arithmetic Asian Monte-Carlo pricing. */
export interface AsianMonteCarloInput {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
}

/** Inputs for the exact discrete geometric-average Asian price. */
export interface AsianInput extends AsianMonteCarloInput {
  /** Number of equally-spaced averaging dates t_i = i·T/m, i = 1..m (default 50). */
  averagingPoints?: number;
}

export interface AsianMonteCarloOptions extends MonteCarloSamplingOptions {
  /** Number of equally-spaced averaging dates t_i = i·T/m, i = 1..m (default 50). */
  averagingPoints?: number;
}

function validateAsian(input: AsianInput, functionName: string): number {
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  return q;
}

/** Exact discrete geometric-average Asian price (the average's geometric mean is lognormal). */
function geometricAsian(input: {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  averagingPoints: number;
}): number {
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    averagingPoints: m,
  } = input;
  const timeStepYears = T / m;
  // t_i = i·dt, i=1..m → t̄ = dt·(m+1)/2 ;  Σ_{i,j} min(t_i,t_j) = dt·m(m+1)(2m+1)/6
  const tBar = timeStepYears * ((m + 1) / 2);
  const varSum = timeStepYears * ((m * (m + 1) * (2 * m + 1)) / 6);
  const muG = Math.log(S) + (r - q - 0.5 * sigma * sigma) * tBar;
  const varG = (sigma * sigma * varSum) / (m * m);
  const sigG = Math.sqrt(varG);
  const d1 = (muG - Math.log(K) + varG) / sigG;
  const d2 = d1 - sigG;
  const eG = Math.exp(muG + 0.5 * varG);
  const er = Math.exp(-r * T);
  return type === 'call' ? er * (eG * N(d1) - K * N(d2)) : er * (K * N(-d2) - eG * N(-d1));
}

const ASIAN_GEOMETRIC_SPEC = specOf('asian.geometricPrice#0');
const ASIAN_MC_INPUT_SPEC = specOf('asian.monteCarloPrice#0');
const ASIAN_MC_OPTIONS_SPEC = specOf('asian.monteCarloPrice#1');

const ASIAN_EXAMPLE = (): string =>
  "asian.geometricPrice({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 })";

export const asian = {
  /** Exact discrete geometric-average Asian price. */
  geometricPrice(input: AsianInput & { type: OptionType }): ExoticResult {
    const functionName = 'asian.geometricPrice';
    validateClosedRequest(functionName, input, ASIAN_GEOMETRIC_SPEC, {
      exampleCall: ASIAN_EXAMPLE,
    });
    const { type } = input;
    const q = validateAsian(input, functionName);
    const sigma = requireSigma(input, functionName);
    const m = input.averagingPoints ?? 50;
    requirePoints(m, functionName);
    const value = geometricAsian({
      type,
      spot: input.spot,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      dividendYield: q,
      volatility: sigma,
      averagingPoints: m,
    });
    const diagnostics: Diagnostics = {
      engine: 'asian-geometric',
      method: 'closed-form',
      converged: Number.isFinite(value),
      warnings: [],
    };
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'asian-geometric', 'asian-geometric'),
      diagnostics,
    };
  },

  /** Arithmetic-average Asian price by Monte-Carlo, with the geometric Asian as control variate. */
  monteCarloPrice(
    input: AsianMonteCarloInput & { type: OptionType },
    options: AsianMonteCarloOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'asian.monteCarloPrice';
    validateClosedRequest(functionName, input, ASIAN_MC_INPUT_SPEC, {
      exampleCall: ASIAN_EXAMPLE,
    });
    validateClosedRequest(functionName, options, ASIAN_MC_OPTIONS_SPEC, {
      exampleCall: ASIAN_EXAMPLE,
      argumentName: 'options',
    });
    const { type } = input;
    const q = validateAsian(input, functionName);
    const sigma = requireSigma(input, functionName);
    const { spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r } = input;
    const m = options.averagingPoints ?? 50;
    requirePoints(m, functionName);
    const df = Math.exp(-r * T);
    const geoMean = geometricAsian({
      type,
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
      averagingPoints: m,
    });

    const averages = (z: number[]): { arith: number; geo: number } => {
      const path = gbmPathUnchecked({
        spot: S,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        timeToExpiryYears: T,
        shocks: z,
      });
      let sum = 0;
      let logSum = 0;
      for (let i = 1; i <= m; i++) {
        sum += path[i]!;
        logSum += Math.log(path[i]!);
      }
      return { arith: sum / m, geo: Math.exp(logSum / m) };
    };
    const payoff = (z: number[]): number => {
      const { arith } = averages(z);
      return df * (type === 'call' ? Math.max(arith - K, 0) : Math.max(K - arith, 0));
    };
    const control = {
      estimate: (z: number[]): number => {
        const { geo } = averages(z);
        return df * (type === 'call' ? Math.max(geo - K, 0) : Math.max(K - geo, 0));
      },
      mean: geoMean,
    };
    const est = monteCarloEstimate({
      dimensions: m,
      payoff,
      options,
      controlVariate: control,
      label: functionName,
    });
    const diagnostics: Diagnostics = {
      engine: 'asian-arithmetic',
      method:
        est.method === 'pseudo'
          ? 'monte-carlo-geometric-control'
          : `monte-carlo-${est.method}-geometric-control`,
      converged: est.converged,
      iterations: est.paths,
      warnings: est.warnings,
    };
    return {
      value: est.value,
      assumptions: assumptions(
        input.timeToExpiryYears,
        q,
        'asian-arithmetic',
        'asian-arithmetic-mc',
      ),
      diagnostics,
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Lookback options
// ────────────────────────────────────────────────────────────────────────────

export type LookbackStrike = 'floating' | 'fixed';

const LOOKBACK_STRIKES: readonly LookbackStrike[] = ['floating', 'fixed'];

export interface LookbackInput {
  spot: number;
  /** Strike (fixed-strike lookbacks only). */
  strike?: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** Running minimum observed so far (default = spot, a newly-issued option). */
  runningMin?: number;
  /** Running maximum observed so far (default = spot). */
  runningMax?: number;
}

export interface LookbackMonteCarloOptions extends MonteCarloSamplingOptions {
  /** Monitoring steps per path (default 150). */
  steps?: number;
}

/** Broadie–Glasserman–Kou discrete-monitoring shift constant β = ζ(1/2)/√(2π). */
const BGK_BETA = 0.5826;

function bSafe(r: number, q: number): number {
  // The lookback closed form has a 1/(r−q) factor; nudge the cost-of-carry off zero to avoid the
  // removable singularity (negligible price impact, flagged to the caller).
  const b = r - q;
  return Math.abs(b) < 1e-6 ? (b >= 0 ? 1e-6 : -1e-6) : b;
}

function floatingLookback(input: {
  type: OptionType;
  spot: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  runningMin: number;
  runningMax: number;
}): number {
  const {
    type,
    spot: S,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    runningMin: sMin,
    runningMax: sMax,
  } = input;
  const b = bSafe(r, q);
  const sqrtT = Math.sqrt(T);
  const vol = sigma * sqrtT;
  const eqr = Math.exp((b - r) * T);
  const er = Math.exp(-r * T);
  const twoB = (2 * b) / (sigma * sigma);
  if (type === 'call') {
    const m = sMin;
    const a1 = (Math.log(S / m) + (b + 0.5 * sigma * sigma) * T) / vol;
    const a2 = a1 - vol;
    return (
      S * eqr * N(a1) -
      m * er * N(a2) +
      S *
        er *
        ((sigma * sigma) / (2 * b)) *
        (Math.pow(S / m, -twoB) * N(-a1 + twoB * vol) - Math.exp(b * T) * N(-a1))
    );
  }
  const M = sMax;
  const b1 = (Math.log(S / M) + (b + 0.5 * sigma * sigma) * T) / vol;
  const b2 = b1 - vol;
  return (
    M * er * N(-b2) -
    S * eqr * N(-b1) +
    S *
      er *
      ((sigma * sigma) / (2 * b)) *
      (-Math.pow(S / M, -twoB) * N(b1 - twoB * vol) + Math.exp(b * T) * N(b1))
  );
}

function fixedLookback(input: {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  runningMin: number;
  runningMax: number;
}): number {
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    runningMin: sMin,
    runningMax: sMax,
  } = input;
  const b = bSafe(r, q);
  const sqrtT = Math.sqrt(T);
  const vol = sigma * sqrtT;
  const eqr = Math.exp((b - r) * T);
  const er = Math.exp(-r * T);
  const twoB = (2 * b) / (sigma * sigma);
  const carry = (S * er * sigma * sigma) / (2 * b);

  if (type === 'call') {
    if (K > sMax) {
      const d1 = (Math.log(S / K) + (b + 0.5 * sigma * sigma) * T) / vol;
      const d2 = d1 - vol;
      return (
        S * eqr * N(d1) -
        K * er * N(d2) +
        carry * (-Math.pow(S / K, -twoB) * N(d1 - twoB * vol) + Math.exp(b * T) * N(d1))
      );
    }
    const M = sMax;
    const e1 = (Math.log(S / M) + (b + 0.5 * sigma * sigma) * T) / vol;
    const e2 = e1 - vol;
    return (
      er * (M - K) +
      S * eqr * N(e1) -
      M * er * N(e2) +
      carry * (-Math.pow(S / M, -twoB) * N(e1 - twoB * vol) + Math.exp(b * T) * N(e1))
    );
  }
  // put
  if (K < sMin) {
    const f1 = (Math.log(S / K) + (b + 0.5 * sigma * sigma) * T) / vol;
    const f2 = f1 - vol;
    return (
      K * er * N(-f2) -
      S * eqr * N(-f1) +
      carry * (Math.pow(S / K, -twoB) * N(-f1 + twoB * vol) - Math.exp(b * T) * N(-f1))
    );
  }
  const m = sMin;
  const g1 = (Math.log(S / m) + (b + 0.5 * sigma * sigma) * T) / vol;
  const g2 = g1 - vol;
  return (
    er * (K - m) -
    S * eqr * N(-g1) +
    m * er * N(-g2) +
    carry * (Math.pow(S / m, -twoB) * N(-g1 + twoB * vol) - Math.exp(b * T) * N(-g1))
  );
}

function validateLookback(
  input: LookbackInput,
  strikeType: LookbackStrike,
  functionName: string,
): {
  q: number;
  sMin: number;
  sMax: number;
  warnings: QuantWarning[];
} {
  ensureEnum(strikeType, LOOKBACK_STRIKES, 'strikeType', functionName);
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  if (strikeType === 'fixed') {
    if (typeof input.strike !== 'number') {
      throw new InputError(`${functionName}: fixed-strike lookbacks require a strike.`, {
        code: ErrorCode.InputMissingField,
        context: { field: 'strike' },
      });
    }
    ensurePositive(input.strike, 'strike', functionName);
  }
  const sMin = input.runningMin ?? input.spot;
  const sMax = input.runningMax ?? input.spot;
  ensurePositive(sMin, 'runningMin', functionName);
  ensurePositive(sMax, 'runningMax', functionName);
  const warnings: QuantWarning[] = [];
  if (Math.abs(input.riskFreeRate - q) < 1e-6) {
    warnings.push(
      warning(
        WarningCode.LookbackZeroCarry,
        'Cost of carry r−q ≈ 0; the closed form has a removable singularity there and is evaluated at a small ε offset.',
        'info',
        { riskFreeRate: input.riskFreeRate, dividendYield: q },
      ),
    );
  }
  return { q, sMin, sMax, warnings };
}

const LOOKBACK_PRICE_SPEC = specOf('lookback.price#0');
const LOOKBACK_MC_INPUT_SPEC = specOf('lookback.monteCarloPrice#0');
const LOOKBACK_MC_OPTIONS_SPEC = specOf('lookback.monteCarloPrice#1');

const LOOKBACK_EXAMPLE = (): string =>
  "lookback.price({ type: 'call', strikeType: 'floating', spot: 100, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 })";

export const lookback = {
  /** Continuous-monitoring lookback price (Conze–Viswanathan / Goldman–Sosin–Gatto). */
  price(input: LookbackInput & { type: OptionType; strikeType: LookbackStrike }): ExoticResult {
    const functionName = 'lookback.price';
    validateClosedRequest(functionName, input, LOOKBACK_PRICE_SPEC, {
      exampleCall: LOOKBACK_EXAMPLE,
    });
    const { type, strikeType } = input;
    const { q, sMin, sMax, warnings } = validateLookback(input, strikeType, functionName);
    const sigma = input.volatility;
    const value =
      strikeType === 'floating'
        ? floatingLookback({
            type,
            spot: input.spot,
            timeToExpiryYears: input.timeToExpiryYears,
            riskFreeRate: input.riskFreeRate,
            dividendYield: q,
            volatility: sigma,
            runningMin: sMin,
            runningMax: sMax,
          })
        : fixedLookback({
            type,
            spot: input.spot,
            strike: input.strike!,
            timeToExpiryYears: input.timeToExpiryYears,
            riskFreeRate: input.riskFreeRate,
            dividendYield: q,
            volatility: sigma,
            runningMin: sMin,
            runningMax: sMax,
          });
    const diagnostics: Diagnostics = {
      engine: `lookback-${strikeType}`,
      method: 'conze-viswanathan',
      converged: Number.isFinite(value),
      warnings,
    };
    return {
      value: Math.max(0, value),
      assumptions: assumptions(
        input.timeToExpiryYears,
        q,
        `lookback-${strikeType}`,
        `lookback-${strikeType}`,
      ),
      diagnostics,
    };
  },

  /** Monte-Carlo lookback price with the Broadie–Glasserman–Kou discrete-monitoring correction. */
  monteCarloPrice(
    input: LookbackInput & { type: OptionType; strikeType: LookbackStrike },
    options: LookbackMonteCarloOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'lookback.monteCarloPrice';
    validateClosedRequest(functionName, input, LOOKBACK_MC_INPUT_SPEC, {
      exampleCall: LOOKBACK_EXAMPLE,
    });
    validateClosedRequest(functionName, options, LOOKBACK_MC_OPTIONS_SPEC, {
      exampleCall: LOOKBACK_EXAMPLE,
      argumentName: 'options',
    });
    const { type, strikeType } = input;
    const {
      q,
      sMin: sMin0,
      sMax: sMax0,
      warnings,
    } = validateLookback(input, strikeType, functionName);
    const { spot: S, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma } = input;
    const K = input.strike ?? 0;
    const steps = options.steps ?? 150;
    const timeStepYears = T / steps;
    const df = Math.exp(-r * T);
    // BGK shift: the continuous extreme is the discrete one extrapolated by exp(±βσ√dt).
    const upShift = Math.exp(BGK_BETA * sigma * Math.sqrt(timeStepYears));
    const downShift = 1 / upShift;

    const payoff = (z: number[]): number => {
      const path = gbmPathUnchecked({
        spot: S,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        timeToExpiryYears: T,
        shocks: z,
      });
      let mn = sMin0;
      let mx = sMax0;
      for (let i = 1; i <= steps; i++) {
        const p = path[i]!;
        if (p < mn) mn = p;
        if (p > mx) mx = p;
      }
      const ST = path[steps]!;
      const minC = mn * downShift;
      const maxC = mx * upShift;
      let intrinsic: number;
      if (strikeType === 'floating') {
        intrinsic = type === 'call' ? ST - minC : maxC - ST;
      } else {
        intrinsic = type === 'call' ? Math.max(maxC - K, 0) : Math.max(K - minC, 0);
      }
      return df * Math.max(0, intrinsic);
    };
    const est = monteCarloEstimate({
      dimensions: steps,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    const diagnostics: Diagnostics = {
      engine: `lookback-${strikeType}`,
      method: est.method === 'pseudo' ? 'monte-carlo-bgk' : `monte-carlo-${est.method}-bgk`,
      converged: est.converged,
      iterations: est.paths,
      warnings: [...warnings, ...est.warnings],
    };
    return {
      value: est.value,
      assumptions: assumptions(
        input.timeToExpiryYears,
        q,
        `lookback-${strikeType}`,
        `lookback-${strikeType}-mc`,
      ),
      diagnostics,
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// shared input validation
// ────────────────────────────────────────────────────────────────────────────

function requireSigma(input: { volatility?: number }, functionName: string): number {
  if (typeof input.volatility !== 'number') {
    throw new InputError(`${functionName}: volatility (a number) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'volatility' },
    });
  }
  ensurePositive(input.volatility, 'volatility', functionName);
  return input.volatility;
}

/**
 * The most averaging fixings one Asian contract accepts (2026-08-23 review, P0 "unbounded work"):
 * `Number.isInteger(1e308)` is `true`, so the old check let an absurd fixing count through — the
 * Monte-Carlo pricer draws one normal and one path point PER fixing on every path (averagingPoints
 * becomes the estimator's dimension count), so the count is a workload control, not a label.
 * 100,000 fixings is daily averaging for ~400 years; real Asian contracts fix daily-to-monthly over
 * months-to-years (tens to hundreds).
 */
const MAX_AVERAGING_POINTS = 100_000;

function requirePoints(m: number, functionName: string): void {
  if (!Number.isSafeInteger(m) || m < 1 || m > MAX_AVERAGING_POINTS) {
    throw new InputError(
      `${functionName}: averagingPoints must be an integer in [1, ${MAX_AVERAGING_POINTS.toLocaleString('en-US')}] — each fixing is one path point per Monte-Carlo path (the cap is daily fixings for ~400 years; real contracts fix tens to hundreds of times). Received ${m}.\n  e.g. { averagingPoints: 252 }`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { averagingPoints: m, max: MAX_AVERAGING_POINTS },
      },
    );
  }
}

// ────────────────────────────────────────────────────────────────────────────
// §9.3 multi-asset & structured exotics: spread, quanto, basket, rainbow,
// autocallable, and variance/volatility swaps. Each closed form is corroborated by
// (or, where no closed form exists, replaced with) a Monte-Carlo engine.
// ────────────────────────────────────────────────────────────────────────────

/** Map independent normals `z` to correlated normals via a Cholesky factor `L` (lower-triangular). */
function correlatedDraw(L: number[][], z: number[]): number[] {
  const n = L.length;
  const w = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k <= i; k++) s += L[i]![k]! * z[k]!;
    w[i] = s;
  }
  return w;
}

function requireCorrelation(rho: number, functionName: string): void {
  ensureFinite(rho, 'correlation', functionName);
  if (rho < -1 || rho > 1) {
    throw new InputError(`${functionName}: correlation must be in [-1, 1], got ${rho}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { correlation: rho },
    });
  }
}

// ───────────────────────── spread option (Kirk + Monte-Carlo) ─────────────────────────

export interface SpreadInput {
  spot1: number;
  spot2: number;
  /** Strike on `S1 − S2`. May be negative; Kirk requires `F2 + K > 0`. */
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  /**
   * Per-asset volatilities.
   *
   * These were `vol1`/`vol2` under a retired rule ("flat inputs use `vol`") that survived in this
   * comment long after the rule went. The denylist has forbidden `vol` since N0 — the digit is what
   * hid these two, which is the whole reason the tokenizer now tests the letter run in front of a
   * numeric suffix.
   */
  volatility1: number;
  volatility2: number;
  /** Correlation between the two assets, in [-1, 1]. */
  correlation: number;
  dividendYield1?: number;
  dividendYield2?: number;
}

function validateSpread(input: SpreadInput, functionName: string): { q1: number; q2: number } {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot1, 'spot1', functionName);
  ensurePositive(input.spot2, 'spot2', functionName);
  ensureFinite(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.volatility1, 'volatility1', functionName);
  ensurePositive(input.volatility2, 'volatility2', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  requireCorrelation(input.correlation, functionName);
  const q1 = input.dividendYield1 ?? 0;
  const q2 = input.dividendYield2 ?? 0;
  ensureFinite(q1, 'dividendYield1', functionName);
  ensureFinite(q2, 'dividendYield2', functionName);
  return { q1, q2 };
}

/** Kirk's approximation for a spread call/put (exact Margrabe when `K = 0`). */
function kirkSpread(input: {
  type: OptionType;
  spot1: number;
  spot2: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield1: number;
  dividendYield2: number;
  volatility1: number;
  volatility2: number;
  correlation: number;
}): number {
  const {
    type,
    spot1: S1,
    spot2: S2,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield1: q1,
    dividendYield2: q2,
    volatility1: v1,
    volatility2: v2,
    correlation: rho,
  } = input;
  const F1 = S1 * Math.exp((r - q1) * T);
  const F2 = S2 * Math.exp((r - q2) * T);
  if (F2 + K <= 0) {
    throw new InputError(`spread: Kirk's approximation requires F2 + K > 0 (got ${F2 + K}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { forward2: F2, strike: K },
    });
  }
  const disc = Math.exp(-r * T);
  const a = F2 / (F2 + K);
  const sk = Math.sqrt(Math.max(0, v1 * v1 - 2 * rho * v1 * v2 * a + v2 * v2 * a * a));
  const sd = sk * Math.sqrt(T);
  let call: number;
  if (sd <= 0) {
    call = disc * Math.max(F1 - (F2 + K), 0);
  } else {
    const d1 = (Math.log(F1 / (F2 + K)) + 0.5 * sd * sd) / sd;
    const d2 = d1 - sd;
    call = disc * (F1 * N(d1) - (F2 + K) * N(d2));
  }
  // Spread put–call parity: C − P = disc·(F1 − F2 − K).
  return type === 'call' ? call : call - disc * (F1 - F2 - K);
}

const SPREAD_PRICE_SPEC = specOf('spread.price#0');
const SPREAD_MC_INPUT_SPEC = specOf('spread.monteCarloPrice#0');
const SPREAD_MC_OPTIONS_SPEC = specOf('spread.monteCarloPrice#1');

const SPREAD_EXAMPLE = (): string =>
  "spread.price({ type: 'call', spot1: 100, spot2: 95, strike: 5, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility1: 0.2, volatility2: 0.25, correlation: 0.5 })";

export const spread = {
  /** Kirk's-approximation analytic price of an option on `S1 − S2`. */
  price(input: SpreadInput & { type: OptionType }): ExoticResult {
    const functionName = 'spread.price';
    validateClosedRequest(functionName, input, SPREAD_PRICE_SPEC, {
      exampleCall: SPREAD_EXAMPLE,
    });
    const { type } = input;
    const { q1, q2 } = validateSpread(input, functionName);
    const value = kirkSpread({
      type,
      spot1: input.spot1,
      spot2: input.spot2,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      dividendYield1: q1,
      dividendYield2: q2,
      volatility1: input.volatility1,
      volatility2: input.volatility2,
      correlation: input.correlation,
    });
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q1, 'spread-kirk', 'spread-kirk'),
      diagnostics: {
        engine: 'spread-kirk',
        method: 'closed-form',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /** Monte-Carlo price of the spread option (validator for, and generalization of, Kirk). */
  monteCarloPrice(
    input: SpreadInput & { type: OptionType },
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'spread.monteCarloPrice';
    validateClosedRequest(functionName, input, SPREAD_MC_INPUT_SPEC, {
      exampleCall: SPREAD_EXAMPLE,
    });
    validateClosedRequest(functionName, options, SPREAD_MC_OPTIONS_SPEC, {
      exampleCall: SPREAD_EXAMPLE,
      argumentName: 'options',
    });
    const { type } = input;
    const { q1, q2 } = validateSpread(input, functionName);
    const {
      spot1: S1,
      spot2: S2,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      volatility1: v1,
      volatility2: v2,
      correlation: rho,
    } = input;
    const df = Math.exp(-r * T);
    const drift1 = (r - q1 - 0.5 * v1 * v1) * T;
    const drift2 = (r - q2 - 0.5 * v2 * v2) * T;
    const sq = Math.sqrt(T);
    const payoff = (z: number[]): number => {
      const w1 = z[0]!;
      const w2 = rho * z[0]! + Math.sqrt(1 - rho * rho) * z[1]!;
      const s1 = S1 * Math.exp(drift1 + v1 * sq * w1);
      const s2 = S2 * Math.exp(drift2 + v2 * sq * w2);
      const intrinsic = type === 'call' ? Math.max(s1 - s2 - K, 0) : Math.max(K - (s1 - s2), 0);
      return df * intrinsic;
    };
    const est = monteCarloEstimate({
      dimensions: 2,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(T, q1, 'spread', 'spread-mc'),
      diagnostics: {
        engine: 'spread-mc',
        method: `monte-carlo-${est.method}`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ───────────────────────── quanto option (closed form) ─────────────────────────

export interface QuantoInput {
  /** Foreign-asset spot (in foreign currency). */
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  /** Domestic discount rate. */
  domesticRate: number;
  /** Foreign risk-free rate. */
  foreignRate: number;
  /** Asset volatility. */
  volatility: number;
  /** Volatility of the domestic/foreign FX rate. */
  fxVolatility: number;
  /** Correlation between the asset and the FX rate, in [-1, 1]. */
  correlation: number;
  dividendYield?: number;
}

const QUANTO_PRICE_SPEC = specOf('quanto.price#0');

const QUANTO_EXAMPLE = (): string =>
  "quanto.price({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.25, domesticRate: 0.04, foreignRate: 0.02, volatility: 0.2, fxVolatility: 0.1, correlation: 0.5 })";

export const quanto = {
  /**
   * Quanto option paying `(S_foreign(T) − K)⁺` in domestic currency at a fixed FX rate. The asset's
   * drift is adjusted by `−ρ·σ_S·σ_FX` (the quanto correction) and discounting is domestic.
   */
  price(input: QuantoInput & { type: OptionType }): ExoticResult {
    const functionName = 'quanto.price';
    validateClosedRequest(functionName, input, QUANTO_PRICE_SPEC, {
      exampleCall: QUANTO_EXAMPLE,
    });
    const { type } = input;
    ensurePositive(input.spot, 'spot', functionName);
    ensurePositive(input.strike, 'strike', functionName);
    ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
    ensurePositive(input.volatility, 'volatility', functionName);
    ensureNonNegativeVolatility(input.fxVolatility, 'fxVolatility', functionName);
    ensureFinite(input.domesticRate, 'domesticRate', functionName);
    ensureFinite(input.foreignRate, 'foreignRate', functionName);
    requireCorrelation(input.correlation, functionName);
    const q = input.dividendYield ?? 0;
    ensureFinite(q, 'dividendYield', functionName);
    const { spot: S, strike: K, timeToExpiryYears: T, volatility: sigma } = input;
    const muQ = input.foreignRate - q - input.correlation * sigma * input.fxVolatility;
    const F = S * Math.exp(muQ * T);
    const sd = sigma * Math.sqrt(T);
    const disc = Math.exp(-input.domesticRate * T);
    const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd;
    const d2 = d1 - sd;
    const value =
      type === 'call' ? disc * (F * N(d1) - K * N(d2)) : disc * (K * N(-d2) - F * N(-d1));
    return {
      value,
      assumptions: assumptions(T, q, 'quanto', 'quanto'),
      diagnostics: {
        engine: 'quanto',
        method: 'closed-form',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },
} as const;

function ensureNonNegativeVolatility(v: number, field: string, functionName: string): void {
  ensureFinite(v, field, functionName);
  if (v < 0) {
    throw new InputError(`${functionName}: ${field} must be ≥ 0, got ${v}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { [field]: v },
    });
  }
}

// ───────────────────────── basket & rainbow (multi-asset Monte-Carlo) ─────────────────────────

export interface MultiAssetInput {
  spots: number[];
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatilities: number[];
  /** Correlation matrix (n × n, symmetric, unit diagonal, positive definite). */
  correlation: number[][];
  dividendYields?: number[];
}

export interface BasketInput extends MultiAssetInput {
  /** Basket weights (one per asset). */
  weights: number[];
}

/**
 * Validate a correlation matrix: square, symmetric, unit diagonal, entries in [−1, 1], and positive
 * definite.
 *
 * The Monte-Carlo branch got this for free — `cholesky` refuses a non-PD matrix — while the analytic
 * (Levy moment-matched) branch only ever READ the entries, so `ρ = 1.8` produced a confident price
 * from an impossible market, and an asymmetric or non-PSD matrix priced a covariance no asset pair
 * could have. One validator now runs on every multi-asset entry point.
 */
function requireCorrelationMatrix(matrix: number[][], size: number, functionName: string): void {
  const bad = (message: string, context: Record<string, unknown>): never => {
    throw new InputError(`${functionName}: ${message}`, {
      code: ErrorCode.InputOutOfRange,
      context,
    });
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size; j++) {
      const value = matrix[i]![j]!;
      ensureFinite(value, `correlation[${i}][${j}]`, functionName);
      if (i === j && Math.abs(value - 1) > 1e-12) {
        bad(
          `correlation[${i}][${i}] must be exactly 1 (an asset correlates perfectly with itself), got ${value}.`,
          {
            row: i,
            value,
          },
        );
      }
      if (value < -1 || value > 1) {
        bad(
          `correlation[${i}][${j}] = ${value} is outside [−1, 1] — a correlation is a normalized covariance; ` +
            'did you pass a covariance matrix?',
          { row: i, column: j, value },
        );
      }
      const mirrored = matrix[j]![i]!;
      if (i !== j && Math.abs(value - mirrored) > 1e-12) {
        bad(
          `correlation is not symmetric: [${i}][${j}] = ${value} but [${j}][${i}] = ${mirrored}.`,
          { row: i, column: j, value, mirrored },
        );
      }
    }
  }
  try {
    // The same positive-definiteness test the simulation path applies, so both branches accept
    // exactly the same matrices (and reject the same ones with the same code).
    cholesky(matrix);
  } catch (error) {
    throw new InputError(
      `${functionName}: correlation is not positive definite, so it describes no possible joint ` +
        'distribution (some portfolio of these assets would have negative variance). Repair it with ' +
        'nearestCorrelation / nearestPsd from @totalfinance/math, or reduce the number of assets.',
      {
        code: ErrorCode.LinalgNotPositiveDefinite,
        context: { function: functionName, size },
        cause: error,
      },
    );
  }
}

function validateMultiAsset(input: MultiAssetInput, functionName: string): number[] {
  requireArgumentObject(functionName, 'input', input);
  // Container-shape first: a wrong key (`volatilities: [...]`, `sigma: [...]`) must teach the real slot
  // names by echoing what the caller DID pass, not crash on `undefined.length`.
  if (
    !Array.isArray(input.spots) ||
    !Array.isArray(input.volatilities) ||
    !Array.isArray(input.correlation)
  ) {
    throw wrongShapeError(
      functionName,
      'input with spots: number[], volatilities: number[], and correlation: number[][] (plus strike, t, rate)',
      input,
    );
  }
  const n = input.spots.length;
  if (n < 2 || input.volatilities.length !== n || input.correlation.length !== n) {
    throw new InputError(
      `${functionName}: need ≥ 2 assets with matching volatilities and an n×n correlation.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          spots: n,
          volatilities: input.volatilities.length,
          correlation: input.correlation.length,
        },
      },
    );
  }
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  for (let i = 0; i < n; i++) {
    ensurePositive(input.spots[i]!, `spots[${i}]`, functionName);
    ensurePositive(input.volatilities[i]!, `volatilities[${i}]`, functionName);
    if (!Array.isArray(input.correlation[i]) || input.correlation[i]!.length !== n) {
      throw new InputError(`${functionName}: correlation row ${i} must have length ${n}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { row: i },
      });
    }
  }
  requireCorrelationMatrix(input.correlation, n, functionName);
  const q = input.dividendYields ?? new Array<number>(n).fill(0);
  if (q.length !== n) {
    throw new InputError(`${functionName}: dividendYields must have length ${n}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { got: q.length, expected: n },
    });
  }
  for (let i = 0; i < n; i++) ensureFinite(q[i]!, `dividendYields[${i}]`, functionName);
  return q;
}

const BASKET_APPROXIMATE_SPEC = specOf('basket.approximatePrice#0');
const BASKET_MC_INPUT_SPEC = specOf('basket.monteCarloPrice#0');
const BASKET_MC_OPTIONS_SPEC = specOf('basket.monteCarloPrice#1');

const BASKET_EXAMPLE = (): string =>
  "basket.approximatePrice({ type: 'call', spots: [100, 95], weights: [0.5, 0.5], strike: 100, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatilities: [0.2, 0.25], correlation: [[1, 0.5], [0.5, 1]] })";

export const basket = {
  /** Levy moment-matched lognormal approximation (closed form) for a weighted-basket option. */
  approximatePrice(input: BasketInput & { type: OptionType }): ExoticResult {
    const functionName = 'basket.approximatePrice';
    validateClosedRequest(functionName, input, BASKET_APPROXIMATE_SPEC, {
      exampleCall: BASKET_EXAMPLE,
    });
    const { type } = input;
    const q = validateMultiAsset(input, functionName);
    const n = input.spots.length;
    // A missing/mistyped weights slot must teach its name, not crash on `.length`.
    requireArgumentArray(functionName, 'input.weights', input.weights);
    if (input.weights.length !== n) {
      throw new InputError(`${functionName}: weights must have length ${n}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { got: input.weights.length, expected: n },
      });
    }
    const { timeToExpiryYears: T, riskFreeRate: r, strike: K } = input;
    const F = input.spots.map((s, i) => s * Math.exp((r - q[i]!) * T));
    let M1 = 0;
    for (let i = 0; i < n; i++) M1 += input.weights[i]! * F[i]!;
    let M2 = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const covariance = Math.exp(
          input.correlation[i]![j]! * input.volatilities[i]! * input.volatilities[j]! * T,
        );
        M2 += input.weights[i]! * input.weights[j]! * F[i]! * F[j]! * covariance;
      }
    }
    if (M1 <= 0) {
      throw new InputError(
        `${functionName}: the moment-matched forward basket must be positive (got ${M1}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { forwardBasket: M1 },
        },
      );
    }
    const sigmaB = Math.sqrt(Math.log(M2 / (M1 * M1)) / T);
    const sd = sigmaB * Math.sqrt(T);
    const disc = Math.exp(-r * T);
    let call: number;
    if (sd <= 0) {
      call = disc * Math.max(M1 - K, 0);
    } else {
      const d1 = (Math.log(M1 / K) + 0.5 * sd * sd) / sd;
      call = disc * (M1 * N(d1) - K * N(d1 - sd));
    }
    const value = type === 'call' ? call : call - disc * (M1 - K);
    return {
      value,
      assumptions: assumptions(T, 0, 'basket-levy', 'basket-levy'),
      diagnostics: {
        engine: 'basket-levy',
        method: 'closed-form',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /** Monte-Carlo price of a weighted-basket option (exact; corroborates the Levy approximation). */
  monteCarloPrice(
    input: BasketInput & { type: OptionType },
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'basket.monteCarloPrice';
    validateClosedRequest(functionName, input, BASKET_MC_INPUT_SPEC, {
      exampleCall: BASKET_EXAMPLE,
    });
    validateClosedRequest(functionName, options, BASKET_MC_OPTIONS_SPEC, {
      exampleCall: BASKET_EXAMPLE,
      argumentName: 'options',
    });
    const { type } = input;
    const q = validateMultiAsset(input, functionName);
    const n = input.spots.length;
    requireArgumentArray(functionName, 'input.weights', input.weights);
    if (input.weights.length !== n) {
      throw new InputError(`${functionName}: weights must have length ${n}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { got: input.weights.length, expected: n },
      });
    }
    const { timeToExpiryYears: T, riskFreeRate: r, strike: K } = input;
    const L = cholesky(input.correlation);
    const df = Math.exp(-r * T);
    const sq = Math.sqrt(T);
    const drift = input.spots.map(
      (_, i) => (r - q[i]! - 0.5 * input.volatilities[i]! * input.volatilities[i]!) * T,
    );
    const payoff = (z: number[]): number => {
      const w = correlatedDraw(L, z);
      let b = 0;
      for (let i = 0; i < n; i++) {
        b +=
          input.weights[i]! *
          input.spots[i]! *
          Math.exp(drift[i]! + input.volatilities[i]! * sq * w[i]!);
      }
      return df * (type === 'call' ? Math.max(b - K, 0) : Math.max(K - b, 0));
    };
    const est = monteCarloEstimate({
      dimensions: n,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(T, 0, 'basket', 'basket-mc'),
      diagnostics: {
        engine: 'basket-mc',
        method: `monte-carlo-${est.method}`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

export type RainbowKind = 'max' | 'min';

const RAINBOW_MC_INPUT_SPEC = specOf('rainbow.monteCarloPrice#0');
const RAINBOW_MC_OPTIONS_SPEC = specOf('rainbow.monteCarloPrice#1');

const RAINBOW_EXAMPLE = (): string =>
  "rainbow.monteCarloPrice({ type: 'call', kind: 'max', spots: [100, 95], strike: 100, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatilities: [0.2, 0.25], correlation: [[1, 0.5], [0.5, 1]] }, { paths: 20000, seed: 42 })";

export const rainbow = {
  /** Monte-Carlo price of a rainbow option on the max or min of several assets. */
  monteCarloPrice(
    input: MultiAssetInput & { type: OptionType; kind: RainbowKind },
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'rainbow.monteCarloPrice';
    validateClosedRequest(functionName, input, RAINBOW_MC_INPUT_SPEC, {
      exampleCall: RAINBOW_EXAMPLE,
    });
    validateClosedRequest(functionName, options, RAINBOW_MC_OPTIONS_SPEC, {
      exampleCall: RAINBOW_EXAMPLE,
      argumentName: 'options',
    });
    const { type, kind } = input;
    const q = validateMultiAsset(input, functionName);
    const n = input.spots.length;
    const { timeToExpiryYears: T, riskFreeRate: r, strike: K } = input;
    const L = cholesky(input.correlation);
    const df = Math.exp(-r * T);
    const sq = Math.sqrt(T);
    const drift = input.spots.map(
      (_, i) => (r - q[i]! - 0.5 * input.volatilities[i]! * input.volatilities[i]!) * T,
    );
    const payoff = (z: number[]): number => {
      const w = correlatedDraw(L, z);
      let best = kind === 'max' ? -Infinity : Infinity;
      for (let i = 0; i < n; i++) {
        const si = input.spots[i]! * Math.exp(drift[i]! + input.volatilities[i]! * sq * w[i]!);
        best = kind === 'max' ? Math.max(best, si) : Math.min(best, si);
      }
      return df * (type === 'call' ? Math.max(best - K, 0) : Math.max(K - best, 0));
    };
    const est = monteCarloEstimate({
      dimensions: n,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(T, 0, `rainbow-${kind}`, `rainbow-${kind}-mc`),
      diagnostics: {
        engine: `rainbow-${kind}-mc`,
        method: `monte-carlo-${est.method}`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ───────────────────────── autocallable note (Monte-Carlo) ─────────────────────────

export interface AutocallableInput {
  spot: number;
  /** Strictly-increasing observation times in years; the last is maturity. */
  observationTimes: number[];
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** Autocall trigger level: if `S(tᵢ) ≥ autocallBarrier`, the note redeems early. */
  autocallBarrier: number;
  /** Coupon per elapsed period (fraction of notional), paid cumulatively on redemption. */
  couponRate: number;
  /** Downside knock-in level checked at maturity (capital is at risk below it). */
  knockInBarrier: number;
  /** Notional. Default 100. */
  notional?: number;
}

const AUTOCALLABLE_MC_INPUT_SPEC = specOf('autocallable.monteCarloPrice#0');
const AUTOCALLABLE_MC_OPTIONS_SPEC = specOf('autocallable.monteCarloPrice#1');

const AUTOCALLABLE_EXAMPLE = (): string =>
  'autocallable.monteCarloPrice({ spot: 100, observationTimes: [0.5, 1], riskFreeRate: 0.04, volatility: 0.2, autocallBarrier: 105, couponRate: 0.03, knockInBarrier: 70 }, { paths: 20000, seed: 42 })';

export const autocallable = {
  /**
   * Monte-Carlo price of a canonical autocallable note: on each observation date the note redeems at
   * `notional·(1 + couponRate·periods)` if the spot is at or above `autocallBarrier`; if it never does,
   * at maturity it returns the notional when `S(T) ≥ knockInBarrier`, else the loss-bearing
   * `notional·S(T)/S(0)`. The payoff is discounted at the per-path redemption time.
   */
  monteCarloPrice(
    input: AutocallableInput,
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'autocallable.monteCarloPrice';
    validateClosedRequest(functionName, input, AUTOCALLABLE_MC_INPUT_SPEC, {
      exampleCall: AUTOCALLABLE_EXAMPLE,
    });
    validateClosedRequest(functionName, options, AUTOCALLABLE_MC_OPTIONS_SPEC, {
      exampleCall: AUTOCALLABLE_EXAMPLE,
      argumentName: 'options',
    });
    ensurePositive(input.spot, 'spot', functionName);
    ensurePositive(input.volatility, 'volatility', functionName);
    ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
    ensurePositive(input.autocallBarrier, 'autocallBarrier', functionName);
    ensurePositive(input.knockInBarrier, 'knockInBarrier', functionName);
    ensureFinite(input.couponRate, 'couponRate', functionName);
    const q = input.dividendYield ?? 0;
    ensureFinite(q, 'dividendYield', functionName);
    // A missing/mistyped schedule slot must teach its name, not crash on `.length`.
    requireArgumentArray(functionName, 'input.observationTimes', input.observationTimes);
    const obs = input.observationTimes;
    const n = obs.length;
    if (n < 1) {
      throw new InputError(`${functionName}: at least one observation time is required.`, {
        code: ErrorCode.InputOutOfRange,
        context: { observations: n },
      });
    }
    for (let i = 0; i < n; i++) {
      ensurePositive(obs[i]!, `observationTimes[${i}]`, functionName);
      if (i > 0 && obs[i]! <= obs[i - 1]!) {
        throw new InputError(`${functionName}: observationTimes must be strictly increasing.`, {
          code: ErrorCode.InputOutOfRange,
          context: { index: i },
        });
      }
    }
    const notional = input.notional ?? 100;
    const { spot: S0, riskFreeRate: r, volatility: sigma } = input;
    const timeStepYears = obs.map((t, i) => t - (i === 0 ? 0 : obs[i - 1]!));
    const sqdt = timeStepYears.map((d) => Math.sqrt(d));
    const drift = timeStepYears.map((d) => (r - q - 0.5 * sigma * sigma) * d);
    const T = obs[n - 1]!;

    const payoff = (z: number[]): number => {
      let logS = Math.log(S0);
      for (let i = 0; i < n; i++) {
        logS += drift[i]! + sigma * sqdt[i]! * z[i]!;
        const s = Math.exp(logS);
        if (s >= input.autocallBarrier) {
          return notional * (1 + input.couponRate * (i + 1)) * Math.exp(-r * obs[i]!);
        }
      }
      const sT = Math.exp(logS);
      const redemption = sT >= input.knockInBarrier ? notional : notional * (sT / S0);
      return redemption * Math.exp(-r * T);
    };
    const est = monteCarloEstimate({
      dimensions: n,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(T, q, 'autocallable', 'autocallable-mc'),
      diagnostics: {
        engine: 'autocallable-mc',
        method: `monte-carlo-${est.method}`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ───────────────────────── variance & volatility swaps ─────────────────────────

const VARIANCE_SWAP_HESTON_SPEC = specOf('varianceSwap.hestonFairVariance#0');
const VARIANCE_SWAP_VALUE_SPEC = specOf('varianceSwap.value#0');

const VARIANCE_SWAP_HESTON_EXAMPLE = (): string =>
  'varianceSwap.hestonFairVariance({ v0: 0.04, kappa: 2, theta: 0.05 }, 0.25)';
const VARIANCE_SWAP_VALUE_EXAMPLE = (): string =>
  'varianceSwap.value({ realizedVariance: 0.05, strikeVariance: 0.04, riskFreeRate: 0.04, timeToExpiryYears: 0.25 })';

export const varianceSwap = {
  /**
   * Fair variance strike under Heston: `θ + (v₀ − θ)·(1 − e^{−κT})/(κT)`. Depends only on the
   * mean-reversion `κ`, long-run variance `θ`, and initial variance `v₀` (not on vol-of-vol/ρ).
   */
  hestonFairVariance(
    parameters: { v0: number; kappa: number; theta: number },
    timeToExpiryYears: number,
  ): number {
    const functionName = 'varianceSwap.hestonFairVariance';
    validateClosedRequest(functionName, parameters, VARIANCE_SWAP_HESTON_SPEC, {
      exampleCall: VARIANCE_SWAP_HESTON_EXAMPLE,
      argumentName: 'parameters',
    });
    ensureNonNegativeVolatility(parameters.v0, 'v0', functionName);
    ensurePositive(parameters.kappa, 'kappa', functionName);
    ensureNonNegativeVolatility(parameters.theta, 'theta', functionName);
    ensurePositive(timeToExpiryYears, 'timeToExpiryYears', functionName);
    return (
      parameters.theta +
      ((parameters.v0 - parameters.theta) * (1 - Math.exp(-parameters.kappa * timeToExpiryYears))) /
        (parameters.kappa * timeToExpiryYears)
    );
  },

  /** Present value of a variance swap: `e^{−rT}·varianceNotional·(realizedVariance − strikeVariance)`. */
  value(input: {
    realizedVariance: number;
    strikeVariance: number;
    varianceNotional?: number;
    riskFreeRate: number;
    timeToExpiryYears: number;
  }): number {
    const functionName = 'varianceSwap.value';
    validateClosedRequest(functionName, input, VARIANCE_SWAP_VALUE_SPEC, {
      exampleCall: VARIANCE_SWAP_VALUE_EXAMPLE,
    });
    ensureNonNegativeVolatility(input.realizedVariance, 'realizedVariance', functionName);
    ensureNonNegativeVolatility(input.strikeVariance, 'strikeVariance', functionName);
    ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
    ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
    const notional = input.varianceNotional ?? 1;
    // `?? 1` only substitutes for null/undefined, so an explicit NaN would flow straight through.
    ensureFinite(notional, 'varianceNotional', functionName);
    return (
      Math.exp(-input.riskFreeRate * input.timeToExpiryYears) *
      notional *
      (input.realizedVariance - input.strikeVariance)
    );
  },
} as const;

const VOLATILITY_SWAP_FAIR_VOLATILITY_SPEC = specOf('volatilitySwap.approximateFairVolatility#0');

const VOLATILITY_SWAP_EXAMPLE = (): string =>
  'volatilitySwap.approximateFairVolatility({ fairVariance: 0.04 })';

export const volatilitySwap = {
  /**
   * Brockhaus–Long convexity-adjusted fair vol:
   * `K_vol ≈ √K_var·(1 − Var[realized variance]/(8·K_var²))`. With no variance-of-variance it reduces
   * to `√K_var`; the adjustment captures the (downward) Jensen gap between √E[var] and E[√var].
   */
  approximateFairVolatility(input: { fairVariance: number; varianceOfVariance?: number }): number {
    const functionName = 'volatilitySwap.approximateFairVolatility';
    validateClosedRequest(functionName, input, VOLATILITY_SWAP_FAIR_VOLATILITY_SPEC, {
      exampleCall: VOLATILITY_SWAP_EXAMPLE,
    });
    ensurePositive(input.fairVariance, 'fairVariance', functionName);
    const varVar = input.varianceOfVariance ?? 0;
    ensureNonNegativeVolatility(varVar, 'varianceOfVariance', functionName);
    // The Brockhaus–Long convexity term `varVar/(8·K_var²)` is a *small* second-order correction; once
    // it reaches 1 the formula would return a ≤0 "fair vol", which is meaningless. Refuse rather than
    // emit a negative volatility — the caller must supply a smaller varVar or price the swap directly.
    const secondOrder = varVar / (8 * input.fairVariance * input.fairVariance);
    if (secondOrder >= 1) {
      throw new InputError(
        `${functionName}: varianceOfVariance ${varVar} is too large relative to fairVariance² — the Brockhaus–Long approximation leaves its valid region (convexity correction ${
          1 - secondOrder
        } ≤ 0).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: {
            fairVariance: input.fairVariance,
            varianceOfVariance: varVar,
            correction: 1 - secondOrder,
          },
        },
      );
    }
    return Math.sqrt(input.fairVariance) * (1 - secondOrder);
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Digital (binary) options — European cash-or-nothing / asset-or-nothing
// ────────────────────────────────────────────────────────────────────────────

export type DigitalKind = 'cash-or-nothing' | 'asset-or-nothing';

export interface DigitalInput {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** Fixed payout for `cash-or-nothing` (ignored by `asset-or-nothing`); default 1. */
  cash?: number;
}

function validateDigital(input: DigitalInput, functionName: string): { q: number; cash: number } {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const cash = input.cash ?? 1;
  ensureFinite(cash, 'cash', functionName);
  return { q, cash };
}

/** Cash-or-nothing (`Q·e^{−rT}·N(±d₂)`) / asset-or-nothing (`S·e^{−qT}·N(±d₁)`) European binary. */
function digitalAnalytic(input: {
  type: OptionType;
  kind: DigitalKind;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  cash: number;
}): number {
  const {
    type,
    kind,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    cash,
  } = input;
  const b = r - q;
  const vol = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (b + 0.5 * sigma * sigma) * T) / vol;
  const d2 = d1 - vol;
  const phi = type === 'call' ? 1 : -1;
  return kind === 'cash-or-nothing'
    ? cash * Math.exp(-r * T) * N(phi * d2)
    : S * Math.exp(-q * T) * N(phi * d1);
}

const DIGITAL_PRICE_SPEC = specOf('digital.price#0');
const DIGITAL_MC_INPUT_SPEC = specOf('digital.monteCarloPrice#0');
const DIGITAL_MC_OPTIONS_SPEC = specOf('digital.monteCarloPrice#1');
const DIGITAL_GREEKS_SPEC = specOf('digital.greeks#0');
const DIGITAL_EXTENDED_GREEKS_SPEC = specOf('digital.extendedGreeks#0');

const DIGITAL_EXAMPLE = (): string =>
  "digital.price({ type: 'call', kind: 'cash-or-nothing', spot: 100, strike: 105, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 })";

export const digital = {
  /** European binary price (closed form). A vanilla call ≡ asset-or-nothing call − K·cash-or-nothing call. */
  price(input: DigitalInput & { type: OptionType; kind: DigitalKind }): ExoticResult {
    const functionName = 'digital.price';
    validateClosedRequest(functionName, input, DIGITAL_PRICE_SPEC, {
      exampleCall: DIGITAL_EXAMPLE,
    });
    const { type, kind } = input;
    const { q, cash } = validateDigital(input, functionName);
    const value = digitalAnalytic({
      type,
      kind,
      spot: input.spot,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      dividendYield: q,
      volatility: input.volatility,
      cash,
    });
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'digital', `digital-${kind}`),
      diagnostics: {
        engine: `digital-${kind}`,
        method: 'closed-form',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /** Monte-Carlo binary price (discount the terminal indicator payoff); converges to the analytic. */
  monteCarloPrice(
    input: DigitalInput & { type: OptionType; kind: DigitalKind },
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'digital.monteCarloPrice';
    validateClosedRequest(functionName, input, DIGITAL_MC_INPUT_SPEC, {
      exampleCall: DIGITAL_EXAMPLE,
    });
    validateClosedRequest(functionName, options, DIGITAL_MC_OPTIONS_SPEC, {
      exampleCall: DIGITAL_EXAMPLE,
      argumentName: 'options',
    });
    const { type, kind } = input;
    const { q, cash } = validateDigital(input, functionName);
    const { spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma } = input;
    const df = Math.exp(-r * T);
    const payoff = (z: number[]): number => {
      const ST = gbmTerminal({
        spot: S,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        timeToExpiryYears: T,
        shock: z[0]!,
      });
      const inMoney = type === 'call' ? ST > K : ST < K;
      if (!inMoney) return 0;
      return df * (kind === 'cash-or-nothing' ? cash : ST);
    };
    const est = monteCarloEstimate({
      dimensions: 1,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'digital', `digital-${kind}-mc`),
      diagnostics: {
        engine: `digital-${kind}`,
        method: `monte-carlo-${est.method}`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },

  /**
   * Closed-form greeks (delta, gamma, vega, theta, rho) for the European binary. Every greek is an exact
   * derivative of the `digital.price` closed form — pinned to a finite-difference bump in the tests. Units
   * match the package: `vega` per vol point, `theta` per calendar day, `rho` per 1% (echoed in
   * `assumptions.units`). A cash-or-nothing's delta spikes and gamma flips sign across the strike (pin
   * risk); the asset-or-nothing's gamma/vega are exactly `0` at `d₂ = 0`. See `docs/specs/digital-greeks.md`.
   */
  greeks(input: DigitalInput & { type: OptionType; kind: DigitalKind }): Computed<Greeks> {
    const functionName = 'digital.greeks';
    validateClosedRequest(functionName, input, DIGITAL_GREEKS_SPEC, {
      exampleCall: DIGITAL_EXAMPLE,
    });
    const { type, kind } = input;
    const { q, cash } = validateDigital(input, functionName);
    const { spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma } = input;

    const sqrtT = Math.sqrt(T);
    const vol = sigma * sqrtT;
    const v2 = sigma * sigma * T; // vol²
    const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vol;
    const d2 = d1 - vol;
    const phi = type === 'call' ? 1 : -1;
    const df = Math.exp(-r * T);
    const dq = Math.exp(-q * T);
    const pd1 = npdf(d1);
    const pd2 = npdf(d2);
    const Aterm = Math.log(S / K) / sigma;
    const dd2dT = ((r - q - 0.5 * sigma * sigma) / sigma - Aterm / T) / (2 * sqrtT);
    const dd1dT = ((r - q + 0.5 * sigma * sigma) / sigma - Aterm / T) / (2 * sqrtT);

    let delta: number;
    let gamma: number;
    let vegaRaw: number; // ∂V/∂σ
    let rhoRaw: number; // ∂V/∂r
    let thetaPerYear: number; // −∂V/∂T
    if (kind === 'cash-or-nothing') {
      const nCdf = N(phi * d2);
      delta = (phi * cash * df * pd2) / (S * vol);
      gamma = (-phi * cash * df * pd2 * d1) / (S * S * v2);
      vegaRaw = (-phi * cash * df * pd2 * d1) / sigma;
      rhoRaw = cash * df * (-T * nCdf + (phi * pd2 * sqrtT) / sigma);
      thetaPerYear = cash * df * (r * nCdf - phi * pd2 * dd2dT);
    } else {
      const nCdf = N(phi * d1);
      delta = dq * nCdf + (phi * dq * pd1) / vol;
      gamma = (-phi * dq * pd1 * d2) / (S * v2);
      vegaRaw = (-phi * S * dq * pd1 * d2) / sigma;
      rhoRaw = (phi * S * dq * pd1 * sqrtT) / sigma;
      thetaPerYear = S * dq * (q * nCdf - phi * pd1 * dd1dT);
    }

    const greeks: Greeks = {
      delta,
      gamma,
      theta: thetaPerYear / DAYS_PER_YEAR,
      vega: vegaRaw / 100,
      rho: rhoRaw / 100,
    };
    return {
      value: greeks,
      assumptions: {
        ...assumptions(input.timeToExpiryYears, q, 'digital', `digital-${kind}`),
        units: DEFAULT_GREEK_UNITS,
      },
      diagnostics: {
        engine: `digital-${kind}`,
        method: 'closed-form-greeks',
        converged: Object.values(greeks).every((x) => Number.isFinite(x)),
        warnings: [],
      },
    };
  },

  /**
   * The full higher-order (extended) Greek set for the European binary — completing {@link digital.greeks}
   * with vanna, charm, vomma, speed, color, phi, zomma, veta, vera, ultima, and lambda. The binary price is
   * a smooth function of `(S, σ, r, q, T)` for `T > 0`, so the higher-order Greeks are taken by central
   * finite differences of the exact `digital.price` closed form (the shared `finiteDifferenceExtendedGreeks`
   * helper); the first-order fields are the exact analytic Greeks of {@link digital.greeks}. Units match the
   * package (higher-order raw; `phi` per 1% dividend yield; `lambda` dimensionless). Near the strike a
   * binary's Greeks spike (pin risk) — they stay finite for `T > 0`, but very close to expiry-at-the-pin the
   * higher-order finite differences lose precision; widen `t` or read the sign/scale rather than the digit.
   * See `docs/specs/digital-extended-greeks.md`.
   */
  extendedGreeks(
    input: DigitalInput & { type: OptionType; kind: DigitalKind },
  ): Computed<ExtendedGreeks> {
    const functionName = 'digital.extendedGreeks';
    validateClosedRequest(functionName, input, DIGITAL_EXTENDED_GREEKS_SPEC, {
      exampleCall: DIGITAL_EXAMPLE,
    });
    const { type, kind } = input;
    const { q, cash } = validateDigital(input, functionName);
    const { spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma } = input;

    // Higher-order set: central differences of the exact analytic binary price.
    const price = ({
      spot,
      volatility,
      timeToExpiryYears,
      riskFreeRate,
      dividendYield,
    }: {
      spot: number;
      volatility: number;
      timeToExpiryYears: number;
      riskFreeRate: number;
      dividendYield: number;
    }): number =>
      digitalAnalytic({
        type,
        kind,
        spot,
        strike: K,
        timeToExpiryYears,
        riskFreeRate,
        dividendYield,
        volatility,
        cash,
      });
    const fd = finiteDifferenceExtendedGreeks({
      price,
      spotAt: () => S,
      state: { spot: S, T, r, q, sigma },
    });
    // Override the FD first-order with the exact analytic Greeks (they agree to ~1e-5), and re-derive the
    // elasticity `lambda = Δ·S/V` from the analytic delta so it stays consistent with the overridden delta.
    const first = digital.greeks(input).value;
    const value: ExtendedGreeks = {
      ...fd,
      ...first,
      lambda: finiteOrNull(
        (first.delta * S) /
          digitalAnalytic({
            type,
            kind,
            spot: S,
            strike: K,
            timeToExpiryYears: T,
            riskFreeRate: r,
            dividendYield: q,
            volatility: sigma,
            cash,
          }),
      ),
    };

    return {
      value,
      assumptions: {
        ...assumptions(input.timeToExpiryYears, q, 'digital', `digital-${kind}`),
        units: DEFAULT_GREEK_UNITS,
      },
      diagnostics: {
        engine: `digital-${kind}`,
        method: 'analytic-first-order + fd-higher-order',
        // A disclosed-null lambda is an undefined-by-design quantity, not a convergence failure.
        converged: Object.values(value).every((x) => x === null || Number.isFinite(x)),
        warnings:
          value.lambda === null
            ? [
                {
                  code: WarningCode.LambdaUndefined,
                  message:
                    'lambda (elasticity Δ·S/V) is undefined — the binary price underflowed to zero; reported as null, never NaN/Infinity.',
                  severity: 'info' as const,
                },
              ]
            : [],
      },
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// One-touch / no-touch options — American binaries on a barrier
// ────────────────────────────────────────────────────────────────────────────

export type TouchKind = 'one-touch' | 'no-touch';
type TouchPayAt = 'expiry' | 'hit';

export interface TouchInput {
  spot: number;
  /** Barrier level `H`; below spot ⇒ a down-touch, above ⇒ an up-touch. */
  barrier: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** Rebate paid on the touch outcome; default 1. */
  cash?: number;
  /** When a `one-touch` pays: `'expiry'` (default) or `'hit'` (immediate). Not applicable to `no-touch`. */
  payAt?: 'expiry' | 'hit';
}

export interface TouchMonteCarloOptions extends MonteCarloSamplingOptions {
  /** Monitoring steps per path (default 100). */
  steps?: number;
}

function validateTouch(input: TouchInput, functionName: string): { q: number; cash: number } {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.barrier, 'barrier', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const cash = input.cash ?? 1;
  ensureFinite(cash, 'cash', functionName);
  return { q, cash };
}

/** Risk-neutral probability of touching `H` in `[0,T]` (continuous monitoring; assumes `S ≠ H`). */
interface TouchPricingState {
  spot: number;
  barrier: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}

interface TouchValueInput extends TouchPricingState {
  kind: TouchKind;
  payAt: TouchPayAt;
  cash: number;
}

function touchProbability(input: TouchPricingState): number {
  const {
    spot: S,
    barrier: H,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  const nu = r - q - 0.5 * sigma * sigma;
  const sT = sigma * Math.sqrt(T);
  const L = Math.log(H / S);
  const p =
    H < S
      ? N((L - nu * T) / sT) + Math.exp((2 * nu * L) / (sigma * sigma)) * N((L + nu * T) / sT)
      : N((-L + nu * T) / sT) + Math.exp((2 * nu * L) / (sigma * sigma)) * N((-L - nu * T) / sT);
  return Math.min(1, Math.max(0, p));
}

/** Reiner–Rubinstein one-touch value with the rebate paid AT the hit (assumes `S ≠ H`). */
function oneTouchAtHit(input: TouchPricingState & { cash: number }): number {
  const {
    spot: S,
    barrier: H,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    cash,
  } = input;
  const b = r - q;
  const mu = (b - 0.5 * sigma * sigma) / (sigma * sigma);
  // λ is the exponent of the first-passage Laplace transform E[e^{−rτ}]. Its discriminant goes
  // negative when a negative rate outruns the drift (r < 0 with a negative carry), and λ — with the
  // whole value — becomes NaN: the discounted rebate has no finite expectation, because discounting
  // at a negative rate GROWS the payoff faster than the hitting-time density decays.
  const discriminant = mu * mu + (2 * r) / (sigma * sigma);
  if (!(discriminant >= 0)) {
    throw new UnsupportedError(
      `touch.price: the pay-at-hit one-touch has no finite value at riskFreeRate=${r} with carry ` +
        `riskFreeRate − dividendYield=${b} — the first-passage discount exponent needs ` +
        `μ² + 2r/σ² ≥ 0 and here it is ${discriminant.toPrecision(6)} (μ=${mu.toPrecision(6)}, σ=${sigma}). ` +
        'Discounting at a negative rate grows the rebate faster than the hitting time can arrive, so ' +
        "E[e^{−rτ}·cash] diverges. Price the expiry-settled form instead (payAt: 'expiry', which is " +
        'bounded by cash·e^{−rT}), or use a non-negative riskFreeRate.',
      {
        code: ErrorCode.EngineUnsupportedContract,
        context: {
          engine: 'touch-one-touch',
          payAt: 'hit',
          riskFreeRate: r,
          dividendYield: q,
          carry: b,
          volatility: sigma,
          discriminant,
        },
      },
    );
  }
  const lambda = Math.sqrt(discriminant);
  const sT = sigma * Math.sqrt(T);
  const z = Math.log(H / S) / sT + lambda * sT;
  const eta = H < S ? 1 : -1;
  const value =
    Math.pow(H / S, mu + lambda) * N(eta * z) +
    Math.pow(H / S, mu - lambda) * N(eta * (z - 2 * lambda * sT));
  return cash * value;
}

/** Pure one-touch / no-touch value (shared by `touch.price` and the finite-difference `touch.greeks`). */
function touchValue(input: TouchValueInput): number {
  const { kind, payAt, spot: S, barrier: H, timeToExpiryYears: T, riskFreeRate: r, cash } = input;
  const df = Math.exp(-r * T);
  if (S === H) return kind === 'no-touch' ? 0 : payAt === 'hit' ? cash : cash * df;
  if (kind === 'one-touch') {
    return payAt === 'hit' ? oneTouchAtHit(input) : cash * df * touchProbability(input);
  }
  return cash * df * (1 - touchProbability(input));
}

/**
 * First-order greeks (package units) by central finite-difference of an exact barrier-binary value
 * `v(S, σ, T, r)`. The spot bump (`spotStep`) is chosen by the caller to never straddle a barrier; the σ/T bumps
 * are clamped so the bumped point stays valid. Used for the touch / double-touch binaries, whose analytic
 * greeks are a research-grade series — the exact prices are differenced instead, and the results are pinned
 * to the exact `one-touch + no-touch = cash·e^{−rT}` (and `DNT + DOT = cash·e^{−rT}`) greek identities.
 */
interface BarrierGreekState {
  spot: number;
  volatility: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
}

function fdBarrierGreeks(input: {
  price: (state: BarrierGreekState) => number;
  state: BarrierGreekState;
  spotBump: number;
}): Greeks {
  const { price: v, state, spotBump: spotStep } = input;
  const { spot: S, volatility: sigma, timeToExpiryYears: T, riskFreeRate: r } = state;
  const hVolatility = Math.min(1e-4, sigma * 0.5);
  const timeStepYears = Math.min(1e-4, T * 0.5);
  const rateStep = 1e-5;
  const p0 = v(state);
  const delta =
    (v({ ...state, spot: S + spotStep }) - v({ ...state, spot: S - spotStep })) / (2 * spotStep);
  const gamma =
    (v({ ...state, spot: S + spotStep }) - 2 * p0 + v({ ...state, spot: S - spotStep })) /
    (spotStep * spotStep);
  const vegaRaw =
    (v({ ...state, volatility: sigma + hVolatility }) -
      v({ ...state, volatility: sigma - hVolatility })) /
    (2 * hVolatility);
  const thetaPerYear =
    -(
      v({ ...state, timeToExpiryYears: T + timeStepYears }) -
      v({ ...state, timeToExpiryYears: T - timeStepYears })
    ) /
    (2 * timeStepYears);
  const rhoRaw =
    (v({ ...state, riskFreeRate: r + rateStep }) - v({ ...state, riskFreeRate: r - rateStep })) /
    (2 * rateStep);
  return {
    delta,
    gamma,
    theta: thetaPerYear / DAYS_PER_YEAR,
    vega: vegaRaw / 100,
    rho: rhoRaw / 100,
  };
}

const TOUCH_PRICE_SPEC = specOf('touch.price#0');
const TOUCH_GREEKS_SPEC = specOf('touch.greeks#0');
const TOUCH_MC_INPUT_SPEC = specOf('touch.monteCarloPrice#0');
const TOUCH_MC_OPTIONS_SPEC = specOf('touch.monteCarloPrice#1');

const TOUCH_EXAMPLE = (): string =>
  "touch.price({ kind: 'one-touch', spot: 100, barrier: 110, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 })";

export const touch = {
  /**
   * One-touch (pays if `H` is ever touched) / no-touch (pays if it never is), continuous monitoring.
   * `one-touch` settles at expiry by default or at the hit (`payAt: 'hit'`, Reiner–Rubinstein);
   * `no-touch` is always expiry-settled. An already-touched spot (`S = H`) short-circuits to the
   * certain payoff. See `docs/specs/digital-touch.md`.
   */
  price(input: TouchInput & { kind: TouchKind }): ExoticResult {
    const functionName = 'touch.price';
    validateClosedRequest(functionName, input, TOUCH_PRICE_SPEC, {
      exampleCall: TOUCH_EXAMPLE,
    });
    const { kind } = input;
    const { q, cash } = validateTouch(input, functionName);
    const payAt = input.payAt ?? 'expiry';
    if (kind === 'no-touch' && input.payAt === 'hit') {
      throw new InputError(
        `${functionName}: a no-touch settles at expiry — payAt: 'hit' is not applicable (there is no hit to pay on).`,
        { code: ErrorCode.InputInvalidEnum, context: { kind, payAt } },
      );
    }
    const { spot: S, barrier: H, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma } = input;
    const value = touchValue({
      kind,
      payAt,
      spot: S,
      barrier: H,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
      cash,
    });
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'touch', `touch-${kind}-${payAt}`),
      diagnostics: {
        engine: `touch-${kind}`,
        method: payAt === 'hit' ? 'reiner-rubinstein' : 'first-passage',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /**
   * First-order greeks (delta, gamma, vega, theta, rho) for the one-touch / no-touch binary, by central
   * finite-difference of the exact `touch.price` (the analytic greeks are a research-grade first-passage
   * series). Units match the package (vega/1%, theta/day, rho/1%; echoed in `assumptions.units`). The spot
   * bump is shrunk near the barrier so it never straddles it. Pinned to the exact identity that a one-touch
   * (pay-at-expiry) and a no-touch greek sum to the `cash·e^{−rT}` greeks. See `docs/specs/touch-greeks.md`.
   */
  greeks(input: TouchInput & { kind: TouchKind }): Computed<Greeks> {
    const functionName = 'touch.greeks';
    validateClosedRequest(functionName, input, TOUCH_GREEKS_SPEC, {
      exampleCall: TOUCH_EXAMPLE,
    });
    const { kind } = input;
    const { q, cash } = validateTouch(input, functionName);
    const payAt = input.payAt ?? 'expiry';
    if (kind === 'no-touch' && input.payAt === 'hit') {
      throw new InputError(
        `${functionName}: a no-touch settles at expiry — payAt: 'hit' is not applicable.`,
        { code: ErrorCode.InputInvalidEnum, context: { kind, payAt } },
      );
    }
    const { spot: S, barrier: H, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma } = input;
    // Keep the spot bump from straddling the barrier (the price is discontinuous in regime across H).
    const spotStep = Math.min(S * 1e-4, Math.abs(S - H) * 0.25) || S * 1e-6;
    const greeks = fdBarrierGreeks({
      price: ({ spot, volatility, timeToExpiryYears, riskFreeRate }) =>
        touchValue({
          kind,
          payAt,
          spot,
          barrier: H,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield: q,
          volatility,
          cash,
        }),
      state: { spot: S, volatility: sigma, timeToExpiryYears: T, riskFreeRate: r },
      spotBump: spotStep,
    });
    return {
      value: greeks,
      assumptions: {
        ...assumptions(input.timeToExpiryYears, q, 'touch', `touch-${kind}-${payAt}`),
        units: DEFAULT_GREEK_UNITS,
      },
      diagnostics: {
        engine: `touch-${kind}`,
        method: 'finite-difference',
        converged: Object.values(greeks).every((x) => Number.isFinite(x)),
        warnings: [],
      },
    };
  },

  /**
   * Monte-Carlo one-touch / no-touch. Pay-at-expiry reuses the Brownian-bridge survival so discrete
   * monitoring converges to the continuous analytic; pay-at-hit detects the first crossing on the grid
   * and discounts at the hit time.
   */
  monteCarloPrice(
    input: TouchInput & { kind: TouchKind },
    options: TouchMonteCarloOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'touch.monteCarloPrice';
    validateClosedRequest(functionName, input, TOUCH_MC_INPUT_SPEC, {
      exampleCall: TOUCH_EXAMPLE,
    });
    validateClosedRequest(functionName, options, TOUCH_MC_OPTIONS_SPEC, {
      exampleCall: TOUCH_EXAMPLE,
      argumentName: 'options',
    });
    const { kind } = input;
    const { q, cash } = validateTouch(input, functionName);
    const payAt = input.payAt ?? 'expiry';
    if (kind === 'no-touch' && input.payAt === 'hit') {
      throw new InputError(
        `${functionName}: a no-touch settles at expiry — payAt: 'hit' is not applicable.`,
        { code: ErrorCode.InputInvalidEnum, context: { kind, payAt } },
      );
    }
    const { spot: S, barrier: H, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma } = input;
    const steps = options.steps ?? 100;
    const timeStepYears = T / steps;
    const df = Math.exp(-r * T);
    const isDown = H < S;
    // Broadie–Glasserman–Kou continuity correction, β₁ = −ζ(1/2)/√(2π) = 0.5826: a barrier monitored
    // on a Δt grid behaves like a continuous barrier that is 0.5826·σ√Δt further away in log-space,
    // so the grid barrier is moved that far TOWARD the spot to reproduce the continuous price.
    const correctedBarrier =
      H * Math.exp((isDown ? 1 : -1) * 0.5826 * sigma * Math.sqrt(timeStepYears));

    const payoff = (z: number[]): number => {
      const path = gbmPathUnchecked({
        spot: S,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        timeToExpiryYears: T,
        shocks: z,
      });
      if (payAt === 'hit') {
        // one-touch only (no-touch@hit rejected above): discount the rebate at the first crossing.
        // The grid only SEES the barrier at monitoring dates, so it misses every excursion that
        // crosses and returns between them and under-prices the touch (>8 SE low at 500 steps). The
        // Broadie–Glasserman–Kou continuity correction is applied the same way the barrier engines
        // apply it: the tested barrier is shifted TOWARD the path by e^{±0.5826·σ√Δt}, which makes a
        // discretely-monitored crossing match the continuous first-passage probability.
        for (let k = 0; k <= steps; k++) {
          const x = path[k]!;
          if (isDown ? x <= correctedBarrier : x >= correctedBarrier)
            return cash * Math.exp(-r * k * timeStepYears);
        }
        return 0;
      }
      const surv = barrierSurvival({
        path,
        barrier: H,
        isDown,
        volatility: sigma,
        timeStepYears,
      });
      return df * cash * (kind === 'one-touch' ? 1 - surv : surv);
    };
    const est = monteCarloEstimate({
      dimensions: steps,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'touch', `touch-${kind}-${payAt}-mc`),
      diagnostics: {
        engine: `touch-${kind}`,
        method:
          payAt === 'hit'
            ? `monte-carlo-${est.method}-first-crossing`
            : `monte-carlo-${est.method}-brownian-bridge`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Forward-start options — strike set to α·S(t₁) at a future reset date
// ────────────────────────────────────────────────────────────────────────────

export interface ForwardStartInput {
  spot: number;
  /** Strike multiplier α: the strike is set to `α·S(t₁)` at the reset (α=1 ⇒ at-the-money-at-reset). Default 1. */
  strikeMultiplier?: number;
  /** Reset time `t₁` (years) at which the strike is fixed; must be in `(0, t)`. */
  resetTime: number;
  /** Expiry `T` (years). */
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
}

function validateForwardStart(
  input: ForwardStartInput,
  functionName: string,
): { q: number; alpha: number } {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  if (!(input.resetTime > 0 && input.resetTime < input.timeToExpiryYears)) {
    throw new InputError(
      `${functionName}: resetTime must be in (0, t); got resetTime=${input.resetTime}, t=${input.timeToExpiryYears}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { resetTime: input.resetTime, timeToExpiryYears: input.timeToExpiryYears },
      },
    );
  }
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const alpha = input.strikeMultiplier ?? 1;
  ensurePositive(alpha, 'strikeMultiplier', functionName);
  return { q, alpha };
}

/** Rubinstein (1991) forward-start price: `V = S·e^{−q·t₁}·φ`, with `φ` the fixed-moneyness BSM shape. */
function forwardStartAnalytic(input: {
  type: OptionType;
  spot: number;
  strikeMultiplier: number;
  resetTime: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}): number {
  const {
    type,
    spot: S,
    strikeMultiplier: alpha,
    resetTime: t1,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  const b = r - q;
  const tau = T - t1;
  const vol = sigma * Math.sqrt(tau);
  const d1 = (-Math.log(alpha) + (b + 0.5 * sigma * sigma) * tau) / vol;
  const d2 = d1 - vol;
  const phi =
    type === 'call'
      ? Math.exp(-q * tau) * N(d1) - alpha * Math.exp(-r * tau) * N(d2)
      : alpha * Math.exp(-r * tau) * N(-d2) - Math.exp(-q * tau) * N(-d1);
  return S * Math.exp(-q * t1) * phi;
}

const FORWARD_START_PRICE_SPEC = specOf('forwardStart.price#0');
const FORWARD_START_MC_INPUT_SPEC = specOf('forwardStart.monteCarloPrice#0');
const FORWARD_START_MC_OPTIONS_SPEC = specOf('forwardStart.monteCarloPrice#1');

const FORWARD_START_EXAMPLE = (): string =>
  "forwardStart.price({ type: 'call', spot: 100, resetTime: 0.1, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 })";

export const forwardStart = {
  /** Closed-form forward-start price (Rubinstein 1991); the value scales with today's spot. */
  price(input: ForwardStartInput & { type: OptionType }): ExoticResult {
    const functionName = 'forwardStart.price';
    validateClosedRequest(functionName, input, FORWARD_START_PRICE_SPEC, {
      exampleCall: FORWARD_START_EXAMPLE,
    });
    const { type } = input;
    const { q, alpha } = validateForwardStart(input, functionName);
    const value = forwardStartAnalytic({
      type,
      spot: input.spot,
      strikeMultiplier: alpha,
      resetTime: input.resetTime,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      dividendYield: q,
      volatility: input.volatility,
    });
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'forward-start', 'forward-start'),
      diagnostics: {
        engine: 'forward-start',
        method: 'rubinstein',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /** Two-step-GBM Monte-Carlo forward-start price (converges to the analytic). */
  monteCarloPrice(
    input: ForwardStartInput & { type: OptionType },
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'forwardStart.monteCarloPrice';
    validateClosedRequest(functionName, input, FORWARD_START_MC_INPUT_SPEC, {
      exampleCall: FORWARD_START_EXAMPLE,
    });
    validateClosedRequest(functionName, options, FORWARD_START_MC_OPTIONS_SPEC, {
      exampleCall: FORWARD_START_EXAMPLE,
      argumentName: 'options',
    });
    const { type } = input;
    const { q, alpha } = validateForwardStart(input, functionName);
    const {
      spot: S,
      resetTime: t1,
      timeToExpiryYears: T,
      riskFreeRate: r,
      volatility: sigma,
    } = input;
    const tau = T - t1;
    const df = Math.exp(-r * T);
    const payoff = (z: number[]): number => {
      const St1 = gbmTerminal({
        spot: S,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        timeToExpiryYears: t1,
        shock: z[0]!,
      });
      const ST = gbmTerminal({
        spot: St1,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        timeToExpiryYears: tau,
        shock: z[1]!,
      });
      const K = alpha * St1;
      const intrinsic = type === 'call' ? Math.max(ST - K, 0) : Math.max(K - ST, 0);
      return df * intrinsic;
    };
    const est = monteCarloEstimate({
      dimensions: 2,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'forward-start', 'forward-start-mc'),
      diagnostics: {
        engine: 'forward-start',
        method: `monte-carlo-${est.method}`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Cliquet / ratchet options — a capped strip of forward-start caplets
// ────────────────────────────────────────────────────────────────────────────

export interface CliquetInput {
  spot: number;
  /** Reset times `t₁…tₙ` (years, strictly increasing, > 0); `t₀ = 0` (today), `tₙ = maturity`. */
  resetTimes: number[];
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** Per-period return floor; default 0 (lock in non-negative gains). Must be ≥ −1. */
  localFloor?: number;
  /** Per-period return cap; default `+∞` (uncapped). Must be > `localFloor`. */
  localCap?: number;
  /** Global (summed) floor; default `−∞`. Requires `monteCarloPrice`. */
  globalFloor?: number;
  /** Global (summed) cap; default `+∞`. Requires `monteCarloPrice`. */
  globalCap?: number;
  /** Notional multiplier; default 1. */
  notional?: number;
}

interface CliquetResolved {
  q: number;
  localFloor: number;
  localCap: number;
  globalFloor: number;
  globalCap: number;
  notional: number;
  periods: number[]; // τᵢ per period (from t₀=0)
  maturity: number;
}

function validateCliquet(input: CliquetInput, functionName: string): CliquetResolved {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  requireArgumentArray(functionName, 'resetTimes', input.resetTimes as unknown);
  const rt = input.resetTimes;
  if (rt.length < 1) {
    throw new InputError(`${functionName}: at least one reset time is required.`, {
      code: ErrorCode.InputOutOfRange,
      context: { resets: rt.length },
    });
  }
  const periods: number[] = [];
  let prev = 0;
  for (let i = 0; i < rt.length; i++) {
    ensureFinite(rt[i]!, `resetTimes[${i}]`, functionName);
    if (!(rt[i]! > prev)) {
      throw new InputError(
        `${functionName}: resetTimes must be strictly increasing and > 0; resetTimes[${i}] = ${rt[i]} ≤ ${prev}.`,
        { code: ErrorCode.InputOutOfRange, context: { index: i, value: rt[i], previous: prev } },
      );
    }
    periods.push(rt[i]! - prev);
    prev = rt[i]!;
  }
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const localFloor = input.localFloor ?? 0;
  const localCap = input.localCap ?? Infinity;
  ensureFinite(localFloor, 'localFloor', functionName);
  if (!(localFloor >= -1)) {
    throw new InputError(
      `${functionName}: localFloor must be ≥ −1 (a return can't fall below −100%); got ${localFloor}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { localFloor },
      },
    );
  }
  if (!(localCap > localFloor)) {
    throw new InputError(
      `${functionName}: localCap must exceed localFloor; got cap ${localCap}, floor ${localFloor}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { localCap, localFloor },
      },
    );
  }
  const globalFloor = input.globalFloor ?? -Infinity;
  const globalCap = input.globalCap ?? Infinity;
  if (!(globalCap > globalFloor)) {
    throw new InputError(
      `${functionName}: globalCap must exceed globalFloor; got cap ${globalCap}, floor ${globalFloor}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { globalCap, globalFloor },
      },
    );
  }
  const notional = input.notional ?? 1;
  ensureFinite(notional, 'notional', functionName);
  return {
    q,
    localFloor,
    localCap,
    globalFloor,
    globalCap,
    notional,
    periods,
    maturity: prev,
  };
}

/** `E[max(R − K′, 0)]` for the period return `R` (Black-76 on the forward return `e^{b·τ}`). */
function returnCaplet(input: {
  strike: number;
  period: number;
  carryRate: number;
  volatility: number;
}): number {
  const { strike, period: tau, carryRate: b, volatility: sigma } = input;
  if (!Number.isFinite(strike)) return 0; // an infinite (uncapped) strike contributes nothing
  const forward = Math.exp(b * tau);
  const vol = sigma * Math.sqrt(tau);
  const d1 = (Math.log(forward / strike) + 0.5 * sigma * sigma * tau) / vol;
  const d2 = d1 - vol;
  return forward * N(d1) - strike * N(d2);
}

const CLIQUET_PRICE_SPEC = specOf('cliquet.price#0');
const CLIQUET_MC_INPUT_SPEC = specOf('cliquet.monteCarloPrice#0');
const CLIQUET_MC_OPTIONS_SPEC = specOf('cliquet.monteCarloPrice#1');

const CLIQUET_EXAMPLE = (): string =>
  'cliquet.price({ spot: 100, resetTimes: [0.25, 0.5, 0.75, 1], riskFreeRate: 0.04, volatility: 0.2 })';

export const cliquet = {
  /**
   * Closed-form cliquet (a strip of forward-start caplets), valid when there is NO global cap/floor —
   * the value is then the discounted sum of the per-period expected clipped returns (Black-76 on each
   * period return). A global cap/floor makes the total path-dependent; this throws and points to
   * `monteCarloPrice`. See `docs/specs/cliquet.md`.
   */
  price(input: CliquetInput): ExoticResult {
    const functionName = 'cliquet.price';
    validateClosedRequest(functionName, input, CLIQUET_PRICE_SPEC, {
      exampleCall: CLIQUET_EXAMPLE,
    });
    const c = validateCliquet(input, functionName);
    if (Number.isFinite(c.globalFloor) || Number.isFinite(c.globalCap)) {
      throw new UnsupportedError(
        `${functionName}: a globalFloor/globalCap makes the summed payoff path-dependent — the closed form does not apply. Use cliquet.monteCarloPrice.`,
        {
          code: ErrorCode.EngineUnsupportedContract,
          context: { globalFloor: c.globalFloor, globalCap: c.globalCap },
        },
      );
    }
    const b = input.riskFreeRate - c.q;
    let sumExpected = 0;
    for (const tau of c.periods) {
      // E[clip(rᵢ, lf, lc)] = lf + caplet(1+lf) − caplet(1+lc).
      sumExpected +=
        c.localFloor +
        returnCaplet({
          strike: 1 + c.localFloor,
          period: tau,
          carryRate: b,
          volatility: input.volatility,
        }) -
        returnCaplet({
          strike: 1 + c.localCap,
          period: tau,
          carryRate: b,
          volatility: input.volatility,
        });
    }
    const value = Math.exp(-input.riskFreeRate * c.maturity) * c.notional * sumExpected;
    return {
      value,
      assumptions: assumptions(c.maturity, c.q, 'cliquet', 'cliquet'),
      diagnostics: {
        engine: 'cliquet',
        method: 'black76-caplet-strip',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /** General Monte-Carlo cliquet (local + global caps/floors); converges to the analytic in the no-global case. */
  monteCarloPrice(input: CliquetInput, options: MonteCarloSamplingOptions): ExoticMonteCarloResult {
    const functionName = 'cliquet.monteCarloPrice';
    validateClosedRequest(functionName, input, CLIQUET_MC_INPUT_SPEC, {
      exampleCall: CLIQUET_EXAMPLE,
    });
    validateClosedRequest(functionName, options, CLIQUET_MC_OPTIONS_SPEC, {
      exampleCall: CLIQUET_EXAMPLE,
      argumentName: 'options',
    });
    const c = validateCliquet(input, functionName);
    const { spot: S, riskFreeRate: r, volatility: sigma } = input;
    const df = Math.exp(-r * c.maturity);
    const payoff = (z: number[]): number => {
      let acc = 0;
      let prevSpot = S;
      for (let i = 0; i < c.periods.length; i++) {
        const next = gbmTerminal({
          spot: prevSpot,
          riskFreeRate: r,
          dividendYield: c.q,
          volatility: sigma,
          timeToExpiryYears: c.periods[i]!,
          shock: z[i]!,
        });
        const ret = next / prevSpot - 1;
        acc += Math.min(c.localCap, Math.max(c.localFloor, ret));
        prevSpot = next;
      }
      const total = Math.min(c.globalCap, Math.max(c.globalFloor, acc));
      return df * c.notional * total;
    };
    const est = monteCarloEstimate({
      dimensions: c.periods.length,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(c.maturity, c.q, 'cliquet', 'cliquet-mc'),
      diagnostics: {
        engine: 'cliquet',
        method: `monte-carlo-${est.method}`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Napoleon & reverse cliquet — coupon-degraded cliquet structures (short vol)
// ────────────────────────────────────────────────────────────────────────────

/** Input for {@link napoleon} and {@link reverseCliquet} (same shape; the coupon is degraded differently). */
export interface NapoleonInput {
  spot: number;
  /** Reset times `t₁…tₙ` (years, strictly increasing, > 0); `t₀ = 0` (today), `tₙ = maturity`. */
  resetTimes: number[];
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** The fixed coupon degraded by the period returns. */
  coupon: number;
  /** Floor on the payoff. Default 0 (the note cannot pay less than 0). */
  globalFloor?: number;
  /** Notional multiplier. Default 1. */
  notional?: number;
}

/** Reverse cliquet takes the same inputs as {@link napoleon}; the coupon is degraded by `Σ min(rᵢ, 0)`. */
export type ReverseCliquetInput = NapoleonInput;

interface NapoleonResolved {
  q: number;
  coupon: number;
  globalFloor: number;
  notional: number;
  periods: number[];
  maturity: number;
}

function validateNapoleon(input: NapoleonInput, functionName: string): NapoleonResolved {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  ensureFinite(input.coupon, 'coupon', functionName);
  requireArgumentArray(functionName, 'resetTimes', input.resetTimes as unknown);
  const rt = input.resetTimes;
  if (rt.length < 1) {
    throw new InputError(`${functionName}: at least one reset time is required.`, {
      code: ErrorCode.InputOutOfRange,
      context: { resets: rt.length },
    });
  }
  const periods: number[] = [];
  let prev = 0;
  for (let i = 0; i < rt.length; i++) {
    ensureFinite(rt[i]!, `resetTimes[${i}]`, functionName);
    if (!(rt[i]! > prev)) {
      throw new InputError(
        `${functionName}: resetTimes must be strictly increasing and > 0; resetTimes[${i}] = ${rt[i]} ≤ ${prev}.`,
        { code: ErrorCode.InputOutOfRange, context: { index: i, value: rt[i], previous: prev } },
      );
    }
    periods.push(rt[i]! - prev);
    prev = rt[i]!;
  }
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const globalFloor = input.globalFloor ?? 0;
  // −Infinity is the "unfloored" note (the closed-form floorlessValue case); reject +Infinity / NaN.
  if (globalFloor !== -Infinity) ensureFinite(globalFloor, 'globalFloor', functionName);
  const notional = input.notional ?? 1;
  ensureFinite(notional, 'notional', functionName);
  return { q, coupon: input.coupon, globalFloor, notional, periods, maturity: prev };
}

const NAPOLEON_MC_INPUT_SPEC = specOf('napoleon.monteCarloPrice#0');
const NAPOLEON_MC_OPTIONS_SPEC = specOf('napoleon.monteCarloPrice#1');

const NAPOLEON_EXAMPLE = (): string =>
  'napoleon.monteCarloPrice({ spot: 100, resetTimes: [0.25, 0.5, 0.75, 1], riskFreeRate: 0.04, volatility: 0.2, coupon: 0.08 }, { paths: 20000, seed: 42 })';

export const napoleon = {
  /**
   * Napoleon option: pays the coupon plus the **single worst** period return, `max(floor, C + minᵢ rᵢ)`.
   * The investor is SHORT the volatility of the minimum return — a higher `volatility` LOWERS the value. No clean
   * closed form (the minimum of `n` dependent lognormals), so Monte-Carlo only. See
   * `docs/specs/napoleon-reverse-cliquet.md`.
   */
  monteCarloPrice(
    input: NapoleonInput,
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'napoleon.monteCarloPrice';
    validateClosedRequest(functionName, input, NAPOLEON_MC_INPUT_SPEC, {
      exampleCall: NAPOLEON_EXAMPLE,
    });
    validateClosedRequest(functionName, options, NAPOLEON_MC_OPTIONS_SPEC, {
      exampleCall: NAPOLEON_EXAMPLE,
      argumentName: 'options',
    });
    const c = validateNapoleon(input, functionName);
    const { spot: S, riskFreeRate: r, volatility: sigma } = input;
    const df = Math.exp(-r * c.maturity);
    const payoff = (z: number[]): number => {
      let prevSpot = S;
      let worst = Infinity;
      for (let i = 0; i < c.periods.length; i++) {
        const next = gbmTerminal({
          spot: prevSpot,
          riskFreeRate: r,
          dividendYield: c.q,
          volatility: sigma,
          timeToExpiryYears: c.periods[i]!,
          shock: z[i]!,
        });
        worst = Math.min(worst, next / prevSpot - 1);
        prevSpot = next;
      }
      return df * c.notional * Math.max(c.globalFloor, c.coupon + worst);
    };
    const est = monteCarloEstimate({
      dimensions: c.periods.length,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(c.maturity, c.q, 'napoleon', 'napoleon-mc'),
      diagnostics: {
        engine: 'napoleon',
        method: `monte-carlo-${est.method}-short-worst-return-vol`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

const REVERSE_CLIQUET_MC_INPUT_SPEC = specOf('reverseCliquet.monteCarloPrice#0');
const REVERSE_CLIQUET_MC_OPTIONS_SPEC = specOf('reverseCliquet.monteCarloPrice#1');
const REVERSE_CLIQUET_FLOORLESS_SPEC = specOf('reverseCliquet.floorlessValue#0');

const REVERSE_CLIQUET_EXAMPLE = (): string =>
  'reverseCliquet.floorlessValue({ spot: 100, resetTimes: [0.25, 0.5, 0.75, 1], riskFreeRate: 0.04, volatility: 0.2, coupon: 0.08 })';

export const reverseCliquet = {
  /**
   * Reverse cliquet: pays the coupon eroded by the **sum of the negative** period returns,
   * `max(floor, C + Σᵢ min(rᵢ, 0))`. Up-periods don't help, down-periods subtract — the investor is short
   * downside vol, so a higher `volatility` LOWERS the value. Path-dependent (the floored sum) ⇒ Monte-Carlo. See
   * `docs/specs/napoleon-reverse-cliquet.md`.
   */
  monteCarloPrice(
    input: ReverseCliquetInput,
    options: MonteCarloSamplingOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'reverseCliquet.monteCarloPrice';
    validateClosedRequest(functionName, input, REVERSE_CLIQUET_MC_INPUT_SPEC, {
      exampleCall: REVERSE_CLIQUET_EXAMPLE,
    });
    validateClosedRequest(functionName, options, REVERSE_CLIQUET_MC_OPTIONS_SPEC, {
      exampleCall: REVERSE_CLIQUET_EXAMPLE,
      argumentName: 'options',
    });
    const c = validateNapoleon(input, functionName);
    const { spot: S, riskFreeRate: r, volatility: sigma } = input;
    const df = Math.exp(-r * c.maturity);
    const payoff = (z: number[]): number => {
      let prevSpot = S;
      let acc = 0;
      for (let i = 0; i < c.periods.length; i++) {
        const next = gbmTerminal({
          spot: prevSpot,
          riskFreeRate: r,
          dividendYield: c.q,
          volatility: sigma,
          timeToExpiryYears: c.periods[i]!,
          shock: z[i]!,
        });
        acc += Math.min(next / prevSpot - 1, 0);
        prevSpot = next;
      }
      return df * c.notional * Math.max(c.globalFloor, c.coupon + acc);
    };
    const est = monteCarloEstimate({
      dimensions: c.periods.length,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(c.maturity, c.q, 'reverse-cliquet', 'reverse-cliquet-mc'),
      diagnostics: {
        engine: 'reverse-cliquet',
        method: `monte-carlo-${est.method}-short-downside-vol`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },

  /**
   * Closed-form reverse-cliquet value **ignoring the global floor**: `df·notional·(C + Σᵢ E[min(rᵢ, 0)])`,
   * with `E[min(rᵢ, 0)] = (e^{b·τᵢ} − 1) − returnCaplet(1, τᵢ, b, σ)` (reusing the cliquet caplet). Exact for
   * an unfloored note (`globalFloor = −∞`) and a fast lower bound for the floored one (large coupon ⇒ the
   * floor rarely binds ⇒ this ≈ the MC price). See `docs/specs/napoleon-reverse-cliquet.md`.
   */
  floorlessValue(input: ReverseCliquetInput): ExoticResult {
    const functionName = 'reverseCliquet.floorlessValue';
    validateClosedRequest(functionName, input, REVERSE_CLIQUET_FLOORLESS_SPEC, {
      exampleCall: REVERSE_CLIQUET_EXAMPLE,
    });
    const c = validateNapoleon(input, functionName);
    const b = input.riskFreeRate - c.q;
    let expectedNeg = 0;
    for (const tau of c.periods) {
      // E[min(r,0)] = E[r] − E[max(r,0)] = (e^{bτ} − 1) − returnCaplet(1, τ, b, σ).
      expectedNeg +=
        Math.exp(b * tau) -
        1 -
        returnCaplet({ strike: 1, period: tau, carryRate: b, volatility: input.volatility });
    }
    const value =
      Math.exp(-input.riskFreeRate * c.maturity) * c.notional * (c.coupon + expectedNeg);
    return {
      value,
      assumptions: assumptions(c.maturity, c.q, 'reverse-cliquet', 'reverse-cliquet-floorless'),
      diagnostics: {
        engine: 'reverse-cliquet',
        method: 'closed-form-floorless-caplet-strip',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Double one-touch / double no-touch — corridor binaries on two barriers
// ────────────────────────────────────────────────────────────────────────────

export type DoubleTouchKind = 'double-no-touch' | 'double-one-touch';

export interface DoubleTouchInput {
  spot: number;
  /** Lower barrier `L` (> 0). */
  lower: number;
  /** Upper barrier `U` (> L). */
  upper: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  volatility: number;
  dividendYield?: number;
  /** Payout on the winning outcome; default 1. */
  cash?: number;
}

function validateDoubleTouch(
  input: DoubleTouchInput,
  functionName: string,
): { q: number; cash: number } {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.lower, 'lower', functionName);
  ensurePositive(input.upper, 'upper', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  if (!(input.lower < input.upper)) {
    throw new InputError(
      `${functionName}: require lower < upper (got lower=${input.lower}, upper=${input.upper}).`,
      { code: ErrorCode.InputOutOfRange, context: { lower: input.lower, upper: input.upper } },
    );
  }
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const cash = input.cash ?? 1;
  ensureFinite(cash, 'cash', functionName);
  return { q, cash };
}

/**
 * Risk-neutral probability that `S_t ∈ (L, U)` for all `t ∈ [0, T]` (continuous monitoring), via the
 * method-of-images series: source images at `2n·d` and sink images at `2b + 2n·d` (`a = ln(L/S)`,
 * `b = ln(U/S)`, `d = b − a`). Converges geometrically; `|n| ≤ 25` is far past machine precision for
 * realistic corridors. Assumes the spot starts strictly inside the corridor.
 */
interface DoubleTouchPricingState {
  spot: number;
  lower: number;
  upper: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
}

function doubleBarrierSurvival(input: DoubleTouchPricingState): number {
  const {
    spot: S,
    lower: L,
    upper: U,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
  } = input;
  const a = Math.log(L / S);
  const b = Math.log(U / S);
  const nu = r - q - 0.5 * sigma * sigma;
  const sT = sigma * Math.sqrt(T);
  const d = b - a;
  const v2 = sigma * sigma;
  const term = (c: number): number =>
    Math.exp((nu * c) / v2) * (N((b - c - nu * T) / sT) - N((a - c - nu * T) / sT));
  let p = 0;
  for (let n = -25; n <= 25; n++) p += term(2 * n * d) - term(2 * b + 2 * n * d);
  return Math.min(1, Math.max(0, p));
}

/** Pure double-no-touch / double-one-touch value (shared by `doubleTouch.price` and `doubleTouch.greeks`). */
function doubleTouchValue(
  input: DoubleTouchPricingState & { kind: DoubleTouchKind; cash: number },
): number {
  const { kind, spot: S, lower: L, upper: U, timeToExpiryYears: T, riskFreeRate: r, cash } = input;
  const df = Math.exp(-r * T);
  const survival = S <= L || S >= U ? 0 : doubleBarrierSurvival(input);
  return cash * df * (kind === 'double-no-touch' ? survival : 1 - survival);
}

const DOUBLE_TOUCH_PRICE_SPEC = specOf('doubleTouch.price#0');
const DOUBLE_TOUCH_GREEKS_SPEC = specOf('doubleTouch.greeks#0');
const DOUBLE_TOUCH_MC_INPUT_SPEC = specOf('doubleTouch.monteCarloPrice#0');
const DOUBLE_TOUCH_MC_OPTIONS_SPEC = specOf('doubleTouch.monteCarloPrice#1');

const DOUBLE_TOUCH_EXAMPLE = (): string =>
  "doubleTouch.price({ kind: 'double-no-touch', spot: 100, lower: 90, upper: 115, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 })";

export const doubleTouch = {
  /**
   * Double no-touch (pays if `S` stays in `(L, U)` the whole life) / double one-touch (pays if it ever
   * leaves), continuous monitoring, settled at expiry. The image-series survival `P_stay` drives both:
   * `DNT = cash·e^{−rT}·P_stay`, `DOT = cash·e^{−rT}·(1 − P_stay)`, so `DNT + DOT = cash·e^{−rT}`. A spot
   * already outside the corridor short-circuits (DNT = 0, DOT = cash·e^{−rT}). See
   * `docs/specs/double-touch.md`.
   */
  price(input: DoubleTouchInput & { kind: DoubleTouchKind }): ExoticResult {
    const functionName = 'doubleTouch.price';
    validateClosedRequest(functionName, input, DOUBLE_TOUCH_PRICE_SPEC, {
      exampleCall: DOUBLE_TOUCH_EXAMPLE,
    });
    const { kind } = input;
    const { q, cash } = validateDoubleTouch(input, functionName);
    const {
      spot: S,
      lower: L,
      upper: U,
      timeToExpiryYears: T,
      riskFreeRate: r,
      volatility: sigma,
    } = input;
    const breached = S <= L || S >= U;
    const value = doubleTouchValue({
      kind,
      spot: S,
      lower: L,
      upper: U,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
      cash,
    });
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'double-touch', `double-touch-${kind}`),
      diagnostics: {
        engine: `double-touch-${kind}`,
        method: breached ? 'already-breached' : 'method-of-images',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /**
   * First-order greeks (delta, gamma, vega, theta, rho) for the double-no-touch / double-one-touch corridor
   * binary, by central finite-difference of the exact `doubleTouch.price` (the image-series precludes clean
   * analytic greeks). Units match the package (vega/1%, theta/day, rho/1%; echoed in `assumptions.units`).
   * The spot bump is shrunk near either barrier so it never straddles the corridor edge. Pinned to the exact
   * `DNT + DOT = cash·e^{−rT}` greek identity. See `docs/specs/touch-greeks.md`.
   */
  greeks(input: DoubleTouchInput & { kind: DoubleTouchKind }): Computed<Greeks> {
    const functionName = 'doubleTouch.greeks';
    validateClosedRequest(functionName, input, DOUBLE_TOUCH_GREEKS_SPEC, {
      exampleCall: DOUBLE_TOUCH_EXAMPLE,
    });
    const { kind } = input;
    const { q, cash } = validateDoubleTouch(input, functionName);
    const {
      spot: S,
      lower: L,
      upper: U,
      timeToExpiryYears: T,
      riskFreeRate: r,
      volatility: sigma,
    } = input;
    // Keep the spot bump inside the corridor (the value is discontinuous in regime across L and U); floor it
    // positive so a breached spot (S ≤ L or S ≥ U, where the distances go non-positive) still bumps validly.
    const spotStep = Math.max(S * 1e-6, Math.min(S * 1e-4, (S - L) * 0.25, (U - S) * 0.25));
    const greeks = fdBarrierGreeks({
      price: ({ spot, volatility, timeToExpiryYears, riskFreeRate }) =>
        doubleTouchValue({
          kind,
          spot,
          lower: L,
          upper: U,
          timeToExpiryYears,
          riskFreeRate,
          dividendYield: q,
          volatility,
          cash,
        }),
      state: { spot: S, volatility: sigma, timeToExpiryYears: T, riskFreeRate: r },
      spotBump: spotStep,
    });
    return {
      value: greeks,
      assumptions: {
        ...assumptions(input.timeToExpiryYears, q, 'double-touch', `double-touch-${kind}`),
        units: DEFAULT_GREEK_UNITS,
      },
      diagnostics: {
        engine: `double-touch-${kind}`,
        method: 'finite-difference',
        converged: Object.values(greeks).every((x) => Number.isFinite(x)),
        warnings: [],
      },
    };
  },

  /**
   * Monte-Carlo double-no-touch / double-one-touch. The corridor survival per path is the product of the
   * two single-barrier Brownian-bridge survivals (lower down × upper up), so discrete monitoring converges
   * to the continuous analytic.
   */
  monteCarloPrice(
    input: DoubleTouchInput & { kind: DoubleTouchKind },
    options: TouchMonteCarloOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'doubleTouch.monteCarloPrice';
    validateClosedRequest(functionName, input, DOUBLE_TOUCH_MC_INPUT_SPEC, {
      exampleCall: DOUBLE_TOUCH_EXAMPLE,
    });
    validateClosedRequest(functionName, options, DOUBLE_TOUCH_MC_OPTIONS_SPEC, {
      exampleCall: DOUBLE_TOUCH_EXAMPLE,
      argumentName: 'options',
    });
    const { kind } = input;
    const { q, cash } = validateDoubleTouch(input, functionName);
    const {
      spot: S,
      lower: L,
      upper: U,
      timeToExpiryYears: T,
      riskFreeRate: r,
      volatility: sigma,
    } = input;
    const steps = options.steps ?? 100;
    const timeStepYears = T / steps;
    const df = Math.exp(-r * T);

    const payoff = (z: number[]): number => {
      const path = gbmPathUnchecked({
        spot: S,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        timeToExpiryYears: T,
        shocks: z,
      });
      const surv =
        barrierSurvival({
          path,
          barrier: L,
          isDown: true,
          volatility: sigma,
          timeStepYears,
        }) *
        barrierSurvival({
          path,
          barrier: U,
          isDown: false,
          volatility: sigma,
          timeStepYears,
        });
      return df * cash * (kind === 'double-no-touch' ? surv : 1 - surv);
    };
    const est = monteCarloEstimate({
      dimensions: steps,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(
        input.timeToExpiryYears,
        q,
        'double-touch',
        `double-touch-${kind}-mc`,
      ),
      diagnostics: {
        engine: `double-touch-${kind}`,
        method: `monte-carlo-${est.method}-brownian-bridge`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Composite (compo) option — foreign asset × floating FX, domestic strike
// ────────────────────────────────────────────────────────────────────────────

/** Input for the {@link compo} composite option. */
export interface CompoInput {
  /** Foreign-asset spot (in foreign currency). */
  spot: number;
  /** FX rate — units of domestic currency per unit of foreign (`X₀`). */
  fxSpot: number;
  /** Strike, in DOMESTIC currency. */
  strike: number;
  timeToExpiryYears: number;
  /** Domestic discount / growth rate. */
  domesticRate: number;
  /** Foreign-asset volatility `σ_S`. */
  volatility: number;
  /** FX volatility `σ_X`. */
  fxVolatility: number;
  /** Correlation between the asset and the FX rate, in `[−1, 1]`. */
  correlation: number;
  /** Foreign dividend yield `q`. Default 0. */
  dividendYield?: number;
}

/** The compo's multi-factor risk. */
export interface CompoGreeks {
  /** `∂C/∂S_f` — foreign-asset delta. */
  assetDelta: number;
  /** `∂C/∂X` — FX delta. */
  fxDelta: number;
  /** `∂²C/∂S_f²` — foreign-asset gamma. */
  assetGamma: number;
  /** `∂C/∂σ_S`, per vol point. */
  assetVega: number;
  /** `∂C/∂σ_X`, per vol point. */
  fxVega: number;
  /** `∂C/∂ρ`, per 0.01 of correlation — the distinctive compo greek (long correlation). */
  correlationVega: number;
  /** Per calendar day. */
  theta: number;
  /** Domestic, per 1% rate. */
  rho: number;
}

/** Monte-Carlo options for {@link compo.monteCarloPrice}. */
export interface CompoMonteCarloOptions extends MonteCarloSamplingOptions {
  /** Foreign rate used only to split the two-factor drift; the price is invariant to it. Default = `domesticRate`. */
  foreignRate?: number;
}

/** Validate a compo input and return the composite spot `A₀`, composite vol `σ_A`, and yield `q`. */
function resolveCompo(
  input: CompoInput,
  functionName: string,
): { A0: number; sigA: number; q: number } {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.fxSpot, 'fxSpot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureNonNegativeVolatility(input.fxVolatility, 'fxVolatility', functionName);
  ensureFinite(input.domesticRate, 'domesticRate', functionName);
  requireCorrelation(input.correlation, functionName);
  const q = input.dividendYield ?? 0;
  ensureFinite(q, 'dividendYield', functionName);
  const { volatility: sigS, fxVolatility: sigX, correlation: rho } = input;
  const varA = sigS * sigS + sigX * sigX + 2 * rho * sigS * sigX;
  const sigA = Math.sqrt(Math.max(0, varA));
  if (!(sigA > 0)) {
    throw new InputError(
      `${functionName}: the composite volatility is zero (the asset and FX perfectly offset: ρ = ${rho}, σ_S = ${sigS}, σ_X = ${sigX}) — the composite is riskless, price it as a domestic forward.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { correlation: rho, assetVolatility: sigS, fxVolatility: sigX },
      },
    );
  }
  return { A0: input.spot * input.fxSpot, sigA, q };
}

const COMPO_PRICE_SPEC = specOf('compo.price#0');
const COMPO_GREEKS_SPEC = specOf('compo.greeks#0');
const COMPO_MC_INPUT_SPEC = specOf('compo.monteCarloPrice#0');
const COMPO_MC_OPTIONS_SPEC = specOf('compo.monteCarloPrice#1');

const COMPO_EXAMPLE = (): string =>
  "compo.price({ type: 'call', spot: 50, fxSpot: 1.1, strike: 60, timeToExpiryYears: 0.25, domesticRate: 0.04, volatility: 0.2, fxVolatility: 0.1, correlation: 0.3 })";

export const compo = {
  /**
   * Composite option paying `(S_f(T)·X(T) − K_d)⁺` in domestic currency — the foreign asset at the
   * FLOATING FX rate against a domestic strike. The domestic value `A = S_f·X` is a domestic asset
   * drifting at `r_d − q`, so this is exactly `BSM(A₀ = S_f·X, K_d, T, r_d, q, σ_A)` with the composite
   * vol `σ_A = √(σ_S² + σ_X² + 2ρσ_Sσ_X)`. The foreign rate drops out. See `docs/specs/compo-option.md`.
   */
  price(input: CompoInput & { type: OptionType }): ExoticResult {
    const functionName = 'compo.price';
    validateClosedRequest(functionName, input, COMPO_PRICE_SPEC, { exampleCall: COMPO_EXAMPLE });
    const { type } = input;
    const { A0, sigA, q } = resolveCompo(input, functionName);
    const value = blackScholesPrice({
      type,
      spot: A0,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.domesticRate,
      dividendYield: q,
      volatility: sigA,
    });
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'compo', 'compo'),
      diagnostics: {
        engine: 'compo',
        method: 'closed-form',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /**
   * The compo's multi-factor risk: foreign-asset and FX deltas, foreign-asset gamma, the asset and FX
   * vegas, the **correlation vega** (a compo is long correlation), plus theta and domestic rho — all
   * exact chain-rule derivatives of the composite BSM greeks through `A₀ = S_f·X` and `σ_A`.
   */
  greeks(input: CompoInput & { type: OptionType }): Computed<CompoGreeks> {
    const functionName = 'compo.greeks';
    validateClosedRequest(functionName, input, COMPO_GREEKS_SPEC, { exampleCall: COMPO_EXAMPLE });
    const { type } = input;
    const { A0, sigA, q } = resolveCompo(input, functionName);
    const { spot: S, fxSpot: X, volatility: sigS, fxVolatility: sigX, correlation: rho } = input;
    const bg = blackScholesGreeks({
      type,
      spot: A0,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.domesticRate,
      dividendYield: q,
      volatility: sigA,
    });
    const greeks: CompoGreeks = {
      assetDelta: bg.delta * X,
      fxDelta: bg.delta * S,
      assetGamma: bg.gamma * X * X,
      assetVega: bg.vega * ((sigS + rho * sigX) / sigA),
      fxVega: bg.vega * ((sigX + rho * sigS) / sigA),
      correlationVega: bg.vega * ((sigS * sigX) / sigA),
      theta: bg.theta,
      rho: bg.rho,
    };
    return {
      value: greeks,
      assumptions: {
        ...assumptions(input.timeToExpiryYears, q, 'compo', 'compo'),
        units: DEFAULT_GREEK_UNITS,
      },
      diagnostics: {
        engine: 'compo',
        method: 'closed-form-greeks',
        converged: Object.values(greeks).every((x) => Number.isFinite(x)),
        warnings: [],
      },
    };
  },

  /**
   * Two-factor Monte-Carlo: simulate `S_f` and `X` as correlated GBMs under the domestic measure and
   * price `(S_f(T)·X(T) − K)⁺` discounted at `r_d`. Converges to the closed form, corroborating the `σ_A`
   * combination. `options.foreignRate` (default `domesticRate`) only splits the two drifts — the price is
   * invariant to it.
   */
  monteCarloPrice(
    input: CompoInput & { type: OptionType },
    options: CompoMonteCarloOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'compo.monteCarloPrice';
    validateClosedRequest(functionName, input, COMPO_MC_INPUT_SPEC, {
      exampleCall: COMPO_EXAMPLE,
    });
    validateClosedRequest(functionName, options, COMPO_MC_OPTIONS_SPEC, {
      exampleCall: COMPO_EXAMPLE,
      argumentName: 'options',
    });
    const { type } = input;
    const { q } = resolveCompo(input, functionName);
    const {
      spot: S,
      fxSpot: X,
      strike: K,
      timeToExpiryYears: T,
      domesticRate: rd,
      volatility: sigS,
      fxVolatility: sigX,
      correlation: rho,
    } = input;
    const rf = options.foreignRate ?? rd;
    ensureFinite(rf, 'foreignRate', functionName);
    const sq = Math.sqrt(T);
    const df = Math.exp(-rd * T);
    // Q_d drifts: S_f at (r_f − q − ρσ_Sσ_X), X at (r_d − r_f).
    const drift1 = (rf - q - rho * sigS * sigX - 0.5 * sigS * sigS) * T;
    const drift2 = (rd - rf - 0.5 * sigX * sigX) * T;
    const payoff = (z: number[]): number => {
      const w1 = z[0]!;
      const w2 = rho * z[0]! + Math.sqrt(1 - rho * rho) * z[1]!;
      const sT = S * Math.exp(drift1 + sigS * sq * w1);
      const xT = X * Math.exp(drift2 + sigX * sq * w2);
      const composite = sT * xT;
      const intrinsic = type === 'call' ? Math.max(composite - K, 0) : Math.max(K - composite, 0);
      return df * intrinsic;
    };
    const est = monteCarloEstimate({
      dimensions: 2,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(T, q, 'compo', 'compo-mc'),
      diagnostics: {
        engine: 'compo',
        method: `monte-carlo-${est.method}-two-factor`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },
} as const;

// ────────────────────────────────────────────────────────────────────────────
// Inverse (coin-settled / Deribit-style) options
// ────────────────────────────────────────────────────────────────────────────

/** Input for the {@link inverseOption} coin-settled option. */
export interface InverseOptionInput {
  /** Underlying spot, quote per coin (e.g. BTC/USD). */
  spot: number;
  /** Strike, in the QUOTE currency (USD). */
  strike: number;
  timeToExpiryYears: number;
  /** USD (quote-currency) risk-free rate. */
  riskFreeRate: number;
  /** Coin (base-currency) yield — lending/staking. Default 0. Enters the forward as the dividend yield. */
  coinYield?: number;
  /** Volatility. */
  volatility: number;
}

/** An inverse option's risk in both denominations. */
export interface InverseGreeks {
  /**
   * Coin-denominated greeks — derivatives of the coin premium `V_usd/S`. delta/gamma are raw (per $1
   * move in spot), vega/1%, theta/day, rho/1%. The delta carries the `−V_coin/S` correction (the
   * embedded short-coin from paying premium in the coin), so it is NOT the Black–Scholes delta.
   */
  coin: Greeks;
  /** USD-linear greeks — equal to the vanilla BSM greeks, since the inverse option's USD payoff is a vanilla's. */
  usd: Greeks;
}

/** Monte-Carlo options for {@link inverseOption.monteCarloPrice}. */
export type InverseOptionMonteCarloOptions = MonteCarloSamplingOptions;

/** Validate an inverse-option input and return the resolved coin yield. */
function resolveInverse(input: InverseOptionInput, functionName: string): { q: number } {
  requireArgumentObject(functionName, 'input', input);
  ensurePositive(input.spot, 'spot', functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  ensurePositive(input.volatility, 'volatility', functionName);
  ensureFinite(input.riskFreeRate, 'riskFreeRate', functionName);
  const q = input.coinYield ?? 0;
  ensureFinite(q, 'coinYield', functionName);
  return { q };
}

const INVERSE_PRICE_SPEC = specOf('inverseOption.price#0');
const INVERSE_GREEKS_SPEC = specOf('inverseOption.greeks#0');
const INVERSE_MC_INPUT_SPEC = specOf('inverseOption.monteCarloPrice#0');
const INVERSE_MC_OPTIONS_SPEC = specOf('inverseOption.monteCarloPrice#1');
const INVERSE_DIGITAL_SPEC = specOf('inverseOption.digital#0');
const INVERSE_BARRIER_SPEC = specOf('inverseOption.barrier#0');

const INVERSE_EXAMPLE = (): string =>
  "inverseOption.price({ type: 'call', spot: 60000, strike: 65000, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.6 })";

export const inverseOption = {
  /**
   * The **coin (base-currency) premium** of a Deribit-style inverse option, settling `(±(S_T−K))⁺/S_T` in
   * the coin. The USD payoff is a vanilla's, so the coin premium is exactly `blackScholesPrice/spot`. `value·spot`
   * recovers the USD premium. `rate` is the USD/quote rate; `coinYield` the coin lending/staking yield.
   * See `docs/specs/inverse-option.md`.
   */
  price(input: InverseOptionInput & { type: OptionType }): ExoticResult {
    const functionName = 'inverseOption.price';
    validateClosedRequest(functionName, input, INVERSE_PRICE_SPEC, {
      exampleCall: INVERSE_EXAMPLE,
    });
    const { type } = input;
    const { q } = resolveInverse(input, functionName);
    const vUsd = blackScholesPrice({
      type,
      spot: input.spot,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      dividendYield: q,
      volatility: input.volatility,
    });
    const value = vUsd / input.spot;
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'inverse', 'inverse'),
      diagnostics: {
        engine: 'inverse',
        method: 'closed-form-coin-premium',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /**
   * The inverse option's risk in **both** denominations. The `coin` greeks are the exact derivatives of
   * the coin premium `V_usd/S`: delta and gamma carry the numeraire corrections (`Δ_coin = Δ_usd/S −
   * V_usd/S²`, `Γ_coin = Γ_usd/S − 2Δ_usd/S² + 2V_usd/S³`), while vega/theta/rho scale by `1/S`. The `usd`
   * greeks equal the vanilla BSM greeks. The `−V_coin/S` delta term is the embedded short-coin from the
   * coin-denominated premium — an inverse option is NOT hedged at its Black–Scholes delta.
   */
  greeks(input: InverseOptionInput & { type: OptionType }): Computed<InverseGreeks> {
    const functionName = 'inverseOption.greeks';
    validateClosedRequest(functionName, input, INVERSE_GREEKS_SPEC, {
      exampleCall: INVERSE_EXAMPLE,
    });
    const { type } = input;
    const { q } = resolveInverse(input, functionName);
    const { spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, volatility } = input;
    const usd = blackScholesGreeks({
      type,
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      volatility,
    });
    const vUsd = blackScholesPrice({
      type,
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      volatility,
    });
    const coin: Greeks = {
      delta: usd.delta / S - vUsd / (S * S),
      gamma: usd.gamma / S - (2 * usd.delta) / (S * S) + (2 * vUsd) / (S * S * S),
      vega: usd.vega / S,
      theta: usd.theta / S,
      rho: usd.rho / S,
    };
    const finite = (g: Greeks) => Object.values(g).every((x) => Number.isFinite(x));
    return {
      value: { coin, usd },
      assumptions: { ...assumptions(T, q, 'inverse', 'inverse'), units: DEFAULT_GREEK_UNITS },
      diagnostics: {
        engine: 'inverse',
        method: 'closed-form-greeks',
        converged: finite(coin) && finite(usd),
        warnings: [],
      },
    };
  },

  /**
   * One-factor **coin-numeraire** Monte-Carlo: under the coin money-market numeraire the spot drifts at the
   * self-quanto rate `r − q + σ²`, and the coin premium is `E[e^{−qT}·(±(S_T−K))⁺/S_T]`. Converges to the
   * closed-form coin premium, corroborating the `V_usd/S` identity from the other measure.
   */
  monteCarloPrice(
    input: InverseOptionInput & { type: OptionType },
    options: InverseOptionMonteCarloOptions,
  ): ExoticMonteCarloResult {
    const functionName = 'inverseOption.monteCarloPrice';
    validateClosedRequest(functionName, input, INVERSE_MC_INPUT_SPEC, {
      exampleCall: INVERSE_EXAMPLE,
    });
    validateClosedRequest(functionName, options, INVERSE_MC_OPTIONS_SPEC, {
      exampleCall: INVERSE_EXAMPLE,
      argumentName: 'options',
    });
    const { type } = input;
    const { q } = resolveInverse(input, functionName);
    const { spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, volatility } = input;
    const dq = Math.exp(-q * T);
    // Coin-measure drift r − q + σ²: fold the +σ² into gbmTerminal's rate argument.
    const payoff = (z: number[]): number => {
      const sT = gbmTerminal({
        spot: S,
        riskFreeRate: r + volatility * volatility,
        dividendYield: q,
        volatility,
        timeToExpiryYears: T,
        shock: z[0]!,
      });
      const intrinsic = type === 'call' ? Math.max(sT - K, 0) : Math.max(K - sT, 0);
      return (dq * intrinsic) / sT;
    };
    const est = monteCarloEstimate({
      dimensions: 1,
      payoff,
      options,
      controlVariate: undefined,
      label: functionName,
    });
    return {
      value: est.value,
      assumptions: assumptions(T, q, 'inverse', 'inverse-mc'),
      diagnostics: {
        engine: 'inverse',
        method: `monte-carlo-${est.method}-coin-numeraire`,
        converged: est.converged,
        iterations: est.paths,
        warnings: est.warnings,
      },
      monteCarlo: monteCarloStatistics(est),
    };
  },

  /**
   * The **coin premium** of a coin-settled (inverse) **binary**. Every coin-settled exotic obeys the same
   * universal identity as the vanilla: a coin payoff `H(S_T)/S_T` is worth `H(S_T)` USD at expiry (1 coin =
   * `S_T` USD then), so its USD price is the vanilla's and its coin premium is exactly `vanillaUsd/spot`.
   * A `cash-or-nothing` therefore settles its `cash` USD-equivalent in the coin, an `asset-or-nothing`
   * settles 1 coin if in-the-money. `value·spot` recovers the USD premium. See `docs/specs/inverse-option.md`.
   */
  digital(
    input: InverseOptionInput & { type: OptionType; kind: DigitalKind; cash?: number },
  ): ExoticResult {
    const functionName = 'inverseOption.digital';
    validateClosedRequest(functionName, input, INVERSE_DIGITAL_SPEC, {
      exampleCall: INVERSE_EXAMPLE,
    });
    const { type, kind } = input;
    const { q } = resolveInverse(input, functionName);
    const usd = digital.price({
      type,
      kind,
      spot: input.spot,
      strike: input.strike,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      volatility: input.volatility,
      dividendYield: q,
      ...(input.cash !== undefined ? { cash: input.cash } : {}),
    }).value;
    const value = usd / input.spot;
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'inverse', 'inverse-digital'),
      diagnostics: {
        engine: 'inverse-digital',
        method: 'closed-form-coin-premium',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },

  /**
   * The **coin premium** of a coin-settled (inverse) **barrier** (continuous monitoring, zero rebate). By the
   * same universal identity, the coin premium is the vanilla barrier's USD price divided by spot. `value·spot`
   * recovers the USD premium. See `docs/specs/inverse-option.md`.
   */
  barrier(
    input: InverseOptionInput & { type: OptionType; barrierType: BarrierType; barrier: number },
  ): ExoticResult {
    const functionName = 'inverseOption.barrier';
    validateClosedRequest(functionName, input, INVERSE_BARRIER_SPEC, {
      exampleCall: INVERSE_EXAMPLE,
    });
    const { type, barrierType } = input;
    const { q } = resolveInverse(input, functionName);
    const usd = barrier.price({
      type,
      barrierType,
      spot: input.spot,
      strike: input.strike,
      barrier: input.barrier,
      timeToExpiryYears: input.timeToExpiryYears,
      riskFreeRate: input.riskFreeRate,
      volatility: input.volatility,
      dividendYield: q,
    }).value;
    const value = usd / input.spot;
    return {
      value,
      assumptions: assumptions(input.timeToExpiryYears, q, 'inverse', 'inverse-barrier'),
      diagnostics: {
        engine: 'inverse-barrier',
        method: 'closed-form-coin-premium',
        converged: Number.isFinite(value),
        warnings: [],
      },
    };
  },
} as const;
