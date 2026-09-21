/**
 * The options tear sheet — the base return/performance stats plus the options-native breakdown an
 * options trader actually reads: win rate, average credit, days held, assignment count, P&L by
 * structure, and per-leg-role attribution. Reuses `returnStatistics` from the equity tear sheet.
 *
 * Report-shaped (Law 2): the sheet carries the source backtest's `assumptions` + `diagnostics`
 * inline, and any stat with no finite value on this run is `null` plus a warning explaining the
 * null (Law 7) — never NaN.
 */

import {
  ErrorCode,
  InputError,
  WarningCode,
  requireArgumentArray,
  requireArgumentObject,
  warning,
} from '@totalfinance/core';
import type { Diagnostics, QuantWarning } from '@totalfinance/core';
import type { PerformanceSummary } from '@totalfinance/performance';
import type { PnlExplain } from '@totalfinance/risk';
import { type ReturnStatistics, returnStatistics } from '../tearsheet.js';
import type { OptionsBacktestAssumptions, OptionsBacktestResult, OptionsTrade } from './types.js';

const DAY_MS = 86_400_000;

/** Options-strategy summary stats over the closed trades. */
export interface OptionsTradeStatistics {
  /** Closed round-trips (excludes any position still open at the end). */
  closed: number;
  wins: number;
  losses: number;
  /**
   * `wins / (wins + losses)`. `null` when there are no decided trades — disclosed via a
   * `performance.undefined_metric` warning, never NaN (Law 7).
   */
  winRate: number | null;
  /** Average credit received on credit trades (entry premium < 0); 0 when there are none. */
  averageCredit: number;
  /** Average realized P&L per closed trade, in account currency. */
  averagePnl: number;
  /** Average calendar days a closed trade was held. */
  averageDaysHeld: number;
  /** Total commission + slippage across all trades. */
  totalCosts: number;
  /** Number of legs assigned at expiry (short, ITM). */
  assignments: number;
}

/** Realized P&L grouped by the constructed structure (e.g. `bullPutSpread`). */
export interface StructureAttribution {
  structure: string;
  trades: number;
  realizedPnl: number;
  /** `null` when the group has no decided (non-zero P&L) trades — disclosed, never NaN (Law 7). */
  winRate: number | null;
}

/** Realized P&L grouped by leg role (`short put`, `long call`, `stock`, …) across every trade. */
export interface LegRoleAttribution {
  role: string;
  legs: number;
  realizedPnl: number;
}

/**
 * Strategy-level greek P&L attribution — the per-trade `TradePnlExplain`s summed across every trade.
 * Answers "where did the P&L come from": how much of the realized gross P&L was `delta` (direction),
 * `theta` (decay), `gamma` (convexity), `vega` (vol), etc., plus the `unexplained` 3rd-order-and-higher
 * residual. `total` is the summed **gross** (pre-cost) mark P&L; the net P&L is `total −
 * options.totalCosts`. Because the backtester marks at constant entry IV with a fixed rate, `delta`/
 * `gamma`/`theta` carry most strategies and `vega`/`rho` are ~0 (see `TradePnlExplain`).
 */
export interface GreekAttribution extends Omit<PnlExplain, 'assumptions' | 'diagnostics'> {
  /** Number of trades summed (every trade in the result, closed and open-at-end). */
  trades: number;
}

export interface OptionsTearSheet {
  performance: PerformanceSummary;
  returns: ReturnStatistics;
  options: OptionsTradeStatistics;
  byStructure: StructureAttribution[];
  byLegRole: LegRoleAttribution[];
  /** Strategy-level greek P&L decomposition (summed per-trade explains). */
  greekAttribution: GreekAttribution;
  /** Echoed from the source backtest — never dropped (the envelope law). */
  assumptions: OptionsBacktestAssumptions;
  diagnostics: Diagnostics;
}

function legRole(kind: string, quantity: number): string {
  if (kind === 'stock') return quantity >= 0 ? 'long stock' : 'short stock';
  return `${quantity >= 0 ? 'long' : 'short'} ${kind}`;
}

