/**
 * Phase 3B.N8-DOCS item 7 — the published bundle table matches the enforced budgets.
 *
 * "Regenerate package/deep-entrypoint bundle measurements and the stability table only after the new
 * packed imports exist; retain the capability's budget and stability intent across a rename."
 *
 * `docs/bundle-size.md` opens by calling bundle size "a public contract". It was not being treated as
 * one. Against the budgets CI actually enforced, the page published:
 *
 *   @insiderfinance/totalfinance/math                    "< 14 KB"  enforced 33 KB   — a consumer would budget 2.4x low
 *   @insiderfinance/totalfinance/options/black-scholes   "< 8 KB"   enforced 8.5 KB
 *   six entrypoints                   absent     including the umbrella, the largest number here
 *
 * and its measured column was staler still — `performance/sharpe` published at 0.9 KB measures
 * 5.7 KB, `technical-analysis/rsi` at 0.6 KB measures 4.6 KB. Off by 6-7x on the numbers a consumer
 * would use to decide what to import.
 *
 * The page is generated now, so this test splits the two kinds of claim it makes:
 *
 *   EXACT      entrypoints, budgets, intents, structural guarantees — the contract. A mismatch here
 *              means the page disagrees with CI, which is the failure that started all this.
 *   TOLERANT   the measured gzip column, which legitimately moves with every commit. Held to 0.6 KB
 *              or 12%, enough to catch a stale page without demanding regeneration on every change.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KB, measureBundle } from './bundle-size/measure.js';
import { BUNDLE_BUDGETS } from './bundle-size/budgets.js';
import { workspaceAlias } from './bundle-size/workspace-alias.js';
import { reportedConsumerFixtures } from './bundle-size/packed-report.js';

const root = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const page = readFileSync(root('docs/bundle-size.md'), 'utf8');

/** The table's rows: specifier → { gzip KB, budget label }. */
function publishedRows(): Map<string, { gzipKB: number; budget: string; notes: string }> {
  const rows = new Map<string, { gzipKB: number; budget: string; notes: string }>();
  for (const line of page.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([\d.]+) KB\s*\|\s*(< [\d.]+ KB)\s*\|\s*(.*?)\s*\|$/.exec(
      line,
    );
    if (match) {
      rows.set(match[1]!, {
        gzipKB: Number(match[2]),
        budget: match[3]!,
        notes: match[4]!,
      });
    }
  }
  return rows;
}

const rows = publishedRows();

