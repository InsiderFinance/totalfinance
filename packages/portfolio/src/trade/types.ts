/**
 * `@totalfinance/portfolio/trade` — the safe trade lifecycle's grammar (Stage 7B.2, AT5). Every stage
 * is an explicit, content-addressed artifact: an intent, the execution plan it normalizes to, the
 * preflight report with its structured policy decision, the authorization grant, the execution
 * journal, the receipt, and the reconciliation report. The compute here is pure and credential-free.
 */
import type {
  EpochMs,
  OrderSide,
  OrderType,
  Provenance,
  QuantWarning,
  TimeInForce,
} from '@totalfinance/core';
import type { MarketSnapshot } from '@totalfinance/core/artifacts';
import type { NormalizedFill, PortfolioEventEnvelope } from '../events.js';
import type { DerivativeContractTerms, SettlementStyle } from '../events.js';
import type { CurrencyPairQuote } from '../internal.js';
import type { PolicyLimits } from '../policy-grammar.js';
import type { TradePlanArtifact, TradePlanTrade } from '../rebalance.js';
import type {
  ExternalPortfolioSnapshot,
  ReconcilePortfolioResult,
  ReconciliationTolerance,
} from '../reconciliation.js';
import type { PortfolioSnapshotResult } from '../snapshot.js';
import type { PortfolioState } from '../state.js';
import type { MonitorAlert, PortfolioMonitorState } from '../monitor.js';

// B6 — one order vocabulary: `OrderSide`, `OrderType` and `TimeInForce` are core's, re-exported here.

/** One executable order — field for field the execution grammar every engine and the paper broker fill. */
export interface TradeOrder {
  orderId: string;
  instrumentId: string;
  side: OrderSide;
  quantity: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  /** The plan's instant — when the order was planned, never when it reached a broker. */
  plannedTimestampMs: EpochMs;
  /** Stamped by the broker at submission; absent on a plan's order. A fill never consumes an observation older than it. */
  submittedTimestampMs?: EpochMs;
  /** The multi-leg order this is a leg of (B5); the plan's `combos` names the legs and the net limit. */
  comboId?: string;
}

/** One line of an intent: a quantity, or a notional weight of NAV the normalization sizes at the mark. */
export interface TradeIntentOrder {
  instrumentId: string;
  side: OrderSide;
  quantity?: number;
  /** Size the order so its notional is this fraction of NAV at the mark, (0, 1]; mutually exclusive with `quantity`. */
  notionalWeight?: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  /** The multi-leg order this line is a leg of; at least two lines share a combo id. */
  comboId?: string;
}

/** A combo's terms on an intent: the net limit its legs must meet together. */
export interface TradeIntentCombo {
  comboId: string;
  /**
   * Net price limit per combo unit: a net debit is positive (pay at most), a net credit negative
   * (receive at least the magnitude). A combo unit is the legs' quantities divided by their greatest
   * common divisor for integer quantities, or by the smallest leg quantity otherwise — a 10-lot
   * 1×1 vertical is ten units. Allowed quantity scaling preserves these authorized economics;
   * the broker translates the quote if the submitted unit size changes. Absent: each leg fills
   * at its own price.
   */
  netLimitPrice?: number;
}

/** A multi-leg order on a plan: one order to the broker, filled all-or-none against one observation. */
export interface ExecutionPlanCombo {
  comboId: string;
  /** The leg order ids, in plan order (at least two). */
  orderIds: string[];
  /** See {@link TradeIntentCombo.netLimitPrice}. */
  netLimitPrice?: number;
}

export const TRADE_INTENT_KIND = 'totalfinance.trade-intent';
export const TRADE_INTENT_SCHEMA_VERSION = 1;

/** The desired economic action, without a broker payload or a credential (law 5). */
export interface TradeIntent {
  kind: typeof TRADE_INTENT_KIND;
  schemaVersion: number;
  accountId: string;
  asOf: EpochMs;
  orders: TradeIntentOrder[];
  /** The combos the lines' `comboId`s name, when a net limit is wanted; a combo without terms needs no entry. */
  combos?: TradeIntentCombo[];
  /** Metadata: recorded, never read by any stage. */
  rationale?: string;
  /** Artifact ids the intent rests on. */
  evidence?: string[];
}

export const EXECUTION_PLAN_KIND = 'totalfinance.execution-plan';
export const EXECUTION_PLAN_SCHEMA_VERSION = 1;

export type ExecutionPlanSource =
  | { kind: 'intent'; intentHash: string }
  | { kind: 'rebalance-proposal'; planHash: string; policyContentHash: string };

