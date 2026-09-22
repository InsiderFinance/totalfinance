import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME } from '../public-packages.js';
import {
  inspectTarball,
  validateManifest,
  validatePackageMetadata,
  verifyApproved,
} from './artifact-policy.js';
import { readFixedGroup } from './dry-run.js';
import {
  fixtureEntries,
  fixtureMetadata,
  writeFixtureArtifact,
  writeFixtureGroup,
} from './test-fixtures.js';

const temps: string[] = [];
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), 'totalfinance-release-policy-test-'));
  temps.push(path);
  return path;
}
afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('approved two-artifact policy', () => {
  it('checks real archive metadata, sources and hashes in dependency order, ignoring comment examples', () => {
    const dir = temp();
    const manifest = writeFixtureGroup(dir);
    expect(verifyApproved(dir)).toEqual(manifest);
    expect(manifest.packages.map((pkg) => pkg.package)).toEqual([
      PUBLIC_PACKAGE_NAME,
      MCP_PACKAGE_NAME,
    ]);
  });

  it.each([
    'empty',
    'missing',
    'extra',
    'duplicate',
    'reversed',
    'version',
    'traversal',
    'absolute',
    'hash',
    'length',
    'commit',
  ])('rejects a %s manifest before trusting files', (kind) => {
    const manifest = writeFixtureGroup(temp());
    if (kind === 'empty') manifest.packages = [];
    if (kind === 'missing') manifest.packages.pop();
    if (kind === 'extra') manifest.packages.push(manifest.packages[0]!);
    if (kind === 'duplicate') manifest.packages[1] = manifest.packages[0]!;
    if (kind === 'reversed') manifest.packages.reverse();
    if (kind === 'version') manifest.packages[1]!.version = '0.1.1';
    if (kind === 'traversal') manifest.packages[0]!.tarball = '../outside.tgz';
    if (kind === 'absolute') manifest.packages[0]!.tarball = '/tmp/outside.tgz';
    if (kind === 'hash') manifest.packages[0]!.sha256 = 'abc';
    if (kind === 'length') manifest.packages[0]!.bytes = -1;
    if (kind === 'commit') manifest.commit = 'HEAD';
    expect(() => validateManifest(manifest)).toThrow();
  });

  it.each([
    'private',
    'identity',
    'floor',
    'repository',
    'dependencies',
    'optional',
    'peer',
    'dev',
    'bundle',
    'provenance',
    'registry',
    'tag-override',
    'hook',
    'bin',
    'exports',
  ])('rejects %s metadata even when tarball hashes match', (kind) => {
    const pkg = fixtureMetadata();
    if (kind === 'private') pkg['private'] = true;
    if (kind === 'identity') pkg['name'] = '@totalfinance/core';
    if (kind === 'floor') pkg['engines'] = { node: '>=20' };
    if (kind === 'repository') pkg['repository'] = { type: 'git', url: 'https://example.com' };
    if (kind === 'dependencies') pkg['dependencies'] = { '@totalfinance/core': '0.1.0' };
    if (kind === 'optional') pkg['optionalDependencies'] = { unwanted: '1.0.0' };
    if (kind === 'peer') pkg['peerDependencies'] = { unwanted: '1.0.0' };
    if (kind === 'dev') pkg['devDependencies'] = { unwanted: '1.0.0' };
    if (kind === 'bundle') pkg['bundledDependencies'] = ['unwanted'];
    if (kind === 'provenance') pkg['publishConfig'] = { access: 'public', provenance: false };
    if (kind === 'registry')
      pkg['publishConfig'] = {
        access: 'public',
        provenance: true,
        registry: 'https://example.com',
      };
    if (kind === 'tag-override')
      pkg['publishConfig'] = { access: 'public', provenance: true, tag: 'latest' };
    if (kind === 'hook') pkg['scripts'] = { preinstall: 'echo unexpected' };
    if (kind === 'bin') pkg['bin'] = { totalfinance: '../outside.js' };
    if (kind === 'exports') pkg['exports'] = { '.': './missing.js' };
    const dir = temp();
    const entries = fixtureEntries();
    entries.find((entry) => entry.name === 'package/package.json')!.body = JSON.stringify(pkg);
    const artifact = writeFixtureArtifact(dir, PUBLIC_PACKAGE_NAME, entries);
    expect(() => inspectTarball(join(dir, artifact.tarball), artifact)).toThrow();
  });

  it.each(['^0.1.0', 'workspace:*', 'file:../totalfinance', '0.1.1'])(
    'rejects non-exact/wrong MCP main dependency %s',
    (version) => {
      const pkg = fixtureMetadata(MCP_PACKAGE_NAME);
      pkg['dependencies'] = {
        [PUBLIC_PACKAGE_NAME]: version,
        '@modelcontextprotocol/sdk': '^1.12.0',
      };
      expect(() => validatePackageMetadata(pkg, MCP_PACKAGE_NAME, '0.1.0')).toThrow(/exact main/);
    },
  );

  it.each(['changed-bytes', 'size', 'symlink', 'extra-tarball', 'missing-file'])(
    'refuses %s in the approved directory',
    (kind) => {
      const dir = temp();
      const manifest = writeFixtureGroup(dir);
      const path = join(dir, manifest.packages[0]!.tarball);
      if (kind === 'changed-bytes') {
        const bytes = readFileSync(path);
        bytes[0] = 0;
        writeFileSync(path, bytes);
      }
      if (kind === 'size') {
        manifest.packages[0]!.bytes++;
        writeFileSync(join(dir, 'RELEASE_HASHES.json'), JSON.stringify(manifest));
      }
      if (kind === 'symlink') {
        const outside = join(temp(), 'outside.tgz');
        writeFileSync(outside, readFileSync(path));
        rmSync(path);
        symlinkSync(outside, path);
      }
      if (kind === 'extra-tarball') writeFileSync(join(dir, 'unapproved.tgz'), 'extra');
      if (kind === 'missing-file') rmSync(path);
      expect(() => verifyApproved(dir)).toThrow();
    },
  );

  it.each([
    'traversal',
    'duplicate',
    'symlink',
    'hardlink',
    'missing-target',
    'missing-source',
    'private-import',
    'private-type-import',
  ])('refuses archive %s even with a matching digest', (kind) => {
    const dir = temp();
    let entries = fixtureEntries();
    if (kind === 'traversal') entries.push({ name: 'package/../../escaped', body: 'bad' });
    if (kind === 'duplicate') entries.push(entries[0]!);
    if (kind === 'symlink' || kind === 'hardlink')
      entries.push({
        name: 'package/link',
        body: '',
        type: kind === 'symlink' ? '2' : '1',
        link: '../../escaped',
      });
    if (kind === 'missing-target')
      entries = entries.filter((entry) => !entry.name.endsWith('/dist/index.js'));
    if (kind === 'missing-source')
      entries = entries.filter((entry) => !entry.name.endsWith('/src/index.ts'));
    if (kind === 'private-import')
      entries.find((entry) => entry.name.endsWith('/dist/index.js'))!.body =
        'export const value = import /* gap */ ("@totalfinance/core");';
    if (kind === 'private-type-import')
      entries.find((entry) => entry.name.endsWith('/dist/index.d.ts'))!.body =
        'export type Value = import("@totalfinance/core").Value;';
    const artifact = writeFixtureArtifact(dir, PUBLIC_PACKAGE_NAME, entries);
    expect(() => inspectTarball(join(dir, artifact.tarball), artifact)).toThrow();
  });

  it('uses absolute distribution paths and rejects extra artifacts or a publishable source workspace', () => {
    const root = temp();
    for (const [dir, name] of [
      ['totalfinance', PUBLIC_PACKAGE_NAME],
      ['mcp', MCP_PACKAGE_NAME],
    ]) {
      const path = join(root, 'distribution', dir!);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'package.json'), JSON.stringify(fixtureMetadata(name)));
    }
    mkdirSync(join(root, 'packages/core'), { recursive: true });
    writeFileSync(join(root, 'packages/core/package.json'), JSON.stringify({ private: true }));
    expect(readFixedGroup(root).map((pkg) => pkg.path)).toEqual([
      join(root, 'distribution/totalfinance'),
      join(root, 'distribution/mcp'),
    ]);
    writeFileSync(join(root, 'packages/core/package.json'), JSON.stringify({ private: false }));
    expect(() => readFixedGroup(root)).toThrow(/must be private/);
    mkdirSync(join(root, 'distribution/extra'));
    writeFileSync(join(root, 'distribution/extra/package.json'), '{}');
    expect(() => readFixedGroup(root)).toThrow(/exactly/);
  });
});
