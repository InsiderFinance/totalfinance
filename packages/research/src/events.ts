/**
 * FC3 — event studies. An event study measures how an instrument's returns behave around an
 * information instant: actual return minus a declared expected-return model, aligned on
 * event-relative trading-session offsets.
 *
 * The conventions this module states (and echoes in every result's `assumptions`):
 *
 * - **Sessions are the data.** An instrument's trading sessions are the SORTED distinct
 *   `tradingSessionDate` values in its return observations. Offset 0 is the event session; offset
 *   −1 the session before it; offset +1 the one after.
 * - **Session policy** maps `announcedTimestampMs` (converted to a UTC `YYYY-MM-DD` date) to
 *   session 0. `'announcement-session'` anchors to the FIRST session dated ON OR AFTER the
 *   announcement date. `'next-session'` (the default) anchors to the first session STRICTLY AFTER
 *   the last session dated on or before the announcement date — information arriving during or
 *   after a session is tradable the NEXT session. An announcement dated before every observed
 *   session anchors to the first session under both policies (the information already exists when
 *   trading begins).
 * - **Exclusion over patching.** An event missing ANY session in its event window, or missing the
 *   estimation window its model requires, is EXCLUDED with a per-event reason in
 *   `diagnostics.excludedEvents` — never silently truncated or interpolated.
 * - **Overlap is a declared choice.** `overlappingEventPolicy` is REQUIRED with no default:
 *   `'reject'` excludes any same-instrument event whose windows collide with an earlier kept
 *   event's (event-vs-event, event-vs-estimation, estimation-vs-event; the estimation window
 *   participates only when the model uses one); `'allow-contaminated'` keeps every such event and
 *   lists it in `diagnostics.contaminatedEventIds`.
 * - **Cumulation is declared.** `'sum'` (the classic CAR, the default) adds abnormal returns;
 *   `'compound'` chains them as Π(1 + AR) − 1. CAAR applies the SAME convention to the AAR series.
 * - **Null with reason, never NaN.** A statistic that does not exist (t with n < 2, R² of a
 *   zero-variance instrument) is `null` beside a written reason, never a non-finite number.
 */

