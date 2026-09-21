/**
 * Parameter validation for the TA facades (spec design law #4 — no silent degradation).
 *
 * These run at the public boundary (the `makeIndicator` factory and the batch chart/price-action
 * functions), so a bad `period`, brick size, or threshold throws a typed `InputError` instead of
 * quietly returning an all-warmup `NaN` series or, worse, spinning a `while` loop forever. Restore
 * (`fromJSON`) is a trusted internal path and is not re-validated. Built on `@totalfinance/core`'s
 * hot-path invariants so the deep entrypoints stay within bundle budget.
 */

import {
  ErrorCode,
  InputError,
  ensureEnum,
  ensureFinite,
  ensureNonNegative,
  ensurePositive,
  missingFieldError,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  MAX_TECHNICAL_ANALYSIS_LOOKBACK,
  MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS,
} from './limits.js';

/** The first argument each input kind's teaching example shows. */
export type RequiredInputKind = 'series' | 'bars' | 'pair';

/**
 * The moving-average length family: these keep the "common MA lengths" hint in their required-field
 * error (dx R7 — `ema`/`sma` stay required, but the error teaches the common lengths). Every other
 * indicator gets a plain `fn(<input>, { field: 14 })` example — a chart-length hint on, say, a
 * rolling quantile would be misleading.
 */
const MA_LENGTH_FAMILY: ReadonlySet<string> = new Set([
  'sma',
  'ema',
  'wma',
  'rma',
  'dema',
  'tema',
  'trima',
  't3',
  'hma',
  'zlema',
  'mcginley',
  'movingAverage',
  'vwma',
  'fwma',
  'sineWma',
  'pascalWma',
  'symmetricWma',
]);

const EXAMPLE_ARG: Record<RequiredInputKind, string> = {
  series: 'series',
  bars: 'bars',
  pair: 'pairs(a, b)',
};

/**
 * A field that has no industry-standard default and so is genuinely required: when it arrives
 * `undefined`/`null` (e.g. `sma(closes)` with no parameters object), throw the teaching missing-field
 * error naming the field and a working example — never let it fall through to `ensureFinite` (whose
 * "must be a finite number. Received undefined" reads like a bug) or to a raw property `TypeError`.
 * The example is phrased for the indicator's input kind (`fn(bars, …)` for bar indicators), and only
 * the moving-average length family carries the common-MA-lengths hint.
 */
function requirePresent(
  value: number | undefined,
  functionName: string,
  field: string,
  input: RequiredInputKind,
): void {
  if (value === undefined || value === null) {
    const arg = EXAMPLE_ARG[input];
    const example = MA_LENGTH_FAMILY.has(functionName)
      ? `${functionName}(${arg}, { ${field}: 20 }) — common: 10, 20, 50, 200`
      : `${functionName}(${arg}, { ${field}: 14 })`;
    throw missingFieldError(functionName, field, example);
  }
}

/**
 * Throw unless `value` is an integer `≥ min` (default 1). Sample-based estimators pass `min = 2`
 * because a one-element sample variance (`÷ (n − 1)`) is undefined. `input` phrases the
 * missing-field teaching example (`fn(bars, …)` vs `fn(series, …)`).
 */
export function requirePeriod(
  value: number | undefined,
  functionName: string,
  field = 'period',
  min = 1,
  input: RequiredInputKind = 'series',
): number {
  requirePresent(value, functionName, field, input);
  const v = value as number;
  ensureFinite(v, field, functionName);
  if (!Number.isSafeInteger(v) || v < min || v > MAX_TECHNICAL_ANALYSIS_LOOKBACK) {
    throw new InputError(
      `${functionName}: ${field} must be an integer ≥ ${min.toLocaleString('en-US')} and ≤ ${MAX_TECHNICAL_ANALYSIS_LOOKBACK.toLocaleString('en-US')} — streams may precompute one or two arrays of this length, so the cap bounds synchronous setup and memory while already exceeding any practical chart history. Received ${v}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          field,
          value: v,
          min,
          max: MAX_TECHNICAL_ANALYSIS_LOOKBACK,
          function: functionName,
        },
      },
    );
  }
  return v;
}

/** Bound a count of eagerly allocated parallel indicator streams. */
export function requireParallelStreamCount(
  value: number | undefined,
  functionName: string,
  field: string,
): number {
  requirePresent(value, functionName, field, 'series');
  const count = value as number;
  ensureFinite(count, field, functionName);
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS
  ) {
    throw new InputError(
      `${functionName}: ${field} must be an integer of at least 1 and at most ${MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS.toLocaleString('en-US')}. Received ${count}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          field,
          value: count,
          min: 1,
          max: MAX_TECHNICAL_ANALYSIS_PARALLEL_STREAMS,
          function: functionName,
        },
      },
    );
  }
  return count;
}

