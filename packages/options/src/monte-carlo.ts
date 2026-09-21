/**
 * Monte-Carlo / quasi-Monte-Carlo European option pricing on geometric Brownian motion (spec §9.3).
 *
 * Built on the seeded MC estimator in `./mc/core`. The terminal underlying is the control variate
 * (its expectation `S₀·e^{−qT}` is known exactly), and Greeks are computed by common-random-number
 * finite differences — re-pricing with the *same* seed so the bumps difference cleanly.
 *
 * This is the reference path-pricer: against Black–Scholes–Merton it converges to the closed form, so
 * it both validates the analytic engines and prices payoffs the closed form can't. Stochastic-vol and
 * exotic pricers reuse the same estimator with their own dynamics and payoffs.
 *
 *   import { monteCarloPrice } from '@totalfinance/options/monte-carlo';
 *   monteCarloPrice({ contract: option.call({ ..., style: 'european' }), market, options: { paths: 100_000, seed: 7, method: 'sobol' } });
 */

import {
  ensureKnownKeys,
  requireFiniteFields,
  ensureFiniteWhenPresent,
  type Assumptions,
  CONVENTIONS_VERSION,
  DEFAULT_GREEK_UNITS,
  type Diagnostics,
  ErrorCode,
  type EpochMs,
  InputError,
  type OptionContract,
  type OptionType,
  UnsupportedError,
  ensureEnum,
  ensureFinite,
  ensurePositive,
  requireArgumentObject,
  resolveValuationAsOf,
  WarningCode,
} from '@totalfinance/core';
import { expiryConventionOf } from './engine-bsm.js';
import { escrowedSpot, hasDiscreteDividends } from './dividends.js';
import {
  type ControlVariate,
  type MonteCarloEstimate,
  type MonteCarloStatistics,
  type MonteCarloSamplingOptions,
  gbmTerminalUnchecked,
  monteCarloEstimate,
} from './mc/core.js';
import { contractTimeToExpiryYears } from './time.js';
import { assertNoArbitrageBounds } from './engines/bounds.js';
import { finiteDifferenceExtendedGreeks, resolveFdSteps } from './engines/fd-greeks.js';
import type { ExtendedGreeks, Greeks, OptionMarket, PriceResult } from './types.js';

export type {
  GbmPathInput,
  GbmTerminalInput,
  MonteCarloMethod,
  MonteCarloRandomNumberGenerator,
  MonteCarloStatistics,
  MonteCarloEstimate,
  MonteCarloSamplingOptions,
  VarianceReduction,
  ControlVariate,
} from './mc/core.js';
export { gbm, gbmPath, gbmTerminal } from './mc/core.js';

/** Options for {@link monteCarloPrice}. Extends the shared MC sampling options. */
export interface MonteCarloPriceOptions extends MonteCarloSamplingOptions {
  /** Compute Greeks by common-random-number finite differences (default `true`). */
  greeks?: boolean;
  /**
   * Compute the full higher-order (extended) Greek set by CRN finite differences (implies `greeks`).
   * Third-order Greeks (speed/color/ultima) carry more Monte-Carlo error than the first/second order —
   * raise `paths` when you need them tight.
   */
  extendedGreeks?: boolean;
}

/** A pricing result enriched with the Monte-Carlo error statistics. */
export interface MonteCarloPriceResult extends PriceResult {
  /** Standard error, confidence interval, path count, seed, method, and variance-reduction flags. */
  monteCarlo: MonteCarloStatistics;
}

/** Required raw inputs for one discounted European GBM estimate. */
export interface MonteCarloEuropeanInput {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  options: MonteCarloPriceOptions;
}

/**
 * Low-level kernel: estimate the discounted European payoff on GBM. Inputs are assumed validated
 * (S, K, T, σ all > 0). Uses the discounted terminal price as a control variate.
 *
 * The raw kernel remains direct and assumption-light, but its financially interchangeable values
 * are named so a transposed rate, yield, time, or volatility cannot typecheck unnoticed.
 */
