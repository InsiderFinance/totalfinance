/**
 * The Gate C reference adapter: `option.price` exposed through the `@insiderfinance/totalfinance/core/pricing`
 * `Pricer` protocol (`docs/specs/gate-c-extension-contracts.md`).
 *
 * This file contains ZERO pricing mathematics — it is the existence proof that the protocol adds
 * none (the no-second-engine law). It declares what `option.price` consumes as typed market
 * requirements, maps satisfied observations onto the EXISTING `OptionMarket` shape, calls the
 * EXISTING `option.price`, and returns the EXISTING `PriceResult` envelope untouched — except for
 * one additive disclosure: an explicit-mode `diagnostics.selection` report when the caller pinned
 * the engine (the automatic report is emitted by `engines.auto()` itself, at the routing site
 * that owns the decision).
 *
 * The adapter therefore has a PROVABLE parity law: for the same contract and equivalent market,
 * `pricer.price(...)` and `option.price(...)` agree bit-for-bit on value, Greeks, and assumptions
 * (`packages/options/test/pricer-adapter.test.ts`).
 */

import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  type OptionContract,
} from '@totalfinance/core';
import {
  definePricer,
  optionalObservationValue,
  requireObservationValue,
  type MarketRequirement,
  type Pricer,
  type PricerPriceInput,
} from '@totalfinance/core/pricing';
import { engines, requireEngine, type OptionPricingEngine } from './engines.js';
import { priceOption } from './pro.js';
import type { OptionMarket, PriceResult } from './types.js';

/** Adapter identity, reported via `definePricer` and usable in selection/diagnostics tooling. */
export const OPTION_CONTRACT_PRICER_NAME = 'options.option-contract';
const PRICER_VERSION = '0.0.1';

const FACTORY_KEYS = ['engine'] as const;
const PRICE_KEYS = ['instrument', 'observations', 'request'] as const;
// `seed` is part of the closed protocol request grammar (PricerValuationRequest) and is accepted
// here so the randomness-'none' seed-ignoring law holds: this adapter never reads it (see the
// capabilities note below), and refusing it as an unknown key would break the law that a 'none'
// pricer ignores a supplied seed entirely.
const REQUEST_KEYS = ['greeks', 'seed'] as const;

export interface OptionContractPricerOptions {
  /**
   * Explicit engine selection — the same engine objects `option.price` accepts (`engines.*` or
   * `defineOptionPricingEngine(...)`). Omit for automatic selection via `engines.auto()`; either
   * way the result's `diagnostics.selection` discloses who priced and why. Passing `engines.auto()`
   * here yields an AUTOMATIC report — auto genuinely chose, and the report never pretends
   * otherwise.
   */
  engine?: OptionPricingEngine;
}

/**
 * The market requirements pricing `contract` consumes, as data. `riskFreeRate` is keyed by the
 * contract's currency, defaulting to `'USD'` exactly as the contract metadata does; `dividendYield`
 * is OPTIONAL with the workspace-disclosed default of 0 (`assumptions.dividendModel` on the result
 * says which model actually applied — the no-silent-economics disclosure already lives in the
 * wrapped function, not in this adapter).
 */
function contractRequirements(contract: OptionContract): readonly MarketRequirement[] {
  return [
    { kind: 'valuationInstant' },
    { kind: 'spot', symbol: contract.underlying },
    {
      kind: 'impliedVolatility',
      symbol: contract.underlying,
      strike: contract.strike,
      expiresAt: contract.expiresAt,
    },
    { kind: 'riskFreeRate', currency: contract.currency ?? 'USD' },
    { kind: 'dividendYield', symbol: contract.underlying, optional: true },
  ];
}

/**
 * Build a `Pricer<OptionContract, PriceResult>` around the EXISTING `option.price`.
 *
 * `optionContractPricer()` — automatic engine selection (`engines.auto()`), disclosed candidate by
 * candidate in `diagnostics.selection`. `optionContractPricer({ engine: engines.binomial({ steps:
 * 501 }) })` — explicit selection, disclosed as explicit. The `greeks` capability is inherited from
 * the chosen engine's own verified capabilities, never re-asserted; `randomness` is `'none'` for
 * every engine (see the capabilities note below — engine randomness is construction-seeded, so the
 * wrapped engine is per-instance deterministic).
 */
