/**
 * Calendar interface, rules engine, and tiny calendars (spec §7.3, §22.4).
 *
 * Core owns the *machinery* (the interface, roll/observance rules, holiday-rule generators, and the
 * `createRuleCalendar` factory) and two tiny calendars that need no holiday datasets (`alwaysOpen`,
 * `weekendsOnly`). Exchange-specific holiday *data* lives in `@insiderfinance/totalfinance/calendars`, so core never
 * bundles exchange datasets.
 */

import { isoDateToEpochMs, parseIsoDate } from './dates.js';
import { ConfigurationError, ErrorCode, InputError } from './errors.js';
import { ensureKnownKeys, requireArgumentObject } from './invariants.js';

const MS_PER_DAY = 86_400_000;

/**
 * Business-day arithmetic cap: |n| beyond a million business days (~4,000 years) is a bug —
 * typically an accidental epoch or an unconverted millisecond count — not a request.
 */
const MAX_BUSINESS_DAY_STEPS = 1_000_000;

/** Day of week, Sunday = 0 … Saturday = 6. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface DaySession {
  date: string;
  isBusinessDay: boolean;
  isHalfDay: boolean;
  /** Local `HH:MM` open (present only on business days). */
  open?: string;
  /** Local `HH:MM` close (early close on half days). */
  close?: string;
}

export interface Calendar {
  readonly name: string;
  readonly version: string;
  readonly timezone: string;
  isBusinessDay(date: string): boolean;
  isHoliday(date: string): boolean;
  isHalfDay(date: string): boolean;
  nextBusinessDay(date: string): string;
  previousBusinessDay(date: string): string;
  addBusinessDays(date: string, days: number): string;
  /** Business days in the half-open interval `(from, to]` (negative if `to < from`). */
  businessDaysBetween(from: string, to: string): number;
  session(date: string): DaySession;
}

// ---- date helpers (UTC, no clock reads) ----

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatEpoch(ms: number): string {
  const d = new Date(ms);
  // Pad the year too: years 0–999 must format as ISO `0099-…`, not a malformed `99-…`.
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * A `Date` probe at UTC midnight built via `setUTCFullYear`, so years 0000–0099 stay literal —
 * `Date.UTC` would remap them into 1900–1999 (the legacy two-digit convention) and silently
 * corrupt day-of-week and month-length reads for ancient dates.
 */
function utcProbe(year: number, monthIndex: number, day: number): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, monthIndex, day);
  return d;
}

/** Day of week for an ISO date. */
export function dayOfWeek(date: string): Weekday {
  return new Date(isoDateToEpochMs(date)).getUTCDay() as Weekday;
}

/** Add `n` calendar days to an ISO date. */
export function addDays(date: string, days: number): string {
  return formatEpoch(isoDateToEpochMs(date) + days * MS_PER_DAY);
}

/** Compose an ISO date from components. */
export function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

// ---- holiday-rule generators ----

/**
 * The `occurrence`-th (1-based) `weekday` of a month, e.g. 3rd Monday of January. Returns `null`
 * when the month has no such occurrence (e.g. a 5th Friday in a 4-Friday February) — the same
 * "not observed" channel {@link HolidayRule} already speaks — rather than fabricating an
 * impossible date like `2026-02-34`.
 */
