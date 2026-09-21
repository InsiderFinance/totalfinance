/**
 * Tests for the multi-expiry strategies (calendars, diagonals, double diagonal). Verifies leg
 * composition (short near, long far — each with its own expiry) and that Position.value() prices each
 * leg at its own time-to-expiry, so a calendar valued AT the near expiry keeps the long leg's time
 * value (a positive net worth near the strike) rather than collapsing both legs to intrinsic.
 */

import { describe, expect, it } from 'vitest';
import { strategy } from '@totalfinance/strategy';
import type { Leg } from '@totalfinance/strategy';

const nearExpiry = '2026-02-20';
const farExpiry = '2026-05-15';
const sig = (legs: readonly Leg[]): Array<[string, number, number, string | undefined]> =>
  legs.map(
    (l) => [l.kind, l.strike, l.quantity, l.expiry] as [string, number, number, string | undefined],
  );

describe('calendar spreads', () => {
  it('call calendar = short near call + long far call at the same strike', () => {
    const pos = strategy.calendarCallSpread({
      strike: 100,
      nearExpiry,
      shortPremium: 3,
      farExpiry,
      longPremium: 5,
    });
    expect(sig(pos.legs)).toEqual([
      ['call', 100, -1, nearExpiry],
      ['call', 100, 1, farExpiry],
    ]);
    // netDebit() is expiry-independent (pure cash flow), so it stays available; the single-expiration
    // metrics()/payoff() do not (WS2.5) — they would answer a meaningless single-terminal question.
    expect(pos.netDebit()).toBeCloseTo((5 - 3) * 100, 9); // net debit paid
  });

  it('a call calendar is worth more than its debit near the strike at the near expiry', () => {
    // Priced right at the near expiry: the short leg is worthless at-the-money while the long leg still
    // carries ~3 months of time value ⇒ the spread's mark-to-market P&L is a peak near the strike.
    const pos = strategy.calendarCallSpread({
      strike: 100,
      nearExpiry,
      shortPremium: 3,
      farExpiry,
      longPremium: 5,
    });
    const atStrike = pos.value({
      spot: 100,
      asOf: Date.parse(`${nearExpiry}T20:00:00Z`), // ~16:00 ET on the near-expiry day
      expiry: farExpiry, // position-level expiry (used by legs without their own)
      volatility: 0.25,
      riskFreeRate: 0.03,
    });
    const farOtm = pos.value({
      spot: 70, // far from the strike ⇒ both legs ~worthless ⇒ near the full debit loss
      asOf: Date.parse(`${nearExpiry}T20:00:00Z`),
      expiry: farExpiry,
      volatility: 0.25,
      riskFreeRate: 0.03,
    });
    // The long far leg retains substantial time value at the strike, so the calendar is profitable
    // there, and far worse deep OTM — the classic calendar tent.
    expect(atStrike.value).toBeGreaterThan(farOtm.value);
    expect(atStrike.value).toBeGreaterThan(0);
  });
});

describe('diagonals and double diagonal', () => {
  it('diagonal call spread = short near (higher) + long far (lower), each its own expiry', () => {
    const pos = strategy.diagonalCallSpread({
      shortStrike: 105,
      shortPremium: 2,
      nearExpiry,
      longStrike: 100,
      longPremium: 6,
      farExpiry,
    });
    expect(sig(pos.legs)).toEqual([
      ['call', 105, -1, nearExpiry],
      ['call', 100, 1, farExpiry],
    ]);
  });

  it('double diagonal = short near strangle + long far strangle (4 legs, 2 expiries)', () => {
    const pos = strategy.doubleDiagonal({
      nearExpiry,
      farExpiry,
      call: { shortStrike: 105, shortPremium: 2, longStrike: 110, longPremium: 1.5 },
      put: { shortStrike: 95, shortPremium: 2, longStrike: 90, longPremium: 1.5 },
    });
    expect(sig(pos.legs)).toEqual([
      ['call', 110, 1, farExpiry],
      ['call', 105, -1, nearExpiry],
      ['put', 90, 1, farExpiry],
      ['put', 95, -1, nearExpiry],
    ]);
  });
});

