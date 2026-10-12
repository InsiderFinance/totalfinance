import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError, type Computed } from '@totalfinance/core';
import * as levels from '../src/price-levels.js';
import * as schemas from '../src/schemas.js';

const cases = [
  {
    name: 'esToSpyLevel',
    call: levels.esToSpyLevel,
    schema: schemas.EsToSpyLevelInputSchema,
    input: { esPriceLevel: 6030, referenceEsPrice: 6000, referenceSpyPrice: 596 },
    levelField: 'esPriceLevel',
    sourceField: 'referenceEsPrice',
    targetField: 'referenceSpyPrice',
    expected: 598.98,
    sourceUnit: 'ES index points',
    targetUnit: 'USD per SPY share',
  },
  {
    name: 'spyToEsLevel',
    call: levels.spyToEsLevel,
    schema: schemas.SpyToEsLevelInputSchema,
    input: { spyPriceLevel: 598.98, referenceSpyPrice: 596, referenceEsPrice: 6000 },
    levelField: 'spyPriceLevel',
    sourceField: 'referenceSpyPrice',
    targetField: 'referenceEsPrice',
    expected: 6030,
    sourceUnit: 'USD per SPY share',
    targetUnit: 'ES index points',
  },
  {
    name: 'nqToQqqLevel',
    call: levels.nqToQqqLevel,
    schema: schemas.NqToQqqLevelInputSchema,
    input: { nqPriceLevel: 20250, referenceNqPrice: 20000, referenceQqqPrice: 500 },
    levelField: 'nqPriceLevel',
    sourceField: 'referenceNqPrice',
    targetField: 'referenceQqqPrice',
    expected: 506.25,
    sourceUnit: 'NQ index points',
    targetUnit: 'USD per QQQ share',
  },
  {
    name: 'qqqToNqLevel',
    call: levels.qqqToNqLevel,
    schema: schemas.QqqToNqLevelInputSchema,
    input: { qqqPriceLevel: 506.25, referenceQqqPrice: 500, referenceNqPrice: 20000 },
    levelField: 'qqqPriceLevel',
    sourceField: 'referenceQqqPrice',
    targetField: 'referenceNqPrice',
    expected: 20250,
    sourceUnit: 'USD per QQQ share',
    targetUnit: 'NQ index points',
  },
  {
    name: 'ymToDiaLevel',
    call: levels.ymToDiaLevel,
    schema: schemas.YmToDiaLevelInputSchema,
    input: { ymPriceLevel: 40400, referenceYmPrice: 40000, referenceDiaPrice: 398 },
    levelField: 'ymPriceLevel',
    sourceField: 'referenceYmPrice',
    targetField: 'referenceDiaPrice',
    expected: 401.98,
    sourceUnit: 'YM index points',
    targetUnit: 'USD per DIA share',
  },
  {
    name: 'diaToYmLevel',
    call: levels.diaToYmLevel,
    schema: schemas.DiaToYmLevelInputSchema,
    input: { diaPriceLevel: 401.98, referenceDiaPrice: 398, referenceYmPrice: 40000 },
    levelField: 'diaPriceLevel',
    sourceField: 'referenceDiaPrice',
    targetField: 'referenceYmPrice',
    expected: 40400,
    sourceUnit: 'USD per DIA share',
    targetUnit: 'YM index points',
  },
  {
    name: 'rtyToIwmLevel',
    call: levels.rtyToIwmLevel,
    schema: schemas.RtyToIwmLevelInputSchema,
    input: { rtyPriceLevel: 2020, referenceRtyPrice: 2000, referenceIwmPrice: 198 },
    levelField: 'rtyPriceLevel',
    sourceField: 'referenceRtyPrice',
    targetField: 'referenceIwmPrice',
    expected: 199.98,
    sourceUnit: 'RTY index points',
    targetUnit: 'USD per IWM share',
  },
  {
    name: 'iwmToRtyLevel',
    call: levels.iwmToRtyLevel,
    schema: schemas.IwmToRtyLevelInputSchema,
    input: { iwmPriceLevel: 199.98, referenceIwmPrice: 198, referenceRtyPrice: 2000 },
    levelField: 'iwmPriceLevel',
    sourceField: 'referenceIwmPrice',
    targetField: 'referenceRtyPrice',
    expected: 2020,
    sourceUnit: 'USD per IWM share',
    targetUnit: 'RTY index points',
  },
  {
    name: 'spxToSpyLevel',
    call: levels.spxToSpyLevel,
    schema: schemas.SpxToSpyLevelInputSchema,
    input: { spxPriceLevel: 6030, referenceSpxPrice: 6000, referenceSpyPrice: 596 },
    levelField: 'spxPriceLevel',
    sourceField: 'referenceSpxPrice',
    targetField: 'referenceSpyPrice',
    expected: 598.98,
    sourceUnit: 'SPX index points',
    targetUnit: 'USD per SPY share',
  },
  {
    name: 'spyToSpxLevel',
    call: levels.spyToSpxLevel,
    schema: schemas.SpyToSpxLevelInputSchema,
    input: { spyPriceLevel: 598.98, referenceSpyPrice: 596, referenceSpxPrice: 6000 },
    levelField: 'spyPriceLevel',
    sourceField: 'referenceSpyPrice',
    targetField: 'referenceSpxPrice',
    expected: 6030,
    sourceUnit: 'USD per SPY share',
    targetUnit: 'SPX index points',
  },
  {
    name: 'ndxToQqqLevel',
    call: levels.ndxToQqqLevel,
    schema: schemas.NdxToQqqLevelInputSchema,
    input: { ndxPriceLevel: 20250, referenceNdxPrice: 20000, referenceQqqPrice: 500 },
    levelField: 'ndxPriceLevel',
    sourceField: 'referenceNdxPrice',
    targetField: 'referenceQqqPrice',
    expected: 506.25,
    sourceUnit: 'NDX index points',
    targetUnit: 'USD per QQQ share',
  },
  {
    name: 'qqqToNdxLevel',
    call: levels.qqqToNdxLevel,
    schema: schemas.QqqToNdxLevelInputSchema,
    input: { qqqPriceLevel: 506.25, referenceQqqPrice: 500, referenceNdxPrice: 20000 },
    levelField: 'qqqPriceLevel',
    sourceField: 'referenceQqqPrice',
    targetField: 'referenceNdxPrice',
    expected: 20250,
    sourceUnit: 'USD per QQQ share',
    targetUnit: 'NDX index points',
  },
  {
    name: 'rutToIwmLevel',
    call: levels.rutToIwmLevel,
    schema: schemas.RutToIwmLevelInputSchema,
    input: { rutPriceLevel: 2020, referenceRutPrice: 2000, referenceIwmPrice: 198 },
    levelField: 'rutPriceLevel',
    sourceField: 'referenceRutPrice',
    targetField: 'referenceIwmPrice',
    expected: 199.98,
    sourceUnit: 'RUT index points',
    targetUnit: 'USD per IWM share',
  },
  {
    name: 'iwmToRutLevel',
    call: levels.iwmToRutLevel,
    schema: schemas.IwmToRutLevelInputSchema,
    input: { iwmPriceLevel: 199.98, referenceIwmPrice: 198, referenceRutPrice: 2000 },
    levelField: 'iwmPriceLevel',
    sourceField: 'referenceIwmPrice',
    targetField: 'referenceRutPrice',
    expected: 2020,
    sourceUnit: 'USD per IWM share',
    targetUnit: 'RUT index points',
  },
  {
    name: 'djiaToDiaLevel',
    call: levels.djiaToDiaLevel,
    schema: schemas.DjiaToDiaLevelInputSchema,
    input: { djiaPriceLevel: 40400, referenceDjiaPrice: 40000, referenceDiaPrice: 398 },
    levelField: 'djiaPriceLevel',
    sourceField: 'referenceDjiaPrice',
    targetField: 'referenceDiaPrice',
    expected: 401.98,
    sourceUnit: 'DJIA index points (full Dow Jones Industrial Average)',
    targetUnit: 'USD per DIA share',
  },
  {
    name: 'diaToDjiaLevel',
    call: levels.diaToDjiaLevel,
    schema: schemas.DiaToDjiaLevelInputSchema,
    input: { diaPriceLevel: 401.98, referenceDiaPrice: 398, referenceDjiaPrice: 40000 },
    levelField: 'diaPriceLevel',
    sourceField: 'referenceDiaPrice',
    targetField: 'referenceDjiaPrice',
    expected: 40400,
    sourceUnit: 'USD per DIA share',
    targetUnit: 'DJIA index points (full Dow Jones Industrial Average)',
  },
] as const;

