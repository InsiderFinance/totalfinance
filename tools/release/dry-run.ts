/**
 * `pnpm release:dry-run` — the every-public-publish gate's local half (Stage 5A, Decision 6).
 *
 * Runs the whole landing standard (`pnpm run ci`), packs every package of the fixed group into
 * `release/`, and writes `release/RELEASE_HASHES.json`: one `{ package, version, tarball, sha256,
 * bytes }` row per artifact plus the commit they were built from. A maintainer approves THOSE hashes
 * in the `npm-publish` environment, and the publish job
 * uploads exactly those tarballs (`tools/release/publish-tarballs.ts`) after re-checking their
 * hashes. Re-packing is NOT the approval check: upload the approved artifacts themselves,
 * not a rebuild that happens to carry the same version number.
 *
 *   --skip-ci            the caller already ran `pnpm run ci` on this tree (the hosted verify job)
 *   --out <dir>          where the tarballs and manifest go (default `release/`, git-ignored)
 *   --allow-dirty        pack an uncommitted tree (never for a real release; useful while iterating)
 *   --expect-version <v> refuse unless every package is exactly this version (the workflow's input)
 *   --evidence <path>    also copy the manifest to this path (committed under docs/evidence/)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { publicPackageDirectories } from '../public-packages.js';
import {
  inspectTarball,
  releaseVersion,
  sha256Of,
  tarballName,
  validatePackageMetadata,
  type ReleaseArtifact,
  type ReleaseManifest,
} from './artifact-policy.js';
export { sha256Of, type ReleaseArtifact, type ReleaseManifest } from './artifact-policy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sh(cmd: string, args: string[], cwd: string, inherit = false): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }) as string;
}

function fail(message: string, code = 2): never {
  process.stderr.write(`release:dry-run: ${message}\n`);
  process.exit(code);
}

/** `path` is absolute; callers must never resolve `dir` relative to packages/. */
export function readFixedGroup(
  root = ROOT,
): { dir: string; name: string; path: string; version: string }[] {
  const directories = readdirSync(join(root, 'distribution'))
    .filter((dir) => existsSync(join(root, 'distribution', dir, 'package.json')))
    .sort();
  if (JSON.stringify(directories) !== JSON.stringify(['mcp', 'totalfinance']))
    throw new Error('Distribution must contain exactly the main and MCP workspaces');
  const group = publicPackageDirectories(root).map((pkg) => {
    const manifest = JSON.parse(readFileSync(join(pkg.path, 'package.json'), 'utf8')) as {
      version: unknown;
    };
    releaseVersion(manifest.version);
    validatePackageMetadata(manifest, pkg.name, manifest.version);
    return { ...pkg, version: manifest.version };
  });
  if (new Set(group.map((pkg) => pkg.version)).size !== 1)
    throw new Error('The two public artifacts must have the same version');
  for (const dir of readdirSync(join(root, 'packages'))) {
    const path = join(root, 'packages', dir, 'package.json');
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { private?: boolean };
    if (pkg.private !== true) throw new Error(`Source workspace packages/${dir} must be private`);
  }
  return group;
}

/** Pack the whole group into `out` and describe every artifact. */
export function packGroup(out: string, commit: string): ReleaseManifest {
  const group = readFixedGroup();
  const versions = new Set(group.map((p) => p.version));
  if (versions.size !== 1)
    fail(`the fixed group carries ${versions.size} versions: ${[...versions].join(', ')}`);
  out = resolve(out);
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).some((file) => file.endsWith('.tgz') || file === 'RELEASE_HASHES.json'))
    throw new Error(
      'Output already contains release artifacts; use a fresh directory (never overwrite approved bytes)',
    );
  const packages: ReleaseArtifact[] = [];
  for (const pkg of group) {
    sh('pnpm', ['pack', '--pack-destination', out, '--config.ignore-scripts=true'], pkg.path);
    const tarball = join(out, tarballName(pkg.name, pkg.version));
    const artifact = {
      package: pkg.name,
      version: pkg.version,
      tarball: basename(tarball),
      sha256: sha256Of(tarball),
      bytes: statSync(tarball).size,
    };
    inspectTarball(tarball, artifact);
    packages.push(artifact);
  }
  return {
    version: [...versions][0]!,
    commit,
    sourceDirty:
      sh('git', ['status', '--porcelain', '--untracked-files=all', '--', '.'], ROOT).trim().length >
      0,
    packages,
  };
}

function main(): void {
  const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  const { values } = parseArgs({
    args,
    options: {
      'skip-ci': { type: 'boolean', default: false },
      out: { type: 'string', default: 'release' },
      'allow-dirty': { type: 'boolean', default: false },
      'expect-version': { type: 'string' },
      evidence: { type: 'string' },
    },
    strict: true,
  });
  const out = resolve(ROOT, values.out!);
  const commit = sh('git', ['rev-parse', 'HEAD'], ROOT).trim();
  const dirty = sh('git', ['status', '--porcelain', '--', '.'], ROOT).trim();
  if (dirty && !values['allow-dirty']) {
    fail(
      `the working tree is not clean; a release is packed from a commit, not a tree:\n${dirty}\n(pass --allow-dirty only while iterating)`,
    );
  }
  const group = readFixedGroup();
  if (values['expect-version'] !== undefined) {
    const off = group.filter((p) => p.version !== values['expect-version']);
    if (off.length > 0) {
      fail(
        `expected version ${values['expect-version']} but ${off.map((p) => `${p.name}@${p.version}`).join(', ')} differ`,
      );
    }
  }
  if (!values['skip-ci']) {
    process.stdout.write('release:dry-run: running the landing standard (pnpm run ci)\n');
    sh('pnpm', ['run', 'ci'], ROOT, true);
  }
  const manifest = packGroup(out, commit);
  if (sh('git', ['rev-parse', 'HEAD'], ROOT).trim() !== commit)
    fail('HEAD changed during packing; discard this rehearsal and rerun from one commit');
  if (!values['allow-dirty'] && manifest.sourceDirty !== false)
    fail('Source changed during verification/packing; no approval manifest will be issued');

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(out, 'RELEASE_HASHES.json'), json);
  if (values.evidence !== undefined) {
    const target = resolve(ROOT, values.evidence);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, json);
  }
  const widest = Math.max(...manifest.packages.map((p) => p.package.length));
  process.stdout.write(
    `release:dry-run: ${manifest.version} @ ${manifest.commit} — ${manifest.packages.length} artifacts in ${out}\n`,
  );
  for (const p of manifest.packages) {
    process.stdout.write(
      `  ${p.package.padEnd(widest)}  ${p.sha256.slice(0, 16)}  ${String(p.bytes).padStart(9)} B  ${p.tarball}\n`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