/** Throw unless `value` is a finite number `> 0`; returns it for inline use. */
export function requirePositive(
  value: number | undefined,
  functionName: string,
  field: string,
  input: RequiredInputKind = 'series',
): number {
  requirePresent(value, functionName, field, input);
  const v = value as number;
  ensurePositive(v, field, functionName);
  return v;
}

/**
 * A volatility estimator's `annualization` is REQUIRED: TotalFinance never assumes the bar frequency, and
 * a per-bar σ silently fed to an annualized consumer (`@totalfinance/volatility`'s spread, premium and
 * rank tools) is wrong by √252 on daily bars. `252` annualizes daily bars, `52` weekly, `12` monthly,
 * `1` reports the per-bar σ.
 */
export function requireAnnualization(
  value: number | undefined,
  functionName: string,
  input: RequiredInputKind = 'series',
): number {
  if (value === undefined || value === null) {
    const arg = EXAMPLE_ARG[input];
    throw missingFieldError(
      functionName,
      'annualization',
      `${functionName}(${arg}, { period: 20, annualization: 252 }) — bars per year: 252 daily, 52 weekly, 12 monthly, or 1 for the per-bar σ`,
    );
  }
  ensurePositive(value, 'annualization', functionName);
  return value;
}

/** Throw unless `value` is a finite number; returns it for inline use. */
export function requireFinite(value: number, functionName: string, field: string): number {
  ensureFinite(value, field, functionName);
  return value;
}

/** Throw unless `value` is one of `allowed`; returns it narrowed for inline use. */
export function requireOneOf<T extends string>(
  value: string,
  allowed: readonly T[],
  functionName: string,
  field: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InputError(
      `${functionName}: ${field} must be one of ${allowed.join(' | ')}. Received "${value}".`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field, value, allowed: [...allowed], function: functionName },
      },
    );
  }
  return value as T;
}

/** Throw unless `value` is a finite number in `[lo, hi]`; returns it for inline use. */
export function requireInRange(
  value: number,
  functionName: string,
  field: string,
  lo: number,
  hi: number,
): number {
  ensureFinite(value, field, functionName);
  if (value < lo || value > hi) {
    throw new InputError(
      `${functionName}: ${field} must be in [${lo}, ${hi}]. Received ${value}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field, value, lowerBound: lo, upperBound: hi, function: functionName },
      },
    );
  }
  return value;
}

/** Throw unless `value ≤ ceiling`; returns `value` for inline use. */
export function requireAtMost(
  value: number,
  ceiling: number,
  functionName: string,
  field: string,
  ceilingField: string,
): number {
  if (value > ceiling) {
    throw new InputError(
      `${functionName}: ${field} (${value}) must be ≤ ${ceilingField} (${ceiling}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field, value, ceilingField, ceiling, function: functionName },
      },
    );
  }
  return value;
}

/** Throw unless two parallel inputs have the same length; returns the shared length. */
export function requireSameLength(
  a: number,
  b: number,
  functionName: string,
  aField: string,
  bField: string,
): number {
  if (a !== b) {
    throw new InputError(
      `${functionName}: ${aField} length (${a}) must equal ${bField} length (${b}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { aField, aLength: a, bField, bLength: b, function: functionName },
      },
    );
  }
  return a;
}

/** Throw unless `value` is a non-negative integer; returns it for inline use. */
export function requireNonNegativeInt(
  value: number | undefined,
  functionName: string,
  field: string,
  input: RequiredInputKind = 'series',
): number {
  requirePresent(value, functionName, field, input);
  const v = value as number;
  ensureFinite(v, field, functionName);
  // Safe integer (2026-08-23 review, P0): see requirePeriod — same exactness argument for counts.
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new InputError(
      `${functionName}: ${field} must be a non-negative integer. Received ${v}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field, value: v, function: functionName },
      },
    );
  }
  return v;
}

