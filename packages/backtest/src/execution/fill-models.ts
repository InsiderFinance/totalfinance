/**
 * The built-in fill models (Stage 4.6, FC8 Decision 7): one per observation kind. Each is pure and
 * deterministic, reads only the observation it declares, and returns a closed decision — a fill
 * with the price it referenced, or an unfilled decision with its reason. The bar model reproduces
 * the shipped `SimulatedBroker`'s touch rules exactly, so `eventDriven` and the new engines agree
 * on what a bar can fill; the quote and order-book models add what bars cannot say.
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { requireBarPrices, requireOrderIntent } from './validate.js';
import type {
  FillContext,
  FillDecision,
  FillModel,
  FillRequest,
  OrderIntent,
  SessionRules,
} from './types.js';

// ---------------------------------------------------------------------------------------------------
// Shared session and sizing rules
// ---------------------------------------------------------------------------------------------------

function halted(sessions: SessionRules | undefined, instrumentId: string, asOf: number): boolean {
  for (const halt of sessions?.halts ?? []) {
    if (halt.instrumentId !== undefined && halt.instrumentId !== instrumentId) continue;
    if (asOf >= halt.fromTimestampMs && asOf < halt.toTimestampMs) return true;
  }
  return false;
}

function priceLimit(
  sessions: SessionRules | undefined,
  instrumentId: string,
  asOf: number,
): { low: number; high: number } | null {
  for (const window of sessions?.priceLimits ?? []) {
    if (window.instrumentId !== instrumentId) continue;
    if (asOf >= window.fromTimestampMs && asOf < window.toTimestampMs) {
      return { low: window.low, high: window.high };
    }
  }
  return null;
}

/** Apply a participation cap and the partial-fill policy to a requested quantity. */
function sizeFill(
  requested: number,
  available: number | undefined,
  context: FillContext,
): { quantity: number; partial: boolean } | { unfilled: 'zero-quantity' | 'insufficient-depth' } {
  let quantity = requested;
  if (available !== undefined) {
    const cap =
      context.participation !== undefined
        ? available * context.participation
        : Number.POSITIVE_INFINITY;
    if (cap < quantity) quantity = cap;
  }
  if (!(quantity > 0)) return { unfilled: 'zero-quantity' };
  const partial = quantity < requested;
  if (partial && context.partialFills === 'reject') return { unfilled: 'insufficient-depth' };
  return { quantity, partial };
}

