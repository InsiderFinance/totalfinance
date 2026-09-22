/**
 * Runnable backtesting examples (spec §16). Each snippet executes in CI with assertions so the
 * vectorized-engine / event-driven / walk-forward / tear-sheet docs cannot drift from working code.
 *
 * The throughline: a backtest is a *model*, and `@insiderfinance/totalfinance/backtest` makes its hidden assumptions
 * (fills, costs, slippage, look-ahead, survivorship) visible on every result.
 */

import { describe, expect, it } from 'vitest';
import type { Bar } from '@insiderfinance/totalfinance/core';
import {
  brokers,
  crossOver,
  crossUnder,
  fees,
  type Indicator,
  slippage,
  tearSheet,
  walkForward,
} from '@insiderfinance/totalfinance/backtest';
import * as backtest from '@insiderfinance/totalfinance/backtest';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 2);
const candles = (closes: number[], symbol = 'SPY'): Bar[] =>
  closes.map((c, i) => ({ symbol, timestampMs: t0 + i * DAY, open: c, high: c, low: c, close: c }));

/** A tiny streaming SMA (any `@insiderfinance/totalfinance/technical-analysis` stream is structurally compatible). */
function sma(period: number): Indicator<number, number> {
  const buf: number[] = [];
  return {
    next(x: number): number | null {
      buf.push(x);
      if (buf.length > period) buf.shift();
      return buf.length < period ? null : buf.reduce((s, v) => s + v, 0) / period;
    },
  };
}

describe('docs: the vectorized research engine', () => {
  it('runs a signal-driven backtest with costs and no look-ahead', () => {
    // a long-only momentum signal on a gently trending series
    const closes = Array.from({ length: 40 }, (_, i) => 100 * 1.004 ** i);
    const data = candles(closes);
    const signal = closes.map((_, i) => i >= 5); // flat for 5 bars, then long

    const result = backtest.vectorized({
      data,
      signal,
      initialCapital: 100_000,
      rebalance: 'weekly',
      fees: fees.bps(1), // 1 bp commission
      slippage: slippage.bps(2), // 2 bp slippage
    });

    expect(result.finalValue).toBeGreaterThan(100_000); // the uptrend was captured
    expect(result.points).toHaveLength(data.length + 1); // points[0] = opening capital at bar 0's ts

    // the result carries its modelling assumptions — never hidden
    expect(result.assumptions.fill).toBe('close');
    expect(result.assumptions.calendar).toBe('weekly');
    expect(result.diagnostics.warnings).toHaveLength(0); // clean data, lag ≥ 1 ⇒ no look-ahead flag
  });

  it('flags look-ahead when execution lag is turned off', () => {
    const data = candles(Array.from({ length: 10 }, (_, i) => 100 + i));
    const result = backtest.vectorized({ data, signal: data.map(() => true), executionLag: 0 });
    expect(result.diagnostics.warnings.some((w) => w.code === 'backtest.lookahead')).toBe(true);
  });
});

describe('docs: the event-driven execution simulator', () => {
  it('trades an SMA crossover through a simulated broker', () => {
    // V-shaped series: down, then a sustained rally that triggers a golden cross
    const closes = [
      50, 49, 48, 46, 44, 42, 41, 40, 41, 43, 46, 50, 55, 60, 66, 72, 78, 85, 92, 100,
    ];

    const result = backtest.eventDriven({
      data: candles(closes, 'AAPL'),
      broker: brokers.simulated({
        cash: 100_000,
        commission: fees.bps(1),
        slippage: slippage.bps(2),
      }),
      strategy(context) {
        const fast = context.indicator('AAPL', sma(3), 'close');
        const slow = context.indicator('AAPL', sma(8), 'close');
        context.onBar('AAPL', () => {
          if (crossOver(fast, slow))
            context.buy('AAPL', { percent: 1 }); // go 100% long
          else if (crossUnder(fast, slow)) context.close('AAPL'); // flatten
        });
      },
    });

    expect(result.finalValue).toBeGreaterThan(100_000);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.assumptions.fill).toBe('next-bar-open / intrabar-trigger');
  });

  it('supports bracket orders (take-profit / stop-loss as an OCO pair)', () => {
    // price rises into the take-profit level
    const closes = [100, 101, 103, 106, 110, 115, 121];
    const result = backtest.eventDriven({
      data: candles(closes, 'MSFT'),
      broker: brokers.simulated({ cash: 50_000 }),
      strategy(context) {
        let entered = false;
        context.onBar('MSFT', () => {
          if (!entered) {
            entered = true;
            // enter long with a protective bracket: exit at 112 (TP) or 99 (SL)
            context.buy('MSFT', { value: 10_000, takeProfit: 112, stopLoss: 99 });
          }
        });
      },
    });
    // the take-profit child fired, so the position is flat by the end
    expect(result.trades.length).toBeGreaterThanOrEqual(2); // entry + bracket exit
  });
});

describe('docs: walk-forward keeps the evaluation out-of-sample', () => {
  it('stitches per-window OOS returns into one curve', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 * 1.002 ** i);
    const data = candles(closes);

    const wf = walkForward({
      data,
      trainSize: 30,
      testSize: 20,
      mode: 'rolling',
      run: ({ test }) =>
        // a trivial always-long strategy on the test window (train window would fit parameters)
        backtest.vectorized({ data: test, signal: test.map(() => true) }),
    });

    expect(wf.windows.length).toBeGreaterThan(1);
    expect(wf.equityCurve[0]).toBe(1); // stitched OOS curve starts at 1
    expect(wf.performance.totalReturn).toBeGreaterThan(0); // the uptrend persists out-of-sample
  });
});

