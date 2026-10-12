import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ErrorCode, InputError } from '@totalfinance/core';
import {
  convertPriceLevel,
  type ConvertPriceLevelInput,
  type ReferencePriceLevelInput,
} from '../src/price-levels.js';
import { ConvertPriceLevelInputSchema } from '../src/schemas.js';

const ES: ReferencePriceLevelInput = {
  method: 'reference-prices',
  sourcePriceLevel: 6030,
  referenceSourcePrice: 6000,
  referenceTargetPrice: 596,
  sourcePriceUnit: 'ES index points',
  targetPriceUnit: 'USD per SPY share',
};
const RATIO: ConvertPriceLevelInput = {
  method: 'ratio',
  sourcePriceLevel: 20250,
  targetPricePerSourcePrice: 0.025,
  sourcePriceUnit: 'NQ index points',
  targetPriceUnit: 'USD per QQQ share',
};

function reverse(input: ReferencePriceLevelInput, level: number): ReferencePriceLevelInput {
  return {
    method: 'reference-prices',
    sourcePriceLevel: level,
    referenceSourcePrice: input.referenceTargetPrice,
    referenceTargetPrice: input.referenceSourcePrice,
    sourcePriceUnit: input.targetPriceUnit,
    targetPriceUnit: input.sourcePriceUnit,
  };
}

function refused(
  value: unknown,
  code: string,
  boundary: (input: ConvertPriceLevelInput) => unknown,
): void {
  let error: unknown;
  try {
    boundary(value as ConvertPriceLevelInput);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(InputError);
  expect(error).toMatchObject({ code });
  expect((error as InputError).message).toContain('convertPriceLevel');
}

describe('reference-price conversion', () => {
  it('ES/SPY: a 0.5% reference move is 2.98 USD per share, in both directions', () => {
    const target = convertPriceLevel(ES);
    expect(target).toBeCloseTo(598.98, 10);
    expect(target - 596).toBeCloseTo(2.98, 10);
    expect(convertPriceLevel(reverse(ES, 598.98))).toBeCloseTo(6030, 9);
  });

  it('NQ/QQQ: a 1.25% reference move is 6.25 USD per share, with independent references', () => {
    const input: ReferencePriceLevelInput = {
      ...ES,
      sourcePriceLevel: 20250,
      referenceSourcePrice: 20000,
      referenceTargetPrice: 500,
      sourcePriceUnit: 'NQ index points',
      targetPriceUnit: 'USD per QQQ share',
    };
    expect(convertPriceLevel(input)).toBe(506.25);
    expect(convertPriceLevel(reverse(input, 506.25))).toBe(20250);
    expect(convertPriceLevel(RATIO)).toBe(506.25);
    expect(
      convertPriceLevel({
        method: 'ratio',
        sourcePriceLevel: 506.25,
        targetPricePerSourcePrice: 40,
        sourcePriceUnit: 'USD per QQQ share',
        targetPriceUnit: 'NQ index points',
      }),
    ).toBe(20250);
  });

  it('reference identity and zero do not require a representable implicit ratio', () => {
    expect(convertPriceLevel({ ...ES, sourcePriceLevel: 6000 })).toBe(596);
    expect(convertPriceLevel({ ...ES, sourcePriceLevel: 0 })).toBe(0);
    expect(convertPriceLevel({ ...RATIO, sourcePriceLevel: -0 })).toBe(0);
    expect(
      convertPriceLevel({
        ...ES,
        sourcePriceLevel: Number.MIN_VALUE,
        referenceSourcePrice: Number.MIN_VALUE,
        referenceTargetPrice: Number.MAX_VALUE,
      }),
    ).toBe(Number.MAX_VALUE);
    expect(
      convertPriceLevel({
        ...ES,
        sourcePriceLevel: Number.MAX_VALUE,
        referenceSourcePrice: Number.MAX_VALUE,
        referenceTargetPrice: Number.MIN_VALUE,
      }),
    ).toBe(Number.MIN_VALUE);
    expect(
      convertPriceLevel({
        ...ES,
        sourcePriceLevel: 0,
        referenceSourcePrice: Number.MIN_VALUE,
        referenceTargetPrice: Number.MAX_VALUE,
      }),
    ).toBe(0);
  });

  it('property: inverse, homogeneity, joint-reference scaling and ratio parity (relative tolerance 1e-12)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1000 }),
        (level, sourceReference, targetReference, scale) => {
          const input = {
            ...ES,
            sourcePriceLevel: level,
            referenceSourcePrice: sourceReference,
            referenceTargetPrice: targetReference,
          };
          const target = convertPriceLevel(input);
          expect(Math.abs(convertPriceLevel(reverse(input, target)) / level - 1)).toBeLessThan(
            1e-12,
          );
          expect(
            Math.abs(
              convertPriceLevel({ ...input, sourcePriceLevel: level * scale }) / target / scale - 1,
            ),
          ).toBeLessThan(1e-12);
          expect(
            Math.abs(
              convertPriceLevel({
                ...input,
                referenceSourcePrice: sourceReference * scale,
                referenceTargetPrice: targetReference * scale,
              }) /
                target -
                1,
            ),
          ).toBeLessThan(1e-12);
          expect(
            Math.abs(
              convertPriceLevel({
                ...RATIO,
                sourcePriceLevel: level,
                targetPricePerSourcePrice: targetReference / sourceReference,
              }) /
                target -
                1,
            ),
          ).toBeLessThan(1e-12);
        },
      ),
      { seed: 20261012, numRuns: 300 },
    );
  });

  it('explanation copies each method, prices and units, and discloses the approximation', () => {
    for (const input of [ES, RATIO]) {
      const frozen = Object.freeze({ ...input });
      const result = convertPriceLevel.explain(frozen);
      expect(result.value).toBe(convertPriceLevel(input));
      expect(result.assumptions.conversion).toEqual(input);
      expect(result.assumptions.conversion).not.toBe(frozen);
      expect(result.assumptions.resultUnit).toBe(input.targetPriceUnit);
      expect(result.assumptions.ratioDirection).toBe('target-price-per-source-price');
      expect(result.assumptions.mappingAssumption).toContain('remains valid');
      expect(result.diagnostics.warnings[0]).toMatchObject({
        code: 'model.limitation',
        severity: 'info',
      });
      for (const limit of [
        'live quote',
        'predicted ETF open',
        'arbitrage/fair-value',
        'option premium',
        'notional/delta hedge',
      ]) {
        expect(result.diagnostics.warnings[0]?.message).toContain(limit);
      }
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(frozen).toEqual(input);
    }
  });
});

