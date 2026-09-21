/**
 * Tests for §14.3 short-rate models: Vasicek and CIR affine bond prices and moments, Hull-White's
 * curve reconstruction and analytic ZCB option, and the Hull-White / Black-Karasinski trinomial tree's
 * arbitrage-free calibration (it must reprice the input discount curve).
 */

import { describe, expect, it } from 'vitest';
import { cir, curves, g2pp, hullWhite, shortRateTree, vasicek } from '@totalfinance/fixed-income';

describe('Vasicek', () => {
  const m = vasicek({ a: 0.1, b: 0.05, sigma: 0.01, r0: 0.03 });

  it('discount bond is 1 at zero tenor and decreasing in maturity', () => {
    expect(m.discountBond(0.03, 0)).toBe(1);
    expect(m.discountBond(0.03, 5)).toBeLessThan(1);
    expect(m.discountBond(0.03, 10)).toBeLessThan(m.discountBond(0.03, 5));
  });

  it('short-rate mean reverts to b; the long zero rate is b − σ²/2a²', () => {
    expect(m.shortRateMoments(200).mean).toBeCloseTo(0.05, 6); // e^{−0.1·200} ≈ 0 ⇒ fully reverted
    const long = 0.05 - (0.01 * 0.01) / (2 * 0.1 * 0.1);
    expect(m.zeroRate(0.03, 500)).toBeCloseTo(long, 3); // R(τ)→R∞ only as O(1/aτ)
  });

  it('ZCB option satisfies put-call parity', () => {
    const call = m.zeroCouponBondOption({
      optionMaturity: 1,
      bondMaturity: 5,
      strike: 0.8,
      right: 'call',
    });
    const put = m.zeroCouponBondOption({
      optionMaturity: 1,
      bondMaturity: 5,
      strike: 0.8,
      right: 'put',
    });
    expect(call - put).toBeCloseTo(m.discountBond(0.03, 5) - 0.8 * m.discountBond(0.03, 1), 10);
  });

  it('caplet is positive and rises with volatility', () => {
    const lo = vasicek({ a: 0.1, b: 0.05, sigma: 0.005, r0: 0.03 }).caplet({
      optionMaturity: 1,
      bondMaturity: 1.5,
      strikeRate: 0.04,
      accrualFraction: 0.5,
    });
    const hi = vasicek({ a: 0.1, b: 0.05, sigma: 0.02, r0: 0.03 }).caplet({
      optionMaturity: 1,
      bondMaturity: 1.5,
      strikeRate: 0.04,
      accrualFraction: 0.5,
    });
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeGreaterThan(lo);
  });

  it('rejects non-positive mean reversion / vol', () => {
    expect(() => vasicek({ a: 0, b: 0.05, sigma: 0.01, r0: 0.03 })).toThrow(/a must be/);
    expect(() => vasicek({ a: 0.1, b: 0.05, sigma: -0.01, r0: 0.03 })).toThrow(/sigma must be/);
  });
});

describe('CIR', () => {
  const m = cir({ a: 0.2, b: 0.04, sigma: 0.06, r0: 0.03 });

  it('discount bond is in (0,1] and the zero rate stays positive (non-negative rates)', () => {
    expect(m.discountBond(0.03, 0)).toBe(1);
    const p = m.discountBond(0.03, 5);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    expect(m.zeroRate(0.03, 5)).toBeGreaterThan(0);
  });

  it('short rate mean reverts to b', () => {
    expect(m.shortRateMoments(100).mean).toBeCloseTo(0.04, 6);
    expect(m.shortRateMoments(5).variance).toBeGreaterThan(0);
  });

  it('rejects r0 < 0', () => {
    expect(() => cir({ a: 0.2, b: 0.04, sigma: 0.06, r0: -0.01 })).toThrow(/r0/);
  });

  it('says nothing when the Feller condition holds', () => {
    // 2ab = 0.016 ≥ σ² = 0.0036 — the short rate stays strictly positive, so there is nothing to
    // disclose and the warnings channel must stay empty (a diagnostic that always fires is noise).
    expect(2 * 0.2 * 0.04).toBeGreaterThanOrEqual(0.06 * 0.06);
    expect(m.diagnostics.warnings).toEqual([]);
  });

  it('DISCLOSES a Feller violation instead of accepting it silently (2ab < σ²)', () => {
    // Parameters that let the short rate reach 0 are perfectly usable and CIR fits land there
    // routinely — but they change what the model means, so they are reported, not swallowed and
    // not thrown. 2ab = 0.002 < σ² = 0.0225.
    const violating = cir({ a: 0.05, b: 0.02, sigma: 0.15, r0: 0.03 });
    expect(2 * 0.05 * 0.02).toBeLessThan(0.15 * 0.15);
    expect(violating.diagnostics.warnings).toHaveLength(1);
    const w = violating.diagnostics.warnings[0]!;
    expect(w.code).toBe('model.feller_condition_violated');
    expect(w.severity).toBe('warn');
    expect(w.message).toMatch(/Feller condition/);
    expect(w.context).toMatchObject({ sigma: 0.15 });
    // Accepted, not rejected: the affine bond price is still a valid number.
    const p = violating.discountBond(0.03, 5);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
});

describe('Hull-White (curve-fit)', () => {
  const ref = '2026-01-01';
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.035],
      ['2032-01-01', 0.04],
    ],
    { referenceDate: ref },
  );
  const hw = hullWhite(curve, { a: 0.1, sigma: 0.01 });

  it('reconstructs the market discount curve at t = 0 (r = instantaneous forward)', () => {
    const r0 = curve.instantaneousForward(0);
    for (const tau of [1, 2, 4, 5]) {
      expect(hw.discountBond({ valuationTime: 0, timeToMaturity: tau, shortRate: r0 })).toBeCloseTo(
        curve.discount(tau),
        4,
      );
    }
  });

  it('ZCB option satisfies put-call parity against the market curve', () => {
    const call = hw.zeroCouponBondOption({
      optionMaturity: 1,
      bondMaturity: 4,
      strike: 0.85,
      right: 'call',
    });
    const put = hw.zeroCouponBondOption({
      optionMaturity: 1,
      bondMaturity: 4,
      strike: 0.85,
      right: 'put',
    });
    expect(call - put).toBeCloseTo(curve.discount(4) - 0.85 * curve.discount(1), 10);
  });

  it('short-rate dispersion grows with horizonYears', () => {
    expect(hw.shortRateStandardDeviation(5)).toBeGreaterThan(hw.shortRateStandardDeviation(1));
  });
});

