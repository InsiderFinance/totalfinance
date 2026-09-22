/**
 * `@insiderfinance/totalfinance/portfolio/events` — the FC7 economic-event grammar (Stage 4.4).
 *
 * Portfolio truth is EVENT-DERIVED (agent-native platform doc, Permanent law 1; spec decision
 * D16): positions, cash, cost basis, and realized P&L are a pure fold over immutable economic
 * events — never mutable fields, never conversation memory. This module owns the closed
 * discriminated union of first-slice event payloads, the decided `PortfolioEventEnvelope`, the
 * Law-12 teaching validator, and the event content identity that defines the duplicate boundary.
 *
 * The families and their event lists are the agent-native doc's decided table ("Economic event
 * model"): cash (deposit, withdrawal, transfer, FX conversion), trading (fill), costs
 * (commission, exchange/regulatory fee, slippage adjustment), income (dividend, coupon, interest,
 * staking/funding receipt), financing (margin interest, borrow charge, funding payment), and
 * corporate actions (split, in this slice). Derivative lifecycle, further corporate actions, and
 * correction/reversal folding are later FC7 slices — see `docs/specs/fc7-first-slice.md`.
 *
 * Order submission/acknowledgement/rejection belongs to the EXECUTION JOURNAL, not this ledger
 * (Permanent law 3): an order does not change holdings; a fill does.
 */

import type { EpochMs, Provenance } from '@totalfinance/core';
import { ErrorCode, InputError, ensureKnownKeys } from '@totalfinance/core';
import { canonicalJsonOf, contentHash } from '@totalfinance/core/artifacts';
import {
  describeInputValue,
  hasOwnKey,
  ownValue,
  requireCurrencyCode,
  requireDenseDataArray,
  requireEpochMsField,
  requireFiniteNumberField,
  requireIdentityString,
  requireNoInheritedFields,
  requirePlainDataObject,
  requirePositiveNumberField,
  requireProvenanceShape,
} from './internal.js';

/**
 * Version of the event grammar carried by EVERY envelope. Bump only with a payload shape change,
 * landed together with a registered ledger migration.
 */
export const PORTFOLIO_EVENT_SCHEMA_VERSION = 1;

/** A deep copy of plain JSON data (the only kind these boundaries accept); typed, lib-free. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------------------------------
// Event payloads (closed discriminated union)
// ---------------------------------------------------------------------------------------------------

/** External money INTO the portfolio — an external flow, never investment profit (FC4's law). */
export interface CashDepositEvent {
  eventType: 'cash.deposit';
  /** Magnitude deposited, > 0, in `currency`. */
  amount: number;
  currency: string;
  /** When the cash leg settles; omitted = settled at `effectiveTimestampMs`. */
  settleTimestampMs?: EpochMs;
}

/** External money OUT of the portfolio — an external flow, never investment loss. */
export interface CashWithdrawalEvent {
  eventType: 'cash.withdrawal';
  /** Magnitude withdrawn, > 0, in `currency`. */
  amount: number;
  currency: string;
  settleTimestampMs?: EpochMs;
}

/** Cash moved between two accounts of the SAME portfolio — internal, never an external flow. */
export interface CashTransferEvent {
  eventType: 'cash.transfer';
  /** Magnitude transferred, > 0, in `currency`. */
  amount: number;
  currency: string;
  /** Must equal the envelope's `accountId` — the account the transfer leaves. */
  fromAccountId: string;
  toAccountId: string;
}

/**
 * A realized FX conversion between two cash balances of one account. Both legs are explicit
 * amounts — the realized rate is `toAmount / fromAmount`; no rate arithmetic is guessed here.
 */
export interface CashConversionEvent {
  eventType: 'cash.conversion';
  fromCurrency: string;
  toCurrency: string;
  /** Magnitude of `fromCurrency` sold, > 0. */
  fromAmount: number;
  /** Magnitude of `toCurrency` received, > 0. */
  toAmount: number;
}

/** One `specific-lot` relief instruction: which lot, and how much of it, this fill closes. */
export interface TradeFillLotSelection {
  lotId: string;
  /** Quantity relieved from the named lot, > 0 (an unsigned magnitude). */
  quantity: number;
}

/**
 * An executed fill — the audited bridge from the execution journal into economic holdings
 * (Permanent law 3). Buys open/extend long lots or cover short lots; sells relieve long lots or
 * open short lots. This slice prices cash as `quantity × pricePerUnit` (contract multipliers
 * arrive with the derivative-lifecycle slice).
 */
export interface TradeFillEvent {
  eventType: 'trade.fill';
  instrumentId: string;
  side: 'buy' | 'sell';
  /** Filled quantity, > 0 (fractional supported); `side` carries the direction. */
  quantity: number;
  /** Execution price per unit in `currency`. Finite; sign-unconstrained (negative prints are real). */
  pricePerUnit: number;
  currency: string;
  /** When the cash leg settles (trade date vs settlement date); omitted = settles immediately. */
  settleTimestampMs?: EpochMs;
  /** Required exactly when the ledger's `lotRelief` is `'specific-lot'` AND this fill closes. */
  lotSelections?: TradeFillLotSelection[];
  /**
   * Units of the underlying per unit of `quantity` (an equity option's 100, a futures contract
   * size). Omitted = 1 (one unit per unit). REQUIRED when `contract` is given — a derivative fill
   * states its multiplier. Cash and lot values scale by it; the lot basis stays per unit.
   */
  contractMultiplier?: number;
  /**
   * `'cash-on-trade'` (equities, options, spot; the default) books `quantity × pricePerUnit ×
   * contractMultiplier` at the fill. `'variation-margin'` (futures, perpetuals) books NO cash at
   * the fill: P&L is realized by `derivative.variation-margin` settlements and on close. REQUIRED
   * as `'variation-margin'` when `contract.kind` is `'future'` or `'perpetual'`.
   */
  settlementStyle?: SettlementStyle;
  /** The derivative's terms (option type/strike/expiry, future expiry, perpetual) — stored on the position. */
  contract?: DerivativeContractTerms;
  /**
   * Accrued interest paid with a bond purchase (or received on a sale), in `currency` — booked as
   * an income adjustment (negative on a buy), NEVER into the lot basis; the next coupon recovers it.
   */
  accruedInterest?: number;
}

export type CostType = 'commission' | 'exchange-fee' | 'regulatory-fee' | 'slippage-adjustment';

/**
 * An explicit transaction cost — a SEPARATE event, never folded into lot cost basis (FC7
 * mandatory state: costs are separate components), attributed via `instrumentId`/`relatesToEventId`.
 */
export interface CostChargeEvent {
  eventType: 'cost.charge';
  costType: CostType;
  /** Finite and non-zero: > 0 charges cash, < 0 is a rebate/credit. */
  amount: number;
  currency: string;
  instrumentId?: string;
  /** The `eventId` of the fill (or other event) this cost belongs to, when known. */
  relatesToEventId?: string;
}

export type IncomeType = 'dividend' | 'coupon' | 'interest' | 'staking-reward' | 'funding-receipt';

/**
 * Income cash effect — dividend, coupon, interest, staking reward, or funding receipt.
 * Despite the historical `income.received` event name, dividends and coupons are signed:
 * positive receives income; negative pays the corresponding short-position obligation.
 * Either sign belongs to income attribution, not external flows or financing costs.
 */
export interface IncomeReceivedEvent {
  eventType: 'income.received';
  incomeType: IncomeType;
  /**
   * Finite and non-zero, in `currency`. Dividends/coupons may be negative (income owed on a
   * short); other income types must be positive (funding payments use `financing.charge`).
   */
  amount: number;
  currency: string;
  instrumentId?: string;
  settleTimestampMs?: EpochMs;
}

export type FinancingType = 'margin-interest' | 'borrow-charge' | 'funding-payment';

/** A financing charge paid in cash — margin interest, borrow fee, or perpetual funding paid. */
export interface FinancingChargeEvent {
  eventType: 'financing.charge';
  financingType: FinancingType;
  /** Magnitude charged, > 0, in `currency` (a funding RECEIPT is `income.received`). */
  amount: number;
  currency: string;
  instrumentId?: string;
}

/**
 * A forward or reverse stock split: every lot's quantity scales by
 * `sharesAfterSplit / sharesBeforeSplit` and its per-unit basis by the inverse, so total cost
 * basis is preserved exactly. Cash-in-lieu of fractional shares is a separate (later) event.
 */
export interface StockSplitEvent {
  eventType: 'corporate.split';
  instrumentId: string;
  /** Shares held after the split per `sharesBeforeSplit` held before; positive integer. */
  sharesAfterSplit: number;
  /** Positive integer; a 2-for-1 split is `{ sharesAfterSplit: 2, sharesBeforeSplit: 1 }`. */
  sharesBeforeSplit: number;
}

// ---------------------------------------------------------------------------------------------------
// Instrument profile and lifecycle families (slice 5, 2026-08-29; agent-native "Derivative
// lifecycle" and "Corporate actions" families; FC7 mandatory state)
// ---------------------------------------------------------------------------------------------------

/** How a position's cash settles: at the fill, or through variation margin. */
export type SettlementStyle = 'cash-on-trade' | 'variation-margin';

