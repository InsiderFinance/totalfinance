import { ErrorCode } from '../src/index.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import {
  type Infer,
  schema,
  validate,
  requireJSONSchema,
  JSON_SCHEMA_MAX_DEPTH,
} from '@totalfinance/core/schema';

const Contract = schema.object({
  underlying: schema.string().nonempty(),
  type: schema.enum(['call', 'put'] as const),
  style: schema.enum(['european', 'american', 'bermudan'] as const),
  strike: schema.number().positive(),
  expiry: schema.string().date(),
  multiplier: schema.number().positive().optional(),
});

type Contract = Infer<typeof Contract>;

describe('schema: parsing', () => {
  it('parses a valid object and infers a precise type', () => {
    const parsed = Contract.parse({
      underlying: 'AAPL',
      type: 'call',
      style: 'european',
      strike: 105,
      expiry: '2026-09-18',
    });
    expect(parsed.type).toBe('call');
    expect(parsed.strike).toBe(105);
    expect('multiplier' in parsed).toBe(false);

    expectTypeOf(parsed).toEqualTypeOf<{
      underlying: string;
      type: 'call' | 'put';
      style: 'european' | 'american' | 'bermudan';
      strike: number;
      expiry: string;
      multiplier?: number;
    }>();
  });

  it('rejects an invalid strike with an InputError carrying a stable code and path', () => {
    const r = Contract.safeParse({
      underlying: 'AAPL',
      type: 'call',
      style: 'european',
      strike: -5,
      expiry: '2026-09-18',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error).toBeInstanceOf(InputError);
      expect(r.issues[0]?.code).toBe('input.out_of_range');
      expect(r.issues[0]?.path).toEqual(['strike']);
    }
  });

  it('rejects a non-calendar date', () => {
    const r = Contract.safeParse({
      underlying: 'AAPL',
      type: 'call',
      style: 'european',
      strike: 105,
      expiry: '2026-02-30',
    });
    expect(r.success).toBe(false);
  });

  it('reports an invalid enum value', () => {
    expect(() =>
      Contract.parse({
        underlying: 'AAPL',
        type: 'straddle',
        style: 'european',
        strike: 105,
        expiry: '2026-09-18',
      }),
    ).toThrowError(/expected one of/);
  });

  it('WS2.9: a NaN number reports input.nan with a "received NaN" message, not "received number"', () => {
    const r = Contract.safeParse({
      underlying: 'AAPL',
      type: 'call',
      style: 'european',
      strike: Number.NaN,
      expiry: '2026-09-18',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.issues[0]?.code).toBe('input.nan');
      expect(r.issues[0]?.message).toMatch(/received NaN/);
      expect(r.issues[0]?.message).not.toMatch(/received number/);
    }
  });

  it('WS2.9: an invalid enum echoes the offending value alongside the allowed set', () => {
    const r = Contract.safeParse({
      underlying: 'AAPL',
      type: 'straddle',
      style: 'european',
      strike: 105,
      expiry: '2026-09-18',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.issues[0]?.code).toBe('input.invalid_enum');
      expect(r.issues[0]?.message).toMatch(/"straddle"/); // the offending value
      expect(r.issues[0]?.message).toMatch(/"call"/); // the allowed set
    }
  });
});

