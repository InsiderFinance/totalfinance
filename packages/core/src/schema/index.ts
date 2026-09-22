/**
 * `@insiderfinance/totalfinance/core/schema` — the runtime schema facade.
 *
 * This is a SEPARATE entrypoint on purpose (spec §6 hot-path rule). Compute entrypoints like
 * `@insiderfinance/totalfinance/options/black-scholes` import `@insiderfinance/totalfinance/core` (types + tiny guards) but never this
 * module, so the validator code stays out of their bundles.
 */

export { schema, validate, __TOTALFINANCE_SCHEMA_FACADE__ } from './schema.js';

export type {
  Schema,
  Infer,
  InferObject,
  ParseOptions,
  ValidationMode,
  SchemaCheckContext,
  SafeParseResult,
  SchemaIssue,
  NumberConstraints,
  StringConstraints,
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
} from './schema.js';

export type { JSONSchema, JSONSchemaTypeName } from './json-schema.js';
export { JSON_SCHEMA_MAX_DEPTH, requireJSONSchema } from './json-schema-guard.js';

export type {
  StandardSchemaV1,
  StandardSchemaV1Props,
  StandardSchemaV1Result,
  StandardSchemaV1Issue,
} from './standard.js';

// Canonical market-data payload schemas (spec §7.6).
export {
  coreSchemas,
  BarSchema,
  QuoteSchema,
  TradeSchema,
  OptionContractSchema,
  OptionQuoteSchema,
  OptionTradeSchema,
  DividendSchema,
  CorporateActionSchema,
  RateCurvePointSchema,
  RateCurveSchema,
  OrderBookLevelSchema,
  OrderBookSchema,
  RawFundamentalsRecordSchema,
} from './payloads.js';
