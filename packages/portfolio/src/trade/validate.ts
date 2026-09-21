import {
  ErrorCode,
  InputError,
  ORDER_TYPES,
  TIME_IN_FORCE_VALUES,
  ensureKnownKeys,
  requireArgumentObject,
} from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import { requireNormalizedFill } from '@totalfinance/portfolio/events';
import {
  describeInputValue,
  hasOwnKey,
  requireCurrencyCode,
  requireEpochMsField,
  requireFiniteNumberField,
  requireIdentityString,
  requireProvenanceShape,
} from '../internal.js';
import type { CurrencyPairQuote } from '../internal.js';
import { requirePolicyLimits } from '../policy-grammar.js';
import {
  AUTHORIZATION_GRANT_KIND,
  AUTHORIZATION_GRANT_SCHEMA_VERSION,
  EXECUTION_JOURNAL_EVENT_TYPES,
  EXECUTION_PLAN_KIND,
  EXECUTION_PLAN_SCHEMA_VERSION,
  PREFLIGHT_REPORT_KIND,
  PREFLIGHT_REPORT_SCHEMA_VERSION,
  TRADE_INTENT_KIND,
  TRADE_INTENT_SCHEMA_VERSION,
  type AuthorizationGrant,
  type ExecutionJournalEvent,
  type ExecutionJournalState,
  type ExecutionOrderState,
  type ExecutionPlan,
  type GrantVariance,
  type PolicyCheck,
  type PreflightCostRates,
  type PreflightInstrument,
  type PreflightReport,
  type TradeIntent,
  type TradeOrder,
  type TradePolicy,
} from './types.js';

/** The most orders one plan may carry (Decision 11). */
export const TRADE_PLAN_ORDER_CEILING = 1_000;

// B6: the order vocabulary is core's — one list of types and of time-in-force values everywhere.
const ORDER_KEYS = [
  'orderId',
  'instrumentId',
  'side',
  'quantity',
  'type',
  'limitPrice',
  'stopPrice',
  'timeInForce',
  'plannedTimestampMs',
  'submittedTimestampMs',
  'comboId',
] as const;
const INTENT_ORDER_KEYS = [
  'instrumentId',
  'side',
  'quantity',
  'notionalWeight',
  'type',
  'limitPrice',
  'stopPrice',
  'timeInForce',
  'comboId',
] as const;
const INTENT_COMBO_KEYS = ['comboId', 'netLimitPrice'] as const;
const PLAN_COMBO_KEYS = ['comboId', 'orderIds', 'netLimitPrice'] as const;
const INTENT_KEYS = [
  'kind',
  'schemaVersion',
  'accountId',
  'asOf',
  'orders',
  'combos',
  'rationale',
  'evidence',
] as const;
const PLAN_KEYS = [
  'kind',
  'schemaVersion',
  'accountId',
  'asOf',
  'baseCurrency',
  'portfolioId',
  'orders',
  'combos',
  'trades',
  'source',
  'rationale',
  'evidence',
  'contentHash',
] as const;
const POLICY_KEYS = [
  'mode',
  'limits',
  'allowedAccounts',
  'allowedAssetClasses',
  'allowedInstruments',
  'allowedOrderTypes',
  'maximumOrderQuantity',
  'maximumOrderNotional',
  'maximumEstimatedCost',
  'maximumSlippageBps',
  'maximumParticipation',
  'allowUndefinedRiskOptions',
  'marketMaximumAgeMs',
  'maximumTurnover',
  'requireApprovalAbove',
  'onUnverifiable',
] as const;
const INSTRUMENT_KEYS = ['currency', 'contractMultiplier', 'contract', 'assetClass'] as const;
const COST_KEYS = ['commissionBps', 'commissionPerOrder', 'spreadBps', 'slippageBps'] as const;

