/**
 * `@totalfinance/performance/activity` — portfolio-activity metrics (spec §15.1): turnover and exposure.
 *
 * Both read a time series of portfolio weight vectors — `weights[t][i]` is the weight of asset `i` at
 * rebalance `t` (negative = short, the row need not sum to 1 if the book runs net cash). These are the
 * two metrics that need position data rather than just a return/equity series.
 */

import {
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  seriesFacade,
  finiteOrNull,
} from '@totalfinance/core';
import { degenerateAwareDiagnostics } from './sharpe.js';

function requireRectangular(weights: readonly ArrayLike<number>[], functionName: string): number {
  if (!Array.isArray(weights)) {
    throw new InputError(
      `${functionName}: weights must be an array of per-period weight rows (weights[t][i]).`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName },
      },
    );
  }
  if (weights.length === 0) return 0;
  const width = weights[0]!.length;
  for (let t = 0; t < weights.length; t++) {
    if (weights[t]!.length !== width) {
      throw new InputError(
        `${functionName}: every weight row must have the same length (${width}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { row: t, expected: width, got: weights[t]!.length },
        },
      );
    }
  }
  return width;
}

/**
 * Average one-way turnover per rebalance: `mean_t( ½·Σ_i |w_{t,i} − w_{t-1,i}| )`. The leading row
 * counts as turnover from an all-cash start, so a single buy-and-hold allocation reports its entry
 * turnover once and ~0 thereafter.
 *
 * NOTE: this is a **per-rebalance weight-change ratio** (unitless, in [0, 1] one-way), distinct from
 * `BacktestResult.turnover` in `@totalfinance/backtest`, which is a **traded-notional ÷ equity** ratio
 * accumulated over the run. Different definitions and units — do not compare the two directly.
 */
function turnoverValue(weights: readonly ArrayLike<number>[]): number {
  const width = requireRectangular(weights, 'turnover');
  if (weights.length === 0) return NaN;
  let total = 0;
  for (let t = 0; t < weights.length; t++) {
    let row = 0;
    for (let i = 0; i < width; i++) {
      const prev = t === 0 ? 0 : weights[t - 1]![i]!;
      row += Math.abs(weights[t]![i]! - prev);
    }
    total += row / 2;
  }
  return total / weights.length;
}

export interface ExposureResult {
  /** Fraction of periods with any non-zero net position (`Σ_i w ≠ 0`). */
  timeInMarket: number | null;
  /** Average gross exposure `mean_t( Σ_i |w_{t,i}| )`. */
  averageGross: number | null;
  /** Average net exposure `mean_t( Σ_i w_{t,i} )`. */
  averageNet: number | null;
  /** Average long exposure `mean_t( Σ_i max(w_{t,i}, 0) )`. */
  averageLong: number | null;
  /** Average short exposure as a positive number `mean_t( Σ_i max(−w_{t,i}, 0) )`. */
  averageShort: number | null;
}

/** Exposure profile from a weight time series: time-in-market plus average gross/net/long/short. */
function exposureValue(weights: readonly ArrayLike<number>[]): ExposureResult {
  const width = requireRectangular(weights, 'exposure');
  const n = weights.length;
  if (n === 0) {
    return {
      timeInMarket: NaN,
      averageGross: NaN,
      averageNet: NaN,
      averageLong: NaN,
      averageShort: NaN,
    };
  }
  let inMarket = 0;
  let gross = 0;
  let net = 0;
  let long = 0;
  let short = 0;
  for (let t = 0; t < n; t++) {
    let rowNet = 0;
    let rowGross = 0;
    for (let i = 0; i < width; i++) {
      const w = weights[t]![i]!;
      rowNet += w;
      rowGross += Math.abs(w);
      if (w > 0) long += w;
      else if (w < 0) short -= w;
    }
    if (rowGross > 0) inMarket++;
    gross += rowGross;
    net += rowNet;
  }
  return {
    timeInMarket: inMarket / n,
    averageGross: gross / n,
    averageNet: net / n,
    averageLong: long / n,
    averageShort: short / n,
  };
}

/** Law 7 (D3): an empty weight series makes every profile field undefined — null, never NaN. */
function nullSafeExposure(v: Record<string, number | null>): ExposureResult {
  return {
    timeInMarket:
      v['timeInMarket'] === null || v['timeInMarket'] === undefined
        ? null
        : finiteOrNull(v['timeInMarket']),
    averageGross:
      v['averageGross'] === null || v['averageGross'] === undefined
        ? null
        : finiteOrNull(v['averageGross']),
    averageNet:
      v['averageNet'] === null || v['averageNet'] === undefined
        ? null
        : finiteOrNull(v['averageNet']),
    averageLong:
      v['averageLong'] === null || v['averageLong'] === undefined
        ? null
        : finiteOrNull(v['averageLong']),
    averageShort:
      v['averageShort'] === null || v['averageShort'] === undefined
        ? null
        : finiteOrNull(v['averageShort']),
  };
}

/** Turnover facade (dx §2.3): plain call → the ratio; `.explain()` → the Computed envelope. */
export const turnover = seriesFacade(
  'turnover',
  (weights: readonly ArrayLike<number>[]): number | null => finiteOrNull(turnoverValue(weights)),
  (weights: readonly ArrayLike<number>[]): Computed<number | null> => {
    const value = turnoverValue(weights);
    return {
      value: finiteOrNull(value),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION },
      // No series args: weights are not returns, so the prices-as-returns scan must not apply.
      diagnostics: degenerateAwareDiagnostics(value, 'turnover', 'the weight series is empty'),
    };
  },
);

/** Exposure facade (dx §2.3): plain call → the profile; `.explain()` → the Computed envelope. */
export const exposure = seriesFacade(
  'exposure',
  (weights: readonly ArrayLike<number>[]): ExposureResult =>
    nullSafeExposure(exposureValue(weights) as unknown as Record<string, number | null>),
  (weights: readonly ArrayLike<number>[]): Computed<ExposureResult> => {
    const value = exposureValue(weights);
    return {
      value: nullSafeExposure(value as unknown as Record<string, number | null>),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION },
      // Probe one field: every field of the profile is NaN together (empty weight series).
      diagnostics: degenerateAwareDiagnostics(
        value.timeInMarket ?? NaN,
        'exposure',
        'the weight series is empty',
      ),
    };
  },
);
