/**
 * Tests for the general (non-symmetric) eigensolver: triangular/diagonal spectra, complex-conjugate
 * pairs, agreement with the symmetric Jacobi solver, the trace/determinant identities, companion-matrix
 * polynomial roots, and the eigenvector relation A·v = λ·v for real eigenvalues.
 */

import { describe, expect, it } from 'vitest';
import {
  determinant,
  eigen,
  eigenvalues,
  jacobiEigen,
  matrixVectorProduct,
  type Complex,
  type Matrix,
} from '@totalfinance/math';

const sortByRe = (xs: Complex[]): Complex[] => [...xs].sort((a, b) => a.re - b.re || a.im - b.im);

describe('general eigenvalues', () => {
  it('an upper-triangular matrix has its diagonal as the spectrum', () => {
    const A: Matrix = [
      [2, 5, 7],
      [0, 3, 1],
      [0, 0, -1],
    ];
    const vals = sortByRe(eigenvalues(A));
    expect(vals.map((v) => v.re)).toEqual([-1, 2, 3]);
    expect(vals.every((v) => v.im === 0)).toBe(true);
  });

  it('a 2-D rotation has the pure-imaginary pair ±i', () => {
    const vals = eigenvalues([
      [0, -1],
      [1, 0],
    ]);
    expect(vals.map((v) => v.re)).toEqual([0, 0]);
    expect(
      sortByRe(vals)
        .map((v) => v.im)
        .sort((a, b) => a - b),
    ).toEqual([-1, 1]);
  });

  it('matches the symmetric Jacobi solver on a symmetric matrix', () => {
    const A: Matrix = [
      [4, 1, 2],
      [1, 3, 0],
      [2, 0, 5],
    ];
    const general = sortByRe(eigenvalues(A)).map((v) => v.re);
    const jacobi = [...jacobiEigen(A).values].sort((a, b) => a - b);
    for (let i = 0; i < 3; i++) expect(general[i]).toBeCloseTo(jacobi[i]!, 8);
  });

  it('eigenvalues sum to the trace and multiply to the determinant', () => {
    const A: Matrix = [
      [1, 2, 3],
      [0, 4, 5],
      [1, 0, 6],
    ];
    const vals = eigenvalues(A);
    const sumRe = vals.reduce((s, v) => s + v.re, 0);
    const trace = A[0]![0]! + A[1]![1]! + A[2]![2]!;
    expect(sumRe).toBeCloseTo(trace, 8);
    // Product of eigenvalues (real, since complex come in conjugate pairs) = det.
    let prodRe = 1;
    let prodIm = 0;
    for (const v of vals) {
      const re = prodRe * v.re - prodIm * v.im;
      const im = prodRe * v.im + prodIm * v.re;
      prodRe = re;
      prodIm = im;
    }
    expect(prodRe).toBeCloseTo(determinant(A), 6);
    expect(prodIm).toBeCloseTo(0, 6);
  });

  it('recovers the roots of a polynomial from its companion matrix', () => {
    // p(x) = (x−1)(x−2)(x−4) = x³ − 7x² + 14x − 8 ⇒ roots {1,2,4}.
    const companion: Matrix = [
      [7, -14, 8],
      [1, 0, 0],
      [0, 1, 0],
    ];
    const roots = sortByRe(eigenvalues(companion)).map((v) => v.re);
    expect(roots[0]).toBeCloseTo(1, 6);
    expect(roots[1]).toBeCloseTo(2, 6);
    expect(roots[2]).toBeCloseTo(4, 6);
  });
});

describe('eigen (values + real eigenvectors)', () => {
  it('returns eigenvectors satisfying A·v = λ·v for real eigenvalues, null for complex', () => {
    const A: Matrix = [
      [2, 0, 0],
      [1, 3, 0],
      [0, 1, 4],
    ];
    const { values, vectors } = eigen(A);
    for (let i = 0; i < values.length; i++) {
      if (Math.abs(values[i]!.im) > 1e-9) {
        expect(vectors[i]).toBeNull();
        continue;
      }
      const v = vectors[i]!;
      const Av = matrixVectorProduct(A, v);
      for (let k = 0; k < v.length; k++) expect(Av[k]).toBeCloseTo(values[i]!.re * v[k]!, 6);
    }
  });

  it('marks complex eigenvalues with a null eigenvector', () => {
    const { values, vectors } = eigen([
      [0, -2],
      [1, 0],
    ]);
    expect(values.every((v) => Math.abs(v.im) > 0)).toBe(true);
    expect(vectors.every((v) => v === null)).toBe(true);
  });
});
