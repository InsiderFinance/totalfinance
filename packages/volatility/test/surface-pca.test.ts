/**
 * Volatility-surface PCA (`surfacePCA`). Verifies that the dominant modes of a synthetic level+slope+curvature
 * panel are recovered and labeled correctly, that variance-explained is decreasing and cumulates to 1,
 * that the factor scores reconstruct the changes (orthonormal-basis identity), that `gridPoints` orders
 * the shape labeling, `maxComponents` truncates, relative vs absolute, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { surfacePCA, surfacePcaScenarios } from '@totalfinance/volatility';

function normals(n: number, seed: number): number[] {
  let s = seed >>> 0;
  const u = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 0) / 2 ** 32;
  };
  return Array.from(
    { length: n },
    () => Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u()),
  );
}

const LEVEL = [1, 1, 1, 1, 1];
const SLOPE = [-2, -1, 0, 1, 2];
const CURV = [2, -1, -2, -1, 2];

/** A snapshot panel whose daily changes are a·level + b·slope + c·curvature (+ small noise). */
function syntheticPanel(T: number, seed: number): number[][] {
  const z = normals(T * 4, seed);
  const base = [0.2, 0.22, 0.25, 0.23, 0.21];
  const snaps: number[][] = [base];
  for (let t = 1; t < T; t++) {
    const a = 0.01 * z[t]!;
    const b = 0.005 * z[T + t]!;
    const c = 0.002 * z[2 * T + t]!;
    snaps.push(
      snaps[t - 1]!.map(
        (v, i) => v + a * LEVEL[i]! + b * SLOPE[i]! + c * CURV[i]! + 0.0004 * z[3 * T + t]!,
      ),
    );
  }
  return snaps;
}

