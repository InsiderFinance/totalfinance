/**
 * Ledoit–Wolf covariance shrinkage (`ledoitWolfShrinkage`). Pins the `Σ* = δ·μI + (1−δ)·S` blend and its
 * symmetry, `δ ∈ [0, 1]`, the shrinkage of correlations toward the diagonal target and its decay as the
 * sample grows, the headline `T < p ⇒ invertible` benefit (`cholesky` accepts `Σ*` where `S` is
 * singular), the degenerate `p = 1` (`δ = 0`) case, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { cholesky, ledoitWolfShrinkage } from '@totalfinance/math';

/** Deterministic mulberry32 → standard normal (Box–Muller). */
function randomNumberGenerator(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  const u1 = Math.max(1e-12, r());
  const u2 = r();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
/** `p` correlated variables (common factor + idiosyncratic) × `T` observations → `series[k]`. */
function correlated(p: number, T: number, seed: number): number[][] {
  const r = randomNumberGenerator(seed);
  const series: number[][] = Array.from({ length: p }, () => new Array<number>(T));
  for (let t = 0; t < T; t++) {
    const f = gauss(r);
    for (let k = 0; k < p; k++) series[k]![t] = 0.8 * f + 0.4 * gauss(r);
  }
  return series;
}

describe('ledoitWolfShrinkage', () => {
  it('returns the exact δ·μI + (1−δ)·S blend, symmetric, with δ ∈ [0, 1]', () => {
    const res = ledoitWolfShrinkage(correlated(5, 30, 11));
    const {
      covariance: C,
      shrinkage: d,
      sampleCovariance: S,
      averageVariance: mu,
      observations,
    } = res;
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
    expect(observations).toBe(30);
    // μ = tr(S)/p.
    const traceS = S.reduce((s, row, i) => s + row[i]!, 0);
    expect(mu).toBeCloseTo(traceS / 5, 12);
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        expect(C[i]![j]).toBeCloseTo(d * (i === j ? mu : 0) + (1 - d) * S[i]![j]!, 14);
        expect(C[i]![j]).toBeCloseTo(C[j]![i]!, 15); // symmetric
      }
    }
  });

  it('shrinks off-diagonal correlations toward the target, and less so as the sample grows', () => {
    const small = ledoitWolfShrinkage(correlated(5, 15, 3));
    const large = ledoitWolfShrinkage(correlated(5, 800, 3));
    // Σ* off-diagonals are pulled toward the diagonal target (0), never past S.
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        if (i !== j)
          expect(Math.abs(small.covariance[i]![j]!)).toBeLessThanOrEqual(
            Math.abs(small.sampleCovariance[i]![j]!) + 1e-12,
          );
      }
    }
    // With far more data the shrinkage intensity is much smaller (Σ* → S).
    expect(large.shrinkage).toBeLessThan(small.shrinkage);
  });

  it('produces an invertible (SPD) covariance even when T < p, where the sample covariance is singular', () => {
    const res = ledoitWolfShrinkage(correlated(6, 4, 99)); // 4 observations, 6 variables
    expect(res.shrinkage).toBeGreaterThan(0);
    expect(() => cholesky(res.sampleCovariance)).toThrowError(); // S is singular
    expect(() => cholesky(res.covariance)).not.toThrowError(); // Σ* is SPD — the whole point
  });

  it('does not shrink a single variable (d² = 0 ⇒ δ = 0, Σ* = S)', () => {
    const res = ledoitWolfShrinkage([[0.01, -0.02, 0.015, 0.005, -0.01]]);
    expect(res.shrinkage).toBe(0);
    expect(res.covariance[0]![0]).toBeCloseTo(res.sampleCovariance[0]![0]!, 15);
  });

  it('guards a non-array, empty, too-short, ragged, or non-finite series', () => {
    expect(() => ledoitWolfShrinkage(undefined as never)).toThrowError();
    expect(() => ledoitWolfShrinkage([])).toThrowError();
    expect(() => ledoitWolfShrinkage([5 as never])).toThrowError(); // series[0] not an array
    expect(() => ledoitWolfShrinkage([[1], [2]])).toThrowError(); // T < 2
    expect(() =>
      ledoitWolfShrinkage([
        [1, 2, 3],
        [1, 2],
      ]),
    ).toThrowError(); // ragged
    expect(() =>
      ledoitWolfShrinkage([
        [1, 2, Number.NaN],
        [1, 2, 3],
      ]),
    ).toThrowError(); // non-finite
    expect(() => ledoitWolfShrinkage([[1, 2, 3], 6 as never])).toThrowError(); // row not an array
  });
});

