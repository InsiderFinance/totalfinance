/**
 * EVT tail-risk pack (`fitGeneralizedParetoTail`, `extremeValueTailRisk`, `drawdownAtRisk`, `spectralRisk`). The estimators are
 * validated by recovering a KNOWN GPD tail index from a simulated sample (the GPD is threshold-stable,
 * so the excess over any threshold keeps ξ); EVT VaR is cross-checked against the tail-probability
 * inversion that defines it and shown to exceed the Gaussian on a fat-tailed sample; the drawdown and
 * spectral measures are checked against a hand-computed path and against the empirical ES (the coherent
 * self-consistency: an ES spectrum reproduces Expected Shortfall).
 */

import { describe, expect, it } from 'vitest';
import {
  drawdownAtRisk,
  extremeValueTailRisk,
  fitGeneralizedParetoTail,
  meanExcessPlot,
  spectralRisk,
} from '@totalfinance/risk';

/** Inverse GPD CDF (test-local sampler; the package keeps this a private implementation detail). */
function gpdInverseCdf(u: number, shape: number, scale: number): number {
  return shape === 0 ? -scale * Math.log(1 - u) : (scale / shape) * (Math.pow(1 - u, -shape) - 1);
}

/** Deterministic LCG uniforms. */
function randomNumberGenerator(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 0) / 2 ** 32;
  };
}

/** A return series whose losses are exactly GPD(ξ, β) — the excess over any threshold stays GPD(ξ, ·). */
function gpdReturns(xi: number, beta: number, n: number, seed: number): number[] {
  const u = randomNumberGenerator(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(-gpdInverseCdf(Math.max(1e-12, u()), xi, beta));
  return out;
}

/** Student-t(3) fat-tailed returns, scaled. */
function fatReturns(n: number, seed: number): number[] {
  const u = randomNumberGenerator(seed);
  const norm = (): number =>
    Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u());
  const t3 = (): number => {
    const z = norm();
    let c = 0;
    for (let k = 0; k < 3; k++) {
      const g = norm();
      c += g * g;
    }
    return z / Math.sqrt(c / 3);
  };
  return Array.from({ length: n }, () => 0.0003 + 0.012 * t3());
}

describe('gpdInverseCdf', () => {
  it('inverts the GPD CDF (round-trip) and matches the exponential/heavy closed forms', () => {
    // ξ = 0: G⁻¹(u) = −β·ln(1−u); median = β·ln2.
    expect(gpdInverseCdf(0.5, 0, 0.03)).toBeCloseTo(0.03 * Math.LN2, 12);
    // ξ ≠ 0: G(G⁻¹(u)) = u, where G(y) = 1 − (1 + ξy/β)^(−1/ξ).
    for (const [xi, beta] of [
      [0.25, 0.02],
      [-0.1, 0.05],
    ] as [number, number][]) {
      for (const u of [0.1, 0.5, 0.9, 0.99]) {
        const y = gpdInverseCdf(u, xi, beta);
        const cdf = 1 - (1 + (xi * y) / beta) ** (-1 / xi);
        expect(cdf).toBeCloseTo(u, 10);
      }
    }
  });
});

