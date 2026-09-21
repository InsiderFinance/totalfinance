/**
 * Fixed-income market conventions (spec §14): day counts, business-day adjustment, and coupon
 * schedule generation. These are the shared primitives every other module in `@totalfinance/fixed-income`
 * builds on (bonds, curves, rates derivatives, credit).
 *
 * Pure and clock-free (design law #5): every function operates on explicit ISO `YYYY-MM-DD` inputs or
 * an injected {@link Calendar}; none read the system clock. The day-count layer extends the three
 * conventions in `@totalfinance/core` (`ACT/365F`, `ACT/360`, `30/360`) with the two remaining standards
 * fixed income needs — `ACT/ACT` (ISDA) and `30E/360` (Eurobond).
 */

import {
  ensureKnownKeys,
  type Calendar,
  type DayCount as CoreDayCount,
  InputError,
  ErrorCode,
  isoDateToEpochMs,
  parseIsoDate,
  weekendsOnly,
  yearFraction as coreYearFraction,
  ymd,
  requireArgumentObject,
} from '@totalfinance/core';

const MS_PER_DAY = 86_400_000;

/**
 * Hard cap on the settlement lag (2026-08-23 review, P0): every lag day is one business-day walk
 * step per schedule period — through whatever Calendar the caller supplied, capped or not — so an
 * astronomical "integer" made schedule generation effectively non-terminating. 260 business days
 * is a full year; real settlement conventions are 0–5.
 */
const MAX_PAYMENT_LAG_DAYS = 260;

/**
 * Day-count conventions supported by the fixed-income surface — the three from `@totalfinance/core` plus
 * `ACT/ACT` (ISDA, calendar-year split) and `30E/360` (the Eurobond 30/360 variant).
 */
export type FixedIncomeDayCount = CoreDayCount | 'ACT/ACT' | '30E/360';

/** The day counts handled directly here (everything else delegates to `@totalfinance/core`). */
const FI_DAY_COUNTS = new Set<FixedIncomeDayCount>([
  'ACT/365F',
  'ACT/360',
  '30/360',
  'ACT/ACT',
  '30E/360',
]);

// ---------------------------------------------------------------------------------------------------
// Calendar arithmetic helpers (UTC, no clock reads)
// ---------------------------------------------------------------------------------------------------

/** Gregorian leap-year test. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a Gregorian year (365 or 366). */
export function daysInYear(year: number): number {
  return isLeapYear(year) ? 366 : 365;
}

/** Days in a given month (`month` is 1-12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whether an ISO date is the last calendar day of its month. */
export function isEndOfMonth(date: string): boolean {
  const { year, month, day } = parseIsoDate(date);
  return day === daysInMonth(year, month);
}

/**
 * Add `months` to an ISO date. The day-of-month is clamped to the target month's length; when
 * `endOfMonth` is set the result snaps to the last day of the target month (the convention used when
 * a coupon schedule anchors on a month-end date).
 */
