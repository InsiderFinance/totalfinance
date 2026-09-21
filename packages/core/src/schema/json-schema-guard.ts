/**
 * A structural guard for a JSON Schema document (the {@link JSONSchema} shape): every known keyword
 * that is PRESENT must carry its declared type — `null` is not omission — and every nested schema
 * (`properties`, `additionalProperties`, `items`, `anyOf` / `oneOf` / `allOf`) is walked the same
 * way. Vendor keywords pass through untouched, exactly as the type's index signature allows. An
 * operation's or a tool's output schema is a document a transport publishes verbatim, so it is
 * validated once, where it is declared.
 */

import { ErrorCode, InputError } from '../errors.js';
import { requireArgumentObject } from '../invariants.js';
import type { JSONSchema } from './json-schema.js';

const JSON_SCHEMA_TYPE_NAMES: readonly string[] = [
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
];
const STRING_KEYS = ['$schema', '$id', 'title', 'description', 'pattern', 'format'] as const;
const NUMBER_KEYS = [
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
] as const;
const LIST_KEYS = ['anyOf', 'oneOf', 'allOf'] as const;

/** The deepest nesting a document may declare; deeper is a cycle, not a schema. */
export const JSON_SCHEMA_MAX_DEPTH = 64;

function refuse(functionName: string, message: string, field: string, code: ErrorCode): never {
  throw new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

/**
 * Assert that `value` is a well-formed JSON Schema document; throws a typed `InputError` naming the
 * offending path (`<field>.properties.<name>.type`, …) otherwise.
 *
 * @param functionName - The public function reporting the refusal (core's own guard order).
 * @param field - The argument path the document was received under.
 * @param value - The candidate document.
 */
export function requireJSONSchema(
  functionName: string,
  field: string,
  value: unknown,
): asserts value is JSONSchema {
  walk(functionName, field, value, 0);
}

function walk(functionName: string, field: string, value: unknown, depth: number): void {
  if (depth > JSON_SCHEMA_MAX_DEPTH) {
    refuse(
      functionName,
      `${field} nests deeper than ${JSON_SCHEMA_MAX_DEPTH} levels; a JSON Schema document this deep is not a schema, it is a cycle.`,
      field,
      ErrorCode.InputWrongShape,
    );
  }
  requireArgumentObject(functionName, field, value);
  const document = value as Record<string, unknown>;
  for (const key of STRING_KEYS) {
    if (document[key] !== undefined && typeof document[key] !== 'string') {
      refuse(
        functionName,
        `${field}.${key} must be a string when present.`,
        `${field}.${key}`,
        ErrorCode.InputWrongType,
      );
    }
  }
  for (const key of NUMBER_KEYS) {
    if (document[key] !== undefined && !Number.isFinite(document[key])) {
      refuse(
        functionName,
        `${field}.${key} must be a finite number when present.`,
        `${field}.${key}`,
        typeof document[key] === 'number' ? ErrorCode.InputNotFinite : ErrorCode.InputWrongType,
      );
    }
  }
  if (document['type'] !== undefined) {
    const names = Array.isArray(document['type']) ? document['type'] : [document['type']];
    for (const name of names) {
      if (typeof name !== 'string' || !JSON_SCHEMA_TYPE_NAMES.includes(name)) {
        refuse(
          functionName,
          `${field}.type must be one of ${JSON_SCHEMA_TYPE_NAMES.join(', ')} (or a list of them).`,
          `${field}.type`,
          typeof name === 'string' ? ErrorCode.InputInvalidEnum : ErrorCode.InputWrongType,
        );
      }
    }
  }
  for (const key of ['const', 'default'] as const) {
    if (document[key] === null) {
      refuse(
        functionName,
        `${field}.${key} is null: a null constant or default is not a value a published document carries — express a nullable field as type: [<type>, 'null'] and omit the keyword.`,
        `${field}.${key}`,
        ErrorCode.InputWrongType,
      );
    }
  }
  if (document['enum'] !== undefined && !Array.isArray(document['enum'])) {
    refuse(
      functionName,
      `${field}.enum must be an array when present.`,
      `${field}.enum`,
      ErrorCode.InputWrongType,
    );
  }
  if (
    document['required'] !== undefined &&
    (!Array.isArray(document['required']) ||
      document['required'].some((name) => typeof name !== 'string'))
  ) {
    refuse(
      functionName,
      `${field}.required must be an array of property names when present.`,
      `${field}.required`,
      ErrorCode.InputWrongType,
    );
  }
  if (document['properties'] !== undefined) {
    requireArgumentObject(functionName, `${field}.properties`, document['properties']);
    for (const [name, child] of Object.entries(document['properties'] as object)) {
      walk(functionName, `${field}.properties.${name}`, child, depth + 1);
    }
  }
  if (
    document['additionalProperties'] !== undefined &&
    document['additionalProperties'] !== true &&
    document['additionalProperties'] !== false
  ) {
    walk(
      functionName,
      `${field}.additionalProperties`,
      document['additionalProperties'],
      depth + 1,
    );
  }
  if (document['items'] !== undefined) {
    walk(functionName, `${field}.items`, document['items'], depth + 1);
  }
  for (const key of LIST_KEYS) {
    if (document[key] === undefined) continue;
    if (!Array.isArray(document[key])) {
      refuse(
        functionName,
        `${field}.${key} must be an array of schemas when present.`,
        `${field}.${key}`,
        ErrorCode.InputWrongType,
      );
    }
    (document[key] as unknown[]).forEach((child, index) => {
      walk(functionName, `${field}.${key}[${index}]`, child, depth + 1);
    });
  }
}