describe.each([
  ['plain', convertPriceLevel],
  ['explain', convertPriceLevel.explain],
] as const)('%s boundary', (_name, boundary) => {
  it.each([undefined, null, 1, '6030', [], new Float64Array(1), true, () => 1])(
    'refuses a malformed input container %s',
    (value) => {
      refused(value, ErrorCode.InputWrongType, boundary);
    },
  );

  for (const input of [ES, RATIO]) {
    it(`teaches a corrected ${input.method} call without switching methods`, () => {
      const numericField =
        input.method === 'ratio' ? 'targetPricePerSourcePrice' : 'referenceSourcePrice';
      const invalidFields: Record<string, unknown[]> = {
        [numericField]: [undefined, 0],
        sourcePriceUnit: [1, ' '],
        targetPriceUnit: [1, ' '],
      };
      for (const [field, values] of Object.entries(invalidFields)) {
        for (const value of values) {
          let error: unknown;
          try {
            boundary({ ...input, [field]: value } as ConvertPriceLevelInput);
          } catch (caught) {
            error = caught;
          }
          expect(error).toBeInstanceOf(InputError);
          const example = (error as InputError).message.split('e.g. ')[1];
          expect(example).toContain(`method: '${input.method}'`);
          expect(example).toContain(numericField);
          expect(example).not.toContain(
            input.method === 'ratio' ? 'referenceSourcePrice' : 'targetPricePerSourcePrice',
          );
        }
      }
    });

    it(`validates every required field for ${input.method}`, () => {
      for (const field of Object.keys(input)) {
        const omitted: Record<string, unknown> = { ...input };
        delete omitted[field];
        if (field === 'sourcePriceUnit' || field === 'targetPriceUnit') {
          expect(boundary(omitted as unknown as ConvertPriceLevelInput)).toBeDefined();
          expect(boundary({ ...input, [field]: undefined })).toBeDefined();
        } else {
          refused(omitted, ErrorCode.InputMissingField, boundary);
          refused({ ...input, [field]: undefined }, ErrorCode.InputMissingField, boundary);
        }
        for (const wrong of [null, {}, [], true])
          refused({ ...input, [field]: wrong }, ErrorCode.InputWrongType, boundary);
      }
      for (const [field, value] of Object.entries(input)) {
        if (typeof value === 'number') {
          refused({ ...input, [field]: '1' }, ErrorCode.InputWrongType, boundary);
          for (const nonfinite of [NaN, Infinity, -Infinity])
            refused(
              { ...input, [field]: nonfinite },
              Number.isNaN(nonfinite) ? ErrorCode.InputNaN : ErrorCode.InputNotFinite,
              boundary,
            );
          refused({ ...input, [field]: -1 }, ErrorCode.InputOutOfRange, boundary);
          if (field !== 'sourcePriceLevel')
            refused({ ...input, [field]: 0 }, ErrorCode.InputOutOfRange, boundary);
        }
      }
    });
  }

  it('refuses unknown keys, mixed methods, invalid enums and blank units; corrected call succeeds', () => {
    for (const invalid of [
      { ...ES, ratio: 0.1 },
      { ...ES, targetPricePerSourcePrice: 0.1 },
      { ...ES, targetPricePerSourcePrice: undefined },
      { ...RATIO, referenceSourcePrice: 20000 },
      { ...RATIO, referenceTargetPrice: undefined },
      { ...ES, sourcePriceLevell: 6030 },
    ])
      refused(invalid, ErrorCode.InputUnknownField, boundary);
    for (const method of ['', 'auto', 'inverse', 'references'])
      refused({ ...ES, method }, ErrorCode.InputInvalidEnum, boundary);
    for (const unit of ['', ' \n\t', '\u00a0']) {
      for (const field of ['sourcePriceUnit', 'targetPriceUnit'])
        refused({ ...ES, [field]: unit }, ErrorCode.InputOutOfRange, boundary);
    }
    expect(boundary(ES)).toBeDefined();
  });

  it('refuses true output overflow and positive underflow, including reference mode', () => {
    refused(
      { ...RATIO, sourcePriceLevel: Number.MAX_VALUE, targetPricePerSourcePrice: 2 },
      ErrorCode.InputOutOfRange,
      boundary,
    );
    refused(
      { ...RATIO, sourcePriceLevel: Number.MIN_VALUE, targetPricePerSourcePrice: 0.25 },
      ErrorCode.InputOutOfRange,
      boundary,
    );
    refused(
      {
        ...ES,
        sourcePriceLevel: Number.MAX_VALUE,
        referenceSourcePrice: 1,
        referenceTargetPrice: 2,
      },
      ErrorCode.InputOutOfRange,
      boundary,
    );
    refused(
      {
        ...ES,
        sourcePriceLevel: Number.MIN_VALUE,
        referenceSourcePrice: 4,
        referenceTargetPrice: 1,
      },
      ErrorCode.InputOutOfRange,
      boundary,
    );
  });
});

