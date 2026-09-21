/**
 * Write a generated document in the form the repository actually commits.
 *
 * Generated markdown used to be written raw, and `prettier --write .` then reformatted it in place.
 * That made the generator's own output DIFFERENT from the committed file — `ta-indicators.md` was
 * 44,258 bytes on disk against 18,227 from the generator, entirely in table padding. Two things follow
 * from that gap, and both are bad:
 *
 *   - No drift test was possible. A byte comparison against the generator would have failed on every
 *     run, so the only three TA reference docs in the repository had no regeneration guard at all and
 *     could have been hand-edited without anything noticing.
 *   - Running the generator was not idempotent. `pnpm run format` immediately dirtied the tree again.
 *
 * Formatting here — with the repository's own prettier and its own resolved config — closes both. The
 * generator now emits exactly what is committed, so `toBe` is a legitimate assertion and running a
 * generator twice is a no-op.
 */

import { writeFileSync } from 'node:fs';
import { format, resolveConfig } from 'prettier';

/** Format `content` as the repo formats it, then write it to `path`. */
export async function writeGenerated(path: string, content: string): Promise<string> {
  const formatted = await formatGenerated(path, content);
  writeFileSync(path, formatted, 'utf8');
  return formatted;
}

/**
 * Format `content` the way the repository's prettier would.
 *
 * Exported separately so a drift test can compare in memory without touching the working tree — a
 * test that regenerates files on disk is not a test, it is a mutation with an assertion attached.
 */
export async function formatGenerated(path: string, content: string): Promise<string> {
  const config = await resolveConfig(path);
  return format(content, { ...config, filepath: path });
}
