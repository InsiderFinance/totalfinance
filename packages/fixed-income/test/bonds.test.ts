/**
 * Tests for §14.1 bonds: fixed/zero/FRN/amortizing/inflation cash flows and the analytics suite —
 * clean/dirty price, accrued interest, YTM, yield-to-call, durations, convexity, DV01, and the
 * curve-based effective/key-rate measures. Verified against closed forms and finite-difference checks.
 */

import { describe, expect, it } from 'vitest';
import { ConvergenceError } from '@totalfinance/core';
import {
  bonds,
  curveMetrics,
  curves,
  priceFromYield,
  priceMultiCurve,
  yearFraction,
  yieldMetrics,
  yieldToCall,
  yieldToMaturity,
} from '@totalfinance/fixed-income';

describe('fixed-rate bond — par/yield relationships', () => {
  const bond = bonds.fixedRate({
    issueDate: '2026-01-01',
    maturityDate: '2031-01-01',
    couponRate: 0.05,
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });
  const settlementDate = '2026-01-01';

  it('prices to par when the yield equals the coupon', () => {
    const { dirtyPrice, cleanPrice, accruedInterest } = priceFromYield(bond, {
      settlementDate,
      yield: 0.05,
    });
    expect(accruedInterest).toBe(0); // settling on a coupon date
    expect(cleanPrice).toBeCloseTo(100, 8);
    expect(dirtyPrice).toBeCloseTo(100, 8);
  });

  it('prices below par above the coupon, above par below it', () => {
    expect(priceFromYield(bond, { settlementDate, yield: 0.06 }).cleanPrice).toBeLessThan(100);
    expect(priceFromYield(bond, { settlementDate, yield: 0.04 }).cleanPrice).toBeGreaterThan(100);
  });

  it('round-trips price → yield', () => {
    const price = priceFromYield(bond, { settlementDate, yield: 0.037 }).cleanPrice;
    expect(yieldToMaturity(bond, { settlementDate, price })).toBeCloseTo(0.037, 8);
  });

  it('emits 10 semiannual coupons of 2.5 plus principal at maturity', () => {
    const flows = bond.cashflows();
    expect(flows).toHaveLength(10);
    for (let i = 0; i < 9; i++) expect(flows[i]!.amount).toBeCloseTo(2.5, 9);
    expect(flows[9]!.amount).toBeCloseTo(102.5, 9);
  });
});

describe('duration, convexity, and DV01', () => {
  const bond = bonds.fixedRate({
    issueDate: '2026-01-01',
    maturityDate: '2036-01-01',
    couponRate: 0.04,
    frequency: 'semiannual',
    dayCount: '30/360',
  });
  const settlementDate = '2026-01-01';

  it('modified < Macaulay, convexity positive', () => {
    const m = yieldMetrics(bond, { settlementDate, yield: 0.04 });
    expect(m.modifiedDuration).toBeLessThan(m.macaulayDuration);
    expect(m.modifiedDuration).toBeCloseTo(m.macaulayDuration / (1 + 0.04 / 2), 10);
    expect(m.convexity).toBeGreaterThan(0);
    expect(m.macaulayDuration).toBeGreaterThan(7); // ~8y for a 10y 4% bond
    expect(m.macaulayDuration).toBeLessThan(9);
  });

  it('DV01 matches a central finite-difference of price w.r.t. yield', () => {
    const y = 0.04;
    const m = yieldMetrics(bond, { settlementDate, yield: y });
    const h = 1e-6;
    const pUp = priceFromYield(bond, { settlementDate, yield: y + h }).dirtyPrice;
    const pDn = priceFromYield(bond, { settlementDate, yield: y - h }).dirtyPrice;
    const dv01Numeric = (-(pUp - pDn) / (2 * h)) * 1e-4;
    expect(m.dv01).toBeCloseTo(dv01Numeric, 6);
    expect(m.pv01).toBe(m.dv01);
  });

  it('longer maturity ⇒ longer duration', () => {
    const short = bonds.fixedRate({
      issueDate: '2026-01-01',
      maturityDate: '2029-01-01',
      couponRate: 0.04,
      frequency: 'semiannual',
      dayCount: '30/360',
    });
    const dShort = yieldMetrics(short, { settlementDate, yield: 0.04 }).macaulayDuration;
    const dLong = yieldMetrics(bond, { settlementDate, yield: 0.04 }).macaulayDuration;
    expect(dLong).toBeGreaterThan(dShort);
  });
});

