/** Raw option trade-premium accounting; NOT dealer hedging drift, delta weighting, or P&L. */
import {
  type Calendar,
  type Computed,
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  type OptionTrade,
  type OptionType,
  type Quote,
  type Trade,
  WarningCode,
  ensureFinite,
  ensureFiniteWhenPresent,
  ensureKnownKeys,
  ensureNonNegative,
  ensurePositive,
  isoDateToEpochMs,
  optionExpiryToMs,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
  warning,
} from '@totalfinance/core';
import { NYSE, requireCalendar } from '@totalfinance/calendars';
import {
  type AggressorSide,
  type FlowClassificationProvenance,
  type FlowClassificationSource,
} from './flow.js';
import { classifyPrint, requireClassificationSource } from './flow-print.js';

/** Canonical epoch-ms print, optionally carrying a caller-normalized, tape-wide unique ID. */
export interface OptionFlowDriftTrade extends OptionTrade {
  /** Repeated IDs fail, even across symbols. Namespace provider/venue IDs before combining feeds. */
  id?: string;
}

export interface OptionFlowDriftSession {
  /** Explicit ISO YYYY-MM-DD in the calendar's timezone; never inferred from the tape. */
  date: string;
  /** Default NYSE. Accepts core Calendar or calendars.TradingCalendar, including half-days. */
  calendar?: Calendar;
}

export interface OptionFlowPriceOverlay {
  /** Required for an explicit overlay, especially in marketwide mode. Exact, case-sensitive. */
  symbol: string;
  /** Contemporaneously available quotes; non-crossed, positive bid/ask midpoint is used. */
  quotes?: readonly Quote[];
  /** Contemporaneously available underlying trades; use their price, not an option price. */
  trades?: readonly Trade[];
}

export interface OptionFlowDriftConfig {
  /** Omit to aggregate all underlyings. Exact, case-sensitive match. */
  symbol?: string;
  /** Defaults to the scoped symbol's OptionTrade.underlyingPrice; marketwide defaults to no overlay. */
  priceOverlay?: OptionFlowPriceOverlay;
  /** Additional open-anchored bucket width, integer minutes in [1, 1440]. Default 5. */
  bucketMinutes?: number;
  /** Exclusive epoch-ms cutoff; no trade, overlay observation, or bucket at/after this instant. */
  asOf?: number;
  /** Default provided-first: authoritative unknown stays unknown; only absent labels use quotes. */
  classificationSource?: FlowClassificationSource;
  /** Fallback when contract.multiplier is absent. Default 100; supplied premium always wins. */
  multiplier?: number;
  /** Premium classification coverage below this suppresses directional heuristics. Default 0.6. */
  minimumClassificationCoverage?: number;
}

export interface OptionFlowDriftInput {
  trades: readonly OptionFlowDriftTrade[];
  session: OptionFlowDriftSession;
  config?: OptionFlowDriftConfig;
}

/** Descriptive sign agreement, NOT evidence of predictive power. */
export type OptionFlowVolumeConfirmation = 'aligned' | 'opposed' | 'none';
export type OptionFlowDriftHeuristic =
  | 'no-signal'
  | 'low-coverage'
  | 'volume-opposed'
  | 'bullish-expansion'
  | 'bearish-expansion'
  | 'mixed-flow';

/** All premiums are raw currency amounts; all volumes are contract counts (not shares). */
export interface OptionFlowDriftTotals {
  callBuyPremium: number;
  callSellPremium: number;
  putBuyPremium: number;
  putSellPremium: number;
  callUnknownPremium: number;
  putUnknownPremium: number;
  callPremium: number;
  putPremium: number;
  bullishPremium: number;
  bearishPremium: number;
  classifiedPremium: number;
  unknownPremium: number;
  totalPremium: number;
  /** Call buys minus call sells. */
  callDrift: number;
  /** Put buys minus put sells (positive put drift is bearish in the directional mapping). */
  putDrift: number;
  /** callDrift - putDrift. No delta, gamma, charm, vanna, or income projection. */
  netDirectionalDrift: number;
  /** Worst-case sign-assignment bounds from unknown premium, NOT confidence intervals. */
  callBounds: [number, number];
  putBounds: [number, number];
  netDirectionalBounds: [number, number];
  /** classifiedPremium / totalPremium; null at zero premium. NOT a probability. */
  classificationCoverage: number | null;
  bullishVolume: number;
  bearishVolume: number;
  unknownVolume: number;
  totalVolume: number;
  netDirectionalVolume: number;
  tradeCount: number;
  classifiedTradeCount: number;
  unknownTradeCount: number;
  volumeConfirmation: OptionFlowVolumeConfirmation;
  /** Same-window premium/volume rule. See the function's documentation for precedence. */
  heuristic: OptionFlowDriftHeuristic;
}

