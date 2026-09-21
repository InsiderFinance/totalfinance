/**
 * Expected-return estimation (FC7 slice 4, Stage 4.4) — the `mean` on-ramp for the optimizers and
 * the efficient frontier, under an EXPLICIT method. The method is a discriminant the caller
 * states, never an inference:
 *
 *   • `'historical-mean'`         — composes `meanReturns` exactly (bit-identical means);
 *   • `'exponentially-weighted'`  — half-life decay, most recent observation heaviest, with the
 *                                   effective sample size disclosed;
 *   • `'capital-asset-pricing'`   — composes FC2's `capitalAssetPricingExpectedReturn` from
 *                                   `@totalfinance/valuation` per asset (annual by construction);
 *   • `'supplied'`                — a validated pass-through of caller values with an explicit
 *                                   `annualized` flag.
 *
 * Annualization is never silent (spec Law 6): the sample methods report per-period means unless
 * `periodsPerYear` is given, and the result always says which it did. The point-in-time law: when
 * `observationTimestamps` accompany the rows and `asOf` is given, every row observed after `asOf`
 * is excluded and the count is disclosed — the estimate cannot see the future by accident.
 */

import {
  CONVENTIONS_VERSION,
  type Diagnostics,
  type EpochMs,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  requireRepresentableResult,
  resolveAsOf,
  warning,
  WarningCode,
} from '@totalfinance/core';
import { capitalAssetPricingExpectedReturn } from '@totalfinance/valuation';
import { meanReturns, validateReturnsInput } from './covariance.js';

/** Fields shared by the two sample-based methods (`'historical-mean'`, `'exponentially-weighted'`). */
interface SampleExpectedReturnsFields {
  /**
   * Observations-major returns — the same orientation as `CovarianceInput`: `returns[t][k]` is
   * asset `k`'s simple return in period `t` (one row per period, one column per asset).
   */
  returns: number[][];
  /**
   * Annualize by this factor (e.g. `252` for daily, `12` for monthly data): the reported means
   * become `periodMean × periodsPerYear`. OMITTED means per-period means with `annualized: false`
   * — annualization is never silent.
   */
  periodsPerYear?: number;
  /** Optional asset labels aligned to the columns; echoed on the result. */
  assetIds?: string[];
  /**
   * Optional observation instants aligned 1:1 with the rows of `returns` (epoch milliseconds or
   * an ISO date / zoned datetime), non-decreasing. Required for `asOf` to screen anything.
   */
  observationTimestamps?: (EpochMs | string)[];
  /**
   * Point-in-time cut: every row whose timestamp is AFTER this instant is excluded from the
   * estimate and the excluded count is disclosed in `diagnostics.excludedAfterAsOf`. Without
   * `observationTimestamps` nothing can be screened — the result then carries a warning.
   */
  asOf?: EpochMs | string;
}

export interface HistoricalMeanExpectedReturnsInput extends SampleExpectedReturnsFields {
  method: 'historical-mean';
}

export interface ExponentiallyWeightedExpectedReturnsInput extends SampleExpectedReturnsFields {
  method: 'exponentially-weighted';
  /**
   * Half-life of the observation weights in PERIODS: observation `t` of `T` carries weight
   * `0.5^((T − 1 − t) / halfLifePeriods)` before normalization, so the most recent row is the
   * heaviest. Required — there is no universal decay rate.
   */
  halfLifePeriods: number;
}

export interface CapitalAssetPricingExpectedReturnsInput {
  method: 'capital-asset-pricing';
  /** Per-asset market betas (one per asset). */
  betas: number[];
  /** Annual risk-free rate (decimal). */
  annualRiskFreeRate: number;
  /** Annual market risk premium (decimal) — the premium itself, not the market return. */
  annualMarketRiskPremium: number;
  /** Optional asset labels aligned to `betas`; echoed on the result. */
  assetIds?: string[];
}