describe('accrued interest', () => {
  const bond = bonds.fixedRate({
    issueDate: '2026-01-01',
    maturityDate: '2028-01-01',
    couponRate: 0.05,
    frequency: 'semiannual',
    dayCount: '30/360',
  });

  it('is the coupon scaled by the elapsed 30/360 fraction of the period', () => {
    // Period [2026-07-01, 2027-01-01]; settle 2026-10-01 ⇒ half-elapsed ⇒ 2.5 × 0.5 = 1.25.
    expect(bond.accrued('2026-10-01')).toBeCloseTo(1.25, 9);
    expect(bond.accrued('2026-07-01')).toBeCloseTo(0, 9); // on a coupon date
  });

  it('clean = dirty − accrued', () => {
    const { dirtyPrice, cleanPrice, accruedInterest } = priceFromYield(bond, {
      settlementDate: '2026-10-01',
      yield: 0.05,
    });
    expect(accruedInterest).toBeCloseTo(1.25, 9);
    expect(cleanPrice).toBeCloseTo(dirtyPrice - accruedInterest, 12);
  });
});

describe('zero-coupon bond', () => {
  const bond = bonds.zeroCoupon({
    issueDate: '2026-01-01',
    maturityDate: '2031-01-01',
    faceValue: 100,
    frequency: 'annual',
    dayCount: 'ACT/365F',
  });

  it('is a single redemption flow and prices as face/(1+y)^t', () => {
    expect(bond.cashflows()).toHaveLength(1);
    const y = 0.04;
    const { dirtyPrice } = priceFromYield(bond, { settlementDate: '2026-01-01', yield: y });
    const t = (Date.UTC(2031, 0, 1) - Date.UTC(2026, 0, 1)) / (365 * 86_400_000);
    expect(dirtyPrice).toBeCloseTo(100 * Math.pow(1 + y, -t), 8);
    expect(dirtyPrice).toBeLessThan(100);
  });

  it('round-trips its yield', () => {
    const price = priceFromYield(bond, { settlementDate: '2026-01-01', yield: 0.045 }).cleanPrice;
    expect(yieldToMaturity(bond, { settlementDate: '2026-01-01', price })).toBeCloseTo(0.045, 8);
  });

  it('rejects an impossible yield that drives the actuarial base ≤ 0 (PR review)', () => {
    // A one-year zero at y = −2 (annual) has base 1 + y/f = −1; the old math returned dirtyPrice −100.
    expect(() => priceFromYield(bond, { settlementDate: '2026-01-01', yield: -2 })).toThrow(
      /actuarial base|non-positive/,
    );
    expect(() => yieldMetrics(bond, { settlementDate: '2026-01-01', yield: -2 })).toThrow(
      /actuarial base|non-positive/,
    );
    expect(() => priceFromYield(bond, { settlementDate: '2026-01-01', yield: Number.NaN })).toThrow(
      /finite/,
    );
  });
});

