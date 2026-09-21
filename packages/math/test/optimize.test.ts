import { describe, expect, it } from 'vitest';
import {
  bfgs,
  brentMin,
  goldenSectionMin,
  levenbergMarquardt,
  nelderMead,
} from '@totalfinance/math';

const rosenbrock = (v: number[]): number => {
  const x = v[0]!;
  const y = v[1]!;
  return (1 - x) ** 2 + 100 * (y - x * x) ** 2;
};

describe('scalar minimization', () => {
  it('goldenSectionMin finds the minimum of (x-3)²', () => {
    const r = goldenSectionMin((x) => (x - 3) ** 2, 0, 10);
    expect(r.converged).toBe(true);
    expect(r.argMin).toBeCloseTo(3, 6);
  });
  it('brentMin finds the minimum of a quartic', () => {
    // f = x^4 - 3x^2 + x has a minimum near x ≈ -1.30; bracket the left well.
    const r = brentMin((x) => x ** 4 - 3 * x * x + x, -3, 0);
    expect(r.converged).toBe(true);
    // verify it is a local min: f'(x) ≈ 0
    const h = 1e-6;
    const slope =
      ((r.argMin + h) ** 4 -
        3 * (r.argMin + h) ** 2 +
        (r.argMin + h) -
        ((r.argMin - h) ** 4 - 3 * (r.argMin - h) ** 2 + (r.argMin - h))) /
      (2 * h);
    expect(slope).toBeCloseTo(0, 5);
  });
});

describe('multivariate minimization (Rosenbrock)', () => {
  it('nelderMead converges near (1,1)', () => {
    const r = nelderMead(rosenbrock, [-1.2, 1], { maximumIterations: 1000 });
    expect(r.argMin[0]).toBeCloseTo(1, 2);
    expect(r.argMin[1]).toBeCloseTo(1, 2);
    expect(r.minimum).toBeLessThan(1e-4);
  });
  it('bfgs converges near (1,1)', () => {
    const r = bfgs(rosenbrock, [-1.2, 1], { maximumIterations: 500 });
    expect(r.argMin[0]).toBeCloseTo(1, 3);
    expect(r.argMin[1]).toBeCloseTo(1, 3);
  });
  it('bfgs solves a quadratic essentially exactly', () => {
    const f = (v: number[]) => (v[0]! - 2) ** 2 + 3 * (v[1]! + 1) ** 2;
    const r = bfgs(f, [0, 0]);
    expect(r.converged).toBe(true);
    expect(r.argMin[0]).toBeCloseTo(2, 6);
    expect(r.argMin[1]).toBeCloseTo(-1, 6);
  });
});

describe('Levenberg–Marquardt least squares', () => {
  it('recovers parameters of an exponential model', () => {
    const xs = [0, 1, 2, 3, 4, 5];
    const trueA = 2;
    const trueB = 0.5;
    const ys = xs.map((x) => trueA * Math.exp(trueB * x));
    const residuals = (p: number[]) => xs.map((x, i) => p[0]! * Math.exp(p[1]! * x) - ys[i]!);
    const r = levenbergMarquardt(residuals, [1, 1]);
    expect(r.converged).toBe(true);
    expect(r.parameters[0]).toBeCloseTo(trueA, 4);
    expect(r.parameters[1]).toBeCloseTo(trueB, 4);
    expect(r.residualNorm).toBeLessThan(1e-4);
  });
});
