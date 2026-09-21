/**
 * `@totalfinance/backtest/execution` — pluggable execution reality (Stage 4.6, FC8 Decision 7).
 *
 * - {@link execution} — `simplified()` (the honest default; its label says exactly what it does)
 *   and `declared()` (every member the caller states, validated, under a label the caller signs).
 * - {@link fillModels} — the built-in bar, quote, and order-book fill models; {@link barTriggerPrice}
 *   is the bar touch rule the shipped `SimulatedBroker` applies, exported so the two never drift.
 * - {@link orderTouchSequence} — the four intrabar ambiguity policies over one bar's touches.
 * - {@link spreadModels}, {@link impactModels}, {@link latencyModels} and the re-exported
 *   {@link fees}, {@link slippage}, {@link borrow} — small named cost models.
 * - {@link requiredInitialMargin}, {@link maintenanceMarginBreached}, and the closed guards
 *   {@link requireOrderIntent}, {@link requireFillDecision}, {@link requireMarketObservation},
 *   {@link requireFillContext}, {@link requireExecutionPolicy}, {@link requireMarginPolicy}.
 * - {@link assertFillModelConformance} — what a custom fill model must satisfy.
 * - {@link normalizedFillFromDecision} — a filled decision → the portfolio-owned `NormalizedFill`.
 * - {@link describeExecutionPolicy} — the JSON-safe projection every result echoes.
 *
 * Nothing here computes a P&L, a position, or a mark; those are the ledger's and the engines'.
 */

export {
  borrow,
  describeExecutionPolicy,
  execution,
  fees,
  impactModels,
  latencyModels,
  maintenanceMarginBreached,
  requiredInitialMargin,
  slippage,
  spreadModels,
} from './policy.js';
export {
  requireExecutionPolicy,
  requireFillContext,
  requireFillDecision,
  requireMarginPolicy,
  requireMarketObservation,
  requireOrderIntent,
} from './validate.js';
export type { DeclaredExecutionPolicy } from './policy.js';
export { barTriggerPrice, fillModels } from './fill-models.js';
export { orderTouchSequence } from './intrabar.js';
export type {
  IntrabarPath,
  IntrabarTouch,
  OrderTouchSequenceInput,
  OrderTouchSequenceResult,
} from './intrabar.js';
export { assertFillModelConformance } from './conformance.js';
export type {
  AssertFillModelConformanceInput,
  FillModelConformanceResult,
  FillModelFixture,
} from './conformance.js';
export { normalizedFillFromDecision, normalizedFillsFromBacktest } from './normalized.js';
export { fillOrderWithPolicy } from './fill-order.js';
export type { FillOrderWithPolicyInput, FillOrderWithPolicyResult } from './fill-order.js';
export type {
  NormalizedFillFromDecisionInput,
  NormalizedFillsFromBacktestInput,
} from './normalized.js';
export type {
  AmbiguityPolicy,
  ExecutionCosts,
  OrderType,
  ExecutionPolicy,
  ExecutionPolicyDescription,
  TimeInForce,
  FillContext,
  FillDecision,
  FillModel,
  FillRequest,
  ForcedLiquidationPolicy,
  HaltWindow,
  LatencyModel,
  LockedCrossedPolicy,
  MarginPolicy,
  MarketImpactModel,
  MarketObservation,
  MarketObservationKind,
  OrderIntent,
  OrderSide,
  PartialFillPolicy,
  PriceLimitWindow,
  QueueModel,
  SessionRules,
  SpreadModel,
  StaleQuotePolicy,
  UnfilledReason,
} from './types.js';
