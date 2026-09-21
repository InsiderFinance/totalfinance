/**
 * The execution journal (Decision 6): an append-only event list separate from the portfolio
 * ledger. `applyJournalEvents` folds events to per-order states with the transition table
 * enforced — a fill after a cancellation is a late fill (the order stays terminal, the fill is
 * recorded, the state is `unresolved` with the reason), and a duplicate delivery of a known
 * `eventId` is idempotent (recorded once, reported in diagnostics). Nothing here touches the ledger:
 * the ledger's own `trade.fill` events are the accounting truth; the journal is the order's story.
 */
import { ErrorCode, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { deepFreeze, hasOwnKey } from '../internal.js';
import {
  type ApplyJournalEventsInput,
  type ApplyJournalEventsResult,
  type ExecutionJournalEvent,
  type ExecutionJournalEventType,
  type ExecutionJournalState,
  type ExecutionOrderState,
  type ExecutionOrderStatus,
} from './types.js';
import { refuse, requireExecutionJournalEvent, requireExecutionJournalState } from './validate.js';

const FN = 'applyJournalEvents';
const INPUT_KEYS = ['events', 'previousState'] as const;

/** A journal read folds at most this many events (Decision 11). */
export const EXECUTION_JOURNAL_EVENT_CEILING = 100_000;

const TERMINAL: ReadonlySet<ExecutionOrderStatus> = new Set([
  'filled',
  'cancelled',
  'rejected',
  'expired',
  'unresolved',
]);
/** Fills that are within this fraction of the submitted quantity complete the order. */
const QUANTITY_EPSILON = 1e-9;

function emptyState(): ExecutionJournalState {
  return {
    journalId: null,
    eventCount: 0,
    eventIds: [],
    orders: {},
    preSubmission: {},
    duplicateEventIds: [],
  };
}

function cloneState(state: ExecutionJournalState): ExecutionJournalState {
  const orders: Record<string, ExecutionOrderState> = {};
  for (const [orderId, order] of Object.entries(state.orders)) {
    orders[orderId] = {
      ...order,
      fillIds: [...order.fillIds],
      lateFillIds: [...order.lateFillIds],
    };
  }
  const preSubmission: Record<string, ExecutionJournalEventType[]> = {};
  for (const [orderId, types] of Object.entries(state.preSubmission)) {
    preSubmission[orderId] = [...types];
  }
  return {
    journalId: state.journalId,
    eventCount: state.eventCount,
    eventIds: [...state.eventIds],
    orders,
    preSubmission,
    duplicateEventIds: [...state.duplicateEventIds],
  };
}

function transitionInvalid(event: ExecutionJournalEvent, index: number, why: string): never {
  return refuse(
    FN,
    `input.events[${index}]`,
    `(${event.eventType} for order ${JSON.stringify(event.orderId)}, event ${JSON.stringify(event.eventId)}) is not a valid transition: ${why}`,
    ErrorCode.TradeJournalTransitionInvalid,
  );
}

function requireDetailQuantity(event: ExecutionJournalEvent, index: number): number {
  const quantity = event.detail.quantity;
  if (typeof quantity !== 'number' || !(quantity > 0) || !Number.isFinite(quantity)) {
    transitionInvalid(
      event,
      index,
      `detail.quantity must be a finite number > 0 for a ${event.eventType} event`,
    );
  }
  return quantity;
}

function requireDetailFillId(event: ExecutionJournalEvent, index: number): string {
  const fillId = event.detail.fillId;
  if (typeof fillId !== 'string' || fillId.length === 0) {
    transitionInvalid(
      event,
      index,
      `detail.fillId must name the fill for a ${event.eventType} event`,
    );
  }
  return fillId;
}

function recordFill(
  order: ExecutionOrderState,
  event: ExecutionJournalEvent,
  index: number,
  late: boolean,
): void {
  const quantity = requireDetailQuantity(event, index);
  const fillId = requireDetailFillId(event, index);
  if (order.fillIds.includes(fillId)) {
    transitionInvalid(
      event,
      index,
      `fill ${JSON.stringify(fillId)} is already journaled on this order`,
    );
  }
  const price = event.detail.pricePerUnit;
  const priced = typeof price === 'number' && Number.isFinite(price);
  const previousFilled = order.filledQuantity;
  order.filledQuantity = previousFilled + quantity;
  order.remainingQuantity = Math.max(0, order.submittedQuantity - order.filledQuantity);
  if (priced) {
    const previousNotional =
      order.averageFillPrice === null ? 0 : order.averageFillPrice * previousFilled;
    order.averageFillPrice = (previousNotional + price * quantity) / order.filledQuantity;
  } else if (order.averageFillPrice !== null) {
    order.averageFillPrice = null;
  }
  if (
    !Number.isFinite(order.filledQuantity) ||
    (order.averageFillPrice !== null && !Number.isFinite(order.averageFillPrice))
  ) {
    refuse(
      FN,
      `input.events[${index}].detail`,
      `overflows the order's fill tally (quantity ${quantity}${priced ? ` at ${price}` : ''} onto ${previousFilled} filled); a journal never carries an unrepresentable number`,
    );
  }
  order.fillIds.push(fillId);
  if (late) order.lateFillIds.push(fillId);
}

/**
 * Fold journal events onto a state (Decision 6). The transition table:
 *
 * - `proposed` / `preflighted` / `authorized` are accepted only before `submitted`;
 * - `submitted` opens the order (its `detail.quantity` is the submitted quantity);
 * - `acknowledged` follows `submitted` once;
 * - `partially-filled` and `filled` carry `detail.fillId` and `detail.quantity`; a partial fill
 *   must leave quantity open, a fill must complete it;
 * - `cancel-requested` flags the order, `cancelled` / `replaced` / `expired` / `rejected` close it;
 * - `reconciled` marks any existing order; `unresolved` closes any existing order with a reason;
 * - a fill on an order closed by cancellation, replacement, expiry, or rejection is a LATE FILL:
 *   the fill is recorded, the order becomes `unresolved` (terminal), and the result lists it.
 *
 * Any other sequence refuses with `trade.journal_transition_invalid`; a store appends only what
 * folds. A duplicate `eventId` is skipped and reported.
 */
export function applyJournalEvents(input: ApplyJournalEventsInput): ApplyJournalEventsResult {
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, INPUT_KEYS);
  const { events } = input;
  if (!Array.isArray(events))
    refuse(FN, 'input.events', 'must be an array', ErrorCode.InputWrongType);
  const state =
    input.previousState === undefined
      ? emptyState()
      : cloneState(requireExecutionJournalState(FN, 'input.previousState', input.previousState));
  if (state.eventCount + events.length > EXECUTION_JOURNAL_EVENT_CEILING) {
    refuse(
      FN,
      'input.events',
      `would bring the journal to ${state.eventCount + events.length} events; a journal read folds at most ${EXECUTION_JOURNAL_EVENT_CEILING}`,
      ErrorCode.InputOutOfRange,
    );
  }
  const seen = new Set(state.eventIds);
  // A fill id is source/journal-wide accounting identity, not merely unique within one order.
  const seenFills = new Set(Object.values(state.orders).flatMap((order) => order.fillIds));
  const duplicates: string[] = [];
  const lateFills: ApplyJournalEventsResult['lateFills'] = [];
  const warnings: string[] = [];
  let applied = 0;

  for (let index = 0; index < events.length; index += 1) {
    const event = requireExecutionJournalEvent(FN, `input.events[${index}]`, events[index]);
    if (state.journalId === null) state.journalId = event.journalId;
    else if (event.journalId !== state.journalId) {
      refuse(
        FN,
        `input.events[${index}].journalId`,
        `must be ${JSON.stringify(state.journalId)} (one fold, one journal). Received ${JSON.stringify(event.journalId)}`,
        ErrorCode.InputWrongShape,
      );
    }
    if (seen.has(event.eventId)) {
      duplicates.push(event.eventId);
      state.duplicateEventIds.push(event.eventId);
      continue;
    }
    const order = hasOwnKey(state.orders, event.orderId) ? state.orders[event.orderId] : undefined;
    if (order !== undefined && order.planHash !== event.planHash) {
      transitionInvalid(
        event,
        index,
        `the order belongs to plan ${order.planHash}; the event names plan ${event.planHash}`,
      );
    }
    switch (event.eventType) {
      case 'proposed':
      case 'preflighted':
      case 'authorized': {
        if (order !== undefined) transitionInvalid(event, index, 'the order is already submitted');
        const list = state.preSubmission[event.orderId] ?? [];
        list.push(event.eventType);
        state.preSubmission[event.orderId] = list;
        break;
      }
      case 'submitted': {
        if (order !== undefined) transitionInvalid(event, index, 'the order is already submitted');
        const quantity = requireDetailQuantity(event, index);
        state.orders[event.orderId] = {
          orderId: event.orderId,
          planHash: event.planHash,
          state: 'submitted',
          submittedQuantity: quantity,
          filledQuantity: 0,
          remainingQuantity: quantity,
          averageFillPrice: null,
          fillIds: [],
          lateFillIds: [],
          lastEventId: event.eventId,
          lastTimestampMs: event.timestampMs,
          terminal: false,
          cancelRequested: false,
          reason: null,
          replacedBy: null,
          reconciledEventId: null,
        };
        delete state.preSubmission[event.orderId];
        break;
      }
      case 'acknowledged': {
        if (order === undefined) transitionInvalid(event, index, 'no submitted event precedes it');
        if (order.state !== 'submitted') {
          transitionInvalid(
            event,
            index,
            `the order is ${order.state}; acknowledged follows submitted once`,
          );
        }
        order.state = 'acknowledged';
        break;
      }
      case 'partially-filled':
      case 'filled': {
        if (order === undefined) transitionInvalid(event, index, 'no submitted event precedes it');
        const fillId = requireDetailFillId(event, index);
        if (seenFills.has(fillId))
          transitionInvalid(
            event,
            index,
            `fill ${JSON.stringify(fillId)} is already journaled ${order.fillIds.includes(fillId) ? 'on this order' : 'on another order'}; redeliver its original event instead`,
          );
        seenFills.add(fillId);
        if (order.state === 'filled') {
          transitionInvalid(
            event,
            index,
            'the order is already filled; a further fill would over-fill it',
          );
        }
        if (order.state === 'unresolved' || TERMINAL.has(order.state)) {
          // A late fill: terminal stays terminal, the fill is recorded, the order is unresolved.
          const closedAs =
            order.state === 'unresolved' ? (order.reason ?? 'unresolved') : order.state;
          recordFill(order, event, index, true);
          order.state = 'unresolved';
          order.terminal = true;
          order.reason = `late fill after ${closedAs}: ${event.detail.fillId as string} for ${event.detail.quantity as number}`;
          lateFills.push({
            orderId: order.orderId,
            fillId: event.detail.fillId as string,
            eventId: event.eventId,
          });
          break;
        }
        recordFill(order, event, index, false);
        const complete = order.filledQuantity >= order.submittedQuantity * (1 - QUANTITY_EPSILON);
        if (event.eventType === 'partially-filled') {
          if (complete) {
            transitionInvalid(
              event,
              index,
              `the fill completes the order (${order.filledQuantity} of ${order.submittedQuantity}); journal it as filled`,
            );
          }
          order.state = 'partially-filled';
        } else {
          if (!complete) {
            transitionInvalid(
              event,
              index,
              `the order is not complete (${order.filledQuantity} of ${order.submittedQuantity}); journal a partial fill`,
            );
          }
          if (order.filledQuantity > order.submittedQuantity * (1 + QUANTITY_EPSILON)) {
            transitionInvalid(
              event,
              index,
              `the fills over-fill the order (${order.filledQuantity} of ${order.submittedQuantity})`,
            );
          }
          order.remainingQuantity = 0;
          order.state = 'filled';
          order.terminal = true;
        }
        break;
      }
      case 'rejected': {
        if (order === undefined) transitionInvalid(event, index, 'no submitted event precedes it');
        if (order.terminal) transitionInvalid(event, index, `the order is already ${order.state}`);
        order.state = 'rejected';
        order.terminal = true;
        order.reason = typeof event.detail.reason === 'string' ? event.detail.reason : 'rejected';
        break;
      }
      case 'cancel-requested': {
        if (order === undefined) transitionInvalid(event, index, 'no submitted event precedes it');
        if (order.terminal) transitionInvalid(event, index, `the order is already ${order.state}`);
        order.cancelRequested = true;
        break;
      }
      case 'cancelled':
      case 'expired': {
        if (order === undefined) transitionInvalid(event, index, 'no submitted event precedes it');
        if (order.terminal) transitionInvalid(event, index, `the order is already ${order.state}`);
        order.state = event.eventType;
        order.terminal = true;
        if (typeof event.detail.reason === 'string') order.reason = event.detail.reason;
        break;
      }
      case 'replaced': {
        if (order === undefined) transitionInvalid(event, index, 'no submitted event precedes it');
        if (order.terminal) transitionInvalid(event, index, `the order is already ${order.state}`);
        const replacement = event.detail.replacementOrderId;
        if (typeof replacement !== 'string' || replacement.length === 0) {
          transitionInvalid(
            event,
            index,
            'detail.replacementOrderId must name the replacing order',
          );
        }
        order.state = 'cancelled';
        order.terminal = true;
        order.replacedBy = replacement;
        order.reason = `replaced by ${replacement}`;
        break;
      }
      case 'reconciled': {
        if (order === undefined) transitionInvalid(event, index, 'no submitted event precedes it');
        order.reconciledEventId = event.eventId;
        break;
      }
      case 'unresolved': {
        if (order === undefined) transitionInvalid(event, index, 'no submitted event precedes it');
        order.state = 'unresolved';
        order.terminal = true;
        order.reason = typeof event.detail.reason === 'string' ? event.detail.reason : 'unresolved';
        break;
      }
      default: {
        const never: never = event.eventType;
        transitionInvalid(event, index, `unknown event type ${String(never)}`);
      }
    }
    if (order !== undefined) {
      order.lastEventId = event.eventId;
      order.lastTimestampMs = event.timestampMs;
    }
    seen.add(event.eventId);
    state.eventIds.push(event.eventId);
    state.eventCount += 1;
    applied += 1;
  }

  const orderStates = Object.values(state.orders);
  const unresolvedCount = orderStates.filter((order) => order.state === 'unresolved').length;
  if (duplicates.length > 0) {
    warnings.push(
      `${duplicates.length} duplicate ${duplicates.length === 1 ? 'delivery' : 'deliveries'} skipped (already journaled): ${duplicates.slice(0, 5).join(', ')}${duplicates.length > 5 ? ', …' : ''}`,
    );
  }
  if (lateFills.length > 0) {
    warnings.push(
      `${lateFills.length} late ${lateFills.length === 1 ? 'fill' : 'fills'} recorded on closed orders; those orders are unresolved until reconciliation`,
    );
  }
  const pending = Object.keys(state.preSubmission).length;
  if (pending > 0)
    warnings.push(`${pending} order${pending === 1 ? '' : 's'} journaled only before submission`);
  return deepFreeze({
    state,
    applied,
    duplicates,
    lateFills,
    diagnostics: {
      warnings,
      eventCount: state.eventCount,
      orderCount: orderStates.length,
      duplicateCount: duplicates.length,
      lateFillCount: lateFills.length,
      unresolvedCount,
    },
  });
}

/** The journal's order states in id order — a stable listing for receipts and reconciliation. */
export function journalOrderStates(state: ExecutionJournalState): ExecutionOrderState[] {
  requireExecutionJournalState('journalOrderStates', 'state', state);
  return deepFreeze(
    Object.keys(state.orders)
      .sort()
      .map((orderId) => {
        const order = state.orders[orderId]!;
        return { ...order, fillIds: [...order.fillIds], lateFillIds: [...order.lateFillIds] };
      }),
  );
}
