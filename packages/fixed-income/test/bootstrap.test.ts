/**
 * Tests for §14.2 curve bootstrapping: deposits, FRAs, futures, OIS, and par swaps. The acid test is
 * self-consistency — every instrument used to build the curve must reprice to par off the curve.
 */

import { describe, expect, it } from 'vitest';
import {
  bonds,
  curves,
  priceMultiCurve,
  swapValue,
  type BootstrapInstrument,
} from '@totalfinance/fixed-income';

const referenceDate = '2026-01-01';

describe('deposit / FRA / future legs', () => {
  it('a deposit reprices to its simple rate', () => {
    const curve = curves.bootstrap([{ type: 'deposit', maturity: '2026-07-01', rate: 0.04 }], {
      referenceDate,
    });
    const tau = (Date.UTC(2026, 6, 1) - Date.UTC(2026, 0, 1)) / (360 * 86_400_000); // ACT/360
    expect(curve.discount('2026-07-01')).toBeCloseTo(1 / (1 + 0.04 * tau), 10);
  });

  it('a FRA pins the forward rate over its window', () => {
    const curve = curves.bootstrap(
      [
        { type: 'deposit', maturity: '2026-04-01', rate: 0.04 },
        { type: 'fra', start: '2026-04-01', end: '2026-10-01', rate: 0.045 },
      ],
      { referenceDate },
    );
    const fwd = curve.forwardRate('2026-04-01', '2026-10-01', 'ACT/360');
    expect(fwd).toBeCloseTo(0.045, 8);
  });

  it('a future pins its implied forward (price = 100·(1 − f))', () => {
    const curve = curves.bootstrap(
      [
        { type: 'deposit', maturity: '2026-03-01', rate: 0.04 },
        { type: 'future', start: '2026-03-01', end: '2026-06-01', price: 95.5 },
      ],
      { referenceDate },
    );
    expect(curve.forwardRate('2026-03-01', '2026-06-01', 'ACT/360')).toBeCloseTo(0.045, 8);
  });
});

describe('swap / OIS bootstrap reprices every instrument to par', () => {
  const instruments: BootstrapInstrument[] = [
    { type: 'deposit', maturity: '2026-07-01', rate: 0.03 },
    { type: 'swap', maturity: '2028-01-01', rate: 0.032, fixedFrequency: 'semiannual' },
    { type: 'swap', maturity: '2031-01-01', rate: 0.035, fixedFrequency: 'semiannual' },
    { type: 'swap', maturity: '2036-01-01', rate: 0.038, fixedFrequency: 'semiannual' },
  ];
  const curve = curves.bootstrap(instruments, { referenceDate });

  it('par swaps price to ~par when discounted on the bootstrapped curve', () => {
    for (const inst of instruments) {
      if (inst.type !== 'swap') continue;
      // A par fixed-coupon bond at the swap rate should be worth ~100 on the curve.
      const bond = bonds.fixedRate({
        issueDate: referenceDate,
        maturityDate: inst.maturity,
        couponRate: inst.rate,
        frequency: inst.fixedFrequency ?? 'semiannual',
        dayCount: '30/360',
        faceValue: 100,
        // No `convention` override: the bootstrap discounts its fixed leg at the SAME
        // business-day-adjusted payment dates the schedule produces, so the matching par bond uses
        // the same default roll. (It used to need `convention: 'unadjusted'` to line up, because
        // the bootstrap discounted unadjusted period ends while every pricer used payment dates.)
      });
      const { dirtyPrice } = priceMultiCurve(bond, {
        settlementDate: referenceDate,
        discountCurve: curve,
      });
      // "A par swap ⇔ a par bond at 100" holds EXACTLY only while every payment date equals its
      // accrual end, because that is when the floating leg telescopes to `1 − DF(T)`. Several of
      // these schedule dates are weekends (2028-01-01 is a Saturday), so each rolled period leaves
      // `D(s)·[D(pay)/D(e) − 1]` behind: a few cents per 100 at most, and it is a bond-versus-swap
      // convention gap, not a curve error. This test used to pin 100 to 5e-5 by building the bond
      // `unadjusted` — which lined it up with the bootstrap's own unadjusted discounting and so
      // concealed exactly the defect being fixed here. The exact, roll-proof statement of the
      // calibration identity is the `swapValue` round-trip below, which holds to 1e-9.
      expect(dirtyPrice).toBeCloseTo(100, 1);
      expect(Math.abs(dirtyPrice - 100)).toBeLessThan(0.02);
    }
  });

  it('produces a monotone, sensible discount curve', () => {
    expect(curve.discount('2028-01-01')).toBeLessThan(curve.discount('2026-07-01'));
    expect(curve.discount('2036-01-01')).toBeLessThan(curve.discount('2031-01-01'));
    expect(curve.discount('2036-01-01')).toBeGreaterThan(0);
    expect(curve.zeroRate('2036-01-01')).toBeGreaterThan(curve.zeroRate('2028-01-01')); // upward curve
  });

  it('an OIS bootstrap satisfies the single-curve par identity', () => {
    const ois = curves.bootstrap(
      [
        { type: 'ois', maturity: '2027-01-01', rate: 0.03 },
        { type: 'ois', maturity: '2029-01-01', rate: 0.033 },
      ],
      { referenceDate },
    );
    // rate · Σ τ·DF = 1 − DF(T) at each pillar (annual fixed leg).
    const df1 = ois.discount('2027-01-01');
    const annuity1 = 1 * df1; // single annual period
    expect(0.03 * annuity1).toBeCloseTo(1 - df1, 8);
  });
});