export interface OptionFlowDriftPrint {
  id: string | null;
  /** Position in the original input tape; ties preserve that order. */
  inputIndex: number;
  timestampMs: number;
  underlying: string;
  type: OptionType;
  side: AggressorSide;
  classificationProvenance: FlowClassificationProvenance;
  premium: number;
  premiumSource: 'provided' | 'price-size-multiplier';
  multiplier: number;
  contracts: number;
  directionalPremium: number;
}

export interface OptionFlowDriftPrice {
  symbol: string;
  price: number;
  timestampMs: number;
  source: 'option-trade-underlying' | 'underlying-quote-midpoint' | 'underlying-trade';
}

export interface OptionFlowDriftBucket {
  /** Interval [startTimestampMs, endTimestampMs); values become available at its END. */
  startTimestampMs: number;
  endTimestampMs: number;
  /** True only for the final cutoff-shortened interval, not a calendar-shortened closing bucket. */
  partial: boolean;
  change: OptionFlowDriftTotals;
  cumulative: OptionFlowDriftTotals;
  /** Latest in-session observation strictly before endTimestampMs; never backfilled. */
  price: OptionFlowDriftPrice | null;
  trades: OptionFlowDriftPrint[];
}

export interface OptionFlowDriftValue {
  session: {
    date: string;
    isBusinessDay: boolean;
    isHalfDay: boolean;
    openTimestampMs: number | null;
    closeTimestampMs: number | null;
    /** Effective exclusive cutoff, clamped to this session; null on closed dates. */
    endTimestampMs: number | null;
  };
  /** All elapsed session minutes, including leading/interior/trailing empties. */
  minutes: OptionFlowDriftBucket[];
  /** The same tape aggregated into config.bucketMinutes intervals. */
  buckets: OptionFlowDriftBucket[];
  summary: OptionFlowDriftTotals;
}

export type OptionFlowDriftAssumptions = {
  timezone: string;
  sessionDate: string;
  symbol: string | null;
  priceOverlaySymbol: string | null;
  bucketMinutes: number;
  classificationSource: FlowClassificationSource;
  multiplier: number;
  minimumClassificationCoverage: number;
  premiumRule: 'provided-else-price-times-size-times-multiplier';
  unknownPolicy: 'zero-drift-full-premium-bounds';
  interval: '[open,min(close,asOf))';
  priceRule: 'in-session-latest-before-bucket-end-no-backfill';
  priceTieBreak: 'underlying-trade-then-quote-then-option-trade-last-input';
  orderPolicy: 'stable-timestamp-sort';
  duplicatePolicy: 'reject-id-or-identical-idless-print';
  coverageMeaning: 'classified-premium-share-not-probability';
  heuristicRule: 'empty-low-coverage-volume-opposed-expansion-mixed';
};

export type OptionFlowDriftResult = Computed<OptionFlowDriftValue, OptionFlowDriftAssumptions>;

const FN = 'optionFlowDrift';
const MINUTE = 60_000;
const DAY = 86_400_000;

function invalid(field: string, message: string, code: string = ErrorCode.InputOutOfRange): never {
  throw new InputError(`${FN}: ${field} ${message}`, { code, context: { function: FN, field } });
}

function requireSymbol(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(field, 'must be a non-empty symbol string.', ErrorCode.InputWrongType);
  }
}

function requireTimestamp(value: number, field: string): void {
  if (value === undefined)
    invalid(field, 'is required in epoch milliseconds.', ErrorCode.InputMissingField);
  ensureFiniteWhenPresent(value, field, FN);
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8.64e15) {
    invalid(
      field,
      'must be representable integer epoch milliseconds (not seconds or a date string).',
    );
  }
}

