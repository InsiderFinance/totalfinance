import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  blackScholesEvaluateMany,
  blackScholesEvaluateManyInto,
  blackScholesPriceMany,
  blackScholesPriceManyInto,
  type BlackScholesOutput,
  type OptionBatchColumns,
} from '@totalfinance/options/batch';
import {
  blackScholes,
  blackScholesExtendedGreeks,
  blackScholesGreeks,
  blackScholesPrice,
} from '@totalfinance/options/black-scholes';

/**
 * The selective batch family (selective Greeks and exposure spec, decisions 7–9):
 * `blackScholesEvaluateMany`, `blackScholesEvaluateManyInto`, and the existing
 * `blackScholesPriceMany`/`blackScholesPriceManyInto` routed through the same kernel.
 *
 * Parity is EXACT (`Object.is`), row by row, against the scalar functions — one set of expressions.
 * The buffer contract is tested as a contract: validate everything before the first write, write
 * `[0, rows)`, leave the tail alone, refuse shared memory.
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

const row = fc.record({
  call: fc.boolean(),
  spot: fc.double({ min: 1, max: 10_000, noNaN: true }),
  strikeRatio: fc.double({ min: 0.5, max: 2, noNaN: true }),
  timeToExpiryYears: fc.double({ min: 1 / (365 * 24), max: 5, noNaN: true }),
  riskFreeRate: fc.double({ min: -0.02, max: 0.1, noNaN: true }),
  dividendYield: fc.double({ min: 0, max: 0.08, noNaN: true }),
  volatility: fc.double({ min: 0.01, max: 2, noNaN: true }),
});
type Row = typeof row extends fc.Arbitrary<infer T> ? T : never;

function columnsOf(rows: readonly Row[], withDividends: boolean): OptionBatchColumns {
  const columns: OptionBatchColumns = {
    spot: Float64Array.from(rows, (r) => r.spot),
    strike: Float64Array.from(rows, (r) => r.spot * r.strikeRatio),
    volatility: Float64Array.from(rows, (r) => r.volatility),
    riskFreeRate: Float64Array.from(rows, (r) => r.riskFreeRate),
    timeToExpiryYears: Float64Array.from(rows, (r) => r.timeToExpiryYears),
    type: Int8Array.from(rows, (r) => (r.call ? 1 : -1)),
  };
  if (withDividends) columns.dividendYield = Float64Array.from(rows, (r) => r.dividendYield);
  return columns;
}

function rowInput(columns: OptionBatchColumns, i: number) {
  return {
    type: columns.type[i]! > 0 ? ('call' as const) : ('put' as const),
    spot: columns.spot[i]!,
    strike: columns.strike[i]!,
    timeToExpiryYears: columns.timeToExpiryYears[i]!,
    riskFreeRate: columns.riskFreeRate[i]!,
    dividendYield: columns.dividendYield === undefined ? 0 : columns.dividendYield[i]!,
    volatility: columns.volatility[i]!,
  };
}

/** Every output for one row from the EXISTING scalar kernels — the parity reference. */
function existingRow(columns: OptionBatchColumns, i: number): Record<BlackScholesOutput, number> {
  const input = rowInput(columns, i);
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

/** A small fixed chain: calls and puts, ITM/ATM/OTM, with a dividend column. */
function chain(): OptionBatchColumns {
  return {
    spot: Float64Array.from([100, 100, 100, 6500, 7.5]),
    strike: Float64Array.from([90, 100, 115, 6450, 9]),
    volatility: Float64Array.from([0.2, 0.25, 0.3, 0.15, 1.1]),
    riskFreeRate: Float64Array.from([0.04, 0.04, 0.04, 0.045, -0.005]),
    timeToExpiryYears: Float64Array.from([0.5, 1 / 365, 2, 0.02, 0.25]),
    type: Int8Array.from([1, -1, 1, -1, 1]),
    dividendYield: Float64Array.from([0, 0.01, 0.02, 0.013, 0]),
  };
}

function caught(fn: () => unknown): { code: string; message: string; context: unknown } {
  try {
    fn();
  } catch (error) {
    if (!isQuantError(error)) throw error;
    return { code: error.code, message: error.message, context: error.context };
  }
  throw new Error('expected a typed error');
}

const SENTINEL = -12345.678;
const sentinel = (length: number) => new Float64Array(length).fill(SENTINEL);

describe('blackScholesEvaluateMany — exact parity with the scalar kernels', () => {
  it('every output column equals the scalar value on every row (property)', () => {
    fc.assert(
      fc.property(
        fc.array(row, { minLength: 1, maxLength: 24 }),
        fc.boolean(),
        fc.subarray([...OUTPUTS], { minLength: 1 }),
        (rows, withDividends, outputs) => {
          const columns = columnsOf(rows, withDividends);
          const result = blackScholesEvaluateMany(columns, { outputs });
          expect(Object.keys(result)).toEqual(outputs);
          for (let i = 0; i < rows.length; i++) {
            const want = existingRow(columns, i);
            for (const output of outputs)
              expect(Object.is(result[output]![i], want[output])).toBe(true);
          }
        },
      ),
      { numRuns: 200, seed: 20261003 },
    );
  });

  it('a gamma-only selection runs its own row loop and equals the general loop bit for bit', () => {
    // Gamma alone (GEX profile and zero-gamma sweeps, gammaExposure) has a dedicated loop; zero rates
    // and yields take a shortcut that skips their discount exponential. Both must leave every value
    // exactly what the general loop and the scalar kernels produce, -0 yields included.
    fc.assert(
      fc.property(
        fc.array(row, { minLength: 1, maxLength: 24 }),
        fc.boolean(),
        fc.constantFrom('given', 'zero', 'negative-zero'),
        (rows, withDividends, rates) => {
          const base = columnsOf(rows, withDividends);
          const zero = () => new Float64Array(rows.length).fill(rates === 'zero' ? 0 : -0);
          const columns: OptionBatchColumns =
            rates === 'given'
              ? base
              : {
                  ...base,
                  riskFreeRate: zero(),
                  ...(withDividends ? { dividendYield: zero() } : {}),
                };
          const alone = blackScholesEvaluateMany(columns, { outputs: ['gamma'] }).gamma;
          const general = blackScholesEvaluateMany(columns, { outputs: ['gamma', 'delta'] }).gamma;
          const into = new Float64Array(rows.length);
          blackScholesEvaluateManyInto(columns, { gamma: into });
          for (let i = 0; i < rows.length; i++) {
            const want = existingRow(columns, i).gamma;
            expect(Object.is(alone[i], want)).toBe(true);
            expect(Object.is(general[i], want)).toBe(true);
            expect(Object.is(into[i], want)).toBe(true);
          }
        },
      ),
      { numRuns: 300, seed: 20261005 },
    );
  });

  it('matches the scalar blackScholes.evaluate row by row, in request order', () => {
    const columns = chain();
    const outputs = ['color', 'price', 'gamma'] as const;
    const result = blackScholesEvaluateMany(columns, { outputs });
    expect(Object.keys(result)).toEqual(['color', 'price', 'gamma']);
    for (let i = 0; i < columns.spot.length; i++) {
      const scalar = blackScholes.evaluate({ ...rowInput(columns, i), outputs });
      expect(result.color[i]).toBe(scalar.color);
      expect(result.price[i]).toBe(scalar.price);
      expect(result.gamma[i]).toBe(scalar.gamma);
    }
  });

  it('allocates exactly one row-length Float64Array per selected output', () => {
    const result = blackScholesEvaluateMany(chain(), { outputs: ['gamma'] });
    expect(Object.keys(result)).toEqual(['gamma']);
    expect(result.gamma).toBeInstanceOf(Float64Array);
    expect(result.gamma.length).toBe(5);
  });

  it('an empty chain returns empty columns', () => {
    const empty = columnsOf([], false);
    const result = blackScholesEvaluateMany(empty, { outputs: ['gamma', 'delta'] });
    expect(result.gamma.length).toBe(0);
    expect(result.delta.length).toBe(0);
  });

  it('plain number arrays are accepted as columns, as for the existing batch pricers', () => {
    const typed = chain();
    const plain = Object.fromEntries(
      Object.entries(typed).map(([key, values]) => [key, Array.from(values as Float64Array)]),
    ) as unknown as OptionBatchColumns;
    const fromPlain = blackScholesEvaluateMany(plain, { outputs: ['delta'] });
    const fromTyped = blackScholesEvaluateMany(typed, { outputs: ['delta'] });
    expect(Array.from(fromPlain.delta)).toEqual(Array.from(fromTyped.delta));
  });
});

describe('blackScholesEvaluateManyInto — reusable storage, not unchecked input', () => {
  it('writes the same values as blackScholesEvaluateMany', () => {
    fc.assert(
      fc.property(
        fc.array(row, { minLength: 1, maxLength: 24 }),
        fc.boolean(),
        fc.subarray([...OUTPUTS], { minLength: 1 }),
        (rows, withDividends, outputs) => {
          const columns = columnsOf(rows, withDividends);
          const want = blackScholesEvaluateMany(columns, { outputs });
          const buffers = Object.fromEntries(
            outputs.map((output) => [output, new Float64Array(rows.length)]),
          );
          blackScholesEvaluateManyInto(columns, buffers);
          for (const output of outputs) {
            expect(Array.from(buffers[output]!)).toEqual(Array.from(want[output]!));
          }
        },
      ),
      { numRuns: 150, seed: 20261004 },
    );
  });

  it('writes rows [0, n) and leaves a larger buffer’s tail untouched; buffers are reusable', () => {
    const columns = chain();
    const gamma = sentinel(8);
    const delta = sentinel(5);
    blackScholesEvaluateManyInto(columns, { gamma, delta });
    const want = blackScholesEvaluateMany(columns, { outputs: ['gamma', 'delta'] });
    expect(Array.from(gamma.subarray(0, 5))).toEqual(Array.from(want.gamma));
    expect(Array.from(gamma.subarray(5))).toEqual([SENTINEL, SENTINEL, SENTINEL]);
    expect(Array.from(delta)).toEqual(Array.from(want.delta));

    // Reuse: a shorter chain overwrites only its own rows.
    const shorter = columnsOf(
      [
        {
          call: true,
          spot: 50,
          strikeRatio: 1,
          timeToExpiryYears: 0.1,
          riskFreeRate: 0.03,
          dividendYield: 0,
          volatility: 0.4,
        },
      ],
      false,
    );
    blackScholesEvaluateManyInto(shorter, { gamma });
    expect(gamma[0]).toBe(blackScholes.gamma(rowInput(shorter, 0)));
    expect(Array.from(gamma.subarray(1, 5))).toEqual(Array.from(want.gamma.subarray(1)));
    expect(Array.from(gamma.subarray(5))).toEqual([SENTINEL, SENTINEL, SENTINEL]);
  });

  it('an undefined entry is treated as omitted', () => {
    const gamma = sentinel(5);
    blackScholesEvaluateManyInto(chain(), { gamma, delta: undefined } as never);
    expect(gamma[0]).not.toBe(SENTINEL);
  });

  it('validates every row before the first write: a bad LAST row leaves every buffer untouched', () => {
    const columns = chain();
    columns.volatility[4] = Number.NaN;
    const gamma = sentinel(5);
    const price = sentinel(5);
    const error = caught(() => blackScholesEvaluateManyInto(columns, { gamma, price }));
    expect(error.code).toBe(ErrorCode.InputOutOfRange);
    expect(error.context).toMatchObject({ row: 4, field: 'volatility' });
    expect(Array.from(gamma)).toEqual(Array.from(sentinel(5)));
    expect(Array.from(price)).toEqual(Array.from(sentinel(5)));
  });

  it('a rejected buffer leaves the valid buffers untouched', () => {
    const gamma = sentinel(5);
    expect(
      caught(() => blackScholesEvaluateManyInto(chain(), { gamma, delta: new Float64Array(4) }))
        .code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(Array.from(gamma)).toEqual(Array.from(sentinel(5)));
  });

  it('refuses buffers that are not Float64Arrays, too short, unknown, or absent', () => {
    const columns = chain();
    const wrongType = (value: unknown) =>
      caught(() => blackScholesEvaluateManyInto(columns, { gamma: value } as never));
    expect(wrongType([0, 0, 0, 0, 0]).code).toBe(ErrorCode.InputWrongType);
    expect(wrongType([0, 0, 0, 0, 0]).message).toMatch(
      /outputs\.gamma must be a Float64Array.*got Array/,
    );
    expect(wrongType(new Float32Array(5)).message).toMatch(/got Float32Array/);
    expect(wrongType(null).code).toBe(ErrorCode.InputWrongType);

    const short = caught(() =>
      blackScholesEvaluateManyInto(columns, { gamma: new Float64Array(4) }),
    );
    expect(short.code).toBe(ErrorCode.InputOutOfRange);
    expect(short.context).toMatchObject({ output: 'gamma', length: 4, rows: 5 });

    const typo = caught(() =>
      blackScholesEvaluateManyInto(columns, { gama: new Float64Array(5) } as never),
    );
    expect(typo.code).toBe(ErrorCode.InputUnknownField);
    expect(typo.message).toMatch(/did you mean "gamma"/);

    expect(caught(() => blackScholesEvaluateManyInto(columns, {})).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      caught(() => blackScholesEvaluateManyInto(columns, { gamma: undefined } as never)).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(caught(() => blackScholesEvaluateManyInto(columns, null as never)).code).toBe(
      ErrorCode.InputWrongType,
    );
  });

  describe('shared memory is refused before anything is written', () => {
    const ROWS = 5;
    function columnsIn(buffer: ArrayBuffer): OptionBatchColumns {
      // spot occupies elements [0, ROWS) of the buffer; everything else is separate storage.
      const spot = new Float64Array(buffer, 0, ROWS);
      spot.set(chain().spot);
      return { ...chain(), spot };
    }

    it('an output EXACTLY aliasing an input column', () => {
      const columns = chain();
      const before = Array.from(columns.spot);
      const error = caught(() => blackScholesEvaluateManyInto(columns, { gamma: columns.spot }));
      expect(error.code).toBe(ErrorCode.InputWrongShape);
      expect(error.message).toMatch(/outputs\.gamma overlaps input column "spot"/);
      expect(Array.from(columns.spot)).toEqual(before);
    });

    it('an output partially overlapping an input column', () => {
      const buffer = new ArrayBuffer((ROWS + 2) * 8);
      const columns = columnsIn(buffer);
      const gamma = new Float64Array(buffer, 16, ROWS);
      expect(caught(() => blackScholesEvaluateManyInto(columns, { gamma })).message).toMatch(
        /overlaps input column "spot"/,
      );
    });

    it('an output overlapping the Int8 type column', () => {
      const buffer = new ArrayBuffer(ROWS * 8);
      const type = new Int8Array(buffer, 0, ROWS);
      type.set(chain().type);
      const gamma = new Float64Array(buffer, 0, ROWS);
      expect(
        caught(() => blackScholesEvaluateManyInto({ ...chain(), type }, { gamma })).message,
      ).toMatch(/overlaps input column "type"/);
    });

    it('the same buffer passed for two outputs, or two overlapping views', () => {
      const shared = sentinel(ROWS);
      const same = caught(() =>
        blackScholesEvaluateManyInto(chain(), { gamma: shared, delta: shared }),
      );
      expect(same.code).toBe(ErrorCode.InputWrongShape);
      expect(same.message).toMatch(/outputs\.gamma and outputs\.delta share memory/);
      expect(Array.from(shared)).toEqual(Array.from(sentinel(ROWS)));

      const buffer = new ArrayBuffer((ROWS + 1) * 8);
      const gamma = new Float64Array(buffer, 0, ROWS);
      const delta = new Float64Array(buffer, 8, ROWS);
      expect(caught(() => blackScholesEvaluateManyInto(chain(), { gamma, delta })).code).toBe(
        ErrorCode.InputWrongShape,
      );
    });

    it('disjoint views of ONE ArrayBuffer are fine', () => {
      const buffer = new ArrayBuffer(3 * ROWS * 8);
      const columns = columnsIn(buffer);
      const gamma = new Float64Array(buffer, ROWS * 8, ROWS);
      const delta = new Float64Array(buffer, 2 * ROWS * 8, ROWS);
      blackScholesEvaluateManyInto(columns, { gamma, delta });
      const want = blackScholesEvaluateMany(chain(), { outputs: ['gamma', 'delta'] });
      expect(Array.from(gamma)).toEqual(Array.from(want.gamma));
      expect(Array.from(delta)).toEqual(Array.from(want.delta));
    });
  });
});

describe('batch validation is a public boundary (decision 8)', () => {
  const both = (columns: unknown) => [
    () => blackScholesEvaluateMany(columns as OptionBatchColumns, { outputs: ['gamma'] }),
    () =>
      blackScholesEvaluateManyInto(columns as OptionBatchColumns, {
        gamma: new Float64Array(16),
      }),
  ];

  it('columns: closed keys, required columns, arrays only, one row count', () => {
    const unknownColumn = { ...chain(), volatilty: new Float64Array(5) };
    for (const run of both(unknownColumn)) {
      const error = caught(run);
      expect(error.code).toBe(ErrorCode.InputUnknownField);
      expect(error.message).toMatch(/did you mean "volatility"/);
    }
    const { strike: _strike, ...missingStrike } = chain();
    for (const run of both(missingStrike)) {
      expect(caught(run).code).toBe(ErrorCode.InputMissingField);
    }
    for (const run of both({ ...chain(), strike: '12345' })) {
      expect(caught(run).code).toBe(ErrorCode.InputWrongType);
    }
    for (const run of both({ ...chain(), strike: new Float64Array(4) })) {
      expect(caught(run).code).toBe(ErrorCode.InputOutOfRange);
    }
    for (const run of both(null)) expect(caught(run).code).toBe(ErrorCode.InputWrongType);
  });

  it('every consumed value, with the row that failed', () => {
    const cases: Array<[keyof OptionBatchColumns, number, string]> = [
      ['spot', 0, ErrorCode.InputOutOfRange],
      ['strike', -1, ErrorCode.InputOutOfRange],
      ['timeToExpiryYears', 0, ErrorCode.InputOutOfRange],
      ['volatility', Number.POSITIVE_INFINITY, ErrorCode.InputOutOfRange],
      ['riskFreeRate', Number.NaN, ErrorCode.InputNotFinite],
      ['dividendYield', Number.NEGATIVE_INFINITY, ErrorCode.InputNotFinite],
    ];
    for (const [field, value, code] of cases) {
      const columns = chain();
      (columns[field] as Float64Array)[3] = value;
      for (const run of both(columns)) {
        const error = caught(run);
        expect(error.code).toBe(code);
        expect(error.context).toMatchObject({ row: 3, field });
      }
    }
    // A plain-array type column can hold NaN, which used to price silently as a put.
    const plainType = { ...chain(), type: [1, -1, Number.NaN, 1, 1] };
    for (const run of both(plainType)) {
      expect(caught(run).context).toMatchObject({ row: 2, field: 'type' });
    }
  });

  it('a non-number in a LATER row is refused before anything is written, by every batch path', () => {
    // Review of #3: the per-row fast path compared values, and comparisons coerce ("100" > 0,
    // true > 0 and 100n > 0 are all true). A plain-array column [100, 100n] passed validation,
    // wrote row 0, then threw an untyped TypeError from the kernel on row 1. Every value must now be
    // a number before the loop runs, and nothing caller-controlled (valueOf) is ever invoked.
    let valueOfCalls = 0;
    const withValueOf = {
      valueOf: () => {
        valueOfCalls++;
        return 100;
      },
    };
    const values: Array<[unknown, string]> = [
      ['100', '"100" (string)'],
      [100n, '100n (bigint)'],
      [true, 'true (boolean)'],
      [null, 'null'],
      [undefined, 'undefined'],
      [withValueOf, 'Object'],
    ];
    const positive = ['spot', 'strike', 'timeToExpiryYears', 'volatility'] as const;
    const finite = ['riskFreeRate', 'dividendYield', 'type'] as const;
    const last = 4;
    for (const field of [...positive, ...finite]) {
      const code = (positive as readonly string[]).includes(field)
        ? ErrorCode.InputOutOfRange
        : ErrorCode.InputNotFinite;
      for (const [value, described] of values) {
        const column: unknown[] = Array.from(chain()[field]!);
        column[last] = value;
        const columns = { ...chain(), [field]: column } as unknown as OptionBatchColumns;
        const gamma = sentinel(5);
        const delta = sentinel(5);
        const out = sentinel(5);
        const runs: Array<[string, () => unknown]> = [
          [
            'blackScholesEvaluateMany',
            () => blackScholesEvaluateMany(columns, { outputs: ['gamma'] }),
          ],
          [
            'blackScholesEvaluateManyInto',
            () => blackScholesEvaluateManyInto(columns, { gamma, delta }),
          ],
          ['blackScholesPriceMany', () => blackScholesPriceMany(columns)],
          ['blackScholesPriceMany', () => blackScholesPriceMany(columns, { greeks: true })],
          ['blackScholesPriceManyInto', () => blackScholesPriceManyInto(columns, out)],
        ];
        for (const [name, run] of runs) {
          const error = caught(run);
          expect(error.code, `${name} ${field} ${described}`).toBe(code);
          expect(error.message).toContain(`${name}: ${field} at row ${last}`);
          expect(error.message).toContain(`got ${described}.`);
          expect(error.context).toEqual({ row: last, field, value: described });
          expect(() => JSON.stringify(error.context)).not.toThrow();
        }
        for (const buffer of [gamma, delta, out]) expect(buffer).toEqual(sentinel(5));
      }
    }
    expect(valueOfCalls).toBe(0);
  });

  it('options and selection: closed, explicit, nonempty, dense, known, duplicate-free', () => {
    const columns = chain();
    const evaluate = (options: unknown) =>
      caught(() => blackScholesEvaluateMany(columns, options as never)).code;
    expect(evaluate(null)).toBe(ErrorCode.InputWrongType);
    expect(evaluate({ outputs: ['gamma'], greeks: true })).toBe(ErrorCode.InputUnknownField);
    expect(evaluate({})).toBe(ErrorCode.InputWrongType);
    expect(evaluate({ outputs: 'gamma' })).toBe(ErrorCode.InputWrongType);
    expect(evaluate({ outputs: [] })).toBe(ErrorCode.InputOutOfRange);
    // eslint-disable-next-line no-sparse-arrays
    expect(evaluate({ outputs: ['gamma', , 'delta'] })).toBe(ErrorCode.InputMissingField);
    expect(evaluate({ outputs: ['gamma', 'lambda'] })).toBe(ErrorCode.InputInvalidEnum);
    expect(evaluate({ outputs: ['gamma', 'gamma'] })).toBe(ErrorCode.InputDuplicateEntry);
    const typo = caught(() => blackScholesEvaluateMany(columns, { outputs: ['gama'] } as never));
    expect(typo.message).toMatch(/gamma/);
  });
});

describe('the existing batch pricers on the shared kernel (decision 9)', () => {
  it('blackScholesPriceMany: price and the five Greeks are bit-identical to the scalar kernels', () => {
    fc.assert(
      fc.property(
        fc.array(row, { minLength: 1, maxLength: 24 }),
        fc.boolean(),
        (rows, withDividends) => {
          const columns = columnsOf(rows, withDividends);
          const result = blackScholesPriceMany(columns, { greeks: true });
          const priceOnly = blackScholesPriceMany(columns);
          expect(Object.keys(result)).toEqual(['price', 'delta', 'gamma', 'theta', 'vega', 'rho']);
          expect(Object.keys(priceOnly)).toEqual(['price']);
          for (let i = 0; i < rows.length; i++) {
            const input = rowInput(columns, i);
            const greeks = blackScholesGreeks(input);
            expect(Object.is(result.price[i], blackScholesPrice(input))).toBe(true);
            expect(Object.is(priceOnly.price[i], result.price[i])).toBe(true);
            expect(Object.is(result.delta![i], greeks.delta)).toBe(true);
            expect(Object.is(result.gamma![i], greeks.gamma)).toBe(true);
            expect(Object.is(result.theta![i], greeks.theta)).toBe(true);
            expect(Object.is(result.vega![i], greeks.vega)).toBe(true);
            expect(Object.is(result.rho![i], greeks.rho)).toBe(true);
          }
        },
      ),
      { numRuns: 200, seed: 20261005 },
    );
  });

  it('blackScholesPriceManyInto keeps exact in-place aliasing of an input column', () => {
    const columns = chain();
    const want = blackScholesPriceMany(chain()).price;
    blackScholesPriceManyInto(columns, columns.strike);
    expect(Array.from(columns.strike)).toEqual(Array.from(want));
  });

  it('CORRECTION: blackScholesPriceManyInto now validates row values before writing (it used to price NaN)', () => {
    const columns = chain();
    columns.volatility[4] = 0;
    const out = sentinel(5);
    const error = caught(() => blackScholesPriceManyInto(columns, out));
    expect(error.code).toBe(ErrorCode.InputOutOfRange);
    expect(error.context).toMatchObject({ row: 4, field: 'volatility' });
    expect(Array.from(out)).toEqual(Array.from(sentinel(5)));
  });

  it('blackScholesPriceManyInto leaves elements past the row count untouched', () => {
    const out = sentinel(7);
    blackScholesPriceManyInto(chain(), out);
    expect(Array.from(out.subarray(0, 5))).toEqual(
      Array.from(blackScholesPriceMany(chain()).price),
    );
    expect(Array.from(out.subarray(5))).toEqual([SENTINEL, SENTINEL]);
  });
});
