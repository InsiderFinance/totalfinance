/**
 * The covariance-estimation front door (`estimateCovariance`). Pins each method against the piece it
 * composes (`sample` = `covarianceMatrix`, `ledoit-wolf` = `ledoitWolfShrinkage`, `ridge` = sample + λI),
 * the `auto` selection (sample when well-conditioned, Ledoit–Wolf when the sample is singular), the
 * conditioning diagnostics against a direct `jacobiEigen`, the singular-sample and ill-conditioned
 * disclosures, and the guards.
 */

import { describe, expect, it } from 'vitest';
import {
  cholesky,
  covarianceMatrix,
  estimateCovariance,
  jacobiEigen,
  ledoitWolfShrinkage,
} from '@totalfinance/math';

/** Deterministic mulberry32 → standard normal. */
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
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * r());
}
/** `p` correlated variables (common factor) × `T` observations → `series[k]`. */
function correlated(p: number, T: number, seed: number): number[][] {
  const r = randomNumberGenerator(seed);
  const s: number[][] = Array.from({ length: p }, () => new Array<number>(T));
  for (let t = 0; t < T; t++) {
    const f = gauss(r);
    for (let k = 0; k < p; k++) s[k]![t] = 0.8 * f + 0.4 * gauss(r);
  }
  return s;
}

const WELL = correlated(4, 500, 1); // T ≫ p — well-conditioned
const SINGULAR = correlated(6, 4, 2); // T < p — singular sample

