/**
 * Corporate actions beyond splits, fixed-income redemptions, and position transfers (FC7 slice 5,
 * 2026-08-29; agent-native "Corporate actions" family — "instrument/lot transformation with
 * provenance"; FC7 mandatory state: merger, spin-off, symbol change, return of capital,
 * cash-in-lieu, fixed-income call/maturity/principal, and internal transfer identity) — over the
 * ONE reducer kernel a fill uses: every relief goes through `relieveQuantity`, every new lot
 * through `openLot`, every cash leg through `bookCash`.
 *
 * Conventions decided here (each proven in `test/lifecycle-corporate.test.ts`):
 *
 * - **Symbol change** moves the position object (lots, lot ids, basis, profile) and the account's
 *   per-instrument attribution to the new key; a rename never merges two positions. Its reversal
 *   is EXACT (rename back) while the account holds the new id and not the old one.
 * - **Merger** — a pure cash merger relieves every lot at `cashPerShare` (realized through the
 *   kernel). Stock consideration converts every lot in place (`quantity × sharesPerShare`,
 *   `basis ÷ sharesPerShare`; total basis preserved exactly) and appends it to the acquirer's
 *   position with lot identity and opening date intact. MIXED consideration treats the cash as a
 *   return of capital FIRST (basis per unit − `cashPerShare`, any excess over basis realized, the
 *   lot floored at 0) and then converts — this build's mixed-merger convention, chosen because the
 *   fold holds no mark with which to apportion basis by value. Long positions only.
 * - **Spin-off** moves the explicit fraction of each parent lot's basis into a child lot that
 *   carries the PARENT lot's opening date (the holding period tacks) under the spin-off's event id.
 * - **Return of capital** reduces basis per unit, realizes any excess over basis, and is never
 *   income.
 * - **Cash-in-lieu** relieves the surrendered fraction at `amount ÷ quantity` per unit.
 * - **Redemption** relieves face units at the redemption price; a `'maturity'` retires the whole
 *   position. Long positions receive principal; short positions pay it.
 * - **Position transfer** MOVES lots between accounts: a lot moved whole keeps its identity; a lot
 *   moved in part splits into a new lot carrying the source lot's opening date and event. No cash,
 *   no realized P&L; attribution history stays in the account that earned it.
 *
 * The fold keeps no effect record for these families, so every reversal except the symbol change
 * is refused through the kernel's `infeasible` — the correcting economic event is the repair.
 *
 * Package-internal: dispatched from `state.ts`; nothing here is curated public surface.
 */

import { DataError, ErrorCode, InputError } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import type {
  CashInLieuEvent,
  FixedIncomeRedemptionEvent,
  MergerEvent,
  PortfolioEventEnvelope,
  PositionTransferEvent,
  ReturnOfCapitalEvent,
  SpinOffEvent,
  SymbolChangeEvent,
  TradeFillLotSelection,
} from './events.js';
import { QUANTITY_DUST, ownValue, setOwnValue } from './internal.js';
import type { PositionProfile } from './reducer-kernel.js';
import {
  accountOf,
  addToInstrument,
  bookCash,
  closingCapacity,
  ensurePosition,
  finalizePosition,
  infeasible,
  openLot,
  recordRealized,
  relieveQuantity,
  reliefOrder,
  requireHeldPosition,
} from './reducer-kernel.js';
import type { AccountState, PortfolioState, PositionState, TaxLot } from './state.js';

export type CorporateLifecycleEventType =
  | 'corporate.symbol-change'
  | 'corporate.merger'
  | 'corporate.spin-off'
  | 'corporate.return-of-capital'
  | 'corporate.cash-in-lieu'
  | 'fixed-income.redemption'
  | 'position.transfer';

type RefusalCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------------------------------
// Shared refusals and small helpers
// ---------------------------------------------------------------------------------------------------

/** A typed refusal of the economically impossible — the event is well-formed, the state forbids it. */
function refuse(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  field: string,
  detail: string,
  code: RefusalCode = ErrorCode.InputOutOfRange,
): never {
  throw new InputError(
    `${functionName}: ${envelope.event.eventType} event '${envelope.eventId}' ${detail}`,
    { code, context: { function: functionName, field, eventId: envelope.eventId } },
  );
}

