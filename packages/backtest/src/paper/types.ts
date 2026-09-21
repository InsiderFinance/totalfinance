/**
 * `@totalfinance/backtest/paper` — the paper broker's types (Stage 7B.2, Decision 7).
 */
import type { EpochMs } from '@totalfinance/core';
import type {
  AuthorizationGrant,
  DerivativeContractTerms,
  ExecutionJournalEvent,
  ExecutionJournalState,
  ExecutionOrderState,
  ExecutionPlan,
  NormalizedFill,
  PortfolioEventEnvelope,
  SettlementStyle,
  TradeOrder,
} from '@totalfinance/portfolio';
import type {
  ExecutionPolicy,
  ExecutionPolicyDescription,
  MarketObservation,
  UnfilledReason,
} from '../execution/types.js';

export const EXECUTION_RECEIPT_KIND = 'totalfinance.execution-receipt';
export const EXECUTION_RECEIPT_SCHEMA_VERSION = 1;

/** What the broker needs to know about an instrument to write a ledger fill for it. */
export interface PaperInstrument {
  currency: string;
  contractMultiplier?: number;
  settlementStyle?: SettlementStyle;
  contract?: DerivativeContractTerms;
  /** Settlement lag in 24-hour days; no exchange calendar is applied. Default 0 = at the fill. */
  settlementLag?: 0 | 1 | 2;
}

export interface CreatePaperBrokerInput {
  /**
   * The declared execution reality; default `execution.simplified()`. Restoring requires the same
   * declared data, callback labels and fill-model version as every submission in the journal.
   * Callbacks cannot serialize: callers must supply the original implementations and change their
   * declared identity when their behavior changes; the broker cannot verify captured closure state.
   */
  execution?: ExecutionPolicy;
  /** The ledger's base currency — prices an instrument `instruments` does not describe. The broker never holds the ledger: the caller applies the events it returns. */
  baseCurrency: string;
  /**
   * Complete prior paper journal, folded at construction. Submitted context and normalized fills
   * are required; incomplete legacy journals fail explicitly and need migration from original facts.
   * Restore, operate and persist must be one caller-owned transaction for concurrent processes.
   * The journal preserves halt's cancellations, NOT the in-memory halt flag. A durable account-wide
   * kill switch requires an external persisted execution gate (including when there are no orders).
   */
  journal?: readonly ExecutionJournalEvent[];
  /** The `sourceId` every journal event and ledger fill carries — `paper:<account>` by convention. */
  sourceId: string;
  accountId: string;
  /** Instrument terms by id for new orders; absent = plain cash in base currency. Restored orders use their persisted terms; conflicting supplied terms are refused. */
  instruments?: Readonly<Record<string, PaperInstrument>>;
}

export interface PaperSubmitInput {
  plan: ExecutionPlan;
  grant: AuthorizationGrant;
  idempotencyKey: string;
  now: EpochMs;
  /** The portfolio's content hash at submission (the grant binds it). */
  portfolioHash: string;
  /** The market snapshot's content hash and instant at submission. */
  marketHash: string;
  marketAsOf: EpochMs;
  /** The orders to submit when they differ from the plan's (judged against the grant's variance). */
  orders?: readonly TradeOrder[];
}

/** The receipt of one submission — the same object for a retry with the same key and plan. */
export interface ExecutionReceipt {
  kind: typeof EXECUTION_RECEIPT_KIND;
  schemaVersion: typeof EXECUTION_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  planHash: string;
  grantHash: string;
  idempotencyKey: string;
  adapter: 'paper';
  accountId: string;
  sourceId: string;
  submittedAt: EpochMs;
  /** The order states as of submission (submitted and acknowledged). */
  orders: ExecutionOrderState[];
  /** Fills known at submission — always empty for the paper broker (fills arrive on `step`). */
  fills: NormalizedFill[];
  journalEventIds: string[];
  assumptions: {
    conventionsVersion: string;
    mode: 'paper';
    execution: ExecutionPolicyDescription;
    idempotencyConvention: string;
  };
  diagnostics: {
    engine: 'paper-broker';
    warnings: string[];
    orderCount: number;
    retried: boolean;
  };
  contentHash: string;
}

