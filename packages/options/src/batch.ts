/**
 * Batch option pricing (spec §9.6).
 *
 * Two shapes:
 *   - rows: `priceMany({ contracts, market, engine })` → `PriceResult[]` (rich, convenient).
 *   - columns: struct-of-arrays `Float64Array` kernels (`blackScholesPriceMany`, `blackScholesPriceManyInto`) for hot
 *     loops, with a buffer-writing `*Into` variant for zero-allocation reuse.
 *
 * Batch output is defined to match scalar output exactly (same kernel), which the tests assert.
 */

import {
  QuantError,
  ErrorCode,
  InputError,
  type OptionContract,
  type OptionType,
  UnsupportedError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  blackScholesGreeks,
  blackScholesImpliedVolatility,
  type ImpliedVolatilityReason,
  blackScholesPriceUnchecked,
} from './bsm.js';
import { type OptionPricingEngine, engines, requireEngine } from './engines.js';
import type { Greeks, OptionMarket, PriceResult } from './types.js';

/** Reject mismatched columnar shapes — a short column would silently produce `NaN`/dropped rows. */
function requireEqualLengths(
  n: number,
  entries: Array<[string, { length: number }]>,
  functionName: string,
): void {
  for (const [name, arr] of entries) {
    // A missing/mistyped column must teach its name, not crash on `.length` of undefined.
    if (arr === null || arr === undefined || typeof arr.length !== 'number') {
      throw new InputError(
        `${functionName}: column "${name}" is required (a Float64Array/Int8Array of ${n} rows); got ${
          arr === null ? 'null' : typeof arr
        }.`,
        {
          code: ErrorCode.InputMissingField,
          context: { column: name, expected: n },
        },
      );
    }
    if (arr.length !== n) {
      throw new InputError(
        `${functionName}: column "${name}" has length ${arr.length}, but the row count is ${n}; all columns must match.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { column: name, length: arr.length, expected: n },
        },
      );
    }
  }
}

function requirePositiveRow(value: number, field: string, row: number, functionName: string): void {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${field} at row ${row} must be a positive finite number, got ${value}.`,
      { code: ErrorCode.InputOutOfRange, context: { row, field, value } },
    );
  }
}

function requireFiniteRow(value: number, field: string, row: number, functionName: string): void {
  if (!Number.isFinite(value)) {
    throw new InputError(`${functionName}: ${field} at row ${row} must be finite, got ${value}.`, {
      code: ErrorCode.InputNotFinite,
      context: { row, field, value },
    });
  }
}

/**
 * Compiler-checked column allowlist — `satisfies` fails the build if the interface gains a column
 * this table misses, so an unknown-key rejection can never lag the declaration.
 */
const BATCH_COLUMN_KEYS = [
  'spot',
  'strike',
  'volatility',
  'riskFreeRate',
  'timeToExpiryYears',
  'type',
  'dividendYield',
] as const satisfies readonly (keyof OptionBatchColumns)[];
type BatchColumnsAreTotal =
  Exclude<keyof OptionBatchColumns, (typeof BATCH_COLUMN_KEYS)[number]> extends never
    ? true
    : never;
const BATCH_COLUMNS_ARE_TOTAL: BatchColumnsAreTotal = true;
void BATCH_COLUMNS_ARE_TOTAL;

/** Struct-of-arrays columnar batch input. `type`: 1 = call, ≤ 0 = put. */
export interface OptionBatchColumns {
  spot: Float64Array;
  strike: Float64Array;
  volatility: Float64Array;
  riskFreeRate: Float64Array;
  /** Time to expiry in years. */
  timeToExpiryYears: Float64Array;
  type: Int8Array;
  /** Optional per-row continuous dividend yield (defaults to 0). */
  dividendYield?: Float64Array;
}

export interface OptionBatchResult {
  price: Float64Array;
  delta?: Float64Array;
  gamma?: Float64Array;
  theta?: Float64Array;
  vega?: Float64Array;
  rho?: Float64Array;
}

function typeAt(types: Int8Array, i: number): OptionType {
  return types[i]! > 0 ? 'call' : 'put';
}

function rowCount(cols: OptionBatchColumns): number {
  return cols.spot.length;
}

/**
 * Reject an `out` buffer that PARTIALLY overlaps an input column (defect-fix wave, finding 5).
 *
 * The loop reads row `i` of every column and then writes `out[i]`, so writing over memory a LATER
 * row still has to read silently corrupts those rows — the caller gets prices computed from prices.
 * Two aliasings are safe and stay supported: a different buffer, and `out` being EXACTLY a column
 * (row `i`'s inputs are all consumed before `out[i]` lands on them). Everything in between — a
 * `subarray` at an offset, a second view over the same buffer — is the bug this catches.
 */
function requireNonOverlappingOut(
  cols: OptionBatchColumns,
  out: Float64Array,
  rows: number,
  functionName: string,
): void {
  const outStart = out.byteOffset;
  const outEnd = outStart + rows * Float64Array.BYTES_PER_ELEMENT;
  const columns: Array<[string, Float64Array | Int8Array]> = [
    ['spot', cols.spot],
    ['strike', cols.strike],
    ['volatility', cols.volatility],
    ['riskFreeRate', cols.riskFreeRate],
    ['timeToExpiryYears', cols.timeToExpiryYears],
    ['type', cols.type],
  ];
  if (cols.dividendYield !== undefined) columns.push(['dividendYield', cols.dividendYield]);
  for (const [name, column] of columns) {
    if (column.buffer !== out.buffer) continue;
    // Exact alias: same start, same element type, same length — the documented in-place fast path.
    if (
      column.byteOffset === out.byteOffset &&
      column.byteLength === out.byteLength &&
      column.constructor === out.constructor
    ) {
      continue;
    }
    const columnStart = column.byteOffset;
    const columnEnd = columnStart + rows * column.BYTES_PER_ELEMENT;
    if (columnStart < outEnd && outStart < columnEnd) {
      throw new InputError(
        `${functionName}: the out buffer overlaps input column "${name}" in the same ArrayBuffer ` +
          `(out bytes [${outStart}, ${outEnd}) vs "${name}" bytes [${columnStart}, ${columnEnd})). ` +
          'Writing a price over memory a later row still has to read would silently corrupt those ' +
          'rows. Pass a non-overlapping buffer (aliasing out to a column EXACTLY — same offset, ' +
          'same length, same type — is allowed and stays in place).',
        {
          code: ErrorCode.InputWrongShape,
          context: {
            column: name,
            outByteOffset: outStart,
            columnByteOffset: columnStart,
            rows,
            function: functionName,
          },
        },
      );
    }
  }
}

/**
 * Write BSM prices for `cols` into the provided `out` buffer (no allocation).
 *
 * TRUSTED FAST PATH: this validates column/buffer SHAPES but NOT per-row values — it assumes finite,
 * positive `spot/strike/t/vol` and finite `rate/q`. For validated input use {@link blackScholesPriceMany}.
 *
 * `out` may alias an input column EXACTLY (in-place pricing); a partial overlap is rejected.
 */
export function blackScholesPriceManyInto(cols: OptionBatchColumns, out: Float64Array): void {
  requireArgumentObject('blackScholesPriceManyInto', 'cols', cols);
  ensureKnownKeys('blackScholesPriceManyInto', 'cols', cols, BATCH_COLUMN_KEYS);
  requireArgumentObject('blackScholesPriceManyInto', 'cols', cols);
  requireArgumentArray(
    'blackScholesPriceManyInto',
    'cols.spot',
    (cols as { spot?: unknown }).spot as never,
  );
  requireArgumentArray('blackScholesPriceManyInto', 'out', out);
  const n = rowCount(cols);
  const entries: Array<[string, { length: number }]> = [
    ['strike', cols.strike],
    ['volatility', cols.volatility],
    ['riskFreeRate', cols.riskFreeRate],
    ['timeToExpiryYears', cols.timeToExpiryYears],
    ['type', cols.type],
  ];
  if (cols.dividendYield !== undefined) entries.push(['dividendYield', cols.dividendYield]);
  requireEqualLengths(n, entries, 'blackScholesPriceManyInto');
  if (out.length < n) {
    throw new InputError(
      `blackScholesPriceManyInto: out buffer length ${out.length} is smaller than the row count ${n}; rows would be dropped.`,
      { code: ErrorCode.InputOutOfRange, context: { outLength: out.length, rows: n } },
    );
  }
  requireNonOverlappingOut(cols, out, n, 'blackScholesPriceManyInto');
  // The UNCHECKED kernel on purpose: every column was shape- and length-checked above, so routing
  // 100,000 rows through the validating facade would re-check the same six field names per row and
  // buy nothing. Spec 3B.1b: runtime safety may cost at the scalar boundary, never per row inside an
  // already-validated columnar loop.
  for (let i = 0; i < n; i++) {
    const q = cols.dividendYield !== undefined ? cols.dividendYield[i]! : 0;
    out[i] = blackScholesPriceUnchecked({
      type: typeAt(cols.type, i),
      spot: cols.spot[i]!,
      strike: cols.strike[i]!,
      timeToExpiryYears: cols.timeToExpiryYears[i]!,
      riskFreeRate: cols.riskFreeRate[i]!,
      dividendYield: q,
      volatility: cols.volatility[i]!,
    });
  }
}

/** BSM batch pricing over columnar input. Pass `{ greeks: true }` to also fill Greek columns. */
export function blackScholesPriceMany(
  cols: OptionBatchColumns,
  options: { greeks?: boolean } = {},
): OptionBatchResult {
  requireArgumentObject('blackScholesPriceMany', 'cols', cols);
  ensureKnownKeys('blackScholesPriceMany', 'cols', cols, BATCH_COLUMN_KEYS);
  requireArgumentObject('blackScholesPriceMany', 'options', options);
  ensureKnownKeys('blackScholesPriceMany', 'options', options, ['greeks']);
  if (options.greeks !== undefined && typeof options.greeks !== 'boolean') {
    throw new InputError(
      `blackScholesPriceMany: options.greeks must be a boolean when provided. Received ${options.greeks === null ? 'null' : typeof options.greeks}.`,
      { code: ErrorCode.InputWrongType, context: { greeks: options.greeks } },
    );
  }
  requireArgumentArray(
    'blackScholesPriceMany',
    'cols.spot',
    (cols as { spot?: unknown }).spot as never,
  );
  const n = rowCount(cols);
  // Column shapes first: the per-row value loop below reads every column, so a missing column must
  // teach its name here rather than crash on `undefined[i]`.
  {
    const entries: Array<[string, { length: number }]> = [
      ['strike', cols.strike],
      ['volatility', cols.volatility],
      ['riskFreeRate', cols.riskFreeRate],
      ['timeToExpiryYears', cols.timeToExpiryYears],
      ['type', cols.type],
    ];
    if (cols.dividendYield !== undefined) entries.push(['dividendYield', cols.dividendYield]);
    requireEqualLengths(n, entries, 'blackScholesPriceMany');
  }
  for (let i = 0; i < n; i++) {
    requirePositiveRow(cols.spot[i]!, 'spot', i, 'blackScholesPriceMany');
    requirePositiveRow(cols.strike[i]!, 'strike', i, 'blackScholesPriceMany');
    requirePositiveRow(cols.timeToExpiryYears[i]!, 'timeToExpiryYears', i, 'blackScholesPriceMany');
    requirePositiveRow(cols.volatility[i]!, 'volatility', i, 'blackScholesPriceMany');
    requireFiniteRow(cols.riskFreeRate[i]!, 'riskFreeRate', i, 'blackScholesPriceMany');
    if (cols.dividendYield)
      requireFiniteRow(cols.dividendYield[i]!, 'dividendYield', i, 'blackScholesPriceMany');
  }
  const price = new Float64Array(n);
  blackScholesPriceManyInto(cols, price);
  if (!options.greeks) return { price };

  const delta = new Float64Array(n);
  const gamma = new Float64Array(n);
  const theta = new Float64Array(n);
  const vega = new Float64Array(n);
  const rho = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const q = cols.dividendYield !== undefined ? cols.dividendYield[i]! : 0;
    const g: Greeks = blackScholesGreeks({
      type: typeAt(cols.type, i),
      spot: cols.spot[i]!,
      strike: cols.strike[i]!,
      timeToExpiryYears: cols.timeToExpiryYears[i]!,
      riskFreeRate: cols.riskFreeRate[i]!,
      dividendYield: q,
      volatility: cols.volatility[i]!,
    });
    delta[i] = g.delta;
    gamma[i] = g.gamma;
    theta[i] = g.theta;
    vega[i] = g.vega;
    rho[i] = g.rho;
  }
  return { price, delta, gamma, theta, vega, rho };
}

