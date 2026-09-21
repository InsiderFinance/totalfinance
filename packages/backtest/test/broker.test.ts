import { describe, expect, it } from 'vitest';
import { InputError, type Bar } from '@totalfinance/core';
import { borrow, fees } from '@totalfinance/backtest/costs';
import { SimulatedBroker } from '@totalfinance/backtest';

const DAY = 86_400_000;
const t0 = Date.UTC(2026, 0, 1);
function bar(i: number, o: number, h: number, l: number, c: number, volume?: number): Bar {
  return {
    symbol: 'X',
    timestampMs: t0 + i * DAY,
    open: o,
    high: h,
    low: l,
    close: c,
    ...(volume !== undefined ? { volume } : {}),
  };
}

describe('SimulatedBroker — order types', () => {
  it('market order fills at the bar open with commission, moving cash and position', () => {
    const b = new SimulatedBroker({ cash: 100_000, commission: fees.perShare(0.01) });
    b.submit({ symbol: 'X', side: 'buy', quantity: 100 });
    const fills = b.processBar(bar(0, 50, 52, 49, 51));
    expect(fills).toHaveLength(1);
    expect(b.position('X').quantity).toBe(100);
    expect(b.position('X').averagePrice).toBe(50);
    expect(b.cash).toBeCloseTo(100_000 - 100 * 50 - 100 * 0.01, 6);
  });

  it('limit buy fills only when the bar trades down to the limit', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, type: 'limit', limitPrice: 48 });
    expect(b.processBar(bar(0, 50, 51, 49, 50))).toHaveLength(0); // never reached 48
    expect(b.processBar(bar(1, 49, 50, 47, 48))).toHaveLength(1); // dipped to 47 → fills at 48
    expect(b.position('X').quantity).toBe(10);
  });

  it('stop buy triggers when the bar trades up through the stop', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, type: 'stop', stopPrice: 52 });
    expect(b.processBar(bar(0, 50, 51, 49, 50))).toHaveLength(0);
    const fills = b.processBar(bar(1, 51, 53, 50, 52));
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price).toBe(52); // max(open=51, stop=52)
  });

  it('stop-limit needs both the trigger and the limit', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    b.submit({
      symbol: 'X',
      side: 'buy',
      quantity: 10,
      type: 'stop-limit',
      stopPrice: 52,
      limitPrice: 52.5,
    });
    // triggers (high 53) and fills within the limit
    expect(b.processBar(bar(0, 51, 53, 50, 52))).toHaveLength(1);
  });
});

describe('SimulatedBroker — brackets / OCO, shorts, partial fills, margin, corporate actions', () => {
  it('a bracket attaches take-profit + stop-loss as OCO; one fill cancels the other', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, takeProfit: 55, stopLoss: 45 });
    b.processBar(bar(0, 50, 50, 50, 50)); // parent fills, children created
    const children = b.orders.filter((o) => o.ocoGroup);
    expect(children).toHaveLength(2);
    b.processBar(bar(1, 54, 56, 53, 55)); // hits take-profit
    expect(b.position('X').quantity).toBe(0); // flat
    expect(b.orders.find((o) => o.type === 'stop' && o.ocoGroup)!.status).toBe('cancelled');
  });

  it('shorting accrues a borrow fee carried into the next bar', () => {
    const b = new SimulatedBroker({
      cash: 100_000,
      borrow: borrow.annualRate(0.0252),
      periodsPerYear: 252,
    });
    b.submit({ symbol: 'X', side: 'sell', quantity: 100 });
    b.processBar(bar(0, 100, 100, 100, 100)); // open short; mark=100
    const cashAfterShort = b.cash;
    b.processBar(bar(1, 100, 100, 100, 100)); // borrow accrues on |100|*100 * 0.0252/252 = 1
    expect(cashAfterShort - b.cash).toBeCloseTo(1, 6);
  });

  it('volume-participation caps a single fill into partial fills', () => {
    const b = new SimulatedBroker({ cash: 1_000_000, maxVolumeParticipation: 0.1 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 25 });
    b.processBar(bar(0, 50, 50, 50, 50, 100)); // cap = 10
    expect(b.position('X').quantity).toBe(10);
    expect(b.orders[0]!.status).toBe('partially-filled');
    b.processBar(bar(1, 50, 50, 50, 50, 100));
    expect(b.position('X').quantity).toBe(20);
  });

  it('a gross-leverage cap rejects an over-leveraged order', () => {
    const b = new SimulatedBroker({ cash: 1000, maxLeverage: 1 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 100 }); // 100*50 = 5000 >> 1× of 1000 equity
    b.processBar(bar(0, 50, 50, 50, 50));
    expect(b.position('X').quantity).toBe(0);
    expect(b.warnings.some((w) => w.code === 'backtest.margin_rejected')).toBe(true);
  });

  it('dividends credit a long, splits adjust the position', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 100 });
    b.processBar(bar(0, 50, 50, 50, 50));
    const cash0 = b.cash;
    b.processBar(bar(1, 50, 50, 50, 50), { dividend: 0.5 });
    expect(b.cash - cash0).toBeCloseTo(50, 6); // 100 shares × $0.50
    b.processBar(bar(2, 25, 25, 25, 25), { split: 2 });
    expect(b.position('X').quantity).toBe(200);
    expect(b.position('X').averagePrice).toBeCloseTo(25, 6);
  });
});

describe('SimulatedBroker — validation', () => {
  it('rejects bad orders', () => {
    const b = new SimulatedBroker({ cash: 1000 });
    expect(() => b.submit({ symbol: 'X', side: 'buy', quantity: -1 })).toThrow(InputError);
    expect(() => b.submit({ symbol: 'X', side: 'buy', quantity: 1, type: 'limit' })).toThrow(
      InputError,
    );
    expect(() => b.submit({ symbol: 'X', side: 'buy', quantity: 1, type: 'stop' })).toThrow(
      InputError,
    );
  });
});

describe('SimulatedBroker — submittedTimestampMs (dx review: no dead-zero clock)', () => {
  it('an order submitted while a bar is being processed carries that bar timestamp', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    b.processBar(bar(0, 50, 50, 50, 50));
    const id = b.submit({ symbol: 'X', side: 'buy', quantity: 10 });
    const order = b.orders.find((o) => o.id === id)!;
    expect(order.submittedTimestampMs).toBe(t0); // the bar the broker last processed — its only clock
  });

  it('an order submitted before the broker has seen any bar has NO submittedTimestampMs (not a fake 0)', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    const id = b.submit({ symbol: 'X', side: 'buy', quantity: 10 });
    const order = b.orders.find((o) => o.id === id)!;
    expect(order.submittedTimestampMs).toBeUndefined();
    expect('submittedTimestampMs' in order).toBe(false);
  });

  it('bracket children submitted on the parent fill carry the fill bar timestamp', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, takeProfit: 60, stopLoss: 40 });
    b.processBar(bar(0, 50, 50, 50, 50)); // parent fills here; children are submitted mid-bar
    const children = b.orders.filter((o) => o.ocoGroup?.startsWith('bracket-'));
    expect(children).toHaveLength(2);
    for (const child of children) expect(child.submittedTimestampMs).toBe(t0);
  });
});
