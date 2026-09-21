/**
 * Dense linear algebra for small matrices (spec §8.3).
 *
 * Cholesky factorization, a symmetric Jacobi eigensolver, covariance-matrix construction, and
 * nearest positive-semidefinite / correlation repair (eigenvalue clipping). Pure TypeScript
 * reference implementations; acceleration is a later concern.
 */

import {
  ensureKnownKeys,
  requireArgumentObject,
  CONVENTIONS_VERSION,
  ConvergenceError,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  warning,
  WarningCode,
} from '@totalfinance/core';
import type { PopulationOptions } from './statistics.js';
import { requireMathIterationBudgetWhenPresent } from './resource-validation.js';
import {
  covarianceValidated,
  POPULATION_OPTIONS_SPEC,
  validateOptions,
} from './statistics-internal.js';

export type Matrix = number[][];

/** Cholesky factorization: lower-triangular `L` with `A = L Lᵀ`. Throws if `A` is not PD. */
export function cholesky(matrix: Matrix): Matrix {
  const n = matrix.length;
  const L: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = 0;
      for (let k = 0; k < j; k++) s += L[i]![k]! * L[j]![k]!;
      if (i === j) {
        const d = matrix[i]![i]! - s;
        // `!(d > 0)` (not `d <= 0`) so a NaN pivot — a NaN-carrying covariance matrix — throws the
        // documented not-positive-definite error instead of flowing NaN into every simulation path.
        if (!(d > 0)) {
          throw new InputError(`cholesky: matrix is not positive definite (pivot ${d} at ${i}).`, {
            code: ErrorCode.LinalgNotPositiveDefinite,
            context: { pivot: d, index: i },
          });
        }
        L[i]![j] = Math.sqrt(d);
      } else {
        L[i]![j] = (matrix[i]![j]! - s) / L[j]![j]!;
      }
    }
  }
  return L;
}

/** Solve `A x = b` given the Cholesky factor `L` of `A`. */
export function choleskySolve(L: Matrix, b: number[]): number[] {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i]![k]! * y[k]!;
    y[i] = s / L[i]![i]!;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k]![i]! * x[k]!;
    x[i] = s / L[i]![i]!;
  }
  return x;
}

/** Covariance matrix of a set of equal-length variables (`series[k]` is variable k). */
export function covarianceMatrix(series: number[][], options?: PopulationOptions): Matrix {
  // Law 12 at THIS boundary, against THIS declaration — validated ONCE, with the same
  // compiler-exact spec the statistics module uses. The pairwise loop below goes through the
  // package-internal `covarianceValidated`, so no per-pair revalidation and no forwarding into
  // `covariance`'s wider allowlist (which would accept a `nanPolicy` this signature never
  // declared, engaging pairwise deletion no caller was offered).
  validateOptions('covarianceMatrix', options, POPULATION_OPTIONS_SPEC);
  const k = series.length;
  const M: Matrix = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      const c = covarianceValidated(series[i]!, series[j]!, options, 'covarianceMatrix');
      M[i]![j] = c;
      M[j]![i] = c;
    }
  }
  return M;
}

/**
 * Validate a variable-observation series (`series[k]` = variable k's observations): a non-empty,
 * rectangular array of ≥ 2 finite observations per variable. Returns the shape `{ p, T }`. Shared by the
 * covariance estimators so they all reject the same malformed inputs the same way.
 */
function validateReturnsSeries(series: number[][], functionName: string): { p: number; T: number } {
  if (!Array.isArray(series) || series.length === 0) {
    throw new InputError(
      `${functionName}: series must be a non-empty array of variable observations.`,
      {
        code: ErrorCode.InputWrongType,
        context: { series },
      },
    );
  }
  const p = series.length;
  if (!Array.isArray(series[0])) {
    throw new InputError(`${functionName}: series[0] must be an array of observations.`, {
      code: ErrorCode.InputWrongType,
      context: { row: 0 },
    });
  }
  const T = series[0]!.length;
  if (!(T >= 2)) {
    throw new InputError(`${functionName}: need at least 2 observations per variable, got ${T}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { observations: T },
    });
  }
  for (let k = 0; k < p; k++) {
    const row = series[k]!;
    if (!Array.isArray(row) || row.length !== T) {
      throw new InputError(
        `${functionName}: every variable must have the same number of observations (${T}); series[${k}] has ${Array.isArray(row) ? row.length : 'non-array'}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { row: k, length: Array.isArray(row) ? row.length : null },
        },
      );
    }
    for (let t = 0; t < T; t++) {
      if (!Number.isFinite(row[t]!)) {
        throw new InputError(`${functionName}: series[${k}][${t}] is not finite (${row[t]}).`, {
          code: ErrorCode.InputNotFinite,
          context: { row: k, index: t, value: row[t] },
        });
      }
    }
  }
  return { p, T };
}

/** Options for {@link ledoitWolfShrinkage}. */
export interface LedoitWolfOptions {
  /**
   * Shrinkage target: `'identity'` (the scaled identity `μI`, the default and original),
   * `'constant-correlation'` (the Ledoit–Wolf 2004 target — each variable's own variance with the
   * **average** sample correlation on every off-diagonal, which fits correlated asset returns far better), or
   * `'single-index'` (the Ledoit–Wolf 2003 market-model target — a one-factor structure built from each
   * variable's covariance with the equal-weighted market, the best-specified target for stock returns).
   */
  target?: 'identity' | 'constant-correlation' | 'single-index';
  /**
   * Observed market return series (length `T`, chronological) for the `'single-index'` target.
   * When omitted the equal-weight cross-sectional average of `series` is used as the market proxy
   * (Ledoit–Wolf 2003's construction); {@link estimateCovariance} discloses which was used.
   */
  market?: ArrayLike<number>;
}

/** The Ledoit–Wolf shrunk covariance and the intensity that produced it. */
export interface LedoitWolfResult {
  /** Shrunk covariance `Σ* = δ·F + (1−δ)·S` (`F` = the chosen target) — symmetric positive-definite even when `T < p`. */
  covariance: Matrix;
  /** Optimal shrinkage intensity `δ ∈ [0, 1]`. */
  shrinkage: number;
  /** Raw sample covariance `S` (`1/T` / MLE normalization). */
  sampleCovariance: Matrix;
  /** Average variance `μ = tr(S)/p` — the scaled-identity target's diagonal. */
  averageVariance: number;
  /** Number of observations `T`. */
  observations: number;
  /** The shrinkage target used. */
  target: 'identity' | 'constant-correlation' | 'single-index';
  /** Average off-diagonal sample correlation `r̄` — the constant-correlation target's correlation (that target only). */
  averageCorrelation?: number;
  /** Variance of the equal-weighted market proxy `varmkt` — the single-index target's factor variance (that target only). */
  marketVariance?: number;
}

/**
 * Ledoit–Wolf (2004) linear covariance shrinkage toward the scaled identity `μI` (`μ = tr(S)/p`):
 * `Σ* = δ·μI + (1−δ)·S` with the analytically optimal intensity `δ = min(b̄², d²)/d²`, where
 * `d² = ‖S − μI‖²_F` and `b̄² = (1/T²)·Σₜ‖xₜxₜᵀ − S‖²_F` estimates the sampling error in `S`. The result
 * is always SPD (for non-degenerate data), so it is invertible even when the raw sample covariance `S`
 * is singular (`T < p`). `series[k]` is variable k's observations (p variables × T), matching
 * {@link covarianceMatrix}. See `docs/specs/ledoit-wolf-shrinkage.md`.
 */
