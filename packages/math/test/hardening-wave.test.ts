/**
 * The 2026-08 defect-fix wave for `@totalfinance/math` — one regression per reviewed, reproduced defect.
 *
 * Every test in this file FAILED before its fix — verified by reverting each change and re-running.
 *
 * Two of the defects were HANGS rather than wrong numbers, and they behave differently under test.
 * The NaN-knot spin allocates until the array allocator throws, so the explicit timeouts below turn a
 * regression into a red test. `differentialEvolution` with a population of three is a synchronous
 * rejection-sampling loop that never yields: vitest cannot interrupt it, and a regression there WILL
 * stall the run (measured — 45s with no progress and no way to time it out from inside the worker).
 * The timeout on that block is best-effort; the assertion is what actually pins the guard.
 *
 * References used here are INDEPENDENT of the code under test: the Wilson–Hilferty χ² quantile, an
 * uncapped power series written out in the test, the `χ²₁ = Z²` identity, and a Newton solve on the
 * library's own far-tail LOG-cdf (a different code path from the quantile being checked).
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  bfgs,
  chiSquare,
  differentialEvolution,
  gamma,
  gaussLegendre,
  gaussLegendreNodes,
  jacobiEigen,
  kalmanFilter,
  kalmanSmooth,
  levenbergMarquardt,
  lgamma,
  ljungBox,
  makeBicubicInterpolator,
  makeLinearInterpolator,
  makeNaturalCubicSpline,
  makePchipInterpolator,
  monteCarlo,
  mulberry32,
  normalCdf,
  normalInverseCdf,
  normalLogCdf,
  regularizedGammaP,
  augmentedDickeyFullerTest,
  bootstrap,
  mean,
  restoreRandomNumberGenerator,
  rollingCorrelation,
  rollingCovariance,
  rollingMean,
  rollingStandardDeviation,
  stratifiedUniforms,
  validateInterpolationData,
  xoshiro128ss,
  type KalmanModel,
  type Matrix,
} from '@totalfinance/math';

// ───────────────────────── independent references ─────────────────────────

/**
 * `P(a, x)` by the same power series the library uses for small `a`, but with a 5·10⁷-term budget
 * instead of 400 — i.e. the answer the capped series WOULD have reached had it been allowed to
 * converge. Deliberately not the quadrature under test.
 */
function referenceLowerRegGamma(a: number, x: number): number {
  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let n = 0; n < 5e7; n++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-17) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
}

/** Wilson–Hilferty cube-root normal approximation to the χ²(k) quantile — accurate to ~1e-9 at k=1e6. */
function wilsonHilfertyQuantile(p: number, k: number): number {
  const z = normalInverseCdf(p);
  const t = 2 / (9 * k);
  return k * Math.pow(1 - t + z * Math.sqrt(t), 3);
}

// ───────────────────────── [P0] large-shape incomplete gamma ─────────────────────────

