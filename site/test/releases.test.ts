import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createSmokeReceipt } from '../../tools/release/registry-smoke.js';
import { verifiedReleaseFromReceipt } from '../record-release.js';
import { restoreReleaseArchives } from '../archives.js';
import type { SiteVersion } from '../version.js';

const version = '0.1.0-preview.1';
const makeReceipt = () =>
  createSmokeReceipt({
    source: { sourceCommit: 'a'.repeat(40), sourceDirty: false },
    origin: { kind: 'registry-verification', registry: 'https://registry.npmjs.org/' },
    expectations: { matched: true, sha256: 'b'.repeat(64) },
    verifiedAt: '2026-09-07T00:00:00Z',
    evidence: {
      observation: {
        version,
        packages: 25,
        operations: 46,
        priceStructured: 'synthetic fixture',
        journey: 'synthetic fixture',
        openapi: { version, paths: 46 },
        mcp: { tools: 23, namesSha256: 'c'.repeat(64) },
      },
      siteExamples: {
        version,
        cases: 1,
        caseIds: ['fixture-only'],
        sha256: 'd'.repeat(64),
        packages: { '@totalfinance/options': version },
        typecheck: {
          typescriptVersion: '5.9.3',
          modes: ['nodenext', 'bundler'],
          strict: true,
          skipLibCheck: false,
        },
      },
    },
  });

describe('release receipts and preserved documentation', () => {
  it('accepts only explicit, clean, matched public-registry receipts with coherent summaries', () => {
    const receipt = makeReceipt();
    expect(verifiedReleaseFromReceipt(receipt, 'preview')).toMatchObject({
      version,
      channel: 'preview',
      sourceCommit: receipt.sourceCommit,
    });
    for (const invalid of [
      null,
      {},
      { ...receipt, sourceDirty: true },
      { ...receipt, expectations: { matched: false } },
      { ...receipt, examplesCount: 12 },
      { ...receipt, registry: 'http://localhost:4873/' },
      { ...receipt, origin: { kind: 'tarball-rehearsal' } },
    ])
      expect(() => verifiedReleaseFromReceipt(invalid, 'preview')).toThrow();
    expect(() => verifiedReleaseFromReceipt(receipt, 'stable')).toThrow();
  });

  it('copies original version assets and refuses missing, mismatched or symlinked archives', () => {
    const root = mkdtempSync(join(tmpdir(), 'totalfinance-docs-archives-'));
    const release = verifiedReleaseFromReceipt(makeReceipt(), 'preview');
    const old: SiteVersion = {
      version,
      label: `Preview · ${version}`,
      channel: 'preview',
      published: true,
      sourceMatchesRelease: true,
      packageVersions: { totalfinance: version },
      releases: [release],
    };
    const current: SiteVersion = { ...old, version: '0.1.0-preview.2' };
    const archives = join(root, 'archives');
    const source = join(archives, version);
    const out = join(root, 'dist');
    try {
      expect(() => restoreReleaseArchives(undefined, out, current)).toThrow(
        'requires TOTALFINANCE_DOCS_ARCHIVES',
      );
      expect(() => restoreReleaseArchives(archives, out, current)).toThrow(
        'Missing documentation archive',
      );
      mkdirSync(join(source, 'assets'), { recursive: true });
      writeFileSync(join(source, 'version.json'), JSON.stringify(old));
      writeFileSync(join(source, 'index.html'), 'original old page');
      writeFileSync(join(source, 'assets/client.js'), 'original old code');
      expect(restoreReleaseArchives(archives, out, current)).toEqual([version]);
      expect(readFileSync(join(out, 'versions', version, 'assets/client.js'), 'utf8')).toBe(
        'original old code',
      );
      writeFileSync(join(source, 'version.json'), JSON.stringify({ ...old, published: false }));
      expect(() => restoreReleaseArchives(archives, out, current)).toThrow('does not match');
      writeFileSync(join(source, 'version.json'), JSON.stringify(old));
      symlinkSync(join(source, 'index.html'), join(source, 'alias.html'));
      expect(() => restoreReleaseArchives(archives, out, current)).toThrow('symlinks');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
