/**
 * Shared BSM contract-pricing used by both the engine objects (`engines.*`) and the pro API
 * (`option.price` / `option.impliedVolatility`). Single source of truth — routes to the `bsm` kernel.
 */

import {
  type Assumptions,
  CONVENTIONS_VERSION,
  DEFAULT_GREEK_UNITS,
  type Diagnostics,
  ErrorCode,
  type EpochMs,
  InputError,
  type OptionContract,
  UnsupportedError,
  ensureFinite,
  ensurePositive,
  resolveValuationAsOf,
  WarningCode,
} from '@totalfinance/core';
import { blackScholesExtendedGreeks, blackScholesGreeks, blackScholesPrice } from './bsm.js';
import { escrowedSpot, hasDiscreteDividends } from './dividends.js';
import { withLambdaDisclosure, withUnderflowDisclosure } from './facade-util.js';
import {
  type ImpliedVolatilityOptions,
  type ImpliedVolatilitySolveResult,
  impliedVolatility,
} from './iv.js';
import { contractTimeToExpiryYears } from './time.js';
import type { ExtendedGreeks, OptionMarket, PriceResult } from './types.js';

const MODEL = 'black-scholes-merton';

export interface BlackScholesEngineConfig {
  name: string;
  /** Whether `market.dividendYield` is applied (BSM) or ignored (textbook Black–Scholes). */
  useDividends: boolean;
}

function requireSpot(market: OptionMarket, functionName: string): number {
  if (typeof market.spot !== 'number') {
    throw new InputError(`${functionName}: market.spot is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'spot', function: functionName },
    });
  }
  ensurePositive(market.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  return market.spot;
}

function requireScalarVolatility(market: OptionMarket, functionName: string): number {
  if (typeof market.volatility !== 'number') {
    throw new InputError(`${functionName}: market.volatility (a number) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'volatility', function: functionName },
    });
  }
  ensurePositive(market.volatility, 'volatility', functionName, ErrorCode.InputNegativeVolatility);
  return market.volatility;
}

