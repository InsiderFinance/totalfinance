/**
 * `@totalfinance/performance/sharpe` — the Sharpe ratio and annualized volatility.
 *
 * This deep entrypoint imports only `@totalfinance/math` (mean/stddev) and tiny `@totalfinance/core` facade
 * plumbing — never options, fixed-income, risk, or data packages — so computing a Sharpe ratio stays
 * import-light (spec §15.1).
 *
 * Each metric is a facade (design law #3): the plain call returns a bare number; `.explain()` returns
 * the `Computed` envelope echoing the annualization factor (and, where used, the risk-free rate) it
 * applied — so a defaulted `periodsPerYear: 252` is disclosed, never hidden.
 */

import {
  requireFiniteFields,
  CONVENTIONS_VERSION,
  type Assumptions,
  type Computed,
  type Diagnostics,
  ErrorCode,
  InputError,
  seriesFacade,
  suspiciousReturnsWarning,
  warning,
  WarningCode,
  finiteOrNull,
  ensureKnownKeys,
  requireArgumentObject,
} from '@totalfinance/core';
import { resolvePeriodsPerYear, resolveRiskFreeRate } from './annualization-internal.js';
import { mean, standardDeviation } from '@totalfinance/math';

/**
 * Boundary guard for every series-consuming performance facade (dx §1.2 applied here): the input
 * must be a real array (or typed array) of numbers — a string, `undefined`, or a plain object
 * throws a typed teaching error instead of a raw `TypeError` from `series.length` downstream.
 * The container being an array is not enough: EVERY element is validated (E4) — a single NaN,
 * `undefined`, or string mid-series poisons a mean/stddev into a silently-wrong number, and a
 * `sharpe([0.01, NaN, 0.02])` masquerading as a real ratio is exactly the corruption Law 7 kills
 * at the boundary. A `Float64Array` of finite values always passes; empty arrays keep their
 * documented null-with-reason behavior downstream.
 */
export function requireSeries(
  series: ArrayLike<number>,
  functionName: string,
  field = 'returns',
): void {
  // This validator is itself public API: a garbled functionName would emit teaching that names no
  // function, so it runs its own ladder first.
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new InputError(
      `requireSeries: functionName must be a non-empty string naming the boundary being validated. Received ${functionName === undefined ? 'undefined' : functionName === null ? 'null' : typeof functionName}.`,
      { code: ErrorCode.InputWrongType, context: { functionName } },
    );
  }
  if (!Array.isArray(series) && !ArrayBuffer.isView(series)) {
    const received = series === null ? 'null' : typeof series;
    throw new InputError(
      `${functionName}: ${field} must be an array of numbers (got ${received}). e.g. ${functionName}([0.01, -0.02, 0.015])`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field, received } },
    );
  }
  for (let i = 0; i < series.length; i++) {
    const v: unknown = series[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      const received = typeof v === 'number' ? String(v) : typeof v;
      throw new InputError(
        `${functionName}: ${field}[${i}] must be a finite number (got ${received}) — a non-finite value would silently poison every metric. ${functionName} expects per-period decimal returns, e.g. ${functionName}([0.01, -0.02, 0.015]).`,
        {
          // Wrong CONTAINER content (a string) is a type error; a NaN/Infinity NUMBER is not-finite.
          code: typeof v === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
          context: { function: functionName, field, index: i, received },
        },
      );
    }
  }
}

/**
 * The daily-data annualization convention. It is an industry constant (252 trading days), not a
 * hidden finance choice — so it DEFAULTS when omitted and is echoed back in the result's assumptions.
 * Use 12 for monthly data, 52 for weekly.
 */
export const DEFAULT_PERIODS_PER_YEAR = 252;

export interface AnnualizationOptions {
  /** Periods per year for annualization. Defaults to 252 (daily); pass 12 monthly, 52 weekly. */
  periodsPerYear?: number;
}

/** Law 12 allowlist for {@link AnnualizationOptions} — a `periodsPeryear` typo teaches, never silently annualizes at 252. */
export const ANNUALIZATION_KEYS = ['periodsPerYear'] as const;

export interface SharpeOptions extends AnnualizationOptions {
  /** Annualized risk-free rate (decimal, default 0). */
  riskFreeRate?: number;
}

/** Law 12 allowlist for {@link SharpeOptions} — the parent's keys plus the risk-free rate. */
export const SHARPE_KEYS = [...ANNUALIZATION_KEYS, 'riskFreeRate'] as const;

/** Conventions disclosed by an annualization-only metric. */
export type AnnualizationExtra = { periodsPerYear: number };
/** Conventions disclosed by a risk-adjusted (excess-return) metric. */
export type RiskAdjustedExtra = { periodsPerYear: number; riskFreeRate: number };

/** Assumptions echoing just the annualization factor. */
export function annualizationAssumptions(periodsPerYear: number): Assumptions<AnnualizationExtra> {
  return { conventionsVersion: CONVENTIONS_VERSION, periodsPerYear };
}

/** Assumptions echoing the annualization factor and the applied risk-free rate. */
export function riskAdjustedAssumptions(input: RiskAdjustedExtra): Assumptions<RiskAdjustedExtra> {
  requireArgumentObject('riskAdjustedAssumptions', 'input', input);
  ensureKnownKeys('riskAdjustedAssumptions', 'input', input, ['periodsPerYear', 'riskFreeRate']);
  // What lands here is DISCLOSED as the applied conventions — a null or string smuggled into
  // `assumptions` would be served to the caller as truth.
  requireFiniteFields('riskAdjustedAssumptions', input, ['periodsPerYear', 'riskFreeRate'], {
    exampleCall: 'riskAdjustedAssumptions({ periodsPerYear: 252, riskFreeRate: 0.04 })',
  });
  const { periodsPerYear, riskFreeRate } = input;
  return { conventionsVersion: CONVENTIONS_VERSION, periodsPerYear, riskFreeRate };
}

