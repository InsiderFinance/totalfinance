import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcmeProvider } from './dist/index.js';
import { makeVendorFetch } from './dist/vendor.js';
import { data, technicalAnalysis, backtest } from '@insiderfinance/totalfinance';
import { defineDataProvider } from '@insiderfinance/totalfinance/core/data';
import { validateDataProvider } from '@insiderfinance/totalfinance/core/data-conformance';
const request = { symbol: 'SPY', interval: '1d', from: '2026-01-01', to: '2026-03-01' },
  query = { ...request, kind: 'price-bars' };
const receipt = 1700000000000;
const source = (fetch = makeVendorFetch(30)) =>
  createAcmeProvider('synthetic-key', fetch, () => receipt);
const times = {
  observedTimestampMs: null,
  availableTimestampMs: null,
  sourceStoredTimestampMs: null,
};
// Literal independent truth oracle: no call to provider or SDK materialization constructs expectations.
const expected = [
  {
    bar: {
      symbol: 'SPY',
      timestampMs: Date.parse('2026-01-05T04:00:00Z'),
      open: 99.5,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
      adjusted: true,
    },
    sessionDate: '2026-01-05',
    timestampConvention: 'session-start',
    times,
    source: null,
    provisional: null,
    revision: null,
    diagnostics: { warnings: [] },
  },
];
test('plain author, future intervals and independent expected rows use the same public contract', async () => {
  const p = defineDataProvider(source(makeVendorFetch(1)));
  const caps = await p.capabilities();
  assert.equal(caps.ignored.intervals, 1);
  assert.ok(caps.capabilities[0].intervals.includes('1h'));
  await validateDataProvider({
    provider: p,
    probes: [
      {
        kind: 'records',
        name: 'independent Acme fields/units',
        request: query,
        pageSize: 10000,
        expectedRecords: expected,
        expectedFacts: [
          {
            datasetId: 'bars-1d',
            datasetVersion: 'v2',
            adjustment: 'split',
            consistency: 'best-effort',
          },
        ],
      },
    ],
    maxPages: 2,
    maxRecords: 10000,
    timeoutMs: 1000,
  });
});
test('actual04Z survives array selectors/storage and unchanged existing engines', async () => {
  const p = await data.connect(source()).priceBars(request, { pageSize: 10 });
  assert.equal(technicalAnalysis.sma(p.closePrices, { period: 20 }).at(-1), 119.5);
  assert.equal(p.bars[0].timestampMs, Date.parse('2026-01-05T04:00:00Z'));
  assert.equal(p.bars[0].adjusted, true);
  const restored = data.createPriceBarsWindowView(JSON.parse(JSON.stringify(p.window)));
  assert.deepEqual(restored.bars, p.bars);
  const explicit = {
    data: [...p.bars],
    signal: p.closePrices.map(() => true),
    initialCapital: 1000,
  };
  assert.deepEqual(
    backtest.vectorized(explicit),
    backtest.vectorized({ ...explicit, data: p.bars.map((b) => ({ ...b })) }),
  );
  assert.deepEqual(
    technicalAnalysis.resample(p.bars, 172800000, { includePartial: true }),
    technicalAnalysis.resample(
      p.bars.map((b) => ({ ...b })),
      172800000,
      { includePartial: true },
    ),
  );
});
test('page3 throttle persists consumed work then deliberately resumes without repeating accepted reads', async () => {
  const seen = [];
  let once = true;
  const fetch = makeVendorFetch(30),
    s = source(async (url, init) => {
      const token = new URL(url).searchParams.get('page_token');
      seen.push(token);
      if (token === '20' && once) {
        once = false;
        return new Response('{}', { status: 429 });
      }
      return fetch(url, init);
    });
  let failure;
  try {
    await data.connect(s).priceBars(request, { pageSize: 10 });
  } catch (e) {
    failure = e;
  }
  assert.equal(failure.code, 'data.rate_limited');
  assert.equal(failure.context.retryAfterMs, 2000);
  const cp = data.priceBarsCheckpoint(failure);
  assert.ok(cp);
  assert.equal(cp.pages.length, 2);
  assert.equal(cp.progress.reads, 4);
  assert.ok(!JSON.stringify(failure).includes('page_token'));
  const result = await data.connect(s).resumePriceBars(JSON.parse(JSON.stringify(cp)));
  assert.equal(result.window.pagination.reads, 6);
  assert.deepEqual(seen, [null, '10', '20', '20']);
  assert.equal(technicalAnalysis.sma(result.closePrices, { period: 20 }).at(-1), 119.5);
});
test('unexpected network throw is provider failure, not invalid market data', async () => {
  await assert.rejects(
    data.connect(source(makeVendorFetch(3, { failNetwork: true }))).priceBars(request),
    { code: 'data.provider_failure' },
  );
});
test('suspect finite values are retained, default stop, deliberate exclusion/use/correction are visible', async () => {
  const fetch = makeVendorFetch(3),
    p = await data
      .connect(
        source(async (url, init) => {
          const r = await fetch(url, init),
            b = await r.json();
          b.bars[1].h = 50;
          return new Response(JSON.stringify(b));
        }),
      )
      .priceBars(request);
  assert.equal(p.window.pages[0].data[1].bar.high, 50);
  assert.throws(() => p.closePrices, { code: 'data.suspect_observations' });
  const excluded = p.resolve({ action: 'exclude', reason: 'independent row review' });
  assert.deepEqual(excluded.closePrices, [100, 102]);
  assert.deepEqual(excluded.selection.sourceRows, [
    { pageIndex: 0, rowIndex: 0 },
    { pageIndex: 0, rowIndex: 2 },
  ]);
  const corrected = p.resolve({
    action: 'correct',
    reason: 'explicit independent correction',
    corrections: [{ row: { pageIndex: 0, rowIndex: 1 }, values: { high: 102 } }],
  });
  assert.deepEqual(corrected.closePrices, [100, 101, 102]);
  assert.equal(p.window.pages[0].data[1].bar.high, 50);
  assert.deepEqual(
    data.createPriceBarsWindowView(p.window, JSON.parse(JSON.stringify(excluded.selection)))
      .closePrices,
    excluded.closePrices,
  );
  assert.deepEqual(
    p.resolve({ action: 'use', reason: 'deliberate research decision' }).closePrices,
    [100, 101, 102],
  );
});
