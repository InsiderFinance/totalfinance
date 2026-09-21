/**
 * The public-surface manifest (alignment spec Law 1, P3.1a) — the SPINE.
 *
 * Every runtime value export of every scoped package is classified here: role (which result
 * grammar it must obey), where it is reachable (entrypoints), and whether it backs an MCP tool.
 * The conformance gate (`conformance.test.ts`) fails on any unclassified export, any stale entry,
 * any role violation (a facade without `.explain`, a flat kernel on a facade-package root), any
 * entrypoint that doesn't match the package.json exports map, and any MCP tool not backed by an
 * `mcp`-eligible entry.
 *
 * Scope note (deliberate, v1): the manifest governs the RUNTIME surface — functions, namespaces,
 * classes, schemas, constants. Type-only exports (interfaces, type aliases) are inventoried and
 * drift-gated by the API reports (`tools/api-report`), which already snapshot the full typed
 * surface per package; duplicating ~1,500 type entries here would add churn without adding a
 * gate. Units live in the type-level JSDoc and MCP schemas; determinism is declared here only
 * where it is NOT the default (Monte-Carlo/seeded paths).
 *
 * The JSON files under `tools/manifest/packages/` are SOURCE-CONTROLLED and hand-curated.
 * `pnpm manifest:update` regenerates the inventory skeleton from the live surface and MERGES it
 * with the curated files: new exports arrive as `role: "unclassified"` (which the gate fails
 * until a human classifies them), removed exports are dropped, and curated fields are preserved.
 */

/**
 * The four public roles (spec §Law 2) plus the operational kinds that also appear on package
 * roots. Every role implies a result grammar the conformance gate can check:
 *
 * - `facade`    — plain value; MUST expose `.explain()` returning the rich envelope.
 * - `analysis`  — rich `Computed`/report result on the primary call (calibration, optimization,
 *                 backtests, covariance); no `.explain` twin required.
 * - `artifact`  — factory returning an immutable domain object with versioned serialization
 *                 (contracts, positions, streams, surfaces).
 * - `kernel`    — lean numeric expert tier, documented IEEE-754 behavior. Never exported FLAT
 *                 from a facade-package root: reachable only via expert subpaths, namespaces
 *                 (the curated root surface), or the trusted-tier packages (core/math).
 * - `namespace` — a plain object grouping members (bs, engines, asian, legs, charts, …). The
 *                 MEMBERS carry the meaningful roles; the container is topology.
 * - `helper`    — supporting utilities that are neither of the four quant roles (adapters,
 *                 predicates, formatters, server/tool builders).
 * - `constant`  — versioned constants and frozen data (CONVENTIONS_VERSION, registries).
 * - `error`     — the typed error classes / error-code registries.
 * - `schema`    — runtime schema facades (payload validators with `toJSONSchema`).
 * - `unclassified` — generator-inserted; the gate FAILS while any of these remain.
 */
export type Role =
  | 'facade'
  | 'analysis'
  | 'artifact'
  | 'kernel'
  | 'namespace'
  | 'helper'
  | 'constant'
  | 'error'
  | 'schema'
  | 'unclassified';

export type ExportKind = 'function' | 'class' | 'object' | 'value';
export type InputPolicy = 'closed' | 'open' | 'passthrough';