/**
 * Diagnostics for a returns-consuming explain path (dx WS-3/R6): flags any input series whose
 * values look like prices rather than per-period decimal returns. Shared by every returns-typed
 * metric in this package (and risk); equity/price-typed parameters must NOT use it.
 */
export function returnsDiagnostics(...series: ArrayLike<number>[]): Diagnostics {
  // Publicly reachable via the /sharpe subpath: a non-series argument yields no diagnostics
  // rather than a raw crash (the metric facades validate the series before ever calling this).
  series = series.filter((s) => s !== null && typeof s === 'object' && 'length' in s);
  const warnings = [];
  for (const s of series) {
    const w = suspiciousReturnsWarning(s);
    if (w !== undefined) {
      warnings.push(w);
      break; // one warning is enough to make the point
    }
  }
  return { warnings };
}

/**
 * Degenerate-NaN honesty (design law #4: a NaN result must ride with an explicit diagnostic, never
 * alone). Wraps {@link returnsDiagnostics} and — when the computed `value` is NaN — appends a
 * `WarningCode.DegenerateInput` warning saying WHY the metric is undefined for this input. Used by
 * the `.explain()` paths only; plain calls stay silent-and-correct (they still return the NaN).
 * Pass no `series` for non-returns inputs (e.g. weight rows) where the prices-as-returns
 * plausibility scan must not apply.
 */
export function degenerateAwareDiagnostics(
  value: number,
  functionName: string,
  reason: string,
  ...series: ArrayLike<number>[]
): Diagnostics {
  // `value` may legitimately be NaN/±Infinity — that is the case this helper explains — but it
  // must BE a number, and the labels must be strings, or the disclosure this builds would lie.
  if (typeof value !== 'number' || typeof functionName !== 'string' || typeof reason !== 'string') {
    throw new InputError(
      `degenerateAwareDiagnostics: expected (value: number, functionName: string, reason: string, ...series). Received (${typeof value}, ${typeof functionName}, ${typeof reason}).`,
      { code: ErrorCode.InputWrongType, context: { value, functionName } },
    );
  }
  const d = returnsDiagnostics(...series);
  // Law 7 (D3): NaN AND ±Infinity are both undefined-metric cases — the facade reports null and
  // this warning names the exact metric and why.
  if (!Number.isFinite(value)) {
    d.warnings.push(
      warning(
        WarningCode.DegenerateInput,
        `${functionName}: the metric is undefined — ${reason}; reported as null (never NaN/Infinity).`,
        'info',
        {
          function: functionName,
          metric: functionName,
        },
      ),
    );
  }
  return d;
}

function annualizedVolatilityValue(
  returns: ArrayLike<number>,
  options: AnnualizationOptions,
): number {
  requireSeries(returns, 'annualizedVolatility');
  // Law 12: shared by the plain call AND `.explain()` — an unknown option teaches, never ignored.
  ensureKnownKeys('annualizedVolatility', 'options', options, ANNUALIZATION_KEYS);
  return (
    standardDeviation(returns) * Math.sqrt(resolvePeriodsPerYear('annualizedVolatility', options))
  );
}

/** Annualized volatility: per-period stddev scaled by √periodsPerYear. */
export const annualizedVolatility = seriesFacade(
  'annualizedVolatility',
  (returns: ArrayLike<number>, options: AnnualizationOptions = {}): number | null =>
    finiteOrNull(annualizedVolatilityValue(returns, options)),
  (
    returns: ArrayLike<number>,
    options: AnnualizationOptions = {},
  ): Computed<number | null, AnnualizationExtra> => {
    const value = annualizedVolatilityValue(returns, options);
    return {
      value: finiteOrNull(value),
      assumptions: annualizationAssumptions(resolvePeriodsPerYear('annualizedVolatility', options)),
      diagnostics: degenerateAwareDiagnostics(
        value,
        'annualizedVolatility',
        'the sample standard deviation needs at least 2 periods (the series is empty or has one element)',
        returns,
      ),
    };
  },
);

function sharpeRatioValue(returns: ArrayLike<number>, options: SharpeOptions): number {
  requireSeries(returns, 'sharpe');
  ensureKnownKeys('sharpe', 'options', options, SHARPE_KEYS);
  const ppy = resolvePeriodsPerYear('sharpe', options);
  const rfPerPeriod = resolveRiskFreeRate('sharpe', options) / ppy;
  const excess = new Array<number>(returns.length);
  for (let i = 0; i < returns.length; i++) excess[i] = returns[i]! - rfPerPeriod;
  const sd = standardDeviation(excess);
  if (sd === 0) return NaN;
  return (mean(excess) / sd) * Math.sqrt(ppy);
}

/** Annualized Sharpe ratio of a per-period return series. */
export const sharpe = seriesFacade(
  'sharpe',
  (returns: ArrayLike<number>, options: SharpeOptions = {}): number | null =>
    finiteOrNull(sharpeRatioValue(returns, options)),
  (
    returns: ArrayLike<number>,
    options: SharpeOptions = {},
  ): Computed<number | null, RiskAdjustedExtra> => {
    const value = sharpeRatioValue(returns, options);
    return {
      value: finiteOrNull(value),
      assumptions: riskAdjustedAssumptions({
        periodsPerYear: resolvePeriodsPerYear('sharpe', options),
        riskFreeRate: resolveRiskFreeRate('sharpe', options),
      }),
      diagnostics: degenerateAwareDiagnostics(
        value,
        'sharpe',
        'the excess returns have zero variance (or fewer than 2 periods), so there is no dispersion to divide by',
        returns,
      ),
    };
  },
);