/** The normalized, content-addressed plan every later stage binds to — the actionable boundary. */
export interface ExecutionPlan {
  kind: typeof EXECUTION_PLAN_KIND;
  schemaVersion: number;
  accountId: string;
  asOf: EpochMs;
  baseCurrency: string;
  portfolioId?: string;
  orders: TradeOrder[];
  /** Every multi-leg order, each with at least two legs; empty when every order stands alone. */
  combos: ExecutionPlanCombo[];
  /** The FC7 rows — reference prices and estimated notional per trade — for estimates and comparison. */
  trades: TradePlanTrade[];
  source: ExecutionPlanSource;
  rationale?: string;
  evidence: string[];
  contentHash: string;
}

/** What preflight and the paper broker need to know about an instrument the ledger may not hold yet. */
export interface PreflightInstrument {
  currency: string;
  contractMultiplier?: number;
  contract?: DerivativeContractTerms;
  assetClass?: string;
}

export type PolicyCheckVerdict = 'pass' | 'fail' | 'unverifiable' | 'require-approval';

export interface PolicyCheck {
  name: string;
  verdict: PolicyCheckVerdict;
  value: number | string | null;
  limit: number | string | null;
  detail: string;
}

export type PolicyDecision =
  | { verdict: 'allow'; checks: PolicyCheck[] }
  | { verdict: 'deny'; checks: PolicyCheck[] }
  | { verdict: 'require-approval'; checks: PolicyCheck[]; requiredScope: string };

/** A closed, deterministic policy over a plan: FC7's limits verbatim plus the order-level bounds. */
export interface TradePolicy {
  /** The only mode this stage accepts; `'live'` is a typed refusal naming AT8. */
  mode: 'paper';
  limits?: PolicyLimits;
  allowedAccounts?: string[];
  allowedAssetClasses?: string[];
  allowedInstruments?: string[];
  allowedOrderTypes?: OrderType[];
  maximumOrderQuantity?: number;
  maximumOrderNotional?: number;
  /** Base currency, the plan's total estimated commission + spread + slippage. */
  maximumEstimatedCost?: number;
  maximumSlippageBps?: number;
  maximumParticipation?: number;
  /** Default false: a plan that leaves an option net short (a call uncovered) is denied. */
  allowUndefinedRiskOptions?: boolean;
  marketMaximumAgeMs?: number;
  /** Traded notional ÷ NAV before the plan. */
  maximumTurnover?: number;
  /** Above either bound the decision is `require-approval` rather than `allow`. */
  requireApprovalAbove?: { notional?: number; quantity?: number };
  /** What an unverifiable check does to the decision (default `'require-approval'`). */
  onUnverifiable?: 'require-approval' | 'deny';
}

/** Declared cost rates preflight estimates with (the execution policy's own models live in the broker). */
export interface PreflightCostRates {
  commissionBps?: number;
  commissionPerOrder?: number;
  spreadBps?: number;
  slippageBps?: number;
}

export interface PreflightSession {
  open: boolean;
  /** Instrument ids halted at the instant. */
  halted?: string[];
}

export interface PreflightTradePlanInput {
  plan: ExecutionPlan;
  portfolio: PortfolioState;
  market: MarketSnapshot;
  asOf: EpochMs | string;
  policy: TradePolicy;
  instruments?: Record<string, PreflightInstrument>;
  currencyConversions?: CurrencyPairQuote[];
  /** Orders already open in the journal; a plan that repeats one is a conflict. */
  openOrders?: TradeOrder[];
  costs?: PreflightCostRates;
  averageDailyVolumes?: Record<string, number>;
  session?: PreflightSession;
  /** The monitor state carried from the previous evaluation, when the caller keeps one. */
  monitorState?: PortfolioMonitorState | null;
}

export interface PreflightEstimates {
  tradedNotional: number;
  commission: number;
  spread: number;
  slippage: number;
  totalCost: number;
  turnover: number;
}

export const PREFLIGHT_REPORT_KIND = 'totalfinance.preflight-report';
export const PREFLIGHT_REPORT_SCHEMA_VERSION = 1;

