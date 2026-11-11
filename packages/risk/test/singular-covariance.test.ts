import { expect, it } from 'vitest';
import { minVariance, efficientFrontier } from '@totalfinance/risk';
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
