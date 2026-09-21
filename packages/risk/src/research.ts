import {
  ensureBooleanWhenPresent,
  ensureEnumWhenPresent,
  ensureFiniteWhenPresent,
} from './options-internal.js';
/**
 * Research hygiene (spec §15.5) — the statistics that keep a backtest honest.
 *
 * Selecting the best of many strategy configurations inflates the in-sample Sharpe; reusing data
 * across train/test boundaries leaks the future into the past. This module provides the standard
 * defences:
 *
 *   • **Probabilistic / deflated Sharpe** (Bailey & López de Prado) — the probability that the true
 *     Sharpe exceeds a benchmark, adjusted for sample length, skew/kurtosis, and the number of trials.
 *   • **Multiple-testing correction** — Bonferroni, Šidák, Holm (FWER) and Benjamini–Hochberg (FDR).
 *   • **Walk-forward** and **purged & embargoed K-fold** splitters for leakage-free evaluation.
 *   • **Parameter-sweep diagnostics**, **train/test leakage** checks, and a **survivorship-bias** flag.
 *
 * Depends only on `@totalfinance/core` and `@totalfinance/math`.
 */

import {
  CONVENTIONS_VERSION,
  type Computed,
  ErrorCode,
  InputError,
  type QuantWarning,
  ensureFinite,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  seriesFacade,
  WarningCode,
  warning,
} from '@totalfinance/core';
import {
  kurtosis as mathKurtosis,
  mean,
  normalCdf,
  normalInverseCdf,
  skewness,
  standardDeviation,
} from '@totalfinance/math';

/** Euler–Mascheroni constant, used in the expected-maximum-Sharpe formula. */
const EULER_MASCHERONI = 0.5772156649015329;

// ───────────────────────── Sharpe inference ─────────────────────────

/** Sample statistics of a return series needed for Sharpe inference. All in per-observation units. */
export interface SharpeStatistics {
  /**
   * Per-observation Sharpe ratio `mean(excess)/std` (NOT annualized). `null` (C hygiene) when the
   * returns have zero variance: there is no dispersion to scale by, and the report says so.
   */
  sharpe: number | null;
  /** Number of observations. */
  observations: number;
  /** Skewness `γ₃` of the returns. */
  skewness: number;
  /** Non-excess kurtosis `γ₄` of the returns (3 for a normal distribution). */
  kurtosis: number;
}

/** {@link sharpeStatistics}'s report: the stats plus the applied conventions (Law 2 report grammar). */
export interface SharpeStatisticsReport extends SharpeStatistics {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** The documented `sharpeStatistics` option keys. */
const SHARPE_STATS_OPTIONS_KEYS = ['riskFreeRate'] as const;

/**
 * Sample Sharpe statistics of a return series: the per-observation (non-annualized) Sharpe plus the
 * skewness and (non-excess) kurtosis that the probabilistic-Sharpe adjustment needs.
 */
export function sharpeStatistics(
  returns: ArrayLike<number>,
  options: { riskFreeRate?: number } = {},
): SharpeStatisticsReport {
  const functionName = 'sharpeStatistics';
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  requireArgumentObject(functionName, 'options', options);
  // Law 12: a misspelled knob (`riskfreeRate` running at the 0 default) must throw, never no-op.
  ensureKnownKeys(functionName, 'options', options, SHARPE_STATS_OPTIONS_KEYS);
  requireArgumentArray('sharpeStatistics', 'returns', returns);
  const n = returns.length;
  if (n < 3) {
    throw new InputError(`${functionName}: need ≥ 3 returns, got ${n}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { observations: n },
    });
  }
  ensureFiniteWhenPresent(options.riskFreeRate, 'riskFreeRate', 'sharpeStatistics');
  const rf = options.riskFreeRate ?? 0;
  ensureFinite(rf, 'riskFreeRate', functionName);
  const excess: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    ensureFinite(returns[i]!, `returns[${i}]`, functionName);
    excess[i] = returns[i]! - rf;
  }
  const sd = standardDeviation(returns);
  const degenerate = !(sd > 0);
  return {
    sharpe: degenerate ? null : mean(excess) / sd,
    observations: n,
    skewness: skewness(returns),
    kurtosis: mathKurtosis(returns, { excess: false }),
    // The applied risk-free default and units (dx §2.4): per-observation, never annualized here.
    ...researchReport(
      { riskFreeRate: rf, units: 'per-observation', observations: n },
      degenerate
        ? [
            warning(
              WarningCode.RiskSharpeUndefined,
              `${functionName}: returns have zero variance (standard deviation ${sd}); the Sharpe ratio is undefined and reported as null.`,
              'warn',
              { standardDeviation: sd, observations: n },
            ),
          ]
        : [],
    ),
  };
}

/** The PSR number itself — shared by the public envelope and the deflation/protocol callers. */
/**
 * The PSR kernel; `null` when the statistics carry no Sharpe (a zero-variance series): the
 * probability of an undefined ratio beating a benchmark is not a number (C hygiene).
 */
function psrKernel(
  stats: SharpeStatistics,
  benchmarkSharpe: number,
  functionName: string,
): number | null {
  requireArgumentObject(functionName, 'stats', stats);
  const { sharpe: sr, observations: n, skewness: g3, kurtosis: g4 } = stats;
  if (sr === null) return null;
  ensureFinite(sr, 'sharpe', functionName);
  ensureFinite(benchmarkSharpe, 'benchmarkSharpe', functionName);
  if (n < 2) {
    throw new InputError(`${functionName}: need ≥ 2 observations, got ${n}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { observations: n },
    });
  }
  // standard error of the Sharpe estimator under non-normality
  const denom = 1 - g3 * sr + ((g4 - 1) / 4) * sr * sr;
  if (!(denom > 0)) {
    throw new InputError(
      `${functionName}: the Sharpe estimator variance is non-positive (1 − γ₃·SR + (γ₄−1)/4·SR² = ${denom.toFixed(4)}); the moment estimates are inconsistent.`,
      { code: ErrorCode.InputOutOfRange, context: { denom } },
    );
  }
  return normalCdf(((sr - benchmarkSharpe) * Math.sqrt(n - 1)) / Math.sqrt(denom));
}

