/**
 * Wire schemas shared by the journey and trade operations (Stage 7B.2 slice 4 lifted them out of
 * `operations-journey.ts` so the trade pack declares the same market, ledger, and state shapes).
 * Every interior is re-validated by its read door; these schemas are the transport's first line.
 */
import { schema } from '@totalfinance/core/schema';

/**
 * The ONE valuation-instant schema for every option-pricing operation: epoch ms or a zoned ISO
 * datetime. A bare `YYYY-MM-DD` is refused by core's `resolveValuationAsOf` because a same-day
 * option's value depends on the time of day. Ledger operations (dated events) keep their own
 * date-or-instant schema.
 */
export const ValuationInstantSchema = schema
  .union([schema.number(), schema.string()])
  .describe(
    'Valuation instant — epoch ms or a zoned ISO datetime such as "2026-07-20T10:30:00-04:00". ' +
      "A bare YYYY-MM-DD is refused: a same-day option's value depends on the time of day. " +
      'For an end-of-day mark use the 16:00 ET close (13:00 ET on early-close days).',
  );

export const ProvenanceSchema = schema.object({
  provider: schema.string().optional(),
  dataset: schema.string().optional(),
  asOf: schema.number().optional(),
  receivedAt: schema.number().optional(),
  sourceVersion: schema.string().optional(),
  requestId: schema.string().optional(),
  warnings: schema.array(schema.record(schema.unknown())).optional(),
});

export const MarketSnapshotSchema = schema
  .object({
    kind: schema.literal('totalfinance.market-snapshot'),
    schemaVersion: schema.number().integer(),
    asOf: schema.number().describe('Epoch ms (resolved on the artifact)'),
    conventions: schema.object({
      conventionsVersion: schema.string(),
      asOfConvention: schema
        .enum(['explicit-instant', 'date-midnight-utc'] as const)
        .describe(
          'How asOf was expressed at create time (a bare date is refused by option pricing)',
        ),
      dayCount: schema.string().optional(),
      compounding: schema.string().optional(),
      calendar: schema.string().optional(),
    }),
    observations: schema.object({
      spots: schema.record(schema.record(schema.unknown())).optional(),
      riskFreeRates: schema.record(schema.number()).optional(),
      dividendYields: schema.record(schema.number()).optional(),
      volatilities: schema.record(schema.number()).optional(),
      curves: schema.record(schema.record(schema.unknown())).optional(),
      surfaces: schema.record(schema.record(schema.unknown())).optional(),
      chains: schema.record(schema.record(schema.unknown())).optional(),
    }),
    provenance: ProvenanceSchema.optional(),
  })
  .describe(
    'A Gate B market snapshot (totalfinance.market-snapshot); its interior is re-validated by the read door',
  );

export const CurrencyPairQuoteSchema = schema.object({
  baseCurrency: schema.string().regex(/^[A-Z]{3}$/),
  quoteCurrency: schema.string().regex(/^[A-Z]{3}$/),
  quotePerBase: schema.number().positive(),
});

export const LOT_RELIEF = ['fifo', 'lifo', 'highest-cost', 'specific-lot'] as const;

export const PortfolioLedgerEnvelopeSchema = schema
  .object({
    kind: schema.literal('totalfinance.portfolio-ledger'),
    schemaVersion: schema.number().integer(),
    portfolioId: schema.string().optional(),
    baseCurrency: schema.string(),
    lotRelief: schema.enum(LOT_RELIEF),
    events: schema
      .array(schema.record(schema.unknown()))
      .describe('Portfolio event envelopes (each re-validated by readPortfolioLedgerSnapshot)'),
    provenance: ProvenanceSchema.optional(),
  })
  .describe('A serialized portfolio ledger (totalfinance.portfolio-ledger, the FC7 JSON form)');

export const PortfolioStateSchema = schema
  .object({
    schemaVersion: schema.number().integer(),
    portfolioId: schema.string().optional(),
    baseCurrency: schema.string(),
    lotRelief: schema.enum(LOT_RELIEF),
    accounts: schema.record(schema.record(schema.unknown())),
    appliedEvents: schema.record(schema.string()),
    eventCount: schema.number().integer().nonnegative(),
    lastEffectiveTimestampMs: schema.union([schema.number(), schema.null()]),
    lotSequence: schema.number().integer().nonnegative(),
    fillEffects: schema.record(schema.record(schema.unknown())),
    reversals: schema.record(schema.string()),
    accountMigrations: schema.array(schema.record(schema.unknown())),
  })
  .describe('A derived PortfolioState (from applyPortfolioEvents or ledger.state)');