export interface PreflightReport {
  kind: typeof PREFLIGHT_REPORT_KIND;
  schemaVersion: number;
  asOf: EpochMs;
  planHash: string;
  portfolioHash: string;
  marketHash: string;
  marketAsOf: EpochMs;
  before: PortfolioSnapshotResult;
  after: PortfolioSnapshotResult;
  /** The hypothetical fills the after-state was folded from. */
  hypotheticalFills: NormalizedFill[];
  hypotheticalEvents: PortfolioEventEnvelope[];
  estimates: PreflightEstimates;
  checks: PolicyCheck[];
  alerts: MonitorAlert[];
  decision: PolicyDecision;
  unverifiable: string[];
  monitorState: PortfolioMonitorState | null;
  assumptions: {
    conventionsVersion: string;
    policyContentHash: string;
    mode: 'paper';
    costRates: Required<PreflightCostRates>;
    fillConvention: string;
    /** Where each instrument's currency and multiplier came from: the ledger position, the caller's description, or the market spot (priced as a plain cash instrument). */
    instrumentSources: Record<string, string>;
    decisionConvention: string;
  };
  diagnostics: {
    engine: 'trade-preflight';
    method: 'hypothetical-fold';
    converged: true;
    warnings: QuantWarning[];
    checkCount: number;
    failedCount: number;
    unverifiableCount: number;
  };
  contentHash: string;
}

export interface NormalizeTradePlanInput {
  intent?: TradeIntent;
  proposal?: TradePlanArtifact;
  portfolio: PortfolioState;
  market: MarketSnapshot;
  asOf: EpochMs | string;
  accountId?: string;
  instruments?: Record<string, PreflightInstrument>;
  currencyConversions?: CurrencyPairQuote[];
  rationale?: string;
  evidence?: string[];
}

/** The stricter of two policies: the minimum of every bound, the intersection of every allow list. */
export type MergeTradePoliciesInput = { policies: readonly TradePolicy[] };

// ---------------------------------------------------------------------------------------------------
// Slice 2 — the authorization grant (Decision 5)
// ---------------------------------------------------------------------------------------------------

export const AUTHORIZATION_GRANT_KIND = 'totalfinance.authorization-grant';
export const AUTHORIZATION_GRANT_SCHEMA_VERSION = 1;

/** How far an executed order may drift from the authorized plan before the grant refuses it. */
export interface GrantVariance {
  /** `|executed quantity / authorized quantity − 1|` at most this (0 = exactly the plan). */
  maximumQuantityRatio: number;
  /** `|executed notional / authorized notional − 1|` at most this, at the plan's reference prices. */
  maximumNotionalRatio: number;
  /** A limit price may sit at most this many bps from the plan's reference price. */
  maximumSlippageBps: number;
}

/** Human authority bound to one plan, one preflight, and the snapshots they were judged against. */
export interface AuthorizationGrant {
  kind: typeof AUTHORIZATION_GRANT_KIND;
  schemaVersion: typeof AUTHORIZATION_GRANT_SCHEMA_VERSION;
  grantId: string;
  planHash: string;
  preflightHash: string;
  portfolioHash: string;
  marketHash: string;
  /** The market instant the preflight judged; execution must not see an older market. */
  marketAsOf: EpochMs;
  /** At execution the market may be at most this old (`now − marketAsOf`). */
  marketMaximumAgeMs: number;
  mode: 'paper';
  accountId: string;
  baseCurrency: string;
  /** The plan's order ids, in plan order. */
  orderIds: string[];
  /** The plan's combo ids, in plan order — a grant binds the multi-leg structure, not only the legs. */
  comboIds: string[];
  variance: GrantVariance;
  issuedAt: EpochMs;
  expiresAt: EpochMs;
  approvedBy: string;
  /** The scope the preflight asked for (`require-approval`), or null when it allowed outright. */
  requiredScope: string | null;
  /** The closed set of submission keys this grant licenses — one per attempt. */
  idempotencyKeys: string[];
  contentHash: string;
}

export interface CreateAuthorizationGrantInput {
  plan: ExecutionPlan;
  preflight: PreflightReport;
  /** Defaults to the preflight's; given, it must match (a grant binds what preflight saw). */
  portfolioHash?: string;
  /** Defaults to the preflight's; given, it must match. */
  marketHash?: string;
  marketMaximumAgeMs: number;
  mode: 'paper';
  /** Defaults to the plan's account; given, it must match. */
  account?: string;
  variance: GrantVariance;
  expiresAt: EpochMs;
  approvedBy: string;
  idempotencyKeys: string[] | { prefix: string; count: number };
  /** The issue instant — supplied, never read from a clock. */
  now: EpochMs;
  /** Default `grant:<plan hash prefix>:<now>`. */
  grantId?: string;
}

export type GrantRefusalReason =
  | 'expired'
  | 'premature'
  | 'plan-hash-mismatch'
  | 'portfolio-hash-mismatch'
  | 'market-hash-mismatch'
  | 'market-stale'
  | 'mode-mismatch'
  | 'account-mismatch'
  | 'idempotency-key-unknown'
  | 'order-unknown'
  | 'order-mismatch'
  | 'combo-mismatch'
  | 'quantity-variance'
  | 'notional-variance'
  | 'slippage-variance';

