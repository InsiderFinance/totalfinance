import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KB, measureBundle } from './measure.js';
import { BUNDLE_BUDGETS } from './budgets.js';
import { workspaceAlias } from './workspace-alias.js';

const root = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));

const alias = workspaceAlias();

/**
 * Spec §21.5 — whole-entrypoint ceilings (all exports retained). Installed-consumer budgets
 * separately cover the actual cost of selected functions and import spellings across bundlers.
 *
 * The budgets, their rationales, and the structural guarantees are declared in `budgets.ts`, because
 * the published table in `docs/bundle-size.md` is generated from the same record. Keeping them apart
 * is what let the doc publish "< 14 KB" for `@insiderfinance/totalfinance/math` while this file allowed 33 KB, and omit
 * six budgeted entrypoints entirely.
 */
describe('bundle-size budgets', () => {
  for (const budget of BUNDLE_BUDGETS) {
    it(
      `${budget.specifier} is < ${budget.budgetKB} KB gzip`,
      async () => {
        const measured = await measureBundle(root(budget.entry), alias);
        // Structural guarantees first: they are the budget's real content, and a byte count that
        // passes while a validator leaked onto the hot path would be the wrong thing to celebrate.
        for (const { needle, why } of budget.forbidden ?? []) {
          expect(
            measured.code,
            `${budget.specifier} must not bundle ${needle} — ${why}`,
          ).not.toContain(needle);
        }
        expect(
          measured.bytesGzip,
          `${budget.specifier} gzip=${measured.bytesGzip}B min=${measured.bytesMin}B`,
        ).toBeLessThan(budget.budgetKB * KB);
      },
      budget.timeoutMs,
    );
  }
});