import {
  requireRepresentableResult,
  ensureKnownKeys,
  ErrorCode,
  InputError,
  isoDateToEpochMs,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import {
  type MarketEvent,
  type ReturnObservation,
  requireMarketEvent,
  requireReturnObservations,
} from './observations.js';

// ---------------------------------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------------------------------

/** How a timestamp maps to session 0 — see the module header for the exact anchoring rules. */
export type EventStudySessionPolicy = 'announcement-session' | 'next-session';

/** How same-instrument window collisions are handled. REQUIRED — no default. */
export type OverlappingEventPolicy = 'reject' | 'allow-contaminated';

/** How abnormal returns cumulate: `'sum'` = Σ AR (classic CAR); `'compound'` = Π(1 + AR) − 1. */
export type CumulativeConvention = 'sum' | 'compound';

/** An inclusive event-relative session window; offset 0 is the event session. */
export interface TradingSessionWindow {
  startTradingSessionOffset: number;
  endTradingSessionOffset: number;
}

/** One market (index/benchmark) return for one trading session. */
export interface MarketReturnObservation {
  /** Strict `YYYY-MM-DD` trading-session date. */
  tradingSessionDate: string;
  /** Simple (arithmetic) market return over the session, as a decimal. */
  simpleReturn: number;
}

/** What a caller-supplied factor model is shown per event session. */
export interface ExpectedReturnContext {
  instrumentId: string;
  tradingSessionDate: string;
  /** Present when `marketReturns` were supplied and carry this session's date. */
  marketReturn?: number;
}

/** The declared expected-return model — a closed union; `'custom'` is the structural escape. */
export type ExpectedReturnModelInput =
  | { model: 'mean-adjusted' }
  | { model: 'market-adjusted' }
  | { model: 'market' }
  | { model: 'custom'; expectedReturn: (context: ExpectedReturnContext) => number };

/** Input for {@link eventStudy}. */
export interface EventStudyInput {
  events: readonly MarketEvent[];
  /** Instrument returns per trading session — the sessions ARE these rows' distinct dates. */
  returnObservations: readonly ReturnObservation[];
  /** Required by the `'market-adjusted'` and `'market'` models. */
  marketReturns?: readonly MarketReturnObservation[];
  /** Integers, start ≤ end; offset 0 is the event session. */
  eventWindow: TradingSessionWindow;
  /**
   * REQUIRED by `'mean-adjusted'` and `'market'`; must END strictly BEFORE the event window
   * starts — a model estimated through the event measures the event twice.
   */
  estimationWindow?: TradingSessionWindow;
  expectedReturnModel: ExpectedReturnModelInput;
  /** Default `'next-session'` — documented in the module header and echoed in assumptions. */
  sessionPolicy?: EventStudySessionPolicy;
  /** REQUIRED, no default — overlap handling changes the statistics, so the caller must choose. */
  overlappingEventPolicy: OverlappingEventPolicy;
  /** Default `'sum'` (classic CAR) — documented and echoed. */
  cumulativeConvention?: CumulativeConvention;
}

/** The conventions an event study ran under, echoed verbatim. */
export interface EventStudyAssumptions {
  sessionPolicy: EventStudySessionPolicy;
  cumulativeConvention: CumulativeConvention;
  /** The model name; a caller function is classified `'custom (non-serializable)'`. */
  expectedReturnModel: string;
  eventWindow: TradingSessionWindow;
  /** Echoed exactly when supplied. */
  estimationWindow?: TradingSessionWindow;
  overlappingEventPolicy: OverlappingEventPolicy;
}

/** What the study disclosed about coverage and exclusions. */
export interface EventStudyDiagnostics {
  warnings: string[];
  eventsSupplied: number;
  eventsIncluded: number;
  excludedEvents: { eventId: string; reason: string }[];
  /** Populated under `'allow-contaminated'`; empty under `'reject'` (contamination is removed). */
  contaminatedEventIds: string[];
}

/** One aligned event-window session with actual, expected, and abnormal return. */
export interface AbnormalReturnRow {
  tradingSessionOffset: number;
  tradingSessionDate: string;
  actualReturn: number;
  expectedReturn: number;
  abnormalReturn: number;
}

/** The market model fitted for one event (`'market'` model only). */
export interface EventMarketModel {
  alpha: number;
  beta: number;
  /** `null` with a reason when the instrument had zero variance over the estimation window. */
  rSquared: number | null;
  rSquaredAbsentReason?: string;
}

/** One included event's aligned rows and cumulative abnormal return. */
export interface EventStudyEventResult {
  eventId: string;
  instrumentId: string;
  anchorTradingSessionDate: string;
  /** Present only under the `'market'` model. */
  marketModel?: EventMarketModel;
  rows: AbnormalReturnRow[];
  cumulativeAbnormalReturn: number;
}

/** One cross-sectional row: AAR, CAAR, and the per-offset t-statistic with its sample size. */
export interface AverageAbnormalReturnRow {
  tradingSessionOffset: number;
  averageAbnormalReturn: number;
  cumulativeAverageAbnormalReturn: number;
  eventCount: number;
  /** `mean / (sampleStandardDeviation / √n)`; `null` with a reason when n < 2 or variance is 0. */
  tStatistic: number | null;
  tStatisticAbsentReason?: string;
}

/** The full event-study result — assumptions and diagnostics always present. */
export interface EventStudyResult {
  assumptions: EventStudyAssumptions;
  diagnostics: EventStudyDiagnostics;
  events: EventStudyEventResult[];
  averageAbnormalReturns: AverageAbnormalReturnRow[];
}

/** Input for {@link aggregateEventStudies}. */
export interface AggregateEventStudiesInput {
  studies: readonly EventStudyResult[];
}

/** Aggregate assumptions — per-study fields that legitimately differ are labelled, not hidden. */
export interface AggregateEventStudiesAssumptions {
  sessionPolicy: EventStudySessionPolicy;
  cumulativeConvention: CumulativeConvention;
  /** The shared model name, or `'mixed (…)'` naming each model pooled. */
  expectedReturnModel: string;
  eventWindow: TradingSessionWindow;
  /** Present only when every study declared the identical estimation window. */
  estimationWindow?: TradingSessionWindow;
  /** The shared policy, or `'mixed'` when studies differ. */
  overlappingEventPolicy: OverlappingEventPolicy | 'mixed';
}

/** The pooled result: same grammar, plus how many studies were pooled. */
export interface AggregateEventStudiesResult {
  assumptions: AggregateEventStudiesAssumptions;
  diagnostics: EventStudyDiagnostics;
  events: EventStudyEventResult[];
  averageAbnormalReturns: AverageAbnormalReturnRow[];
  studiesAggregated: number;
}

/** Input for {@link alignEventWindows}. */
export interface AlignEventWindowsInput {
  events: readonly MarketEvent[];
  returnObservations: readonly ReturnObservation[];
  eventWindow: TradingSessionWindow;
  /** Default `'next-session'` — the same policy, the same code path, as {@link eventStudy}. */
  sessionPolicy?: EventStudySessionPolicy;
}

/** One event-relative session row before any expected-return modelling. */
export interface AlignedSessionRow {
  tradingSessionOffset: number;
  tradingSessionDate: string;
  simpleReturn: number;
}

/** One successfully aligned event. */
export interface AlignedEventWindow {
  eventId: string;
  instrumentId: string;
  anchorTradingSessionDate: string;
  rows: AlignedSessionRow[];
}

/** The alignment helper's result — the anchoring truth {@link eventStudy} itself computes over. */
export interface AlignEventWindowsResult {
  assumptions: {
    sessionPolicy: EventStudySessionPolicy;
    eventWindow: TradingSessionWindow;
  };
  diagnostics: {
    warnings: string[];
    eventsSupplied: number;
    eventsAligned: number;
    excludedEvents: { eventId: string; reason: string }[];
  };
  alignments: AlignedEventWindow[];
}

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shape via the regex, then the REAL calendar: `2025-02-30` must teach, never normalize. */
const isCalendarDate = (value: string): boolean => {
  try {
    isoDateToEpochMs(value);
    return true;
  } catch {
    return false;
  }
};
const WINDOW_KEYS = ['startTradingSessionOffset', 'endTradingSessionOffset'] as const;
const MARKET_RETURN_KEYS = ['tradingSessionDate', 'simpleReturn'] as const;
const SESSION_POLICIES: readonly EventStudySessionPolicy[] = [
  'announcement-session',
  'next-session',
];
const OVERLAP_POLICIES: readonly OverlappingEventPolicy[] = ['reject', 'allow-contaminated'];
const CUMULATIVE_CONVENTIONS: readonly CumulativeConvention[] = ['sum', 'compound'];
const MODEL_NAMES = ['mean-adjusted', 'market-adjusted', 'market', 'custom'] as const;

const EVENT_STUDY_EXAMPLE =
  "eventStudy({ events: [{ eventId: 'e1', instrumentId: 'AAA', eventType: 'earnings', announcedTimestampMs: 1709823600000 }], returnObservations: [{ instrumentId: 'AAA', tradingSessionDate: '2024-03-07', simpleReturn: 0.012 }, …], eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 }, estimationWindow: { startTradingSessionOffset: -6, endTradingSessionOffset: -2 }, expectedReturnModel: { model: 'mean-adjusted' }, overlappingEventPolicy: 'reject' })";

/** Validate the event list: each a {@link MarketEvent}, identities unique. */
function requireEvents(functionName: string, events: readonly MarketEvent[]): void {
  if (!Array.isArray(events) || events.length === 0) {
    throw new InputError(
      `${functionName}: events must be a non-empty array of market events — an event study needs at least one event.\n  e.g. ${EVENT_STUDY_EXAMPLE}`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'events' } },
    );
  }
  const seen = new Set<string>();
  events.forEach((event, index) => {
    requireMarketEvent(functionName, `events[${index}]`, event);
    if (seen.has(event.eventId)) {
      throw new InputError(
        `${functionName}: events[${index}] reuses eventId '${event.eventId}' — event identities must be unique so per-event exclusions and contamination lists are unambiguous.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `events[${index}].eventId` } },
      );
    }
    seen.add(event.eventId);
  });
}

/** Validate an inclusive session window: integer offsets, start ≤ end. */
function requireSessionWindow(
  functionName: string,
  field: string,
  window: TradingSessionWindow,
): void {
  requireArgumentObject(functionName, field, window);
  ensureKnownKeys(functionName, field, window, WINDOW_KEYS);
  for (const key of WINDOW_KEYS) {
    const value = window[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new InputError(
        `${functionName}: ${field}.${key} must be an integer trading-session offset (offset 0 is the event session). Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.\n  e.g. ${functionName}({ ..., ${field}: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 } })`,
        { code: ErrorCode.InputWrongType, context: { field: `${field}.${key}` } },
      );
    }
  }
  if (window.startTradingSessionOffset > window.endTradingSessionOffset) {
    throw new InputError(
      `${functionName}: ${field}.startTradingSessionOffset (${window.startTradingSessionOffset}) must be ≤ ${field}.endTradingSessionOffset (${window.endTradingSessionOffset}) — the window is inclusive and reads left to right.`,
      { code: ErrorCode.InputOutOfRange, context: { field } },
    );
  }
}

/** Validate the model union and return the string classified for `assumptions`. */
function requireExpectedReturnModel(functionName: string, model: ExpectedReturnModelInput): string {
  requireArgumentObject(functionName, 'expectedReturnModel', model);
  if (!(MODEL_NAMES as readonly string[]).includes(model.model)) {
    throw new InputError(
      `${functionName}: expectedReturnModel.model must be one of ${MODEL_NAMES.map((name) => `'${name}'`).join(', ')}. Received ${model.model === null ? 'null' : JSON.stringify(model.model)}.\n  e.g. ${functionName}({ ..., expectedReturnModel: { model: 'mean-adjusted' } })`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'expectedReturnModel.model' } },
    );
  }
  if (model.model === 'custom') {
    ensureKnownKeys(functionName, 'expectedReturnModel', model, ['model', 'expectedReturn']);
    if (typeof model.expectedReturn !== 'function') {
      throw new InputError(
        `${functionName}: expectedReturnModel.expectedReturn must be a function (context) => number when model is 'custom' — the structural escape hatch for caller factor models.\n  e.g. ${functionName}({ ..., expectedReturnModel: { model: 'custom', expectedReturn: ({ marketReturn }) => 0.0002 + 1.1 * (marketReturn ?? 0) } })`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: 'expectedReturnModel.expectedReturn' },
        },
      );
    }
    return 'custom (non-serializable)';
  }
  ensureKnownKeys(functionName, 'expectedReturnModel', model, ['model']);
  return model.model;
}

/** Validate an enum-typed option when present; return the documented default when absent. */
function resolveEnumOption<T extends string>(
  functionName: string,
  field: string,
  value: T | undefined,
  allowed: readonly T[],
  defaultValue: T,
): T {
  if (value === undefined) return defaultValue;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InputError(
      `${functionName}: ${field} must be one of ${allowed.map((name) => `'${name}'`).join(' | ')}. Received ${value === null ? 'null' : JSON.stringify(value)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field } },
    );
  }
  return value;
}

