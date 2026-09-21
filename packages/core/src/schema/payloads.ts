/**
 * Runtime schemas for core market-data payloads (spec §6, §7.6).
 *
 * Lives under `@totalfinance/core/schema` so it never burdens hot compute paths. These are the canonical
 * payload schemas; domain packages re-export the relevant ones (e.g. `@totalfinance/options` re-exports
 * `OptionContractSchema`).
 */

import { requireRateCurveData } from '../market-data.js';
import { validateResolvedExpiry } from '../time.js';
import type { DayCount, InterestCompounding } from '../time.js';
import { schema, transformSchema } from './schema.js';

/**
 * Recursively freeze a parsed artifact. `Object.freeze` is shallow — a "FROZEN" contract whose
 * `deliverable` (and its `shares[]`) stayed mutable is an immutability lie: an engine could
 * validate the artifact and then have its economics edited underneath it. Schema output is a
 * fresh tree (no cycles, no shared references), so a plain recursive walk is exact.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const symbolId = schema.string().nonempty();
const epochMs = schema.number();
const conditions = schema.array(schema.string());

export const BarSchema = schema.object({
  symbol: symbolId,
  timestampMs: epochMs,
  open: schema.number(),
  high: schema.number(),
  low: schema.number(),
  close: schema.number(),
  volume: schema.number().nonnegative().optional(),
  vwap: schema.number().optional(),
  adjusted: schema.boolean().optional(),
});

export const QuoteSchema = schema.object({
  symbol: symbolId,
  timestampMs: epochMs,
  bid: schema.number(),
  ask: schema.number(),
  bidSize: schema.number().nonnegative().optional(),
  askSize: schema.number().nonnegative().optional(),
  exchange: schema.string().optional(),
  conditions: conditions.optional(),
});

export const TradeSchema = schema.object({
  symbol: symbolId,
  timestampMs: epochMs,
  price: schema.number(),
  size: schema.number(),
  exchange: schema.string().optional(),
  conditions: conditions.optional(),
  sequence: schema.number().optional(),
});

/**
 * D2 decision: this schema validates the RESOLVED pricing artifact — what the option builders
 * return and engines consume — not an unresolved DTO. The label accepts everything the builders
 * accept (date-only or zoned datetime), and the resolved `expiresAt` + `expiryConvention` are
 * REQUIRED: a contract without its instant is not a contract yet (build it first).
 */
const OptionContractShapeSchema = schema.object({
  underlying: schema.string().nonempty(),
  type: schema.enum(['call', 'put'] as const),
  style: schema.enum(['european', 'american'] as const),
  strike: schema.number().positive(),
  expiry: schema
    .string()
    // Mirrors core's expiry grammar exactly (incl. RFC-3339 lowercase t/z) so a builder-accepted
    // label always validates here — one expiry law, one grammar.
    .regex(/^\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2}))?$/)
    .describe("Display label: 'YYYY-MM-DD' or a zoned ISO datetime (matches the builders)"),
  expiresAt: epochMs.describe('Resolved expiration instant (epoch ms) — stamped by the builders'),
  expiryConvention: schema
    .enum(['us-equity-close', 'explicit-instant'] as const)
    .describe('How the label resolved to the instant'),
  multiplier: schema.number().positive().optional(),
  settlement: schema.enum(['physical', 'cash'] as const).optional(),
  exerciseTime: schema.enum(['AM', 'PM'] as const).optional(),
  currency: schema.string().optional(),
  root: schema.string().optional(),
  occSymbol: schema.string().optional(),
  deliverable: schema
    .object({
      cash: schema.number().optional(),
      shares: schema
        .array(schema.object({ symbol: schema.string().nonempty(), quantity: schema.number() }))
        .optional(),
      notes: schema.string().optional(),
    })
    .optional(),
  adjusted: schema.boolean().optional(),
});

/**
 * E2 — the contract schema validates the RESOLVED ARTIFACT cross-field, not just field shapes:
 * after the structural parse, `validateResolvedExpiry` confirms the label ↔ instant ↔ convention
 * triple is internally consistent (impossible dates, mismatched epochs, and contradictory
 * conventions all reject), and the parsed value is DEEP-frozen — the artifact (including
 * `deliverable` and its `shares[]`) stays immutable through the schema boundary exactly as it
 * left the builders.
 */
export const OptionContractSchema = transformSchema(
  OptionContractShapeSchema,
  (contract) => {
    validateResolvedExpiry(
      'OptionContractSchema',
      contract.expiry,
      contract.expiresAt,
      contract.expiryConvention,
    );
    return deepFreeze(contract);
  },
  { errorPath: ['expiresAt'] },
);

