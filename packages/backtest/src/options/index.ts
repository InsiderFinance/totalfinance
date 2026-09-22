/**
 * `@insiderfinance/totalfinance/backtest/options` — the chain-driven options-strategy backtester (roadmap §1.2).
 *
 * Run a rules-based options strategy over a time series of historical option chains and get an
 * equity curve, per-trade + per-leg P&L attribution, assignment events, and an options tear sheet.
 * Composes `@insiderfinance/totalfinance/strategy` (structures + marking), `@insiderfinance/totalfinance/options` (pricing), and
 * `@insiderfinance/totalfinance/risk` (margin) — no re-implemented option math. See `docs/specs/options-backtest.md`.
 *
 *   import { optionsBacktest, optionsTearSheet } from '@insiderfinance/totalfinance/backtest/options';
 *
 *   const result = optionsBacktest({
 *     chains,
 *     entry: { daysToExpiry: { target: 45, min: 30, max: 60 }, structure: 'bullPutSpread',
 *              select: { shortDelta: 0.3, width: 5 } },
 *     exit: { profitTarget: 0.5, daysToExpiry: 21 },
 *   });
 *   const sheet = optionsTearSheet(result);
 */

export { OPTIONS_BOOK_CEILING, optionsBacktest, requireOptionsBacktestConfig } from './engine.js';
export { optionsTearSheet } from './tearsheet.js';
export type {
  OptionsTearSheet,
  OptionsTradeStatistics,
  StructureAttribution,
  LegRoleAttribution,
  GreekAttribution,
} from './tearsheet.js';
export type {
  ChainSnapshot,
  DaysToExpiryTarget,
  EntryWhen,
  EntryContext,
  Sizing,
  EntryRule,
  EntryStructure,
  ExitContext,
  ExitRule,
  RollRule,
  DeltaHedgeRule,
  MarkingPolicy,
  AppliedMarkingPolicy,
  MarkSource,
  MissingMarkCause,
  TradeMarkCounts,
  OptionsBacktestConfig,
  ExitReason,
  LegAttribution,
  TradePnlExplain,
  OptionsTrade,
  OptionsBacktestAssumptions,
  OptionsBacktestResult,
  OptionsBacktestDiagnostics,
  OpenTradeView,
  MultiExpirySelection,
  MultiExpiryStructure,
  BookPolicy,
  PortfolioLimits,
  FillPolicy,
  QuoteFreshnessPolicy,
  DividendRecord,
  TradeLineage,
  UnfilledLeg,
  LimitRejection,
  FillRejection,
  DividendRiskRow,
  SurfaceRow,
} from './types.js';
