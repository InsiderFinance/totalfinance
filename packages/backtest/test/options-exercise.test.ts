/**
 * Tests for §16.2 options exercise / assignment in the simulated broker: physical and cash settlement
 * of ITM longs (exercise) and shorts (assignment), worthless OTM expiry, multiplier-aware marking and
 * fill cash, and end-to-end auto-settlement through the event-driven engine.
 */

import { describe, expect, it } from 'vitest';
import type { Bar } from '@totalfinance/core';
import { brokers, eventDriven } from '@totalfinance/backtest';

const EXPIRY = 3000;
const optSpecification = (overrides = {}) => ({
  underlying: 'AAPL',
  type: 'call' as const,
  strike: 100,
  expiresAt: EXPIRY,
  multiplier: 100,
  ...overrides,
});

describe('option settlement in the broker', () => {
  it('exercises an ITM long call physically (pay strike, receive shares)', () => {
    const b = brokers.simulated({ cash: 100_000 });
    b.registerOption('AAPL_C', optSpecification());
    b.positions.set('AAPL_C', { symbol: 'AAPL_C', quantity: 1, averagePrice: 5 });
    const [s] = b.settleExpiries(EXPIRY, new Map([['AAPL', 120]]));
    expect(s!.action).toBe('exercised');
    expect(s!.intrinsic).toBe(20);
    expect(s!.cashFlow).toBe(-10_000); // pay 100 × 100 shares
    expect(s!.shares).toBe(100);
    expect(b.cash).toBe(90_000);
    expect(b.position('AAPL').quantity).toBe(100);
    expect(b.position('AAPL').averagePrice).toBe(100);
    expect(b.position('AAPL_C').quantity).toBe(0); // option gone
  });

  it('cash-settles an ITM long call to its intrinsic', () => {
    const b = brokers.simulated({ cash: 100_000 });
    b.registerOption('AAPL_C', optSpecification({ settlement: 'cash' }));
    b.positions.set('AAPL_C', { symbol: 'AAPL_C', quantity: 2, averagePrice: 5 });
    const [s] = b.settleExpiries(EXPIRY, new Map([['AAPL', 115]]));
    expect(s!.settlement).toBe('cash');
    expect(s!.cashFlow).toBe(15 * 100 * 2); // intrinsic × mult × contracts
    expect(b.cash).toBe(103_000);
    expect(b.position('AAPL').quantity).toBe(0); // no shares delivered
  });

  it('assigns an ITM short call (deliver shares, receive strike)', () => {
    const b = brokers.simulated({ cash: 100_000 });
    b.registerOption('AAPL_C', optSpecification());
    b.positions.set('AAPL_C', { symbol: 'AAPL_C', quantity: -1, averagePrice: 5 });
    const [s] = b.settleExpiries(EXPIRY, new Map([['AAPL', 120]]));
    expect(s!.action).toBe('assigned');
    expect(s!.cashFlow).toBe(10_000); // receive 100 × 100
    expect(s!.shares).toBe(-100); // short 100 shares
    expect(b.position('AAPL').quantity).toBe(-100);
  });

  it('exercises an ITM long put (sell shares at strike)', () => {
    const b = brokers.simulated({ cash: 100_000 });
    b.registerOption('AAPL_P', optSpecification({ type: 'put' }));
    b.positions.set('AAPL_P', { symbol: 'AAPL_P', quantity: 1, averagePrice: 5 });
    const [s] = b.settleExpiries(EXPIRY, new Map([['AAPL', 80]]));
    expect(s!.action).toBe('exercised');
    expect(s!.intrinsic).toBe(20);
    expect(s!.cashFlow).toBe(10_000); // receive 100 × 100
    expect(b.position('AAPL').quantity).toBe(-100); // delivered/sold short
  });

  it('lets an OTM option expire worthless', () => {
    const b = brokers.simulated({ cash: 100_000 });
    b.registerOption('AAPL_C', optSpecification());
    b.positions.set('AAPL_C', { symbol: 'AAPL_C', quantity: 1, averagePrice: 5 });
    const [s] = b.settleExpiries(EXPIRY, new Map([['AAPL', 90]]));
    expect(s!.action).toBe('expired');
    expect(s!.cashFlow).toBe(0);
    expect(b.cash).toBe(100_000);
    expect(b.position('AAPL_C').quantity).toBe(0);
    expect(b.position('AAPL').quantity).toBe(0);
  });

  it('throws when no underlier settlement price is available', () => {
    const b = brokers.simulated({ cash: 100_000 });
    b.registerOption('AAPL_C', optSpecification());
    b.positions.set('AAPL_C', { symbol: 'AAPL_C', quantity: 1, averagePrice: 5 });
    expect(() => b.settleExpiries(EXPIRY)).toThrow(/settlement price/);
  });

  it('rejects a NaN/non-positive settlement mark WITHOUT mutating state, so a retry still settles', () => {
    const b = brokers.simulated({ cash: 100_000 });
    b.registerOption('AAPL_C', optSpecification());
    b.positions.set('AAPL_C', { symbol: 'AAPL_C', quantity: 1, averagePrice: 5 });
    // A NaN mark must not slip past the `=== undefined` check and write NaN into cash.
    expect(() => b.settleExpiries(EXPIRY, new Map([['AAPL', NaN]]))).toThrow(/settlement price/);
    expect(() => b.settleExpiries(EXPIRY, new Map([['AAPL', -5]]))).toThrow(/settlement price/);
    // Nothing was mutated: the option is still registered, the position intact, cash untouched.
    expect(b.cash).toBe(100_000);
    expect(b.position('AAPL_C').quantity).toBe(1);
    const [s] = b.settleExpiries(EXPIRY, new Map([['AAPL', 120]]));
    expect(s!.action).toBe('exercised');
    expect(b.cash).toBe(90_000);
  });

  it('marks option positions by their contract multiplier', () => {
    const b = brokers.simulated({ cash: 10_000 });
    b.registerOption('AAPL_C', optSpecification());
    b.positions.set('AAPL_C', { symbol: 'AAPL_C', quantity: 1, averagePrice: 5 });
    // 1 contract × $6 × 100 multiplier = $600 of market value.
    expect(b.equity(new Map([['AAPL_C', 6]]))).toBe(10_000 + 600);
  });
});