function tradeStatistics(
  trades: readonly OptionsTrade[],
  assignments: number,
): { stats: OptionsTradeStatistics; warnings: QuantWarning[] } {
  const closed = trades.filter((t) => t.exitAsOf !== null);
  let wins = 0;
  let losses = 0;
  let creditSum = 0;
  let creditCount = 0;
  let pnlSum = 0;
  let daysSum = 0;
  let totalCosts = 0;
  for (const t of trades) totalCosts += t.costs;
  for (const t of closed) {
    if (t.realizedPnl > 0) wins++;
    else if (t.realizedPnl < 0) losses++;
    if (t.entryPremium < 0) {
      creditSum += -t.entryPremium;
      creditCount++;
    }
    pnlSum += t.realizedPnl;
    if (t.exitAsOf !== null) daysSum += (t.exitAsOf - t.entryAsOf) / DAY_MS;
  }
  const decided = wins + losses;
  const warnings: QuantWarning[] = [];
  if (decided === 0) {
    warnings.push(
      warning(
        WarningCode.PerformanceUndefinedMetric,
        'optionsTearSheet: winRate is undefined — no closed trade has a non-zero realized P&L; ' +
          'reported as null.',
        'info',
        { closed: closed.length },
      ),
    );
  }
  return {
    stats: {
      closed: closed.length,
      wins,
      losses,
      winRate: decided > 0 ? wins / decided : null,
      averageCredit: creditCount > 0 ? creditSum / creditCount : 0,
      averagePnl: closed.length > 0 ? pnlSum / closed.length : 0,
      averageDaysHeld: closed.length > 0 ? daysSum / closed.length : 0,
      totalCosts,
      assignments,
    },
    warnings,
  };
}

function byStructure(trades: readonly OptionsTrade[]): {
  rows: StructureAttribution[];
  warnings: QuantWarning[];
} {
  const groups = new Map<
    string,
    { trades: number; realizedPnl: number; wins: number; decided: number }
  >();
  for (const t of trades) {
    const g = groups.get(t.structure) ?? { trades: 0, realizedPnl: 0, wins: 0, decided: 0 };
    g.trades++;
    g.realizedPnl += t.realizedPnl;
    if (t.realizedPnl > 0) {
      g.wins++;
      g.decided++;
    } else if (t.realizedPnl < 0) {
      g.decided++;
    }
    groups.set(t.structure, g);
  }
  const rows = [...groups.entries()]
    .map(([structure, g]) => ({
      structure,
      trades: g.trades,
      realizedPnl: g.realizedPnl,
      winRate: g.decided > 0 ? g.wins / g.decided : null,
    }))
    .sort((a, b) => b.realizedPnl - a.realizedPnl);
  const undecided = rows.filter((r) => r.winRate === null).map((r) => r.structure);
  const warnings: QuantWarning[] =
    undecided.length === 0
      ? []
      : [
          warning(
            WarningCode.PerformanceUndefinedMetric,
            `optionsTearSheet: winRate is undefined for structure(s) ${undecided.join(', ')} — ` +
              'no decided (non-zero P&L) trades in the group; reported as null.',
            'info',
            { structures: undecided },
          ),
        ];
  return { rows, warnings };
}

/** The greek P&L terms summed by {@link greekAttribution} (every field of the bare explain). */
const GREEK_TERM_KEYS = [
  'total',
  'delta',
  'gamma',
  'vega',
  'theta',
  'rho',
  'vanna',
  'vomma',
  'charm',
  'veta',
  'vera',
  'deltaRate',
  'thetaRate',
  'rhoConvexity',
  'thetaConvexity',
  'phi',
  'unexplained',
] as const;

/** Sum every trade's greek P&L explain into the strategy-level attribution (gross, pre-cost). */
function greekAttribution(trades: readonly OptionsTrade[]): GreekAttribution {
  const acc: GreekAttribution = {
    trades: 0,
    total: 0,
    delta: 0,
    gamma: 0,
    vega: 0,
    theta: 0,
    rho: 0,
    vanna: 0,
    vomma: 0,
    charm: 0,
    veta: 0,
    vera: 0,
    deltaRate: 0,
    thetaRate: 0,
    rhoConvexity: 0,
    thetaConvexity: 0,
    phi: 0,
    unexplained: 0,
  };
  for (const t of trades) {
    acc.trades++;
    for (const k of GREEK_TERM_KEYS) acc[k] += t.pnlExplain[k];
  }
  return acc;
}

