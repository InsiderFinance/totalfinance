/**
 * The SABR stochastic-volatility model (Hagan, Kumar, Lesniewski & Woodward 2002) — spec §9.3, §10.1.
 *
 * Forward dynamics:
 *   dF = α·F^β·dW₁
 *   dα = ν·α·dW₂,   corr(dW₁, dW₂) = ρ
 *
 * SABR's value is its closed-form *implied volatility* asymptotics, which fit an entire smile with
 * four intuitive parameters (α level, β backbone, ρ skew, ν smile). We expose:
 *   • `sabrVolatility` — Hagan's lognormal (Black) and normal (Bachelier) implied-vol expansions;
 *   • `sabrPrice` — the option price, by plugging that vol into Black-76 / Bachelier;
 *   • `sabrMonteCarloPrice` — an Euler simulation of the SDE that validates the asymptotic formula in its
 *     region of accuracy (short maturities, moderate vol-of-vol).
 *
 * Degenerate anchors: (β=1, ν=0) ⇒ lognormal vol ≡ α; (β=0, ν=0) ⇒ normal vol ≡ α.
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
import { bachelierPrice } from './bachelier.js';
import { black76Price } from './black76.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';
import { assertNoArbitrageBounds } from './engines/bounds.js';
import {
  type MonteCarloEstimate,
  type MonteCarloStatistics,
  type MonteCarloSamplingOptions,
  monteCarloEstimate,
} from './mc/core.js';
import { finiteDifferenceExtendedGreeks } from './engines/fd-greeks.js';
import type { ExtendedGreeks, Greeks, PriceResult } from './types.js';

/** SABR parameters. */
export interface SabrParameters {
  /** Initial volatility level α (> 0). */
  alpha: number;
  /** Backbone exponent β ∈ [0, 1]. */
  beta: number;
  /** Correlation ρ ∈ (−1, 1). */
  rho: number;
  /** Volatility of volatility ν (≥ 0). */
  nu: number;
}

/** Which Hagan expansion to use. */
export type SabrVolatilityType = 'lognormal' | 'normal';

/** Market inputs for a SABR computation. Provide `forward`, or `spot` (+ `rate`, `dividendYield`). */
export interface SabrInput {
  forward?: number;
  spot?: number;
  strike: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
  /** Discount/forward rate (default 0). */
  riskFreeRate?: number;
  dividendYield?: number;
}

export interface SabrOptions {
  /** Hagan expansion (default `'lognormal'`). */
  volatilityType?: SabrVolatilityType;
  /** Compute Greeks by finite differences (default `true`). */
  greeks?: boolean;
  /**
   * Compute the full higher-order (extended) Greek set (implies `greeks`). Volatility Greeks (vega, vanna, …)
   * are w.r.t. the SABR level `α` — extending the `vega` convention; `phi = 0` (forward model). Hagan's
   * vol is smooth, so the finite differences are stable.
   */
  extendedGreeks?: boolean;
}

export interface SabrMonteCarloOptions extends MonteCarloSamplingOptions {
  /** Time steps per path (default 100). */
  steps?: number;
}

/** A SABR MC result enriched with the Monte-Carlo error statistics. */
export interface SabrMonteCarloResult extends PriceResult {
  monteCarlo: MonteCarloStatistics;
}

/** One cohesive request for a Hagan SABR volatility evaluation. */
export interface SabrVolatilityRequest {
  input: SabrVolatilityInput;
  parameters: SabrParameters;
  options?: SabrVolatilityOptions;
}

/** One cohesive request for the validated Hagan SABR pricer. */
export interface SabrPriceRequest {
  type: OptionType;
  input: SabrInput;
  parameters: SabrParameters;
  options?: SabrOptions;
}

/** Complete, assumption-light inputs for one raw SABR Monte-Carlo estimate. */
export interface SabrMonteCarloEstimateInput {
  type: OptionType;
  forward: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  parameters: SabrParameters;
  options: SabrMonteCarloOptions;
}

/** One cohesive request for the validated SABR Monte-Carlo pricer. */
export interface SabrPriceMonteCarloRequest {
  type: OptionType;
  input: SabrInput;
  parameters: SabrParameters;
  options: SabrMonteCarloOptions;
}