describe('numeric range and schemas', () => {
  it('exact binary-power oracle spans normal, subnormal, overflow and underflow regimes', () => {
    const powers = [-1074, -1022, -600, -1, 0, 1, 600, 1023];
    for (const sourceExponent of powers)
      for (const targetExponent of powers)
        for (const referenceExponent of powers) {
          const input = {
            ...ES,
            sourcePriceLevel: 2 ** sourceExponent,
            referenceTargetPrice: 2 ** targetExponent,
            referenceSourcePrice: 2 ** referenceExponent,
          };
          const resultExponent = sourceExponent + targetExponent - referenceExponent;
          if (resultExponent < -1074 || resultExponent > 1023) {
            expect(() => convertPriceLevel(input)).toThrow(InputError);
          } else {
            expect(convertPriceLevel(input)).toBe(2 ** resultExponent);
          }
        }
  });

  it('recovers representable results despite intermediate product, quotient and ratio range limits', () => {
    const cases = [
      [1e308, 1e300, 1e307, 1e301],
      [1e200, 2e-200, 1e-200, 2e200],
      [2e-300, 1e300, 1e-300, 2e300],
      [1e300, 1e-300, 2e300, 5e-301],
      [1e-300, 1e-300, 2e-300, 5e-301],
    ];
    for (const [level, target, source, expected] of cases) {
      const result = convertPriceLevel({
        ...ES,
        sourcePriceLevel: level!,
        referenceTargetPrice: target!,
        referenceSourcePrice: source!,
      });
      expect(Math.abs(result / expected! - 1)).toBeLessThan(1e-12);
    }
    expect(
      convertPriceLevel({
        ...ES,
        sourcePriceLevel: 1.5,
        referenceTargetPrice: Number.MIN_VALUE,
        referenceSourcePrice: 1,
      }),
    ).toBe(2 * Number.MIN_VALUE);
    expect(
      convertPriceLevel({
        ...ES,
        sourcePriceLevel: 0.75,
        referenceTargetPrice: Number.MIN_VALUE,
        referenceSourcePrice: 1,
      }),
    ).toBe(Number.MIN_VALUE);
  });

  it('schema selects closed method arms, validates units and produces honest JSON Schema', () => {
    for (const input of [ES, RATIO])
      expect(ConvertPriceLevelInputSchema.parse(input)).toEqual(input);
    for (const bad of [
      { ...ES, targetPricePerSourcePrice: 1 },
      { ...RATIO, referenceSourcePrice: 1 },
      { ...ES, referenceSourcePrice: 0 },
      { ...ES, referenceTargetPrice: NaN },
      { ...RATIO, targetPricePerSourcePrice: Infinity },
      { ...ES, targetPriceUnit: ' ' },
      {},
      null,
    ]) {
      expect(ConvertPriceLevelInputSchema.safeParse(bad).success).toBe(false);
    }
    const json = ConvertPriceLevelInputSchema.toJSONSchema();
    expect(json.anyOf).toHaveLength(2);
    for (const arm of json.anyOf ?? []) expect(arm.additionalProperties).toBe(false);
    expect(JSON.stringify(json)).toContain('target price units per ONE source price unit');
  });
});