export function refuse(
  functionName: string,
  field: string,
  message: string,
  code: string = ErrorCode.InputOutOfRange,
): never {
  throw new InputError(`${functionName}: ${field} ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

function present(record: object, key: string): boolean {
  return hasOwnKey(record, key) && (record as Record<string, unknown>)[key] !== undefined;
}

function enumField<T extends string>(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (!(allowed as readonly unknown[]).includes(value))
    refuse(
      functionName,
      field,
      `must be one of ${allowed.map((v) => `'${v}'`).join(', ')}. Received ${describeInputValue(value)}.`,
      ErrorCode.InputInvalidEnum,
    );
  return value as T;
}

function positiveNumber(functionName: string, field: string, value: unknown): number {
  requireFiniteNumberField(functionName, field, value);
  if (!(value > 0)) refuse(functionName, field, `must be > 0. Received ${value}.`);
  return value;
}

function stringList(functionName: string, field: string, value: unknown): string[] {
  if (!Array.isArray(value))
    refuse(
      functionName,
      field,
      `must be an array of strings. Received ${describeInputValue(value)}.`,
      ErrorCode.InputWrongType,
    );
  value.forEach((row, i) => requireIdentityString(functionName, `${field}[${i}]`, row));
  return value as string[];
}

function priceFields(
  functionName: string,
  label: string,
  order: Record<string, unknown>,
  type: string,
): void {
  const needsLimit = type === 'limit' || type === 'stop-limit';
  const needsStop = type === 'stop' || type === 'stop-limit';
  for (const [field, needed] of [
    ['limitPrice', needsLimit],
    ['stopPrice', needsStop],
  ] as const) {
    if (present(order, field)) {
      positiveNumber(functionName, `${label}.${field}`, order[field]);
      if (!needed)
        refuse(
          functionName,
          `${label}.${field}`,
          `is given but a '${type}' order does not use it — omit it, or choose the order type that does.`,
        );
    } else if (needed) {
      refuse(
        functionName,
        `${label}.${field}`,
        `is required for a '${type}' order.`,
        ErrorCode.InputMissingField,
      );
    }
  }
  if (present(order, 'timeInForce'))
    enumField(functionName, `${label}.timeInForce`, order['timeInForce'], TIME_IN_FORCE_VALUES);
}

/** One executable order in the frozen execution grammar. */
export function requireTradeOrder(functionName: string, label: string, value: unknown): TradeOrder {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, ORDER_KEYS);
  const order = value as Record<string, unknown>;
  requireIdentityString(functionName, `${label}.orderId`, order['orderId']);
  requireIdentityString(functionName, `${label}.instrumentId`, order['instrumentId']);
  enumField(functionName, `${label}.side`, order['side'], ['buy', 'sell'] as const);
  positiveNumber(functionName, `${label}.quantity`, order['quantity']);
  const type = enumField(functionName, `${label}.type`, order['type'], ORDER_TYPES);
  priceFields(functionName, label, order, type);
  requireEpochMsField(functionName, `${label}.plannedTimestampMs`, order['plannedTimestampMs']);
  if (present(order, 'submittedTimestampMs'))
    requireEpochMsField(
      functionName,
      `${label}.submittedTimestampMs`,
      order['submittedTimestampMs'],
    );
  if (present(order, 'comboId'))
    requireIdentityString(functionName, `${label}.comboId`, order['comboId']);
  return value as TradeOrder;
}

/** A trade intent: closed, without a credential, a quantity or a notional weight per line. */
export function requireTradeIntent(
  functionName: string,
  label: string,
  value: unknown,
): TradeIntent {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, INTENT_KEYS);
  const intent = value as Record<string, unknown>;
  if (intent['kind'] !== TRADE_INTENT_KIND)
    refuse(
      functionName,
      `${label}.kind`,
      `must be '${TRADE_INTENT_KIND}'. Received ${describeInputValue(intent['kind'])}.`,
      ErrorCode.InputInvalidEnum,
    );
  if (intent['schemaVersion'] !== TRADE_INTENT_SCHEMA_VERSION)
    refuse(
      functionName,
      `${label}.schemaVersion`,
      `must be ${TRADE_INTENT_SCHEMA_VERSION}. Received ${describeInputValue(intent['schemaVersion'])}.`,
    );
  requireIdentityString(functionName, `${label}.accountId`, intent['accountId']);
  requireEpochMsField(functionName, `${label}.asOf`, intent['asOf']);
  if (!Array.isArray(intent['orders']) || intent['orders'].length === 0)
    refuse(
      functionName,
      `${label}.orders`,
      'must hold at least one order.',
      ErrorCode.InputWrongType,
    );
  if (intent['orders'].length > TRADE_PLAN_ORDER_CEILING)
    refuse(
      functionName,
      `${label}.orders`,
      `holds ${intent['orders'].length} orders, above the ${TRADE_PLAN_ORDER_CEILING} one plan may carry.`,
      ErrorCode.BacktestInputTooLarge,
    );
  const comboLegs = new Map<string, number>();
  (intent['orders'] as unknown[]).forEach((row, i) => {
    const at = `${label}.orders[${i}]`;
    requireArgumentObject(functionName, at, row);
    ensureKnownKeys(functionName, at, row as object, INTENT_ORDER_KEYS);
    const order = row as Record<string, unknown>;
    requireIdentityString(functionName, `${at}.instrumentId`, order['instrumentId']);
    enumField(functionName, `${at}.side`, order['side'], ['buy', 'sell'] as const);
    const hasQuantity = present(order, 'quantity');
    const hasWeight = present(order, 'notionalWeight');
    if (hasQuantity === hasWeight)
      refuse(
        functionName,
        at,
        'must carry exactly one of quantity or notionalWeight.',
        hasQuantity ? ErrorCode.InputUnknownField : ErrorCode.InputMissingField,
      );
    if (hasQuantity) positiveNumber(functionName, `${at}.quantity`, order['quantity']);
    if (hasWeight) {
      const weight = positiveNumber(functionName, `${at}.notionalWeight`, order['notionalWeight']);
      if (weight > 1)
        refuse(
          functionName,
          `${at}.notionalWeight`,
          `is a fraction of NAV, at most 1. Received ${weight}.`,
        );
    }
    const type = enumField(functionName, `${at}.type`, order['type'], ORDER_TYPES);
    priceFields(functionName, at, order, type);
    if (present(order, 'comboId')) {
      requireIdentityString(functionName, `${at}.comboId`, order['comboId']);
      const comboId = order['comboId'] as string;
      comboLegs.set(comboId, (comboLegs.get(comboId) ?? 0) + 1);
    }
  });
  for (const [comboId, legs] of comboLegs)
    if (legs < 2)
      refuse(
        functionName,
        `${label}.orders`,
        `combo '${comboId}' has one leg; a combo is at least two orders — add its other leg or drop the comboId.`,
        ErrorCode.TradePlanInvalid,
      );
  if (present(intent, 'combos')) {
    if (!Array.isArray(intent['combos']))
      refuse(
        functionName,
        `${label}.combos`,
        'must be an array of combo terms ({ comboId, netLimitPrice? }).',
        ErrorCode.InputWrongType,
      );
    const seen = new Set<string>();
    (intent['combos'] as unknown[]).forEach((row, i) => {
      const at = `${label}.combos[${i}]`;
      requireArgumentObject(functionName, at, row);
      ensureKnownKeys(functionName, at, row as object, INTENT_COMBO_KEYS);
      const combo = row as Record<string, unknown>;
      requireIdentityString(functionName, `${at}.comboId`, combo['comboId']);
      const comboId = combo['comboId'] as string;
      if (seen.has(comboId))
        refuse(functionName, `${at}.comboId`, `repeats '${comboId}' — one entry per combo.`);
      seen.add(comboId);
      if (!comboLegs.has(comboId))
        refuse(
          functionName,
          `${at}.comboId`,
          `'${comboId}' names no order — give at least two lines this comboId.`,
          ErrorCode.TradePlanInvalid,
        );
      if (present(combo, 'netLimitPrice'))
        requireFiniteNumberField(functionName, `${at}.netLimitPrice`, combo['netLimitPrice']);
    });
  }
  if (present(intent, 'rationale') && typeof intent['rationale'] !== 'string')
    refuse(functionName, `${label}.rationale`, 'must be a string.', ErrorCode.InputWrongType);
  if (present(intent, 'evidence'))
    stringList(functionName, `${label}.evidence`, intent['evidence']);
  return value as TradeIntent;
}

/** An execution plan: the closed artifact every later stage binds to; its content hash must match its body. */
export function requireExecutionPlan(
  functionName: string,
  label: string,
  value: unknown,
): ExecutionPlan {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, PLAN_KEYS);
  const plan = value as Record<string, unknown>;
  if (plan['kind'] !== EXECUTION_PLAN_KIND)
    refuse(
      functionName,
      `${label}.kind`,
      `must be '${EXECUTION_PLAN_KIND}'. Received ${describeInputValue(plan['kind'])}.`,
      ErrorCode.InputInvalidEnum,
    );
  if (plan['schemaVersion'] !== EXECUTION_PLAN_SCHEMA_VERSION)
    refuse(
      functionName,
      `${label}.schemaVersion`,
      `must be ${EXECUTION_PLAN_SCHEMA_VERSION}. Received ${describeInputValue(plan['schemaVersion'])}.`,
    );
  requireIdentityString(functionName, `${label}.accountId`, plan['accountId']);
  requireEpochMsField(functionName, `${label}.asOf`, plan['asOf']);
  requireCurrencyCode(functionName, `${label}.baseCurrency`, plan['baseCurrency']);
  if (present(plan, 'portfolioId'))
    requireIdentityString(functionName, `${label}.portfolioId`, plan['portfolioId']);
  if (!Array.isArray(plan['orders']) || plan['orders'].length === 0)
    refuse(
      functionName,
      `${label}.orders`,
      'must hold at least one order.',
      ErrorCode.InputWrongType,
    );
  if (plan['orders'].length > TRADE_PLAN_ORDER_CEILING)
    refuse(
      functionName,
      `${label}.orders`,
      `holds ${plan['orders'].length} orders, above the ${TRADE_PLAN_ORDER_CEILING} one plan may carry.`,
      ErrorCode.BacktestInputTooLarge,
    );
  const ids = new Set<string>();
  const orderById = new Map<string, TradeOrder>();
  (plan['orders'] as unknown[]).forEach((row, i) => {
    const order = requireTradeOrder(functionName, `${label}.orders[${i}]`, row);
    if (ids.has(order.orderId))
      refuse(
        functionName,
        `${label}.orders[${i}].orderId`,
        `repeats '${order.orderId}' — order ids are unique within a plan.`,
      );
    if (present(row as object, 'submittedTimestampMs'))
      refuse(
        functionName,
        `${label}.orders[${i}].submittedTimestampMs`,
        'is stamped by the broker at submission; a plan carries plannedTimestampMs only.',
        ErrorCode.InputUnknownField,
      );
    ids.add(order.orderId);
    orderById.set(order.orderId, order);
  });
  // B5: every multi-leg order is listed once, with at least two legs that carry its id.
  if (!Array.isArray(plan['combos']))
    refuse(
      functionName,
      `${label}.combos`,
      "must be the plan's combos — an empty array when every order stands alone.",
      ErrorCode.InputWrongType,
    );
  const comboOfOrder = new Map<string, string>();
  const comboIds = new Set<string>();
  (plan['combos'] as unknown[]).forEach((row, i) => {
    const at = `${label}.combos[${i}]`;
    requireArgumentObject(functionName, at, row);
    ensureKnownKeys(functionName, at, row as object, PLAN_COMBO_KEYS);
    const combo = row as Record<string, unknown>;
    requireIdentityString(functionName, `${at}.comboId`, combo['comboId']);
    const comboId = combo['comboId'] as string;
    if (comboIds.has(comboId)) refuse(functionName, `${at}.comboId`, `repeats '${comboId}'.`);
    comboIds.add(comboId);
    const legs = stringList(functionName, `${at}.orderIds`, combo['orderIds']);
    if (legs.length < 2)
      refuse(
        functionName,
        `${at}.orderIds`,
        `names ${legs.length} leg${legs.length === 1 ? '' : 's'}; a combo is at least two orders.`,
        ErrorCode.TradePlanInvalid,
      );
    legs.forEach((orderId, j) => {
      const order = orderById.get(orderId);
      if (order === undefined)
        refuse(
          functionName,
          `${at}.orderIds[${j}]`,
          `'${orderId}' is not an order of this plan.`,
          ErrorCode.TradePlanInvalid,
        );
      if (order.comboId !== comboId)
        refuse(
          functionName,
          `${at}.orderIds[${j}]`,
          `'${orderId}' carries comboId ${JSON.stringify(order.comboId)}, not '${comboId}'.`,
          ErrorCode.TradePlanInvalid,
        );
      if (comboOfOrder.has(orderId))
        refuse(
          functionName,
          `${at}.orderIds[${j}]`,
          `'${orderId}' is a leg of two combos.`,
          ErrorCode.TradePlanInvalid,
        );
      comboOfOrder.set(orderId, comboId);
    });
    if (present(combo, 'netLimitPrice'))
      requireFiniteNumberField(functionName, `${at}.netLimitPrice`, combo['netLimitPrice']);
  });
  for (const order of orderById.values())
    if (order.comboId !== undefined && !comboOfOrder.has(order.orderId))
      refuse(
        functionName,
        `${label}.combos`,
        `order '${order.orderId}' carries comboId '${order.comboId}' but no combo lists it.`,
        ErrorCode.TradePlanInvalid,
      );
  if (!Array.isArray(plan['trades']))
    refuse(
      functionName,
      `${label}.trades`,
      "must be the plan's trade rows.",
      ErrorCode.InputWrongType,
    );
  requireArgumentObject(functionName, `${label}.source`, plan['source']);
  const source = plan['source'] as Record<string, unknown>;
  const kind = enumField(functionName, `${label}.source.kind`, source['kind'], [
    'intent',
    'rebalance-proposal',
  ] as const);
  if (kind === 'intent') {
    ensureKnownKeys(functionName, `${label}.source`, source, ['kind', 'intentHash']);
    requireIdentityString(functionName, `${label}.source.intentHash`, source['intentHash']);
  } else {
    ensureKnownKeys(functionName, `${label}.source`, source, [
      'kind',
      'planHash',
      'policyContentHash',
    ]);
    requireIdentityString(functionName, `${label}.source.planHash`, source['planHash']);
    requireIdentityString(
      functionName,
      `${label}.source.policyContentHash`,
      source['policyContentHash'],
    );
  }
  if (present(plan, 'rationale') && typeof plan['rationale'] !== 'string')
    refuse(functionName, `${label}.rationale`, 'must be a string.', ErrorCode.InputWrongType);
  stringList(functionName, `${label}.evidence`, plan['evidence']);
  requireIdentityString(functionName, `${label}.contentHash`, plan['contentHash']);
  const { contentHash: declared, ...body } = plan;
  const actual = contentHash(body);
  if (declared !== actual)
    refuse(
      functionName,
      `${label}.contentHash`,
      `does not match the plan's body (${actual}) — a plan is bound by its content; rebuild it rather than editing it.`,
      ErrorCode.InputWrongShape,
    );
  return value as ExecutionPlan;
}

