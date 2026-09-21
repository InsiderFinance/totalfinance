/**
 * Tests for the dense linear-algebra primitives (§8.3): matrix algebra, LU/QR/SVD factorizations, and
 * the pseudoinverse. Verified by reconstruction and the defining identities (orthogonality, A·x = b).
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  determinant,
  identity,
  luDecompose,
  luSolve,
  matrixMultiply,
  matrixVectorProduct,
  pseudoInverse,
  qrDecompose,
  qrSolve,
  svd,
  transpose,
  type Matrix,
  cholesky,
} from '@totalfinance/math';

const close = (a: number, b: number, p = 9): void => expect(a).toBeCloseTo(b, p);

function matClose(A: Matrix, B: Matrix, p = 8): void {
  expect(A.length).toBe(B.length);
  for (let i = 0; i < A.length; i++)
    for (let j = 0; j < A[i]!.length; j++) close(A[i]![j]!, B[i]![j]!, p);
}

describe('basic matrix algebra', () => {
  it('transpose, matrixMultiply, matrixVectorProduct', () => {
    const A: Matrix = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    expect(transpose(A)).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    matClose(matrixMultiply(A, identity(3)), A);
    expect(matrixVectorProduct(A, [1, 1, 1])).toEqual([6, 15]);
    // (A·Aᵀ) is 2×2 symmetric.
    const AAt = matrixMultiply(A, transpose(A));
    close(AAt[0]![1]!, AAt[1]![0]!);
  });

  it('rejects a dimension mismatch', () => {
    expect(() => matrixMultiply([[1, 2]], [[1, 2]])).toThrow(/inner dimensions/);
  });
});

describe('LU decomposition', () => {
  const A: Matrix = [
    [2, 1, 1],
    [4, -6, 0],
    [-2, 7, 2],
  ];

  it('solves A·x = b and recovers the determinant', () => {
    const lu = luDecompose(A);
    const b = [5, -2, 9];
    const x = luSolve(lu, b);
    matClose([matrixVectorProduct(A, x)], [b]);
    close(determinant(A), -16); // det of this matrix
  });

  it('determinant is 0 for a singular matrix; luDecompose throws', () => {
    const singular: Matrix = [
      [1, 2],
      [2, 4],
    ];
    expect(determinant(singular)).toBe(0);
    expect(() => luDecompose(singular)).toThrow(/singular/);
  });
});

describe('QR decomposition', () => {
  const A: Matrix = [
    [1, 2],
    [3, 4],
    [5, 7],
  ];

  it('A = Q·R with orthonormal Q and upper-triangular R', () => {
    const { q, r } = qrDecompose(A);
    matClose(matrixMultiply(q, r), A);
    // Qᵀ Q = I (thin).
    matClose(matrixMultiply(transpose(q), q), identity(2));
    expect(r[1]![0]).toBeCloseTo(0, 10); // lower-triangular entry is zero
  });

  it('least-squares solve makes the residual orthogonal to the columns of A', () => {
    const b = [1, 2, 4];
    const x = qrSolve(A, b);
    const residual = matrixVectorProduct(A, x).map((v, i) => v - b[i]!);
    const AtR = matrixVectorProduct(transpose(A), residual);
    close(AtR[0]!, 0, 8);
    close(AtR[1]!, 0, 8);
  });

  it('rejects a rank-deficient system instead of returning zeroed/blown-up coefficients', () => {
    // Second column is 2× the first ⇒ collinear ⇒ singular least-squares system.
    const singular: Matrix = [
      [1, 2],
      [2, 4],
      [3, 6],
    ];
    let caught: unknown;
    try {
      qrSolve(singular, [1, 2, 3]);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'linalg.singular')).toBe(true);
  });
});

describe('SVD', () => {
  function reconstruct(u: Matrix, s: number[], v: Matrix): Matrix {
    const m = u.length;
    const n = v.length;
    const out: Matrix = Array.from({ length: m }, () => new Array<number>(n).fill(0));
    for (let i = 0; i < m; i++)
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let k = 0; k < s.length; k++) sum += u[i]![k]! * s[k]! * v[j]![k]!;
        out[i]![j] = sum;
      }
    return out;
  }

  it('reconstructs a tall matrix with descending, orthonormal factors', () => {
    const A: Matrix = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    const { u, s, v } = svd(A);
    matClose(reconstruct(u, s, v), A, 7);
    expect(s[0]).toBeGreaterThanOrEqual(s[1]!); // descending
    matClose(matrixMultiply(transpose(u), u), identity(2), 7); // Uᵀ U = I
    matClose(matrixMultiply(transpose(v), v), identity(2), 7); // Vᵀ V = I
  });

  it('reconstructs a wide matrix (m < n)', () => {
    const A: Matrix = [
      [1, 2, 3],
      [4, 5, 6],
    ];
    const { u, s, v } = svd(A);
    matClose(reconstruct(u, s, v), A, 7);
  });

  it('singular values of a diagonal matrix are its sorted |entries|', () => {
    const { s } = svd([
      [2, 0, 0],
      [0, 5, 0],
      [0, 0, 1],
    ]);
    expect(s.map((x) => Math.round(x))).toEqual([5, 2, 1]);
  });

  it('pseudoinverse satisfies A·A⁺·A = A', () => {
    const A: Matrix = [
      [1, 2],
      [3, 4],
      [5, 6],
    ];
    const Ap = pseudoInverse(A);
    matClose(matrixMultiply(matrixMultiply(A, Ap), A), A, 6);
    // Full column rank ⇒ A⁺ A = I₂.
    matClose(matrixMultiply(Ap, A), identity(2), 6);
  });
});

describe('R3 honesty fixes', () => {
  it('cholesky throws on a NaN pivot instead of silently emitting NaN factors', () => {
    expect(() =>
      cholesky([
        [1, 0],
        [0, NaN],
      ]),
    ).toThrowError(/not positive definite/);
  });

  it('luSolve/qrSolve reject a b of the wrong length instead of returning silent NaN', () => {
    const lu = luDecompose([
      [2, 0],
      [0, 2],
    ]);
    expect(() => luSolve(lu, [1])).toThrowError(/b has 1 entries but the system is 2×2/);
    expect(() =>
      qrSolve(
        [
          [1, 0],
          [0, 1],
          [1, 1],
        ],
        [1, 2],
      ),
    ).toThrowError(/one observation per row/);
  });

  it('svd converges honestly on a normal matrix and still solves', () => {
    const { s } = svd([
      [3, 0],
      [0, 4],
    ]);
    expect(s[0]).toBeCloseTo(4, 10);
    expect(s[1]).toBeCloseTo(3, 10);
  });
});
