import { describe, expect, it } from 'vitest';
import { NPMJS, type ReleaseManifest } from './artifact-policy.js';
import { createSmokeReceipt, type SmokeObservation, type SmokeReceipt } from './registry-smoke.js';
import { verifyPromotionReceipt } from './promote-tarballs.js';
import { PUBLIC_PACKAGE_NAME } from '../public-packages.js';

// Synthetic unit evidence is never written to a release ledger or mistaken for a public receipt.
const commit = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const expected: SmokeObservation = {
  version: '0.1.0',
  packages: 2,
  operations: 23,
  priceStructured: '{"value":2}',
  journey: '{"price":1}',
  openapi: { version: '3.1.0', paths: 55 },
  mcp: { tools: 23, namesSha256: digest },
};
const manifest: ReleaseManifest = { version: '0.1.0', commit, sourceDirty: false, packages: [] };
function receipt(): SmokeReceipt {
  return createSmokeReceipt({
    evidence: {
      observation: structuredClone(expected),
      siteExamples: {
        version: '0.1.0',
        cases: 1,
        caseIds: ['example'],
        sha256: digest,
        packages: { [PUBLIC_PACKAGE_NAME]: '0.1.0' },
        typecheck: {
          typescriptVersion: '5.9.3',
          modes: ['nodenext', 'bundler'],
          strict: true,
          skipLibCheck: false,
        },
      },
    },
    source: { sourceCommit: commit, sourceDirty: false },
    origin: { kind: 'registry-verification', registry: NPMJS },
    expectations: { matched: true, sha256: digest },
    verifiedAt: '2026-09-22T00:00:00Z',
  });
}
describe('explicit latest promotion evidence gate', () => {
  it('accepts matched same-commit public smoke without changing anything', () => {
    expect(() =>
      verifyPromotionReceipt(manifest, receipt(), expected, digest, digest),
    ).not.toThrow();
  });
  it.each([
    'dirty',
    'commit',
    'version',
    'registry',
    'tarball',
    'unmatched',
    'expectations',
    'examples',
    'numerics',
    'operations',
    'tools',
  ])('refuses %s evidence without normalizing the behavioral result', (kind) => {
    const evidence = receipt();
    if (kind === 'dirty') evidence.sourceDirty = true;
    if (kind === 'commit') evidence.sourceCommit = 'c'.repeat(40);
    if (kind === 'version') evidence.version = '0.1.1';
    if (kind === 'registry') {
      evidence.registry = 'http://localhost:4873';
      evidence.origin = { kind: 'registry-verification', registry: 'http://localhost:4873' };
    }
    if (kind === 'tarball') {
      evidence.registry = null;
      evidence.origin = {
        kind: 'tarball-rehearsal',
        manifestCommit: commit,
        manifestSha256: digest,
      };
    }
    if (kind === 'unmatched') evidence.expectations.matched = false;
    if (kind === 'expectations') evidence.expectations.sha256 = 'c'.repeat(64);
    if (kind === 'examples') evidence.siteExamples.sha256 = 'c'.repeat(64);
    if (kind === 'numerics') evidence.observation.priceStructured = '{"value":2.00001}';
    if (kind === 'operations') evidence.observation.operations++;
    if (kind === 'tools') evidence.observation.mcp.namesSha256 = 'c'.repeat(64);
    expect(() => verifyPromotionReceipt(manifest, evidence, expected, digest, digest)).toThrow();
  });
  it('refuses an artifact built from a dirty tree even if the smoke checkout is clean', () => {
    expect(() =>
      verifyPromotionReceipt(
        { ...manifest, sourceDirty: true },
        receipt(),
        expected,
        digest,
        digest,
      ),
    ).toThrow();
    expect(() =>
      verifyPromotionReceipt(
        { version: manifest.version, commit, packages: [] },
        receipt(),
        expected,
        digest,
        digest,
      ),
    ).toThrow();
  });
});
