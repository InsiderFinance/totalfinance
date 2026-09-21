/**
 * The FC7 pure reducer: `PortfolioState` is a FOLD over immutable economic events (agent-native
 * platform doc, Permanent law 1 — "Portfolio truth is event-derived"; spec D16). Same events →
 * same state, always: the fold reads no clock, no locale, no global registry, and never mutates
 * its inputs. Replaying an identical `(sourceId, eventId)` envelope is a no-op; a same-key
 * envelope with a different body is a typed conflict (`portfolio.duplicate_event_conflict`).
 *
 * The fold derives FACTS ONLY: cash by currency (with each leg's settlement schedule — the
 * settled/unsettled SPLIT is classified at an explicit `asOf` by `portfolioSnapshot`, keeping the
 * fold clock-free), positions with signed fractional tax lots, realized P&L from lot relief, and
 * income/cost/financing accumulators. Unrealized P&L, NAV, and base-currency values need marks
 * and are derived reports (Permanent law 2 — "P&L is a derived result, not a ledger event").
 */

import type { EpochMs } from '@totalfinance/core';
import {
  requireRepresentableResult,
  DataError,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  canonicalJsonOf,
  fromCanonicalJson,
  isContentHashString,
} from '@totalfinance/core/artifacts';
import type {
  CashConversionEvent,
  CashDepositEvent,
  CashTransferEvent,
  CashWithdrawalEvent,
  CostChargeEvent,
  DerivativeContractTerms,
  FinancingChargeEvent,
  IncomeReceivedEvent,
  PortfolioEventEnvelope,
  SettlementStyle,
  StockSplitEvent,
  TradeFillEvent,
} from './events.js';
import { applyCorporateEvent, reverseCorporateEvent } from './lifecycle-corporate.js';
import { applyDerivativeEvent, reverseDerivativeEvent } from './lifecycle-derivatives.js';
import type { PositionProfile } from './reducer-kernel.js';
import {
  accountOf,
  addTo,
  addToInstrument,
  bookCash,
  cashOf,
  ensurePosition,
  finalizePosition,
  foldPositionLeg,
  infeasible,
  recordIncome,
  removeSettlementLeg,
} from './reducer-kernel.js';
export { reliefOrder } from './reducer-kernel.js';
import {
  duplicateBoundaryKey,
  portfolioEventContentHash,
  requirePortfolioEventEnvelope,
} from './events.js';
import type { PortfolioLedger } from './ledger.js';
import {
  describeInputValue,
  requireProvenanceShape,
  QUANTITY_DUST,
  deepFreeze,
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
  setOwnValue,
} from './internal.js';

// ---------------------------------------------------------------------------------------------------
// State contracts
// ---------------------------------------------------------------------------------------------------

/** The decided lot-relief set (agent-native doc, "Initial accounting scope"). */
export type LotReliefPolicy = 'fifo' | 'lifo' | 'highest-cost' | 'specific-lot';

const LOT_RELIEF_POLICIES: readonly LotReliefPolicy[] = [
  'fifo',
  'lifo',
  'highest-cost',
  'specific-lot',
];

/** One dated cash leg: `amount` (signed) becomes settled once `asOf ≥ settleTimestampMs`. */
export interface ScheduledSettlement {
  /** The envelope `eventId` that booked this leg. */
  eventId: string;
  /** Signed cash effect: positive = incoming (receivable until settled), negative = payable. */
  amount: number;
  settleTimestampMs: EpochMs;
}

/** One currency's cash: the booked total plus the settlement schedule of its dated legs. */
export interface CashBalance {
  /** The booked balance including not-yet-settled legs. May be negative (margin/overdraft). */
  totalAmount: number;
  settlementSchedule: ScheduledSettlement[];
}

/** One tax lot. Long lots have `quantity > 0`; short lots `quantity < 0`. */
export interface TaxLot {
  /** Deterministic fold identity (`lot-<n>`), stable across replays — addressable by
   * `specific-lot` relief. */
  lotId: string;
  openedByEventId: string;
  openedTimestampMs: EpochMs;
  /** Signed remaining quantity; fractional supported. */
  quantity: number;
  /** For long lots: acquisition price per unit. For short lots: opening proceeds per unit. */
  costBasisPerUnit: number;
}

/** One instrument's open position in one account. */
export interface PositionState {
  instrumentId: string;
  /** The ONE trading currency of this position's fills (mixed currencies refuse). */
  currency: string;
  /** Units of the underlying per unit of `quantity` (slice 5): 1 for shares, an option's 100, a futures contract size. */
  contractMultiplier: number;
  /** `'cash-on-trade'` (equities, options, spot) or `'variation-margin'` (futures, perpetuals). */
  settlementStyle: SettlementStyle;
  /** The derivative's terms, carried from the opening fill. */
  contract?: DerivativeContractTerms;
  /** Signed net quantity — always the sum of `lots[].quantity`. */
  quantity: number;
  lots: TaxLot[];
}

/** One account's derived facts. Accumulators are keyed by uppercase currency code. */
export interface AccountState {
  cashBalances: Record<string, CashBalance>;
  positions: Record<string, PositionState>;
  /** Realized P&L from lot relief under the state's `lotRelief` policy, by currency. */
  realizedPnl: Record<string, number>;
  /** Income received (dividends, coupons, interest, staking, funding receipts), by currency. */
  incomeReceived: Record<string, number>;
  /** Transaction costs charged (commissions, fees, slippage adjustments), by currency. */
  transactionCosts: Record<string, number>;
  /** Financing charged (margin interest, borrow, funding payments), by currency. */
  financingCosts: Record<string, number>;
  /**
   * Per-instrument attribution of the realized, income, and cost accumulators (slice 2,
   * 2026-08-28): `instrumentId → currency → amount`. Realized P&L always carries the instrument;
   * income and costs carry it only when the event named one (unattributed amounts stay in the
   * account-level totals above and are reported as such by `portfolioPnl`). These survive a
   * position closing — `positions` drops a flat instrument, its history does not disappear.
   */
  realizedPnlByInstrument: Record<string, Record<string, number>>;
  incomeByInstrument: Record<string, Record<string, number>>;
  transactionCostsByInstrument: Record<string, Record<string, number>>;
}

/**
 * 2 (2026-08-28, FC7 slice 2): accounts gained the per-instrument attribution maps.
 * 3 (2026-08-28, FC7 slice 3): the fold records per-fill effects (for exact reversal), the
 * reversal links, and account-migration markers.
 * 4 (2026-08-29, FC7 slice 5): positions carry their instrument profile (contract multiplier,
 * settlement style, derivative terms) and fill effects record the cash they booked.
 */
export const PORTFOLIO_STATE_SCHEMA_VERSION = 4;

/** What one applied fill did — the facts an exact reversal needs (slice 3). */
export interface FillEffect {
  accountId: string;
  instrumentId: string;
  currency: string;
  /** Lot ids this fill OPENED (in order). Empty when the fill only relieved. */
  openedLotIds: string[];
  /** Quantity this fill relieved from prior lots — non-zero means the fill is not exactly reversible. */
  relievedQuantity: number;
  realizedPnl: number;
  /** The signed cash the fill booked (price × quantity × multiplier, or the realized variation-margin P&L), incl. accrued interest. */
  cashDelta: number;
  /** Signed accrued interest exchanged (negative = paid on a buy), booked as income. */
  accruedInterest: number;
}

/** An account-migration marker as folded (slice 3): the fact IS the marker; no economic effect. */
export interface AccountMigrationMarker {
  eventId: string;
  fromAccountId: string;
  toAccountId: string;
  effectiveTimestampMs: EpochMs;
}

/**
 * The derived portfolio state: a JSON-safe, deeply frozen fold result. The economic policy that
 * shaped it (`baseCurrency`, `lotRelief`) is echoed ON the state, and the applied-event registry
 * makes replay idempotent and conflict-detecting.
 */