/** Prose for what an account holds in a position — every teaching names it. */
function held(position: PositionState): string {
  const lots = position.lots.length;
  return `${Math.abs(position.quantity)} ${position.instrumentId} (${position.quantity < 0 ? 'short' : 'long'}, ${lots} lot${lots === 1 ? '' : 's'})`;
}

/** The instrument facts a position carries — what a successor position must agree with. */
function profileOf(position: PositionState): PositionProfile {
  const profile: PositionProfile = {
    currency: position.currency,
    contractMultiplier: position.contractMultiplier,
    settlementStyle: position.settlementStyle,
  };
  if (position.contract !== undefined) profile.contract = position.contract;
  return profile;
}

/** The families that re-base or relieve capital lots act on LONG positions only in this build. */
function requireLong(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  position: PositionState,
  field: string,
  instead: string,
): void {
  if (position.quantity < 0) {
    refuse(
      functionName,
      envelope,
      field,
      `names ${position.instrumentId}, but account '${envelope.accountId}' is SHORT ${Math.abs(position.quantity)} — ${instead}`,
    );
  }
}

/**
 * Basis re-basing and cash relief are capital operations: a variation-margin position's lot basis
 * is its last settlement price, not capital, so these families refuse it.
 */
function requireCashOnTrade(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  position: PositionState,
  field: string,
): void {
  if (position.settlementStyle !== 'cash-on-trade') {
    refuse(
      functionName,
      envelope,
      field,
      `names ${position.instrumentId}, a '${position.settlementStyle}' position in account '${envelope.accountId}' — this family re-bases or relieves capital lots, and a variation-margin lot's basis is its last settlement price, not capital. Record a derivative.variation-margin settlement or a closing trade.fill instead.`,
    );
  }
}

/** A corporate cash leg is paid in the position's currency; an FX leg is a separate conversion. */
function requireEventCurrency(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  position: PositionState,
  currency: string,
  field: string,
): void {
  if (currency !== position.currency) {
    refuse(
      functionName,
      envelope,
      field,
      `books ${currency}, but account '${envelope.accountId}' holds ${held(position)} in ${position.currency} — a corporate cash leg is paid in the position's currency. Restate the event in ${position.currency} and record the exchange as a cash.conversion.`,
    );
  }
}

/** Lots delivered into an existing position must share its sign — a position never mixes both. */
function requireReceivingDirection(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  accountId: string,
  destination: PositionState,
  incomingSign: 1 | -1,
  field: string,
): void {
  if (destination.quantity !== 0 && Math.sign(destination.quantity) !== incomingSign) {
    refuse(
      functionName,
      envelope,
      field,
      `delivers ${incomingSign > 0 ? 'long' : 'short'} lots of ${destination.instrumentId} into account '${accountId}', which holds ${held(destination)} — a position never holds lots of both signs. Close that position with a trade.fill first.`,
    );
  }
}

/** Move the per-instrument attribution (realized, income, costs) from one key to another, merge-adding. */
function carryInstrumentHistory(account: AccountState, from: string, to: string): void {
  for (const record of [
    account.realizedPnlByInstrument,
    account.incomeByInstrument,
    account.transactionCostsByInstrument,
  ]) {
    const history = ownValue(record, from);
    if (history === undefined) continue;
    for (const [currency, amount] of Object.entries(history)) {
      addToInstrument(record, to, currency, amount);
    }
    delete record[from];
  }
}

/** Re-key a position (and its attribution) under a new instrument id; the object is the same. */
function renamePosition(account: AccountState, position: PositionState, to: string): void {
  const from = position.instrumentId;
  delete account.positions[from];
  position.instrumentId = to;
  setOwnValue(account.positions, to, position);
  carryInstrumentHistory(account, from, to);
}

function coversWholePosition(position: PositionState, quantity: number): boolean {
  return Math.abs(position.quantity) - quantity <= QUANTITY_DUST;
}

/**
 * The relief instructions for a family that may carry none. Under `specific-lot` an event that
 * relieves the WHOLE position, or a position holding ONE lot, leaves nothing to choose — the
 * selections are derived from the lots themselves (exact, never a guess). Anything else returns
 * `undefined` and the kernel (or the family) teaches.
 */
function selectionsForRelief(
  state: PortfolioState,
  position: PositionState,
  quantity: number,
  explicit: TradeFillLotSelection[] | undefined,
): TradeFillLotSelection[] | undefined {
  if (explicit !== undefined || state.lotRelief !== 'specific-lot') return explicit;
  if (coversWholePosition(position, quantity)) {
    return position.lots.map((lot) => ({ lotId: lot.lotId, quantity: Math.abs(lot.quantity) }));
  }
  const only = position.lots[0];
  if (position.lots.length === 1 && only !== undefined) {
    return [{ lotId: only.lotId, quantity }];
  }
  return undefined;
}

