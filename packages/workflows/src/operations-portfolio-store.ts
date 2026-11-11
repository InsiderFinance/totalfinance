/** Explicit bootstrap and bounded inspection over the existing event-derived ledger/store. */
import { ErrorCode, InputError } from '@totalfinance/core';
import { schema } from '@totalfinance/core/schema';
import { createPortfolioLedger, readPortfolioLedgerSnapshot } from '@totalfinance/portfolio';
import { defineOperation } from './operation.js';
import type { ArtifactStore } from './stores.js';
import { boundedPreview } from './preview.js';
import { LOT_RELIEF } from './wire-schemas.js';
import { TradeLedgerSchema, PortfolioEventEnvelopeSchema } from './trade-wire-ledger-schemas.js';
import { HandleSchema } from './trade-wire-schemas.js';
import {
  domainWireSchema,
  TradeProvenanceSchema,
  tradeInputSchema,
  tradeSchemaDocument,
} from './trade-wire-common-schemas.js';

export const portfolioCreate = defineOperation({
  id: 'totalfinance.portfolio.create',
  title: 'Create and store an explicitly defined portfolio ledger',
  description:
    'Start here before portfolio.record_events: supply durable portfolioId, baseCurrency and explicit initial events (an empty array creates no cash). Uses the existing artifact store and ledger reducer. Requires portfolio:write and a writable store. Save the returned handle and open it with portfolio.inspect from portfolioPack (enable both trade and portfolio packs, or use --profile full); subsequent event writes return a new immutable handle. Opt-in (tradePack).',
  inputSchema: tradeInputSchema(
    schema.object({
      portfolioId: schema.string().min(1),
      baseCurrency: schema.string().regex(/^[A-Z]{3}$/),
      lotRelief: schema
        .enum(LOT_RELIEF)
        .optional()
        .describe('Existing ledger default: fifo, echoed in the stored ledger'),
      events: schema
        .array(PortfolioEventEnvelopeSchema)
        .max(100_000)
        .describe('Explicit initial events; [] means an empty, unfunded portfolio'),
      provenance: TradeProvenanceSchema.optional(),
      createdTimestampMs: schema.number().integer().describe('Caller clock in epoch milliseconds'),
    }),
    'portfolio.create.input',
  ),
  outputSchema: tradeSchemaDocument(
    schema
      .object({
        handle: HandleSchema,
        portfolioId: schema.string(),
        baseCurrency: schema.string(),
        eventCount: schema.number().integer().nonnegative(),
        lotRelief: schema.enum(LOT_RELIEF),
        inspectOperation: schema.literal('totalfinance.portfolio.inspect'),
      })
      .toJSONSchema(),
    'portfolio.create.output',
  ),
  sideEffect: 'portfolio-state',
  idempotency: 'required',
  requiredCapabilities: ['portfolio:write'],
  run: (input, context) => {
    const store = context.artifacts as ArtifactStore | null;
    if (store === null || typeof store.put !== 'function') {
      throw new InputError(
        'portfolio.create: pass a writable artifact store (CLI/MCP --store) to retain the ledger and resolve its handle.',
        {
          code: ErrorCode.OperationHandleStoreMissing,
          context: { field: 'artifacts' },
        },
      );
    }
    const { createdTimestampMs, ...definition } = input;
    const ledger = createPortfolioLedger(definition);
    const handle = store.put({
      value: ledger.toJSON() as unknown as Record<string, unknown>,
      kind: 'portfolio',
      createdTimestampMs,
    });
    return {
      summary: `Created ${input.portfolioId}: ${ledger.state.eventCount} explicit events → ${handle.uri}; open with totalfinance.portfolio.inspect (portfolio pack; requires portfolio:read)`,
      structured: {
        handle,
        portfolioId: input.portfolioId,
        baseCurrency: ledger.baseCurrency,
        eventCount: ledger.state.eventCount,
        lotRelief: ledger.lotRelief,
        inspectOperation: 'totalfinance.portfolio.inspect' as const,
      },
      artifacts: [handle],
    };
  },
});

