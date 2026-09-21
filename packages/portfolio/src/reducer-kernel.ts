/**
 * The reducer kernel (FC7 slice 5, 2026-08-29): the ONE set of lot, cash, and position primitives
 * every economic family folds through. Extracted from `state.ts` so the lifecycle modules
 * (`lifecycle-derivatives.ts`, `lifecycle-corporate.ts`) and the fill reducer share exactly one
 * relief law, one lot-opening law, and one cash-booking law — a derivative exercise relieves
 * option lots and opens underlying lots with the same arithmetic a fill uses.
 *
 * Package-internal: `reducer-kernel.ts` is not an entrypoint and nothing here is curated public
 * surface. Every function operates on the fold's WORKING copy (never on caller data).
 */

import { DataError, ErrorCode, InputError } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import type {
  DerivativeContractTerms,
  PortfolioEventEnvelope,
  SettlementStyle,
  TradeFillLotSelection,
} from './events.js';
import { QUANTITY_DUST, ownValue, setOwnValue } from './internal.js';
import type {
  AccountState,
  CashBalance,
  LotReliefPolicy,
  PortfolioState,
  PositionState,
  TaxLot,
} from './state.js';

// ---------------------------------------------------------------------------------------------------
// Accounts and cash
// ---------------------------------------------------------------------------------------------------

export function freshAccount(): AccountState {
  return {
    cashBalances: {},
    positions: {},
    realizedPnl: {},
    incomeReceived: {},
    transactionCosts: {},
    financingCosts: {},
    realizedPnlByInstrument: {},
    incomeByInstrument: {},
    transactionCostsByInstrument: {},
  };
}

export function accountOf(state: PortfolioState, accountId: string): AccountState {
  const existing = ownValue(state.accounts, accountId);
  if (existing !== undefined) return existing;
  const created = freshAccount();
  setOwnValue(state.accounts, accountId, created);
  return created;
}

export function cashOf(account: AccountState, currency: string): CashBalance {
  const existing = ownValue(account.cashBalances, currency);
  if (existing !== undefined) return existing;
  const created: CashBalance = { totalAmount: 0, settlementSchedule: [] };
  setOwnValue(account.cashBalances, currency, created);
  return created;
}

export function addTo(record: Record<string, number>, currency: string, delta: number): void {
  setOwnValue(record, currency, (ownValue(record, currency) ?? 0) + delta);
}

export function addToInstrument(
  record: Record<string, Record<string, number>>,
  instrumentId: string,
  currency: string,
  delta: number,
): void {
  let byCurrency = ownValue(record, instrumentId);
  if (byCurrency === undefined) {
    byCurrency = {};
    setOwnValue(record, instrumentId, byCurrency);
  }
  addTo(byCurrency, currency, delta);
}

/** Book a signed cash amount; a dated leg joins the settlement schedule. */
export function bookCash(
  account: AccountState,
  currency: string,
  amount: number,
  eventId: string,
  settleTimestampMs: number | undefined,
): void {
  const cash = cashOf(account, currency);
  cash.totalAmount += amount;
  if (settleTimestampMs !== undefined) {
    cash.settlementSchedule.push({ eventId, amount, settleTimestampMs });
  }
}

export function removeSettlementLeg(
  account: AccountState,
  currency: string,
  eventId: string,
  amount: number,
  settleTimestampMs: number | undefined,
): boolean {
  if (settleTimestampMs === undefined || amount === 0) return true;
  const cash = cashOf(account, currency);
  const index = cash.settlementSchedule.findIndex(
    (leg) =>
      leg.eventId === eventId &&
      leg.amount === amount &&
      leg.settleTimestampMs === settleTimestampMs,
  );
  if (index < 0) return false;
  cash.settlementSchedule.splice(index, 1);
  return true;
}

/** Realized P&L (position currency) to the account and the instrument attribution. */
export function recordRealized(
  account: AccountState,
  instrumentId: string,
  currency: string,
  realized: number,
): void {
  if (realized === 0) return;
  addTo(account.realizedPnl, currency, realized);
  addToInstrument(account.realizedPnlByInstrument, instrumentId, currency, realized);
}

/** Income (positive) or an income adjustment (negative, e.g. accrued interest paid) attributed. */
export function recordIncome(
  account: AccountState,
  instrumentId: string | undefined,
  currency: string,
  amount: number,
): void {
  if (amount === 0) return;
  addTo(account.incomeReceived, currency, amount);
  if (instrumentId !== undefined) {
    addToInstrument(account.incomeByInstrument, instrumentId, currency, amount);
  }
}

// ---------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------

