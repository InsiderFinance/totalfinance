import { expect, it } from 'vitest';
import {
  QuantError,
  InputError,
  ConvergenceError,
  ArbitrageError,
  DataError,
  UnsupportedError,
  ConfigurationError,
  PostconditionError,
  missingFieldError,
  ErrorCode,
} from '../src/errors.js';
import { ensureFinite } from '../src/invariants.js';

it.each([
  QuantError,
  InputError,
  ConvergenceError,
  ArbitrageError,
  DataError,
  UnsupportedError,
  ConfigurationError,
  PostconditionError,
])('preserves native prototype, cause and exact serialized metadata for %s', (ErrorClass) => {
  const cause = new Error('synthetic cause');
  const context = { field: 'spot', value: -1 };
  const error = new ErrorClass('probe: explicit failure.', {
    code: ErrorCode.InputOutOfRange,
    context,
    cause,
  });
  expect(Object.getPrototypeOf(error)).toBe(ErrorClass.prototype);
  expect(error).toBeInstanceOf(QuantError);
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe(ErrorClass.name);
  expect(error.cause).toBe(cause);
  expect(error.context).toBe(context);
  expect(error.toJSON()).toEqual({
    serialization: 1,
    name: ErrorClass.name,
    code: 'input.out_of_range',
    message: 'probe: explicit failure.',
    context,
  });
  const bare = new ErrorClass('probe: no metadata.', { code: ErrorCode.InputWrongType });
  expect(bare.toJSON()).toEqual({
    serialization: 1,
    name: ErrorClass.name,
    code: 'input.wrong_type',
    message: 'probe: no metadata.',
  });
  expect(Object.hasOwn(bare, 'cause')).toBe(false);
});

it.each([undefined, '', 'Supply a decimal annual rate.'])(
  'preserves exact missing-field text/context for hint %j',
  (hint) => {
    const error = missingFieldError('probe', 'rate', 'probe({ rate: 0.04 })', hint);
    expect(error.message).toBe(
      'probe: rate is required.\n  e.g. probe({ rate: 0.04 })' +
        (hint === undefined ? '' : `\n  rate: ${hint}`),
    );
    expect(error.context).toEqual({
      function: 'probe',
      field: 'rate',
      example: 'probe({ rate: 0.04 })',
      ...(hint === undefined ? {} : { hint }),
    });
    expect(error.code).toBe(ErrorCode.InputMissingField);
  },
);

it.each([
  [NaN, 'NaN'],
  [Infinity, 'Infinity'],
  [-Infinity, '-Infinity'],
  [true, 'true (boolean)'],
  [false, 'false (boolean)'],
  [100n, '100n (bigint)'],
  [undefined, 'undefined'],
  [null, 'null'],
  ['100', '"100" (string)'],
  [{}, 'object'],
  [Symbol('x'), 'symbol'],
  [() => 0, 'function'],
])('preserves exact primitive teaching text for %s', (value, description) => {
  let caught: unknown;
  try {
    ensureFinite(value as number, 'spot', 'probe');
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(InputError);
  expect((caught as InputError).message).toBe(
    `probe: spot must be a finite number. Received ${description}.`,
  );
});
