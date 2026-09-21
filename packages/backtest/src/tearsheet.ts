/**
 * Tear sheets, attribution, and Monte-Carlo resampling (spec §16.2).
 *
 * A tear sheet is a structured (browser-safe, render-free) summary of a {@link BacktestResult}: the
 * standard performance metrics plus return-distribution stats, trade/cost totals, per-symbol realized
 * P&L attribution, and — optionally — a seeded bootstrap of the bar returns for confidence bands on the
 * total return (so a single backtest path isn't mistaken for certainty).
 *
 * Every analysis export here is REPORT-shaped (Law 2): the domain fields carry `assumptions` +
 * `diagnostics` inline (no `value` nesting), exactly like the fixed-income rates reports. The tear
 * sheet itself echoes the SOURCE backtest's assumptions/diagnostics (WS2.8) and only augments the
 * warnings channel when a derived stat is undefined (Law 7: null-with-reason, never a non-finite).
 */

import {
  ErrorCode,
  InputError,
  CONVENTIONS_VERSION,
  WarningCode,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  warning,
  signOf,
} from '@totalfinance/core';
import type { QuantWarning, SymbolId } from '@totalfinance/core';
import { bootstrap } from '@totalfinance/math';
import type { PerformanceSummary } from '@totalfinance/performance';
import type { BacktestAssumptions, BacktestResult, ImplementationRisk, Trade } from './types.js';

export interface TradeStatistics {
  count: number;
  totalCommission: number;
  totalSlippage: number;
  turnover: number;
}

export interface ReturnStatistics {
  /**
   * Fraction of non-zero return bars that were positive. `null` when the series has NO non-zero
   * bar — there is no win/loss population to take a fraction of, so the metric is undefined and is
   * disclosed via a `performance.undefined_metric` warning rather than reported as a `0` hit rate
   * (which reads as "every bar lost"). Matches `@totalfinance/performance`'s `analyze().hitRate`.
   */
  hitRate: number | null;
  /**
   * Σ gains ÷ |Σ losses|. `null` when there are gains but NO losses — the ratio has no finite
   * value, so it is disclosed via a `performance.undefined_metric` warning, never `Infinity`
   * (Law 7). `0` when there are no gains either.
   */
  profitFactor: number | null;
  /**
   * Mean per-bar return. `null` on an EMPTY series (no bars to average), disclosed the same way —
   * matches `@totalfinance/performance`'s `analyze().expectancy`, which never reports a fabricated `0`.
   */
  expectancy: number | null;
  averageWin: number;
  averageLoss: number;
  bestPeriod: number;
  worstPeriod: number;
}

/** Realized P&L (and costs) attributed to one symbol. */
export interface SymbolAttribution {
  symbol: SymbolId;
  /** Realized trading P&L (average-cost matched; excludes open positions, dividends, borrow). */
  realizedPnl: number;
  commission: number;
  slippage: number;
  tradedNotional: number;
}

export interface MonteCarloResampleResult {
  iterations: number;
  seed: number;
  /** Mean bootstrapped total return. */
  meanTotalReturn: number;
  standardDeviation: number;
  /** 95% percentile interval of the total return across resamples. */
  confidenceInterval95: [number, number];
}

/** {@link returnStatistics} as a report: the stats carrying `assumptions` + `diagnostics` inline. */
export interface ReturnStatisticsReport extends ReturnStatistics {
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  diagnostics: { warnings: QuantWarning[] };
}

/** {@link attribution} as a report: per-symbol rows carrying `assumptions` + `diagnostics` inline. */
export interface AttributionReport {
  /** Realized P&L per symbol (average-cost matched), in first-trade order. */
  bySymbol: SymbolAttribution[];
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  diagnostics: { warnings: QuantWarning[] };
}

/** {@link monteCarloResample} as a report: the resample stats + `assumptions` + `diagnostics`. */
export interface MonteCarloResampleReport extends MonteCarloResampleResult {
  assumptions: { conventionsVersion: string; [k: string]: unknown };
  diagnostics: { warnings: QuantWarning[] };
}

