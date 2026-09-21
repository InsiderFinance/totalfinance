/**
 * WS4.5 — the per-tick fast path (`atSpot`) and the `byStrike` call/put GEX/OI split.
 *
 * `atSpot(spot)` is a fixed-IV re-evaluation of net GEX/DEX at a new spot (the intraday dashboard
 * path); at the ORIGINAL spot it must reproduce the base aggregate exactly. `byStrike(['gex'])` rows
 * gain the `callGex`/`putGex`/`callOpenInterest`/`putOpenInterest` split (the canonical call-up/put-down chart) that sums
 * back to the net — but ONLY when `'gex'` is requested (mirrors the WS2.4 metric narrowing).
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionQuote, OptionType } from '@totalfinance/core';
import { exposure } from '@totalfinance/structure';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-02-20'; // ~0.14y
const spot = 100;
const rate = 0.03;

function q(type: OptionType, strike: number, oi: number, impliedVolatility = 0.2): OptionQuote {
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
    impliedVolatility,
    openInterest: oi,
    underlyingPrice: spot,
  };
}

// Typical chain: one call + one put per strike, heavier put OI below spot, heavier call OI above.
function chain(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (let k = 85; k <= 115; k += 5) {
    rows.push(q('call', k, 200 + Math.max(0, k - 100) * 10));
    rows.push(q('put', k, 200 + Math.max(0, 100 - k) * 10));
  }
  return rows;
}

describe('exposure per-tick fast path & call/put split (WS4.5)', () => {
  it('atSpot(originalSpot) reproduces the base aggregate {gex, dex} (frozen-IV recompute, same spot)', () => {
    // A convention that signs both sides negative, so DEX has real cancellation to reproduce exactly.
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'dealerShortGamma' },
    });
    const at = prof.atSpot(spot);
    // The per-tick path re-runs the identical gamma/delta pass at the same spot ⇒ bit-for-bit equal.
    expect(at.gex).toBeCloseTo(prof.aggregate.gex, 9);
    expect(at.dex).toBeCloseTo(prof.aggregate.dex, 9);
  });

  it('atSpot matches the base aggregate under a mixed-sign convention too', () => {
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'callsPositivePutsNegative' },
    });
    const at = prof.atSpot(spot);
    expect(at.gex).toBeCloseTo(prof.aggregate.gex, 9);
    expect(at.dex).toBeCloseTo(prof.aggregate.dex, 9);
  });

  it('atSpot(shiftedSpot) returns finite exposures that differ from the base (sanity)', () => {
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'dealerShortGamma' },
    });
    const shifted = prof.atSpot(spot * 1.05);
    expect(Number.isFinite(shifted.gex)).toBe(true);
    expect(Number.isFinite(shifted.dex)).toBe(true);
    expect(Math.abs(shifted.gex - prof.aggregate.gex)).toBeGreaterThan(1e-6);
    expect(Math.abs(shifted.dex - prof.aggregate.dex)).toBeGreaterThan(1e-6);
  });

  it("byStrike(['gex']) rows carry the call/put GEX + OI split that sums to the net", () => {
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'callsPositivePutsNegative' },
    });
    const rows = prof.byStrike(['gex']);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect('callGex' in row).toBe(true);
      expect('putGex' in row).toBe(true);
      expect('callOpenInterest' in row).toBe(true);
      expect('putOpenInterest' in row).toBe(true);
      // The split sums back to the net gex (call bars up + put bars down = net).
      expect(row.callGex + row.putGex).toBeCloseTo(row.gex, 9);
      // callOpenInterest + putOpenInterest === the total open interest at that strike.
      const oiAtStrike = prof.contracts
        .filter((c) => c.strike === row.strike)
        .reduce((s, c) => s + c.openInterest, 0);
      expect(row.callOpenInterest + row.putOpenInterest).toBe(oiAtStrike);
    }
  });

  it("byStrike(['dex']) rows have NO call/put split (runtime + compile-time)", () => {
    const prof = exposure({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { convention: 'callsPositivePutsNegative' },
    });
    const rows = prof.byStrike(['dex']);
    const row = rows[0]!;
    // The split appears ONLY when 'gex' is requested — absent here.
    expect('callGex' in row).toBe(false);
    expect('putGex' in row).toBe(false);
    expect('callOpenInterest' in row).toBe(false);
    expect('putOpenInterest' in row).toBe(false);
    // compile-time: the split keys are not part of StrikeRow<'dex'>
    // @ts-expect-error callGex is not a key of StrikeRow<'dex'>
    void row.callGex;
  });
});
