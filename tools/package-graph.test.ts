import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package-graph dependency law (Wave 6 §2A). The workspace `@totalfinance/*` runtime dependency graph
 * must be a DAG whose edges point *down* the layer model — never a cycle, never a strictly-higher
 * tier. A back-edge (e.g. re-introducing `@totalfinance/risk` → `@totalfinance/strategy` while
 * `@totalfinance/strategy` → `@totalfinance/risk`) is exactly the failure this ratchet catches.
 *
 * Scope: `dependencies` only. `devDependencies` (e.g. a package's tests building a real object from a
 * higher-layer package) are test-time and never a build edge, so they are intentionally ignored — the
 * fine-grained permanent layer law is owned later by the platform spine (implementation-order §3.1);
 * this guard installs the cycle + coarse-tier half now.
 */

const PKG_DIR = fileURLToPath(new URL('../packages', import.meta.url));
const MANIFEST_DIR = fileURLToPath(new URL('./manifest/packages', import.meta.url));

/** Coarse layer ranks from the package manifests' `tier`. Edges must not climb this order. */
const TIER_RANK: Record<string, number> = { trusted: 0, facade: 1, integration: 2 };

interface PackageNode {
  name: string;
  /** `@totalfinance/*` runtime dependencies (build edges). */
  deps: string[];
  tier: string | undefined;
}

function loadTiers(): Map<string, string> {
  const tiers = new Map<string, string>();
  for (const file of readdirSync(MANIFEST_DIR)) {
    if (!file.endsWith('.json')) continue;
    const m = JSON.parse(readFileSync(`${MANIFEST_DIR}/${file}`, 'utf8')) as {
      package?: string;
      tier?: string;
    };
    if (m.package && m.tier) tiers.set(m.package, m.tier);
  }
  return tiers;
}

function loadGraph(): Map<string, PackageNode> {
  const tiers = loadTiers();
  const graph = new Map<string, PackageNode>();
  for (const dir of readdirSync(PKG_DIR).sort()) {
    let pkg: { name?: string; dependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(`${PKG_DIR}/${dir}/package.json`, 'utf8'));
    } catch {
      continue;
    }
    if (!pkg.name) continue;
    const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@totalfinance/'));
    graph.set(pkg.name, { name: pkg.name, deps, tier: tiers.get(pkg.name) });
  }
  return graph;
}

function adjacency(graph: Map<string, PackageNode>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const [name, node] of graph) adj.set(name, node.deps);
  return adj;
}

/** Return the first cycle (as a node path `a → … → a`) in the directed graph, or `null` if acyclic. */
function findCycle(adj: Map<string, string[]>): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of adj.keys()) color.set(n, WHITE);
  const stack: string[] = [];
  let cycle: string[] | null = null;

  const dfs = (u: string): boolean => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (!adj.has(v)) continue; // an edge to a package outside the workspace graph
      const c = color.get(v);
      if (c === GRAY) {
        cycle = [...stack.slice(stack.indexOf(v)), v];
        return true;
      }
      if (c === WHITE && dfs(v)) return true;
    }
    stack.pop();
    color.set(u, BLACK);
    return false;
  };

  for (const n of adj.keys()) {
    if (color.get(n) === WHITE && dfs(n)) break;
  }
  return cycle;
}

