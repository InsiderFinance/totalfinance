/**
 * Law 12 for the statistics options objects (spec 3B.1b, `math/statistics` cluster + the
 * review-correction wave on `52f4e422e`).
 *
 * Every public reduction here takes a small closed options object. The original defects: a
 * misspelled key was silently ignored (`{ nanPolcy: 'omit' }` left `propagate` semantics on), and a
 * wrong-typed `nanPolicy` fell through `prepare`'s branch chain into `throw` semantics — silent
 * behavioural changes with no error at any layer. The review then found two more of the same
 * species in the FIX itself: the rolling family accepted a `nanPolicy` it documents it does not
 * have (accepted-and-ignored — the H03 class), and `null` was blessed as omission on fields whose
 * generated contract says `nullable: false`.
 *
 * The corrected contract, asserted here with the EXACT code each mistake owns:
 *
 *     unknown key           input.unknown_field   misspelled or not part of THIS declaration
 *     bad enum value/null   input.invalid_enum    not one of the declared policies
 *     wrong primitive/null  input.wrong_type      a string/number/null where a boolean/number goes
 *     NaN                   input.nan             the upstream computation already failed
 *     ±Infinity             input.not_finite      the upstream computation overflowed
 *     non-object options    input.wrong_type      a scalar where the options object goes
 *     tail fraction > 1     input.out_of_range    winsorize teaches its OWN field, not quantile's p
 *
 * `undefined` remains omission (C06). `null` is rejected because the declarations are
 * non-nullable and the runtime contract matches the declaration.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import {
  correlation,
  covariance,
  covarianceMatrix,
  kurtosis,
  max,
  mean,
  median,
  medianAbsoluteDeviation,
  min,
  quantile,
  rollingCovariance,
  rollingStandardDeviation,
  skewness,
  standardDeviation,
  sum,
  trimmedMean,
  variance,
  welfordVariance,
  winsorize,
} from '@totalfinance/math';

const xs = [3, 1, 4, 1, 5, 9, 2, 6];
const ys = [2, 7, 1, 8, 2, 8, 1, 8];

type Boundary = readonly [name: string, call: (options: unknown) => unknown];

/** The 16 boundaries whose contract includes `nanPolicy`. */
const NAN_POLICY_BOUNDARIES: readonly Boundary[] = [
  ['sum', (o) => sum(xs, o as never)],
  ['mean', (o) => mean(xs, o as never)],
  ['min', (o) => min(xs, o as never)],
  ['max', (o) => max(xs, o as never)],
  ['variance', (o) => variance(xs, o as never)],
  ['standardDeviation', (o) => standardDeviation(xs, o as never)],
  ['welfordVariance', (o) => welfordVariance(xs, o as never)],
  ['median', (o) => median(xs, o as never)],
  ['quantile', (o) => quantile(xs, 0.5, o as never)],
  ['skewness', (o) => skewness(xs, o as never)],
  ['kurtosis', (o) => kurtosis(xs, o as never)],
  ['medianAbsoluteDeviation', (o) => medianAbsoluteDeviation(xs, o as never)],
  ['winsorize', (o) => winsorize(xs, o as never)],
  ['trimmedMean', (o) => trimmedMean(xs, o as never)],
  ['covariance', (o) => covariance(xs, ys, o as never)],
  ['correlation', (o) => correlation(xs, ys, o as never)],
] as const;

/**
 * The 3 boundaries whose contract is `population` ONLY. The rolling family documents that it never
 * takes a `nanPolicy` (a per-window `omit` would have an ambiguous width), and `covarianceMatrix`
 * never declared one — so there the field is an UNKNOWN key, not an accepted no-op.
 */
const POPULATION_ONLY_BOUNDARIES: readonly Boundary[] = [
  ['rollingStandardDeviation', (o) => rollingStandardDeviation(xs, 3, o as never)],
  ['rollingCovariance', (o) => rollingCovariance(xs, ys, 3, o as never)],
  ['covarianceMatrix', (o) => covarianceMatrix([xs, ys], o as never)],
] as const;

const ALL_BOUNDARIES: readonly Boundary[] = [
  ...NAN_POLICY_BOUNDARIES,
  ...POPULATION_ONLY_BOUNDARIES,
];

