import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildReadmes } from './readme-gen.js';

// Drift guard (DX4.2): the committed per-package READMEs must match what the generator produces from
// the live manifests, API reports, and CI-run example snippets. Regenerate with
// `pnpm tsx tools/readme-gen.ts` after any public-API or example change.
describe('DX4.2 per-package READMEs are up to date', () => {
  for (const { dir, content } of buildReadmes()) {
    it(`packages/${dir}/README.md matches the generator`, () => {
      const committed = readFileSync(
        fileURLToPath(new URL(`../packages/${dir}/README.md`, import.meta.url)),
        'utf8',
      );
      expect(committed).toBe(content);
    });
  }
});

describe('package README import guidance', () => {
  const readmes = buildReadmes();

  it('generates portable import guidance and a public guide link for every package', () => {
    for (const { dir, content } of readmes) {
      expect(content, dir).toContain('## Imports and bundles');
      expect(content, dir).toContain('named imports from `totalfinance/<domain>`');
      expect(content, dir).toContain('`@totalfinance/<domain>`');
      expect(content, dir).toContain('`@totalfinance/math/normal`');
      expect(content, dir).toContain('Installation size is not final bundle size');
      expect(content, dir).toContain('Plain Node ESM performs no automatic dead-code elimination');
      expect(content, dir).toContain('validation and `.explain()`');
      expect(content, dir).toContain('streaming support, not just a bare formula');
      expect(content, dir).toContain('Type-only imports add no runtime code');
      expect(content, dir).toContain(
        '](https://github.com/InsiderFinance/totalfinance/blob/main/docs/guides/imports-and-bundles.md)',
      );
      expect(content, dir).toContain('Unpublished preview');
      expect(content, dir).toContain('not a verified npm installation');
    }
  });

  it('starts the umbrella example with domain imports while preserving namespace convenience', () => {
    const content = readmes.find(({ dir }) => dir === 'totalfinance')!.content;
    const example = content.split('## Example\n')[1]!.split('## Imports and bundles')[0]!;
    expect(example).toContain("import { blackScholes } from 'totalfinance/options'");
    expect(example).toContain("import { rsi } from 'totalfinance/technical-analysis'");
    expect(example).not.toContain("from 'totalfinance';");
    for (const name of ['blackScholes', 'option', 'market', 'engines', 'impliedVolatility'])
      expect(content).toContain(`\`${name}\``);
    expect(content).toContain('hoists only five option gestures');
    expect(content).toContain("import { math } from 'totalfinance'");
    expect(content).toContain('retains the whole math namespace in esbuild');
    expect(content).toContain('https://github.com/evanw/esbuild/issues/1420');
    expect(content).toContain('Rollup shakes this static use');
    expect(content).toContain("import * as math from 'totalfinance/math'");
    expect(content).toContain('Dynamic namespace access, enumeration, and registries');
  });
});