export interface PaperStepInput {
  /**
   * The observation each open instrument meets; missing instruments stay open. After a fill, only
   * a strictly newer observation timestamp may fill that order again (including across restarts).
   * Repeating or revising a consumed timestamp cannot consume its liquidity again. An observation
   * older than the order's submission never fills it (B6). Results contain only NEW fills;
   * previously returned accounting facts remain in journal detail.fill for recovery.
   */
  observations: Readonly<Record<string, MarketObservation>>;
  /** Decision time, at or after submission/latest order event and every supplied observation (an
   * already-consumed observation may be retried at its original instant and is a no-op). Day
   * orders expire after 24 hours from acceptance when expireAtSessionClose is enabled; no exchange
   * calendar/session-close lookup is performed by paper. */
  asOf: EpochMs;
}

export interface PaperStepResult {
  asOf: EpochMs;
  fills: NormalizedFill[];
  /** The ledger events for the fills (`portfolioEventsFromFill`) — the caller applies them. */
  events: PortfolioEventEnvelope[];
  journal: ExecutionJournalEvent[];
  expired: string[];
  /**
   * Why an open order did not fill this step. `already-observed`: the observation is not newer than
   * the last one this order consumed. `observation-before-submission` (B6): the observation predates
   * the submission. `combo-leg-unfilled` / `combo-net-limit` (B5): a combo fills all-or-none against
   * one observation instant, and only when its net price per combo unit meets the limit.
   */
  unfilled: {
    orderId: string;
    reason:
      | UnfilledReason
      | 'already-observed'
      | 'observation-before-submission'
      | 'combo-leg-unfilled'
      | 'combo-net-limit';
    detail: string;
  }[];
  /** Orders still open after the step. */
  open: string[];
}

export interface PaperCancelInput {
  orderId: string;
  now: EpochMs;
}

export interface PaperCancelResult {
  orderId: string;
  /** False when the order was already terminal — nothing is journaled, the state says why. */
  accepted: boolean;
  journal: ExecutionJournalEvent[];
  state: ExecutionOrderState;
}

export interface PaperDeliverInput {
  event: ExecutionJournalEvent;
}

export interface PaperDeliverResult {
  /** False for a duplicate delivery (recorded once, reported here). */
  applied: boolean;
  duplicate: boolean;
  lateFill: boolean;
  /** Ledger events for a delivered fill (a late fill reaches the ledger too). */
  events: PortfolioEventEnvelope[];
  fill: NormalizedFill | null;
  state: ExecutionOrderState | null;
}

export interface PaperHaltInput {
  reason: string;
  now: EpochMs;
}

export interface PaperHaltResult {
  halted: true;
  reason: string;
  cancelled: string[];
  journal: ExecutionJournalEvent[];
}

export interface PaperBrokerDescription {
  adapter: 'paper';
  sourceId: string;
  accountId: string;
  journalId: string;
  execution: ExecutionPolicyDescription;
  halted: boolean;
  haltReason: string | null;
  openOrderCount: number;
  eventCount: number;
  receiptCount: number;
}

export interface PaperBroker {
  submit(input: PaperSubmitInput): ExecutionReceipt;
  step(input: PaperStepInput): PaperStepResult;
  cancel(input: PaperCancelInput): PaperCancelResult;
  deliver(input: PaperDeliverInput): PaperDeliverResult;
  halt(input: PaperHaltInput): PaperHaltResult;
  /** Clears this instance's halt only; never reopens the cancelled orders. */
  resume(input: { now: EpochMs }): { halted: false };
  /** The append-only journal so far (a frozen copy). */
  journal(): ExecutionJournalEvent[];
  /** The folded journal state (a frozen copy). */
  state(): ExecutionJournalState;
  /** Open (non-terminal) order states in id order. */
  openOrders(): ExecutionOrderState[];
  /** Every receipt issued, in submission order. */
  receipts(): ExecutionReceipt[];
  describe(): PaperBrokerDescription;
}
