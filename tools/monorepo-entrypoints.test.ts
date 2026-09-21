import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * DX7.2 — the monorepo-wide entrypoint property test. Generalizes the ta-only
 * `entrypoints-exhaustive.test.ts` to EVERY workspace package: read each package's `exports` map
 * (not a hand-list), import every declared subpath, and assert it resolves to a module with ≥1
 * binding. A new `exports` entry without a working alias/source — anywhere in the monorepo — fails
 * here, so the whole public deep-import surface cannot silently drift.
 */

const PKG_DIR = fileURLToPath(new URL('../packages', import.meta.url));

function packageSpecifiers(): { name: string; specifiers: string[] }[] {
  const out: { name: string; specifiers: string[] }[] = [];
  for (const dir of readdirSync(PKG_DIR).sort()) {
    let manifest: { name?: string; exports?: Record<string, unknown> };
    try {
      manifest = JSON.parse(readFileSync(`${PKG_DIR}/${dir}/package.json`, 'utf8'));
    } catch {
      continue;
    }
    if (!manifest.name || !manifest.exports) continue;
    const specifiers = Object.keys(manifest.exports)
      .filter((k) => k !== './package.json')
      .map((k) => (k === '.' ? manifest.name! : `${manifest.name}/${k.slice(2)}`));
    out.push({ name: manifest.name, specifiers });
  }
  return out;
}

describe('DX7.2 monorepo-wide entrypoint exhaustiveness', () => {
  const pkgs = packageSpecifiers();

  it('covers every workspace package (13 scoped + the umbrella)', () => {
    expect(pkgs.length).toBeGreaterThanOrEqual(14);
  });

  it('every conditional exports entry ends with a `default` condition (F10 — require never dead-ends)', () => {
    const missing: string[] = [];
    for (const dir of readdirSync(PKG_DIR).sort()) {
      let manifest: { name?: string; exports?: Record<string, unknown> };
      try {
        manifest = JSON.parse(readFileSync(`${PKG_DIR}/${dir}/package.json`, 'utf8'));
      } catch {
        continue;
      }
      if (!manifest.name || !manifest.exports) continue;
      for (const [key, val] of Object.entries(manifest.exports)) {
        if (key === './package.json') continue;
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const conditions = Object.keys(val as Record<string, unknown>);
          // A conditional map without `default` dead-ends any resolver that doesn't set `import`
          // (bare require, tooling) with ERR_PACKAGE_PATH_NOT_EXPORTED. `default` must also be last.
          if (!conditions.includes('default')) {
            missing.push(`${manifest.name} ${key}: [${conditions.join(', ')}]`);
          } else if (conditions[conditions.length - 1] !== 'default') {
            missing.push(`${manifest.name} ${key}: default is not the last condition`);
          }
        }
      }
    }
    expect(missing, `exports entries missing a trailing default:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });

  // Importing every subpath transforms the whole workspace graph in one test — well past Vitest's
  // 5s default — so this gets a generous explicit timeout.
  it('every package.json export across the monorepo resolves and exposes ≥1 binding', async () => {
    const failures: string[] = [];
    for (const { specifiers } of pkgs) {
      for (const specification of specifiers) {
        try {
          const mod = (await import(/* @vite-ignore */ specification)) as Record<string, unknown>;
          const names = Object.keys(mod).filter((n) => n !== 'default');
          if (names.length === 0) failures.push(`${specification}: resolved but exports nothing`);
        } catch (e) {
          failures.push(`${specification}: ${(e as Error).message}`);
        }
      }
    }
    expect(failures, `unresolved/empty entrypoints:\n${failures.join('\n')}`).toEqual([]);
  }, 120_000);
});
