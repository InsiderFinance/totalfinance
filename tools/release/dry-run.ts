/**
 * `pnpm release:dry-run` — the every-public-publish gate's local half (Stage 5A, Decision 6).
 *
 * Runs the whole landing standard (`pnpm run ci`), packs every package of the fixed group into
 * `release/`, and writes `release/RELEASE_HASHES.json`: one `{ package, version, tarball, sha256,
 * bytes }` row per artifact plus the commit they were built from. A maintainer approves THOSE hashes
 * in the `npm-publish` environment, and the publish job re-packs and refuses if a single byte differs
 * uploads exactly those tarballs (`tools/release/publish-tarballs.ts`) after re-checking their
 * hashes. Re-packing is NOT the check: `pnpm pack` rewrites `workspace:*` dependencies in an order
 * that is not stable across runs, so the approved artifacts are what ships, not a rebuild of them.
 *
 *   --skip-ci            the caller already ran `pnpm run ci` on this tree (the hosted verify job)
 *   --out <dir>          where the tarballs and manifest go (default `release/`, git-ignored)
 *   --allow-dirty        pack an uncommitted tree (never for a real release; useful while iterating)
 *   --expect-version <v> refuse unless every package is exactly this version (the workflow's input)
 *   --evidence <path>    also copy the manifest to this path (committed under docs/evidence/)
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG_DIR = join(ROOT, 'packages');

export interface ReleaseArtifact {
  package: string;
  version: string;
  tarball: string;
  sha256: string;
  bytes: number;
}

export interface ReleaseManifest {
  /** The fixed-group version every artifact carries. */
  version: string;
  /** The commit the artifacts were packed from. */
  commit: string;
  /** Sorted by package name; the order is part of the manifest's identity. */
  packages: ReleaseArtifact[];
}

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

/** The fixed group, read from the filesystem — the same source the preview-surface audit uses. */
export function readFixedGroup(): { dir: string; name: string; version: string }[] {
  const out: { dir: string; name: string; version: string }[] = [];
  for (const dir of readdirSync(PKG_DIR).sort()) {
    let manifest: { name?: string; version?: string; private?: boolean };
    try {
      manifest = JSON.parse(
        readFileSync(join(PKG_DIR, dir, 'package.json'), 'utf8'),
      ) as typeof manifest;
    } catch {
      continue;
    }
    if (!manifest.name || !manifest.version) continue;
    if (manifest.private)
      fail(`${manifest.name} is private; the fixed group cannot contain a private package`);
    out.push({ dir, name: manifest.name, version: manifest.version });
  }
  if (out.length === 0) fail('no packages found under packages/');
  return out;
}

export function sha256Of(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Pack the whole group into `out` and describe every artifact. */
export function packGroup(out: string, commit: string): ReleaseManifest {
  const group = readFixedGroup();
  const versions = new Set(group.map((p) => p.version));
  if (versions.size !== 1)
    fail(`the fixed group carries ${versions.size} versions: ${[...versions].join(', ')}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const packages: ReleaseArtifact[] = [];
  for (const pkg of group) {
    const printed = sh('pnpm', ['pack', '--pack-destination', out], join(PKG_DIR, pkg.dir)).trim();
    const tarball = printed.split('\n').at(-1)!.trim();
    packages.push({
      package: pkg.name,
      version: pkg.version,
      tarball: basename(tarball),
      sha256: sha256Of(tarball),
      bytes: statSync(tarball).size,
    });
  }
  packages.sort((a, b) => a.package.localeCompare(b.package));
  return { version: [...versions][0]!, commit, packages };
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