/**
 * Reduce every lot's basis per unit by `perUnit` (a return of capital); a lot whose basis would
 * fall below zero realizes the excess and floors at zero. Returns the realized excess in the
 * position currency (contract multiplier applied, as the kernel does).
 */
function reduceBasisPerUnit(position: PositionState, perUnit: number): number {
  let realized = 0;
  for (const lot of position.lots) {
    const reduced = lot.costBasisPerUnit - perUnit;
    if (reduced < 0) {
      realized += -reduced * lot.quantity * position.contractMultiplier;
      lot.costBasisPerUnit = 0;
    } else {
      lot.costBasisPerUnit = reduced;
    }
  }
  return realized;
}

// ---------------------------------------------------------------------------------------------------
// corporate.symbol-change
// ---------------------------------------------------------------------------------------------------

function applySymbolChange(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  event: SymbolChangeEvent,
): void {
  const account = accountOf(state, envelope.accountId);
  const position = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.fromInstrumentId,
    'event.fromInstrumentId',
  );
  const collision = ownValue(account.positions, event.toInstrumentId);
  if (collision !== undefined) {
    refuse(
      functionName,
      envelope,
      'event.toInstrumentId',
      `renames ${event.fromInstrumentId} to ${event.toInstrumentId}, but account '${envelope.accountId}' already holds ${held(collision)} — a rename never merges two positions. Record a corporate.merger (sharesPerShare 1) to combine ${event.fromInstrumentId} into ${event.toInstrumentId}.`,
    );
  }
  renamePosition(account, position, event.toInstrumentId);
}

function reverseSymbolChange(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  applied: PortfolioEventEnvelope,
  event: SymbolChangeEvent,
): void {
  const account = accountOf(state, applied.accountId);
  const position = ownValue(account.positions, event.toInstrumentId);
  if (position === undefined) {
    infeasible(
      functionName,
      envelope,
      `account '${applied.accountId}' no longer holds ${event.toInstrumentId} (the renamed position was closed, merged, or renamed again).`,
    );
  }
  if (ownValue(account.positions, event.fromInstrumentId) !== undefined) {
    infeasible(
      functionName,
      envelope,
      `account '${applied.accountId}' holds ${event.fromInstrumentId} again — renaming ${event.toInstrumentId} back would merge two positions.`,
    );
  }
  renamePosition(account, position, event.fromInstrumentId);
}

// ---------------------------------------------------------------------------------------------------
// corporate.merger
// ---------------------------------------------------------------------------------------------------

function applyMerger(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  event: MergerEvent,
): void {
  const account = accountOf(state, envelope.accountId);
  const position = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.fromInstrumentId,
    'event.fromInstrumentId',
  );
  requireLong(
    functionName,
    envelope,
    position,
    'event.fromInstrumentId',
    'a short position in an acquired instrument is closed out by the acquirer, and that settlement is deferred in this build. Record the cover as a trade.fill buy at the deal price.',
  );
  requireCashOnTrade(functionName, envelope, position, 'event.fromInstrumentId');
  if (event.currency !== undefined) {
    requireEventCurrency(functionName, envelope, position, event.currency, 'event.currency');
  }
  const quantity = position.quantity;
  const multiplier = position.contractMultiplier;

  if (event.sharesPerShare === undefined) {
    // Pure cash: every lot is relieved at the deal price — realized through the kernel.
    const cashPerShare = event.cashPerShare!;
    const outcome = relieveQuantity(
      functionName,
      state,
      envelope,
      position,
      quantity,
      cashPerShare,
      selectionsForRelief(state, position, quantity, undefined),
      'event',
    );
    recordRealized(account, event.fromInstrumentId, position.currency, outcome.realizedPnl);
    bookCash(
      account,
      position.currency,
      cashPerShare * quantity * multiplier,
      envelope.eventId,
      event.settleTimestampMs,
    );
    finalizePosition(account, position);
    return;
  }

  // Stock (or mixed): the acquirer's position must agree with the acquired profile and direction
  // BEFORE any cash or basis moves, so a refusal leaves nothing half-applied.
  const toInstrumentId = event.toInstrumentId!;
  const destination = ensurePosition(
    functionName,
    account,
    envelope,
    toInstrumentId,
    profileOf(position),
    'event.toInstrumentId',
  );
  requireReceivingDirection(
    functionName,
    envelope,
    envelope.accountId,
    destination,
    1,
    'event.toInstrumentId',
  );

  if (event.cashPerShare !== undefined) {
    // Mixed consideration: the cash is a return of capital against each lot first (excess over
    // basis realized, floored at 0); the remaining basis converts with the shares.
    bookCash(
      account,
      position.currency,
      event.cashPerShare * quantity * multiplier,
      envelope.eventId,
      event.settleTimestampMs,
    );
    const excess = reduceBasisPerUnit(position, event.cashPerShare);
    recordRealized(account, event.fromInstrumentId, position.currency, excess);
  }

  const ratio = event.sharesPerShare;
  for (const lot of position.lots) {
    lot.quantity *= ratio;
    lot.costBasisPerUnit /= ratio;
    destination.lots.push(lot);
  }
  position.lots = [];
  finalizePosition(account, position);
  finalizePosition(account, destination);
  carryInstrumentHistory(account, event.fromInstrumentId, toInstrumentId);
}

