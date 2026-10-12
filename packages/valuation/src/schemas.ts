/** Runtime schemas are a separate import so compute calls remain free of schema machinery. */
import { schema, type Schema } from '@totalfinance/core/schema';
import { type ConvertPriceLevelInput } from './price-level-input.js';

const coordinates = {
  sourcePriceLevel: schema
    .number()
    .nonnegative()
    .describe('Source price level in sourcePriceUnit; finite and nonnegative.'),
  sourcePriceUnit: schema
    .string()
    .regex(/\S/)
    .describe('Caller-supplied source price unit label; nonblank.'),
  targetPriceUnit: schema
    .string()
    .regex(/\S/)
    .describe('Caller-supplied target price unit label; also the result unit; nonblank.'),
};

/** Closed request schema for {@link convertPriceLevel}; select exactly one explicit method. */
export const ConvertPriceLevelInputSchema: Schema<ConvertPriceLevelInput> = schema
  .union([
    schema.object({
      ...coordinates,
      method: schema.literal('reference-prices'),
      referenceSourcePrice: schema
        .number()
        .positive()
        .describe('Positive reference price in sourcePriceUnit; denominator.'),
      referenceTargetPrice: schema
        .number()
        .positive()
        .describe('Positive reference price in targetPriceUnit.'),
    }),
    schema.object({
      ...coordinates,
      method: schema.literal('ratio'),
      targetPricePerSourcePrice: schema
        .number()
        .positive()
        .describe('Positive ratio: target price units per ONE source price unit.'),
    }),
  ])
  .describe(
    'Approximate proportional price mapping with explicit units and no financial defaults.',
  );
