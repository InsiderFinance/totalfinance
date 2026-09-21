/**
 * Canonical market-data contracts (spec §7.6). Pure types — plus one tiny quote-price selector and
 * the ONE `RateCurve` data validator shared by the Gate B snapshot spine and the Gate C pricing
 * protocol (both consume stored curves as plain data, so both must refuse the same malformations).
 */

import type { OptionContract } from './contracts.js';
import { discountFactor, isoDateToEpochMs, yearFraction } from './dates.js';
import { ErrorCode, InputError } from './errors.js';
import type { InterestCompounding, DayCount, EpochMs } from './time.js';

export type SymbolId = string;

export interface Bar {
  symbol: SymbolId;
  timestampMs: EpochMs;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  vwap?: number;
  adjusted?: boolean;
}

export interface Quote {
  symbol: SymbolId;
  timestampMs: EpochMs;
  bid: number;
  ask: number;
  bidSize?: number;
  askSize?: number;
  exchange?: string;
  conditions?: string[];
}

export interface Trade {
  symbol: SymbolId;
  timestampMs: EpochMs;
  price: number;
  size: number;
  exchange?: string;
  conditions?: string[];
  sequence?: number;
}

/** Who produced a chain row's Greeks, with what, and when. */
export interface OptionQuoteGreeksProvenance {
  /** The provider or model that produced them, e.g. `'vendor-feed-v2'` or `'chainGreeks'`. */
  source: string;
  /** The pricing model behind them when known, e.g. `'black-scholes-merton'`. */
  model?: string;
  /** When the Greeks were observed or computed (epoch ms). */
  timestampMs?: EpochMs;
}

/**
 * Per-share Greeks on a chain row, in TotalFinance display units: `delta` per $1 of spot, `gamma` per
 * $1², `theta` per calendar day, `vega` per volatility point, `rho` per 1% rate. A vendor feed may
 * supply `delta` alone; `chainGreeks` stamps the full set with its provenance.
 */
export interface OptionQuoteGreeks {
  delta: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  provenance?: OptionQuoteGreeksProvenance;
}

export interface OptionQuote {
  contract: OptionContract;
  timestampMs: EpochMs;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  mid?: number;
  last?: number;
  mark?: number;
  volume?: number;
  openInterest?: number;
  underlyingPrice?: number;
  impliedVolatility?: number;
  /** Per-share Greeks in display units, when the source (or `chainGreeks`) supplied them. */
  greeks?: OptionQuoteGreeks;
  exchange?: string;
  conditions?: string[];
}

export interface OptionTrade extends OptionQuote {
  price: number;
  size: number;
  sequence?: number;
  aggressorSide?: 'buy' | 'sell' | 'unknown';
  premium?: number;
  notional?: number;
  openingLikely?: boolean;
}

export interface Dividend {
  symbol: SymbolId;
  exDate: string;
  payDate?: string;
  amount: number;
  currency?: string;
  type?: 'regular' | 'special' | 'returnOfCapital' | 'unknown';
}

export interface CorporateAction {
  symbol: SymbolId;
  effectiveDate: string;
  type: 'split' | 'reverseSplit' | 'dividend' | 'symbolChange' | 'merger' | 'spinoff' | 'other';
  ratio?: number;
  cash?: number;
  newSymbol?: string;
  details?: Record<string, unknown>;
}

/**
 * One curve pillar: a `'YYYY-MM-DD'` date and the ZERO RATE quoted there, as a decimal, under the
 * owning curve's own `compounding`/`dayCount`. The field is `zeroRate` — not a generic `rate` —
 * because that is exactly what TotalFinance consumers evaluate (`curves.fromZeroRates` semantics):
 * every discount factor is DERIVED from this rate through the curve's compounding transform.
 *
 * There is deliberately no `discountFactor` member (removed 2026-08-23, second external review):
 * two answers to "what discounts this pillar?" on one pillar can contradict each other, and the
 * old advisory field did — sign-consistency let `zeroRate: 0.05` sit beside `discountFactor: 0.2`.
 * Discount-factor-quoted data has its own constructor (`curves.fromDiscountFactors`), whose
 * pillars carry no rates. Entries stay open to vendor decoration (Law 12).
 */