/** The structured trade policy: closed, deterministic, paper-only in this stage. */
export function requireTradePolicy(
  functionName: string,
  label: string,
  value: unknown,
): TradePolicy {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, POLICY_KEYS);
  const policy = value as Record<string, unknown>;
  if (policy['mode'] === 'live')
    refuse(
      functionName,
      `${label}.mode`,
      "'live' is not available — live adapters ship under their own authorization (AT8); this stage executes on paper only.",
      ErrorCode.TradeLiveUnavailable,
    );
  enumField(functionName, `${label}.mode`, policy['mode'], ['paper'] as const);
  if (present(policy, 'limits'))
    requirePolicyLimits(functionName, `${label}.limits`, policy['limits']);
  for (const key of ['allowedAccounts', 'allowedAssetClasses', 'allowedInstruments'] as const)
    if (present(policy, key)) stringList(functionName, `${label}.${key}`, policy[key]);
  if (present(policy, 'allowedOrderTypes')) {
    const rows = stringList(
      functionName,
      `${label}.allowedOrderTypes`,
      policy['allowedOrderTypes'],
    );
    rows.forEach((row, i) =>
      enumField(functionName, `${label}.allowedOrderTypes[${i}]`, row, ORDER_TYPES),
    );
  }
  for (const key of [
    'maximumOrderQuantity',
    'maximumOrderNotional',
    'maximumEstimatedCost',
    'maximumSlippageBps',
    'maximumParticipation',
    'marketMaximumAgeMs',
    'maximumTurnover',
  ] as const)
    if (present(policy, key)) positiveNumber(functionName, `${label}.${key}`, policy[key]);
  if (present(policy, 'maximumParticipation') && (policy['maximumParticipation'] as number) > 1)
    refuse(functionName, `${label}.maximumParticipation`, 'is a fraction of volume, at most 1.');
  if (
    present(policy, 'allowUndefinedRiskOptions') &&
    typeof policy['allowUndefinedRiskOptions'] !== 'boolean'
  )
    refuse(
      functionName,
      `${label}.allowUndefinedRiskOptions`,
      'must be a boolean.',
      ErrorCode.InputWrongType,
    );
  if (present(policy, 'requireApprovalAbove')) {
    requireArgumentObject(
      functionName,
      `${label}.requireApprovalAbove`,
      policy['requireApprovalAbove'],
    );
    ensureKnownKeys(
      functionName,
      `${label}.requireApprovalAbove`,
      policy['requireApprovalAbove'] as object,
      ['notional', 'quantity'],
    );
    const above = policy['requireApprovalAbove'] as Record<string, unknown>;
    for (const key of ['notional', 'quantity'] as const)
      if (present(above, key))
        positiveNumber(functionName, `${label}.requireApprovalAbove.${key}`, above[key]);
  }
  if (present(policy, 'onUnverifiable'))
    enumField(functionName, `${label}.onUnverifiable`, policy['onUnverifiable'], [
      'require-approval',
      'deny',
    ] as const);
  return value as TradePolicy;
}