// ---------------------------------------------------------------------------------------------------
// corporate.spin-off
// ---------------------------------------------------------------------------------------------------

function applySpinOff(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  event: SpinOffEvent,
): void {
  const account = accountOf(state, envelope.accountId);
  const parent = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.parentInstrumentId,
    'event.parentInstrumentId',
  );
  requireLong(
    functionName,
    envelope,
    parent,
    'event.parentInstrumentId',
    'a short parent owes the distributed child shares to the lender, and that obligation is deferred in this build. Record the child short as a trade.fill sell at the distribution price.',
  );
  requireCashOnTrade(functionName, envelope, parent, 'event.parentInstrumentId');
  const child = ensurePosition(
    functionName,
    account,
    envelope,
    event.childInstrumentId,
    { currency: parent.currency, contractMultiplier: 1, settlementStyle: 'cash-on-trade' },
    'event.childInstrumentId',
  );
  requireReceivingDirection(
    functionName,
    envelope,
    envelope.accountId,
    child,
    1,
    'event.childInstrumentId',
  );
  const fraction = event.basisAllocationFraction;
  for (const lot of parent.lots) {
    const childQuantity = lot.quantity * event.sharesPerParentShare;
    const lotBasis = lot.costBasisPerUnit * lot.quantity * parent.contractMultiplier;
    const childLot = openLot(
      state,
      child,
      childQuantity,
      (lotBasis * fraction) / childQuantity,
      envelope,
    );
    // The holding period tacks: the child lot keeps the parent lot's opening date, under the
    // spin-off's own event id (set by `openLot`).
    childLot.openedTimestampMs = lot.openedTimestampMs;
    lot.costBasisPerUnit *= 1 - fraction;
  }
  finalizePosition(account, child);
  finalizePosition(account, parent);
}

// ---------------------------------------------------------------------------------------------------
// corporate.return-of-capital
// ---------------------------------------------------------------------------------------------------

function applyReturnOfCapital(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  event: ReturnOfCapitalEvent,
): void {
  const account = accountOf(state, envelope.accountId);
  const position = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.instrumentId,
    'event.instrumentId',
  );
  requireLong(
    functionName,
    envelope,
    position,
    'event.instrumentId',
    'a short position PAYS the distribution to the lender. Record that payment as a cost.charge, never as capital returned.',
  );
  requireCashOnTrade(functionName, envelope, position, 'event.instrumentId');
  requireEventCurrency(functionName, envelope, position, event.currency, 'event.currency');
  bookCash(
    account,
    position.currency,
    event.amountPerShare * position.quantity * position.contractMultiplier,
    envelope.eventId,
    event.settleTimestampMs,
  );
  const excess = reduceBasisPerUnit(position, event.amountPerShare);
  recordRealized(account, event.instrumentId, position.currency, excess);
}

// ---------------------------------------------------------------------------------------------------
// corporate.cash-in-lieu
// ---------------------------------------------------------------------------------------------------

