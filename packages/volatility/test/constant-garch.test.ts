import { expect, it } from 'vitest';
import { fitGarch } from '@totalfinance/volatility/forecast';
for (const value of [0.0023, -0.0011, 0.1])
  for (const length of [60, 127])
    it(`keeps exact constant ${value}/${length} degenerate in sample mode (#20)`, () => {
      const result = fitGarch(Array(length).fill(value), { mean: 'sample', seed: 42 });
      expect(result.converged).toBe(false);
      expect(result.longRunVariance).toBe(0);
    });
it('retains the zero-mean second moment of a nonzero constant', () => {
  expect(
    fitGarch(Array(60).fill(0.0023), { mean: 'zero', seed: 42 }).longRunVariance,
  ).toBeGreaterThan(0);
});
it('does not erase genuine variation near a constant', () => {
  const r = fitGarch(
    Array.from({ length: 60 }, (_, i) => 0.0023 + (i % 2) * 1e-10),
    { mean: 'sample', seed: 42 },
  );
  expect(r.longRunVariance).toBeGreaterThan(0);
});