describe('estimateCovariance', () => {
  it("method 'sample' equals covarianceMatrix and discloses when it is singular", () => {
    const res = estimateCovariance(WELL, { method: 'sample' });
    expect(res.covariance).toEqual(covarianceMatrix(WELL, { population: true }));
    expect(res.method).toBe('sample');
    expect(res.observations).toBe(500);
    expect(res.variables).toBe(4);

    const sing = estimateCovariance(SINGULAR, { method: 'sample' });
    expect(sing.isPositiveDefinite).toBe(false);
    expect(sing.conditionNumber).toBe(Infinity);
    expect(sing.effectiveRank).toBeLessThan(6);
    expect(() => cholesky(sing.covariance)).toThrowError(); // genuinely not invertible
    expect(sing.diagnostics.warnings.some((w) => w.code === 'math.covariance_singular')).toBe(true);
  });

  it("method 'ledoit-wolf' equals ledoitWolfShrinkage and is SPD even when T < p", () => {
    const res = estimateCovariance(SINGULAR, { method: 'ledoit-wolf' });
    const lw = ledoitWolfShrinkage(SINGULAR);
    expect(res.covariance).toEqual(lw.covariance);
    expect(res.shrinkage).toBeCloseTo(lw.shrinkage, 15);
    expect(res.isPositiveDefinite).toBe(true);
    expect(() => cholesky(res.covariance)).not.toThrowError();
  });

  it('passes ledoitWolfTarget through to ledoitWolfShrinkage (constant-correlation), differing from the identity default', () => {
    const cc = estimateCovariance(SINGULAR, {
      method: 'ledoit-wolf',
      ledoitWolfTarget: 'constant-correlation',
    });
    expect(cc.covariance).toEqual(
      ledoitWolfShrinkage(SINGULAR, { target: 'constant-correlation' }).covariance,
    );
    expect(cc.isPositiveDefinite).toBe(true);
    // A genuinely different target than the identity default.
    const id = estimateCovariance(SINGULAR, { method: 'ledoit-wolf' });
    expect(cc.covariance).not.toEqual(id.covariance);
    // 'auto' also honors ledoitWolfTarget when it decides to shrink a singular sample.
    const auto = estimateCovariance(SINGULAR, { ledoitWolfTarget: 'constant-correlation' });
    expect(auto.method).toBe('ledoit-wolf');
    expect(auto.covariance).toEqual(
      ledoitWolfShrinkage(SINGULAR, { target: 'constant-correlation' }).covariance,
    );
  });

  it('passes ledoitWolfTarget: single-index through to ledoitWolfShrinkage', () => {
    const si = estimateCovariance(SINGULAR, {
      method: 'ledoit-wolf',
      ledoitWolfTarget: 'single-index',
    });
    expect(si.covariance).toEqual(
      ledoitWolfShrinkage(SINGULAR, { target: 'single-index' }).covariance,
    );
    expect(si.isPositiveDefinite).toBe(true);
    // 'auto' honors it when it decides to shrink the singular sample.
    const auto = estimateCovariance(SINGULAR, { ledoitWolfTarget: 'single-index' });
    expect(auto.method).toBe('ledoit-wolf');
    expect(auto.covariance).toEqual(
      ledoitWolfShrinkage(SINGULAR, { target: 'single-index' }).covariance,
    );
  });

  it("method 'ridge' adds λ·I (λ = ridge·avg variance) and is SPD", () => {
    const ridge = 0.1;
    const res = estimateCovariance(SINGULAR, { method: 'ridge', ridge });
    const S = covarianceMatrix(SINGULAR, { population: true });
    let averageVar = 0;
    for (let i = 0; i < 6; i++) averageVar += S[i]![i]!;
    averageVar /= 6;
    const lambda = ridge * averageVar;
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        expect(res.covariance[i]![j]).toBeCloseTo(S[i]![j]! + (i === j ? lambda : 0), 12);
      }
    }
    expect(res.isPositiveDefinite).toBe(true);
    expect(() => cholesky(res.covariance)).not.toThrowError();
    // ridge defaults to 0.1 when omitted.
    const dflt = estimateCovariance(SINGULAR, { method: 'ridge' });
    expect(dflt.covariance).toEqual(res.covariance);
  });

  it("method 'auto' uses the sample when well-conditioned and Ledoit–Wolf when the sample is singular or ill-conditioned", () => {
    const well = estimateCovariance(WELL); // default 'auto'
    expect(well.method).toBe('sample');
    expect(well.isPositiveDefinite).toBe(true);

    const sing = estimateCovariance(SINGULAR);
    expect(sing.method).toBe('ledoit-wolf'); // refuses to return a singular matrix
    expect(sing.isPositiveDefinite).toBe(true);
    expect(sing.shrinkage).toBeGreaterThan(0);

    // SPD but ill-conditioned (a tight threshold) ⇒ auto still shrinks rather than trust it.
    const illCond = estimateCovariance(WELL, { conditionThreshold: 5 });
    expect(illCond.method).toBe('ledoit-wolf');

    for (const r of [well, sing, illCond]) {
      expect(r.diagnostics.warnings.some((w) => w.code === 'math.covariance_method_auto')).toBe(
        true,
      );
    }
  });

  it('reports conditioning that matches a direct eigen-decomposition, and flags an ill-conditioned result', () => {
    const res = estimateCovariance(WELL, { method: 'sample' });
    const { values } = jacobiEigen(res.covariance);
    const min = Math.min(...values);
    const max = Math.max(...values);
    expect(res.minEigenvalue).toBeCloseTo(min, 12);
    expect(res.maxEigenvalue).toBeCloseTo(max, 12);
    expect(res.conditionNumber).toBeCloseTo(max / min, 8);
    expect(res.effectiveRank).toBe(values.filter((v) => v > 1e-9 * max).length);

    // A tight conditionThreshold turns the (SPD but cond≈18) sample into an ill-conditioned flag.
    const flagged = estimateCovariance(WELL, { method: 'sample', conditionThreshold: 5 });
    expect(flagged.conditionNumber).toBeGreaterThan(5);
    expect(
      flagged.diagnostics.warnings.some((w) => w.code === 'math.covariance_ill_conditioned'),
    ).toBe(true);
  });

  it('honors the population flag (sample vs unbiased normalization)', () => {
    const pop = estimateCovariance(WELL, { method: 'sample', population: true });
    const unb = estimateCovariance(WELL, { method: 'sample', population: false });
    expect(pop.covariance).toEqual(covarianceMatrix(WELL, { population: true }));
    expect(unb.covariance).toEqual(covarianceMatrix(WELL, { population: false }));
    // 1/(T−1) is larger than 1/T ⇒ unbiased variances exceed population ones.
    expect(unb.covariance[0]![0]).toBeGreaterThan(pop.covariance[0]![0]!);
  });

  it('guards a non-array, empty, too-short, ragged, or non-finite series, and a non-positive ridge', () => {
    expect(() => estimateCovariance(undefined as never)).toThrowError();
    expect(() => estimateCovariance([])).toThrowError();
    expect(() => estimateCovariance([[1], [2]])).toThrowError(); // T < 2
    expect(() =>
      estimateCovariance([
        [1, 2, 3],
        [1, 2],
      ]),
    ).toThrowError(); // ragged
    expect(() =>
      estimateCovariance([
        [1, 2, Number.NaN],
        [1, 2, 3],
      ]),
    ).toThrowError(); // non-finite
    expect(() => estimateCovariance(WELL, { method: 'ridge', ridge: 0 })).toThrowError();
    expect(() => estimateCovariance(WELL, { method: 'ridge', ridge: -0.1 })).toThrowError();
  });
});

