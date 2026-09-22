/** Negative gates against the real installed artifacts, not private source workspaces. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { MCP_PACKAGE_NAME, PUBLIC_PACKAGE_NAME } from '../public-packages.js';

export function isPrivateSpecifier(specifier: string): boolean {
  return (
    specifier === 'totalfinance' ||
    specifier.startsWith('totalfinance/') ||
    specifier.startsWith('@totalfinance/')
  );
}

/** Decode actual import syntax (including import types/dynamic imports), not diagnostic strings. */
export function assertPublicModuleSpecifiers(
  source: string,
  file: string,
  mcp = false,
  artifactDirectory?: string,
): void {
  for (const { fileName: specifier } of ts.preProcessFile(source, true, true).importedFiles) {
    assert.ok(!isPrivateSpecifier(specifier), `${file}: private import escaped: ${specifier}`);
    const relativeImport = specifier.startsWith('./') || specifier.startsWith('../');
    assert.ok(
      relativeImport ||
        isBuiltin(specifier) ||
        (mcp &&
          (specifier === PUBLIC_PACKAGE_NAME ||
            specifier.startsWith(`${PUBLIC_PACKAGE_NAME}/`) ||
            specifier.startsWith('@modelcontextprotocol/sdk/'))),
      `${file}: unexpected runtime/declaration dependency: ${specifier}`,
    );
    if (relativeImport) {
      assert.match(specifier, /\.js$/, `${file}: import must resolve to an exact emitted module`);
      assert.ok(
        existsSync(resolve(dirname(file), specifier)),
        `${file}: missing imported file: ${specifier}`,
      );
      if (artifactDirectory) {
        const boundary = realpathSync(artifactDirectory);
        const target = realpathSync(resolve(dirname(file), specifier));
        assert.ok(
          target.startsWith(boundary + sep),
          `${file}: relative dependency escaped artifact: ${specifier}`,
        );
        assert.match(
          relative(boundary, target).split(sep).join('/'),
          mcp ? /^dist\// : /^modules\/[^/]+\/dist\//,
          `${file}: dependency bypassed emitted modules: ${specifier}`,
        );
      }
    }
  }
}

