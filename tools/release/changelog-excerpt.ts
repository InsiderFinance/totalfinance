/**
 * Print the changelog section for one version — the GitHub release's notes (Stage 5A, Decision 6).
 * Reads the umbrella's `CHANGELOG.md`, which changesets writes for every version of the fixed group
 * (the entries are identical across the group because the group moves together).
 *
 *   pnpm exec tsx tools/release/changelog-excerpt.ts 0.1.0-preview.0
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function changelogExcerpt(changelog: string, version: string): string | undefined {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return `${lines
    .slice(start + 1, end)
    .join('\n')
    .trim()}\n`;
}

const version = process.argv[2];
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!version) {
    process.stderr.write('usage: changelog-excerpt <version>\n');
    process.exit(2);
  }
  const changelog = readFileSync(join(ROOT, 'packages', 'totalfinance', 'CHANGELOG.md'), 'utf8');
  const excerpt = changelogExcerpt(changelog, version);
  if (excerpt === undefined) {
    process.stderr.write(
      `no "## ${version}" section in packages/totalfinance/CHANGELOG.md — run 'pnpm exec changeset version' first\n`,
    );
    process.exit(2);
  }
  process.stdout.write(
    `${excerpt}\nThe attached \`RELEASE_HASHES.json\` names every artifact of this release by sha256; the tarballs on npm match it byte for byte.\n`,
  );
}