describe('fitGeneralizedParetoTail — estimator recovery', () => {
  it('PWM and MLE recover a known tail index ξ from a simulated GPD sample', () => {
    const returns = gpdReturns(0.25, 0.02, 20_000, 42);
    const pwm = fitGeneralizedParetoTail(returns, { tailFraction: 0.1, method: 'pwm' });
    const mle = fitGeneralizedParetoTail(returns, { tailFraction: 0.1, method: 'mle' });
    expect(Math.abs(pwm.shape - 0.25)).toBeLessThan(0.06);
    expect(Math.abs(mle.shape - 0.25)).toBeLessThan(0.06);
    expect(pwm.scale).toBeGreaterThan(0);
    expect(pwm.exceedances).toBeCloseTo(2000, -2); // ~10% of 20k
    expect(pwm.method).toBe('pwm');
    expect(mle.method).toBe('mle');
  });

  it('flags an infinite-variance tail (ξ ≥ 0.5) and an infinite-mean tail (ξ ≥ 1)', () => {
    const heavy = fitGeneralizedParetoTail(gpdReturns(0.6, 0.02, 20_000, 42), {
      tailFraction: 0.1,
    });
    expect(heavy.shape).toBeGreaterThanOrEqual(0.5);
    expect(
      heavy.diagnostics.warnings.some((w) => w.code === 'risk.extreme_value_infinite_variance'),
    ).toBe(true);

    const veryHeavy = fitGeneralizedParetoTail(gpdReturns(1.25, 0.02, 20_000, 42), {
      tailFraction: 0.1,
      method: 'mle',
    });
    expect(veryHeavy.shape).toBeGreaterThanOrEqual(1);
    expect(
      veryHeavy.diagnostics.warnings.some((w) => w.code === 'risk.extreme_value_infinite_mean'),
    ).toBe(true);
  });

  it('warns when there are too few exceedances', () => {
    const f = fitGeneralizedParetoTail(fatReturns(60, 7), { tailFraction: 0.1 }); // ~6 exceedances
    expect(
      f.diagnostics.warnings.some((w) => w.code === 'risk.extreme_value_few_exceedances'),
    ).toBe(true);
  });

  it('accepts an explicit loss threshold (overriding tailFraction)', () => {
    const returns = fatReturns(3000, 11);
    const f = fitGeneralizedParetoTail(returns, { threshold: 0.02 });
    expect(f.threshold).toBe(0.02);
    expect(f.exceedances).toBeGreaterThan(0);
    expect(f.tailFraction).toBeCloseTo(f.exceedances / f.observationCount, 12);
    expect(Number.isFinite(f.shape)).toBe(true);
  });

  it('recovers a near-zero tail index from exponential (ξ = 0) losses via MLE', () => {
    const f = fitGeneralizedParetoTail(gpdReturns(0, 0.02, 20_000, 42), {
      tailFraction: 0.1,
      method: 'mle',
    });
    expect(Math.abs(f.shape)).toBeLessThan(0.1); // exponential tail — thin, ξ ≈ 0
  });

  it('flags a degenerate fit from near-constant exceedances instead of returning an absurd ξ', () => {
    // 180 tiny losses + 20 identical large losses → the exceedances are all equal ⇒ |ξ| blows up.
    const returns = [...Array(180).fill(-0.001), ...Array(20).fill(-0.3)];
    const f = fitGeneralizedParetoTail(returns, { tailFraction: 0.1 });
    expect(Math.abs(f.shape)).toBeGreaterThan(10);
    expect(f.diagnostics.warnings.some((w) => w.code === 'risk.extreme_value_degenerate_fit')).toBe(
      true,
    );
  });
});