describe('package-graph dependency law (Wave 6 §2A)', () => {
  const graph = loadGraph();

  it('discovers every workspace package with a tier', () => {
    expect(graph.size).toBeGreaterThanOrEqual(14);
    const untiered = [...graph.values()].filter((n) => n.tier === undefined).map((n) => n.name);
    // The umbrella `totalfinance` may be untiered; every scoped compute package must declare a tier.
    expect(untiered.filter((n) => n !== 'totalfinance')).toEqual([]);
  });

  it('the @totalfinance runtime dependency graph is acyclic', () => {
    const cycle = findCycle(adjacency(graph));
    expect(cycle, cycle ? `dependency cycle: ${cycle.join(' → ')}` : undefined).toBeNull();
  });

  it('no package depends on a strictly higher tier (edges point down the layer model)', () => {
    const violations: string[] = [];
    for (const node of graph.values()) {
      const from = node.tier === undefined ? undefined : TIER_RANK[node.tier];
      if (from === undefined) continue;
      for (const dep of node.deps) {
        const depTier = graph.get(dep)?.tier;
        const to = depTier === undefined ? undefined : TIER_RANK[depTier];
        if (to !== undefined && to > from) {
          violations.push(`${node.name} (${node.tier}) → ${dep} (${depTier})`);
        }
      }
    }
    expect(violations, `upward tier edges:\n${violations.join('\n')}`).toEqual([]);
  });

  it('risk no longer depends on strategy (2A decoupling) so strategy → risk stays acyclic', () => {
    expect(graph.get('@totalfinance/risk')?.deps ?? []).not.toContain('@totalfinance/strategy');
  });

  it('the cycle detector flags a synthetic reverse edge (guard proof)', () => {
    // The real graph is acyclic...
    const adj = adjacency(graph);
    expect(findCycle(adj)).toBeNull();
    // ...but reinstating risk → strategy on top of a (future) strategy → risk edge is a cycle.
    const poisoned = new Map([...adj].map(([k, v]) => [k, [...v]]));
    poisoned.get('@totalfinance/strategy')!.push('@totalfinance/risk'); // the intended 2B edge
    poisoned.get('@totalfinance/risk')!.push('@totalfinance/strategy'); // the forbidden reverse edge
    const cycle = findCycle(poisoned);
    expect(cycle).not.toBeNull();
    expect(cycle).toContain('@totalfinance/risk');
    expect(cycle).toContain('@totalfinance/strategy');
  });
});

