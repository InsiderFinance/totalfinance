/**
 * Trade- and quote-level microstructure (spec §11.7).
 *
 * TotalFinance's indicators consume OHLCV **bars**; this module consumes the tier below them — the raw
 * trade tape and the order book — to compute the analytics that bars structurally cannot:
 *
 *   • **aggressor classification** (Lee-Ready / tick rule): was a print a buy or a sell?
 *   • **cumulative volume delta** (signed-volume accumulation) — streaming + serializable;
 *   • **tick-level volume profile** (volume-by-price from real prints, not smeared bar ranges) with
 *     POC, value area, and per-price buy/sell delta (a footprint);
 *   • **multi-level order-book imbalance** and the size-weighted **microprice**;
 *   • **footprint bars** — aggregate a tape into OHLCV + buy/sell/delta by count, volume, or time.
 *
 * Everything is pure and deterministic. Classification is an ESTIMATE when the feed doesn't stamp the
 * aggressor side — Lee-Ready (quote-relative) is preferred; the tick rule is the fallback.
 */

import {
  ensureFiniteWhenPresent,
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  WarningCode,
  assertFiniteValue,
  ensureKnownKeys,
  facade,
  requireArgumentArray,
  requireArgumentObject,
  seriesFacade,
  warning,
} from '@totalfinance/core';
import type { QuantWarning } from '@totalfinance/core';
import {
  type BarInput,
  type TechnicalAnalysisSnapshot,
  readSnapshot,
  snapshotOf,
} from './framework.js';
import {
  requireBooleanWhenPresent,
  requireFinite,
  requireInRange,
  requireOneOf,
  requireOrderBook,
  requirePeriod,
  requirePositive,
  requireQuote,
  requireQuotes,
  requireTrade,
  requireTrades,
} from './validate.js';

export interface Trade {
  price: number;
  size: number;
  /** Epoch milliseconds (optional; required only for time-bucketed footprint bars). */
  time?: number;
  /** Explicit aggressor side if the feed provides it — takes precedence over inference. */
  side?: 'buy' | 'sell';
}

export interface Quote {
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
}

export interface BookLevel {
  price: number;
  size: number;
}
/** Order book with levels sorted best-first (bids descending, asks ascending). */
export interface OrderBook {
  bids: readonly BookLevel[];
  asks: readonly BookLevel[];
}

export type AggressorMethod = 'side' | 'quote' | 'tick';
export type TradeDirection = -1 | 0 | 1;
const AGGRESSOR_METHODS: readonly AggressorMethod[] = ['side', 'quote', 'tick'];
const TRADE_DIRECTIONS: readonly TradeDirection[] = [-1, 0, 1];

export interface SignContext {
  /** NBBO quote in effect at the trade (for the Lee-Ready quote rule). */
  quote?: Quote;
  /** Previous trade price (for the tick rule / quote-rule tie-break). */
  previousPrice?: number | null;
  /** Previous resolved sign, carried when the tick rule is indeterminate (zero tick). */
  previousSign?: TradeDirection;
}
const SIGN_CONTEXT_KEYS = ['quote', 'previousPrice', 'previousSign'] as const;

/**
 * Core aggressor classification (validation-free) — the batch and streaming paths call this once
 * per print, so it stays lean; the public `tradeSign` envelope validates and wraps it.
 */
interface TradeClassification {
  value: TradeDirection;
  method: AggressorMethod;
}

function classifyTrade(trade: Trade, context: SignContext): TradeClassification {
  if (trade.side !== undefined) {
    return { value: trade.side === 'buy' ? 1 : -1, method: 'side' };
  }
  const tick = (): TradeClassification => {
    if (context.previousPrice == null) return { value: context.previousSign ?? 0, method: 'tick' };
    if (trade.price > context.previousPrice) return { value: 1, method: 'tick' };
    if (trade.price < context.previousPrice) return { value: -1, method: 'tick' };
    return { value: context.previousSign ?? 0, method: 'tick' };
  };
  if (context.quote) {
    const mid = (context.quote.bid + context.quote.ask) / 2;
    if (trade.price > mid) return { value: 1, method: 'quote' };
    if (trade.price < mid) return { value: -1, method: 'quote' };
    return tick(); // exactly at the mid → tick rule
  }
  return tick();
}

