/**
 * The adversarial calendar and settlement family (2026-08 defect-fix wave).
 *
 * Every case here is a date or a settlement position that a schedule generator, an accrual, or a
 * yield solver gets wrong when it takes a shortcut — and each one shipped wrong at least once:
 *
 *   - 29th and 30th anchors crossed with leap and non-leap Februaries, at monthly / quarterly /
 *     semiannual frequency. The back-roll used to walk from the previously computed boundary, so
 *     the first February clamp propagated backwards forever and the anchor day was lost.
 *   - Mid-period calls, where the accrued coupon used to be forfeited.
 *   - Mid-period FRN settles, which used to be unpriceable at all.
 *   - Distressed yields, whose root lives outside the retired [−0.99·f, 1] bracket.
 *   - Settlement exactly ON a coupon date, the boundary every accrual `<` / `<=` gets wrong.
 *
 * These are properties, not golden numbers: each assertion states something that must be true of
 * ANY correct implementation (the anchor is preserved, boundaries depend only on the anchor and the
 * index, accrual is continuous across a coupon date), so it keeps its teeth under a rewrite.
 */

import { describe, expect, it } from 'vitest';
import {
  addMonths,
  bonds,
  compareDates,
  curves,
  daysInMonth,
  generateSchedule,
  isEndOfMonth,
  isLeapYear,
  priceFromYield,
  priceMultiCurve,
  yearFraction,
  yieldToCall,
  yieldToMaturity,
  type Frequency,
} from '@totalfinance/fixed-income';

const FREQUENCIES: { name: string; frequency: Frequency; step: number }[] = [
  { name: 'monthly', frequency: 'monthly', step: 1 },
  { name: 'quarterly', frequency: 'quarterly', step: 3 },
  { name: 'semiannual', frequency: 'semiannual', step: 6 },
];

/** Day-of-month of an ISO date. */
const dayOf = (date: string): number => Number(date.slice(8, 10));
/** `YYYY-MM` of an ISO date. */
const monthOf = (date: string): string => date.slice(0, 7);
/** The calendar day before an ISO date (UTC, clock-free). */
const minusOneDay = (date: string): string =>
  new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) - 86_400_000)
    .toISOString()
    .slice(0, 10);

