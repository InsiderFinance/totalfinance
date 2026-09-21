/**
 * The 2026-08-02 defect-fix wave for `@totalfinance/calendars`: the shipped-calendar consequences of
 * the core fixes (config-mutation immunity on the REAL NYSE dataset, holiday rules that can return
 * "not observed"), the date-parse error context, the shared NYSE/Cboe builder, and a self-
 * maintaining `Intl` cross-check for the US equity close.
 */

import { describe, expect, it } from 'vitest';
import {
  isQuantError,
  isoDateToEpochMs,
  nthWeekdayOfMonth,
  usEquityCloseUtcMs,
} from '@totalfinance/core';
import type { HolidayRule } from '@totalfinance/core';
import { CBOE, NYSE, expirations, nextExpiry, tradingDaysToExpiry } from '../src/index.js';
import { usMarketHalfDayRules, usMarketHolidayRules } from '../src/us-market.js';

// ---------------------------------------------------------------------------
// [6] the shipped calendars are immune to dataset mutation
// ---------------------------------------------------------------------------

describe('[6] NYSE is immune to post-construction mutation of the exported rule arrays', () => {
  it('REGRESSION: pushing into usMarketHolidayRules after a warm query cannot split the answer', () => {
    // The exported rules array is public API — a caller (or a test, or a plugin) can push to it.
    // Pre-fix, the calendar held a LIVE reference: a year already memoized answered the OLD rules
    // while any cold year answered the NEW ones, so the same calendar said both things at once.
    expect(NYSE.isHoliday('2026-03-17')).toBe(false); // warms 2026
    const extra: HolidayRule = (y) => `${y}-03-17`;
    usMarketHolidayRules.push(extra);
    try {
      const warmYear = NYSE.isHoliday('2026-03-17'); // memoized year
      const coldYear = NYSE.isHoliday('2031-03-17'); // never queried before
      expect(warmYear).toBe(false);
      expect(coldYear).toBe(false);
      expect(warmYear).toBe(coldYear); // the calendar answers ONE way, whenever you ask
      // Cboe is built from the same dataset and must agree.
      expect(CBOE.isHoliday('2031-03-17')).toBe(false);
    } finally {
      usMarketHolidayRules.splice(usMarketHolidayRules.indexOf(extra), 1);
    }
    expect(usMarketHolidayRules).not.toContain(extra);
  });

  it('REGRESSION: the same holds for the half-day rules', () => {
    expect(NYSE.isHalfDay('2026-03-17')).toBe(false); // warms 2026
    const extra: HolidayRule = (y) => `${y}-03-17`;
    usMarketHalfDayRules.push(extra);
    try {
      expect(NYSE.isHalfDay('2026-03-17')).toBe(false);
      expect(NYSE.isHalfDay('2032-03-17')).toBe(false);
    } finally {
      usMarketHalfDayRules.splice(usMarketHalfDayRules.indexOf(extra), 1);
    }
  });

  it('the golden schedule is unchanged by the snapshot (spot-check across the year)', () => {
    for (const date of ['2026-01-01', '2026-04-03', '2026-07-03', '2026-11-26', '2026-12-25']) {
      expect(NYSE.isHoliday(date), date).toBe(true);
    }
    expect(NYSE.isHalfDay('2026-11-27')).toBe(true);
    expect(NYSE.isHalfDay('2026-12-24')).toBe(true);
    expect(NYSE.session('2026-11-27').close).toBe('13:00');
    expect(NYSE.session('2026-03-17')).toMatchObject({ open: '09:30', close: '16:00' });
  });
});

// ---------------------------------------------------------------------------
// [8] the holiday rules tolerate the generator's null channel
// ---------------------------------------------------------------------------