function linalgOptionLadder(
  functionName: string,
  options: Record<string, unknown>,
  allowed: readonly string[],
  numericFields: readonly string[],
): void {
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, allowed);
  for (const field of numericFields) {
    const value = options[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new InputError(
        `${functionName}: ${field} must be a finite number when provided — omit the field to use the default. Received ${value === null ? 'null' : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
      );
    }
  }
}

export function ledoitWolfShrinkage(
  series: number[][],
  options: LedoitWolfOptions = {},
): LedoitWolfResult {
  const functionName = 'ledoitWolfShrinkage';
  const { p, T } = validateReturnsSeries(series, functionName);
  linalgOptionLadder(
    'ledoitWolfShrinkage',
    options as unknown as Record<string, unknown>,
    ['target', 'market'],
    [],
  );
  if (
    options.target !== undefined &&
    !['identity', 'constant-correlation', 'single-index'].includes(options.target as string)
  ) {
    throw new InputError(
      `ledoitWolfShrinkage: target must be identity | constant-correlation | single-index when provided. Received ${options.target === null ? 'null' : JSON.stringify(options.target)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'target' } },
    );
  }
  if (
    options.market !== undefined &&
    !Array.isArray(options.market) &&
    !ArrayBuffer.isView(options.market)
  ) {
    throw new InputError(
      `ledoitWolfShrinkage: market must be an array of market returns when provided. Received ${options.market === null ? 'null' : typeof options.market}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'market' } },
    );
  }
  const target = options.target ?? 'identity';
  const means = new Array<number>(p);
  for (let k = 0; k < p; k++) {
    let sum = 0;
    for (let t = 0; t < T; t++) sum += series[k]![t]!;
    means[k] = sum / T;
  }

  // Sample covariance S (1/T / MLE) and the average variance μ.
  const S = covarianceMatrix(series, { population: true });
  let mu = 0;
  for (let i = 0; i < p; i++) mu += S[i]![i]!;
  mu /= p;

  if (target === 'constant-correlation') {
    return constantCorrelationShrinkage(series, S, means, mu, p, T, functionName);
  }
  if (target === 'single-index') {
    return singleIndexShrinkage(series, S, means, mu, p, T, functionName, options.market);
  }

  // ── identity target: Σ* = δ·μI + (1−δ)·S ──
  // d² = ‖S − μI‖²_F (how far the sample is from the target).
  let d2 = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      const difference = S[i]![j]! - (i === j ? mu : 0);
      d2 += difference * difference;
    }
  }

  // b̄² = (1/T²)·Σₜ ‖xₜxₜᵀ − S‖²_F (the sampling error in S), clamped so δ ∈ [0, 1].
  let bbar = 0;
  const x = new Array<number>(p);
  for (let t = 0; t < T; t++) {
    for (let i = 0; i < p; i++) x[i] = series[i]![t]! - means[i]!;
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        const difference = x[i]! * x[j]! - S[i]![j]!;
        bbar += difference * difference;
      }
    }
  }
  bbar /= T * T;
  const b2 = Math.min(bbar, d2);
  const delta = d2 > 0 ? b2 / d2 : 0;

  // Σ* = δ·μI + (1−δ)·S.
  const covariance: Matrix = S.map((row, i) =>
    row.map((v, j) => delta * (i === j ? mu : 0) + (1 - delta) * v),
  );

  return {
    covariance,
    shrinkage: delta,
    sampleCovariance: S,
    averageVariance: mu,
    observations: T,
    target: 'identity',
  };
}

/**
 * Ledoit–Wolf (2004, "Honey, I Shrunk the Sample Covariance Matrix") shrinkage toward the
 * **constant-correlation** target `F` (`Fᵢᵢ = Sᵢᵢ`, `Fᵢⱼ = r̄·√(SᵢᵢSⱼⱼ)`, `r̄` the average sample
 * correlation), with the paper's closed-form intensity `δ* = (π̂ − ρ̂)/γ̂ / T` clamped to `[0, 1]`. See
 * `docs/specs/ledoit-wolf-constant-correlation.md`.
 */
function constantCorrelationShrinkage(
  series: number[][],
  S: Matrix,
  means: number[],
  mu: number,
  p: number,
  T: number,
  functionName: string,
): LedoitWolfResult {
  // Correlations need positive variances; a constant (zero-variance) variable makes the target undefined.
  const sd = new Array<number>(p);
  for (let i = 0; i < p; i++) {
    if (!(S[i]![i]! > 0)) {
      throw new InputError(
        `${functionName}: the constant-correlation target needs positive variances; variable ${i} has zero sample variance.`,
        { code: ErrorCode.InputOutOfRange, context: { variable: i } },
      );
    }
    sd[i] = Math.sqrt(S[i]![i]!);
  }

  // r̄ = mean of the p(p−1)/2 off-diagonal sample correlations.
  let rsum = 0;
  let cnt = 0;
  for (let i = 0; i < p; i++) {
    for (let j = i + 1; j < p; j++) {
      rsum += S[i]![j]! / (sd[i]! * sd[j]!);
      cnt++;
    }
  }
  const rbar = cnt > 0 ? rsum / cnt : 0;

  // Target F.
  const F: Matrix = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? S[i]![i]! : rbar * sd[i]! * sd[j]!)),
  );

  // Demeaned observations x[i][t].
  const x: number[][] = series.map((row, i) => row.map((v) => v - means[i]!));

  // π̂ᵢⱼ = (1/T)Σₜ (xᵢₜxⱼₜ − Sᵢⱼ)² (asymptotic variance of Sᵢⱼ); π̂ = Σπ̂ᵢⱼ.
  const piHat: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  let pi = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) {
        const d = x[i]![t]! * x[j]![t]! - S[i]![j]!;
        s += d * d;
      }
      piHat[i]![j] = s / T;
      pi += piHat[i]![j]!;
    }
  }

  // γ̂ = ‖F − S‖²_F (target misspecification).
  let gamma = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      const d = F[i]![j]! - S[i]![j]!;
      gamma += d * d;
    }
  }

  // ρ̂ = Σᵢ π̂ᵢᵢ + Σ_{i≠j} (r̄/2)(√(Sⱼⱼ/Sᵢᵢ)·ϑ̂ᵢ,ᵢⱼ + √(Sᵢᵢ/Sⱼⱼ)·ϑ̂ⱼ,ᵢⱼ),
  //   ϑ̂ₖ,ᵢⱼ = (1/T)Σₜ (xₖₜ² − Sₖₖ)(xᵢₜxⱼₜ − Sᵢⱼ) (cov of the diagonal & off-diagonal estimates).
  const thetaTerm = (k: number, i: number, j: number): number => {
    let s = 0;
    for (let t = 0; t < T; t++) {
      s += (x[k]![t]! * x[k]![t]! - S[k]![k]!) * (x[i]![t]! * x[j]![t]! - S[i]![j]!);
    }
    return s / T;
  };
  let rho = 0;
  for (let i = 0; i < p; i++) rho += piHat[i]![i]!;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      if (i === j) continue;
      rho +=
        (rbar / 2) *
        ((sd[j]! / sd[i]!) * thetaTerm(i, i, j) + (sd[i]! / sd[j]!) * thetaTerm(j, i, j));
    }
  }

  const kappa = gamma > 0 ? (pi - rho) / gamma : 0;
  const delta = Math.max(0, Math.min(1, kappa / T));

  // Σ* = δ·F + (1−δ)·S.
  const covariance: Matrix = S.map((row, i) =>
    row.map((v, j) => delta * F[i]![j]! + (1 - delta) * v),
  );

  return {
    covariance,
    shrinkage: delta,
    sampleCovariance: S,
    averageVariance: mu,
    observations: T,
    target: 'constant-correlation',
    averageCorrelation: rbar,
  };
}

/**
 * Ledoit–Wolf (2003, "Improved estimation of the covariance matrix of stock returns…") shrinkage toward the
 * **single-index (market-model)** target `F`: `Fᵢⱼ = covmktᵢ·covmktⱼ/varmkt` off-diagonal, `Fᵢᵢ = Sᵢᵢ`, where
 * the market proxy is the equal-weighted average return, `covmktᵢ = Cov(xᵢ, x_mkt)`, `varmkt = Var(x_mkt)`.
 * Intensity `δ* = (π̂ − ρ̂)/γ̂ / T` clamped to `[0, 1]` with the paper's market-specific `ρ̂`. See
 * `docs/specs/ledoit-wolf-single-index.md`.
 */
function singleIndexShrinkage(
  series: number[][],
  S: Matrix,
  means: number[],
  mu: number,
  p: number,
  T: number,
  functionName: string,
  market?: ArrayLike<number>,
): LedoitWolfResult {
  // Demeaned observations x[i][t].
  const x: number[][] = series.map((row, i) => row.map((v) => v - means[i]!));
  // Market factor: the caller's observed series when given (demeaned), else the equal-weighted
  // cross-sectional average return — the Ledoit–Wolf (2003) proxy, disclosed by the front door.
  const xmkt = new Array<number>(T);
  if (market !== undefined) {
    if (market.length !== T) {
      throw new InputError(
        `${functionName}: market series length ${market.length} must equal the observation count T = ${T}.`,
        { code: ErrorCode.InputWrongShape, context: { marketLength: market.length, T } },
      );
    }
    let mmean = 0;
    for (let t = 0; t < T; t++) {
      const v = market[t]!;
      if (!Number.isFinite(v)) {
        throw new InputError(
          `${functionName}: market[${t}] must be a finite number. Received ${v}.`,
          {
            code: ErrorCode.InputNotFinite,
            context: { index: t },
          },
        );
      }
      mmean += v;
    }
    mmean /= T;
    for (let t = 0; t < T; t++) xmkt[t] = market[t]! - mmean;
  } else {
    for (let t = 0; t < T; t++) {
      let s = 0;
      for (let i = 0; i < p; i++) s += x[i]![t]!;
      xmkt[t] = s / p;
    }
  }
  let varmkt = 0;
  for (let t = 0; t < T; t++) varmkt += xmkt[t]! * xmkt[t]!;
  varmkt /= T;
  if (!(varmkt > 0)) {
    throw new InputError(
      `${functionName}: the single-index target needs a non-degenerate market (Var of the equal-weighted average return is 0) — the market-model target is undefined.`,
      { code: ErrorCode.InputOutOfRange, context: { varmkt } },
    );
  }
  // covmkt[i] = Cov(x_i, x_mkt).
  const covmkt = new Array<number>(p);
  for (let i = 0; i < p; i++) {
    let s = 0;
    for (let t = 0; t < T; t++) s += x[i]![t]! * xmkt[t]!;
    covmkt[i] = s / T;
  }

  // Target F: off-diagonal from the single market factor, diagonal keeps the sample variance.
  const F: Matrix = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (i === j ? S[i]![i]! : (covmkt[i]! * covmkt[j]!) / varmkt)),
  );

  // π̂ᵢⱼ = (1/T)Σₜ (xᵢₜxⱼₜ − Sᵢⱼ)²; π̂ = Σπ̂ᵢⱼ; rdiag = Σᵢ π̂ᵢᵢ. γ̂ = ‖F − S‖²_F.
  const piHat: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  let pi = 0;
  let gamma = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) {
        const d = x[i]![t]! * x[j]![t]! - S[i]![j]!;
        s += d * d;
      }
      piHat[i]![j] = s / T;
      pi += s / T;
      const g = F[i]![j]! - S[i]![j]!;
      gamma += g * g;
    }
  }
  let rdiag = 0;
  for (let i = 0; i < p; i++) rdiag += piHat[i]![i]!;

  // roff₁ = (1/varmkt)Σ_{i≠j} v1ᵢⱼ·covmktⱼ,  v1ᵢⱼ = (1/T)Σₜ xᵢₜ²·xⱼₜ·x_mkt,t − covmktᵢ·Sᵢⱼ.
  // roff₃ = (1/varmkt²)Σ_{i≠j} v3ᵢⱼ·covmktᵢ·covmktⱼ,  v3ᵢⱼ = (1/T)Σₜ xᵢₜxⱼₜ·x_mkt,t² − varmkt·Sᵢⱼ.
  let roff1 = 0;
  let roff3 = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      if (i === j) continue;
      let s1 = 0;
      let s3 = 0;
      for (let t = 0; t < T; t++) {
        const xi = x[i]![t]!;
        const xj = x[j]![t]!;
        const mkt = xmkt[t]!;
        s1 += xi * xi * xj * mkt;
        s3 += xi * xj * mkt * mkt;
      }
      const v1 = s1 / T - covmkt[i]! * S[i]![j]!;
      const v3 = s3 / T - varmkt * S[i]![j]!;
      roff1 += v1 * covmkt[j]!;
      roff3 += v3 * covmkt[i]! * covmkt[j]!;
    }
  }
  roff1 /= varmkt;
  roff3 /= varmkt * varmkt;
  const rho = rdiag + 2 * roff1 - roff3;

  const kappa = gamma > 0 ? (pi - rho) / gamma : 0;
  const delta = Math.max(0, Math.min(1, kappa / T));

  // Σ* = δ·F + (1−δ)·S.
  const covariance: Matrix = S.map((row, i) =>
    row.map((v, j) => delta * F[i]![j]! + (1 - delta) * v),
  );

  return {
    covariance,
    shrinkage: delta,
    sampleCovariance: S,
    averageVariance: mu,
    observations: T,
    target: 'single-index',
    marketVariance: varmkt,
  };
}

// ── covariance-estimation front door ───────────────────────────────────────────────────────────

/** Covariance estimator selector for {@link estimateCovariance}. */
export type CovarianceMethod = 'sample' | 'ledoit-wolf' | 'ridge' | 'ewma' | 'auto';

/** Options for {@link estimateCovariance}. */
export interface EstimateCovarianceOptions {
  /** Estimator; default `'auto'`. */
  method?: CovarianceMethod;
  /** Ridge diagonal load as a fraction of the average variance (method `'ridge'`). Default 0.1; > 0. */
  ridge?: number;
  /** Condition-number threshold above which `'auto'` shrinks rather than using the sample. Default 1e4. */
  conditionThreshold?: number;
  /** Population (`1/T`) vs sample (`1/(T−1)`) normalization. Default `true` (matches Ledoit–Wolf). */
  population?: boolean;
  /** EWMA decay `0 < λ < 1` (method `'ewma'`). Default 0.94 (RiskMetrics). */
  lambda?: number;
  /** EWMA half-life in periods (method `'ewma'`); `λ = 2^{−1/halfLife}` when `lambda` is omitted. */
  halfLife?: number;
  /**
   * Ledoit–Wolf shrinkage target when the method resolves to `'ledoit-wolf'` (explicitly or via `'auto'`).
   * `'identity'` (default), `'constant-correlation'` (fits correlated returns better), or `'single-index'`
   * (the market-model target, best-specified for stock returns).
   */
  ledoitWolfTarget?: 'identity' | 'constant-correlation' | 'single-index';
  /**
   * Observed market return series for the `'single-index'` target (length `T`). Omitted → the
   * equal-weight cross-sectional proxy is used and disclosed via `assumptions.marketProxy`.
   */
  market?: ArrayLike<number>;
}

/** A well-conditioned covariance estimate plus its conditioning diagnostics. */
export interface CovarianceEstimate {
  /** The estimated covariance. */
  covariance: Matrix;
  /** The estimator actually used (`'auto'` resolves to one of these). */
  method: 'sample' | 'ledoit-wolf' | 'ridge' | 'ewma';
  /** Number of variables `p`. */
  variables: number;
  /** Number of observations `T`. */
  observations: number;
  /** Smallest eigenvalue of the returned covariance. */
  minEigenvalue: number;
  /** Largest eigenvalue of the returned covariance. */
  maxEigenvalue: number;
  /** `maxEigenvalue / minEigenvalue` (`Infinity` when singular). */
  conditionNumber: number;
  /** Whether the returned covariance is positive-definite (invertible). */
  isPositiveDefinite: boolean;
  /** Number of eigenvalues `> 1e-9 · maxEigenvalue` — the effective rank. */
  effectiveRank: number;
  /** Ledoit–Wolf shrinkage intensity, present when `method` is `'ledoit-wolf'`. */
  shrinkage?: number;
  /** The EWMA decay used — present only for method `'ewma'`. */
  lambda?: number;
  /** Kish effective sample size `1/Σwₜ²` — present only for method `'ewma'`. */
  effectiveObservations?: number;
  assumptions: {
    conventionsVersion: string;
    method: string;
    population: boolean;
    /** Single-index target only: the caller's observed market series vs the equal-weight proxy. */
    marketProxy?: 'observed-series' | 'equal-weight';
  };
  diagnostics: Diagnostics;
}

/** Eigenvalue conditioning of a symmetric matrix. */
function conditioning(M: Matrix): {
  min: number;
  max: number;
  cond: number;
  spd: boolean;
  effectiveRank: number;
} {
  const { values } = jacobiEigen(M);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const cond = min > 0 ? max / min : Infinity;
  const spd = min > 1e-12 * max;
  const effectiveRank = values.filter((v) => v > 1e-9 * max).length;
  return { min, max, cond, spd, effectiveRank };
}

/**
 * The exponentially-weighted (RiskMetrics) covariance of a `p × T` chronological series (oldest first).
 * Weights `wₜ ∝ λ^{(T−1)−t}` (newest weighted most) normalized to sum 1; demeaned with the EWMA-weighted
 * mean; `population` selects the biased (`c = 1`) or unbiased weighted-covariance (`c = 1/(1 − Σwₜ²)`)
 * normalization. Returns the covariance and the Kish effective sample size `1/Σwₜ²`.
 */
function ewmaCovariance(
  series: number[][],
  lambda: number,
  population: boolean,
): { covariance: Matrix; effectiveObservations: number } {
  const p = series.length;
  const T = series[0]!.length;
  const w = new Array<number>(T);
  let wsum = 0;
  for (let t = 0; t < T; t++) {
    w[t] = Math.pow(lambda, T - 1 - t);
    wsum += w[t]!;
  }
  let w2 = 0;
  for (let t = 0; t < T; t++) {
    w[t]! /= wsum;
    w2 += w[t]! * w[t]!;
  }
  const mean = series.map((row) => {
    let m = 0;
    for (let t = 0; t < T; t++) m += w[t]! * row[t]!;
    return m;
  });
  const c = population ? 1 : 1 / (1 - w2);
  const covariance: Matrix = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let s = 0;
      for (let t = 0; t < T; t++)
        s += w[t]! * (series[i]![t]! - mean[i]!) * (series[j]![t]! - mean[j]!);
      covariance[i]![j] = s * c;
      covariance[j]![i] = covariance[i]![j]!;
    }
  }
  return { covariance, effectiveObservations: 1 / w2 };
}

/**
 * The covariance-estimation front door: turn a returns matrix into a well-conditioned (usually
 * invertible) covariance and report its **conditioning** so a caller knows whether it is safe to invert.
 * `'sample'` and `'ewma'` are the raw estimators (never altered; flagged + `converged: false` when
 * singular); `'ledoit-wolf'` and `'ridge'` GUARANTEE an SPD result — degenerate/collinear inputs are
 * eigenvalue-floored with a `math.covariance_floored` warning rather than returned singular; `'auto'`
 * (default) uses the sample when it is SPD and well-conditioned, else shrinks (inheriting the SPD
 * guarantee). `series[k]` is variable
 * k's observations (p × T), matching {@link covarianceMatrix}. See `docs/specs/estimate-covariance.md`.
 */
export function estimateCovariance(
  series: number[][],
  options: EstimateCovarianceOptions = {},
): CovarianceEstimate {
  const functionName = 'estimateCovariance';
  const { p, T } = validateReturnsSeries(series, functionName);
  linalgOptionLadder(
    'estimateCovariance',
    options as unknown as Record<string, unknown>,
    [
      'method',
      'ridge',
      'conditionThreshold',
      'population',
      'lambda',
      'halfLife',
      'ledoitWolfTarget',
      'market',
    ],
    ['ridge', 'conditionThreshold', 'lambda', 'halfLife'],
  );
  if (
    options.method !== undefined &&
    !['auto', 'sample', 'ledoit-wolf', 'ridge', 'ewma'].includes(options.method as string)
  ) {
    throw new InputError(
      `estimateCovariance: method must be auto | sample | ledoit-wolf | ridge | ewma when provided. Received ${options.method === null ? 'null' : JSON.stringify(options.method)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'method' } },
    );
  }
  if (options.population !== undefined && typeof options.population !== 'boolean') {
    throw new InputError(
      `estimateCovariance: population must be a boolean when provided. Received ${options.population === null ? 'null' : typeof options.population}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'population' } },
    );
  }
  if (
    options.ledoitWolfTarget !== undefined &&
    !['identity', 'constant-correlation', 'single-index'].includes(
      options.ledoitWolfTarget as string,
    )
  ) {
    throw new InputError(
      `estimateCovariance: ledoitWolfTarget must be identity | constant-correlation | single-index when provided. Received ${options.ledoitWolfTarget === null ? 'null' : JSON.stringify(options.ledoitWolfTarget)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'ledoitWolfTarget' } },
    );
  }
  if (
    options.market !== undefined &&
    !Array.isArray(options.market) &&
    !ArrayBuffer.isView(options.market)
  ) {
    throw new InputError(
      `estimateCovariance: market must be an array of market returns when provided. Received ${options.market === null ? 'null' : typeof options.market}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'market' } },
    );
  }
  const method: CovarianceMethod = options.method ?? 'auto';
  const population = options.population ?? true;
  const conditionThreshold = options.conditionThreshold ?? 1e4;

  const sample = covarianceMatrix(series, { population });
  const warnings: QuantWarning[] = [];

  let covariance: Matrix;
  let resolved: 'sample' | 'ledoit-wolf' | 'ridge' | 'ewma';
  let shrinkage: number | undefined;
  let ewmaLambda: number | undefined;
  let effectiveObservations: number | undefined;

  if (method === 'ewma') {
    let lambda: number;
    if (options.lambda !== undefined) {
      lambda = options.lambda;
      if (!(lambda > 0 && lambda < 1)) {
        throw new InputError(`${functionName}: lambda must be in (0, 1) (got ${lambda}).`, {
          code: ErrorCode.InputOutOfRange,
          context: { lambda },
        });
      }
    } else if (options.halfLife !== undefined) {
      if (!(options.halfLife > 0)) {
        throw new InputError(`${functionName}: halfLife must be > 0 (got ${options.halfLife}).`, {
          code: ErrorCode.InputOutOfRange,
          context: { halfLife: options.halfLife },
        });
      }
      lambda = Math.pow(2, -1 / options.halfLife);
    } else {
      lambda = 0.94; // RiskMetrics default
    }
    const ewma = ewmaCovariance(series, lambda, population);
    covariance = ewma.covariance;
    resolved = 'ewma';
    ewmaLambda = lambda;
    effectiveObservations = ewma.effectiveObservations;
    if (effectiveObservations < p) {
      warnings.push(
        warning(
          WarningCode.MathCovarianceEwmaEffectiveSample,
          `${functionName}: the EWMA effective sample (${effectiveObservations.toFixed(1)}) is below the ${p} variables (λ = ${lambda.toFixed(3)}) — the estimate is noisy; raise λ or add history.`,
          'warn',
          { effectiveObservations, variables: p, lambda },
        ),
      );
    }
  } else if (method === 'ridge') {
    const ridge = options.ridge ?? 0.1;
    if (!(ridge > 0)) {
      throw new InputError(`${functionName}: ridge must be > 0 (got ${ridge}).`, {
        code: ErrorCode.InputOutOfRange,
        context: { ridge },
      });
    }
    let averageVar = 0;
    for (let i = 0; i < p; i++) averageVar += sample[i]![i]!;
    averageVar /= p;
    const lambda = ridge * averageVar;
    covariance = sample.map((row, i) => row.map((v, j) => (i === j ? v + lambda : v)));
    resolved = 'ridge';
  } else if (method === 'ledoit-wolf') {
    const lw = ledoitWolfShrinkage(series, {
      target: options.ledoitWolfTarget ?? 'identity',
      ...(options.market !== undefined ? { market: options.market } : {}),
    });
    covariance = lw.covariance;
    shrinkage = lw.shrinkage;
    resolved = 'ledoit-wolf';
  } else if (method === 'sample') {
    covariance = sample;
    resolved = 'sample';
  } else {
    // 'auto' — use the sample when it is SPD and well-conditioned, otherwise shrink.
    const sc = conditioning(sample);
    if (sc.spd && sc.cond <= conditionThreshold) {
      covariance = sample;
      resolved = 'sample';
      warnings.push(
        warning(
          WarningCode.MathCovarianceMethodAuto,
          `${functionName}: the sample covariance is well-conditioned (condition number ${sc.cond.toExponential(1)} ≤ ${conditionThreshold.toExponential(0)}) — used as-is.`,
          'info',
          { chosen: 'sample', conditionNumber: sc.cond },
        ),
      );
    } else {
      const lw = ledoitWolfShrinkage(series, {
        target: options.ledoitWolfTarget ?? 'identity',
        ...(options.market !== undefined ? { market: options.market } : {}),
      });
      covariance = lw.covariance;
      shrinkage = lw.shrinkage;
      resolved = 'ledoit-wolf';
      warnings.push(
        warning(
          WarningCode.MathCovarianceMethodAuto,
          `${functionName}: the sample covariance is ${sc.spd ? `ill-conditioned (condition number ${sc.cond.toExponential(1)})` : 'singular'} — shrank to Ledoit–Wolf (δ = ${lw.shrinkage.toFixed(3)}).`,
          'info',
          { chosen: 'ledoit-wolf', sampleSpd: sc.spd, sampleCondition: sc.cond },
        ),
      );
    }
  }

  let cond = conditioning(covariance);
  // The front door's postcondition (Law 7 / spec P2.2): the SPD-PROMISING methods ('ledoit-wolf',
  // 'ridge' — and 'auto' when it resolves to them) always return an SPD covariance. Degenerate
  // inputs (constant series → zero matrix, perfectly collinear variables → singular shrunk
  // target) get a documented eigenvalue floor — Σ' = Σ + bump·I — plus a warning, never a silent
  // `isPositiveDefinite: false` "success". The explicitly-RAW estimators ('sample', 'ewma') are
  // never altered: they flag singularity honestly and report `converged: false` instead.
  if ((resolved === 'ledoit-wolf' || resolved === 'ridge') && !cond.spd) {
    let averageVar = 0;
    for (let i = 0; i < p; i++) averageVar += covariance[i]![i]!;
    averageVar /= p;
    const scale = cond.max > 0 ? cond.max : averageVar > 0 ? averageVar : 1;
    const floor = 1e-10 * scale;
    const minEigenvalueBefore = cond.min;
    const bump = floor - Math.min(cond.min, 0) + floor;
    covariance = covariance.map((row, i) => row.map((v, j) => (i === j ? v + bump : v)));
    cond = conditioning(covariance);
    warnings.push(
      warning(
        WarningCode.CovarianceFloored,
        `${functionName}: the ${resolved} covariance was not positive-definite (degenerate/collinear input) — applied an eigenvalue floor (bump ${bump.toExponential(1)}) to keep the SPD postcondition. Treat the result as regularized, not estimated.`,
        'warn',
        { method: resolved, bump, minEigenvalueBefore },
      ),
    );
  }
  if ((resolved === 'sample' || resolved === 'ewma') && !cond.spd) {
    warnings.push(
      warning(
        WarningCode.MathCovarianceSingular,
        `${functionName}: the ${resolved} covariance is singular (effective rank ${cond.effectiveRank} < ${p}; T = ${T}) — it is NOT invertible. Use method 'ledoit-wolf' or 'ridge' for an SPD estimate.`,
        'warn',
        { effectiveRank: cond.effectiveRank, variables: p, observations: T },
      ),
    );
  } else if (cond.spd && cond.cond > conditionThreshold) {
    warnings.push(
      warning(
        WarningCode.MathCovarianceIllConditioned,
        `${functionName}: the ${resolved} covariance is ill-conditioned (condition number ${cond.cond.toExponential(1)} > ${conditionThreshold.toExponential(0)}); inverting it amplifies estimation noise.`,
        'warn',
        { conditionNumber: cond.cond, method: resolved },
      ),
    );
  }

  return {
    covariance,
    method: resolved,
    variables: p,
    observations: T,
    minEigenvalue: cond.min,
    maxEigenvalue: cond.max,
    conditionNumber: cond.cond,
    isPositiveDefinite: cond.spd,
    effectiveRank: cond.effectiveRank,
    ...(shrinkage !== undefined ? { shrinkage } : {}),
    ...(ewmaLambda !== undefined ? { lambda: ewmaLambda } : {}),
    ...(effectiveObservations !== undefined ? { effectiveObservations } : {}),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: resolved,
      population,
      ...(resolved === 'ledoit-wolf' && (options.ledoitWolfTarget ?? 'identity') === 'single-index'
        ? { marketProxy: options.market ? ('observed-series' as const) : ('equal-weight' as const) }
        : {}),
    },
    diagnostics: {
      engine: 'estimate-covariance',
      method: resolved,
      converged: cond.spd,
      warnings,
    },
  };
}

export interface EigenResult {
  /** Eigenvalues (not sorted). */
  values: number[];
  /** Eigenvectors as columns of the matrix. */
  vectors: Matrix;
}

/**
 * Symmetric eigendecomposition via cyclic Jacobi rotations. The tolerance is RELATIVE to the input's
 * off-diagonal Frobenius norm, so a matrix scaled by any constant converges identically (an absolute
 * tolerance would spin to `maximumIterations` on a large-scaled covariance matrix). Throws `ConvergenceError`
 * (`linalg.no_convergence`) if the sweeps do not reach the tolerance within `maximumIterations`.
 *
 * The input must be SQUARE and finite. It used to be neither checked nor needed: every loop is
 * indexed by `input.length`, so a `2×3` matrix quietly returned the eigenvalues of its leading `2×2`
 * block — the right shape, the wrong matrix, and no way for the caller to tell. (Non-symmetric square
 * input is still accepted and still reports non-convergence through `ConvergenceError` when the
 * rotations cannot diagonalize it; use {@link eigenvalues} for the general case.)
 */
export function jacobiEigen(
  input: Matrix,
  options: { maximumIterations?: number; tolerance?: number } = {},
): EigenResult {
  const n = input.length;
  linalgOptionLadder(
    'jacobiEigen',
    options as unknown as Record<string, unknown>,
    ['maximumIterations', 'tolerance'],
    ['maximumIterations', 'tolerance'],
  );
  requireMathIterationBudgetWhenPresent('jacobiEigen', options.maximumIterations);
  const maximumIterations = options.maximumIterations ?? 100;
  const tolerance = options.tolerance ?? 1e-14;
  if (n === 0) {
    throw new InputError('jacobiEigen: matrix must be non-empty.', {
      code: ErrorCode.InputOutOfRange,
      context: { rows: n },
    });
  }
  for (let i = 0; i < n; i++) {
    const row = input[i]!;
    if (row.length !== n) {
      throw new InputError(
        `jacobiEigen: matrix must be square (row ${i} has ${row.length} entries, expected ${n}); the eigendecomposition of a non-square matrix is undefined — use svd() for its singular values.`,
        { code: ErrorCode.InputOutOfRange, context: { rows: n, row: i, cols: row.length } },
      );
    }
    for (let j = 0; j < n; j++) {
      if (!Number.isFinite(row[j]!)) {
        throw new InputError(
          `jacobiEigen: matrix[${i}][${j}] is ${row[j]}; a non-finite entry makes every eigenvalue NaN.`,
          { code: ErrorCode.InputNotFinite, context: { row: i, col: j, value: row[j] } },
        );
      }
    }
  }
  const a = input.map((row) => row.slice());
  const v: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  // Scale the tolerance by the initial off-diagonal norm (relative convergence). A diagonal input
  // (norm0 === 0) is already converged.
  let norm0 = 0;
  for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) norm0 += a[p]![q]! * a[p]![q]!;
  norm0 = Math.sqrt(norm0);
  const threshold = tolerance * (norm0 > 0 ? norm0 : 1);

  let sweeps = 0;
  for (; sweeps < maximumIterations; sweeps++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! * a[p]![q]!;
    if (Math.sqrt(off) <= threshold) break;

    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p]![q]!;
        if (apq === 0) continue;
        const tau = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(tau || 1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = t * c;
        for (let i = 0; i < n; i++) {
          const aip = a[i]![p]!;
          const aiq = a[i]![q]!;
          a[i]![p] = c * aip - s * aiq;
          a[i]![q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = a[p]![i]!;
          const aqi = a[q]![i]!;
          a[p]![i] = c * api - s * aqi;
          a[q]![i] = s * api + c * aqi;
        }
        for (let i = 0; i < n; i++) {
          const vip = v[i]![p]!;
          const viq = v[i]![q]!;
          v[i]![p] = c * vip - s * viq;
          v[i]![q] = s * vip + c * viq;
        }
      }
    }
  }

  // Honest convergence check on the final matrix: if the sweeps ran out before the off-diagonal norm
  // fell under the (relative) threshold, report it rather than returning silently-wrong eigenvalues.
  let finalOff = 0;
  for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) finalOff += a[p]![q]! * a[p]![q]!;
  if (Math.sqrt(finalOff) > threshold) {
    throw new ConvergenceError(
      'jacobiEigen: Jacobi rotations did not converge within maximumIterations.',
      {
        code: ErrorCode.LinalgNoConvergence,
        context: { iterations: sweeps, offDiagNorm: Math.sqrt(finalOff), threshold },
      },
    );
  }

  const values = a.map((row, i) => row[i]!);
  return { values, vectors: v };
}

function reconstruct(values: number[], vectors: Matrix): Matrix {
  const n = values.length;
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += vectors[i]![k]! * values[k]! * vectors[j]![k]!;
      out[i]![j] = s;
    }
  }
  return out;
}

/** Nearest positive-semidefinite matrix (eigenvalue clipping). */
export function nearestPsd(matrix: Matrix): Matrix {
  const { values, vectors } = jacobiEigen(matrix);
  const clipped = values.map((v) => Math.max(v, 0));
  return reconstruct(clipped, vectors);
}

/**
 * A valid correlation matrix near `matrix`: ONE eigenvalue-clipping pass to PSD ({@link nearestPsd}),
 * then a rescale to a unit diagonal.
 *
 * Not the Frobenius-NEAREST correlation matrix. That is Higham's (2002) alternating-projections
 * problem, iterated to convergence between the PSD cone and the unit-diagonal set; the rescale here
 * is a single projection that can push the result slightly off the PSD cone again (the output is PSD
 * to within the rescale, not by construction). It is the standard cheap repair — good enough to make
 * a noisy correlation estimate usable for Cholesky/simulation — and it is deterministic and O(n³),
 * but a caller who needs the true minimizer needs Higham's iteration, not this.
 */
export function nearestCorrelation(matrix: Matrix): Matrix {
  const psd = nearestPsd(matrix);
  const n = psd.length;
  const d = new Array<number>(n);
  for (let i = 0; i < n; i++) d[i] = psd[i]![i]! > 0 ? 1 / Math.sqrt(psd[i]![i]!) : 0;
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out[i]![j] = i === j ? 1 : d[i]! * psd[i]![j]! * d[j]!;
    }
  }
  return out;
}

// ───────────────────────── basic matrix algebra (spec §8.3) ─────────────────────────

/** The `n × n` identity matrix. */
export function identity(size: number): Matrix {
  return Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => (i === j ? 1 : 0)),
  );
}

/** Transpose of an `m × n` matrix → `n × m`. */
export function transpose(matrix: Matrix): Matrix {
  const m = matrix.length;
  const n = matrix[0]?.length ?? 0;
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) out[j]![i] = matrix[i]![j]!;
  return out;
}

/** Matrix product `A (m×k) · B (k×n)` → `m×n`. Throws on a dimension mismatch. */
export function matrixMultiply(left: Matrix, right: Matrix): Matrix {
  const m = left.length;
  const k = left[0]?.length ?? 0;
  const k2 = right.length;
  const n = right[0]?.length ?? 0;
  if (k !== k2) {
    throw new InputError(`matrixMultiply: inner dimensions disagree (${k} vs ${k2}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { aCols: k, bRows: k2 },
    });
  }
  const out: Matrix = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < m; i++) {
    for (let p = 0; p < k; p++) {
      const aip = left[i]![p]!;
      if (aip === 0) continue;
      const brow = right[p]!;
      const orow = out[i]!;
      for (let j = 0; j < n; j++) orow[j]! += aip * brow[j]!;
    }
  }
  return out;
}

