/**
 * WS2.8 — backtest artifacts carry the implementation-risk story end-to-end, the equity curve is an
 * explicit (ts, equity) series, onBar refuses duplicate handlers, onBars fires once per timestamp,
 * and walk-forward windows carry their train/test ranges + aggregated diagnostics.
 */

import { describe, expect, it } from 'vitest';
import { type Bar } from '@totalfinance/core';
import { brokers, fees, tearSheet, walkForward } from '@totalfinance/backtest';
import * as backtest from '@totalfinance/backtest';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);
const bars = (closes: number[], symbol = 'AAPL'): Bar[] =>
  closes.map((c, i) => ({ symbol, timestampMs: t0 + i * DAY, open: c, high: c, low: c, close: c }));

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe('WS2.8e — equity curve is an explicit (ts, equity) series', () => {
  it('points[0] is the opening capital stamped at the first bar timestamp', () => {
    const data = bars([100, 101, 102]);
    const res = backtest.eventDriven({
      data,
      broker: brokers.simulated({ cash: 100_000 }),
      strategy() {},
    });
    expect(res.points).toHaveLength(data.length + 1);
    expect(res.points[0]).toEqual({ timestampMs: data[0]!.timestampMs, equity: 100_000 });
    expect(res.finalValue).toBe(res.points[res.points.length - 1]!.equity);
  });
});

describe('WS2.8c — onBar / onBars registration discipline', () => {
  it('onBar throws on a duplicate symbol handler', () => {
    const run = (): unknown =>
      backtest.eventDriven({
        data: bars([100, 101]),
        broker: brokers.simulated({ cash: 100_000 }),
        strategy(context) {
          context.onBar('AAPL', () => {});
          context.onBar('AAPL', () => {});
        },
      });
    expect(run).toThrow(/already registered|one handler per symbol/i);
    expect(codeOf(run)).toBe('backtest.duplicate_handler');
  });

  it('onBars fires exactly once per timestamp, after the symbol handlers', () => {
    let onBarsCalls = 0;
    const data = bars([100, 101, 102, 103]); // 4 distinct timestamps
    backtest.eventDriven({
      data,
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(context) {
        context.onBar('AAPL', () => {});
        context.onBars(() => {
          onBarsCalls++;
        });
      },
    });
    expect(onBarsCalls).toBe(data.length);
  });
});

describe('WS2.8a — a tear sheet carries the source assumptions + diagnostics', () => {
  it('copies assumptions and diagnostics from the backtest result', () => {
    const res = backtest.eventDriven({
      data: bars([100, 101, 102]),
      broker: brokers.simulated({ cash: 100_000, commission: fees.bps(1) }),
      strategy(context) {
        context.onBar('AAPL', () => context.buy('AAPL', { percent: 1 }));
      },
    });
    const sheet = tearSheet(res);
    expect(sheet.diagnostics).toBe(res.diagnostics);
    expect(sheet.diagnostics.benchmarkFixtureVersion).toBeDefined();
    expect(sheet.assumptions).toBe(res.assumptions);
    expect(sheet.assumptions.calendar).toBe('event-driven');
  });
});

describe('WS2.8b — walk-forward windows carry ranges + aggregated diagnostics', () => {
  it('each window has train/test ranges; the result aggregates assumptions + warnings', () => {
    const data = bars(Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3)));
    const wf = walkForward({
      data,
      trainSize: 10,
      testSize: 5,
      run: (w) => backtest.vectorized({ data: w.test, signal: w.test.map(() => true) }),
    });
    expect(wf.windows.length).toBeGreaterThan(0);
    const w0 = wf.windows[0]!;
    // train covers bars [0, 10); test covers [10, 15) — ranges follow the bar timestamps
    expect(w0.trainRange).toEqual([data[0]!.timestampMs, data[9]!.timestampMs]);
    expect(w0.testRange).toEqual([data[10]!.timestampMs, data[14]!.timestampMs]);
    // shared assumptions echo + a core-Diagnostics (deduped) warnings channel
    expect(wf.assumptions).toBe(w0.assumptions);
    expect(wf.assumptions.fill).toBeDefined();
    expect(Array.isArray(wf.diagnostics.warnings)).toBe(true);
    // the ratified shape moved policies out of diagnostics entirely (dx §2.5)
    expect('policies' in wf.diagnostics).toBe(false);
  });
});

describe('dx §2.5 — assumptions get their own slot (policies leave diagnostics)', () => {
  it('vectorized: assumptions carry conventionsVersion + the echoed run policies + initialCapital', () => {
    const data = bars([100, 101, 102, 103]);
    const res = backtest.vectorized({
      data,
      signal: data.map(() => true),
      initialCapital: 5000,
      rebalance: 'monthly',
    });
    expect(res.assumptions).toMatchObject({
      conventionsVersion: expect.any(String),
      initialCapital: 5000,
      fill: 'close',
      cost: 'none',
      slippage: 'none',
      cashSettlement: 'immediate',
      corporateAction: 'none',
      calendar: 'monthly',
      margin: 'maxLeverage',
    });
    // moved, not duplicated: diagnostics keeps only warnings + the benchmark fixture version
    expect('policies' in res.diagnostics).toBe(false);
    expect(Array.isArray(res.diagnostics.warnings)).toBe(true);
    expect(res.diagnostics.benchmarkFixtureVersion).toBeDefined();
  });

  it('eventDriven: assumptions echo the broker policies, opening capital, and assignment', () => {
    const res = backtest.eventDriven({
      data: bars([100, 101, 102]),
      broker: brokers.simulated({ cash: 100_000, commission: fees.bps(1) }),
      strategy(context) {
        context.onBar('AAPL', () => {});
      },
    });
    expect(res.assumptions.conventionsVersion).toEqual(expect.any(String));
    expect(res.assumptions.initialCapital).toBe(100_000);
    expect(res.assumptions.cost).toBe('bps(1)');
    expect(res.assumptions.calendar).toBe('event-driven');
    expect(res.assumptions.assignment).toBe('none');
    expect('policies' in res.diagnostics).toBe(false);
  });
});