export const OptionQuoteSchema = schema.object({
  contract: OptionContractSchema,
  timestampMs: epochMs,
  bid: schema.number().optional(),
  ask: schema.number().optional(),
  bidSize: schema.number().nonnegative().optional(),
  askSize: schema.number().nonnegative().optional(),
  mid: schema.number().optional(),
  last: schema.number().optional(),
  mark: schema.number().optional(),
  volume: schema.number().nonnegative().optional(),
  openInterest: schema.number().nonnegative().optional(),
  underlyingPrice: schema.number().positive().optional(),
  impliedVolatility: schema.number().nonnegative().optional(),
  greeks: schema
    .object({
      delta: schema.number(),
      gamma: schema.number().optional(),
      theta: schema.number().optional(),
      vega: schema.number().optional(),
      rho: schema.number().optional(),
      provenance: schema
        .object({
          source: schema.string(),
          model: schema.string().optional(),
          timestampMs: epochMs.optional(),
        })
        .optional(),
    })
    .optional()
    .describe(
      'Per-share Greeks in display units (theta per day, vega per vol point, rho per 1%), with optional provenance',
    ),
  exchange: schema.string().optional(),
  conditions: conditions.optional(),
});

export const DividendSchema = schema.object({
  symbol: symbolId,
  exDate: schema.string().date(),
  payDate: schema.string().date().optional(),
  amount: schema.number(),
  currency: schema.string().optional(),
  type: schema.enum(['regular', 'special', 'returnOfCapital', 'unknown'] as const).optional(),
});

/**
 * Runtime member lists DERIVED from core's one conventions grammar in `time.ts` (2026-08-23,
 * fourth external review). The exported types are the source of truth and `satisfies
 * Record<…, true>` makes drift a COMPILE error in both directions: a member added to the type
 * breaks the record (missing key); a member misspelled or retired here breaks excess-property
 * checking. Never a second hand-maintained list.
 */
const DAY_COUNT_MEMBERS = {
  'ACT/365F': true,
  'ACT/360': true,
  '30/360': true,
} as const satisfies Record<DayCount, true>;
const DAY_COUNTS = Object.keys(DAY_COUNT_MEMBERS) as readonly DayCount[];

type NamedCompounding = Extract<InterestCompounding, string>;
const NAMED_COMPOUNDING_MEMBERS = {
  simple: true,
  continuous: true,
  annual: true,
  semiannual: true,
  quarterly: true,
  monthly: true,
} as const satisfies Record<NamedCompounding, true>;
const NAMED_COMPOUNDINGS = Object.keys(NAMED_COMPOUNDING_MEMBERS) as readonly NamedCompounding[];

/**
 * The FULL `InterestCompounding` grammar as a schema: the six named forms plus the periodic
 * object form. The periodic object is `.open()` because the runtime validator checks only
 * `type`/`periodsPerYear` and tolerates decoration — the shape must never refuse what the
 * semantic door accepts.
 */
const InterestCompoundingSchema = schema
  .union([
    schema.enum(NAMED_COMPOUNDINGS),
    schema
      .object({
        type: schema.literal('periodic'),
        periodsPerYear: schema.number().positive(),
      })
      .open(),
  ])
  .describe(
    "Interest compounding convention: 'simple' | 'continuous' | 'annual' | 'semiannual' | 'quarterly' | 'monthly' or { type: 'periodic', periodsPerYear }",
  );

/**
 * OPEN (2026-08-23, fourth external review): `RateCurvePoint` entries are documented "open to
 * vendor decoration (Law 12)" and the runtime curve validator accepts a decorated pillar, but
 * this schema was CLOSED — the one schema-vs-runtime openness misstatement in this module.
 * `.open()` validates the declared pillar shape and preserves decoration, and the emitted JSON
 * Schema now says `additionalProperties: true` instead of lying `false`.
 */
export const RateCurvePointSchema = schema
  .object({
    date: schema.string().date().describe("Pillar date, 'YYYY-MM-DD'"),
    zeroRate: schema
      .number()
      .describe("Decimal zero rate quoted under the curve's own compounding/dayCount"),
  })
  .open();

/**
 * The `RateCurve` schema is a structured-open shape ROUTED through core's ONE semantic validator
 * — a value must pass BOTH (2026-08-23, fourth external review; the routing itself dates to the
 * second review, when a purely structural schema drifted from the runtime on three counts).
 *
 * Division of labor, so neither half can lie:
 *   - STRUCTURE via the `.open()` shape below: field presence and types, the real `dayCount` and
 *     compounding grammars (derived from `time.ts`, above), the pillar item shape. This is what
 *     `toJSONSchema()` emits — complete `properties`/`required`/enums with
 *     `additionalProperties: true` — so MCP tools, agents, and generated forms see the actual
 *     contract; the old `record(unknown())` inner shape emitted a shapeless `{ type: 'object' }`.
 *   - SEMANTICS via `requireRateCurveData` (the same door the Gate B snapshot spine and Gate C
 *     pricing protocol use): pillar nonemptiness, strict date ascension, at-or-after-`asOf`,
 *     representable discount factors under the curve's own conventions, non-empty
 *     `interpolation`. The shape deliberately does NOT duplicate these laws, so their refusals
 *     keep the semantic validator's own teaching and the two doors cannot drift.
 */
