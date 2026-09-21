/**
 * `pnpm release:publish -- [--dir release] [--registry <url>] [--tag preview] [--dry-run]` — publish
 * the artifacts a maintainer approved, unchanged (Stage 5A, Decision 6).
 *
 * `pnpm pack` rewrites `workspace:*` dependencies at pack time and does not emit them in a stable
 * order, so two packs of one commit can differ by a few bytes of `package.json`. A release therefore
 * cannot be "re-pack and compare": the manifest names the artifacts that were reviewed, and this
 * tool uploads exactly those tarballs after checking every sha256 against the manifest. What was
 * approved is what ships, byte for byte.
 *
 * Provenance is on by default (the packages' `publishConfig` asks for it; in the release workflow
 * the OIDC token attests the tarball digests). A loopback registry — the CI rehearsal's Verdaccio —
 * cannot attest, so provenance is turned off there explicitly, and the tool refuses a non-loopback
 * registry that is not npmjs.org: the rehearsal cannot be pointed at a third registry by accident.
 *
 *   --dir <dir>          the dry-run output (default `release/`): tarballs + RELEASE_HASHES.json
 *   --registry <url>     default https://registry.npmjs.org
 *   --tag <tag>          the dist-tag (default `preview`)
 *   --dry-run            `npm publish --dry-run` — everything but the upload
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256Of, type ReleaseManifest } from './dry-run.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NPMJS = 'https://registry.npmjs.org';

function fail(message: string): never {
  process.stderr.write(`release:publish: ${message}\n`);
  process.exit(2);
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** A token from the couchdb-style login endpoint a local registry exposes (registers on first use). */
async function rehearsalToken(registry: string): Promise<string> {
  const name = 'rehearsal';
  const response = await fetch(`${registry}/-/user/org.couchdb.user:${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      password: 'rehearsal-only-local-registry',
      email: 'rehearsal@localhost',
      type: 'user',
      roles: [],
      date: new Date().toISOString(),
    }),
  });
  const body = (await response.json()) as { token?: string; error?: string };
  if (!response.ok || !body.token) {
    fail(`could not obtain a token from ${registry}: ${response.status} ${body.error ?? ''}`);
  }
  return body.token;
}

/** Verify every tarball in `dir` against its manifest; returns the manifest. */
export function verifyApproved(dir: string): ReleaseManifest {
  const manifest = JSON.parse(
    readFileSync(join(dir, 'RELEASE_HASHES.json'), 'utf8'),
  ) as ReleaseManifest;
  const differences: string[] = [];
  for (const artifact of manifest.packages) {
    let actual: string;
    try {
      actual = sha256Of(join(dir, artifact.tarball));
    } catch {
      differences.push(`${artifact.tarball}: missing`);
      continue;
    }
    if (actual !== artifact.sha256) {
      differences.push(
        `${artifact.tarball}: ${actual.slice(0, 12)} ≠ approved ${artifact.sha256.slice(0, 12)}`,
      );
    }
  }
  if (differences.length > 0)
    fail(`the artifacts do not match the approved manifest:\n  ${differences.join('\n  ')}`);
  return manifest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  const { values } = parseArgs({
    args,
    options: {
      dir: { type: 'string', default: 'release' },
      registry: { type: 'string', default: NPMJS },
      tag: { type: 'string', default: 'preview' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const registry = values.registry!.replace(/\/$/, '');
  const url = new URL(registry);
  const loopback = isLoopback(url);
  if (!loopback && registry !== NPMJS) {
    fail(`refusing to publish to ${registry}: only npmjs.org or a loopback rehearsal registry`);
  }
  const dir = resolve(ROOT, values.dir!);
  const manifest = verifyApproved(dir);
  process.stdout.write(
    `release:publish: ${manifest.packages.length} approved artifacts @ ${manifest.version} (commit ${manifest.commit.slice(0, 9)}) → ${registry} [${values.tag}]${values['dry-run'] ? ' (dry run)' : ''}\n`,
  );

  let userconfig: string | undefined;
  let home: string | undefined;
  if (loopback) {
    home = mkdtempSync(join(tmpdir(), 'totalfinance-publish-rehearsal-'));
    userconfig = join(home, '.npmrc');
    writeFileSync(
      userconfig,
      `registry=${registry}/\n//${url.host}/:_authToken=${await rehearsalToken(registry)}\n`,
    );
  }
  try {
    for (const artifact of manifest.packages) {
      const npmArgs = [
        'publish',
        join(dir, artifact.tarball),
        '--registry',
        `${registry}/`,
        '--tag',
        values.tag!,
        '--access',
        'public',
        loopback ? '--provenance=false' : '--provenance',
        '--ignore-scripts',
        '--loglevel=error',
      ];
      if (userconfig) npmArgs.push('--userconfig', userconfig);
      if (values['dry-run']) npmArgs.push('--dry-run');
      execFileSync('npm', npmArgs, { cwd: dir, stdio: ['ignore', 'inherit', 'inherit'] });
      process.stdout.write(
        `release:publish: ${artifact.package}@${artifact.version} ${artifact.sha256.slice(0, 12)}\n`,
      );
    }
  } finally {
    if (home) rmSync(home, { recursive: true, force: true });
  }
  process.stdout.write(`release:publish: done — ${manifest.packages.length} artifacts\n`);
}

await main();