describe('chiSquare/gamma CDF at large shape (the 400-term series used to return its partial sum)', () => {
  it('df sweep: |cdf(df, df) − ½| ≤ 2/√df (property)', () => {
    // The median of χ²(k) is just below k, so cdf(k, k) → ½ from above as k grows. The capped series
    // returned 0.5059 at df=1e3, 0.4638 at 1e5 and 0.2147 at 1e6 — the last two outside this bound
    // by 6× and 140×.
    for (const df of [1e3, 1e4, 1e5, 1e6, 1e7]) {
      const deviation = Math.abs(chiSquare.cdf(df, df) - 0.5);
      expect(deviation, `df=${df}`).toBeLessThanOrEqual(2 / Math.sqrt(df));
      // ...and it really is approaching ½, not merely inside a loose envelope.
      expect(deviation, `df=${df}`).toBeGreaterThan(0);
    }
    // Monotone in df: the deviation shrinks as ~1/√df.
    const deviations = [1e3, 1e4, 1e5, 1e6, 1e7].map((df) => Math.abs(chiSquare.cdf(df, df) - 0.5));
    for (let i = 1; i < deviations.length; i++) {
      expect(deviations[i]!).toBeLessThan(deviations[i - 1]!);
    }
  });

  it('both 5% decision points at df=1e6 match Wilson–Hilferty and an uncapped series', () => {
    const k = 1e6;
    // BOTH tails, deliberately: the capped SERIES ran for x below the mean (the 5th percentile),
    // where it read 0.21 instead of 0.05 — a decision flipped, not a digit lost — while the
    // continued fraction above the mean happened to converge. A one-sided check misses the defect.
    for (const [p, tolerance] of [
      [0.05, 1e-6],
      [0.95, 1e-6],
      [0.01, 1e-6],
      [0.5, 1e-6],
    ] as Array<[number, number]>) {
      const x = wilsonHilfertyQuantile(p, k);
      expect(Math.abs(chiSquare.cdf(x, k) - p), `p=${p}`).toBeLessThanOrEqual(tolerance);
      // Independent uncapped-series reference (χ²(k) at x ⇔ P(k/2, x/2)).
      expect(
        Math.abs(chiSquare.cdf(x, k) - referenceLowerRegGamma(k / 2, x / 2)),
        `p=${p} vs series`,
      ).toBeLessThan(1e-7);
      // ...and the quantile inverts back to the same place.
      expect(Math.abs(chiSquare.inverseCdf(p, k) / x - 1), `p=${p} inverse`).toBeLessThan(1e-8);
    }
  });

  it('the upper tail saturates at 1 rather than underflowing to 0', () => {
    // Q(a, x) underflows to exactly 0 far above the mean; the probability there is 1, not 0.
    for (const [x, df] of [
      [2e6, 1e6],
      [1e6, 1e5],
      [1e9, 1e6],
    ] as Array<[number, number]>) {
      expect(chiSquare.cdf(x, df), `cdf(${x}, ${df})`).toBe(1);
    }
    // and it is monotone across the whole range (no branch seam)
    let previous = -1;
    for (let x = 0; x <= 2e6; x += 25_000) {
      const v = chiSquare.cdf(x, 1e6);
      expect(v, `cdf(${x}, 1e6)`).toBeGreaterThanOrEqual(previous - 1e-15);
      previous = v;
    }
  });

  it('is continuous across the series/quadrature boundary at shape 150', () => {
    // Same distribution either side of the branch (a = 150 ∓ 1e-6): any disagreement between the two
    // algorithms shows up as a jump far larger than |∂P/∂a|·2e-6 ≈ 7e-8.
    for (const x of [100, 130, 150, 170, 220]) {
      const series = gamma.cdf(x, 150 - 1e-6);
      const quadrature = gamma.cdf(x, 150 + 1e-6);
      expect(Math.abs(series - quadrature), `x=${x}`).toBeLessThan(1e-6);
    }
    // Both branches also agree with the uncapped series reference.
    for (const [a, x] of [
      [149.9, 120],
      [149.9, 150],
      [150.1, 120],
      [150.1, 150],
      [500, 500],
    ] as Array<[number, number]>) {
      expect(
        Math.abs(gamma.cdf(x, a) - referenceLowerRegGamma(a, x)),
        `a=${a} x=${x}`,
      ).toBeLessThan(1e-11);
    }
  });

  it('matches the analytic P(a, a) asymptote out to a = 10¹²', () => {
    // P(a, a) = ½ + 1/(3√(2πa)) + O(a^−3/2) — an ANALYTIC reference, independent of any series,
    // quadrature or table. It is also the sharpest available check on the two floating-point
    // cancellations in the large-shape branch: with either one left in place, a = 10⁹ is off by
    // 1.6e-6 and a = 10¹² by 1.1e-4, both far outside this bound.
    for (const a of [1e3, 1e5, 1e7, 1e9, 1e12]) {
      const asymptote = 0.5 + 1 / (3 * Math.sqrt(2 * Math.PI * a));
      expect(Math.abs(regularizedGammaP(a, a) - asymptote), `a=${a}`).toBeLessThan(1e-6);
    }
    // Two standard deviations above the mean the CDF approaches Φ(2) as a → ∞.
    expect(regularizedGammaP(1e12, 1e12 + 2e6)).toBeCloseTo(normalCdf(2), 6);
  });

  it('P(a, ∞) is the limit 1, for every shape and both branches', () => {
    // The continued fraction evaluates exp(−∞ + ∞) = NaN here and can never satisfy its convergence
    // test, so this returned NaN before — and, once budget exhaustion became a thrown
    // ConvergenceError, it would have thrown on a perfectly well-defined limit.
    for (const df of [1, 5, 30, 1e6]) expect(chiSquare.cdf(Infinity, df), `df=${df}`).toBe(1);
    expect(gamma.cdf(Infinity, 200)).toBe(1);
    expect(regularizedGammaP(150, Infinity)).toBe(1);
  });

  it('leaves the small-shape goldens exactly where they were', () => {
    // Closed forms that must not move: χ²(2) is 1 − e^(−x/2), gamma(k=1) is the exponential.
    for (const x of [0.5, 1, 2, 4, 9]) {
      expect(chiSquare.cdf(x, 2)).toBeCloseTo(1 - Math.exp(-x / 2), 12);
      expect(gamma.cdf(x, 1, 2)).toBeCloseTo(1 - Math.exp(-x / 2), 12);
    }
    expect(chiSquare.inverseCdf(0.05, 3)).toBeCloseTo(0.3518463, 6);
    expect(chiSquare.inverseCdf(0.95, 10)).toBeCloseTo(18.307038, 5);
  });
});