/** Resolve a calendar's local boundary without using the host timezone or guessing a DST fold. */
function boundary(
  dateMs: number,
  clock: string | undefined,
  timezone: string,
  field: string,
): number {
  if (
    typeof clock !== 'string' ||
    (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock) &&
      !(field === 'calendar.session.close' && clock === '24:00'))
  ) {
    invalid(field, 'must be HH:MM (close also accepts 24:00).', ErrorCode.InputWrongType);
  }
  const wall = dateMs + (Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3))) * MINUTE;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
  } catch {
    invalid('calendar.timezone', 'must be a supported IANA timezone.', ErrorCode.InputWrongType);
  }
  const offsetAt = (ms: number): number => {
    const name = formatter
      .formatToParts(new Date(ms))
      .find((p) => p.type === 'timeZoneName')?.value;
    if (name === 'GMT') return 0;
    const parts = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name ?? '');
    if (!parts) invalid('calendar.timezone', 'could not resolve its UTC offset.');
    return (
      (parts[1] === '-' ? -1 : 1) *
      (Number(parts[2]) * 3_600_000 + Number(parts[3]) * MINUTE + Number(parts[4] ?? 0) * 1000)
    );
  };
  const offsets = new Set([-36, 0, 36].map((hours) => offsetAt(wall + hours * 3_600_000)));
  const candidates = [...offsets]
    .map((offset) => wall - offset)
    .filter((ms) => ms + offsetAt(ms) === wall);
  if (candidates.length !== 1)
    invalid(field, 'is ambiguous or nonexistent in the calendar timezone (DST transition).');
  return candidates[0]!;
}

interface Accumulator {
  callBuyPremium: number;
  callSellPremium: number;
  putBuyPremium: number;
  putSellPremium: number;
  callUnknownPremium: number;
  putUnknownPremium: number;
  bullishVolume: number;
  bearishVolume: number;
  unknownVolume: number;
  tradeCount: number;
  classifiedTradeCount: number;
}

function empty(): Accumulator {
  return {
    callBuyPremium: 0,
    callSellPremium: 0,
    putBuyPremium: 0,
    putSellPremium: 0,
    callUnknownPremium: 0,
    putUnknownPremium: 0,
    bullishVolume: 0,
    bearishVolume: 0,
    unknownVolume: 0,
    tradeCount: 0,
    classifiedTradeCount: 0,
  };
}

function add(acc: Accumulator, print: OptionFlowDriftPrint): void {
  const call = print.type === 'call';
  if (print.side === 'unknown') {
    if (call) acc.callUnknownPremium += print.premium;
    else acc.putUnknownPremium += print.premium;
    acc.unknownVolume += print.contracts;
  } else {
    if (call && print.side === 'buy') acc.callBuyPremium += print.premium;
    else if (call) acc.callSellPremium += print.premium;
    else if (print.side === 'buy') acc.putBuyPremium += print.premium;
    else acc.putSellPremium += print.premium;
    if (call === (print.side === 'buy')) acc.bullishVolume += print.contracts;
    else acc.bearishVolume += print.contracts;
    acc.classifiedTradeCount++;
  }
  acc.tradeCount++;
}