export interface GrantRefusal {
  reason: GrantRefusalReason;
  detail: string;
  orderId?: string;
}

export interface VerifyAuthorizationGrantInput {
  grant: AuthorizationGrant;
  plan: ExecutionPlan;
  now: EpochMs;
  /** The portfolio's content hash at execution. */
  portfolioHash: string;
  /** The market snapshot's content hash at execution. */
  marketHash: string;
  /** The market snapshot's instant at execution. */
  marketAsOf: EpochMs;
  /** Default `'paper'`. */
  mode?: 'paper';
  /** The submission's key; must be one the grant licenses. */
  idempotencyKey: string;
  /**
   * The orders about to be submitted when they differ from the plan's (a re-priced limit, a resized
   * quantity), judged against the grant's variance envelope. Default: the plan's orders.
   */
  orders?: readonly TradeOrder[];
}

export interface GrantVerification {
  valid: boolean;
  /** Every failed binding, never only the first. */
  reasons: GrantRefusal[];
  grantHash: string;
  planHash: string;
  checkedAt: EpochMs;
  assumptions: {
    conventionsVersion: string;
    mode: 'paper';
    /** The market instant and age the verification judged. */
    marketAsOf: EpochMs;
    marketAgeMs: number;
    marketMaximumAgeMs: number;
    /** Whether the orders judged for variance were the plan's own (no variance) or supplied. */
    ordersJudged: 'plan' | 'supplied';
    bindingConvention: string;
  };
  diagnostics: {
    engine: 'grant-verification';
    warnings: string[];
    bindingCount: number;
    reasonCount: number;
    orderCount: number;
  };
}

// ---------------------------------------------------------------------------------------------------
// Slice 2 — the execution journal (Decision 6)
// ---------------------------------------------------------------------------------------------------

export const EXECUTION_JOURNAL_EVENT_TYPES = [
  'proposed',
  'preflighted',
  'authorized',
  'submitted',
  'acknowledged',
  'partially-filled',
  'filled',
  'rejected',
  'cancel-requested',
  'cancelled',
  'replaced',
  'expired',
  'reconciled',
  'unresolved',
] as const;
export type ExecutionJournalEventType = (typeof EXECUTION_JOURNAL_EVENT_TYPES)[number];

export type ExecutionOrderStatus =
  | 'submitted'
  | 'acknowledged'
  | 'partially-filled'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  | 'unresolved';

/** The closed detail record; which fields matter depends on the event type (see `applyJournalEvents`). */
export interface ExecutionJournalDetail {
  /** `submitted`: the submitted quantity; `partially-filled` / `filled`: the fill's quantity. */
  quantity?: number;
  /** `partially-filled` / `filled`: the fill id — the ledger's `trade.fill` event id. */
  fillId?: string;
  /** `partially-filled` / `filled`: the fill price, for the average. */
  pricePerUnit?: number;
  /** `rejected` / `cancelled` / `expired` / `unresolved`: why. */
  reason?: string;
  /** `replaced`: the replacing order. */
  replacementOrderId?: string;
  /** `proposed` / `preflighted` / `authorized` / `reconciled`: the artifact's content hash. */
  artifactHash?: string;
  note?: string;
  /** Paper `submitted`: complete intent, with the effective time-in-force made explicit. */
  order?: TradeOrder;
  /** Paper `submitted`: instrument terms captured at submission, never replaced by restart defaults. */
  instrument?: {
    currency: string;
    contractMultiplier?: number;
    settlementStyle?: SettlementStyle;
    contract?: DerivativeContractTerms;
    /** Paper currently measures this lag in 24-hour days, not exchange-calendar sessions. */
    settlementLag?: 0 | 1 | 2;
  };
  /** Paper `submitted`: the account/base-currency binding of the broker. */
  accountId?: string;
  baseCurrency?: string;
  /** Hash of the complete declared policy data and callback labels/versions; not serialized code. */
  executionPolicyHash?: string;
  /** Paper fills: the consumed market observation's instant, preventing retry from consuming it again. */
  observationTimestampMs?: EpochMs;
  /** Paper `submitted`: the combo this order is a leg of (B5), so a restored broker fills it all-or-none. */
  comboId?: string;
  /** Paper `submitted`: the combo's net limit per combo unit, repeated on every leg. */
  netLimitPrice?: number;
  /** The complete accounting fact, including settlement and costs, for durable recovery. */
  fill?: NormalizedFill;
}

