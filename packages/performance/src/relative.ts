/**
 * `@totalfinance/performance/relative` — benchmark-relative performance metrics (spec §15.1).
 *
 * Each takes a per-period strategy return series and an aligned benchmark return series (same length,
 * same periodicity) and reports the standard CAPM-style relationships: beta, Jensen's alpha, tracking
 * error, the information ratio, and the Treynor ratio. Imports only `@totalfinance/math` + `@totalfinance/core`.
 *
 * Every metric here is a facade (design law #3): the plain call returns a number; `.explain()`
 * echoes the annualization factor (and risk-free rate) where applied. `beta` applies no
 * annualization or risk-free convention, so its envelope discloses none beyond the conventions
 * version.
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type Computed,
  seriesFacade,
  finiteOrNull,
  ensureKnownKeys,
} from '@totalfinance/core';
import { covariance, mean, standardDeviation, variance } from '@totalfinance/math';
import { annualizedReturn } from './metrics.js';
import {
  ANNUALIZATION_KEYS,
  type AnnualizationExtra,
  type AnnualizationOptions,
  type RiskAdjustedExtra,
  SHARPE_KEYS,
  type SharpeOptions,
  annualizationAssumptions,
  degenerateAwareDiagnostics,
  requireSeries,
  riskAdjustedAssumptions,
} from './sharpe.js';
import { resolvePeriodsPerYear, resolveRiskFreeRate } from './annualization-internal.js';

function requireAligned(
  returns: ArrayLike<number>,
  benchmark: ArrayLike<number>,
  functionName: string,
): void {
  requireSeries(returns, functionName);
  requireSeries(benchmark, functionName, 'benchmark');
  if (returns.length !== benchmark.length) {
    throw new InputError(
      `${functionName}: returns length (${returns.length}) must match benchmark length (${benchmark.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { returns: returns.length, benchmark: benchmark.length },
      },
    );
  }
}

function betaValue(returns: ArrayLike<number>, benchmark: ArrayLike<number>): number {
  requireAligned(returns, benchmark, 'beta');
  const varB = variance(benchmark);
  if (varB === 0) return NaN;
  return covariance(returns, benchmark) / varB;
}

/** Beta: sensitivity of the strategy to the benchmark, `cov(r, b) / var(b)`. */
export const beta = seriesFacade(
  'beta',
  (returns: ArrayLike<number>, benchmark: ArrayLike<number>): number | null =>
    finiteOrNull(betaValue(returns, benchmark)),
  (returns: ArrayLike<number>, benchmark: ArrayLike<number>): Computed<number | null> => {
    const value = betaValue(returns, benchmark);
    return {
      value: finiteOrNull(value),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION },
      diagnostics: degenerateAwareDiagnostics(
        value,
        'beta',
        'the benchmark has zero variance (or fewer than 2 periods), so sensitivity to it is undefined',
        returns,
        benchmark,
      ),
    };
  },
);

function alphaValue(
  returns: ArrayLike<number>,
  benchmark: ArrayLike<number>,
  options: SharpeOptions,
): number {
  requireAligned(returns, benchmark, 'alpha');
  // Law 12: shared by the plain call AND `.explain()` — an unknown option teaches, never ignored.
  ensureKnownKeys('alpha', 'options', options, SHARPE_KEYS);
  // Resolve (and thereby VALIDATE) before any early return — an empty series must not smuggle a
  // null periodsPerYear past the ladder (the solver-family law: never return on malformed input).
  const ppy = resolvePeriodsPerYear('alpha', options);
  const rfPerPeriod = resolveRiskFreeRate('alpha', options) / ppy;
  if (returns.length === 0) return NaN;
  const b = betaValue(returns, benchmark);
  const perPeriod = mean(returns) - (rfPerPeriod + b * (mean(benchmark) - rfPerPeriod));
  return perPeriod * ppy;
}

/**
 * Annualized Jensen's alpha: the strategy's average return in excess of what its beta exposure to the
 * benchmark would predict, `α = ppy · (r̄ − [rf_p + β·(b̄ − rf_p)])` (rf split to a per-period rate).
 */
export const alpha = seriesFacade(
  'alpha',
  (
    returns: ArrayLike<number>,
    benchmark: ArrayLike<number>,
    options: SharpeOptions = {},
  ): number | null => finiteOrNull(alphaValue(returns, benchmark, options)),
  (
    returns: ArrayLike<number>,
    benchmark: ArrayLike<number>,
    options: SharpeOptions = {},
  ): Computed<number | null, RiskAdjustedExtra> => {
    const value = alphaValue(returns, benchmark, options);
    return {
      value: finiteOrNull(value),
      assumptions: riskAdjustedAssumptions({
        periodsPerYear: resolvePeriodsPerYear('alpha', options),
        riskFreeRate: resolveRiskFreeRate('alpha', options),
      }),
      diagnostics: degenerateAwareDiagnostics(
        value,
        'alpha',
        'the series is empty or beta is undefined (zero-variance benchmark)',
        returns,
        benchmark,
      ),
    };
  },
);