describe('the single-curve bootstrap is self-consistent WITH swapValue (the pricer that consumes it)', () => {
  // The bootstrap and `swapValue` are the same claim stated twice: "these swaps are at par." The
  // bootstrap used to discount its fixed leg at the UNADJUSTED accrual end while `swapValue` used
  // the business-day-ADJUSTED payment date, so the curve it produced did not reprice its own input
  // swaps to zero — a calibration that silently failed its own definition. The residual was small
  // (sub-basis-point on these curves) and therefore invisible: exactly the kind of error that
  // survives review. Now they agree to machine precision.
  // Every maturity here is a business day, so no payment date rolls and the identity is exact.
  const MATURITIES = ['2029-01-01', '2031-01-01', '2036-01-01'] as const;
  const shapes: { name: string; rates: [number, number, number] }[] = [
    { name: 'flat', rates: [0.03, 0.03, 0.03] },
    { name: 'steep', rates: [0.02, 0.035, 0.05] },
    { name: 'inverted', rates: [0.055, 0.042, 0.035] },
  ];

  /** The swap `swapValue` prices, on the exact conventions `curves.bootstrap` assumes by default. */
  const asSwap = (maturityDate: string, fixedRate: number) => ({
    startDate: referenceDate,
    maturityDate,
    fixedRate,
    notional: 100,
    fixedFrequency: 'semiannual' as const,
    fixedDayCount: '30/360' as const,
    floatFrequency: 'quarterly' as const,
    floatDayCount: 'ACT/360' as const,
  });

  for (const shape of shapes) {
    it(`a ${shape.name} curve reprices every input swap to 0 per 100 notional`, () => {
      const instruments: BootstrapInstrument[] = MATURITIES.map((maturity, i) => ({
        type: 'swap',
        maturity,
        rate: shape.rates[i]!,
        fixedFrequency: 'semiannual',
      }));
      const curve = curves.bootstrap(instruments, { referenceDate });
      for (let i = 0; i < MATURITIES.length; i++) {
        const v = swapValue(asSwap(MATURITIES[i]!, shape.rates[i]!), { discountCurve: curve });
        expect(Math.abs(v.value)).toBeLessThan(1e-9);
      }
    });
  }

  it('an INTERIOR maturity whose terminal payment rolls keeps a small, bounded residual', () => {
    // 2028-01-01 is a Saturday, so this swap's last flow settles 2028-01-03 — AFTER the pillar the
    // bootstrap pins at its (unadjusted) maturity. A sequential bootstrap extrapolates past that
    // pillar while solving and interpolates through it once the longer pillars exist, so those two
    // dates cannot agree exactly. That is a property of pinning pillars at instrument maturities
    // (which key-rate reporting relies on), NOT the accrual-end/payment-date mismatch fixed above:
    // the residual is ~7e-5 per 100 instead of the ~2e-4 the mismatch contributed on top of it.
    // The terminal instrument is unaffected — its pillar is the last one either way.
    const instruments: BootstrapInstrument[] = [
      { type: 'swap', maturity: '2028-01-01', rate: 0.03, fixedFrequency: 'semiannual' },
      { type: 'swap', maturity: '2031-01-01', rate: 0.035, fixedFrequency: 'semiannual' },
    ];
    const curve = curves.bootstrap(instruments, { referenceDate });
    const rolled = Math.abs(swapValue(asSwap('2028-01-01', 0.03), { discountCurve: curve }).value);
    const terminal = Math.abs(
      swapValue(asSwap('2031-01-01', 0.035), { discountCurve: curve }).value,
    );
    expect(rolled).toBeGreaterThan(0); // honest: it is not exact
    expect(rolled).toBeLessThan(1e-4); // and it is bounded well inside a basis point of price
    expect(terminal).toBeLessThan(1e-9); // the last pillar stays exact
  });
});

describe('validation', () => {
  it('rejects an empty instrument set', () => {
    expect(() => curves.bootstrap([], { referenceDate })).toThrow(/at least one instrument/);
  });

  it('rejects an instrument maturing on or before the reference date', () => {
    expect(() =>
      curves.bootstrap([{ type: 'deposit', maturity: '2025-07-01', rate: 0.04 }], {
        referenceDate,
      }),
    ).toThrow(/not after the reference date/);
  });
});
