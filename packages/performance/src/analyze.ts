/** A one-call performance summary (spec §15.1). */

import {
  CONVENTIONS_VERSION,
  type Computed,
  InputError,
  type QuantWarning,
  seriesFacade,
  suspiciousReturnsWarning,
  ensureKnownKeys,
  ErrorCode,
  WarningCode,
} from '@totalfinance/core';
import { type DrawdownResult, maxDrawdown } from './drawdown.js';
import { annualizedReturn, calmar, sortino } from './metrics.js';
import { hitRate, omega, profitFactor } from './ratios.js';
import { alpha, beta, informationRatio, trackingError, treynor } from './relative.js';
import { equityCurve, simpleReturns } from './returns.js';
import { requireSeries } from './sharpe.js';
import { resolvePeriodsPerYear, resolveRiskFreeRate } from './annualization-internal.js';
import { annualizedVolatility, sharpe } from './sharpe.js';

/**
 * Input for {@link analyze}: an explicit `equity` curve (growth of capital) **or** a per-period
 * `returns` series — a tagged union so the caller can never silently confuse the two (WS3.3b).
 */
export type AnalyzeInput = { equity: ArrayLike<number> } | { returns: ArrayLike<number> };

/** Law 12 allowlist for {@link AnalyzeInput} — the union's two tags; anything else is a typo. */
const ANALYZE_INPUT_KEYS = ['returns', 'equity'] as const;

export interface AnalyzeOptions {
  /** Annualization factor. Defaults to 252 (daily); echoed in the summary's `assumptions`. */
  periodsPerYear?: number;
  riskFreeRate?: number;
  /**
   * Per-period benchmark **return** series aligned to the equity curve's returns (length =
   * `equity.length − 1`). When supplied, the summary adds beta, alpha, tracking error, information
   * ratio, and the Treynor ratio.
   */
  benchmark?: ArrayLike<number>;
}

/** Law 12 allowlist for {@link AnalyzeOptions} — a `benchMark` typo teaches, never a summary silently missing beta/alpha. */
const ANALYZE_OPTIONS_KEYS = ['periodsPerYear', 'riskFreeRate', 'benchmark'] as const;

export interface PerformanceSummary {
  periods: number;
  /** `null` when compounding overflowed (disclosed via `performance.non_finite_metric`). */
  totalReturn: number | null;
  /** `null` when compounding overflowed (disclosed via `performance.non_finite_metric`). */
  annualizedReturn: number | null;
  annualizedVolatility: number | null;
  /** `null` when the metric is undefined for this input (disclosed via warnings). */
  sharpe: number | null;
  /** `null` when the metric is undefined for this input (disclosed via warnings). */
  sortino: number | null;
  /** `null` when the metric is undefined for this input (disclosed via warnings). */
  calmar: number | null;
  maxDrawdown: number;
  drawdown: DrawdownResult;
  /** Omega ratio at a 0 per-period threshold. */
  /** `null` when the metric is undefined for this input (disclosed via warnings). */
  omega: number | null;
  /** Fraction of non-zero return periods that were positive. */
  /** `null` when the metric is undefined for this input (disclosed via warnings). */
  hitRate: number | null;
  /** Gross gains ÷ gross losses across the return series. */
  /** `null` when the metric is undefined for this input (disclosed via warnings). */
  profitFactor: number | null;
  /** Mean per-period return (expectancy); `null` on an empty series or overflow (disclosed). */
  expectancy: number | null;
  /** Diagnostics — e.g. `performance.suspicious_equity_input` when an equity curve looks like returns. */
  warnings: QuantWarning[];
  /** Beta to the benchmark (only when `options.benchmark` is supplied). */
  beta?: number | null;
  /** Annualized Jensen's alpha (only when `options.benchmark` is supplied). */
  alpha?: number | null;
  /** Annualized tracking error (only when `options.benchmark` is supplied). */
  trackingError?: number | null;
  /** Information ratio (only when `options.benchmark` is supplied). */
  informationRatio?: number | null;
  /** Treynor ratio (only when `options.benchmark` is supplied). */
  treynor?: number | null;
  /** The conventions actually applied — a serialized summary is self-interpreting (spec §7.4). */
  assumptions: {
    /** Annualization factor used for all annualized metrics. */
    periodsPerYear: number;
    /** Per-period risk-free rate used for Sharpe/Sortino/alpha/Treynor (0 when unspecified). */
    riskFreeRate: number;
    /** Length of the benchmark return series, present only when a benchmark was supplied. */
    benchmarkLength?: number;
  };
}

