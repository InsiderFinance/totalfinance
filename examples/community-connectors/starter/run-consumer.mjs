import process from 'node:process';
import console from 'node:console';
/** Install actual packs in a clean project; intentionally break and repair exactly one mapping. */
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  cpSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const here = dirname(fileURLToPath(import.meta.url)),
  artifacts = resolve(process.argv[2] ?? '.local-connector-artifacts');
const sdk = join(artifacts, 'insiderfinance-totalfinance-0.1.3.tgz');
const rootPackages = JSON.parse(
  execFileSync('pnpm', ['-r', 'list', '--depth', '-1', '--json'], {
    cwd: resolve(here, '../../..'),
    encoding: 'utf8',
  }),
);
assert.ok(
  !rootPackages.some((p) => p.name === '@totalfinance-example/cents-connector'),
  'Starter must remain outside root workspace',
);
const starterSdk = realpathSync(join(here, 'node_modules/@insiderfinance/totalfinance'));
assert.ok(
  starterSdk.startsWith(join(realpathSync(here), 'node_modules/')),
  'Starter SDK must resolve its own file install, never a source workspace',
);
assert.ok(readFileSync(join(here, 'pnpm-lock.yaml'), 'utf8').includes('file:sdk.tgz'));

const provider = join(
  artifacts,
  readdirSync(artifacts).find((n) => n.includes('cents-connector') && n.endsWith('.tgz')) ??
    'missing-provider',
);
const work = mkdtempSync(join(tmpdir(), 'totalfinance-starter-consumer-'));
writeFileSync(
  join(work, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: {
      '@insiderfinance/totalfinance': `file:${sdk}`,
      '@totalfinance-example/cents-connector': `file:${provider}`,
    },
  }),
);
const run = (command, args, cwd = work) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 8 * 1024 * 1024,
  });
run('pnpm', ['install', '--ignore-scripts']);
run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']);
assert.ok(
  realpathSync(join(work, 'node_modules/@insiderfinance/totalfinance')).startsWith(
    join(realpathSync(work), 'node_modules/'),
  ),
);
const consumerLock = readFileSync(join(work, 'pnpm-lock.yaml'), 'utf8');
assert.ok(
  consumerLock.includes('insiderfinance-totalfinance-0.1.3.tgz') &&
    !consumerLock.includes('workspace:'),
);

const facts = readFileSync(join(here, 'test.mjs'), 'utf8')
  .split("test('independently")[0]
  .replace("from './dist/index.js'", "from '@totalfinance-example/cents-connector'");
writeFileSync(
  join(work, 'consumer.mjs'),
  facts +
    `
const prices=await data.connect(createStarterProvider(rows,receipt)).priceBars(request);
console.log(JSON.stringify({sma:technicalAnalysis.sma(prices.closePrices,{period:2}).at(-1),vwap:technicalAnalysis.vwap(prices.ohlcvBars).at(-1),source:prices.window.pages.map(p=>({provenance:p.provenance,warnings:p.diagnostics.warnings}))}));
const last=technicalAnalysis.sma(prices.closePrices,{period:20}).at(-1);
if(last===undefined||!Number.isFinite(last))console.log('Insufficient history for SMA(20): 3 observed rows; no additional read.');
`,
);
const output = run(process.execPath, ['consumer.mjs']);
assert.match(output, /"sma":103/);
assert.match(output, /"vwap":102/);
assert.match(output, /coverage_unverified/);
console.log(output.trim());
// Build a separate copied author package. The installed successful provider stays untouched.
const broken = join(work, 'broken');
cpSync(here, broken, {
  recursive: true,
  filter: (p) => !p.includes('node_modules') && !p.includes('/dist') && !p.endsWith('.tgz'),
});
cpSync(sdk, join(broken, 'sdk.tgz'));
run('pnpm', ['install', '--frozen-lockfile'], broken);
const source = join(broken, 'src/index.ts'),
  good = readFileSync(source, 'utf8');
for (const [name, change] of [
  ['missing', 'Number.NaN'],
  ['scale', 'row.closeCents'],
]) {
  writeFileSync(
    source,
    name === 'scale'
      ? good.replaceAll(' / 100', '')
      : good.replace('close: row.closeCents / 100', 'close: ' + change),
  );
  run('pnpm', ['build'], broken);
  if (name === 'missing') {
    writeFileSync(
      join(broken, 'probe.mjs'),
      readFileSync(join(broken, 'test.mjs'), 'utf8').split("test('independently")[0] +
        `try{await defineDataProvider(createStarterProvider(rows,receipt)).query({...request,kind:'price-bars'},{limit:2});throw Error('accepted broken mapping');}catch(e){if(e.context?.path!=='data[].bar.close'||e.context?.reason!=='not_finite')throw e;console.log(e.code+' '+e.context.path+' '+e.context.reason);}`,
    );
    console.log(run(process.execPath, ['probe.mjs'], broken).trim());
  } else
    assert.throws(
      () => run('pnpm', ['test'], broken),
      (error) => /expected-facts/.test(String(error.stdout)),
      'Expected-page oracle must refute finite wrong units',
    );
}
writeFileSync(source, good);
run('pnpm', ['build'], broken);
run('pnpm', ['test'], broken);
console.log('Single-field repair and independent unit-scale oracle passed.');
