/**
 * Regenerate the technical-analysis indicator reference (`docs/guides/ta-indicators.md`) from the
 * live `@totalfinance/technical-analysis` registry. Run with `pnpm tsx tools/ta-registry-doc.ts`.
 */

import { fileURLToPath } from 'node:url';
import { writeGenerated } from './write-generated.js';
import { registryMarkdown } from '../packages/technical-analysis/src/registry.js';

const out = fileURLToPath(new URL('../docs/guides/ta-indicators.md', import.meta.url));

/** The document's content, before formatting. Exported so the drift test can compare in memory. */
export function taIndicatorsMarkdown(): string {
  return registryMarkdown() + '\n';
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  await writeGenerated(out, taIndicatorsMarkdown());
  process.stdout.write(`wrote ${out}\n`);
}
