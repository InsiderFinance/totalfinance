/**
 * Phase 3B.N8-DOCS item 4 — generated documentation matches its generator.
 *
 * The rule is "update generators and templates before generated output", and its failure mode is
 * silent in both directions: a hand-edit to a generated file survives until someone regenerates, and
 * a generator whose SOURCE changed leaves the committed output stale until someone notices.
 *
 * The second one had already happened. `rollingQuantile`'s parameter was renamed `q` → `quantile`
 * during 3B.N, and `ta-indicators.md` and `ta-warmup.md` went on teaching `q` for the rest of the
 * phase because nothing compared them to the registry. Three of the four TA reference documents had
 * no drift guard at all.
 *
 * Worth being precise about why they had none: the generators wrote raw markdown, `prettier --write`
 * then reformatted it in place, and the committed file no longer matched the generator byte-for-byte
 * (44,258 bytes against 18,227, all of it table padding). A `toBe` would have failed on every run, so
 * there was nothing to write. Generators now format their own output via `writeGenerated`, which makes
 * the comparison below both possible and exact.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generatedDocs, buildGenerated } from './generated-docs.js';
import { formatGenerated } from './write-generated.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const docs = generatedDocs();

describe('generated documentation is regenerable (3B.N8-DOCS item 4)', () => {
  it('registers every generated surface with an owning generator', () => {
    // 22 package READMEs + 2 llms files + 4 TA references + the bundle report + 22 API reports.
    // 37 → 39 (FC0) → 41 (FC1) → 43 (FC3) → 45 (FC5) → 47 (FC6, 2026-08-19) → 49 (FC7, 2026-08-28) → 51 (Stage 4.4b) → 53 (Stage 7A slice 1, 2026-09-03: @totalfinance/workflows) → 55 (Stage 7A slice 3: @totalfinance/cli) → 57 (Stage 7A slice 5: @totalfinance/http): each package
    // joins both generated surfaces — its README (readme-gen) and its API report (api-report).
    expect(docs.length).toBe(82); // 57 → 82 (Stage 4.7 slice 3, 2026-09-04): the field reference — the index and one page per package;
    for (const doc of docs) {
      expect(doc.generator, `${doc.path} has no generator`).toBeTruthy();
      expect(
        readFileSync(resolve(ROOT, doc.path), 'utf8').length,
        `${doc.path} is empty`,
      ).toBeGreaterThan(0);
    }
  });

  it('the API reports are covered by a stronger check', () => {
    // They carry no `build` on purpose: `pnpm run api:check` compares them to the compiled `.d.ts`,
    // which is stronger than anything this file could assert. This test exists so that the absence
    // is a recorded decision rather than an oversight.
    const reports = docs.filter((doc) => doc.path.endsWith('.api.md'));
    // 15 → 16 (FC0) → 17 (FC1) → 18 (FC3) → 19 (FC5) → 20 (FC6) → 21 (FC7) → 22 (Stage 4.4b) → 23 (Stage 7A slice 1) → 24 (Stage 7A slice 3) → 25 (Stage 7A slice 5): each package's API
    // report joins the surface.
    expect(reports.length).toBe(25);
    for (const report of reports) {
      expect(report.build).toBeUndefined();
      expect(report.generator).toBe('tools/api-report');
    }
  });

  for (const doc of docs.filter((entry) => entry.build !== undefined)) {
    it(`${doc.path} matches ${doc.generator}`, async () => {
      const content = buildGenerated(doc);
      expect(content, `${doc.path} declares a build that returned nothing`).not.toBeNull();
      const expected = await formatGenerated(resolve(ROOT, doc.path), content!);
      const committed = readFileSync(resolve(ROOT, doc.path), 'utf8');
      expect(
        committed,
        `${doc.path} is out of date — run \`pnpm tsx ${doc.generator}\`. Hand-editing it is not a ` +
          `closeout; fix the generator instead.`,
      ).toBe(expected);
    });
  }

  it('regenerating is idempotent', async () => {
    // Formatting already-formatted output must be a no-op, or every CI run would dirty the tree and
    // the drift test above would be checking prettier's fixed point rather than the generator's.
    for (const doc of docs.filter((entry) => entry.build !== undefined)) {
      const path = resolve(ROOT, doc.path);
      const once = await formatGenerated(path, buildGenerated(doc)!);
      const twice = await formatGenerated(path, once);
      expect(twice, `${doc.path} does not reach a formatting fixed point`).toBe(once);
    }
  });
});