/** Matrix–vector product `A (m×n) · x (n)` → `m`. */
export function matrixVectorProduct(matrix: Matrix, vector: number[]): number[] {
  const m = matrix.length;
  const n = matrix[0]?.length ?? 0;
  if (vector.length !== n) {
    throw new InputError(
      `matrixVectorProduct: the matrix has ${n} columns but the vector has length ${vector.length}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { cols: n, vectorLength: vector.length },
      },
    );
  }
  const out = new Array<number>(m).fill(0);
  for (let i = 0; i < m; i++) {
    let s = 0;
    const row = matrix[i]!;
    for (let j = 0; j < n; j++) s += row[j]! * vector[j]!;
    out[i] = s;
  }
  return out;
}

// ───────────────────────── LU decomposition (partial pivoting) ─────────────────────────

export interface LuResult {
  /** Combined lower/upper factors (unit-diagonal `L` below, `U` on and above the diagonal). */
  lu: Matrix;
  /** Row permutation: `pivotIndices[i]` is the source row moved into row `i`. */
  pivotIndices: number[];
  /** Sign of the permutation (+1 or −1), for the determinant. */
  sign: number;
}

/** LU decomposition with partial pivoting: `P·A = L·U`. Throws on a singular matrix. */
export function luDecompose(matrix: Matrix): LuResult {
  const n = matrix.length;
  if (n === 0 || (matrix[0]?.length ?? 0) !== n) {
    throw new InputError('luDecompose: a non-empty square matrix is required.', {
      code: ErrorCode.InputOutOfRange,
      context: { rows: n, cols: matrix[0]?.length ?? 0 },
    });
  }
  const lu = matrix.map((row) => row.slice());
  const pivotIndices = Array.from({ length: n }, (_, i) => i);
  let sign = 1;
  for (let k = 0; k < n; k++) {
    let p = k;
    let max = Math.abs(lu[k]![k]!);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(lu[i]![k]!);
      if (v > max) {
        max = v;
        p = i;
      }
    }
    if (max === 0) {
      throw new InputError(`luDecompose: matrix is singular (zero pivot at ${k}).`, {
        code: ErrorCode.LinalgSingular,
        context: { index: k },
      });
    }
    if (p !== k) {
      const tmp = lu[k]!;
      lu[k] = lu[p]!;
      lu[p] = tmp;
      const tp = pivotIndices[k]!;
      pivotIndices[k] = pivotIndices[p]!;
      pivotIndices[p] = tp;
      sign = -sign;
    }
    const pivot = lu[k]![k]!;
    for (let i = k + 1; i < n; i++) {
      const f = (lu[i]![k]! /= pivot);
      for (let j = k + 1; j < n; j++) lu[i]![j]! -= f * lu[k]![j]!;
    }
  }
  return { lu, pivotIndices, sign };
}

const LU_RESULT_KEYS = ['lu', 'pivotIndices', 'sign'] as const;

/**
 * A closed structural guard for an `LuResult` handed BACK to the library: the factors must be a
 * square finite matrix, the permutation a valid index list of the same order, the sign ±1. A
 * decomposition edited by hand is refused with the field named, never solved into nonsense.
 */
function requireLuResult(functionName: string, result: unknown): asserts result is LuResult {
  const refuse = (
    message: string,
    field: string,
    code: ErrorCode = ErrorCode.InputWrongType,
  ): never => {
    throw new InputError(`${functionName}: ${message}`, {
      code,
      context: { function: functionName, field },
    });
  };
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    refuse(
      'result must be the LuResult returned by luDecompose ({ lu, pivotIndices, sign }).',
      'result',
    );
  }
  for (const key of Object.keys(result as object)) {
    if (!(LU_RESULT_KEYS as readonly string[]).includes(key)) {
      refuse(
        `unknown field "${key}" in result. Allowed fields: ${LU_RESULT_KEYS.join(', ')}.`,
        'result',
        ErrorCode.InputUnknownField,
      );
    }
  }
  const { lu, pivotIndices, sign } = result as Record<string, unknown>;
  if (!Array.isArray(lu) || lu.length === 0 || lu.some((row) => !Array.isArray(row))) {
    refuse('result.lu must be a non-empty square matrix (an array of number rows).', 'result.lu');
  }
  const n = (lu as unknown[]).length;
  for (const [index, row] of (lu as unknown[][]).entries()) {
    if (row.length !== n) {
      refuse(
        `result.lu must be square: row ${index} has ${row.length} entries, expected ${n}.`,
        'result.lu',
        ErrorCode.InputWrongShape,
      );
    }
    if (row.some((value) => typeof value !== 'number'))
      refuse(`result.lu[${index}] must contain only numbers.`, 'result.lu');
    if (row.some((value) => !Number.isFinite(value as number))) {
      refuse(
        `result.lu[${index}] must contain only finite numbers.`,
        'result.lu',
        ErrorCode.InputNotFinite,
      );
    }
  }
  if (!Array.isArray(pivotIndices) || pivotIndices.length !== n) {
    refuse(
      `result.pivotIndices must be an array of ${n} row indices.`,
      'result.pivotIndices',
      Array.isArray(pivotIndices) ? ErrorCode.InputWrongShape : ErrorCode.InputWrongType,
    );
  }
  for (const [index, pivot] of (pivotIndices as unknown[]).entries()) {
    if (typeof pivot !== 'number') {
      refuse(`result.pivotIndices[${index}] must be a number.`, 'result.pivotIndices');
    }
    const row = pivot as number;
    if (!Number.isInteger(row) || row < 0 || row >= n) {
      refuse(
        `result.pivotIndices[${index}] must be an integer row index in [0, ${n}).`,
        'result.pivotIndices',
        Number.isFinite(row) ? ErrorCode.InputOutOfRange : ErrorCode.InputNotFinite,
      );
    }
  }
  if (typeof sign !== 'number') refuse('result.sign must be a number (+1 or -1).', 'result.sign');
  if (sign !== 1 && sign !== -1)
    refuse(
      'result.sign must be +1 or -1.',
      'result.sign',
      Number.isFinite(sign) ? ErrorCode.InputOutOfRange : ErrorCode.InputNotFinite,
    );
}

/** Solve `A·x = b` from a precomputed {@link luDecompose} result. */
export function luSolve(result: LuResult, b: number[]): number[] {
  requireLuResult('luSolve', result);
  const { lu, pivotIndices } = result;
  const n = lu.length;
  if (!Array.isArray(b) || b.some((value) => typeof value !== 'number')) {
    throw new InputError('luSolve: b must be an array of numbers.', {
      code: ErrorCode.InputWrongType,
      context: { function: 'luSolve', field: 'b' },
    });
  }
  if (b.some((value) => !Number.isFinite(value))) {
    throw new InputError('luSolve: b must contain only finite numbers.', {
      code: ErrorCode.InputNotFinite,
      context: { function: 'luSolve', field: 'b' },
    });
  }
  if (b.length !== n) {
    throw new InputError(`luSolve: b has ${b.length} entries but the system is ${n}×${n}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { expected: n, received: b.length },
    });
  }
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[pivotIndices[i]!]!;
    for (let j = 0; j < i; j++) s -= lu[i]![j]! * y[j]!;
    y[i] = s;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let j = i + 1; j < n; j++) s -= lu[i]![j]! * x[j]!;
    x[i] = s / lu[i]![i]!;
  }
  return x;
}

