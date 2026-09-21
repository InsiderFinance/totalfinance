/**
 * WS1.7: iterative linear algebra and adaptive integration must report non-convergence instead of
 * returning silently-wrong results.
 *   - jacobiEigen: relative tolerance (scale-invariant) + throws when sweeps run out.
 *   - adaptiveSimpson: tolerance halved per level + throws on depth exhaustion; adaptiveSimpsonSafe
 *     returns diagnostics.
 */

import { describe, expect, it } from 'vitest';
import {
  adaptiveSimpson,
  adaptiveSimpsonSafe,
  jacobiEigen,
  nearestCorrelation,
} from '@totalfinance/math';

describe('jacobiEigen convergence (WS1.7)', () => {
  it('converges under a large scale factor via a RELATIVE tolerance', () => {
    // A = S · tridiag(2; 1) whose eigenvalues are S·{2−√2, 2, 2+√2}. An absolute 1e-14 tolerance is
    // unreachable at this scale; the relative tolerance recovers the eigenvalues exactly.
    const S = 1e10;
    const A = [
      [2 * S, 1 * S, 0],
      [1 * S, 2 * S, 1 * S],
      [0, 1 * S, 2 * S],
    ];
    const vals = [...jacobiEigen(A).values].sort((a, b) => a - b).map((v) => v / S);
    expect(vals[0]).toBeCloseTo(2 - Math.SQRT2, 6);
    expect(vals[1]).toBeCloseTo(2, 6);
    expect(vals[2]).toBeCloseTo(2 + Math.SQRT2, 6);
  });

  it('throws ConvergenceError when it cannot converge within maximumIterations', () => {
    const A = [
      [2, 1, 0.5],
      [1, 2, 1],
      [0.5, 1, 2],
    ];
    expect(() => jacobiEigen(A, { maximumIterations: 0 })).toThrow(/converge/i);
  });

  it('nearestCorrelation is unchanged for an already-valid correlation matrix (regression)', () => {
    const C = [
      [1, 0.3, 0.1],
      [0.3, 1, 0.2],
      [0.1, 0.2, 1],
    ];
    const out = nearestCorrelation(C);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) expect(out[i]![j]).toBeCloseTo(C[i]![j]!, 12);
  });
});

describe('adaptiveSimpson depth control (WS1.7)', () => {
  it('integrates a smooth function to tolerance (regression)', () => {
    expect(adaptiveSimpson((x) => x * x, 0, 1)).toBeCloseTo(1 / 3, 12);
  });

  const needle = (x: number): number => Math.exp(-((x / 1e-6) ** 2));

  it('throws integration.max_depth on a needle integrand with a tiny depth budget', () => {
    expect(() => adaptiveSimpson(needle, -1, 1, { maxDepth: 3 })).toThrow(/depth/i);
  });

  it('adaptiveSimpsonSafe reports non-convergence with diagnostics instead of throwing', () => {
    const r = adaptiveSimpsonSafe(needle, -1, 1, { maxDepth: 3 });
    expect(r.converged).toBe(false);
    expect(r.deepestLevel).toBeGreaterThan(0);
    expect(Number.isFinite(r.value)).toBe(true);
  });
});