// ───────────────────────── [P2] tail quantiles ─────────────────────────

describe('inverse CDFs resolve the deep lower tail instead of collapsing to 0', () => {
  it('χ²₁ quantiles match the Z² identity to 1e-6 relative (property)', () => {
    // χ²₁ quantile at probability q is (Φ⁻¹((1+q)/2))². Below ~1e-4 the true quantile is smaller
    // than the solver's ABSOLUTE step tolerance, and every one of these used to return exactly 0.
    for (const p of [1e-8, 1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 0.01, 0.1]) {
      const z = normalInverseCdf((1 + p) / 2);
      const reference = z * z;
      const got = chiSquare.inverseCdf(p, 1);
      expect(got, `p=${p}`).toBeGreaterThan(0);
      expect(Math.abs(got / reference - 1), `p=${p}`).toBeLessThanOrEqual(1e-6);
    }
  });

  it('gamma quantiles round-trip through the CDF in the far tail', () => {
    for (const [p, shape] of [
      [1e-12, 0.1],
      [1e-9, 0.5],
      [1e-6, 1],
      [1e-10, 2],
    ] as Array<[number, number]>) {
      const x = gamma.inverseCdf(p, shape);
      expect(x, `p=${p} k=${shape}`).toBeGreaterThan(0);
      expect(Math.abs(gamma.cdf(x, shape) / p - 1), `p=${p} k=${shape}`).toBeLessThanOrEqual(1e-6);
    }
  });

  it('mainstream quantiles are untouched', () => {
    for (const df of [1, 3, 7, 20]) {
      for (const p of [0.05, 0.25, 0.5, 0.9, 0.99]) {
        expect(chiSquare.cdf(chiSquare.inverseCdf(p, df), df), `df=${df} p=${p}`).toBeCloseTo(p, 8);
      }
    }
  });
});

// ───────────────────────── [P2] normal quantile in the denormal band ─────────────────────────

describe('normalInverseCdf keeps its accurate seed where the CDF underflows', () => {
  /** Newton on log Φ(x) = log p, using the library's asymptotic LOG-cdf branch (x ≤ −20). */
  function farTailReference(p: number): number {
    let x = -Math.sqrt(2 * Math.log(1 / p)); // crude start, well inside the asymptotic branch
    const target = Math.log(p);
    for (let i = 0; i < 200; i++) {
      const f = normalLogCdf(x) - target;
      // d/dx log Φ(x) = φ(x)/Φ(x) ≈ −x in the far-left tail.
      const step = f / -x;
      x -= step;
      if (Math.abs(step) < 1e-14) break;
    }
    return x;
  }

  it('p = 1e-300 (Φ(x) flushed to 0): the Halley step no longer drags the answer', () => {
    const reference = farTailReference(1e-300);
    expect(reference).toBeLessThan(-37); // sanity: the reference really is in the flushed band
    // Pre-fix: −37.0291 (the refinement was computed from e = −p, pure underflow noise).
    expect(Math.abs(normalInverseCdf(1e-300) - reference)).toBeLessThan(1e-6);
    expect(normalInverseCdf(1e-300)).toBeCloseTo(-37.0471, 3);
  });

  it('p = 3e-299 (Φ(x) still positive): refined exactly as before', () => {
    expect(normalInverseCdf(3e-299)).toBeCloseTo(-36.95524194441363, 12);
  });

  it('the CDF round-trips across the band boundary', () => {
    for (const p of [1e-290, 1e-298, 3e-299, 1e-300, 1e-305]) {
      const x = normalInverseCdf(p);
      expect(Number.isFinite(x), `p=${p}`).toBe(true);
      expect(Math.abs(normalLogCdf(x) - Math.log(p)), `p=${p}`).toBeLessThan(1e-6);
    }
  });
});

// ───────────────────────── [P1] non-finite interpolation knots ─────────────────────────

