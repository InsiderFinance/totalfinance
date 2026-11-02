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
import {dailyRequest,page,barCapability} from './community-connector-facts.js';
import {defineDataProvider,type PriceBarRecord,type DataProvider} from '@insiderfinance/totalfinance/core/data';
import {validateDataProvider} from '@insiderfinance/totalfinance/core/data-conformance';
import {QuantError} from '@insiderfinance/totalfinance/core';
const provider:DataProvider=createFixtureDataProvider({id:'fixture',version:'0.0.0',capabilities:[barCapability],entries:[{request:dailyRequest,page:page()}]});
await validateDataProvider({provider,probes:[{name:'installed fixture',kind:'pages',request:dailyRequest,expectedPages:[page()]}],maxPages:1,maxRecords:2,timeoutMs:1000});
const result=await provider.query(dailyRequest);const rows:readonly PriceBarRecord[]=result.page.data;
if(rows.length!==0||result.page.metadata.executionEligibility!=='research-only')throw new Error('unexpected fixture facts');
try{defineDataProvider(null as never);throw new Error('missing refusal');}catch(error){if(!(error instanceof QuantError))throw error;}
console.log('INSTALLED_COMMUNITY_CONTRACT_OK');
`;
  writeFileSync(join(work, 'consumer.mts'), source);
  writeFileSync(
    join(work, 'consumer.mjs'),
    transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code,
  );
  expect(run(process.execPath, ['consumer.mjs'])).toContain('INSTALLED_COMMUNITY_CONTRACT_OK');
  const misuse = `import type {PriceBarsRequest,DataProvider} from '@insiderfinance/totalfinance/core/data';
// @ts-expect-error explicit interval/from/to/limit are required
const missing:PriceBarsRequest={kind:'price-bars',symbol:'TEST'};
declare const provider:DataProvider;
// @ts-expect-error unknown kind is not a public account-read capability
provider.query({kind:'account-read',symbol:'TEST',limit:2});
// @ts-expect-error removed source envelope
import('@insiderfinance/totalfinance/core/data').then(m=>m.defineDataProvider({provider}));
// @ts-expect-error removed query envelope
provider.query({request:{kind:'price-bars',symbol:'TEST',interval:'1d',from:'2026-10-26',to:'2026-10-28',limit:2}});
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
