/**
 * Estimation-error-shrunk portfolio Kelly (`shrunkKelly`). Pins the shrinkage factor to
 * `max(0, 1 − (n/T)/θ̂²)` and its monotone approach to 1 as `T` grows; the shrunk weights as `c*·Σ̂⁻¹μ̂`
 * (with `Σ̂·naive = μ̂`); the shrunk book's expected OOS growth ≥ the naive book's; the no-edge zero book
 * (`n/T ≥ θ̂²`), the naive-overbet flag, and the thin-sample flag; and the SPD / dimension guards.
 */

import { describe, expect, it } from 'vitest';
import { shrunkKelly } from '@totalfinance/risk';

const MU = [0.08, 0.05, 0.03];
const SIG = [
  [0.04, 0.006, 0.004],
  [0.006, 0.02, 0.003],
  [0.004, 0.003, 0.01],
];
const N = 3;

/** Σ·w (to confirm the naive weights solve Σ w = μ). */
const matVec = (A: number[][], v: number[]): number[] =>
  A.map((row) => row.reduce((s, x, j) => s + x * v[j]!, 0));

describe('shrunkKelly', () => {
  it('shrinks by max(0, 1 − (n/T)/θ̂²) and approaches 1 as the sample grows', () => {
    let prev = -1;
    for (const T of [24, 60, 120, 600]) {
      const r = shrunkKelly({ mean: MU, covariance: SIG, sampleSize: T });
      expect(r.shrinkage).toBeCloseTo(Math.max(0, 1 - N / T / r.inSampleSharpeSquared), 12);
      expect(r.correctedSharpeSquared).toBeCloseTo(r.inSampleSharpeSquared - N / T, 12);
      expect(r.shrinkage).toBeGreaterThan(prev); // monotone increasing in T
      expect(r.shrinkage).toBeLessThanOrEqual(1);
      prev = r.shrinkage;
    }
  });

  it('returns c*·Σ̂⁻¹μ̂; the naive weights solve Σ̂ w = μ̂', () => {
    const r = shrunkKelly({ mean: MU, covariance: SIG, sampleSize: 60 });
    // naive weights are Σ̂⁻¹μ̂ ⇒ Σ̂ · naive = μ̂.
    const recovered = matVec(SIG, r.naiveWeights);
    for (let i = 0; i < N; i++) expect(recovered[i]).toBeCloseTo(MU[i]!, 12);
    // shrunk = shrinkage · naive.
    for (let i = 0; i < N; i++)
      expect(r.weights[i]).toBeCloseTo(r.shrinkage * r.naiveWeights[i]!, 12);
    expect(r.appliedScaling).toBeCloseTo(r.shrinkage, 12); // fraction defaults to 1
    // the shrunk book's expected OOS growth is at least the naive book's.
    expect(r.expectedGrowth).toBeGreaterThanOrEqual(r.naiveExpectedGrowth);
  });

  it('applies an extra fractional-Kelly multiplier on top of the shrinkage', () => {
    const full = shrunkKelly({ mean: MU, covariance: SIG, sampleSize: 120 });
    const half = shrunkKelly({ mean: MU, covariance: SIG, sampleSize: 120, fraction: 0.5 });
    expect(half.shrinkage).toBeCloseTo(full.shrinkage, 12); // shrinkage itself unchanged
    expect(half.appliedScaling).toBeCloseTo(0.5 * full.shrinkage, 12);
    for (let i = 0; i < N; i++) expect(half.weights[i]).toBeCloseTo(0.5 * full.weights[i]!, 12);
  });

  it('returns a ZERO book and a no-edge warning when n/T ≥ θ̂²', () => {
    const r = shrunkKelly({ mean: [0.005, 0.003, 0.002], covariance: SIG, sampleSize: 20 });
    expect(r.correctedSharpeSquared).toBeLessThanOrEqual(0);
    expect(r.shrinkage).toBe(0);
    expect(r.weights).toEqual([0, 0, 0]);
    expect(r.diagnostics.converged).toBe(false);
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_estimation_no_edge')).toBe(
      true,
    );

    // A zero mean ⇒ θ̂² = 0 ⇒ shrinkage 0 (no division by the zero Sharpe), a zero book, no-edge.
    const flat = shrunkKelly({ mean: [0, 0, 0], covariance: SIG, sampleSize: 60 });
    expect(flat.inSampleSharpeSquared).toBe(0);
    expect(flat.shrinkage).toBe(0);
    expect(flat.weights).toEqual([0, 0, 0]);
    expect(flat.diagnostics.warnings.some((w) => w.code === 'risk.kelly_estimation_no_edge')).toBe(
      true,
    );
  });

  it('flags the naive book as overbetting when its expected OOS growth is negative but c* > 0', () => {
    const r = shrunkKelly({ mean: MU, covariance: SIG, sampleSize: 12 });
    expect(r.shrinkage).toBeGreaterThan(0);
    expect(r.naiveExpectedGrowth).toBeLessThan(0); // naive would erode capital
    expect(r.expectedGrowth).toBeGreaterThan(0); // shrinkage restores positive growth
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_naive_overbet')).toBe(true);
  });

  it('flags a thin sample (T ≤ 2n)', () => {
    // A strong edge keeps c* > 0 at T = 2n so the thin-sample flag is isolated.
    const r = shrunkKelly({ mean: [0.3, 0.2, 0.15], covariance: SIG, sampleSize: 6 });
    expect(r.shrinkage).toBeGreaterThan(0);
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_estimation_thin_sample')).toBe(
      true,
    );
  });

  it('guards dimensions, a non-SPD covariance, and bad scalars', () => {
    expect(() => shrunkKelly(undefined as never)).toThrowError();
    expect(() => shrunkKelly({ mean: [], covariance: [], sampleSize: 60 })).toThrowError(); // no assets
    expect(() => shrunkKelly({ mean: [0.1, 0.1], covariance: SIG, sampleSize: 60 })).toThrowError(); // mean/covariance mismatch
    expect(() =>
      shrunkKelly({
        mean: MU,
        covariance: [
          [0.04, 0.006],
          [0.006, 0.02],
          [0.004, 0.003],
        ],
        sampleSize: 60,
      }),
    ).toThrowError(); // non-square row
    expect(() =>
      shrunkKelly({
        mean: MU,
        covariance: [
          [1, 2, 0],
          [2, 1, 0],
          [0, 0, 1],
        ],
        sampleSize: 60,
      }),
    ).toThrowError(); // not positive-definite
    expect(() => shrunkKelly({ mean: MU, covariance: SIG, sampleSize: -5 })).toThrowError();
    expect(() =>
      shrunkKelly({ mean: MU, covariance: SIG, sampleSize: 60, fraction: -1 }),
    ).toThrowError();
  });
});