describe('interpolation rejects non-finite knots instead of spinning', () => {
  // Pre-fix these never returned: the dedup loop cannot advance past a NaN x (NaN === NaN is false),
  // so it appended forever until the array allocator threw a raw RangeError. Hence the timeouts.
  const badX = [0, NaN, 2];
  const badY = [0, 1, 2];

  it('every constructor and the validator throw fast on a NaN x-knot', { timeout: 10_000 }, () => {
    const table: Array<[string, () => unknown]> = [
      ['validateInterpolationData', () => validateInterpolationData(badX, badY)],
      ['makeLinearInterpolator', () => makeLinearInterpolator(badX, badY)],
      ['makePchipInterpolator', () => makePchipInterpolator(badX, badY)],
      ['makeNaturalCubicSpline', () => makeNaturalCubicSpline(badX, badY)],
      [
        'makeBicubicInterpolator',
        () =>
          makeBicubicInterpolator(
            badX,
            [0, 1, 2],
            [
              [0, 1, 2],
              [3, 4, 5],
              [6, 7, 8],
            ],
          ),
      ],
    ];
    for (const [name, call] of table) {
      expect(call, name).toThrowError(/finite/i);
    }
  });

  it(
    'names the offending index, and rejects ±Infinity and NaN y-knots too',
    { timeout: 10_000 },
    () => {
      expect(() => validateInterpolationData([0, NaN, 2], badY)).toThrowError(/xs\[1\]/);
      expect(() => validateInterpolationData([0, Infinity, 2], badY)).toThrowError(/xs\[1\]/);
      expect(() => validateInterpolationData([0, 1, 2], [0, NaN, 2])).toThrowError(/ys\[1\]/);
      expect(() => makePchipInterpolator([0, 1, 2], [0, -Infinity, 2])).toThrowError(/ys\[1\]/);
    },
  );

  it(
    'property: any NaN anywhere in the knots is rejected, never returned',
    { timeout: 20_000 },
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 2, max: 12 }),
          fc.integer({ min: 0, max: 11 }),
          (n, rawIndex) => {
            const index = rawIndex % n;
            const xs = Array.from({ length: n }, (_, i) => i);
            const ys = Array.from({ length: n }, (_, i) => i * i);
            xs[index] = NaN;
            expect(() => makeLinearInterpolator(xs, ys)).toThrowError(/finite/i);
          },
        ),
        { numRuns: 40 },
      );
    },
  );

  it('clean data still builds and interpolates', () => {
    const f = makeLinearInterpolator([0, 1, 2], [0, 10, 20]);
    expect(f(0.5)).toBeCloseTo(5, 12);
  });
});

// ───────────────────────── [P3] bicubic axis validation ─────────────────────────

describe('makeBicubicInterpolator enforces the axes it documents', () => {
  const z = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
  ];

  it('rejects an out-of-order axis (it was building splines on assumeSorted)', () => {
    expect(() => makeBicubicInterpolator([0, 2, 1], [0, 1, 2], z)).toThrowError(
      /strictly increasing/,
    );
    expect(() => makeBicubicInterpolator([0, 1, 2], [0, 2, 1], z)).toThrowError(
      /strictly increasing/,
    );
    expect(() => makeBicubicInterpolator([0, 1, 1], [0, 1, 2], z)).toThrowError(
      /strictly increasing/,
    );
  });

  it('still interpolates a valid grid exactly at the nodes', () => {
    const xs = [0, 1, 2];
    const ys = [0, 1, 2];
    const f = makeBicubicInterpolator(xs, ys, z);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(f(xs[i]!, ys[j]!)).toBeCloseTo(z[i]![j]!, 9);
  });
});

// ───────────────────────── [P1] differential evolution guards ─────────────────────────

describe('differentialEvolution validates its knobs (bounds table)', () => {
  const sphere = (v: number[]): number => v.reduce((s, vi) => s + vi * vi, 0);
  const bounds: Array<[number, number]> = [
    [-5, 5],
    [-5, 5],
  ];

  it('rejects every out-of-range knob', { timeout: 10_000 }, () => {
    // populationSize ≤ 3 used to HANG: rand/1/bin rejection-samples three distinct donors ≠ i, which
    // cannot terminate with fewer than four members. The others are ordinary range checks.
    const table: Array<[string, Record<string, number>, RegExp]> = [
      ['populationSize 3', { populationSize: 3 }, /populationSize/],
      ['populationSize 0', { populationSize: 0 }, /populationSize/],
      ['populationSize 4.5', { populationSize: 4.5 }, /populationSize/],
      ['mutation 0', { mutation: 0 }, /mutation/],
      ['mutation 2.5', { mutation: 2.5 }, /mutation/],
      ['mutation NaN', { mutation: NaN }, /mutation/],
      ['crossover -0.1', { crossover: -0.1 }, /crossover/],
      ['crossover 1.5', { crossover: 1.5 }, /crossover/],
      ['maxGenerations 0', { maxGenerations: 0 }, /maxGenerations/],
    ];
    for (const [name, options, message] of table) {
      expect(() => differentialEvolution(sphere, bounds, options), name).toThrowError(message);
    }
  });

  it(
    'accepts the smallest workable population and the range endpoints',
    { timeout: 10_000 },
    () => {
      const r = differentialEvolution(sphere, bounds, {
        populationSize: 4,
        mutation: 2,
        crossover: 0,
        maxGenerations: 30,
        seed: 3,
      });
      expect(Number.isFinite(r.minimum)).toBe(true);
      expect(r.evaluations).toBeGreaterThan(0);
    },
  );

  it('reports converged:true when it converges ON the final generation', () => {
    // Find the generation the run actually converges at, then hand it exactly that budget. The
    // off-by-one (`gen++` then `converged: gen < maxGen`) reported this identical run as a budget
    // exhaustion with reason 'max_iterations'.
    const full = differentialEvolution(sphere, bounds, { seed: 11 });
    expect(full.converged).toBe(true);
    const atBudget = differentialEvolution(sphere, bounds, {
      seed: 11,
      maxGenerations: full.iterations,
    });
    expect(atBudget.iterations).toBe(full.iterations);
    expect(atBudget.converged).toBe(true);
    expect(atBudget.reason).toBeUndefined();
    expect(atBudget.minimum).toBe(full.minimum);
    // One generation short is still an honest non-convergence.
    const short = differentialEvolution(sphere, bounds, {
      seed: 11,
      maxGenerations: full.iterations - 1,
    });
    expect(short.converged).toBe(false);
    expect(short.reason).toBe('max_iterations');
  });
});

