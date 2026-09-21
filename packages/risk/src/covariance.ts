import { ensureEnumWhenPresent, ensureFiniteWhenPresent } from './options-internal.js';
/**
 * The covariance on-ramp (alignment spec D11, P3.6) — the missing first step of the portfolio
 * journey: RETURNS → `covariance()` → optimizer.
 *
 * This is a cohesive risk-domain operation, not a barrel re-export: it takes returns in the
 * shape portfolio data actually arrives in (observations-major — one row per period, one column
 * per asset), delegates the estimation to `@totalfinance/math`'s `estimateCovariance` (auto
 * shrinkage, SPD guarantees, conditioning report), and returns the analysis envelope whose
 * `value` plugs STRAIGHT into `minVariance` / `maxSharpe` / `meanVariance` / `riskParity`:
 *
 * ```ts
 * const { covariance: cov, meanReturns: mu } = covariance({ returns }).value;
 * const w = maxSharpe({
 *   mean: mu,
 *   covariance: cov,
 *   options: { longOnly: true },
 * }).value.weights;
 * ```
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type Diagnostics,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  estimateCovariance,
  type EstimateCovarianceOptions,
  type Matrix,
} from '@totalfinance/math';

export interface CovarianceInput {
  /**
   * Observations-major returns: `returns[t][k]` is asset `k`'s simple return in period `t` —
   * one row per period, one column per asset (the natural CSV/dataframe orientation, and the
   * TRANSPOSE of `@totalfinance/math`'s variables-major `estimateCovariance` input). Every row must
   * have the same number of assets.
   */
  returns: number[][];
  /** Optional asset labels aligned to the columns; echoed on the result for self-description. */
  assets?: string[];
}

/** The documented {@link CovarianceInput} keys — Law 12: an unknown field must throw, never no-op. */
const COVARIANCE_INPUT_KEYS = ['returns', 'assets'] as const;

/** Estimator options — delegated verbatim to `@totalfinance/math`'s `estimateCovariance`. */
export type CovarianceOptions = EstimateCovarianceOptions;

/** The documented {@link CovarianceOptions} keys (mirrors `EstimateCovarianceOptions`). */
const COVARIANCE_OPTIONS_KEYS = [
  'method',
  'ridge',
  'conditionThreshold',
  'population',
  'lambda',
  'halfLife',
  'ledoitWolfTarget',
  'market',
] as const;

export interface CovarianceValue {
  /** The estimated covariance Σ (assets × assets) — feed it to any optimizer. */
  covariance: Matrix;
  /** Per-asset arithmetic mean PERIOD returns, aligned to the columns — feed to `maxSharpe`. */
  meanReturns: number[];
  /** Asset labels, when provided. */
  assets?: string[];
}

export interface CovarianceResult {
  value: CovarianceValue;
  assumptions: {
    conventionsVersion: string;
    /** The estimator actually used (`'auto'` resolves before reporting). */
    method: 'sample' | 'ledoit-wolf' | 'ridge' | 'ewma';
    observations: number;
    /** Returns are treated as one row per PERIOD; means are per-period, not annualized. */
    orientation: 'observations-major';
  };
  diagnostics: Diagnostics & {
    /** `null` when the matrix is singular (κ = ∞ has no JSON representation; see warnings). */
    conditionNumber: number | null;
    isPositiveDefinite: boolean;
    effectiveRank: number;
    minEigenvalue: number;
    maxEigenvalue: number;
    shrinkage?: number;
    lambda?: number;
  };
}

/**
 * Package-internal (shared with `expected-returns.ts`; not re-exported from any entrypoint):
 * validate an observations-major returns matrix — non-empty, rectangular, every cell finite.
 */
export function validateReturnsInput(
  functionName: string,
  input: CovarianceInput,
): { T: number; p: number } {
  requireArgumentObject(functionName, 'input', input);
  requireArgumentArray(functionName, 'input.returns', input.returns);
  const T = input.returns.length;
  if (T === 0) {
    throw new InputError(
      `${functionName}: input.returns must contain at least one period (got 0 rows).`,
      {
        code: ErrorCode.InputWrongShape,
        context: { rows: 0 },
      },
    );
  }
  requireArgumentArray(functionName, 'input.returns[0]', input.returns[0]);
  const p = input.returns[0]!.length;
  if (p === 0) {
    throw new InputError(
      `${functionName}: input.returns rows must contain at least one asset (got 0 columns).`,
      {
        code: ErrorCode.InputWrongShape,
        context: { columns: 0 },
      },
    );
  }
  for (let t = 0; t < T; t++) {
    const row: unknown = input.returns[t];
    if (!Array.isArray(row) || row.length !== p) {
      throw new InputError(
        `${functionName}: input.returns[${t}] has ${
          Array.isArray(row) ? row.length : typeof row
        } entries — every period row must list the same ${p} assets.`,
        { code: ErrorCode.InputLengthMismatch, context: { row: t, expected: p } },
      );
    }
    // Law 7 at the boundary: one NaN return would ride into every covariance entry silently.
    for (let k = 0; k < p; k++) {
      const v: unknown = (row as number[])[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new InputError(
          `${functionName}: input.returns[${t}][${k}] is not a finite number (${String(v)}).`,
          { code: ErrorCode.InputNotFinite, context: { row: t, column: k } },
        );
      }
    }
  }
  if (input.assets !== undefined) {
    requireArgumentArray(functionName, 'input.assets', input.assets);
    if (input.assets.length !== p) {
      throw new InputError(
        `${functionName}: input.assets lists ${input.assets.length} labels for ${p} return columns.`,
        {
          code: ErrorCode.InputLengthMismatch,
          context: { labels: input.assets.length, assets: p },
        },
      );
    }
  }
  return { T, p };
}

