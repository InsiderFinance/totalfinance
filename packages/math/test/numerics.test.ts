import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  adaptiveSimpson,
  adaptiveSimpsonSafe,
  bilinearInterp,
  cholesky,
  choleskySolve,
  covarianceMatrix,
  gaussLegendre,
  jacobiEigen,
  makeLinearInterpolator,
  makeNaturalCubicSpline,
  makePchipInterpolator,
  nearestCorrelation,
  nearestPsd,
  validateInterpolationData,
} from '@totalfinance/math';

describe('interpolation axis validation', () => {
  it('rejects unsorted axes', () => {
    expect(() => makeLinearInterpolator([0, 2, 1], [0, 1, 2])).toThrowError(/strictly increasing/);
  });
  it('rejects duplicate x without an aggregate policy', () => {
    expect(() => validateInterpolationData([0, 1, 1, 2], [0, 1, 2, 3])).toThrowError(/duplicate/);
  });
  it('aggregates duplicates with mean', () => {
    const r = validateInterpolationData([0, 1, 1, 2], [0, 1, 3, 4], { aggregate: 'mean' });
    expect(r.xs).toEqual([0, 1, 2]);
    expect(r.ys).toEqual([0, 2, 4]);
  });
  it('assumeSorted skips validation (fast path)', () => {
    expect(() =>
      makeLinearInterpolator([0, 2, 1], [0, 1, 2], { assumeSorted: true }),
    ).not.toThrow();
  });
});

describe('PCHIP monotone interpolation', () => {
  const xs = [0, 1, 2, 3, 4];
  const ys = [0, 1, 1, 2, 10];
  const f = makePchipInterpolator(xs, ys);

  it('hits the nodes exactly', () => {
    for (let i = 0; i < xs.length; i++) expect(f(xs[i]!)).toBeCloseTo(ys[i]!, 12);
  });

  it('property: preserves monotonicity (no overshoot) on increasing data', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0.01, max: 5, noNaN: true }), { minLength: 4, maxLength: 12 }),
        (incrs) => {
          const X = incrs.map((_, i) => i);
          let acc = 0;
          const Y = incrs.map((d) => (acc += d));
          const g = makePchipInterpolator(X, Y);
          let prev = g(0);
          for (let t = 0; t <= X.length - 1; t += 0.13) {
            const v = g(t);
            expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = v;
          }
        },
      ),
    );
  });
});

describe('natural cubic spline', () => {
  it('hits nodes and approximates a smooth function', () => {
    const xs = Array.from({ length: 9 }, (_, i) => (i * Math.PI) / 4);
    const ys = xs.map((x) => Math.sin(x));
    const spline = makeNaturalCubicSpline(xs, ys);
    for (let i = 0; i < xs.length; i++) expect(spline(xs[i]!)).toBeCloseTo(ys[i]!, 12);
    // midpoint accuracy
    expect(spline(Math.PI / 8)).toBeCloseTo(Math.sin(Math.PI / 8), 2);
  });
});

describe('bilinear surface interpolation', () => {
  it('is exact for a bilinear function', () => {
    const xs = [0, 1, 2];
    const ys = [0, 1, 2];
    const fn = (x: number, y: number) => 1 + 2 * x + 3 * y + 4 * x * y;
    const z = xs.map((x) => ys.map((y) => fn(x, y)));
    expect(bilinearInterp(xs, ys, z, 0.5, 0.5)).toBeCloseTo(fn(0.5, 0.5), 12);
    expect(bilinearInterp(xs, ys, z, 1.5, 0.25)).toBeCloseTo(fn(1.5, 0.25), 12);
  });
});

describe('Cholesky', () => {
  const A = [
    [4, 2, 2],
    [2, 5, 1],
    [2, 1, 3],
  ];
  it('factorizes A = L Lᵀ', () => {
    const L = cholesky(A);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += L[i]![k]! * L[j]![k]!;
        expect(s).toBeCloseTo(A[i]![j]!, 10);
      }
    }
  });
  it('solves A x = b', () => {
    const L = cholesky(A);
    const b = [1, 2, 3];
    const x = choleskySolve(L, b);
    for (let i = 0; i < 3; i++) {
      let s = 0;
      for (let j = 0; j < 3; j++) s += A[i]![j]! * x[j]!;
      expect(s).toBeCloseTo(b[i]!, 9);
    }
  });
  it('throws on a non-PD matrix', () => {
    expect(() =>
      cholesky([
        [1, 2],
        [2, 1],
      ]),
    ).toThrowError(/not positive definite/);
  });
});

