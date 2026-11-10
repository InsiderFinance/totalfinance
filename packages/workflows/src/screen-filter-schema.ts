/** Recursive discovery document for the existing SDK grammar; SDK validation owns semantics. */
import { schema, type JSONSchema } from '@totalfinance/core/schema';
import { domainWireSchema } from './trade-wire-common-schemas.js';

const reference: JSONSchema = { $ref: 'https://totalfinance.dev/schemas/research/screen-filter' };
const text: JSONSchema = { type: 'string' };
const number: JSONSchema = { type: 'number' };
const object = (properties: Record<string, JSONSchema>): JSONSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const condition = (operators: string[], values: Record<string, JSONSchema>): JSONSchema =>
  object({ field: text, operator: { type: 'string', enum: operators }, ...values });

export const ScreenFilterSchema = domainWireSchema(
  () => ({
    $id: 'https://totalfinance.dev/schemas/research/screen-filter',
    oneOf: [
      object({ all: { type: 'array', minItems: 1, items: reference } }),
      object({ any: { type: 'array', minItems: 1, items: reference } }),
      object({ not: reference }),
      condition(['greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'], {
        value: number,
      }),
      condition(['equals', 'notEquals'], { value: { type: ['number', 'string', 'boolean'] } }),
      condition(['between'], { from: number, to: number }),
      condition(['in', 'notIn'], {
        values: { type: 'array', minItems: 1, items: { type: ['number', 'string'] } },
      }),
      condition(['isPresent', 'isMissing'], {}),
    ],
  }),
  (value) => schema.record(schema.unknown()).parse(value),
);
