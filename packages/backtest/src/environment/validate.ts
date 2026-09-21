import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { hasOwn, requireOrderIntent } from '../execution/validate.js';
import { requirePortfolioStepperRequest } from '../portfolio/validate.js';
import type {
  EnvironmentAction,
  EnvironmentLimits,
  EnvironmentOrder,
  FeatureRecipes,
  RewardComposition,
  TradingEnvironmentDefinition,
} from './types.js';

/** The most steps one episode may take (Decision 11). */
export const MAXIMUM_ENVIRONMENT_STEPS = 100_000;
/** Bytes of `rationale` kept per action; longer text is truncated with a diagnostic, never refused. */
export const RATIONALE_BYTE_LIMIT = 4_096;

const ORDER_KEYS = [
  'orderId',
  'instrumentId',
  'side',
  'quantity',
  'type',
  'limitPrice',
  'stopPrice',
  'timeInForce',
] as const;
const HOLD_KEYS = ['kind', 'rationale'] as const;
const LIMIT_KEYS = [
  'maximumPositionWeight',
  'maximumGroupWeights',
  'maximumGrossLeverage',
  'maximumDrawdown',
  'maximumDailyLoss',
  'maximumDaysToLiquidate',
  'minimumSettledCash',
  'allowUndefinedRiskOptions',
  'maximumPositionNotional',
  'onBreach',
] as const;
const REWARD_KEYS = [
  'pnl',
  'drawdown',
  'turnover',
  'cost',
  'concentration',
  'leverage',
  'riskViolation',
  'benchmark',
  'goal',
] as const;
const FEATURE_KEYS = ['lookbackReturns', 'realizedVolatility', 'drawdown'] as const;
const ON_BREACH = ['terminate', 'reject-and-continue'] as const;
const ORDERS_KEYS = ['kind', 'orders', 'cancel', 'rationale'] as const;

function refuse(
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

/**
 * The environment definition (Stage 7B.1): the stepper's request plus `maximumSteps`. A `strategy`
 * member teaches which verb wants it — the environment's orders come from `step()`.
 */
export function requireTradingEnvironmentDefinition(
  functionName: string,
  label: string,
  value: unknown,
): TradingEnvironmentDefinition {
  requireArgumentObject(functionName, label, value);
  const definition = value as Record<string, unknown>;
  if (hasOwn(definition, 'strategy'))
    refuse(
      functionName,
      `${label}.strategy`,
      'is not an environment field — the orders come from step(); portfolioBacktest is the verb that runs a strategy.',
      ErrorCode.InputUnknownField,
    );
  const rest: Record<string, unknown> = { ...definition };
  if (hasOwn(definition, 'maximumSteps')) {
    const steps = definition['maximumSteps'];
    if (steps === null)
      refuse(
        functionName,
        `${label}.maximumSteps`,
        'must not be null — omit it for the instant count.',
        ErrorCode.InputWrongType,
      );
    if (!(Number.isSafeInteger(steps) && (steps as number) >= 1))
      refuse(
        functionName,
        `${label}.maximumSteps`,
        `must be a positive safe integer. Received ${String(steps)}.`,
        typeof steps === 'number' ? ErrorCode.InputOutOfRange : ErrorCode.InputWrongType,
      );
    if ((steps as number) > MAXIMUM_ENVIRONMENT_STEPS)
      refuse(
        functionName,
        `${label}.maximumSteps`,
        `is ${steps as number}, above the ${MAXIMUM_ENVIRONMENT_STEPS} one episode may take.`,
        ErrorCode.BacktestInputTooLarge,
      );
    delete rest['maximumSteps'];
  }
  for (const key of ['limits', 'reward', 'features'] as const) {
    if (!hasOwn(definition, key)) continue;
    if (definition[key] === null)
      refuse(
        functionName,
        `${label}.${key}`,
        'must not be null — omit it instead.',
        ErrorCode.InputWrongType,
      );
    if (key === 'limits')
      requireEnvironmentLimits(functionName, `${label}.limits`, definition[key]);
    else if (key === 'reward')
      requireRewardComposition(functionName, `${label}.reward`, definition[key]);
    else requireFeatureRecipes(functionName, `${label}.features`, definition[key]);
    delete rest[key];
  }
  requirePortfolioStepperRequest(functionName, label, rest);
  if (hasOwn(definition, 'reward')) {
    const benchmark = (definition['reward'] as RewardComposition).benchmark;
    if (
      benchmark !== undefined &&
      !(benchmark.instrumentId in (definition['instruments'] as object))
    )
      refuse(
        functionName,
        `${label}.reward.benchmark.instrumentId`,
        `names '${benchmark.instrumentId}', which is not an instrument of this environment.`,
        ErrorCode.InputOutOfRange,
      );
  }
  return value as TradingEnvironmentDefinition;
}

function finiteField(functionName: string, label: string, value: unknown): number {
  if (value === null)
    refuse(functionName, label, 'must not be null — omit it instead.', ErrorCode.InputWrongType);
  if (typeof value !== 'number')
    refuse(
      functionName,
      label,
      `must be a number. Received ${typeof value}.`,
      ErrorCode.InputWrongType,
    );
  if (!Number.isFinite(value))
    refuse(functionName, label, 'must be finite.', ErrorCode.InputNotFinite);
  return value as number;
}

function positiveInteger(functionName: string, label: string, value: unknown): number {
  const n = finiteField(functionName, label, value);
  if (!(Number.isSafeInteger(n) && n >= 1))
    refuse(
      functionName,
      label,
      `must be a positive safe integer. Received ${n}.`,
      ErrorCode.InputOutOfRange,
    );
  return n;
}

/** FC7's `PolicyLimits` members plus the three environment-only ones (Decision 5). */
export function requireEnvironmentLimits(
  functionName: string,
  label: string,
  value: unknown,
): EnvironmentLimits {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, LIMIT_KEYS);
  const limits = value as Record<string, unknown>;
  for (const key of [
    'maximumPositionWeight',
    'maximumGrossLeverage',
    'maximumDrawdown',
    'maximumDailyLoss',
    'maximumDaysToLiquidate',
    'maximumPositionNotional',
  ] as const) {
    if (!hasOwn(limits, key)) continue;
    const n = finiteField(functionName, `${label}.${key}`, limits[key]);
    if (!(n > 0)) refuse(functionName, `${label}.${key}`, `must be > 0. Received ${n}.`);
    if (
      (key === 'maximumPositionWeight' ||
        key === 'maximumDrawdown' ||
        key === 'maximumDailyLoss') &&
      n > 1
    )
      refuse(
        functionName,
        `${label}.${key}`,
        `is a decimal fraction of NAV, at most 1. Received ${n}.`,
      );
  }
  if (hasOwn(limits, 'minimumSettledCash'))
    finiteField(functionName, `${label}.minimumSettledCash`, limits['minimumSettledCash']);
  if (hasOwn(limits, 'maximumGroupWeights')) {
    const rows = limits['maximumGroupWeights'];
    if (!Array.isArray(rows))
      refuse(
        functionName,
        `${label}.maximumGroupWeights`,
        'must be an array of group weight limits.',
        ErrorCode.InputWrongType,
      );
    rows.forEach((row, i) =>
      requireArgumentObject(functionName, `${label}.maximumGroupWeights[${i}]`, row),
    );
  }
  if (
    hasOwn(limits, 'allowUndefinedRiskOptions') &&
    typeof limits['allowUndefinedRiskOptions'] !== 'boolean'
  )
    refuse(
      functionName,
      `${label}.allowUndefinedRiskOptions`,
      `must be a boolean. Received ${limits['allowUndefinedRiskOptions'] === null ? 'null' : typeof limits['allowUndefinedRiskOptions']}.`,
      ErrorCode.InputWrongType,
    );
  if (hasOwn(limits, 'onBreach') && !(ON_BREACH as readonly unknown[]).includes(limits['onBreach']))
    refuse(
      functionName,
      `${label}.onBreach`,
      `must be one of ${ON_BREACH.map((v) => `'${v}'`).join(', ')}. Received ${JSON.stringify(limits['onBreach'])}.`,
      ErrorCode.InputInvalidEnum,
    );
  return value as EnvironmentLimits;
}

