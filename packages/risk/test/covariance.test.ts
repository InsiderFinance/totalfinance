import { describe, expect, it } from 'vitest';
import { covariance, maxSharpe, meanReturns, minVariance } from '@totalfinance/risk';

/**
 * D11 / P3.6 — the covariance on-ramp: returns → covariance()/meanReturns() → optimizer, with
 * observations-major input (one row per period) and the conditioning report on diagnostics.
 */

// 8 periods × 3 assets, observations-major (rows = periods).
const RETURNS = [
  [0.012, -0.004, 0.006],
  [-0.008, 0.011, -0.002],
  [0.005, 0.003, 0.009],
  [0.014, -0.009, -0.005],
  [-0.011, 0.007, 0.004],
  [0.009, 0.002, -0.008],
  [-0.003, -0.006, 0.011],
  [0.007, 0.008, 0.001],
];

describe('risk.covariance (D11)', () => {
  it('estimates an SPD covariance with means, in the analysis grammar', () => {
    const r = covariance({ returns: RETURNS, assets: ['SPY', 'TLT', 'GLD'] });
    expect(r.value.covariance).toHaveLength(3);
    expect(r.value.covariance[0]).toHaveLength(3);
    expect(r.value.meanReturns).toHaveLength(3);
    expect(r.value.assets).toEqual(['SPY', 'TLT', 'GLD']);
    expect(r.assumptions.orientation).toBe('observations-major');
    expect(r.assumptions.observations).toBe(8);
    expect(r.diagnostics.isPositiveDefinite).toBe(true);
    expect(r.diagnostics.conditionNumber).toBeGreaterThan(0);
    // Symmetry + diagonal variances positive.
    for (let i = 0; i < 3; i++) {
      expect(r.value.covariance[i]![i]!).toBeGreaterThan(0);
      for (let j = 0; j < 3; j++) {
        expect(r.value.covariance[i]![j]).toBeCloseTo(r.value.covariance[j]![i]!, 12);
      }
    }
  });

  it('matches a hand-computed population covariance entry and mean', () => {
    const r = covariance({ returns: RETURNS });
    const col0 = RETURNS.map((row) => row[0]!);
    const mu0 = col0.reduce((a, b) => a + b, 0) / col0.length;
    const var0 = col0.reduce((a, b) => a + (b - mu0) ** 2, 0) / col0.length;
    expect(r.value.meanReturns[0]).toBeCloseTo(mu0, 14);
    expect(r.value.covariance[0]![0]).toBeCloseTo(var0, 14);
  });

  it('the journey composes: value plugs straight into minVariance and maxSharpe', () => {
    const { covariance: covarianceMatrix, meanReturns: mu } = covariance({
      returns: RETURNS,
    }).value;
    const w1 = minVariance(covarianceMatrix, { longOnly: true }).value.weights;
    const w2 = maxSharpe({ mean: mu, covariance: covarianceMatrix, options: { longOnly: true } })
      .value.weights;
    for (const w of [w1, w2]) {
      expect(w).toHaveLength(3);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    }
  });

  it('a collinear book is disclosed, never returned silently singular', () => {
    // Asset 2 is exactly 2× asset 1 — rank-deficient by construction.
    const collinear = RETURNS.map((row) => [row[0]!, 2 * row[0]!, row[2]!]);
    const r = covariance({ returns: collinear });
    // auto shrinks to an SPD estimate and says so.
    expect(r.diagnostics.isPositiveDefinite).toBe(true);
    expect(r.assumptions.method).not.toBe('sample');
    expect((r.diagnostics.warnings ?? []).length).toBeGreaterThan(0);
  });

  it('rejects ragged rows and mislabeled assets with typed errors', () => {
    expect(() => covariance({ returns: [[0.01, 0.02], [0.01]] })).toThrow(/every period row/);
    expect(() => covariance({ returns: RETURNS, assets: ['A'] })).toThrow(/labels/);
    expect(() => covariance(undefined as never)).toThrow(/input/);
  });
});

describe('risk.meanReturns', () => {
  it('per-period means by default; annualization is explicit, never silent', () => {
    const perPeriod = meanReturns({ returns: RETURNS });
    const annual = meanReturns({ returns: RETURNS, periodsPerYear: 252 });
    for (let k = 0; k < 3; k++) {
      expect(annual[k]).toBeCloseTo(perPeriod[k]! * 252, 12);
    }
  });

  it('rejects a non-positive periodsPerYear', () => {
    expect(() => meanReturns({ returns: RETURNS, periodsPerYear: 0 })).toThrow(/periodsPerYear/);
  });
});