/** An instrument description preflight and the broker read for an instrument the ledger may not hold. */
export function requirePreflightInstrument(
  functionName: string,
  label: string,
  value: unknown,
): PreflightInstrument {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, INSTRUMENT_KEYS);
  const spec = value as Record<string, unknown>;
  requireCurrencyCode(functionName, `${label}.currency`, spec['currency']);
  if (present(spec, 'contractMultiplier'))
    positiveNumber(functionName, `${label}.contractMultiplier`, spec['contractMultiplier']);
  if (present(spec, 'contract'))
    requireArgumentObject(functionName, `${label}.contract`, spec['contract']);
  if (present(spec, 'assetClass'))
    requireIdentityString(functionName, `${label}.assetClass`, spec['assetClass']);
  return value as PreflightInstrument;
}

export function requirePreflightCostRates(
  functionName: string,
  label: string,
  value: unknown,
): PreflightCostRates {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, COST_KEYS);
  const rates = value as Record<string, unknown>;
  for (const key of COST_KEYS) {
    if (!present(rates, key)) continue;
    requireFiniteNumberField(functionName, `${label}.${key}`, rates[key]);
    if ((rates[key] as number) < 0)
      refuse(functionName, `${label}.${key}`, `must be >= 0. Received ${rates[key] as number}.`);
  }
  return value as PreflightCostRates;
}

