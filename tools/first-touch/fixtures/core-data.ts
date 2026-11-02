import { createFixtureDataProvider } from '../../../docs/examples/community-connector-fixture.js';
import {
  dailyRequest,
  page,
  barCapability,
} from '../../../docs/examples/community-connector-facts.js';
import type { FixtureThunk } from '../inputs.js';
const provider = () =>
  createFixtureDataProvider({
    id: 'fixture',
    version: '0.0.0',
    capabilities: [barCapability],
    entries: [{ request: dailyRequest, page: page() }],
  });
export const CORE_DATA_FIXTURES: Record<string, FixtureThunk> = {
  'core.defineDataProvider': () => [
    {
      id: 'fixture',
      version: '0.0.0',
      contractVersion: 1,
      capabilities: () => provider().capabilities(),
      query: async () => page(),
    },
  ],
  'core.createDataView': () => [page()],
  'core.validateDataProvider': Object.assign(
    () => [
      {
        provider: provider(),
        probes: [
          {
            name: 'empty synthetic daily',
            kind: 'pages',
            request: dailyRequest,
            expectedPages: [page()],
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
