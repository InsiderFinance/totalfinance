/**
 * The paper broker (Stage 7B.2, Decision 7): the first execution adapter — deterministic,
 * credential-free, and honest. `submit` verifies the grant and journals; `step` meets every open
 * order with the market through the SAME fill path the engines use (`fillOrderWithPolicy`); `cancel`,
 * `deliver`, and `halt` are the hazard surface. The broker never touches the ledger: it returns the
 * ledger events for its fills and the caller (or `portfolio.record_events`) applies them.
 */
import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isOccOptionSymbol,
  requireArgumentObject,
  signOf,
} from '@totalfinance/core';
import type { EpochMs } from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import { portfolioEventsFromFill, requireNormalizedFill } from '@totalfinance/portfolio';
import {
  applyJournalEvents,
  journalOrderStates,
  requireAuthorizationGrant,
  requireExecutionJournalEvent,
  requireExecutionPlan,
  requireTradeOrder,
  verifyAuthorizationGrant,
} from '@totalfinance/portfolio/trade';
import type {
  ExecutionJournalEvent,
  ExecutionJournalState,
  ExecutionOrderState,
  NormalizedFill,
  PortfolioEventEnvelope,
  TradeOrder,
} from '@totalfinance/portfolio';
import type {
  ExecutionJournalDetail,
  ExecutionJournalEventType,
} from '@totalfinance/portfolio/trade';
import { fillOrderWithPolicy } from '../execution/fill-order.js';
import { describeExecutionPolicy, execution } from '../execution/policy.js';
import type { ExecutionPolicy, MarketObservation, OrderIntent } from '../execution/types.js';
import { requireExecutionPolicy, requireMarketObservation } from '../execution/validate.js';
import {
  EXECUTION_RECEIPT_KIND,
  EXECUTION_RECEIPT_SCHEMA_VERSION,
  type CreatePaperBrokerInput,
  type ExecutionReceipt,
  type PaperBroker,
  type PaperBrokerDescription,
  type PaperCancelInput,
  type PaperCancelResult,
  type PaperDeliverInput,
  type PaperDeliverResult,
  type PaperHaltInput,
  type PaperHaltResult,
  type PaperInstrument,
  type PaperStepInput,
  type PaperStepResult,
  type PaperSubmitInput,
} from './types.js';
import {
  requireCreatePaperBrokerInput,
  requirePaperInstruments,
  requireEpochMs,
  requireIdentity,
} from './validate.js';

const CREATE = 'createPaperBroker';
const SUBMIT_KEYS = [
  'plan',
  'grant',
  'idempotencyKey',
  'now',
  'portfolioHash',
  'marketHash',
  'marketAsOf',
  'orders',
] as const;
const STEP_KEYS = ['observations', 'asOf'] as const;
const CANCEL_KEYS = ['orderId', 'now'] as const;
const DELIVER_KEYS = ['event'] as const;
const HALT_KEYS = ['reason', 'now'] as const;
const DAY_MS = 86_400_000;