const POLICY_CHECK_KEYS = ['name', 'verdict', 'value', 'limit', 'detail'] as const;
const POLICY_CHECK_VERDICTS = ['pass', 'fail', 'unverifiable', 'require-approval'] as const;

/** A policy check row: the closed shape `decideFromChecks` judges. */
export function requirePolicyCheck(
  functionName: string,
  label: string,
  value: unknown,
): PolicyCheck {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, POLICY_CHECK_KEYS);
  const record = value as Record<string, unknown>;
  requireIdentityString(functionName, `${label}.name`, record['name']);
  enumField(functionName, `${label}.verdict`, record['verdict'], POLICY_CHECK_VERDICTS);
  if (typeof record['detail'] !== 'string')
    refuse(functionName, `${label}.detail`, 'must be a string', ErrorCode.InputWrongType);
  for (const key of ['value', 'limit'] as const) {
    if (!present(record, key))
      refuse(
        functionName,
        `${label}.${key}`,
        'is required (null when there is none)',
        ErrorCode.InputMissingField,
      );
    if (typeof record[key] === 'number' && !Number.isFinite(record[key] as number))
      refuse(
        functionName,
        `${label}.${key}`,
        `must be finite. Received ${String(record[key])}`,
        ErrorCode.InputNotFinite,
      );
  }
  return value as PolicyCheck;
}

/** `currencyConversions`, when present, is an array of pair quotes; the snapshot validates each. */
export function conversionsField(functionName: string, value: unknown): CurrencyPairQuote[] {
  if (!Array.isArray(value))
    refuse(
      functionName,
      'input.currencyConversions',
      'must be an array of currency pair quotes',
      ErrorCode.InputWrongType,
    );
  value.forEach((quote, index) =>
    requireArgumentObject(functionName, `input.currencyConversions[${index}]`, quote),
  );
  return value as CurrencyPairQuote[];
}

// ---------------------------------------------------------------------------------------------------
// Slice 2 — the grant, the journal, the report (Decisions 5, 6, 8)
// ---------------------------------------------------------------------------------------------------

const VARIANCE_KEYS = [
  'maximumQuantityRatio',
  'maximumNotionalRatio',
  'maximumSlippageBps',
] as const;

export function requireGrantVariance(
  functionName: string,
  field: string,
  value: unknown,
): GrantVariance {
  requireArgumentObject(functionName, field, value);
  ensureKnownKeys(functionName, field, value as object, VARIANCE_KEYS);
  const record = value as Record<string, unknown>;
  for (const key of VARIANCE_KEYS) {
    requireFiniteNumberField(functionName, `${field}.${key}`, record[key]);
    if ((record[key] as number) < 0) refuse(functionName, `${field}.${key}`, 'must be ≥ 0');
  }
  return {
    maximumQuantityRatio: record['maximumQuantityRatio'] as number,
    maximumNotionalRatio: record['maximumNotionalRatio'] as number,
    maximumSlippageBps: record['maximumSlippageBps'] as number,
  };
}

const PREFLIGHT_REPORT_KEYS = [
  'kind',
  'schemaVersion',
  'asOf',
  'planHash',
  'portfolioHash',
  'marketHash',
  'marketAsOf',
  'before',
  'after',
  'hypotheticalFills',
  'hypotheticalEvents',
  'estimates',
  'checks',
  'alerts',
  'decision',
  'unverifiable',
  'monitorState',
  'assumptions',
  'diagnostics',
  'contentHash',
] as const;

/** A preflight report: closed, its kind and version, its content hash re-verified over the body. */
export function requirePreflightReport(
  functionName: string,
  label: string,
  value: unknown,
): PreflightReport {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, PREFLIGHT_REPORT_KEYS);
  const record = value as Record<string, unknown>;
  if (record['kind'] !== PREFLIGHT_REPORT_KIND)
    refuse(
      functionName,
      `${label}.kind`,
      `must be '${PREFLIGHT_REPORT_KIND}'. Received ${describeInputValue(record['kind'])}.`,
      ErrorCode.InputWrongShape,
    );
  if (record['schemaVersion'] !== PREFLIGHT_REPORT_SCHEMA_VERSION)
    refuse(
      functionName,
      `${label}.schemaVersion`,
      `must be ${PREFLIGHT_REPORT_SCHEMA_VERSION}. Received ${describeInputValue(record['schemaVersion'])}.`,
      ErrorCode.InputWrongShape,
    );
  for (const key of ['planHash', 'portfolioHash', 'marketHash', 'contentHash'] as const)
    requireIdentityString(functionName, `${label}.${key}`, record[key]);
  requireEpochMsField(functionName, `${label}.asOf`, record['asOf']);
  requireEpochMsField(functionName, `${label}.marketAsOf`, record['marketAsOf']);
  if (!Array.isArray(record['checks']))
    refuse(
      functionName,
      `${label}.checks`,
      'must be an array of policy checks',
      ErrorCode.InputWrongType,
    );
  (record['checks'] as unknown[]).forEach((check, index) =>
    requirePolicyCheck(functionName, `${label}.checks[${index}]`, check),
  );
  requireArgumentObject(functionName, `${label}.decision`, record['decision']);
  enumField(
    functionName,
    `${label}.decision.verdict`,
    (record['decision'] as Record<string, unknown>)['verdict'],
    ['allow', 'deny', 'require-approval'] as const,
  );
  requireArgumentObject(functionName, `${label}.assumptions`, record['assumptions']);
  enumField(
    functionName,
    `${label}.assumptions.mode`,
    (record['assumptions'] as Record<string, unknown>)['mode'],
    ['paper'] as const,
  );
  verifyContentHash(functionName, label, record);
  return value as PreflightReport;
}