/** The reward composition: finite weights, a benchmark with a weight and an instrument, an optional goal callback (Decision 7). */
export function requireRewardComposition(
  functionName: string,
  label: string,
  value: unknown,
): RewardComposition {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, REWARD_KEYS);
  const reward = value as Record<string, unknown>;
  for (const key of [
    'pnl',
    'drawdown',
    'turnover',
    'cost',
    'concentration',
    'leverage',
    'riskViolation',
  ] as const)
    if (hasOwn(reward, key)) finiteField(functionName, `${label}.${key}`, reward[key]);
  if (hasOwn(reward, 'benchmark')) {
    requireArgumentObject(functionName, `${label}.benchmark`, reward['benchmark']);
    ensureKnownKeys(functionName, `${label}.benchmark`, reward['benchmark'] as object, [
      'weight',
      'instrumentId',
    ]);
    const benchmark = reward['benchmark'] as Record<string, unknown>;
    finiteField(functionName, `${label}.benchmark.weight`, benchmark['weight']);
    if (typeof benchmark['instrumentId'] !== 'string' || benchmark['instrumentId'].length === 0)
      refuse(
        functionName,
        `${label}.benchmark.instrumentId`,
        'must name an instrument.',
        ErrorCode.InputWrongType,
      );
  }
  if (hasOwn(reward, 'goal') && typeof reward['goal'] !== 'function')
    refuse(
      functionName,
      `${label}.goal`,
      'must be a function of the reward frame.',
      ErrorCode.InputWrongType,
    );
  return value as RewardComposition;
}

