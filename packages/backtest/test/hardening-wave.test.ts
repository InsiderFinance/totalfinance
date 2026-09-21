/**
 * Broker + engine interaction matrix (2026-08 defect-fix wave).
 *
 * Every cell here is a mechanic that used to produce a plausible-looking but WRONG number, and every
 * expected value is hand-computed in the comment above it — fills, cash, marks, and the arithmetic
 * that connects them. Nothing in this file was read back off the engine.
 *
 * The matrix:
 *   1. stop-limit × {buy, sell} × {gap-through, no-gap}, against the plain `stop` reference row
 *   2. split × resting orders (phantom GTC fill, borrow accrual, equity continuity)
 *   3. OCO × volume participation (partial-fill double exit)
 *   4. onBars × percent sizing across symbols
 *   5. commission on the SLIPPED fill price
 *   6. contract multiplier in turnover / realized-P&L attribution
 *   7. the ambiguous-bar OCO tie-break, disclosed in `assumptions`
 *   8. degenerate return statistics: null-with-warning, never a fabricated 0
 */

import { describe, expect, it } from 'vitest';
import type { Bar } from '@totalfinance/core';
import { borrow } from '@totalfinance/backtest/costs';
import { brokers, fees, returnStatistics, slippage, tearSheet } from '@totalfinance/backtest';
import * as backtest from '@totalfinance/backtest';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);

function bar(
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume?: number,
  symbol = 'X',
): Bar {
  return {
    symbol,
    timestampMs: t0 + i * DAY,
    open,
    high,
    low,
    close,
    ...(volume !== undefined ? { volume } : {}),
  };
}

/** A flat bar (open = high = low = close) — the price is unambiguous. */
const flat = (i: number, price: number, volume?: number, symbol = 'X'): Bar =>
  bar(i, price, price, price, price, volume, symbol);

// ───────────────────────────── 1. stop-limit × gap grid ─────────────────────────────

