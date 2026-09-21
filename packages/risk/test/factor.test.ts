import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { pca, factorExposure, covarianceToCorrelation } from '@totalfinance/risk/factor';

describe('pca', () => {
  it('diagonal covariance: eigenvalues = variances, components are the axes', () => {
    const res = pca([
      [4, 0],
      [0, 1],
    ]);
    expect(res.eigenvalues[0]).toBeCloseTo(4, 10);
    expect(res.eigenvalues[1]).toBeCloseTo(1, 10);
    expect(res.varianceExplained[0]).toBeCloseTo(0.8, 10);
    expect(res.cumulativeVariance[1]).toBeCloseTo(1, 10);
    expect(res.totalVariance).toBeCloseTo(5, 10);
    // first axis is e1 (canonical positive sign)
    expect(Math.abs(res.loadings[0]![0]!)).toBeCloseTo(1, 10);
    expect(Math.abs(res.loadings[0]![1]!)).toBeCloseTo(0, 10);
  });

  it('correlated 2×2 [[2,1],[1,2]]: eigenvalues 3 & 1 with (1,1)/√2 and (1,−1)/√2', () => {
    const res = pca([
      [2, 1],
      [1, 2],
    ]);
    expect(res.eigenvalues[0]).toBeCloseTo(3, 10);
    expect(res.eigenvalues[1]).toBeCloseTo(1, 10);
    const inv = 1 / Math.SQRT2;
    expect(res.loadings[0]![0]).toBeCloseTo(inv, 8);
    expect(res.loadings[0]![1]).toBeCloseTo(inv, 8);
    expect(Math.abs(res.loadings[1]![0]!)).toBeCloseTo(inv, 8);
    expect(res.varianceExplained[0]).toBeCloseTo(0.75, 10);
  });

  it('spectral reconstruction Σ = Σ λ_k v_k v_kᵀ recovers the covariance', () => {
    const covariance = [
      [0.04, 0.006, 0.0],
      [0.006, 0.09, -0.01],
      [0.0, -0.01, 0.0225],
    ];
    const res = pca(covariance);
    const n = 3;
    const recon = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    res.components.forEach((c) => {
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) recon[i]![j]! += c.eigenvalue * c.loadings[i]! * c.loadings[j]!;
    });
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) expect(recon[i]![j]).toBeCloseTo(covariance[i]![j]!, 8);
  });

  it('variance explained always sums to 1; eigenvalues sorted descending', () => {
    const res = pca([
      [0.04, 0.006, 0.0],
      [0.006, 0.09, -0.01],
      [0.0, -0.01, 0.0225],
    ]);
    expect(res.varianceExplained.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
    expect(res.eigenvalues[0]).toBeGreaterThanOrEqual(res.eigenvalues[1]!);
    expect(res.eigenvalues[1]).toBeGreaterThanOrEqual(res.eigenvalues[2]!);
  });

  it('correlation mode standardizes to unit diagonal', () => {
    const corr = covarianceToCorrelation([
      [4, 1],
      [1, 1],
    ]);
    expect(corr[0]![0]).toBeCloseTo(1, 12);
    expect(corr[1]![1]).toBeCloseTo(1, 12);
    expect(corr[0]![1]).toBeCloseTo(0.5, 12); // 1/(2·1)
  });
});

describe('factorExposure', () => {
  const covariance = [
    [0.04, 0.018, 0.012],
    [0.018, 0.09, 0.02],
    [0.012, 0.02, 0.0225],
  ];
  it('keeps the top-k factors and reports each asset’s loading on them', () => {
    const fe = factorExposure(covariance, { factorCount: 1 });
    expect(fe.factors).toHaveLength(1);
    expect(fe.exposure).toHaveLength(3); // one row per asset
    expect(fe.exposure[0]).toHaveLength(1); // one column per retained factor
    expect(fe.varianceExplained).toBeGreaterThan(0);
    expect(fe.varianceExplained).toBeLessThanOrEqual(1);
  });
  it('throws on a non-square matrix', () => {
    expect(() => pca([[1, 0]])).toThrow(InputError);
  });
  it('rejects a non-positive k instead of silently keeping all-but-last via slice(0,-1)', () => {
    expect(() => factorExposure(covariance, { factorCount: -1 })).toThrow(InputError);
    expect(() => factorExposure(covariance, { factorCount: 0 })).toThrow(InputError);
    expect(() => factorExposure(covariance, { factorCount: 1.5 })).toThrow(InputError);
  });
});
