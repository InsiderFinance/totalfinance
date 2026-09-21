/**
 * `pnpm manifest:update` — regenerate the manifest skeletons from the LIVE surface and merge
 * with the hand-curated files (spec P3.1a).
 *
 * Merge rules:
 *   - new export → inserted with an INFERRED role where safe (`.explain` twin ⇒ facade,
 *     `*Schema` object ⇒ schema, `*Error` class ⇒ error, UPPER_SNAKE value ⇒ constant,
 *     plain-object container ⇒ namespace), else `"unclassified"` — which the conformance gate
 *     fails until a human classifies it;
 *   - removed export → dropped (reported);
 *   - existing export → curated fields (`role`, `mcpTools`, `determinism`, `note`) are
 *     PRESERVED; auto-detected fields (`kind`, `entrypoints`, `hasExplain`, `hasStream`) are
 *     refreshed from the live surface.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MANIFEST_TIERS, inventoryPackage, packageEntrypoints } from './inventory.js';
import type { ExportEntry, PackageManifest, Role } from './schema.js';

const OUT_DIR = fileURLToPath(new URL('./packages', import.meta.url));

export function manifestPathFor(domain: string): string {
  return `${OUT_DIR}/${domain}.json`;
}

export function readManifest(domain: string): PackageManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPathFor(domain), 'utf8')) as PackageManifest;
  } catch {
    return null;
  }
}

function inferRole(name: string, e: Omit<ExportEntry, 'role'>): Role {
  const leaf = name.split('.').pop() ?? name;
  if (e.kind === 'function' && e.hasExplain) return 'facade';
  if (e.kind === 'class') return /Error$/.test(leaf) ? 'error' : 'artifact';
  if (e.kind === 'object' && /Schema$/.test(leaf)) return 'schema';
  if (e.kind === 'object') return 'namespace';
  if (e.kind === 'value' && /^[A-Z0-9_]+$/.test(leaf)) return 'constant';
  return 'unclassified';
}

export async function generateManifests(): Promise<
  { domain: string; added: string[]; removed: string[] }[]
> {
  const report: { domain: string; added: string[]; removed: string[] }[] = [];
  for (const pkg of packageEntrypoints()) {
    const domain = pkg.dir;
    const inv = await inventoryPackage(pkg, { built: true });
    const prior = readManifest(domain);
    const exports: Record<string, ExportEntry> = {};
    const added: string[] = [];
    for (const [name, live] of [...inv.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const curated = prior?.exports[name];
      if (curated) {
        exports[name] = {
          ...live,
          role: curated.role,
          ...(curated.mcpTools ? { mcpTools: curated.mcpTools } : {}),
          ...(curated.determinism ? { determinism: curated.determinism } : {}),
          ...(curated.shape ? { shape: curated.shape } : {}),
          ...(curated.passthrough ? { passthrough: curated.passthrough } : {}),
          ...(curated.inputPolicies ? { inputPolicies: curated.inputPolicies } : {}),
          ...(curated.methodInputPolicies
            ? { methodInputPolicies: curated.methodInputPolicies }
            : {}),
          ...(curated.policyNote ? { policyNote: curated.policyNote } : {}),
          ...(curated.note ? { note: curated.note } : {}),
        };
      } else {
        exports[name] = { ...live, role: inferRole(name, live) };
        added.push(name);
      }
    }
    const removed = prior ? Object.keys(prior.exports).filter((n) => !inv.has(n)) : [];
    const manifest: PackageManifest = {
      package: pkg.package,
      domain,
      tier: MANIFEST_TIERS[pkg.package]!,
      exports,
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(manifestPathFor(domain), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    report.push({ domain, added, removed });
  }
  return report;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const report = await generateManifests();
  for (const r of report) {
    const bits = [
      r.added.length ? `+${r.added.length} new` : '',
      r.removed.length ? `-${r.removed.length} removed (${r.removed.join(', ')})` : '',
    ]
      .filter(Boolean)
      .join(', ');
    console.log(`manifest: ${r.domain}${bits ? ` — ${bits}` : ' — up to date'}`);
  }
}
