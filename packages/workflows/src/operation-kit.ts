/**
 * Shared helpers for operation bodies: the row cap every series operation applies before compute,
 * and the composed object schema that lets an operation add knobs to a library input schema
 * without re-declaring it (moved from `@totalfinance/mcp` in Stage 7A — one home).
 */

import { InputError, ErrorCode } from '@totalfinance/core';
import {
  type JSONSchema,
  type ParseOptions,
  type SafeParseResult,
  type Schema,
  type SchemaCheckContext,
  type SchemaIssue,
  type StandardSchemaV1Props,
} from '@totalfinance/core/schema';

/** The nested-check result shape core's schemas exchange (`@internal` there, structural here). */
type CheckResult<Output> = { ok: true; value: Output } | { ok: false; issues: SchemaIssue[] };

export const MAX_ROWS = 5000;

export function capRows<Rows extends readonly unknown[]>(
  rows: Rows,
  field: string,
  operationId: string,
  max: number = MAX_ROWS,
): Rows {
  if (!Array.isArray(rows)) {
    throw new InputError(
      `capRows: rows must be an array. Received ${rows === null ? 'null' : typeof rows}.`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: 'capRows', field: 'rows' },
      },
    );
  }
  for (const [name, value] of [
    ['field', field],
    ['operationId', operationId],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new InputError(
        `capRows: ${name} must be a non-empty string (it names the refused field in the teaching). Received ${value === null ? 'null' : typeof value}.`,
        {
          code: value === undefined ? 'input.missing_field' : 'input.wrong_type',
          context: { function: 'capRows', field: name },
        },
      );
    }
  }
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1) {
    throw new InputError(
      `capRows: max must be a positive safe integer. Received ${typeof max === 'number' ? String(max) : max === null ? 'null' : typeof max}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: 'capRows', field: 'max' },
      },
    );
  }
  if (rows.length > max) {
    throw new InputError(
      `${operationId}: \`${field}\` exceeds the ${max}-row limit for this operation (${rows.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { operation: operationId, field, length: rows.length, max },
      },
    );
  }
  return rows;
}

class ExtendedObjectSchema<Output> implements Schema<Output> {
  readonly kind = 'object';
  readonly isOptional: boolean = false;
  private description: string | undefined;

  constructor(
    private readonly base: Schema<unknown>,
    private readonly extension: Schema<unknown>,
    private readonly extKeys: readonly string[],
  ) {}

  parse(input: unknown, options?: ParseOptions): Output {
    const res = this.safeParse(input, options);
    if (res.success) return res.data;
    throw res.error;
  }

  /**
   * @internal The nested-check protocol every core schema speaks, so an extended object composes
   * inside `schema.array(...)` / `schema.object({ ... })` exactly like a plain object schema (the
   * path in every issue stays exact). Delegates to the two halves' own checks.
   */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<Output> {
    type Checkable = { _check(input: unknown, context: SchemaCheckContext): CheckResult<unknown> };
    const base = this.base as unknown as Checkable;
    const extension = this.extension as unknown as Checkable;
    if (this.isOptional && input === undefined) return { ok: true, value: undefined as Output };
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return base._check(input, context) as CheckResult<Output>;
    }
    const record = input as Record<string, unknown>;
    const baseInput: Record<string, unknown> = {};
    const extInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (this.extKeys.includes(k)) extInput[k] = v;
      else baseInput[k] = v;
    }
    const baseRes = base._check(baseInput, context);
    const extRes = extension._check(extInput, context);
    if (baseRes.ok && extRes.ok) {
      return {
        ok: true,
        value: {
          ...(baseRes.value as Record<string, unknown>),
          ...(extRes.value as Record<string, unknown>),
        } as Output,
      };
    }
    return {
      ok: false,
      issues: [...(baseRes.ok ? [] : baseRes.issues), ...(extRes.ok ? [] : extRes.issues)],
    };
  }

  safeParse(input: unknown, options?: ParseOptions): SafeParseResult<Output> {
    if (this.isOptional && input === undefined) {
      return { success: true, data: undefined as Output };
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return this.base.safeParse(input, options) as SafeParseResult<Output>;
    }
    const record = input as Record<string, unknown>;
    const baseInput: Record<string, unknown> = {};
    const extInput: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      if (this.extKeys.includes(k)) extInput[k] = v;
      else baseInput[k] = v;
    }
    const baseRes = this.base.safeParse(baseInput, options);
    const extRes = this.extension.safeParse(extInput, options);
    if (baseRes.success && extRes.success) {
      return {
        success: true,
        data: {
          ...(baseRes.data as Record<string, unknown>),
          ...(extRes.data as Record<string, unknown>),
        } as Output,
      };
    }
    const issues = [
      ...(baseRes.success ? [] : baseRes.issues),
      ...(extRes.success ? [] : extRes.issues),
    ];
    const error = !baseRes.success ? baseRes.error : (extRes as { error: InputError }).error;
    return { success: false, issues, error };
  }

  toJSONSchema(): JSONSchema {
    const b = this.base.toJSONSchema();
    const e = this.extension.toJSONSchema();
    const required = [...(b.required ?? []), ...(e.required ?? [])];
    const out: JSONSchema = {
      ...b,
      properties: { ...(b.properties ?? {}), ...(e.properties ?? {}) },
    };
    if (required.length > 0) out.required = required;
    if (this.description !== undefined && out.description === undefined) {
      out.description = this.description;
    }
    return out;
  }

  optional(): Schema<Output | undefined> {
    const copy = this.clone() as ExtendedObjectSchema<Output | undefined>;
    (copy as { isOptional: boolean }).isOptional = true;
    return copy;
  }

  describe(description: string): this {
    const copy = this.clone();
    copy.description = description;
    return copy;
  }

  private clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this) as object) as this;
    Object.assign(copy, this);
    return copy;
  }

  get ['~standard'](): StandardSchemaV1Props<unknown, Output> {
    return {
      version: 1,
      vendor: 'totalfinance',
      validate: (value: unknown) => {
        const res = this.safeParse(value);
        if (res.success) return { value: res.data };
        return { issues: res.issues.map((i) => ({ message: i.message, path: i.path })) };
      },
    };
  }
}

/** Compose `base` (a library object schema) with operation-only `extension` fields. */
function requireSchema(functionName: string, field: string, value: unknown): void {
  const candidate = value as { safeParse?: unknown; toJSONSchema?: unknown } | null;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.safeParse !== 'function' ||
    typeof candidate.toJSONSchema !== 'function'
  ) {
    throw new InputError(
      `${functionName}: ${field} must be a @totalfinance/core/schema Schema (safeParse + toJSONSchema). Received ${value === null ? 'null' : typeof value}.`,
      {
        code: value === undefined ? 'input.missing_field' : 'input.wrong_type',
        context: { function: functionName, field },
      },
    );
  }
}

export function extendObjectSchema<B, E>(base: Schema<B>, extension: Schema<E>): Schema<B & E> {
  requireSchema('extendObjectSchema', 'base', base);
  requireSchema('extendObjectSchema', 'extension', extension);
  const extKeys = Object.keys(extension.toJSONSchema().properties ?? {});
  return new ExtendedObjectSchema<B & E>(
    base as Schema<unknown>,
    extension as Schema<unknown>,
    extKeys,
  );
}