export function addMonths(date: string, months: number, endOfMonth = false): string {
  const { year, month, day } = parseIsoDate(date);
  const total = year * 12 + (month - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = daysInMonth(ny, nm);
  const nd = endOfMonth ? last : Math.min(day, last);
  return ymd(ny, nm, nd);
}

/** Compare two ISO dates: negative if `a < b`, 0 if equal, positive if `a > b`. */
export function compareDates(first: string, second: string): number {
  return isoDateToEpochMs(first) - isoDateToEpochMs(second);
}

/** Actual elapsed days between two ISO dates (signed). */
function actualDays(from: string, to: string): number {
  return (isoDateToEpochMs(to) - isoDateToEpochMs(from)) / MS_PER_DAY;
}

// ---------------------------------------------------------------------------------------------------
// Day-count year fractions
// ---------------------------------------------------------------------------------------------------

/** ACT/ACT (ISDA): each calendar year's actual days divided by that year's actual day basis. */
function actActIsda(from: string, to: string): number {
  if (compareDates(from, to) > 0) return -actActIsda(to, from);
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  if (a.year === b.year) return actualDays(from, to) / daysInYear(a.year);
  // Stub at the start (from → end of its year), whole years between, stub at the end.
  let frac = actualDays(from, ymd(a.year + 1, 1, 1)) / daysInYear(a.year);
  for (let y = a.year + 1; y < b.year; y++) frac += 1;
  frac += actualDays(ymd(b.year, 1, 1), to) / daysInYear(b.year);
  return frac;
}

/** 30E/360 (Eurobond): both day numbers capped at 30, then the 30/360 linear formula. */
function thirtyE360(from: string, to: string): number {
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  const d1 = Math.min(a.day, 30);
  const d2 = Math.min(b.day, 30);
  return (360 * (b.year - a.year) + 30 * (b.month - a.month) + (d2 - d1)) / 360;
}

/**
 * Year fraction between two ISO dates under a fixed-income day-count convention. `ACT/ACT` and
 * `30E/360` are implemented here; the three core conventions delegate to `@totalfinance/core`.
 */
export function yearFraction(
  from: string,
  to: string,
  dayCount: FixedIncomeDayCount = 'ACT/ACT',
): number {
  switch (dayCount) {
    case 'ACT/ACT':
      return actActIsda(from, to);
    case '30E/360':
      return thirtyE360(from, to);
    case 'ACT/365F':
    case 'ACT/360':
    case '30/360':
      return coreYearFraction(from, to, dayCount);
    default:
      throw new InputError(`yearFraction: Unknown day-count convention "${String(dayCount)}".`, {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'dayCount', value: dayCount, supported: [...FI_DAY_COUNTS] },
      });
  }
}

// ---------------------------------------------------------------------------------------------------
// Business-day adjustment
// ---------------------------------------------------------------------------------------------------

/** Business-day roll conventions (spec §14). */
export type BusinessDayConvention =
  | 'unadjusted'
  | 'following'
  | 'modifiedFollowing'
  | 'preceding'
  | 'modifiedPreceding';

/**
 * Roll a date to a good business day under `convention`, using `calendar` to decide which days are
 * business days (defaults to weekends-only, so callers need no holiday data to get sane results).
 *
 * - `following` / `preceding` roll forward / backward to the nearest business day.
 * - The `modified` variants roll the same way but reverse direction if the roll would cross into a
 *   different calendar month (the standard swap-market rule).
 */
const BUSINESS_DAY_CONVENTIONS = [
  'unadjusted',
  'following',
  'preceding',
  'modifiedFollowing',
  'modifiedPreceding',
] as const satisfies readonly BusinessDayConvention[];

