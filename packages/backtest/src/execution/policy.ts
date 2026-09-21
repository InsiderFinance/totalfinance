/**
 * Execution policies (Stage 4.6, FC8 Decision 7): the honest default and the declared override.
 *
 * `execution.simplified()` is what a run gets when it names no policy: market at the open,
 * market-on-close at the close, limit and stop on the bar range, full fills, no spread, impact,
 * latency, or borrow, a cash account with no margin. Its label says exactly that and every result
 * echoes it under `assumptions.execution` with `realism: 'simplified'`. `execution.declared()`
 * takes the members a caller wants to state, fills the rest with the simplified ones, and requires
 * a label — a declared policy is a claim the caller signs. A member that is present is validated
 * (`null` is refused: omission is spelled by leaving the key out).
 */

import {
  ErrorCode,
  InputError,
  ensureFinite,
  ensureKnownKeys,
  ensureNonNegative,
  requireArgumentObject,
} from '@totalfinance/core';
import {
  type BorrowModel,
  type CostModel,
  type SlippageModel,
  borrow,
  fees,
  slippage,
} from '../costs.js';
import { fillModels } from './fill-models.js';
import type {
  AmbiguityPolicy,
  ExecutionCosts,
  ExecutionPolicy,
  ExecutionPolicyDescription,
  TimeInForce,
  FillModel,
  LatencyModel,
  LockedCrossedPolicy,
  MarginPolicy,
  MarketImpactModel,
  MarketObservationKind,
  OrderSide,
  PartialFillPolicy,
  QueueModel,
  SessionRules,
  SpreadModel,
  StaleQuotePolicy,
} from './types.js';
import {
  hasOwn,
  requireExecutionPolicy,
  requireFillModel,
  requireLabeledModel,
  requireMarginPolicy,
  requireSessionRules,
  requireStaleQuotePolicy,
} from './validate.js';

/** A deep copy of plain JSON data (the only kind these boundaries accept); typed, lib-free. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------------------------------
// Small named models
// ---------------------------------------------------------------------------------------------------

/** Spread models: an aggressor pays half the quoted spread on top of the reference price. */
export const spreadModels = Object.freeze({
  /** A constant half-spread in basis points of the reference price. */
  halfSpreadBps(bps: number): SpreadModel {
    ensureFinite(bps, 'bps', 'spreadModels.halfSpreadBps');
    ensureNonNegative(bps, 'bps', 'spreadModels.halfSpreadBps');
    return Object.freeze({
      label: `half-spread ${bps} bps`,
      halfSpread: ({ referencePrice }: { referencePrice: number; side: OrderSide }): number =>
        Math.abs(referencePrice) * (bps / 10_000),
    });
  },
  none(): SpreadModel {
    return Object.freeze({ label: 'no spread', halfSpread: (): number => 0 });
  },
});

/** Market-impact models: the fraction of the reference price a quantity moves against itself. */
export const impactModels = Object.freeze({
  /**
   * The square-root law: impact = coefficient × √(quantity / averageDailyVolume). A fill with no
   * average daily volume in context has no impact and says so through the label the engine echoes.
   */
  squareRoot(input: { coefficient: number }): MarketImpactModel {
    requireArgumentObject('impactModels.squareRoot', 'input', input);
    ensureKnownKeys('impactModels.squareRoot', 'input', input, ['coefficient']);
    ensureFinite(input.coefficient, 'coefficient', 'impactModels.squareRoot');
    ensureNonNegative(input.coefficient, 'coefficient', 'impactModels.squareRoot');
    const { coefficient } = input;
    return Object.freeze({
      label: `square-root impact, coefficient ${coefficient} (no impact without an average daily volume)`,
      impact: ({
        quantity,
        averageDailyVolume,
      }: {
        quantity: number;
        referencePrice: number;
        averageDailyVolume?: number;
      }): number => {
        if (averageDailyVolume === undefined || !(averageDailyVolume > 0) || !(quantity > 0))
          return 0;
        return coefficient * Math.sqrt(quantity / averageDailyVolume);
      },
    });
  },
  none(): MarketImpactModel {
    return Object.freeze({ label: 'no market impact', impact: (): number => 0 });
  },
});

