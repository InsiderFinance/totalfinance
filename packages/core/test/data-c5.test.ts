import type { PriceBarRecord } from '../src/data-types.js';
import { expect, it } from 'vitest';
import {
  connect,
  defineDataProvider,
  createDataView,
  createPriceBarsWindowView,
  priceBarsCheckpoint,
} from '../src/data.js';
import type { DataProviderSource, DataQuery, SourcePriceBarsPage } from '../src/data-types.js';
const query = {
  kind: 'price-bars' as const,
  symbol: 'TEST',
  interval: '1d' as const,
  from: '2026-01-01',
  to: '2026-01-30',
};
const request = { symbol: query.symbol, interval: query.interval, from: query.from, to: query.to };
function page(index: number, nextCursor: string | null = null): SourcePriceBarsPage {
  const session = `2026-01-${String(index + 1).padStart(2, '0')}`;
  return {
    data: [
      {
        bar: {
          timestampMs: Date.parse(session + 'T04:00:00Z'),
          open: 100 + index,
          high: 102 + index,
          low: 99 + index,
          close: 101 + index,
          volume: 10,
          adjusted: true,
          vwap: 0,
        },
        sessionDate: session,
      },
    ],
    nextCursor,
    facts: {
      dataset: { id: 'independent', version: '1' },
      receivedTimestampMs: 1793404800000,
      adjustment: 'split',
      consistency: 'best-effort',
      timestampConvention: 'session-start',
    },
  };
}
function source(overrides: Partial<DataProviderSource> = {}): DataProviderSource {
  return {
    protocol: 'totalfinance-data-source',
    contractVersion: 2,
    id: 'example',
    version: '1',
    async capabilities() {
      return [
        {
          kind: 'price-bars',
          intervals: ['1d'],
          maxPageSize: 10000,
          consistency: ['best-effort'],
          pointInTime: false,
          access: 'unknown',
        },
      ];
    },
    async query() {
      return page(0);
    },
    ...overrides,
  };
}
it('sends original query on every page and restores exact continuation without discovery', async () => {
  let reads = 0,
    caps = 0;
  const seen: DataQuery[] = [];
  const p = defineDataProvider(
    source({
      async capabilities() {
        caps++;
        return [];
      },
      async query(q, o) {
        reads++;
        seen.push(q);
        return page(o.cursor ? 1 : 0, o.cursor ? null : 'vendor-token');
      },
    }),
  );
  const first = await p.query(query, { limit: 1 });
  const restored = createDataView(JSON.parse(JSON.stringify(first.page)));
  expect(restored.continuation?.binding).toEqual({
    provider: { id: 'example', version: '1' },
    query,
  });
  await p.query(query, { limit: 1, cursor: restored.continuation! });
  expect(seen).toEqual([query, query]);
  expect(reads).toBe(2);
  expect(caps).toBe(0);
  await expect(
    p.query({ ...query, to: '2026-01-29' }, { limit: 1, cursor: restored.continuation! }),
  ).rejects.toMatchObject({ code: 'data.invalid_cursor' });
  expect(reads).toBe(2);
});
it('negotiates understood intervals without disabling them for future units', async () => {
  const p = defineDataProvider(
    source({
      async capabilities() {
        return [
          {
            kind: 'price-bars',
            intervals: ['1d', '1s', '1y'],
            maxPageSize: 10000,
            consistency: ['best-effort'],
            pointInTime: false,
            access: 'unknown',
          },
          {
            kind: 'future-data',
            intervals: [],
            maxPageSize: 1,
            consistency: ['best-effort'],
            pointInTime: false,
            access: 'unknown',
          },
        ];
      },
    }),
  );
  const c = await p.capabilities();
  expect(c.capabilities[0]?.intervals).toEqual(['1d']);
  expect(c.ignored).toEqual({ kinds: 1, intervals: 2 });
});
it('preserves actual daily timestamps, flags and zero vwap in native immutable bars', async () => {
  const v = await connect(source()).priceBars(request);
  expect(v.bars[0]).toMatchObject({
    timestampMs: Date.parse('2026-01-01T04:00:00Z'),
    adjusted: true,
    vwap: 0,
  });
  expect(Object.isFrozen(v.bars)).toBe(true);
  expect(JSON.parse(JSON.stringify(v)).selections).toEqual(['closePrices', 'ohlcvBars', 'bars']);
  expect(createPriceBarsWindowView(JSON.parse(JSON.stringify(v.window))).bars).toEqual(v.bars);
});
it('retains suspect values, stops affected selectors and records explicit exclusion/correction/use', async () => {
  const bad = page(0);
  const row = bad.data[0]!;
  const p = source({
    async query() {
      return { ...bad, data: [{ ...row, bar: { ...row.bar, high: 100 } }, ...page(1).data] };
    },
  });
  const v = await connect(p).priceBars(request);
  expect(v.issues).toHaveLength(1);
  expect(() => v.closePrices).toThrowError(
    expect.objectContaining({ code: 'data.suspect_observations' }),
  );
  const excluded = v.resolve({ action: 'exclude', reason: 'independent quality review' });
  expect(excluded.closePrices).toEqual([102]);
  expect(excluded.window.pages[0]!.data[0]!.bar.high).toBe(100);
  const fixed = v.resolve({
    action: 'correct',
    reason: 'explicit correction',
    corrections: [{ row: { pageIndex: 0, rowIndex: 0 }, values: { high: 102 } }],
  });
  expect(fixed.closePrices).toEqual([101, 102]);
  expect(fixed.bars[0]?.high).toBe(102);
  expect(v.resolve({ action: 'use', reason: 'deliberate research' }).closePrices).toEqual([
    101, 102,
  ]);
  expect(
    createPriceBarsWindowView(excluded.window, JSON.parse(JSON.stringify(excluded.selection)))
      .closePrices,
  ).toEqual([102]);
});
it('retains pages and consumed reads on page3 throttle; resumes without accepted refetch', async () => {
  let calls = 0;
  const offsets: number[] = [];
  const s = source({
    async query(q, o) {
      calls++;
      const n = Number(o.cursor ?? 0);
      offsets.push(n);
      if (calls === 3)
        throw Object.assign(new Error('SECRET URL'), {
          code: 'data.rate_limited',
          context: { retryAfterMs: 3000 },
        });
      return page(n, n === 3 ? null : String(n + 1));
    },
  });
  let failed: unknown;
  try {
    await connect(s).priceBars(request);
  } catch (e) {
    failed = e;
  }
  const cp = priceBarsCheckpoint(failed)!;
  expect(cp.pages).toHaveLength(2);
  expect(cp.progress.reads).toBe(4);
  expect(JSON.stringify(failed)).not.toContain('SECRET');
  expect(JSON.stringify(failed)).not.toContain('vendor-token');
  const result = await connect(s, { maxReads: 30 }).resumePriceBars(JSON.parse(JSON.stringify(cp)));
  expect(result.closePrices).toEqual([101, 102, 103, 104]);
  expect(offsets).toEqual([0, 1, 2, 2, 3]);
  expect(result.window.pagination.reads).toBe(7);
});
it('resolves failed automatic discovery under current lower ceiling and counts only invoked reads', async () => {
  let discoveries = 0,
    queries = 0,
    limit = 0;
  const s = source({
    async capabilities() {
      discoveries++;
      if (discoveries === 1)
        throw Object.assign(new Error('offline'), { code: 'data.unavailable' });
      return [
        {
          kind: 'price-bars',
          intervals: ['1d'],
          maxPageSize: 50,
          consistency: ['best-effort'],
          pointInTime: false,
          access: 'unknown',
        },
      ];
    },
    async query(_, o) {
      queries++;
      limit = o.limit;
      return page(0);
    },
  });
  let error: unknown;
  try {
    await connect(s).priceBars(request);
  } catch (e) {
    error = e;
  }
  const cp = priceBarsCheckpoint(error)!;
  expect(cp.paging.state.status).toBe('unresolved');
  expect(cp.progress.reads).toBe(1);
  const v = await connect(s, { pageSize: 20 }).resumePriceBars(cp);
  expect(v.closePrices).toEqual([101]);
  expect(limit).toBe(20);
  expect(v.window.pagination.reads).toBe(3);
  expect(queries).toBe(1);
});
it('retains impossible explicit size and post-discovery consumption', async () => {
  let caps = 0,
    queries = 0;
  const s = source({
    async capabilities() {
      if (++caps === 1) throw Error('fail');
      return [
        {
          kind: 'price-bars',
          intervals: ['1d'],
          maxPageSize: 50,
          consistency: ['best-effort'],
          pointInTime: false,
          access: 'unknown',
        },
      ];
    },
    async query() {
      queries++;
      return page(0);
    },
  });
  let first: unknown;
  try {
    await connect(s, { pageSize: 1000 }).priceBars(request);
  } catch (e) {
    first = e;
  }
  let second: unknown;
  try {
    await connect(s).resumePriceBars(priceBarsCheckpoint(first));
  } catch (e) {
    second = e;
  }
  expect(second).toMatchObject({
    message: expect.stringMatching(/^priceBars: pageSize/),
    code: 'input.out_of_range',
  });
  expect(priceBarsCheckpoint(second)?.progress.reads).toBe(2);
  expect(queries).toBe(0);
  expect(priceBarsCheckpoint(second)?.paging.requested).toEqual({ mode: 'explicit', size: 1000 });
});
it('rejects resolved paging above current host ceiling before discovery and preserves checkpoint', async () => {
  let reads = 0,
    caps = 0;
  const s = source({
    async capabilities() {
      caps++;
      return [
        {
          kind: 'price-bars',
          intervals: ['1d'],
          maxPageSize: 1000,
          consistency: ['best-effort'],
          pointInTime: false,
          access: 'unknown',
        },
      ];
    },
    async query(_, _o) {
      if (++reads === 2) throw Error('failed');
      return page(0, 'next');
    },
  });
  let error: unknown;
  try {
    await connect(s).priceBars(request);
  } catch (e) {
    error = e;
  }
  const cp = priceBarsCheckpoint(error)!;
  let rejected: unknown;
  try {
    await connect(s, { pageSize: 50 }).resumePriceBars(cp);
  } catch (e) {
    rejected = e;
  }
  expect(caps).toBe(1);
  expect(priceBarsCheckpoint(rejected)).toEqual(cp);
  expect(reads).toBe(2);
});
it('new connection defaults do not raise saved budgets; explicit increases do', async () => {
  let reads = 0,
    caps = 0;
  const s = source({
    async capabilities() {
      caps++;
      return [
        {
          kind: 'price-bars',
          intervals: ['1d'],
          maxPageSize: 1000,
          consistency: ['best-effort'],
          pointInTime: false,
          access: 'unknown',
        },
      ];
    },
    async query(_, o) {
      reads++;
      const n = Number(o.cursor ?? 0);
      return page(n, n === 2 ? null : String(n + 1));
    },
  });
  let error: unknown;
  try {
    await connect(s).priceBars(request, { maxPages: 1, maxReads: 2 });
  } catch (e) {
    error = e;
  }
  const cp = priceBarsCheckpoint(error)!;
  let rejected: unknown;
  try {
    await connect(s).resumePriceBars(cp);
  } catch (e) {
    rejected = e;
  }
  expect((rejected as any).code).toBe('data.window_budget_exceeded');
  expect(caps).toBe(1);
  expect(reads).toBe(1);
  const v = await connect(s, { maxPages: 5, maxReads: 10 }).resumePriceBars(cp);
  expect(v.closePrices).toEqual([101, 102, 103]);
  expect(reads).toBe(3);
  expect(v.window.pagination.reads).toBe(5);
});
it('accepted empty nonterminal page retains temporal pins and resumes its cursor', async () => {
  const seen: (string | null)[] = [];
  let attempts = 0;
  const s = source({
    async query(_, o) {
      seen.push(o.cursor);
      attempts++;
      if (attempts === 1) return { ...page(0, 'empty-next'), data: [] };
      if (attempts === 2) throw Error('offline');
      return page(1);
    },
  });
  let error: unknown;
  try {
    await connect(s).priceBars(request);
  } catch (e) {
    error = e;
  }
  const cp = priceBarsCheckpoint(error)!;
  expect(cp.progress).toMatchObject({ acceptedPages: 1, records: 0, reads: 3 });
  expect(cp.next?.pins.temporal).toMatchObject({ timestampConvention: 'session-start' });
  const v = await connect(s).resumePriceBars(cp);
  expect(v.closePrices).toEqual([102]);
  expect(seen).toEqual([null, 'empty-next', 'empty-next']);
});
it('pre-dispatch abort never invokes or charges the source', async () => {
  let caps = 0;
  const s = source({
    async capabilities() {
      caps++;
      return [];
    },
  });
  const c = new AbortController();
  const p = connect(s).priceBars(request, { signal: c.signal });
  c.abort();
  let error: unknown;
  try {
    await p;
  } catch (e) {
    error = e;
  }
  expect((error as any).code).toBe('data.aborted');
  expect(caps).toBe(0);
  expect(priceBarsCheckpoint(error)?.progress.reads).toBe(0);
});
it('mixed individually valid daily conventions refuse in live and restored sequences', async () => {
  const s = source({
    async query(_, o) {
      return o.cursor
        ? {
            ...page(1),
            data: page(1).data.map((r) => ({
              ...r,
              bar: { ...r.bar, timestampMs: Date.parse('2026-01-02T00:00:00Z') },
            })),
            facts: { ...page(1).facts, timestampConvention: 'session-label-midnight-utc' },
          }
        : page(0, 'next');
    },
  });
  await expect(connect(s).priceBars(request)).rejects.toMatchObject({
    code: 'data.invalid_response',
  });
});
it('unknown volume remains serializable and known close is usable with partial quality', async () => {
  const raw = page(0),
    bar = { ...raw.data[0]!.bar };
  delete bar.volume;
  const s = source({
    async query() {
      return {
        ...raw,
        data: [{ ...raw.data[0]!, bar }],
        facts: { ...raw.facts, quality: { status: 'partial', issues: [] } },
      };
    },
  });
  const v = await connect(s).priceBars(request);
  expect(v.closePrices).toEqual([101]);
  expect(() => JSON.stringify(v)).not.toThrow();
  expect(() => v.bars).toThrowError(expect.objectContaining({ code: 'input.missing_field' }));
});
for (const adjusted of [true, false, undefined])
  it('retains supplied adjusted flag ' + adjusted, async () => {
    const r = page(0),
      bar = { ...r.data[0]!.bar };
    delete bar.adjusted;
    if (adjusted !== undefined) bar.adjusted = adjusted;
    const v = await connect(
      source({
        async query() {
          return {
            ...r,
            data: [{ ...r.data[0]!, bar }],
            facts: { ...r.facts, adjustment: 'unknown' },
          };
        },
      }),
    ).priceBars(request);
    expect(v.bars[0]?.adjusted).toBe(adjusted);
    expect(Object.hasOwn(v.bars[0]!, 'adjusted')).toBe(adjusted !== undefined);
    expect(v.bars[0]?.vwap).toBe(0);
  });

