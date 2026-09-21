/**
 * Derivative lifecycle (FC7 slice 5, 2026-08-29; agent-native "Derivative lifecycle" family; FC7
 * mandatory state "option exercise, assignment, expiration, physical/cash settlement, and
 * multiplier changes" and "futures variation margin and contract rolls"): every family here folds
 * through the ONE reducer kernel a fill uses — one relief law, one lot-opening law, one
 * cash-booking law — so an exercise relieves option lots and opens underlying lots with exactly
 * the arithmetic the equivalent fills would.
 *
 * Semantics (position currency, multiplier `m`, and terms come from the position — `ensurePosition`
 * proved them at the opening fill; every event quantity is in contracts, underlying quantities are
 * `contracts × m`):
 *
 * - `derivative.exercise` — a LONG option position. Cash settlement relieves the contracts at the
 *   intrinsic value per underlying unit (`max(0, S − K)` for a call, `max(0, K − S)` for a put)
 *   and books `intrinsic × q × m`; the premium is necessarily realized (there is no underlying lot
 *   to fold it into). Physical settlement relieves the contracts at 0 (`'realize'`: the premium is
 *   the option's realized loss) or at each lot's own basis (`'fold-into-underlying-basis'`:
 *   realized 0, the relieved-quantity-weighted premium per underlying unit moves into the
 *   delivery price), then buys (call) or sells (put) `q × m` of the underlying at the strike with
 *   the same lot mechanics as a fill; cash moves at the strike.
 * - `derivative.assignment` — the mirror image for a SHORT option position: the premium received
 *   is realized (`'realize'`) or improves the delivery price (`'fold'`); a short call delivers
 *   (sells) the underlying, a short put takes delivery (buys).
 * - `derivative.expiration` — any option position; the contracts are relieved at 0 and no cash
 *   moves (a long expires at a loss of its premium, a short keeps it).
 * - `derivative.multiplier-change` — every open lot's per-unit basis scales by `before / after`
 *   so `Σ lot.quantity × basis × multiplier` is preserved exactly; the position's multiplier is
 *   replaced. An option's strike changes only when the event explicitly carries
 *   `strikePricePerUnitAfter`; the ledger never derives an adjusted strike from the multiplier.
 * - `derivative.variation-margin` — a `'variation-margin'` position settles
 *   `Σ (S − lot basis) × lot quantity × m` in cash and as realized P&L (a short lot gains when
 *   the price falls), and every lot re-bases to `S`; a second settlement at the same price
 *   realizes 0.
 * - `derivative.roll` — closes `quantity` of the from-contract at the close price (proceeds for a
 *   cash-on-trade position, realized P&L for a variation-margin one) and opens the successor with
 *   the same sign at the open price under the SAME currency, multiplier, and settlement style.
 *
 * Reversal: every family here relieves or re-bases lots. Without an effect record an exact
 * inverse is not provable, so `reverseDerivativeEvent` refuses through the kernel's `infeasible`
 * (`portfolio.reversal_infeasible`) naming the family and the correcting event to record instead.
 * A multiplier change is refused too: the applied event carries only the multiplier AFTER, and
 * the fold does not keep the multiplier before, so the inverse cannot be proven from the fact —
 * record the multiplier change back to the prior multiplier.
 *
 * Package-internal: dispatched from `state.ts`; nothing here is curated public surface.
 */

import { ErrorCode, InputError, sideOf } from '@totalfinance/core';
import type {
  ContractMultiplierChangeEvent,
  DerivativeContractTerms,
  DerivativeRollEvent,
  OptionAssignmentEvent,
  OptionContractTerms,
  OptionExerciseEvent,
  OptionExpirationEvent,
  PortfolioEventEnvelope,
  SettlementStyle,
  VariationMarginEvent,
} from './events.js';
import type { PositionProfile } from './reducer-kernel.js';
import {
  accountOf,
  bookCash,
  closingCapacity,
  ensurePosition,
  finalizePosition,
  foldPositionLeg,
  infeasible,
  recordRealized,
  relieveQuantity,
  requireHeldPosition,
} from './reducer-kernel.js';
import type { AccountState, PortfolioState, PositionState } from './state.js';

