import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { executeSnippet, extractTsBlocks, readmeAliasMap } from '../../tools/readme-exec.js';

const guideUrl = new URL('./imports-and-bundles.md', import.meta.url);
const guide = readFileSync(guideUrl, 'utf8');
const normalized = (text: string): string => text.replace(/\s+/g, ' ');

describe('public imports and bundles guidance', () => {
  it('distinguishes import forms, runtime services, and the three different size questions', () => {
    const text = normalized(guide);
    for (const advice of [
      'named imports from `totalfinance/<domain>` or `@totalfinance/<domain>`',
      'Installation size',
      'Final bundle size',
      'Plain Node ESM loading',
      'no automatic dead-code elimination',
      'retains the whole math namespace',
      'Rollup shakes this static use',
      'math[name]',
      'Object.values(math)',
      'registries',
      'Type-only imports',
      'add no runtime code',
      'input validation, typed errors, and `.explain()`',
      'streaming and serialization',
      'not the cost of a bare formula',
      'Whole-entrypoint budgets and used-function consumer budgets',
      'unpublished preview',
    ])
      expect(text).toContain(advice);
    expect(guide).toContain('https://github.com/evanw/esbuild/issues/1420');
    expect(guide).toContain('](../bundle-size.md)');
    expect(existsSync(new URL('../bundle-size.md', guideUrl))).toBe(true);
    // Measurements belong to the generated report, not a second manual budget table.
    expect(guide).not.toMatch(/\b\d+(?:\.\d+)?\s*(?:KiB|KB|bytes)\b/);
  });

  it('uses only supported public entrypoints in its executable examples', () => {
    const aliases = readmeAliasMap();
    const blocks = extractTsBlocks(guide);
    expect(blocks).toHaveLength(5);
    for (const block of blocks) {
      const specifier = /from '([^']+)'/.exec(block)![1]!;
      expect(aliases, specifier).toHaveProperty(specifier);
      expect(specifier).not.toContain('/dist/');
    }
    for (const specifier of [
      '@totalfinance/technical-analysis/rsi',
      '@totalfinance/options/black-scholes',
    ])
      expect(aliases).toHaveProperty(specifier);
    expect(aliases).not.toHaveProperty('totalfinance/math/normal');
  });

  for (const [index, block] of extractTsBlocks(guide).entries()) {
    it(`executes normal-CDF import example ${index + 1} with the documented answer`, async () => {
      await executeSnippet(
        `const console = { log(value: number) {
          if (value !== 0.5) throw new Error('Expected normalCdf(0) to be 0.5');
        } };\n${block}`,
      );
    });
  }

  for (const path of ['../../README.md', '../getting-started.md']) {
    it(`${path} starts with runnable named domain imports and preserves root convenience`, async () => {
      const markdown = readFileSync(new URL(path, guideUrl), 'utf8');
      const text = normalized(markdown);
      const intro = extractTsBlocks(markdown)[0]!;
      for (const statement of [
        "import { blackScholes } from 'totalfinance/options';",
        "import { valueAtRisk } from 'totalfinance/risk';",
        "import { rsi } from 'totalfinance/technical-analysis';",
      ])
        expect(intro).toContain(statement);
      expect(intro).not.toContain("from 'totalfinance';");
      expect(text).not.toContain('options API is re-exported flat');
      expect(text).not.toContain('leanest possible bundle, install only');
      for (const name of ['blackScholes', 'option', 'market', 'engines', 'impliedVolatility'])
        expect(text).toContain(`\`${name}\``);
      expect(text).toContain('Rollup shakes this static use');
      expect(text).toContain('guides/imports-and-bundles.md)');
      await executeSnippet(intro);
    });
  }

  it('keeps the public start page linked to the guide rather than implementation trackers', () => {
    const startUrl = new URL('../../site/content/start.md', guideUrl);
    const start = readFileSync(startUrl, 'utf8');
    expect(start).toContain('](../../docs/guides/imports-and-bundles.md)');
    expect(start).toContain('unpublished preview');
    expect(normalized(start)).toContain('Type-only imports add no runtime code');
    for (const match of start.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!;
      expect(target).not.toMatch(/specs\/|implementation-order|completeness|roadmap/);
      if (!/^https?:/.test(target)) expect(existsSync(new URL(target, startUrl))).toBe(true);
    }
  });
});