describe('stop / stop-limit trigger grid: the limit is evaluated from the TRIGGER, not the open', () => {
  /**
   * A stop-limit is not a working limit order until the stop trips. The limit therefore has to be
   * measured from the order's effective open — `max(open, stop)` for a buy, `min(open, stop)` for a
   * sell — which is exactly the flooring the plain `stop` case has always applied. Measuring from
   * the bar's raw `open` handed the order a price that existed BEFORE it was live.
   *
   * Every row uses stop = 100 and (where it matters) limit = 100.
   *
   *   row                     bar (O,H,L,C)        old fill   correct fill   why
   *   buy  stop      no-gap   ( 95,105, 95,105)    100        100            max(open 95, stop 100)
   *   buy  stop      gap      (105,110,105,110)    105        105            max(open 105, stop 100)
   *   sell stop      no-gap   (105,105, 95, 95)    100        100            min(open 105, stop 100)
   *   sell stop      gap      ( 95, 95, 90, 90)     95         95            min(open 95, stop 100)
   *   buy  stop-limit no-gap   ( 95,105, 95,105)     95        100            open was pre-trigger
   *   buy  stop-limit gap      (105,110,105,110)    105        105            unchanged
   *   sell stop-limit no-gap   (105,105, 95, 95)    105        100            open was pre-trigger
   *   sell stop-limit gap      ( 95, 95, 90, 90)     95         95            unchanged
   */
  const NO_GAP_UP = bar(0, 95, 105, 95, 105); // opens below the stop, rallies through it
  const GAP_UP = bar(0, 105, 110, 105, 110); // already open above the stop
  const NO_GAP_DOWN = bar(0, 105, 105, 95, 95); // opens above the stop, breaks down through it
  const GAP_DOWN = bar(0, 95, 95, 90, 90); // already open below the stop

  const fillPrice = (
    request: Parameters<ReturnType<typeof brokers.simulated>['submit']>[0],
    b: Bar,
  ): number | null => {
    const broker = brokers.simulated({ cash: 1_000_000 });
    broker.submit(request);
    const fills = broker.processBar(b);
    return fills.length === 0 ? null : fills[0]!.price;
  };

  it('plain stop — the reference row the stop-limit now mirrors', () => {
    // buy, no gap: high 105 ≥ 100 triggers; fill = max(open 95, stop 100) = 100.
    expect(
      fillPrice({ symbol: 'X', side: 'buy', quantity: 1, type: 'stop', stopPrice: 100 }, NO_GAP_UP),
    ).toBe(100);
    // buy, gapped: the bar already opened through the stop ⇒ fill = max(105, 100) = 105.
    expect(
      fillPrice({ symbol: 'X', side: 'buy', quantity: 1, type: 'stop', stopPrice: 100 }, GAP_UP),
    ).toBe(105);
    // sell, no gap: low 95 ≤ 100 triggers; fill = min(open 105, stop 100) = 100.
    expect(
      fillPrice(
        { symbol: 'X', side: 'sell', quantity: 1, type: 'stop', stopPrice: 100 },
        NO_GAP_DOWN,
      ),
    ).toBe(100);
    // sell, gapped: fill = min(open 95, stop 100) = 95.
    expect(
      fillPrice({ symbol: 'X', side: 'sell', quantity: 1, type: 'stop', stopPrice: 100 }, GAP_DOWN),
    ).toBe(95);
  });

  it('buy stop-limit fills at the stop (100), not the pre-trigger open (95)', () => {
    // entry = max(open 95, stop 100) = 100; 100 ≤ limit 100 ⇒ fill @ 100.
    expect(
      fillPrice(
        {
          symbol: 'X',
          side: 'buy',
          quantity: 1,
          type: 'stop-limit',
          stopPrice: 100,
          limitPrice: 100,
        },
        NO_GAP_UP,
      ),
    ).toBe(100);
  });

  it('sell stop-limit fills at the stop (100), not the pre-trigger open (105)', () => {
    // entry = min(open 105, stop 100) = 100; 100 ≥ limit 100 ⇒ fill @ 100.
    expect(
      fillPrice(
        {
          symbol: 'X',
          side: 'sell',
          quantity: 1,
          type: 'stop-limit',
          stopPrice: 100,
          limitPrice: 100,
        },
        NO_GAP_DOWN,
      ),
    ).toBe(100);
  });

  it('a GAPPED stop-limit open is unchanged — the bar really did open past the stop', () => {
    // buy: entry = max(open 105, stop 100) = 105; 105 ≤ limit 110 ⇒ fill @ 105 (as before the fix).
    expect(
      fillPrice(
        {
          symbol: 'X',
          side: 'buy',
          quantity: 1,
          type: 'stop-limit',
          stopPrice: 100,
          limitPrice: 110,
        },
        GAP_UP,
      ),
    ).toBe(105);
    // sell: entry = min(open 95, stop 100) = 95; 95 ≥ limit 90 ⇒ fill @ 95 (as before the fix).
    expect(
      fillPrice(
        {
          symbol: 'X',
          side: 'sell',
          quantity: 1,
          type: 'stop-limit',
          stopPrice: 100,
          limitPrice: 90,
        },
        GAP_DOWN,
      ),
    ).toBe(95);
  });

  it('a stop-limit whose limit is beyond the trigger still falls back to the limit price', () => {
    // buy, stop 100 / limit 98: entry = max(95, 100) = 100 > 98, so the trigger price is not
    // acceptable; the bar's low (95) did reach 98, so the order fills AT the limit, 98.
    // (Which side of the trigger that low occurred on is not knowable from OHLC — this is the
    // engine's standing intrabar-path convention, shared with plain limit orders, not a fix.)
    expect(
      fillPrice(
        {
          symbol: 'X',
          side: 'buy',
          quantity: 1,
          type: 'stop-limit',
          stopPrice: 100,
          limitPrice: 98,
        },
        NO_GAP_UP,
      ),
    ).toBe(98);
  });

  it('an untriggered stop-limit does not fill at all', () => {
    // high 99 never reaches the 100 stop.
    expect(
      fillPrice(
        {
          symbol: 'X',
          side: 'buy',
          quantity: 1,
          type: 'stop-limit',
          stopPrice: 100,
          limitPrice: 100,
        },
        bar(0, 95, 99, 95, 99),
      ),
    ).toBeNull();
  });
});

// ───────────────────────────── 2. split × resting orders ─────────────────────────────