export type DerivativeLifecycleEventType =
  | 'derivative.exercise'
  | 'derivative.assignment'
  | 'derivative.expiration'
  | 'derivative.multiplier-change'
  | 'derivative.variation-margin'
  | 'derivative.roll';

// ---------------------------------------------------------------------------------------------------
// Local primitives (candidates for the kernel — named in the slice report)
// ---------------------------------------------------------------------------------------------------

/** Signed direction of a held position, as prose. */
function directionOf(position: PositionState): 'long' | 'short' {
  return position.quantity > 0 ? 'long' : 'short';
}

/** The position's terms as prose for a teaching: what the account actually holds. */
function describeTerms(position: PositionState): string {
  const terms = position.contract;
  if (terms === undefined) {
    return `carries no derivative terms (a cash instrument with multiplier ${position.contractMultiplier})`;
  }
  if (terms.kind === 'option') {
    return `is a ${terms.type} option on ${terms.underlyingInstrumentId} struck at ${terms.strikePricePerUnit}`;
  }
  return `is a ${terms.kind} on ${terms.underlyingInstrumentId}`;
}

/** Book a signed cash amount unless it is exactly zero — a zero leg is not a cash movement. */
function bookNonZeroCash(
  account: AccountState,
  currency: string,
  amount: number,
  envelope: PortfolioEventEnvelope,
  settleTimestampMs: number | undefined,
): void {
  if (amount === 0) return;
  bookCash(account, currency, amount, envelope.eventId, settleTimestampMs);
}

/** The option terms a lifecycle event requires, or the typed refusal naming what is held instead. */
function requireOptionTerms(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  position: PositionState,
  field: string,
): OptionContractTerms {
  const terms = position.contract;
  if (terms !== undefined && terms.kind === 'option') return terms;
  throw new InputError(
    `${functionName}: ${envelope.event.eventType} event '${envelope.eventId}' names ${position.instrumentId}, but the ${directionOf(position)} position of ${Math.abs(position.quantity)} in account '${envelope.accountId}' ${describeTerms(position)} — only an option position (a fill with contract.kind 'option') exercises, is assigned, or expires. ${
      terms === undefined
        ? 'Record the opening fill with its contract terms, or close the position with a trade.fill.'
        : `A ${terms.kind} settles through derivative.variation-margin and closes with a trade.fill or a derivative.roll.`
    }`,
    {
      code: ErrorCode.InputOutOfRange,
      context: { function: functionName, field, eventId: envelope.eventId },
    },
  );
}

/** Explicit derivative terms required by lifecycle events that apply across contract kinds. */
function requireDerivativeTerms(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  position: PositionState,
  field: string,
): DerivativeContractTerms {
  if (position.contract !== undefined) return position.contract;
  throw new InputError(
    `${functionName}: ${envelope.event.eventType} event '${envelope.eventId}' names ${position.instrumentId}, but the position in account '${envelope.accountId}' ${describeTerms(position)} and settles '${position.settlementStyle}' — derivative lifecycle events require a fill with explicit contract terms; a multiplier alone is not a derivative identity. Cash-on-trade instruments mark through portfolioSnapshot and close with trade.fill. Record the opening fill with contract.kind and its terms, or use trade.fill to close this position.`,
    {
      code: ErrorCode.InputOutOfRange,
      context: { function: functionName, field, eventId: envelope.eventId },
    },
  );
}

/** Dated contracts may be acted on through their expiry instant, never after it. */
function requireContractLiveAtEvent(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  terms: DerivativeContractTerms,
  field: string,
): void {
  if (terms.kind === 'perpetual' || envelope.effectiveTimestampMs <= terms.expiryTimestampMs)
    return;
  throw new InputError(
    `${functionName}: ${envelope.event.eventType} event '${envelope.eventId}' occurs at ${envelope.effectiveTimestampMs}, after ${field} expired at ${terms.expiryTimestampMs} — a dated contract may be exercised, assigned, adjusted, margin-settled, or rolled only through its expiry instant. Record the event at its actual effective time, or use the appropriate expiration/closing fact.`,
    {
      code: ErrorCode.InputOutOfRange,
      context: {
        function: functionName,
        field,
        eventId: envelope.eventId,
        effectiveTimestampMs: envelope.effectiveTimestampMs,
        expiryTimestampMs: terms.expiryTimestampMs,
      },
    },
  );
}

