import { createFixtureDataProvider } from '../../../docs/examples/community-connector-fixture.js';
import {
  dailyRequest,
  page,
  barCapability,
} from '../../../docs/examples/community-connector-facts.js';
import { defineDataProvider } from '@insiderfinance/totalfinance/core/data';
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
import type { FixtureThunk } from '../inputs.js';
const { limit, ...query } = dailyRequest;
const expected = () => ({
  ...page(),
  contractVersion: 2 as const,
  binding: { provider: { id: 'fixture', version: '0.0.0' }, query },
  timestampConvention: 'session-label-midnight-utc' as const,
  issues: [],
});
const provider = () =>
  createFixtureDataProvider({
    id: 'fixture',
    version: '0.0.0',
    capabilities: [barCapability],
    entries: [
      {
        query,
        cursor: null,
        page: {
          data: [],
          nextCursor: null,
          facts: {
            dataset: { id: 'synthetic', version: '1' },
            receivedTimestampMs: 1793203200000,
            adjustment: 'split',
            consistency: 'best-effort',
            timestampConvention: 'session-label-midnight-utc',
            freshness: { status: 'end-of-day', configuredDelayMs: 0, evaluatedTimestampMs: null },
            quality: { status: 'complete', issues: [] },
          },
        },
      },
    ],
  });
export const CORE_DATA_FIXTURES: Record<string, FixtureThunk> = {
  'core.defineDataProvider': () => [provider()],
  'core.connect': () => [provider()],
  'core.createPriceBarsWindowView': () => [
    {
      version: 2,
      kind: 'price-bars-window',
      contractVersion: 2,
      binding: expected().binding,
      pages: [expected()],
      pagination: { status: 'terminal', pageSize: 2, pageCalls: 1, reads: 2, records: 0 },
      bytes: new TextEncoder().encode(canonicalJsonOf(expected())).length,
    },
  ],
  'core.createDataView': () => [expected()],
  'core.priceBarsCheckpoint': () => [{}],
  'core.validateDataProvider': Object.assign(
    () => [
      {
        provider: defineDataProvider(provider()),
        probes: [
          {
            name: 'empty synthetic daily',
            kind: 'pages',
            request: query,
            pageSize: limit,
            expectedPages: [expected()],
          },
        ],
        maxPages: 1,
        maxRecords: 2,
        timeoutMs: 100,
      },
    ],
    { boundedAsync: true as const },
  ),
};