/** {@link probabilisticSharpeRatio}'s envelope: the probability plus the applied benchmark. */
export type ProbabilisticSharpeResult = Computed<
  number | null,
  { benchmarkSharpe: number; observations: number }
>;

function undefinedSharpeWarning(functionName: string): QuantWarning {
  return warning(
    WarningCode.RiskSharpeUndefined,
    `${functionName}: the statistics carry no Sharpe ratio (a zero-variance series); the result is null.`,
    'warn',
  );
}

/**
 * Probabilistic Sharpe Ratio (Bailey & López de Prado 2012): the probability that the true Sharpe
 * exceeds `benchmarkSharpe`, given the observed Sharpe, sample length, and return non-normality.
 * `benchmarkSharpe` is in the same per-observation units as `statistics.sharpe` (default 0). Returns the
 * standard `Computed` envelope (`value` = the probability); the applied `benchmarkSharpe: 0`
 * default is echoed in `assumptions` (dx §2.4, never silently applied).
 */
function probabilisticSharpeRatioResult(
  statistics: SharpeStatistics,
  benchmarkSharpe = 0,
): ProbabilisticSharpeResult {
  const value = psrKernel(statistics, benchmarkSharpe, 'probabilisticSharpeRatio');
  return {
    value,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      benchmarkSharpe,
      observations: statistics.observations,
    },
    diagnostics: {
      warnings: value === null ? [undefinedSharpeWarning('probabilisticSharpeRatio')] : [],
    },
  };
}

/** Plain probability; use `.explain()` for the benchmark and observation count. */
export const probabilisticSharpeRatio = seriesFacade(
  'probabilisticSharpeRatio',
  (stats: SharpeStatistics, benchmarkSharpe = 0): number | null =>
    probabilisticSharpeRatioResult(stats, benchmarkSharpe).value,
  probabilisticSharpeRatioResult,
);

/** The two documented shapes of `deflatedSharpeRatio`'s `trials` union, guarded per branch. */
const TRIAL_SHARPES_KEYS = ['trialSharpes'] as const;
const TRIAL_COUNT_KEYS = ['trialCount', 'varianceSharpe'] as const;

/** Law 2 report grammar (D5): every research answer carries its conventions and a warnings channel. */
function researchReport(assumptions: Record<string, unknown>, warnings: QuantWarning[] = []) {
  return {
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, ...assumptions },
    diagnostics: { warnings },
  };
}

export interface DeflatedSharpeResult {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
  /** Probability the true Sharpe beats the multiple-testing-adjusted benchmark `SR₀`. */
  /** `null` when the statistics carry no Sharpe (a zero-variance series). */
  deflatedSharpe: number | null;
  /** The un-deflated PSR (benchmark 0), for comparison. */
  probabilisticSharpe: number | null;
  /** Expected maximum Sharpe across `trialCount` under the null — the deflation benchmark `SR₀`. */
  expectedMaxSharpe: number;
  trialCount: number;
}

/**
 * Deflated Sharpe Ratio (Bailey & López de Prado 2014): the PSR evaluated against the *expected
 * maximum* Sharpe that `N` independent trials would produce by chance, so selecting the best of a
 * parameter sweep is penalised. Pass the trial Sharpes (variance computed for you) or `trialCount` plus
 * their variance directly.
 */
