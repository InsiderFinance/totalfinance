/**
 * Tests for the option-expiry time helpers (§7.2): `usEquityCloseUtcMs` and `optionExpiryToMs`. These
 * pin the single option-expiry convention shared by `core`, `options`, `strategy`, and `structure`.
 */

import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, isQuantError } from '../src/errors.js';
import {
  isUsEquityHalfDay,
  optionExpiryToMs,
  resolveAsOf,
  resolveValuationAsOf,
  usEquityCloseUtcMs,
  usEquityMarketDateUtcMs,
  usEquityMarketDayIndex,
  usEquitySessionInstant,
} from '../src/time.js';

describe('usEquityCloseUtcMs (16:00 America/New_York, DST-aware)', () => {
  it('resolves to 21:00 UTC in EST and 20:00 UTC in EDT', () => {
    expect(usEquityCloseUtcMs(2026, 1, 15)).toBe(Date.UTC(2026, 0, 15, 21)); // January → EST (UTC−5)
    expect(usEquityCloseUtcMs(2026, 7, 15)).toBe(Date.UTC(2026, 6, 15, 20)); // July → EDT (UTC−4)
  });

  it('pins both DST boundaries (spring forward / fall back)', () => {
    // DST 2026 starts 2nd Sunday of March (Mar 8) and ends 1st Sunday of November (Nov 1).
    expect(usEquityCloseUtcMs(2026, 3, 7)).toBe(Date.UTC(2026, 2, 7, 21)); // EST before spring-forward
    expect(usEquityCloseUtcMs(2026, 3, 8)).toBe(Date.UTC(2026, 2, 8, 20)); // EDT on spring-forward day
    expect(usEquityCloseUtcMs(2026, 10, 31)).toBe(Date.UTC(2026, 9, 31, 20)); // EDT before fall-back
    expect(usEquityCloseUtcMs(2026, 11, 1)).toBe(Date.UTC(2026, 10, 1, 21)); // EST on fall-back day
  });

  it('throws (never silently assumes EST) when Intl cannot resolve the offset', () => {
    const original = Intl;
    vi.stubGlobal('Intl', {
      ...Intl,
      // A hostile Intl whose offset string does not match the GMT±HH:MM pattern.
      DateTimeFormat: function () {
        return {
          formatToParts: () => [{ type: 'timeZoneName', value: 'Coordinated Universal Time' }],
        };
      },
    });
    try {
      expect(() => usEquityCloseUtcMs(2026, 7, 15)).toThrow(/resolve|timezone/i);
    } finally {
      vi.stubGlobal('Intl', original);
    }
  });
});

describe('optionExpiryToMs', () => {
  it('resolves a date-only expiry to the market close, not UTC midnight', () => {
    expect(optionExpiryToMs('2026-01-15')).toBe(usEquityCloseUtcMs(2026, 1, 15));
    expect(optionExpiryToMs('2026-01-15')).toBe(Date.UTC(2026, 0, 15, 21));
  });

  it('parses a full datetime as-is', () => {
    expect(optionExpiryToMs('2026-01-15T18:30:00Z')).toBe(Date.UTC(2026, 0, 15, 18, 30));
  });

  it('rejects an invalid calendar date instead of silently rolling it forward', () => {
    // Date.UTC would turn 2026-02-31 into 2026-03-03; the convention must reject it.
    expect(() => optionExpiryToMs('2026-02-31')).toThrow();
    expect(() => optionExpiryToMs('2026-13-01')).toThrow();
  });

  it('rejects an unparseable label', () => {
    expect(() => optionExpiryToMs('not-a-date')).toThrow(/cannot parse/);
  });
});

