import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  blackScholes,
  blackScholesExtendedGreeks,
  blackScholesGreeks,
  blackScholesPrice,
  type BlackScholesOutput,
} from '@totalfinance/options/black-scholes';
import golden from './golden/black-scholes-greeks-mpmath.json';

/**
 * The selective Black–Scholes surface (selective Greeks and exposure spec, decisions 2–6):
 * named single-Greek methods and `blackScholes.evaluate` against the existing kernels (EXACT
 * equality — one implementation, same operation order) and against independent 50-digit mpmath
 * references (golden/black-scholes-greeks-mpmath.json, from tools/golden/generate_black_scholes_greeks.py).
 */

const OUTPUTS: readonly BlackScholesOutput[] = [
  'price',
  'delta',
  'gamma',
  'theta',
  'vega',
  'rho',
  'vanna',
  'charm',
  'vomma',
  'speed',
  'color',
];
const BASIC = ['delta', 'gamma', 'theta', 'vega', 'rho'] as const;

const typedInput = fc.record({
  type: fc.constantFrom('call' as const, 'put' as const),
  spot: fc.double({ min: 1, max: 10_000, noNaN: true }),
  strikeRatio: fc.double({ min: 0.5, max: 2, noNaN: true }),
  timeToExpiryYears: fc.double({ min: 1 / (365 * 24), max: 5, noNaN: true }),
  riskFreeRate: fc.double({ min: -0.02, max: 0.1, noNaN: true }),
  dividendYield: fc.double({ min: 0, max: 0.08, noNaN: true }),
  volatility: fc.double({ min: 0.01, max: 2, noNaN: true }),
});

type TypedSample = typeof typedInput extends fc.Arbitrary<infer T> ? T : never;

const toInput = (sample: TypedSample) => ({
  type: sample.type,
  spot: sample.spot,
  strike: sample.spot * sample.strikeRatio,
  timeToExpiryYears: sample.timeToExpiryYears,
  riskFreeRate: sample.riskFreeRate,
  dividendYield: sample.dividendYield,
  volatility: sample.volatility,
});

/** Every output from the existing kernels, the reference for exact parity. */
function existing(input: ReturnType<typeof toInput>): Record<BlackScholesOutput, number> {
  const extended = blackScholesExtendedGreeks(input);
  return {
    price: blackScholesPrice(input),
    delta: extended.delta,
    gamma: extended.gamma,
    theta: extended.theta,
    vega: extended.vega,
    rho: extended.rho,
    vanna: extended.vanna,
    charm: extended.charm,
    vomma: extended.vomma,
    speed: extended.speed,
    color: extended.color,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return isQuantError(error) ? error.code : 'not-a-quant-error';
  }
  return undefined;
}

