/**
 * Pluggable execution reality (Stage 4.6, FC8 Decision 7) — the vocabulary every simulator in this
 * package consumes. Nothing here computes; these are the closed shapes a fill model reads and
 * writes, and the policy a run declares. No default claims exchange realism: a policy carries a
 * `realism` verdict and a label, and both are echoed into every result's assumptions.
 */

import type {
  Bar,
  EpochMs,
  OrderBook,
  OrderSide,
  OrderType,
  Quote,
  TimeInForce,
  Trade,
} from '@totalfinance/core';
import type { BorrowModel, CostModel, SlippageModel } from '../costs.js';

// ---------------------------------------------------------------------------------------------------
// Orders and observations
// ---------------------------------------------------------------------------------------------------

/**
 * B6 — one order vocabulary: the order types a fill model must decide, the side and the
 * time-in-force are core's. A combo (multi-leg) order is decided leg by leg through the same
 * models (the paper broker fills it all-or-none); it is not a fill-model order type.
 */
export type { OrderSide, OrderType, TimeInForce } from '@totalfinance/core';

/** One order a simulator wants filled — the intent, not the journey. */
export interface OrderIntent {
  orderId: string;
  instrumentId: string;
  side: OrderSide;
  /** Requested quantity, > 0. */
  quantity: number;
  type: OrderType;
  limitPrice?: number;
  stopPrice?: number;
  timeInForce?: TimeInForce;
  submittedTimestampMs: EpochMs;
}

/** What a fill model observes at the decision instant. */
export type MarketObservation =
  | { kind: 'bar'; bar: Bar }
  | { kind: 'quote'; quote: Quote }
  | { kind: 'trade'; trade: Trade }
  | { kind: 'order-book'; book: OrderBook };

export type MarketObservationKind = MarketObservation['kind'];

// ---------------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------------

export type UnfilledReason =
  | 'not-triggered'
  | 'no-observation'
  | 'wrong-observation-kind'
  | 'stale-quote'
  | 'locked-crossed'
  | 'halted'
  | 'zero-quantity'
  | 'insufficient-depth';

export type FillDecision =
  | {
      outcome: 'filled';
      quantity: number;
      pricePerUnit: number;
      /** Which price the fill referenced — `bar.open`, `bar.touch:limit`, `quote.ask`, `book.levels`, … */
      reference: string;
      /** Less than the requested quantity (participation, depth, size caps). */
      partial: boolean;
      /** The fill price was clamped into a session price-limit band. */
      clampedToPriceLimit?: boolean;
      /** Order-book fills: how many levels the quantity consumed. */
      levelsConsumed?: number;
    }
  | { outcome: 'unfilled'; reason: UnfilledReason; detail?: string };

// ---------------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------------

/** No fills for the instrument (or every instrument when `instrumentId` is omitted) in the window. */
export interface HaltWindow {
  instrumentId?: string;
  fromTimestampMs: EpochMs;
  toTimestampMs: EpochMs;
}

/** Fills for the instrument are clamped into `[low, high]` in the window (limit-up / limit-down). */
export interface PriceLimitWindow {
  instrumentId: string;
  fromTimestampMs: EpochMs;
  toTimestampMs: EpochMs;
  low: number;
  high: number;
}

export interface SessionRules {
  halts?: readonly HaltWindow[];
  priceLimits?: readonly PriceLimitWindow[];
  /** How auction-only order types are treated by a model that has no auction: declared, never assumed. */
  auction?: 'ignore' | 'open-close-only';
}

// ---------------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------------

export interface StaleQuotePolicy {
  /** A quote older than this at the decision instant is stale; `null` = never stale. */
  maximumAgeMs: number | null;
  /** `reject` refuses the run (`backtest.stale_quote`); `fill-at-last` fills at the stale quote and reports it. */
  behavior: 'reject' | 'fill-at-last';
}

export type LockedCrossedPolicy = 'reject' | 'fill-at-mid';
export type PartialFillPolicy = 'allow' | 'reject';
export type QueueModel = 'none' | 'depth-approximation';

