/**
 * The trade pack (Stage 7B.2, AT5, Decision 10): the one lifecycle through which a decision may
 * become a paper order — `trade.preflight` (no effect), `trade.authorize` (human authority into the
 * authorization store), `trade.submit` and `trade.cancel` (paper external-order effects through the
 * paper broker over the journal store), `trade.reconcile` (no effect), and
 * `portfolio.record_events` (the portfolio-state write: a content-addressed put of the new ledger).
 * Every operation is declarative: plans, policies, observations, and fills travel inline; ledgers
 * and markets inline or by handle; nothing is looked up by session.
 */
import { ErrorCode, InputError } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { schema } from '@totalfinance/core/schema';
import {
  createPaperBroker,
  type ExecutionReceipt,
  type PaperInstrument,
  type PaperStepResult,
} from '@totalfinance/backtest/paper';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  portfolioEventsFromFill,
  readPortfolioLedgerSnapshot,
  requireNormalizedFill,
  type PortfolioEventEnvelope,
  type PortfolioState,
  type PortfolioLedgerSnapshot,
} from '@totalfinance/portfolio';
import {
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
  reconcileExecution,
  requireAuthorizationGrant,
  requireExecutionJournalEvent,
  requireExecutionPlan,
  type AuthorizationGrant,
  type ExecutionJournalEvent,
} from '@totalfinance/portfolio/trade';
import { defineOperation, type OperationContext, type OperationPack } from './operation.js';
import type { ArtifactStore } from './stores.js';
import {
  prepareJournalCommit,
  type AuthorizationStore,
  type GrantConsumption,
} from './stores-trade.js';
import {
  domainWireSchema,
  tradeInputSchema,
  tradeSchemaDocument,
} from './trade-wire-common-schemas.js';
import { capRows } from './operation-kit.js';
import { TradeMarketSchema } from './trade-wire-market-schemas.js';
import {
  TradeLedgerSchema,
  TradePortfolioStateSchema,
  PortfolioEventEnvelopeSchema,
} from './trade-wire-ledger-schemas.js';
import {
  ExecutionPlanSchema,
  TradeIntentSchema,
  TradeOrderSchema,
  TradePolicySchema,
  PreflightReportSchema,
  GrantSchema,
  PreflightInstrumentSchema,
  PaperInstrumentSchema,
  ObservationsSchema,
  VarianceSchema,
  ToleranceSchema,
  CostRatesSchema,
  FillSchema,
  JournalEventSchema,
  PreflightOutputSchema,
  SubmitOutputSchema,
  ReconcileOutputSchema,
  ExternalPortfolioSchema,
  HandleSchema,
  JournalSummarySchema,
  OrderStateSchema,
} from './trade-wire-schemas.js';

