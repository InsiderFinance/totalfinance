/** SDK-owned installed fixture proof; external provider installation is independently rehearsed. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, it, expect } from 'vitest';
import { transformSync } from 'esbuild';
const root = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'totalfinance-community-consumer-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
function run(command: string, args: string[], cwd = work): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
    maxBuffer: 16 * 1024 * 1024,
  });
  expect(result.status, `${command} ${args.join(' ')}\n${result.stderr}\n${result.stdout}`).toBe(0);
  return result.stdout;
}
it('fresh SDK pack installs, exposes opt-in contracts, and runs the public fixture and kit', () => {
  run('pnpm', ['pack', '--pack-destination', work], join(root, 'distribution/totalfinance'));
  const version = JSON.parse(
    readFileSync(join(root, 'distribution/totalfinance/package.json'), 'utf8'),
  ).version as string;
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@insiderfinance/totalfinance': `file:./insiderfinance-totalfinance-${version}.tgz`,
      },
    }),
  );
  run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile']);
  run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile']);
  for (const name of ['community-connector-fixture', 'community-connector-facts']) {
    cpSync(join(root, `docs/examples/${name}.ts`), join(work, `${name}.ts`));
    writeFileSync(
      join(work, `${name}.js`),
      transformSync(readFileSync(join(work, `${name}.ts`), 'utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'es2022',
      }).code,
    );
  }
  const source = `
import {createFixtureDataProvider} from './community-connector-fixture.js';
import {defineDataProvider,createDataView,type DataProviderSource,type DataQuery,type DataPageOptions,type SourcePriceBarsPage,type PriceBarRecord,type DataProvider,type DataViewFor} from '@insiderfinance/totalfinance/core/data';
import {validateDataProvider} from '@insiderfinance/totalfinance/core/data-conformance';
import {QuantError} from '@insiderfinance/totalfinance/core';
import { data, technicalAnalysis,backtest } from '@insiderfinance/totalfinance';
const query={kind:'price-bars' as const,symbol:'TEST',interval:'1d' as const,from:'2026-10-26',to:'2026-10-28'};
// Natural one-capability author, no conditional return assertion or generic envelope duplication.
function author():DataProviderSource{return {protocol:'totalfinance-data-source',contractVersion:2,id:'independent',version:'1',
 async capabilities(){return [{kind:'price-bars',intervals:['1d','1s'],maxPageSize:10000,consistency:['best-effort'],pointInTime:false,access:'unknown'}]},
 async query(q:DataQuery,p:DataPageOptions):Promise<SourcePriceBarsPage>{
  if(q.kind!=='price-bars')throw Error('unsupported synthetic source');
  return {data:[{bar:{timestampMs:1792972800000,open:100,high:102,low:99,close:101,volume:1,adjusted:true,vwap:0},sessionDate:'2026-10-26'}],nextCursor:null,facts:{dataset:{id:'literal-bars',version:'1'},receivedTimestampMs:1793203200000,adjustment:'split',consistency:'best-effort',timestampConvention:'session-label-midnight-utc'}};
 }}};
const source=author(),provider:DataProvider=defineDataProvider(source);
const result=await provider.query(query,{limit:2});const rows:readonly PriceBarRecord[]=result.page.data;const values:readonly number[]=result.closePrices;
if(values[0]!==101||rows.length!==1||result.page.metadata.executionEligibility!=='research-only')throw Error('unexpected source facts');
const expectedRecords=[{bar:{symbol:'TEST',timestampMs:1792972800000,open:100,high:102,low:99,close:101,volume:1,adjusted:true,vwap:0},sessionDate:'2026-10-26',timestampConvention:'session-label-midnight-utc' as const,times:{observedTimestampMs:null,availableTimestampMs:null,sourceStoredTimestampMs:null},source:null,provisional:null,revision:null,diagnostics:{warnings:[]}}];
await validateDataProvider({provider,probes:[{name:'literal independently authored rows',kind:'records',request:query,pageSize:2,expectedRecords,expectedFacts:[{datasetId:'literal-bars',datasetVersion:'1',adjustment:'split',consistency:'best-effort'}]}],maxPages:2,maxRecords:3,timeoutMs:1000});
const prices=await data.connect(source).priceBars({symbol:'TEST',interval:'1d',from:query.from,to:query.to});
const mutableOwnership=[...prices.bars];const engineInput:Parameters<typeof backtest.vectorized>[0]={data:mutableOwnership,signal:[true],initialCapital:1000};void engineInput;
technicalAnalysis.resample(prices.bars,86400000,{includePartial:true});
if(data.createPriceBarsWindowView(JSON.parse(JSON.stringify(prices.window))).closePrices[0]!==101)throw Error('restore');
if(createDataView(JSON.parse(JSON.stringify(result.page))).kind!=='price-bars')throw Error('page restore');
const restored=createDataView(result.page);if(restored.kind==='price-bars')technicalAnalysis.sma(restored.closePrices,{period:1});
// Public fixture/source binding is interchangeable without returning consumer views from authors.
const syntheticPage=await source.query(query,{limit:2,cursor:null,pins:null});
const fixture=createFixtureDataProvider({id:'independent',version:'1',capabilities:await source.capabilities(),entries:[{query,cursor:null,page:syntheticPage}]});
if((await data.connect(fixture).priceBars({symbol:'TEST',interval:'1d',from:query.from,to:query.to})).closePrices[0]!==101)throw Error('fixture');
try{defineDataProvider(null as never);throw Error('missing refusal')}catch(error){if(!(error instanceof QuantError))throw error}
console.log('INSTALLED_COMMUNITY_CONTRACT_OK');
`;
  writeFileSync(join(work, 'consumer.mts'), source);
  writeFileSync(
    join(work, 'consumer.mjs'),
    transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code,
  );
  expect(run(process.execPath, ['consumer.mjs'])).toContain('INSTALLED_COMMUNITY_CONTRACT_OK');
  const misuse = `import type {PriceBarsQuery,DataProvider} from '@insiderfinance/totalfinance/core/data';
// @ts-expect-error explicit interval/from/to/limit are required
const missing:PriceBarsQuery={kind:'price-bars',symbol:'TEST'};
declare const provider:DataProvider;
// @ts-expect-error unknown kind is not a public account-read capability
provider.query({kind:'account-read',symbol:'TEST',limit:2});
// @ts-expect-error removed source envelope
import('@insiderfinance/totalfinance/core/data').then(m=>m.defineDataProvider({provider}));
// @ts-expect-error removed query envelope
provider.query({request:{kind:'price-bars',symbol:'TEST',interval:'1d',from:'2026-10-26',to:'2026-10-28',limit:2}});
declare const connected:import('@insiderfinance/totalfinance/data').ConnectedData;
// @ts-expect-error high-level financial request has no limit
connected.priceBars({symbol:'TEST',interval:'1d',from:'2026-10-26',to:'2026-10-28',limit:2});
const window=await connected.priceBars({symbol:'TEST',interval:'1d',from:'2026-10-26',to:'2026-10-28'});
// @ts-expect-error readonly native array
window.closePrices.push(1);
void missing;
`;
  writeFileSync(join(work, 'misuse.mts'), misuse);
  for (const [module, resolution] of [
    ['NodeNext', 'NodeNext'],
    ['ESNext', 'Bundler'],
  ])
    run(join(root, 'node_modules/.bin/tsc'), [
      '--strict',
      '--skipLibCheck',
      '--noEmit',
      '--target',
      'ES2022',
      '--lib',
      'ES2022,DOM',
      '--module',
      module!,
      '--moduleResolution',
      resolution!,
      'consumer.mts',
      'misuse.mts',
    ]);
  const installed = readFileSync(
    join(work, 'node_modules/@insiderfinance/totalfinance/package.json'),
    'utf8',
  );
  expect(installed).not.toContain('workspace:');
  expect(installed).not.toContain(root);
}, 60000);
