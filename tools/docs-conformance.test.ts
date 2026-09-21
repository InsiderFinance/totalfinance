/**
 * Documentation gates for 3B.N8-DOCS.
 *
 * The parent task was marked complete while all eleven of its child items sat unchecked — the tracker
 * dishonesty a reviewer flagged twice. Ticking the boxes would have been the wrong repair; most of those
 * children genuinely are not done, and the spec now says so. Two of them ARE mechanical, so they are
 * closed here with tests rather than with prose:
 *
 *   - "Validate every internal documentation link and generated index after package-directory, subpath,
 *      heading, and anchor changes." A rename that moves a file or a heading leaves a dead link, and
 *      3B.N moved a great many of both.
 *
 *   - "Finish with zero stale legacy executable names in active, current-runnable, or generated
 *      surfaces." The retired forms are already recorded as data in `COMPILE_FAIL_FIXTURES`; this asserts
 *      none of them reappears in a place a reader would copy from.
 *
 * The inventory items — a documentation naming inventory, per-surface class assignment, a context-aware
 * policy with machine-readable dispositions — are now closed by `docs-inventory.ts` and gated below.
 * What that inventory found is worth recording, because it is the argument for having built it: 48
 * identifiers across 23 SHIPPED specs named fields the library does not have (`var`, `cvar`, `iv`,
 * `vols`, `tenor`, `t`, `dte`, `params`, `n`, `vol`), and six runtime guards told callers to fix a field
 * by a name they could not find (`thesis.vol`, `bars[i].ts`, `${label}.t`, `${field}.rate`).
 *
 * The bundle re-measurement and future-target audit items remain authored work, and the spec's checklist
 * marks them open.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPILE_FAIL_FIXTURES } from './manifest/naming-policy.js';
import { generatedDocOwners } from './generated-docs.js';
import {
  documentationInventory,
  readDocsInventory,
  ruleFor,
  DOCUMENTED_EXCEPTIONS,
  matchesDocumentedException,
  type DocClass,
} from './manifest/docs-inventory.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = resolve(ROOT, 'docs');

/** Every markdown file under `docs/`, plus the package READMEs a user actually lands on. */
function markdownFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      // `pnpm docs` renders the TypeDoc API site into docs/api (git-ignored); a build artifact is not a
      // documentation surface this gate reads (2026-09-06).
      if (entry === 'api' && dir.endsWith(`${sep}docs`)) continue;
      const path = resolve(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.md')) out.push(path);
    }
  };
  walk(DOCS);
  const packages = resolve(ROOT, 'packages');
  for (const dir of readdirSync(packages).sort()) {
    const readme = resolve(packages, dir, 'README.md');
    if (existsSync(readme)) out.push(readme);
  }
  return out;
}

const files = markdownFiles();

