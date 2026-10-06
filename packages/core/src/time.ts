/**
 * Time primitives (spec §7.2).
 *
 * The internal contract is Unix epoch milliseconds. Core calculations NEVER read the system clock;
 * `asOf` is always injected by the caller (design law #5).
 */

import {
  type HolidayRule,
  addDays,
  dayOfWeek,
  nthWeekdayOfMonth,
  observedHoliday,
  ymd,
} from './calendar.js';
import { isoDateToEpochMs, parseIsoDate } from './dates.js';
import { ErrorCode, InputError, UnsupportedError } from './errors.js';

/** Unix epoch milliseconds. */
export type EpochMs = number;

/** Day-count conventions supported in the 0.0.1 surface. */
export type DayCount = 'ACT/365F' | 'ACT/360' | '30/360';

/** Interest compounding conventions. */
/**
 * The ONE public interest-compounding grammar (FC0). Every rate-bearing contract in the library
 * quotes its compounding in this vocabulary — the former core `'continuous' | 'simple'` pair and
 * fixed-income's separate curve grammar (with its bare-number periodic form) are unified here,
 * with no compatibility aliases (pre-1.0). The object form names its meaning: a bare `12` said
 * nothing about being periods-per-year.
 */
export type InterestCompounding =
  | 'simple'
  | 'continuous'
  | 'annual'
  | 'semiannual'
  | 'quarterly'
  | 'monthly'
  | { type: 'periodic'; periodsPerYear: number };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The offset formatter, built ONCE per module and only on first use (InsiderFinance/totalfinance#1).
 *
 * Constructing an `Intl.DateTimeFormat` costs tens of microseconds, and this probe runs once per
 * date-labelled expiry a contract validates — so building one per call made validating a chain cost
 * ~30 µs a row. A formatter is immutable and reusable. It is created lazily, not at import, so
 * importing the module stays side-effect free for bundlers.
 */
let newYorkOffsetFormatter: Intl.DateTimeFormat | undefined;

/**
 * Resolved offsets per UTC wall-clock probe. An offset only depends on the probe, there are a few
 * hundred distinct probes a year, and the map is cleared if a long-running process walks an unusual
 * number of them, so it can never grow without bound. Failures are never cached.
 */
const newYorkOffsetCache = new Map<number, number>();
const NEW_YORK_OFFSET_CACHE_LIMIT = 20_000;

/**
 * The America/New_York UTC offset (minutes east of UTC) in force at a given UTC wall-clock probe —
 * DST-aware via `Intl`. Throws rather than silently assuming EST (wrong by an hour half the year).
 */
function newYorkOffsetMinutes(
  year: number,
  month: number,
  day: number,
  hour: number,
  functionName: string,
): number {
  const probe = Date.UTC(year, month - 1, day, hour);
  const cached = newYorkOffsetCache.get(probe);
  if (cached !== undefined) return cached;
  newYorkOffsetFormatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  });
  const tzName = newYorkOffsetFormatter
    .formatToParts(new Date(probe))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = tzName?.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) {
    throw new UnsupportedError(
      `${functionName}: could not resolve the America/New_York UTC offset from Intl (got "${tzName}").`,
      { code: ErrorCode.TimeTimezoneResolutionFailed, context: { year, month, day, tzName } },
    );
  }
  const minutes = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  if (newYorkOffsetCache.size >= NEW_YORK_OFFSET_CACHE_LIMIT) newYorkOffsetCache.clear();
  newYorkOffsetCache.set(probe, minutes);
  return minutes;
}