export function adjustDate(
  date: string,
  convention: BusinessDayConvention = 'modifiedFollowing',
  calendar: Calendar = weekendsOnly,
): string {
  // Positional front door: an omitted date used to crash deep in parseIsoDate, and a misspelled
  // convention fell through the switch and returned the date UNADJUSTED as if it had rolled.
  if (typeof date !== 'string' || date.length === 0) {
    throw new InputError(
      `adjustDate: date must be an ISO date string — adjustDate('2026-01-17', 'modifiedFollowing'). Received ${date === undefined ? 'undefined' : date === null ? 'null' : typeof date}.`,
      { code: ErrorCode.InputWrongType, context: { function: 'adjustDate', field: 'date' } },
    );
  }
  if (!(BUSINESS_DAY_CONVENTIONS as readonly string[]).includes(convention)) {
    throw new InputError(
      `adjustDate: convention must be one of ${BUSINESS_DAY_CONVENTIONS.join(' | ')}. Received ${convention === null ? 'null' : JSON.stringify(convention)}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: 'adjustDate', field: 'convention', received: convention },
      },
    );
  }
  if (convention === 'unadjusted' || calendar.isBusinessDay(date)) {
    if (convention === 'unadjusted') return date;
    if (calendar.isBusinessDay(date)) return date;
  }
  switch (convention) {
    case 'following':
      return calendar.nextBusinessDay(date);
    case 'preceding':
      return calendar.previousBusinessDay(date);
    case 'modifiedFollowing': {
      const next = calendar.nextBusinessDay(date);
      return parseIsoDate(next).month !== parseIsoDate(date).month
        ? calendar.previousBusinessDay(date)
        : next;
    }
    case 'modifiedPreceding': {
      const prev = calendar.previousBusinessDay(date);
      return parseIsoDate(prev).month !== parseIsoDate(date).month
        ? calendar.nextBusinessDay(date)
        : prev;
    }
    default:
      throw new InputError(`adjustDate: Unknown business-day convention "${String(convention)}".`, {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'convention', value: convention },
      });
  }
}

// ---------------------------------------------------------------------------------------------------
// Coupon schedule generation
// ---------------------------------------------------------------------------------------------------

/** Coupon payment frequency, named or as an explicit number of payments per year. */
export type Frequency = 'annual' | 'semiannual' | 'quarterly' | 'bimonthly' | 'monthly' | number;

/** Resolve a {@link Frequency} to an integer number of payments per year (must divide 12 evenly). */
export function paymentsPerYear(frequency: Frequency): number {
  const n =
    typeof frequency === 'number'
      ? frequency
      : { annual: 1, semiannual: 2, quarterly: 4, bimonthly: 6, monthly: 12 }[frequency];
  // isSafeInteger for uniformity (2026-08-23 review, P0) — `12 % n !== 0` already rejects any
  // unsafe magnitude (12 % 2^53 = 12), so n is pinned to {1, 2, 3, 4, 6, 12}.
  if (n === undefined || !Number.isSafeInteger(n) || n < 1 || 12 % n !== 0) {
    throw new InputError(
      `paymentsPerYear: Invalid coupon frequency "${String(frequency)}" (expected a name or a divisor of 12).`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'frequency', value: frequency } },
    );
  }
  return n;
}

export interface ScheduleOptions {
  /** First accrual date (dated/effective date). */
  effectiveDate: string;
  /** Final accrual date (maturity). */
  maturityDate: string;
  frequency: Frequency;
  /** Business-day roll applied to payment dates (default `modifiedFollowing`). */
  convention?: BusinessDayConvention;
  /** Calendar deciding business days (default weekends-only). */
  calendar?: Calendar;
  /** Force month-end rolling; defaults to auto-detect from whether `maturityDate` is a month end. */
  endOfMonth?: boolean;
  /** Business days between a period's accrual end and its payment (settlement lag). Default 0. */
  paymentLagDays?: number;
}

export interface SchedulePeriod {
  /** Unadjusted accrual start (regular schedule date). */
  accrualStart: string;
  /** Unadjusted accrual end (regular schedule date). */
  accrualEnd: string;
  /** Business-day-adjusted payment date (accrual end rolled, plus any settlement lag). */
  paymentDate: string;
  /** True when this period is a short front stub (shorter than a regular coupon period). */
  isStub: boolean;
}

/**
 * Generate a coupon schedule by rolling backward from maturity at the coupon interval — the market
 * default, which places any irregular ("stub") period at the front. Accrual boundaries are the
 * regular unadjusted dates (so coupon amounts use the true period length); payment dates are
 * business-day-adjusted and optionally lagged.
 */
export function generateSchedule(options: ScheduleOptions): SchedulePeriod[] {
  requireArgumentObject('generateSchedule', 'options', options);
  ensureKnownKeys('generateSchedule', 'options', options, [
    'effectiveDate',
    'maturityDate',
    'frequency',
    'convention',
    'calendar',
    'endOfMonth',
    'paymentLagDays',
  ]);
  const endOfMonthOption = (options as unknown as Record<string, unknown>)['endOfMonth'];
  if (endOfMonthOption !== undefined && typeof endOfMonthOption !== 'boolean') {
    throw new InputError(
      `generateSchedule: endOfMonth must be a boolean when provided. Received ${endOfMonthOption === null ? 'null' : typeof endOfMonthOption}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'endOfMonth' } },
    );
  }
  const calendarOption = (options as unknown as Record<string, unknown>)['calendar'];
  if (
    calendarOption !== undefined &&
    (calendarOption === null || typeof calendarOption !== 'object')
  ) {
    throw new InputError(
      `generateSchedule: calendar must be a Calendar object when provided. Received ${calendarOption === null ? 'null' : typeof calendarOption}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'calendar' } },
    );
  }
  requireArgumentObject('generateSchedule', 'options', options);
  const {
    effectiveDate,
    maturityDate,
    frequency,
    convention = 'modifiedFollowing',
    calendar = weekendsOnly,
    paymentLagDays = 0,
  } = options;

  if (compareDates(effectiveDate, maturityDate) >= 0) {
    throw new InputError('generateSchedule: Schedule requires effectiveDate < maturityDate.', {
      code: ErrorCode.InputOutOfRange,
      context: { effectiveDate, maturityDate },
    });
  }
  // Safe integer AND a work cap (2026-08-23 review, P0): paymentLagDays drives a one-day-at-a-time
  // business-day walk PER PERIOD (calendar.addBusinessDays — including caller-supplied calendars
  // with no cap of their own), so `Number.isInteger(1e15)` passing made one schedule a
  // non-terminating loop. 260 is a full year of business days — real settlement lags are 0–5, so
  // the cap is ~50× any convention while keeping the walk trivially cheap per period.
  if (
    !Number.isSafeInteger(paymentLagDays) ||
    paymentLagDays < 0 ||
    paymentLagDays > MAX_PAYMENT_LAG_DAYS
  ) {
    throw new InputError(
      `generateSchedule: paymentLagDays must be a non-negative integer ≤ ${MAX_PAYMENT_LAG_DAYS} (a full year of business days — settlement lags are 0–5 in every real convention, and each lag day is one calendar-walk step per period), got ${paymentLagDays}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'paymentLagDays', value: paymentLagDays, max: MAX_PAYMENT_LAG_DAYS },
      },
    );
  }

  const monthsPerPeriod = 12 / paymentsPerYear(frequency);
  const eom = options.endOfMonth ?? isEndOfMonth(maturityDate);

  // Roll backward from maturity, collecting unadjusted accrual boundaries. EVERY boundary is
  // computed from the maturity ANCHOR — `addMonths(maturityDate, −i·step)` — never from the
  // previously computed boundary. An iterative back-roll inherits February's day clamp FOREVER:
  // a 29th-anchored semiannual schedule stepping through a non-leap February emitted 02-28 and
  // then carried the 28th backwards, so the next leap February produced 02-28 instead of 02-29
  // and every earlier date lost the 29th anchor (silently corrupting accruals for bonds, swaps,
  // CDS, caps, and XVA, and inventing a front stub where the term was exactly regular).
  // Clamping and the month-end rule are therefore re-applied PER BOUNDARY against the anchor, so
  // boundary `i` is a pure function of (maturityDate, i, step, endOfMonth).
  const boundaries: string[] = [maturityDate];
  let stub = false;
  for (let i = 1; ; i++) {
    const prev = addMonths(maturityDate, -i * monthsPerPeriod, eom);
    const cmp = compareDates(prev, effectiveDate);
    if (cmp <= 0) {
      boundaries.unshift(effectiveDate);
      stub = cmp < 0; // a true stub only when the regular date lands before the effective date
      break;
    }
    boundaries.unshift(prev);
  }

  const periods: SchedulePeriod[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const accrualStart = boundaries[i]!;
    const accrualEnd = boundaries[i + 1]!;
    const rolled = adjustDate(accrualEnd, convention, calendar);
    const paymentDate =
      paymentLagDays > 0 ? calendar.addBusinessDays(rolled, paymentLagDays) : rolled;
    periods.push({ accrualStart, accrualEnd, paymentDate, isStub: i === 0 && stub });
  }
  return periods;
}
