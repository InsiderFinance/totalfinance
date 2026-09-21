import { resolvedExpiry, resolveAsOf } from '@totalfinance/core';
/**
 * SKEW-style tail-risk index (`tailRiskIndex`). Verifies that a symmetric (flat) smile gives ~0
 * risk-neutral skewness and a SKEW value ~100, that a put-skew smile gives negative skewness and a
 * SKEW > 100 (steeper ⇒ higher), that a fat-winged smile shows positive excess kurtosis, the
 * constant-maturity interpolation, dropped-expiry disclosure, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { type OptionQuote, isQuantError, optionExpiryToMs, yearFraction } from '@totalfinance/core';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { tailRiskIndex } from '@totalfinance/volatility';

const ASOF = '2026-05-01T00:00:00Z'; // a valuation instant names its time of day
const RATE = 0.02;

/** A BSM-consistent chain with a per-strike IV (the smile) at each expiry. */
function makeChain(
  spot: number,
  expiries: readonly { expiry: string; impliedVolatility: (k: number) => number }[],
): OptionQuote[] {
  const asOfMs = resolveAsOf(ASOF);
  const quotes: OptionQuote[] = [];
  for (const { expiry, impliedVolatility } of expiries) {
    const t = yearFraction(asOfMs, optionExpiryToMs(expiry), 'ACT/365F');
    if (t <= 0) continue;
    for (let k = Math.round(spot * 0.5); k <= spot * 1.5; k += 2.5) {
      const vol = Math.max(0.03, impliedVolatility(k));
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
            volatility: vol,
          }),
          underlyingPrice: spot,
        });
      }
    }
  }
  return quotes;
}

const flat = () => 0.2;
const putSkew = (slope: number) => (k: number) => 0.25 - slope * Math.log(k / 100); // higher IV at low strikes
const smile = (k: number) => 0.2 + 0.6 * Math.log(k / 100) ** 2; // symmetric U — fat both tails

describe('tailRiskIndex — sign & level', () => {
  it('a symmetric (flat-vol) smile gives ~0 skewness and a SKEW value ~100', () => {
    const r = tailRiskIndex({
      quotes: makeChain(100, [{ expiry: '2026-06-20', impliedVolatility: flat }]),
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
    });
    expect(Math.abs(r.termStructure[0]!.skewness)).toBeLessThan(0.05); // lognormal ⇒ ~0 log-return skew
    expect(r.termStructure[0]!.skewIndex).toBeCloseTo(100, 0);
    expect(r.diagnostics.engine).toBe('tail-risk-index');
  });

  it('a put-skew smile gives negative skewness and a SKEW > 100 (steeper ⇒ higher)', () => {
    const mild = tailRiskIndex({
      quotes: makeChain(100, [{ expiry: '2026-06-20', impliedVolatility: putSkew(0.3) }]),
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
    });
    const steep = tailRiskIndex({
      quotes: makeChain(100, [{ expiry: '2026-06-20', impliedVolatility: putSkew(0.6) }]),
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
    });
    expect(mild.termStructure[0]!.skewness).toBeLessThan(0); // fat left tail
    expect(mild.skewIndex).toBeGreaterThan(100);
    expect(steep.skewIndex).toBeGreaterThan(mild.skewIndex); // steeper skew ⇒ more crash risk priced
  });

  it('a fat-winged (symmetric) smile shows positive excess kurtosis', () => {
    const r = tailRiskIndex({
      quotes: makeChain(100, [{ expiry: '2026-06-20', impliedVolatility: smile }]),
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
    });
    expect(r.termStructure[0]!.excessKurtosis).toBeGreaterThan(0); // fat tails
    expect(Math.abs(r.termStructure[0]!.skewness)).toBeLessThan(0.05); // symmetric ⇒ ~0 skew
  });
});

describe('tailRiskIndex — term structure & interpolation', () => {
  it('interpolates the constant-maturity SKEW between two expiries', () => {
    const r = tailRiskIndex({
      quotes: makeChain(100, [
        { expiry: '2026-05-21', impliedVolatility: putSkew(0.2) }, // 20d, milder
        { expiry: '2026-06-20', impliedVolatility: putSkew(0.6) }, // 50d, steeper
      ]),
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
      horizonDays: 30,
    });
    expect(r.termStructure).toHaveLength(2);
    expect(r.interpolatedBetween).toEqual({ near: '2026-05-21', far: '2026-06-20' });
    const near = r.termStructure[0]!.skewIndex;
    const far = r.termStructure[1]!.skewIndex;
    expect(r.skewIndex).toBeGreaterThan(Math.min(near, far));
    expect(r.skewIndex).toBeLessThan(Math.max(near, far));
  });
});

describe('tailRiskIndex — envelope & guards', () => {
  it('drops an un-replicable (too-sparse) expiry with a disclosed warning', () => {
    const good = makeChain(100, [{ expiry: '2026-06-20', impliedVolatility: putSkew(0.3) }]);
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
    const r = tailRiskIndex({
      quotes: [...good, ...sparse],
      spot: 100,
      riskFreeRate: RATE,
      asOf: ASOF,
    });
    expect(r.termStructure.map((e) => e.expiry)).toEqual(['2026-06-20']);
    expect(r.diagnostics.warnings.some((w) => w.message.includes('2026-07-20'))).toBe(true);
  });

  it('throws on garbage, an unusable chain, and a bad horizonPeriods', () => {
    expect(() => tailRiskIndex(undefined as never)).toThrowError();
    const callsOnly = makeChain(100, [{ expiry: '2026-06-20', impliedVolatility: flat }]).filter(
      (q) => q.contract.type === 'call',
    );
    try {
      tailRiskIndex({ quotes: callsOnly, spot: 100, riskFreeRate: RATE, asOf: ASOF });
      expect.unreachable('a chain with no bracketing forward should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
    const quotes = makeChain(100, [{ expiry: '2026-06-20', impliedVolatility: flat }]);
    expect(() =>
      tailRiskIndex({ quotes, spot: 100, riskFreeRate: RATE, asOf: ASOF, horizonDays: 0 }),
    ).toThrowError();
    expect(() =>
      tailRiskIndex({ quotes, spot: -1, riskFreeRate: RATE, asOf: ASOF }),
    ).toThrowError();
  });
});