/** The per-decision context a fill model receives beside the order and the observation. */
export interface FillContext {
  asOf: EpochMs;
  /** Fraction of the observation's volume (or size) one fill may take; omitted = no cap. */
  participation?: number;
  partialFills: PartialFillPolicy;
  staleQuotes: StaleQuotePolicy;
  lockedCrossed: LockedCrossedPolicy;
  sessions?: SessionRules;
  queue: { model: QueueModel };
}

/** What a fill model decides on: one order, one observation, the decision context. */
export interface FillRequest {
  order: OrderIntent;
  observation: MarketObservation;
  context: FillContext;
}

/** A fill model: pure, deterministic, and closed over the observation it declares. */
export interface FillModel {
  readonly label: string;
  readonly version: string;
  readonly observation: MarketObservationKind;
  fill(request: FillRequest): FillDecision;
}

/** Half-spread paid by an aggressor, as a price adjustment per unit (≥ 0). */
export interface SpreadModel {
  readonly label: string;
  halfSpread(input: { referencePrice: number; side: OrderSide }): number;
}

/** Price impact of a quantity as a FRACTION of the reference price (≥ 0), by side. */
export interface MarketImpactModel {
  readonly label: string;
  impact(input: { quantity: number; referencePrice: number; averageDailyVolume?: number }): number;
}

/** The order is worked `sessions` observations after submission (0 = the same observation). */
export interface LatencyModel {
  readonly label: string;
  readonly sessions: number;
}

/** How an intrabar sequence of touches is resolved when the bar alone cannot say. */
export type AmbiguityPolicy = 'optimistic' | 'pessimistic' | 'deterministic-path' | 'reject';

export type ForcedLiquidationPolicy = 'none' | 'close-largest-loss' | 'pro-rata';

export interface MarginPolicy {
  /** Gross notional an account may hold per unit of equity (1 = cash account). */
  buyingPowerMultiplier: number;
  /** Fraction of a new position's notional that must be equity at entry. */
  initialMarginRate: number;
  /** Fraction of gross notional that must remain equity after every fold. */
  maintenanceMarginRate: number;
  forcedLiquidation: ForcedLiquidationPolicy;
}

export interface ExecutionCosts {
  commission: CostModel;
  slippage: SlippageModel;
  spread?: SpreadModel;
  marketImpact?: MarketImpactModel;
  latency?: LatencyModel;
  /** Fraction of the observation's volume one fill may take. */
  participation?: number;
  borrow?: BorrowModel;
}

/** The whole declared execution reality of one run. */
export interface ExecutionPolicy {
  /** Echoed in every result's assumptions. */
  readonly label: string;
  /** `simplified` is the default and says so; `declared` means the caller named every member. */
  readonly realism: 'simplified' | 'declared';
  readonly observation: MarketObservationKind;
  readonly fill: FillModel;
  readonly ambiguity: AmbiguityPolicy;
  readonly costs: ExecutionCosts;
  readonly staleQuotes: StaleQuotePolicy;
  readonly lockedCrossed: LockedCrossedPolicy;
  readonly sessions?: SessionRules;
  readonly partialFills: PartialFillPolicy;
  readonly queue: { model: QueueModel };
  readonly timeInForce: { default: TimeInForce; expireAtSessionClose: boolean };
  readonly margin: MarginPolicy;
}

/** The JSON-safe projection of a policy that goes into a result's assumptions. */
export interface ExecutionPolicyDescription {
  label: string;
  realism: 'simplified' | 'declared';
  observation: MarketObservationKind;
  fill: { label: string; version: string };
  ambiguity: AmbiguityPolicy;
  costs: {
    commission: string;
    slippage: string;
    spread: string | null;
    marketImpact: string | null;
    latencySessions: number | null;
    participation: number | null;
    borrow: string | null;
  };
  staleQuotes: StaleQuotePolicy;
  lockedCrossed: LockedCrossedPolicy;
  sessions: { halts: number; priceLimits: number; auction: 'ignore' | 'open-close-only' | null };
  partialFills: PartialFillPolicy;
  queue: QueueModel;
  timeInForce: { default: TimeInForce; expireAtSessionClose: boolean };
  margin: MarginPolicy;
}
