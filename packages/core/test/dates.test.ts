import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  compoundFactor,
  discountFactor,
  isoDateToEpochMs,
  parseIsoDate,
  yearFraction,
} from '@totalfinance/core';

describe('parseIsoDate', () => {
  it('parses a valid date', () => {
    expect(parseIsoDate('2026-09-18')).toEqual({ year: 2026, month: 9, day: 18 });
  });
  it('rejects malformed and non-calendar dates', () => {
    expect(() => parseIsoDate('2026/09/18')).toThrowError(/Invalid ISO date/);
    expect(() => parseIsoDate('2026-02-30')).toThrowError(/not a valid calendar date/);
  });
  it('isoDateToEpochMs is UTC midnight', () => {
    expect(isoDateToEpochMs('2026-01-01')).toBe(Date.UTC(2026, 0, 1));
  });
});

describe('yearFraction', () => {
  it('ACT/365F over a full non-leap year is 1', () => {
    expect(yearFraction('2026-01-01', '2027-01-01', 'ACT/365F')).toBeCloseTo(1, 12);
  });
  it('ACT/360 over 360 days is 1', () => {
    expect(yearFraction('2026-01-01', '2026-12-27', 'ACT/360')).toBeCloseTo(360 / 360, 12);
  });
  it('30/360 US half-year', () => {
    expect(yearFraction('2026-01-01', '2026-07-01', '30/360')).toBeCloseTo(0.5, 12);
  });
  it('30/360 US applies the end-of-month adjustment', () => {
    // d1=31→30, d2=28: (30*1 + (28-30))/360 = 28/360
    expect(yearFraction('2026-01-31', '2026-02-28', '30/360')).toBeCloseTo(28 / 360, 12);
  });
  it('accepts epoch-ms inputs', () => {
    expect(yearFraction(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), 'ACT/365F')).toBeCloseTo(1, 12);
  });
  it('computes TRUE 30/360 from epoch-ms inputs (WS1.4: replaces the old ACT/360 fake)', () => {
    // Jan 31 → Mar 31 under 30/360 US is exactly 60/360 (d1=31→30, d2=31→30 ⇒ 2 full 30-day months).
    // The deleted `yearFractionMs` returned actual-days/360 = 59/360 for the same epoch-ms inputs.
    expect(yearFraction(Date.UTC(2026, 0, 31), Date.UTC(2026, 2, 31), '30/360')).toBeCloseTo(
      60 / 360,
      12,
    );
    expect(yearFraction(Date.UTC(2026, 0, 31), Date.UTC(2026, 2, 31), '30/360')).not.toBeCloseTo(
      59 / 360,
      6,
    );
  });
});

describe('compounding', () => {
  it('discountFactor / compoundFactor are inverses', () => {
    expect(discountFactor(0.05, 1, 'continuous')).toBeCloseTo(Math.exp(-0.05), 12);
    expect(discountFactor(0.05, 1, 'simple')).toBeCloseTo(1 / 1.05, 12);
    expect(discountFactor(0.05, 2) * compoundFactor(0.05, 2)).toBeCloseTo(1, 12);
    expect(discountFactor(0.05, 2, 'simple') * compoundFactor(0.05, 2, 'simple')).toBeCloseTo(
      1,
      12,
    );
  });
});

describe('InterestCompounding — the ONE grammar (FC0)', () => {
  const forms = [
    'simple',
    'continuous',
    'annual',
    'semiannual',
    'quarterly',
    'monthly',
    { type: 'periodic', periodsPerYear: 26 },
  ] as const;

  it('discount and compound factors invert under EVERY supported form', () => {
    for (const compounding of forms) {
      const df = discountFactor(0.05, 2.5, compounding);
      const cf = compoundFactor(0.05, 2.5, compounding);
      expect(df * cf).toBeCloseTo(1, 12);
      expect(df).toBeGreaterThan(0);
      expect(df).toBeLessThan(1);
    }
  });

  it('the named discrete forms equal their periodic spellings exactly', () => {
    expect(discountFactor(0.06, 3, 'quarterly')).toBe(
      discountFactor(0.06, 3, { type: 'periodic', periodsPerYear: 4 }),
    );
    expect(compoundFactor(0.06, 3, 'monthly')).toBe(
      compoundFactor(0.06, 3, { type: 'periodic', periodsPerYear: 12 }),
    );
  });

  it('a periodic rate at or below −100% per period is rejected, never a complex-adjacent NaN', () => {
    let caught: unknown;
    try {
      discountFactor(-1.2, 1, 'annual');
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    // Continuous compounding has no such floor: mathematically valid, stays open.
    expect(Number.isFinite(discountFactor(-1.2, 1, 'continuous'))).toBe(true);
  });

  it('periodsPerYear must be a finite number > 0', () => {
    for (const bad of [0, -4, NaN, Infinity]) {
      expect(() =>
        discountFactor(0.05, 1, { type: 'periodic', periodsPerYear: bad }),
      ).toThrowError();
    }
  });
});
