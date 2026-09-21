/**
 * Implied-volatility solvers validate at the BOUNDARY, because their objectives are unchecked.
 *
 * This is a regression suite for a defect I introduced. RV1 routed every solver objective to an
 * unchecked pricing kernel to keep validation out of the Brent loop — correct — and added the
 * required one-time boundary check to the Black-Scholes solver only. Black-76 and Bachelier got the
 * unchecked objective WITHOUT the precondition, and each carried a comment asserting the solver
 * "validated its own legs at the boundary". It had not. Measured before the fix:
 *
 *     black76ImpliedVolatility({ ...valid, forward: '100' })    -> converged: true, value 0.2197
 *     bachelierImpliedVolatility({ ...valid, forward: '100' })  -> converged: true, value 22.50
 *     either, omitting `strike`                                 -> converged: false, 'max_iterations'
 *
 * A string coerced through the arithmetic and came back as a CONVERGED solve. That is worse than the
 * seed defect it descends from: `NaN` at least looks wrong downstream, whereas 0.2197 is a plausible
 * implied volatility that a caller has no reason to distrust. The omission case was worse still as a
 * diagnosis — `max_iterations` blames the solver for the caller's missing field.
 *
 * The property under test is one line: for every solver, every required field, and every way a value
 * can be wrong, the solver THROWS rather than returning a result object. A solver that reports
 * `converged` on malformed input is asserting something about the market it never computed.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { blackScholesImpliedVolatility } from '@totalfinance/options/black-scholes';
import { black76ImpliedVolatility } from '@totalfinance/options/black76';
import { bachelierImpliedVolatility } from '@totalfinance/options/bachelier';

type Solver = (input: never) => unknown;

interface SolverCase {
  readonly name: string;
  readonly solve: Solver;
  readonly valid: Record<string, unknown>;
  readonly required: readonly string[];
  /** The quantity this solver SOLVES FOR — passing it is a conceptual error, not a valid input. */
  readonly solvesFor: string;
  /** Declared OPTIONAL numeric fields. Optional means omittable, never "any value goes". */
  readonly optional?: readonly string[];
  /** Field names of the search bracket, when the solver exposes one. */
  readonly bracket?: { readonly lo: string; readonly hi: string };
}

const SOLVERS: readonly SolverCase[] = [
  {
    name: 'blackScholesImpliedVolatility',
    solve: blackScholesImpliedVolatility as Solver,
    valid: {
      type: 'call',
      price: 2.4,
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      dividendYield: 0,
    },
    required: ['price', 'spot', 'strike', 'timeToExpiryYears', 'riskFreeRate', 'dividendYield'],
    solvesFor: 'volatility',
    optional: ['lowerVolatilityBound', 'upperVolatilityBound'],
    bracket: { lo: 'lowerVolatilityBound', hi: 'upperVolatilityBound' },
  },
  {
    name: 'black76ImpliedVolatility',
    solve: black76ImpliedVolatility as Solver,
    valid: {
      type: 'call',
      price: 2.4,
      forward: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
    },
    required: ['price', 'forward', 'strike', 'timeToExpiryYears', 'riskFreeRate'],
    solvesFor: 'volatility',
  },
  {
    name: 'bachelierImpliedVolatility',
    solve: bachelierImpliedVolatility as Solver,
    valid: {
      type: 'call',
      price: 8,
      forward: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
    },
    required: ['price', 'forward', 'strike', 'timeToExpiryYears', 'riskFreeRate'],
    solvesFor: 'normalVolatility',
  },
];