/** A reversal that has no exact inverse — the typed refusal every family shares. */
export function infeasible(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  detail: string,
): never {
  throw new DataError(
    `${functionName}: ${envelope.event.eventType} '${envelope.eventId}' cannot reverse '${envelope.reversesEventId}' exactly — ${detail} History is never approximated; record the correcting economic event instead.`,
    {
      code: ErrorCode.PortfolioReversalInfeasible,
      context: {
        function: functionName,
        eventId: envelope.eventId,
        reversesEventId: envelope.reversesEventId,
      },
    },
  );
}

/** A lifecycle event that names a position the account does not hold. */
export function requireHeldPosition(
  functionName: string,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  instrumentId: string,
  field: string,
): PositionState {
  const position = ownValue(account.positions, instrumentId);
  if (position === undefined) {
    throw new InputError(
      `${functionName}: ${envelope.event.eventType} event '${envelope.eventId}' names ${instrumentId}, but account '${envelope.accountId}' holds no open position in it — a lifecycle event transforms held lots, so record the position's fills first or drop the event for this account.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, eventId: envelope.eventId },
      },
    );
  }
  return position;
}

// ---------------------------------------------------------------------------------------------------
// Positions and lots
// ---------------------------------------------------------------------------------------------------

/** The instrument facts a position is opened with (from its first fill) and must keep. */
export interface PositionProfile {
  currency: string;
  contractMultiplier: number;
  settlementStyle: SettlementStyle;
  contract?: DerivativeContractTerms;
}

/**
 * The account's open position for `instrumentId`, created from `profile` when absent. An existing
 * position must AGREE with the profile (one currency, one multiplier, one settlement style, one
 * set of contract terms per open position) — a disagreement is a typed refusal, never a silent
 * re-profile.
 */
export function ensurePosition(
  functionName: string,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  instrumentId: string,
  profile: PositionProfile,
  field: string,
): PositionState {
  const existing = ownValue(account.positions, instrumentId);
  if (existing === undefined) {
    const created: PositionState = {
      instrumentId,
      currency: profile.currency,
      contractMultiplier: profile.contractMultiplier,
      settlementStyle: profile.settlementStyle,
      quantity: 0,
      lots: [],
    };
    if (profile.contract !== undefined) created.contract = profile.contract;
    setOwnValue(account.positions, instrumentId, created);
    return created;
  }
  const disagreement =
    existing.currency !== profile.currency
      ? `currency ${profile.currency} vs the open position's ${existing.currency}`
      : existing.contractMultiplier !== profile.contractMultiplier
        ? `contractMultiplier ${profile.contractMultiplier} vs the open position's ${existing.contractMultiplier}`
        : existing.settlementStyle !== profile.settlementStyle
          ? `settlementStyle '${profile.settlementStyle}' vs the open position's '${existing.settlementStyle}'`
          : canonicalJsonOf(existing.contract ?? null) !== canonicalJsonOf(profile.contract ?? null)
            ? `contract terms that differ from the open position's`
            : null;
  if (disagreement !== null) {
    throw new InputError(
      `${functionName}: ${envelope.event.eventType} event '${envelope.eventId}' describes ${instrumentId} with ${disagreement} in account '${envelope.accountId}' — one profile per open position. Close the position first, or record the event with the position's own profile.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, eventId: envelope.eventId },
      },
    );
  }
  return existing;
}

/** Open one lot with the fold's deterministic id and return it. */
export function openLot(
  state: PortfolioState,
  position: PositionState,
  signedQuantity: number,
  costBasisPerUnit: number,
  envelope: PortfolioEventEnvelope,
): TaxLot {
  state.lotSequence += 1;
  const lot: TaxLot = {
    lotId: `lot-${state.lotSequence}`,
    openedByEventId: envelope.eventId,
    openedTimestampMs: envelope.effectiveTimestampMs,
    quantity: signedQuantity,
    costBasisPerUnit,
  };
  position.lots.push(lot);
  return lot;
}

/**
 * Policy-ordered view of a position's lots for relief (never reorders the stored array). Also
 * consumed by `proposePortfolioRebalance` to preview EXACTLY the lots a fill would relieve — one
 * ordering law, proven by the parity test in `test/rebalance.test.ts`.
 */
export function reliefOrder(lots: TaxLot[], policy: LotReliefPolicy): TaxLot[] {
  if (policy === 'fifo') return [...lots];
  if (policy === 'lifo') return [...lots].reverse();
  // 'highest-cost': descending per-unit basis, stable (ties keep chronological order). For short
  // lots `costBasisPerUnit` records opening proceeds per unit; the same descending order applies —
  // documented in docs/specs/fc7-first-slice.md.
  return [...lots].sort((a, b) => b.costBasisPerUnit - a.costBasisPerUnit);
}

/** One lot's share of a relief. */
export interface RelievedLot {
  lotId: string;
  /** Unsigned quantity relieved from the lot. */
  quantity: number;
  costBasisPerUnit: number;
  /** Realized P&L on this lot in the position currency (contract multiplier applied). */
  realizedPnl: number;
}

export interface ReliefOutcome {
  /** Σ over relieved lots, in the position currency. */
  realizedPnl: number;
  relievedQuantity: number;
  relieved: RelievedLot[];
}

function relieveFromLot(
  position: PositionState,
  lot: TaxLot,
  quantityRelieved: number,
  pricePerUnit: number,
): number {
  const isLong = lot.quantity > 0;
  const realizedPerUnit = isLong
    ? (pricePerUnit - lot.costBasisPerUnit) * quantityRelieved
    : (lot.costBasisPerUnit - pricePerUnit) * quantityRelieved;
  lot.quantity += isLong ? -quantityRelieved : quantityRelieved;
  if (Math.abs(lot.quantity) <= QUANTITY_DUST) {
    const index = position.lots.indexOf(lot);
    position.lots.splice(index, 1);
  }
  return realizedPerUnit * position.contractMultiplier;
}

/**
 * Relieve `quantity` (unsigned) of a position's open lots at `pricePerUnit` under the state's
 * relief policy — or under explicit `lotSelections` when the policy is `specific-lot`. Realized
 * P&L carries the contract multiplier. The caller has established that the relief closes against
 * the position's direction and that `quantity` does not exceed what is held.
 */
export function relieveQuantity(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  position: PositionState,
  quantity: number,
  pricePerUnit: number,
  lotSelections: TradeFillLotSelection[] | undefined,
  field: string,
): ReliefOutcome {
  const subject = `${envelope.event.eventType} event '${envelope.eventId}'`;
  const relieved: RelievedLot[] = [];
  let realized = 0;
  if (lotSelections !== undefined && state.lotRelief !== 'specific-lot') {
    throw new InputError(
      `${functionName}: ${subject} carries ${field}, but this ledger's lotRelief is '${state.lotRelief}' — the selections would be silently ignored. Remove them, or fold under lotRelief: 'specific-lot'.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, eventId: envelope.eventId },
      },
    );
  }
  if (quantity <= QUANTITY_DUST) return { realizedPnl: 0, relievedQuantity: 0, relieved };
  if (state.lotRelief === 'specific-lot') {
    if (lotSelections === undefined) {
      throw new InputError(
        `${functionName}: ${subject} closes ${quantity} of ${position.instrumentId} under lotRelief 'specific-lot', so ${field} must name the lots relieved (their quantities summing to ${quantity}).`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field, eventId: envelope.eventId },
        },
      );
    }
    const selectedTotal = lotSelections.reduce((sum, s) => sum + s.quantity, 0);
    if (Math.abs(selectedTotal - quantity) > QUANTITY_DUST) {
      throw new InputError(
        `${functionName}: ${subject} relieves ${quantity} of ${position.instrumentId}, but its ${field} sum to ${selectedTotal} — specific-lot relief must name exactly the relieved quantity.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field, eventId: envelope.eventId },
        },
      );
    }
    for (const selection of lotSelections) {
      const lot = position.lots.find((candidate) => candidate.lotId === selection.lotId);
      if (lot === undefined) {
        throw new DataError(
          `${functionName}: ${subject} names lot '${selection.lotId}', which does not exist in the ${position.instrumentId} position of account '${envelope.accountId}' — lot relief never guesses a substitute. Open lots: ${position.lots.map((l) => `${l.lotId} (${l.quantity})`).join(', ') || 'none'}.`,
          {
            code: ErrorCode.PortfolioLotUnavailable,
            context: { function: functionName, lotId: selection.lotId, eventId: envelope.eventId },
          },
        );
      }
      if (Math.abs(lot.quantity) + QUANTITY_DUST < selection.quantity) {
        throw new DataError(
          `${functionName}: ${subject} relieves ${selection.quantity} from lot '${selection.lotId}', which holds only ${Math.abs(lot.quantity)}.`,
          {
            code: ErrorCode.PortfolioLotUnavailable,
            context: { function: functionName, lotId: selection.lotId, eventId: envelope.eventId },
          },
        );
      }
      const basis = lot.costBasisPerUnit;
      const lotRealized = relieveFromLot(position, lot, selection.quantity, pricePerUnit);
      realized += lotRealized;
      relieved.push({
        lotId: selection.lotId,
        quantity: selection.quantity,
        costBasisPerUnit: basis,
        realizedPnl: lotRealized,
      });
    }
  } else {
    let remaining = quantity;
    for (const lot of reliefOrder(position.lots, state.lotRelief)) {
      if (remaining <= QUANTITY_DUST) break;
      const take = Math.min(Math.abs(lot.quantity), remaining);
      const basis = lot.costBasisPerUnit;
      const lotId = lot.lotId;
      const lotRealized = relieveFromLot(position, lot, take, pricePerUnit);
      realized += lotRealized;
      relieved.push({ lotId, quantity: take, costBasisPerUnit: basis, realizedPnl: lotRealized });
      remaining -= take;
    }
  }
  return { realizedPnl: realized, relievedQuantity: quantity, relieved };
}

/** Recompute the signed quantity from the lots and drop an empty position. */
export function finalizePosition(account: AccountState, position: PositionState): void {
  position.quantity = position.lots.reduce((sum, lot) => sum + lot.quantity, 0);
  if (Math.abs(position.quantity) <= QUANTITY_DUST && position.lots.length === 0) {
    delete account.positions[position.instrumentId];
  }
}

/** The held (unsigned) quantity a closing event may relieve, with the direction it closes. */
export function closingCapacity(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  position: PositionState,
  quantity: number,
  field: string,
): void {
  if (Math.abs(position.quantity) + QUANTITY_DUST < quantity) {
    throw new InputError(
      `${functionName}: ${envelope.event.eventType} event '${envelope.eventId}' settles ${quantity} of ${position.instrumentId}, but account '${envelope.accountId}' holds ${Math.abs(position.quantity)} — a lifecycle event never settles more than is held; record the quantity actually settled.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, eventId: envelope.eventId },
      },
    );
  }
}