export function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: Weekday,
  occurrence: number,
): string | null {
  if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
    throw new InputError(
      `nthWeekdayOfMonth: occurrence must be an integer >= 1 (1st, 2nd, 3rd, …). Received ${String(occurrence)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'occurrence', value: occurrence } },
    );
  }
  const firstDow = utcProbe(year, month - 1, 1).getUTCDay();
  const day = 1 + ((weekday - firstDow + 7) % 7) + (occurrence - 1) * 7;
  // Day 0 of the NEXT month is the last day of this one.
  const daysInMonth = utcProbe(year, month, 0).getUTCDate();
  if (day > daysInMonth) return null;
  return ymd(year, month, day);
}

/** The last `weekday` of a month, e.g. last Monday of May. */
export function lastWeekdayOfMonth(year: number, month: number, weekday: Weekday): string {
  const lastDay = utcProbe(year, month, 0).getUTCDate();
  const lastDow = utcProbe(year, month - 1, lastDay).getUTCDay();
  const day = lastDay - ((lastDow - weekday + 7) % 7);
  return ymd(year, month, day);
}

/** Apply the US observance rule: Saturday → preceding Friday, Sunday → following Monday. */
export function observedHoliday(year: number, month: number, day: number): string {
  const dow = utcProbe(year, month - 1, day).getUTCDay();
  if (dow === 6) return addDays(ymd(year, month, day), -1);
  if (dow === 0) return addDays(ymd(year, month, day), 1);
  return ymd(year, month, day);
}

/** Easter Sunday via the Anonymous Gregorian algorithm (Computus). */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Good Friday (two days before Easter Sunday). */
export function goodFriday(year: number): string {
  const e = easterSunday(year);
  return addDays(ymd(year, e.month, e.day), -2);
}

// ---- rules engine ----

/** A holiday/half-day rule: given a year, return the ISO date it falls on, or `null` if not observed. */
export type HolidayRule = (year: number) => string | null;

export interface CalendarConfig {
  name: string;
  version: string;
  timezone: string;
  /** Default `[0, 6]` (Sun & Sat). */
  weekendDays?: Weekday[];
  /**
   * Regular session hours as `HH:MM` in the calendar's `timezone`. `close: '24:00'` is the sentinel
   * for "no close" — a continuous 24-hour session (e.g. `alwaysOpen`/crypto), distinct from `'00:00'`
   * (midnight). Keep it as `'24:00'`; do not normalize to `'00:00'`.
   */
  session: { open: string; close: string; halfDayClose?: string };
  holidayRules?: HolidayRule[];
  halfDayRules?: HolidayRule[];
  /** Ad-hoc full closures (ISO dates), e.g. emergency closures or days of mourning. */
  closures?: string[];
}

/**
 * Build a `Calendar` from rules. Holiday/half-day sets are computed lazily per year and cached.
 *
 * The config is SNAPSHOTTED at construction — rule arrays, closures, weekend days, and the session
 * object are copied — so mutating the caller's config (or a shared exported rules array) later can
 * never make one calendar answer the same question two ways across warm and cold cache years.
 */
export function createRuleCalendar(config: CalendarConfig): Calendar {
  requireArgumentObject('createRuleCalendar', 'config', config);
  ensureKnownKeys('createRuleCalendar', 'config', config, [
    'name',
    'version',
    'timezone',
    'weekendDays',
    'session',
    'holidayRules',
    'halfDayRules',
    'closures',
  ]);
  for (const field of ['name', 'version', 'timezone'] as const) {
    const value = (config as unknown as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new InputError(
        `createRuleCalendar: ${field} must be a non-empty string. Received ${value === null ? 'null' : value === undefined ? 'undefined' : typeof value}.`,
        {
          code: value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
          context: { field },
        },
      );
    }
  }
  requireArgumentObject('createRuleCalendar', 'session', config.session);
  ensureKnownKeys('createRuleCalendar', 'session', config.session, [
    'open',
    'close',
    'halfDayClose',
  ] as const);
  for (const clockField of ['open', 'close'] as const) {
    const clockValue = (config.session as unknown as Record<string, unknown>)[clockField];
    if (typeof clockValue !== 'string' || clockValue.length === 0) {
      throw new InputError(
        `createRuleCalendar: session.${clockField} must be an HH:MM string. Received ${clockValue === null ? 'null' : clockValue === undefined ? 'undefined' : typeof clockValue}.`,
        {
          code: clockValue === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
          context: { field: `session.${clockField}` },
        },
      );
    }
  }
  const halfDayClose = (config.session as unknown as Record<string, unknown>)['halfDayClose'];
  if (
    halfDayClose !== undefined &&
    (typeof halfDayClose !== 'string' || halfDayClose.length === 0)
  ) {
    throw new InputError(
      `createRuleCalendar: session.halfDayClose must be an HH:MM string when provided. Received ${halfDayClose === null ? 'null' : typeof halfDayClose}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'session.halfDayClose' } },
    );
  }
  for (const field of ['weekendDays', 'holidayRules', 'halfDayRules', 'closures'] as const) {
    const v = (config as unknown as Record<string, unknown>)[field];
    if (v !== undefined && !Array.isArray(v)) {
      throw new InputError(
        `createRuleCalendar: ${field} must be an array when provided. Received ${v === null ? 'null' : typeof v}.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
  const weekend = new Set<number>(config.weekendDays ?? [0, 6]);
  // A weekend covering all 7 weekdays leaves no candidate business day: nextBusinessDay /
  // addBusinessDays would scan forever. Reject the contradiction at construction, loudly.
  // Counted over the REAL weekdays (0–6), so an out-of-range entry cannot fake a full week.
  if (![0, 1, 2, 3, 4, 5, 6].some((d) => !weekend.has(d))) {
    throw new ConfigurationError(
      `createRuleCalendar: "${config.name}" has no business days — all 7 are in weekendDays. Leave one open (closures/holidayRules express full closures).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { calendar: config.name, weekendDays: config.weekendDays },
      },
    );
  }
  const closures = new Set(config.closures ?? []);
  const holidayRules = [...(config.holidayRules ?? [])];
  const halfDayRules = [...(config.halfDayRules ?? [])];
  const sessionHours = { ...config.session };
  const holidayCache = new Map<number, Set<string>>();
  const halfDayCache = new Map<number, Set<string>>();

  const datesFor = (
    cache: Map<number, Set<string>>,
    rules: HolidayRule[],
    year: number,
  ): Set<string> => {
    let set = cache.get(year);
    if (!set) {
      set = new Set();
      const prefix = `${year}-`;
      // Evaluate the neighbouring years too: an observed-holiday rule can resolve a date INTO an
      // adjacent year (e.g. a Saturday holiday observed on the preceding Friday, or a New-Year rule
      // that lands on Dec 31). Keep only the results that fall in the queried year.
      for (const y of [year - 1, year, year + 1]) {
        for (const rule of rules) {
          const date = rule(y);
          if (date !== null && date.startsWith(prefix)) set.add(date);
        }
      }
      cache.set(year, set);
    }
    return set;
  };

  const isHoliday = (date: string): boolean => {
    const { year } = parseIsoDate(date);
    return closures.has(date) || datesFor(holidayCache, holidayRules, year).has(date);
  };

  const isWeekend = (date: string): boolean => weekend.has(dayOfWeek(date));

  const isBusinessDay = (date: string): boolean => !isWeekend(date) && !isHoliday(date);

  const isHalfDay = (date: string): boolean => {
    if (!isBusinessDay(date)) return false;
    const { year } = parseIsoDate(date);
    return datesFor(halfDayCache, halfDayRules, year).has(date);
  };

  /** Scan day-by-day in `step` direction to the next business day (one mirror-image scan, not two). */
  const scan = (date: string, step: 1 | -1): string => {
    let d = addDays(date, step);
    while (!isBusinessDay(d)) d = addDays(d, step);
    return d;
  };

  const nextBusinessDay = (date: string): string => scan(date, 1);

  const previousBusinessDay = (date: string): string => scan(date, -1);

  const addBusinessDays = (date: string, n: number): string => {
    // Integer-only: Infinity would loop forever (Infinity - 1 === Infinity), a fractional n would
    // silently round, and NaN would silently return the input date.
    if (!Number.isInteger(n)) {
      throw new InputError(
        `addBusinessDays: n must be an integer number of business days, got ${n}.`,
        { code: ErrorCode.InputOutOfRange, context: { businessDays: n } },
      );
    }
    if (Math.abs(n) > MAX_BUSINESS_DAY_STEPS) {
      throw new InputError(
        `addBusinessDays: |n| must be <= ${MAX_BUSINESS_DAY_STEPS} business days, got ${n} — a timestamp passed as a day count?`,
        { code: ErrorCode.InputOutOfRange, context: { businessDays: n } },
      );
    }
    if (n === 0) return date;
    const step = n > 0 ? 1 : -1;
    let remaining = Math.abs(n);
    let d = date;
    while (remaining-- > 0) d = scan(d, step);
    return d;
  };

  const businessDaysBetween = (from: string, to: string): number => {
    const fromMs = isoDateToEpochMs(from);
    const toMs = isoDateToEpochMs(to);
    if (fromMs === toMs) return 0;
    const sign = toMs > fromMs ? 1 : -1;
    let count = 0;
    let d = from;
    while (d !== to) {
      d = addDays(d, sign);
      if (isBusinessDay(d)) count += sign;
    }
    return count;
  };

  const session = (date: string): DaySession => {
    const business = isBusinessDay(date);
    const half = business && isHalfDay(date);
    if (!business) return { date, isBusinessDay: false, isHalfDay: false };
    return {
      date,
      isBusinessDay: true,
      isHalfDay: half,
      // Read the construction-time snapshot — a later mutation of the caller's config object must
      // not change what a warm calendar reports.
      open: sessionHours.open,
      close: half ? (sessionHours.halfDayClose ?? sessionHours.close) : sessionHours.close,
    };
  };

  return {
    name: config.name,
    version: config.version,
    timezone: config.timezone,
    isBusinessDay,
    isHoliday,
    isHalfDay,
    nextBusinessDay,
    previousBusinessDay,
    addBusinessDays,
    businessDaysBetween,
    session,
  };
}

/** A 24/7 calendar (every day is a business day) — e.g. crypto. */
export const alwaysOpen: Calendar = createRuleCalendar({
  name: 'ALWAYS_OPEN',
  version: '1.0.0',
  timezone: 'UTC',
  weekendDays: [],
  session: { open: '00:00', close: '24:00' },
});

/** A calendar whose only non-business days are weekends. */
export const weekendsOnly: Calendar = createRuleCalendar({
  name: 'WEEKENDS_ONLY',
  version: '1.0.0',
  timezone: 'UTC',
  session: { open: '00:00', close: '24:00' },
});

/**
 * Define a custom calendar (spec §22.4 extension API). A thin wrapper over `createRuleCalendar` so
 * the extension surface is stable even if the engine evolves.
 */
export function defineCalendar(config: CalendarConfig): Calendar {
  return createRuleCalendar(config);
}