describe('FC0 required dependency graph (Stage 4 activation)', () => {
  const graph = loadGraph();
  /**
   * `A → B` means A MAY depend on B — the settled Stage 4 ownership graph from the core
   * capability spec, installed BEFORE scaffolding so every future package lands under the law.
   * A package listed here may depend only on core, math, and its listed edges; packages not yet
   * created are pre-declared so their first slice cannot invent an edge.
   */
  const FC0_ALLOWED: Record<string, readonly string[]> = {
    '@totalfinance/fundamentals': ['@totalfinance/core', '@totalfinance/math'],
    '@totalfinance/valuation': [
      '@totalfinance/core',
      '@totalfinance/math',
      '@totalfinance/calendars',
      '@totalfinance/fundamentals',
    ],
    '@totalfinance/research': [
      '@totalfinance/core',
      '@totalfinance/math',
      '@totalfinance/performance',
      '@totalfinance/fundamentals',
      '@totalfinance/valuation',
    ],
    '@totalfinance/performance': [
      '@totalfinance/core',
      '@totalfinance/math',
      '@totalfinance/valuation',
    ],
    '@totalfinance/foreign-exchange': [
      '@totalfinance/core',
      '@totalfinance/math',
      '@totalfinance/calendars',
    ],
    '@totalfinance/commodities': [
      '@totalfinance/core',
      '@totalfinance/math',
      '@totalfinance/calendars',
    ],
    '@totalfinance/portfolio': ['@totalfinance/core', '@totalfinance/performance'],
    '@totalfinance/scenarios': [
      '@totalfinance/core',
      '@totalfinance/foreign-exchange',
      '@totalfinance/portfolio',
      '@totalfinance/risk',
    ],
    // Stage 4.6 (FC8, 2026-09-03): the ownership row `backtest → portfolio; focused subpaths may
    // also depend on research, options, strategy, risk, calendars, and performance` — ratified as a
    // matrix row instead of an implicit allowance. `scenarios` is deliberately absent: portfolio
    // limits in the simulators go through @totalfinance/risk. September R05 adds fixed-income so the
    // bond adapter consumes the calendar/day-count owner rather than a second accrual formula.
    '@totalfinance/backtest': [
      '@totalfinance/core',
      '@totalfinance/math',
      '@totalfinance/calendars',
      '@totalfinance/fixed-income',
      '@totalfinance/options',
      '@totalfinance/performance',
      '@totalfinance/portfolio',
      '@totalfinance/research',
      '@totalfinance/risk',
      '@totalfinance/strategy',
    ],
  };
  /** Explicitly forbidden edges — each direction named, per the FC0 exit gate. */
  const FC0_FORBIDDEN: readonly (readonly [string, string])[] = [
    ['@totalfinance/portfolio', '@totalfinance/risk'],
    ['@totalfinance/risk', '@totalfinance/portfolio'],
    ['@totalfinance/research', '@totalfinance/backtest'],
  ];

  it('every FC0-governed package uses only its allowed edges', () => {
    const violations: string[] = [];
    for (const [name, allowed] of Object.entries(FC0_ALLOWED)) {
      const node = graph.get(name);
      if (!node) continue; // not yet created — the matrix pre-declares it
      for (const dep of node.deps) {
        if (!allowed.includes(dep)) violations.push(`${name} → ${dep}`);
      }
    }
    expect(violations, `edges outside the FC0 ownership graph:\n${violations.join('\n')}`).toEqual(
      [],
    );
  });

  it('the named forbidden edges do not exist in either direction', () => {
    const present = FC0_FORBIDDEN.filter(([from, to]) => graph.get(from)?.deps.includes(to)).map(
      ([from, to]) => `${from} → ${to}`,
    );
    expect(present, `forbidden edges present:\n${present.join('\n')}`).toEqual([]);
  });

  it('fundamentals exists, is tiered, and depends only downward (the FC0 first slice landed)', () => {
    const node = graph.get('@totalfinance/fundamentals');
    expect(node).toBeDefined();
    // FC0 landed the package 'trusted' (frozen contracts only); FC2 gave it the user-facing ratio
    // and score surface, so it takes the facade tier and both first-touch sweeps with it.
    expect(node!.tier).toBe('facade');
    expect(node!.deps).toEqual(['@totalfinance/core']);
  });

  it('no compute package depends on a data/provider/transport package', () => {
    // No such package exists in the workspace yet; the law is encoded so the first one that
    // appears cannot be imported by compute code. The name conventions it will use:
    const DATA_EDGE = /@totalfinance\/(data|providers?|adapters?|http|cli)(-|$)/;
    const violations: string[] = [];
    for (const node of graph.values()) {
      for (const dep of node.deps) {
        if (DATA_EDGE.test(dep)) violations.push(`${node.name} → ${dep}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('Gate A platform constitution — future edge packages (roadmap laws #3 and #7)', () => {
  const graph = loadGraph();

  /**
   * The platform's future EDGE packages, pre-declared under the FC0 precedent: `A → B` means A MAY
   * depend on B, a package listed here may depend only on its listed edges, and none of them exists
   * yet — so its first slice cannot invent an edge. Creating one under different edges is a
   * REVIEWED change to this matrix, not an accident.
   *
   * The names encode the roadmap's layer diagram: data providers normalize + carry provenance into
   * L3/L4 inputs; `@totalfinance/workflows` is the L5 connected-analysis layer; `@totalfinance/http` /
   * `@totalfinance/cli` are L6 transports beside the existing `@totalfinance/mcp`. Rows are deliberately
   * TIGHT (e.g. `data` gets the domain-contract packages it normalizes into, not the whole
   * workspace); widening one is a decision this file exists to make visible.
   */
  const GATE_A_ALLOWED: Record<string, readonly string[]> = {
    // Edge data providers (roadmap: "Data providers ──normalize + provenance──▶ L3/L4 inputs").
    // Contracts and conventions only — a provider package must not compute.
    '@totalfinance/data': [
      '@totalfinance/core',
      '@totalfinance/calendars',
      '@totalfinance/options',
      '@totalfinance/fixed-income',
      '@totalfinance/crypto',
      '@totalfinance/foreign-exchange',
      '@totalfinance/commodities',
      '@totalfinance/fundamentals',
    ],
    // L5 workflows: acquire, normalize, compute, save, compare, monitor — over the compositions and
    // everything below them, plus the data edge. NEVER a transport (mcp/http/cli) and never the
    // umbrella.
    '@totalfinance/workflows': [
      '@totalfinance/core',
      '@totalfinance/math',
      '@totalfinance/calendars',
      '@totalfinance/options',
      '@totalfinance/volatility',
      '@totalfinance/fixed-income',
      '@totalfinance/foreign-exchange',
      '@totalfinance/commodities',
      '@totalfinance/crypto',
      '@totalfinance/technical-analysis',
      '@totalfinance/fundamentals',
      '@totalfinance/valuation',
      '@totalfinance/performance',
      '@totalfinance/risk',
      '@totalfinance/strategy',
      '@totalfinance/structure',
      '@totalfinance/backtest',
      '@totalfinance/research',
      '@totalfinance/scenarios',
      // Reviewed widening (Stage 7A, 2026-09-03): the durable portfolio ledger (FC7) landed after
      // this row was written; the portfolio journey operations compose it — an L4 composition, in
      // the row's own law.
      '@totalfinance/portfolio',
      '@totalfinance/data',
    ],
    // L6 transports/experiences "may depend on all of them" (law #3) — compute, workflows, and the
    // data edge, but never each other.
    '@totalfinance/http': [
      '@totalfinance/core',
      '@totalfinance/math',
      '@totalfinance/calendars',
      '@totalfinance/options',
      '@totalfinance/volatility',
      '@totalfinance/fixed-income',
      '@totalfinance/foreign-exchange',
      '@totalfinance/commodities',
      '@totalfinance/crypto',
      '@totalfinance/technical-analysis',
      '@totalfinance/fundamentals',
      '@totalfinance/valuation',
      '@totalfinance/performance',
      '@totalfinance/risk',
      '@totalfinance/strategy',
      '@totalfinance/structure',
      '@totalfinance/backtest',
      '@totalfinance/research',
      '@totalfinance/scenarios',
      '@totalfinance/data',
      '@totalfinance/workflows',
    ],
    '@totalfinance/cli': [
      '@totalfinance/core',
      '@totalfinance/math',
      '@totalfinance/calendars',
      '@totalfinance/options',
      '@totalfinance/volatility',
      '@totalfinance/fixed-income',
      '@totalfinance/foreign-exchange',
      '@totalfinance/commodities',
      '@totalfinance/crypto',
      '@totalfinance/technical-analysis',
      '@totalfinance/fundamentals',
      '@totalfinance/valuation',
      '@totalfinance/performance',
      '@totalfinance/risk',
      '@totalfinance/strategy',
      '@totalfinance/structure',
      '@totalfinance/backtest',
      '@totalfinance/research',
      '@totalfinance/scenarios',
      '@totalfinance/data',
      '@totalfinance/workflows',
    ],
  };

  /**
   * The one EXISTING edge package, held to the same row discipline: the MCP transport may reach any
   * compute package and (once they exist) workflows and data — never http/cli/the umbrella.
   */
  const MCP_ALLOWED: readonly string[] = [
    '@totalfinance/core',
    '@totalfinance/math',
    '@totalfinance/calendars',
    '@totalfinance/options',
    '@totalfinance/volatility',
    '@totalfinance/fixed-income',
    '@totalfinance/foreign-exchange',
    '@totalfinance/commodities',
    '@totalfinance/crypto',
    '@totalfinance/technical-analysis',
    '@totalfinance/fundamentals',
    '@totalfinance/valuation',
    '@totalfinance/performance',
    '@totalfinance/risk',
    '@totalfinance/strategy',
    '@totalfinance/structure',
    '@totalfinance/backtest',
    '@totalfinance/research',
    '@totalfinance/scenarios',
    '@totalfinance/data',
    '@totalfinance/workflows',
  ];

  /**
   * LAW (roadmap law #3 sentence 2 + law #7, explicit effects): compute packages never depend on
   * provider, transport, UI, or credential packages. Pure calculation must not be able to silently
   * fetch, choose a credentialed service, or grow a transport. The regex is the naming convention
   * those edge packages will use — broadened from the FC0 guard above with transports/ui/apps/
   * credentials/secrets.
   */
  const EDGE_PACKAGE =
    /@totalfinance\/(data|providers?|adapters?|transports?|http|cli|ui|apps?|credentials?|secrets?)(-|$)/;

  /** The non-compute residents: their own rows govern them, the compute law does not. */
  const NON_COMPUTE = new Set(['@totalfinance/mcp', ...Object.keys(GATE_A_ALLOWED)]);

  function computeToEdgeViolations(g: Map<string, PackageNode>): string[] {
    const violations: string[] = [];
    for (const node of g.values()) {
      if (NON_COMPUTE.has(node.name)) continue;
      for (const dep of node.deps) {
        if (EDGE_PACKAGE.test(dep)) violations.push(`${node.name} → ${dep}`);
      }
    }
    return violations;
  }

  /**
   * LAW (roadmap law #3 sentence 1): workflows may depend on compositions — never the reverse.
   * Only a transport may sit above `@totalfinance/workflows`.
   */
  function workflowReverseViolations(g: Map<string, PackageNode>): string[] {
    const TRANSPORTS = new Set(['@totalfinance/mcp', '@totalfinance/http', '@totalfinance/cli']);
    const violations: string[] = [];
    for (const node of g.values()) {
      if (TRANSPORTS.has(node.name)) continue;
      if (node.deps.includes('@totalfinance/workflows')) {
        violations.push(`${node.name} → @totalfinance/workflows`);
      }
    }
    return violations;
  }

  it('every Gate-A-governed future package uses only its pre-declared edges', () => {
    const violations: string[] = [];
    for (const [name, allowed] of Object.entries(GATE_A_ALLOWED)) {
      const node = graph.get(name);
      if (!node) continue; // not yet created — the matrix pre-declares it
      for (const dep of node.deps) {
        if (!allowed.includes(dep)) violations.push(`${name} → ${dep}`);
      }
    }
    expect(violations, `edges outside the Gate A edge matrix:\n${violations.join('\n')}`).toEqual(
      [],
    );
  });

  it('mcp (the existing transport) stays inside its row', () => {
    const node = graph.get('@totalfinance/mcp');
    expect(node).toBeDefined();
    const outside = node!.deps.filter((dep) => !MCP_ALLOWED.includes(dep));
    expect(outside, `mcp edges outside its row:\n${outside.join('\n')}`).toEqual([]);
  });

  it('LAW: no compute package depends on a provider/transport/UI/credential package', () => {
    expect(computeToEdgeViolations(graph)).toEqual([]);
  });

  it('the compute-to-edge law flags a synthetic provider edge (guard proof)', () => {
    // The forbidden names do not exist yet, so the pass above must be proven non-vacuous: poison a
    // copied graph with the exact edge the law forbids and require the checker to name it.
    const poisoned = new Map<string, PackageNode>(
      [...graph].map(([k, v]) => [k, { ...v, deps: [...v.deps] }]),
    );
    poisoned.get('@totalfinance/strategy')!.deps.push('@totalfinance/data');
    poisoned.get('@totalfinance/options')!.deps.push('@totalfinance/data-polygon');
    expect(computeToEdgeViolations(poisoned)).toEqual([
      '@totalfinance/options → @totalfinance/data-polygon',
      '@totalfinance/strategy → @totalfinance/data',
    ]);
  });

  it('LAW: workflows may depend on compositions, never the reverse', () => {
    // The allowed direction is a row in the matrix (workflows → strategy/backtest/…); the forbidden
    // direction must be empty in the real graph…
    expect(GATE_A_ALLOWED['@totalfinance/workflows']).toContain('@totalfinance/strategy');
    expect(GATE_A_ALLOWED['@totalfinance/workflows']).toContain('@totalfinance/backtest');
    expect(workflowReverseViolations(graph)).toEqual([]);
  });

  it('the workflow-direction law flags a synthetic reverse edge (guard proof)', () => {
    const poisoned = new Map<string, PackageNode>(
      [...graph].map(([k, v]) => [k, { ...v, deps: [...v.deps] }]),
    );
    poisoned.get('@totalfinance/strategy')!.deps.push('@totalfinance/workflows'); // composition → workflow
    expect(workflowReverseViolations(poisoned)).toEqual([
      '@totalfinance/strategy → @totalfinance/workflows',
    ]);
  });
});