export interface OptionContractTerms {
  kind: 'option';
  underlyingInstrumentId: string;
  /** `'call' | 'put'` — the same word the option contract and every chain row use (B6). */
  type: 'call' | 'put';
  strikePricePerUnit: number;
  expiryTimestampMs: EpochMs;
}

export interface FutureContractTerms {
  kind: 'future';
  underlyingInstrumentId: string;
  expiryTimestampMs: EpochMs;
}

export interface PerpetualContractTerms {
  kind: 'perpetual';
  underlyingInstrumentId: string;
}

/** The terms a derivative position carries from its opening fill. */
export type DerivativeContractTerms =
  | OptionContractTerms
  | FutureContractTerms
  | PerpetualContractTerms;

/** Physical delivery of the underlying at the strike, or cash at an explicit settlement price. */
export type DerivativeSettlement =
  | { kind: 'physical' }
  | { kind: 'cash'; settlementPricePerUnit: number };

/**
 * What happens to the option premium on physical exercise/assignment: folded into the delivered
 * underlying's basis or proceeds (the common tax-lot convention), or realized on the option lots.
 * REQUIRED — a convention is a goal, not a default.
 */
export type PremiumTreatment = 'fold-into-underlying-basis' | 'realize';

/** A holder exercises long option contracts. */
export interface OptionExerciseEvent {
  eventType: 'derivative.exercise';
  instrumentId: string;
  /** Contracts exercised, > 0. */
  quantity: number;
  settlement: DerivativeSettlement;
  premiumTreatment: PremiumTreatment;
  settleTimestampMs?: EpochMs;
  lotSelections?: TradeFillLotSelection[];
}

/** A writer is assigned on short option contracts. */
export interface OptionAssignmentEvent {
  eventType: 'derivative.assignment';
  instrumentId: string;
  /** Contracts assigned, > 0. */
  quantity: number;
  settlement: DerivativeSettlement;
  premiumTreatment: PremiumTreatment;
  settleTimestampMs?: EpochMs;
  lotSelections?: TradeFillLotSelection[];
}

/** Option contracts expire worthless: lots are relieved at zero, no cash moves. */
export interface OptionExpirationEvent {
  eventType: 'derivative.expiration';
  instrumentId: string;
  /** Contracts expiring, > 0. */
  quantity: number;
  lotSelections?: TradeFillLotSelection[];
}

/** A contract adjustment rescales the multiplier; total basis is preserved exactly. */
export interface ContractMultiplierChangeEvent {
  eventType: 'derivative.multiplier-change';
  instrumentId: string;
  contractMultiplierAfter: number;
  /** An adjusted strike (OCC-style adjustments change both); only for a position with option terms. */
  strikePricePerUnitAfter?: number;
  reason?: string;
}

/**
 * A variation-margin settlement: every open lot of a `'variation-margin'` position re-bases to
 * the settlement price and the difference is realized in cash — the fold computes the amount
 * from the lots, so a statement's figure reconciles rather than being trusted.
 */
export interface VariationMarginEvent {
  eventType: 'derivative.variation-margin';
  instrumentId: string;
  settlementPricePerUnit: number;
}

/** Close a contract and open its successor in one economic event (one provenance). */
export interface DerivativeRollEvent {
  eventType: 'derivative.roll';
  fromInstrumentId: string;
  toInstrumentId: string;
  /** Contracts rolled, > 0. */
  quantity: number;
  closePricePerUnit: number;
  openPricePerUnit: number;
  /** Terms of the successor contract (the multiplier and settlement style carry over). */
  contract?: DerivativeContractTerms;
  lotSelections?: TradeFillLotSelection[];
}

export type RedemptionType = 'maturity' | 'call' | 'principal-paydown' | 'sinking-fund';

/**
 * Principal settled on a fixed-income position: long or short lots relieved at the redemption
 * price. Long holdings receive principal; short holdings pay it. Direction comes from the
 * held position, while the event quantity is always an unsigned magnitude.
 */
export interface FixedIncomeRedemptionEvent {
  eventType: 'fixed-income.redemption';
  instrumentId: string;
  redemptionType: RedemptionType;
  /** Magnitude of face units redeemed, > 0, for either a long or short holding. */
  quantity: number;
  /** Redemption price per unit (par = 1 per unit of face, or 100 per 100 face — the fill's unit). */
  pricePerUnit: number;
  currency: string;
  settleTimestampMs?: EpochMs;
  lotSelections?: TradeFillLotSelection[];
}

/** The instrument is renamed; lots, basis, and lot ids carry over. */
export interface SymbolChangeEvent {
  eventType: 'corporate.symbol-change';
  fromInstrumentId: string;
  toInstrumentId: string;
}

/**
 * A merger: stock-for-stock (`sharesPerShare` of `toInstrumentId` per share held), cash
 * (`cashPerShare`), or both. At least one consideration is REQUIRED.
 */
export interface MergerEvent {
  eventType: 'corporate.merger';
  fromInstrumentId: string;
  toInstrumentId?: string;
  sharesPerShare?: number;
  cashPerShare?: number;
  /** Required with `cashPerShare`. */
  currency?: string;
  settleTimestampMs?: EpochMs;
}

/** A spin-off: child shares per parent share with an EXPLICIT basis allocation fraction. */
export interface SpinOffEvent {
  eventType: 'corporate.spin-off';
  parentInstrumentId: string;
  childInstrumentId: string;
  sharesPerParentShare: number;
  /** Fraction of the parent's basis that moves to the child, in [0, 1]. REQUIRED. */
  basisAllocationFraction: number;
}

/** A return of capital: cash received reduces basis (never income); excess over basis is realized. */
export interface ReturnOfCapitalEvent {
  eventType: 'corporate.return-of-capital';
  instrumentId: string;
  amountPerShare: number;
  currency: string;
  settleTimestampMs?: EpochMs;
}

/** Cash in lieu of a fractional quantity surrendered (after a split, merger, or spin-off). */
export interface CashInLieuEvent {
  eventType: 'corporate.cash-in-lieu';
  instrumentId: string;
  /** Fractional quantity surrendered, > 0. */
  quantity: number;
  /** Cash received, in `currency`. */
  amount: number;
  currency: string;
  relatesToEventId?: string;
  settleTimestampMs?: EpochMs;
}

/** Lots move between two accounts of the portfolio; basis and opening dates are preserved. */
export interface PositionTransferEvent {
  eventType: 'position.transfer';
  instrumentId: string;
  /** Unsigned quantity moved, > 0. */
  quantity: number;
  fromAccountId: string;
  toAccountId: string;
  lotSelections?: TradeFillLotSelection[];
}

/** The closed first-slice economic-event union (agent-native doc's decided event families). */
// ---------------------------------------------------------------------------------------------------
// Administration (slice 3, 2026-08-28; agent-native "Administration" family, Permanent law 1)
// ---------------------------------------------------------------------------------------------------

/**
 * Reverse an applied fact EXACTLY. The envelope's `reversesEventId` names it; `original` carries
 * the applied envelope verbatim so the fold can prove (by content hash against its registry) that
 * what is being reversed is what was applied — a reversal never targets an imagined fact.
 * History is not rewritten: the original stays in the registry, the reversal is registered beside
 * it, and the state records the link.
 */
export interface AdminReversalEvent {
  eventType: 'admin.reversal';
  original: PortfolioEventEnvelope;
  reason?: string;
}

/**
 * Reverse an applied fact exactly and record what it should have been, atomically. The
 * `replacement` folds at the ORIGINAL's effective instant (so lot order and settlement timing are
 * what they would have been had the fact been recorded right), under the correction's identity.
 */
export interface AdminCorrectionEvent {
  eventType: 'admin.correction';
  original: PortfolioEventEnvelope;
  replacement: EconomicPortfolioEvent;
  reason?: string;
}

/** An audit marker that an account's identity moved; no economic effect (the marker is the fact). */
export interface AdminAccountMigrationEvent {
  eventType: 'admin.account-migration';
  fromAccountId: string;
  toAccountId: string;
  reason?: string;
}

/** The events with an economic effect — everything an `admin.*` event can reference or replace. */
export type EconomicPortfolioEvent =
  | CashDepositEvent
  | CashWithdrawalEvent
  | CashTransferEvent
  | CashConversionEvent
  | TradeFillEvent
  | CostChargeEvent
  | IncomeReceivedEvent
  | FinancingChargeEvent
  | StockSplitEvent
  | OptionExerciseEvent
  | OptionAssignmentEvent
  | OptionExpirationEvent
  | ContractMultiplierChangeEvent
  | VariationMarginEvent
  | DerivativeRollEvent
  | FixedIncomeRedemptionEvent
  | SymbolChangeEvent
  | MergerEvent
  | SpinOffEvent
  | ReturnOfCapitalEvent
  | CashInLieuEvent
  | PositionTransferEvent;

export type PortfolioEvent =
  | EconomicPortfolioEvent
  | AdminReversalEvent
  | AdminCorrectionEvent
  | AdminAccountMigrationEvent;

export type PortfolioEventType = PortfolioEvent['eventType'];

// ---------------------------------------------------------------------------------------------------
// The envelope (the agent-native doc's decided shape)
// ---------------------------------------------------------------------------------------------------

/**
 * The canonical event envelope — JSON-safe, CloudEvents-mappable without the dependency, and
 * clock-free: BOTH timestamps are supplied explicitly; the package never reads the system clock.
 * `(sourceId, eventId)` is the duplicate boundary: replaying an identical envelope is a no-op,
 * and a same-key envelope with a different body is a typed conflict
 * (`portfolio.duplicate_event_conflict`).
 */
