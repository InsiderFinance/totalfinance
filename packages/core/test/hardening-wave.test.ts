/**
 * The 2026-08-02 defect-fix wave for `@totalfinance/core`: one regression test per reviewed finding,
 * plus the property packs that keep the classes closed rather than the single reproductions.
 *
 * Every test in this file FAILS on the pre-fix source. Grouped by finding so a future bisect reads
 * as a sentence: what broke, what it did, what it does now.
 */

import { describe, expect, it } from 'vitest';
import {
  type Computed,
  type Provenance,
  ConfigurationError,
  InputError,
  PostconditionError,
  assertFiniteResult,
  assertFiniteValue,
  createRuleCalendar,
  emptyDiagnostics,
  formatOccSymbol,
  isQuantError,
  isoDateToEpochMs,
  nthWeekdayOfMonth,
  optionExpiryToMs,
  parseIsoDate,
  parseOccSymbol,
  resolveAsOf,
  resolvedExpiry,
  round,
  selectQuotePrice,
} from '@totalfinance/core';
import type { OptionQuote, PriceSource } from '@totalfinance/core';
import {
  CorporateActionSchema,
  RawFundamentalsRecordSchema,
  OptionContractSchema,
  schema,
} from '@totalfinance/core/schema';

// ---------------------------------------------------------------------------
// [1] schema: adversarial keys can neither vanish nor rewrite an output prototype
// ---------------------------------------------------------------------------

/**
 * The four keys that make `out[key] = value` unsafe. `__proto__` is the live one — it is an
 * accessor on `Object.prototype`, so a plain assignment either swallows the value (primitive) or
 * REPLACES the output object's prototype (object). The other three are inherited data properties
 * that a shape check must not confuse with own data.
 *
 * `JSON.parse` is the honest source: it produces these as genuine OWN keys, exactly as a payload
 * off the wire would.
 */
const ADVERSARIAL_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'] as const;

/** An object value is the dangerous payload: assigning it to `__proto__` swaps the prototype. */
const POISON = { success: true, polluted: 'yes' };

function payloadWith(key: string, value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ [key]: value })) as Record<string, unknown>;
}

