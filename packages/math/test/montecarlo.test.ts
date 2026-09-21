import { describe, expect, it } from 'vitest';
import {
  antitheticSampler,
  brownianBridge,
  controlVariateEstimate,
  correlatedNormalSampler,
  correlation,
  haltonPoint,
  haltonSequence,
  mean,
  monteCarlo,
  mulberry32,
  normalSample,
  restoreRandomNumberGenerator,
  sobolSequence,
  variance,
  xoshiro128ss,
} from '@totalfinance/math';

describe('PRNG state serialization', () => {
  it('xoshiro128ss is deterministic and resumes from a snapshot', () => {
    const a = xoshiro128ss(42);
    const b = xoshiro128ss(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(
      Array.from({ length: 5 }, () => b.next()),
    );

    const r = xoshiro128ss(7);
    for (let i = 0; i < 10; i++) r.next();
    const restored = restoreRandomNumberGenerator(JSON.parse(JSON.stringify(r.getState())));
    expect(Array.from({ length: 5 }, () => restored.next())).toEqual(
      Array.from({ length: 5 }, () => r.next()),
    );
  });

  it('mulberry32 restores from a snapshot', () => {
    const r = mulberry32(99);
    for (let i = 0; i < 8; i++) r.next();
    const restored = restoreRandomNumberGenerator(r.getState());
    expect(restored.next()).toBe(r.next());
  });
});

describe('low-discrepancy sequences', () => {
  it('Halton points use radical inverses', () => {
    expect(haltonPoint(1, 2)).toEqual([0.5, expect.closeTo(1 / 3, 12)]);
  });

  it('Sobol first 2^m points form the dyadic grid (1-D)', () => {
    const pts = sobolSequence(8, 1).map((p) => p[0]!);
    expect(pts.slice().sort((a, b) => a - b)).toEqual([
      0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875,
    ]);
  });

  it('Sobol points stay in [0,1)', () => {
    for (const p of sobolSequence(64, 3)) {
      for (const v of p) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('Sobol/Halton return exactly n points (n=0 yields an empty sequence, no stray origin)', () => {
    expect(sobolSequence(0, 2)).toEqual([]);
    expect(sobolSequence(1, 2)).toEqual([[0, 0]]);
    expect(sobolSequence(5, 3)).toHaveLength(5);
    expect(haltonSequence(0, 2)).toEqual([]);
    expect(haltonSequence(4, 2)).toHaveLength(4);
  });

  it('Sobol/Halton reject invalid sizes and dimensions', () => {
    expect(() => sobolSequence(-1, 2)).toThrow();
    expect(() => sobolSequence(8, 0)).toThrow();
    expect(() => haltonSequence(-1, 2)).toThrow();
    expect(() => haltonSequence(8, 0)).toThrow();
  });

  it('haltonPoint rejects a negative index or non-positive dimensions (no silent [0,0])', () => {
    expect(() => haltonPoint(-1, 2)).toThrow();
    expect(() => haltonPoint(1, 0)).toThrow();
    expect(haltonPoint(0, 2)).toEqual([0, 0]); // index 0 is the valid origin
  });

  it('low-discrepancy errors are typed TotalFinance InputErrors with stable codes', () => {
    expect(() => sobolSequence(-1, 2)).toThrow(
      expect.objectContaining({ code: 'input.out_of_range' }),
    );
    expect(() => haltonPoint(1, 0)).toThrow(
      expect.objectContaining({ code: 'input.out_of_range' }),
    );
  });
});

describe('Monte Carlo runner', () => {
  it('estimates E[U] = 0.5 and echoes the seed (deterministic)', () => {
    const a = monteCarlo((randomNumberGenerator) => randomNumberGenerator.next(), {
      seed: 1,
      paths: 5000,
    });
    const b = monteCarlo((randomNumberGenerator) => randomNumberGenerator.next(), {
      seed: 1,
      paths: 5000,
    });
    expect(a.value).toBe(b.value);
    expect(a.seed).toBe(1);
    expect(a.value).toBeCloseTo(0.5, 1);
    expect(a.standardError).toBeGreaterThan(0);
  });

  it('throws on an invalid budget instead of returning a NaN result', () => {
    expect(() =>
      monteCarlo((randomNumberGenerator) => randomNumberGenerator.next(), { seed: 1, paths: 0 }),
    ).toThrow();
    expect(() =>
      monteCarlo((randomNumberGenerator) => randomNumberGenerator.next(), { seed: 1, paths: 1 }),
    ).toThrow();
    expect(() =>
      monteCarlo((randomNumberGenerator) => randomNumberGenerator.next(), {
        seed: NaN,
        paths: 100,
      }),
    ).toThrow();
    expect(() =>
      monteCarlo((randomNumberGenerator) => randomNumberGenerator.next(), {
        seed: 1,
        paths: 100,
        confidence: 1,
      }),
    ).toThrow();
    expect(() =>
      monteCarlo((randomNumberGenerator) => randomNumberGenerator.next(), {
        seed: 1,
        paths: 100,
        targetStandardError: 0,
      }),
    ).toThrow();
  });

  it('throws when the sampler returns a non-finite value (no NaN/∞ with converged:true)', () => {
    expect(() => monteCarlo(() => NaN, { seed: 1, paths: 100 })).toThrow();
    expect(() => monteCarlo(() => Infinity, { seed: 1, paths: 100 })).toThrow();
    // A sampler that goes bad partway through is still caught.
    let i = 0;
    expect(() => monteCarlo(() => (++i < 50 ? 1 : NaN), { seed: 1, paths: 100 })).toThrow();
  });

  it('estimates π', () => {
    const r = monteCarlo(
      (randomNumberGenerator) => {
        const x = randomNumberGenerator.next();
        const y = randomNumberGenerator.next();
        return x * x + y * y < 1 ? 4 : 0;
      },
      { seed: 12345, paths: 50000 },
    );
    expect(r.value).toBeCloseTo(Math.PI, 1);
  });

  it('stops early when the target standard error is reached', () => {
    const r = monteCarlo((randomNumberGenerator) => randomNumberGenerator.next(), {
      seed: 3,
      paths: 1_000_000,
      targetStandardError: 0.01,
      minPaths: 500,
    });
    expect(r.converged).toBe(true);
    expect(r.paths).toBeLessThan(1_000_000);
    expect(r.standardError).toBeLessThanOrEqual(0.01 + 1e-6);
  });
});

describe('variance reduction', () => {
  const trueValue = Math.exp(0.5); // E[e^Z], Z ~ N(0,1)

  it('antithetic variates reduce the standard error on E[e^Z]', () => {
    const plain = monteCarlo(
      (randomNumberGenerator) => Math.exp(normalSample(randomNumberGenerator)),
      { seed: 5, paths: 4000 },
    );
    const anti = monteCarlo(
      antitheticSampler((z) => Math.exp(z[0]!), 1),
      { seed: 5, paths: 4000 },
    );
    expect(plain.value).toBeCloseTo(trueValue, 1);
    expect(anti.value).toBeCloseTo(trueValue, 1);
    expect(anti.standardError).toBeLessThan(plain.standardError);
  });

  it('antitheticSampler rejects an invalid dimensions (no raw RangeError)', () => {
    expect(() => antitheticSampler((z) => z[0]!, NaN)).toThrow();
    expect(() => antitheticSampler((z) => z[0]!, 0)).toThrow();
  });

  it('control variate (X = Z, E[X] = 0) recovers the value', () => {
    const randomNumberGenerator = mulberry32(11);
    const ys: number[] = [];
    const xs: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const z = normalSample(randomNumberGenerator);
      ys.push(Math.exp(z));
      xs.push(z);
    }
    const cv = controlVariateEstimate(ys, xs, 0);
    expect(cv).toBeCloseTo(trueValue, 1);
    // CV variance is lower than the plain estimator's variance
    expect(variance(ys.map((y, i) => y - covarianceRatio(ys, xs) * (xs[i]! - 0)))).toBeLessThan(
      variance(ys),
    );
  });
});

function covarianceRatio(ys: number[], xs: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let covariance = 0;
  let vx = 0;
  for (let i = 0; i < xs.length; i++) {
    covariance += (xs[i]! - mx) * (ys[i]! - my);
    vx += (xs[i]! - mx) ** 2;
  }
  return covariance / vx;
}

describe('Brownian bridge', () => {
  it('produces a valid Brownian path with the right marginal variances', () => {
    const n = 4;
    const timeStepYears = 0.25; // T = 1
    const ends: number[] = [];
    const mids: number[] = [];
    const randomNumberGenerator = mulberry32(2024);
    for (let p = 0; p < 20000; p++) {
      const normals = Array.from({ length: n }, () => normalSample(randomNumberGenerator));
      const W = brownianBridge(normals, timeStepYears);
      expect(W[0]).toBe(0);
      ends.push(W[n]!);
      mids.push(W[2]!); // t = 0.5
    }
    expect(variance(ends)).toBeCloseTo(1, 1); // Var(W_T) = T = 1
    expect(variance(mids)).toBeCloseTo(0.5, 1); // Var(W_0.5) = 0.5
  });

  it('throws on a non-positive timeStepYears instead of producing NaNs', () => {
    expect(() => brownianBridge([0.1, -0.2], -1)).toThrow();
    expect(() => brownianBridge([0.1, -0.2], 0)).toThrow();
  });
});

describe('correlated normals', () => {
  it('reproduce the target correlation', () => {
    const sampler = correlatedNormalSampler([
      [1, 0.7],
      [0.7, 1],
    ]);
    const randomNumberGenerator = mulberry32(2025);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 30000; i++) {
      const [a, b] = sampler(randomNumberGenerator);
      xs.push(a!);
      ys.push(b!);
    }
    expect(correlation(xs, ys)).toBeCloseTo(0.7, 1);
  });
});
