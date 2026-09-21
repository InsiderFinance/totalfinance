import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { ols } from '@totalfinance/math';

/** Deterministic LCG so autocorrelated-noise fixtures are stable across runs (no Math.random). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('ols — exact-fit goldens (HAND-COMPUTED)', () => {
  it('recovers y = 2x + 1 exactly on x = [1..6] (intercept first)', () => {
    const x = [1, 2, 3, 4, 5, 6];
    const y = x.map((v) => 2 * v + 1);
    const r = ols(
      y,
      x.map((v) => [v]),
    );
    expect(r.coefficients[0]).toBeCloseTo(1, 10); // intercept
    expect(r.coefficients[1]).toBeCloseTo(2, 10); // slope
    expect(r.rSquared).toBeCloseTo(1, 12);
    for (const e of r.residuals) expect(Math.abs(e)).toBeLessThan(1e-9);
    expect(r.observationCount).toBe(6);
    expect(r.coefficientCount).toBe(2);
  });

  it('recovers a two-predictor exact fit y = 3 + 2·x1 − 1·x2', () => {
    const X = [
      [1, 1],
      [2, 1],
      [3, 4],
      [4, 2],
      [5, 7],
      [6, 3],
    ];
    const y = X.map(([x1, x2]) => 3 + 2 * x1! - 1 * x2!);
    const r = ols(y, X);
    expect(r.coefficients[0]).toBeCloseTo(3, 9);
    expect(r.coefficients[1]).toBeCloseTo(2, 9);
    expect(r.coefficients[2]).toBeCloseTo(-1, 9);
    expect(r.rSquared).toBeCloseTo(1, 12);
    expect(r.coefficientCount).toBe(3);
  });

  it('honours intercept:false (regression through the origin)', () => {
    const x = [1, 2, 3, 4];
    const y = x.map((v) => 2.5 * v);
    const r = ols(
      y,
      x.map((v) => [v]),
      { intercept: false },
    );
    expect(r.coefficientCount).toBe(1);
    expect(r.coefficients[0]).toBeCloseTo(2.5, 10);
  });

  // Regression for an external-review finding: adjusted R² used (n − 1) total df unconditionally, which
  // is wrong for a through-the-origin fit (no mean is estimated ⇒ total df is n). Here n=4, k=1, so the
  // old formula degenerated to adjR² == R²; the correct one applies a genuine penalty (< R²).
  it('adjusted R² uses n (not n−1) total df when intercept:false', () => {
    const x = [1, 2, 3, 4];
    const y = [2, 3, 7, 8]; // imperfect fit ⇒ R² strictly below 1
    const r = ols(
      y,
      x.map((v) => [v]),
      { intercept: false },
    );
    const expected =
      1 - ((1 - r.rSquared) * r.observationCount) / (r.observationCount - r.coefficientCount); // n, not n−1
    expect(r.adjustedRSquared).toBeCloseTo(expected, 12);
    expect(r.adjustedRSquared).toBeLessThan(r.rSquared); // the old (n−1) formula gave adjR² == R² here
  });

  // Regression for an external-review finding: the solver used the normal equations (XᵀX), squaring
  // the condition number; a perfectly collinear design must be rejected, not silently blown up.
  it('rejects a rank-deficient (collinear) design instead of returning garbage', () => {
    const rows = [
      [1, 2],
      [2, 4],
      [3, 6],
      [4, 8], // column 2 = 2 × column 1
    ];
    const y = [1, 2, 3, 4];
    let caught: unknown;
    try {
      ols(y, rows, { intercept: false });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'linalg.singular')).toBe(true);
  });
});

describe('ols — noisy fit (properties + HAC)', () => {
  it('rSquared ∈ (0,1), standardErrors > 0, and HAC differs from OLS on autocorrelated residuals', () => {
    const rnd = lcg(20240607);
    const n = 240;
    const x: number[] = [];
    const y: number[] = [];
    let e = 0;
    for (let i = 0; i < n; i++) {
      const xi = i / 10;
      // AR(1) residual (φ=0.8) ⇒ strong serial correlation ⇒ HAC ≠ OLS standard errors.
      e = 0.8 * e + (rnd() - 0.5);
      x.push(xi);
      y.push(1 + 0.5 * xi + e);
    }
    const plain = ols(
      y,
      x.map((v) => [v]),
    );
    const hac = ols(
      y,
      x.map((v) => [v]),
      { hac: { lags: 8 } },
    );

    expect(plain.rSquared).toBeGreaterThan(0);
    expect(plain.rSquared).toBeLessThan(1);
    for (const se of plain.standardErrors) expect(se).toBeGreaterThan(0);

    // Point estimates are unchanged; only the covariance (hence SE / t) changes.
    expect(hac.coefficients[0]).toBeCloseTo(plain.coefficients[0]!, 12);
    expect(hac.coefficients[1]).toBeCloseTo(plain.coefficients[1]!, 12);

    // The slope's HAC standard error is materially different from the classical one.
    const seOls = plain.standardErrors[1]!;
    const seHac = hac.standardErrors[1]!;
    expect(Math.abs(seHac - seOls) / seOls).toBeGreaterThan(0.05);
    for (const se of hac.standardErrors) expect(se).toBeGreaterThan(0);
  });
});

describe('ols — validation (design law #4)', () => {
  const response = [1, 2.1, 2.9, 4.2, 4.8, 6.1];
  const design = [[1], [2], [3], [4], [5], [6]];

  it('rejects unknown, null, and wrong-typed nested options before fitting', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [{ typo: true }, 'input.unknown_field'],
      [{ intercept: null }, 'input.wrong_type'],
      [{ intercept: 'false' }, 'input.wrong_type'],
      [{ hac: null }, 'input.wrong_type'],
      [{ hac: {} }, 'input.missing_field'],
      [{ hac: { lags: '4' } }, 'input.wrong_type'],
      [{ hac: { lags: Number.NaN } }, 'input.not_finite'],
      [{ hac: { lags: 1, typo: true } }, 'input.unknown_field'],
    ];
    for (const [options, code] of cases) {
      let caught: unknown;
      try {
        ols(response, design, options as never);
      } catch (error) {
        caught = error;
      }
      expect(isQuantError(caught, code), JSON.stringify(options)).toBe(true);
    }
  });

  it('throws on a row/response length mismatch', () => {
    expect(() => ols([1, 2, 3], [[1], [2]])).toThrow();
  });

  it('throws on ragged design rows', () => {
    expect(() => ols([1, 2, 3], [[1], [2, 3], [4]])).toThrow();
  });

  it('throws on a rank-deficient design (duplicate predictor)', () => {
    const X = [
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
    ];
    const y = [2, 3, 5, 4, 8];
    expect(() => ols(y, X)).toThrow();
  });

  it('throws when there are not more observations than coefficients', () => {
    expect(() =>
      ols(
        [1, 2],
        [
          [1, 0],
          [0, 1],
        ],
      ),
    ).toThrow();
  });
});
