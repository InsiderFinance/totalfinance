/**
 * Tests for §14.1/14.3 lattice instruments: callable/putable bonds (option value, no-call limit, OAS)
 * and Bermudan swaptions (positivity, exercise-set and volatility monotonicity) on the short-rate tree.
 */

import { describe, expect, it } from 'vitest';
import { ConvergenceError } from '@totalfinance/core';
import {
  bermudanSwaption,
  bonds,
  callableBond,
  curves,
  oasAnalytics,
  priceMultiCurve,
} from '@totalfinance/fixed-income';

const ref = '2026-01-01';
const flat4 = curves.flat({ rate: 0.04, referenceDate: ref, options: { dayCount: 'ACT/365F' } });

const premiumBond = bonds.fixedRate({
  issueDate: ref,
  maturityDate: '2031-01-01',
  couponRate: 0.05, // 5% coupon vs 4% curve ⇒ trades above par
  frequency: 'semiannual',
  dayCount: '30/360',
  faceValue: 100,
});

describe('callable bond', () => {
  const calls = [
    { date: '2028-01-01', price: 102 },
    { date: '2029-01-01', price: 101 },
    { date: '2030-01-01', price: 100 },
  ];

  it('is worth less than the otherwise-identical straight bond (positive option value)', () => {
    const r = callableBond({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
    });
    expect(r.optionValue).toBeGreaterThan(0);
    expect(r.price).toBeLessThan(r.straightPrice);
    expect(r.effectiveDuration).toBeGreaterThan(0);
  });

  it('the tree straight price matches the curve-discounted bond price', () => {
    const r = callableBond({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
      stepsPerYear: 48,
    });
    const curvePrice = priceMultiCurve(premiumBond, {
      settlementDate: ref,
      discountCurve: flat4,
    }).dirtyPrice;
    expect(r.straightPrice).toBeCloseTo(curvePrice, 0); // within tree discretization / date snapping
  });

  it('an unreachable call strike leaves the bond ≈ straight (no option value)', () => {
    const r = callableBond({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls: [{ date: '2029-01-01', price: 1e6 }],
    });
    expect(Math.abs(r.optionValue)).toBeLessThan(1e-6);
  });

  it('recovers ~zero OAS when the market price equals the model price', () => {
    const model = callableBond({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
    });
    const withOas = callableBond({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
      marketPrice: model.price,
    });
    expect(withOas.oas).toBeCloseTo(0, 6);
  });

  it('a putable bond is worth more than the straight bond', () => {
    const r = callableBond({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      puts: [{ date: '2029-01-01', price: 100 }],
    });
    expect(r.price).toBeGreaterThan(r.straightPrice);
    expect(r.optionValue).toBeLessThan(0);
  });

  it('requires at least one option', () => {
    expect(() =>
      callableBond({ bond: premiumBond, curve: flat4, meanReversion: 0.05, sigma: 0.01 }),
    ).toThrow(/call or put/);
  });
});

describe('Bermudan swaption', () => {
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.035],
      ['2032-01-01', 0.04],
    ],
    { referenceDate: ref },
  );
  const base = {
    curve,
    maturityDate: '2031-01-01',
    fixedRate: 0.035,
    optionType: 'payer' as const,
    meanReversion: 0.05,
    sigma: 0.01,
    fixedFrequency: 'semiannual' as const,
  };

  it('is positive and increases as exercise opportunities are added', () => {
    const few = bermudanSwaption({ ...base, exerciseDates: ['2028-01-01'] });
    const many = bermudanSwaption({
      ...base,
      exerciseDates: ['2027-01-01', '2028-01-01', '2029-01-01', '2030-01-01'],
    });
    expect(few.price).toBeGreaterThan(0);
    expect(many.price).toBeGreaterThanOrEqual(few.price - 1e-9);
  });

  it('increases with volatility', () => {
    const lo = bermudanSwaption({
      ...base,
      sigma: 0.008,
      exerciseDates: ['2028-01-01', '2029-01-01'],
    });
    const hi = bermudanSwaption({
      ...base,
      sigma: 0.02,
      exerciseDates: ['2028-01-01', '2029-01-01'],
    });
    expect(hi.price).toBeGreaterThan(lo.price);
  });

  it('a deep out-of-the-money payer is worth less than an at-the-money one', () => {
    const ex = ['2028-01-01', '2029-01-01'];
    const atm = bermudanSwaption({ ...base, fixedRate: 0.035, exerciseDates: ex });
    const otm = bermudanSwaption({ ...base, fixedRate: 0.08, exerciseDates: ex });
    expect(otm.price).toBeLessThan(atm.price);
  });
});