export interface TearSheet {
  performance: PerformanceSummary;
  trades: TradeStatistics;
  returns: ReturnStatistics;
  attribution: SymbolAttribution[];
  monteCarlo?: MonteCarloResampleResult;
  /** The source backtest's echoed modelling assumptions — a tear sheet never drops them (WS2.8). */
  assumptions: BacktestAssumptions;
  /** The source backtest's implementation-risk diagnostics — a tear sheet never drops them (WS2.8). */
  diagnostics: ImplementationRisk;
}

export interface TearSheetOptions {
  /** Add a seeded Monte-Carlo bootstrap of the bar returns for total-return confidence bands. */
  monteCarlo?: { iterations?: number; seed?: number };
}

/**
 * Shared stats kernel: the distribution numbers plus the Law-7 disclosures for any metric that has
 * no finite value on this series. Module-private so the tear sheet embeds the SAME numbers the
 * report export carries without nesting a second assumptions/diagnostics block.
 */
function computeReturnStatistics(returns: ArrayLike<number>): {
  stats: ReturnStatistics;
  warnings: QuantWarning[];
} {
  let wins = 0;
  let losses = 0;
  let sumWin = 0;
  let sumLoss = 0;
  let best = -Infinity;
  let worst = Infinity;
  let sum = 0;
  for (let i = 0; i < returns.length; i++) {
    const r = returns[i]!;
    sum += r;
    if (r > best) best = r;
    if (r < worst) worst = r;
    if (r > 0) {
      wins++;
      sumWin += r;
    } else if (r < 0) {
      losses++;
      sumLoss += r;
    }
  }
  const n = returns.length;
  const warnings: QuantWarning[] = [];
  let profitFactor: number | null;
  if (sumLoss < 0) {
    profitFactor = sumWin / -sumLoss;
  } else if (sumWin > 0) {
    profitFactor = null;
    warnings.push(
      warning(
        WarningCode.PerformanceUndefinedMetric,
        'returnStatistics: profitFactor is undefined — the series has gains but no losing periods ' +
          '(Σ losses = 0), so gains ÷ |losses| has no finite value; reported as null.',
        'info',
        { wins, losses },
      ),
    );
  } else {
    profitFactor = 0;
  }
  // Law 7 alignment with @totalfinance/performance: a metric with no population is `null` + a
  // disclosure, never a fabricated `0` (a `0` hit rate means "every non-zero bar lost", which is a
  // materially different — and false — claim about a flat or empty series).
  let hitRate: number | null;
  if (wins + losses > 0) {
    hitRate = wins / (wins + losses);
  } else {
    hitRate = null;
    warnings.push(
      warning(
        WarningCode.PerformanceUndefinedMetric,
        'returnStatistics: hitRate is undefined — the series has no non-zero period, so there is no ' +
          'win/loss population to take a fraction of; reported as null (not a 0 hit rate).',
        'info',
        { periods: n, wins, losses },
      ),
    );
  }
  let expectancy: number | null;
  if (n > 0) {
    expectancy = sum / n;
  } else {
    expectancy = null;
    warnings.push(
      warning(
        WarningCode.PerformanceUndefinedMetric,
        'returnStatistics: expectancy is undefined — the series is empty, so there is no mean ' +
          'per-period return; reported as null (not a 0 expectancy).',
        'info',
        { periods: n },
      ),
    );
  }
  return {
    stats: {
      hitRate,
      profitFactor,
      expectancy,
      averageWin: wins > 0 ? sumWin / wins : 0,
      averageLoss: losses > 0 ? sumLoss / losses : 0,
      bestPeriod: n > 0 ? best : 0,
      worstPeriod: n > 0 ? worst : 0,
    },
    warnings,
  };
}

/** Return-distribution statistics from a series of per-bar returns (report-shaped, Law 2). */
export function returnStatistics(returns: ArrayLike<number>): ReturnStatisticsReport {
  requireArgumentArray('returnStatistics', 'returns', returns);
  const { stats, warnings } = computeReturnStatistics(returns);
  return {
    ...stats,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      hitRate: 'zero-return periods excluded',
      profitFactor: 'sum(gains) / |sum(losses)|',
    },
    diagnostics: { warnings },
  };
}

