import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Gate A ratification — the permanent seven-layer model made executable (platform roadmap, "The
 * permanent layer model" + architecture law #3, downward-only).
 *
 * Every workspace package is assigned an EXPLICIT layer below, and every declared runtime workspace
 * dependency must point to a same-or-lower layer. This is the fine-grained half of the dependency
 * law whose coarse tier/cycle half `package-graph.test.ts` installed in Wave 6 §2A — that file
 * remains the historical §2A/FC0 record; the layer table lives here because it IS the Gate A
 * artifact being ratified.
 *
 * Two properties make this a live gate rather than a passing one:
 *   1. the assignment is EXHAUSTIVE both ways — a new package fails until someone places it
 *      deliberately, and a deleted package fails until its row is retired;
 *   2. the checker is guard-proofed against a synthetic upward edge, so "no violations" is a
 *      measured result, not a vacuous one.
 *
 * The layer numbers are the roadmap's: L1 numerical core, L2 model kernels, L3 domain API (facades,
 * contracts, pricers), L4 compositions, L5 workflows (none exist yet), L6 experiences/transports.
 * L0 is language data and has no package. A package that contains both kernels and facades is placed
 * at the TOP layer its public surface occupies (its kernels are interior floors of the same
 * building), which is why the kernel-bearing domain packages sit at L3.
 */

const PKG_DIR = fileURLToPath(new URL('../packages', import.meta.url));

interface LayerAssignment {
  /** 1–6 per the roadmap diagram. */
  layer: number;
  /** Why the package sits there — printed when an edge violates the law. */
  reason: string;
}

/**
 * The ratified layer table (Gate A DECISION — review me deliberately, not incidentally).
 *
 * Dependencies may point sideways or down this table, never up.
 */
const LAYERS: Record<string, LayerAssignment> = {
  // ---- L1 · numerical core: small, deterministic building blocks everything trusts ----
  '@totalfinance/core': {
    layer: 1,
    reason: 'error taxonomy, invariants, conventions, contract types — the trusted foundation',
  },
  '@totalfinance/math': {
    layer: 1,
    reason: 'distributions, solvers, interpolation, linalg, RNG — the roadmap’s named L1 row',
  },

  // ---- L2 · model kernels: direct formula/convention machinery with no market-state facade ----
  '@totalfinance/calendars': {
    layer: 2,
    reason: 'session/day-count conventions consumed as kernels by the domain packages above',
  },

  // ---- L3 · domain API: kernels + validated facades, contracts, typed results ----
  '@totalfinance/options': {
    layer: 3,
    reason: 'BSM/Black-76/lattice/MC kernels (L2 floors) under the validated facades and pro API',
  },
  '@totalfinance/volatility': {
    layer: 3,
    reason: 'SVI/SSVI/SABR surface kernels under fitting/analytics facades',
  },
  '@totalfinance/fixed-income': {
    layer: 3,
    reason: 'curve/bond/rate-model kernels under pricing facades',
  },
  '@totalfinance/foreign-exchange': {
    layer: 3,
    reason: 'spot/forward/exposure facades over calendar conventions',
  },
  '@totalfinance/commodities': {
    layer: 3,
    reason: 'cost-of-carry forward and term-structure facades over core conventions',
  },
  '@totalfinance/crypto': {
    layer: 3,
    reason: 'perpetual/inverse/carry facades over core contracts',
  },
  '@totalfinance/technical-analysis': {
    layer: 3,
    reason: 'indicator kernels (a named L2 family) under the registry/pipeline/framework facade',
  },
  '@totalfinance/fundamentals': {
    layer: 3,
    reason: 'statement contracts plus the ratio/score facade surface',
  },
  '@totalfinance/valuation': {
    layer: 3,
    reason: 'cash-flow/corporate valuation facades over fundamentals’ statements',
  },
  '@totalfinance/performance': {
    layer: 3,
    reason: 'return/drawdown/ratio measurement — a domain API over series, not a composition',
  },

  // ---- L4 · compositions: many related calculations with one coherent state ----
  '@totalfinance/risk': {
    layer: 4,
    reason: 'VaR/scenario/portfolio compositions over options pricing and performance',
  },
  '@totalfinance/strategy': {
    layer: 4,
    reason: 'multi-leg positions composing option pricing, probability, and risk',
  },
  '@totalfinance/structure': {
    layer: 4,
    reason: 'chain/exposure structure analytics composing options pricing',
  },
  '@totalfinance/backtest': {
    layer: 4,
    reason: 'event/vectorized engines composing strategy, risk, performance, and options',
  },
  '@totalfinance/research': {
    layer: 4,
    reason:
      'point-in-time factor/screening/event studies composing fundamentals, valuation, and ' +
      'performance (compute-only research; provider-CONNECTED research runs are the future L5)',
  },
  '@totalfinance/portfolio': {
    layer: 4,
    reason:
      'the FC7 event-derived ledger: one coherent durable state (events → lots/cash/positions) ' +
      'composing the performance domain API — the FC0 row allows exactly core + performance, and ' +
      'the risk edge is forbidden in BOTH directions (package-graph FC0_FORBIDDEN)',
  },
  '@totalfinance/scenarios': {
    layer: 4,
    reason:
      'cross-domain scenario composition over core pricing contracts, risk attribution, FX conversion, and durable portfolio state',
  },

  // ---- L5 · workflows: none exist yet (pre-declared in package-graph.test.ts, Gate A block) ----

  // ---- L5 · workflows: protocol-neutral operations composed over the domain API ----
  '@totalfinance/workflows': {
    layer: 5,
    reason:
      'Stage 7A: the operation registry and runtime every transport adapts — compositions of public ' +
      'functions with effect metadata, never a kernel, never a transport',
  },

  // ---- L6 · experiences/transports: deliver the platform, never extend its math ----
  '@totalfinance/mcp': {
    layer: 6,
    reason: 'MCP transport/experience over the engine — the roadmap places MCP at L6',
  },
  '@totalfinance/http': {
    layer: 6,
    reason:
      'the local HTTP transport (OpenAPI 3.1, the loopback read-only server, the totalfinance-http binary) — ' +
      'an L6 experience beside MCP and the CLI; it never extends the math (Stage 7A)',
  },
  '@totalfinance/cli': {
    layer: 6,
    reason:
      'the local CLI transport (file stores, worker-terminated job runner, the totalfinance binary) — ' +
      'an L6 experience beside MCP; it never extends the math (Stage 7A)',
  },
  totalfinance: {
    layer: 6,
    reason:
      'the umbrella distribution shell: not compute, re-exports every lower layer to consumers, ' +
      'so it sits at the top and nothing below may import it',
  },
};