/** 2 variables × T; variable 0 shifts from low to high vol at the midpoint (a regime change). */
function regimeSeries(T = 300, seed = 42): number[][] {
  const r = randomNumberGenerator(seed);
  const v0 = new Array<number>(T);
  const v1 = new Array<number>(T);
  for (let t = 0; t < T; t++) {
    const vol = t < T / 2 ? 0.01 : 0.05; // recent half is high-vol
    v0[t] = vol * gauss(r);
    v1[t] = 0.02 * gauss(r);
  }
  return [v0, v1];
}

describe('estimateCovariance — ewma (RiskMetrics)', () => {
  it('reduces to the equal-weighted sample covariance as λ → 1', () => {
    const near1 = estimateCovariance(WELL, { method: 'ewma', lambda: 1 - 1e-8 });
    const samp = estimateCovariance(WELL, { method: 'sample' });
    expect(near1.method).toBe('ewma');
    expect(near1.lambda).toBeCloseTo(1 - 1e-8, 12);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++)
        expect(near1.covariance[i]![j]).toBeCloseTo(samp.covariance[i]![j]!, 5);
  });

  it('tracks a volatility regime: recent high-vol history lifts the EWMA variance above the sample', () => {
    const series = regimeSeries();
    const ew = estimateCovariance(series, { method: 'ewma', lambda: 0.94 });
    const samp = estimateCovariance(series, { method: 'sample' });
    // Variable 0's recent half is 5× the vol; the recency-weighted EWMA reflects it, the sample averages.
    expect(ew.covariance[0]![0]!).toBeGreaterThan(samp.covariance[0]![0]! * 1.5);
    expect(ew.isPositiveDefinite).toBe(true);
    expect(ew.covariance[0]![1]).toBeCloseTo(ew.covariance[1]![0]!, 15); // symmetric
  });

  it('reports the Kish effective sample size 1/Σwₜ² ≈ (1+λ)/(1−λ)', () => {
    const ew = estimateCovariance(WELL, { method: 'ewma', lambda: 0.94 });
    expect(ew.lambda).toBe(0.94);
    expect(ew.effectiveObservations).toBeCloseTo((1 + 0.94) / (1 - 0.94), 1); // ≈ 32.33 (T = 500 ≫ 1/(1−λ))
  });

  it('accepts a half-life parameterization (λ = 2^(−1/halfLife))', () => {
    const ew = estimateCovariance(WELL, { method: 'ewma', halfLife: 20 });
    expect(ew.lambda).toBeCloseTo(Math.pow(2, -1 / 20), 12);
  });

  it('applies the unbiased weighted-covariance correction under population: false', () => {
    const biased = estimateCovariance(WELL, { method: 'ewma', lambda: 0.94, population: true });
    const unbiased = estimateCovariance(WELL, { method: 'ewma', lambda: 0.94, population: false });
    // unbiased = biased / (1 − Σwₜ²) = biased · T_eff/(T_eff − 1).
    const factor = 1 / (1 - 1 / biased.effectiveObservations!);
    expect(unbiased.covariance[0]![0]!).toBeCloseTo(biased.covariance[0]![0]! * factor, 12);
  });

  it('warns when the effective sample is below the number of variables', () => {
    const big = correlated(6, 500, 9); // full-rank (T ≫ p) but a fast decay shrinks the effective sample
    const ew = estimateCovariance(big, { method: 'ewma', lambda: 0.5 }); // T_eff ≈ 3 < 6
    expect(ew.effectiveObservations!).toBeLessThan(6);
    expect(
      ew.diagnostics.warnings.some((w) => w.code === 'math.covariance_ewma_effective_sample'),
    ).toBe(true);
  });

  it('flags a rank-deficient EWMA (T < p) as singular, like the sample', () => {
    const ew = estimateCovariance(SINGULAR, { method: 'ewma' });
    expect(ew.isPositiveDefinite).toBe(false);
  });

  it('guards a bad λ and half-life', () => {
    expect(() => estimateCovariance(WELL, { method: 'ewma', lambda: 0 })).toThrowError();
    expect(() => estimateCovariance(WELL, { method: 'ewma', lambda: 1 })).toThrowError();
    expect(() => estimateCovariance(WELL, { method: 'ewma', lambda: 1.2 })).toThrowError();
    expect(() => estimateCovariance(WELL, { method: 'ewma', halfLife: 0 })).toThrowError();
    expect(() => estimateCovariance(WELL, { method: 'ewma', halfLife: -5 })).toThrowError();
  });
});

