/**
 * From a fill decision to the ledger's fill (Stage 4.6, FC8 Decision 2). A simulator that filled an
 * order calls this to produce the portfolio-owned {@link NormalizedFill}; the ledger's own
 * `portfolioEventsFromFill` then turns it into economic events. The backtest package never defines
 * a fill of its own.
 */

import type { EpochMs } from '@totalfinance/core';
import type { Trade } from '../types.js';
import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { type NormalizedFill, requireNormalizedFill } from '@totalfinance/portfolio';
import type { FillDecision, OrderIntent } from './types.js';
import { hasOwn, requireFillDecision, requireOrderIntent } from './validate.js';

export interface NormalizedFillFromDecisionInput {
  decision: FillDecision;
  order: OrderIntent;
  accountId: string;
  currency: string;
  filledTimestampMs: EpochMs;
  /** Defaults to `<orderId>:fill`; a partial fill sequence should number its fills. */
  fillId?: string;
  costs?: NormalizedFill['costs'];
  /** Attribution already included in the execution price, not an additional cash charge. */
  executionPriceAdjustment?: NormalizedFill['executionPriceAdjustment'];
  settleTimestampMs?: EpochMs;
  contractMultiplier?: number;
  settlementStyle?: NormalizedFill['settlementStyle'];
  contract?: NormalizedFill['contract'];
  accruedInterest?: number;
  venue?: string;
  liquidity?: NormalizedFill['liquidity'];
}

/** A deep copy of plain JSON data (the only kind these boundaries accept); typed, lib-free. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const KEYS = [
  'decision',
  'order',
  'accountId',
  'currency',
  'filledTimestampMs',
  'fillId',
  'costs',
  'executionPriceAdjustment',
  'settleTimestampMs',
  'contractMultiplier',
  'settlementStyle',
  'contract',
  'accruedInterest',
  'venue',
  'liquidity',
] as const;

/** Build the portfolio-owned fill for a filled decision; an unfilled decision is a teaching refusal. */
export function normalizedFillFromDecision(input: NormalizedFillFromDecisionInput): NormalizedFill {
  const functionName = 'normalizedFillFromDecision';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, KEYS);
  requireFillDecision(functionName, 'input.decision', input.decision);
  requireOrderIntent(functionName, 'input.order', input.order);
  // Optional members are present-or-absent; a present null is a refusal, never a silent default.
  for (const key of KEYS) {
    if (hasOwn(input, key) && (input as unknown as Record<string, unknown>)[key] === null) {
      throw new InputError(
        `${functionName}: input.${key} is null — omit the field to leave it unset; null is not a value here.`,
        { code: ErrorCode.InputWrongType, context: { field: key } },
      );
    }
  }
  if (hasOwn(input, 'fillId') && (typeof input.fillId !== 'string' || input.fillId.length === 0)) {
    throw new InputError(`${functionName}: input.fillId must be a non-empty string when given.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'fillId' },
    });
  }
  if (input.decision.outcome !== 'filled') {
    throw new InputError(
      `${functionName}: input.decision is not a fill (outcome ${JSON.stringify((input.decision as { outcome?: unknown }).outcome)}${'reason' in input.decision ? `, reason '${String(input.decision.reason)}'` : ''}) — only a filled decision becomes a ledger fill.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'decision.outcome', orderId: input.order.orderId },
      },
    );
  }
  const fill: NormalizedFill = {
    fillId: input.fillId ?? `${input.order.orderId}:fill`,
    accountId: input.accountId,
    instrumentId: input.order.instrumentId,
    side: input.order.side,
    quantity: input.decision.quantity,
    pricePerUnit: input.decision.pricePerUnit,
    currency: input.currency,
    filledTimestampMs: input.filledTimestampMs,
    orderId: input.order.orderId,
    ...(input.settleTimestampMs !== undefined
      ? { settleTimestampMs: input.settleTimestampMs }
      : {}),
    ...(input.contractMultiplier !== undefined
      ? { contractMultiplier: input.contractMultiplier }
      : {}),
    ...(input.settlementStyle !== undefined ? { settlementStyle: input.settlementStyle } : {}),
    ...(input.contract !== undefined ? { contract: cloneJson(input.contract) } : {}),
    ...(input.accruedInterest !== undefined ? { accruedInterest: input.accruedInterest } : {}),
    ...(input.costs !== undefined ? { costs: { ...input.costs } } : {}),
    ...(input.executionPriceAdjustment !== undefined
      ? { executionPriceAdjustment: input.executionPriceAdjustment }
      : {}),
    ...(input.venue !== undefined ? { venue: input.venue } : {}),
    ...(input.liquidity !== undefined ? { liquidity: input.liquidity } : {}),
  };
  requireNormalizedFill(functionName, 'fill', fill);
  return fill;
}

