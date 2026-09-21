/**
 * Tests for the cross-expiry term-structure metrics (§10.2) and the event-vol / variance-premium
 * additions (§10.2/§10.3): ATM term structure, forward vol, calendar & forward skew, wing steepness,
 * realized-vs-implied spread, variance risk premium, event decomposition, and de-earned vol.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import {
  ArbitrageError,
  type OptionQuote,
  type OptionType,
  isQuantError,
  optionExpiryToMs,
  yearFraction,
} from '@totalfinance/core';
import {
  type SVIParameters,
  atmTermStructure,
  calendarSkew,
  eventStrippedVolatility,
  eventVolatilityDecomposition,
  forwardSkew,
  forwardVolatility,
  realizedImpliedSpread,
  skew,
  varianceRiskPremium,
  volatilitySurface,
} from '@totalfinance/volatility';
import { sviVolatility } from '@totalfinance/volatility/svi';

const asOf = Date.UTC(2026, 0, 1);
const spot = 100;
const rate = 0.03;
const E0 = '2026-04-02';
const E1 = '2026-07-02';
const STRIKES = [80, 85, 90, 95, 100, 105, 110, 115, 120];
const tOf = (e: string): number => yearFraction(asOf, optionExpiryToMs(e), 'ACT/365F');
const fwdOf = (timeToExpiryYears: number): number => spot * Math.exp(rate * timeToExpiryYears);

function quote(
  type: OptionType,
  strike: number,
  expiry: string,
  impliedVolatility: number,
): OptionQuote {
  return {
    contract: {
      underlying: 'X',
      type,
      style: 'european',
      strike,
      expiry,
      ...resolvedExpiry(expiry),
    },
    timestampMs: asOf,
    impliedVolatility,
    underlyingPrice: spot,
  };
}

// total variance grows with maturity (calendar-safe); near-dated smile is steeper
const P: Record<string, SVIParameters> = {
  [E0]: { a: 0.008, b: 0.09, rho: -0.6, m: 0, sigma: 0.06 },
  [E1]: { a: 0.02, b: 0.1, rho: -0.4, m: 0, sigma: 0.1 },
};
const chain = (): OptionQuote[] => {
  const rows: OptionQuote[] = [];
  for (const e of [E0, E1]) {
    const t = tOf(e);
    const F = fwdOf(t);
    for (const k of STRIKES)
      rows.push(quote('call', k, e, sviVolatility(P[e]!, Math.log(k / F), t)));
  }
  return rows;
};

describe('ATM term structure & forward vol', () => {
  it('reports ATM IV per expiry with monotone total variance', () => {
    const ts = atmTermStructure(
      volatilitySurface({
        quotes: chain(),
        market: { riskFreeRate: rate, asOf, spot },
        config: { model: 'svi' },
      }),
    );
    expect(ts.points).toHaveLength(2);
    expect(ts.points[0]!.timeToExpiryYears).toBeLessThan(ts.points[1]!.timeToExpiryYears);
    expect(ts.calendarMonotone).toBe(true); // total variance non-decreasing
  });

  it('forward vol sits between the two ATM volatilities and squares-adds correctly', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
    const fv = forwardVolatility(surf, E0, E1);
    const t0 = tOf(E0);
    const t1 = tOf(E1);
    const w0 = surf.impliedVolatility(fwdOf(t0), E0) ** 2 * t0;
    const w1 = surf.impliedVolatility(fwdOf(t1), E1) ** 2 * t1;
    expect(fv).toBeCloseTo(Math.sqrt((w1 - w0) / (t1 - t0)), 10);
  });

  it('calendar skew is the change in ATM skew slope across maturities', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
    const cs = calendarSkew(surf, E0, E1);
    expect(Number.isFinite(cs)).toBe(true);
  });

  // Review finding: a DETECTED calendar arbitrage was thrown as InputError input.out_of_range —
  // but the input arguments were fine; it is the market data that violates no-arbitrage.
  it('a negative forward variance throws ArbitrageError (vol.calendar_arbitrage), not InputError', () => {
    // flat 40% near vs flat 20% far ⇒ far ATM total variance < near ATM total variance
    const rows: OptionQuote[] = [];
    for (const k of STRIKES) rows.push(quote('call', k, E0, 0.4));
    for (const k of STRIKES) rows.push(quote('call', k, E1, 0.2));
    const surf = volatilitySurface({ quotes: rows, market: { riskFreeRate: rate, asOf, spot } });
    let caught: unknown;
    try {
      forwardVolatility(surf, E0, E1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ArbitrageError);
    expect(isQuantError(caught, 'volatility.calendar_arbitrage')).toBe(true);
    expect((caught as Error).message).toMatch(/calendar arbitrage/);
  });
});

describe('skew wing steepness', () => {
  it('is the extra IV in the 10Δ wings over the 25Δ wings', () => {
    const res = skew({
      quotes: chain(),
      market: { spot, riskFreeRate: rate, asOf },
      config: { expiry: E0, model: 'svi' },
    });
    const m = res.value;
    expect(m.wingSteepness).toBeCloseTo(
      m.put10DeltaImpliedVolatility -
        m.put25DeltaImpliedVolatility +
        (m.call10DeltaImpliedVolatility - m.call25DeltaImpliedVolatility),
      12,
    );
    expect(m.wingSteepness).toBeGreaterThan(0); // convex smile ⇒ wings lift above the 25Δ points
  });
});

describe('realized-vs-implied & variance risk premium', () => {
  it('spread and premium are positive when implied exceeds realized', () => {
    expect(
      realizedImpliedSpread({ impliedVolatility: 0.25, realizedVolatility: 0.18 }),
    ).toBeCloseTo(0.07, 12);
    expect(varianceRiskPremium({ impliedVolatility: 0.25, realizedVolatility: 0.18 })).toBeCloseTo(
      0.25 ** 2 - 0.18 ** 2,
      12,
    );
  });

  it('rejects a negative realized vol', () => {
    expect(() => varianceRiskPremium({ impliedVolatility: 0.2, realizedVolatility: -0.1 })).toThrow(
      /realizedVolatility/,
    );
  });
});

describe('event vol decomposition & de-earned vol', () => {
  it('splits an event-spanning ATM vol into base variance and an event jump', () => {
    // base 30% vol over 0.1y, plus a 4% event move
    const t = 0.1;
    const baseVolatility = 0.3;
    const eventMove = 0.04;
    const totalVar = baseVolatility * baseVolatility * t + eventMove * eventMove;
    const atmVolatility = Math.sqrt(totalVar / t);
    const d = eventVolatilityDecomposition({ atmVolatility, timeToExpiryYears: t, baseVolatility });
    expect(d.eventMove).toBeCloseTo(eventMove, 10);
    expect(d.eventVariance).toBeCloseTo(eventMove * eventMove, 10);
  });

  it('de-earned vol strips the event jump back out to recover the base vol', () => {
    const t = 0.1;
    const baseVolatility = 0.3;
    const eventMove = 0.04;
    const atmVolatility = Math.sqrt(
      (baseVolatility * baseVolatility * t + eventMove * eventMove) / t,
    );
    expect(eventStrippedVolatility({ atmVolatility, timeToExpiryYears: t, eventMove })).toBeCloseTo(
      baseVolatility,
      10,
    );
    expect(
      eventStrippedVolatility.explain({ atmVolatility, timeToExpiryYears: t, eventMove }).value,
    ).toBeCloseTo(baseVolatility, 10);
  });

  it('clamps a non-existent event to zero rather than returning NaN', () => {
    const d = eventVolatilityDecomposition({
      atmVolatility: 0.2,
      timeToExpiryYears: 0.1,
      baseVolatility: 0.25,
    }); // base > total
    expect(d.eventVariance).toBe(0);
    expect(d.eventMove).toBe(0);
  });
});

describe('forwardSkew options hardening (deep-sweep boundary)', () => {
  it('rejects a null options bag instead of dying on the first option read', () => {
    // `null` slips past the `= {}` default parameter (only `undefined` triggers it).
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
    expect(() => forwardSkew(surf, E0, E1, null as never)).toThrow(
      /forwardSkew: options must be an object/,
    );
    // A valid call still works with and without the bag.
    expect(Number.isFinite(forwardSkew(surf, E0, E1))).toBe(true);
    expect(Number.isFinite(forwardSkew(surf, E0, E1, { step: 0.05 }))).toBe(true);
  });
});

// ───────────────── H21/H22/H23 — the term-structure facades explain their arithmetic ─────────────────

describe('term-structure explain facades (ledger H21/H22/H23)', () => {
  const surf = (): ReturnType<typeof volatilitySurface> =>
    volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });

  it('H21: forwardVolatility.explain returns the same scalar and reconstructs it from the variances', () => {
    const s = surf();
    const plain = forwardVolatility(s, E0, E1);
    const explained = forwardVolatility.explain(s, E0, E1);
    expect(explained.value).toBeCloseTo(plain, 15);
    const d = explained.diagnostics.decomposition!;
    // forwardVariance = (farTotalVariance − nearTotalVariance) / timeGapYears, value = √forwardVariance
    expect(d['forwardVariance']!).toBeCloseTo(
      (d['farTotalVariance']! - d['nearTotalVariance']!) / d['timeGapYears']!,
      12,
    );
    expect(explained.value).toBeCloseTo(Math.sqrt(d['forwardVariance']!), 12);
    expect(d['timeGapYears']!).toBeCloseTo(tOf(E1) - tOf(E0), 10);
    // assumptions disclose the RESOLVED pair (ascending in time) with its year fractions
    expect(explained.assumptions.nearExpiry).toBe(E0);
    expect(explained.assumptions.farExpiry).toBe(E1);
    expect(explained.assumptions.nearTimeToExpiryYears).toBeCloseTo(tOf(E0), 10);
    expect(explained.assumptions.farTimeToExpiryYears).toBeCloseTo(tOf(E1), 10);
    expect(explained.assumptions.conventionsVersion.length).toBeGreaterThan(0);
    expect(explained.diagnostics.warnings).toEqual([]);
    // a reversed argument order resolves to the SAME near/far pair and the same value
    const reversed = forwardVolatility.explain(s, E1, E0);
    expect(reversed.assumptions.nearExpiry).toBe(E0);
    expect(reversed.assumptions.farExpiry).toBe(E1);
    expect(reversed.value).toBeCloseTo(plain, 15);
  });

  it('H21: the explain path throws the SAME calendar-arbitrage error as the plain call', () => {
    // flat 40% near vs flat 20% far ⇒ far ATM total variance < near ATM total variance
    const rows: OptionQuote[] = [];
    for (const k of STRIKES) rows.push(quote('call', k, E0, 0.4));
    for (const k of STRIKES) rows.push(quote('call', k, E1, 0.2));
    const inverted = volatilitySurface({
      quotes: rows,
      market: { riskFreeRate: rate, asOf, spot },
    });
    expect(() => forwardVolatility.explain(inverted, E0, E1)).toThrow(ArbitrageError);
    expect(() => forwardSkew.explain(inverted, E0, E1)).toThrow(ArbitrageError);
  });

  it('H22: calendarSkew.explain discloses both ATM slopes and the canonical 0.05 step', () => {
    const s = surf();
    const plain = calendarSkew(s, E0, E1);
    const explained = calendarSkew.explain(s, E0, E1);
    expect(explained.value).toBeCloseTo(plain, 15);
    const d = explained.diagnostics.decomposition!;
    // value = farSkewSlope − nearSkewSlope, and both slopes are real finite disclosures
    expect(explained.value).toBeCloseTo(d['farSkewSlope']! - d['nearSkewSlope']!, 12);
    expect(Number.isFinite(d['nearSkewSlope']!)).toBe(true);
    expect(Number.isFinite(d['farSkewSlope']!)).toBe(true);
    expect(explained.assumptions.logMoneynessStep).toBe(0.05);
    expect(explained.assumptions.nearExpiry).toBe(E0);
    expect(explained.assumptions.farExpiry).toBe(E1);
    expect(explained.assumptions.nearTimeToExpiryYears).toBeCloseTo(tOf(E0), 10);
    expect(explained.assumptions.farTimeToExpiryYears).toBeCloseTo(tOf(E1), 10);
    expect(explained.diagnostics.warnings).toEqual([]);
  });

  it('H23: forwardSkew.explain discloses the applied step and BOTH total-variance legs', () => {
    const s = surf();
    const step = 0.04;
    const plain = forwardSkew(s, E0, E1, { step });
    const explained = forwardSkew.explain(s, E0, E1, { step });
    expect(explained.value).toBeCloseTo(plain, 15);
    expect(explained.assumptions.step).toBe(step);
    const d = explained.diagnostics.decomposition!;
    // Each leg: forwardVariance = (farTotalVariance − nearTotalVariance) / timeGapYears, σ_fwd = √it.
    for (const leg of ['Up', 'Down'] as const) {
      expect(d[`forwardVariance${leg}`]!).toBeCloseTo(
        (d[`farTotalVariance${leg}`]! - d[`nearTotalVariance${leg}`]!) / d['timeGapYears']!,
        12,
      );
      expect(d[`forwardVolatility${leg}`]!).toBeCloseTo(Math.sqrt(d[`forwardVariance${leg}`]!), 12);
    }
    // The scalar is the central difference of the two disclosed legs.
    expect(explained.value).toBeCloseTo(
      (d['forwardVolatilityUp']! - d['forwardVolatilityDown']!) / (2 * step),
      12,
    );
    // The default step is echoed too, and matches the plain default-step value.
    const defaulted = forwardSkew.explain(s, E0, E1);
    expect(defaulted.assumptions.step).toBe(0.05);
    expect(defaulted.value).toBeCloseTo(forwardSkew(s, E0, E1), 15);
  });
});
