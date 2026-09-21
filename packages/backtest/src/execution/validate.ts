/**
 * Closed-request guards for the execution vocabulary (Stage 4.6, FC8 Decision 7). Every public head
 * on the subpath validates its whole input through these before computing: unknown keys, `null`
 * where a value or omission is meant, wrong primitive types, invalid enum values, and non-finite
 * numbers are teaching refusals that name the field. The guards take the library's
 * `(functionName, label, value)` order so the message says which public boundary refused.
 */

import {
  ErrorCode,
  InputError,
  ORDER_TYPES,
  TIME_IN_FORCE_VALUES,
  ensureKnownKeys,
  requireArgumentObject,
} from '@totalfinance/core';
import type {
  AmbiguityPolicy,
  OrderType,
  ExecutionPolicy,
  FillContext,
  FillDecision,
  FillModel,
  MarginPolicy,
  MarketObservation,
  MarketObservationKind,
  OrderIntent,
  SessionRules,
  StaleQuotePolicy,
  UnfilledReason,
} from './types.js';

// ---------------------------------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------------------------------

export function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function wrongType(functionName: string, field: string, expected: string, value: unknown): never {
  const received = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  throw new InputError(`${functionName}: ${field} must be ${expected}. Received ${received}.`, {
    code: ErrorCode.InputWrongType,
    context: { function: functionName, field },
  });
}

export function requireBoundaryLabel(
  functionName: string,
  parameter: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(
      `${typeof functionName === 'string' && functionName.length > 0 ? functionName : 'execution guard'}: ${parameter} must be a non-empty string (the boundary the refusal names). Received ${value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { field: parameter } },
    );
  }
}

function requireFiniteNumber(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is number {
  if (typeof value !== 'number') wrongType(functionName, field, 'a finite number', value);
  if (!Number.isFinite(value)) {
    throw new InputError(`${functionName}: ${field} must be finite. Received ${String(value)}.`, {
      code: ErrorCode.InputNotFinite,
      context: { function: functionName, field },
    });
  }
}

function requireIdentity(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0)
    wrongType(functionName, field, 'a non-empty string', value);
}

function requireBooleanField(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is boolean {
  if (typeof value !== 'boolean') wrongType(functionName, field, 'a boolean', value);
}

function requireEnumField<T extends string>(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new InputError(
      `${functionName}: ${field} must be one of ${allowed.map((v) => `'${v}'`).join(' | ')}. Received ${value === null ? 'null' : JSON.stringify(value)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { function: functionName, field } },
    );
  }
}

