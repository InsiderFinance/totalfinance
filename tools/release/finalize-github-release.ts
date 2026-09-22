/** Recover interrupted GitHub finalization without replacing tags or approved evidence. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  object,
  sha256Of,
  validateManifest,
  verifyApproved,
  type ReleaseManifest,
} from './artifact-policy.js';
import { assertReleaseSource } from './publish-tarballs.js';
import { verifyPromotionReceipt } from './promote-tarballs.js';
import { type SmokeObservation, type SmokeReceipt } from './registry-smoke.js';
import { siteExamplesSha256 } from '../site-examples-smoke.js';
import { changelogExcerpt } from './changelog-excerpt.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPOSITORY = 'InsiderFinance/totalfinance';
const API = `repos/${REPOSITORY}`;
const RECOVERY =
  'Stop promotion. Preserve the original artifacts and receipt; follow docs/runbooks/release-rollback.md, GitHub finalization recovery. Never replace a conflicting tag or asset.';

export interface EvidenceFile {
  name: string;
  bytes: Buffer;
}

/** Injected at the subprocess boundary: tests never contact or mutate GitHub. */
export type ReleaseCommand = (command: 'git' | 'gh', args: string[], input?: Buffer) => Buffer;

function fail(message: string): never {
  throw new Error(`${message}. ${RECOVERY}`);
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail('Invalid GitHub object ID');
  return value as number;
}