describe('extremeValueTailRisk', () => {
  it('EVT VaR satisfies the tail-probability inversion that defines it', () => {
    const returns = fatReturns(3000, 2024);
    const e = extremeValueTailRisk(returns, { confidence: 0.99, tailFraction: 0.1 });
    const { shape: xi, scale: beta, threshold: u, exceedances: nu, observationCount } = e.fit;
    // P(loss > VaR) via the fitted tail must equal 1 − confidence.
    const tailProbAtVar =
      (nu / observationCount) * (1 + (xi * (e.valueAtRisk - u)) / beta) ** (-1 / xi);
    expect(tailProbAtVar).toBeCloseTo(1 - 0.99, 6);
    expect(e.conditionalValueAtRisk).toBeGreaterThanOrEqual(e.valueAtRisk); // ES ≥ VaR
  });

  it('reads a fatter tail than the Gaussian on a fat-tailed sample, near the empirical quantile', () => {
    const returns = fatReturns(3000, 99);
    const e = extremeValueTailRisk(returns, { confidence: 0.995 });
    expect(e.tailFatnessRatio).toBeGreaterThan(1); // EVT > normal
    expect(e.valueAtRisk).toBeGreaterThan(e.normal.valueAtRisk);
    // EVT should track the empirical quantile within ~20% (both estimate the same tail).
    expect(
      Math.abs(e.valueAtRisk - e.empirical.valueAtRisk) / e.empirical.valueAtRisk,
    ).toBeLessThan(0.2);
  });

  it('does not extrapolate outside the fitted tail — falls back to the empirical quantile', () => {
    const returns = fatReturns(3000, 5);
    const e = extremeValueTailRisk(returns, { confidence: 0.85, tailFraction: 0.1 }); // 1−0.85 = 0.15 > 0.10
    expect(
      e.diagnostics.warnings.some((w) => w.code === 'risk.extreme_value_confidence_outside_tail'),
    ).toBe(true);
    expect(e.valueAtRisk).toBe(e.empirical.valueAtRisk);
  });

  it('an infinite-mean tail (ξ ≥ 1) yields an infinite Expected Shortfall', () => {
    const e = extremeValueTailRisk(gpdReturns(1.25, 0.02, 20_000, 42), {
      confidence: 0.99,
      method: 'mle',
    });
    expect(e.fit.shape).toBeGreaterThanOrEqual(1);
    expect(e.conditionalValueAtRisk).toBe(Infinity);
  });
});

describe('drawdownAtRisk', () => {
  it('matches a hand-computed monotone-decline path and obeys DaR ≤ CDaR ≤ maxDrawdown', () => {
    const returns = Array(10).fill(-0.05); // equity 1·0.95ᵗ, monotone underwater
    const d = drawdownAtRisk(returns, { confidence: 0.95 });
    expect(d.maxDrawdown).toBeCloseTo(1 - 0.95 ** 10, 6); // 0.401263
    expect(d.drawdownAtRisk).toBeGreaterThanOrEqual(0);
    expect(d.conditionalDrawdownAtRisk).toBeGreaterThanOrEqual(d.drawdownAtRisk);
    expect(d.maxDrawdown).toBeGreaterThanOrEqual(d.conditionalDrawdownAtRisk - 1e-12);
    expect(d.observations).toBe(10);
  });

  it('a never-underwater (monotone-up) path has zero drawdown risk', () => {
    const d = drawdownAtRisk(Array(20).fill(0.01), { confidence: 0.95 });
    expect(d.maxDrawdown).toBe(0);
    expect(d.drawdownAtRisk).toBe(0);
    expect(d.conditionalDrawdownAtRisk).toBe(0);
  });

  it('guards empty and non-finite return series', () => {
    expect(() => drawdownAtRisk([])).toThrowError();
    expect(() => drawdownAtRisk([0.01, NaN])).toThrowError();
    expect(() => drawdownAtRisk(undefined as never)).toThrowError();
  });
});

describe('spectralRisk', () => {
  it('the Expected-Shortfall spectrum reproduces the empirical ES (coherence self-check)', () => {
    const returns = fatReturns(1000, 314);
    const sr = spectralRisk(returns, { alpha: 0.95 });
    const empES = extremeValueTailRisk(returns, { confidence: 0.95 }).empirical
      .conditionalValueAtRisk;
    expect(sr.spectrum).toBe('expected-shortfall');
    expect(sr.value).toBeCloseTo(empES, 6);
  });

  it('the exponential spectrum is more risk-averse than the mean and rises with risk-aversion k', () => {
    const returns = fatReturns(1000, 271);
    const meanLoss = returns.reduce((s, r) => s - r, 0) / returns.length;
    const dflt = spectralRisk(returns); // default k = 10
    const mild = spectralRisk(returns, { riskAversion: 5 });
    const harsh = spectralRisk(returns, { riskAversion: 25 });
    expect(mild.value).toBeGreaterThan(meanLoss); // overweights losses ⇒ ≥ mean
    expect(harsh.value).toBeGreaterThan(mild.value); // more aversion ⇒ heavier tail weight
    expect(dflt.riskAversion).toBe(10); // disclosed default
    expect(mild.spectrum).toBe('exponential');
    expect(mild.riskAversion).toBe(5);
  });
});

