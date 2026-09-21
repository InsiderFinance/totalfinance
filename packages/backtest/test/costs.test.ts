import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { borrow, fees, slippage } from '@totalfinance/backtest/costs';

describe('commission models', () => {
  it('bps charges basis points of notional', () => {
    expect(fees.bps(10).commission({ quantity: 100, price: 50 })).toBeCloseTo(
      (100 * 50 * 10) / 10_000,
      12,
    ); // 5
  });
  it('perShare charges per share; fixed charges once', () => {
    expect(fees.perShare(0.005).commission({ quantity: 200, price: 50 })).toBeCloseTo(1, 12);
    expect(fees.fixed(1).commission({ quantity: 200, price: 50 })).toBe(1);
    expect(fees.fixed(1).commission({ quantity: 0, price: 50 })).toBe(0);
  });
  it('rejects negative parameters', () => {
    expect(() => fees.bps(-1)).toThrow(InputError);
  });
});

describe('slippage models worsen the fill against the order', () => {
  it('a buy fills above and a sell below the reference', () => {
    expect(slippage.bps(20).fill({ referencePrice: 100, side: 'buy', quantity: 1 })).toBeCloseTo(
      100.2,
      9,
    );
    expect(slippage.bps(20).fill({ referencePrice: 100, side: 'sell', quantity: 1 })).toBeCloseTo(
      99.8,
      9,
    );
    expect(
      slippage.fixed(0.05).fill({ referencePrice: 100, side: 'buy', quantity: 1 }),
    ).toBeCloseTo(100.05, 9);
    expect(
      slippage.spread(0.001).fill({ referencePrice: 100, side: 'buy', quantity: 1 }),
    ).toBeCloseTo(100.05, 9); // half of 10bps
  });
});

describe('borrow model', () => {
  it('carries an annual rate and label', () => {
    expect(borrow.annualRate(0.005).annualRate).toBe(0.005);
    expect(borrow.none().annualRate).toBe(0);
    expect(() => borrow.annualRate(-1)).toThrow(InputError);
  });
});
