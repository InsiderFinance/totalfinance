/**
 * Swaption cube — SABR-on-rates (`swaptionCube`, `swaptionCubeVolatility`). Per-node calibration recovers known
 * SABR parameters (smiles generated from them); a node-exact query reproduces that node's SABR vol; a
 * between-nodes query is bounded by its neighbors and interpolates the forward bilinearly; extrapolation
 * sets the flag + warning; a jagged node warns as a poor fit; and the grid / node / query guards hold.
 */

import { describe, expect, it } from 'vitest';
import {
  swaptionCube,
  swaptionCubeVolatility,
  type SwaptionCubeNode,
} from '@totalfinance/volatility';
import { type SabrParameters } from '@totalfinance/options';
import { sabrVolatility } from '@totalfinance/options/sabr';

const BETA = 0.5;
const KNOWN: Record<string, SabrParameters> = {
  '1|2': { alpha: 0.012, beta: BETA, rho: -0.25, nu: 0.45 },
  '1|10': { alpha: 0.011, beta: BETA, rho: -0.35, nu: 0.4 },
  '5|2': { alpha: 0.013, beta: BETA, rho: -0.2, nu: 0.35 },
  '5|10': { alpha: 0.01, beta: BETA, rho: -0.4, nu: 0.3 },
};
const OFFSETS = [-0.01, -0.005, 0, 0.005, 0.01];

/** Build a synthetic cube whose nodes' smiles come from the KNOWN SABR parameters (per-node forward). */
function buildNodes(
  forwardOf: (e: number, timeToExpiryYears: number) => number = () => 0.03,
): SwaptionCubeNode[] {
  return Object.entries(KNOWN).map(([k, p]) => {
    const [e, t] = k.split('|').map(Number) as [number, number];
    const forward = forwardOf(e, t);
    const strikes = OFFSETS.map((o) => forward + o);
    const volatilities = strikes.map((K) =>
      sabrVolatility({
        input: { forward, strike: K, timeToExpiryYears: e },
        parameters: p,
        options: { volatilityType: 'lognormal' },
      }),
    );
    return { expiryYears: e, tenorYears: t, forward, strikes, volatilities };
  });
}

/** The cube-wide displacement used by the shifted-SABR tests. */
const SHIFT = 0.02;
/**
 * Negative-rate nodes for shifted (displaced) SABR: forwards below zero, with market volatilities quoted the way
 * the market would — SABR evaluated on the *shifted* rates `forward + SHIFT` / `strike + SHIFT`, so a
 * `shift: SHIFT` cube must recover the KNOWN parameters exactly.
 */
function buildShiftedNodes(
  volatilityType: 'lognormal' | 'normal' = 'lognormal',
  forward = -0.005,
): SwaptionCubeNode[] {
  return Object.entries(KNOWN).map(([k, p]) => {
    const [e, t] = k.split('|').map(Number) as [number, number];
    const strikes = OFFSETS.map((o) => forward + o);
    const volatilities = strikes.map((K) =>
      sabrVolatility({
        input: { forward: forward + SHIFT, strike: K + SHIFT, timeToExpiryYears: e },
        parameters: p,
        options: { volatilityType },
      }),
    );
    return { expiryYears: e, tenorYears: t, forward, strikes, volatilities };
  });
}

