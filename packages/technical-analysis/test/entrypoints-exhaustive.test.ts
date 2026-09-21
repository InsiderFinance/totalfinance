import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * CI-owned exhaustive deep-entrypoint coverage: imports EVERY subpath declared in the package's
 * `exports` map (read from package.json, not a hand-maintained list) and asserts it resolves to a
 * module with at least one binding. A new `exports` entry without a matching test/alias fails here,
 * so the deep-import surface can't silently drift (the sampled entrypoints.test.ts complements this
 * with usage examples).
 */

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
) as { exports: Record<string, unknown> };

const specifiers = Object.keys(pkg.exports)
  .filter((k) => k !== './package.json')
  .map((k) =>
    k === '.'
      ? '@totalfinance/technical-analysis'
      : `@totalfinance/technical-analysis/${k.slice(2)}`,
  );

describe('exhaustive deep-entrypoint coverage', () => {
  it('declares a meaningful number of entrypoints', () => {
    expect(specifiers.length).toBeGreaterThan(25);
  });

  // Importing every subpath transforms (and, under --coverage, instruments) the whole package
  // graph in one test, which exceeds Vitest's 5s default. Give it a generous explicit timeout.
  it('every package.json export resolves and exposes ≥1 binding', async () => {
    const failures: string[] = [];
    for (const specification of specifiers) {
      try {
        const mod = (await import(/* @vite-ignore */ specification)) as Record<string, unknown>;
        const names = Object.keys(mod).filter((n) => n !== 'default');
        if (names.length === 0) failures.push(`${specification}: resolved but exports nothing`);
      } catch (e) {
        failures.push(`${specification}: ${(e as Error).message}`);
      }
    }
    expect(failures, `unresolved/empty entrypoints:\n${failures.join('\n')}`).toEqual([]);
  }, 30_000);
});