export interface SuppliedExpectedReturnsInput {
  method: 'supplied';
  /** Caller-supplied expected returns, one per asset. */
  expectedReturns: number[];
  /** Whether the supplied values are annual (`true`) or per-period (`false`). Required. */
  annualized: boolean;
  /** Optional asset labels aligned to `expectedReturns`; echoed on the result. */
  assetIds?: string[];
}

/** The closed request: an explicit `method` discriminant selects the branch and its own keys. */
export type EstimateExpectedReturnsInput =
  | HistoricalMeanExpectedReturnsInput
  | ExponentiallyWeightedExpectedReturnsInput
  | CapitalAssetPricingExpectedReturnsInput
  | SuppliedExpectedReturnsInput;

export type ExpectedReturnsMethod = EstimateExpectedReturnsInput['method'];

export interface ExpectedReturnsValue {
  /** Per-asset expected returns, aligned to the input columns / betas / supplied values. */
  expectedReturns: number[];
  /** Whether `expectedReturns` are annual (`true`) or per-period (`false`) — never implicit. */
  annualized: boolean;
  /** Asset labels, when provided. */
  assetIds?: string[];
}

export interface ExpectedReturnsResult {
  value: ExpectedReturnsValue;
  assumptions: {
    conventionsVersion: string;
    method: ExpectedReturnsMethod;
    /** Echoed when annualization was requested (sample methods only). */
    periodsPerYear?: number;
    /** Echoed for `'exponentially-weighted'`. */
    halfLifePeriods?: number;
    /** Echoed for `'capital-asset-pricing'`. */
    annualRiskFreeRate?: number;
    /** Echoed for `'capital-asset-pricing'`. */
    annualMarketRiskPremium?: number;
    /** The resolved point-in-time cut (epoch milliseconds), when `asOf` was given. */
    asOf?: EpochMs;
    /** Prose statement of exactly how the numbers were produced. */
    estimationConvention: string;
  };
  diagnostics: Diagnostics & {
    /** Return observations consumed (after point-in-time screening); 0 for methods without a sample. */
    sampleSize: number;
    /** `(Σw)² / Σw²` of the observation weights (`'exponentially-weighted'` only). */
    effectiveSampleSize?: number;
    /** Rows excluded because their timestamp is after `asOf` (when both were supplied). */
    excludedAfterAsOf?: number;
  };
}

const FUNCTION_NAME = 'estimateExpectedReturns';

const METHODS: readonly ExpectedReturnsMethod[] = [
  'historical-mean',
  'exponentially-weighted',
  'capital-asset-pricing',
  'supplied',
];

const SAMPLE_KEYS = [
  'method',
  'returns',
  'periodsPerYear',
  'assetIds',
  'observationTimestamps',
  'asOf',
] as const;

/** The documented keys of every branch — Law 12: an unknown field throws, never no-ops. */
const KEYS_BY_METHOD: Record<ExpectedReturnsMethod, readonly string[]> = {
  'historical-mean': SAMPLE_KEYS,
  'exponentially-weighted': [...SAMPLE_KEYS, 'halfLifePeriods'],
  'capital-asset-pricing': [
    'method',
    'betas',
    'annualRiskFreeRate',
    'annualMarketRiskPremium',
    'assetIds',
  ],
  supplied: ['method', 'expectedReturns', 'annualized', 'assetIds'],
};

const EXAMPLE_CALL =
  "estimateExpectedReturns({ method: 'historical-mean', returns, periodsPerYear: 252 })";

/** Validate optional asset labels: an array of strings, one per asset. */
function resolveAssetIds(assetIds: unknown, assetCount: number): string[] | undefined {
  if (assetIds === undefined) return undefined;
  requireArgumentArray(FUNCTION_NAME, 'input.assetIds', assetIds);
  const labels = assetIds as unknown[];
  if (labels.length !== assetCount) {
    throw new InputError(
      `${FUNCTION_NAME}: input.assetIds lists ${labels.length} labels for ${assetCount} assets.`,
      {
        code: ErrorCode.InputLengthMismatch,
        context: { labels: labels.length, assets: assetCount },
      },
    );
  }
  for (let k = 0; k < labels.length; k++) {
    if (typeof labels[k] !== 'string') {
      throw new InputError(
        `${FUNCTION_NAME}: input.assetIds[${k}] must be a string label, got ${labels[k] === null ? 'null' : typeof labels[k]}.`,
        { code: ErrorCode.InputWrongType, context: { index: k, received: labels[k] } },
      );
    }
  }
  return labels as string[];
}