/** Per-instrument sessions: sorted distinct dates plus the return at each date. */
interface InstrumentSessionIndex {
  dates: string[];
  returnByDate: Map<string, number>;
}

/** Index return observations by instrument, refusing ambiguous duplicate sessions. */
function buildInstrumentSessions(
  functionName: string,
  observations: readonly ReturnObservation[],
): Map<string, InstrumentSessionIndex> {
  const byInstrument = new Map<string, InstrumentSessionIndex>();
  observations.forEach((row, index) => {
    let entry = byInstrument.get(row.instrumentId);
    if (entry === undefined) {
      entry = { dates: [], returnByDate: new Map() };
      byInstrument.set(row.instrumentId, entry);
    }
    if (entry.returnByDate.has(row.tradingSessionDate)) {
      throw new InputError(
        `${functionName}: returnObservations[${index}] duplicates instrument '${row.instrumentId}' session ${row.tradingSessionDate} — one return per instrument per trading session; two rows for the same session are ambiguous.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `returnObservations[${index}]` } },
      );
    }
    entry.returnByDate.set(row.tradingSessionDate, row.simpleReturn);
  });
  for (const entry of byInstrument.values()) {
    entry.dates = [...entry.returnByDate.keys()].sort();
  }
  return byInstrument;
}

/** Validate market returns and index them by date, refusing duplicates. */
function buildMarketReturnIndex(
  functionName: string,
  rows: readonly MarketReturnObservation[],
): Map<string, number> {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new InputError(
      `${functionName}: marketReturns must be a non-empty array of { tradingSessionDate, simpleReturn } rows.\n  e.g. ${functionName}({ ..., marketReturns: [{ tradingSessionDate: '2024-03-01', simpleReturn: 0.0012 }] })`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'marketReturns' } },
    );
  }
  const byDate = new Map<string, number>();
  rows.forEach((row, index) => {
    const path = `marketReturns[${index}]`;
    requireArgumentObject(functionName, path, row);
    ensureKnownKeys(functionName, path, row, MARKET_RETURN_KEYS);
    if (
      typeof row.tradingSessionDate !== 'string' ||
      !STRICT_DATE.test(row.tradingSessionDate) ||
      !isCalendarDate(row.tradingSessionDate)
    ) {
      throw new InputError(
        `${functionName}: ${path}.tradingSessionDate must be a strict YYYY-MM-DD calendar date. Received ${row.tradingSessionDate === null ? 'null' : JSON.stringify(row.tradingSessionDate)}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.tradingSessionDate` } },
      );
    }
    requireFiniteFields(functionName, row, ['simpleReturn'], {
      exampleCall: () =>
        `${functionName}({ ..., marketReturns: [{ tradingSessionDate: '2024-03-01', simpleReturn: 0.0012 }] })`,
      path,
    });
    if (byDate.has(row.tradingSessionDate)) {
      throw new InputError(
        `${functionName}: ${path} duplicates the market return for session ${row.tradingSessionDate} — one market return per trading session.`,
        { code: ErrorCode.InputOutOfRange, context: { field: path } },
      );
    }
    byDate.set(row.tradingSessionDate, row.simpleReturn);
  });
  return byDate;
}

// ---------------------------------------------------------------------------------------------------
// Anchoring — ONE implementation, shared by eventStudy and alignEventWindows
// ---------------------------------------------------------------------------------------------------

/** Convert an epoch-ms instant to its UTC `YYYY-MM-DD` trading-comparison date. */
function utcDateOf(functionName: string, field: string, timestampMs: number): string {
  const instant = new Date(timestampMs);
  if (Number.isNaN(instant.getTime())) {
    throw new InputError(
      `${functionName}: ${field} (${timestampMs}) is outside the representable date range — epoch milliseconds were expected.`,
      { code: ErrorCode.InputOutOfRange, context: { field } },
    );
  }
  const iso = instant.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) {
    throw new InputError(
      `${functionName}: ${field} (${timestampMs}) resolves outside years 0000–9999 (${iso}) — trading-session dates are strict YYYY-MM-DD.`,
      { code: ErrorCode.InputOutOfRange, context: { field } },
    );
  }
  return iso.slice(0, 10);
}

type AnchorResolution = { ok: true; anchorIndex: number } | { ok: false; reason: string };

/**
 * Anchor session 0 on an instrument's sorted sessions.
 *
 * - `'announcement-session'`: the FIRST session dated ≥ the announcement date.
 * - `'next-session'`: the first session STRICTLY AFTER the last session dated ≤ the announcement
 *   date; when no session is dated ≤ it, the first session (the information predates trading).
 */
function resolveAnchorIndex(
  dates: readonly string[],
  announcementDate: string,
  sessionPolicy: EventStudySessionPolicy,
): AnchorResolution {
  if (sessionPolicy === 'announcement-session') {
    for (let i = 0; i < dates.length; i++) {
      if (dates[i]! >= announcementDate) return { ok: true, anchorIndex: i };
    }
    return {
      ok: false,
      reason: `no trading session on or after the announcement date ${announcementDate} — 'announcement-session' anchors session 0 to the first session dated on or after the announcement date.`,
    };
  }
  let lastAtOrBefore = -1;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i]! <= announcementDate) lastAtOrBefore = i;
    else break;
  }
  if (lastAtOrBefore === -1) return { ok: true, anchorIndex: 0 };
  const anchorIndex = lastAtOrBefore + 1;
  if (anchorIndex >= dates.length) {
    return {
      ok: false,
      reason: `the announcement date ${announcementDate} is on or after the last observed session (${dates[dates.length - 1]!}) — 'next-session' anchors session 0 to the first session strictly after the last session dated on or before the announcement, and no later session exists in the data.`,
    };
  }
  return { ok: true, anchorIndex };
}

type WindowSlice = { ok: true; rows: AlignedSessionRow[] } | { ok: false; reason: string };

/** Slice an inclusive offset window from the sorted sessions, or say exactly what is missing. */
function sliceSessionWindow(
  index: InstrumentSessionIndex,
  anchorIndex: number,
  window: TradingSessionWindow,
  windowLabel: string,
): WindowSlice {
  const rows: AlignedSessionRow[] = [];
  for (
    let offset = window.startTradingSessionOffset;
    offset <= window.endTradingSessionOffset;
    offset++
  ) {
    const sessionIndex = anchorIndex + offset;
    if (sessionIndex < 0 || sessionIndex >= index.dates.length) {
      return {
        ok: false,
        reason: `missing trading session at ${windowLabel} offset ${offset >= 0 ? `+${offset}` : String(offset)} relative to anchor session ${index.dates[anchorIndex]!} — the instrument's observed sessions span ${index.dates[0]!}..${index.dates[index.dates.length - 1]!}.`,
      };
    }
    const tradingSessionDate = index.dates[sessionIndex]!;
    rows.push({
      tradingSessionOffset: offset,
      tradingSessionDate,
      simpleReturn: index.returnByDate.get(tradingSessionDate)!,
    });
  }
  return { ok: true, rows };
}

type EventAlignment =
  | { ok: true; anchorIndex: number; anchorTradingSessionDate: string; rows: AlignedSessionRow[] }
  | { ok: false; reason: string };

/** The single anchoring code path: date the announcement, anchor session 0, slice the window. */
function alignEventToSessions(
  functionName: string,
  event: MarketEvent,
  eventField: string,
  sessionsByInstrument: Map<string, InstrumentSessionIndex>,
  eventWindow: TradingSessionWindow,
  sessionPolicy: EventStudySessionPolicy,
): EventAlignment {
  const announcementDate = utcDateOf(
    functionName,
    `${eventField}.announcedTimestampMs`,
    event.announcedTimestampMs,
  );
  const index = sessionsByInstrument.get(event.instrumentId);
  if (index === undefined) {
    return {
      ok: false,
      reason: `no return observations were supplied for instrument '${event.instrumentId}'.`,
    };
  }
  const anchor = resolveAnchorIndex(index.dates, announcementDate, sessionPolicy);
  if (!anchor.ok) return anchor;
  const slice = sliceSessionWindow(index, anchor.anchorIndex, eventWindow, 'event window');
  if (!slice.ok) return slice;
  return {
    ok: true,
    anchorIndex: anchor.anchorIndex,
    anchorTradingSessionDate: index.dates[anchor.anchorIndex]!,
    rows: slice.rows,
  };
}

// ---------------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------------

/** Cumulate a series under the declared convention: running Σ, or running Π(1 + v) − 1. */
function cumulate(values: readonly number[], convention: CumulativeConvention): number[] {
  const out: number[] = [];
  if (convention === 'sum') {
    let total = 0;
    for (const value of values) {
      total += value;
      out.push(total);
    }
  } else {
    let factor = 1;
    for (const value of values) {
      factor *= 1 + value;
      out.push(factor - 1);
    }
  }
  return out;
}

interface CrossSectionalTest {
  mean: number;
  tStatistic: number | null;
  tStatisticAbsentReason?: string;
}

/** `t = mean / (sampleStandardDeviation / √n)`; null-with-reason for n < 2 or zero variance. */
function crossSectionalTest(values: readonly number[]): CrossSectionalTest {
  const n = values.length;
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / n;
  if (n < 2) {
    return {
      mean,
      tStatistic: null,
      tStatisticAbsentReason: `the cross-sectional t-statistic needs at least 2 events; received n=${n}.`,
    };
  }
  let sumOfSquares = 0;
  for (const value of values) sumOfSquares += (value - mean) * (value - mean);
  const sampleStandardDeviation = Math.sqrt(sumOfSquares / (n - 1));
  if (sampleStandardDeviation === 0) {
    return {
      mean,
      tStatistic: null,
      tStatisticAbsentReason: `zero cross-sectional variance across the ${n} events at this offset — the t-statistic is undefined, never ±Infinity.`,
    };
  }
  return { mean, tStatistic: mean / (sampleStandardDeviation / Math.sqrt(n)) };
}

type MarketModelFit = { ok: true; model: EventMarketModel } | { ok: false; reason: string };

/** Plain-sums OLS of instrument returns on market returns over the estimation window. */
function fitMarketModel(
  marketSeries: readonly number[],
  instrumentSeries: readonly number[],
): MarketModelFit {
  const n = marketSeries.length;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += marketSeries[i]!;
    sumY += instrumentSeries[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sumXX = 0;
  let sumXY = 0;
  let sumYY = 0;
  for (let i = 0; i < n; i++) {
    const dx = marketSeries[i]! - meanX;
    const dy = instrumentSeries[i]! - meanY;
    sumXX += dx * dx;
    sumXY += dx * dy;
    sumYY += dy * dy;
  }
  if (sumXX === 0) {
    return {
      ok: false,
      reason: `market model inestimable: market returns are constant across the ${n}-session estimation window (zero variance), so beta is undefined.`,
    };
  }
  const beta = sumXY / sumXX;
  const alpha = meanY - beta * meanX;
  if (sumYY === 0) {
    return {
      ok: true,
      model: {
        alpha,
        beta,
        rSquared: null,
        rSquaredAbsentReason:
          'instrument returns are constant across the estimation window — the explained share of zero variance is undefined, so R² is null with this reason, never NaN.',
      },
    };
  }
  return { ok: true, model: { alpha, beta, rSquared: (sumXY * sumXY) / (sumXX * sumYY) } };
}

/** Build the per-offset AAR/CAAR/t rows shared by {@link eventStudy} and the aggregator. */
function buildAverageAbnormalReturns(
  events: readonly EventStudyEventResult[],
  eventWindow: TradingSessionWindow,
  convention: CumulativeConvention,
  warnings: string[],
  emptyWarning: string,
): AverageAbnormalReturnRow[] {
  if (events.length === 0) {
    warnings.push(emptyWarning);
    return [];
  }
  const offsetCount =
    eventWindow.endTradingSessionOffset - eventWindow.startTradingSessionOffset + 1;
  const tests: CrossSectionalTest[] = [];
  const averages: number[] = [];
  for (let k = 0; k < offsetCount; k++) {
    const values = events.map((event) => event.rows[k]!.abnormalReturn);
    const test = crossSectionalTest(values);
    tests.push(test);
    averages.push(test.mean);
  }
  const cumulativeAverages = cumulate(averages, convention);
  return tests.map((test, k) => ({
    tradingSessionOffset: eventWindow.startTradingSessionOffset + k,
    averageAbnormalReturn: test.mean,
    cumulativeAverageAbnormalReturn: cumulativeAverages[k]!,
    eventCount: events.length,
    tStatistic: test.tStatistic,
    ...(test.tStatisticAbsentReason !== undefined
      ? { tStatisticAbsentReason: test.tStatisticAbsentReason }
      : {}),
  }));
}

// ---------------------------------------------------------------------------------------------------
// Overlap detection
// ---------------------------------------------------------------------------------------------------

interface CandidateEvent {
  event: MarketEvent;
  anchorIndex: number;
  anchorTradingSessionDate: string;
  eventRows: AlignedSessionRow[];
  estimationRows?: AlignedSessionRow[];
  marketModel?: EventMarketModel;
}

type SessionSpan = readonly [number, number];

function spansOverlap(a: SessionSpan, b: SessionSpan): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

interface CandidateSpans {
  eventSpan: SessionSpan;
  estimationSpan?: SessionSpan;
}

function spansOf(
  candidate: CandidateEvent,
  eventWindow: TradingSessionWindow,
  estimationWindow: TradingSessionWindow | undefined,
): CandidateSpans {
  const eventSpan: SessionSpan = [
    candidate.anchorIndex + eventWindow.startTradingSessionOffset,
    candidate.anchorIndex + eventWindow.endTradingSessionOffset,
  ];
  if (estimationWindow === undefined) return { eventSpan };
  return {
    eventSpan,
    estimationSpan: [
      candidate.anchorIndex + estimationWindow.startTradingSessionOffset,
      candidate.anchorIndex + estimationWindow.endTradingSessionOffset,
    ],
  };
}

/**
 * A pair conflicts when an EVENT window intrudes anywhere abnormal behaviour must not: the other
 * event's event window, or the estimation window a model fits on. Two estimation windows sharing
 * history do NOT conflict — only an event period inside them contaminates.
 */
function candidatesConflict(a: CandidateSpans, b: CandidateSpans): boolean {
  if (spansOverlap(a.eventSpan, b.eventSpan)) return true;
  if (b.estimationSpan !== undefined && spansOverlap(a.eventSpan, b.estimationSpan)) return true;
  if (a.estimationSpan !== undefined && spansOverlap(a.estimationSpan, b.eventSpan)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------
// eventStudy
// ---------------------------------------------------------------------------------------------------

const EVENT_STUDY_KEYS = [
  'events',
  'returnObservations',
  'marketReturns',
  'eventWindow',
  'estimationWindow',
  'expectedReturnModel',
  'sessionPolicy',
  'overlappingEventPolicy',
  'cumulativeConvention',
] as const;

/**
 * Run an event study: anchor each event on its instrument's sessions under the declared session
 * policy, model expected returns, and disclose abnormal returns per event and across events.
 * Every convention is echoed in `assumptions`; every dropped event is named with its reason in
 * `diagnostics.excludedEvents` — see the module header for the exact anchoring and overlap rules.
 */
export function eventStudy(input: EventStudyInput): EventStudyResult {
  const functionName = 'eventStudy';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, EVENT_STUDY_KEYS);
  requireEvents(functionName, input.events);
  requireReturnObservations(functionName, 'returnObservations', input.returnObservations);
  requireSessionWindow(functionName, 'eventWindow', input.eventWindow);
  const modelLabel = requireExpectedReturnModel(functionName, input.expectedReturnModel);
  const model = input.expectedReturnModel;
  const needsEstimation = model.model === 'mean-adjusted' || model.model === 'market';
  const needsMarket = model.model === 'market-adjusted' || model.model === 'market';

  const sessionPolicy = resolveEnumOption(
    functionName,
    'sessionPolicy',
    input.sessionPolicy,
    SESSION_POLICIES,
    'next-session',
  );
  const cumulativeConvention = resolveEnumOption(
    functionName,
    'cumulativeConvention',
    input.cumulativeConvention,
    CUMULATIVE_CONVENTIONS,
    'sum',
  );
  if (input.overlappingEventPolicy === undefined) {
    throw new InputError(
      `${functionName}: overlappingEventPolicy is required and has NO default — 'reject' excludes same-instrument events whose windows overlap; 'allow-contaminated' keeps them and lists them in diagnostics.contaminatedEventIds. Overlap handling changes the statistics, so the caller must choose.\n  e.g. ${EVENT_STUDY_EXAMPLE}`,
      { code: ErrorCode.InputMissingField, context: { field: 'overlappingEventPolicy' } },
    );
  }
  const overlappingEventPolicy = resolveEnumOption(
    functionName,
    'overlappingEventPolicy',
    input.overlappingEventPolicy,
    OVERLAP_POLICIES,
    'reject', // unreachable: presence was enforced above; resolveEnumOption only validates here.
  );

  const warnings: string[] = [];

  if (input.estimationWindow !== undefined) {
    requireSessionWindow(functionName, 'estimationWindow', input.estimationWindow);
    if (
      input.estimationWindow.endTradingSessionOffset >= input.eventWindow.startTradingSessionOffset
    ) {
      throw new InputError(
        `${functionName}: estimationWindow.endTradingSessionOffset (${input.estimationWindow.endTradingSessionOffset}) must end strictly BEFORE eventWindow.startTradingSessionOffset (${input.eventWindow.startTradingSessionOffset}) — a model estimated through the event window measures the event twice.\n  e.g. ${functionName}({ ..., estimationWindow: { startTradingSessionOffset: -6, endTradingSessionOffset: -2 }, eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 } })`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'estimationWindow' } },
      );
    }
    if (!needsEstimation) {
      warnings.push(
        `estimationWindow was supplied but the '${model.model}' model does not use one — it is echoed in assumptions and does not participate in overlap detection.`,
      );
    } else if (input.estimationWindow.endTradingSessionOffset >= 0) {
      warnings.push(
        'estimationWindow includes sessions at or after the event session (offset 0) — an expected-return model estimated on post-announcement sessions is contaminated by the event itself.',
      );
    }
  } else if (needsEstimation) {
    throw new InputError(
      `${functionName}: the '${model.model}' model estimates expected returns over a pre-event window — supply estimationWindow (integers, ending strictly before the event window starts).\n  e.g. ${EVENT_STUDY_EXAMPLE}`,
      { code: ErrorCode.InputMissingField, context: { field: 'estimationWindow' } },
    );
  }

  let marketByDate: Map<string, number> | undefined;
  if (input.marketReturns !== undefined) {
    marketByDate = buildMarketReturnIndex(functionName, input.marketReturns);
    if (model.model === 'mean-adjusted') {
      warnings.push("marketReturns were supplied but the 'mean-adjusted' model does not use them.");
    }
  } else if (needsMarket) {
    throw new InputError(
      `${functionName}: the '${model.model}' model needs same-session market returns — supply marketReturns as [{ tradingSessionDate, simpleReturn }].\n  e.g. ${functionName}({ ..., marketReturns: [{ tradingSessionDate: '2024-03-01', simpleReturn: 0.0012 }], expectedReturnModel: { model: '${model.model}' } })`,
      { code: ErrorCode.InputMissingField, context: { field: 'marketReturns' } },
    );
  }

  const sessionsByInstrument = buildInstrumentSessions(functionName, input.returnObservations);

  // -- Per-event alignment and data-completeness (exclusion with reason, never patching) ----------
  const excludedEvents: { eventId: string; reason: string }[] = [];
  const candidates: CandidateEvent[] = [];
  input.events.forEach((event, index) => {
    const exclude = (reason: string): void => {
      excludedEvents.push({ eventId: event.eventId, reason });
    };
    const alignment = alignEventToSessions(
      functionName,
      event,
      `events[${index}]`,
      sessionsByInstrument,
      input.eventWindow,
      sessionPolicy,
    );
    if (!alignment.ok) {
      exclude(alignment.reason);
      return;
    }
    const index2 = sessionsByInstrument.get(event.instrumentId)!;
    let estimationRows: AlignedSessionRow[] | undefined;
    if (needsEstimation) {
      const slice = sliceSessionWindow(
        index2,
        alignment.anchorIndex,
        input.estimationWindow!,
        'estimation window',
      );
      if (!slice.ok) {
        exclude(slice.reason);
        return;
      }
      estimationRows = slice.rows;
    }
    if (needsMarket) {
      const rowsNeedingMarket =
        model.model === 'market' ? [...estimationRows!, ...alignment.rows] : alignment.rows;
      for (const row of rowsNeedingMarket) {
        if (!marketByDate!.has(row.tradingSessionDate)) {
          exclude(
            `no market return was supplied for session ${row.tradingSessionDate} — the '${model.model}' model needs the same-session market return for every event-window${model.model === 'market' ? ' and estimation-window' : ''} session.`,
          );
          return;
        }
      }
    }
    let marketModel: EventMarketModel | undefined;
    if (model.model === 'market') {
      const fit = fitMarketModel(
        estimationRows!.map((row) => marketByDate!.get(row.tradingSessionDate)!),
        estimationRows!.map((row) => row.simpleReturn),
      );
      if (!fit.ok) {
        exclude(fit.reason);
        return;
      }
      marketModel = fit.model;
      if (fit.model.rSquaredAbsentReason !== undefined) {
        warnings.push(`event '${event.eventId}': ${fit.model.rSquaredAbsentReason}`);
      }
    }
    candidates.push({
      event,
      anchorIndex: alignment.anchorIndex,
      anchorTradingSessionDate: alignment.anchorTradingSessionDate,
      eventRows: alignment.rows,
      ...(estimationRows !== undefined ? { estimationRows } : {}),
      ...(marketModel !== undefined ? { marketModel } : {}),
    });
  });

  // -- Overlap policy (same-instrument only; estimation windows participate when the model uses one)
  const effectiveEstimationWindow = needsEstimation ? input.estimationWindow : undefined;
  const contaminatedEventIds: string[] = [];
  const rejectedEventIds = new Set<string>();
  const byInstrument = new Map<string, CandidateEvent[]>();
  for (const candidate of candidates) {
    const group = byInstrument.get(candidate.event.instrumentId);
    if (group === undefined) byInstrument.set(candidate.event.instrumentId, [candidate]);
    else group.push(candidate);
  }
  for (const group of byInstrument.values()) {
    const sorted = [...group].sort(
      (a, b) =>
        a.anchorIndex - b.anchorIndex ||
        a.event.announcedTimestampMs - b.event.announcedTimestampMs ||
        (a.event.eventId < b.event.eventId ? -1 : 1),
    );
    if (overlappingEventPolicy === 'reject') {
      const kept: { candidate: CandidateEvent; spans: CandidateSpans }[] = [];
      for (const candidate of sorted) {
        const spans = spansOf(candidate, input.eventWindow, effectiveEstimationWindow);
        const collision = kept.find((entry) => candidatesConflict(spans, entry.spans));
        if (collision !== undefined) {
          rejectedEventIds.add(candidate.event.eventId);
          excludedEvents.push({
            eventId: candidate.event.eventId,
            reason: `overlappingEventPolicy 'reject': its event window (${candidate.eventRows[0]!.tradingSessionDate}..${candidate.eventRows[candidate.eventRows.length - 1]!.tradingSessionDate}) overlaps the ${effectiveEstimationWindow !== undefined ? 'event or estimation window' : 'event window'} of event '${collision.candidate.event.eventId}' on the same instrument — choose 'allow-contaminated' to keep and disclose contaminated events.`,
          });
        } else {
          kept.push({ candidate, spans });
        }
      }
    } else {
      const spans = sorted.map((candidate) =>
        spansOf(candidate, input.eventWindow, effectiveEstimationWindow),
      );
      const contaminated = new Set<number>();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          if (candidatesConflict(spans[i]!, spans[j]!)) {
            contaminated.add(i);
            contaminated.add(j);
          }
        }
      }
      for (let i = 0; i < sorted.length; i++) {
        if (contaminated.has(i)) contaminatedEventIds.push(sorted[i]!.event.eventId);
      }
    }
  }
  const included = candidates.filter((candidate) => !rejectedEventIds.has(candidate.event.eventId));

  // -- Expected returns, abnormal returns, and cumulation -----------------------------------------
  const eventResults: EventStudyEventResult[] = included.map((candidate) => {
    let estimationMean = 0;
    if (model.model === 'mean-adjusted') {
      let sum = 0;
      for (const row of candidate.estimationRows!) sum += row.simpleReturn;
      estimationMean = sum / candidate.estimationRows!.length;
    }
    const rows: AbnormalReturnRow[] = candidate.eventRows.map((row) => {
      let expectedReturn: number;
      if (model.model === 'mean-adjusted') {
        expectedReturn = estimationMean;
      } else if (model.model === 'market-adjusted') {
        expectedReturn = marketByDate!.get(row.tradingSessionDate)!;
      } else if (model.model === 'market') {
        expectedReturn =
          candidate.marketModel!.alpha +
          candidate.marketModel!.beta * marketByDate!.get(row.tradingSessionDate)!;
      } else {
        const marketReturn = marketByDate?.get(row.tradingSessionDate);
        expectedReturn = model.expectedReturn({
          instrumentId: candidate.event.instrumentId,
          tradingSessionDate: row.tradingSessionDate,
          ...(marketReturn !== undefined ? { marketReturn } : {}),
        });
        if (typeof expectedReturn !== 'number' || !Number.isFinite(expectedReturn)) {
          throw new InputError(
            `${functionName}: expectedReturnModel.expectedReturn returned ${expectedReturn === null ? 'null' : typeof expectedReturn === 'number' ? String(expectedReturn) : typeof expectedReturn} for instrument '${candidate.event.instrumentId}' at ${row.tradingSessionDate} — a structural factor model must return a finite decimal return for every session it is asked about.`,
            {
              code: ErrorCode.InputWrongType,
              context: { field: 'expectedReturnModel.expectedReturn' },
            },
          );
        }
      }
      return {
        tradingSessionOffset: row.tradingSessionOffset,
        tradingSessionDate: row.tradingSessionDate,
        actualReturn: row.simpleReturn,
        expectedReturn,
        abnormalReturn: row.simpleReturn - expectedReturn,
      };
    });
    const cumulative = cumulate(
      rows.map((row) => row.abnormalReturn),
      cumulativeConvention,
    );
    return {
      eventId: candidate.event.eventId,
      instrumentId: candidate.event.instrumentId,
      anchorTradingSessionDate: candidate.anchorTradingSessionDate,
      ...(candidate.marketModel !== undefined ? { marketModel: candidate.marketModel } : {}),
      rows,
      cumulativeAbnormalReturn: cumulative[cumulative.length - 1]!,
    };
  });

  const averageAbnormalReturns = buildAverageAbnormalReturns(
    eventResults,
    input.eventWindow,
    cumulativeConvention,
    warnings,
    'no events were included — average abnormal returns are empty; diagnostics.excludedEvents carries the per-event reasons.',
  );

  return requireRepresentableResult('eventStudy', {
    assumptions: {
      sessionPolicy,
      cumulativeConvention,
      expectedReturnModel: modelLabel,
      eventWindow: {
        startTradingSessionOffset: input.eventWindow.startTradingSessionOffset,
        endTradingSessionOffset: input.eventWindow.endTradingSessionOffset,
      },
      ...(input.estimationWindow !== undefined
        ? {
            estimationWindow: {
              startTradingSessionOffset: input.estimationWindow.startTradingSessionOffset,
              endTradingSessionOffset: input.estimationWindow.endTradingSessionOffset,
            },
          }
        : {}),
      overlappingEventPolicy,
    },
    diagnostics: {
      warnings,
      eventsSupplied: input.events.length,
      eventsIncluded: eventResults.length,
      excludedEvents,
      contaminatedEventIds,
    },
    events: eventResults,
    averageAbnormalReturns,
  });
}