import { DataProviderError } from '../src/data.js';
import { DataError, InputError, ErrorCode } from '../src/errors.js';
import { validateDataProvider } from '../src/data-conformance.js';
import { chain } from '../../../docs/examples/community-connector-facts.js';
import { vectorized } from '../../backtest/src/vectorized.js';
import { resample } from '../../technical-analysis/src/resample.js';
for (const tokens of [
  [],
  ['1d', '1d'],
  ['1d', ''],
  ['1d', '1\ns'],
  ['1d', 0],
  ['1d', 'x'.repeat(33)],
])
  it('refuses malformed known interval declaration ' + JSON.stringify(tokens), async () => {
    const s = source({
      async capabilities() {
        return [
          {
            kind: 'price-bars',
            intervals: tokens,
            maxPageSize: 10000,
            consistency: ['best-effort'],
            pointInTime: false,
            access: 'unknown',
          },
        ] as never;
      },
    });
    await expect(defineDataProvider(s).capabilities()).rejects.toMatchObject({
      code: 'data.invalid_response',
    });
  });
for (const interval of ['5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mo'] as const)
  it('understands explicit interval ' + interval, async () => {
    const session = ['1d', '1w', '1mo'].includes(interval);
    const s = source({
      async capabilities() {
        return [
          {
            kind: 'price-bars',
            intervals: [interval, '1s'],
            maxPageSize: 50000,
            consistency: ['best-effort'],
            pointInTime: false,
            access: 'unknown',
          },
        ];
      },
      async query() {
        return {
          ...page(0),
          facts: {
            ...page(0).facts,
            timestampConvention: session ? 'session-start' : 'interval-start',
          },
          data: page(0).data.map((r) => ({
            ...r,
            sessionDate: session ? (r.sessionDate ?? null) : null,
          })),
        };
      },
    });
    const v = await connect(s).priceBars({
      ...request,
      interval,
      ...(!session ? { from: '2026-01-01T04:00:00Z', to: '2026-01-01T04:00:00Z' } : {}),
    });
    expect(v.closePrices).toEqual([101]);
  });
