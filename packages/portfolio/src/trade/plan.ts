/**
 * `normalizeTradePlan` (Decision 3): an intent or a rebalance proposal becomes the one executable
 * plan — orders in the frozen execution grammar, a target weight sized to whole units at the mark,
 * reference prices from the market snapshot, the FC7 trade rows for estimates, the source named,
 * and a content hash over the body. Nothing here places an order.
 */
import {
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isOccOptionSymbol,
  requireArgumentObject,
  resolveAsOf,
} from '@totalfinance/core';
import type { MarketSnapshot } from '@totalfinance/core/artifacts';
import { contentHash, readMarketSnapshot } from '@totalfinance/core/artifacts';
import { deepFreeze, hasOwnKey, requireEpochMsField, requireIdentityString } from '../internal.js';
import type { CurrencyPairQuote } from '../internal.js';
import { TRADE_PLAN_KIND, type TradePlanArtifact, type TradePlanTrade } from '../rebalance.js';
import { portfolioSnapshot } from '../snapshot.js';
import { requirePortfolioStateShape } from '../state.js';
import type { PortfolioState } from '../state.js';
import {
  EXECUTION_PLAN_KIND,
  EXECUTION_PLAN_SCHEMA_VERSION,
  type ExecutionPlan,
  type ExecutionPlanCombo,
  type NormalizeTradePlanInput,
  type PreflightInstrument,
  type TradeIntentCombo,
  type TradeOrder,
} from './types.js';
import {
  conversionsField,
  hasPresentKey,
  refuse,
  requirePreflightInstrument,
  requireTradeIntent,
  stringList,
} from './validate.js';

const FN = 'normalizeTradePlan';
const INPUT_KEYS = [
  'intent',
  'proposal',
  'portfolio',
  'market',
  'asOf',
  'accountId',
  'instruments',
  'currencyConversions',
  'rationale',
  'evidence',
] as const;

/** The reference price and currency for an instrument at the snapshot, or null without a spot. */
export function spotPriceOf(
  market: MarketSnapshot,
  instrumentId: string,
): { price: number; currency: string | null } | null {
  const spot = market.observations.spots?.[instrumentId];
  if (spot === undefined || !(spot.price > 0)) return null;
  return { price: spot.price, currency: spot.currency ?? null };
}

/**
 * The reference price for an instrument: the snapshot's spot when it has one at a positive price,
 * else null (a limit price stands in only without one). The snapshot is read through its own door.
 */
export function referencePriceOf(
  market: MarketSnapshot,
  instrumentId: string,
): { price: number; currency: string | null } | null {
  const { snapshot } = readMarketSnapshot({ snapshot: market });
  requireIdentityString('referencePriceOf', 'instrumentId', instrumentId);
  return spotPriceOf(snapshot, instrumentId);
}

/**
 * An OCC option symbol without a declared contract multiplier is refused, never defaulted. A spot
 * (or a description that omits the field) says nothing about the contract size, and the share
 * default of 1 would size, estimate and preflight a 100-share contract at 1% of its cash value.
 * Plain instruments keep the share default; the plan row discloses the multiplier it used.
 */
function requireDeclaredMultiplier(
  functionName: string,
  instrumentId: string,
  knownFrom: 'instruments' | 'market spot',
): void {
  if (!isOccOptionSymbol(instrumentId)) return;
  refuse(
    functionName,
    `instruments['${instrumentId}'].contractMultiplier`,
    `is required: '${instrumentId}' is an OCC option symbol ${
      knownFrom === 'instruments'
        ? 'described without a contract multiplier'
        : 'known only from a market spot'
    }, and the share default of 1 would value each contract at one share. Describe it in input.instruments with its currency and contractMultiplier (100 for a standard US equity option).`,
    ErrorCode.InputMissingField,
  );
}

