/**
 * Package-internal when-present ladders — deliberately NOT re-exported from any entrypoint.
 * The risk package's option objects are small and numerous; every conviction in the 3B.1b
 * measurement was the same defect: a `?? default` coalescing null (and truthy strings through
 * boolean flags) BEFORE the field's own guard ran, so `{ confidence: null }` silently computed at
 * 0.95 (the 350c2796 ruling: null is a wrong-typed value, not omission).
 */

import { ensureFiniteWhenPresent, ErrorCode, InputError } from '@totalfinance/core';

export { ensureFiniteWhenPresent };

/** A present flag must be a boolean — a truthy string must never silently engage a variant. */
export function ensureBooleanWhenPresent(
  value: unknown,
  functionName: string,
  field: string,
): void {
  if (value === undefined) return;
  if (typeof value !== 'boolean') {
    throw new InputError(
      `${functionName}: ${field} must be a boolean when provided — omit the field to use the default. Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field, received: value },
      },
    );
  }
}

/** A present enum member must be in its domain — null must never coalesce into the default. */
export function ensureEnumWhenPresent(
  value: unknown,
  functionName: string,
  field: string,
  domain: readonly string[],
): void {
  if (value === undefined) return;
  if (typeof value !== 'string' || !domain.includes(value)) {
    throw new InputError(
      `${functionName}: ${field} must be one of ${domain.join(' | ')} when provided — omit the field to use the default. Received ${value === null ? 'null' : typeof value === 'string' ? `"${value}"` : typeof value}.`,
      {
        code: ErrorCode.InputInvalidEnum,
        context: { function: functionName, field, received: value },
      },
    );
  }
}

/** Finite-when-present across a list of optional numeric fields — one call per boundary. */
export function ensureFiniteOptionsWhenPresent(
  functionName: string,
  options: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    ensureFiniteWhenPresent(options[field], field, functionName);
  }
}

/** An optional array-valued option must be an array when provided (bounds, groups, samples…). */
export function ensureArrayWhenPresent(value: unknown, functionName: string, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new InputError(
      `${functionName}: ${field} must be an array when provided. Received ${value === null ? 'null' : typeof value}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field, received: value },
      },
    );
  }
}
