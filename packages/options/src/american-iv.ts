/**
 * Engine-inverted implied volatility (spec §9.5, WS4.2).
 *
 * Closed-form Black–Scholes–Merton inverts only a European contract. Everything else — an American
 * contract, or a European contract the caller wants solved under a specific engine (a lattice with
 * discrete dividends, a custom model) — inverts the ENGINE's price over volatility with a
 * safeguarded Brent bracket. One kernel does that inversion ({@link invertEngine}); two doors dress
 * it: {@link americanImpliedVolatility} (the American door, default engine Bjerksund–Stensland
 * 2002) and `option.impliedVolatility({ contract, market, engine })` (any style with a supplied
 * engine). The kernel never fabricates a vol: a price outside the style's no-arbitrage band, at the
 * band's floor (no time value), or unreachable within the bracket fails honestly (design law #4).
 *
 * The bounds are model-free, by exercise style: an American call sits in `[max(S−K,0), S]` and an
 * American put in `[max(K−S,0), K]` (no discounting — exercise is available now); a European
 * contract sits in the discounted band `blackScholesPriceBounds` states, on the escrowed spot when
 * the market carries discrete dividends.
 */

import {
  ensureFiniteWhenPresent,
  type Assumptions,
  CONVENTIONS_VERSION,
  DEFAULT_GREEK_UNITS,
  type DividendModel,
  type EpochMs,
  ErrorCode,
  InputError,
  type OptionContract,
  type QuantWarning,
  UnsupportedError,
  ensureFinite,
  ensureKnownKeys,
  ensurePositive,
  requireArgumentObject,
  resolveValuationAsOf,
  WarningCode,
} from '@totalfinance/core';
import { brent } from '@totalfinance/math';
import { blackScholesPriceBounds } from './bsm.js';
import { escrowedSpot, hasDiscreteDividends } from './dividends.js';
import { engines, requireEngine, type OptionPricingEngine } from './engines.js';
import { requireOptionalArgObject } from './facade-util.js';
import type { ImpliedVolatilitySolveResult } from './iv.js';
import { vanillaIntrinsicUnchecked } from './payoff-kernel.js';
import { contractTimeToExpiryYears } from './time.js';
import type { OptionMarket } from './types.js';

interface InversionAssumptionsInput {
  engine: string;
  timeToExpiryYears: number;
  dividendYield: number;
  asOf: EpochMs;
  escrowed: boolean;
}

function inversionAssumptions(input: InversionAssumptionsInput): Assumptions {
  const { engine, timeToExpiryYears: t, dividendYield: q, asOf, escrowed } = input;
  const dividendModel: DividendModel = escrowed
    ? 'discreteSchedule'
    : q === 0
      ? 'none'
      : 'continuousYield';
  return {
    conventionsVersion: CONVENTIONS_VERSION,
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    asOf,
    timeToExpiryYears: t,
    dividendModel,
    units: DEFAULT_GREEK_UNITS,
    model: engine,
    engine,
  };
}

function fail(
  input: InversionAssumptionsInput & { code: string; message: string },
): ImpliedVolatilitySolveResult {
  const { engine, code, message } = input;
  return {
    value: null,
    assumptions: inversionAssumptions(input),
    diagnostics: {
      engine,
      method: 'none',
      converged: false,
      iterations: 0,
      fallback: false,
      warnings: [{ code, message, severity: 'error' }],
    },
  };
}

/** The validated economics every engine inversion starts from. */
interface InversionInputs {
  price: number;
  spot: number;
  riskFreeRate: number;
  dividendYield: number;
  asOf: EpochMs;
  timeToExpiryYears: number;
  escrowed: boolean;
}

/**
 * Validate the market and contract an inversion needs (price, spot, rate, strike, yield, asOf,
 * a positive time to expiry) with the same messages on every door.
 */
