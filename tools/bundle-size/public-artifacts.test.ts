import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertInstalledPublicArtifacts,
  assertPublicModuleSpecifiers,
  assertPublicPackageDependencies,
  isPrivateSpecifier,
} from './public-artifacts.js';
import { MCP_PACKAGE_NAME, PUBLIC_PACKAGE_NAME } from '../public-packages.js';

describe('published module dependency audit', () => {
  let directory: string;
  let file: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'public-artifact-audit-'));
    file = join(directory, 'index.d.ts');
    writeFileSync(join(directory, 'leaf.js'), 'export const value = 1;');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it.each([
    "import { value } from '@totalfinance/core';",
    "export { value } from 'totalfinance/options';",
    "export * from '@totalfinance/math/normal';",
    "const value = import('@totalfinance/workflows/local');",
    "type Value = import('@totalfinance/core').Value;",
    "import type { Value } from 'totalfinance';",
    "const value = require('@totalfinance/core');",
  ])('rejects private static, dynamic and declaration imports: %s', (source) => {
    expect(() => assertPublicModuleSpecifiers(source, file)).toThrow('private import escaped');
    expect(() => assertPublicModuleSpecifiers(source, file, true)).toThrow(
      'private import escaped',
    );
  });

  it('accepts exact local imports, Node builtins, and explanatory strings without private dependencies', () => {
    expect(() =>
      assertPublicModuleSpecifiers(
        `
      export { value } from './leaf.js';
      type Value = import('./leaf.js').Value;
      import { readFileSync } from 'node:fs';
      // import '@totalfinance/core';
      const message = "build @totalfinance/cli first";
    `,
        file,
      ),
    ).not.toThrow();
  });

  it('rejects missing and non-exact relative module files', () => {
    expect(() => assertPublicModuleSpecifiers("export * from './missing.js'", file)).toThrow(
      'missing imported file',
    );
    expect(() => assertPublicModuleSpecifiers("export * from './leaf'", file)).toThrow(
      'exact emitted module',
    );
  });

  it('rejects a relative dependency escaping the artifact or bypassing emitted dist', () => {
    mkdirSync(join(directory, 'other'));
    expect(() =>
      assertPublicModuleSpecifiers("export * from './leaf.js'", file, false, directory),
    ).toThrow('dependency bypassed emitted modules');
    expect(() =>
      assertPublicModuleSpecifiers(
        "export * from './leaf.js'",
        file,
        false,
        join(directory, 'other'),
      ),
    ).toThrow('relative dependency escaped artifact');
  });

  it('only MCP may depend on the public main package and SDK', () => {
    const source = `
      import { InputError } from '@insiderfinance/totalfinance/core';
      import { Server } from '@modelcontextprotocol/sdk/server/index.js';
    `;
    expect(() => assertPublicModuleSpecifiers(source, file)).toThrow(
      'unexpected runtime/declaration dependency',
    );
    expect(() => assertPublicModuleSpecifiers(source, file, true)).not.toThrow();
    expect(() => assertPublicModuleSpecifiers("import 'unlisted-dependency'", file, true)).toThrow(
      'unexpected runtime/declaration dependency',
    );
    expect(isPrivateSpecifier('totalfinance')).toBe(true);
    expect(isPrivateSpecifier('totalfinance/options')).toBe(true);
    expect(isPrivateSpecifier('@totalfinance/core')).toBe(true);
    expect(isPrivateSpecifier('@insiderfinance/totalfinance')).toBe(false);
    expect(isPrivateSpecifier('@insiderfinance/totalfinance-mcp')).toBe(false);
  });

  it('uses the supplied release version for both artifacts and the exact MCP dependency', () => {
    const version = '0.1.1';
    writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: {} }));
    for (const name of [PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME]) {
      const mcp = name === MCP_PACKAGE_NAME;
      const artifact = join(directory, 'node_modules', name);
      const prefix = mcp ? '' : 'modules/core/';
      const dist = join(artifact, prefix, 'dist');
      const src = join(artifact, prefix, 'src');
      mkdirSync(dist, { recursive: true });
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'index.ts'), 'export const value = 1;');
      for (const extension of ['js', 'd.ts']) {
        writeFileSync(
          join(dist, `index.${extension}`),
          extension === 'js' ? 'export const value = 1;' : 'export declare const value: number;',
        );
        writeFileSync(
          join(dist, `index.${extension}.map`),
          JSON.stringify({ sources: ['../src/index.ts'] }),
        );
      }
      const keys = mcp ? ['.'] : ['.', './workflows', './workflows/local', './cli', './http'];
      writeFileSync(
        join(artifact, 'package.json'),
        JSON.stringify({
          name,
          version,
          sideEffects: false,
          dependencies: mcp
            ? { [PUBLIC_PACKAGE_NAME]: version, '@modelcontextprotocol/sdk': '^1.12.0' }
            : {},
          exports: {
            ...Object.fromEntries(
              keys.map((key) => [
                key,
                {
                  types: `./${prefix}dist/index.d.ts`,
                  import: `./${prefix}dist/index.js`,
                  default: `./${prefix}dist/index.js`,
                },
              ]),
            ),
            './package.json': './package.json',
          },
        }),
      );
    }
    expect(assertInstalledPublicArtifacts(directory, version)).toEqual({
      javascript: 2,
      declarations: 2,
      maps: 4,
    });
    expect(() => assertInstalledPublicArtifacts(directory, '0.1.0')).toThrow();
  });
});

describe('pre-install dependency gate', () => {
  const main = { name: PUBLIC_PACKAGE_NAME, version: '0.1.1', dependencies: {} };
  const mcp = {
    name: MCP_PACKAGE_NAME,
    version: '0.1.1',
    dependencies: {
      [PUBLIC_PACKAGE_NAME]: '0.1.1',
      '@modelcontextprotocol/sdk': '^1.12.0',
    },
  };

  it('permits only a dependency-free main and MCP with exact main plus the SDK', () => {
    expect(() => assertPublicPackageDependencies(main, PUBLIC_PACKAGE_NAME, '0.1.1')).not.toThrow();
    expect(() => assertPublicPackageDependencies(mcp, MCP_PACKAGE_NAME, '0.1.1')).not.toThrow();
  });

  it.each([
    { ...main, dependencies: { '@totalfinance/core': '0.1.1' } },
    { ...main, dependencies: { totalfinance: '0.1.1' } },
    { ...main, peerDependencies: { '@totalfinance/core': '*' } },
    { ...main, optionalDependencies: { '@totalfinance/core': '*' } },
    { ...mcp, dependencies: { ...mcp.dependencies, '@totalfinance/core': '0.1.1' } },
    { ...mcp, dependencies: { ...mcp.dependencies, [PUBLIC_PACKAGE_NAME]: '^0.1.1' } },
    {
      ...mcp,
      dependencies: {
        ...mcp.dependencies,
        '@modelcontextprotocol/sdk': 'npm:@totalfinance/core@0.1.1',
      },
    },
    { ...mcp, dependencies: { ...mcp.dependencies, '@modelcontextprotocol/sdk': 'workspace:*' } },
  ])('refuses dependency metadata before npm can fetch it: %j', (manifest) => {
    expect(() => assertPublicPackageDependencies(manifest, manifest.name, '0.1.1')).toThrow();
  });
});
