/** Minimal community provider: callers supply already normalized synthetic pages, no registration. */
import {
  defineDataProvider,
  type DataCapability,
  type DataProvider,
  type DataRequest,
  type DataPage,
  type PriceBarRecord,
  type OptionChainResearchRecord,
} from '@insiderfinance/totalfinance/core/data';
import {
  DataError,
  ErrorCode,
  InputError,
  UnsupportedError,
} from '@insiderfinance/totalfinance/core';
import { canonicalJsonOf } from '@insiderfinance/totalfinance/core/artifacts';

export function createFixtureDataProvider(input: {
  id: string;
  version: string;
  capabilities: readonly DataCapability[];
  entries: readonly {
    request: DataRequest;
    page: DataPage<PriceBarRecord> | DataPage<OptionChainResearchRecord>;
  }[];
  beforeQuery?: (input: { signal?: AbortSignal }) => Promise<void>;
}): DataProvider {
  return defineDataProvider({
    id: input.id,
    version: input.version,
    contractVersion: 1,
    async capabilities() {
      return {
        contractVersion: 1,
        providerId: input.id,
        providerVersion: input.version,
        capabilities: input.capabilities,
      };
    },
    async query(request, { signal } = {}) {
      const capability = input.capabilities.find((c) => c.kind === request.kind);
      if (
        !capability ||
        (request.kind === 'price-bars' &&
          !('cursor' in request) &&
          !capability.intervals.includes(request.interval))
      )
        throw new UnsupportedError('fixture: capability not supplied.', {
          code: ErrorCode.DataUnsupportedCapability,
        });
      if (request.limit > capability.maxPageSize)
        throw new InputError('fixture: limit exceeds capability.', {
          code: ErrorCode.InputOutOfRange,
        });
      await input.beforeQuery?.(signal ? { signal } : {});
      const found = input.entries.find(
        (entry) => canonicalJsonOf(entry.request) === canonicalJsonOf(request),
      );
      if (!found)
        throw new DataError('fixture: no page supplied for this request.', {
          code: ErrorCode.DataNotFound,
        });
      return found.page;
    },
  });
}