const GRANT_KEYS = [
  'kind',
  'schemaVersion',
  'grantId',
  'planHash',
  'preflightHash',
  'portfolioHash',
  'marketHash',
  'marketAsOf',
  'marketMaximumAgeMs',
  'mode',
  'accountId',
  'baseCurrency',
  'orderIds',
  'comboIds',
  'variance',
  'issuedAt',
  'expiresAt',
  'approvedBy',
  'requiredScope',
  'idempotencyKeys',
  'contentHash',
] as const;

/** An authorization grant: closed, its kind and version, every binding typed, the hash re-verified. */
export function requireAuthorizationGrant(
  functionName: string,
  label: string,
  value: unknown,
): AuthorizationGrant {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, GRANT_KEYS);
  const record = value as Record<string, unknown>;
  if (record['kind'] !== AUTHORIZATION_GRANT_KIND)
    refuse(
      functionName,
      `${label}.kind`,
      `must be '${AUTHORIZATION_GRANT_KIND}'. Received ${describeInputValue(record['kind'])}.`,
      ErrorCode.InputWrongShape,
    );
  if (record['schemaVersion'] !== AUTHORIZATION_GRANT_SCHEMA_VERSION)
    refuse(
      functionName,
      `${label}.schemaVersion`,
      `must be ${AUTHORIZATION_GRANT_SCHEMA_VERSION}. Received ${describeInputValue(record['schemaVersion'])}.`,
      ErrorCode.InputWrongShape,
    );
  for (const key of [
    'grantId',
    'planHash',
    'preflightHash',
    'portfolioHash',
    'marketHash',
    'accountId',
    'approvedBy',
    'contentHash',
  ] as const)
    requireIdentityString(functionName, `${label}.${key}`, record[key]);
  requireCurrencyCode(functionName, `${label}.baseCurrency`, record['baseCurrency']);
  requireEpochMsField(functionName, `${label}.marketAsOf`, record['marketAsOf']);
  requireEpochMsField(functionName, `${label}.issuedAt`, record['issuedAt']);
  requireEpochMsField(functionName, `${label}.expiresAt`, record['expiresAt']);
  positiveNumber(functionName, `${label}.marketMaximumAgeMs`, record['marketMaximumAgeMs']);
  enumField(functionName, `${label}.mode`, record['mode'], ['paper'] as const);
  stringList(functionName, `${label}.orderIds`, record['orderIds']);
  stringList(functionName, `${label}.comboIds`, record['comboIds']);
  const keys = stringList(functionName, `${label}.idempotencyKeys`, record['idempotencyKeys']);
  if (keys.length === 0)
    refuse(functionName, `${label}.idempotencyKeys`, 'must name at least one key');
  if (record['requiredScope'] !== null)
    requireIdentityString(functionName, `${label}.requiredScope`, record['requiredScope']);
  requireGrantVariance(functionName, `${label}.variance`, record['variance']);
  verifyContentHash(functionName, label, record);
  return value as AuthorizationGrant;
}

const JOURNAL_EVENT_KEYS = [
  'eventId',
  'journalId',
  'timestampMs',
  'orderId',
  'planHash',
  'idempotencyKey',
  'eventType',
  'detail',
  'sourceId',
  'provenance',
] as const;
const JOURNAL_DETAIL_KEYS = [
  'quantity',
  'fillId',
  'pricePerUnit',
  'reason',
  'replacementOrderId',
  'artifactHash',
  'note',
  'order',
  'instrument',
  'accountId',
  'baseCurrency',
  'executionPolicyHash',
  'observationTimestampMs',
  'fill',
  'comboId',
  'netLimitPrice',
] as const;

