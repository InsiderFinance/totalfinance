import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteVersion } from './version.js';

/** Preserve previously built release snapshots; never regenerate old API pages from today's code. */
export function restoreReleaseArchives(
  directory: string | undefined,
  out: string,
  current: SiteVersion,
): string[] {
  if (directory === undefined) {
    if (
      current.published &&
      current.releases.some((release) => release.version !== current.version)
    )
      throw new Error(
        'A published docs build requires TOTALFINANCE_DOCS_ARCHIVES for previous verified releases.',
      );
    return [];
  }
  const restored: string[] = [];
  for (const release of current.releases) {
    if (release.version === current.version) continue;
    const source = join(directory, release.version);
    if (!existsSync(source)) {
      if (current.published)
        throw new Error(`Missing documentation archive for verified release ${release.version}.`);
      continue;
    }
    const walk = (path: string): void => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new Error('Documentation archives must not contain symlinks.');
      if (stat.isDirectory()) for (const child of readdirSync(path)) walk(join(path, child));
      else if (!/\.(?:html|css|js|json|txt)$/.test(path))
        throw new Error(`Unexpected documentation archive asset: ${path}`);
    };
    walk(source);
    const metadata = JSON.parse(readFileSync(join(source, 'version.json'), 'utf8')) as SiteVersion;
    const receipt = metadata.releases.find((candidate) => candidate.version === release.version);
    if (
      !metadata.published ||
      metadata.version !== release.version ||
      receipt?.sourceCommit !== release.sourceCommit ||
      receipt.examplesSha256 !== release.examplesSha256 ||
      receipt.registry !== release.registry
    )
      throw new Error(`Documentation archive does not match verified release ${release.version}.`);
    mkdirSync(join(out, 'versions'), { recursive: true });
    cpSync(source, join(out, 'versions', release.version), { recursive: true });
    restored.push(release.version);
  }
  return restored;
}
