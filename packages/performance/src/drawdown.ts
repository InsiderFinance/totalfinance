/** Drawdown analytics (spec §15.1). */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type Computed,
  seriesFacade,
} from '@totalfinance/core';
import { requireSeries } from './sharpe.js';

/** C (hygiene): a drawdown needs a series — an empty one has no peak to draw down from. */
function requireNonEmpty(series: ArrayLike<number>, functionName: string, field: string): void {
  if (series.length === 0) {
    throw new InputError(
      `${functionName}: ${field} must not be empty — a drawdown needs at least one observation to name a peak. e.g. ${functionName}([100, 120, 90, 110]).`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field, length: 0 } },
    );
  }
}

export interface DrawdownResult {
  /** Maximum drawdown as a positive fraction (0.2 = a 20% peak-to-trough decline). */
  maxDrawdown: number;
  /** Index of the peak preceding the worst drawdown. */
  peakIndex: number;
  /** Index of the trough of the worst drawdown. */
  troughIndex: number;
  /** Longest underwater stretch, in periods. */
  longestDurationPeriods: number;
  /**
   * Index at which equity first regained the pre-drawdown peak after the worst trough (WS3.3c).
   * Absent when the curve never recovered by the end of the series (still underwater).
   */
  recoveryIndex?: number;
}

/** Maximum drawdown and longest underwater duration of an equity curve. */
function maxDrawdownValue(equity: ArrayLike<number>): DrawdownResult {
  requireSeries(equity, 'maxDrawdown', 'equity');
  requireNonEmpty(equity, 'maxDrawdown', 'equity');
  let peak = equity.length > 0 ? equity[0]! : NaN;
  let peakIdx = 0;
  let worst = 0;
  let worstPeakIdx = 0;
  let worstTroughIdx = 0;

  let underwaterStart = 0;
  let longest = 0;

  for (let i = 0; i < equity.length; i++) {
    const v = equity[i]!;
    if (v >= peak) {
      peak = v;
      peakIdx = i;
      underwaterStart = i;
    } else {
      const dd = (peak - v) / peak;
      if (dd > worst) {
        worst = dd;
        worstPeakIdx = peakIdx;
        worstTroughIdx = i;
      }
      const duration = i - underwaterStart;
      if (duration > longest) longest = duration;
    }
  }

  const result: DrawdownResult = {
    maxDrawdown: worst,
    peakIndex: worstPeakIdx,
    troughIndex: worstTroughIdx,
    longestDurationPeriods: longest,
  };
  // Recovery: first point after the worst trough that regains the pre-drawdown peak value.
  if (worst > 0) {
    const peakValue = equity[worstPeakIdx]!;
    for (let j = worstTroughIdx + 1; j < equity.length; j++) {
      if (equity[j]! >= peakValue) {
        result.recoveryIndex = j;
        break;
      }
    }
  }
  return result;
}

/**
 * Maximum drawdown facade (dx §2.3): plain call → the `DrawdownResult`; `.explain()` → the
 * `Computed` envelope. `equity` is a PRICE-level series by contract, so the prices-as-returns
 * plausibility guard deliberately does not apply here.
 */
export const maxDrawdown = seriesFacade(
  'maxDrawdown',
  (equity: ArrayLike<number>): DrawdownResult => maxDrawdownValue(equity),
  (equity: ArrayLike<number>): Computed<DrawdownResult> => ({
    value: maxDrawdownValue(equity),
    assumptions: { conventionsVersion: CONVENTIONS_VERSION },
    diagnostics: { warnings: [] },
  }),
);

/**
 * Per-period drawdown series (input-aligned): the fractional decline from the running peak at each
 * index, as a non-negative number (0 at a fresh high). The series that drives an underwater chart
 * (WS3.3c); its maximum equals `maxDrawdown(equity).maxDrawdown`.
 */
export function underwater(equity: ArrayLike<number>): number[] {
  requireSeries(equity, 'underwater', 'equity');
  const out = new Array<number>(equity.length);
  let peak = equity.length > 0 ? equity[0]! : NaN;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i]!;
    if (v > peak) peak = v;
    out[i] = peak > 0 ? (peak - v) / peak : 0;
  }
  return out;
}

/**
 * Maximum drawdown of the growth-of-1 equity curve implied by a per-period **return** series
 * (WS3.3b) — the returns-input counterpart to {@link maxDrawdown}, which expects an equity curve.
 */
export function maxDrawdownFromReturns(returns: ArrayLike<number>): DrawdownResult {
  requireSeries(returns, 'maxDrawdownFromReturns');
  requireNonEmpty(returns, 'maxDrawdownFromReturns', 'returns');
  const n = returns.length;
  const equity = new Array<number>(n + 1);
  equity[0] = 1;
  for (let i = 0; i < n; i++) equity[i + 1] = equity[i]! * (1 + returns[i]!);
  return maxDrawdown(equity);
}