/** `"-04:00"` / `"-05:00"`: the New York offset label for a calendar date, for teaching examples. */
function newYorkOffsetLabel(year: number, month: number, day: number): string {
  const minutes = newYorkOffsetMinutes(year, month, day, 12, 'newYorkOffsetLabel');
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * US equity/options early-close (13:00 ET) rules — the ONE table, consumed by `@insiderfinance/totalfinance/calendars`
 * as well: the day after Thanksgiving, and 24 December and 3 July when they fall on a weekday and
 * are not themselves the observed Christmas / Independence Day holiday. A rule returns the
 * candidate date for a year; {@link isUsEquityHalfDay} applies the weekday/observance exclusions.
 */
export const US_EQUITY_HALF_DAY_RULES: readonly HolidayRule[] = [
  // Day after Thanksgiving. Every November has a 4th Thursday, so the generator's "no such
  // occurrence" channel never fires here — propagate it rather than assert it away.
  (y) => {
    const thanksgiving = nthWeekdayOfMonth(y, 11, 4, 4);
    return thanksgiving === null ? null : addDays(thanksgiving, 1);
  },
  (y) => `${y}-12-24`, // Christmas Eve (a weekend or the observed Christmas holiday is not a half day)
  (y) => `${y}-07-03`, // 3 July (a weekend or the observed Independence Day holiday is not a half day)
];

/**
 * Whether a `YYYY-MM-DD` calendar date is a US equity/options early-close day (13:00 ET). Applies
 * {@link US_EQUITY_HALF_DAY_RULES} with the weekend and observed-holiday exclusions, so
 * 2021-12-24 (the observed Christmas holiday) and 2026-07-03 (the observed Independence Day
 * holiday) are full closures, not half days.
 */
export function isUsEquityHalfDay(date: string): boolean {
  const { year, month, day } = parseIsoDate(date);
  const label = ymd(year, month, day);
  const dow = dayOfWeek(label);
  if (dow === 0 || dow === 6) return false;
  if (observedHoliday(year, 12, 25) === label || observedHoliday(year, 7, 4) === label)
    return false;
  return US_EQUITY_HALF_DAY_RULES.some((rule) => rule(year) === label);
}

/**
 * UTC epoch-ms for the **US equity/options market close** on a calendar date — 16:00
 * America/New_York, or 13:00 on an early-close day ({@link isUsEquityHalfDay}) — DST-aware via
 * `Intl`. Use it to resolve a *date-only* option expiry to its end-of-session instant instead of
 * UTC midnight, so a contract stays alive through its expiry trading day. This encodes US-equity
 * hours specifically; it is not a generic exchange close.
 */
export function usEquityCloseUtcMs(year: number, month: number, day: number): EpochMs {
  const hour = isUsEquityHalfDay(ymd(year, month, day)) ? 13 : 16;
  const offsetMinutes = newYorkOffsetMinutes(year, month, day, hour, 'usEquityCloseUtcMs');
  // `hour`:00 on the local ET clock, expressed in UTC, is `Date.UTC(..., hour) − offset`.
  return Date.UTC(year, month - 1, day, hour, 0, 0) - offsetMinutes * 60_000;
}

/**
 * UTC epoch-ms for the **US equity/options market open** (09:30 America/New_York) on a calendar
 * date — DST-aware via `Intl`. The session open is the same on early-close days.
 */
function usEquityOpenUtcMs(year: number, month: number, day: number): EpochMs {
  const offsetMinutes = newYorkOffsetMinutes(year, month, day, 9, 'usEquityOpenUtcMs');
  return Date.UTC(year, month - 1, day, 9, 30, 0) - offsetMinutes * 60_000;
}

/**
 * The instant of a US equity/options session boundary on a `YYYY-MM-DD` date — the one-call way
 * to say "as of today's close" without remembering the DST offset:
 *
 * ```ts
 * market({ spot: 195.3, riskFreeRate: 0.045, volatility: 0.24, asOf: usEquitySessionInstant('2026-07-20', 'close') })
 * ```
 *
 * `'open'` is 09:30 ET; `'close'` is 16:00 ET, or 13:00 ET on an early-close day. Weekends and
 * holidays are not rejected here (the instant still exists); use `@insiderfinance/totalfinance/calendars` to ask
 * whether the market was open.
 */
export function usEquitySessionInstant(date: string, session: 'open' | 'close'): EpochMs {
  const functionName = 'usEquitySessionInstant';
  if (typeof date !== 'string' || !DATE_ONLY.test(date)) {
    throw new InputError(
      `${functionName}: date must be a YYYY-MM-DD calendar date (e.g. '2026-07-20'). Received ${
        typeof date === 'string' ? `"${date}"` : date === null ? 'null' : typeof date
      }.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: 'date', date } },
    );
  }
  if (session !== 'open' && session !== 'close') {
    throw new InputError(
      `${functionName}: session must be 'open' (09:30 ET) or 'close' (16:00 ET, 13:00 on early-close days). Received ${
        typeof session === 'string' ? `"${session}"` : session === null ? 'null' : typeof session
      }.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field: 'session', session },
      },
    );
  }
  const { year, month, day } = parseIsoDate(date);
  return session === 'open'
    ? usEquityOpenUtcMs(year, month, day)
    : usEquityCloseUtcMs(year, month, day);
}

