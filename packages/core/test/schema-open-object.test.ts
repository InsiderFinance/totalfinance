/**
 * Structured-open objects and the RateCurve JSON Schema (2026-08-23, fourth external review).
 *
 * The finding: `RateCurveSchema` had perfect semantic parity with `requireRateCurveData` but its
 * `toJSONSchema()` emitted a shapeless `{ type: 'object', additionalProperties: {} }` — no
 * required fields, no pillar shape, no compounding enum — useless to MCP tools, agents, generated
 * forms, and adapters. The fix is the facade's `.open()` object mode (full declared shape, unknown
 * keys allowed and preserved, `additionalProperties: true`) with the curve REBUILT on it while
 * still routing through the semantic validator. This suite is the test whose absence permitted the
 * regression: it pins the emitted JSON Schema's structure, the `.open()` runtime semantics, and
 * the "a value must pass BOTH doors" law.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { coreSchemas, RateCurvePointSchema, schema } from '@totalfinance/core/schema';

describe('schema.object().open() — structured-open objects', () => {
  const decorated = schema
    .object({ symbol: schema.string().nonempty(), price: schema.number() })
    .open();

  it('validates the declared shape and preserves unknown keys in strict mode', () => {
    const parsed = decorated.parse(
      { symbol: 'AAPL', price: 191, vendor: 'refinitiv' },
      { mode: 'strict' },
    );
    expect(parsed).toEqual({ symbol: 'AAPL', price: 191, vendor: 'refinitiv' });
  });

  it('an open object still refuses a bad DECLARED field — openness never weakens the shape', () => {
    const refused = decorated.safeParse({ symbol: 'AAPL', price: 'not-a-number', vendor: 'x' });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.issues[0]?.code).toBe(ErrorCode.InputWrongType);
      expect(refused.issues[0]?.path).toEqual(['price']);
    }
  });

  it('open() returns a NEW schema; the receiver stays closed (immutable refiner convention)', () => {
    const closed = schema.object({ symbol: schema.string() });
    const open = closed.open();
    expect(open).not.toBe(closed);
    expect(closed.safeParse({ symbol: 'AAPL', extra: 1 }).success).toBe(false);
    expect(open.safeParse({ symbol: 'AAPL', extra: 1 }).success).toBe(true);
    expect(closed.toJSONSchema().additionalProperties).toBe(false);
  });

  it('emits the full shape with additionalProperties: true', () => {
    const json = decorated.toJSONSchema();
    expect(json.type).toBe('object');
    expect(json.required).toEqual(['symbol', 'price']);
    expect(json.properties?.['symbol']).toMatchObject({ type: 'string', minLength: 1 });
    expect(json.additionalProperties).toBe(true);
  });

  it('a prototype-polluting decoration key lands as an own data key, never the prototype', () => {
    const parsed = decorated.parse(
      JSON.parse('{"symbol":"AAPL","price":1,"__proto__":{"polluted":true}}'),
    ) as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect((parsed as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
  });
});

describe('RateCurveSchema.toJSONSchema() is structured, not shapeless (fourth review, P1)', () => {
  const json = coreSchemas.RateCurve.toJSONSchema();

  it('names the required fields and stays open to vendor decoration', () => {
    expect(json.type).toBe('object');
    expect(json.required).toEqual(['currency', 'asOf', 'dayCount', 'compounding', 'points']);
    expect(json.additionalProperties).toBe(true);
    // `interpolation` is declared but optional.
    expect(json.properties?.['interpolation']).toMatchObject({ type: 'string' });
    expect(json.required).not.toContain('interpolation');
  });

  it('emits the pillar item shape — date format noted, zeroRate a number, entries open', () => {
    const points = json.properties?.['points'];
    expect(points?.type).toBe('array');
    expect(points?.items?.properties?.['date']).toMatchObject({ type: 'string', format: 'date' });
    expect(points?.items?.properties?.['zeroRate']).toMatchObject({ type: 'number' });
    expect(points?.items?.required).toEqual(['date', 'zeroRate']);
    expect(points?.items?.additionalProperties).toBe(true);
  });

  it('emits the FULL InterestCompounding grammar (derived from time.ts, both forms)', () => {
    const compounding = json.properties?.['compounding'];
    const named = compounding?.anyOf?.find((member) => member.enum !== undefined);
    expect(named?.enum).toEqual([
      'simple',
      'continuous',
      'annual',
      'semiannual',
      'quarterly',
      'monthly',
    ]);
    const periodic = compounding?.anyOf?.find((member) => member.type === 'object');
    expect(periodic?.properties?.['type']).toMatchObject({ const: 'periodic' });
    expect(periodic?.properties?.['periodsPerYear']).toMatchObject({
      type: 'number',
      exclusiveMinimum: 0,
    });
  });

  it('emits the real dayCount enum', () => {
    expect(json.properties?.['dayCount']).toMatchObject({
      type: 'string',
      enum: ['ACT/365F', 'ACT/360', '30/360'],
    });
  });
});

describe('RateCurveSchema: a value must pass BOTH doors (shape AND semantic validator)', () => {
  const base = {
    currency: 'USD',
    asOf: Date.UTC(2026, 6, 20),
    dayCount: 'ACT/365F',
    compounding: 'continuous',
    points: [
      { date: '2026-10-20', zeroRate: 0.045 },
      { date: '2027-07-20', zeroRate: 0.043 },
    ],
    interpolation: 'linearZero',
  };

  it('a structurally valid but semantically invalid curve is refused with the VALIDATOR’s teaching', () => {
    const unordered = { ...base, points: [...base.points].reverse() };
    const refused = coreSchemas.RateCurve.safeParse(unordered);
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.message).toMatch(/strictly ascending/);
  });

  it('a structurally invalid curve is refused by the SHAPE with the real enum named', () => {
    const refused = coreSchemas.RateCurve.safeParse({ ...base, dayCount: 'ACT/364' });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.issues.some((issue) => issue.code === ErrorCode.InputInvalidEnum)).toBe(true);
      expect(refused.error.message).toMatch(/ACT\/365F/);
    }
  });

  it('vendor decoration survives the round trip at curve AND pillar level', () => {
    const decorated = {
      ...base,
      vendor: 'refinitiv',
      points: [{ date: '2026-10-20', zeroRate: 0.045, vendorTag: 'sofr' }],
    };
    const parsed = coreSchemas.RateCurve.parse(decorated, { mode: 'strict' });
    expect(parsed).toEqual(decorated);
  });
});

describe('RateCurvePointSchema is open (Law 12 — the openness the interface documents)', () => {
  it('accepts and preserves a vendor-decorated pillar in strict mode', () => {
    const pillar = { date: '2026-10-20', zeroRate: 0.045, vendorTag: 'sofr' };
    expect(RateCurvePointSchema.parse(pillar, { mode: 'strict' })).toEqual(pillar);
  });

  it('still refuses an impossible pillar date and a non-numeric zeroRate', () => {
    expect(RateCurvePointSchema.safeParse({ date: '2025-02-30', zeroRate: 0.04 }).success).toBe(
      false,
    );
    const refused = RateCurvePointSchema.safeParse({ date: '2026-10-20', zeroRate: '4.5%' });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(isQuantError(refused.error, ErrorCode.InputWrongType)).toBe(true);
    }
  });

  it('declares its openness in JSON Schema', () => {
    expect(RateCurvePointSchema.toJSONSchema().additionalProperties).toBe(true);
  });
});
