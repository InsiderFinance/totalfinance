/**
 * Tests for the §11.6 flow additions: 0DTE detection, opening estimate, and the call/put premium
 * summary with put/call ratios.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionTrade, OptionType } from '@totalfinance/core';
import { flow } from '@totalfinance/structure';

function trade(
  type: OptionType,
  strike: number,
  ts: number,
  price: number,
  size: number,
  expiry: string,
  options: { bid?: number; ask?: number; openInterest?: number } = {},
): OptionTrade {
  return {
    contract: {
      underlying: 'SPY',
      type,
      style: 'european',
      strike,
      expiry,
      multiplier: 100,
      ...resolvedExpiry(expiry),
    },
    timestampMs: ts,
    price,
    size,
    ...(options.bid !== undefined ? { bid: options.bid } : {}),
    ...(options.ask !== undefined ? { ask: options.ask } : {}),
    ...(options.openInterest !== undefined ? { openInterest: options.openInterest } : {}),
  };
}

const onExpiryDay = Date.UTC(2026, 2, 20, 14); // 2026-03-20 14:00 UTC
const earlier = Date.UTC(2026, 2, 18, 14); // 2026-03-18

describe('0DTE detection', () => {
  it('flags trades printing on their contract expiration day', () => {
    const f = flow([
      trade('call', 500, onExpiryDay, 1, 10, '2026-03-20'), // expires today → 0DTE
      trade('call', 500, earlier, 1, 10, '2026-03-20'), // 2 days out → not 0DTE
    ]);
    // the constructor sorts by ts, so address trades by their timestamp, not input index
    expect(f.zeroDaysToExpiry).toHaveLength(1);
    expect(f.zeroDaysToExpiry[0]!.trade.timestampMs).toBe(onExpiryDay);
    expect(f.trades.find((t) => t.trade.timestampMs === earlier)!.isZeroDaysToExpiry).toBe(false);
  });
});

describe('opening estimate', () => {
  it('flags a definite open when size exceeds prior open interest', () => {
    const f = flow([
      trade('call', 500, onExpiryDay, 1, 5000, '2026-04-17', { openInterest: 1000 }), // size > OI → open
      trade('call', 500, onExpiryDay, 1, 50, '2026-04-17', { openInterest: 1000 }), // size < OI → unknown
      trade('call', 500, onExpiryDay, 1, 50, '2026-04-17'), // no OI → unknown
    ]);
    expect(f.trades[0]!.openClose).toBe('open');
    expect(f.trades[1]!.openClose).toBe('unknown');
    expect(f.trades[2]!.openClose).toBe('unknown');
  });
});

describe('call/put premium summary', () => {
  it('aggregates premium/volume by right and computes put/call ratios', () => {
    const e = '2026-04-17';
    const f = flow([
      trade('call', 500, 1, 2.0, 10, e, { bid: 1.9, ask: 2.0 }), // at ask → buy, $2000
      trade('call', 510, 2, 1.0, 10, e, { bid: 1.0, ask: 1.1 }), // at bid → sell, $1000
      trade('put', 490, 3, 3.0, 20, e, { bid: 2.9, ask: 3.0 }), // at ask → buy, $6000
    ]);
    const s = f.callPutPremium();
    expect(s.callPremium).toBeCloseTo(2.0 * 10 * 100 + 1.0 * 10 * 100, 6); // 3000
    expect(s.putPremium).toBeCloseTo(3.0 * 20 * 100, 6); // 6000
    expect(s.callVolume).toBe(20);
    expect(s.putVolume).toBe(20);
    expect(s.putCallVolumeRatio).toBeCloseTo(1, 12);
    expect(s.putCallPremiumRatio).toBeCloseTo(6000 / 3000, 12);
    // net premium: call buy 2000 + put buy 6000 − call sell 1000 = 7000
    expect(s.netPremium).toBeCloseTo(2000 + 6000 - 1000, 6);
  });

  it('reports null put/call ratios (JSON-safe) when a side has no flow', () => {
    const s = flow([trade('put', 490, 1, 3, 20, '2026-04-17')]).callPutPremium();
    expect(s.putCallVolumeRatio).toBeNull();
    expect(s.putCallPremiumRatio).toBeNull();
  });
});

describe('flow config validation (PR review §4)', () => {
  const t = trade('call', 500, onExpiryDay, 1, 10, '2026-03-20');
  it('rejects nonsensical flow knobs', () => {
    expect(() => flow([t], { multiplier: -100 })).toThrow(/multiplier/);
    expect(() => flow([t], { blockMinSize: -1 })).toThrow(/blockMinSize/);
    expect(() => flow([t], { blockMinPremium: -5 })).toThrow(/blockMinPremium/);
    expect(() => flow([t], { sweepWindowMs: 0 })).toThrow(/sweepWindowMs/);
    expect(() => flow([t], { spreadWindowMs: -1 })).toThrow(/spreadWindowMs/);
    expect(() => flow([t], { sweepMinPrints: 0 })).toThrow(/sweepMinPrints/);
  });

  it('rejects a negative open interest print', () => {
    const bad = trade('call', 500, onExpiryDay, 1, 10, '2026-03-20', { openInterest: -1 });
    expect(() => flow([bad])).toThrow(/openInterest/);
  });

  it('rank() rejects an unknown by-key, a negative limit, and NaN thresholds', () => {
    const f = flow([t]);
    expect(() => f.rank([], { by: 'bogus' as unknown as 'premium' })).toThrow(/by/);
    expect(() => f.rank([], { limit: -3 })).toThrow(/limit/);
    expect(() => f.rank([], { minPremium: Number.NaN })).toThrow(/minPremium/);
    expect(() => f.rank([], { minVolumeOpenInterestRatio: Number.NaN })).toThrow(
      /minVolumeOpenInterestRatio/,
    );
    expect(() => f.rank([], { minPremium: -1 })).toThrow(/minPremium/);
    expect(() => f.rank([], { minVolumeOpenInterestRatio: -0.5 })).toThrow(
      /minVolumeOpenInterestRatio/,
    );
  });
});