describe('swaptionCube', () => {
  it('calibrates each node, recovering the known SABR parameters and the axes', () => {
    const cube = swaptionCube({ nodes: buildNodes(), beta: BETA });
    expect(cube.expiries).toEqual([1, 5]);
    expect(cube.tenors).toEqual([2, 10]);
    expect(cube.nodes).toHaveLength(4);
    expect(cube.diagnostics.converged).toBe(true);
    for (const n of cube.nodes) {
      const p = KNOWN[`${n.expiryYears}|${n.tenorYears}`]!;
      expect(n.parameters.alpha).toBeCloseTo(p.alpha, 5);
      expect(n.parameters.rho).toBeCloseTo(p.rho, 4);
      expect(n.parameters.nu).toBeCloseTo(p.nu, 4);
      expect(n.rmse).toBeLessThan(1e-6);
      // atmVolatility is the SABR vol at K = forward (the full Hagan ATM, not just the α/F^(1−β) leading term).
      expect(n.atmVolatility).toBeCloseTo(
        sabrVolatility({
          input: { forward: n.forward, strike: n.forward, timeToExpiryYears: n.expiryYears },
          parameters: n.parameters,
          options: {
            volatilityType: 'lognormal',
          },
        }),
        12,
      );
      // …and in the right neighborhood of the leading Hagan ATM approximation.
      expect(n.atmVolatility).toBeCloseTo(p.alpha / Math.pow(n.forward, 1 - BETA), 2);
    }
    // nodes sorted by (expiry, tenor)
    expect(cube.nodes.map((n) => `${n.expiryYears}|${n.tenorYears}`)).toEqual([
      '1|2',
      '1|10',
      '5|2',
      '5|10',
    ]);
  });

  it('honors a per-node beta override', () => {
    const nodes = buildNodes();
    nodes[0] = { ...nodes[0]!, beta: 0.9 };
    const cube = swaptionCube({ nodes, beta: BETA });
    const overridden = cube.nodes.find((n) => n.expiryYears === 1 && n.tenorYears === 2)!;
    expect(overridden.parameters.beta).toBe(0.9);
    expect(cube.nodes.find((n) => n.expiryYears === 5 && n.tenorYears === 2)!.parameters.beta).toBe(
      BETA,
    );
  });

  it('warns when a node smile does not fit SABR well', () => {
    const nodes = buildNodes();
    nodes[0] = { ...nodes[0]!, volatilities: [0.2, 0.02, 0.15, 0.03, 0.18] }; // jagged, unfittable
    const cube = swaptionCube({ nodes, beta: BETA });
    expect(
      cube.diagnostics.warnings.some((w) => w.code === 'volatility.swaption_node_poor_fit'),
    ).toBe(true);
  });

  it('passes maximumIterations/tolerance through and discloses a node that did not converge', () => {
    // maximumIterations: 1 starves the LM fit so it cannot converge on a real smile → poor-fit warning.
    const cube = swaptionCube({
      nodes: buildNodes(),
      beta: BETA,
      maximumIterations: 1,
      tolerance: 1e-15,
    });
    expect(cube.nodes.some((n) => !n.converged)).toBe(true);
    expect(cube.diagnostics.converged).toBe(false);
    expect(
      cube.diagnostics.warnings.some((w) => w.code === 'volatility.swaption_node_poor_fit'),
    ).toBe(true);
  });

  it('guards a non-rectangular grid, a duplicate node, a thin smile, and empty input', () => {
    expect(() => swaptionCube(undefined as never)).toThrowError();
    expect(() => swaptionCube({ nodes: [] })).toThrowError();
    expect(() => swaptionCube({ nodes: buildNodes().slice(0, 3) })).toThrowError(); // 3 nodes for a 2×2 grid
    expect(() =>
      swaptionCube({ nodes: [...buildNodes(), { ...buildNodes()[0]! }] }),
    ).toThrowError(); // 5 nodes
    // A *balanced* duplicate: dup (1,2), drop (5,10) — count still 4 = 2×2, so the dup check must catch it.
    const balancedDup = buildNodes();
    balancedDup[3] = { ...balancedDup[0]! };
    expect(() => swaptionCube({ nodes: balancedDup })).toThrowError();
    expect(() =>
      swaptionCube({
        nodes: [
          {
            expiryYears: 1,
            tenorYears: 2,
            forward: 0.03,
            strikes: [0.02, 0.03],
            volatilities: [0.1, 0.1],
          },
        ],
      }),
    ).toThrowError(); // < 3 strikes
  });
});