/** The feature recipes: positive integer lookbacks, a positive annualization, a boolean drawdown flag. */
export function requireFeatureRecipes(
  functionName: string,
  label: string,
  value: unknown,
): FeatureRecipes {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, FEATURE_KEYS);
  const recipes = value as Record<string, unknown>;
  const lookbacks = (field: string, rows: unknown): void => {
    if (!Array.isArray(rows))
      refuse(
        functionName,
        field,
        'must be an array of lookbacks in bars.',
        ErrorCode.InputWrongType,
      );
    if (rows.length === 0) refuse(functionName, field, 'must name at least one lookback.');
    rows.forEach((row, i) => {
      const n = positiveInteger(functionName, `${field}[${i}]`, row);
      if (n > MAXIMUM_ENVIRONMENT_STEPS)
        refuse(
          functionName,
          `${field}[${i}]`,
          `is ${n} bars, above the ${MAXIMUM_ENVIRONMENT_STEPS} an episode may hold.`,
          ErrorCode.BacktestInputTooLarge,
        );
    });
  };
  if (hasOwn(recipes, 'lookbackReturns'))
    lookbacks(`${label}.lookbackReturns`, recipes['lookbackReturns']);
  if (hasOwn(recipes, 'realizedVolatility')) {
    requireArgumentObject(
      functionName,
      `${label}.realizedVolatility`,
      recipes['realizedVolatility'],
    );
    ensureKnownKeys(
      functionName,
      `${label}.realizedVolatility`,
      recipes['realizedVolatility'] as object,
      ['lookbacks', 'annualization'],
    );
    const rv = recipes['realizedVolatility'] as Record<string, unknown>;
    lookbacks(`${label}.realizedVolatility.lookbacks`, rv['lookbacks']);
    if (!hasOwn(rv, 'annualization') || rv['annualization'] === undefined) {
      refuse(
        functionName,
        `${label}.realizedVolatility.annualization`,
        'is required — the bars per year that scales the per-bar σ: 252 for daily bars, 52 weekly, 12 monthly, or 1 for the per-bar σ. The environment never assumes the bar frequency.',
        ErrorCode.InputMissingField,
      );
    }
    const a = finiteField(
      functionName,
      `${label}.realizedVolatility.annualization`,
      rv['annualization'],
    );
    if (!(a > 0))
      refuse(
        functionName,
        `${label}.realizedVolatility.annualization`,
        `must be > 0. Received ${a}.`,
      );
  }
  if (hasOwn(recipes, 'drawdown') && typeof recipes['drawdown'] !== 'boolean')
    refuse(functionName, `${label}.drawdown`, 'must be a boolean.', ErrorCode.InputWrongType);
  return value as FeatureRecipes;
}

/** The structural problem with an action, or null — one sentence a rejection row can carry. */
export function actionProblem(value: unknown): string | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return `an action is an object of named fields, received ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`;
  const action = value as Record<string, unknown>;
  const kind = action['kind'];
  if (kind !== 'hold' && kind !== 'orders')
    return `kind must be 'hold' or 'orders', received ${JSON.stringify(kind)}`;
  const allowed: readonly string[] = kind === 'hold' ? HOLD_KEYS : ORDERS_KEYS;
  const unknown = Object.keys(action).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    return `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `'${k}'`).join(', ')} on a '${kind}' action (allowed: ${allowed.join(', ')})`;
  if (hasOwn(action, 'rationale') && typeof action['rationale'] !== 'string')
    return `rationale must be a string, received ${typeof action['rationale']}`;
  if (kind === 'orders') {
    if (!Array.isArray(action['orders'])) return 'orders must be an array of orders';
    const bad = (action['orders'] as unknown[]).findIndex(
      (order) => order === null || typeof order !== 'object' || Array.isArray(order),
    );
    if (bad >= 0) return `orders[${bad}] must be an object of named fields`;
    if (hasOwn(action, 'cancel')) {
      if (!Array.isArray(action['cancel'])) return 'cancel must be an array of order ids';
      const badId = (action['cancel'] as unknown[]).findIndex(
        (id) => typeof id !== 'string' || id.length === 0,
      );
      if (badId >= 0) return `cancel[${badId}] must be a non-empty order id`;
    }
  }
  return null;
}

/** One environment order, validated through the execution grammar it extends. */
export function requireEnvironmentOrder(
  functionName: string,
  label: string,
  value: unknown,
): EnvironmentOrder {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, ORDER_KEYS);
  const order = value as Record<string, unknown>;
  const intent: Record<string, unknown> = { ...order, submittedTimestampMs: 0 };
  if (!hasOwn(order, 'orderId')) intent['orderId'] = 'pending';
  requireOrderIntent(functionName, label, intent);
  return value as EnvironmentOrder;
}

/** An action, refused outright — for callers who want the teaching error rather than a rejection row. */
export function requireEnvironmentAction(
  functionName: string,
  label: string,
  value: unknown,
): EnvironmentAction {
  requireArgumentObject(functionName, label, value);
  const problem = actionProblem(value);
  if (problem !== null) refuse(functionName, label, `— ${problem}.`, ErrorCode.InputWrongShape);
  const action = value as Record<string, unknown>;
  if (action['kind'] === 'orders')
    (action['orders'] as unknown[]).forEach((order, i) =>
      requireEnvironmentOrder(functionName, `${label}.orders[${i}]`, order),
    );
  return value as EnvironmentAction;
}