function refuse(functionName: string, field: string, message: string, code: string): never {
  throw new InputError(`${functionName}: ${field} ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

/**
 * An OCC option symbol fills at its contract multiplier or not at all. The fill kernel's share
 * default of 1 is right for a share and silently wrong for a contract — every cash figure the
 * journal would then carry (notional, commission, slippage, settlement) is 1% of the truth — so an
 * undescribed OCC id, or one described without the field, is refused before anything is journaled.
 */
function requireDeclaredMultiplier(
  functionName: string,
  instrumentId: string,
  terms: PaperInstrument | undefined,
): void {
  if (terms?.contractMultiplier !== undefined || !isOccOptionSymbol(instrumentId)) return;
  refuse(
    functionName,
    `input.instruments[${JSON.stringify(instrumentId)}].contractMultiplier`,
    `is required: ${JSON.stringify(instrumentId)} is an OCC option symbol ${
      terms === undefined ? 'with no instrument terms' : 'described without a contract multiplier'
    }, and the share default of 1 would fill each contract as one share. Describe it with its currency and contractMultiplier (100 for a standard US equity option).`,
    ErrorCode.InputMissingField,
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The order as submitted: the plan's order with the broker's stamp (B6). */
type SubmittedOrder = TradeOrder & { submittedTimestampMs: EpochMs };

/** The fill models' view of a submitted order — the execution grammar's fields, nothing else. */
function toOrderIntent(order: SubmittedOrder, quantity: number): OrderIntent {
  return {
    orderId: order.orderId,
    instrumentId: order.instrumentId,
    side: order.side,
    quantity,
    type: order.type,
    ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
    ...(order.stopPrice !== undefined ? { stopPrice: order.stopPrice } : {}),
    ...(order.timeInForce !== undefined ? { timeInForce: order.timeInForce } : {}),
    submittedTimestampMs: order.submittedTimestampMs,
  };
}

interface OpenOrder {
  order: SubmittedOrder;
  instrument: PaperInstrument;
  submittedAt: EpochMs;
  planHash: string;
  grantHash: string;
  idempotencyKey: string;
  /** B5: the combo this order is a leg of, and the combo's net limit per combo unit. */
  comboId?: string;
  netLimitPrice?: number;
}

/** Combo labels belong to a plan, never to the broker's global open-order namespace. */
function comboKey(entry: OpenOrder): string {
  return JSON.stringify([entry.planHash, entry.comboId]);
}

/**
 * The combo unit a net limit is quoted per: the legs' quantities divided by their greatest common
 * divisor when every quantity is a whole number (a 10-lot 1×1 vertical is ten units; a 5/10 ratio
 * spread is five units of 1×2), else by the smallest leg quantity.
 */
function comboUnitDivisor(quantities: readonly number[]): number {
  if (quantities.every((quantity) => Number.isSafeInteger(quantity))) {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    return quantities.reduce((acc, quantity) => gcd(acc, Math.abs(quantity)), 0) || 1;
  }
  return Math.min(...quantities) || 1;
}

/** A TradeOrder without the broker's submission stamp, for comparing a retry against the original. */
function withoutSubmissionStamp(order: TradeOrder): Omit<TradeOrder, 'submittedTimestampMs'> {
  const { submittedTimestampMs: _stamp, ...rest } = order;
  return rest;
}

function observationTimestamp(observation: MarketObservation): EpochMs {
  switch (observation.kind) {
    case 'bar':
      return observation.bar.timestampMs;
    case 'quote':
      return observation.quote.timestampMs;
    case 'trade':
      return observation.trade.timestampMs;
    case 'order-book':
      return observation.book.timestampMs;
  }
}

/** Preserve executable callbacks while isolating their declared data from caller mutations. */
function clonePolicy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePolicy) as T;
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, clonePolicy(member)]),
    ) as T;
  return value;
}

/**
 * Build the paper broker over a declared execution policy and a ledger's account. Every method is
 * explicit about time (`now` / `asOf`), every journal write folds through the transition table,
 * every fill is a `NormalizedFill` the ledger folds unchanged, and a retry is never a second order.
 */
export function createPaperBroker(input: CreatePaperBrokerInput): PaperBroker {
  requireCreatePaperBrokerInput(CREATE, 'input', input);
  const policy: ExecutionPolicy = deepFreeze(
    clonePolicy(input.execution === undefined ? execution.simplified() : input.execution),
  );
  requireExecutionPolicy(CREATE, 'input.execution', policy);
  const instruments: Readonly<Record<string, PaperInstrument>> = deepFreeze(
    cloneJson(requirePaperInstruments(CREATE, 'input.instruments', input.instruments)),
  );
  for (const [instrumentId, terms] of Object.entries(instruments))
    requireDeclaredMultiplier(CREATE, instrumentId, terms);
  // Descriptions alone omit session-window contents and some numeric model parameters. Include
  // ALL serializable policy data too. Callback labels/versions are the caller's declared identity;
  // their closures cannot be serialized, inferred, or verified by the journal.
  const executionPolicyHash = contentHash({
    conventionsVersion: CONVENTIONS_VERSION,
    description: describeExecutionPolicy(policy),
    parameters: cloneJson(policy),
  });
  const { sourceId, accountId } = input;
  const baseCurrency = input.baseCurrency;
  const journalId = `${sourceId}:journal`;
  const events: ExecutionJournalEvent[] = [];
  let state: ExecutionJournalState = applyJournalEvents({ events: [] }).state;
  const open = new Map<string, OpenOrder>();
  /** Every order ever submitted here — a late fill on a closed order still needs its intent. */
  const intents = new Map<string, OpenOrder>();
  const receiptsByKey = new Map<string, ExecutionReceipt>();
  const receiptList: ExecutionReceipt[] = [];
  let halted: { reason: string; at: EpochMs } | null = null;
  let eventSequence = 0;
  let fillSequence = 0;
  const eventIds = new Set<string>();
  const fillIds = new Set<string>();
  const observedThrough = new Map<string, EpochMs>();

  const sequenceOf = (id: string, prefix: string): number => {
    if (!id.startsWith(prefix)) return 0;
    const suffix = id.slice(prefix.length);
    const number = Number(suffix);
    return /^[1-9]\d*$/.test(suffix) && Number.isSafeInteger(number) ? number : 0;
  };

  const fold = (batch: ExecutionJournalEvent[]) => {
    const copies = cloneJson(batch);
    const known = new Map(events.map((event) => [event.eventId, event]));
    for (const event of copies) {
      const previous = known.get(event.eventId);
      if (previous !== undefined && contentHash(previous) !== contentHash(event))
        refuse(
          CREATE,
          'journal.eventId',
          `${JSON.stringify(event.eventId)} was already recorded with a different body`,
          ErrorCode.TradeIdempotencyConflict,
        );
      known.set(event.eventId, event);
    }
    const result = applyJournalEvents({ events: copies, previousState: state });
    state = result.state;
    for (const event of copies) {
      if (eventIds.has(event.eventId)) continue;
      events.push(deepFreeze(event));
      eventIds.add(event.eventId);
      eventSequence = Math.max(eventSequence, sequenceOf(event.eventId, `${journalId}:`));
      if (event.eventType === 'filled' || event.eventType === 'partially-filled') {
        const fillId = event.detail.fillId!;
        fillIds.add(fillId);
        fillSequence = Math.max(fillSequence, sequenceOf(fillId, `${sourceId}:fill:`));
        if (event.detail.observationTimestampMs !== undefined)
          observedThrough.set(
            event.orderId,
            Math.max(
              observedThrough.get(event.orderId) ?? -Infinity,
              event.detail.observationTimestampMs,
            ),
          );
      }
    }
    return result;
  };
  const journal = (
    orderId: string,
    planHash: string,
    eventType: ExecutionJournalEventType,
    timestampMs: EpochMs,
    detail: ExecutionJournalDetail = {},
    idempotencyKey?: string,
  ): ExecutionJournalEvent => {
    do {
      eventSequence += 1;
    } while (eventIds.has(`${journalId}:${eventSequence}`));
    if (!Number.isSafeInteger(eventSequence))
      refuse(CREATE, 'journal', 'event identity sequence exhausted', ErrorCode.InputOutOfRange);
    return {
      eventId: `${journalId}:${eventSequence}`,
      journalId,
      timestampMs,
      orderId,
      planHash,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      eventType,
      detail,
      sourceId,
      provenance: {},
    };
  };
  const buildReceipt = (input: {
    receiptId: string;
    planHash: string;
    grantHash: string;
    idempotencyKey: string;
    submittedAt: EpochMs;
    orders: ExecutionOrderState[];
    journalEventIds: string[];
  }): ExecutionReceipt => {
    const body = {
      kind: EXECUTION_RECEIPT_KIND,
      schemaVersion: EXECUTION_RECEIPT_SCHEMA_VERSION,
      receiptId: input.receiptId,
      planHash: input.planHash,
      grantHash: input.grantHash,
      idempotencyKey: input.idempotencyKey,
      adapter: 'paper' as const,
      accountId,
      sourceId,
      submittedAt: input.submittedAt,
      orders: input.orders.map((order) => cloneJson(order)),
      fills: [] as NormalizedFill[],
      journalEventIds: [...input.journalEventIds],
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        mode: 'paper' as const,
        execution: describeExecutionPolicy(policy),
        idempotencyConvention:
          'one idempotency key licenses one submission of one plan: a retry with the same key and plan returns this receipt and creates no order; the same key with another plan is trade.idempotency_conflict',
      },
      diagnostics: {
        engine: 'paper-broker' as const,
        warnings: [] as string[],
        orderCount: input.orders.length,
        retried: false,
      },
    };
    return deepFreeze({ ...body, contentHash: contentHash(body) } as ExecutionReceipt);
  };

  const eventsForFill = (
    functionName: string,
    event: ExecutionJournalEvent,
    entry: OpenOrder,
    fill: NormalizedFill,
  ): PortfolioEventEnvelope[] => {
    const terms = entry.instrument;
    requireNormalizedFill(functionName, 'event.detail.fill', fill);
    if (
      fill.accountId !== accountId ||
      fill.instrumentId !== entry.order.instrumentId ||
      fill.side !== entry.order.side ||
      fill.currency !== terms.currency ||
      fill.orderId !== event.orderId ||
      fill.fillId !== event.detail.fillId ||
      fill.quantity !== event.detail.quantity ||
      fill.pricePerUnit !== event.detail.pricePerUnit ||
      fill.filledTimestampMs !== event.timestampMs ||
      (fill.contractMultiplier ?? 1) !== (terms.contractMultiplier ?? 1) ||
      (fill.settlementStyle ?? 'cash-on-trade') !== (terms.settlementStyle ?? 'cash-on-trade') ||
      contentHash(fill.contract ?? null) !== contentHash(terms.contract ?? null)
    )
      refuse(
        functionName,
        'event.detail.fill',
        'does not match its journal event and submitted instrument/order context',
        ErrorCode.InputWrongShape,
      );
    return portfolioEventsFromFill({ fill, sourceId, recordedTimestampMs: event.timestampMs });
  };

  if (input.journal !== undefined) {
    const prior = input.journal.map((event, index) =>
      requireExecutionJournalEvent(CREATE, `input.journal[${index}]`, event),
    );
    for (const event of prior) {
      if (event.journalId !== journalId || event.sourceId !== sourceId)
        refuse(
          CREATE,
          'input.journal',
          `belongs to journal ${JSON.stringify(event.journalId)}; this broker's journal is ${JSON.stringify(journalId)}`,
          ErrorCode.InputWrongShape,
        );
    }
    fold(prior);
    // A receipt is reconstructed from the journal: the submitted events carry the grant hash and the
    // receipt id, the order states are the fold up to that submission's acknowledgements — so a retry
    // through a broker rebuilt from the store returns the SAME receipt, byte for byte.
    const submissions = new Map<
      string,
      {
        planHash: string;
        grantHash: string;
        receiptId: string;
        submittedAt: EpochMs;
        orderIds: string[];
        eventIds: string[];
        last: number;
      }
    >();
    events.forEach((event, index) => {
      if (event.idempotencyKey === undefined) return;
      if (event.eventType === 'submitted') {
        const grantHash = event.detail.artifactHash;
        const receiptId = event.detail.note;
        if (typeof grantHash !== 'string' || typeof receiptId !== 'string')
          refuse(
            CREATE,
            'input.journal',
            'has an incomplete paper submission: missing grant hash or receipt id; migrate from the original execution context before restoring',
            ErrorCode.InputMissingField,
          );
        const entry = submissions.get(event.idempotencyKey) ?? {
          planHash: event.planHash,
          grantHash,
          receiptId,
          submittedAt: event.timestampMs,
          orderIds: [],
          eventIds: [],
          last: index,
        };
        if (
          entry.planHash !== event.planHash ||
          entry.grantHash !== grantHash ||
          entry.receiptId !== receiptId ||
          entry.submittedAt !== event.timestampMs
        )
          refuse(
            CREATE,
            'input.journal',
            'conflicting submission metadata for one idempotency key',
            ErrorCode.TradeIdempotencyConflict,
          );
        entry.orderIds.push(event.orderId);
        entry.eventIds.push(event.eventId);
        entry.last = index;
        submissions.set(event.idempotencyKey, entry);
      } else if (event.eventType === 'acknowledged') {
        const entry = submissions.get(event.idempotencyKey);
        if (entry !== undefined && entry.orderIds.includes(event.orderId)) {
          entry.eventIds.push(event.eventId);
          entry.last = index;
        }
      }
    });
    for (const [key, entry] of [...submissions.entries()].sort((a, b) => a[1].last - b[1].last)) {
      const atSubmission = applyJournalEvents({ events: events.slice(0, entry.last + 1) }).state;
      const receipt = buildReceipt({
        receiptId: entry.receiptId,
        planHash: entry.planHash,
        grantHash: entry.grantHash,
        idempotencyKey: key,
        submittedAt: entry.submittedAt,
        orders: entry.orderIds.map((orderId) => atSubmission.orders[orderId]!),
        journalEventIds: entry.eventIds,
      });
      receiptsByKey.set(key, receipt);
      receiptList.push(receipt);
    }
    for (const event of events) {
      if (event.eventType !== 'submitted') continue;
      const {
        order,
        instrument,
        accountId: submittedAccount,
        baseCurrency: submittedCurrency,
        executionPolicyHash: submittedPolicy,
      } = event.detail;
      if (
        order === undefined ||
        instrument === undefined ||
        submittedAccount === undefined ||
        submittedCurrency === undefined ||
        submittedPolicy === undefined ||
        event.idempotencyKey === undefined ||
        order.timeInForce === undefined ||
        order.submittedTimestampMs === undefined
      )
        refuse(
          CREATE,
          'input.journal',
          `cannot restore order ${JSON.stringify(event.orderId)}: incomplete paper submission context; migrate from the original order, account, instrument and policy before restoring`,
          ErrorCode.InputMissingField,
        );
      if (
        order.orderId !== event.orderId ||
        order.quantity !== event.detail.quantity ||
        submittedAccount !== accountId ||
        submittedCurrency !== baseCurrency
      )
        refuse(
          CREATE,
          'input.journal',
          'submitted order/account/base currency does not match this broker',
          ErrorCode.InputWrongShape,
        );
      if (submittedPolicy !== executionPolicyHash)
        refuse(
          CREATE,
          'input.execution',
          'must have the same declared policy identity as the journal; supply the original policy callbacks and configuration (never substitute restart defaults)',
          ErrorCode.InputWrongShape,
        );
      const suppliedTerms = Object.hasOwn(instruments, order.instrumentId)
        ? instruments[order.instrumentId]
        : undefined;
      if (suppliedTerms !== undefined && contentHash(suppliedTerms) !== contentHash(instrument))
        refuse(
          CREATE,
          'input.instruments',
          `changes the persisted terms for ${JSON.stringify(order.instrumentId)}; omit them to use the journal or supply the original terms`,
          ErrorCode.InputWrongShape,
        );
      const entry: OpenOrder = {
        order: cloneJson({ ...order, submittedTimestampMs: order.submittedTimestampMs }),
        instrument: cloneJson(instrument),
        submittedAt: event.timestampMs,
        planHash: event.planHash,
        grantHash: event.detail.artifactHash!,
        idempotencyKey: event.idempotencyKey,
        ...(event.detail.comboId !== undefined ? { comboId: event.detail.comboId } : {}),
        ...(event.detail.netLimitPrice !== undefined
          ? { netLimitPrice: event.detail.netLimitPrice }
          : {}),
      };
      intents.set(event.orderId, entry);
      if (!state.orders[event.orderId]!.terminal) open.set(event.orderId, entry);
    }
    for (const event of events) {
      if (event.eventType !== 'filled' && event.eventType !== 'partially-filled') continue;
      if (event.detail.fill === undefined)
        refuse(
          CREATE,
          'input.journal',
          'has an incomplete paper fill; its original normalized accounting fact is required for restoration',
          ErrorCode.InputMissingField,
        );
      eventsForFill(CREATE, event, intents.get(event.orderId)!, event.detail.fill);
    }
  }

  const instrumentOf = (instrumentId: string): PaperInstrument =>
    Object.hasOwn(instruments, instrumentId)
      ? instruments[instrumentId]!
      : { currency: baseCurrency };
  const stateOf = (orderId: string): ExecutionOrderState | null =>
    Object.hasOwn(state.orders, orderId) ? state.orders[orderId]! : null;
  const frozenStateOf = (orderId: string): ExecutionOrderState =>
    deepFreeze(cloneJson(state.orders[orderId]!));

  const submit = (request: PaperSubmitInput): ExecutionReceipt => {
    const FN = 'paperBroker.submit';
    requireArgumentObject(FN, 'input', request);
    ensureKnownKeys(FN, 'input', request as object, SUBMIT_KEYS);
    const plan = requireExecutionPlan(FN, 'input.plan', request.plan);
    const grant = requireAuthorizationGrant(FN, 'input.grant', request.grant);
    requireIdentity(FN, 'input.idempotencyKey', request.idempotencyKey);
    requireEpochMs(FN, 'input.now', request.now);
    requireIdentity(FN, 'input.portfolioHash', request.portfolioHash);
    requireIdentity(FN, 'input.marketHash', request.marketHash);
    requireEpochMs(FN, 'input.marketAsOf', request.marketAsOf);
    if (halted !== null) {
      refuse(
        FN,
        'input',
        `is refused: the broker is halted (${halted.reason}, since ${halted.at}); resume before submitting`,
        ErrorCode.TradeHalted,
      );
    }
    const key = request.idempotencyKey;
    const previous = receiptsByKey.get(key);
    if (previous !== undefined) {
      if (previous.planHash !== plan.contentHash) {
        refuse(
          FN,
          'input.idempotencyKey',
          `${JSON.stringify(key)} was already used for plan ${previous.planHash}; this plan is ${plan.contentHash} — one key, one plan`,
          ErrorCode.TradeIdempotencyConflict,
        );
      }
      if (request.orders !== undefined) {
        if (!Array.isArray(request.orders))
          refuse(FN, 'input.orders', 'must be an array of orders', ErrorCode.InputWrongType);
        const retriedOrders = request.orders.map((order, index) => {
          requireTradeOrder(FN, `input.orders[${index}]`, order);
          return withoutSubmissionStamp({
            ...order,
            timeInForce: order.timeInForce ?? policy.timeInForce.default,
          });
        });
        const originalOrders = previous.orders.map((order) =>
          withoutSubmissionStamp(intents.get(order.orderId)!.order),
        );
        if (contentHash(retriedOrders) !== contentHash(originalOrders))
          refuse(
            FN,
            'input.orders',
            'differs from the orders already submitted with this key; a retry cannot amend an order',
            ErrorCode.TradeIdempotencyConflict,
          );
      }
      return previous;
    }
    if (plan.accountId !== accountId) {
      refuse(
        FN,
        'input.plan.accountId',
        `must be this broker's account (${JSON.stringify(accountId)}). Received ${JSON.stringify(plan.accountId)}`,
        ErrorCode.InputOutOfRange,
      );
    }
    let orders: readonly TradeOrder[] = plan.orders;
    if (request.orders !== undefined) {
      if (!Array.isArray(request.orders))
        refuse(FN, 'input.orders', 'must be an array of orders', ErrorCode.InputWrongType);
      orders = request.orders.map((order, index) =>
        requireTradeOrder(FN, `input.orders[${index}]`, order),
      );
    }
    const verification = verifyAuthorizationGrant({
      grant,
      plan,
      now: request.now,
      portfolioHash: request.portfolioHash,
      marketHash: request.marketHash,
      marketAsOf: request.marketAsOf,
      idempotencyKey: key,
      ...(request.orders === undefined ? {} : { orders }),
    });
    if (!verification.valid) {
      const hasExpired = verification.reasons.some((reason) => reason.reason === 'expired');
      throw new InputError(
        `${FN}: input.grant does not authorize this submission — ${verification.reasons.map((reason) => `${reason.reason}: ${reason.detail}`).join('; ')}`,
        {
          code: hasExpired ? ErrorCode.TradeGrantExpired : ErrorCode.TradeGrantInvalid,
          context: {
            function: FN,
            field: 'input.grant',
            reasons: verification.reasons.map((reason) => reason.reason),
          },
        },
      );
    }
    for (const order of orders) {
      if (open.has(order.orderId) || stateOf(order.orderId) !== null) {
        refuse(
          FN,
          'input.orders',
          `order ${JSON.stringify(order.orderId)} is already journaled; a plan submits each order once`,
          ErrorCode.TradeIdempotencyConflict,
        );
      }
      requireDeclaredMultiplier(
        FN,
        order.instrumentId,
        Object.hasOwn(instruments, order.instrumentId)
          ? instruments[order.instrumentId]
          : undefined,
      );
    }
    const receiptId = `${sourceId}:receipt:${receiptList.length + 1}`;
    const comboById = new Map(
      plan.combos.map((combo) => {
        if (combo.netLimitPrice === undefined) return [combo.comboId, combo] as const;
        const planned = combo.orderIds.map(
          (id) => plan.orders.find((order) => order.orderId === id)!,
        );
        const submitted = combo.orderIds.map((id) => orders.find((order) => order.orderId === id)!);
        // Quantity variance preserves the leg ratios, but integer-GCD and fractional-minimum
        // units can differ (5:2 scaled to 4.75:1.9). Translate the quote, not its economics, and
        // persist the effective submitted-unit limit so restoration uses exactly the same terms.
        const plannedUnits =
          planned[0]!.quantity / comboUnitDivisor(planned.map((order) => order.quantity));
        const submittedUnits =
          submitted[0]!.quantity / comboUnitDivisor(submitted.map((order) => order.quantity));
        const netLimitPrice = combo.netLimitPrice * (submittedUnits / plannedUnits);
        if (!Number.isFinite(netLimitPrice))
          refuse(
            FN,
            'input.orders',
            'cannot represent the authorized net limit at these quantities; use smaller quantities and preflight a new plan',
            ErrorCode.InputOutOfRange,
          );
        return [combo.comboId, { ...combo, netLimitPrice }] as const;
      }),
    );
    /** B5/B6: the order as submitted — the broker's stamp, the default time-in-force, its combo. */
    const submittedOrder = (order: TradeOrder): SubmittedOrder => ({
      ...order,
      timeInForce: order.timeInForce ?? policy.timeInForce.default,
      submittedTimestampMs: request.now,
    });
    const comboDetail = (order: TradeOrder): ExecutionJournalDetail => {
      if (order.comboId === undefined) return {};
      const combo = comboById.get(order.comboId);
      return {
        comboId: order.comboId,
        ...(combo?.netLimitPrice !== undefined ? { netLimitPrice: combo.netLimitPrice } : {}),
      };
    };
    const batch: ExecutionJournalEvent[] = [];
    for (const order of orders) {
      batch.push(
        journal(
          order.orderId,
          plan.contentHash,
          'submitted',
          request.now,
          {
            quantity: order.quantity,
            artifactHash: grant.contentHash,
            note: receiptId,
            order: submittedOrder(order),
            instrument: cloneJson(instrumentOf(order.instrumentId)),
            accountId,
            baseCurrency,
            executionPolicyHash,
            ...comboDetail(order),
          },
          key,
        ),
        journal(order.orderId, plan.contentHash, 'acknowledged', request.now, {}, key),
      );
    }
    fold(batch);
    for (const order of orders) {
      const terms = comboDetail(order);
      const entry: OpenOrder = {
        order: cloneJson(submittedOrder(order)),
        instrument: cloneJson(instrumentOf(order.instrumentId)),
        submittedAt: request.now,
        planHash: plan.contentHash,
        grantHash: grant.contentHash,
        idempotencyKey: key,
        ...(terms.comboId !== undefined ? { comboId: terms.comboId } : {}),
        ...(terms.netLimitPrice !== undefined ? { netLimitPrice: terms.netLimitPrice } : {}),
      };
      open.set(order.orderId, entry);
      intents.set(order.orderId, entry);
    }
    const receipt = buildReceipt({
      receiptId,
      planHash: plan.contentHash,
      grantHash: grant.contentHash,
      idempotencyKey: key,
      submittedAt: request.now,
      orders: orders.map((order) => state.orders[order.orderId]!),
      journalEventIds: batch.map((event) => event.eventId),
    });
    receiptsByKey.set(key, receipt);
    receiptList.push(receipt);
    return receipt;
  };

  const step = (request: PaperStepInput): PaperStepResult => {
    const FN = 'paperBroker.step';
    requireArgumentObject(FN, 'input', request);
    ensureKnownKeys(FN, 'input', request as object, STEP_KEYS);
    requireArgumentObject(FN, 'input.observations', request.observations);
    requireEpochMs(FN, 'input.asOf', request.asOf);
    const { asOf } = request;
    for (const [instrumentId, observation] of Object.entries(request.observations)) {
      requireMarketObservation(
        FN,
        `input.observations[${JSON.stringify(instrumentId)}]`,
        observation,
      );
      if (observationTimestamp(observation) > asOf)
        refuse(
          FN,
          'input.observations',
          'contains an observation after input.asOf',
          ErrorCode.InputOutOfRange,
        );
    }
    const fills: NormalizedFill[] = [];
    const ledgerEvents: PortfolioEventEnvelope[] = [];
    const batch: ExecutionJournalEvent[] = [];
    const expired: string[] = [];
    const unfilled: PaperStepResult['unfilled'] = [];
    const closed = new Set<string>();
    const openIds = [...open.keys()].sort();
    const comboLegs = new Map<string, string[]>();
    for (const orderId of openIds) {
      const entry = open.get(orderId)!;
      if (entry.comboId !== undefined) {
        const key = comboKey(entry);
        comboLegs.set(key, [...(comboLegs.get(key) ?? []), orderId]);
      }
    }

    interface Prepared {
      orderId: string;
      entry: OpenOrder;
      current: ExecutionOrderState;
      observation: MarketObservation;
      timestampMs: EpochMs;
    }
    type Blocked =
      | { kind: 'closed' }
      | { kind: 'expired' }
      | {
          kind: 'unfilled';
          reason: PaperStepResult['unfilled'][number]['reason'];
          detail: string;
        };
    type Outcome = { ok: true; prepared: Prepared } | { ok: false; blocked: Blocked };
    /** The pre-checks every open order passes before it meets its observation. */
    const prepare = (orderId: string): Outcome => {
      const entry = open.get(orderId)!;
      const current = stateOf(orderId);
      if (current === null || current.terminal) return { ok: false, blocked: { kind: 'closed' } };
      const observation = request.observations[entry.order.instrumentId];
      const alreadyObserved =
        observation !== undefined &&
        observationTimestamp(observation) <= (observedThrough.get(orderId) ?? -Infinity);
      if (asOf < entry.submittedAt || (asOf < current.lastTimestampMs && !alreadyObserved))
        refuse(
          FN,
          'input.asOf',
          `precedes the last journaled instant for order ${JSON.stringify(orderId)}`,
          ErrorCode.InputOutOfRange,
        );
      const timeInForce = entry.order.timeInForce ?? policy.timeInForce.default;
      if (
        timeInForce === 'day' &&
        policy.timeInForce.expireAtSessionClose &&
        asOf - entry.submittedAt >= DAY_MS
      )
        return { ok: false, blocked: { kind: 'expired' } };
      if (observation === undefined)
        return {
          ok: false,
          blocked: {
            kind: 'unfilled',
            reason: 'no-observation',
            detail: `no observation for ${entry.order.instrumentId} at ${asOf}`,
          },
        };
      const timestampMs = observationTimestamp(observation);
      if (alreadyObserved)
        return {
          ok: false,
          blocked: {
            kind: 'unfilled',
            reason: 'already-observed',
            detail: `observation at ${timestampMs} is not newer than this order's last consumed observation; retries cannot reuse liquidity`,
          },
        };
      // B6: an observation older than the submission is a market the order never saw.
      if (timestampMs < entry.submittedAt)
        return {
          ok: false,
          blocked: {
            kind: 'unfilled',
            reason: 'observation-before-submission',
            detail: `observation at ${timestampMs} precedes the submission at ${entry.submittedAt}; an order fills only against a market it has seen`,
          },
        };
      return { ok: true, prepared: { orderId, entry, current, observation, timestampMs } };
    };
    const record = (orderId: string, entry: OpenOrder, blocked: Blocked): void => {
      if (blocked.kind === 'closed') {
        closed.add(orderId);
        return;
      }
      if (blocked.kind === 'expired') {
        batch.push(
          journal(orderId, entry.planHash, 'expired', asOf, {
            reason: 'day order past its session',
          }),
        );
        expired.push(orderId);
        closed.add(orderId);
        return;
      }
      unfilled.push({ orderId, reason: blocked.reason, detail: blocked.detail });
    };
    const nextFillId = (): string => {
      do {
        fillSequence += 1;
      } while (fillIds.has(`${sourceId}:fill:${fillSequence}`));
      if (!Number.isSafeInteger(fillSequence))
        refuse(FN, 'input', 'fill identity sequence exhausted', ErrorCode.InputOutOfRange);
      return `${sourceId}:fill:${fillSequence}`;
    };
    const decide = (p: Prepared, fillId: string) => {
      const terms = p.entry.instrument;
      const remaining = toOrderIntent(p.entry.order, p.current.remainingQuantity);
      const lag = terms.settlementLag ?? 0;
      return fillOrderWithPolicy({
        policy,
        order: remaining,
        observation: p.observation,
        asOf,
        accountId,
        currency: terms.currency,
        fillId,
        ...(terms.contractMultiplier !== undefined ||
        terms.settlementStyle !== undefined ||
        terms.contract !== undefined
          ? {
              terms: {
                ...(terms.contractMultiplier !== undefined
                  ? { contractMultiplier: terms.contractMultiplier }
                  : {}),
                ...(terms.settlementStyle !== undefined
                  ? { settlementStyle: terms.settlementStyle }
                  : {}),
                ...(terms.contract !== undefined ? { contract: terms.contract } : {}),
              },
            }
          : {}),
        ...(lag > 0 ? { settleTimestampMs: asOf + lag * DAY_MS } : {}),
      });
    };
    const commit = (p: Prepared, fill: NormalizedFill): void => {
      const complete = fill.quantity >= p.current.remainingQuantity * (1 - 1e-9);
      batch.push(
        journal(p.orderId, p.entry.planHash, complete ? 'filled' : 'partially-filled', asOf, {
          fillId: fill.fillId,
          quantity: fill.quantity,
          pricePerUnit: fill.pricePerUnit,
          observationTimestampMs: p.timestampMs,
          fill,
        }),
      );
      fills.push(fill);
      ledgerEvents.push(...portfolioEventsFromFill({ fill, sourceId, recordedTimestampMs: asOf }));
      if (complete) closed.add(p.orderId);
    };

    const done = new Set<string>();
    for (const orderId of openIds) {
      if (done.has(orderId)) continue;
      const entry = open.get(orderId)!;
      if (entry.comboId === undefined) {
        done.add(orderId);
        const outcome = prepare(orderId);
        if (!outcome.ok) {
          record(orderId, entry, outcome.blocked);
          continue;
        }
        const sequenceBefore = fillSequence;
        const result = decide(outcome.prepared, nextFillId());
        if (result.outcome === 'unfilled') {
          fillSequence = sequenceBefore;
          unfilled.push({ orderId, reason: result.reason, detail: result.detail });
          continue;
        }
        commit(outcome.prepared, result.fill);
        continue;
      }
      // B5: a combo is ONE order — every leg meets one observation instant, fills in full, and the
      // net price per combo unit meets the limit; otherwise no leg fills and no liquidity is consumed.
      const comboId = entry.comboId;
      const legs = comboLegs.get(comboKey(entry))!;
      for (const leg of legs) done.add(leg);
      const outcomes = legs.map((leg) => ({ leg, entry: open.get(leg)!, outcome: prepare(leg) }));
      if (outcomes.some((o) => !o.outcome.ok && o.outcome.blocked.kind === 'expired')) {
        // One expired leg expires the combo: a leg cannot stand alone.
        for (const o of outcomes)
          if (o.outcome.ok || o.outcome.blocked.kind !== 'closed')
            record(o.leg, o.entry, { kind: 'expired' });
          else record(o.leg, o.entry, o.outcome.blocked);
        continue;
      }
      const members = [...intents].filter(
        ([, candidate]) => comboKey(candidate) === comboKey(entry),
      );
      if (
        members.length !== legs.length ||
        members.some(([id]) => (stateOf(id)?.filledQuantity ?? 0) > 0)
      ) {
        // Asynchronous delivery may close or partially fill just one leg. Those are external
        // facts to reconcile, not permission to synthesize an orphan/changed-ratio paper fill.
        for (const leg of legs)
          unfilled.push({
            orderId: leg,
            reason: 'combo-leg-unfilled',
            detail: `combo ${comboId} has a closed or externally partially-filled leg; reconcile and cancel the remaining legs before submitting a new plan`,
          });
        continue;
      }
      const blocked = outcomes.filter(
        (o): o is typeof o & { outcome: { ok: false; blocked: Blocked } } => !o.outcome.ok,
      );
      if (blocked.length > 0) {
        for (const o of blocked) record(o.leg, o.entry, o.outcome.blocked);
        const cause = blocked[0]!;
        const why =
          cause.outcome.blocked.kind === 'unfilled'
            ? `${cause.outcome.blocked.reason} (${cause.outcome.blocked.detail})`
            : 'is closed';
        for (const o of outcomes)
          if (o.outcome.ok)
            unfilled.push({
              orderId: o.leg,
              reason: 'combo-leg-unfilled',
              detail: `combo ${comboId}: leg ${JSON.stringify(cause.leg)} ${why}; a combo fills all-or-none`,
            });
        continue;
      }
      const prepared = outcomes.map(
        (o) => (o.outcome as { ok: true; prepared: Prepared }).prepared,
      );
      const instants = [...new Set(prepared.map((p) => p.timestampMs))].sort((a, b) => a - b);
      if (instants.length > 1) {
        for (const p of prepared)
          unfilled.push({
            orderId: p.orderId,
            reason: 'combo-leg-unfilled',
            detail: `combo ${comboId}: its legs were observed at ${instants.join(', ')}; a combo fills against one observation instant`,
          });
        continue;
      }
      const sequenceBefore = fillSequence;
      const decisions = prepared.map((p) => ({ p, result: decide(p, nextFillId()) }));
      const short = decisions.find(
        (d) =>
          d.result.outcome === 'unfilled' ||
          d.result.fill.quantity < d.p.current.remainingQuantity * (1 - 1e-9),
      );
      if (short !== undefined) {
        fillSequence = sequenceBefore;
        const why =
          short.result.outcome === 'unfilled'
            ? `${short.result.reason} (${short.result.detail})`
            : `would fill ${short.result.fill.quantity} of ${short.p.current.remainingQuantity}`;
        for (const p of prepared)
          unfilled.push({
            orderId: p.orderId,
            reason: 'combo-leg-unfilled',
            detail: `combo ${comboId}: leg ${JSON.stringify(short.p.orderId)} ${why}; a combo fills all-or-none`,
          });
        continue;
      }
      const filled = decisions.map((d) => ({
        p: d.p,
        fill: (d.result as { fill: NormalizedFill }).fill,
      }));
      if (entry.netLimitPrice !== undefined) {
        const unit = comboUnitDivisor(filled.map((d) => d.p.current.remainingQuantity));
        const net = filled.reduce(
          (sum, d) =>
            sum +
            signOf(d.p.entry.order.side) *
              d.fill.pricePerUnit *
              (d.p.current.remainingQuantity / unit),
          0,
        );
        if (net > entry.netLimitPrice + 1e-9) {
          fillSequence = sequenceBefore;
          for (const p of prepared)
            unfilled.push({
              orderId: p.orderId,
              reason: 'combo-net-limit',
              detail: `combo ${comboId}: net ${net} per combo unit is worse than the limit ${entry.netLimitPrice} (debit positive, credit negative)`,
            });
          continue;
        }
      }
      for (const d of filled) commit(d.p, d.fill);
    }
    fold(batch);
    for (const orderId of closed) open.delete(orderId);
    return deepFreeze({
      asOf,
      fills,
      events: ledgerEvents,
      journal: batch,
      expired,
      unfilled,
      open: [...open.keys()].sort(),
    });
  };

  const cancel = (request: PaperCancelInput): PaperCancelResult => {
    const FN = 'paperBroker.cancel';
    requireArgumentObject(FN, 'input', request);
    ensureKnownKeys(FN, 'input', request as object, CANCEL_KEYS);
    requireIdentity(FN, 'input.orderId', request.orderId);
    requireEpochMs(FN, 'input.now', request.now);
    const current = stateOf(request.orderId);
    if (current === null)
      refuse(
        FN,
        'input.orderId',
        `${JSON.stringify(request.orderId)} is not a journaled order`,
        ErrorCode.InputOutOfRange,
      );
    if (current.terminal) {
      return deepFreeze({
        orderId: request.orderId,
        accepted: false,
        journal: [],
        state: frozenStateOf(request.orderId),
      });
    }
    const entry = open.get(request.orderId);
    const affected =
      entry?.comboId === undefined
        ? [request.orderId]
        : [...open]
            .filter(([, candidate]) => comboKey(candidate) === comboKey(entry))
            .map(([id]) => id);
    // Validate the entire cancellation before allocating journal IDs or mutating any leg.
    if (affected.some((id) => request.now < stateOf(id)!.lastTimestampMs))
      refuse(
        FN,
        'input.now',
        'precedes the latest journaled order event',
        ErrorCode.InputOutOfRange,
      );
    const batch = affected.flatMap((id) => [
      journal(id, current.planHash, 'cancel-requested', request.now),
      journal(id, current.planHash, 'cancelled', request.now, {
        reason:
          entry?.comboId === undefined
            ? 'cancelled by request'
            : `combo ${entry.comboId} cancelled by request`,
      }),
    ]);
    fold(batch);
    for (const id of affected) open.delete(id);
    return deepFreeze({
      orderId: request.orderId,
      accepted: true,
      journal: batch,
      state: frozenStateOf(request.orderId),
    });
  };

  const deliver = (request: PaperDeliverInput): PaperDeliverResult => {
    const FN = 'paperBroker.deliver';
    requireArgumentObject(FN, 'input', request);
    ensureKnownKeys(FN, 'input', request as object, DELIVER_KEYS);
    const event = requireExecutionJournalEvent(FN, 'input.event', request.event);
    if (event.journalId !== journalId)
      refuse(
        FN,
        'input.event.journalId',
        `must be ${JSON.stringify(journalId)}. Received ${JSON.stringify(event.journalId)}`,
        ErrorCode.InputWrongShape,
      );
    if (event.sourceId !== sourceId)
      refuse(FN, 'input.event.sourceId', "must be this broker's source", ErrorCode.InputWrongShape);
    const entry = intents.get(event.orderId);
    if (entry === undefined)
      refuse(
        FN,
        'input.event.orderId',
        'has no submitted intent in this broker; submit orders through submit before delivering their events',
        ErrorCode.TradeJournalTransitionInvalid,
      );
    const isFill = event.eventType === 'filled' || event.eventType === 'partially-filled';
    let fill: NormalizedFill | null = null;
    let ledgerEvents: PortfolioEventEnvelope[] = [];
    let deliveredEvent = event;
    if (isFill) {
      const terms = entry.instrument;
      const lag = terms.settlementLag ?? 0;
      fill = cloneJson(
        event.detail.fill ?? {
          fillId: event.detail.fillId as string,
          accountId,
          instrumentId: entry.order.instrumentId,
          side: entry.order.side,
          quantity: event.detail.quantity as number,
          pricePerUnit: event.detail.pricePerUnit as number,
          currency: terms.currency,
          filledTimestampMs: event.timestampMs,
          orderId: event.orderId,
          ...(lag > 0 ? { settleTimestampMs: event.timestampMs + lag * DAY_MS } : {}),
          ...(terms.contractMultiplier !== undefined
            ? { contractMultiplier: terms.contractMultiplier }
            : {}),
          ...(terms.settlementStyle !== undefined
            ? { settlementStyle: terms.settlementStyle }
            : {}),
          ...(terms.contract !== undefined ? { contract: terms.contract } : {}),
        },
      );
      ledgerEvents = eventsForFill(FN, event, entry, fill);
      deliveredEvent = { ...event, detail: { ...event.detail, fill } };
    }
    // No mutable state changes until every accounting event and the whole transition validate.
    const result = fold([deliveredEvent]);
    const duplicate = result.duplicates.includes(event.eventId);
    const lateFill = result.lateFills.some((late) => late.eventId === event.eventId);
    const after = stateOf(event.orderId);
    if (after !== null && after.terminal) open.delete(event.orderId);
    return deepFreeze({
      applied: !duplicate,
      duplicate,
      lateFill,
      events: duplicate ? [] : ledgerEvents,
      fill: duplicate ? null : fill,
      state: stateOf(event.orderId) === null ? null : frozenStateOf(event.orderId),
    });
  };

  const halt = (request: PaperHaltInput): PaperHaltResult => {
    const FN = 'paperBroker.halt';
    requireArgumentObject(FN, 'input', request);
    ensureKnownKeys(FN, 'input', request as object, HALT_KEYS);
    requireIdentity(FN, 'input.reason', request.reason);
    requireEpochMs(FN, 'input.now', request.now);
    const batch: ExecutionJournalEvent[] = [];
    const cancelled: string[] = [];
    for (const orderId of [...open.keys()].sort()) {
      const current = stateOf(orderId);
      if (current === null || current.terminal) {
        continue;
      }
      if (request.now < current.lastTimestampMs)
        refuse(
          FN,
          'input.now',
          'precedes the latest journaled order event',
          ErrorCode.InputOutOfRange,
        );
      batch.push(
        journal(orderId, current.planHash, 'cancel-requested', request.now, {
          reason: `halt: ${request.reason}`,
        }),
        journal(orderId, current.planHash, 'cancelled', request.now, {
          reason: `halt: ${request.reason}`,
        }),
      );
      cancelled.push(orderId);
    }
    fold(batch);
    for (const orderId of cancelled) open.delete(orderId);
    halted = { reason: request.reason, at: request.now };
    return deepFreeze({ halted: true as const, reason: request.reason, cancelled, journal: batch });
  };

  const resume = (request: { now: EpochMs }): { halted: false } => {
    requireArgumentObject('paperBroker.resume', 'input', request);
    requireEpochMs('paperBroker.resume', 'input.now', request.now);
    halted = null;
    return { halted: false };
  };

  const describe = (): PaperBrokerDescription =>
    deepFreeze({
      adapter: 'paper' as const,
      sourceId,
      accountId,
      journalId,
      execution: describeExecutionPolicy(policy),
      halted: halted !== null,
      haltReason: halted === null ? null : halted.reason,
      openOrderCount: open.size,
      eventCount: events.length,
      receiptCount: receiptList.length,
    });

  return Object.freeze({
    submit,
    step,
    cancel,
    deliver,
    halt,
    resume,
    journal: () => deepFreeze(cloneJson(events)),
    state: () => deepFreeze(cloneJson(state)),
    openOrders: () => journalOrderStates(state).filter((order) => !order.terminal),
    receipts: () => [...receiptList],
    describe,
  });
}