function applyCashInLieu(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  event: CashInLieuEvent,
): void {
  const account = accountOf(state, envelope.accountId);
  const position = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.instrumentId,
    'event.instrumentId',
  );
  requireLong(
    functionName,
    envelope,
    position,
    'event.instrumentId',
    'cash in lieu settles a fractional LONG share. Record a short fraction covered for cash as a trade.fill buy.',
  );
  requireCashOnTrade(functionName, envelope, position, 'event.instrumentId');
  requireEventCurrency(functionName, envelope, position, event.currency, 'event.currency');
  closingCapacity(functionName, envelope, position, event.quantity, 'event.quantity');
  const selections = selectionsForRelief(state, position, event.quantity, undefined);
  const pricePerUnit = event.amount / (event.quantity * position.contractMultiplier);
  if (selections === undefined && state.lotRelief === 'specific-lot') {
    refuse(
      functionName,
      envelope,
      'event.quantity',
      `surrenders ${event.quantity} of ${held(position)} under lotRelief 'specific-lot', and corporate.cash-in-lieu names no lots — record the fraction as a trade.fill sell (quantity ${event.quantity}, pricePerUnit ${pricePerUnit}) with lotSelections, attributed through relatesToEventId.`,
      ErrorCode.InputMissingField,
    );
  }
  const outcome = relieveQuantity(
    functionName,
    state,
    envelope,
    position,
    event.quantity,
    pricePerUnit,
    selections,
    'event',
  );
  recordRealized(account, event.instrumentId, position.currency, outcome.realizedPnl);
  bookCash(account, position.currency, event.amount, envelope.eventId, event.settleTimestampMs);
  finalizePosition(account, position);
}

// ---------------------------------------------------------------------------------------------------
// fixed-income.redemption
// ---------------------------------------------------------------------------------------------------

function applyRedemption(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  event: FixedIncomeRedemptionEvent,
): void {
  const account = accountOf(state, envelope.accountId);
  const position = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.instrumentId,
    'event.instrumentId',
  );
  requireCashOnTrade(functionName, envelope, position, 'event.instrumentId');
  requireEventCurrency(functionName, envelope, position, event.currency, 'event.currency');
  closingCapacity(functionName, envelope, position, event.quantity, 'event.quantity');
  if (event.redemptionType === 'maturity' && !coversWholePosition(position, event.quantity)) {
    refuse(
      functionName,
      envelope,
      'event.quantity',
      `redeems ${event.quantity} of ${held(position)} at maturity — a maturity retires the whole instrument. Record redemptionType 'principal-paydown' for a partial return of principal, or the full ${Math.abs(position.quantity)}.`,
    );
  }
  const direction = Math.sign(position.quantity);
  const outcome = relieveQuantity(
    functionName,
    state,
    envelope,
    position,
    event.quantity,
    event.pricePerUnit,
    selectionsForRelief(state, position, event.quantity, event.lotSelections),
    'event.lotSelections',
  );
  recordRealized(account, event.instrumentId, position.currency, outcome.realizedPnl);
  bookCash(
    account,
    position.currency,
    direction * event.quantity * event.pricePerUnit * position.contractMultiplier,
    envelope.eventId,
    event.settleTimestampMs,
  );
  finalizePosition(account, position);
}

// ---------------------------------------------------------------------------------------------------
// position.transfer
// ---------------------------------------------------------------------------------------------------

interface LotMove {
  lot: TaxLot;
  /** Unsigned quantity leaving the lot. */
  quantity: number;
}

