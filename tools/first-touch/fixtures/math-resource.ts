/** Valid, low-cost baselines for every resource-bearing @totalfinance/math public function. */

import { mulberry32, luDecompose } from '@totalfinance/math';
import type { FixtureThunk } from '../inputs.js';

const ROOT = (x: number): number => x * x - 2;
const DERIVATIVES = (x: number): { f: number; df: number; d2f: number; d3f: number } => ({
  f: x * x - 2,
  df: 2 * x,
  d2f: 2,
  d3f: 0,
});
const QUADRATIC = (point: number[]): number => (point[0] ?? 0) ** 2;
const SCALAR_QUADRATIC = (value: number): number => value * value;
const SERIES = (): number[] =>
  Array.from({ length: 24 }, (_, index) => index * 0.1 + Math.sin(index * 0.7));
export const MATH_RESOURCE_FIXTURES: Record<string, FixtureThunk> = {
  'math.antitheticSampler': () => [(normalDraws: number[]) => normalDraws[0] ?? 0, 2],
  'math.augmentedDickeyFullerTest': () => [SERIES(), { lags: 1 }],
  'math.bfgs': () => [QUADRATIC, [1], { maximumIterations: 20 }],
  'math.bisection': () => [ROOT, 0, 2, { maximumIterations: 20 }],
  'math.bootstrap': () => [
    [1, 2, 3, 4],
    (sample: number[]) => sample.reduce((sum, value) => sum + value, 0) / sample.length,
    { iterations: 20, seed: 1 },
  ],
  'math.bracketExpand': () => [ROOT, 0, 2, { maximumIterations: 20 }],
  'math.brent': () => [ROOT, 0, 2, { maximumIterations: 20 }],
  'math.brentMin': () => [SCALAR_QUADRATIC, -2, 2, { maximumIterations: 20 }],
  'math.differentialEvolution': () => [
    QUADRATIC,
    [[-2, 2]],
    { populationSize: 8, maxGenerations: 8, seed: 1 },
  ],
  'math.findRoot': () => [ROOT, 0, 2, { maximumIterations: 20 }],
  'math.gaussLegendre': () => [(x: number) => x * x, 0, 1, 8],
  'math.gaussLegendreNodes': () => [8],
  'math.goldenSectionMin': () => [SCALAR_QUADRATIC, -2, 2, { maximumIterations: 20 }],
  'math.halley': () => [DERIVATIVES, 1, { maximumIterations: 20 }],
  'math.haltonPoint': () => [1, 2],
  'math.haltonSequence': () => [8, 2],
  'math.householder': () => [DERIVATIVES, 1, { maximumIterations: 20 }],
  'math.jacobiEigen': () => [
    [
      [2, 1],
      [1, 2],
    ],
    { maximumIterations: 20 },
  ],
  'math.levenbergMarquardt': () => [
    (parameters: number[]) => [(parameters[0] ?? 0) - 1],
    [0],
    { maximumIterations: 20 },
  ],
  'math.ljungBox': () => [SERIES(), 3, { fittedParameterCount: 1 }],
  'math.monteCarlo': () => [
    (randomNumberGenerator: { next: () => number }) => randomNumberGenerator.next(),
    { paths: 100, minPaths: 20, seed: 1 },
  ],
  'math.nelderMead': () => [QUADRATIC, [1], { maximumIterations: 20 }],
  'math.newton': () => [DERIVATIVES, 1, { maximumIterations: 20 }],
  // Stage 7A slice 3 (2026-09-03): three linear-algebra heads whose synthesized baselines had
  // mismatched dimensions (60-vectors against 12×12 systems) — valid calls, measured instead of ledgered.
  'math.luSolve': () => [
    luDecompose([
      [4, 3],
      [6, 3],
    ]),
    [10, 12],
  ],
  'math.qrSolve': () => [
    [
      [1, 1],
      [1, 2],
      [1, 3],
    ],
    [1, 2, 2],
  ],
  'math.matrixVectorProduct': () => [
    [
      [1, 2],
      [3, 4],
    ],
    [5, 6],
  ],
  'math.ols': () => [
    [1, 2.1, 2.9, 4.2, 4.8, 6.1],
    [[1], [2], [3], [4], [5], [6]],
    { hac: { lags: 1 } },
  ],
  'math.ridder': () => [ROOT, 0, 2, { maximumIterations: 20 }],
  'math.rollingCorrelation': () => [SERIES(), SERIES().map((value) => value * 1.1 + 0.2), 3],
  'math.rollingCovariance': () => [SERIES(), SERIES().map((value) => value * 1.1 + 0.2), 3],
  'math.rollingMean': () => [SERIES(), 3],
  'math.rollingStandardDeviation': () => [SERIES(), 3],
  'math.secant': () => [ROOT, 0, 2, { maximumIterations: 20 }],
  'math.sobolSequence': () => [8, 2],
  'math.solveAll': () => [
    [{ objective: ROOT, lowerBound: 0, upperBound: 2 }],
    { maximumIterations: 20 },
  ],
  'math.stratifiedUniforms': () => [mulberry32(1), 8],
  'math.uniformSamples': () => [mulberry32(1), 8],
};