/** Determinant via LU; returns 0 for a singular matrix instead of throwing. */
export function determinant(matrix: Matrix): number {
  let result: LuResult;
  try {
    result = luDecompose(matrix);
  } catch {
    return 0;
  }
  let det = result.sign;
  const n = result.lu.length;
  for (let i = 0; i < n; i++) det *= result.lu[i]![i]!;
  return det;
}

// ───────────────────────── QR decomposition (Householder) ─────────────────────────

export interface QrResult {
  /** Orthonormal `Q` (`m × n`, thin). */
  q: Matrix;
  /** Upper-triangular `R` (`n × n`). */
  r: Matrix;
}

/** Householder QR of an `m × n` matrix (`m ≥ n`): `A = Q·R`, `Q` thin with orthonormal columns. */
export function qrDecompose(matrix: Matrix): QrResult {
  const m = matrix.length;
  const n = matrix[0]?.length ?? 0;
  if (m < n) {
    throw new InputError(`qrDecompose: requires m ≥ n (got ${m}×${n}).`, {
      code: ErrorCode.InputOutOfRange,
      context: { rows: m, cols: n },
    });
  }
  const R = matrix.map((row) => row.slice());
  const Q = identity(m);
  for (let k = 0; k < n; k++) {
    // Householder vector for column k below the diagonal.
    let norm = 0;
    for (let i = k; i < m; i++) norm += R[i]![k]! * R[i]![k]!;
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const alpha = R[k]![k]! > 0 ? -norm : norm;
    const v = new Array<number>(m).fill(0);
    v[k] = R[k]![k]! - alpha;
    for (let i = k + 1; i < m; i++) v[i] = R[i]![k]!;
    let vNorm2 = 0;
    for (let i = k; i < m; i++) vNorm2 += v[i]! * v[i]!;
    if (vNorm2 === 0) continue;
    // Apply (I − 2 v vᵀ / vᵀv) to R (columns k..n-1) and to Q (all columns).
    for (let j = k; j < n; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i]! * R[i]![j]!;
      const f = (2 * dot) / vNorm2;
      for (let i = k; i < m; i++) R[i]![j]! -= f * v[i]!;
    }
    for (let j = 0; j < m; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i]! * Q[i]![j]!;
      const f = (2 * dot) / vNorm2;
      for (let i = k; i < m; i++) Q[i]![j]! -= f * v[i]!;
    }
  }
  // Thin Q (first n columns of Qᵀ) and the n×n R block.
  const qThin: Matrix = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) qThin[i]![j] = Q[j]![i]!;
  const rTop: Matrix = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i <= j ? R[i]![j]! : 0)),
  );
  return { q: qThin, r: rTop };
}