export interface PortfolioState {
  schemaVersion: number;
  portfolioId?: string;
  baseCurrency: string;
  /** The lot-relief policy every realized figure in this state was computed under. */
  lotRelief: LotReliefPolicy;
  accounts: Record<string, AccountState>;
  /** `(sourceId, eventId)` → event content hash — the duplicate/conflict boundary. */
  appliedEvents: Record<string, string>;
  eventCount: number;
  lastEffectiveTimestampMs: EpochMs | null;
  /** Fold-deterministic lot-id counter (`lot-<n>`). */
  lotSequence: number;
  /** Registry key of every applied `trade.fill` → what it did (slice 3; exact reversal needs it). */
  fillEffects: Record<string, FillEffect>;
  /** Registry key of every reversed fact → registry key of the admin event that reversed it. */
  reversals: Record<string, string>;
  /** Account-migration markers in fold order. */
  accountMigrations: AccountMigrationMarker[];
}

/** The fresh-ledger definition accepted by {@link applyPortfolioEvents} and the ledger artifact. */
export interface PortfolioDefinition {
  portfolioId?: string;
  baseCurrency: string;
  /** Defaults to `'fifo'` (documented; echoed on the state and every ledger envelope). */
  lotRelief?: LotReliefPolicy;
}

/** Input for {@link applyPortfolioEvents}: exactly ONE of `portfolio` (fresh) or `previousState`. */
export interface ApplyPortfolioEventsInput {
  portfolio?: PortfolioDefinition;
  previousState?: PortfolioState;
  events: readonly PortfolioEventEnvelope[];
}

// ---------------------------------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------------------------------

const APPLY_KEYS = ['portfolio', 'previousState', 'events'] as const;
const DEFINITION_KEYS = ['portfolioId', 'baseCurrency', 'lotRelief'] as const;
const STATE_KEYS = [
  'schemaVersion',
  'portfolioId',
  'baseCurrency',
  'lotRelief',
  'accounts',
  'appliedEvents',
  'eventCount',
  'lastEffectiveTimestampMs',
  'lotSequence',
  'fillEffects',
  'reversals',
  'accountMigrations',
] as const;
const REQUIRED_STATE_KEYS = STATE_KEYS.filter((key) => key !== 'portfolioId');
const ACCOUNT_KEYS = [
  'cashBalances',
  'positions',
  'realizedPnl',
  'incomeReceived',
  'transactionCosts',
  'financingCosts',
  'realizedPnlByInstrument',
  'incomeByInstrument',
  'transactionCostsByInstrument',
] as const;
const CASH_BALANCE_KEYS = ['totalAmount', 'settlementSchedule'] as const;
const SETTLEMENT_KEYS = ['eventId', 'amount', 'settleTimestampMs'] as const;
const POSITION_KEYS = [
  'instrumentId',
  'currency',
  'contractMultiplier',
  'settlementStyle',
  'contract',
  'quantity',
  'lots',
] as const;
const REQUIRED_POSITION_KEYS = POSITION_KEYS.filter((key) => key !== 'contract');
const LOT_KEYS = [
  'lotId',
  'openedByEventId',
  'openedTimestampMs',
  'quantity',
  'costBasisPerUnit',
] as const;
const FILL_EFFECT_KEYS = [
  'accountId',
  'instrumentId',
  'currency',
  'openedLotIds',
  'relievedQuantity',
  'realizedPnl',
  'cashDelta',
  'accruedInterest',
] as const;
const ACCOUNT_MIGRATION_KEYS = [
  'eventId',
  'fromAccountId',
  'toAccountId',
  'effectiveTimestampMs',
] as const;

const EXAMPLE_APPLY =
  "applyPortfolioEvents({ portfolio: { baseCurrency: 'USD' }, events }) — or continue a fold with " +
  'applyPortfolioEvents({ previousState, events })';

function validateDefinition(functionName: string, definition: PortfolioDefinition): void {
  requirePlainDataObject(functionName, 'portfolio', definition);
  requireNoInheritedFields(functionName, 'portfolio', definition, DEFINITION_KEYS);
  ensureKnownKeys(functionName, 'portfolio', definition, DEFINITION_KEYS);
  if (definition.portfolioId !== undefined) {
    requireIdentityString(functionName, 'portfolio.portfolioId', definition.portfolioId);
  }
  requireCurrencyCode(functionName, 'portfolio.baseCurrency', definition.baseCurrency);
  if (
    definition.lotRelief !== undefined &&
    !(LOT_RELIEF_POLICIES as readonly string[]).includes(definition.lotRelief)
  ) {
    throw new InputError(
      `${functionName}: portfolio.lotRelief must be one of ${LOT_RELIEF_POLICIES.map((p) => `'${p}'`).join(' | ')} (omitted = 'fifo', echoed on the state). Received ${describeInputValue(definition.lotRelief)}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: 'portfolio.lotRelief' },
      },
    );
  }
}

function requireJsonRecord(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is Record<string, unknown> {
  requireArgumentObject(functionName, label, value);
  const record = value as object;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputError(
      `${functionName}: ${label} must be a plain JSON object, not a class instance or an object with a custom prototype. Serialize and parse the state before restoring it.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: label } },
    );
  }
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') {
      throw new InputError(
        `${functionName}: ${label} must contain only string-keyed JSON data; symbol key ${String(key)} cannot survive serialization.`,
        { code: ErrorCode.InputWrongType, context: { function: functionName, field: label } },
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor !== undefined && (!descriptor.enumerable || !('value' in descriptor))) {
      throw new InputError(
        `${functionName}: ${label}[${JSON.stringify(key)}] must be enumerable stored JSON data, not an accessor or hidden property. Restore the serialized state rather than a live object with getters, setters, or non-JSON metadata.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}[${JSON.stringify(key)}]` },
        },
      );
    }
  }
}

function requireOwnFields(
  functionName: string,
  label: string,
  record: object,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (hasOwnKey(record, field)) continue;
    throw new InputError(
      `${functionName}: ${label}.${field} is required in a restored portfolio state — the state must be the complete JSON value returned by TotalFinance, not a partial projection.`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: `${label}.${field}` },
      },
    );
  }
}

function requireDenseArray(functionName: string, label: string, value: unknown): unknown[] {
  requireArgumentArray(functionName, label, value);
  const array = value as unknown[];
  if (Object.getPrototypeOf(array) !== Array.prototype) {
    throw new InputError(
      `${functionName}: ${label} must be a plain JSON array, not an Array subclass or an array with a custom prototype. Serialize and parse the state before restoring it.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: label } },
    );
  }
  for (const key of Reflect.ownKeys(array)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
    const descriptor = Object.getOwnPropertyDescriptor(array, key);
    if (
      typeof key !== 'string' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= array.length ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new InputError(
        `${functionName}: ${label} must contain only dense enumerable JSON array elements; ${String(key)} is an accessor, hidden member, symbol, or non-index property.`,
        { code: ErrorCode.InputWrongType, context: { function: functionName, field: label } },
      );
    }
  }
  for (let index = 0; index < array.length; index += 1) {
    if (hasOwnKey(array, index)) continue;
    throw new InputError(
      `${functionName}: ${label} must be a dense JSON array; index ${index} is missing.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `${label}[${index}]` },
      },
    );
  }
  return array;
}

