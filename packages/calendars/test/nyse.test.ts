import { describe, expect, it } from 'vitest';
import { alwaysOpen, createRuleCalendar } from '@totalfinance/core';
import { NYSE } from '@totalfinance/calendars/nyse';
import { crypto24x7 } from '@totalfinance/calendars/crypto';
import { CBOE } from '@totalfinance/calendars/cboe';

describe('NYSE 2026 holidays (golden)', () => {
  const holidays2026: Record<string, string> = {
    "New Year's Day": '2026-01-01',
    'MLK Jr. Day': '2026-01-19',
    "Presidents' Day": '2026-02-16',
    'Good Friday': '2026-04-03',
    'Memorial Day': '2026-05-25',
    Juneteenth: '2026-06-19',
    'Independence Day (observed)': '2026-07-03',
    'Labor Day': '2026-09-07',
    Thanksgiving: '2026-11-26',
    Christmas: '2026-12-25',
  };

  for (const [name, date] of Object.entries(holidays2026)) {
    it(`${name} (${date}) is a market holiday`, () => {
      expect(NYSE.isHoliday(date)).toBe(true);
      expect(NYSE.isBusinessDay(date)).toBe(false);
    });
  }

  it('a normal weekday is a business day', () => {
    expect(NYSE.isBusinessDay('2026-01-02')).toBe(true);
    expect(NYSE.isBusinessDay('2026-03-17')).toBe(true);
  });

  it('weekends are not business days', () => {
    expect(NYSE.isBusinessDay('2026-01-03')).toBe(false); // Saturday
    expect(NYSE.isBusinessDay('2026-01-04')).toBe(false); // Sunday
  });
});

describe('NYSE half days (golden)', () => {
  it('day after Thanksgiving and Christmas Eve 2026 are early closes', () => {
    expect(NYSE.isHalfDay('2026-11-27')).toBe(true);
    expect(NYSE.isHalfDay('2026-12-24')).toBe(true);
    expect(NYSE.session('2026-11-27').close).toBe('13:00');
  });

  it('July 3 2026 is a full holiday (observed July 4), not a half day', () => {
    expect(NYSE.isHoliday('2026-07-03')).toBe(true);
    expect(NYSE.isHalfDay('2026-07-03')).toBe(false);
  });
});

describe('NYSE ad-hoc closures', () => {
  it('honors emergency closures and days of mourning', () => {
    expect(NYSE.isBusinessDay('2012-10-30')).toBe(false); // Hurricane Sandy
    expect(NYSE.isBusinessDay('2025-01-09')).toBe(false); // Jimmy Carter mourning
    expect(NYSE.isBusinessDay('2001-09-12')).toBe(false); // 9/11
  });
});

describe('Juneteenth only from 2022', () => {
  it('is a holiday in 2026 but not in 2019', () => {
    expect(NYSE.isHoliday('2026-06-19')).toBe(true);
    expect(NYSE.isHoliday('2019-06-19')).toBe(false);
  });
});

describe('CBOE follows the same US schedule', () => {
  it('Thanksgiving 2026 is a holiday', () => {
    expect(CBOE.isHoliday('2026-11-26')).toBe(true);
    expect(CBOE.session('2026-11-27').close).toBe('13:00');
  });
});

describe('crypto is 24/7', () => {
  it('weekends and holidays are business days', () => {
    expect(crypto24x7.isBusinessDay('2026-01-03')).toBe(true); // Saturday
    expect(crypto24x7.isBusinessDay('2026-12-25')).toBe(true); // Christmas
    expect(crypto24x7.nextBusinessDay('2026-01-02')).toBe('2026-01-03');
  });

  it('runs a continuous 00:00–24:00 session and aliases core alwaysOpen (WS3.9)', () => {
    const s = crypto24x7.session('2026-01-03'); // a Saturday — still a full session
    expect(s.isBusinessDay).toBe(true);
    expect(s.open).toBe('00:00');
    expect(s.close).toBe('24:00'); // the "no close" sentinel, not normalized to 00:00
    // single implementation: the crypto calendar wraps core's alwaysOpen with trader vocabulary
    // (R10) — the underlying methods are the SAME function references, so behavior cannot drift.
    expect(crypto24x7.isBusinessDay).toBe(alwaysOpen.isBusinessDay);
    expect(crypto24x7.isTradingDay).toBe(alwaysOpen.isBusinessDay);
  });
});

describe('cross-year holiday observance (WS1.8)', () => {
  it('NYSE New Year: a Saturday Jan 1 is NOT observed (no preceding-Friday close)', () => {
    expect(NYSE.isBusinessDay('2021-12-31')).toBe(true); // Jan 1 2022 = Saturday
    expect(NYSE.isBusinessDay('2027-12-31')).toBe(true); // Jan 1 2028 = Saturday
  });

  it('NYSE New Year: a Sunday Jan 1 is observed the following Monday', () => {
    // Jan 1 2023 = Sunday ⇒ observed Monday Jan 2 2023.
    expect(NYSE.isHoliday('2023-01-02')).toBe(true);
    expect(NYSE.isBusinessDay('2023-01-02')).toBe(false);
  });

  it('a custom rule that emits a PRIOR-year date is honored (engine evaluates Y±1)', () => {
    const cal = createRuleCalendar({
      name: 'test-cross-year',
      version: '0',
      timezone: 'UTC',
      session: { open: '09:30', close: '16:00' },
      holidayRules: [(y) => `${y - 1}-12-31`], // resolves INTO the previous calendar year
    });
    // '2030-12-31' is emitted by rule(2031); the single-year engine missed it, the Y±1 engine catches it.
    expect(cal.isHoliday('2030-12-31')).toBe(true);
    expect(cal.isBusinessDay('2030-12-31')).toBe(false);
  });
});
