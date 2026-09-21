/** A pragmatic JSON Schema (Draft 2020-12) shape — enough for MCP tools and docs. */

export type JSONSchemaTypeName =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export interface JSONSchema {
  $schema?: string;
  $id?: string;
  title?: string;
  description?: string;
  type?: JSONSchemaTypeName | JSONSchemaTypeName[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;

  // object
  properties?: Record<string, JSONSchema>;
  required?: string[];
  additionalProperties?: boolean | JSONSchema;

  // array
  items?: JSONSchema;
  minItems?: number;
  maxItems?: number;

  // number
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  // string
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;

  // composition
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];

  /** Allow vendor/extension keywords without losing type-checking on the known ones. */
  [key: string]: unknown;
}
