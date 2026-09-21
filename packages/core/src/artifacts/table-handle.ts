/**
 * The large-table reference (Gate B): a saved artifact NAMES its big tabular outputs instead of
 * inlining them, so envelopes stay small enough to hash, diff, store, and hand to an agent —
 * roadmap Journey 3's "no large chain must travel through an LLM context", made structural.
 *
 * A handle is identity + dimensions + an OPAQUE locator. The spine deliberately owns no storage:
 * `locator` is whatever string the caller's storage layer understands (a path, URL, cache key),
 * and the `contentHash` is what makes the reference verifiable wherever the bytes actually live —
 * fetch the table, hash its canonical JSON row projection, compare.
 *
 * `mediaType` is `application/json` today. A lossless Arrow mapping is RESERVED, not implemented:
 * the contract is that an Arrow-encoded table hashes over the SAME canonical JSON row projection,
 * so one logical table has one identity in either encoding. Implementation waits for a measured
 * large-table consumer — performance work is explicitly deferred in this repo by user decision.
 */

import { ErrorCode, InputError } from '../errors.js';
import { ensureKnownKeys, requireArgumentObject } from '../invariants.js';
import { contentHash, isContentHashString } from './content-hash.js';
import { scanCanonicalData } from './canonical-scan.js';

export const TABLE_HANDLE_KIND = 'totalfinance.table-handle';

/** The reserved (unimplemented) Arrow media type — reserved here so no caller invents a second name. */
export const TABLE_MEDIA_TYPE_ARROW_RESERVED = 'application/vnd.apache.arrow.file';

export interface TableHandle {
  kind: typeof TABLE_HANDLE_KIND;
  /** `sha256:` hash of the table's canonical JSON row projection — encoding-independent identity. */
  contentHash: string;
  rowCount: number;
  columnCount: number;
  /** Column names, in table order; when present, `columns.length === columnCount`. */
  columns?: string[];
  /** Storage-agnostic opaque reference — meaningful only to the storage layer that minted it. */
  locator?: string;
  /** Concrete encoding of the stored bytes. `application/json` unless a future Arrow mapping lands. */
  mediaType?: string;
}

const TABLE_HANDLE_KEYS = [
  'kind',
  'contentHash',
  'rowCount',
  'columnCount',
  'columns',
  'locator',
  'mediaType',
] as const;

/**
 * Row/column counts are METADATA — they drive no loop or allocation here, so they take no
 * practical cap — but they must be SAFE integers (2026-08-23 review, P0 "unbounded work"
 * wave): `Number.isInteger(1e308)` is `true`, yet above 2^53 an IEEE-754 double skips integers,
 * so such a "count" can neither be exact nor honestly compared against the table it names.
 */