const RateCurveShapeSchema = schema
  .object({
    currency: schema
      .string()
      .nonempty()
      .describe("Currency the curve discounts in (e.g. 'USD') — the curve states its own"),
    asOf: epochMs.describe('Curve valuation instant (epoch ms); every pillar is at or after it'),
    dayCount: schema
      .enum(DAY_COUNTS)
      .describe('Day-count convention the zero rates are quoted under'),
    compounding: InterestCompoundingSchema,
    points: schema
      .array(RateCurvePointSchema)
      .describe(
        'Pillar points — nonempty and strictly ascending by date (refused with teaching by the semantic validator)',
      ),
    interpolation: schema
      .string()
      .optional()
      .describe("Interpolation-name string when present (e.g. 'linearZero')"),
  })
  .open();

export const RateCurveSchema = transformSchema(RateCurveShapeSchema, (curve) =>
  requireRateCurveData('RateCurveSchema', 'curve', curve),
).describe(
  "A stored RateCurve as plain data: { currency, asOf, dayCount, compounding, points: [{ date: 'YYYY-MM-DD', zeroRate }...], interpolation? } — structural shape above, semantics by core requireRateCurveData (nonempty strictly-ascending pillars at/after asOf, representable discount factors, open to vendor decoration)",
);

export const OptionTradeSchema = schema.object({
  // OptionQuote base (OptionTrade extends OptionQuote) …
  contract: OptionContractSchema,
  timestampMs: epochMs,
  bid: schema.number().optional(),
  ask: schema.number().optional(),
  bidSize: schema.number().nonnegative().optional(),
  askSize: schema.number().nonnegative().optional(),
  mid: schema.number().optional(),
  last: schema.number().optional(),
  mark: schema.number().optional(),
  volume: schema.number().nonnegative().optional(),
  openInterest: schema.number().nonnegative().optional(),
  underlyingPrice: schema.number().positive().optional(),
  impliedVolatility: schema.number().nonnegative().optional(),
  exchange: schema.string().optional(),
  conditions: conditions.optional(),
  // … plus the trade fields.
  price: schema.number(),
  size: schema.number(),
  sequence: schema.number().optional(),
  aggressorSide: schema.enum(['buy', 'sell', 'unknown'] as const).optional(),
  premium: schema.number().optional(),
  notional: schema.number().optional(),
  openingLikely: schema.boolean().optional(),
});

export const CorporateActionSchema = schema.object({
  symbol: symbolId,
  effectiveDate: schema.string().date(),
  type: schema.enum([
    'split',
    'reverseSplit',
    'dividend',
    'symbolChange',
    'merger',
    'spinoff',
    'other',
  ] as const),
  ratio: schema.number().optional(),
  cash: schema.number().optional(),
  newSymbol: schema.string().optional(),
  details: schema.record(schema.unknown()).optional(),
});

export const OrderBookLevelSchema = schema.object({
  price: schema.number(),
  size: schema.number().nonnegative(),
  exchange: schema.string().optional(),
});

export const OrderBookSchema = schema.object({
  symbol: symbolId,
  timestampMs: epochMs,
  bids: schema.array(OrderBookLevelSchema),
  asks: schema.array(OrderBookLevelSchema),
});

export const RawFundamentalsRecordSchema = schema.object({
  symbol: symbolId,
  fiscalPeriod: schema.string().optional(),
  asOf: epochMs.optional(),
  // Matches the `RawFundamentalsRecord` interface: values are scalar-or-null, NOT arbitrary objects/booleans
  // (the old `record(unknown())` silently accepted `{ pe: { nested: true } }` and drifted from the type).
  fields: schema.record(schema.union([schema.number(), schema.string(), schema.null()])),
});

/**
 * Convenience namespace of the core payload schemas. Covers every exported market-data object type,
 * so the schema/interface drift test (`schema-parity.test.ts`) can enumerate it exhaustively (WS3.10).
 */
export const coreSchemas = {
  Bar: BarSchema,
  Quote: QuoteSchema,
  Trade: TradeSchema,
  OptionContract: OptionContractSchema,
  OptionQuote: OptionQuoteSchema,
  OptionTrade: OptionTradeSchema,
  Dividend: DividendSchema,
  CorporateAction: CorporateActionSchema,
  RateCurvePoint: RateCurvePointSchema,
  RateCurve: RateCurveSchema,
  OrderBookLevel: OrderBookLevelSchema,
  OrderBook: OrderBookSchema,
  RawFundamentalsRecord: RawFundamentalsRecordSchema,
} as const;