describe('WS2.5 — multi-expiry positions refuse single-expiration analytics', () => {
  const calendar = (): ReturnType<typeof strategy.calendarCallSpread> =>
    strategy.calendarCallSpread({
      strike: 100,
      nearExpiry,
      shortPremium: 3,
      farExpiry,
      longPremium: 5,
    });

  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return undefined;
  };

  it('metrics/payoff/probability/monteCarloProbability throw with the multi-expiry code', () => {
    const pos = calendar();
    for (const call of [
      () => pos.metrics(),
      () => pos.payoff({ prices: { from: 80, to: 120, steps: 41 } }),
      () =>
        pos.probability({
          spot: 100,
          asOf: Date.parse('2026-01-01T00:00:00Z'),
          expiry: farExpiry,
          volatility: 0.25,
          riskFreeRate: 0.03,
        }),
      () =>
        pos.monteCarloProbability({
          spot: 100,
          asOf: Date.parse('2026-01-01T00:00:00Z'),
          expiry: farExpiry,
          volatility: 0.25,
          riskFreeRate: 0.03,
          seed: 1,
          paths: 1000,
        }),
    ]) {
      expect(call).toThrow(/multiple expiries|single-expiration/i);
      expect(codeOf(call)).toBe('strategy.multi_expiry_expiration_analytics');
    }
  });

  it('but value() still works (prices each leg at its own time-to-expiry)', () => {
    const pos = calendar();
    const markToMarket = pos.value({
      spot: 100,
      asOf: Date.parse(`${nearExpiry}T20:00:00Z`),
      expiry: farExpiry,
      volatility: 0.25,
      riskFreeRate: 0.03,
    });
    expect(Number.isFinite(markToMarket.value)).toBe(true);
  });

  it('a single-expiry position (no per-leg expiries) still computes metrics', () => {
    const single = strategy.longCall({ strike: 100, premium: 5 });
    expect(() => single.metrics()).not.toThrow();
  });

  it('value() needs NO expiry when every leg carries its own (fully multi-expiry)', () => {
    const pos = calendar();
    const markToMarket = pos.value({
      spot: 100,
      asOf: Date.parse('2026-01-15T21:00:00Z'),
      volatility: 0.25,
      riskFreeRate: 0.03,
    });
    expect(Number.isFinite(markToMarket.value)).toBe(true);
    // No position-level time-to-expiry is echoed: every leg priced at its OWN t, so a single
    // timeToExpiryYears would disclose an assumption that was never used.
    expect(markToMarket.assumptions.timeToExpiryYears).toBeUndefined();
  });

  it('a call-site expiry that contradicts the legs is refused — the position owns its horizon', () => {
    const pos = calendar();
    const base = {
      spot: 100,
      asOf: Date.parse('2026-01-15T21:00:00Z'),
      volatility: 0.25,
      riskFreeRate: 0.03,
    };
    expect(pos.value(base).assumptions.timeToExpiryYears).toBeUndefined();
    // It used to be silently ignored for pricing while being echoed in assumptions and used by
    // probability(); a contradiction is refused with the rebuild path instead.
    expect(() => pos.value({ ...base, expiry: '2031-12-19' })).toThrow(
      /option legs expire .* would price them at a horizon they do not have/,
    );
  });

  it('a single-expiry position still requires and echoes its expiry (unchanged behavior)', () => {
    const single = strategy.longCall({ strike: 100, premium: 5 });
    expect(() =>
      single.value({
        spot: 100,
        asOf: Date.parse('2026-01-15T21:00:00Z'),
        volatility: 0.25,
        riskFreeRate: 0.03,
      }),
    ).toThrow(/expiry/);
    const markToMarket = single.value({
      spot: 100,
      asOf: Date.parse('2026-01-15T21:00:00Z'),
      expiry: farExpiry,
      volatility: 0.25,
      riskFreeRate: 0.03,
    });
    expect(markToMarket.assumptions.timeToExpiryYears).toBeGreaterThan(0);
  });
});

describe('R4 — calendar/diagonal input validation (no silent degenerate structures)', () => {
  const good = { strike: 100, nearExpiry, shortPremium: 3, farExpiry, longPremium: 5 };

  it('a missing farExpiry throws a teaching error naming the full shape', () => {
    const { farExpiry: _omit, ...missing } = good;
    let caught: unknown;
    try {
      strategy.calendarCallSpread(missing as never);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toContain('strategy.calendarCallSpread');
    expect(msg).toContain('farExpiry');
    expect(msg).toContain('nearExpiry');
  });

  it('a bare `expiry` key is rejected with the per-side teaching (never silently ignored)', () => {
    for (const build of [
      () => strategy.calendarCallSpread({ ...good, expiry: '2026-03-20' } as never),
      () => strategy.calendarPutSpread({ ...good, expiry: '2026-03-20' } as never),
      () =>
        strategy.diagonalCallSpread({
          shortStrike: 105,
          longStrike: 100,
          nearExpiry,
          farExpiry,
          expiry: '2026-03-20',
        } as never),
      () =>
        strategy.doubleDiagonal({
          nearExpiry,
          farExpiry,
          call: { shortStrike: 105, longStrike: 110 },
          put: { shortStrike: 95, longStrike: 90 },
          expiry: '2026-03-20',
        } as never),
    ]) {
      expect(build).toThrow(/nearExpiry\/farExpiry, not expiry/);
    }
  });

  it('diagonals validate their per-side slots (missing nearExpiry throws, teaches shape)', () => {
    expect(() =>
      strategy.diagonalPutSpread({ shortStrike: 100, longStrike: 110, farExpiry } as never),
    ).toThrow(/nearExpiry/);
  });

  it('doubleDiagonal validates the nested call/put sides', () => {
    expect(() =>
      strategy.doubleDiagonal({
        nearExpiry,
        farExpiry,
        call: { shortStrike: 105 }, // missing longStrike
        put: { shortStrike: 95, longStrike: 90 },
      } as never),
    ).toThrow(/longStrike/);
  });

  it('nearExpiry must be strictly before farExpiry (a same/inverted-expiry "calendar" is degenerate)', () => {
    expect(() =>
      strategy.calendarCallSpread({ ...good, nearExpiry: farExpiry, farExpiry }),
    ).toThrow(/nearExpiry must be strictly before farExpiry/);
    expect(() =>
      strategy.calendarCallSpread({ ...good, nearExpiry: farExpiry, farExpiry: nearExpiry }),
    ).toThrow(/nearExpiry must be strictly before farExpiry/);
  });
});
