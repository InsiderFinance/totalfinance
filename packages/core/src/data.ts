/** Opt-in structural data contract. No provider, credential, clock or network is loaded here. */
import { dataCall, dataSignal, invalidResponse } from './data-call.js';
import type {
  DataProvider,
  DataProviderSource,
  DataRequest,
  DataViewFor,
  DataCapabilities,
  DataCallOptions,
} from './data-types.js';
import {
  providerShape,
  requestData,
  capabilityData,
  pageData,
  copyFrozen,
} from './data-validation.js';
import { dataViewOf } from './data-view.js';
export { createDataView } from './data-view.js';
export type * from './data-types.js';
/** Research acquisition protocol version, independent of package and dataset versions. */
export const DATA_CONTRACT_VERSION = 1;

/** Validate and bind a raw source without calling it. Query returns an immutable common SDK view.
 * @example
 * const provider = defineDataProvider(mySource);
 * const prices = await provider.query({ kind: 'price-bars', symbol: 'SPY', interval: '1d', from: '2026-10-26', to: '2026-10-28', limit: 100 });
 * const average = sma(prices.closePrices, { period: 2 });
 */
export function defineDataProvider(source: DataProviderSource): DataProvider {
  providerShape(source);
  const raw: DataProviderSource = source;
  const id = raw.id,
    version = raw.version;
  const query = raw.query.bind(raw);
  const capabilities = raw.capabilities.bind(raw);
  const identity = { id, version };
  return Object.freeze({
    id,
    version,
    contractVersion: DATA_CONTRACT_VERSION,
    async capabilities(options?: DataCallOptions): Promise<DataCapabilities> {
      const signal = dataSignal(options);
      return dataCall(signal, async () => {
        const result = await capabilities(signal ? { signal } : undefined);
        try {
          capabilityData(result, identity);
          return copyFrozen(result);
        } catch (error) {
          invalidResponse(error, id, 'defineDataProvider.capabilities');
        }
      });
    },
    async query<R extends DataRequest>(
      input: R,
      options?: DataCallOptions,
    ): Promise<DataViewFor<R>> {
      const signal = dataSignal(options);
      requestData(input);
      const request = copyFrozen(input);
      return dataCall(signal, async () => {
        const result = await query(request, signal ? { signal } : undefined);
        try {
          pageData(result, request, identity);
          return dataViewOf(copyFrozen(result)) as DataViewFor<R>;
        } catch (error) {
          invalidResponse(error, id);
        }
      });
    },
  });
}

export { connect, createPriceBarsWindowView } from './data-connection.js';