describe('published bundle table (3B.N8-DOCS item 7)', () => {
  it('separates used-function installed measurements from whole-entrypoint ceilings', () => {
    expect(page).toContain('## Small installed consumers');
    expect(page).toContain('## Whole-entrypoint ceilings');
    expect(page).toContain('not** the cost of importing one function');
    expect(page).toContain('https://github.com/evanw/esbuild/issues/1420');
    expect(page).toContain("import { normalCdf } from '@insiderfinance/totalfinance/math'");
    expect(page).toContain('exactly the two built distribution artifacts');
    expect(page).toContain('@insiderfinance/totalfinance-mcp');
    expect(page).toContain('main artifact has no runtime dependencies');
    expect(page).not.toMatch(/`(?:@totalfinance\/|totalfinance(?:\/|`))/);
  });

  it('publishes both bundler budgets from the installed-consumer fixture record', () => {
    const matches = [
      ...page.matchAll(
        /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([\d.]+) KiB \/ < ([\d.]+) KiB\s*\|\s*([\d.]+) KiB \/ < ([\d.]+) KiB\s*\|$/gm,
      ),
    ];
    expect(matches.map((match) => match[1])).toEqual(
      reportedConsumerFixtures().map((fixture) => fixture.id),
    );
    for (const [index, fixture] of reportedConsumerFixtures().entries()) {
      const row = matches[index]!;
      expect(row[2]).toBe(fixture.specifier);
      expect(Number(row[4])).toBe(fixture.budgetKiB.esbuild);
      expect(Number(row[6])).toBe(fixture.budgetKiB.rollup);
      // Display rounding may add at most half of a tenth KiB. Exact bytes remain the CI gate.
      expect(Number(row[3])).toBeLessThanOrEqual(fixture.budgetKiB.esbuild + 0.05);
      expect(Number(row[5])).toBeLessThanOrEqual(fixture.budgetKiB.rollup + 0.05);
    }
  });

  it('publishes every budgeted entrypoint, and none that is not budgeted', () => {
    const declared = BUNDLE_BUDGETS.map((budget) => budget.specifier).sort();
    expect([...rows.keys()].sort()).toEqual(declared);
    // 13 → 14 (FC3) → 15 (FC5) → 16 (FC6) → 17 (Gate B) → 18 (Gate C, 2026-08-20) → 19 (FC7,
    // 2026-09-01):
    // @insiderfinance/totalfinance/scenarios joins the 19 previously budgeted entrypoints → 21 (Stage 4.5 slice 3,
    // 2026-09-02): @insiderfinance/totalfinance/volatility/artifacts. → 22 (Stage 4.5 slice 4, 2026-09-03):
    // @insiderfinance/totalfinance/fixed-income/artifacts. → 23 (Stage 4.5 slice 5, 2026-09-03):
    // @insiderfinance/totalfinance/research/artifacts. → 24 (Stage 7A slice 1, 2026-09-03): @insiderfinance/totalfinance/workflows. → 25
    // (Stage 4.6 slice 3, 2026-09-04): @insiderfinance/totalfinance/backtest/artifacts. → 26 (Stage 4.6 slice 5, 2026-09-04):
    // @insiderfinance/totalfinance/backtest/portfolio. → 27 (Stage 7B.1 slice 1, 2026-09-05):
    // @insiderfinance/totalfinance/backtest/environment. → 28 (Stage 7B.2 slice 1, 2026-09-05): @insiderfinance/totalfinance/portfolio/trade.
    // 28 → 29 (Stage 7B.2 slice 3, 2026-09-06): the @insiderfinance/totalfinance/backtest/paper entrypoint joins the table.
    // 29 → 30 (PR #336, 2026-09-07): @insiderfinance/totalfinance/performance/sector-performance is independently budgeted.

    // The independently capped disclosed-holdings subpath adds one entrypoint (2026-09-25).
    expect(declared.length).toBe(31);
  });

  it('publishes the budget CI enforces, exactly', () => {
    const wrong: string[] = [];
    for (const budget of BUNDLE_BUDGETS) {
      const row = rows.get(budget.specifier);
      if (row && row.budget !== `< ${budget.budgetKB} KB`) {
        wrong.push(
          `${budget.specifier}: page says ${row.budget}, CI enforces < ${budget.budgetKB} KB`,
        );
      }
    }
    expect(
      wrong,
      `the page quotes a budget CI does not hold — this is the defect that published ` +
        `\`@insiderfinance/totalfinance/math\` at "< 14 KB" against a 33 KB budget:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });

  it('carries each capability’s stability intent across renames', () => {
    // The intent travels with the specifier because they are one record; this asserts the page did
    // not lose it. "Retain the capability's budget and stability intent across a rename."
    const missing = BUNDLE_BUDGETS.filter(
      (budget) => rows.get(budget.specifier)?.notes !== budget.intent,
    ).map((budget) => budget.specifier);
    expect(missing, `entrypoints whose published intent does not match the declaration`).toEqual(
      [],
    );
  });

  it('publishes every structural guarantee', () => {
    for (const budget of BUNDLE_BUDGETS) {
      for (const rule of budget.forbidden ?? []) {
        expect(
          page,
          `${budget.specifier} is asserted not to bundle ${rule.needle}, but the page never says so`,
        ).toContain(rule.needle);
      }
    }
  });

  it('its measured numbers are not stale', async () => {
    const alias = workspaceAlias();
    const stale: string[] = [];
    for (const budget of BUNDLE_BUDGETS) {
      const row = rows.get(budget.specifier);
      if (!row) continue;
      const measured = (await measureBundle(root(budget.entry), alias)).bytesGzip / KB;
      const drift = Math.abs(measured - row.gzipKB);
      // Absolute floor for small bundles, relative for large ones.
      if (drift > 0.6 && drift / measured > 0.12) {
        stale.push(
          `${budget.specifier}: page says ${row.gzipKB} KB, measures ${measured.toFixed(1)} KB`,
        );
      }
    }
    expect(
      stale,
      `the published measurements have drifted — run \`pnpm run bundle:update\`:\n${stale.join('\n')}`,
    ).toEqual([]);
  }, 120_000);
});
