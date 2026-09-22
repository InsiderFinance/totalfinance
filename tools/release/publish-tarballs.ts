/** Publish approved bytes main-first under candidate; never advance latest here. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NPMJS, verifyApproved, type ReleaseManifest } from './artifact-policy.js';
import {
  assertCandidateTags,
  planPublication,
  registryTags,
  releaseRegistry,
} from './registry-policy.js';
export { verifyApproved } from './artifact-policy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function assertReleaseSource(manifest: ReleaseManifest): void {
  if (
    manifest.sourceDirty !== false ||
    git(['rev-parse', 'HEAD']) !== manifest.commit ||
    git(['status', '--porcelain', '--untracked-files=all', '--', '.'])
  )
    throw new Error(
      'Public release requires approved clean-source artifacts and a clean matching checkout',
    );
}

export function assertPublishToolchain(node: string, npm: string): void {
  const version = npm.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (
    !/^24\./.test(node) ||
    !version ||
    Number(version[1]) < 11 ||
    (Number(version[1]) === 11 &&
      (Number(version[2]) < 5 || (Number(version[2]) === 5 && Number(version[3]) < 1)))
  )
    throw new Error('Trusted publishing requires the pinned Node 24 runtime and npm >=11.5.1');
}

export async function rehearsalToken(
  registry: string,
  request: typeof fetch = fetch,
): Promise<string> {
  if (!releaseRegistry(registry).loopback)
    throw new Error('Rehearsal authentication is loopback-only');
  const url = `${registry}/-/user/org.couchdb.user:rehearsal`;
  const options: RequestInit = {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'rehearsal',
      password: 'rehearsal-only-local-registry',
      email: 'rehearsal@localhost',
      type: 'user',
      roles: [],
      date: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  };
  let response = await request(url, options);
  // Existing Verdaccio users log in with Basic authentication; blindly creating again returns 409.
  if (response.status === 409) {
    response = await request(url, {
      ...options,
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from('rehearsal:rehearsal-only-local-registry').toString('base64')}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  }
  const body = (await response.json()) as { token?: string };
  if (!response.ok || !body.token)
    throw new Error(`Could not obtain loopback rehearsal token (${response.status})`);
  return body.token;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === '--')),
    options: {
      dir: { type: 'string', default: 'release' },
      registry: { type: 'string', default: NPMJS },
      tag: { type: 'string', default: 'candidate' },
      'dry-run': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      'bootstrap-token': { type: 'boolean', default: false },
      'expect-version': { type: 'string' },
    },
    strict: true,
  });
  const { registry, loopback } = releaseRegistry(values.registry!);
  if (loopback && values['bootstrap-token'])
    throw new Error(
      'Bootstrap tokens are only for the explicitly approved first public publication',
    );
  if (values.tag !== 'candidate')
    throw new Error('Publication must use candidate; latest needs separate post-smoke promotion');
  const dir = resolve(ROOT, values.dir!);
  const manifest = verifyApproved(dir);
  if (values['bootstrap-token'] && manifest.version !== '0.1.0')
    throw new Error('Bootstrap authentication is restricted to the initial 0.1.0 pair');
  if (values['expect-version'] && manifest.version !== values['expect-version'])
    throw new Error('Approved manifest version differs from the requested version');
  if (!loopback) {
    assertReleaseSource(manifest);
    if (!values['dry-run']) {
      if (
        process.env['GITHUB_ACTIONS'] !== 'true' ||
        process.env['GITHUB_REF'] !== 'refs/heads/main' ||
        process.env['TOTALFINANCE_RELEASE_ENABLED'] !== 'true'
      )
        throw new Error(
          'Public publishing is allowed only in the explicitly enabled approval-gated GitHub workflow',
        );
      if (
        values['bootstrap-token']
          ? !process.env['NODE_AUTH_TOKEN']
          : !process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] ||
            !process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']
      )
        throw new Error(
          'Selected publication authentication is unavailable; automatic fallback is forbidden',
        );
      assertPublishToolchain(
        process.versions.node,
        execFileSync('npm', ['--version'], { encoding: 'utf8' }),
      );
    }
  }
  // Inspect the entire remote group before any mutation. Resume skips only byte-identical versions.
  const existing = values['dry-run']
    ? []
    : await planPublication(manifest, registry, values.resume!);
  const tagsBefore =
    !loopback && !values['dry-run']
      ? await Promise.all(
          manifest.packages.map((artifact) => registryTags(artifact.package, registry)),
        )
      : undefined;
  if (tagsBefore?.some((tags) => tags['latest'] === manifest.version))
    throw new Error(
      'This version is already latest; stop candidate publication and verify its promotion record',
    );
  const home = mkdtempSync(join(tmpdir(), 'totalfinance-publish-'));
  try {
    const userconfig = join(home, '.npmrc');
    const token =
      loopback && !values['dry-run'] && existing.some((present) => !present)
        ? await rehearsalToken(registry)
        : undefined;
    const auth = values['bootstrap-token']
      ? '//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n'
      : token
        ? `//${new URL(registry).host}/:_authToken=${token}\n`
        : '';
    writeFileSync(
      userconfig,
      `registry=${registry}/\n@insiderfinance:registry=${registry}/\n${auth}`,
    );
    for (const [index, artifact] of manifest.packages.entries()) {
      if (existing[index]) {
        process.stdout.write(
          `release:publish: verified existing ${artifact.package}@${artifact.version}; not republishing\n`,
        );
        continue;
      }
      verifyApproved(dir);
      const args = [
        'publish',
        join(dir, artifact.tarball),
        '--registry',
        `${registry}/`,
        '--tag',
        'candidate',
        '--access',
        'public',
        loopback ? '--provenance=false' : '--provenance',
        '--ignore-scripts',
        '--loglevel=error',
        '--userconfig',
        userconfig,
      ];
      if (values['dry-run']) args.push('--dry-run');
      execFileSync('npm', args, { cwd: home, stdio: ['ignore', 'inherit', 'inherit'] });
      process.stdout.write(
        `release:publish: ${artifact.package}@${artifact.version} ${artifact.sha256}\n`,
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  if (tagsBefore) {
    for (const [index, artifact] of manifest.packages.entries())
      assertCandidateTags(
        artifact.package,
        artifact.version,
        tagsBefore[index]!,
        await registryTags(artifact.package, registry),
      );
  }
  process.stdout.write(
    `release:publish: ${manifest.packages.length} candidate artifacts checked; ${tagsBefore ? 'public candidate/latest tags verified' : loopback ? 'local rehearsal only (Verdaccio may synthesize latest)' : 'dry run; no uploads or tag changes'}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `release:publish: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
