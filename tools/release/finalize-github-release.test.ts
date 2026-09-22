import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PUBLIC_ROSTER, tarballName, type ReleaseManifest } from './artifact-policy.js';
import {
  finalizeGitHubRelease,
  type EvidenceFile,
  type ReleaseCommand,
} from './finalize-github-release.js';

const commit = 'a'.repeat(40);
const tagObject = 'b'.repeat(40);
const tag = 'totalfinance-v0.1.0';
const api = 'repos/InsiderFinance/totalfinance';

function evidence(): {
  manifest: ReleaseManifest;
  files: EvidenceFile[];
  notes: string;
  apply: boolean;
} {
  const files = PUBLIC_ROSTER.map((name) => ({
    name: tarballName(name, '0.1.0'),
    bytes: Buffer.from(`synthetic ${name}`),
  }));
  const manifest: ReleaseManifest = {
    version: '0.1.0',
    commit,
    sourceDirty: false,
    packages: PUBLIC_ROSTER.map((name, index) => ({
      package: name,
      version: '0.1.0',
      tarball: files[index]!.name,
      bytes: files[index]!.bytes.length,
      sha256: createHash('sha256').update(files[index]!.bytes).digest('hex'),
    })),
  };
  return {
    manifest,
    notes: 'Reviewed candidate notes',
    apply: true,
    files: [
      { name: 'RELEASE_HASHES.json', bytes: Buffer.from(JSON.stringify(manifest)) },
      ...files,
      {
        name: 'SMOKE_RECEIPT-0.1.0.json',
        bytes: Buffer.from('{"synthetic":true,"verifiedAt":"2026-09-22T00:00:00.000Z"}'),
      },
    ],
  };
}

interface Asset {
  id: number;
  name: string;
  bytes: Buffer;
  state: string;
}
interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