it('restores filtered chain continuation with exact query/version/pins and zero discovery', async () => {
  let calls = 0,
    caps = 0;
  const a = { ...chain(), sourceContractId: 'a' },
    b = { ...chain(), sourceContractId: 'b' };
  const q = {
    kind: 'option-chain-research' as const,
    symbol: 'TEST',
    snapshot: { kind: 'id' as const, snapshotId: 'snap' },
    expirationFrom: a.terms.expiry,
    expirationTo: a.terms.expiry,
    minStrike: a.terms.strike,
    maxStrike: a.terms.strike,
    rights: ['call' as const],
  };
  const s = source({
    async capabilities() {
      caps++;
      return [];
    },
    async query(actual, o) {
      calls++;
      expect(actual).toEqual(q);
      return {
        data: [o.cursor ? b : a],
        nextCursor: o.cursor ? null : 'source-chain-token',
        facts: {
          dataset: { id: 'chain', version: '2' },
          receivedTimestampMs: 1793404800000,
          adjustment: 'unknown',
          consistency: 'snapshot',
          snapshotId: 'snap',
        },
      };
    },
  });
  const p = defineDataProvider(s),
    v = await p.query(q, { limit: 1 }),
    r = createDataView(JSON.parse(JSON.stringify(v.page)));
  expect(r.continuation).toEqual(v.continuation);
  if (!r.continuation) throw Error('missing continuation');
  await p.query(q, { limit: 1, cursor: r.continuation });
  expect(caps).toBe(0);
  expect(calls).toBe(2);
  for (const changed of [
    { ...q, maxStrike: q.maxStrike + 1 },
    { ...q, rights: ['put' as const] },
  ])
    await expect(p.query(changed, { limit: 1, cursor: r.continuation })).rejects.toMatchObject({
      code: 'data.invalid_cursor',
    });
  await expect(
    defineDataProvider({ ...s, version: 'other' }).query(q, { limit: 1, cursor: r.continuation }),
  ).rejects.toMatchObject({ code: 'data.invalid_cursor' });
  expect(calls).toBe(2);
  const bad = structuredClone({
    ...r.continuation,
    pins: { ...r.continuation.pins, snapshotId: 'other' },
  });
  await expect(p.query(q, { limit: 1, cursor: bad })).rejects.toBeInstanceOf(InputError);
  expect(calls).toBe(2);
});
for (const adjusted of [true, false, undefined])
  it(
    'timestamped arrays preserve existing backtest and resample behavior ' + adjusted,
    async () => {
      const s = source({
        async query() {
          return {
            ...page(0),
            facts: { ...page(0).facts, adjustment: 'unknown' },
            data: [0, 1, 2].flatMap((n) =>
              page(n).data.map((r) => {
                const bar = { ...r.bar };
                delete bar.adjusted;
                if (adjusted !== undefined) bar.adjusted = adjusted;
                return { ...r, bar };
              }),
            ),
          };
        },
      });
      const v = await connect(s).priceBars(request);
      const independent = [0, 1, 2].map((n) => ({
        symbol: 'TEST',
        timestampMs: Date.parse(`2026-01-0${n + 1}T04:00:00Z`),
        open: 100 + n,
        high: 102 + n,
        low: 99 + n,
        close: 101 + n,
        volume: 10,
        vwap: 0,
        ...(adjusted === undefined ? {} : { adjusted }),
      }));
      expect(v.bars).toEqual(independent);
      expect(
        vectorized({ data: [...v.bars], signal: [true, true, true], initialCapital: 1000 }),
      ).toEqual(
        vectorized({ data: independent, signal: [true, true, true], initialCapital: 1000 }),
      );
      expect(resample(v.bars, 172800000, { includePartial: true })).toEqual(
        resample(independent, 172800000, { includePartial: true }),
      );
    },
  );