// ── Cholesky-factored Gaussian sampling from a known Σ, for the constant-correlation MC tests ──
function factor(Sigma: number[][]): number[][] {
  return cholesky(Sigma); // lower-triangular L with L Lᵀ = Σ
}
function draw(L: number[][], T: number, r: () => number): number[][] {
  const p = L.length;
  const series: number[][] = Array.from({ length: p }, () => new Array<number>(T));
  for (let t = 0; t < T; t++) {
    const z = Array.from({ length: p }, () => gauss(r));
    for (let i = 0; i < p; i++) {
      let v = 0;
      for (let k = 0; k <= i; k++) v += L[i]![k]! * z[k]!;
      series[i]![t] = v;
    }
  }
  return series;
}
function frobenius(A: number[][], B: number[][]): number {
  let s = 0;
  for (let i = 0; i < A.length; i++)
    for (let j = 0; j < A.length; j++) s += (A[i]![j]! - B[i]![j]!) ** 2;
  return Math.sqrt(s);
}
/** Constant-correlation truth: variance vᵢ², every pair correlated `r`. */
function constCorr(p: number, r: number): number[][] {
  const v = Array.from({ length: p }, (_, i) => 0.1 + 0.02 * i);
  return Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? v[i]! * v[i]! : r * v[i]! * v[j]!)),
  );
}
/** 1-factor truth with HETEROGENEOUS loadings ⇒ correlations vary ⇒ CC target misspecified. */
function heteroFactor(p: number, T: number, seed: number): number[][] {
  const r = randomNumberGenerator(seed);
  const load = Array.from({ length: p }, (_, i) => 0.2 + 0.12 * i);
  const series: number[][] = Array.from({ length: p }, () => new Array<number>(T));
  for (let t = 0; t < T; t++) {
    const f = gauss(r);
    for (let k = 0; k < p; k++) series[k]![t] = load[k]! * f + 0.4 * gauss(r);
  }
  return series;
}