export function deflatedSharpeRatio(
  statistics: SharpeStatistics,
  trials: { trialSharpes: ArrayLike<number> } | { trialCount: number; varianceSharpe: number },
): DeflatedSharpeResult {
  requireArgumentObject('deflatedSharpeRatio', 'trials', trials);
  requireArgumentObject('deflatedSharpeRatio', 'statistics', statistics);
  // The trials union is discriminated by `trialSharpes`; guard against the resolved branch so a
  // stray `trialCount` beside `trialSharpes` (which would be silently ignored) throws too.
  ensureKnownKeys(
    'deflatedSharpeRatio',
    'trials',
    trials,
    'trialSharpes' in trials ? TRIAL_SHARPES_KEYS : TRIAL_COUNT_KEYS,
  );
  const functionName = 'deflatedSharpeRatio';
  let trialCount: number;
  let varSharpe: number;
  if ('trialSharpes' in trials) {
    if (trials.trialSharpes === null || typeof trials.trialSharpes?.length !== 'number') {
      throw new InputError(
        `deflatedSharpeRatio: trials.trialSharpes must be an array of Sharpe ratios. Received ${trials.trialSharpes === null ? 'null' : typeof trials.trialSharpes}.`,
        { code: ErrorCode.InputWrongType, context: { field: 'trials.trialSharpes' } },
      );
    }
    const m = trials.trialSharpes.length;
    if (m < 2) {
      throw new InputError(
        `${functionName}: need ≥ 2 trial Sharpes to estimate their variance, got ${m}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { trials: m },
        },
      );
    }
    trialCount = m;
    varSharpe = variance(trials.trialSharpes);
  } else {
    trialCount = trials.trialCount;
    varSharpe = trials.varianceSharpe;
    // Safe integer (2026-08-23 review, P0): trialCount only feeds the closed-form Gumbel
    // approximation (no loop, no allocation), but above 2^53 the count itself is no longer exact —
    // an inexact "how many trials did you run" is a corrupted input, not a big one.
    if (!Number.isSafeInteger(trialCount) || trialCount < 2) {
      throw new InputError(
        `${functionName}: trialCount must be an integer ≥ 2, got ${trialCount}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { trialCount },
        },
      );
    }
    ensureFinite(varSharpe, 'varianceSharpe', functionName);
    // A variance can't be negative; reject it rather than silently clamping to 0 (which would make
    // the deflated Sharpe collapse to the un-deflated PSR and quietly defeat the diagnostic).
    if (varSharpe < 0) {
      throw new InputError(`${functionName}: varianceSharpe must be ≥ 0, got ${varSharpe}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { varianceSharpe: varSharpe },
      });
    }
  }

  // Expected maximum of N i.i.d. Gaussians (Gumbel approximation), scaled by the trial-Sharpe stddev:
  //   SR₀ = √V · [ (1−γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e)) ]
  const sd = Math.sqrt(varSharpe);
  const sr0 =
    sd *
    ((1 - EULER_MASCHERONI) * normalInverseCdf(1 - 1 / trialCount) +
      EULER_MASCHERONI * normalInverseCdf(1 - 1 / (trialCount * Math.E)));

  return {
    deflatedSharpe: psrKernel(statistics, sr0, functionName),
    probabilisticSharpe: psrKernel(statistics, 0, functionName),
    expectedMaxSharpe: sr0,
    trialCount,
    // Which branch of the `trials` union was resolved, and against what sample sizes (dx §2.4):
    // a serialized result says whether the trial-Sharpe variance was estimated or supplied.
    ...researchReport(
      {
        trialsFrom: 'trialSharpes' in trials ? 'trialSharpes' : 'trialCount+varianceSharpe',
        trialCount,
        varianceSharpe: varSharpe,
        observations: statistics.observations,
      },
      statistics.sharpe === null ? [undefinedSharpeWarning(functionName)] : [],
    ),
  };
}

/** Sample variance helper (n−1) used for trial-Sharpe dispersion. */
function variance(xs: ArrayLike<number>): number {
  const n = xs.length;
  const mu = mean(xs);
  let acc = 0;
  for (let i = 0; i < n; i++) acc += (xs[i]! - mu) ** 2;
  return acc / (n - 1);
}

// ───────────────────────── multiple-testing correction ─────────────────────────

export type MultipleTestMethod = 'bonferroni' | 'sidak' | 'holm' | 'benjaminiHochberg';

const MULTIPLE_TEST_METHODS: readonly MultipleTestMethod[] = [
  'bonferroni',
  'sidak',
  'holm',
  'benjaminiHochberg',
];
const MULTIPLE_TEST_OPTIONS_KEYS = ['method', 'alpha'] as const;

export interface MultipleTestResult {
  method: MultipleTestMethod;
  alpha: number;
  /** Adjusted p-values aligned with the input order. */
  adjusted: number[];
  /** Whether each hypothesis is rejected at `alpha` (`adjusted ≤ alpha`). */
  rejected: boolean[];
}

export interface MultipleTestOptions {
  /** Correction method (default `'holm'`). */
  method?: MultipleTestMethod;
  /** Significance level (default 0.05). */
  alpha?: number;
}

/**
 * Adjust a set of p-values for multiple testing. Bonferroni/Šidák/Holm control the family-wise error
 * rate; Benjamini–Hochberg controls the false-discovery rate. Returns adjusted p-values (input order)
 * and the rejection decisions at `alpha`.
 */
export function adjustPValues(
  pValues: ArrayLike<number>,
  options: MultipleTestOptions = {},
): MultipleTestResult {
  requireArgumentArray('adjustPValues', 'pValues', pValues);
  const functionName = 'adjustPValues';
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, MULTIPLE_TEST_OPTIONS_KEYS);
  const m = pValues.length;
  if (m === 0) {
    throw new InputError(`${functionName}: p-values must be non-empty.`, {
      code: ErrorCode.InputOutOfRange,
      context: { count: 0 },
    });
  }
  const p = new Array<number>(m);
  for (let i = 0; i < m; i++) {
    const v = pValues[i]!;
    if (!(v >= 0 && v <= 1)) {
      throw new InputError(`${functionName}: p-value[${i}] must be in [0, 1], got ${v}.`, {
        code: ErrorCode.InputOutOfRange,
        context: { index: i, value: v },
      });
    }
    p[i] = v;
  }
  ensureEnumWhenPresent(options.method, 'adjustPValues', 'method', [
    'bonferroni',
    'sidak',
    'holm',
    'benjaminiHochberg',
  ]);
  ensureFiniteWhenPresent(options.alpha, 'alpha', functionName);
  const method = options.method ?? 'holm';
  if (!MULTIPLE_TEST_METHODS.includes(method)) {
    throw new InputError(
      `${functionName}: method must be one of ${MULTIPLE_TEST_METHODS.join(', ')}; got "${method}".`,
      { code: ErrorCode.InputInvalidEnum, context: { method } },
    );
  }
  const alpha = options.alpha ?? 0.05;
  if (!(alpha > 0 && alpha < 1)) {
    throw new InputError(`${functionName}: alpha must be in (0, 1), got ${alpha}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { alpha },
    });
  }
  const adjusted = new Array<number>(m);

  if (method === 'bonferroni') {
    for (let i = 0; i < m; i++) adjusted[i] = Math.min(1, p[i]! * m);
  } else if (method === 'sidak') {
    for (let i = 0; i < m; i++) adjusted[i] = 1 - (1 - p[i]!) ** m;
  } else {
    // Holm (step-down) and Benjamini–Hochberg (step-up) both work on the sorted p-values.
    const order = Array.from({ length: m }, (_, i) => i).sort((a, b) => p[a]! - p[b]!);
    const sorted = order.map((i) => p[i]!);
    const adjSorted = new Array<number>(m);
    if (method === 'holm') {
      let running = 0;
      for (let k = 0; k < m; k++) {
        running = Math.max(running, Math.min(1, (m - k) * sorted[k]!));
        adjSorted[k] = running;
      }
    } else {
      // benjaminiHochberg
      let running = 1;
      for (let k = m - 1; k >= 0; k--) {
        running = Math.min(running, Math.min(1, (m / (k + 1)) * sorted[k]!));
        adjSorted[k] = running;
      }
    }
    for (let k = 0; k < m; k++) adjusted[order[k]!] = adjSorted[k]!;
  }

  return { method, alpha, adjusted, rejected: adjusted.map((a) => a <= alpha) };
}

