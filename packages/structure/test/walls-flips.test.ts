/**
 * WS1.1 (per-strike wall aggregation) + WS1.15 (nearest-spot gamma flip, gammaFlips list).
 * Test-first: each assertion fails on the old per-contract wall scan / first-flip-from-bottom scan.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionQuote, OptionType } from '@totalfinance/core';
import { exposure } from '@totalfinance/structure';

const rate = 0.03;
const wSpot = 101;
const wAsOf = Date.UTC(2026, 0, 1, 10); // 10:00 UTC on 2026-01-01
const later = ['2026-01-16', '2026-02-20', '2026-03-20', '2026-04-17', '2026-05-15'];

function qw(type: OptionType, strike: number, oi: number, exp: string, uPx = wSpot): OptionQuote {
  return {
    contract: {
      underlying: 'X',
      type,
      style: 'european',
      strike,
      expiry: exp,
      multiplier: 100,
      ...resolvedExpiry(exp),
    },
    timestampMs: wAsOf,
    impliedVolatility: 0.2,
    openInterest: oi,
    underlyingPrice: uPx,
  };
}

describe('walls & gamma flips aggregate correctly (WS1.1 / WS1.15)', () => {
  it('callWall is the strike with the most call OI SUMMED across expiries, not one fat contract', () => {
    const rows: OptionQuote[] = [
      ...later.map((e) => qw('call', 100, 4000, e)), // 20,000 OI split over 5 expiries
      qw('call', 105, 8000, later[1]!), // one fat 8,000-OI single-expiry contract
    ];
    const lv = exposure({
      quotes: rows,
      market: {
        spot: wSpot,
        riskFreeRate: rate,
        asOf: wAsOf,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    }).levels();
    expect(lv.callWall).toBe(100); // per-strike sum (20k) wins; per-contract scan would pick 105
  });

  it('putWall sums put OI per strike across expiries the same way', () => {
    const rows: OptionQuote[] = [
      ...later.map((e) => qw('put', 100, 4000, e)), // 20,000 OI split over 5 expiries
      qw('put', 95, 8000, later[1]!),
    ];
    const lv = exposure({
      quotes: rows,
      market: {
        spot: wSpot,
        riskFreeRate: rate,
        asOf: wAsOf,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    }).levels();
    expect(lv.putWall).toBe(100);
  });

  it('a single-expiry chain is unaffected — the fattest contract legitimately wins (regression)', () => {
    const rows: OptionQuote[] = [
      qw('call', 100, 4000, later[0]!),
      qw('call', 105, 8000, later[0]!),
    ];
    const lv = exposure({
      quotes: rows,
      market: {
        spot: wSpot,
        riskFreeRate: rate,
        asOf: wAsOf,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    }).levels();
    expect(lv.callWall).toBe(105);
  });

  it('zeroDaysToExpiryWall sums call+put net GEX per strike, not the single fattest contract', () => {
    const daysToExpiry = '2026-01-01'; // same calendar day as wAsOf ⇒ 0DTE bucket
    const rows: OptionQuote[] = [
      qw('call', 100, 4000, daysToExpiry), // strike 100: single 4,000-OI contract
      qw('call', 102, 3000, daysToExpiry), // strike 102: 3,000 call ...
      qw('put', 102, 3000, daysToExpiry), //  ... + 3,000 put ⇒ 6,000 summed (same-sign convention)
    ];
    const lv = exposure({
      quotes: rows,
      market: {
        spot: wSpot,
        riskFreeRate: rate,
        asOf: wAsOf,
      },
      config: {
        convention: { calls: 1, puts: 1 }, // both add ⇒ the 102 strike's summed wall wins
      },
    }).levels();
    expect(lv.zeroDaysToExpiryWall).toBe(102);
  });

  it('zeroGamma is the gamma flip NEAREST spot, and gammaFlips lists them all', () => {
    // Positive-gamma bump centered BELOW spot (calls @94) between two put walls (@82, @108) ⇒ two
    // flips: a lower one (far from spot) and an upper one (nearest spot).
    const rows: OptionQuote[] = [
      qw('put', 82, 6000, later[0]!),
      qw('call', 94, 7000, later[0]!),
      qw('put', 108, 6000, later[0]!),
    ];
    const lv = exposure({
      quotes: rows,
      market: {
        spot: 100,
        riskFreeRate: rate,
        asOf: wAsOf,
      },
      config: {
        convention: 'callsPositivePutsNegative',
      },
    }).levels();
    expect(lv.gammaFlips.length).toBeGreaterThanOrEqual(2);
    const nearest = lv.gammaFlips.reduce((b, f) => (Math.abs(f - 100) < Math.abs(b - 100) ? f : b));
    expect(lv.zeroGamma).toBeCloseTo(nearest, 6);
    // The old scan returned the lowest flip; the fix returns a DIFFERENT (nearer) level.
    expect(lv.zeroGamma).not.toBeCloseTo(Math.min(...lv.gammaFlips), 6);
  });
});
