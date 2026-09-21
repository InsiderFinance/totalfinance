/**
 * One order against one observation through a declared execution policy — the fill decision, the
 * cost models (slippage, half-spread, market impact, commission), and the portfolio-owned fill.
 * The portfolio engine and the paper broker (Stage 7B.2, Decision 7) call THIS, so paper, backtest,
 * and replay share fills, costs, and accounting exactly; the difference is who supplies the
 * observations. Pure: no clock, no state.
 */
import type { EpochMs } from '@totalfinance/core';
import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import type {
  DerivativeContractTerms,
  NormalizedFill,
  SettlementStyle,
} from '@totalfinance/portfolio';
import { normalizedFillFromDecision } from './normalized.js';
import type {
  ExecutionPolicy,
  FillDecision,
  MarketObservation,
  OrderIntent,
  UnfilledReason,
} from './types.js';
import {
  requireExecutionPolicy,
  requireMarketObservation,
  requireOrderIntent,
} from './validate.js';

export interface FillOrderWithPolicyInput {
  policy: ExecutionPolicy;
  order: OrderIntent;
  observation: MarketObservation;
  /** The decision instant (the fill context's `asOf`). */
  asOf: EpochMs;
  accountId: string;
  currency: string;
  fillId: string;
  /** The instant stamped on the fill; default `asOf` (an engine stamps its session close). */
  filledTimestampMs?: EpochMs;
  /** The instrument's fill terms; a plain cash instrument omits them. */
  terms?: {
    contractMultiplier?: number;
    settlementStyle?: SettlementStyle;
    contract?: DerivativeContractTerms;
  };
  /** When the cash leg settles; omitted = at the fill. Ignored unless after `asOf`. */
  settleTimestampMs?: EpochMs;
  /** Accrued interest per unit exchanged with a bond fill (0 = none). */
  accruedPerUnit?: number;
}

export type FillOrderWithPolicyResult =
  | {
      outcome: 'filled';
      fill: NormalizedFill;
      decision: Extract<FillDecision, { outcome: 'filled' }>;
      /** The executed price after slippage, half-spread, and impact. */
      price: number;
      commission: number;
      slippageAdjustment: number;
    }
  | { outcome: 'unfilled'; reason: UnfilledReason; detail: string };

const TERM_KEYS = ['contractMultiplier', 'settlementStyle', 'contract'] as const;
const SETTLEMENT_STYLES = ['cash-on-trade', 'variation-margin'] as const;
const MAX_EPOCH_MS = 8.64e15;

