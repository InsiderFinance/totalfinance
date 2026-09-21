/** Package-internal validation for the shared optimizer constraint grammar. */

import { ensureKnownKeys, ErrorCode, InputError, requireArgumentObject } from '@totalfinance/core';
import { describeInputValue } from './input-description.js';
import type { OptimizeConstraints } from './optimize.js';

/** The one closed key set accepted by every optimizer and composed optimizer facade. */
export const OPTIMIZE_CONSTRAINTS_KEYS = [
  'longOnly',
  'bounds',
  'budget',
  'groups',
  'turnover',
  'transactionCosts',
  'maximumIterations',
  'tolerance',
] as const;

export const GROUP_CONSTRAINT_KEYS = ['members', 'min', 'max'] as const;
export const TURNOVER_CONSTRAINT_KEYS = ['previousWeights', 'max'] as const;
export const TRANSACTION_COST_KEYS = ['perUnitTurnover', 'previousWeights'] as const;
const hasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * Public optimizer objects are JSON-style data, never behavior. Besides producing better typed
 * errors for `null`, this prevents inherited/accessor options from changing a solve while being
 * absent from `Object.keys`, logs, and serialized requests.
 */
export function requirePlainDataObject(functionName: string, field: string, value: unknown): void {
  requireArgumentObject(functionName, field, value);
  const record = value as object;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new InputError(`${functionName}: ${field} must be a plain object of stored data.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field },
    });
  }
  for (const key of Reflect.ownKeys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      throw new InputError(
        `${functionName}: ${field} must contain only enumerable string-keyed stored data; accessors, hidden fields, and symbols are not optimizer inputs.`,
        {
          code: ErrorCode.InputWrongShape,
          context: { function: functionName, field },
        },
      );
    }
  }
}

/** Reject a known option inherited from a polluted prototype instead of silently consuming it. */
export function requireNoInheritedFields(
  functionName: string,
  field: string,
  value: object,
  fields: readonly string[],
): void {
  for (const key of fields) {
    if (hasOwnProperty.call(value, key) || !(key in value)) continue;
    throw new InputError(
      `${functionName}: ${field}.${key} is inherited rather than an own field — state every optimizer option explicitly in the request object.`,
      {
        code: ErrorCode.InputWrongShape,
        context: { function: functionName, field: `${field}.${key}` },
      },
    );
  }
}

/** One closed, plain-data object boundary shared by optimizer public facades. */
export function requireClosedDataObject(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly string[],
): void {
  requirePlainDataObject(functionName, field, value);
  const record = value as object;
  requireNoInheritedFields(functionName, field, record, allowed);
  ensureKnownKeys(functionName, field, record, allowed);
}

/** Arrays in the constraint grammar are dense data arrays with no behavior or decoration. */
export function requireDenseDataArray(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new InputError(
      `${functionName}: ${field} must be an array. Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field },
      },
    );
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new InputError(`${functionName}: ${field} must be a plain array.`, {
      code: ErrorCode.InputWrongType,
      context: { function: functionName, field },
    });
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new InputError(
        `${functionName}: ${field} must be a dense array of stored data; index ${index} is missing or accessor-backed.`,
        {
          code: ErrorCode.InputWrongShape,
          context: { function: functionName, field: `${field}[${index}]` },
        },
      );
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    const index = typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) ? Number(key) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
      throw new InputError(
        `${functionName}: ${field} must contain only its dense indexed values; ${String(key)} is not array data.`,
        {
          code: ErrorCode.InputWrongShape,
          context: { function: functionName, field },
        },
      );
    }
  }
}

/**
 * Hard cap for synchronous projected solvers. Above 2^53 an integer loop counter can stop
 * advancing; one million iterations is already 100–200× the normal defaults.
 */
const MAX_OPTIMIZER_ITERATIONS = 1_000_000;