/** GitHub's heading→anchor slug. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

describe('documentation conformance (3B.N8-DOCS)', () => {
  it('covers a meaningful documentation surface', () => {
    // A floor, so a broken walker cannot silently reduce these gates to asserting nothing.
    expect(files.length).toBeGreaterThan(30);
  });

  it('every internal documentation link resolves to a file that exists', () => {
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]!.trim();
        // External links, anchors-in-page, and mail links are not this gate's business.
        if (/^(?:https?:|mailto:|#)/.test(target)) continue;
        const [path] = target.split('#');
        if (!path) continue;
        const resolved = resolve(dirname(file), path);
        if (!existsSync(resolved)) {
          broken.push(`${relative(ROOT, file)} -> ${target}`);
        }
      }
    }
    expect(
      broken,
      `dead internal documentation links — 3B.N moved package directories, subpaths and headings, ` +
        `and a link that 404s is a rename that was not finished:\n${broken.join('\n')}`,
    ).toEqual([]);
  });

  it('every in-page anchor link resolves to a heading in the target file', () => {
    const broken: string[] = [];
    const headingsOf = (path: string): Set<string> => {
      const set = new Set<string>();
      const text = readFileSync(path, 'utf8');
      for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) set.add(slug(match[1]!));
      // EXPLICIT anchors count too. These docs place `<a id="wave6-ctd-frontier"></a>` above a heading
      // whose own slug differs, and a gate that only knew about heading slugs called four live links
      // broken — a false positive is as damaging to a gate's credibility as a miss.
      for (const match of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) set.add(match[1]!);
      for (const match of text.matchAll(/\{#([^}]+)\}/g)) set.add(match[1]!);
      return set;
    };
    const cache = new Map<string, Set<string>>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]!.trim();
        if (/^(?:https?:|mailto:)/.test(target)) continue;
        const hash = target.indexOf('#');
        if (hash < 0) continue;
        const anchor = target.slice(hash + 1);
        if (anchor === '') continue;
        const path = target.slice(0, hash);
        const resolved = path === '' ? file : resolve(dirname(file), path);
        if (!existsSync(resolved) || !resolved.endsWith('.md')) continue;
        if (!cache.has(resolved)) cache.set(resolved, headingsOf(resolved));
        if (!cache.get(resolved)!.has(anchor)) {
          broken.push(`${relative(ROOT, file)} -> ${target}`);
        }
      }
    }
    expect(
      broken,
      `documentation anchors pointing at headings that no longer exist:\n${broken.join('\n')}`,
    ).toEqual([]);
  });

  it('no retired executable name appears in an active guide or package README', () => {
    /**
     * The retired forms are already recorded as data in `COMPILE_FAIL_FIXTURES`. This asserts none has
     * come back somewhere a reader would copy from — the `t: 1` in the errors guide was exactly this,
     * and it survived the whole naming phase because nothing looked.
     *
     * SPEC documents are excluded on purpose: they are the before→after record, and a removal fixture
     * that cannot name what it removed proves nothing. Guides and READMEs are the teaching surfaces.
     */
    const teaching = files.filter(
      (file) => file.includes('/docs/guides/') || file.endsWith('/README.md'),
    );
    expect(teaching.length).toBeGreaterThan(15);

    // Only single-token identifiers can be searched safely; a prose form like `basket.priceApproximation(...)`
    // would need context this gate does not have.
    const retired = COMPILE_FAIL_FIXTURES.map((fixture) => fixture.before)
      .filter((before) => /^[A-Za-z_$][\w$]*$/.test(before))
      .filter((before) => before.length > 3);

    const found: string[] = [];
    for (const file of teaching) {
      const text = readFileSync(file, 'utf8');
      for (const name of retired) {
        // Word-boundary, so `vol` inside `volatility` never matches.
        if (new RegExp(`\\b${name}\\b`).test(text)) {
          found.push(`${relative(ROOT, file)}: ${name}`);
        }
      }
    }
    expect(
      found,
      `a retired executable name is being taught in an active surface — a runnable example that ` +
        `teaches an old field is the same class of defect as the old field itself:\n${found.join('\n')}`,
    ).toEqual([]);
  });
});

