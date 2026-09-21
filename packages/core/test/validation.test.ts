/**
 * The reusable closed-request validator, proven at its DEFINITION (spec 3B.1b, first checkbox).
 *
 * A property demonstrated only through consumers changes silently when a consumer is rewritten —
 * the same reason the numeric-field taxonomy is proven in this package. Every code asserted here
 * is exact (C11): the four numeric mistakes, the enum domain, the null ruling, closed keys with a
 * did-you-mean, and the union rules — discriminant-first selection, structural fallback, and the
 * no-branch-matched teaching error.
 */

import { describe, expect, it } from 'vitest';
import {
  type ClosedRequestSpecification,
  ErrorCode,
  isQuantError,
  validateClosedRequest,
} from '@totalfinance/core';

const TEACHING = { exampleCall: "price({ spot: 100, strike: 105, type: 'call' })" } as const;

function codeOf(run: () => void): string {
  try {
    run();
    return 'NO THROW';
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

const FLAT: ClosedRequestSpecification = {
  contract: 'test:Flat',
  fields: [
    { name: 'spot', kind: 'numeric' },
    { name: 'type', kind: 'enum', literals: ['call', 'put'] },
    { name: 'greeks', kind: 'boolean', optional: true },
    { name: 'label', kind: 'string', optional: true },
    { name: 'weights', kind: 'array', optional: true },
    { name: 'payoff', kind: 'callback', optional: true },
    { name: 'cap', kind: 'numeric', optional: true, nullable: true },
  ],
};

const VALID = { spot: 100, type: 'call' };

describe('flat closed requests', () => {
  it('the control passes, with every optional engaged', () => {
    expect(
      codeOf(() =>
        validateClosedRequest(
          'price',
          { ...VALID, greeks: true, label: 'x', weights: [1], payoff: () => 0, cap: null },
          FLAT,
          TEACHING,
        ),
      ),
    ).toBe('NO THROW');
  });

  it('a non-object request teaches wrong_type under the argument name', () => {
    expect(codeOf(() => validateClosedRequest('price', 42, FLAT, TEACHING))).toBe(
      ErrorCode.InputWrongType,
    );
    expect(codeOf(() => validateClosedRequest('price', null, FLAT, TEACHING))).toBe(
      ErrorCode.InputWrongType,
    );
  });

  it('an unknown key rejects with a did-you-mean and the allowed list', () => {
    try {
      validateClosedRequest('price', { ...VALID, spott: 1 }, FLAT, TEACHING);
      expect.unreachable('accepted an unknown key');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputUnknownField)) throw error;
      expect(error.message).toContain('price: unknown field "spott" in input');
      expect(error.message).toContain('did you mean "spot"');
      expect(error.message).toContain('Allowed fields: spot, type,');
    }
  });

  it('a missing required field teaches with the worked example', () => {
    try {
      validateClosedRequest('price', { type: 'call' }, FLAT, TEACHING);
      expect.unreachable('accepted a missing required field');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputMissingField)) throw error;
      expect(error.message).toContain('spot');
      expect(error.message).toContain(TEACHING.exampleCall);
    }
  });

  it('top-level fields keep BARE names for the subject request', () => {
    try {
      validateClosedRequest('price', { ...VALID, spot: 'abc' }, FLAT, TEACHING);
      expect.unreachable('accepted a string spot');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputWrongType)) throw error;
      expect(error.message).toContain('price: spot must be a number');
      expect(error.message).not.toContain('input.spot');
    }
  });

  it('a secondary argument prefixes its fields', () => {
    try {
      validateClosedRequest('price', { spot: 'abc', type: 'call' }, FLAT, {
        ...TEACHING,
        argumentName: 'options',
      });
      expect.unreachable('accepted a string spot');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputWrongType)) throw error;
      expect(error.message).toContain('options.spot must be a number');
    }
  });

  it('runs the numeric ladder with the exact code per mistake', () => {
    const withSpot =
      (spot: unknown): (() => void) =>
      () =>
        validateClosedRequest('price', { ...VALID, spot }, FLAT, TEACHING);
    expect(codeOf(withSpot('100'))).toBe(ErrorCode.InputWrongType);
    expect(codeOf(withSpot(Number.NaN))).toBe(ErrorCode.InputNaN);
    expect(codeOf(withSpot(Number.POSITIVE_INFINITY))).toBe(ErrorCode.InputNotFinite);
  });

  it('a curated bound field accepts ±Infinity but never NaN', () => {
    // The `localCap: Infinity` class: ±∞ is the documented "unbounded" on curated bound fields
    // (C03 — curation, never inference); NaN means nothing anywhere.
    const BOUNDED: ClosedRequestSpecification = {
      contract: 'test:Bounded',
      fields: [{ name: 'cap', kind: 'numeric', optional: true, allowsInfinity: true }],
    };
    const withCap = (cap: unknown): string =>
      codeOf(() => validateClosedRequest('note', { cap }, BOUNDED, TEACHING));
    expect(withCap(Number.POSITIVE_INFINITY)).toBe('NO THROW');
    expect(withCap(Number.NEGATIVE_INFINITY)).toBe('NO THROW');
    expect(withCap(5)).toBe('NO THROW');
    expect(withCap(Number.NaN)).toBe(ErrorCode.InputNaN);
    expect(withCap('5')).toBe(ErrorCode.InputWrongType);
  });

  it('enum domains reject outside members and non-strings', () => {
    const withType =
      (type: unknown): (() => void) =>
      () =>
        validateClosedRequest('price', { ...VALID, type }, FLAT, TEACHING);
    expect(codeOf(withType('Call'))).toBe(ErrorCode.InputInvalidEnum);
    expect(codeOf(withType(1))).toBe(ErrorCode.InputInvalidEnum);
  });

  it('wrong-type teaching and serialized error context never execute caller coercion hooks', () => {
    let calls = 0;
    const hostile = {
      toJSON(): never {
        calls += 1;
        throw new Error('toJSON must not execute');
      },
      toString(): never {
        calls += 1;
        throw new Error('toString must not execute');
      },
      [Symbol.toPrimitive](): never {
        calls += 1;
        throw new Error('Symbol.toPrimitive must not execute');
      },
    };

    for (const patch of [{ spot: hostile }, { type: hostile }]) {
      try {
        validateClosedRequest('price', { ...VALID, ...patch }, FLAT, TEACHING);
        expect.unreachable('accepted a hostile wrong-typed value');
      } catch (error) {
        if (!isQuantError(error)) throw error;
        expect([ErrorCode.InputWrongType, ErrorCode.InputInvalidEnum]).toContain(error.code);
        expect(() => JSON.stringify(error)).not.toThrow();
      }
    }

    expect(calls).toBe(0);
  });

  it('checks boolean, string, array, and callback kinds', () => {
    const mutate = (patch: Record<string, unknown>): string =>
      codeOf(() => validateClosedRequest('price', { ...VALID, ...patch }, FLAT, TEACHING));
    expect(mutate({ greeks: 'yes' })).toBe(ErrorCode.InputWrongType);
    expect(mutate({ label: 7 })).toBe(ErrorCode.InputWrongType);
    expect(mutate({ weights: 'heavy' })).toBe(ErrorCode.InputWrongType);
    expect(mutate({ payoff: 'later' })).toBe(ErrorCode.InputWrongType);
  });
});