// ---------------------------------------------------------------------------------------------------
// aggregateEventStudies
// ---------------------------------------------------------------------------------------------------

const AGGREGATE_KEYS = ['studies'] as const;
const RESULT_KEYS = ['assumptions', 'diagnostics', 'events', 'averageAbnormalReturns'] as const;

function formatWindow(window: TradingSessionWindow): string {
  return `[${window.startTradingSessionOffset}, ${window.endTradingSessionOffset}]`;
}

function requireSharedAssumption(
  index: number,
  field: string,
  value: string,
  reference: string,
  why: string,
): void {
  if (value !== reference) {
    throw new InputError(
      `aggregateEventStudies: studies[${index}].assumptions.${field} (${value}) does not match studies[0].assumptions.${field} (${reference}) — ${why}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: `studies[${index}].assumptions.${field}` },
      },
    );
  }
}

/**
 * Pool the INCLUDED events of several {@link eventStudy} results and recompute AAR/CAAR and
 * per-offset t-statistics across the pooled cross-section. Studies must share `sessionPolicy`,
 * `cumulativeConvention`, and `eventWindow` — pooled per-offset statistics are meaningless
 * otherwise, and a mismatch is refused naming both values.
 */
export function aggregateEventStudies(
  input: AggregateEventStudiesInput,
): AggregateEventStudiesResult {
  const functionName = 'aggregateEventStudies';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, AGGREGATE_KEYS);
  if (!Array.isArray(input.studies) || input.studies.length === 0) {
    throw new InputError(
      `${functionName}: studies must be a non-empty array of eventStudy results.\n  e.g. aggregateEventStudies({ studies: [studyA, studyB] })`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'studies' } },
    );
  }
  const studies: readonly EventStudyResult[] = input.studies;
  studies.forEach((study, index) => {
    const path = `studies[${index}]`;
    requireArgumentObject(functionName, path, study);
    for (const key of RESULT_KEYS) {
      if (study[key] === undefined) {
        throw new InputError(
          `${functionName}: ${path} is not an eventStudy result — it must carry assumptions, diagnostics, events, and averageAbnormalReturns.`,
          { code: ErrorCode.InputMissingField, context: { field: `${path}.${key}` } },
        );
      }
    }
  });

  const first = studies[0]!;
  const eventWindow = first.assumptions.eventWindow;
  studies.forEach((study, index) => {
    if (index === 0) return;
    requireSharedAssumption(
      index,
      'sessionPolicy',
      `'${study.assumptions.sessionPolicy}'`,
      `'${first.assumptions.sessionPolicy}'`,
      'pooled offsets are only comparable under one anchoring policy.',
    );
    requireSharedAssumption(
      index,
      'cumulativeConvention',
      `'${study.assumptions.cumulativeConvention}'`,
      `'${first.assumptions.cumulativeConvention}'`,
      'pooled CAR/CAAR under two cumulation conventions is not one statistic.',
    );
    requireSharedAssumption(
      index,
      'eventWindow',
      formatWindow(study.assumptions.eventWindow),
      formatWindow(eventWindow),
      'pooled per-offset statistics need one shared event window.',
    );
  });

  // -- Pool the included events and verify each covers the shared window --------------------------
  const offsetCount =
    eventWindow.endTradingSessionOffset - eventWindow.startTradingSessionOffset + 1;
  const pooledEvents: EventStudyEventResult[] = [];
  studies.forEach((study, studyIndex) => {
    study.events.forEach((event, eventIndex) => {
      if (event.rows.length !== offsetCount) {
        throw new InputError(
          `${functionName}: studies[${studyIndex}].events[${eventIndex}] ('${event.eventId}') carries ${event.rows.length} rows but the shared event window ${formatWindow(eventWindow)} spans ${offsetCount} sessions — aggregate over unmodified eventStudy results.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { field: `studies[${studyIndex}].events[${eventIndex}].rows` },
          },
        );
      }
      event.rows.forEach((row, k) => {
        const expectedOffset = eventWindow.startTradingSessionOffset + k;
        if (row.tradingSessionOffset !== expectedOffset) {
          throw new InputError(
            `${functionName}: studies[${studyIndex}].events[${eventIndex}].rows[${k}] is at offset ${row.tradingSessionOffset}, expected ${expectedOffset} — aggregate over unmodified eventStudy results.`,
            {
              code: ErrorCode.InputOutOfRange,
              context: { field: `studies[${studyIndex}].events[${eventIndex}].rows[${k}]` },
            },
          );
        }
      });
      pooledEvents.push(event);
    });
  });

  // -- Union the diagnostics ----------------------------------------------------------------------
  const warnings: string[] = [];
  const seenWarnings = new Set<string>();
  for (const study of studies) {
    for (const warning of study.diagnostics.warnings) {
      if (!seenWarnings.has(warning)) {
        seenWarnings.add(warning);
        warnings.push(warning);
      }
    }
  }
  const idCounts = new Map<string, number>();
  for (const event of pooledEvents) {
    idCounts.set(event.eventId, (idCounts.get(event.eventId) ?? 0) + 1);
  }
  const duplicatedIds = [...idCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([eventId]) => eventId);
  if (duplicatedIds.length > 0) {
    warnings.push(
      `events ${duplicatedIds.map((eventId) => `'${eventId}'`).join(', ')} appear in more than one study — pooled statistics count them once per appearance.`,
    );
  }

  const models = [...new Set(studies.map((study) => study.assumptions.expectedReturnModel))];
  const overlapPolicies = [
    ...new Set(studies.map((study) => study.assumptions.overlappingEventPolicy)),
  ];
  const estimationWindows = studies.map((study) => study.assumptions.estimationWindow);
  const firstEstimation = estimationWindows[0];
  const estimationShared = estimationWindows.every((window) =>
    window === undefined
      ? firstEstimation === undefined
      : firstEstimation !== undefined &&
        window.startTradingSessionOffset === firstEstimation.startTradingSessionOffset &&
        window.endTradingSessionOffset === firstEstimation.endTradingSessionOffset,
  );
  if (!estimationShared) {
    warnings.push(
      'studies declare differing estimation windows — the aggregate omits estimationWindow from its assumptions; each pooled event keeps the model its own study fitted.',
    );
  }

  const averageAbnormalReturns = buildAverageAbnormalReturns(
    pooledEvents,
    eventWindow,
    first.assumptions.cumulativeConvention,
    warnings,
    'no events were included in any study — pooled average abnormal returns are empty.',
  );

  return {
    assumptions: {
      sessionPolicy: first.assumptions.sessionPolicy,
      cumulativeConvention: first.assumptions.cumulativeConvention,
      expectedReturnModel: models.length === 1 ? models[0]! : `mixed (${models.join(', ')})`,
      eventWindow: {
        startTradingSessionOffset: eventWindow.startTradingSessionOffset,
        endTradingSessionOffset: eventWindow.endTradingSessionOffset,
      },
      ...(estimationShared && firstEstimation !== undefined
        ? {
            estimationWindow: {
              startTradingSessionOffset: firstEstimation.startTradingSessionOffset,
              endTradingSessionOffset: firstEstimation.endTradingSessionOffset,
            },
          }
        : {}),
      overlappingEventPolicy: overlapPolicies.length === 1 ? overlapPolicies[0]! : 'mixed',
    },
    diagnostics: {
      warnings,
      eventsSupplied: studies.reduce((total, study) => total + study.diagnostics.eventsSupplied, 0),
      eventsIncluded: pooledEvents.length,
      excludedEvents: studies.flatMap((study) => study.diagnostics.excludedEvents),
      contaminatedEventIds: [
        ...new Set(studies.flatMap((study) => study.diagnostics.contaminatedEventIds)),
      ],
    },
    events: pooledEvents,
    averageAbnormalReturns,
    studiesAggregated: studies.length,
  };
}

