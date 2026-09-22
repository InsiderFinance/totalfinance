/**
 * `@insiderfinance/totalfinance/options/schema` — runtime schemas for option payloads (spec §6).
 *
 * Isolation guarantee: the hot path is the deep `@insiderfinance/totalfinance/options/black-scholes` entrypoint, which
 * does NOT import this module — the bundle-size test enforces that it carries no schema/validator
 * code. The aggregate `@insiderfinance/totalfinance/options` index re-exports these schemas for convenience; bundlers
 * tree-shake them when unused, but a native-ESM `import { blackScholes } from '@insiderfinance/totalfinance/options'` will still
 * evaluate this module. That cost is trivial (plain descriptor objects, no work at load); anyone who
 * needs the guaranteed-lean footprint imports the deep entrypoint. MCP tools, adapters, and validated
 * wrappers use these; the compute path does not.
 */

import { type Infer, OptionContractSchema, schema } from '@totalfinance/core/schema';

/**
 * The Black–Scholes–Merton input field descriptors — the ONE source of truth for every option
 * payload schema (facade, typed, implied-vol) and for consumers (MCP tools) that compose date-aware
 * variants. Reusing these fields is why every option schema carries the same field descriptions
 * instead of drifting apart.
 */
export const blackScholesShape = {
  spot: schema.number().positive().describe('Spot price of the underlying'),
  strike: schema.number().positive().describe('Strike price'),
  timeToExpiryYears: schema.number().positive().describe('Time to expiry in years'),
  riskFreeRate: schema.number().describe('Continuously-compounded risk-free rate (decimal)'),
  volatility: schema.number().positive().describe('Volatility (decimal)'),
  dividendYield: schema
    .number()
    .optional()
    .describe('Continuous dividend yield (decimal, default 0)'),
} as const;

/** The `call | put` option-type enum, shared by every typed option schema. */
export const optionType = schema.enum(['call', 'put'] as const).describe('Option type');

/** Schema for a `BlackScholesInput` facade payload. */
export const BlackScholesInputSchema = schema.object(blackScholesShape);

/** Schema for a typed BSM payload (`blackScholes.price` / `blackScholes.greeks`). */
export const BlackScholesTypedInputSchema = schema.object({
  ...blackScholesShape,
  type: optionType,
});

/**
 * Schema for an implied-volatility request. Built from {@link blackScholesShape} (minus `volatility`, which is the
 * unknown being solved) so its fields carry the same descriptions as every other option schema
 * rather than the bare, description-less duplicate this used to be.
 */
export const BlackScholesImpliedVolatilityInputSchema = schema.object({
  price: schema.number().positive().describe('Observed option price to invert'),
  spot: blackScholesShape.spot,
  strike: blackScholesShape.strike,
  timeToExpiryYears: blackScholesShape.timeToExpiryYears,
  riskFreeRate: blackScholesShape.riskFreeRate,
  type: optionType,
  dividendYield: blackScholesShape.dividendYield,
});

/** Canonical `OptionContract` schema (defined in `@insiderfinance/totalfinance/core/schema`, re-exported for convenience). */
export { OptionContractSchema };

/** Convenience namespace mirroring the spec's `schemas.OptionContract.parse(...)` usage. */
export const schemas = {
  BlackScholesInput: BlackScholesInputSchema,
  BlackScholesTypedInput: BlackScholesTypedInputSchema,
  BlackScholesImpliedVolatilityInput: BlackScholesImpliedVolatilityInputSchema,
  OptionContract: OptionContractSchema,
} as const;

export type BlackScholesInputShape = Infer<typeof BlackScholesInputSchema>;
export type BlackScholesTypedInputShape = Infer<typeof BlackScholesTypedInputSchema>;
export type OptionContractShape = Infer<typeof OptionContractSchema>;