function validateParams(p: SabrParameters, functionName: string): void {
  ensurePositive(p.alpha, 'alpha', functionName);
  ensureFinite(p.beta, 'beta', functionName);
  ensureFinite(p.nu, 'nu', functionName);
  ensureFinite(p.rho, 'rho', functionName);
  if (p.beta < 0 || p.beta > 1) {
    throw new InputError(`${functionName}: beta must be in [0, 1], got ${p.beta}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { beta: p.beta },
    });
  }
  if (p.rho <= -1 || p.rho >= 1) {
    throw new InputError(`${functionName}: rho must be in (-1, 1), got ${p.rho}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { rho: p.rho },
    });
  }
  if (p.nu < 0) {
    throw new InputError(`${functionName}: nu must be ≥ 0, got ${p.nu}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { nu: p.nu },
    });
  }
}

/** z / x(z) with a small-z series limit (→ 1) to avoid the 0/0 at the money. */
function zOverX(z: number, rho: number): number {
  if (Math.abs(z) < 1e-7) return 1 - 0.5 * rho * z; // leading correction
  const x = Math.log((Math.sqrt(1 - 2 * rho * z + z * z) + z - rho) / (1 - rho));
  return z / x;
}

/**
 * Hagan's formula is a **small-time asymptotic expansion**, and its `1 + [ … ]·T` bracket is the
 * first-order term of that expansion — not a bounded correction. For `ρ² > 2/3` the `(2 − 3ρ²)/24·ν²`
 * contribution is negative, so a large enough `ν²T` drives the bracket through zero and the formula
 * returns a NEGATIVE implied volatility. Fed to Black-76 that produced a negative PRICE reported as
 * `converged: true` (α=0.3, β=1, ρ=−0.99, ν=1.5, T=30 → vol ≈ −0.7, price < 0).
 *
 * A negative volatility is not a number to clamp or pass on: it means the requested point is outside
 * the expansion's domain of validity, which is what this says.
 */
function requireExpansionInDomain(input: {
  volatility: number;
  timeBracket: number;
  parameters: SabrParameters;
  timeToExpiryYears: number;
  volatilityType: SabrVolatilityType;
  functionName: string;
}): number {
  const {
    volatility,
    timeBracket,
    parameters: p,
    timeToExpiryYears: T,
    volatilityType,
    functionName,
  } = input;
  if (timeBracket > 0 && volatility > 0) return volatility;
  throw new InputError(
    `${functionName}: Hagan's ${volatilityType} expansion is out of domain here — its time-correction bracket ` +
      `1 + […]·T is ${timeBracket.toPrecision(6)} (≤ 0), giving an implied volatility of ` +
      `${volatility.toPrecision(6)}. The driver is the (2 − 3ρ²)/24·ν²·T term, which turns negative for ` +
      `ρ² > 2/3: here ρ=${p.rho} (ρ²=${(p.rho * p.rho).toPrecision(4)}) and ν²·T=${(p.nu * p.nu * T).toPrecision(6)}. ` +
      'This is beyond Hagan (2002) expansion validity — the asymptotic is first order in T and is trustworthy ' +
      'for roughly ν²·T ≲ 1 — not a solvable numerical issue. Shorten timeToExpiryYears, reduce nu or |rho|, or ' +
      'price the point by simulation with sabr.monteCarloPrice.',
    {
      code: ErrorCode.InputOutOfRange,
      context: {
        volatility,
        timeBracket,
        rho: p.rho,
        nu: p.nu,
        timeToExpiryYears: T,
        nuSquaredTime: p.nu * p.nu * T,
        volatilityType,
      },
    },
  );
}

/** Point at which to evaluate a SABR smile: forward, strike, and time to expiry. */
export interface SabrVolatilityInput {
  forward: number;
  strike: number;
  /** Time to expiry in years. */
  timeToExpiryYears: number;
}

/** Knobs for {@link sabrVolatility}. */
export interface SabrVolatilityOptions {
  /** Hagan expansion: `'lognormal'` (Black, default) or `'normal'` (Bachelier). */
  volatilityType?: SabrVolatilityType;
}

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations —
 * including the `volatilityType` and `type` literal domains, so the hand enum guards cannot drift
 * from the declared unions. Resolved at module load so a stale key fails at import. The `sabr.*`
 * namespace aliases the same implementations, so one validation head serves both spellings.
 */
function sabrSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `sabr: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const SABR_VOLATILITY_SPEC = sabrSpecOf('sabrVolatility#0');
const SABR_PRICE_SPEC = sabrSpecOf('sabrPrice#0');
const SABR_MC_ESTIMATE_SPEC = sabrSpecOf('sabrMonteCarloEstimate#0');
const SABR_MC_PRICE_SPEC = sabrSpecOf('sabrMonteCarloPrice#0');

const SABR_EXAMPLE = (): string =>
  'sabr.volatility({ input: { forward: 100, strike: 105, timeToExpiryYears: 0.25 }, parameters: { alpha: 0.2, beta: 0.5, rho: -0.3, nu: 0.4 } })';

/**
 * Hagan implied volatility (lognormal/Black by default, or normal/Bachelier). Returns the volatility
 * to feed into Black-76 (lognormal) or Bachelier (normal) at the same forward, strike, and maturity.
 *
 * Subject-first like its namespace sibling `sabr.price(type, input, parameters, options)`: the smile POINT
 * (`input`) comes before the model PARAMETERS (`parameters`).
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link sabr.volatility}.
 */
export function sabrVolatility(request: SabrVolatilityRequest): number {
  validateClosedRequest('sabrVolatility', request, SABR_VOLATILITY_SPEC, {
    argumentName: 'request',
    subject: true,
    exampleCall: SABR_EXAMPLE,
  });
  const { input, parameters, options: options = {} } = request;
  const functionName = 'sabrVolatility';
  // An unknown `volatilityType` teaches via the generated literal domain rather than silently
  // pricing as lognormal (design law #4) — this head is the chokepoint every SABR path
  // (price, MC, calibration, surface) routes through.
  const volatilityType = options.volatilityType ?? 'lognormal';
  // A garbage α/β/ρ/ν must throw here, not surface later as a silent NaN vol.
  validateParams(parameters, functionName);
  const { forward, strike, timeToExpiryYears } = input;
  ensurePositive(forward, 'forward', functionName);
  ensurePositive(strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  ensurePositive(timeToExpiryYears, 'timeToExpiryYears', functionName, ErrorCode.InputNegativeTime);
  const { alpha, beta, rho, nu } = parameters;
  const F = forward;
  const K = strike;
  const oneMinusBeta = 1 - beta;
  const logFK = Math.log(F / K);
  const fkBeta = Math.pow(F * K, oneMinusBeta / 2);
  const z = (nu / alpha) * fkBeta * logFK;
  const zx = zOverX(z, rho);

  if (volatilityType === 'normal') {
    const atK = Math.pow(F * K, beta / 2);
    const num = 1 + (1 / 24) * logFK * logFK + (1 / 1920) * logFK ** 4;
    const den =
      1 +
      ((oneMinusBeta * oneMinusBeta) / 24) * logFK * logFK +
      (oneMinusBeta ** 4 / 1920) * logFK ** 4;
    const tBracket =
      1 +
      ((-beta * (2 - beta) * alpha * alpha) / (24 * Math.pow(F * K, oneMinusBeta)) +
        (rho * beta * nu * alpha) / (4 * Math.pow(F * K, oneMinusBeta / 2)) +
        ((2 - 3 * rho * rho) / 24) * nu * nu) *
        timeToExpiryYears;
    return requireExpansionInDomain({
      volatility: alpha * atK * (num / den) * zx * tBracket,
      timeBracket: tBracket,
      parameters,
      timeToExpiryYears,
      volatilityType,
      functionName,
    });
  }

  // lognormal (Black)
  const denom =
    fkBeta *
    (1 +
      ((oneMinusBeta * oneMinusBeta) / 24) * logFK * logFK +
      (oneMinusBeta ** 4 / 1920) * logFK ** 4);
  const tBracket =
    1 +
    ((((oneMinusBeta * oneMinusBeta) / 24) * (alpha * alpha)) / Math.pow(F * K, oneMinusBeta) +
      (0.25 * rho * beta * nu * alpha) / fkBeta +
      ((2 - 3 * rho * rho) / 24) * nu * nu) *
      timeToExpiryYears;
  return requireExpansionInDomain({
    volatility: (alpha / denom) * zx * tBracket,
    timeBracket: tBracket,
    parameters,
    timeToExpiryYears,
    volatilityType,
    functionName,
  });
}

function resolveForward(input: SabrInput, functionName: string): { F: number; r: number } {
  const r = input.riskFreeRate ?? 0;
  ensureFinite(r, 'riskFreeRate', functionName);
  if (typeof input.forward === 'number') {
    ensurePositive(input.forward, 'forward', functionName);
    return { F: input.forward, r };
  }
  if (typeof input.spot === 'number') {
    ensurePositive(input.spot, 'spot', functionName);
    const q = input.dividendYield ?? 0;
    ensureFinite(q, 'dividendYield', functionName);
    return { F: input.spot * Math.exp((r - q) * input.timeToExpiryYears), r };
  }
  throw new InputError(`${functionName}: provide either input.forward or input.spot.`, {
    code: ErrorCode.InputMissingField,
    context: { fields: ['forward', 'spot'] },
  });
}

function assumptions(t: number, volatilityType: SabrVolatilityType): Assumptions {
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    timeToExpiryYears: t,
    dividendModel: 'continuousYield',
    units: DEFAULT_GREEK_UNITS,
    model: 'sabr',
    engine: volatilityType === 'normal' ? 'sabr-bachelier' : 'sabr-black76',
  };
}

/**
 * Price a European option under SABR by evaluating Hagan's implied vol and pricing with Black-76
 * (lognormal) or Bachelier (normal). Greeks are finite differences: `delta`/`gamma` w.r.t. the
 * forward, `theta` per day, `vega` per 1% change in α, `rho` per 1% change in the rate — all echoed in
 * `assumptions.units`.
 *
 * A point outside Hagan's expansion domain (see {@link requireExpansionInDomain}) REFUSES with a
 * typed `input.out_of_range` error carrying the ν²T·ρ diagnosis — never a negative volatility, never
 * a negative "price" reported as converged. Through `engines.sabr()` that surfaces as a failed
 * `compareEngines` row; the value type stays `number` so no caller has to defend against a null.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link sabr.price}.
 */
export function sabrPrice(request: SabrPriceRequest): PriceResult {
  validateClosedRequest('sabrPrice', request, SABR_PRICE_SPEC, {
    argumentName: 'request',
    subject: true,
    exampleCall: SABR_EXAMPLE,
  });
  const { type, input, parameters, options: options = {} } = request;
  const functionName = 'sabrPrice';
  validateParams(parameters, functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  const { F, r } = resolveForward(input, functionName);
  const volatilityType = options.volatilityType ?? 'lognormal';
  const K = input.strike;
  const T = input.timeToExpiryYears;

  const priceWith = ({
    forward,
    parameters: priceParams,
    timeToExpiryYears,
    riskFreeRate,
  }: {
    forward: number;
    parameters: SabrParameters;
    timeToExpiryYears: number;
    riskFreeRate: number;
  }): number => {
    const v = sabrVolatility({
      input: { forward, strike: K, timeToExpiryYears },
      parameters: priceParams,
      options: { volatilityType },
    });
    return volatilityType === 'normal'
      ? bachelierPrice({
          type,
          forward,
          strike: K,
          timeToExpiryYears,
          riskFreeRate,
          normalVolatility: v,
        })
      : black76Price({
          type,
          forward,
          strike: K,
          timeToExpiryYears,
          riskFreeRate,
          volatility: v,
        });
  };

  // Out of Hagan's domain this throws (typed, with the diagnosis) rather than returning a negative
  // volatility's negative "price" under converged: true.
  const value = priceWith({ forward: F, parameters, timeToExpiryYears: T, riskFreeRate: r });
  const wantExtended = options.extendedGreeks ?? false;
  const wantGreeks = wantExtended || (options.greeks ?? true);
  let greeks: Greeks | ExtendedGreeks | undefined;
  if (wantExtended) {
    // The full set differences the smooth Hagan price; the vol level is `α` (shift = 0 at base). SABR
    // is a forward model (no dividend yield), so `phi = 0` falls out of the q-bump automatically.
    const priceVL = ({
      spot: forward,
      volatility: shift,
      timeToExpiryYears,
      riskFreeRate,
    }: {
      spot: number;
      volatility: number;
      timeToExpiryYears: number;
      riskFreeRate: number;
      dividendYield: number;
    }): number =>
      priceWith({
        forward,
        parameters: { ...parameters, alpha: parameters.alpha + shift },
        timeToExpiryYears,
        riskFreeRate,
      });
    // Shift-mode: scale the vol bump to α so `α + shift` never crosses zero (spec P2.3).
    const volatilityStep = parameters.alpha > 0 ? Math.min(1e-3, parameters.alpha / 4) : 1e-3;
    greeks = finiteDifferenceExtendedGreeks({
      price: priceVL,
      spotAt: () => F,
      state: { spot: F, T, r, q: 0, sigma: 0 },
      steps: { volatilityStep },
    });
  } else if (wantGreeks) {
    // Adaptive near boundaries (P2.3): the α bump shrinks to α/4 for tiny vol levels so
    // `α − h` never crosses zero; the time bump shrinks to T/4 near expiry.
    const hF = F * 1e-4;
    const timeStepYears = Math.min(1e-4, T / 4);
    const rateStep = 1e-4;
    const hA = parameters.alpha > 0 ? Math.min(1e-4, parameters.alpha / 4) : 1e-4;
    const up = priceWith({ forward: F + hF, parameters, timeToExpiryYears: T, riskFreeRate: r });
    const dn = priceWith({ forward: F - hF, parameters, timeToExpiryYears: T, riskFreeRate: r });
    const aUp = { ...parameters, alpha: parameters.alpha + hA };
    const aDn = { ...parameters, alpha: parameters.alpha - hA };
    greeks = {
      delta: (up - dn) / (2 * hF),
      gamma: (up - 2 * value + dn) / (hF * hF),
      theta:
        -(
          priceWith({
            forward: F,
            parameters,
            timeToExpiryYears: T + timeStepYears,
            riskFreeRate: r,
          }) -
          priceWith({
            forward: F,
            parameters,
            timeToExpiryYears: T - timeStepYears,
            riskFreeRate: r,
          })
        ) /
        (2 * timeStepYears) /
        365,
      vega:
        (priceWith({ forward: F, parameters: aUp, timeToExpiryYears: T, riskFreeRate: r }) -
          priceWith({ forward: F, parameters: aDn, timeToExpiryYears: T, riskFreeRate: r })) /
        (2 * hA) /
        100,
      rho:
        (priceWith({ forward: F, parameters, timeToExpiryYears: T, riskFreeRate: r + rateStep }) -
          priceWith({ forward: F, parameters, timeToExpiryYears: T, riskFreeRate: r - rateStep })) /
        (2 * rateStep) /
        100,
    };
  }

  // The ACTUAL bump sizes differenced (P2.3): α-scaled vol bump, forward-relative spot bump.
  const sabrHSig =
    parameters.alpha > 0
      ? Math.min(wantExtended ? 1e-3 : 1e-4, parameters.alpha / 4)
      : wantExtended
        ? 1e-3
        : 1e-4;
  const diagnostics: Diagnostics = {
    engine: volatilityType === 'normal' ? 'sabr-bachelier' : 'sabr-black76',
    method: 'hagan-2002',
    converged: Number.isFinite(value),
    ...(wantGreeks
      ? {
          finiteDifferenceBumps: {
            spotStep: wantExtended ? F * 1e-3 : F * 1e-4,
            volatilityStep: sabrHSig,
            timeStepYears: wantExtended ? Math.min(1e-3, T / 4) : Math.min(1e-4, T / 4),
            rateStep: wantExtended ? 1e-4 : 1e-4,
          },
        }
      : {}),
    warnings: wantGreeks
      ? []
      : [
          {
            code: WarningCode.GreeksNotComputed,
            message: 'Greeks were not computed (greeks: false).',
            severity: 'info' as const,
          },
        ],
  };
  // Structural postcondition (defect-fix wave, finding 5): SABR is a forward model, so the call's
  // ceiling is the PV of the forward, F·e^{−rT}, and the put's is K·e^{−rT}.
  assertNoArbitrageBounds({
    engine: volatilityType === 'normal' ? 'sabr-bachelier' : 'sabr-black76',
    type,
    style: 'european',
    value,
    underlyingPresentValue: F * Math.exp(-r * T),
    strikePresentValue: K * Math.exp(-r * T),
    spot: F,
    strike: K,
  });
  return {
    value,
    ...(greeks ? { greeks } : {}),
    assumptions: assumptions(T, volatilityType),
    diagnostics,
  };
}

/** One SABR Euler terminal forward from `2·steps` standard normals (α simulated exactly, F absorbed at 0). */
function sabrTerminal(input: {
  shocks: number[];
  forward: number;
  timeToExpiryYears: number;
  parameters: SabrParameters;
  steps: number;
}): number {
  const { shocks: z, forward: F0, timeToExpiryYears: T, parameters: p, steps } = input;
  const { alpha, beta, rho, nu } = p;
  const timeStepYears = T / steps;
  const sqdt = Math.sqrt(timeStepYears);
  const corr = Math.sqrt(1 - rho * rho);
  let F = F0;
  let a = alpha;
  for (let k = 0; k < steps; k++) {
    const z1 = z[2 * k]!;
    const z2 = z[2 * k + 1]!;
    const dW2 = z2 * sqdt;
    const dW1 = (rho * z2 + corr * z1) * sqdt;
    if (F > 0) {
      F = F + a * Math.pow(F, beta) * dW1;
      if (F < 0) F = 0; // absorbing boundary for β < 1
    }
    a = a * Math.exp(nu * dW2 - 0.5 * nu * nu * timeStepYears); // exact GBM for the vol process
  }
  return F;
}

/**
 * Low-level kernel: SABR Euler Monte-Carlo estimate of the discounted European payoff.
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link sabr.monteCarloEstimate}.
 */
export function sabrMonteCarloEstimate(input: SabrMonteCarloEstimateInput): MonteCarloEstimate {
  validateClosedRequest('sabrMonteCarloEstimate', input, SABR_MC_ESTIMATE_SPEC, {
    exampleCall: SABR_EXAMPLE,
  });
  const {
    type,
    forward: F,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    parameters,
    options,
  } = input;
  const steps = options.steps ?? 100;
  const df = Math.exp(-r * T);
  const payoff = (z: number[]): number => {
    const FT = sabrTerminal({
      shocks: z,
      forward: F,
      timeToExpiryYears: T,
      parameters,
      steps,
    });
    return df * (type === 'call' ? Math.max(FT - K, 0) : Math.max(K - FT, 0));
  };
  const control = {
    estimate: (z: number[]) =>
      df *
      sabrTerminal({
        shocks: z,
        forward: F,
        timeToExpiryYears: T,
        parameters,
        steps,
      }),
    mean: df * F, // F is a martingale
  };
  return monteCarloEstimate({
    dimensions: 2 * steps,
    payoff,
    options,
    controlVariate: control,
    label: 'sabrMonteCarloPrice',
  });
}

/**
 * Price a European option under SABR by Euler Monte-Carlo of the SDE (validates the Hagan formula).
 *
 * Expert kernel form (model-subpath surface) — the curated root surface is {@link sabr.monteCarloPrice}.
 */
export function sabrMonteCarloPrice(request: SabrPriceMonteCarloRequest): SabrMonteCarloResult {
  validateClosedRequest('sabrMonteCarloPrice', request, SABR_MC_PRICE_SPEC, {
    argumentName: 'request',
    subject: true,
    exampleCall: SABR_EXAMPLE,
  });
  const { type, input, parameters, options } = request;
  const functionName = 'sabrMonteCarloPrice';
  validateParams(parameters, functionName);
  ensurePositive(input.strike, 'strike', functionName);
  ensurePositive(input.timeToExpiryYears, 'timeToExpiryYears', functionName);
  const { F, r } = resolveForward(input, functionName);

  const est = sabrMonteCarloEstimate({
    type,
    forward: F,
    strike: input.strike,
    timeToExpiryYears: input.timeToExpiryYears,
    riskFreeRate: r,
    parameters,
    options,
  });
  // Same structural bound as the analytic path, with the estimator's own sampling error as slack.
  assertNoArbitrageBounds({
    engine: 'sabr-euler-mc',
    type,
    style: 'european',
    value: est.value,
    underlyingPresentValue: F * Math.exp(-r * input.timeToExpiryYears),
    strikePresentValue: input.strike * Math.exp(-r * input.timeToExpiryYears),
    spot: F,
    strike: input.strike,
    tolerance:
      5 *
      (est.standardError !== null && Number.isFinite(est.standardError) ? est.standardError : 0),
  });
  const diagnostics: Diagnostics = {
    engine: 'sabr',
    method: est.method === 'pseudo' ? 'euler-monte-carlo' : `euler-monte-carlo-${est.method}`,
    converged: est.converged,
    iterations: est.paths,
    warnings: [
      ...est.warnings,
      {
        code: WarningCode.GreeksNotComputed,
        message: 'The SABR Euler Monte-Carlo engine does not compute Greeks.',
        severity: 'info' as const,
      },
    ],
  };
  return {
    value: est.value,
    assumptions: { ...assumptions(input.timeToExpiryYears, 'lognormal'), engine: 'sabr-euler-mc' },
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
 * The SABR model namespace — the grouped, discoverable surface over the flat `sabr*` functions.
 * `sabr.volatility` / `sabr.price` / `sabr.monteCarloPrice` / `sabr.monteCarloEstimate` are the same functions; prefer the
 * namespace over the deprecated flat exports.
 */
export const sabr = {
  volatility: sabrVolatility,
  price: sabrPrice,
  monteCarloPrice: sabrMonteCarloPrice,
  monteCarloEstimate: sabrMonteCarloEstimate,
} as const;