it('unrelated open issue leaves closes usable; use still meets existing leaf refusal', async () => {
  const p = page(0);
  const v = await connect(
    source({
      async query() {
        return { ...p, data: p.data.map((r) => ({ ...r, bar: { ...r.bar, open: 1000 } })) };
      },
    }),
  ).priceBars(request);
  expect(v.issues.map((i) => i.rule)).toEqual(['open_outside_range']);
  expect(v.closePrices).toEqual([101]);
  expect(() => v.bars).toThrowError(expect.objectContaining({ code: 'data.suspect_observations' }));
  const use = v.resolve({ action: 'use', reason: 'retain source' });
  expect(use.bars[0]?.open).toBe(1000);
  expect(resample(use.bars, 86400000)).toEqual(
    resample(
      use.bars.map((r) => ({ ...r })),
      86400000,
    ),
  );
});
for (const choice of [
  {
    action: 'correct',
    reason: 'bad correction',
    corrections: [{ row: { pageIndex: 0, rowIndex: 0 }, values: { high: 100 } }],
  },
  {
    action: 'correct',
    reason: 'no volume invention',
    corrections: [{ row: { pageIndex: 0, rowIndex: 0 }, values: { volume: 0 } }],
  },
  {
    action: 'exclude',
    reason: 'duplicate',
    rows: [
      { pageIndex: 0, rowIndex: 0 },
      { pageIndex: 0, rowIndex: 0 },
    ],
  },
  { action: 'use', reason: '', rows: [{ pageIndex: 0, rowIndex: 0 }] },
])
  it('refuses invalid explicit quality choice ' + choice.reason, async () => {
    const raw = page(0);
    const v = await connect(
      source({
        async query() {
          return { ...raw, data: raw.data.map((r) => ({ ...r, bar: { ...r.bar, high: 100 } })) };
        },
      }),
    ).priceBars(request);
    expect(() => v.resolve(choice as never)).toThrow();
  });
