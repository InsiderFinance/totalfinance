import { ErrorCode, InputError } from '@totalfinance/core';
import {
  CANONICAL_DATA_MAX_DEPTH,
  canonicalJsonOf,
  canonicalStringWorkUnits,
  fromCanonicalJson,
  scanCanonicalData,
} from '@totalfinance/core/artifacts';
import type { CanonicalDataScanOptions } from '@totalfinance/core/artifacts';

// The bounded stored-data scanner is the spine's (`@insiderfinance/totalfinance/core/artifacts`, Stage 4.5 Decision 9):
// one scanner, one cost law (Stage 4.4b Decision 10), shared by every artifact door. This module keeps
// the scenario-specific detachment and request-shell helpers and re-exports the scanner so the
// runner's call sites and its boundary tests read unchanged.
export { canonicalStringWorkUnits, scanCanonicalData };
export type { CanonicalDataScanOptions };

export const SCENARIO_DATA_MAX_DEPTH = CANONICAL_DATA_MAX_DEPTH;

/** Describe an unknown value without invoking caller-controlled coercion hooks. */
export function describeInputValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'undefined') return 'undefined';
  if (typeof value === 'symbol') return 'symbol';
  return typeof value;
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** Freeze a previously detached canonical value without reading caller-controlled properties. */
export function deepFreezeDetached<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') return value;
  const discovered = new WeakSet<object>();
  const order: object[] = [];
  const stack: object[] = [value as object];
  while (stack.length > 0) {
    const object = stack.pop()!;
    if (discovered.has(object)) continue;
    discovered.add(object);
    order.push(object);
    if (Array.isArray(object)) {
      for (let index = 0; index < object.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(object, String(index));
        const child = descriptor !== undefined && 'value' in descriptor ? descriptor.value : null;
        if (child !== null && typeof child === 'object') stack.push(child as object);
      }
    } else {
      for (const key of Reflect.ownKeys(object)) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        const child = descriptor !== undefined && 'value' in descriptor ? descriptor.value : null;
        if (child !== null && typeof child === 'object') stack.push(child as object);
      }
    }
  }
  for (let index = order.length - 1; index >= 0; index--) Object.freeze(order[index]!);
  return value;
}

/** Prove, canonically detach, and deeply freeze behavior-free data. */
export function detachCanonicalData<T>(value: T, options: CanonicalDataScanOptions): Readonly<T> {
  scanCanonicalData(value, options);
  const detached = fromCanonicalJson(canonicalJsonOf(value)) as T;
  return deepFreezeDetached(detached);
}

/**
 * Canonically detach data that has just been proved by `scanCanonicalData` or constructed by a
 * closed validator from only that proved data. Keeping this helper private to the scenarios
 * implementation avoids charging and traversing the same callback/requirement result twice.
 */
export function detachProvenCanonicalData<T>(value: T): Readonly<T> {
  const detached = fromCanonicalJson(canonicalJsonOf(value)) as T;
  return deepFreezeDetached(detached);
}

export interface ClosedRecordOptions {
  readonly functionName: string;
  readonly label: string;
  readonly allowedKeys: readonly string[];
  readonly requiredKeys?: readonly string[];
}

/** Read only a plain array's intrinsic length descriptor, without allocating or visiting slots. */
export function readPlainArrayLength(value: unknown, functionName: string, label: string): number {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new InputError(`${functionName}: ${label} must be a plain dense array.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: label },
    });
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    descriptor === undefined ||
    !('value' in descriptor) ||
    !Number.isSafeInteger(descriptor.value) ||
    descriptor.value < 0
  ) {
    throw new InputError(`${functionName}: ${label} has an invalid array length descriptor.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field: `${label}.length` },
    });
  }
  return descriptor.value as number;
}

/**
 * Validate one public request shell through own descriptors only. Returns a plain map of the
 * snapshotted values so later validation never re-reads a getter or a mutable request property.
 */
export function snapshotClosedRecord(
  value: unknown,
  options: ClosedRecordOptions,
): Readonly<Record<string, unknown>> {
  const { functionName, label, allowedKeys, requiredKeys = [] } = options;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError(
      `${functionName}: ${label} must be a plain object of named fields, got ${describeInputValue(value)}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: label, received: describeInputValue(value) },
      },
    );
  }
  const object = value as object;
  if (!isPlainRecord(object)) {
    throw new InputError(
      `${functionName}: ${label} must be a plain object with own stored fields — class instances and custom prototypes are not accepted request containers.`,
      { code: ErrorCode.InputWrongType, context: { function: functionName, field: label } },
    );
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== 'string') {
      throw new InputError(
        `${functionName}: ${label} contains a symbol key (${String(key)}); closed request objects use enumerable string fields only.`,
        { code: ErrorCode.InputUnknownField, context: { function: functionName, field: label } },
      );
    }
    if (!allowedKeys.includes(key)) {
      throw new InputError(
        `${functionName}: unknown field ${JSON.stringify(key)} in ${label}. Allowed fields: ${allowedKeys.join(', ')}.`,
        {
          code: ErrorCode.InputUnknownField,
          context: { function: functionName, field: label, key },
        },
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new InputError(
        `${functionName}: ${label}.${key} must be an enumerable own data property — accessors and hidden members are not accepted.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}.${key}` },
        },
      );
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(result, key) || result[key] === undefined) {
      throw new InputError(`${functionName}: ${label}.${key} is required.`, {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: `${label}.${key}` },
      });
    }
  }
  return Object.freeze(result);
}

/** Snapshot and validate a plain dense array without reading inherited or accessor-backed slots. */
export function snapshotDenseArray(
  value: unknown,
  functionName: string,
  label: string,
): readonly unknown[] {
  const length = readPlainArrayLength(value, functionName, label);
  const array = value as unknown[];
  const result: unknown[] = new Array(length);
  for (const key of Reflect.ownKeys(array)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
      throw new InputError(
        `${functionName}: ${label} has a non-index member ${String(key)} — arrays at this boundary contain only dense elements.`,
        { code: ErrorCode.InputUnknownField, context: { function: functionName, field: label } },
      );
    }
  }
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new InputError(
        `${functionName}: ${label}[${index}] must be a stored element — sparse arrays and accessors are not accepted.`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: `${label}[${index}]` },
        },
      );
    }
    result[index] = descriptor.value;
  }
  return Object.freeze(result);
}

export function checkedAdd(
  functionName: string,
  label: string,
  first: number,
  second: number,
): number {
  if (
    !Number.isSafeInteger(first) ||
    first < 0 ||
    !Number.isSafeInteger(second) ||
    second < 0 ||
    first > Number.MAX_SAFE_INTEGER - second
  ) {
    throw new InputError(
      `${functionName}: ${label} exceeds the safe-integer work range — split the scenario run.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field: label } },
    );
  }
  return first + second;
}

export function checkedMultiply(
  functionName: string,
  label: string,
  first: number,
  second: number,
): number {
  if (
    !Number.isSafeInteger(first) ||
    first < 0 ||
    !Number.isSafeInteger(second) ||
    second < 0 ||
    (first !== 0 && second > Math.floor(Number.MAX_SAFE_INTEGER / first))
  ) {
    throw new InputError(
      `${functionName}: ${label} exceeds the safe-integer work range — split the scenario run.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field: label } },
    );
  }
  return first * second;
}
