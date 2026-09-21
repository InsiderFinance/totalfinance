/**
 * Ordinary least squares regression (spec §9.1) with optional Newey–West HAC standard errors.
 *
 * `ols` fits `y = Xβ + ε` by QR factorization of the design matrix (`β` solves `R·β = Qᵀy`), which is
 * numerically stable — it avoids forming `XᵀX` and squaring the condition number that the normal
 * equations would incur. The classical covariance still uses `(XᵀX)⁻¹`, but obtained as `R⁻¹R⁻ᵀ` from
 * the same `R` factor. The design matrix `X` is passed WITHOUT an intercept column; one is prepended
 * unless `intercept: false`.
 *
 * Standard errors default to the classical homoskedastic estimator `σ̂²(XᵀX)⁻¹`. When
 * `options.hac = { lags }` is supplied, the coefficient covariance is replaced by the Newey–West (1987)
 * heteroskedasticity- and autocorrelation-consistent sandwich with a Bartlett kernel of bandwidth
 * `lags`, and the reported `standardErrors`/`tStatistics` are recomputed from it. This matters when residuals are
 * serially correlated (e.g. overlapping returns), where classical errors understate uncertainty.
 *
 * Design law #4 (no fake successes): rank-deficient or under-determined designs throw `InputError`
 * rather than silently returning a degenerate fit.
 */

import {
  ensureKnownKeys,
  ErrorCode,
  InputError,
  missingFieldError,
  requireArgumentObject,
} from '@totalfinance/core';
import type { Matrix } from './linalg.js';
import { matrixMultiply, matrixVectorProduct, qrDecompose, transpose } from './linalg.js';

/** Newey–West HAC configuration: Bartlett-kernel bandwidth (number of lags). */
export interface OlsHacOptions {
  /** Bartlett-kernel bandwidth `L`; weights are `1 − j/(L+1)` for lag `j = 1..L`. `L = 0` ⇒ White (HC0). */
  lags: number;
}

export interface OlsOptions {
  /** Prepend an intercept column of ones (default `true`). */
  intercept?: boolean;
  /** Replace the classical covariance with the Newey–West HAC estimator. */
  hac?: OlsHacOptions;
}

export interface OlsResult {
  /** Fitted coefficients; the intercept is first when `intercept !== false`. */
  coefficients: number[];
  /** Standard error of each coefficient (√ of the covariance diagonal). */
  standardErrors: number[];
  /** t-statistic `βⱼ / se(βⱼ)` for each coefficient. */
  tStatistics: number[];
  /** Coefficient of determination `R²` (centered when an intercept is present). */
  rSquared: number;
  /** Degrees-of-freedom-adjusted `R̄²`. */
  adjustedRSquared: number;
  /** Residuals `y − Xβ`, aligned to the input rows. */
  residuals: number[];
  /** Number of observations. */
  observationCount: number;
  /** Number of estimated coefficients (including the intercept). */
  coefficientCount: number;
}

const OLS_OPTION_KEYS = ['intercept', 'hac'] as const satisfies readonly (keyof OlsOptions)[];
const OLS_HAC_OPTION_KEYS = ['lags'] as const satisfies readonly (keyof OlsHacOptions)[];