const PortfolioInlineSchema = schema.union([TradeLedgerSchema, TradePortfolioStateSchema]);
// Runtime resolves handle fields before parsing. Publish both transport representations while
// keeping the operation body typed to the resolved domain value.
const PortfolioSchema = domainWireSchema(
  () =>
    schema
      .union([PortfolioInlineSchema, schema.string().regex(/^totalfinance:\/\/portfolios\//)])
      .toJSONSchema(),
  (value) => PortfolioInlineSchema.parse(value),
);
const MarketInputSchema = domainWireSchema(
  () =>
    schema
      .union([TradeMarketSchema, schema.string().regex(/^totalfinance:\/\/markets\//)])
      .toJSONSchema(),
  (value) => TradeMarketSchema.parse(value),
);
const MAX_OBSERVATIONS = 10_000;
const MAX_JOURNAL_EVENTS = 100_000;
const MAX_FILLS = 100_000;
const MAX_LEDGER_EVENTS = 100_000;

function portfolioStateOf(portfolio: PortfolioLedgerSnapshot | PortfolioState): PortfolioState {
  if ('kind' in portfolio) {
    return readPortfolioLedgerSnapshot({ snapshot: portfolio }).ledger.state;
  }
  return portfolio;
}

function refuse(id: string, field: string, message: string, code: string): never {
  throw new InputError(`${id}: ${message}`, {
    code,
    context: { operation: id, field },
  });
}

function requireStore<T>(id: string, field: string, store: T | null | undefined, what: string): T {
  if (store === null || store === undefined) {
    refuse(
      id,
      field,
      `needs the ${what} store — pass \`stores: { ${field} }\` to the runtime (the CLI's --store directory holds one; the HTTP and MCP servers take a \`stores\` option).`,
      ErrorCode.OperationHandleStoreMissing,
    );
  }
  return store;
}

function grantOf(
  id: string,
  input: { grant?: unknown; grantHash?: string },
  context: OperationContext,
): AuthorizationGrant {
  const inline =
    input.grant === undefined
      ? undefined
      : requireAuthorizationGrant(id, 'input.grant', input.grant);
  if (inline === undefined && input.grantHash === undefined)
    refuse(
      id,
      'input.grant',
      'needs the grant inline (`grant`) or by content hash (`grantHash`) from the authorization store.',
      ErrorCode.InputMissingField,
    );
  const store = requireStore(id, 'authorization', context.stores.authorization, 'authorization');
  const hash = input.grantHash ?? inline!.contentHash;
  const entry = store.get(hash);
  if (entry === null)
    refuse(
      id,
      'input.grantHash',
      `${hash} is not in the trusted authorization store — authorize first with trade:approve; an inline grant is not proof of approval.`,
      ErrorCode.OperationHandleUnknown,
    );
  const approved = requireAuthorizationGrant(id, 'authorization.grant', entry.grant);
  if (
    (inline !== undefined &&
      canonicalJsonOf(inline as unknown as Record<string, unknown>) !==
        canonicalJsonOf(approved as unknown as Record<string, unknown>)) ||
    (hash !== approved.contentHash && hash !== entry.handle.uri)
  )
    refuse(
      id,
      'input.grant',
      'must match the approved grant in the trusted authorization store exactly.',
      ErrorCode.TradeGrantInvalid,
    );
  return approved;
}

// ── trade.preflight ───────────────────────────────────────────────────────────────────────────

const PreflightInputShape = schema.object({
  plan: ExecutionPlanSchema.optional(),
  intent: TradeIntentSchema.optional(),
  portfolio: PortfolioSchema,
  market: MarketInputSchema,
  asOf: schema.number().describe('Epoch ms — the instant the plan is judged at'),
  policy: TradePolicySchema,
  costs: CostRatesSchema.optional(),
  instruments: schema.record(PreflightInstrumentSchema).optional(),
  session: schema
    .object({ open: schema.boolean(), halted: schema.array(schema.string()).optional() })
    .optional(),
  openOrders: schema.array(TradeOrderSchema).optional(),
  volumes: schema.record(schema.number().nonnegative()).optional(),
});

const PreflightInputSchema = domainWireSchema(
  () => ({
    ...PreflightInputShape.toJSONSchema(),
    oneOf: [
      { required: ['plan'], not: { required: ['intent'] } },
      { required: ['intent'], not: { required: ['plan'] } },
    ],
  }),
  (value) => {
    const input = PreflightInputShape.parse(value);
    if ((input.plan === undefined) === (input.intent === undefined))
      refuse(
        'totalfinance.trade.preflight',
        'input.plan',
        'takes exactly one of `plan` or `intent`.',
        ErrorCode.InputWrongShape,
      );
    return input;
  },
);

const tradePreflight = defineOperation({
  id: 'totalfinance.trade.preflight',
  title: 'Preflight a trade plan against the ledger, the market, and the policy',
  description:
    'Normalize an intent (or take an execution plan) and judge it: the portfolio before and after through the ' +
    "ledger's own fold of hypothetical fills, every policy check with its verdict, declared-rate cost estimates, the " +
    "monitor's alerts on the after-state, and one decision — allow only when every check passes, deny on any failure, " +
    'require-approval when evidence is missing; never an allow from missing information. No effect. Opt-in (tradePack).',
  inputSchema: tradeInputSchema(PreflightInputSchema, 'trade.preflight.input'),
  outputSchema: tradeSchemaDocument(PreflightOutputSchema.toJSONSchema(), 'trade.preflight.output'),
  // B6: proposing a trade — even a judgment of one — is a capability, held by default.
  requiredCapabilities: ['trade:propose'],
  costClass: 'small',
  handleFields: ['portfolio', 'market'],
  run: (input) => {
    const id = 'totalfinance.trade.preflight';
    const portfolio = portfolioStateOf(input.portfolio);
    if ((input.plan === undefined) === (input.intent === undefined))
      refuse(
        id,
        'input.plan',
        'takes exactly one of `plan` or `intent`.',
        ErrorCode.InputWrongShape,
      );
    const plan =
      input.plan !== undefined
        ? requireExecutionPlan(id, 'input.plan', input.plan)
        : normalizeTradePlan({
            intent: input.intent!,
            portfolio,
            market: input.market,
            asOf: input.asOf,
            ...(input.instruments !== undefined ? { instruments: input.instruments } : {}),
          });
    const report = preflightTradePlan({
      plan,
      portfolio,
      market: input.market,
      asOf: input.asOf,
      policy: input.policy,
      ...(input.costs !== undefined ? { costs: input.costs } : {}),
      ...(input.instruments !== undefined ? { instruments: input.instruments } : {}),
      ...(input.session !== undefined ? { session: input.session } : {}),
      ...(input.openOrders !== undefined
        ? { openOrders: capRows(input.openOrders, 'input.openOrders', id) }
        : {}),
      ...(input.volumes !== undefined ? { averageDailyVolumes: input.volumes } : {}),
    });
    const failed = report.checks.filter((check) => check.verdict === 'fail').length;
    return {
      summary: `preflight ${report.decision.verdict} for ${plan.orders.length} order${plan.orders.length === 1 ? '' : 's'} (${report.checks.length} checks, ${failed} failed, ${report.unverifiable.length} unverifiable); NAV ${report.before.netAssetValue.toFixed(2)} → ${report.after.netAssetValue.toFixed(2)} ${plan.baseCurrency}`,
      structured: { ...report, plan },
    };
  },
});

// ── trade.authorize ───────────────────────────────────────────────────────────────────────────

const AuthorizeInputSchema = schema.object({
  plan: ExecutionPlanSchema,
  preflight: PreflightReportSchema,
  approvedBy: schema.string().min(1),
  expiresAt: schema.number().describe('Epoch ms'),
  now: schema.number().describe('Epoch ms — the issue instant, the caller’s clock'),
  variance: VarianceSchema,
  marketMaximumAgeMs: schema.number().positive(),
  idempotencyKeys: schema.union([
    schema.array(schema.string().min(1)).min(1).max(1_000),
    schema.object({
      prefix: schema.string().min(1),
      count: schema.number().integer().min(1).max(1_000),
    }),
  ]),
  portfolioHash: schema.string().optional(),
  marketHash: schema.string().optional(),
  account: schema.string().optional(),
  grantId: schema.string().optional(),
  createdTimestampMs: schema
    .number()
    .integer()
    .describe('Epoch ms stamped on the stored grant’s handle — the caller’s clock'),
});

const tradeAuthorize = defineOperation({
  id: 'totalfinance.trade.authorize',
  title: 'Mint an authorization grant for a preflighted plan',
  description:
    'Bind human authority to one plan and one preflight report: the plan hash, the portfolio and market hashes ' +
    'preflight judged, the market instant and an age allowance, the paper mode, the account, a variance envelope, an ' +
    'expiry, the approver, and a closed set of idempotency keys. Refuses a denied preflight, an unjudged plan, or a ' +
    'stale expiry. The grant is put into the authorization store under its content hash and returned with its handle. ' +
    'Requires the trade:approve capability. Opt-in (tradePack).',
  inputSchema: tradeInputSchema(AuthorizeInputSchema, 'trade.authorize.input'),
  outputSchema: tradeSchemaDocument(
    schema
      .object({
        grant: GrantSchema,
        handle: HandleSchema,
        requiredScope: schema.union([schema.string(), schema.null()]),
      })
      .toJSONSchema(),
    'trade.authorize.output',
  ),
  authorization: 'human',
  requiredCapabilities: ['trade:approve'],
  costClass: 'small',
  run: (input, context) => {
    const id = 'totalfinance.trade.authorize';
    const store = requireStore(id, 'authorization', context.stores.authorization, 'authorization');
    const grant = createAuthorizationGrant({
      plan: requireExecutionPlan(id, 'input.plan', input.plan),
      preflight: input.preflight,
      marketMaximumAgeMs: input.marketMaximumAgeMs,
      mode: 'paper',
      variance: input.variance,
      expiresAt: input.expiresAt,
      approvedBy: input.approvedBy,
      idempotencyKeys: input.idempotencyKeys,
      now: input.now,
      ...(input.portfolioHash !== undefined ? { portfolioHash: input.portfolioHash } : {}),
      ...(input.marketHash !== undefined ? { marketHash: input.marketHash } : {}),
      ...(input.account !== undefined ? { account: input.account } : {}),
      ...(input.grantId !== undefined ? { grantId: input.grantId } : {}),
    });
    const handle = store.put({ grant, createdTimestampMs: input.createdTimestampMs });
    return {
      summary: `grant ${grant.grantId} for plan ${grant.planHash.slice(0, 19)}… by ${grant.approvedBy}, ${grant.idempotencyKeys.length} key${grant.idempotencyKeys.length === 1 ? '' : 's'}, expires ${new Date(grant.expiresAt).toISOString()}${grant.requiredScope === null ? '' : ` (scope ${grant.requiredScope})`}`,
      structured: { grant, handle, requiredScope: grant.requiredScope },
      artifacts: [handle],
    };
  },
});

// ── trade.submit ──────────────────────────────────────────────────────────────────────────────

const SubmitInputShape = schema.object({
  plan: ExecutionPlanSchema,
  grant: GrantSchema.optional(),
  grantHash: schema.string().optional(),
  idempotencyKey: schema.string().min(1),
  now: schema.number().describe('Epoch ms — the submission instant'),
  portfolioHash: schema.string(),
  marketHash: schema.string(),
  marketAsOf: schema.number(),
  sourceId: schema
    .string()
    .min(1)
    .describe(
      'The execution source (`paper:<account>` by convention); the journal id derives from it',
    ),
  accountId: schema.string().min(1),
  baseCurrency: schema.string().regex(/^[A-Z]{3}$/),
  instruments: schema.record(PaperInstrumentSchema).optional(),
  orders: schema.array(TradeOrderSchema).optional(),
  journal: schema
    .array(JournalEventSchema)
    .optional()
    .describe(
      'Optional exact canonical snapshot of the persisted journal; checked inside the transaction. Never imports or replaces history. An execution-journal store is required.',
    ),
  observations: ObservationsSchema.optional(),
  asOf: schema
    .number()
    .optional()
    .describe('Epoch ms — the instant the open orders meet the observations (default `now`)'),
});

const SubmitInputSchema = domainWireSchema(
  () => ({
    ...SubmitInputShape.toJSONSchema(),
    anyOf: [{ required: ['grant'] }, { required: ['grantHash'] }],
  }),
  (value) => SubmitInputShape.parse(value),
);

function transactBroker<T>(
  id: string,
  input: {
    sourceId: string;
    accountId: string;
    baseCurrency: string;
    instruments?: Record<string, PaperInstrument>;
    journal?: ExecutionJournalEvent[];
  },
  context: OperationContext,
  execute: (
    broker: ReturnType<typeof createPaperBroker>,
    journal: () => { journalId: string; appended: number; total: number },
  ) => T,
  authority?: { store: AuthorizationStore; grantHash: string; idempotencyKey: string; now: number },
): T {
  const journalId = `${input.sourceId}:journal`;
  const store = requireStore(id, 'journal', context.stores.journal, 'execution-journal');
  const authorization = requireStore(
    id,
    'authorization',
    context.stores.authorization,
    'authorization',
  );
  const inline = input.journal !== undefined;
  if (inline && input.journal!.length > MAX_JOURNAL_EVENTS)
    refuse(
      id,
      'input.journal',
      `holds ${input.journal!.length} events; at most ${MAX_JOURNAL_EVENTS}.`,
      ErrorCode.OperationInputTooLarge,
    );
  const supplied: ExecutionJournalEvent[] | undefined = inline
    ? input.journal!.map((event, index) =>
        requireExecutionJournalEvent(id, `input.journal[${index}]`, event),
      )
    : undefined;
  return store.transact({
    journalId,
    execute: (prior) => {
      // This read happens under the journal lock. consume below is the cross-journal atomic
      // compare-and-set, so competing sources/stores cannot both commit the same authority.
      const consumed = authority?.store.get(authority.grantHash)?.consumed ?? null;
      if (
        authority !== undefined &&
        (typeof store.storeId !== 'string' || store.storeId.length === 0)
      )
        refuse(
          id,
          'stores.journal.storeId',
          'requires a stable non-empty storage identity.',
          ErrorCode.InputMissingField,
        );
      if (
        consumed !== null &&
        (consumed.journalStoreId !== store.storeId ||
          consumed.journalId !== journalId ||
          consumed.idempotencyKey !== authority!.idempotencyKey ||
          !Array.isArray(consumed.journalEvents))
      )
        refuse(
          id,
          'input.grantHash',
          'this grant already licenses a submission in another store, journal or key (or lacks recovery facts); use the original stores and key, or authorize a new grant.',
          ErrorCode.TradeGrantConsumed,
        );
      // Inline history is an optimistic concurrency assertion, never a replacement or an import.
      if (
        supplied !== undefined &&
        canonicalJsonOf({ events: supplied }) !== canonicalJsonOf({ events: prior })
      )
        refuse(
          id,
          'input.journal',
          'must match the complete persisted journal; read the current history and retry. Inline history cannot replace authoritative state.',
          ErrorCode.TradeJournalTransitionInvalid,
        );
      // Recover ALL prepared submissions before allocating any more identities, including on
      // cancellation. Otherwise another grant could reuse IDs reserved by a failed commit.
      // A later uncommitted batch includes any earlier pending batches it recovered; longest
      // batches first preserve that append order. Already-committed facts deduplicate exactly.
      const prepared = authorization
        .list()
        .map((handle) => authorization.get(handle.uri)?.consumed)
        .filter(
          (record): record is GrantConsumption =>
            record != null &&
            record.journalStoreId === store.storeId &&
            record.journalId === journalId,
        )
        .sort((a, b) => b.journalEvents.length - a.journalEvents.length);
      let restored = [...prior];
      for (const record of prepared)
        restored = prepareJournalCommit(journalId, restored, record.journalEvents).events;
      const broker = createPaperBroker({
        baseCurrency: input.baseCurrency,
        sourceId: input.sourceId,
        accountId: input.accountId,
        ...(input.instruments !== undefined ? { instruments: input.instruments } : {}),
        ...(restored.length > 0 ? { journal: restored } : {}),
      });
      if (
        consumed !== null &&
        !broker
          .receipts()
          .some(
            (receipt) =>
              receipt.receiptId === consumed.receiptId &&
              receipt.grantHash === authority!.grantHash &&
              receipt.idempotencyKey === authority!.idempotencyKey,
          )
      )
        refuse(
          id,
          'input.grantHash',
          'the consumed grant has no recoverable original receipt; restore its authoritative journal. It cannot authorize a new submission.',
          ErrorCode.TradeGrantConsumed,
        );
      const result = execute(broker, () => ({
        journalId,
        appended: broker.journal().length - prior.length,
        total: broker.journal().length,
      }));
      const events = broker.journal().slice(prior.length);
      // Validate the batch before spending authority. Persist the exact submission FIRST: if the
      // journal commit fails or the process exits, retry can append these facts without execution.
      prepareJournalCommit(journalId, prior, events);
      if (authority !== undefined && consumed === null) {
        const receipt = broker
          .receipts()
          .find((candidate) => candidate.idempotencyKey === authority.idempotencyKey);
        if (receipt === undefined)
          refuse(
            id,
            'input.idempotencyKey',
            'submission did not produce a receipt.',
            ErrorCode.TradeJournalTransitionInvalid,
          );
        if (receipt.grantHash !== authority.grantHash)
          refuse(
            id,
            'input.grantHash',
            'this receipt belongs to a different grant; retry with the original authority and key.',
            ErrorCode.TradeGrantInvalid,
          );
        const consumption: GrantConsumption = {
          journalStoreId: store.storeId,
          journalId,
          receiptId: receipt.receiptId,
          idempotencyKey: authority.idempotencyKey,
          consumedTimestampMs: authority.now,
          journalEvents: events,
        };
        authority.store.consume({ hashOrUri: authority.grantHash, ...consumption });
      }
      return { events, result };
    },
  });
}

function recoveryForReceipt(
  journal: readonly ExecutionJournalEvent[],
  receipt: ExecutionReceipt,
): Pick<PaperStepResult, 'fills' | 'events'> {
  const orderIds = new Set(receipt.orders.map((order) => order.orderId));
  const recovery: Pick<PaperStepResult, 'fills' | 'events'> = { fills: [], events: [] };
  for (const [index, event] of journal.entries()) {
    if (
      event.planHash !== receipt.planHash ||
      !orderIds.has(event.orderId) ||
      (event.eventType !== 'filled' && event.eventType !== 'partially-filled')
    )
      continue;
    const fill = event.detail.fill;
    if (fill === undefined)
      refuse(
        'totalfinance.trade.submit',
        `journal[${index}].detail.fill`,
        'recovery requires the persisted normalized fill; incomplete legacy facts must be recovered explicitly.',
        ErrorCode.InputMissingField,
      );
    recovery.fills.push(fill);
    recovery.events.push(
      ...portfolioEventsFromFill({
        fill,
        sourceId: event.sourceId,
        recordedTimestampMs: event.timestampMs,
      }),
    );
  }
  return recovery;
}

const tradeSubmit = defineOperation({
  id: 'totalfinance.trade.submit',
  title: 'Submit an authorized plan to the paper broker',
  description:
    'Verify the grant against the plan, the portfolio and market hashes, the market instant, the account, and the ' +
    'idempotency key; journal submitted and acknowledged; return the content-addressed receipt — the SAME receipt for ' +
    'a retry with the same key and plan (no second order), trade.idempotency_conflict for the same key with another ' +
    "plan, trade.grant_expired for an expired grant. With `observations`, the open orders meet the market through the engines' " +
    'own fill path. Top-level fills/events are only this call’s new deltas; the submission receipt is immutable. ' +
    '`recovery: { fills, events }` contains all persisted normalized fills and reproducible ledger envelopes for this ' +
    'receipt’s orders, including this call’s fills. Retry after a lost response and apply recovery.events with ' +
    'portfolio.record_events; identical events fold once. Recovery grows with later fills without replaying the fill engine. The ' +
    'journal continues transactionally from the required journal store under `<sourceId>:journal`; retries must retain that ' +
    'store and source. A grant atomically records its exact prepared submission before journal commit: a retry with the same key into the same store/journal ' +
    'recovers those events and reads the same receipt; any other submission of the grant is trade.grant_consumed. Every journal write recovers earlier pending submissions before allocating new identities. Inline history must match persisted history exactly. ' +
    'Inline grants must exist unchanged in the trusted authorization store. Paper only; requires trade:paper. Opt-in (tradePack).',
  inputSchema: tradeInputSchema(SubmitInputSchema, 'trade.submit.input'),
  outputSchema: tradeSchemaDocument(SubmitOutputSchema.toJSONSchema(), 'trade.submit.output'),
  sideEffect: 'external-order',
  authorization: 'policy',
  idempotency: 'required',
  requiredCapabilities: ['trade:paper'],
  costClass: 'small',
  run: (input, context) => {
    const id = 'totalfinance.trade.submit';
    const grant = grantOf(id, input, context);
    // B6: a consumed grant licenses nothing but the retry of its own submission.
    const authorization = requireStore(
      id,
      'authorization',
      context.stores.authorization,
      'authorization',
    );
    const outcome = transactBroker(
      id,
      input,
      context,
      (broker, journalSummary) => {
        const before = broker.receipts().length;
        const receipt = broker.submit({
          plan: requireExecutionPlan(id, 'input.plan', input.plan),
          grant,
          idempotencyKey: input.idempotencyKey,
          now: input.now,
          portfolioHash: input.portfolioHash,
          marketHash: input.marketHash,
          marketAsOf: input.marketAsOf,
          ...(input.orders !== undefined ? { orders: input.orders } : {}),
        });
        const retried = broker.receipts().length === before;
        let fills: PaperStepResult['fills'] = [];
        let events: PortfolioEventEnvelope[] = [];
        let open: string[] = broker.openOrders().map((order) => order.orderId);
        let expired: string[] = [];
        let unfilled: PaperStepResult['unfilled'] = [];
        if (input.observations !== undefined) {
          const count = Object.keys(input.observations).length;
          if (count > MAX_OBSERVATIONS)
            refuse(
              id,
              'input.observations',
              `holds ${count} observations; at most ${MAX_OBSERVATIONS} per call.`,
              ErrorCode.OperationInputTooLarge,
            );
          const stepped = broker.step({
            observations: input.observations,
            asOf: input.asOf ?? input.now,
          });
          fills = stepped.fills;
          events = stepped.events;
          open = stepped.open;
          expired = stepped.expired;
          unfilled = stepped.unfilled;
        }
        // This snapshot includes the new batch, but transact exposes it only after that batch commits.
        // Fill events need not carry a key: the immutable receipt identifies exactly its submitted orders.
        const recovery = recoveryForReceipt(broker.journal(), receipt);
        const journal = journalSummary();
        return {
          summary: `${retried ? 'retry: the same receipt' : `receipt ${receipt.receiptId}`} for plan ${receipt.planHash.slice(0, 19)}… (${receipt.orders.length} order${receipt.orders.length === 1 ? '' : 's'}); ${fills.length} fill${fills.length === 1 ? '' : 's'}, ${open.length} open, ${expired.length} expired; journal ${journal.journalId} +${journal.appended}`,
          structured: {
            receipt,
            retried,
            fills,
            events,
            recovery,
            journal,
            open,
            expired,
            unfilled,
          },
        };
      },
      {
        store: authorization,
        grantHash: grant.contentHash,
        idempotencyKey: input.idempotencyKey,
        now: input.now,
      },
    );
    return outcome;
  },
});

// ── trade.cancel ──────────────────────────────────────────────────────────────────────────────

const CancelInputSchema = schema.object({
  orderId: schema.string().min(1),
  now: schema.number(),
  sourceId: schema.string().min(1),
  accountId: schema.string().min(1),
  baseCurrency: schema.string().regex(/^[A-Z]{3}$/),
  idempotencyKey: schema.string().min(1).optional(),
  journal: schema
    .array(JournalEventSchema)
    .optional()
    .describe(
      'Optional exact canonical snapshot of the persisted journal; checked inside the transaction. Never imports or replaces history. An execution-journal store is required.',
    ),
});

const tradeCancel = defineOperation({
  id: 'totalfinance.trade.cancel',
  title: 'Cancel an open paper order',
  description:
    'Journal cancel-requested then cancelled for an open order in the journal store under `<sourceId>:journal`; a ' +
    'terminal order is not cancelled twice (accepted: false, the state says why). Cancelling a combo leg cancels all remaining legs of that plan-local combo. Both the original journal and authorization stores are required to recover pending submissions before cancellation; no new grant is needed. A fill delivered after the ' +
    "cancellation is Decision 6's late-fill path. Paper only; requires trade:paper. Opt-in (tradePack).",
  inputSchema: tradeInputSchema(CancelInputSchema, 'trade.cancel.input'),
  outputSchema: tradeSchemaDocument(
    schema
      .object({
        orderId: schema.string(),
        accepted: schema.boolean(),
        state: OrderStateSchema,
        journal: JournalSummarySchema,
      })
      .toJSONSchema(),
    'trade.cancel.output',
  ),
  sideEffect: 'external-order',
  authorization: 'policy',
  idempotency: 'optional',
  requiredCapabilities: ['trade:paper'],
  costClass: 'small',
  run: (input, context) => {
    const id = 'totalfinance.trade.cancel';
    return transactBroker(id, input, context, (broker, journalSummary) => {
      const result = broker.cancel({ orderId: input.orderId, now: input.now });
      const journal = journalSummary();
      return {
        summary: `${result.accepted ? 'cancelled' : `not cancelled (already ${result.state.state})`} ${input.orderId}; journal ${journal.journalId} +${journal.appended}`,
        structured: {
          orderId: result.orderId,
          accepted: result.accepted,
          state: result.state,
          journal,
        },
      };
    });
  },
});

// ── trade.reconcile ───────────────────────────────────────────────────────────────────────────

const ReconcileInputShape = schema.object({
  journalId: schema.string().min(1).optional(),
  journal: schema.array(JournalEventSchema).optional(),
  ledger: PortfolioSchema,
  sourceId: schema.string().min(1),
  fills: schema.array(FillSchema),
  external: ExternalPortfolioSchema.optional(),
  asOf: schema.number(),
  tolerance: ToleranceSchema,
  planHash: schema.string().optional(),
});

const ReconcileInputSchema = domainWireSchema(
  () => ({
    ...ReconcileInputShape.toJSONSchema(),
    oneOf: [
      { required: ['journalId'], not: { required: ['journal'] } },
      { required: ['journal'], not: { required: ['journalId'] } },
    ],
  }),
  (value) => {
    const input = ReconcileInputShape.parse(value);
    if ((input.journalId === undefined) === (input.journal === undefined))
      refuse(
        'totalfinance.trade.reconcile',
        'input.journal',
        'takes exactly one of `journalId` (from the journal store) or `journal` (inline events).',
        ErrorCode.InputWrongShape,
      );
    return input;
  },
);

const tradeReconcile = defineOperation({
  id: 'totalfinance.trade.reconcile',
  title: 'Reconcile an execution journal to the ledger',
  description:
    "Join the journal's order states (from the journal store by `journalId`, or inline events) to the ledger's fills " +
    'under the execution source in both directions, compare delivered fill quantities per order within an explicit ' +
    'tolerance, list the unresolved orders, and — with an external snapshot — compose reconcilePortfolio verbatim. ' +
    'reconciled is true only when everything agrees and no order is unresolved. No effect; requires trade:paper. Opt-in (tradePack).',
  inputSchema: tradeInputSchema(ReconcileInputSchema, 'trade.reconcile.input'),
  outputSchema: tradeSchemaDocument(ReconcileOutputSchema.toJSONSchema(), 'trade.reconcile.output'),
  requiredCapabilities: ['trade:paper'],
  costClass: 'small',
  handleFields: ['ledger'],
  run: (input, context) => {
    const id = 'totalfinance.trade.reconcile';
    if ((input.journalId === undefined) === (input.journal === undefined))
      refuse(
        id,
        'input.journal',
        'takes exactly one of `journalId` (from the journal store) or `journal` (inline events).',
        ErrorCode.InputWrongShape,
      );
    let events: ExecutionJournalEvent[];
    if (input.journalId !== undefined) {
      const store = requireStore(id, 'journal', context.stores.journal, 'execution-journal');
      events = store.read(input.journalId);
    } else {
      if (input.journal!.length > MAX_JOURNAL_EVENTS)
        refuse(
          id,
          'input.journal',
          `holds ${input.journal!.length} events; at most ${MAX_JOURNAL_EVENTS}.`,
          ErrorCode.OperationInputTooLarge,
        );
      events = input.journal!.map((event, index) =>
        requireExecutionJournalEvent(id, `input.journal[${index}]`, event),
      );
    }
    if (input.fills.length > MAX_FILLS)
      refuse(
        id,
        'input.fills',
        `holds ${input.fills.length} fills; at most ${MAX_FILLS}.`,
        ErrorCode.OperationInputTooLarge,
      );
    input.fills.forEach((fill, index) => requireNormalizedFill(id, `input.fills[${index}]`, fill));
    const report = reconcileExecution({
      journal: events,
      ledger: portfolioStateOf(input.ledger),
      sourceId: input.sourceId,
      fills: input.fills,
      asOf: input.asOf,
      tolerance: input.tolerance,
      ...(input.external !== undefined ? { external: input.external } : {}),
      ...(input.planHash !== undefined ? { planHash: input.planHash } : {}),
    });
    return {
      summary: `${report.reconciled ? 'reconciled' : 'NOT reconciled'}: ${report.orders.length} order${report.orders.length === 1 ? '' : 's'}, ${report.diagnostics.differenceCount} difference${report.diagnostics.differenceCount === 1 ? '' : 's'}, ${report.unresolved.length} unresolved${report.portfolio === null ? '' : `; portfolio ${report.portfolio.reconciled ? 'agrees' : 'differs'}`}`,
      structured: { ...report },
    };
  },
});

// ── portfolio.record_events ───────────────────────────────────────────────────────────────────

const RecordEventsInputSchema = schema.object({
  portfolio: PortfolioSchema,
  events: schema
    .array(PortfolioEventEnvelopeSchema)
    .min(1)
    .describe('Portfolio event envelopes to apply, in order'),
  createdTimestampMs: schema
    .number()
    .integer()
    .describe('Epoch ms stamped on the new ledger’s handle — the caller’s clock'),
});

const portfolioRecordEvents = defineOperation({
  id: 'totalfinance.portfolio.record_events',
  title: 'Apply events to a ledger and store the new ledger',
  description:
    "Fold validated portfolio events (fills from trade.submit, deposits, corporate actions) onto a ledger through the ledger's " +
    'own reducer and put the new ledger into the artifact store as a content-addressed portfolio handle. The write is ' +
    'the put: an unchanged ledger is the same handle, a replayed event is refused by the fold. Requires a writable ' +
    'artifact store and the portfolio:write capability. Opt-in (tradePack).',
  inputSchema: tradeInputSchema(RecordEventsInputSchema, 'portfolio.record_events.input'),
  outputSchema: tradeSchemaDocument(
    schema
      .object({
        handle: HandleSchema,
        applied: schema.number().integer().nonnegative(),
        eventCount: schema.number().integer().nonnegative(),
        baseCurrency: schema.string(),
        lastEffectiveTimestampMs: schema.union([schema.number(), schema.null()]),
      })
      .toJSONSchema(),
    'portfolio.record_events.output',
  ),
  sideEffect: 'portfolio-state',
  idempotency: 'required',
  requiredCapabilities: ['portfolio:write'],
  costClass: 'small',
  handleFields: ['portfolio'],
  run: (input, context) => {
    const id = 'totalfinance.portfolio.record_events';
    const artifacts = context.artifacts as ArtifactStore | null;
    if (artifacts === null || typeof artifacts.put !== 'function')
      refuse(
        id,
        'artifacts',
        'needs a WRITABLE artifact store (put) to store the new ledger — pass one to the runtime.',
        ErrorCode.OperationHandleStoreMissing,
      );
    if (input.events.length > MAX_LEDGER_EVENTS)
      refuse(
        id,
        'input.events',
        `holds ${input.events.length} events; at most ${MAX_LEDGER_EVENTS} per call.`,
        ErrorCode.OperationInputTooLarge,
      );
    const previous = portfolioStateOf(input.portfolio);
    const state = applyPortfolioEvents({ previousState: previous, events: input.events });
    // The stored form is the ledger envelope: every applied event in order, re-hydratable by the read door.
    const priorEvents = 'kind' in input.portfolio ? input.portfolio.events : null;
    if (priorEvents === null)
      refuse(
        id,
        'input.portfolio',
        'must be the serialized ledger envelope (totalfinance.portfolio-ledger) — a derived state cannot be stored as a ledger; read it from its handle or pass the envelope.',
        ErrorCode.InputWrongShape,
      );
    const ledger = createPortfolioLedger({
      baseCurrency: previous.baseCurrency,
      lotRelief: previous.lotRelief,
      ...(previous.portfolioId !== undefined ? { portfolioId: previous.portfolioId } : {}),
      events: [...priorEvents, ...input.events],
    });
    const handle = artifacts.put({
      value: ledger.toJSON() as unknown as Record<string, unknown>,
      kind: 'portfolio',
      createdTimestampMs: input.createdTimestampMs,
    });
    return {
      summary: `${input.events.length} event${input.events.length === 1 ? '' : 's'} applied; ledger now ${state.eventCount} events → ${handle.uri}`,
      structured: {
        handle,
        applied: input.events.length,
        eventCount: state.eventCount,
        baseCurrency: state.baseCurrency,
        lastEffectiveTimestampMs: state.lastEffectiveTimestampMs,
      },
      artifacts: [handle],
    };
  },
});

export function tradePack(): OperationPack {
  return {
    name: 'trade',
    operations: [
      tradePreflight,
      tradeAuthorize,
      tradeSubmit,
      tradeCancel,
      tradeReconcile,
      portfolioRecordEvents,
    ],
  };
}
