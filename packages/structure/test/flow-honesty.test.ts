/**
 * WS2.12 (flow envelope + null missing-value policy) and WS2.13 (sweep/spread heuristic upgrades).
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionTrade, OptionType } from '@totalfinance/core';
import { flow } from '@totalfinance/structure';

const expiry = '2026-03-20';

function mk(
  type: OptionType,
  strike: number,
  ts: number,
  price: number,
  size: number,
  bid: number,
  ask: number,
  extra: { exchange?: string; openInterest?: number } = {},
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
    bid,
    ask,
    ...(extra.exchange !== undefined ? { exchange: extra.exchange } : {}),
    ...(extra.openInterest !== undefined ? { openInterest: extra.openInterest } : {}),
  };
}

describe('WS2.12 — locked market carries no directional signal', () => {
  it('a print at a locked (bid == ask == price) market is unknown, not buy', () => {
    const f = flow([mk('call', 100, 1000, 5.0, 1, 5.0, 5.0)]);
    expect(f.trades[0]!.side).toBe('unknown');
  });

  it('a print at a crossed (bid > ask) market is unknown', () => {
    const f = flow([mk('call', 100, 1000, 5.0, 1, 5.1, 5.0)]);
    expect(f.trades[0]!.side).toBe('unknown');
  });
});

describe('WS2.12 — flow envelope + JSON-safe null policy', () => {
  it('echoes its assumptions and carries a diagnostics.warnings channel', () => {
    const f = flow([mk('call', 100, 1000, 5.0, 1, 4.8, 5.0)]);
    // The echoed rule names what actually runs: the quote rule with midpoint ⇒ unknown. It is NOT
    // Lee–Ready (no tick test), and the label must not claim to be.
    expect(f.assumptions.nbboRule).toBe('quote-rule-midpoint-unknown');
    expect(f.assumptions.sweepWindowMs).toBe(500);
    expect(f.assumptions.venueVerifiedSweeps).toBe(false);
    expect(Array.isArray(f.diagnostics.warnings)).toBe(true);
    // no exchange data ⇒ a not-venue-verified info warning + a model.limitation caveat
    expect(f.diagnostics.warnings.some((w) => w.code === 'flow.sweeps_not_venue_verified')).toBe(
      true,
    );
    expect(
      f.diagnostics.warnings.some(
        (w) => w.code === 'model.limitation' && /venue-verified/i.test(w.message),
      ),
    ).toBe(true);
  });

  it('a put-only summary reports null (not NaN) put/call ratios, and JSON round-trips explicit nulls', () => {
    const s = flow([mk('put', 100, 1000, 3.0, 5, 2.9, 3.1)]).callPutPremium();
    expect(s.putCallVolumeRatio).toBeNull();
    expect(s.putCallPremiumRatio).toBeNull();
    const rt = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(rt.putCallVolumeRatio).toBeNull(); // explicit null key, not omitted
    expect('putCallVolumeRatio' in rt).toBe(true);
  });

  it('a group without known OI reports volumeOpenInterestRatio: null (JSON-safe)', () => {
    const groups = flow([mk('call', 100, 1000, 5.0, 3, 4.8, 5.0)]).groupBy([
      'underlying',
      'expiry',
      'strike',
      'type',
    ]);
    const rt = JSON.parse(JSON.stringify(groups)) as typeof groups;
    expect(rt[0]!.volumeOpenInterestRatio).toBeNull();
  });
});

describe('WS2.13 — sweep and spread heuristics', () => {
  it('a single-venue iceberg (all one exchange) is NOT a sweep, but ≥2 venues is', () => {
    const oneVenue = flow([
      mk('call', 105, 1000, 2.0, 10, 1.9, 2.0, { exchange: 'CBOE' }),
      mk('call', 105, 1100, 2.0, 15, 1.9, 2.0, { exchange: 'CBOE' }),
      mk('call', 105, 1200, 2.0, 20, 1.9, 2.0, { exchange: 'CBOE' }),
    ]);
    expect(oneVenue.sweeps).toHaveLength(0);
    expect(oneVenue.assumptions.venueVerifiedSweeps).toBe(true);

    const multiVenue = flow([
      mk('call', 105, 1000, 2.0, 10, 1.9, 2.0, { exchange: 'CBOE' }),
      mk('call', 105, 1100, 2.0, 15, 1.9, 2.0, { exchange: 'ISE' }),
      mk('call', 105, 1200, 2.0, 20, 1.9, 2.0, { exchange: 'PHLX' }),
    ]);
    expect(multiVenue.sweeps).toHaveLength(1);
  });

  it('a 500-lot vs 3-lot pair is NOT glued into a spread; compatible sizes are', () => {
    // wildly mismatched leg sizes within the window ⇒ not a spread
    const mismatched = flow([
      mk('call', 100, 1000, 5.0, 500, 4.9, 5.1),
      mk('call', 110, 1010, 2.0, 3, 1.9, 2.1),
    ]);
    expect(mismatched.spreads).toHaveLength(0);

    // compatible leg sizes (ratio within [1/4, 4]) in the same window ⇒ a spread
    const balanced = flow([
      mk('call', 100, 1000, 5.0, 10, 4.9, 5.1),
      mk('call', 110, 1010, 2.0, 10, 1.9, 2.1),
    ]);
    expect(balanced.spreads).toHaveLength(1);
  });
});