export function monteCarloEuropean(input: MonteCarloEuropeanInput): MonteCarloEstimate {
  requireArgumentObject('monteCarloEuropean', 'input', input);
  ensureKnownKeys('monteCarloEuropean', 'input', input, [
    'type',
    'spot',
    'strike',
    'timeToExpiryYears',
    'riskFreeRate',
    'dividendYield',
    'volatility',
    'options',
  ] as const);
  // Every numeric is declared REQUIRED: present / a number / finite each teach their own code —
  // a null spot used to reach the GBM kernel and estimate NaN with a clean confidence interval.
  requireFiniteFields(
    'monteCarloEuropean',
    input as unknown as Record<string, unknown>,
    ['spot', 'strike', 'timeToExpiryYears', 'riskFreeRate', 'dividendYield', 'volatility'] as const,
    {
      exampleCall:
        "monteCarloEuropean({ type: 'call', spot: 100, strike: 105, timeToExpiryYears: 0.5, riskFreeRate: 0.045, dividendYield: 0, volatility: 0.2, options: { paths: 100_000, seed: 42 } })",
    },
  );
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    options,
  } = input;
  // `type` is a meaning-changing string: unvalidated garbage would silently price the other leg.
  ensureEnum(type, ['call', 'put'] as const, 'type', 'monteCarloEuropean');
  requireArgumentObject('monteCarloEuropean', 'options', options);
  for (const numField of ['confidence', 'paths', 'seed'] as const) {
    const numValue = (options as unknown as Record<string, unknown>)[numField];
    if (numValue !== undefined && (typeof numValue !== 'number' || !Number.isFinite(numValue))) {
      throw new InputError(
        `monteCarloEuropean: options.${numField} must be a finite number when provided. Received ${numValue === null ? 'null' : typeof numValue}.`,
        { code: ErrorCode.InputWrongType, context: { field: numField } },
      );
    }
  }
  for (const flag of ['greeks', 'extendedGreeks', 'antithetic', 'brownianBridge'] as const) {
    const flagValue = (options as unknown as Record<string, unknown>)[flag];
    if (flagValue !== undefined && typeof flagValue !== 'boolean') {
      throw new InputError(
        `monteCarloEuropean: options.${flag} must be a boolean when provided. Received ${flagValue === null ? 'null' : typeof flagValue}.`,
        { code: ErrorCode.InputWrongType, context: { field: flag } },
      );
    }
  }
  const df = Math.exp(-r * T);
  const payoff = (z: number[]): number => {
    const ST = gbmTerminalUnchecked({
      spot: S,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sigma,
      timeToExpiryYears: T,
      shock: z[0]!,
    });
    return df * (type === 'call' ? Math.max(ST - K, 0) : Math.max(K - ST, 0));
  };
  const control: ControlVariate = {
    estimate: (z: number[]) =>
      df *
      gbmTerminalUnchecked({
        spot: S,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        timeToExpiryYears: T,
        shock: z[0]!,
      }),
    mean: S * Math.exp(-q * T),
  };
  return monteCarloEstimate({
    dimensions: 1,
    payoff,
    options,
    controlVariate: control,
    label: 'monteCarloPrice',
  });
}

