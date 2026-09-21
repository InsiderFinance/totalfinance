/**
 * US equity/options market holiday rules (NYSE/CBOE share this schedule).
 *
 * Rules-based, not table-based: holidays are computed from rules for any year, with a small list of
 * ad-hoc full closures (emergency closures and days of mourning) that cannot be derived from rules.
 */

import {
  type HolidayRule,
  US_EQUITY_HALF_DAY_RULES,
  createRuleCalendar,
  goodFriday,
  lastWeekdayOfMonth,
  nthWeekdayOfMonth,
  observedHoliday,
} from '@totalfinance/core';
import { type TradingCalendar, withTradingVocabulary } from './trading-calendar.js';

/** Bump when the holiday rules or closure list change. */
export const CALENDAR_DATA_VERSION = '2026.06.0';

const MONDAY = 1;
const THURSDAY = 4;

export const usMarketHolidayRules: HolidayRule[] = [
  // New Year's Day (NYSE Rule 7.2): observed the following Monday when Jan 1 is a Sunday, but NOT
  // observed when Jan 1 falls on a Saturday (the exchange does not close the preceding Friday).
  (y) => {
    const dow = new Date(Date.UTC(y, 0, 1)).getUTCDay();
    if (dow === 6) return null; // Saturday → not observed
    if (dow === 0) return `${y}-01-02`; // Sunday → observed Monday
    return `${y}-01-01`;
  },
  (y) => (y >= 1998 ? nthWeekdayOfMonth(y, 1, MONDAY, 3) : null), // MLK Jr. Day (since 1998)
  (y) => nthWeekdayOfMonth(y, 2, MONDAY, 3), // Washington's Birthday / Presidents' Day
  (y) => goodFriday(y), // Good Friday
  (y) => lastWeekdayOfMonth(y, 5, MONDAY), // Memorial Day
  (y) => (y >= 2022 ? observedHoliday(y, 6, 19) : null), // Juneteenth (market holiday since 2022)
  (y) => observedHoliday(y, 7, 4), // Independence Day
  (y) => nthWeekdayOfMonth(y, 9, MONDAY, 1), // Labor Day
  (y) => nthWeekdayOfMonth(y, 11, THURSDAY, 4), // Thanksgiving
  (y) => observedHoliday(y, 12, 25), // Christmas
];

export const usMarketHalfDayRules: HolidayRule[] = [...US_EQUITY_HALF_DAY_RULES];

/**
 * Ad-hoc full closures that no rule can derive. Complete for the era this list spans (2001→present);
 * dates BEFORE 2001 are not covered — day counts across earlier one-off closures (e.g. the 1994
 * Nixon mourning day) would be silently wrong, so treat 2001-01-01 as the calendar's historical floor.
 */
export const usMarketClosures: string[] = [
  '2001-09-11', // September 11 attacks
  '2001-09-12',
  '2001-09-13',
  '2001-09-14',
  '2004-06-11', // National day of mourning — Ronald Reagan
  '2007-01-02', // National day of mourning — Gerald Ford
  '2012-10-29', // Hurricane Sandy
  '2012-10-30',
  '2018-12-05', // National day of mourning — George H. W. Bush
  '2025-01-09', // National day of mourning — Jimmy Carter
];

/**
 * @internal Build a US equity/options trading calendar over the shared schedule above.
 *
 * NYSE and Cboe observe the SAME holidays, closures, half-days, and regular ET session hours — the
 * two entrypoints were byte-identical apart from the venue name, so a fix applied to one could
 * silently miss the other. One builder, two named instances: each venue still gets its OWN
 * calendar object (independent per-year caches, its own `name`), so the public identities are
 * unchanged. NOT re-exported from the package index: the exported surface stays `NYSE`/`CBOE`.
 */
export function usEquityMarketCalendar(name: string): TradingCalendar {
  return withTradingVocabulary(
    createRuleCalendar({
      name,
      version: CALENDAR_DATA_VERSION,
      timezone: 'America/New_York',
      session: { open: '09:30', close: '16:00', halfDayClose: '13:00' },
      holidayRules: usMarketHolidayRules,
      halfDayRules: usMarketHalfDayRules,
      closures: usMarketClosures,
    }),
  );
}