describe('a split adjusts everything the broker holds, not just the position', () => {
  it('a resting GTC limit is re-priced ÷ratio — no phantom fill on the split bar', () => {
    // GTC buy limit 90 on a $100 stock that splits 2:1 to $50.
    //   bar0 @100: limit 90 — open 100 > 90 and low 100 > 90 ⇒ no fill.
    //   bar1 @50, split 2: limitPrice 90 ÷ 2 = 45, quantity 10 × 2 = 20.
    //        open 50 > 45 and low 50 > 45 ⇒ STILL no fill. (Unadjusted, the stale 90 limit would
    //        have swallowed the whole split: open 50 ≤ 90 ⇒ an instant fill at 50 on a stock that
    //        never moved.)
    //   bar2 @44: open 44 ≤ 45 ⇒ fills 20 shares @ 44.
    const b = brokers.simulated({ cash: 1_000_000 });
    const id = b.submit({ symbol: 'X', side: 'buy', quantity: 10, type: 'limit', limitPrice: 90 });

    expect(b.processBar(flat(0, 100))).toHaveLength(0);
    expect(b.processBar(flat(1, 50), { split: 2 })).toHaveLength(0);

    const order = b.orders.find((o) => o.id === id)!;
    expect(order.limitPrice).toBe(45);
    expect(order.quantity).toBe(20);

    const fills = b.processBar(flat(2, 44));
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBe(44);
    expect(fills[0]!.quantity).toBe(20);
    expect(b.position('X').quantity).toBe(20);

    const w = b.warnings.find((x) => x.code === 'backtest.order_split_adjusted');
    expect(w).toBeDefined();
    expect(w!.severity).toBe('info');
    expect(w!.context!['order']).toBe(id);
    expect(w!.context!['split']).toBe(2);
    expect(w!.context!['after']).toMatchObject({ quantity: 20, limitPrice: 45 });
  });

  it("a stop-limit's BOTH prices are adjusted, and a bracket parent's exits with them", () => {
    // 4-for-1: stop 200 → 50, limit 210 → 52.5, takeProfit 240 → 60, stopLoss 160 → 40, qty 8 → 32.
    const b = brokers.simulated({ cash: 1_000_000 });
    const id = b.submit({
      symbol: 'X',
      side: 'buy',
      quantity: 8,
      type: 'stop-limit',
      stopPrice: 200,
      limitPrice: 210,
      takeProfit: 240,
      stopLoss: 160,
    });
    b.processBar(flat(0, 100)); // far below the 200 stop — nothing triggers
    b.processBar(flat(1, 25), { split: 4 });
    const order = b.orders.find((o) => o.id === id)!;
    expect(order.stopPrice).toBe(50);
    expect(order.limitPrice).toBe(52.5);
    expect(order.takeProfit).toBe(60);
    expect(order.stopLoss).toBe(40);
    expect(order.quantity).toBe(32);
  });
});

describe('split × borrow accrual', () => {
  /**
   * borrow 2.52%/yr over 252 periods ⇒ 0.0001 per bar of short market value.
   *   bar0 @100: short 1 000 sh; lastMark = 100.
   *   bar1 @50, split 2: position −1 000 → −2 000 AND lastMark 100 → 50, so the short's market
   *     value is unchanged at 2 000 × 50 = $100 000 and the charge is
   *     100 000 × 0.0252 / 252 = $10.00 exactly.
   *   Leaving lastMark at the pre-split 100 charged 2 000 × 100 × 0.0001 = $20.00 — the split
   *     doubled the borrow bill on a position whose value never changed.
   */
  it('charges the split-adjusted market value (10.00, not 20.00)', () => {
    const b = brokers.simulated({
      cash: 1_000_000,
      borrow: borrow.annualRate(0.0252),
      periodsPerYear: 252,
    });
    b.submit({ symbol: 'X', side: 'sell', quantity: 1000 });
    b.processBar(flat(0, 100)); // opens the short at 100; lastMark = 100
    expect(b.position('X').quantity).toBe(-1000);
    const cashAfterShort = b.cash;

    b.processBar(flat(1, 50), { split: 2 });
    // position −1 000 × 2 = −2 000 @ averagePrice 100 / 2 = 50; mark 100 / 2 = 50.
    expect(b.position('X').quantity).toBe(-2000);
    expect(b.position('X').averagePrice).toBeCloseTo(50, 12);
    // |−2 000| × 50 × 0.0252 / 252 = 100 000 × 0.0001 = 10.00
    expect(cashAfterShort - b.cash).toBeCloseTo(10, 9);
  });

  it('equity is continuous across the split bar', () => {
    // bar0 @100: buy 100 sh ⇒ cash 1 000 000 − 10 000 = 990 000; equity = 990 000 + 100·100 = 1 000 000.
    // bar1 @50 split 2: 200 sh @ mark 50 ⇒ equity = 990 000 + 200·50 = 1 000 000. Unchanged.
    const b = brokers.simulated({ cash: 1_000_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 100 });
    b.processBar(flat(0, 100));
    expect(b.cash).toBeCloseTo(990_000, 9);
    expect(b.equity(new Map())).toBeCloseTo(1_000_000, 9);

    b.processBar(flat(1, 50), { split: 2 });
    expect(b.position('X').quantity).toBe(200);
    expect(b.equity(new Map())).toBeCloseTo(1_000_000, 9);
  });
});

