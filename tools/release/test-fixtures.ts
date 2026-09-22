/** Synthetic, local-only release fixtures; these are never public release evidence. */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MCP_PACKAGE_NAME, PUBLIC_PACKAGE_NAME } from '../public-packages.js';
import { tarballName, type ReleaseArtifact, type ReleaseManifest } from './artifact-policy.js';

export function fixtureMetadata(name = PUBLIC_PACKAGE_NAME): Record<string, unknown> {
  const main = name === PUBLIC_PACKAGE_NAME;
  const base = main ? './modules/totalfinance/dist' : './dist';
  const target = {
    types: `${base}/index.d.ts`,
    import: `${base}/index.js`,
    default: `${base}/index.js`,
  };
  return {
    name,
    version: '0.1.0',
    type: 'module',
    license: 'Apache-2.0',
    sideEffects: false,
    engines: { node: '>=22.13.0' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/InsiderFinance/totalfinance.git',
      directory: main ? 'distribution/totalfinance' : 'distribution/mcp',
    },
    publishConfig: { access: 'public', provenance: true },
    main: `${base}/index.js`,
    module: `${base}/index.js`,
    types: `${base}/index.d.ts`,
    exports: {
      '.': target,
      './package.json': './package.json',
      ...(main
        ? Object.fromEntries(
            ['./workflows', './cli', './http', './options/black-scholes'].map((key) => [
              key,
              target,
            ]),
          )
        : {}),
    },
    bin: main
      ? {
          totalfinance: './modules/cli/dist/bin.js',
          'totalfinance-http': './modules/http/dist/bin.js',
        }
      : { 'totalfinance-mcp': './dist/bin.js' },
    dependencies: main
      ? {}
      : { [PUBLIC_PACKAGE_NAME]: '0.1.0', '@modelcontextprotocol/sdk': '^1.12.0' },
  };
}

export interface TarEntry {
  name: string;
  body: string;
  type?: string;
  link?: string;
}

/** Minimal deterministic ustar writer, including unsafe names/links for refusal tests. */
export function fixtureTar(entries: TarEntry[]): Buffer {
  const buffers: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.body);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write('00000000000\0', 136, 12);
    header.fill(' ', 148, 156);
    header.write(entry.type ?? '0', 156, 1);
    if (entry.link) header.write(entry.link, 157, 100);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    header.write(
      `${header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0')}\0 `,
      148,
      8,
    );
    buffers.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...buffers, Buffer.alloc(1024)]));
}

export function fixtureEntries(name = PUBLIC_PACKAGE_NAME): TarEntry[] {
  const pkg = fixtureMetadata(name);
  const files: Record<string, string> = {
    'package/package.json': JSON.stringify(pkg),
    'package/LICENSE': 'Apache-2.0',
    'package/STABILITY.md': 'Pre-1.0',
    'package/README.md': 'Synthetic test fixture',
  };
  const js = [pkg['main'] as string, ...Object.values(pkg['bin'] as Record<string, string>)];
  for (const path of js) {
    const file = `package/${path.slice(2)}`;
    files[file] = '// Example: import { x } from "@totalfinance/core";\nexport const x = 1;\n';
    files[file.replace(/\.js$/, '.d.ts')] = 'export declare const x = 1;\n';
    const source = `../src/${posix.basename(file, '.js')}.ts`;
    files[`${file}.map`] = JSON.stringify({ version: 3, sourceRoot: '', sources: [source] });
    files[posix.join(posix.dirname(file), source)] = 'export const x = 1;\n';
  }
  return Object.entries(files).map(([name, body]) => ({ name, body }));
}

export function writeFixtureArtifact(
  dir: string,
  name: string,
  entries = fixtureEntries(name),
): ReleaseArtifact {
  const bytes = fixtureTar(entries);
  const artifact = {
    package: name,
    version: '0.1.0',
    tarball: tarballName(name, '0.1.0'),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  writeFileSync(join(dir, artifact.tarball), bytes);
  return artifact;
}

export function writeFixtureGroup(dir: string): ReleaseManifest {
  const manifest = {
    version: '0.1.0',
    commit: 'a'.repeat(40),
    sourceDirty: false,
    packages: [
      writeFixtureArtifact(dir, PUBLIC_PACKAGE_NAME),
      writeFixtureArtifact(dir, MCP_PACKAGE_NAME),
    ],
  };
  writeFileSync(join(dir, 'RELEASE_HASHES.json'), JSON.stringify(manifest));
  return manifest;
}