describe('documentation naming inventory (3B.N8-DOCS items 1-3, 11)', () => {
  const inventory = documentationInventory();

  it('classifies every documentation surface, with an owner', () => {
    // The spec requires a class and a named owner per surface; "neither" is the state it forbids.
    const classes = new Set<DocClass>([
      'future-target',
      'current-runnable',
      'generated',
      'historical',
      'formula-notation',
      'migration-evidence',
    ]);
    const unclassified = inventory.surfaces.filter(
      (surface) => !classes.has(surface.class) || surface.owner.trim() === '',
    );
    expect(unclassified.map((surface) => surface.path)).toEqual([]);
    // A floor, so a broken walker cannot reduce this suite to asserting nothing.
    expect(inventory.surfaces.length).toBeGreaterThan(100);
    expect(inventory.summary['executableFences']).toBeGreaterThan(100);
  });

  it('assigns each class the rule the spec prescribes', () => {
    // Reading the mapping back stops a future edit from quietly moving a class to a weaker rule —
    // which is exactly what a wrapped `Status:` marker did by accident, holding 5 shipped specs to the
    // vocabulary rule instead of truthfulness.
    expect(ruleFor('current-runnable')).toBe('truthfulness');
    expect(ruleFor('generated')).toBe('truthfulness');
    expect(ruleFor('future-target')).toBe('vocabulary');
    expect(ruleFor('historical')).toBe('none');
    expect(ruleFor('migration-evidence')).toBe('none');
    expect(ruleFor('formula-notation')).toBe('none');
    // Both rules must actually be exercised; a rule that covers nothing gates nothing.
    expect(inventory.summary['checkedUnderTruthfulness']).toBeGreaterThan(50);
    expect(inventory.summary['checkedUnderVocabulary']).toBeGreaterThan(5);
  });

  it('every generated surface is declared in the generator registry', () => {
    // Ownership is declared in `tools/generated-docs.ts`, not inferred from a marker. This binds the
    // two together in both directions, because each direction hides a different failure:
    //   registry -> inventory   a generated file the inventory thinks a human owns
    //   inventory -> registry   a generator nobody registered, so nothing proves its output
    const registry = generatedDocOwners();
    const classified = new Map(
      inventory.surfaces
        .filter((surface) => surface.class === 'generated')
        .map((surface) => [surface.path, surface.owner]),
    );

    const unclassified = [...registry.keys()].filter((path) => !classified.has(path));
    expect(
      unclassified,
      `declared generated, but the inventory did not classify it as generated:\n${unclassified.join('\n')}`,
    ).toEqual([]);

    const unregistered = [...classified.keys()].filter((path) => !registry.has(path));
    expect(
      unregistered,
      `classified as generated but absent from tools/generated-docs.ts, so nothing proves it can be ` +
        `regenerated:\n${unregistered.join('\n')}`,
    ).toEqual([]);

    const misowned = [...registry.entries()]
      .filter(([path, generator]) => classified.get(path) !== generator)
      .map(
        ([path, generator]) =>
          `${path}: registry says ${generator}, inventory says ${classified.get(path)}`,
      );
    expect(misowned).toEqual([]);
  });

  it('every generated surface names a generator that exists', () => {
    // "Fix the generator, then regenerate" is only actionable if the owner is a real file.
    const missing = inventory.surfaces
      .filter((surface) => surface.class === 'generated')
      .filter((surface) => !existsSync(resolve(ROOT, surface.owner)))
      .map((surface) => `${surface.path} -> ${surface.owner}`);
    expect(
      missing,
      `generated docs whose owning generator cannot be found:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('no documentation surface names an identity the library does not have', () => {
    /**
     * The exit condition for "zero stale legacy executable names in active, current-runnable, or
     * generated surfaces" — checked against the naming baseline rather than a token list, so it
     * convicts a field that merely no longer exists and acquits `k`/`w`, which are really shipped.
     */
    const report = inventory.findings.map(
      (finding) => `[${finding.rule}] ${finding.id} (${finding.position}) — ${finding.line}`,
    );
    expect(
      report,
      `a documentation fence asserts an identity the library does not export, or a future-target spec ` +
        `is choosing a name the naming policy forbids:\n${report.join('\n')}`,
    ).toEqual([]);
  });

  it('carries no stale disposition', () => {
    // The spec rules out a broad file allowlist. A per-finding disposition is the replacement, and it
    // only stays honest if an entry that stops matching anything is itself a failure.
    expect(
      inventory.unusedExceptions,
      `dispositions that no longer match any finding — delete them, or they become the allowlist the ` +
        `spec forbids:\n${inventory.unusedExceptions.join('\n')}`,
    ).toEqual([]);
    for (const [id, entry] of Object.entries(DOCUMENTED_EXCEPTIONS)) {
      expect(entry.why.length, `disposition ${id} must say why`).toBeGreaterThan(20);
    }
  });

  it('keeps HTTP authentication examples with narrowly documented host-API dispositions', () => {
    const path = 'docs/guides/http.md';
    const source = readFileSync(resolve(ROOT, path), 'utf8');
    expect(source).toContain("import { randomBytes } from 'node:crypto';");
    expect(source).toContain('Authorization: `Bearer ${authenticationToken}`');
    expect(inventory.surfaces.find((surface) => surface.path === path)?.rule).toBe('truthfulness');
    expect(Object.keys(DOCUMENTED_EXCEPTIONS).filter((id) => id.startsWith(`${path}#`))).toEqual([
      `${path}#Authorization`,
      `${path}#randomBytes`,
    ]);
    for (const name of ['Authorization', 'randomBytes']) {
      const id = `${path}#${name}`;
      expect(DOCUMENTED_EXCEPTIONS[id]?.disposition).toBe('illustrative');
      expect(inventory.unusedExceptions).not.toContain(id);
      expect(inventory.findings.some((finding) => finding.id === id)).toBe(false);
    }
  });

  it.each([
    ['AAPL', '@totalfinance/core/artifacts#createMarketSnapshot', 'spots'],
    ['AAPL', '@totalfinance/core/artifacts#createMarketSnapshot', 'volatilities'],
    ['AAPL', '@totalfinance/portfolio#portfolioSnapshot', 'spots'],
    ['AGG', '@totalfinance/portfolio#allocatePortfolio', 'prices'],
    ['AGG', '@totalfinance/portfolio#proposePortfolioRebalance', 'spots'],
    ['AGG', '@totalfinance/portfolio#proposePortfolioRebalance', 'instrumentClassification'],
    ['SPY', '@totalfinance/portfolio#proposePortfolioRebalance', 'prices'],
    ['SPY', '@totalfinance/portfolio#proposePortfolioRebalance', 'spots'],
    ['SPY', '@totalfinance/portfolio#proposePortfolioRebalance', 'instrumentClassification'],
    ['USD', '@totalfinance/core/artifacts#createMarketSnapshot', 'riskFreeRates'],
  ])(
    'limits generated %s data-key dispositions to their source dictionary',
    (name, sourceHeading, container) => {
      const input = {
        path: 'docs/llms-full.txt',
        owner: 'tools/llms-docs.ts',
        sourceHeading,
        identifier: { name, position: 'field' as const, container, line: `${name}: sample` },
      };
      expect(matchesDocumentedException(input)).toBe(true);
      expect(matchesDocumentedException({ ...input, path: 'docs/guides/mcp.md' })).toBe(false);
      expect(matchesDocumentedException({ ...input, owner: 'human' })).toBe(false);
      expect(
        matchesDocumentedException({ ...input, sourceHeading: '@totalfinance/options#price' }),
      ).toBe(false);
      expect(
        matchesDocumentedException({
          ...input,
          identifier: { ...input.identifier, container: 'input' },
        }),
      ).toBe(false);
      expect(
        matchesDocumentedException({
          ...input,
          identifier: { ...input.identifier, position: 'access' },
        }),
      ).toBe(false);
      expect(
        matchesDocumentedException({
          ...input,
          identifier: { ...input.identifier, name: 'UnknownField' },
        }),
      ).toBe(false);
    },
  );

  it('limits the OpenAPI host disposition to the generated bearer declaration', () => {
    const input = {
      path: 'docs/llms-full.txt',
      owner: 'tools/llms-docs.ts',
      sourceHeading: '@totalfinance/http#OpenApiDocument',
      identifier: { name: 'scheme', position: 'declaration' as const, line: "scheme: 'bearer';" },
    };
    expect(matchesDocumentedException(input)).toBe(true);
    expect(
      matchesDocumentedException({
        ...input,
        sourceHeading: '@totalfinance/http#HttpServerOptions',
      }),
    ).toBe(false);
    expect(
      matchesDocumentedException({
        ...input,
        identifier: { ...input.identifier, position: 'field' },
      }),
    ).toBe(false);
    expect(
      matchesDocumentedException({
        ...input,
        identifier: { ...input.identifier, line: "scheme: 'other';" },
      }),
    ).toBe(false);
    const generated = Object.keys(DOCUMENTED_EXCEPTIONS).filter((id) =>
      id.startsWith('docs/llms-full.txt#'),
    );
    expect(generated).toEqual(
      ['AAPL', 'AGG', 'SPY', 'USD', 'scheme'].map((name) => `docs/llms-full.txt#${name}`),
    );
    for (const id of generated) {
      expect(DOCUMENTED_EXCEPTIONS[id]?.generatedSource).toBeDefined();
      expect(inventory.unusedExceptions).not.toContain(id);
      expect(inventory.findings.some((finding) => finding.id === id)).toBe(false);
    }
  });

  it('is deterministic and matches the committed artifact', () => {
    const again = documentationInventory();
    expect(JSON.stringify(again)).toBe(JSON.stringify(inventory));

    const committed = readDocsInventory();
    expect(committed, 'public-docs.json is missing — run `pnpm run docs:update`').not.toBeNull();
    // Compare by IDENTITY SET, not by count: a surface added and another removed leaves the totals
    // unchanged while the content drifted.
    expect(new Set(committed!.surfaces.map((surface) => surface.path))).toEqual(
      new Set(inventory.surfaces.map((surface) => surface.path)),
    );
    expect(new Set(committed!.findings.map((finding) => finding.id))).toEqual(
      new Set(inventory.findings.map((finding) => finding.id)),
    );
    const classOf = new Map(committed!.surfaces.map((surface) => [surface.path, surface.class]));
    const reclassified = inventory.surfaces
      .filter((surface) => classOf.get(surface.path) !== surface.class)
      .map((surface) => `${surface.path}: ${classOf.get(surface.path)} -> ${surface.class}`);
    expect(reclassified, `surfaces changed class without the artifact being regenerated`).toEqual(
      [],
    );
  });
});