// ───────────────────────────── 3. OCO × volume participation ─────────────────────────────

describe('OCO siblings are re-sized on a PARTIAL fill, so a throttled bracket cannot double-exit', () => {
  it('a 10-lot bracket capped at 5/bar exits exactly 10 and never goes short', () => {
    // participation 0.5 on bars of volume 10 ⇒ at most 5 shares per bar.
    //   bar0 @100: parent buy 10 fills 5 (capped)         ⇒ position 5,  partially-filled
    //   bar1 @100: parent fills 5 more                    ⇒ position 10, FILLED ⇒ children born
    //              (take-profit limit sell 110 ×10, stop-loss stop sell 90 ×10; neither triggers
    //               on this flat 100 bar)
    //   bar2 (100/115/85/100): the bar touches BOTH exits.
    //         take-profit first (submission order): fills 5 @ 110 ⇒ position 5, partially-filled.
    //           ⇒ the sibling is re-sized to the 5 shares still open (was: left at 10).
    //         stop-loss:          fills 5 @ 90   ⇒ position 0, FILLED ⇒ take-profit cancelled.
    //   bar3 (same wide bar): nothing is working ⇒ no fills.
    //   Total sold = 5 + 5 = 10 = exactly the position. Before the fix both legs kept their full
    //   10 lots, so bar3 filled the two 5-lot remainders and left the book 10 lots SHORT.
    const b = brokers.simulated({ cash: 1_000_000, maxVolumeParticipation: 0.5 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, takeProfit: 110, stopLoss: 90 });

    b.processBar(flat(0, 100, 10));
    expect(b.position('X').quantity).toBe(5);
    b.processBar(flat(1, 100, 10));
    expect(b.position('X').quantity).toBe(10);
    expect(b.orders.filter((o) => o.ocoGroup)).toHaveLength(2);

    b.processBar(bar(2, 100, 115, 85, 100, 10));
    expect(b.position('X').quantity).toBe(0);

    b.processBar(bar(3, 100, 115, 85, 100, 10));
    expect(b.position('X').quantity).toBe(0); // never crosses to short

    const sells = b.trades.filter((t) => t.side === 'sell');
    expect(sells.reduce((s, t) => s + t.quantity, 0)).toBe(10);
    expect(sells.map((t) => t.price)).toEqual([110, 90]);
    expect(b.orders.find((o) => o.type === 'limit' && o.ocoGroup)!.status).toBe('cancelled');
  });

  it('a FULL fill still cancels the sibling outright (one-cancels-other, unchanged)', () => {
    // bar0 @100: parent buy 10 fills fully; children born (neither triggers on a flat 100 bar).
    // bar1 (100/115/85/100): take-profit fills all 10 @ 110 ⇒ stop-loss cancelled, position flat.
    const b = brokers.simulated({ cash: 1_000_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, takeProfit: 110, stopLoss: 90 });
    b.processBar(flat(0, 100));
    expect(b.position('X').quantity).toBe(10);

    b.processBar(bar(1, 100, 115, 85, 100));
    expect(b.position('X').quantity).toBe(0);
    expect(b.trades.filter((t) => t.side === 'sell')).toHaveLength(1);
    expect(b.trades[1]!.price).toBe(110);
    expect(b.orders.find((o) => o.type === 'stop' && o.ocoGroup)!.status).toBe('cancelled');
  });
});

