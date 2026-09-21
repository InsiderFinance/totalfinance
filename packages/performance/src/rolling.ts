/**
 * `@totalfinance/performance/rolling` — rolling-window performance metrics (spec §15.1).
 *
 * Each returns one value per input period, aligned to the input index: `out[i]` is the metric over the
 * trailing `window` periods ending at `i`, and the first `window − 1` entries are `NaN` (insufficient
 * history). This matches the `@totalfinance/math` rolling primitives these build on, so a windowed
 * Sharpe/vol lines up with the original series for plotting or merging.
 *
 * Each is a facade (dx §2.3): `.explain()` returns the `Computed` envelope with the resolved window
 * and conventions in `assumptions` and the warmup count (`window − 1`) in `diagnostics.warmup` —
 * the same envelope grammar as the TA indicators.
 */

import {
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  seriesFacade,
  ensureKnownKeys,
} from '@totalfinance/core';
import { rollingMean, rollingStandardDeviation } from '@totalfinance/math';
import {
  ANNUALIZATION_KEYS,
  type AnnualizationOptions,
  SHARPE_KEYS,
  type SharpeOptions,
  requireSeries,
  returnsDiagnostics,
} from './sharpe.js';
import { resolvePeriodsPerYear, resolveRiskFreeRate } from './annualization-internal.js';

function requireWindow(window: number, functionName: string): void {
  if (!Number.isSafeInteger(window) || window < 2) {
    throw new InputError(`${functionName}: window must be an integer ≥ 2, got ${window}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { window },
    });
  }
}

/** Envelope diagnostics for a rolling metric: the plausibility guard plus the window warmup. */
function rollingDiagnostics(
  returns: ArrayLike<number>,
  window: number,
): Computed<number[]>['diagnostics'] {
  return { ...returnsDiagnostics(returns), warmup: window - 1 };
}

function rollingVolatilityValue(
  returns: ArrayLike<number>,
  window: number,
  options: AnnualizationOptions,
): number[] {
  requireSeries(returns, 'rollingVolatility');
  requireWindow(window, 'rollingVolatility');
  // Law 12: shared by the plain call AND `.explain()` — an unknown option teaches, never ignored.
  ensureKnownKeys('rollingVolatility', 'options', options, ANNUALIZATION_KEYS);
  const scale = Math.sqrt(resolvePeriodsPerYear('rollingVolatility', options));
  return rollingStandardDeviation(returns, window).map((sd) => sd * scale);
}

/**
 * Rolling annualized volatility over a trailing window (leading `window − 1` entries are `NaN`).
 * `options.periodsPerYear` defaults to 252 — matching every other `rolling*(series, window, options?)`
 * sibling, so the annualization factor is no longer a bare positional scalar.
 */
export const rollingVolatility = seriesFacade(
  'rollingVolatility',
  (returns: ArrayLike<number>, window: number, options: AnnualizationOptions = {}): number[] =>
    rollingVolatilityValue(returns, window, options),
  (
    returns: ArrayLike<number>,
    window: number,
    options: AnnualizationOptions = {},
  ): Computed<number[], { window: number; periodsPerYear: number }> => ({
    value: rollingVolatilityValue(returns, window, options),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      window,
      periodsPerYear: resolvePeriodsPerYear('rollingVolatility', options),
    },
    diagnostics: rollingDiagnostics(returns, window),
  }),
);

function rollingSharpeValue(
  returns: ArrayLike<number>,
  window: number,
  options: SharpeOptions,
): number[] {
  requireSeries(returns, 'rollingSharpe');
  requireWindow(window, 'rollingSharpe');
  ensureKnownKeys('rollingSharpe', 'options', options, SHARPE_KEYS);
  const ppy = resolvePeriodsPerYear('rollingSharpe', options);
  const rfPerPeriod = resolveRiskFreeRate('rollingSharpe', options) / ppy;
  const n = returns.length;
  const excess = new Array<number>(n);
  for (let i = 0; i < n; i++) excess[i] = returns[i]! - rfPerPeriod;
  const means = rollingMean(excess, window);
  const sds = rollingStandardDeviation(excess, window);
  const scale = Math.sqrt(ppy);
  return means.map((m, i) => {
    const sd = sds[i]!;
    return Number.isFinite(m) && sd !== 0 ? (m / sd) * scale : NaN;
  });
}

/** Rolling annualized Sharpe ratio over a trailing window (leading `window − 1` entries are `NaN`). */
export const rollingSharpe = seriesFacade(
  'rollingSharpe',
  (returns: ArrayLike<number>, window: number, options: SharpeOptions = {}): number[] =>
    rollingSharpeValue(returns, window, options),
  (
    returns: ArrayLike<number>,
    window: number,
    options: SharpeOptions = {},
  ): Computed<number[], { window: number; periodsPerYear: number; riskFreeRate: number }> => ({
    value: rollingSharpeValue(returns, window, options),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      window,
      periodsPerYear: resolvePeriodsPerYear('rollingSharpe', options),
      riskFreeRate: resolveRiskFreeRate('rollingSharpe', options),
    },
    diagnostics: rollingDiagnostics(returns, window),
  }),
);

function rollingReturnValue(returns: ArrayLike<number>, window: number): number[] {
  requireSeries(returns, 'rollingReturn');
  requireWindow(window, 'rollingReturn');
  const n = returns.length;
  const out = new Array<number>(n).fill(NaN);
  for (let end = window; end <= n; end++) {
    let growth = 1;
    for (let i = end - window; i < end; i++) growth *= 1 + returns[i]!;
    out[end - 1] = growth - 1;
  }
  return out;
}

/**
 * Rolling compounded return over a trailing window (`Π(1 + r) − 1`), aligned to the input index with
 * the leading `window − 1` entries set to `NaN`.
 */
export const rollingReturn = seriesFacade(
  'rollingReturn',
  (returns: ArrayLike<number>, window: number): number[] => rollingReturnValue(returns, window),
  (returns: ArrayLike<number>, window: number): Computed<number[], { window: number }> => ({
    value: rollingReturnValue(returns, window),
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, window },
    diagnostics: rollingDiagnostics(returns, window),
  }),
);
