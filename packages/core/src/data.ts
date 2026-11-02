/** Opt-in structural data contract. No provider, credential, clock or network is loaded here. */
import { DataError, ErrorCode, QuantError } from './errors.js';
import type {
  DataProvider,
  DataProviderSource,
  DataRequest,
  DataViewFor,
  DataCapabilities,
  DataCallOptions,
} from './data-types.js';
import {
  object,
  providerShape,
  signalField,
  aborted,
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
  function responseError(error: unknown): never {
    if (error instanceof QuantError && error.code === ErrorCode.DataContractVersionUnsupported)
      throw error;
    throw new DataError(
      'defineDataProvider: provider returned invalid data; check its declared contract and diagnostics.',
      { code: ErrorCode.DataInvalidResponse, context: { provider: id } },
    );
  }
  function callSignal(options: DataCallOptions = {}): AbortSignal | undefined {
    const args = object(options, 'options', ['signal']);
    signalField(args['signal']);
    return args['signal'];
  }
  async function call<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    aborted(signal);
    try {
      const result = await run();
      aborted(signal);
      return result;
    } catch (error) {
      aborted(signal);
      if (error instanceof QuantError) throw error;
      responseError(error);
    }
  }
  return Object.freeze({
    id,
    version,
    contractVersion: DATA_CONTRACT_VERSION,
    async capabilities(options?: DataCallOptions): Promise<DataCapabilities> {
      const signal = callSignal(options);
      return call(signal, async () => {
        const result = await capabilities(signal ? { signal } : undefined);
        try {
          capabilityData(result, identity);
          return copyFrozen(result);
        } catch (error) {
          responseError(error);
        }
      });
    },
    async query<R extends DataRequest>(
      input: R,
      options?: DataCallOptions,
    ): Promise<DataViewFor<R>> {
      const signal = callSignal(options);
      requestData(input);
      const request = copyFrozen(input);
      return call(signal, async () => {
        const result = await query(request, signal ? { signal } : undefined);
        try {
          pageData(result, request, identity);
          return dataViewOf(copyFrozen(result)) as DataViewFor<R>;
        } catch (error) {
          responseError(error);
        }
      });
    },
  });
}