function requireInversionInputs(
  functionName: string,
  contract: OptionContract,
  market: OptionMarket,
): InversionInputs {
  if (typeof market.price !== 'number') {
    throw new InputError(`${functionName}: market.price is required to solve implied volatility.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'price', function: functionName },
    });
  }
  // A zero premium is a legitimate observation for the kernel to classify (it sits at or below the
  // style's floor); the doors refuse it before calling, so a caller asking for a vol at 0 is taught.
  ensureFinite(market.price, 'price', functionName);
  if (market.price < 0) ensurePositive(market.price, 'price', functionName);
  if (typeof market.spot !== 'number') {
    throw new InputError(`${functionName}: market.spot is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'spot', function: functionName },
    });
  }
  ensurePositive(market.spot, 'spot', functionName, ErrorCode.InputNegativeSpot);
  if (typeof market.riskFreeRate !== 'number') {
    throw new InputError(`${functionName}: market.riskFreeRate (a number) is required.`, {
      code: ErrorCode.InputMissingField,
      context: { field: 'riskFreeRate', function: functionName },
    });
  }
  ensureFinite(market.riskFreeRate, 'riskFreeRate', functionName);
  ensurePositive(contract.strike, 'strike', functionName, ErrorCode.InputNegativeStrike);
  // Null is a wrong-typed value, not omission (the 350c2796 ruling): it used to coalesce
  // to 0 BEFORE the finite check and silently price a dividend-free underlying.
  ensureFiniteWhenPresent(market.dividendYield, 'dividendYield', functionName);
  const dividendYield = market.dividendYield ?? 0;
  const asOf = resolveValuationAsOf(market.asOf, functionName);
  ensureFinite(asOf, 'asOf', functionName);
  const timeToExpiryYears = contractTimeToExpiryYears(asOf, contract, functionName);
  if (timeToExpiryYears <= 0) {
    throw new UnsupportedError(
      `${functionName}: contract expiry ${contract.expiry} is not after asOf.`,
      {
        code: ErrorCode.InputNegativeTime,
        context: { asOf: market.asOf, expiry: contract.expiry, timeToExpiryYears },
      },
    );
  }
  return {
    price: market.price,
    spot: market.spot,
    riskFreeRate: market.riskFreeRate,
    dividendYield,
    asOf,
    timeToExpiryYears,
    escrowed: hasDiscreteDividends(market),
  };
}

/** A σ bracket the inversion solves on exactly, with no widening. */
export interface EngineInversionBracket {
  lowerVolatilityBound: number;
  upperVolatilityBound: number;
}

/** A request to {@link invertEngine}; the caller has validated the market, contract and engine. */
export interface EngineInversionRequest {
  functionName: string;
  contract: OptionContract;
  market: OptionMarket;
  engine: OptionPricingEngine;
  /**
   * Explicit Brent bracket in σ. When absent, the safeguarded default `[1e-4, 5]`, widened once to
   * `[1e-6, 10]` when the root is not inside it.
   */
  bracket?: EngineInversionBracket;
}

export type EngineInversionStatus =
  | 'solved'
  | 'below-lower-bound'
  | 'above-upper-bound'
  | 'no-time-value'
  | 'no-convergence';

/** The raw outcome of one engine inversion — what the two doors and the chain-health report dress. */
export interface EngineInversion {
  status: EngineInversionStatus;
  /** The target price the inversion was asked to reproduce (per share). */
  price: number;
  /** The accepted σ, or null for every other status (never a NaN "value"). */
  value: number | null;
  /** Absolute repricing residual per share of an accepted solve; null otherwise. */
  residual: number | null;
  /** The model-free no-arbitrage band for this style; a price outside it has no volatility. */
  bounds: { lower: number; upper: number };
  iterations: number;
  /** The σ interval actually searched last. */
  bracket: [number, number];
  /** True when the default bracket had to be widened (never for an explicit bracket). */
  expanded: boolean;
  /**
   * On `no-convergence`: the engine's price at the bracket floor and ceiling, and on which side
   * the target fell outside them — the usual cause is a target under the σ→0 floor, not a fussy
   * solver.
   */
  floor: number | null;
  belowFloor: boolean;
  ceiling: number | null;
  aboveCeiling: boolean;
  timeToExpiryYears: number;
  dividendYield: number;
  escrowed: boolean;
  asOf: EpochMs;
}

/**
 * Invert `engine.price` over σ for `market.price`. This is the one inversion kernel: it decides the
 * style's bounds, refuses prices with no volatility, and searches the bracket; the doors turn the
 * outcome into their own result grammar. The engine must already support the contract.
 */