/** A journal event: closed, typed, its detail record closed; the fold judges the sequence. */
export function requireExecutionJournalEvent(
  functionName: string,
  label: string,
  value: unknown,
): ExecutionJournalEvent {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, JOURNAL_EVENT_KEYS);
  const record = value as Record<string, unknown>;
  for (const key of ['eventId', 'journalId', 'orderId', 'planHash', 'sourceId'] as const)
    requireIdentityString(functionName, `${label}.${key}`, record[key]);
  if (present(record, 'idempotencyKey'))
    requireIdentityString(functionName, `${label}.idempotencyKey`, record['idempotencyKey']);
  requireEpochMsField(functionName, `${label}.timestampMs`, record['timestampMs']);
  enumField(functionName, `${label}.eventType`, record['eventType'], EXECUTION_JOURNAL_EVENT_TYPES);
  requireArgumentObject(functionName, `${label}.detail`, record['detail']);
  ensureKnownKeys(functionName, `${label}.detail`, record['detail'] as object, JOURNAL_DETAIL_KEYS);
  const detail = record['detail'] as Record<string, unknown>;
  for (const key of ['quantity', 'pricePerUnit'] as const)
    if (present(detail, key))
      requireFiniteNumberField(functionName, `${label}.detail.${key}`, detail[key]);
  for (const key of ['fillId', 'reason', 'replacementOrderId', 'artifactHash', 'note'] as const)
    if (present(detail, key) && typeof detail[key] !== 'string')
      refuse(functionName, `${label}.detail.${key}`, 'must be a string', ErrorCode.InputWrongType);
  for (const key of ['accountId', 'executionPolicyHash', 'comboId'] as const)
    if (present(detail, key))
      requireIdentityString(functionName, `${label}.detail.${key}`, detail[key]);
  if (present(detail, 'netLimitPrice'))
    requireFiniteNumberField(
      functionName,
      `${label}.detail.netLimitPrice`,
      detail['netLimitPrice'],
    );
  if (present(detail, 'baseCurrency'))
    requireCurrencyCode(functionName, `${label}.detail.baseCurrency`, detail['baseCurrency']);
  if (present(detail, 'order')) {
    const order = requireTradeOrder(functionName, `${label}.detail.order`, detail['order']);
    if (
      record['eventType'] !== 'submitted' ||
      order.orderId !== record['orderId'] ||
      order.quantity !== detail['quantity']
    )
      refuse(
        functionName,
        `${label}.detail.order`,
        'must match the submitted event order and quantity',
        ErrorCode.InputWrongShape,
      );
  }
  if (present(detail, 'observationTimestampMs'))
    requireEpochMsField(
      functionName,
      `${label}.detail.observationTimestampMs`,
      detail['observationTimestampMs'],
    );
  if (present(detail, 'fill')) {
    const fill = detail['fill'];
    requireNormalizedFill(functionName, `${label}.detail.fill`, fill);
    if (
      !['filled', 'partially-filled'].includes(record['eventType'] as string) ||
      fill.orderId !== record['orderId'] ||
      fill.fillId !== detail['fillId'] ||
      fill.quantity !== detail['quantity'] ||
      fill.pricePerUnit !== detail['pricePerUnit'] ||
      fill.filledTimestampMs !== record['timestampMs']
    )
      refuse(
        functionName,
        `${label}.detail.fill`,
        'must match the fill event identity, quantity, price and timestamp',
        ErrorCode.InputWrongShape,
      );
  }
  if (
    present(detail, 'observationTimestampMs') &&
    (!['filled', 'partially-filled'].includes(record['eventType'] as string) ||
      (detail['observationTimestampMs'] as number) > (record['timestampMs'] as number))
  )
    refuse(
      functionName,
      `${label}.detail.observationTimestampMs`,
      'must be on a fill event and no later than its timestamp',
      ErrorCode.InputOutOfRange,
    );
  for (const key of [
    'instrument',
    'accountId',
    'baseCurrency',
    'executionPolicyHash',
    'comboId',
    'netLimitPrice',
  ] as const)
    if (present(detail, key) && record['eventType'] !== 'submitted')
      refuse(
        functionName,
        `${label}.detail.${key}`,
        'belongs only on submitted events',
        ErrorCode.InputWrongShape,
      );
  if (present(detail, 'instrument')) {
    const path = `${label}.detail.instrument`;
    requireArgumentObject(functionName, path, detail['instrument']);
    const instrument = detail['instrument'] as Record<string, unknown>;
    ensureKnownKeys(functionName, path, instrument, [
      'currency',
      'contractMultiplier',
      'settlementStyle',
      'contract',
      'settlementLag',
    ]);
    requireCurrencyCode(functionName, `${path}.currency`, instrument['currency']);
    if (present(instrument, 'contractMultiplier'))
      positiveNumber(functionName, `${path}.contractMultiplier`, instrument['contractMultiplier']);
    if (present(instrument, 'settlementStyle'))
      enumField(functionName, `${path}.settlementStyle`, instrument['settlementStyle'], [
        'cash-on-trade',
        'variation-margin',
      ]);
    if (
      present(instrument, 'settlementLag') &&
      ![0, 1, 2].includes(instrument['settlementLag'] as number)
    )
      refuse(
        functionName,
        `${path}.settlementLag`,
        'must be 0, 1, or 2',
        ErrorCode.InputOutOfRange,
      );
    if (present(instrument, 'contract')) {
      requireArgumentObject(functionName, `${path}.contract`, instrument['contract']);
      const contract = instrument['contract'] as Record<string, unknown>;
      const kind = enumField(functionName, `${path}.contract.kind`, contract['kind'], [
        'option',
        'future',
        'perpetual',
      ]);
      ensureKnownKeys(functionName, `${path}.contract`, contract, [
        'kind',
        'underlyingInstrumentId',
        ...(kind === 'perpetual' ? [] : ['expiryTimestampMs']),
        ...(kind === 'option' ? ['type', 'strikePricePerUnit'] : []),
      ]);
      requireIdentityString(
        functionName,
        `${path}.contract.underlyingInstrumentId`,
        contract['underlyingInstrumentId'],
      );
      positiveNumber(functionName, `${path}.contractMultiplier`, instrument['contractMultiplier']);
      if (kind !== 'perpetual')
        requireEpochMsField(
          functionName,
          `${path}.contract.expiryTimestampMs`,
          contract['expiryTimestampMs'],
        );
      if (kind === 'option') {
        enumField(functionName, `${path}.contract.type`, contract['type'], ['call', 'put']);
        requireFiniteNumberField(
          functionName,
          `${path}.contract.strikePricePerUnit`,
          contract['strikePricePerUnit'],
        );
      }
    }
  }
  requireProvenanceShape(functionName, `${label}.provenance`, record['provenance']);
  return value as ExecutionJournalEvent;
}

