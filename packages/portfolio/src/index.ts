/**
 * `@totalfinance/portfolio` — durable portfolio management (FC7, Stage 4.4): the event-derived,
 * browser-safe economic-state package decided in
 * `docs/agent-native-portfolio-and-trading-platform.md` (D5).
 *
 * Portfolio truth is a FOLD over immutable economic events; P&L is a derived report; the ledger
 * artifact serializes THROUGH the Gate B artifact spine and restores by replay. The obvious first
 * calls:
 *
 * - {@link applyPortfolioEvents} — the direct pure reducer (events → state);
 * - {@link createPortfolioLedger} — the immutable reusable artifact (`.apply`, `.toJSON`,
 *   {@link readPortfolioLedgerSnapshot}, {@link portfolioLedgerContentHash});
 * - {@link portfolioSnapshot} — explicit market/as-of valuation (NAV, settled/unsettled cash,
 *   unrealized P&L);
 * - {@link portfolioPerformanceInputs} — the exact flow/mark series `@totalfinance/performance`'s
 *   FC4 calls consume (the ledger FEEDS TWR/MWR, never re-implements them).
 *
 * `analyzeBook` in `@totalfinance/risk` remains the independent one-off book calculation; nothing
 * here is required for direct calculations (Permanent law 10).
 */

export {
  NORMALIZED_FILL_KEYS,
  PORTFOLIO_EVENT_SCHEMA_VERSION,
  duplicateBoundaryKey,
  portfolioEventContentHash,
  portfolioEventsFromFill,
  requireNormalizedFill,
  requirePortfolioEventEnvelope,
} from './events.js';
export type {
  AdminAccountMigrationEvent,
  NormalizedFill,
  NormalizedFillCosts,
  NormalizedFillLiquidity,
  PortfolioEventsFromFillInput,
  AdminCorrectionEvent,
  AdminReversalEvent,
  CashConversionEvent,
  CashDepositEvent,
  CashTransferEvent,
  CashWithdrawalEvent,
  CostChargeEvent,
  CostType,
  EconomicPortfolioEvent,
  FinancingChargeEvent,
  FinancingType,
  IncomeReceivedEvent,
  IncomeType,
  PortfolioEvent,
  PortfolioEventEnvelope,
  PortfolioEventType,
  StockSplitEvent,
  TradeFillEvent,
  TradeFillLotSelection,
  CashInLieuEvent,
  ContractMultiplierChangeEvent,
  DerivativeContractTerms,
  DerivativeRollEvent,
  DerivativeSettlement,
  FixedIncomeRedemptionEvent,
  FutureContractTerms,
  MergerEvent,
  OptionAssignmentEvent,
  OptionContractTerms,
  OptionExerciseEvent,
  OptionExpirationEvent,
  PerpetualContractTerms,
  PositionTransferEvent,
  PremiumTreatment,
  RedemptionType,
  ReturnOfCapitalEvent,
  SettlementStyle,
  SpinOffEvent,
  SymbolChangeEvent,
  VariationMarginEvent,
} from './events.js';

export { PORTFOLIO_STATE_SCHEMA_VERSION, applyPortfolioEvents } from './state.js';
export type {
  AccountMigrationMarker,
  AccountState,
  ApplyPortfolioEventsInput,
  FillEffect,
  CashBalance,
  LotReliefPolicy,
  PortfolioDefinition,
  PortfolioState,
  PositionState,
  ScheduledSettlement,
  TaxLot,
} from './state.js';

export {
  PORTFOLIO_LEDGER_KIND,
  PORTFOLIO_LEDGER_SCHEMA_VERSION,
  createPortfolioLedger,
  isPortfolioLedgerSnapshot,
  portfolioLedgerContentHash,
  readPortfolioLedgerSnapshot,
} from './ledger.js';
export type {
  CreatePortfolioLedgerInput,
  PortfolioLedger,
  PortfolioLedgerSnapshot,
  ReadPortfolioLedgerSnapshotInput,
} from './ledger.js';

export { portfolioSnapshot } from './snapshot.js';
export type {
  PortfolioSnapshotCashRow,
  PortfolioSnapshotInput,
  PortfolioSnapshotPosition,
  PortfolioSnapshotResult,
} from './snapshot.js';

export { portfolioPerformanceInputs } from './performance.js';
export { portfolioPnl } from './pnl.js';
export type {
  InstrumentClassification,
  PortfolioGroupingDimension,
  PortfolioPnlComponents,
  PortfolioPnlCurrencyRow,
  PortfolioPnlGroupRow,
  PortfolioPnlGrouping,
  PortfolioPnlInput,
  PortfolioPnlResult,
} from './pnl.js';
export { portfolioTimeline } from './timeline.js';
export type {
  PortfolioExposure,
  PortfolioExposureGroupRow,
  PortfolioExposureGrouping,
  PortfolioTimelineInput,
  PortfolioTimelineResult,
  PortfolioTimelineRow,
} from './timeline.js';
export type {
  PortfolioPerformanceInputsInput,
  PortfolioPerformanceInputsResult,
  PortfolioValuationMark,
} from './performance.js';

