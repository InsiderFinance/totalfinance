/** Migrated copy of the independently authored public synthetic Alpaca-style adapter.
 * Original reviewer artifacts stay unchanged. This package uses public SDK imports only.
 */
import type {
  DataProviderSource,
  DataQuery,
  DataPageOptions,
  SourcePriceBarsPage,
} from '@insiderfinance/totalfinance/core/data';
import { DataProviderError } from '@insiderfinance/totalfinance/core/data';
import { ErrorCode, DataError } from '@insiderfinance/totalfinance/core';
import type { VendorResponse } from './vendor.js';
export function createAcmeProvider(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): DataProviderSource {
  return {
    protocol: 'totalfinance-data-source',
    contractVersion: 2,
    id: 'acme',
    version: '0.1.0',
    async capabilities() {
      return [
        {
          kind: 'price-bars',
          intervals: ['1m', '5m', '15m', '30m', '1h', '1d', '1s'],
          maxPageSize: 10000,
          consistency: ['best-effort'],
          pointInTime: false,
          access: 'unknown',
        },
      ];
    },
    async query(query: DataQuery, page: DataPageOptions): Promise<SourcePriceBarsPage> {
      if (query.kind !== 'price-bars')
        throw new DataProviderError({ code: ErrorCode.DataUnsupportedCapability });
      const frames: { [key: string]: string | undefined } = {
        '1m': '1Min',
        '5m': '5Min',
        '15m': '15Min',
        '30m': '30Min',
        '1h': '1Hour',
        '1d': '1Day',
      };
      const frame = frames[query.interval];
      if (!frame)
        throw new DataProviderError({
          code: ErrorCode.DataUnsupportedCapability,
          guidance: { field: 'request.interval', rule: 'unsupported_interval' },
        });
      if (!/^[A-Z][A-Z0-9.]*$/.test(query.symbol))
        throw new DataProviderError({
          code: ErrorCode.DataInvalidRequest,
          guidance: { field: 'request.symbol', rule: 'uppercase_symbol' },
        });
      const url = new URL(
        `https://data.acme.test/v2/stocks/${encodeURIComponent(query.symbol)}/bars`,
      );
      url.searchParams.set('timeframe', frame);
      url.searchParams.set('start', query.from);
      url.searchParams.set('end', query.to);
      url.searchParams.set('limit', String(page.limit));
      if (page.cursor !== null) url.searchParams.set('page_token', page.cursor);
      // One actual vendor read, no retries. Unexpected network throws keep their local cause in SDK.
      const response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        ...(page.signal ? { signal: page.signal } : {}),
      });
      if (response.status === 429)
        throw new DataError('acme: rate limited.', {
          code: ErrorCode.DataRateLimited,
          context: { retryAfterMs: 2000, retryable: true, status: 429 },
        });
      if (response.status === 401)
        throw new DataError('acme: bad key.', { code: ErrorCode.DataAuthenticationRequired });
      if (response.status === 410)
        throw new DataProviderError({ code: ErrorCode.DataSnapshotExpired });
      if (!response.ok)
        throw new DataProviderError({ code: ErrorCode.DataUnavailable, status: response.status });
      const body: VendorResponse = await response.json();
      return {
        data: body.bars.map((b) => ({
          bar: {
            timestampMs: Date.parse(b.t),
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v,
            adjusted: true,
          },
          // This synthetic vendor's documented daily04Z label has the same calendar date as its session.
          sessionDate: query.interval === '1d' ? b.t.slice(0, 10) : null,
        })),
        nextCursor: body.next_page_token,
        facts: {
          dataset: { id: 'bars-1d', version: 'v2' },
          sourceSymbol: body.symbol,
          receivedTimestampMs: now(),
          adjustment: 'split',
          consistency: 'best-effort',
          timestampConvention: query.interval === '1d' ? 'session-start' : 'interval-start',
        },
      };
    },
  };
}
