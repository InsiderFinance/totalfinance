/**
 * Columnar ⇄ row conversion (dx §1.2). Bar-input indicators take an array of bar ROWS
 * (`{ high, low, close, … }` per element); charting stacks and the MCP surface speak COLUMNS
 * (`{ high: number[], low: number[], close: number[] }`). These converters are the sanctioned
 * bridge — passing columns where rows are expected throws a teaching error naming
 * `barsFromColumns` instead of silently emitting garbage.
 */

import { ensureKnownKeys, ErrorCode, InputError } from '@totalfinance/core';
import type { BarInput } from './framework.js';

export interface BarColumns {
  open?: readonly number[];
  high?: readonly number[];
  low?: readonly number[];
  close?: readonly number[];
  volume?: readonly number[];
}

const COLUMN_KEYS = ['open', 'high', 'low', 'close', 'volume'] as const;

/**
 * Convert columnar OHLCV arrays into bar rows. All supplied columns must be arrays of one shared
 * length; omitted columns are simply absent from the rows. Throws typed teaching errors on shape
 * garbage — never returns a partial result.
 */
export function barsFromColumns(columns: BarColumns): BarInput[] {
  const functionName = 'technicalAnalysis.barsFromColumns';
  if (columns === null || typeof columns !== 'object' || Array.isArray(columns)) {
    throw new InputError(
      `${functionName}: expected { open?, high?, low?, close?, volume? } columnar arrays, got ${
        columns === null ? 'null' : Array.isArray(columns) ? 'an array' : typeof columns
      }.`,
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  // Law 12: a `colse` typo must teach, never silently build bars with no close column.
  ensureKnownKeys(functionName, 'columns', columns, ['open', 'high', 'low', 'close', 'volume']);
  const present = COLUMN_KEYS.filter((k) => columns[k] !== undefined);
  if (present.length === 0) {
    throw new InputError(`${functionName}: supply at least one of open/high/low/close/volume.`, {
      code: ErrorCode.InputMissingField,
      context: {},
    });
  }
  let length: number | undefined;
  for (const key of present) {
    const col = columns[key];
    if (!Array.isArray(col) && !ArrayBuffer.isView(col)) {
      throw new InputError(`${functionName}: ${key} must be an array of numbers.`, {
        code: ErrorCode.InputWrongType,
        context: { field: key },
      });
    }
    if (length === undefined) length = col.length;
    else if (col.length !== length) {
      throw new InputError(
        `${functionName}: column lengths differ (${key} has ${col.length}, expected ${length}).`,
        { code: ErrorCode.InputOutOfRange, context: { field: key, length: col.length } },
      );
    }
  }
  const bars: BarInput[] = new Array(length!);
  for (let i = 0; i < length!; i++) {
    const bar: Record<string, number> = {};
    for (const key of present) bar[key] = columns[key]![i]!;
    bars[i] = bar as unknown as BarInput;
  }
  return bars;
}

/** Convert bar rows back into columnar arrays (only columns present on the first bar are emitted). */
export function columnsFromBars(bars: readonly BarInput[]): BarColumns {
  const functionName = 'technicalAnalysis.columnsFromBars';
  if (!Array.isArray(bars)) {
    throw new InputError(`${functionName}: expected an array of bars.`, {
      code: ErrorCode.InputWrongType,
      context: {},
    });
  }
  if (bars.length === 0) return {};
  const first = bars[0] as unknown as Record<string, unknown>;
  const present = COLUMN_KEYS.filter((k) => typeof first[k] === 'number');
  const out: Record<string, number[]> = {};
  for (const key of present) out[key] = bars.map((b) => (b as Record<string, number>)[key]!);
  return out as BarColumns;
}
