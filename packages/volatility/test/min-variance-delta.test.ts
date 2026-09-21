/**
 * Minimum-variance (smile-adjusted) delta (`minimumVarianceDelta`). Verifies the formula against
 * independent `blackScholesGreeks` (Δ_MV = Δ_BS + vega_raw·β), the regime mapping (sticky-strike → BSM,
 * sticky-moneyness → −skewSlope/spot), the β-source precedence, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { blackScholesGreeks } from '@totalfinance/options/black-scholes';
import { minimumVarianceDelta } from '@totalfinance/volatility';

const BASE = {
  type: 'call',
  spot: 100,
  strike: 100,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.03,
  volatility: 0.2,
} as const;

describe('minimumVarianceDelta — the formula', () => {
  it('sticky-strike (β = 0) returns exactly the BSM delta', () => {
    const r = minimumVarianceDelta({ ...BASE, skewSlope: -0.5, regime: 'sticky-strike' });
    expect(r.value.volatilitySpotBeta).toBe(0);
    expect(r.value.skewAdjustment).toBe(0);
    expect(r.value.minimumVarianceDelta).toBe(r.value.blackScholesDelta);
    expect(r.assumptions.betaSource).toBe('skew-sticky-strike');
  });

  it('matches Δ_BS + vega_raw·β from independent blackScholesGreeks (a negative β lowers a call delta)', () => {
    const beta = -0.002; // IV falls 0.2 vol points per +$1 (leverage)
    const r = minimumVarianceDelta({ ...BASE, volatilitySpotBeta: beta });
    const g = blackScholesGreeks({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.03,
      dividendYield: 0,
      volatility: 0.2,
    });
    expect(r.value.blackScholesDelta).toBeCloseTo(g.delta, 12);
    expect(r.value.vega).toBeCloseTo(g.vega, 12);
    expect(r.value.skewAdjustment).toBeCloseTo(g.vega * 100 * beta, 12);
    expect(r.value.minimumVarianceDelta).toBeCloseTo(g.delta + g.vega * 100 * beta, 12);
    expect(r.value.minimumVarianceDelta).toBeLessThan(r.value.blackScholesDelta); // leverage reduces the call hedge
    expect(r.assumptions.betaSource).toBe('supplied');
    expect(r.assumptions.measure).toBe('real-world-hedge');
  });

  it('the self-consistency identity holds: minimumVarianceDelta − blackScholesDelta === skewAdjustment', () => {
    const r = minimumVarianceDelta({ ...BASE, type: 'put', volatilitySpotBeta: 0.0015 });
    expect(r.value.minimumVarianceDelta - r.value.blackScholesDelta).toBeCloseTo(
      r.value.skewAdjustment,
      12,
    );
  });
});

describe('minimumVarianceDelta — β source', () => {
  it('sticky-moneyness maps skewSlope to β = −skewSlope/spot', () => {
    const r = minimumVarianceDelta({ ...BASE, skewSlope: -0.5 }); // default regime
    expect(r.value.volatilitySpotBeta).toBeCloseTo(-(-0.5) / 100, 12); // +0.005
    expect(r.assumptions.betaSource).toBe('skew-sticky-moneyness');
    expect(r.assumptions.regime).toBe('sticky-moneyness');
  });

  it('volatilitySpotBeta overrides skewSlope', () => {
    const r = minimumVarianceDelta({ ...BASE, volatilitySpotBeta: -0.003, skewSlope: -0.5 });
    expect(r.value.volatilitySpotBeta).toBe(-0.003);
    expect(r.assumptions.betaSource).toBe('supplied');
    expect(r.assumptions.regime).toBeUndefined();
  });
});

describe('minimumVarianceDelta — envelope & guards', () => {
  it('throws when no vol–spot sensitivity is given (no silent β = 0)', () => {
    try {
      minimumVarianceDelta({ ...BASE });
      expect.unreachable('a missing β source should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
  });

  it('throws on garbage, a bad type, and non-positive parameters', () => {
    expect(() => minimumVarianceDelta(undefined as never)).toThrowError();
    expect(() =>
      minimumVarianceDelta({ ...BASE, type: 'Call' as never, volatilitySpotBeta: 0 }),
    ).toThrowError();
    expect(() => minimumVarianceDelta({ ...BASE, spot: -1, volatilitySpotBeta: 0 })).toThrowError();
    expect(() =>
      minimumVarianceDelta({ ...BASE, timeToExpiryYears: 0, volatilitySpotBeta: 0 }),
    ).toThrowError();
    expect(() =>
      minimumVarianceDelta({ ...BASE, volatility: 0, volatilitySpotBeta: 0 }),
    ).toThrowError();
  });
});
