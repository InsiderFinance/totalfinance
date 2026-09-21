import { ErrorCode, InputError } from '@totalfinance/core';

/**
 * Public calibration budgets share one deliberately generous outer ceiling.
 *
 * The largest default is 2,000 iterations. Ten thousand leaves substantial room for difficult
 * surfaces while preventing an accidental `2 ** 32` (or `1e308`, which is an integer in JavaScript)
 * from turning a synchronous calibration into effectively unbounded work. Individual optimizers
 * may stop earlier on convergence; this is only the public request ceiling.
 */
export const MAX_VOLATILITY_CALIBRATION_ITERATIONS = 10_000;

/** The COS engine's own public ceiling; calibration validates before its objective swallows probes. */
const MAX_HESTON_COS_TERMS = 8_192;

/** Validate once at the public boundary, before any objective or optimizer work begins. */
export function requireCalibrationIterationBudget(
  functionName: string,
  maximumIterations: number | undefined,
): void {
  if (maximumIterations === undefined) return;
  if (
    !Number.isSafeInteger(maximumIterations) ||
    maximumIterations < 1 ||
    maximumIterations > MAX_VOLATILITY_CALIBRATION_ITERATIONS
  ) {
    throw new InputError(
      `${functionName}: maximumIterations must be a positive safe integer ≤ ${MAX_VOLATILITY_CALIBRATION_ITERATIONS.toLocaleString('en-US')} (the largest calibration default is 2,000; the cap prevents an accidental iteration budget from monopolizing the calling thread). Received ${String(maximumIterations)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'maximumIterations',
          received: maximumIterations,
          max: MAX_VOLATILITY_CALIBRATION_ITERATIONS,
        },
      },
    );
  }
}

export function requireHestonCosineTermCount(
  functionName: string,
  terms: number | undefined,
): void {
  if (terms === undefined) return;
  if (!Number.isSafeInteger(terms) || terms < 1 || terms > MAX_HESTON_COS_TERMS) {
    throw new InputError(
      `${functionName}: options.terms must be a positive safe integer ≤ ${MAX_HESTON_COS_TERMS.toLocaleString('en-US')} (the Heston COS default is 256 and convergence is exponential). Received ${String(terms)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'options.terms',
          received: terms,
          max: MAX_HESTON_COS_TERMS,
        },
      },
    );
  }
}