/** Average-cost realized-P&L matching per symbol (the computation behind {@link attribution}). */
function attributeBySymbol(trades: Trade[]): SymbolAttribution[] {
  interface Acc {
    pos: number;
    averageCost: number;
    realized: number;
    commission: number;
    slippage: number;
    notional: number;
  }
  const acc = new Map<SymbolId, Acc>();
  for (const t of trades) {
    const a = acc.get(t.symbol) ?? {
      pos: 0,
      averageCost: 0,
      realized: 0,
      commission: 0,
      slippage: 0,
      notional: 0,
    };
    // Cash-valued at the instrument's contract multiplier: a registered option's fill moves
    // `quantity · price · multiplier` dollars, so leaving the multiplier out reported an option
    // book's turnover AND its realized P&L at 1% of the truth.
    const multiplier = t.multiplier;
    a.commission += t.commission;
    a.slippage += t.slippage;
    a.notional += t.quantity * t.price * multiplier;
    const signed = signOf(t.side) * t.quantity;
    if (a.pos !== 0 && Math.sign(signed) !== Math.sign(a.pos)) {
      const closedQty = Math.min(Math.abs(signed), Math.abs(a.pos));
      a.realized += (t.price - a.averageCost) * closedQty * Math.sign(a.pos) * multiplier;
      if (Math.abs(signed) > Math.abs(a.pos)) a.averageCost = t.price; // flipped through zero
      a.pos += signed;
    } else {
      const next = a.pos + signed;
      a.averageCost = next === 0 ? 0 : (a.averageCost * a.pos + t.price * signed) / next;
      a.pos = next;
    }
    acc.set(t.symbol, a);
  }
  return [...acc.entries()].map(([symbol, a]) => ({
    symbol,
    realizedPnl: a.realized,
    commission: a.commission,
    slippage: a.slippage,
    tradedNotional: a.notional,
  }));
}

/** Per-symbol realized P&L attribution (average-cost matched) from a trade blotter (report-shaped). */
export function attribution(trades: Trade[]): AttributionReport {
  requireArgumentArray('attribution', 'trades', trades);
  return {
    bySymbol: attributeBySymbol(trades),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      matching: 'average-cost',
      scope: 'realized trading P&L only (open positions, dividends, and borrow excluded)',
    },
    diagnostics: { warnings: [] },
  };
}

/** EXACT {@link monteCarloResample} / tear-sheet `monteCarlo` option fields (Law 12). */
const MONTE_CARLO_OPTS_KEYS = ['iterations', 'seed'] as const;

/** The seeded bootstrap behind {@link monteCarloResample} (shared with the tear sheet). */
function resampleTotalReturn(
  returns: ArrayLike<number>,
  options: { iterations?: number; seed?: number },
): MonteCarloResampleResult {
  if (
    (options as unknown as Record<string, unknown>)['iterations'] !== undefined &&
    (typeof (options as unknown as Record<string, unknown>)['iterations'] !== 'number' ||
      !Number.isFinite((options as unknown as Record<string, unknown>)['iterations'] as number))
  ) {
    throw new InputError(
      `tearsheet: iterations must be a finite number when provided. Received ${(options as unknown as Record<string, unknown>)['iterations'] === null ? 'null' : typeof (options as unknown as Record<string, unknown>)['iterations']}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'iterations' } },
    );
  }
  const iterations = options.iterations ?? 1000;
  if (
    (options as unknown as Record<string, unknown>)['seed'] !== undefined &&
    (typeof (options as unknown as Record<string, unknown>)['seed'] !== 'number' ||
      !Number.isFinite((options as unknown as Record<string, unknown>)['seed'] as number))
  ) {
    throw new InputError(
      `tearsheet: seed must be a finite number when provided. Received ${(options as unknown as Record<string, unknown>)['seed'] === null ? 'null' : typeof (options as unknown as Record<string, unknown>)['seed']}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'seed' } },
    );
  }
  const seed = options.seed ?? 1;
  const res = bootstrap(returns, (sample) => sample.reduce((g, r) => g * (1 + r), 1) - 1, {
    iterations,
    seed,
  });
  return {
    iterations,
    seed: res.seed,
    meanTotalReturn: res.mean,
    standardDeviation: res.standardDeviation,
    confidenceInterval95: res.confidenceInterval95,
  };
}