describe('generated resource-count constraints', () => {
  const RESOURCE: ClosedRequestSpecification = {
    contract: 'test:Resource',
    fields: [
      { name: 'period', kind: 'numeric', safeIntegerMaximum: 1_000_000 },
      {
        name: 'periods',
        kind: 'array',
        safeIntegerElementsMaximum: 1_000_000,
      },
    ],
  };
  const run = (period: unknown, periods: unknown): string =>
    codeOf(() =>
      validateClosedRequest('Stream', { period, periods }, RESOURCE, {
        exampleCall: 'new Stream({ period: 20, periods: [10, 20, 50] })',
      }),
    );

  it('accepts realistic scalar and array resource counts', () => {
    expect(run(20, [10, 20, 50])).toBe('NO THROW');
  });

  it('rejects non-safe, fractional, non-positive, and over-cap counts with typed codes', () => {
    for (const bad of [0, -1, 2.5, 1_000_001, 2 ** 53, 1e308]) {
      expect(run(bad, [10]), `period = ${bad}`).toBe(ErrorCode.InputOutOfRange);
      expect(run(20, [bad]), `periods[0] = ${bad}`).toBe(ErrorCode.InputOutOfRange);
    }
    expect(run('20', [10])).toBe(ErrorCode.InputWrongType);
    expect(run(20, ['10'])).toBe(ErrorCode.InputWrongType);
    expect(run(Number.NaN, [10])).toBe(ErrorCode.InputNaN);
    expect(run(20, [Number.POSITIVE_INFINITY])).toBe(ErrorCode.InputNotFinite);
  });
});

