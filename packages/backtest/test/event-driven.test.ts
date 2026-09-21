import { describe, expect, it } from 'vitest';
import { type Bar } from '@totalfinance/core';
import { brokers, crossOver, crossUnder, fees, type Indicator } from '@totalfinance/backtest';
import * as backtest from '@totalfinance/backtest';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);
function bars(closes: number[], symbol = 'AAPL'): Bar[] {
  return closes.map((c, i) => ({
    symbol,
    timestampMs: t0 + i * DAY,
    open: c,
    high: c,
    low: c,
    close: c,
  }));
}

/** A tiny streaming SMA, structurally an Indicator<number, number>. */
function sma(period: number): Indicator<number, number> {
  const buf: number[] = [];
  return {
    next(x: number): number | null {
      buf.push(x);
      if (buf.length > period) buf.shift();
      if (buf.length < period) return null;
      return buf.reduce((s, v) => s + v, 0) / period;
    },
  };
}

describe('eventDriven — SMA crossover', () => {
  // a V-shaped series: falls then rises, so fast SMA crosses slow once up
  const closes = [50, 48, 46, 44, 42, 40, 41, 43, 46, 50, 55, 60, 66, 72, 78, 84, 90, 96, 102, 108];

  it('goes long on a golden cross, flattens on a death cross, and produces an equity curve', () => {
    const res = backtest.eventDriven({
      data: bars(closes),
      broker: brokers.simulated({ cash: 100_000, commission: fees.bps(1) }),
      strategy(context) {
        const fast = context.indicator('AAPL', sma(3), 'close');
        const slow = context.indicator('AAPL', sma(8), 'close');
        context.onBar('AAPL', () => {
          if (crossOver(fast, slow)) context.buy('AAPL', { percent: 1 });
          else if (crossUnder(fast, slow)) context.close('AAPL');
        });
      },
    });
    expect(res.trades.length).toBeGreaterThan(0);
    expect(res.points.length).toBe(closes.length + 1);
    expect(res.assumptions.calendar).toBe('event-driven');
    expect(res.assumptions.fill).toContain('next-bar');
    // the long is established before the rally, so it ends profitable
    expect(res.finalValue).toBeGreaterThan(100_000);
  });

  it('accepts decorated handles but rejects missing or non-finite readings', () => {
    expect(
      crossOver(
        { value: 2, previous: 0, indicator: 'fast' } as never,
        { value: 1, previous: 1, indicator: 'slow' } as never,
      ),
    ).toBe(true);
    expect(() => crossOver({ value: Number.NaN, previous: 0 }, { value: 1, previous: 1 })).toThrow(
      /first.value/,
    );
    expect(() => crossUnder({ value: 0 } as never, { value: 1, previous: 1 })).toThrow(
      /first.previous/,
    );
  });
});

describe('eventDriven — sizing & accounting', () => {
  it('a buy-and-hold via percent:1 tracks the underlying from the entry bar', () => {
    const closes = [100, 110, 121, 133.1];
    const res = backtest.eventDriven({
      data: bars(closes),
      broker: brokers.simulated({ cash: 1000 }),
      strategy(context) {
        let entered = false;
        context.onBar('AAPL', () => {
          if (!entered) {
            context.buy('AAPL', { percent: 1 });
            entered = true;
          }
        });
      },
    });
    // ordered on bar 0, filled at bar 1 open (=110); held through 133.1 → 1000 * 133.1/110
    expect(res.finalValue).toBeCloseTo(1000 * (133.1 / 110), 6);
    expect(res.trades).toHaveLength(1);
  });

  it('close() flattens an open position', () => {
    const res = backtest.eventDriven({
      data: bars([100, 105, 110, 108]),
      broker: brokers.simulated({ cash: 10_000 }),
      strategy(context) {
        context.onBar('AAPL', () => {
          if (context.bar.timestampMs === t0) context.buy('AAPL', { quantity: 10 });
          if (context.bar.timestampMs === t0 + 2 * DAY) context.close('AAPL');
        });
      },
    });
    expect(res.trades.length).toBe(2); // one buy, one closing sell
    // position is flat at the end
    expect(res.finalValue).toBe(res.points[res.points.length - 1]!.equity);
  });
});

describe('eventDriven — diagnostics', () => {
  it('flags a survivorship-biased (current) universe', () => {
    const res = backtest.eventDriven({
      data: bars([100, 101, 102]),
      broker: brokers.simulated({ cash: 1000 }),
      universe: 'current',
      strategy() {},
    });
    expect(res.diagnostics.warnings.some((w) => w.code === 'research.survivorship_bias')).toBe(
      true,
    );
  });
});
