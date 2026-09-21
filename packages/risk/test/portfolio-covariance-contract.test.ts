import { describe, expect, it } from 'vitest';
import { InputError, isQuantError } from '@totalfinance/core';
import {
  portfolioVariance,
  portfolioVolatility,
  riskContributions,
  diversificationRatio,
  portfolioVaR,
} from '@totalfinance/risk/value-at-risk';

/**
 * Phase 3B.3 — the H07/H08/H09 covariance contract (decision ledger, Risk section).
 *
 * H07 `portfolioVariance` (ratified plain): every weight and covariance cell validated finite,
 * symmetry enforced, a materially negative quadratic form rejected, only the tiny documented
 * floating-point tolerance clamped to 0. H08 `portfolioVolatility` delegates to that kernel under
 * its own name. H09 `diversificationRatio`: a zero-volatility portfolio throws a typed
 * `input.degenerate` error instead of returning the plausible but false value 1.
 */
describe('H07: portfolioVariance validates every weight and covariance cell', () => {
  const nanCell = [
    [0.04, Number.NaN],
    [Number.NaN, 0.09],
  ];
  const infCell = [
    [0.04, Infinity],
    [Infinity, 0.09],
  ];

  it('rejects a NaN covariance cell (used to return NaN silently)', () => {
    expect(() => portfolioVariance([0.5, 0.5], nanCell)).toThrow(InputError);
    try {
      portfolioVariance([0.5, 0.5], nanCell);
    } catch (e) {
      expect(isQuantError(e, 'input.not_finite')).toBe(true);
      expect((e as InputError).message).toContain('portfolioVariance');
    }
  });

  it('rejects an Infinity covariance cell (used to return Infinity silently)', () => {
    expect(() => portfolioVariance([0.5, 0.5], infCell)).toThrow(InputError);
    try {
      portfolioVariance([0.5, 0.5], infCell);
    } catch (e) {
      expect(isQuantError(e, 'input.not_finite')).toBe(true);
    }
  });

  it('rejects an asymmetric covariance (a transposed entry bends every quadratic form)', () => {
    const asymmetric = [
      [0.04, 0.9],
      [-0.9, 0.09],
    ];
    try {
      portfolioVariance([0.5, 0.5], asymmetric);
      expect.unreachable('asymmetric covariance must be rejected');
    } catch (e) {
      expect(isQuantError(e, 'input.out_of_range')).toBe(true);
      expect((e as InputError).message).toContain('symmetric');
    }
  });

  it('tolerates round-off asymmetry relative to the matrix scale', () => {
    const drift = [
      [0.04, 0.006 + 1e-13],
      [0.006, 0.09],
    ];
    expect(portfolioVariance([0.5, 0.5], drift)).toBeCloseTo(0.0355, 10);
  });

  it('rejects a negative diagonal cell (a variance cannot be negative)', () => {
    // With w[1] = 0 the negative variance is invisible to wᵀΣw — the cell check must catch it.
    const negDiag = [
      [0.04, 0],
      [0, -0.09],
    ];
    try {
      portfolioVariance([1, 0], negDiag);
      expect.unreachable('negative diagonal must be rejected');
    } catch (e) {
      expect(isQuantError(e, 'input.out_of_range')).toBe(true);
    }
  });

  it('rejects a materially negative quadratic form instead of clamping it to 0', () => {
    // Symmetric but indefinite: eigenvalues 0.04 ± 0.9 → wᵀΣw = −0.43 along w = [0.5, −0.5].
    const indefinite = [
      [0.04, 0.9],
      [0.9, 0.04],
    ];
    try {
      portfolioVariance([0.5, -0.5], indefinite);
      expect.unreachable('materially negative wᵀΣw must be rejected');
    } catch (e) {
      expect(isQuantError(e, 'linalg.not_positive_definite')).toBe(true);
    }
  });

  it('clamps only floating-point negative noise to exactly 0', () => {
    // Rank-1 PSD Σ = vvᵀ with w exactly orthogonal to v in exact arithmetic; the FP evaluation
    // order leaves wᵀΣw = −6.66e−16 — inside the documented 1e−12·max|Σ|·(Σ|w|)² tolerance.
    const v = [0.1, 0.3, 0.7];
    const rankOne = v.map((a) => v.map((b) => a * b));
    const w = [0, 7, -3];
    expect(portfolioVariance(w, rankOne)).toBe(0);
    expect(portfolioVolatility(w, rankOne)).toBe(0);
  });

  it('still rejects non-finite weights (the half of the contract that already existed)', () => {
    expect(() =>
      portfolioVariance(
        [0.5, Number.NaN],
        [
          [0.04, 0],
          [0, 0.09],
        ],
      ),
    ).toThrow(InputError);
  });

  it('the strengthened contract guards the sibling covariance consumers too', () => {
    expect(() => riskContributions([0.5, 0.5], nanCell)).toThrow(InputError);
    expect(() =>
      portfolioVaR({ method: 'parametric', weights: [0.5, 0.5], covariance: nanCell }),
    ).toThrow(InputError);
    expect(() =>
      portfolioVaR({ method: 'monteCarlo', weights: [0.5, 0.5], covariance: infCell }),
    ).toThrow(InputError);
  });
});

