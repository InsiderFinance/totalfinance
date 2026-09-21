/** Shared workload validation used by public option kernels and their engine factories. */

import { ErrorCode, InputError } from '@totalfinance/core';

/** Default time resolution for local-volatility Monte-Carlo paths. */
export const DEFAULT_LOCAL_VOLATILITY_STEPS = 100;

/** Maximum explicit Heston COS terms; 8,192 is already 32× the default. */
export const MAX_HESTON_COSINE_TERMS = 8_192;

/** Reject an unsafe Heston COS expansion before a kernel or configured engine captures it. */
export function requireHestonCosineTermCount(
  functionName: string,
  terms: number | undefined,
): void {
  if (terms === undefined) return;
  if (!Number.isSafeInteger(terms) || terms < 1 || terms > MAX_HESTON_COSINE_TERMS) {
    throw new InputError(
      `${functionName}: terms must be a positive safe integer ≤ ${MAX_HESTON_COSINE_TERMS.toLocaleString('en-US')} (the default is 256 and COS convergence is exponential). Received ${String(terms)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'terms',
          received: terms,
          max: MAX_HESTON_COSINE_TERMS,
        },
      },
    );
  }
}
