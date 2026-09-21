/**
 * American exercise analytics (`americanExercise`). Verifies the premium decomposition (European leg
 * matches `blackScholesPrice` exactly; premium ≥ 0), the boundary recovered from BAW is consistent with the
 * exercise-now verdict (spot past S* ⟺ american = intrinsic ⟺ exercise now), the put boundary rises
 * toward K (and the dividend-call boundary falls toward K) as expiry nears, a non-dividend call has no
 * early-exercise value or boundary, the discrete-dividend disclosure, and the guards.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import { americanExercise } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import type { OptionContract } from '@totalfinance/core';
import type { OptionMarket } from '@totalfinance/options';

const ASOF = '2026-01-15T00:00:00Z'; // a valuation instant names its time of day
const EXPIRY = '2027-01-15'; // ~1 year

const put = (strike = 100): OptionContract => ({
  underlying: 'XYZ',
  type: 'put',
  style: 'american',
  strike,
  expiry: EXPIRY,
  ...resolvedExpiry(EXPIRY),
});
const call = (strike = 100): OptionContract => ({
  underlying: 'XYZ',
  type: 'call',
  style: 'american',
  strike,
  expiry: EXPIRY,
  ...resolvedExpiry(EXPIRY),
});
const mkt = (spot: number, extra: Partial<OptionMarket> = {}): OptionMarket => ({
  spot,
  riskFreeRate: 0.05,
  volatility: 0.25,
  asOf: ASOF,
  ...extra,
});

describe('americanExercise — premium decomposition', () => {
  it('splits the American value into European + early-exercise premium (European = blackScholesPrice exactly)', () => {
    const r = americanExercise({ contract: put(100), market: mkt(100) });
    // `optionType` (not `style`): `style` is the EXERCISE style everywhere else in TotalFinance.
    expect(r.optionType).toBe('put');
    expect(r.spot).toBe(100);
    // European leg is exactly the BSM price at the same maturity.
    expect(r.european).toBeCloseTo(
      blackScholesPrice({
        type: 'put',
        spot: 100,
        strike: 100,
        timeToExpiryYears: r.assumptions.timeToExpiryYears,
        riskFreeRate: 0.05,
        dividendYield: 0,
        volatility: 0.25,
      }),
      9,
    );
    expect(r.earlyExercisePremium).toBeCloseTo(r.american - r.european, 12);
    expect(r.earlyExercisePremium).toBeGreaterThan(0);
    expect(r.american).toBeGreaterThanOrEqual(r.european);
    expect(r.timeValue).toBeCloseTo(r.american - r.intrinsic, 12);
    // Known BAW magnitude (S=K=100, r=5%, σ=25%, T=1): American put ≈ 7.99.
    expect(r.american).toBeCloseTo(7.99, 1);
  });

  it('premiumFractionOfValue = premium / american, and the rationale is grounded', () => {
    const r = americanExercise({ contract: put(100), market: mkt(90) });
    expect(r.premiumFractionOfValue).toBeCloseTo(r.earlyExercisePremium / r.american, 12);
    expect(r.rationale).not.toContain('NaN');
    expect(r.rationale).not.toContain('undefined');
    expect(r.diagnostics.engine).toBe('american-exercise');
  });
});

describe('americanExercise — boundary & exercise-now consistency', () => {
  it('for a put, shouldExerciseNow ⟺ spot ≤ criticalSpot ⟺ american = intrinsic', () => {
    const below = americanExercise({ contract: put(100), market: mkt(70) }); // deep ITM, below S*
    const above = americanExercise({ contract: put(100), market: mkt(80) }); // ITM but above S*

    expect(below.shouldExerciseNow).toBe(below.spot <= below.criticalSpot!);
    expect(above.shouldExerciseNow).toBe(above.spot <= above.criticalSpot!);
    // Same contract ⇒ same current boundary regardless of spot.
    expect(below.criticalSpot).toBeCloseTo(above.criticalSpot!, 6);

    expect(below.shouldExerciseNow).toBe(true);
    expect(below.american).toBeCloseTo(below.intrinsic, 6); // collapsed to intrinsic
    expect(below.timeValue).toBeLessThan(1e-6);
    expect(below.spotToBoundary!).toBeLessThan(0); // past the boundary

    expect(above.shouldExerciseNow).toBe(false);
    expect(above.timeValue).toBeGreaterThan(0);
    expect(above.spotToBoundary!).toBeGreaterThan(0);
  });

  it('the put exercise boundary rises toward K as expiry approaches', () => {
    const r = americanExercise({
      contract: put(100),
      market: mkt(100),
      options: { boundaryPoints: 24 },
    });
    expect(r.boundary.length).toBe(24);
    // Ordered from current maturity (longest) to near-expiry (shortest); S* increases toward K.
    for (let i = 1; i < r.boundary.length; i++) {
      expect(r.boundary[i]!.yearsToExpiry).toBeLessThan(r.boundary[i - 1]!.yearsToExpiry);
      expect(r.boundary[i]!.criticalSpot).toBeGreaterThanOrEqual(
        r.boundary[i - 1]!.criticalSpot - 1e-9,
      );
      expect(r.boundary[i]!.criticalSpot).toBeLessThan(100); // a put is only exercised in-the-money
    }
  });
});

describe('americanExercise — dividend logic', () => {
  it('a non-dividend call is never exercised early — no premium, no boundary', () => {
    const r = americanExercise({ contract: call(100), market: mkt(110) });
    expect(r.earlyExerciseCanBeOptimal).toBe(false);
    expect(r.criticalSpot).toBeNull();
    expect(r.earlyExercisePremium).toBeCloseTo(0, 9);
    expect(r.american).toBeCloseTo(r.european, 9);
    expect(r.boundary).toEqual([]);
    expect(r.spotToBoundary).toBeNull();
    expect(r.rationale).toContain('Never exercise early');
  });

  it('a dividend-paying call has a finite high-spot boundary that falls toward K', () => {
    const r = americanExercise({
      contract: call(100),
      market: mkt(110, { dividendYield: 0.06 }),
      options: {
        boundaryPoints: 20,
      },
    });
    expect(r.earlyExerciseCanBeOptimal).toBe(true);
    expect(r.criticalSpot!).toBeGreaterThan(100); // exercise a call only when high enough
    expect(r.earlyExercisePremium).toBeGreaterThan(0);
    for (let i = 1; i < r.boundary.length; i++) {
      expect(r.boundary[i]!.criticalSpot).toBeLessThanOrEqual(
        r.boundary[i - 1]!.criticalSpot + 1e-9,
      );
      expect(r.boundary[i]!.criticalSpot).toBeGreaterThan(100);
    }
  });

  it('a tiny dividend yield yields a very high call boundary (bracket expansion still finds it)', () => {
    // As q → 0⁺ the call boundary → ∞; a small q pushes S* well past the initial 4K bracket, so the
    // expansion loop must widen it. The boundary is still finite and above the strike.
    const r = americanExercise({
      contract: call(100),
      market: mkt(110, { dividendYield: 0.005 }),
      options: {
        boundaryPoints: 0,
      },
    });
    expect(r.earlyExerciseCanBeOptimal).toBe(true);
    expect(r.criticalSpot!).toBeGreaterThan(400); // beyond the initial 4·K bracket
    expect(Number.isFinite(r.criticalSpot!)).toBe(true);
  });

  it('a deep-in-the-money dividend call says exercise now', () => {
    const r = americanExercise({ contract: call(100), market: mkt(170, { dividendYield: 0.06 }) });
    expect(r.shouldExerciseNow).toBe(true);
    expect(r.american).toBeCloseTo(r.intrinsic, 6);
    expect(r.timeValue).toBeLessThan(1e-6);
    expect(r.rationale).toContain('Exercise now');
  });

  it('a negative interest rate removes the put early-exercise incentive (no boundary)', () => {
    // With r < 0, holding to receive K at expiry (discounted up) beats exercising for K now.
    const r = americanExercise({ contract: put(100), market: mkt(70, { riskFreeRate: -0.02 }) });
    expect(r.earlyExerciseCanBeOptimal).toBe(false);
    expect(r.criticalSpot).toBeNull();
    expect(r.shouldExerciseNow).toBe(false);
  });

  it('discloses a discrete-dividend schedule (continuous-yield approximation)', () => {
    const r = americanExercise({
      contract: call(100),
      market: mkt(110, { dividends: [{ exDate: '2026-07-15', amount: 2 }] }),
    });
    expect(r.assumptions.dividendModel).toBe('discreteSchedule');
    expect(
      r.diagnostics.warnings.some((w) => w.code === 'options.exercise_discrete_dividends'),
    ).toBe(true);
  });
});

describe('americanExercise — envelope & guards', () => {
  it('boundaryPoints: 0 skips the curve; other counts size it', () => {
    expect(
      americanExercise({ contract: put(100), market: mkt(100), options: { boundaryPoints: 0 } })
        .boundary,
    ).toEqual([]);
    expect(
      americanExercise({ contract: put(100), market: mkt(100), options: { boundaryPoints: 10 } })
        .boundary.length,
    ).toBe(10);
  });

  it('throws on garbage, missing fields, and an expired contract', () => {
    expect(() =>
      americanExercise({ contract: undefined as never, market: mkt(100) }),
    ).toThrowError();
    expect(() =>
      americanExercise({ contract: put(100), market: undefined as never }),
    ).toThrowError();
    expect(() =>
      americanExercise({
        contract: put(100),
        market: { riskFreeRate: 0.05, volatility: 0.25, asOf: ASOF } as never,
      }),
    ).toThrowError(); // no spot
    expect(() =>
      americanExercise({
        contract: put(100),
        market: { spot: 100, volatility: 0.25, asOf: ASOF } as never,
      }),
    ).toThrowError(); // no rate
    expect(() =>
      americanExercise({
        contract: put(100),
        market: { spot: 100, riskFreeRate: 0.05, asOf: ASOF } as never,
      }),
    ).toThrowError(); // no vol
    expect(() => americanExercise({ contract: put(-1), market: mkt(100) })).toThrowError(); // negative strike
    expect(() =>
      americanExercise({ contract: { ...put(100), expiry: '2025-01-15' }, market: mkt(100) }),
    ).toThrowError(); // expiry before asOf
    expect(() =>
      americanExercise({ contract: put(100), market: mkt(100), options: { boundaryPoints: -3 } }),
    ).toThrowError();
    expect(() =>
      americanExercise({ contract: put(100), market: mkt(100), options: { boundaryPoints: 2.5 } }),
    ).toThrowError();
  });
});