export function optionContractPricer(
  options: OptionContractPricerOptions = {},
): Pricer<OptionContract, PriceResult> {
  const factoryName = 'optionContractPricer';
  requireArgumentObject(factoryName, 'options', options);
  ensureKnownKeys(factoryName, 'options', options, FACTORY_KEYS);
  const explicit = options.engine;
  if (explicit !== undefined) requireEngine(factoryName, explicit);
  const engine = explicit ?? engines.auto();

  const functionName = `${factoryName}.price`;
  return definePricer<OptionContract, PriceResult>({
    name: OPTION_CONTRACT_PRICER_NAME,
    version: PRICER_VERSION,
    capabilities: {
      greeks: engine.capabilities.greeks,
      // 'none' for EVERY engine, including the stochastic ones (2026-08-23, second external
      // review — PricerCapabilities.deterministic → randomness): options engines that draw
      // (Monte Carlo, local vol) REQUIRE their seed at engine construction and echo it on the
      // result, so the engine object this adapter wraps is a pure function of
      // (contract, market) — its randomness was consumed when the caller built the engine, never
      // per call. That makes repeat-call byte-identity (the 'none' law) the verifiable truth
      // here, while a per-call `request.seed` has no engine input to flow into and is ignored
      // (callers who want a different draw build a different engine; the engine's own
      // `deterministic` flag keeps meaning "closed-form vs seeded method" in the options
      // engine-contract suite).
      randomness: 'none',
      // The options batch paths (`@insiderfinance/totalfinance/options/batch`) are strike/vol-columnar over ONE
      // market, not instrument-columnar over one observation set; the batch adapter is specified
      // in the Gate C design doc and lands with a measured consumer. Claiming `batch: true` here
      // would be unverified capability marketing.
      batch: false,
    },
    supports: (instrument) => engine.supports(instrument),
    requirements: (instrument) => {
      requireArgumentObject(factoryName, 'instrument', instrument);
      return contractRequirements(instrument);
    },
    price: (input: PricerPriceInput<OptionContract>): PriceResult => {
      requireArgumentObject(functionName, 'input', input);
      ensureKnownKeys(functionName, 'input', input, PRICE_KEYS);
      const { instrument, observations, request } = input;
      requireArgumentObject(functionName, 'input.instrument', instrument);
      if (request !== undefined) {
        requireArgumentObject(functionName, 'input.request', request);
        ensureKnownKeys(functionName, 'input.request', request, REQUEST_KEYS);
        if (request.greeks !== undefined && typeof request.greeks !== 'boolean') {
          throw new InputError(`${functionName}: input.request.greeks must be a boolean.`, {
            code: ErrorCode.InputWrongType,
            context: { function: functionName, field: 'input.request.greeks' },
          });
        }
        if (
          request.seed !== undefined &&
          (typeof request.seed !== 'number' ||
            !Number.isSafeInteger(request.seed) ||
            request.seed < 0)
        ) {
          throw new InputError(
            `${functionName}: input.request.seed must be a non-negative safe integer when supplied.`,
            {
              code: ErrorCode.InputOutOfRange,
              context: { function: functionName, field: 'input.request.seed' },
            },
          );
        }
      }

      // Satisfy the declared requirements — nothing more. A missing required observation throws
      // the protocol's teaching error; an undeclared observation is structurally unreachable from
      // here, which is exactly what the conformance kit's independence probe verifies.
      const asOf = requireObservationValue(functionName, observations, {
        kind: 'valuationInstant',
      });
      const spot = requireObservationValue(functionName, observations, {
        kind: 'spot',
        symbol: instrument.underlying,
      });
      const volatility = requireObservationValue(functionName, observations, {
        kind: 'impliedVolatility',
        symbol: instrument.underlying,
        strike: instrument.strike,
        expiresAt: instrument.expiresAt,
      });
      const riskFreeRate = requireObservationValue(functionName, observations, {
        kind: 'riskFreeRate',
        currency: instrument.currency ?? 'USD',
      });
      const dividendYield = optionalObservationValue(functionName, observations, {
        kind: 'dividendYield',
        symbol: instrument.underlying,
      });

      // The EXISTING market shape and the EXISTING entrypoint — the adapter maps, never re-prices.
      const market: OptionMarket = {
        spot,
        riskFreeRate,
        volatility,
        asOf,
        ...(dividendYield !== undefined ? { dividendYield } : {}),
      };
      const result = priceOption({
        contract: instrument,
        market,
        engine,
        ...(request?.greeks !== undefined ? { greeks: request.greeks } : {}),
      });

      // Selection disclosure: a meta-engine (auto) reports its own automatic selection at the
      // routing site; any result that already carries a report keeps it. Otherwise the caller
      // pinned this engine, and the report says so — explicitly, with nothing "considered".
      if (result.diagnostics.selection !== undefined) return result;
      return {
        ...result,
        diagnostics: {
          ...result.diagnostics,
          selection: {
            mode: 'explicit',
            selected: { name: engine.name, version: engine.version },
            reason: `caller-selected: optionContractPricer({ engine }) named "${engine.name}" explicitly.`,
          },
        },
      };
    },
  });
}
