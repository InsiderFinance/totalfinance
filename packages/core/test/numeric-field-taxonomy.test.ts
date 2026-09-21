/**
 * The numeric-field error taxonomy, proven where it is DEFINED rather than where it is used.
 *
 * `requireFiniteFields` is the shared enforcement path for every object-input numeric contract, and
 * the codes it emits are a public promise: four distinct mistakes, four distinct codes, each with a
 * fix that follows from the code alone.
 *
 *     omitted/undefined  input.missing_field   you forgot it — here is a runnable call
 *     null               input.wrong_type      a value the declaration refuses (null is not omission)
 *     wrong type         input.wrong_type      a string where a number goes
 *     NaN                input.nan             your upstream computation already failed
 *     ±Infinity          input.not_finite      your upstream computation overflowed
 *     non-object input   input.wrong_type      you passed a number where the request goes
 *
 * A review found the matrix contradicted in two places, and BOTH survived because the matrix was only
 * ever demonstrated indirectly through the options and technical-analysis suites:
 *
 *   - a non-object container threw `input.wrong_shape` here but `input.wrong_type` from
 *     `requireArgumentObject` — one mistake, two codes, decided by which guard ran first;
 *   - an optional-but-present field ran bare `ensureFinite`, so a string reported `input.not_finite`
 *     instead of `input.wrong_type` — and a test had been written asserting exactly that, which is
 *     how the contradiction outlived the matrix that forbade it.
 *
 * Proving it at the definition is the point. A property demonstrated only through its consumers is a
 * property that changes silently when a consumer is rewritten.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '../src/errors.js';
import { ensureFiniteWhenPresent, requireFiniteFields } from '../src/invariants.js';

const FIELDS = ['alpha', 'beta'] as const;
const VALID = { alpha: 1, beta: 2 };

function codeOf(call: () => unknown): string {
  try {
    call();
    return 'NO THROW';
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

const EXAMPLE = 'probe({ alpha: 1, beta: 2 })';
const requireFields = (
  input: unknown,
  options: Parameters<typeof requireFiniteFields>[3] = { exampleCall: EXAMPLE },
) => codeOf(() => requireFiniteFields('probe', input, FIELDS, options));

describe('requireFiniteFields — one code per mistake', () => {
  it('the control passes', () => {
    expect(requireFields(VALID)).toBe('NO THROW');
  });

  it.each([
    ['omitted', { alpha: 1 }, 'input.missing_field'],
    // The 350c2796 review settled the split ruling: required null had reported missing_field while
    // optional null reported wrong_type — one value, two codes, decided by requiredness. A present
    // non-nullable null is a wrong-typed VALUE everywhere now, and the ladders agree.
    ['null', { alpha: 1, beta: null }, 'input.wrong_type'],
    ['undefined', { alpha: 1, beta: undefined }, 'input.missing_field'],
    ['a string', { alpha: 1, beta: '2' }, 'input.wrong_type'],
    ['a boolean', { alpha: 1, beta: true }, 'input.wrong_type'],
    ['an object', { alpha: 1, beta: {} }, 'input.wrong_type'],
    ['NaN', { alpha: 1, beta: Number.NaN }, 'input.nan'],
    ['Infinity', { alpha: 1, beta: Number.POSITIVE_INFINITY }, 'input.not_finite'],
    ['-Infinity', { alpha: 1, beta: Number.NEGATIVE_INFINITY }, 'input.not_finite'],
  ])('a field that is %s reports %s', (_label, input, expected) => {
    expect(requireFields(input)).toBe(expected as string);
  });

  /**
   * The container, settled. All four of these are "you did not pass the request object", and they
   * now agree with `requireArgumentObject` rather than reporting a second code for the same mistake.
   */
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an array', [1, 2]],
  ])('a non-object input (%s) reports input.wrong_type', (_label, input) => {
    expect(requireFields(input)).toBe('input.wrong_type');
  });

  it('reports the NESTED path, so the caller knows which object to fix', () => {
    try {
      requireFiniteFields('probe', { alpha: 1 }, FIELDS, {
        path: 'parameters',
        exampleCall: EXAMPLE,
      });
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as Error).message).toContain('parameters.beta is required');
    }
  });

  it('the example is a runnable call and the hint is a separate line', () => {
    try {
      requireFiniteFields('probe', { alpha: 1 }, FIELDS, {
        exampleCall: 'probe({ alpha: 1, beta: 2 })',
        hints: { beta: 'must be positive' },
      });
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('e.g. probe({ alpha: 1, beta: 2 })');
      expect(message).toContain('beta: must be positive');
    }
  });

  it('RV9 — the example is REQUIRED and emitted verbatim; there is no shaped fallback', () => {
    /**
     * This test used to assert the opposite: that omitting `exampleCall` fell back to
     * `probe({ …, beta: … })`. That string is not runnable — `…` is not JavaScript — so the error
     * promised "a WORKING example call" and, at any boundary whose author forgot the option,
     * delivered a shape sketch instead. The fallback made forgetting invisible.
     *
     * `exampleCall` and the options object are now REQUIRED, so the compiler asks every boundary for
     * one and this file cannot express the old call at all. What survives at runtime is the check
     * that the caller's example reaches the message unaltered, and that no ellipsis placeholder can
     * appear in it.
     */
    try {
      requireFiniteFields('probe', { alpha: 1 }, FIELDS, { exampleCall: EXAMPLE });
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(EXAMPLE);
      expect(message).not.toContain('…');
    }
  });

  it('a thunk example is evaluated only on the failing path', () => {
    // The lazy form exists so a derived example costs nothing on the millions of calls that succeed.
    let built = 0;
    const lazy = () => {
      built += 1;
      return EXAMPLE;
    };
    expect(requireFields(VALID, { exampleCall: lazy })).toBe('NO THROW');
    expect(built, 'the thunk must NOT run when every field is present').toBe(0);
    expect(requireFields({ alpha: 1 }, { exampleCall: lazy })).toBe('input.missing_field');
    expect(built, 'the thunk runs exactly once, on the throw').toBe(1);
  });
});