/** A present optional field may not be `null`: omission is spelled by leaving the key out. */
function refuseNull(functionName: string, field: string, value: unknown): void {
  if (value === null) {
    throw new InputError(
      `${functionName}: ${field} is null — omit the field to leave it unset; null is not a value here.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------------

const ORDER_KEYS = [
  'orderId',
  'instrumentId',
  'side',
  'quantity',
  'type',
  'limitPrice',
  'stopPrice',
  'timeInForce',
  'submittedTimestampMs',
] as const;

/** Validate an {@link OrderIntent}: a closed record whose prices match its order type. */
export function requireOrderIntent(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is OrderIntent {
  requireBoundaryLabel(functionName, 'functionName', functionName);
  requireBoundaryLabel(functionName, 'label', label);
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, ORDER_KEYS);
  const order = value as Record<string, unknown>;
  requireIdentity(functionName, `${label}.orderId`, order['orderId']);
  requireIdentity(functionName, `${label}.instrumentId`, order['instrumentId']);
  requireEnumField(functionName, `${label}.side`, order['side'], ['buy', 'sell'] as const);
  requireFiniteNumber(functionName, `${label}.quantity`, order['quantity']);
  if (!((order['quantity'] as number) > 0)) {
    throw new InputError(
      `${functionName}: ${label}.quantity must be > 0 (side carries the direction). Received ${String(order['quantity'])}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.quantity` },
      },
    );
  }
  requireEnumField(functionName, `${label}.type`, order['type'], ORDER_TYPES);
  const type = order['type'] as OrderType;
  const needsLimit = type === 'limit' || type === 'stop-limit';
  const needsStop = type === 'stop' || type === 'stop-limit';
  for (const [field, needed] of [
    ['limitPrice', needsLimit],
    ['stopPrice', needsStop],
  ] as const) {
    if (hasOwn(order, field)) {
      refuseNull(functionName, `${label}.${field}`, order[field]);
      requireFiniteNumber(functionName, `${label}.${field}`, order[field]);
      if (!needed) {
        throw new InputError(
          `${functionName}: ${label}.${field} is given but a '${type}' order does not use it — omit it, or choose the order type that does.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${label}.${field}` },
          },
        );
      }
    } else if (needed) {
      throw new InputError(
        `${functionName}: ${label}.${field} is required for a '${type}' order.`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field: `${label}.${field}` },
        },
      );
    }
  }
  if (hasOwn(order, 'timeInForce')) {
    refuseNull(functionName, `${label}.timeInForce`, order['timeInForce']);
    requireEnumField(
      functionName,
      `${label}.timeInForce`,
      order['timeInForce'],
      TIME_IN_FORCE_VALUES,
    );
  }
  requireFiniteNumber(functionName, `${label}.submittedTimestampMs`, order['submittedTimestampMs']);
}

// ---------------------------------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------------------------------

const BAR_FIELDS = ['open', 'high', 'low', 'close'] as const;

/** Validate the four prices of a bar: finite, `low ≤ high`, open and close inside the range. */
export function requireBarPrices(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is { open: number; high: number; low: number; close: number } {
  requireArgumentObject(functionName, label, value);
  const bar = value as Record<string, unknown>;
  for (const field of BAR_FIELDS)
    requireFiniteNumber(functionName, `${label}.${field}`, bar[field]);
  const { open, high, low, close } = bar as Record<(typeof BAR_FIELDS)[number], number>;
  if (low > high) {
    throw new InputError(
      `${functionName}: ${label}.low (${low}) exceeds ${label}.high (${high}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.low` },
      },
    );
  }
  for (const [field, price] of [
    ['open', open],
    ['close', close],
  ] as const) {
    if (price < low || price > high) {
      throw new InputError(
        `${functionName}: ${label}.${field} (${price}) lies outside [${label}.low, ${label}.high] = [${low}, ${high}].`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.${field}` },
        },
      );
    }
  }
}

const OBSERVATION_KINDS: readonly MarketObservationKind[] = ['bar', 'quote', 'trade', 'order-book'];
const BAR_KEYS = [
  'symbol',
  'timestampMs',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'vwap',
  'adjusted',
] as const;
const QUOTE_KEYS = [
  'symbol',
  'timestampMs',
  'bid',
  'ask',
  'bidSize',
  'askSize',
  'exchange',
  'conditions',
] as const;
const TRADE_KEYS = [
  'symbol',
  'timestampMs',
  'price',
  'size',
  'exchange',
  'conditions',
  'sequence',
] as const;
const BOOK_KEYS = ['symbol', 'timestampMs', 'bids', 'asks'] as const;

function requireOptionalFinite(
  functionName: string,
  field: string,
  record: Record<string, unknown>,
  key: string,
  nonNegative = false,
): void {
  if (!hasOwn(record, key)) return;
  refuseNull(functionName, field, record[key]);
  requireFiniteNumber(functionName, field, record[key]);
  if (nonNegative && (record[key] as number) < 0) {
    throw new InputError(
      `${functionName}: ${field} must be ≥ 0. Received ${String(record[key])}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field },
      },
    );
  }
}

function requireLevels(functionName: string, field: string, value: unknown): void {
  if (!Array.isArray(value))
    wrongType(functionName, field, 'an array of { price, size } levels', value);
  (value as unknown[]).forEach((level, index) => {
    const path = `${field}[${index}]`;
    requireArgumentObject(functionName, path, level);
    ensureKnownKeys(functionName, path, level as object, ['price', 'size', 'exchange']);
    const record = level as Record<string, unknown>;
    requireFiniteNumber(functionName, `${path}.price`, record['price']);
    requireFiniteNumber(functionName, `${path}.size`, record['size']);
    if ((record['size'] as number) < 0) {
      throw new InputError(`${functionName}: ${path}.size must be ≥ 0.`, {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${path}.size` },
      });
    }
  });
}