/** Latency models: how many observations after submission an order is first worked. */
export const latencyModels = Object.freeze({
  sessions(sessions: number): LatencyModel {
    if (!Number.isSafeInteger(sessions) || sessions < 0 || sessions > 10_000) {
      throw new InputError(
        `latencyModels.sessions: sessions must be an integer in [0, 10000] (observations after submission before the order is worked). Received ${String(sessions)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'sessions' } },
      );
    }
    return Object.freeze({
      label: `latency ${sessions} session${sessions === 1 ? '' : 's'}`,
      sessions,
    });
  },
});

// ---------------------------------------------------------------------------------------------------
// Margin helpers (pure; the engines apply them)
// ---------------------------------------------------------------------------------------------------

/** Equity a new position of `notional` requires at entry under the policy. */
export function requiredInitialMargin(input: { notional: number; policy: MarginPolicy }): number {
  requireArgumentObject('requiredInitialMargin', 'input', input);
  ensureKnownKeys('requiredInitialMargin', 'input', input, ['notional', 'policy']);
  ensureFinite(input.notional, 'notional', 'requiredInitialMargin');
  ensureNonNegative(input.notional, 'notional', 'requiredInitialMargin');
  requireMarginPolicy('requiredInitialMargin', 'input.policy', input.policy);
  return input.notional * input.policy.initialMarginRate;
}

/** Whether equity has fallen below the maintenance requirement on the gross notional held. */
export function maintenanceMarginBreached(input: {
  equity: number;
  grossNotional: number;
  policy: MarginPolicy;
}): { breached: boolean; requiredEquity: number; shortfall: number } {
  requireArgumentObject('maintenanceMarginBreached', 'input', input);
  ensureKnownKeys('maintenanceMarginBreached', 'input', input, [
    'equity',
    'grossNotional',
    'policy',
  ]);
  ensureFinite(input.equity, 'equity', 'maintenanceMarginBreached');
  ensureFinite(input.grossNotional, 'grossNotional', 'maintenanceMarginBreached');
  ensureNonNegative(input.grossNotional, 'grossNotional', 'maintenanceMarginBreached');
  requireMarginPolicy('maintenanceMarginBreached', 'input.policy', input.policy);
  const requiredEquity = input.grossNotional * input.policy.maintenanceMarginRate;
  const shortfall = Math.max(0, requiredEquity - input.equity);
  return { breached: shortfall > 0, requiredEquity, shortfall };
}

// ---------------------------------------------------------------------------------------------------
// The policies
// ---------------------------------------------------------------------------------------------------

const SIMPLIFIED_LABEL =
  'simplified: market at open, market-on-close at close, limit and stop on the bar range, full fills, no spread, impact, latency, or borrow, cash account';

function simplifiedMembers(): Omit<ExecutionPolicy, 'label' | 'realism'> {
  return {
    observation: 'bar',
    fill: fillModels.bar(),
    ambiguity: 'deterministic-path',
    costs: { commission: fees.none(), slippage: slippage.none() },
    staleQuotes: { maximumAgeMs: null, behavior: 'fill-at-last' },
    lockedCrossed: 'fill-at-mid',
    partialFills: 'allow',
    queue: { model: 'none' },
    timeInForce: { default: 'day', expireAtSessionClose: true },
    margin: {
      buyingPowerMultiplier: 1,
      initialMarginRate: 1,
      maintenanceMarginRate: 0,
      forcedLiquidation: 'none',
    },
  };
}

function freezePolicy(policy: ExecutionPolicy): ExecutionPolicy {
  Object.freeze(policy.costs);
  Object.freeze(policy.staleQuotes);
  Object.freeze(policy.queue);
  Object.freeze(policy.timeInForce);
  Object.freeze(policy.margin);
  if (policy.sessions !== undefined) Object.freeze(policy.sessions);
  return Object.freeze(policy);
}

/** The members `execution.declared` accepts — every one optional except the label. */
export interface DeclaredExecutionPolicy {
  label: string;
  observation?: MarketObservationKind;
  fill?: FillModel;
  ambiguity?: AmbiguityPolicy;
  costs?: Partial<ExecutionCosts>;
  staleQuotes?: StaleQuotePolicy;
  lockedCrossed?: LockedCrossedPolicy;
  sessions?: SessionRules;
  partialFills?: PartialFillPolicy;
  queue?: { model: QueueModel };
  timeInForce?: { default: TimeInForce; expireAtSessionClose: boolean };
  margin?: MarginPolicy;
}

const DECLARED_KEYS = [
  'label',
  'observation',
  'fill',
  'ambiguity',
  'costs',
  'staleQuotes',
  'lockedCrossed',
  'sessions',
  'partialFills',
  'queue',
  'timeInForce',
  'margin',
] as const;
const COST_KEYS = [
  'commission',
  'slippage',
  'spread',
  'marketImpact',
  'latency',
  'participation',
  'borrow',
] as const;
const OBSERVATIONS: readonly MarketObservationKind[] = ['bar', 'quote', 'trade', 'order-book'];

/** The execution policies a run may declare. */
export const execution = Object.freeze({
  /** The honest default: every member named in the label, `realism: 'simplified'`. */
  simplified(): ExecutionPolicy {
    return freezePolicy({ label: SIMPLIFIED_LABEL, realism: 'simplified', ...simplifiedMembers() });
  },
  /**
   * A declared policy: the members given override the simplified ones; the label is required and
   * is the caller's claim about what the run assumes. Every member present is validated — the
   * whole assembled policy passes `requireExecutionPolicy` before it is returned.
   */
  declared(input: DeclaredExecutionPolicy): ExecutionPolicy {
    const functionName = 'execution.declared';
    requireArgumentObject(functionName, 'input', input);
    ensureKnownKeys(functionName, 'input', input, DECLARED_KEYS);
    const given = input as unknown as Record<string, unknown>;
    if (typeof input.label !== 'string' || input.label.length === 0) {
      throw new InputError(
        `${functionName}: input.label must be a non-empty string — a declared execution policy is a claim the caller signs, and results echo it.\n  e.g. execution.declared({ label: 'quote fills, 2 bps half-spread', observation: 'quote', fill: fillModels.quote(), costs: { spread: spreadModels.halfSpreadBps(2) } })`,
        { code: ErrorCode.InputWrongType, context: { field: 'label' } },
      );
    }
    const base = simplifiedMembers();
    // Every member: present → validated (null refused); absent → the simplified member.
    let fill: FillModel | undefined;
    if (hasOwn(given, 'fill')) {
      requireFillModel(functionName, 'input.fill', given['fill']);
      fill = given['fill'] as FillModel;
    }
    let observation: MarketObservationKind;
    if (hasOwn(given, 'observation')) {
      if (!OBSERVATIONS.includes(given['observation'] as MarketObservationKind)) {
        throw new InputError(
          `${functionName}: input.observation must be one of ${OBSERVATIONS.map((o) => `'${o}'`).join(' | ')}. Received ${given['observation'] === null ? 'null' : JSON.stringify(given['observation'])}.`,
          { code: ErrorCode.InputInvalidEnum, context: { field: 'observation' } },
        );
      }
      observation = given['observation'] as MarketObservationKind;
    } else {
      observation = fill !== undefined ? fill.observation : base.observation;
    }
    if (fill === undefined) {
      if (observation === 'quote') fill = fillModels.quote();
      else if (observation === 'order-book') fill = fillModels.orderBook();
      else if (observation === 'trade') {
        throw new InputError(
          `${functionName}: no built-in fill model reads 'trade' observations; supply input.fill.`,
          { code: ErrorCode.InputMissingField, context: { field: 'fill' } },
        );
      } else fill = base.fill;
    }
    if (fill.observation !== observation) {
      throw new InputError(
        `${functionName}: input.fill reads '${fill.observation}' observations but input.observation is '${observation}' — a policy observes what its fill model reads.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'observation' } },
      );
    }
    const costs: ExecutionCosts = { ...base.costs };
    if (hasOwn(given, 'costs')) {
      requireArgumentObject(functionName, 'input.costs', given['costs']);
      const c = given['costs'] as Record<string, unknown>;
      ensureKnownKeys(functionName, 'input.costs', c, COST_KEYS);
      if (hasOwn(c, 'commission')) {
        requireLabeledModel(functionName, 'input.costs.commission', c['commission'], 'commission');
        costs.commission = c['commission'] as CostModel;
      }
      if (hasOwn(c, 'slippage')) {
        requireLabeledModel(functionName, 'input.costs.slippage', c['slippage'], 'fill');
        costs.slippage = c['slippage'] as SlippageModel;
      }
      if (hasOwn(c, 'spread')) {
        requireLabeledModel(functionName, 'input.costs.spread', c['spread'], 'halfSpread');
        costs.spread = c['spread'] as SpreadModel;
      }
      if (hasOwn(c, 'marketImpact')) {
        requireLabeledModel(functionName, 'input.costs.marketImpact', c['marketImpact'], 'impact');
        costs.marketImpact = c['marketImpact'] as MarketImpactModel;
      }
      if (hasOwn(c, 'latency')) {
        requireArgumentObject(functionName, 'input.costs.latency', c['latency']);
        const latency = c['latency'] as { label?: unknown; sessions?: unknown };
        if (typeof latency.label !== 'string' || latency.label.length === 0) {
          throw new InputError(
            `${functionName}: input.costs.latency.label must be a non-empty string.`,
            {
              code: ErrorCode.InputWrongType,
              context: { field: 'costs.latency.label' },
            },
          );
        }
        costs.latency = latencyModels.sessions(latency.sessions as number);
      }
      if (hasOwn(c, 'participation')) {
        const participation = c['participation'];
        if (
          typeof participation !== 'number' ||
          !Number.isFinite(participation) ||
          !(participation > 0) ||
          participation > 1
        ) {
          throw new InputError(
            `${functionName}: input.costs.participation is a finite fraction of the observation's volume in (0, 1]. Received ${participation === null ? 'null' : String(participation)}.`,
            { code: ErrorCode.InputOutOfRange, context: { field: 'costs.participation' } },
          );
        }
        costs.participation = participation;
      }
      if (hasOwn(c, 'borrow')) {
        requireArgumentObject(functionName, 'input.costs.borrow', c['borrow']);
        const b = c['borrow'] as { label?: unknown; annualRate?: unknown };
        if (typeof b.label !== 'string' || b.label.length === 0) {
          throw new InputError(
            `${functionName}: input.costs.borrow.label must be a non-empty string.`,
            {
              code: ErrorCode.InputWrongType,
              context: { field: 'costs.borrow.label' },
            },
          );
        }
        ensureFinite(b.annualRate as number, 'costs.borrow.annualRate', functionName);
        costs.borrow = c['borrow'] as BorrowModel;
      }
    }
    let staleQuotes: StaleQuotePolicy = base.staleQuotes;
    if (hasOwn(given, 'staleQuotes')) {
      requireStaleQuotePolicy(functionName, 'input.staleQuotes', given['staleQuotes']);
      staleQuotes = given['staleQuotes'] as StaleQuotePolicy;
    }
    let sessions: SessionRules | undefined;
    if (hasOwn(given, 'sessions')) {
      requireSessionRules(functionName, 'input.sessions', given['sessions']);
      sessions = cloneJson(given['sessions'] as SessionRules);
    }
    const assembled: ExecutionPolicy = {
      label: input.label,
      realism: 'declared',
      observation,
      fill,
      ambiguity: hasOwn(given, 'ambiguity')
        ? (given['ambiguity'] as AmbiguityPolicy)
        : base.ambiguity,
      costs,
      staleQuotes: { ...staleQuotes },
      lockedCrossed: hasOwn(given, 'lockedCrossed')
        ? (given['lockedCrossed'] as LockedCrossedPolicy)
        : base.lockedCrossed,
      ...(sessions !== undefined ? { sessions } : {}),
      partialFills: hasOwn(given, 'partialFills')
        ? (given['partialFills'] as PartialFillPolicy)
        : base.partialFills,
      queue: hasOwn(given, 'queue')
        ? (cloneJson(given['queue']) as { model: QueueModel })
        : { ...base.queue },
      timeInForce: hasOwn(given, 'timeInForce')
        ? (cloneJson(given['timeInForce']) as ExecutionPolicy['timeInForce'])
        : { ...base.timeInForce },
      margin: hasOwn(given, 'margin')
        ? (cloneJson(given['margin']) as MarginPolicy)
        : { ...base.margin },
    };
    // The assembled whole passes the same guard every engine applies — one law for both paths.
    requireExecutionPolicy(functionName, 'input', assembled);
    return freezePolicy(assembled);
  },
});