export interface RateCurvePoint {
  date: string;
  zeroRate: number;
}

export interface RateCurve {
  currency: string;
  asOf: EpochMs;
  dayCount: DayCount;
  compounding: InterestCompounding;
  points: RateCurvePoint[];
  interpolation?: string;
}

const RATE_CURVE_DAY_COUNTS: readonly DayCount[] = ['ACT/365F', 'ACT/360', '30/360'];

function isValidCompounding(value: unknown): boolean {
  if (
    value === 'simple' ||
    value === 'continuous' ||
    value === 'annual' ||
    value === 'semiannual' ||
    value === 'quarterly' ||
    value === 'monthly'
  )
    return true;
  if (
    value !== null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'periodic'
  ) {
    const periods = (value as { periodsPerYear?: unknown }).periodsPerYear;
    return typeof periods === 'number' && Number.isFinite(periods) && periods > 0;
  }
  return false;
}

function curveError(
  functionName: string,
  message: string,
  code: ErrorCode,
  context: Record<string, unknown>,
): InputError {
  return new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, ...context },
  });
}

/**
 * The ONE full validator for a stored/observed {@link RateCurve} as PLAIN DATA — shared by the
 * Gate B market-snapshot spine (`observations.curves`) and the Gate C pricing protocol (the
 * `discountCurve` observation value), so both refuse the same malformed curves with the same
 * teaching. Core-internal on purpose: it is validation plumbing, not analysis API.
 *
 * Checks: `currency` a non-empty string; `asOf` finite epoch ms; `dayCount`/`compounding` valid
 * conventions (a curve states its own — no silent economics); `points` an array of AT LEAST ONE
 * pillar (an empty curve discounts nothing — a consumer handed zero pillars has no discount
 * function, so emptiness is refused here rather than downstream) whose entries have a REAL
 * `'YYYY-MM-DD'` calendar date (parsed with core's date parser, so `'2025-02-30'` is refused),
 * strictly ascending pillar dates, dates at or after the curve's own `asOf` (a pillar BEFORE the
 * curve's valuation instant discounts into the past — no consumer has a meaning for it; a pillar
 * exactly AT `asOf` is the legal t = 0 anchor), and a finite `zeroRate` whose discount factor is
 * actually computable and representable under the curve's compounding at that pillar's tenor;
 * `interpolation` a non-empty string when present (the declared type). Entries stay open (Law 12):
 * vendor decoration is preserved, not enumerated here.
 *
 * **Pillar authority — `zeroRate` is the ONE datum (2026-08-23, second external review).** The
 * semantics are the existing fixed-income consumer's: `curves.fromZeroRates(...)` consumes ZERO
 * RATES quoted under the curve's own `compounding`/`dayCount` and DERIVES every discount factor
 * through that compounding transform. The former advisory `discountFactor` pillar member is GONE:
 * a second, potentially contradictory answer must not share a pillar (the old sign-consistency
 * tolerance accepted `rate: 0.05` beside `discountFactor: 0.2`), and no consumer in the workspace
 * ever read it — discount-factor-quoted data has its own constructor
 * (`curves.fromDiscountFactors`), whose pillars carry no rates. What replaced the tolerance is a
 * REAL economics check through core's own transform (`discountFactor` in `dates.ts` — the one
 * compounding engine, not a second one): every pillar's derived discount factor must exist and be
 * a positive finite number, so `zeroRate: -2` under annual compounding (growth factor
 * `1 + r/m ≤ 0` — no real discount factor exists) and rate/tenor pairs whose factor overflows,
 * underflows to zero, or goes negative are refused with the arithmetic named.
 */
