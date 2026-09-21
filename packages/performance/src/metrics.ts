/** Annualized return, Sortino, and Calmar ratios (spec §15.1). */

import {
  ensureFiniteWhenPresent,
  type Computed,
  seriesFacade,
  finiteOrNull,
  ensureKnownKeys,
} from '@totalfinance/core';
import { mean } from '@totalfinance/math';
import { maxDrawdown } from './drawdown.js';
import { equityCurve } from './returns.js';
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

function annualizedReturnValue(returns: ArrayLike<number>, options: AnnualizationOptions): number {
  requireSeries(returns, 'annualizedReturn');
  // Law 12: shared by the plain call AND `.explain()` — an unknown option teaches, never ignored.
  ensureKnownKeys('annualizedReturn', 'options', options, ANNUALIZATION_KEYS);
  // Resolved before the empty-series early return (never return on malformed input).
  const ppy = resolvePeriodsPerYear('annualizedReturn', options);
  const n = returns.length;
  if (n === 0) return NaN;
  let growth = 1;
  for (let i = 0; i < n; i++) growth *= 1 + returns[i]!;
  return growth ** (ppy / n) - 1;
}

/** Geometric annualized return from a per-period return series. */
export const annualizedReturn = seriesFacade(
  'annualizedReturn',
  (returns: ArrayLike<number>, options: AnnualizationOptions = {}): number | null =>
    finiteOrNull(annualizedReturnValue(returns, options)),
  (
    returns: ArrayLike<number>,
    options: AnnualizationOptions = {},
  ): Computed<number | null, AnnualizationExtra> => {
    const value = annualizedReturnValue(returns, options);
    return {
      value: finiteOrNull(value),
      assumptions: annualizationAssumptions(resolvePeriodsPerYear('annualizedReturn', options)),
      diagnostics: degenerateAwareDiagnostics(
        value,
        'annualizedReturn',
        'the return series is empty (no periods to compound)',
        returns,
      ),
    };
  },
);

export interface SortinoOptions extends SharpeOptions {
  /** Minimum acceptable per-period return (default 0). */
  targetReturn?: number;
}

/** Law 12 allowlist for {@link SortinoOptions} — the inherited Sharpe keys plus the target return. */
const SORTINO_KEYS = [...SHARPE_KEYS, 'targetReturn'] as const;

function sortinoRatioValue(returns: ArrayLike<number>, options: SortinoOptions): number {
  requireSeries(returns, 'sortino');
  ensureKnownKeys('sortino', 'options', options, SORTINO_KEYS);
  const ppy = resolvePeriodsPerYear('sortino', options);
  const rfPerPeriod = resolveRiskFreeRate('sortino', options) / ppy;
  ensureFiniteWhenPresent(options.targetReturn, 'targetReturn', 'sortino');
  const target = options.targetReturn ?? 0;
  const n = returns.length;
  if (n === 0) return NaN;
  const excess = new Array<number>(n);
  let downSq = 0;
  for (let i = 0; i < n; i++) {
    excess[i] = returns[i]! - rfPerPeriod;
    const below = Math.min(0, returns[i]! - target);
    downSq += below * below;
  }
  const downsideDev = Math.sqrt(downSq / n);
  if (downsideDev === 0) return NaN;
  return (mean(excess) / downsideDev) * Math.sqrt(ppy);
}

/** Annualized Sortino ratio (downside-deviation-adjusted). */
export const sortino = seriesFacade(
  'sortino',
  (returns: ArrayLike<number>, options: SortinoOptions = {}): number | null =>
    finiteOrNull(sortinoRatioValue(returns, options)),
  (
    returns: ArrayLike<number>,
    options: SortinoOptions = {},
  ): Computed<number | null, RiskAdjustedExtra> => {
    const value = sortinoRatioValue(returns, options);
    return {
      value: finiteOrNull(value),
      assumptions: riskAdjustedAssumptions({
        periodsPerYear: resolvePeriodsPerYear('sortino', options),
        riskFreeRate: resolveRiskFreeRate('sortino', options),
      }),
      diagnostics: degenerateAwareDiagnostics(
        value,
        'sortino',
        'no period falls below the target return (zero downside deviation) or the series is empty',
        returns,
      ),
    };
  },
);

function calmarRatioValue(returns: ArrayLike<number>, options: AnnualizationOptions): number {
  requireSeries(returns, 'calmar');
  ensureKnownKeys('calmar', 'options', options, ANNUALIZATION_KEYS);
  // Validate the options before the zero-drawdown early return (never return on malformed input);
  // annualizedReturnValue re-resolves the same value for its own use.
  resolvePeriodsPerYear('calmar', options);
  const dd = maxDrawdown(equityCurve(returns)).maxDrawdown;
  if (dd === 0) return NaN;
  return annualizedReturnValue(returns, options) / dd;
}

/** Calmar ratio: annualized return divided by maximum drawdown. */
export const calmar = seriesFacade(
  'calmar',
  (returns: ArrayLike<number>, options: AnnualizationOptions = {}): number | null =>
    finiteOrNull(calmarRatioValue(returns, options)),
  (
    returns: ArrayLike<number>,
    options: AnnualizationOptions = {},
  ): Computed<number | null, AnnualizationExtra> => {
    const value = calmarRatioValue(returns, options);
    return {
      value: finiteOrNull(value),
      assumptions: annualizationAssumptions(resolvePeriodsPerYear('calmar', options)),
      diagnostics: degenerateAwareDiagnostics(
        value,
        'calmar',
        'the equity curve never draws down (max drawdown is 0) or the series is empty',
        returns,
      ),
    };
  },
);