/** Input for {@link normalizedFillsFromBacktest}: the trades a backtest reported, and the account they book to. */
export interface NormalizedFillsFromBacktestInput {
  /** The run's trades (`result.trades`), in order. */
  trades: readonly Trade[];
  accountId: string;
  /** The currency every fill books in (a backtest quotes one currency). */
  currency: string;
  /** Fill ids default to `<sourceId>:fill:<n>`; the source names the run. */
  sourceId: string;
  /** Instrument terms by symbol (an option's contract, its settlement style) for fills that need them. */
  instruments?: Readonly<
    Record<
      string,
      {
        contract?: NormalizedFill['contract'];
        settlementStyle?: NormalizedFill['settlementStyle'];
        settleTimestampMs?: EpochMs;
      }
    >
  >;
}

const FROM_BACKTEST_KEYS = ['trades', 'accountId', 'currency', 'sourceId', 'instruments'] as const;

/**
 * B6 — the bridge from a backtest's trades to the ledger's fills: one `NormalizedFill` per trade,
 * keyed by `instrumentId = symbol`, the contract multiplier the engine stamped, commission and
 * commission as a cash cost. Slippage is already in trade.price; trade.slippage is attribution,
 * not another cash charge. Every fill is validated by the ledger's own guard, so a run's trades fold
 * through `portfolioEventsFromFill` exactly like a paper broker's.
 */
export function normalizedFillsFromBacktest(
  input: NormalizedFillsFromBacktestInput,
): NormalizedFill[] {
  const functionName = 'normalizedFillsFromBacktest';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, FROM_BACKTEST_KEYS);
  if (!Array.isArray(input.trades)) {
    throw new InputError(`${functionName}: input.trades must be an array of backtest trades.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'trades' },
    });
  }
  for (const key of ['accountId', 'currency', 'sourceId'] as const) {
    if (typeof input[key] !== 'string' || input[key].length === 0) {
      throw new InputError(`${functionName}: input.${key} must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: key },
      });
    }
  }
  if (input.instruments !== undefined)
    requireArgumentObject(functionName, 'input.instruments', input.instruments);
  return input.trades.map((trade, index) => {
    requireArgumentObject(functionName, `input.trades[${index}]`, trade);
    for (const key of ['commission', 'slippage'] as const) {
      if (typeof trade[key] !== 'number' || !Number.isFinite(trade[key]) || trade[key] < 0)
        throw new InputError(
          `${functionName}: input.trades[${index}].${key} must be a finite non-negative amount in the trade currency.`,
          {
            code:
              typeof trade[key] !== 'number'
                ? ErrorCode.InputWrongType
                : !Number.isFinite(trade[key])
                  ? ErrorCode.InputNotFinite
                  : ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `input.trades[${index}].${key}` },
          },
        );
    }
    const terms = input.instruments?.[trade.symbol];
    const costs: NonNullable<NormalizedFill['costs']> = {
      ...(trade.commission > 0 ? { commission: trade.commission } : {}),
    };
    const fill: NormalizedFill = {
      fillId: `${input.sourceId}:fill:${index + 1}`,
      accountId: input.accountId,
      instrumentId: trade.symbol,
      side: trade.side,
      quantity: trade.quantity,
      pricePerUnit: trade.price,
      currency: input.currency,
      filledTimestampMs: trade.timestampMs,
      ...(trade.multiplier !== 1 ? { contractMultiplier: trade.multiplier } : {}),
      ...(terms?.contract !== undefined
        ? { contract: cloneJson(terms.contract), contractMultiplier: trade.multiplier }
        : {}),
      ...(terms?.settlementStyle !== undefined ? { settlementStyle: terms.settlementStyle } : {}),
      ...(terms?.settleTimestampMs !== undefined
        ? { settleTimestampMs: terms.settleTimestampMs }
        : {}),
      ...(Object.keys(costs).length > 0 ? { costs } : {}),
      ...(trade.slippage !== 0 ? { executionPriceAdjustment: trade.slippage } : {}),
    };
    requireNormalizedFill(functionName, `fills[${index}]`, fill);
    return fill;
  });
}