/** Aggressor-classification envelope (Law 2): the sign plus applied conventions and diagnostics. */
export interface TradeSignResult {
  /** +1 buyer-initiated, −1 seller-initiated, 0 indeterminate (disclosed in diagnostics). */
  value: TradeDirection;
  /** Applied conventions, echoed — `method` is the rule that actually resolved the sign. */
  assumptions: { conventionsVersion: string; method: AggressorMethod };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Classify a trade's aggressor side: `value` +1 buyer-initiated, −1 seller-initiated, 0
 * indeterminate. Order of precedence: explicit `trade.side` → Lee-Ready quote rule (trade vs mid;
 * at the mid, fall back to the tick rule) → tick rule (uptick = buy, downtick = sell, zero tick
 * carries `previousSign`). An indeterminate sign carries a diagnostics warning (design law #4).
 */
function tradeSignResult(trade: Trade, context: SignContext = {}): TradeSignResult {
  requireTrade(trade, 'tradeSign', 'trade');
  requireArgumentObject('tradeSign', 'context', context);
  ensureKnownKeys('tradeSign', 'context', context, SIGN_CONTEXT_KEYS);
  if (context.quote !== undefined) requireQuote(context.quote, 'tradeSign', 'context.quote');
  if (context.previousPrice !== undefined && context.previousPrice !== null) {
    requireFinite(context.previousPrice, 'tradeSign', 'context.previousPrice');
  }
  if (context.previousSign !== undefined && !([-1, 0, 1] as const).includes(context.previousSign)) {
    throw new InputError('tradeSign: context.previousSign must be -1, 0, or 1.', {
      code: ErrorCode.InputOutOfRange,
      context: {
        function: 'tradeSign',
        field: 'context.previousSign',
        value: context.previousSign,
      },
    });
  }
  const { value, method } = classifyTrade(trade, context);
  const warnings: QuantWarning[] = [];
  if (value === 0) {
    warnings.push(
      warning(
        WarningCode.DegenerateInput,
        'tradeSign: the aggressor is indeterminate — no explicit side, and the quote/tick rules could not break the tie.',
        'info',
        { method },
      ),
    );
  }
  return {
    value,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, method },
    diagnostics: { warnings },
  };
}

/** Plain aggressor sign; use `tradeSign.explain(...)` for the resolving rule and diagnostics. */
export const tradeSign = seriesFacade(
  'tradeSign',
  (trade: Trade, context: SignContext = {}): TradeDirection =>
    tradeSignResult(trade, context).value,
  tradeSignResult,
);

// ───────────────────────── cumulative volume delta ─────────────────────────

/** CVD report (Law 2): the aligned series and totals plus conventions and diagnostics. */
export interface CvdResult {
  /** Per-trade signed volume (`sign · size`). */
  delta: number[];
  /** Running cumulative volume delta after each trade. */
  cumulative: number[];
  /** Per-trade aggressor sign (+1 / −1 / 0). */
  sign: number[];
  buyVolume: number;
  sellVolume: number;
  /** Applied conventions, echoed — `method` is the aggressor rule actually used. */
  assumptions: { conventionsVersion: string; method: AggressorMethod };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Streaming, serializable cumulative-volume-delta aggregator — feed it trades (with optional aligned
 * quotes) and it tracks running CVD and buy/sell volume. Mirrors the framework's stream ethos so it
 * can be checkpointed and resumed mid-tape.
 */
export class CvdAggregator {
  private cumulativeSum = 0;
  private previousPrice: number | null = null;
  private previousSign: TradeDirection = 0;
  private readonly method: AggressorMethod;
  buyVolume = 0;
  sellVolume = 0;
  constructor(method: AggressorMethod = 'quote') {
    this.method = requireOneOf(method, AGGRESSOR_METHODS, 'CvdAggregator', 'method');
  }

