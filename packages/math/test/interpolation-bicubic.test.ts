/**
 * Tests for bicubic surface interpolation (§8.5): node reproduction, exactness on separable-linear
 * data, and smoothness (matches a smooth function more closely than bilinear at the cell center).
 */

import { describe, expect, it } from 'vitest';
import { bicubicInterp, bilinearInterp, makeBicubicInterpolator } from '@totalfinance/math';

const xs = [0, 1, 2, 3];
const ys = [0, 1, 2, 3];

describe('bicubic interpolation', () => {
  it('reproduces the grid values exactly at nodes', () => {
    const z = xs.map((x) => ys.map((y) => Math.sin(x) * Math.cos(y)));
    const f = makeBicubicInterpolator(xs, ys, z);
    for (let i = 0; i < xs.length; i++)
      for (let j = 0; j < ys.length; j++) {
        expect(f(xs[i]!, ys[j]!)).toBeCloseTo(z[i]![j]!, 9);
      }
  });

  it('is exact for separable-linear data z = x·y (splines reproduce linears)', () => {
    const z = xs.map((x) => ys.map((y) => x * y));
    expect(bicubicInterp(xs, ys, z, 1.7, 2.3)).toBeCloseTo(1.7 * 2.3, 9);
    expect(bicubicInterp(xs, ys, z, 0.4, 2.9)).toBeCloseTo(0.4 * 2.9, 9);
  });

  it('tracks a smooth surface more closely than bilinear at a cell center', () => {
    const g = (x: number, y: number): number => Math.exp(-((x - 1.5) ** 2 + (y - 1.5) ** 2) / 2);
    const fine = [0, 0.75, 1.5, 2.25, 3];
    const z = fine.map((x) => fine.map((y) => g(x, y)));
    const cubic = makeBicubicInterpolator(fine, fine, z);
    const px = 1.1;
    const py = 1.9;
    const truth = g(px, py);
    const cubicErr = Math.abs(cubic(px, py) - truth);
    const linearErr = Math.abs(bilinearInterp(fine, fine, z, px, py) - truth);
    expect(cubicErr).toBeLessThanOrEqual(linearErr + 1e-12);
  });

  it('rejects a mis-shaped grid', () => {
    expect(() => makeBicubicInterpolator(xs, ys, [[1, 2, 3]])).toThrow(/×/);
  });
});
