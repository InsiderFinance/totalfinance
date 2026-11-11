import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FULL_CI_JOBS,
  publishedSdkRelease,
  requireForwardLatest,
  requireFullMainCi,
  requireReleaseCheckout,
} from './github-sdk-policy.js';

function event() {
  return {
    action: 'published',
    repository: { full_name: 'InsiderFinance/totalfinance' },
    release: { id: 123, draft: false, prerelease: false, tag_name: 'totalfinance-v0.1.3' },
  };
}
function run() {
  return {
    id: 456,
    event: 'push',
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/InsiderFinance/totalfinance/actions/runs/456',
  };
}
function jobs() {
  return {
    jobs: FULL_CI_JOBS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  };
}

describe('a GitHub Release is explicit SDK-only publication authority', () => {
  it.each(['verify', 'publish'])(
    'the actual %s command refuses disabled publication before reading artifacts or contacting a registry',
    (command) => {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(new URL('./github-sdk-release.ts', import.meta.url)),
          command,
          '--dir',
          '/no-approved-release-here',
        ],
        {
          env: { ...process.env, TOTALFINANCE_RELEASE_ENABLED: 'false' },
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Publication is disabled');
      expect(result.stderr).not.toContain('ENOENT');
    },
  );
  it('takes the already prepared version from the exact release tag', () => {
    expect(publishedSdkRelease(event())).toEqual({
      version: '0.1.3',
      tag: 'totalfinance-v0.1.3',
      id: 123,
    });
  });
  it.each([
    'draft',
    'prerelease',
    'edited',
    'fork',
    'missing-id',
    'tag',
    'prefix',
    'leading-zero',
    'shell',
    'prerelease-version',
    'build-version',
  ])('refuses %s releases before publication', (kind) => {
    const input = event();
    if (kind === 'draft') input.release.draft = true;
    if (kind === 'prerelease') input.release.prerelease = true;
    if (kind === 'edited') input.action = 'edited';
    if (kind === 'fork') input.repository.full_name = 'other/totalfinance';
    if (kind === 'missing-id') input.release.id = 0;
    if (kind === 'tag') input.release.tag_name = 'main';
    if (kind === 'prefix') input.release.tag_name = 'v0.1.3';
    if (kind === 'leading-zero') input.release.tag_name = 'totalfinance-v0.01.3';
    if (kind === 'shell') input.release.tag_name = 'totalfinance-v0.1.3;echo unsafe';
    if (kind === 'prerelease-version') input.release.tag_name = 'totalfinance-v0.1.3-rc.1';
    if (kind === 'build-version') input.release.tag_name = 'totalfinance-v0.1.3+build';
    expect(() => publishedSdkRelease(input)).toThrow();
  });
  it.each([null, [], {}, { release: {} }])('refuses incomplete event %j', (input) => {
    expect(() => publishedSdkRelease(input)).toThrow();
  });
});

describe('release receipts require full main CI at the exact source commit', () => {
  it('accepts all supported Node shards, coverage, static, regeneration and rehearsal', () => {
    expect(requireFullMainCi(run(), jobs(), 'a'.repeat(40))).toBe(run().html_url);
    expect(FULL_CI_JOBS).toHaveLength(23);
  });
  it.each([
    'stale-sha',
    'fast-pr',
    'wrong-branch',
    'pending',
    'failed-run',
    'missing-shard',
    'missing-coverage',
    'missing-regen',
    'failed-job',
    'skipped-job',
    'pending-job',
    'wrong-url',
  ])('refuses %s evidence', (kind) => {
    const candidate = run();
    const evidence = jobs();
    if (kind === 'stale-sha') candidate.head_sha = 'b'.repeat(40);
    if (kind === 'fast-pr') candidate.event = 'pull_request';
    if (kind === 'wrong-branch') candidate.head_branch = 'feature';
    if (kind === 'pending') candidate.status = 'in_progress';
    if (kind === 'failed-run') candidate.conclusion = 'failure';
    if (kind === 'missing-shard')
      evidence.jobs = evidence.jobs.filter((job) => job.name !== 'ci (node 26.x, shard 5/5)');
    if (kind === 'missing-coverage')
      evidence.jobs = evidence.jobs.filter((job) => !job.name.startsWith('coverage'));
    if (kind === 'missing-regen')
      evidence.jobs = evidence.jobs.filter((job) => job.name !== 'clean-repository generation');
    if (kind === 'failed-job') evidence.jobs[0]!.conclusion = 'failure';
    if (kind === 'skipped-job') evidence.jobs[0]!.conclusion = 'skipped';
    if (kind === 'pending-job') evidence.jobs[0]!.status = 'in_progress';
    if (kind === 'wrong-url') candidate.html_url = 'https://other.example/runs/456';
    expect(() => requireFullMainCi(candidate, evidence, 'a'.repeat(40))).toThrow('full main CI');
  });
});

describe('the checked out source is the reviewed release source', () => {
  const source = {
    repository: 'InsiderFinance/totalfinance',
    eventName: 'release',
    ref: 'refs/tags/totalfinance-v0.1.3',
    eventCommit: 'a'.repeat(40),
    commit: 'a'.repeat(40),
    tagCommit: 'a'.repeat(40),
    onMain: true,
    versions: ['0.1.3', '0.1.3'],
  };
  it('accepts the prepared distributions at a tag on main', () => {
    expect(() => requireReleaseCheckout(publishedSdkRelease(event()), source)).not.toThrow();
  });
  it.each([
    'branch-ref',
    'wrong-repository',
    'manual-dispatch',
    'different-checkout',
    'moved-tag',
    'off-main',
    'wrong-sdk-version',
    'wrong-mcp-version',
    'missing-version',
  ])('refuses %s before packing or publishing', (kind) => {
    const value = { ...source, versions: [...source.versions] };
    if (kind === 'branch-ref') value.ref = 'refs/heads/main';
    if (kind === 'wrong-repository') value.repository = 'other/totalfinance';
    if (kind === 'manual-dispatch') value.eventName = 'workflow_dispatch';
    if (kind === 'different-checkout') value.eventCommit = 'b'.repeat(40);
    if (kind === 'moved-tag') value.tagCommit = 'b'.repeat(40);
    if (kind === 'off-main') value.onMain = false;
    if (kind === 'wrong-sdk-version') value.versions[0] = '0.1.2';
    if (kind === 'wrong-mcp-version') value.versions[1] = '0.1.2';
    if (kind === 'missing-version') value.versions.pop();
    expect(() => requireReleaseCheckout(publishedSdkRelease(event()), value)).toThrow(
      'commit on main',
    );
  });
});

describe('release reruns preserve later latest versions', () => {
  it.each([undefined, '0.1.2', '0.1.3'])(
    'allows an absent, older or identical latest %s',
    (latest) => {
      expect(() => requireForwardLatest('0.1.3', latest)).not.toThrow();
    },
  );
  it.each(['0.1.4', '0.2.0', '1.0.0'])('refuses downgrade from %s', (latest) => {
    expect(() => requireForwardLatest('0.1.3', latest)).toThrow('newer npm latest');
  });
  it('compares minor/patch components numerically and does not treat prereleases as stable', () => {
    expect(() => requireForwardLatest('0.1.10', '0.1.9')).not.toThrow();
    expect(() => requireForwardLatest('0.1.3', '0.1.3-rc.1')).toThrow();
  });
});