/** Which lots (and how much of each) a transfer moves — the kernel's relief law, without relief. */
function planTransfer(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  position: PositionState,
  quantity: number,
  explicit: TradeFillLotSelection[] | undefined,
): LotMove[] {
  const subject = `${envelope.event.eventType} event '${envelope.eventId}'`;
  if (explicit !== undefined && state.lotRelief !== 'specific-lot') {
    refuse(
      functionName,
      envelope,
      'event.lotSelections',
      `carries lotSelections, but this ledger's lotRelief is '${state.lotRelief}' — the selections would be silently ignored. Remove them, or fold under lotRelief: 'specific-lot'.`,
    );
  }
  if (state.lotRelief === 'specific-lot') {
    const selections = selectionsForRelief(state, position, quantity, explicit);
    if (selections === undefined) {
      refuse(
        functionName,
        envelope,
        'event.lotSelections',
        `moves ${quantity} of ${held(position)} under lotRelief 'specific-lot', so event.lotSelections must name the lots moved (their quantities summing to ${quantity}).`,
        ErrorCode.InputMissingField,
      );
    }
    const selectedTotal = selections.reduce((sum, s) => sum + s.quantity, 0);
    if (Math.abs(selectedTotal - quantity) > QUANTITY_DUST) {
      refuse(
        functionName,
        envelope,
        'event.lotSelections',
        `moves ${quantity} of ${position.instrumentId}, but its lotSelections sum to ${selectedTotal} — specific-lot selection must name exactly the moved quantity.`,
      );
    }
    return selections.map((selection) => {
      const lot = position.lots.find((candidate) => candidate.lotId === selection.lotId);
      if (lot === undefined) {
        throw new DataError(
          `${functionName}: ${subject} names lot '${selection.lotId}', which does not exist in the ${position.instrumentId} position of account '${envelope.accountId}' — a transfer never guesses a substitute. Open lots: ${position.lots.map((l) => `${l.lotId} (${l.quantity})`).join(', ') || 'none'}.`,
          {
            code: ErrorCode.PortfolioLotUnavailable,
            context: { function: functionName, lotId: selection.lotId, eventId: envelope.eventId },
          },
        );
      }
      if (Math.abs(lot.quantity) + QUANTITY_DUST < selection.quantity) {
        throw new DataError(
          `${functionName}: ${subject} moves ${selection.quantity} from lot '${selection.lotId}', which holds only ${Math.abs(lot.quantity)}.`,
          {
            code: ErrorCode.PortfolioLotUnavailable,
            context: { function: functionName, lotId: selection.lotId, eventId: envelope.eventId },
          },
        );
      }
      return { lot, quantity: selection.quantity };
    });
  }
  const moves: LotMove[] = [];
  let remaining = quantity;
  for (const lot of reliefOrder(position.lots, state.lotRelief)) {
    if (remaining <= QUANTITY_DUST) break;
    const take = Math.min(Math.abs(lot.quantity), remaining);
    moves.push({ lot, quantity: take });
    remaining -= take;
  }
  return moves;
}

/** The destination's open position must agree with the moving lots' profile — named for the RECEIVING account. */
function requireDestinationProfile(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  toAccountId: string,
  existing: PositionState,
  moving: PositionState,
): void {
  const disagreement =
    existing.currency !== moving.currency
      ? `in ${existing.currency}, while the moving lots are in ${moving.currency}`
      : existing.contractMultiplier !== moving.contractMultiplier
        ? `with contractMultiplier ${existing.contractMultiplier}, while the moving lots carry ${moving.contractMultiplier}`
        : existing.settlementStyle !== moving.settlementStyle
          ? `settling '${existing.settlementStyle}', while the moving lots settle '${moving.settlementStyle}'`
          : canonicalJsonOf(existing.contract ?? null) !== canonicalJsonOf(moving.contract ?? null)
            ? `under contract terms that differ from the moving lots'`
            : null;
  if (disagreement !== null) {
    refuse(
      functionName,
      envelope,
      'event.toAccountId',
      `moves ${moving.instrumentId} into account '${toAccountId}', which holds ${held(existing)} ${disagreement} — one profile per open position. Close the destination position first, or transfer into an account whose ${moving.instrumentId} position agrees.`,
    );
  }
}

function applyTransfer(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  event: PositionTransferEvent,
): void {
  const source = accountOf(state, envelope.accountId);
  const position = requireHeldPosition(
    functionName,
    source,
    envelope,
    event.instrumentId,
    'event.instrumentId',
  );
  closingCapacity(functionName, envelope, position, event.quantity, 'event.quantity');
  const receiver = accountOf(state, event.toAccountId);
  const existing = ownValue(receiver.positions, event.instrumentId);
  if (existing !== undefined) {
    requireDestinationProfile(functionName, envelope, event.toAccountId, existing, position);
  }
  const destination = ensurePosition(
    functionName,
    receiver,
    envelope,
    event.instrumentId,
    profileOf(position),
    'event.toAccountId',
  );
  const sign: 1 | -1 = position.quantity < 0 ? -1 : 1;
  requireReceivingDirection(
    functionName,
    envelope,
    event.toAccountId,
    destination,
    sign,
    'event.toAccountId',
  );
  const moves = planTransfer(
    functionName,
    state,
    envelope,
    position,
    event.quantity,
    event.lotSelections,
  );
  for (const { lot, quantity } of moves) {
    if (Math.abs(lot.quantity) - quantity <= QUANTITY_DUST) {
      // The whole lot travels: its identity, opening date, and basis are unchanged.
      position.lots.splice(position.lots.indexOf(lot), 1);
      destination.lots.push(lot);
    } else {
      // A partial move splits the lot: the moved part is a NEW lot (fold-deterministic id) that
      // keeps the source lot's opening date and opening event, so the holding period is preserved.
      const moved = openLot(state, destination, sign * quantity, lot.costBasisPerUnit, envelope);
      moved.openedTimestampMs = lot.openedTimestampMs;
      moved.openedByEventId = lot.openedByEventId;
      lot.quantity -= sign * quantity;
    }
  }
  finalizePosition(source, position);
  finalizePosition(receiver, destination);
}

