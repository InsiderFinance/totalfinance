/**
 * Batch option pricing (spec §9.6).
 *
 * Two shapes:
 *   - rows: `priceMany({ contracts, market, engine })` → `PriceResult[]` (rich, convenient).
 *   - columns: struct-of-arrays `Float64Array` kernels for hot loops — `blackScholesEvaluateMany`
 *     for any selection of outputs, `blackScholesPriceMany` for price (optionally with the five
 *     first-order Greeks) — each with a buffer-writing `*Into` variant for zero-allocation reuse.
 *
 * Every columnar Black–Scholes path runs the ONE selective kernel (`bsm-evaluate.ts`): the plan is
 * resolved once per call, only the requested outputs and their dependencies are computed per row,
 * and values are written straight into the output columns. Batch output is defined to match scalar
 * output exactly (same expressions), which the tests assert bit for bit.
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
  requireSelection,
} from '@totalfinance/core';
import { blackScholesImpliedVolatility, type ImpliedVolatilityReason } from './bsm.js';
import {
  BLACK_SCHOLES_OUTPUTS,
  BLACK_SCHOLES_OUTPUT_SLOTS,
  type BlackScholesOutput,
  type BlackScholesOutputSelection,
  type BlackScholesPlan,
  evaluateBlackScholesRowsUnchecked,
  resolveBlackScholesPlan,
} from './bsm-evaluate.js';
import { type OptionPricingEngine, engines, requireEngine } from './engines.js';
import type { OptionMarket, PriceResult } from './types.js';

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
    // A string has a numeric `length` too; a column is an array or a typed array, nothing else.
    if (!Array.isArray(arr) && !(ArrayBuffer.isView(arr) && !(arr instanceof DataView))) {
      throw new InputError(
        `${functionName}: column "${name}" must be a Float64Array/Int8Array (or a number array) of ${n} rows; got ${typeof arr}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { column: name, received: typeof arr },
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
  if (!Number.isFinite(value) || !(value > 0)) {
    throw new InputError(
      `${functionName}: ${field} at row ${row} must be a positive finite number, got ${rowValue(value)}.`,
      { code: ErrorCode.InputOutOfRange, context: { row, field, value: rowContext(value) } },
    );
  }
}

function requireFiniteRow(value: number, field: string, row: number, functionName: string): void {
  if (!Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${field} at row ${row} must be finite, got ${rowValue(value)}.`,
      { code: ErrorCode.InputNotFinite, context: { row, field, value: rowContext(value) } },
    );
  }
}

/**
 * A row value as an error names it. Columns are typed arrays, but plain arrays reach the boundary at
 * run time too: a non-number names its type, so `"100" (string)` and `100n (bigint)` read as the
 * mistakes they are rather than as plausible numbers.
 */
function rowValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `${JSON.stringify(value)} (string)`;
  if (typeof value === 'bigint') return `${value}n (bigint)`;
  if (typeof value === 'boolean') return `${value ? 'true' : 'false'} (boolean)`;
  return describeReceived(value);
}