function refuse(functionName: string, field: string, message: string, code: string): never {
  throw new InputError(`${functionName}: ${field} ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

function requireIdentity(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0)
    refuse(
      functionName,
      field,
      `must be a non-empty string. Received ${value === null ? 'null' : typeof value === 'string' ? "''" : typeof value}.`,
      ErrorCode.InputWrongType,
    );
}

function requireFinite(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    refuse(
      functionName,
      field,
      `must be a finite number. Received ${typeof value === 'number' ? value : value === null ? 'null' : typeof value}.`,
      typeof value === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
    );
}

function requireEpochMs(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is number {
  requireFinite(functionName, field, value);
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_EPOCH_MS)
    refuse(
      functionName,
      field,
      `must be an integer epoch-millisecond timestamp within ±8.64e15. Received ${String(value)}.`,
      ErrorCode.InputOutOfRange,
    );
}

function requireTerms(functionName: string, field: string, value: unknown): void {
  requireArgumentObject(functionName, field, value);
  ensureKnownKeys(functionName, field, value as object, TERM_KEYS);
  const record = value as Record<string, unknown>;
  if (record['contractMultiplier'] !== undefined) {
    requireFinite(functionName, `${field}.contractMultiplier`, record['contractMultiplier']);
    if (!((record['contractMultiplier'] as number) > 0))
      refuse(
        functionName,
        `${field}.contractMultiplier`,
        `must be > 0. Received ${String(record['contractMultiplier'])}.`,
        ErrorCode.InputOutOfRange,
      );
  }
  if (
    record['settlementStyle'] !== undefined &&
    !(SETTLEMENT_STYLES as readonly unknown[]).includes(record['settlementStyle'])
  )
    refuse(
      functionName,
      `${field}.settlementStyle`,
      `must be one of ${SETTLEMENT_STYLES.map((s) => `'${s}'`).join(', ')}. Received ${JSON.stringify(record['settlementStyle'])}.`,
      ErrorCode.InputInvalidEnum,
    );
  if (record['contract'] !== undefined)
    requireArgumentObject(functionName, `${field}.contract`, record['contract']);
}

const KEYS = [
  'policy',
  'order',
  'observation',
  'asOf',
  'accountId',
  'currency',
  'fillId',
  'filledTimestampMs',
  'terms',
  'settleTimestampMs',
  'accruedPerUnit',
] as const;

/**
 * Meet one order with one observation through the policy: the fill model decides; a filled decision
 * pays slippage, the half-spread, and impact on the price, commission on the notional, and becomes a
 * `NormalizedFill` (the ledger's own grammar) with its costs and terms; an unfilled decision returns
 * the model's reason. The arithmetic is the engine's, verbatim — the goldens prove it.
 */
export function fillOrderWithPolicy(input: FillOrderWithPolicyInput): FillOrderWithPolicyResult {
  const functionName = 'fillOrderWithPolicy';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, KEYS);
  const { policy, order, observation, asOf } = input;
  requireExecutionPolicy(functionName, 'input.policy', policy);
  requireOrderIntent(functionName, 'input.order', order);
  requireMarketObservation(functionName, 'input.observation', observation);
  requireEpochMs(functionName, 'input.asOf', asOf);
  requireIdentity(functionName, 'input.accountId', input.accountId);
  requireIdentity(functionName, 'input.currency', input.currency);
  requireIdentity(functionName, 'input.fillId', input.fillId);
  // Optional members are present-or-absent; a present null or a wrong type teaches, never a default.
  if (input.filledTimestampMs !== undefined)
    requireEpochMs(functionName, 'input.filledTimestampMs', input.filledTimestampMs);
  if (input.settleTimestampMs !== undefined)
    requireEpochMs(functionName, 'input.settleTimestampMs', input.settleTimestampMs);
  if (input.accruedPerUnit !== undefined)
    requireFinite(functionName, 'input.accruedPerUnit', input.accruedPerUnit);
  if (input.terms !== undefined) requireTerms(functionName, 'input.terms', input.terms);
  const decision = policy.fill.fill({
    order,
    observation,
    context: {
      asOf,
      ...(policy.costs.participation !== undefined
        ? { participation: policy.costs.participation }
        : {}),
      partialFills: policy.partialFills,
      staleQuotes: policy.staleQuotes,
      lockedCrossed: policy.lockedCrossed,
      ...(policy.sessions !== undefined ? { sessions: policy.sessions } : {}),
      queue: policy.queue,
    },
  });
  if (decision.outcome !== 'filled') {
    return {
      outcome: 'unfilled',
      reason: decision.reason,
      detail: decision.detail ?? decision.reason,
    };
  }
  let price = policy.costs.slippage.fill({
    referencePrice: decision.pricePerUnit,
    side: order.side,
    quantity: decision.quantity,
  });
  const direction = order.side === 'buy' ? 1 : -1;
  if (policy.costs.spread !== undefined)
    price +=
      direction *
      policy.costs.spread.halfSpread({ referencePrice: decision.pricePerUnit, side: order.side });
  if (policy.costs.marketImpact !== undefined) {
    const volume = observation.kind === 'bar' ? observation.bar.volume : undefined;
    price *=
      1 +
      direction *
        policy.costs.marketImpact.impact({
          quantity: decision.quantity,
          referencePrice: decision.pricePerUnit,
          ...(volume !== undefined ? { averageDailyVolume: volume } : {}),
        });
  }
  const terms = input.terms ?? {};
  const multiplier = terms.contractMultiplier ?? 1;
  const commission = policy.costs.commission.commission({
    quantity: decision.quantity,
    price: price * multiplier,
  });
  const slippageAdjustment =
    Math.abs(price - decision.pricePerUnit) * decision.quantity * multiplier;
  const accruedPerUnit = input.accruedPerUnit ?? 0;
  const settle = input.settleTimestampMs;
  const fill = normalizedFillFromDecision({
    decision: { ...decision, pricePerUnit: price },
    order,
    accountId: input.accountId,
    currency: input.currency,
    filledTimestampMs: input.filledTimestampMs ?? asOf,
    fillId: input.fillId,
    // Price already includes slippage/spread/impact. The reported adjustment is attribution,
    // whereas NormalizedFill.costs are additional cash charges.
    ...(commission > 0 ? { costs: { commission } } : {}),
    ...(slippageAdjustment > 0 ? { executionPriceAdjustment: slippageAdjustment } : {}),
    ...(settle !== undefined && settle > asOf ? { settleTimestampMs: settle } : {}),
    ...(terms.contractMultiplier !== undefined
      ? { contractMultiplier: terms.contractMultiplier }
      : {}),
    ...(terms.settlementStyle !== undefined ? { settlementStyle: terms.settlementStyle } : {}),
    ...(terms.contract !== undefined ? { contract: terms.contract } : {}),
    ...(accruedPerUnit !== 0
      ? { accruedInterest: accruedPerUnit * decision.quantity * multiplier }
      : {}),
  });
  return { outcome: 'filled', fill, decision, price, commission, slippageAdjustment };
}