/**
 * `Intl.DateTimeFormat` is expensive to construct and the market-day index runs per contract per
 * level — build the formatter once. Numbering system pinned to `latn` so a host default of e.g.
 * `arab` digits cannot turn the parse into `NaN`.
 */
const NEW_YORK_DATE_PARTS = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  era: 'short',
});

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
/**
 * The largest magnitude the cache serves: one hour inside the ±8.64e15 ms (±100,000,000 days) an
 * ECMAScript time value may hold, so the whole UTC hour of every instant it serves is valid too.
 * A literal, not `8.64e15 - MS_PER_HOUR`, so a bundle that never asks for a market day drops it.
 */
const CACHED_TIME_LIMIT = 8_639_999_996_400_000;

/**
 * Market day per UTC hour. Formatting a date in New York costs a few microseconds, and a flow tape
 * asks for the market day of every print (and of its expiry) — 50,000 prints spent most of
 * `flow()` here. The first time an hour is asked about, the instant is read exactly, as it always
 * was, and the hour is only noted, so work that visits each hour once pays nothing extra. The
 * second time, the hour's first and last milliseconds are read, and if they fall on one New York
 * date the hour stores it. That is sound because every New York offset change falls on a whole UTC
 * hour (the tests check the zone data): inside one hour local time only moves forward, so two ends
 * on one date mean one date throughout. An hour whose ends differ (New York's pre-1883 local mean
 * time, −4:56:02, puts midnight inside one) stores `NaN` and is answered exactly, every time.
 * Cleared when full, like the offset cache above; errors are never stored.
 */
const marketDayByUtcHour = new Map<number, number>();
const MARKET_DAY_CACHE_LIMIT = 8_192;
/** Marks an hour asked about once. Never a day index, which is a whole number or `NaN`. */
const HOUR_SEEN_ONCE = Infinity;

/**
 * The US equity/options market's calendar DAY an instant falls on, as a whole-day index (days since
 * the epoch of the America/New_York calendar date). Differencing two indices gives whole CALENDAR
 * DAYS between two market dates; equality means "same trading date". This is the ONE day boundary
 * shared by 0DTE classification, days-to-expiry counts and earnings day counts: expiries resolve to
 * 16:00 ET (20:00/21:00 UTC), so a UTC-day comparison is already "tomorrow" between 20:00 and
 * 23:59 ET. Pure and clock-free.
 */
export function usEquityMarketDayIndex(epochMs: EpochMs): number {
  // Anything that is not a finite number (`Number.isFinite` refuses every non-number), or that lies
  // at the edge of the time range, keeps the exact path, and with it the exact result or error.
  if (!Number.isFinite(epochMs) || Math.abs(epochMs) > CACHED_TIME_LIMIT) {
    return newYorkDayIndex(epochMs);
  }
  // `new Date` truncates a fractional time toward zero; bucket the instant it actually reads. The
  // start of its UTC hour, for negative instants too (`%` keeps the dividend's sign).
  const instant = Math.trunc(epochMs);
  const hourStart = instant - (((instant % MS_PER_HOUR) + MS_PER_HOUR) % MS_PER_HOUR);
  let day = marketDayByUtcHour.get(hourStart);
  if (day === undefined) {
    const exact = newYorkDayIndex(epochMs);
    if (marketDayByUtcHour.size >= MARKET_DAY_CACHE_LIMIT) marketDayByUtcHour.clear();
    marketDayByUtcHour.set(hourStart, HOUR_SEEN_ONCE);
    return exact;
  }
  if (day === HOUR_SEEN_ONCE) {
    const first = newYorkDayIndex(hourStart);
    day = first === newYorkDayIndex(hourStart + MS_PER_HOUR - 1) ? first : NaN;
    marketDayByUtcHour.set(hourStart, day);
  }
  return Number.isNaN(day) ? newYorkDayIndex(epochMs) : day;
}

/** The New York calendar date of an instant, read from `Intl`: the definition the cache above serves. */
function newYorkDayIndex(epochMs: EpochMs): number {
  const parts = NEW_YORK_DATE_PARTS.formatToParts(new Date(epochMs));
  let year = NaN;
  let month = NaN;
  let day = NaN;
  let bc = false;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'era') bc = part.value.startsWith('B');
  }
  // Date.UTC of the LOCAL Y/M/D — a pure re-encoding of the calendar date, never a re-zoning.
  return Math.round(Date.UTC(bc ? 1 - year : year, month - 1, day) / MS_PER_DAY);
}