/** Validate a {@link MarketObservation}: the closed union over bar, quote, trade, and order book. */
export function requireMarketObservation(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is MarketObservation {
  requireArgumentObject(functionName, label, value);
  const record = value as Record<string, unknown>;
  requireEnumField(functionName, `${label}.kind`, record['kind'], OBSERVATION_KINDS);
  const kind = record['kind'] as MarketObservationKind;
  switch (kind) {
    case 'bar': {
      ensureKnownKeys(functionName, label, record, ['kind', 'bar']);
      requireArgumentObject(functionName, `${label}.bar`, record['bar']);
      const bar = record['bar'] as Record<string, unknown>;
      ensureKnownKeys(functionName, `${label}.bar`, bar, BAR_KEYS);
      requireIdentity(functionName, `${label}.bar.symbol`, bar['symbol']);
      requireFiniteNumber(functionName, `${label}.bar.timestampMs`, bar['timestampMs']);
      requireBarPrices(functionName, `${label}.bar`, record['bar']);
      requireOptionalFinite(functionName, `${label}.bar.volume`, bar, 'volume', true);
      requireOptionalFinite(functionName, `${label}.bar.vwap`, bar, 'vwap');
      if (hasOwn(bar, 'adjusted')) {
        refuseNull(functionName, `${label}.bar.adjusted`, bar['adjusted']);
        requireBooleanField(functionName, `${label}.bar.adjusted`, bar['adjusted']);
      }
      return;
    }
    case 'quote': {
      ensureKnownKeys(functionName, label, record, ['kind', 'quote']);
      requireArgumentObject(functionName, `${label}.quote`, record['quote']);
      const quote = record['quote'] as Record<string, unknown>;
      ensureKnownKeys(functionName, `${label}.quote`, quote, QUOTE_KEYS);
      requireIdentity(functionName, `${label}.quote.symbol`, quote['symbol']);
      requireFiniteNumber(functionName, `${label}.quote.timestampMs`, quote['timestampMs']);
      requireFiniteNumber(functionName, `${label}.quote.bid`, quote['bid']);
      requireFiniteNumber(functionName, `${label}.quote.ask`, quote['ask']);
      requireOptionalFinite(functionName, `${label}.quote.bidSize`, quote, 'bidSize', true);
      requireOptionalFinite(functionName, `${label}.quote.askSize`, quote, 'askSize', true);
      return;
    }
    case 'trade': {
      ensureKnownKeys(functionName, label, record, ['kind', 'trade']);
      requireArgumentObject(functionName, `${label}.trade`, record['trade']);
      const trade = record['trade'] as Record<string, unknown>;
      ensureKnownKeys(functionName, `${label}.trade`, trade, TRADE_KEYS);
      requireIdentity(functionName, `${label}.trade.symbol`, trade['symbol']);
      requireFiniteNumber(functionName, `${label}.trade.timestampMs`, trade['timestampMs']);
      requireFiniteNumber(functionName, `${label}.trade.price`, trade['price']);
      requireFiniteNumber(functionName, `${label}.trade.size`, trade['size']);
      return;
    }
    case 'order-book': {
      ensureKnownKeys(functionName, label, record, ['kind', 'book']);
      requireArgumentObject(functionName, `${label}.book`, record['book']);
      const book = record['book'] as Record<string, unknown>;
      ensureKnownKeys(functionName, `${label}.book`, book, BOOK_KEYS);
      requireIdentity(functionName, `${label}.book.symbol`, book['symbol']);
      requireFiniteNumber(functionName, `${label}.book.timestampMs`, book['timestampMs']);
      requireLevels(functionName, `${label}.book.bids`, book['bids']);
      requireLevels(functionName, `${label}.book.asks`, book['asks']);
      return;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------------

const UNFILLED_REASONS: readonly UnfilledReason[] = [
  'not-triggered',
  'no-observation',
  'wrong-observation-kind',
  'stale-quote',
  'locked-crossed',
  'halted',
  'zero-quantity',
  'insufficient-depth',
];
const FILLED_KEYS = [
  'outcome',
  'quantity',
  'pricePerUnit',
  'reference',
  'partial',
  'clampedToPriceLimit',
  'levelsConsumed',
] as const;
const UNFILLED_KEYS = ['outcome', 'reason', 'detail'] as const;

/** Validate a {@link FillDecision}: the closed `filled | unfilled` union. */
export function requireFillDecision(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is FillDecision {
  requireBoundaryLabel(functionName, 'functionName', functionName);
  requireBoundaryLabel(functionName, 'label', label);
  requireArgumentObject(functionName, label, value);
  const record = value as Record<string, unknown>;
  requireEnumField(functionName, `${label}.outcome`, record['outcome'], [
    'filled',
    'unfilled',
  ] as const);
  if (record['outcome'] === 'filled') {
    ensureKnownKeys(functionName, label, record, FILLED_KEYS);
    requireFiniteNumber(functionName, `${label}.quantity`, record['quantity']);
    if (!((record['quantity'] as number) > 0)) {
      throw new InputError(
        `${functionName}: ${label}.quantity must be > 0 for a fill. Received ${String(record['quantity'])}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.quantity` },
        },
      );
    }
    requireFiniteNumber(functionName, `${label}.pricePerUnit`, record['pricePerUnit']);
    requireIdentity(functionName, `${label}.reference`, record['reference']);
    requireBooleanField(functionName, `${label}.partial`, record['partial']);
    if (hasOwn(record, 'clampedToPriceLimit')) {
      refuseNull(functionName, `${label}.clampedToPriceLimit`, record['clampedToPriceLimit']);
      requireBooleanField(
        functionName,
        `${label}.clampedToPriceLimit`,
        record['clampedToPriceLimit'],
      );
    }
    if (hasOwn(record, 'levelsConsumed')) {
      refuseNull(functionName, `${label}.levelsConsumed`, record['levelsConsumed']);
      const levels = record['levelsConsumed'];
      if (!Number.isSafeInteger(levels) || (levels as number) < 1) {
        throw new InputError(
          `${functionName}: ${label}.levelsConsumed must be an integer ≥ 1. Received ${String(levels)}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${label}.levelsConsumed` },
          },
        );
      }
    }
    return;
  }
  ensureKnownKeys(functionName, label, record, UNFILLED_KEYS);
  requireEnumField(functionName, `${label}.reason`, record['reason'], UNFILLED_REASONS);
  if (hasOwn(record, 'detail')) {
    refuseNull(functionName, `${label}.detail`, record['detail']);
    if (typeof record['detail'] !== 'string')
      wrongType(functionName, `${label}.detail`, 'a string', record['detail']);
  }
}

// ---------------------------------------------------------------------------------------------------
// Context, models, policies
// ---------------------------------------------------------------------------------------------------

const CONTEXT_KEYS = [
  'asOf',
  'participation',
  'partialFills',
  'staleQuotes',
  'lockedCrossed',
  'sessions',
  'queue',
] as const;
const AMBIGUITIES: readonly AmbiguityPolicy[] = [
  'optimistic',
  'pessimistic',
  'deterministic-path',
  'reject',
];
const FORCED: readonly MarginPolicy['forcedLiquidation'][] = [
  'none',
  'close-largest-loss',
  'pro-rata',
];

export function requireStaleQuotePolicy(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is StaleQuotePolicy {
  requireArgumentObject(functionName, field, value);
  ensureKnownKeys(functionName, field, value as object, ['maximumAgeMs', 'behavior']);
  const record = value as Record<string, unknown>;
  if (!hasOwn(record, 'maximumAgeMs')) {
    throw new InputError(
      `${functionName}: ${field}.maximumAgeMs is required — a number of milliseconds, or null for "never stale".`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: `${field}.maximumAgeMs` },
      },
    );
  }
  if (record['maximumAgeMs'] !== null) {
    requireFiniteNumber(functionName, `${field}.maximumAgeMs`, record['maximumAgeMs']);
    if ((record['maximumAgeMs'] as number) < 0) {
      throw new InputError(`${functionName}: ${field}.maximumAgeMs must be ≥ 0 or null.`, {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${field}.maximumAgeMs` },
      });
    }
  }
  requireEnumField(functionName, `${field}.behavior`, record['behavior'], [
    'reject',
    'fill-at-last',
  ] as const);
}

export function requireSessionRules(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is SessionRules {
  requireArgumentObject(functionName, field, value);
  ensureKnownKeys(functionName, field, value as object, ['halts', 'priceLimits', 'auction']);
  const rules = value as Record<string, unknown>;
  if (hasOwn(rules, 'halts')) {
    refuseNull(functionName, `${field}.halts`, rules['halts']);
    if (!Array.isArray(rules['halts']))
      wrongType(functionName, `${field}.halts`, 'an array of halt windows', rules['halts']);
    (rules['halts'] as unknown[]).forEach((halt, index) => {
      const path = `${field}.halts[${index}]`;
      requireArgumentObject(functionName, path, halt);
      ensureKnownKeys(functionName, path, halt as object, [
        'instrumentId',
        'fromTimestampMs',
        'toTimestampMs',
      ]);
      const record = halt as Record<string, unknown>;
      if (hasOwn(record, 'instrumentId')) {
        refuseNull(functionName, `${path}.instrumentId`, record['instrumentId']);
        requireIdentity(functionName, `${path}.instrumentId`, record['instrumentId']);
      }
      requireFiniteNumber(functionName, `${path}.fromTimestampMs`, record['fromTimestampMs']);
      requireFiniteNumber(functionName, `${path}.toTimestampMs`, record['toTimestampMs']);
      if ((record['toTimestampMs'] as number) <= (record['fromTimestampMs'] as number)) {
        throw new InputError(`${functionName}: ${path} must end after it starts.`, {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${path}.toTimestampMs` },
        });
      }
    });
  }
  if (hasOwn(rules, 'priceLimits')) {
    refuseNull(functionName, `${field}.priceLimits`, rules['priceLimits']);
    if (!Array.isArray(rules['priceLimits']))
      wrongType(
        functionName,
        `${field}.priceLimits`,
        'an array of price-limit windows',
        rules['priceLimits'],
      );
    (rules['priceLimits'] as unknown[]).forEach((window, index) => {
      const path = `${field}.priceLimits[${index}]`;
      requireArgumentObject(functionName, path, window);
      ensureKnownKeys(functionName, path, window as object, [
        'instrumentId',
        'fromTimestampMs',
        'toTimestampMs',
        'low',
        'high',
      ]);
      const record = window as Record<string, unknown>;
      requireIdentity(functionName, `${path}.instrumentId`, record['instrumentId']);
      for (const key of ['fromTimestampMs', 'toTimestampMs', 'low', 'high'] as const) {
        requireFiniteNumber(functionName, `${path}.${key}`, record[key]);
      }
      if (
        (record['toTimestampMs'] as number) <= (record['fromTimestampMs'] as number) ||
        (record['high'] as number) < (record['low'] as number)
      ) {
        throw new InputError(
          `${functionName}: ${path} must end after it starts and have low ≤ high.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: path },
          },
        );
      }
    });
  }
  if (hasOwn(rules, 'auction')) {
    refuseNull(functionName, `${field}.auction`, rules['auction']);
    requireEnumField(functionName, `${field}.auction`, rules['auction'], [
      'ignore',
      'open-close-only',
    ] as const);
  }
}

/** Validate a {@link FillContext}. */
export function requireFillContext(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is FillContext {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, CONTEXT_KEYS);
  const record = value as Record<string, unknown>;
  requireFiniteNumber(functionName, `${label}.asOf`, record['asOf']);
  if (hasOwn(record, 'participation')) {
    refuseNull(functionName, `${label}.participation`, record['participation']);
    requireFiniteNumber(functionName, `${label}.participation`, record['participation']);
    const participation = record['participation'] as number;
    if (!(participation > 0) || participation > 1) {
      throw new InputError(
        `${functionName}: ${label}.participation is a fraction in (0, 1]. Received ${participation}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.participation` },
        },
      );
    }
  }
  requireEnumField(functionName, `${label}.partialFills`, record['partialFills'], [
    'allow',
    'reject',
  ] as const);
  requireStaleQuotePolicy(functionName, `${label}.staleQuotes`, record['staleQuotes']);
  requireEnumField(functionName, `${label}.lockedCrossed`, record['lockedCrossed'], [
    'reject',
    'fill-at-mid',
  ] as const);
  if (hasOwn(record, 'sessions')) {
    refuseNull(functionName, `${label}.sessions`, record['sessions']);
    requireSessionRules(functionName, `${label}.sessions`, record['sessions']);
  }
  requireArgumentObject(functionName, `${label}.queue`, record['queue']);
  ensureKnownKeys(functionName, `${label}.queue`, record['queue'] as object, ['model']);
  requireEnumField(
    functionName,
    `${label}.queue.model`,
    (record['queue'] as Record<string, unknown>)['model'],
    ['none', 'depth-approximation'] as const,
  );
}

/** A labeled model: a closed object with a non-empty `label` and the named function member. */
export function requireLabeledModel(
  functionName: string,
  field: string,
  value: unknown,
  member: string,
): void {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  requireIdentity(functionName, `${field}.label`, record['label']);
  if (typeof record[member] !== 'function') {
    throw new InputError(`${functionName}: ${field}.${member} must be a function.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: `${field}.${member}` },
    });
  }
}