/** Validate the complete nested OLS options boundary before matrix work begins. */
function requireOlsOptions(options: OlsOptions): void {
  requireArgumentObject('ols', 'options', options);
  ensureKnownKeys('ols', 'options', options, OLS_OPTION_KEYS);
  if (options.intercept !== undefined && typeof options.intercept !== 'boolean') {
    throw new InputError(
      `ols: options.intercept must be a boolean when provided. Received ${options.intercept === null ? 'null' : typeof options.intercept}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {
          function: 'ols',
          field: 'options.intercept',
          received: options.intercept === null ? 'null' : typeof options.intercept,
        },
      },
    );
  }
  if (options.hac === undefined) return;
  requireArgumentObject('ols', 'options.hac', options.hac);
  ensureKnownKeys('ols', 'options.hac', options.hac, OLS_HAC_OPTION_KEYS);
  const lags = options.hac.lags;
  if (lags === undefined) {
    throw missingFieldError(
      'ols',
      'options.hac.lags',
      'ols(response, design, { hac: { lags: 4 } })',
      'Newey–West bandwidth; use 0 for White (HC0) standard errors',
    );
  }
  if (typeof lags !== 'number') {
    throw new InputError(
      `ols: options.hac.lags must be a number. Received ${lags === null ? 'null' : typeof lags}.`,
      {
        code: ErrorCode.InputWrongType,
        context: {
          function: 'ols',
          field: 'options.hac.lags',
          received: lags === null ? 'null' : typeof lags,
        },
      },
    );
  }
  if (!Number.isFinite(lags)) {
    throw new InputError(`ols: options.hac.lags must be finite. Received ${String(lags)}.`, {
      code: ErrorCode.InputNotFinite,
      context: { function: 'ols', field: 'options.hac.lags', received: lags },
    });
  }
}

/**
 * Invert an upper-triangular matrix `R` by back-substitution, throwing on a rank-deficient (singular)
 * design (design law #4): if a diagonal pivot is negligible relative to the largest, the regressors
 * are collinear and the fit is not identifiable — we reject rather than return blown-up coefficients.
 */
function invertUpperTriangular(R: Matrix, functionName: string): Matrix {
  const k = R.length;
  let maxD = 0;
  for (let i = 0; i < k; i++) maxD = Math.max(maxD, Math.abs(R[i]![i]!));
  for (let i = 0; i < k; i++) {
    if (maxD === 0 || Math.abs(R[i]![i]!) <= 1e-12 * maxD) {
      throw new InputError(
        `${functionName}: design matrix is rank-deficient (collinear regressors — near-zero pivot ${R[i]![i]} in R).`,
        { code: ErrorCode.LinalgSingular, context: { index: i, pivot: R[i]![i], maxPivot: maxD } },
      );
    }
  }
  const inv: Matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let col = 0; col < k; col++) {
    for (let i = k - 1; i >= 0; i--) {
      let s = i === col ? 1 : 0;
      for (let j = i + 1; j < k; j++) s -= R[i]![j]! * inv[j]![col]!;
      inv[i]![col] = s / R[i]![i]!;
    }
  }
  return inv;
}

/** Newey–West Bartlett-kernel "meat" matrix `S = Ω₀ + Σⱼ wⱼ(Γⱼ + Γⱼᵀ)` from score vectors `gₜ = ûₜ·xₜ`. */
function neweyWestMeat(scores: number[][], k: number, lags: number): Matrix {
  const n = scores.length;
  const S: Matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  // Ω₀ = Σₜ gₜ gₜᵀ.
  for (let t = 0; t < n; t++) {
    const g = scores[t]!;
    for (let a = 0; a < k; a++) {
      const ga = g[a]!;
      if (ga === 0) continue;
      const row = S[a]!;
      for (let b = 0; b < k; b++) row[b]! += ga * g[b]!;
    }
  }
  // Cross-lag autocovariances with Bartlett weights.
  for (let j = 1; j <= lags; j++) {
    const w = 1 - j / (lags + 1);
    // Γⱼ = Σₜ gₜ g_{t−j}ᵀ. Add w·(Γⱼ + Γⱼᵀ).
    for (let t = j; t < n; t++) {
      const gt = scores[t]!;
      const gl = scores[t - j]!;
      for (let a = 0; a < k; a++) {
        const gta = gt[a]!;
        const gla = gl[a]!;
        const rowA = S[a]!;
        for (let b = 0; b < k; b++) {
          rowA[b]! += w * (gta * gl[b]! + gla * gt[b]!);
        }
      }
    }
  }
  return S;
}

/**
 * Ordinary least squares fit of `y` on `X` (rows = observations, columns = predictors, no intercept
 * column). Returns coefficients, standard errors, t-statistics, `R²`/`R̄²`, and residuals.
 *
 * @param y  Response vector, length `n`.
 * @param X  Design rows, `n × p` (predictors only; the intercept is added unless disabled).
 * @param options.intercept  Prepend an intercept column (default `true`).
 * @param options.hac  Newey–West HAC standard errors with a Bartlett kernel of the given bandwidth.
 */
export function ols(response: number[], design: number[][], options: OlsOptions = {}): OlsResult {
  requireOlsOptions(options);
  const intercept = options.intercept !== false;
  const n = response.length;
  if (n === 0) {
    throw new InputError('ols: y must be non-empty.', {
      code: ErrorCode.InputOutOfRange,
      context: { observations: n },
    });
  }
  if (design.length !== n) {
    throw new InputError(`ols: X has ${design.length} rows but y has length ${n}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { xRows: design.length, yLen: n },
    });
  }
  const p = design[0]?.length ?? 0;
  for (let i = 0; i < n; i++) {
    if ((design[i]?.length ?? 0) !== p) {
      throw new InputError(`ols: X row ${i} has length ${design[i]?.length ?? 0}, expected ${p}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { row: i, got: design[i]?.length ?? 0, expected: p },
      });
    }
    if (!Number.isFinite(response[i]!)) {
      throw new InputError(`ols: y[${i}] is not finite.`, {
        code: ErrorCode.InputNotFinite,
        context: { index: i, value: response[i] },
      });
    }
    for (let j = 0; j < p; j++) {
      if (!Number.isFinite(design[i]![j]!)) {
        throw new InputError(`ols: X[${i}][${j}] is not finite.`, {
          code: ErrorCode.InputNotFinite,
          context: { row: i, col: j, value: design[i]![j] },
        });
      }
    }
  }
  const k = p + (intercept ? 1 : 0);
  if (k === 0) {
    throw new InputError('ols: model has no regressors (empty X and intercept disabled).', {
      code: ErrorCode.InputOutOfRange,
      context: { p, intercept },
    });
  }
  if (n <= k) {
    throw new InputError(`ols: needs more observations than coefficients (n=${n} ≤ k=${k}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { observations: n, k },
    });
  }

  // Build the design matrix D (n × k) with the intercept column first when requested.
  const D: Matrix = Array.from({ length: n }, (_, i) => {
    const row = new Array<number>(k);
    let c = 0;
    if (intercept) row[c++] = 1;
    for (let j = 0; j < p; j++) row[c++] = design[i]![j]!;
    return row;
  });

  // Solve the least-squares system by QR (D = QR): β solves R·β = Qᵀy. This is numerically stable —
  // it avoids forming XᵀX and squaring the condition number the normal equations would incur. The
  // classical covariance still needs (XᵀX)⁻¹, obtained as R⁻¹R⁻ᵀ from the same R factor.
  const { q, r } = qrDecompose(D);
  const Rinv = invertUpperTriangular(r, 'ols');
  const qty = matrixVectorProduct(transpose(q), response); // Qᵀy, length k
  const coefficients = matrixVectorProduct(Rinv, qty); // β = R⁻¹ Qᵀ y
  const XtXinv = matrixMultiply(Rinv, transpose(Rinv)); // (XᵀX)⁻¹ = R⁻¹ R⁻ᵀ

  // Residuals and fit statistics.
  const fitted = matrixVectorProduct(D, coefficients);
  const residuals = new Array<number>(n);
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const r = response[i]! - fitted[i]!;
    residuals[i] = r;
    rss += r * r;
  }
  let yBar = 0;
  for (let i = 0; i < n; i++) yBar += response[i]!;
  yBar /= n;
  let tss = 0;
  for (let i = 0; i < n; i++) {
    const d = intercept ? response[i]! - yBar : response[i]!;
    tss += d * d;
  }
  const rSquared = tss > 0 ? 1 - rss / tss : 0;
  // Adjusted R² uses the total degrees of freedom: (n − 1) when an intercept absorbs the mean, but n
  // for a through-the-origin fit (no mean is estimated, so no df is spent on it). Using (n − 1) for an
  // intercept-free model — as the naïve formula does — overstates the penalty and misreports R̄².
  const totalDf = intercept ? n - 1 : n;
  const adjustedRSquared = 1 - ((1 - rSquared) * totalDf) / (n - k);
  const sigma2 = rss / (n - k);

  // Coefficient covariance: classical σ̂²(XᵀX)⁻¹, or the Newey–West HAC sandwich.
  let covariance: Matrix;
  if (options.hac) {
    const lags = options.hac.lags;
    // Safe integer AND a data bound (2026-08-23 review, P0 "unbounded work"): the Newey–West outer
    // loop runs `lags` iterations REGARDLESS of the sample — for j ≥ n every Γⱼ is identically zero
    // (there are only n − 1 sample autocovariances) yet each still costs an iteration, so
    // `Number.isInteger(1e308)` passing here was an effectively non-terminating loop of empty work
    // (and above 2^53 the loop counter literally stops advancing). A bandwidth of n − 1 already
    // includes every estimable autocovariance; standard practice is ~⌊4(n/100)^{2/9}⌋, far below it.
    if (!Number.isSafeInteger(lags) || lags < 0 || lags > n - 1) {
      throw new InputError(
        `ols: hac.lags must be an integer in [0, ${n - 1}] (n − 1 = ${n - 1} for this fit) — a sample of n observations has only n − 1 estimable autocovariances, so a larger Newey–West bandwidth adds nothing but dead loop iterations. Received ${lags}.\n  e.g. ols(y, x, { hac: { lags: 4 } })`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { lags, max: n - 1 },
        },
      );
    }
    // Score vectors gₜ = ûₜ · xₜ (row of the design matrix).
    const scores: number[][] = Array.from({ length: n }, (_, t) => {
      const g = new Array<number>(k);
      const u = residuals[t]!;
      const row = D[t]!;
      for (let a = 0; a < k; a++) g[a] = u * row[a]!;
      return g;
    });
    const S = neweyWestMeat(scores, k, lags);
    // V = (XᵀX)⁻¹ S (XᵀX)⁻¹, with a finite-sample dof correction n/(n−k).
    const dof = n / (n - k);
    const mid = matrixMultiply(XtXinv, S);
    covariance = matrixMultiply(mid, XtXinv);
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) covariance[a]![b]! *= dof;
  } else {
    covariance = Array.from({ length: k }, (_, a) =>
      Array.from({ length: k }, (_, b) => sigma2 * XtXinv[a]![b]!),
    );
  }

  const standardErrors = new Array<number>(k);
  const tStatistics = new Array<number>(k);
  for (let a = 0; a < k; a++) {
    const v = covariance[a]![a]!;
    const se = v > 0 ? Math.sqrt(v) : 0;
    standardErrors[a] = se;
    tStatistics[a] = se > 0 ? coefficients[a]! / se : NaN;
  }

  return {
    coefficients,
    standardErrors,
    tStatistics,
    rSquared,
    adjustedRSquared,
    residuals,
    observationCount: n,
    coefficientCount: k,
  };
}
