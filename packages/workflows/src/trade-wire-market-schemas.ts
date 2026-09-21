/** The trade door's Gate-B grammar, including the deliberately open vendor observations. */
import { schema, RateCurveSchema } from '@totalfinance/core/schema';
import {
  readMarketSnapshot,
  type MarketSnapshot,
  type TableHandle,
} from '@totalfinance/core/artifacts';
import {
  TradeProvenanceSchema,
  domainWireSchema,
  type Shape,
} from './trade-wire-common-schemas.js';
const str = schema.string();
const num = schema.number();
const table = schema.object({
  kind: schema.literal('totalfinance.table-handle'),
  contentHash: str,
  rowCount: num.integer().nonnegative(),
  columnCount: num.integer().nonnegative(),
  columns: schema.array(str).optional(),
  locator: str.optional(),
  mediaType: str.optional(),
} satisfies Shape<TableHandle>);
const quote = schema
  .object({
    bid: num.optional(),
    ask: num.optional(),
    bidSize: num.optional(),
    askSize: num.optional(),
    mid: num.optional(),
    last: num.optional(),
    mark: num.optional(),
    price: num.optional(),
    size: num.optional(),
    volume: num.optional(),
    openInterest: num.optional(),
    underlyingPrice: num.optional(),
    impliedVolatility: num.optional(),
    timestampMs: num.optional(),
    sequence: num.optional(),
    premium: num.optional(),
    notional: num.optional(),
  })
  .open();
const grammar = schema.object({
  kind: schema.literal('totalfinance.market-snapshot'),
  schemaVersion: schema.literal(1),
  asOf: num.describe('Epoch milliseconds'),
  conventions: schema.object({
    conventionsVersion: str,
    asOfConvention: schema
      .enum(['explicit-instant', 'date-midnight-utc'] as const)
      .describe(
        'How asOf was expressed at create time: an instant, or a bare date (00:00 UTC of that date — refused by option pricing)',
      ),
    dayCount: schema.enum(['ACT/365F', 'ACT/360', '30/360'] as const).optional(),
    compounding: schema
      .union([
        schema.enum([
          'simple',
          'continuous',
          'annual',
          'semiannual',
          'quarterly',
          'monthly',
        ] as const),
        schema.object({ type: schema.literal('periodic'), periodsPerYear: num.positive() }).open(),
      ])
      .optional(),
    calendar: str.optional(),
  } satisfies Shape<MarketSnapshot['conventions']>),
  observations: schema.object({
    spots: schema
      .record(
        schema.object({ price: num, currency: str.optional(), timestampMs: num.optional() }).open(),
      )
      .optional(),
    riskFreeRates: schema.record(num).optional(),
    dividendYields: schema.record(num).optional(),
    volatilities: schema.record(num.nonnegative()).optional(),
    curves: schema.record(RateCurveSchema).optional(),
    surfaces: schema
      .record(
        schema.object({
          timeToExpiryYears: schema.array(num.nonnegative()),
          strikes: schema.array(num.positive()),
          impliedVolatilities: schema.array(schema.array(num.nonnegative())),
        }),
      )
      .optional(),
    chains: schema
      .record(
        schema.union([schema.object({ quotes: schema.array(quote) }), schema.object({ table })]),
      )
      .optional(),
  } satisfies Shape<MarketSnapshot['observations']>),
  provenance: TradeProvenanceSchema.optional(),
} satisfies Shape<MarketSnapshot>);
export const TradeMarketSchema = domainWireSchema(
  () => grammar.toJSONSchema(),
  (value) => readMarketSnapshot({ snapshot: value as MarketSnapshot }).snapshot,
  grammar,
);
