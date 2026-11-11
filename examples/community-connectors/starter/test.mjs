import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStarterProvider } from './dist/index.js';
import { validateDataProvider } from '@insiderfinance/totalfinance/core/data-conformance';
import { data, technicalAnalysis } from '@insiderfinance/totalfinance';
import { CONVENTIONS_VERSION } from '@insiderfinance/totalfinance/core';
export const rows = [
  {
    ticker: 'TEST',
    session: '2026-10-26',
    openCents: 10000,
    highCents: 10100,
    lowCents: 9900,
    closeCents: 10000,
    shares: 10,
  },
  {
    ticker: 'TEST',
    session: '2026-10-28',
    openCents: 10200,
    highCents: 10300,
    lowCents: 10100,
    closeCents: 10200,
    shares: 10,
  },
  {
    ticker: 'TEST',
    session: '2026-10-30',
    openCents: 10400,
    highCents: 10500,
    lowCents: 10300,
    closeCents: 10400,
    shares: 10,
  },
];
export const receipt = 1793404800000;
export const request = { symbol: 'TEST', interval: '1d', from: '2026-10-26', to: '2026-10-30' };
const times = {
  observedTimestampMs: null,
  availableTimestampMs: null,
  sourceStoredTimestampMs: null,
};
const records = [
  ['2026-10-26', 100, 101, 99, 100],
  ['2026-10-28', 102, 103, 101, 102],
  ['2026-10-30', 104, 105, 103, 104],
].map(([session, open, high, low, close]) => ({
  bar: {
    symbol: 'TEST',
    timestampMs: Date.parse(session + 'T00:00:00Z'),
    open,
    high,
    low,
    close,
    volume: 10,
    adjusted: false,
  },
  sessionDate: session,
  timestampConvention: 'session-label-midnight-utc',
  times,
  source: 'starter-cents-json',
  provisional: null,
  revision: null,
  diagnostics: { warnings: [] },
}));
const header = {
  contractVersion: 1,
  kind: 'price-bars',
  symbol: 'TEST',
  provenance: {
    provider: 'starter-synthetic',
    dataset: 'synthetic-daily',
    sourceVersion: '1',
    receivedAt: receipt,
  },
  metadata: {
    datasetId: 'synthetic-daily',
    datasetVersion: '1',
    snapshotId: null,
    sessionDate: null,
    sourceGeneratedTimestampMs: null,
    receivedTimestampMs: receipt,
    times,
    consistency: 'best-effort',
    freshness: { status: 'historical', configuredDelayMs: null, evaluatedTimestampMs: null },
    coverage: { status: 'observed-only', start: '2026-10-26', end: '2026-10-30' },
    adjustment: 'unadjusted',
    quality: { status: 'complete', issues: [] },
    access: 'granted',
    executionEligibility: 'research-only',
  },
  assumptions: { conventionsVersion: CONVENTIONS_VERSION },
  diagnostics: {
    warnings: [
      {
        code: 'data.coverage_unverified',
        message:
          'Synthetic gapped research sample; terminal paging does not certify continuous history.',
        severity: 'warn',
      },
    ],
  },
};
const cursor = Buffer.from(
  JSON.stringify({ symbol: 'TEST', from: '2026-10-26', to: '2026-10-30', offset: 2 }),
).toString('base64url');
const expected = [
  { ...header, data: records.slice(0, 2), nextCursor: cursor },
  { ...header, data: records.slice(2), nextCursor: null },
];
test('independently expected pages refute unit scaling errors', async () => {
  await validateDataProvider({
    provider: createStarterProvider(rows, receipt),
    probes: [
      {
        name: 'cents mapping',
        kind: 'pages',
        request: { ...request, kind: 'price-bars', limit: 2 },
        expectedPages: expected,
      },
    ],
    maxPages: 2,
    maxRecords: 3,
    timeoutMs: 1000,
  });
});
test('ordinary calculations preserve source and disclose insufficient history', async () => {
  const prices = await data.connect(createStarterProvider(rows, receipt)).priceBars(request);
  assert.deepEqual(prices.closePrices, [100, 102, 104]);
  assert.equal(technicalAnalysis.sma(prices.closePrices, { period: 2 }).at(-1), 103);
  assert.equal(technicalAnalysis.vwap(prices.ohlcvBars).at(-1), 102);
  const last = technicalAnalysis.sma(prices.closePrices, { period: 20 }).at(-1);
  assert.ok(last === undefined || !Number.isFinite(last));
  assert.equal(prices.window.pages[0].diagnostics.warnings[0].code, 'data.coverage_unverified');
  assert.deepEqual(
    data.createPriceBarsWindowView(JSON.parse(JSON.stringify(prices.window))).closePrices,
    prices.closePrices,
  );
});
