/**
 * Count/resource safety, library-wide wave (2026-08-23 review, P0).
 *
 * The defect class: `Number.isInteger(1e308)` is `true`, and `counter++` stops advancing at 2^53 —
 * so a workload control validated with `Number.isInteger` and then looped or allocated is a
 * non-terminating loop or an absurd allocation (with `new Float64Array(1e308)` surfacing as a raw
 * RangeError that teaches nothing). Every workload head in this package now refuses non-safe
 * integers with a typed teaching, and every head that drives synchronous loops/allocation also
 * carries an operation-appropriate cap that names its own boundary and reason.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  acf,
  antitheticSampler,
  augmentedDickeyFullerTest,
  bfgs,
  bisection,
  bootstrap,
  bracketExpand,
  brent,
  brentMin,
  differentialEvolution,
  findRoot,
  gaussLegendre,
  gaussLegendreNodes,
  goldenSectionMin,
  halley,
  haltonPoint,
  haltonSequence,
  householder,
  jacobiEigen,
  levenbergMarquardt,
  ljungBox,
  monteCarlo,
  mulberry32,
  nelderMead,
  newton,
  ols,
  pacf,
  ridder,
  rollingMean,
  secant,
  sobolSequence,
  solveAll,
  stratifiedUniforms,
  uniformSamples,
} from '@totalfinance/math';
import { sobolPrimitive } from '../src/sobol-data.js';

/** Catch and return whatever `fn` throws (undefined when it does not). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const sphere = (v: number[]): number => v.reduce((s, x) => s + x * x, 0);

// Values that `Number.isInteger` blesses but no loop or allocator can honor, plus a plain fraction.
const ABSURD = [2 ** 32, 2 ** 53, 2 ** 53 + 2, 1e308, -(2 ** 53), 2.5] as const;

describe('2026-08-23 P0 — capped workload heads refuse absurd counts with one typed teaching', () => {
  it('every capped head refuses 2^32, unsafe integers, 1e308, a huge negative, and a fraction', () => {
    for (const bad of ABSURD) {
      const calls: ReadonlyArray<readonly [string, () => unknown]> = [
        ['uniformSamples.count', () => uniformSamples(mulberry32(1), bad)],
        ['stratifiedUniforms.count', () => stratifiedUniforms(mulberry32(1), bad)],
        [
          'bootstrap.iterations',
          () => bootstrap([1, 2, 3, 4], (s) => s[0]!, { iterations: bad, seed: 1 }),
        ],
        ['monteCarlo.paths', () => monteCarlo((rng) => rng.next(), { paths: bad, seed: 1 })],
        ['antitheticSampler.dimensions', () => antitheticSampler((z) => z[0]!, bad)],
        [
          'differentialEvolution.populationSize',
          () => differentialEvolution(sphere, [[-1, 1]], { populationSize: bad }),
        ],
        [
          'differentialEvolution.maxGenerations',
          () => differentialEvolution(sphere, [[-1, 1]], { maxGenerations: bad }),
        ],
        ['haltonSequence.count', () => haltonSequence(bad, 2)],
        ['sobolSequence.count', () => sobolSequence(bad, 2)],
      ];
      for (const [head, call] of calls) {
        const error = caught(call);
        expect(isQuantError(error, 'input.out_of_range'), `${head} = ${bad}`).toBe(true);
      }
    }
  });

  it('shared solver, optimizer, eigen, and batch iteration budgets are capped before work', () => {
    const root = (value: number): number => value * value - 2;
    const derivatives = (value: number) => ({
      f: value * value - 2,
      df: 2 * value,
      d2f: 2,
      d3f: 0,
    });
    const scalarObjective = (value: number): number => value * value;
    const vectorObjective = (values: number[]): number => (values[0] ?? 0) ** 2;

    for (const bad of ABSURD) {
      const calls: ReadonlyArray<readonly [string, () => unknown]> = [
        ['bisection', () => bisection(root, 0, 2, { maximumIterations: bad })],
        ['brent', () => brent(root, 0, 2, { maximumIterations: bad })],
        ['ridder', () => ridder(root, 0, 2, { maximumIterations: bad })],
        ['secant', () => secant(root, 0, 2, { maximumIterations: bad })],
        ['bracketExpand', () => bracketExpand(root, 0, 2, { maximumIterations: bad })],
        ['findRoot', () => findRoot(root, 0, 2, { maximumIterations: bad })],
        ['newton', () => newton(derivatives, 1, { maximumIterations: bad })],
        ['halley', () => halley(derivatives, 1, { maximumIterations: bad })],
        ['householder', () => householder(derivatives, 1, { maximumIterations: bad })],
        [
          'goldenSectionMin',
          () => goldenSectionMin(scalarObjective, -2, 2, { maximumIterations: bad }),
        ],
        ['brentMin', () => brentMin(scalarObjective, -2, 2, { maximumIterations: bad })],
        ['nelderMead', () => nelderMead(vectorObjective, [1], { maximumIterations: bad })],
        ['bfgs', () => bfgs(vectorObjective, [1], { maximumIterations: bad })],
        [
          'levenbergMarquardt',
          () =>
            levenbergMarquardt((parameters) => [(parameters[0] ?? 0) - 1], [0], {
              maximumIterations: bad,
            }),
        ],
        [
          'jacobiEigen',
          () =>
            jacobiEigen(
              [
                [2, 1],
                [1, 2],
              ],
              { maximumIterations: bad },
            ),
        ],
        ['solveAll', () => solveAll([], { maximumIterations: bad })],
      ];
      for (const [head, call] of calls) {
        expect(isQuantError(caught(call), 'input.out_of_range'), `${head} = ${bad}`).toBe(true);
      }
    }
  });

  it('shared iteration and Gauss–Legendre caps teach their own boundary before allocation', () => {
    const iterationError = caught(() => solveAll([], { maximumIterations: 1_000_001 })) as Error;
    expect(isQuantError(iterationError, 'input.out_of_range')).toBe(true);
    expect(iterationError.message).toContain('1,000,000');
    expect(iterationError.message).toContain('unbounded synchronous solve');

    for (const [head, call] of [
      ['gaussLegendreNodes', (): unknown => gaussLegendreNodes(4_097)],
      ['gaussLegendre', (): unknown => gaussLegendre((x) => x * x, 0, 1, 4_097)],
    ] as const) {
      const error = caught(call) as Error;
      expect(isQuantError(error, 'input.out_of_range'), head).toBe(true);
      expect(error.message, head).toContain('4,096');
      expect(error.message, head).toContain('quadratic');
    }
  });

  it('each cap teaches its own boundary: cap + 1 is refused naming the cap and its reason', () => {
    const table: ReadonlyArray<readonly [string, () => unknown, string, string]> = [
      // [head, call at cap + 1, formatted cap in the message, a load-bearing reason fragment]
      ['uniformSamples', () => uniformSamples(mulberry32(1), 100_000_001), '100,000,000', '8-byte'],
      [
        'stratifiedUniforms',
        () => stratifiedUniforms(mulberry32(1), 100_000_001),
        '100,000,000',
        'stratum',
      ],
      [
        'bootstrap',
        () => bootstrap([1, 2, 3], (s) => s[0]!, { iterations: 1_000_001, seed: 1 }),
        '1,000,000',
        'resamples',
      ],
      [
        'monteCarlo',
        () => monteCarlo((rng) => rng.next(), { paths: 100_000_001, seed: 1 }),
        '100,000,000',
        '1/√n',
      ],
      [
        'antitheticSampler',
        () => antitheticSampler((z) => z[0]!, 1_000_001),
        '1,000,000',
        'scratch',
      ],
      [
        'differentialEvolution populationSize',
        () => differentialEvolution(sphere, [[-1, 1]], { populationSize: 1_000_001 }),
        '1,000,000',
        'populationSize × dimensions',
      ],
      ['haltonSequence', () => haltonSequence(16_777_217, 2), '16,777,216', 'materialized'],
      ['sobolSequence', () => sobolSequence(16_777_217, 2), '16,777,216', 'materialized'],
    ];
    for (const [head, call, cap, reason] of table) {
      const error = caught(call);
      expect(isQuantError(error, 'input.out_of_range'), head).toBe(true);
      expect(String((error as Error).message), `${head} names its cap`).toContain(cap);
      expect(String((error as Error).message), `${head} teaches its reason`).toContain(reason);
    }
  });

  it('multiplying counts are bounded as a PRODUCT even when each factor is under its own cap', () => {
    // DE: 20,000 members × 10,000 generations = 2×10^8 objective evaluations > the 10^8 cap.
    const de = caught(() =>
      differentialEvolution(sphere, [[-1, 1]], { populationSize: 20_000, maxGenerations: 10_000 }),
    );
    expect(isQuantError(de, 'input.out_of_range')).toBe(true);
    expect(String((de as Error).message)).toContain('populationSize × maxGenerations');
    expect(String((de as Error).message)).toContain('100,000,000');

    // Low-discrepancy: 2^24 points × 5 dims = 8.4×10^7 cells > the 2^26-cell allocation bound.
    for (const [name, call] of [
      ['haltonSequence', (): unknown => haltonSequence(2 ** 24, 5)],
      ['sobolSequence', (): unknown => sobolSequence(2 ** 24, 5)],
    ] as const) {
      const error = caught(call);
      expect(isQuantError(error, 'input.out_of_range'), name).toBe(true);
      expect(String((error as Error).message), name).toContain('count × dimensions');
      expect(String((error as Error).message), name).toContain('67,108,864');
    }
  });

  it('uniformSamples 1e308 is now a typed refusal, not the raw allocator RangeError it used to be', () => {
    // Before this wave `Number.isInteger(1e308)` passed and `new Float64Array(1e308)` threw a raw
    // `RangeError: Invalid typed array length` naming neither the function nor the argument.
    const error = caught(() => uniformSamples(mulberry32(1), 1e308));
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(String((error as Error).message)).toContain('uniformSamples');
    expect(String((error as Error).message)).toContain('count');
  });

  it('realistic budgets still work end to end', () => {
    expect(uniformSamples(mulberry32(1), 1_000)).toHaveLength(1_000);
    expect(stratifiedUniforms(mulberry32(2), 16)).toHaveLength(16);
    const bs = bootstrap([3, 1, 4, 1, 5, 9, 2, 6], (s) => s.reduce((a, b) => a + b, 0) / s.length, {
      iterations: 200,
      seed: 7,
    });
    expect(bs.iterations).toBe(200);
    expect(Number.isFinite(bs.mean)).toBe(true);
    const mc = monteCarlo((rng) => rng.next(), { paths: 2_000, seed: 5 });
    expect(mc.value).toBeGreaterThan(0.4);
    expect(mc.value).toBeLessThan(0.6);
    const sampler = antitheticSampler((z) => z[0]! * z[0]!, 3);
    expect(Number.isFinite(sampler(mulberry32(9)))).toBe(true);
    const de = differentialEvolution((p) => (p[0]! - 1) ** 2, [[-5, 5]], {
      populationSize: 12,
      maxGenerations: 60,
      seed: 3,
    });
    expect(de.argMin[0]!).toBeCloseTo(1, 1);
    expect(haltonSequence(64, 2)).toHaveLength(64);
    expect(sobolSequence(64, 3)).toHaveLength(64);
  });
});

describe('2026-08-23 P0 — data/domain-bounded heads are safe integers', () => {
  it('monteCarlo minPaths (bounds no loop) refuses 2^53 and fractions', () => {
    for (const bad of [2 ** 53, 1e308, 2.5]) {
      const error = caught(() =>
        monteCarlo((rng) => rng.next(), { paths: 100, minPaths: bad, seed: 1 }),
      );
      expect(isQuantError(error, 'input.out_of_range'), `minPaths = ${bad}`).toBe(true);
    }
  });

  it('lag/window heads refuse 2^53 and fractions with the same typed teaching as before', () => {
    const series = [1, 3, 2, 5, 4, 6, 5, 8, 7, 9, 8, 11];
    for (const bad of [2 ** 53, 1e308, 2.5]) {
      const calls: ReadonlyArray<readonly [string, () => unknown]> = [
        ['acf.maxLag', () => acf(series, bad)],
        ['pacf.maxLag', () => pacf(series, bad)],
        ['ljungBox.lags', () => ljungBox(series, bad)],
        ['ljungBox.fittedParameterCount', () => ljungBox(series, 3, { fittedParameterCount: bad })],
        ['augmentedDickeyFullerTest.lags', () => augmentedDickeyFullerTest(series, { lags: bad })],
        ['rollingMean.window', () => rollingMean(series, bad)],
      ];
      for (const [head, call] of calls) {
        const error = caught(call);
        expect(isQuantError(error, 'input.out_of_range'), `${head} = ${bad}`).toBe(true);
      }
    }
  });

  it('rollingMean at 2^53 REFUSES instead of silently returning the all-NaN vector it used to', () => {
    // The discriminating case: `Number.isInteger(2 ** 53)` is `true` and `window > n` early-returns,
    // so before this wave the call "succeeded" with a meaningless all-NaN result.
    const error = caught(() => rollingMean([1, 2, 3], 2 ** 53));
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(rollingMean([1, 2, 3, 4], 2)[3]).toBeCloseTo(3.5, 12); // realistic window unchanged
  });

  it('haltonPoint index must be exact: 2^53 refused, real indices unchanged', () => {
    const error = caught(() => haltonPoint(2 ** 53, 2));
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(haltonPoint(1, 1)[0]).toBeCloseTo(0.5, 12);
  });

  it('ols hac.lags is bounded by the data: only n − 1 sample autocovariances exist', () => {
    const n = 12;
    const y = Array.from({ length: n }, (_, i) => 2 + 0.5 * i + Math.sin(i));
    const x = Array.from({ length: n }, (_, i) => [i]);
    // 2^53 used to spin the Newey–West outer loop effectively forever (empty Γⱼ per iteration).
    for (const bad of [2 ** 53, 1e308, n, 2.5]) {
      const error = caught(() => ols(y, x, { hac: { lags: bad } }));
      expect(isQuantError(error, 'input.out_of_range'), `hac.lags = ${bad}`).toBe(true);
    }
    const atBound = caught(() => ols(y, x, { hac: { lags: n } }));
    expect(String((atBound as Error).message)).toContain(`[0, ${n - 1}]`);
    expect(String((atBound as Error).message)).toContain('autocovariances');
    // A realistic bandwidth still fits and reports finite HAC standard errors.
    const fit = ols(y, x, { hac: { lags: 4 } });
    expect(fit.standardErrors.every((se) => Number.isFinite(se))).toBe(true);
  });

  it('sobolPrimitive dimIndex is capped at the last dimension this build can emit', () => {
    for (const bad of [2 ** 53, 1e308, 2.5, 1111]) {
      const error = caught(() => sobolPrimitive(bad));
      expect(isQuantError(error, 'input.out_of_range'), `dimIndex = ${bad}`).toBe(true);
    }
    const overCap = caught(() => sobolPrimitive(1111));
    expect(String((overCap as Error).message)).toContain('1110');
    expect(String((overCap as Error).message)).toContain('unbounded');
    expect(sobolPrimitive(13)).toEqual({ s: 6, a: 1 }); // the committed Joe–Kuo row for dimIndex 13
  });
});