describe('named single-Greek methods', () => {
  it('equal the matching blackScholes.greeks field exactly, for calls and puts across the domain', () => {
    fc.assert(
      fc.property(typedInput, (sample) => {
        const input = toInput(sample);
        const greeks = blackScholesGreeks(input);
        for (const name of BASIC) expect(blackScholes[name](input)).toBe(greeks[name]);
      }),
      { numRuns: 400, seed: 20261001 },
    );
  });

  it('match the facade greeks for the documented optional dividend yield', () => {
    const input = {
      type: 'put' as const,
      spot: 100,
      strike: 95,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.04,
      volatility: 0.25,
    };
    const greeks = blackScholes.greeks(input);
    for (const name of BASIC) expect(blackScholes[name](input)).toBe(greeks[name]);
  });

  it('explain returns the closed-form envelope with the same value and Greek units', () => {
    const input = {
      type: 'call' as const,
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    };
    for (const name of BASIC) {
      const explained = blackScholes[name].explain(input);
      expect(explained.value).toBe(blackScholes[name](input));
      expect(explained.assumptions).toEqual(blackScholes.greeks.explain(input).assumptions);
      expect(explained.diagnostics).toMatchObject({
        engine: 'black-scholes-merton',
        method: 'closed-form',
        converged: true,
      });
    }
    // The plausibility disclosure rides .explain exactly as on .greeks.explain (volatility as a percent).
    const suspicious = { ...input, volatility: 20 };
    expect(blackScholes.gamma.explain(suspicious).diagnostics.warnings.map((w) => w.code)).toEqual(
      blackScholes.greeks.explain(suspicious).diagnostics.warnings.map((w) => w.code),
    );
  });

  it('validate exactly like the existing facade methods', () => {
    const valid = {
      type: 'call' as const,
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    };
    const cases: Array<Record<string, unknown>> = [
      { ...valid, volatility: undefined },
      { ...valid, spot: -1 },
      { ...valid, type: 'Call' },
      { ...valid, sigma: 0.2 },
      { ...valid, outputs: ['gamma'] },
      { ...valid, dividendYield: null },
    ];
    for (const bad of cases) {
      for (const name of BASIC) {
        expect(codeOf(() => blackScholes[name](bad as never))).toBe(
          codeOf(() => blackScholes.greeks(bad as never)),
        );
        expect(codeOf(() => blackScholes[name](bad as never))).toBeDefined();
      }
    }
  });
});

