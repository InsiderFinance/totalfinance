/**
 * The fill-model conformance suite (Stage 4.6, FC8 Decision 7): what a caller-supplied model must
 * satisfy before an engine will trust it. Pure and deterministic; the same decision twice for the
 * same inputs; never a price outside the observation's range; never more than the order asked;
 * finite, JSON-safe decisions; inputs untouched. The built-in models pass it; a custom one that
 * does not is refused with `backtest.adapter_nonconformant` naming the check that failed.
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import {
  hasOwn,
  requireFillContext,
  requireFillModel,
  requireMarketObservation,
  requireOrderIntent,
} from './validate.js';
import type {
  FillContext,
  FillDecision,
  FillModel,
  MarketObservation,
  OrderIntent,
} from './types.js';

export interface FillModelFixture {
  order: OrderIntent;
  observation: MarketObservation;
  context: FillContext;
}

export interface AssertFillModelConformanceInput {
  fillModel: FillModel;
  /** Caller fixtures run beside the built-in ones for the model's observation kind. */
  fixtures?: readonly FillModelFixture[];
}

export interface FillModelConformanceResult {
  conformant: true;
  label: string;
  version: string;
  observation: MarketObservation['kind'];
  checks: string[];
  fixturesRun: number;
}

const T0 = Date.UTC(2026, 0, 5, 14, 30);

/** A deep copy of plain JSON data (the only kind these boundaries accept); typed, lib-free. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function baseContext(): FillContext {
  return {
    asOf: T0,
    partialFills: 'allow',
    staleQuotes: { maximumAgeMs: null, behavior: 'fill-at-last' },
    lockedCrossed: 'fill-at-mid',
    queue: { model: 'depth-approximation' },
  };
}

function order(overrides: Partial<OrderIntent>): OrderIntent {
  return {
    orderId: 'o-1',
    instrumentId: 'XYZ',
    side: 'buy',
    quantity: 100,
    type: 'market',
    submittedTimestampMs: T0 - 60_000,
    ...overrides,
  };
}

/** The built-in fixtures for each observation kind — one per order type and side. */
function builtInFixtures(kind: MarketObservation['kind']): FillModelFixture[] {
  const context = baseContext();
  const orders: OrderIntent[] = [
    order({ type: 'market' }),
    order({ orderId: 'o-2', side: 'sell', type: 'market' }),
    order({ orderId: 'o-3', type: 'limit', limitPrice: 99.5 }),
    order({ orderId: 'o-4', side: 'sell', type: 'limit', limitPrice: 100.5 }),
    order({ orderId: 'o-5', type: 'stop', stopPrice: 100.5 }),
    order({ orderId: 'o-6', side: 'sell', type: 'stop', stopPrice: 99.5 }),
    order({ orderId: 'o-7', type: 'stop-limit', stopPrice: 100.5, limitPrice: 101 }),
    order({ orderId: 'o-8', type: 'market-on-open' }),
    order({ orderId: 'o-9', type: 'market-on-close' }),
    order({ orderId: 'o-10', quantity: 1_000_000, type: 'market' }),
  ];
  let observation: MarketObservation;
  switch (kind) {
    case 'bar':
      observation = {
        kind: 'bar',
        bar: {
          symbol: 'XYZ',
          timestampMs: T0,
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 10_000,
        },
      };
      break;
    case 'quote':
      observation = {
        kind: 'quote',
        quote: {
          symbol: 'XYZ',
          timestampMs: T0,
          bid: 99.9,
          ask: 100.1,
          bidSize: 500,
          askSize: 400,
        },
      };
      break;
    case 'trade':
      observation = {
        kind: 'trade',
        trade: { symbol: 'XYZ', timestampMs: T0, price: 100, size: 300 },
      };
      break;
    case 'order-book':
      observation = {
        kind: 'order-book',
        book: {
          symbol: 'XYZ',
          timestampMs: T0,
          bids: [
            { price: 99.9, size: 200 },
            { price: 99.8, size: 300 },
          ],
          asks: [
            { price: 100.1, size: 150 },
            { price: 100.2, size: 250 },
          ],
        },
      };
      break;
  }
  return orders.map((o) => ({
    order: o,
    observation,
    context: { ...context, participation: 0.5 },
  }));
}

function observationRange(observation: MarketObservation): { low: number; high: number } | null {
  switch (observation.kind) {
    case 'bar':
      return { low: observation.bar.low, high: observation.bar.high };
    case 'quote':
      return {
        low: Math.min(observation.quote.bid, observation.quote.ask),
        high: Math.max(observation.quote.bid, observation.quote.ask),
      };
    case 'trade':
      return { low: observation.trade.price, high: observation.trade.price };
    case 'order-book': {
      const prices = [...observation.book.bids, ...observation.book.asks].map(
        (level) => level.price,
      );
      if (prices.length === 0) return null;
      return { low: Math.min(...prices), high: Math.max(...prices) };
    }
  }
}

function isJsonSafeFinite(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonSafeFinite);
  if (typeof value === 'object') {
    return (
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value as object).every(isJsonSafeFinite)
    );
  }
  return false;
}

function fail(check: string, label: string, detail: string): never {
  throw new InputError(
    `assertFillModelConformance: fill model '${label}' failed the check "${check}" — ${detail}. A fill model must be pure, deterministic, fill inside the observation it read, never exceed the order, and return a finite JSON-safe decision.`,
    { code: ErrorCode.BacktestAdapterNonconformant, context: { check, fillModel: label } },
  );
}