export function requireRateCurveData(
  functionName: string,
  path: string,
  value: unknown,
): RateCurve {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw curveError(
      functionName,
      `${path} must be a RateCurve data object ({ currency, asOf, dayCount, compounding, points }). Received ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}.\n  e.g. { currency: 'USD', asOf: 1784505600000, dayCount: 'ACT/365F', compounding: 'continuous', points: [{ date: '2027-07-20', zeroRate: 0.045 }] }`,
      ErrorCode.InputWrongType,
      { field: path },
    );
  }
  const curve = value as Partial<RateCurve> & Record<string, unknown>;
  if (typeof curve.currency !== 'string' || curve.currency.length === 0) {
    throw curveError(
      functionName,
      `${path}.currency must be a currency code string.`,
      ErrorCode.InputWrongType,
      { field: `${path}.currency` },
    );
  }
  if (typeof curve.asOf !== 'number' || !Number.isFinite(curve.asOf)) {
    throw curveError(
      functionName,
      `${path}.asOf must be finite epoch milliseconds. Received ${typeof curve.asOf === 'number' ? curve.asOf : curve.asOf === null ? 'null' : typeof curve.asOf}.`,
      typeof curve.asOf === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
      { field: `${path}.asOf` },
    );
  }
  if (
    typeof curve.dayCount !== 'string' ||
    !(RATE_CURVE_DAY_COUNTS as readonly string[]).includes(curve.dayCount)
  ) {
    throw curveError(
      functionName,
      `${path}.dayCount must be one of ${RATE_CURVE_DAY_COUNTS.join(', ')} — a curve states its own conventions. Received ${JSON.stringify(curve.dayCount)}.`,
      ErrorCode.InputInvalidEnum,
      { field: `${path}.dayCount`, value: curve.dayCount },
    );
  }
  if (!isValidCompounding(curve.compounding)) {
    throw curveError(
      functionName,
      `${path}.compounding must state the curve's compounding convention: 'simple' | 'continuous' | 'annual' | 'semiannual' | 'quarterly' | 'monthly' or { type: 'periodic', periodsPerYear }.`,
      ErrorCode.InputInvalidEnum,
      { field: `${path}.compounding` },
    );
  }
  if (!Array.isArray(curve.points)) {
    throw curveError(
      functionName,
      `${path}.points must be an array of { date, zeroRate } pillar points.`,
      ErrorCode.InputWrongType,
      { field: `${path}.points` },
    );
  }
  if (curve.points.length === 0) {
    throw curveError(
      functionName,
      `${path}.points must contain at least one pillar — an empty curve discounts nothing, and a consumer handed it would have no discount function to evaluate.\n  e.g. points: [{ date: '2027-07-20', zeroRate: 0.045 }]`,
      ErrorCode.InputOutOfRange,
      { field: `${path}.points` },
    );
  }
  let previousDateMs: number | undefined;
  let previousDate: string | undefined;
  for (let i = 0; i < curve.points.length; i++) {
    const point = curve.points[i] as Partial<RateCurvePoint> | null;
    if (point === null || typeof point !== 'object' || Array.isArray(point)) {
      throw curveError(
        functionName,
        `${path}.points[${i}] must be a { date, zeroRate } object.`,
        ErrorCode.InputWrongType,
        { field: `${path}.points[${i}]` },
      );
    }
    if (typeof point.date !== 'string') {
      throw curveError(
        functionName,
        `${path}.points[${i}].date must be a 'YYYY-MM-DD' string. Received ${point.date === null ? 'null' : typeof point.date}.`,
        ErrorCode.InputWrongType,
        { field: `${path}.points[${i}].date` },
      );
    }
    let dateMs: number;
    try {
      dateMs = isoDateToEpochMs(point.date);
    } catch (error) {
      throw curveError(
        functionName,
        `${path}.points[${i}].date is not a real calendar date: ${error instanceof Error ? error.message : String(error)}`,
        ErrorCode.InputOutOfRange,
        { field: `${path}.points[${i}].date`, value: point.date },
      );
    }
    if (previousDateMs !== undefined && dateMs <= previousDateMs) {
      throw curveError(
        functionName,
        `${path}.points must be strictly ascending by date — points[${i}].date '${point.date}' does not follow points[${i - 1}].date '${previousDate}'. Sort the pillars and remove duplicates.`,
        ErrorCode.InputOutOfRange,
        { field: `${path}.points[${i}].date`, previous: previousDate, value: point.date },
      );
    }
    previousDateMs = dateMs;
    previousDate = point.date;
    // A pillar strictly before the curve's own valuation instant discounts into the past — no
    // consumer has a meaning for it (2026-08-23, second external review). A pillar exactly AT
    // asOf is legal: it is the t = 0 anchor, and its discount factor is 1 by construction.
    if (dateMs < curve.asOf) {
      throw curveError(
        functionName,
        `${path}.points[${i}].date '${point.date}' is before the curve's asOf (${curve.asOf} epoch ms) — a curve discounts FORWARD from its valuation instant, so every pillar must be at or after asOf (a pillar exactly at asOf is the legal t = 0 anchor). Drop the stale pillar or fix asOf.`,
        ErrorCode.InputOutOfRange,
        { field: `${path}.points[${i}].date`, value: point.date, asOf: curve.asOf },
      );
    }
    if (typeof point.zeroRate !== 'number' || !Number.isFinite(point.zeroRate)) {
      throw curveError(
        functionName,
        `${path}.points[${i}].zeroRate must be a finite decimal zero rate quoted under the curve's own compounding/dayCount (e.g. 0.045 for 4.5%). Received ${typeof point.zeroRate === 'number' ? point.zeroRate : point.zeroRate === null ? 'null' : typeof point.zeroRate}.`,
        typeof point.zeroRate === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
        { field: `${path}.points[${i}].zeroRate` },
      );
    }
    // Economic validity: the pillar's discount factor must EXIST under the curve's own conventions
    // (2026-08-23, second external review — the old advisory-field sign check accepted quotes no
    // convention can discount). Derived through core's ONE compounding transform, never a second
    // engine: `discountFactor(zeroRate, t, compounding)` refuses a periodic growth factor
    // `1 + zeroRate/m ≤ 0` itself, and the result must be a positive finite number — an overflow
    // to Infinity, an underflow to 0, or a negative factor is a quote nothing downstream can use.
    const tenorYears = yearFraction(curve.asOf, dateMs, curve.dayCount as DayCount);
    let pillarDiscountFactor: number;
    try {
      pillarDiscountFactor = discountFactor(
        point.zeroRate,
        tenorYears,
        curve.compounding as InterestCompounding,
      );
    } catch (error) {
      throw curveError(
        functionName,
        `${path}.points[${i}].zeroRate ${point.zeroRate} has no real discount factor under compounding ${JSON.stringify(curve.compounding)}: ${error instanceof Error ? error.message : String(error)}\n  e.g. under 'annual' compounding the zero rate must stay above -1 (-100%), like { date: '${point.date}', zeroRate: -0.02 }.`,
        ErrorCode.InputOutOfRange,
        { field: `${path}.points[${i}].zeroRate`, value: point.zeroRate, tenorYears },
      );
    }
    if (!Number.isFinite(pillarDiscountFactor) || pillarDiscountFactor <= 0) {
      throw curveError(
        functionName,
        `${path}.points[${i}].zeroRate ${point.zeroRate} yields discount factor ${pillarDiscountFactor} at tenor ${tenorYears} years under compounding ${JSON.stringify(curve.compounding)} — a pillar's discount factor must be a positive finite number, so this quote cannot discount anything. Fix the rate's sign/magnitude or the pillar date.\n  e.g. { date: '${point.date}', zeroRate: 0.045 }.`,
        ErrorCode.InputOutOfRange,
        {
          field: `${path}.points[${i}].zeroRate`,
          value: point.zeroRate,
          tenorYears,
          discountFactor: pillarDiscountFactor,
        },
      );
    }
  }
  if (
    curve.interpolation !== undefined &&
    (typeof curve.interpolation !== 'string' || curve.interpolation.length === 0)
  ) {
    throw curveError(
      functionName,
      `${path}.interpolation must be an interpolation-name string when present (e.g. 'linearZero'). Received ${curve.interpolation === null ? 'null' : typeof curve.interpolation === 'string' ? "''" : typeof curve.interpolation}.`,
      ErrorCode.InputWrongType,
      { field: `${path}.interpolation` },
    );
  }
  return value as RateCurve;
}

