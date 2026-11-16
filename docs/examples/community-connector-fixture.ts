/** Public synthetic source: explicit supplied facts, no registry or source-workspace imports. */
import type {
  DataProviderSource,
  DataQuery,
  DataCapabilityDeclaration,
  SourcePriceBarsPage,
  SourceOptionChainPage,
} from '@insiderfinance/totalfinance/core/data';
import { DataProviderError } from '@insiderfinance/totalfinance/core/data';
import { ErrorCode } from '@insiderfinance/totalfinance/core';
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';
export function createFixtureDataProvider(input: {
  id: string;
  version: string;
  capabilities: readonly DataCapabilityDeclaration[];
  entries: readonly {
    query: DataQuery;
    cursor: string | null;
    page: SourcePriceBarsPage | SourceOptionChainPage;
  }[];
  beforeQuery?: (input: { signal?: AbortSignal }) => Promise<void>;
}): DataProviderSource {
  return {
    protocol: 'totalfinance-data-source',
    contractVersion: 2,
    id: input.id,
    version: input.version,
    async capabilities() {
      return input.capabilities;
    },
    async query(query, options) {
      const cap = input.capabilities.find((c) => c.kind === query.kind);
      if (!cap || (query.kind === 'price-bars' && !cap.intervals.includes(query.interval)))
        throw new DataProviderError({ code: ErrorCode.DataUnsupportedCapability });
      if (options.limit > cap.maxPageSize)
        throw new DataProviderError({
          code: ErrorCode.DataInvalidRequest,
          guidance: { field: 'request.limit', rule: 'page_limit' },
        });
      await input.beforeQuery?.(options.signal ? { signal: options.signal } : {});
      const found = input.entries.find(
        (e) => e.cursor === options.cursor && canonicalJsonOf(e.query) === canonicalJsonOf(query),
      );
      if (!found) throw new DataProviderError({ code: ErrorCode.DataNotFound });
      return found.page;
    },
  };
}
