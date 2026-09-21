/**
 * Regenerate the TA warmup / lookahead / displacement reference (`docs/guides/ta-warmup.md`) from
 * the live `@totalfinance/technical-analysis` registry. Run with `pnpm tsx tools/ta-warmup-doc.ts`.
 */

import { fileURLToPath } from 'node:url';
import { writeGenerated } from './write-generated.js';
import { warmupMarkdown } from '../packages/technical-analysis/src/warmup.js';

const out = fileURLToPath(new URL('../docs/guides/ta-warmup.md', import.meta.url));

/** The document's content, before formatting. Exported so the drift test can compare in memory. */
export function taWarmupMarkdown(): string {
  return warmupMarkdown() + '\n';
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  await writeGenerated(out, taWarmupMarkdown());
  process.stdout.write(`wrote ${out}\n`);
}
