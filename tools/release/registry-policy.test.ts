import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MCP_PACKAGE_NAME, PUBLIC_PACKAGE_NAME } from '../public-packages.js';
import {
  NPMJS,
  tarballName,
  type ReleaseArtifact,
  type ReleaseManifest,
} from './artifact-policy.js';
import { assertPublishToolchain } from './publish-tarballs.js';
import { planPublication, releaseRegistry, verifyRegistryArtifact } from './registry-policy.js';
import { fixtureMetadata } from './test-fixtures.js';

const bytes = 'synthetic approved bytes';
function artifact(name = PUBLIC_PACKAGE_NAME): ReleaseArtifact {
  return {
    package: name,
    version: '0.1.0',
    tarball: tarballName(name, '0.1.0'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}
function metadata(name = PUBLIC_PACKAGE_NAME): Response {
  return Response.json({
    ...fixtureMetadata(name),
    dist: { tarball: `${NPMJS}/${name}/-/test.tgz` },
  });
}
const manifest: ReleaseManifest = {
  version: '0.1.0',
  commit: 'a'.repeat(40),
  sourceDirty: false,
  packages: [artifact(), artifact(MCP_PACKAGE_NAME)],
};

describe('registry preflight and trusted publication', () => {
  it.each([
    'https://evil.test',
    'https://registry.npmjs.org/other',
    'https://token@registry.npmjs.org',
    'http://registry.npmjs.org',
    'https://registry.npmjs.org/?token=secret',
    'http://127.0.0.1:4873/#fragment',
  ])('rejects unapproved or credential-bearing registry %s', (registry) => {
    expect(() => releaseRegistry(registry)).toThrow();
  });
  it('permits only public npm and explicit HTTP loopback rehearsal roots', () => {
    expect(releaseRegistry(`${NPMJS}/`)).toEqual({ registry: NPMJS, loopback: false });
    expect(releaseRegistry('http://localhost:4873').loopback).toBe(true);
    expect(releaseRegistry('http://[::1]:4873').loopback).toBe(true);
  });
  it.each([
    ['22.13.0', '11.5.1'],
    ['24.21.0', '10.9.0'],
    ['24.21.0', '11.5.0'],
    ['24.21.0', 'garbage'],
  ])('refuses incompatible publishing tools Node %s/npm %s', (node, npm) => {
    expect(() => assertPublishToolchain(node, npm)).toThrow();
  });
  it('accepts the pinned Node family and the minimum compatible npm', () => {
    expect(() => assertPublishToolchain('24.21.0', '11.5.1')).not.toThrow();
    expect(() => assertPublishToolchain('24.21.0', '11.19.1\n')).not.toThrow();
  });
  it.each([PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME])(
    'accepts npm-normalized bin metadata for %s while still checking exact artifact bytes',
    async (name) => {
      const pkg = fixtureMetadata(name);
      pkg['bin'] = Object.fromEntries(
        Object.entries(pkg['bin'] as Record<string, string>).map(([key, path]) => [
          key,
          path.replace(/^\.\//, ''),
        ]),
      );
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ ...pkg, dist: { tarball: `${NPMJS}/${name}/-/test.tgz` } }),
        )
        .mockResolvedValueOnce(new Response(bytes));
      expect(await verifyRegistryArtifact(artifact(name), NPMJS, request)).toBe(true);
      expect(request).toHaveBeenCalledTimes(2);
      const changed = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ ...pkg, dist: { tarball: `${NPMJS}/${name}/-/test.tgz` } }),
        )
        .mockResolvedValueOnce(new Response('different bytes'));
      await expect(verifyRegistryArtifact(artifact(name), NPMJS, changed)).rejects.toThrow(
        /differ from approval/,
      );
    },
  );
  it.each([
    '../modules/cli/dist/bin.js',
    '/modules/cli/dist/bin.js',
    '././modules/cli/dist/bin.js',
    'modules/cli/dist/other.js',
    42,
  ])('still rejects invalid registry executable path %s before download', async (path) => {
    const pkg = fixtureMetadata();
    pkg['bin'] = { ...(pkg['bin'] as Record<string, unknown>), totalfinance: path };
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(pkg));
    await expect(verifyRegistryArtifact(artifact(), NPMJS, request)).rejects.toThrow(
      /Invalid executable paths/,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('resumes a main-only partial publish only after checking main metadata and exact bytes', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(new Response(bytes))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    expect(await planPublication(manifest, NPMJS, true, request)).toEqual([true, false]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[0]![0]).toContain(encodeURIComponent(PUBLIC_PACKAGE_NAME));
    expect(request.mock.calls[2]![0]).toContain(encodeURIComponent(MCP_PACKAGE_NAME));
    expect(
      request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
    ).toBe(true);
  });
  it('does not treat an existing version as a successful new publish without explicit resume', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(new Response(bytes));
    await expect(planPublication(manifest, NPMJS, false, request)).rejects.toThrow(
      /requires --resume/,
    );
  });
  it('refuses a hash mismatch in main rather than skipping it and uploading MCP', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(new Response('changed bytes'));
    await expect(planPublication(manifest, NPMJS, true, request)).rejects.toThrow(
      /differ from approval/,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 429, 500])(
    'never interprets registry status %i as absence',
    async (status) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
      await expect(verifyRegistryArtifact(artifact(), NPMJS, request)).rejects.toThrow(
        /metadata failed/,
      );
    },
  );
  it('refuses redirected/off-registry tarballs and wrong metadata before download', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ ...fixtureMetadata(), dist: { tarball: 'https://evil.test/payload.tgz' } }),
      );
    await expect(verifyRegistryArtifact(artifact(), NPMJS, request)).rejects.toThrow(
      /Unsafe registry/,
    );
    expect(request).toHaveBeenCalledTimes(1);
    const wrong = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ...fixtureMetadata(), version: '0.1.1' }));
    await expect(verifyRegistryArtifact(artifact(), NPMJS, wrong)).rejects.toThrow(/identity/);
  });
});