export function invertEngine(request: EngineInversionRequest): EngineInversion {
  const { functionName, contract, market, engine, bracket } = request;
  const inputs = requireInversionInputs(functionName, contract, market);
  const { price, spot: S, riskFreeRate, dividendYield: q, asOf, timeToExpiryYears: t } = inputs;
  const K = contract.strike;
  const bounds =
    contract.style === 'american'
      ? // American intrinsic (no discounting) and the no-arbitrage upper bound: an American call
        // ≤ spot, an American put ≤ strike — exercise is available now, so nothing is discounted.
        {
          lower: vanillaIntrinsicUnchecked({ type: contract.type, underlyingPrice: S, strike: K }),
          upper: contract.type === 'call' ? S : K,
        }
      : // The discounted European band, on the escrowed spot when cash dividends are scheduled —
        // the same effective spot every engine prices the contract off.
        blackScholesPriceBounds({
          type: contract.type,
          spot: escrowedSpot({
            spot: S,
            market,
            asOf,
            timeToExpiryYears: t,
            riskFreeRate,
            functionName,
          }),
          strike: K,
          timeToExpiryYears: t,
          riskFreeRate,
          dividendYield: q,
        });
  const tolerance = 1e-8 * Math.max(1, S);
  const base = {
    price,
    value: null,
    residual: null,
    bounds,
    iterations: 0,
    bracket: [bracket?.lowerVolatilityBound ?? 1e-4, bracket?.upperVolatilityBound ?? 5] as [
      number,
      number,
    ],
    expanded: false,
    floor: null,
    belowFloor: false,
    ceiling: null,
    aboveCeiling: false,
    timeToExpiryYears: t,
    dividendYield: q,
    escrowed: inputs.escrowed,
    asOf,
  };
  if (price < bounds.lower - tolerance) return { ...base, status: 'below-lower-bound' };
  if (price > bounds.upper + tolerance) return { ...base, status: 'above-upper-bound' };
  // At (or numerically at) the floor the option carries no time value, so the vol is indeterminate.
  // Reject rather than let Brent lock onto a bracket endpoint and report a fabricated σ.
  if (price <= bounds.lower + tolerance) return { ...base, status: 'no-time-value' };

  const priceAt = (sigma: number): number =>
    engine.price({ contract, market: { ...market, volatility: sigma } }).value;
  const residual = (sigma: number): number => priceAt(sigma) - price;
  const tolOpts = {
    stepTolerance: 1e-8,
    residualTolerance: 1e-10 * Math.max(1, price),
    maximumIterations: 100,
  };
  // Solve on a bracket, first sanitizing any non-finite endpoint: some engines (e.g. a Leisen–Reimer
  // lattice) return NaN at extreme σ, which would poison Brent's endpoint check even when a valid root
  // sits inside the bracket. Walk a non-finite low endpoint up / high endpoint down until both are
  // finite. The closed-form default (Bjerksund–Stensland) is finite at 1e-4, so its bracket is
  // unchanged.
  const solveBracket = (lo: number, hi: number): ReturnType<typeof brent> => {
    let a = lo;
    for (let i = 0; i < 30 && a < hi && !Number.isFinite(residual(a)); i++) a *= 2;
    let b = hi;
    for (let i = 0; i < 30 && b > a && !Number.isFinite(residual(b)); i++) b *= 0.8;
    if (!(a < b) || !Number.isFinite(residual(a)) || !Number.isFinite(residual(b))) {
      return { value: NaN, converged: false, iterations: 0, method: 'brent' };
    }
    return brent(residual, a, b, tolOpts);
  };

  let searched: [number, number] = base.bracket;
  let res = solveBracket(searched[0], searched[1]);
  let iterations = res.iterations;
  let expanded = false;
  if (!res.converged && bracket === undefined) {
    // Widen the default bracket once: deep-OTM (tiny σ) and extreme-priced (huge σ) contracts live
    // outside the default window. An explicit bracket is the caller's resolvability window and is
    // never widened.
    searched = [1e-6, 10];
    const wide = solveBracket(searched[0], searched[1]);
    iterations += wide.iterations;
    res = wide;
    expanded = true;
  }
  const accepted =
    res.converged &&
    Number.isFinite(res.value) &&
    res.value > 0 &&
    Math.abs(priceAt(res.value) - price) <= 1e-6 * Math.max(1, price);
  if (accepted) {
    return {
      ...base,
      status: 'solved',
      value: res.value,
      residual: Math.abs(priceAt(res.value) - price),
      iterations,
      bracket: searched,
      expanded,
    };
  }
  // WHY it failed matters: the usual cause is not a fussy solver but a target price BELOW the
  // engine's σ→0 floor (an American call on a non-dividend payer is worth at least S − K·e^{−rT},
  // so a quote under that has no volatility at all). That is not "below the bound" — the American
  // intrinsic is S − K and the price cleared it — so the floor and ceiling ride the outcome where a
  // caller can see the gap instead of guessing at the bracket.
  const floor = priceAt(searched[0]);
  const ceiling = priceAt(searched[1]);
  return {
    ...base,
    status: 'no-convergence',
    iterations,
    bracket: searched,
    expanded,
    floor: Number.isFinite(floor) ? floor : null,
    belowFloor: Number.isFinite(floor) && price < floor,
    ceiling: Number.isFinite(ceiling) ? ceiling : null,
    aboveCeiling: Number.isFinite(ceiling) && price > ceiling,
  };
}

