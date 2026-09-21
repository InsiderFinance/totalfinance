import { describe, expect, it } from 'vitest';
import { type Bar } from '@totalfinance/core';
import {
  attribution,
  monteCarloResample,
  returnStatistics,
  tearSheet,
  vectorized,
  walkForward,
} from '@totalfinance/backtest';
import type { Trade } from '@totalfinance/backtest';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);
function bars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({
    symbol: 'X',
    timestampMs: t0 + i * DAY,
    open: c,
    high: c,
    low: c,
    close: c,
  }));
}

describe('returnStatistics', () => {
  it('summarizes the return distribution', () => {
    const s = returnStatistics([0.02, -0.01, 0.03, -0.02, 0]);
    expect(s.hitRate).toBeCloseTo(2 / 4, 12); // 2 wins of 4 non-zero
    expect(s.profitFactor).toBeCloseTo(0.05 / 0.03, 12);
    expect(s.bestPeriod).toBe(0.03);
    expect(s.worstPeriod).toBe(-0.02);
  });
});

describe('attribution — realized P&L per symbol (average-cost)', () => {
  it('matches a hand-computed round trip', () => {
    const trades: Trade[] = [
      {
        symbol: 'X',
        timestampMs: t0,
        side: 'buy',
        quantity: 10,
        price: 100,
        commission: 0,
        slippage: 0,
        multiplier: 1,
      },
      {
        symbol: 'X',
        timestampMs: t0 + DAY,
        side: 'sell',
        quantity: 10,
        price: 110,
        commission: 0,
        slippage: 0,
        multiplier: 1,
      },
      {
        symbol: 'Y',
        timestampMs: t0,
        side: 'sell',
        quantity: 5,
        price: 50,
        commission: 1,
        slippage: 0,
        multiplier: 1,
      }, // short
      {
        symbol: 'Y',
        timestampMs: t0 + DAY,
        side: 'buy',
        quantity: 5,
        price: 45,
        commission: 1,
        slippage: 0,
        multiplier: 1,
      }, // cover lower
    ];
    const attr = attribution(trades);
    const x = attr.bySymbol.find((a) => a.symbol === 'X')!;
    const y = attr.bySymbol.find((a) => a.symbol === 'Y')!;
    expect(x.realizedPnl).toBeCloseTo(10 * (110 - 100), 9); // +100
    expect(y.realizedPnl).toBeCloseTo(5 * (50 - 45), 9); // short profit +25
    expect(y.commission).toBe(2);
    // Report grammar (Law 2): assumptions + diagnostics inline, no `value` nesting.
    expect(attr.assumptions.conventionsVersion).toBeDefined();
    expect(attr.assumptions['matching']).toBe('average-cost');
    expect(attr.diagnostics.warnings).toEqual([]);
    expect('value' in attr).toBe(false);
  });
});

describe('tearSheet', () => {
  it('assembles performance, trade, return stats and attribution', () => {
    const res = vectorized({
      data: bars([100, 102, 101, 105, 110, 108, 112, 115]),
      signal: [true, true, false, true, true, false, true, true],
    });
    const sheet = tearSheet(res, { monteCarlo: { iterations: 500, seed: 7 } });
    expect(sheet.performance.sharpe).toBeDefined();
    expect(sheet.trades.count).toBe(res.trades.length);
    expect(sheet.attribution.length).toBeGreaterThanOrEqual(0);
    expect(sheet.monteCarlo!.iterations).toBe(500);
    expect(sheet.monteCarlo!.confidenceInterval95[0]).toBeLessThanOrEqual(
      sheet.monteCarlo!.confidenceInterval95[1],
    );
  });
});

describe('monteCarloResample', () => {
  it('is deterministic under a seed', () => {
    const r = [0.01, -0.005, 0.02, -0.01, 0.015, 0.0, -0.02, 0.03];
    const a = monteCarloResample(r, { iterations: 800, seed: 3 });
    const b = monteCarloResample(r, { iterations: 800, seed: 3 });
    expect(a.meanTotalReturn).toBe(b.meanTotalReturn);
    expect(a.seed).toBe(3);
  });
});

describe('walkForward', () => {
  it('stitches out-of-sample windows into one equity curve', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i + Math.sin(i / 3) * 3);
    const data = bars(closes);
    const wf = walkForward({
      data,
      trainSize: 20,
      testSize: 10,
      run: ({ test }) => vectorized({ data: test, signal: test.map(() => true) }),
    });
    expect(wf.windows.length).toBe(4); // (60-20)/10
    expect(wf.equityCurve[0]).toBe(1);
    expect(wf.performance.periods).toBeGreaterThan(0);
  });
});