describe('surfacePCA', () => {
  it('recovers and labels the level / slope / curvature modes in variance order', () => {
    const r = surfacePCA({
      snapshots: syntheticPanel(400, 3),
      gridPoints: [-0.2, -0.1, 0, 0.1, 0.2],
    });
    expect(r.observations).toBe(399);
    expect(r.gridSize).toBe(5);
    expect(r.modes[0]!.shape).toBe('level');
    expect(r.modes[1]!.shape).toBe('slope');
    expect(r.modes[2]!.shape).toBe('curvature');
    // Variance explained is non-increasing.
    for (let k = 1; k < r.modes.length; k++) {
      expect(r.modes[k]!.varianceExplained).toBeLessThanOrEqual(r.modes[k - 1]!.varianceExplained);
    }
    expect(r.modes[0]!.varianceExplained).toBeGreaterThan(0.4); // level dominates
    // All modes cumulate to ~1.
    expect(r.cumulativeVarianceExplained[r.modes.length - 1]!).toBeCloseTo(1, 8);
    // A level mode's loadings are all one sign; a slope mode's span both.
    expect(r.modes[0]!.loadings.every((x) => x > 0)).toBe(true);
    expect(Math.min(...r.modes[1]!.loadings)).toBeLessThan(0);
    expect(Math.max(...r.modes[1]!.loadings)).toBeGreaterThan(0);
  });

  it('the factor scores reconstruct the centered changes (orthonormal-basis identity)', () => {
    const snaps = syntheticPanel(120, 9);
    const r = surfacePCA({ snapshots: snaps }); // all modes kept
    const G = 5;
    const T = snaps.length;
    // Independently rebuild the centered change at t=1 (change index 0).
    const changes = Array.from({ length: T - 1 }, (_, t) =>
      snaps[t + 1]!.map((v, i) => v - snaps[t]![i]!),
    );
    const mean = Array(G).fill(0) as number[];
    for (const c of changes) for (let i = 0; i < G; i++) mean[i]! += c[i]! / changes.length;
    const centered0 = changes[0]!.map((v, i) => v - mean[i]!);
    // Reconstruct from Σ_k score_{k,0}·loadings_k.
    const recon = Array(G).fill(0) as number[];
    for (const m of r.modes) for (let i = 0; i < G; i++) recon[i]! += m.scores[0]! * m.loadings[i]!;
    for (let i = 0; i < G; i++) expect(recon[i]).toBeCloseTo(centered0[i]!, 10);
  });

  it('gridPoints order the shape labeling — a scrambled-column slope still reads as slope', () => {
    // Grid points in a scrambled column order; the pure-slope shape follows the (true) moneyness order.
    const grid = [0, 0.2, -0.2, 0.1, -0.1];
    const slopeAtGrid = grid.map((g) => g * 10); // monotone in moneyness ⇒ a slope
    const z = normals(600, 4);
    const snaps: number[][] = [[0.2, 0.2, 0.2, 0.2, 0.2]];
    for (let t = 1; t < 200; t++) {
      const a = 0.01 * z[t]!;
      snaps.push(snaps[t - 1]!.map((v, i) => v + a * slopeAtGrid[i]! + 0.0002 * z[300 + t]!));
    }
    const withGrid = surfacePCA({ snapshots: snaps, gridPoints: grid });
    const noGrid = surfacePCA({ snapshots: snaps });
    expect(withGrid.modes[0]!.shape).toBe('slope'); // ordered by moneyness ⇒ monotone
    expect(noGrid.modes[0]!.shape).not.toBe('slope'); // column order is scrambled ⇒ not a clean tilt
  });

  it('relative changes are supported and maxComponents truncates', () => {
    const snaps = syntheticPanel(100, 7);
    const rel = surfacePCA({ snapshots: snaps, changes: 'relative' });
    expect(rel.changeType).toBe('relative');
    expect(rel.modes.length).toBe(5);
    const trunc = surfacePCA({ snapshots: snaps, maxComponents: 2 });
    expect(trunc.modes.length).toBe(2);
    expect(trunc.cumulativeVarianceExplained.length).toBe(2);
  });

  it('a single change (2 snapshots) degrades gracefully to a zero-variance decomposition', () => {
    // One observation has no dispersion: the centered change is zero, so every mode explains 0%.
    const r = surfacePCA({
      snapshots: [
        [0.2, 0.22, 0.25],
        [0.21, 0.22, 0.24],
      ],
    });
    expect(r.observations).toBe(1);
    expect(r.totalVariance).toBeCloseTo(0, 12);
    expect(r.modes.every((m) => m.varianceExplained === 0)).toBe(true);
    expect(r.modes.every((m) => m.loadings.every((x) => Number.isFinite(x)))).toBe(true);
  });

  it('guards malformed panels', () => {
    expect(() => surfacePCA(undefined as never)).toThrowError();
    expect(() => surfacePCA({ snapshots: [[0.2, 0.2, 0.2]] })).toThrowError(); // < 2 snapshots
    expect(() => surfacePCA({ snapshots: [[0.2], [0.21]] })).toThrowError(); // < 2 grid points
    expect(() =>
      surfacePCA({
        snapshots: [
          [0.2, 0.2],
          [0.21, 0.22, 0.23],
        ],
      }),
    ).toThrowError(); // ragged
    expect(() =>
      surfacePCA({
        snapshots: [
          [0.2, 0.2],
          [0.21, Number.NaN],
        ],
      }),
    ).toThrowError(); // non-finite
    expect(() =>
      surfacePCA({ snapshots: syntheticPanel(10, 1), changes: 'bogus' as never }),
    ).toThrowError();
    expect(() => surfacePCA({ snapshots: syntheticPanel(10, 1), maxComponents: 0 })).toThrowError();
    expect(() =>
      surfacePCA({
        snapshots: [
          [0, 0.2],
          [0.1, 0.21],
        ],
        changes: 'relative',
      }),
    ).toThrowError(); // relative with a zero prior vol
    expect(() =>
      surfacePCA({ snapshots: syntheticPanel(10, 1), gridPoints: [0, 1, 2] }),
    ).toThrowError(); // gridPoints length ≠ grid size
  });
});