/**
 * Throw unless `value` is a boolean when it is defined; returns it (or undefined) for `??` chains.
 * Null is a wrong-typed value here, not a second spelling of omission (the 350c2796 ruling) — and a
 * truthy string (`strict: 'yes'`) must never silently engage the flag.
 */
export function requireBooleanWhenPresent(
  value: unknown,
  functionName: string,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new InputError(
      `${functionName}: ${field} must be a boolean when provided — omit the field to use the default. Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { field, value, function: functionName },
      },
    );
  }
  return value;
}

/** Throw unless `value` is a finite number `>= 0`; returns it for inline use. */
export function requireNonNegative(value: number, functionName: string, field: string): number {
  ensureNonNegative(value, field, functionName);
  return value;
}

interface TradeLike {
  price?: unknown;
  size?: unknown;
  time?: unknown;
  side?: unknown;
}

interface QuoteLike {
  bid?: unknown;
  ask?: unknown;
  bidSize?: unknown;
  askSize?: unknown;
}

interface BookLevelLike {
  price?: unknown;
  size?: unknown;
}

interface OrderBookLike {
  bids?: unknown;
  asks?: unknown;
}

interface BarLike {
  open?: unknown;
  high?: unknown;
  low?: unknown;
  close?: unknown;
  volume?: unknown;
}

function requireNumericField(
  value: unknown,
  functionName: string,
  field: string,
  example: string,
): number {
  if (value === undefined || value === null) throw missingFieldError(functionName, field, example);
  ensureFinite(value as number, field, functionName);
  return value as number;
}

/** Validate one trade print, including runtime enum and non-negative-size semantics. */
export function requireTrade(value: unknown, functionName: string, field = 'trade'): void {
  requireArgumentObject(functionName, field, value);
  const trade = value as TradeLike;
  const price = requireNumericField(
    trade.price,
    functionName,
    `${field}.price`,
    `${functionName}({ price: 100, size: 1 })`,
  );
  ensurePositive(price, `${field}.price`, functionName);
  const size = requireNumericField(
    trade.size,
    functionName,
    `${field}.size`,
    `${functionName}({ price: 100, size: 1 })`,
  );
  ensureNonNegative(size, `${field}.size`, functionName);
  if (trade.time !== undefined) ensureFinite(trade.time as number, `${field}.time`, functionName);
  if (trade.side !== undefined) {
    ensureEnum(trade.side, ['buy', 'sell'] as const, `${field}.side`, functionName);
  }
}

/** Validate every print in a trade tape; no later corrupt element can bypass first-touch checks. */
export function requireTrades(
  values: readonly unknown[],
  functionName: string,
  field = 'trades',
): void {
  requireArgumentArray(functionName, field, values);
  for (let i = 0; i < values.length; i++) requireTrade(values[i], functionName, `${field}[${i}]`);
}

/** Validate a quote and its bid/ask and size invariants. Locked quotes are allowed; crossed are not. */
export function requireQuote(value: unknown, functionName: string, field = 'quote'): void {
  requireArgumentObject(functionName, field, value);
  const quote = value as QuoteLike;
  const bid = requireNumericField(
    quote.bid,
    functionName,
    `${field}.bid`,
    `${functionName}({ bid: 99, ask: 101 })`,
  );
  const ask = requireNumericField(
    quote.ask,
    functionName,
    `${field}.ask`,
    `${functionName}({ bid: 99, ask: 101 })`,
  );
  ensureNonNegative(bid, `${field}.bid`, functionName);
  ensureNonNegative(ask, `${field}.ask`, functionName);
  if (bid > ask) {
    throw new InputError(
      `${functionName}: ${field}.bid (${bid}) must be <= ${field}.ask (${ask}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, bid, ask },
      },
    );
  }
  if (quote.bidSize !== undefined) {
    ensureNonNegative(quote.bidSize as number, `${field}.bidSize`, functionName);
  }
  if (quote.askSize !== undefined) {
    ensureNonNegative(quote.askSize as number, `${field}.askSize`, functionName);
  }
}