export interface PortfolioEventEnvelope {
  /** Unique within `sourceId` — together they are the duplicate boundary. */
  eventId: string;
  /** Must equal {@link PORTFOLIO_EVENT_SCHEMA_VERSION}. */
  schemaVersion: number;
  /** Redundant discriminator; must equal `event.eventType`. */
  eventType: PortfolioEventType;
  /** The system that emitted the event (a broker import, a simulator, a manual entry). */
  sourceId: string;
  /** The account the event is recorded against (for transfers, the FROM account). */
  accountId: string;
  /** When the economic effect occurred. Events fold in non-decreasing `effectiveTimestampMs`. */
  effectiveTimestampMs: EpochMs;
  /** When the event was recorded — may lag the effect; never read from a clock by this package. */
  recordedTimestampMs: EpochMs;
  correlationId?: string;
  causationId?: string;
  /** Names a prior event this one reverses. Recorded now; the repair fold is a later slice. */
  reversesEventId?: string;
  event: PortfolioEvent;
  /** Where the event came from — caller-supplied, never fetched; OUTSIDE the event identity. */
  provenance: Provenance;
}

const ENVELOPE_KEYS = [
  'eventId',
  'schemaVersion',
  'eventType',
  'sourceId',
  'accountId',
  'effectiveTimestampMs',
  'recordedTimestampMs',
  'correlationId',
  'causationId',
  'reversesEventId',
  'event',
  'provenance',
] as const;

const EVENT_KEYS: Record<PortfolioEventType, readonly string[]> = {
  'admin.reversal': ['eventType', 'original', 'reason'],
  'admin.correction': ['eventType', 'original', 'replacement', 'reason'],
  'admin.account-migration': ['eventType', 'fromAccountId', 'toAccountId', 'reason'],
  'cash.deposit': ['eventType', 'amount', 'currency', 'settleTimestampMs'],
  'cash.withdrawal': ['eventType', 'amount', 'currency', 'settleTimestampMs'],
  'cash.transfer': ['eventType', 'amount', 'currency', 'fromAccountId', 'toAccountId'],
  'cash.conversion': ['eventType', 'fromCurrency', 'toCurrency', 'fromAmount', 'toAmount'],
  'trade.fill': [
    'eventType',
    'instrumentId',
    'side',
    'quantity',
    'pricePerUnit',
    'currency',
    'settleTimestampMs',
    'lotSelections',
    'contractMultiplier',
    'settlementStyle',
    'contract',
    'accruedInterest',
  ],
  'cost.charge': [
    'eventType',
    'costType',
    'amount',
    'currency',
    'instrumentId',
    'relatesToEventId',
  ],
  'income.received': [
    'eventType',
    'incomeType',
    'amount',
    'currency',
    'instrumentId',
    'settleTimestampMs',
  ],
  'financing.charge': ['eventType', 'financingType', 'amount', 'currency', 'instrumentId'],
  'corporate.split': ['eventType', 'instrumentId', 'sharesAfterSplit', 'sharesBeforeSplit'],
  'derivative.exercise': [
    'eventType',
    'instrumentId',
    'quantity',
    'settlement',
    'premiumTreatment',
    'settleTimestampMs',
    'lotSelections',
  ],
  'derivative.assignment': [
    'eventType',
    'instrumentId',
    'quantity',
    'settlement',
    'premiumTreatment',
    'settleTimestampMs',
    'lotSelections',
  ],
  'derivative.expiration': ['eventType', 'instrumentId', 'quantity', 'lotSelections'],
  'derivative.multiplier-change': [
    'eventType',
    'instrumentId',
    'contractMultiplierAfter',
    'strikePricePerUnitAfter',
    'reason',
  ],
  'derivative.variation-margin': ['eventType', 'instrumentId', 'settlementPricePerUnit'],
  'derivative.roll': [
    'eventType',
    'fromInstrumentId',
    'toInstrumentId',
    'quantity',
    'closePricePerUnit',
    'openPricePerUnit',
    'contract',
    'lotSelections',
  ],
  'fixed-income.redemption': [
    'eventType',
    'instrumentId',
    'redemptionType',
    'quantity',
    'pricePerUnit',
    'currency',
    'settleTimestampMs',
    'lotSelections',
  ],
  'corporate.symbol-change': ['eventType', 'fromInstrumentId', 'toInstrumentId'],
  'corporate.merger': [
    'eventType',
    'fromInstrumentId',
    'toInstrumentId',
    'sharesPerShare',
    'cashPerShare',
    'currency',
    'settleTimestampMs',
  ],
  'corporate.spin-off': [
    'eventType',
    'parentInstrumentId',
    'childInstrumentId',
    'sharesPerParentShare',
    'basisAllocationFraction',
  ],
  'corporate.return-of-capital': [
    'eventType',
    'instrumentId',
    'amountPerShare',
    'currency',
    'settleTimestampMs',
  ],
  'corporate.cash-in-lieu': [
    'eventType',
    'instrumentId',
    'quantity',
    'amount',
    'currency',
    'relatesToEventId',
    'settleTimestampMs',
  ],
  'position.transfer': [
    'eventType',
    'instrumentId',
    'quantity',
    'fromAccountId',
    'toAccountId',
    'lotSelections',
  ],
};

const SETTLEMENT_STYLES: readonly SettlementStyle[] = ['cash-on-trade', 'variation-margin'];
const CONTRACT_KINDS = ['option', 'future', 'perpetual'] as const;
const PREMIUM_TREATMENTS: readonly PremiumTreatment[] = ['fold-into-underlying-basis', 'realize'];
const REDEMPTION_TYPES: readonly RedemptionType[] = [
  'maturity',
  'call',
  'principal-paydown',
  'sinking-fund',
];

const COST_TYPES: readonly CostType[] = [
  'commission',
  'exchange-fee',
  'regulatory-fee',
  'slippage-adjustment',
];
const INCOME_TYPES: readonly IncomeType[] = [
  'dividend',
  'coupon',
  'interest',
  'staking-reward',
  'funding-receipt',
];
const FINANCING_TYPES: readonly FinancingType[] = [
  'margin-interest',
  'borrow-charge',
  'funding-payment',
];

const EXAMPLE_ENVELOPE =
  "{ eventId: 'evt-1', schemaVersion: 1, eventType: 'cash.deposit', sourceId: 'manual', accountId: 'main', " +
  'effectiveTimestampMs: 1735689600000, recordedTimestampMs: 1735689600000, ' +
  "event: { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' }, provenance: {} }";

function requireEnumField<T extends string>(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new InputError(
      `${functionName}: ${field} must be one of ${allowed.map((v) => `'${v}'`).join(' | ')}. Received ${describeInputValue(value)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { function: functionName, field } },
    );
  }
}

function requireOptionalSettle(
  functionName: string,
  path: string,
  event: { settleTimestampMs?: unknown },
  effectiveTimestampMs: number,
): void {
  if (event.settleTimestampMs === undefined) return;
  requireEpochMsField(functionName, `${path}.settleTimestampMs`, event.settleTimestampMs);
  if ((event.settleTimestampMs as number) < effectiveTimestampMs) {
    throw new InputError(
      `${functionName}: ${path}.settleTimestampMs (${event.settleTimestampMs as number}) is before the envelope's effectiveTimestampMs (${effectiveTimestampMs}) — a cash leg cannot settle before its economic effect occurs.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${path}.settleTimestampMs` },
      },
    );
  }
}

/** Validate an optional `lotSelections` array (shared by every lot-relieving family). */
function requireLotSelectionsShape(functionName: string, path: string, selections: unknown): void {
  if (selections === undefined) return;
  if (!Array.isArray(selections) || selections.length === 0) {
    throw new InputError(
      `${functionName}: ${path}.lotSelections must be a non-empty array of { lotId, quantity } when present. Received ${selections === null ? 'null' : Array.isArray(selections) ? 'an empty array' : typeof selections}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${path}.lotSelections` },
      },
    );
  }
  requireDenseDataArray(functionName, `${path}.lotSelections`, selections);
  const seen = new Set<string>();
  selections.forEach((selection, index) => {
    const selectionPath = `${path}.lotSelections[${index}]`;
    requirePlainDataObject(functionName, selectionPath, selection);
    requireNoInheritedFields(functionName, selectionPath, selection, ['lotId', 'quantity']);
    ensureKnownKeys(functionName, selectionPath, selection as object, ['lotId', 'quantity']);
    const row = selection as Record<string, unknown>;
    requireIdentityString(functionName, `${selectionPath}.lotId`, row['lotId']);
    requirePositiveNumberField(
      functionName,
      `${selectionPath}.quantity`,
      row['quantity'],
      'the unsigned quantity relieved from the named lot',
    );
    if (seen.has(row['lotId'] as string)) {
      throw new InputError(
        `${functionName}: ${selectionPath}.lotId '${String(row['lotId'])}' appears twice — name each relieved lot once, with its total relieved quantity.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${selectionPath}.lotId` },
        },
      );
    }
    seen.add(row['lotId'] as string);
  });
}

