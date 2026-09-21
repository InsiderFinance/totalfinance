/**
 * The roster perimeter: no package directory can ship without being gated.
 *
 * The repo has three hand-maintained package rosters — the manifest's `MANIFEST_TIERS`, the garbage
 * sweep's `PACKAGES`, and the deep sweep's `PACKAGES`. Nothing compared them to each other or to
 * the filesystem, so they drifted: `@totalfinance/crypto` reached the garbage sweep and never the deep
 * sweep, and an entire facade package ran for releases with no later-argument, partial-input, or
 * envelope coverage. The failure mode is the dangerous one — silence. Adding a package and simply
 * forgetting a roster produced a green build.
 *
 * This test closes the perimeter three ways:
 *
 *   1. every `packages/*` directory is classified — in `MANIFEST_TIERS`, or in the DOCUMENTED
 *      `TIER_EXCEPTIONS` (the umbrella today);
 *   2. both sweep rosters equal the derived expectation — the facade tier minus the documented
 *      `SWEEP_EXCLUSIONS` (empty), read out of the sweep sources so this holds even if someone
 *      deletes the in-sweep guard;
 *   3. the derivation is FAIL-CLOSED, proven by simulation: an unregistered package directory is
 *      reported as unclassified AND is required in the sweep roster, so it fails all three checks
 *      rather than being silently exempt.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MANIFEST_TIERS } from './manifest/inventory.js';
import {
  SWEEP_EXCLUSIONS,
  TIER_EXCEPTIONS,
  type PackageDirectory,
  expectedSweptPackages,
  readPackageDirectories,
  unclassifiedDirectories,
} from './first-touch/sweep-roster.js';

/**
 * Extract the `PACKAGES` roster keys from a sweep's SOURCE.
 *
 * Reading the source (rather than importing the module) is deliberate: importing a `*.test.ts` from
 * another test file re-registers its entire suite. The roster is a flat object literal of
 * `key: namespace` pairs, so the keys are recoverable exactly, and a malformed read fails loudly
 * below rather than silently matching an empty list.
 */
function sweepRoster(relativePath: string): string[] {
  const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
  const match = /const PACKAGES: Record<string, Record<string, unknown>> = \{([\s\S]*?)\n\};/.exec(
    source,
  );
  if (!match) throw new Error(`${relativePath}: could not find the PACKAGES roster literal`);
  const keys = [...match[1]!.matchAll(/^\s*'?([A-Za-z][A-Za-z0-9-]*)'?\s*:/gm)].map((m) => m[1]!);
  if (keys.length === 0) throw new Error(`${relativePath}: PACKAGES roster parsed as empty`);
  return keys.sort();
}

const SWEEPS = [
  { name: 'garbage sweep', path: './first-touch/garbage-sweep.test.ts' },
  { name: 'deep sweep', path: './first-touch/deep-sweep.test.ts' },
] as const;

describe('roster conformance — every package is gated, or documented as an exception', () => {
  const directories = readPackageDirectories();

  it('finds the workspace packages at all (the checks below are not vacuous)', () => {
    expect(directories.length).toBeGreaterThanOrEqual(14);
    expect(directories.map((d) => d.package)).toContain('@totalfinance/crypto');
  });

  it('every packages/* directory is tiered by the manifest or a documented exception', () => {
    const unclassified = unclassifiedDirectories(directories);
    expect(
      unclassified,
      `packages/* directories nothing knows about: ${unclassified.join(', ')}\n` +
        'Add each to MANIFEST_TIERS in tools/manifest/inventory.ts (facade / trusted / integration), ' +
        'or — only with a written reason — to TIER_EXCEPTIONS in tools/first-touch/sweep-roster.ts.',
    ).toEqual([]);
    // Exceptions must be real directories, and must each carry a reason.
    for (const [dir, reason] of TIER_EXCEPTIONS) {
      expect(
        directories.some((d) => d.dir === dir),
        `TIER_EXCEPTIONS lists "${dir}", which is not a package directory — delist it.`,
      ).toBe(true);
      expect(reason.length, `TIER_EXCEPTIONS["${dir}"] needs a reason`).toBeGreaterThan(20);
    }
  });

  it('the sweep exclusion list is empty (a facade that cannot be swept is a defect)', () => {
    // Documented and deliberately unused: an entry here silently removes a package from the
    // runtime gates, so it must be a decision someone writes down, not a default.
    expect([...SWEEP_EXCLUSIONS.keys()]).toEqual([]);
  });

  for (const sweep of SWEEPS) {
    it(`the ${sweep.name} roster is exactly the tier map minus the exclusion list`, () => {
      const roster = sweepRoster(sweep.path);
      const expected = expectedSweptPackages(directories);
      const missing = expected.filter((p) => !roster.includes(p));
      const unexpected = roster.filter((p) => !expected.includes(p));
      expect(
        { missing, unexpected },
        `${sweep.name} roster drift.\n` +
          `  missing (must be added, WITH its \`import * as x\`): ${missing.join(', ') || '—'}\n` +
          `  unexpected (not a swept package): ${unexpected.join(', ') || '—'}`,
      ).toEqual({ missing: [], unexpected: [] });
    });
  }

  it('both sweeps keep a live roster guard, so drift also fails inside the sweep itself', () => {
    // Belt and braces: reading the literal proves the roster is right TODAY; the in-sweep
    // assertion is what fails when someone edits the roster and runs only that sweep.
    for (const sweep of SWEEPS) {
      const source = readFileSync(fileURLToPath(new URL(sweep.path, import.meta.url)), 'utf8');
      expect(
        source.includes('expectedSweptPackages'),
        `${sweep.name} lost its roster guard — restore the expectedSweptPackages() assertion.`,
      ).toBe(true);
    }
  });

  it('the derivation is fail-closed: an unregistered package fails all three checks', () => {
    // Simulate adding `packages/newthing` and registering it nowhere.
    const simulated: PackageDirectory[] = [
      ...directories,
      { dir: 'newthing', package: '@totalfinance/newthing' },
    ];
    // (1) it is reported as unclassified…
    expect(unclassifiedDirectories(simulated)).toContain('newthing');
    // (2) …and it is REQUIRED in the swept roster, so both sweep-roster checks fail on it.
    expect(expectedSweptPackages(simulated)).toContain('newthing');
    for (const sweep of SWEEPS) {
      expect(sweepRoster(sweep.path)).not.toContain('newthing');
    }
  });

  it('classification is honest about the tiers that are deliberately NOT swept', () => {
    const swept = expectedSweptPackages(directories);
    for (const { dir, package: name } of directories) {
      const tier = MANIFEST_TIERS[name];
      if (tier === 'trusted' || tier === 'integration') {
        expect(swept, `${dir} is ${tier}-tier and must not be runtime-swept`).not.toContain(dir);
      }
      if (tier === 'facade') {
        expect(swept, `${dir} is a facade and must be runtime-swept`).toContain(dir);
      }
    }
    // The two tiers that opt out are the mathematical kernel and the MCP integration — spelled out
    // here so a future reader sees the intent rather than inferring it from an absence.
    expect(MANIFEST_TIERS['@totalfinance/core']).toBe('trusted');
    expect(MANIFEST_TIERS['@totalfinance/math']).toBe('trusted');
    expect(MANIFEST_TIERS['@totalfinance/mcp']).toBe('integration');
    expect(MANIFEST_TIERS['@totalfinance/cli']).toBe('integration');
    expect(MANIFEST_TIERS['@totalfinance/http']).toBe('integration');
    expect([...TIER_EXCEPTIONS.keys()]).toEqual(['totalfinance']);
  });
});
