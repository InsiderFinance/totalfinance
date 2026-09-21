import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import {
  minVariance,
  maxSharpe,
  meanVariance,
  riskParity,
  hrp,
  kelly,
} from '@totalfinance/risk/optimize';

const cov2 = [
  [4, 1],
  [1, 2],
];
const matVec = (A: number[][], x: number[]): number[] =>
  A.map((r) => r.reduce((s, a, j) => s + a * x[j]!, 0));
const sum = (w: number[]): number => w.reduce((a, b) => a + b, 0);
const variance = (A: number[][], w: number[]): number =>
  w.reduce((s, wi, i) => s + wi * matVec(A, w)[i]!, 0);

describe('minVariance', () => {
  it('KKT: Σw has equal components (unconstrained), weights sum to budget', () => {
    const r = minVariance(cov2);
    expect(sum(r.value.weights)).toBeCloseTo(1, 12);
    const cw = matVec(cov2, r.value.weights);
    expect(cw[0]).toBeCloseTo(cw[1]!, 10); // ∂valueAtRisk/∂w_i equal ⇒ tangent to budget constraint
    // analytic w = Σ⁻¹1 / (1ᵀΣ⁻¹1) = [1/4, 3/4]
    expect(r.value.weights[0]).toBeCloseTo(0.25, 8);
    expect(r.value.weights[1]).toBeCloseTo(0.75, 8);
  });

  it('is the minimum: variance ≤ equal-weight variance', () => {
    const r = minVariance(cov2);
    expect(r.value.objective).toBeLessThanOrEqual(variance(cov2, [0.5, 0.5]) + 1e-12);
  });

  it('long-only == unconstrained when the interior solution is already feasible', () => {
    const r = minVariance(cov2, { longOnly: true });
    expect(r.value.weights[0]).toBeCloseTo(0.25, 6);
    expect(r.value.weights[1]).toBeCloseTo(0.75, 6);
    expect(r.diagnostics.converged).toBe(true);
  });

  it('long-only clamps a short: highly-correlated high-vol asset gets ~0 weight', () => {
    const covariance = [
      [1, 2.7],
      [2.7, 9],
    ]; // corr 0.9, volatilities 1 & 3 → unconstrained shorts asset 2
    const r = minVariance(covariance, { longOnly: true });
    expect(r.value.weights.every((w) => w >= -1e-9)).toBe(true);
    expect(sum(r.value.weights)).toBeCloseTo(1, 8);
    expect(r.value.weights[0]).toBeCloseTo(1, 3);
    expect(r.value.weights[1]).toBeCloseTo(0, 3);
  });

  it('honors per-asset bounds', () => {
    const r = minVariance(cov2, {
      bounds: [
        [0.4, 0.6],
        [0.4, 0.6],
      ],
    });
    expect(r.value.weights[0]).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect(r.value.weights[0]).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(sum(r.value.weights)).toBeCloseTo(1, 8);
  });
});

describe('maxSharpe (tangency)', () => {
  it('KKT: Σw ∝ excess returns; weights sum to budget', () => {
    const mu = [0.15, 0.1];
    const r = maxSharpe({ mean: mu, covariance: cov2 });
    expect(sum(r.value.weights)).toBeCloseTo(1, 10);
    const cw = matVec(cov2, r.value.weights);
    // tangency: Σw ∝ (μ − rf) ⇒ ratios equal
    expect(cw[0]! / mu[0]!).toBeCloseTo(cw[1]! / mu[1]!, 8);
    // analytic w = Σ⁻¹μ normalized = [0.2,0.25]/0.45
    expect(r.value.weights[0]).toBeCloseTo(0.2 / 0.45, 6);
  });
  it('long-only tangency stays feasible and positive-Sharpe', () => {
    const r = maxSharpe({ mean: [0.2, 0.05], covariance: cov2, options: { longOnly: true } });
    expect(r.value.weights.every((w) => w >= -1e-9)).toBe(true);
    expect(sum(r.value.weights)).toBeCloseTo(1, 6);
    expect(r.value.objective).toBeGreaterThan(0);
  });

  it('[review-1] the risk-free rate is PER PERIOD and is named that way', () => {
    // The rate is subtracted from `mean` directly, so it must be in the same per-period units.
    // The old name `riskFreeRate` matched performance/backtest, where the same word means an
    // ANNUAL rate — passing 0.04 on daily inputs silently applied a 4%-per-DAY hurdle.
    const mu = [0.15, 0.1];
    const withRate = maxSharpe({
      mean: mu,
      covariance: cov2,
      options: { riskFreeRatePerPeriod: 0.05 },
    });
    const shifted = maxSharpe({ mean: [0.1, 0.05], covariance: cov2 });
    // subtracting rf from μ ≡ shifting μ down by rf
    expect(withRate.value.weights[0]).toBeCloseTo(shifted.value.weights[0]!, 10);

    // Law 12: the retired spelling is an unknown key — it throws, it does not silently run at 0.
    expect(() =>
      maxSharpe({ mean: mu, covariance: cov2, options: { riskFreeRate: 0.05 } as never }),
    ).toThrow(/riskFreeRate/);
  });
});