/** Validate derivative contract terms (closed per kind). */
function requireContractTerms(functionName: string, path: string, value: unknown): void {
  requirePlainDataObject(functionName, path, value);
  const terms = value as Record<string, unknown>;
  requireNoInheritedFields(functionName, path, terms, ['kind', 'underlyingInstrumentId']);
  const kind = ownValue(terms, 'kind');
  requireEnumField(functionName, `${path}.kind`, kind, CONTRACT_KINDS);
  requireIdentityString(
    functionName,
    `${path}.underlyingInstrumentId`,
    terms['underlyingInstrumentId'],
  );
  if (kind === 'option') {
    const keys = [
      'kind',
      'underlyingInstrumentId',
      'type',
      'strikePricePerUnit',
      'expiryTimestampMs',
    ] as const;
    requireNoInheritedFields(functionName, path, terms, keys);
    ensureKnownKeys(functionName, path, terms, keys);
    requireEnumField(functionName, `${path}.type`, terms['type'], ['call', 'put'] as const);
    requireFiniteNumberField(
      functionName,
      `${path}.strikePricePerUnit`,
      terms['strikePricePerUnit'],
    );
    requireEpochMsField(functionName, `${path}.expiryTimestampMs`, terms['expiryTimestampMs']);
  } else if (kind === 'future') {
    const keys = ['kind', 'underlyingInstrumentId', 'expiryTimestampMs'] as const;
    requireNoInheritedFields(functionName, path, terms, keys);
    ensureKnownKeys(functionName, path, terms, keys);
    requireEpochMsField(functionName, `${path}.expiryTimestampMs`, terms['expiryTimestampMs']);
  } else {
    const keys = ['kind', 'underlyingInstrumentId'] as const;
    requireNoInheritedFields(functionName, path, terms, keys);
    ensureKnownKeys(functionName, path, terms, keys);
  }
}

/**
 * The fill's instrument profile: multiplier (> 0, required with contract terms), settlement style
 * (variation margin exactly for futures/perpetuals), and contract terms.
 */
function requireContractProfile(
  functionName: string,
  path: string,
  event: Record<string, unknown>,
): void {
  if (event['contractMultiplier'] !== undefined) {
    requirePositiveNumberField(
      functionName,
      `${path}.contractMultiplier`,
      event['contractMultiplier'],
      'units of the underlying per unit of quantity',
    );
  }
  if (event['settlementStyle'] !== undefined) {
    requireEnumField(
      functionName,
      `${path}.settlementStyle`,
      event['settlementStyle'],
      SETTLEMENT_STYLES,
    );
  }
  if (event['contract'] !== undefined) {
    requireContractTerms(functionName, `${path}.contract`, event['contract']);
    if (event['contractMultiplier'] === undefined) {
      throw new InputError(
        `${functionName}: ${path}.contractMultiplier is required with ${path}.contract — a derivative fill states its multiplier (an equity option's 100, a futures contract size); the ledger never assumes one.`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field: `${path}.contractMultiplier` },
        },
      );
    }
    const kind = (event['contract'] as Record<string, unknown>)['kind'];
    const style = event['settlementStyle'] ?? 'cash-on-trade';
    if ((kind === 'future' || kind === 'perpetual') && style !== 'variation-margin') {
      throw new InputError(
        `${functionName}: ${path}.settlementStyle must be 'variation-margin' for a ${kind} — no cash changes hands at the fill; P&L settles through derivative.variation-margin. Received ${describeInputValue(event['settlementStyle'])}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${path}.settlementStyle` },
        },
      );
    }
    if (kind === 'option' && style !== 'cash-on-trade') {
      throw new InputError(
        `${functionName}: ${path}.settlementStyle must be 'cash-on-trade' for an option (the premium is paid at the fill). Received ${describeInputValue(event['settlementStyle'])}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${path}.settlementStyle` },
        },
      );
    }
  } else if (event['settlementStyle'] === 'variation-margin') {
    throw new InputError(
      `${functionName}: ${path}.contract is required with settlementStyle 'variation-margin' — only an explicitly described future or perpetual receives daily variation-margin treatment; a multiplier alone does not turn a cash instrument into a derivative.`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: `${path}.contract` },
      },
    );
  }
}

/** A dated contract may be opened/rolled only while its expiry has not passed (inclusive). */
function requireContractLiveAt(
  functionName: string,
  path: string,
  value: unknown,
  effectiveTimestampMs: number,
): void {
  if (value === undefined) return;
  const terms = value as Record<string, unknown>;
  if (
    (terms['kind'] === 'option' || terms['kind'] === 'future') &&
    (terms['expiryTimestampMs'] as number) < effectiveTimestampMs
  ) {
    throw new InputError(
      `${functionName}: ${path}.expiryTimestampMs (${String(terms['expiryTimestampMs'])}) is before the event's effectiveTimestampMs (${effectiveTimestampMs}) — a dated contract cannot be opened or rolled after it has expired.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${path}.expiryTimestampMs` },
      },
    );
  }
}

function requireDerivativeSettlement(functionName: string, path: string, value: unknown): void {
  requirePlainDataObject(functionName, path, value);
  const settlement = value as Record<string, unknown>;
  const kind = ownValue(settlement, 'kind');
  requireEnumField(functionName, `${path}.kind`, kind, ['physical', 'cash'] as const);
  if (kind === 'physical') {
    requireNoInheritedFields(functionName, path, settlement, ['kind']);
    ensureKnownKeys(functionName, path, settlement, ['kind']);
  } else {
    const keys = ['kind', 'settlementPricePerUnit'] as const;
    requireNoInheritedFields(functionName, path, settlement, keys);
    ensureKnownKeys(functionName, path, settlement, keys);
    requireFiniteNumberField(
      functionName,
      `${path}.settlementPricePerUnit`,
      settlement['settlementPricePerUnit'],
    );
  }
}

function requireQuantityField(
  functionName: string,
  path: string,
  event: Record<string, unknown>,
  meaning: string,
): void {
  requirePositiveNumberField(functionName, `${path}.quantity`, event['quantity'], meaning);
}