export type { CurrencyPairQuote } from './internal.js';

export { reconcilePortfolio } from './reconciliation.js';
export type {
  CashDifference,
  ExternalAccountSnapshot,
  ExternalCashBalance,
  ExternalPortfolioSnapshot,
  ExternalPosition,
  PositionDifference,
  PositionDifferenceKind,
  ReconcilePortfolioInput,
  ReconcilePortfolioResult,
  ReconciliationAccountReport,
  ReconciliationExplanation,
  ReconciliationTolerance,
} from './reconciliation.js';

export {
  MODEL_PORTFOLIO_KIND,
  MODEL_PORTFOLIO_SCHEMA_VERSION,
  createModelPortfolio,
  isModelPortfolio,
  resolveModelTargets,
} from './policy.js';
export type {
  AllocationTarget,
  BenchmarkConstituent,
  BenchmarkIdentity,
  ContributionHandling,
  ExpandedTargets,
  GlidePath,
  GlidePathPoint,
  GroupTarget,
  GroupWeightLimit,
  IncomeReinvestment,
  InstrumentTarget,
  InvestmentPolicy,
  LiabilityEntry,
  LiabilitySchedule,
  ModelPortfolio,
  ModelPortfolioDefinition,
  ModelSleeve,
  PolicyLimits,
  ResolveModelTargetsInput,
  ResolvedTargetSource,
  ResolvedTargets,
  SleeveMember,
  TargetGroup,
  TargetGroupKey,
  TargetSet,
  UnresolvedTarget,
  WithdrawalHandling,
  WithinGroupAllocation,
} from './policy.js';

export {
  MONITOR_ALERT_FAMILIES,
  MONITOR_LIQUIDITY_PARTICIPATION_RATE,
  PORTFOLIO_MONITOR_STATE_SCHEMA_VERSION,
  monitorPortfolio,
} from './policy.js';
export type {
  MonitorAlert,
  MonitorAlertDirection,
  MonitorAlertFamily,
  MonitorAlertSeverity,
  MonitorAlertState,
  MonitorDeferredFamily,
  MonitorFamilyEvaluation,
  MonitorHysteresis,
  MonitorPortfolioInput,
  MonitorPortfolioResult,
  MonitorRule,
  MonitorRuleState,
  MonitorThresholdSource,
  PortfolioMonitorState,
  ResolvedMonitorRule,
} from './policy.js';

export {
  TRADE_PLAN_KIND,
  TRADE_PLAN_SCHEMA_VERSION,
  allocatePortfolio,
  proposePortfolioRebalance,
} from './policy.js';
export type {
  AllocatePortfolioInput,
  AllocatePortfolioResult,
  AllocationCash,
  AllocationDustRow,
  AllocationPrice,
  AllocationRow,
  AllocationSizing,
  AllocationSizingInput,
  AllocationTrade,
  AllocationTransactionCosts,
  TradeCostEstimate,
  ExternalFlow,
  ProposePortfolioRebalanceInput,
  ProposePortfolioRebalanceResult,
  RebalanceCashSummary,
  RebalanceCashWeight,
  RebalanceDustSummary,
  RebalanceEstimates,
  RebalanceGroupWeight,
  RebalanceInstrumentWeight,
  RebalanceLotPreview,
  RebalanceLotSelection,
  RebalanceObjectivePoint,
  RebalanceRiskPoint,
  RebalanceScope,
  RebalanceTrade,
  RebalanceTradeReason,
  TradePlanArtifact,
  TradePlanTrade,
  UnresolvedConstraint,
  UnresolvedConstraintStatus,
} from './policy.js';

// Stage 7B.2 (AT5) — the safe trade lifecycle's pure compute; its grammar lives on `./trade`.
export {
  applyJournalEvents,
  createAuthorizationGrant,
  mergeTradePolicies,
  normalizeTradePlan,
  preflightTradePlan,
  reconcileExecution,
  verifyAuthorizationGrant,
} from './trade/index.js';
// B6 — one order vocabulary (core's names), re-exported so a portfolio caller needs one import.
export type { OrderSide, OrderType, TimeInForce } from '@totalfinance/core';
export type {
  ApplyJournalEventsInput,
  ApplyJournalEventsResult,
  AuthorizationGrant,
  CreateAuthorizationGrantInput,
  ExecutionJournalEvent,
  ExecutionJournalState,
  ExecutionOrderState,
  ExecutionPlan,
  GrantVerification,
  PolicyCheck,
  PolicyDecision,
  PreflightReport,
  ReconcileExecutionInput,
  ReconciliationReport,
  TradeIntent,
  TradeOrder,
  TradePolicy,
  VerifyAuthorizationGrantInput,
} from './trade/index.js';