describe('oasAnalytics', () => {
  const calls = [
    { date: '2028-01-01', price: 102 },
    { date: '2029-01-01', price: 101 },
    { date: '2030-01-01', price: 100 },
  ];
  const model = callableBond({
    bond: premiumBond,
    curve: flat4,
    meanReversion: 0.05,
    sigma: 0.01,
    calls,
  });

  it('decomposes a callable: positive option cost (oas < zSpread), agreeing with callableBond OAS', () => {
    const market = model.price - 1.5; // trade below the model ⇒ positive OAS
    const r = oasAnalytics({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
      marketPrice: market,
    });
    expect(r.oas).toBeLessThan(r.zSpread); // the holder is short the call
    expect(r.optionCost).toBeCloseTo(r.zSpread - r.oas, 15);
    expect(r.optionCost).toBeGreaterThan(0);
    expect(r.marketPrice).toBe(market);
    expect(r.modelPrice).toBeCloseTo(model.price, 8); // the no-spread price
    // The OAS matches the one callableBond's own solver produces.
    const viaCallable = callableBond({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
      marketPrice: market,
    });
    expect(r.oas).toBeCloseTo(viaCallable.oas!, 8);
  });

  describe('over a non-flat spread curve (Wave 1.2)', () => {
    const market = model.price - 1.5;
    const baseSpecification = {
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
      marketPrice: market,
    };

    it('a zero spread curve leaves the OAS unchanged (backward compatible)', () => {
      const plain = oasAnalytics(baseSpecification).oas;
      const withZero = oasAnalytics({
        ...baseSpecification,
        spreadCurve: curves.flat({ rate: 0, referenceDate: ref }),
      }).oas;
      expect(withZero).toBeCloseTo(plain, 8);
    });

    it('a FLAT spread σ shifts the OAS by exactly −σ (the constant absorbs into the OAS)', () => {
      const sigma = 0.005;
      const plain = oasAnalytics(baseSpecification).oas;
      const withFlat = oasAnalytics({
        ...baseSpecification,
        spreadCurve: curves.flat({ rate: sigma, referenceDate: ref }),
      }).oas;
      expect(withFlat).toBeCloseTo(plain - sigma, 6);
    });

    it('a NON-FLAT spread curve is applied (OAS drops, disclosed in diagnostics.method)', () => {
      const plain = oasAnalytics(baseSpecification);
      const spreadCurve = curves.fromZeroRates(
        [
          ['2028-01-01', 0.006],
          ['2031-01-01', 0.012],
        ],
        { referenceDate: ref },
      );
      const r = oasAnalytics({ ...baseSpecification, spreadCurve });
      // Adding a positive spread curve to the benchmark raises discounting ⇒ lower residual OAS.
      expect(r.oas).toBeLessThan(plain.oas);
      expect(r.diagnostics.method).toMatch(/benchmark\+spreadCurve/);
      // Option cost keeps its meaning — zSpread − oas over the SAME combined benchmark.
      expect(r.optionCost).toBeCloseTo(r.zSpread - r.oas, 12);
    });

    it('rejects a spread curve whose reference date does not match the benchmark', () => {
      const bad = curves.flat({ rate: 0.005, referenceDate: '2026-06-01' });
      expect(() => oasAnalytics({ ...baseSpecification, spreadCurve: bad })).toThrow(/reference/i);
    });
  });

  it('reports OAS-consistent effective duration (positive) and convexity, distinct from the model duration', () => {
    const market = model.price - 1.5;
    const r = oasAnalytics({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
      marketPrice: market,
    });
    expect(r.effectiveDuration).toBeGreaterThan(0);
    expect(Number.isFinite(r.effectiveConvexity)).toBe(true);
    // The OAS duration holds the spread fixed, so it differs from callableBond's zero-spread model duration.
    expect(r.effectiveDuration).not.toBeCloseTo(model.effectiveDuration, 2);
    // A custom shock still produces a finite, positive duration.
    const wide = oasAnalytics({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
      marketPrice: market,
      durationShock: 5e-4,
    });
    expect(wide.effectiveDuration).toBeGreaterThan(0);
  });

  it('collapses the option cost to ~0 when the option is unreachable (oas ≈ zSpread)', () => {
    const farCall = [{ date: '2029-01-01', price: 1e6 }];
    const noOptModel = callableBond({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls: farCall,
    });
    const market = noOptModel.price - 1.0;
    const r = oasAnalytics({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls: farCall,
      marketPrice: market,
    });
    expect(Math.abs(r.optionCost)).toBeLessThan(1e-5); // < 0.1 bp
  });

  it('a putable has a negative option cost (oas > zSpread)', () => {
    const discountBond = bonds.fixedRate({
      issueDate: ref,
      maturityDate: '2031-01-01',
      couponRate: 0.03, // below the 4% curve ⇒ the put has value
      frequency: 'semiannual',
      dayCount: '30/360',
      faceValue: 100,
    });
    const puts = [
      { date: '2028-01-01', price: 99 },
      { date: '2029-01-01', price: 99 },
    ];
    const putModel = callableBond({
      bond: discountBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      puts,
    });
    const market = putModel.price - 1.0;
    const r = oasAnalytics({
      bond: discountBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      puts,
      marketPrice: market,
    });
    expect(r.oas).toBeGreaterThan(r.zSpread); // the holder is long the put
    expect(r.optionCost).toBeLessThan(0);
  });

  it('guards a missing/non-positive marketPrice, no option schedule, and a bad input', () => {
    expect(() => oasAnalytics(undefined as never)).toThrowError();
    expect(() =>
      oasAnalytics({ bond: premiumBond, curve: flat4, a: 0.05, sigma: 0.01, calls } as never),
    ).toThrowError(/marketPrice/);
    expect(() =>
      oasAnalytics({
        bond: premiumBond,
        curve: flat4,
        meanReversion: 0.05,
        sigma: 0.01,
        calls,
        marketPrice: 0,
      }),
    ).toThrowError(/marketPrice/);
    expect(() =>
      oasAnalytics({
        bond: premiumBond,
        curve: flat4,
        meanReversion: 0.05,
        sigma: 0.01,
        marketPrice: 100,
      }),
    ).toThrowError(/call or put/);
  });

  it('throws a typed ConvergenceError naming the bracket it searched when no spread reprices', () => {
    // A price of 1 is unreachable even at ±5000bp (the bond is worth ~100) ⇒ no root ⇒ throw.
    // The message must name the interval actually searched: "did not converge" blamed the solver
    // for a window that never contained the answer.
    const solve = (): unknown =>
      oasAnalytics({
        bond: premiumBond,
        curve: flat4,
        meanReversion: 0.05,
        sigma: 0.01,
        calls,
        marketPrice: 1,
      });
    expect(solve).toThrowError(ConvergenceError);
    expect(solve).toThrowError(/no OAS in the bracket searched/);
    expect(solve).toThrowError(/-5000bp, 5000bp/);
    try {
      solve();
      expect.unreachable('oasAnalytics should have thrown');
    } catch (error) {
      const e = error as ConvergenceError;
      expect(e.code).toBe('solver.no_convergence');
      expect(e.context?.['bracketSearched']).toEqual([-0.5, 0.5]);
    }
  });

  it('finds an OAS BEYOND the old ±500bp bracket instead of reporting non-convergence', () => {
    // Deeply distressed: the model price at zero spread is ~100, the market pays far less, so the
    // OAS is a four-figure basis-point number. The old hard-coded ±500bp bracket had no sign
    // change and reported "OAS solve did not converge" for a perfectly well-posed problem.
    const stressed = oasAnalytics({
      bond: premiumBond,
      curve: flat4,
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
      marketPrice: 60,
    });
    expect(stressed.oas).toBeGreaterThan(0.05); // outside the retired bracket
    expect(stressed.oas).toBeLessThan(0.5); // inside the honest cap
    // The reported OAS really does reprice the model to the market price.
    const repriced = callableBond({
      bond: premiumBond,
      curve: flat4.shift(stressed.oas),
      meanReversion: 0.05,
      sigma: 0.01,
      calls,
    }).price;
    expect(repriced).toBeCloseTo(60, 6);
  });
});
