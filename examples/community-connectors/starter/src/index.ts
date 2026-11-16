import type {
  DataProviderSource,
  DataQuery,
  DataPageOptions,
  SourcePriceBarsPage,
} from '@insiderfinance/totalfinance/core/data';
import { DataProviderError } from '@insiderfinance/totalfinance/core/data';
import { ErrorCode } from '@insiderfinance/totalfinance/core';
/** Different synthetic vendor schema. Prices are actual USD cents/share, volume actual shares. */
export interface VendorRow {
  ticker: string;
  session: string;
  openCents: number;
  highCents: number;
  lowCents: number;
  closeCents: number;
  shares: number | null;
}
/** No network, key, financial default, return assertion or query-in-cursor envelope. */
export function createStarterProvider(
  rows: readonly VendorRow[],
  receivedTimestampMs: number,
): DataProviderSource {
  return {
    protocol: 'totalfinance-data-source',
    contractVersion: 2,
    id: 'starter-synthetic',
    version: '1',
    async capabilities() {
      return [
        {
          kind: 'price-bars',
          intervals: ['1d'],
          maxPageSize: 2,
          consistency: ['best-effort'],
          pointInTime: false,
          access: 'granted',
        },
      ];
    },
    async query(query: DataQuery, page: DataPageOptions): Promise<SourcePriceBarsPage> {
      if (query.kind !== 'price-bars' || query.interval !== '1d')
        throw new DataProviderError({ code: ErrorCode.DataUnsupportedCapability });
      if (page.limit > 2)
        throw new DataProviderError({
          code: ErrorCode.DataInvalidRequest,
          guidance: { field: 'request.limit', rule: 'page_limit' },
        });
      const offset = page.cursor === null ? 0 : Number(page.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new DataProviderError({ code: ErrorCode.DataInvalidCursor });
      const matching = rows.filter(
        (row) =>
          row.ticker === query.symbol && row.session >= query.from && row.session <= query.to,
      );
      const selected = matching.slice(offset, offset + page.limit),
        next = offset + selected.length;
      return {
        data: selected.map((row) => ({
          bar: {
            timestampMs: Date.parse(row.session + 'T00:00:00Z'),
            open: row.openCents / 100,
            high: row.highCents / 100,
            low: row.lowCents / 100,
            close: row.closeCents / 100,
            ...(row.shares === null ? {} : { volume: row.shares }),
            adjusted: false,
          },
          sessionDate: row.session,
          source: 'starter-cents-json',
        })),
        nextCursor: next < matching.length ? String(next) : null,
        facts: {
          dataset: { id: 'synthetic-daily', version: '1' },
          receivedTimestampMs,
          adjustment: 'unadjusted',
          consistency: 'best-effort',
          timestampConvention: 'session-label-midnight-utc',
          freshness: { status: 'historical', configuredDelayMs: null, evaluatedTimestampMs: null },
          coverage: {
            status: 'observed-only',
            start: matching[0]?.session ?? null,
            end: matching.at(-1)?.session ?? null,
          },
          quality: { status: 'complete', issues: [] },
          access: 'granted',
        },
        diagnostics: {
          warnings: [
            {
              code: 'data.coverage_unverified',
              message:
                'Synthetic gapped research sample; terminal paging does not certify continuous history.',
              severity: 'warn',
            },
          ],
        },
      };
    },
  };
}