it('validates replayed choices, correspondence and immutable originals', async () => {
  const raw = page(0),
    v = await connect(
      source({
        async query() {
          return { ...raw, data: raw.data.map((r) => ({ ...r, bar: { ...r.bar, high: 100 } })) };
        },
      }),
    ).priceBars(request);
  const a = v.resolve({
    action: 'correct',
    reason: 'independent correction',
    corrections: [{ row: { pageIndex: 0, rowIndex: 0 }, values: { high: 105 } }],
  });
  expect(a.window).toBe(v.window);
  expect(a.bars[0]?.high).toBe(105);
  expect(v.window.pages[0]?.data[0]?.bar.high).toBe(100);
  const restored = createPriceBarsWindowView(
    JSON.parse(JSON.stringify(a.window)),
    JSON.parse(JSON.stringify(a.selection)),
  );
  expect(restored.bars).toEqual(a.bars);
  expect(restored.issues).toEqual(v.issues);
  const lie = structuredClone(a.selection);
  (lie.sourceRows as unknown[]).pop();
  expect(() => createPriceBarsWindowView(a.window, lie)).toThrow();
  expect(() => a.resolve({ action: 'use', reason: 'second decision' })).toThrow();
  expect(Object.isFrozen(a.selection.decisions[0])).toBe(true);
});
it('normalizes controlled safe provider guidance and foreign error descriptors without arbitrary text', async () => {
  for (const failure of [
    new DataError('secret-url', {
      code: ErrorCode.DataRateLimited,
      context: { retryAfterMs: 321, status: 429, requestId: 'secret' },
    }),
    new DataProviderError({
      code: ErrorCode.DataRateLimited,
      retryAfterMs: 321,
      status: 429,
      cause: 'secret-url',
    }),
  ]) {
    try {
      await defineDataProvider(
        source({
          async query() {
            throw failure;
          },
        }),
      ).query(query, { limit: 1 });
      throw Error('accepted');
    } catch (e: any) {
      expect(e).toBeInstanceOf(DataError);
      expect(e.code).toBe('data.rate_limited');
      expect(e.context).toMatchObject({ retryAfterMs: 321, status: 429 });
      expect(JSON.stringify(e)).not.toMatch(/secret|cause|requestId/);
      expect(e.cause).toBe(failure);
    }
  }
  const p = defineDataProvider(
    source({
      async query() {
        throw new DataProviderError({
          code: ErrorCode.DataInvalidRequest,
          guidance: { field: 'request.symbol', rule: 'uppercase_symbol' },
          cause: 'secret',
        });
      },
    }),
  );
  await expect(p.query({ ...query, symbol: 'test' }, { limit: 1 })).rejects.toMatchObject({
    name: 'InputError',
    code: 'data.invalid_request',
    context: { field: 'request.symbol', rule: 'uppercase_symbol' },
    message: expect.stringMatching(/uppercase.*SPY/),
  });
});
it('never calls foreign error getters/toJSON and treats unknown failures as provider failures', async () => {
  let getters = 0;
  const forged = {
    get code() {
      getters++;
      return 'data.rate_limited';
    },
    get context() {
      getters++;
      return { retryAfterMs: 0 };
    },
    toJSON() {
      getters++;
      return 'secret';
    },
  };
  const p = defineDataProvider(
    source({
      async query() {
        throw forged;
      },
    }),
  );
  await expect(p.query(query, { limit: 1 })).rejects.toMatchObject({
    code: 'data.provider_failure',
  });
  expect(getters).toBe(0);
});
it('malformed expected record fixtures are InputErrors before capabilities or query', async () => {
  let calls = 0;
  const p = defineDataProvider(
    source({
      async capabilities() {
        calls++;
        return [];
      },
      async query() {
        calls++;
        return page(0);
      },
    }),
  );
  const r = expectedRecordFacts()[0]!;
  const bad = { ...r, bar: { ...r.bar, close: NaN } };
  await expect(
    validateDataProvider({
      provider: p,
      probes: [
        {
          name: 'caller oracle',
          kind: 'records',
          request: query,
          pageSize: 1,
          expectedRecords: [bad],
          expectedFacts: [
            {
              datasetId: 'independent',
              datasetVersion: '1',
              adjustment: 'split',
              consistency: 'best-effort',
            },
          ],
        },
      ],
      maxPages: 2,
      maxRecords: 2,
      timeoutMs: 100,
    }),
  ).rejects.toMatchObject({
    name: 'InputError',
    code: 'input.not_finite',
    context: { path: 'data[].bar.close', rowIndex: 0 },
  });
  expect(calls).toBe(0);
});
it('record oracle refutes finite wrong source units independently', async () => {
  const correct = { page: { data: expectedRecordFacts() } };
  const raw = page(0),
    s = source({
      async query() {
        return {
          ...raw,
          data: raw.data.map((r) => ({
            ...r,
            bar: {
              ...r.bar,
              open: r.bar.open * 100,
              high: r.bar.high * 100,
              low: r.bar.low * 100,
              close: r.bar.close * 100,
            },
          })),
        };
      },
    });
  await expect(
    validateDataProvider({
      provider: defineDataProvider(s),
      probes: [
        {
          name: 'independent units',
          kind: 'records',
          request: query,
          pageSize: 1,
          expectedRecords: correct.page.data,
          expectedFacts: [
            {
              datasetId: 'independent',
              datasetVersion: '1',
              adjustment: 'split',
              consistency: 'best-effort',
            },
          ],
        },
      ],
      maxPages: 2,
      maxRecords: 2,
      timeoutMs: 100,
    }),
  ).rejects.toMatchObject({ code: 'data.nonconformant', context: { law: 'expected-facts' } });
});

function expectedRecordFacts(): PriceBarRecord[] {
  return [
    {
      bar: {
        symbol: 'TEST',
        timestampMs: Date.parse('2026-01-01T04:00:00Z'),
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 10,
        adjusted: true,
        vwap: 0,
      },
      sessionDate: '2026-01-01',
      timestampConvention: 'session-start',
      times: {
        observedTimestampMs: null,
        availableTimestampMs: null,
        sourceStoredTimestampMs: null,
      },
      source: null,
      provisional: null,
      revision: null,
      diagnostics: { warnings: [] },
    },
  ];
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw Error('expected refusal');
}
for (const dimension of ['maxPages', 'maxReads', 'maxRecords'] as const)
  it(
    'preserves exhausted ' + dimension + ' and explicitly resumes without accepted refetch',
    async () => {
      const seen: (string | null)[] = [];
      const s = source({
        async query(_, o) {
          seen.push(o.cursor);
          return page(Number(o.cursor ?? 0), o.cursor === null ? '1' : null);
        },
      });
      const limits =
        dimension === 'maxPages'
          ? { maxPages: 1 }
          : dimension === 'maxReads'
            ? { maxReads: 2 }
            : { maxRecords: 1 };
      const first = await failureOf(() => connect(s).priceBars(request, limits)),
        cp = priceBarsCheckpoint(first);
      if (!cp) throw Error('missing checkpoint');
      expect(cp.pages).toHaveLength(1);
      expect(seen).toEqual([null]);
      const refused = await failureOf(() => connect(s).resumePriceBars(cp));
      expect(priceBarsCheckpoint(refused)).toEqual(cp);
      expect(seen).toEqual([null]);
      const result = await connect(s).resumePriceBars(cp, {
        [dimension]: dimension === 'maxReads' ? 4 : 2,
      });
      expect(result.closePrices).toEqual([101, 102]);
      expect(seen).toEqual([null, '1']);
      expect(result.window.pagination.reads).toBe(4);
    },
  );