/** Every boundary whose contract includes `population`. */
const POPULATION_BOUNDARIES: readonly Boundary[] = [
  ...POPULATION_ONLY_BOUNDARIES,
  ['variance', (o) => variance(xs, o as never)],
  ['standardDeviation', (o) => standardDeviation(xs, o as never)],
  ['welfordVariance', (o) => welfordVariance(xs, o as never)],
  ['covariance', (o) => covariance(xs, ys, o as never)],
] as const;

/** The thrown error's stable code, or a marker naming what came back instead. */
function outcome(call: Boundary[1], options: unknown): string {
  try {
    return `NO THROW — returned ${JSON.stringify(call(options))}`;
  } catch (error) {
    return isQuantError(error) ? error.code : `untyped ${(error as Error).constructor.name}`;
  }
}

/** Offender-list sweep: one assertion, every violator named (3B.1a suite convention). */
function sweep(boundaries: readonly Boundary[], options: unknown, expectedCode: string): string[] {
  const violations: string[] = [];
  for (const [name, call] of boundaries) {
    const got = outcome(call, options);
    if (got !== expectedCode) violations.push(`${name}: ${got}`);
  }
  return violations;
}

describe('statistics options are closed requests (Law 12)', () => {
  it('every boundary rejects a misspelled key with input.unknown_field', () => {
    expect(sweep(ALL_BOUNDARIES, { nanPolcy: 'omit' }, ErrorCode.InputUnknownField)).toEqual([]);
  });

  it('the unknown-key error names the function, the key, a did-you-mean, and the allowed list', () => {
    try {
      mean(xs, { nanPolcy: 'omit' } as never);
      expect.unreachable('mean accepted a misspelled key');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputUnknownField)) throw error;
      expect(error.message).toContain('mean: unknown field "nanPolcy"');
      expect(error.message).toContain('did you mean "nanPolicy"');
      expect(error.message).toContain('Allowed fields: nanPolicy');
      expect(error.context).toMatchObject({
        function: 'mean',
        key: 'nanPolcy',
        suggestion: 'nanPolicy',
      });
    }
  });

  it('an undeclared extra key beside valid fields still rejects', () => {
    expect(
      sweep(
        NAN_POLICY_BOUNDARIES,
        { nanPolicy: 'omit', weights: [1] },
        ErrorCode.InputUnknownField,
      ),
    ).toEqual([]);
  });

  it('a non-object options argument rejects with input.wrong_type', () => {
    expect(sweep(ALL_BOUNDARIES, 42, ErrorCode.InputWrongType)).toEqual([]);
    expect(sweep(ALL_BOUNDARIES, ['omit'], ErrorCode.InputWrongType)).toEqual([]);
    expect(sweep(ALL_BOUNDARIES, null, ErrorCode.InputWrongType)).toEqual([]);
  });
});

describe('the rolling family and covarianceMatrix declare population ONLY', () => {
  it('nanPolicy is an UNKNOWN field there — never an accepted no-op', () => {
    // The first fix accepted-and-validated `nanPolicy` on the rolling functions and then ignored
    // it: `{ nanPolicy: 'throw' }` did not throw on NaN and `{ nanPolicy: 'omit' }` did not omit.
    // Accepted-but-ignored is the exact defect class Law 12 exists to prevent (compare H03).
    expect(
      sweep(POPULATION_ONLY_BOUNDARIES, { nanPolicy: 'omit' }, ErrorCode.InputUnknownField),
    ).toEqual([]);
  });

  it('the rejection names the boundary the user called and its real contract', () => {
    try {
      rollingStandardDeviation(xs, 3, { nanPolicy: 'throw' } as never);
      expect.unreachable('rollingStandardDeviation accepted nanPolicy');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputUnknownField)) throw error;
      expect(error.message).toContain('rollingStandardDeviation: unknown field "nanPolicy"');
      expect(error.message).toContain('Allowed fields: population');
    }
    try {
      covarianceMatrix([xs, ys], { nanPolicy: 'omit' } as never);
      expect.unreachable('covarianceMatrix accepted nanPolicy');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputUnknownField)) throw error;
      expect(error.message).toContain('covarianceMatrix: unknown field "nanPolicy"');
    }
  });

  it('population still works and the matrix agrees with pairwise covariance', () => {
    expect(rollingStandardDeviation(xs, 3, { population: true })).toHaveLength(xs.length);
    expect(rollingCovariance(xs, ys, 3, { population: true })).toHaveLength(xs.length);
    expect(covarianceMatrix([xs, ys], { population: true })[0]![1]).toBeCloseTo(
      covariance(xs, ys, { population: true }),
      12,
    );
    expect(covarianceMatrix([xs, ys])[0]![0]).toBeCloseTo(variance(xs), 12);
  });
});