/** Expiration is valid at or after the contract's declared expiry, never before it. */
function requireExpiryReached(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  terms: OptionContractTerms,
): void {
  if (envelope.effectiveTimestampMs >= terms.expiryTimestampMs) return;
  throw new InputError(
    `${functionName}: derivative.expiration event '${envelope.eventId}' occurs at ${envelope.effectiveTimestampMs}, before ${envelope.event.eventType === 'derivative.expiration' ? envelope.event.instrumentId : 'the option'} expires at ${terms.expiryTimestampMs} — expiration is inclusive at the declared expiry instant and may be recorded later, but never early.`,
    {
      code: ErrorCode.InputOutOfRange,
      context: {
        function: functionName,
        field: 'event.instrumentId',
        eventId: envelope.eventId,
        effectiveTimestampMs: envelope.effectiveTimestampMs,
        expiryTimestampMs: terms.expiryTimestampMs,
      },
    },
  );
}

/** The one profile-vs-terms law the fill validator enforces, re-applied to a roll's successor. */
function requireStyleForTerms(
  functionName: string,
  envelope: PortfolioEventEnvelope,
  instrumentId: string,
  style: SettlementStyle,
  terms: DerivativeContractTerms,
  field: string,
): void {
  const expected: SettlementStyle = terms.kind === 'option' ? 'cash-on-trade' : 'variation-margin';
  if (style === expected) return;
  throw new InputError(
    `${functionName}: ${envelope.event.eventType} event '${envelope.eventId}' opens ${instrumentId} as a ${terms.kind} under settlementStyle '${style}' (carried from the closed position), but a ${terms.kind} settles '${expected}' — a roll's successor is the same kind of contract as the position it replaces. Roll into a ${terms.kind} of the same style, or open the successor with its own trade.fill.`,
    {
      code: ErrorCode.InputOutOfRange,
      context: { function: functionName, field, eventId: envelope.eventId },
    },
  );
}

// ---------------------------------------------------------------------------------------------------
// Exercise and assignment (one settlement law, two directions)
// ---------------------------------------------------------------------------------------------------

/** Intrinsic value per underlying unit at settlement price `S` for strike `K`. */
function intrinsicPerUnit(type: 'call' | 'put', S: number, K: number): number {
  return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
}