function requireNonNegativeSafeInteger(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InputError(
      `${functionName}: ${field} must be a non-negative safe integer (at most 2^53 − 1). Received ${describeInputValue(value)}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field } },
    );
  }
}

function dictionaryMember(label: string, key: string): string {
  return `${label}[${JSON.stringify(key)}]`;
}

function requireRegistryKey(functionName: string, field: string, value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new InputError(
      `${functionName}: ${field} must be the canonical [sourceId, eventId] registry key produced by duplicateBoundaryKey. Received ${JSON.stringify(value)}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    parsed[0].length === 0 ||
    typeof parsed[1] !== 'string' ||
    parsed[1].length === 0 ||
    canonicalJsonOf(parsed) !== value
  ) {
    throw new InputError(
      `${functionName}: ${field} must be the canonical [sourceId, eventId] registry key produced by duplicateBoundaryKey. Received ${JSON.stringify(value)}.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
    );
  }
}

function requireCurrencyAmounts(functionName: string, label: string, value: unknown): void {
  requireJsonRecord(functionName, label, value);
  for (const [currency, amount] of Object.entries(value)) {
    const field = dictionaryMember(label, currency);
    requireCurrencyCode(functionName, `${field} (currency key)`, currency);
    requireFiniteNumberField(functionName, field, amount);
  }
}

function requireInstrumentAmounts(functionName: string, label: string, value: unknown): void {
  requireJsonRecord(functionName, label, value);
  for (const [instrumentId, amounts] of Object.entries(value)) {
    const field = dictionaryMember(label, instrumentId);
    requireIdentityString(functionName, `${field} (instrument key)`, instrumentId);
    requireCurrencyAmounts(functionName, field, amounts);
  }
}

function requireContractTermsShape(functionName: string, label: string, value: unknown): string {
  requireJsonRecord(functionName, label, value);
  const kind = ownValue(value, 'kind');
  if (kind !== 'option' && kind !== 'future' && kind !== 'perpetual') {
    throw new InputError(
      `${functionName}: ${label}.kind must be 'option' | 'future' | 'perpetual'. Received ${describeInputValue(kind)}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: `${label}.kind` },
      },
    );
  }
  const commonKeys = ['kind', 'underlyingInstrumentId'] as const;
  const keys =
    kind === 'option'
      ? [...commonKeys, 'type', 'strikePricePerUnit', 'expiryTimestampMs']
      : kind === 'future'
        ? [...commonKeys, 'expiryTimestampMs']
        : commonKeys;
  ensureKnownKeys(functionName, label, value, keys);
  requireOwnFields(functionName, label, value, keys);
  requireIdentityString(
    functionName,
    `${label}.underlyingInstrumentId`,
    ownValue(value, 'underlyingInstrumentId'),
  );
  if (kind === 'option') {
    const optionType = ownValue(value, 'type');
    if (optionType !== 'call' && optionType !== 'put') {
      throw new InputError(
        `${functionName}: ${label}.type must be 'call' | 'put'. Received ${describeInputValue(optionType)}.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { function: functionName, field: `${label}.type` },
        },
      );
    }
    requireFiniteNumberField(
      functionName,
      `${label}.strikePricePerUnit`,
      ownValue(value, 'strikePricePerUnit'),
    );
    requireEpochMsField(
      functionName,
      `${label}.expiryTimestampMs`,
      ownValue(value, 'expiryTimestampMs'),
    );
  } else if (kind === 'future') {
    requireEpochMsField(
      functionName,
      `${label}.expiryTimestampMs`,
      ownValue(value, 'expiryTimestampMs'),
    );
  }
  return kind;
}

interface StateAudit {
  readonly lotIds: Set<string>;
  readonly effectLotIds: Set<string>;
  readonly lastEffectiveTimestampMs: EpochMs | null;
  maximumLotSequence: number;
}

function requireLotIdentity(
  functionName: string,
  field: string,
  value: unknown,
): { lotId: string; sequence: number } {
  requireIdentityString(functionName, field, value);
  const match = /^lot-([1-9][0-9]*)$/.exec(value);
  const sequence = match === null ? Number.NaN : Number(match[1]);
  if (match === null || !Number.isSafeInteger(sequence)) {
    throw new InputError(
      `${functionName}: ${field} must be the deterministic 'lot-<positive safe integer>' identity produced by the fold. Received ${JSON.stringify(value)}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field } },
    );
  }
  return { lotId: value, sequence };
}

function requirePositionShape(
  functionName: string,
  label: string,
  mapInstrumentId: string,
  value: unknown,
  audit: StateAudit,
): void {
  requireJsonRecord(functionName, label, value);
  ensureKnownKeys(functionName, label, value, POSITION_KEYS);
  requireOwnFields(functionName, label, value, REQUIRED_POSITION_KEYS);
  const instrumentId = ownValue(value, 'instrumentId');
  requireIdentityString(functionName, `${label}.instrumentId`, instrumentId);
  if (instrumentId !== mapInstrumentId) {
    throw new InputError(
      `${functionName}: ${label}.instrumentId (${JSON.stringify(instrumentId)}) must equal its positions dictionary key (${JSON.stringify(mapInstrumentId)}) — a restored position cannot disagree with its own identity.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.instrumentId` },
      },
    );
  }
  requireCurrencyCode(functionName, `${label}.currency`, ownValue(value, 'currency'));
  requirePositiveNumberField(
    functionName,
    `${label}.contractMultiplier`,
    ownValue(value, 'contractMultiplier'),
    'units of the underlying per unit of position quantity',
  );
  const settlementStyle = ownValue(value, 'settlementStyle');
  if (settlementStyle !== 'cash-on-trade' && settlementStyle !== 'variation-margin') {
    throw new InputError(
      `${functionName}: ${label}.settlementStyle must be 'cash-on-trade' | 'variation-margin'. Received ${describeInputValue(settlementStyle)}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: `${label}.settlementStyle` },
      },
    );
  }
  const contract = ownValue(value, 'contract');
  if (contract === undefined) {
    if (settlementStyle === 'variation-margin') {
      throw new InputError(
        `${functionName}: ${label}.contract is required for settlementStyle 'variation-margin' — only explicit future or perpetual terms receive variation-margin treatment.`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field: `${label}.contract` },
        },
      );
    }
  } else {
    const kind = requireContractTermsShape(functionName, `${label}.contract`, contract);
    const expectedStyle = kind === 'option' ? 'cash-on-trade' : 'variation-margin';
    if (settlementStyle !== expectedStyle) {
      throw new InputError(
        `${functionName}: ${label}.settlementStyle must be '${expectedStyle}' for contract kind '${kind}'. Received ${describeInputValue(settlementStyle)}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.settlementStyle` },
        },
      );
    }
  }
  const quantity = ownValue(value, 'quantity');
  requireFiniteNumberField(functionName, `${label}.quantity`, quantity);
  if (quantity === 0) {
    throw new InputError(
      `${functionName}: ${label}.quantity must be non-zero — flat positions are removed from the state rather than retained as empty dictionary entries.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.quantity` },
      },
    );
  }
  const lots = requireDenseArray(functionName, `${label}.lots`, ownValue(value, 'lots'));
  if (lots.length === 0) {
    throw new InputError(
      `${functionName}: ${label}.lots must contain the tax lots whose signed sum is the open position quantity.`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: `${label}.lots` },
      },
    );
  }
  let lotQuantity = 0;
  lots.forEach((candidate, index) => {
    const lotLabel = `${label}.lots[${index}]`;
    requireJsonRecord(functionName, lotLabel, candidate);
    ensureKnownKeys(functionName, lotLabel, candidate, LOT_KEYS);
    requireOwnFields(functionName, lotLabel, candidate, LOT_KEYS);
    const { lotId, sequence } = requireLotIdentity(
      functionName,
      `${lotLabel}.lotId`,
      ownValue(candidate, 'lotId'),
    );
    if (audit.lotIds.has(lotId)) {
      throw new InputError(
        `${functionName}: ${lotLabel}.lotId '${lotId}' is duplicated — an open lot identity belongs to exactly one account/instrument position.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${lotLabel}.lotId` },
        },
      );
    }
    audit.lotIds.add(lotId);
    audit.maximumLotSequence = Math.max(audit.maximumLotSequence, sequence);
    requireIdentityString(
      functionName,
      `${lotLabel}.openedByEventId`,
      ownValue(candidate, 'openedByEventId'),
    );
    const openedTimestampMs = ownValue(candidate, 'openedTimestampMs');
    requireEpochMsField(functionName, `${lotLabel}.openedTimestampMs`, openedTimestampMs);
    if (
      audit.lastEffectiveTimestampMs === null ||
      openedTimestampMs > audit.lastEffectiveTimestampMs
    ) {
      throw new InputError(
        `${functionName}: ${lotLabel}.openedTimestampMs (${openedTimestampMs}) must be no later than the state's lastEffectiveTimestampMs (${String(audit.lastEffectiveTimestampMs)}) — a restored fold cannot hold a lot opened by a future event.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${lotLabel}.openedTimestampMs` },
        },
      );
    }
    const quantityOfLot = ownValue(candidate, 'quantity');
    requireFiniteNumberField(functionName, `${lotLabel}.quantity`, quantityOfLot);
    if (quantityOfLot === 0 || Math.sign(quantityOfLot) !== Math.sign(quantity)) {
      throw new InputError(
        `${functionName}: ${lotLabel}.quantity must be non-zero and have the same sign as ${label}.quantity (${String(quantity)}). Received ${String(quantityOfLot)}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${lotLabel}.quantity` },
        },
      );
    }
    requireFiniteNumberField(
      functionName,
      `${lotLabel}.costBasisPerUnit`,
      ownValue(candidate, 'costBasisPerUnit'),
    );
    lotQuantity += quantityOfLot;
  });
  const tolerance = QUANTITY_DUST * Math.max(1, Math.abs(quantity), Math.abs(lotQuantity));
  if (!Number.isFinite(lotQuantity) || Math.abs(lotQuantity - quantity) > tolerance) {
    throw new InputError(
      `${functionName}: ${label}.quantity (${String(quantity)}) must equal the signed sum of ${label}.lots (${String(lotQuantity)}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.quantity` },
      },
    );
  }
}

