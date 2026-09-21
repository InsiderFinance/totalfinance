/** Trade wire grammar. The schema facade owns validation AND JSON Schema projection.
 * `Shape<T>` makes every domain field (including optional fields) a compile-time obligation;
 * the trade-pack parity tests also compare discriminants and exercise the domain read doors.
 * Economic/hash/state-transition validation remains with those doors, never duplicated here.
 */
import {
  schema,
  BarSchema,
  QuoteSchema,
  TradeSchema,
  OrderBookSchema,
  type Schema,
} from '@totalfinance/core/schema';
import type {
  AuthorizationGrant,
  ExecutionPlan,
  ExecutionPlanCombo,
  TradeIntent,
  TradeIntentCombo,
  TradeOrder,
  TradeIntentOrder,
  TradePolicy,
  PreflightInstrument,
  PreflightCostRates,
  PolicyCheck,
  PolicyDecision,
  PreflightReport,
  ExecutionJournalDetail,
  ExecutionJournalEvent,
  ExecutionOrderState,
  ReconciliationReport,
} from '@totalfinance/portfolio/trade';
import {
  requireTradeOrder,
  requireTradeIntent,
  requireExecutionPlan,
  requireTradePolicy,
  requirePreflightReport,
  requireAuthorizationGrant,
  requireExecutionJournalEvent,
  EXECUTION_JOURNAL_EVENT_TYPES,
  TRADE_PLAN_ORDER_CEILING,
} from '@totalfinance/portfolio/trade';
import type {
  PaperInstrument,
  ExecutionReceipt,
  PaperStepResult,
} from '@totalfinance/backtest/paper';
import type {
  MarketObservation,
  ExecutionPolicyDescription,
} from '@totalfinance/backtest/execution';
import type {
  NormalizedFill,
  PortfolioSnapshotResult,
  PolicyLimits,
  ExternalPortfolioSnapshot,
  ReconcilePortfolioResult,
  PortfolioMonitorState,
  MonitorAlert,
} from '@totalfinance/portfolio';
import type { ResourceHandle } from './operation.js';
import { CurrencyPairQuoteSchema, LOT_RELIEF } from './wire-schemas.js';
import { PortfolioEventEnvelopeSchema } from './trade-wire-ledger-schemas.js';
import {
  ContractSchema,
  TradeProvenanceSchema,
  WarningSchema,
  domainWireSchema,
  type Shape,
} from './trade-wire-common-schemas.js';
const str = schema.string();
const id = str.min(1);
const num = schema.number();
const positive = num.positive();
const nonnegative = num.nonnegative();
const count = nonnegative.integer();
const epoch = num.describe('Epoch milliseconds');
const currency = str.regex(/^[A-Z]{3}$/);
const strings = schema.array(str);
const nullableNumber = schema.union([num, schema.null()]);
const nullableString = schema.union([str, schema.null()]);
const scalar = schema.union([num, str, schema.null()]);
const side = schema.enum(['buy', 'sell'] as const);
const timeInForce = schema
  .enum(['day', 'gtc'] as const)
  .describe('Default: the paper execution policy’s day time-in-force');
const orderTypes = schema.enum([
  'market',
  'limit',
  'stop',
  'stop-limit',
  'market-on-open',
  'market-on-close',
] as const);
const settlementStyle = schema.enum(['cash-on-trade', 'variation-margin'] as const);

