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

  it('throws (never silently assumes EST) when Intl cannot resolve the offset', async () => {
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
      // A FRESH module: the offset formatter and resolved offsets are cached per module (#1), so the
      // module already loaded above would answer from its cache without consulting this Intl.
      vi.resetModules();
      const fresh = await import('../src/time.js');
      expect(() => fresh.usEquityCloseUtcMs(2026, 7, 15)).toThrow(/resolve|timezone/i);
      // A failed resolution is never cached: the next call asks Intl again and fails again.
      expect(() => fresh.usEquityCloseUtcMs(2026, 7, 15)).toThrow(/resolve|timezone/i);
    } finally {
      vi.stubGlobal('Intl', original);
    }
  });

  it('builds the offset formatter once per module, not once per call (#1)', async () => {
    const Original = Intl.DateTimeFormat;
    let constructed = 0;
    class Counting extends Original {
      constructor(...args: ConstructorParameters<typeof Intl.DateTimeFormat>) {
        super(...args);
        constructed++;
      }
    }
    vi.stubGlobal('Intl', { ...Intl, DateTimeFormat: Counting });
    try {
      vi.resetModules();
      const fresh = await import('../src/time.js');
      constructed = 0; // import-time formatters (the market-date parts) are not the per-call cost
      const labels = Array.from({ length: 500 }, (_, i) =>
        new Date(Date.UTC(2026, 0, 2 + i * 3)).toISOString().slice(0, 10),
      );
      for (let pass = 0; pass < 3; pass++) {
        for (const label of labels) fresh.optionExpiryToMs(label);
      }
      // 1,500 resolutions across ~4 years of dates (both DST regimes and the early closes):
      // at most the one lazily built offset formatter.
      expect(constructed).toBeLessThanOrEqual(1);
      // Byte-identical results to the module loaded at the top of this file.
      for (const label of labels)
        expect(fresh.optionExpiryToMs(label)).toBe(optionExpiryToMs(label));
      expect(fresh.usEquityCloseUtcMs(2026, 11, 27)).toBe(Date.UTC(2026, 10, 27, 18)); // 13:00 EST
      expect(fresh.usEquityCloseUtcMs(2026, 3, 8)).toBe(Date.UTC(2026, 2, 8, 20)); // EDT
    } finally {
      vi.unstubAllGlobals();
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

/**
 * The New York date straight from `Intl`, independently of the module: the definition the market-day
 * cache must reproduce exactly, error for error.
 */
const referenceFormatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  era: 'short',
});
function referenceDayIndex(epochMs: number): number {
  const parts = referenceFormatter.formatToParts(new Date(epochMs));
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = Number(value('year'));
  const bc = value('era')?.startsWith('B') ?? false;
  return Math.round(
    Date.UTC(bc ? 1 - year : year, Number(value('month')) - 1, Number(value('day'))) / 86_400_000,
  );
}
function outcome(run: () => number): { value: number } | { error: string } {
  try {
    return { value: run() };
  } catch (error) {
    return { error: `${(error as Error).name}: ${(error as Error).message}` };
  }
}
/**
 * Asks three times, so the instant is answered on its hour's first visit, on the visit that reads
 * the hour's two ends, and from memory (or the same paths again in an hour already known).
 */
const expectSameDay = (epochMs: number) => {
  const expected = outcome(() => referenceDayIndex(epochMs));
  for (let call = 1; call <= 3; call++)
    expect(
      outcome(() => usEquityMarketDayIndex(epochMs)),
      `${epochMs}, call ${call}`,
    ).toEqual(expected);
};

describe('usEquityMarketDayIndex answers from the clock hour, exactly as Intl does', () => {
  it('matches Intl on 50,000 instants from 2000 BC to 3000 AD, fractional milliseconds included', () => {
    let seed = 20261006;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const from = Date.UTC(-2000, 0, 1);
    const to = Date.UTC(3000, 0, 1);
    for (let i = 0; i < 50_000; i++) expectSameDay(from + random() * (to - from));
  });

  it('matches Intl on both sides of every New York clock change and midnight, 1860 to 2100', () => {
    // Each day whose New York UTC offset differs from the day before has a clock change: probe every
    // UTC hour around it (local midnights included) at the boundary and just either side.
    const offsetFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'longOffset',
    });
    const offsetAt = (ms: number) =>
      offsetFormatter.formatToParts(new Date(ms)).find((part) => part.type === 'timeZoneName')
        ?.value;
    let changes = 0;
    let previous = offsetAt(Date.UTC(1859, 11, 31, 12));
    for (let day = Date.UTC(1860, 0, 1); day < Date.UTC(2101, 0, 1); day += 86_400_000) {
      const current = offsetAt(day + 12 * 3_600_000);
      if (current === previous) continue;
      // The first millisecond of the new offset lies within the 24 hours before the probe. The cache
      // is sound only because it is always the start of a UTC hour: check the zone data says so.
      let before = day - 12 * 3_600_000;
      let after = day + 12 * 3_600_000;
      while (after - before > 1) {
        const middle = before + Math.floor((after - before) / 2);
        if (offsetAt(middle) === previous) before = middle;
        else after = middle;
      }
      expect(((after % 3_600_000) + 3_600_000) % 3_600_000, new Date(after).toISOString()).toBe(0);
      previous = current;
      changes++;
      for (let hour = -36; hour <= 36; hour++) {
        const boundary = day + hour * 3_600_000;
        for (const delta of [-1, -0.5, 0, 0.5, 1, 1_799_999, 3_599_999])
          expectSameDay(boundary + delta);
      }
    }
    // Standard time in 1883, war time, and two changes a year since 1918 (with gaps).
    expect(changes).toBeGreaterThan(300);
  });

  it('answers the local-mean-time era exactly, where midnight falls inside a clock hour', () => {
    // Before 18 Nov 1883 New York ran at −4:56:02: local midnight is 04:56:02Z.
    const midnight = Date.UTC(1880, 5, 2, 4, 56, 2);
    expect(referenceDayIndex(midnight - 1)).toBe(referenceDayIndex(midnight) - 1);
    for (let second = -3600; second <= 3600; second++) {
      expectSameDay(midnight + second * 1000);
      expectSameDay(midnight + second * 1000 - 1);
    }
    // The 1883 switch to standard time, at local noon.
    for (let minute = -120; minute <= 120; minute++)
      expectSameDay(Date.UTC(1883, 10, 18, 17) + minute * 60_000);
  });

  it('keeps the edge of the time range, signed zero and invalid input exactly as Intl answers them', () => {
    // The range ends at ±8.64e15; the cache serves only instants at least one hour inside it.
    // No fractions here: above 2^52 a double steps by whole milliseconds.
    for (const edge of [8.64e15, -8.64e15]) {
      const inward = -Math.sign(edge);
      for (const delta of [0, 1, -1, 3_600_000, -3_600_000]) expectSameDay(edge + delta);
      for (const delta of [3_599_999, 3_600_000, 3_600_001, 7_200_000])
        expectSameDay(edge + inward * delta);
    }
    for (const value of [0, -0, 0.5, -0.5, -1, 1, NaN, Infinity, -Infinity, Number.MAX_VALUE])
      expectSameDay(value);
    // Not a number at all: whatever `new Date` makes of it, as before.
    for (const value of ['2026-06-04T15:00:00Z', null, undefined] as unknown as number[])
      expectSameDay(value);
  });

  it('reads Intl three times per clock hour of a session, not once per instant', async () => {
    // A fresh module, so no other test's hours are already known.
    vi.resetModules();
    const fresh = await import('../src/time.js');
    // A trading session's worth of prints, one every 0.47 s.
    const open = Date.UTC(2031, 2, 4, 14, 30);
    const instants = Array.from({ length: 50_000 }, (_, i) => open + i * 470);
    const expected = referenceDayIndex(open);
    const hours = new Set(instants.map((at) => Math.floor(at / 3_600_000))).size;
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      const days = new Set(instants.map((at) => fresh.usEquityMarketDayIndex(at)));
      expect([...days]).toEqual([expected]);
      // Per UTC hour: the first print read exactly, then the hour's first and last millisecond.
      expect(hours).toBe(8);
      expect(formatToParts).toHaveBeenCalledTimes(3 * hours);
    } finally {
      formatToParts.mockRestore();
    }
  });

  it('costs one Intl read for an hour asked about once, as before the cache', async () => {
    vi.resetModules();
    const fresh = await import('../src/time.js');
    // A daily backtest: one close a day for 1,000 days, each in its own UTC hour.
    const closes = Array.from(
      { length: 1_000 },
      (_, i) => Date.UTC(2032, 0, 1, 20) + i * 86_400_000,
    );
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      const reads = () => formatToParts.mock.calls.length;
      const pass = () => closes.map((at) => fresh.usEquityMarketDayIndex(at));
      const expected = closes.map((at) => referenceDayIndex(at));
      formatToParts.mockClear();
      expect(pass()).toEqual(expected);
      expect(reads()).toBe(closes.length);
      // A second visit reads each hour's two ends; after that the hours answer from memory.
      formatToParts.mockClear();
      expect(pass()).toEqual(expected);
      expect(reads()).toBe(2 * closes.length);
      formatToParts.mockClear();
      expect(pass()).toEqual(expected);
      expect(reads()).toBe(0);
    } finally {
      formatToParts.mockRestore();
    }
  });

  it('stays exact past the bound of its memory', () => {
    const start = Date.UTC(2040, 0, 1);
    for (let hour = 0; hour < 9_000; hour++) expectSameDay(start + hour * 3_600_000 + 1_234);
    expectSameDay(start + 1_234);
  });
});

describe('optionExpiryToMs remembers parsed labels, never failures', () => {
  it('returns the same instants from the cache, past its bound, and throws on every bad label', () => {
    expect(optionExpiryToMs('2026-09-18')).toBe(Date.UTC(2026, 8, 18, 20));
    expect(optionExpiryToMs('2026-09-18')).toBe(Date.UTC(2026, 8, 18, 20));
    // More distinct labels than the cache holds: every one still resolves exactly.
    for (let minute = 0; minute < 3000; minute++) {
      const at = Date.UTC(2027, 0, 4, 14, 0) + minute * 60_000;
      const label = new Date(at).toISOString().replace('.000Z', 'Z');
      expect(optionExpiryToMs(label)).toBe(at);
      expect(optionExpiryToMs(label)).toBe(at);
    }
    // A failure is not cached: the same bad label teaches every time.
    for (let attempt = 0; attempt < 2; attempt++) {
      let error: unknown;
      try {
        optionExpiryToMs('2026-02-31');
      } catch (caught) {
        error = caught;
      }
      expect(isQuantError(error)).toBe(true);
    }
  });
});
