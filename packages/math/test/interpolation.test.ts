import { describe, expect, it } from 'vitest';
import { linearInterp, makeLinearInterpolator } from '@totalfinance/math';

const xs = [0, 1, 2, 3];
const ys = [0, 10, 20, 30];

describe('linearInterp', () => {
  it('interpolates interior points and hits the nodes exactly', () => {
    expect(linearInterp(xs, ys, 0.5)).toBeCloseTo(5, 12);
    expect(linearInterp(xs, ys, 1.5)).toBeCloseTo(15, 12);
    expect(linearInterp(xs, ys, 2)).toBe(20);
    expect(linearInterp(xs, ys, 0)).toBe(0);
    expect(linearInterp(xs, ys, 3)).toBe(30);
  });

  it('flat extrapolation by default', () => {
    expect(linearInterp(xs, ys, -5)).toBe(0);
    expect(linearInterp(xs, ys, 10)).toBe(30);
  });

  it('linear extrapolation extends the end slopes', () => {
    expect(linearInterp(xs, ys, -1, { extrapolate: 'linear' })).toBeCloseTo(-10, 12);
    expect(linearInterp(xs, ys, 4, { extrapolate: 'linear' })).toBeCloseTo(40, 12);
  });

  it('forbid extrapolation throws', () => {
    expect(() => linearInterp(xs, ys, 5, { extrapolate: 'forbid' })).toThrowError(/forbidden/);
  });

  it('makeLinearInterpolator is reusable', () => {
    const f = makeLinearInterpolator(xs, ys);
    expect(f(0.5)).toBeCloseTo(5, 12);
    expect(f(2.5)).toBeCloseTo(25, 12);
  });
});