// Build every price/sizing combination from the same fields, not a second JSON shape table.
const orderBase = {
  instrumentId: id,
  side,
  timeInForce: timeInForce.optional(),
  comboId: id.optional().describe('The multi-leg order this is a leg of (B5)'),
};
function priceVariants<S extends Record<string, Schema<unknown>>>(base: S) {
  return schema.union([
    schema.object({ ...base, type: schema.literal('market') }),
    schema.object({ ...base, type: schema.literal('market-on-open') }),
    schema.object({ ...base, type: schema.literal('market-on-close') }),
    schema.object({ ...base, type: schema.literal('limit'), limitPrice: positive }),
    schema.object({ ...base, type: schema.literal('stop'), stopPrice: positive }),
    schema.object({
      ...base,
      type: schema.literal('stop-limit'),
      limitPrice: positive,
      stopPrice: positive,
    }),
  ]);
}
const TradeOrderGrammar = priceVariants({
  ...orderBase,
  orderId: id,
  quantity: positive.describe('Units/contracts, strictly positive; side carries direction'),
  plannedTimestampMs: epoch.describe('When the plan was made — never when a broker saw the order'),
  submittedTimestampMs: epoch
    .optional()
    .describe('Stamped by the broker at submission; absent on a plan’s order'),
}) satisfies Schema<TradeOrder>;
export const TradeOrderSchema = domainWireSchema(
  () => TradeOrderGrammar.toJSONSchema(),
  (value) => requireTradeOrder('trade wire', 'TradeOrder', value),
  TradeOrderGrammar,
);
export const TradeIntentOrderSchema = schema.union([
  priceVariants({ ...orderBase, quantity: positive }),
  priceVariants({
    ...orderBase,
    notionalWeight: positive
      .max(1)
      .describe(
        'Notional as a fraction of NAV at the mark, (0, 1]; mutually exclusive with quantity',
      ),
  }),
]) satisfies Schema<TradeIntentOrder>;
const TradeIntentGrammar = schema.object({
  kind: schema.literal('totalfinance.trade-intent'),
  schemaVersion: schema.literal(1),
  accountId: id,
  asOf: epoch,
  orders: schema.array(TradeIntentOrderSchema).min(1).max(TRADE_PLAN_ORDER_CEILING),
  combos: schema
    .array(
      schema.object({
        comboId: id,
        netLimitPrice: num
          .optional()
          .describe('Net limit per combo unit: debit positive (pay at most), credit negative'),
      } satisfies Shape<TradeIntentCombo>),
    )
    .optional(),
  rationale: str.optional(),
  evidence: strings.optional(),
} satisfies Shape<TradeIntent>);
export const TradeIntentSchema = domainWireSchema(
  () => TradeIntentGrammar.toJSONSchema(),
  (value) => requireTradeIntent('trade wire', 'TradeIntent', value),
  TradeIntentGrammar,
);
const ExecutionPlanGrammar = schema.object({
  kind: schema.literal('totalfinance.execution-plan'),
  schemaVersion: schema.literal(1),
  accountId: id,
  asOf: epoch,
  baseCurrency: currency,
  portfolioId: id.optional(),
  orders: schema.array(TradeOrderSchema).min(1).max(TRADE_PLAN_ORDER_CEILING),
  combos: schema.array(
    schema.object({
      comboId: id,
      orderIds: schema.array(id).min(2).describe('The legs, in plan order (at least two)'),
      netLimitPrice: num.optional(),
    } satisfies Shape<ExecutionPlanCombo>),
  ),
  trades: schema.array(
    schema.object({
      accountId: id,
      instrumentId: id,
      side,
      quantity: positive,
      currency,
      referencePricePerUnit: num,
      contractMultiplier: positive,
      estimatedNotional: num,
    } satisfies Shape<ExecutionPlan['trades'][number]>),
  ),
  source: schema.union([
    schema.object({ kind: schema.literal('intent'), intentHash: id } satisfies Shape<
      Extract<ExecutionPlan['source'], { kind: 'intent' }>
    >),
    schema.object({
      kind: schema.literal('rebalance-proposal'),
      planHash: id,
      policyContentHash: id,
    } satisfies Shape<Extract<ExecutionPlan['source'], { kind: 'rebalance-proposal' }>>),
  ]),
  rationale: str.optional(),
  evidence: strings,
  contentHash: id,
} satisfies Shape<ExecutionPlan>);
export const ExecutionPlanSchema = domainWireSchema(
  () => ExecutionPlanGrammar.toJSONSchema(),
  (value) => requireExecutionPlan('trade wire', 'ExecutionPlan', value),
  ExecutionPlanGrammar,
);