describe('adversarial coupon schedules — 29th/30th anchors across leap and non-leap Februaries', () => {
  // Anchors on the two days that only some months have, in a leap year and the year after, so every
  // generated schedule crosses at least one February of each kind.
  const ANCHORS = [
    '2024-02-29', // leap-day maturity (also month end ⇒ EOM auto-detected)
    '2026-08-29',
    '2026-08-30',
    '2027-03-29',
    '2027-03-30',
    '2028-05-30', // crosses leap Feb 2028 on the way back
  ];

  for (const maturityDate of ANCHORS) {
    for (const { name, frequency, step } of FREQUENCIES) {
      it(`${name} to ${maturityDate}: every boundary is addMonths(maturity, −i·${step})`, () => {
        // Three years back so monthly/quarterly/semiannual all cross several Februaries.
        const effectiveDate = addMonths(maturityDate, -36);
        const sched = generateSchedule({ effectiveDate, maturityDate, frequency });
        const ends = sched.map((p) => p.accrualEnd);
        expect(ends[ends.length - 1]).toBe(maturityDate);

        // THE invariant: boundary i is a pure function of (anchor, i). Under an iterative back-roll
        // this fails the moment one boundary clamps in February. (A month-end maturity turns on the
        // EOM rule, which is likewise applied per boundary against the anchor.)
        const eom = isEndOfMonth(maturityDate);
        for (let i = 0; i < ends.length; i++) {
          expect(ends[i]).toBe(addMonths(maturityDate, -step * (ends.length - 1 - i), eom));
        }

        // Boundaries are strictly increasing and one period apart, with no repeated month.
        for (let i = 1; i < ends.length; i++) {
          expect(compareDates(ends[i - 1]!, ends[i]!)).toBeLessThan(0);
          expect(monthOf(ends[i - 1]!)).not.toBe(monthOf(ends[i]!));
        }

        // Periods tile the term with no gaps.
        for (let i = 1; i < sched.length; i++) {
          expect(sched[i]!.accrualStart).toBe(sched[i - 1]!.accrualEnd);
        }
        expect(sched[0]!.accrualStart).toBe(effectiveDate);
      });
    }
  }

  it('the anchor day is preserved wherever the month is long enough, and clamped ONLY where it is not', () => {
    const maturityDate = '2027-03-30'; // day 30, not a month end ⇒ no EOM snapping
    const sched = generateSchedule({
      effectiveDate: '2023-03-30',
      maturityDate,
      frequency: 'monthly',
    });
    for (const p of sched) {
      const [y, m] = [Number(p.accrualEnd.slice(0, 4)), Number(p.accrualEnd.slice(5, 7))];
      const length = daysInMonth(y, m);
      // Day 30 survives every month with 30+ days; February gets exactly its own last day.
      expect(dayOf(p.accrualEnd)).toBe(Math.min(30, length));
      if (m === 2) expect(dayOf(p.accrualEnd)).toBe(isLeapYear(y) ? 29 : 28);
    }
    // Three Februaries in this window: 2024 (leap → 29), 2025 and 2026 (→ 28), 2027 (→ 28).
    const februaries = sched.map((p) => p.accrualEnd).filter((d) => monthOf(d).endsWith('-02'));
    expect(februaries).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28']);
  });

  it('an EOM-anchored schedule still snaps every boundary to its month end', () => {
    // The EOM rule is applied PER BOUNDARY against the anchor, so it is unchanged by the rewrite.
    const sched = generateSchedule({
      effectiveDate: '2023-08-31',
      maturityDate: '2026-08-31',
      frequency: 'quarterly',
    });
    for (const p of sched) {
      const [y, m] = [Number(p.accrualEnd.slice(0, 4)), Number(p.accrualEnd.slice(5, 7))];
      expect(dayOf(p.accrualEnd)).toBe(daysInMonth(y, m));
    }
    expect(sched.map((p) => p.accrualEnd)).toContain('2024-02-29'); // leap February month end
    expect(sched.map((p) => p.accrualEnd)).toContain('2025-02-28');
  });

  it('a day-15 schedule is untouched by any of this (no clamping can occur)', () => {
    const sched = generateSchedule({
      effectiveDate: '2023-05-15',
      maturityDate: '2027-05-15',
      frequency: 'quarterly',
    });
    for (const p of sched) expect(dayOf(p.accrualEnd)).toBe(15);
    expect(sched).toHaveLength(16);
    expect(sched.every((p) => !p.isStub)).toBe(true);
  });

  it('stub detection survives: a genuinely short front period is still a stub, an exact term is not', () => {
    const exact = generateSchedule({
      effectiveDate: '2023-08-29',
      maturityDate: '2026-08-29',
      frequency: 'semiannual',
    });
    expect(exact.every((p) => !p.isStub)).toBe(true);

    const stubbed = generateSchedule({
      effectiveDate: '2023-10-10', // not on the 29th grid
      maturityDate: '2026-08-29',
      frequency: 'semiannual',
    });
    expect(stubbed[0]!.isStub).toBe(true);
    expect(stubbed[0]!.accrualStart).toBe('2023-10-10');
    expect(stubbed[0]!.accrualEnd).toBe('2024-02-29');
    expect(stubbed.slice(1).every((p) => !p.isStub)).toBe(true);
  });

  it('paymentLagDays still applies on top of the roll, per period', () => {
    const sched = generateSchedule({
      effectiveDate: '2023-08-29',
      maturityDate: '2026-08-29',
      frequency: 'semiannual',
      convention: 'following',
      paymentLagDays: 2,
    });
    // 2024-02-29 is a Thursday: following keeps it, +2 business days ⇒ Monday 2024-03-04.
    expect(sched[0]!.accrualEnd).toBe('2024-02-29');
    expect(sched[0]!.paymentDate).toBe('2024-03-04');
    for (const p of sched) expect(compareDates(p.accrualEnd, p.paymentDate)).toBeLessThanOrEqual(0);
  });
});