describe('distressed yields — the solver bracket expands instead of blaming itself', () => {
  const zero = bonds.zeroCoupon({
    issueDate: '2026-01-15',
    maturityDate: '2027-01-15',
    faceValue: 100,
    frequency: 'annual',
    dayCount: '30/360',
  });
  const settlementDate = '2026-01-15';

  it('solves a 1y zero quoted at 40 → 150% (hand math: 40 = 100/(1+y) ⇒ y = 1.5)', () => {
    // The bracket was hard-coded to [−0.99·f, 1]. Every distressed bond's yield lives above it, so
    // Brent found no sign change and the caller was told the solve "did not converge" — a true
    // statement naming the wrong cause. There is nothing wrong with a 150% yield.
    const y = yieldToMaturity(zero, { settlementDate, price: 40 });
    expect(y).toBeCloseTo(1.5, 9);
    // And it really reprices: 100/(1 + 1.5) = 40.
    expect(priceFromYield(zero, { settlementDate, yield: y }).cleanPrice).toBeCloseTo(40, 8);
  });

  it('reports honest solver diagnostics through .explain() on the expanded bracket', () => {
    const explained = yieldToMaturity.explain(zero, { settlementDate, price: 40 });
    expect(explained.value).toBeCloseTo(1.5, 9);
    expect(explained.diagnostics.converged).toBe(true);
    expect(explained.diagnostics.method).toBe('brent');
  });

  it('past the 1000% cap the error names the bracket SEARCHED, not "did not converge"', () => {
    // 100/(1+y) = 5 ⇒ y = 1900%, past any yield worth quoting: a price that far from the flows is
    // a typo or a bond quoted in points upfront, and a four-digit percentage would launder that.
    const solve = (): unknown => yieldToMaturity(zero, { settlementDate, price: 5 });
    expect(solve).toThrowError(ConvergenceError);
    expect(solve).toThrowError(/no yield in the bracket searched/);
    expect(solve).toThrowError(/1000\.0%/);
    expect(solve).not.toThrowError(/did not converge/);
    try {
      solve();
      expect.unreachable('yieldToMaturity should have thrown');
    } catch (error) {
      const e = error as ConvergenceError;
      expect(e.code).toBe('solver.no_convergence');
      expect(e.context?.['bracketSearched']).toEqual([-0.99, 10]);
    }
  });

  it('yieldToCall expands the same way', () => {
    const distressed = bonds.fixedRate({
      issueDate: '2026-01-15',
      maturityDate: '2031-01-15',
      couponRate: 0.05,
      frequency: 'semiannual',
      faceValue: 100,
      dayCount: '30/360',
    });
    // Called at par in a year, bought at 45: the yield to call is well past 100%.
    const y = yieldToCall(
      distressed,
      { callDate: '2027-01-15', callPrice: 100 },
      { settlementDate, price: 45 },
    );
    expect(y).toBeGreaterThan(1.0);
    expect(Number.isFinite(y)).toBe(true);
    // H05: the explain twin mirrors yieldToMaturity.explain — the SAME scalar, solver facts in
    // diagnostics, the resolved call price and settlement accrued in the decomposition, and the
    // call/price basis echoed in assumptions.
    const explained = yieldToCall.explain(
      distressed,
      { callDate: '2027-01-15', callPrice: 100 },
      { settlementDate, price: 45 },
    );
    expect(explained.value).toBeCloseTo(y, 15);
    expect(explained.assumptions.callDate).toBe('2027-01-15');
    expect(explained.assumptions.priceType).toBe('clean');
    expect(explained.diagnostics.method).toBe('brent');
    expect(explained.diagnostics.iterations).toBeGreaterThan(0);
    expect(explained.diagnostics.decomposition!['resolvedCallPrice']).toBe(100);
    expect(Number.isFinite(explained.diagnostics.decomposition!['accruedInterest']!)).toBe(true);
  });
});

