/**
 * The seed defects Phase 3B was opened on, and the shared enforcement path that closes them.
 *
 * The original bug, verbatim from the spec: "omitting required `volatility` through JavaScript or
 * `any` reaches arithmetic and returns `NaN`". Both kernels validated the request OBJECT and the
 * `type` enum, then destructured six numeric fields and checked none of them — so a caller who
 * forgot one got a price of `NaN` returned as a success, through a declaration that said the field
 * was required.
 *
 * That is the worst failure mode a pricing library has. A throw is loud and stops at the call site;
 * `NaN` is silent, survives arithmetic, and reaches a P&L number, a risk report, or an order.
 *
 * These tests assert the EXACT code per failure mode rather than "it throws", because the four modes
 * are four different user mistakes and a single code for all of them teaches none:
 *
 *     omitted        input.missing_field   you forgot it — here is a working example
 *     wrong type     input.wrong_type      you passed a string where a number goes
 *     NaN            input.nan             your upstream computation already failed
 *     ±Infinity      input.not_finite      your upstream computation overflowed
 *
 * Every negative case here fails against the pre-fix kernels (they returned a number), which is what
 * makes them regression tests rather than descriptions of current behaviour.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { black76Price } from '@totalfinance/options/black76';

const BSM = {
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  dividendYield: 0,
  volatility: 0.2,
} as const;

const B76 = {
  type: 'call',
  forward: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
} as const;

/** Call through `any`, which is exactly how a JavaScript caller reaches these kernels. */
const call = (fn: (input: never) => number, input: unknown): number => fn(input as never);

/** The thrown error's stable code, or a marker naming what came back instead. */
function codeOf(fn: (input: never) => number, input: unknown): string {
  try {
    return `NO THROW — returned ${String(call(fn, input))}`;
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

describe('blackScholesPrice — the seed defect', () => {
  it('the control still prices correctly, so the guard did not break the math', () => {
    expect(blackScholesPrice(BSM)).toBeCloseTo(2.390877, 5);
  });

  // The heart of it: every declared-required numeric field, omitted one at a time.
  const fields = [
    'spot',
    'strike',
    'timeToExpiryYears',
    'riskFreeRate',
    'dividendYield',
    'volatility',
  ] as const;

  it.each(fields)('omitting %s is refused, not priced as NaN', (field) => {
    const input: Record<string, unknown> = { ...BSM };
    delete input[field];
    expect(codeOf(blackScholesPrice, input)).toBe('input.missing_field');
  });

  /**
   * The example must be a RUNNABLE CALL, not a field fragment.
   *
   * `missingFieldError` documents itself as showing "a WORKING example call", and the first version of
   * this test only asserted the presence of `e.g.` and a unit phrase — which a fragment like
   * `volatility: 0.2 (annualized decimal)` satisfies while being unpasteable. A caller confused about
   * the request shape is exactly the one who cannot assemble a call from a snippet, so the assertion
   * now demands the function name and a complete argument list.
   */
  it('the message shows a runnable call, and the unit trap survives as a hint', () => {
    const input: Record<string, unknown> = { ...BSM };
    delete input['volatility'];
    try {
      call(blackScholesPrice, input);
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('volatility is required');

      const example = message.split('e.g. ')[1]?.split('\n')[0] ?? '';
      expect(example, 'the example must name the function').toContain('blackScholesPrice(');
      expect(example, 'and close the call').toMatch(/\)$/);
      // Every field the kernel requires appears in the example, so pasting it actually works.
      for (const field of fields) expect(example, `example omits ${field}`).toContain(`${field}:`);

      // The hint is a SECOND line: the call shape cannot carry "not 20".
      expect(message).toContain('volatility: annualized decimal, not 20');
    }
  });

  it.each([
    ['a string', '0.2', 'input.wrong_type'],
    // Null is not omission (350c2796 ruling): a producer that omits writes nothing; one that
    // writes null wrote a value the declaration refuses, and the code says so.
    ['null', null, 'input.wrong_type'],
    ['NaN', Number.NaN, 'input.nan'],
    ['Infinity', Number.POSITIVE_INFINITY, 'input.not_finite'],
    ['-Infinity', Number.NEGATIVE_INFINITY, 'input.not_finite'],
  ])('volatility as %s is refused with %s', (_label, value, expected) => {
    expect(codeOf(blackScholesPrice, { ...BSM, volatility: value })).toBe(expected as string);
  });

  it('a non-object input is still refused before any field is read', () => {
    expect(codeOf(blackScholesPrice, undefined)).toBe('input.wrong_type');
    expect(codeOf(blackScholesPrice, 100)).toBe('input.wrong_type');
  });

  it('the enum guard still runs — a wrong `type` never silently prices the other leg', () => {
    expect(codeOf(blackScholesPrice, { ...BSM, type: 'Call' })).toBe('input.invalid_enum');
  });
});

describe('black76Price — the second seed defect', () => {
  it('the control still prices correctly', () => {
    expect(black76Price(B76)).toBeGreaterThan(0);
  });

  it.each(['forward', 'strike', 'timeToExpiryYears', 'riskFreeRate', 'volatility'] as const)(
    'omitting %s is refused, not priced as NaN',
    (field) => {
      const input: Record<string, unknown> = { ...B76 };
      delete input[field];
      expect(codeOf(black76Price, input)).toBe('input.missing_field');
    },
  );

  it('teaches the forward/spot distinction, which is the mistake this kernel actually invites', () => {
    const input: Record<string, unknown> = { ...B76 };
    delete input['forward'];
    try {
      call(black76Price, input);
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('not spot');
    }
  });
});

describe('no result is ever a non-finite success', () => {
  /**
   * The property behind both seed defects, stated once: for every single-field omission the kernel
   * must THROW. Returning any number at all — `NaN` most of all — is the defect.
   */
  it('no omission of any required field yields a returned value', () => {
    const offenders: string[] = [];
    for (const field of Object.keys(BSM)) {
      const input: Record<string, unknown> = { ...BSM };
      delete input[field];
      const result = codeOf(blackScholesPrice, input);
      if (result.startsWith('NO THROW'))
        offenders.push(`blackScholesPrice omit ${field}: ${result}`);
    }
    for (const field of Object.keys(B76)) {
      const input: Record<string, unknown> = { ...B76 };
      delete input[field];
      const result = codeOf(black76Price, input);
      if (result.startsWith('NO THROW')) offenders.push(`black76Price omit ${field}: ${result}`);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
