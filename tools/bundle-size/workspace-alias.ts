/**
 * The FULL workspace alias map, derived from every package's `exports` map (dist target → src file),
 * longest specifier first (esbuild prefix-remaps, so subpath aliases must outrank the bare package).
 *
 * Derived rather than hand-listed, because a hand-list silently rots as subpaths are added. Shared by
 * `budgets.test.ts` and `tools/bundle-size-doc.ts` so the enforced measurement and the published one
 * resolve imports identically.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (path: string): string => fileURLToPath(new URL(`../../${path}`, import.meta.url));

export function workspaceAlias(): Record<string, string> {
  const entries: [string, string][] = [];
  for (const dir of readdirSync(root('packages')).sort()) {
    let manifest: { name?: string; exports?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(root(`packages/${dir}/package.json`), 'utf8'));
    } catch {
      continue;
    }
    if (!manifest.name || !manifest.exports) continue;
    for (const [key, value] of Object.entries(manifest.exports)) {
      if (key === './package.json') continue;
      const target =
        typeof value === 'string'
          ? value
          : ((value as Record<string, string>)['import'] ??
            (value as Record<string, string>)['default']);
      if (!target) continue;
      const source = target.replace('./dist/', `packages/${dir}/src/`).replace(/\.js$/, '.ts');
      entries.push([
        key === '.' ? manifest.name : `${manifest.name}/${key.slice(2)}`,
        root(source),
      ]);
    }
  }
  entries.sort((a, b) => b[0].length - a[0].length);
  return Object.fromEntries(entries);
}