it('pre-aborted resume preserves checkpoint and zero additional source calls', async () => {
  let calls = 0;
  const s = source({
      async query() {
        calls++;
        return page(0, '1');
      },
    }),
    e = await failureOf(() => connect(s, { maxPages: 1 }).priceBars(request)),
    cp = priceBarsCheckpoint(e);
  if (!cp) throw Error('missing checkpoint');
  const c = new AbortController();
  c.abort();
  const r = await failureOf(() =>
    connect(s, { maxPages: 3 }).resumePriceBars(cp, { signal: c.signal }),
  );
  expect((r as any).code).toBe('data.aborted');
  expect(priceBarsCheckpoint(r)).toEqual(cp);
  expect(calls).toBe(1);
});
it('body abort charges attempted query, accepts no page and explicitly resumes it', async () => {
  const controller = new AbortController();
  let calls = 0;
  const s = source({
    async query() {
      if (++calls === 1) controller.abort();
      return page(0);
    },
  });
  const error = await failureOf(() => connect(s).priceBars(request, { signal: controller.signal })),
    cp = priceBarsCheckpoint(error);
  if (!cp) throw Error('missing checkpoint');
  expect(cp.pages).toEqual([]);
  expect(cp.progress.reads).toBe(2);
  const v = await connect(s).resumePriceBars(cp);
  expect(v.closePrices).toEqual([101]);
  expect(v.window.pagination.reads).toBe(4);
  expect(calls).toBe(2);
});
it('expired source pin does not reset to a new snapshot or refetch accepted pages', async () => {
  const seen: (string | null)[] = [];
  const s = source({
    async query(_, o) {
      seen.push(o.cursor);
      if (o.cursor !== null) throw new DataProviderError({ code: ErrorCode.DataSnapshotExpired });
      return page(0, 'pin-token');
    },
  });
  const error = await failureOf(() => connect(s).priceBars(request)),
    cp = priceBarsCheckpoint(error);
  if (!cp) throw Error('missing checkpoint');
  expect(cp.pages).toHaveLength(1);
  expect(cp.progress.reads).toBe(3);
  const again = await failureOf(() => connect(s).resumePriceBars(cp));
  expect((again as any).code).toBe('data.snapshot_expired');
  expect(priceBarsCheckpoint(again)?.progress.reads).toBe(5);
  expect(seen).toEqual([null, 'pin-token', 'pin-token']);
});
it('revalidates checkpoint binding, pins, conventions, counters and bytes before any I/O', async () => {
  let calls = 0,
    caps = 0;
  const s = source({
    async capabilities() {
      caps++;
      return [
        {
          kind: 'price-bars',
          intervals: ['1d'],
          maxPageSize: 1000,
          consistency: ['best-effort'],
          pointInTime: false,
          access: 'unknown',
        },
      ];
    },
    async query() {
      calls++;
      return page(0, 'pin-token');
    },
  });
  const error = await failureOf(() => connect(s, { maxPages: 1 }).priceBars(request)),
    cp = priceBarsCheckpoint(error);
  if (!cp) throw Error('missing checkpoint');
  const mutants = [
    (c: any) => (c.binding.provider.version = 'other'),
    (c: any) => (c.binding.query.to = '2025-12-30'),
    (c: any) => (c.next.pins.datasetId = 'other'),
    (c: any) => (c.next.pins.temporal.timestampConvention = 'session-label-midnight-utc'),
    (c: any) => (c.progress.reads = 0),
    (c: any) => c.bytes++,
    (c: any) => (c.pages[0].data[0].bar.close = NaN),
  ];
  for (const mutate of mutants) {
    const saved = structuredClone(cp);
    mutate(saved);
    await expect(connect(s).resumePriceBars(saved)).rejects.toBeInstanceOf(InputError);
    expect(caps).toBe(1);
    expect(calls).toBe(1);
  }
});
it('rejects changed temporal convention on an accepted-empty-page resume without accepting it', async () => {
  let attempt = 0;
  const s = source({
    async query() {
      if (++attempt === 1) return { ...page(0, 'empty'), data: [] };
      if (attempt === 2) throw Error('offline');
      return {
        ...page(1),
        facts: { ...page(1).facts, timestampConvention: 'session-label-midnight-utc' },
        data: page(1).data.map((r) => ({
          ...r,
          bar: { ...r.bar, timestampMs: Date.parse('2026-01-02T00:00:00Z') },
        })),
      };
    },
  });
  const error = await failureOf(() => connect(s).priceBars(request)),
    cp = priceBarsCheckpoint(error);
  if (!cp) throw Error('missing checkpoint');
  const again = await failureOf(() => connect(s).resumePriceBars(cp));
  expect((again as any).code).toBe('data.invalid_response');
  expect(priceBarsCheckpoint(again)?.pages).toEqual(cp.pages);
  expect(priceBarsCheckpoint(again)?.progress.reads).toBe(5);
});
for (const options of [{ maxSessionDays: 3 }, { maxWindowMs: 0 }])
  it('validates declared span ceiling ' + JSON.stringify(options), async () => {
    const s = source({
      async capabilities() {
        return [
          {
            kind: 'price-bars',
            intervals: ['1d'],
            maxPageSize: 10000,
            consistency: ['best-effort'],
            pointInTime: false,
            access: 'unknown',
            ...options,
          },
        ];
      },
    });
    if (options.maxWindowMs === 0)
      await expect(defineDataProvider(s).capabilities()).rejects.toMatchObject({
        code: 'data.invalid_response',
      });
    else {
      await expect(
        connect(s).priceBars({ ...request, from: '2026-01-01', to: '2026-01-03' }),
      ).resolves.toBeDefined();
      await expect(
        connect(s).priceBars({ ...request, from: '2026-01-01', to: '2026-01-04' }),
      ).rejects.toMatchObject({ code: 'input.out_of_range' });
      await expect(
        connect(s).priceBars({ ...request, from: '2026-01-01', to: '2026-01-01' }),
      ).resolves.toBeDefined();
    }
  });

