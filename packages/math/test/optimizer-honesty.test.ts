/**
 * WS1.17: the local optimizers must report a non-finite objective as converged:false / reason
 * 'non_finite' (they had ZERO finiteness checks — a NaN corrupted the simplex sort / comparisons and
 * returned converged:true). differentialEvolution throws InputError on bad bounds and reports
 * max_iterations; findRoot reports the truthful 'bracket+brent' method and combined iteration count.
 */

import { describe, expect, it } from 'vitest';
import {
  brentMin,
  differentialEvolution,
  findRoot,
  goldenSectionMin,
  nelderMead,
} from '@totalfinance/math';

describe('local optimizers report non-finite objectives honestly (WS1.17)', () => {
  it('goldenSectionMin: a NaN objective is not reported as converged', () => {
    const r = goldenSectionMin(() => NaN, 0, 5);
    expect(r.converged).toBe(false);
    expect(r.reason).toBe('non_finite');
  });

  it('brentMin: a NaN objective is not reported as converged', () => {
    const r = brentMin(() => NaN, 0, 5);
    expect(r.converged).toBe(false);
    expect(r.reason).toBe('non_finite');
  });

  it('nelderMead: a NaN objective does not corrupt the simplex sort into converged:true', () => {
    const r = nelderMead(() => NaN, [0, 0]);
    expect(r.converged).toBe(false);
    expect(r.reason).toBe('non_finite');
  });

  it('NaN-free objectives still converge and carry an evaluation count (regression)', () => {
    const g = goldenSectionMin((x) => (x - 2) ** 2, 0, 5);
    expect(g.converged).toBe(true);
    expect(g.argMin).toBeCloseTo(2, 4);
    expect(g.evaluations).toBeGreaterThan(0);

    const nm = nelderMead((x) => (x[0]! - 1) ** 2 + (x[1]! + 2) ** 2, [0, 0]);
    expect(nm.converged).toBe(true);
    expect(nm.argMin[0]).toBeCloseTo(1, 3);
    expect(nm.argMin[1]).toBeCloseTo(-2, 3);
  });
});

describe('differentialEvolution honesty (WS1.17)', () => {
  it('throws InputError (optimize.invalid_bounds) on an inverted bound', () => {
    expect(() => differentialEvolution((x) => x[0]!, [[1, 0]])).toThrow(/invalid bound/);
  });

  it('reports max_iterations when the generation budget is exhausted', () => {
    const r = differentialEvolution((x) => x[0]! * x[0]!, [[-5, 5]], {
      maxGenerations: 2,
      tolerance: 0,
    });
    expect(r.converged).toBe(false);
    expect(r.reason).toBe('max_iterations');
  });
});

describe('findRoot reports the method and iterations truthfully (WS1.17)', () => {
  const f = (x: number): number => x - 5; // root at 5

  it('a bracket that needs expansion reports bracket+brent and includes the expansion steps', () => {
    const r = findRoot(f, 0, 1); // [0,1] does not straddle 5
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(5, 9);
    expect(r.method).toBe('bracket+brent');
    expect(r.iterations).toBeGreaterThan(0);
  });

  it('a bracket that already straddles the root runs plain Brent', () => {
    const r = findRoot(f, 0, 10);
    expect(r.converged).toBe(true);
    expect(r.value).toBeCloseTo(5, 9);
    expect(r.method).not.toBe('bracket+brent'); // no expansion needed
  });
});

describe('differentialEvolution echoes its seed (WS2.1)', () => {
  // a simple bowl with the minimum at (1, -2)
  const bowl = (x: number[]): number => (x[0]! - 1) ** 2 + (x[1]! + 2) ** 2;
  const bounds: ReadonlyArray<readonly [number, number]> = [
    [-5, 5],
    [-5, 5],
  ];

  it('echoes the seed actually used', () => {
    const r = differentialEvolution(bowl, bounds, { seed: 4242, maxGenerations: 60 });
    expect(r.seed).toBe(4242);
  });

  it('echoes the default seed when none is supplied', () => {
    const r = differentialEvolution(bowl, bounds, { maxGenerations: 20 });
    expect(r.seed).toBe(0x5eed);
  });

  it('same seed → identical search (reproducible)', () => {
    const a = differentialEvolution(bowl, bounds, { seed: 7, maxGenerations: 40 });
    const b = differentialEvolution(bowl, bounds, { seed: 7, maxGenerations: 40 });
    expect(b).toEqual(a);
  });
});