export interface PositionLegOutcome {
  realizedPnl: number;
  relievedQuantity: number;
  openedLotIds: string[];
}

/**
 * Fold one side of a trade into a position — THE lot law a fill, an exercise, an assignment, and
 * a roll share: a buy covers short lots before opening a long lot; a sell relieves long lots
 * before opening a short lot. Cash is the caller's (the delivery price and the lot price differ
 * under `'fold-into-underlying-basis'`). `lotSelections` name the relieved lots under
 * `specific-lot`; a DERIVED leg (`derivedLegName` given — the delivered underlying, a roll's
 * successor) whose lots the event cannot name is a typed refusal under that policy, never a
 * silent pick; a direct leg (a fill) falls through to `relieveQuantity`'s own teaching.
 */
export function foldPositionLeg(
  functionName: string,
  state: PortfolioState,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  position: PositionState,
  side: 'buy' | 'sell',
  quantity: number,
  pricePerUnit: number,
  lotSelections: TradeFillLotSelection[] | undefined,
  field: string,
  derivedLegName: string | undefined,
): PositionLegOutcome {
  const opposing =
    (side === 'buy' && position.quantity < 0) || (side === 'sell' && position.quantity > 0);
  const closingQuantity = opposing ? Math.min(quantity, Math.abs(position.quantity)) : 0;
  let realized = 0;
  if (closingQuantity > QUANTITY_DUST) {
    if (
      derivedLegName !== undefined &&
      state.lotRelief === 'specific-lot' &&
      lotSelections === undefined
    ) {
      throw new InputError(
        `${functionName}: ${envelope.event.eventType} event '${envelope.eventId}' ${derivedLegName} ${side === 'buy' ? 'covers' : 'relieves'} ${closingQuantity} of the ${position.quantity > 0 ? 'long' : 'short'} ${position.instrumentId} position held in account '${envelope.accountId}', and this ledger's lotRelief is 'specific-lot' — the event names the contract lots it settles, not the ${position.instrumentId} lots this leg would relieve, and lot relief never guesses a lot. Close the ${position.instrumentId} lots first with a trade.fill carrying lotSelections, or fold under fifo | lifo | highest-cost.`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field, eventId: envelope.eventId },
        },
      );
    }
    realized = relieveQuantity(
      functionName,
      state,
      envelope,
      position,
      closingQuantity,
      pricePerUnit,
      lotSelections,
      field,
    ).realizedPnl;
  }
  recordRealized(account, position.instrumentId, position.currency, realized);
  const openingQuantity = quantity - closingQuantity;
  const openedLotIds: string[] = [];
  if (openingQuantity > QUANTITY_DUST) {
    const lot = openLot(
      state,
      position,
      side === 'buy' ? openingQuantity : -openingQuantity,
      pricePerUnit,
      envelope,
    );
    openedLotIds.push(lot.lotId);
  }
  finalizePosition(account, position);
  return { realizedPnl: realized, relievedQuantity: closingQuantity, openedLotIds };
}
