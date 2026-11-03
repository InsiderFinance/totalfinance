import { describe, it, expect } from 'vitest';
import { connect, createPriceBarsWindowView, defineDataProvider } from '../src/data.js';
import { sma } from '../../technical-analysis/src/overlap.js';
import { vwap } from '../../technical-analysis/src/bars.js';
import { bar, page, barCapability } from '../../../docs/examples/community-connector-facts.js';

const request = { symbol: 'TEST', interval: '1d' as const, from: '2026-10-26', to: '2026-10-28' };
function facts() {
  const a: any = page(),
    b: any = page();
  a.data = [bar('2026-10-26', 100), bar('2026-10-27', 101)];
  b.data = [bar('2026-10-28', 102)];
  a.nextCursor = 'second';
  return [a, b];
}
function fixture(pages = facts(), extra: Record<string, unknown> = {}) {
  const calls: any[] = [];
  let discovery = 0;
  const provider = defineDataProvider({
    id: 'fixture',
    version: '0.0.0',
    contractVersion: 1,
    async capabilities() {
      discovery++;
      return {
        contractVersion: 1,
        providerId: 'fixture',
        providerVersion: '0.0.0',
        capabilities: [barCapability],
      };
    },
    async query(r) {
      calls.push(r);
      return pages['cursor' in r ? 1 : 0];
    },
  });
  return {
    provider: { ...provider, ...extra } as typeof provider,
    calls,
    discovery: () => discovery,
  };
}
describe('connected research windows', () => {
  it('binds without reads and completes two pages before existing SMA', async () => {
    const f = fixture();
    const data = connect(f.provider, { pageSize: 2 });
    expect(f.calls).toHaveLength(0);
    expect(f.discovery()).toBe(0);
    const prices = await data.priceBars(request);
    expect(prices.closePrices).toEqual([100, 101, 102]);
    expect(sma(prices.closePrices, { period: 2 }).at(-1)).toBe(101.5);
    expect(prices.window.pages).toEqual(facts());
    expect(f.calls).toEqual([
      { ...request, kind: 'price-bars', limit: 2 },
      { kind: 'price-bars', symbol: 'TEST', cursor: 'second', limit: 2 },
    ]);
    expect(f.discovery()).toBe(1);
    expect(sma.explain(prices.closePrices, { period: 2 })).toEqual(
      sma.explain([100, 101, 102], { period: 2 }),
    );
    expect(vwap(prices.ohlcvBars)).toEqual(vwap(prices.ohlcvBars.map((x) => ({ ...x }))));
  });
  it('refuses a nonterminal window at its page budget without another read', async () => {
    const f = fixture();
    await expect(connect(f.provider, { maxPages: 1 }).priceBars(request)).rejects.toMatchObject({
      code: 'data.window_budget_exceeded',
      context: { limit: 'maxPages', pageCalls: 1 },
    });
    expect(f.calls).toHaveLength(1);
  });
  it('preserves canonical source facts through restoration', async () => {
    const f = fixture();
    const prices = await connect(f.provider).priceBars(request);
    const restored = createPriceBarsWindowView(JSON.parse(JSON.stringify(prices.window)));
    expect(restored.window).toEqual(prices.window);
    expect(restored.closePrices).toEqual(prices.closePrices);
    expect(Object.keys(prices)).toEqual(['kind', 'window']);
  });
});

