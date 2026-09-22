/**
 * `@insiderfinance/totalfinance/portfolio/trade` — the safe trade lifecycle's pure compute (Stage 7B.2, AT5): the
 * intent and the execution plan it normalizes to, the structured policy, and the preflight that
 * values the portfolio before and after through the ledger's own fold and judges it through the
 * monitor; the authorization grant, the execution journal, and reconciliation (slice 2).
 */
export { normalizeTradePlan, referencePriceOf } from './plan.js';
export { decideFromChecks, mergeTradePolicies } from './policy.js';
export { preflightTradePlan } from './preflight.js';
export {
  TRADE_PLAN_ORDER_CEILING,
  requireExecutionPlan,
  requirePreflightCostRates,
  requirePreflightInstrument,
  requireTradeIntent,
  requireTradeOrder,
  requireTradePolicy,
} from './validate.js';
export {
  EXECUTION_PLAN_KIND,
  EXECUTION_PLAN_SCHEMA_VERSION,
  PREFLIGHT_REPORT_KIND,
  PREFLIGHT_REPORT_SCHEMA_VERSION,
  TRADE_INTENT_KIND,
  TRADE_INTENT_SCHEMA_VERSION,
} from './types.js';
export type {
  ExecutionPlan,
  ExecutionPlanSource,
  MergeTradePoliciesInput,
  NormalizeTradePlanInput,
  PolicyCheck,
  PolicyCheckVerdict,
  PolicyDecision,
  PreflightCostRates,
  PreflightEstimates,
  PreflightInstrument,
  PreflightReport,
  PreflightSession,
  PreflightTradePlanInput,
  TradeIntent,
  TradeIntentCombo,
  TradeIntentOrder,
  TradeOrder,
  TradePolicy,
  ExecutionPlanCombo,
} from './types.js';
// B6 — one order vocabulary: the names are core's; this package re-exports them for its callers.
export type { OrderSide, OrderType, TimeInForce } from '@totalfinance/core';
export {
  createAuthorizationGrant,
  verifyAuthorizationGrant,
  GRANT_IDEMPOTENCY_KEY_CEILING,
} from './grant.js';
export {
  applyJournalEvents,
  journalOrderStates,
  EXECUTION_JOURNAL_EVENT_CEILING,
} from './journal.js';
export { reconcileExecution } from './reconcile.js';
export {
  requireAuthorizationGrant,
  requireGrantVariance,
  requireExecutionJournalEvent,
  requireExecutionJournalState,
  requireExecutionOrderState,
  requirePreflightReport,
} from './validate.js';
export {
  AUTHORIZATION_GRANT_KIND,
  AUTHORIZATION_GRANT_SCHEMA_VERSION,
  EXECUTION_JOURNAL_EVENT_TYPES,
  RECONCILIATION_REPORT_KIND,
  RECONCILIATION_REPORT_SCHEMA_VERSION,
} from './types.js';
export type {
  ApplyJournalEventsInput,
  ApplyJournalEventsResult,
  AuthorizationGrant,
  CreateAuthorizationGrantInput,
  ExecutionJournalDetail,
  ExecutionJournalEvent,
  ExecutionJournalEventType,
  ExecutionJournalState,
  ExecutionOrderState,
  ExecutionOrderStatus,
  GrantRefusal,
  GrantRefusalReason,
  GrantVariance,
  GrantVerification,
  ReconcileExecutionInput,
  ReconciliationFillMatch,
  ReconciliationOrderCheck,
  ReconciliationReport,
  VerifyAuthorizationGrantInput,
} from './types.js';