/** Error context keeps a number as a number; anything else as its description (a BigInt cannot be JSON). */
function rowContext(value: unknown): number | string {
  return typeof value === 'number' ? value : rowValue(value);
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
 * The column SHAPE half of the batch boundary: a closed columns object whose every column is an
 * array of exactly the row count. Returns the row count.
 */
function requireBatchColumnShapes(
  functionName: string,
  field: string,
  cols: OptionBatchColumns,
): number {
  requireArgumentObject(functionName, field, cols);
  ensureKnownKeys(functionName, field, cols, BATCH_COLUMN_KEYS);
  requireArgumentArray(functionName, `${field}.spot`, (cols as { spot?: unknown }).spot);
  const n = rowCount(cols);
  // Column shapes first: the per-row value loop reads every column, so a missing column must teach
  // its name here rather than crash on `undefined[i]`.
  const entries: Array<[string, { length: number }]> = [
    ['strike', cols.strike],
    ['volatility', cols.volatility],
    ['riskFreeRate', cols.riskFreeRate],
    ['timeToExpiryYears', cols.timeToExpiryYears],
    ['type', cols.type],
  ];
  if (cols.dividendYield !== undefined) entries.push(['dividendYield', cols.dividendYield]);
  requireEqualLengths(n, entries, functionName);
  return n;
}

/**
 * The VALUE half of the batch boundary: every value the kernel consumes is usable — positive finite
 * spot, strike, time and volatility; finite rate, dividend yield and type. One flat pass over the
 * columns, before anything is allocated or written (selective Greeks spec, decision 8).
 */
function requireBatchRowValues(cols: OptionBatchColumns, n: number, functionName: string): void {
  const { spot, strike, timeToExpiryYears, volatility, riskFreeRate, type, dividendYield } = cols;
  for (let i = 0; i < n; i++) {
    const S = spot[i]!;
    const K = strike[i]!;
    const T = timeToExpiryYears[i]!;
    const sigma = volatility[i]!;
    const r = riskFreeRate[i]!;
    const q = dividendYield === undefined ? 0 : dividendYield[i]!;
    const kind = type[i]!;
    // Fast path: one inline test per row, no calls, so no number is boxed on a valid row.
    // `typeof x === 'number' && x > 0 && x < Infinity` is "a positive finite number": the typeof
    // test comes first because the comparisons alone coerce — "100", true and 100n all compare
    // greater than 0 — and a plain-array column could otherwise carry one past validation into the
    // kernel. NaN fails the comparisons. Number.isFinite never coerces.
    if (
      typeof S === 'number' &&
      S > 0 &&
      S < Infinity &&
      typeof K === 'number' &&
      K > 0 &&
      K < Infinity &&
      typeof T === 'number' &&
      T > 0 &&
      T < Infinity &&
      typeof sigma === 'number' &&
      sigma > 0 &&
      sigma < Infinity &&
      Number.isFinite(r) &&
      Number.isFinite(q) &&
      Number.isFinite(kind)
    ) {
      continue;
    }
    // A failing row re-runs the precise checks in order, so the typed error names the first bad field.
    requirePositiveRow(S, 'spot', i, functionName);
    requirePositiveRow(K, 'strike', i, functionName);
    requirePositiveRow(T, 'timeToExpiryYears', i, functionName);
    requirePositiveRow(sigma, 'volatility', i, functionName);
    requireFiniteRow(r, 'riskFreeRate', i, functionName);
    if (dividendYield !== undefined) requireFiniteRow(q, 'dividendYield', i, functionName);
    requireFiniteRow(kind, 'type', i, functionName);
  }
}

/**
 * The columnar Black–Scholes evaluation every batch path shares: `targets[k]` receives the plan's
 * k-th requested output for rows `[0, rows)`; nothing past `rows` is touched. The caller has
 * validated every column, value and target, so the kernel's row loop runs without per-row
 * validation or per-row objects (spec 3B.1b; selective Greeks decision 1).
 *
 * Row `i`'s inputs are all read before any of its outputs is written, which is what keeps
 * `blackScholesPriceManyInto`'s exact in-place aliasing correct.
 */
function evaluateColumns(
  plan: BlackScholesPlan,
  cols: OptionBatchColumns,
  rows: number,
  targets: readonly Float64Array[],
): void {
  const bySlot = new Array<Float64Array | undefined>(BLACK_SCHOLES_OUTPUT_SLOTS);
  for (let k = 0; k < plan.slots.length; k++) bySlot[plan.slots[k]!] = targets[k];
  evaluateBlackScholesRowsUnchecked(plan, cols, rows, bySlot);
}

/** Byte range `[start, end)` the first `rows` elements of a typed array occupy, or none for a plain array. */
function byteRange(
  view: ArrayLike<number>,
  rows: number,
): { buffer: ArrayBufferLike; start: number; end: number } | undefined {
  if (!ArrayBuffer.isView(view)) return undefined;
  const typed = view as unknown as Float64Array | Int8Array;
  return {
    buffer: typed.buffer,
    start: typed.byteOffset,
    end: typed.byteOffset + rows * typed.BYTES_PER_ELEMENT,
  };
}

function presentColumns(cols: OptionBatchColumns): Array<[string, Float64Array | Int8Array]> {
  const columns: Array<[string, Float64Array | Int8Array]> = [
    ['spot', cols.spot],
    ['strike', cols.strike],
    ['volatility', cols.volatility],
    ['riskFreeRate', cols.riskFreeRate],
    ['timeToExpiryYears', cols.timeToExpiryYears],
    ['type', cols.type],
  ];
  if (cols.dividendYield !== undefined) columns.push(['dividendYield', cols.dividendYield]);
  return columns;
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
  for (const [name, column] of presentColumns(cols)) {
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
 * Validates the columns (closed keys, exact row counts) and every row's values — positive finite
 * spot, strike, time and volatility; finite rate, dividend yield and type — before writing anything,
 * exactly as {@link blackScholesPriceMany} does. Elements of `out` past the row count are untouched.
 *
 * `out` may alias an input column EXACTLY (in-place pricing); a partial overlap is rejected.
 */
export function blackScholesPriceManyInto(cols: OptionBatchColumns, out: Float64Array): void {
  const n = requireBatchColumnShapes('blackScholesPriceManyInto', 'cols', cols);
  requireArgumentArray('blackScholesPriceManyInto', 'out', out);
  if (out.length < n) {
    throw new InputError(
      `blackScholesPriceManyInto: out buffer length ${out.length} is smaller than the row count ${n}; rows would be dropped.`,
      { code: ErrorCode.InputOutOfRange, context: { outLength: out.length, rows: n } },
    );
  }
  requireNonOverlappingOut(cols, out, n, 'blackScholesPriceManyInto');
  // Selective Greeks spec, decision 9 (a documented correction): this path used to validate shapes
  // only and price NaN for a non-positive or non-finite row. A reusable buffer is storage, not a
  // licence to skip input validation — the values are checked here, in one flat pass, before the
  // first write, so a rejected call never leaves `out` half-updated.
  requireBatchRowValues(cols, n, 'blackScholesPriceManyInto');
  evaluateColumns(resolveBlackScholesPlan(['price']), cols, n, [out]);
}

/**
 * BSM batch pricing over columnar input. Pass `{ greeks: true }` to also fill the five first-order
 * Greek columns (theta per calendar day, vega and rho per 1%), computed in the SAME pass as price so
 * `d1`, `d2`, the discounts and the distribution terms are evaluated once per row.
 *
 * For any other selection — gamma alone, price and gamma, the higher-order Greeks — use
 * {@link blackScholesEvaluateMany}.
 */
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
  const n = requireBatchColumnShapes('blackScholesPriceMany', 'cols', cols);
  requireBatchRowValues(cols, n, 'blackScholesPriceMany');
  const price = new Float64Array(n);
  if (!options.greeks) {
    evaluateColumns(resolveBlackScholesPlan(['price']), cols, n, [price]);
    return { price };
  }
  const delta = new Float64Array(n);
  const gamma = new Float64Array(n);
  const theta = new Float64Array(n);
  const vega = new Float64Array(n);
  const rho = new Float64Array(n);
  evaluateColumns(
    resolveBlackScholesPlan(['price', 'delta', 'gamma', 'theta', 'vega', 'rho']),
    cols,
    n,
    [price, delta, gamma, theta, vega, rho],
  );
  return { price, delta, gamma, theta, vega, rho };
}

// ---- selective batch evaluation (selective Greeks spec, decisions 6–8) ----

/** Options for {@link blackScholesEvaluateMany}. */
export interface BlackScholesEvaluateManyOptions<
  O extends BlackScholesOutputSelection = BlackScholesOutputSelection,
> {
  /**
   * The outputs to compute, e.g. `['gamma']` or `['price', 'delta']`. Required, nonempty, dense and
   * duplicate-free; only these are computed and returned.
   */
  outputs: O;
}

/**
 * One `Float64Array` (one value per row) for each selected output. A literal selection gives exactly
 * those required columns; a dynamic selection (`BlackScholesOutput[]`) gives optional ones, because
 * the type cannot know which outputs were requested and never claims one exists that was not.
 */
export type BlackScholesEvaluateManyResult<O extends BlackScholesOutputSelection> =
  number extends O['length']
    ? { [K in O[number]]?: Float64Array }
    : { [K in O[number]]: Float64Array };

/**
 * Caller-owned output storage for {@link blackScholesEvaluateManyInto}: the property names ARE the
 * selection. Each buffer is a `Float64Array` with at least one element per row; only elements
 * `[0, rows)` are written.
 */
export interface BlackScholesOutputBuffers {
  /** Option value. */
  price?: Float64Array;
  /** ∂V/∂S. */
  delta?: Float64Array;
  /** ∂²V/∂S². */
  gamma?: Float64Array;
  /** Value change per calendar day elapsed. */
  theta?: Float64Array;
  /** Value change per 1% (0.01) volatility move. */
  vega?: Float64Array;
  /** Value change per 1% (0.01) rate move. */
  rho?: Float64Array;
  /** ∂Δ/∂σ, per 1.00 σ. */
  vanna?: Float64Array;
  /** ∂Δ/∂T, per added year of time-to-expiry. */
  charm?: Float64Array;
  /** ∂²V/∂σ², per 1.00 σ². */
  vomma?: Float64Array;
  /** ∂Γ/∂S. */
  speed?: Float64Array;
  /** ∂Γ/∂T, per added year of time-to-expiry. */
  color?: Float64Array;
}

type OutputBuffersAreTotal = [
  Exclude<BlackScholesOutput, keyof BlackScholesOutputBuffers>,
  Exclude<keyof BlackScholesOutputBuffers, BlackScholesOutput>,
] extends [never, never]
  ? true
  : never;
const OUTPUT_BUFFERS_ARE_TOTAL: OutputBuffersAreTotal = true;
void OUTPUT_BUFFERS_ARE_TOTAL;

/**
 * Black–Scholes–Merton outputs for every row of a columnar batch, computing ONLY the selected
 * outputs and their dependencies — `{ outputs: ['gamma'] }` evaluates no cumulative normal.
 *
 * Validates the columns (closed keys, exact row counts), every row's values (positive finite spot,
 * strike, time and volatility; finite rate, dividend yield and type) and the selection, then
 * allocates one `Float64Array` per selected output. Values are bit-identical to the scalar
 * `blackScholes` functions on the same row. Units: theta per calendar day, vega and rho per 1%,
 * higher-order Greeks in the raw units of `blackScholes.extendedGreeks`.
 *
 * @example
 * const { gamma } = blackScholesEvaluateMany(columns, { outputs: ['gamma'] });
 */
export function blackScholesEvaluateMany<const O extends BlackScholesOutputSelection>(
  columns: OptionBatchColumns,
  options: BlackScholesEvaluateManyOptions<O>,
): BlackScholesEvaluateManyResult<O> {
  const functionName = 'blackScholesEvaluateMany';
  const n = requireBatchColumnShapes(functionName, 'columns', columns);
  requireBatchRowValues(columns, n, functionName);
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, ['outputs']);
  const outputs = requireSelection(
    functionName,
    'options.outputs',
    (options as { outputs?: unknown }).outputs,
    BLACK_SCHOLES_OUTPUTS,
  );
  const plan = resolveBlackScholesPlan(outputs);
  const targets = outputs.map(() => new Float64Array(n));
  evaluateColumns(plan, columns, n, targets);
  const result: Partial<Record<BlackScholesOutput, Float64Array>> = {};
  for (let k = 0; k < outputs.length; k++) result[outputs[k]!] = targets[k]!;
  return result as BlackScholesEvaluateManyResult<O>;
}

function describeReceived(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' && name !== '' ? name : 'object';
}

/**
 * Write the selected Black–Scholes–Merton outputs for every row into caller-owned buffers — the
 * zero-allocation form of {@link blackScholesEvaluateMany} for hot loops that reuse storage. The
 * property names of `outputs` are the selection: `{ gamma: buffer }` computes gamma only.
 *
 * Reusable storage is not unchecked input. Before anything is written this validates the columns
 * and every row's values exactly as {@link blackScholesEvaluateMany} does, and every buffer: a
 * `Float64Array` (not a plain array or another typed array) with at least one element per row. No
 * buffer may overlap an input column or another output buffer in memory — not even an exact alias —
 * because a write would then change values that are still to be read or returned. A rejected call
 * writes nothing; a successful one writes elements `[0, rows)` of each buffer and leaves the rest
 * untouched. An `undefined` entry is treated as omitted.
 *
 * @example
 * const gamma = new Float64Array(capacity);
 * blackScholesEvaluateManyInto(columns, { gamma });
 */
export function blackScholesEvaluateManyInto(
  columns: OptionBatchColumns,
  outputs: BlackScholesOutputBuffers,
): void {
  const functionName = 'blackScholesEvaluateManyInto';
  const n = requireBatchColumnShapes(functionName, 'columns', columns);
  requireArgumentObject(functionName, 'outputs', outputs);
  ensureKnownKeys(functionName, 'outputs', outputs, BLACK_SCHOLES_OUTPUTS);
  const selected: BlackScholesOutput[] = [];
  const targets: Float64Array[] = [];
  for (const name of Object.keys(outputs) as BlackScholesOutput[]) {
    const buffer: unknown = outputs[name];
    if (buffer === undefined) continue;
    if (!(buffer instanceof Float64Array)) {
      throw new InputError(
        `${functionName}: outputs.${name} must be a Float64Array with at least ${n} elements (reusable output storage); got ${describeReceived(buffer)}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, output: name, received: describeReceived(buffer) },
        },
      );
    }
    if (buffer.length < n) {
      throw new InputError(
        `${functionName}: outputs.${name} has length ${buffer.length}, smaller than the row count ${n}; rows would be dropped.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, output: name, length: buffer.length, rows: n },
        },
      );
    }
    selected.push(name);
    targets.push(buffer);
  }
  if (selected.length === 0) {
    throw new InputError(
      `${functionName}: outputs must name at least one output buffer, e.g. { gamma: new Float64Array(${n}) }. Allowed outputs: ${BLACK_SCHOLES_OUTPUTS.join(', ')}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field: 'outputs' } },
    );
  }
  requireDisjointOutputs(columns, selected, targets, n, functionName);
  requireBatchRowValues(columns, n, functionName);
  evaluateColumns(resolveBlackScholesPlan(selected), columns, n, targets);
}

/**
 * Selective Greeks spec, decision 8: an output buffer may share memory with neither an input column
 * nor another output. Unlike `blackScholesPriceManyInto`'s single `out`, exact aliasing is refused
 * too — overwriting the spot column with gamma, or writing delta and gamma into one buffer, returns
 * the caller something other than what they asked for.
 */
function requireDisjointOutputs(
  cols: OptionBatchColumns,
  names: readonly BlackScholesOutput[],
  buffers: readonly Float64Array[],
  rows: number,
  functionName: string,
): void {
  const columns = presentColumns(cols);
  for (let k = 0; k < buffers.length; k++) {
    const buffer = buffers[k]!;
    const out = byteRange(buffer, rows)!;
    for (const [column, values] of columns) {
      const input = byteRange(values, rows);
      if (input === undefined || input.buffer !== out.buffer) continue;
      if (input.start < out.end && out.start < input.end) {
        throw new InputError(
          `${functionName}: outputs.${names[k]} overlaps input column "${column}" in the same ArrayBuffer ` +
            `(output bytes [${out.start}, ${out.end}) vs "${column}" bytes [${input.start}, ${input.end})). ` +
            'Writing it would overwrite inputs the batch still reads; give each output its own storage.',
          {
            code: ErrorCode.InputWrongShape,
            context: { function: functionName, output: names[k], column, rows },
          },
        );
      }
    }
    for (let j = 0; j < k; j++) {
      const other = buffers[j]!;
      const prior = byteRange(other, rows)!;
      if (
        other === buffer ||
        (prior.buffer === out.buffer && prior.start < out.end && out.start < prior.end)
      ) {
        throw new InputError(
          `${functionName}: outputs.${names[j]} and outputs.${names[k]} share memory; each output needs its own buffer, or one would overwrite the other.`,
          {
            code: ErrorCode.InputWrongShape,
            context: { function: functionName, output: names[k], overlapsOutput: names[j], rows },
          },
        );
      }
    }
  }
}

export type { BlackScholesOutput, BlackScholesOutputSelection } from './bsm-evaluate.js';

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
