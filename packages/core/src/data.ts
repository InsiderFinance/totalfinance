/** Opt-in structural data contract. No provider, credential, clock or network is loaded here. */
import { DataError, ErrorCode, QuantError } from './errors.js';
import type {
  DataProvider,
  DataRequest,
  DataFor,
  DataPage,
  DataCapabilities,
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
export type * from './data-types.js';
/** Research acquisition protocol version, independent of package and dataset versions. */
export const DATA_CONTRACT_VERSION = 1;

/** Validate and bind a provider without calling it. Every call validates requests and observations.
 * Valid output is copied/frozen; malformed provider output is refused rather than normalized.
 * @example
 * const provider = defineDataProvider({ provider: myProvider });
 * const supported = await provider.capabilities({});
 */
export function defineDataProvider(input: { readonly provider: DataProvider }): DataProvider {
  const config = object(input, 'input', ['provider']);
  providerShape(config['provider']);
  const source = config['provider'];
  const id = source.id,
    version = source.version;
  const query = source.query.bind(source);
  const capabilities = source.capabilities.bind(source);
  const identity = { id, version };
  function responseError(error: unknown): never {
    if (error instanceof QuantError && error.code === ErrorCode.DataContractVersionUnsupported)
      throw error;
    throw new DataError(
      'defineDataProvider: provider returned invalid data; check its declared contract and diagnostics.',
      { code: ErrorCode.DataInvalidResponse, context: { provider: id } },
    );
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
    async capabilities(input: { signal?: AbortSignal }): Promise<DataCapabilities> {
      const args = object(input, 'input', ['signal']);
      signalField(args['signal']);
      const signal = args['signal'];
      return call(signal, async () => {
        const result = await capabilities(signal ? { signal } : {});
        try {
          capabilityData(result, identity);
          return copyFrozen(result);
        } catch (e) {
          responseError(e);
        }
      });
    },
    async query<R extends DataRequest>(input: {
      request: R;
      signal?: AbortSignal;
    }): Promise<DataPage<DataFor<R>>> {
      const args = object(input, 'input', ['request', 'signal']);
      signalField(args['signal']);
      requestData(args['request']);
      const signal = args['signal'];
      const request = copyFrozen(args['request']);
      return call(signal, async () => {
        const result = await query(signal ? { request, signal } : { request });
        try {
          pageData(result, request, identity);
          return copyFrozen(result) as DataPage<DataFor<R>>;
        } catch (e) {
          responseError(e);
        }
      });
    },
  });
}