  /** Process one trade; returns `{ sign, delta, cumulative }` for it. */
  next(trade: Trade, quote?: Quote): { sign: TradeDirection; delta: number; cumulative: number } {
    requireTrade(trade, 'CvdAggregator.next', 'trade');
    if (quote !== undefined) requireQuote(quote, 'CvdAggregator.next', 'quote');
    const context = mkCtx(
      this.previousPrice,
      this.previousSign,
      this.method === 'quote' ? quote : undefined,
    );
    // `method: 'tick'` ignores quotes; `'side'` uses only an explicit side then falls back to tick.
    const sign =
      this.method === 'side' && !trade.side
        ? tradeSignTickOnly(trade, context)
        : classifyTrade(trade, context).value;
    const delta = sign * trade.size;
    const cumulative = this.cumulativeSum + delta;
    const buyVolume = this.buyVolume + (sign > 0 ? trade.size : 0);
    const sellVolume = this.sellVolume + (sign < 0 ? trade.size : 0);
    const result = { sign, delta, cumulative };
    assertFiniteValue('CvdAggregator.next', result);
    assertFiniteValue('CvdAggregator.next', { buyVolume, sellVolume });
    // Commit only after every derived value passes its postcondition; a rejected print must not
    // poison a reusable stream with Infinity.
    this.cumulativeSum = cumulative;
    this.buyVolume = buyVolume;
    this.sellVolume = sellVolume;
    this.previousPrice = trade.price;
    if (sign !== 0) this.previousSign = sign;
    return result;
  }