describe('settlement exactly ON a coupon date (the < / <= boundary)', () => {
  // A leap-day dated date on a 29th-anchored schedule: coupon periods have UNEQUAL 30/360 lengths
  // (…-02-28 → …-08-29 is 181/360, …-08-29 → …-02-28 is 179/360), so nothing here can lean on a
  // uniform 3.00 coupon — which is exactly what makes it a good boundary test.
  const bond = bonds.fixedRate({
    issueDate: '2024-02-29',
    maturityDate: '2029-08-29',
    couponRate: 0.06,
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });
  const flowAt = (date: string): number => bond.cashflows().find((f) => f.date === date)!.interest;

  it('accrued resets to exactly 0 on a coupon date and is continuous across it', () => {
    const couponDate = bond.schedule[2]!.accrualEnd;
    expect(bond.accrued(couponDate)).toBe(0); // EXACTLY zero, not 1e-16
    // One day earlier, essentially the whole coupon has accrued: strictly below it, and within one
    // day's worth of it. The step at the boundary is the coupon itself, not an off-by-one.
    const coupon = flowAt(couponDate);
    const justBefore = bond.accrued(minusOneDay(couponDate));
    expect(justBefore).toBeGreaterThan(0);
    expect(justBefore).toBeLessThan(coupon);
    expect(coupon - justBefore).toBeLessThan(coupon / 20);
    // And just after the coupon date, accrual has restarted from zero.
    const justAfter = bond.accrued(bond.schedule[3]!.accrualStart);
    expect(justAfter).toBe(0);
  });

  it('a coupon-date settlement drops that coupon from the future flows (the buyer does not get it)', () => {
    const couponDate = bond.schedule[2]!.accrualEnd;
    const future = bond.futureCashflows(couponDate);
    expect(future.every((f) => compareDates(f.date, couponDate) > 0)).toBe(true);
    expect(future).toHaveLength(bond.cashflows().length - 3);
    // Clean == dirty when nothing has accrued, and a 6% bond at a 6% yield is near par (not exactly:
    // the unequal 30/360 periods on a 29th anchor move it by a few cents).
    const p = priceFromYield(bond, { settlementDate: couponDate, yield: 0.06 });
    expect(p.accruedInterest).toBe(0);
    expect(p.cleanPrice).toBeCloseTo(p.dirtyPrice, 12);
    expect(Math.abs(p.cleanPrice - 100)).toBeLessThan(0.1);
  });

  it('a call ON a coupon date pays that coupon once — not twice, not zero', () => {
    const settlementDate = bond.schedule[1]!.accrualEnd;
    const callDate = bond.schedule[4]!.accrualEnd;
    // Build the expected price from the bond's OWN scheduled coupons (unequal, from `cashflows`)
    // plus par at the call date, discounted actuarially at 6%. This is independent of the flow
    // assembly inside `yieldToCall`, which is what the test is checking.
    const y = 0.06;
    const base = 1 + y / 2;
    let expected = 0;
    for (const period of bond.schedule.slice(2, 5)) {
      const t = yearFraction(settlementDate, period.accrualEnd, '30/360');
      expected += flowAt(period.accrualEnd) * Math.pow(base, -2 * t);
    }
    expected += 100 * Math.pow(base, -2 * yearFraction(settlementDate, callDate, '30/360'));
    const solved = yieldToCall(
      bond,
      { callDate, callPrice: 100 },
      { settlementDate, price: expected },
    );
    expect(solved).toBeCloseTo(0.06, 8);
    expect(bond.accrued(callDate)).toBe(0); // nothing extra to add on a coupon date
  });
});

describe('mid-period calls keep the accrued coupon', () => {
  // A 6% semiannual par bond settling on a coupon date, called ONE MONTH later at par.
  //   flows: 100 (call) + 0.5 accrued (6% × 100 × 30/360) at τ = 1/12 (30/360)
  //   100 = 100.5·(1 + y/2)^(−2/12)  ⇒  (1 + y/2) = 1.005^6 = 1.0303775…  ⇒  y = 6.0755%
  // Forfeiting the accrued coupon made this 100 = 100·(1 + y/2)^(−1/6) ⇒ y = 0%: buy at par,
  // get par back, earn nothing — a month of contractual interest deleted without a diagnostic.
  const bond = bonds.fixedRate({
    issueDate: '2026-01-15',
    maturityDate: '2036-01-15',
    couponRate: 0.06,
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });
  const settlementDate = '2026-07-15'; // a coupon date ⇒ accrued 0, clean == dirty

  it('a par bond called a month after a coupon yields ~6%, not 0%', () => {
    const y = yieldToCall(
      bond,
      { callDate: '2026-08-15', callPrice: 100 },
      { settlementDate, price: 100 },
    );
    const handMath = 2 * (Math.pow(1.005, 6) - 1);
    expect(handMath).toBeCloseTo(0.060755, 6);
    expect(y).toBeCloseTo(handMath, 10);
    expect(y).toBeGreaterThan(0.06); // strictly above the coupon: par in, par + accrued out
  });

  it('the accrued is the exact partial-period interest, at every point in the period', () => {
    for (const [callDate, months] of [
      ['2026-08-15', 1],
      ['2026-09-15', 2],
      ['2026-11-15', 4],
    ] as const) {
      const accrued = bond.accrued(callDate);
      expect(accrued).toBeCloseTo(3 * (months / 6), 10); // 3.00 per half-year, 30/360
      const tau = yearFraction(settlementDate, callDate, '30/360');
      const y = yieldToCall(bond, { callDate, callPrice: 100 }, { settlementDate, price: 100 });
      // The solved yield reprices the true flows: (100 + accrued)·(1 + y/2)^(−2τ) = 100.
      expect((100 + accrued) * Math.pow(1 + y / 2, -2 * tau)).toBeCloseTo(100, 9);
    }
  });

  it('a call ON a coupon date is unchanged (the scheduled coupon is already in the flow)', () => {
    // Regression guard for the fix itself: the on-coupon branch must NOT gain a second coupon.
    const onCoupon = yieldToCall(
      bond,
      { callDate: '2027-01-15', callPrice: 100 },
      { settlementDate, price: 100 },
    );
    // 3 at τ = 0.5 and 103 at τ = 0.5? No: one coupon of 3 at 2027-01-15 plus par ⇒ 103 at τ=0.5.
    expect(onCoupon).toBeCloseTo(0.06, 10);
    expect(bond.accrued('2027-01-15')).toBe(0);
  });
});