export function requireFillModel(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is FillModel {
  requireLabeledModel(functionName, field, value, 'fill');
  const model = value as Record<string, unknown>;
  requireIdentity(functionName, `${field}.version`, model['version']);
  requireEnumField(functionName, `${field}.observation`, model['observation'], OBSERVATION_KINDS);
}

const MARGIN_KEYS = [
  'buyingPowerMultiplier',
  'initialMarginRate',
  'maintenanceMarginRate',
  'forcedLiquidation',
] as const;

/** Validate a {@link MarginPolicy}: rates in [0, 1], maintenance ≤ initial, a buying power ≥ 1. */
export function requireMarginPolicy(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is MarginPolicy {
  requireBoundaryLabel(functionName, 'functionName', functionName);
  requireBoundaryLabel(functionName, 'label', label);
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, MARGIN_KEYS);
  const policy = value as Record<string, unknown>;
  for (const field of [
    'buyingPowerMultiplier',
    'initialMarginRate',
    'maintenanceMarginRate',
  ] as const) {
    requireFiniteNumber(functionName, `${label}.${field}`, policy[field]);
    if ((policy[field] as number) < 0) {
      throw new InputError(`${functionName}: ${label}.${field} must be ≥ 0.`, {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.${field}` },
      });
    }
  }
  const p = policy as Record<(typeof MARGIN_KEYS)[number], number>;
  if (p.buyingPowerMultiplier < 1) {
    throw new InputError(
      `${functionName}: ${label}.buyingPowerMultiplier must be ≥ 1 (1 is a cash account). Received ${p.buyingPowerMultiplier}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.buyingPowerMultiplier` },
      },
    );
  }
  if (p.initialMarginRate > 1 || p.maintenanceMarginRate > 1) {
    throw new InputError(
      `${functionName}: ${label} margin rates are fractions of notional in [0, 1].`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.initialMarginRate` },
      },
    );
  }
  if (p.maintenanceMarginRate > p.initialMarginRate) {
    throw new InputError(
      `${functionName}: ${label}.maintenanceMarginRate (${p.maintenanceMarginRate}) exceeds initialMarginRate (${p.initialMarginRate}) — a position could be liquidated the instant it is opened.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.maintenanceMarginRate` },
      },
    );
  }
  requireEnumField(functionName, `${label}.forcedLiquidation`, policy['forcedLiquidation'], FORCED);
}