  get cumulative(): number {
    return this.cumulativeSum;
  }
  /**
   * Serialize as a {@link TechnicalAnalysisSnapshot}, like every other stream in the package.
   *
   * This class used to return a bare `Record<string, unknown>` — no `kind`, no `schemaVersion`, no
   * `state` — so it sat outside the envelope law entirely: its snapshot could not say which
   * aggregator wrote it, could not be version-checked, and lost non-finite numbers to
   * `JSON.stringify` with nothing to notice. The structural gate in `restorer-conformance` is what
   * surfaced it; it was the only serializer in the package building an envelope by hand.
   */
  toJSON(): TechnicalAnalysisSnapshot {
    return snapshotOf('cvdAggregator', {
      method: this.method,
      cumulativeSum: this.cumulativeSum,
      previousPrice: this.previousPrice,
      previousSign: this.previousSign,
      buyVolume: this.buyVolume,
      sellVolume: this.sellVolume,
    });
  }
  static fromJSON(snapshot: TechnicalAnalysisSnapshot): CvdAggregator {
    const state = readSnapshot(snapshot, 'cvdAggregator');
    const x = new CvdAggregator(state.literal<AggressorMethod>('method', AGGRESSOR_METHODS));
    x.cumulativeSum = state.number('cumulativeSum');
    x.previousPrice = state.numberOrNull('previousPrice');
    x.previousSign = state.literal<TradeDirection>('previousSign', TRADE_DIRECTIONS);
    x.buyVolume = state.number('buyVolume');
    x.sellVolume = state.number('sellVolume');
    return x;
  }
}

/** Build a SignContext, omitting `quote` when undefined (exactOptionalPropertyTypes-safe). */
function mkCtx(
  previousPrice: number | null,
  previousSign: TradeDirection,
  quote: Quote | undefined,
): SignContext {
  return quote ? { previousPrice, previousSign, quote } : { previousPrice, previousSign };
}

function tradeSignTickOnly(trade: Trade, context: SignContext): TradeDirection {
  if (context.previousPrice == null) return context.previousSign ?? 0;
  if (trade.price > context.previousPrice) return 1;
  if (trade.price < context.previousPrice) return -1;
  return context.previousSign ?? 0;
}

export interface CvdParameters {
  /** Aggressor inference method. Default `'quote'` (Lee-Ready) when quotes are supplied, else `'tick'`. */
  method?: AggressorMethod;
  /** NBBO quotes aligned 1:1 with `trades` (for the quote rule). */
  quotes?: readonly Quote[];
}
const CVD_PARAMS_KEYS = ['method', 'quotes'] as const;

/** Batch cumulative volume delta over a trade tape. */
export function cumulativeVolumeDelta(
  trades: readonly Trade[],
  parameters: CvdParameters = {},
): CvdResult {
  requireArgumentArray('cumulativeVolumeDelta', 'trades', trades);
  requireTrades(trades, 'cumulativeVolumeDelta');
  requireArgumentObject('cumulativeVolumeDelta', 'parameters', parameters);
  // Law 12: an unknown param (a `quots` typo) teaches instead of being silently ignored.
  ensureKnownKeys('cumulativeVolumeDelta', 'parameters', parameters, CVD_PARAMS_KEYS);
  if (parameters.method !== undefined) {
    requireOneOf(parameters.method, AGGRESSOR_METHODS, 'cumulativeVolumeDelta', 'method');
  }
  if (parameters.quotes !== undefined) {
    requireArgumentArray('cumulativeVolumeDelta', 'quotes', parameters.quotes);
    if (parameters.quotes.length !== trades.length) {
      throw new InputError(
        `cumulativeVolumeDelta: quotes length (${parameters.quotes.length}) must match trades length (${trades.length}) — quotes align 1:1 with prints.`,
        {
          code: ErrorCode.InputLengthMismatch,
          context: { trades: trades.length, quotes: parameters.quotes.length },
        },
      );
    }
    requireQuotes(parameters.quotes, 'cumulativeVolumeDelta');
  }
  const method = parameters.method ?? (parameters.quotes ? 'quote' : 'tick');
  const agg = new CvdAggregator(method);
  const delta: number[] = [];
  const cumulative: number[] = [];
  const sign: number[] = [];
  for (let i = 0; i < trades.length; i++) {
    const r = agg.next(trades[i]!, parameters.quotes?.[i]);
    sign.push(r.sign);
    delta.push(r.delta);
    cumulative.push(r.cumulative);
  }
  const result: CvdResult = {
    delta,
    cumulative,
    sign,
    buyVolume: agg.buyVolume,
    sellVolume: agg.sellVolume,
    assumptions: { conventionsVersion: CONVENTIONS_VERSION, method },
    diagnostics: { warnings: [] },
  };
  assertFiniteValue('cumulativeVolumeDelta', result);
  return result;
}

// ───────────────────────── tick-level volume profile ─────────────────────────

export interface TickVolumeBin {
  /** Bucket lower price bound. */
  low: number;
  /** Bucket upper price bound. */
  high: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  /** `buyVolume − sellVolume` (the footprint delta at this price). */
  delta: number;
  trades: number;
}
/** Tick-profile report (Law 2): the footprint bins and levels plus conventions and diagnostics. */
export interface TickVolumeProfile {
  bins: TickVolumeBin[];
  /** Point of control: price of the highest-volume bucket (its midpoint); null for an empty tape. */
  poc: number | null;
  /** Value-area price bounds holding `valueAreaFraction` of total volume around the POC (nulls when empty). */
  valueArea: { low: number | null; high: number | null };
  totalVolume: number;
  totalDelta: number;
  /** Applied conventions, echoed — the binning mode that WON is non-null (`tickSize` beats `bins`). */
  assumptions: {
    conventionsVersion: string;
    tickSize: number | null;
    bins: number | null;
    valueAreaFraction: number;
    method: AggressorMethod;
  };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

export interface TickVolumeProfileParameters {
  /** Bucket width in price units (e.g. one tick). Mutually exclusive with `bins` (tickSize wins). */
  tickSize?: number;
  /** Number of equal-width buckets between the min and max trade price. Default 50. */
  bins?: number;
  /** Fraction of total volume defining the value area. Default 0.7. */
  valueAreaFraction?: number;
  /** Aggressor method for the buy/sell split. Default `'quote'` if quotes given, else `'tick'`. */
  method?: AggressorMethod;
  quotes?: readonly Quote[];
}
const TICK_VOLUME_PROFILE_KEYS = [
  'tickSize',
  'bins',
  'valueAreaFraction',
  'method',
  'quotes',
] as const;

/**
 * Volume-by-price built from the **actual trade prints** (each trade's full size lands in the bucket
 * of its exact price — no bar-range smearing), with the POC, value area, and a per-price buy/sell
 * delta (footprint). This is the trade-level counterpart to the bar-based `volumeProfile`.
 */
export function tickVolumeProfile(
  trades: readonly Trade[],
  parameters: TickVolumeProfileParameters = {},
): TickVolumeProfile {
  requireArgumentArray('tickVolumeProfile', 'trades', trades);
  requireTrades(trades, 'tickVolumeProfile');
  requireArgumentObject('tickVolumeProfile', 'parameters', parameters);
  // Law 12: an unknown param (a `tikSize` typo) teaches instead of being silently ignored.
  ensureKnownKeys('tickVolumeProfile', 'parameters', parameters, TICK_VOLUME_PROFILE_KEYS);
  ensureFiniteWhenPresent(parameters.valueAreaFraction, 'valueAreaFraction', 'tickVolumeProfile');
  const vaPct = requireInRange(
    parameters.valueAreaFraction ?? 0.7,
    'tickVolumeProfile',
    'valueAreaFraction',
    0,
    1,
  );
  if (parameters.tickSize === null) {
    throw new InputError(
      'tickVolumeProfile: tickSize must not be null — omit the field to bin by count instead. Received null.',
      { code: ErrorCode.InputWrongType, context: { field: 'tickSize' } },
    );
  }
  const tickSize =
    parameters.tickSize != null
      ? requirePositive(parameters.tickSize, 'tickVolumeProfile', 'tickSize')
      : null;
  // A period-style bound (integer ≥ 1): `bins: 0` must throw, not silently become the default.
  ensureFiniteWhenPresent(parameters.bins, 'bins', 'tickVolumeProfile');
  const binsParam =
    tickSize === null ? requirePeriod(parameters.bins ?? 50, 'tickVolumeProfile', 'bins') : null;
  const method =
    parameters.method !== undefined
      ? requireOneOf(parameters.method, AGGRESSOR_METHODS, 'tickVolumeProfile', 'method')
      : parameters.quotes
        ? 'quote'
        : 'tick';
  if (parameters.quotes !== undefined) {
    requireArgumentArray('tickVolumeProfile', 'quotes', parameters.quotes);
    if (parameters.quotes.length !== trades.length) {
      throw new InputError(
        `tickVolumeProfile: quotes length (${parameters.quotes.length}) must match trades length (${trades.length}) — quotes align 1:1 with prints.`,
        {
          code: ErrorCode.InputLengthMismatch,
          context: { trades: trades.length, quotes: parameters.quotes.length },
        },
      );
    }
    requireQuotes(parameters.quotes, 'tickVolumeProfile');
  }
  const assumptions: TickVolumeProfile['assumptions'] = {
    conventionsVersion: CONVENTIONS_VERSION,
    tickSize,
    bins: binsParam,
    valueAreaFraction: vaPct,
    method,
  };
  if (trades.length === 0) {
    // Law 7: an empty tape has no POC/value area — nulls with a reason, never NaN.
    return {
      bins: [],
      poc: null,
      valueArea: { low: null, high: null },
      totalVolume: 0,
      totalDelta: 0,
      assumptions,
      diagnostics: {
        warnings: [
          warning(
            WarningCode.DegenerateInput,
            'tickVolumeProfile: empty trade tape — there is no profile; poc and valueArea are null.',
            'warn',
            { trades: 0 },
          ),
        ],
      },
    };
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (const t of trades) {
    if (t.price < lo) lo = t.price;
    if (t.price > hi) hi = t.price;
  }
  let width: number;
  let binCount: number;
  if (tickSize !== null) {
    width = tickSize;
    binCount = Math.max(1, Math.floor((hi - lo) / width) + 1);
  } else {
    binCount = binsParam!;
    width = (hi - lo) / binCount || 1;
  }
  const bins: TickVolumeBin[] = Array.from({ length: binCount }, (_, i) => ({
    low: lo + i * width,
    high: lo + (i + 1) * width,
    volume: 0,
    buyVolume: 0,
    sellVolume: 0,
    delta: 0,
    trades: 0,
  }));

  let previousPrice: number | null = null;
  let previousSign: TradeDirection = 0;
  let total = 0;
  let totalDelta = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]!;
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor((t.price - lo) / width)));
    const context = mkCtx(
      previousPrice,
      previousSign,
      method === 'quote' ? parameters.quotes?.[i] : undefined,
    );
    const sign =
      method === 'side' && !t.side
        ? tradeSignTickOnly(t, context)
        : classifyTrade(t, context).value;
    previousPrice = t.price;
    if (sign !== 0) previousSign = sign;
    const bin = bins[idx]!;
    bin.volume += t.size;
    bin.trades += 1;
    if (sign > 0) bin.buyVolume += t.size;
    else if (sign < 0) bin.sellVolume += t.size;
    bin.delta = bin.buyVolume - bin.sellVolume;
    total += t.size;
    totalDelta += sign * t.size;
  }