describe('swaptionCubeVolatility', () => {
  const cube = swaptionCube({ nodes: buildNodes(), beta: BETA });

  it('reproduces a node exactly and reports it as not extrapolated', () => {
    const node = cube.nodes.find((n) => n.expiryYears === 1 && n.tenorYears === 2)!;
    const direct = sabrVolatility({
      input: { forward: node.forward, strike: 0.035, timeToExpiryYears: 1 },
      parameters: node.parameters,
      options: {
        volatilityType: 'lognormal',
      },
    });
    const q = swaptionCubeVolatility({ cube, expiryYears: 1, tenorYears: 2, strike: 0.035 });
    expect(q.value).toBeCloseTo(direct, 12);
    expect(q.forward).toBeCloseTo(node.forward, 12);
    expect(q.extrapolated).toBe(false);
  });

  it('a between-nodes ATM query is bounded by the surrounding nodes (uniform forward)', () => {
    // Same forward at every node ⇒ strike = forward is the true ATM everywhere, so the interpolated
    // ATM vol must sit within the corner ATM volatilities.
    const q = swaptionCubeVolatility({ cube, expiryYears: 3, tenorYears: 6, strike: 0.03 });
    const atms = cube.nodes.map((n) => n.atmVolatility);
    expect(q.value).toBeGreaterThanOrEqual(Math.min(...atms) - 1e-9);
    expect(q.value).toBeLessThanOrEqual(Math.max(...atms) + 1e-9);
    expect(q.extrapolated).toBe(false);
  });

  it('interpolates the forward bilinearly (center query = mean of the four node forwards)', () => {
    const forwardOf = (e: number, timeToExpiryYears: number) =>
      0.03 + 0.001 * e + 0.0005 * timeToExpiryYears;
    const c = swaptionCube({ nodes: buildNodes(forwardOf), beta: BETA });
    const q = swaptionCubeVolatility({ cube: c, expiryYears: 3, tenorYears: 6, strike: 0.03 });
    const meanForward = c.nodes.reduce((s, n) => s + n.forward, 0) / 4; // (3,6) is the exact grid center
    expect(q.forward).toBeCloseTo(meanForward, 12);
    expect(q.extrapolated).toBe(false);
  });

  it('brackets an interior query on a ≥3-point axis (the forward search advances)', () => {
    // Every other test uses a 2×2 grid, where the bracket search never steps; a 3-expiry grid with a
    // query in the upper cell forces the linear forward-search to advance past the first interval.
    const p: SabrParameters = { alpha: 0.012, beta: BETA, rho: -0.25, nu: 0.45 };
    const nodes: SwaptionCubeNode[] = [];
    for (const e of [1, 3, 5]) {
      for (const t of [2, 10]) {
        const strikes = OFFSETS.map((o) => 0.03 + o);
        const volatilities = strikes.map((K) =>
          sabrVolatility({
            input: { forward: 0.03, strike: K, timeToExpiryYears: e },
            parameters: p,
            options: { volatilityType: 'lognormal' },
          }),
        );
        nodes.push({ expiryYears: e, tenorYears: t, forward: 0.03, strikes, volatilities });
      }
    }
    const c = swaptionCube({ nodes, beta: BETA });
    const q = swaptionCubeVolatility({ cube: c, expiryYears: 4, tenorYears: 6, strike: 0.03 }); // expiry 4 ∈ (3, 5)
    expect(q.extrapolated).toBe(false);
    expect(q.forward).toBeCloseTo(0.03, 12);
    expect(Number.isFinite(q.value)).toBe(true);
  });

  it('flags and warns on a query outside the grid (clamped to the edge)', () => {
    const q = swaptionCubeVolatility({ cube, expiryYears: 0.5, tenorYears: 20, strike: 0.03 });
    expect(q.extrapolated).toBe(true);
    expect(
      q.diagnostics.warnings.some((w) => w.code === 'volatility.swaption_cube_extrapolated'),
    ).toBe(true);
    // clamped to the corner node (1, 10): forward equals that node's forward.
    expect(q.forward).toBeCloseTo(
      cube.nodes.find((n) => n.expiryYears === 1 && n.tenorYears === 10)!.forward,
      12,
    );
  });

  it('guards a bad query, a missing cube, and non-positive coordinates', () => {
    expect(() => swaptionCubeVolatility(undefined as never)).toThrowError();
    expect(() =>
      swaptionCubeVolatility({ expiryYears: 1, tenorYears: 2, strike: 0.03 } as never),
    ).toThrowError(); // no cube
    expect(() =>
      swaptionCubeVolatility({ cube, expiryYears: -1, tenorYears: 2, strike: 0.03 }),
    ).toThrowError();
    expect(() =>
      swaptionCubeVolatility({ cube, expiryYears: 1, tenorYears: 2, strike: -0.01 }),
    ).toThrowError();
    expect(() =>
      swaptionCubeVolatility({ cube, expiryYears: 1, tenorYears: 0, strike: 0.03 }),
    ).toThrowError();
    // A structurally corrupted cube: non-array axes, and axes referencing an absent node.
    expect(() =>
      swaptionCubeVolatility({
        cube: { ...cube, expiries: null as never },
        expiryYears: 1,
        tenorYears: 2,
        strike: 0.03,
      }),
    ).toThrowError();
    expect(() =>
      swaptionCubeVolatility({
        cube: { ...cube, nodes: cube.nodes.slice(0, 3) },
        expiryYears: 3,
        tenorYears: 6,
        strike: 0.03,
      }),
    ).toThrowError(); // interior query needs the dropped 4th corner
  });
});

