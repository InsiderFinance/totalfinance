import { resolvedExpiry, resolveAsOf } from '@totalfinance/core';
/**
 * VIX-style variance index + VRP term structure (`varianceIndex`, `varianceRiskPremiumTermStructure`). Verifies that a
 * flat-vol synthetic chain recovers ~that vol at every expiry and the index, that the index
 * interpolates between expiries and is monotone in horizonPeriods, that un-replicable expiries are dropped
 * with a disclosed warning, the VRP sign, single-expiry extrapolation disclosure, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { type OptionQuote, isQuantError, optionExpiryToMs, yearFraction } from '@totalfinance/core';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { varianceIndex, varianceRiskPremiumTermStructure } from '@totalfinance/volatility';

const ASOF = '2026-05-01T10:00:00-04:00'; // an intraday ET instant: day counts run on the market date
const RATE = 0.03;

/** A BSM-consistent chain: call+put mids across a wide strike strip at each (expiry, vol). */
function makeChain(
  spot: number,
  expiries: readonly { expiry: string; volatility: number }[],
): OptionQuote[] {
  const asOfMs = resolveAsOf(ASOF);
  const quotes: OptionQuote[] = [];
  for (const { expiry, volatility } of expiries) {
    const t = yearFraction(asOfMs, optionExpiryToMs(expiry), 'ACT/365F');
    if (t <= 0) continue;
    for (let k = Math.round(spot * 0.5); k <= spot * 1.5; k += 2.5) {
      for (const type of ['call', 'put'] as const) {
        quotes.push({
          contract: {
            underlying: 'XYZ',
            type,
            style: 'european',
            strike: k,
            expiry,
            ...resolvedExpiry(expiry),
          },
          timestampMs: asOfMs,
          mid: blackScholesPrice({
            type,
            spot,
            strike: k,
            timeToExpiryYears: t,
            riskFreeRate: RATE,
            dividendYield: 0,
            volatility,
          }),
          underlyingPrice: spot,
        });
      }
    }
  }
  return quotes;
}

describe('varianceIndex — recovers a flat vol', () => {
  it('a flat-0.20 chain gives ~0.20 fair vol at every expiry and a ~20 index', () => {
    const quotes = makeChain(100, [
      { expiry: '2026-05-21', volatility: 0.2 }, // 20d
      { expiry: '2026-06-20', volatility: 0.2 }, // 50d
    ]);
    const r = varianceIndex({ quotes, spot: 100, riskFreeRate: RATE, asOf: ASOF, horizonDays: 30 });
    expect(r.termStructure).toHaveLength(2);
    for (const e of r.termStructure) expect(e.fairVolatility).toBeCloseTo(0.2, 2); // within ~0.005
    expect(r.index).toBeCloseTo(20, 0); // ~20 VIX points
    expect(r.fairVolatility).toBeCloseTo(0.2, 2);
    // DDKZ on a finite discrete strip carries a small (~2-3%) positive variance bias — real VIX too.
    expect(r.variance).toBeCloseTo(0.04, 2);
    expect(r.interpolatedBetween).toEqual({ near: '2026-05-21', far: '2026-06-20' });
    expect(r.diagnostics.engine).toBe('variance-index');
  });
});

describe('varianceIndex — daysToExpiry is clean calendar days (bracketing fix)', () => {
  it('a listed 30-day expiry has daysToExpiry 30 and brackets a 30-day horizonPeriods (not extrapolated)', () => {
    const quotes = makeChain(100, [
      { expiry: '2026-05-31', volatility: 0.2 }, // exactly 30 calendar days from 2026-05-01
      { expiry: '2026-06-30', volatility: 0.22 }, // 60 days
    ]);
    const r = varianceIndex({ quotes, spot: 100, riskFreeRate: RATE, asOf: ASOF, horizonDays: 30 });
    expect(r.termStructure[0]!.daysToExpiry).toBe(30); // was 31 before the fix (16:00-ET inflation)
    expect(r.termStructure[1]!.daysToExpiry).toBe(60);
    // The 30-day expiry brackets the 30-day horizonPeriods → interpolated, not extrapolated.
    expect(r.interpolatedBetween).toEqual({ near: '2026-05-31', far: '2026-06-30' });
    expect(r.diagnostics.warnings.some((w) => w.message.includes('extrapolated'))).toBe(false);
  });
});

describe('varianceIndex — term structure & interpolation', () => {
  const quotes = makeChain(100, [
    { expiry: '2026-05-21', volatility: 0.2 }, // 20d
    { expiry: '2026-06-20', volatility: 0.3 }, // 50d
  ]);

  it('the 30d index sits between the near and far fair volatilities', () => {
    const r = varianceIndex({ quotes, spot: 100, riskFreeRate: RATE, asOf: ASOF, horizonDays: 30 });
    const near = r.termStructure[0]!.fairVolatility;
    const far = r.termStructure[1]!.fairVolatility;
    expect(near).toBeLessThan(r.fairVolatility);
    expect(r.fairVolatility).toBeLessThan(far);
  });

  it('the index rises with the horizonPeriods on an upward-sloping term structure', () => {
    const shorter = varianceIndex({
      quotes,
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
      horizonDays: 25,
    });
    const longer = varianceIndex({
      quotes,
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
      horizonDays: 45,
    });
    expect(longer.index).toBeGreaterThan(shorter.index);
  });
});