describe('a bracket exits ITS OWN size, not the whole account position', () => {
  /**
   * The previous fix sized OCO siblings off `Math.abs(position(symbol).quantity)`, which is the
   * bracket's own size only when the bracket IS the entire position. Its regression started from a
   * flat account, so the two numbers coincided and this case was invisible.
   */
  it('long add-on: a 10-share bracket over a 100-share holding sells exactly 10', () => {
    // participation 0.5 on volume-10 bars ⇒ at most 5 shares per bar.
    //   bar0: an UNBRACKETED 100-share position is established over several bars.
    //   then:  buy 10 more WITH a bracket ⇒ position 110, bracket capacity 10.
    //   wide bar: take-profit fills 5 ⇒ the stop must be cut to 5, not left at 10.
    // Before the fix `remaining` read 105, the stop stayed at 10, and the bracket exited 15.
    const b = brokers.simulated({ cash: 1_000_000, maxVolumeParticipation: 1 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 100 });
    b.processBar(flat(0, 100, 1_000));
    expect(b.position('X').quantity).toBe(100);

    b.submit({ symbol: 'X', side: 'buy', quantity: 10, takeProfit: 110, stopLoss: 90 });
    b.processBar(flat(1, 100, 1_000));
    expect(b.position('X').quantity).toBe(110);

    // A bar that touches both exits, throttled to 5 shares.
    b.processBar(bar(2, 100, 115, 85, 100, 10));
    b.processBar(bar(3, 100, 115, 85, 100, 10));
    b.processBar(bar(4, 100, 115, 85, 100, 10));

    const sold = b.trades
      .filter((t) => t.side === 'sell')
      .reduce((total, t) => total + t.quantity, 0);
    expect(sold, 'the bracket exited more than the 10 shares it owned').toBe(10);
    expect(b.position('X').quantity, 'the original 100-share holding was raided').toBe(100);
  });

  it('short add-on: the same holds with the signs reversed', () => {
    const b = brokers.simulated({ cash: 1_000_000, maxVolumeParticipation: 1 });
    b.submit({ symbol: 'X', side: 'sell', quantity: 100 });
    b.processBar(flat(0, 100, 1_000));
    expect(b.position('X').quantity).toBe(-100);

    b.submit({ symbol: 'X', side: 'sell', quantity: 10, takeProfit: 90, stopLoss: 110 });
    b.processBar(flat(1, 100, 1_000));
    expect(b.position('X').quantity).toBe(-110);

    b.processBar(bar(2, 100, 115, 85, 100, 10));
    b.processBar(bar(3, 100, 115, 85, 100, 10));
    b.processBar(bar(4, 100, 115, 85, 100, 10));

    const bought = b.trades
      .filter((t) => t.side === 'buy')
      .reduce((total, t) => total + t.quantity, 0);
    expect(bought).toBe(10);
    expect(b.position('X').quantity).toBe(-100);
  });

  it('two overlapping brackets each exit their own size', () => {
    // Two brackets live at once, so the account position is neither one's capacity.
    const b = brokers.simulated({ cash: 1_000_000, maxVolumeParticipation: 1 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, takeProfit: 110, stopLoss: 90 });
    b.processBar(flat(0, 100, 1_000));
    b.submit({ symbol: 'X', side: 'buy', quantity: 6, takeProfit: 110, stopLoss: 90 });
    b.processBar(flat(1, 100, 1_000));
    expect(b.position('X').quantity).toBe(16);
    expect(new Set(b.orders.filter((o) => o.ocoGroup).map((o) => o.ocoGroup)).size).toBe(2);

    for (let i = 2; i < 8; i++) b.processBar(bar(i, 100, 115, 85, 100, 10));

    const sold = b.trades
      .filter((t) => t.side === 'sell')
      .reduce((total, t) => total + t.quantity, 0);
    expect(sold, 'the two brackets between them exited more than 16').toBe(16);
    expect(b.position('X').quantity).toBe(0);
  });

  it('a bracket does not exit shares the strategy already closed out from under it', () => {
    const b = brokers.simulated({ cash: 1_000_000, maxVolumeParticipation: 1 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, takeProfit: 110, stopLoss: 90 });
    b.processBar(flat(0, 100, 1_000));
    expect(b.position('X').quantity).toBe(10);

    // the strategy flattens by hand; the bracket must not then sell 10 more
    b.submit({ symbol: 'X', side: 'sell', quantity: 10 });
    b.processBar(flat(1, 100, 1_000));
    expect(b.position('X').quantity).toBe(0);

    b.processBar(bar(2, 100, 115, 85, 100, 1_000));
    expect(b.position('X').quantity, 'the bracket sold shares that were already gone').toBe(0);
  });
});