/**
 * Least-squares solve of `A·x ≈ b` (`m ≥ n`) via QR back-substitution.
 *
 * Rejects a rank-deficient (numerically singular) system rather than silently returning zeroed or
 * blown-up coefficients: if the smallest `|Rᵢᵢ|` pivot falls below `rcond × max|Rᵢᵢ|`, the columns
 * of `A` are collinear and the least-squares solution is not well defined (design law #4 — no silent
 * garbage). Raise `rcond` to reject more aggressively; lower it to admit borderline-conditioned fits.
 */
export function qrSolve(matrix: Matrix, b: number[], options: { rcond?: number } = {}): number[] {
  if (b.length !== matrix.length) {
    throw new InputError(
      `qrSolve: b has ${b.length} entries but A has ${matrix.length} rows — the least-squares system needs one observation per row.`,
      { code: ErrorCode.InputOutOfRange, context: { rows: matrix.length, received: b.length } },
    );
  }
  const { q, r } = qrDecompose(matrix);
  const n = r.length;
  const rcond = options.rcond ?? 1e-12;
  // Rank check on the R diagonal: a pivot tiny relative to the largest means collinear columns.
  let maxDiag = 0;
  for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Math.abs(r[i]![i]!));
  for (let i = 0; i < n; i++) {
    if (maxDiag === 0 || Math.abs(r[i]![i]!) <= rcond * maxDiag) {
      throw new InputError(
        `qrSolve: matrix is rank-deficient (pivot ${r[i]![i]!} at ${i} vs max ${maxDiag}); the least-squares system is singular — check for collinear columns.`,
        { code: ErrorCode.LinalgSingular, context: { index: i, pivot: r[i]![i]!, maxDiag, rcond } },
      );
    }
  }
  // Qᵀ b (n entries).
  const qtb = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let i = 0; i < q.length; i++) s += q[i]![j]! * b[i]!;
    qtb[j] = s;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = qtb[i]!;
    for (let j = i + 1; j < n; j++) s -= r[i]![j]! * x[j]!;
    x[i] = s / r[i]![i]!; // pivot is guaranteed nonzero by the rank check above
  }
  return x;
}

