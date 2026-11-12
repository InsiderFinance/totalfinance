/** Independent public-tarball rehearsal for the no-key starter and copied second author.
 * Usage: <sdk.tgz> <starter.tgz> <author.tgz> <receipt.json>. No credentials or vendor requests.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, cpSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const [sdkInput, starterInput, authorInput, receiptInput] = process.argv.slice(2);
if (!sdkInput || !starterInput || !authorInput || !receiptInput)
  throw Error('SDK/starter/author packs and receipt required');
const root = fileURLToPath(new URL('..', import.meta.url)),
  work = mkdtempSync(join(tmpdir(), 'totalfinance-c5-authors-'));
const sdk = resolve(sdkInput),
  starter = resolve(starterInput),
  author = resolve(authorInput),
  receipt = resolve(receiptInput);
const commands: string[] = [];
function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, {
    cwd: work,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: '' },
  });
  commands.push([cmd, ...args].join(' '));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout;
}
try {
  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {
        '@insiderfinance/totalfinance': 'file:' + sdk,
        '@totalfinance-example/cents-connector': 'file:' + starter,
        'tf-connector-acme': 'file:' + author,
      },
    }),
  );
  run('pnpm', ['install', '--ignore-scripts', '--offline', '--no-frozen-lockfile']);
  run('pnpm', ['install', '--frozen-lockfile', '--offline', '--ignore-scripts']);
  const lock = readFileSync(join(work, 'pnpm-lock.yaml'), 'utf8');
  assert.ok(!lock.includes('workspace:'));
  assert.ok(lock.includes('insiderfinance-totalfinance-0.1.4.tgz'));
  for (const name of ['starter', 'alpaca-style']) {
    const p = join(root, 'examples/community-connectors', name),
      input = readFileSync(join(p, 'test.mjs'), 'utf8');
    const code = input
      .replace(
        "from './dist/index.js'",
        name === 'starter'
          ? "from '@totalfinance-example/cents-connector'"
          : "from 'tf-connector-acme'",
      )
      .replace("from './dist/vendor.js'", "from './vendor.mjs'");
    writeFileSync(join(work, name + '.test.mjs'), code);
  }
  // The synthetic vendor is a copied TEST FIXTURE, not a source-workspace provider import.
  cpSync(
    join(root, 'examples/community-connectors/alpaca-style/dist/vendor.js'),
    join(work, 'vendor.mjs'),
  );
  const output = run(process.execPath, ['--test', 'starter.test.mjs', 'alpaca-style.test.mjs']);
  assert.match(output, /# tests 7\b/);
  assert.match(output, /# pass 7\b/);
  assert.match(output, /# skipped 0\b/);
  const installed = realpathSync(join(work, 'node_modules/@insiderfinance/totalfinance'));
  assert.ok(installed.startsWith(realpathSync(work)));
  const source = join(root, 'examples/community-connectors/alpaca-style/src/index.ts');
  assert.doesNotMatch(readFileSync(source, 'utf8'), /\bas\s+(?:Data|Source|never)/);
  const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  writeFileSync(
    receipt,
    JSON.stringify(
      {
        node: process.version,
        syntheticOnly: true,
        tests: 7,
        passed: 7,
        skipped: 0,
        sdk: { path: sdk, sha256: hash(sdk) },
        starter: { path: starter, sha256: hash(starter) },
        author: { path: author, sha256: hash(author) },
        copiedAuthorSourceSha256: hash(source),
        commands,
        output,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify({ tests: 7, passed: 7, syntheticOnly: true, receipt }));
} finally {
  rmSync(work, { recursive: true, force: true });
}
