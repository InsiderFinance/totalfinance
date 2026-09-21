/**
 * Stage 4.5 Decision 9 — the promoted bounded stored-data scanner:
 *
 * - the cost law is exact and deterministic (the Stage 4.4b Barrier A formula);
 * - hostile shapes are refused WITHOUT invoking them (accessors, coercion hooks, class instances,
 *   Array subclasses, sparse arrays, symbols, functions, bigints, enumerable undefined, cycles,
 *   nesting past the depth limit);
 * - the work budget is a STOP-AT-LIMIT refusal (the scan throws before finishing an oversized value);
 * - the options object is a closed, typed request.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  CANONICAL_DATA_MAX_DEPTH,
  canonicalStringWorkUnits,
  scanCanonicalData,
} from '@totalfinance/core/artifacts';

const options = { functionName: 'scanTest', label: 'value' } as const;

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

describe('scanCanonicalData — the cost law', () => {
  it('prices primitives, strings, arrays, and objects by the Barrier A formula', () => {
    expect(scanCanonicalData(null, options)).toBe(1);
    expect(scanCanonicalData(true, options)).toBe(1);
    expect(scanCanonicalData(1.5, options)).toBe(1);
    expect(scanCanonicalData('x', options)).toBe(2);
    expect(canonicalStringWorkUnits('a'.repeat(64))).toBe(2);
    expect(canonicalStringWorkUnits('a'.repeat(65))).toBe(3);
    // [1, 'x'] = 1 + 2 elements + (1 + 2)
    expect(scanCanonicalData([1, 'x'], options)).toBe(6);
    // { a: 1 } = 1 + 1·ceil(log2 2) + key 'a' (2) + member (1)
    expect(scanCanonicalData({ a: 1 }, options)).toBe(5);
    expect(scanCanonicalData({}, options)).toBe(1);
    expect(scanCanonicalData([], options)).toBe(1);
  });

  it('is deterministic across key order', () => {
    expect(scanCanonicalData({ b: [1, 2], a: 'x' }, options)).toBe(
      scanCanonicalData({ a: 'x', b: [1, 2] }, options),
    );
  });

  it('exposes the default depth limit as a public fact', () => {
    expect(CANONICAL_DATA_MAX_DEPTH).toBe(64);
  });
});

describe('scanCanonicalData — refusals without invocation', () => {
  it('refuses an accessor without reading it', () => {
    let read = 0;
    const hostile = {};
    Object.defineProperty(hostile, 'price', {
      enumerable: true,
      get: () => {
        read += 1;
        return 1;
      },
    });
    expect(() => scanCanonicalData(hostile, options)).toThrow(/accessors/);
    expect(read).toBe(0);
  });

  it('refuses class instances, Array subclasses, sparse arrays, and non-index members', () => {
    class Point {
      x = 1;
    }
    expect(() => scanCanonicalData(new Point(), options)).toThrow(/custom prototype/);
    class Rows extends Array {}
    expect(() => scanCanonicalData(new Rows(), options)).toThrow(/Array subclass/);
    const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
    expect(() => scanCanonicalData(sparse, options)).toThrow(/hole or accessor/);
    const decorated = [1, 2] as number[] & { note?: string };
    decorated.note = 'x';
    expect(() => scanCanonicalData(decorated, options)).toThrow(/non-index array member/);
  });

  it('refuses functions, symbols, bigints, and enumerable undefined with the path', () => {
    expect(() => scanCanonicalData({ f: () => 1 }, options)).toThrow(/value\.f is a function/);
    expect(() => scanCanonicalData({ s: Symbol('s') }, options)).toThrow(/is a symbol/);
    expect(() => scanCanonicalData({ b: 1n }, options)).toThrow(/is a bigint/);
    expect(() => scanCanonicalData({ u: undefined }, options)).toThrow(/enumerable undefined/);
    expect(() => scanCanonicalData({ [Symbol('k')]: 1 }, options)).toThrow(/symbol member/);
  });

  it('ignores exactly the symbol keys the caller owns', () => {
    const owned = Symbol('binding');
    const value = { a: 1, [owned]: () => 'behavior' };
    expect(() => scanCanonicalData(value, options)).toThrow(/symbol member/);
    expect(scanCanonicalData(value, { ...options, ignoredSymbols: new Set([owned]) })).toBe(5);
  });

  it('refuses cycles and nesting past the depth limit', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => scanCanonicalData(cyclic, options)).toThrow(/cycle/);
    let deep: unknown = 1;
    for (let i = 0; i < 66; i++) deep = [deep];
    expect(codeOf(() => scanCanonicalData(deep, options))).toBe(ErrorCode.InputOutOfRange);
    expect(() => scanCanonicalData(deep, options)).toThrow(/nested deeper than 64/);
    expect(scanCanonicalData(deep, { ...options, maximumDepth: 70 })).toBeGreaterThan(66);
  });

  it('refuses non-finite numbers only when asked, naming NaN and Infinity apart', () => {
    expect(scanCanonicalData([Number.NaN, Number.POSITIVE_INFINITY], options)).toBe(5);
    const finite = { ...options, requireFiniteNumbers: true } as const;
    expect(codeOf(() => scanCanonicalData({ v: Number.NaN }, finite))).toBe(ErrorCode.InputNaN);
    expect(codeOf(() => scanCanonicalData({ v: -Infinity }, finite))).toBe(
      ErrorCode.InputNotFinite,
    );
  });
});

describe('scanCanonicalData — the stop-at-limit budget', () => {
  it('throws before finishing an oversized value', () => {
    const big = { rows: Array.from({ length: 10_000 }, (_, i) => ({ i, v: i / 7 })) };
    expect(codeOf(() => scanCanonicalData(big, { ...options, maximumWorkUnits: 500 }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(() => scanCanonicalData(big, { ...options, maximumWorkUnits: 500 })).toThrow(
      /data-work limit of 500/,
    );
    const full = scanCanonicalData(big, options);
    expect(scanCanonicalData(big, { ...options, maximumWorkUnits: full })).toBe(full);
    expect(() => scanCanonicalData(big, { ...options, maximumWorkUnits: full - 1 })).toThrow(
      /data-work limit/,
    );
  });
});

describe('scanCanonicalData — the options request is closed and typed', () => {
  it('refuses unknown keys, missing names, and malformed limits', () => {
    expect(codeOf(() => scanCanonicalData(1, { ...options, bogus: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(codeOf(() => scanCanonicalData(1, { label: 'v' } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => scanCanonicalData(1, { functionName: 'f' } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => scanCanonicalData(1, { ...options, maximumWorkUnits: -1 }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    // A zero budget is admissible and refuses at the first unit with the limit teaching.
    expect(() => scanCanonicalData(1, { ...options, maximumWorkUnits: 0 })).toThrow(
      /data-work limit of 0/,
    );
    expect(codeOf(() => scanCanonicalData(1, { ...options, maximumDepth: 0 }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => scanCanonicalData(1, { ...options, maximumDepth: 2.5 }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => scanCanonicalData(1, { ...options, maximumWorkUnits: 2 ** 53 }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => scanCanonicalData(1, { ...options, ignoredSymbols: [] } as never))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      codeOf(() => scanCanonicalData(1, { ...options, requireFiniteNumbers: 1 } as never)),
    ).toBe(ErrorCode.InputWrongType);
    expect(codeOf(() => scanCanonicalData(1, null as never))).toBe(ErrorCode.InputWrongType);
  });
});