// ---------------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------------

/** Fold one corporate-action / redemption / transfer envelope into the working state. */
export function applyCorporateEvent(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
): void {
  const event = envelope.event;
  switch (event.eventType) {
    case 'corporate.symbol-change':
      applySymbolChange(functionName, state, envelope, event);
      return;
    case 'corporate.merger':
      applyMerger(functionName, state, envelope, event);
      return;
    case 'corporate.spin-off':
      applySpinOff(functionName, state, envelope, event);
      return;
    case 'corporate.return-of-capital':
      applyReturnOfCapital(functionName, state, envelope, event);
      return;
    case 'corporate.cash-in-lieu':
      applyCashInLieu(functionName, state, envelope, event);
      return;
    case 'fixed-income.redemption':
      applyRedemption(functionName, state, envelope, event);
      return;
    case 'position.transfer':
      applyTransfer(functionName, state, envelope, event);
      return;
    default:
      throw new InputError(
        `${functionName}: '${event.eventType}' is not a corporate-action, redemption, or transfer event.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { function: functionName, field: 'event.eventType', eventId: envelope.eventId },
        },
      );
  }
}

/**
 * Undo one applied envelope of this family EXACTLY, or refuse with the reason (through the
 * kernel's `infeasible`). `applied` is the registry-proven original; `key` its registry identity.
 * Only the symbol change has an exact inverse from state alone; the fold records no effect for
 * the other families, so their reversal is the correcting economic event.
 */
export function reverseCorporateEvent(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  applied: PortfolioEventEnvelope,
  _key: string,
): void {
  const target = applied.event;
  if (target.eventType === 'corporate.symbol-change') {
    reverseSymbolChange(functionName, state, envelope, applied, target);
    return;
  }
  // Every other family transformed or relieved lots without an effect record: name why.
  let detail: string;
  switch (target.eventType) {
    case 'corporate.merger':
      detail =
        target.sharesPerShare === undefined
          ? `the cash merger relieved every ${target.fromInstrumentId} lot at ${target.cashPerShare} and realized the result; relieved lots cannot be restored exactly.`
          : `the merger converted every ${target.fromInstrumentId} lot into ${target.toInstrumentId}${target.cashPerShare !== undefined ? ' after re-basing it for the cash consideration' : ''}; transformed lots cannot be restored exactly.`;
      break;
    case 'corporate.spin-off':
      detail = `the spin-off re-based every ${target.parentInstrumentId} lot and opened ${target.childInstrumentId} lots from them; the fold keeps no per-lot record of the allocation.`;
      break;
    case 'corporate.return-of-capital':
      detail = `the return of capital re-based every ${target.instrumentId} lot (floored at zero where the distribution exceeded basis) and the fold keeps no per-lot record of the reduction — later fills or relief would blur it. Record a cash.withdrawal for the cash and an admin.correction of the acquiring fills if the basis must be restored.`;
      break;
    case 'corporate.cash-in-lieu':
      detail = `the cash-in-lieu relieved ${target.quantity} ${target.instrumentId} from prior lots and realized the result; relieved lots cannot be restored exactly.`;
      break;
    case 'fixed-income.redemption':
      detail = `the ${target.redemptionType} redemption relieved ${target.quantity} ${target.instrumentId} from prior lots and realized the result; relieved lots cannot be restored exactly.`;
      break;
    case 'position.transfer':
      detail = `the transfer moved ${target.quantity} ${target.instrumentId} from '${target.fromAccountId}' to '${target.toAccountId}', splitting lots where needed, and the fold keeps no record of which lots travelled. Record a position.transfer back from '${target.toAccountId}' instead.`;
      break;
    default:
      detail = `'${target.eventType}' has no inverse in this module.`;
  }
  infeasible(functionName, envelope, detail);
}
