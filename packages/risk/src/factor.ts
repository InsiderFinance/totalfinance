/**
 * Factor / principal-component analysis of a covariance (or correlation) matrix.
 *
 * `pca` returns the principal components sorted by descending eigenvalue, each with its loadings
 * (the eigenvector) and the fraction of total variance it explains. `factorExposure` keeps the top-k
 * components and reports every asset's loading on them — the standard statistical-factor risk view.
 */

import {
  ErrorCode,
  CONVENTIONS_VERSION,
  InputError,
  type QuantWarning,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import { type Matrix, jacobiEigen } from '@totalfinance/math';

/** Law 2 report grammar (D5): every factor answer carries its conventions and a warnings channel. */
function factorReport(assumptions: Record<string, unknown>, warnings: QuantWarning[] = []) {
  return {
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, ...assumptions },
    diagnostics: { warnings },
  };
}

export interface PcaComponent {
  /** Variance along this principal axis (the eigenvalue). */
  eigenvalue: number;
  /** Loadings: the unit eigenvector, length = number of assets. */
  loadings: number[];
  /** Fraction of total variance this component explains. */
  varianceExplained: number;
}

export interface PcaResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** Components sorted by descending eigenvalue. */
  components: PcaComponent[];
  eigenvalues: number[];
  /** `loadings[k]` = the k-th component's eigenvector. */
  loadings: number[][];
  varianceExplained: number[];
  cumulativeVariance: number[];
  /** Sum of eigenvalues (= trace of the input matrix). */
  totalVariance: number;
}

function assertSquare(M: Matrix, functionName: string): number {
  const n = M.length;
  if (n === 0 || M.some((r) => r.length !== n)) {
    throw new InputError(`${functionName}: input must be a non-empty square matrix.`, {
      code: ErrorCode.InputOutOfRange,
      context: { functionName, rows: n },
    });
  }
  return n;
}

/** Convert a covariance matrix to a correlation matrix (unit diagonal). */
export function covarianceToCorrelation(covariance: Matrix): Matrix {
  requireArgumentArray('covarianceToCorrelation', 'covariance', covariance);
  assertSquare(covariance, 'covarianceToCorrelation');
  const d = covariance.map((row, i) => {
    const v = row[i]!;
    return v > 0 ? 1 / Math.sqrt(v) : 0;
  });
  return covariance.map((row, i) => row.map((c, j) => c * d[i]! * d[j]!));
}

/** Flip an eigenvector's sign so its largest-magnitude loading is positive (stable convention). */
function canonicalSign(v: number[]): number[] {
  let maxAbs = 0;
  let s = 1;
  for (const x of v) {
    if (Math.abs(x) > maxAbs) {
      maxAbs = Math.abs(x);
      s = x < 0 ? -1 : 1;
    }
  }
  return s < 0 ? v.map((x) => -x) : v;
}

/** The documented `pca` option keys. */
const PCA_OPTIONS_KEYS = ['correlation'] as const;

/** Principal-component analysis of a covariance (or, with `correlation`, the standardized) matrix. */
export function pca(covariance: Matrix, options: { correlation?: boolean } = {}): PcaResult {
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('pca', 'options', options);
  // Law 12: a misspelled knob (`correlaton: true` running on raw covariance) must throw, never no-op.
  ensureKnownKeys('pca', 'options', options, PCA_OPTIONS_KEYS);
  requireArgumentArray('pca', 'covariance', covariance);
  assertSquare(covariance, 'pca');
  if (options.correlation !== undefined && typeof options.correlation !== 'boolean') {
    throw new InputError(
      `pca: correlation must be a boolean when provided — it selects WHICH matrix is decomposed. Received ${options.correlation === null ? 'null' : typeof options.correlation}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'correlation' } },
    );
  }
  const M = options.correlation ? covarianceToCorrelation(covariance) : covariance;
  const { values, vectors } = jacobiEigen(M);
  const order = values.map((_, i) => i).sort((a, b) => values[b]! - values[a]!);
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);

  const eigenvalues = order.map((i) => values[i]!);
  const loadings = order.map((k) => canonicalSign(vectors.map((row) => row[k]!)));
  const varianceExplained = eigenvalues.map((v) => (total > 0 ? Math.max(0, v) / total : 0));
  const cumulativeVariance: number[] = [];
  let acc = 0;
  for (const ve of varianceExplained) {
    acc += ve;
    cumulativeVariance.push(acc);
  }
  const components: PcaComponent[] = eigenvalues.map((ev, k) => ({
    eigenvalue: ev,
    loadings: loadings[k]!,
    varianceExplained: varianceExplained[k]!,
  }));
  return {
    components,
    eigenvalues,
    loadings,
    varianceExplained,
    cumulativeVariance,
    totalVariance: total,
    // Which matrix was decomposed (dx §2.4): the covariance-vs-correlation choice is disclosed.
    ...factorReport({
      matrix: options.correlation ? 'correlation' : 'covariance',
      assets: covariance.length,
    }),
  };
}

export interface FactorExposureResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** The retained top-k principal components. */
  factors: PcaComponent[];
  /** `exposure[assetIndex][factorIndex]` = that asset's loading on the factor. */
  exposure: number[][];
  /** Total variance explained by the retained factors. */
  varianceExplained: number;
}

/** The documented `factorExposure` option keys. */
const FACTOR_EXPOSURE_OPTIONS_KEYS = ['factorCount', 'correlation'] as const;

/** Keep the top-`k` principal components and report each asset's exposure (loading) to them. */
export function factorExposure(
  covariance: Matrix,
  options: { factorCount?: number; correlation?: boolean } = {},
): FactorExposureResult {
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject('factorExposure', 'options', options);
  // Law 12: a misspelled knob (`factorcount: 2` silently keeping every factor) must throw, never no-op.
  ensureKnownKeys('factorExposure', 'options', options, FACTOR_EXPOSURE_OPTIONS_KEYS);
  requireArgumentArray('factorExposure', 'covariance', covariance);
  if (
    options.factorCount !== undefined &&
    // Safe integer (2026-08-23 review, P0): `Math.min(factorCount, components.length)` below keeps
    // the retained count data-bounded, but the count itself must be exact — above 2^53 it is not.
    (!Number.isSafeInteger(options.factorCount) || options.factorCount < 1)
  ) {
    // Guard the `slice(0, k)` — a negative k like -1 would silently keep "all but the last" factor.
    throw new InputError(
      `factorExposure: factorCount must be a positive integer, got ${options.factorCount}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { factorCount: options.factorCount },
      },
    );
  }
  const res = pca(covariance, {
    ...(options.correlation !== undefined ? { correlation: options.correlation } : {}),
  });
  const n = covariance.length;
  const k = Math.min(options.factorCount ?? n, res.components.length);
  const factors = res.components.slice(0, k);
  const exposure = Array.from({ length: n }, (_, asset) => factors.map((f) => f.loadings[asset]!));
  const varianceExplained = factors.reduce((s, f) => s + f.varianceExplained, 0);
  return {
    factors,
    exposure,
    varianceExplained,
    // The retained-factor window (dx §2.4): the `k = n` default is disclosed, never hidden.
    ...factorReport({
      k,
      matrix: options.correlation ? 'correlation' : 'covariance',
      assets: n,
    }),
  };
}
