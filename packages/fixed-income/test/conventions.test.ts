/**
 * Tests for §14 conventions: ACT/ACT (ISDA) and 30E/360 day counts, business-day adjustment, and
 * backward-generated coupon schedules with stubs and month-end rolling.
 */

import { describe, expect, it } from 'vitest';
import { weekendsOnly } from '@totalfinance/core';
import {
  addMonths,
  adjustDate,
  compareDates,
  daysInYear,
  generateSchedule,
  isEndOfMonth,
  isLeapYear,
  paymentsPerYear,
  yearFraction,
} from '@totalfinance/fixed-income';

describe('calendar helpers', () => {
  it('leap years and day counts', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2025)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
    expect(daysInYear(2024)).toBe(366);
    expect(daysInYear(2025)).toBe(365);
  });

  it('addMonths clamps day-of-month and supports month-end snapping', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28'); // clamp to Feb length
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29'); // leap Feb
    expect(addMonths('2026-01-15', -3)).toBe('2025-10-15'); // crosses year
    expect(addMonths('2026-02-28', 6, true)).toBe('2026-08-31'); // EOM snap
  });

  it('isEndOfMonth and compareDates', () => {
    expect(isEndOfMonth('2026-02-28')).toBe(true);
    expect(isEndOfMonth('2024-02-28')).toBe(false); // leap year, 29 is the end
    expect(isEndOfMonth('2026-01-31')).toBe(true);
    expect(compareDates('2026-01-01', '2026-06-01')).toBeLessThan(0);
    expect(compareDates('2026-06-01', '2026-06-01')).toBe(0);
  });
});

describe('day-count year fractions', () => {
  it('ACT/ACT (ISDA) is exactly 1.0 over a full calendar year and additive across years', () => {
    expect(yearFraction('2026-01-01', '2027-01-01', 'ACT/ACT')).toBeCloseTo(1, 12);
    // 2024 (leap) + 2025 (non-leap), each a full year → 2.0
    expect(yearFraction('2024-01-01', '2026-01-01', 'ACT/ACT')).toBeCloseTo(2, 12);
  });

  it('ACT/ACT (ISDA) splits a leap-spanning stub by each year basis', () => {
    // 2023-12-15 → 2024-01-01 = 17 days / 365, then → 2024-01-15 = 14 days / 366
    const yf = yearFraction('2023-12-15', '2024-01-15', 'ACT/ACT');
    expect(yf).toBeCloseTo(17 / 365 + 14 / 366, 12);
  });

  it('ACT/ACT is antisymmetric in its arguments', () => {
    expect(yearFraction('2027-01-15', '2026-12-15', 'ACT/ACT')).toBeCloseTo(
      -yearFraction('2026-12-15', '2027-01-15', 'ACT/ACT'),
      12,
    );
  });

  it('30E/360 caps both day numbers at 30 (distinct from US 30/360 on a 31st end date)', () => {
    // 2026-02-28 → 2026-08-31: 30E/360 caps the 31 → 30; US 30/360 keeps it (start day ≠ 30).
    expect(yearFraction('2026-02-28', '2026-08-31', '30E/360')).toBeCloseTo(182 / 360, 12);
    expect(yearFraction('2026-02-28', '2026-08-31', '30/360')).toBeCloseTo(183 / 360, 12);
  });

  it('delegates the three core conventions', () => {
    expect(yearFraction('2026-01-01', '2026-07-01', 'ACT/365F')).toBeCloseTo(181 / 365, 12);
    expect(yearFraction('2026-01-01', '2026-07-01', 'ACT/360')).toBeCloseTo(181 / 360, 12);
  });

  it('rejects an unknown day count', () => {
    expect(() => yearFraction('2026-01-01', '2026-02-01', 'BOGUS' as 'ACT/ACT')).toThrow(
      /day-count/,
    );
  });
});

describe('business-day adjustment (weekends-only default)', () => {
  it('following and preceding roll off a Saturday', () => {
    expect(adjustDate('2026-01-03', 'following')).toBe('2026-01-05'); // Sat → Mon
    expect(adjustDate('2026-01-03', 'preceding')).toBe('2026-01-02'); // Sat → Fri
    expect(adjustDate('2026-01-05', 'following')).toBe('2026-01-05'); // already a business day
  });

  it('modifiedFollowing reverses when the roll crosses a month boundary', () => {
    // 2026-05-31 is a Sunday; following → Mon 2026-06-01 (next month) ⇒ use preceding Fri 2026-05-29.
    expect(adjustDate('2026-05-31', 'modifiedFollowing')).toBe('2026-05-29');
    // 2026-02-28 is a Saturday at month end; following → Mon 2026-03-02 (next month) ⇒ Fri 2026-02-27.
    expect(adjustDate('2026-02-28', 'modifiedFollowing')).toBe('2026-02-27');
  });

  it('unadjusted is a no-op even on a weekend', () => {
    expect(adjustDate('2026-01-03', 'unadjusted')).toBe('2026-01-03');
  });

  it('rejects an unknown convention', () => {
    expect(() => adjustDate('2026-01-03', 'sideways' as 'following')).toThrow(/convention/);
  });
});