// ---------------------------------------------------------------------------------------------------
// alignEventWindows
// ---------------------------------------------------------------------------------------------------

const ALIGN_KEYS = ['events', 'returnObservations', 'eventWindow', 'sessionPolicy'] as const;

/**
 * The alignment step of {@link eventStudy} alone: per event, the anchor session and the resolved
 * event-window rows, or the exclusion reason. Runs the SAME anchoring code path as `eventStudy` —
 * there is exactly one implementation of the session-policy rules in this module.
 */
export function alignEventWindows(input: AlignEventWindowsInput): AlignEventWindowsResult {
  const functionName = 'alignEventWindows';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ALIGN_KEYS);
  requireEvents(functionName, input.events);
  requireReturnObservations(functionName, 'returnObservations', input.returnObservations);
  requireSessionWindow(functionName, 'eventWindow', input.eventWindow);
  const sessionPolicy = resolveEnumOption(
    functionName,
    'sessionPolicy',
    input.sessionPolicy,
    SESSION_POLICIES,
    'next-session',
  );
  const sessionsByInstrument = buildInstrumentSessions(functionName, input.returnObservations);
  const excludedEvents: { eventId: string; reason: string }[] = [];
  const alignments: AlignedEventWindow[] = [];
  input.events.forEach((event, index) => {
    const alignment = alignEventToSessions(
      functionName,
      event,
      `events[${index}]`,
      sessionsByInstrument,
      input.eventWindow,
      sessionPolicy,
    );
    if (!alignment.ok) {
      excludedEvents.push({ eventId: event.eventId, reason: alignment.reason });
      return;
    }
    alignments.push({
      eventId: event.eventId,
      instrumentId: event.instrumentId,
      anchorTradingSessionDate: alignment.anchorTradingSessionDate,
      rows: alignment.rows,
    });
  });
  return {
    assumptions: {
      sessionPolicy,
      eventWindow: {
        startTradingSessionOffset: input.eventWindow.startTradingSessionOffset,
        endTradingSessionOffset: input.eventWindow.endTradingSessionOffset,
      },
    },
    diagnostics: {
      warnings: [],
      eventsSupplied: input.events.length,
      eventsAligned: alignments.length,
      excludedEvents,
    },
    alignments,
  };
}
