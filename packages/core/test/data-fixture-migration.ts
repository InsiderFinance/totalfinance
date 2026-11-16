import type { OptionChainResearchRecord } from '../src/data-types.js';
/** Test-only migration of the immutable C1-C4 financial fixtures. No public protocol1 live alias.
 * Old canonical observations remain independent truth facts; requests use the actual protocol2 door.
 */
import { defineDataProvider as bind } from '../src/data.js';
import { pageData, providerShape } from '../src/data-validation.js';
import { DataError, ErrorCode } from '../src/errors.js';
import type {
  DataProvider,
  DataContinuation,
  DataProviderSource,
  SourcePriceBarsPage,
  SourceOptionChainPage,
} from '../src/data-types.js';
import type { DataRequest } from '../src/data-legacy-types.js';
export interface CanonicalFixtureSource {
  id: string;
  version: string;
  contractVersion: number;
  capabilities(options?: { signal?: AbortSignal }): Promise<any>;
  query(request: DataRequest, options?: { signal?: AbortSignal }): Promise<any>;
}
const sources = new WeakMap<object, DataProviderSource>();
const consumers = new WeakMap<object, DataProvider>();
const continuations = new WeakMap<object, DataContinuation>();
export function rawFacts(p: any, request?: any): SourcePriceBarsPage | SourceOptionChainPage {
  // Deliberately validate the ORIGINAL old canonical fixture before translating mechanical fields.
  // This retains original duplicate-envelope and v1 strict-shape regression coverage, rather than
  // quietly erasing an invalid fixture during migration.
  pageData(p, request);
  const original: any = p;
  const m = original.metadata;
  const facts = {
    dataset: { id: m.datasetId, version: m.datasetVersion },
    receivedTimestampMs: m.receivedTimestampMs,
    adjustment: m.adjustment,
    consistency: m.consistency,
    snapshotId: m.snapshotId,
    sessionDate: m.sessionDate,
    sourceGeneratedTimestampMs: m.sourceGeneratedTimestampMs,
    times: m.times,
    freshness: m.freshness,
    coverage: m.coverage,
    quality: m.quality,
    access: m.access,
    ...(p.provenance.requestId ? { requestId: p.provenance.requestId } : {}),
  };
  if (p.kind === 'price-bars')
    return {
      data: p.data.map((r: any) => {
        const { symbol: _symbol, ...bar } = r.bar;
        return {
          bar,
          sessionDate: r.sessionDate,
          times: r.times,
          source: r.source,
          provisional: r.provisional,
          revision: r.revision,
          diagnostics: r.diagnostics,
        };
      }),
      nextCursor: p.nextCursor,
      facts: {
        ...facts,
        timestampConvention:
          (p.data[0] as any)?.timestampConvention ?? 'session-label-midnight-utc',
      },
      diagnostics: p.diagnostics,
    };
  return {
    data: p.data as readonly OptionChainResearchRecord[],
    nextCursor: p.nextCursor,
    facts,
    diagnostics: p.diagnostics,
  };
}
export function fixtureSource(old: CanonicalFixtureSource): DataProviderSource {
  return {
    protocol: 'totalfinance-data-source',
    contractVersion: (old.contractVersion === 1 ? 2 : old.contractVersion) as 2,
    id: old.id,
    version: old.version,
    async capabilities(options) {
      const c = await old.capabilities(options);
      if (
        Object.keys(c).some(
          (k) => !['contractVersion', 'providerId', 'providerVersion', 'capabilities'].includes(k),
        )
      )
        return c;
      return c.capabilities.map((x: any) => ({
        ...x,
        consistency: Array.isArray(x.consistency) ? x.consistency : [x.consistency],
      }));
    },
    async query(q, o) {
      const request = o.cursor
        ? { kind: q.kind, symbol: q.symbol, cursor: o.cursor, limit: o.limit }
        : { ...q, limit: o.limit };
      return rawFacts(
        await old.query(
          Object.freeze(request) as DataRequest,
          o.signal ? { signal: o.signal } : undefined,
        ),
        request,
      );
    },
  };
}
export function defineFixtureProvider(old: CanonicalFixtureSource): DataProvider {
  providerShape(old);
  const source = fixtureSource(old),
    p = bind(source);
  sources.set(p, source);
  return p;
}
export function fixtureSourceOf(value: any): DataProviderSource {
  return sources.get(value) ?? value;
}

export async function queryFixture(provider: any, input: any, options?: any): Promise<any> {
  if (provider?.protocol === 'totalfinance-data-source') {
    let p = consumers.get(provider);
    if (!p) {
      p = bind(provider);
      consumers.set(provider, p);
    }
    provider = p;
  }
  if (!input || typeof input !== 'object' || !('limit' in input))
    return provider.query(input, options);
  const { limit, cursor, ...query } = input;
  if (
    options !== undefined &&
    (options === null || typeof options !== 'object' || Array.isArray(options))
  )
    return provider.query(query, options);
  if (cursor !== undefined) {
    const prior = continuations.get(provider);
    if (!prior)
      throw new DataError('query: continuation context is required.', {
        code: ErrorCode.DataInvalidCursor,
      });
    const result = await provider.query(
      { ...prior.binding.query, kind: input.kind, symbol: input.symbol },
      { limit, ...options, cursor: { ...prior, cursor } },
    );
    if (result.continuation) continuations.set(provider, result.continuation);
    return result;
  }
  const result = await provider.query(query, options === null ? null : { limit, ...options });
  if (result.continuation) continuations.set(provider, result.continuation);
  return result;
}
/** Independent expected financial observations, with explicit mechanical protocol2 facts. */
export function expectedPage(p: any, input: any, version = '0.0.0'): any {
  const { limit: _limit, cursor: _cursor, ...query } = input;
  return {
    ...p,
    contractVersion: 2,
    binding: { provider: { id: p.provenance.provider, version }, query },
    issues: [],
    ...(p.kind === 'price-bars'
      ? {
          timestampConvention:
            (p.data[0] as any)?.timestampConvention ??
            (query.interval === '1m' ? 'interval-start' : 'session-label-midnight-utc'),
        }
      : {}),
  };
}
export function fixtureEntries(entries: readonly any[]): any[] {
  let original: any;
  return entries.map((e) => {
    const { limit: _limit, cursor, ...q } = e.request;
    if (cursor === undefined) original = q;
    return {
      query: cursor === undefined ? q : { ...original, kind: q.kind, symbol: q.symbol },
      cursor: cursor ?? null,
      page: rawFacts(e.page),
    };
  });
}

export function fixtureProbe(p: any): any {
  const { limit, ...q } = p.request;
  return {
    ...p,
    request: q,
    pageSize: limit,
    expectedPages: p.expectedPages.map((page: any) => expectedPage(page, q)),
  };
}
