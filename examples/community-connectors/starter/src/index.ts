import {
  defineDataProvider,
  type DataPage,
  type DataRequest,
  type PriceBarRecord,
} from '@insiderfinance/totalfinance/core/data';
import {
  CONVENTIONS_VERSION,
  DataError,
  ErrorCode,
  UnsupportedError,
} from '@insiderfinance/totalfinance/core';

/** Deliberately different vendor schema; all prices are synthetic USD per share. */
export interface VendorRow {
  ticker: string;
  session: string;
  openCents: number;
  highCents: number;
  lowCents: number;
  closeCents: number;
  shares: number | null;
}

export function createStarterProvider(rows: readonly VendorRow[], receivedTimestampMs: number) {
  const id = 'starter-synthetic';
  const version = '1';
  const unknownTimes = {
    observedTimestampMs: null,
    availableTimestampMs: null,
    sourceStoredTimestampMs: null,
  };
  return defineDataProvider({
    id,
    version,
    contractVersion: 1,
    async capabilities() {
      return {
        contractVersion: 1,
        providerId: id,
        providerVersion: version,
        capabilities: [
          {
            kind: 'price-bars',
            intervals: ['1d'],
            maxPageSize: 2,
            consistency: 'best-effort',
            pointInTime: false,
            access: 'granted',
          },
        ],
      };
    },
    async query(request: DataRequest): Promise<DataPage<PriceBarRecord>> {
      if (request.kind !== 'price-bars' || (!('cursor' in request) && request.interval !== '1d')) {
        throw new UnsupportedError('This synthetic connector supplies daily prices only.', {
          code: ErrorCode.DataUnsupportedCapability,
        });
      }
      if (request.limit > 2)
        throw new DataError('Page size exceeds 2.', { code: ErrorCode.DataInvalidRequest });
      // An opaque continuation retains the original resource and date bounds.
      const selection =
        'cursor' in request
          ? (JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as {
              symbol: string;
              from: string;
              to: string;
              offset: number;
            })
          : { symbol: request.symbol, from: request.from, to: request.to, offset: 0 };
      if (selection.symbol !== request.symbol)
        throw new DataError('Cursor resource changed.', { code: ErrorCode.DataInvalidCursor });
      const matching = rows.filter(
        (row) =>
          row.ticker === selection.symbol &&
          row.session >= selection.from &&
          row.session <= selection.to,
      );
      const selected = matching.slice(selection.offset, selection.offset + request.limit);
      const data: PriceBarRecord[] = selected.map((row) => ({
        bar: {
          symbol: row.ticker,
          timestampMs: Date.parse(`${row.session}T00:00:00Z`),
          open: row.openCents / 100,
          high: row.highCents / 100,
          low: row.lowCents / 100,
          close: row.closeCents / 100,
          ...(row.shares === null ? {} : { volume: row.shares }),
          adjusted: false,
        },
        sessionDate: row.session,
        timestampConvention: 'session-label-midnight-utc',
        times: unknownTimes,
        source: 'starter-cents-json',
        provisional: null,
        revision: null,
        diagnostics: { warnings: [] },
      }));
      const offset = selection.offset + selected.length;
      const page: DataPage<PriceBarRecord> = {
        contractVersion: 1,
        kind: 'price-bars',
        symbol: request.symbol,
        data,
        nextCursor:
          offset < matching.length
            ? Buffer.from(JSON.stringify({ ...selection, offset })).toString('base64url')
            : null,
        provenance: {
          provider: id,
          dataset: 'synthetic-daily',
          sourceVersion: '1',
          receivedAt: receivedTimestampMs,
        },
        metadata: {
          datasetId: 'synthetic-daily',
          datasetVersion: '1',
          snapshotId: null,
          sessionDate: null,
          sourceGeneratedTimestampMs: null,
          receivedTimestampMs,
          times: unknownTimes,
          consistency: 'best-effort',
          freshness: { status: 'historical', configuredDelayMs: null, evaluatedTimestampMs: null },
          coverage: {
            status: 'observed-only',
            start: matching[0]?.session ?? null,
            end: matching.at(-1)?.session ?? null,
          },
          adjustment: 'unadjusted',
          quality: { status: 'complete', issues: [] },
          access: 'granted',
          executionEligibility: 'research-only',
        },
        assumptions: { conventionsVersion: CONVENTIONS_VERSION },
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
      return page;
    },
  });
}