/** What preflight and the broker know about an instrument: the ledger's position first, then the caller's description, then the spot. */
export function resolveInstrument(
  functionName: string,
  portfolio: PortfolioState,
  accountId: string,
  instruments: Readonly<Record<string, PreflightInstrument>> | undefined,
  market: MarketSnapshot,
  instrumentId: string,
): {
  currency: string;
  contractMultiplier: number;
  assetClass: string | null;
  source: string;
} | null {
  const held = portfolio.accounts[accountId]?.positions[instrumentId];
  if (held !== undefined) {
    return {
      currency: held.currency,
      contractMultiplier: held.contractMultiplier,
      assetClass: null,
      source: 'ledger position',
    };
  }
  const described = instruments?.[instrumentId];
  if (described !== undefined) {
    if (described.contractMultiplier === undefined)
      requireDeclaredMultiplier(functionName, instrumentId, 'instruments');
    return {
      currency: described.currency,
      contractMultiplier: described.contractMultiplier ?? 1,
      assetClass: described.assetClass ?? null,
      source: 'instruments',
    };
  }
  const spot = spotPriceOf(market, instrumentId);
  if (spot !== null && spot.currency !== null) {
    requireDeclaredMultiplier(functionName, instrumentId, 'market spot');
    return {
      currency: spot.currency,
      contractMultiplier: 1,
      assetClass: null,
      source: 'market spot',
    };
  }
  return null;
}

/**
 * B5 — the plan's combos: every comboId the orders carry, its legs in plan order, and the net limit
 * the intent gave it (a combo without terms fills its legs at their own prices). The intent guard
 * already refused a one-leg combo, so a combo here always has at least two legs.
 */
function combosOf(
  orders: readonly TradeOrder[],
  terms: readonly TradeIntentCombo[] | undefined,
): ExecutionPlanCombo[] {
  const legs = new Map<string, string[]>();
  for (const order of orders) {
    if (order.comboId === undefined) continue;
    legs.set(order.comboId, [...(legs.get(order.comboId) ?? []), order.orderId]);
  }
  const byId = new Map((terms ?? []).map((combo) => [combo.comboId, combo]));
  return [...legs.entries()].map(([comboId, orderIds]) => {
    const net = byId.get(comboId)?.netLimitPrice;
    return { comboId, orderIds, ...(net !== undefined ? { netLimitPrice: net } : {}) };
  });
}