describe('meanVariance utility', () => {
  it('KKT: μ − λΣw has equal components (unconstrained)', () => {
    const mu = [0.1, 0.08];
    const lambda = 3;
    const r = meanVariance({ mean: mu, covariance: cov2, options: { riskAversion: lambda } });
    const g = mu.map((m, i) => m - lambda * matVec(cov2, r.value.weights)[i]!);
    expect(g[0]).toBeCloseTo(g[1]!, 9);
    expect(sum(r.value.weights)).toBeCloseTo(1, 10);
  });
  it('higher risk-aversion ⇒ lower variance', () => {
    const mu = [0.12, 0.07];
    const lo = meanVariance({ mean: mu, covariance: cov2, options: { riskAversion: 0.5 } });
    const hi = meanVariance({ mean: mu, covariance: cov2, options: { riskAversion: 8 } });
    expect(variance(cov2, hi.value.weights)).toBeLessThan(variance(cov2, lo.value.weights));
  });
  it('long-only converges and stays feasible', () => {
    const r = meanVariance({
      mean: [0.2, -0.05],
      covariance: cov2,
      options: { riskAversion: 2, longOnly: true },
    });
    expect(r.value.weights.every((w) => w >= -1e-9)).toBe(true);
    expect(sum(r.value.weights)).toBeCloseTo(1, 6);
    expect(r.diagnostics.converged).toBe(true);
  });
  it('non-binding box bounds reproduce the unconstrained analytic solution (box gradient path)', () => {
    // Pins the projected-gradient ascent path (bounds given, no extended constraints) after the
    // per-component matVec hoist: same fixed point, same utility.
    const mu = [0.1, 0.08];
    const unc = meanVariance({ mean: mu, covariance: cov2, options: { riskAversion: 3 } });
    const boxed = meanVariance({
      mean: mu,
      covariance: cov2,
      options: {
        riskAversion: 3,
        bounds: [
          [-5, 5],
          [-5, 5],
        ],
      },
    });
    expect(boxed.diagnostics.converged).toBe(true);
    expect(boxed.value.weights[0]).toBeCloseTo(unc.value.weights[0]!, 6);
    expect(boxed.value.weights[1]).toBeCloseTo(unc.value.weights[1]!, 6);
    expect(boxed.value.objective).toBeCloseTo(unc.value.objective, 8);
  });
});

describe('riskParity', () => {
  it('equalizes per-asset risk contributions', () => {
    const covariance = [
      [0.04, 0.006, 0.0],
      [0.006, 0.09, -0.01],
      [0.0, -0.01, 0.0225],
    ];
    const r = riskParity(covariance);
    expect(sum(r.value.weights)).toBeCloseTo(1, 8);
    const cw = matVec(covariance, r.value.weights);
    const rc = r.value.weights.map((w, i) => w * cw[i]!);
    // all risk contributions equal
    expect(rc[0]).toBeCloseTo(rc[1]!, 6);
    expect(rc[1]).toBeCloseTo(rc[2]!, 6);
    expect(r.diagnostics.converged).toBe(true);
    expect(r.value.weights.every((w) => w > 0)).toBe(true);
  });
});

describe('hrp', () => {
  it('produces positive, fully-invested weights that diversify across correlated blocks', () => {
    // two blocks: {0,1} correlated, {2,3} correlated, blocks ~uncorrelated
    const covariance = [
      [0.04, 0.035, 0.001, 0.001],
      [0.035, 0.04, 0.001, 0.001],
      [0.001, 0.001, 0.09, 0.08],
      [0.001, 0.001, 0.08, 0.09],
    ];
    const r = hrp(covariance);
    expect(r.value.weights.every((w) => w > 0)).toBe(true);
    expect(sum(r.value.weights)).toBeCloseTo(1, 10);
    // the low-variance block {0,1} should receive more total weight than the high-variance block
    expect(r.value.weights[0]! + r.value.weights[1]!).toBeGreaterThan(
      r.value.weights[2]! + r.value.weights[3]!,
    );
  });
});

describe('kelly', () => {
  it('full Kelly w = Σ⁻¹μ ⇒ Σw = μ exactly', () => {
    const mu = [0.1, 0.08];
    const r = kelly({ mean: mu, covariance: cov2 });
    const cw = matVec(cov2, r.value.weights);
    expect(cw[0]).toBeCloseTo(mu[0]!, 10);
    expect(cw[1]).toBeCloseTo(mu[1]!, 10);
  });
  it('fractional Kelly scales the position linearly', () => {
    const full = kelly({ mean: [0.1, 0.08], covariance: cov2 });
    const half = kelly({ mean: [0.1, 0.08], covariance: cov2, options: { fraction: 0.5 } });
    expect(half.value.weights[0]).toBeCloseTo(full.value.weights[0]! * 0.5, 10);
  });
  it('normalize fully invests the Kelly direction', () => {
    const r = kelly({ mean: [0.1, 0.08], covariance: cov2, options: { normalize: true } });
    expect(sum(r.value.weights)).toBeCloseTo(1, 10);
  });
  it('normalize does NOT flip the book when the raw Kelly weights sum negative (review fix)', () => {
    const mu = [-0.1, 0.02];
    const dcov = [
      [0.04, 0],
      [0, 0.09],
    ]; // Σ⁻¹μ = [-2.5, 0.222…]: a net-short book whose total is negative
    const raw = kelly({ mean: mu, covariance: dcov });
    const r = kelly({ mean: mu, covariance: dcov, options: { normalize: true } });
    // the UNnormalized weights come back with signs intact (the old scaleToSum flipped shorts long)
    expect(r.value.weights[0]).toBeCloseTo(raw.value.weights[0]!, 12);
    expect(r.value.weights[1]).toBeCloseTo(raw.value.weights[1]!, 12);
    expect(r.value.weights[0]!).toBeLessThan(0);
    expect(r.value.weights[1]!).toBeGreaterThan(0);
    expect(r.diagnostics.converged).toBe(false);
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_negative_sum')).toBe(true);
  });
});