function totals(acc: Accumulator, threshold: number): OptionFlowDriftTotals {
  const callPremium = acc.callBuyPremium + acc.callSellPremium + acc.callUnknownPremium;
  const putPremium = acc.putBuyPremium + acc.putSellPremium + acc.putUnknownPremium;
  const bullishPremium = acc.callBuyPremium + acc.putSellPremium;
  const bearishPremium = acc.putBuyPremium + acc.callSellPremium;
  const classifiedPremium = bullishPremium + bearishPremium;
  const unknownPremium = acc.callUnknownPremium + acc.putUnknownPremium;
  const totalPremium = classifiedPremium + unknownPremium;
  const callDrift = acc.callBuyPremium - acc.callSellPremium;
  const putDrift = acc.putBuyPremium - acc.putSellPremium;
  const netDirectionalDrift = callDrift - putDrift;
  const netDirectionalVolume = acc.bullishVolume - acc.bearishVolume;
  const classificationCoverage = totalPremium > 0 ? classifiedPremium / totalPremium : null;
  const volumeConfirmation: OptionFlowVolumeConfirmation =
    netDirectionalDrift === 0 || netDirectionalVolume === 0
      ? 'none'
      : Math.sign(netDirectionalDrift) === Math.sign(netDirectionalVolume)
        ? 'aligned'
        : 'opposed';
  const heuristic: OptionFlowDriftHeuristic =
    acc.tradeCount === 0 || totalPremium === 0
      ? 'no-signal'
      : classificationCoverage! < threshold
        ? 'low-coverage'
        : volumeConfirmation === 'opposed'
          ? 'volume-opposed'
          : callDrift > 0 && putDrift < 0
            ? 'bullish-expansion'
            : callDrift < 0 && putDrift > 0
              ? 'bearish-expansion'
              : netDirectionalDrift !== 0
                ? 'mixed-flow'
                : 'no-signal';
  const result: OptionFlowDriftTotals = {
    ...acc,
    callPremium,
    putPremium,
    bullishPremium,
    bearishPremium,
    classifiedPremium,
    unknownPremium,
    totalPremium,
    callDrift,
    putDrift,
    netDirectionalDrift,
    callBounds: [callDrift - acc.callUnknownPremium, callDrift + acc.callUnknownPremium],
    putBounds: [putDrift - acc.putUnknownPremium, putDrift + acc.putUnknownPremium],
    netDirectionalBounds: [
      netDirectionalDrift - unknownPremium,
      netDirectionalDrift + unknownPremium,
    ],
    classificationCoverage,
    totalVolume: acc.bullishVolume + acc.bearishVolume + acc.unknownVolume,
    netDirectionalVolume,
    unknownTradeCount: acc.tradeCount - acc.classifiedTradeCount,
    volumeConfirmation,
    heuristic,
  };
  // Finite inputs can still overflow products, sums, or bounds. Never emit Infinity/NaN as money.
  for (const [field, value] of Object.entries(result)) {
    if (typeof value === 'number') ensureFinite(value, `computed ${field}`, FN);
    if (Array.isArray(value)) value.forEach((n) => ensureFinite(n, `computed ${field}`, FN));
  }
  return result;
}

/**
 * Aggregate observed raw option trading premium for one explicit session. Example:
 * `optionFlowDrift({ trades, session: { date: '2026-06-04' }, config: { symbol: 'SPY' } })`.
 *
 * Each minute/bucket exposes separate `change` and `cumulative` accounting. Buy calls / sell puts
 * map to bullish premium and volume; sell calls / buy puts map to bearish. Unknowns move neither
 * drift nor directional volume, but contribute all their premium to worst-case sign bounds.
 * Classification coverage is a share of premium, NOT a success probability or confidence band.
 * No delta weighting, dealer-position inference, multi-leg netting, fees, P&L, or income prediction.
 * All combined premiums must already use one currency; this operation does not convert FX.
 *
 * Heuristics apply to the SAME window's totals: no prints/zero premium → no-signal; coverage below
 * the threshold → low-coverage; opposing nonzero volume/premium signs → volume-opposed; call > 0
 * and put < 0 → bullish-expansion (reverse → bearish-expansion); remaining nonzero net → mixed-flow.
 * These are descriptive accounting rules, not trading recommendations or measured predictiveness.
 *
 * Session/cutoff and bucket ends are exclusive. A bucket is a completed END-of-interval observation,
 * not a value available at its start. Prices carry forward only from observations in this session;
 * missing prices stay null. Overlay ties prefer underlying trades, then quotes, then option-print
 * underlyingPrice, with last input winning within a source. Caller timestamps must express when
 * data was available; embedded underlyingPrice is assumed available at its option print timestamp.
 * Late vendor corrections/publication delays cannot be reconstructed from these fields alone.
 *
 * Trades are validated even outside scope, then stably sorted without mutation. Repeated explicit
 * IDs fail. ID-less prints identical in the consumed trade fields fail (including sequence/venue);
 * give genuinely distinct identical executions distinct IDs. Vendor metadata stays open. No print
 * is silently deduplicated; malformed data or unrepresentable arithmetic throws typed InputError.
 */
