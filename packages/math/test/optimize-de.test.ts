/**
 * Tests for differential evolution (§8.4): a seeded global optimizer. Verified on the multimodal
 * Rastrigin function (where local methods stall) and for deterministic reproducibility.
 */

import { describe, expect, it } from 'vitest';
import { differentialEvolution } from '@totalfinance/math';

const rastrigin = (x: number[]): number =>
  10 * x.length + x.reduce((s, xi) => s + xi * xi - 10 * Math.cos(2 * Math.PI * xi), 0);

describe('differentialEvolution', () => {
  it('finds the global minimum of the multimodal Rastrigin function', () => {
    const bounds: Array<[number, number]> = [
      [-5.12, 5.12],
      [-5.12, 5.12],
    ];
    const r = differentialEvolution(rastrigin, bounds, { seed: 1, maxGenerations: 500 });
    expect(r.minimum).toBeLessThan(1e-3); // global min is 0 at the origin
    expect(Math.abs(r.argMin[0]!)).toBeLessThan(0.05);
    expect(Math.abs(r.argMin[1]!)).toBeLessThan(0.05);
  });

  it('minimizes a simple sphere to the origin', () => {
    const sphere = (x: number[]): number => x.reduce((s, xi) => s + xi * xi, 0);
    const r = differentialEvolution(sphere, [
      [-10, 10],
      [-10, 10],
      [-10, 10],
    ]);
    expect(r.minimum).toBeLessThan(1e-6);
  });

  it('is deterministic given the seed', () => {
    const bounds: Array<[number, number]> = [
      [-5, 5],
      [-5, 5],
    ];
    const a = differentialEvolution(rastrigin, bounds, { seed: 42 });
    const b = differentialEvolution(rastrigin, bounds, { seed: 42 });
    expect(a.argMin).toEqual(b.argMin);
    expect(a.minimum).toBe(b.minimum);
  });

  it('rejects an inverted/non-finite bound', () => {
    expect(() => differentialEvolution(rastrigin, [[1, -1]])).toThrow(/bound/);
    expect(() => differentialEvolution(rastrigin, [[0, NaN]])).toThrow(/bound/);
  });
});
