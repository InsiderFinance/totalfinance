/**
 * Build the browser runtime for "Edit and run" (`site/src/runner/protocol.ts`) into
 * `public/runtime/`: ESM bundles of every browser-safe public entry point of the built package
 * (split, so a run downloads only what its imports reach), the TypeScript stripper, the sandboxed
 * runner page with its own Content-Security-Policy, and the manifest that maps import specifiers
 * to files. File names carry content hashes, so hosts can cache them forever.
 */
import { build, type BuildOptions, type Metafile } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PACKAGE_SPECIFIER, type RuntimeManifest } from '../src/runner/protocol';

/**
 * Entry points that load Node built-ins (files, processes, sockets). They stay out of the browser
 * runtime; the packed-consumer test proves the same three refuse browser bundlers.
 */
export const NODE_ONLY_SUBPATHS = ['cli', 'http', 'workflows/local'] as const;

/**
 * Origins that serve these docs, for the runner's `script-src`. The runner's origin is opaque, and
 * WebKit (following the CSP specification) then matches `'self'` against nothing, so the docs'
 * own origins are listed: the public origin, the Vercel deployment's hosts when built there,
 * loopback for the local preview when built anywhere else, and any preview hosts named in
 * `TOTALFINANCE_DOCS_PREVIEW_ORIGINS` (comma-separated, e.g. a tunnel URL).
 */
export function runnerScriptOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = new Set<string>();
  const add = (value: string | undefined, scheme = 'https://') => {
    if (!value) return;
    const url = new URL(/^https?:\/\//.test(value) ? value : `${scheme}${value}`);
    origins.add(url.origin);
  };
  add(env['TOTALFINANCE_DOCS_ORIGIN'] ?? 'https://www.totalfinance.io');
  if (env['VERCEL']) {
    add(env['VERCEL_PROJECT_PRODUCTION_URL']);
    add(env['VERCEL_BRANCH_URL']);
    add(env['VERCEL_URL']);
  } else {
    origins.add('http://127.0.0.1:*');
    origins.add('http://localhost:*');
  }
  for (const preview of (env['TOTALFINANCE_DOCS_PREVIEW_ORIGINS'] ?? '').split(','))
    add(preview.trim() || undefined);
  return [...origins];
}

/** The runner page's policy: scripts only from these docs (and the worker/module blobs), no network. */
export function runnerPolicy(origins: readonly string[] = runnerScriptOrigins()): string {
  return [
    "default-src 'none'",
    `script-src 'self' ${origins.join(' ')} blob:`,
    'worker-src blob:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export interface RuntimeBuild {
  manifest: RuntimeManifest;
  files: number;
  bytes: number;
}

const COMMON: BuildOptions = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  // Error classes keep their names (`InputError`), which readers see when a run fails.
  keepNames: true,
  legalComments: 'eof',
  write: true,
  metafile: true,
  logLevel: 'silent',
};

/** Public specifiers of the package, from its export map. */
export function publicEntryPoints(site: string): { subpath: string; specifier: string }[] {
  const pkg = JSON.parse(
    readFileSync(join(site, 'node_modules/@insiderfinance/totalfinance/package.json'), 'utf8'),
  ) as { exports: Record<string, unknown> };
  return Object.keys(pkg.exports)
    .filter((key) => key !== './package.json' && !key.endsWith('.json') && !key.includes('*'))
    .map((key) => {
      const subpath = key === '.' ? '' : key.slice(2);
      return {
        subpath,
        specifier: subpath ? `${PACKAGE_SPECIFIER}/${subpath}` : PACKAGE_SPECIFIER,
      };
    });
}

/**
 * The single output file of an esbuild entry named `name` (entry names are `<name>-<hash>`).
 * Metafile paths are relative to the build's working directory, `site`.
 */
function outputOf(metafile: Metafile, site: string, out: string, name: string): string {
  const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[A-Z0-9]+\\.js$`);
  const file = Object.keys(metafile.outputs)
    .map((path) => relative(out, join(site, path)).replaceAll('\\', '/'))
    .find((path) => pattern.test(path));
  if (!file) throw new Error(`The runtime build produced no file for ${name}.`);
  return file;
}

export async function buildRuntime(site: string): Promise<RuntimeBuild> {
  const out = join(site, 'public/runtime');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const version = (
    JSON.parse(
      readFileSync(join(site, 'node_modules/@insiderfinance/totalfinance/package.json'), 'utf8'),
    ) as { version: string }
  ).version;

  const entries = publicEntryPoints(site);
  const nodeOnly = entries.filter((entry) =>
    (NODE_ONLY_SUBPATHS as readonly string[]).includes(entry.subpath),
  );
  const browser = entries.filter((entry) => !nodeOnly.includes(entry));
  // `pkg/` keeps package entry names apart from the runner's own files.
  const name = (subpath: string) => `pkg/${subpath || 'index'}`;
  const library = await build({
    ...COMMON,
    absWorkingDir: site,
    entryPoints: Object.fromEntries(browser.map((entry) => [name(entry.subpath), entry.specifier])),
    splitting: true,
    outdir: out,
    entryNames: '[dir]/[name]-[hash]',
    chunkNames: 'pkg/chunks/[hash]',
  });
  const tools = await build({
    ...COMMON,
    absWorkingDir: site,
    entryPoints: {
      runner: join(site, 'src/runner/frame.ts'),
      worker: join(site, 'src/runner/worker.ts'),
      sucrase: join(site, 'node_modules/sucrase/dist/esm/index.js'),
    },
    splitting: true,
    outdir: out,
    entryNames: '[name]-[hash]',
    chunkNames: 'chunks/[hash]',
  });

  const manifest: RuntimeManifest = {
    version,
    imports: Object.fromEntries(
      browser.map((entry) => [
        entry.specifier,
        outputOf(library.metafile!, site, out, name(entry.subpath)),
      ]),
    ),
    transpiler: outputOf(tools.metafile!, site, out, 'sucrase'),
    worker: outputOf(tools.metafile!, site, out, 'worker'),
    nodeOnly: nodeOnly.map((entry) => entry.specifier),
  };
  const runner = outputOf(tools.metafile!, site, out, 'runner');
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // `<` is escaped so the JSON can never close its script element.
  const data = JSON.stringify(manifest).replaceAll('<', '\\u003c');
  writeFileSync(
    join(out, 'runner.html'),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${runnerPolicy()}">
<meta name="robots" content="noindex">
<title>TotalFinance example runner</title>
<script type="application/json" id="tf-runtime">${data}</script>
<script type="module" src="./${runner}"></script>
</head>
<body></body>
</html>
`,
  );
  const outputs = [
    ...Object.values(library.metafile!.outputs),
    ...Object.values(tools.metafile!.outputs),
  ];
  return {
    manifest,
    files: outputs.length + 2,
    bytes: outputs.reduce((total, output) => total + output.bytes, 0),
  };
}