function trackingErrorValue(
  returns: ArrayLike<number>,
  benchmark: ArrayLike<number>,
  options: AnnualizationOptions,
): number {
  requireAligned(returns, benchmark, 'trackingError');
  ensureKnownKeys('trackingError', 'options', options, ANNUALIZATION_KEYS);
  const n = returns.length;
  const active = new Array<number>(n);
  for (let i = 0; i < n; i++) active[i] = returns[i]! - benchmark[i]!;
  return standardDeviation(active) * Math.sqrt(resolvePeriodsPerYear('trackingError', options));
}

/** Annualized tracking error: the volatility of the active (strategy − benchmark) return series. */
export const trackingError = seriesFacade(
  'trackingError',
  (
    returns: ArrayLike<number>,
    benchmark: ArrayLike<number>,
    options: AnnualizationOptions = {},
  ): number | null => finiteOrNull(trackingErrorValue(returns, benchmark, options)),
  (
    returns: ArrayLike<number>,
    benchmark: ArrayLike<number>,
    options: AnnualizationOptions = {},
  ): Computed<number | null, AnnualizationExtra> => {
    const value = trackingErrorValue(returns, benchmark, options);
    return {
      value: finiteOrNull(value),
      assumptions: annualizationAssumptions(resolvePeriodsPerYear('trackingError', options)),
      diagnostics: degenerateAwareDiagnostics(
        value,
        'trackingError',
        'the sample standard deviation of the active series needs at least 2 periods',
        returns,
        benchmark,
      ),
    };
  },
);

function informationRatioValue(
  returns: ArrayLike<number>,
  benchmark: ArrayLike<number>,
  options: AnnualizationOptions,
): number {
  requireAligned(returns, benchmark, 'informationRatio');
  ensureKnownKeys('informationRatio', 'options', options, ANNUALIZATION_KEYS);
  // Resolved before the degenerate early returns — see alphaValue.
  const ppy = resolvePeriodsPerYear('informationRatio', options);
  const n = returns.length;
  if (n === 0) return NaN;
  const active = new Array<number>(n);
  for (let i = 0; i < n; i++) active[i] = returns[i]! - benchmark[i]!;
  const sd = standardDeviation(active);
  if (sd === 0) return NaN;
  return (mean(active) / sd) * Math.sqrt(ppy);
}

/**
 * Information ratio: annualized mean active return divided by annualized tracking error — the Sharpe
 * ratio of the active (strategy − benchmark) return series.
 */
export const informationRatio = seriesFacade(
  'informationRatio',
  (
    returns: ArrayLike<number>,
    benchmark: ArrayLike<number>,
    options: AnnualizationOptions = {},
  ): number | null => finiteOrNull(informationRatioValue(returns, benchmark, options)),
  (
    returns: ArrayLike<number>,
    benchmark: ArrayLike<number>,
    options: AnnualizationOptions = {},
  ): Computed<number | null, AnnualizationExtra> => {
    const value = informationRatioValue(returns, benchmark, options);
    return {
      value: finiteOrNull(value),
      assumptions: annualizationAssumptions(resolvePeriodsPerYear('informationRatio', options)),
      diagnostics: degenerateAwareDiagnostics(
        value,
        'informationRatio',
        'the active (strategy − benchmark) series is empty or has zero variance (perfect tracking)',
        returns,
        benchmark,
      ),
    };
  },
);

function treynorRatioValue(
  returns: ArrayLike<number>,
  benchmark: ArrayLike<number>,
  options: SharpeOptions,
): number {
  requireAligned(returns, benchmark, 'treynorRatio');
  ensureKnownKeys('treynorRatio', 'options', options, SHARPE_KEYS);
  // Resolved before the degenerate early returns — see alphaValue.
  const ppy = resolvePeriodsPerYear('treynorRatio', options);
  const riskFreeRate = resolveRiskFreeRate('treynorRatio', options);
  const b = betaValue(returns, benchmark);
  if (b === 0 || !Number.isFinite(b)) return NaN;
  // Exact-shaped hand-off: annualizedReturn takes AnnualizationOptions only — a riskFreeRate here
  // would (rightly) trip its Law 12 guard.
  const annReturn = annualizedReturn(returns, { periodsPerYear: ppy });
  if (annReturn === null) return NaN;
  return (annReturn - riskFreeRate) / b;
}

/**
 * Treynor ratio: excess (over risk-free) annualized return per unit of systematic risk (beta),
 * `(annualizedReturn − rf) / β`. Uses the geometric annualized return for the numerator.
 */
export const treynor = seriesFacade(
  'treynor',
  (
    returns: ArrayLike<number>,
    benchmark: ArrayLike<number>,
    options: SharpeOptions = {},
  ): number | null => finiteOrNull(treynorRatioValue(returns, benchmark, options)),
  (
    returns: ArrayLike<number>,
    benchmark: ArrayLike<number>,
    options: SharpeOptions = {},
  ): Computed<number | null, RiskAdjustedExtra> => {
    const value = treynorRatioValue(returns, benchmark, options);
    return {
      value: finiteOrNull(value),
      assumptions: riskAdjustedAssumptions({
        periodsPerYear: resolvePeriodsPerYear('treynorRatio', options),
        riskFreeRate: resolveRiskFreeRate('treynorRatio', options),
      }),
      diagnostics: degenerateAwareDiagnostics(
        value,
        'treynor',
        'beta is zero or undefined, so return per unit of systematic risk is undefined',
        returns,
        benchmark,
      ),
    };
  },
);