// ───────────────────────────── 4. onBars × percent sizing ─────────────────────────────

describe('percent sizing prices the SIZED symbol, whatever bar came last', () => {
  /**
   * A ($50) and B ($200) both print at every timestamp, B second, so inside `onBars` the engine's
   * `currentBar` is always B. Sizing A off `currentBar.close` valued A's shares at $200 apiece.
   */
  const data = (): Bar[] => {
    const out: Bar[] = [];
    for (let i = 0; i < 6; i++) {
      out.push(flat(i, 50, undefined, 'A'));
      out.push(flat(i, 200, undefined, 'B'));
    }
    return out;
  };

  it('buy: one 1 000-share fill, then delta = 0 forever', () => {
    // target = 0.5 × 100 000 = 50 000; first pass current = 0 ⇒ buy 50 000 notional ⇒ 1 000 sh @ 50.
    // afterwards equity = 50 000 cash + 1 000·50 = 100 000, current = 1 000·50 = 50 000 ⇒ delta 0.
    // (Buggy: current = 1 000 · 200 = 200 000 ⇒ delta = −150 000 ⇒ a phantom sell every bar.)
    const r = backtest.eventDriven({
      data: data(),
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(context) {
        context.onBar('A', () => {});
        context.onBar('B', () => {});
        context.onBars(() => context.buy('A', { percent: 0.5 }));
      },
    });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ symbol: 'A', side: 'buy', quantity: 1000, price: 50 });
    expect(r.finalValue).toBeCloseTo(100_000, 9);
  });

  it('sell: one 1 000-share short, then delta = 0 forever', () => {
    // target = −0.5 × 100 000 = −50 000; current = 0 ⇒ sell 50 000 notional ⇒ short 1 000 sh @ 50.
    // afterwards equity = 150 000 cash − 1 000·50 = 100 000, current = −50 000 ⇒ delta 0.
    const r = backtest.eventDriven({
      data: data(),
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(context) {
        context.onBar('A', () => {});
        context.onBar('B', () => {});
        context.onBars(() => context.sell('A', { percent: 0.5 }));
      },
    });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ symbol: 'A', side: 'sell', quantity: 1000, price: 50 });
    expect(r.finalValue).toBeCloseTo(100_000, 9);
  });
});

// ───────────────────────────── 5. commission on the slipped price ─────────────────────────────

describe('commission is charged on the price the fill actually printed at', () => {
  it('a bps schedule bills the slipped price, not the reference', () => {
    // ref = 50, slippage 100 bps against a buy ⇒ fill 50 × 1.01 = 50.50.
    // commission = 100 sh × 50.50 × 10/10 000 = 100 × 50.50 × 0.001 = 5.05
    //   (billed at the reference it was 100 × 50 × 0.001 = 5.00 — a 0.05 UNDER-charge every buy).
    // cash = 1 000 000 − 100 × 50.50 − 5.05 = 1 000 000 − 5 050 − 5.05 = 994 944.95.
    const b = brokers.simulated({
      cash: 1_000_000,
      commission: fees.bps(10),
      slippage: slippage.bps(100),
    });
    b.submit({ symbol: 'X', side: 'buy', quantity: 100 });
    const fills = b.processBar(flat(0, 50));
    expect(fills[0]!.price).toBeCloseTo(50.5, 12);
    expect(fills[0]!.commission).toBeCloseTo(5.05, 12);
    expect(b.cash).toBeCloseTo(994_944.95, 9);
  });

  it('a sell is billed at its (lower) slipped price too', () => {
    // ref = 50, slippage 100 bps against a sell ⇒ fill 50 × 0.99 = 49.50.
    // commission = 100 × 49.50 × 0.001 = 4.95 (billed at the reference it was 5.00 — an OVER-charge).
    const b = brokers.simulated({
      cash: 1_000_000,
      commission: fees.bps(10),
      slippage: slippage.bps(100),
    });
    b.submit({ symbol: 'X', side: 'sell', quantity: 100 });
    const fills = b.processBar(flat(0, 50));
    expect(fills[0]!.price).toBeCloseTo(49.5, 12);
    expect(fills[0]!.commission).toBeCloseTo(4.95, 12);
  });
});