function requireCount(functionName: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InputError(
      `${functionName}: ${field} must be a non-negative safe integer (≤ 2^53 − 1 = 9,007,199,254,740,991 — above that, doubles skip integers and a count stops being exact). Received ${typeof value === 'number' ? value : value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field } },
    );
  }
  return value;
}

/**
 * The FULL table-handle validator, shared by `createTableHandle`, every envelope site that accepts
 * a stored handle (artifact `tables`, snapshot chain `table`), AND the public {@link isTableHandle}
 * guard — one validator, so a handle that would be refused at creation can never slip into an
 * envelope pre-built or pass the guard. Beyond kind/hash/counts it enforces the optional-field
 * contracts: `columns` an array of non-empty, DUPLICATE-FREE column-name strings whose length
 * equals `columnCount`, `locator` a non-empty string when present, and `mediaType` a non-empty
 * media-type string when present. Returns the (unchanged) validated handle.
 */
export function requireTableHandle(
  functionName: string,
  label: string,
  value: unknown,
): TableHandle {
  requireArgumentObject(functionName, label, value);
  const handle = value as Partial<TableHandle> & Record<string, unknown>;
  ensureKnownKeys(functionName, label, handle, TABLE_HANDLE_KEYS as readonly string[]);
  if (handle.kind !== TABLE_HANDLE_KIND) {
    throw new InputError(
      `${functionName}: ${label}.kind must be '${TABLE_HANDLE_KIND}'. Received ${JSON.stringify(handle.kind)} — build handles with createTableHandle({ contentHash, rowCount, columnCount, … }).`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${label}.kind` },
      },
    );
  }
  const suppliedHash: unknown = handle.contentHash;
  if (!isContentHashString(suppliedHash)) {
    throw new InputError(
      `${functionName}: ${label}.contentHash must be a 'sha256:<64 hex>' string — build it with contentHash(rows). ` +
        `Received ${typeof suppliedHash === 'string' ? `"${suppliedHash.slice(0, 24)}…"` : suppliedHash === null ? 'null' : typeof suppliedHash}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${label}.contentHash` },
      },
    );
  }
  requireCount(functionName, `${label}.rowCount`, handle.rowCount);
  const columnCount = requireCount(functionName, `${label}.columnCount`, handle.columnCount);
  if (handle.columns !== undefined) {
    if (
      !Array.isArray(handle.columns) ||
      handle.columns.some((c) => typeof c !== 'string' || c.length === 0)
    ) {
      throw new InputError(
        `${functionName}: ${label}.columns must be an array of NON-EMPTY column-name strings — a ` +
          `column with no name cannot be addressed by any consumer that fetches the table.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}.columns` },
        },
      );
    }
    const seenColumns = new Set<string>();
    for (const column of handle.columns) {
      if (seenColumns.has(column)) {
        throw new InputError(
          `${functionName}: ${label}.columns names "${column}" twice — column names are the table's ` +
            `column identity, so a duplicate makes "which column is ${JSON.stringify(column)}?" ` +
            'unanswerable for every consumer. Rename or drop one.',
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${label}.columns`, column },
          },
        );
      }
      seenColumns.add(column);
    }
    if (handle.columns.length !== columnCount) {
      throw new InputError(
        `${functionName}: ${label}.columns names ${handle.columns.length} column${handle.columns.length === 1 ? '' : 's'} but columnCount is ${columnCount} — the two must agree.`,
        {
          code: ErrorCode.InputLengthMismatch,
          context: {
            function: functionName,
            field: `${label}.columns`,
            columns: handle.columns.length,
            columnCount,
          },
        },
      );
    }
  }
  if (
    handle.locator !== undefined &&
    (typeof handle.locator !== 'string' || handle.locator.length === 0)
  ) {
    throw new InputError(
      `${functionName}: ${label}.locator must be a non-empty storage-reference string when present (a path, URL, or cache key the storage layer understands). Received ${handle.locator === null ? 'null' : typeof handle.locator === 'string' ? "''" : typeof handle.locator}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${label}.locator` },
      },
    );
  }
  if (
    handle.mediaType !== undefined &&
    (typeof handle.mediaType !== 'string' || handle.mediaType.length === 0)
  ) {
    throw new InputError(
      `${functionName}: ${label}.mediaType must be a non-empty media-type string when present (e.g. 'application/json') — an empty encoding name tells the fetching side nothing. Received ${handle.mediaType === null ? 'null' : typeof handle.mediaType === 'string' ? "''" : typeof handle.mediaType}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${label}.mediaType` },
      },
    );
  }
  return value as TableHandle;
}

/**
 * Structural PREDICATE for a table handle: the COMPLETE {@link requireTableHandle} validation
 * behind a boolean door, so `value is TableHandle` is a sound claim — `true` means every envelope
 * site would accept the handle unchanged. (An earlier version checked only the required fields, so
 * `{ …, columns: 42 }` passed the guard and then detonated at the first validation site; a guard
 * that is a weaker law than the validator is a `false` dressed as a `true`.) It runs the full
 * field walk — not a constant-time tag sniff — which for a handle (a dozen scalar fields) is still
 * trivially cheap.
 */
export function isTableHandle(value: unknown): value is TableHandle {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    requireTableHandle('isTableHandle', 'value', value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a validated, frozen table handle.
 *
 * @example
 * ```ts
 * const handle = createTableHandle({
 *   contentHash: contentHash(chainRows),
 *   rowCount: chainRows.length,
 *   columnCount: 8,
 *   columns: ['strike', 'expiry', 'bid', 'ask', 'mid', 'volume', 'openInterest', 'impliedVolatility'],
 *   locator: 'artifacts/chains/aapl-2026-07-20.json',
 * });
 * ```
 */
export function createTableHandle(input: {
  contentHash: string;
  rowCount: number;
  columnCount: number;
  columns?: string[];
  locator?: string;
  mediaType?: string;
}): TableHandle {
  requireArgumentObject('createTableHandle', 'input', input);
  ensureKnownKeys('createTableHandle', 'input', input, [
    'contentHash',
    'rowCount',
    'columnCount',
    'columns',
    'locator',
    'mediaType',
  ]);
  // ONE validator: creation routes through the same full check every envelope site applies to a
  // stored handle, so create-time and read-time can never disagree about what a handle is.
  const validated = requireTableHandle('createTableHandle', 'input', {
    kind: TABLE_HANDLE_KIND,
    contentHash: input.contentHash,
    rowCount: input.rowCount,
    columnCount: input.columnCount,
    ...(input.columns !== undefined ? { columns: input.columns } : {}),
    ...(input.locator !== undefined ? { locator: input.locator } : {}),
    ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
  });
  return Object.freeze({
    kind: TABLE_HANDLE_KIND,
    contentHash: validated.contentHash,
    rowCount: validated.rowCount,
    columnCount: validated.columnCount,
    ...(validated.columns !== undefined
      ? { columns: Object.freeze([...validated.columns]) as string[] }
      : {}),
    ...(validated.locator !== undefined ? { locator: validated.locator } : {}),
    ...(validated.mediaType !== undefined ? { mediaType: validated.mediaType } : {}),
  });
}

const ROWS_HANDLE_KEYS = ['rows', 'locator', 'mediaType'] as const;

/**
 * Mint the table handle for a row set the caller holds (Stage 4.5 Decision 4 — the ONE column law
 * every package shares, so the same rows always mint the same handle):
 *
 * - an array of plain records → `columns` is the sorted union of the rows' own keys;
 * - an array of numbers (a returns or realized-variance vector) → one column, `['value']`;
 * - anything else (mixed rows, nested arrays, non-plain objects) is refused with the teaching.
 *
 * `contentHash` is the canonical-JSON hash of the rows exactly as given, so a consumer that later
 * receives rows can prove they are the referenced ones by re-minting and comparing hashes.
 *
 * @example
 * ```ts
 * const handle = tableHandleForRows({ rows: observations, locator: 'universe/2026-09-01.json' });
 * // { kind: 'totalfinance.table-handle', contentHash: 'sha256:…', rowCount: 4200, columnCount: 3, columns: ['availableTimestampMs', 'fields', 'instrumentId'] }
 * ```
 */
export function tableHandleForRows(input: {
  rows: readonly unknown[];
  locator?: string;
  mediaType?: string;
}): TableHandle {
  const functionName = 'tableHandleForRows';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ROWS_HANDLE_KEYS);
  const rows = input.rows;
  if (!Array.isArray(rows)) {
    throw new InputError(
      `${functionName}: input.rows must be an array of rows (plain records or numbers). Received ${rows === null ? 'null' : typeof rows}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'input.rows' } },
    );
  }
  // Prove the rows are behavior-free stored data (dense, plain, acyclic) before reading or hashing them.
  scanCanonicalData(rows, { functionName, label: 'input.rows' });
  let columns: string[];
  if (rows.length === 0) {
    columns = [];
  } else if (rows.every((row) => typeof row === 'number')) {
    columns = ['value'];
  } else if (
    rows.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null),
    )
  ) {
    const union = new Set<string>();
    for (const row of rows as readonly Record<string, unknown>[]) {
      for (const key of Object.keys(row)) union.add(key);
    }
    columns = [...union].sort();
    if (columns.some((column) => column.length === 0)) {
      throw new InputError(
        `${functionName}: input.rows contains a record with an empty-string key — a column with no name cannot be addressed by any consumer.`,
        {
          code: ErrorCode.InputWrongShape,
          context: { function: functionName, field: 'input.rows' },
        },
      );
    }
  } else {
    throw new InputError(
      `${functionName}: input.rows must be EITHER an array of plain records (one column per key) OR an array of numbers (one 'value' column) — mixed or nested rows have no single column law. Project them to records first, e.g. rows.map((value, index) => ({ index, value })).`,
      { code: ErrorCode.InputWrongShape, context: { function: functionName, field: 'input.rows' } },
    );
  }
  return createTableHandle({
    contentHash: contentHash(rows),
    rowCount: rows.length,
    columnCount: columns.length,
    ...(columns.length > 0 ? { columns } : {}),
    ...(input.locator !== undefined ? { locator: input.locator } : {}),
    ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}),
  });
}