/** Common-random-number finite-difference Greeks: re-price with the same seed so bumps difference cleanly. */
function crnGreeks(input: {
  type: OptionType;
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  dividendYield: number;
  volatility: number;
  options: MonteCarloPriceOptions;
}): Greeks | ExtendedGreeks {
  const {
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    options,
  } = input;
  const priceAt = ({
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
    monteCarloEuropean({
      type,
      spot,
      strike: K,
      timeToExpiryYears,
      riskFreeRate,
      dividendYield,
      volatility,
      options,
    }).value;

  // The full set uses common random numbers throughout (the seed is fixed in `options`), so the
  // difference stencils are low-variance. `sigma` is the real GBM vol here (no vol-level proxy).
  if (options.extendedGreeks) {
    return finiteDifferenceExtendedGreeks({
      price: priceAt,
      spotAt: () => S,
      state: { spot: S, T, r, q, sigma },
    });
  }

  const base = priceAt({
    spot: S,
    volatility: sigma,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
  });
  // Adaptive near the vol/time boundaries (P2.3) — same rule as every other FD path.
  const { spotStep, volatilityStep, timeStepYears, rateStep } = resolveFdSteps(
    { spot: S, T, r, q, sigma },
    { timeStepYears: Math.min(1e-4, T / 4) },
  );

  const pSup = priceAt({
    spot: S + spotStep,
    volatility: sigma,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
  });
  const pSdn = priceAt({
    spot: S - spotStep,
    volatility: sigma,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
  });
  const delta = (pSup - pSdn) / (2 * spotStep);
  const gamma = (pSup - 2 * base + pSdn) / (spotStep * spotStep);
  const vega =
    (priceAt({
      spot: S,
      volatility: sigma + volatilityStep,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
    }) -
      priceAt({
        spot: S,
        volatility: sigma - volatilityStep,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
      })) /
    (2 * volatilityStep) /
    100;
  const theta =
    -(
      priceAt({
        spot: S,
        volatility: sigma,
        timeToExpiryYears: T + timeStepYears,
        riskFreeRate: r,
        dividendYield: q,
      }) -
      priceAt({
        spot: S,
        volatility: sigma,
        timeToExpiryYears: T - timeStepYears,
        riskFreeRate: r,
        dividendYield: q,
      })
    ) /
    (2 * timeStepYears) /
    365;
  const rho =
    (priceAt({
      spot: S,
      volatility: sigma,
      timeToExpiryYears: T,
      riskFreeRate: r + rateStep,
      dividendYield: q,
    }) -
      priceAt({
        spot: S,
        volatility: sigma,
        timeToExpiryYears: T,
        riskFreeRate: r - rateStep,
        dividendYield: q,
      })) /
    (2 * rateStep) /
    100;
  return { delta, gamma, theta, vega, rho };
}

function assumptions(input: {
  timeToExpiryYears: number;
  dividendYield: number;
  asOf: EpochMs;
  escrowed: boolean;
  expiry: string;
}): Assumptions {
  const { timeToExpiryYears: t, dividendYield: q, asOf, escrowed, expiry } = input;
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    asOf,
    timeToExpiryYears: t,
    expiryConvention: expiryConventionOf(expiry),
    dividendModel: escrowed ? 'discreteSchedule' : q === 0 ? 'none' : 'continuousYield',
    units: DEFAULT_GREEK_UNITS,
    model: 'black-scholes-merton',
    engine: 'monte-carlo',
  };
}

function methodLabel(method: MonteCarloStatistics['method']): string {
  return method === 'pseudo' ? 'monte-carlo' : `monte-carlo-${method}`;
}

/**
 * Price a European contract by Monte-Carlo simulation, returning value, Greeks, assumptions, and the
 * MC error statistics (`result.mc`). Validates the market the same way the analytic engines do, and
 * applies the escrowed-spot model for discrete dividends.
 */
export interface MonteCarloPriceInput {
  contract: OptionContract;
  market: OptionMarket;
  options: MonteCarloPriceOptions;
}

export function monteCarloPrice(input: MonteCarloPriceInput): MonteCarloPriceResult {
  requireArgumentObject('monteCarloPrice', 'input', input);
  // Law 12: a misspelled top-level field (`contarct`) must teach, never price against defaults.
  ensureKnownKeys('monteCarloPrice', 'input', input, ['contract', 'market', 'options'] as const);
  const mcOptions = (input as unknown as Record<string, unknown>)['options'];
  if (mcOptions !== undefined && (mcOptions === null || typeof mcOptions !== 'object')) {
    throw new InputError(
      `monteCarloPrice: options must be an object when provided. Received ${mcOptions === null ? 'null' : typeof mcOptions}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'options' } },
    );
  }
  if (mcOptions !== undefined) {
    for (const numField of ['confidence', 'paths', 'seed'] as const) {
      const numValue = (mcOptions as Record<string, unknown>)[numField];
      if (numValue !== undefined && (typeof numValue !== 'number' || !Number.isFinite(numValue))) {
        throw new InputError(
          `monteCarloPrice: options.${numField} must be a finite number when provided. Received ${numValue === null ? 'null' : typeof numValue}.`,
          { code: ErrorCode.InputWrongType, context: { field: numField } },
        );
      }
    }
    for (const flag of ['greeks', 'extendedGreeks', 'antithetic', 'brownianBridge'] as const) {
      const flagValue = (mcOptions as Record<string, unknown>)[flag];
      if (flagValue !== undefined && typeof flagValue !== 'boolean') {
        throw new InputError(
          `monteCarloPrice: options.${flag} must be a boolean when provided. Received ${flagValue === null ? 'null' : typeof flagValue}.`,
          { code: ErrorCode.InputWrongType, context: { field: flag } },
        );
      }
    }
  }
  const { contract, market, options } = input;
  requireArgumentObject('monteCarloPrice', 'contract', contract);
  requireArgumentObject('monteCarloPrice', 'market', market);
  const functionName = 'monteCarloPrice';
  if (contract.style !== 'european') {
    throw new UnsupportedError(
      `${functionName}: the GBM Monte-Carlo engine prices European-style options only; received "${contract.style}".`,
      { code: ErrorCode.EngineUnsupportedContract, context: { style: contract.style } },
    );
  }
  if (typeof market.spot !== 'number') {
    throw new InputError(`${functionName}: market.spot is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'spot' },
    });
  }
  if (typeof market.volatility !== 'number') {
    throw new InputError(`${functionName}: market.volatility (a number) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'volatility' },
    });
  }
  if (typeof market.riskFreeRate !== 'number') {
    throw new InputError(`${functionName}: market.riskFreeRate (a number) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'riskFreeRate' },
    });
  }
  ensurePositive(market.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  ensurePositive(market.volatility, 'volatility', functionName, ErrorCode.InputNegativeVolatility);
  ensurePositive(contract.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  ensureFinite(market.riskFreeRate, 'riskFreeRate', functionName);
  // Null is a wrong-typed value, not omission (the 350c2796 ruling): it used to coalesce
  // to 0 BEFORE the finite check and silently price a dividend-free underlying.
  ensureFiniteWhenPresent(market.dividendYield, 'dividendYield', functionName);
  const q = market.dividendYield ?? 0;
  const asOfMs = resolveValuationAsOf(market.asOf, functionName);
  ensureFinite(asOfMs, 'asOf', functionName);
  const T = contractTimeToExpiryYears(asOfMs, contract, functionName);
  if (T <= 0) {
    throw new UnsupportedError(
      `${functionName}: contract expiry ${contract.expiry} is not after asOf.`,
      {
        code: ErrorCode.InputNegativeTime,
        context: { asOf: market.asOf, expiry: contract.expiry },
      },
    );
  }

  const escrowed = hasDiscreteDividends(market);
  const S = escrowed
    ? escrowedSpot({
        spot: market.spot,
        market,
        asOf: asOfMs,
        timeToExpiryYears: T,
        riskFreeRate: market.riskFreeRate,
        functionName,
      })
    : market.spot;
  const sigma = market.volatility;
  const r = market.riskFreeRate;
  const K = contract.strike;
  const type = contract.type;

  const est = monteCarloEuropean({
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    options,
  });
  // Monte-Carlo defaults to NOT computing Greeks (each is ~2 extra path budgets). When not requested
  // they are ABSENT — never fabricated zeros (design law #4) — with an info diagnostic. Pass
  // `{ greeks: true }` to compute CRN finite-difference Greeks.
  const wantGreeks = options.extendedGreeks || (options.greeks ?? false);
  const greeks = wantGreeks
    ? crnGreeks({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sigma,
        options,
      })
    : undefined;

  const fd = wantGreeks
    ? resolveFdSteps(
        { spot: S, T, r, q, sigma },
        options.extendedGreeks ? {} : { timeStepYears: Math.min(1e-4, T / 4) },
      )
    : undefined;
  const diagnostics: Diagnostics = {
    engine: 'monte-carlo',
    method: methodLabel(est.method),
    converged: est.converged,
    iterations: est.paths,
    // The exact bump sizes differenced for the CRN Greeks (P2.3).
    ...(fd !== undefined
      ? {
          finiteDifferenceBumps: options.extendedGreeks
            ? {
                spotStep: fd.spotStep,
                volatilityStep: fd.volatilityStep,
                timeStepYears: fd.timeStepYears,
                rateStep: fd.rateStep,
                dividendYieldStep: fd.dividendYieldStep,
              }
            : {
                spotStep: fd.spotStep,
                volatilityStep: fd.volatilityStep,
                timeStepYears: fd.timeStepYears,
                rateStep: fd.rateStep,
              },
        }
      : {}),
    warnings: wantGreeks
      ? est.warnings
      : [
          ...est.warnings,
          {
            code: WarningCode.GreeksNotComputed,
            message: 'Greeks were not computed for this Monte-Carlo price; pass { greeks: true }.',
            severity: 'info' as const,
          },
        ],
  };

  // Structural postcondition (defect-fix wave, finding 5), with the estimator's own sampling error
  // as slack so a legitimate draw near the bound is never mistaken for a defect.
  assertNoArbitrageBounds({
    engine: 'monte-carlo',
    type,
    style: 'european',
    value: est.value,
    underlyingPresentValue: S * Math.exp(-q * T),
    strikePresentValue: K * Math.exp(-r * T),
    spot: S,
    strike: K,
    tolerance:
      5 *
      (est.standardError !== null && Number.isFinite(est.standardError) ? est.standardError : 0),
  });
  return {
    value: est.value,
    ...(greeks ? { greeks } : {}),
    assumptions: assumptions({
      timeToExpiryYears: T,
      dividendYield: q,
      asOf: asOfMs,
      escrowed,
      expiry: contract.expiry,
    }),
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
