/**
 * Small internal linear-algebra helpers for portfolio math. Heavy primitives (Cholesky, eigen,
 * nearest-PSD, correlated sampling) come from `@insiderfinance/totalfinance/math`; these are the lightweight vector
 * operations the risk formulas lean on.
 */

import { InputError, ErrorCode } from '@totalfinance/core';
import { type Matrix, cholesky, choleskySolve } from '@totalfinance/math';

/** Dot product of two equal-length vectors. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/** Matrix · vector. */
export function matVec(A: Matrix, x: ArrayLike<number>): number[] {
  return A.map((row) => dot(row, x));
}

/** Quadratic form `xᵀ A x` (e.g. portfolio variance `wᵀΣw`). */
export function quadForm(A: Matrix, x: ArrayLike<number>): number {
  return dot(matVec(A, x), x);
}

/** Assert a covariance matrix is square and matches the expected dimension. */
export function assertSquare(A: Matrix, n: number, functionName: string): void {
  if (A.length !== n || A.some((r) => r.length !== n)) {
    throw new InputError(`${functionName}: covariance must be a ${n}×${n} matrix.`, {
      code: ErrorCode.InputOutOfRange,
      context: { functionName, expected: n, got: A.length },
    });
  }
}

/**
 * Validate a covariance matrix cell-by-cell (H07): every cell finite, every diagonal cell (a
 * variance) non-negative, and the matrix numerically symmetric. The symmetry tolerance is relative
 * to the largest |cell| (`1e-9 · scale`, the kalman-filter convention) so a legitimately computed
 * sample covariance with round-off drift passes while a transposed/mistyped entry — which would
 * silently bend every quadratic form built on it — is rejected with a typed error.
 */
export function requireFiniteSymmetric(A: Matrix, functionName: string): void {
  const n = A.length;
  let maxAbs = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = A[i]![j]!;
      if (!Number.isFinite(v)) {
        throw new InputError(`${functionName}: covariance[${i}][${j}] must be finite; got ${v}.`, {
          code: ErrorCode.InputNotFinite,
          context: { functionName, row: i, column: j, value: v },
        });
      }
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    // A diagonal cell is an asset variance; a negative one is not a covariance at all — and it
    // would otherwise ride into √(Σᵢᵢ) as a silent NaN wherever a weight zeroes it out of wᵀΣw.
    if (A[i]![i]! < 0) {
      throw new InputError(
        `${functionName}: covariance[${i}][${i}] is a variance and must be ≥ 0; got ${A[i]![i]}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { functionName, row: i, column: i, value: A[i]![i] },
        },
      );
    }
  }
  const tolerance = 1e-9 * (maxAbs || 1);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(A[i]![j]! - A[j]![i]!) > tolerance) {
        throw new InputError(
          `${functionName}: covariance must be symmetric (entry [${i}][${j}]=${A[i]![j]} ≠ [${j}][${i}]=${A[j]![i]}); a covariance is symmetric by definition.`,
          { code: ErrorCode.InputOutOfRange, context: { functionName, row: i, column: j } },
        );
      }
    }
  }
}

/** Solve `A x = b` for a symmetric positive-definite `A` via Cholesky. */
export function spdSolve(A: Matrix, b: number[]): number[] {
  return choleskySolve(cholesky(A), b);
}

/** Inverse of a symmetric positive-definite matrix (column-by-column Cholesky solves). */
export function spdInverse(A: Matrix): Matrix {
  const n = A.length;
  const L = cholesky(A);
  const inv: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let j = 0; j < n; j++) {
    const e = new Array<number>(n).fill(0);
    e[j] = 1;
    const col = choleskySolve(L, e);
    for (let i = 0; i < n; i++) inv[i]![j] = col[i]!;
  }
  return inv;
}
