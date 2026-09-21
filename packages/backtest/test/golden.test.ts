/**
 * Golden backtest fixtures (spec §16.3): committed, deterministic regression cases that pin both
 * engines' behaviour across the canonical strategy archetypes. If a number here changes, an engine
 * mechanic changed — which should be a deliberate, reviewed event.
 */

import { describe, expect, it } from 'vitest';
import { type Bar } from '@totalfinance/core';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  brokers,
  crossOver,
  crossUnder,
  fees,
  type Indicator,
  slippage,
} from '@totalfinance/backtest';
import * as backtest from '@totalfinance/backtest';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 2); // a Friday-agnostic start
const bar = (symbol: string, i: number, c: number): Bar => ({
  symbol,
  timestampMs: t0 + i * DAY,
  open: c,
  high: c,
  low: c,
  close: c,
});

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

describe('golden fixture — buy and hold', () => {
  it('tracks the underlying from the entry bar', () => {
    const closes = Array.from({ length: 24 }, (_, i) => 100 * 1.01 ** i);
    const data = closes.map((c, i) => bar('SPY', i, c));
    const r = backtest.vectorized({ data, signal: closes.map(() => true), initialCapital: 10_000 });
    expect(r.finalValue).toBeCloseTo(10_000 * (closes[23]! / closes[1]!), 4);
    expect(r.trades).toHaveLength(1);
  });
});

describe('golden fixture — monthly equal weight', () => {
  it('rebalances three sleeves to ⅓ each on month boundaries', () => {
    const n = 70;
    const syms = ['A', 'B', 'C'] as const;
    const path = (drift: number) => (i: number) => 100 * (1 + drift) ** i;
    const paths = { A: path(0.004), B: path(0.0), C: path(-0.002) };
    const data: Bar[] = [];
    for (let i = 0; i < n; i++) for (const s of syms) data.push(bar(s, i, paths[s](i)));

    const r = backtest.eventDriven({
      data,
      broker: brokers.simulated({ cash: 30_000, commission: fees.bps(1) }),
      strategy(context) {
        const lastMonth: Record<string, number> = {};
        for (const s of syms) {
          context.onBar(s, () => {
            const m = new Date(context.bar.timestampMs).getUTCMonth();
            if (lastMonth[s] !== m) {
              lastMonth[s] = m;
              context.buy(s, { percent: 1 / 3 });
            }
          });
        }
      },
    });
    expect(r.trades.length).toBeGreaterThanOrEqual(syms.length); // ≥ one rebalance set
    expect(r.assumptions.calendar).toBe('event-driven');
    expect(r.finalValue).toBeCloseTo(31_565.322, 1);
  });
});

describe('golden fixture — SMA crossover', () => {
  it('goes long on the golden cross and rides the rally', () => {
    const closes = [
      50, 49, 48, 46, 44, 42, 41, 40, 41, 43, 46, 50, 55, 60, 66, 72, 78, 85, 92, 100,
    ];
    const r = backtest.eventDriven({
      data: closes.map((c, i) => bar('AAPL', i, c)),
      broker: brokers.simulated({
        cash: 100_000,
        commission: fees.bps(1),
        slippage: slippage.bps(2),
      }),
      strategy(context) {
        const fast = context.indicator('AAPL', sma(3), 'close');
        const slow = context.indicator('AAPL', sma(8), 'close');
        context.onBar('AAPL', () => {
          if (crossOver(fast, slow)) context.buy('AAPL', { percent: 1 });
          else if (crossUnder(fast, slow)) context.close('AAPL');
        });
      },
    });
    expect(r.finalValue).toBeGreaterThan(100_000);
    // golden cross fires at index 10 (close 46), fills next bar at 50.01, rides the monotonic
    // rally to 100 with no intervening cross-under ⇒ a clean ~2× net of costs.
    expect(r.finalValue).toBeCloseTo(199_950.01, 1);
  });
});

