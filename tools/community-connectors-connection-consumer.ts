/** C3 budget-review rehearsal: fresh local packs, exact root example, independent synthetic HTTP facts. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { transform } from 'esbuild';
import { measureConsumer } from './bundle-size/consumer-measure.js';
import type { ConsumerFixture } from './bundle-size/consumer-fixtures.js';

const [sdk, provider, receipt] = process.argv.slice(2);
if (!sdk || !provider || !receipt) throw Error('SDK/provider tarballs and receipt path required');
const consumer = mkdtempSync(join(tmpdir(), 'totalfinance-c3-review-'));
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
function run(command: string, args: string[], cwd = consumer, extra: Record<string, string> = {}) {
  const p = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH']!, HOME: process.env['HOME']!, ...extra },
  });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  return p.stdout.trim();
}
run('npm', [
  'install',
  '--ignore-scripts',
  '--offline',
  '--no-audit',
  '--no-fund',
  resolve(sdk),
  resolve(provider),
]);
const primary = readFileSync(
  new URL('../docs/examples/community-connector-connection.ts', import.meta.url),
  'utf8',
);
assert.equal((primary.match(/^import /gm) ?? []).length, 2);
writeFileSync(
  join(consumer, 'primary.mjs'),
  (await transform(primary, { loader: 'ts', format: 'esm', target: 'es2022' })).code,
);
// Independently authored financial facts: 30 closes100..129; final20 arithmetic mean119.5.
const rows = Array.from({ length: 30 }, (_, i) => ({
  sessionDate: `2026-09-${String(i + 1).padStart(2, '0')}`,
  open: 100 + i,
  high: 101 + i,
  low: 99 + i,
  close: 100 + i,
  volume: i + 1,
}));
const meta = {
  symbol: 'SPY',
  requestId: 'synthetic-c3',
  generatedAt: '2026-10-29T12:00:00Z',
  dataset: { id: 'equityBarsDaily', version: '1' },
  interval: '1d',
  adjustment: { splits: true, dividends: false },
  coverage: { start: '2026-09-01', end: '2026-09-30' },
  freshness: { status: 'endOfDay', configuredDelaySeconds: 0 },
  quality: { status: 'partial', issues: [] },
};
const primaryRuns = [];
for (const size of [30, 10]) {
  const pages = [];
  for (let i = 0; i < rows.length; i += size)
    pages.push({
      data: rows.slice(i, i + size),
      meta,
      ...(i + size < rows.length ? { pagination: { nextFrom: rows[i + size]!.sessionDate } } : {}),
    });
  writeFileSync(
    join(consumer, 'preload.mjs'),
    `const pages=${JSON.stringify(pages)};let calls=0;globalThis.fetch=async(url,init)=>{if(new URL(url).origin!=='https://api-staging.insiderfinance.workers.dev')throw Error('wrong preview origin');if(!init.headers.Authorization.includes('synthetic-c3-key'))throw Error('wrong synthetic auth');const p=pages[calls++];if(!p)throw Error('extra request');return new Response(JSON.stringify(p),{headers:{'content-type':'application/json'}})};process.on('exit',()=>{if(calls!==${pages.length})throw Error('incorrect call count')});`,
  );
  const output = run(process.execPath, ['--import', './preload.mjs', './primary.mjs'], consumer, {
    INSIDERFINANCE_API_KEY: 'synthetic-c3-key',
  });
  assert.equal(output, '119.5');
  primaryRuns.push({ pages: pages.length, output });
}
writeFileSync(join(consumer, 'primary.mts'), primary);
writeFileSync(
  join(consumer, 'types.mts'),
  `
import { data, type PriceBarsWindowRequest, type DataProvider } from '@insiderfinance/totalfinance';
import { connect, createPriceBarsWindowView } from '@insiderfinance/totalfinance/data';
import { sma, vwap } from '@insiderfinance/totalfinance/technical-analysis';
declare const provider:DataProvider;
const request:PriceBarsWindowRequest={symbol:'SPY',interval:'1d',from:'2026-09-01',to:'2026-10-28'};
const connected=connect(provider);
const result=await data.connect(provider).priceBars(request);
sma(result.closePrices,{period:20});vwap(result.ohlcvBars);
createPriceBarsWindowView(result.window);
// @ts-expect-error immutable array
result.closePrices.push(1);
// @ts-expect-error no page limit in the financial window request
connected.priceBars({...request,limit:100});
// @ts-expect-error explicit interval remains required
connected.priceBars({symbol:'SPY',from:request.from,to:request.to});
// @ts-expect-error no per-indicator provider client
connected.sma({period:20});
const sample=await connected.query({...request,kind:'price-bars',limit:100});
sma(sample.closePrices,{period:20});
`,
);
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const typeRoots = fileURLToPath(new URL('../node_modules/@types', import.meta.url));
for (const [module, resolution] of [
  ['NodeNext', 'NodeNext'],
  ['ESNext', 'Bundler'],
])
  run(process.execPath, [
    compiler,
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--target',
    'ES2022',
    '--lib',
    'ES2022,DOM',
    '--typeRoots',
    typeRoots,
    '--module',
    module!,
    '--moduleResolution',
    resolution!,
    'primary.mts',
    'types.mts',
  ]);
assert.equal(
  run(process.execPath, [
    '--input-type=module',
    '-e',
    "import * as root from '@insiderfinance/totalfinance'; import {connect} from '@insiderfinance/totalfinance/data'; if(root.data.connect!==connect || 'connect' in root) throw Error('namespace/export identity'); console.log('namespace_ok');",
  ]),
  'namespace_ok',
);
const measurements = [];
for (const [id, source] of [
  [
    'data-named',
    "import { connect } from '@insiderfinance/totalfinance/data'; globalThis.consumerConnect = connect;",
  ],
  [
    'data-root',
    "import { data } from '@insiderfinance/totalfinance'; globalThis.consumerConnect = data.connect;",
  ],
  [
    'data-restore',
    "import { createPriceBarsWindowView } from '@insiderfinance/totalfinance/data'; globalThis.consumerRestore = createPriceBarsWindowView;",
  ],
] as const)
  for (const bundler of ['esbuild', 'rollup'] as const) {
    const fixture: ConsumerFixture = {
      id,
      source,
      canary: 'normal',
      specifier: '@insiderfinance/totalfinance/data',
      style: id,
      budgetKiB: { esbuild: 0, rollup: 0 },
      reason: 'Measurement only: no threshold is approved or asserted.',
    };
    const a = await measureConsumer(consumer, fixture, bundler),
      b = await measureConsumer(consumer, fixture, bundler);
    assert.deepEqual(a, b);
    for (const module of a.retainedModules) {
      assert.match(
        module.id,
        /\/modules\/(core|totalfinance)\//,
        'Acquisition retained an unrelated domain',
      );
      assert.doesNotMatch(module.id, /data-conformance/, 'Conformance runner entered runtime');
    }
    measurements.push({ ...a, code: undefined });
  }
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const result = {
  node: process.version,
  consumer,
  sdk: { path: resolve(sdk), sha256: sha(sdk) },
  provider: { path: resolve(provider), sha256: sha(provider) },
  primaryRuns,
  typescript: ['NodeNext', 'Bundler'],
  namespaceIdentity: true,
  measurements,
};
writeFileSync(receipt, JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      ...result,
      measurements: measurements.map(({ fixture, bundler, bytesMin, bytesGzip }) => ({
        fixture,
        bundler,
        bytesMin,
        bytesGzip,
      })),
    },
    null,
    2,
  ),
);