/**
 * UTC-midnight epoch of the market DATE an instant falls on — the anchor for weekday / day-of-month
 * arithmetic (`getUTCDay()` on it is the ET weekday) and for whole-day counts against date labels.
 */
export function usEquityMarketDateUtcMs(epochMs: EpochMs): EpochMs {
  return usEquityMarketDayIndex(epochMs) * MS_PER_DAY;
}

/**
 * Parse an option-expiry label to epoch-ms. A bare `YYYY-MM-DD` resolves to {@link usEquityCloseUtcMs}
 * (16:00 ET) — not UTC midnight — so an intraday `asOf` on the expiry date still sees positive
 * time-to-expiry; a full datetime string is parsed as-is. Throws on an unparseable value.
 */
export function optionExpiryToMs(expiry: string): EpochMs {
  // A chain repeats a few dozen labels across thousands of quotes, and each parse is a regular
  // expression plus a calendar round trip. The result depends on the string alone, so successful
  // parses are remembered; a failure is not, and throws its teaching error every time.
  if (typeof expiry !== 'string') return parseOptionExpiry(expiry);
  const cached = expiryMsCache.get(expiry);
  if (cached !== undefined) return cached;
  const ms = parseOptionExpiry(expiry);
  if (expiryMsCache.size >= EXPIRY_MS_CACHE_LIMIT) expiryMsCache.clear();
  expiryMsCache.set(expiry, ms);
  return ms;
}

/** Parsed expiry labels (see {@link optionExpiryToMs}); bounded so distinct labels cannot grow it. */
const expiryMsCache = new Map<string, EpochMs>();
const EXPIRY_MS_CACHE_LIMIT = 1024;

function parseOptionExpiry(expiry: string): EpochMs {
  if (DATE_ONLY.test(expiry)) {
    // Validate it is a real calendar date — `parseIsoDate` rejects e.g. 2026-02-31 rather than letting
    // Date.UTC silently roll it forward to 2026-03-03.
    const { year, month, day } = parseIsoDate(expiry);
    return usEquityCloseUtcMs(year, month, day);
  }
  // Full datetimes must carry an explicit zone (Z or ±HH:MM). A bare '2026-09-18T16:00' would parse
  // in the MACHINE's local zone — the same input yielding different epochs on different boxes breaks
  // the determinism law (design law #5) — so it is rejected with the fix, never silently localized.
  if (DATETIME_ZONED.test(expiry))
    return parseZonedDatetimeMs(expiry, 'optionExpiryToMs', 'expiry');
  if (DATETIME_BARE.test(expiry)) {
    throw new InputError(
      `optionExpiryToMs: datetime expiry "${expiry}" has no timezone — append 'Z' or an offset like '-05:00' (a bare datetime would silently parse in the machine's local zone).`,
      { code: ErrorCode.InputWrongType, context: { expiry } },
    );
  }
  throw new InputError(
    `optionExpiryToMs: cannot parse expiry "${expiry}" — use 'YYYY-MM-DD' (resolves to 16:00 ET) or a zoned ISO datetime.`,
    { code: ErrorCode.InputWrongType, context: { expiry } },
  );
}

// `[Tt ]` and `[Zz]`: RFC 3339 explicitly permits the lowercase date/time separator and zone
// designator, so `2026-07-06t12:00:00z` is the same legal instant as its uppercase form.
// Everything else stays strict.
const DATETIME_ZONED =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/;
const DATETIME_BARE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}/;

/**
 * STRICT zoned-datetime parsing (D2, one expiry law): every component is range-checked and the
 * epoch is computed arithmetically — `Date.parse` is never trusted. Without this,
 * `2026-02-31T16:00:00Z` silently normalizes into March and `T25:00` yields NaN, both of which
 * would flow into "valid by construction" frozen contracts.
 */
