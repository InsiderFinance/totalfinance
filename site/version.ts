import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_PACKAGE_NAME, publicPackageDirectories } from '../tools/public-packages.js';

import type { SiteVersion } from './version-types.js';

export type { SiteVersion } from './version-types.js';

/** The docs describe the version in the public package manifests, which releases publish to npm. */
export function readSiteVersion(root: string): SiteVersion {
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
  const stage = version.includes('-') ? 'Preview' : version.startsWith('0.') ? 'Pre-1.0' : 'Stable';
  return { version, label: `${stage} · ${version}`, packageVersions };
}