describe('H08: portfolioVolatility delegates to the H07 kernel under its own name', () => {
  it('equals √portfolioVariance for a valid covariance', () => {
    const covariance = [
      [0.04, 0.006],
      [0.006, 0.09],
    ];
    const w = [0.6, 0.4];
    expect(portfolioVolatility(w, covariance)).toBeCloseTo(
      Math.sqrt(portfolioVariance(w, covariance)),
      15,
    );
  });

  it('names ITSELF, not its delegate, when it rejects (the H04 forwarded-contract lesson)', () => {
    const indefinite = [
      [0.04, 0.9],
      [0.9, 0.04],
    ];
    try {
      portfolioVolatility([0.5, -0.5], indefinite);
      expect.unreachable('materially negative wᵀΣw must be rejected');
    } catch (e) {
      expect(isQuantError(e, 'linalg.not_positive_definite')).toBe(true);
      expect((e as InputError).message).toMatch(/^portfolioVolatility:/);
    }
  });
});

describe('H09: diversificationRatio corrects the zero-volatility degenerate case', () => {
  it('throws a typed input.degenerate error instead of returning the false value 1', () => {
    const zeroCov = [
      [0, 0],
      [0, 0],
    ];
    try {
      diversificationRatio([0.5, 0.5], zeroCov);
      expect.unreachable('zero portfolio volatility must be rejected as degenerate');
    } catch (e) {
      expect(e).toBeInstanceOf(InputError);
      expect(isQuantError(e, 'input.degenerate')).toBe(true);
      expect((e as InputError).message).toMatch(/^diversificationRatio:/);
      expect((e as InputError).message).toContain('zero');
    }
  });

  it('a fully hedged (offsetting) portfolio is the same degenerate case, not ratio 1', () => {
    // Perfectly correlated pair, equal and opposite weights: σ_p = 0 while assets have volatility.
    const perfectlyCorrelated = [
      [0.04, 0.04],
      [0.04, 0.04],
    ];
    try {
      diversificationRatio([1, -1], perfectlyCorrelated);
      expect.unreachable('zero portfolio volatility must be rejected as degenerate');
    } catch (e) {
      expect(isQuantError(e, 'input.degenerate')).toBe(true);
    }
  });

  it('a genuine single-asset portfolio still measures exactly 1 (not the degenerate path)', () => {
    expect(diversificationRatio([1], [[0.04]])).toBeCloseTo(1, 12);
  });

  it('a diversified portfolio still measures > 1', () => {
    const covariance = [
      [0.04, 0.0],
      [0.0, 0.09],
    ];
    expect(diversificationRatio([0.5, 0.5], covariance)).toBeGreaterThan(1);
  });
});