describe('golden fixture — high-turnover rotation', () => {
  it('rotates 100% into the stronger of two assets each bar', () => {
    const n = 40;
    // two anti-correlated saw-tooth assets so the winner flips often
    const a = (i: number) => 100 + 8 * Math.sin(i / 1.5);
    const b = (i: number) => 100 + 8 * Math.cos(i / 1.5);
    const data: Bar[] = [];
    for (let i = 0; i < n; i++) {
      data.push(bar('A', i, a(i)));
      data.push(bar('B', i, b(i)));
    }
    const r = backtest.eventDriven({
      data,
      broker: brokers.simulated({ cash: 50_000, commission: fees.bps(2) }),
      strategy(context) {
        let pa = NaN;
        let pb = NaN;
        let rA = 0;
        let rB = 0;
        context.onBar('A', () => {
          const c = context.bar.close;
          rA = Number.isNaN(pa) ? 0 : c / pa - 1;
          pa = c;
        });
        context.onBar('B', () => {
          const c = context.bar.close;
          rB = Number.isNaN(pb) ? 0 : c / pb - 1;
          pb = c;
        });
        // Cross-sectional rotation runs in onBars — fires once per timestamp after BOTH symbol
        // handlers, so the decision no longer relies on B being last in input order (WS2.8).
        context.onBars(() => {
          if (rA >= rB) {
            context.close('B');
            context.buy('A', { percent: 1 });
          } else {
            context.close('A');
            context.buy('B', { percent: 1 });
          }
        });
      },
    });
    expect(r.trades.length).toBeGreaterThan(20); // high turnover

    // ── Hand-computed expectation ──────────────────────────────────────────────────────────────
    // The previous golden (60_642.003) FROZE A BUG: `context.buy('A', { percent })` called from
    // `onBars` valued the held A position at `currentBar.close`, and `currentBar` at that moment is
    // whichever symbol's bar the engine processed last — B, because B is emitted second at every
    // timestamp. So the rotation sized A's position at B's price. The engine now prices the sized
    // symbol with its own mark; the value below is recomputed from the mechanics, not read back.
    //
    // Mechanics: bars are flat (O=H=L=C), A is emitted before B at each timestamp, `onBars` fires
    // once per timestamp AFTER both handlers with `marks` = that timestamp's closes, and the orders
    // it submits fill on the NEXT timestamp's bar for that symbol at the bar OPEN (= its price).
    // Sizing: target = percent·equity(marks); current = position·marks[SIZED symbol];
    // delta = target − current; commission = fees.bps(2) = |qty|·price·2/10⁴; no slippage.
    //
    //   prices  a(i) = 100 + 8·sin(i/1.5),  b(i) = 100 + 8·cos(i/1.5)
    //           a(0) = 100.000000  b(0) = 108.000000
    //           a(1) = 104.946958  b(1) = 106.287098
    //           a(2) = 107.775503  b(2) = 101.881901
    //
    //   ts0  handlers: pa/pb were NaN ⇒ rA = rB = 0. onBars: rA ≥ rB ⇒ close('B') (flat, no order),
    //        buy('A', 1). equity = 50 000 cash (no positions). target = 1·50 000 = 50 000;
    //        current = 0·100 = 0; delta = +50 000 ⇒ BUY A, notional 50 000.
    //   ts1  fill at a(1): qty = 50 000 / 104.946958 = 476.431149 sh;
    //        commission = 50 000·2/10⁴ = 10.00; cash = 50 000 − 50 000 − 10 = −10.00.
    //        marks = { A: 104.946958, B: 106.287098 }.
    //        handlers: rA = 104.946958/100 − 1 = +0.049470; rB = 106.287098/108 − 1 = −0.015860.
    //        onBars: rA ≥ rB ⇒ stay in A. equity = −10 + 476.431149·104.946958 = 49 990.00;
    //        current = 476.431149·104.946958 = 50 000.00; delta = −10.00 ⇒ SELL A, notional 10.
    //        (Under the bug this leg was current = 476.431149·b(1) = 50 638.51, delta = −648.51 —
    //        a 65× larger phantom trade, which is where the two goldens diverge.)
    //   ts2  fill at a(2): qty = 10 / 107.775503 = 0.092785 sh; commission = 10·2/10⁴ = 0.0020;
    //        cash = −10 + 10 − 0.002 = −0.002.
    //   … the rotation continues for 40 timestamps by the same three steps.
    //
    //   terminal state (ts39): cash = −0.073268, A = 597.964549 sh, B = 0, mark A = 106.100468
    //   finalValue = −0.073268 + 597.964549 · 106.100468 = 63 444.245
    const a1 = a(1);
    const a2 = a(2);
    expect(r.trades[0]).toMatchObject({ symbol: 'A', side: 'buy' });
    expect(r.trades[0]!.price).toBeCloseTo(a1, 9);
    expect(r.trades[0]!.quantity).toBeCloseTo(50_000 / a1, 9); // 476.431149 sh
    expect(r.trades[0]!.commission).toBeCloseTo(10, 9); // 50 000 · 2/10⁴
    expect(r.trades[1]).toMatchObject({ symbol: 'A', side: 'sell' });
    expect(r.trades[1]!.price).toBeCloseTo(a2, 9);
    expect(r.trades[1]!.quantity).toBeCloseTo(10 / a2, 9); // the −$10 cash trim, not −$648.51
    expect(r.finalValue).toBeCloseTo(63_444.245, 1);
  });

  it('sizes by percent off the SIZED symbol, not whichever bar came last (P0 repro)', () => {
    // A is constant 50, B is constant 200 and is emitted SECOND, so `currentBar` inside `onBars` is
    // always B's bar. One buy of A at 50% of a 100 000 equity ⇒ target 50 000 ⇒ 1 000 sh @ 50.
    // On every later timestamp the target is unchanged (equity stays 100 000: cash 50 000 +
    // 1 000·50) and current = 1 000·50 = 50 000, so delta = 0 and NO further order is submitted.
    // Under the bug, current was 1 000·200 = 200 000 ⇒ delta = −150 000 ⇒ a churn of phantom sells
    // that drove the book short.
    const data: Bar[] = [];
    for (let i = 0; i < 6; i++) {
      data.push(bar('A', i, 50));
      data.push(bar('B', i, 200));
    }
    const r = backtest.eventDriven({
      data,
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(context) {
        context.onBar('A', () => {});
        context.onBar('B', () => {});
        context.onBars(() => {
          context.buy('A', { percent: 0.5 });
        });
      },
    });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ symbol: 'A', side: 'buy', quantity: 1000, price: 50 });
    // equity is unchanged by a costless fill: 50 000 cash + 1 000 sh · 50 = 100 000.
    expect(r.finalValue).toBeCloseTo(100_000, 9);
  });
});