function transpose(rows: number[][], T: number, p: number): number[][] {
  const out: number[][] = Array.from({ length: p }, () => new Array<number>(T));
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < p; k++) out[k]![t] = rows[t]![k]!;
  }
  return out;
}

/**
 * Estimate a portfolio covariance (and mean returns) from raw return history — the first step of
 * every optimizer journey. Delegates estimation to `estimateCovariance` (`method: 'auto'`
 * defaults to the sample covariance and shrinks only when it is singular/ill-conditioned, always
 * disclosing what it did), and reports the full conditioning diagnostics so a caller knows the
 * matrix is safe to invert BEFORE optimizing with it.
 */
export function covariance(
  input: CovarianceInput,
  options: CovarianceOptions = {},
): CovarianceResult {
  const functionName = 'covariance';
  // An explicit `null`/primitive bypasses the `= {}` default — teach, never TypeError downstream.
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, COVARIANCE_OPTIONS_KEYS);
  // When-present ladders before the estimator resolves its defaults (the 350c2796 ruling).
  ensureEnumWhenPresent(options.method, functionName, 'method', [
    'auto',
    'sample',
    'ledoit-wolf',
    'ridge',
    'ewma',
  ]);
  ensureEnumWhenPresent(options.ledoitWolfTarget, functionName, 'ledoitWolfTarget', [
    'identity',
    'constant-correlation',
    'single-index',
  ]);
  if (options.population !== undefined && typeof options.population !== 'boolean') {
    throw new InputError(
      `${functionName}: population must be a boolean when provided (1/T vs 1/(T-1) normalization). Received ${options.population === null ? 'null' : typeof options.population}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'population' } },
    );
  }
  if (
    options.market !== undefined &&
    !Array.isArray(options.market) &&
    !ArrayBuffer.isView(options.market)
  ) {
    throw new InputError(
      `${functionName}: market must be an array of market returns when provided. Received ${options.market === null ? 'null' : typeof options.market}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'market' } },
    );
  }
  for (const field of ['ridge', 'conditionThreshold', 'lambda', 'halfLife'] as const) {
    ensureFiniteWhenPresent((options as Record<string, unknown>)[field], field, functionName);
  }
  const { T, p } = validateReturnsInput(functionName, input);
  ensureKnownKeys(functionName, 'input', input, COVARIANCE_INPUT_KEYS);
  const series = transpose(input.returns, T, p);
  const est = estimateCovariance(series, options);
  const mu = series.map((s) => s.reduce((a, b) => a + b, 0) / T);
  return {
    value: {
      covariance: est.covariance,
      meanReturns: mu,
      ...(input.assets !== undefined ? { assets: input.assets } : {}),
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      method: est.method,
      observations: est.observations,
      orientation: 'observations-major',
    },
    diagnostics: {
      // The estimator's own diagnostics (converged, warnings, method) pass through untouched…
      ...est.diagnostics,
      // …and the conditioning report is surfaced beside them so callers can gate on it. A
      // singular matrix has κ = ∞ — reported as null (JSON-safe) with the estimator's own
      // singularity warning carrying the reason; `isPositiveDefinite: false` is the machine gate.
      conditionNumber: Number.isFinite(est.conditionNumber) ? est.conditionNumber : null,
      isPositiveDefinite: est.isPositiveDefinite,
      effectiveRank: est.effectiveRank,
      minEigenvalue: est.minEigenvalue,
      maxEigenvalue: est.maxEigenvalue,
      ...(est.shrinkage !== undefined ? { shrinkage: est.shrinkage } : {}),
      ...(est.lambda !== undefined ? { lambda: est.lambda } : {}),
    },
  };
}

export interface MeanReturnsInput {
  /** Observations-major returns — same orientation as {@link CovarianceInput}. */
  returns: number[][];
  /**
   * Annualize by this factor (e.g. `252` for daily data): reported means become
   * `periodMean × periodsPerYear`. OMITTED means per-period means — annualization is never
   * silent (spec Law 6).
   */
  periodsPerYear?: number;
}

/** The documented {@link MeanReturnsInput} keys. */
const MEAN_RETURNS_INPUT_KEYS = ['returns', 'periodsPerYear'] as const;

/**
 * Per-asset arithmetic mean returns from observations-major history — the `mu` for
 * `maxSharpe({ mean, covariance })` / `meanVariance({ mean, covariance })`. Kept deliberately small: it is the
 * journey-completing helper, not a statistics suite (see `@totalfinance/math` for that).
 */
export function meanReturns(input: MeanReturnsInput): number[] {
  const functionName = 'meanReturns';
  const { T, p } = validateReturnsInput(functionName, input);
  ensureKnownKeys(functionName, 'input', input, MEAN_RETURNS_INPUT_KEYS);
  if (
    input.periodsPerYear !== undefined &&
    !(input.periodsPerYear > 0 && Number.isFinite(input.periodsPerYear))
  ) {
    throw new InputError(
      `${functionName}: periodsPerYear must be a positive FINITE number (got ${input.periodsPerYear}).`,
      { code: ErrorCode.InputOutOfRange, context: { periodsPerYear: input.periodsPerYear } },
    );
  }
  ensureFiniteWhenPresent(input.periodsPerYear, 'periodsPerYear', 'meanReturns');
  const scale = input.periodsPerYear ?? 1;
  const out = new Array<number>(p).fill(0);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < p; k++) out[k]! += input.returns[t]![k]!;
  }
  return out.map((s) => (s / T) * scale);
}