describe('nanPolicy is a validated enum', () => {
  it('a wrong-typed nanPolicy rejects with input.invalid_enum everywhere it exists', () => {
    expect(sweep(NAN_POLICY_BOUNDARIES, { nanPolicy: 123 }, ErrorCode.InputInvalidEnum)).toEqual(
      [],
    );
  });

  it('a near-miss string value rejects with input.invalid_enum everywhere', () => {
    expect(
      sweep(NAN_POLICY_BOUNDARIES, { nanPolicy: 'omitt' }, ErrorCode.InputInvalidEnum),
    ).toEqual([]);
  });

  it('the enum error names the field path, the allowed values, and the received value', () => {
    try {
      mean(xs, { nanPolicy: 123 } as never);
      expect.unreachable('mean accepted a numeric nanPolicy');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputInvalidEnum)) throw error;
      expect(error.message).toContain(
        'mean: options.nanPolicy must be one of propagate, omit, throw',
      );
      expect(error.message).toContain('123');
      expect(error.context).toMatchObject({ field: 'options.nanPolicy', function: 'mean' });
    }
  });

  it('a wrong-typed nanPolicy no longer silently selects throw semantics', () => {
    // Pre-fix, `prepare` fell through its branch chain: any unrecognized policy BEHAVED as
    // 'throw'. The mistake now teaches instead of silently changing NaN handling.
    expect(outcome((o) => mean([1, NaN, 3], o as never), { nanPolicy: 123 })).toBe(
      ErrorCode.InputInvalidEnum,
    );
  });
});

describe('null is not omission (the declarations are non-nullable)', () => {
  it('undefined remains omission (C06): propagate stays the default', () => {
    expect(mean([1, NaN, 3], { nanPolicy: undefined as never })).toBeNaN();
    expect(mean([1, NaN, 3], { nanPolicy: 'omit' })).toBe(2);
  });

  it('null nanPolicy rejects with input.invalid_enum everywhere it exists', () => {
    expect(sweep(NAN_POLICY_BOUNDARIES, { nanPolicy: null }, ErrorCode.InputInvalidEnum)).toEqual(
      [],
    );
  });

  it('null population rejects with input.wrong_type everywhere it exists', () => {
    expect(sweep(POPULATION_BOUNDARIES, { population: null }, ErrorCode.InputWrongType)).toEqual(
      [],
    );
  });

  it('null numeric fields reject with input.wrong_type', () => {
    expect(outcome((o) => winsorize(xs, o as never), { lower: null })).toBe(
      ErrorCode.InputWrongType,
    );
    expect(outcome((o) => trimmedMean(xs, o as never), { fraction: null })).toBe(
      ErrorCode.InputWrongType,
    );
  });
});

