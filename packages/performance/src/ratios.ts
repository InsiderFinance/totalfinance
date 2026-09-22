/**
 * `@insiderfinance/totalfinance/performance/ratios` — distribution- and trade-level performance ratios (spec §15.1).
 *
 * These read only a per-period return (or per-trade P&L) series: the Omega ratio, win rate, profit
 * factor, and expectancy. Zero-return periods are treated as neither wins nor losses. Each is a
 * facade (dx §2.3): plain call → the value; `.explain()` → the `Computed` envelope (with the
 * prices-as-returns plausibility guard riding `diagnostics.warnings`).
 */

import {
  CONVENTIONS_VERSION,
  type Computed,
  seriesFacade,
  finiteOrNull,
  ensureKnownKeys,
} from '@totalfinance/core';
import { degenerateAwareDiagnostics, requireSeries } from './sharpe.js';

/** Law 12 allowlist for omega's options — a `treshold` typo teaches, never silently ratios about 0. */
const OMEGA_KEYS = ['threshold'] as const;

function omegaValue(returns: ArrayLike<number>, options: { threshold?: number }): number {
  requireSeries(returns, 'omega');
  // Law 12: shared by the plain call AND `.explain()` — an unknown option teaches, never ignored.
  ensureKnownKeys('omega', 'options', options, OMEGA_KEYS);
  const theta = options.threshold ?? 0;
  let gain = 0;
  let loss = 0;
  for (let i = 0; i < returns.length; i++) {
    const d = returns[i]! - theta;
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return gain > 0 ? Infinity : NaN;
  return gain / loss;
}

/**
 * Omega ratio at a per-period `threshold` (default 0): Σ gains above θ ÷ Σ losses below θ.
 *
 * **`null`, never `Infinity`** (Law 7): with gains but no losses the ratio is unbounded, and with
 * neither it is undefined — both are reported as `null`, and `.explain()` carries an
 * `input.degenerate` warning naming the reason. A JSON payload can hold `null`; it cannot hold
 * `Infinity` (`JSON.stringify` silently corrupts it to `null` anyway, without the reason).
 */
export const omega = seriesFacade(
  'omega',
  (returns: ArrayLike<number>, options: { threshold?: number } = {}): number | null =>
    finiteOrNull(omegaValue(returns, options)),
  (
    returns: ArrayLike<number>,
    options: { threshold?: number } = {},
  ): Computed<number | null, { threshold: number }> => {
    const value = omegaValue(returns, options);
    return {
      value: finiteOrNull(value),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION, threshold: options.threshold ?? 0 },
      diagnostics: degenerateAwareDiagnostics(
        value,
        'omega',
        'no return deviates from the threshold (no gains and no losses to ratio) or the series is empty',
        returns,
      ),
    };
  },
);

function hitRateValue(returns: ArrayLike<number>): number {
  requireSeries(returns, 'hitRate');
  let wins = 0;
  let losses = 0;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i]!;
    if (r > 0) wins++;
    else if (r < 0) losses++;
  }
  return wins + losses > 0 ? wins / (wins + losses) : NaN;
}

/** Hit rate: fraction of non-zero periods that were positive (`wins / (wins + losses)`). */
export const hitRate = seriesFacade(
  'hitRate',
  (returns: ArrayLike<number>): number | null => finiteOrNull(hitRateValue(returns)),
  (returns: ArrayLike<number>): Computed<number | null> => {
    const value = hitRateValue(returns);
    return {
      value: finiteOrNull(value),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION },
      diagnostics: degenerateAwareDiagnostics(
        value,
        'hitRate',
        'the series has no non-zero periods (no wins or losses to count)',
        returns,
      ),
    };
  },
);

function profitFactorValue(returns: ArrayLike<number>): number {
  requireSeries(returns, 'profitFactor');
  let gains = 0;
  let losses = 0;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i]!;
    if (r > 0) gains += r;
    else if (r < 0) losses -= r;
  }
  if (losses === 0) return gains > 0 ? Infinity : NaN;
  return gains / losses;
}

/**
 * Profit factor: gross gains ÷ gross losses.
 *
 * **`null`, never `Infinity`** (Law 7): a series with gains but no losses has an unbounded profit
 * factor, and a series with neither has an undefined one — both are reported as `null`, with an
 * `input.degenerate` warning on `.explain()` naming which case it was. (The doc used to promise
 * `Infinity`; the facade has always returned `null`, and `null` is the law-conform answer — a
 * caller branching on `=== Infinity` would never have matched.)
 */