describe('null is not omission', () => {
  const mutate = (patch: Record<string, unknown>): string =>
    codeOf(() => validateClosedRequest('price', { ...VALID, ...patch }, FLAT, TEACHING));

  it('null on a non-nullable numeric field is wrong_type — required and optional alike', () => {
    expect(mutate({ spot: null })).toBe(ErrorCode.InputWrongType);
    expect(mutate({ greeks: null })).toBe(ErrorCode.InputWrongType);
  });

  it('null on an enum field is invalid_enum — null is not a member', () => {
    expect(mutate({ type: null })).toBe(ErrorCode.InputInvalidEnum);
  });

  it('null passes ONLY where the declaration spells it', () => {
    expect(mutate({ cap: null })).toBe('NO THROW');
  });

  it('undefined stays omission for optionals and missing for required', () => {
    expect(mutate({ greeks: undefined })).toBe('NO THROW');
    expect(mutate({ spot: undefined })).toBe(ErrorCode.InputMissingField);
  });
});

describe('nested objects', () => {
  const NESTED: ClosedRequestSpecification = {
    contract: 'test:Nested',
    fields: [
      {
        name: 'parameters',
        kind: 'object',
        fields: [
          { name: 'kappa', kind: 'numeric' },
          { name: 'theta', kind: 'numeric', optional: true },
        ],
      },
    ],
  };

  it('recurses with dotted paths and closed keys at every level', () => {
    try {
      validateClosedRequest('calibrate', { parameters: { kappa: 1, thetaa: 2 } }, NESTED, TEACHING);
      expect.unreachable('accepted a nested unknown key');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputUnknownField)) throw error;
      expect(error.message).toContain('unknown field "thetaa" in parameters');
      expect(error.message).toContain('did you mean "theta"');
    }
    expect(
      codeOf(() =>
        validateClosedRequest('calibrate', { parameters: { kappa: Number.NaN } }, NESTED, TEACHING),
      ),
    ).toBe(ErrorCode.InputNaN);
  });
});

