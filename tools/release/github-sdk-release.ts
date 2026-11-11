/** GitHub-release SDK publisher. Reuses pair inspection and consumer journeys; uploads only SDK. */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PUBLIC_PACKAGE_NAME, MCP_PACKAGE_NAME } from '../public-packages.js';
import { NPMJS, PUBLIC_ROSTER, object, sha256Of, verifyApproved } from './artifact-policy.js';
import {
  publishedSdkRelease,
  requireForwardLatest,
  requireFullMainCi,
  requireReleaseCheckout,
} from './github-sdk-policy.js';
import { assertPublishToolchain, assertReleaseSource, rehearsalToken } from './publish-tarballs.js';
import { registryTags, releaseRegistry, verifyRegistryArtifact } from './registry-policy.js';
import {
  captureSmokeSource,
  compare,
  observeWithEvidence,
  type SmokeObservation,
} from './registry-smoke.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = 'repos/InsiderFinance/totalfinance';

function run(command: string, args: string[], cwd = ROOT): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}
function git(args: string[]): string {
  return run('git', args);
}
function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}
function retain(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function releaseContext() {
  if (
    process.env['GITHUB_ACTIONS'] !== 'true' ||
    process.env['GITHUB_EVENT_NAME'] !== 'release' ||
    process.env['GITHUB_REPOSITORY'] !== 'InsiderFinance/totalfinance' ||
    !process.env['GITHUB_EVENT_PATH']
  )
    throw new Error('Public SDK publication requires the GitHub release workflow');
  const release = publishedSdkRelease(json(process.env['GITHUB_EVENT_PATH']));
  const commit = git(['rev-parse', 'HEAD']);
  let onMain = false;
  try {
    git(['merge-base', '--is-ancestor', commit, 'origin/main']);
    onMain = true;
  } catch {
    /* refused below */
  }
  requireReleaseCheckout(release, {
    repository: process.env['GITHUB_REPOSITORY'],
    eventName: process.env['GITHUB_EVENT_NAME'],
    ref: process.env['GITHUB_REF'],
    eventCommit: process.env['GITHUB_SHA'],
    commit,
    tagCommit: git(['rev-parse', `${release.tag}^{commit}`]),
    onMain,
    versions: ['totalfinance', 'mcp'].map(
      (dir) =>
        object(json(join(ROOT, 'distribution', dir, 'package.json')), 'distribution')['version'],
    ),
  });
  return { ...release, commit };
}

function requireEnabled(): void {
  if (process.env['TOTALFINANCE_RELEASE_ENABLED'] !== 'true')
    throw new Error(
      'Publication is disabled: configure npm trusted publishing and the GitHub environment, then enable TOTALFINANCE_RELEASE_ENABLED',
    );
}

function verify(): void {
  requireEnabled();
  const release = releaseContext();
  const runs = object(
    JSON.parse(
      run('gh', [
        'api',
        `${REPO}/actions/workflows/totalfinance-ci.yml/runs?head_sha=${release.commit}&status=success&per_page=100`,
      ]),
    ),
    'CI runs',
  )['workflow_runs'];
  if (!Array.isArray(runs)) throw new Error('Cannot read full main CI runs');
  const candidate = runs.find((value: unknown) => {
    const entry = object(value, 'CI run');
    return (
      entry['head_sha'] === release.commit &&
      entry['head_branch'] === 'main' &&
      entry['event'] === 'push'
    );
  });
  if (!candidate)
    throw new Error(
      'No successful full main CI for this release commit; wait for main CI and rerun',
    );
  const id = object(candidate, 'CI run')['id'];
  if (!Number.isSafeInteger(id)) throw new Error('Invalid full CI run identity');
  const jobs: unknown = JSON.parse(
    run('gh', ['api', `${REPO}/actions/runs/${id}/jobs?per_page=100`]),
  );
  const fullCi = requireFullMainCi(candidate, jobs, release.commit);
  retain(join(ROOT, 'release', 'SDK_RELEASE_SOURCE.json'), { ...release, fullCi });
  if (process.env['GITHUB_OUTPUT'])
    appendFileSync(
      process.env['GITHUB_OUTPUT'],
      `version=${release.version}\ntag=${release.tag}\n`,
    );
  console.log(`SDK release source verified: ${release.commit}; full CI ${fullCi}`);
}

export async function publishSdk(dir: string, registryValue = NPMJS): Promise<void> {
  const { registry, loopback } = releaseRegistry(registryValue);
  let release: ReturnType<typeof releaseContext> | undefined;
  if (!loopback) {
    requireEnabled();
    release = releaseContext();
    if (
      !process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] ||
      !process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] ||
      process.env['NODE_AUTH_TOKEN']
    )
      throw new Error('SDK publication requires OIDC with no npm-token fallback');
    assertPublishToolchain(process.versions.node, run('npm', ['--version']));
  }
  const manifest = verifyApproved(dir);
  assertReleaseSource(manifest);
  const sdk = manifest.packages[0]!;
  if (sdk.package !== PUBLIC_PACKAGE_NAME) throw new Error('First artifact must be the public SDK');
  if (release && (release.version !== manifest.version || release.commit !== manifest.commit))
    throw new Error('Approved bytes do not match the published GitHub Release');
  const before = await registryTags(sdk.package, registry);
  requireForwardLatest(manifest.version, before['latest']);
  const exists = await verifyRegistryArtifact(sdk, registry);
  if (!exists) {
    const home = mkdtempSync(join(tmpdir(), 'totalfinance-sdk-publish-'));
    try {
      const userconfig = join(home, '.npmrc');
      const token = loopback ? await rehearsalToken(registry) : undefined;
      writeFileSync(
        userconfig,
        `registry=${registry}/\n@insiderfinance:registry=${registry}/\n${token ? `//${new URL(registry).host}/:_authToken=${token}\n` : ''}`,
      );
      execFileSync(
        'npm',
        [
          'publish',
          join(dir, sdk.tarball),
          '--registry',
          `${registry}/`,
          '--tag',
          'latest',
          '--access',
          'public',
          loopback ? '--provenance=false' : '--provenance',
          '--ignore-scripts',
          '--userconfig',
          userconfig,
        ],
        { cwd: home, stdio: 'inherit' },
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  const after = await registryTags(sdk.package, registry);
  if (after['latest'] !== manifest.version || !(await verifyRegistryArtifact(sdk, registry)))
    throw new Error(
      'SDK upload/latest readback does not match approval; preserve artifacts and recover the original job',
    );
  retain(join(dir, 'SDK_PUBLISH_RECEIPT.json'), {
    kind: loopback ? 'loopback-rehearsal' : 'sdk-publication',
    commit: manifest.commit,
    sdk,
    registry,
    resumed: exists,
    before,
    after,
  });
  console.log(
    `SDK ${exists ? 'byte-verified existing version' : 'published'}: ${sdk.package}@${sdk.version}; MCP not uploaded`,
  );
}

export async function smokeSdk(
  dir: string,
  registryValue = NPMJS,
  receipt?: string,
): Promise<void> {
  const { registry, loopback } = releaseRegistry(registryValue);
  const manifest = verifyApproved(dir);
  assertReleaseSource(manifest);
  const [sdk, mcp] = manifest.packages;
  if (!sdk || !mcp || sdk.package !== PUBLIC_PACKAGE_NAME || mcp.package !== MCP_PACKAGE_NAME)
    throw new Error('SDK smoke needs the approved SDK and local optional MCP witness');
  if (!(await verifyRegistryArtifact(sdk, registry))) throw new Error('Registry SDK is missing');
  const consumer = mkdtempSync(join(tmpdir(), 'totalfinance-sdk-smoke-'));
  try {
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({
        name: 'totalfinance-sdk-smoke',
        private: true,
        type: 'module',
        dependencies: {
          [sdk.package]: sdk.version,
          [mcp.package]: `file:${join(dir, mcp.tarball)}`,
        },
      }),
    );
    writeFileSync(
      join(consumer, '.npmrc'),
      `registry=${registry}/\n@insiderfinance:registry=${registry}/\n`,
    );
    run(
      'npm',
      [
        'install',
        '--registry',
        `${registry}/`,
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--loglevel=error',
      ],
      consumer,
    );
    const evidence = observeWithEvidence(consumer, manifest.version, [...PUBLIC_ROSTER]);
    const expected = join(ROOT, 'tools/release/smoke-expected.json');
    const differences = compare(evidence.observation, json(expected) as SmokeObservation);
    if (differences.length)
      throw new Error(
        `SDK consumer differs from approved expectations:\n${differences.join('\n')}`,
      );
    const source = captureSmokeSource();
    if (source.sourceDirty || source.sourceCommit !== manifest.commit)
      throw new Error('Smoke source changed');
    retain(receipt ?? join(dir, `SDK_SMOKE_RECEIPT-${manifest.version}.json`), {
      schemaVersion: 1,
      kind: loopback ? 'sdk-loopback-rehearsal' : 'sdk-registry-verification',
      version: manifest.version,
      ...source,
      verifiedAt: new Date().toISOString(),
      registry,
      publicPackages: [sdk],
      localWitness: mcp,
      manifestSha256: sha256Of(join(dir, 'RELEASE_HASHES.json')),
      expectations: { matched: true, sha256: sha256Of(expected) },
      ...evidence,
    });
    console.log(
      `SDK registry smoke passed: ${evidence.siteExamples.cases} strict site examples; MCP tested from approved local tarball only`,
    );
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      dir: { type: 'string', default: 'release/approved' },
      registry: { type: 'string', default: NPMJS },
      receipt: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const dir = resolve(ROOT, values.dir!);
  if (positionals.length !== 1) throw new Error('Choose verify, publish or smoke');
  if (positionals[0] === 'verify') verify();
  else if (positionals[0] === 'publish') await publishSdk(dir, values.registry!);
  else if (positionals[0] === 'smoke')
    await smokeSdk(
      dir,
      values.registry!,
      values.receipt ? resolve(ROOT, values.receipt) : undefined,
    );
  else throw new Error('Choose verify, publish or smoke');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