/** The JSON-safe projection of a policy every result carries under `assumptions.execution`. */
export function describeExecutionPolicy(policy: ExecutionPolicy): ExecutionPolicyDescription {
  requireExecutionPolicy('describeExecutionPolicy', 'policy', policy);
  return {
    label: policy.label,
    realism: policy.realism,
    observation: policy.observation,
    fill: { label: policy.fill.label, version: policy.fill.version },
    ambiguity: policy.ambiguity,
    costs: {
      commission: policy.costs.commission.label,
      slippage: policy.costs.slippage.label,
      spread: policy.costs.spread?.label ?? null,
      marketImpact: policy.costs.marketImpact?.label ?? null,
      latencySessions: policy.costs.latency?.sessions ?? null,
      participation: policy.costs.participation ?? null,
      borrow: policy.costs.borrow?.label ?? null,
    },
    staleQuotes: { ...policy.staleQuotes },
    lockedCrossed: policy.lockedCrossed,
    sessions: {
      halts: policy.sessions?.halts?.length ?? 0,
      priceLimits: policy.sessions?.priceLimits?.length ?? 0,
      auction: policy.sessions?.auction ?? null,
    },
    partialFills: policy.partialFills,
    queue: policy.queue.model,
    timeInForce: { ...policy.timeInForce },
    margin: { ...policy.margin },
  };
}

// The shipped cost factories are re-exported from the execution subpath so a declared policy can
// be written from one import.
export { borrow, fees, slippage };
