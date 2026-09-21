/**
 * WS1.21: `bilinearInterp` validates its axes/grid (it used to trust unsorted/short input), and the
 * cubic builders gain an `extrapolate` policy: `flat` (default, unchanged), `linear`, or `forbid`
 * (throws `interpolation.out_of_domain`).
 */

import { describe, expect, it } from 'vitest';
import { bilinearInterp, makeNaturalCubicSpline, makePchipInterpolator } from '@totalfinance/math';

describe('bilinearInterp validation (WS1.21)', () => {
  const xs = [0, 1, 2];
  const ys = [0, 1];
  const z = [
    [0, 1],
    [2, 3],
    [4, 5],
  ]; // 3×2

  it('interpolates inside the grid', () => {
    expect(bilinearInterp(xs, ys, z, 1, 0.5)).toBeCloseTo(2.5, 12);
  });
  it('rejects a 1-element axis', () => {
    expect(() => bilinearInterp([0], ys, [[0, 1]], 0, 0.5)).toThrow();
  });
  it('rejects a non-monotone axis', () => {
    expect(() => bilinearInterp([0, 2, 1], ys, z, 1, 0.5)).toThrow();
  });
  it('rejects a mis-shaped grid', () => {
    expect(() =>
      bilinearInterp(
        xs,
        ys,
        [
          [0, 1],
          [2, 3],
        ],
        1,
        0.5,
      ),
    ).toThrow();
  });
});

describe('cubic extrapolation policy (WS1.21)', () => {
  const X = [0, 1, 2, 3, 4];
  const Y = [0, 1, 4, 9, 16]; // ~x²

  for (const make of [makePchipInterpolator, makeNaturalCubicSpline]) {
    it(`${make.name}: default and 'flat' clamp to the endpoint (regression)`, () => {
      const flat = make(X, Y);
      const flatExplicit = make(X, Y, { extrapolate: 'flat' });
      expect(flat(-1)).toBe(0); // clamps to Y[0]
      expect(flat(5)).toBe(16); // clamps to Y[last]
      expect(flatExplicit(-1)).toBe(flat(-1));
      expect(flatExplicit(5)).toBe(flat(5));
      expect(flat(2)).toBeCloseTo(4, 9); // interior unchanged
    });

    it(`${make.name}: 'forbid' throws outside the domain, exact inside`, () => {
      const f = make(X, Y, { extrapolate: 'forbid' });
      expect(() => f(-0.1)).toThrow(/forbidden|domain/i);
      expect(() => f(4.1)).toThrow(/forbidden|domain/i);
      expect(f(2)).toBeCloseTo(4, 9); // interior still works
      expect(f(0)).toBe(0); // endpoints are in-domain
      expect(f(4)).toBe(16);
    });

    it(`${make.name}: 'linear' extends the end slope beyond a flat clamp`, () => {
      const linear = make(X, Y, { extrapolate: 'linear' });
      const flat = make(X, Y, { extrapolate: 'flat' });
      expect(linear(5)).toBeGreaterThan(flat(5)); // rising slope continues past 16
    });
  }
});