describe('[8] the US rule set survives nthWeekdayOfMonth returning null', () => {
  it('every shipped holiday rule returns a real ISO date or null, never a fabricated day', () => {
    for (let year = 1990; year <= 2060; year++) {
      for (const rule of [...usMarketHolidayRules, ...usMarketHalfDayRules]) {
        const date = rule(year);
        if (date === null) continue;
        expect(date, `${year}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // Throws on an impossible date such as the old "2026-02-34".
        expect(() => isoDateToEpochMs(date)).not.toThrow();
      }
    }
  });

  it('the occurrences the US rules actually request always exist (no null in practice)', () => {
    for (let year = 1990; year <= 2060; year++) {
      expect(nthWeekdayOfMonth(year, 1, 1, 3), `MLK ${year}`).not.toBeNull(); // 3rd Monday Jan
      expect(nthWeekdayOfMonth(year, 2, 1, 3), `Presidents ${year}`).not.toBeNull();
      expect(nthWeekdayOfMonth(year, 9, 1, 1), `Labor ${year}`).not.toBeNull();
      expect(nthWeekdayOfMonth(year, 11, 4, 4), `Thanksgiving ${year}`).not.toBeNull();
    }
  });

  it('the third-Friday expiration path is unaffected (OPEX 2026 golden)', () => {
    expect(expirations(NYSE, { from: '2026-01-01', to: '2026-06-30', kind: 'monthly' })).toEqual([
      '2026-01-16',
      '2026-02-20',
      '2026-03-20',
      '2026-04-17',
      '2026-05-15',
      '2026-06-18', // Juneteenth Friday → settles Thursday
    ]);
  });
});

// ---------------------------------------------------------------------------
// [12] date-parse errors name the function AND the field
// ---------------------------------------------------------------------------

describe('[12] calendars: a bad date says which call and which field', () => {
  function caught(fn: () => unknown): { message: string; code: string; field?: unknown } {
    try {
      fn();
    } catch (error) {
      const e = error as { message: string; code: string; context?: { field?: unknown } };
      return { message: e.message, code: e.code, field: e.context?.field };
    }
    throw new Error('expected a throw');
  }

  it('REGRESSION: expirations names `from` (was an anonymous "Invalid ISO date")', () => {
    const e = caught(() => expirations(NYSE, { from: '2026-1-1', to: '2026-12-31' }));
    expect(e.message).toMatch(/^calendars\.expirations: from /);
    expect(e.message).toMatch(/Invalid ISO date "2026-1-1"/);
    expect(e.field).toBe('from');
    expect(e.code).toBe('input.wrong_type');
  });

  it('the wrapped error is still a QuantError with a stable code (not a bare Error)', () => {
    try {
      expirations(NYSE, { from: '2026-1-1', to: '2026-12-31' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isQuantError(error, 'input.wrong_type')).toBe(true);
    }
  });

  it('REGRESSION: expirations names `to`, and distinguishes it from `from`', () => {
    const e = caught(() => expirations(NYSE, { from: '2026-01-01', to: 'next friday' }));
    expect(e.message).toMatch(/^calendars\.expirations: to /);
    expect(e.field).toBe('to');
  });

  it('an impossible calendar date keeps the ORIGINAL out-of-range code plus the field', () => {
    const e = caught(() => expirations(NYSE, { from: '2026-02-30', to: '2026-12-31' }));
    expect(e.message).toMatch(/^calendars\.expirations: from /);
    expect(e.message).toMatch(/not a valid calendar date/);
    expect(e.code).toBe('input.out_of_range');
    expect(e.field).toBe('from');
  });

  it('REGRESSION: nextExpiry names `date`', () => {
    const e = caught(() => nextExpiry(NYSE, 'tomorrow'));
    expect(e.message).toMatch(/^calendars\.nextExpiry: date /);
    expect(e.field).toBe('date');
  });

  it('REGRESSION: tradingDaysToExpiry names `from` and `expiry` separately', () => {
    const bad = caught(() => tradingDaysToExpiry(NYSE, '07/06/2026', '2026-09-18'));
    expect(bad.message).toMatch(/^calendars\.tradingDaysToExpiry: from /);
    expect(bad.field).toBe('from');
    const badExpiry = caught(() => tradingDaysToExpiry(NYSE, '2026-07-06', '2026-09-31'));
    expect(badExpiry.message).toMatch(/^calendars\.tradingDaysToExpiry: expiry /);
    expect(badExpiry.field).toBe('expiry');
  });

  it('the underlying core error is preserved on the cause chain', () => {
    try {
      expirations(NYSE, { from: 'garbage', to: '2026-12-31' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
      expect((error as { cause: Error }).cause.message).toMatch(/Invalid ISO date/);
    }
  });

  it('valid dates are untouched — the wrapper only speaks on failure', () => {
    expect(nextExpiry(NYSE, '2026-07-06')).toBe('2026-07-10');
    expect(tradingDaysToExpiry(NYSE, '2026-07-06', '2026-07-10')).toBe(4);
    expect(expirations(NYSE, { from: '2026-01-01', to: '2026-02-28' }).length).toBe(2);
  });

  it('the pre-existing typed errors still fire with their own messages', () => {
    expect(() => expirations(NYSE, { from: '2026-02-01', to: '2026-01-01' })).toThrowError(
      /to \(2026-01-01\) is before from/,
    );
    expect(() =>
      expirations(NYSE, { from: '2026-01-01', to: '2026-02-01', kind: 'daily' as never }),
    ).toThrowError(/weekly/);
    expect(() => tradingDaysToExpiry(NYSE, '2026-09-18', '2026-07-06')).toThrowError(
      /is before 2026-09-18/,
    );
  });
});

// ---------------------------------------------------------------------------
// [15] NYSE and Cboe share one builder without sharing an identity
// ---------------------------------------------------------------------------

describe('[15] the shared US-equity builder preserves both public identities', () => {
  it('each venue keeps its own name, and they are distinct objects', () => {
    expect(NYSE.name).toBe('NYSE');
    expect(CBOE.name).toBe('CBOE');
    expect(NYSE).not.toBe(CBOE);
    expect(NYSE.isBusinessDay).not.toBe(CBOE.isBusinessDay); // independent per-year caches
  });

  it('identity metadata is unchanged', () => {
    for (const cal of [NYSE, CBOE]) {
      expect(cal.timezone).toBe('America/New_York');
      expect(cal.version).toMatch(/^\d{4}\.\d{2}\.\d+$/);
    }
    expect(NYSE.version).toBe(CBOE.version);
  });

  it('the trader-vocabulary alias survives the extraction (R10)', () => {
    for (const cal of [NYSE, CBOE]) {
      expect(cal.isTradingDay).toBe(cal.isBusinessDay);
    }
  });

  it('PROPERTY: the two calendars agree on every day of 2026 (one schedule, two instances)', () => {
    let day = isoDateToEpochMs('2026-01-01');
    const end = isoDateToEpochMs('2026-12-31');
    let checked = 0;
    for (; day <= end; day += 86_400_000) {
      const iso = new Date(day).toISOString().slice(0, 10);
      expect(CBOE.isBusinessDay(iso), iso).toBe(NYSE.isBusinessDay(iso));
      expect(CBOE.isHoliday(iso), iso).toBe(NYSE.isHoliday(iso));
      expect(CBOE.isHalfDay(iso), iso).toBe(NYSE.isHalfDay(iso));
      expect(CBOE.session(iso), iso).toEqual({ ...NYSE.session(iso) });
      checked++;
    }
    expect(checked).toBe(365);
  });

  it('the session hours both venues publish are the ET equity session', () => {
    expect(NYSE.session('2026-03-17')).toMatchObject({ open: '09:30', close: '16:00' });
    expect(CBOE.session('2026-03-17')).toMatchObject({ open: '09:30', close: '16:00' });
    expect(CBOE.session('2026-11-27').close).toBe('13:00');
  });
});

// ---------------------------------------------------------------------------
// Intl cross-check: the US equity close, verified against the platform, not a table
// ---------------------------------------------------------------------------

describe('usEquityCloseUtcMs: a self-maintaining Intl cross-check, 2020-2030', () => {
  /** What time does the platform think it is in New York at this instant? */
  function newYorkClock(ms: number): { date: string; hour: number; minute: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(ms));
    const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    return {
      date: `${get('year')}-${get('month')}-${get('day')}`,
      hour: Number(get('hour')) % 24, // some ICU versions render midnight as 24
      minute: Number(get('minute')),
    };
  }

  it('every 3rd Friday (OPEX) from 2020 through 2030 lands on 16:00 ET, DST and all', () => {
    let checked = 0;
    for (let year = 2020; year <= 2030; year++) {
      for (let month = 1; month <= 12; month++) {
        const thirdFriday = nthWeekdayOfMonth(year, month, 5, 3);
        expect(thirdFriday, `${year}-${month}`).not.toBeNull();
        const [y, m, d] = thirdFriday!.split('-').map(Number);
        const ms = usEquityCloseUtcMs(y!, m!, d!);
        const clock = newYorkClock(ms);
        expect(clock.date, thirdFriday!).toBe(thirdFriday);
        expect(clock.hour, thirdFriday!).toBe(16);
        expect(clock.minute, thirdFriday!).toBe(0);
        checked++;
      }
    }
    expect(checked).toBe(132);
  });

  it('the DST boundary days themselves are correct (the hour that actually moves)', () => {
    // Second Sunday in March and first Sunday in November, plus the days either side.
    for (let year = 2020; year <= 2030; year++) {
      const springForward = nthWeekdayOfMonth(year, 3, 0, 2)!;
      const fallBack = nthWeekdayOfMonth(year, 11, 0, 1)!;
      for (const iso of [springForward, fallBack]) {
        for (const offsetDays of [-1, 0, 1]) {
          const ms = isoDateToEpochMs(iso) + offsetDays * 86_400_000;
          const probe = new Date(ms).toISOString().slice(0, 10);
          const [y, m, d] = probe.split('-').map(Number);
          const clock = newYorkClock(usEquityCloseUtcMs(y!, m!, d!));
          expect(clock.date, probe).toBe(probe);
          expect(clock.hour, probe).toBe(16);
          expect(clock.minute, probe).toBe(0);
        }
      }
    }
  });

  it('PROPERTY: the close is exactly 21:00 UTC in EST and 20:00 UTC in EDT', () => {
    for (let year = 2020; year <= 2030; year++) {
      // January is always EST; July is always EDT.
      expect(usEquityCloseUtcMs(year, 1, 15)).toBe(Date.UTC(year, 0, 15, 21));
      expect(usEquityCloseUtcMs(year, 7, 15)).toBe(Date.UTC(year, 6, 15, 20));
    }
  });

  it('every NYSE trading day of 2026 closes at the calendar session close by the platform clock (16:00, or 13:00 on early-close days)', () => {
    let day = isoDateToEpochMs('2026-01-01');
    const end = isoDateToEpochMs('2026-12-31');
    let halfDays = 0;
    for (; day <= end; day += 86_400_000) {
      const iso = new Date(day).toISOString().slice(0, 10);
      if (!NYSE.isTradingDay(iso)) continue;
      const [y, m, d] = iso.split('-').map(Number);
      const clock = newYorkClock(usEquityCloseUtcMs(y!, m!, d!));
      expect(clock.date, iso).toBe(iso);
      // ONE rule table: core's early-close instant agrees with the calendar's session close.
      const close = NYSE.session(iso).close;
      expect(close, iso).toBeDefined();
      const expectedHour = Number(close!.slice(0, 2));
      expect(clock.hour, iso).toBe(expectedHour);
      if (NYSE.isHalfDay(iso)) {
        halfDays++;
        expect(clock.hour, iso).toBe(13);
      }
    }
    expect(halfDays).toBe(2); // 2026: the Friday after Thanksgiving and Christmas Eve (3 July is the observed holiday)
  });
});
