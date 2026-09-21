/** Full ledger grammar used by the trade pack; recursive corrections use a local JSON Schema
 * resource, and parsing delegates to the ledger's permanent read door. */
import { schema, type Schema } from '@totalfinance/core/schema';
import {
  requirePortfolioEventEnvelope,
  type EconomicPortfolioEvent,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
  type PortfolioState,
  type PortfolioLedgerSnapshot,
} from '@totalfinance/portfolio';
import {
  ContractSchema,
  TradeProvenanceSchema,
  domainWireSchema,
  PORTFOLIO_EVENT_SCHEMA_ID,
  type Shape,
} from './trade-wire-common-schemas.js';
import { LOT_RELIEF } from './wire-schemas.js';
const str = schema.string();
const id = str.min(1);
const num = schema.number();
const positive = num.positive();
const epoch = num.describe('Epoch milliseconds');
const currency = str.regex(/^[A-Z]{3}$/);
const settlementStyle = schema.enum(['cash-on-trade', 'variation-margin'] as const);
const lots = schema
  .array(schema.object({ lotId: id, quantity: positive }))
  .min(1)
  .optional();
const settlement = epoch.optional();
const economic = {
  'cash.deposit': schema.object({
    eventType: schema.literal('cash.deposit'),
    amount: positive,
    currency,
    settleTimestampMs: settlement,
  }),
  'cash.withdrawal': schema.object({
    eventType: schema.literal('cash.withdrawal'),
    amount: positive,
    currency,
    settleTimestampMs: settlement,
  }),
  'cash.transfer': schema.object({
    eventType: schema.literal('cash.transfer'),
    amount: positive,
    currency,
    fromAccountId: id,
    toAccountId: id,
  }),
  'cash.conversion': schema.object({
    eventType: schema.literal('cash.conversion'),
    fromCurrency: currency,
    toCurrency: currency,
    fromAmount: positive,
    toAmount: positive,
  }),
  'trade.fill': schema.object({
    eventType: schema.literal('trade.fill'),
    instrumentId: id,
    side: schema.enum(['buy', 'sell'] as const),
    quantity: positive,
    pricePerUnit: num,
    currency,
    settleTimestampMs: settlement,
    lotSelections: lots,
    contractMultiplier: positive.optional(),
    settlementStyle: settlementStyle.optional(),
    contract: ContractSchema.optional(),
    accruedInterest: num.optional(),
  }),
  'cost.charge': schema.object({
    eventType: schema.literal('cost.charge'),
    costType: schema.enum([
      'commission',
      'exchange-fee',
      'regulatory-fee',
      'slippage-adjustment',
    ] as const),
    amount: num,
    currency,
    instrumentId: id.optional(),
    relatesToEventId: id.optional(),
  }),
  'income.received': schema.object({
    eventType: schema.literal('income.received'),
    incomeType: schema.enum([
      'dividend',
      'coupon',
      'interest',
      'staking-reward',
      'funding-receipt',
    ] as const),
    amount: num,
    currency,
    instrumentId: id.optional(),
    settleTimestampMs: settlement,
  }),
  'financing.charge': schema.object({
    eventType: schema.literal('financing.charge'),
    financingType: schema.enum(['margin-interest', 'borrow-charge', 'funding-payment'] as const),
    amount: num,
    currency,
    instrumentId: id.optional(),
  }),
  'corporate.split': schema.object({
    eventType: schema.literal('corporate.split'),
    instrumentId: id,
    sharesAfterSplit: positive,
    sharesBeforeSplit: positive,
  }),
  'derivative.exercise': schema.object({
    eventType: schema.literal('derivative.exercise'),
    instrumentId: id,
    quantity: positive,
    settlement: schema.union([
      schema.object({ kind: schema.literal('physical') }),
      schema.object({ kind: schema.literal('cash'), settlementPricePerUnit: num }),
    ]),
    premiumTreatment: schema.enum(['fold-into-underlying-basis', 'realize'] as const),
    settleTimestampMs: settlement,
    lotSelections: lots,
  }),
  'derivative.assignment': schema.object({
    eventType: schema.literal('derivative.assignment'),
    instrumentId: id,
    quantity: positive,
    settlement: schema.union([
      schema.object({ kind: schema.literal('physical') }),
      schema.object({ kind: schema.literal('cash'), settlementPricePerUnit: num }),
    ]),
    premiumTreatment: schema.enum(['fold-into-underlying-basis', 'realize'] as const),
    settleTimestampMs: settlement,
    lotSelections: lots,
  }),
  'derivative.expiration': schema.object({
    eventType: schema.literal('derivative.expiration'),
    instrumentId: id,
    quantity: positive,
    lotSelections: lots,
  }),
  'derivative.multiplier-change': schema.object({
    eventType: schema.literal('derivative.multiplier-change'),
    instrumentId: id,
    contractMultiplierAfter: positive,
    strikePricePerUnitAfter: positive.optional(),
    reason: str.optional(),
  }),
  'derivative.variation-margin': schema.object({
    eventType: schema.literal('derivative.variation-margin'),
    instrumentId: id,
    settlementPricePerUnit: num,
  }),
  'derivative.roll': schema.object({
    eventType: schema.literal('derivative.roll'),
    fromInstrumentId: id,
    toInstrumentId: id,
    quantity: positive,
    closePricePerUnit: num,
    openPricePerUnit: num,
    contract: ContractSchema.optional(),
    lotSelections: lots,
  }),
  'fixed-income.redemption': schema.object({
    eventType: schema.literal('fixed-income.redemption'),
    instrumentId: id,
    redemptionType: schema.enum(['maturity', 'call', 'principal-paydown', 'sinking-fund'] as const),
    quantity: positive,
    pricePerUnit: num,
    currency,
    settleTimestampMs: settlement,
    lotSelections: lots,
  }),
  'corporate.symbol-change': schema.object({
    eventType: schema.literal('corporate.symbol-change'),
    fromInstrumentId: id,
    toInstrumentId: id,
  }),
  'corporate.merger': schema.object({
    eventType: schema.literal('corporate.merger'),
    fromInstrumentId: id,
    toInstrumentId: id.optional(),
    sharesPerShare: positive.optional(),
    cashPerShare: num.optional(),
    currency: currency.optional(),
    settleTimestampMs: settlement,
  }),
  'corporate.spin-off': schema.object({
    eventType: schema.literal('corporate.spin-off'),
    parentInstrumentId: id,
    childInstrumentId: id,
    sharesPerParentShare: positive,
    basisAllocationFraction: num,
  }),
  'corporate.return-of-capital': schema.object({
    eventType: schema.literal('corporate.return-of-capital'),
    instrumentId: id,
    amountPerShare: num,
    currency,
    settleTimestampMs: settlement,
  }),
  'corporate.cash-in-lieu': schema.object({
    eventType: schema.literal('corporate.cash-in-lieu'),
    instrumentId: id,
    quantity: positive,
    amount: num,
    currency,
    relatesToEventId: id.optional(),
    settleTimestampMs: settlement,
  }),
  'position.transfer': schema.object({
    eventType: schema.literal('position.transfer'),
    instrumentId: id,
    quantity: positive,
    fromAccountId: id,
    toAccountId: id,
    lotSelections: lots,
  }),
} satisfies {
  [K in EconomicPortfolioEvent['eventType']]: Schema<
    Extract<EconomicPortfolioEvent, { eventType: K }>
  >;
};
const economicSchema = schema.union(Object.values(economic));
const original = domainWireSchema<PortfolioEventEnvelope>(
  () => ({ $ref: '#' }),
  (value) => {
    requirePortfolioEventEnvelope('trade wire', 'event.original', value as PortfolioEventEnvelope);
    return value as PortfolioEventEnvelope;
  },
);
const admin = {
  'admin.reversal': schema.object({
    eventType: schema.literal('admin.reversal'),
    original,
    reason: str.optional(),
  }),
  'admin.correction': schema.object({
    eventType: schema.literal('admin.correction'),
    original,
    replacement: economicSchema,
    reason: str.optional(),
  }),
  'admin.account-migration': schema.object({
    eventType: schema.literal('admin.account-migration'),
    fromAccountId: id,
    toAccountId: id,
    reason: str.optional(),
  }),
} satisfies {
  [K in Exclude<PortfolioEvent['eventType'], EconomicPortfolioEvent['eventType']>]: Schema<
    Extract<PortfolioEvent, { eventType: K }>
  >;
};
const envelopeFields = {
  eventId: id,
  schemaVersion: schema.literal(1),
  sourceId: id,
  accountId: id,
  effectiveTimestampMs: epoch,
  recordedTimestampMs: epoch,
  correlationId: id.optional(),
  causationId: id.optional(),
  reversesEventId: id.optional(),
  provenance: TradeProvenanceSchema,
};
const variants = Object.entries({ ...economic, ...admin }).map(([eventType, event]) =>
  schema.object({
    ...envelopeFields,
    eventType: schema.literal(eventType),
    event,
    ...(eventType === 'admin.reversal' || eventType === 'admin.correction'
      ? { reversesEventId: id }
      : {}),
  }),
);
export const PortfolioEventEnvelopeSchema = domainWireSchema<PortfolioEventEnvelope>(
  () => ({
    $id: PORTFOLIO_EVENT_SCHEMA_ID,
    ...schema.union(variants).toJSONSchema(),
  }),
  (value) => {
    requirePortfolioEventEnvelope('trade wire', 'event', value as PortfolioEventEnvelope);
    return value as PortfolioEventEnvelope;
  },
);
export const TradeLedgerSchema = schema.object({
  kind: schema.literal('totalfinance.portfolio-ledger'),
  schemaVersion: schema.literal(1),
  portfolioId: id.optional(),
  baseCurrency: currency,
  lotRelief: schema.enum(LOT_RELIEF),
  events: schema.array(PortfolioEventEnvelopeSchema),
  provenance: TradeProvenanceSchema.optional(),
} satisfies Shape<PortfolioLedgerSnapshot>);
const cash = schema.object({
  totalAmount: num,
  settlementSchedule: schema.array(
    schema.object({ eventId: id, amount: num, settleTimestampMs: epoch }),
  ),
});
const position = schema.object({
  instrumentId: id,
  currency,
  contractMultiplier: positive,
  settlementStyle,
  contract: ContractSchema.optional(),
  quantity: num,
  lots: schema.array(
    schema.object({
      lotId: id,
      openedByEventId: id,
      openedTimestampMs: epoch,
      quantity: num,
      costBasisPerUnit: num,
    }),
  ),
});
const amounts = schema.record(num);
export const TradePortfolioStateSchema = schema.object({
  schemaVersion: schema.literal(1),
  portfolioId: id.optional(),
  baseCurrency: currency,
  lotRelief: schema.enum(LOT_RELIEF),
  accounts: schema.record(
    schema.object({
      cashBalances: schema.record(cash),
      positions: schema.record(position),
      realizedPnl: amounts,
      incomeReceived: amounts,
      transactionCosts: amounts,
      financingCosts: amounts,
      realizedPnlByInstrument: schema.record(amounts),
      incomeByInstrument: schema.record(amounts),
      transactionCostsByInstrument: schema.record(amounts),
    } satisfies Shape<PortfolioState['accounts'][string]>),
  ),
  appliedEvents: schema.record(str),
  eventCount: num.integer().nonnegative(),
  lastEffectiveTimestampMs: schema.union([epoch, schema.null()]),
  lotSequence: num.integer().nonnegative(),
  fillEffects: schema.record(
    schema.object({
      accountId: id,
      instrumentId: id,
      currency,
      openedLotIds: schema.array(id),
      relievedQuantity: num,
      realizedPnl: num,
      cashDelta: num,
      accruedInterest: num,
    } satisfies Shape<PortfolioState['fillEffects'][string]>),
  ),
  reversals: schema.record(str),
  accountMigrations: schema.array(
    schema.object({ eventId: id, fromAccountId: id, toAccountId: id, effectiveTimestampMs: epoch }),
  ),
} satisfies Shape<PortfolioState>);