import { copyFrozen } from '../src/data-validation.js';
import { DataError, ErrorCode } from '../src/errors.js';
const invalid = { code: 'data.invalid_response' };
function changedSelector(provider: any, key: string, get: () => unknown): any {
  return {
    ...provider,
    async query(r: any, o: any) {
      const view = await provider.query(r, o),
        descriptors = Object.getOwnPropertyDescriptors(view);
      descriptors[key] = { get, enumerable: false, configurable: false };
      return Object.freeze(Object.defineProperties({}, descriptors));
    },
  };
}
describe('window bounds and independent response mutants', () => {
  for (const [name, mutate] of [
    [
      'late original-date escape',
      (p: any[]) => {
        p[1].data = [bar('2026-10-29')];
      },
    ],
    [
      'duplicate key',
      (p: any[]) => {
        p[1].data = [bar('2026-10-27')];
      },
    ],
    [
      'reverse key',
      (p: any[]) => {
        p[1].data = [bar('2026-10-26')];
      },
    ],
    [
      'dataset switch',
      (p: any[]) => {
        p[1].metadata.datasetId = 'other';
        p[1].provenance.dataset = 'other';
      },
    ],
    [
      'dataset revision',
      (p: any[]) => {
        p[1].metadata.datasetVersion = '2';
        p[1].provenance.sourceVersion = '2';
      },
    ],
    [
      'snapshot switch',
      (p: any[]) => {
        p[1].metadata.snapshotId = 'new';
      },
    ],
    [
      'session pin switch',
      (p: any[]) => {
        p[1].metadata.sessionDate = '2026-10-28';
      },
    ],
    [
      'adjustment switch',
      (p: any[]) => {
        p[1].metadata.adjustment = 'unadjusted';
      },
    ],
    [
      'row adjustment switch',
      (p: any[]) => {
        p[1].data[0].bar.adjusted = false;
      },
    ],
    [
      'unknown adjustment switch',
      (p: any[]) => {
        delete p[1].data[0].bar.adjusted;
      },
    ],
    [
      'cursor cycle',
      (p: any[]) => {
        p[1].nextCursor = 'second';
      },
    ],
    [
      'wrong interval convention',
      (p: any[]) => {
        p[1].data[0].timestampConvention = 'interval-start';
        p[1].data[0].sessionDate = null;
      },
    ],
  ] as const)
    it('refuses ' + name, async () => {
      const pages = facts();
      mutate(pages);
      const f = fixture(pages);
      await expect(connect(f.provider, { pageSize: 2 }).priceBars(request)).rejects.toMatchObject(
        invalid,
      );
      expect(f.calls).toHaveLength(2);
    });
  it('keeps completed sample gaps and varied receipt/time/quality facts exactly', async () => {
    const pages = facts();
    pages[0].data = [bar('2026-10-26', 100)];
    pages[1].metadata.receivedTimestampMs++;
    pages[1].provenance.receivedAt++;
    pages[1].metadata.quality.status = 'partial';
    pages[1].metadata.quality.issues = [
      { source: 'fixture', code: 'gap', message: 'Synthetic gap' },
    ];
    const f = fixture(pages);
    const p = await connect(f.provider).priceBars(request);
    expect(p.window.pages).toEqual(pages);
    expect(p.closePrices).toEqual([100, 102]);
    expect(p.window.pagination.status).toBe('terminal');
    expect(p.window.pages[0]!.metadata.coverage.status).toBe('unknown');
  });
  it('validates minute original bounds on a continuation without interpreting its cursor', async () => {
    const pages = facts();
    for (const p of pages)
      for (const r of p.data) {
        r.timestampConvention = 'interval-start';
        r.sessionDate = null;
      }
    const f = fixture(pages);
    await expect(
      connect(f.provider).priceBars({
        ...request,
        interval: '1m',
        from: '2026-10-26T00:00:00Z',
        to: '2026-10-27T00:00:00Z',
      }),
    ).rejects.toMatchObject(invalid);
  });
  it('refuses raw-source response shape instead of guessing a page/view union', async () => {
    const f = fixture();
    const provider = { ...f.provider, query: async () => copyFrozen(facts()[0]) } as any;
    await expect(
      connect(provider).query({ ...request, kind: 'price-bars', limit: 2 }),
    ).rejects.toMatchObject(invalid);
  });
  it('never invokes an accessor source property', async () => {
    const f = fixture();
    let calls = 0;
    const bad = {
      ...f.provider,
      query: async () =>
        Object.freeze(
          Object.defineProperties(
            { kind: 'price-bars' },
            {
              page: {
                enumerable: true,
                get() {
                  calls++;
                  return facts()[0];
                },
              },
            },
          ),
        ),
    } as any;
    await expect(connect(bad).priceBars(request)).rejects.toMatchObject(invalid);
    expect(calls).toBe(0);
  });
});
describe('metering and explicit controls', () => {
  it('sends the defaults and no implicit date/financial inputs', async () => {
    const f = fixture([page()]);
    await connect(f.provider).priceBars(request);
    expect(f.calls).toEqual([{ ...request, kind: 'price-bars', limit: 1000 }]);
    expect(f.discovery()).toBe(1);
  });
  it('clamps only an omitted pageSize to declared support', async () => {
    const f = fixture([page()]);
    const capabilities = async () => ({
      contractVersion: 1,
      providerId: 'fixture',
      providerVersion: '0.0.0',
      capabilities: [{ ...barCapability, maxPageSize: 3 }],
    });
    const p = connect({ ...f.provider, capabilities } as any);
    await p.priceBars(request);
    expect(f.calls[0].limit).toBe(3);
    await expect(p.priceBars(request, { pageSize: 4 })).rejects.toMatchObject({
      code: 'input.out_of_range',
    });
  });
  it('shrinks the continuation limit to remaining records; terminal exactly at both ceilings succeeds', async () => {
    const f = fixture();
    const p = await connect(f.provider, { pageSize: 2, maxPages: 2, maxRecords: 3 }).priceBars(
      request,
    );
    expect(p.window.pagination).toEqual({
      status: 'terminal',
      pageSize: 2,
      pageCalls: 2,
      records: 3,
    });
    expect(f.calls[1].limit).toBe(1);
  });
  it('refuses nonterminal records ceiling without another query', async () => {
    const f = fixture();
    await expect(
      connect(f.provider, { pageSize: 2, maxRecords: 2 }).priceBars(request),
    ).rejects.toMatchObject({
      code: 'data.window_budget_exceeded',
      context: { limit: 'maxRecords', records: 2 },
    });
    expect(f.calls).toHaveLength(1);
  });
  it('deterministically names page ceiling when both bind and leaks no cursor', async () => {
    const f = fixture();
    let caught: any;
    try {
      await connect(f.provider, { pageSize: 2, maxPages: 1, maxRecords: 2 }).priceBars(request);
    } catch (e) {
      caught = e;
    }
    expect(caught.context.limit).toBe('maxPages');
    expect(JSON.stringify(caught)).not.toContain('second');
  });
  for (const [name, options] of [
    ['zero', { maxPages: 0 }],
    ['null', null],
    ['unknown', { extra: 1 }],
    ['fraction', { maxRecords: 2.5 }],
    ['nonfinite', { pageSize: Infinity }],
    ['too many', { maxPages: 101 }],
  ] as const)
    it('refuses ' + name + ' connection controls before reads', () => {
      const f = fixture();
      expect(() => connect(f.provider, options as any)).toThrow();
      expect(f.calls).toHaveLength(0);
      expect(f.discovery()).toBe(0);
    });
  it('allows lower-only per-call ceilings and refuses raises before discovery', async () => {
    const f = fixture();
    const p = connect(f.provider, { maxPages: 1 });
    await expect(p.priceBars(request, { maxPages: 2 })).rejects.toMatchObject({
      code: 'input.out_of_range',
    });
    expect(f.discovery()).toBe(0);
  });
  it('keeps manual query exactly one page and zero-discovery', async () => {
    const f = fixture();
    const p = await connect(f.provider).query({ ...request, kind: 'price-bars', limit: 2 });
    expect(p.page.nextCursor).toBe('second');
    expect(f.calls).toHaveLength(1);
    expect(f.discovery()).toBe(0);
  });
  it('refuses denied entitlement before acquisition', async () => {
    const f = fixture();
    const capabilities = async () => ({
      contractVersion: 1,
      providerId: 'fixture',
      providerVersion: '0.0.0',
      capabilities: [{ ...barCapability, access: 'denied' }],
    });
    await expect(
      connect({ ...f.provider, capabilities } as any).priceBars(request),
    ).rejects.toMatchObject({ code: 'data.entitlement_required' });
    expect(f.calls).toHaveLength(0);
  });
  it('refuses unsupported interval before acquisition', async () => {
    const f = fixture();
    const capabilities = async () => ({
      contractVersion: 1,
      providerId: 'fixture',
      providerVersion: '0.0.0',
      capabilities: [],
    });
    await expect(
      connect({ ...f.provider, capabilities } as any).priceBars(request),
    ).rejects.toMatchObject({ code: 'data.unsupported_capability' });
    expect(f.calls).toHaveLength(0);
  });
});
describe('source selectors stay lazy, strict and honest', () => {
  for (const row of [0, 2])
    it('keeps closes usable when volume is missing at ' + row, async () => {
      const pages = facts();
      delete (row === 2 ? pages[1].data[0] : pages[0].data[row]).bar.volume;
      pages[0].metadata.quality.status = 'partial';
      const f = fixture(pages);
      const p = await connect(f.provider).priceBars(request);
      expect(p.closePrices).toEqual([100, 101, 102]);
      expect(() => p.ohlcvBars).toThrowError(
        expect.objectContaining({
          code: 'input.missing_field',
          context: {
            field: 'volume',
            pageIndex: row === 2 ? 1 : 0,
            rowIndex: row === 2 ? 0 : row,
            index: row,
          },
        }),
      );
      expect(() => JSON.stringify(p)).not.toThrow();
      expect(f.calls).toHaveLength(2);
    });
  for (const mode of ['query', 'window'])
    it('delegates and refutes a lying close selector through ' + mode, async () => {
      const f = fixture();
      let calls = 0;
      const provider = changedSelector(f.provider, 'closePrices', () => {
        calls++;
        return Object.freeze([0, 0]);
      });
      const p = connect(provider);
      const result =
        mode === 'query'
          ? await p.query({ ...request, kind: 'price-bars', limit: 2 })
          : await p.priceBars(request);
      expect(calls).toBe(0);
      expect(() => result.closePrices).toThrowError(expect.objectContaining(invalid));
      expect(calls).toBeGreaterThan(0);
    });
  it('does not require OHLCV merely to acquire or serialize', async () => {
    const f = fixture();
    let calls = 0;
    const provider = changedSelector(f.provider, 'ohlcvBars', () => {
      calls++;
      throw Error('do not read me');
    });
    const p = await connect(provider).priceBars(request);
    expect(() => JSON.stringify(p)).not.toThrow();
    expect(p.closePrices).toEqual([100, 101, 102]);
    expect(calls).toBe(0);
    expect(() => p.ohlcvBars).toThrow();
  });
  it('produces cached ordinary frozen arrays and strict OHLCV objects', async () => {
    const p = await connect(fixture().provider).priceBars(request);
    expect(Object.getPrototypeOf(p.closePrices)).toBe(Array.prototype);
    expect(Object.isFrozen(p.closePrices)).toBe(true);
    expect(p.closePrices).toBe(p.closePrices);
    expect(Object.isFrozen(p.ohlcvBars[0])).toBe(true);
    expect(p.ohlcvBars[0]!.volume).toBe(0);
    expect(() => {
      (p.closePrices as number[])[0] = 7;
    }).toThrow();
  });
  for (const [name, mutate] of [
    ['record count', (w: any) => w.pagination.records++],
    ['page calls', (w: any) => w.pagination.pageCalls++],
    ['premature terminal', (w: any) => (w.pages[0].nextCursor = null)],
    ['unfinished', (w: any) => (w.pages[1].nextCursor = 'more')],
    ['version', (w: any) => (w.version = 2)],
    ['storage keys', (w: any) => (w.key = 'secret')],
    ['out of bounds', (w: any) => (w.request.to = '2026-10-27')],
  ] as const)
    it('refuses stored ' + name, async () => {
      const p = await connect(fixture().provider).priceBars(request);
      const w = structuredClone(p.window);
      mutate(w);
      expect(() => createPriceBarsWindowView(w)).toThrow();
    });
  it('returns terminal empty arrays without fabricating activity/history', async () => {
    const p = await connect(fixture([page()]).provider).priceBars(request);
    expect(p.closePrices).toEqual([]);
    expect(p.ohlcvBars).toEqual([]);
    expect(p.window.pages).toHaveLength(1);
  });
});
describe('cancellation and safe failures', () => {
  it('pre-abort makes no calls', async () => {
    const f = fixture();
    const c = new AbortController();
    c.abort();
    await expect(
      connect(f.provider).priceBars(request, { signal: c.signal }),
    ).rejects.toMatchObject({ code: 'data.aborted' });
    expect(f.discovery()).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
  it('cancels an ignoring provider while active and observes late rejection', async () => {
    const f = fixture();
    let started!: () => void, reject!: (e: Error) => void;
    const ready = new Promise<void>((r) => (started = r));
    const controller = new AbortController();
    const provider = {
      ...f.provider,
      query: async () => {
        started();
        return await new Promise((_, r) => {
          reject = r;
        });
      },
    } as any;
    const result = connect(provider).priceBars(request, { signal: controller.signal });
    await ready;
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'data.aborted' });
    reject(Error('late secret'));
  });
  it('does not continue after cancellation while the first body resolves', async () => {
    const f = fixture();
    const controller = new AbortController();
    const original = f.provider.query;
    const provider = {
      ...f.provider,
      query: async (...args: any[]) => {
        const v = await (original as any)(...args);
        controller.abort();
        return v;
      },
    };
    await expect(
      connect(provider as any).priceBars(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'data.aborted' });
    expect(f.calls).toHaveLength(1);
  });
  it('redacts arbitrary provider failures', async () => {
    const f = fixture();
    const p = connect({
      ...f.provider,
      query: async () => {
        throw Error('secret key cursor');
      },
    } as any);
    await expect(p.priceBars(request)).rejects.toMatchObject(invalid);
    try {
      await p.priceBars(request);
    } catch (error) {
      expect(JSON.stringify(error)).not.toMatch(/secret|cursor/);
    }
  });
  it('preserves typed allowance refusal without retry', async () => {
    const f = fixture();
    let calls = 0;
    const p = connect({
      ...f.provider,
      query: async () => {
        calls++;
        throw new DataError('synthetic allowance', { code: ErrorCode.DataAllowanceExhausted });
      },
    } as any);
    await expect(p.priceBars(request)).rejects.toMatchObject({ code: 'data.allowance_exhausted' });
    expect(calls).toBe(1);
  });
});