describe('[1] schema: adversarial keys land as own data properties (record/passthrough/open)', () => {
  const OpenRecord = schema.record(schema.unknown());

  for (const key of ADVERSARIAL_KEYS) {
    it(`record(): "${key}" survives as an OWN property, prototype untouched`, () => {
      const parsed = OpenRecord.parse(payloadWith(key, POISON));
      expect(Object.prototype.hasOwnProperty.call(parsed, key)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(parsed, key)?.value).toEqual(POISON);
      // The output is still a bare object literal — nothing was grafted onto its prototype.
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      expect((parsed as { success?: unknown }).success).toBeUndefined();
      // …and no pollution escaped to every object in the process.
      expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it(`record(): "${key}" round-trips through JSON.stringify (it is real data now)`, () => {
      const parsed = OpenRecord.parse(payloadWith(key, 42));
      expect(JSON.parse(JSON.stringify(parsed))).toEqual({ [key]: 42 });
    });
  }

  it('record(): insertion order is preserved across adversarial and normal keys', () => {
    const input = JSON.parse('{"a":1,"__proto__":2,"b":3,"constructor":4,"c":5}') as unknown;
    const parsed = OpenRecord.parse(input);
    expect(Object.keys(parsed)).toEqual(['a', '__proto__', 'b', 'constructor', 'c']);
  });

  it('object() passthrough: unknown adversarial keys are copied as own data, not plumbing', () => {
    const Shape = schema.object({ symbol: schema.string() });
    for (const key of ADVERSARIAL_KEYS) {
      const input = JSON.parse(JSON.stringify({ symbol: 'AAPL', [key]: POISON })) as unknown;
      const parsed = Shape.parse(input, { mode: 'passthrough' }) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(parsed, key)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(parsed, key)?.value).toEqual(POISON);
      expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
      expect((parsed as { success?: unknown }).success).toBeUndefined();
      expect(parsed['symbol']).toBe('AAPL');
    }
  });

  it('object() strict/coerce: an adversarial key is REJECTED as an unknown field', () => {
    const Shape = schema.object({ symbol: schema.string() });
    for (const key of ADVERSARIAL_KEYS) {
      const input = JSON.parse(JSON.stringify({ symbol: 'AAPL', [key]: POISON })) as unknown;
      for (const mode of ['strict', 'coerce'] as const) {
        const r = Shape.safeParse(input, { mode });
        expect(r.success, `${key} in ${mode} mode`).toBe(false);
        if (!r.success) {
          expect(r.issues[0]?.code).toBe('input.unknown_field');
          expect(r.issues[0]?.path).toEqual([key]);
        }
      }
    }
  });

  it('object(): an adversarial key DECLARED in the shape lands as own data', () => {
    // A schema may legitimately declare such a field; the write side must still be safe.
    const Shape = schema.object({ ['__proto__']: schema.object({ nested: schema.number() }) });
    const parsed = Shape.parse(JSON.parse('{"__proto__":{"nested":7}}')) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value).toEqual({ nested: 7 });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('SHIPPED PATH RawFundamentalsRecordSchema.fields: adversarial keys are preserved, not plumbing', () => {
    const raw = JSON.parse(
      '{"symbol":"AAPL","fields":{"pe":28.4,"__proto__":"poison","constructor":"c","toString":"t","hasOwnProperty":"h"}}',
    ) as unknown;
    const parsed = RawFundamentalsRecordSchema.parse(raw);
    expect(parsed.fields['pe']).toBe(28.4);
    for (const key of ADVERSARIAL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(parsed.fields, key)).toBe(true);
    }
    expect(Object.getOwnPropertyDescriptor(parsed.fields, '__proto__')?.value).toBe('poison');
    expect(Object.getPrototypeOf(parsed.fields)).toBe(Object.prototype);
    // The record's value schema still applies to adversarial keys (scalar-or-null, not objects).
    const bad = JSON.parse('{"symbol":"AAPL","fields":{"__proto__":{"nested":true}}}') as unknown;
    expect(RawFundamentalsRecordSchema.safeParse(bad).success).toBe(false);
  });

  it('SHIPPED PATH CorporateActionSchema.details: same guarantee on an open record', () => {
    const raw = JSON.parse(
      '{"symbol":"AAPL","effectiveDate":"2026-06-09","type":"split","ratio":4,"details":{"__proto__":{"success":true},"note":"4-for-1"}}',
    ) as unknown;
    const parsed = CorporateActionSchema.parse(raw);
    const details = parsed.details as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(details, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(details, '__proto__')?.value).toEqual({ success: true });
    expect(Object.getPrototypeOf(details)).toBe(Object.prototype);
    expect((details as { success?: unknown }).success).toBeUndefined();
    expect(details['note']).toBe('4-for-1');
  });

  it('a parsed result never inherits `success: true` from a poisoned prototype', () => {
    // The precise pre-fix failure: `{"__proto__":{"success":true}}` made the RETURNED data object
    // report `success === true` by inheritance — indistinguishable from a real SafeParseResult.
    const parsed = schema.record(schema.unknown()).parse(JSON.parse('{"__proto__":{"success":1}}'));
    expect((parsed as { success?: unknown }).success).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// [2/3/4] the Law-7 walker
// ---------------------------------------------------------------------------

function envelope<T>(value: T, extra: Partial<Computed<T>> = {}): Computed<T> {
  return {
    value,
    assumptions: { conventionsVersion: 'test' } as never,
    diagnostics: emptyDiagnostics(),
    ...extra,
  };
}

describe('[2] Law-7 walker: sentinels are anchored on SHAPE, not on `direction === 0`', () => {
  it('a shipped zone sentinel is still exempt (fairValueGaps/orderBlocks "none")', () => {
    const zones = [{ direction: 0, top: NaN, bottom: NaN, mid: NaN }];
    expect(() => assertFiniteResult('fairValueGaps', envelope(zones))).not.toThrow();
  });

  it('a shipped liquidity-sweep sentinel is still exempt', () => {
    const sweeps = [{ direction: 0, level: NaN }];
    expect(() => assertFiniteResult('liquiditySweeps', envelope(sweeps))).not.toThrow();
  });

  it('a shipped divergence sentinel is still exempt (`code: 0` + priceSwings)', () => {
    const points = [{ index: NaN, code: 0, priceSwings: [NaN, NaN], indicatorSwings: [NaN, NaN] }];
    expect(() => assertFiniteResult('divergences', envelope(points))).not.toThrow();
  });

  it('REGRESSION: tdSequential-shaped `direction: 0` elements ARE walked', () => {
    // The shipped tdSequential emits an honest `{ setup, countdown, direction: 0 }`. Under the old
    // value-matched exemption, ANY element saying `direction: 0` was skipped wholesale — so a NaN
    // setup/countdown shipped silently into a serialization.
    const points = [{ setup: NaN, countdown: 0, direction: 0 }];
    expect(() => assertFiniteResult('tdSequential', envelope(points))).toThrow(PostconditionError);
    try {
      assertFiniteResult('tdSequential', envelope(points));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { context?: { paths?: string[] } }).context?.paths).toEqual([
        'value[0].setup',
      ]);
    }
  });

  it('REGRESSION: a NaN in a NON-sentinel field of a sentinel-shaped element is caught', () => {
    // `top`/`bottom`/`mid` are the documented NaN-when-none fields. `strength` is not — a NaN there
    // is a defect the disclosure does not cover.
    const zones = [{ direction: 0, top: NaN, bottom: NaN, mid: NaN, strength: NaN }];
    expect(() => assertFiniteResult('zones', envelope(zones))).toThrow(/non-finite number at/);
    try {
      assertFiniteResult('zones', envelope(zones));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { context?: { paths?: string[] } }).context?.paths).toEqual([
        'value[0].strength',
      ]);
    }
  });

  it('a bare `direction: 0` object with no zone/sweep shape is walked in full', () => {
    expect(() => assertFiniteValue('custom', [{ direction: 0, whatever: Infinity }])).toThrow(
      PostconditionError,
    );
  });

  it('`code: 0` without priceSwings is still not a sentinel (unrelated numeric codes)', () => {
    expect(() => assertFiniteValue('codes', [{ code: 0, latencyMs: NaN }])).toThrow(
      PostconditionError,
    );
  });

  it('the warmup-prefix sentinel is unchanged', () => {
    const series = [NaN, NaN, 1, 2];
    const withWarmup = envelope(series, { diagnostics: { warnings: [], warmup: 2 } as never });
    expect(() => assertFiniteResult('sma', withWarmup)).not.toThrow();
    // …and a NaN PAST the declared prefix is still a defect.
    const leaky = envelope([NaN, NaN, 1, NaN], {
      diagnostics: { warnings: [], warmup: 2 } as never,
    });
    expect(() => assertFiniteResult('sma', leaky)).toThrow(PostconditionError);
  });
});

describe('[3] Law-7 walker: `provenance` is the 4th Computed field and is walked', () => {
  it('REGRESSION: a NaN in provenance.asOf throws PostconditionError', () => {
    const result = envelope(1, { provenance: { provider: 'test', asOf: NaN } as Provenance });
    expect(() => assertFiniteResult('priced', result)).toThrow(PostconditionError);
    try {
      assertFiniteResult('priced', result);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { context?: { paths?: string[] } }).context?.paths).toEqual([
        'provenance.asOf',
      ]);
    }
  });

  it('a nested non-finite under provenance.warnings is caught too', () => {
    const result = envelope(1, {
      provenance: {
        provider: 'test',
        warnings: [{ code: 'x', message: 'y', severity: 'info', stalenessMs: Infinity }],
      } as never,
    });
    expect(() => assertFiniteResult('priced', result)).toThrow(PostconditionError);
  });

  it('a finite provenance passes untouched', () => {
    const result = envelope(1, {
      provenance: { provider: 'polygon', asOf: Date.UTC(2026, 6, 6) },
    });
    expect(() => assertFiniteResult('priced', result)).not.toThrow();
  });
});