/** Stateful subprocess fake; there is deliberately no real git/gh fallback. */
function github() {
  const state = {
    remoteTag: undefined as { sha: string; peeled?: string } | undefined,
    release: undefined as Release | undefined,
    assets: [] as Asset[],
    mutations: [] as string[],
    calls: [] as string[][],
    failUpload: undefined as string | undefined,
    failPublish: false,
    failRead: false,
    ignorePublish: false,
    changeTagAtPublish: false,
  };
  const json = (value: unknown) => Buffer.from(JSON.stringify(value));
  const run: ReleaseCommand = (command, args, input) => {
    state.calls.push([command, ...args]);
    if (state.failRead) throw new Error('Network/authentication failure');
    if (command === 'git') {
      expect(args.slice(0, 3)).toEqual([
        'ls-remote',
        '--tags',
        'https://github.com/InsiderFinance/totalfinance.git',
      ]);
      return Buffer.from(
        state.remoteTag
          ? `${state.remoteTag.sha}\trefs/tags/${tag}\n${state.remoteTag.peeled ? `${state.remoteTag.peeled}\trefs/tags/${tag}^{}\n` : ''}`
          : '',
      );
    }
    expect(args.slice(0, 3)).toEqual(['api', '--hostname', 'github.com']);
    const endpoint = args[3]!;
    const methodIndex = args.indexOf('--method');
    const method = methodIndex < 0 ? 'GET' : args[methodIndex + 1]!;
    if (method !== 'GET') state.mutations.push(`${method} ${endpoint}`);
    if (endpoint === `${api}/releases?per_page=100`) {
      expect(args.slice(-2)).toEqual(['--paginate', '--slurp']);
      return json([[], state.release ? [state.release] : []]);
    }
    if (endpoint === `${api}/releases/1/assets?per_page=100`) {
      expect(args.slice(-2)).toEqual(['--paginate', '--slurp']);
      // Split over pages: finalization must not trust the embedded first-page asset roster.
      return json(
        state.assets.map((asset) => [
          { id: asset.id, name: asset.name, state: asset.state, size: asset.bytes.length },
        ]),
      );
    }
    if (endpoint.startsWith(`${api}/releases/assets/`)) {
      expect(args.slice(-2)).toEqual(['-H', 'Accept: application/octet-stream']);
      return state.assets.find((asset) => asset.id === Number(endpoint.split('/').at(-1)))!.bytes;
    }
    if (method === 'POST' && endpoint === `${api}/git/tags`) {
      expect(JSON.parse(input!.toString())).toEqual({
        tag,
        message: 'TotalFinance 0.1.0 candidate',
        object: commit,
        type: 'commit',
      });
      return json({ sha: tagObject });
    }
    if (method === 'POST' && endpoint === `${api}/git/refs`) {
      expect(JSON.parse(input!.toString())).toEqual({ ref: `refs/tags/${tag}`, sha: tagObject });
      if (state.remoteTag) throw new Error('409 conflicting ref');
      state.remoteTag = { sha: tagObject, peeled: commit };
      return json({});
    }
    if (method === 'POST' && endpoint === `${api}/releases`) {
      const body = JSON.parse(input!.toString()) as Record<string, unknown>;
      expect(body).toMatchObject({
        tag_name: tag,
        target_commitish: commit,
        draft: true,
        prerelease: true,
        make_latest: 'false',
      });
      state.release = { id: 1, tag_name: tag, draft: true, prerelease: true };
      return json(state.release);
    }
    if (
      method === 'POST' &&
      endpoint.startsWith(`https://uploads.github.com/${api}/releases/1/assets?`)
    ) {
      expect(args.slice(-6)).toEqual([
        '-H',
        'Content-Type: application/octet-stream',
        '-H',
        `Content-Length: ${input!.length}`,
        '--input',
        '-',
      ]);
      const name = new URL(endpoint).searchParams.get('name')!;
      if (state.failUpload === name) throw new Error('Interrupted upload');
      if (state.assets.some((asset) => asset.name === name)) throw new Error('422 duplicate asset');
      state.assets.push({
        id: state.assets.length + 1,
        name,
        bytes: Buffer.from(input!),
        state: 'uploaded',
      });
      return json({});
    }
    if (endpoint === `${api}/releases/1`) {
      if (method === 'PATCH') {
        expect(JSON.parse(input!.toString())).toEqual({
          draft: false,
          prerelease: true,
          make_latest: 'false',
        });
        if (state.failPublish) throw new Error('Interrupted draft publication');
        if (!state.ignorePublish) state.release!.draft = false;
        if (state.changeTagAtPublish) state.remoteTag = { sha: 'c'.repeat(40) };
      }
      return json(state.release);
    }
    throw new Error(`Unexpected subprocess: ${command} ${args.join(' ')}`);
  };
  const seed = (input: ReturnType<typeof evidence>, draft: boolean, assetCount = 4) => {
    state.remoteTag = { sha: tagObject, peeled: commit };
    state.release = { id: 1, tag_name: tag, draft, prerelease: true };
    state.assets = input.files.slice(0, assetCount).map((file, index) => ({
      ...file,
      bytes: Buffer.from(file.bytes),
      id: index + 1,
      state: 'uploaded',
    }));
  };
  return { state, run, seed };
}