/** Success means a matching tag, a published prerelease, and all four exact evidence files. */
export function finalizeGitHubRelease(
  input: { manifest: ReleaseManifest; files: EvidenceFile[]; notes: string; apply: boolean },
  run: ReleaseCommand,
): void {
  const manifest = validateManifest(input.manifest);
  if (manifest.sourceDirty !== false) fail('Finalization requires clean-source approval');
  const tag = `totalfinance-v${manifest.version}`;
  const receiptName = `SMOKE_RECEIPT-${manifest.version}.json`;
  const names = ['RELEASE_HASHES.json', ...manifest.packages.map((p) => p.tarball), receiptName];
  const files = new Map(input.files.map((file) => [file.name, Buffer.from(file.bytes)]));
  if (
    files.size !== names.length ||
    input.files.length !== names.length ||
    names.some((name) => !files.has(name))
  )
    fail('Expected exactly the original manifest, two tarballs and smoke receipt');
  if (
    JSON.stringify(JSON.parse(files.get('RELEASE_HASHES.json')!.toString())) !==
    JSON.stringify(manifest)
  )
    fail('Manifest evidence differs from the approved manifest');
  for (const artifact of manifest.packages) {
    const bytes = files.get(artifact.tarball)!;
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256)
      fail(`Local evidence differs from approval: ${artifact.tarball}`);
  }

  const api = (endpoint: string, method = 'GET', body?: Record<string, unknown>): unknown => {
    const args = ['api', '--hostname', 'github.com', endpoint, '--method', method];
    const bytes = body ? Buffer.from(JSON.stringify(body)) : undefined;
    if (bytes)
      args.push(
        '--input',
        '-',
        '-H',
        'Content-Type: application/json',
        '-H',
        `Content-Length: ${bytes.length}`,
      );
    return JSON.parse(run('gh', args, bytes).toString());
  };
  const pages = (endpoint: string): Record<string, unknown>[] => {
    const response: unknown = JSON.parse(
      run('gh', [
        'api',
        '--hostname',
        'github.com',
        `${endpoint}?per_page=100`,
        '--paginate',
        '--slurp',
      ]).toString(),
    );
    if (!Array.isArray(response) || response.some((page) => !Array.isArray(page)))
      fail('Invalid paginated GitHub response');
    return response.flat().map((entry: unknown) => object(entry, 'GitHub list entry'));
  };
  const tagCommit = (): string | undefined => {
    const ref = `refs/tags/${tag}`;
    const output = run('git', [
      'ls-remote',
      '--tags',
      `https://github.com/${REPOSITORY}.git`,
      ref,
      `${ref}^{}`,
    ])
      .toString()
      .trim();
    if (!output) return undefined;
    const refs = new Map<string, string>();
    for (const line of output.split('\n')) {
      const parts = line.split(/\s+/);
      if (
        parts.length !== 2 ||
        !/^[a-f0-9]{40}$/.test(parts[0]!) ||
        ![ref, `${ref}^{}`].includes(parts[1]!) ||
        refs.has(parts[1]!)
      )
        fail('Invalid remote tag response');
      refs.set(parts[1]!, parts[0]!);
    }
    if (!refs.has(ref)) fail('Remote tag is missing its reference');
    const commit = refs.get(`${ref}^{}`) ?? refs.get(ref)!;
    if (commit !== manifest.commit)
      fail(`Tag ${tag} does not resolve to approved commit ${manifest.commit}`);
    return commit;
  };
  const checkRelease = (value: unknown): Record<string, unknown> => {
    const release = object(value, 'GitHub release');
    id(release['id']);
    if (
      release['tag_name'] !== tag ||
      release['prerelease'] !== true ||
      typeof release['draft'] !== 'boolean'
    )
      fail('Existing release is not the expected candidate prerelease');
    return release;
  };
  const checkAssets = (release: Record<string, unknown>): string[] => {
    const seen = new Set<string>();
    for (const asset of pages(`${API}/releases/${id(release['id'])}/assets`)) {
      const name = asset['name'];
      if (typeof name !== 'string' || !files.has(name) || seen.has(name))
        fail('Unexpected or duplicate GitHub release evidence');
      seen.add(name);
      const approved = files.get(name)!;
      const conflict = (): never => {
        if (name === receiptName)
          fail(
            `Conflicting smoke receipt: ${name}. A smoke rerun changes verifiedAt. Use the original receipt already attached to this release, from its original successful smoke attempt artifact totalfinance-registry-smoke-${manifest.version}-attempt-N (not the newest attempt), or download that existing release asset. Preserve both receipts. Save the original as release/original-${name} and verify with: pnpm exec tsx tools/release/finalize-github-release.ts --dir release/approved --receipt release/original-${name} --expect-version ${manifest.version}. Add --finalize only after separate release-owner approval; do not normalize timestamps or overwrite evidence`,
          );
        fail(`Conflicting asset bytes: ${name}`);
      };
      if (asset['state'] !== 'uploaded') fail(`Incomplete asset: ${name}`);
      if (asset['size'] !== approved.length) conflict();
      const downloaded = run('gh', [
        'api',
        '--hostname',
        'github.com',
        `${API}/releases/assets/${id(asset['id'])}`,
        '-H',
        'Accept: application/octet-stream',
      ]);
      if (!downloaded.equals(approved)) conflict();
    }
    return names.filter((name) => !seen.has(name));
  };

  // Read and validate ALL existing state before making the first mutation.
  const existingTag = tagCommit();
  const matches = pages(`${API}/releases`).filter((release) => release['tag_name'] === tag);
  if (matches.length > 1) fail('Multiple GitHub releases claim the candidate tag');
  let release = matches[0] ? checkRelease(matches[0]) : undefined;
  let missing = release ? checkAssets(release) : names;
  if (!input.apply) {
    if (!existingTag || !release || release['draft'] || missing.length || !tagCommit())
      fail('GitHub finalization is incomplete; rerun with --finalize only after explicit approval');
    return;
  }
  if (!existingTag) {
    const created = object(
      api(`${API}/git/tags`, 'POST', {
        tag,
        message: `TotalFinance ${manifest.version} candidate`,
        object: manifest.commit,
        type: 'commit',
      }),
      'annotated tag',
    );
    if (typeof created['sha'] !== 'string' || !/^[a-f0-9]{40}$/.test(created['sha']))
      fail('Invalid new annotated tag');
    api(`${API}/git/refs`, 'POST', { ref: `refs/tags/${tag}`, sha: created['sha'] });
    if (!tagCommit()) fail('Created tag was not found on readback');
  }
  if (!release) {
    release = checkRelease(
      api(`${API}/releases`, 'POST', {
        tag_name: tag,
        target_commitish: manifest.commit,
        name: `TotalFinance ${manifest.version} (candidate)`,
        body: input.notes,
        draft: true,
        prerelease: true,
        make_latest: 'false',
      }),
    );
    if (release['draft'] !== true) fail('New release must remain draft until evidence is verified');
  }
  const releaseId = id(release['id']);
  for (const name of missing) {
    // Upload the in-memory approved bytes, not a path another process could change.
    // No overwrite/delete route exists; a competing upload returns an error and requires recheck.
    run(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        `https://uploads.github.com/${API}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        '--method',
        'POST',
        '-H',
        'Content-Type: application/octet-stream',
        '-H',
        `Content-Length: ${files.get(name)!.length}`,
        '--input',
        '-',
      ],
      files.get(name)!,
    );
  }
  release = checkRelease(api(`${API}/releases/${releaseId}`));
  missing = checkAssets(release);
  if (missing.length) fail(`Evidence still missing after upload: ${missing.join(', ')}`);
  if (!tagCommit()) fail('Candidate tag disappeared during finalization');
  if (release['draft']) {
    api(`${API}/releases/${releaseId}`, 'PATCH', {
      draft: false,
      prerelease: true,
      make_latest: 'false',
    });
  }
  release = checkRelease(api(`${API}/releases/${releaseId}`));
  if (release['draft'] || checkAssets(release).length || !tagCommit())
    fail('Final candidate release readback is incomplete');
}

function main(): void {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
    options: {
      dir: { type: 'string', default: 'release/approved' },
      receipt: { type: 'string' },
      'expect-version': { type: 'string' },
      finalize: { type: 'boolean', default: false },
    },
    strict: true,
  });
  if (!values.receipt || !values['expect-version'])
    throw new Error('--receipt and --expect-version are required');
  const dir = resolve(ROOT, values.dir!);
  const manifest = verifyApproved(dir);
  if (manifest.version !== values['expect-version'])
    fail('Requested finalization version differs from approval');
  assertReleaseSource(manifest);
  const receiptBytes = readFileSync(resolve(ROOT, values.receipt));
  const expected = join(ROOT, 'tools/release/smoke-expected.json');
  verifyPromotionReceipt(
    manifest,
    JSON.parse(receiptBytes.toString()) as SmokeReceipt,
    JSON.parse(readFileSync(expected, 'utf8')) as SmokeObservation,
    sha256Of(expected),
    siteExamplesSha256(),
  );
  if (
    values.finalize &&
    process.env['GITHUB_ACTIONS'] === 'true' &&
    (process.env['GITHUB_REPOSITORY'] !== REPOSITORY ||
      process.env['GITHUB_REF'] !== 'refs/heads/main' ||
      process.env['GITHUB_SHA'] !== manifest.commit ||
      process.env['TOTALFINANCE_RELEASE_ENABLED'] !== 'true')
  )
    fail(
      'GitHub finalization requires the enabled main-branch release workflow at the approved commit',
    );
  const notesPath =
    manifest.version === '0.1.0'
      ? '.changeset/.release-0.1.0.md'
      : 'distribution/totalfinance/CHANGELOG.md';
  const notes = changelogExcerpt(readFileSync(join(ROOT, notesPath), 'utf8'), manifest.version);
  if (!notes?.trim()) fail('Missing reviewed release notes');
  const run: ReleaseCommand = (command, args, input) =>
    execFileSync(command, args, {
      cwd: ROOT,
      input,
      timeout: 60_000,
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  finalizeGitHubRelease(
    {
      manifest,
      notes,
      apply: values.finalize!,
      files: [
        { name: 'RELEASE_HASHES.json', bytes: readFileSync(join(dir, 'RELEASE_HASHES.json')) },
        ...manifest.packages.map((artifact) => ({
          name: artifact.tarball,
          bytes: readFileSync(join(dir, artifact.tarball)),
        })),
        { name: `SMOKE_RECEIPT-${manifest.version}.json`, bytes: receiptBytes },
      ],
    },
    run,
  );
  process.stdout.write(
    'release:finalize: tag, published candidate prerelease and all four evidence files verified; npm latest unchanged.\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `release:finalize: ${error instanceof Error ? error.message : String(error)}\n${RECOVERY}\n`,
    );
    process.exitCode = 2;
  }
}
