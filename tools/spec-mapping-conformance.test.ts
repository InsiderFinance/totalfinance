/**
 * The 3B.N spec's own mapping table, enforced as a contract (3B.N8).
 *
 * `docs/specs/phase-3b-public-naming-normalization.md` records every rename as `old → new`, in
 * tables and in prose. That document was the DECISION, and the migration was supposed to execute
 * it. It mostly did — but two failure modes slipped through, both of which this file now catches:
 *
 *   1. **String expansion where the spec wrote a semantic target.** The spec says `pnlVol` becomes
 *      `pnlStandardDeviation`, *not* `pnlVolatility` — it says so in those words. A repo-wide
 *      `vol` → `volatility` sweep produced `pnlVolatility` anyway. Every mechanical gate passed:
 *      the name contains no forbidden token, so the naming inventory scored it `explicit` and the
 *      migration reported zero unresolved identities. Law N3 ("semantic, not string, expansion")
 *      was written down and unenforced. Six names reached the public surface this way and were
 *      caught by review, not by CI.
 *
 *   2. **The spec rewriting itself.** The same sweeps edit markdown. Eight mapping rows had been
 *      rewritten into `X becomes X` — the retired form replaced by its own replacement — which
 *      destroys the record of what was removed while still reading like a live instruction. This is
 *      the removal-fixture corruption (see `naming-conformance.test.ts`) one level up, in the
 *      document the fixtures are derived FROM.
 *
 * What is asserted, and what is deliberately not: this checks that the spec's stated TARGET exists
 * in the committed naming baseline and that its stated SOURCE does not. It does not try to parse the
 * spec's prose into a full rename graph — the table rows carry globs, prose, and one-to-many rows
 * that no parser should pretend to understand. Rows it cannot read confidently are skipped and
 * COUNTED, and the count is asserted, so a future edit that makes rows unreadable fails loudly
 * instead of quietly reducing coverage to nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPILE_FAIL_FIXTURES } from './manifest/naming-policy.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEC = resolve(ROOT, 'docs/specs/phase-3b-public-naming-normalization.md');
const OTHER_3B_SPECS = [
  'docs/specs/phase-3b-decision-ledger.md',
  'docs/specs/phase-3b-runtime-semantic-closeout.md',
];

const specText = readFileSync(SPEC, 'utf8');
const specLines = specText.split('\n');

/** Every public identity NAME in the committed baseline (not the ids — names, for lookup by spelling). */
const baselineNames: ReadonlySet<string> = new Set(
  (
    JSON.parse(readFileSync(resolve(ROOT, 'tools/manifest/public-naming.json'), 'utf8')) as {
      identities: { name: string }[];
    }
  ).identities.map((identity) => identity.name),
);

/**
 * A single-token rename the spec states unambiguously: exactly one backticked identifier on each
 * side, both plain identifiers (no globs, dots, spaces, or slashes).
 */
