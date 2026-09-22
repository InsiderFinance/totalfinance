/** One-time scoped-import golden migration; refuses ANY difference beyond the declared text rename. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { contentHash } from '../../packages/core/src/artifacts/index.js';
import { portfolioBacktest } from '../../packages/backtest/src/portfolio/index.js';
import { portfolioJourneys } from '../../packages/backtest/test/portfolio-journeys.js';

const path = new URL('../../packages/backtest/test/portfolio-golden.json', import.meta.url);
const original = readFileSync(path, 'utf8');
const golden = JSON.parse(original) as Record<
  string,
  {
    hash: string;
    finalValue: number;
    sessions: number;
    fills: number;
    events: number;
  }
>;
const journeys = portfolioJourneys();
assert.deepEqual(Object.keys(journeys).sort(), Object.keys(golden).sort());
for (const [name, request] of Object.entries(journeys)) {
  const result = portfolioBacktest(request);
  const previous = golden[name]!;
  assert.equal(result.finalValue, previous.finalValue, `${name}: finalValue changed`);
  assert.equal(result.diagnostics.sessionCount, previous.sessions, `${name}: sessions changed`);
  assert.equal(result.fills.length, previous.fills, `${name}: fills changed`);
  assert.equal(result.events.length, previous.events, `${name}: events changed`);
  const hash = contentHash(result);
  if (hash === previous.hash) continue;
  // JSON roundtripping is not used: it could coerce non-finite/undefined values and hide changes.
  const restoreText = (value: unknown): unknown => {
    if (typeof value === 'string')
      return value.replaceAll('@insiderfinance/totalfinance/', '@totalfinance/');
    if (Array.isArray(value)) return value.map(restoreText);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, restoreText(item)]),
      );
    return value;
  };
  assert.equal(
    contentHash(restoreText(result)),
    previous.hash,
    `${name}: result changed beyond public-import guidance; requires separate financial review`,
  );
  console.log(`${name}: import-guidance-only ${previous.hash} -> ${hash}`);
  previous.hash = hash;
}
if (process.argv.includes('--write')) writeFileSync(path, `${JSON.stringify(golden, null, 2)}\n`);
else
  assert.equal(
    `${JSON.stringify(golden, null, 2)}\n`,
    original,
    'Reviewed import-only migration pending; run with --write to retain the verified new hashes',
  );
