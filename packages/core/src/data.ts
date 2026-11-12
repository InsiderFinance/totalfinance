/** Public protocol2 source binding; ordinary compute remains provider/credential free. */
import { issueOf, responseIssue } from './data-response-issue.js';
import { dataCall, dataSignal } from './data-call.js';
import { object, numberField, aborted, signalField } from './data-validation.js';
import {
  sourceShape,
  queryData,
  freezeData,
  capabilityList,
  materialize,
  continuationData,
} from './data-protocol.js';
import { dataViewOf } from './data-view.js';
import type {
  DataProviderSource,
  DataProvider,
  DataQuery,
  DataQueryOptions,
  DataViewFor,
  DataCallOptions,
} from './data-types.js';
export const DATA_CONTRACT_VERSION = 2;
export type * from './data-types.js';
export { createDataView } from './data-view.js';
export { DataProviderError } from './data-provider-error.js';
export type {
  DataProviderErrorOptions,
  DataProviderFailure,
  KnownDataField,
  DataGuidanceRule,
} from './data-provider-error.js';
export function defineDataProvider(source: DataProviderSource): DataProvider {
  sourceShape(source);
  const { id, version } = source,
    identity = Object.freeze({ id, version }),
    query = source.query.bind(source),
    caps = source.capabilities.bind(source);
  return Object.freeze({
    id,
    version,
    contractVersion: 2,
    async capabilities(options?: DataCallOptions) {
      const signal = dataSignal(options);
      return dataCall(signal, async () => {
        const value = await caps(signal ? { signal } : undefined);
        try {
          return capabilityList(value, identity);
        } catch (error) {
          const detail = issueOf(error);
          if (detail) responseIssue(detail, 'defineDataProvider.capabilities');
          throw error;
        }
      });
    },
    async query<R extends DataQuery>(input: R, options: DataQueryOptions): Promise<DataViewFor<R>> {
      queryData(input);
      const o = object(options, 'options', ['limit', 'cursor', 'signal']);
      numberField(o['limit'], 'request.limit', 1, 10000, true);
      signalField(o['signal']);
      const signal = o['signal'];
      const q = freezeData(input);
      if (options.cursor !== undefined) continuationData(options.cursor, q, identity);
      const binding = freezeData({ provider: identity, query: q }),
        cursor = options.cursor?.cursor ?? null,
        pins = options.cursor?.pins ?? null;
      return dataCall(signal, async () => {
        aborted(signal);
        const result = await query(
          q,
          Object.freeze({ limit: options.limit, cursor, pins, ...(signal ? { signal } : {}) }),
        );
        aborted(signal);
        return dataViewOf(materialize(result, binding, options.limit, pins)) as DataViewFor<R>;
      });
    },
  });
}
export { connect, createPriceBarsWindowView, priceBarsCheckpoint } from './data-connection.js';