/** Turn a raw inversion into the shared implied-volatility result grammar. */
function dressInversion(
  inversion: EngineInversion,
  contract: OptionContract,
  engineName: string,
): ImpliedVolatilitySolveResult {
  const style = contract.style === 'american' ? 'American' : 'European';
  const band =
    contract.style === 'american'
      ? { floor: 'the American intrinsic value', ceiling: 'the American no-arbitrage upper bound' }
      : {
          floor: 'the European no-arbitrage lower bound (the discounted intrinsic)',
          ceiling: 'the European no-arbitrage upper bound',
        };
  const assumptions: InversionAssumptionsInput = {
    engine: engineName,
    timeToExpiryYears: inversion.timeToExpiryYears,
    dividendYield: inversion.dividendYield,
    asOf: inversion.asOf,
    escrowed: inversion.escrowed,
  };
  switch (inversion.status) {
    case 'below-lower-bound':
      return fail({
        ...assumptions,
        code: ErrorCode.ImpliedVolatilityBelowIntrinsic,
        message: `price is below ${band.floor}`,
      });
    case 'above-upper-bound':
      return fail({
        ...assumptions,
        code: ErrorCode.ImpliedVolatilityAboveMax,
        message: `price exceeds ${band.ceiling}`,
      });
    case 'no-time-value':
      return fail({
        ...assumptions,
        code: ErrorCode.ImpliedVolatilityBelowIntrinsic,
        message: `price is at ${band.floor} (no time value); implied volatility is indeterminate`,
      });
    case 'solved':
    case 'no-convergence': {
      const warnings: QuantWarning[] = [];
      const converged = inversion.status === 'solved';
      if (inversion.expanded && converged) {
        warnings.push({
          code: WarningCode.ImpliedVolatilityBracketExpanded,
          message:
            'the [1e-4, 5] bracket did not contain the root; solved on the expanded [1e-6, 10] bracket',
          severity: 'info',
        });
      }
      if (!converged) {
        const { price, floor, belowFloor, ceiling, aboveCeiling, bracket } = inversion;
        const message =
          belowFloor && floor !== null
            ? `price ${price} is below this engine's σ→0 price floor ${floor}; no volatility reproduces it`
            : aboveCeiling && ceiling !== null
              ? `price ${price} is above this engine's price ceiling ${ceiling} at σ = ${bracket[1]}; no volatility in the bracket reproduces it`
              : `Brent did not converge on an ${style} implied volatility within the safeguarded bracket`;
        warnings.push({
          code: ErrorCode.ImpliedVolatilityNoConvergence,
          message,
          severity: 'error',
          context: { price, floor, belowFloor, ceiling, aboveCeiling, bracket },
        });
      }
      return {
        // Law 7 / E3: a failed solve is `null` (the reason rides diagnostics), never a NaN "value" —
        // the declared type and the doc have always promised null.
        value: converged ? inversion.value : null,
        assumptions: inversionAssumptions(assumptions),
        diagnostics: {
          engine: engineName,
          method: 'brent',
          converged,
          iterations: inversion.iterations,
          fallback: inversion.expanded,
          warnings,
        },
      };
    }
  }
}

/** Input for {@link engineImpliedVolatility}: a validated-shape request from a routing door. */
export interface EngineImpliedVolatilityInput {
  functionName: string;
  contract: OptionContract;
  market: OptionMarket;
  engine: OptionPricingEngine;
}

/**
 * Invert a supplied engine for any exercise style and answer in the shared implied-volatility
 * grammar. Internal to the package: `option.impliedVolatility` routes here when the caller names
 * an engine, and {@link americanImpliedVolatility} is the public American door.
 */
