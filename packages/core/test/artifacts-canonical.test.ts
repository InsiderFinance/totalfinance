/**
 * Gate B acceptance laws for the canonical serializer and content hash:
 *
 * - hash round-trip stability: same logical value, any key order → identical canonical bytes and
 *   identical hash; serialize→parse→serialize is the identity on canonical text;
 * - non-finite round-trip: NaN/±Infinity survive the JSON boundary through the library's
 *   `{ nonFinite }` wrapper (exactly the TA snapshot encoding);
 * - sensitivity: any covered field change changes the hash;
 * - golden vectors: SHA-256 against FIPS 180-4 test vectors and independently computed
 *   (Python hashlib) canonical-object digests, so the implementation is pinned to the standard,
 *   not to itself.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  CANONICAL_JSON_VERSION,
  CONTENT_HASH_PREFIX,
  canonicalJsonOf,
  contentHash,
  fromCanonicalJson,
  isContentHashString,
  isNonFiniteNumber,
  sha256Hex,
} from '@totalfinance/core/artifacts';

describe('canonicalJsonOf', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJsonOf({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJsonOf({ z: { d: 1, c: [{ b: 2, a: 3 }] }, a: 0 })).toBe(
      '{"a":0,"z":{"c":[{"a":3,"b":2}],"d":1}}',
    );
  });

  it('is key-order independent: two builds of the same logical value serialize identically', () => {
    const one = { spot: 195.3, riskFreeRate: 0.045, asOf: 1784505600000, nested: { x: 1, y: 2 } };
    const other = { nested: { y: 2, x: 1 }, asOf: 1784505600000, riskFreeRate: 0.045, spot: 195.3 };
    expect(canonicalJsonOf(one)).toBe(canonicalJsonOf(other));
    expect(contentHash(one)).toBe(contentHash(other));
  });

  it('folds -0 to 0 (JSON cannot carry the sign bit) and keeps shortest round-trip numbers', () => {
    expect(canonicalJsonOf(-0)).toBe('0');
    expect(canonicalJsonOf({ a: -0 })).toBe('{"a":0}');
    expect(canonicalJsonOf(0.1)).toBe('0.1');
    expect(canonicalJsonOf(1e21)).toBe('1e+21');
    expect(contentHash({ a: -0 })).toBe(contentHash({ a: 0 }));
  });

  it('encodes non-finite numbers with the library-wide wrapper', () => {
    expect(canonicalJsonOf(Number.NaN)).toBe('{"nonFinite":"NaN"}');
    expect(canonicalJsonOf(Number.POSITIVE_INFINITY)).toBe('{"nonFinite":"Infinity"}');
    expect(canonicalJsonOf(Number.NEGATIVE_INFINITY)).toBe('{"nonFinite":"-Infinity"}');
  });

  it('omits undefined object members (matching JSON.stringify) but REFUSES undefined in arrays', () => {
    expect(canonicalJsonOf({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJsonOf({ a: [1, undefined, 3] })).toThrowError(
      /a\[1\].*undefined inside an array/,
    );
  });

  it('round-trips: fromCanonicalJson(canonicalJsonOf(x)) restores x, non-finite included', () => {
    const value = {
      warmup: [Number.NaN, Number.NaN, 3.25],
      bound: Number.POSITIVE_INFINITY,
      floor: Number.NEGATIVE_INFINITY,
      label: 'π ≥ 0 — ¥€é',
      flag: true,
      empty: null,
    };
    const restored = fromCanonicalJson(canonicalJsonOf(value)) as typeof value;
    expect(Number.isNaN(restored.warmup[0])).toBe(true);
    expect(Number.isNaN(restored.warmup[1])).toBe(true);
    expect(restored.warmup[2]).toBe(3.25);
    expect(restored.bound).toBe(Number.POSITIVE_INFINITY);
    expect(restored.floor).toBe(Number.NEGATIVE_INFINITY);
    expect(restored.label).toBe('π ≥ 0 — ¥€é');
    expect(restored.flag).toBe(true);
    expect(restored.empty).toBeNull();
  });

  it('round-trips every valid JSON key without prototype mutation', () => {
    const value = JSON.parse(
      '{"__proto__":{"USD":7},"constructor":"instrument","nested":{"__proto__":1}}',
    ) as Record<string, unknown>;
    const restored = fromCanonicalJson(canonicalJsonOf(value)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
    expect(Object.hasOwn(restored, '__proto__')).toBe(true);
    expect(restored['__proto__']).toEqual({ USD: 7 });
    expect(restored['constructor']).toBe('instrument');
    expect(Object.hasOwn(restored['nested'] as object, '__proto__')).toBe(true);
    expect((restored['nested'] as Record<string, unknown>)['__proto__']).toBe(1);
    expect(Object.prototype).not.toHaveProperty('USD');
  });

  it('recognizes only an exact stored-data non-finite wrapper without invoking accessors', () => {
    let getterCalled = false;
    const accessor = Object.defineProperty({}, 'nonFinite', {
      enumerable: true,
      get(): never {
        getterCalled = true;
        throw new Error('must not execute');
      },
    });
    const symbol = Symbol('metadata');
    const withSymbol = { nonFinite: 'NaN', [symbol]: true };
    const inherited = Object.create({ nonFinite: 'NaN' }) as object;

    expect(isNonFiniteNumber(accessor)).toBe(false);
    expect(getterCalled).toBe(false);
    expect(isNonFiniteNumber(withSymbol)).toBe(false);
    expect(isNonFiniteNumber(inherited)).toBe(false);
    expect(isNonFiniteNumber({ nonFinite: 'Infinity' })).toBe(true);
  });

  it('refuses sparse, accessor-backed, hidden, symbol, and custom-prototype data', () => {
    let getterCalled = false;
    const accessor = Object.defineProperty({}, 'amount', {
      enumerable: true,
      get(): never {
        getterCalled = true;
        throw new Error('must not execute');
      },
    });
    expect(() => canonicalJsonOf(accessor)).toThrowError(/accessor/);
    expect(getterCalled).toBe(false);

    const sparse = new Array<unknown>(1);
    expect(() => canonicalJsonOf(sparse)).toThrowError(/dense stored data/);
    const hidden = Object.defineProperty({}, 'amount', { enumerable: false, value: 1 });
    expect(() => canonicalJsonOf(hidden)).toThrowError(/hidden member/);
    expect(() => canonicalJsonOf({ [Symbol('metadata')]: true })).toThrowError(/symbol key/);
    expect(() => canonicalJsonOf(Object.create({ amount: 1 }) as object)).toThrowError(
      /custom-prototype object/,
    );
  });

  it('is idempotent on canonical text: serialize(parse(text)) === text', () => {
    const text = canonicalJsonOf({ b: [1, { d: Number.NaN, c: 'x' }], a: 0.5 });
    expect(canonicalJsonOf(fromCanonicalJson(text))).toBe(text);
  });

  it('refuses a Date with the EpochMs teaching', () => {
    expect(() => canonicalJsonOf({ asOf: new Date(0) })).toThrowError(/epoch milliseconds/);
  });

  it('refuses Map, Set, typed arrays, functions, symbols, and bigint with the path named', () => {
    expect(() => canonicalJsonOf({ m: new Map() })).toThrowError(/m is an instance of Map/);
    expect(() => canonicalJsonOf({ s: new Set() })).toThrowError(/s is an instance of Set/);
    expect(() => canonicalJsonOf({ closes: new Float64Array(3) })).toThrowError(/Arrow.*reserved/);
    expect(() => canonicalJsonOf({ f: () => 1 })).toThrowError(/f is a function/);
    expect(() => canonicalJsonOf({ big: 1n })).toThrowError(/big is a bigint/);
    class Position {
      quantity = 1;
    }
    expect(() => canonicalJsonOf({ p: new Position() })).toThrowError(/instance of Position/);
  });

  it('refuses caller data wearing the reserved non-finite wrapper shape', () => {
    expect(() => canonicalJsonOf({ x: { nonFinite: 'NaN' } })).toThrowError(/RESERVED encoding/);
    // A sibling key breaks the exact wrapper shape, so it is ordinary data again.
    expect(canonicalJsonOf({ x: { nonFinite: 'NaN', note: 'just a field' } })).toBe(
      '{"x":{"nonFinite":"NaN","note":"just a field"}}',
    );
  });

  it('escapes strings per well-formed JSON.stringify (lone surrogates included)', () => {
    expect(canonicalJsonOf('\ud800')).toBe('"\\ud800"');
    expect(canonicalJsonOf('a b')).toBe(JSON.stringify('a b'));
  });

  it('names its rules version', () => {
    expect(CANONICAL_JSON_VERSION).toBe(1);
  });
});

describe('fromCanonicalJson — owned parsed-tree decoding', () => {
  it('retains typed refusals for non-string inputs and invalid JSON', () => {
    expect.assertions(6);
    for (const [input, expectedCode] of [
      [null, ErrorCode.InputWrongType],
      [42, ErrorCode.InputWrongType],
      ['{"broken":', ErrorCode.SerializationUnsupportedValue],
    ] as const) {
      try {
        fromCanonicalJson(input as string);
      } catch (error) {
        expect(isQuantError(error)).toBe(true);
        expect(isQuantError(error) ? error.code : undefined).toBe(expectedCode);
      }
    }
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('decodes %s at the root and inside arrays and objects', (tag, expected) => {
    const wrapper = JSON.stringify({ nonFinite: tag });
    expect(fromCanonicalJson(wrapper)).toBe(expected);
    expect(fromCanonicalJson(`[{"value":${wrapper}},[${wrapper}]]`)).toEqual([
      { value: expected },
      [expected],
    ]);
  });

  it('preserves near-wrappers, noncanonical key spelling, and duplicate-key JSON semantics', () => {
    expect(
      fromCanonicalJson(
        '[{"nonFinite":"NaN","note":null},{"nonFinite":"nan"},{"nonFinite":0},{"nonFinite":null}]',
      ),
    ).toEqual([
      { nonFinite: 'NaN', note: null },
      { nonFinite: 'nan' },
      { nonFinite: 0 },
      { nonFinite: null },
    ]);
    expect(fromCanonicalJson('{"\\u006eonFinite":"NaN"}')).toBeNaN();
    expect(fromCanonicalJson('{"nonFinite":"invalid","nonFinite":"Infinity"}')).toBe(Infinity);
    expect(fromCanonicalJson('{"nonFinite":"NaN","nonFinite":"invalid"}')).toEqual({
      nonFinite: 'invalid',
    });
  });

  it('keeps dangerous keys as own data properties even when their values decode', () => {
    const decoded = fromCanonicalJson(
      '{"__proto__":{"nonFinite":"NaN"},"nested":[{"__proto__":{"polluted":true},"constructor":{"prototype":{"nonFinite":"Infinity"}}}]}',
    ) as { nested: Record<string, unknown>[] } & Record<string, unknown>;
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')).toEqual({
      value: Number.NaN,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const nested = decoded.nested[0]!;
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(Object.hasOwn(nested, '__proto__')).toBe(true);
    expect(nested['__proto__']).toEqual({ polluted: true });
    expect(nested['constructor']).toEqual({ prototype: Infinity });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('returns independent writable trees across calls and equal sibling values', () => {
    const text = '{"rows":[{"value":{"nonFinite":"NaN"}},{"value":{"nonFinite":"NaN"}}]}';
    const first = fromCanonicalJson(text) as { rows: { value: number }[] };
    const second = fromCanonicalJson(text) as typeof first;
    first.rows[0]!.value = 123;
    first.rows.push({ value: 456 });
    expect(first.rows[1]!.value).toBeNaN();
    expect(second.rows).toHaveLength(2);
    expect(second.rows[0]!.value).toBeNaN();
    expect(second.rows[1]!.value).toBeNaN();
    expect(first.rows[0]).not.toBe(first.rows[1]);
    expect(first.rows).not.toBe(second.rows);
  });

  it('preserves plain scalars, empty containers, key order, and negative zero from arbitrary JSON', () => {
    for (const text of ['null', 'true', 'false', '0', '1.25', '"text"', '[]', '{}']) {
      expect(fromCanonicalJson(text)).toEqual(JSON.parse(text));
    }
    expect(Object.is(fromCanonicalJson('-0'), -0)).toBe(true);
    expect(Object.keys(fromCanonicalJson('{"z":0,"a":1}') as object)).toEqual(['z', 'a']);
  });

  it('matches an independent JSON reviver over seeded generated trees', () => {
    const wrapper = fc.record({ nonFinite: fc.constantFrom('NaN', 'Infinity', '-Infinity') });
    const trees = fc.array(fc.oneof(fc.jsonValue(), wrapper), { maxLength: 20 });
    fc.assert(
      fc.property(trees, (rows) => {
        const text = JSON.stringify({ rows, nested: { value: rows } });
        const expected: unknown = JSON.parse(text, (_key, value: unknown): unknown => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
          const entries = Object.entries(value);
          if (entries.length !== 1 || entries[0]![0] !== 'nonFinite') return value;
          switch (entries[0]![1]) {
            case 'NaN':
              return Number.NaN;
            case 'Infinity':
              return Infinity;
            case '-Infinity':
              return -Infinity;
            default:
              return value;
          }
        });
        expect(fromCanonicalJson(text)).toEqual(expected);
      }),
      { seed: 20261006, numRuns: 300 },
    );
  });
});

describe('sha256Hex golden vectors', () => {
  it('matches FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches the one-million-a vector (multi-block, length padding)', () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });

  it('hashes UTF-8 bytes, not UTF-16 code units (Python hashlib golden)', () => {
    expect(sha256Hex('volatility π ≥ 0 — ¥€é')).toBe(
      '789018f264c6c78a124dfe38d11a59b9d8b8ed5f784ad26d9dc5cff2314b21e0',
    );
  });
});

describe('contentHash', () => {
  it('prefixes the algorithm and matches an independently computed digest', () => {
    // Python: hashlib.sha256('{"a":2,"b":1}'.encode()).hexdigest()
    expect(contentHash({ b: 1, a: 2 })).toBe(
      `${CONTENT_HASH_PREFIX}d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772`,
    );
    // Python: hashlib.sha256('{"a":{"nonFinite":"NaN"}}'.encode()).hexdigest()
    expect(contentHash({ a: Number.NaN })).toBe(
      `${CONTENT_HASH_PREFIX}2cb4b66eed294d038b18d67ff280a7140a82c6deac8cac6f5fac6befe12ecc46`,
    );
  });

  it('changes when ANY covered field changes', () => {
    const base = {
      spot: 195.3,
      riskFreeRate: 0.045,
      nested: { volatility: 0.24, dividendYield: 0.005 },
      tags: ['a', 'b'],
    };
    const baseHash = contentHash(base);
    const variants: unknown[] = [
      { ...base, spot: 195.30000000001 },
      { ...base, riskFreeRate: 0.0451 },
      { ...base, nested: { ...base.nested, volatility: 0.25 } },
      { ...base, nested: { ...base.nested, dividendYield: 0 } },
      { ...base, tags: ['a', 'c'] },
      { ...base, tags: ['b', 'a'] }, // array ORDER is covered — arrays are sequences, not sets
      { ...base, extra: null },
    ];
    for (const variant of variants) {
      expect(contentHash(variant)).not.toBe(baseHash);
    }
    // …and does NOT change for a pure key-order shuffle.
    expect(
      contentHash({
        tags: ['a', 'b'],
        nested: { dividendYield: 0.005, volatility: 0.24 },
        riskFreeRate: 0.045,
        spot: 195.3,
      }),
    ).toBe(baseHash);
  });

  it('isContentHashString accepts exactly the spine grammar', () => {
    expect(isContentHashString(contentHash({ a: 1 }))).toBe(true);
    expect(isContentHashString('sha256:abc')).toBe(false);
    expect(isContentHashString(`md5:${'0'.repeat(64)}`)).toBe(false);
    expect(isContentHashString(`sha256:${'G'.repeat(64)}`)).toBe(false);
    expect(isContentHashString(42)).toBe(false);
  });
});