/** Validate every quote in an aligned quote tape. */
export function requireQuotes(
  values: readonly unknown[],
  functionName: string,
  field = 'quotes',
): void {
  requireArgumentArray(functionName, field, values);
  for (let i = 0; i < values.length; i++) requireQuote(values[i], functionName, `${field}[${i}]`);
}

/** Validate a best-first order book, every level, sorting, and top-of-book non-crossing. */
export function requireOrderBook(value: unknown, functionName: string, field = 'book'): void {
  requireArgumentObject(functionName, field, value);
  const book = value as OrderBookLike;
  requireArgumentArray(functionName, `${field}.bids`, book.bids);
  requireArgumentArray(functionName, `${field}.asks`, book.asks);
  const bids = book.bids as readonly BookLevelLike[];
  const asks = book.asks as readonly BookLevelLike[];
  const validateSide = (levels: readonly BookLevelLike[], side: 'bids' | 'asks'): void => {
    for (let i = 0; i < levels.length; i++) {
      const levelField = `${field}.${side}[${i}]`;
      requireArgumentObject(functionName, levelField, levels[i]);
      const level = levels[i]!;
      const price = requireNumericField(
        level.price,
        functionName,
        `${levelField}.price`,
        `${functionName}({ bids: [{ price: 99, size: 1 }], asks: [{ price: 101, size: 1 }] })`,
      );
      ensurePositive(price, `${levelField}.price`, functionName);
      const size = requireNumericField(
        level.size,
        functionName,
        `${levelField}.size`,
        `${functionName}({ bids: [{ price: 99, size: 1 }], asks: [{ price: 101, size: 1 }] })`,
      );
      ensureNonNegative(size, `${levelField}.size`, functionName);
      if (i > 0) {
        const previous = levels[i - 1]!.price as number;
        const unsorted = side === 'bids' ? price > previous : price < previous;
        if (unsorted) {
          throw new InputError(`${functionName}: ${field}.${side} must be sorted best-first.`, {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${field}.${side}`, index: i },
          });
        }
      }
    }
  };
  validateSide(bids, 'bids');
  validateSide(asks, 'asks');
  if (
    bids.length > 0 &&
    asks.length > 0 &&
    (bids[0]!.price as number) > (asks[0]!.price as number)
  ) {
    throw new InputError(`${functionName}: ${field} is crossed (best bid exceeds best ask).`, {
      code: ErrorCode.InputOutOfRange,
      context: { function: functionName, field },
    });
  }
}

/** Validate every OHLCV row and its price-range relationships. */
export function requireBars(
  values: ArrayLike<unknown>,
  functionName: string,
  field = 'bars',
): void {
  requireArgumentArray(functionName, field, values);
  for (let i = 0; i < values.length; i++) {
    const barField = `${field}[${i}]`;
    requireArgumentObject(functionName, barField, values[i]);
    const bar = values[i] as BarLike;
    const high = requireNumericField(
      bar.high,
      functionName,
      `${barField}.high`,
      `${functionName}(bars, parameters)`,
    );
    const low = requireNumericField(
      bar.low,
      functionName,
      `${barField}.low`,
      `${functionName}(bars, parameters)`,
    );
    const close = requireNumericField(
      bar.close,
      functionName,
      `${barField}.close`,
      `${functionName}(bars, parameters)`,
    );
    if (high < low) {
      throw new InputError(`${functionName}: ${barField}.high (${high}) must be >= low (${low}).`, {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: barField, high, low },
      });
    }
    if (close < low || close > high) {
      throw new InputError(
        `${functionName}: ${barField}.close (${close}) must be within [low, high].`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${barField}.close`, close, low, high },
        },
      );
    }
    if (bar.open !== undefined) {
      ensureFinite(bar.open as number, `${barField}.open`, functionName);
      if ((bar.open as number) < low || (bar.open as number) > high) {
        throw new InputError(`${functionName}: ${barField}.open must be within [low, high].`, {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${barField}.open`, low, high },
        });
      }
    }
    if (bar.volume !== undefined) {
      ensureNonNegative(bar.volume as number, `${barField}.volume`, functionName);
    }
  }
}