function requireAccountShape(
  functionName: string,
  label: string,
  value: unknown,
  audit: StateAudit,
): void {
  requireJsonRecord(functionName, label, value);
  ensureKnownKeys(functionName, label, value, ACCOUNT_KEYS);
  requireOwnFields(functionName, label, value, ACCOUNT_KEYS);

  const cashBalances = ownValue(value, 'cashBalances');
  requireJsonRecord(functionName, `${label}.cashBalances`, cashBalances);
  for (const [currency, candidate] of Object.entries(cashBalances)) {
    const balanceLabel = dictionaryMember(`${label}.cashBalances`, currency);
    requireCurrencyCode(functionName, `${balanceLabel} (currency key)`, currency);
    requireJsonRecord(functionName, balanceLabel, candidate);
    ensureKnownKeys(functionName, balanceLabel, candidate, CASH_BALANCE_KEYS);
    requireOwnFields(functionName, balanceLabel, candidate, CASH_BALANCE_KEYS);
    requireFiniteNumberField(
      functionName,
      `${balanceLabel}.totalAmount`,
      ownValue(candidate, 'totalAmount'),
    );
    const schedule = requireDenseArray(
      functionName,
      `${balanceLabel}.settlementSchedule`,
      ownValue(candidate, 'settlementSchedule'),
    );
    schedule.forEach((leg, index) => {
      const legLabel = `${balanceLabel}.settlementSchedule[${index}]`;
      requireJsonRecord(functionName, legLabel, leg);
      ensureKnownKeys(functionName, legLabel, leg, SETTLEMENT_KEYS);
      requireOwnFields(functionName, legLabel, leg, SETTLEMENT_KEYS);
      requireIdentityString(functionName, `${legLabel}.eventId`, ownValue(leg, 'eventId'));
      const amount = ownValue(leg, 'amount');
      requireFiniteNumberField(functionName, `${legLabel}.amount`, amount);
      if (amount === 0) {
        throw new InputError(
          `${functionName}: ${legLabel}.amount must be non-zero — zero-dollar legs are not economic settlements and are never stored.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${legLabel}.amount` },
          },
        );
      }
      requireEpochMsField(
        functionName,
        `${legLabel}.settleTimestampMs`,
        ownValue(leg, 'settleTimestampMs'),
      );
    });
  }

  const positions = ownValue(value, 'positions');
  requireJsonRecord(functionName, `${label}.positions`, positions);
  for (const [instrumentId, candidate] of Object.entries(positions)) {
    const positionLabel = dictionaryMember(`${label}.positions`, instrumentId);
    requireIdentityString(functionName, `${positionLabel} (instrument key)`, instrumentId);
    requirePositionShape(functionName, positionLabel, instrumentId, candidate, audit);
  }
  requireCurrencyAmounts(functionName, `${label}.realizedPnl`, ownValue(value, 'realizedPnl'));
  requireCurrencyAmounts(
    functionName,
    `${label}.incomeReceived`,
    ownValue(value, 'incomeReceived'),
  );
  requireCurrencyAmounts(
    functionName,
    `${label}.transactionCosts`,
    ownValue(value, 'transactionCosts'),
  );
  requireCurrencyAmounts(
    functionName,
    `${label}.financingCosts`,
    ownValue(value, 'financingCosts'),
  );
  requireInstrumentAmounts(
    functionName,
    `${label}.realizedPnlByInstrument`,
    ownValue(value, 'realizedPnlByInstrument'),
  );
  requireInstrumentAmounts(
    functionName,
    `${label}.incomeByInstrument`,
    ownValue(value, 'incomeByInstrument'),
  );
  requireInstrumentAmounts(
    functionName,
    `${label}.transactionCostsByInstrument`,
    ownValue(value, 'transactionCostsByInstrument'),
  );
}

/**
 * Deep validation of a {@link PortfolioState} handed back across a public boundary
 * (`applyPortfolioEvents`' `previousState`, `portfolioSnapshot`'s `portfolio`). A TypeScript type
 * does not survive storage or network transit, so every nested account, cash leg, position, lot,
 * attribution, effect, reversal, migration, and registry link is re-audited before use.
 * Package-internal (imported by the snapshot module); not part of the curated public surface.
 */
