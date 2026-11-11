/** Policy for the SDK-only GitHub Release path; the older candidate-pair policy is unchanged. */
import { object, releaseVersion } from './artifact-policy.js';

export function publishedSdkRelease(value: unknown): { version: string; tag: string; id: number } {
  const event = object(value, 'GitHub event');
  const repository = object(event['repository'], 'release repository');
  const release = object(event['release'], 'GitHub release');
  if (
    event['action'] !== 'published' ||
    repository['full_name'] !== 'InsiderFinance/totalfinance' ||
    release['draft'] !== false ||
    release['prerelease'] !== false ||
    !Number.isSafeInteger(release['id']) ||
    (release['id'] as number) <= 0 ||
    typeof release['tag_name'] !== 'string' ||
    !release['tag_name'].startsWith('totalfinance-v')
  )
    throw new Error('SDK publication requires a published, non-prerelease TotalFinance release');
  const version = release['tag_name'].slice('totalfinance-v'.length);
  releaseVersion(version);
  return { version, tag: release['tag_name'], id: release['id'] as number };
}

export const FULL_CI_JOBS = [
  ...['22.13.0', '24.x', '26.x'].flatMap((node) => [
    ...[1, 2, 3, 4, 5].map((shard) => `ci (node ${node}, shard ${shard}/5)`),
    `static checks (node ${node})`,
    `coverage (node ${node})`,
  ]),
  'clean-repository generation',
  'release rehearsal (local registry)',
];

export function requireReleaseCheckout(
  release: { version: string; tag: string },
  source: {
    repository: string | undefined;
    eventName: string | undefined;
    ref: string | undefined;
    eventCommit: string | undefined;
    commit: string;
    tagCommit: string;
    onMain: boolean;
    versions: unknown[];
  },
): void {
  if (
    source.repository !== 'InsiderFinance/totalfinance' ||
    source.eventName !== 'release' ||
    source.ref !== `refs/tags/${release.tag}` ||
    source.eventCommit !== source.commit ||
    source.tagCommit !== source.commit ||
    !source.onMain ||
    source.versions.length !== 2 ||
    source.versions.some((version) => version !== release.version)
  )
    throw new Error('Release tag, checkout and prepared versions must match one commit on main');
}

export function requireFullMainCi(run: unknown, jobs: unknown, commit: string): string {
  const record = object(run, 'full CI run');
  const jobList = object(jobs, 'full CI jobs')['jobs'];
  if (
    record['head_sha'] !== commit ||
    record['head_branch'] !== 'main' ||
    record['event'] !== 'push' ||
    record['status'] !== 'completed' ||
    record['conclusion'] !== 'success' ||
    !Array.isArray(jobList) ||
    FULL_CI_JOBS.some(
      (name) =>
        !jobList.some((job: unknown) => {
          const entry = object(job, 'CI job');
          return (
            entry['name'] === name &&
            entry['status'] === 'completed' &&
            entry['conclusion'] === 'success'
          );
        }),
    ) ||
    jobList.some((job: unknown) => object(job, 'CI job')['conclusion'] !== 'success') ||
    typeof record['html_url'] !== 'string' ||
    !record['html_url'].startsWith('https://github.com/InsiderFinance/totalfinance/actions/runs/')
  )
    throw new Error(
      'Release requires successful full main CI at this exact tag commit; rerun after CI completes',
    );
  return record['html_url'];
}

/** An old release rerun must not roll npm discovery back over a later release. */
export function requireForwardLatest(version: string, latest: string | undefined): void {
  releaseVersion(version);
  if (latest === undefined) return;
  releaseVersion(latest);
  const target = version.split('.').map(Number);
  const current = latest.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (target[index]! > current[index]!) return;
    if (target[index]! < current[index]!)
      throw new Error(`Refusing to replace newer npm latest ${latest} with ${version}`);
  }
}
