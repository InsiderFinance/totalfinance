/** Package-internal strict snapshot of a caller-owned numeric vector. */

import { ErrorCode, InputError } from '@totalfinance/core';
import { describeInputValue } from './input-description.js';

// Read typed arrays through the intrinsic %TypedArray% operations. A typed-array instance or
// subclass may shadow `.length` with a caller getter; ordinary property access would execute it.
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length',
)?.get;
const TYPED_ARRAY_AT = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'at')?.value as
  | ((index: number) => unknown)
  | undefined;

/**
 * Copy a dense stored-data `ArrayLike<number>` without coercion or caller code execution. Plain
 * arrays, numeric typed arrays, array subclasses, and ordinary `{ 0, 1, length }` records work;
 * consumed `length`/index members must be own data properties (typed arrays use internal slots).
 * Unconsumed decoration is ignored. Every copied element must already be a finite number.
 */
export function snapshotFiniteVector(
  functionName: string,
  field: string,
  value: unknown,
  expectedLength?: number,
  maximumLength?: number,
): number[] {
  const isTypedArray = ArrayBuffer.isView(value) && !(value instanceof DataView);
  let length: unknown;
  let read: (index: number) => unknown;

  if (isTypedArray) {
    if (TYPED_ARRAY_LENGTH_GETTER === undefined || TYPED_ARRAY_AT === undefined) {
      throw new InputError(
        `${functionName}: this JavaScript runtime does not expose the intrinsic typed-array operations needed to snapshot ${field} safely. Pass a stored-data array-like record instead.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field },
        },
      );
    }
    try {
      length = Reflect.apply(TYPED_ARRAY_LENGTH_GETTER, value, []);
      read = (index) => Reflect.apply(TYPED_ARRAY_AT, value, [index]);
    } catch {
      throw new InputError(
        `${functionName}: ${field} must be an attached numeric typed array whose internal values can be snapshotted.`,
        {
          code: ErrorCode.InputWrongShape,
          context: { function: functionName, field },
        },
      );
    }
  } else if (value !== null && typeof value === 'object') {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !('value' in lengthDescriptor)) {
      throw new InputError(
        `${functionName}: ${field}.length must be an own stored number; inherited/accessor lengths are not executed.`,
        {
          code: ErrorCode.InputWrongShape,
          context: { function: functionName, field: `${field}.length` },
        },
      );
    }
    length = lengthDescriptor.value;
    read = (index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new InputError(
          `${functionName}: ${field} must be a dense array-like record of stored numbers; index ${index} is missing, inherited, or accessor-backed.`,
          {
            code: ErrorCode.InputWrongShape,
            context: { function: functionName, field: `${field}[${index}]` },
          },
        );
      }
      return descriptor.value;
    };
  } else {
    throw new InputError(
      `${functionName}: ${field} must be a dense stored-data ArrayLike<number> (an array, numeric typed array, or { 0, 1, length } record), got ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field },
      },
    );
  }

  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
    const received = describeInputValue(length);
    throw new InputError(
      `${functionName}: ${field}.length must be a non-negative safe integer, got ${received}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: `${field}.length`, received },
      },
    );
  }
  if (expectedLength !== undefined && length !== expectedLength) {
    throw new InputError(
      `${functionName}: ${field} length (${length}) must match the number of assets (${expectedLength}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, expected: expectedLength, got: length },
      },
    );
  }
  if (maximumLength !== undefined && length > maximumLength) {
    throw new InputError(
      `${functionName}: ${field} lists ${length.toLocaleString('en-US')} values; this synchronous operation accepts at most ${maximumLength.toLocaleString('en-US')} before allocation. Split the calculation or use a smaller universe.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, length, maximum: maximumLength },
      },
    );
  }

  const result = new Array<number>(length);
  for (let index = 0; index < length; index++) {
    let member: unknown;
    try {
      member = read(index);
    } catch (error) {
      if (error instanceof InputError) throw error;
      throw new InputError(
        `${functionName}: ${field}[${index}] could not be read from the typed array's internal storage.`,
        {
          code: ErrorCode.InputWrongShape,
          context: { function: functionName, field: `${field}[${index}]`, index },
        },
      );
    }
    if (typeof member !== 'number') {
      throw new InputError(
        `${functionName}: ${field}[${index}] must be a number, got ${member === null ? 'null' : typeof member}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${field}[${index}]`, index },
        },
      );
    }
    if (!Number.isFinite(member)) {
      throw new InputError(`${functionName}: ${field}[${index}] must be finite.`, {
        code: ErrorCode.InputNotFinite,
        context: { function: functionName, field: `${field}[${index}]`, index, value: member },
      });
    }
    result[index] = member;
  }
  return result;
}