type Request = Record<string, number>;
type Call = ((input: Request) => number) & {
  explain: (
    input: Request,
  ) => Computed<number, levels.NamedPriceLevelConversionAssumptions<Request>>;
};

describe.each(cases)('$name', (testCase) => {
  // Deliberately erase the shape only inside runtime-misuse tests. Packed consumers check each
  // exact public declaration with correctly named calls and @ts-expect-error misuse.
  const call = testCase.call as unknown as Call;
  const request: Request = { ...testCase.input };
  const { name, levelField, sourceField, targetField, sourceUnit, targetUnit } = testCase;
  const withPrices = (level: number, source: number, target: number): Request => ({
    [levelField]: level,
    [sourceField]: source,
    [targetField]: target,
  });

  it('matches an independent worked result, the generic primitive and its named inverse', () => {
    expect(call(request)).toBeCloseTo(testCase.expected, 9);
    expect(call(request)).toBe(
      levels.convertPriceLevel({
        method: 'reference-prices',
        sourcePriceLevel: request[levelField]!,
        referenceSourcePrice: request[sourceField]!,
        referenceTargetPrice: request[targetField]!,
      }),
    );
    const index = cases.findIndex((row) => row.name === name);
    const inverse = cases[index % 2 === 0 ? index + 1 : index - 1]!;
    const reverse = inverse.call as unknown as Call;
    expect(
      reverse({
        [inverse.levelField]: call(request),
        [inverse.sourceField]: request[targetField]!,
        [inverse.targetField]: request[sourceField]!,
      }),
    ).toBeCloseTo(request[levelField]!, 8);
  });

  it('discloses named and canonical inputs, fixed labels and limitations without mutating input', () => {
    const frozen = Object.freeze({ ...request });
    const result = call.explain(frozen);
    expect(result.value).toBe(call(request));
    expect(result.assumptions.input).toEqual(request);
    expect(result.assumptions.input).not.toBe(frozen);
    expect(result.assumptions.resultUnit).toBe(targetUnit);
    expect(result.assumptions.conversion).toEqual({
      method: 'reference-prices',
      sourcePriceLevel: request[levelField],
      referenceSourcePrice: request[sourceField],
      referenceTargetPrice: request[targetField],
      sourcePriceUnit: sourceUnit,
      targetPriceUnit: targetUnit,
    });
    expect(result.diagnostics.method).toBe('reference-prices');
    expect(result.diagnostics.warnings[0]).toMatchObject({ code: 'model.limitation' });
    expect(result.assumptions.mappingAssumption).toContain('remains valid');
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(frozen).toEqual(request);
  });

  it('has a closed, honest schema for exactly three required named prices', () => {
    expect(testCase.schema.parse(request)).toEqual(request);
    const json = testCase.schema.toJSONSchema();
    expect(json.required?.slice().sort()).toEqual(Object.keys(request).sort());
    expect(json.additionalProperties).toBe(false);
    for (const field of Object.keys(request)) {
      const missing = { ...request };
      delete missing[field];
      expect(testCase.schema.safeParse(missing).success).toBe(false);
      for (const value of [undefined, null, '1', NaN, Infinity, -1]) {
        expect(testCase.schema.safeParse({ ...request, [field]: value }).success).toBe(false);
      }
      expect(testCase.schema.safeParse({ ...request, [field]: 0 }).success).toBe(
        field === levelField,
      );
    }
    expect(testCase.schema.safeParse({ ...request, method: undefined }).success).toBe(false);
  });

  for (const mode of ['plain', 'explain'] as const) {
    describe(mode, () => {
      const run = (input: unknown): number =>
        mode === 'plain' ? call(input as Request) : call.explain(input as Request).value;
      function refused(input: unknown, code: string, field?: string): InputError {
        let error: unknown;
        try {
          run(input);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(InputError);
        expect(error).toMatchObject({ code });
        expect(mode === 'explain' ? [name, name + '.explain'] : [name]).toContain(
          (error as InputError).context?.['function'],
        );
        expect((error as InputError).message).toContain(name);
        if (field !== undefined) expect((error as InputError).context?.['field']).toBe(field);
        return error as InputError;
      }

      it('rejects malformed containers with the helper name', () => {
        for (const bad of [undefined, null, 1, '6030', [], new Float64Array(1), true, () => 1])
          refused(bad, ErrorCode.InputWrongType);
      });

      it('rejects every missing coordinate and teaches a working call to this helper', () => {
        for (const field of Object.keys(request)) {
          const missing = { ...request };
          delete missing[field];
          const error = refused(missing, ErrorCode.InputMissingField, field);
          refused({ ...request, [field]: undefined }, ErrorCode.InputMissingField, field);
          expect(error.message).toContain('e.g. ' + name + '(');
          for (const required of Object.keys(request)) expect(error.message).toContain(required);
        }
        expect(run(request)).toBeCloseTo(testCase.expected, 9);
      });

      it('validates every primitive and finite/range constraint', () => {
        for (const field of Object.keys(request)) {
          for (const value of [null, '1', true, {}, []])
            refused({ ...request, [field]: value }, ErrorCode.InputWrongType, field);
          refused({ ...request, [field]: NaN }, ErrorCode.InputNaN);
          for (const value of [Infinity, -Infinity])
            refused({ ...request, [field]: value }, ErrorCode.InputNotFinite);
          refused({ ...request, [field]: -1 }, ErrorCode.InputOutOfRange, field);
          if (field !== levelField)
            refused({ ...request, [field]: 0 }, ErrorCode.InputOutOfRange, field);
        }
      });

      it('refuses generic controls, misspellings and contract multipliers even when undefined', () => {
        for (const field of [
          'method',
          'sourcePriceUnit',
          'targetPriceUnit',
          'sourcePriceLevel',
          'targetPricePerSourcePrice',
          'contractMultiplier',
          levelField + 'l',
        ]) {
          for (const value of [undefined, 1])
            refused({ ...request, [field]: value }, ErrorCode.InputUnknownField);
        }
      });

      it('uses supplied references, not a market preset or a contract multiplier', () => {
        expect(run(withPrices(12, 8, 3))).toBe(4.5);
        expect(run(withPrices(12, 8, 6))).toBe(9);
        expect(run(withPrices(8, 8, 3))).toBe(3);
        expect(run(withPrices(-0, 8, 3))).toBe(0);
      });

      it('retains exact boundary rounding and names the helper on true range refusals', () => {
        expect(run(withPrices(3 * Number.MIN_VALUE, 5.999999999999999, 0.9999999999999999))).toBe(
          Number.MIN_VALUE,
        );
        expect(
          run(withPrices(Number.MAX_VALUE - 2 ** 971, 1.4999999999999996, 1.4999999999999998)),
        ).toBe(Number.MAX_VALUE);
        refused(withPrices(Number.MAX_VALUE, 1, 2), ErrorCode.InputOutOfRange);
        refused(withPrices(3 * Number.MIN_VALUE, 6, 1), ErrorCode.InputOutOfRange);
      });
    });
  }
});

describe('optional generic unit metadata', () => {
  const inputs: levels.ConvertPriceLevelInput[] = [
    {
      method: 'reference-prices',
      sourcePriceLevel: 6030,
      referenceSourcePrice: 6000,
      referenceTargetPrice: 596,
    },
    { method: 'ratio', sourcePriceLevel: 6030, targetPricePerSourcePrice: 596 / 6000 },
  ];
  for (const input of inputs) {
    it(input.method + ': omitted units do not change arithmetic or invent a result unit', () => {
      const result = levels.convertPriceLevel.explain(input);
      expect(result.value).toBeCloseTo(598.98, 10);
      expect(result.assumptions.resultUnit).toBeNull();
      expect(result.assumptions.conversion).toEqual(input);
      expect(schemas.ConvertPriceLevelInputSchema.parse(input)).toEqual(input);
      for (const metadata of [
        { sourcePriceUnit: undefined, targetPriceUnit: undefined },
        { sourcePriceUnit: 'source points' },
        { targetPriceUnit: 'target points' },
        { sourcePriceUnit: 'source points', targetPriceUnit: 'target points' },
      ]) {
        const request = { ...input, ...metadata } as levels.ConvertPriceLevelInput;
        const explanation = levels.convertPriceLevel.explain(request);
        expect(explanation.value).toBe(result.value);
        expect(explanation.assumptions.resultUnit).toBe(metadata.targetPriceUnit ?? null);
        expect(schemas.ConvertPriceLevelInputSchema.safeParse(request).success).toBe(true);
        expect(JSON.parse(JSON.stringify(explanation))).toEqual(explanation);
      }
      for (const field of ['sourcePriceUnit', 'targetPriceUnit']) {
        for (const invalid of [null, 1, false, [], {}, '', '   ']) {
          const bad = { ...input, [field]: invalid } as levels.ConvertPriceLevelInput;
          expect(() => levels.convertPriceLevel(bad)).toThrow(InputError);
          expect(() => levels.convertPriceLevel.explain(bad)).toThrow(InputError);
          expect(schemas.ConvertPriceLevelInputSchema.safeParse(bad).success).toBe(false);
        }
      }
    });
  }
  it('keeps metadata out of both JSON Schema required lists', () => {
    for (const arm of schemas.ConvertPriceLevelInputSchema.toJSONSchema().anyOf ?? []) {
      expect(arm.required).not.toContain('sourcePriceUnit');
      expect(arm.required).not.toContain('targetPriceUnit');
      expect(arm.required).toContain('method');
    }
  });
});
