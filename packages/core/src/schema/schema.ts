/**
 * TotalFinance schema facade — a tiny, zero-dependency runtime validator (spec §6).
 *
 * Design goals that drove the 0.0.1 schema decision (see docs/adr/schema-library.md):
 *   - zero runtime dependencies, so `@totalfinance/core` keeps its zero-dep guarantee;
 *   - native `toJSONSchema()` for MCP tools, docs, and adapters;
 *   - excellent TypeScript inference via `Infer<typeof schema>`;
 *   - errors map to `InputError` with stable codes;
 *   - Standard Schema (https://standardschema.dev) compatibility for ecosystem interop;
 *   - small enough to never threaten compute-entrypoint bundle budgets — and, critically, it lives in
 *     a SEPARATE entrypoint so hot paths never import it.
 *
 * It is intentionally a *facade*: the public surface (`parse`/`safeParse`/`toJSONSchema`/`~standard`)
 * is what users depend on, so the underlying implementation can be swapped for Zod/Valibot later
 * without breaking callers.
 */

import { ErrorCode, InputError } from '../errors.js';
import type { JSONSchema } from './json-schema.js';
import type {
  StandardSchemaV1,
  StandardSchemaV1Props,
  StandardSchemaV1Result,
} from './standard.js';

/** Marker so the bundle harness can prove this module never leaks into a compute entrypoint. */
export const __TOTALFINANCE_SCHEMA_FACADE__ = 'totalfinance/schema';

export type ValidationMode = 'strict' | 'coerce' | 'passthrough' | 'off';

export interface ParseOptions {
  /** Validation strictness (spec §6). Defaults to `strict`. */
  mode?: ValidationMode;
}

export interface SchemaIssue {
  code: string;
  message: string;
  path: (string | number)[];
}

export type SafeParseResult<T> =
  | { success: true; data: T }
  | { success: false; issues: SchemaIssue[]; error: InputError };

/** Public schema interface. Concrete builder implementations stay internal. */
export interface Schema<Output> extends StandardSchemaV1<unknown, Output> {
  readonly kind: string;
  readonly isOptional: boolean;
  parse(input: unknown, options?: ParseOptions): Output;
  safeParse(input: unknown, options?: ParseOptions): SafeParseResult<Output>;
  toJSONSchema(): JSONSchema;
  optional(): Schema<Output | undefined>;
  describe(description: string): this;
}

/** Extract the validated output type of a schema. */
export type Infer<S> = S extends Schema<infer O> ? O : never;

/**
 * The validation context threaded through every schema's `_check` — exported so a consumer
 * subclassing {@link Schema} can NAME the parameter of the method they must implement (3B.2
 * nameability: an abstract method whose parameter type is unexported is a contract a consumer
 * can satisfy only by structural accident).
 */
export interface SchemaCheckContext {
  mode: ValidationMode;
  path: (string | number)[];
}

type CheckResult<T> = { ok: true; value: T } | { ok: false; issues: SchemaIssue[] };

function fail(context: SchemaCheckContext, code: string, message: string): CheckResult<never> {
  return { ok: false, issues: [{ code, message, path: [...context.path] }] };
}

function issuesToError(issues: SchemaIssue[], kind: string): InputError {
  const first = issues[0];
  const where = first && first.path.length > 0 ? ` at \`${first.path.join('.')}\`` : '';
  const extra = issues.length > 1 ? ` (+${issues.length - 1} more issue(s))` : '';
  const message = first
    ? `Schema(${kind}) validation failed: ${first.message}${where}${extra}`
    : `Schema(${kind}) validation failed`;
  return new InputError(message, {
    code: first?.code ?? ErrorCode.InputOutOfRange,
    context: { issues },
  });
}

abstract class BaseSchema<Output> implements Schema<Output> {
  abstract readonly kind: string;
  readonly isOptional: boolean = false;
  description: string | undefined;

  /** @internal */
  abstract _check(input: unknown, context: SchemaCheckContext): CheckResult<Output>;
  /** @internal */
  abstract _toJSONSchema(): JSONSchema;

  parse(input: unknown, options?: ParseOptions): Output {
    const res = this.safeParse(input, options);
    if (res.success) return res.data;
    throw res.error;
  }