describe('ledoitWolfShrinkage — constant-correlation target', () => {
  it('defaults to the identity target (backward-compatible, byte-for-byte)', () => {
    const data = correlated(5, 30, 11);
    const def = ledoitWolfShrinkage(data);
    const id = ledoitWolfShrinkage(data, { target: 'identity' });
    expect(def.target).toBe('identity');
    expect(def.averageCorrelation).toBeUndefined();
    expect(def.shrinkage).toBe(id.shrinkage);
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 5; j++) expect(def.covariance[i]![j]).toBe(id.covariance[i]![j]);
  });

  it('blends δ·F + (1−δ)·S against a hand-computed constant-correlation target', () => {
    const p = 5;
    const res = ledoitWolfShrinkage(correlated(p, 40, 7), { target: 'constant-correlation' });
    const { covariance: C, sampleCovariance: S, shrinkage: d } = res;
    expect(res.target).toBe('constant-correlation');
    expect(d).toBeGreaterThanOrEqual(0);
    expect(d).toBeLessThanOrEqual(1);
    // r̄ = mean off-diagonal sample correlation.
    let rsum = 0;
    let cnt = 0;
    for (let i = 0; i < p; i++)
      for (let j = i + 1; j < p; j++) {
        rsum += S[i]![j]! / Math.sqrt(S[i]![i]! * S[j]![j]!);
        cnt++;
      }
    const rbar = rsum / cnt;
    expect(res.averageCorrelation).toBeCloseTo(rbar, 12);
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        const F = i === j ? S[i]![i]! : rbar * Math.sqrt(S[i]![i]! * S[j]![j]!);
        expect(C[i]![j]).toBeCloseTo(d * F + (1 - d) * S[i]![j]!, 14);
        expect(C[i]![j]).toBeCloseTo(C[j]![i]!, 15); // symmetric
      }
      // the CC target keeps each sample variance exactly, so the shrunk diagonal equals S's.
      expect(C[i]![i]).toBeCloseTo(S[i]![i]!, 14);
    }
  });

  it('is SPD (invertible) even when T < p, where the sample covariance is singular', () => {
    const res = ledoitWolfShrinkage(correlated(6, 4, 42), { target: 'constant-correlation' });
    expect(() => cholesky(res.sampleCovariance)).toThrowError();
    expect(() => cholesky(res.covariance)).not.toThrowError();
  });

  it('recovers the true average correlation and beats the sample covariance (Monte-Carlo)', () => {
    const p = 8;
    const trueR = 0.4;
    const L = factor(constCorr(p, trueR));
    const Sigma = constCorr(p, trueR);
    const r = randomNumberGenerator(2024);
    let sampleErr = 0;
    let ccErr = 0;
    let rbarSum = 0;
    const trials = 40;
    for (let m = 0; m < trials; m++) {
      const series = draw(L, 20, r);
      const cc = ledoitWolfShrinkage(series, { target: 'constant-correlation' });
      sampleErr += frobenius(cc.sampleCovariance, Sigma);
      ccErr += frobenius(cc.covariance, Sigma);
      rbarSum += cc.averageCorrelation!;
    }
    expect(ccErr / trials).toBeLessThan(sampleErr / trials); // closer to truth
    expect(rbarSum / trials).toBeCloseTo(trueR, 1); // r̄ ≈ true correlation
  });

  it('downweights a misspecified target as the sample grows (δ falls toward 0)', () => {
    const small = ledoitWolfShrinkage(heteroFactor(6, 20, 5), { target: 'constant-correlation' });
    const large = ledoitWolfShrinkage(heteroFactor(6, 2000, 5), { target: 'constant-correlation' });
    expect(large.shrinkage).toBeLessThan(small.shrinkage);
  });

  it('does not shrink a single variable (γ² = 0 ⇒ δ = 0, Σ* = S)', () => {
    const res = ledoitWolfShrinkage([[0.01, -0.02, 0.015, 0.005, -0.01]], {
      target: 'constant-correlation',
    });
    expect(res.shrinkage).toBe(0);
    expect(res.target).toBe('constant-correlation');
    expect(res.averageCorrelation).toBe(0);
    expect(res.covariance[0]![0]).toBeCloseTo(res.sampleCovariance[0]![0]!, 15);
  });

  it('rejects a zero-variance (constant) variable — the target would be undefined', () => {
    expect(() =>
      ledoitWolfShrinkage(
        [
          [1, 1, 1], // constant ⇒ zero variance
          [1, 2, 3],
        ],
        { target: 'constant-correlation' },
      ),
    ).toThrowError();
  });
});