interface StatedRename {
  line: number;
  from: string;
  to: string;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Parse `- \`a\` becomes \`b\`` and `- \`a\` → \`b\`` prose statements.
 *
 * Only ONE-TO-ONE rows are read. A row with more than two backticked spans is a list — `\`x\`/\`fx\`
 * become \`argument\` or \`parameters\` and \`objectiveValue\`, or `generic \`rate\` becomes
 * \`riskFreeRate\`, \`financingRate\`, …` — and a parser that took the first pair from those would
 * assert `fx → argument` and `rate → riskFreeRate`, neither of which the spec says. Skipping them is
 * honest; the count assertion below is what keeps the skipping from swallowing everything.
 */
function statedRenames(): StatedRename[] {
  const found: StatedRename[] = [];
  specLines.forEach((line, index) => {
    // A second `becomes`/`→`, or a third backticked span, means the row is a list.
    if ([...line.matchAll(/becomes?\b|→/g)].length !== 1) return;
    if ([...line.matchAll(/`[^`]+`/g)].length !== 2) return;
    const match = /`([^`]+)`\s*(?:becomes?|→)\s*`([^`]+)`/.exec(line);
    if (!match) return;
    const [, from, to] = match as unknown as [string, string, string];
    if (!IDENTIFIER.test(from) || !IDENTIFIER.test(to)) return;
    found.push({ line: index + 1, from, to });
  });
  return found;
}

const renames = statedRenames();

/**
 * The exact counts this gate covers. Both are asserted rather than bounded: a floor lets rows vanish
 * silently, which is how the first version shipped able to lose eight mappings without failing.
 */
const EXPECTED_PROSE_RENAMES = 39;
const EXPECTED_MAPPING_ROWS = 109;

/**
 * Is `name` on the public surface — either as an identity name, or as the last dotted segment of a
 * namespaced serialized code? Error and warning codes are recorded whole
 * (`backtest.data_duplicate_timestamp`) while the spec discusses their suffixes.
 */
function onPublicSurface(name: string): boolean {
  if (baselineNames.has(name)) return true;
  for (const candidate of baselineNames) {
    if (candidate.endsWith(`.${name}`)) return true;
  }
  return false;
}

/**
 * Spec targets that were deliberately overruled, each with a paragraph under "Ratified divergences".
 * The gate consults this list so a genuine miss still fails while a recorded decision does not — and
 * the "ratified-divergences section names each overruled spelling" test below keeps the two in sync,
 * so an entry here without a written reason is itself a failure.
 */
const RATIFIED_TARGETS: ReadonlySet<string> = new Set([
  'volatilityChange', // PnlMove keeps the coordinated d* differential set; dTime -> dTimeYears instead
  'SimulationBroker', // SimulatedBroker reads as the adjective it is
  'volatilitySpotSensitivity', // beta is the term of art
  'estimateVolatilitySpotSensitivity',
  'eventAdjustedVolatility', // "stripped" says the direction; "adjusted" does not
  'MonteCarloOptions', // would recreate the @totalfinance/math collision it was meant to remove
]);

describe('3B.N spec mapping table is a contract, not a description', () => {
  it('parses exactly the expected population of unambiguous prose renames', () => {
    // EXACT, not a floor. The first version of this gate asserted `> 30` against 39 parsed rows,
    // which meant eight mappings could disappear while CI stayed green. A threshold with that much
    // slack is not a gate. A changed count is a real event: update the constant in the same commit
    // that adds or removes a row.
    expect(
      renames.length,
      'the spec parser found a different number of one-to-one prose renames — if that is intended, ' +
        'update EXPECTED_PROSE_RENAMES in the same commit',
    ).toBe(EXPECTED_PROSE_RENAMES);
  });

  it('no mapping row is tautological (the retired form is not its own replacement)', () => {
    // A `vol` → `volatility` sweep rewrites markdown too. `\`volCutoff\` becomes \`volumeCutoff\``
    // became `\`volumeCutoff\` becomes \`volumeCutoff\`` — an instruction that reads live and
    // records nothing. Eight rows were in this state when the gate was written.
    const tautological = specLines
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter(({ text }) => {
        for (const match of text.matchAll(/`([^`]+)`\s*(?:becomes?|→)\s*`([^`]+)`/g)) {
          if (match[1] === match[2]) return true;
        }
        return false;
      })
      .map(({ line, text }) => `${SPEC}:${line}  ${text.trim().slice(0, 110)}`);
    expect(
      tautological,
      `spec rows rewritten into "X becomes X" — recover the retired form from git history:\n${tautological.join('\n')}`,
    ).toEqual([]);
  });

  it('every 3B spec document is free of tautological mappings', () => {
    const offenders: string[] = [];
    for (const relative of OTHER_3B_SPECS) {
      const lines = readFileSync(resolve(ROOT, relative), 'utf8').split('\n');
      lines.forEach((text, index) => {
        for (const match of text.matchAll(/`([^`]+)`\s*(?:becomes?|→)\s*`([^`]+)`/g)) {
          if (match[1] === match[2])
            offenders.push(`${relative}:${index + 1}  ${text.trim().slice(0, 90)}`);
        }
      });
    }
    expect(
      offenders,
      `tautological mappings in a 3B decision record:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the spec-stated TARGET name exists in the public surface', () => {
    // The direction that catches law-N3 violations: if the spec says the answer is
    // `pnlStandardDeviation` and the surface has never heard of it, the rename either did not happen
    // or landed on a different name than the one that was decided.
    const missing = renames
      .filter((rename) => !onPublicSurface(rename.to) && !RATIFIED_TARGETS.has(rename.to))
      .map(
        (rename) => `spec:${rename.line}  ${rename.from} → ${rename.to} (target not in surface)`,
      );
    expect(
      missing,
      `the spec decided these names and the public surface does not have them.\n` +
        `Either land the rename, or amend the spec under "Ratified divergences" with the reason:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('the spec-stated SOURCE name is gone from the public surface', () => {
    const survivors = renames
      .filter((rename) => onPublicSurface(rename.from))
      .map((rename) => `spec:${rename.line}  ${rename.from} → ${rename.to} (source still public)`);
    expect(
      survivors,
      `retired forms the spec says are gone, still on the public surface:\n${survivors.join('\n')}`,
    ).toEqual([]);
  });

  it('the ratified-divergences section exists and names each overruled spelling', () => {
    // The escape hatch has to be real, or the two assertions above become pressure to follow a spec
    // that is sometimes wrong. It also has to be specific: a section that says "we diverged
    // sometimes" is not a record.
    expect(specText).toContain('## Ratified divergences');
    const section = specText.slice(specText.indexOf('## Ratified divergences'));
    for (const ratified of [
      'SimulatedBroker',
      'volatilitySpotBeta',
      'eventStrippedVolatility',
      'estimateVolatilitySpotBeta',
      'MonteCarloSamplingOptions',
      'dVolatility',
    ]) {
      expect(section, `${ratified} diverges from the spec and must be ratified by name`).toContain(
        ratified,
      );
    }
  });
});

describe('3B.N9 closeout numbers are live, not remembered', () => {
  /**
   * A closeout table is the first thing to rot: written once, read often, recomputed by nothing. Every
   * figure below is parsed back out of the spec and compared to the generated summary, so a changed
   * surface either updates the prose or fails here. 3B.N7 discovered that a committed "0 unresolved"
   * had been computed over an incomplete walk — a number nobody could check is exactly the artifact
   * that hid it.
   */
  const summary = (
    JSON.parse(readFileSync(resolve(ROOT, 'tools/manifest/public-naming.json'), 'utf8')) as {
      summary: {
        identities: number;
        unresolved: number;
        byDisposition: Record<string, number>;
        byPackage: Record<string, number>;
      };
    }
  ).summary;

  const closeout = specText.slice(specText.indexOf('## Closeout state (3B.N9)'));

  /** The integer in the closeout row whose label matches, with thousands separators removed. */
  function statedCount(label: string): number | null {
    const row = closeout.split('\n').find((line) => line.startsWith('|') && line.includes(label));
    if (!row) return null;
    const cells = row.split('|').map((cell) => cell.trim());
    const last = cells.filter(Boolean).at(-1) ?? '';
    const digits = /(\d[\d,]*)/.exec(last.replace(/\*\*/g, ''));
    return digits ? Number(digits[1]!.replace(/,/g, '')) : null;
  }

  it.each([
    ['Public naming identities walked', () => summary.identities],
    ['Unresolved (the migration queue)', () => summary.unresolved],
    ['`explicit`', () => summary.byDisposition['explicit'] ?? -1],
    ['`canonical-term`', () => summary.byDisposition['canonical-term'] ?? -1],
    ['`scoped-symbol`', () => summary.byDisposition['scoped-symbol'] ?? -1],
    ['`opaque-state`', () => summary.byDisposition['opaque-state'] ?? -1],
    ['Packages, including the umbrella', () => Object.keys(summary.byPackage).length],
  ] as const)('the closeout row for %s matches the generated baseline', (label, live) => {
    const stated = statedCount(label);
    expect(stated, `no closeout row found for "${label}"`).not.toBeNull();
    expect(
      stated,
      `closeout prose says ${stated}, the baseline says ${live()} — run \`pnpm naming:update\` and update the table`,
    ).toBe(live());
  });

  it('the closeout removal-evidence count matches the fixture set', () => {
    const row = closeout.split('\n').find((line) => line.includes('executable removal evidence'));
    expect(row, 'no removal-evidence row in the closeout table').toBeDefined();
    const pair = /(\d+) of (\d+)/.exec(row ?? '');
    expect(pair, 'the removal-evidence row must read "N of M"').not.toBeNull();
    const [, covered, total] = pair as unknown as [string, string, string];
    expect(Number(total)).toBe(COMPILE_FAIL_FIXTURES.length);
    // naming-removals.test.ts proves every fixture is covered, so N must equal M here.
    expect(Number(covered)).toBe(COMPILE_FAIL_FIXTURES.length);
  });
});

/**
 * Table rows state their mapping COLUMN to column, with no verb for the prose gate to match — so a
 * sweep collapsed 16 of them and the tautology test above saw nothing. A row is collapsed when a
 * backticked token in the retired column reappears verbatim in the canonical column.
 *
 * Rows are deliberately allowed to name the same token on both sides in ONE case: a glob family
 * whose canonical direction legitimately includes an already-correct member. There are none today,
 * so the allowlist is empty and stays empty until a real case argues for an entry — the same
 * discipline the settled-rename lists use.
 */
const COLLAPSED_ROW_EXEMPTIONS: ReadonlySet<string> = new Set();

describe('3B.N spec mapping TABLES are a contract too', () => {
  /**
   * Two-column table rows, as `[lineNumber, retiredCell, canonicalCell]`.
   *
   * NOTE FOR ANYONE EDITING THE SPEC: this matches ANY two-column row whose first cell contains
   * backticks, so a two-column table of examples or evidence anywhere in the document counts as
   * mapping rows and fails the exact-count gate below. Three-column tables and lists are unaffected.
   * Prefer a list for anything that is not a retired-name -> canonical-name mapping.
   */
  const tableRows: [number, string, string][] = specLines.flatMap((line, index) => {
    if (!line.startsWith('| ')) return [];
    const cells = line
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean);
    if (cells.length !== 2) return [];
    if (/^-+$/.test(cells[0]!.replace(/[\s|:-]/g, '-'))) return [];
    return [[index + 1, cells[0]!, cells[1]!] as [number, string, string]];
  });

  const backticked = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

  it('parses the mapping tables', () => {
    // Exact, not a floor: 139 rows across the settled-vocabulary, package, MCP and code tables. A
    // changed count means a row was added or lost, and either way a human should look.
    expect(
      tableRows.filter((row) => backticked(row[1]).length > 0).length,
      'the table parser found a different number of mapping rows — did the table format change?',
    ).toBe(EXPECTED_MAPPING_ROWS);
  });

  it('no table row names the same token on both sides', () => {
    const collapsed = tableRows
      .filter(([line, retired, canonical]) => {
        if (COLLAPSED_ROW_EXEMPTIONS.has(String(line))) return false;
        const right = new Set(backticked(canonical));
        return backticked(retired).some((token) => right.has(token));
      })
      .map(([line, retired, canonical]) => {
        const right = new Set(backticked(canonical));
        const shared = backticked(retired).filter((token) => right.has(token));
        return `spec:${line} shares ${shared.map((s) => `\`${s}\``).join(', ')} — ${retired.slice(0, 60)}`;
      });
    expect(
      collapsed,
      `table rows whose retired column was rewritten into its own replacement — recover the ` +
        `retired form from git history (49ab47f7~1 predates every sweep):\n${collapsed.join('\n')}`,
    ).toEqual([]);
  });
});
