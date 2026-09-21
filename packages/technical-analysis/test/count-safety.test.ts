/**
 * Count/resource safety, library-wide wave (2026-08-23 review, P0).
 *
 * `Number.isInteger(1e308)` is `true` and `counter++` stops advancing at 2^53, so an "integer"
 * control validated with `Number.isInteger` and then looped, allocated, or incremented was a
 * non-terminating loop, an absurd allocation, or a frozen counter. In this package: indicator
 * periods and counts (the shared validators), swing windows, the warmup probe length (the one true
 * workload control — it synthesizes the probe and runs `explain` over it), discovery paging, and
 * the snapshot StateReader heads that restore counts and ring-buffer lookbacks from raw JSON.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import * as ta from '@totalfinance/technical-analysis';
import {
  SCHEMA_VERSION,
  type TechnicalAnalysisSnapshot,
  divergences,
  indicatorWarmup,
  readSnapshot,
  searchIndicators,
} from '@totalfinance/technical-analysis';

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 4) * 5 + i * 0.1);
const bars = closes.map((close, i) => {
  const open = i === 0 ? close : closes[i - 1]!;
  return {
    open,
    high: Math.max(open, close) + 1,
    low: Math.min(open, close) - 1,
    close,
    volume: 1_000 + i,
  };
});

describe('2026-08-23 P0 — shared validators are safe integers', () => {
  it('requirePeriod refuses large-safe allocations as well as unsafe counts; real periods unchanged', () => {
    for (const bad of [1_000_001, 2 ** 32, 2 ** 53, 2 ** 53 + 2, 1e308, 2.5]) {
      const error = caught(() => ta.sma(closes, { period: bad }));
      expect(isQuantError(error, 'input.out_of_range'), `period = ${bad}`).toBe(true);
    }
    expect(ta.sma(closes, { period: 5 })).toHaveLength(closes.length);
  });

  it('candleAverage applies the same lookback ceiling while preserving its period-zero rule', () => {
    for (const bad of [1_000_001, 2 ** 32, 2 ** 53, 1e308, 2.5, -1]) {
      const error = caught(() =>
        ta.candleAverage(bars, { range: 'realBody', averagePeriod: bad, factor: 1 }),
      );
      expect(isQuantError(error, 'input.out_of_range'), `averagePeriod = ${bad}`).toBe(true);
    }
    expect(() =>
      ta.candleAverage(bars, { range: 'realBody', averagePeriod: 0, factor: 1 }),
    ).not.toThrow();
  });

  it('MAVP period observations remain bounded selector data, rounded and clamped by its options', () => {
    const periods = closes.map((_, index) => (index === 0 ? 2 ** 32 : 2.5));
    expect(
      ta.mavp({ series: closes, periods, parameters: { minPeriod: 2, maxPeriod: 30 } }),
    ).toHaveLength(closes.length);
  });

  it('allocation-heavy stream constructors teach instead of leaking Array RangeError', () => {
    for (const make of [
      () => ta.trima.stream({ period: 2 ** 32 }),
      () => ta.msw.stream({ period: 2 ** 32 }),
    ]) {
      const error = caught(make);
      expect(isQuantError(error, 'input.out_of_range')).toBe(true);
      expect(error).not.toBeInstanceOf(RangeError);
      expect(String((error as Error).message)).toContain('1,000,000');
    }
  });

  it('requireNonNegativeInt (via anchoredVwap anchor) refuses 2^53; real anchors unchanged', () => {
    for (const bad of [2 ** 53, 1e308, 2.5]) {
      const error = caught(() => ta.anchoredVwap(bars, { anchor: bad }));
      expect(isQuantError(error, 'input.out_of_range'), `anchor = ${bad}`).toBe(true);
    }
    expect(Number.isFinite(ta.anchoredVwap(bars, { anchor: 3 }).at(-1)!)).toBe(true);
  });

  it('divergence swing windows refuse 2^53; real windows unchanged', () => {
    const price = [10, 9, 8, 9, 10, 11, 7, 8, 9, 10, 11];
    const indicator = [50, 45, 30, 45, 55, 60, 40, 50, 55, 60, 65];
    for (const bad of [2 ** 53, 1e308, 2.5]) {
      const error = caught(() =>
        divergences({ price, indicator, parameters: { swing: { left: bad, right: 2 } } }),
      );
      expect(isQuantError(error, 'input.out_of_range'), `swing.left = ${bad}`).toBe(true);
    }
    expect(
      divergences({ price, indicator, parameters: { swing: { left: 2, right: 2 } } }).length,
    ).toBeGreaterThan(0);
  });

  it('searchIndicators paging is registry-bounded: large safe coordinates work; inexact ones teach', () => {
    for (const bad of [2 ** 53, 1e308, 2.5, -1]) {
      const limit = caught(() => searchIndicators({ query: 'rsi', limit: bad }));
      expect(isQuantError(limit, 'input.out_of_range'), `limit = ${bad}`).toBe(true);
      const offset = caught(() => searchIndicators({ query: 'rsi', offset: bad }));
      expect(isQuantError(offset, 'input.out_of_range'), `offset = ${bad}`).toBe(true);
    }
    expect(searchIndicators({ limit: 0 }).indicators).toEqual([]);
    expect(searchIndicators({ limit: 2 ** 32 }).indicators.length).toBeGreaterThan(300);
    expect(searchIndicators({ offset: 2 ** 32 }).indicators).toEqual([]);
    expect(searchIndicators({ limit: 1_000_001 }).indicators.length).toBeGreaterThan(300);
    expect(searchIndicators({ query: 'rsi', limit: 3 }).indicators.length).toBeLessThanOrEqual(3);
  });
});

describe('2026-08-23 P0 — warmup probeLength is a capped workload control', () => {
  it('refuses 2^53 and 1e308 typed, and cap + 1 names the 100,000 bound and the probe reason', () => {
    for (const bad of [2 ** 53, 2 ** 53 + 2, 1e308, -(2 ** 53), 2.5]) {
      const error = caught(() => indicatorWarmup('rsi', bad));
      expect(isQuantError(error, 'input.out_of_range'), `probeLength = ${bad}`).toBe(true);
    }
    const overCap = caught(() => indicatorWarmup('rsi', 100_001));
    expect(isQuantError(overCap, 'input.out_of_range')).toBe(true);
    expect(String((overCap as Error).message)).toContain('100,000');
    expect(String((overCap as Error).message)).toContain('probe');
    expect(indicatorWarmup('rsi', 512).name).toBe('rsi');
  });
});

describe('2026-08-23 P0 — snapshot StateReader counts and lookbacks are safe integers', () => {
  it('a restored lookback above the practical cap is refused as corrupt state, not allocated', () => {
    const stream = ta.ema.stream({ period: 10 });
    closes.slice(0, 20).forEach((close) => stream.next(close));
    const snapshot = JSON.parse(JSON.stringify(stream.toJSON())) as TechnicalAnalysisSnapshot;
    const tampered = {
      ...snapshot,
      state: { ...snapshot.state, period: 1_000_001 },
    } as TechnicalAnalysisSnapshot;
    const error = caught(() => ta.ema.fromJSON(tampered));
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toContain('period');
    expect(String((error as Error).message)).toContain('1,000,000');
    // The untampered snapshot still restores (the guard rejects corruption, not snapshots).
    expect(() => ta.ema.fromJSON(snapshot)).not.toThrow();
  });

  it('StateReader.integer refuses a count past 2^53 — a stream cannot advance it', () => {
    const envelope = (count: number): TechnicalAnalysisSnapshot => ({
      kind: 'x',
      schemaVersion: SCHEMA_VERSION,
      state: { count },
    });
    const frozen = caught(() => readSnapshot(envelope(2 ** 53), 'x').integer('count'));
    expect(isQuantError(frozen, 'input.out_of_range')).toBe(true);
    expect(String((frozen as Error).message)).toContain('2^53');
    const fractional = caught(() => readSnapshot(envelope(2.5), 'x').integer('count'));
    expect(isQuantError(fractional, 'input.wrong_type')).toBe(true);
    expect(readSnapshot(envelope(41), 'x').integer('count')).toBe(41);
  });
});