/** Columnar input for batch implied-volatility inversion (an option chain). `type`: 1 = call, ≤ 0 = put. */
export interface OptionImpliedVolatilityBatchColumns {
  /** Observed option prices to invert. */
  price: Float64Array;
  spot: Float64Array;
  strike: Float64Array;
  riskFreeRate: Float64Array;
  /** Time to expiry in years. */
  timeToExpiryYears: Float64Array;
  type: Int8Array;
  /** Optional per-row continuous dividend yield (defaults to 0). */
  dividendYield?: Float64Array;
}

export interface OptionImpliedVolatilityBatchResult {
  impliedVolatility: Float64Array;
  /** Per row: 1 = converged, 0 = failed (inspect `reasons[i]`). */
  converged: Uint8Array;
  /** Per-row failure reason, or `undefined` where the solve converged. */
  reasons: (ImpliedVolatilityReason | undefined)[];
}

/**
 * Batch implied volatility over a columnar option chain (spec §9.6). Each row is inverted with the
 * bounded Brent solver; rows that cannot be solved report `converged[i] = 0` and a machine-readable
 * `reasons[i]` rather than a fabricated number (design law #4). The non-converged `iv[i]` is `NaN`.
 */
export function blackScholesImpliedVolatilityMany(
  cols: OptionImpliedVolatilityBatchColumns,
): OptionImpliedVolatilityBatchResult {
  requireArgumentObject('blackScholesImpliedVolatilityMany', 'cols', cols);
  ensureKnownKeys('blackScholesImpliedVolatilityMany', 'cols', cols, [
    ...BATCH_COLUMN_KEYS.filter((k) => k !== 'volatility'),
    'price',
    'lowerVolatilityBound',
    'upperVolatilityBound',
  ]);
  // The row count is defined by `cols.price`, so it (not just spot) must be a real column.
  requireArgumentArray(
    'blackScholesImpliedVolatilityMany',
    'cols.price',
    (cols as { price?: unknown }).price as never,
  );
  requireArgumentArray(
    'blackScholesImpliedVolatilityMany',
    'cols.spot',
    (cols as { spot?: unknown }).spot as never,
  );
  const n = cols.price.length;
  const entries: Array<[string, { length: number }]> = [
    ['spot', cols.spot],
    ['strike', cols.strike],
    ['riskFreeRate', cols.riskFreeRate],
    ['timeToExpiryYears', cols.timeToExpiryYears],
    ['type', cols.type],
  ];
  if (cols.dividendYield !== undefined) entries.push(['dividendYield', cols.dividendYield]);
  requireEqualLengths(n, entries, 'blackScholesImpliedVolatilityMany');
  // Validate per-row structural inputs up front, so a malformed row (e.g. NaN spot) throws rather
  // than masquerading as a `max_iterations` solver failure. Genuine no-solution rows (a valid price
  // outside the no-arbitrage bounds) still report `converged[i] = 0` with an honest reason.
  for (let i = 0; i < n; i++) {
    requirePositiveRow(cols.price[i]!, 'price', i, 'blackScholesImpliedVolatilityMany');
    requirePositiveRow(cols.spot[i]!, 'spot', i, 'blackScholesImpliedVolatilityMany');
    requirePositiveRow(cols.strike[i]!, 'strike', i, 'blackScholesImpliedVolatilityMany');
    requirePositiveRow(
      cols.timeToExpiryYears[i]!,
      'timeToExpiryYears',
      i,
      'blackScholesImpliedVolatilityMany',
    );
    requireFiniteRow(cols.riskFreeRate[i]!, 'riskFreeRate', i, 'blackScholesImpliedVolatilityMany');
    if (cols.dividendYield)
      requireFiniteRow(
        cols.dividendYield[i]!,
        'dividendYield',
        i,
        'blackScholesImpliedVolatilityMany',
      );
  }
  const impliedVolatility = new Float64Array(n);
  const converged = new Uint8Array(n);
  const reasons: (ImpliedVolatilityReason | undefined)[] = new Array<
    ImpliedVolatilityReason | undefined
  >(n);
  for (let i = 0; i < n; i++) {
    const q = cols.dividendYield !== undefined ? cols.dividendYield[i]! : 0;
    const res = blackScholesImpliedVolatility({
      type: typeAt(cols.type, i),
      price: cols.price[i]!,
      spot: cols.spot[i]!,
      strike: cols.strike[i]!,
      timeToExpiryYears: cols.timeToExpiryYears[i]!,
      riskFreeRate: cols.riskFreeRate[i]!,
      dividendYield: q,
    });
    impliedVolatility[i] = res.value;
    converged[i] = res.converged ? 1 : 0;
    reasons[i] = res.reason;
  }
  return { impliedVolatility, converged, reasons };
}