it('raw author omitted and explicit undefined close keep controlled field/row diagnostics', async () => {
  for (const explicit of [true, false]) {
    const raw = structuredClone(page(0));
    const b = raw.data[0]!.bar as unknown as Record<string, unknown>;
    if (explicit) b['close'] = undefined;
    else delete b['close'];
    await expect(
      defineDataProvider(
        source({
          async query() {
            return raw;
          },
        }),
      ).query(query, { limit: 1 }),
    ).rejects.toMatchObject({
      code: 'data.invalid_response',
      context: { path: 'data[].bar.close', rowIndex: 0, reason: 'missing_field' },
    });
  }
  const raw = page(0);
  const noBar = { ...raw, data: [{ sessionDate: '2026-01-01' }] };
  await expect(
    defineDataProvider(
      source({
        async query() {
          return noBar as never;
        },
      }),
    ).query(query, { limit: 1 }),
  ).rejects.toMatchObject({
    code: 'data.invalid_response',
    context: { path: 'data[].bar', rowIndex: 0, reason: 'missing_field' },
  });
});

it('raw-source scanner does not promote canonical-envelope lookalikes or arbitrary names', async () => {
  for (const decoration of [
    { metadata: { datasetId: NaN } },
    { binding: { provider: { id: undefined } } },
    { 'data[0].bar.close': NaN },
  ]) {
    const s = source({
      async query() {
        return { ...page(0), ...decoration };
      },
    });
    await expect(defineDataProvider(s).query(query, { limit: 1 })).rejects.toMatchObject({
      code: 'data.invalid_response',
      context: { path: 'page', reason: 'invalid_structure' },
    });
  }
});

it('rebuilds genuine SDK validation detail after a provider changes public error text/context', async () => {
  let original: unknown;
  try {
    createDataView({
      contractVersion: 1,
      kind: 'price-bars',
      symbol: 'TEST',
      data: [],
      nextCursor: null,
    });
  } catch (error) {
    original = error;
  }
  if (!(original instanceof DataError)) throw Error('missing SDK validation error');
  original.message = 'secret URL from provider';
  Object.defineProperty(original, 'context', { value: { path: 'secret', value: 'payload' } });
  await expect(
    defineDataProvider(
      source({
        async query() {
          throw original;
        },
      }),
    ).query(query, { limit: 1 }),
  ).rejects.toMatchObject({ code: 'data.invalid_response', context: { path: 'provenance' } });
  const failed = await failureOf(() =>
    defineDataProvider(
      source({
        async query() {
          throw original;
        },
      }),
    ).query(query, { limit: 1 }),
  );
  expect(JSON.stringify(failed)).not.toMatch(/secret|URL|payload/);
});
it('prototype-forged validation errors cannot promote provider-authored schema context', async () => {
  const bad = page(0);
  const r = bad.data[0]!;
  const broken = source({
    async query() {
      return { ...bad, data: [{ ...r, bar: { ...r.bar, close: NaN } }] };
    },
  });
  const actual = await failureOf(() => defineDataProvider(broken).query(query, { limit: 1 }));
  const forged = Object.assign(Object.create(Object.getPrototypeOf(actual)), {
    code: 'data.invalid_response',
    message: 'secret payload',
    issue: Object.freeze({
      phase: 'page',
      path: 'secret',
      reason: 'not_finite',
      validationCode: 'input.not_finite',
    }),
    context: { path: 'secret', value: 'payload' },
  });
  const rejected = await failureOf(() =>
    defineDataProvider(
      source({
        async query() {
          throw forged;
        },
      }),
    ).query(query, { limit: 1 }),
  );
  expect((rejected as any).code).toBe('data.invalid_response');
  expect((rejected as any).context?.path).toBeUndefined();
  expect(JSON.stringify(rejected)).not.toMatch(/secret|payload/);
});
it('copies constructor control authority instead of retaining mutable caller options', async () => {
  let calls = 0;
  const s = source({
    async query(_, o) {
      calls++;
      return page(o.cursor ? 1 : 0, o.cursor ? null : '1');
    },
  });
  const error = await failureOf(() => connect(s).priceBars(request, { maxReads: 2, maxPages: 1 })),
    cp = priceBarsCheckpoint(error);
  if (!cp) throw Error('missing checkpoint');
  const omitted: { maxReads?: number; maxPages?: number } = {},
    defaults = connect(s, omitted);
  omitted.maxReads = 20;
  omitted.maxPages = 10;
  const refused = await failureOf(() => defaults.resumePriceBars(cp));
  expect((refused as any).code).toBe('data.window_budget_exceeded');
  expect(priceBarsCheckpoint(refused)).toEqual(cp);
  expect(calls).toBe(1);
  const explicit = { maxReads: 10, maxPages: 5 },
    chosen = connect(s, explicit);
  explicit.maxReads = 1;
  explicit.maxPages = 1;
  const success = await chosen.resumePriceBars(cp);
  expect(success.closePrices).toEqual([101, 102]);
  expect(calls).toBe(2);
  expect(explicit).toEqual({ maxReads: 1, maxPages: 1 });
});
it('portable guidance admits controlled canonical fields without claiming a forged SDK phase', async () => {
  for (const field of [
    'data[].bar.close',
    'metadata.datasetId',
    'capabilities[].maxPageSize',
  ] as const) {
    const p = defineDataProvider(
      source({
        async query() {
          throw new DataProviderError({
            code: ErrorCode.DataInvalidResponse,
            guidance: { field, rule: 'source_domain_rule' },
          });
        },
      }),
    );
    const e = await failureOf(() => p.query(query, { limit: 1 }));
    expect((e as any).context).toEqual({ retryable: false, field, rule: 'source_domain_rule' });
    expect((e as any).context.phase).toBeUndefined();
  }
  expect(
    () =>
      new DataProviderError({
        code: ErrorCode.DataInvalidRequest,
        guidance: { field: 'secret URL' as never, rule: 'source_domain_rule' },
      }),
  ).toThrowError(expect.objectContaining({ code: 'input.invalid_enum' }));
});
for (const patch of [
  { protocol: 'other' },
  { contractVersion: 1 },
  { query: null },
  { capabilities: null },
])
  it('refuses raw-source protocol misuse before any call ' + JSON.stringify(patch), () => {
    let calls = 0;
    const raw = source({
      async capabilities() {
        calls++;
        return [];
      },
      async query() {
        calls++;
        return page(0);
      },
    });
    expect(() => connect({ ...raw, ...patch } as never)).toThrow();
    expect(calls).toBe(0);
  });