describe('EVT pack — guards', () => {
  it('throws on garbage and out-of-range parameters', () => {
    expect(() => fitGeneralizedParetoTail(undefined as never)).toThrowError();
    expect(() => fitGeneralizedParetoTail([0.01])).toThrowError(); // < 2 returns
    expect(() => fitGeneralizedParetoTail([0.01, 0.02, NaN])).toThrowError(); // non-finite
    expect(() =>
      fitGeneralizedParetoTail(fatReturns(500, 1), { tailFraction: 1.5 }),
    ).toThrowError();
    expect(() =>
      fitGeneralizedParetoTail(fatReturns(500, 1), { method: 'bogus' as never }),
    ).toThrowError();
    expect(() =>
      fitGeneralizedParetoTail(fatReturns(500, 1), { threshold: Infinity }),
    ).toThrowError(); // non-finite threshold
    // A tiny tail fraction on a small sample leaves < 2 exceedances → throws.
    expect(() =>
      fitGeneralizedParetoTail([0.01, -0.02, 0.03, -0.04], { tailFraction: 0.01 }),
    ).toThrowError();
    expect(() => extremeValueTailRisk(fatReturns(500, 1), { confidence: 1.2 })).toThrowError();
    expect(() => drawdownAtRisk(fatReturns(500, 1), { confidence: 0 })).toThrowError();
    expect(() => spectralRisk(fatReturns(500, 1), { alpha: 1.5 })).toThrowError();
    expect(() => spectralRisk(fatReturns(500, 1), { riskAversion: -1 })).toThrowError();
  });
});