/** A required finite scalar field. */
function requireFiniteField(input: Record<string, unknown>, field: string): number {
  const value = input[field];
  if (value === undefined) {
    throw new InputError(
      `${FUNCTION_NAME}: ${field} is required for method '${String(input['method'])}'.`,
      { code: ErrorCode.InputMissingField, context: { field } },
    );
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `${FUNCTION_NAME}: ${field} must be a finite number, got ${value === null ? 'null' : String(value)}.`,
      { code: ErrorCode.InputNotFinite, context: { field, received: value } },
    );
  }
  return value;
}

/** A non-empty array of finite numbers (betas, supplied expected returns). */
function requireFiniteVector(input: Record<string, unknown>, field: string): number[] {
  const value = input[field];
  if (value === undefined) {
    throw new InputError(
      `${FUNCTION_NAME}: ${field} is required for method '${String(input['method'])}'.`,
      { code: ErrorCode.InputMissingField, context: { field } },
    );
  }
  requireArgumentArray(FUNCTION_NAME, `input.${field}`, value);
  const vector = value as unknown[];
  if (vector.length === 0) {
    throw new InputError(`${FUNCTION_NAME}: input.${field} must list at least one asset.`, {
      code: ErrorCode.InputWrongShape,
      context: { field, length: 0 },
    });
  }
  for (let k = 0; k < vector.length; k++) {
    const entry = vector[k];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw new InputError(
        `${FUNCTION_NAME}: input.${field}[${k}] is not a finite number (${String(entry)}).`,
        { code: ErrorCode.InputNotFinite, context: { field, index: k } },
      );
    }
  }
  return vector as number[];
}

