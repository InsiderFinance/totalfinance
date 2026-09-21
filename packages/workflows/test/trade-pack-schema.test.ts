import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { describe, expect, it } from 'vitest';
import { schema, type JSONSchema, type Schema } from '@totalfinance/core/schema';
import { ErrorCode } from '@totalfinance/core';
import { createMarketSnapshot, type MarketSnapshot } from '@totalfinance/core/artifacts';
import type {
  TradeOrder,
  TradeIntentOrder,
  TradeIntent,
  ExecutionPlan,
  TradePolicy,
  AuthorizationGrant,
  PreflightReport,
  ExecutionJournalEvent,
  ExecutionOrderState,
  ReconciliationReport,
} from '@totalfinance/portfolio/trade';
import {
  requireTradeOrder,
  requireTradeIntent,
  requireTradePolicy,
} from '@totalfinance/portfolio/trade';
import {
  createPortfolioLedger,
  requireNormalizedFill,
  type NormalizedFill,
  type PortfolioEventEnvelope,
  type PortfolioLedgerSnapshot,
  type PortfolioState,
} from '@totalfinance/portfolio';
import type { PaperInstrument, ExecutionReceipt } from '@totalfinance/backtest/paper';
import type { MarketObservation } from '@totalfinance/backtest/execution';
import {
  TradeOrderSchema,
  TradeIntentOrderSchema,
  TradeIntentSchema,
  ExecutionPlanSchema,
  TradePolicySchema,
  GrantSchema,
  PreflightReportSchema,
  JournalEventSchema,
  OrderStateSchema,
  ReconcileOutputSchema,
  FillSchema,
  PaperInstrumentSchema,
  ReceiptSchema,
  ObservationsSchema,
  SubmitOutputSchema,
  type TradeSubmitOutput,
} from '../src/trade-wire-schemas.js';
import {
  PortfolioEventEnvelopeSchema,
  TradeLedgerSchema,
  TradePortfolioStateSchema,
} from '../src/trade-wire-ledger-schemas.js';
import { TradeMarketSchema } from '../src/trade-wire-market-schemas.js';
import { createOperationRegistry, tradePack } from '../src/index.js';

// The compiler reads these actual public domains, not a second hand-maintained field inventory.
type Domains = {
  submit: TradeSubmitOutput;
  order: TradeOrder;
  intentOrder: TradeIntentOrder;
  intent: TradeIntent;
  plan: ExecutionPlan;
  policy: TradePolicy;
  grant: AuthorizationGrant;
  preflight: PreflightReport;
  journal: ExecutionJournalEvent;
  orderState: ExecutionOrderState;
  reconciliation: ReconciliationReport;
  fill: NormalizedFill;
  instrument: PaperInstrument;
  receipt: ExecutionReceipt;
  observations: Record<string, MarketObservation>;
  envelope: PortfolioEventEnvelope;
  ledger: PortfolioLedgerSnapshot;
  state: PortfolioState;
  market: MarketSnapshot;
};
const contracts = {
  submit: SubmitOutputSchema,
  order: TradeOrderSchema,
  intentOrder: TradeIntentOrderSchema,
  intent: TradeIntentSchema,
  plan: ExecutionPlanSchema,
  policy: TradePolicySchema,
  grant: GrantSchema,
  preflight: PreflightReportSchema,
  journal: JournalEventSchema,
  orderState: OrderStateSchema,
  reconciliation: ReconcileOutputSchema,
  fill: FillSchema,
  instrument: PaperInstrumentSchema,
  receipt: ReceiptSchema,
  observations: ObservationsSchema,
  envelope: PortfolioEventEnvelopeSchema,
  ledger: TradeLedgerSchema,
  state: TradePortfolioStateSchema,
  market: TradeMarketSchema,
} satisfies Record<keyof Domains, Schema<unknown>>;
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const at = Date.UTC(2026, 0, 7, 21);
const validate = (grammar: Schema<unknown>, value: unknown) =>
  new AjvJsonSchemaValidator().getValidator(grammar.toJSONSchema())(wire(value));
const base = {
  orderId: 'o',
  instrumentId: 'AAA',
  side: 'buy',
  quantity: 3,
  plannedTimestampMs: at,
} as const;
const orders = [
  { ...base, type: 'market' },
  { ...base, type: 'market-on-open' },
  { ...base, type: 'market-on-close' },
  { ...base, type: 'limit', limitPrice: 100 },
  { ...base, type: 'stop', stopPrice: 100 },
  { ...base, type: 'stop-limit', limitPrice: 101, stopPrice: 100, timeInForce: 'gtc' },
] satisfies TradeOrder[];

