/**
 * Runtime export inventory (spec P3.1a) — enumerate the LIVE public surface of every scoped
 * package by importing each exports-map entrypoint and walking its value exports.
 *
 * Under the conformance test (vitest) the specifiers resolve through the alias map to SOURCE;
 * under `pnpm manifest:update` (plain node/tsx) they resolve through package.json `exports` to
 * the BUILT dist. The manifest must match both — which also catches src↔dist skew.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ExportEntry, ExportKind } from './schema.js';

const PKG_DIR = fileURLToPath(new URL('../../packages', import.meta.url));

/** Packages the manifest classifies (the umbrella is checked structurally, not re-classified). */
export const MANIFEST_TIERS: Record<string, 'facade' | 'trusted' | 'integration'> = {
  '@totalfinance/backtest': 'facade',
  '@totalfinance/calendars': 'facade',
  '@totalfinance/commodities': 'facade',
  '@totalfinance/core': 'trusted',
  '@totalfinance/crypto': 'facade',
  '@totalfinance/fixed-income': 'facade',
  '@totalfinance/foreign-exchange': 'facade',
  // FC0 landed fundamentals as trusted (frozen contracts only); FC2 gives it a user-facing ratio
  // and score surface, so it takes the facade tier and the sweeps that come with it.
  '@totalfinance/fundamentals': 'facade',
  '@totalfinance/research': 'facade',
  '@totalfinance/valuation': 'facade',
  '@totalfinance/math': 'trusted',
  '@totalfinance/mcp': 'integration',
  // Stage 7A slice 3 (2026-09-03): the CLI's stores and job runner are an integration over the
  // workflows registry (node-only: files and worker threads), not a compute facade — same tier as MCP.
  '@totalfinance/cli': 'integration',
  // Stage 7A slice 5 (2026-09-03): the local HTTP transport — an integration over the registry, like MCP and the CLI.
  '@totalfinance/http': 'integration',
  '@totalfinance/options': 'facade',
  '@totalfinance/performance': 'facade',
  // FC7 (Stage 4.4): the event-derived ledger is a user-facing surface from its first slice.
  '@totalfinance/portfolio': 'facade',
  '@totalfinance/risk': 'facade',
  // Stage 4.4b: validated cross-domain scenario composition is a financial facade, not a kernel.
  '@totalfinance/scenarios': 'facade',
  '@totalfinance/strategy': 'facade',
  '@totalfinance/structure': 'facade',
  '@totalfinance/technical-analysis': 'facade',
  '@totalfinance/volatility': 'facade',
  // Stage 7A: the protocol-neutral operation registry is a user-facing composition surface (L5).
  '@totalfinance/workflows': 'facade',
};

export interface PackageEntrypoints {
  package: string;
  dir: string;
  /** exports-map keys (`"."`, `"./svi"`, …) — `./package.json` excluded. */
  entrypoints: string[];
}

export function packageEntrypoints(): PackageEntrypoints[] {
  const out: PackageEntrypoints[] = [];
  for (const dir of readdirSync(PKG_DIR).sort()) {
    let manifest: { name?: string; exports?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(`${PKG_DIR}/${dir}/package.json`, 'utf8')) as never;
    } catch {
      continue;
    }
    if (!manifest.name || !manifest.exports || !(manifest.name in MANIFEST_TIERS)) continue;
    out.push({
      package: manifest.name,
      dir,
      entrypoints: Object.keys(manifest.exports).filter((k) => k !== './package.json'),
    });
  }
  return out;
}

function kindOf(name: string, value: unknown): ExportKind {
  if (typeof value === 'function') {
    return /^[A-Z]/.test(name.split('.').pop() ?? name) ? 'class' : 'function';
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return 'object';
  return 'value';
}

/** A plain namespace object worth descending into (not a class instance, schema, or array). */
function isNamespaceObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

export type Inventory = Map<string, Omit<ExportEntry, 'role'>>;

function record(
  inv: Inventory,
  path: string,
  value: unknown,
  entrypoint: string,
  depth: number,
): void {
  const existing = inv.get(path);
  if (existing) {
    if (!existing.entrypoints.includes(entrypoint)) existing.entrypoints.push(entrypoint);
    return;
  }
  const kind = kindOf(path, value);
  const entry: Omit<ExportEntry, 'role'> = { kind, entrypoints: [entrypoint] };
  if (typeof value === 'function') {
    const fn = value as { explain?: unknown; stream?: unknown; fromJSON?: unknown };
    if (typeof fn.explain === 'function') entry.hasExplain = true;
    if (typeof fn.stream === 'function' || typeof fn.fromJSON === 'function') {
      entry.hasStream = true;
    }
  }
  inv.set(path, entry);
  // Descend into plain-object namespaces (blackScholes.price, asian.monteCarloPrice, charts.renko, …) — but only
  // when the object actually contains callables. Data-only records (the ErrorCode/WarningCode
  // registries, DEFAULT_GREEK_UNITS, holiday tables) are ONE constant entry, not one per key.
  // Depth 2 is the deepest real nesting; `.explain` twins are recorded as flags, not entries.
  if (depth < 2 && isNamespaceObject(value)) {
    const members = Object.entries(value);
    if (members.some(([, v]) => typeof v === 'function')) {
      for (const [k, v] of members) {
        record(inv, `${path}.${k}`, v, entrypoint, depth + 1);
      }
    }
  }
}

/**
 * Build the runtime inventory for one package: every value export of every entrypoint, keyed by
 * dotted path, with the entrypoints it is reachable from.
 */
export async function inventoryPackage(
  pkg: PackageEntrypoints,
  options: { built?: boolean } = {},
): Promise<Inventory> {
  const inv: Inventory = new Map();
  for (const ep of pkg.entrypoints) {
    const specifier = ep === '.' ? pkg.package : `${pkg.package}/${ep.slice(2)}`;
    // The standalone generator must resolve each package's own exports map, not a parent app's
    // installed package (which may intentionally be an older dogfooding tarball). Self-reference
    // also handles public subpaths whose names differ from their source filenames, such as FX/risk.
    // Vitest callers retain normal specifier imports so its source aliases check the live surface.
    const target = options.built
      ? pathToFileURL(createRequire(`${PKG_DIR}/${pkg.dir}/package.json`).resolve(specifier)).href
      : specifier;
    const mod = (await import(/* @vite-ignore */ target)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (name === 'default') continue;
      record(inv, name, value, ep, 0);
    }
  }
  return inv;
}
