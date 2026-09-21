/**
 * Manifest conformance gate v1 (alignment spec Law 1, P3.1b) — the manifest is the SPINE, and
 * this suite is what makes it load-bearing:
 *
 *   1. every manifest file is structurally valid;
 *   2. the LIVE surface and the manifest match exactly — an unclassified new export, a stale
 *      entry, a changed entrypoint set, or a lost `.explain` twin all fail here;
 *   3. no entry is `role: "unclassified"`;
 *   4. role grammar: every `facade` exposes `.explain` (violations live on a SHRINK-ONLY ledger
 *      with the migration note);
 *   5. topology: no FLAT `kernel` export on a facade-package root — kernels live behind expert
 *      subpaths or inside curated namespaces (shrink-only eviction ledger for the known flats);
 *   6. entrypoints ↔ package.json exports maps stay in sync, both directions;
 *   7. MCP: the runtime tool set and the manifest's `mcpTools` declarations are the SAME set —
 *      a new tool must name its backing export, a renamed export can't silently orphan a tool;
 *   8. the umbrella hoist stays frozen to the five ratified names + the 20 domain namespaces;
 *   9. fixtures: every facade-role function is exercised by the deep-sweep fixture set (or sits
 *      on its shrink-only ledger) — the manifest can DEMAND fixtures; humans author them.
 */

import { describe, expect, it } from 'vitest';
import * as umbrella from 'totalfinance';
import { allFixtures } from '../first-touch/fixtures.js';
import { UNFIXTURED } from '../first-touch/unfixtured.js';
import { UNFIXTURED_ANALYSIS } from '../first-touch/unfixtured-analysis.js';
import { MANIFEST_TIERS, inventoryPackage, packageEntrypoints } from './inventory.js';
import { readManifest } from './generate.js';
import { validatePackageManifest, type PackageManifest } from './schema.js';

const PKGS = packageEntrypoints();
const MANIFESTS = new Map<string, PackageManifest>();
for (const pkg of PKGS) {
  const m = readManifest(pkg.dir);
  if (m) MANIFESTS.set(pkg.dir, m);
}

/**
 * SHRINK-ONLY: facade-role exports whose `.explain` twin is still pending. Each entry is real
 * debt with an owner note in the manifest. Adding to this list is not allowed — build the twin.
 */
const FACADE_EXPLAIN_LEDGER = new Set<string>([
  // EMPTY (C5) — the four parity extractors were envelopes all along and are now classified
  // analysis/envelope. Stays empty: a facade without .explain doesn't merge.
]);

/**
 * SHRINK-ONLY: flat kernel exports still sitting on a facade-package root. The P3.3 eviction
 * cleared the options root; these are the remaining known flats. Evict (breaking, pre-release)
 * or re-scope; never extend.
 */
const KERNEL_ON_ROOT_LEDGER = new Set<string>([
  // EMPTY (C5) — the vol evaluator flats moved behind their feature subpaths and the FI
  // kernels live on '@totalfinance/fixed-income/rates'. Stays empty: flat kernels don't merge.
]);

const RATIFIED_HOIST = [
  'blackScholes',
  'option',
  'market',
  'engines',
  'impliedVolatility',
] as const;
const DOMAINS = [
  'options',
  'core',
  'math',
  'crypto',
  'calendars',
  'performance',
  'risk',
  'backtest',
  'volatility',
  'structure',
  'technicalAnalysis',
  'strategy',
  'fixedIncome',
  // 13 → 14 (FC0) → 15 (FC1) → 16 (FC3) → 17 (FC5) → 18 (FC6, 2026-08-19) → 19 (FC7,
  // 2026-08-28) → 20 (Stage 4.4b): each Stage 4 domain lands with its first real slice.
  'fundamentals',
  'valuation',
  'research',
  'foreignExchange',
  'commodities',
  'portfolio',
  'scenarios',
] as const;