describe('end-to-end exercise through the event-driven engine', () => {
  const bar = (symbol: string, timestampMs: number, close: number): Bar => ({
    symbol,
    timestampMs,
    open: close,
    high: close,
    low: close,
    close,
  });

  it('auto-settles a held ITM call at expiry and reflects it in the result', () => {
    // Underlier rallies 100 → 120; the call (strike 100) is bought at ts1 and exercised at expiry ts3.
    const data: Bar[] = [
      bar('AAPL', 1000, 100),
      bar('AAPL_C', 1000, 5),
      bar('AAPL', 2000, 110),
      bar('AAPL_C', 2000, 11),
      bar('AAPL', 3000, 120),
    ];
    const result = eventDriven({
      data,
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(context) {
        let bought = false;
        context.registerOption('AAPL_C', optSpecification());
        context.onBar('AAPL_C', () => {
          if (!bought) {
            context.buy('AAPL_C', { quantity: 1 });
            bought = true;
          }
        });
      },
    });
    expect(result.settlements).toHaveLength(1);
    const s = result.settlements![0]!;
    expect(s.action).toBe('exercised');
    expect(s.intrinsic).toBe(20);
    // Bought 1 call for ~$11×100 = $1,100 at ts2 (fill of the ts1 order), exercised into 100 shares
    // worth $12,000 having paid $10,000 strike ⇒ net option P&L ≈ +$2,000 − $1,100 premium.
    expect(result.finalValue).toBeGreaterThan(100_000); // ITM exercise was profitable net of premium
  });
});
