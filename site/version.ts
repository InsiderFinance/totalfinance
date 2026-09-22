import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { siteExamplesSha256 } from '../tools/site-examples-smoke.js';
import { PUBLIC_PACKAGE_NAME, publicPackageDirectories } from '../tools/public-packages.js';

export interface VerifiedRelease {
  version: string;
  channel: 'preview' | 'stable';
  verifiedAt: string;
  sourceCommit: string;
  registry: string;
  examplesSha256: string;
}

export interface SiteVersion {
  version: string;
  label: string;
  channel: 'development' | 'preview' | 'stable';
  published: boolean;
  sourceMatchesRelease: boolean;
  packageVersions: Record<string, string>;
  releases: VerifiedRelease[];
}

export function sourceMatchesRelease(root: string, release: VerifiedRelease): boolean {
  try {
    // A version string alone is not evidence: a working checkout may already differ from npm.
    execFileSync(
      'git',
      [
        'diff',
        '--quiet',
        release.sourceCommit,
        '--',
        'packages',
        'distribution',
        'tools/assemble-distribution.ts',
        'tools/public-packages.ts',
      ],
      {
        cwd: root,
        stdio: 'pipe',
      },
    );
    const untracked = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', 'packages', 'distribution'],
      { cwd: root, encoding: 'utf8' },
    );
    return untracked.trim() === '' && siteExamplesSha256() === release.examplesSha256;
  } catch {
    return false;
  }
}

export function readSiteVersion(root: string, verifySource = sourceMatchesRelease): SiteVersion {
  const packageVersions: Record<string, string> = {};
  for (const { path } of publicPackageDirectories(root)) {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    packageVersions[manifest.name] = manifest.version;
  }
  const version = packageVersions[PUBLIC_PACKAGE_NAME]!;
  if (!version || Object.values(packageVersions).some((candidate) => candidate !== version))
    throw new Error('Site build requires both public distributions at one exact version.');
  const ledger = JSON.parse(readFileSync(join(root, 'site/releases.json'), 'utf8')) as {
    schemaVersion: number;
    releases: VerifiedRelease[];
  };
  if (
    !ledger ||
    ledger.schemaVersion !== 1 ||
    !Array.isArray(ledger.releases) ||
    Object.keys(ledger).some((key) => !['schemaVersion', 'releases'].includes(key))
  )
    throw new Error('Invalid site release-evidence ledger.');
  const seen = new Set<string>();
  for (const release of ledger.releases) {
    if (
      !release ||
      Object.keys(release).some(
        (key) =>
          ![
            'version',
            'channel',
            'verifiedAt',
            'sourceCommit',
            'registry',
            'examplesSha256',
          ].includes(key),
      ) ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(release.version) ||
      seen.has(release.version) ||
      !['preview', 'stable'].includes(release.channel) ||
      !Number.isFinite(Date.parse(release.verifiedAt)) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(release.sourceCommit) ||
      !/^[a-f0-9]{64}$/.test(release.examplesSha256) ||
      !/^https:\/\/registry\.npmjs\.org\/?$/.test(release.registry)
    )
      throw new Error('Invalid or duplicate verified release evidence.');
    if ((release.channel === 'preview') !== release.version.includes('-'))
      throw new Error('Release channel must match the package version.');
    seen.add(release.version);
  }
  const recorded = ledger.releases.find((release) => release.version === version);
  const matched = recorded !== undefined && verifySource(root, recorded);
  const published = matched ? recorded : undefined;
  return {
    version,
    label: published
      ? `${published.channel === 'stable' ? (version.startsWith('0.') ? 'Pre-1.0 release' : 'Stable') : 'Preview'} · ${version}`
      : `Development · ${version} · ${recorded ? 'source differs from verified release' : 'unpublished'}`,
    channel: published?.channel ?? 'development',
    published: published !== undefined,
    sourceMatchesRelease: matched,
    packageVersions,
    releases: ledger.releases,
  };
}