function validateEventPayload(
  functionName: string,
  path: string,
  envelope: PortfolioEventEnvelope,
): void {
  const event = envelope.event as unknown as Record<string, unknown>;
  requirePlainDataObject(functionName, path, event);
  const eventType = ownValue(event, 'eventType');
  if (typeof eventType !== 'string' || !hasOwnKey(EVENT_KEYS, eventType)) {
    throw new InputError(
      `${functionName}: ${path}.eventType must be one of ${Object.keys(EVENT_KEYS)
        .map((t) => `'${t}'`)
        .join(' | ')}. Received ${describeInputValue(eventType)}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: `${path}.eventType` },
      },
    );
  }
  const knownKeys = EVENT_KEYS[eventType as PortfolioEventType];
  requireNoInheritedFields(functionName, path, event, knownKeys);
  ensureKnownKeys(functionName, path, event, knownKeys);
  if (envelope.eventType !== eventType) {
    throw new InputError(
      `${functionName}: the envelope's eventType (${describeInputValue(envelope.eventType)}) must equal ${path}.eventType ('${eventType}') — the redundant discriminator exists so a mismatched envelope is heard, not guessed around.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field: 'eventType' } },
    );
  }

  switch (eventType as PortfolioEventType) {
    case 'cash.deposit':
    case 'cash.withdrawal': {
      requirePositiveNumberField(
        functionName,
        `${path}.amount`,
        event['amount'],
        `the ${eventType === 'cash.deposit' ? 'deposited' : 'withdrawn'} magnitude (direction comes from the event type)`,
      );
      requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      requireOptionalSettle(functionName, path, event, envelope.effectiveTimestampMs);
      break;
    }
    case 'cash.transfer': {
      requirePositiveNumberField(
        functionName,
        `${path}.amount`,
        event['amount'],
        'the transferred magnitude',
      );
      requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      requireIdentityString(functionName, `${path}.fromAccountId`, event['fromAccountId']);
      requireIdentityString(functionName, `${path}.toAccountId`, event['toAccountId']);
      if (event['fromAccountId'] === event['toAccountId']) {
        throw new InputError(
          `${functionName}: ${path} transfers from account '${String(event['fromAccountId'])}' to itself — fromAccountId and toAccountId must differ.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.toAccountId` },
          },
        );
      }
      if (envelope.accountId !== event['fromAccountId']) {
        throw new InputError(
          `${functionName}: the envelope's accountId ('${envelope.accountId}') must equal ${path}.fromAccountId ('${String(event['fromAccountId'])}') — a transfer is recorded against the account it leaves.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: 'accountId' },
          },
        );
      }
      break;
    }
    case 'cash.conversion': {
      requireCurrencyCode(functionName, `${path}.fromCurrency`, event['fromCurrency']);
      requireCurrencyCode(functionName, `${path}.toCurrency`, event['toCurrency']);
      if (event['fromCurrency'] === event['toCurrency']) {
        throw new InputError(
          `${functionName}: ${path} converts ${String(event['fromCurrency'])} into itself — fromCurrency and toCurrency must differ.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.toCurrency` },
          },
        );
      }
      requirePositiveNumberField(
        functionName,
        `${path}.fromAmount`,
        event['fromAmount'],
        'the magnitude of the currency sold',
      );
      requirePositiveNumberField(
        functionName,
        `${path}.toAmount`,
        event['toAmount'],
        'the magnitude of the currency received',
      );
      break;
    }
    case 'trade.fill': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      requireEnumField(functionName, `${path}.side`, event['side'], ['buy', 'sell'] as const);
      requirePositiveNumberField(
        functionName,
        `${path}.quantity`,
        event['quantity'],
        'the filled quantity (side carries the direction)',
      );
      requireFiniteNumberField(functionName, `${path}.pricePerUnit`, event['pricePerUnit']);
      requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      requireOptionalSettle(functionName, path, event, envelope.effectiveTimestampMs);
      requireLotSelectionsShape(functionName, path, event['lotSelections']);
      requireContractProfile(functionName, path, event);
      requireContractLiveAt(
        functionName,
        `${path}.contract`,
        event['contract'],
        envelope.effectiveTimestampMs,
      );
      if (event['accruedInterest'] !== undefined) {
        requireFiniteNumberField(functionName, `${path}.accruedInterest`, event['accruedInterest']);
        if (event['accruedInterest'] < 0) {
          throw new InputError(
            `${functionName}: ${path}.accruedInterest is the unsigned accrued amount exchanged with the fill (side carries the direction: paid on a buy, received on a sell). Received ${event['accruedInterest']}.`,
            {
              code: ErrorCode.InputOutOfRange,
              context: { function: functionName, field: `${path}.accruedInterest` },
            },
          );
        }
      }
      break;
    }
    case 'cost.charge': {
      requireEnumField(functionName, `${path}.costType`, event['costType'], COST_TYPES);
      requireFiniteNumberField(functionName, `${path}.amount`, event['amount']);
      if ((event['amount'] as number) === 0) {
        throw new InputError(
          `${functionName}: ${path}.amount must be non-zero — positive charges cash, negative is a rebate/credit; a zero cost is not an economic event.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.amount` },
          },
        );
      }
      requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      if (event['instrumentId'] !== undefined) {
        requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      }
      if (event['relatesToEventId'] !== undefined) {
        requireIdentityString(functionName, `${path}.relatesToEventId`, event['relatesToEventId']);
      }
      break;
    }
    case 'income.received': {
      requireEnumField(functionName, `${path}.incomeType`, event['incomeType'], INCOME_TYPES);
      if (event['incomeType'] === 'dividend' || event['incomeType'] === 'coupon') {
        requireFiniteNumberField(functionName, `${path}.amount`, event['amount']);
        if ((event['amount'] as number) === 0) {
          throw new InputError(
            `${functionName}: ${path}.amount must be non-zero — positive receives income, negative pays a short-position dividend/coupon obligation; omit a zero income event.`,
            {
              code: ErrorCode.InputOutOfRange,
              context: { function: functionName, field: `${path}.amount` },
            },
          );
        }
      } else {
        requirePositiveNumberField(
          functionName,
          `${path}.amount`,
          event['amount'],
          'income received in cash (a financing PAYMENT is financing.charge)',
        );
      }
      requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      if (event['instrumentId'] !== undefined) {
        requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      }
      requireOptionalSettle(functionName, path, event, envelope.effectiveTimestampMs);
      break;
    }
    case 'financing.charge': {
      requireEnumField(
        functionName,
        `${path}.financingType`,
        event['financingType'],
        FINANCING_TYPES,
      );
      requirePositiveNumberField(
        functionName,
        `${path}.amount`,
        event['amount'],
        'the financing magnitude paid (a funding RECEIPT is income.received)',
      );
      requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      if (event['instrumentId'] !== undefined) {
        requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      }
      break;
    }
    case 'admin.reversal':
    case 'admin.correction': {
      requirePlainDataObject(functionName, `${path}.original`, event['original']);
      // The applied envelope, verbatim — validated as the closed grammar it must already satisfy.
      requirePortfolioEventEnvelope(functionName, `${path}.original`, event['original'] as never);
      const original = event['original'] as unknown as PortfolioEventEnvelope;
      const originalType = original.event.eventType;
      // A reversal may undo a repair (a reversal of a reversal re-applies the fact; a reversal of a
      // correction undoes the replacement and re-applies the fact) — that is what makes a wrong
      // repair recoverable. A correction, and a migration marker, are never the subject of a repair.
      const repairable =
        eventType === 'admin.reversal'
          ? originalType !== 'admin.account-migration'
          : !originalType.startsWith('admin.');
      if (!repairable) {
        throw new InputError(
          `${functionName}: ${path}.original is an '${originalType}' event — ${
            eventType === 'admin.correction'
              ? 'a correction repairs an economic fact; to undo a repair, record an admin.reversal of it'
              : 'a migration marker has no effect to reverse'
          }.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.original` },
          },
        );
      }
      if (envelope.reversesEventId !== original.eventId) {
        throw new InputError(
          `${functionName}: ${path.replace(/\.event$/, '')}.reversesEventId must equal ${path}.original.eventId (${describeInputValue(original.eventId)}) — the link and the carried original name the same applied fact. Received ${describeInputValue(envelope.reversesEventId)}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.original.eventId` },
          },
        );
      }
      if (original.accountId !== envelope.accountId) {
        throw new InputError(
          `${functionName}: ${path}.original was recorded on account '${original.accountId}', but this ${eventType as string} is on account '${envelope.accountId}' — a repair is recorded on the account it repairs.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.original.accountId` },
          },
        );
      }
      if (eventType === 'admin.correction') {
        requirePlainDataObject(functionName, `${path}.replacement`, event['replacement']);
        const replacementType = ownValue(
          event['replacement'] as Record<string, unknown>,
          'eventType',
        );
        if (typeof replacementType === 'string' && replacementType.startsWith('admin.')) {
          throw new InputError(
            `${functionName}: ${path}.replacement must be an economic event (cash/trade/cost/income/financing/corporate), not '${replacementType}'.`,
            {
              code: ErrorCode.InputInvalidEnum,
              context: { function: functionName, field: `${path}.replacement.eventType` },
            },
          );
        }
        // Validated at the ORIGINAL's instant — that is when the replacement folds.
        validateEventPayload(functionName, `${path}.replacement`, {
          ...original,
          event: event['replacement'] as unknown as PortfolioEvent,
        });
      }
      if (event['reason'] !== undefined) {
        requireIdentityString(functionName, `${path}.reason`, event['reason']);
      }
      break;
    }
    case 'admin.account-migration': {
      requireIdentityString(functionName, `${path}.fromAccountId`, event['fromAccountId']);
      requireIdentityString(functionName, `${path}.toAccountId`, event['toAccountId']);
      if (event['fromAccountId'] === event['toAccountId']) {
        throw new InputError(
          `${functionName}: ${path} migrates account '${String(event['fromAccountId'])}' to itself — a migration marker names two different account identities.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.toAccountId` },
          },
        );
      }
      if (event['reason'] !== undefined) {
        requireIdentityString(functionName, `${path}.reason`, event['reason']);
      }
      break;
    }
    case 'corporate.split': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      for (const field of ['sharesAfterSplit', 'sharesBeforeSplit'] as const) {
        const value = event[field];
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
          throw new InputError(
            `${functionName}: ${path}.${field} must be a positive safe-integer share count (a 2-for-1 split is { sharesAfterSplit: 2, sharesBeforeSplit: 1 }; ratios past 2^53 are not share counts). Received ${value === null ? 'null' : typeof value === 'number' ? value : typeof value}.`,
            {
              code:
                typeof value === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
              context: { function: functionName, field: `${path}.${field}` },
            },
          );
        }
      }
      if (event['sharesAfterSplit'] === event['sharesBeforeSplit']) {
        throw new InputError(
          `${functionName}: ${path} declares a ${String(event['sharesAfterSplit'])}-for-${String(event['sharesBeforeSplit'])} split — a 1:1 "split" changes nothing and is not an economic event.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.sharesAfterSplit` },
          },
        );
      }
      break;
    }
    case 'derivative.exercise':
    case 'derivative.assignment': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      requireQuantityField(functionName, path, event, 'the contracts settled');
      requireDerivativeSettlement(functionName, `${path}.settlement`, event['settlement']);
      requireEnumField(
        functionName,
        `${path}.premiumTreatment`,
        event['premiumTreatment'],
        PREMIUM_TREATMENTS,
      );
      requireOptionalSettle(functionName, path, event, envelope.effectiveTimestampMs);
      requireLotSelectionsShape(functionName, path, event['lotSelections']);
      break;
    }
    case 'derivative.expiration': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      requireQuantityField(functionName, path, event, 'the contracts expiring');
      requireLotSelectionsShape(functionName, path, event['lotSelections']);
      break;
    }
    case 'derivative.multiplier-change': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      requirePositiveNumberField(
        functionName,
        `${path}.contractMultiplierAfter`,
        event['contractMultiplierAfter'],
        'the adjusted units of the underlying per contract',
      );
      if (event['strikePricePerUnitAfter'] !== undefined) {
        requireFiniteNumberField(
          functionName,
          `${path}.strikePricePerUnitAfter`,
          event['strikePricePerUnitAfter'],
        );
      }
      if (event['reason'] !== undefined && typeof event['reason'] !== 'string') {
        throw new InputError(`${functionName}: ${path}.reason must be a string.`, {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${path}.reason` },
        });
      }
      break;
    }
    case 'derivative.variation-margin': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      requireFiniteNumberField(
        functionName,
        `${path}.settlementPricePerUnit`,
        event['settlementPricePerUnit'],
      );
      break;
    }
    case 'derivative.roll': {
      requireIdentityString(functionName, `${path}.fromInstrumentId`, event['fromInstrumentId']);
      requireIdentityString(functionName, `${path}.toInstrumentId`, event['toInstrumentId']);
      if (event['fromInstrumentId'] === event['toInstrumentId']) {
        throw new InputError(
          `${functionName}: ${path} rolls ${String(event['fromInstrumentId'])} into itself — a roll closes one contract and opens its successor.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.toInstrumentId` },
          },
        );
      }
      requireQuantityField(functionName, path, event, 'the contracts rolled');
      requireFiniteNumberField(
        functionName,
        `${path}.closePricePerUnit`,
        event['closePricePerUnit'],
      );
      requireFiniteNumberField(functionName, `${path}.openPricePerUnit`, event['openPricePerUnit']);
      if (event['contract'] !== undefined) {
        requireContractTerms(functionName, `${path}.contract`, event['contract']);
        requireContractLiveAt(
          functionName,
          `${path}.contract`,
          event['contract'],
          envelope.effectiveTimestampMs,
        );
      }
      requireLotSelectionsShape(functionName, path, event['lotSelections']);
      break;
    }
    case 'fixed-income.redemption': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      requireEnumField(
        functionName,
        `${path}.redemptionType`,
        event['redemptionType'],
        REDEMPTION_TYPES,
      );
      requireQuantityField(functionName, path, event, 'the face units redeemed');
      requireFiniteNumberField(functionName, `${path}.pricePerUnit`, event['pricePerUnit']);
      requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      requireOptionalSettle(functionName, path, event, envelope.effectiveTimestampMs);
      requireLotSelectionsShape(functionName, path, event['lotSelections']);
      break;
    }
    case 'corporate.symbol-change': {
      requireIdentityString(functionName, `${path}.fromInstrumentId`, event['fromInstrumentId']);
      requireIdentityString(functionName, `${path}.toInstrumentId`, event['toInstrumentId']);
      if (event['fromInstrumentId'] === event['toInstrumentId']) {
        throw new InputError(
          `${functionName}: ${path} renames ${String(event['fromInstrumentId'])} to itself — not an economic event.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.toInstrumentId` },
          },
        );
      }
      break;
    }
    case 'corporate.merger': {
      requireIdentityString(functionName, `${path}.fromInstrumentId`, event['fromInstrumentId']);
      const hasShares = event['sharesPerShare'] !== undefined;
      const hasCash = event['cashPerShare'] !== undefined;
      if (!hasShares && !hasCash) {
        throw new InputError(
          `${functionName}: ${path} must declare a consideration — sharesPerShare (with toInstrumentId), cashPerShare (with currency), or both.`,
          {
            code: ErrorCode.InputMissingField,
            context: { function: functionName, field: `${path}.sharesPerShare` },
          },
        );
      }
      if (hasShares) {
        requirePositiveNumberField(
          functionName,
          `${path}.sharesPerShare`,
          event['sharesPerShare'],
          'new shares per share held',
        );
        if (event['toInstrumentId'] === undefined) {
          throw new InputError(
            `${functionName}: ${path}.toInstrumentId is required with sharesPerShare — the shares must be of something.`,
            {
              code: ErrorCode.InputMissingField,
              context: { function: functionName, field: `${path}.toInstrumentId` },
            },
          );
        }
        requireIdentityString(functionName, `${path}.toInstrumentId`, event['toInstrumentId']);
        if (event['toInstrumentId'] === event['fromInstrumentId']) {
          throw new InputError(
            `${functionName}: ${path} merges ${String(event['fromInstrumentId'])} into itself — use corporate.split for a share-count change.`,
            {
              code: ErrorCode.InputOutOfRange,
              context: { function: functionName, field: `${path}.toInstrumentId` },
            },
          );
        }
      } else if (event['toInstrumentId'] !== undefined) {
        throw new InputError(
          `${functionName}: ${path}.toInstrumentId is only meaningful with sharesPerShare (a cash merger delivers no shares).`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.toInstrumentId` },
          },
        );
      }
      if (hasCash) {
        requirePositiveNumberField(
          functionName,
          `${path}.cashPerShare`,
          event['cashPerShare'],
          'cash per share held',
        );
        requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      } else if (event['currency'] !== undefined) {
        throw new InputError(
          `${functionName}: ${path}.currency is only meaningful with cashPerShare.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.currency` },
          },
        );
      }
      requireOptionalSettle(functionName, path, event, envelope.effectiveTimestampMs);
      break;
    }
    case 'corporate.spin-off': {
      requireIdentityString(
        functionName,
        `${path}.parentInstrumentId`,
        event['parentInstrumentId'],
      );
      requireIdentityString(functionName, `${path}.childInstrumentId`, event['childInstrumentId']);
      if (event['parentInstrumentId'] === event['childInstrumentId']) {
        throw new InputError(
          `${functionName}: ${path} spins ${String(event['parentInstrumentId'])} off from itself.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.childInstrumentId` },
          },
        );
      }
      requirePositiveNumberField(
        functionName,
        `${path}.sharesPerParentShare`,
        event['sharesPerParentShare'],
        'child shares per parent share',
      );
      requireFiniteNumberField(
        functionName,
        `${path}.basisAllocationFraction`,
        event['basisAllocationFraction'],
      );
      if (event['basisAllocationFraction'] < 0 || event['basisAllocationFraction'] > 1) {
        throw new InputError(
          `${functionName}: ${path}.basisAllocationFraction is the fraction of the parent's basis that moves to the child, in [0, 1]. Received ${event['basisAllocationFraction']}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.basisAllocationFraction` },
          },
        );
      }
      break;
    }
    case 'corporate.return-of-capital': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      requirePositiveNumberField(
        functionName,
        `${path}.amountPerShare`,
        event['amountPerShare'],
        'capital returned per share held',
      );
      requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      requireOptionalSettle(functionName, path, event, envelope.effectiveTimestampMs);
      break;
    }
    case 'corporate.cash-in-lieu': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      requireQuantityField(functionName, path, event, 'the fractional quantity surrendered');
      requireFiniteNumberField(functionName, `${path}.amount`, event['amount']);
      if (event['amount'] < 0) {
        throw new InputError(
          `${functionName}: ${path}.amount is the cash received in lieu, ≥ 0. Received ${event['amount']}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.amount` },
          },
        );
      }
      requireCurrencyCode(functionName, `${path}.currency`, event['currency']);
      if (event['relatesToEventId'] !== undefined) {
        requireIdentityString(functionName, `${path}.relatesToEventId`, event['relatesToEventId']);
      }
      requireOptionalSettle(functionName, path, event, envelope.effectiveTimestampMs);
      break;
    }
    case 'position.transfer': {
      requireIdentityString(functionName, `${path}.instrumentId`, event['instrumentId']);
      requireQuantityField(functionName, path, event, 'the unsigned quantity moved');
      requireIdentityString(functionName, `${path}.fromAccountId`, event['fromAccountId']);
      requireIdentityString(functionName, `${path}.toAccountId`, event['toAccountId']);
      if (event['fromAccountId'] === event['toAccountId']) {
        throw new InputError(
          `${functionName}: ${path} transfers ${String(event['instrumentId'])} from account '${String(event['fromAccountId'])}' to itself — fromAccountId and toAccountId must differ.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}.toAccountId` },
          },
        );
      }
      if (envelope.accountId !== event['fromAccountId']) {
        throw new InputError(
          `${functionName}: the envelope's accountId ('${envelope.accountId}') must equal ${path}.fromAccountId ('${String(event['fromAccountId'])}') — a transfer is recorded against the account it leaves.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: 'accountId' },
          },
        );
      }
      requireLotSelectionsShape(functionName, path, event['lotSelections']);
      break;
    }
  }
}

/**
 * Validate one {@link PortfolioEventEnvelope} at a public boundary (Law 12 closed request): known
 * keys at every level, identity strings, finite explicit timestamps, the schema version, the
 * envelope/payload discriminator agreement, and the full per-variant payload contract. The guard
 * validates its own `functionName` and `label` first (the `requireFundamentalPeriod` precedent) so
 * its teaching errors always name the real boundary.
 */
export function requirePortfolioEventEnvelope(
  functionName: string,
  label: string,
  envelope: PortfolioEventEnvelope,
): asserts envelope is PortfolioEventEnvelope {
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new InputError(
      `requirePortfolioEventEnvelope: functionName must be a non-empty string (the public boundary being validated). Received ${functionName === null ? 'null' : functionName === undefined ? 'undefined' : typeof functionName === 'string' ? "''" : typeof functionName}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'functionName' } },
    );
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new InputError(
      `requirePortfolioEventEnvelope: label must be a non-empty string (the caller's name for the envelope field being validated). Received ${label === null ? 'null' : label === undefined ? 'undefined' : typeof label === 'string' ? "''" : typeof label}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'label' } },
    );
  }
  requirePlainDataObject(functionName, label, envelope);
  requireNoInheritedFields(functionName, label, envelope, ENVELOPE_KEYS);
  ensureKnownKeys(functionName, label, envelope, ENVELOPE_KEYS);
  requireIdentityString(functionName, `${label}.eventId`, envelope.eventId);
  if (envelope.schemaVersion !== PORTFOLIO_EVENT_SCHEMA_VERSION) {
    const received = describeInputValue(envelope.schemaVersion);
    throw new InputError(
      `${functionName}: ${label}.schemaVersion must be ${PORTFOLIO_EVENT_SCHEMA_VERSION} (this build's event grammar). Received ${received}. Older stored events restore through readPortfolioLedgerSnapshot with a registered migration; a newer version needs a newer @insiderfinance/totalfinance release.\n  e.g. ${EXAMPLE_ENVELOPE}`,
      {
        code:
          typeof envelope.schemaVersion === 'number'
            ? ErrorCode.SnapshotUnsupportedVersion
            : ErrorCode.InputWrongType,
        context: { function: functionName, field: `${label}.schemaVersion`, received },
      },
    );
  }
  requireIdentityString(functionName, `${label}.sourceId`, envelope.sourceId);
  requireIdentityString(functionName, `${label}.accountId`, envelope.accountId);
  requireEpochMsField(functionName, `${label}.effectiveTimestampMs`, envelope.effectiveTimestampMs);
  requireEpochMsField(functionName, `${label}.recordedTimestampMs`, envelope.recordedTimestampMs);
  for (const field of ['correlationId', 'causationId', 'reversesEventId'] as const) {
    if (envelope[field] !== undefined) {
      requireIdentityString(functionName, `${label}.${field}`, envelope[field]);
    }
  }
  {
    // Inspect the discriminator only after proving the nested value is stored data. Optional
    // chaining would otherwise execute an inherited/accessor `eventType` before the payload guard
    // got a chance to refuse it.
    requirePlainDataObject(functionName, `${label}.event`, envelope.event);
    const type = ownValue(envelope.event as unknown as Record<string, unknown>, 'eventType');
    const isRepair = type === 'admin.reversal' || type === 'admin.correction';
    if (envelope.reversesEventId !== undefined && !isRepair) {
      throw new InputError(
        `${functionName}: ${label}.reversesEventId is set, but only admin.reversal and admin.correction fold that link — a ${describeInputValue(type)} event cannot reverse anything (its own effect stands). Record an admin.reversal naming the fact, or drop the link.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.reversesEventId` },
        },
      );
    }
    if (envelope.reversesEventId === undefined && isRepair) {
      throw new InputError(
        `${functionName}: ${label}.reversesEventId is required on an ${describeInputValue(type)} — the envelope names the applied fact it repairs (equal to event.original.eventId).`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field: `${label}.reversesEventId` },
        },
      );
    }
  }
  if (envelope.provenance === undefined) {
    throw new InputError(
      `${functionName}: ${label}.provenance is required — every economic event states where it came from (an empty object {} is a valid "no further detail"). It is caller-supplied, never fetched, and excluded from the event identity.\n  e.g. ${EXAMPLE_ENVELOPE}`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: `${label}.provenance` },
      },
    );
  }
  requireProvenanceShape(functionName, `${label}.provenance`, envelope.provenance);
  validateEventPayload(functionName, `${label}.event`, envelope);
}