// ───────────────────────── cross-validation splitters ─────────────────────────

/** A train/test split as sorted index arrays into a length-`n` sample. */
export interface Split {
  train: number[];
  test: number[];
}

/**
 * Hard cap on the TOTAL index entries a splitter may materialize (2026-08-23 review, P0). The
 * splitters take `observationCount` as a NUMBER, not data, so a call like
 * `purgedKFold(1e12, { folds: 1e6 })` was an absurd allocation the old integer checks happily
 * accepted (`Number.isInteger(1e12)` is `true`). Every emitted index is one array slot (~8 bytes)
 * and one loop iteration (a few ns), so 5·10^7 entries is ~400 MB at the very worst and well under
 * a second to generate — already past any realistic design (50 folds over a decade of minute bars
 * ≈ 5·10^7). Beyond it the caller is asking for an allocation, not a split plan.
 */
const MAX_SPLIT_INDEX_ENTRIES = 50_000_000;

export interface WalkForwardOptions {
  /** Training window length (in observations). */
  trainSize: number;
  /** Test window length. */
  testSize: number;
  /** Step between successive folds (default `testSize`). */
  step?: number;
  /** `rolling` (sliding train window) or `anchored` (train always starts at 0). Default `rolling`. */
  mode?: 'rolling' | 'anchored';
}

/** The documented {@link WalkForwardOptions} keys. */
const WALK_FORWARD_OPTIONS_KEYS = ['trainSize', 'testSize', 'step', 'mode'] as const;

