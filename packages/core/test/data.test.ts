import { describe, it, expect, vi } from 'vitest';
import { defineDataProvider, DATA_CONTRACT_VERSION, type DataProvider } from '../src/data.js';
import { ErrorCode, QuantError } from '../src/errors.js';
import { createFixtureDataProvider } from '../../../docs/examples/community-connector-fixture.js';
import {
  bar,
  chain,
  page,
  dailyRequest,
  barCapability,
} from '../../../docs/examples/community-connector-facts.js';
function raw(value = page()): DataProvider {
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
  it('binds without calling, copies/freezes output and preserves null and zero', async () => {
    const value = page();
    (value.data as unknown[]).push(bar());
    const source = raw(value);
    vi.spyOn(source, 'query');
    vi.spyOn(source, 'capabilities');
    const provider = defineDataProvider({ provider: source });
    expect(DATA_CONTRACT_VERSION).toBe(1);
    expect(source.query).not.toHaveBeenCalled();
    expect(source.capabilities).not.toHaveBeenCalled();
    const result = await provider.query({ request: dailyRequest });
    expect(result.data[0]?.bar.volume).toBe(0);
    expect(result.metadata.times.observedTimestampMs).toBeNull();
    expect(Object.isFrozen(result.data[0]?.bar)).toBe(true);
    expect(Object.isFrozen(value)).toBe(false);
    expect(result).not.toBe(value);
    expect(Object.isFrozen(await provider.capabilities({}))).toBe(true);
  });
  it.each([undefined, null, [], {}, 42])('first touch is typed for %j', (input) => {
    expect(() => defineDataProvider(input as never)).toThrow(QuantError);
  });
  it.each([
    { request: {} },
    { request: { ...dailyRequest, limt: 2 } },
    { request: { ...dailyRequest, limit: NaN } },
    { request: { ...dailyRequest, from: '2026-02-30' } },
    { request: { ...dailyRequest, to: '2026-10-25' } },
    { request: { ...dailyRequest, cursor: 'next' } },
    {
      request: {
        ...dailyRequest,
        interval: '1m',
        from: '2026-10-26T12:00:00',
        to: '2026-10-26T13:00:00',
      },
    },
  ])('rejects malformed request %j', async (input) => {
    await expect(
      defineDataProvider({ provider: raw() }).query(input as never),
    ).rejects.toBeInstanceOf(QuantError);
  });
  it('refuses unsupported kinds and version without a raw crash', async () => {
    await expect(
      defineDataProvider({ provider: raw() }).query({
        request: { ...dailyRequest, kind: 'account-read' } as never,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DataUnsupportedCapability });
    expect(() =>
      defineDataProvider({ provider: { ...raw(), contractVersion: 2 } as never }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.DataContractVersionUnsupported }));
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
    await expect(
      defineDataProvider({ provider: raw(value) }).query({ request: dailyRequest }),
    ).rejects.toMatchObject({ code: ErrorCode.DataInvalidResponse });
  });
  it('preserves incomplete research records without fabricating compute contracts', async () => {
    const value = page('option-chain-research');
    (value.data as unknown[]).push(chain());
    const result = await defineDataProvider({ provider: raw(value) }).query({
      request: {
        kind: 'option-chain-research',
        symbol: 'TEST',
        snapshot: { kind: 'latest' },
        limit: 2,
      },
    });
    expect(result.data[0]?.terms.multiplier).toBeNull();
    expect(result.data[0]?.quote.bid).toBe(0);
    expect(result.data[0]?.greeks).toBeNull();
  });
  it('does not mutate caller request and refuses provider mutation attempts', async () => {
    const source = raw();
    source.query = async ({ request }) => {
      (request as any).symbol = 'OTHER';
      return page() as never;
    };
    await expect(
      defineDataProvider({ provider: source }).query({ request: dailyRequest }),
    ).rejects.toMatchObject({ code: ErrorCode.DataInvalidResponse });
    expect(dailyRequest.symbol).toBe('TEST');
  });
  it('pre-abort performs no call and abort after provider return refuses late success', async () => {
    const controller = new AbortController();
    const source = raw();
    vi.spyOn(source, 'query');
    const provider = defineDataProvider({ provider: source });
    controller.abort();
    await expect(
      provider.query({ request: dailyRequest, signal: controller.signal }),
    ).rejects.toMatchObject({ code: ErrorCode.DataAborted });
    expect(source.query).not.toHaveBeenCalled();
    const later = new AbortController();
    source.query = async () => {
      later.abort();
      return page() as never;
    };
    await expect(
      defineDataProvider({ provider: source }).query({
        request: dailyRequest,
        signal: later.signal,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DataAborted });
  });
  it('fixture provider uses the public path and rejects unsupported intervals/bounds', async () => {
    const provider = createFixtureDataProvider({
      id: 'fixture',
      version: '0.0.0',
      capabilities: [{ ...barCapability, intervals: ['1d'], maxPageSize: 2 }],
      entries: [{ request: dailyRequest, page: page() }],
    });
    expect((await provider.query({ request: dailyRequest })).data).toEqual([]);
    await expect(
      provider.query({
        request: {
          ...dailyRequest,
          interval: '1m',
          from: '2026-10-26T00:00:00Z',
          to: '2026-10-26T01:00:00Z',
        },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.DataUnsupportedCapability });
    await expect(provider.query({ request: { ...dailyRequest, limit: 3 } })).rejects.toMatchObject({
      code: ErrorCode.InputOutOfRange,
    });
  });
});

it('provider structural state stays open while the wrapper config and consumed fields are checked', async () => {
  const source = { ...raw(), vendorState: { connection: 'synthetic' } };
  expect(defineDataProvider({ provider: source }).id).toBe('fixture');
  expect(() =>
    defineDataProvider({ provider: source, apiKey: 'not-a-core-field' } as never),
  ).toThrow(expect.objectContaining({ code: ErrorCode.InputUnknownField }));
  expect(() => defineDataProvider({ provider: { ...source, id: 42 } } as never)).toThrow(
    QuantError,
  );
});