describe('mid-period FRN settles', () => {
  const issueDate = '2026-02-27';
  const frn = bonds.floatingRateNote({
    issueDate,
    maturityDate: '2029-05-27',
    couponRate: 0,
    frequency: 'quarterly',
    dayCount: 'ACT/360',
    spread: 0.001,
  });

  it('a leap-February-anchored FRN prices mid-period with a known fixing', () => {
    const settle = '2026-04-15';
    const curve = curves.flat({
      rate: 0.035,
      referenceDate: settle,
      options: { dayCount: 'ACT/360' },
    });
    // The in-progress coupon fixed on the issue date, before the curve exists.
    expect(() => frn.cashflows({ forecastCurve: curve })).toThrow(/knownFixingRate/);
    const flows = frn.cashflows({ forecastCurve: curve, knownFixingRate: 0.052 });
    const first = frn.schedule[0]!;
    const accrual = yearFraction(first.accrualStart, first.accrualEnd, 'ACT/360');
    expect(flows[0]!.interest).toBeCloseTo((0.052 + 0.001) * 100 * accrual, 12);
    const { dirtyPrice, accruedInterest } = priceMultiCurve(frn, {
      settlementDate: settle,
      discountCurve: curve,
      forecastCurve: curve,
      knownFixingRate: 0.052,
    });
    expect(dirtyPrice).toBeGreaterThan(99);
    expect(dirtyPrice).toBeLessThan(103);
    // Accrued is the elapsed fraction of the KNOWN coupon, not of a projected one.
    const elapsed = yearFraction(first.accrualStart, settle, 'ACT/360') / accrual;
    expect(accruedInterest).toBeCloseTo(flows[0]!.interest * elapsed, 10);
  });

  it('settling exactly on a reset date needs no fixing at all', () => {
    const reset = frn.schedule[0]!.accrualEnd; // the next period starts here
    const curve = curves.flat({
      rate: 0.035,
      referenceDate: reset,
      options: { dayCount: 'ACT/360' },
    });
    // Period 0 ended ON the curve reference date, so it is settled history: rejected, not faked.
    expect(() => frn.cashflows({ forecastCurve: curve, knownFixingRate: 0.052 })).toThrow(
      /ended before/,
    );
    // …but a note whose schedule starts at the reset projects entirely off the curve.
    const rolled = bonds.floatingRateNote({
      issueDate: reset,
      maturityDate: '2029-05-27',
      couponRate: 0,
      frequency: 'quarterly',
      dayCount: 'ACT/360',
      spread: 0.001,
    });
    expect(() => rolled.cashflows({ forecastCurve: curve })).not.toThrow();
    expect(rolled.accrued(reset, { forecastCurve: curve })).toBe(0);
  });
});

describe('distressed yields across the adversarial calendar', () => {
  it('a leap-day 1y zero at a distressed price solves above the retired bracket', () => {
    const zero = bonds.zeroCoupon({
      issueDate: '2024-02-29',
      maturityDate: '2025-02-28',
      faceValue: 100,
      frequency: 'annual',
      dayCount: 'ACT/365F',
    });
    const y = yieldToMaturity(zero, { settlementDate: '2024-02-29', price: 40 });
    expect(y).toBeGreaterThan(1.0); // outside [−0.99, 1]
    // Reprices exactly: 100·(1 + y)^(−τ) = 40.
    const tau = yearFraction('2024-02-29', '2025-02-28', 'ACT/365F');
    expect(100 * Math.pow(1 + y, -tau)).toBeCloseTo(40, 8);
  });

  it('a deeply discounted 29th-anchored coupon bond still solves and reprices', () => {
    const bond = bonds.fixedRate({
      issueDate: '2023-08-29',
      maturityDate: '2026-08-29',
      couponRate: 0.04,
      frequency: 'semiannual',
      faceValue: 100,
      dayCount: 'ACT/ACT',
    });
    const settlementDate = '2024-02-29'; // a leap-day coupon date on this schedule
    expect(bond.schedule.map((p) => p.accrualEnd)).toContain(settlementDate);
    const y = yieldToMaturity(bond, { settlementDate, price: 55 });
    expect(y).toBeGreaterThan(0.3);
    expect(priceFromYield(bond, { settlementDate, yield: y }).cleanPrice).toBeCloseTo(55, 8);
  });
});
