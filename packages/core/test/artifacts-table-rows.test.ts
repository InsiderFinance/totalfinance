/**
 * Stage 4.5 Decision 4 — the ONE column law for minting a table handle from rows: records → the
 * sorted union of keys; numbers → one 'value' column; anything else refuses. The hash is the rows'
 * canonical content hash, so a receiver can prove supplied rows are the referenced ones.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { contentHash, isTableHandle, tableHandleForRows } from '@totalfinance/core/artifacts';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

describe('tableHandleForRows', () => {
  it('mints the sorted key union for records and hashes the rows as given', () => {
    const rows = [
      { instrumentId: 'AAPL', value: 1 },
      { value: 2, instrumentId: 'MSFT', sector: 'tech' },
    ];
    const handle = tableHandleForRows({ rows, locator: 'rows/1.json' });
    expect(isTableHandle(handle)).toBe(true);
    expect(handle.rowCount).toBe(2);
    expect(handle.columnCount).toBe(3);
    expect(handle.columns).toEqual(['instrumentId', 'sector', 'value']);
    expect(handle.contentHash).toBe(contentHash(rows));
    expect(handle.locator).toBe('rows/1.json');
    expect(Object.isFrozen(handle)).toBe(true);
  });

  it('mints one value column for a numeric vector and no columns for no rows', () => {
    const vector = tableHandleForRows({ rows: [0.01, -0.02, 0.003] });
    expect(vector.columns).toEqual(['value']);
    expect(vector.columnCount).toBe(1);
    expect(vector.rowCount).toBe(3);
    const empty = tableHandleForRows({ rows: [] });
    expect(empty.rowCount).toBe(0);
    expect(empty.columnCount).toBe(0);
    expect(empty.columns).toBeUndefined();
  });

  it('is the identity a receiver re-mints: same rows, any key order → same hash', () => {
    const a = tableHandleForRows({ rows: [{ x: 1, y: 2 }] });
    const b = tableHandleForRows({ rows: [{ y: 2, x: 1 }] });
    expect(a.contentHash).toBe(b.contentHash);
    const changed = tableHandleForRows({ rows: [{ x: 1, y: 3 }] });
    expect(changed.contentHash).not.toBe(a.contentHash);
  });

  it('refuses mixed, nested, hostile, and malformed row sets with the teaching', () => {
    expect(codeOf(() => tableHandleForRows({ rows: [1, { a: 1 }] }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(() => tableHandleForRows({ rows: [[1, 2]] })).toThrow(/mixed or nested rows/);
    class Row {
      a = 1;
    }
    expect(codeOf(() => tableHandleForRows({ rows: [new Row()] }))).toBe(
      ErrorCode.SerializationUnsupportedValue,
    );
    const hostile = {};
    Object.defineProperty(hostile, 'a', { enumerable: true, get: () => 1 });
    expect(() => tableHandleForRows({ rows: [hostile] })).toThrow(/accessors/);
    expect(codeOf(() => tableHandleForRows({ rows: [{ '': 1 }] }))).toBe(ErrorCode.InputWrongShape);
    expect(codeOf(() => tableHandleForRows({ rows: 'rows' as never }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => tableHandleForRows({ rows: [1], bogus: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => tableHandleForRows({ rows: [1], locator: '' }))).toBe(
      ErrorCode.InputWrongType,
    );
  });
});
