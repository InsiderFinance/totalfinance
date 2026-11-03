/** Provider-neutral error/cancellation boundaries; no financial or wall-clock defaults. */
import { DataError, ErrorCode, QuantError } from './errors.js';
import type { DataCallOptions } from './data-types.js';
import { aborted, object, signalField } from './data-validation.js';
export function dataSignal(options: DataCallOptions = {}): AbortSignal | undefined {
  const args = object(options, 'options', ['signal']);
  signalField(args['signal']);
  return args['signal'];
}
export function invalidResponse(error?: unknown, provider?: string): never {
  if (error instanceof QuantError && error.code === ErrorCode.DataContractVersionUnsupported)
    throw error;
  throw new DataError(
    'connect: provider returned invalid research data; check its declared contract.',
    { code: ErrorCode.DataInvalidResponse, ...(provider ? { context: { provider } } : {}) },
  );
}
export function responseData<T>(run: () => T, provider?: string): T {
  try {
    return run();
  } catch (error) {
    invalidResponse(error, provider);
  }
}
export async function dataCall<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  aborted(signal);
  let cleanup = () => {};
  try {
    const pending = Promise.resolve().then(() => {
      aborted(signal);
      return run();
    });
    const result = signal
      ? await Promise.race([
          pending,
          new Promise<never>((_, reject) => {
            const cancel = () => {
              try {
                aborted(signal);
              } catch (error) {
                reject(error);
              }
            };
            signal.addEventListener('abort', cancel, { once: true });
            cleanup = () => signal.removeEventListener('abort', cancel);
            if (signal.aborted) cancel();
          }),
        ])
      : await pending;
    aborted(signal);
    return result;
  } catch (error) {
    aborted(signal);
    if (error instanceof QuantError) throw error;
    invalidResponse();
  } finally {
    cleanup();
  }
}
