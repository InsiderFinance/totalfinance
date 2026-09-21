/**
 * Dividend term structures (`dividendTermStructure`). The headline is the exactness guarantee: pricing an
 * expiry with the reported continuous-equivalent yield `q_eff(T)` reproduces the escrowed-spot BSM price
 * to machine precision. Also pinned: the dividend PV / forward / q_eff against an independent escrowed
 * recomputation, term-structure sorting and the `1/T` decay past the last ex-date, past-dividend exclusion
 * with disclosure, the continuous-only (flat) case, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { parseExDateToEpoch } from '../src/time.js';
import { dividendTermStructure } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  optionExpiryToMs,
  resolveAsOf,
  usEquitySessionInstant,
  yearFraction,
} from '@totalfinance/core';

const ASOF = '2026-01-01T00:00:00Z'; // a valuation instant names its time of day
/** Replicate the package's `timeToExpiryYears(asOf, maturity)` (16:00 ET) from public core helpers. */
const tau = (date: string): number =>
  yearFraction(resolveAsOf(ASOF), optionExpiryToMs(date), 'ACT/365F');
/**
 * Ex-dates use the MARKET-OPEN convention (09:30 ET on every session, including early-close days; NOT the 6.5-hour session),
 * not the option-expiry close: a share stops carrying the dividend at the open on the ex-date.
 */
const tauEx = (exDate: string): number =>
  yearFraction(resolveAsOf(ASOF), usEquitySessionInstant(exDate, 'open'), 'ACT/365F');