import { validateDataProvider } from '../src/data-conformance.js';
it('the same independent compatibility kit accepts the connected one-page protocol', async () => {
  const pages = facts(),
    f = fixture(pages);
  await validateDataProvider({
    provider: connect(f.provider),
    probes: [
      {
        name: 'retained fixture',
        kind: 'pages',
        request: { ...request, kind: 'price-bars', limit: 2 },
        expectedPages: pages,
      },
    ],
    maxPages: 2,
    maxRecords: 3,
    timeoutMs: 1000,
  });
});

it('window VWAP equals the existing engine on independent literal OHLCV facts', async () => {
  const pages = facts();
  pages[0].data[0].bar.volume = 1;
  pages[0].data[1].bar.volume = 2;
  pages[1].data[0].bar.volume = 3;
  const prices = await connect(fixture(pages).provider).priceBars(request);
  const expected = [
    { open: 100, high: 102, low: 99, close: 100, volume: 1 },
    { open: 100, high: 102, low: 99, close: 101, volume: 2 },
    { open: 100, high: 102, low: 99, close: 102, volume: 3 },
  ];
  expect(prices.ohlcvBars).toEqual(expected);
  expect(vwap(prices.ohlcvBars)).toEqual(vwap(expected));
});

it('JS invalid-date teaching names priceBars before invoking a provider', async () => {
  const f = fixture();
  await expect(connect(f.provider).priceBars({ ...request, from: 'bad' })).rejects.toMatchObject({
    code: 'input.wrong_type',
    message: expect.stringMatching(/^priceBars: request.from/),
    context: { field: 'request.from' },
  });
  expect(f.discovery()).toBe(0);
  expect(f.calls).toHaveLength(0);
});