describe('meanExcessPlot — EVT threshold selection', () => {
  it('recovers the GPD tail index from the slope of the (linear) mean-excess curve', () => {
    const r = meanExcessPlot(gpdReturns(0.3, 1, 20_000, 7));
    // GPD losses ⇒ mean-excess increases (ξ > 0) and is linear, so the slope recovers ξ ≈ 0.3.
    expect(r.tailIndexEstimate).toBeGreaterThan(0.2);
    expect(r.tailIndexEstimate).toBeLessThan(0.4);
    expect(r.points.length).toBeGreaterThan(5);
    expect(r.points[r.points.length - 1]!.meanExcess).toBeGreaterThan(r.points[0]!.meanExcess);
    // Exceedances strictly decrease as the threshold rises.
    for (let i = 1; i < r.points.length; i++)
      expect(r.points[i]!.exceedances).toBeLessThanOrEqual(r.points[i - 1]!.exceedances);
  });

  it('computes e(u) as the mean of the excesses over u (matches a direct computation)', () => {
    const returns = gpdReturns(0.25, 1, 5_000, 3);
    const losses = returns.map((x) => -x);
    const r = meanExcessPlot(returns);
    const pt = r.points[2]!;
    const exc = losses.filter((x) => x > pt.threshold).map((x) => x - pt.threshold);
    const direct = exc.reduce((a, b) => a + b, 0) / exc.length;
    expect(pt.meanExcess).toBeCloseTo(direct, 12);
    expect(pt.exceedances).toBe(exc.length);
    expect(pt.standardError).toBeGreaterThan(0);
  });

  it('suggests a threshold whose tail fraction fits GPD to a consistent tail index', () => {
    const returns = gpdReturns(0.35, 1, 20_000, 11);
    const r = meanExcessPlot(returns);
    expect(r.suggestedTailFraction).toBeGreaterThan(0);
    expect(r.suggestedTailFraction).toBeLessThanOrEqual(0.5); // ≤ the median-loss grid start
    // Feeding the suggested threshold to fitGPDTail recovers a consistent ξ.
    const fit = fitGeneralizedParetoTail(returns, { threshold: r.suggestedThreshold });
    expect(fit.shape).toBeCloseTo(r.tailIndexEstimate, 1); // both ≈ 0.35, within ~0.1
    expect(fit.threshold).toBe(r.suggestedThreshold);
  });

  it('detects a positive tail index on a genuinely heavy-tailed (Student-t₃) sample', () => {
    const r = meanExcessPlot(fatReturns(20_000, 5));
    expect(r.tailIndexEstimate).toBeGreaterThan(0); // t₃ has ξ ≈ 1/3 > 0
  });

  it('accepts explicit candidate thresholds', () => {
    const returns = gpdReturns(0.3, 1, 5_000, 8);
    const r = meanExcessPlot(returns, { thresholds: [0.5, 1, 1.5, 2, 3] });
    expect(r.points.map((p) => p.threshold)).toEqual([0.5, 1, 1.5, 2, 3]);
  });

  it('warns and falls back when no threshold gives a linear region within the tolerance', () => {
    // An impossibly tight tolerance ⇒ no start index qualifies ⇒ fallback + warning.
    const r = meanExcessPlot(fatReturns(5_000, 9), { linearTolerance: 1e-9 });
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.mean_excess_no_linear_region')).toBe(
      true,
    );
    expect(Number.isFinite(r.suggestedThreshold)).toBe(true);
  });

  it('skips thresholds above all losses, and throws when none have any exceedances', () => {
    const returns = gpdReturns(0.3, 1, 5_000, 3);
    const skipped = meanExcessPlot(returns, { thresholds: [0.5, 1, 1e9] }); // 1e9 exceeds every loss
    expect(skipped.points.map((p) => p.threshold)).toEqual([0.5, 1]);
    expect(() => meanExcessPlot(returns, { thresholds: [1e9, 2e9] })).toThrowError();
  });

  it('handles degenerate slices: identical (zero-range) thresholds and a single-exceedance top', () => {
    const returns = gpdReturns(0.3, 1, 5_000, 3);
    // Identical thresholds ⇒ a flat, zero-range, degenerate-slope slice that is trivially "linear".
    const flat = meanExcessPlot(returns, { thresholds: [5, 5, 5] });
    expect(flat.suggestedThreshold).toBe(5);
    // A tiny sample (losses 1…12) with high thresholds ⇒ a single-exceedance point (no SE) and the
    // no-linear-region fallback (no threshold reaches the default 10 exceedances).
    const tiny = meanExcessPlot([-1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12], {
      thresholds: [10.5, 11.5],
    });
    expect(tiny.points[1]!.exceedances).toBe(1);
    expect(tiny.points[1]!.standardError).toBe(0);
    expect(
      tiny.diagnostics.warnings.some((w) => w.code === 'risk.mean_excess_no_linear_region'),
    ).toBe(true);
  });

  it('guards bad options and insufficient data', () => {
    const returns = gpdReturns(0.3, 1, 2_000, 1);
    expect(() => meanExcessPlot(undefined as never)).toThrowError();
    expect(() => meanExcessPlot(returns, { startQuantile: 0 })).toThrowError();
    expect(() => meanExcessPlot(returns, { startQuantile: 1 })).toThrowError();
    expect(() => meanExcessPlot(returns, { gridSize: 1 })).toThrowError();
    expect(() => meanExcessPlot(returns, { minExceedances: 0 })).toThrowError();
    expect(() => meanExcessPlot(returns, { linearTolerance: 0 })).toThrowError();
    expect(() => meanExcessPlot(returns, { thresholds: [Number.NaN] })).toThrowError();
    // Too few observations for the grid to separate.
    expect(() => meanExcessPlot(gpdReturns(0.3, 1, 15, 2))).toThrowError();
  });
});