describe('SPD postcondition (alignment specification P2.2) — the two review counterexamples', () => {
  it('degenerate constant series: auto/ledoit-wolf is FLOORED to SPD with a disclosure, never isPositiveDefinite: false', () => {
    // Constant series → zero sample covariance → the original code returned a zero matrix with
    // conditionNumber Infinity and isPositiveDefinite: false while the docs promised SPD.
    const constant = [
      [0.01, 0.01, 0.01, 0.01, 0.01],
      [0.02, 0.02, 0.02, 0.02, 0.02],
    ];
    const r = estimateCovariance(constant, { method: 'auto' });
    expect(r.method).toBe('ledoit-wolf');
    expect(r.isPositiveDefinite).toBe(true);
    expect(Number.isFinite(r.conditionNumber)).toBe(true);
    expect(r.diagnostics.converged).toBe(true);
    expect(r.diagnostics.warnings.some((w) => w.code === 'math.covariance_floored')).toBe(true);
  });

  it('perfectly collinear series: the single-index target is floored to SPD with a disclosure', () => {
    // x2 = 2·x1 exactly — the shrunk single-index target equals the singular sample (δ = 0) and
    // Cholesky failed with an empty warning list before the fix.
    const x1 = [0.01, -0.02, 0.015, -0.005, 0.02, -0.01, 0.005, 0.01];
    const collinear = [x1, x1.map((v) => 2 * v)];
    const r = estimateCovariance(collinear, {
      method: 'ledoit-wolf',
      ledoitWolfTarget: 'single-index',
    });
    expect(r.isPositiveDefinite).toBe(true);
    expect(r.diagnostics.converged).toBe(true);
    expect(r.diagnostics.warnings.some((w) => w.code === 'math.covariance_floored')).toBe(true);
    // The equal-weight market proxy is DISCLOSED, not silent.
    expect(r.assumptions.marketProxy).toBe('equal-weight');
  });

  it('an observed market series is accepted for the single-index target and disclosed as such', () => {
    const series = [
      [0.011, -0.018, 0.014, -0.004, 0.021, -0.012, 0.004, 0.012],
      [0.008, -0.011, 0.009, -0.006, 0.013, -0.009, 0.006, 0.007],
      [-0.002, 0.004, -0.001, 0.003, -0.005, 0.002, 0.001, -0.003],
    ];
    const market = [0.01, -0.012, 0.011, -0.003, 0.015, -0.008, 0.004, 0.006];
    const r = estimateCovariance(series, {
      method: 'ledoit-wolf',
      ledoitWolfTarget: 'single-index',
      market,
    });
    expect(r.assumptions.marketProxy).toBe('observed-series');
    expect(r.isPositiveDefinite).toBe(true);
    // A wrong-length market series teaches instead of misestimating.
    expect(() =>
      estimateCovariance(series, {
        method: 'ledoit-wolf',
        ledoitWolfTarget: 'single-index',
        market: [0.01],
      }),
    ).toThrow(/market series length 1 must equal the observation count T = 8/);
  });

  it('the raw estimators are never altered: sample and ewma stay honestly singular', () => {
    const shortHistory = [
      [0.01, -0.02],
      [0.02, 0.01],
      [0.005, 0.007],
    ]; // T = 2 < p = 3 → rank-deficient
    for (const method of ['sample', 'ewma'] as const) {
      const r = estimateCovariance(shortHistory, { method });
      expect(r.isPositiveDefinite).toBe(false);
      expect(r.diagnostics.converged).toBe(false);
      expect(r.diagnostics.warnings.some((w) => w.code === 'math.covariance_singular')).toBe(true);
      expect(r.diagnostics.warnings.some((w) => w.code === 'math.covariance_floored')).toBe(false);
    }
  });
});
