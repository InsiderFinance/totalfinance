import { expect, it } from 'vitest';
import { ols } from '@totalfinance/math';
it('retains exact HC1 corrected sandwich standard errors (#24)', () => {
  const r = ols([1, 2, 2, 4], [[0], [1], [2], [3]], { intercept: true, hac: { lags: 0 } });
  expect(r.standardErrors[0]! ** 2).toBeCloseTo(113 / 2500, 14);
  expect(r.standardErrors[1]! ** 2).toBeCloseTo(103 / 2500, 14);
});
it('teaches the actual HC1 convention for missing bandwidth', () => {
  expect(() =>
    ols([1, 2, 2, 4], [[0], [1], [2], [3]], { intercept: true, hac: {} as never }),
  ).toThrow(/HC1/);
});
// Exact rational Bartlett sandwich references, independently evaluated with Fraction arithmetic.
for (const [intercept, lags, diagonal] of [
  [true, 1, [141 / 2500, 71 / 2500]],
  [false, 0, [2 / 147]],
  [false, 1, [34 / 7203]],
] as const)
  it(`states and preserves finite correction: intercept=${intercept}, lags=${lags}`, () => {
    const r = ols([1, 2, 2, 4], [[0], [1], [2], [3]], { intercept, hac: { lags } });
    diagonal.forEach((expected, i) => expect(r.standardErrors[i]! ** 2).toBeCloseTo(expected, 14));
  });