function byLegRole(trades: readonly OptionsTrade[]): LegRoleAttribution[] {
  const groups = new Map<string, { legs: number; realizedPnl: number }>();
  for (const t of trades) {
    for (const a of t.perLeg) {
      const role = legRole(a.leg.kind, a.leg.quantity);
      const g = groups.get(role) ?? { legs: 0, realizedPnl: 0 };
      g.legs++;
      g.realizedPnl += a.realizedPnl;
      groups.set(role, g);
    }
  }
  return [...groups.entries()]
    .map(([role, g]) => ({ role, legs: g.legs, realizedPnl: g.realizedPnl }))
    .sort((a, b) => b.realizedPnl - a.realizedPnl);
}

/** Build the options tear sheet from an {@link OptionsBacktestResult}. */
export function optionsTearSheet(result: OptionsBacktestResult): OptionsTearSheet {
  requireArgumentObject('optionsTearSheet', 'result', result);
  if (
    result.assumptions === undefined ||
    result.assumptions === null ||
    typeof result.assumptions !== 'object'
  ) {
    throw new InputError(
      `optionsTearSheet: result.assumptions is required — pass the OptionsBacktestResult returned by optionsBacktest, not a hand-built object. Received ${result.assumptions === null ? 'null' : result.assumptions === undefined ? 'undefined' : typeof result.assumptions}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'assumptions' } },
    );
  }
  const functionName = 'optionsTearSheet';
  requireArgumentObject(functionName, 'result', result);
  requireArgumentArray(functionName, 'result.trades', result.trades);
  requireArgumentArray(functionName, 'result.settlements', result.settlements);
  requireArgumentArray(functionName, 'result.returns', result.returns);
  // C05: the input is the optionsBacktest RESULT artifact — decoration passes through, but the
  // members this sheet CONSUMES are validated, so a corrupted diagnostics never crashes the merge.
  const sourceDiagnostics = (result as unknown as Record<string, unknown>)['diagnostics'];
  if (
    sourceDiagnostics !== undefined &&
    (sourceDiagnostics === null || typeof sourceDiagnostics !== 'object')
  ) {
    throw new InputError(
      `${functionName}: result.diagnostics must be the backtest's diagnostics object when present. Received ${sourceDiagnostics === null ? 'null' : typeof sourceDiagnostics}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'diagnostics' } },
    );
  }
  if (
    sourceDiagnostics !== undefined &&
    !Array.isArray((sourceDiagnostics as { warnings?: unknown }).warnings)
  ) {
    throw new InputError(
      `${functionName}: result.diagnostics.warnings must be an array. Received ${typeof (sourceDiagnostics as { warnings?: unknown }).warnings}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'diagnostics.warnings' } },
    );
  }
  const assignments = result.settlements.filter((s) => s.action === 'assigned').length;
  // The report export carries its own assumptions/diagnostics; the sheet embeds the bare stats and
  // folds the stat disclosures into ITS warnings channel (one channel per report, Law 2).
  const {
    assumptions: _statsAssumptions,
    diagnostics: statsDiagnostics,
    ...returnsStatistics
  } = returnStatistics(result.returns);
  const { stats: optionsStatistics, warnings: tradeWarnings } = tradeStatistics(
    result.trades,
    assignments,
  );
  const { rows: structureRows, warnings: structureWarnings } = byStructure(result.trades);
  const extra = [...statsDiagnostics.warnings, ...tradeWarnings, ...structureWarnings];
  const source = result.diagnostics as Diagnostics | undefined;
  const diagnostics =
    extra.length === 0 || source === undefined
      ? result.diagnostics
      : { ...source, warnings: [...source.warnings, ...extra] };
  return {
    performance: result.performance,
    returns: returnsStatistics,
    options: optionsStatistics,
    byStructure: structureRows,
    byLegRole: byLegRole(result.trades),
    greekAttribution: greekAttribution(result.trades),
    assumptions: result.assumptions,
    diagnostics,
  };
}
