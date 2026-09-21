/**
 * Tests for the §14.3 G2++ two-factor Gaussian model: curve reconstruction, ZCB-option put-call
 * parity, the Hull-White reduction (η → 0), and short-rate variance.
 */

import { describe, expect, it } from 'vitest';
import { curves, g2pp, hullWhite } from '@totalfinance/fixed-income';

const ref = '2026-01-01';
const curve = curves.fromZeroRates(
  [
    ['2027-01-01', 0.03],
    ['2029-01-01', 0.035],
    ['2032-01-01', 0.04],
  ],
  { referenceDate: ref },
);

describe('G2++', () => {
  const g2 = g2pp(curve, { a: 0.5, sigma: 0.01, b: 0.1, eta: 0.008, rho: -0.7 });

  it('reconstructs the market discount curve at t = 0 (x = y = 0)', () => {
    for (const tau of [1, 2, 4, 5]) {
      expect(g2.discountBond({ valuationTime: 0, timeToMaturity: tau })).toBeCloseTo(
        curve.discount(tau),
        10,
      );
    }
  });

  it('ZCB option satisfies put-call parity against the market curve', () => {
    const call = g2.zeroCouponBondOption({
      optionMaturity: 1,
      bondMaturity: 4,
      strike: 0.85,
      right: 'call',
    });
    const put = g2.zeroCouponBondOption({
      optionMaturity: 1,
      bondMaturity: 4,
      strike: 0.85,
      right: 'put',
    });
    expect(call - put).toBeCloseTo(curve.discount(4) - 0.85 * curve.discount(1), 10);
  });

  it('short-rate variance is positive and grows with horizonYears', () => {
    expect(g2.shortRateVariance(1)).toBeGreaterThan(0);
    expect(g2.shortRateVariance(5)).toBeGreaterThan(g2.shortRateVariance(1));
  });

  it('reduces to Hull-White as the second factor vanishes (η → 0)', () => {
    const a = 0.1;
    const sigma = 0.01;
    const g2Degenerate = g2pp(curve, { a, sigma, b: 0.5, eta: 1e-7, rho: 0 });
    const hw = hullWhite(curve, { a, sigma });
    expect(
      g2Degenerate.zeroCouponBondOption({
        optionMaturity: 1,
        bondMaturity: 5,
        strike: 0.8,
        right: 'call',
      }),
    ).toBeCloseTo(
      hw.zeroCouponBondOption({ optionMaturity: 1, bondMaturity: 5, strike: 0.8, right: 'call' }),
      6,
    );
  });

  it('accepts η = 0 EXACTLY and then IS Hull-White (the documented reduction, now reachable)', () => {
    // The doc promised "reduces to Hull-White when eta = 0" while `requirePositive('eta', …)`
    // rejected 0, so the one parameter set that makes the claim checkable was unreachable and the
    // best a caller could do was approach it with an epsilon. Every η-weighted term carries η as a
    // factor and `b` stays strictly positive, so η = 0 is not degenerate — it is exact.
    const a = 0.1;
    const sigma = 0.01;
    const g2Exact = g2pp(curve, { a, sigma, b: 0.5, eta: 0, rho: 0 });
    const hw = hullWhite(curve, { a, sigma });
    for (const tau of [0.5, 1, 3, 6]) {
      expect(g2Exact.discountBond({ valuationTime: 0, timeToMaturity: tau })).toBeCloseTo(
        curve.discount(tau),
        12,
      );
    }
    for (const [tOption, tBond, strike] of [
      [1, 5, 0.8],
      [2, 4, 0.9],
      [0.5, 10, 0.7],
    ] as const) {
      for (const right of ['call', 'put'] as const) {
        expect(
          g2Exact.zeroCouponBondOption({
            optionMaturity: tOption,
            bondMaturity: tBond,
            strike,
            right,
          }),
        ).toBeCloseTo(
          hw.zeroCouponBondOption({ optionMaturity: tOption, bondMaturity: tBond, strike, right }),
          14,
        );
      }
    }
    // Caplets/floorlets inherit the equality, and the short-rate variance collapses to one factor.
    expect(
      g2Exact.caplet({
        optionMaturity: 1,
        bondMaturity: 1.5,
        strikeRate: 0.03,
        accrualFraction: 0.5,
      }),
    ).toBeCloseTo(
      hw.caplet({
        optionMaturity: 1,
        bondMaturity: 1.5,
        strikeRate: 0.03,
        accrualFraction: 0.5,
      }),
      14,
    );
    expect(g2Exact.shortRateVariance(3)).toBeCloseTo(
      Math.pow(hw.shortRateStandardDeviation(3), 2),
      14,
    );
  });

  it('still rejects a negative η', () => {
    expect(() => g2pp(curve, { a: 0.5, sigma: 0.01, b: 0.1, eta: -0.001, rho: 0 })).toThrow(/eta/);
  });

  it('rejects an out-of-range correlation', () => {
    expect(() => g2pp(curve, { a: 0.5, sigma: 0.01, b: 0.1, eta: 0.008, rho: 1.5 })).toThrow(/rho/);
  });
});