describe('discriminated unions', () => {
  it('a PURE discriminated union refuses a missing discriminant on the discriminant itself', () => {
    const PURE: ClosedRequestSpecification = {
      contract: 'test:Pure',
      fields: [{ name: 'kind', kind: 'enum', literals: ['power-law', 'heston'] }],
      branches: [
        {
          fields: [
            { name: 'kind', kind: 'enum', literals: ['power-law'] },
            { name: 'eta', kind: 'numeric' },
          ],
        },
        {
          fields: [
            { name: 'kind', kind: 'enum', literals: ['heston'] },
            { name: 'lambda', kind: 'numeric' },
          ],
        },
      ],
    };
    try {
      validateClosedRequest('phi', {}, PURE, TEACHING);
      expect.unreachable('accepted an empty pure union value');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputInvalidEnum)) throw error;
      expect(error.message).toContain('power-law');
      expect(error.message).toContain('heston');
    }
  });

  it('an OPTIONAL enum shared by every arm is never a discriminant', () => {
    // The EntryRule shape: every arm carries `price?: 'bid' | 'mid'` beside the true REQUIRED
    // discriminant. Collecting price as a discriminant refused every legal call omitting it.
    const OPTIONAL_ENUM: ClosedRequestSpecification = {
      contract: 'test:OptionalEnum',
      fields: [{ name: 'structure', kind: 'enum', literals: ['spread', 'condor'] }],
      branches: [
        {
          fields: [
            { name: 'structure', kind: 'enum', literals: ['spread'] },
            { name: 'width', kind: 'numeric' },
            { name: 'price', kind: 'enum', optional: true, literals: ['bid', 'mid'] },
          ],
        },
        {
          fields: [
            { name: 'structure', kind: 'enum', literals: ['condor'] },
            { name: 'wings', kind: 'numeric' },
            { name: 'price', kind: 'enum', optional: true, literals: ['bid', 'mid'] },
          ],
        },
      ],
    };
    // Omitting the optional enum selects by the REQUIRED discriminant and passes.
    validateClosedRequest('entry', { structure: 'spread', width: 5 }, OPTIONAL_ENUM, TEACHING);
    // When present it still validates against its domain.
    expect(
      codeOf(() =>
        validateClosedRequest(
          'entry',
          { structure: 'spread', width: 5, price: 'garbage' },
          OPTIONAL_ENUM,
          TEACHING,
        ),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    // And the true discriminant still refuses omission with the whole domain.
    expect(
      codeOf(() => validateClosedRequest('entry', { width: 5 }, OPTIONAL_ENUM, TEACHING)),
    ).toBe(ErrorCode.InputInvalidEnum);
  });

  // The Amortization shape from the live inventory: two literal-discriminated arms and one
  // structural arm with no discriminant at all.
  const UNION: ClosedRequestSpecification = {
    contract: 'test:Union',
    fields: [
      {
        name: 'amortization',
        kind: 'object',
        branches: [
          { fields: [{ name: 'type', kind: 'enum', literals: ['straight'] }] },
          {
            fields: [
              { name: 'type', kind: 'enum', literals: ['annuity'] },
              { name: 'rate', kind: 'numeric', optional: true },
            ],
          },
          { fields: [{ name: 'principalByPeriod', kind: 'array' }] },
        ],
      },
    ],
  };

  const run = (amortization: unknown): string =>
    codeOf(() => validateClosedRequest('bond', { amortization }, UNION, TEACHING));

  it('selects by discriminant and validates the chosen branch closed', () => {
    expect(run({ type: 'straight' })).toBe('NO THROW');
    expect(run({ type: 'annuity', rate: 0.05 })).toBe('NO THROW');
    expect(run({ type: 'annuity', principalByPeriod: [1] })).toBe(ErrorCode.InputUnknownField);
  });

  it('a wrong discriminant teaches against the WHOLE declared domain, never falls through', () => {
    // The `phi: {}` class: an unrecognized discriminant must not select whichever branch a
    // key-set match happens to pick.
    try {
      validateClosedRequest('bond', { amortization: { type: 'bullet' } }, UNION, TEACHING);
      expect.unreachable('accepted an undeclared discriminant');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputInvalidEnum)) throw error;
      expect(error.message).toContain('straight');
      expect(error.message).toContain('annuity');
    }
  });

  it('selects the structural arm when no discriminant is present', () => {
    expect(run({ principalByPeriod: [100, 100] })).toBe('NO THROW');
    expect(run({ principalByPeriod: 'all' })).toBe(ErrorCode.InputWrongType);
  });

  it('a value matching no arm teaches every alternative (structural arms present)', () => {
    // `{}` here could be a malformed structural arm, so the union with a `principalByPeriod` arm
    // teaches every alternative; a PURE discriminated union instead refuses on the discriminant
    // (covered below).
    try {
      validateClosedRequest('bond', { amortization: {} }, UNION, TEACHING);
      expect.unreachable('accepted an empty union value');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputWrongShape)) throw error;
      expect(error.message).toContain("type: 'straight'");
      expect(error.message).toContain("type: 'annuity'");
      expect(error.message).toContain('principalByPeriod');
    }
  });
});