  let pocIdx = 0;
  for (let i = 1; i < bins.length; i++) if (bins[i]!.volume > bins[pocIdx]!.volume) pocIdx = i;
  let valueAreaVolume = bins[pocIdx]!.volume;
  let lowIdx = pocIdx;
  let highIdx = pocIdx;
  const target = total * vaPct;
  while (valueAreaVolume < target && (lowIdx > 0 || highIdx < bins.length - 1)) {
    const below = lowIdx > 0 ? bins[lowIdx - 1]!.volume : -1;
    const above = highIdx < bins.length - 1 ? bins[highIdx + 1]!.volume : -1;
    if (above >= below) valueAreaVolume += bins[++highIdx]!.volume;
    else valueAreaVolume += bins[--lowIdx]!.volume;
  }
  const result: TickVolumeProfile = {
    bins,
    poc: (bins[pocIdx]!.low + bins[pocIdx]!.high) / 2,
    valueArea: { low: bins[lowIdx]!.low, high: bins[highIdx]!.high },
    totalVolume: total,
    totalDelta,
    assumptions,
    diagnostics: { warnings: [] },
  };
  assertFiniteValue('tickVolumeProfile', result);
  return result;
}

// ───────────────────────── order-book analytics ─────────────────────────

export interface BookImbalanceParameters {
  /** Depth levels to aggregate from the top of book. Default = all available. */
  levels?: number;
  /** Weight each level by `1/(1+rank)` so nearer levels dominate. Default false (equal weight). */
  weighted?: boolean;
}
const BOOK_IMBALANCE_PARAMS_KEYS = ['levels', 'weighted'] as const;