describe('manifest conformance (Law 1)', () => {
  it('every classified package has a committed, structurally valid manifest', () => {
    for (const pkg of PKGS) {
      const m = MANIFESTS.get(pkg.dir);
      expect(m, `${pkg.package}: missing tools/manifest/packages/${pkg.dir}.json`).toBeTruthy();
      expect(validatePackageManifest(m!), pkg.package).toEqual([]);
      expect(m!.package).toBe(pkg.package);
      expect(m!.tier).toBe(MANIFEST_TIERS[pkg.package]);
    }
  });

  it('the live surface matches the manifest exactly (no unclassified, no stale, no drift)', async () => {
    const problems: string[] = [];
    for (const pkg of PKGS) {
      const m = MANIFESTS.get(pkg.dir);
      if (!m) continue;
      const inv = await inventoryPackage(pkg);
      for (const [name, live] of inv) {
        const entry = m.exports[name];
        if (!entry) {
          problems.push(
            `${pkg.dir}: NEW export "${name}" is not in the manifest — run pnpm manifest:update and classify it`,
          );
          continue;
        }
        if (entry.kind !== live.kind) {
          problems.push(
            `${pkg.dir}.${name}: kind drift (manifest ${entry.kind}, live ${live.kind})`,
          );
        }
        if ((entry.hasExplain ?? false) !== (live.hasExplain ?? false)) {
          problems.push(
            `${pkg.dir}.${name}: hasExplain drift (manifest ${entry.hasExplain ?? false}, live ${live.hasExplain ?? false})`,
          );
        }
        const a = [...entry.entrypoints].sort().join(',');
        const b = [...live.entrypoints].sort().join(',');
        if (a !== b)
          problems.push(`${pkg.dir}.${name}: entrypoints drift (manifest [${a}], live [${b}])`);
      }
      for (const name of Object.keys(m.exports)) {
        if (!inv.has(name)) {
          problems.push(`${pkg.dir}: STALE manifest entry "${name}" — the export no longer exists`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  }, 60_000);

  it('no export is unclassified', () => {
    const unclassified: string[] = [];
    for (const [domain, m] of MANIFESTS) {
      for (const [name, e] of Object.entries(m.exports)) {
        if (e.role === 'unclassified') unclassified.push(`${domain}.${name}`);
      }
    }
    expect(unclassified, unclassified.join('\n')).toEqual([]);
  });

  it('role grammar: every facade exposes .explain (ledger shrinks only)', () => {
    const violations: string[] = [];
    const stale: string[] = [];
    for (const [domain, m] of MANIFESTS) {
      for (const [name, e] of Object.entries(m.exports)) {
        const key = `${domain}:${name}`;
        if (e.role !== 'facade') {
          if (FACADE_EXPLAIN_LEDGER.has(key) === false) continue;
        }
        if (e.role === 'facade' && !e.hasExplain && !FACADE_EXPLAIN_LEDGER.has(key)) {
          violations.push(
            `${key} is a facade without .explain — build the twin (never extend the ledger)`,
          );
        }
        if (FACADE_EXPLAIN_LEDGER.has(key) && e.hasExplain) {
          stale.push(
            `${key} now has .explain — remove it from FACADE_EXPLAIN_LEDGER (the ledger only shrinks)`,
          );
        }
      }
    }
    expect([...violations, ...stale], [...violations, ...stale].join('\n')).toEqual([]);
  });

  it('topology: no flat kernel on a facade-package root (eviction ledger shrinks only)', () => {
    const violations: string[] = [];
    const stale: string[] = [...KERNEL_ON_ROOT_LEDGER];
    for (const [domain, m] of MANIFESTS) {
      if (m.tier !== 'facade') continue;
      for (const [name, e] of Object.entries(m.exports)) {
        const key = `${domain}:${name}`;
        const flatOnRoot =
          e.role === 'kernel' && !name.includes('.') && e.entrypoints.includes('.');
        if (flatOnRoot && !KERNEL_ON_ROOT_LEDGER.has(key)) {
          violations.push(
            `${key}: kernel exported FLAT from the package root — move it behind an expert subpath or namespace`,
          );
        }
        if (KERNEL_ON_ROOT_LEDGER.has(key) && flatOnRoot) {
          stale.splice(stale.indexOf(key), 1);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
    expect(
      stale,
      `no longer flat-on-root — remove from KERNEL_ON_ROOT_LEDGER:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('entrypoints in the manifest and package.json exports maps agree, both directions', () => {
    const problems: string[] = [];
    for (const pkg of PKGS) {
      const m = MANIFESTS.get(pkg.dir);
      if (!m) continue;
      const declared = new Set(pkg.entrypoints);
      const used = new Set<string>();
      for (const [name, e] of Object.entries(m.exports)) {
        for (const ep of e.entrypoints) {
          used.add(ep);
          if (!declared.has(ep)) {
            problems.push(`${pkg.dir}.${name}: entrypoint "${ep}" is not in package.json exports`);
          }
        }
      }
      for (const ep of declared) {
        if (!used.has(ep)) {
          problems.push(
            `${pkg.dir}: exports map declares "${ep}" but no manifest entry is reachable from it`,
          );
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('MCP: the runtime tool set equals the manifest mcpTools declarations', async () => {
    const mcp = (await import('@totalfinance/mcp')) as {
      defaultTools: () => { name: string }[];
      backtestPack: () => { tools: { name: string }[] };
      journeyPacks: () => { tools: { name: string }[] }[];
    };
    // The runtime set is every shipped tool: the defaults, the opt-in backtest pack, and (Stage 7A
    // slice 2) the four opt-in journey packs — each backed by the compute export it composes.
    const runtime = new Set<string>([
      ...mcp.defaultTools().map((t) => t.name),
      ...mcp.backtestPack().tools.map((t) => t.name),
      ...mcp.journeyPacks().flatMap((pack) => pack.tools.map((t) => t.name)),
    ]);
    const declared = new Map<string, string>();
    for (const [domain, m] of MANIFESTS) {
      for (const [name, e] of Object.entries(m.exports)) {
        for (const tool of e.mcpTools ?? []) {
          expect(
            declared.has(tool),
            `tool ${tool} declared by both ${declared.get(tool)} and ${domain}.${name}`,
          ).toBe(false);
          declared.set(tool, `${domain}.${name}`);
        }
      }
    }
    const undeclaredTools = [...runtime].filter((t) => !declared.has(t));
    const orphanDeclarations = [...declared.keys()].filter((t) => !runtime.has(t));
    expect(
      undeclaredTools,
      `MCP tools with no manifest backing (declare mcpTools on the implementing export):\n${undeclaredTools.join('\n')}`,
    ).toEqual([]);
    expect(
      orphanDeclarations,
      `manifest declares MCP tools that no longer exist:\n${orphanDeclarations.join('\n')}`,
    ).toEqual([]);
  });

  it('the umbrella hoist is frozen: five ratified names + the 20 domain namespaces, nothing else', () => {
    const names = Object.keys(umbrella).filter((n) => n !== 'default');
    expect([...names].sort()).toEqual([...RATIFIED_HOIST, ...DOMAINS].sort());
    // The hoisted five are identical to the scoped options exports (pure re-export, no copy).
    const options = MANIFESTS.get('options')!;
    for (const name of RATIFIED_HOIST) {
      expect(name in options.exports, `hoisted "${name}" missing from the options manifest`).toBe(
        true,
      );
    }
  });

  /**
   * SHRINK-ONLY (C4): analysis exports whose report results still lack `assumptions`/`diagnostics`.
   * Fix the producer (add the two fields), then delist. Never extend.
   */
  // EMPTY as of E5: all 19 tracked exports now return their declared envelope|report shape
  // (or were honestly reclassified as artifacts). Shrink-only — keep empty.
  const ANALYSIS_GRAMMAR_DEBT = new Set<string>([]);

  describe('analysis grammar is EXECUTABLE (Law 2 / C4)', () => {
    it('every fixtured analysis export returns its declared shape (debt ledger shrinks only)', async () => {
      const { allFixtures } = await import('../first-touch/fixtures.js');
      const fixtures = allFixtures();
      const problems: string[] = [];
      const conformingDebt: string[] = [];
      for (const pkg of PKGS) {
        const m = MANIFESTS.get(pkg.dir);
        if (!m || m.tier !== 'facade') continue;
        const mod = (await import(/* @vite-ignore */ pkg.package)) as Record<string, unknown>;
        const resolve = (dotted: string): unknown =>
          dotted
            .split('.')
            .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], mod);
        const byFn = new Map<unknown, () => unknown[]>();
        for (const [k, thunk] of fixtures) {
          if (!k.startsWith(`${pkg.dir}.`)) continue;
          const f = resolve(k.slice(pkg.dir.length + 1));
          if (typeof f === 'function') byFn.set(f, thunk as () => unknown[]);
        }
        for (const [name, e] of Object.entries(m.exports)) {
          if (e.kind !== 'function' || e.role !== 'analysis') continue;
          const key = `${pkg.dir}:${name}`;
          const fn = resolve(name);
          if (typeof fn !== 'function') continue;
          const thunk = fixtures.get(`${pkg.dir}.${name}`) ?? byFn.get(fn);
          if (!thunk) continue; // fixture coverage is tracked separately
          let r: unknown;
          try {
            r = (fn as (...a: unknown[]) => unknown)(...thunk());
          } catch (err) {
            // A fixture that throws is ITSELF a finding — swallowing it would let the shape
            // check silently skip the export (D5).
            problems.push(
              `${key}: fixture threw during the shape check — fix the fixture or the export: ${(err as Error).message.slice(0, 120)}`,
            );
            continue;
          }
          const obj = r !== null && typeof r === 'object' && !Array.isArray(r);
          // EXACT shapes (D5): an envelope has value + assumptions + diagnostics (assumptions is
          // not optional — an unexplained envelope is a report in costume); a report carries
          // assumptions + diagnostics inline WITHOUT the value nesting. A report-declared export
          // returning an envelope (or vice versa) is a manifest lie, not a pass.
          const isEnvelope =
            obj &&
            'value' in (r as object) &&
            'assumptions' in (r as object) &&
            'diagnostics' in (r as object);
          const isReport =
            obj &&
            !('value' in (r as object)) &&
            'assumptions' in (r as object) &&
            'diagnostics' in (r as object);
          const conforms =
            e.shape === 'envelope' ? isEnvelope : e.shape === 'report' ? isReport : false;
          if (ANALYSIS_GRAMMAR_DEBT.has(key)) {
            if (conforms) conformingDebt.push(key);
            continue;
          }
          if (conforms) continue;
          problems.push(
            e.shape === undefined
              ? `${key}: analysis export has no declared shape — stamp envelope|report from its behavior`
              : `${key}: result does not match its declared shape "${e.shape}" exactly ` +
                  `(envelope = value+assumptions+diagnostics; report = assumptions+diagnostics, no value nesting) — Law 2`,
          );
        }
        // Debt entries that were reclassified away from `analysis` are stale too (D4's rule:
        // debt can never fall out of view by reclassification).
        for (const key of ANALYSIS_GRAMMAR_DEBT) {
          if (!key.startsWith(`${pkg.dir}:`)) continue;
          const entryName = key.slice(pkg.dir.length + 1);
          const entry = m.exports[entryName];
          if (entry === undefined || entry.role !== 'analysis') conformingDebt.push(key);
        }
      }
      // The stale check is a PLAIN SET DIFFERENCE (D5 — the old conditional was inert): any debt
      // entry that now conforms (or no longer exists as analysis) must be delisted.
      expect(problems, problems.join('\n')).toEqual([]);
      expect(
        [...new Set(conformingDebt)],
        `now conform (or reclassified) — remove from ANALYSIS_GRAMMAR_DEBT (it only shrinks):\n${[...new Set(conformingDebt)].join('\n')}`,
      ).toEqual([]);
    }, 60_000);
  });

  describe('manifest conformance (Law 1) — fixtures', () => {
    it('fixtures: every facade-role function is deep-sweep-fixtured (or on the shrink-only ledger)', async () => {
      const fixtures = allFixtures();
      // The deep sweep resolves fixtures by FUNCTION IDENTITY, so an alias (performance.calmar ≡
      // performance.calmarRatio) is covered by its canonical fixture. Mirror that here: resolve
      // every fixture key to its function and accept identity matches.
      const roots = new Map<string, Record<string, unknown>>();
      for (const pkg of PKGS) {
        roots.set(
          pkg.dir,
          (await import(/* @vite-ignore */ pkg.package)) as Record<string, unknown>,
        );
      }
      const resolve = (domain: string, dotted: string): unknown =>
        dotted
          .split('.')
          .reduce<unknown>(
            (o, k) => (o as Record<string, unknown> | undefined)?.[k],
            roots.get(domain),
          );
      const fixturedFns = new Set<unknown>();
      for (const key of fixtures.keys()) {
        const [domain, ...rest] = key.split('.');
        const fn = resolve(domain!, rest.join('.'));
        if (typeof fn === 'function') fixturedFns.add(fn);
      }
      const missing: string[] = [];
      for (const [domain, m] of MANIFESTS) {
        if (m.tier !== 'facade') continue;
        for (const [name, e] of Object.entries(m.exports)) {
          if (e.role !== 'facade' || e.kind !== 'function' || !e.hasExplain) continue;
          const key = `${domain}.${name}`;
          if (fixtures.has(key) || UNFIXTURED.has(key)) continue;
          if (fixturedFns.has(resolve(domain, name))) continue;
          missing.push(key);
        }
      }
      expect(
        missing,
        `facade exports without a deep-sweep fixture (author one in tools/first-touch/fixtures/):\n${missing.join('\n')}`,
      ).toEqual([]);
    }, 30_000);

    it('fixtures: every analysis-role export is fixtured (or on the shrink-only ratchet) — an unfixtured analysis export is an UNVERIFIED grammar claim', async () => {
      const fixtures = allFixtures();
      const roots = new Map<string, Record<string, unknown>>();
      for (const pkg of PKGS) {
        roots.set(
          pkg.dir,
          (await import(/* @vite-ignore */ pkg.package)) as Record<string, unknown>,
        );
      }
      const resolve = (domain: string, dotted: string): unknown =>
        dotted
          .split('.')
          .reduce<unknown>(
            (o, k) => (o as Record<string, unknown> | undefined)?.[k],
            roots.get(domain),
          );
      const fixturedFns = new Set<unknown>();
      for (const key of fixtures.keys()) {
        const [domain, ...rest] = key.split('.');
        const fn = resolve(domain!, rest.join('.'));
        if (typeof fn === 'function') fixturedFns.add(fn);
      }
      const missing: string[] = [];
      const covered = new Set<string>();
      for (const [domain, m] of MANIFESTS) {
        if (m.tier !== 'facade') continue;
        for (const [name, e] of Object.entries(m.exports)) {
          if (e.role !== 'analysis' || e.kind !== 'function') continue;
          const key = `${domain}.${name}`;
          if (fixtures.has(key) || fixturedFns.has(resolve(domain, name))) {
            covered.add(key);
            continue;
          }
          if (UNFIXTURED_ANALYSIS.has(key)) continue;
          missing.push(key);
        }
      }
      expect(
        missing,
        `analysis exports without a fixture — their envelope|report claim is UNCHECKED (author a fixture, never extend the ratchet):\n${missing.join('\n')}`,
      ).toEqual([]);
      // Shrink-only: an entry that gained a fixture (or stopped being analysis) must be delisted.
      const allAnalysis = new Set<string>();
      for (const [domain, m] of MANIFESTS) {
        if (m.tier !== 'facade') continue;
        for (const [name, e] of Object.entries(m.exports)) {
          if (e.role === 'analysis' && e.kind === 'function') allAnalysis.add(`${domain}.${name}`);
        }
      }
      const stale = [...UNFIXTURED_ANALYSIS].filter((k) => covered.has(k) || !allAnalysis.has(k));
      expect(
        stale,
        `now fixtured (or no longer analysis) — remove from UNFIXTURED_ANALYSIS (it only shrinks):\n${stale.join('\n')}`,
      ).toEqual([]);
    }, 30_000);
  });

  describe('helper honesty (E5)', () => {
    /**
     * SHRINK-ONLY — helper-role exports that return a plain-value QUANT ANSWER (a measurement a
     * user would quote) without the facade/analysis grammar. Their manifest note points HERE, so
     * the "recorded in the backlog" claim is mechanically true: every noted export is listed,
     * every listed export carries the note, and the list only shrinks (upgrade the export to a
     * facade/analysis grammar, then delist).
     */
    const HELPER_QUANT_ANSWER_BACKLOG = new Set<string>([]);
    const MARKER = 'plain-value quant answer';

    it('the quant-answer helper backlog and the manifest notes agree exactly, both directions', () => {
      const noted = new Set<string>();
      for (const [domain, m] of MANIFESTS) {
        for (const [name, e] of Object.entries(m.exports)) {
          if (e.kind !== 'function' || e.role !== 'helper') continue;
          if ((e.note ?? '').includes(MARKER)) noted.add(`${domain}:${name}`);
        }
      }
      const unlisted = [...noted].filter((k) => !HELPER_QUANT_ANSWER_BACKLOG.has(k));
      const orphaned = [...HELPER_QUANT_ANSWER_BACKLOG].filter((k) => !noted.has(k));
      expect(
        unlisted,
        `helper notes claim the quant-answer backlog but are not listed (add the grammar, or list honestly):\n${unlisted.join('\n')}`,
      ).toEqual([]);
      expect(
        orphaned,
        `backlog entries whose export lost the note/role — upgraded exports must be DELISTED (shrink-only):\n${orphaned.join('\n')}`,
      ).toEqual([]);
    });
  });
});