describe('suspicious coupon rate (input.suspicious_coupon_rate)', () => {
  // `couponRate: 5` is a 500% coupon. It prices, it solves, and every duration and DV01 that comes
  // out is nonsense — with nothing in the result to say so. Mirrors core's plausibilityWarnings:
  // informational, never thrown, threshold at 100% because distressed/EM paper really does pay
  // above par-coupon rates.
  const typo = bonds.fixedRate({
    issueDate: '2026-01-01',
    maturityDate: '2031-01-01',
    couponRate: 5, // meant 5%
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });
  const sane = bonds.fixedRate({
    issueDate: '2026-01-01',
    maturityDate: '2031-01-01',
    couponRate: 0.05,
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });
  const settlementDate = '2026-01-01';

  it('flags a percent typed as a decimal on the analysis paths', () => {
    const price = priceFromYield(typo, { settlementDate, yield: 0.05 });
    expect(price.diagnostics.warnings).toHaveLength(1);
    const w = price.diagnostics.warnings[0]!;
    expect(w.code).toBe('input.suspicious_coupon_rate');
    expect(w.severity).toBe('info');
    expect(w.message).toMatch(/500%/);
    expect(w.message).toMatch(/did you mean 0\.0500/);
    expect(w.context).toEqual({ couponRate: 5 });
    // The VALUE is untouched — this teaches, it does not second-guess the caller.
    expect(price.dirtyPrice).toBeGreaterThan(1000);
  });

  it('rides every analysis surface, including the explain envelopes', () => {
    const codes = (warnings: { code: string }[]): string[] => warnings.map((x) => x.code);
    expect(codes(yieldMetrics(typo, { settlementDate, yield: 0.05 }).diagnostics.warnings)).toEqual(
      ['input.suspicious_coupon_rate'],
    );
    expect(
      codes(yieldMetrics.explain(typo, { settlementDate, yield: 0.05 }).diagnostics.warnings),
    ).toEqual(['input.suspicious_coupon_rate']);
    expect(
      codes(yieldToMaturity.explain(typo, { settlementDate, price: 500 }).diagnostics.warnings),
    ).toEqual(['input.suspicious_coupon_rate']);
    const curve = curves.flat({ rate: 0.04, referenceDate: settlementDate });
    expect(
      codes(priceMultiCurve(typo, { settlementDate, discountCurve: curve }).diagnostics.warnings),
    ).toEqual(['input.suspicious_coupon_rate']);
    expect(codes(curveMetrics(typo, curve, { settlementDate }).diagnostics.warnings)).toEqual([
      'input.suspicious_coupon_rate',
    ]);
  });

  it('stays silent on a normal coupon (a diagnostic that always fires is noise)', () => {
    expect(priceFromYield(sane, { settlementDate, yield: 0.05 }).diagnostics.warnings).toEqual([]);
    expect(yieldMetrics(sane, { settlementDate, yield: 0.05 }).diagnostics.warnings).toEqual([]);
    // A 100% coupon is the boundary and is NOT flagged; 101% is.
    const par = bonds.fixedRate({
      ...{
        issueDate: '2026-01-01',
        maturityDate: '2031-01-01',
        frequency: 'semiannual' as const,
        faceValue: 100,
        dayCount: '30/360' as const,
      },
      couponRate: 1,
    });
    expect(priceFromYield(par, { settlementDate, yield: 0.05 }).diagnostics.warnings).toEqual([]);
  });
});

