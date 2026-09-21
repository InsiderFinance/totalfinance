/**
 * Napoleon & reverse-cliquet options (`napoleon`, `reverseCliquet`). Both are short-vol coupon structures
 * priced by Monte-Carlo. The defining checks: the reverse-cliquet MC equals its closed-form floorless value
 * when unfloored (exact identity), the global floor is a genuine lower bound, both are short volatility (a
 * higher vol lowers the value), and the near-zero-vol limits match the deterministic payoff.
 */

import { describe, expect, it } from 'vitest';
import { napoleon, reverseCliquet } from '@totalfinance/options';

const BASE = {
  spot: 100,
  resetTimes: [0.25, 0.5, 0.75, 1],
  riskFreeRate: 0.03,
  volatility: 0.25,
  dividendYield: 0,
  coupon: 0.1,
  notional: 100,
};
const MC = { paths: 400_000, seed: 11 };

describe('reverseCliquet', () => {
  it('the MC equals the closed-form floorless value when unfloored (exact identity)', () => {
    const unfloored = { ...BASE, globalFloor: -Infinity };
    const analytic = reverseCliquet.floorlessValue(unfloored).value;
    const monteCarlo = reverseCliquet.monteCarloPrice(unfloored, MC);
    expect(Math.abs(monteCarlo.value - analytic)).toBeLessThan(
      5 * monteCarlo.monteCarlo.standardError!,
    );
    expect(monteCarlo.monteCarlo.standardError).toBeGreaterThan(0);
  });

  it('the floored price is ≥ the floorless value (the floor only adds value) and ≥ 0', () => {
    // A negative coupon makes the floor bind: the unfloored value is negative, the floored one is ≥ 0.
    const input = { ...BASE, coupon: -0.15, globalFloor: 0 };
    const analytic = reverseCliquet.floorlessValue(input).value;
    const monteCarlo = reverseCliquet.monteCarloPrice(input, MC);
    expect(analytic).toBeLessThan(0); // unfloored: coupon can't cover the expected erosion
    expect(monteCarlo.value).toBeGreaterThanOrEqual(0);
    expect(monteCarlo.value).toBeGreaterThan(analytic);
  });

  it('is short downside volatility: a higher vol lowers the value', () => {
    const lo = reverseCliquet.monteCarloPrice({ ...BASE, volatility: 0.15 }, MC).value;
    const hi = reverseCliquet.monteCarloPrice({ ...BASE, volatility: 0.45 }, MC).value;
    expect(hi).toBeLessThan(lo);
  });

  it('with a tiny vol and positive drift the coupon is untouched (floorless ≈ df·notional·coupon)', () => {
    const df = Math.exp(-BASE.riskFreeRate * 1);
    const v = reverseCliquet.floorlessValue({ ...BASE, volatility: 1e-4, dividendYield: 0 }).value;
    // Positive drift ⇒ E[min(r,0)] ≈ 0 ⇒ value ≈ df·notional·coupon.
    expect(v).toBeCloseTo(df * BASE.notional * BASE.coupon, 2);
  });

  it('defaults the dividend yield to 0 and the notional to 1 when omitted', () => {
    const v = reverseCliquet.floorlessValue({
      spot: 100,
      resetTimes: [0.5, 1],
      riskFreeRate: 0.03,
      volatility: 0.2,
      coupon: 0.1,
    }).value;
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0); // coupon 0.1 · notional 1, lightly eroded, discounted
    expect(v).toBeLessThan(0.1); // below the raw coupon after erosion + discount
  });

  it('guards a bad input, non-increasing reset times, non-positive scalars, and missing MC options', () => {
    expect(() => reverseCliquet.floorlessValue(undefined as never)).toThrowError();
    expect(() =>
      reverseCliquet.floorlessValue({ ...BASE, resetTimes: [0.5, 0.25] }),
    ).toThrowError();
    expect(() => reverseCliquet.floorlessValue({ ...BASE, resetTimes: [] })).toThrowError();
    expect(() => reverseCliquet.floorlessValue({ ...BASE, spot: 0 })).toThrowError();
    expect(() => reverseCliquet.floorlessValue({ ...BASE, coupon: NaN })).toThrowError();
    expect(() => reverseCliquet.monteCarloPrice(BASE, undefined as never)).toThrowError();
    expect(() =>
      reverseCliquet.monteCarloPrice({ ...BASE, globalFloor: Infinity }, MC),
    ).toThrowError();
  });
});

describe('napoleon', () => {
  it('matches the deterministic payoff in the near-zero-vol limit', () => {
    // r_i ≈ e^{b·τ_i} − 1; the worst is the shortest period (smallest positive return for b > 0).
    const resetTimes = [0.1, 0.5, 1];
    const b = BASE.riskFreeRate - BASE.dividendYield;
    const periods = [0.1, 0.4, 0.5];
    const worst = Math.min(...periods.map((tau) => Math.exp(b * tau) - 1));
    const df = Math.exp(-BASE.riskFreeRate * 1);
    const expected = df * BASE.notional * Math.max(0, BASE.coupon + worst);
    const monteCarlo = napoleon.monteCarloPrice(
      { ...BASE, resetTimes, volatility: 1e-4, globalFloor: 0 },
      MC,
    );
    expect(monteCarlo.value).toBeCloseTo(expected, 2);
  });

  it('is short worst-return volatility: a higher vol lowers the value', () => {
    const lo = napoleon.monteCarloPrice({ ...BASE, volatility: 0.15 }, MC).value;
    const hi = napoleon.monteCarloPrice({ ...BASE, volatility: 0.4 }, MC).value;
    expect(hi).toBeLessThan(lo);
    // The MC carries error statistics and converged.
    expect(napoleon.monteCarloPrice({ ...BASE, volatility: 0.15 }, MC).diagnostics.converged).toBe(
      true,
    );
  });

  it('a large coupon dominates the worst return, floored below', () => {
    // With a big coupon the payoff ≈ df·notional·(coupon + worst) and stays well above the floor.
    const monteCarlo = napoleon.monteCarloPrice({ ...BASE, coupon: 1 }, MC);
    const df = Math.exp(-BASE.riskFreeRate * 1);
    // coupon + worst-monthly is comfortably positive ⇒ value near df·notional·(1 + E[worst]) < df·notional·1.
    expect(monteCarlo.value).toBeGreaterThan(0);
    expect(monteCarlo.value).toBeLessThan(df * BASE.notional * 1); // the worst return drags below the pure coupon
  });

  it('guards a bad input, non-increasing reset times, non-positive scalars, and missing MC options', () => {
    expect(() => napoleon.monteCarloPrice(undefined as never, MC)).toThrowError();
    expect(() => napoleon.monteCarloPrice({ ...BASE, resetTimes: [0.5, 0.5] }, MC)).toThrowError();
    expect(() => napoleon.monteCarloPrice({ ...BASE, volatility: 0 }, MC)).toThrowError();
    expect(() => napoleon.monteCarloPrice({ ...BASE, riskFreeRate: NaN }, MC)).toThrowError();
    expect(() => napoleon.monteCarloPrice(BASE, undefined as never)).toThrowError();
  });
});