export const portfolioInspect = defineOperation({
  id: 'totalfinance.portfolio.inspect',
  title: 'Open a portfolio ledger or handle and inspect a bounded page',
  description:
    'Open a returned totalfinance://portfolios/... handle through the same configured store, or import an inline serialized ledger for read-only inspection. Revalidates and replays the ledger. Summary returns identity/counts; events, positions and cash return bounded previews (default 20, maximum 100 rows). This does not value the portfolio; use portfolio.snapshot with explicit marks. Opt-in (portfolioPack).',
  inputSchema: tradeInputSchema(
    schema.object({
      portfolio: domainWireSchema(
        () =>
          schema
            .union([
              TradeLedgerSchema,
              schema.string().regex(/^totalfinance:\/\/portfolios\//),
              HandleSchema,
            ])
            .toJSONSchema(),
        (value) => TradeLedgerSchema.parse(value),
      ),
      section: schema.enum(['summary', 'events', 'positions', 'cash'] as const).optional(),
      offset: schema.number().integer().nonnegative().optional(),
      limit: schema.number().integer().min(1).max(100).optional(),
    }),
    'portfolio.inspect.input',
  ),
  outputSchema: schema
    .object({
      portfolioId: schema.union([schema.string(), schema.null()]),
      baseCurrency: schema.string(),
      lotRelief: schema.enum(LOT_RELIEF),
      eventCount: schema.number().integer().nonnegative(),
      accountCount: schema.number().integer().nonnegative(),
      lastEffectiveTimestampMs: schema.union([schema.number(), schema.null()]),
      section: schema.enum(['summary', 'events', 'positions', 'cash'] as const),
      offset: schema.number().integer().nonnegative(),
      limit: schema.number().integer().positive(),
      total: schema.number().integer().nonnegative(),
      nextOffset: schema.union([schema.number(), schema.null()]),
      rows: schema.array(schema.record(schema.unknown())),
    })
    .toJSONSchema(),
  requiredCapabilities: ['portfolio:read'],
  handleFields: ['portfolio'],
  run: (input) => {
    const { ledger } = readPortfolioLedgerSnapshot({ snapshot: input.portfolio });
    const section = input.section ?? 'summary';
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;
    const rows: Record<string, unknown>[] = [];
    let total = 0;
    const add = (value: Record<string, unknown>): void => {
      if (total >= offset && rows.length < limit) rows.push(value);
      total += 1;
    };
    if (section === 'events') {
      for (const event of ledger.events) {
        add({
          ...boundedPreview(event as unknown as Record<string, unknown>),
          event: boundedPreview(event.event as unknown as Record<string, unknown>),
        });
      }
    } else if (section === 'positions' || section === 'cash') {
      for (const [accountId, account] of Object.entries(ledger.state.accounts).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      )) {
        if (section === 'positions') {
          for (const [instrumentId, position] of Object.entries(account.positions).sort(
            ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
          )) {
            add({
              accountId,
              instrumentId,
              ...boundedPreview(position as unknown as Record<string, unknown>),
            });
          }
        } else {
          for (const [currency, cash] of Object.entries(account.cashBalances).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          )) {
            add({
              accountId,
              currency,
              ...boundedPreview(cash as unknown as Record<string, unknown>),
            });
          }
        }
      }
    }
    return {
      summary: `${ledger.portfolioId ?? 'Unnamed portfolio'}: ${ledger.state.eventCount} events; ${section} ${rows.length}/${total} rows`,
      structured: {
        portfolioId: ledger.portfolioId ?? null,
        baseCurrency: ledger.baseCurrency,
        lotRelief: ledger.lotRelief,
        eventCount: ledger.state.eventCount,
        accountCount: Object.keys(ledger.state.accounts).length,
        lastEffectiveTimestampMs: ledger.state.lastEffectiveTimestampMs,
        section,
        offset,
        limit,
        total,
        nextOffset: offset + rows.length < total ? offset + rows.length : null,
        rows,
      },
    };
  },
});