/** Generate walk-forward (rolling or anchored) train/test splits over `n` ordered observations. */
export function walkForwardSplits(observationCount: number, options: WalkForwardOptions): Split[] {
  ensureFinite(observationCount, 'observationCount', 'walkForwardSplits');
  requireArgumentObject('walkForwardSplits', 'options', options);
  ensureKnownKeys('walkForwardSplits', 'options', options, WALK_FORWARD_OPTIONS_KEYS);
  const functionName = 'walkForwardSplits';
  requirePositiveInt(observationCount, 'observationCount', functionName);
  const { trainSize, testSize } = options;
  requirePositiveInt(trainSize, 'trainSize', functionName);
  requirePositiveInt(testSize, 'testSize', functionName);
  ensureFiniteWhenPresent(options.step, 'step', 'walkForwardSplits');
  const step = options.step ?? testSize;
  requirePositiveInt(step, 'step', functionName);
  ensureEnumWhenPresent(options.mode, 'walkForwardSplits', 'mode', ['rolling', 'anchored']);
  const mode = options.mode ?? 'rolling';
  if (mode !== 'rolling' && mode !== 'anchored') {
    // Reject an unknown mode rather than silently behaving as rolling.
    throw new InputError(`${functionName}: mode must be 'rolling' or 'anchored', got "${mode}".`, {
      code: ErrorCode.InputInvalidEnum,
      context: { mode },
    });
  }

  // Bound the PRODUCT before the loop (2026-08-23 review, P0): observationCount, trainSize,
  // testSize, and step are each safe positive integers by now, but the WORK is their combination —
  // `walkForwardSplits(1e12, { trainSize: 1, testSize: 2, step: 1 })` would materialize ~3·10^12
  // index entries. Count the splits and the entries they emit arithmetically (exact closed forms,
  // no loop) and refuse an absurd total with the bound and its price.
  const splitCount =
    trainSize + testSize > observationCount
      ? 0
      : Math.floor((observationCount - trainSize - testSize) / step) + 1;
  const totalIndexEntries =
    mode === 'anchored'
      ? // k-th anchored split trains on [0, trainSize + k·step): Σ = c·(train+test) + step·c(c−1)/2.
        splitCount * (trainSize + testSize) + (step * splitCount * (splitCount - 1)) / 2
      : splitCount * (trainSize + testSize);
  if (totalIndexEntries > MAX_SPLIT_INDEX_ENTRIES) {
    throw new InputError(
      `${functionName}: this request would materialize ${totalIndexEntries.toLocaleString('en-US')} split index entries (${splitCount.toLocaleString('en-US')} ${mode} splits over ${observationCount.toLocaleString('en-US')} observations), above the ${MAX_SPLIT_INDEX_ENTRIES.toLocaleString('en-US')} cap — each entry is an array slot and a loop iteration, so the cap keeps the largest request under a second and a few hundred MB. Use a larger step, smaller windows, or fewer observations.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          observationCount,
          trainSize,
          testSize,
          step,
          mode,
          splitCount,
          totalIndexEntries,
          max: MAX_SPLIT_INDEX_ENTRIES,
        },
      },
    );
  }

  const splits: Split[] = [];
  for (let trainEnd = trainSize; trainEnd + testSize <= observationCount; trainEnd += step) {
    const trainStart = mode === 'anchored' ? 0 : trainEnd - trainSize;
    splits.push({
      train: range(trainStart, trainEnd),
      test: range(trainEnd, trainEnd + testSize),
    });
  }
  return splits;
}

export interface PurgedKFoldOptions {
  /** Number of folds (≥ 2). */
  folds: number;
  /** Fraction of `n` to embargo after each test fold (default 0). */
  embargo?: number;
  /** Observations to purge on each side of a test fold (label-overlap buffer; default 0). */
  purgeGap?: number;
}

/** The documented {@link PurgedKFoldOptions} keys. */
const PURGED_K_FOLD_OPTIONS_KEYS = ['folds', 'embargo', 'purgeGap'] as const;

/**
 * Purged & embargoed K-fold cross-validation (López de Prado, *Advances in Financial ML* ch. 7).
 * Each fold's test set is a contiguous block; training drops any observation within `purgeGap` of the
 * test block (label-overlap purge) and within the trailing `embargo·n` window after it.
 *
 * Throws a typed `input.out_of_range` naming the largest viable `purgeGap` when the requested purge
 * (with the embargo) would leave a fold with an empty training set — an unusable split is an error,
 * not an empty array to be discovered downstream.
 */
export function purgedKFold(observationCount: number, options: PurgedKFoldOptions): Split[] {
  ensureFinite(observationCount, 'observationCount', 'purgedKFold');
  requireArgumentObject('purgedKFold', 'options', options);
  ensureKnownKeys('purgedKFold', 'options', options, PURGED_K_FOLD_OPTIONS_KEYS);
  const functionName = 'purgedKFold';
  requirePositiveInt(observationCount, 'observationCount', functionName);
  const { folds } = options;
  // Safe integer (2026-08-23 review, P0); the ≤ observationCount bound below keeps folds
  // data-scaled, and the PRODUCT check after it bounds the actual work.
  if (!Number.isSafeInteger(folds) || folds < 2 || folds > observationCount) {
    throw new InputError(
      `${functionName}: folds must be an integer in [2, observationCount=${observationCount}], got ${folds}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { folds, observationCount },
      },
    );
  }
  // Bound the PRODUCT (2026-08-23 review, P0): the generator visits every observation once PER
  // FOLD (folds × observationCount iterations) and materializes nearly that many train indices, so
  // two individually-plausible counts can multiply into an absurd allocation —
  // `purgedKFold(10_000_000, { folds: 5_000 })` is 5·10^10 entries. See MAX_SPLIT_INDEX_ENTRIES
  // for the cap's price.
  if (folds * observationCount > MAX_SPLIT_INDEX_ENTRIES) {
    throw new InputError(
      `${functionName}: folds × observationCount = ${(folds * observationCount).toLocaleString('en-US')} exceeds the ${MAX_SPLIT_INDEX_ENTRIES.toLocaleString('en-US')} cap on materialized split index entries — every fold's training array revisits (almost) the whole sample, so the work and memory scale with the product, and the cap keeps the largest request under a second and a few hundred MB. Use fewer folds or fewer observations.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { folds, observationCount, max: MAX_SPLIT_INDEX_ENTRIES },
      },
    );
  }
  ensureFiniteWhenPresent(options.embargo, 'embargo', 'purgedKFold');
  const embargo = options.embargo ?? 0;
  if (!(embargo >= 0 && embargo < 1)) {
    throw new InputError(`${functionName}: embargo must be in [0, 1), got ${embargo}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { embargo },
    });
  }
  ensureFiniteWhenPresent(options.purgeGap, 'purgeGap', 'purgedKFold');
  const purgeGap = options.purgeGap ?? 0;
  // Safe integer (2026-08-23 review, P0); the maxViablePurgeGap check below additionally bounds it
  // by the sample, so it can never widen any loop.
  if (!Number.isSafeInteger(purgeGap) || purgeGap < 0) {
    throw new InputError(
      `${functionName}: purgeGap must be a non-negative integer, got ${purgeGap}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { purgeGap },
      },
    );
  }
  const embargoSize = Math.floor(embargo * observationCount);
  const foldSize = Math.floor(observationCount / folds);

  // A purge window wide enough to swallow a fold's whole complement leaves that fold with an EMPTY
  // training set — and an empty train set is not a cross-validation split, it is a silently
  // unusable one (every downstream fit sees zero rows and either throws far from here or "learns"
  // nothing). Compute the largest purgeGap that still leaves at least one training observation in
  // every fold, and teach it.
  const maxViablePurgeGap = (): number => {
    let bound = Infinity;
    for (let k = 0; k < folds; k++) {
      const testStart = k * foldSize;
      const testEnd = k === folds - 1 ? observationCount : testStart + foldSize;
      // Left side survives while `purgeGap ≤ testStart − 1`; the right side additionally has to
      // clear the embargo, which no purgeGap can shrink.
      const left = testStart - 1;
      const right =
        embargoSize <= observationCount - 1 - testEnd ? observationCount - 1 - testEnd : -1;
      bound = Math.min(bound, Math.max(left, right));
    }
    return bound;
  };
  const maxGap = maxViablePurgeGap();
  if (purgeGap > maxGap) {
    throw new InputError(
      maxGap < 0
        ? `${functionName}: embargo=${embargo} already purges every training observation of at least one fold (embargoSize=${embargoSize} over ${observationCount} observations in ${folds} folds) — no purgeGap can produce a usable split. Lower the embargo or the fold count.`
        : `${functionName}: purgeGap=${purgeGap} leaves at least one fold with an EMPTY training set (fold span ${foldSize} of ${observationCount} observations, embargoSize=${embargoSize}). The largest viable purgeGap for folds=${folds}, embargo=${embargo} is ${maxGap}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          purgeGap,
          maxViablePurgeGap: maxGap,
          folds,
          foldSize,
          embargoSize,
          observationCount,
        },
      },
    );
  }

  const splits: Split[] = [];
  for (let k = 0; k < folds; k++) {
    const testStart = k * foldSize;
    const testEnd = k === folds - 1 ? observationCount : testStart + foldSize; // last fold absorbs the remainder
    const test = range(testStart, testEnd);
    const purgeLo = testStart - purgeGap;
    const purgeHi = testEnd + purgeGap;
    const embargoHi = testEnd + embargoSize;
    const train: number[] = [];
    for (let i = 0; i < observationCount; i++) {
      if (i >= testStart && i < testEnd) continue; // the test block itself
      if (i >= purgeLo && i < purgeHi) continue; // purge around the boundaries
      if (i >= testEnd && i < embargoHi) continue; // embargo after the test block
      train.push(i);
    }
    splits.push({ train, test });
  }
  return splits;
}