describe('golden fixture — long/short portfolio', () => {
  it('holds a 50% long / 50% short pair', () => {
    const n = 40;
    const a = (i: number) => 100 * 1.002 ** i; // winner
    const b = (i: number) => 100 * 1.0005 ** i; // laggard
    const data: Bar[] = [];
    for (let i = 0; i < n; i++) {
      data.push(bar('A', i, a(i)));
      data.push(bar('B', i, b(i)));
    }
    const r = backtest.eventDriven({
      data,
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(context) {
        let done = false;
        context.onBar('B', () => {
          if (!done) {
            context.buy('A', { percent: 0.5 });
            context.sell('B', { percent: 0.5 });
            done = true;
          }
        });
      },
    });
    // long the winner / short the laggard ⇒ profitable, low net exposure
    expect(r.finalValue).toBeGreaterThan(100_000);
    expect(r.finalValue).toBeCloseTo(102_985.194, 1);
  });
});

describe('golden fixture — options strategy with expiration', () => {
  it('buys a call and settles it at intrinsic on the expiry bar', () => {
    const K = 100;
    const r = 0.04;
    const vol = 0.25;
    const days = 30;
    // underlying drifts up; the option symbol's "close" is its premium, ending at intrinsic
    const premia: number[] = [];
    let S = 98;
    for (let i = 0; i <= days; i++) {
      const tRem = (days - i) / 365;
      S *= 1.004; // deterministic upward drift
      premia.push(
        tRem > 0
          ? blackScholesPrice({
              type: 'call',
              spot: S,
              strike: K,
              timeToExpiryYears: tRem,
              riskFreeRate: r,
              dividendYield: 0,
              volatility: vol,
            })
          : Math.max(0, S - K),
      );
    }
    const data = premia.map((p, i) => bar('AAPL_C100', i, p));
    const res = backtest.vectorized({
      data,
      signal: premia.map(() => true),
      initialCapital: 10_000,
      periodsPerYear: 252,
    });
    // bought the option at bar 1's premium, settled at expiry intrinsic
    expect(res.finalValue).toBeCloseTo(10_000 * (premia[days]! / premia[1]!), 4);
    expect(res.finalValue).toBeGreaterThan(10_000); // the call finished in the money
  });
});