describe('ledoitWolfShrinkage — single-index (market-model) target', () => {
  // A genuine one-factor truth with HETEROGENEOUS loadings (so the correlation structure is NOT
  // constant-correlation): rᵢ = βᵢ·f + εᵢ, Σ_true = ββᵀσ_f² + diag(ψ²).
  const P = 12;
  const SIGF = 0.15;
  const BETA = Array.from({ length: P }, (_, i) => 0.1 + i * 0.18);
  const PSI = Array.from({ length: P }, (_, i) => 0.08 + (i % 6) * 0.05);
  const trueCov: number[][] = Array.from({ length: P }, (_, i) =>
    Array.from(
      { length: P },
      (_, j) => BETA[i]! * BETA[j]! * SIGF * SIGF + (i === j ? PSI[i]! ** 2 : 0),
    ),
  );
  const oneFactor = (T: number, seed: number): number[][] => {
    const r = randomNumberGenerator(seed);
    const s: number[][] = Array.from({ length: P }, () => new Array<number>(T));
    for (let t = 0; t < T; t++) {
      const f = SIGF * gauss(r);
      for (let i = 0; i < P; i++) s[i]![t] = BETA[i]! * f + PSI[i]! * gauss(r);
    }
    return s;
  };
  const froErr = (M: number[][]): number => {
    let e = 0;
    for (let i = 0; i < P; i++) for (let j = 0; j < P; j++) e += (M[i]![j]! - trueCov[i]![j]!) ** 2;
    return Math.sqrt(e);
  };

  it('recovers the one-factor truth better than S, identity, and constant-correlation', () => {
    // Averaged over many draws (deterministic seeds) so the ordering is a stable statistical property.
    const T = 30;
    const N = 120;
    let eS = 0;
    let eId = 0;
    let eCC = 0;
    let eSI = 0;
    for (let n = 0; n < N; n++) {
      const s = oneFactor(T, 1000 + n);
      eS += froErr(ledoitWolfShrinkage(s).sampleCovariance);
      eId += froErr(ledoitWolfShrinkage(s, { target: 'identity' }).covariance);
      eCC += froErr(ledoitWolfShrinkage(s, { target: 'constant-correlation' }).covariance);
      eSI += froErr(ledoitWolfShrinkage(s, { target: 'single-index' }).covariance);
    }
    expect(eSI).toBeLessThan(eS); // beats the raw sample
    expect(eSI).toBeLessThan(eId); // beats the identity target
    expect(eSI).toBeLessThan(eCC); // beats the constant-correlation target (correctly specified)
  });

  it('is the exact δ·F + (1−δ)·S blend, SPD, echoes the target and market variance', () => {
    const res = ledoitWolfShrinkage(oneFactor(40, 7), { target: 'single-index' });
    expect(res.target).toBe('single-index');
    expect(res.shrinkage).toBeGreaterThanOrEqual(0);
    expect(res.shrinkage).toBeLessThanOrEqual(1);
    expect(res.marketVariance).toBeGreaterThan(0); // varmkt disclosed
    // Reconstruct F off-diagonal from covmkt/varmkt and check the blend.
    const C = res.covariance;
    for (let i = 0; i < P; i++) {
      for (let j = 0; j < P; j++) expect(C[i]![j]).toBeCloseTo(C[j]![i]!, 14); // symmetric
    }
    expect(() => cholesky(C)).not.toThrow(); // SPD even though the fit shrinks
    // The other targets do NOT carry a marketVariance.
    expect(ledoitWolfShrinkage(oneFactor(40, 7)).marketVariance).toBeUndefined();
    expect(
      ledoitWolfShrinkage(oneFactor(40, 7), { target: 'constant-correlation' }).marketVariance,
    ).toBeUndefined();
  });

  it('shrinks less as T grows (δ → 0 when the sample dominates)', () => {
    const dSmall = ledoitWolfShrinkage(oneFactor(20, 3), { target: 'single-index' }).shrinkage;
    const dLarge = ledoitWolfShrinkage(oneFactor(400, 3), { target: 'single-index' }).shrinkage;
    expect(dLarge).toBeLessThan(dSmall);
  });

  it('rejects a degenerate market (varmkt = 0)', () => {
    // Two exactly anti-correlated variables ⇒ the equal-weighted average is 0 every period.
    expect(() =>
      ledoitWolfShrinkage(
        [
          [1, -1, 2, -2, 1.5],
          [-1, 1, -2, 2, -1.5],
        ],
        { target: 'single-index' },
      ),
    ).toThrowError();
  });
});
