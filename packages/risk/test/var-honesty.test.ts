import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { portfolioVaR, valueAtRisk } from '@totalfinance/risk';

/**
 * Regression for an external-review finding: a Monte-Carlo VaR must reject a non-reproducible seed,
 * and portfolio VaR must reject a non-positive horizonPeriods — rather than silently returning a number
 * that cannot be reproduced (fractional/NaN seed) or is NaN (√ of a negative horizonPeriods).
 */
describe('risk VaR — no silent non-reproducibility / degradation', () => {
  const returns = [0.01, -0.02, 0.03, -0.01, 0.02, -0.03];

  it('rejects a fractional Monte-Carlo seed', () => {
    let caught: unknown;
    try {
      valueAtRisk(returns, { method: 'monteCarlo', seed: 3.7 });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
  });

  it('rejects a NaN Monte-Carlo seed', () => {
    expect(() => valueAtRisk(returns, { method: 'monteCarlo', seed: NaN })).toThrow(
      /seed must be an integer/,
    );
  });

  it('still accepts a valid integer seed and is reproducible', () => {
    const a = valueAtRisk(returns, { method: 'monteCarlo', seed: 7 });
    const b = valueAtRisk(returns, { method: 'monteCarlo', seed: 7 });
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it('parametricPortfolioVaR rejects a non-positive horizonPeriods (no unflagged NaN)', () => {
    expect(() =>
      portfolioVaR({
        method: 'parametric',
        weights: [0.5, 0.5],
        covariance: [
          [0.04, 0.01],
          [0.01, 0.09],
        ],
        options: { horizonPeriods: -3 },
      }),
    ).toThrow(/horizonPeriods must be a positive finite/);
  });
});
