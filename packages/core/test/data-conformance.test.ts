import { describe, it, expect } from 'vitest';
import { validateDataProvider, type DataPagesProbe } from '../src/data-conformance.js';
import type { DataProvider, DataRequest, DataCapabilities } from '../src/data.js';
import { ErrorCode, DataError, QuantError } from '../src/errors.js';
import { createFixtureDataProvider } from '../../../docs/examples/community-connector-fixture.js';
import { copyFrozen } from '../src/data-validation.js';
import {
  page,
  bar,
  dailyRequest,
  barCapability,
} from '../../../docs/examples/community-connector-facts.js';
function fixture() {
  const first = page(),
    last = page();
  (first.data as unknown[]).push(bar(), bar('2026-10-27'));
  (first as any).nextCursor = 'fixture-page2';
  (last.data as unknown[]).push(bar('2026-10-28'));
  const continuation: DataRequest = {
    kind: 'price-bars',
    symbol: 'TEST',
    cursor: 'fixture-page2',
    limit: 2,
  };
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const provider = createFixtureDataProvider({
    id: 'fixture',
    version: '0.0.0',
    capabilities: [barCapability],
    entries: [
      { request: dailyRequest, page: first },
      { request: continuation, page: last },
    ],
    beforeQuery: async ({ signal }) => {
      if (signal) {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
    },
  });
  const probe: DataPagesProbe = {
    name: 'daily',
    kind: 'pages',
    request: dailyRequest,
    expectedPages: [first, last],
  };
  return { provider, probe, first, last, ready };
}
const options = { maxPages: 4, maxRecords: 10, timeoutMs: 100 };
describe('public data compatibility kit', () => {
  it('proves exact multipage facts, typed errors and actual in-flight abort', async () => {
    const f = fixture();
    await validateDataProvider({
      ...options,
      provider: f.provider,
      probes: [
        f.probe,
        {
          name: 'missing',
          kind: 'error',
          request: { ...dailyRequest, symbol: 'NONE' },
          expectedCode: ErrorCode.DataNotFound,
        },
        { name: 'abort', kind: 'abort', request: dailyRequest, waitUntilStarted: () => f.ready },
      ],
    });
  });
  it.each([{}, null, undefined, { provider: null }, { ...options, probes: [] }])(
    'first touch teaches for %j',
    async (input) => {
      await expect(validateDataProvider(input as never)).rejects.toBeInstanceOf(QuantError);
    },
  );
  const mutations: [string, (page: any, index: number) => any][] = [
    [
      'nonfinite',
      (p) => {
        p.metadata.receivedTimestampMs = NaN;
        return p;
      },
    ],
    [
      'wrong resource',
      (p) => {
        p.symbol = 'OTHER';
        return p;
      },
    ],
    [
      'fabricated coverage',
      (p) => {
        p.metadata.coverage = { status: 'continuous', start: '2000-01-01', end: '2026-10-28' };
        return p;
      },
    ],
    [
      'changed source',
      (p) => {
        p.provenance.provider = 'other';
        return p;
      },
    ],
    [
      'wrong null',
      (p) => {
        p.metadata.times.observedTimestampMs = 123;
        return p;
      },
    ],
    [
      'reordered rows',
      (p) => {
        p.data.reverse();
        return p;
      },
    ],
    [
      'duplicate rows',
      (p) => {
        p.data[1] = p.data[0];
        return p;
      },
    ],
    [
      'cross-page order',
      (p, i) => {
        if (i) p.data = [bar('2026-10-26')];
        return p;
      },
    ],
    [
      'changed snapshot',
      (p, i) => {
        if (i) p.metadata.snapshotId = 'different';
        return p;
      },
    ],
    [
      'repeated cursor',
      (p, i) => {
        if (i) p.nextCursor = 'fixture-page2';
        return p;
      },
    ],
    [
      'row loss',
      (p) => {
        p.data = [];
        p.nextCursor = null;
        return p;
      },
    ],
    [
      'nonfinite decoration',
      (p) => {
        p.extra = { hidden: Infinity };
        return p;
      },
    ],
  ];
  for (const [name, mutate] of mutations)
    it(`refutes independent ${name} mutant`, async () => {
      const f = fixture();
      let index = 0;
      const provider: DataProvider = {
        ...f.provider,
        async query(input) {
          if (input.signal?.aborted)
            throw new DataError('aborted', { code: ErrorCode.DataAborted });
          const p = JSON.parse(JSON.stringify(index ? f.last : f.first));
          return copyFrozen(mutate(p, index++)) as never;
        },
      };
      // A NaN mutation must be visible to the kit, rather than repaired by the fixture wrapper.
      if (name.startsWith('nonfinite'))
        provider.query = async ({ signal }) => {
          if (signal?.aborted) throw new DataError('aborted', { code: ErrorCode.DataAborted });
          return mutate(JSON.parse(JSON.stringify(f.first)), 0) as never;
        };
      await expect(
        validateDataProvider({ ...options, provider, probes: [f.probe] }),
      ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
    });
  it('rejects unfrozen output rather than repairing it', async () => {
    const f = fixture();
    const provider = {
      ...f.provider,
      async query({ signal }: any) {
        if (signal?.aborted) throw new DataError('abort', { code: ErrorCode.DataAborted });
        return f.first as never;
      },
    };
    await expect(
      validateDataProvider({ ...options, provider, probes: [f.probe] }),
    ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
  });
  it('detects input mutation through a provider that otherwise returns valid facts', async () => {
    const f = fixture();
    const original = f.provider.query;
    const provider = {
      ...f.provider,
      async query(input: any) {
        const result = await original(input);
        input.request.symbol = 'OTHER';
        return result as never;
      },
    };
    await expect(
      validateDataProvider({ ...options, provider, probes: [f.probe] }),
    ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
  });
  it('refutes capability mismatch and unproved capabilities', async () => {
    const f = fixture();
    const provider = {
      ...f.provider,
      async capabilities(): Promise<DataCapabilities> {
        const c = await f.provider.capabilities({});
        return copyFrozen({ ...c, capabilities: [{ ...barCapability, maxPageSize: 1 }] });
      },
    };
    await expect(
      validateDataProvider({ ...options, provider, probes: [f.probe] }),
    ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
  });
  it.each([{ maxPages: 1 }, { maxRecords: 2 }])('fails bounded walks %j', async (bound) => {
    const f = fixture();
    await expect(
      validateDataProvider({ ...options, ...bound, provider: f.provider, probes: [f.probe] }),
    ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
  });
  it('bounds a hanging cancellation latch and refuses late success', async () => {
    const f = fixture();
    await expect(
      validateDataProvider({
        ...options,
        timeoutMs: 10,
        provider: f.provider,
        probes: [
          f.probe,
          {
            name: 'never-started',
            kind: 'abort',
            request: dailyRequest,
            waitUntilStarted: () => new Promise(() => {}),
          },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
  });
  it('rejects a callback substitute: abort must reject the actual query', async () => {
    const f = fixture();
    const provider = {
      ...f.provider,
      async query(input: any) {
        if (input.signal?.aborted) throw new DataError('abort', { code: ErrorCode.DataAborted });
        if (input.signal) return copyFrozen(f.first) as never;
        return (await f.provider.query(input)) as never;
      },
    };
    await expect(
      validateDataProvider({
        ...options,
        provider,
        probes: [
          f.probe,
          { name: 'late', kind: 'abort', request: dailyRequest, waitUntilStarted: async () => {} },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
  });
});