  safeParse(input: unknown, options?: ParseOptions): SafeParseResult<Output> {
    const mode = options?.mode ?? 'strict';
    if (mode === 'off') return { success: true, data: input as Output };
    const result = this._check(input, { mode, path: [] });
    if (result.ok) return { success: true, data: result.value };
    return {
      success: false,
      issues: result.issues,
      error: issuesToError(result.issues, this.kind),
    };
  }

  toJSONSchema(): JSONSchema {
    const base = this._toJSONSchema();
    if (this.description !== undefined && base.description === undefined) {
      base.description = this.description;
    }
    return base;
  }

  optional(): OptionalSchema<Output> {
    return new OptionalSchema<Output>(this);
  }

  /**
   * Structural copy with the same prototype, so chainable refiners (`.describe()`, `.positive()`,
   * `.min()`, …) return a NEW schema instead of mutating `this`. Refiners replace their internal
   * constraint object wholesale (never mutate it in place), so the shallow copy is safe.
   * @internal
   */
  protected clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this) as object) as this;
    Object.assign(copy, this);
    return copy;
  }

  describe(description: string): this {
    const copy = this.clone();
    copy.description = description;
    return copy;
  }

  get ['~standard'](): StandardSchemaV1Props<unknown, Output> {
    return {
      version: 1,
      vendor: 'totalfinance',
      validate: (value: unknown): StandardSchemaV1Result<Output> => {
        const res = this.safeParse(value);
        if (res.success) return { value: res.data };
        return { issues: res.issues.map((i) => ({ message: i.message, path: i.path })) };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// number
// ---------------------------------------------------------------------------

export interface NumberConstraints {
  integer?: boolean;
  min?: number;
  max?: number;
  exclusiveMin?: number;
  exclusiveMax?: number;
}

class NumberSchema extends BaseSchema<number> {
  readonly kind = 'number';
  private c: NumberConstraints;

  constructor(constraints: NumberConstraints = {}) {
    super();
    this.c = { ...constraints };
  }

  private withConstraints(patch: NumberConstraints): this {
    const copy = this.clone();
    copy.c = { ...this.c, ...patch };
    return copy;
  }
  integer(): this {
    return this.withConstraints({ integer: true });
  }
  positive(): this {
    return this.withConstraints({ exclusiveMin: 0 });
  }
  nonnegative(): this {
    return this.withConstraints({ min: 0 });
  }
  min(value: number): this {
    return this.withConstraints({ min: value });
  }
  max(value: number): this {
    return this.withConstraints({ max: value });
  }
  gt(value: number): this {
    return this.withConstraints({ exclusiveMin: value });
  }
  lt(value: number): this {
    return this.withConstraints({ exclusiveMax: value });
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<number> {
    let value = input;
    if (context.mode === 'coerce' && typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      if (Number.isFinite(n)) value = n;
    }
    if (typeof value !== 'number') {
      return fail(
        context,
        ErrorCode.InputWrongType,
        `expected a number, received ${typeName(input)}`,
      );
    }
    // NaN IS a number typeof-wise, so report it as NaN — not the confusing "received number" (WS2.9).
    if (Number.isNaN(value)) {
      return fail(context, ErrorCode.InputNaN, `expected a finite number, received NaN`);
    }
    if (!Number.isFinite(value)) {
      return fail(context, ErrorCode.InputNotFinite, `expected a finite number, received ${value}`);
    }
    const { integer, min, max, exclusiveMin, exclusiveMax } = this.c;
    if (integer && !Number.isInteger(value)) {
      return fail(context, ErrorCode.InputOutOfRange, `expected an integer, received ${value}`);
    }
    if (min !== undefined && value < min) {
      return fail(context, ErrorCode.InputOutOfRange, `must be >= ${min}, received ${value}`);
    }
    if (max !== undefined && value > max) {
      return fail(context, ErrorCode.InputOutOfRange, `must be <= ${max}, received ${value}`);
    }
    if (exclusiveMin !== undefined && value <= exclusiveMin) {
      return fail(
        context,
        ErrorCode.InputOutOfRange,
        `must be > ${exclusiveMin}, received ${value}`,
      );
    }
    if (exclusiveMax !== undefined && value >= exclusiveMax) {
      return fail(
        context,
        ErrorCode.InputOutOfRange,
        `must be < ${exclusiveMax}, received ${value}`,
      );
    }
    return { ok: true, value };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    const schema: JSONSchema = { type: this.c.integer ? 'integer' : 'number' };
    if (this.c.min !== undefined) schema.minimum = this.c.min;
    if (this.c.max !== undefined) schema.maximum = this.c.max;
    if (this.c.exclusiveMin !== undefined) schema.exclusiveMinimum = this.c.exclusiveMin;
    if (this.c.exclusiveMax !== undefined) schema.exclusiveMaximum = this.c.exclusiveMax;
    return schema;
  }
}

// ---------------------------------------------------------------------------
// string
// ---------------------------------------------------------------------------

export interface StringConstraints {
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'date' | 'date-time' | string;
}

class StringSchema extends BaseSchema<string> {
  readonly kind = 'string';
  private c: StringConstraints;

  constructor(constraints: StringConstraints = {}) {
    super();
    this.c = { ...constraints };
  }

  private withConstraints(patch: StringConstraints): this {
    const copy = this.clone();
    copy.c = { ...this.c, ...patch };
    return copy;
  }
  min(length: number): this {
    return this.withConstraints({ minLength: length });
  }
  max(length: number): this {
    return this.withConstraints({ maxLength: length });
  }
  nonempty(): this {
    return this.withConstraints({ minLength: Math.max(1, this.c.minLength ?? 0) });
  }
  regex(pattern: RegExp | string): this {
    return this.withConstraints({
      pattern: typeof pattern === 'string' ? pattern : pattern.source,
    });
  }
  date(): this {
    return this.withConstraints({ format: 'date' });
  }
  datetime(): this {
    return this.withConstraints({ format: 'date-time' });
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<string> {
    let value = input;
    if (context.mode === 'coerce' && typeof value === 'number' && Number.isFinite(value)) {
      value = String(value);
    }
    if (typeof value !== 'string') {
      return fail(
        context,
        ErrorCode.InputWrongType,
        `expected a string, received ${typeName(input)}`,
      );
    }
    const { minLength, maxLength, pattern, format } = this.c;
    if (minLength !== undefined && value.length < minLength) {
      return fail(context, ErrorCode.InputOutOfRange, `must have length >= ${minLength}`);
    }
    if (maxLength !== undefined && value.length > maxLength) {
      return fail(context, ErrorCode.InputOutOfRange, `must have length <= ${maxLength}`);
    }
    if (pattern !== undefined && !new RegExp(pattern).test(value)) {
      return fail(context, ErrorCode.InputOutOfRange, `must match /${pattern}/`);
    }
    if (format === 'date' && !isIsoDate(value)) {
      return fail(
        context,
        ErrorCode.InputOutOfRange,
        `must be an ISO date (YYYY-MM-DD), received "${value}"`,
      );
    }
    if (format === 'date-time' && !isIsoDateTime(value)) {
      return fail(
        context,
        ErrorCode.InputOutOfRange,
        `must be an ISO date-time, received "${value}"`,
      );
    }
    return { ok: true, value };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    const schema: JSONSchema = { type: 'string' };
    if (this.c.minLength !== undefined) schema.minLength = this.c.minLength;
    if (this.c.maxLength !== undefined) schema.maxLength = this.c.maxLength;
    if (this.c.pattern !== undefined) schema.pattern = this.c.pattern;
    if (this.c.format !== undefined) schema.format = this.c.format;
    return schema;
  }
}

// ---------------------------------------------------------------------------
// boolean
// ---------------------------------------------------------------------------

class BooleanSchema extends BaseSchema<boolean> {
  readonly kind = 'boolean';

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<boolean> {
    let value = input;
    if (context.mode === 'coerce' && typeof value === 'string') {
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
    }
    if (typeof value !== 'boolean') {
      return fail(
        context,
        ErrorCode.InputWrongType,
        `expected a boolean, received ${typeName(input)}`,
      );
    }
    return { ok: true, value };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    return { type: 'boolean' };
  }
}

// ---------------------------------------------------------------------------
// literal
// ---------------------------------------------------------------------------

class LiteralSchema<V extends string | number | boolean> extends BaseSchema<V> {
  readonly kind = 'literal';
  constructor(private readonly value: V) {
    super();
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<V> {
    if (input !== this.value) {
      return fail(context, ErrorCode.InputInvalidEnum, `expected ${JSON.stringify(this.value)}`);
    }
    return { ok: true, value: this.value };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    return { const: this.value, type: jsonTypeOf(this.value) };
  }
}

// ---------------------------------------------------------------------------
// enum (string)
// ---------------------------------------------------------------------------

class EnumSchema<V extends string> extends BaseSchema<V> {
  readonly kind = 'enum';
  private readonly values: readonly V[];
  constructor(values: readonly V[]) {
    super();
    this.values = values;
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<V> {
    if (typeof input === 'string') {
      if ((this.values as readonly string[]).includes(input)) {
        return { ok: true, value: input as V };
      }
      if (context.mode === 'coerce') {
        const match = this.values.find((v) => v.toLowerCase() === input.toLowerCase());
        if (match !== undefined) return { ok: true, value: match };
      }
    }
    // Echo the offending value (not just its type) alongside the allowed set (WS2.9).
    const got = typeof input === 'string' ? `"${input}"` : typeName(input);
    return fail(
      context,
      ErrorCode.InputInvalidEnum,
      `expected one of ${this.values.map((v) => `"${v}"`).join(', ')}, received ${got}`,
    );
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    return { type: 'string', enum: [...this.values] };
  }
}

// ---------------------------------------------------------------------------
// array
// ---------------------------------------------------------------------------

class ArraySchema<Item> extends BaseSchema<Item[]> {
  readonly kind = 'array';
  constructor(
    private readonly item: BaseSchema<Item>,
    private bounds: { min?: number; max?: number } = {},
  ) {
    super();
  }

  min(minimum: number): this {
    const copy = this.clone();
    copy.bounds = { ...this.bounds, min: minimum };
    return copy;
  }
  max(maximum: number): this {
    const copy = this.clone();
    copy.bounds = { ...this.bounds, max: maximum };
    return copy;
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<Item[]> {
    if (!Array.isArray(input)) {
      return fail(
        context,
        ErrorCode.InputWrongType,
        `expected an array, received ${typeName(input)}`,
      );
    }
    if (this.bounds.min !== undefined && input.length < this.bounds.min) {
      return fail(
        context,
        ErrorCode.InputOutOfRange,
        `must have at least ${this.bounds.min} items`,
      );
    }
    if (this.bounds.max !== undefined && input.length > this.bounds.max) {
      return fail(context, ErrorCode.InputOutOfRange, `must have at most ${this.bounds.max} items`);
    }
    const out: Item[] = [];
    const issues: SchemaIssue[] = [];
    for (let i = 0; i < input.length; i++) {
      const res = this.item._check(input[i], { mode: context.mode, path: [...context.path, i] });
      if (res.ok) out.push(res.value);
      else issues.push(...res.issues);
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    const schema: JSONSchema = { type: 'array', items: this.item.toJSONSchema() };
    if (this.bounds.min !== undefined) schema.minItems = this.bounds.min;
    if (this.bounds.max !== undefined) schema.maxItems = this.bounds.max;
    return schema;
  }
}

// ---------------------------------------------------------------------------
// optional
// ---------------------------------------------------------------------------

class OptionalSchema<T> extends BaseSchema<T | undefined> {
  override readonly isOptional = true;
  readonly kind = 'optional';
  constructor(private readonly inner: BaseSchema<T>) {
    super();
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<T | undefined> {
    if (input === undefined) return { ok: true, value: undefined };
    return this.inner._check(input, context);
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    return this.inner.toJSONSchema();
  }

  override optional(): OptionalSchema<T | undefined> {
    return this as unknown as OptionalSchema<T | undefined>;
  }
}

// ---------------------------------------------------------------------------
// transform / cross-field validation
// ---------------------------------------------------------------------------

/**
 * A composable schema effect. Unlike replacing `safeParse()` on one schema instance, this layer is
 * reached through `_check()` when the schema is nested in an object, array, optional, or union. The
 * transform may also enforce cross-field invariants by throwing an {@link InputError}; the error is
 * converted back into a normal schema issue at the configured relative path.
 *
 * This stays internal to the schema implementation for now. The public facade can expose a polished
 * refinement API later without making core payload correctness depend on method monkey-patching.
 */
class TransformSchema<Input, Output> extends BaseSchema<Output> {
  readonly kind: string;
  override readonly isOptional: boolean;
  readonly #transformValue: (value: Input) => Output;

  constructor(
    private readonly inner: BaseSchema<Input>,
    transform: (value: Input) => Output,
    private readonly errorPath: readonly (string | number)[],
  ) {
    super();
    this.kind = inner.kind;
    this.isOptional = inner.isOptional;
    this.#transformValue = transform;
  }

  /** Preserve the ECMAScript private transform slot when `.describe()` clones this effect. */
  protected override clone(): this {
    const copy = new TransformSchema(this.inner, this.#transformValue, this.errorPath);
    copy.description = this.description;
    return copy as this;
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<Output> {
    const parsed = this.inner._check(input, context);
    if (!parsed.ok) return parsed;
    try {
      return { ok: true, value: this.#transformValue(parsed.value) };
    } catch (error) {
      if (error instanceof InputError) {
        return {
          ok: false,
          issues: [
            {
              code: error.code,
              message: error.message,
              path: [...context.path, ...this.errorPath],
            },
          ],
        };
      }
      throw error;
    }
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    return this.inner.toJSONSchema();
  }
}

/** @internal Compose a cross-field validator/transform with any schema. */
export function transformSchema<Input, Output>(
  schema: Schema<Input>,
  transform: (value: Input) => Output,
  options: { errorPath?: readonly (string | number)[] } = {},
): Schema<Output> {
  return new TransformSchema(schema as BaseSchema<Input>, transform, options.errorPath ?? []);
}

// ---------------------------------------------------------------------------
// object
// ---------------------------------------------------------------------------

type AnySchema = BaseSchema<unknown>;

type Prettify<T> = { [K in keyof T]: T[K] } & {};

type OptionalShapeKeys<Shape> = {
  [K in keyof Shape]: Shape[K] extends { isOptional: true } ? K : never;
}[keyof Shape];
type RequiredShapeKeys<Shape> = Exclude<keyof Shape, OptionalShapeKeys<Shape>>;

export type InferObject<Shape extends Record<string, Schema<unknown>>> = Prettify<
  { [K in RequiredShapeKeys<Shape>]: Infer<Shape[K]> } & {
    // Strip the `undefined` the optional wrapper adds so inferred optionals read as `?: T`,
    // matching the `exactOptionalPropertyTypes` convention used across TotalFinance interfaces.
    [K in OptionalShapeKeys<Shape>]?: Exclude<Infer<Shape[K]>, undefined>;
  }
>;

class ObjectSchema<Shape extends Record<string, Schema<unknown>>> extends BaseSchema<
  InferObject<Shape>
> {
  readonly kind = 'object';
  private readonly entries: [string, AnySchema][];
  private allowsUnknownKeys = false;

  constructor(private readonly shape: Shape) {
    super();
    this.entries = Object.entries(shape) as [string, AnySchema][];
  }

  /**
   * Structured-OPEN object mode (2026-08-23, fourth external review). The declared shape is still
   * fully validated, but unknown keys are ALLOWED and preserved — the schema form for a payload
   * whose contract documents vendor decoration (Law 12: entries stay open). `toJSONSchema()` then
   * emits the complete `properties`/`required` map with `additionalProperties: true`, so MCP
   * tools, agents, and generated forms see the real field shape instead of a shapeless object.
   *
   * Distinct from parse-time `mode: 'passthrough'` on purpose: openness declared here is a
   * property of the PAYLOAD's contract (every caller, every mode, and the emitted JSON Schema all
   * agree), while `passthrough` is one caller's per-parse leniency toward a schema that itself
   * remains closed. Like every refiner, returns a NEW schema; the receiver stays closed.
   */
  open(): this {
    const copy = this.clone();
    copy.allowsUnknownKeys = true;
    return copy;
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<InferObject<Shape>> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fail(
        context,
        ErrorCode.InputWrongType,
        `expected an object, received ${typeName(input)}`,
      );
    }
    const record = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const issues: SchemaIssue[] = [];

    for (const [key, child] of this.entries) {
      const present = Object.prototype.hasOwnProperty.call(record, key);
      const value = record[key];
      if ((!present || value === undefined) && child.isOptional) continue;
      if (!present) {
        issues.push({
          code: ErrorCode.InputMissingField,
          message: 'is required',
          path: [...context.path, key],
        });
        continue;
      }
      const res = child._check(value, { mode: context.mode, path: [...context.path, key] });
      if (res.ok) {
        if (res.value !== undefined) safeSet(out, key, res.value);
      } else {
        issues.push(...res.issues);
      }
    }

    if (context.mode === 'strict' || context.mode === 'coerce') {
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(this.shape, key)) {
          if (this.allowsUnknownKeys) {
            // Declared-open contract: decoration is data, preserved verbatim (prototype-safe).
            safeSet(out, key, record[key]);
          } else {
            issues.push({
              code: ErrorCode.InputUnknownField,
              message: `unknown field "${key}"`,
              path: [...context.path, key],
            });
          }
        }
      }
    } else if (context.mode === 'passthrough') {
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(this.shape, key)) {
          safeSet(out, key, record[key]);
        }
      }
    }

    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, value: out as InferObject<Shape> };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    for (const [key, child] of this.entries) {
      properties[key] = child.toJSONSchema();
      if (!child.isOptional) required.push(key);
    }
    // An open object states its openness (`true`), a closed one its closure (`false`) — the
    // emitted JSON Schema and the runtime verdicts must tell the same story about unknown keys.
    const schema: JSONSchema = {
      type: 'object',
      properties,
      additionalProperties: this.allowsUnknownKeys,
    };
    if (required.length > 0) schema.required = required;
    return schema;
  }
}

// ---------------------------------------------------------------------------
// union
// ---------------------------------------------------------------------------

class UnionSchema<T> extends BaseSchema<T> {
  readonly kind = 'union';
  constructor(private readonly members: BaseSchema<T>[]) {
    super();
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<T> {
    const issues: SchemaIssue[] = [];
    for (const member of this.members) {
      const res = member._check(input, context);
      if (res.ok) return res;
      issues.push(...res.issues);
    }
    return {
      ok: false,
      issues: [
        {
          code: ErrorCode.InputWrongType,
          message: `did not match any union member`,
          path: [...context.path],
        },
        ...issues,
      ],
    };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    return { anyOf: this.members.map((m) => m.toJSONSchema()) };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Write a validated key onto an output object as an OWN data property, immune to prototype
 * plumbing. A plain `out[key] = value` is unsafe for attacker-controlled keys: `"__proto__"`
 * (own-key in any `JSON.parse` result) hits the `Object.prototype.__proto__` accessor, so the
 * value either vanishes (primitive) or REPLACES the output's prototype (object — instant
 * pollution: `out.success === true` by inheritance). `defineProperty` always creates an own
 * enumerable/writable/configurable property — `__proto__`, `constructor`, and friends land as
 * ordinary data keys, in insertion order, with the prototype untouched.
 */
function safeSet(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function jsonTypeOf(value: string | number | boolean): 'string' | 'number' | 'boolean' {
  return typeof value as 'string' | 'number' | 'boolean';
}

function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [, y, mo, da] = m;
  if (!y || !mo || !da) return false;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(da);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // setUTCFullYear, not Date.UTC: the latter remaps years 0–99 to 1900–1999, which would reject
  // every date in the first century as "not a real date" (the same defect core's parseIsoDate had).
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function isIsoDateTime(value: string): boolean {
  // The zone is REQUIRED (determinism law #5): a zone-less datetime would parse in the machine's
  // local zone — the same payload validating to different instants on different boxes. This aligns
  // `.datetime()` with core's `resolveAsOf`/`optionExpiryToMs` grammar (which also accept the
  // RFC-3339-legal lowercase `t`/`z`).
  if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2})?(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  // Uppercase the RFC-3339 lowercase t/z before the calendar-validity probe: `Date.parse` only
  // guarantees ISO handling for the uppercase form.
  return !Number.isNaN(Date.parse(value.toUpperCase()));
}

// ---------------------------------------------------------------------------
// record (arbitrary string-keyed maps) + unknown
// ---------------------------------------------------------------------------

/** Accepts any value unchanged. For genuinely open payloads (e.g. `Record<string, unknown>` maps). */
class UnknownSchema extends BaseSchema<unknown> {
  readonly kind = 'unknown';

  /** @internal */
  _check(input: unknown): CheckResult<unknown> {
    return { ok: true, value: input };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    return {};
  }
}

/** Accepts only the literal `null` (JSON's explicit null value; distinct from `undefined`/absent). */
class NullSchema extends BaseSchema<null> {
  readonly kind = 'null';

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<null> {
    if (input !== null) {
      return fail(context, ErrorCode.InputWrongType, `expected null, received ${typeName(input)}`);
    }
    return { ok: true, value: null };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    return { type: 'null' };
  }
}

/** An object with arbitrary string keys whose values all satisfy `value` (e.g. `Fundamentals.fields`). */
class RecordSchema<V> extends BaseSchema<Record<string, V>> {
  readonly kind = 'record';
  constructor(private readonly value: BaseSchema<V>) {
    super();
  }

  /** @internal */
  _check(input: unknown, context: SchemaCheckContext): CheckResult<Record<string, V>> {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return fail(
        context,
        ErrorCode.InputWrongType,
        `expected an object, received ${typeName(input)}`,
      );
    }
    const rec = input as Record<string, unknown>;
    const out: Record<string, V> = {};
    const issues: SchemaIssue[] = [];
    for (const key of Object.keys(rec)) {
      const res = this.value._check(rec[key], { mode: context.mode, path: [...context.path, key] });
      if (res.ok) safeSet(out, key, res.value);
      else issues.push(...res.issues);
    }
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out };
  }

  /** @internal */
  _toJSONSchema(): JSONSchema {
    return { type: 'object', additionalProperties: this.value.toJSONSchema() };
  }
}

// ---------------------------------------------------------------------------
// builder facade
// ---------------------------------------------------------------------------

/** The schema builder. Returns typed schemas with `parse`/`safeParse`/`toJSONSchema`. */
export const schema = {
  // Raw-constraint objects are not accepted here — compose constraints with the chainers
  // (`.min()`, `.positive()`, `.integer()`, `.nonempty()`, …) so there is one way to build a schema (WS2.14).
  number(): NumberSchema {
    return new NumberSchema();
  },
  string(): StringSchema {
    return new StringSchema();
  },
  boolean(): BooleanSchema {
    return new BooleanSchema();
  },
  literal<V extends string | number | boolean>(value: V): LiteralSchema<V> {
    return new LiteralSchema<V>(value);
  },
  enum<V extends string>(values: readonly V[]): EnumSchema<V> {
    return new EnumSchema<V>(values);
  },
  array<Item>(item: Schema<Item>): ArraySchema<Item> {
    return new ArraySchema<Item>(item as BaseSchema<Item>);
  },
  object<Shape extends Record<string, Schema<unknown>>>(shape: Shape): ObjectSchema<Shape> {
    return new ObjectSchema<Shape>(shape);
  },
  union<Members extends readonly Schema<unknown>[]>(
    members: Members,
  ): UnionSchema<Infer<Members[number]>> {
    return new UnionSchema(members as unknown as BaseSchema<Infer<Members[number]>>[]);
  },
  record<V>(value: Schema<V>): RecordSchema<V> {
    return new RecordSchema<V>(value as BaseSchema<V>);
  },
  unknown(): UnknownSchema {
    return new UnknownSchema();
  },
  null(): NullSchema {
    return new NullSchema();
  },
} as const;

/** Validate `input` against `schema`, returning a typed `SafeParseResult`. */
export function validate<Output>(
  schema: Schema<Output>,
  input: unknown,
  options?: ParseOptions,
): SafeParseResult<Output> {
  return schema.safeParse(input, options);
}

export type {
  NumberSchema,
  StringSchema,
  BooleanSchema,
  LiteralSchema,
  EnumSchema,
  ArraySchema,
  ObjectSchema,
  OptionalSchema,
  UnionSchema,
  RecordSchema,
  UnknownSchema,
};