it('restores a bounded 40000-row minute window without applying one-page scan work to the aggregate', async () => {
  const start = Date.parse('2026-10-01T00:00:00Z');
  const pages = Array.from({ length: 20 }, (_, part) => {
    const p: any = page();
    p.nextCursor = part === 19 ? null : `page-${part + 1}`;
    p.data = Array.from({ length: 2000 }, (_, i) => {
      const r = bar();
      return {
        ...r,
        bar: { ...r.bar, timestampMs: start + (part * 2000 + i) * 60000 },
        timestampConvention: 'interval-start' as const,
        sessionDate: null,
      };
    });
    return p;
  });
  const provider = defineDataProvider({
    id: 'fixture',
    version: '0.0.0',
    contractVersion: 1,
    async capabilities() {
      return {
        contractVersion: 1,
        providerId: 'fixture',
        providerVersion: '0.0.0',
        capabilities: [barCapability],
      };
    },
    async query(r) {
      return pages['cursor' in r ? Number(r.cursor.slice(5)) : 0];
    },
  });
  const prices = await connect(provider, {
    pageSize: 2000,
    maxPages: 20,
    maxRecords: 40000,
  }).priceBars({
    symbol: 'TEST',
    interval: '1m',
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-29T00:00:00Z',
  });
  expect(prices.closePrices).toHaveLength(40000);
  expect(createPriceBarsWindowView(prices.window).closePrices).toEqual(prices.closePrices);
}, 30000);