describe('constraint feasibility', () => {
  // two assets each capped at 0.4 cannot sum to a budget of 1 — the set is empty.
  const infeasibleBounds: [number, number][] = [
    [0, 0.4],
    [0, 0.4],
  ];
  it('an infeasible box+budget reports converged:false, never a fabricated success', () => {
    expect(minVariance(cov2, { bounds: infeasibleBounds }).diagnostics.converged).toBe(false);
    expect(
      meanVariance({ mean: [0.1, 0.1], covariance: cov2, options: { bounds: infeasibleBounds } })
        .diagnostics.converged,
    ).toBe(false);
    expect(
      maxSharpe({ mean: [0.1, 0.1], covariance: cov2, options: { bounds: infeasibleBounds } })
        .diagnostics.converged,
    ).toBe(false);
  });

  it('a feasible box still converges', () => {
    expect(
      minVariance(cov2, {
        bounds: [
          [0, 0.6],
          [0, 0.6],
        ],
      }).diagnostics.converged,
    ).toBe(true);
  });
});

describe('constrained maxSharpe respects per-asset bounds', () => {
  it('caps the dominant asset at its upper bound instead of overshooting via renormalization', () => {
    // unconstrained tangency would put >100% in asset 0; the 0.6 cap must hold after solving.
    const r = maxSharpe({
      mean: [0.3, 0.05],
      covariance: cov2,
      options: {
        bounds: [
          [0, 0.6],
          [0, 1],
        ],
      },
    });
    expect(r.diagnostics.converged).toBe(true);
    expect(r.value.weights[0]!).toBeLessThanOrEqual(0.6 + 1e-6); // the bug returned ~0.98 here
    expect(r.value.weights[0]!).toBeCloseTo(0.6, 3); // pushed to the cap
    expect(r.value.weights.every((w) => w >= -1e-9)).toBe(true);
    expect(sum(r.value.weights)).toBeCloseTo(1, 6);
    expect(r.value.objective).toBeGreaterThan(0);
  });
});

describe('validation', () => {
  it('rejects non-square covariance and mismatched bounds', () => {
    expect(() => minVariance([[1, 0]])).toThrow(InputError);
    expect(() => minVariance(cov2, { bounds: [[0, 1]] })).toThrow(InputError);
  });

  it('rejects a mean vector whose length does not match the assets, or is non-finite', () => {
    expect(() => maxSharpe({ mean: [0.1], covariance: cov2 })).toThrow(InputError);
    expect(() => meanVariance({ mean: [0.1, 0.2, 0.3], covariance: cov2 })).toThrow(InputError);
    expect(() => kelly({ mean: [0.1], covariance: cov2 })).toThrow(InputError);
    expect(() => maxSharpe({ mean: [0.1, NaN], covariance: cov2 })).toThrow(InputError);
  });

  it('rejects invalid numeric knobs instead of leaking NaN weights with converged:true', () => {
    expect(() => minVariance(cov2, { budget: NaN })).toThrow(InputError);
    expect(() =>
      kelly({ mean: [0.1, 0.08], covariance: cov2, options: { fraction: NaN } }),
    ).toThrow(InputError);
    expect(() =>
      meanVariance({ mean: [0.1, 0.08], covariance: cov2, options: { riskAversion: 0 } }),
    ).toThrow(InputError);
    expect(() =>
      meanVariance({ mean: [0.1, 0.08], covariance: cov2, options: { riskAversion: -1 } }),
    ).toThrow(InputError);
    expect(() =>
      maxSharpe({ mean: [0.1, 0.08], covariance: cov2, options: { tolerance: NaN } }),
    ).toThrow(InputError);
    expect(() => riskParity(cov2, { maximumIterations: 0 })).toThrow(InputError);
  });

  it('kelly rejects a non-positive fraction in the UNCONSTRAINED branch too (review fix)', () => {
    expect(() => kelly({ mean: [0.1, 0.08], covariance: cov2, options: { fraction: -1 } })).toThrow(
      /fraction/,
    );
    expect(() => kelly({ mean: [0.1, 0.08], covariance: cov2, options: { fraction: 0 } })).toThrow(
      /fraction/,
    );
  });
});
