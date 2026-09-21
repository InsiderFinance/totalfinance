/**
 * 2026-08-23 review P0 — count/resource safety, library-wide wave.
 *
 * `Number.isInteger(1e308)` is `true`, and above 2^53 integer arithmetic goes inexact — so a count
 * validated with `Number.isInteger` was accepted while no longer meaning the number typed. The
 * structure counts are data-bounded (print thresholds, rank limits) or already capped (the spot
 * grid's 10,000 steps), so the discipline here is safe-integer exactness plus locking the cap.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionQuote, OptionTrade, OptionType } from '@totalfinance/core';
import { isQuantError } from '@totalfinance/core';
import { exposure, flow } from '@totalfinance/structure';

/** Capture the thrown value (the guards must throw typed QuantErrors, never return). */
function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const UNSAFE_COUNTS = [2 ** 53, 1e308] as const;
const EXPIRY = '2026-03-20';
const AS_OF = Date.UTC(2026, 0, 1);

function trade(strike: number, ts: number, price: number, size: number): OptionTrade {
  return {
    contract: {
      underlying: 'SPY',
      type: 'call',
      style: 'european',
      strike,
      expiry: EXPIRY,
      multiplier: 100,
      ...resolvedExpiry(EXPIRY),
    },
    timestampMs: ts,
    price,
    size,
    bid: price - 0.1,
    ask: price,
  };
}

const TRADES = [trade(100, 1000, 5.0, 10), trade(100, 1100, 5.0, 15), trade(105, 1200, 2.0, 20)];

function quote(type: OptionType, strike: number, oi: number): OptionQuote {
  return {
    contract: {
      underlying: 'X',
      type,
      style: 'european',
      strike,
      expiry: '2026-02-20',
      multiplier: 100,
      ...resolvedExpiry('2026-02-20'),
    },
    timestampMs: AS_OF,
    impliedVolatility: 0.2,
    openInterest: oi,
    underlyingPrice: 100,
  };
}

describe('flow — sweepMinPrints and rank limit are safe integers', () => {
  it('flow refuses a 2^53 / fractional sweepMinPrints typed and accepts the realistic default', () => {
    for (const bad of [...UNSAFE_COUNTS, 2.5]) {
      const caught = catching(() => flow(TRADES, { sweepMinPrints: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `sweepMinPrints ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('sweepMinPrints');
    }
    expect(flow(TRADES, { sweepMinPrints: 3 }).trades).toHaveLength(3);
  });

  it('rank accepts data-bounded safe limits and refuses negative, fractional, or inexact limits', () => {
    const f = flow(TRADES);
    for (const bad of [...UNSAFE_COUNTS, 1.5, -1]) {
      const caught = catching(() => f.rank([], { limit: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `limit ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('limit');
    }
    const groups = f.groupBy(['underlying']);
    expect(f.rank(groups, { limit: 0 })).toEqual([]);
    expect(f.rank(groups, { limit: 2 ** 32 })).toHaveLength(groups.length);
    expect(f.rank(groups, { limit: 1_000_001 })).toHaveLength(groups.length);
    expect(f.rank(groups, { limit: 1 })).toHaveLength(1);
  });
});

describe('exposure.scenarioMap — the spot grid steps stay capped at 10,000 AND are safe integers', () => {
  const prof = exposure({
    quotes: [quote('call', 100, 1000), quote('put', 95, 800)],
    market: { riskFreeRate: 0.03, asOf: AS_OF, spot: 100 },
    config: { convention: 'callsPositivePutsNegative' },
  });

  it('refuses 2^53 / 1e308 / cap + 1 / fractional steps typed naming the bound, and a realistic grid runs', () => {
    for (const bad of [...UNSAFE_COUNTS, 10_001, 11.5]) {
      const caught = catching(() => prof.scenarioMap({ spot: { from: 90, to: 110, steps: bad } }));
      expect(isQuantError(caught, 'input.out_of_range'), `steps ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('steps');
    }
    const atCapPlusOne = catching(() =>
      prof.scenarioMap({ spot: { from: 90, to: 110, steps: 10_001 } }),
    );
    expect(String((atCapPlusOne as Error).message)).toContain('10000');
    const sm = prof.scenarioMap({ spot: { from: 90, to: 110, steps: 11 } });
    expect(sm.cells.length).toBeGreaterThan(0);
  });
});