function parseZonedDatetimeMs(value: string, functionName: string, field: string): EpochMs {
  const m = DATETIME_ZONED.exec(value);
  if (!m) {
    throw new InputError(`${functionName}: ${field} "${value}" is not a zoned ISO datetime.`, {
      code: ErrorCode.InputWrongType,
      context: { field, value },
    });
  }
  const [, ys, mos, ds, hs, mins, secs, frac, zone] = m;
  // Real calendar date (rejects 2026-02-31 / month 13 instead of rolling forward). Built via
  // setUTCFullYear so years 0000–0099 stay literal — Date.UTC would remap them to 1900–1999.
  const probe = new Date(0);
  probe.setUTCFullYear(Number(ys), Number(mos) - 1, Number(ds));
  const validDate =
    probe.getUTCFullYear() === Number(ys) &&
    probe.getUTCMonth() === Number(mos) - 1 &&
    probe.getUTCDate() === Number(ds);
  const hour = Number(hs);
  const minute = Number(mins);
  const second = secs === undefined ? 0 : Number(secs);
  let offsetMinutes = 0;
  let validZone = true;
  if (zone !== 'Z' && zone !== 'z' && zone !== undefined) {
    const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (!zm) validZone = false;
    else {
      const oh = Number(zm[2]);
      const om = Number(zm[3]);
      // RFC 3339 real-world envelope: offsets run −12:00 … +14:00 EXACTLY — +14:59 is not a
      // real place (the error contract promises this bound, so the code enforces it).
      validZone =
        om <= 59 &&
        (zm[1] === '+' ? oh < 14 || (oh === 14 && om === 0) : oh < 12 || (oh === 12 && om === 0));
      offsetMinutes = (zm[1] === '-' ? -1 : 1) * (oh * 60 + om);
    }
  }
  if (!validDate || hour > 23 || minute > 59 || second > 59 || !validZone) {
    throw new InputError(
      `${functionName}: ${field} "${value}" is not a valid instant — ` +
        (!validDate
          ? 'the calendar date does not exist'
          : !validZone
            ? 'the UTC offset is out of range (−12:00 … +14:00)'
            : 'the time-of-day component is out of range') +
        ' (components are verified exactly; nothing is silently normalized).',
      { code: ErrorCode.InputOutOfRange, context: { field, value } },
    );
  }
  const fracMs = frac === undefined ? 0 : Math.round(Number(frac) * 1000);
  // Time-of-day arithmetic on the validated midnight probe (not Date.UTC, which would remap
  // years 0000–0099): midnight epoch + h/m/s/frac − zone offset.
  return (
    probe.getTime() + ((hour * 60 + minute) * 60 + second) * 1000 + fracMs - offsetMinutes * 60_000
  );
}

/**
 * Resolve a DATE-GRANULAR `asOf` to epoch ms — ledgers, calendars, fundamentals, performance and
 * research windows, where "as of 2026-07-06" means the calendar date. Deterministic by
 * construction: bare dates resolve to UTC midnight, datetimes require an explicit zone, and
 * anything else throws a teaching error (never a machine-local parse).
 *
 * Option-pricing paths must NOT use this door: a bare date hides the time of day that a same-day
 * option's value depends on. They resolve through {@link resolveValuationAsOf}, which rejects a
 * date-only `asOf` with the fix.
 */
export function resolveAsOf(asOf: EpochMs | string, functionName = 'resolveAsOf'): EpochMs {
  if (typeof asOf === 'number') {
    // The numeric branch obeys the first-touch law too: NaN/Infinity here would flow downstream
    // as a poisoned timestamp and surface far from the mistake.
    if (!Number.isFinite(asOf)) {
      throw new InputError(
        `${functionName}: asOf must be finite epoch milliseconds. Received ${asOf}. TotalFinance never reads the system clock — pass the current instant from your own clock (epoch milliseconds or a zoned ISO datetime).`,
        { code: ErrorCode.InputNotFinite, context: { asOf } },
      );
    }
    return asOf;
  }
  if (typeof asOf === 'string') {
    if (DATE_ONLY.test(asOf)) {
      // Validates the calendar date AND keeps years 0000–0099 literal (isoDateToEpochMs builds the
      // epoch via setUTCFullYear; a direct Date.UTC would remap those years to 1900–1999).
      return isoDateToEpochMs(asOf);
    }
    if (DATETIME_ZONED.test(asOf)) return parseZonedDatetimeMs(asOf, functionName, 'asOf');
    if (DATETIME_BARE.test(asOf)) {
      throw new InputError(
        `${functionName}: asOf datetime "${asOf}" has no timezone — append 'Z' or an offset like '-05:00' (a bare datetime would silently parse in the machine's local zone).`,
        { code: ErrorCode.InputWrongType, context: { asOf } },
      );
    }
    throw new InputError(
      `${functionName}: cannot parse asOf "${asOf}" — use epoch milliseconds, 'YYYY-MM-DD', or a zoned ISO datetime.`,
      { code: ErrorCode.InputWrongType, context: { asOf } },
    );
  }
  throw new InputError(
    `${functionName}: asOf must be epoch milliseconds or an ISO date string. Received ${asOf === null ? 'null' : typeof asOf}.`,
    { code: ErrorCode.InputWrongType, context: { asOf } },
  );
}