// ───────────────────────── [P3] optimizer evaluation counts ─────────────────────────

describe('bfgs / levenbergMarquardt report the evaluations they promise', () => {
  it('bfgs populates evaluations on every exit path', () => {
    const quadratic = (v: number[]): number => (v[0]! - 1) ** 2 + (v[1]! + 2) ** 2;
    const converged = bfgs(quadratic, [0, 0]);
    expect(converged.converged).toBe(true);
    expect(converged.evaluations).toBeGreaterThan(0);
    // Numerical-gradient calls are counted too: 2n per gradient means well over one per iteration.
    expect(converged.evaluations!).toBeGreaterThan(converged.iterations);

    const budgetExhausted = bfgs(quadratic, [0, 0], { maximumIterations: 1, tolerance: 1e-16 });
    expect(budgetExhausted.evaluations).toBeGreaterThan(0);
  });

  it('levenbergMarquardt populates evaluations and no longer duplicates the base residual', () => {
    let calls = 0;
    const residuals = (p: number[]): number[] => {
      calls++;
      return [p[0]! - 3, p[1]! + 1, p[0]! * p[1]!];
    };
    const r = levenbergMarquardt(residuals, [0, 0]);
    expect(r.converged).toBe(true);
    expect(r.evaluations).toBe(calls); // the counter is the truth, not an estimate
    // Per iteration: n=2 Jacobian columns + 1 trial step = 3 evaluations (+1 for the initial
    // residual). The redundant `residuals(parameters)` pair inside the Jacobian made it 5.
    expect(r.evaluations!).toBeLessThanOrEqual(3 * r.iterations + 1);
  });

  it('levenbergMarquardt still fits what it used to fit', () => {
    // y = a·e^(b·x) sampled exactly; the fit must recover (a, b) = (2, −0.5).
    const xs = [0, 0.5, 1, 1.5, 2, 3, 4];
    const ys = xs.map((x) => 2 * Math.exp(-0.5 * x));
    const r = levenbergMarquardt(
      (p) => xs.map((x, i) => p[0]! * Math.exp(p[1]! * x) - ys[i]!),
      [1, -1],
    );
    expect(r.parameters[0]).toBeCloseTo(2, 6);
    expect(r.parameters[1]).toBeCloseTo(-0.5, 6);
    expect(r.residualNorm).toBeLessThan(1e-6);
  });
});

// ───────────────────────── [P2] PRNG state and seed echo ─────────────────────────

describe('random: degenerate states and seed echoes', () => {
  it('rejects the all-zero xoshiro state (a fixed point that yields 0 forever)', () => {
    expect(() =>
      restoreRandomNumberGenerator({ algorithm: 'xoshiro128ss', state: [0, 0, 0, 0], seed: 1 }),
    ).toThrowError(/all-zero|fixed point/i);
    // Only the ALL-zero state is degenerate; a single zero word is legitimate.
    const partial = restoreRandomNumberGenerator({
      algorithm: 'xoshiro128ss',
      state: [0, 0, 0, 123456789],
      seed: 1,
    });
    expect(partial.next()).toBeGreaterThanOrEqual(0);
    // A real snapshot still round-trips bit-for-bit.
    const live = xoshiro128ss(7);
    for (let i = 0; i < 5; i++) live.next();
    const restored = restoreRandomNumberGenerator(live.getState());
    expect(restored.next()).toBe(live.next());
  });

  it('echoes the caller literal seed, while seeding the state with seed >>> 0', () => {
    expect(mulberry32(-1).seed).toBe(-1);
    expect(xoshiro128ss(-1).seed).toBe(-1);
    expect(bootstrap([1, 2, 3, 4], mean, { seed: -1, iterations: 10 }).seed).toBe(-1);
    expect(monteCarlo((rng) => rng.next(), { seed: -1, paths: 100 }).seed).toBe(-1);
    // The stream is still the 32-bit one, so -1 and 4294967295 remain the same run.
    expect(mulberry32(-1).next()).toBe(mulberry32(4294967295).next());
    expect(mulberry32(42).seed).toBe(42);
  });
});

