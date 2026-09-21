import { describe, expect, it } from 'vitest';
import { type Bar } from '@totalfinance/core';
import { vectorized } from '@totalfinance/backtest/vectorized';
import {
  crossOverSeries,
  crossUnderSeries,
  gtSeries,
  latchSeries,
  ltSeries,
} from '@totalfinance/backtest';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);
const closes = [100, 101, 102, 103, 104, 105, 106, 107];
function bars(): Bar[] {
  return closes.map((c, i) => ({
    symbol: 'TEST',
    timestampMs: t0 + i * DAY,
    open: c,
    high: c,
    low: c,
    close: c,
  }));
}

describe('WS6.4 — vectorized accepts a warmup-aware TA signal', () => {
  it('treats leading warmup NaNs as flat and emits one backtest.signal_warmup info warning', () => {
    const signal = { value: [NaN, NaN, 1, 1, 1, 1, 1, 1], warmup: 2 };
    const r = vectorized({ data: bars(), signal, initialCapital: 1000 });
    expect(Number.isFinite(r.finalValue)).toBe(true);
    const warmupWarnings = r.diagnostics.warnings.filter(
      (w) => w.code === 'backtest.signal_warmup',
    );
    expect(warmupWarnings).toHaveLength(1);
    expect(warmupWarnings[0]!.severity).toBe('info');
    expect(warmupWarnings[0]!.context).toMatchObject({ warmupBars: 2, skipped: 2 });
  });

  it('holds zero position through the warmup: NaN-in-warmup === an explicit flat (0) warmup', () => {
    const withNaN = vectorized({
      data: bars(),
      signal: { value: [NaN, NaN, 1, 1, 1, 1, 1, 1], warmup: 2 },
      initialCapital: 1000,
    });
    const withFlat = vectorized({
      data: bars(),
      signal: { value: [0, 0, 1, 1, 1, 1, 1, 1], warmup: 0 },
      initialCapital: 1000,
    });
    expect(withNaN.finalValue).toBe(withFlat.finalValue);
    expect(withNaN.trades).toHaveLength(withFlat.trades.length);
  });

  it('a non-finite value AFTER the declared warmup still throws', () => {
    const signal = { value: [NaN, NaN, 1, 1, NaN, 1, 1, 1], warmup: 2 }; // NaN at index 4 ≥ warmup
    expect(() => vectorized({ data: bars(), signal, initialCapital: 1000 })).toThrow();
  });

  it('a bare number[] with a mid-series NaN still throws (implicit warmup 0)', () => {
    const signal = [1, 1, NaN, 1, 1, 1, 1, 1];
    expect(() => vectorized({ data: bars(), signal, initialCapital: 1000 })).toThrow();
  });
});

describe('WS6.4 — signal composition primitives', () => {
  it('gtSeries / ltSeries with a scalar level and with a series', () => {
    const rsi = [NaN, 20, 75, 50, 80];
    expect(Array.from(gtSeries(rsi, 70))).toEqual([NaN, 0, 1, 0, 1]);
    expect(Array.from(ltSeries(rsi, 30))).toEqual([NaN, 1, 0, 0, 0]);
    expect(Array.from(gtSeries([1, 2, 3, 4], [4, 3, 2, 1]))).toEqual([0, 0, 1, 1]);
  });

  it('crossOverSeries / crossUnderSeries mark the exact crossing bar; index 0 and NaN inputs are NaN', () => {
    const fast = [NaN, 1, 2, 3, 2, 1];
    expect(Array.from(crossOverSeries(fast, 2))).toEqual([NaN, NaN, 0, 1, 0, 0]);
    expect(Array.from(crossUnderSeries(fast, 2))).toEqual([NaN, NaN, 0, 0, 0, 1]);
  });

  it('cross series propagate NaN from either input and reject length mismatch', () => {
    // A clean up-cross of a series level.
    expect(Array.from(crossOverSeries([1, 3], [2, 2]))).toEqual([NaN, 1]);
    // A NaN in the prior bar of either input poisons the crossing check.
    expect(Array.from(crossOverSeries([1, 3], [NaN, 2]))).toEqual([NaN, NaN]);
    expect(() => gtSeries([1, 2, 3], [1, 2])).toThrow();
  });

  it('latchSeries turns entry/exit crosses into a HELD position (the F5 fix)', () => {
    // fast crosses above level 2 at bar 2 and back below at bar 5.
    const fast = [NaN, 1, 3, 4, 3, 1];
    const entries = crossOverSeries(fast, 2); // [NaN, NaN, 1, 0, 0, 0]
    const exits = crossUnderSeries(fast, 2); // [NaN, NaN, 0, 0, 0, 1]
    // The raw entry cross is 1 for ONE bar; latching holds it across the whole regime.
    expect(Array.from(entries)).toEqual([NaN, NaN, 1, 0, 0, 0]);
    expect(Array.from(latchSeries(entries, exits))).toEqual([NaN, NaN, 1, 1, 1, 0]);
  });

  it('latchSeries: exit wins a same-bar tie and any non-zero value fires', () => {
    // Same-bar entry+exit at bar 1 stays flat (exit wins); a fresh entry at bar 2 opens.
    expect(Array.from(latchSeries([0, 1, 1], [0, 1, 0]))).toEqual([0, 0, 1]);
    // A non-1 truthy value counts as a fire; the latch holds through later 0 bars.
    expect(Array.from(latchSeries([0, 2, 0], [0, 0, 0]))).toEqual([0, 1, 1]);
  });

  it('latchSeries: NaN warmup is propagated without disturbing the latch, mismatch/type throw', () => {
    // A NaN mid-stream emits NaN and leaves the held position intact on the next finite bar.
    expect(Array.from(latchSeries([1, NaN, 0], [0, NaN, 0]))).toEqual([1, NaN, 1]);
    expect(() => latchSeries([1, 2, 3], [1, 2])).toThrow(/equal length/);
    expect(() => latchSeries('nope' as never, [1])).toThrow();
  });
});