export function engineImpliedVolatility(
  input: EngineImpliedVolatilityInput,
): ImpliedVolatilitySolveResult {
  const { functionName, contract, market, engine } = input;
  requireEngine(functionName, engine);
  if (typeof market.price === 'number') ensurePositive(market.price, 'price', functionName);
  // The framework enforces `supports()` on every inversion exactly as `option.price` does, so a
  // European-only engine handed an American contract fails the same way in both directions.
  if (!engine.supports(contract)) {
    throw new UnsupportedError(
      `engineImpliedVolatility: Engine "${engine.name}" does not support this contract ` +
        `(style "${contract.style}", type "${contract.type}").`,
      {
        code: ErrorCode.EngineUnsupportedContract,
        context: { engine: engine.name, style: contract.style, type: contract.type },
      },
    );
  }
  return dressInversion(
    invertEngine({ functionName, contract, market, engine }),
    contract,
    engine.name,
  );
}

/** Options for {@link americanImpliedVolatility}. Mirrors the subset of `ImpliedVolatilityOptions` it honours. */
export interface AmericanImpliedVolatilityOptions {
  /**
   * Engine to invert. Default `engines.bjerksundStensland2002()`. Pass e.g. a binomial engine to
   * handle discrete dividends — the inversion is generic and the reported engine follows the override.
   */
  engine?: OptionPricingEngine;
}

/** One cohesive request for American implied-volatility inversion. */
export interface AmericanImpliedVolatilityInput {
  contract: OptionContract;
  market: OptionMarket;
  options?: AmericanImpliedVolatilityOptions;
}

/** Law 12 allowlist for {@link AmericanImpliedVolatilityOptions}. */
const AMERICAN_IV_KEYS = ['engine'] as const;
const AMERICAN_IV_REQUEST_KEYS = ['contract', 'market', 'options'] as const;

/**
 * Solve the implied volatility of an American contract from `market.price` by inverting an American
 * pricing engine over σ with a safeguarded Brent bracket (`[1e-4, 5]`, expanded once to `[1e-6, 10]`).
 * No-arbitrage bounds use the American intrinsic (`max(S−K,0)` calls, `max(K−S,0)` puts, no
 * discounting): a price below intrinsic, above the upper bound, or at intrinsic (no time value to
 * imply a vol) fails honestly instead of returning a fabricated number. A European contract is
 * refused — its door is `option.impliedVolatility`, closed-form by default or engine-inverted when
 * an engine is named.
 */
export function americanImpliedVolatility(
  input: AmericanImpliedVolatilityInput,
): ImpliedVolatilitySolveResult {
  requireArgumentObject('americanImpliedVolatility', 'input', input);
  ensureKnownKeys('americanImpliedVolatility', 'input', input, AMERICAN_IV_REQUEST_KEYS);
  const { contract, market, options: options = {} } = input;
  requireArgumentObject('americanImpliedVolatility', 'contract', contract);
  requireArgumentObject('americanImpliedVolatility', 'market', market);
  const functionName = 'option.impliedVolatility';
  // `null` (or a primitive) slips past `options = {}` — teach, never TypeError on `options.engine`.
  requireOptionalArgObject(functionName, 'options', options);
  if ((options as unknown as Record<string, unknown>)['engine'] === null) {
    throw new InputError(
      `americanImpliedVolatility: engine must not be null — omit the field to use the default engine. Received null.`,
      { code: ErrorCode.InputWrongType, context: { field: 'engine' } },
    );
  }
  // Contract/market artifacts may carry provenance metadata; the closed options object remains strict.
  ensureKnownKeys(functionName, 'options', options, AMERICAN_IV_KEYS);
  if (contract.style !== 'american') {
    throw new UnsupportedError(
      `americanImpliedVolatility: inverts American exercise only; this contract is "${contract.style}". ` +
        'Use option.impliedVolatility({ contract, market }) for the closed-form European inverse, or ' +
        'option.impliedVolatility({ contract, market, engine }) to invert a specific engine.',
      {
        code: ErrorCode.EngineUnsupportedContract,
        context: { function: 'americanImpliedVolatility', style: contract.style },
      },
    );
  }
  return engineImpliedVolatility({
    functionName,
    contract,
    market,
    engine: options.engine ?? engines.bjerksundStensland2002(),
  });
}
