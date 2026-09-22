/**
 * The pro API namespace `option` (spec §5.2, §5.3).
 *
 * Pro APIs take cohesive named request objects and always return rich `Computed` envelopes (value +
 * assumptions + diagnostics). There is no `.explain()` here — that is a facade-only affordance;
 * pro results are already explained. Quantitative failures are reported via
 * `diagnostics.converged`, not thrown.
 */

import {
  InputError,
  ErrorCode,
  type OptionContract,
  UnsupportedError,
  ensureKnownKeys,
  requireArgumentObject,
} from '@totalfinance/core';
import { americanImpliedVolatility, engineImpliedVolatility } from './american-iv.js';
import {
  callContract,
  european,
  putContract,
  usEquityCall,
  usEquityOption,
  usEquityPut,
} from './contract.js';
import { impliedVolatilityContract } from './engine-bsm.js';
import {
  compareEngines,
  engines,
  requireEngine,
  type OptionPricingEngine,
  type PriceOptions,
} from './engines.js';
import type { ImpliedVolatilityOptions, ImpliedVolatilitySolveResult } from './iv.js';
import type { OptionMarket, PriceResult } from './types.js';

const DEFAULT_IV_CONFIG = { name: 'black-scholes-merton', useDividends: true } as const;

/**
 * The default engine auto-selects by contract (spec §9.3 / WS4.1): European contracts price with the
 * closed-form Black–Scholes–Merton model — byte-identical to the prior default — while American
 * contracts now route to the appropriate lattice/closed-form approximation instead of throwing.
 */
const defaultEngine: OptionPricingEngine = engines.auto();

/** Input for {@link priceOption} — ONE options-bearing object (alignment spec P3.5b). */
export interface PriceOptionInput extends PriceOptions {
  contract: OptionContract;
  /** Market snapshot. `asOf` is required on the market; the clock is never read. */
  market: OptionMarket;
  /** Engine override; defaults to {@link engines.auto} (European → BSM, American → lattice/approx). */
  engine?: OptionPricingEngine;
}

/**
 * Price a contract. ONE object input — `option.price({ contract, market, engine?, greeks?,
 * extendedGreeks? })` — so requesting per-call options never requires a positional
 * `undefined` hole (spec P3.5b; the positional form is deleted, pre-release). `greeks: false`
 * flows to the engine: a Monte-Carlo engine skips its Greek budget, and the result's `greeks`
 * is then absent rather than fabricated.
 */
const PRICE_INPUT_KEYS = ['contract', 'market', 'engine', 'greeks', 'extendedGreeks'] as const;

/**
 * When-present ladders for the pro option shape (the 350c2796 ruling): `engine: null` used to
 * coalesce into the default engine — the caller thought THEIR engine priced — and a truthy-string
 * flag silently toggled greeks or the failFast path.
 */
