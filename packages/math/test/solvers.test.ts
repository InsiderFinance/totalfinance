import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bisection, brent, findRoot } from '@totalfinance/math';

describe('brent', () => {
  it('finds sqrt(2) as a root of x^2 - 2', () => {
    const r = brent((x) => x * x - 2, 0, 2);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(Math.SQRT2, 12);
    expect(r.residual ?? 0).toBeLessThan(1e-10);
    expect(r.method).toBe('brent');
    expect(r.bracket?.[0]).toBeLessThanOrEqual(r.value);
    expect(r.bracket?.[1]).toBeGreaterThanOrEqual(r.value);
  });

  it('finds a transcendental root', () => {
    const r = brent((x) => Math.cos(x) - x, 0, 1);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(0.7390851332151607, 10);
  });

  it('reports non-convergence honestly when the bracket has no sign change', () => {
    const r = brent((x) => x * x + 1, -1, 1);
    expect(r.converged).toBe(false);
    expect(r.reason).toBe('no_sign_change');
    expect(Number.isNaN(r.value)).toBe(true);
  });
});

describe('bisection', () => {
  it('finds the same root as brent', () => {
    const r = bisection((x) => x * x - 2, 0, 2, { tolerance: 1e-12 });
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(Math.SQRT2, 9);
  });
});

describe('findRoot (hybrid)', () => {
  it('property: recovers a known root for monotone linear functions', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        (root, slope) => {
          // f(x) = slope * (x - root); bracket must straddle the root.
          const r = findRoot((x) => slope * (x - root), root - 25, root + 25);
          expect(r.converged).toBe(true);
          expect(r.value).toBeCloseTo(root, 6);
        },
      ),
    );
  });
});