function finish(
  order: OrderIntent,
  context: FillContext,
  price: number,
  reference: string,
  available: number | undefined,
  extra: { levelsConsumed?: number } = {},
): FillDecision {
  const limit = priceLimit(context.sessions, order.instrumentId, context.asOf);
  let pricePerUnit = price;
  let clamped = false;
  if (limit !== null) {
    if (pricePerUnit < limit.low) {
      pricePerUnit = limit.low;
      clamped = true;
    } else if (pricePerUnit > limit.high) {
      pricePerUnit = limit.high;
      clamped = true;
    }
  }
  const sized = sizeFill(order.quantity, available, context);
  if ('unfilled' in sized) return { outcome: 'unfilled', reason: sized.unfilled };
  return {
    outcome: 'filled',
    quantity: sized.quantity,
    pricePerUnit,
    reference,
    partial: sized.partial,
    ...(clamped ? { clampedToPriceLimit: true } : {}),
    ...(extra.levelsConsumed !== undefined ? { levelsConsumed: extra.levelsConsumed } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------
// Bar model — the SimulatedBroker's touch rules, verbatim
// ---------------------------------------------------------------------------------------------------

/**
 * Where a bar fills an order, or `null` when the bar never touched it. Market and market-on-open
 * fill at the open; market-on-close at the close; a limit fills at the open when the open is
 * already through it, else at the limit when the range reached it; a stop triggers on the range
 * and fills at the worse of the open and the stop (a gap through the stop fills at the open); a
 * stop-limit becomes a limit at the stop instant, so its effective open is the stop unless the bar
 * gapped through it.
 */
export function barTriggerPrice(input: {
  order: OrderIntent;
  bar: { open: number; high: number; low: number; close: number };
}): { price: number; reference: string } | null {
  requireArgumentObject('barTriggerPrice', 'input', input);
  ensureKnownKeys('barTriggerPrice', 'input', input, ['order', 'bar']);
  requireOrderIntent('barTriggerPrice', 'input.order', input.order);
  requireBarPrices('barTriggerPrice', 'input.bar', input.bar);
  return barTouch(input.order, input.bar);
}

/** The touch rule without the boundary guard — the bar model calls it after its own validation. */
function barTouch(
  order: OrderIntent,
  bar: { open: number; high: number; low: number; close: number },
): { price: number; reference: string } | null {
  const { open, high, low, close } = bar;
  switch (order.type) {
    case 'market':
    case 'market-on-open':
      return { price: open, reference: 'bar.open' };
    case 'market-on-close':
      return { price: close, reference: 'bar.close' };
    case 'limit': {
      const limit = order.limitPrice as number;
      if (order.side === 'buy') {
        return open <= limit
          ? { price: open, reference: 'bar.open' }
          : low <= limit
            ? { price: limit, reference: 'bar.touch:limit' }
            : null;
      }
      return open >= limit
        ? { price: open, reference: 'bar.open' }
        : high >= limit
          ? { price: limit, reference: 'bar.touch:limit' }
          : null;
    }
    case 'stop': {
      const stop = order.stopPrice as number;
      if (order.side === 'buy') {
        return high >= stop ? { price: Math.max(open, stop), reference: 'bar.touch:stop' } : null;
      }
      return low <= stop ? { price: Math.min(open, stop), reference: 'bar.touch:stop' } : null;
    }
    case 'stop-limit': {
      const stop = order.stopPrice as number;
      const limit = order.limitPrice as number;
      const triggered = order.side === 'buy' ? high >= stop : low <= stop;
      if (!triggered) return null;
      if (order.side === 'buy') {
        const entry = Math.max(open, stop);
        return entry <= limit
          ? { price: entry, reference: 'bar.touch:stop-limit' }
          : low <= limit
            ? { price: limit, reference: 'bar.touch:limit' }
            : null;
      }
      const entry = Math.min(open, stop);
      return entry >= limit
        ? { price: entry, reference: 'bar.touch:stop-limit' }
        : high >= limit
          ? { price: limit, reference: 'bar.touch:limit' }
          : null;
    }
    default:
      return null;
  }
}

const barFillModel: FillModel = Object.freeze({
  label: 'bar-touch: market at open, market-on-close at close, limit and stop on the bar range',
  version: '1',
  observation: 'bar',
  fill({ order, observation, context }: FillRequest): FillDecision {
    if (observation.kind !== 'bar') {
      return { outcome: 'unfilled', reason: 'wrong-observation-kind', detail: observation.kind };
    }
    if (halted(context.sessions, order.instrumentId, context.asOf)) {
      return { outcome: 'unfilled', reason: 'halted' };
    }
    const touch = barTouch(order, observation.bar);
    if (touch === null) return { outcome: 'unfilled', reason: 'not-triggered' };
    return finish(order, context, touch.price, touch.reference, observation.bar.volume);
  },
});

// ---------------------------------------------------------------------------------------------------
// Quote model — bid/ask by side, freshness, locked/crossed markets
// ---------------------------------------------------------------------------------------------------

function quoteStale(timestampMs: number, context: FillContext): boolean {
  const maximum = context.staleQuotes.maximumAgeMs;
  return maximum !== null && context.asOf - timestampMs > maximum;
}

const quoteFillModel: FillModel = Object.freeze({
  label: 'quote-side: buy at the ask, sell at the bid; limit and stop against the touch side',
  version: '1',
  observation: 'quote',
  fill({ order, observation, context }: FillRequest): FillDecision {
    if (observation.kind !== 'quote') {
      return { outcome: 'unfilled', reason: 'wrong-observation-kind', detail: observation.kind };
    }
    if (halted(context.sessions, order.instrumentId, context.asOf)) {
      return { outcome: 'unfilled', reason: 'halted' };
    }
    const { quote } = observation;
    if (quoteStale(quote.timestampMs, context)) {
      if (context.staleQuotes.behavior === 'reject') {
        throw new InputError(
          `execution: the quote for '${order.instrumentId}' at ${quote.timestampMs} is ${context.asOf - quote.timestampMs} ms old at ${context.asOf}, beyond staleQuotes.maximumAgeMs ${String(context.staleQuotes.maximumAgeMs)} — the policy refuses stale fills. Supply a fresher quote, raise the maximum age, or choose behavior 'fill-at-last'.`,
          {
            code: ErrorCode.BacktestStaleQuote,
            context: {
              orderId: order.orderId,
              instrumentId: order.instrumentId,
              asOf: context.asOf,
            },
          },
        );
      }
      // fill-at-last: proceed, but the decision names the staleness through its reference.
    }
    const stale = quoteStale(quote.timestampMs, context);
    const locked = quote.bid === quote.ask;
    const crossed = quote.bid > quote.ask;
    if (locked || crossed) {
      if (context.lockedCrossed === 'reject') {
        return {
          outcome: 'unfilled',
          reason: 'locked-crossed',
          detail: `bid ${quote.bid} ${crossed ? '>' : '='} ask ${quote.ask}`,
        };
      }
      const mid = (quote.bid + quote.ask) / 2;
      const size = order.side === 'buy' ? quote.askSize : quote.bidSize;
      return finish(order, context, mid, stale ? 'quote.mid:stale' : 'quote.mid', size);
    }
    const touchSide = order.side === 'buy' ? quote.ask : quote.bid;
    const size = order.side === 'buy' ? quote.askSize : quote.bidSize;
    const reference = (order.side === 'buy' ? 'quote.ask' : 'quote.bid') + (stale ? ':stale' : '');
    switch (order.type) {
      case 'market':
      case 'market-on-open':
      case 'market-on-close':
        return finish(order, context, touchSide, reference, size);
      case 'limit': {
        const limit = order.limitPrice as number;
        const marketable = order.side === 'buy' ? touchSide <= limit : touchSide >= limit;
        return marketable
          ? finish(order, context, touchSide, reference, size)
          : { outcome: 'unfilled', reason: 'not-triggered' };
      }
      case 'stop': {
        const stop = order.stopPrice as number;
        const triggered = order.side === 'buy' ? touchSide >= stop : touchSide <= stop;
        return triggered
          ? finish(order, context, touchSide, reference, size)
          : { outcome: 'unfilled', reason: 'not-triggered' };
      }
      case 'stop-limit': {
        const stop = order.stopPrice as number;
        const limit = order.limitPrice as number;
        const triggered = order.side === 'buy' ? touchSide >= stop : touchSide <= stop;
        if (!triggered) return { outcome: 'unfilled', reason: 'not-triggered' };
        const marketable = order.side === 'buy' ? touchSide <= limit : touchSide >= limit;
        return marketable
          ? finish(order, context, touchSide, reference, size)
          : { outcome: 'unfilled', reason: 'not-triggered' };
      }
      default:
        return { outcome: 'unfilled', reason: 'not-triggered' };
    }
  },
});

// ---------------------------------------------------------------------------------------------------
// Order-book model — walk the levels
// ---------------------------------------------------------------------------------------------------

const orderBookFillModel: FillModel = Object.freeze({
  label: 'order-book: walk the opposite side by level; average price, levels consumed reported',
  version: '1',
  observation: 'order-book',
  fill({ order, observation, context }: FillRequest): FillDecision {
    if (observation.kind !== 'order-book') {
      return { outcome: 'unfilled', reason: 'wrong-observation-kind', detail: observation.kind };
    }
    if (halted(context.sessions, order.instrumentId, context.asOf)) {
      return { outcome: 'unfilled', reason: 'halted' };
    }
    const { book } = observation;
    if (quoteStale(book.timestampMs, context)) {
      if (context.staleQuotes.behavior === 'reject') {
        throw new InputError(
          `execution: the order book for '${order.instrumentId}' at ${book.timestampMs} is ${context.asOf - book.timestampMs} ms old at ${context.asOf}, beyond staleQuotes.maximumAgeMs ${String(context.staleQuotes.maximumAgeMs)} — the policy refuses stale fills.`,
          {
            code: ErrorCode.BacktestStaleQuote,
            context: {
              orderId: order.orderId,
              instrumentId: order.instrumentId,
              asOf: context.asOf,
            },
          },
        );
      }
    }
    const stale = quoteStale(book.timestampMs, context);
    const levels = order.side === 'buy' ? book.asks : book.bids;
    const best = levels[0];
    if (best === undefined)
      return { outcome: 'unfilled', reason: 'insufficient-depth', detail: 'empty side' };
    const bestBid = book.bids[0]?.price;
    const bestAsk = book.asks[0]?.price;
    if (bestBid !== undefined && bestAsk !== undefined && bestBid >= bestAsk) {
      if (context.lockedCrossed === 'reject') {
        return {
          outcome: 'unfilled',
          reason: 'locked-crossed',
          detail: `bid ${bestBid} ≥ ask ${bestAsk}`,
        };
      }
      const mid = (bestBid + bestAsk) / 2;
      return finish(order, context, mid, stale ? 'book.mid:stale' : 'book.mid', best.size);
    }
    // Trigger rules against the best opposite level (a stop fires on the touch side).
    if (order.type === 'stop' || order.type === 'stop-limit') {
      const stop = order.stopPrice as number;
      const triggered = order.side === 'buy' ? best.price >= stop : best.price <= stop;
      if (!triggered) return { outcome: 'unfilled', reason: 'not-triggered' };
    }
    const limit =
      order.type === 'limit' || order.type === 'stop-limit' ? (order.limitPrice as number) : null;
    // Walk the levels; a limit stops the walk at the first level through it.
    let remaining = order.quantity;
    if (context.participation !== undefined) {
      const depth = levels.reduce((sum, level) => sum + level.size, 0);
      remaining = Math.min(remaining, depth * context.participation);
    }
    if (!(remaining > 0)) return { outcome: 'unfilled', reason: 'zero-quantity' };
    let filled = 0;
    let notional = 0;
    let consumed = 0;
    for (const level of levels) {
      if (limit !== null && (order.side === 'buy' ? level.price > limit : level.price < limit))
        break;
      const take = Math.min(remaining - filled, level.size);
      if (!(take > 0)) break;
      filled += take;
      notional += take * level.price;
      consumed += 1;
      if (filled >= remaining) break;
      if (context.queue.model === 'none') break; // one level only: no depth approximation was declared
    }
    if (!(filled > 0)) {
      return {
        outcome: 'unfilled',
        reason: limit !== null ? 'not-triggered' : 'insufficient-depth',
      };
    }
    const partial = filled < order.quantity;
    if (partial && context.partialFills === 'reject') {
      return {
        outcome: 'unfilled',
        reason: 'insufficient-depth',
        detail: `${filled} of ${order.quantity}`,
      };
    }
    const average = notional / filled;
    const priceLimitBand = priceLimit(context.sessions, order.instrumentId, context.asOf);
    let pricePerUnit = average;
    let clamped = false;
    if (priceLimitBand !== null) {
      if (pricePerUnit < priceLimitBand.low) {
        pricePerUnit = priceLimitBand.low;
        clamped = true;
      } else if (pricePerUnit > priceLimitBand.high) {
        pricePerUnit = priceLimitBand.high;
        clamped = true;
      }
    }
    return {
      outcome: 'filled',
      quantity: filled,
      pricePerUnit,
      reference: stale ? 'book.levels:stale' : 'book.levels',
      partial,
      ...(clamped ? { clampedToPriceLimit: true } : {}),
      levelsConsumed: consumed,
    };
  },
});

/** The built-in fill models, one per observation kind. Each factory returns the frozen singleton. */
export const fillModels = Object.freeze({
  bar: (): FillModel => barFillModel,
  quote: (): FillModel => quoteFillModel,
  orderBook: (): FillModel => orderBookFillModel,
});