// ───────────────────────── SVD (one-sided Jacobi) ─────────────────────────

export interface SvdResult {
  /** Left singular vectors as columns (`m × n`, thin). */
  u: Matrix;
  /** Singular values, descending. */
  s: number[];
  /** Right singular vectors as columns (`n × n`). */
  v: Matrix;
}

/**
 * Thin singular value decomposition `A = U·diag(s)·Vᵀ` via the one-sided Jacobi (Hestenes) method —
 * accurate and dependency-free for the small matrices TotalFinance handles. `s` is sorted descending.
 */
export function svd(
  matrix: Matrix,
  options: { maxSweeps?: number; tolerance?: number } = {},
): SvdResult {
  linalgOptionLadder(
    'svd',
    options as unknown as Record<string, unknown>,
    ['maxSweeps', 'tolerance'],
    ['maxSweeps', 'tolerance'],
  );
  const m0 = matrix.length;
  const n0 = matrix[0]?.length ?? 0;
  const transposed = m0 < n0;
  // Work on a tall matrix; if A is wide, factor Aᵀ and swap U/V at the end.
  const W = transposed ? transpose(matrix) : matrix.map((row) => row.slice());
  const m = W.length;
  const n = W[0]?.length ?? 0;
  const maxSweeps = options.maxSweeps ?? 60;
  const tolerance = options.tolerance ?? 1e-14;

  const U = W.map((row) => row.slice()); // m × n, columns get orthogonalized in place
  const V = identity(n);

  let converged = false;
  let offMax = 0;
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    offMax = 0;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        let alpha = 0;
        let beta = 0;
        let gamma = 0;
        for (let k = 0; k < m; k++) {
          const uki = U[k]![i]!;
          const ukj = U[k]![j]!;
          alpha += uki * uki;
          beta += ukj * ukj;
          gamma += uki * ukj;
        }
        offMax = Math.max(offMax, Math.abs(gamma) / Math.sqrt(alpha * beta || 1));
        if (Math.abs(gamma) <= tolerance * Math.sqrt(alpha * beta) || gamma === 0) continue;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = Math.sign(zeta || 1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let k = 0; k < m; k++) {
          const uki = U[k]![i]!;
          const ukj = U[k]![j]!;
          U[k]![i] = c * uki - s * ukj;
          U[k]![j] = s * uki + c * ukj;
        }
        for (let k = 0; k < n; k++) {
          const vki = V[k]![i]!;
          const vkj = V[k]![j]!;
          V[k]![i] = c * vki - s * vkj;
          V[k]![j] = s * vki + c * vkj;
        }
      }
    }
    if (offMax < tolerance) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    // Same honesty rule as jacobiEigen: never hand back a silently unconverged factorization
    // (design law #4 — fail loudly instead of fabricating numbers).
    throw new ConvergenceError(
      `svd: Jacobi sweeps did not converge within ${maxSweeps} sweeps (off-diagonal ${offMax.toExponential(2)} vs tolerance ${tolerance.toExponential(2)}). Raise options.maxSweeps or check the matrix for NaN/Infinity.`,
      { code: ErrorCode.LinalgNoConvergence, context: { maxSweeps, offMax, tolerance } },
    );
  }

  // Singular values = column norms of U; normalize U columns.
  const sVals = new Array<number>(n).fill(0);
  for (let j = 0; j < n; j++) {
    let norm = 0;
    for (let k = 0; k < m; k++) norm += U[k]![j]! * U[k]![j]!;
    sVals[j] = Math.sqrt(norm);
  }
  for (let j = 0; j < n; j++) {
    const sj = sVals[j]!;
    if (sj > 0) for (let k = 0; k < m; k++) U[k]![j]! /= sj;
  }
  // Sort descending by singular value, permuting U and V columns to match.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => sVals[b]! - sVals[a]!);
  const sSorted = order.map((i) => sVals[i]!);
  const Us: Matrix = Array.from({ length: m }, () => new Array<number>(n).fill(0));
  const Vs: Matrix = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  order.forEach((src, dst) => {
    for (let k = 0; k < m; k++) Us[k]![dst] = U[k]![src]!;
    for (let k = 0; k < n; k++) Vs[k]![dst] = V[k]![src]!;
  });

  return transposed ? { u: Vs, s: sSorted, v: Us } : { u: Us, s: sSorted, v: Vs };
}

