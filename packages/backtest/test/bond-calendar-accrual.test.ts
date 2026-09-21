/** R05: independent calendar/day-count economics, not just adapter/ledger agreement. */
import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError, isoDateToEpochMs } from '@totalfinance/core';
import { bonds } from '@totalfinance/fixed-income/bonds';
import {
  accruedFromTerms,
  instrumentAdapters,
  portfolioBacktest,
  type CouponTerms,
} from '@totalfinance/backtest/portfolio';

const terms: CouponTerms = {
  annualRate: 0.06,
  faceValuePerUnit: 100,
  paymentsPerYear: 2,
  issueDate: '2026-01-01',
  maturityDate: '2028-01-01',
};
const at = (date: string) => isoDateToEpochMs(date) + 15 * 3_600_000;

describe('R05: coupon calendar and day-count accrual', () => {
  it.each([
    { annualRate: 1e308, faceValuePerUnit: 100 },
    { annualRate: 2, faceValuePerUnit: 1e308 },
    { annualRate: 1e300, faceValuePerUnit: 1e300 },
    { annualRate: -1e308, faceValuePerUnit: 100 },
  ])(
    'refuses non-finite results from finite terms $annualRate × $faceValuePerUnit',
    (overrides) => {
      const coupon = { ...terms, ...overrides };
      for (const date of ['2026-01-02', '2026-07-02']) {
        // The owner's coupon can overflow; it must not escape the helper or its mark/fill paths.
        const asOf = at(date);
        const specification = { kind: 'bond' as const, currency: 'USD', coupon };
        const calls = [
          () => accruedFromTerms(coupon, asOf),
          () => instrumentAdapters.bond.accrued!({ specification, asOf }),
          () =>
            instrumentAdapters.bond.mark({
              instrumentId: 'BOND',
              specification,
              asOf,
              latest: { trade: { symbol: 'BOND', timestampMs: asOf, price: 100, size: 1 } },
              previous: null,
            }),
        ];
        for (const call of calls) {
          expect(call).toThrow(InputError);
          expect(call).toThrowError(
            expect.objectContaining({
              code: ErrorCode.InputOutOfRange,
              context: expect.objectContaining({ function: 'accruedFromTerms', field: 'terms' }),
            }),
          );
        }
      }
    },
  );

  it('retains large representable accruals and zero outside the coupon life', () => {
    const coupon = { ...terms, annualRate: 0.01, faceValuePerUnit: 1e308 };
    const accrued = accruedFromTerms(coupon, at('2026-01-02'));
    expect(Number.isFinite(accrued)).toBe(true);
    expect(accrued / 1e303).toBeCloseTo(1000 / 365, 12);
    expect(accruedFromTerms(coupon, at('2026-07-01'))).toBe(0);
    const overflowing = { ...coupon, annualRate: 1e308 };
    // Infinity * zero elapsed fraction would be NaN inside the owner's accrual. Its coupon
    // schedule still declares zero on every boundary, including the issue date intraday.
    for (const date of [
      '2025-12-31',
      '2026-01-01',
      '2026-07-01',
      '2027-01-01',
      '2027-07-01',
      '2028-01-01',
      '2028-01-02',
    ]) {
      expect(accruedFromTerms(overflowing, at(date))).toBe(0);
    }
  });

  it.each(['ACT/365F', '30/360'] as const)('%s resets on each real coupon date', (dayCount) => {
    for (const date of [
      '2025-12-31',
      '2026-01-01',
      '2026-07-01',
      '2027-01-01',
      '2027-07-01',
      '2028-01-01',
      '2028-01-02',
    ]) {
      expect(accruedFromTerms({ ...terms, dayCount }, at(date)), date).toBe(0);
    }
    const denominator = dayCount === 'ACT/365F' ? 365 : 360;
    expect(accruedFromTerms({ ...terms, dayCount }, at('2026-07-02'))).toBeCloseTo(
      6 / denominator,
      12,
    );
  });

  it.each([
    // Actual calendar days from January 1; 30/360 uses thirty-day months instead.
    { dayCount: 'ACT/365F', date: '2026-03-31', days: 89, denominator: 365 },
    { dayCount: '30/360', date: '2026-03-31', days: 90, denominator: 360 },
    { dayCount: 'ACT/365F', date: '2026-06-30', days: 180, denominator: 365 },
    { dayCount: '30/360', date: '2026-06-30', days: 179, denominator: 360 },
  ] as const)(
    '$dayCount at $date uses $days convention days',
    ({ dayCount, date, days, denominator }) => {
      expect(accruedFromTerms({ ...terms, dayCount }, at(date))).toBeCloseTo(
        (6 * days) / denominator,
        12,
      );
    },
  );

  it.each(['ACT/365F', '30/360'] as const)(
    '%s honors month ends and leap-year coupon boundaries',
    (dayCount) => {
      const monthEnd: CouponTerms = {
        ...terms,
        issueDate: '2023-08-31',
        maturityDate: '2025-08-31',
        dayCount,
      };
      // Maturity-anchored semiannual periods end on Feb 29 in 2024, Feb 28 in 2025, and Aug 31.
      for (const date of ['2024-02-29', '2024-08-31', '2025-02-28', '2025-08-31']) {
        expect(accruedFromTerms(monthEnd, at(date)), date).toBe(0);
      }
      // Feb 29 → Mar 1: one actual day, two 30/360 days under the owner's US convention.
      expect(accruedFromTerms(monthEnd, at('2024-03-01'))).toBeCloseTo(
        dayCount === 'ACT/365F' ? 6 / 365 : 12 / 360,
        12,
      );
      const leap: CouponTerms = {
        ...terms,
        issueDate: '2024-01-01',
        maturityDate: '2026-01-01',
        dayCount,
      };
      expect(accruedFromTerms(leap, at('2024-03-01'))).toBeCloseTo(
        dayCount === 'ACT/365F' ? (6 * 60) / 365 : (6 * 60) / 360,
        12,
      );
    },
  );

  it.each(['ACT/365F', '30/360'] as const)(
    '%s accrues a short front stub from issue, then resets on the maturity-anchored date',
    (dayCount) => {
      const stub: CouponTerms = {
        ...terms,
        issueDate: '2026-04-15',
        maturityDate: '2028-01-31',
        dayCount,
      };
      // The first period is Apr 15 → Jul 31, NOT Apr 15 plus half of 365 days.
      expect(accruedFromTerms(stub, at('2026-04-15'))).toBe(0);
      expect(accruedFromTerms(stub, at('2026-05-15'))).toBeCloseTo(
        (6 * 30) / (dayCount === 'ACT/365F' ? 365 : 360),
        12,
      );
      expect(accruedFromTerms(stub, at('2026-07-31'))).toBe(0);
      expect(accruedFromTerms(stub, at('2026-08-01'))).toBeCloseTo(
        6 / (dayCount === 'ACT/365F' ? 365 : 360),
        12,
      );
    },
  );

  it.each([1, 2, 4, 12])(
    'reuses fixed-income owner semantics for %i payments/year',
    (paymentsPerYear) => {
      const coupon: CouponTerms = {
        ...terms,
        paymentsPerYear,
        issueDate: '2024-04-15',
        maturityDate: '2028-01-31',
      };
      const owner = bonds.fixedRate({
        issueDate: coupon.issueDate,
        maturityDate: coupon.maturityDate,
        couponRate: coupon.annualRate,
        frequency: paymentsPerYear,
        faceValue: 100,
        dayCount: 'ACT/365F',
      });
      for (const date of ['2024-05-01', '2024-07-31', '2025-02-28', '2025-12-15']) {
        expect(accruedFromTerms(coupon, at(date))).toBe(owner.accrued(date));
      }
    },
  );

  it('preserves face=1 and ACT/365F defaults and date-level intraday semantics', () => {
    const coupon = {
      annualRate: 0.06,
      paymentsPerYear: 2,
      issueDate: '2026-01-01',
      maturityDate: '2028-01-01',
    };
    expect(accruedFromTerms(coupon, at('2026-03-01'))).toBeCloseTo((0.06 * 59) / 365, 12);
    expect(accruedFromTerms(coupon, isoDateToEpochMs('2026-03-01'))).toBe(
      accruedFromTerms(coupon, at('2026-03-01')),
    );
  });

  it.each(
    (['ACT/365F', '30/360'] as const).flatMap((dayCount) =>
      ([1, -1] as const).map((direction) => ({ dayCount, direction })),
    ),
  )(
    '$dayCount direction $direction: dirty marks exchange accrued for coupon cash without phantom P&L',
    ({ dayCount, direction }) => {
      const coupon: CouponTerms = { ...terms, dayCount };
      const denominator = dayCount === 'ACT/365F' ? 365 : 360;
      const fullCoupon = (6 * (dayCount === 'ACT/365F' ? 181 : 180)) / denominator;
      // Both possible entry observations are June 30; accrual expectations are independent of
      // the engine timing repair and come from calendar days, never the adapter under test.
      const days = ['2026-06-30', '2026-06-30', '2026-07-01', '2026-07-02'];
      const result = portfolioBacktest({
        accounting: {
          baseCurrency: 'USD',
          initialCash: [{ currency: 'USD', amount: 100_000 }],
          settlement: { bond: 'T+0' },
        },
        instruments: { BOND: { kind: 'bond', currency: 'USD', coupon } },
        marketData: {
          bars: days.map((date, index) => ({
            symbol: 'BOND',
            timestampMs: at(date) + index * 3_600_000,
            open: 100,
            high: 100,
            low: 100,
            close: 100,
          })),
          coupons: [{ instrumentId: 'BOND', paymentDate: '2026-07-01', amountPerUnit: fullCoupon }],
        },
        strategy: {
          onSession: (c) =>
            c.index === 0
              ? [
                  {
                    orderId: 'entry',
                    instrumentId: 'BOND',
                    side: direction > 0 ? 'buy' : 'sell',
                    quantity: 10,
                    type: 'market',
                    submittedTimestampMs: c.asOf,
                  },
                ]
              : [],
        },
      });
      const fill = result.fills[0]!;
      expect(fill.pricePerUnit).toBe(100);
      const entryDays = dayCount === 'ACT/365F' ? 180 : 179;
      expect(fill.accruedInterest).toBeCloseTo((10 * 6 * entryDays) / denominator, 10);
      // At July 2, the coupon plus one day's fresh accrual, less accrued paid on entry.
      expect(result.finalValue).toBeCloseTo(
        100_000 + direction * 10 * (fullCoupon + 6 / denominator - (6 * entryDays) / denominator),
        8,
      );
      const markBefore = instrumentAdapters.bond.mark({
        instrumentId: 'BOND',
        specification: { kind: 'bond', currency: 'USD', coupon },
        asOf: at('2026-06-30'),
        latest: { trade: { symbol: 'BOND', timestampMs: at('2026-06-30'), price: 100, size: 1 } },
        previous: null,
      });
      const markAfter = instrumentAdapters.bond.mark({
        instrumentId: 'BOND',
        specification: { kind: 'bond', currency: 'USD', coupon },
        asOf: at('2026-07-01'),
        latest: { trade: { symbol: 'BOND', timestampMs: at('2026-07-01'), price: 100, size: 1 } },
        previous: null,
      });
      expect(markAfter).toEqual({ pricePerUnit: 100, source: 'trade.price+accrued' });
      expect(
        'pricePerUnit' in markBefore && 100 + fullCoupon - markBefore.pricePerUnit,
      ).toBeCloseTo(6 / denominator, 12);
    },
  );
});