function requireRate(market: OptionMarket, functionName: string): number {
  if (typeof market.riskFreeRate !== 'number') {
    throw new InputError(`${functionName}: market.riskFreeRate (a number) is required in 0.0.1.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'riskFreeRate', function: functionName },
    });
  }
  ensureFinite(market.riskFreeRate, 'riskFreeRate', functionName);
  return market.riskFreeRate;
}

const DATE_ONLY_EXPIRY = /^\d{4}-\d{2}-\d{2}$/;

/** The applied expiry-resolution convention, echoed in assumptions so it is never silent. */
export function expiryConventionOf(expiry: string): 'us-equity-close' | 'explicit-instant' {
  return DATE_ONLY_EXPIRY.test(expiry) ? 'us-equity-close' : 'explicit-instant';
}

function resolveTimeToExpiry(
  asOf: EpochMs | string,
  contract: OptionContract,
  functionName: string,
): { t: number; asOfMs: EpochMs } {
  const asOfMs = resolveValuationAsOf(asOf, functionName);
  ensureFinite(asOfMs, 'asOf', functionName);
  const t = contractTimeToExpiryYears(asOfMs, contract, functionName);
  if (t <= 0) {
    throw new UnsupportedError(
      `${functionName}: contract expiry ${contract.expiry} is not after asOf; BSM requires t > 0.`,
      {
        code: ErrorCode.InputNegativeTime,
        context: { asOf, expiry: contract.expiry, timeToExpiryYears: t },
      },
    );
  }
  return { t, asOfMs };
}

function assertEuropean(config: BlackScholesEngineConfig, contract: OptionContract): void {
  if (contract.style !== 'european') {
    throw new UnsupportedError(
      `${config.name} prices European-style options only; received style "${contract.style}". ` +
        `For American/Bermudan pricing use the engines.* factories ` +
        `(e.g. engines.binomial(), engines.bjerksundStensland2002()).`,
      {
        code: ErrorCode.EngineUnsupportedContract,
        context: { engine: config.name, style: contract.style },
      },
    );
  }
}

function proAssumptions(input: {
  engine: string;
  timeToExpiryYears: number;
  dividendYield: number;
  asOf: EpochMs;
  expiry: string;
  escrowed?: boolean;
}): Assumptions {
  const { engine, timeToExpiryYears: t, dividendYield: q, asOf, expiry, escrowed = false } = input;
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    asOf,
    timeToExpiryYears: t,
    expiryConvention: expiryConventionOf(expiry),
    dividendModel: escrowed ? 'discreteSchedule' : q === 0 ? 'none' : 'continuousYield',
    units: DEFAULT_GREEK_UNITS,
    model: MODEL,
    engine,
  };
}

function closedForm(engine: string): Diagnostics {
  return { engine, method: 'closed-form', converged: true, warnings: [] };
}

/** Price a European contract under BSM, returning value + Greeks + assumptions + diagnostics. */
export function priceContract(
  config: BlackScholesEngineConfig,
  contract: OptionContract,
  market: OptionMarket,
  options?: { greeks?: boolean; extendedGreeks?: boolean },
): PriceResult {
  const functionName = `option.price(${config.name})`;
  assertEuropean(config, contract);
  const spot = requireSpot(market, functionName);
  const vol = requireScalarVolatility(market, functionName);
  const rate = requireRate(market, functionName);
  ensurePositive(contract.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  const q = config.useDividends ? (market.dividendYield ?? 0) : 0;
  ensureFinite(q, 'dividendYield', functionName);
  const { t, asOfMs } = resolveTimeToExpiry(market.asOf, contract, functionName);

  // Discrete cash dividends are applied via the escrowed-spot model — the same handling the American
  // engines use — so `market.dividends` is never silently ignored on the dividend-aware BSM path.
  // The textbook `blackScholes` engine (`useDividends: false`) is the no-dividend model and ignores
  // both continuous and discrete dividends by design.
  const escrowed = config.useDividends && hasDiscreteDividends(market);
  const S = escrowed
    ? escrowedSpot({
        spot,
        market,
        asOf: asOfMs,
        timeToExpiryYears: t,
        riskFreeRate: rate,
        functionName,
      })
    : spot;

  const value = blackScholesPrice({
    type: contract.type,
    spot: S,
    strike: contract.strike,
    timeToExpiryYears: t,
    riskFreeRate: rate,
    dividendYield: q,
    volatility: vol,
  });
  // Honor `greeks: false` (engine-substitutability law, spec P2.4): absent Greeks mean "not
  // requested", flagged not-computed — matching the American/FD engines' contract exactly.
  // `extendedGreeks` implies `greeks` (the shared PriceOptions semantics).
  const wantExtended = options?.extendedGreeks ?? false;
  const wantGreeks = wantExtended || (options?.greeks ?? true);
  const greeks = !wantGreeks
    ? undefined
    : wantExtended
      ? blackScholesExtendedGreeks({
          type: contract.type,
          spot: S,
          strike: contract.strike,
          timeToExpiryYears: t,
          riskFreeRate: rate,
          dividendYield: q,
          volatility: vol,
        })
      : blackScholesGreeks({
          type: contract.type,
          spot: S,
          strike: contract.strike,
          timeToExpiryYears: t,
          riskFreeRate: rate,
          dividendYield: q,
          volatility: vol,
        });
  // The facade discloses an underflowed price; the PRO path must say the same thing, or the same
  // calculation is honest through one door and silent through the other.
  let diagnostics = withUnderflowDisclosure(closedForm(config.name), value);
  if (!wantGreeks) {
    diagnostics = {
      ...diagnostics,
      warnings: [
        ...diagnostics.warnings,
        {
          code: WarningCode.GreeksNotComputed,
          message: 'Greeks were not computed (greeks: false).',
          severity: 'info',
        },
      ],
    };
  } else if (wantExtended && (greeks as ExtendedGreeks).lambda === null) {
    diagnostics = withLambdaDisclosure(diagnostics, { lambda: null });
  }
  const base = {
    value,
    assumptions: proAssumptions({
      engine: config.name,
      timeToExpiryYears: t,
      dividendYield: q,
      asOf: asOfMs,
      expiry: contract.expiry,
      escrowed,
    }),
    diagnostics,
  };
  return greeks ? { ...base, greeks } : base;
}

/** Solve implied volatility for a contract from `market.price`, returning a rich envelope. */
export function impliedVolatilityContract(
  config: BlackScholesEngineConfig,
  contract: OptionContract,
  market: OptionMarket,
  options: ImpliedVolatilityOptions = {},
): ImpliedVolatilitySolveResult {
  const functionName = 'option.impliedVolatility';
  assertEuropean(config, contract);
  if (typeof market.price !== 'number') {
    throw new InputError(`${functionName}: market.price is required to solve implied volatility.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'price', function: functionName },
    });
  }
  ensurePositive(market.price, 'price', functionName);
  const spot = requireSpot(market, functionName);
  const rate = requireRate(market, functionName);
  ensurePositive(contract.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  const q = config.useDividends ? (market.dividendYield ?? 0) : 0;
  ensureFinite(q, 'dividendYield', functionName);
  const { t, asOfMs } = resolveTimeToExpiry(market.asOf, contract, functionName);

  // Discrete dividends are escrowed off the spot, consistent with pricing (above) and the American
  // engines, so the inverted vol is solved against the same effective spot.
  const escrowed = config.useDividends && hasDiscreteDividends(market);
  const S = escrowed
    ? escrowedSpot({
        spot,
        market,
        asOf: asOfMs,
        timeToExpiryYears: t,
        riskFreeRate: rate,
        functionName,
      })
    : spot;

  // Route through the full IV method suite (auto/brent/newton/halley/householder + fallback),
  // re-stamping the pro assumptions envelope (which carries asOf). Non-convergence and no-arbitrage
  // failures arrive as `diagnostics.converged: false`, never a fabricated value.
  const res = impliedVolatility(
    {
      price: market.price,
      spot: S,
      strike: contract.strike,
      timeToExpiryYears: t,
      riskFreeRate: rate,
      type: contract.type,
      dividendYield: q,
    },
    options,
  );
  return {
    value: res.value,
    assumptions: proAssumptions({
      engine: config.name,
      timeToExpiryYears: t,
      dividendYield: q,
      asOf: asOfMs,
      expiry: contract.expiry,
      escrowed,
    }),
    diagnostics: res.diagnostics,
  };
}