/**
 * Validate the complete shared constraint grammar without starting a solve. Composed facades use
 * this before estimating work; direct optimizers use the same function immediately before their
 * kernels. The optional asset count activates all dimension/index checks.
 */
export function validateOptimizeConstraints(
  constraints: OptimizeConstraints,
  functionName: string,
  assetCount?: number,
): void {
  // Solver-specific option bags extend this grammar (`riskAversion`, `alpha`, `normalize`, …),
  // and their public facades already enforce their own wider closed key sets. Here, reject
  // behavior/inherited COMMON fields while validating only the shared members. A composed facade
  // such as efficientFrontier closes its top-level constraint key set before calling this helper.
  requirePlainDataObject(functionName, 'constraints', constraints);
  requireNoInheritedFields(functionName, 'constraints', constraints, OPTIMIZE_CONSTRAINTS_KEYS);
  const fail = (
    message: string,
    context: Record<string, unknown>,
    code: string = ErrorCode.InputOutOfRange,
  ): never => {
    throw new InputError(`${functionName}: ${message}`, { code, context });
  };
  const requireVector = (value: unknown, field: string): number[] => {
    requireDenseDataArray(functionName, field, value);
    if (assetCount !== undefined && value.length !== assetCount) {
      fail(`${field} length (${value.length}) must match the number of assets (${assetCount}).`, {
        field,
        length: value.length,
        assets: assetCount,
      });
    }
    for (let index = 0; index < value.length; index++) {
      const member = value[index];
      if (typeof member !== 'number') {
        fail(
          `${field}[${index}] must be a number, got ${member === null ? 'null' : typeof member}.`,
          { field, index },
          ErrorCode.InputWrongType,
        );
      }
      if (!Number.isFinite(member)) {
        fail(
          `${field}[${index}] must be finite, got ${describeInputValue(member)}.`,
          { field, index },
          ErrorCode.InputNotFinite,
        );
      }
    }
    return value as number[];
  };

  if (constraints.bounds !== undefined) {
    requireDenseDataArray(functionName, 'constraints.bounds', constraints.bounds);
    if (assetCount !== undefined && constraints.bounds.length !== assetCount) {
      fail(
        `bounds length (${constraints.bounds.length}) must match the number of assets (${assetCount}).`,
        { field: 'constraints.bounds', length: constraints.bounds.length, assets: assetCount },
      );
    }
    for (let index = 0; index < constraints.bounds.length; index++) {
      const field = `constraints.bounds[${index}]`;
      const pair = constraints.bounds[index] as unknown;
      requireDenseDataArray(functionName, field, pair);
      if (pair.length !== 2) {
        fail(
          `${field} must contain exactly [lower, upper], got ${pair.length} values.`,
          { field, length: pair.length },
          ErrorCode.InputWrongShape,
        );
      }
      const lower = pair[0];
      const upper = pair[1];
      for (const [side, value] of [
        ['lower', lower],
        ['upper', upper],
      ] as const) {
        if (typeof value !== 'number') {
          fail(
            `${field} ${side} bound must be a number (the lower side may use -Infinity; the upper side may use +Infinity), got ${value === null ? 'null' : typeof value}.`,
            { field, side },
            ErrorCode.InputWrongType,
          );
        }
        if (Number.isNaN(value)) {
          fail(
            `${field} ${side} bound must not be NaN.`,
            { field, side },
            ErrorCode.InputNotFinite,
          );
        }
      }
      if (lower === Number.POSITIVE_INFINITY) {
        fail(
          `${field} lower bound must be finite or -Infinity, never +Infinity.`,
          { field, side: 'lower', value: lower },
          ErrorCode.InputOutOfRange,
        );
      }
      if (upper === Number.NEGATIVE_INFINITY) {
        fail(
          `${field} upper bound must be finite or +Infinity, never -Infinity.`,
          { field, side: 'upper', value: upper },
          ErrorCode.InputOutOfRange,
        );
      }
      if ((lower as number) > (upper as number)) {
        fail(`${field} lower (${String(lower)}) must not exceed upper (${String(upper)}).`, {
          field,
          lower,
          upper,
        });
      }
    }
  }

  if (constraints.groups !== undefined) {
    requireDenseDataArray(functionName, 'constraints.groups', constraints.groups);
    for (let index = 0; index < constraints.groups.length; index++) {
      const field = `constraints.groups[${index}]`;
      const raw = constraints.groups[index] as unknown;
      requireClosedDataObject(functionName, field, raw, GROUP_CONSTRAINT_KEYS);
      const group = raw as Record<string, unknown>;
      if (group['members'] === undefined) {
        fail(
          `${field}.members is required.`,
          { field: `${field}.members` },
          ErrorCode.InputMissingField,
        );
      }
      requireDenseDataArray(functionName, `${field}.members`, group['members']);
      if (group['members'].length === 0) {
        fail('each group must list at least one member index.', { field: `${field}.members` });
      }
      for (const limit of ['min', 'max'] as const) {
        const value = group[limit];
        if (value === undefined) continue;
        if (typeof value !== 'number') {
          fail(
            `${field}.${limit} must be a finite number, got ${value === null ? 'null' : typeof value}.`,
            { field: `${field}.${limit}` },
            ErrorCode.InputWrongType,
          );
        }
        if (!Number.isFinite(value)) {
          fail(
            `${field}.${limit} must be finite, got ${describeInputValue(value)}.`,
            { field: `${field}.${limit}`, value },
            ErrorCode.InputNotFinite,
          );
        }
      }
    }
  }

  if (constraints.turnover !== undefined) {
    requireClosedDataObject(
      functionName,
      'constraints.turnover',
      constraints.turnover,
      TURNOVER_CONSTRAINT_KEYS,
    );
    if (constraints.turnover.previousWeights === undefined) {
      fail(
        'constraints.turnover.previousWeights is required.',
        { field: 'constraints.turnover.previousWeights' },
        ErrorCode.InputMissingField,
      );
    }
    if (constraints.turnover.max === undefined) {
      fail(
        'constraints.turnover.max is required.',
        { field: 'constraints.turnover.max' },
        ErrorCode.InputMissingField,
      );
    }
  }

  if (constraints.transactionCosts !== undefined) {
    requireClosedDataObject(
      functionName,
      'constraints.transactionCosts',
      constraints.transactionCosts,
      TRANSACTION_COST_KEYS,
    );
    if (constraints.transactionCosts.perUnitTurnover === undefined) {
      fail(
        'constraints.transactionCosts.perUnitTurnover is required.',
        { field: 'constraints.transactionCosts.perUnitTurnover' },
        ErrorCode.InputMissingField,
      );
    }
    if (constraints.transactionCosts.previousWeights === undefined) {
      fail(
        'constraints.transactionCosts.previousWeights is required.',
        { field: 'constraints.transactionCosts.previousWeights' },
        ErrorCode.InputMissingField,
      );
    }
  }

  if (constraints.longOnly !== undefined && typeof constraints.longOnly !== 'boolean') {
    const received = describeInputValue(constraints.longOnly);
    fail(
      `longOnly must be a boolean when provided. Received ${received}.`,
      { field: 'longOnly', received },
      ErrorCode.InputWrongType,
    );
  }
  if (constraints.budget !== undefined && typeof constraints.budget !== 'number') {
    const received = describeInputValue(constraints.budget);
    fail(
      `budget must be a number, got ${received}.`,
      { field: 'budget', received },
      ErrorCode.InputWrongType,
    );
  }
  if (constraints.budget !== undefined && !Number.isFinite(constraints.budget)) {
    fail(
      `budget must be a finite number, got ${constraints.budget}.`,
      { budget: constraints.budget },
      ErrorCode.InputNotFinite,
    );
  }
  if (
    constraints.maximumIterations !== undefined &&
    (!Number.isSafeInteger(constraints.maximumIterations) ||
      constraints.maximumIterations < 1 ||
      constraints.maximumIterations > MAX_OPTIMIZER_ITERATIONS)
  ) {
    fail(
      `maximumIterations must be a positive integer ≤ ${MAX_OPTIMIZER_ITERATIONS.toLocaleString('en-US')} (each iteration is a full projection/gradient pass, so the cap keeps the largest request single-digit seconds; optimizer defaults are 4,000–10,000), got ${describeInputValue(constraints.maximumIterations)}.`,
      {
        received: describeInputValue(constraints.maximumIterations),
        max: MAX_OPTIMIZER_ITERATIONS,
      },
    );
  }
  if (constraints.tolerance !== undefined && typeof constraints.tolerance !== 'number') {
    const received = describeInputValue(constraints.tolerance);
    fail(
      `tolerance must be a number, got ${received}.`,
      { field: 'tolerance', received },
      ErrorCode.InputWrongType,
    );
  }
  if (
    constraints.tolerance !== undefined &&
    !(constraints.tolerance > 0 && Number.isFinite(constraints.tolerance))
  ) {
    fail(`tolerance must be a finite number > 0, got ${constraints.tolerance}.`, {
      tolerance: constraints.tolerance,
    });
  }

  if (constraints.turnover !== undefined) {
    if (typeof constraints.turnover.max !== 'number') {
      const received = describeInputValue(constraints.turnover.max);
      fail(
        `turnover.max must be a number, got ${received}.`,
        { field: 'turnover.max', received },
        ErrorCode.InputWrongType,
      );
    }
    if (!(constraints.turnover.max >= 0 && Number.isFinite(constraints.turnover.max))) {
      fail(`turnover.max must be a finite number ≥ 0, got ${constraints.turnover.max}.`, {
        max: constraints.turnover.max,
      });
    }
    requireVector(constraints.turnover.previousWeights, 'turnover.previousWeights');
  }

  for (const [groupIndex, group] of (constraints.groups ?? []).entries()) {
    const distinctMembers = new Set<number>();
    for (const [memberIndex, member] of group.members.entries()) {
      if (typeof member !== 'number') {
        fail(
          `group member at constraints.groups[${groupIndex}].members[${memberIndex}] must be a number, got ${member === null ? 'null' : typeof member}.`,
          { groupIndex, memberIndex },
          ErrorCode.InputWrongType,
        );
      }
      if (
        !Number.isSafeInteger(member) ||
        member < 0 ||
        (assetCount !== undefined && member >= assetCount)
      ) {
        fail(
          `group member index ${describeInputValue(member)} must be an integer in [0, ${assetCount ?? '∞'}).`,
          { member, assets: assetCount },
        );
      }
      if (distinctMembers.has(member)) {
        fail(
          `group member index ${member} is duplicated; each asset may appear only once within a group.`,
          { groupIndex, member },
          ErrorCode.InputWrongShape,
        );
      }
      distinctMembers.add(member);
    }
    if (group.min !== undefined && group.max !== undefined && group.min > group.max) {
      fail(`group min (${group.min}) must not exceed max (${group.max}).`, {
        min: group.min,
        max: group.max,
      });
    }
  }

  if (constraints.transactionCosts !== undefined) {
    const { perUnitTurnover } = constraints.transactionCosts;
    if (typeof perUnitTurnover === 'number') {
      if (!Number.isFinite(perUnitTurnover) || perUnitTurnover < 0) {
        fail('transactionCosts.perUnitTurnover must be finite and ≥ 0.', { perUnitTurnover });
      }
    } else {
      const rates = requireVector(perUnitTurnover, 'transactionCosts.perUnitTurnover');
      if (rates.some((rate) => rate < 0)) {
        fail('transactionCosts.perUnitTurnover must be ≥ 0.', { perUnitTurnover });
      }
    }
    requireVector(constraints.transactionCosts.previousWeights, 'transactionCosts.previousWeights');
  }
}
