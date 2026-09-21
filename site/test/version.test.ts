import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readSiteVersion, sourceMatchesRelease, type VerifiedRelease } from '../version.js';

const preview: VerifiedRelease = {
  version: '0.1.0-preview.1',
  channel: 'preview',
  verifiedAt: '2026-09-07T00:00:00Z',
  sourceCommit: 'a'.repeat(40),
  registry: 'https://registry.npmjs.org/',
  examplesSha256: 'b'.repeat(64),
};
function fixture(releases: unknown[], version = preview.version) {
  const root = mkdtempSync(join(tmpdir(), 'totalfinance-site-version-'));
  mkdirSync(join(root, 'packages/totalfinance'), { recursive: true });
  mkdirSync(join(root, 'site'));
  writeFileSync(
    join(root, 'packages/totalfinance/package.json'),
    JSON.stringify({ name: 'totalfinance', version }),
  );
  writeFileSync(join(root, 'site/releases.json'), JSON.stringify({ schemaVersion: 1, releases }));
  return root;
}
describe('honest version labels', () => {
  it('does not invent published status from a version number', () => {
    const root = fixture([]);
    try {
      expect(readSiteVersion(root)).toMatchObject({ published: false, channel: 'development' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('requires both a release receipt and matching package source/examples', () => {
    const root = fixture([preview]);
    try {
      expect(readSiteVersion(root, () => true)).toMatchObject({
        published: true,
        channel: 'preview',
      });
      expect(readSiteVersion(root, () => false)).toMatchObject({
        published: false,
        channel: 'development',
      });
      expect(sourceMatchesRelease(root, preview)).toBe(false); // no git evidence
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    { releases: [preview, preview] },
    { releases: [{ ...preview, channel: 'stable' }] },
    { releases: [{ ...preview, examplesSha256: 'made-up' }] },
    { releases: [{ ...preview, registry: 'http://localhost:4873/' }] },
    { releases: [{ ...preview, registry: 'https://secret@registry.npmjs.org/' }] },
    { releases: [{ ...preview, accessToken: 'must-not-reach-output' }] },
  ])('rejects invalid, duplicated, or local-rehearsal evidence', ({ releases }) => {
    const root = fixture(releases);
    try {
      expect(() => readSiteVersion(root, () => true)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