describe('docs: tear sheet summarizes a run (with bootstrap confidence bands)', () => {
  it('reports trade/return stats and a seeded Monte-Carlo total-return interval', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 * 1.003 ** i);
    const result = backtest.vectorized({
      data: candles(closes),
      signal: closes.map(() => true),
      initialCapital: 100_000,
    });

    const sheet = tearSheet(result, { monteCarlo: { iterations: 500, seed: 7 } });

    expect(sheet.trades.count).toBeGreaterThanOrEqual(1);
    expect(sheet.returns.hitRate).toBeGreaterThan(0.5); // a steady uptrend wins most bars
    expect(sheet.monteCarlo?.seed).toBe(7); // seeded ⇒ reproducible
    expect(sheet.monteCarlo?.confidenceInterval95[0]).toBeLessThan(
      sheet.monteCarlo!.confidenceInterval95[1],
    );
  });
});

describe('Stage 4.6 engines — the first call of each, reconciled to the ledger', () => {
  it('portfolioBacktest: two equities on daily bars, a weekly equal-weight model, the ledger as the truth', () => {
    const days = [
      '2026-01-02',
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-12',
      '2026-01-13',
    ];
    const bars = days.flatMap((date, i) =>
      (['AAA', 'BBB'] as const).map((symbol) => {
        const close = (symbol === 'AAA' ? 100 : 50) * (1 + i * (symbol === 'AAA' ? 0.004 : -0.002));
        return {
          symbol,
          timestampMs: Date.parse(`${date}T21:00:00Z`),
          open: close,
          high: close,
          low: close,
          close,
          volume: 1_000_000,
        };
      }),
    );
    const run = backtest.portfolioBacktest({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: {
        AAA: { kind: 'equity', currency: 'USD' },
        BBB: { kind: 'equity', currency: 'USD' },
      },
      marketData: { bars },
      strategy: {
        model: [
          { group: { instrumentId: 'AAA' }, weight: 0.5 },
          { group: { instrumentId: 'BBB' }, weight: 0.5 },
        ],
        schedule: { frequency: 'weekly' },
      },
      calendar: 'NYSE',
    });
    // The equity IS the ledger's net asset value; the fills are portfolio events; execution is named.
    expect(run.fills.length).toBeGreaterThan(0);
    expect(Math.abs(run.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-9);
    expect(run.assumptions.execution.realism).toBe('simplified');
    expect(run.ledger.events.some((e) => e.event.eventType === 'trade.fill')).toBe(true);
    expect(run.finalValue).toBeGreaterThan(0);
  });

  it('crossSectionalWalkForward: choose on the training span, report the held-out span', () => {
    const names = ['AAA', 'BBB', 'CCC', 'DDD'];
    const sessions = Array.from({ length: 12 }, (_, i) =>
      new Date(Date.UTC(2026, 0, 2) + i * 7 * DAY).toISOString().slice(0, 10),
    );
    const quality: Record<string, number> = { AAA: 4, BBB: 3, CCC: 2, DDD: 1 };
    const drift: Record<string, number> = { AAA: 0.02, BBB: 0.005, CCC: -0.01, DDD: -0.02 };
    const request = {
      dataset: {
        observations: names.map((instrumentId) => ({
          instrumentId,
          availableTimestampMs: Date.UTC(2026, 0, 1),
          fields: { quality: quality[instrumentId]! },
        })),
        fieldDefinitions: [{ fieldName: 'quality', kind: 'numeric' as const }],
        returns: names.flatMap((instrumentId) =>
          sessions.map((tradingSessionDate, i) => ({
            instrumentId,
            tradingSessionDate,
            simpleReturn: drift[instrumentId]! + (i % 3) * 0.002 - 0.002,
          })),
        ),
      },
      universeHistory: {
        universeId: 'example-4',
        members: names.map((instrumentId) => ({
          instrumentId,
          fromTimestampMs: Date.UTC(2026, 0, 1),
        })),
      },
      signal: {
        score: {
          components: [
            {
              field: 'quality',
              weight: 1,
              direction: 'higher-is-better' as const,
              standardization: 'z-score' as const,
            },
          ],
          missingValuePolicy: 'exclude' as const,
        },
      },
      rebalanceSchedule: { frequency: 'weekly' as const, session: 'close' as const },
      portfolioConstruction: { method: 'equal-weight' as const, long: { count: 2 } },
      initialCapital: 100_000,
    };
    const evaluation = backtest.crossSectionalWalkForward({
      request,
      variations: [{ path: 'portfolioConstruction.long.count', values: [1, 2, 3] }],
      trainSessions: 4,
      testSessions: 2,
    });
    // 12 sessions, train 4, test 2 → held-out spans at 4–5, 6–7, 8–9, 10–11
    expect(evaluation.windows).toHaveLength(4);
    expect(evaluation.hygiene.evaluatedWindowCount).toBe(4);
    expect(evaluation.returns).toEqual(evaluation.runs.flatMap((run) => run.returns));
    expect(evaluation.assumptions.visibility).toContain('rolling');
  });
});