describe('floating-rate note', () => {
  const issueDate = '2026-01-02';
  const ref = '2026-01-02';
  const forecast = curves.flat({
    rate: 0.03,
    referenceDate: ref,
    options: { dayCount: 'ACT/360' },
  });
  const frn = bonds.floatingRateNote({
    issueDate,
    maturityDate: '2029-01-02',
    couponRate: 0, // unused — coupons project off the curve
    frequency: 'quarterly',
    dayCount: 'ACT/360',
    spread: 0,
  });

  it('prices near par at issue (spread 0, discount = forecast curve)', () => {
    const { dirtyPrice } = priceMultiCurve(frn, {
      settlementDate: issueDate,
      discountCurve: forecast,
      forecastCurve: forecast,
    });
    expect(dirtyPrice).toBeCloseTo(100, 1); // par to within rounding/payment-lag basis
  });

  it('has near-zero effective duration (coupons reset with rates)', () => {
    const m = curveMetrics(frn, forecast, {
      settlementDate: issueDate,
      context: { forecastCurve: forecast },
    });
    expect(Math.abs(m.effectiveDuration)).toBeLessThan(0.4); // << a fixed 3y bond's ~2.8y
  });

  it('throws if no forecast curve is supplied', () => {
    expect(() => frn.cashflows()).toThrow(/forecastCurve/);
  });

  describe('settling MID-PERIOD (the in-progress coupon is already fixed)', () => {
    // The note resets quarterly from 2026-01-02. Settle 2026-02-02, one month into the first
    // period: that coupon was FIXED on 2026-01-02, before any curve a trader has today reaches.
    const settle = '2026-02-02';
    const midCurve = curves.flat({
      rate: 0.03,
      referenceDate: settle,
      options: { dayCount: 'ACT/360' },
    });

    it('names knownFixingRate instead of leaking the raw curve error', () => {
      // Before: `Curve query before reference date (t=-0.0833…)` — a correct refusal from the
      // curve and a useless message from the FRN, naming nothing the caller could supply.
      expect(() => frn.cashflows({ forecastCurve: midCurve })).toThrow(/context\.knownFixingRate/);
      expect(() => frn.cashflows({ forecastCurve: midCurve })).toThrow(/FIXED on 2026-01-02/);
      expect(() => frn.cashflows({ forecastCurve: midCurve })).not.toThrow(
        /Curve query before reference date/,
      );
      expect(() =>
        priceMultiCurve(frn, {
          settlementDate: settle,
          discountCurve: midCurve,
          forecastCurve: midCurve,
        }),
      ).toThrow(/knownFixingRate/);
    });

    it('prices with the supplied fixing (hand-computed first coupon)', () => {
      const flows = frn.cashflows({ forecastCurve: midCurve, knownFixingRate: 0.045 });
      // First coupon: the KNOWN 4.5% fixing over 2026-01-02 → 2026-04-02 (90 actual days, ACT/360).
      const accrual = yearFraction('2026-01-02', '2026-04-02', 'ACT/360');
      expect(accrual).toBeCloseTo(90 / 360, 12);
      expect(flows[0]!.interest).toBeCloseTo(0.045 * 100 * accrual, 12);
      expect(flows[0]!.interest).toBeCloseTo(1.125, 10); // 4.5% × 100 × 0.25
      // Every LATER coupon still projects off the curve — the fixing is not smeared forward.
      const projected = midCurve.forwardRate('2026-04-02', '2026-07-02', 'ACT/360');
      expect(flows[1]!.interest).toBeCloseTo(
        projected * 100 * yearFraction('2026-04-02', '2026-07-02', 'ACT/360'),
        12,
      );
      expect(flows[1]!.interest).not.toBeCloseTo(flows[0]!.interest, 6);
      // Accrued at settlement uses the same fixed coupon: 31 of 90 days elapsed.
      expect(frn.accrued(settle, { forecastCurve: midCurve, knownFixingRate: 0.045 })).toBeCloseTo(
        1.125 * (31 / 90),
        10,
      );
      // And the note prices, which is the whole point.
      const { dirtyPrice, cleanPrice } = priceMultiCurve(frn, {
        settlementDate: settle,
        discountCurve: midCurve,
        forecastCurve: midCurve,
        knownFixingRate: 0.045,
      });
      expect(dirtyPrice).toBeGreaterThan(99);
      expect(dirtyPrice).toBeLessThan(102);
      expect(cleanPrice).toBeCloseTo(dirtyPrice - 1.125 * (31 / 90), 10);
    });

    it('the fixing carries the quoted spread on top, like a projected coupon', () => {
      const spreadNote = bonds.floatingRateNote({
        issueDate,
        maturityDate: '2029-01-02',
        couponRate: 0,
        frequency: 'quarterly',
        dayCount: 'ACT/360',
        spread: 0.0025,
      });
      const flows = spreadNote.cashflows({ forecastCurve: midCurve, knownFixingRate: 0.045 });
      const accrual = yearFraction('2026-01-02', '2026-04-02', 'ACT/360');
      expect(flows[0]!.interest).toBeCloseTo((0.045 + 0.0025) * 100 * accrual, 12);
    });

    it('rejects a fixing that cannot be a rate, and a strip of fully-past coupons', () => {
      expect(() => frn.cashflows({ forecastCurve: midCurve, knownFixingRate: Number.NaN })).toThrow(
        /knownFixingRate must be a finite/,
      );
      // One fixing cannot honestly stand in for coupons that both began AND ended in the past.
      const seasoned = curves.flat({
        rate: 0.03,
        referenceDate: '2026-08-02',
        options: { dayCount: 'ACT/360' },
      });
      expect(() => frn.cashflows({ forecastCurve: seasoned, knownFixingRate: 0.045 })).toThrow(
        /ended before/,
      );
    });
  });
});