it('refuses a consumer wrapper as the C5 raw-source binding before calling it', () => {
  let calls = 0;
  const p = defineDataProvider(
    source({
      async capabilities() {
        calls++;
        return [];
      },
      async query() {
        calls++;
        return page(0);
      },
    }),
  );
  expect(() => connect(p as never)).toThrowError(
    expect.objectContaining({ code: 'data.contract_version_unsupported' }),
  );
  expect(calls).toBe(0);
});

it.each(['cycle', 'accessor', 'work limit'] as const)(
  'bounded continuation preflight refuses %s before serialization or source invocation',
  async (variation) => {
    let calls = 0,
      getterReads = 0;
    const provider = defineDataProvider(
      source({
        async query() {
          calls++;
          return page(0, 'next');
        },
      }),
    );
    const first = await provider.query(query, { limit: 1 });
    const cursor = structuredClone(first.continuation) as unknown as {
      pins: Record<string, unknown>;
    };
    if (variation === 'cycle') cursor.pins['extra'] = cursor.pins;
    if (variation === 'accessor')
      Object.defineProperty(cursor.pins, 'datasetId', {
        enumerable: true,
        get() {
          getterReads++;
          return 'independent';
        },
      });
    if (variation === 'work limit') cursor.pins['extra'] = Array(1_000_001).fill(0);
    const before = calls;
    const { DataError } = await import('../src/errors.js');
    const pending = provider.query(query, { limit: 1, cursor: cursor as never });
    await expect(pending).rejects.toBeInstanceOf(DataError);
    await expect(pending).rejects.toMatchObject({ code: 'data.invalid_response' });
    expect(calls).toBe(before);
    expect(getterReads).toBe(0);
    expect(Object.isFrozen(cursor)).toBe(false);
    expect(Object.isFrozen(cursor.pins)).toBe(false);
  },
);

it('snapshots validated limit, query and nested continuation pins before asynchronous dispatch', async () => {
  const seen: unknown[] = [];
  const p = defineDataProvider(
    source({
      async query(q, controls) {
        seen.push({ q, controls });
        return page(controls.cursor ? 1 : 0, controls.cursor ? null : 'next');
      },
    }),
  );
  const mutableQuery = { ...query };
  const options = { limit: 1 };
  const pending = p.query(mutableQuery, options);
  options.limit = 100000;
  mutableQuery.to = '2026-01-02';
  const first = await pending;
  expect(seen[0]).toMatchObject({ q: query, controls: { limit: 1 } });
  expect(Object.isFrozen(options)).toBe(false);
  const cursor = JSON.parse(JSON.stringify(first.continuation));
  const second = p.query(query, { limit: 1, cursor });
  cursor.pins.datasetId = 'changed-after-validation';
  cursor.binding.query.to = '2026-01-02';
  await second;
  expect(seen[1]).toMatchObject({ q: query, controls: { pins: { datasetId: 'independent' } } });
  expect(Object.isFrozen(cursor.pins)).toBe(false);
});
it('rejects two rows against original limit1 despite a post-invocation options mutation', async () => {
  let received = 0;
  const p = defineDataProvider(
    source({
      async query(_q, controls) {
        received = controls.limit;
        return { ...page(0), data: [...page(0).data, ...page(1).data] };
      },
    }),
  );
  const options = { limit: 1 };
  const pending = p.query(query, options);
  options.limit = 100000;
  await expect(pending).rejects.toMatchObject({ code: 'data.invalid_response' });
  expect(received).toBe(1);
});

it.each([
  'input.wrong_type',
  'input.missing_field',
  'input.not_finite',
  'input.out_of_range',
  'input.invalid_enum',
])(
  'rebuilds a safe local input refusal %s with private cause and no provider text',
  async (code) => {
    const { InputError } = await import('../src/errors.js');
    const original = new InputError('SECRET URL payload', { code, context: { url: 'SECRET' } });
    const p = defineDataProvider(
      source({
        async query() {
          throw original;
        },
      }),
    );
    const e = await failureOf(() => p.query(query, { limit: 1 }));
    expect(e).toBeInstanceOf(InputError);
    expect(e).toMatchObject({ code, cause: original });
    expect(JSON.stringify(e)).not.toMatch(/SECRET|url|payload/);
  },
);

it('portable input refusal recognition never trusts unknown codes, inherited codes or getters', async () => {
  let reads = 0;
  const bad = [
    { code: 'input.made_up' },
    Object.create({ code: 'input.wrong_type' }),
    Object.defineProperty({}, 'code', {
      get() {
        reads++;
        return 'input.wrong_type';
      },
    }),
    Object.defineProperty({ code: 'input.wrong_type' }, 'context', {
      get() {
        reads++;
        return {};
      },
    }),
    {
      code: 'input.wrong_type',
      context: Object.defineProperty({}, 'secret', {
        enumerable: true,
        get() {
          reads++;
          return 'SECRET';
        },
      }),
    },
  ];
  for (const original of bad) {
    const p = defineDataProvider(
      source({
        async query() {
          throw original;
        },
      }),
    );
    const e = await failureOf(() => p.query(query, { limit: 1 }));
    expect(e).toMatchObject({ code: 'data.provider_failure' });
    expect(JSON.stringify(e)).not.toMatch(/SECRET|made_up/);
  }
  expect(reads).toBe(0);
});