export interface PriceManyInput {
  contracts: OptionContract[];
  market: OptionMarket;
  /** Engine to use; defaults to {@link engines.auto}, the same default as `option.price`. */
  engine?: OptionPricingEngine;
}

/** Law 12 allowlist for {@link PriceManyInput}. */
const PRICE_MANY_KEYS = ['contracts', 'market', 'engine'] as const;

/** Price many contracts against one market, returning a rich `PriceResult` per contract (rows form). */
export function priceMany(input: PriceManyInput): PriceResult[] {
  requireArgumentObject('priceMany', 'input', input);
  ensureKnownKeys('priceMany', 'input', input, PRICE_MANY_KEYS);
  const { contracts, market, engine: requestedEngine } = input;
  requireArgumentArray('priceMany', 'contracts', contracts);
  requireArgumentObject('priceMany', 'market', market);
  if (requestedEngine === null) {
    throw new InputError(
      'priceMany: engine must not be null — omit the field to use the auto default. Received null.',
      { code: ErrorCode.InputWrongType, context: { field: 'engine' } },
    );
  }
  // The same default as scalar `option.price`: European → BSM, American → the American engine. A
  // batch that silently priced American rows as European (or refused them) while the scalar path
  // priced them would make the two forms disagree on the same contract.
  const engine = requestedEngine ?? engines.auto();
  requireEngine('priceMany', engine);
  return contracts.map((contract, i) => {
    // A null/garbage element must teach (typed error naming the offending index), not crash on
    // `null.style` inside the engine's support check.
    requireArgumentObject('priceMany', `contracts[${i}]`, contract);
    // Enforce the same support contract as scalar `option.price`, so an engine cannot price a
    // contract in batch that it would reject one-at-a-time.
    try {
      if (!engine.supports(contract)) {
        throw new UnsupportedError(
          `priceMany: engine "${engine.name}" does not support contracts[${i}] ` +
            `(style "${contract.style}", type "${contract.type}").`,
          {
            code: ErrorCode.EngineUnsupportedContract,
            context: {
              engine: engine.name,
              style: contract.style,
              type: contract.type,
              contractIndex: i,
            },
          },
        );
      }
      return engine.price({ contract, market });
    } catch (error) {
      rethrowAtIndex(i, error);
    }
  });
}

/**
 * Re-raise a per-row failure carrying the row it came from (H06): a 10,000-row batch whose error
 * says only "this contract" is a needle hunt. Same concrete class, same code, merged context with
 * `contractIndex`, the original as `cause` — the caller's `catch (e) { e.code }` branch and
 * `instanceof` checks see exactly what the scalar path would have thrown, plus the index.
 */
function rethrowAtIndex(index: number, error: unknown): never {
  if (error instanceof QuantError) {
    if ((error.context ?? {})['contractIndex'] !== undefined) throw error;
    const SameClass = error.constructor as new (
      message: string,
      options: { code: string; context?: Record<string, unknown>; cause?: unknown },
    ) => QuantError;
    throw new SameClass(`contracts[${index}]: ${error.message}`, {
      code: error.code,
      context: { ...error.context, contractIndex: index },
      cause: error,
    });
  }
  throw error;
}