export interface OrderBookLevel {
  price: number;
  size: number;
  exchange?: string;
}

export interface OrderBook {
  symbol: SymbolId;
  timestampMs: EpochMs;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

/**
 * The RAW provider-fundamentals record — an explicitly raw/open DATA-EDGE artifact (FC0). A
 * vendor's untyped field bag survives ONLY here; compute functions never read `fields`. Typed
 * analysis attaches to `@totalfinance/fundamentals`' `FundamentalPeriod` declarations, and a data
 * adapter's job is to map one of these raw records into them with the availability instant
 * carried honestly. (Relocation-by-rename of the former generic `Fundamentals`, pre-1.0, no
 * alias.)
 */
export interface RawFundamentalsRecord {
  symbol: SymbolId;
  /** Vendor's own period label, verbatim (e.g. `'Q1 2026'`, `'FY25'`). */
  fiscalPeriod?: string;
  /** When the vendor says the record is as-of, when known. */
  asOf?: EpochMs;
  /** The vendor's untyped field bag — data-edge only, never a compute input. */
  fields: Record<string, number | string | null>;
}

/**
 * The canonical market snapshot every pricing/analytics entrypoint takes (spec §5.3 / WS3.2). One
 * shape, one vocabulary: `spot`, `rate`, optional `dividendYield` (default 0), and the `asOf` the
 * snapshot is valid for. Package-specific markets EXTEND this and add their own fields (options adds
 * `forward`/`volatility`/quotes; structure/vol pair it with a separate `config`), so the same word
 * always means the same thing across the workspace.
 */
export interface MarketInputs {
  spot: number;
  riskFreeRate: number;
  /** Continuous dividend yield; defaults to 0 when omitted. */
  dividendYield?: number;
  /**
   * Snapshot time: epoch ms, `'YYYY-MM-DD'`, or a ZONED ISO datetime — one grammar for "when"
   * across every package. Each boundary resolves it once via core `resolveAsOf` (zone-less
   * datetimes are rejected with a teaching error; TotalFinance never reads the machine clock or zone).
   */
  asOf: EpochMs | string;
}

/** Price-source selection for quotes (spec §9.5 bid/ask/mid selection). */
export type PriceSource = 'bid' | 'ask' | 'mid' | 'last' | 'mark';

/**
 * Resolve a single price from an option quote per the requested source. Returns `undefined` when
 * the requested fields are absent. `mid` falls back to (bid+ask)/2 when an explicit mid is missing.
 * An unknown `source` is a typed error, never a silent `undefined` — "field absent" and "you typed
 * `'midd'`" must not be the same answer.
 */
export function selectQuotePrice(quote: OptionQuote, source: PriceSource): number | undefined {
  // "Field absent" (undefined) and "field null" are different answers: absent means the venue
  // did not publish it; null is a wrong-typed value that would flow into (bid+ask)/2 as zero.
  for (const field of ['bid', 'ask', 'mid', 'last', 'mark'] as const) {
    const v = quote?.[field];
    if (v !== undefined && (typeof v !== 'number' || Number.isNaN(v))) {
      throw new InputError(
        `selectQuotePrice: quote.${field} must be a number when present. Received ${v === null ? 'null' : typeof v}.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
  switch (source) {
    case 'bid':
      return quote.bid;
    case 'ask':
      return quote.ask;
    case 'last':
      return quote.last;
    case 'mark':
      return quote.mark;
    case 'mid':
      if (quote.mid !== undefined) return quote.mid;
      if (quote.bid !== undefined && quote.ask !== undefined) return (quote.bid + quote.ask) / 2;
      return undefined;
  }
  throw new InputError(
    `selectQuotePrice: source must be one of 'bid', 'ask', 'mid', 'last', 'mark'; got ${JSON.stringify(source)}.`,
    {
      code: ErrorCode.InputInvalidEnum,
      context: { function: 'selectQuotePrice', field: 'source', value: source },
    },
  );
}