// ───────────────────────────── 6. contract multiplier in attribution ─────────────────────────────

describe('a registered option is valued at its contract multiplier', () => {
  it('turnover and realized P&L apply ×100, not ×1', () => {
    // One call contract, multiplier 100, expiring after the data (so nothing settles).
    // premiums:      bar0 5, bar1 5, bar2 8, bar3 8, bar4 8
    // buy submitted on bar0's handler  ⇒ fills bar1 @ 5 ⇒ cash −1 × 5 × 100 = −500
    // sell submitted on bar2's handler ⇒ fills bar3 @ 8 ⇒ cash +1 × 8 × 100 = +800
    //   realized P&L    = (8 − 5) × 1 contract × 100 = 300     (was 3 without the multiplier)
    //   traded notional = 1·5·100 + 1·8·100 = 500 + 800 = 1 300 (was 13)
    const premia = [5, 5, 8, 8, 8];
    const expiry = t0 + 30 * DAY; // beyond the last bar
    const r = backtest.eventDriven({
      data: premia.map((p, i) => flat(i, p, undefined, 'XYZ_C100')),
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(context) {
        context.registerOption('XYZ_C100', {
          underlying: 'XYZ',
          type: 'call',
          strike: 100,
          expiresAt: expiry,
          multiplier: 100,
        });
        let i = 0;
        context.onBar('XYZ_C100', () => {
          if (i === 0) context.buy('XYZ_C100', { quantity: 1 });
          if (i === 2) context.sell('XYZ_C100', { quantity: 1 });
          i++;
        });
      },
    });

    expect(r.trades).toHaveLength(2);
    expect(r.trades.map((t) => t.multiplier)).toEqual([100, 100]);

    const sheet = tearSheet(r);
    const leg = sheet.attribution.find((a) => a.symbol === 'XYZ_C100')!;
    expect(leg.realizedPnl).toBeCloseTo(300, 9);
    expect(leg.tradedNotional).toBeCloseTo(1300, 9);

    // Engine turnover uses the same cash-valued notional: Σ|notional| ÷ mean equity.
    const equities = r.points.map((p) => p.equity);
    const averageEquity = equities.reduce((s, e) => s + e, 0) / equities.length;
    expect(r.turnover).toBeCloseTo(1300 / averageEquity, 9);
  });

  it('a plain share fill is multiplier 1 — cash value is unchanged', () => {
    const b = brokers.simulated({ cash: 100_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10 });
    const fills = b.processBar(flat(0, 100));
    expect(fills[0]!.multiplier).toBe(1);
    expect(b.cash).toBeCloseTo(99_000, 9); // 100 000 − 10 × 100 × 1
  });

  it('commission and slippage on an option fill are cash figures at the contract multiplier', () => {
    // 10 bps commission on 2 contracts at a 5.05 print (5 reference + 1% slippage) is charged on
    // the CASH price of a contract, 5.05 × 100, exactly as the shared fill kernel bills it:
    //   commission = 2 × 505 × 0.001 = 1.01      (was 0.0101 — billed as if a contract were a share)
    //   slippage   = 2 × |5.05 − 5| × 100 = 10   (was 0.10 — reported in premium points)
    //   cash       = 100 000 − 2 × 5.05 × 100 − 1.01
    const b = brokers.simulated({
      cash: 100_000,
      commission: fees.bps(10),
      slippage: slippage.bps(100),
    });
    b.registerOption('XYZ_C100', {
      underlying: 'XYZ',
      type: 'call',
      strike: 100,
      expiresAt: t0 + 30 * DAY,
      multiplier: 100,
    });
    b.submit({ symbol: 'XYZ_C100', side: 'buy', quantity: 2 });
    const [fill] = b.processBar(flat(0, 5, undefined, 'XYZ_C100'));
    expect(fill).toMatchObject({ quantity: 2, price: 5.05, multiplier: 100 });
    expect(fill!.commission).toBeCloseTo(1.01, 9);
    expect(fill!.slippage).toBeCloseTo(10, 9);
    expect(b.cash).toBeCloseTo(100_000 - 2 * 5.05 * 100 - 1.01, 9);
  });

  it('a notional option order is sized in cash, not in premium points', () => {
    // $2 000 of a 5-premium contract is 4 contracts (2 000 ÷ (5 × 100)), not 400.
    const b = brokers.simulated({ cash: 100_000 });
    b.registerOption('XYZ_C100', {
      underlying: 'XYZ',
      type: 'call',
      strike: 100,
      expiresAt: t0 + 30 * DAY,
      multiplier: 100,
    });
    b.submit({ symbol: 'XYZ_C100', side: 'buy', notional: 2_000 });
    const [fill] = b.processBar(flat(0, 5, undefined, 'XYZ_C100'));
    expect(fill!.quantity).toBeCloseTo(4, 9);
    expect(b.cash).toBeCloseTo(98_000, 9);
  });
});

