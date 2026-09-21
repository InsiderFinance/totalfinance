import { describe, expect, it } from 'vitest';
import { InputError, type Bar } from '@totalfinance/core';
import { fees, slippage } from '@totalfinance/backtest/costs';
import { vectorized } from '@totalfinance/backtest/vectorized';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);

function bars(closes: number[], start = t0): Bar[] {
  return closes.map((c, i) => ({
    symbol: 'TEST',
    timestampMs: start + i * DAY,
    open: c,
    high: c,
    low: c,
    close: c,
  }));
}

const closes = [100, 101, 102, 100, 105, 110, 108, 112];

describe('vectorized — buy and hold', () => {
  it('holds a full position and tracks the underlying from entry', () => {
    const data = bars(closes);
    const r = vectorized({ data, signal: closes.map(() => true), initialCapital: 1000 });
    // entered at bar 1 (lag 1); final value tracks close[n-1]/close[1]
    expect(r.finalValue).toBeCloseTo(1000 * (closes[7]! / closes[1]!), 6);
    expect(r.trades).toHaveLength(1); // a single entry, then it just holds
    expect(r.diagnostics.benchmarkFixtureVersion).toBeDefined();
    expect(r.points).toHaveLength(closes.length + 1);
  });

  it('a flat signal stays in cash', () => {
    const r = vectorized({
      data: bars(closes),
      signal: closes.map(() => false),
      initialCapital: 1000,
    });
    expect(r.trades).toHaveLength(0);
    expect(r.finalValue).toBe(1000);
    expect(r.performance.annualizedVolatility).toBe(0);
  });
});

describe('vectorized — costs, shorts, look-ahead', () => {
  it('transaction costs drag the final value below the cost-free run', () => {
    const data = bars(closes);
    const signal = [true, false, true, false, true, false, true, false];
    const free = vectorized({ data, signal, initialCapital: 1000 });
    const costly = vectorized({
      data,
      signal,
      initialCapital: 1000,
      fees: fees.bps(10),
      slippage: slippage.bps(5),
    });
    expect(costly.finalValue).toBeLessThan(free.finalValue);
    expect(costly.assumptions.cost).toBe('bps(10)');
    expect(costly.assumptions.slippage).toBe('bps(5)');
  });

  it('a short position profits when the price falls', () => {
    const down = bars([100, 98, 96, 94, 92]);
    const r = vectorized({ data: down, signal: down.map(() => -1), initialCapital: 1000 });
    expect(r.finalValue).toBeGreaterThan(1000);
  });

  it('executionLag 0 raises a look-ahead diagnostic', () => {
    const r = vectorized({ data: bars(closes), signal: closes.map(() => true), executionLag: 0 });
    expect(r.diagnostics.warnings.some((w) => w.code === 'backtest.lookahead')).toBe(true);
  });
});

describe('vectorized — rebalancing calendar', () => {
  it('monthly rebalancing trades far less than every-bar for an oscillating signal', () => {
    // 70 daily bars, alternating long/flat
    const longSeries = Array.from({ length: 70 }, (_, i) => 100 + Math.sin(i / 2) * 5);
    const data = bars(longSeries);
    const signal = longSeries.map((_, i) => i % 2 === 0);
    const everyBar = vectorized({ data, signal, rebalance: 'everyBar' });
    const monthly = vectorized({ data, signal, rebalance: 'monthly' });
    expect(monthly.trades.length).toBeLessThan(everyBar.trades.length);
    expect(monthly.assumptions.calendar).toBe('monthly');
  });
});

describe('vectorized — validation', () => {
  it('rejects a signal length mismatch and too few bars', () => {
    expect(() => vectorized({ data: bars(closes), signal: [true, false] })).toThrow(InputError);
    expect(() => vectorized({ data: bars([100]), signal: [true] })).toThrow(InputError);
  });

  it('rejects a mixed-symbol series (WS1.13)', () => {
    const data = bars([100, 101, 102]);
    data[2] = { ...data[2]!, symbol: 'OTHER' }; // a stray bar from a different instrument
    expect(() => vectorized({ data, signal: data.map(() => true) })).toThrow(
      /all bars must share one symbol/,
    );
  });
});
