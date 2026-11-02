import { describe, it, expect, vi } from 'vitest';
import { defineDataProvider, DATA_CONTRACT_VERSION, type DataProviderSource } from '../src/data.js';
import { ErrorCode, QuantError } from '../src/errors.js';
import { createFixtureDataProvider } from '../../../docs/examples/community-connector-fixture.js';
import {
  bar,
  chain,
  page,
  dailyRequest,
  barCapability,
} from '../../../docs/examples/community-connector-facts.js';
function raw(value = page()): DataProviderSource {
  return {
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
    async query() {
      return value as never;
    },
  };
}
describe('community data contract', () => {
  it('binds a direct source without calling it and preserves immutable raw facts', async () => {
    const value = page();
    (value.data as unknown[]).push(bar());
    const source = raw(value);
    vi.spyOn(source, 'query');
    vi.spyOn(source, 'capabilities');
    const provider = defineDataProvider(source);
    expect(DATA_CONTRACT_VERSION).toBe(1);
    expect(source.query).not.toHaveBeenCalled();
    expect(source.capabilities).not.toHaveBeenCalled();
    const result = await provider.query(dailyRequest);
    expect(result.page.data[0]?.bar.volume).toBe(0);
    expect(result.page.metadata.times.observedTimestampMs).toBeNull();
    expect(Object.isFrozen(result.page.data[0]?.bar)).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
    expect(result.page).not.toBe(value);
    expect(Object.isFrozen(await provider.capabilities())).toBe(true);
  });
  it.each([undefined, null, [], {}, 42])('first touch is typed for %j', (input) => {
    expect(() => defineDataProvider(input as never)).toThrow(QuantError);
  });
  it.each([
    {},
    { ...dailyRequest, limt: 2 },
    { ...dailyRequest, limit: NaN },
    { ...dailyRequest, from: '2026-02-30' },
    { ...dailyRequest, to: '2026-10-25' },
    { ...dailyRequest, cursor: 'next' },
    { ...dailyRequest, interval: '1m', from: '2026-10-26T12:00:00', to: '2026-10-26T13:00:00' },
  ])('rejects malformed direct request %j', async (input) => {
    await expect(defineDataProvider(raw()).query(input as never)).rejects.toBeInstanceOf(
      QuantError,
    );
  });
  it('refuses unsupported kinds and versions', async () => {
    await expect(
      defineDataProvider(raw()).query({ ...dailyRequest, kind: 'account-read' } as never),
    ).rejects.toMatchObject({ code: ErrorCode.DataUnsupportedCapability });
    expect(() => defineDataProvider({ ...raw(), contractVersion: 2 } as never)).toThrow(
      expect.objectContaining({ code: ErrorCode.DataContractVersionUnsupported }),
    );
  });
  it.each([
    (p: ReturnType<typeof page>) => {
      (p.data as unknown[]).push({ ...bar(), bar: { ...bar().bar, close: NaN } });
    },
    (p: ReturnType<typeof page>) => {
      (p.data as unknown[]).push(bar('2026-10-27'), bar('2026-10-26'));
    },
    (p: ReturnType<typeof page>) => {
      (p.data as unknown[]).push(bar(), bar());
    },
    (p: ReturnType<typeof page>) => {
      (p.metadata as any).executionEligibility = 'live';
    },
    (p: ReturnType<typeof page>) => {
      (p.metadata.times as any).availableTimestampMs = undefined;
    },
    (p: ReturnType<typeof page>) => {
      (p.metadata.times as any).observedTimestampMs = 10;
      (p.metadata.times as any).availableTimestampMs = 9;
    },
    (p: ReturnType<typeof page>) => {
      (p as any).symbol = 'OTHER';
    },
    (p: ReturnType<typeof page>) => {
      (p as any).nextCursor = 'again';
    },
    (p: ReturnType<typeof page>) => {
      (p.metadata.quality as any).status = 'perfect';
    },
  ])('refuses a malformed provider page', async (mutate) => {
    const value = page();
    mutate(value);
    await expect(defineDataProvider(raw(value)).query(dailyRequest)).rejects.toMatchObject({
      code: ErrorCode.DataInvalidResponse,
    });
  });

  it('retains incomplete chain research without invented terms', async () => {
    const value = page('option-chain-research');
    (value.data as unknown[]).push(chain());
    const result = await defineDataProvider(raw(value)).query({
      kind: 'option-chain-research',
      symbol: 'TEST',
      snapshot: { kind: 'latest' },
      limit: 2,
    });
    expect(result.page.data[0]?.terms.multiplier).toBeNull();
    expect(result.page.data[0]?.quote.bid).toBe(0);
    expect(result.page.data[0]?.greeks).toBeNull();
    expect(Object.keys(result)).toEqual(['kind', 'page']);
  });
  it('protects the caller request and refuses raw-source mutation', async () => {
    const source = raw();
    source.query = async (request) => {
      (request as any).symbol = 'OTHER';
      return page() as never;
    };
    await expect(defineDataProvider(source).query(dailyRequest)).rejects.toMatchObject({
      code: ErrorCode.DataInvalidResponse,
    });
    expect(dailyRequest.symbol).toBe('TEST');
  });
  it('pre-abort does no call and cancellation before return refuses late success', async () => {
    const pre = new AbortController();
    const source = raw();
    vi.spyOn(source, 'query');
    const provider = defineDataProvider(source);
    pre.abort();
    await expect(provider.query(dailyRequest, { signal: pre.signal })).rejects.toMatchObject({
      code: ErrorCode.DataAborted,
    });
    expect(source.query).not.toHaveBeenCalled();
    const later = new AbortController();
    source.query = async () => {
      later.abort();
      return page() as never;
    };
    await expect(
      defineDataProvider(source).query(dailyRequest, { signal: later.signal }),
    ).rejects.toMatchObject({ code: ErrorCode.DataAborted });
  });
  it('migrates public fixture query/discovery and narrower capability bounds', async () => {
    const provider = createFixtureDataProvider({
      id: 'fixture',
      version: '0.0.0',
      capabilities: [{ ...barCapability, intervals: ['1d'], maxPageSize: 2 }],
      entries: [{ request: dailyRequest, page: page() }],
    });
    expect((await provider.query(dailyRequest)).page.data).toEqual([]);
    await expect(
      provider.query({
        ...dailyRequest,
        interval: '1m',
        from: '2026-10-26T00:00:00Z',
        to: '2026-10-26T01:00:00Z',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DataUnsupportedCapability });
    await expect(provider.query({ ...dailyRequest, limit: 3 })).rejects.toMatchObject({
      code: ErrorCode.InputOutOfRange,
    });
  });
  it('teaches removed envelopes and invalid optional controls without aliases', async () => {
    expect(() => defineDataProvider({ provider: raw() } as never)).toThrow(QuantError);
    const provider = defineDataProvider(raw());
    await expect(provider.query({ request: dailyRequest } as never)).rejects.toBeInstanceOf(
      QuantError,
    );
    for (const options of [null, 42, [], { singal: true }, { signal: null }]) {
      await expect(provider.query(dailyRequest, options as never)).rejects.toBeInstanceOf(
        QuantError,
      );
      await expect(provider.capabilities(options as never)).rejects.toBeInstanceOf(QuantError);
    }
    await expect(provider.capabilities(undefined)).resolves.toMatchObject({ contractVersion: 1 });
  });
});
it('allows raw source-owned structural state without changing consumed fields', () => {
  const source = { ...raw(), vendorState: { connection: 'synthetic' } };
  expect(defineDataProvider(source).id).toBe('fixture');
  expect(() => defineDataProvider({ ...source, id: 42 } as never)).toThrow(QuantError);
});
