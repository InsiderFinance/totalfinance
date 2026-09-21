/**
 * Cross-sectional implied-volatility metrics (spec §10.2): IV rank and IV percentile against a
 * trailing history of ATM (or any fixed-reference) implied volatilities.
 */

import {
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  requireArgumentArray,
  facade,
  ensureKnownKeys,
  WarningCode,
} from '@totalfinance/core';
import { max as arrMax, mean as arrMean, min as arrMin } from '@totalfinance/math';

/** The conventions echoed by an empirical IV metric: the sample window and which statistic. */
type ImpliedVolatilityMetricExtra = { window: number; method: 'rank' | 'percentile' | 'stats' };

function requireHistory(history: ArrayLike<number>, functionName: string): void {
  if (history.length === 0) {
    throw new InputError(`${functionName}: history must be non-empty.`, {
      code: ErrorCode.InputOutOfRange,
      context: { length: 0 },
    });
  }
  // A single NaN/∞ in the history poisons min/max/mean and yields a silently-wrong rank — reject it.
  for (let i = 0; i < history.length; i++) {
    if (!Number.isFinite(history[i]!)) {
      throw new InputError(`${functionName}: history[${i}] must be finite, got ${history[i]}.`, {
        code: ErrorCode.InputNotFinite,
        context: { index: i, value: history[i] },
      });
    }
  }
}

/**
 * IV rank: where `current` sits in the trailing [min, max] range, as a percentage in `[0, 100]`.
 * `(current − min) / (max − min) × 100`, clamped. Returns `NaN` only when the history is flat
 * (min == max) — there is no defined rank, and we never fabricate one.
 */
/** Input for {@link impliedVolatilityRank}/{@link impliedVolatilityPercentile}/{@link impliedVolatilityStatistics}: current IV vs its history. */
export interface ImpliedVolatilityMetricInput {
  /** Current implied volatility (annualized decimal). */
  current: number;
  /** Trailing IV history (chronological or not — order-insensitive). */
  history: ArrayLike<number>;
}

function impliedVolatilityRankExplain(
  input: ImpliedVolatilityMetricInput,
): Computed<number | null, ImpliedVolatilityMetricExtra> {
  const { current, history } = input;
  ensureKnownKeys('impliedVolatilityRank', 'input', input, ['current', 'history']);
  requireArgumentArray('impliedVolatilityRank', 'history', history);
  ensureFinite(current, 'current', 'impliedVolatilityRank');
  requireHistory(history, 'impliedVolatilityRank');
  const lo = arrMin(history);
  const hi = arrMax(history);
  const warnings: QuantWarning[] = [];
  let value: number | null;
  if (hi === lo) {
    // Flat history ⇒ no defined rank ⇒ null-with-reason (Law 7: JSON-safe, never NaN).
    value = null;
    warnings.push({
      code: WarningCode.ImpliedVolatilityFlatHistory,
      message: `IV rank is undefined for a flat history (min == max == ${lo}); reported as null.`,
      severity: 'warn',
      context: { min: lo, max: hi },
    });
  } else {
    value = Math.min(100, Math.max(0, ((current - lo) / (hi - lo)) * 100));
  }
  return {
    value,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      window: history.length,
      method: 'rank',
    },
    diagnostics: { warnings },
  };
}

/**
 * IV percentile: the share of the trailing history strictly below `current`, in `[0, 100]`. Unlike
 * IV rank this is robust to outliers (it counts observations, not the range).
 */
function impliedVolatilityPercentileExplain(
  input: ImpliedVolatilityMetricInput,
): Computed<number, ImpliedVolatilityMetricExtra> {
  const { current, history } = input;
  ensureKnownKeys('impliedVolatilityPercentile', 'input', input, ['current', 'history']);
  requireArgumentArray('impliedVolatilityPercentile', 'history', history);
  ensureFinite(current, 'current', 'impliedVolatilityPercentile');
  requireHistory(history, 'impliedVolatilityPercentile');
  let below = 0;
  for (let i = 0; i < history.length; i++) if (history[i]! < current) below++;
  return {
    value: (below / history.length) * 100,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      window: history.length,
      method: 'percentile',
    },
    diagnostics: { warnings: [] },
  };
}

export interface ImpliedVolatilityStatistics {
  current: number;
  /** `null` for a flat history (rank undefined — disclosed via `implied_volatility.flat_history`). */
  rank: number | null;
  percentile: number;
  min: number;
  max: number;
  mean: number;
  observations: number;
}

/** Combined IV rank/percentile plus the trailing min/max/mean used to compute them. */
function impliedVolatilityStatsExplain(
  input: ImpliedVolatilityMetricInput,
): Computed<ImpliedVolatilityStatistics, ImpliedVolatilityMetricExtra> {
  const { current, history } = input;
  ensureKnownKeys('impliedVolatilityStatistics', 'input', input, ['current', 'history']);
  requireArgumentArray('impliedVolatilityStatistics', 'history', history);
  ensureFinite(current, 'current', 'impliedVolatilityStatistics');
  requireHistory(history, 'impliedVolatilityStatistics');
  const rank = impliedVolatilityRankExplain(input);
  const percentile = impliedVolatilityPercentileExplain(input);
  return {
    value: {
      current,
      rank: rank.value,
      percentile: percentile.value,
      min: arrMin(history),
      max: arrMax(history),
      mean: arrMean(history),
      observations: history.length,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      window: history.length,
      method: 'stats',
    },
    // propagate the flat-history caveat from the inner rank, if any.
    diagnostics: { warnings: rank.diagnostics.warnings },
  };
}

/**
 * FACADES (P3.2, one gesture): plain value from the call; the same call's `.explain()` returns the
 * envelope (window, method, and the flat-history caveat when rank is undefined). Single-object
 * input per Decision 3 — `impliedVolatilityRank({ current, history })`.
 */
export const impliedVolatilityRank = facade(
  'impliedVolatilityRank',
  (input: ImpliedVolatilityMetricInput): number | null => impliedVolatilityRankExplain(input).value,
  impliedVolatilityRankExplain,
);
export const impliedVolatilityPercentile = facade(
  'impliedVolatilityPercentile',
  (input: ImpliedVolatilityMetricInput): number => impliedVolatilityPercentileExplain(input).value,
  impliedVolatilityPercentileExplain,
);
export const impliedVolatilityStatistics = facade(
  'impliedVolatilityStatistics',
  (input: ImpliedVolatilityMetricInput): ImpliedVolatilityStatistics =>
    impliedVolatilityStatsExplain(input).value,
  impliedVolatilityStatsExplain,
);