/**
 * The event's content identity and the CONFLICT boundary for duplicate `(sourceId, eventId)`
 * delivery: the `sha256:` content hash (Gate B canonical JSON) of the envelope EXCLUDING
 * `provenance` — two deliveries of the same economic fact under different source labels are the
 * SAME event (Gate B Decision 3: provenance is outside every identity). The envelope is fully
 * validated first; a malformed envelope never acquires a confident-looking hash.
 */
export function portfolioEventContentHash(envelope: PortfolioEventEnvelope): string {
  requirePortfolioEventEnvelope('portfolioEventContentHash', 'envelope', envelope);
  const body: Record<string, unknown> = { ...envelope };
  delete body['provenance'];
  return contentHash(body);
}

/**
 * The `(sourceId, eventId)` duplicate-boundary key — the exact registry key `PortfolioState`
 * records under `appliedEvents`, exposed so stores and importers can pre-check delivery without
 * re-deriving the encoding.
 */
export function duplicateBoundaryKey(envelope: PortfolioEventEnvelope): string {
  // A boundary, not a shortcut: the key is only meaningful for a VALID envelope, so the full
  // closed-key validator runs here exactly as it does for the content hash — a malformed or
  // decorated envelope teaches instead of reading `sourceId` off `undefined` (2026-08-28).
  requirePortfolioEventEnvelope('duplicateBoundaryKey', 'envelope', envelope);
  return canonicalJsonOf([envelope.sourceId, envelope.eventId]);
}