export function requirePortfolioStateShape(
  functionName: string,
  label: string,
  state: PortfolioState,
): void {
  requireJsonRecord(functionName, label, state);
  ensureKnownKeys(functionName, label, state, STATE_KEYS);
  requireOwnFields(functionName, label, state, REQUIRED_STATE_KEYS);
  if (state.schemaVersion !== PORTFOLIO_STATE_SCHEMA_VERSION) {
    const received = describeInputValue(state.schemaVersion);
    throw new InputError(
      `${functionName}: ${label}.schemaVersion must be ${PORTFOLIO_STATE_SCHEMA_VERSION} — a state from another build restores through readPortfolioLedgerSnapshot (which re-folds the events), not by handing an old state back in. Received ${received}.`,
      {
        code: ErrorCode.SnapshotUnsupportedVersion,
        context: { function: functionName, field: `${label}.schemaVersion`, received },
      },
    );
  }
  if (hasOwnKey(state, 'portfolioId')) {
    requireIdentityString(functionName, `${label}.portfolioId`, state.portfolioId);
  }
  requireCurrencyCode(functionName, `${label}.baseCurrency`, state.baseCurrency);
  if (!(LOT_RELIEF_POLICIES as readonly string[]).includes(state.lotRelief)) {
    throw new InputError(
      `${functionName}: ${label}.lotRelief must be one of ${LOT_RELIEF_POLICIES.map((p) => `'${p}'`).join(' | ')}. Received ${describeInputValue(state.lotRelief)}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: `${label}.lotRelief` },
      },
    );
  }
  requireNonNegativeSafeInteger(functionName, `${label}.eventCount`, state.eventCount);
  if (
    (state.eventCount === 0 && state.lastEffectiveTimestampMs !== null) ||
    (state.eventCount > 0 && state.lastEffectiveTimestampMs === null)
  ) {
    throw new InputError(
      `${functionName}: ${label}.lastEffectiveTimestampMs must be null exactly when eventCount is 0, and an epoch-millisecond timestamp once events exist. Received eventCount ${state.eventCount} and ${describeInputValue(state.lastEffectiveTimestampMs)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.lastEffectiveTimestampMs` },
      },
    );
  }
  if (state.lastEffectiveTimestampMs !== null) {
    requireEpochMsField(
      functionName,
      `${label}.lastEffectiveTimestampMs`,
      state.lastEffectiveTimestampMs,
    );
  }
  const audit: StateAudit = {
    lotIds: new Set<string>(),
    effectLotIds: new Set<string>(),
    lastEffectiveTimestampMs: state.lastEffectiveTimestampMs,
    maximumLotSequence: 0,
  };
  requireJsonRecord(functionName, `${label}.accounts`, state.accounts);
  for (const [accountId, account] of Object.entries(state.accounts)) {
    const accountLabel = dictionaryMember(`${label}.accounts`, accountId);
    requireIdentityString(functionName, `${accountLabel} (account key)`, accountId);
    requireAccountShape(functionName, accountLabel, account, audit);
  }

  requireJsonRecord(functionName, `${label}.appliedEvents`, state.appliedEvents);
  const appliedKeys = new Set<string>();
  for (const [key, hash] of Object.entries(state.appliedEvents)) {
    const field = dictionaryMember(`${label}.appliedEvents`, key);
    requireRegistryKey(functionName, `${field} (registry key)`, key);
    if (!isContentHashString(hash)) {
      throw new InputError(
        `${functionName}: ${field} must be a 'sha256:<64 lowercase hex>' event content hash. Received ${describeInputValue(hash)}.`,
        { code: ErrorCode.InputWrongType, context: { function: functionName, field } },
      );
    }
    appliedKeys.add(key);
  }

  // Internal consistency (2026-08-28): the count is an ECHO of the applied-event registry, not an
  // independent fact — a restored state whose counter disagrees with its registry was edited by
  // hand or corrupted in transit, and no fold continues from it.
  const registered = Object.keys(state.appliedEvents).length;
  if (state.eventCount !== registered) {
    throw new InputError(
      `${functionName}: ${label}.eventCount (${String(state.eventCount)}) must equal the number of applied events in ${label}.appliedEvents (${registered}) — the count echoes the registry; a state that disagrees with itself is corrupt, not a bigger ledger.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.eventCount`, registered },
      },
    );
  }
  requireNonNegativeSafeInteger(functionName, `${label}.lotSequence`, state.lotSequence);

  requireJsonRecord(functionName, `${label}.fillEffects`, state.fillEffects);
  for (const [key, candidate] of Object.entries(state.fillEffects)) {
    const effectLabel = dictionaryMember(`${label}.fillEffects`, key);
    requireRegistryKey(functionName, `${effectLabel} (registry key)`, key);
    if (!appliedKeys.has(key)) {
      throw new InputError(
        `${functionName}: ${effectLabel} has no matching appliedEvents entry — an effect cannot outlive the event identity that produced it.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: effectLabel },
        },
      );
    }
    requireJsonRecord(functionName, effectLabel, candidate);
    ensureKnownKeys(functionName, effectLabel, candidate, FILL_EFFECT_KEYS);
    requireOwnFields(functionName, effectLabel, candidate, FILL_EFFECT_KEYS);
    const accountId = ownValue(candidate, 'accountId');
    requireIdentityString(functionName, `${effectLabel}.accountId`, accountId);
    if (ownValue(state.accounts, accountId) === undefined) {
      throw new InputError(
        `${functionName}: ${effectLabel}.accountId names ${JSON.stringify(accountId)}, which is absent from ${label}.accounts.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${effectLabel}.accountId` },
        },
      );
    }
    requireIdentityString(
      functionName,
      `${effectLabel}.instrumentId`,
      ownValue(candidate, 'instrumentId'),
    );
    requireCurrencyCode(functionName, `${effectLabel}.currency`, ownValue(candidate, 'currency'));
    const openedLotIds = requireDenseArray(
      functionName,
      `${effectLabel}.openedLotIds`,
      ownValue(candidate, 'openedLotIds'),
    );
    const openedSeen = new Set<string>();
    openedLotIds.forEach((candidateLotId, index) => {
      const openedField = `${effectLabel}.openedLotIds[${index}]`;
      const { lotId, sequence } = requireLotIdentity(functionName, openedField, candidateLotId);
      if (openedSeen.has(lotId)) {
        throw new InputError(
          `${functionName}: ${effectLabel}.openedLotIds repeats '${lotId}' — each opened lot is named once.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${effectLabel}.openedLotIds[${index}]` },
          },
        );
      }
      openedSeen.add(lotId);
      if (audit.effectLotIds.has(lotId)) {
        throw new InputError(
          `${functionName}: ${openedField} repeats lot identity '${lotId}' from another fill effect — one deterministic lot is opened by exactly one event.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: openedField },
          },
        );
      }
      audit.effectLotIds.add(lotId);
      audit.maximumLotSequence = Math.max(audit.maximumLotSequence, sequence);
    });
    const relievedQuantity = ownValue(candidate, 'relievedQuantity');
    requireFiniteNumberField(functionName, `${effectLabel}.relievedQuantity`, relievedQuantity);
    if (relievedQuantity < 0) {
      throw new InputError(
        `${functionName}: ${effectLabel}.relievedQuantity is unsigned and must be >= 0. Received ${relievedQuantity}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${effectLabel}.relievedQuantity` },
        },
      );
    }
    for (const field of ['realizedPnl', 'cashDelta', 'accruedInterest'] as const) {
      requireFiniteNumberField(functionName, `${effectLabel}.${field}`, ownValue(candidate, field));
    }
  }
  if (audit.maximumLotSequence > state.lotSequence) {
    throw new InputError(
      `${functionName}: ${label}.lotSequence (${state.lotSequence}) must be at least the largest open or historically recorded lot suffix (${audit.maximumLotSequence}) — the counter never moves backward or reuses a lot identity.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${label}.lotSequence` },
      },
    );
  }

  requireJsonRecord(functionName, `${label}.reversals`, state.reversals);
  const reversalEvents = new Set<string>();
  for (const [targetKey, reversalKey] of Object.entries(state.reversals)) {
    const field = dictionaryMember(`${label}.reversals`, targetKey);
    requireRegistryKey(functionName, `${field} (target registry key)`, targetKey);
    requireRegistryKey(functionName, field, reversalKey);
    if (!appliedKeys.has(targetKey) || !appliedKeys.has(reversalKey) || targetKey === reversalKey) {
      throw new InputError(
        `${functionName}: ${field} must link two distinct identities that both exist in ${label}.appliedEvents.`,
        { code: ErrorCode.InputOutOfRange, context: { function: functionName, field } },
      );
    }
    if (reversalEvents.has(reversalKey)) {
      throw new InputError(
        `${functionName}: ${field} reuses reversal identity ${reversalKey} — one admin event reverses exactly one applied fact.`,
        { code: ErrorCode.InputOutOfRange, context: { function: functionName, field } },
      );
    }
    reversalEvents.add(reversalKey);
  }

  const migrations = requireDenseArray(
    functionName,
    `${label}.accountMigrations`,
    state.accountMigrations,
  );
  let previousMigrationTimestampMs = Number.NEGATIVE_INFINITY;
  migrations.forEach((candidate, index) => {
    const migrationLabel = `${label}.accountMigrations[${index}]`;
    requireJsonRecord(functionName, migrationLabel, candidate);
    ensureKnownKeys(functionName, migrationLabel, candidate, ACCOUNT_MIGRATION_KEYS);
    requireOwnFields(functionName, migrationLabel, candidate, ACCOUNT_MIGRATION_KEYS);
    requireIdentityString(
      functionName,
      `${migrationLabel}.eventId`,
      ownValue(candidate, 'eventId'),
    );
    const fromAccountId = ownValue(candidate, 'fromAccountId');
    const toAccountId = ownValue(candidate, 'toAccountId');
    requireIdentityString(functionName, `${migrationLabel}.fromAccountId`, fromAccountId);
    requireIdentityString(functionName, `${migrationLabel}.toAccountId`, toAccountId);
    if (fromAccountId === toAccountId) {
      throw new InputError(
        `${functionName}: ${migrationLabel} must name two different account identities.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${migrationLabel}.toAccountId` },
        },
      );
    }
    const effectiveTimestampMs = ownValue(candidate, 'effectiveTimestampMs');
    requireEpochMsField(
      functionName,
      `${migrationLabel}.effectiveTimestampMs`,
      effectiveTimestampMs,
    );
    if (
      state.lastEffectiveTimestampMs === null ||
      effectiveTimestampMs > state.lastEffectiveTimestampMs ||
      effectiveTimestampMs < previousMigrationTimestampMs
    ) {
      throw new InputError(
        `${functionName}: ${migrationLabel}.effectiveTimestampMs (${effectiveTimestampMs}) must preserve fold order and be no later than the state's lastEffectiveTimestampMs (${String(state.lastEffectiveTimestampMs)}).`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${migrationLabel}.effectiveTimestampMs` },
        },
      );
    }
    previousMigrationTimestampMs = effectiveTimestampMs;
  });
}

// ---------------------------------------------------------------------------------------------------
// Fold helpers (operate on the working copy — never on caller data)
// ---------------------------------------------------------------------------------------------------