describe('resolveAsOf — the one deterministic grammar for "when"', () => {
  it('passes epoch ms through and resolves bare dates to UTC midnight', () => {
    expect(resolveAsOf(1750000000000)).toBe(1750000000000);
    expect(resolveAsOf('2026-07-06')).toBe(Date.UTC(2026, 6, 6));
  });

  it('accepts zoned datetimes and rejects bare (machine-local) ones with the fix', () => {
    expect(resolveAsOf('2026-07-06T14:30:00Z')).toBe(Date.UTC(2026, 6, 6, 14, 30, 0));
    expect(resolveAsOf('2026-07-06T09:30:00-05:00')).toBe(Date.UTC(2026, 6, 6, 14, 30, 0));
    expect(() => resolveAsOf('2026-07-06T14:30')).toThrowError(/append 'Z' or an offset/);
    expect(() => resolveAsOf('yesterday')).toThrowError(/cannot parse asOf/);
    expect(() => resolveAsOf(null as never)).toThrowError(/epoch milliseconds or an ISO date/);
  });

  it('rejects non-finite epoch numbers on the numeric branch too (alignment specification P1.6)', () => {
    expect(() => resolveAsOf(Number.NaN)).toThrowError(/must be finite epoch milliseconds/);
    expect(() => resolveAsOf(Infinity)).toThrowError(/never reads the system clock/);
  });
});

describe('optionExpiryToMs strictness (determinism law)', () => {
  it('accepts zoned datetimes, rejects bare datetimes and garbage', () => {
    expect(optionExpiryToMs('2026-09-18T20:00:00Z')).toBe(Date.UTC(2026, 8, 18, 20, 0, 0));
    expect(() => optionExpiryToMs('2026-09-18T16:00')).toThrowError(/no timezone/);
    expect(() => optionExpiryToMs('sep 18')).toThrowError(/cannot parse expiry/);
  });
});

describe('US equity early-close days (13:00 ET) — one rule table shared with @totalfinance/calendars', () => {
  it('recognises the day after Thanksgiving and weekday Christmas Eve / 3 July', () => {
    expect(isUsEquityHalfDay('2026-11-27')).toBe(true); // Friday after Thanksgiving 2026
    expect(isUsEquityHalfDay('2026-12-24')).toBe(true); // Thursday
    expect(isUsEquityHalfDay('2025-12-24')).toBe(true); // Wednesday
    expect(isUsEquityHalfDay('2025-07-03')).toBe(true); // Thursday
    expect(isUsEquityHalfDay('2026-11-26')).toBe(false); // Thanksgiving itself
    expect(isUsEquityHalfDay('2026-07-20')).toBe(false);
  });

  it('excludes weekends and the observed Christmas / Independence Day holidays', () => {
    expect(isUsEquityHalfDay('2022-12-24')).toBe(false); // Saturday
    expect(isUsEquityHalfDay('2021-12-24')).toBe(false); // observed Christmas (Dec 25 was Saturday)
    expect(isUsEquityHalfDay('2026-07-03')).toBe(false); // observed Independence Day (Jul 4 is Saturday)
    expect(isUsEquityHalfDay('2027-07-03')).toBe(false); // Saturday
    expect(isUsEquityHalfDay('2027-12-24')).toBe(false); // observed Christmas (Dec 25 is Saturday)
  });

  it('resolves the close to 13:00 ET on an early-close day and 16:00 ET otherwise', () => {
    expect(usEquityCloseUtcMs(2026, 11, 27)).toBe(Date.UTC(2026, 10, 27, 18)); // EST: 13:00 ET = 18:00Z
    expect(usEquityCloseUtcMs(2026, 12, 24)).toBe(Date.UTC(2026, 11, 24, 18));
    expect(usEquityCloseUtcMs(2025, 7, 3)).toBe(Date.UTC(2025, 6, 3, 17)); // EDT: 13:00 ET = 17:00Z
    expect(usEquityCloseUtcMs(2026, 11, 25)).toBe(Date.UTC(2026, 10, 25, 21));
    expect(optionExpiryToMs('2026-11-27')).toBe(Date.UTC(2026, 10, 27, 18));
  });

  it('rejects an impossible calendar date', () => {
    expect(() => isUsEquityHalfDay('2026-02-31')).toThrow();
  });
});

