import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MCP_PUBLISHED_ON_NPM } from '../site/src/agents.js';
import { buildMcpReadme, buildReadmes } from './readme-gen.js';

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

  it('keeps the CLI executable distinct from the package used to install it', () => {
    const content = readmes.find(({ dir }) => dir === 'cli')!.content;
    expect(content).toContain('behind the `totalfinance` command line');
    expect(content).not.toContain('behind the `@insiderfinance/totalfinance` command line');
    expect(content).toContain('pnpm add @insiderfinance/totalfinance@');
  });

  it('generates portable import guidance and a public guide link for every package', () => {
    // The MCP README is the server's npm page: it covers running the server, not SDK imports.
    for (const { dir, content } of readmes.filter((readme) => readme.dir !== 'mcp')) {
      expect(content, dir).toContain('## Imports and bundles');
      expect(content, dir).toContain('named imports from `@insiderfinance/totalfinance/<domain>`');
      expect(content, dir).toContain('`@insiderfinance/totalfinance/<domain>`');
      expect(content, dir).toContain('`@insiderfinance/totalfinance/math/normal`');
      expect(content, dir).toContain('Installation size is not final bundle size');
      expect(content, dir).toContain('Plain Node ESM performs no automatic dead-code elimination');
      expect(content, dir).toContain('validation and `.explain()`');
      expect(content, dir).toContain('streaming support, not just a bare formula');
      expect(content, dir).toContain('Type-only imports add no runtime code');
      expect(content, dir).toContain(
        '](https://github.com/InsiderFinance/totalfinance/blob/main/docs/guides/imports-and-bundles.md)',
      );
      const manifest = JSON.parse(
        readFileSync(new URL(`../packages/${dir}/package.json`, import.meta.url), 'utf8'),
      ) as { version: string };
      expect(content, dir).toContain(`Source version ${manifest.version}`);
      expect(content, dir).toContain(`@${manifest.version}`);
      expect(content, dir).not.toContain('@totalfinance/');
      expect(content, dir).toContain('not a verified npm installation');
    }
  });

  it('commits the MCP README for the current publication state', () => {
    expect(readmes.find(({ dir }) => dir === 'mcp')!.content).toBe(
      buildMcpReadme(MCP_PUBLISHED_ON_NPM),
    );
  });

  it('describes the MCP source build, and no npm install, while the server is not on npm', () => {
    const content = buildMcpReadme(false);
    expect(content).toContain('is not on npm yet');
    expect(content).toContain('node distribution/mcp/dist/bin.js doctor');
    expect(content).not.toContain('npx');
    expect(content).not.toContain('@insiderfinance/totalfinance-mcp@');
    expect(content).toContain(
      'claude mcp add totalfinance -- node /absolute/path/to/totalfinance/distribution/mcp/dist/bin.js',
    );
  });

  it('gives the npx setup for every client once the server is on npm', () => {
    const content = buildMcpReadme(true);
    const manifest = JSON.parse(
      readFileSync(new URL('../packages/mcp/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const run = `npx -y @insiderfinance/totalfinance-mcp@${manifest.version}`;
    expect(content).not.toContain('not on npm');
    expect(content).toContain(`${run} doctor`);
    expect(content).toContain(`claude mcp add totalfinance -- ${run}`);
    expect(content).toContain(`codex mcp add totalfinance -- ${run}`);
    for (const client of ['Claude Code', 'Claude Desktop', 'Cursor', 'VS Code', 'Codex'])
      expect(content).toContain(`### ${client}`);
    expect(content).toContain('"command": "npx"');
    expect(content).toContain('| `full` | 42 |');
    expect(content).not.toContain('@totalfinance/');
  });

  it('starts the umbrella example with domain imports while preserving namespace convenience', () => {
    const content = readmes.find(({ dir }) => dir === 'totalfinance')!.content;
    const example = content.split('## Example\n')[1]!.split('## Imports and bundles')[0]!;
    expect(example).toContain(
      "import { blackScholes } from '@insiderfinance/totalfinance/options'",
    );
    expect(example).toContain(
      "import { rsi } from '@insiderfinance/totalfinance/technical-analysis'",
    );
    expect(example).not.toContain("from '@insiderfinance/totalfinance';");
    for (const name of ['blackScholes', 'option', 'market', 'engines', 'impliedVolatility'])
      expect(content).toContain(`\`${name}\``);
    expect(content).toContain('hoists only five option gestures');
    expect(content).toContain("import { math } from '@insiderfinance/totalfinance'");
    expect(content).toContain('retains the whole math namespace in esbuild');
    expect(content).toContain('https://github.com/evanw/esbuild/issues/1420');
    expect(content).toContain('Rollup shakes this static use');
    expect(content).toContain("import * as math from '@insiderfinance/totalfinance/math'");
    expect(content).toContain('Dynamic namespace access, enumeration, and registries');
  });
});
