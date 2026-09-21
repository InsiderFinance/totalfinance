/** Internal workload-budget validation shared by math solvers, optimizers, and quadrature. */

import { ErrorCode, InputError } from '@totalfinance/core';

/**
 * Outer ceiling for explicit scalar solver/optimizer iteration budgets. Defaults are 40–400; one
 * million iterations is already thousands of times normal practice and keeps a malformed request
 * from becoming an effectively unbounded synchronous loop.
 */
export const MAX_MATH_ITERATIONS = 1_000_000;

/**
 * Gauss–Legendre construction is roughly quadratic in the rule order (root iterations each run an
 * order-length recurrence). 4,096 nodes already represent tens of millions of recurrence steps and
 * far exceed ordinary fixed-order quadrature use.
 */
export const MAX_GAUSS_LEGENDRE_NODES = 4_096;

/** Reject an explicit solver/optimizer loop budget before any objective or callback is evaluated. */
export function requireMathIterationBudgetWhenPresent(
  functionName: string,
  value: unknown,
  field = 'maximumIterations',
): void {
  if (value === undefined) return;
  if (typeof value !== 'number') {
    throw new InputError(
      `${functionName}: ${field} must be a number when provided. Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {
          function: functionName,
          field,
          received: value === null ? 'null' : typeof value,
        },
      },
    );
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MATH_ITERATIONS) {
    throw new InputError(
      `${functionName}: ${field} must be a non-negative safe integer ≤ ${MAX_MATH_ITERATIONS.toLocaleString('en-US')} (the defaults are 40–400; the cap prevents an effectively unbounded synchronous solve). Received ${String(value)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, received: value, max: MAX_MATH_ITERATIONS },
      },
    );
  }
}

/** Reject an unsafe quadrature order before arrays or the O(nodeCount²) recurrence are started. */
export function requireGaussLegendreNodeCount(functionName: string, value: unknown): void {
  if (typeof value !== 'number') {
    throw new InputError(
      `${functionName}: nodeCount must be a number. Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {
          function: functionName,
          field: 'nodeCount',
          received: value === null ? 'null' : typeof value,
        },
      },
    );
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GAUSS_LEGENDRE_NODES) {
    throw new InputError(
      `${functionName}: nodeCount must be a positive safe integer ≤ ${MAX_GAUSS_LEGENDRE_NODES.toLocaleString('en-US')} (constructing the rule is approximately quadratic in nodeCount). Received ${String(value)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'nodeCount',
          received: value,
          max: MAX_GAUSS_LEGENDRE_NODES,
        },
      },
    );
  }
}