describe('declared optional fields validate their primitive type', () => {
  it('a wrong-typed population rejects with input.wrong_type across every population boundary', () => {
    expect(sweep(POPULATION_BOUNDARIES, { population: 'yes' }, ErrorCode.InputWrongType)).toEqual(
      [],
    );
  });

  it('kurtosis excess and medianAbsoluteDeviation scale reject wrong-typed booleans', () => {
    expect(outcome((o) => kurtosis(xs, o as never), { excess: 1 })).toBe(ErrorCode.InputWrongType);
    expect(outcome((o) => medianAbsoluteDeviation(xs, o as never), { scale: 'no' })).toBe(
      ErrorCode.InputWrongType,
    );
  });

  it('winsorize and trimmedMean numeric fields run the full finite ladder', () => {
    const w = (o: unknown): unknown => winsorize(xs, o as never);
    const t = (o: unknown): unknown => trimmedMean(xs, o as never);
    expect(outcome(w, { lower: '0.05' })).toBe(ErrorCode.InputWrongType);
    expect(outcome(w, { upper: NaN })).toBe(ErrorCode.InputNaN);
    expect(outcome(t, { fraction: Infinity })).toBe(ErrorCode.InputNotFinite);
  });

  it('a winsorize tail fraction outside [0, 1] teaches on ITS field, not on quantile p', () => {
    // Previously `{ lower: 5 }` surfaced as "quantile: p is a fraction in [0, 1]" — the right
    // rejection under the wrong function and field name.
    try {
      winsorize(xs, { lower: 5 });
      expect.unreachable('winsorize accepted a tail fraction of 5');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputOutOfRange)) throw error;
      expect(error.message).toContain('winsorize: options.lower is a tail fraction in [0, 1]');
      expect(error.message).toContain('did you mean 0.05?');
    }
    // The percentage hint appears only when the division would land in range — no false teaching.
    expect(outcome((o) => winsorize(xs, o as never), { upper: -0.2 })).toBe(
      ErrorCode.InputOutOfRange,
    );
  });

  it('winsorize rejects overlapping tails even when each is individually valid', () => {
    // { lower: 0.8, upper: 0.8 } clipped [1..5] into [4.2, 4.2, 4.2, 4.2, 1.8] — the clip bounds
    // cross and every value lands in an inverted range, a plausible-looking wrong answer.
    try {
      winsorize(xs, { lower: 0.8, upper: 0.8 });
      expect.unreachable('winsorize accepted overlapping tails');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputOutOfRange)) throw error;
      expect(error.message).toContain('options.lower + options.upper must be <= 1');
      expect(error.message).toContain('0.8 + 0.8');
    }
    // The boundary itself is legal: complementary tails exactly partition the sample.
    expect(winsorize(xs, { lower: 0.5, upper: 0.5 })).toHaveLength(xs.length);
  });

  it('trimmedMean rejects fractions outside [0, 0.5] instead of silently answering differently', () => {
    // A negative trim silently became an ordinary mean; > 0.5 silently became the median — two
    // plausible answers to a question the caller did not ask.
    expect(outcome((o) => trimmedMean(xs, o as never), { fraction: -0.1 })).toBe(
      ErrorCode.InputOutOfRange,
    );
    try {
      trimmedMean(xs, { fraction: 0.6 });
      expect.unreachable('trimmedMean accepted a fraction above 0.5');
    } catch (error) {
      if (!isQuantError(error, ErrorCode.InputOutOfRange)) throw error;
      expect(error.message).toContain('trimmedMean: options.fraction');
      expect(error.message).toContain('[0, 0.5]');
    }
    // The domain edges stay meaningful: 0 is the plain mean, 0.5 is the documented median.
    expect(trimmedMean(xs, { fraction: 0 })).toBe(mean(xs));
    expect(trimmedMean(xs, { fraction: 0.5 })).toBe(median(xs));
  });
});

describe('valid calls are untouched', () => {
  it('full valid options objects still compute the same answers', () => {
    expect(mean(xs, { nanPolicy: 'propagate' })).toBeCloseTo(3.875, 12);
    expect(variance(xs, { nanPolicy: 'omit', population: true })).toBeCloseTo(
      variance(xs, { population: true }),
      12,
    );
    expect(kurtosis(xs, { excess: false })).toBeCloseTo(kurtosis(xs) + 3, 12);
    expect(medianAbsoluteDeviation(xs, { scale: false })).toBeCloseTo(
      medianAbsoluteDeviation(xs) / 1.4826,
      12,
    );
    expect(winsorize(xs, { lower: 0.1, upper: 0.1 })).toHaveLength(xs.length);
    expect(quantile(xs, 0.5, { nanPolicy: 'throw' })).toBe(median(xs));
    expect(correlation(xs, ys, { nanPolicy: 'omit' })).toBeCloseTo(correlation(xs, ys), 12);
  });

  it('trimmedMean matches an independently derived expected value', () => {
    // xs sorted: [1, 1, 2, 3, 4, 5, 6, 9]; fraction 0.25 of n=8 drops k=2 from each tail,
    // leaving [2, 3, 4, 5] whose mean is 3.5. (The previous assertion compared the call with
    // itself and could not fail.)
    expect(trimmedMean(xs, { fraction: 0.25 })).toBe(3.5);
    // fraction large enough that 2k >= n falls back to the median: k=3, 2k=6 < 8 keeps [3, 4];
    // at 0.5, k=4 and 2k=8 >= 8 → median of the sorted data = (3+4)/2.
    expect(trimmedMean(xs, { fraction: 0.5 })).toBe(3.5);
  });
});