describe('usEquitySessionInstant', () => {
  it('resolves the open to 09:30 ET, DST-aware, and the close through the same table', () => {
    expect(usEquitySessionInstant('2026-01-15', 'open')).toBe(Date.UTC(2026, 0, 15, 14, 30)); // EST
    expect(usEquitySessionInstant('2026-07-15', 'open')).toBe(Date.UTC(2026, 6, 15, 13, 30));
    expect(usEquitySessionInstant('2026-07-15', 'close')).toBe(Date.UTC(2026, 6, 15, 20));
    expect(usEquitySessionInstant('2026-11-27', 'close')).toBe(Date.UTC(2026, 10, 27, 18));
    expect(usEquitySessionInstant('2026-11-27', 'open')).toBe(Date.UTC(2026, 10, 27, 14, 30));
  });

  it('teaches the date and session grammar instead of guessing', () => {
    expect(() => usEquitySessionInstant('2026-07-15T10:30:00-04:00', 'close')).toThrow(
      /YYYY-MM-DD/,
    );
    expect(() => usEquitySessionInstant('2026-02-31', 'close')).toThrow();
    // @ts-expect-error — the session enum is closed
    expect(() => usEquitySessionInstant('2026-07-15', 'midday')).toThrow(/'open'|'close'/);
    // @ts-expect-error — a date is required
    expect(() => usEquitySessionInstant(undefined, 'close')).toThrow(/YYYY-MM-DD/);
  });
});

describe('resolveValuationAsOf — a valuation instant names its time of day', () => {
  it('accepts epoch ms and zoned datetimes exactly like resolveAsOf', () => {
    expect(resolveValuationAsOf(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(resolveValuationAsOf('2026-07-20T10:30:00-04:00')).toBe(Date.UTC(2026, 6, 20, 14, 30));
    expect(resolveValuationAsOf('2026-07-20T14:30:00Z')).toBe(resolveAsOf('2026-07-20T14:30:00Z'));
  });

  it('rejects a date-only asOf with the typed code and a fix that carries the right offset', () => {
    let caught: unknown;
    try {
      resolveValuationAsOf('2026-07-20', 'market');
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught)).toBe(true);
    if (!isQuantError(caught)) throw new Error('unreachable');
    expect(caught.code).toBe(ErrorCode.TimeValuationInstantRequired);
    expect(caught.message).toMatch(/^market: asOf "2026-07-20" is a date with no time of day/);
    expect(caught.message).toContain('2026-07-20T10:30:00-04:00'); // EDT in July
    expect(caught.message).toContain("usEquitySessionInstant('2026-07-20', 'close')");
    expect(() => resolveValuationAsOf('2026-01-20', 'market')).toThrow(/2026-01-20T10:30:00-05:00/); // EST
  });

  it('still refuses impossible dates, bare datetimes and garbage through the shared grammar', () => {
    expect(() => resolveValuationAsOf('2026-02-31')).toThrow(/calendar|exist|invalid/i);
    expect(() => resolveValuationAsOf('2026-07-20T10:30:00')).toThrow(/timezone/);
    expect(() => resolveValuationAsOf('tomorrow')).toThrow(/cannot parse/);
    expect(() => resolveValuationAsOf(Number.NaN)).toThrow(/finite/);
  });
});

describe('usEquityMarketDayIndex — the ONE America/New_York day boundary', () => {
  it('keeps a Thursday-evening ET instant on Thursday even though the UTC date is Friday', () => {
    const thursday2130Et = Date.UTC(2026, 5, 19, 1, 30); // 01:30Z Friday = 21:30 ET Thursday (EDT)
    const fridayIndex = Math.round(Date.UTC(2026, 5, 19) / 86_400_000);
    expect(usEquityMarketDayIndex(thursday2130Et)).toBe(fridayIndex - 1);
    expect(usEquityMarketDayIndex(Date.UTC(2026, 5, 19, 13, 30))).toBe(fridayIndex); // 09:30 ET Friday
    expect(usEquityMarketDateUtcMs(thursday2130Et)).toBe(Date.UTC(2026, 5, 18));
  });

  it('is DST-aware (EST evening rollover at 00:00Z + 5h)', () => {
    expect(usEquityMarketDayIndex(Date.UTC(2026, 0, 16, 4, 59))).toBe(
      Math.round(Date.UTC(2026, 0, 15) / 86_400_000),
    ); // 23:59 ET Jan 15
    expect(usEquityMarketDayIndex(Date.UTC(2026, 0, 16, 5, 0))).toBe(
      Math.round(Date.UTC(2026, 0, 16) / 86_400_000),
    ); // 00:00 ET Jan 16
  });
});