/** One observation instant: finite epoch milliseconds, or a date string through core's time grammar. */
function resolveObservationInstant(value: unknown, index: number): EpochMs {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InputError(
        `${FUNCTION_NAME}: observationTimestamps[${index}] must be finite epoch milliseconds, got ${value}.`,
        { code: ErrorCode.InputNotFinite, context: { index, received: value } },
      );
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw new InputError(
      `${FUNCTION_NAME}: observationTimestamps[${index}] must be epoch milliseconds or an ISO date string. Received ${value === null ? 'null' : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { index, received: value } },
    );
  }
  return resolveAsOf(value, `${FUNCTION_NAME} (observationTimestamps[${index}])`);
}

interface ResolvedSample {
  rows: number[][];
  observations: number;
  assetCount: number;
  assetIds: string[] | undefined;
  periodsPerYear: number | undefined;
  asOf: EpochMs | undefined;
  excludedAfterAsOf: number | undefined;
  warnings: QuantWarning[];
}

/** Validate a sample-method request and apply the point-in-time screen. */
function resolveSample(input: SampleExpectedReturnsFields): ResolvedSample {
  const { T, p } = validateReturnsInput(FUNCTION_NAME, { returns: input.returns });
  if (
    input.periodsPerYear !== undefined &&
    !(
      typeof input.periodsPerYear === 'number' &&
      input.periodsPerYear > 0 &&
      Number.isFinite(input.periodsPerYear)
    )
  ) {
    throw new InputError(
      `${FUNCTION_NAME}: periodsPerYear must be a positive FINITE number (got ${String(input.periodsPerYear)}) — omit it for per-period means.`,
      { code: ErrorCode.InputOutOfRange, context: { periodsPerYear: input.periodsPerYear } },
    );
  }
  const assetIds = resolveAssetIds(input.assetIds, p);
  const warnings: QuantWarning[] = [];

  let timestamps: EpochMs[] | undefined;
  if (input.observationTimestamps !== undefined) {
    requireArgumentArray(FUNCTION_NAME, 'input.observationTimestamps', input.observationTimestamps);
    const raw = input.observationTimestamps as unknown[];
    if (raw.length !== T) {
      throw new InputError(
        `${FUNCTION_NAME}: observationTimestamps lists ${raw.length} instants for ${T} return rows — they must align 1:1.`,
        {
          code: ErrorCode.InputLengthMismatch,
          context: { timestamps: raw.length, rows: T },
        },
      );
    }
    timestamps = raw.map((value, index) => resolveObservationInstant(value, index));
    for (let t = 1; t < T; t++) {
      if (timestamps[t]! < timestamps[t - 1]!) {
        throw new InputError(
          `${FUNCTION_NAME}: observationTimestamps must be non-decreasing — row ${t} (${timestamps[t]}) is earlier than row ${t - 1} (${timestamps[t - 1]}). Sort the rows chronologically.`,
          { code: ErrorCode.InputOutOfRange, context: { row: t, previousRow: t - 1 } },
        );
      }
    }
  }

  let asOf: EpochMs | undefined;
  let rows = input.returns;
  let excludedAfterAsOf: number | undefined;
  if (input.asOf !== undefined) {
    asOf = resolveAsOf(input.asOf, FUNCTION_NAME);
    if (timestamps === undefined) {
      warnings.push(
        warning(
          WarningCode.RiskAsOfUnscreened,
          `${FUNCTION_NAME}: asOf was supplied without observationTimestamps, so no row could be screened — all ${T} rows were used. Pass observationTimestamps aligned to the rows to enforce the point-in-time cut.`,
          'warn',
          { asOf, rows: T },
        ),
      );
    } else {
      const cutoff = asOf;
      rows = input.returns.filter((_, t) => timestamps![t]! <= cutoff);
      excludedAfterAsOf = T - rows.length;
      if (rows.length === 0) {
        throw new InputError(
          `${FUNCTION_NAME}: every one of the ${T} observations is after asOf (${asOf}) — nothing remains to estimate from. Move asOf later or supply earlier history.`,
          { code: ErrorCode.InputOutOfRange, context: { asOf, rows: T } },
        );
      }
    }
  }

  return {
    rows,
    observations: rows.length,
    assetCount: p,
    assetIds,
    periodsPerYear: input.periodsPerYear,
    asOf,
    excludedAfterAsOf,
    warnings,
  };
}

const annualizationClause = (periodsPerYear: number | undefined): string =>
  periodsPerYear !== undefined
    ? `, annualized by multiplying by periodsPerYear = ${periodsPerYear}`
    : ' (per-period, not annualized)';

/**
 * Estimate per-asset expected returns under an EXPLICIT method — the `mean` for `maxSharpe`,
 * `meanVariance`, `kelly`, and `efficientFrontier`.
 *
 * ```ts
 * estimateExpectedReturns({ method: 'historical-mean', returns, periodsPerYear: 252 });
 * estimateExpectedReturns({ method: 'exponentially-weighted', returns, halfLifePeriods: 60 });
 * estimateExpectedReturns({
 *   method: 'capital-asset-pricing',
 *   betas: [0.8, 1.2],
 *   annualRiskFreeRate: 0.04,
 *   annualMarketRiskPremium: 0.05,
 * });
 * estimateExpectedReturns({ method: 'supplied', expectedReturns: [0.08, 0.1], annualized: true });
 * ```
 *
 * `value.annualized` always states the unit of the result; the sample methods report per-period
 * means unless `periodsPerYear` is given, the capital-asset-pricing method is annual by
 * construction, and the supplied method carries the caller's own flag.
 */
export function estimateExpectedReturns(
  input: EstimateExpectedReturnsInput,
): ExpectedReturnsResult {
  requireArgumentObject(FUNCTION_NAME, 'input', input);
  const record = input as unknown as Record<string, unknown>;
  const method = record['method'];
  if (method === undefined) {
    throw new InputError(
      `${FUNCTION_NAME}: method is required — one of ${METHODS.map((m) => `'${m}'`).join(' | ')}.\n  e.g. ${EXAMPLE_CALL}`,
      { code: ErrorCode.InputMissingField, context: { field: 'method' } },
    );
  }
  if (typeof method !== 'string' || !(METHODS as readonly string[]).includes(method)) {
    throw new InputError(
      `${FUNCTION_NAME}: method must be one of ${METHODS.map((m) => `'${m}'`).join(' | ')}. Received ${method === null ? 'null' : typeof method === 'string' ? `"${method}"` : typeof method}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'method', received: method } },
    );
  }
  const branch = method as ExpectedReturnsMethod;
  ensureKnownKeys(FUNCTION_NAME, 'input', input, KEYS_BY_METHOD[branch]);

  let result: ExpectedReturnsResult;
  switch (branch) {
    case 'historical-mean': {
      const sample = resolveSample(input as HistoricalMeanExpectedReturnsInput);
      // Composes `meanReturns` on the screened rows — bit-identical to calling it directly.
      const expectedReturns = meanReturns({
        returns: sample.rows,
        ...(sample.periodsPerYear !== undefined ? { periodsPerYear: sample.periodsPerYear } : {}),
      });
      result = {
        value: {
          expectedReturns,
          annualized: sample.periodsPerYear !== undefined,
          ...(sample.assetIds !== undefined ? { assetIds: sample.assetIds } : {}),
        },
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          method: branch,
          ...(sample.periodsPerYear !== undefined ? { periodsPerYear: sample.periodsPerYear } : {}),
          ...(sample.asOf !== undefined ? { asOf: sample.asOf } : {}),
          estimationConvention: `arithmetic mean of ${sample.observations} per-period simple returns per asset (equal weights)${annualizationClause(sample.periodsPerYear)}`,
        },
        diagnostics: {
          warnings: sample.warnings,
          sampleSize: sample.observations,
          ...(sample.excludedAfterAsOf !== undefined
            ? { excludedAfterAsOf: sample.excludedAfterAsOf }
            : {}),
        },
      };
      break;
    }
    case 'exponentially-weighted': {
      const halfLifePeriods = record['halfLifePeriods'];
      if (halfLifePeriods === undefined) {
        throw new InputError(
          `${FUNCTION_NAME}: halfLifePeriods is required for method 'exponentially-weighted' (the decay half-life in periods; there is no universal default).`,
          { code: ErrorCode.InputMissingField, context: { field: 'halfLifePeriods' } },
        );
      }
      if (typeof halfLifePeriods !== 'number' || !Number.isFinite(halfLifePeriods)) {
        throw new InputError(
          `${FUNCTION_NAME}: halfLifePeriods must be a finite number of periods, got ${halfLifePeriods === null ? 'null' : String(halfLifePeriods)}.`,
          { code: ErrorCode.InputNotFinite, context: { halfLifePeriods } },
        );
      }
      if (!(halfLifePeriods > 0)) {
        throw new InputError(
          `${FUNCTION_NAME}: halfLifePeriods must be > 0 (a weight half-life in periods), got ${halfLifePeriods}.`,
          { code: ErrorCode.InputOutOfRange, context: { halfLifePeriods } },
        );
      }
      const sample = resolveSample(input as ExponentiallyWeightedExpectedReturnsInput);
      const T = sample.observations;
      const p = sample.assetCount;
      // w_t ∝ 0.5^((T − 1 − t) / halfLife): the last row carries weight 1, each half-life back halves.
      let weightSum = 0;
      let weightSquareSum = 0;
      const sums = new Array<number>(p).fill(0);
      for (let t = 0; t < T; t++) {
        const w = 0.5 ** ((T - 1 - t) / halfLifePeriods);
        weightSum += w;
        weightSquareSum += w * w;
        const row = sample.rows[t]!;
        for (let k = 0; k < p; k++) sums[k]! += w * row[k]!;
      }
      const scale = sample.periodsPerYear ?? 1;
      const expectedReturns = sums.map((s) => (s / weightSum) * scale);
      const effectiveSampleSize = (weightSum * weightSum) / weightSquareSum;
      result = {
        value: {
          expectedReturns,
          annualized: sample.periodsPerYear !== undefined,
          ...(sample.assetIds !== undefined ? { assetIds: sample.assetIds } : {}),
        },
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          method: branch,
          ...(sample.periodsPerYear !== undefined ? { periodsPerYear: sample.periodsPerYear } : {}),
          halfLifePeriods,
          ...(sample.asOf !== undefined ? { asOf: sample.asOf } : {}),
          estimationConvention: `exponentially weighted mean over ${T} per-period simple returns with weights proportional to 0.5^((T − 1 − t) / ${halfLifePeriods}) (most recent observation heaviest), normalized to sum to 1${annualizationClause(sample.periodsPerYear)}`,
        },
        diagnostics: {
          warnings: sample.warnings,
          sampleSize: T,
          effectiveSampleSize,
          ...(sample.excludedAfterAsOf !== undefined
            ? { excludedAfterAsOf: sample.excludedAfterAsOf }
            : {}),
        },
      };
      break;
    }
    case 'capital-asset-pricing': {
      const betas = requireFiniteVector(record, 'betas');
      const annualRiskFreeRate = requireFiniteField(record, 'annualRiskFreeRate');
      const annualMarketRiskPremium = requireFiniteField(record, 'annualMarketRiskPremium');
      const assetIds = resolveAssetIds(record['assetIds'], betas.length);
      // FC2's direct primitive, composed per asset — never re-derived here.
      const expectedReturns = betas.map((beta) =>
        capitalAssetPricingExpectedReturn({ annualRiskFreeRate, beta, annualMarketRiskPremium }),
      );
      result = {
        value: {
          expectedReturns,
          annualized: true,
          ...(assetIds !== undefined ? { assetIds } : {}),
        },
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          method: branch,
          annualRiskFreeRate,
          annualMarketRiskPremium,
          estimationConvention: `annual risk-free rate + beta × annual market risk premium per asset (composes @totalfinance/valuation capitalAssetPricingExpectedReturn); annual by construction — no return sample is consumed`,
        },
        diagnostics: { warnings: [], sampleSize: 0 },
      };
      break;
    }
    case 'supplied': {
      const expectedReturns = requireFiniteVector(record, 'expectedReturns');
      const annualized = record['annualized'];
      if (annualized === undefined) {
        throw new InputError(
          `${FUNCTION_NAME}: annualized is required for method 'supplied' — state whether the supplied expected returns are annual (true) or per-period (false).`,
          { code: ErrorCode.InputMissingField, context: { field: 'annualized' } },
        );
      }
      if (typeof annualized !== 'boolean') {
        throw new InputError(
          `${FUNCTION_NAME}: annualized must be a boolean. Received ${annualized === null ? 'null' : typeof annualized}.`,
          {
            code: ErrorCode.InputWrongType,
            context: { field: 'annualized', received: annualized },
          },
        );
      }
      const assetIds = resolveAssetIds(record['assetIds'], expectedReturns.length);
      result = {
        value: {
          expectedReturns: expectedReturns.slice(),
          annualized,
          ...(assetIds !== undefined ? { assetIds } : {}),
        },
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          method: branch,
          estimationConvention: `caller-supplied expected returns passed through after finiteness validation; declared ${annualized ? 'annual' : 'per-period'} by the caller — no return sample is consumed`,
        },
        diagnostics: { warnings: [], sampleSize: 0 },
      };
      break;
    }
  }
  // Law 7 finalizer: a non-finite estimate (e.g. an overflowing annualization) is a typed refusal,
  // never a warning beside a NaN.
  return requireRepresentableResult(FUNCTION_NAME, result);
}