/** Moore–Penrose pseudoinverse `A⁺` via SVD (singular values below `rcond·σ_max` are dropped). */
export function pseudoInverse(matrix: Matrix, options: { rcond?: number } = {}): Matrix {
  linalgOptionLadder(
    'pseudoInverse',
    options as unknown as Record<string, unknown>,
    ['rcond'],
    ['rcond'],
  );
  const { u, s, v } = svd(matrix);
  const rcond = options.rcond ?? 1e-12;
  const sMax = s[0] ?? 0;
  const cutoff = rcond * sMax;
  const r = s.length;
  const m = u.length;
  const n = v.length;
  // A⁺ = V · diag(1/s) · Uᵀ  →  (n × m).
  const out: Matrix = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let sum = 0;
      for (let k = 0; k < r; k++) {
        const sk = s[k]!;
        if (sk <= cutoff) continue;
        sum += (v[i]![k]! * u[j]![k]!) / sk;
      }
      out[i]![j] = sum;
    }
  }
  return out;
}

// ───────────────────────── general (non-symmetric) eigenvalues ─────────────────────────

/** A complex number `re + im·i`. */
export interface Complex {
  re: number;
  im: number;
}

export interface GeneralEigenResult {
  /** Eigenvalues (real, or complex-conjugate pairs), in real-Schur order. */
  values: Complex[];
  /**
   * Eigenvector for each real eigenvalue (via inverse iteration), aligned to `values`; `null` for
   * complex eigenvalues (their eigenvectors are complex and not returned in this real interface).
   */
  vectors: (number[] | null)[];
}

/** Reduce a square matrix to upper-Hessenberg form by Householder similarity (eigenvalue-preserving). */
function toHessenberg(matrix: Matrix): Matrix {
  const n = matrix.length;
  const H = matrix.map((row) => row.slice());
  for (let k = 1; k < n - 1; k++) {
    let scale = 0;
    for (let i = k; i < n; i++) scale += Math.abs(H[i]![k - 1]!);
    if (scale === 0) continue;
    let h = 0;
    const ort = new Array<number>(n).fill(0);
    for (let i = k; i < n; i++) {
      ort[i] = H[i]![k - 1]! / scale;
      h += ort[i]! * ort[i]!;
    }
    let g = Math.sqrt(h);
    if (ort[k]! > 0) g = -g;
    h -= ort[k]! * g;
    ort[k]! -= g;
    for (let j = k; j < n; j++) {
      let f = 0;
      for (let i = n - 1; i >= k; i--) f += ort[i]! * H[i]![j]!;
      f /= h;
      for (let i = k; i < n; i++) H[i]![j]! -= f * ort[i]!;
    }
    for (let i = 0; i < n; i++) {
      let f = 0;
      for (let j = n - 1; j >= k; j--) f += ort[j]! * H[i]![j]!;
      f /= h;
      for (let j = k; j < n; j++) H[i]![j]! -= f * ort[j]!;
    }
    H[k]![k - 1] = scale * g;
    for (let i = k + 1; i < n; i++) H[i]![k - 1] = 0;
  }
  return H;
}