function applyFill(
  functionName: string,
  state: PortfolioState,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  event: TradeFillEvent,
): void {
  const multiplier = event.contractMultiplier ?? 1;
  const style: SettlementStyle = event.settlementStyle ?? 'cash-on-trade';
  const profile: PositionProfile = {
    currency: event.currency,
    contractMultiplier: multiplier,
    settlementStyle: style,
  };
  if (event.contract !== undefined) profile.contract = event.contract;
  const position = ensurePosition(
    functionName,
    account,
    envelope,
    event.instrumentId,
    profile,
    'event',
  );

  const opposing =
    (event.side === 'buy' && position.quantity < 0) ||
    (event.side === 'sell' && position.quantity > 0);
  const closingQuantity = opposing ? Math.min(event.quantity, Math.abs(position.quantity)) : 0;

  if (event.lotSelections !== undefined && state.lotRelief !== 'specific-lot') {
    throw new InputError(
      `${functionName}: trade.fill event '${envelope.eventId}' carries lotSelections, but this ledger's lotRelief is '${state.lotRelief}' — the selections would be silently ignored. Remove them, or fold under lotRelief: 'specific-lot'.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'event.lotSelections',
          eventId: envelope.eventId,
        },
      },
    );
  }

  if (closingQuantity <= QUANTITY_DUST && event.lotSelections !== undefined) {
    throw new InputError(
      `${functionName}: trade.fill event '${envelope.eventId}' opens a new ${event.side === 'buy' ? 'long' : 'short'} position in ${event.instrumentId} — nothing is relieved, so lotSelections has no meaning here and would be silently ignored. Remove it.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'event.lotSelections',
          eventId: envelope.eventId,
        },
      },
    );
  }
  const leg = foldPositionLeg(
    functionName,
    state,
    account,
    envelope,
    position,
    event.side,
    event.quantity,
    event.pricePerUnit,
    event.lotSelections,
    'event.lotSelections',
    undefined,
  );
  const realized = leg.realizedPnl;
  const openedLotIds = leg.openedLotIds;

  // Cash: price × quantity × multiplier at the fill for cash-on-trade positions; for
  // variation-margin positions nothing at the open and the realized difference on a close.
  // Accrued interest travels with the fill as an income adjustment, never into the lot basis.
  const signedQuantity = event.side === 'buy' ? event.quantity : -event.quantity;
  const accruedSigned =
    event.side === 'buy' ? -(event.accruedInterest ?? 0) : (event.accruedInterest ?? 0);
  const cashDelta =
    (style === 'cash-on-trade' ? -signedQuantity * event.pricePerUnit * multiplier : realized) +
    accruedSigned;
  // A variation-margin opening fill has no cash leg. In particular, a supplied settlement date
  // must not manufacture a zero-dollar schedule entry or an otherwise empty cash balance.
  if (cashDelta !== 0) {
    bookCash(account, event.currency, cashDelta, envelope.eventId, event.settleTimestampMs);
  }
  recordIncome(account, event.instrumentId, event.currency, accruedSigned);

  // What this fill did, keyed by its registry identity — the facts an exact reversal needs.
  setOwnValue(state.fillEffects, duplicateBoundaryKey(envelope), {
    accountId: envelope.accountId,
    instrumentId: event.instrumentId,
    currency: event.currency,
    openedLotIds,
    relievedQuantity: closingQuantity,
    realizedPnl: realized,
    cashDelta,
    accruedInterest: accruedSigned,
  });
}