const group = schema.union(
  ['instrumentId', 'sleeveId', 'assetClass', 'currency', 'tag', 'underlying', 'strategy'].map(
    (key) => schema.object({ [key]: id }),
  ),
);
export const PolicyLimitsSchema = schema.object({
  maximumPositionWeight: nonnegative.optional(),
  maximumGroupWeights: schema
    .array(schema.object({ group, maximumWeight: nonnegative }))
    .optional(),
  maximumGrossLeverage: positive.optional(),
  maximumDrawdown: nonnegative.max(1).optional(),
  maximumDailyLoss: nonnegative.max(1).optional(),
  maximumDaysToLiquidate: positive.optional(),
  minimumSettledCash: num.optional(),
} satisfies Shape<PolicyLimits>);
const TradePolicyGrammar = schema.object({
  mode: schema.literal('paper'),
  limits: PolicyLimitsSchema.optional(),
  allowedAccounts: strings.optional(),
  allowedAssetClasses: strings.optional(),
  allowedInstruments: strings.optional(),
  allowedOrderTypes: schema.array(orderTypes).optional(),
  maximumOrderQuantity: positive.optional(),
  maximumOrderNotional: positive.optional(),
  maximumEstimatedCost: positive.optional(),
  maximumSlippageBps: positive.optional(),
  maximumParticipation: positive.max(1).optional(),
  allowUndefinedRiskOptions: schema
    .boolean()
    .describe('Default false: undefined-risk options are denied')
    .optional(),
  marketMaximumAgeMs: positive.optional(),
  maximumTurnover: positive.optional(),
  requireApprovalAbove: schema
    .object({ notional: nonnegative.optional(), quantity: nonnegative.optional() })
    .optional(),
  onUnverifiable: schema
    .enum(['require-approval', 'deny'] as const)
    .describe('Default require-approval; missing evidence never implies allow')
    .optional(),
} satisfies Shape<TradePolicy>);
export const TradePolicySchema = domainWireSchema(
  () => TradePolicyGrammar.toJSONSchema(),
  (value) => requireTradePolicy('trade wire', 'TradePolicy', value),
  TradePolicyGrammar,
);
export const PreflightInstrumentSchema = schema.object({
  currency,
  contractMultiplier: positive.optional(),
  contract: ContractSchema.optional(),
  assetClass: str.optional(),
} satisfies Shape<PreflightInstrument>);
export const PaperInstrumentSchema = schema.object({
  currency,
  contractMultiplier: positive.optional(),
  contract: ContractSchema.optional(),
  settlementStyle: settlementStyle.optional(),
  settlementLag: schema
    .union([schema.literal(0), schema.literal(1), schema.literal(2)])
    .describe('T+n 24-hour days in the paper broker; default 0')
    .optional(),
} satisfies Shape<PaperInstrument>);
export const ObservationsSchema = schema.record(
  schema.union([
    schema.object({ kind: schema.literal('bar'), bar: BarSchema }),
    schema.object({ kind: schema.literal('quote'), quote: QuoteSchema }),
    schema.object({ kind: schema.literal('trade'), trade: TradeSchema }),
    schema.object({ kind: schema.literal('order-book'), book: OrderBookSchema }),
  ]) satisfies Schema<MarketObservation>,
);
export const CostRatesSchema = schema.object({
  commissionBps: nonnegative.optional(),
  commissionPerOrder: nonnegative.optional(),
  spreadBps: nonnegative.optional(),
  slippageBps: nonnegative.optional(),
} satisfies Shape<PreflightCostRates>);
const resolvedCosts = schema.object({
  commissionBps: nonnegative,
  commissionPerOrder: nonnegative,
  spreadBps: nonnegative,
  slippageBps: nonnegative,
} satisfies Shape<Required<PreflightCostRates>>);
export const VarianceSchema = schema.object({
  maximumQuantityRatio: nonnegative,
  maximumNotionalRatio: nonnegative,
  maximumSlippageBps: nonnegative,
} satisfies Shape<AuthorizationGrant['variance']>);
const GrantGrammar = schema.object({
  kind: schema.literal('totalfinance.authorization-grant'),
  schemaVersion: schema.literal(1),
  grantId: id,
  planHash: id,
  preflightHash: id,
  portfolioHash: id,
  marketHash: id,
  marketAsOf: epoch,
  marketMaximumAgeMs: positive,
  mode: schema.literal('paper'),
  accountId: id,
  baseCurrency: currency,
  orderIds: strings,
  comboIds: strings,
  variance: VarianceSchema,
  issuedAt: epoch,
  expiresAt: epoch,
  approvedBy: id,
  requiredScope: nullableString,
  idempotencyKeys: schema.array(id).min(1).max(1000),
  contentHash: id,
} satisfies Shape<AuthorizationGrant>);
export const GrantSchema = domainWireSchema(
  () => GrantGrammar.toJSONSchema(),
  (value) => requireAuthorizationGrant('trade wire', 'Grant', value),
  GrantGrammar,
);
export const FillSchema = schema.object({
  fillId: id,
  accountId: id,
  instrumentId: id,
  side,
  quantity: positive,
  pricePerUnit: num,
  currency,
  filledTimestampMs: epoch,
  settleTimestampMs: epoch.optional(),
  contractMultiplier: positive.optional(),
  settlementStyle: settlementStyle.optional(),
  contract: ContractSchema.optional(),
  accruedInterest: num.optional(),
  executionPriceAdjustment: nonnegative.optional(),
  costs: schema
    .object({
      commission: nonnegative.optional(),
      exchangeFees: nonnegative.optional(),
      regulatoryFees: nonnegative.optional(),
      slippageAdjustment: nonnegative.optional(),
    } satisfies Shape<NonNullable<NormalizedFill['costs']>>)
    .optional(),
  orderId: id.optional(),
  venue: str.optional(),
  liquidity: schema.enum(['maker', 'taker', 'unknown'] as const).optional(),
} satisfies Shape<NormalizedFill>);

