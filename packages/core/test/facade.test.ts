import { describe, expect, it } from 'vitest';
import {
  type Computed,
  emptyDiagnostics,
  facade,
  PostconditionError,
  stableSum,
} from '@totalfinance/core';

/**
 * DX1.1 — `facade()` lives in core: a plain callable with an `.explain()` companion. The plain call
 * returns the bare value; `.explain()` returns the full `Computed` envelope. Since the first-touch
 * law moved into `facade()` itself, the first argument must be an input object of named fields —
 * garbage (scalars, null, undefined) is rejected centrally with a typed InputError before the
 * wrapped function ever runs.
 */

describe('facade()', () => {
  const square = facade(
    'square',
    (input: { x: number }) => input.x * input.x,
    (input: { x: number }): Computed<number> => ({
      value: input.x * input.x,
      assumptions: { conventionsVersion: 'test' } as never,
      diagnostics: emptyDiagnostics(),
    }),
  );

  it('the plain call returns the bare value', () => {
    expect(square({ x: 4 })).toBe(16);
  });

  it('.explain() returns the Computed envelope', () => {
    const r = square.explain({ x: 4 });
    expect(r.value).toBe(16);
    expect(r.diagnostics.warnings).toEqual([]);
    expect(r.assumptions).toBeDefined();
  });

  it('the first-touch law is central: scalar/null garbage gets a typed InputError from both entrypoints', () => {
    expect(() => square(4 as never)).toThrowError(
      /^square: expected an input object of named fields as the first argument, got number\./,
    );
    expect(() => square.explain(null as never)).toThrowError(
      /^square\.explain: expected an input object of named fields/,
    );
  });

  it('guard messages open with the label the user typed — never an internal helper name', () => {
    try {
      square(undefined as never);
      expect.unreachable('should have thrown');
    } catch (err) {
      const e = err as { message: string; code?: string };
      expect(e.message.startsWith('square:')).toBe(true);
      expect(e.message).not.toContain('facade');
      expect(e.code).toBe('input.wrong_type');
    }
  });

  it('S1 facades reject arrays: the input is an object of named fields, not a series', () => {
    expect(() => square([1, 2, 3] as never)).toThrowError(
      /^square: expected an input object of named fields as the first argument, got an array\./,
    );
  });

  it('the facade is the callable itself with .explain bolted on', () => {
    expect(typeof square).toBe('function');
    expect(typeof square.explain).toBe('function');
  });

  it('rejects non-finite values on both successful paths', () => {
    const broken = facade(
      'broken',
      (_input: { x: number }) => Number.NaN,
      (_input: { x: number }): Computed<number> => ({
        value: Infinity,
        assumptions: { conventionsVersion: 'test' } as never,
        diagnostics: emptyDiagnostics(),
      }),
    );
    expect(() => broken({ x: 1 })).toThrow(PostconditionError);
    expect(() => broken.explain({ x: 1 })).toThrow(PostconditionError);
  });
});

describe('stableSum()', () => {
  it('preserves a low-order residual through finite cancellation', () => {
    expect(stableSum([1e16, 1, -1e16])).toBe(1);
  });

  it('returns the same representable residual through every overflow/cancellation permutation', () => {
    const values = [1e308, 1e308, 1, -1e308, -1e308];
    const permutations = (remaining: number[], prefix: number[] = []): number[][] =>
      remaining.length === 0
        ? [prefix]
        : remaining.flatMap((value, index) =>
            permutations(
              [...remaining.slice(0, index), ...remaining.slice(index + 1)],
              [...prefix, value],
            ),
          );
    for (const permutation of permutations(values)) expect(stableSum(permutation)).toBe(1);
  });

  it('returns a non-finite only when the finite addends truly exceed the double range', () => {
    expect(stableSum([Number.MAX_VALUE, Number.MAX_VALUE])).toBe(Infinity);
    expect(stableSum([-Number.MAX_VALUE, -Number.MAX_VALUE])).toBe(-Infinity);
  });

  it('retains IEEE-754 propagation for explicitly non-finite addends', () => {
    expect(stableSum([1, Infinity])).toBe(Infinity);
    expect(stableSum([Infinity, -Infinity])).toBeNaN();
  });
});