/** The thrown code, or a marker naming the result the solver returned instead. */
function codeOf(solve: Solver, input: unknown): string {
  try {
    return `NO THROW — returned ${JSON.stringify(solve(input as never))}`;
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

/** The four ways a numeric field is wrong, and the code each one owns. */
const MUTATIONS: ReadonlyArray<readonly [string, unknown, string]> = [
  ['a string', '100', 'input.wrong_type'],
  ['NaN', Number.NaN, 'input.nan'],
  ['Infinity', Number.POSITIVE_INFINITY, 'input.not_finite'],
  // Null is not omission (350c2796 ruling): required and optional null report the same
  // wrong_type, because a producer that writes null wrote a VALUE the declaration refuses.
  ['null', null, 'input.wrong_type'],
];

for (const { name, solve, valid, required, solvesFor, optional = [], bracket } of SOLVERS) {
  describe(`${name} — boundary validation`, () => {
    it('the control converges, so the guard did not break the solve', () => {
      const result = solve(valid as never) as { converged: boolean; value: number };
      expect(result.converged).toBe(true);
      expect(Number.isFinite(result.value)).toBe(true);
    });

    it.each(required)('omitting %s throws input.missing_field', (field) => {
      const input: Record<string, unknown> = { ...valid };
      delete input[field];
      expect(codeOf(solve, input)).toBe('input.missing_field');
    });

    for (const [label, value, expected] of MUTATIONS) {
      it.each(required)(`%s as ${label} throws ${expected}`, (field) => {
        expect(codeOf(solve, { ...valid, [field]: value })).toBe(expected);
      });
    }

    /**
     * A solver must REFUSE the quantity it solves for.
     *
     * Black-76 and Bachelier built their solver key lists as `[...PRICING_KEYS, 'price']`, which
     * inherited `volatility` / `normalVolatility` from the pricing contract. So a caller could pass
     * the very number being solved for and have it silently ignored — the answer returned is to a
     * different question than the one the call appears to ask. Black-Scholes spelled its list out by
     * hand and was correct, which is exactly why the other two are now spelled out too.
     */
    it(`refuses ${solvesFor} — the quantity it solves for`, () => {
      expect(codeOf(solve, { ...valid, [solvesFor]: 0.2 })).toBe('input.unknown_field');
    });

    it('a misspelled field is refused, not silently defaulted (Law 12)', () => {
      expect(codeOf(solve, { ...valid, forwrd: 1 })).toBe('input.unknown_field');
    });

    /**
     * OPTIONAL is about PRESENCE, not about type.
     *
     * The enforcement harness caught what this suite first missed: it probed only required fields, so
     * `lowerVolatilityBound: '0.1'` sailed through. The bracket comparison against a string is silently
     * false, the search never narrows, and the solver returns `reason: 'max_iterations'` — a
     * diagnosis that points at the algorithm instead of the argument. Omitting an optional field is
     * always fine; supplying a non-number for one never is.
     */
    if (optional.length > 0) {
      it.each(optional)('%s may be omitted, but not supplied as a string', (field) => {
        const withoutIt: Record<string, unknown> = { ...valid };
        delete withoutIt[field];
        expect(
          (solve(withoutIt as never) as { converged: boolean }).converged,
          'omitting an optional field must still solve',
        ).toBe(true);
        expect(codeOf(solve, { ...valid, [field]: '0.1' })).toBe('input.wrong_type');
      });

      it.each(optional)('%s as NaN is refused rather than iterated on', (field) => {
        expect(codeOf(solve, { ...valid, [field]: Number.NaN })).toBe('input.nan');
      });
    }

    /**
     * OPTIONAL ALSO MEANS "a valid value of its kind".
     *
     * RV5 checked the bracket endpoints were finite and stopped there, which is a type check standing
     * in for a domain check. Three broken brackets survived it, each failing differently and none of
     * them naming the argument:
     *
     *     lowerVolatilityBound: -0.1          -> converged: true, a plausible positive IV
     *     lowerVolatilityBound: 0             -> converged, or `max_iterations` depending on the quote
     *     lowerVolatilityBound: 0.3, hi: 0.1  -> `price_below_resolvable`
     *
     * A NEGATIVE volatility bound producing a confident answer is the serious one: σ < 0 has no
     * meaning in this model, and the solver never visits the endpoint it was handed, so nothing
     * downstream ever sees the contradiction. The half-specified cases matter for the same reason —
     * `lowerVolatilityBound: 10` against the default `hi = 5` is reversed just as surely.
     */
    if (bracket !== undefined) {
      const { lo, hi } = bracket;
      it.each([
        ['zero lower bound', { [lo]: 0 }],
        ['negative lower bound', { [lo]: -0.1 }],
        ['zero upper bound', { [hi]: 0 }],
        ['negative upper bound', { [hi]: -1 }],
        ['reversed bracket', { [lo]: 0.3, [hi]: 0.1 }],
        ['reversed against the default upper', { [lo]: 10 }],
      ])('refuses a %s', (_label, extra) => {
        expect(codeOf(solve, { ...valid, ...extra })).toBe('input.out_of_range');
      });

      /**
       * CROSSED WITH THE PRICE REGIME, because ordering is the defect.
       *
       * RV6 validated the bracket where its variables were defined — below the below-intrinsic and
       * above-bound exits. So `lowerVolatilityBound: -0.1` with a below-intrinsic price returned
       * `reason: 'below_intrinsic'`: a statement about the MARKET, produced for a call that was never
       * valid enough to have one. The single-price test passed the whole time, because it happened to
       * use a price inside the band.
       *
       * A precondition that only holds on the happy path is not a precondition.
       */
      const PRICE_REGIMES: ReadonlyArray<readonly [string, number]> = [
        ['inside the no-arbitrage band', valid['price'] as number],
        ['below intrinsic', 0],
        ['above the upper bound', 1e9],
      ];
      const INVALID_BRACKETS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ['zero lower', { [lo]: 0 }],
        ['negative lower', { [lo]: -0.1 }],
        ['zero upper', { [hi]: 0 }],
        ['negative upper', { [hi]: -1 }],
        ['reversed', { [lo]: 0.3, [hi]: 0.1 }],
        ['reversed against the default upper', { [lo]: 10 }],
      ];
      it('refuses every invalid bracket at every price regime', () => {
        const offenders: string[] = [];
        for (const [priceLabel, price] of PRICE_REGIMES) {
          for (const [bracketLabel, bracket] of INVALID_BRACKETS) {
            const code = codeOf(solve, { ...valid, price, ...bracket });
            if (code !== 'input.out_of_range') {
              offenders.push(`${bracketLabel} @ ${priceLabel}: got ${code}`);
            }
          }
        }
        expect(offenders, offenders.join('\n')).toEqual([]);
      });

      /**
       * A BOUND BOUNDS. The solver expands its upper endpoint by doubling, up to twelve times, and
       * that ran regardless of how the endpoint arrived — so a contract priced at σ = 1 solved to
       * 1.0000 with `converged: true` under `upperVolatilityBound: 0.2`. The caller named a ceiling
       * and the search stepped through it by a factor of 4,096, reporting success.
       *
       * Explicit means hard. Omitted means the library's default is a starting point it may grow.
       */
      it('an explicitly supplied upper bound is never exceeded', () => {
        const priced = solve({ ...valid, [hi]: 0.2 } as never) as {
          converged: boolean;
          value: number | null;
          reason?: string;
        };
        if (priced.converged) {
          expect(
            priced.value,
            'a converged root must lie under the stated bound',
          ).toBeLessThanOrEqual(0.2);
        } else {
          expect(priced.reason).toBe('no_bracket');
        }
      });

      it('an omitted upper bound still expands to find a distant root', () => {
        // The default is this library's guess, not the caller's constraint — growing it is a service.
        const wide = solve(valid as never) as { converged: boolean };
        expect(wide.converged).toBe(true);
      });

      it('a valid explicit bracket still solves', () => {
        const result = solve({ ...valid, [lo]: 0.01, [hi]: 3 } as never) as { converged: boolean };
        expect(result.converged).toBe(true);
      });
    }

    /**
     * The property, stated once. A returned result object — of ANY shape, converged or not — means
     * the solver treated malformed input as a market it could reason about.
     */
    it('never RETURNS on malformed input, for any field or mutation', () => {
      const offenders: string[] = [];
      for (const field of required) {
        const omitted: Record<string, unknown> = { ...valid };
        delete omitted[field];
        const cases: Array<[string, unknown]> = [
          [`omit ${field}`, omitted],
          ...MUTATIONS.map(
            ([label, value]) =>
              [`${field}=${label}`, { ...valid, [field]: value }] as [string, unknown],
          ),
        ];
        for (const [label, input] of cases) {
          const result = codeOf(solve, input);
          if (result.startsWith('NO THROW')) offenders.push(`${label}: ${result}`);
        }
      }
      expect(offenders, offenders.join('\n')).toEqual([]);
    });
  });
}
