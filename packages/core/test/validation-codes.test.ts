import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import * as core from '@totalfinance/core';
import * as ValidationCode from '../src/validation-codes.js';

type ValidationKey = Extract<
  keyof typeof core.ErrorCode,
  `Input${string}` | 'PostconditionNonFinite'
>;

function caught(run: () => unknown): core.QuantError {
  try {
    run();
  } catch (error) {
    if (core.isQuantError(error)) return error;
    throw error;
  }
  throw new Error('Expected a QuantError');
}

describe('package-private validation codes', () => {
  it('has exactly the public input/postcondition keys, values, and readonly literal types', () => {
    expectTypeOf<typeof ValidationCode>().toEqualTypeOf<
      Pick<typeof core.ErrorCode, ValidationKey>
    >();
    expectTypeOf<(typeof ValidationCode)[ValidationKey]>().toExtend<core.ErrorCode>();
    expectTypeOf<typeof ValidationCode>().toEqualTypeOf<Readonly<typeof ValidationCode>>();
    const entries = Object.entries(core.ErrorCode).filter(
      ([key]) => key.startsWith('Input') || key === 'PostconditionNonFinite',
    );
    expect(Object.fromEntries(Object.entries(ValidationCode))).toEqual(Object.fromEntries(entries));
  });

  it('does not add a public export or change the registry into getters', () => {
    expect(core).not.toHaveProperty('ValidationCode');
    for (const [key, value] of Object.entries(core.ErrorCode)) {
      expect(Object.getOwnPropertyDescriptor(core.ErrorCode, key)).toEqual({
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  });

  it('keeps the validation keys at their original public registry positions', () => {
    const keys = Object.keys(core.ErrorCode);
    expect(keys.slice(0, 12)).toEqual([
      'InputNaN',
      'InputNotFinite',
      'InputNegativeSpot',
      'InputNegativeStrike',
      'InputNegativeVolatility',
      'InputNegativeTime',
      'InputOutOfRange',
      'InputInvalidEnum',
      'InputMissingField',
      'InputUnknownField',
      'InputWrongType',
      'InputWrongShape',
    ]);
    expect(keys[keys.indexOf('InputLengthMismatch') - 1]).toBe('OperationHandleKindMismatch');
    expect(keys[keys.indexOf('PostconditionNonFinite') - 1]).toBe('McpInternalError');
    expect(keys[keys.indexOf('InputSuspiciousCouponRate') - 1]).toBe('BacktestOrderSplitAdjusted');
    expect(keys[keys.indexOf('InputSuspiciousYield') + 1]).toBe('ModelFellerConditionViolated');
  });
});

describe('validation errors keep the public error model', () => {
  it.each([
    [() => core.ensureFinite(NaN, 'spot', 'probe'), core.ErrorCode.InputNaN],
    [() => core.ensureFinite(Infinity, 'spot', 'probe'), core.ErrorCode.InputNotFinite],
    [() => core.ensurePositive(0, 'spot', 'probe'), core.ErrorCode.InputOutOfRange],
    [() => core.ensureNonNegative(-1, 'spot', 'probe'), core.ErrorCode.InputOutOfRange],
    [
      () => core.ensurePositive(-1, 'spot', 'probe', core.ErrorCode.InputNegativeSpot),
      core.ErrorCode.InputNegativeSpot,
    ],
    [
      () => core.ensureEnum('bad', ['call', 'put'], 'type', 'probe'),
      core.ErrorCode.InputInvalidEnum,
    ],
    [() => core.requireArgumentObject('probe', 'input', null), core.ErrorCode.InputWrongType],
    [() => core.requireArgumentArray('probe', 'data', {}), core.ErrorCode.InputWrongType],
    [() => core.ensureFiniteWhenPresent(null, 'spot', 'probe'), core.ErrorCode.InputWrongType],
    [
      () => core.ensureKnownKeys('probe', 'input', { typo: 1 }, ['spot']),
      core.ErrorCode.InputUnknownField,
    ],
    [() => core.requireRepresentableResult('probe', Infinity), core.ErrorCode.InputOutOfRange],
  ] as const)('preserves InputError identity and serialization for refusal %#', (run, code) => {
    const error = caught(run);
    expect(error.constructor).toBe(core.InputError);
    expect(error).toBeInstanceOf(core.QuantError);
    expect(error).toBeInstanceOf(Error);
    expect(core.isQuantError(error, code)).toBe(true);
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      serialization: 1,
      name: 'InputError',
      code,
      message: error.message,
      context: error.context,
    });
  });

  it('preserves the exact missing-field teaching error through the shared guard', () => {
    const example = 'probe({ spot: 100 })';
    const hint = 'positive price';
    const error = caught(() =>
      core.requireFiniteFields('probe', {}, ['spot'], {
        exampleCall: () => example,
        hints: { spot: hint },
      }),
    );
    const expected = {
      serialization: 1,
      name: 'InputError',
      code: core.ErrorCode.InputMissingField,
      message: 'probe: spot is required.\n  e.g. probe({ spot: 100 })\n  spot: positive price',
      context: { function: 'probe', field: 'spot', example, hint },
    };
    expect(error.constructor).toBe(core.InputError);
    expect(error.toJSON()).toEqual(expected);
    expect(core.missingFieldError('probe', 'spot', example, hint).toJSON()).toEqual(expected);
  });

  it('preserves wrong-shape keys, message, and absent optional context', () => {
    const error = core.wrongShapeError('probe', '{ spot }', { price: 100 });
    expect(error.constructor).toBe(core.InputError);
    expect(error.toJSON()).toEqual({
      serialization: 1,
      name: 'InputError',
      code: core.ErrorCode.InputWrongShape,
      message: 'probe: expected { spot }.\n  received keys: price',
      context: { function: 'probe', expected: '{ spot }', receivedKeys: ['price'] },
    });
    const cause = new Error('upstream');
    const direct = new core.InputError('probe: invalid input', {
      code: ValidationCode.InputWrongType,
      cause,
    });
    expect(direct.cause).toBe(cause);
    expect(direct.toJSON()).not.toHaveProperty('context');
  });

  it('keeps facade guards before callbacks on both ordinary and explained paths', () => {
    const call = vi.fn((_input: object) => 1);
    const explain = vi.fn(
      (_input: object): core.Computed<number> => ({
        value: 1,
        assumptions: { conventionsVersion: 'test' },
        diagnostics: { warnings: [] },
      }),
    );
    const wrapped = core.facade('probe', call, explain);
    for (const [label, run] of [
      ['probe', wrapped],
      ['probe.explain', wrapped.explain],
    ] as const) {
      const error = caught(() => run(null as never));
      expect(error.constructor).toBe(core.InputError);
      expect(error.toJSON()).toEqual({
        serialization: 1,
        name: 'InputError',
        code: core.ErrorCode.InputWrongType,
        message: `${label}: expected an input object of named fields as the first argument, got null.`,
        context: { function: label, received: 'null' },
      });
    }
    expect(call).not.toHaveBeenCalled();
    expect(explain).not.toHaveBeenCalled();
  });

  it('preserves postcondition identity and exhaustive paths', () => {
    const result = {
      value: { nested: [Infinity] },
      assumptions: { conventionsVersion: 'test', timeToExpiryYears: NaN },
      diagnostics: { warnings: [] },
    };
    const error = caught(() => core.assertFiniteResult('probe', result));
    expect(error.constructor).toBe(core.PostconditionError);
    expect(error).toBeInstanceOf(core.QuantError);
    expect(error.toJSON()).toEqual({
      serialization: 1,
      name: 'PostconditionError',
      code: core.ErrorCode.PostconditionNonFinite,
      message:
        'probe: successful result carries a non-finite number at value.nested[0] — this is a library defect (Law 7); undefined quantities are reported as null with a warning explaining the null. Please report it with your inputs.',
      context: { function: 'probe', paths: ['value.nested[0]', 'assumptions.timeToExpiryYears'] },
    });
    expect(caught(() => core.assertFiniteValue('probe', Infinity)).constructor).toBe(
      core.PostconditionError,
    );
  });
});