// ───────────────────────── [P3] Monte Carlo helper validation ─────────────────────────

describe('stratifiedUniforms validates count like its siblings', () => {
  it('rejects non-positive / fractional counts instead of throwing a raw RangeError', () => {
    // 2026-08-23: the message now teaches the full [1, cap] range (count safety wave), so the
    // assertion pins the range phrasing rather than the retired "positive integer" wording.
    for (const bad of [-1, 0, 2.5, NaN, Infinity]) {
      expect(() => stratifiedUniforms(mulberry32(1), bad), `count=${bad}`).toThrowError(
        /must be an integer in \[1/,
      );
    }
  });

  it('still stratifies: one sample per stratum, in order', () => {
    const out = stratifiedUniforms(mulberry32(5), 4);
    expect(out).toHaveLength(4);
    out.forEach((u, i) => {
      expect(u).toBeGreaterThanOrEqual(i / 4);
      expect(u).toBeLessThan((i + 1) / 4);
    });
  });
});

// ───────────────────────── [P3] rolling non-finite policy ─────────────────────────

describe('rolling statistics share ONE non-finite policy', () => {
  it('policy table: a window holding a non-finite value emits NaN, and recovers after it leaves', () => {
    const xs = [1, Infinity, 3, 4];
    const ys = [1, 2, 3, 4];
    const table: Array<[string, number[]]> = [
      ['rollingMean', rollingMean(xs, 2)],
      ['rollingStandardDeviation', rollingStandardDeviation(xs, 2)],
      ['rollingCovariance', rollingCovariance(xs, ys, 2)],
      ['rollingCorrelation', rollingCorrelation(xs, ys, 2)],
    ];
    for (const [name, out] of table) {
      expect(out[0], `${name}[0] warmup`).toBeNaN();
      expect(out[1], `${name}[1] window holds Infinity`).toBeNaN();
      expect(out[2], `${name}[2] window holds Infinity`).toBeNaN();
      expect(Number.isFinite(out[3]!), `${name}[3] recovered`).toBe(true);
    }
    // -Infinity and NaN are treated identically.
    for (const poison of [-Infinity, NaN]) {
      const out = rollingStandardDeviation([1, poison, 3, 4], 2);
      expect(out[1]).toBeNaN();
      expect(out[2]).toBeNaN();
      expect(out[3]).toBeCloseTo(Math.sqrt(0.5), 12);
    }
  });

  it('a statistic that is not finite is reported NaN, never ±Infinity or a silent 0', () => {
    // Finite inputs whose intermediate sums overflow. These used to surface as Infinity — or, for
    // correlation, as a perfectly correlated pair reporting ZERO.
    expect(rollingMean([1e308, 1.5e308, 3], 2)[1]).toBeNaN();
    expect(rollingStandardDeviation([1e308, 1.5e308, 3], 2)[1]).toBeNaN();
    expect(rollingCovariance([1e200, -1e200, 1], [1e200, -1e200, 1], 2)[1]).toBeNaN();
    expect(rollingCorrelation([1, 2, 3], [1e200, 2e200, 3e200], 2)[1]).toBeNaN();
    // The same correlation on a representable scale is still exactly 1.
    expect(rollingCorrelation([1, 2, 3], [1e100, 2e100, 3e100], 2)[1]).toBeCloseTo(1, 12);
  });

  it('ordinary series are untouched', () => {
    expect(rollingMean([1, 2, 3, 4], 2)).toEqual([NaN, 1.5, 2.5, 3.5]);
    expect(rollingStandardDeviation([1, 2, 3, 4], 2)[1]).toBeCloseTo(Math.sqrt(0.5), 12);
    expect(rollingCorrelation([1, 2, 3, 4], [2, 4, 6, 8], 3)[3]).toBeCloseTo(1, 12);
  });
});

// ───────────────────────── [P3] jacobiEigen shape validation ─────────────────────────

describe('jacobiEigen rejects what it cannot decompose', () => {
  it('a non-square matrix throws instead of returning the leading block eigenvalues', () => {
    // Pre-fix this returned [-0.464, 6.464] — the eigenvalues of [[1,2],[4,5]], with no hint that
    // the third column had been ignored.
    expect(() =>
      jacobiEigen([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toThrowError(/square/);
    expect(() => jacobiEigen([[1, 2], [3]] as Matrix)).toThrowError(/square/);
    expect(() => jacobiEigen([])).toThrowError(/non-empty/);
  });

  it('a non-finite entry throws instead of returning NaN eigenvalues', () => {
    expect(() =>
      jacobiEigen([
        [1, NaN],
        [NaN, 1],
      ]),
    ).toThrowError(/finite/);
  });

  it('legitimate symmetric matrices are unaffected (covariance / conditioning callers)', () => {
    const A: Matrix = [
      [4, 1, 2],
      [1, 3, 0],
      [2, 0, 5],
    ];
    const { values, vectors } = jacobiEigen(A);
    expect(values).toHaveLength(3);
    const trace = values.reduce((s, v) => s + v, 0);
    expect(trace).toBeCloseTo(12, 10);
    // A·v = λ·v for each eigenpair.
    for (let k = 0; k < 3; k++) {
      for (let i = 0; i < 3; i++) {
        const Av = A[i]!.reduce((s, aij, j) => s + aij * vectors[j]![k]!, 0);
        expect(Av).toBeCloseTo(values[k]! * vectors[i]![k]!, 8);
      }
    }
  });
});

// ───────────────────────── [review-1] Gauss–Legendre cache immutability ─────────────────────────

describe('gaussLegendreNodes hands out copies, not the shared cache', () => {
  it('mutating the returned arrays cannot corrupt later integrals', () => {
    const exact = gaussLegendre((x) => x * x, 0, 1, 10);
    expect(exact).toBeCloseTo(1 / 3, 12);

    const rule = gaussLegendreNodes(10);
    rule.nodes[0] = 999;
    rule.weights[0] = 999;
    rule.nodes.fill(-42);

    // Pre-fix: 1.2e8. The cached rule had been overwritten in place for the whole process.
    expect(gaussLegendre((x) => x * x, 0, 1, 10)).toBeCloseTo(1 / 3, 12);
    expect(gaussLegendre((x) => x ** 3, 0, 2, 10)).toBeCloseTo(4, 10);
    // A freshly requested rule is pristine too.
    const again = gaussLegendreNodes(10);
    expect(again.nodes.some((v) => v === 999 || v === -42)).toBe(false);
    expect(again.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(2, 12);
  });
});

// ───────────────────────── [review-1] RTS smoother on a PSD model ─────────────────────────

describe('kalmanSmooth handles the deterministic models the validator accepts', () => {
  it('P0 = Q = [[0]] smooths without throwing and reproduces the filter', () => {
    // A state that is known exactly and never moves. validateModel accepts it (PSD, not PD); the
    // smoother used to die inside cholesky with "matrix is not positive definite (pivot 0 at 0)".
    const model: KalmanModel = { x0: [2], P0: [[0]], F: [[1]], H: [[1]], Q: [[0]], R: [[1]] };
    const observations = [1, 2, 3, 4];
    const filtered = kalmanFilter(model, observations);
    const smoothed = kalmanSmooth(model, observations);
    for (let t = 0; t < observations.length; t++) {
      expect(smoothed.smoothedStates[t]![0]!, `t=${t}`).toBeCloseTo(
        filtered.filteredStates[t]![0]!,
        12,
      );
      expect(smoothed.smoothedCovariances[t]![0]![0]!, `t=${t}`).toBeCloseTo(0, 12);
    }
    // The deterministic state really is the prior, unmoved by the data.
    expect(smoothed.smoothedStates[0]![0]!).toBeCloseTo(2, 12);
  });

  it('a partially deterministic 2-state model smooths its stochastic component', () => {
    // [level, drift] with drift deterministic (zero process noise) — a singular predicted covariance
    // in the drift direction, a genuine one in the level.
    const model: KalmanModel = {
      x0: [0, 1],
      P0: [
        [1, 0],
        [0, 0],
      ],
      F: [
        [1, 1],
        [0, 1],
      ],
      H: [[1, 0]],
      Q: [
        [0.25, 0],
        [0, 0],
      ],
      R: [[0.5]],
    };
    const observations = [1.1, 2.0, 2.9, 4.2, 5.1, 5.9];
    const smoothed = kalmanSmooth(model, observations);
    expect(smoothed.smoothedStates).toHaveLength(observations.length);
    for (const s of smoothed.smoothedStates) {
      expect(Number.isFinite(s[0]!)).toBe(true);
      expect(s[1]!).toBeCloseTo(1, 12); // the deterministic drift is never corrected
    }
    // Smoothing is never less certain than filtering.
    const filtered = kalmanFilter(model, observations);
    for (let t = 0; t < observations.length; t++) {
      expect(smoothed.smoothedCovariances[t]![0]![0]!).toBeLessThanOrEqual(
        filtered.filteredCovariances[t]![0]![0]! + 1e-12,
      );
    }
  });

  it('a positive-definite model still goes through the Cholesky path unchanged', () => {
    const model: KalmanModel = { x0: [0], P0: [[1]], F: [[1]], H: [[1]], Q: [[0.1]], R: [[1]] };
    const smoothed = kalmanSmooth(model, [1, 2, 3, 4, 5]);
    for (const s of smoothed.smoothedStates) expect(Number.isFinite(s[0]!)).toBe(true);
    expect(smoothed.smoothedCovariances[0]![0]![0]!).toBeGreaterThan(0);
  });
});

// ───────────────────────── [P3] time-series preconditions ─────────────────────────

describe('augmentedDickeyFullerTest states the length it actually needs', () => {
  it('a 5-point series with lags=1 gets the teaching error, not an OLS internal', () => {
    // The regression has n−1−lags rows and lags+2 columns ('c'), so it needs n ≥ 2·lags + 4 = 6.
    // The old `lags + 4` let this through to die with "ols: needs more observations than
    // coefficients (n=3 ≤ k=3)".
    expect(() => augmentedDickeyFullerTest([1, 2, 1.5, 2.5, 2], { lags: 1 })).toThrowError(
      /augmentedDickeyFullerTest: series must have at least 6 observations, got 5/,
    );
    expect(() => augmentedDickeyFullerTest([1, 2, 1.5, 2.5], { regression: 'ct' })).toThrowError(
      /at least 5 observations, got 4/,
    );
    // The trend column costs one more observation: 'ct' with lags=1 needs 2·1+5 = 7.
    expect(() =>
      augmentedDickeyFullerTest([1, 2.3, 1.7, 3.1, 2.4, 4], { regression: 'ct', lags: 1 }),
    ).toThrowError(/at least 7 observations, got 6/);
  });

  it('the shortest ACCEPTED series really does fit', () => {
    // Exactly the length the guard demands must produce a finite statistic — i.e. the bound is the
    // true precondition, not a cushion. (It is a NECESSARY condition: a long-enough series can still
    // be rank-deficient, which `ols` reports in its own words.)
    expect(
      Number.isFinite(augmentedDickeyFullerTest([1, 2, 1.5, 2.5, 2, 3], { lags: 1 }).statistic),
    ).toBe(true);
    expect(
      Number.isFinite(
        augmentedDickeyFullerTest([1, 2, 1.5, 2.5, 2], { regression: 'ct' }).statistic,
      ),
    ).toBe(true);
    expect(
      Number.isFinite(
        augmentedDickeyFullerTest([1, 2.3, 1.7, 3.1, 2.4, 4, 3.2], {
          regression: 'ct',
          lags: 1,
        }).statistic,
      ),
    ).toBe(true);
  });
});

describe('ljungBox can drop degrees of freedom for fitted parameters', () => {
  const series = [1, 3, 2, 5, 4, 6, 5, 8, 7, 9, 8, 11];

  it('the default is unchanged and the corrected reference moves only the p-value', () => {
    const plain = ljungBox(series, 5);
    const corrected = ljungBox(series, 5, { fittedParameterCount: 2 });
    expect(corrected.statistic).toBe(plain.statistic);
    // dof = 5 − 2 = 3: the p-value is the χ²(3) survival of the same statistic.
    expect(corrected.pValue!).toBeCloseTo(1 - chiSquare.cdf(plain.statistic, 3), 12);
    expect(plain.pValue!).toBeCloseTo(1 - chiSquare.cdf(plain.statistic, 5), 12);
    // Fewer degrees of freedom ⇒ a smaller p-value for the same statistic (a sharper test).
    expect(corrected.pValue!).toBeLessThan(plain.pValue!);
    expect(corrected.method).toContain('dof=3');
    expect(plain.method).toBe('Ljung-Box (lags=5)');
    expect(ljungBox(series, 5, { fittedParameterCount: 0 }).method).toBe('Ljung-Box (lags=5)');
  });

  it('rejects a correction that would leave no degrees of freedom', () => {
    expect(() => ljungBox(series, 5, { fittedParameterCount: 5 })).toThrowError(
      /fittedParameterCount/,
    );
    expect(() => ljungBox(series, 5, { fittedParameterCount: -1 })).toThrowError(
      /fittedParameterCount/,
    );
    expect(() => ljungBox(series, 5, { fittedParameterCount: 1.5 })).toThrowError(
      /fittedParameterCount/,
    );
  });
});