describe('blackScholes.evaluate', () => {
  it('returns exactly the requested outputs, in request order, equal to the existing kernels', () => {
    fc.assert(
      fc.property(
        typedInput,
        fc.subarray([...OUTPUTS], { minLength: 1 }),
        fc.boolean(),
        (sample, picked, reversed) => {
          const input = toInput(sample);
          const outputs = reversed ? [...picked].reverse() : picked;
          const result = blackScholes.evaluate({ ...input, outputs });
          expect(Object.keys(result)).toEqual(outputs);
          const reference = existing(input);
          for (const name of outputs) expect(result[name]).toBe(reference[name]);
        },
      ),
      { numRuns: 400, seed: 20261002 },
    );
  });

  it('a combined selection equals the individual calls', () => {
    const input = {
      type: 'put' as const,
      spot: 6500,
      strike: 6450,
      timeToExpiryYears: 3 / 365,
      riskFreeRate: 0.045,
      dividendYield: 0.013,
      volatility: 0.16,
    };
    const all = blackScholes.evaluate({ ...input, outputs: [...OUTPUTS] });
    for (const name of OUTPUTS) {
      expect(blackScholes.evaluate({ ...input, outputs: [name] })[name]).toBe(all[name]);
    }
    for (const name of BASIC) expect(blackScholes[name](input)).toBe(all[name]);
    expect(blackScholes.price(input)).toBe(all.price);
  });

  it('explain carries the closed-form envelope and discloses a price that underflowed to 0', () => {
    const input = {
      type: 'call' as const,
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    };
    const explained = blackScholes.evaluate.explain({ ...input, outputs: ['gamma', 'price'] });
    expect(explained.value).toEqual(
      blackScholes.evaluate({ ...input, outputs: ['gamma', 'price'] }),
    );
    expect(explained.assumptions).toEqual(blackScholes.greeks.explain(input).assumptions);
    const deepOtm = { ...input, strike: 100_000, timeToExpiryYears: 0.01 };
    const underflow = blackScholes.evaluate.explain({ ...deepOtm, outputs: ['price'] });
    expect(underflow.value.price).toBe(0);
    expect(underflow.diagnostics.warnings.map((w) => w.code)).toContain('model.limitation');
    // Without `price` in the selection there is no price to disclose.
    expect(
      blackScholes.evaluate
        .explain({ ...deepOtm, outputs: ['gamma'] })
        .diagnostics.warnings.map((w) => w.code),
    ).not.toContain('model.limitation');
  });

  it('refuses malformed selections with typed, specific codes', () => {
    const input = {
      type: 'call' as const,
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    };
    const run = (outputs: unknown) =>
      codeOf(() => blackScholes.evaluate({ ...input, outputs } as never));
    expect(run(undefined)).toBe(ErrorCode.InputWrongType);
    expect(run('gamma')).toBe(ErrorCode.InputWrongType);
    expect(run([])).toBe(ErrorCode.InputOutOfRange);
    // eslint-disable-next-line no-sparse-arrays
    expect(run(['price', , 'gamma'])).toBe(ErrorCode.InputMissingField);
    expect(run(['gama'])).toBe(ErrorCode.InputInvalidEnum);
    expect(run([7])).toBe(ErrorCode.InputInvalidEnum);
    // Outputs that stay on their existing APIs are not silently accepted.
    expect(run(['lambda'])).toBe(ErrorCode.InputInvalidEnum);
    expect(run(['zomma'])).toBe(ErrorCode.InputInvalidEnum);
    expect(run(['gamma', 'delta', 'gamma'])).toBe(ErrorCode.InputDuplicateEntry);
    // A misspelled top-level key teaches (Law 12).
    expect(codeOf(() => blackScholes.evaluate({ ...input, output: ['gamma'] } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
  });

  it('teaches with a did-you-mean and names the offending index', () => {
    const input = {
      type: 'call' as const,
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    };
    expect(() =>
      blackScholes.evaluate({
        ...input,
        outputs: ['price', 'gama'] as unknown as BlackScholesOutput[],
      }),
    ).toThrow(/outputs\[1\].*did you mean "gamma"/);
    expect(() => blackScholes.evaluate({ ...input, outputs: ['vega', 'vega'] })).toThrow(
      /names "vega" more than once/,
    );
  });

  it('validates the Black–Scholes input before the selection, like every facade', () => {
    const input = {
      type: 'call' as const,
      spot: -5,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    };
    expect(
      codeOf(() =>
        blackScholes.evaluate({ ...input, outputs: ['gama'] as unknown as BlackScholesOutput[] }),
      ),
    ).toBe(ErrorCode.InputNegativeSpot);
  });
});

describe('independent mpmath references (50 digits; Greeks by numerical differentiation)', () => {
  /**
   * The tolerance is the double-precision floor, not a fitting knob: relative 2e-9, plus an
   * absolute floor of 1e-12 of the output's own scale (spot-scaled for spot derivatives) so that
   * values that are truly ~0 (deep OTM, one-day expiries) compare by absolute error. The largest
   * observed errors are recorded in the spec's verification record.
   */
  const scaleFor = (name: BlackScholesOutput, spot: number): number => {
    switch (name) {
      case 'gamma':
      case 'vanna':
        return 1 / spot;
      case 'speed':
      case 'color':
        return 1 / (spot * spot);
      default:
        return spot;
    }
  };

  it('every output of every case agrees with the reference', () => {
    let worst = { name: '', relative: 0 };
    for (const { input, expected } of golden.entries) {
      const typed = { ...input, type: input.type as 'call' | 'put' };
      const result = blackScholes.evaluate({ ...typed, outputs: [...OUTPUTS] });
      for (const name of OUTPUTS) {
        const want = (expected as Record<string, number>)[name]!;
        const got = result[name];
        if (got === undefined) throw new Error(`${name} missing from a full selection`);
        const tolerance = 2e-9 * Math.abs(want) + 1e-12 * scaleFor(name, typed.spot);
        expect(Math.abs(got - want), `${name} ${JSON.stringify(input)}`).toBeLessThanOrEqual(
          tolerance,
        );
        const relative = Math.abs(got - want) / Math.max(Math.abs(want), 1e-300);
        if (Math.abs(want) > 1e-12 * scaleFor(name, typed.spot) && relative > worst.relative)
          worst = { name, relative };
      }
    }
    expect(golden.entries.length).toBe(96);
    expect(worst.relative).toBeLessThan(2e-9);
  });
});
