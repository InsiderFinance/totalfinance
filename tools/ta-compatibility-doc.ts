/**
 * Regenerate the TA naming compatibility matrix (`docs/guides/ta-compatibility.md`) from the live
 * `@totalfinance/technical-analysis` alias table. Run with `pnpm tsx tools/ta-compatibility-doc.ts`.
 */

import { fileURLToPath } from 'node:url';
import { writeGenerated } from './write-generated.js';
import { compatibilityMatrixMarkdown } from '../packages/technical-analysis/src/aliases.js';

const out = fileURLToPath(new URL('../docs/guides/ta-compatibility.md', import.meta.url));

/** The document's content, before formatting. Exported so the drift test can compare in memory. */
export function taCompatibilityMarkdown(): string {
  return compatibilityMatrixMarkdown() + '\n';
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  await writeGenerated(out, taCompatibilityMarkdown());
  process.stdout.write(`wrote ${out}\n`);
}