export const OrderStateSchema = schema.object({
  orderId: id,
  planHash: id,
  state: schema.enum([
    'submitted',
    'acknowledged',
    'partially-filled',
    'filled',
    'cancelled',
    'rejected',
    'expired',
    'unresolved',
  ] as const),
  submittedQuantity: nonnegative,
  filledQuantity: nonnegative,
  remainingQuantity: nonnegative,
  averageFillPrice: nullableNumber,
  fillIds: strings,
  lateFillIds: strings,
  lastEventId: id,
  lastTimestampMs: epoch,
  terminal: schema.boolean(),
  cancelRequested: schema.boolean(),
  reason: nullableString,
  replacedBy: nullableString,
  reconciledEventId: nullableString,
} satisfies Shape<ExecutionOrderState>);
const journalDetailFields = {
  quantity: num.optional(),
  fillId: str.optional(),
  pricePerUnit: num.optional(),
  reason: str.optional(),
  replacementOrderId: str.optional(),
  artifactHash: str.optional(),
  note: str.optional(),
  order: TradeOrderSchema.optional(),
  instrument: PaperInstrumentSchema.optional(),
  accountId: id.optional(),
  baseCurrency: currency.optional(),
  executionPolicyHash: id.optional(),
  observationTimestampMs: epoch.optional(),
  fill: FillSchema.optional(),
  comboId: id.optional(),
  netLimitPrice: num.optional(),
} satisfies Shape<ExecutionJournalDetail>;
const {
  order,
  instrument,
  accountId,
  baseCurrency,
  executionPolicyHash,
  observationTimestampMs,
  fill,
  comboId,
  netLimitPrice,
  ...commonDetail
} = journalDetailFields;
const journalCommon = {
  eventId: id,
  journalId: id,
  timestampMs: epoch,
  orderId: id,
  planHash: id,
  idempotencyKey: id.optional(),
  sourceId: id,
  provenance: TradeProvenanceSchema,
};
const JournalEventGrammar = schema.union(
  EXECUTION_JOURNAL_EVENT_TYPES.map((eventType) => {
    const base = { ...journalCommon, eventType: schema.literal(eventType) };
    if (eventType === 'submitted')
      return schema.object({
        ...base,
        detail: schema.object({
          ...commonDetail,
          quantity: positive,
          order,
          instrument,
          accountId,
          baseCurrency,
          executionPolicyHash,
          comboId,
          netLimitPrice,
        }),
      });
    if (eventType === 'filled' || eventType === 'partially-filled')
      return schema.object({
        ...base,
        detail: schema.object({
          ...commonDetail,
          quantity: positive,
          fillId: id,
          observationTimestampMs,
          fill,
        }),
      });
    if (eventType === 'replaced')
      return schema.object({
        ...base,
        detail: schema.object({ ...commonDetail, replacementOrderId: id }),
      });
    return schema.object({ ...base, detail: schema.object(commonDetail) });
  }),
) satisfies Schema<ExecutionJournalEvent>;
export const JournalEventSchema = domainWireSchema(
  () => JournalEventGrammar.toJSONSchema(),
  (value) => requireExecutionJournalEvent('trade wire', 'journal event', value),
  JournalEventGrammar,
);
export const JournalSummarySchema = schema.object({ journalId: id, appended: count, total: count });
export const HandleSchema = schema.object({
  uri: id,
  kind: schema.enum([
    'report',
    'job',
    'portfolio',
    'scenario',
    'market',
    'authorization',
    'journal',
  ] as const),
  schema: id,
  version: str,
  contentHash: nullableString,
  createdTimestampMs: epoch,
  expiresTimestampMs: nullableNumber,
  provenance: TradeProvenanceSchema,
} satisfies Shape<ResourceHandle>);

