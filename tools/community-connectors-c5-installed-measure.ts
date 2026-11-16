/** Measure every existing ordinary/guard/browser consumer against one installed SDK.
 * No thresholds/options are changed; byte failures are reported for explicit technical review.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  CONSUMER_FIXTURES,
  DATA_CONSUMER_FIXTURES,
  allowedConsumerModule,
} from './bundle-size/consumer-fixtures.js';
import { measureConsumer } from './bundle-size/consumer-measure.js';
const [input, receipt] = process.argv.slice(2);
if (!input || !receipt) throw Error('Installed primary receipt and output required');
const primary = JSON.parse(readFileSync(input, 'utf8'));
const rows = [];
for (const fixture of [...CONSUMER_FIXTURES, ...DATA_CONSUMER_FIXTURES])
  for (const bundler of ['esbuild', 'rollup'] as const) {
    const r = await measureConsumer(primary.consumer, fixture, bundler);
    const repeated = await measureConsumer(primary.consumer, fixture, bundler);
    assert.deepEqual(r, repeated);
    const modules = r.retainedModules.filter((m) =>
      fixture.id.startsWith('data-')
        ? !/\/modules\/(core|totalfinance)\//.test(m.id) || /data-conformance/.test(m.id)
        : !allowedConsumerModule(fixture, bundler, m.id),
    );
    assert.deepEqual(modules, [], `${fixture.id} ${bundler} structural violation`);
    if (!fixture.id.startsWith('data-'))
      assert.ok(
        !r.retainedModules.some((m) => /\/data(?:-|\.js)/.test(m.id)),
        `${fixture.id} retained acquisition`,
      );
    rows.push({ ...r, code: undefined, enforcedCapBytes: fixture.budgetKiB[bundler] * 1024 });
  }
writeFileSync(
  receipt,
  JSON.stringify(
    {
      node: process.version,
      sdk: primary.sdk,
      consumer: primary.consumer,
      repeated: true,
      structuralFailures: 0,
      rows,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify(
    {
      cases: rows.length,
      structuralFailures: 0,
      overages: rows
        .filter((r) => r.bytesGzip >= r.enforcedCapBytes)
        .map(({ retainedModules: _modules, ...r }) => r),
    },
    null,
    2,
  ),
);
