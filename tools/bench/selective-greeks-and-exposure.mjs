#!/usr/bin/env node
/**
 * Before/after evidence for docs/specs/selective-greeks-and-exposure.md (SG8).
 *
 * Runs ONE harness against an installed `@insiderfinance/totalfinance` package root, so the same
 * workloads time the published 0.1.0 ("before") and this branch's assembled distribution ("after"):
 *
 *     npm install --prefix /tmp/tf010 @insiderfinance/totalfinance@0.1.0
 *     node --expose-gc --max-semi-space-size=256 tools/bench/selective-greeks-and-exposure.mjs \
 *       /tmp/tf010/node_modules/@insiderfinance/totalfinance > before.json
 *     pnpm build
 *     node --expose-gc --max-semi-space-size=256 tools/bench/selective-greeks-and-exposure.mjs \
 *       distribution/totalfinance > after.json
 *
 * A workload whose API does not exist in the measured version reports `null` (before has no
 * selective APIs, so its gamma-only paths are what a 0.1.0 consumer had to do instead: the full
 * Greeks call or batch). Timing is the median of 25 timed iterations after a warm-up of at least
 * five iterations and 500 ms. Allocation is the mean heap growth of five steady-state iterations
 * after a forced GC, with a 256 MB semi-space so they do not trigger a scavenge — an estimate of
 * bytes allocated per call, not retained.
 *
 * Allocation is recorded from one process per workload (`BENCH_ONLY=<id>`), because a long run's
 * earlier workloads change what the optimizer has done by the time later ones are measured.
 *
 * The workloads live in `selective-workloads.mjs`, shared with the browser runner
 * (`selective-browser.mjs`), so Node and browser numbers time identical code.
 */
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { createBench } from './selective-workloads.mjs';

const root = process.argv[2];
if (!root) {
  console.error(
    'usage: selective-greeks-and-exposure.mjs <installed @insiderfinance/totalfinance root>',
  );
  process.exit(2);
}
const load = (path) => import(pathToFileURL(join(root, 'modules', path)).href);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { blackScholes } = await load('options/dist/black-scholes.js');
const batch = await load('options/dist/batch.js');
const structure = await load('structure/dist/index.js');
const { resolvedExpiry } = await load('core/dist/index.js');

// BENCH_RUNS overrides the timed-iteration count (a smoke check; recorded evidence uses the default).
const report = createBench(
  { blackScholes, batch, structure, resolvedExpiry },
  () => performance.now(),
  process.env['BENCH_RUNS'] === undefined ? undefined : Number(process.env['BENCH_RUNS']),
).run(
  () => process.memoryUsage().heapUsed,
  // BENCH_ONLY=id,id runs a subset — one workload per process isolates its allocation from the
  // optimization state earlier workloads leave behind.
  process.env['BENCH_ONLY']?.split(','),
);
console.log(
  JSON.stringify(
    {
      package: `${pkg.name}@${pkg.version}`,
      environment: {
        runtime: `node ${process.version}`,
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        cores: cpus().length,
        memoryGB: Math.round(totalmem() / 2 ** 30),
        gcExposed: typeof globalThis.gc === 'function',
        execArgv: process.execArgv,
      },
      ...report,
    },
    null,
    2,
  ),
);
