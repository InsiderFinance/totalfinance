/**
 * `@totalfinance/portfolio/policy` — the portfolio-side management surface (FC7 slice 4, Stage 4.4):
 * an explicit, user-supplied investment policy over the event-derived ledger.
 *
 * - {@link createModelPortfolio} — an immutable, content-addressed strategic/tactical/glide-path
 *   target artifact with hierarchical sleeves; {@link resolveModelTargets} shows which targets a
 *   model makes effective at an instant;
 * - {@link allocatePortfolio} — target weights to executable quantities with lot sizes, minimum
 *   notionals, a cash reserve, transaction-cost estimates, and dust reporting;
 * - {@link proposePortfolioRebalance} — a pure, contribution/withdrawal-aware proposal that never
 *   executes; every hard constraint is satisfied or explicitly reported;
 * - {@link monitorPortfolio} — a pure state transition returning typed alerts with evidence.
 *
 * Missing goals never become secret defaults (agent-native doc, "Investment policy").
 */

export {
  MODEL_PORTFOLIO_KIND,
  MODEL_PORTFOLIO_SCHEMA_VERSION,
  createModelPortfolio,
  isModelPortfolio,
  resolveModelTargets,
} from './policy-grammar.js';
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
} from './policy-grammar.js';

export {
  MONITOR_ALERT_FAMILIES,
  MONITOR_LIQUIDITY_PARTICIPATION_RATE,
  PORTFOLIO_MONITOR_STATE_SCHEMA_VERSION,
  monitorPortfolio,
} from './monitor.js';
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
} from './monitor.js';

export { allocatePortfolio } from './allocation.js';
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
} from './allocation.js';
export {
  TRADE_PLAN_KIND,
  TRADE_PLAN_SCHEMA_VERSION,
  proposePortfolioRebalance,
} from './rebalance.js';
export type {
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
} from './rebalance.js';