/** Summarize an equity curve (growth of capital) into the standard performance metrics. */
function analyzeValue(input: AnalyzeInput, options: AnalyzeOptions = {}): PerformanceSummary {
  const anyInput = input as { returns?: unknown; equity?: unknown };
  // Law 12 on the tagged union (plain objects only — a bare series/string keeps the teaching error
  // below): an unknown tag (`rets`, `equityCurve`) gets a did-you-mean instead of "missing field".
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    ensureKnownKeys('analyze', 'input', input, ANALYZE_INPUT_KEYS);
  }
  if (anyInput.returns === undefined && anyInput.equity === undefined) {
    throw new InputError(
      'analyze: supply { returns } (per-period decimals) or { equity } (an equity curve).',
      { code: ErrorCode.InputMissingField, context: {} },
    );
  }
  // BOTH tags at once is a confused caller, not a choice this function should silently make (it
  // would prefer `equity` and ignore `returns`).
  if (anyInput.returns !== undefined && anyInput.equity !== undefined) {
    throw new InputError(
      'analyze: supply exactly one of { returns } or { equity }, not both — they are different units and the choice changes every metric.',
      { code: ErrorCode.InputWrongShape, context: {} },
    );
  }
  requireSeries(
    (anyInput.returns ?? anyInput.equity) as ArrayLike<number>,
    'analyze',
    anyInput.returns !== undefined ? 'returns' : 'equity',
  );
  const warnings: QuantWarning[] = [];
  // Law 12: an unknown option (a `benchMark` typo) teaches instead of a summary silently missing
  // its beta/alpha block.
  ensureKnownKeys('analyze', 'options', options, ANALYZE_OPTIONS_KEYS);
  // Resolve the Tier-1 annualization default once, so it is echoed (not hidden) in `assumptions`
  // — the shared resolver carries the positivity/finiteness rejection (design law #4).
  const periodsPerYear = resolvePeriodsPerYear('analyze', options);
  // Exact-shaped hand-offs: each metric's own Law 12 guard rejects keys outside ITS options
  // interface (e.g. `benchmark`/`riskFreeRate` on an annualization-only metric), so the wider
  // AnalyzeOptions must never be forwarded verbatim.
  const annualizationOpts = { periodsPerYear };
  const sharpeOpts = {
    periodsPerYear,
    ...(options.riskFreeRate !== undefined ? { riskFreeRate: options.riskFreeRate } : {}),
  };
  // Element-level finiteness is requireSeries' job (E4): every slot was already validated above.
  let returns: number[];
  let equity: ArrayLike<number>;
  let totalReturn: number;

  if ('equity' in input) {
    equity = input.equity;
    const en = equity.length;
    // A zero equity level before the end makes that period's return `x/0`. It used to flow through
    // as a NaN and resurface as "annualizedReturn overflowed" — an error naming the wrong function
    // and the wrong cause. Name the offending `equity[i]` here, where the caller can act on it.
    // (A zero as the LAST point is a legitimate total loss: that period's return is −100%.)
    for (let i = 0; i < en - 1; i++) {
      if (equity[i] === 0) {
        throw new InputError(
          `analyze: equity[${i}] is 0 — the return over equity[${i}] → equity[${i + 1}] divides by it and is undefined. equity is a capital LEVEL series (e.g. [100, 110, 99]); drop the zero level or pass the per-period returns as { returns }.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: 'analyze', field: 'equity', index: i },
          },
        );
      }
    }
    // Returns-vs-equity guard (WS3.3b): a genuine equity curve is all-positive with a non-tiny mean
    // level. Non-positive values or |mean| < 0.05 almost always mean a per-period RETURN series was
    // passed as `equity` — surface it rather than silently reporting nonsense metrics.
    let sum = 0;
    let anyNonPositive = false;
    for (let i = 0; i < en; i++) {
      const v = equity[i]!;
      sum += v;
      if (v <= 0) anyNonPositive = true;
    }
    const meanLevel = en > 0 ? sum / en : NaN;
    if (anyNonPositive || Math.abs(meanLevel) < 0.05) {
      warnings.push({
        code: WarningCode.PerformanceSuspiciousEquityInput,
        message: anyNonPositive
          ? 'analyze({ equity }) received a series with non-positive values — did you pass per-period returns as an equity curve? Use analyze({ returns }) instead.'
          : `analyze({ equity }) received a series with a near-zero mean level (${meanLevel.toFixed(4)}) — did you pass per-period returns as an equity curve? Use analyze({ returns }) instead.`,
        severity: 'info',
      });
    }
    returns = simpleReturns(equity);
    totalReturn = en >= 2 ? equity[en - 1]! / equity[0]! - 1 : NaN;
  } else {
    returns = Array.from(input.returns);
    // The prices-as-returns footgun (WS-3/R6): analyze discloses it exactly like sharpe.explain.
    const suspicious = suspiciousReturnsWarning(returns);
    if (suspicious !== undefined) warnings.push(suspicious);
    equity = equityCurve(returns, 1); // reconstruct a growth-of-1 curve for the drawdown path
    let growth = 1;
    for (let i = 0; i < returns.length; i++) growth *= 1 + returns[i]!;
    totalReturn = returns.length > 0 ? growth - 1 : NaN;
  }

  const dd = maxDrawdown(equity);
  let mean = 0;
  for (let i = 0; i < returns.length; i++) mean += returns[i]!;
  mean = returns.length > 0 ? mean / returns.length : NaN;

  // Law 7 (E3): zero return periods make every metric undefined — the summary is degenerate
  // all-null WITH a disclosure, never a PostconditionError and never a silent NaN.
  if (returns.length === 0) {
    warnings.push({
      code: WarningCode.PerformanceEmptySeries,
      message:
        'analyze: the input produced zero return periods — every metric is undefined and reported as null (drawdown is the empty-series zero record).',
      severity: 'warn',
      context: { periods: 0 },
    });
  }

  // Law 7: a compounding overflow (astronomical "returns" — usually a unit mistake) reports
  // null-with-reason, never an Infinity that JSON.stringify would corrupt to null silently.
  const finiteOrDisclosedNull = (label: string, v: number): number | null => {
    if (Number.isFinite(v)) return v;
    warnings.push({
      code: WarningCode.PerformanceNonFiniteMetric,
      message: `analyze: ${label} overflowed (${v}) — the input scale is inconsistent with per-period decimal returns; reported as null.`,
      severity: 'warn',
      context: { metric: label, value: String(v) },
    });
    return null;
  };
  const summary: PerformanceSummary = {
    periods: returns.length,
    // On an empty series these are null under the `performance.empty_series` disclosure above —
    // the overflow message would misdiagnose "no data" as "wrong scale".
    totalReturn: returns.length > 0 ? finiteOrDisclosedNull('totalReturn', totalReturn) : null,
    annualizedReturn: (() => {
      if (returns.length === 0) return null;
      const v = annualizedReturn(returns, annualizationOpts);
      return v === null ? finiteOrDisclosedNull('annualizedReturn', NaN) : v;
    })(),
    annualizedVolatility: annualizedVolatility(returns, annualizationOpts),
    sharpe: sharpe(returns, sharpeOpts),
    sortino: sortino(returns, sharpeOpts),
    calmar: calmar(returns, annualizationOpts),
    maxDrawdown: dd.maxDrawdown,
    drawdown: dd,
    omega: omega(returns),
    hitRate: hitRate(returns),
    profitFactor: profitFactor(returns),
    expectancy: returns.length > 0 ? finiteOrDisclosedNull('expectancy', mean) : null,
    warnings,
    assumptions: {
      periodsPerYear,
      // Sharpe/Sortino/alpha/Treynor treat an unspecified risk-free rate as 0 — echo the applied value.
      riskFreeRate: resolveRiskFreeRate('analyze', options),
    },
  };

  if (options.benchmark !== undefined) {
    summary.beta = beta(returns, options.benchmark);
    summary.alpha = alpha(returns, options.benchmark, sharpeOpts);
    summary.trackingError = trackingError(returns, options.benchmark, annualizationOpts);
    summary.informationRatio = informationRatio(returns, options.benchmark, annualizationOpts);
    summary.treynor = treynor(returns, options.benchmark, sharpeOpts);
    summary.assumptions.benchmarkLength = options.benchmark.length;
  }

  // D3: scan AFTER the benchmark block so relative metrics receive the same named disclosure as
  // the base summary. A null in a JSON payload without a reason is indistinguishable from missing.
  const nullableMetrics: (keyof PerformanceSummary)[] = [
    'sharpe',
    'sortino',
    'calmar',
    'omega',
    'hitRate',
    'profitFactor',
    ...(options.benchmark === undefined
      ? []
      : (['beta', 'alpha', 'trackingError', 'informationRatio', 'treynor'] as const)),
  ];
  const nullMetrics = nullableMetrics.filter((key) => summary[key] === null);
  if (nullMetrics.length > 0) {
    warnings.push({
      code: WarningCode.PerformanceUndefinedMetric,
      message: `analyze: ${nullMetrics.join(', ')} ${nullMetrics.length === 1 ? 'is' : 'are'} undefined for this input (degenerate dispersion/drawdown/loss profile); reported as null.`,
      severity: 'info',
      context: { metrics: nullMetrics },
    });
  }

  return summary;
}

/**
 * The performance summary facade (dx §2.3): plain call → the summary; `.explain()` → the core
 * Computed envelope around it (the summary's own warnings ride `diagnostics.warnings`, its echoed
 * conventions ride `assumptions`).
 */
export const analyze = seriesFacade(
  'analyze',
  analyzeValue,
  (
    input: AnalyzeInput,
    options: AnalyzeOptions = {},
  ): Computed<PerformanceSummary, PerformanceSummary['assumptions']> => {
    const summary = analyzeValue(input, options);
    return {
      value: summary,
      assumptions: { conventionsVersion: CONVENTIONS_VERSION, ...summary.assumptions },
      diagnostics: { warnings: summary.warnings },
    };
  },
);
