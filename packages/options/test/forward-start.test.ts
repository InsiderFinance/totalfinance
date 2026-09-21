/**
 * Forward-start options (`forwardStart`). The Rubinstein closed form is pinned by its Monte-Carlo
 * corroboration (call/put across strike multipliers), the spot-homogeneity property (the value scales
 * linearly with today's spot), a clean forward-start put-call relation, the limit as the reset → 0 (it
 * becomes a vanilla struck at α·S), and the guards.
 */

import { describe, expect, it } from 'vitest';
import { forwardStart } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

const BASE = {
  spot: 100,
  resetTime: 0.5,
  timeToExpiryYears: 1,
  riskFreeRate: 0.05,
  volatility: 0.25,
  dividendYield: 0.02,
};

describe('forwardStart', () => {
  it('the analytic matches the two-step Monte-Carlo (call/put across strike multipliers)', () => {
    const monteCarlo = { paths: 300_000, seed: 42 };
    for (const type of ['call', 'put'] as const) {
      for (const alpha of [1, 0.9, 1.1]) {
        const input = { ...BASE, strikeMultiplier: alpha };
        const a = forwardStart.price({ ...input, type }).value;
        const m = forwardStart.monteCarloPrice({ ...input, type }, monteCarlo);
        expect(Math.abs(m.value - a)).toBeLessThan(5 * m.monteCarlo.standardError!);
      }
    }
  });

  it('is homogeneous of degree 1 in today’s spot (value scales linearly)', () => {
    const v1 = forwardStart.price({ ...BASE, type: 'call' }).value;
    const v2 = forwardStart.price({ type: 'call', ...BASE, spot: 250 }).value;
    expect(v2 / v1).toBeCloseTo(2.5, 10);
  });

  it('obeys the forward-start put-call relation c − p = S·e^{−q·t₁}·(e^{−qτ} − α·e^{−rτ})', () => {
    const alpha = 0.95;
    const input = { ...BASE, strikeMultiplier: alpha };
    const c = forwardStart.price({ ...input, type: 'call' }).value;
    const p = forwardStart.price({ ...input, type: 'put' }).value;
    const tau = BASE.timeToExpiryYears - BASE.resetTime;
    const expected =
      BASE.spot *
      Math.exp(-BASE.dividendYield * BASE.resetTime) *
      (Math.exp(-BASE.dividendYield * tau) - alpha * Math.exp(-BASE.riskFreeRate * tau));
    expect(c - p).toBeCloseTo(expected, 10);
  });

  it('approaches a vanilla struck at α·S as the reset → 0', () => {
    const alpha = 1.05;
    const early = forwardStart.price({
      type: 'call',
      ...BASE,
      resetTime: 1e-7,
      strikeMultiplier: alpha,
    }).value;
    const vanilla = blackScholesPrice({
      type: 'call',
      spot: BASE.spot,
      strike: alpha * BASE.spot,
      timeToExpiryYears: BASE.timeToExpiryYears,
      riskFreeRate: BASE.riskFreeRate,
      dividendYield: BASE.dividendYield,
      volatility: BASE.volatility,
    });
    expect(early).toBeCloseTo(vanilla, 4);
  });

  it('guards a reset outside (0, t), a non-positive multiplier, and bad enums', () => {
    expect(() => forwardStart.price({ type: 'call', ...BASE, resetTime: 1 })).toThrowError(); // reset = t
    expect(() => forwardStart.price({ type: 'call', ...BASE, resetTime: 0 })).toThrowError(); // reset = 0
    expect(() => forwardStart.price({ type: 'call', ...BASE, resetTime: 1.5 })).toThrowError(); // reset > t
    expect(() => forwardStart.price({ type: 'call', ...BASE, strikeMultiplier: 0 })).toThrowError();
    expect(() => forwardStart.price({ type: 'call', ...BASE, spot: -1 })).toThrowError();
    expect(() => forwardStart.price({ ...BASE, type: 'bogus' } as never)).toThrowError();
    expect(() => forwardStart.price(undefined as never)).toThrowError();
  });
});