export interface ExportEntry {
  /** Runtime kind, auto-detected by the generator. */
  kind: ExportKind;
  /** Hand-curated role — the result grammar this export must obey. */
  role: Role;
  /**
   * Entrypoint specifiers this export is reachable from, as exports-map keys of the owning
   * package: `"."` for the root, `"./svi"` etc. for subpaths. Auto-detected; the conformance
   * gate cross-checks each against package.json.
   */
  entrypoints: string[];
  /** Auto-detected: the callable exposes a `.explain` twin (required for `role: "facade"`). */
  hasExplain?: boolean;
  /** Auto-detected: the callable exposes `.stream`/`.fromJSON` (TA-style stream artifacts). */
  hasStream?: boolean;
  /**
   * Declared ONLY when results are not run-to-run deterministic by default: `"seeded"` means a
   * caller-provided seed makes it reproducible (Monte-Carlo tiers).
   */
  determinism?: 'seeded';
  /** This export is the library-side implementation backing one or more MCP tools. */
  mcpTools?: string[];
  /**
   * Analysis result grammar (Law 2, C4): `envelope` = `{ value, assumptions, diagnostics }`
   * (`Computed`); `report` = a domain-shaped rich object CARRYING `assumptions` + `diagnostics`
   * inline. Stamped from OBSERVED runtime results; the conformance gate executes fixtured
   * analysis exports and fails a shape mismatch.
   */
  shape?: 'envelope' | 'report';
  /**
   * Law 12 exemption: this input deliberately accepts foreign/superset keys (an adapter that owns
   * a passthrough schema). Curated, rare, and reviewed — the unknown-key sweep skips it.
   */
  passthrough?: boolean;
  /**
   * Per-object-argument strictness keyed by zero-based argument index. `closed` rejects unknown
   * control/config keys, `open` accepts structural artifact decoration, and `passthrough` owns a
   * foreign schema whose preservation semantics are tested by its adapter. Unspecified arguments
   * are closed. Structural artifacts must opt into `open` explicitly so adding a helper cannot
   * accidentally make an options object typo-tolerant.
   */
  inputPolicies?: Record<string, InputPolicy>;
  /**
   * `inputPolicies` for a CLASS entry's instance methods, keyed by method name then argument
   * index — the exports map only holds live export names, so `SqueezeCore#update`'s policy lives
   * on `SqueezeCore` (`{ update: { "0": "open" } }`). Same vocabulary and same explicit-opt-in
   * rule as `inputPolicies`.
   */
  methodInputPolicies?: Record<string, Record<string, InputPolicy>>;
  /** Why the declared input policy holds (C05 citations etc.) — kept next to the policy it explains. */
  policyNote?: string;
  /** Free-form curation note: why a role exception holds, migration intent, etc. */
  note?: string;
}

export interface PackageManifest {
  /** Full package name, e.g. `"@totalfinance/volatility"`. */
  package: string;
  /** Short domain key, e.g. `"vol"` — matches the umbrella namespace name. */
  domain: string;
  /**
   * `facade` packages are swept + role-gated. `trusted` packages (core/math) contain low-level
   * mathematical utilities: inventoried for drift, exempt from facade result-grammar sweeps, but
   * still covered by the compiler-backed signature gate.
   * `umbrella` / `integration` are structural packages (totalfinance, mcp).
   */
  tier: 'facade' | 'trusted' | 'umbrella' | 'integration';
  /**
   * Exports keyed by dotted path: a root export is `"rsi"`, a namespace member is `"blackScholes.price"`
   * (descent is recursive through plain-object namespaces).
   */
  exports: Record<string, ExportEntry>;
}

export const ROLES: readonly Role[] = [
  'facade',
  'analysis',
  'artifact',
  'kernel',
  'namespace',
  'helper',
  'constant',
  'error',
  'schema',
  'unclassified',
];

/** Structural validation of a parsed manifest file. Returns human-readable problems. */
export function validatePackageManifest(m: PackageManifest): string[] {
  const problems: string[] = [];
  if (!m.package?.length) problems.push('missing package');
  if (!m.domain?.length) problems.push('missing domain');
  if (!['facade', 'trusted', 'umbrella', 'integration'].includes(m.tier)) {
    problems.push(`bad tier "${m.tier}"`);
  }
  for (const [name, e] of Object.entries(m.exports ?? {})) {
    if (!ROLES.includes(e.role)) problems.push(`${name}: unknown role "${e.role}"`);
    if (!['function', 'class', 'object', 'value'].includes(e.kind)) {
      problems.push(`${name}: unknown kind "${e.kind}"`);
    }
    if (!Array.isArray(e.entrypoints) || e.entrypoints.length === 0) {
      problems.push(`${name}: no entrypoints`);
    }
    if (e.role === 'namespace' && e.kind !== 'object') {
      problems.push(`${name}: role "namespace" requires kind "object"`);
    }
    for (const [index, policy] of Object.entries(e.inputPolicies ?? {})) {
      if (!/^\d+$/.test(index))
        problems.push(`${name}: inputPolicies key "${index}" is not an index`);
      if (!['closed', 'open', 'passthrough'].includes(policy)) {
        problems.push(`${name}: unknown input policy "${policy}" at argument ${index}`);
      }
    }
  }
  return problems;
}
