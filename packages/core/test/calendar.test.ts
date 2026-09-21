import { describe, expect, it } from 'vitest';
import {
  alwaysOpen,
  createRuleCalendar,
  easterSunday,
  goodFriday,
  lastWeekdayOfMonth,
  nthWeekdayOfMonth,
  observedHoliday,
  weekendsOnly,
} from '@totalfinance/core';

describe('holiday-rule generators', () => {
  it('nthWeekdayOfMonth: 3rd Monday of Jan 2026 is Jan 19', () => {
    expect(nthWeekdayOfMonth(2026, 1, 1, 3)).toBe('2026-01-19');
  });
  it('lastWeekdayOfMonth: last Monday of May 2026 is May 25', () => {
    expect(lastWeekdayOfMonth(2026, 5, 1)).toBe('2026-05-25');
  });
  it('observedHoliday: Independence Day 2026 (Sat) observed Fri Jul 3', () => {
    expect(observedHoliday(2026, 7, 4)).toBe('2026-07-03');
  });
  it('easterSunday / goodFriday 2026', () => {
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(goodFriday(2026)).toBe('2026-04-03');
  });
});

describe('tiny calendars', () => {
  it('alwaysOpen treats every day as a business day', () => {
    expect(alwaysOpen.isBusinessDay('2026-01-03')).toBe(true); // Saturday
    expect(alwaysOpen.isBusinessDay('2026-12-25')).toBe(true);
  });
  it('weekendsOnly excludes weekends only', () => {
    expect(weekendsOnly.isBusinessDay('2026-01-02')).toBe(true); // Friday
    expect(weekendsOnly.isBusinessDay('2026-01-03')).toBe(false); // Saturday
    expect(weekendsOnly.isBusinessDay('2026-12-25')).toBe(true); // no holidays
  });
});

describe('createRuleCalendar basics', () => {
  const cal = createRuleCalendar({
    name: 'TEST',
    version: '1.0.0',
    timezone: 'UTC',
    session: { open: '09:30', close: '16:00' },
    holidayRules: [(y) => `${y}-01-01`],
  });

  it('business-day arithmetic skips weekends and holidays', () => {
    expect(cal.isHoliday('2026-01-01')).toBe(true);
    // Dec 31 2025 is Wed; next business day skips Jan 1 holiday and lands on Jan 2 (Fri).
    expect(cal.nextBusinessDay('2025-12-31')).toBe('2026-01-02');
    expect(cal.addBusinessDays('2026-01-02', 1)).toBe('2026-01-05'); // skip Sat/Sun
    expect(cal.businessDaysBetween('2026-01-02', '2026-01-09')).toBe(5);
  });

  it('session reports open/close', () => {
    expect(cal.session('2026-01-02')).toMatchObject({
      isBusinessDay: true,
      open: '09:30',
      close: '16:00',
    });
    expect(cal.session('2026-01-01').isBusinessDay).toBe(false);
  });
});