const snapshot = schema.object({
  asOf: epoch,
  baseCurrency: currency,
  netAssetValue: num,
  cash: schema.array(
    schema.object({
      accountId: id,
      currency,
      totalAmount: num,
      settledAmount: num,
      unsettledReceivable: num,
      unsettledPayable: num,
      baseCurrencyValue: num,
    } satisfies Shape<PortfolioSnapshotResult['cash'][number]>),
  ),
  totalCashBaseCurrencyValue: num,
  positions: schema.array(
    schema.object({
      accountId: id,
      instrumentId: id,
      currency,
      quantity: num,
      markPricePerUnit: num,
      contractMultiplier: positive,
      settlementStyle,
      marketValue: num,
      baseCurrencyMarketValue: num,
      notionalValue: num,
      baseCurrencyNotionalValue: num,
      costBasis: num,
      unrealizedPnl: num,
      baseCurrencyUnrealizedPnl: num,
      lotCount: count,
    } satisfies Shape<PortfolioSnapshotResult['positions'][number]>),
  ),
  totalPositionsBaseCurrencyValue: num,
  assumptions: schema.object({
    conventionsVersion: str,
    lotRelief: schema.enum(LOT_RELIEF),
    marketAsOf: epoch,
    currencyConversionsUsed: schema.array(CurrencyPairQuoteSchema),
    valuationConvention: str,
  } satisfies Shape<PortfolioSnapshotResult['assumptions']>),
  diagnostics: schema.object({
    warnings: strings,
    accountCount: count,
    positionCount: count,
  } satisfies Shape<PortfolioSnapshotResult['diagnostics']>),
} satisfies Shape<PortfolioSnapshotResult>);
const check = schema.object({
  name: str,
  verdict: schema.enum(['pass', 'fail', 'unverifiable', 'require-approval'] as const),
  value: scalar,
  limit: scalar,
  detail: str,
} satisfies Shape<PolicyCheck>);
const checks = schema.array(check);
const decision = schema.union([
  schema.object({ verdict: schema.literal('allow'), checks }),
  schema.object({ verdict: schema.literal('deny'), checks }),
  schema.object({ verdict: schema.literal('require-approval'), checks, requiredScope: id }),
]) satisfies Schema<PolicyDecision>;
const monitorState = schema.object({
  schemaVersion: schema.literal(1),
  asOf: epoch,
  netAssetValue: nullableNumber,
  peakNetAssetValue: nullableNumber,
  evaluationCount: count,
  rules: schema.record(
    schema.object({
      active: schema.boolean(),
      consecutiveBreaches: count,
      lastRaisedAtMs: nullableNumber,
      acknowledged: schema.boolean(),
      lastValue: nullableNumber,
    } satisfies Shape<PortfolioMonitorState['rules'][string]>),
  ),
} satisfies Shape<PortfolioMonitorState>);
const alert = schema.object({
  key: id,
  family: schema.enum([
    'allocation-drift',
    'concentration-limit',
    'leverage-limit',
    'drawdown',
    'daily-loss',
    'cash-reserve',
    'margin-pressure',
    'liquidity',
    'option-expiration',
    'assignment-risk',
    'stale-market-data',
    'reconciliation-difference',
    'unexplained-residual',
    'unusual-pnl',
  ] as const),
  subject: str,
  severity: schema.enum(['informational', 'warning', 'critical'] as const),
  state: schema.enum(['raised', 'active', 'acknowledged', 'suppressed', 'cleared'] as const),
  value: nullableNumber,
  threshold: nullableNumber,
  direction: schema.enum(['above', 'below'] as const),
  message: str,
  evidence: schema.record(scalar),
} satisfies Shape<MonitorAlert>);
const preflightFields = {
  kind: schema.literal('totalfinance.preflight-report'),
  schemaVersion: schema.literal(1),
  asOf: epoch,
  planHash: id,
  portfolioHash: id,
  marketHash: id,
  marketAsOf: epoch,
  before: snapshot,
  after: snapshot,
  hypotheticalFills: schema.array(FillSchema),
  hypotheticalEvents: schema.array(PortfolioEventEnvelopeSchema),
  estimates: schema.object({
    tradedNotional: num,
    commission: num,
    spread: num,
    slippage: num,
    totalCost: num,
    turnover: num,
  } satisfies Shape<PreflightReport['estimates']>),
  checks,
  alerts: schema.array(alert),
  decision,
  unverifiable: strings,
  monitorState: schema.union([monitorState, schema.null()]),
  assumptions: schema.object({
    conventionsVersion: str,
    policyContentHash: str,
    mode: schema.literal('paper'),
    costRates: resolvedCosts,
    fillConvention: str,
    instrumentSources: schema.record(str),
    decisionConvention: str,
  } satisfies Shape<PreflightReport['assumptions']>),
  diagnostics: schema.object({
    engine: schema.literal('trade-preflight'),
    method: schema.literal('hypothetical-fold'),
    converged: schema.literal(true),
    warnings: schema.array(WarningSchema),
    checkCount: count,
    failedCount: count,
    unverifiableCount: count,
  } satisfies Shape<PreflightReport['diagnostics']>),
  contentHash: id,
} satisfies Shape<PreflightReport>;
const PreflightReportGrammar = schema.object(preflightFields);
export const PreflightReportSchema = domainWireSchema(
  () => PreflightReportGrammar.toJSONSchema(),
  (value) => requirePreflightReport('trade wire', 'PreflightReport', value),
  PreflightReportGrammar,
);
export const PreflightOutputSchema = schema.object({
  ...preflightFields,
  plan: ExecutionPlanSchema,
});
export const ExecutionPolicyDescriptionSchema = schema.object({
  label: str,
  realism: schema.enum(['simplified', 'declared'] as const),
  observation: schema.enum(['bar', 'quote', 'trade', 'order-book'] as const),
  fill: schema.object({ label: str, version: str }),
  ambiguity: schema.enum(['optimistic', 'pessimistic', 'deterministic-path', 'reject'] as const),
  costs: schema.object({
    commission: str,
    slippage: str,
    spread: nullableString,
    marketImpact: nullableString,
    latencySessions: nullableNumber,
    participation: nullableNumber,
    borrow: nullableString,
  }),
  staleQuotes: schema.object({
    maximumAgeMs: nullableNumber,
    behavior: schema.enum(['reject', 'fill-at-last'] as const),
  }),
  lockedCrossed: schema.enum(['reject', 'fill-at-mid'] as const),
  sessions: schema.object({
    halts: count,
    priceLimits: count,
    auction: schema.union([schema.enum(['ignore', 'open-close-only'] as const), schema.null()]),
  }),
  partialFills: schema.enum(['allow', 'reject'] as const),
  queue: schema.enum(['none', 'depth-approximation'] as const),
  timeInForce: schema.object({ default: timeInForce, expireAtSessionClose: schema.boolean() }),
  margin: schema.object({
    buyingPowerMultiplier: num,
    initialMarginRate: num,
    maintenanceMarginRate: num,
    forcedLiquidation: schema.enum(['none', 'close-largest-loss', 'pro-rata'] as const),
  }),
} satisfies Shape<ExecutionPolicyDescription>);
export const ReceiptSchema = schema.object({
  kind: schema.literal('totalfinance.execution-receipt'),
  schemaVersion: schema.literal(1),
  receiptId: id,
  planHash: id,
  grantHash: id,
  idempotencyKey: id,
  adapter: schema.literal('paper'),
  accountId: id,
  sourceId: id,
  submittedAt: epoch,
  orders: schema.array(OrderStateSchema),
  fills: schema.array(FillSchema),
  journalEventIds: strings,
  assumptions: schema.object({
    conventionsVersion: str,
    mode: schema.literal('paper'),
    execution: ExecutionPolicyDescriptionSchema,
    idempotencyConvention: str,
  }),
  diagnostics: schema.object({
    engine: schema.literal('paper-broker'),
    warnings: strings,
    orderCount: count,
    retried: schema.boolean(),
  }),
  contentHash: id,
} satisfies Shape<ExecutionReceipt>);
export type TradeSubmitOutput = Omit<PaperStepResult, 'asOf' | 'journal'> & {
  receipt: ExecutionReceipt;
  retried: boolean;
  recovery: Pick<PaperStepResult, 'fills' | 'events'>;
  journal: { journalId: string; appended: number; total: number };
};
export const SubmitOutputSchema = schema.object({
  receipt: ReceiptSchema,
  retried: schema.boolean(),
  fills: schema.array(FillSchema),
  events: schema.array(PortfolioEventEnvelopeSchema),
  recovery: schema
    .object({ fills: schema.array(FillSchema), events: schema.array(PortfolioEventEnvelopeSchema) })
    .describe(
      'Cumulative persisted fills and reproducible ledger events for this receipt; safe to apply idempotently after a lost response. Top-level fills/events remain new deltas.',
    ),
  journal: JournalSummarySchema,
  open: strings,
  expired: strings,
  unfilled: schema.array(
    schema.object({
      orderId: id,
      reason: schema.enum([
        'not-triggered',
        'no-observation',
        'wrong-observation-kind',
        'stale-quote',
        'locked-crossed',
        'halted',
        'zero-quantity',
        'insufficient-depth',
        'already-observed',
      ] as const),
      detail: str,
    }),
  ),
} satisfies Shape<TradeSubmitOutput>);
export const ExternalPortfolioSchema = schema.object({
  asOf: schema.union([epoch, str]),
  accounts: schema.record(
    schema.object({
      cash: schema.record(schema.object({ total: num, settled: num.optional() })),
      positions: schema.array(
        schema.object({
          instrumentId: id,
          quantity: num,
          currency: currency.optional(),
          costBasis: num.optional(),
        }),
      ),
    }),
  ),
  source: str.optional(),
} satisfies Shape<ExternalPortfolioSnapshot>);
export const ToleranceSchema = schema.object({
  quantity: nonnegative,
  cashAmount: nonnegative,
  costBasis: nonnegative.optional(),
});
const resolvedTolerance = schema.object({
  quantity: nonnegative,
  cashAmount: nonnegative,
  costBasis: nonnegative,
});
const explanation = schema.union([
  schema.object({ kind: schema.literal('pending-settlement'), detail: str }),
  schema.object({ kind: schema.literal('corporate-action-candidate'), detail: str, ratio: num }),
]);
const portfolioReconciliation = schema.object({
  asOf: epoch,
  baseCurrency: currency,
  reconciled: schema.boolean(),
  accounts: schema.array(
    schema.object({
      accountId: id,
      presentInLedger: schema.boolean(),
      presentInExternal: schema.boolean(),
      cash: schema.array(
        schema.object({
          currency,
          ledgerTotal: num,
          ledgerSettled: num,
          ledgerUnsettledReceivable: num,
          ledgerUnsettledPayable: num,
          externalTotal: num,
          externalSettled: nullableNumber,
          totalDifference: num,
          settledDifference: nullableNumber,
          withinTolerance: schema.boolean(),
          explanation: explanation.optional(),
        } satisfies Shape<ReconcilePortfolioResult['accounts'][number]['cash'][number]>),
      ),
      positions: schema.array(
        schema.object({
          instrumentId: id,
          kind: schema.enum([
            'matched',
            'quantity-difference',
            'missing-in-external',
            'extra-in-external',
          ] as const),
          ledgerQuantity: num,
          externalQuantity: num,
          quantityDifference: num,
          withinTolerance: schema.boolean(),
          currency: nullableString,
          currencyMismatch: schema.object({ ledger: str, external: str }).optional(),
          costBasis: schema
            .object({
              ledger: num,
              external: num,
              difference: num,
              withinTolerance: schema.boolean(),
            })
            .optional(),
          explanation: explanation.optional(),
        } satisfies Shape<ReconcilePortfolioResult['accounts'][number]['positions'][number]>),
      ),
    }),
  ),
  differenceCount: count,
  explainedCount: count,
  suggestedCorrections: schema.array(PortfolioEventEnvelopeSchema),
  undraftable: schema.array(schema.object({ accountId: id, subject: str, reason: str })),
  assumptions: schema.object({
    conventionsVersion: str,
    lotRelief: schema.enum(LOT_RELIEF),
    tolerance: resolvedTolerance,
    comparisonConvention: str,
  }),
  diagnostics: schema.object({
    warnings: strings,
    ledgerAccountCount: count,
    externalAccountCount: count,
  }),
} satisfies Shape<ReconcilePortfolioResult>);
export const ReconcileOutputSchema = schema.object({
  kind: schema.literal('totalfinance.reconciliation-report'),
  schemaVersion: schema.literal(1),
  asOf: epoch,
  planHash: nullableString,
  journalId: nullableString,
  sourceId: id,
  reconciled: schema.boolean(),
  orders: schema.array(OrderStateSchema),
  orderChecks: schema.array(
    schema.object({
      orderId: id,
      state: schema.enum([
        'submitted',
        'acknowledged',
        'partially-filled',
        'filled',
        'cancelled',
        'rejected',
        'expired',
        'unresolved',
      ] as const),
      journaledQuantity: num,
      fillQuantity: num,
      difference: num,
      withinTolerance: schema.boolean(),
    } satisfies Shape<ReconciliationReport['orderChecks'][number]>),
  ),
  fills: schema.array(
    schema.object({
      fillId: id,
      orderId: nullableString,
      quantity: num,
      journaled: schema.boolean(),
      inLedger: schema.boolean(),
      ledgerKey: str,
    } satisfies Shape<ReconciliationReport['fills'][number]>),
  ),
  journaledNotInLedger: strings,
  ledgerNotJournaled: strings,
  unresolved: schema.array(schema.object({ orderId: id, reason: str })),
  portfolio: schema.union([portfolioReconciliation, schema.null()]),
  assumptions: schema.object({
    conventionsVersion: str,
    tolerance: resolvedTolerance,
    matchConvention: str,
  }),
  diagnostics: schema.object({
    engine: schema.literal('trade-reconciliation'),
    warnings: strings,
    orderCount: count,
    openCount: count,
    fillCount: count,
    ledgerFillCount: count,
    unresolvedCount: count,
    differenceCount: count,
  }),
  contentHash: id,
} satisfies Shape<ReconciliationReport>);