// ---------------------------------------------------------------------------------------------------
// The normalized fill — the audited bridge from an execution fact to economic events (Stage 4.6,
// FC8 Decision 2). Backtest, deterministic replay, paper, and live adapters all produce THIS shape;
// the ledger records the `trade.fill` and `cost.charge` events it maps to. The package owns the
// bridge so no simulator or broker adapter defines a fill of its own.
// ---------------------------------------------------------------------------------------------------

/** Additional cash charges, each in the fill's currency, ≥ 0. Never repeat costs embedded in pricePerUnit. */
export interface NormalizedFillCosts {
  commission?: number;
  exchangeFees?: number;
  regulatoryFees?: number;
  slippageAdjustment?: number;
}

/** Whether the fill added liquidity (rested) or removed it (crossed); unknown when the venue did not say. */
export type NormalizedFillLiquidity = 'maker' | 'taker' | 'unknown';

/**
 * One execution fact, normalized. Everything an economic ledger needs to book the fill is here;
 * nothing about the order's journey (acknowledgements, partials, replacements) is — that is the
 * execution journal's, which stays separate from the ledger by design.
 */
export interface NormalizedFill {
  /** Unique within `sourceId`; becomes the `trade.fill` event's id, so a replayed fill folds once. */
  fillId: string;
  accountId: string;
  instrumentId: string;
  side: 'buy' | 'sell';
  /** Filled quantity, > 0 (fractional supported); `side` carries the direction. */
  quantity: number;
  /** Execution price per unit in `currency`. Finite; sign-unconstrained (negative prints are real). */
  pricePerUnit: number;
  currency: string;
  /** When the fill happened — the event's effective instant. */
  filledTimestampMs: EpochMs;
  /** When the cash leg settles; omitted = settles at the fill. Never before `filledTimestampMs`. */
  settleTimestampMs?: EpochMs;
  /** Units of the underlying per unit of quantity; REQUIRED when `contract` is given (the ledger's law). */
  contractMultiplier?: number;
  settlementStyle?: SettlementStyle;
  contract?: DerivativeContractTerms;
  /** Accrued interest paid (bought) or received (sold) with a bond fill, in `currency`. */
  accruedInterest?: number;
  costs?: NormalizedFillCosts;
  /** Absolute execution-price deviation × quantity × multiplier, in currency, ≥ 0. Attribution
   * only: already embedded in pricePerUnit, NEVER emitted as another cash charge. */
  executionPriceAdjustment?: number;
  /** The order this fill answers; becomes the events' `correlationId`. */
  orderId?: string;
  venue?: string;
  liquidity?: NormalizedFillLiquidity;
}

export const NORMALIZED_FILL_KEYS = [
  'fillId',
  'accountId',
  'instrumentId',
  'side',
  'quantity',
  'pricePerUnit',
  'currency',
  'filledTimestampMs',
  'settleTimestampMs',
  'contractMultiplier',
  'settlementStyle',
  'contract',
  'accruedInterest',
  'costs',
  'executionPriceAdjustment',
  'orderId',
  'venue',
  'liquidity',
] as const;

const NORMALIZED_FILL_COST_KEYS = [
  'commission',
  'exchangeFees',
  'regulatoryFees',
  'slippageAdjustment',
] as const;

/** Cost component → the ledger's `costType` and the event-id suffix, in emission order. */
const COST_COMPONENTS: readonly (readonly [keyof NormalizedFillCosts, CostType])[] = [
  ['commission', 'commission'],
  ['exchangeFees', 'exchange-fee'],
  ['regulatoryFees', 'regulatory-fee'],
  ['slippageAdjustment', 'slippage-adjustment'],
];

const EXAMPLE_FILL =
  "portfolioEventsFromFill({ fill: { fillId: 'f-1', accountId: 'main', instrumentId: 'AAPL', side: 'buy', quantity: 100, pricePerUnit: 150, currency: 'USD', filledTimestampMs: 1767200400000, costs: { commission: 1 } }, sourceId: 'backtest:run-1', recordedTimestampMs: 1767200400000 })";

/**
 * Validate a {@link NormalizedFill} at a public boundary: a closed plain-data record whose numbers
 * are finite, whose quantity is positive, whose settlement never precedes the fill, whose cost
 * components are non-negative, and whose derivative terms come with their multiplier. The
 * economic laws a fill must satisfy inside the ledger (a future settles by variation margin, a lot
 * selection names real lots, …) are enforced by the event validator the mapped events pass through.
 */