describe('amortizing bond', () => {
  it('straight-line: equal principal, declining interest, principal sums to face', () => {
    const bond = bonds.amortizing({
      issueDate: '2026-01-01',
      maturityDate: '2031-01-01',
      couponRate: 0.06,
      frequency: 'annual',
      faceValue: 100,
      dayCount: '30/360',
      amortization: { type: 'straight' },
    });
    const flows = bond.cashflows();
    expect(flows).toHaveLength(5);
    expect(flows.reduce((s, f) => s + f.principal, 0)).toBeCloseTo(100, 8);
    for (const f of flows) expect(f.principal).toBeCloseTo(20, 8);
    // Interest declines as the balance amortizes: first 6.0 on 100, then 4.8 on 80, …
    expect(flows[0]!.interest).toBeCloseTo(6.0, 8);
    expect(flows[1]!.interest).toBeCloseTo(4.8, 8);
    expect(flows[0]!.notional).toBeCloseTo(100, 8);
    expect(flows[1]!.notional).toBeCloseTo(80, 8);
  });

  it('annuity: level total payment, principal still sums to face', () => {
    const bond = bonds.amortizing({
      issueDate: '2026-01-01',
      maturityDate: '2031-01-01',
      couponRate: 0.06,
      frequency: 'annual',
      faceValue: 100,
      dayCount: '30/360',
      amortization: { type: 'annuity' },
    });
    const flows = bond.cashflows();
    expect(flows.reduce((s, f) => s + f.principal, 0)).toBeCloseTo(100, 6);
    // Level payments (except a tiny final rounding clean-up).
    for (let i = 0; i < flows.length - 1; i++) {
      expect(flows[i]!.amount).toBeCloseTo(flows[0]!.amount, 6);
    }
  });

  it('rejects an explicit principal schedule that does not sum to face', () => {
    expect(() =>
      bonds
        .amortizing({
          issueDate: '2026-01-01',
          maturityDate: '2029-01-01',
          couponRate: 0.05,
          frequency: 'annual',
          faceValue: 100,
          amortization: { principalByPeriod: [10, 10, 10] }, // sums to 30, not 100
        })
        .cashflows(),
    ).toThrow(/face value/);
  });
});

describe('inflation-linked bond', () => {
  const bond = bonds.inflationLinked({
    issueDate: '2026-01-01',
    maturityDate: '2029-01-01',
    couponRate: 0.02,
    frequency: 'annual',
    faceValue: 100,
    dayCount: 'ACT/ACT',
    baseIndex: 250,
  });

  it('scales coupons and principal by the index ratio', () => {
    // A flat 5% inflation path compounding annually off the base index.
    const referenceIndex = (date: string): number => {
      const years =
        (Date.UTC(Number(date.slice(0, 4)), 0, 1) - Date.UTC(2026, 0, 1)) / (365.25 * 86_400_000);
      return 250 * Math.pow(1.05, years);
    };
    const flows = bond.cashflows({ referenceIndex });
    // Final principal is uplifted by ~1.05^3 ≈ 1.1576.
    expect(flows[flows.length - 1]!.principal).toBeGreaterThan(114);
    expect(flows[flows.length - 1]!.principal).toBeLessThan(117);
    // Each coupon grows with the index.
    expect(flows[1]!.interest).toBeGreaterThan(flows[0]!.interest);
  });

  it('applies the deflation floor to principal', () => {
    const floored = bonds.inflationLinked({
      issueDate: '2026-01-01',
      maturityDate: '2027-01-01',
      couponRate: 0.02,
      frequency: 'annual',
      faceValue: 100,
      baseIndex: 250,
      deflationFloor: true,
    });
    const deflation = (): number => 200; // index fell below base ⇒ ratio 0.8
    const flows = floored.cashflows({ referenceIndex: deflation });
    expect(flows[flows.length - 1]!.principal).toBeCloseTo(100, 8); // floored at par
  });
});

describe('yield to call', () => {
  const bond = bonds.fixedRate({
    issueDate: '2026-01-01',
    maturityDate: '2036-01-01',
    couponRate: 0.06,
    frequency: 'semiannual',
    dayCount: '30/360',
  });

  it('a premium bond callable at par yields less to call than to maturity', () => {
    // Trading at a premium (low yield) — being called early at par hurts the realised yield.
    const price = priceFromYield(bond, { settlementDate: '2026-01-01', yield: 0.04 }).cleanPrice;
    const ytm = yieldToMaturity(bond, { settlementDate: '2026-01-01', price });
    const ytc = yieldToCall(
      bond,
      { callDate: '2031-01-01', callPrice: 100 },
      { settlementDate: '2026-01-01', price },
    );
    expect(ytc).toBeLessThan(ytm);
  });

  it('bullet bonds: the default call price is the face value (outstanding = face)', () => {
    const price = priceFromYield(bond, { settlementDate: '2026-01-01', yield: 0.04 }).cleanPrice;
    const explicit = yieldToCall(
      bond,
      { callDate: '2031-01-01', callPrice: 100 },
      { settlementDate: '2026-01-01', price },
    );
    const defaulted = yieldToCall(
      bond,
      { callDate: '2031-01-01' },
      { settlementDate: '2026-01-01', price },
    );
    expect(defaulted).toBeCloseTo(explicit, 12);
  });
});