describe('Jacobi eigensolver', () => {
  it('recovers eigenvalues of a symmetric matrix', () => {
    const { values } = jacobiEigen([
      [2, 1],
      [1, 2],
    ]);
    expect(values.slice().sort((a, b) => a - b)).toEqual([
      expect.closeTo(1, 9),
      expect.closeTo(3, 9),
    ]);
  });
  it('A v = λ v for each eigenpair', () => {
    const A = [
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2],
    ];
    const { values, vectors } = jacobiEigen(A);
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < 3; i++) {
        let av = 0;
        for (let j = 0; j < 3; j++) av += A[i]![j]! * vectors[j]![k]!;
        expect(av).toBeCloseTo(values[k]! * vectors[i]![k]!, 8);
      }
    }
  });
});

describe('nearest PSD / correlation repair', () => {
  it('nearestPsd clips negative eigenvalues', () => {
    const indefinite = [
      [2, -1],
      [-1, -1],
    ];
    const psd = nearestPsd(indefinite);
    const { values } = jacobiEigen(psd);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(-1e-8);
  });
  it('nearestCorrelation returns unit diagonal and PSD', () => {
    const indefinite = [
      [1, 0.95, 0.95],
      [0.95, 1, -0.95],
      [0.95, -0.95, 1],
    ];
    const corr = nearestCorrelation(indefinite);
    for (let i = 0; i < 3; i++) expect(corr[i]![i]!).toBeCloseTo(1, 12);
    const { values } = jacobiEigen(corr);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(-1e-8);
  });
});

describe('covariance matrix', () => {
  it('is symmetric with variances on the diagonal', () => {
    const M = covarianceMatrix([
      [1, 2, 3, 4],
      [2, 4, 6, 8],
    ]);
    expect(M[0]![1]).toBeCloseTo(M[1]![0]!, 12);
    expect(M[0]![0]).toBeGreaterThan(0);
  });
});

describe('integration', () => {
  it('adaptive Simpson', () => {
    expect(adaptiveSimpson((x) => Math.sin(x), 0, Math.PI)).toBeCloseTo(2, 9);
    expect(adaptiveSimpson((x) => x * x, 0, 1)).toBeCloseTo(1 / 3, 10);
    expect(adaptiveSimpson((x) => Math.exp(x), 0, 1)).toBeCloseTo(Math.E - 1, 10);
  });
  it('Gauss–Legendre is exact for low-degree polynomials and accurate for smooth functions', () => {
    expect(gaussLegendre((x) => x * x, 0, 1, 2)).toBeCloseTo(1 / 3, 12);
    expect(gaussLegendre((x) => Math.sin(x), 0, Math.PI, 16)).toBeCloseTo(2, 12);
  });

  /**
   * A NON-FINITE BOUND USED TO HANG — found by the 3B.0 contract harness, then reproduced by hand.
   *
   * `adaptiveSimpsonSafe(f, NaN, 1)` never returned, while `[1, 1]` and `[0, 1]` both answered in
   * under a millisecond. A NaN bound makes the error estimate NaN, and every comparison with NaN is
   * false — so `Math.abs(err) <= 15 * tolerance` can never be taken and the only remaining exit is
   * depth exhaustion. The recursion is binary, so reaching depth 50 that way costs 2^50 evaluations.
   * A caller who let a NaN reach a bound got a hung process rather than an error.
   *
   * These assertions are about TERMINATION as much as about the error: an unguarded regression here
   * does not fail, it hangs, so the timeout is the assertion of record.
   */
  it('refuses a non-finite bound instead of subdividing forever', () => {
    expect(() => adaptiveSimpson((x) => x, Number.NaN, 1)).toThrow(/lowerBound must be a finite/);
    expect(() => adaptiveSimpson((x) => x, 0, Number.NaN)).toThrow(/upperBound must be a finite/);
    expect(() => adaptiveSimpson((x) => x, 0, Number.POSITIVE_INFINITY)).toThrow(
      /upperBound must be a finite/,
    );
    // And the guard did not cost the ordinary case.
    expect(adaptiveSimpson((x) => x, 0, 1)).toBeCloseTo(0.5, 12);
  }, 5_000);

  /**
   * `maxDepth` bounds the DEPTH of a binary subdivision, so it bounds work at 2^depth — the default
   * of 50 permits ~10^15 evaluations, which is a budget in name only. `maxEvaluations` is the bound
   * that corresponds to elapsed time, and exhausting it reports `converged: false` rather than
   * running until someone kills the process.
   */
  it('bounds work, not just depth, on an integrand that never meets tolerance', () => {
    // Wildly oscillating: adaptive quadrature reads this as roughness everywhere and keeps splitting.
    const pathological = (x: number): number => Math.sin(1e9 * x);
    const result = adaptiveSimpsonSafe(pathological, 0, 1, {
      tolerance: 1e-15,
      maxEvaluations: 5_000,
    });
    expect(result.converged).toBe(false);
    expect(Number.isFinite(result.value)).toBe(true);
  }, 5_000);
});