export interface PublicDependencyMetadata {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Run before npm install too: malformed artifacts must not trigger private registry fetches. */
export function assertPublicPackageDependencies(
  manifest: PublicDependencyMetadata,
  expectedName: string,
  expectedVersion: string,
): void {
  assert.equal(manifest.name, expectedName);
  assert.equal(manifest.version, expectedVersion);
  assert.deepEqual(manifest.optionalDependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies ?? {}, {});
  if (expectedName === MCP_PACKAGE_NAME) {
    assert.deepEqual(
      Object.keys(manifest.dependencies ?? {}).sort(),
      [PUBLIC_PACKAGE_NAME, '@modelcontextprotocol/sdk'].sort(),
    );
    assert.equal(manifest.dependencies?.[PUBLIC_PACKAGE_NAME], expectedVersion);
    const sdk = manifest.dependencies?.['@modelcontextprotocol/sdk'];
    assert.equal(typeof sdk, 'string');
    assert.ok(sdk!.trim().length > 0, 'MCP SDK version range is missing');
    assert.doesNotMatch(
      sdk!,
      /[:/\\]/,
      'MCP SDK must be a registry version range, never a private alias or workspace path',
    );
  } else {
    assert.equal(expectedName, PUBLIC_PACKAGE_NAME);
    assert.deepEqual(manifest.dependencies ?? {}, {});
  }
}

interface PublicManifest extends PublicDependencyMetadata {
  private?: boolean;
  sideEffects: boolean;
  exports: Record<string, string | { types: string; import: string; default: string }>;
}

/** Returns counts so callers cannot accidentally audit an empty/missing distribution. */
export function assertInstalledPublicArtifacts(
  consumer: string,
  expectedVersion: string,
): {
  javascript: number;
  declarations: number;
  maps: number;
} {
  const modules = realpathSync(join(consumer, 'node_modules'));
  const counts = { javascript: 0, declarations: 0, maps: 0 };
  assert.ok(!existsSync(join(modules, '@totalfinance')), 'Private scoped packages were installed');
  assert.ok(!existsSync(join(modules, 'totalfinance')), 'Private umbrella was installed');
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { dependencies?: Record<string, string> }>;
  };
  for (const [path, entry] of Object.entries(lock.packages)) {
    assert.doesNotMatch(
      path,
      /(?:^|\/)node_modules\/(?:@totalfinance\/|totalfinance(?:\/|$))/,
      `Private package exists in installed dependency tree: ${path}`,
    );
    for (const dependency of Object.keys(entry.dependencies ?? {}))
      assert.ok(
        !isPrivateSpecifier(dependency),
        `Private transitive dependency: ${path} -> ${dependency}`,
      );
  }
  for (const name of [PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME]) {
    const directory = realpathSync(join(modules, name));
    const manifest = JSON.parse(
      readFileSync(join(directory, 'package.json'), 'utf8'),
    ) as PublicManifest;
    const mcp = name === MCP_PACKAGE_NAME;
    assertPublicPackageDependencies(manifest, name, expectedVersion);
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.sideEffects, false);
    if (!mcp) {
      assert.ok(
        !existsSync(join(directory, 'modules', 'mcp')),
        'MCP implementation shipped in main',
      );
      for (const key of [
        '.',
        './workflows',
        './workflows/local',
        './cli',
        './http',
        './package.json',
      ])
        assert.ok(Object.hasOwn(manifest.exports, key), `Missing public export: ${key}`);
      assert.ok(!Object.hasOwn(manifest.exports, './mcp'), 'Main exposes optional MCP');
    }
    const emitted = mcp ? /^dist\// : /^modules\/[^/]+\/dist\//;
    for (const [key, target] of Object.entries(manifest.exports)) {
      if (key === './package.json') {
        assert.equal(target, './package.json');
        continue;
      }
      assert.ok(!key.endsWith('/package.json'), `Private domain manifest exposed: ${key}`);
      assert.equal(typeof target, 'object', `Missing typed ESM export: ${key}`);
      if (typeof target === 'string') continue;
      assert.deepEqual(
        Object.keys(target).sort(),
        ['default', 'import', 'types'],
        `Missing export condition: ${key}`,
      );
      assert.equal(target.import, target.default);
      for (const [condition, path] of Object.entries(target)) {
        const installed = realpathSync(resolve(directory, path));
        assert.ok(installed.startsWith(directory + sep), `Export escaped artifact: ${key}`);
        assert.match(relative(directory, installed).split(sep).join('/'), emitted);
        assert.match(path, condition === 'types' ? /\.d\.ts$/ : /\.js$/);
      }
    }
    for (const path of readdirSync(directory, { recursive: true }) as string[]) {
      const normalized = path.split(sep).join('/');
      if (!emitted.test(normalized)) continue;
      const file = join(directory, path);
      if (/\.(?:js|d\.ts)$/.test(path)) {
        assertPublicModuleSpecifiers(readFileSync(file, 'utf8'), file, mcp, directory);
        counts[path.endsWith('.d.ts') ? 'declarations' : 'javascript']++;
        assert.ok(existsSync(file + '.map'), `Missing source map: ${file}`);
      } else if (path.endsWith('.map')) {
        const map = JSON.parse(readFileSync(file, 'utf8')) as {
          sourceRoot?: string;
          sources: string[];
        };
        assert.ok(map.sources.length > 0, `Empty source map: ${file}`);
        for (const source of map.sources) {
          const original = realpathSync(resolve(dirname(file), map.sourceRoot ?? '', source));
          assert.ok(original.startsWith(directory + sep), `Source map escaped artifact: ${file}`);
          assert.match(
            relative(directory, original).split(sep).join('/'),
            mcp ? /^src\// : /^modules\/[^/]+\/src\//,
          );
        }
        counts.maps++;
      }
    }
  }
  return counts;
}
