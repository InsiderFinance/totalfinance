/**
 * Shared implementation-risk diagnostics (spec §16.3).
 *
 * Backtests are models; this surfaces the data-quality assumptions a run silently relies on. The
 * per-engine policy blocks and look-ahead checks live in the engines; this module supplies the
 * **data-alignment** checks both engines fold into their warnings.
 */

import { requireArgumentArray, WarningCode } from '@totalfinance/core';
import type { QuantWarning } from '@totalfinance/core';
import type { Bar } from './types.js';

/**
 * Check that each symbol's bars are strictly time-ascending with finite positive prices. Returns
 * structured warnings for out-of-order timestamps, duplicate timestamps, and non-finite/non-positive
 * closes — the silent corruptions that make a backtest quietly wrong.
 */
export function checkDataAlignment(bars: Bar[]): QuantWarning[] {
  requireArgumentArray('checkDataAlignment', 'bars', bars);
  const warnings: QuantWarning[] = [];
  const lastTs = new Map<string, number>();
  let unsorted = 0;
  let duplicates = 0;
  let badPrice = 0;
  for (const b of bars) {
    const prev = lastTs.get(b.symbol);
    if (prev !== undefined) {
      if (b.timestampMs < prev) unsorted++;
      else if (b.timestampMs === prev) duplicates++;
    }
    lastTs.set(b.symbol, b.timestampMs);
    if (
      !(b.close > 0) ||
      !Number.isFinite(b.open) ||
      !Number.isFinite(b.high) ||
      !Number.isFinite(b.low)
    ) {
      badPrice++;
    }
  }
  if (unsorted > 0) {
    warnings.push({
      code: WarningCode.BacktestDataUnsorted,
      message: `${unsorted} bar(s) are out of time order within their symbol; results may be misaligned.`,
      severity: 'warn',
      context: { count: unsorted },
    });
  }
  if (duplicates > 0) {
    warnings.push({
      code: WarningCode.BacktestDataDuplicateTimestamp,
      message: `${duplicates} bar(s) share a timestamp with the previous bar of the same symbol.`,
      severity: 'warn',
      context: { count: duplicates },
    });
  }
  if (badPrice > 0) {
    warnings.push({
      code: WarningCode.BacktestDataNonfinite,
      message: `${badPrice} bar(s) have a non-positive or non-finite price.`,
      severity: 'warn',
      context: { count: badPrice },
    });
  }
  return warnings;
}
