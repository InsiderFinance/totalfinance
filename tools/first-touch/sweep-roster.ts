/**
 * The single source of truth for WHICH packages the runtime sweeps must cover.
 *
 * The garbage sweep and the deep sweep each carried their own hand-typed package roster, because
 * each needs static `import * as pkg` namespaces that cannot be built from a string list. Two hand
 * lists of the same thing rot independently, and they did: `@totalfinance/crypto` was added to the
 * garbage sweep and never to the deep sweep, so an entire facade package shipped with no
 * later-argument, partial-input, or envelope coverage — silently, because nothing compares the two
 * lists to anything.
 *
 * The namespaces still have to be imported by hand. What does NOT have to be is the DECISION about
 * which packages belong: that is derived here from `MANIFEST_TIERS` (the manifest's own tier map)
 * and asserted by both sweeps plus `tools/roster-conformance.test.ts`.
 *
 * The derivation is FAIL-CLOSED: a package directory that no one has classified is treated as
 * needing to be swept. Forgetting to register a new package therefore fails loudly, instead of
 * quietly exempting it from every runtime gate the repo has.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MANIFEST_TIERS } from '../manifest/inventory.js';

const PKG_DIR = fileURLToPath(new URL('../../packages', import.meta.url));

/** A workspace package directory and the package name its manifest declares. */
export interface PackageDirectory {
  /** Directory name under `packages/` — this is also the sweeps' roster key. */
  dir: string;
  /** The `name` field of its package.json (e.g. `@totalfinance/options`). */
  package: string;
}

/**
 * Directories deliberately absent from `MANIFEST_TIERS`. Each entry states WHY, because an
 * unexplained exception is indistinguishable from an oversight — which is how this class of gap
 * appears in the first place.
 */
export const TIER_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'totalfinance',
    'the umbrella re-export package: it introduces no implementation, so the manifest checks it ' +
      'structurally (entrypoints, bundle size, re-export identity) instead of re-classifying every ' +
      'symbol it forwards',
  ],
]);

/**
 * Facade packages deliberately NOT runtime-swept. Empty, and meant to stay that way — a facade that
 * cannot survive the garbage probes is a defect, not a configuration choice. Any entry must give a
 * reason, and removing one is the goal state.
 */
export const SWEEP_EXCLUSIONS: ReadonlyMap<string, string> = new Map([]);

/** Read every workspace package directory that declares a package name. */
export function readPackageDirectories(): PackageDirectory[] {
  const out: PackageDirectory[] = [];
  for (const dir of readdirSync(PKG_DIR).sort()) {
    let manifest: { name?: string };
    try {
      manifest = JSON.parse(readFileSync(`${PKG_DIR}/${dir}/package.json`, 'utf8')) as {
        name?: string;
      };
    } catch {
      continue;
    }
    if (!manifest.name) continue;
    out.push({ dir, package: manifest.name });
  }
  return out;
}

/**
 * Directories that are neither tiered nor a documented exception — i.e. packages nothing in the
 * gate machinery knows about.
 */
export function unclassifiedDirectories(
  dirs: readonly PackageDirectory[] = readPackageDirectories(),
): string[] {
  return dirs
    .filter((d) => !(d.package in MANIFEST_TIERS) && !TIER_EXCEPTIONS.has(d.dir))
    .map((d) => d.dir)
    .sort();
}

/**
 * The roster both runtime sweeps must cover, as directory names, sorted.
 *
 * `facade` packages are swept. `trusted` (`core`, `math` — the mathematical kernel tier) and
 * `integration` (`mcp`) are not, by tier. The umbrella is not, by documented exception. Anything
 * UNCLASSIFIED is swept, so a newly added package cannot slip through by being unknown.
 */
export function expectedSweptPackages(
  dirs: readonly PackageDirectory[] = readPackageDirectories(),
): string[] {
  return dirs
    .filter((d) => {
      if (SWEEP_EXCLUSIONS.has(d.dir)) return false;
      if (TIER_EXCEPTIONS.has(d.dir)) return false;
      const tier = MANIFEST_TIERS[d.package];
      return tier === undefined || tier === 'facade';
    })
    .map((d) => d.dir)
    .sort();
}
