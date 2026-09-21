import { describe, expect, it } from 'vitest';
import {
  type Derivatives,
  bracketExpand,
  brent,
  findRoot,
  halley,
  householder,
  newton,
  ridder,
  secant,
  solveAll,
} from '@totalfinance/math';

const sqrt2Fn = (x: number): number => x * x - 2;
const sqrt2Deriv = (x: number): Derivatives => ({ f: x * x - 2, df: 2 * x, d2f: 2, d3f: 0 });

describe('bracketing solvers find √2', () => {
  it('ridder', () => {
    const r = ridder(sqrt2Fn, 0, 2);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(Math.SQRT2, 10);
  });
  it('accepts reversed brackets', () => {
    const r = brent(sqrt2Fn, 2, 0);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(Math.SQRT2, 10);
  });
});

describe('open & derivative solvers find √2', () => {
  it('secant', () => {
    expect(secant(sqrt2Fn, 1, 2).value).toBeCloseTo(Math.SQRT2, 10);
  });
  it('newton', () => {
    const r = newton(sqrt2Deriv, 2);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(Math.SQRT2, 12);
  });
  it('halley converges in very few iterations', () => {
    const r = halley(sqrt2Deriv, 2);
    expect(r.value).toBeCloseTo(Math.SQRT2, 12);
    expect(r.iterations).toBeLessThanOrEqual(6);
  });
  it('householder converges in very few iterations', () => {
    const r = householder(sqrt2Deriv, 2);
    expect(r.value).toBeCloseTo(Math.SQRT2, 12);
    expect(r.iterations).toBeLessThanOrEqual(5);
  });
});

describe('honest failure diagnostics', () => {
  it('typed no_sign_change', () => {
    const r = brent((x) => x * x + 1, -1, 1);
    expect(r.converged).toBe(false);
    expect(r.reason).toBe('no_sign_change');
  });
  it('newton reports zero_derivative', () => {
    // df = 0 at x = 0 for f = x^3 (also f = 0), but seed away so derivative hits 0 first.
    const r = newton((x) => ({ f: x * x + 1, df: 2 * x }), 0);
    expect(r.converged).toBe(false);
    expect(r.reason).toBe('zero_derivative');
  });
  it('non-finite endpoint detected', () => {
    const r = brent((x) => (x < 0 ? NaN : x - 1), -1, 2);
    expect(r.reason).toBe('non_finite_endpoint');
  });
});

describe('bracket expansion', () => {
  it('expands to capture a sign change', () => {
    const b = bracketExpand((x) => x - 100, 0, 1);
    expect(b.found).toBe(true);
    expect(b.objectiveAtLowerBound * b.objectiveAtUpperBound).toBeLessThan(0);
  });
  it('findRoot auto-expands when the initial bracket has no sign change', () => {
    const r = findRoot((x) => x - 100, 0, 1);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(100, 8);
  });
});

describe('batch root solving', () => {
  it('returns one diagnostic-carrying result per row', () => {
    const results = solveAll([
      { objective: (x) => x - 1, lowerBound: 0, upperBound: 2 },
      { objective: (x) => x - 5, lowerBound: 0, upperBound: 10 },
      { objective: (x) => x * x + 1, lowerBound: -1, upperBound: 1 }, // no root
    ]);
    expect(results[0]!.value).toBeCloseTo(1, 9);
    expect(results[1]!.value).toBeCloseTo(5, 9);
    expect(results[2]!.converged).toBe(false);
    expect(results[2]!.reason).toBe('no_sign_change');
  });
});