describe('trade machine grammar (R14)', () => {
  it.each(orders)(
    'validates the typed $type order in both JSON Schema and the domain; rejects missing/irrelevant prices',
    (order) => {
      expect(validate(TradeOrderSchema, order).valid).toBe(true);
      expect(requireTradeOrder('test', 'order', order)).toEqual(order);
      const invalid =
        order.type === 'limit' || order.type === 'stop-limit'
          ? { ...order, limitPrice: undefined }
          : order.type === 'stop'
            ? { ...order, stopPrice: undefined }
            : { ...order, limitPrice: 100 };
      expect(validate(TradeOrderSchema, invalid).valid).toBe(false);
      expect(() => requireTradeOrder('test', 'order', wire(invalid))).toThrow();
      expect(validate(TradeOrderSchema, { ...order, credentials: 'no' }).valid).toBe(false);
      for (const sizing of [{ quantity: 3 }, { notionalWeight: 0.2 }]) {
        const {
          orderId: _id,
          plannedTimestampMs: _at,
          quantity: _quantity,
          ...intentOrder
        } = order;
        const intent: TradeIntent = {
          kind: 'totalfinance.trade-intent',
          schemaVersion: 1,
          accountId: 'main',
          asOf: at,
          orders: [{ ...intentOrder, ...sizing }],
        };
        expect(validate(TradeIntentSchema, intent).valid).toBe(true);
        expect(requireTradeIntent('test', 'intent', intent)).toEqual(intent);
        expect(
          validate(TradeIntentSchema, {
            ...intent,
            orders: [{ ...intentOrder, quantity: 3, notionalWeight: 0.2 }],
          }).valid,
        ).toBe(false);
      }
    },
  );

  it('keeps the domain’s useful nested price, policy, and hash refusals rather than replacing them with a generic union error', () => {
    const nested = schema.object({ orders: schema.array(TradeOrderSchema) });
    const missing = nested.safeParse({ orders: [{ ...base, type: 'limit' }] });
    expect(missing).toMatchObject({ success: false, error: { code: ErrorCode.InputMissingField } });
    if (!missing.success) expect(missing.error.message).toContain("required for a 'limit' order");
    expect(
      schema.array(TradeOrderSchema.optional()).safeParse([undefined, { ...base, type: 'limit' }])
        .success,
    ).toBe(false);
    const live = TradePolicySchema.safeParse({ mode: 'live' });
    expect(live).toMatchObject({ success: false, error: { code: ErrorCode.TradeLiveUnavailable } });
    const validPolicy: TradePolicy = {
      mode: 'paper',
      limits: { maximumGroupWeights: [{ group: { instrumentId: 'AAA' }, maximumWeight: 0.5 }] },
      maximumParticipation: 0.2,
      requireApprovalAbove: { notional: 5000 },
      onUnverifiable: 'deny',
    };
    expect(validate(TradePolicySchema, validPolicy).valid).toBe(true);
    expect(requireTradePolicy('test', 'policy', validPolicy)).toEqual(validPolicy);
    expect(validate(TradePolicySchema, { ...validPolicy, limits: { madeUp: true } }).valid).toBe(
      false,
    );
  });

  it('describes all four observation variants using core validators, and all derivative instrument variants', () => {
    const observations: Record<string, MarketObservation> = {
      bar: {
        kind: 'bar',
        bar: {
          symbol: 'AAA',
          timestampMs: at,
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1000,
        },
      },
      quote: { kind: 'quote', quote: { symbol: 'AAA', timestampMs: at, bid: 99, ask: 101 } },
      trade: { kind: 'trade', trade: { symbol: 'AAA', timestampMs: at, price: 100, size: 10 } },
      book: {
        kind: 'order-book',
        book: {
          symbol: 'AAA',
          timestampMs: at,
          bids: [{ price: 99, size: 10 }],
          asks: [{ price: 101, size: 10 }],
        },
      },
    };
    expect(validate(ObservationsSchema, observations).valid).toBe(true);
    expect(ObservationsSchema.parse(observations)).toEqual(observations);
    expect(
      validate(ObservationsSchema, { AAA: { kind: 'quote', bar: observations['bar'] } }).valid,
    ).toBe(false);
    expect(
      ObservationsSchema.safeParse({
        AAA: { kind: 'quote', quote: { symbol: 'AAA', timestampMs: at, bid: '100', ask: 101 } },
      }).success,
    ).toBe(false);
    const instruments: PaperInstrument[] = [
      { currency: 'USD' },
      {
        currency: 'USD',
        contractMultiplier: 100,
        contract: {
          kind: 'option',
          underlyingInstrumentId: 'AAA',
          type: 'put',
          strikePricePerUnit: 100,
          expiryTimestampMs: at + 1000,
        },
      },
      {
        currency: 'USD',
        contractMultiplier: 50,
        settlementStyle: 'variation-margin',
        settlementLag: 2,
        contract: { kind: 'future', underlyingInstrumentId: 'AAA', expiryTimestampMs: at + 1000 },
      },
      {
        currency: 'USD',
        contractMultiplier: 1,
        contract: { kind: 'perpetual', underlyingInstrumentId: 'AAA' },
      },
    ];
    for (const instrument of instruments) {
      expect(validate(PaperInstrumentSchema, instrument).valid).toBe(true);
      expect(PaperInstrumentSchema.parse(instrument)).toEqual(instrument);
    }
    expect(
      validate(PaperInstrumentSchema, {
        ...instruments[1],
        contract: { kind: 'option', type: 'call' },
      }).valid,
    ).toBe(false);
    expect(PaperInstrumentSchema.safeParse({ currency: 'USD', settlementLag: 3 }).success).toBe(
      false,
    );
  });

  it('validates real signed fills and recursive ledger corrections, without opening economic fields or provenance', () => {
    const fill: NormalizedFill = {
      fillId: 'fill',
      accountId: 'main',
      instrumentId: 'AAA',
      side: 'sell',
      quantity: 3,
      pricePerUnit: -10,
      currency: 'USD',
      filledTimestampMs: at,
      costs: { commission: 2 },
    };
    expect(validate(FillSchema, fill).valid).toBe(true);
    expect(() => requireNormalizedFill('test', 'fill', fill)).not.toThrow();
    expect(validate(FillSchema, { ...fill, side: 'short' }).valid).toBe(false);
    const original: PortfolioEventEnvelope = {
      eventId: 'deposit',
      schemaVersion: 1,
      eventType: 'cash.deposit',
      sourceId: 'test',
      accountId: 'main',
      effectiveTimestampMs: at,
      recordedTimestampMs: at,
      event: { eventType: 'cash.deposit', amount: 100, currency: 'USD' },
      provenance: {
        warnings: [
          {
            code: 'test',
            message: 'fixture',
            severity: 'info',
            context: { arbitrary: { kept: true } },
          },
        ],
      },
    };
    const correction: PortfolioEventEnvelope = {
      ...original,
      eventId: 'correction',
      reversesEventId: 'deposit',
      eventType: 'admin.correction',
      event: {
        eventType: 'admin.correction',
        original,
        replacement: { eventType: 'cash.deposit', amount: 200, currency: 'USD' },
      },
    };
    expect(validate(PortfolioEventEnvelopeSchema, correction)).toMatchObject({ valid: true });
    expect(PortfolioEventEnvelopeSchema.parse(correction)).toEqual(correction);
    const invalid = {
      ...correction,
      event: {
        ...correction.event,
        original: { ...original, event: { ...original.event, typo: 1 } },
      },
    };
    expect(validate(PortfolioEventEnvelopeSchema, invalid).valid).toBe(false);
    expect(PortfolioEventEnvelopeSchema.safeParse(invalid).success).toBe(false);
    expect(
      validate(PortfolioEventEnvelopeSchema, { ...original, provenance: { credentials: 'no' } })
        .valid,
    ).toBe(false);
  });

  it('preserves explicitly open vendor market data and wires halted instruments/volumes to preflight', () => {
    const market = createMarketSnapshot({
      asOf: at,
      observations: {
        spots: { AAA: { price: 100, currency: 'USD', vendor: { print: 7 } } as never },
      },
    });
    expect(validate(TradeMarketSchema, market).valid).toBe(true);
    expect(TradeMarketSchema.parse(market)).toEqual(market);
    expect(
      validate(TradeMarketSchema, { ...market, observations: { spots: { AAA: {} } } }).valid,
    ).toBe(false);
    const registry = createOperationRegistry({ packs: [tradePack()] });
    const input = {
      intent: {
        kind: 'totalfinance.trade-intent',
        schemaVersion: 1,
        accountId: 'main',
        asOf: at,
        orders: [{ instrumentId: 'AAA', side: 'buy', quantity: 10, type: 'market' }],
      },
      portfolio: createPortfolioLedger({ baseCurrency: 'USD', events: [] }).toJSON(),
      market,
      asOf: at,
      policy: { mode: 'paper', maximumParticipation: 0.1 },
      session: { open: true, halted: ['AAA'] },
      volumes: { AAA: 1000 },
    };
    const report = registry.run({ id: 'totalfinance.trade.preflight', input })
      .structured as unknown as PreflightReport;
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.stringContaining('participation'),
          verdict: 'pass',
        }),
        expect.objectContaining({
          name: expect.stringContaining('session'),
          value: 'halted',
          verdict: 'fail',
        }),
      ]),
    );
  });

  it('projects every public typed field and discriminator recursively (compiler-to-schema drift gate)', () => {
    const file = fileURLToPath(import.meta.url);
    const configPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      fileURLToPath(new URL('../../../', import.meta.url)),
    );
    const program = ts.createProgram([file], parsed.options);
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(file)!;
    const declaration = source.statements.find(
      (node): node is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(node) && node.name.text === 'Domains',
    )!;
    const domains = checker.getTypeAtLocation(declaration);
    const expand = (schemas: JSONSchema[]): JSONSchema[] =>
      schemas.flatMap((s) => (s.anyOf || s.oneOf ? expand(s.anyOf ?? s.oneOf!) : [s]));
    let audited = 0;
    const audit = (type: ts.Type, schemas: JSONSchema[], path: string): void => {
      audited++;
      const candidates = expand(schemas).filter((s) => s.type !== 'null');
      if (candidates.some((s) => s['$ref'])) return; // recursive originals are this same audited envelope
      if (
        type.flags &
        (ts.TypeFlags.Unknown | ts.TypeFlags.Any | ts.TypeFlags.Undefined | ts.TypeFlags.Null)
      )
        return;
      if (type.isUnion()) {
        const members = type.types.filter(
          (t) => !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
        );
        if (members.every((t) => t.isStringLiteral())) {
          const actual = candidates.flatMap(
            (s) => s.enum ?? (s.const === undefined ? [] : [s.const]),
          );
          expect([...new Set(actual)].sort(), path).toEqual(
            members.map((t) => (t as ts.StringLiteralType).value).sort(),
          );
          return;
        }
        for (const member of members) {
          const discriminator = member
            .getProperties()
            .find(
              (p) =>
                ['kind', 'type', 'eventType', 'verdict'].includes(p.name) &&
                checker.getTypeOfSymbolAtLocation(p, declaration).isStringLiteral(),
            );
          const value =
            discriminator &&
            (checker.getTypeOfSymbolAtLocation(discriminator, declaration) as ts.StringLiteralType)
              .value;
          const matching = discriminator
            ? candidates.filter((s) => s.properties?.[discriminator.name]?.const === value)
            : candidates;
          audit(member, matching, path);
        }
        return;
      }
      if (checker.isArrayType(type)) {
        audit(
          checker.getIndexTypeOfType(type, ts.IndexKind.Number)!,
          candidates.flatMap((s) => (s.items ? [s.items] : [])),
          `${path}[]`,
        );
        return;
      }
      if (!(type.flags & ts.TypeFlags.Object)) return;
      const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
      if (index) {
        audit(
          index,
          candidates.flatMap((s) =>
            typeof s.additionalProperties === 'object' ? [s.additionalProperties] : [],
          ),
          `${path}.*`,
        );
        return;
      }
      const properties = type.getProperties();
      const actual = [
        ...new Set(candidates.flatMap((s) => Object.keys(s.properties ?? {}))),
      ].sort();
      expect(actual, path).toEqual(properties.map((p) => p.name).sort());
      for (const property of properties)
        audit(
          checker.getTypeOfSymbolAtLocation(property, declaration),
          candidates.flatMap((s) =>
            s.properties?.[property.name] ? [s.properties[property.name]!] : [],
          ),
          `${path}.${property.name}`,
        );
    };
    for (const domain of domains.getProperties())
      audit(
        checker.getTypeOfSymbolAtLocation(domain, declaration),
        [contracts[domain.name as keyof Domains].toJSONSchema()],
        domain.name,
      );
    expect(audited).toBeGreaterThan(1000);
  }, 30000);
});