/**
 * Eigenvalues of a general real matrix via the **Francis double-shift QR** algorithm on its Hessenberg
 * form (the EISPACK/JAMA `hqr2` reduction to real Schur form). Returns real eigenvalues and
 * complex-conjugate pairs. For symmetric matrices prefer {@link jacobiEigen} (which also gives vectors).
 */
export function eigenvalues(matrix: Matrix): Complex[] {
  const n = matrix.length;
  if (n === 0 || (matrix[0]?.length ?? 0) !== n) {
    throw new InputError('eigenvalues: a non-empty square matrix is required.', {
      code: ErrorCode.InputOutOfRange,
      context: { rows: n, cols: matrix[0]?.length ?? 0 },
    });
  }
  if (n === 1) return [{ re: matrix[0]![0]!, im: 0 }];
  const H = toHessenberg(matrix);
  const d = new Array<number>(n).fill(0); // real parts
  const e = new Array<number>(n).fill(0); // imaginary parts
  const eps = 2 ** -52;

  let norm = 0;
  for (let i = 0; i < n; i++)
    for (let j = Math.max(i - 1, 0); j < n; j++) norm += Math.abs(H[i]![j]!);

  let nn = n - 1;
  let exshift = 0;
  let iter = 0;
  let p = 0;
  let q = 0;
  let r = 0;
  let s = 0;
  let z = 0;
  let x = 0;
  let y = 0;
  let w = 0;

  while (nn >= 0) {
    // Find a small sub-diagonal element to deflate the active block.
    let l = nn;
    while (l > 0) {
      let sl = Math.abs(H[l - 1]![l - 1]!) + Math.abs(H[l]![l]!);
      if (sl === 0) sl = norm;
      if (Math.abs(H[l]![l - 1]!) < eps * sl) break;
      l--;
    }

    if (l === nn) {
      // One real root.
      d[nn] = H[nn]![nn]! + exshift;
      e[nn] = 0;
      nn--;
      iter = 0;
    } else if (l === nn - 1) {
      // Two roots (a 2×2 block).
      w = H[nn]![nn - 1]! * H[nn - 1]![nn]!;
      p = (H[nn - 1]![nn - 1]! - H[nn]![nn]!) / 2;
      q = p * p + w;
      z = Math.sqrt(Math.abs(q));
      H[nn]![nn]! += exshift;
      H[nn - 1]![nn - 1]! += exshift;
      x = H[nn]![nn]!;
      if (q >= 0) {
        z = p >= 0 ? p + z : p - z;
        d[nn - 1] = x + z;
        d[nn] = d[nn - 1]!;
        if (z !== 0) d[nn] = x - w / z;
        e[nn - 1] = 0;
        e[nn] = 0;
      } else {
        d[nn - 1] = x + p;
        d[nn] = x + p;
        e[nn - 1] = z;
        e[nn] = -z;
      }
      nn -= 2;
      iter = 0;
    } else {
      // No convergence yet — perform a double QR sweep.
      x = H[nn]![nn]!;
      y = 0;
      w = 0;
      if (l < nn) {
        y = H[nn - 1]![nn - 1]!;
        w = H[nn]![nn - 1]! * H[nn - 1]![nn]!;
      }
      if (iter === 10) {
        // Exceptional shift to break a cycle.
        exshift += x;
        for (let i = 0; i <= nn; i++) H[i]![i]! -= x;
        s = Math.abs(H[nn]![nn - 1]!) + Math.abs(H[nn - 1]![nn - 2]!);
        x = y = 0.75 * s;
        w = -0.4375 * s * s;
      }
      if (iter === 30) {
        s = (y - x) / 2;
        s = s * s + w;
        if (s > 0) {
          s = Math.sqrt(s);
          if (y < x) s = -s;
          s = x - w / ((y - x) / 2 + s);
          for (let i = 0; i <= nn; i++) H[i]![i]! -= s;
          exshift += s;
          x = y = w = 0.964;
        }
      }
      if (iter > 60) {
        // Same failure family as jacobiEigen: linear-algebra non-convergence, not a root-find.
        throw new ConvergenceError('eigenvalues: QR iteration did not converge.', {
          code: ErrorCode.LinalgNoConvergence,
          context: { block: nn },
        });
      }
      iter++;

      // Look for two consecutive small sub-diagonal elements.
      let m = nn - 2;
      while (m >= l) {
        z = H[m]![m]!;
        r = x - z;
        s = y - z;
        p = (r * s - w) / H[m + 1]![m]! + H[m]![m + 1]!;
        q = H[m + 1]![m + 1]! - z - r - s;
        r = H[m + 2]![m + 1]!;
        s = Math.abs(p) + Math.abs(q) + Math.abs(r);
        p /= s;
        q /= s;
        r /= s;
        if (m === l) break;
        if (
          Math.abs(H[m]![m - 1]!) * (Math.abs(q) + Math.abs(r)) <
          eps *
            (Math.abs(p) *
              (Math.abs(H[m - 1]![m - 1]!) + Math.abs(z) + Math.abs(H[m + 1]![m + 1]!)))
        ) {
          break;
        }
        m--;
      }
      for (let i = m + 2; i <= nn; i++) {
        H[i]![i - 2] = 0;
        if (i > m + 2) H[i]![i - 3] = 0;
      }

      // Double QR step over rows/columns l..nn.
      for (let k = m; k <= nn - 1; k++) {
        const notlast = k !== nn - 1;
        if (k !== m) {
          p = H[k]![k - 1]!;
          q = H[k + 1]![k - 1]!;
          r = notlast ? H[k + 2]![k - 1]! : 0;
          x = Math.abs(p) + Math.abs(q) + Math.abs(r);
          if (x !== 0) {
            p /= x;
            q /= x;
            r /= x;
          }
        }
        if (x === 0) break;
        s = Math.sqrt(p * p + q * q + r * r);
        if (p < 0) s = -s;
        if (s !== 0) {
          if (k !== m) H[k]![k - 1] = -s * x;
          else if (l !== m) H[k]![k - 1] = -H[k]![k - 1]!;
          p += s;
          x = p / s;
          y = q / s;
          z = r / s;
          q /= p;
          r /= p;
          for (let j = k; j < n; j++) {
            p = H[k]![j]! + q * H[k + 1]![j]!;
            if (notlast) {
              p += r * H[k + 2]![j]!;
              H[k + 2]![j]! -= p * z;
            }
            H[k + 1]![j]! -= p * y;
            H[k]![j]! -= p * x;
          }
          const iMax = Math.min(nn, k + 3);
          for (let i = 0; i <= iMax; i++) {
            p = x * H[i]![k]! + y * H[i]![k + 1]!;
            if (notlast) {
              p += z * H[i]![k + 2]!;
              H[i]![k + 2]! -= p * r;
            }
            H[i]![k + 1]! -= p * q;
            H[i]![k]! -= p;
          }
        }
      }
    }
  }

  return d.map((re, i) => ({ re, im: e[i]! }));
}

/** Eigenvector of `A` for a real eigenvalue `lambda`, by inverse iteration (or `null` on breakdown). */
function eigenvectorReal(matrix: Matrix, lambda: number): number[] | null {
  const n = matrix.length;
  const shift = 1e-9 * (Math.abs(lambda) + 1);
  const M = matrix.map((row, i) => row.map((v, j) => v - (i === j ? lambda + shift : 0)));
  let lu: LuResult;
  try {
    lu = luDecompose(M);
  } catch {
    return null;
  }
  let v = new Array<number>(n).fill(1 / Math.sqrt(n));
  for (let iter = 0; iter < 6; iter++) {
    const w = luSolve(lu, v);
    let norm = 0;
    for (const x of w) norm += x * x;
    norm = Math.sqrt(norm);
    if (!(norm > 0) || !Number.isFinite(norm)) return null;
    v = w.map((x) => x / norm);
  }
  // Sign convention: make the largest-magnitude component positive.
  let mi = 0;
  for (let i = 1; i < n; i++) if (Math.abs(v[i]!) > Math.abs(v[mi]!)) mi = i;
  if (v[mi]! < 0) v = v.map((x) => -x);
  return v;
}

/**
 * Eigenvalues and (for real eigenvalues) eigenvectors of a general real matrix. Eigenvalues come from
 * the Francis QR algorithm ({@link eigenvalues}); each real eigenvalue's eigenvector is recovered by
 * inverse iteration. Complex eigenvalues report a `null` vector in this real-valued interface.
 */
export function eigen(matrix: Matrix): GeneralEigenResult {
  const values = eigenvalues(matrix);
  const tolerance = 1e-9;
  const vectors = values.map((lambda) =>
    Math.abs(lambda.im) < tolerance ? eigenvectorReal(matrix, lambda.re) : null,
  );
  return { values, vectors };
}