/** Seeded bootstrap of bar returns → confidence bands on the compounded total return (report-shaped). */
export function monteCarloResample(
  returns: ArrayLike<number>,
  options: { iterations?: number; seed?: number } = {},
): MonteCarloResampleReport {
  const functionName = 'monteCarloResample';
  requireArgumentArray(functionName, 'returns', returns);
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, MONTE_CARLO_OPTS_KEYS);
  return {
    ...resampleTotalReturn(returns, options),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      resampling: 'iid-bootstrap of per-bar returns (serial dependence not preserved)',
      interval: 'percentile-95',
    },
    diagnostics: { warnings: [] },
  };
}

/** EXACT {@link TearSheetOptions} fields (Law 12). */
const TEAR_SHEET_OPTS_KEYS = ['monteCarlo'] as const;

/** Build a structured tear sheet from a backtest result. */
export function tearSheet(result: BacktestResult, options: TearSheetOptions = {}): TearSheet {
  const functionName = 'tearSheet';
  requireArgumentObject(functionName, 'result', result);
  requireArgumentArray(functionName, 'result.returns', (result as BacktestResult).returns);
  requireArgumentArray(functionName, 'result.trades', (result as BacktestResult).trades);
  requireArgumentObject(functionName, 'options', options);
  ensureKnownKeys(functionName, 'options', options, TEAR_SHEET_OPTS_KEYS);
  // Metadata honesty (2026-08-23, fourth review): the report's own count echoes must be counts.
  // A hand-edited result whose `periods` is 2.5 or beyond 2^53 is not a result this library
  // produced — teach instead of formatting nonsense into a tear sheet.
  for (const [label, count] of [
    ['result.performance.periods', result.performance?.periods],
    [
      'result.performance.drawdown.longestDurationPeriods',
      result.performance?.drawdown?.longestDurationPeriods,
    ],
  ] as const) {
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) {
      throw new InputError(
        `${functionName}: ${label} must be a safe integer ≥ 0 (a period count echoed by the backtest). Received ${String(count)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: label, received: count } },
      );
    }
  }
  let totalCommission = 0;
  let totalSlippage = 0;
  for (const t of result.trades) {
    totalCommission += t.commission;
    totalSlippage += t.slippage;
  }
  const { stats: returnsStatistics, warnings: statsWarnings } = computeReturnStatistics(
    result.returns,
  );
  // WS2.8: the SOURCE diagnostics pass through by reference; the object is only re-built when a
  // derived stat needed a Law-7 disclosure of its own (an augmented copy — the source is not mutated).
  const source = result.diagnostics as ImplementationRisk | undefined;
  const diagnostics =
    statsWarnings.length === 0 || source === undefined
      ? result.diagnostics
      : { ...source, warnings: [...source.warnings, ...statsWarnings] };
  const sheet: TearSheet = {
    performance: result.performance,
    trades: {
      count: result.trades.length,
      totalCommission,
      totalSlippage,
      turnover: result.turnover,
    },
    returns: returnsStatistics,
    attribution: attributeBySymbol(result.trades),
    assumptions: result.assumptions,
    diagnostics,
  };
  if (options.monteCarlo === null) {
    throw new InputError(
      `${functionName}: monteCarlo must be an object when provided — omit the field to skip the resample. Received null.`,
      { code: ErrorCode.InputWrongType, context: { field: 'monteCarlo' } },
    );
  }
  if (options.monteCarlo) {
    requireArgumentObject(functionName, 'options.monteCarlo', options.monteCarlo);
    ensureKnownKeys(functionName, 'options.monteCarlo', options.monteCarlo, MONTE_CARLO_OPTS_KEYS);
    sheet.monteCarlo = resampleTotalReturn(result.returns, options.monteCarlo);
  }
  return sheet;
}