/** Book-imbalance envelope (Law 2): the imbalance plus applied conventions and diagnostics. */
export interface BookImbalanceResult {
  /** Imbalance in [−1, 1], or null when the aggregated depth is zero (disclosed in diagnostics). */
  value: number | null;
  /** Applied conventions, echoed — `levels` is the depth actually aggregated. */
  assumptions: { conventionsVersion: string; levels: number; weighted: boolean };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Multi-level order-book imbalance in [−1, 1]: +1 all bid-side depth, −1 all ask-side, 0 balanced.
 * Sums the top `levels` of each side; `weighted` decays deeper levels by `1/(1+rank)`. A book with
 * zero aggregated depth has no imbalance — `value` is null with a diagnostics warning (Law 7).
 */
function bookImbalanceResult(
  book: OrderBook,
  parameters: BookImbalanceParameters = {},
): BookImbalanceResult {
  requireOrderBook(book, 'bookImbalance');
  requireArgumentObject('bookImbalance', 'parameters', parameters);
  ensureKnownKeys('bookImbalance', 'parameters', parameters, BOOK_IMBALANCE_PARAMS_KEYS);
  const n =
    parameters.levels !== undefined
      ? requirePeriod(parameters.levels, 'bookImbalance', 'levels')
      : Math.max(book.bids.length, book.asks.length);
  requireBooleanWhenPresent(parameters.weighted, 'bookImbalance', 'weighted');
  const weighted = parameters.weighted ?? false;
  const w = (rank: number): number => (weighted ? 1 / (1 + rank) : 1);
  let bid = 0;
  let ask = 0;
  for (let i = 0; i < n; i++) {
    if (i < book.bids.length) bid += book.bids[i]!.size * w(i);
    if (i < book.asks.length) ask += book.asks[i]!.size * w(i);
  }
  const total = bid + ask;
  const assumptions = { conventionsVersion: CONVENTIONS_VERSION, levels: n, weighted };
  if (total === 0) {
    return {
      value: null,
      assumptions,
      diagnostics: {
        warnings: [
          warning(
            WarningCode.DegenerateInput,
            'bookImbalance: zero aggregated depth across the requested levels — the imbalance is undefined (null).',
            'warn',
            { levels: n },
          ),
        ],
      },
    };
  }
  return { value: (bid - ask) / total, assumptions, diagnostics: { warnings: [] } };
}

/** Plain imbalance; use `.explain()` for effective depth, weighting, and null diagnostics. */
export const bookImbalance = seriesFacade(
  'bookImbalance',
  (book: OrderBook, parameters: BookImbalanceParameters = {}): number | null =>
    bookImbalanceResult(book, parameters).value,
  bookImbalanceResult,
);

/** Microprice envelope (Law 2): the size-weighted mid plus conventions and diagnostics. */
export interface MicropriceResult {
  /** The size-weighted mid, or null when either side of the book is empty (disclosed). */
  value: number | null;
  /** Applied conventions, echoed (Law 2 grammar). */
  assumptions: { conventionsVersion: string };
  /** Structured warnings; always present (possibly empty). */
  diagnostics: { warnings: QuantWarning[] };
}

/**
 * Size-weighted mid (microprice): `(bestBid·askSize + bestAsk·bidSize) / (bidSize + askSize)`. More
 * size resting on the ask pulls the fair price toward the bid (and vice-versa). Falls back to the
 * arithmetic mid when both top sizes are zero (disclosed via a diagnostics warning); a one-sided or
 * empty book has no microprice — `value` is null with a warning (Law 7).
 */
function micropriceResult(book: OrderBook): MicropriceResult {
  requireOrderBook(book, 'microprice');
  const assumptions = { conventionsVersion: CONVENTIONS_VERSION };
  const bb = book.bids[0];
  const ba = book.asks[0];
  if (!bb || !ba) {
    return {
      value: null,
      assumptions,
      diagnostics: {
        warnings: [
          warning(
            WarningCode.DegenerateInput,
            'microprice: one or both sides of the book are empty — the microprice is undefined (null).',
            'warn',
            { bids: book.bids.length, asks: book.asks.length },
          ),
        ],
      },
    };
  }
  const denom = bb.size + ba.size;
  if (denom === 0) {
    return {
      value: (bb.price + ba.price) / 2,
      assumptions,
      diagnostics: {
        warnings: [
          warning(
            WarningCode.DegenerateInput,
            'microprice: both top-of-book sizes are zero — returned the arithmetic mid instead of the size-weighted mid.',
            'info',
            { bidSize: bb.size, askSize: ba.size },
          ),
        ],
      },
    };
  }
  return {
    value: (bb.price * ba.size + ba.price * bb.size) / denom,
    assumptions,
    diagnostics: { warnings: [] },
  };
}

/** Plain microprice; use `.explain()` for null/fallback diagnostics. */
export const microprice = facade(
  'microprice',
  (book: OrderBook): number | null => micropriceResult(book).value,
  micropriceResult,
);

// ───────────────────────── footprint bars ─────────────────────────

export interface FootprintBar extends BarInput {
  volume: number;
  buyVolume: number;
  sellVolume: number;
  /** `buyVolume − sellVolume`. */
  delta: number;
  trades: number;
  /** Bar start time (epoch ms) if trades carry timestamps. */
  time?: number;
}

export interface FootprintBarParameters {
  /** Aggregation rule and threshold. `by` defaults to `'volume'`. */
  by?: 'count' | 'volume' | 'time';
  /** Trades per bar (`count`), volume per bar (`volume`), or milliseconds per bar (`time`). */
  threshold: number;
  method?: AggressorMethod;
  quotes?: readonly Quote[];
}
const FOOTPRINT_BAR_KEYS = ['by', 'threshold', 'method', 'quotes'] as const;

/**
 * Aggregate a trade tape into OHLCV bars annotated with the aggressor footprint (buy/sell volume and
 * delta), bucketing by trade `count`, cumulative `volume`, or `time`.
 */
export function footprintBars(
  trades: readonly Trade[],
  parameters: FootprintBarParameters,
): FootprintBar[] {
  requireArgumentObject('footprintBars', 'parameters', parameters);
  // Law 12: an unknown param (a `treshold` typo) teaches instead of being silently ignored.
  ensureKnownKeys('footprintBars', 'parameters', parameters, FOOTPRINT_BAR_KEYS);
  requireArgumentArray('footprintBars', 'trades', trades);
  requireTrades(trades, 'footprintBars');
  if (parameters.by === null || parameters.method === null) {
    throw new InputError(
      `footprintBars: ${parameters.by === null ? 'by' : 'method'} must not be null — omit the field to use the default. Received null.`,
      { code: ErrorCode.InputWrongType, context: {} },
    );
  }
  const by = requireOneOf(
    parameters.by ?? 'volume',
    ['count', 'volume', 'time'] as const,
    'footprintBars',
    'by',
  );
  const threshold = requirePositive(parameters.threshold, 'footprintBars', 'threshold');
  // Time bucketing needs timestamps: without them no bar would ever close and the whole tape would
  // silently collapse into one giant bar (design law #4 — no silent degradation). First-element
  // check per the facade law.
  if (by === 'time') {
    const missingTime = trades.findIndex((trade) => trade.time == null);
    if (missingTime >= 0) {
      throw new InputError(
        `footprintBars: by: 'time' needs every trade to carry a \`time\` field (epoch ms); trades[${missingTime}] does not.`,
        { code: ErrorCode.InputMissingField, context: { by, index: missingTime } },
      );
    }
    for (let i = 1; i < trades.length; i++) {
      if (trades[i]!.time! < trades[i - 1]!.time!) {
        throw new InputError(
          `footprintBars: trades must be ordered by non-decreasing time; trades[${i}] is earlier than trades[${i - 1}].`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: 'footprintBars', field: 'trades', index: i },
          },
        );
      }
    }
  }
  const method = requireOneOf(
    parameters.method ?? (parameters.quotes ? 'quote' : 'tick'),
    AGGRESSOR_METHODS,
    'footprintBars',
    'method',
  );
  if (parameters.quotes !== undefined) {
    requireArgumentArray('footprintBars', 'quotes', parameters.quotes);
    if (parameters.quotes.length !== trades.length) {
      throw new InputError(
        `footprintBars: quotes length (${parameters.quotes.length}) must match trades length (${trades.length}) — quotes align 1:1 with prints.`,
        {
          code: ErrorCode.InputLengthMismatch,
          context: { trades: trades.length, quotes: parameters.quotes.length },
        },
      );
    }
    requireQuotes(parameters.quotes, 'footprintBars');
  }
  const out: FootprintBar[] = [];
  let cur: FootprintBar | null = null;
  let acc = 0;
  let barStartTime: number | undefined;
  let previousPrice: number | null = null;
  let previousSign: TradeDirection = 0;

  const flush = (): void => {
    if (cur) out.push(cur);
    cur = null;
    acc = 0;
  };

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]!;
    if (
      by === 'time' &&
      cur &&
      t.time != null &&
      barStartTime != null &&
      t.time - barStartTime >= threshold
    ) {
      flush();
    }
    if (!cur) {
      cur = {
        open: t.price,
        high: t.price,
        low: t.price,
        close: t.price,
        volume: 0,
        buyVolume: 0,
        sellVolume: 0,
        delta: 0,
        trades: 0,
        ...(t.time != null ? { time: t.time } : {}),
      };
      barStartTime = t.time;
    }
    const bar = cur!; // stable non-null reference (cur may be nulled by `flush` in the closure)
    const context = mkCtx(
      previousPrice,
      previousSign,
      method === 'quote' ? parameters.quotes?.[i] : undefined,
    );
    const sign =
      method === 'side' && !t.side
        ? tradeSignTickOnly(t, context)
        : classifyTrade(t, context).value;
    previousPrice = t.price;
    if (sign !== 0) previousSign = sign;
    bar.high = Math.max(bar.high, t.price);
    bar.low = Math.min(bar.low, t.price);
    bar.close = t.price;
    bar.volume += t.size;
    bar.trades += 1;
    if (sign > 0) bar.buyVolume += t.size;
    else if (sign < 0) bar.sellVolume += t.size;
    bar.delta = bar.buyVolume - bar.sellVolume;
    acc += by === 'count' ? 1 : by === 'volume' ? t.size : 0;
    if ((by === 'count' || by === 'volume') && acc >= threshold) flush();
  }
  flush();
  assertFiniteValue('footprintBars', out);
  return out;
}
