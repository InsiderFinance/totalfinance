/** Explicit post-publish evidence import. Never publishes packages or deploys a site. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createSmokeReceipt, type SmokeReceipt } from '../tools/release/registry-smoke.js';
import { readSiteVersion, sourceMatchesRelease, type VerifiedRelease } from './version.js';

export function verifiedReleaseFromReceipt(
  value: unknown,
  channel: 'preview' | 'stable',
): VerifiedRelease {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a registry-smoke receipt.');
  const receipt = value as SmokeReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.origin?.kind !== 'registry-verification' ||
    receipt.sourceDirty !== false ||
    receipt.expectations?.matched !== true ||
    typeof receipt.registry !== 'string' ||
    !/^https:\/\/registry\.npmjs\.org\/?$/.test(receipt.registry) ||
    !/^https:\/\/registry\.npmjs\.org\/?$/.test(receipt.origin.registry)
  )
    throw new Error(
      'Only a clean, expectation-matched public npm verification is release evidence; local/dirty rehearsals are not.',
    );
  const regenerated = createSmokeReceipt({
    evidence: { observation: receipt.observation, siteExamples: receipt.siteExamples },
    source: { sourceCommit: receipt.sourceCommit, sourceDirty: receipt.sourceDirty },
    origin: receipt.origin,
    expectations: receipt.expectations,
    verifiedAt: receipt.verifiedAt,
  });
  if (
    regenerated.version !== receipt.version ||
    regenerated.examplesSha256 !== receipt.examplesSha256 ||
    regenerated.examplesCount !== receipt.examplesCount
  )
    throw new Error('Receipt summary differs from its observed evidence.');
  if (
    !['preview', 'stable'].includes(channel) ||
    (channel === 'preview') !== receipt.version.includes('-')
  )
    throw new Error('Explicit preview/stable channel must match the version.');
  return {
    version: receipt.version,
    channel,
    verifiedAt: receipt.verifiedAt,
    sourceCommit: receipt.sourceCommit,
    registry: 'https://registry.npmjs.org/',
    examplesSha256: receipt.examplesSha256,
  };
}

export function recordRelease(root: string, receipt: unknown, channel: 'preview' | 'stable'): void {
  const release = verifiedReleaseFromReceipt(receipt, channel);
  const current = readSiteVersion(root);
  if (release.version !== current.version || !sourceMatchesRelease(root, release))
    throw new Error(
      'Release receipt does not match this package source and its exact copied examples.',
    );
  const previous = current.releases.find((candidate) => candidate.version === release.version);
  if (previous && JSON.stringify(previous) !== JSON.stringify(release))
    throw new Error(
      'A different receipt already owns this version; do not silently rewrite release history.',
    );
  const releases = previous ? current.releases : [...current.releases, release];
  writeFileSync(
    join(root, 'site/releases.json'),
    JSON.stringify({ schemaVersion: 1, releases }, null, 2) + '\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [receiptPath, channel, ...extra] = process.argv.slice(2);
  if (!receiptPath || !['preview', 'stable'].includes(channel ?? '') || extra.length)
    throw new Error(
      'Usage: pnpm site:record-release <registry-smoke-receipt.json> <preview|stable>',
    );
  recordRelease(
    fileURLToPath(new URL('..', import.meta.url)),
    JSON.parse(readFileSync(receiptPath, 'utf8')),
    channel as 'preview' | 'stable',
  );
  process.stdout.write(
    'Recorded verified release evidence. Build the site, preserve its version snapshot, then deploy only with maintainer approval.\n',
  );
}