describe('fail-closed GitHub candidate finalization', () => {
  it('creates an annotated tag and draft, verifies four uploaded files, then publishes only a prerelease', () => {
    const input = evidence();
    const fake = github();
    finalizeGitHubRelease(input, fake.run);
    expect(fake.state.release).toMatchObject({ draft: false, prerelease: true });
    expect(fake.state.assets.map((asset) => asset.name)).toEqual(
      input.files.map((file) => file.name),
    );
    expect(fake.state.mutations).toHaveLength(8); // tag object, ref, release, four assets, draft -> published
    expect(fake.state.mutations.at(-1)).toBe(`PATCH ${api}/releases/1`);
  });

  it.each([true, false])('is idempotent for a complete candidate (apply=%s)', (apply) => {
    const input = evidence();
    const fake = github();
    fake.seed(input, false);
    finalizeGitHubRelease({ ...input, apply }, fake.run);
    expect(fake.state.mutations).toEqual([]);
  });

  it('dereferences annotated tags instead of comparing the tag-object SHA to the source commit', () => {
    const input = evidence();
    const fake = github();
    fake.seed(input, false);
    expect(() => finalizeGitHubRelease(input, fake.run)).not.toThrow();
    fake.state.remoteTag = { sha: tagObject, peeled: 'c'.repeat(40) };
    expect(() => finalizeGitHubRelease(input, fake.run)).toThrow(
      /does not resolve to approved commit/,
    );
    expect(fake.state.mutations).toEqual([]);
  });

  it('accepts a matching lightweight tag and rejects a conflicting one before writes', () => {
    const input = evidence();
    const fake = github();
    fake.seed(input, false);
    fake.state.remoteTag = { sha: commit };
    expect(() => finalizeGitHubRelease(input, fake.run)).not.toThrow();
    fake.state.remoteTag = { sha: tagObject };
    expect(() => finalizeGitHubRelease(input, fake.run)).toThrow(/does not resolve/);
    expect(fake.state.mutations).toEqual([]);
  });

  it('resumes an interrupted draft by uploading ONLY missing files', () => {
    const input = evidence();
    const fake = github();
    fake.seed(input, true, 2);
    const original = fake.state.assets.map((asset) => asset.bytes);
    finalizeGitHubRelease(input, fake.run);
    expect(fake.state.mutations).toHaveLength(3);
    expect(fake.state.assets.slice(0, 2).map((asset) => asset.bytes)).toEqual(original);
    expect(fake.state.release!.draft).toBe(false);
  });

  it('survives interruption after a partial upload without recreating the tag/release or replacing files', () => {
    const input = evidence();
    const fake = github();
    fake.state.failUpload = input.files[2]!.name;
    expect(() => finalizeGitHubRelease(input, fake.run)).toThrow(/Interrupted upload/);
    expect(fake.state.assets).toHaveLength(2);
    expect(fake.state.release!.draft).toBe(true);
    fake.state.failUpload = undefined;
    fake.state.mutations = [];
    finalizeGitHubRelease(input, fake.run);
    expect(fake.state.mutations).toHaveLength(3);
    expect(fake.state.mutations.every((value) => !value.includes('/git/'))).toBe(true);
  });

  it('resumes interruption after all evidence uploaded but before draft publication', () => {
    const input = evidence();
    const fake = github();
    fake.seed(input, true);
    fake.state.failPublish = true;
    expect(() => finalizeGitHubRelease(input, fake.run)).toThrow(/Interrupted draft publication/);
    fake.state.failPublish = false;
    fake.state.mutations = [];
    finalizeGitHubRelease(input, fake.run);
    expect(fake.state.mutations).toEqual([`PATCH ${api}/releases/1`]);
  });

  it.each(['missing', 'draft'])(
    'read-only verification refuses incomplete %s state without repairs',
    (kind) => {
      const input = evidence();
      const fake = github();
      if (kind === 'draft') fake.seed(input, true);
      expect(() => finalizeGitHubRelease({ ...input, apply: false }, fake.run)).toThrow(
        /incomplete/,
      );
      expect(fake.state.mutations).toEqual([]);
    },
  );

  it.each(['bytes', 'extra', 'duplicate', 'starter', 'stable'])(
    'rejects %s conflicts before even uploading missing evidence',
    (kind) => {
      const input = evidence();
      const fake = github();
      fake.seed(input, true, 2);
      if (kind === 'bytes') fake.state.assets[1]!.bytes[0] = fake.state.assets[1]!.bytes[0]! ^ 1;
      if (kind === 'extra') fake.state.assets[1]!.name = 'unapproved.txt';
      if (kind === 'duplicate') fake.state.assets[1]!.name = fake.state.assets[0]!.name;
      if (kind === 'starter') fake.state.assets[1]!.state = 'starter';
      if (kind === 'stable') fake.state.release!.prerelease = false;
      expect(() => finalizeGitHubRelease(input, fake.run)).toThrow(/Stop promotion/);
      expect(fake.state.mutations).toEqual([]);
    },
  );

  it.each(['timestamp-only', 'size'])(
    'rejects a %s receipt change with precise original-attempt recovery instructions',
    (kind) => {
      const input = evidence();
      const fake = github();
      fake.seed(input, true);
      const original = Buffer.from(input.files[3]!.bytes);
      input.files[3]!.bytes = Buffer.from(
        kind === 'timestamp-only'
          ? original.toString().replace('T00:00:00', 'T00:01:00')
          : '{"synthetic":"different size"}',
      );
      expect(() => finalizeGitHubRelease(input, fake.run)).toThrow(
        /Conflicting smoke receipt: SMOKE_RECEIPT-0.1.0.json.*verifiedAt.*totalfinance-registry-smoke-0.1.0-attempt-N \(not the newest attempt\).*--receipt release\/original-SMOKE_RECEIPT-0.1.0.json.*do not normalize timestamps or overwrite evidence/,
      );
      expect(fake.state.mutations).toEqual([]);
      expect(fake.state.assets[3]!.bytes).toEqual(original);
      // The retained original receipt resumes the draft without uploading/replacing any asset.
      input.files[3]!.bytes = original;
      finalizeGitHubRelease(input, fake.run);
      expect(fake.state.mutations).toEqual([`PATCH ${api}/releases/1`]);
    },
  );

  it('does not interpret an auth/network error as absence', () => {
    const input = evidence();
    const fake = github();
    fake.state.failRead = true;
    expect(() => finalizeGitHubRelease(input, fake.run)).toThrow(/Network\/authentication/);
    expect(fake.state.mutations).toEqual([]);
  });

  it.each(['draft', 'moved-tag'])('refuses false success on final %s readback', (kind) => {
    const input = evidence();
    const fake = github();
    fake.seed(input, true);
    fake.state.ignorePublish = kind === 'draft';
    fake.state.changeTagAtPublish = kind === 'moved-tag';
    expect(() => finalizeGitHubRelease(input, fake.run)).toThrow(/incomplete|does not resolve/);
  });

  it.each(['dirty', 'tarball', 'roster', 'manifest'])(
    'rejects invalid local %s evidence before subprocesses',
    (kind) => {
      const input = evidence();
      const fake = github();
      if (kind === 'dirty') input.manifest.sourceDirty = true;
      if (kind === 'tarball') input.files[1]!.bytes = Buffer.from('changed');
      if (kind === 'roster') input.files.pop();
      if (kind === 'manifest') input.files[0]!.bytes = Buffer.from('{}');
      expect(() => finalizeGitHubRelease(input, fake.run)).toThrow();
      expect(fake.state.calls).toEqual([]);
    },
  );

  it('the workflow delegates finalization and cannot silently skip existing releases', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/totalfinance-release.yml', import.meta.url),
      'utf8',
    );
    expect(workflow).toContain('tools/release/finalize-github-release.ts');
    expect(workflow).toContain('--expect-version "$RELEASE_VERSION" --finalize');
    expect(workflow).toContain(
      'name: totalfinance-registry-smoke-${{ inputs.version }}-attempt-${{ github.run_attempt }}',
    );
    expect(workflow).not.toContain('overwrite: true');
    expect(workflow).not.toContain('if ! gh release view');
    const tool = readFileSync(new URL('./finalize-github-release.ts', import.meta.url), 'utf8');
    expect(tool).not.toContain('--clobber');
    expect(tool).not.toContain("'DELETE'");
  });
});