export function normalizeTradePlan(input: NormalizeTradePlanInput): ExecutionPlan {
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, INPUT_KEYS);
  const hasIntent = hasPresentKey(input, 'intent');
  const hasProposal = hasPresentKey(input, 'proposal');
  if (hasIntent === hasProposal)
    refuse(
      FN,
      'input',
      'must carry exactly one of intent or proposal.',
      hasIntent ? ErrorCode.InputUnknownField : ErrorCode.InputMissingField,
    );
  requirePortfolioStateShape(FN, 'input.portfolio', input.portfolio);
  const { snapshot: market } = readMarketSnapshot({ snapshot: input.market });
  const asOf = resolveAsOf(input.asOf, FN);
  if (hasPresentKey(input, 'accountId'))
    requireIdentityString(FN, 'input.accountId', input.accountId);
  if (hasPresentKey(input, 'instruments')) {
    requireArgumentObject(FN, 'input.instruments', input.instruments);
    for (const [id, spec] of Object.entries(input.instruments!))
      requirePreflightInstrument(FN, `input.instruments.${id}`, spec);
  }
  if (hasPresentKey(input, 'rationale') && typeof input.rationale !== 'string')
    refuse(FN, 'input.rationale', 'must be a string.', ErrorCode.InputWrongType);
  const evidence = hasPresentKey(input, 'evidence')
    ? stringList(FN, 'input.evidence', input.evidence)
    : [];
  const conversions: CurrencyPairQuote[] = hasPresentKey(input, 'currencyConversions')
    ? conversionsField(FN, input.currencyConversions)
    : [];
  const portfolio = input.portfolio;

  let accountId: string;
  let sourceOrders: Array<{
    instrumentId: string;
    side: 'buy' | 'sell';
    quantity: number;
    type: TradeOrder['type'];
    limitPrice?: number;
    stopPrice?: number;
    timeInForce?: TradeOrder['timeInForce'];
    comboId?: string;
  }>;
  let intentCombos: readonly TradeIntentCombo[] | undefined;
  let source: ExecutionPlan['source'];
  let economicHash: string;
  let rationale: string | undefined;

  if (hasIntent) {
    const intent = requireTradeIntent(FN, 'input.intent', input.intent);
    accountId = input.accountId ?? intent.accountId;
    if (input.accountId !== undefined && input.accountId !== intent.accountId)
      refuse(
        FN,
        'input.accountId',
        `is '${input.accountId}' but the intent names '${intent.accountId}' — one account per plan.`,
      );
    const nav = portfolioSnapshot({
      portfolio,
      asOf,
      market,
      ...(conversions.length > 0 ? { currencyConversions: conversions } : {}),
    }).netAssetValue;
    sourceOrders = intent.orders.map((order, i) => {
      const reference = spotPriceOf(market, order.instrumentId);
      let quantity = order.quantity;
      if (quantity === undefined) {
        if (reference === null)
          refuse(
            FN,
            `input.intent.orders[${i}]`,
            `sizes a notional weight of ${order.instrumentId} but the market snapshot has no spot for it.`,
            ErrorCode.PortfolioMarkUnavailable,
          );
        const resolved = resolveInstrument(
          FN,
          portfolio,
          accountId,
          input.instruments,
          market,
          order.instrumentId,
        );
        const multiplier = resolved?.contractMultiplier ?? 1;
        quantity = Math.floor((order.notionalWeight! * nav) / (reference.price * multiplier));
        if (!Number.isFinite(quantity) || quantity > Number.MAX_SAFE_INTEGER)
          refuse(
            FN,
            `input.intent.orders[${i}].notionalWeight`,
            `sizes to a quantity that cannot be represented (${order.notionalWeight} of NAV ${nav} at ${reference.price} × ${multiplier}); the mark is degenerate or the weight is absurd.`,
          );
        if (!(quantity > 0))
          refuse(
            FN,
            `input.intent.orders[${i}].notionalWeight`,
            `sizes to no whole unit of ${order.instrumentId} at ${reference.price} on NAV ${nav}.`,
          );
      }
      return {
        instrumentId: order.instrumentId,
        side: order.side,
        quantity,
        type: order.type,
        ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
        ...(order.stopPrice !== undefined ? { stopPrice: order.stopPrice } : {}),
        ...(order.timeInForce !== undefined ? { timeInForce: order.timeInForce } : {}),
        ...(order.comboId !== undefined ? { comboId: order.comboId } : {}),
      };
    });
    intentCombos = intent.combos;
    const { rationale: intentRationale, ...intentBody } = intent;
    void intentBody;
    source = { kind: 'intent', intentHash: contentHash(intent) };
    // The economic body: free text and evidence are metadata and never change an order id.
    const { rationale: _rationale, evidence: _evidence, ...economic } = intent;
    economicHash = contentHash(economic);
    rationale = input.rationale ?? intentRationale;
    if (intent.evidence !== undefined)
      for (const id of intent.evidence) if (!evidence.includes(id)) evidence.push(id);
  } else {
    const proposal = input.proposal as TradePlanArtifact;
    requireArgumentObject(FN, 'input.proposal', proposal);
    if (proposal.kind !== TRADE_PLAN_KIND)
      refuse(
        FN,
        'input.proposal.kind',
        `must be '${TRADE_PLAN_KIND}' (proposePortfolioRebalance's plan).`,
        ErrorCode.InputInvalidEnum,
      );
    requireIdentityString(FN, 'input.proposal.contentHash', proposal.contentHash);
    if (!Array.isArray(proposal.trades) || proposal.trades.length === 0)
      refuse(
        FN,
        'input.proposal.trades',
        'must hold at least one trade.',
        ErrorCode.InputWrongType,
      );
    const accounts = new Set(proposal.trades.map((t) => t.accountId));
    if (accounts.size !== 1)
      refuse(FN, 'input.proposal.trades', `span ${accounts.size} accounts — one account per plan.`);
    accountId = input.accountId ?? proposal.trades[0]!.accountId;
    if (accountId !== proposal.trades[0]!.accountId)
      refuse(
        FN,
        'input.accountId',
        `is '${accountId}' but the proposal trades '${proposal.trades[0]!.accountId}'.`,
      );
    sourceOrders = proposal.trades.map((t) => ({
      instrumentId: t.instrumentId,
      side: t.side,
      quantity: t.quantity,
      type: 'market' as const,
    }));
    source = {
      kind: 'rebalance-proposal',
      planHash: proposal.contentHash,
      policyContentHash: proposal.policyContentHash,
    };
    economicHash = proposal.contentHash;
    rationale = input.rationale;
  }

  const trades: TradePlanTrade[] = [];
  /** Order ids are unique per source (the intent's or the proposal's hash), so one economic intent submits once. */
  const sourcePrefix = economicHash.replace(/^sha256:/, '').slice(0, 12);
  const orders: TradeOrder[] = [];
  const seen = new Set<string>();
  sourceOrders.forEach((order, i) => {
    const key = `${order.instrumentId}#${order.side}#${order.type}#${order.limitPrice ?? ''}#${order.stopPrice ?? ''}`;
    if (seen.has(key))
      refuse(
        FN,
        `orders[${i}]`,
        `duplicates an earlier ${order.side} of ${order.instrumentId} — merge the lines or give them different terms.`,
        ErrorCode.TradePlanInvalid,
      );
    seen.add(key);
    const resolved = resolveInstrument(
      FN,
      portfolio,
      accountId,
      input.instruments,
      market,
      order.instrumentId,
    );
    const reference = spotPriceOf(market, order.instrumentId);
    if (resolved === null)
      refuse(
        FN,
        `orders[${i}].instrumentId`,
        `'${order.instrumentId}' is unknown — not held, not in input.instruments, and without a spot in the market snapshot.`,
        ErrorCode.TradePlanInvalid,
      );
    const price = reference?.price ?? order.limitPrice ?? null;
    if (price === null)
      refuse(
        FN,
        `orders[${i}].instrumentId`,
        `'${order.instrumentId}' has no reference price — no spot in the market snapshot and no limit price.`,
        ErrorCode.PortfolioMarkUnavailable,
      );
    const estimatedNotional = order.quantity * price * resolved.contractMultiplier;
    if (!Number.isFinite(estimatedNotional))
      refuse(
        FN,
        `orders[${i}].quantity`,
        `× ${price} × ${resolved.contractMultiplier} overflows to a non-finite notional; a plan never carries an unrepresentable trade.`,
      );
    trades.push({
      accountId,
      instrumentId: order.instrumentId,
      side: order.side,
      quantity: order.quantity,
      currency: resolved.currency,
      referencePricePerUnit: price,
      contractMultiplier: resolved.contractMultiplier,
      estimatedNotional,
    });
    orders.push({
      orderId: `plan:${sourcePrefix}:${i + 1}:${order.instrumentId}:${order.side}`,
      instrumentId: order.instrumentId,
      side: order.side,
      quantity: order.quantity,
      type: order.type,
      ...(order.limitPrice !== undefined ? { limitPrice: order.limitPrice } : {}),
      ...(order.stopPrice !== undefined ? { stopPrice: order.stopPrice } : {}),
      ...(order.timeInForce !== undefined ? { timeInForce: order.timeInForce } : {}),
      plannedTimestampMs: asOf,
      ...(order.comboId !== undefined ? { comboId: order.comboId } : {}),
    });
  });
  const combos = combosOf(orders, intentCombos);
  const body = {
    kind: EXECUTION_PLAN_KIND,
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    accountId,
    asOf,
    baseCurrency: portfolio.baseCurrency,
    ...(portfolio.portfolioId !== undefined ? { portfolioId: portfolio.portfolioId } : {}),
    orders,
    combos,
    trades,
    source,
    ...(rationale !== undefined ? { rationale } : {}),
    evidence: [...evidence],
  };
  const withHash = { ...body, contentHash: contentHash(body) };
  requireEpochMsField(FN, 'plan.asOf', withHash.asOf);
  if (!hasOwnKey(withHash, 'contentHash'))
    throw new InputError(`${FN}: the plan lost its content hash — an engine invariant failed.`, {
      code: ErrorCode.InputWrongShape,
      context: { function: FN },
    });
  return deepFreeze(withHash as ExecutionPlan);
}