const POLICY_KEYS = [
  'label',
  'realism',
  'observation',
  'fill',
  'ambiguity',
  'costs',
  'staleQuotes',
  'lockedCrossed',
  'sessions',
  'partialFills',
  'queue',
  'timeInForce',
  'margin',
] as const;
const COST_KEYS = [
  'commission',
  'slippage',
  'spread',
  'marketImpact',
  'latency',
  'participation',
  'borrow',
] as const;

/** Validate a whole {@link ExecutionPolicy} — what `execution.declared` builds and every engine echoes. */
export function requireExecutionPolicy(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is ExecutionPolicy {
  requireBoundaryLabel(functionName, 'functionName', functionName);
  requireBoundaryLabel(functionName, 'label', label);
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, POLICY_KEYS);
  const policy = value as Record<string, unknown>;
  requireIdentity(functionName, `${label}.label`, policy['label']);
  requireEnumField(functionName, `${label}.realism`, policy['realism'], [
    'simplified',
    'declared',
  ] as const);
  requireEnumField(functionName, `${label}.observation`, policy['observation'], OBSERVATION_KINDS);
  requireFillModel(functionName, `${label}.fill`, policy['fill']);
  if ((policy['fill'] as FillModel).observation !== policy['observation']) {
    throw new InputError(
      `${functionName}: ${label}.fill reads '${(policy['fill'] as FillModel).observation}' observations but ${label}.observation is '${String(policy['observation'])}' — a policy observes what its fill model reads.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.observation` },
      },
    );
  }
  requireEnumField(functionName, `${label}.ambiguity`, policy['ambiguity'], AMBIGUITIES);
  requireArgumentObject(functionName, `${label}.costs`, policy['costs']);
  const costs = policy['costs'] as Record<string, unknown>;
  ensureKnownKeys(functionName, `${label}.costs`, costs, COST_KEYS);
  requireLabeledModel(functionName, `${label}.costs.commission`, costs['commission'], 'commission');
  requireLabeledModel(functionName, `${label}.costs.slippage`, costs['slippage'], 'fill');
  if (hasOwn(costs, 'spread')) {
    refuseNull(functionName, `${label}.costs.spread`, costs['spread']);
    requireLabeledModel(functionName, `${label}.costs.spread`, costs['spread'], 'halfSpread');
  }
  if (hasOwn(costs, 'marketImpact')) {
    refuseNull(functionName, `${label}.costs.marketImpact`, costs['marketImpact']);
    requireLabeledModel(
      functionName,
      `${label}.costs.marketImpact`,
      costs['marketImpact'],
      'impact',
    );
  }
  if (hasOwn(costs, 'latency')) {
    refuseNull(functionName, `${label}.costs.latency`, costs['latency']);
    requireArgumentObject(functionName, `${label}.costs.latency`, costs['latency']);
    const latency = costs['latency'] as Record<string, unknown>;
    ensureKnownKeys(functionName, `${label}.costs.latency`, latency, ['label', 'sessions']);
    requireIdentity(functionName, `${label}.costs.latency.label`, latency['label']);
    if (!Number.isSafeInteger(latency['sessions']) || (latency['sessions'] as number) < 0) {
      throw new InputError(
        `${functionName}: ${label}.costs.latency.sessions must be an integer ≥ 0.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.costs.latency.sessions` },
        },
      );
    }
  }
  if (hasOwn(costs, 'participation')) {
    refuseNull(functionName, `${label}.costs.participation`, costs['participation']);
    requireFiniteNumber(functionName, `${label}.costs.participation`, costs['participation']);
    const participation = costs['participation'] as number;
    if (!(participation > 0) || participation > 1) {
      throw new InputError(
        `${functionName}: ${label}.costs.participation is a fraction in (0, 1]. Received ${participation}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.costs.participation` },
        },
      );
    }
  }
  if (hasOwn(costs, 'borrow')) {
    refuseNull(functionName, `${label}.costs.borrow`, costs['borrow']);
    requireArgumentObject(functionName, `${label}.costs.borrow`, costs['borrow']);
    const borrow = costs['borrow'] as Record<string, unknown>;
    requireIdentity(functionName, `${label}.costs.borrow.label`, borrow['label']);
    requireFiniteNumber(functionName, `${label}.costs.borrow.annualRate`, borrow['annualRate']);
  }
  requireStaleQuotePolicy(functionName, `${label}.staleQuotes`, policy['staleQuotes']);
  requireEnumField(functionName, `${label}.lockedCrossed`, policy['lockedCrossed'], [
    'reject',
    'fill-at-mid',
  ] as const);
  if (hasOwn(policy, 'sessions')) {
    refuseNull(functionName, `${label}.sessions`, policy['sessions']);
    requireSessionRules(functionName, `${label}.sessions`, policy['sessions']);
  }
  requireEnumField(functionName, `${label}.partialFills`, policy['partialFills'], [
    'allow',
    'reject',
  ] as const);
  requireArgumentObject(functionName, `${label}.queue`, policy['queue']);
  ensureKnownKeys(functionName, `${label}.queue`, policy['queue'] as object, ['model']);
  requireEnumField(
    functionName,
    `${label}.queue.model`,
    (policy['queue'] as Record<string, unknown>)['model'],
    ['none', 'depth-approximation'] as const,
  );
  requireArgumentObject(functionName, `${label}.timeInForce`, policy['timeInForce']);
  ensureKnownKeys(functionName, `${label}.timeInForce`, policy['timeInForce'] as object, [
    'default',
    'expireAtSessionClose',
  ]);
  const tif = policy['timeInForce'] as Record<string, unknown>;
  requireEnumField(
    functionName,
    `${label}.timeInForce.default`,
    tif['default'],
    TIME_IN_FORCE_VALUES,
  );
  requireBooleanField(
    functionName,
    `${label}.timeInForce.expireAtSessionClose`,
    tif['expireAtSessionClose'],
  );
  requireMarginPolicy(functionName, `${label}.margin`, policy['margin']);
}