describe('yield to call — amortizing callables (scheduled principal + outstanding-notional call)', () => {
  // Two annual periods, straight amortization: flows are
  //   2027-01-01: interest 10 (10% on 100), principal 50, notional 100
  //   2028-01-01: interest  5 (10% on  50), principal 50, notional  50
  const amortizer = bonds.amortizing({
    issueDate: '2026-01-01',
    maturityDate: '2028-01-01',
    couponRate: 0.1,
    frequency: 'annual',
    faceValue: 100,
    dayCount: '30/360',
    amortization: { type: 'straight' },
  });
  const settlementDate = '2026-01-01'; // settling on the issue date ⇒ accrued 0, clean = dirty

  it('called on a coupon date: pays that coupon plus the FULL outstanding balance (hand-computed)', () => {
    // Called 2027-01-01: the holder receives interest 10 + outstanding 100 = 110, one year out.
    // Price 104 ⇒ y = 110/104 − 1.
    const y = yieldToCall(amortizer, { callDate: '2027-01-01' }, { settlementDate, price: 104 });
    expect(y).toBeCloseTo(110 / 104 - 1, 10);
  });

  it('keeps scheduled amortization BEFORE the call date (hand-computed mid-period call)', () => {
    // Called 2027-07-01 (t = 1.5 under 30/360): the holder still receives the scheduled
    // 2027-01-01 flow of 60 (interest 10 + principal 50), then at the call date the outstanding
    // 50 PLUS the coupon accrued over the half-period since 2027-01-01 — 10% on the outstanding
    // 50 for 180/360 = 2.5. At y = 5%: PV = 60/1.05 + 52.5/1.05^1.5.
    const target = 60 / 1.05 + 52.5 / Math.pow(1.05, 1.5);
    const y = yieldToCall(amortizer, { callDate: '2027-07-01' }, { settlementDate, price: target });
    expect(y).toBeCloseTo(0.05, 8);
  });

  it('a mid-period call pays the accrued coupon, not bare principal (regression)', () => {
    // The redemption-only cash flow the old code built is 2.5 light at t = 1.5, so pricing the
    // TRUE flows and asking for the yield to call must NOT return the redemption-only answer.
    const truePrice = 60 / 1.05 + 52.5 / Math.pow(1.05, 1.5);
    const redemptionOnlyPrice = 60 / 1.05 + 50 / Math.pow(1.05, 1.5);
    expect(truePrice - redemptionOnlyPrice).toBeCloseTo(2.5 / Math.pow(1.05, 1.5), 12);
    // Priced at the redemption-only PV, the yield to call must come out ABOVE 5%: the buyer pays
    // less than the flows are worth. The old code returned exactly 5% here — it had forfeited the
    // accrued coupon on both sides of the equation.
    const y = yieldToCall(
      amortizer,
      { callDate: '2027-07-01' },
      { settlementDate, price: redemptionOnlyPrice },
    );
    expect(y).toBeGreaterThan(0.05 + 1e-4);
    expect(y).toBeCloseTo(0.069107754179162, 9);
  });

  it('an explicit callPrice overrides the derived outstanding balance', () => {
    // Premium call at 102 on the 2027-01-01 coupon date: 10 + 102 = 112 one year out.
    const y = yieldToCall(
      amortizer,
      { callDate: '2027-01-01', callPrice: 102 },
      { settlementDate, price: 104 },
    );
    expect(y).toBeCloseTo(112 / 104 - 1, 10);
  });

  it('the pre-fix cash-flow model (zeroed pre-call principal, face redemption) was materially wrong', () => {
    // For the mid-period call the old code dropped the 2027-01-01 principal of 50 and redeemed
    // face 100: old PV = 10/1.05 + 100/1.05^1.5 vs true PV = 60/1.05 + 52.5/1.05^1.5.
    const target = 60 / 1.05 + 52.5 / Math.pow(1.05, 1.5);
    const oldModel = 10 / 1.05 + 100 / Math.pow(1.05, 1.5);
    expect(Math.abs(oldModel - target)).toBeGreaterThan(1); // > 1 point of price
    const y = yieldToCall(amortizer, { callDate: '2027-07-01' }, { settlementDate, price: target });
    expect(y).toBeCloseTo(0.05, 8); // the fixed model round-trips the true 5% yield
  });

  it('throws a teaching error when the outstanding balance is not derivable', () => {
    // A call date past every scheduled flow: nothing pins the outstanding notional.
    expect(() =>
      yieldToCall(amortizer, { callDate: '2030-01-01' }, { settlementDate, price: 100 }),
    ).toThrow(/callPrice/);
  });

  it('the non-derivable case still works with an explicit callPrice', () => {
    // Same call date, caller supplies the redemption amount: flows 60 @ t=1, 55 @ t=2, 25 @ t=4.
    const target = 60 / 1.05 + 55 / Math.pow(1.05, 2) + 25 / Math.pow(1.05, 4);
    const y = yieldToCall(
      amortizer,
      { callDate: '2030-01-01', callPrice: 25 },
      { settlementDate, price: target },
    );
    expect(y).toBeCloseTo(0.05, 8);
  });
});