function requirePriceOptionLadders(functionName: string, input: Record<string, unknown>): void {
  if (input['engine'] === null) {
    throw new InputError(
      `${functionName}: engine must not be null — omit the field to use the auto default. Received null.`,
      { code: ErrorCode.InputWrongType, context: { field: 'engine' } },
    );
  }
  const engineValue = input['engine'];
  if (engineValue !== undefined && (engineValue === null || typeof engineValue !== 'object')) {
    throw new InputError(
      `${functionName}: engine must be a pricing engine object when provided — omit the field to use the auto default. Received ${engineValue === null ? 'null' : typeof engineValue}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'engine' } },
    );
  }
  const methodValue = input['method'];
  if (
    methodValue !== undefined &&
    methodValue !== 'auto' &&
    methodValue !== 'brent' &&
    methodValue !== 'newton' &&
    methodValue !== 'halley' &&
    methodValue !== 'householder'
  ) {
    throw new InputError(
      `${functionName}: method must be 'auto' | 'brent' | 'newton' | 'halley' | 'householder' when provided. Received ${methodValue === null ? 'null' : JSON.stringify(methodValue)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'method' } },
    );
  }
  const fallbackValue = input['fallback'];
  if (fallbackValue !== undefined && typeof fallbackValue !== 'boolean') {
    throw new InputError(
      `${functionName}: fallback must be a boolean when provided. Received ${fallbackValue === null ? 'null' : typeof fallbackValue}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'fallback' } },
    );
  }
  for (const flag of ['greeks', 'extendedGreeks', 'failFast'] as const) {
    const value = input[flag];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new InputError(
        `${functionName}: ${flag} must be a boolean when provided. Received ${value === null ? 'null' : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: flag } },
      );
    }
  }
  for (const field of ['confidence', 'boundaryPoints'] as const) {
    const value = input[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new InputError(
        `${functionName}: ${field} must be a finite number when provided. Received ${value === null ? 'null' : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
}

export function priceOption(input: PriceOptionInput): PriceResult {
  requireArgumentObject('option.price', 'input', input);
  requirePriceOptionLadders('option.price', input as unknown as Record<string, unknown>);
  // Law 12: a misspelled option (`greek: false`) must teach, never silently compute Greeks anyway.
  ensureKnownKeys('option.price', 'input', input, PRICE_INPUT_KEYS);
  const { contract, market, engine, ...options } = input;
  requireArgumentObject('option.price', 'input.contract', contract);
  requireArgumentObject('option.price', 'input.market', market);
  const chosen = engine ?? defaultEngine;
  // A non-engine value would crash as `chosen.supports is not a function` — teach instead.
  requireEngine('option.price', chosen);
  // The framework enforces `supports()` so every engine — built-in, custom, or the auto default —
  // fails the same way on an unsupported contract, rather than relying on each engine to self-police.
  if (!chosen.supports(contract)) {
    throw new UnsupportedError(
      `option.price: Engine "${chosen.name}" does not support this contract ` +
        `(style "${contract.style}", type "${contract.type}").`,
      {
        code: ErrorCode.EngineUnsupportedContract,
        context: { engine: chosen.name, style: contract.style, type: contract.type },
      },
    );
  }
  return chosen.price({ contract, market, options });
}

/**
 * Solve implied volatility from `market.price`, returning a rich envelope with diagnostics. Routes on
 * contract style and on whether an engine is named (WS4.2): a European contract with no engine
 * inverts closed-form Black–Scholes–Merton (`method` chooses `auto`/`brent`/`newton`/`halley`/
 * `householder`, `fallback` and `failFast` shape it); an American contract, or any contract with an
 * `engine`, inverts that engine (default Bjerksund–Stensland 2002 for American) over a safeguarded
 * Brent bracket, where the closed-form knobs do not apply and are refused. The engine and
 * actually-used method are reported in `diagnostics`.
 */
/** Input for {@link impliedVolatilityOption} — one object: `{ contract, market, ...solver options }`. */
export interface ImpliedVolatilityOptionInput extends ImpliedVolatilityOptions {
  contract: OptionContract;
  market: OptionMarket;
  /**
   * Engine to invert numerically. An American contract always inverts an engine (default
   * `engines.bjerksundStensland2002()`); a European contract inverts closed-form
   * Black–Scholes–Merton unless an engine is named here, in which case THAT engine is inverted —
   * e.g. a lattice for discrete dividends, or a custom model. `method`/`fallback`/`failFast` belong
   * to the closed-form route and are refused alongside an engine.
   */
  engine?: OptionPricingEngine;
}

const IV_INPUT_KEYS = ['contract', 'market', 'method', 'fallback', 'failFast', 'engine'] as const;

export function impliedVolatilityOption(
  input: ImpliedVolatilityOptionInput,
): ImpliedVolatilitySolveResult {
  requireArgumentObject('option.impliedVolatility', 'input', input);
  requirePriceOptionLadders(
    'option.impliedVolatility',
    input as unknown as Record<string, unknown>,
  );
  ensureKnownKeys('option.impliedVolatility', 'input', input, IV_INPUT_KEYS);
  const { contract, market, engine, ...options } = input;
  requireArgumentObject('option.impliedVolatility', 'input.contract', contract);
  requireArgumentObject('option.impliedVolatility', 'input.market', market);
  const inverting = contract.style === 'american' || engine !== undefined;
  if (inverting) {
    // Law 12: an engine route inverts the ENGINE over a safeguarded Brent bracket — there is no
    // closed-form derivative to run Newton/Halley/Householder on, and no second method to fall back
    // to or fail fast between. Accepting `method`/`fallback`/`failFast` here and dropping them on the
    // floor would answer a question the caller did not ask (and read as "newton ran"), so say so.
    const ignored = (['method', 'fallback', 'failFast'] as const).filter(
      (key) => options[key] !== undefined,
    );
    if (ignored.length > 0) {
      const named = `${ignored.map((k) => `"${k}"`).join(', ')} ${ignored.length === 1 ? 'is' : 'are'}`;
      throw new UnsupportedError(
        contract.style === 'american'
          ? `option.impliedVolatility: ${named} not supported for an AMERICAN contract — that route ` +
              'inverts an American pricing engine over a safeguarded Brent bracket, so solver-method ' +
              'selection does not apply. It honors "engine" (default engines.bjerksundStensland2002(); ' +
              'pass e.g. engines.binomial({ variant: "leisen-reimer" }) for discrete dividends). ' +
              'Method selection applies to EUROPEAN contracts, which invert closed-form Black–Scholes–Merton.'
          : `option.impliedVolatility: ${named} not supported when an "engine" is named — that route ` +
              `inverts engine "${engine!.name}" over a safeguarded Brent bracket, so solver-method ` +
              'selection does not apply. Omit "engine" to invert closed-form Black–Scholes–Merton with ' +
              'the method suite, or omit the solver knobs to invert the engine.',
        {
          code: ErrorCode.EngineUnsupportedContract,
          context: {
            function: 'option.impliedVolatility',
            style: contract.style,
            ignored,
            honored: ['engine'],
          },
        },
      );
    }
    if (contract.style === 'american')
      return americanImpliedVolatility({
        contract,
        market,
        options: engine ? { engine } : {},
      });
    return engineImpliedVolatility({
      functionName: 'option.impliedVolatility',
      contract,
      market,
      engine: engine!,
    });
  }
  return impliedVolatilityContract(DEFAULT_IV_CONFIG, contract, market, options);
}

/**
 * The `option` namespace combines contract builders with pro pricing:
 *   - `option.call(...)` / `option.put(...)` build contracts,
 *   - `option.price({ contract, market, engine? })` prices them,
 *   - `option.impliedVolatility({ contract, market, engine? })` inverts a price,
 *   - `option.compareEngines({ contract, market, options? })` benchmarks engines against each other.
 *
 * @example
 * ```ts
 * import { market, option } from '@insiderfinance/totalfinance/options';
 *
 * const contract = option.usEquityCall({ underlying: 'AAPL', strike: 200, expiry: '2026-09-18' });
 * const result = option.price({
 *   contract,
 *   market: market({ spot: 195.3, riskFreeRate: 0.045, volatility: 0.24, asOf: '2026-07-20T10:30:00-04:00' }),
 * });
 * result.value;          // premium per share
 * result.greeks?.delta;  // engine-reported Greeks
 * const solved = option.impliedVolatility({
 *   contract,
 *   market: market({ spot: 195.3, riskFreeRate: 0.045, price: 4.1, asOf: '2026-07-20T10:30:00-04:00' }),
 * });
 * solved.diagnostics.converged; // check before trusting solved.value
 * ```
 */
export const option = {
  call: callContract,
  put: putContract,
  usEquityCall,
  usEquityPut,
  usEquityOption,
  european,
  price: priceOption,
  impliedVolatility: impliedVolatilityOption,
  compareEngines,
} as const;