describe('surfacePcaScenarios', () => {
  const pca = surfacePCA({
    snapshots: syntheticPanel(400, 7),
    gridPoints: [0.9, 0.95, 1.0, 1.05, 1.1],
  });
  const base = [0.2, 0.22, 0.25, 0.23, 0.21];
  const sd = (m: number) => Math.sqrt(Math.max(0, pca.modes[m]!.eigenvalue));

  it('each shock vector is exactly sigma·√λ·loadings, and shockedSurface = base + shock (floored)', () => {
    const r = surfacePcaScenarios({ pca, base, sigmas: [-2, 1] });
    expect(r.scenarios).toHaveLength(pca.modes.length * 2); // modes × sigmas
    for (const s of r.scenarios) {
      const load = pca.modes[s.mode]!.loadings;
      for (let i = 0; i < base.length; i++) {
        expect(s.shockVector[i]).toBeCloseTo(s.sigma * sd(s.mode) * load[i]!, 12);
        expect(s.shockedSurface[i]).toBeCloseTo(Math.max(0, base[i]! + s.shockVector[i]!), 12);
      }
    }
  });

  it('a +1σ move along the level mode raises every grid vol; the shock norm is √λ', () => {
    const r = surfacePcaScenarios({ pca, base, sigmas: [1] });
    const level = r.scenarios.find((s) => s.shape === 'level' && s.sigma === 1)!;
    for (let i = 0; i < base.length; i++) expect(level.shockedSurface[i]).toBeGreaterThan(base[i]!);
    // ‖sigma·√λ·loadings‖ = |sigma|·√λ (loadings are unit-norm).
    const norm = Math.sqrt(level.shockVector.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(sd(level.mode), 10);
  });

  it('floors the shocked volatilities so a large downside shock cannot go negative', () => {
    const r = surfacePcaScenarios({ pca, base, sigmas: [-100], floor: 0 });
    for (const s of r.scenarios) {
      for (const v of s.shockedSurface) expect(v).toBeGreaterThanOrEqual(0);
    }
    // A custom positive floor clamps there instead.
    const rf = surfacePcaScenarios({ pca, base, sigmas: [-100], floor: 0.05 });
    for (const v of rf.scenarios[0]!.shockedSurface) expect(v).toBeGreaterThanOrEqual(0.05);
  });

  it('combines independent per-mode moves into one surface (= the summed shocks)', () => {
    const combined = [1, -1]; // +1σ mode 0, −1σ mode 1
    const r = surfacePcaScenarios({ pca, base, combined });
    expect(r.combinedSurface).toBeDefined();
    for (let i = 0; i < base.length; i++) {
      const expected =
        base[i]! + 1 * sd(0) * pca.modes[0]!.loadings[i]! + -1 * sd(1) * pca.modes[1]!.loadings[i]!;
      expect(r.combinedSurface![i]).toBeCloseTo(Math.max(0, expected), 12);
    }
    // No combined field when the input omits it.
    expect(surfacePcaScenarios({ pca, base }).combinedSurface).toBeUndefined();
  });

  it('defaults to ±1σ and honors maxModes and the echoed changeType', () => {
    const r = surfacePcaScenarios({ pca, base, maxModes: 2 });
    expect(r.scenarios.map((s) => s.sigma)).toContain(-1);
    expect(r.scenarios.map((s) => s.sigma)).toContain(1);
    expect(new Set(r.scenarios.map((s) => s.mode)).size).toBe(2); // only the top 2 modes
    expect(r.assumptions.changeType).toBe('absolute');
  });

  it('guards a bad input, a modeless pca, a base/grid mismatch, a bad maxModes, and an over-long combined', () => {
    expect(() => surfacePcaScenarios(undefined as never)).toThrowError();
    expect(() => surfacePcaScenarios({ pca: {} as never, base })).toThrowError();
    expect(() => surfacePcaScenarios({ pca: { modes: [] } as never, base })).toThrowError(); // no modes
    expect(() => surfacePcaScenarios({ pca, base: [] })).toThrowError(); // empty base
    expect(() => surfacePcaScenarios({ pca, base: [0.2, 0.2] })).toThrowError(); // wrong length
    expect(() => surfacePcaScenarios({ pca, base, maxModes: 0 })).toThrowError();
    expect(() => surfacePcaScenarios({ pca, base, sigmas: [Number.NaN] })).toThrowError();
    expect(() =>
      surfacePcaScenarios({ pca, base, combined: [1, 1, 1, 1, 1, 1, 1, 1] }),
    ).toThrowError(); // more entries than modes
  });
});