function settleOption(
  functionName: string,
  state: PortfolioState,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  event: OptionExerciseEvent | OptionAssignmentEvent,
): void {
  const isExercise = event.eventType === 'derivative.exercise';
  const position = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.instrumentId,
    'event.instrumentId',
  );
  const terms = requireOptionTerms(functionName, envelope, position, 'event.instrumentId');
  requireContractLiveAtEvent(functionName, envelope, terms, 'event.instrumentId');
  const held = directionOf(position);
  if ((isExercise && held !== 'long') || (!isExercise && held !== 'short')) {
    throw new InputError(
      `${functionName}: ${event.eventType} event '${envelope.eventId}' names ${event.instrumentId}, but account '${envelope.accountId}' holds a ${held} position of ${Math.abs(position.quantity)} contracts — ${
        isExercise
          ? 'a holder exercises LONG contracts; a writer is assigned on short ones. Record derivative.assignment instead.'
          : 'a writer is assigned on SHORT contracts; a holder exercises long ones. Record derivative.exercise instead.'
      }`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'event.instrumentId', eventId: envelope.eventId },
      },
    );
  }
  closingCapacity(functionName, envelope, position, event.quantity, 'event.quantity');

  const q = event.quantity;
  const m = position.contractMultiplier;
  const K = terms.strikePricePerUnit;
  const currency = position.currency;
  const underlyingUnits = q * m;
  // The settled side of the underlying: a holder's call takes delivery, a holder's put delivers;
  // a writer's call delivers, a writer's put takes delivery.
  const underlyingSide: 'buy' | 'sell' =
    (isExercise && terms.type === 'call') || (!isExercise && terms.type === 'put') ? 'buy' : 'sell';

  if (event.settlement.kind === 'cash') {
    if (event.premiumTreatment !== 'realize') {
      throw new InputError(
        `${functionName}: ${event.eventType} event '${envelope.eventId}' settles ${event.instrumentId} in cash with premiumTreatment 'fold-into-underlying-basis', but a cash settlement delivers no underlying lot to fold the premium into — the premium is realized on the option lots. Record premiumTreatment: 'realize'.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: {
            function: functionName,
            field: 'event.premiumTreatment',
            eventId: envelope.eventId,
          },
        },
      );
    }
    const intrinsic = intrinsicPerUnit(terms.type, event.settlement.settlementPricePerUnit, K);
    const outcome = relieveQuantity(
      functionName,
      state,
      envelope,
      position,
      q,
      intrinsic,
      event.lotSelections,
      'event.lotSelections',
    );
    recordRealized(account, event.instrumentId, currency, outcome.realizedPnl);
    finalizePosition(account, position);
    // The holder receives the intrinsic value; the writer pays it.
    bookNonZeroCash(
      account,
      currency,
      (isExercise ? 1 : -1) * intrinsic * underlyingUnits,
      envelope,
      event.settleTimestampMs,
    );
    return;
  }

  // Physical settlement. The option lots are relieved at 0 ('realize': the premium is the
  // option's realized P&L) or at their own basis ('fold': realized 0, the premium travels into
  // the delivery price as the relieved-quantity-weighted average per underlying unit).
  const fold = event.premiumTreatment === 'fold-into-underlying-basis';
  const outcome = relieveQuantity(
    functionName,
    state,
    envelope,
    position,
    q,
    0,
    event.lotSelections,
    'event.lotSelections',
  );
  let premiumPerUnit = 0;
  if (fold) {
    const premiumPerContract = outcome.relieved.reduce(
      (sum, lot) => sum + lot.costBasisPerUnit * lot.quantity,
      0,
    );
    premiumPerUnit = premiumPerContract / q;
  } else {
    recordRealized(account, event.instrumentId, currency, outcome.realizedPnl);
  }
  finalizePosition(account, position);

  // The delivery price per underlying unit: the strike, moved by the folded premium — against
  // the holder (who paid it) and in favour of the writer (who received it).
  const premiumSign = (isExercise ? 1 : -1) * (underlyingSide === 'buy' ? 1 : -1);
  const deliveryPricePerUnit = K + premiumSign * premiumPerUnit;
  const underlying = ensurePosition(
    functionName,
    account,
    envelope,
    terms.underlyingInstrumentId,
    { currency, contractMultiplier: 1, settlementStyle: 'cash-on-trade' },
    'event.instrumentId',
  );
  foldPositionLeg(
    functionName,
    state,
    account,
    envelope,
    underlying,
    underlyingSide,
    underlyingUnits,
    deliveryPricePerUnit,
    undefined,
    'event.lotSelections',
    `delivers ${terms.underlyingInstrumentId} and`,
  );
  // Cash moves at the strike: the premium already moved at the option fill.
  bookNonZeroCash(
    account,
    currency,
    (underlyingSide === 'buy' ? -1 : 1) * K * underlyingUnits,
    envelope,
    event.settleTimestampMs,
  );
}

// ---------------------------------------------------------------------------------------------------
// Expiration
// ---------------------------------------------------------------------------------------------------

function applyExpiration(
  functionName: string,
  state: PortfolioState,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  event: OptionExpirationEvent,
): void {
  const position = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.instrumentId,
    'event.instrumentId',
  );
  const terms = requireOptionTerms(functionName, envelope, position, 'event.instrumentId');
  requireExpiryReached(functionName, envelope, terms);
  closingCapacity(functionName, envelope, position, event.quantity, 'event.quantity');
  const outcome = relieveQuantity(
    functionName,
    state,
    envelope,
    position,
    event.quantity,
    0,
    event.lotSelections,
    'event.lotSelections',
  );
  recordRealized(account, event.instrumentId, position.currency, outcome.realizedPnl);
  finalizePosition(account, position);
}

// ---------------------------------------------------------------------------------------------------
// Multiplier change
// ---------------------------------------------------------------------------------------------------

function applyMultiplierChange(
  functionName: string,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  event: ContractMultiplierChangeEvent,
): void {
  const position = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.instrumentId,
    'event.instrumentId',
  );
  const terms = requireDerivativeTerms(functionName, envelope, position, 'event.instrumentId');
  requireContractLiveAtEvent(functionName, envelope, terms, 'event.instrumentId');
  const before = position.contractMultiplier;
  const after = event.contractMultiplierAfter;
  if (before === after) {
    throw new InputError(
      `${functionName}: derivative.multiplier-change event '${envelope.eventId}' sets ${event.instrumentId} to contractMultiplier ${after}, which is what the position in account '${envelope.accountId}' already carries — an unchanged multiplier is not an economic event. Drop the event, or record the adjusted multiplier.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'event.contractMultiplierAfter',
          eventId: envelope.eventId,
        },
      },
    );
  }
  // Σ lot.quantity × basis × multiplier is preserved exactly: basis' × after = basis × before.
  for (const lot of position.lots) {
    lot.costBasisPerUnit = (lot.costBasisPerUnit * before) / after;
  }
  position.contractMultiplier = after;
  // An OCC-style adjustment also restates the strike; the event carries it explicitly — the
  // ledger never derives a strike from a multiplier ratio.
  if (event.strikePricePerUnitAfter !== undefined) {
    if (position.contract?.kind !== 'option') {
      throw new InputError(
        `${functionName}: derivative.multiplier-change event '${envelope.eventId}' carries strikePricePerUnitAfter, but ${event.instrumentId} in account '${envelope.accountId}' ${describeTerms(position)} — only an option has a strike to adjust.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: {
            function: functionName,
            field: 'event.strikePricePerUnitAfter',
            eventId: envelope.eventId,
          },
        },
      );
    }
    position.contract = { ...position.contract, strikePricePerUnit: event.strikePricePerUnitAfter };
  }
  finalizePosition(account, position);
}

// ---------------------------------------------------------------------------------------------------
// Variation margin
// ---------------------------------------------------------------------------------------------------

function applyVariationMargin(
  functionName: string,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  event: VariationMarginEvent,
): void {
  const position = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.instrumentId,
    'event.instrumentId',
  );
  const terms = requireDerivativeTerms(functionName, envelope, position, 'event.instrumentId');
  requireContractLiveAtEvent(functionName, envelope, terms, 'event.instrumentId');
  if (terms.kind === 'option') {
    throw new InputError(
      `${functionName}: derivative.variation-margin event '${envelope.eventId}' names ${event.instrumentId}, but it is an option — option premium cash moves at trade.fill and the position marks through portfolioSnapshot; only a future or perpetual settles variation margin.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'event.instrumentId', eventId: envelope.eventId },
      },
    );
  }
  if (position.settlementStyle !== 'variation-margin') {
    throw new InputError(
      `${functionName}: derivative.variation-margin event '${envelope.eventId}' names ${event.instrumentId}, but the ${directionOf(position)} position of ${Math.abs(position.quantity)} in account '${envelope.accountId}' settles '${position.settlementStyle}' — its cash moved at the fill and it marks to market through portfolioSnapshot; only a 'variation-margin' position (a future or perpetual opened with that settlementStyle) settles daily. Drop the event, or record the position's fills with settlementStyle 'variation-margin'.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'event.instrumentId', eventId: envelope.eventId },
      },
    );
  }
  const S = event.settlementPricePerUnit;
  const m = position.contractMultiplier;
  // Signed by lot direction: a long lot gains when S rises, a short lot when it falls.
  let amount = 0;
  for (const lot of position.lots) {
    amount += (S - lot.costBasisPerUnit) * lot.quantity * m;
    lot.costBasisPerUnit = S;
  }
  bookNonZeroCash(account, position.currency, amount, envelope, undefined);
  recordRealized(account, event.instrumentId, position.currency, amount);
  finalizePosition(account, position);
}

// ---------------------------------------------------------------------------------------------------
// Roll
// ---------------------------------------------------------------------------------------------------

function applyRoll(
  functionName: string,
  state: PortfolioState,
  account: AccountState,
  envelope: PortfolioEventEnvelope,
  event: DerivativeRollEvent,
): void {
  const from = requireHeldPosition(
    functionName,
    account,
    envelope,
    event.fromInstrumentId,
    'event.fromInstrumentId',
  );
  const fromTerms = requireDerivativeTerms(functionName, envelope, from, 'event.fromInstrumentId');
  requireContractLiveAtEvent(functionName, envelope, fromTerms, 'event.fromInstrumentId');
  closingCapacity(functionName, envelope, from, event.quantity, 'event.quantity');
  const sign = from.quantity > 0 ? 1 : -1;
  const q = event.quantity;
  const m = from.contractMultiplier;
  const style = from.settlementStyle;
  const currency = from.currency;

  // The successor's terms: the event's own, or — for a perpetual, which carries no expiry — the
  // closed position's. An option or future successor has its own expiry, so it states its terms.
  let successorTerms: DerivativeContractTerms;
  if (event.contract === undefined) {
    if (fromTerms.kind === 'perpetual') {
      successorTerms = fromTerms;
    } else {
      throw new InputError(
        `${functionName}: derivative.roll event '${envelope.eventId}' rolls ${event.fromInstrumentId} (a ${fromTerms.kind} on ${fromTerms.underlyingInstrumentId} expiring at ${fromTerms.expiryTimestampMs}) into ${event.toInstrumentId} without contract terms — a successor ${fromTerms.kind} has its own expiry, and the ledger never copies one. Record event.contract with the successor's terms.`,
        {
          code: ErrorCode.InputMissingField,
          context: { function: functionName, field: 'event.contract', eventId: envelope.eventId },
        },
      );
    }
  } else {
    successorTerms = event.contract;
  }
  requireContractLiveAtEvent(functionName, envelope, successorTerms, 'event.contract');
  if (successorTerms.kind !== fromTerms.kind) {
    throw new InputError(
      `${functionName}: derivative.roll event '${envelope.eventId}' rolls ${event.fromInstrumentId}, a ${fromTerms.kind}, into ${event.toInstrumentId} described as a ${successorTerms.kind} — a roll closes one contract and opens its successor of the SAME kind (the multiplier and settlement style carry over). Close ${event.fromInstrumentId} with a trade.fill and open ${event.toInstrumentId} with its own fill instead.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'event.contract', eventId: envelope.eventId },
      },
    );
  }
  if (successorTerms.underlyingInstrumentId !== fromTerms.underlyingInstrumentId) {
    throw new InputError(
      `${functionName}: derivative.roll event '${envelope.eventId}' changes the underlying from ${fromTerms.underlyingInstrumentId} to ${successorTerms.underlyingInstrumentId} — a roll changes the contract month or strike, not the economic underlying. Close and reopen as separate trade.fill events to change underlyings.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'event.contract', eventId: envelope.eventId },
      },
    );
  }
  if (
    fromTerms.kind === 'option' &&
    successorTerms.kind === 'option' &&
    successorTerms.type !== fromTerms.type
  ) {
    throw new InputError(
      `${functionName}: derivative.roll event '${envelope.eventId}' changes the option type from ${fromTerms.type} to ${successorTerms.type} — a call-to-put (or put-to-call) change is two trades, not a successor-contract roll.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'event.contract', eventId: envelope.eventId },
      },
    );
  }
  requireStyleForTerms(
    functionName,
    envelope,
    event.toInstrumentId,
    style,
    successorTerms,
    'event.contract',
  );

  // Close the from-contract: proceeds at the close price for a cash-on-trade position, the
  // realized difference for a variation-margin one — exactly the closing fill's cash law.
  const closed = relieveQuantity(
    functionName,
    state,
    envelope,
    from,
    q,
    event.closePricePerUnit,
    event.lotSelections,
    'event.lotSelections',
  );
  recordRealized(account, event.fromInstrumentId, currency, closed.realizedPnl);
  finalizePosition(account, from);
  bookNonZeroCash(
    account,
    currency,
    style === 'cash-on-trade' ? sign * event.closePricePerUnit * q * m : closed.realizedPnl,
    envelope,
    undefined,
  );

  // Open the successor with the same sign and profile.
  const profile: PositionProfile = { currency, contractMultiplier: m, settlementStyle: style };
  profile.contract = successorTerms;
  const to = ensurePosition(
    functionName,
    account,
    envelope,
    event.toInstrumentId,
    profile,
    'event.toInstrumentId',
  );
  foldPositionLeg(
    functionName,
    state,
    account,
    envelope,
    to,
    sideOf(sign, functionName),
    q,
    event.openPricePerUnit,
    undefined,
    'event.lotSelections',
    `opens ${event.toInstrumentId} and`,
  );
  if (style === 'cash-on-trade') {
    bookNonZeroCash(account, currency, -sign * event.openPricePerUnit * q * m, envelope, undefined);
  }
}

// ---------------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------------

/** Fold one derivative-lifecycle envelope into the working state. */
export function applyDerivativeEvent(
  functionName: string,
  state: PortfolioState,
  envelope: PortfolioEventEnvelope,
): void {
  const account = accountOf(state, envelope.accountId);
  const event = envelope.event;
  switch (event.eventType) {
    case 'derivative.exercise':
    case 'derivative.assignment':
      settleOption(functionName, state, account, envelope, event);
      return;
    case 'derivative.expiration':
      applyExpiration(functionName, state, account, envelope, event);
      return;
    case 'derivative.multiplier-change':
      applyMultiplierChange(functionName, account, envelope, event);
      return;
    case 'derivative.variation-margin':
      applyVariationMargin(functionName, account, envelope, event);
      return;
    case 'derivative.roll':
      applyRoll(functionName, state, account, envelope, event);
      return;
    default:
      throw new InputError(
        `${functionName}: '${event.eventType}' event '${envelope.eventId}' is not a derivative-lifecycle event — this reducer folds derivative.exercise | derivative.assignment | derivative.expiration | derivative.multiplier-change | derivative.variation-margin | derivative.roll.`,
        {
          code: ErrorCode.InputInvalidEnum,
          context: { function: functionName, field: 'event.eventType', eventId: envelope.eventId },
        },
      );
  }
}

/**
 * Undo one applied derivative-lifecycle envelope EXACTLY, or refuse with the reason (through the
 * kernel's `infeasible`). `applied` is the registry-proven original; `key` its registry identity.
 * Every family here relieves or re-bases lots and records no effect, so no inverse is provable —
 * the refusal names the family and the correcting event to record instead.
 */
export function reverseDerivativeEvent(
  functionName: string,
  _state: PortfolioState,
  envelope: PortfolioEventEnvelope,
  applied: PortfolioEventEnvelope,
  _key: string,
): void {
  const target = applied.event;
  const settled = (kind: 'physical' | 'cash'): string =>
    kind === 'cash' ? 'settled their intrinsic value in cash' : 'delivered the underlying';
  let detail: string;
  switch (target.eventType) {
    case 'derivative.exercise':
      detail = `derivative.exercise relieved ${target.quantity} ${target.instrumentId} contracts and ${settled(target.settlement.kind)}; relieved lots cannot be restored exactly. Record the offsetting fills instead.`;
      break;
    case 'derivative.assignment':
      detail = `derivative.assignment covered ${target.quantity} short ${target.instrumentId} contracts and ${settled(target.settlement.kind)}; relieved lots cannot be restored exactly. Record the offsetting fills instead.`;
      break;
    case 'derivative.expiration':
      detail = `derivative.expiration relieved ${target.quantity} ${target.instrumentId} contracts at zero; relieved lots cannot be restored exactly. Record the offsetting fill instead.`;
      break;
    case 'derivative.multiplier-change':
      detail = `derivative.multiplier-change carries only the multiplier after (${target.contractMultiplierAfter}) and the fold does not keep the multiplier before, so the inverse cannot be proven from the fact. Record a derivative.multiplier-change on ${target.instrumentId} back to the prior multiplier instead.`;
      break;
    case 'derivative.variation-margin':
      detail = `derivative.variation-margin re-based every ${target.instrumentId} lot to ${target.settlementPricePerUnit} and realized the difference; the prior bases are not kept. Record a derivative.variation-margin at the correct settlement price instead (the next settlement realizes the difference).`;
      break;
    case 'derivative.roll':
      detail = `derivative.roll relieved ${target.quantity} ${target.fromInstrumentId} and opened ${target.toInstrumentId}; relieved lots cannot be restored exactly. Record the offsetting fills (or a roll back) instead.`;
      break;
    default:
      detail = `'${(target as { eventType: string }).eventType}' is not a derivative-lifecycle event.`;
  }
  infeasible(functionName, envelope, detail);
}