// ───────────────────────── parameter-sweep diagnostics ─────────────────────────

export interface ParameterSweepResult {
  trialCount: number;
  bestSharpe: number;
  meanSharpe: number;
  varianceSharpe: number;
  /** Expected maximum Sharpe under the null (the deflation benchmark `SR₀`). */
  expectedMaxSharpe: number;
  /** Deflated Sharpe of the selected (best) configuration. */
  /** `null` when the selected statistics carry no Sharpe (a zero-variance series). */
  deflatedSharpe: number | null;
  /** Un-deflated PSR of the selected configuration; `null` with `deflatedSharpe`. */
  probabilisticSharpe: number | null;
}

/**
 * Summarize a parameter sweep: given the per-trial Sharpes and the sample statistics of the *selected*
 * (best) configuration's return series, report the dispersion of the trials and the deflated Sharpe —
 * the honest probability the winner is real rather than the luckiest of many.
 */
export function parameterSweepDiagnostics(
  trialSharpes: ArrayLike<number>,
  selected: SharpeStatistics,
): ParameterSweepResult {
  requireArgumentArray('parameterSweepDiagnostics', 'trialSharpes', trialSharpes);
  requireArgumentObject('parameterSweepDiagnostics', 'selected', selected);
  const functionName = 'parameterSweepDiagnostics';
  const m = trialSharpes.length;
  if (m < 2) {
    throw new InputError(`${functionName}: need ≥ 2 trial Sharpes, got ${m}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { trials: m },
    });
  }
  let best = -Infinity;
  for (let i = 0; i < m; i++) {
    ensureFinite(trialSharpes[i]!, `trialSharpes[${i}]`, functionName);
    if (trialSharpes[i]! > best) best = trialSharpes[i]!;
  }
  const dsr = deflatedSharpeRatio(selected, { trialSharpes });
  return {
    trialCount: m,
    bestSharpe: best,
    meanSharpe: mean(trialSharpes),
    varianceSharpe: variance(trialSharpes),
    expectedMaxSharpe: dsr.expectedMaxSharpe,
    deflatedSharpe: dsr.deflatedSharpe,
    probabilisticSharpe: dsr.probabilisticSharpe,
  };
}

// ───────────────────────── leakage & survivorship diagnostics ─────────────────────────

/** One leaking split found by {@link checkLeakage}. */
export interface LeakageIssue {
  /** Index of the leaking split. */
  split: number;
  /** How many indices appear in both train and test. */
  overlapCount: number;
  /** Up to 10 of the overlapping indices, as a sample. */
  sample: number[];
}

/** {@link checkLeakage}'s report: the leak findings plus the Law 2 report grammar. */
export interface LeakageReport {
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** The leakage warnings themselves (one `research.train_test_leakage` per leaking split). */
  diagnostics: { warnings: QuantWarning[] };
  /** `true` when no split leaks. */
  clean: boolean;
  /** Per-split leak details, aligned with `diagnostics.warnings`. */
  leaks: LeakageIssue[];
}

/**
 * Flag any split whose train and test index sets overlap (look-ahead leakage). The findings are
 * `research.train_test_leakage` warnings on `diagnostics.warnings` (one per leaking split), with the
 * structured per-split detail mirrored on `leaks` and a `clean` verdict.
 */
export function checkLeakage(splits: Split[]): LeakageReport {
  requireArgumentArray('checkLeakage', 'splits', splits);
  if (splits.length > 0) {
    const first = splits[0] as { train?: unknown; test?: unknown } | null;
    if (
      first === null ||
      typeof first !== 'object' ||
      !Array.isArray(first.train) ||
      !Array.isArray(first.test)
    ) {
      throw new InputError(
        'checkLeakage: each split is { train: number[], test: number[] } (see walkForwardSplits/purgedKFold).',
        { code: ErrorCode.InputWrongType, context: {} },
      );
    }
  }
  const warnings: QuantWarning[] = [];
  const leaks: LeakageIssue[] = [];
  splits.forEach((s, i) => {
    const testSet = new Set(s.test);
    const overlap = s.train.filter((x) => testSet.has(x));
    if (overlap.length > 0) {
      const issue: LeakageIssue = {
        split: i,
        overlapCount: overlap.length,
        sample: overlap.slice(0, 10),
      };
      leaks.push(issue);
      warnings.push({
        code: WarningCode.ResearchTrainTestLeakage,
        message: `Split ${i}: ${overlap.length} index(es) appear in both train and test — look-ahead leakage.`,
        severity: 'error',
        context: { ...issue },
      });
    }
  });
  return {
    clean: leaks.length === 0,
    leaks,
    ...researchReport({ splits: splits.length }, warnings),
  };
}

export interface SurvivorshipContext {
  /** Whether delisted / inactive instruments are included in the backtest universe. */
  includesDelisted?: boolean;
  /** Whether the universe is point-in-time (members as they were on each date). */
  pointInTimeUniverse?: boolean;
}

/**
 * Return a survivorship-bias warning when the backtest universe excludes delisted names or is not
 * point-in-time — both bias results upward — or `null` when neither concern applies.
 */
export function survivorshipWarning(context: SurvivorshipContext): QuantWarning | null {
  requireArgumentObject('survivorshipWarning', 'context', context);
  // Law 12 + boolean ladders: `{ includesDelisted: 'no' }` is truthy, so it silently REMOVED the
  // survivorship warning the flag exists to raise.
  ensureKnownKeys('survivorshipWarning', 'context', context, [
    'includesDelisted',
    'pointInTimeUniverse',
    'universeSource',
  ]);
  ensureBooleanWhenPresent(context.includesDelisted, 'survivorshipWarning', 'includesDelisted');
  ensureBooleanWhenPresent(
    context.pointInTimeUniverse,
    'survivorshipWarning',
    'pointInTimeUniverse',
  );
  const issues: string[] = [];
  if (context.includesDelisted === false) issues.push('excludes delisted/inactive instruments');
  if (context.pointInTimeUniverse === false) issues.push('uses a non-point-in-time universe');
  if (issues.length === 0) return null;
  return {
    code: WarningCode.ResearchSurvivorshipBias,
    message: `Backtest universe ${issues.join(' and ')}; results are likely survivorship-biased (upward).`,
    severity: 'warn',
    context: { ...context },
  };
}

// ───────────────────────── PBO (combinatorially-symmetric cross-validation) ─────────────────────────

/** Options for {@link probabilityOfBacktestOverfitting}. */
export interface BacktestOverfittingProbabilityOptions {
  /**
   * Number of disjoint contiguous row-blocks `S` (even, `4 ≤ S ≤ 16`). Default `16` (Bailey & López de
   * Prado). The `C(S, S/2)` train/test splits grow fast in `S`; the observation count is trimmed to a
   * multiple of `S` (the oldest rows dropped).
   */
  splits?: number;
}

/** The result of a CSCV probability-of-backtest-overfitting analysis. */
export interface BacktestOverfittingProbabilityResult {
  /**
   * Probability of backtest overfitting: the fraction of the `C(S, S/2)` symmetric train/test splits on
   * which the in-sample-best configuration ranks **below the out-of-sample median** (logit `λ < 0`). Near
   * `0.5` for noise (selection is worthless out of sample), near `0` for a genuinely persistent edge.
   */
  backtestOverfittingProbability: number;
  /** Number of symmetric train/test splits evaluated: `C(S, S/2)`. */
  combinations: number;
  /** Blocks `S` actually used. */
  splits: number;
  /** Observations (rows) used after trimming to a multiple of `S`. */
  observations: number;
  /** Number of strategy configurations (columns) `N`. */
  trials: number;
  /** Median logit `λ = ln(r̄/(1−r̄))` across the splits (`r̄` = OOS relative rank of the IS-best); `< 0` ⇒ overfit-leaning. */
  medianLogit: number;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/** Per-block sufficient statistics (Σx, Σx²) → the Sharpe of any block union without touching raw rows. */
interface BlockStatistics {
  sum: number[];
  sumSq: number[];
  rows: number;
}

/** Sharpe of a union of blocks (mean/σ, population σ — ranking is invariant to the ddof). */
function unionSharpe(blocks: BlockStatistics[], picks: number[], n: number): number {
  let s = 0;
  let ss = 0;
  let rows = 0;
  for (const b of picks) {
    s += blocks[b]!.sum[n]!;
    ss += blocks[b]!.sumSq[n]!;
    rows += blocks[b]!.rows;
  }
  const m = s / rows;
  const variance = ss / rows - m * m;
  return variance > 0 ? m / Math.sqrt(variance) : 0;
}

/**
 * **Probability of backtest overfitting** (Bailey & López de Prado's CSCV). Given a `T × N` matrix of
 * per-period returns — `T` time observations (rows) × `N` strategy configurations you selected among
 * (columns) — split the rows into `S` blocks, and over **every** `C(S, S/2)` symmetric partition into an
 * in-sample and an out-of-sample half: pick the IS-best configuration, then measure its OOS rank. PBO is
 * the fraction of splits where the IS winner lands **below the OOS median** — the probability that
 * picking the best backtest buys you a below-average live result. `≈ 0.5` means the selection is worthless
 * out of sample; `≈ 0` means a genuinely persistent edge. Depends only on `@totalfinance/core`/`math`.
 */
export function probabilityOfBacktestOverfitting(
  returns: number[][],
  options: BacktestOverfittingProbabilityOptions = {},
): BacktestOverfittingProbabilityResult {
  const functionName = 'probabilityOfBacktestOverfitting';
  requireArgumentArray(functionName, 'returns', returns);
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, PBO_OPTIONS_KEYS);
  ensureFiniteWhenPresent(options.splits, 'splits', 'probabilityOfBacktestOverfitting');
  const S = options.splits ?? 16;
  // isSafeInteger for uniformity (2026-08-23 review, P0) — the ≤ 16 bound already rejects any
  // unsafe magnitude, so C(S, S/2) stays ≤ C(16, 8) = 12,870 partitions.
  if (!Number.isSafeInteger(S) || S < 4 || S > 16 || S % 2 !== 0) {
    throw new InputError(`${functionName}: splits must be an even integer in [4, 16], got ${S}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { splits: S },
    });
  }
  const T = returns.length;
  if (T < S) {
    throw new InputError(
      `${functionName}: need at least splits=${S} observations (rows), got ${T}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { observations: T, splits: S },
      },
    );
  }
  const N = Array.isArray(returns[0]) ? returns[0]!.length : 0;
  if (N < 2) {
    throw new InputError(
      `${functionName}: need at least 2 strategy configurations (columns) to rank; got ${N}.`,
      { code: ErrorCode.InputOutOfRange, context: { trials: N } },
    );
  }

  const block = Math.floor(T / S);
  const used = block * S;
  const offset = T - used; // drop the oldest `offset` rows to make T a multiple of S
  const warnings: QuantWarning[] = [];
  if (offset > 0) {
    warnings.push({
      code: WarningCode.ResearchBacktestOverfittingProbabilityTrimmed,
      message: `${functionName}: trimmed the oldest ${offset} observation(s) so T=${used} divides into ${S} blocks.`,
      severity: 'info',
      context: { dropped: offset, used, splits: S },
    });
  }

  // Per-block sufficient statistics (validating the matrix is rectangular + finite as we go).
  const blocks: BlockStatistics[] = [];
  for (let s = 0; s < S; s++) {
    const sum = new Array<number>(N).fill(0);
    const sumSq = new Array<number>(N).fill(0);
    for (let r = 0; r < block; r++) {
      const row = returns[offset + s * block + r];
      if (!Array.isArray(row) || row.length !== N) {
        throw new InputError(
          `${functionName}: returns must be a rectangular T×N matrix (row ${offset + s * block + r} has a different width).`,
          {
            code: ErrorCode.InputWrongShape,
            context: { expectedWidth: N, row: offset + s * block + r },
          },
        );
      }
      for (let n = 0; n < N; n++) {
        const x = row[n]!;
        ensureFinite(x, `returns[${offset + s * block + r}][${n}]`, functionName);
        sum[n]! += x;
        sumSq[n]! += x * x;
      }
    }
    blocks.push({ sum, sumSq, rows: block });
  }

  const combos = choose(range(0, S), S / 2);
  const all = new Set(range(0, S));
  const logits: number[] = [];
  let overfit = 0;
  for (const isPicks of combos) {
    const isSet = new Set(isPicks);
    const oosPicks = [...all].filter((b) => !isSet.has(b));
    // IS-best configuration.
    let best = 0;
    let bestSharpe = -Infinity;
    for (let n = 0; n < N; n++) {
      const sh = unionSharpe(blocks, isPicks, n);
      if (sh > bestSharpe) {
        bestSharpe = sh;
        best = n;
      }
    }
    // Its OOS relative rank r̄ = (#configs with OOS Sharpe ≤ the winner's) / (N+1).
    const winnerOos = unionSharpe(blocks, oosPicks, best);
    let le = 0;
    for (let n = 0; n < N; n++) if (unionSharpe(blocks, oosPicks, n) <= winnerOos) le++;
    const rBar = le / (N + 1); // ∈ (0, 1); logit is always finite
    const lambda = Math.log(rBar / (1 - rBar));
    logits.push(lambda);
    if (lambda < 0) overfit++;
  }

  return {
    backtestOverfittingProbability: overfit / combos.length,
    combinations: combos.length,
    splits: S,
    observations: used,
    trials: N,
    medianLogit: median(logits),
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, method: 'cscv', splits: S },
    diagnostics: { warnings },
  };
}

/** {@link BacktestOverfittingProbabilityOptions} keys (Law 12). */
const PBO_OPTIONS_KEYS = ['splits'] as const;

// ───────────────────────── helpers ─────────────────────────

/** All `C(items.length, k)` combinations of `k` items, as index arrays (lexicographic). */
function choose<T>(items: readonly T[], k: number): T[][] {
  const S = items.length;
  const out: T[][] = [];
  const idx = range(0, k);
  for (;;) {
    out.push(idx.map((i) => items[i]!));
    let i = k - 1;
    while (i >= 0 && idx[i] === S - k + i) i--;
    if (i < 0) break;
    idx[i]!++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1]! + 1;
  }
  return out;
}

/** Median of a numeric array (does not mutate the input). */
function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function range(start: number, end: number): number[] {
  const out = new Array<number>(Math.max(0, end - start));
  for (let i = start; i < end; i++) out[i - start] = i;
  return out;
}

// Safe integer, not just integer (2026-08-23 review, P0): every caller feeds a splitter whose loop
// bounds and allocations these values drive — `Number.isInteger(1e308)` is `true`, and above 2^53
// a loop counter stops advancing. The splitters additionally bound the PRODUCT of their counts
// (MAX_SPLIT_INDEX_ENTRIES); this gate keeps each count exact on its own.
function requirePositiveInt(value: number, field: string, functionName: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InputError(`${functionName}: ${field} must be a positive integer, got ${value}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { [field]: value },
    });
  }
}