describe('swaptionCube — shifted (displaced) SABR', () => {
  it('shift = 0 is the classic cube, node-for-node (backward-compatible)', () => {
    const a = swaptionCube({ nodes: buildNodes(), beta: BETA });
    const b = swaptionCube({ nodes: buildNodes(), beta: BETA, shift: 0 });
    expect(a.shift).toBe(0);
    expect(b.shift).toBe(0);
    expect(b.assumptions.shift).toBe(0);
    expect(b.diagnostics.method).toBe('sabr-per-node'); // not the shifted label
    for (let i = 0; i < a.nodes.length; i++) {
      expect(b.nodes[i]!.atmVolatility).toBe(a.nodes[i]!.atmVolatility);
      expect(b.nodes[i]!.parameters).toEqual(a.nodes[i]!.parameters);
    }
  });

  it('calibrates a negative-rate cube and recovers the known SABR parameters', () => {
    const cube = swaptionCube({ nodes: buildShiftedNodes(), beta: BETA, shift: SHIFT });
    expect(cube.shift).toBe(SHIFT);
    expect(cube.assumptions.shift).toBe(SHIFT);
    expect(cube.diagnostics.method).toContain('shifted');
    expect(cube.diagnostics.converged).toBe(true);
    for (const n of cube.nodes) {
      const p = KNOWN[`${n.expiryYears}|${n.tenorYears}`]!;
      expect(n.forward).toBeLessThan(0); // the reported forward stays the real (negative) rate
      expect(n.parameters.alpha).toBeCloseTo(p.alpha, 5);
      expect(n.parameters.rho).toBeCloseTo(p.rho, 4);
      expect(n.parameters.nu).toBeCloseTo(p.nu, 4);
      expect(n.rmse).toBeLessThan(1e-6);
      // atmVolatility is the shifted-SABR vol at the shifted ATM (forward + shift), and finite.
      expect(n.atmVolatility).toBeCloseTo(
        sabrVolatility({
          input: {
            forward: n.forward + SHIFT,
            strike: n.forward + SHIFT,
            timeToExpiryYears: n.expiryYears,
          },
          parameters: n.parameters,
          options: {
            volatilityType: 'lognormal',
          },
        }),
        12,
      );
      expect(Number.isFinite(n.atmVolatility)).toBe(true);
    }
  });

  it('evaluates a shifted cube at a NEGATIVE strike, reproducing the node smile', () => {
    const cube = swaptionCube({ nodes: buildShiftedNodes(), beta: BETA, shift: SHIFT });
    const node = cube.nodes.find((n) => n.expiryYears === 1 && n.tenorYears === 2)!;
    const strike = node.forward - 0.005; // a negative absolute strike (−0.01)
    expect(strike).toBeLessThan(0);
    const direct = sabrVolatility({
      input: { forward: node.forward + SHIFT, strike: strike + SHIFT, timeToExpiryYears: 1 },
      parameters: node.parameters,
      options: { volatilityType: 'lognormal' },
    });
    const q = swaptionCubeVolatility({ cube, expiryYears: 1, tenorYears: 2, strike });
    expect(q.value).toBeCloseTo(direct, 12);
    expect(q.assumptions.shift).toBe(SHIFT);
    expect(q.extrapolated).toBe(false);
  });

  it('calibrates a negative-rate cube in the normal (Bachelier) convention too', () => {
    const cube = swaptionCube({
      nodes: buildShiftedNodes('normal'),
      beta: BETA,
      shift: SHIFT,
      volatilityType: 'normal',
    });
    expect(cube.volatilityType).toBe('normal');
    expect(cube.diagnostics.converged).toBe(true);
    expect(Math.max(...cube.nodes.map((n) => n.rmse))).toBeLessThan(1e-6);
  });

  it('defaults an unshifted (legacy, no `shift` field) cube to shift 0 on evaluation', () => {
    const cube = swaptionCube({ nodes: buildNodes(), beta: BETA });
    const legacy = { ...cube } as Partial<typeof cube>;
    delete legacy.shift; // a cube serialized before `shift` existed
    const q = swaptionCubeVolatility({
      cube: legacy as typeof cube,
      expiryYears: 1,
      tenorYears: 2,
      strike: 0.035,
    });
    expect(q.assumptions.shift).toBe(0);
    expect(Number.isFinite(q.value)).toBe(true);
  });

  it('guards the shift and its positivity requirement', () => {
    // shift must be ≥ 0 and finite
    expect(() => swaptionCube({ nodes: buildNodes(), beta: BETA, shift: -0.01 })).toThrowError();
    expect(() =>
      swaptionCube({ nodes: buildNodes(), beta: BETA, shift: Number.NaN }),
    ).toThrowError();
    // a shift too small to lift the negative forward above zero (−0.005 + 0.003 < 0)
    expect(() =>
      swaptionCube({ nodes: buildShiftedNodes(), beta: BETA, shift: 0.003 }),
    ).toThrowError();
    // forward + shift > 0 but a strike + shift ≤ 0 (forward 0.01 + 0.02 > 0; min strike −0.03 + 0.02 < 0)
    const spanNodes = buildNodes().map((n) => ({
      ...n,
      forward: 0.01,
      strikes: [-0.03, -0.01, 0.01, 0.03, 0.05],
    }));
    expect(() => swaptionCube({ nodes: spanNodes, beta: BETA, shift: 0.02 })).toThrowError();
    // evaluation strike guards: strike + shift ≤ 0, and a non-finite strike
    const cube = swaptionCube({ nodes: buildShiftedNodes(), beta: BETA, shift: SHIFT });
    expect(() =>
      swaptionCubeVolatility({ cube, expiryYears: 1, tenorYears: 2, strike: -0.05 }),
    ).toThrowError();
    expect(() =>
      swaptionCubeVolatility({ cube, expiryYears: 1, tenorYears: 2, strike: Number.NaN }),
    ).toThrowError();
  });
});