describe('dividendTermStructure', () => {
  it('the reported q_eff(T) reproduces the escrowed-spot BSM price exactly (call & put)', () => {
    const S = 100;
    const r = 0.05;
    const q = 0.01;
    const ts = dividendTermStructure({
      spot: S,
      riskFreeRate: r,
      dividendYield: q,
      dividends: [
        { exDate: '2026-04-01', amount: 1.5 },
        { exDate: '2026-10-01', amount: 1.5 },
      ],
      asOf: ASOF,
      maturities: ['2026-03-01', '2026-07-01', '2027-01-01'],
    });
    for (const p of ts.points) {
      for (const type of ['call', 'put'] as const) {
        const viaQeff = blackScholesPrice({
          type,
          spot: S,
          strike: 100,
          timeToExpiryYears: p.yearsToExpiry,
          riskFreeRate: r,
          dividendYield: p.impliedContinuousYield,
          volatility: 0.25,
        });
        const escrowed = blackScholesPrice({
          type,
          spot: S - p.dividendPresentValue,
          strike: 100,
          timeToExpiryYears: p.yearsToExpiry,
          riskFreeRate: r,
          dividendYield: q,
          volatility: 0.25,
        });
        // BSM depends on (S,r,q) only through the forward, and q_eff is built to match that forward.
        expect(viaQeff).toBeCloseTo(escrowed, 12);
      }
    }
  });

  it('the dividend PV, forward, q_eff, and carry match an independent escrowed recomputation', () => {
    const S = 100;
    const r = 0.05;
    const q = 0.01;
    const divs = [
      { exDate: '2026-04-01', amount: 1.5 },
      { exDate: '2026-10-01', amount: 1.5 },
    ];
    const ts = dividendTermStructure({
      spot: S,
      riskFreeRate: r,
      dividendYield: q,
      dividends: divs,
      asOf: ASOF,
      maturities: ['2027-01-01'],
    });
    const p = ts.points[0]!;
    // Independent escrowed PV: only ex-dates strictly before expiry, discounted at r.
    const T = tau('2027-01-01');
    const expectedPv = divs
      .map((d) => ({ timeToExpiryYears: tauEx(d.exDate), amt: d.amount }))
      .filter((d) => d.timeToExpiryYears > 0 && d.timeToExpiryYears < T)
      .reduce((s, d) => s + d.amt * Math.exp(-r * d.timeToExpiryYears), 0);
    expect(p.dividendPresentValue).toBeCloseTo(expectedPv, 12);
    expect(p.discreteCount).toBe(2);
    expect(p.forward).toBeCloseTo((S - expectedPv) * Math.exp((r - q) * T), 10);
    expect(p.discreteEquivalentYield).toBeCloseTo(-Math.log(1 - expectedPv / S) / T, 12);
    expect(p.impliedContinuousYield).toBeCloseTo(q + p.discreteEquivalentYield, 12);
    expect(p.carry).toBeCloseTo(r - p.impliedContinuousYield, 12);
    // totalDividendPv is the PV of every future dividend (both accrue before 1y here).
    expect(ts.totalDividendPresentValue).toBeCloseTo(expectedPv, 12);
  });

  it('reports points sorted ascending by tenor regardless of input order', () => {
    const ts = dividendTermStructure({
      spot: 100,
      riskFreeRate: 0.04,
      asOf: ASOF,
      maturities: ['2028-01-01', '2026-06-01', '2027-01-01'],
    });
    const tenors = ts.points.map((p) => p.yearsToExpiry);
    expect(tenors).toEqual([...tenors].sort((a, b) => a - b));
    expect(ts.points.map((p) => p.maturity)).toEqual(['2026-06-01', '2027-01-01', '2028-01-01']);
  });

  it('the discrete-equivalent yield decays like 1/T past the last ex-date', () => {
    // Both dividends fall before 1y, so PV(1y) == PV(2y): the same cash spread over 2× the horizonYears
    // is half the annualized yield.
    const ts = dividendTermStructure({
      spot: 100,
      riskFreeRate: 0.05,
      dividends: [
        { exDate: '2026-04-01', amount: 2 },
        { exDate: '2026-07-01', amount: 2 },
      ],
      asOf: ASOF,
      maturities: ['2027-01-01', '2028-01-01'],
    });
    const [oneY, twoY] = ts.points;
    expect(oneY!.discreteCount).toBe(2);
    expect(twoY!.discreteCount).toBe(2);
    expect(oneY!.dividendPresentValue).toBeCloseTo(twoY!.dividendPresentValue, 12); // no dividend between 1y and 2y
    expect(twoY!.discreteEquivalentYield).toBeLessThan(oneY!.discreteEquivalentYield);
    // ~1/T scaling: q_disc(2y)·(2y) == q_disc(1y)·(1y) == −ln(1−PV/S).
    expect(twoY!.discreteEquivalentYield * twoY!.yearsToExpiry).toBeCloseTo(
      oneY!.discreteEquivalentYield * oneY!.yearsToExpiry,
      12,
    );
  });

  it('excludes ex-dates on/before asOf (disclosed, pluralized) while a future one accrues', () => {
    const ts = dividendTermStructure({
      spot: 100,
      riskFreeRate: 0.05,
      dividends: [
        { exDate: '2025-06-01', amount: 3 }, // before asOf → already paid → dropped
        { exDate: '2025-12-01', amount: 3 }, // before asOf → already paid → dropped
        { exDate: '2026-06-01', amount: 3 }, // future → accrues
      ],
      asOf: ASOF,
      maturities: ['2027-01-01'],
    });
    expect(ts.points[0]!.discreteCount).toBe(1); // only the future one
    expect(ts.totalDividendPresentValue).toBeCloseTo(3 * Math.exp(-0.05 * tauEx('2026-06-01')), 12);
    const past = ts.diagnostics.warnings.find((w) => w.code === 'options.dividends_past');
    expect(past).toBeDefined();
    expect(past!.message).toContain('2 dividends'); // plural branch
    expect(past!.message).toContain('were dropped');

    // Singular branch: exactly one dropped ex-date reads "1 dividend … was dropped".
    const one = dividendTermStructure({
      spot: 100,
      riskFreeRate: 0.05,
      dividends: [{ exDate: '2025-12-01', amount: 3 }],
      asOf: ASOF,
      maturities: ['2027-01-01'],
    });
    const onePast = one.diagnostics.warnings.find((w) => w.code === 'options.dividends_past');
    expect(onePast!.message).toContain('1 dividend ');
    expect(onePast!.message).toContain('was dropped');
  });

  it('a continuous-only input gives a flat q_eff == dividendYield and discloses no schedule', () => {
    const ts = dividendTermStructure({
      spot: 100,
      riskFreeRate: 0.05,
      dividendYield: 0.03,
      asOf: ASOF,
      maturities: ['2026-07-01', '2027-01-01'],
    });
    for (const p of ts.points) {
      expect(p.impliedContinuousYield).toBeCloseTo(0.03, 14);
      expect(p.discreteEquivalentYield).toBeCloseTo(0, 14);
      expect(p.dividendPresentValue).toBe(0);
    }
    expect(ts.assumptions.dividendModel).toBe('continuousYield');
    expect(ts.diagnostics.warnings.some((w) => w.code === 'options.dividends_none')).toBe(true);
  });

  it('a no-dividend, no-yield input gives pure cost-of-carry forwards (model "none")', () => {
    const ts = dividendTermStructure({
      spot: 100,
      riskFreeRate: 0.05,
      asOf: ASOF,
      maturities: ['2027-01-01'],
    });
    const p = ts.points[0]!;
    expect(p.forward).toBeCloseTo(100 * Math.exp(0.05 * p.yearsToExpiry), 12);
    expect(p.impliedContinuousYield).toBe(0);
    expect(ts.assumptions.dividendModel).toBe('none');
    expect(typeof ts.summary).toBe('string');
    expect(ts.summary.length).toBeGreaterThan(0);
  });

  it('guards bad input, spot/rate, dividend amounts, spot-exceeding PV, and bad maturities', () => {
    const OK = { spot: 100, riskFreeRate: 0.05, asOf: ASOF, maturities: ['2027-01-01'] };
    expect(() => dividendTermStructure(undefined as never)).toThrowError();
    expect(() => dividendTermStructure({ ...OK, spot: -1 })).toThrowError();
    expect(() => dividendTermStructure({ ...OK, spot: 0 })).toThrowError();
    expect(() => dividendTermStructure({ ...OK, riskFreeRate: Number.NaN })).toThrowError();
    expect(() => dividendTermStructure({ ...OK, riskFreeRate: undefined as never })).toThrowError();
    expect(() => dividendTermStructure({ ...OK, maturities: [] })).toThrowError();
    expect(() => dividendTermStructure({ ...OK, maturities: ['2025-01-01'] })).toThrowError(); // maturity before asOf
    expect(() => dividendTermStructure({ ...OK, dividends: 'nope' as never })).toThrowError(); // not an array
    expect(() =>
      dividendTermStructure({ ...OK, dividends: [{ exDate: '2026-06-01', amount: -1 }] }),
    ).toThrowError(); // negative amount
    expect(() =>
      dividendTermStructure({ ...OK, dividends: [{ exDate: '2026-06-01', amount: Infinity }] }),
    ).toThrowError(); // non-finite amount
    expect(() =>
      dividendTermStructure({
        spot: 10,
        riskFreeRate: 0.05,
        asOf: ASOF,
        dividends: [{ exDate: '2026-06-01', amount: 20 }],
        maturities: ['2027-01-01'],
      }),
    ).toThrowError(); // PV of dividends ≥ spot → escrowed spot non-positive
  });
});

describe('ex-date open on an early-close day (shared session table)', () => {
  it('resolves a date-only ex-date to 09:30 ET even when that session closes at 13:00 ET', () => {
    // 2026-11-27 is the Friday after Thanksgiving: a 13:00 ET close. The open is still 09:30 ET
    // (14:30Z in EST) — it must never be derived as "close minus 6.5 hours" (06:30 ET).
    expect(parseExDateToEpoch('2026-11-27', 't')).toBe(Date.UTC(2026, 10, 27, 14, 30));
    expect(parseExDateToEpoch('2026-11-25', 't')).toBe(Date.UTC(2026, 10, 25, 14, 30));
  });
});