describe('coupon schedule generation', () => {
  it('paymentsPerYear maps names and validates divisors of 12', () => {
    expect(paymentsPerYear('semiannual')).toBe(2);
    expect(paymentsPerYear('quarterly')).toBe(4);
    expect(paymentsPerYear(12)).toBe(12);
    expect(() => paymentsPerYear(5)).toThrow(/frequency/);
  });

  it('generates a regular semiannual schedule with no stub', () => {
    const sched = generateSchedule({
      effectiveDate: '2026-01-15',
      maturityDate: '2028-01-15',
      frequency: 'semiannual',
    });
    expect(sched).toHaveLength(4);
    expect(sched.map((p) => p.accrualEnd)).toEqual([
      '2026-07-15',
      '2027-01-15',
      '2027-07-15',
      '2028-01-15',
    ]);
    expect(sched.every((p) => !p.isStub)).toBe(true);
    // Each regular semiannual ACT/ACT period is close to half a year.
    for (const p of sched) {
      expect(yearFraction(p.accrualStart, p.accrualEnd, 'ACT/ACT')).toBeCloseTo(0.5, 1);
    }
  });

  it('places a short front stub when the term is not a whole number of periods', () => {
    const sched = generateSchedule({
      effectiveDate: '2026-02-15',
      maturityDate: '2028-01-15',
      frequency: 'semiannual',
    });
    expect(sched[0]!.isStub).toBe(true);
    expect(sched[0]!.accrualStart).toBe('2026-02-15');
    expect(sched[0]!.accrualEnd).toBe('2026-07-15');
    // The stub is shorter than a regular half-year period.
    const stubYf = yearFraction(sched[0]!.accrualStart, sched[0]!.accrualEnd, 'ACT/ACT');
    expect(stubYf).toBeLessThan(0.5);
  });

  it('rolls coupon dates to month-end when the maturity is a month end', () => {
    const sched = generateSchedule({
      effectiveDate: '2025-08-31',
      maturityDate: '2026-08-31',
      frequency: 'semiannual',
    });
    expect(sched.map((p) => p.accrualEnd)).toEqual(['2026-02-28', '2026-08-31']);
  });

  it('adjusts payment dates by the business-day convention and a settlement lag', () => {
    const sched = generateSchedule({
      effectiveDate: '2026-01-31',
      maturityDate: '2026-07-31',
      frequency: 'semiannual',
      convention: 'following',
      calendar: weekendsOnly,
      paymentLagDays: 2,
    });
    // Single period ending 2026-07-31 (Friday): following keeps it, +2 business days ⇒ Tue 2026-08-04.
    expect(sched).toHaveLength(1);
    expect(sched[0]!.accrualEnd).toBe('2026-07-31');
    expect(sched[0]!.paymentDate).toBe('2026-08-04');
  });

  it('a 29th-anchored semiannual schedule keeps the 29th and lands on 02-29 in a leap year', () => {
    // The back-roll used to walk from the PREVIOUS boundary, so the first non-leap February clamped
    // 02-29 → 02-28 and then carried the 28th backwards forever: 2026-02-28, 2025-08-28 (anchor
    // lost), …, 2024-02-28 (a LEAP February that should be the 29th), …, 2023-08-28 — which no
    // longer equals the effective date, inventing a front stub on an exactly regular term.
    const sched = generateSchedule({
      effectiveDate: '2023-08-29',
      maturityDate: '2026-08-29',
      frequency: 'semiannual',
    });
    expect(sched.map((p) => p.accrualEnd)).toEqual([
      '2024-02-29', // leap February — the anchor day 29 exists here
      '2024-08-29',
      '2025-02-28', // non-leap February clamps, and the clamp does NOT propagate
      '2025-08-29',
      '2026-02-28',
      '2026-08-29',
    ]);
    expect(sched[0]!.accrualStart).toBe('2023-08-29');
    expect(sched.every((p) => !p.isStub)).toBe(true); // exactly six regular periods, no stub
  });

  it('a 30th-anchored monthly schedule clamps only the month that needs it', () => {
    // 2023-12-30 → 2024-05-30 monthly: February 2024 has 29 days so that ONE boundary clamps to
    // 02-29; January and March keep the 30th. The old iterative roll produced 01-29 and a stub.
    const sched = generateSchedule({
      effectiveDate: '2023-12-30',
      maturityDate: '2024-05-30',
      frequency: 'monthly',
    });
    expect(sched.map((p) => p.accrualEnd)).toEqual([
      '2024-01-30',
      '2024-02-29',
      '2024-03-30',
      '2024-04-30',
      '2024-05-30',
    ]);
    expect(sched.every((p) => !p.isStub)).toBe(true);
  });

  it('every boundary is a pure function of (maturity anchor, index) — not of the effective date', () => {
    // The invariant the rewrite buys: boundary i is `addMonths(maturity, −i·step)`, so two bonds
    // sharing a maturity and frequency share every schedule date they have in common, no matter
    // how far back each one starts (the old cursor walk made early dates depend on how many steps
    // had been taken, hence on the effective date).
    const maturityDate = '2030-01-31';
    const long = generateSchedule({
      effectiveDate: '2024-01-31',
      maturityDate,
      frequency: 'quarterly',
    });
    const short = generateSchedule({
      effectiveDate: '2028-01-31',
      maturityDate,
      frequency: 'quarterly',
    });
    const longEnds = long.map((p) => p.accrualEnd);
    const shortEnds = short.map((p) => p.accrualEnd);
    expect(longEnds.slice(longEnds.length - shortEnds.length)).toEqual(shortEnds);
  });

  it('rejects an inverted term', () => {
    expect(() =>
      generateSchedule({
        effectiveDate: '2028-01-15',
        maturityDate: '2026-01-15',
        frequency: 'semiannual',
      }),
    ).toThrow(/effectiveDate/);
  });
});