/**
 * Run the conformance suite over the built-in fixtures for the model's observation kind and any
 * caller fixtures. Returns the checks that passed; throws `backtest.adapter_nonconformant` on the
 * first failure, naming the check.
 */
export function assertFillModelConformance(
  input: AssertFillModelConformanceInput,
): FillModelConformanceResult {
  const functionName = 'assertFillModelConformance';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['fillModel', 'fixtures']);
  let fillModel: FillModel;
  try {
    requireFillModel(functionName, 'input.fillModel', input.fillModel);
    fillModel = input.fillModel;
  } catch (error) {
    // The suite's own verdict for a malformed model: nonconformant, naming what is missing.
    fail(
      'model-shape',
      String((input.fillModel as { label?: unknown } | null)?.label ?? input.fillModel),
      error instanceof Error ? error.message : String(error),
    );
  }
  const label = fillModel.label;
  const callerFixtures: FillModelFixture[] = [];
  if (hasOwn(input, 'fixtures')) {
    if (!Array.isArray(input.fixtures)) {
      throw new InputError(
        `${functionName}: input.fixtures must be an array of { order, observation, context } when given (omit it to run the built-in fixtures only). Received ${input.fixtures === null ? 'null' : typeof input.fixtures}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'fixtures' } },
      );
    }
    input.fixtures.forEach((fixture, index) => {
      const path = `input.fixtures[${index}]`;
      requireArgumentObject(functionName, path, fixture);
      ensureKnownKeys(functionName, path, fixture, ['order', 'observation', 'context']);
      requireOrderIntent(functionName, `${path}.order`, fixture.order);
      requireMarketObservation(functionName, `${path}.observation`, fixture.observation);
      requireFillContext(functionName, `${path}.context`, fixture.context);
      callerFixtures.push(fixture);
    });
  }
  const fixtures = [...builtInFixtures(fillModel.observation), ...callerFixtures];
  const checks = new Set<string>();
  fixtures.forEach((fixture, index) => {
    // The model receives the fixture's OWN objects so a mutation is visible afterwards; the second
    // call receives clones so a model that keys on identity cannot pass by accident.
    const before = canonicalJsonOf({
      order: fixture.order,
      observation: fixture.observation,
      context: fixture.context,
    });
    let decision: FillDecision;
    let again: FillDecision;
    try {
      decision = fillModel.fill({
        order: fixture.order,
        observation: fixture.observation,
        context: fixture.context,
      });
      again = fillModel.fill(
        cloneJson({
          order: fixture.order,
          observation: fixture.observation,
          context: fixture.context,
        }),
      );
    } catch (error) {
      if (error instanceof InputError && error.code === ErrorCode.BacktestStaleQuote) {
        // A refusal the policy asked for is conformant behaviour, not a defect.
        checks.add('stale-quote-refusal-is-typed');
        return;
      }
      fail(
        'no-throw',
        label,
        `fixture ${index} threw ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      canonicalJsonOf({
        order: fixture.order,
        observation: fixture.observation,
        context: fixture.context,
      }) !== before
    ) {
      fail('immutability', label, `fixture ${index}: the model mutated its inputs`);
    }
    checks.add('immutability');
    if (!isJsonSafeFinite(decision))
      fail(
        'json-safe-finite',
        label,
        `fixture ${index}: the decision is not finite JSON-safe data`,
      );
    checks.add('json-safe-finite');
    if (canonicalJsonOf(decision) !== canonicalJsonOf(again))
      fail('determinism', label, `fixture ${index}: two calls disagree`);
    checks.add('determinism');
    if (decision.outcome !== 'filled' && decision.outcome !== 'unfilled') {
      fail('closed-outcome', label, `fixture ${index}: outcome must be 'filled' | 'unfilled'`);
    }
    checks.add('closed-outcome');
    if (decision.outcome === 'filled') {
      if (!(decision.quantity > 0) || decision.quantity > fixture.order.quantity + 1e-12) {
        fail(
          'quantity-within-order',
          label,
          `fixture ${index}: filled ${decision.quantity} of ${fixture.order.quantity}`,
        );
      }
      checks.add('quantity-within-order');
      if (decision.partial !== decision.quantity < fixture.order.quantity - 1e-12) {
        fail(
          'partial-flag',
          label,
          `fixture ${index}: partial must be true exactly when the fill is short of the order`,
        );
      }
      checks.add('partial-flag');
      const range = observationRange(fixture.observation);
      if (range !== null && decision.clampedToPriceLimit !== true) {
        if (
          decision.pricePerUnit < range.low - 1e-12 ||
          decision.pricePerUnit > range.high + 1e-12
        ) {
          fail(
            'price-within-observation',
            label,
            `fixture ${index}: ${decision.pricePerUnit} outside [${range.low}, ${range.high}]`,
          );
        }
      }
      checks.add('price-within-observation');
      if (typeof decision.reference !== 'string' || decision.reference.length === 0) {
        fail('reference-named', label, `fixture ${index}: a fill names the price it referenced`);
      }
      checks.add('reference-named');
    } else {
      if (typeof decision.reason !== 'string' || decision.reason.length === 0) {
        fail('unfilled-reason', label, `fixture ${index}: an unfilled decision names its reason`);
      }
      checks.add('unfilled-reason');
    }
  });
  return {
    conformant: true,
    label,
    version: fillModel.version,
    observation: fillModel.observation,
    checks: [...checks].sort(),
    fixturesRun: fixtures.length,
  };
}
