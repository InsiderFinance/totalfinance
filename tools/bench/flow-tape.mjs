#!/usr/bin/env node
/**
 * Before/after evidence for flow analysis of a full session's tape: `flow()` and
 * `optionFlowDrift()` over a deterministic synthetic tape of option prints.
 *
 * Runs ONE harness against an installed `@insiderfinance/totalfinance` package root, so the same
 * workloads time a published version ("before") and this branch's assembled distribution
 * ("after"):
 *
 *     npm install --prefix /tmp/tf012 @insiderfinance/totalfinance@0.1.2
 *     node tools/bench/flow-tape.mjs /tmp/tf012/node_modules/@insiderfinance/totalfinance > before.json
 *     pnpm build
 *     node tools/bench/flow-tape.mjs distribution/totalfinance > after.json
 *
 * The tape is one regular session (09:30–16:00 ET) of SPY prints spread evenly in time, across six
 * expiries from the same day (0DTE) to three months out, with a seeded mix of calls and puts,
 * strikes, sizes, quotes and aggressor sides. Every run builds the same tape. Timing is the median
 * of 25 timed iterations after a warm-up of at least five iterations and 500 ms. Quote numbers only
 * from an idle machine, with the environment block this prints.
 */
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import console from 'node:console';
import process from 'node:process';

const root = process.argv[2];
if (!root) {
  console.error('usage: flow-tape.mjs <installed @insiderfinance/totalfinance root>');
  process.exit(2);
}
const load = (path) => import(pathToFileURL(join(root, 'modules', path)).href);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const { flow, optionFlowDrift } = await load('structure/dist/index.js');
const { resolvedExpiry } = await load('core/dist/index.js');

const WARMUP = 5;
const WARMUP_MS = 500;
// BENCH_RUNS overrides the timed-iteration count (a smoke check; recorded evidence uses the default).
const RUNS = process.env['BENCH_RUNS'] === undefined ? 25 : Number(process.env['BENCH_RUNS']);

const SESSION_DATE = '2026-06-04';
const SESSION_OPEN_MS = Date.parse(`${SESSION_DATE}T13:30:00Z`);
const SESSION_LENGTH_MS = 6.5 * 3_600_000;
const EXPIRIES = [
  '2026-06-04',
  '2026-06-05',
  '2026-06-12',
  '2026-06-19',
  '2026-07-17',
  '2026-09-18',
];
const SIDES = ['buy', 'sell', 'unknown'];

function tape(prints) {
  let seed = 12_345;
  const random = () => (seed = (seed * 1_103_515_245 + 12_345) >>> 0) / 2 ** 32;
  const cents = (value) => Math.round(value * 100) / 100;
  const resolved = Object.fromEntries(EXPIRIES.map((expiry) => [expiry, resolvedExpiry(expiry)]));
  return Array.from({ length: prints }, (_, i) => {
    const expiry = EXPIRIES[Math.floor(random() * EXPIRIES.length)];
    const price = cents(0.05 + random() * 20);
    const halfSpread = Math.max(0.01, cents(price * 0.02));
    return {
      id: `p${i}`,
      contract: {
        underlying: 'SPY',
        type: random() < 0.55 ? 'call' : 'put',
        strike: 500 + 5 * Math.floor(random() * 60),
        style: 'american',
        expiry,
        ...resolved[expiry],
        multiplier: 100,
      },
      timestampMs: SESSION_OPEN_MS + Math.floor((i / prints) * SESSION_LENGTH_MS),
      price,
      size: 1 + Math.floor(random() * 200),
      bid: cents(price - halfSpread),
      ask: cents(price + halfSpread),
      aggressorSide: SIDES[Math.floor(random() * SIDES.length)],
    };
  });
}

const tapes = { 10_000: tape(10_000), 50_000: tape(50_000) };
const workloads = [
  { id: 'flow-10k', description: 'flow() over 10,000 prints', run: () => flow(tapes[10_000]) },
  { id: 'flow-50k', description: 'flow() over 50,000 prints', run: () => flow(tapes[50_000]) },
  {
    id: 'drift-50k',
    description: 'optionFlowDrift() over 50,000 prints, one-minute buckets',
    run: () =>
      optionFlowDrift({
        trades: tapes[50_000],
        session: { date: SESSION_DATE },
        config: { bucketMinutes: 1 },
      }),
  },
];

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const results = workloads.map(({ id, description, run }) => {
  const warmStart = performance.now();
  for (let i = 0; i < WARMUP || performance.now() - warmStart < WARMUP_MS; i++) run();
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return {
    id,
    description,
    medianMs: Number(median(times).toFixed(3)),
    minMs: Number(Math.min(...times).toFixed(3)),
  };
});

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
        loadAverage1m: Number(loadavg()[0].toFixed(2)),
      },
      method: { warmup: `${WARMUP} runs and ${WARMUP_MS} ms`, runs: RUNS, statistic: 'median' },
      workloads: results,
    },
    null,
    2,
  ),
);