const JOURNAL_STATE_KEYS = [
  'journalId',
  'eventCount',
  'eventIds',
  'orders',
  'preSubmission',
  'duplicateEventIds',
] as const;
const ORDER_STATE_KEYS = [
  'orderId',
  'planHash',
  'state',
  'submittedQuantity',
  'filledQuantity',
  'remainingQuantity',
  'averageFillPrice',
  'fillIds',
  'lateFillIds',
  'lastEventId',
  'lastTimestampMs',
  'terminal',
  'cancelRequested',
  'reason',
  'replacedBy',
  'reconciledEventId',
] as const;
const ORDER_STATES = [
  'submitted',
  'acknowledged',
  'partially-filled',
  'filled',
  'cancelled',
  'rejected',
  'expired',
  'unresolved',
] as const;

export function requireExecutionOrderState(
  functionName: string,
  label: string,
  value: unknown,
): ExecutionOrderState {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, ORDER_STATE_KEYS);
  const record = value as Record<string, unknown>;
  for (const key of ['orderId', 'planHash', 'lastEventId'] as const)
    requireIdentityString(functionName, `${label}.${key}`, record[key]);
  enumField(functionName, `${label}.state`, record['state'], ORDER_STATES);
  positiveNumber(functionName, `${label}.submittedQuantity`, record['submittedQuantity']);
  for (const key of ['filledQuantity', 'remainingQuantity'] as const) {
    requireFiniteNumberField(functionName, `${label}.${key}`, record[key]);
    if ((record[key] as number) < 0) refuse(functionName, `${label}.${key}`, 'must be ≥ 0');
  }
  if (record['averageFillPrice'] !== null)
    requireFiniteNumberField(functionName, `${label}.averageFillPrice`, record['averageFillPrice']);
  stringList(functionName, `${label}.fillIds`, record['fillIds']);
  stringList(functionName, `${label}.lateFillIds`, record['lateFillIds']);
  requireEpochMsField(functionName, `${label}.lastTimestampMs`, record['lastTimestampMs']);
  for (const key of ['terminal', 'cancelRequested'] as const)
    if (typeof record[key] !== 'boolean')
      refuse(functionName, `${label}.${key}`, 'must be a boolean', ErrorCode.InputWrongType);
  for (const key of ['reason', 'replacedBy', 'reconciledEventId'] as const)
    if (record[key] !== null && typeof record[key] !== 'string')
      refuse(functionName, `${label}.${key}`, 'must be a string or null', ErrorCode.InputWrongType);
  return value as ExecutionOrderState;
}

/** A folded journal state, as `applyJournalEvents` returns it. */
export function requireExecutionJournalState(
  functionName: string,
  label: string,
  value: unknown,
): ExecutionJournalState {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, JOURNAL_STATE_KEYS);
  const record = value as Record<string, unknown>;
  if (record['journalId'] !== null)
    requireIdentityString(functionName, `${label}.journalId`, record['journalId']);
  if (
    typeof record['eventCount'] !== 'number' ||
    !Number.isSafeInteger(record['eventCount']) ||
    record['eventCount'] < 0
  )
    refuse(
      functionName,
      `${label}.eventCount`,
      'must be a non-negative integer',
      ErrorCode.InputWrongType,
    );
  const eventIds = stringList(functionName, `${label}.eventIds`, record['eventIds']);
  if (record['eventCount'] !== eventIds.length)
    refuse(
      functionName,
      `${label}.eventCount`,
      `must equal eventIds.length (${eventIds.length}) — the count is the fold's own tally, never an input. Received ${String(record['eventCount'])}`,
      ErrorCode.InputWrongShape,
    );
  stringList(functionName, `${label}.duplicateEventIds`, record['duplicateEventIds']);
  requireArgumentObject(functionName, `${label}.orders`, record['orders']);
  for (const [orderId, order] of Object.entries(record['orders'] as Record<string, unknown>)) {
    const state = requireExecutionOrderState(
      functionName,
      `${label}.orders[${JSON.stringify(orderId)}]`,
      order,
    );
    if (state.orderId !== orderId)
      refuse(
        functionName,
        `${label}.orders[${JSON.stringify(orderId)}].orderId`,
        `must be the key. Received ${JSON.stringify(state.orderId)}`,
        ErrorCode.InputWrongShape,
      );
  }
  requireArgumentObject(functionName, `${label}.preSubmission`, record['preSubmission']);
  for (const [orderId, types] of Object.entries(
    record['preSubmission'] as Record<string, unknown>,
  )) {
    const list = stringList(
      functionName,
      `${label}.preSubmission[${JSON.stringify(orderId)}]`,
      types,
    );
    list.forEach((type, index) =>
      enumField(
        functionName,
        `${label}.preSubmission[${JSON.stringify(orderId)}][${index}]`,
        type,
        EXECUTION_JOURNAL_EVENT_TYPES,
      ),
    );
  }
  return value as ExecutionJournalState;
}

/** Recompute a content-addressed artifact's hash over its body and refuse a mismatch. */
function verifyContentHash(
  functionName: string,
  label: string,
  record: Record<string, unknown>,
): void {
  const { contentHash: declared, ...body } = record;
  const computed = contentHash(body);
  if (declared !== computed)
    refuse(
      functionName,
      `${label}.contentHash`,
      `does not match the body (computed ${computed}); the artifact was altered after it was produced`,
      ErrorCode.InputWrongShape,
    );
}

export { present as hasPresentKey, enumField, positiveNumber, stringList };
