/**
 * Trader vocabulary for TotalFinance calendars (WS6.1 / R10).
 *
 * Traders say "trading day"; core's `Calendar` interface says `isBusinessDay`. `TradingCalendar`
 * extends the core interface with `isTradingDay` — a FIRST-CLASS alias (the very same function
 * reference, so `cal.isTradingDay === cal.isBusinessDay` and the two can never drift). The alias is
 * attached once here, at the factory level, and every calendar this package exports (NYSE, CBOE,
 * crypto24x7) passes through it; use `withTradingVocabulary` to give a custom
 * `defineCalendar`/`createRuleCalendar` calendar the same vocabulary.
 */

import { type Calendar, ErrorCode, InputError } from '@totalfinance/core';

/** A core `Calendar` extended with trader vocabulary. */
export interface TradingCalendar extends Calendar {
  /**
   * First-class alias of {@link Calendar.isBusinessDay} (R10): `true` when the exchange holds a
   * regular or shortened session on `date` (ISO `YYYY-MM-DD`).
   */
  isTradingDay(date: string): boolean;
}

const CALENDAR_IDENTITY_FIELDS = ['name', 'version', 'timezone'] as const;
const CALENDAR_METHOD_FIELDS = [
  'isBusinessDay',
  'isHoliday',
  'isHalfDay',
  'nextBusinessDay',
  'previousBusinessDay',
  'addBusinessDays',
  'businessDaysBetween',
  'session',
] as const;

/**
 * Validate that `value` is a usable `Calendar` object; throws a teaching `InputError` otherwise.
 * Shared by every facade in this package so garbage inputs (strings, numbers, `{}`) always produce
 * a typed error naming the `calendar` field instead of a raw `TypeError` on a method access.
 */
export function requireCalendar(functionName: string, value: unknown): Calendar {
  const calendar = value as Calendar | null | undefined;
  if (calendar === null || calendar === undefined || typeof calendar !== 'object') {
    const received = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    throw new InputError(
      `${functionName}: calendar must be a Calendar object (e.g. NYSE from '@insiderfinance/totalfinance/calendars/nyse'); got ${received}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'calendar', received },
      },
    );
  }
  for (const field of CALENDAR_IDENTITY_FIELDS) {
    if (typeof calendar[field] !== 'string' || calendar[field].trim() === '') {
      throw new InputError(`${functionName}: calendar.${field} must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: `calendar.${field}` },
      });
    }
  }
  for (const field of CALENDAR_METHOD_FIELDS) {
    if (typeof calendar[field] !== 'function') {
      throw new InputError(
        `${functionName}: calendar.${field} must be a function — pass a complete Calendar from ` +
          "@insiderfinance/totalfinance/calendars or @insiderfinance/totalfinance/core's defineCalendar/createRuleCalendar.",
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `calendar.${field}` },
        },
      );
    }
  }
  // Calendars are structurally typed extension artifacts: venue IDs, provenance, and custom
  // session metadata may decorate them. Validate the full interface; preserve extra fields.
  return calendar;
}

/**
 * Extend a core `Calendar` with the trader-vocabulary alias `isTradingDay` (≡ `isBusinessDay`).
 * Returns a new object; the wrapped methods are the ORIGINAL function references (single
 * implementation), so behavior is identical by construction.
 */
export function withTradingVocabulary(calendar: Calendar): TradingCalendar {
  const base = requireCalendar('calendars.withTradingVocabulary', calendar);
  return { ...base, isTradingDay: base.isBusinessDay };
}
