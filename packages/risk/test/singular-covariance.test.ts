import { expect, it } from 'vitest';
import {
  minVariance,
  efficientFrontier,
  maxSharpe,
  meanVariance,
  kelly,
  blackLitterman,
  riskParity,
  hrp,
} from '@totalfinance/risk';
const constraints = {
  budget: 1,
  bounds: [
    [0, 1],
    [0, 1],
  ] as [number, number][],
  maximumIterations: 1000,
  tolerance: 1e-8,
};
for (const covariance of [
  [
    [0.04, 0.02],
    [0.02, 0.01],
  ],
  [
    [0.04, -0.02],
    [-0.02, 0.01],
  ],
  [
    [0, 0],
    [0, 0],
  ],
  [
    [0.04, 0],
    [0, 0],
  ],
]) {
  it(`returns finite honest diagnostics for ${JSON.stringify(covariance)} (#17)`, () => {
    const result = minVariance(covariance, constraints);
    expect(result.diagnostics.converged).toBe(false);
    expect(result.diagnostics.warnings).toContainEqual(
      expect.objectContaining({
        context: expect.objectContaining({ conditionNumber: null, reason: 'singular_covariance' }),
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
    const frontier = efficientFrontier({
      mean: [0.08, 0.03],
      covariance,
      constraints,
      grid: { kind: 'points', count: 3 },
    });
    expect(JSON.stringify(frontier)).not.toMatch(/NaN|Infinity/);
  });
}

for (const covariance of [
  [
    [-0.04, 0],
    [0, 0.01],
  ],
  [
    [0.04, 0.05],
    [0.05, 0.01],
  ],
])
  for (const [name, run] of Object.entries({
    minVariance: () => minVariance(covariance, constraints),
    costAware: () =>
      minVariance(covariance, {
        ...constraints,
        transactionCosts: { perUnitTurnover: 0.01, previousWeights: [0.5, 0.5] },
      }),
    blackLitterman: () =>
      blackLitterman({
        covariance,
        marketWeights: [0.5, 0.5],
        riskAversion: 2.5,
        views: [{ pick: [1, 0], view: 0.1 }],
      }),
    maxSharpe: () =>
      maxSharpe({
        mean: [0.08, 0.03],
        covariance,
        options: { riskFreeRatePerPeriod: 0, ...constraints },
      }),
    meanVariance: () =>
      meanVariance({
        mean: [0.08, 0.03],
        covariance,
        options: { riskAversion: 1, ...constraints },
      }),
    kelly: () => kelly({ mean: [0.08, 0.03], covariance, options: constraints }),
    frontier: () =>
      efficientFrontier({
        mean: [0.08, 0.03],
        covariance,
        constraints,
        grid: { kind: 'points', count: 3 },
      }),
  }))
    it(`refuses invalid covariance before ${name}`, () =>
      expect(run).toThrowError(expect.objectContaining({ code: 'input.out_of_range' })));

for (const scale of [1e-200, 1, 1e200])
  it(`checks covariance validity independently of currency scale ${scale}`, () => {
    expect(() =>
      minVariance(
        [
          [0.04 * scale, 0.05 * scale],
          [0.05 * scale, 0.01 * scale],
        ],
        constraints,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'input.out_of_range',
        context: expect.objectContaining({ reason: 'indefinite_covariance' }),
      }),
    );
  });

for (const scale of [1e-150, 1, 1e150])
  it(`accepts a rank-deficient Gram covariance at ${scale} without mutating it`, () => {
    const vectors = Array.from({ length: 12 }, (_, i) => [1, (i + 1) / 16, ((i % 3) + 1) / 8]);
    const covariance = vectors.map((x) =>
      vectors.map((y) => scale * x.reduce((sum, z, k) => sum + z * y[k]!, 0)),
    );
    const before = covariance.map((row) => row.slice());
    for (const result of [riskParity(covariance), hrp(covariance)]) {
      expect(result.value.weights.every(Number.isFinite)).toBe(true);
      expect(result.value.weights.reduce((sum, x) => sum + x, 0)).toBeCloseTo(1, 10);
    }
    expect(covariance).toEqual(before);
  });
