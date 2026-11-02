/** Explicit local-tarball rehearsal. This command never obtains credentials or contacts a data API.
 * Usage: pnpm exec tsx tools/community-connectors-provider-smoke.ts <sdk.tgz> <provider.tgz>
 *        <provider-test-directory> <receipt.json>
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync } from 'node:fs';
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
  if (total < 40 || passed !== total || !/^# skipped 0$/m.test(testOutput))
    throw new Error('Provider proof did not execute all synthetic checks.');
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
import {sma} from '@insiderfinance/totalfinance/technical-analysis';
import {market} from '@insiderfinance/totalfinance/options';
import {createFixtureDataProvider} from './fixture.js';
import {daily,minute,chain,received,sourcePages,probes} from './facts.mjs';
function factory(){const counters=new Map();return createInsiderFinanceProvider({baseUrl:'https://synthetic.example',apiKey:'synthetic-fixture',now:()=>received,fetch:async url=>{const u=new URL(url);const r=u.pathname.includes('options')?chain:u.searchParams.get('interval')==='1m'?minute:daily;const i=counters.get(r)||0;counters.set(r,i+1);return new Response(JSON.stringify(sourcePages(r)[i]));}});}
const http=factory();await validateDataProvider({provider:http,probes:probes(),maxPages:4,maxRecords:20,timeoutMs:1000});
const entries=probes().flatMap(p=>[{request:p.request,page:p.expectedPages[0]},{request:{kind:p.request.kind,symbol:p.request.symbol,cursor:p.expectedPages[0].nextCursor,limit:2},page:p.expectedPages[1]}]);
const fixture=createFixtureDataProvider({id:'insiderfinance',version:'0.0.0',capabilities:(await http.capabilities({})).capabilities,entries});
await validateDataProvider({provider:fixture,probes:probes(),maxPages:4,maxRecords:20,timeoutMs:1000});
async function research(p){const bars=await p.query({request:daily});const chainPage=await p.query({request:chain});const last=sma(bars.data.map(row=>row.bar.close),{period:2}).at(-1);assert.equal(last,101.5);const row=chainPage.data[0];assert.throws(()=>market({spot:row.quote.underlyingPrice,volatility:row.quote.impliedVolatility,asOf:row.times.observedTimestampMs}),QuantError);return {average:last,terms:row.terms,observed:row.times.observedTimestampMs,availability:row.times.availableTimestampMs,eligibility:chainPage.metadata.executionEligibility};}
assert.deepEqual(await research(fixture),await research(factory()));
console.log('INSTALLED_EXTERNAL_AND_PUBLIC_FIXTURE_PARITY_OK average=101.5 missing_market_refused=true');
`,
  );
  const workflow = run(process.execPath, ['workflow.mjs']);
  writeFileSync(
    join(work, 'consumer.mts'),
    `
import {createInsiderFinanceProvider} from '@insiderfinance/totalfinance-connector-insiderfinance';
import type {DataProvider,PriceBarRecord} from '@insiderfinance/totalfinance/core/data';
const provider:DataProvider=createInsiderFinanceProvider({baseUrl:'https://synthetic.example',apiKey:'synthetic',fetch,now:()=>123});
const page=await provider.query({request:{kind:'price-bars',symbol:'TEST',interval:'1d',from:'2026-10-26',to:'2026-10-28',limit:2}});
const rows:readonly PriceBarRecord[]=page.data;void rows;
// @ts-expect-error data configuration cannot grant execution
provider.query({request:{kind:'place-order',symbol:'TEST',limit:2}});
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
        typescript: ['NodeNext', 'Bundler'],
        ordinaryBrowserComputeProviderFree: true,
        commands,
        syntheticOnly: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ providerTests: total, passed, workflow: workflow.trim(), receipt }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