export function optionFlowDrift(input: OptionFlowDriftInput): OptionFlowDriftResult {
  requireArgumentObject(FN, 'input', input);
  ensureKnownKeys(FN, 'input', input, ['trades', 'session', 'config']);
  requireArgumentArray(FN, 'trades', input.trades);
  if (!Array.isArray(input.trades))
    invalid('trades', 'must be an array of option prints.', ErrorCode.InputWrongType);
  requireArgumentObject(FN, 'session', input.session);
  ensureKnownKeys(FN, 'session', input.session, ['date', 'calendar']);
  let dateMs: number;
  try {
    dateMs = isoDateToEpochMs(input.session.date);
  } catch {
    invalid('session.date', 'must be a real ISO YYYY-MM-DD date.', ErrorCode.InputWrongType);
  }
  const calendar = requireCalendar(
    FN,
    input.session.calendar === undefined ? NYSE : input.session.calendar,
  );
  const config = input.config === undefined ? {} : input.config;
  requireArgumentObject(FN, 'config', config);
  ensureKnownKeys(FN, 'config', config, [
    'symbol',
    'priceOverlay',
    'bucketMinutes',
    'asOf',
    'classificationSource',
    'multiplier',
    'minimumClassificationCoverage',
  ]);
  if (config.symbol !== undefined) requireSymbol(config.symbol, 'config.symbol');
  for (const field of [
    'bucketMinutes',
    'asOf',
    'multiplier',
    'minimumClassificationCoverage',
  ] as const) {
    ensureFiniteWhenPresent(config[field], `config.${field}`, FN);
  }
  const bucketMinutes = config.bucketMinutes === undefined ? 5 : config.bucketMinutes;
  if (!Number.isSafeInteger(bucketMinutes) || bucketMinutes < 1 || bucketMinutes > 1440) {
    invalid('config.bucketMinutes', 'must be an integer in [1, 1440].');
  }
  if (config.asOf !== undefined) requireTimestamp(config.asOf, 'config.asOf');
  const threshold =
    config.minimumClassificationCoverage === undefined ? 0.6 : config.minimumClassificationCoverage;
  ensureNonNegative(threshold, 'config.minimumClassificationCoverage', FN);
  if (threshold > 1) invalid('config.minimumClassificationCoverage', 'must be in [0, 1].');
  const multiplier = config.multiplier === undefined ? 100 : config.multiplier;
  ensurePositive(multiplier, 'config.multiplier', FN);
  const classificationSource =
    config.classificationSource === undefined ? 'provided-first' : config.classificationSource;

  const overlay = config.priceOverlay;
  if (overlay !== undefined) {
    requireArgumentObject(FN, 'config.priceOverlay', overlay);
    ensureKnownKeys(FN, 'config.priceOverlay', overlay, ['symbol', 'quotes', 'trades']);
    requireSymbol(overlay.symbol, 'config.priceOverlay.symbol');
  }
  const overlaySymbol = overlay?.symbol ?? config.symbol ?? null;
  const prices: Array<OptionFlowDriftPrice & { priority: number }> = [];
  for (const field of ['quotes', 'trades'] as const) {
    const data = overlay?.[field];
    if (data === undefined) continue;
    requireArgumentArray(FN, `config.priceOverlay.${field}`, data);
    if (!Array.isArray(data))
      invalid(`config.priceOverlay.${field}`, 'must be an array.', ErrorCode.InputWrongType);
    Array.from(data as readonly (Quote | Trade)[]).forEach((row, i) => {
      const path = `config.priceOverlay.${field}[${i}]`;
      requireArgumentObject(FN, path, row);
      requireSymbol(row.symbol, `${path}.symbol`);
      requireTimestamp(row.timestampMs, `${path}.timestampMs`);
      requireFiniteFields(FN, row, field === 'quotes' ? ['bid', 'ask'] : ['price', 'size'], {
        path,
        exampleCall:
          "optionFlowDrift({ trades: [], session: { date: '2026-06-04' }, config: { priceOverlay: { symbol: 'SPY', quotes: [{ symbol: 'SPY', timestampMs: 1780579800000, bid: 599, ask: 601 }], trades: [{ symbol: 'SPY', timestampMs: 1780579800000, price: 600, size: 1 }] } } })",
      });
      let price: number;
      if (field === 'quotes') {
        const quote = row as Quote;
        ensureNonNegative(quote.bid, `${path}.bid`, FN);
        ensureNonNegative(quote.ask, `${path}.ask`, FN);
        // Locked quotes have a usable price, crossed/zero-sided quotes do not.
        if (quote.bid > quote.ask || quote.bid === 0 || quote.ask === 0) return;
        price = quote.bid + (quote.ask - quote.bid) / 2;
      } else {
        price = (row as Trade).price;
        ensurePositive(price, `${path}.price`, FN);
        ensurePositive((row as Trade).size, `${path}.size`, FN);
      }
      if (row.symbol === overlaySymbol)
        prices.push({
          symbol: row.symbol,
          timestampMs: row.timestampMs,
          price,
          source: field === 'quotes' ? 'underlying-quote-midpoint' : 'underlying-trade',
          priority: field === 'quotes' ? 1 : 2,
        });
    });
  }

  // flow()'s own per-print validation, premium and side classification — the same function, so the
  // two cannot disagree — WITHOUT its block, 0DTE, open/close, sweep and spread analytics, which
  // drift never reported. flow() also resolved every expiry (for its 0DTE flag), so an unparseable
  // expiry has always failed here; resolving it keeps that error. Then flow()'s stable time order.
  if (config.classificationSource !== undefined) requireClassificationSource(classificationSource);
  const classified = input.trades.map((trade, inputIndex) => {
    const print = classifyPrint(trade, inputIndex, multiplier, classificationSource);
    optionExpiryToMs(trade.contract.expiry);
    return { trade, inputIndex, ...print };
  });
  classified.sort((a, b) => a.trade.timestampMs - b.trade.timestampMs);
  const identities = new Set<string>();
  input.trades.forEach((trade, i) => {
    const path = `trades[${i}]`;
    if (trade.id !== undefined) requireSymbol(trade.id, `${path}.id`);
    ensureFiniteWhenPresent(trade.sequence, `${path}.sequence`, FN);
    if (
      trade.sequence !== undefined &&
      (!Number.isSafeInteger(trade.sequence) || trade.sequence < 0)
    ) {
      invalid(`${path}.sequence`, 'must be a non-negative safe integer.');
    }
    if (trade.exchange !== undefined) requireSymbol(trade.exchange, `${path}.exchange`);
    ensureFiniteWhenPresent(trade.underlyingPrice, `${path}.underlyingPrice`, FN);
    if (trade.underlyingPrice !== undefined)
      ensurePositive(trade.underlyingPrice, `${path}.underlyingPrice`, FN);
    const c = trade.contract;
    const key =
      trade.id !== undefined
        ? `id:${trade.id}`
        : `print:${JSON.stringify([
            c.underlying,
            c.expiry,
            c.type,
            c.strike,
            c.multiplier ?? multiplier,
            trade.timestampMs,
            trade.sequence,
            trade.exchange,
            trade.price,
            trade.size,
            trade.premium,
            trade.aggressorSide,
            trade.bid,
            trade.ask,
            trade.underlyingPrice,
          ])}`;
    if (identities.has(key))
      invalid(
        path,
        'duplicates an ID or an identical ID-less print; supply unique IDs for distinct executions.',
      );
    identities.add(key);
    if (trade.underlyingPrice !== undefined) {
      if (c.underlying === overlaySymbol)
        prices.push({
          symbol: c.underlying,
          price: trade.underlyingPrice,
          timestampMs: trade.timestampMs,
          source: 'option-trade-underlying',
          priority: 0,
        });
    }
  });

  const day = calendar.session(input.session.date);
  requireArgumentObject(FN, 'calendar.session result', day);
  if (
    day.date !== input.session.date ||
    typeof day.isBusinessDay !== 'boolean' ||
    typeof day.isHalfDay !== 'boolean'
  ) {
    invalid(
      'calendar.session',
      'must return the requested date and boolean isBusinessDay/isHalfDay.',
    );
  }
  const open = day.isBusinessDay
    ? boundary(dateMs, day.open, calendar.timezone, 'calendar.session.open')
    : null;
  const close = day.isBusinessDay
    ? boundary(dateMs, day.close, calendar.timezone, 'calendar.session.close')
    : null;
  if (open !== null && close !== null && (close <= open || close - open > 2 * DAY)) {
    invalid(
      'calendar.session',
      'must have close after open and duration at most 48 hours; use 24:00 for next midnight.',
    );
  }
  const end =
    open === null || close === null ? null : Math.max(open, Math.min(close, config.asOf ?? close));
  const inSession = (ms: number): boolean =>
    open !== null && end !== null && ms >= open && ms < end;
  const prints: OptionFlowDriftPrint[] = classified
    .filter(
      (t) =>
        inSession(t.trade.timestampMs) &&
        (config.symbol === undefined || t.trade.contract.underlying === config.symbol),
    )
    .map((t) => ({
      id: t.trade.id ?? null,
      inputIndex: t.inputIndex,
      timestampMs: t.trade.timestampMs,
      underlying: t.trade.contract.underlying,
      type: t.trade.contract.type,
      side: t.side,
      classificationProvenance: { ...t.classificationProvenance },
      premium: t.premium,
      premiumSource: t.trade.premium === undefined ? 'price-size-multiplier' : 'provided',
      multiplier: t.trade.contract.multiplier ?? multiplier,
      contracts: t.trade.size,
      directionalPremium:
        t.side === 'unknown'
          ? 0
          : (t.trade.contract.type === 'call') === (t.side === 'buy')
            ? t.premium
            : -t.premium,
    }));
  const observations = prices
    .filter((p) => inSession(p.timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs || a.priority - b.priority);
  const build = (width: number): OptionFlowDriftBucket[] => {
    if (open === null || close === null || end === null) return [];
    const result: OptionFlowDriftBucket[] = [];
    const cumulative = empty();
    let printIndex = 0;
    let priceIndex = 0;
    let lastPrice: OptionFlowDriftPrice | null = null;
    for (let start = open; start < end; start += width) {
      const bucketEnd = Math.min(start + width, end);
      const change = empty();
      const rows: OptionFlowDriftPrint[] = [];
      while (printIndex < prints.length && prints[printIndex]!.timestampMs < bucketEnd) {
        const print = prints[printIndex++]!;
        add(change, print);
        add(cumulative, print);
        rows.push({ ...print, classificationProvenance: { ...print.classificationProvenance } });
      }
      while (
        priceIndex < observations.length &&
        observations[priceIndex]!.timestampMs < bucketEnd
      ) {
        const { priority: _priority, ...observation } = observations[priceIndex++]!;
        lastPrice = observation;
      }
      result.push({
        startTimestampMs: start,
        endTimestampMs: bucketEnd,
        partial: bucketEnd < Math.min(start + width, close),
        change: totals(change, threshold),
        cumulative: totals(cumulative, threshold),
        price: lastPrice === null ? null : { ...lastPrice },
        trades: rows,
      });
    }
    return result;
  };
  const minutes = build(MINUTE);
  const buckets = build(bucketMinutes * MINUTE);
  const aggregate = empty();
  prints.forEach((print) => add(aggregate, print));
  return {
    value: {
      session: {
        date: input.session.date,
        isBusinessDay: day.isBusinessDay,
        isHalfDay: day.isHalfDay,
        openTimestampMs: open,
        closeTimestampMs: close,
        endTimestampMs: end,
      },
      minutes,
      buckets,
      summary: totals(aggregate, threshold),
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      calendar: calendar.name,
      calendarVersion: calendar.version,
      ...(config.asOf === undefined ? {} : { asOf: config.asOf }),
      timezone: calendar.timezone,
      sessionDate: input.session.date,
      symbol: config.symbol ?? null,
      priceOverlaySymbol: overlaySymbol,
      bucketMinutes,
      classificationSource,
      multiplier,
      minimumClassificationCoverage: threshold,
      premiumRule: 'provided-else-price-times-size-times-multiplier',
      unknownPolicy: 'zero-drift-full-premium-bounds',
      interval: '[open,min(close,asOf))',
      priceRule: 'in-session-latest-before-bucket-end-no-backfill',
      priceTieBreak: 'underlying-trade-then-quote-then-option-trade-last-input',
      orderPolicy: 'stable-timestamp-sort',
      duplicatePolicy: 'reject-id-or-identical-idless-print',
      coverageMeaning: 'classified-premium-share-not-probability',
      heuristicRule: 'empty-low-coverage-volume-opposed-expansion-mixed',
    },
    diagnostics: {
      warnings: [
        warning(
          WarningCode.ModelLimitation,
          'Raw premium accounting, not dealer hedging drift, delta-adjusted premium, P&L, or income prediction. Directional labels and volume agreement are stated heuristics, not measured predictiveness. Combined premiums must use one currency.',
          'info',
        ),
        warning(
          WarningCode.ModelLimitation,
          `Classification policy: ${classificationSource}. Provider classifications are unverified; quote-rule estimates use contemporaneous NBBO, with no tick test. Unknown-premium bounds are worst-case sign assignments, not confidence intervals; classification coverage is not a probability.`,
          'info',
        ),
        warning(
          WarningCode.ModelLimitation,
          'Bucket values are available at the exclusive interval end, not its start. Prices use only in-session observations before that end, with no future backfill. Timestamps must reflect availability; embedded underlyingPrice is assumed available at its option print timestamp. Staleness, vendor delays and corrections are not modeled.',
          'info',
        ),
      ],
    },
  };
}
