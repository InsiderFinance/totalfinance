import { queryFixture, expectedPage, rawFacts } from './data-fixture-migration.js';
import { describe, it, expect } from 'vitest';
import { validateDataProvider, type DataPagesProbe } from '../src/data-conformance.js';
import type { DataProvider, DataCapabilities } from '../src/data.js';

import { defineDataProvider } from '../src/data.js';
import { ErrorCode, DataError, QuantError } from '../src/errors.js';

import { copyFrozen } from '../src/data-validation.js';
import {
  page,
  bar,
  dailyRequest,
  barCapability,
} from '../../../docs/examples/community-connector-facts.js';
// Test-only unchecked view: preserves malformed raw facts instead of validating/repairing them.
function unchecked(raw: any): any {
  function freeze(value: any): any {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  }
  const p = freeze(raw);
  let closes: any, bars: any, timestamped: any;
  return Object.freeze(
    Object.defineProperties(
      {
        kind: p.kind,
        page: p,
        continuation: p.nextCursor
          ? {
              version: 2,
              binding: p.binding,
              cursor: p.nextCursor,
              pins: {
                datasetId: p.metadata.datasetId,
                datasetVersion: p.metadata.datasetVersion,
                snapshotId: p.metadata.snapshotId,
                sessionDate: p.metadata.sessionDate,
                adjustment: p.metadata.adjustment,
                consistency: p.metadata.consistency,
                temporal: {
                  kind: p.kind,
                  interval: p.binding.query.interval,
                  timestampConvention: p.timestampConvention,
                },
              },
            }
          : null,
        continuationStatus: p.nextCursor ? 'available' : 'terminal',
        issues: p.issues,
        selection: freeze({
          version: 1,
          decisions: [],
          sourceRows: p.data.map((_: unknown, rowIndex: number) => ({ pageIndex: 0, rowIndex })),
        }),
        selections: freeze(['closePrices', 'ohlcvBars', 'bars']),
      },
      {
        closePrices: { get: () => (closes ??= freeze(p.data.map((r: any) => r.bar.close))) },
        resolve: {
          value: () => {
            throw Error('unused mutant resolver');
          },
        },
        bars: { get: () => (timestamped ??= freeze(p.data.map((r: any) => ({ ...r.bar })))) },
        ohlcvBars: {
          get: () =>
            (bars ??= freeze(
              p.data.map((r: any) => ({
                open: r.bar.open,
                high: r.bar.high,
                low: r.bar.low,
                close: r.bar.close,
                volume: r.bar.volume,
              })),
            )),
        },
      },
    ),
  );
}
function fixture() {
  const first = expectedPage(page(), dailyRequest),
    last = expectedPage(page(), dailyRequest);
  (first.data as unknown[]).push(bar(), bar('2026-10-27'));
  (first as any).nextCursor = 'fixture-page2';
  (last.data as unknown[]).push(bar('2026-10-28'));
  let block = false;
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const provider = defineDataProvider({
    protocol: 'totalfinance-data-source',
    contractVersion: 2,
    id: 'fixture',
    version: '0.0.0',
    async capabilities() {
      return [barCapability];
    },
    async query(q, o) {
      if (o.signal && block) {
        started();
        await new Promise<void>((r) =>
          o.signal!.addEventListener('abort', () => r(), { once: true }),
        );
      }
      if (q.symbol !== 'TEST') throw new DataError('not found', { code: ErrorCode.DataNotFound });
      return rawFacts(o.cursor ? last : first);
    },
  });
  const probe: DataPagesProbe = {
    name: 'daily',
    kind: 'pages',
    request: (({ limit: _limit, ...q }) => q)(dailyRequest),
    pageSize: 2,
    expectedPages: [first, last],
  };
  return {
    provider,
    probe,
    first,
    last,
    get ready() {
      block = true;
      return ready;
    },
  };
}
const options = { maxPages: 4, maxRecords: 10, timeoutMs: 100 };
describe('public data compatibility kit', () => {
  it('accepts the unmutated independently assembled view control before refuting one-defect mutants', async () => {
    const f = fixture();
    const provider = {
      ...f.provider,
      async query(q: any, o: any) {
        if (o.signal?.aborted) throw new DataError('abort', { code: ErrorCode.DataAborted });
        return unchecked(structuredClone(o.cursor ? f.last : f.first));
      },
    };
    await expect(
      validateDataProvider({ ...options, provider, probes: [f.probe] }),
    ).resolves.toBeUndefined();
  });
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
          request: { ...f.probe.request, symbol: 'NONE' },
          pageSize: 2,
          expectedCode: ErrorCode.DataNotFound,
        },
        {
          name: 'abort',
          kind: 'abort',
          request: f.probe.request,
          pageSize: 2,
          waitUntilStarted: () => f.ready,
        },
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
        async query(_input, options) {
          if (options?.signal?.aborted)
            throw new DataError('aborted', { code: ErrorCode.DataAborted });
          const p = JSON.parse(JSON.stringify(index ? f.last : f.first));
          return unchecked(mutate(p, index++)) as never;
        },
      };
      // A NaN mutation must be visible to the kit, rather than repaired by the fixture wrapper.
      if (name.startsWith('nonfinite'))
        provider.query = async (_request, { signal }) => {
          if (signal?.aborted) throw new DataError('aborted', { code: ErrorCode.DataAborted });
          return unchecked(mutate(JSON.parse(JSON.stringify(f.first)), 0)) as never;
        };
      await expect(
        validateDataProvider({ ...options, provider, probes: [f.probe] }),
      ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
    });
  it('rejects unfrozen output rather than repairing it', async () => {
    const f = fixture();
    const provider = {
      ...f.provider,
      async query(_request: any, { signal }: any = {}) {
        if (signal?.aborted) throw new DataError('abort', { code: ErrorCode.DataAborted });
        return { kind: f.first.kind, page: f.first } as never;
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
      async query(input: any, options?: any) {
        const result = await original(input, options);
        input.symbol = 'OTHER';
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
        const c = await f.provider.capabilities();
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
            request: f.probe.request,
            pageSize: 2,
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
      async query(input: any, options?: any) {
        if (options?.signal?.aborted) throw new DataError('abort', { code: ErrorCode.DataAborted });
        if (options?.signal) return unchecked(structuredClone(f.first)) as never;
        return (await queryFixture(f.provider, input, options)) as never;
      },
    };
    await expect(
      validateDataProvider({
        ...options,
        provider,
        probes: [
          f.probe,
          {
            name: 'late',
            kind: 'abort',
            request: f.probe.request,
            pageSize: 2,
            waitUntilStarted: async () => {},
          },
        ],
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
  });
});

describe('independent consumer-view compatibility mutants', () => {
  const cases: [string, (descriptors: PropertyDescriptorMap) => void][] = [
    [
      'lost issue disclosure',
      (d) => {
        d['issues']!.value = Object.freeze([
          {
            pageIndex: 0,
            rowIndex: 0,
            rule: 'close_outside_range',
            fields: ['close', 'low', 'high'],
          },
        ]);
      },
    ],
    [
      'wrong source-row correspondence',
      (d) => {
        d['selection']!.value = copyFrozen({
          version: 1,
          decisions: [],
          sourceRows: [
            { pageIndex: 0, rowIndex: 1 },
            { pageIndex: 0, rowIndex: 0 },
          ],
        });
      },
    ],
    [
      'lying timestamped bar',
      (d) => {
        const actual = d['bars']!.get!();
        d['bars']!.get = () =>
          copyFrozen(
            actual.map((b: any, i: number) => ({ ...b, timestampMs: i ? b.timestampMs : 1 })),
          );
      },
    ],
    [
      'lost timestamped adjustment',
      (d) => {
        const actual = d['bars']!.get!();
        d['bars']!.get = () =>
          copyFrozen(
            actual.map((b: any) => {
              const { adjusted: _adjusted, ...rest } = b;
              return rest;
            }),
          );
      },
    ],
    [
      'forged suitability refusal',
      (d) => {
        d['closePrices']!.get = () => {
          throw new DataError('forged', { code: ErrorCode.DataSuspectObservations });
        };
      },
    ],
    [
      'wrong kind',
      (d) => {
        d['kind']!.value = 'option-chain-research';
      },
    ],
    [
      'wrong close',
      (d) => {
        d['closePrices']!.get = () => Object.freeze([999, 101]);
      },
    ],
    [
      'lost close',
      (d) => {
        d['closePrices']!.get = () => Object.freeze([101]);
      },
    ],
    [
      'reordered closes',
      (d) => {
        d['closePrices']!.get = () => Object.freeze([102, 101]);
      },
    ],
    [
      'mutable closes',
      (d) => {
        d['closePrices']!.get = () => [101, 101];
      },
    ],
    [
      'unstable selection',
      (d) => {
        d['closePrices']!.get = () => Object.freeze([101, 101]);
      },
    ],
    [
      'decorated array',
      (d) => {
        const a = [101, 101];
        Object.defineProperty(a, 'source', { value: 'hidden' });
        Object.freeze(a);
        d['closePrices']!.get = () => a;
      },
    ],
    [
      'array subclass',
      (d) => {
        class Series extends Array<number> {}
        const a = Object.freeze(new Series(101, 101));
        d['closePrices']!.get = () => a;
      },
    ],
    [
      'wrong OHLCV',
      (d) => {
        const old = d['ohlcvBars']!.get!;
        const a = old().map((r: any, i: number) =>
          Object.freeze({ ...r, volume: i ? 123 : r.volume }),
        );
        const b = Object.freeze(a);
        d['ohlcvBars']!.get = () => b;
      },
    ],
    [
      'enumerable OHLCV',
      (d) => {
        d['ohlcvBars']!.enumerable = true;
      },
    ],
    [
      'enumerable closes',
      (d) => {
        d['closePrices']!.enumerable = true;
      },
    ],
    [
      'source accessor',
      (d) => {
        const p = d['page']!.value;
        d['page'] = { enumerable: true, configurable: false, get: () => p };
      },
    ],
    [
      'lost source warning',
      (d) => {
        const p = structuredClone(d['page']!.value);
        p.diagnostics.warnings = [];
        d['page']!.value = copyFrozen(p);
      },
    ],
  ];
  for (const [name, mutate] of cases)
    it('refutes ' + name + ' without rebuilding the view', async () => {
      const f = fixture();
      (f.first.diagnostics.warnings as unknown[]).push({
        code: 'data.source_issue',
        message: 'Synthetic source limitation',
        severity: 'warn',
      });
      const base = await queryFixture(f.provider, dailyRequest);
      const d = Object.getOwnPropertyDescriptors(base);
      mutate(d);
      const lie = Object.freeze(Object.defineProperties({}, d));
      const provider = {
        ...f.provider,
        async query(request: any, options?: any) {
          if (options?.signal?.aborted)
            throw new DataError('abort', { code: ErrorCode.DataAborted });
          return (options?.cursor ? await f.provider.query(request, options) : lie) as never;
        },
      };
      await expect(
        validateDataProvider({ ...options, provider, probes: [f.probe] }),
      ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
    });
  it('proves partial-source closes plus field-specific volume refusal, and refutes invented zero', async () => {
    const f = fixture();
    delete (f.first.data[1] as any).bar.volume;
    (f.first.metadata.quality as any).status = 'partial';
    await expect(
      validateDataProvider({ ...options, provider: f.provider, probes: [f.probe] }),
    ).resolves.toBeUndefined();
    const base = await queryFixture(f.provider, dailyRequest);
    const d = Object.getOwnPropertyDescriptors(base);
    const fake = Object.freeze(
      f.first.data.map((r: any) => Object.freeze({ ...r.bar, volume: 0 })),
    );
    d['ohlcvBars']!.get = () => fake;
    const lie = Object.freeze(Object.defineProperties({}, d));
    const provider = {
      ...f.provider,
      async query(request: any, opts?: any) {
        if (opts?.signal?.aborted) throw new DataError('abort', { code: ErrorCode.DataAborted });
        return (opts?.cursor ? await f.provider.query(request, opts) : lie) as never;
      },
    };
    await expect(
      validateDataProvider({ ...options, provider, probes: [f.probe] }),
    ).rejects.toMatchObject({ code: ErrorCode.DataNonconformant });
  });
});
