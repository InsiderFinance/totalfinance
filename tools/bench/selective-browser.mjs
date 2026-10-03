#!/usr/bin/env node
/**
 * Browser runner for the SG8 workloads (docs/specs/selective-greeks-and-exposure.md): bundles
 * `selective-workloads.mjs` against an installed `@insiderfinance/totalfinance` package root into
 * one self-contained page. Opening the page runs every workload in that browser and writes the JSON
 * report into `<pre id="report">` (and `window.__report`) — the same timings the Node runner takes,
 * minus allocation, which a page cannot observe portably.
 *
 *     node tools/bench/selective-browser.mjs /tmp/tf010/node_modules/@insiderfinance/totalfinance /tmp/bench-before
 *     node tools/bench/selective-browser.mjs distribution/totalfinance /tmp/bench-after
 *     # then open each index.html (file://) in the browser under test, or drive it headless.
 *
 * The browser is not a library dependency; the verification record names the one used.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import console from 'node:console';
import process from 'node:process';
import { build } from 'esbuild';

const [root, out] = process.argv.slice(2);
if (!root || !out) {
  console.error('usage: selective-browser.mjs <installed package root> <output directory>');
  process.exit(2);
}
const packageRoot = resolve(root);
const here = fileURLToPath(new URL('.', import.meta.url));
const entry = `
import { blackScholes } from ${JSON.stringify(join(packageRoot, 'modules/options/dist/black-scholes.js'))};
import * as batch from ${JSON.stringify(join(packageRoot, 'modules/options/dist/batch.js'))};
import * as structure from ${JSON.stringify(join(packageRoot, 'modules/structure/dist/index.js'))};
import { resolvedExpiry } from ${JSON.stringify(join(packageRoot, 'modules/core/dist/index.js'))};
import { createBench } from ${JSON.stringify(join(here, 'selective-workloads.mjs'))};
import pkg from ${JSON.stringify(join(packageRoot, 'package.json'))};

const run = () => {
  const report = createBench({ blackScholes, batch, structure, resolvedExpiry }, () => performance.now()).run();
  const result = { package: pkg.name + '@' + pkg.version, environment: { runtime: navigator.userAgent }, ...report };
  window.__report = result;
  document.getElementById('report').textContent = JSON.stringify(result, null, 2);
  document.title = 'done';
};
setTimeout(run, 0);
`;
mkdirSync(out, { recursive: true });
const bundle = await build({
  stdin: { contents: entry, resolveDir: here, loader: 'js' },
  bundle: true,
  // A classic script: browsers refuse module scripts from file:// pages.
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  write: false,
});
writeFileSync(join(out, 'bench.js'), bundle.outputFiles[0].text);
writeFileSync(
  join(out, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>running</title><pre id="report">running…</pre><script src="./bench.js"></script>\n',
);
console.log(`wrote ${join(out, 'index.html')}`);