function applySplit(
  functionName: string,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  event: StockSplitEvent,
): void {
  const position = ownValue(account.positions, event.instrumentId);
  if (position === undefined) {
    throw new InputError(
      `${functionName}: corporate.split event '${envelope.eventId}' names ${event.instrumentId}, but account '${envelope.accountId}' holds no open position in it — a split transforms held lots, so record the position's fills first or drop the event for this account.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'event.instrumentId', eventId: envelope.eventId },
      },
    );
  }
  const ratio = event.sharesAfterSplit / event.sharesBeforeSplit;
  for (const lot of position.lots) {
    lot.quantity *= ratio;
    lot.costBasisPerUnit /= ratio;
  }
  position.quantity = position.lots.reduce((sum, lot) => sum + lot.quantity, 0);
}

/**
 * Reverse an applied fact EXACTLY (slice 3). The registry proves the `original` is what was
 * applied (content hash), the reversal link is recorded, and each family's inverse is applied —
 * or refused with the reason when no exact inverse exists (a fill whose lots were relieved, a
 * split, an already-reversed fact).
 */
/**
 * Undo the economic effect of one applied envelope (`applied`) whose facts were recorded under
 * registry `key` — the per-family exact inverse, or a refusal naming why none exists.
 */
function reverseEffect(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  applied: PortfolioEventEnvelope,
  key: string,
): void {
  const account = ownValue(state.accounts, applied.accountId);
  if (account === undefined) {
    infeasible(functionName, envelope, `account '${applied.accountId}' holds no state.`);
  }
  const target = applied.event;
  switch (target.eventType) {
    case 'cash.deposit': {
      if (
        !removeSettlementLeg(
          account,
          target.currency,
          applied.eventId,
          target.amount,
          target.settleTimestampMs,
        )
      ) {
        infeasible(
          functionName,
          envelope,
          `its dated cash leg is absent or differs from the applied deposit; the carried state is not an exact continuation of that fact.`,
        );
      }
      cashOf(account, target.currency).totalAmount -= target.amount;
      break;
    }
    case 'cash.withdrawal': {
      if (
        !removeSettlementLeg(
          account,
          target.currency,
          applied.eventId,
          -target.amount,
          target.settleTimestampMs,
        )
      ) {
        infeasible(
          functionName,
          envelope,
          `its dated cash leg is absent or differs from the applied withdrawal; the carried state is not an exact continuation of that fact.`,
        );
      }
      cashOf(account, target.currency).totalAmount += target.amount;
      break;
    }
    case 'cash.transfer': {
      cashOf(account, target.currency).totalAmount += target.amount;
      cashOf(accountOf(state, target.toAccountId), target.currency).totalAmount -= target.amount;
      break;
    }
    case 'cash.conversion': {
      cashOf(account, target.fromCurrency).totalAmount += target.fromAmount;
      cashOf(account, target.toCurrency).totalAmount -= target.toAmount;
      break;
    }
    case 'cost.charge': {
      cashOf(account, target.currency).totalAmount += target.amount;
      addTo(account.transactionCosts, target.currency, -target.amount);
      if (target.instrumentId !== undefined) {
        addToInstrument(
          account.transactionCostsByInstrument,
          target.instrumentId,
          target.currency,
          -target.amount,
        );
      }
      break;
    }
    case 'income.received': {
      if (
        !removeSettlementLeg(
          account,
          target.currency,
          applied.eventId,
          target.amount,
          target.settleTimestampMs,
        )
      ) {
        infeasible(
          functionName,
          envelope,
          `its dated cash leg is absent or differs from the applied income; the carried state is not an exact continuation of that fact.`,
        );
      }
      cashOf(account, target.currency).totalAmount -= target.amount;
      addTo(account.incomeReceived, target.currency, -target.amount);
      if (target.instrumentId !== undefined) {
        addToInstrument(
          account.incomeByInstrument,
          target.instrumentId,
          target.currency,
          -target.amount,
        );
      }
      break;
    }
    case 'financing.charge': {
      cashOf(account, target.currency).totalAmount += target.amount;
      addTo(account.financingCosts, target.currency, -target.amount);
      break;
    }
    case 'trade.fill': {
      const effect = ownValue(state.fillEffects, key);
      if (effect === undefined) {
        infeasible(functionName, envelope, `the fold holds no effect record for that fill.`);
      }
      if (effect.relievedQuantity > QUANTITY_DUST) {
        infeasible(
          functionName,
          envelope,
          `the fill relieved ${effect.relievedQuantity} ${target.instrumentId} from prior lots and realized ${effect.realizedPnl} ${target.currency}; relieved lots cannot be restored exactly.`,
        );
      }
      const position = ownValue(account.positions, target.instrumentId);
      const opened = position?.lots.filter((lot) => effect.openedLotIds.includes(lot.lotId)) ?? [];
      const intact =
        opened.length === effect.openedLotIds.length &&
        Math.abs(opened.reduce((sum, lot) => sum + Math.abs(lot.quantity), 0) - target.quantity) <=
          QUANTITY_DUST;
      if (!intact) {
        infeasible(
          functionName,
          envelope,
          `the lots it opened (${effect.openedLotIds.join(', ') || 'none'}) were relieved or rescaled by later events.`,
        );
      }
      position!.lots = position!.lots.filter((lot) => !effect.openedLotIds.includes(lot.lotId));
      finalizePosition(account, position!);
      if (effect.cashDelta !== 0) {
        if (
          !removeSettlementLeg(
            account,
            target.currency,
            applied.eventId,
            effect.cashDelta,
            target.settleTimestampMs,
          )
        ) {
          infeasible(
            functionName,
            envelope,
            `its dated cash leg is absent or differs from the applied fill; the carried state is not an exact continuation of that fact.`,
          );
        }
        cashOf(account, target.currency).totalAmount -= effect.cashDelta;
      }
      recordIncome(account, target.instrumentId, target.currency, -effect.accruedInterest);
      delete state.fillEffects[key];
      break;
    }
    default: {
      const eventType = (target as { eventType: string }).eventType;
      if (eventType.startsWith('derivative.')) {
        reverseDerivativeEvent(functionName, state, envelope, applied, key);
        break;
      }
      if (
        (eventType.startsWith('corporate.') && eventType !== 'corporate.split') ||
        eventType === 'fixed-income.redemption' ||
        eventType === 'position.transfer'
      ) {
        reverseCorporateEvent(functionName, state, envelope, applied, key);
        break;
      }
      infeasible(
        functionName,
        envelope,
        eventType === 'corporate.split'
          ? `a split rescales every open lot; reversing one after later activity has no exact inverse in this build (record a counter-split instead).`
          : `'${eventType}' has no inverse.`,
      );
    }
  }
}

/**
 * Reverse an applied fact EXACTLY (slice 3). The registry proves the `original` is what was
 * applied (content hash), the reversal link is recorded, and each family's inverse is applied —
 * or refused with the reason when no exact inverse exists (a fill whose lots were relieved, a
 * split, an already-reversed fact). Reversing a repair is what makes a wrong repair recoverable:
 * a reversal of a reversal re-applies the fact; a reversal of a correction undoes the replacement
 * and re-applies the fact.
 */
function reverseApplied(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  original: PortfolioEventEnvelope,
): void {
  const key = duplicateBoundaryKey(original);
  const appliedHash = ownValue(state.appliedEvents, key);
  if (appliedHash === undefined) {
    throw new DataError(
      `${functionName}: ${envelope.event.eventType} '${envelope.eventId}' names (sourceId '${original.sourceId}', eventId '${original.eventId}'), which this fold never applied — a reversal repairs an applied fact. Check the sourceId/eventId, or fold the original first.`,
      {
        code: ErrorCode.PortfolioReversalTargetMissing,
        context: {
          function: functionName,
          eventId: envelope.eventId,
          reversesEventId: original.eventId,
        },
      },
    );
  }
  if (appliedHash !== portfolioEventContentHash(original)) {
    infeasible(
      functionName,
      envelope,
      `the carried original hashes differently from what was applied (${appliedHash} applied) — the reversal must carry the applied envelope verbatim.`,
    );
  }
  const reversedBy = ownValue(state.reversals, key);
  if (reversedBy !== undefined) {
    infeasible(functionName, envelope, `it was already reversed by ${reversedBy}.`);
  }
  const target = original.event;
  if (target.eventType === 'admin.reversal' || target.eventType === 'admin.correction') {
    // The repair's own subject: live again once the repair is undone.
    const inner = target.original;
    const innerKey = duplicateBoundaryKey(inner);
    if (ownValue(state.reversals, innerKey) !== key) {
      infeasible(
        functionName,
        envelope,
        `'${inner.eventId}' is not currently reversed by '${original.eventId}' (it was re-applied or repaired again since).`,
      );
    }
    if (target.eventType === 'admin.correction') {
      reverseEffect(
        functionName,
        state,
        envelope,
        {
          ...inner,
          eventId: original.eventId,
          sourceId: original.sourceId,
          event: target.replacement,
        },
        key,
      );
    }
    delete state.reversals[innerKey];
    applyOne(functionName, state, inner);
  } else {
    reverseEffect(functionName, state, envelope, original, key);
  }
  setOwnValue(state.reversals, key, duplicateBoundaryKey(envelope));
}

function applyOne(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
): void {
  const account = accountOf(state, envelope.accountId);
  switch (envelope.event.eventType) {
    case 'admin.reversal': {
      reverseApplied(functionName, state, envelope, envelope.event.original);
      break;
    }
    case 'admin.correction': {
      const correction = envelope.event;
      reverseApplied(functionName, state, envelope, correction.original);
      // The replacement folds at the ORIGINAL's instant under the correction's identity: lots it
      // opens are `openedByEventId: <correction>` and its effect record sits under the
      // correction's registry key, so the correction is itself exactly reversible.
      applyOne(functionName, state, {
        ...correction.original,
        eventId: envelope.eventId,
        sourceId: envelope.sourceId,
        event: correction.replacement,
      });
      break;
    }
    case 'admin.account-migration': {
      const marker = envelope.event;
      state.accountMigrations.push({
        eventId: envelope.eventId,
        fromAccountId: marker.fromAccountId,
        toAccountId: marker.toAccountId,
        effectiveTimestampMs: envelope.effectiveTimestampMs,
      });
      break;
    }
    case 'cash.deposit': {
      const event = envelope.event as CashDepositEvent;
      bookCash(account, event.currency, event.amount, envelope.eventId, event.settleTimestampMs);
      break;
    }
    case 'cash.withdrawal': {
      const event = envelope.event as CashWithdrawalEvent;
      bookCash(account, event.currency, -event.amount, envelope.eventId, event.settleTimestampMs);
      break;
    }
    case 'cash.transfer': {
      const event = envelope.event as CashTransferEvent;
      cashOf(account, event.currency).totalAmount -= event.amount;
      cashOf(accountOf(state, event.toAccountId), event.currency).totalAmount += event.amount;
      break;
    }
    case 'cash.conversion': {
      const event = envelope.event as CashConversionEvent;
      cashOf(account, event.fromCurrency).totalAmount -= event.fromAmount;
      cashOf(account, event.toCurrency).totalAmount += event.toAmount;
      break;
    }
    case 'trade.fill': {
      applyFill(functionName, state, account, envelope, envelope.event as TradeFillEvent);
      break;
    }
    case 'cost.charge': {
      const event = envelope.event as CostChargeEvent;
      cashOf(account, event.currency).totalAmount -= event.amount;
      addTo(account.transactionCosts, event.currency, event.amount);
      if (event.instrumentId !== undefined) {
        addToInstrument(
          account.transactionCostsByInstrument,
          event.instrumentId,
          event.currency,
          event.amount,
        );
      }
      break;
    }
    case 'income.received': {
      const event = envelope.event as IncomeReceivedEvent;
      bookCash(account, event.currency, event.amount, envelope.eventId, event.settleTimestampMs);
      addTo(account.incomeReceived, event.currency, event.amount);
      if (event.instrumentId !== undefined) {
        addToInstrument(
          account.incomeByInstrument,
          event.instrumentId,
          event.currency,
          event.amount,
        );
      }
      break;
    }
    case 'financing.charge': {
      const event = envelope.event as FinancingChargeEvent;
      cashOf(account, event.currency).totalAmount -= event.amount;
      addTo(account.financingCosts, event.currency, event.amount);
      break;
    }
    case 'corporate.split': {
      applySplit(functionName, account, envelope, envelope.event as StockSplitEvent);
      break;
    }
    case 'derivative.exercise':
    case 'derivative.assignment':
    case 'derivative.expiration':
    case 'derivative.multiplier-change':
    case 'derivative.variation-margin':
    case 'derivative.roll': {
      applyDerivativeEvent(functionName, state, envelope);
      break;
    }
    case 'fixed-income.redemption':
    case 'corporate.symbol-change':
    case 'corporate.merger':
    case 'corporate.spin-off':
    case 'corporate.return-of-capital':
    case 'corporate.cash-in-lieu':
    case 'position.transfer': {
      applyCorporateEvent(functionName, state, envelope);
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// The public reducer
// ---------------------------------------------------------------------------------------------------

/**
 * The direct pure reducer (FC7 required API; the agent-native doc's decided API ladder): fold
 * `events` over a fresh `portfolio` definition or a `previousState`, returning a new deeply
 * frozen {@link PortfolioState}.
 *
 * Laws (tested in `test/apply.test.ts`):
 *
 * - **replay determinism** — same events, same order → deep-equal state;
 * - **duplicate idempotence** — an already-applied `(sourceId, eventId)` with an identical body
 *   (content hash, provenance excluded) is a no-op;
 * - **conflict detection** — a same-key body change throws `portfolio.duplicate_event_conflict`;
 * - **ordering** — events fold in array order and must be non-decreasing in
 *   `effectiveTimestampMs` (ties keep array order);
 * - **immutability** — neither `previousState` nor any envelope is mutated; the result owns its
 *   own frozen tree.
 *
 * @example
 * ```ts
 * import { applyPortfolioEvents } from '@totalfinance/portfolio';
 *
 * const state = applyPortfolioEvents({ portfolio: { baseCurrency: 'USD' }, events });
 * const next = applyPortfolioEvents({ previousState: state, events: moreEvents });
 * ```
 */
export function applyPortfolioEvents(input: ApplyPortfolioEventsInput): PortfolioState {
  const functionName = 'applyPortfolioEvents';
  requirePlainDataObject(functionName, 'input', input);
  requireNoInheritedFields(functionName, 'input', input, APPLY_KEYS);
  ensureKnownKeys(functionName, 'input', input, APPLY_KEYS);
  if ((input.portfolio === undefined) === (input.previousState === undefined)) {
    throw new InputError(
      `${functionName}: supply EXACTLY ONE of portfolio (start a fresh fold) or previousState (continue one) — ${input.portfolio === undefined ? 'neither was supplied' : 'both were supplied, and the reducer will not silently pick'}.\n  e.g. ${EXAMPLE_APPLY}`,
      {
        code:
          input.portfolio === undefined ? ErrorCode.InputMissingField : ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'portfolio' },
      },
    );
  }
  requireDenseDataArray(functionName, 'events', input.events);
  input.events.forEach((envelope, index) => {
    requirePortfolioEventEnvelope(functionName, `events[${index}]`, envelope);
  });
  // Fold the exact plain tree canonical JSON hashes and persistence store. Validation happens
  // before this copy; the safe canonicalizer rejects any nested behavior that was not data.
  const events = fromCanonicalJson(canonicalJsonOf(input.events)) as PortfolioEventEnvelope[];

  let working: PortfolioState;
  if (input.previousState !== undefined) {
    requirePortfolioStateShape(functionName, 'previousState', input.previousState);
    working = fromCanonicalJson(canonicalJsonOf(input.previousState)) as PortfolioState;
  } else {
    const definition = input.portfolio!;
    validateDefinition(functionName, definition);
    working = {
      schemaVersion: PORTFOLIO_STATE_SCHEMA_VERSION,
      ...(definition.portfolioId !== undefined ? { portfolioId: definition.portfolioId } : {}),
      baseCurrency: definition.baseCurrency,
      lotRelief: definition.lotRelief ?? 'fifo',
      accounts: {},
      appliedEvents: {},
      eventCount: 0,
      lastEffectiveTimestampMs: null,
      lotSequence: 0,
      fillEffects: {},
      reversals: {},
      accountMigrations: [],
    };
  }

  events.forEach((envelope, index) => {
    const key = duplicateBoundaryKey(envelope);
    const bodyHash = portfolioEventContentHash(envelope);
    const appliedHash = ownValue(working.appliedEvents, key);
    if (appliedHash !== undefined) {
      if (appliedHash === bodyHash) return; // decided law: an identical replay is a no-op
      throw new DataError(
        `${functionName}: events[${index}] replays (sourceId '${envelope.sourceId}', eventId '${envelope.eventId}') with a DIFFERENT body — the previously applied event hashed ${appliedHash}, this one ${bodyHash}. A changed payload under the same identity is a conflict; record a correction as a NEW event instead of rewriting history.`,
        {
          code: ErrorCode.PortfolioDuplicateEventConflict,
          context: {
            function: functionName,
            sourceId: envelope.sourceId,
            eventId: envelope.eventId,
          },
        },
      );
    }
    if (
      working.lastEffectiveTimestampMs !== null &&
      envelope.effectiveTimestampMs < working.lastEffectiveTimestampMs
    ) {
      throw new InputError(
        `${functionName}: events[${index}] (eventId '${envelope.eventId}') is effective at ${envelope.effectiveTimestampMs}, before the fold's last applied instant ${working.lastEffectiveTimestampMs} — events fold in non-decreasing effectiveTimestampMs (ties keep array order). Sort the batch by effectiveTimestampMs before applying.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `events[${index}].effectiveTimestampMs` },
        },
      );
    }
    applyOne(functionName, working, envelope);
    setOwnValue(working.appliedEvents, key, bodyHash);
    working.eventCount += 1;
    working.lastEffectiveTimestampMs = envelope.effectiveTimestampMs;
  });

  // Law 7 (finite results): a fold whose balances or bases left IEEE-754 range (a near-MAX fill
  // or two near-MAX deposits) refuses with the input-driven teaching instead of returning a state
  // that carries Infinity — the magnitude mutant holds this law for the package.
  requireRepresentableResult(functionName, working);
  // Audit our own output through the same restoration door. This turns a violated reducer
  // invariant into a typed boundary failure in the call that created it, rather than persisting a
  // corrupt state that only fails (or throws a raw engine error) on the next call.
  requirePortfolioStateShape(functionName, 'result', working);
  return deepFreeze(fromCanonicalJson(canonicalJsonOf(working)) as PortfolioState);
}