interface PackageNode {
  name: string;
  /** Workspace runtime dependencies (`@totalfinance/*` and the bare umbrella). */
  deps: string[];
}

function loadGraph(): Map<string, PackageNode> {
  const graph = new Map<string, PackageNode>();
  for (const dir of readdirSync(PKG_DIR).sort()) {
    let pkg: { name?: string; dependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(`${PKG_DIR}/${dir}/package.json`, 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name) continue;
    const deps = Object.keys(pkg.dependencies ?? {}).filter(
      (d) => d.startsWith('@totalfinance/') || d === 'totalfinance',
    );
    graph.set(pkg.name, { name: pkg.name, deps });
  }
  return graph;
}

/** Every edge that points STRICTLY UP the layer table, named `from (Ln) → to (Lm)`. */
function upwardEdges(graph: Map<string, PackageNode>): string[] {
  const violations: string[] = [];
  for (const node of graph.values()) {
    const from = LAYERS[node.name];
    if (!from) continue; // exhaustiveness is asserted separately
    for (const dep of node.deps) {
      const to = LAYERS[dep];
      if (to && to.layer > from.layer) {
        violations.push(
          `${node.name} (L${from.layer}: ${from.reason}) → ${dep} (L${to.layer}: ${to.reason})`,
        );
      }
    }
  }
  return violations;
}

describe('Gate A layer model (roadmap "The permanent layer model" + law #3)', () => {
  const graph = loadGraph();

  it('assigns every workspace package a layer, and carries no stale rows', () => {
    const onDisk = [...graph.keys()].sort();
    const assigned = Object.keys(LAYERS).sort();
    // Both directions in ONE comparison so the failure names the exact drift: a package present on
    // disk but absent here must be PLACED (a deliberate Gate A decision), and a row whose package is
    // gone must be retired.
    expect(onDisk).toEqual(assigned);
  });

  it('uses only the roadmap layers L1–L6', () => {
    for (const [name, { layer }] of Object.entries(LAYERS)) {
      expect(Number.isInteger(layer) && layer >= 1 && layer <= 6, `${name}: L${layer}`).toBe(true);
    }
  });

  it('keeps the ratified anchors: core/math are the L1 foundation, mcp the L6 transport', () => {
    // These rows are the fixed points the rest of the table is argued from; moving one is a
    // constitution change, not a refactor.
    expect(LAYERS['@totalfinance/core']!.layer).toBe(1);
    expect(LAYERS['@totalfinance/math']!.layer).toBe(1);
    expect(LAYERS['@totalfinance/mcp']!.layer).toBe(6);
  });

  it('every declared workspace dependency points to a same-or-lower layer (downward-only law #3)', () => {
    const violations = upwardEdges(graph);
    expect(violations, `upward layer edges:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the checker flags a synthetic upward edge (guard proof — no vacuous pass)', () => {
    const poisoned = new Map<string, PackageNode>(
      [...graph].map(([k, v]) => [k, { ...v, deps: [...v.deps] }]),
    );
    // An L1 foundation reaching into an L4 composition is exactly the inversion the law forbids.
    poisoned.get('@totalfinance/math')!.deps.push('@totalfinance/strategy');
    const violations = upwardEdges(poisoned);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('@totalfinance/math (L1');
    expect(violations[0]).toContain('@totalfinance/strategy (L4');
  });
});