export const profitFactor = seriesFacade(
  'profitFactor',
  (returns: ArrayLike<number>): number | null => finiteOrNull(profitFactorValue(returns)),
  (returns: ArrayLike<number>): Computed<number | null> => {
    const value = profitFactorValue(returns);
    return {
      value: finiteOrNull(value),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION },
      diagnostics: degenerateAwareDiagnostics(
        value,
        'profitFactor',
        'the series has no gains and no losses (all periods are zero, or it is empty)',
        returns,
      ),
    };
  },
);

/** Win/loss decomposition of a per-period return series (see {@link winLossStatistics}). */
export interface WinLossStatistics {
  /**
   * Mean per-period return over ALL periods (zeros included). With `active` = the fraction of
   * non-zero periods, `expectancy = active · (hitRate·averageWin + (1 − hitRate)·averageLoss)`; the bare
   * `hitRate·averageWin + (1 − hitRate)·averageLoss` identity holds only when no period is exactly zero.
   */
  expectancy: number | null;
  hitRate: number | null;
  /** Average winning return; 0 when the series has no winning periods (not NaN — disclosed here). */
  averageWin: number;
  /** Average losing return (negative); 0 when the series has no losing periods. */
  averageLoss: number;
}

function winLossStatsValue(returns: ArrayLike<number>): WinLossStatistics {
  requireSeries(returns, 'winLossStatistics');
  const n = returns.length;
  let wins = 0;
  let losses = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const r = returns[i]!;
    sum += r;
    if (r > 0) {
      wins++;
      sumWin += r;
    } else if (r < 0) {
      losses++;
      sumLoss += r;
    }
  }
  return {
    expectancy: n > 0 ? sum / n : NaN,
    hitRate: wins + losses > 0 ? wins / (wins + losses) : NaN,
    averageWin: wins > 0 ? sumWin / wins : 0,
    averageLoss: losses > 0 ? sumLoss / losses : 0,
  };
}

/**
 * Expectancy: the mean per-period return — `null` when undefined (empty series), exactly as
 * `analyze().expectancy` reports it (one word, one shape). For the win/loss decomposition that explains it (hit rate, average
 * win/loss), use {@link winLossStatistics}.
 */
export const expectancy = seriesFacade(
  'expectancy',
  (returns: ArrayLike<number>): number | null =>
    finiteOrNull(winLossStatsValue(returns).expectancy as number),
  (returns: ArrayLike<number>): Computed<number | null> => {
    const value = winLossStatsValue(returns).expectancy as number;
    return {
      value: finiteOrNull(value),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION },
      diagnostics: degenerateAwareDiagnostics(
        value,
        'expectancy',
        'the return series is empty (no periods to average)',
        returns,
      ),
    };
  },
);

/**
 * Win/loss decomposition of the expectancy. `hitRate`, `averageWin`, and `averageLoss` are computed over
 * the NON-ZERO periods, while `expectancy` averages ALL periods — so with `active` the fraction of
 * non-zero periods, the exact identity is
 * `expectancy = active · (hitRate·averageWin + (1 − hitRate)·averageLoss)`. Only when the series contains
 * no zero returns (`active = 1`) does this reduce to the classic
 * `expectancy = hitRate·averageWin + (1 − hitRate)·averageLoss`.
 */

/** Law 7 (D3): degenerate stats report null, never NaN, so the record survives JSON. */
function nullSafeWinLoss(v: WinLossStatistics): WinLossStatistics {
  return {
    ...v,
    expectancy: v.expectancy === null ? null : finiteOrNull(v.expectancy),
    hitRate: v.hitRate === null ? null : finiteOrNull(v.hitRate),
  };
}

export const winLossStatistics = seriesFacade(
  'winLossStatistics',
  (returns: ArrayLike<number>): WinLossStatistics => nullSafeWinLoss(winLossStatsValue(returns)),
  (returns: ArrayLike<number>): Computed<WinLossStatistics> => {
    const value = winLossStatsValue(returns);
    // Degenerate probe: expectancy is NaN on an empty series; hitRate is NaN when no period is
    // non-zero. Either way the envelope must say so rather than ship a silent NaN field.
    const probe =
      Number.isNaN(value.expectancy as number) || Number.isNaN(value.hitRate as number) ? NaN : 0;
    return {
      value: nullSafeWinLoss(value),
      assumptions: { conventionsVersion: CONVENTIONS_VERSION },
      diagnostics: degenerateAwareDiagnostics(
        probe,
        'winLossStatistics',
        'the series is empty (expectancy) or has no non-zero periods (hitRate)',
        returns,
      ),
    };
  },
);
