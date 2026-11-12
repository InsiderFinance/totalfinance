/** Explicit local-tarball rehearsal. This command never obtains credentials or contacts a data API.
 * Usage: pnpm exec tsx tools/community-connectors-provider-smoke.ts <sdk.tgz> <provider.tgz>
 *        <provider-test-directory> <receipt.json>
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync, buildSync } from 'esbuild';
const root = fileURLToPath(new URL('..', import.meta.url));
const [sdkInput, providerInput, testsInput, receiptInput] = process.argv.slice(2);
if (!sdkInput || !providerInput || !testsInput || !receiptInput)
  throw new Error(
    'Supply SDK tarball, provider tarball, synthetic test directory and receipt path.',
  );
const sdk = resolve(sdkInput),
  provider = resolve(providerInput),
  tests = resolve(testsInput),
  receipt = resolve(receiptInput);
const work = mkdtempSync(join(tmpdir(), 'totalfinance-external-provider-'));
const commands: string[] = [];
function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
    maxBuffer: 16 * 1024 * 1024,
  });
  commands.push(`${command} ${args.join(' ')}`);
  if (result.status !== 0)
    throw new Error(
      `Consumer command failed: ${commands.at(-1)}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
try {
  cpSync(sdk, join(work, 'sdk.tgz'));
  cpSync(provider, join(work, 'provider.tgz'));
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@insiderfinance/totalfinance': 'file:./sdk.tgz',
        '@insiderfinance/totalfinance-connector-insiderfinance': 'file:./provider.tgz',
      },
    }),
  );
  run('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile']);
  run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile']);
  cpSync(join(tests, 'facts.mjs'), join(work, 'facts.mjs'));
  const source = readFileSync(join(tests, 'provider.test.mjs'), 'utf8').replace(
    /['"]\.\.\/dist\/index\.js['"]/,
    "'@insiderfinance/totalfinance-connector-insiderfinance'",
  );
  writeFileSync(join(work, 'provider.test.mjs'), source);
  const testOutput = run(process.execPath, ['--test', '--test-reporter=tap', 'provider.test.mjs']);
  const total = Number(/^# tests (\d+)$/m.exec(testOutput)?.[1]),
    passed = Number(/^# pass (\d+)$/m.exec(testOutput)?.[1]);
  if (total < 83 || passed !== total || !/^# skipped 0$/m.test(testOutput))
    throw new Error('Provider proof did not execute all synthetic checks.');
  const primary = readFileSync(join(root, 'docs/examples/community-connector-sdk.ts'), 'utf8');
  if (
    (primary.match(/^import /gm) ?? []).length !== 2 ||
    /\.map\(|closePrices\(|createTotalFinanceMcpServer/.test(primary)
  )
    throw new Error('Primary example acquired setup/projection/host ceremony.');
  writeFileSync(join(work, 'primary.mts'), primary);
  writeFileSync(
    join(work, 'primary.mjs'),
    "const apiKey='synthetic-preview-key';\n" +
      transformSync(primary, { loader: 'ts', format: 'esm', target: 'es2022' }).code,
  );
  writeFileSync(
    join(work, 'primary-check.mjs'),
    `
import assert from 'node:assert/strict';
import {primarySource,received} from './facts.mjs';
const savedFetch=globalThis.fetch,savedNow=Date.now;let calls=0,clocks=0;
globalThis.fetch=async function(url,init){calls++;assert.equal(this,globalThis);assert.equal(new URL(url).origin,'https://api-staging.insiderfinance.workers.dev');assert.equal(init.headers.Authorization,'Bearer synthetic-preview-key');return new Response(JSON.stringify(primarySource()));};
Date.now=()=>{clocks++;return received;};
try{const {prices,average}=await import('./primary.mjs');assert.deepEqual(prices.closePrices,[100,101,102]);assert.equal(average.at(-1),101.5);assert.equal(prices.page.metadata.quality.status,'partial');assert.equal(prices.page.metadata.times.observedTimestampMs,null);assert.equal(prices.page.metadata.times.availableTimestampMs,null);assert.equal(prices.page.metadata.executionEligibility,'research-only');assert.equal(calls,1);assert.equal(clocks,1);console.log('EXACT_TWO_IMPORT_KEY_ONLY_PRIMARY_OK SMA=101.5 SOURCE_RETAINED');}finally{globalThis.fetch=savedFetch;Date.now=savedNow;}
`,
  );
  const primaryOutput = run(process.execPath, ['primary-check.mjs']);
  const fixture = readFileSync(join(root, 'docs/examples/community-connector-fixture.ts'), 'utf8');
  writeFileSync(join(work, 'fixture.ts'), fixture);
  writeFileSync(
    join(work, 'fixture.js'),
    transformSync(fixture, { loader: 'ts', format: 'esm', target: 'es2022' }).code,
  );
  writeFileSync(
    join(work, 'workflow.mjs'),
    `
import assert from 'node:assert/strict';
import {createInsiderFinanceProvider} from '@insiderfinance/totalfinance-connector-insiderfinance';
import {validateDataProvider} from '@insiderfinance/totalfinance/core/data-conformance';
import {QuantError} from '@insiderfinance/totalfinance/core';
import {defineDataProvider} from '@insiderfinance/totalfinance/core/data';
import {sma} from '@insiderfinance/totalfinance/technical-analysis';
import {market} from '@insiderfinance/totalfinance/options';
import {createFixtureDataProvider} from './fixture.js';
import {daily,minute,chain,received,sourcePages,probes} from './facts.mjs';
function factory(){const counters=new Map();return createInsiderFinanceProvider('synthetic-fixture',{baseUrl:'https://synthetic.example',now:()=>received,fetch:async url=>{const u=new URL(url);const r=u.pathname.includes('options')?chain:u.searchParams.get('interval')==='1m'?minute:daily;const i=counters.get(r)||0;counters.set(r,i+1);return new Response(JSON.stringify(sourcePages(r)[i]));}});}
const http=defineDataProvider(factory());await validateDataProvider({provider:http,probes:probes(),maxPages:4,maxRecords:20,timeoutMs:1000});
function rawPage(p){const m=p.metadata;const facts={dataset:{id:m.datasetId,version:m.datasetVersion},receivedTimestampMs:m.receivedTimestampMs,adjustment:m.adjustment,consistency:m.consistency,snapshotId:m.snapshotId,sessionDate:m.sessionDate,sourceGeneratedTimestampMs:m.sourceGeneratedTimestampMs,times:m.times,freshness:m.freshness,coverage:m.coverage,quality:m.quality,access:m.access,requestId:p.provenance.requestId};return p.kind==='price-bars'?{data:p.data.map(r=>{const {symbol,...bar}=r.bar;return {bar,sessionDate:r.sessionDate,times:r.times,source:r.source,provisional:r.provisional,revision:r.revision,diagnostics:r.diagnostics}}),nextCursor:p.nextCursor,facts:{...facts,timestampConvention:p.timestampConvention},diagnostics:p.diagnostics}:{data:p.data,nextCursor:p.nextCursor,facts,diagnostics:p.diagnostics};}
const entries=probes().flatMap(p=>p.expectedPages.map((page,i)=>({query:p.request,cursor:i?p.expectedPages[i-1].nextCursor:null,page:rawPage(page)})));
const fixture=defineDataProvider(createFixtureDataProvider({id:'insiderfinance',version:'0.0.0',capabilities:(await http.capabilities()).capabilities,entries}));
await validateDataProvider({provider:fixture,probes:probes(),maxPages:4,maxRecords:20,timeoutMs:1000});
const query=r=>{const {limit,...q}=r;return q};
async function research(p){const bars=await p.query(query(daily),{limit:2});const chainPage=await p.query(query(chain),{limit:2});const last=sma(bars.closePrices,{period:2}).at(-1);assert.equal(last,101.5);const row=chainPage.page.data[0];assert.throws(()=>market({spot:row.quote.underlyingPrice,volatility:row.quote.impliedVolatility,asOf:row.times.observedTimestampMs}),QuantError);return {average:last,terms:row.terms,observed:row.times.observedTimestampMs,availability:row.times.availableTimestampMs,eligibility:chainPage.page.metadata.executionEligibility};}
assert.deepEqual(await research(fixture),await research(defineDataProvider(factory())));
console.log('INSTALLED_EXTERNAL_AND_PUBLIC_FIXTURE_PARITY_OK average=101.5 missing_market_refused=true');
`,
  );
  const workflow = run(process.execPath, ['workflow.mjs']);
  writeFileSync(
    join(work, 'consumer.mts'),
    `
import {createInsiderFinanceProvider} from '@insiderfinance/totalfinance-connector-insiderfinance';
import {defineDataProvider,type DataProvider,type PriceBarRecord} from '@insiderfinance/totalfinance/core/data';
const provider:DataProvider=defineDataProvider(createInsiderFinanceProvider('synthetic',{baseUrl:'https://synthetic.example',fetch,now:()=>123}));
const page=await provider.query({kind:'price-bars',symbol:'TEST',interval:'1d',from:'2026-10-26',to:'2026-10-28'},{limit:2});
const rows:readonly PriceBarRecord[]=page.page.data;void rows;
const values:readonly number[]=page.closePrices; void values;
import {sma} from '@insiderfinance/totalfinance/technical-analysis';
sma(page.closePrices,{period:2});
const chain=await provider.query({kind:'option-chain-research',symbol:'TEST',snapshot:{kind:'latest'}},{limit:2});
// @ts-expect-error chain research is not a closing-price series
chain.closePrices;
import type {DataQuery} from '@insiderfinance/totalfinance/core/data';
async function generic<R extends DataQuery>(request:R){return provider.query(request,{limit:2});}
const narrowed=await generic({kind:'price-bars',symbol:'TEST',interval:'1d',from:'2026-10-26',to:'2026-10-28'});
sma(narrowed.closePrices,{period:2});
async function fromUnion(request:DataQuery){const view=await provider.query(request,{limit:2});if(view.kind==='price-bars')sma(view.closePrices,{period:2});else view.page.data[0]?.terms;}
void fromUnion;
// @ts-expect-error removed factory envelope
createInsiderFinanceProvider({apiKey:'synthetic'});
// @ts-expect-error removed query envelope
provider.query({request:{kind:'price-bars',symbol:'TEST',interval:'1d',from:'2026-10-26',to:'2026-10-28',limit:2}});
// @ts-expect-error readonly consumer arrays
page.closePrices.push(0);
// @ts-expect-error data configuration cannot grant execution
provider.query({kind:'place-order',symbol:'TEST',limit:2});
`,
  );
  for (const [module, resolution] of [
    ['NodeNext', 'NodeNext'],
    ['ESNext', 'Bundler'],
  ])
    run(join(root, 'node_modules/.bin/tsc'), [
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--lib',
      'ES2022,DOM',
      '--module',
      module!,
      '--moduleResolution',
      resolution!,
      'consumer.mts',
      'primary.mts',
    ]);
  const browser = buildSync({
    stdin: {
      contents:
        "export {blackScholesPrice} from '@insiderfinance/totalfinance/options/black-scholes'",
      resolveDir: work,
      loader: 'js',
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  if (
    Object.keys(browser.metafile!.inputs).some(
      (path) =>
        path.includes('connector-insiderfinance') ||
        path.endsWith('/data.js') ||
        path.endsWith('/data-conformance.js'),
    )
  )
    throw new Error('Provider or data machinery entered ordinary browser compute.');
  cpSync(
    realpathSync(join(work, 'node_modules/@insiderfinance/totalfinance')),
    join(work, 'foreign-sdk'),
    { recursive: true },
  );
  writeFileSync(
    join(work, 'cross-copy.mjs'),
    `
import assert from 'node:assert/strict';
import {defineDataProvider} from '@insiderfinance/totalfinance/core/data';
import {validateDataProvider} from '@insiderfinance/totalfinance/core/data-conformance';
import {defineDataProvider as foreignDefine} from './foreign-sdk/modules/core/dist/data.js';
import {InputError as ForeignInputError} from './foreign-sdk/modules/core/dist/errors.js';
import {InputError} from '@insiderfinance/totalfinance/core';
import {DataError} from '@insiderfinance/totalfinance/core';
import {DataError as ForeignDataError} from './foreign-sdk/modules/core/dist/errors.js';
import {DataProviderError as ForeignProviderError} from './foreign-sdk/modules/core/dist/data.js';
assert.notEqual(ForeignDataError,DataError);
const q={kind:'price-bars',symbol:'TEST',interval:'1d',from:'2026-10-26',to:'2026-10-28'};
for(const foreign of [new ForeignDataError('secret URL payload',{code:'data.rate_limited',context:{retryable:true,retryAfterMs:1234,status:429,url:'secret'}}),new ForeignProviderError({code:'data.rate_limited',retryAfterMs:1234,status:429})]){
 const p=defineDataProvider({protocol:'totalfinance-data-source',contractVersion:2,id:'foreign-author',version:'1',async capabilities(){return []},async query(){throw foreign}});
 await assert.rejects(p.query(q,{limit:1}),e=>{assert.ok(e instanceof DataError);assert.ok(!(e instanceof ForeignDataError));assert.equal(e.code,'data.rate_limited');assert.equal(e.context.retryAfterMs,1234);assert.equal(e.context.status,429);assert.ok(!/secret|URL|payload|cause|url/.test(JSON.stringify(e)));assert.equal(e.cause,foreign);return true});
}

assert.notEqual(InputError,ForeignInputError);
for(const code of ['input.wrong_type','input.missing_field','input.not_finite','input.out_of_range','input.invalid_enum'])for(const C of [InputError,ForeignInputError]){
 const cause=new C('SECRET provider URL',{code,context:{url:'SECRET'}});
 const p=defineDataProvider({protocol:'totalfinance-data-source',contractVersion:2,id:'inputs',version:'1',async capabilities(){return []},async query(){throw cause}});
 await assert.rejects(p.query(q,{limit:1}),e=>{assert.ok(e instanceof InputError);assert.equal(e.code,code);assert.equal(e.cause,cause);assert.ok(!/SECRET|url|URL/.test(JSON.stringify(e)));return true});
}
const original={timestampMs:Date.parse('2026-10-26T04:00:00Z'),open:100,high:102,low:99,close:101,volume:10,adjusted:true,vwap:0};
const facts={dataset:{id:'independent',version:'1'},receivedTimestampMs:1793404800000,adjustment:'split',consistency:'best-effort',timestampConvention:'session-start'};
const times={observedTimestampMs:null,availableTimestampMs:null,sourceStoredTimestampMs:null};
let copyControls=0;
for(const bind of [defineDataProvider,foreignDefine])for(const variant of ['normal','missing-volume','suspect']){
 const bar={...original};if(variant==='missing-volume')delete bar.volume;if(variant==='suspect')bar.high=100;
 let calls=0;let notify;const ready=new Promise(r=>notify=r);
 const raw={protocol:'totalfinance-data-source',contractVersion:2,id:'example',version:'1',async capabilities(){return [{kind:'price-bars',intervals:['1d'],maxPageSize:10000,consistency:['best-effort'],pointInTime:false,access:'unknown'}]},async query(_q,page){if(++calls>1){notify();return new Promise(()=>{})}return {data:[{bar,sessionDate:'2026-10-26'}],nextCursor:null,facts}}};
 const p=bind(raw),record={bar:{...bar,symbol:'TEST'},sessionDate:'2026-10-26',timestampConvention:'session-start',times,source:null,provisional:null,revision:null,diagnostics:{warnings:[]}};
 await validateDataProvider({provider:p,probes:[{name:'independent',kind:'records',request:q,pageSize:1,expectedRecords:[record],expectedFacts:[{datasetId:'independent',datasetVersion:'1',adjustment:'split',consistency:'best-effort'}]},{name:'unsupported',kind:'error',request:{...q,interval:'2h'},pageSize:1,expectedCode:'data.unsupported_capability'},{name:'abort',kind:'abort',request:q,pageSize:1,waitUntilStarted:()=>ready}],maxPages:2,maxRecords:2,timeoutMs:1000});
 copyControls++;
}
assert.equal(copyControls,6);
console.log('TWO_COPY_KIT_INPUT_ABORT_SELECTORS_OK controls='+copyControls);

console.log('REAL_SEPARATE_SDK_ERROR_COPY_OK');
`,
  );
  const crossCopy = run(process.execPath, ['cross-copy.mjs']);
  const installed = join(
    work,
    'node_modules/@insiderfinance/totalfinance-connector-insiderfinance',
  );
  for (const name of readdirSync(join(installed, 'dist')).filter((n) => /\.(js|ts|map)$/.test(n))) {
    const text = readFileSync(join(installed, 'dist', name), 'utf8');
    if (
      text.includes('workspace:') ||
      text.includes('@totalfinance/') ||
      text.includes('/Users/agent/') ||
      text.includes('insiderfinance-app')
    )
      throw new Error('Private path or alias in installed provider.');
  }
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(
    receipt,
    JSON.stringify(
      {
        node: process.version,
        sdkTarball: sdk,
        sdkSha256: hash(sdk),
        providerTarball: provider,
        providerSha256: hash(provider),
        providerTests: total,
        passed,
        skipped: 0,
        workflow: workflow.trim(),
        primaryExample: primaryOutput.trim(),
        typescript: ['NodeNext', 'Bundler'],
        ordinaryBrowserComputeProviderFree: true,
        commands,
        syntheticOnly: true,
        crossCopy: crossCopy.trim(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify({
      providerTests: total,
      passed,
      workflow: workflow.trim(),
      primary: primaryOutput.trim(),
      receipt,
    }),
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