describe('varianceIndex — no fabricated points', () => {
  it('drops an un-replicable (too-sparse) expiry with a disclosed warning', () => {
    const good = makeChain(100, [
      { expiry: '2026-05-21', volatility: 0.2 },
      { expiry: '2026-06-20', volatility: 0.22 },
    ]);
    // A third expiry with only two strikes — < 3 usable OTM strikes, must be dropped, not guessed.
    const t = yearFraction(resolveAsOf(ASOF), optionExpiryToMs('2026-07-20'), 'ACT/365F');
    const sparse: OptionQuote[] = [95, 105].flatMap((k) =>
      (['call', 'put'] as const).map((type) => ({
        contract: {
          underlying: 'XYZ',
          type,
          style: 'european' as const,
          strike: k,
          expiry: '2026-07-20',
          ...resolvedExpiry('2026-07-20'),
        },
        timestampMs: resolveAsOf(ASOF),
        mid: blackScholesPrice({
          type,
          spot: 100,
          strike: k,
          timeToExpiryYears: t,
          riskFreeRate: RATE,
          dividendYield: 0,
          volatility: 0.2,
        }),
        underlyingPrice: 100,
      })),
    );
    const r = varianceIndex({
      quotes: [...good, ...sparse],
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
    });
    expect(r.termStructure.map((e) => e.expiry)).toEqual(['2026-05-21', '2026-06-20']);
    expect(r.diagnostics.warnings.some((w) => w.message.includes('2026-07-20'))).toBe(true);
  });

  it('single-expiry: the index is extrapolated and disclosed', () => {
    const quotes = makeChain(100, [{ expiry: '2026-06-20', volatility: 0.25 }]);
    const r = varianceIndex({ quotes, spot: 100, riskFreeRate: RATE, asOf: ASOF, horizonDays: 30 });
    expect(r.termStructure).toHaveLength(1);
    expect(r.interpolatedBetween).toBeUndefined();
    expect(r.fairVolatility).toBeCloseTo(0.25, 2); // nearest expiry's fair vol
    expect(r.diagnostics.warnings.some((w) => w.message.includes('extrapolated'))).toBe(true);
  });
});

describe('varianceRiskPremiumTermStructure — implied vs realized', () => {
  const quotes = makeChain(100, [
    { expiry: '2026-05-21', volatility: 0.25 },
    { expiry: '2026-06-20', volatility: 0.25 },
  ]);

  it('a scalar realized below implied gives a positive VRP and vol spread', () => {
    const r = varianceRiskPremiumTermStructure({
      quotes,
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
      realizedVolatility: 0.18,
    });
    expect(r.points).toHaveLength(2);
    for (const p of r.points) {
      expect(p.varianceRiskPremium).toBeGreaterThan(0); // impliedVolatility² − rv² > 0
      expect(p.volatilitySpread).toBeCloseTo(p.fairVolatility - 0.18, 10);
      expect(p.realizedVolatility).toBe(0.18);
    }
    expect(r.indexVarianceRiskPremium).toBeGreaterThan(0);
  });

  it('realized above implied flips the sign', () => {
    const r = varianceRiskPremiumTermStructure({
      quotes,
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
      realizedVolatility: 0.4,
    });
    expect(r.indexVarianceRiskPremium).toBeLessThan(0);
    for (const p of r.points) expect(p.varianceRiskPremium).toBeLessThan(0);
  });

  it('accepts a per-expiry realized-vol record', () => {
    const r = varianceRiskPremiumTermStructure({
      quotes,
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
      realizedVolatility: { '2026-05-21': 0.2, '2026-06-20': 0.3 },
    });
    expect(r.points.find((p) => p.expiry === '2026-05-21')!.realizedVolatility).toBe(0.2);
    expect(r.points.find((p) => p.expiry === '2026-06-20')!.realizedVolatility).toBe(0.3);
  });
});

describe('varianceIndex — envelope & guards', () => {
  it('throws typed errors on garbage, an unusable chain, and a bad horizonPeriods', () => {
    expect(() => varianceIndex(undefined as never)).toThrowError();
    // A chain with no replicable expiry (calls only → no parity forward).
    const callsOnly = makeChain(100, [{ expiry: '2026-06-20', volatility: 0.2 }]).filter(
      (q) => q.contract.type === 'call',
    );
    try {
      varianceIndex({ quotes: callsOnly, spot: 100, riskFreeRate: RATE, asOf: ASOF });
      expect.unreachable('a chain with no bracketing forward should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
    const quotes = makeChain(100, [{ expiry: '2026-06-20', volatility: 0.2 }]);
    expect(() =>
      varianceIndex({ quotes, spot: 100, riskFreeRate: RATE, asOf: ASOF, horizonDays: 0 }),
    ).toThrowError();
    expect(() =>
      varianceIndex({ quotes, spot: -1, riskFreeRate: RATE, asOf: ASOF }),
    ).toThrowError();
  });

  it('varianceRiskPremiumTermStructure rejects a bad realizedVolatility', () => {
    const quotes = makeChain(100, [{ expiry: '2026-06-20', volatility: 0.2 }]);
    expect(() =>
      varianceRiskPremiumTermStructure({
        quotes,
        spot: 100,
        riskFreeRate: RATE,
        asOf: ASOF,
        realizedVolatility: 'x' as never,
      }),
    ).toThrowError();
    expect(() =>
      varianceRiskPremiumTermStructure({
        quotes,
        spot: 100,
        riskFreeRate: RATE,
        asOf: ASOF,
        realizedVolatility: -0.1,
      }),
    ).toThrowError();
  });
});