// ───────────────────────────── 7. the ambiguous-bar OCO tie-break ─────────────────────────────

describe('the OCO tie-break on an ambiguous bar is disclosed, not silent', () => {
  it('assumptions.oco echoes the take-profit-first rule the engine actually applies', () => {
    const r = backtest.eventDriven({
      data: [flat(0, 100), flat(1, 100), bar(2, 100, 115, 85, 100)],
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(context) {
        let done = false;
        context.onBar('X', () => {
          if (!done) {
            context.buy('X', { quantity: 10, takeProfit: 110, stopLoss: 90 });
            done = true;
          }
        });
      },
    });
    expect(r.assumptions.oco).toBe('take-profit-first-on-ambiguous-bar');
    // …and the run really did take the optimistic leg: the wide bar touched 115 AND 85, and the
    // exit printed at the take-profit 110 rather than the stop 90.
    const sell = r.trades.find((t) => t.side === 'sell')!;
    expect(sell.price).toBe(110);
  });

  it('brokers.simulated().policies() carries the same label', () => {
    expect(brokers.simulated({ cash: 1 }).policies().oco).toBe(
      'take-profit-first-on-ambiguous-bar',
    );
  });
});

// ───────────────────────────── 8. degenerate return statistics ─────────────────────────────

describe('degenerate return statistics are null-with-warning, never a fabricated 0', () => {
  it('an EMPTY series has no expectancy and no hit rate', () => {
    const s = returnStatistics([]);
    expect(s.hitRate).toBeNull();
    expect(s.expectancy).toBeNull();
    const codes = s.diagnostics.warnings.map((w) => w.code);
    expect(codes.filter((c) => c === 'performance.undefined_metric')).toHaveLength(2);
    expect(s.diagnostics.warnings.every((w) => w.severity === 'info')).toBe(true);
  });

  it('an ALL-ZERO series has no hit rate (0 would read as "every bar lost")', () => {
    // No non-zero bar ⇒ no win/loss population. Expectancy is still defined: mean of [0,0,0] = 0.
    const s = returnStatistics([0, 0, 0]);
    expect(s.hitRate).toBeNull();
    expect(s.expectancy).toBe(0);
    expect(
      s.diagnostics.warnings.some(
        (w) => w.code === 'performance.undefined_metric' && /hitRate/.test(w.message),
      ),
    ).toBe(true);
  });

  it('a normal series is unaffected', () => {
    // +1, −1, +2 non-zero bars: 2 wins of 3 ⇒ 2/3; mean of [0.1, −0.1, 0.2, 0] = 0.05.
    const s = returnStatistics([0.1, -0.1, 0.2, 0]);
    expect(s.hitRate).toBeCloseTo(2 / 3, 12);
    expect(s.expectancy).toBeCloseTo(0.05, 12);
    expect(s.diagnostics.warnings).toHaveLength(0);
  });

  it('the tear sheet carries the disclosure into its diagnostics', () => {
    // A run with no price movement at all: every bar return is exactly 0.
    const r = backtest.eventDriven({
      data: [flat(0, 100), flat(1, 100), flat(2, 100)],
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(context) {
        context.onBar('X', () => {});
      },
    });
    const sheet = tearSheet(r);
    expect(sheet.returns.hitRate).toBeNull();
    expect(sheet.diagnostics.warnings.some((w) => w.code === 'performance.undefined_metric')).toBe(
      true,
    );
    // The tear sheet must agree with @totalfinance/performance on the same series.
    expect(sheet.performance.hitRate).toBeNull();
  });
});