describe('schema: validation modes', () => {
  const base = {
    underlying: 'AAPL',
    type: 'call',
    style: 'european',
    expiry: '2026-09-18',
  };

  it('strict rejects unknown fields', () => {
    const r = Contract.safeParse({ ...base, strike: 105, surprise: true }, { mode: 'strict' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.issues[0]?.code).toBe('input.unknown_field');
  });

  it('coerce parses numeric strings and enum aliases', () => {
    const r = Contract.parse({ ...base, type: 'CALL', strike: '105' }, { mode: 'coerce' });
    expect(r.strike).toBe(105);
    expect(r.type).toBe('call');
  });

  it('passthrough preserves extra fields', () => {
    const r = Contract.parse({ ...base, strike: 105, note: 'keep me' }, { mode: 'passthrough' });
    expect((r as Record<string, unknown>)['note']).toBe('keep me');
  });

  it('off skips validation entirely', () => {
    const weird = { anything: 1 };
    const r = validate(Contract, weird, { mode: 'off' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(weird);
  });
});

describe('schema: JSON Schema export', () => {
  it('emits Draft 2020-12-style JSON Schema for MCP/docs', () => {
    const json = Contract.toJSONSchema();
    expect(json.type).toBe('object');
    expect(json.required).toEqual(['underlying', 'type', 'style', 'strike', 'expiry']);
    expect(json.additionalProperties).toBe(false);
    expect(json.properties?.['type']).toMatchObject({ type: 'string', enum: ['call', 'put'] });
    expect(json.properties?.['strike']).toMatchObject({ type: 'number', exclusiveMinimum: 0 });
    // optional field is present in properties but absent from `required`
    expect(json.properties?.['multiplier']).toBeDefined();
    expect(json.required).not.toContain('multiplier');
  });
});

describe('schema: Standard Schema compatibility', () => {
  it('exposes a ~standard prop that validates', () => {
    const std = Contract['~standard'];
    expect(std.version).toBe(1);
    expect(std.vendor).toBe('totalfinance');
    const ok = std.validate({
      underlying: 'AAPL',
      type: 'call',
      style: 'european',
      strike: 105,
      expiry: '2026-09-18',
    });
    expect(ok.issues).toBeUndefined();
    const bad = std.validate({ nope: true });
    expect(bad.issues).toBeDefined();
  });
});

describe('schema: builder is immutable (no shared-instance mutation)', () => {
  it('refiners return a new schema and do not mutate the base', () => {
    const base = schema.number();
    const positive = base.positive();
    const described = base.describe('a number');
    expect(positive).not.toBe(base);
    expect(described).not.toBe(base);
    // The base remains unconstrained and undescribed.
    expect(base.parse(-5)).toBe(-5);
    expect(base.toJSONSchema()).toEqual({ type: 'number' });
    // The refined copies carry only their own constraint/description.
    expect(() => positive.parse(-5)).toThrow();
    expect(described.toJSONSchema().description).toBe('a number');
    expect(described.toJSONSchema().exclusiveMinimum).toBeUndefined();
  });

  it('a shared base refined two ways does not cross-contaminate', () => {
    const price = schema.number();
    const bounded = price.min(0).max(100);
    const justPositive = price.positive();
    expect(() => bounded.parse(150)).toThrow();
    expect(justPositive.parse(150)).toBe(150); // not capped at 100
    expect(price.parse(150)).toBe(150); // base untouched
  });

  it('string and array refiners are immutable too', () => {
    const str = schema.string();
    const nonempty = str.nonempty();
    expect(str.parse('')).toBe(''); // base still accepts empty
    expect(() => nonempty.parse('')).toThrow();

    const arr = schema.array(schema.number());
    const bounded = arr.min(2);
    expect(arr.parse([])).toEqual([]); // base unbounded
    expect(() => bounded.parse([])).toThrow();
  });
});

describe('requireJSONSchema — the document guard', () => {
  it('accepts a well-formed document with vendor keywords and refuses typed defects at any depth', () => {
    expect(() =>
      requireJSONSchema('t', 'document', {
        type: ['object', 'null'],
        properties: { x: { type: 'number', 'x-vendor': 1 }, y: { anyOf: [{ type: 'string' }] } },
        additionalProperties: false,
        required: ['x'],
      }),
    ).not.toThrow();
    const code = (thunk: () => void): string | undefined => {
      try {
        thunk();
        return undefined;
      } catch (error) {
        return (error as { code?: string }).code;
      }
    };
    expect(code(() => requireJSONSchema('t', 'document', null))).toBe(ErrorCode.InputWrongType);
    expect(code(() => requireJSONSchema('t', 'document', { $id: null }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(code(() => requireJSONSchema('t', 'document', { type: 'nope' }))).toBe(
      ErrorCode.InputInvalidEnum,
    );
    expect(code(() => requireJSONSchema('t', 'document', { minimum: Number.NaN }))).toBe(
      ErrorCode.InputNotFinite,
    );
    expect(
      code(() =>
        requireJSONSchema('t', 'document', { properties: { a: { items: { allOf: 'x' } } } }),
      ),
    ).toBe(ErrorCode.InputWrongType);
    expect(code(() => requireJSONSchema('t', 'document', { const: null }))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(code(() => requireJSONSchema('t', 'document', { required: [1] }))).toBe(
      ErrorCode.InputWrongType,
    );
    let cyclic: Record<string, unknown> = { type: 'object' };
    for (let depth = 0; depth <= JSON_SCHEMA_MAX_DEPTH + 1; depth += 1) cyclic = { items: cyclic };
    expect(code(() => requireJSONSchema('t', 'document', cyclic))).toBe(ErrorCode.InputWrongShape);
  });
});
