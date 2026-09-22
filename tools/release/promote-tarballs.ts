/** Explicit maintainer command. No publish/repack: verify public bytes and smoke before latest. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NPMJS, sha256Of, verifyApproved, type ReleaseManifest } from './artifact-policy.js';
import {
  compare,
  createSmokeReceipt,
  type SmokeObservation,
  type SmokeReceipt,
} from './registry-smoke.js';
import { assertReleaseSource } from './publish-tarballs.js';
import { verifyRegistryGroup } from './registry-policy.js';
import { siteExamplesSha256 } from '../site-examples-smoke.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function verifyPromotionReceipt(
  manifest: ReleaseManifest,
  receipt: SmokeReceipt,
  expected: SmokeObservation,
  expectationsSha256: string,
  examplesSha256: string,
): void {
  createSmokeReceipt({
    evidence: { observation: receipt.observation, siteExamples: receipt.siteExamples },
    source: { sourceCommit: receipt.sourceCommit, sourceDirty: receipt.sourceDirty },
    origin: receipt.origin,
    expectations: receipt.expectations,
    verifiedAt: receipt.verifiedAt,
  });
  if (
    receipt.schemaVersion !== 1 ||
    receipt.version !== manifest.version ||
    receipt.observation.version !== manifest.version ||
    receipt.sourceCommit !== manifest.commit ||
    receipt.sourceDirty !== false ||
    manifest.sourceDirty !== false ||
    receipt.origin.kind !== 'registry-verification' ||
    receipt.origin.registry !== NPMJS ||
    receipt.registry !== NPMJS ||
    receipt.expectations.matched !== true ||
    receipt.expectations.sha256 !== expectationsSha256 ||
    receipt.examplesSha256 !== examplesSha256 ||
    receipt.siteExamples.sha256 !== examplesSha256 ||
    compare(receipt.observation, expected).length
  )
    throw new Error(
      'Latest promotion requires matched, clean, same-commit public-registry smoke evidence',
    );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
    options: {
      dir: { type: 'string', default: 'release' },
      receipt: { type: 'string' },
      'expect-version': { type: 'string' },
      'approve-latest': { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.receipt || !values['expect-version'])
    throw new Error('--receipt and --expect-version are required');
  const manifest = verifyApproved(resolve(ROOT, values.dir!));
  if (values['expect-version'] !== manifest.version)
    throw new Error('Requested promotion version differs from approved artifacts');
  assertReleaseSource(manifest);
  const expectedPath = join(ROOT, 'tools/release/smoke-expected.json');
  verifyPromotionReceipt(
    manifest,
    JSON.parse(readFileSync(resolve(ROOT, values.receipt), 'utf8')) as SmokeReceipt,
    JSON.parse(readFileSync(expectedPath, 'utf8')) as SmokeObservation,
    sha256Of(expectedPath),
    siteExamplesSha256(),
  );
  await verifyRegistryGroup(manifest, NPMJS);
  if (!values['approve-latest']) {
    process.stdout.write(
      'release:promote: verification passed; no tags changed. Repeat with --approve-latest only after explicit maintainer approval.\n',
    );
    return;
  }
  // npm OIDC publishes packages, not dist-tags. This command uses the maintainer's npm login/2FA.
  for (const artifact of manifest.packages) {
    execFileSync(
      'npm',
      [
        'dist-tag',
        'add',
        `${artifact.package}@${artifact.version}`,
        'latest',
        '--registry',
        NPMJS,
        `--@insiderfinance:registry=${NPMJS}`,
      ],
      { cwd: ROOT, stdio: 'inherit' },
    );
  }
  for (const artifact of manifest.packages) {
    const latest = execFileSync(
      'npm',
      [
        'view',
        artifact.package,
        'dist-tags.latest',
        '--json',
        '--registry',
        NPMJS,
        `--@insiderfinance:registry=${NPMJS}`,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (JSON.parse(latest) !== manifest.version)
      throw new Error(`Latest readback failed: ${artifact.package}`);
  }
  process.stdout.write(
    `release:promote: both latest tags point to ${manifest.version}; this is not a 1.0 stability declaration\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `release:promote: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