describe('ensureFiniteWhenPresent — optional fields run the SAME ladder', () => {
  it('undefined is omission; null is NOT a second spelling of it', () => {
    // This test used to assert NO THROW for null — pinning the defect in place, which is how it
    // survived (the same shape as the bar-accessor contradiction test). Every call site's
    // declaration is `field?: number` with no `| null`: C06 reserves null for declarations that
    // spell it, so a null here is a wrong-typed value, not an absent one. The
    // `null-when-nonnullable` enforcement mutation keeps this class measurable.
    expect(codeOf(() => ensureFiniteWhenPresent(undefined, 'open', 'probe'))).toBe('NO THROW');
    expect(codeOf(() => ensureFiniteWhenPresent(null, 'open', 'probe'))).toBe('input.wrong_type');
  });

  it('present-and-valid is allowed', () => {
    expect(codeOf(() => ensureFiniteWhenPresent(100, 'open', 'probe'))).toBe('NO THROW');
  });

  /**
   * The case the old code got wrong: a STRING in an optional numeric slot. Bare `ensureFinite` called
   * it `not_finite` — true of `Number.isFinite('100')`, and useless, because the caller passed the
   * wrong TYPE rather than an unusable number.
   */
  it.each([
    ['a string', '100', 'input.wrong_type'],
    ['a boolean', false, 'input.wrong_type'],
    ['NaN', Number.NaN, 'input.nan'],
    ['Infinity', Number.POSITIVE_INFINITY, 'input.not_finite'],
  ])('present but %s reports %s', (_label, value, expected) => {
    expect(codeOf(() => ensureFiniteWhenPresent(value, 'open', 'probe'))).toBe(expected as string);
  });

  it('agrees with the REQUIRED ladder on every present value', () => {
    const disagreements: string[] = [];
    for (const value of ['100', true, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      const optional = codeOf(() => ensureFiniteWhenPresent(value, 'beta', 'probe'));
      const required = requireFields({ alpha: 1, beta: value });
      if (optional !== required)
        disagreements.push(`${String(value)}: optional=${optional} required=${required}`);
    }
    expect(disagreements, disagreements.join('\n')).toEqual([]);
  });
});