export interface ExecutionJournalEvent {
  eventId: string;
  journalId: string;
  timestampMs: EpochMs;
  orderId: string;
  planHash: string;
  idempotencyKey?: string;
  eventType: ExecutionJournalEventType;
  detail: ExecutionJournalDetail;
  sourceId: string;
  provenance: Provenance;
}

export interface ExecutionOrderState {
  orderId: string;
  planHash: string;
  state: ExecutionOrderStatus;
  submittedQuantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  /** Quantity-weighted; null until a priced fill, and null again if any fill came unpriced. */
  averageFillPrice: number | null;
  fillIds: string[];
  /** Fills journaled after the order was closed — the order is `unresolved` while any exist. */
  lateFillIds: string[];
  lastEventId: string;
  lastTimestampMs: EpochMs;
  terminal: boolean;
  cancelRequested: boolean;
  reason: string | null;
  replacedBy: string | null;
  reconciledEventId: string | null;
}

export interface ExecutionJournalState {
  /** Null until the first event. */
  journalId: string | null;
  eventCount: number;
  /** Applied event ids in order (duplicates excluded). */
  eventIds: string[];
  orders: Record<string, ExecutionOrderState>;
  /** Orders journaled only before submission: the pre-submission event types seen. */
  preSubmission: Record<string, ExecutionJournalEventType[]>;
  /** Every duplicate delivery skipped across folds. */
  duplicateEventIds: string[];
}

export interface ApplyJournalEventsInput {
  events: readonly ExecutionJournalEvent[];
  previousState?: ExecutionJournalState;
}

export interface ApplyJournalEventsResult {
  state: ExecutionJournalState;
  applied: number;
  duplicates: string[];
  lateFills: { orderId: string; fillId: string; eventId: string }[];
  diagnostics: {
    warnings: string[];
    eventCount: number;
    orderCount: number;
    duplicateCount: number;
    lateFillCount: number;
    unresolvedCount: number;
  };
}

// ---------------------------------------------------------------------------------------------------
// Slice 2 — reconciliation (Decision 8)
// ---------------------------------------------------------------------------------------------------

export const RECONCILIATION_REPORT_KIND = 'totalfinance.reconciliation-report';
export const RECONCILIATION_REPORT_SCHEMA_VERSION = 1;

export interface ReconcileExecutionInput {
  /** The journal's events (folded here) or an already-folded state. */
  journal: readonly ExecutionJournalEvent[] | ExecutionJournalState;
  ledger: PortfolioState;
  /** The `sourceId` the execution's fills were folded into the ledger under. */
  sourceId: string;
  /** The execution's fills as delivered. */
  fills: readonly NormalizedFill[];
  external?: ExternalPortfolioSnapshot;
  asOf: EpochMs | string;
  /** Explicit — reconciliation never assumes a tolerance. */
  tolerance: ReconciliationTolerance;
  /** Restrict the judgment to one plan's orders. */
  planHash?: string;
}

export interface ReconciliationFillMatch {
  fillId: string;
  orderId: string | null;
  quantity: number;
  journaled: boolean;
  inLedger: boolean;
  ledgerKey: string;
}

export interface ReconciliationOrderCheck {
  orderId: string;
  state: ExecutionOrderStatus;
  journaledQuantity: number;
  fillQuantity: number;
  /** `fillQuantity − journaledQuantity`. */
  difference: number;
  withinTolerance: boolean;
}

export interface ReconciliationReport {
  kind: typeof RECONCILIATION_REPORT_KIND;
  schemaVersion: typeof RECONCILIATION_REPORT_SCHEMA_VERSION;
  asOf: EpochMs;
  planHash: string | null;
  journalId: string | null;
  sourceId: string;
  reconciled: boolean;
  orders: ExecutionOrderState[];
  orderChecks: ReconciliationOrderCheck[];
  fills: ReconciliationFillMatch[];
  /** Journaled fill ids with no `trade.fill` under the source in the ledger. */
  journaledNotInLedger: string[];
  /** Ledger `trade.fill` ids under the source that no order journaled. */
  ledgerNotJournaled: string[];
  unresolved: { orderId: string; reason: string }[];
  /** `reconcilePortfolio`'s result when an external snapshot was given. */
  portfolio: ReconcilePortfolioResult | null;
  assumptions: {
    conventionsVersion: string;
    tolerance: Required<ReconciliationTolerance>;
    matchConvention: string;
  };
  diagnostics: {
    engine: 'trade-reconciliation';
    warnings: string[];
    orderCount: number;
    openCount: number;
    fillCount: number;
    ledgerFillCount: number;
    unresolvedCount: number;
    differenceCount: number;
  };
  contentHash: string;
}