describe('[4] Law-7 walker: values JSON.stringify cannot carry are violations', () => {
  it('REGRESSION: BigInt is flagged (JSON.stringify THROWS on it)', () => {
    // Pre-fix this passed the walker, then exploded at the serialization boundary.
    expect(() => JSON.stringify({ size: 1n })).toThrow(TypeError);
    expect(() => assertFiniteValue('flow', { size: 1n })).toThrow(PostconditionError);
    expect(() => assertFiniteResult('flow', envelope({ size: 1n }))).toThrow(
      /non-finite number at/,
    );
  });

  it('EQUAL bigints are each reported — the cycle set must not dedupe them by value', () => {
    // `Set` identity is SameValueZero, so 1n === 1n: checking bigints before the cycle set is what
    // keeps the second occurrence from disappearing out of the reported paths.
    try {
      assertFiniteValue('flow', { a: 1n, b: 1n });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { context?: { paths?: string[] } }).context?.paths).toEqual([
        'value.a',
        'value.b',
      ]);
    }
  });

  it('REGRESSION: DataView is flagged (isView but no .length ⇒ silently skipped)', () => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, Number.NaN);
    expect(ArrayBuffer.isView(view)).toBe(true);
    expect((view as unknown as { length?: number }).length).toBeUndefined();
    expect(JSON.stringify({ view })).toBe('{"view":{}}'); // silently corrupted
    expect(() => assertFiniteValue('bytes', { view })).toThrow(PostconditionError);
  });

  it('REGRESSION: Map values are walked (stringify drops them silently)', () => {
    expect(JSON.stringify({ m: new Map([['a', NaN]]) })).toBe('{"m":{}}');
    expect(() => assertFiniteValue('byStrike', { m: new Map([['a', NaN]]) })).toThrow(
      PostconditionError,
    );
    try {
      assertFiniteValue('byStrike', { m: new Map([['a', Infinity]]) });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { context?: { paths?: string[] } }).context?.paths).toEqual(['value.m[a]']);
    }
  });

  it('REGRESSION: Set values are walked too', () => {
    expect(() => assertFiniteValue('levels', { s: new Set([1, 2, NaN]) })).toThrow(
      PostconditionError,
    );
  });

  it('a nested non-finite inside a Map value object is caught', () => {
    const m = new Map<string, { gamma: number }>([['SPY', { gamma: Number.NaN }]]);
    expect(() => assertFiniteValue('gex', m)).toThrow(PostconditionError);
  });

  it('finite Maps/Sets/typed arrays still pass', () => {
    expect(() =>
      assertFiniteValue('ok', {
        m: new Map([['a', 1]]),
        s: new Set([1, 2]),
        t: new Float64Array([1, 2, 3]),
      }),
    ).not.toThrow();
  });

  it('the walker stays cycle-safe with the new container branches', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const m = new Map<string, unknown>([['loop', cyclic]]);
    cyclic['m'] = m;
    expect(() => assertFiniteValue('cyclic', cyclic)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [5] round()
// ---------------------------------------------------------------------------

describe('[5] round(): total over the double domain', () => {
  it('the motivating half-away-from-zero cases are unchanged', () => {
    expect(round(1.005, 2)).toBe(1.01);
    expect(round(2.675, 2)).toBe(2.68);
    expect(round(-1.005, 2)).toBe(-1.01);
    expect(round(1234567.005, 2)).toBe(1234567.01);
    expect(round(-1234567.005, 2)).toBe(-1234567.01);
    expect(round(2.5)).toBe(3);
    expect(round(-2.5)).toBe(-3);
    expect(round(1.4999)).toBe(1);
    expect(round(0)).toBe(0);
  });

  it('REGRESSION: MAX_VALUE is an identity, not Infinity', () => {
    // Pre-fix: value * (1 + ε) overflowed, and MAX_VALUE * 100 / 100 came back Infinity.
    expect(round(Number.MAX_VALUE, 2)).toBe(Number.MAX_VALUE);
    expect(round(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    expect(round(-Number.MAX_VALUE, 4)).toBe(-Number.MAX_VALUE);
    expect(Number.isFinite(round(Number.MAX_VALUE, 2))).toBe(true);
  });

  it('REGRESSION: integers at/above 2^53 are returned exactly', () => {
    // Pre-fix: round(1e16, 0) === 1e16 + 2 — the epsilon nudge exceeded one ulp at that scale.
    expect(round(1e16, 0)).toBe(1e16);
    expect(round(1e16, 2)).toBe(1e16);
    expect(round(2 ** 53)).toBe(2 ** 53);
    expect(round(2 ** 53 + 2, 0)).toBe(2 ** 53 + 2);
    expect(round(-(2 ** 53))).toBe(-(2 ** 53));
    expect(round(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('PROPERTY: rounding an integer to >= 0 decimals is the identity', () => {
    const integers = [0, 1, -1, 7, 1e6, 2 ** 31, 2 ** 53, 1e16, 1e21, Number.MAX_VALUE];
    for (const value of integers) {
      for (const decimals of [0, 1, 2, 6, 15]) {
        expect(round(value, decimals), `round(${value}, ${decimals})`).toBe(value);
        expect(round(-value, decimals), `round(${-value}, ${decimals})`).toBe(-value);
      }
    }
  });

  it('PROPERTY: round is idempotent and never manufactures a non-finite from a finite', () => {
    const values = [
      0.1,
      1.005,
      2.675,
      -3.14159,
      1e-7,
      1e-300,
      5e-324,
      1e15,
      1e16,
      1e300,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
    ];
    for (const value of values) {
      for (const decimals of [0, 1, 2, 8, 100, 300, 323, -1, -3, -100, -323]) {
        const once = round(value, decimals);
        expect(Number.isFinite(once), `round(${value}, ${decimals}) = ${once}`).toBe(true);
        expect(round(once, decimals), `idempotence at (${value}, ${decimals})`).toBe(once);
      }
    }
  });

  it('REGRESSION: |decimals| beyond the double grid is a typed InputError, never NaN', () => {
    // Pre-fix: 10 ** 400 === Infinity ⇒ Infinity/Infinity ⇒ NaN returned from a "successful" call.
    for (const decimals of [400, -400, 324, -324, 1e6]) {
      expect(() => round(1.5, decimals)).toThrow(InputError);
      try {
        round(1.5, decimals);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(isQuantError(error, 'input.out_of_range')).toBe(true);
        expect((error as Error).message).toMatch(/decimals must be an integer in \[-323, 323\]/);
      }
    }
  });

  it('non-integer / non-finite decimals are rejected (they used to silently scale)', () => {
    for (const decimals of [1.5, Number.NaN, Infinity, -Infinity]) {
      expect(() => round(1.5, decimals)).toThrow(InputError);
    }
  });

  it('the decimals bounds are inclusive and usable', () => {
    expect(round(1.5, 323)).toBe(1.5);
    expect(round(1.5, -323)).toBe(0);
    expect(round(12345, -3)).toBe(12000);
    expect(round(1.5, 0)).toBe(2);
  });

  it('non-finite VALUES still pass through unchanged (documented behavior)', () => {
    expect(round(Number.NaN, 2)).toBeNaN();
    expect(round(Infinity, 2)).toBe(Infinity);
    expect(round(-Infinity, 2)).toBe(-Infinity);
  });
});

// ---------------------------------------------------------------------------
// [6] createRuleCalendar: config snapshot + termination guards
// ---------------------------------------------------------------------------

describe('[6] createRuleCalendar: the config is snapshotted at construction', () => {
  it('REGRESSION: mutating the rules array after a warm query cannot split the answer', () => {
    const rules = [(y: number) => `${y}-01-01`];
    const cal = createRuleCalendar({
      name: 'MUTABLE',
      version: '1.0.0',
      timezone: 'UTC',
      session: { open: '09:30', close: '16:00' },
      holidayRules: rules,
    });
    expect(cal.isHoliday('2026-03-17')).toBe(false); // warms the 2026 memo
    rules.push((y: number) => `${y}-03-17`); // a LIVE reference would pick this up
    expect(cal.isHoliday('2026-03-17')).toBe(false); // warm year: unchanged
    expect(cal.isHoliday('2027-03-17')).toBe(false); // cold year must AGREE with the warm one
  });

  it('REGRESSION: mutating the session object cannot change what a warm calendar reports', () => {
    const session = { open: '09:30', close: '16:00', halfDayClose: '13:00' };
    const cal = createRuleCalendar({
      name: 'SESSION',
      version: '1.0.0',
      timezone: 'UTC',
      session,
    });
    expect(cal.session('2026-01-02').close).toBe('16:00');
    session.close = '23:59';
    session.open = '00:01';
    expect(cal.session('2026-01-02')).toMatchObject({ open: '09:30', close: '16:00' });
  });

  it('mutating weekendDays / closures after construction is likewise inert', () => {
    const weekendDays: (0 | 6)[] = [0, 6];
    const closures = ['2026-03-17'];
    const cal = createRuleCalendar({
      name: 'ARRAYS',
      version: '1.0.0',
      timezone: 'UTC',
      session: { open: '09:30', close: '16:00' },
      weekendDays,
      closures,
    });
    expect(cal.isBusinessDay('2026-03-18')).toBe(true);
    weekendDays.push(3 as never); // Wednesday
    closures.push('2026-03-18');
    expect(cal.isBusinessDay('2026-03-18')).toBe(true);
  });

  it('REGRESSION: a 7-day weekend is rejected at construction (it could never terminate)', () => {
    expect(() =>
      createRuleCalendar({
        name: 'NEVER_OPEN',
        version: '1.0.0',
        timezone: 'UTC',
        weekendDays: [0, 1, 2, 3, 4, 5, 6],
        session: { open: '00:00', close: '24:00' },
      }),
    ).toThrow(ConfigurationError);
    try {
      createRuleCalendar({
        name: 'NEVER_OPEN',
        version: '1.0.0',
        timezone: 'UTC',
        weekendDays: [6, 5, 4, 3, 2, 1, 0],
        session: { open: '00:00', close: '24:00' },
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isQuantError(error, 'input.out_of_range')).toBe(true);
      expect((error as Error).message).toMatch(/all 7/);
      expect((error as Error).message).toMatch(/weekendDays/);
      expect((error as Error).message).toMatch(/NEVER_OPEN/); // names the offending calendar
    }
  });

  it('the guard counts REAL weekdays: an out-of-range entry cannot fake a full week', () => {
    // `[1..7]` has seven entries but leaves Sunday open, so this calendar terminates and must
    // build — a naive `weekendDays.length >= 7` check would reject it with a false explanation.
    const cal = createRuleCalendar({
      name: 'SUNDAY_ONLY',
      version: '1.0.0',
      timezone: 'UTC',
      weekendDays: [1, 2, 3, 4, 5, 6, 7] as never,
      session: { open: '00:00', close: '24:00' },
    });
    expect(cal.nextBusinessDay('2026-01-05')).toBe('2026-01-11'); // the next Sunday
  });

  it('a 6-day weekend is legal (one open weekday still terminates)', () => {
    const cal = createRuleCalendar({
      name: 'MONDAYS_ONLY',
      version: '1.0.0',
      timezone: 'UTC',
      weekendDays: [0, 2, 3, 4, 5, 6],
      session: { open: '09:30', close: '16:00' },
    });
    expect(cal.nextBusinessDay('2026-01-05')).toBe('2026-01-12'); // Monday → Monday
  });

  it('REGRESSION: addBusinessDays caps |n| instead of grinding for hours', () => {
    const cal = createRuleCalendar({
      name: 'CAP',
      version: '1.0.0',
      timezone: 'UTC',
      session: { open: '09:30', close: '16:00' },
    });
    for (const n of [1_000_001, -1_000_001, 1e12]) {
      expect(() => cal.addBusinessDays('2026-01-02', n)).toThrow(InputError);
      try {
        cal.addBusinessDays('2026-01-02', n);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(isQuantError(error, 'input.out_of_range')).toBe(true);
        expect((error as Error).message).toMatch(/business days/);
      }
    }
    // The existing contract is untouched either side of the cap.
    expect(cal.addBusinessDays('2026-01-02', 1)).toBe('2026-01-05');
    expect(() => cal.addBusinessDays('2026-01-02', 1.5)).toThrow(/must be an integer/);
    expect(() => cal.addBusinessDays('2026-01-02', Infinity)).toThrow(InputError);
  });
});

// ---------------------------------------------------------------------------
// [7] the parsed option contract is DEEP-frozen
// ---------------------------------------------------------------------------

describe('[7] OptionContractSchema: the frozen artifact is frozen all the way down', () => {
  const adjusted = {
    underlying: 'AAPL',
    type: 'call' as const,
    style: 'american' as const,
    strike: 105,
    expiry: '2026-09-18',
    expiresAt: optionExpiryToMs('2026-09-18'),
    expiryConvention: 'us-equity-close' as const,
    deliverable: {
      cash: 12.5,
      shares: [{ symbol: 'AAPL', quantity: 100 }],
      notes: 'post-split adjusted',
    },
  };

  it('REGRESSION: deliverable and shares[] are frozen, not just the top level', () => {
    const parsed = OptionContractSchema.parse(adjusted);
    const contract = parsed as typeof adjusted;
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.deliverable)).toBe(true);
    expect(Object.isFrozen(contract.deliverable.shares)).toBe(true);
    expect(Object.isFrozen(contract.deliverable.shares[0])).toBe(true);
  });

  it('REGRESSION: mutating the economics through the nested objects throws (strict mode)', () => {
    const contract = OptionContractSchema.parse(adjusted) as typeof adjusted;
    // Vitest runs ESM (always strict), so a frozen write throws rather than failing silently.
    expect(() => {
      contract.deliverable.cash = 999;
    }).toThrow(TypeError);
    expect(() => {
      contract.deliverable.shares[0]!.quantity = 1;
    }).toThrow(TypeError);
    expect(() => contract.deliverable.shares.push({ symbol: 'X', quantity: 1 })).toThrow(TypeError);
    expect(contract.deliverable.cash).toBe(12.5);
    expect(contract.deliverable.shares[0]?.quantity).toBe(100);
  });

  it('a contract with no deliverable still parses and freezes', () => {
    const { deliverable: _drop, ...plain } = adjusted;
    const contract = OptionContractSchema.parse(plain);
    expect(Object.isFrozen(contract)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [8] nthWeekdayOfMonth
// ---------------------------------------------------------------------------

describe('[8] nthWeekdayOfMonth: no fabricated dates, no silent day-34', () => {
  it('the shipped rules are unchanged', () => {
    expect(nthWeekdayOfMonth(2026, 1, 1, 3)).toBe('2026-01-19'); // MLK
    expect(nthWeekdayOfMonth(2026, 2, 1, 3)).toBe('2026-02-16'); // Presidents' Day
    expect(nthWeekdayOfMonth(2026, 11, 4, 4)).toBe('2026-11-26'); // Thanksgiving
    expect(nthWeekdayOfMonth(2026, 9, 1, 1)).toBe('2026-09-07'); // Labor Day
  });

  it('REGRESSION: a 5th Friday of Feb 2026 returns null (was "2026-02-34")', () => {
    expect(nthWeekdayOfMonth(2026, 2, 5, 5)).toBeNull();
  });

  it('REGRESSION: a 5th Monday of Feb 2021 returns null (was "2021-02-29", a non-date)', () => {
    expect(nthWeekdayOfMonth(2021, 2, 1, 5)).toBeNull();
  });

  it('REGRESSION: occurrence 0 / negative / fractional is a typed InputError', () => {
    for (const occurrence of [0, -1, 1.5, Number.NaN]) {
      expect(() => nthWeekdayOfMonth(2026, 1, 1, occurrence)).toThrow(InputError);
      try {
        nthWeekdayOfMonth(2026, 1, 1, occurrence);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(isQuantError(error, 'input.out_of_range')).toBe(true);
        expect((error as Error).message).toMatch(/occurrence must be an integer >= 1/);
      }
    }
  });

  it('PROPERTY: every non-null result is a real calendar date with the right weekday/rank', () => {
    for (let month = 1; month <= 12; month++) {
      for (let weekday = 0; weekday <= 6; weekday++) {
        for (let occurrence = 1; occurrence <= 6; occurrence++) {
          for (const year of [2021, 2024, 2026]) {
            const iso = nthWeekdayOfMonth(year, month, weekday as 0, occurrence);
            if (iso === null) continue;
            const { year: y, month: m, day } = parseIsoDate(iso); // throws on a fabricated date
            expect(y).toBe(year);
            expect(m).toBe(month);
            expect(new Date(isoDateToEpochMs(iso)).getUTCDay()).toBe(weekday);
            expect(Math.ceil(day / 7)).toBe(occurrence);
          }
        }
      }
    }
  });

  it('the 5th occurrence exists exactly when the month is long enough', () => {
    expect(nthWeekdayOfMonth(2026, 1, 5, 5)).toBe('2026-01-30'); // Jan 2026 has 5 Fridays
    expect(nthWeekdayOfMonth(2026, 2, 5, 5)).toBeNull(); // Feb 2026 has 4
  });
});

// ---------------------------------------------------------------------------
// [9] parseOccSymbol strike 0
// ---------------------------------------------------------------------------

describe('[9] parseOccSymbol: a zero strike is not a contract', () => {
  it('REGRESSION: strike 00000000 is rejected with formatOccSymbol’s message', () => {
    expect(() => parseOccSymbol('AAPL260918C00000000')).toThrow(/Strike must be > 0, received 0\./);
    try {
      parseOccSymbol('AAPL260918C00000000');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isQuantError(error, 'input.out_of_range')).toBe(true);
      expect((error as { context?: { field?: string } }).context?.field).toBe('strike');
    }
    // The two directions now agree, character for character.
    let parseMessage = '';
    let formatMessage = '';
    try {
      parseOccSymbol('AAPL260918C00000000');
    } catch (error) {
      parseMessage = (error as Error).message;
    }
    try {
      formatOccSymbol({ root: 'AAPL', expiry: '2026-09-18', type: 'call', strike: 0 });
    } catch (error) {
      formatMessage = (error as Error).message;
    }
    // C hygiene: each door prefixes its own name; the sentence after the prefix is shared.
    expect(parseMessage.replace(/^occSymbolParts: /, '')).toBe(
      formatMessage.replace(/^formatOccSymbol: /, ''),
    );
    expect(parseMessage.startsWith('occSymbolParts: ')).toBe(true);
    expect(formatMessage.startsWith('formatOccSymbol: ')).toBe(true);
  });

  it('PROPERTY: parse → format round-trips for every valid strike (still green)', () => {
    for (const sym of [
      'AAPL260918C00105000',
      'SPY260320P00450500',
      'TSLA271217C01234500',
      'A300101P00000500',
      'SPX261218C99999000',
      'BRKB260619P00001000',
    ]) {
      expect(formatOccSymbol(parseOccSymbol(sym))).toBe(sym);
    }
  });

  it('the smallest representable strike (1 thousandth) still parses', () => {
    const parsed = parseOccSymbol('AAPL260918C00000001');
    expect(parsed.strike).toBe(0.001);
    expect(formatOccSymbol(parsed)).toBe('AAPL260918C00000001');
  });
});

// ---------------------------------------------------------------------------
// [10] RFC-3339 lowercase t/z
// ---------------------------------------------------------------------------

describe('[10] time: RFC-3339 permits lowercase t/z', () => {
  it('REGRESSION: resolveAsOf accepts lowercase and agrees with uppercase exactly', () => {
    expect(resolveAsOf('2026-07-06t12:00:00z')).toBe(resolveAsOf('2026-07-06T12:00:00Z'));
    expect(resolveAsOf('2026-07-06t12:00:00z')).toBe(Date.UTC(2026, 6, 6, 12));
    expect(resolveAsOf('2026-07-06t09:30:00-05:00')).toBe(Date.UTC(2026, 6, 6, 14, 30));
  });

  it('REGRESSION: optionExpiryToMs accepts lowercase and agrees with uppercase', () => {
    expect(optionExpiryToMs('2026-09-18t20:00:00z')).toBe(optionExpiryToMs('2026-09-18T20:00:00Z'));
    expect(resolvedExpiry('2026-09-18t20:00:00z').expiryConvention).toBe('explicit-instant');
  });

  it('everything else stays strict: a lowercase zone-less datetime is still rejected', () => {
    expect(() => resolveAsOf('2026-07-06t12:00:00')).toThrow(/no timezone/);
    expect(() => optionExpiryToMs('2026-09-18t16:00')).toThrow(/no timezone/);
    expect(() => resolveAsOf('2026-07-06x12:00:00z')).toThrow(/cannot parse asOf/);
    expect(() => resolveAsOf('2026-13-01t12:00:00z')).toThrow(/is not a valid instant/);
    expect(() => resolveAsOf('2026-07-06t25:00:00z')).toThrow(/is not a valid instant/);
    expect(() => resolveAsOf('2026-07-06t12:00:00+15:00')).toThrow(/UTC offset is out of range/);
  });
});

// ---------------------------------------------------------------------------
// [11] years 0000–0099
// ---------------------------------------------------------------------------

describe('[11] dates: years 0000-0099 are literal, not remapped into the 1900s', () => {
  it('REGRESSION: 0099-12-31 parses instead of being called an invalid calendar date', () => {
    // Pre-fix: Date.UTC(99, …) built 1999, so the round-trip check failed for EVERY year < 100.
    expect(parseIsoDate('0099-12-31')).toEqual({ year: 99, month: 12, day: 31 });
    expect(parseIsoDate('0001-01-01')).toEqual({ year: 1, month: 1, day: 1 });
    expect(parseIsoDate('0000-02-29')).toEqual({ year: 0, month: 2, day: 29 }); // year 0 is leap
  });

  it('REGRESSION: isoDateToEpochMs places those years correctly (not in the 1900s)', () => {
    const ms = isoDateToEpochMs('0099-12-31');
    const probe = new Date(0);
    probe.setUTCFullYear(99, 11, 31);
    expect(ms).toBe(probe.getTime());
    expect(new Date(ms).getUTCFullYear()).toBe(99);
    expect(ms).toBeLessThan(0); // firmly before the epoch, unlike a 1999 remap
  });

  it('REGRESSION: resolveAsOf and the datetime parser agree on an ancient date', () => {
    expect(resolveAsOf('0099-12-31')).toBe(isoDateToEpochMs('0099-12-31'));
    expect(resolveAsOf('0099-12-31T00:00:00Z')).toBe(isoDateToEpochMs('0099-12-31'));
  });

  it('invalid ancient dates are still rejected (the guard did not go soft)', () => {
    expect(() => parseIsoDate('0099-02-30')).toThrow(/not a valid calendar date/);
    expect(() => parseIsoDate('0001-13-01')).toThrow(/not a valid calendar date/);
    expect(() => parseIsoDate('0099-02-29')).toThrow(/not a valid calendar date/); // 99 not leap
  });

  it('modern dates are unaffected', () => {
    expect(isoDateToEpochMs('2026-01-01')).toBe(Date.UTC(2026, 0, 1));
    expect(parseIsoDate('2026-09-18')).toEqual({ year: 2026, month: 9, day: 18 });
  });

  it('REGRESSION: the schema date validator had the same defect and now agrees with core', () => {
    const Dated = schema.object({ on: schema.string().date() });
    expect(Dated.parse({ on: '0099-12-31' }).on).toBe('0099-12-31');
    expect(Dated.parse({ on: '0000-02-29' }).on).toBe('0000-02-29');
    // …and still rejects what core rejects.
    expect(Dated.safeParse({ on: '0099-02-29' }).success).toBe(false);
    expect(Dated.safeParse({ on: '2026-02-30' }).success).toBe(false);
    for (const on of ['0099-12-31', '0001-01-01', '2026-09-18']) {
      expect(Dated.safeParse({ on }).success, on).toBe(true);
      expect(() => parseIsoDate(on)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// [13] isIsoDateTime requires a zone
// ---------------------------------------------------------------------------

describe('[13] schema.string().datetime(): the zone is required (determinism law)', () => {
  const When = schema.object({ at: schema.string().datetime() });

  it('REGRESSION: a zone-less datetime is rejected (it would parse machine-locally)', () => {
    expect(When.safeParse({ at: '2026-07-06T12:00:00' }).success).toBe(false);
    expect(When.safeParse({ at: '2026-07-06T12:00' }).success).toBe(false);
    const r = When.safeParse({ at: '2026-07-06T12:00:00' });
    if (!r.success) expect(r.issues[0]?.message).toMatch(/must be an ISO date-time/);
  });

  it('zoned datetimes (including RFC-3339 lowercase) are accepted', () => {
    expect(When.parse({ at: '2026-07-06T12:00:00Z' }).at).toBe('2026-07-06T12:00:00Z');
    expect(When.parse({ at: '2026-07-06t12:00:00z' }).at).toBe('2026-07-06t12:00:00z');
    expect(When.parse({ at: '2026-07-06T12:00:00.123Z' }).at).toBe('2026-07-06T12:00:00.123Z');
    expect(When.parse({ at: '2026-07-06T12:00-05:00' }).at).toBe('2026-07-06T12:00-05:00');
  });

  it('it agrees with resolveAsOf: what the schema accepts, core can resolve', () => {
    for (const value of [
      '2026-07-06T12:00:00Z',
      '2026-07-06t12:00:00z',
      '2026-07-06T12:00-05:00',
    ]) {
      expect(When.safeParse({ at: value }).success).toBe(true);
      expect(() => resolveAsOf(value)).not.toThrow();
    }
    for (const value of ['2026-07-06T12:00:00', '2026-07-06T12:00']) {
      expect(When.safeParse({ at: value }).success).toBe(false);
      expect(() => resolveAsOf(value)).toThrow();
    }
  });

  it('the JSON Schema export still advertises format: date-time', () => {
    expect(When.toJSONSchema().properties?.['at']).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
  });
});

// ---------------------------------------------------------------------------
// [14] selectQuotePrice
// ---------------------------------------------------------------------------

describe('[14] selectQuotePrice: an unknown source is an error, not silence', () => {
  const quote: OptionQuote = {
    contract: {
      underlying: 'AAPL',
      type: 'call',
      style: 'american',
      strike: 100,
      expiry: '2026-09-18',
      ...resolvedExpiry('2026-09-18'),
    },
    timestampMs: Date.UTC(2026, 5, 18),
    bid: 3.1,
    ask: 3.3,
    last: 3.25,
  };

  it('REGRESSION: a typo no longer reads as "the field is absent"', () => {
    for (const bad of ['midd', 'MID', 'close', '', 'undefined']) {
      expect(() => selectQuotePrice(quote, bad as PriceSource)).toThrow(InputError);
      try {
        selectQuotePrice(quote, bad as PriceSource);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(isQuantError(error, 'input.invalid_enum')).toBe(true);
        expect((error as Error).message).toMatch(/source must be one of/);
      }
    }
    expect(() => selectQuotePrice(quote, undefined as unknown as PriceSource)).toThrow(InputError);
  });

  it('every legal source still behaves exactly as before', () => {
    expect(selectQuotePrice(quote, 'bid')).toBe(3.1);
    expect(selectQuotePrice(quote, 'ask')).toBe(3.3);
    expect(selectQuotePrice(quote, 'last')).toBe(3.25);
    expect(selectQuotePrice(quote, 'mid')).toBeCloseTo(3.2, 12);
    expect(selectQuotePrice(quote, 'mark')).toBeUndefined(); // absent field ⇒ undefined, no throw
    const { last: _drop, ...noLast } = quote;
    expect(selectQuotePrice(noLast, 'last')).toBeUndefined();
  });
});