const LEDGER_KEYS = [
  'portfolioId',
  'baseCurrency',
  'lotRelief',
  'events',
  'state',
  'provenance',
  'apply',
  'toJSON',
  'pnl',
  'timeline',
] as const;

/**
 * Structural validation of a {@link PortfolioLedger} handed back across a public boundary (the
 * performance seam). A ledger is a VALUE object: it can be spread, cloned, or hand-assembled after
 * creation, so every door re-validates it — closed keys, both methods present, every event through
 * the closed envelope validator, the state through its own validator, and the top-level echoes
 * (`baseCurrency`, `lotRelief`, `portfolioId`) equal to the state they summarize. The enforcement
 * harness (2026-08-28) reached the seam with `apply` missing and `baseCurrency: null` and was
 * answered with a series. Package-internal (state.ts is not an entrypoint); not part of the curated public surface — a
 * public `require*` leak is exactly what the review waves evicted elsewhere.
 */
export function requirePortfolioLedger(
  functionName: string,
  label: string,
  ledger: PortfolioLedger,
): void {
  requireArgumentObject(functionName, label, ledger);
  ensureKnownKeys(functionName, label, ledger, LEDGER_KEYS);
  for (const method of ['apply', 'toJSON', 'pnl', 'timeline'] as const) {
    if (typeof ledger[method] !== 'function') {
      throw new InputError(
        `${functionName}: ${label}.${method} must be the ledger's own method — pass the object returned by createPortfolioLedger or readPortfolioLedgerSnapshot, not a copy of its fields. Received ${ledger[method] === null ? 'null' : typeof ledger[method]}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}.${method}` },
        },
      );
    }
  }
  requireArgumentArray(functionName, `${label}.events`, ledger.events);
  ledger.events.forEach((event, index) =>
    requirePortfolioEventEnvelope(functionName, `${label}.events[${index}]`, event),
  );
  requirePortfolioStateShape(functionName, `${label}.state`, ledger.state);
  if (ledger.provenance !== undefined) {
    requireProvenanceShape(functionName, `${label}.provenance`, ledger.provenance);
  }
  for (const field of ['baseCurrency', 'lotRelief', 'portfolioId'] as const) {
    if (ledger[field] !== ledger.state[field]) {
      throw new InputError(
        `${functionName}: ${label}.${field} (${JSON.stringify(ledger[field])}) must equal ${label}.state.${field} (${JSON.stringify(ledger.state[field])}) — the ledger's top-level fields echo the state they summarize; a ledger that disagrees with its own state is corrupt.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}.${field}` },
        },
      );
    }
  }
}
