/**
 * `pnpm site:build`: generate site inputs from the repository, statically export the Next.js
 * documentation site, post-process the export (Markdown twins, agent files, CSP, sitemap), then
 * build the immutable version-pinned snapshot and restore verified earlier releases.
 * Output: `site/dist`, a portable static site served under the configured base path.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreReleaseArchives } from './archives.js';
import { generate } from './scripts/generate.js';
import { postExport } from './scripts/postexport.js';
import { buildRuntime } from './scripts/runtime.js';
import { fetchGitHubStats } from './src/github.js';

const REPOSITORY = 'https://github.com/InsiderFinance/totalfinance';

const SITE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(SITE, 'dist');

export function basePath(): string {
  const value = process.env['TOTALFINANCE_DOCS_BASE_PATH'] ?? '/docs/totalfinance';
  if (value !== '' && (!value.startsWith('/') || value.endsWith('/')))
    throw new Error('TOTALFINANCE_DOCS_BASE_PATH must be empty or start, but not end, with "/".');
  return value;
}

function nextBuild(env: Record<string, string>): void {
  rmSync(join(SITE, 'out'), { recursive: true, force: true });
  if (env['TOTALFINANCE_NEXT_DIST_DIR'])
    rmSync(join(SITE, env['TOTALFINANCE_NEXT_DIST_DIR']), { recursive: true, force: true });
  const result = spawnSync(join(SITE, 'node_modules/.bin/next'), ['build'], {
    cwd: SITE,
    stdio: 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', ...env },
  });
  if (result.status !== 0) throw new Error(`next build failed with exit code ${result.status}.`);
}

export async function buildSite(): Promise<void> {
  if (!existsSync(join(SITE, 'node_modules/next')))
    throw new Error(
      'Site dependencies are missing. Run `pnpm --dir site install --frozen-lockfile` first.',
    );
  if (!existsSync(join(SITE, '../distribution/totalfinance/modules')))
    throw new Error('The built package is missing. Run `pnpm build` before `pnpm site:build`.');
  // Copy reviewed exports; brand regeneration remains a separate source-owned step.
  cpSync(join(SITE, 'brand/assets'), join(SITE, 'public/assets/brand'), { recursive: true });
  for (const name of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'og.png'])
    cpSync(join(SITE, 'brand/assets', name), join(SITE, 'public', name));
  const started = Date.now();
  const base = basePath();
  const generated = generate();
  const runtime = await buildRuntime(SITE);
  // The star count for the GitHub buttons; offline builds (or a GitHub outage) show no count.
  writeFileSync(
    join(SITE, '.generated/github.json'),
    JSON.stringify(
      process.env['TOTALFINANCE_DOCS_OFFLINE'] === '1'
        ? { stars: null, fetchedAt: null }
        : await fetchGitHubStats(REPOSITORY),
    ),
  );

  // Verified earlier releases are restored byte-for-byte, never regenerated from today's source.
  const staging = mkdtempSync(join(tmpdir(), 'totalfinance-docs-archives-'));
  const archived = restoreReleaseArchives(
    process.env['TOTALFINANCE_DOCS_ARCHIVES'],
    staging,
    generated.version,
  );
  writeFileSync(
    join(SITE, '.generated/archives.json'),
    JSON.stringify({ current: generated.version.version, archived }),
  );

  nextBuild({ TOTALFINANCE_DOCS_BASE_PATH: base });
  rmSync(OUT, { recursive: true, force: true });
  renameSync(join(SITE, 'out'), OUT);
  const summary = await postExport({ out: OUT, basePath: base, generated });

  // The version-pinned snapshot is its own export under `<base>/versions/<version>`: links, assets,
  // search and Markdown twins all stay inside it. It is never indexed; canonicals name the current docs.
  if (process.env['TOTALFINANCE_DOCS_SNAPSHOT'] !== '0') {
    const snapshotBase = `${base}/versions/${generated.version.version}`;
    nextBuild({
      TOTALFINANCE_DOCS_BASE_PATH: snapshotBase,
      TOTALFINANCE_DOCS_CANONICAL_BASE: base,
      TOTALFINANCE_DOCS_INDEXING: 'noindex',
      TOTALFINANCE_NEXT_DIST_DIR: '.next-snapshot',
    });
    const target = join(OUT, 'versions', generated.version.version);
    mkdirSync(join(OUT, 'versions'), { recursive: true });
    // With a custom distDir, Next writes the static export into that directory.
    renameSync(join(SITE, '.next-snapshot'), target);
    await postExport({
      out: target,
      basePath: snapshotBase,
      generated,
      snapshot: true,
      root: join(SITE, '..'),
    });
  }
  if (existsSync(join(staging, 'versions')))
    for (const version of readdirSync(join(staging, 'versions')))
      cpSync(join(staging, 'versions', version), join(OUT, 'versions', version), {
        recursive: true,
      });
  rmSync(staging, { recursive: true, force: true });
  writeFileSync(
    join(OUT, 'available-versions.json'),
    JSON.stringify({ current: generated.version.version, archived }),
  );
  // Social metadata uses the standalone domain; serve the reviewed assets at its root too.
  cpSync(join(SITE, 'brand/assets'), join(OUT, 'assets/brand'), { recursive: true });
  console.log(
    `TotalFinance site built in ${((Date.now() - started) / 1000).toFixed(1)} s: ${summary.routes} routes, ${summary.markdown} Markdown twins, ` +
      `${generated.publicReference.entries.length} export paths, ${generated.operations.length} operations, ` +
      `${Object.keys(runtime.manifest.imports).length} runnable entry points (${(runtime.bytes / 1e6).toFixed(1)} MB). Output: ${OUT}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildSite();