describe('curve-based metrics', () => {
  const bond = bonds.fixedRate({
    issueDate: '2026-01-01',
    maturityDate: '2033-01-01',
    couponRate: 0.04,
    frequency: 'semiannual',
    dayCount: '30/360',
  });
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.035],
      ['2030-01-01', 0.04],
      ['2033-01-01', 0.043],
    ],
    { referenceDate: '2026-01-01' },
  );

  it('key-rate durations sum to the parallel (effective) duration', () => {
    const m = curveMetrics(bond, curve, { settlementDate: '2026-01-01' });
    expect(m.effectiveDuration).toBeGreaterThan(0);
    expect(m.effectiveConvexity).toBeGreaterThan(0);
    const krdSum = m.keyRateDurations.reduce((s, k) => s + k.duration, 0);
    expect(krdSum).toBeCloseTo(m.effectiveDuration, 4);
  });

  it('effective duration ≈ Macaulay duration at the curve-implied yield', () => {
    const m = curveMetrics(bond, curve, { settlementDate: '2026-01-01' });
    const ytm = yieldToMaturity(bond, { settlementDate: '2026-01-01', price: m.cleanPrice });
    const macaulay = yieldMetrics(bond, {
      settlementDate: '2026-01-01',
      yield: ytm,
    }).macaulayDuration;
    expect(m.effectiveDuration).toBeCloseTo(macaulay, 1); // continuous-curve effective ≈ Macaulay
  });

  it('key-rate durations are labelled with the EXACT curve input dates under ACT/360', () => {
    // Pre-fix, pillar dates were reconstructed on a hardcoded 365-day basis, so an ACT/360 curve
    // reported key-rate dates that drifted days away from the dates the caller bootstrapped with.
    const dates = ['2027-01-01', '2030-01-01', '2033-01-01'];
    const act360 = curves.fromZeroRates(
      dates.map((d, i) => [d, 0.035 + i * 0.004] as const),
      { referenceDate: '2026-01-01', dayCount: 'ACT/360' },
    );
    const m = curveMetrics(bond, act360, { settlementDate: '2026-01-01' });
    expect(m.keyRateDurations.map((k) => k.date)).toEqual(dates);
  });
});

describe('priceMultiCurve input hardening (deep-sweep boundary)', () => {
  const bond = bonds.fixedRate({
    issueDate: '2026-01-01',
    maturityDate: '2031-01-01',
    couponRate: 0.05,
    frequency: 'semiannual',
    faceValue: 100,
    dayCount: '30/360',
  });
  const curve = curves.flat({
    rate: 0.04,
    referenceDate: '2026-01-01',
    options: { dayCount: 'ACT/365F' },
  });

  it('names a missing or raw discountCurve instead of dying on the first discount() call', () => {
    expect(() => priceMultiCurve(bond, { settlementDate: '2026-01-01' } as never)).toThrow(
      /priceMultiCurve: options\.discountCurve/,
    );
    expect(() =>
      priceMultiCurve(bond, { settlementDate: '2026-01-01', discountCurve: {} } as never),
    ).toThrow(/priceMultiCurve: expected a curve built by curves\.fromZeroRates/);
  });

  it('validates the optional forecastCurve when supplied', () => {
    expect(() =>
      priceMultiCurve(bond, {
        settlementDate: '2026-01-01',
        discountCurve: curve,
        forecastCurve: {} as never,
      }),
    ).toThrow(/priceMultiCurve: expected a curve built by curves\.fromZeroRates/);
  });
});