describe('short-rate trinomial tree calibration', () => {
  const ref = '2026-01-01';
  const curve = curves.fromZeroRates(
    [
      ['2027-01-01', 0.03],
      ['2029-01-01', 0.035],
      ['2031-01-01', 0.04],
    ],
    { referenceDate: ref },
  );

  it('Hull-White tree reprices the discount curve on the grid', () => {
    const tree = shortRateTree(curve, {
      meanReversion: 0.1,
      sigma: 0.01,
      model: 'hull-white',
      horizonYears: 5,
      steps: 40,
    });
    for (const k of [5, 10, 20, 40]) {
      const t = k * tree.timeStepYears;
      expect(tree.discountBond(t)).toBeCloseTo(curve.discount(t), 6);
    }
  });

  it('Black-Karasinski tree reprices the curve and keeps the short rate positive', () => {
    const tree = shortRateTree(curve, {
      meanReversion: 0.1,
      sigma: 0.2,
      model: 'black-karasinski',
      horizonYears: 5,
      steps: 40,
    });
    for (const k of [10, 25, 40]) {
      const t = k * tree.timeStepYears;
      expect(tree.discountBond(t)).toBeCloseTo(curve.discount(t), 5);
    }
    // Lognormal short rate ⇒ every node strictly positive.
    expect(tree.shortRate(20, -3)).toBeGreaterThan(0);
    expect(tree.shortRate(20, 3)).toBeGreaterThan(tree.shortRate(20, -3)); // monotone in level
  });

  it('rejects an off-grid maturity', () => {
    const tree = shortRateTree(curve, {
      meanReversion: 0.1,
      sigma: 0.01,
      model: 'hull-white',
      horizonYears: 5,
      steps: 10,
    });
    expect(() => tree.discountBond(0.123)).toThrow(/grid/);
  });
});

describe('curve-argument hardening (deep-sweep boundary)', () => {
  const curve = curves.flat({
    rate: 0.03,
    referenceDate: '2026-01-01',
    options: { dayCount: 'ACT/365F' },
  });

  it('hullWhite / g2pp / shortRateTree reject a raw object where a curve instance belongs', () => {
    // `{}` passed the object guard but died on the first curve method call — immediately for the
    // eagerly-calibrating tree, or later inside a returned model method for the analytic models.
    expect(() => hullWhite({} as never, { a: 0.05, sigma: 0.01 })).toThrow(
      /hullWhite: curve must be a yield curve/,
    );
    expect(() =>
      g2pp({} as never, { a: 0.05, sigma: 0.01, b: 0.1, eta: 0.008, rho: -0.5 }),
    ).toThrow(/g2pp: curve must be a yield curve/);
    expect(() =>
      shortRateTree({ pillars: [] } as never, {
        meanReversion: 0.05,
        sigma: 0.01,
        model: 'hull-white',
        horizonYears: 2,
        steps: 8,
      }),
    ).toThrow(/shortRateTree: curve must be a yield curve/);
    // A real curve still works.
    expect(
      hullWhite(curve, { a: 0.05, sigma: 0.01 }).shortRateStandardDeviation(1),
    ).toBeGreaterThan(0);
  });
});