export function requireNormalizedFill(
  functionName: string,
  label: string,
  fill: unknown,
): asserts fill is NormalizedFill {
  requirePlainDataObject(functionName, label, fill);
  requireNoInheritedFields(functionName, label, fill, NORMALIZED_FILL_KEYS);
  ensureKnownKeys(functionName, label, fill, NORMALIZED_FILL_KEYS);
  const record = fill as Record<string, unknown>;
  for (const field of ['fillId', 'accountId', 'instrumentId'] as const) {
    requireIdentityString(functionName, `${label}.${field}`, record[field]);
  }
  if (record['side'] !== 'buy' && record['side'] !== 'sell') {
    throw new InputError(
      `${functionName}: ${label}.side must be 'buy' | 'sell'. Received ${describeInputValue(record['side'])}.\n  e.g. ${EXAMPLE_FILL}`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: `${label}.side` },
      },
    );
  }
  requirePositiveNumberField(
    functionName,
    `${label}.quantity`,
    record['quantity'],
    'the filled quantity; side carries the direction',
  );
  requireFiniteNumberField(functionName, `${label}.pricePerUnit`, record['pricePerUnit']);
  requireCurrencyCode(functionName, `${label}.currency`, record['currency']);
  requireEpochMsField(functionName, `${label}.filledTimestampMs`, record['filledTimestampMs']);
  if (hasOwnKey(record, 'settleTimestampMs')) {
    requireEpochMsField(functionName, `${label}.settleTimestampMs`, record['settleTimestampMs']);
    if ((record['settleTimestampMs'] as number) < (record['filledTimestampMs'] as number)) {
      throw new InputError(
        `${functionName}: ${label}.settleTimestampMs (${String(record['settleTimestampMs'])}) precedes filledTimestampMs (${String(record['filledTimestampMs'])}) — cash settles at or after the fill, never before.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.settleTimestampMs` },
        },
      );
    }
  }
  if (hasOwnKey(record, 'contractMultiplier')) {
    requirePositiveNumberField(
      functionName,
      `${label}.contractMultiplier`,
      record['contractMultiplier'],
      'units of the underlying per unit of quantity',
    );
  }
  if (hasOwnKey(record, 'settlementStyle')) {
    if (
      record['settlementStyle'] !== 'cash-on-trade' &&
      record['settlementStyle'] !== 'variation-margin'
    ) {
      throw new InputError(
        `${functionName}: ${label}.settlementStyle must be 'cash-on-trade' | 'variation-margin'. Received ${describeInputValue(record['settlementStyle'])}.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { function: functionName, field: `${label}.settlementStyle` },
        },
      );
    }
  }
  if (hasOwnKey(record, 'contract')) {
    requirePlainDataObject(functionName, `${label}.contract`, record['contract']);
    if (!hasOwnKey(record, 'contractMultiplier')) {
      throw new InputError(
        `${functionName}: ${label}.contract is given but ${label}.contractMultiplier is not — a derivative fill states its multiplier (an equity option's 100, a futures contract size); the ledger never assumes one.`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field: `${label}.contractMultiplier` },
        },
      );
    }
  }
  if (hasOwnKey(record, 'accruedInterest')) {
    requireFiniteNumberField(functionName, `${label}.accruedInterest`, record['accruedInterest']);
  }
  if (hasOwnKey(record, 'costs')) {
    requirePlainDataObject(functionName, `${label}.costs`, record['costs']);
    const costs = record['costs'] as Record<string, unknown>;
    requireNoInheritedFields(functionName, `${label}.costs`, costs, NORMALIZED_FILL_COST_KEYS);
    ensureKnownKeys(functionName, `${label}.costs`, costs, NORMALIZED_FILL_COST_KEYS);
    for (const component of NORMALIZED_FILL_COST_KEYS) {
      if (!hasOwnKey(costs, component)) continue;
      requireFiniteNumberField(functionName, `${label}.costs.${component}`, costs[component]);
      if ((costs[component] as number) < 0) {
        throw new InputError(
          `${functionName}: ${label}.costs.${component} must be ≥ 0 (a cost the account paid, in ${String(record['currency'])}); a rebate is income, not a negative cost. Received ${String(costs[component])}.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${label}.costs.${component}` },
          },
        );
      }
    }
  }
  if (hasOwnKey(record, 'executionPriceAdjustment')) {
    requireFiniteNumberField(
      functionName,
      `${label}.executionPriceAdjustment`,
      record['executionPriceAdjustment'],
    );
    if ((record['executionPriceAdjustment'] as number) < 0)
      throw new InputError(
        `${functionName}: ${label}.executionPriceAdjustment must be non-negative; it reports the absolute price deviation already embedded in the fill.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.executionPriceAdjustment` },
        },
      );
  }
  if (hasOwnKey(record, 'orderId')) {
    requireIdentityString(functionName, `${label}.orderId`, record['orderId']);
  }
  if (hasOwnKey(record, 'venue')) {
    requireIdentityString(functionName, `${label}.venue`, record['venue']);
  }
  if (hasOwnKey(record, 'liquidity')) {
    const liquidity = record['liquidity'];
    if (liquidity !== 'maker' && liquidity !== 'taker' && liquidity !== 'unknown') {
      throw new InputError(
        `${functionName}: ${label}.liquidity must be 'maker' | 'taker' | 'unknown'. Received ${describeInputValue(liquidity)}.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { function: functionName, field: `${label}.liquidity` },
        },
      );
    }
  }
}

/** Input for {@link portfolioEventsFromFill}. */
export interface PortfolioEventsFromFillInput {
  fill: NormalizedFill;
  /** The system that produced the fill — `'backtest:<runId>'`, a broker import id, a paper account. */
  sourceId: string;
  /** When the events are recorded — supplied, never read from a clock. */
  recordedTimestampMs: EpochMs;
  /** Where the fill came from; `{}` when there is no further detail. Outside the event identity. */
  provenance?: Provenance;
}

const EVENTS_FROM_FILL_KEYS = ['fill', 'sourceId', 'recordedTimestampMs', 'provenance'] as const;

/**
 * Map one {@link NormalizedFill} to the economic events the ledger folds: exactly one `trade.fill`
 * (id = `fillId`) followed by one `cost.charge` per non-zero cost component (id =
 * `<fillId>:cost:<component>`, `relatesToEventId` = the fill), in the fixed order commission →
 * exchange fees → regulatory fees → slippage adjustment. The mapping is deterministic and the ids
 * are derived from the fill, so an identical fill delivered twice folds once (the ledger's
 * duplicate boundary) and a replay emits identical envelopes. Every envelope passes the same
 * validator a hand-written one would.
 */
export function portfolioEventsFromFill(
  input: PortfolioEventsFromFillInput,
): PortfolioEventEnvelope[] {
  const functionName = 'portfolioEventsFromFill';
  requirePlainDataObject(functionName, 'input', input);
  requireNoInheritedFields(functionName, 'input', input, EVENTS_FROM_FILL_KEYS);
  ensureKnownKeys(functionName, 'input', input, EVENTS_FROM_FILL_KEYS);
  const { fill, sourceId, recordedTimestampMs } = input;
  requireNormalizedFill(functionName, 'input.fill', fill);
  requireIdentityString(functionName, 'input.sourceId', sourceId);
  requireEpochMsField(functionName, 'input.recordedTimestampMs', recordedTimestampMs);
  const provenance: Provenance = hasOwnKey(input, 'provenance')
    ? (input.provenance as Provenance)
    : {};
  requireProvenanceShape(functionName, 'input.provenance', provenance);

  const tradeFill: TradeFillEvent = {
    eventType: 'trade.fill',
    instrumentId: fill.instrumentId,
    side: fill.side,
    quantity: fill.quantity,
    pricePerUnit: fill.pricePerUnit,
    currency: fill.currency,
    ...(fill.settleTimestampMs !== undefined ? { settleTimestampMs: fill.settleTimestampMs } : {}),
    ...(fill.contractMultiplier !== undefined
      ? { contractMultiplier: fill.contractMultiplier }
      : {}),
    ...(fill.settlementStyle !== undefined ? { settlementStyle: fill.settlementStyle } : {}),
    ...(fill.contract !== undefined ? { contract: cloneJson(fill.contract) } : {}),
    ...(fill.accruedInterest !== undefined ? { accruedInterest: fill.accruedInterest } : {}),
  };
  const correlation = fill.orderId !== undefined ? { correlationId: fill.orderId } : {};
  const envelopes: PortfolioEventEnvelope[] = [
    {
      eventId: fill.fillId,
      schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
      eventType: 'trade.fill',
      sourceId,
      accountId: fill.accountId,
      effectiveTimestampMs: fill.filledTimestampMs,
      recordedTimestampMs,
      ...correlation,
      event: tradeFill,
      provenance: cloneJson(provenance),
    },
  ];
  const costs = fill.costs ?? {};
  for (const [component, costType] of COST_COMPONENTS) {
    const amount = costs[component];
    if (amount === undefined || amount === 0) continue;
    const charge: CostChargeEvent = {
      eventType: 'cost.charge',
      costType,
      amount,
      currency: fill.currency,
      instrumentId: fill.instrumentId,
      relatesToEventId: fill.fillId,
    };
    envelopes.push({
      eventId: `${fill.fillId}:cost:${component}`,
      schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
      eventType: 'cost.charge',
      sourceId,
      accountId: fill.accountId,
      effectiveTimestampMs: fill.filledTimestampMs,
      recordedTimestampMs,
      ...correlation,
      causationId: fill.fillId,
      event: charge,
      provenance: cloneJson(provenance),
    });
  }
  envelopes.forEach((envelope, index) =>
    requirePortfolioEventEnvelope(functionName, `events[${index}]`, envelope),
  );
  return envelopes;
}
