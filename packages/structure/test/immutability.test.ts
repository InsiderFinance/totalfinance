import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionQuote, OptionTrade, OptionType } from '@totalfinance/core';
import { exposure, flow } from '../src/index.js';

/**
 * DX §4.4 — analysis results are frozen snapshots: mutating a result in place must throw, never
 * silently diverge from the assumptions/diagnostics that describe it.
 */
const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-02-20';

function q(type: OptionType, strike: number, oi: number): OptionQuote {
  return {
    contract: {
      underlying: 'X',
      type,
      style: 'european',
      strike,
      expiry,
      multiplier: 100,
      ...resolvedExpiry(expiry),
    },
    timestampMs: asOf,
    impliedVolatility: 0.2,
    openInterest: oi,
    underlyingPrice: 100,
  };
}

function trade(ts: number, price: number, size: number): OptionTrade {
  return {
    contract: {
      underlying: 'SPY',
      type: 'call',
      style: 'european',
      strike: 100,
      expiry,
      ...resolvedExpiry(expiry),
      multiplier: 100,
    },
    timestampMs: ts,
    price,
    size,
    bid: price - 0.1,
    ask: price + 0.1,
  };
}

describe('structure result immutability (dx §4.4)', () => {
  it('exposure profile contracts are frozen', () => {
    const profile = exposure({
      quotes: [q('call', 100, 1000), q('put', 95, 800)],
      market: { riskFreeRate: 0.03, asOf, spot: 100 },
      config: { convention: 'callsPositivePutsNegative' },
    });
    expect(Object.isFrozen(profile.contracts)).toBe(true);
    expect(Object.isFrozen(profile.contracts[0])).toBe(true);
    expect(() => (profile.contracts as unknown as unknown[]).push({})).toThrow(TypeError);
  });

  it('flow analysis trades/sweeps/spreads are frozen', () => {
    const analysis = flow([trade(1000, 2.5, 50), trade(1100, 2.6, 60)]);
    for (const arr of [analysis.trades, analysis.sweeps, analysis.spreads]) {
      expect(Object.isFrozen(arr)).toBe(true);
    }
    expect(() => (analysis.trades as unknown as unknown[]).push({})).toThrow(TypeError);
  });
});