/**
 * Resolve a VALUATION instant (`asOf`) to epoch ms — the door every option-pricing path uses
 * (options, strategy, volatility, structure, scenarios, risk marking). Accepts finite epoch
 * milliseconds or a zoned ISO datetime. A date-only string is REJECTED with the fix: the time of
 * day is the whole answer for a same-day option (a bare date resolved to UTC midnight valued a
 * 0DTE at 10:30 ET with 3.6× its remaining life), and the expiry side already refuses a bare date
 * that does not name its instant. `usEquitySessionInstant(date, 'close')` is the one-call form
 * for an end-of-day mark.
 */
export function resolveValuationAsOf(
  asOf: EpochMs | string,
  functionName = 'resolveValuationAsOf',
): EpochMs {
  if (typeof asOf === 'string' && DATE_ONLY.test(asOf)) {
    // Validate the calendar date first so an impossible date teaches THAT, not the instant rule.
    const { year, month, day } = parseIsoDate(asOf);
    const offset = newYorkOffsetLabel(year, month, day);
    throw new InputError(
      `${functionName}: asOf "${asOf}" is a date with no time of day, and a valuation instant needs one — a same-day option's value depends on it. Pass a zoned datetime like "${asOf}T10:30:00${offset}", epoch milliseconds, or usEquitySessionInstant('${asOf}', 'close') for that day's US market close.`,
      {
        code: ErrorCode.TimeValuationInstantRequired,
        context: { function: functionName, field: 'asOf', asOf },
      },
    );
  }
  return resolveAsOf(asOf, functionName);
}

/**
 * ONE expiry law, cross-field (E2): validate that a resolved option-expiry triple —
 * `expiry` label, `expiresAt` instant, `expiryConvention` — is internally consistent:
 *
 *   - the label parses, and its form matches the convention (date-only ⇔ `us-equity-close`,
 *     zoned datetime ⇔ `explicit-instant`);
 *   - `expiresAt` is the finite instant the label resolves to under that convention.
 *
 * Shared by the contract schema and the pro pricing entrypoints, so a hand-assembled or
 * post-hoc-edited contract can never smuggle a contradictory resolution past an engine.
 */
export function validateResolvedExpiry(
  functionName: string,
  expiry: string,
  expiresAt: unknown,
  expiryConvention: unknown,
): void {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    throw new InputError(
      `${functionName}: contract.expiresAt must be a finite epoch-ms instant (got ${String(expiresAt)}). ` +
        'Build contracts with the option builders — a raw literal is not a resolved contract.',
      { code: ErrorCode.InputMissingField, context: { function: functionName, expiresAt } },
    );
  }
  const isDateOnly = typeof expiry === 'string' && DATE_ONLY.test(expiry);
  const expected = isDateOnly ? 'us-equity-close' : 'explicit-instant';
  if (expiryConvention !== expected) {
    throw new InputError(
      `${functionName}: expiryConvention "${String(expiryConvention)}" contradicts the expiry label ` +
        `"${expiry}" (${isDateOnly ? 'a date-only label resolves via' : 'a zoned instant is'} ` +
        `'${expected}').`,
      {
        code: ErrorCode.InputWrongShape,
        context: { function: functionName, expiry, expiryConvention },
      },
    );
  }
  const fromLabel = optionExpiryToMs(expiry);
  if (fromLabel !== expiresAt) {
    throw new InputError(
      `${functionName}: contract.expiry "${expiry}" resolves to ${fromLabel} but contract.expiresAt is ` +
        `${expiresAt} — the contract was mutated after construction. Rebuild it with the option ` +
        'builders instead of editing fields.',
      {
        code: ErrorCode.InputWrongShape,
        context: { function: functionName, expiry, expiresAt, fromLabel },
      },
    );
  }
}

/**
 * Resolve an expiry label to the REQUIRED contract fields (E2): the spreadable
 * `{ expiresAt, expiryConvention }` pair for constructing an `OptionContract` from a label —
 * the same resolution the option builders stamp. Prefer the builders for user-facing code;
 * this exists for adapters and tests assembling contracts inline.
 */
export function resolvedExpiry(expiry: string): {
  expiresAt: EpochMs;
  expiryConvention: 'us-equity-close' | 'explicit-instant';
} {
  return {
    expiresAt: optionExpiryToMs(expiry),
    expiryConvention: DATE_ONLY.test(expiry) ? 'us-equity-close' : 'explicit-instant',
  };
}
