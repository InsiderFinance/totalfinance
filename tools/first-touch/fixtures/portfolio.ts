/**
 * Fixtures for `@totalfinance/portfolio` (FC7 first slice, Stage 4.4, 2026-08-28): every public head
 * of the event-derived ledger, fed from ONE hand-computed journey so the deep sweep, the magnitude
 * mutant, the count-safety gate, and the declaration-derived resource inventory all govern the
 * package from its first commit — the manifest can DEMAND fixtures; humans author them.
 *
 * The journey: a deposit, a buy, a later deposit and withdrawal (external flows), valued against
 * Gate B market snapshots. Thunks return FRESH structures — probes mutate arguments.
 */
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  createPortfolioLedger,
  applyPortfolioEvents,
  createModelPortfolio,
  monitorPortfolio,
  type InvestmentPolicy,
  type ModelPortfolioDefinition,
  proposePortfolioRebalance,
} from '@totalfinance/portfolio';
import {
  applyJournalEvents,
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
} from '@totalfinance/portfolio/trade';
import type { FixtureThunk } from '../inputs.js';

function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  accountId: string,
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    eventId,
    schemaVersion: 1,
    eventType: event['eventType'],
    sourceId: 'fixture',
    accountId,
    effectiveTimestampMs,
    recordedTimestampMs: effectiveTimestampMs,
    event,
    provenance: {},
  };
}

function journey(): Record<string, unknown>[] {
  return [
    envelope('dep-1', Date.UTC(2026, 0, 1, 15), 'main', {
      eventType: 'cash.deposit',
      amount: 100_000,
      currency: 'USD',
    }),
    envelope('fill-1', Date.UTC(2026, 0, 10, 15), 'main', {
      eventType: 'trade.fill',
      instrumentId: 'AAPL',
      side: 'buy',
      quantity: 100,
      pricePerUnit: 150,
      currency: 'USD',
    }),
    envelope('dep-2', Date.UTC(2026, 1, 1, 12), 'main', {
      eventType: 'cash.deposit',
      amount: 20_000,
      currency: 'USD',
    }),
    envelope('wd-1', Date.UTC(2026, 2, 1, 12), 'main', {
      eventType: 'cash.withdrawal',
      amount: 5_000,
      currency: 'USD',
    }),
  ];
}

function market(asOf: string, applePrice: number) {
  return createMarketSnapshot({
    asOf,
    observations: { spots: { AAPL: { price: applePrice, currency: 'USD' } } },
  });
}

function ledger() {
  return createPortfolioLedger({
    portfolioId: 'primary',
    baseCurrency: 'USD',
    events: journey() as never,
  });
}

/** The accepted example's balanced model — strategic 60/30/10 with a March tactical override. */
function modelDefinition(): ModelPortfolioDefinition {
  return {
    modelId: 'balanced',
    version: 1,
    baseCurrency: 'USD',
    strategic: {
      effectiveFrom: '2026-01-01',
      targets: [
        { group: { tag: 'equity' }, weight: 0.6 },
        { group: { tag: 'fixed-income' }, weight: 0.3 },
        { group: { assetClass: 'cash' }, weight: 0.1 },
      ],
    },
    tactical: [
      {
        effectiveFrom: '2026-03-01',
        effectiveTo: '2026-04-01',
        targets: [
          { group: { tag: 'equity' }, weight: 0.5 },
          { group: { tag: 'fixed-income' }, weight: 0.4 },
          { group: { assetClass: 'cash' }, weight: 0.1 },
        ],
      },
    ],
  };
}

/** A policy over the journey's one holding: AAPL 20% / cash 80%, a 3% band, a 25% position cap. */
function policy(): InvestmentPolicy {
  return {
    targets: [
      { group: { instrumentId: 'AAPL' }, weight: 0.2 },
      { group: { assetClass: 'cash' }, weight: 0.8 },
    ],
    driftBand: 0.03,
    minimumCash: 10_000,
    limits: { maximumPositionWeight: 0.25, maximumDrawdown: 0.2, maximumGrossLeverage: 1.5 },
  };
}

/** Stage 4.6 slice 1 (2026-09-03): one normalized fill — the audited bridge to the ledger's events. */
function normalizedFill(): Record<string, unknown> {
  return {
    fillId: 'f-1',
    accountId: 'main',
    instrumentId: 'AAPL',
    side: 'buy',
    quantity: 100,
    pricePerUnit: 150,
    currency: 'USD',
    filledTimestampMs: Date.UTC(2026, 0, 10, 15),
    orderId: 'o-1',
    costs: { commission: 1.5 },
  };
}

/** Stage 7B.2 slice 1 (2026-09-05): a trade intent over the journey's holding, and its normalized plan. */
function tradeIntent(): Record<string, unknown> {
  return {
    kind: 'totalfinance.trade-intent',
    schemaVersion: 1,
    accountId: 'main',
    asOf: Date.UTC(2026, 2, 2, 15),
    orders: [
      { instrumentId: 'AAPL', side: 'sell', quantity: 10, type: 'limit', limitPrice: 160 },
      { instrumentId: 'MSFT', side: 'buy', notionalWeight: 0.05, type: 'market' },
    ],
    rationale: 'fixture',
    evidence: ['sha256:fixture'],
  };
}
/**
 * The trade fixtures fold hypothetical fills through the ledger at `asOf`, and the declaration
 * synthesizer's branch variants set `asOf` to 2026-02-01T00:00Z — so the trade ledger ends in
 * January and every trade fixture sits at that instant.
 */
const TRADE_AS_OF = Date.UTC(2026, 1, 1);
function tradeLedger() {
  return createPortfolioLedger({
    portfolioId: 'primary',
    baseCurrency: 'USD',
    events: journey().slice(0, 2) as never,
  });
}
function tradeMarket() {
  return createMarketSnapshot({
    asOf: '2026-02-01T00:00:00Z',
    observations: {
      spots: { AAPL: { price: 155, currency: 'USD' }, MSFT: { price: 400, currency: 'USD' } },
    },
  });
}
function tradePlan() {
  return normalizeTradePlan({
    intent: tradeIntent() as never,
    portfolio: tradeLedger().state,
    market: tradeMarket(),
    asOf: TRADE_AS_OF,
  });
}
function tradeProposal() {
  return proposePortfolioRebalance({
    portfolio: tradeLedger().state,
    market: tradeMarket(),
    asOf: TRADE_AS_OF,
    policy: policy(),
    scope: 'to-target',
    defaultLotSize: 1,
    minimumNotional: 100,
  });
}
function tradePlanFromProposal() {
  return normalizeTradePlan({
    proposal: tradeProposal().plan,
    portfolio: tradeLedger().state,
    market: tradeMarket(),
    asOf: TRADE_AS_OF,
  });
}
function tradePreflight() {
  return preflightTradePlan(tradePreflightInput() as never);
}
function tradeGrant() {
  return createAuthorizationGrant({
    plan: tradePlan(),
    preflight: tradePreflight(),
    marketMaximumAgeMs: 86_400_000,
    mode: 'paper',
    variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
    expiresAt: TRADE_AS_OF + 86_400_000,
    approvedBy: 'fixture',
    idempotencyKeys: { prefix: 'fixture', count: 2 },
    now: TRADE_AS_OF,
  });
}
function journalEvent(
  eventId: string,
  eventType: string,
  detail: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId,
    journalId: 'fixture',
    timestampMs: TRADE_AS_OF + 60_000,
    orderId: tradePlan().orders[0]!.orderId,
    planHash: tradePlan().contentHash,
    eventType,
    detail,
    sourceId: 'paper:main',
    provenance: {},
  };
}
function journalEvents(): Record<string, unknown>[] {
  return [
    journalEvent('e1', 'submitted', { quantity: 10 }),
    journalEvent('e2', 'acknowledged'),
    journalEvent('e3', 'filled', { fillId: 'fill-1', quantity: 10, pricePerUnit: 155 }),
  ];
}
function journalState() {
  return applyJournalEvents({ events: journalEvents() as never }).state;
}
function tradePreflightInput(plan: unknown = tradePlan()) {
  return {
    plan,
    portfolio: tradeLedger().state,
    market: tradeMarket(),
    asOf: TRADE_AS_OF,
    policy: tradePolicy(),
    costs: { commissionBps: 5, slippageBps: 10 },
  };
}
function tradePolicy(): Record<string, unknown> {
  return {
    mode: 'paper',
    limits: { maximumPositionWeight: 0.5, maximumGrossLeverage: 1 },
    allowedInstruments: ['AAPL', 'MSFT'],
    maximumOrderNotional: 50_000,
    marketMaximumAgeMs: 86_400_000,
    onUnverifiable: 'require-approval',
  };
}

export const PORTFOLIO_FIXTURES: Record<string, FixtureThunk> = {
  'portfolio.normalizeTradePlan': () => [
    {
      intent: tradeIntent(),
      portfolio: tradeLedger().state,
      market: tradeMarket(),
      asOf: TRADE_AS_OF,
    },
  ],
  'portfolio.preflightTradePlan': () => [tradePreflightInput()],
  'portfolio.mergeTradePolicies': () => [
    { policies: [tradePolicy(), { mode: 'paper', maximumOrderNotional: 20_000 }] },
  ],
  'portfolio.decideFromChecks': () => [
    [{ name: 'fixture', verdict: 'pass', value: 1, limit: 2, detail: 'fixture' }],
    'require-approval',
  ],
  'portfolio.referencePriceOf': () => [tradeMarket(), 'AAPL'],
  'portfolio.requireTradeOrder': () => ['fixture', 'order', tradePlan().orders[0]],
  'portfolio.requireTradeIntent': () => ['fixture', 'intent', tradeIntent()],
  'portfolio.requireExecutionPlan': () => ['fixture', 'plan', tradePlan()],
  'portfolio.requireTradePolicy': () => ['fixture', 'policy', tradePolicy()],
  'portfolio.createAuthorizationGrant': () => [
    {
      plan: tradePlan(),
      preflight: tradePreflight(),
      marketMaximumAgeMs: 86_400_000,
      mode: 'paper',
      variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
      expiresAt: TRADE_AS_OF + 86_400_000,
      approvedBy: 'fixture',
      idempotencyKeys: ['fixture:1'],
      now: TRADE_AS_OF,
    },
  ],
  'portfolio.verifyAuthorizationGrant': () => [
    {
      grant: tradeGrant(),
      plan: tradePlan(),
      now: TRADE_AS_OF + 1_800_000,
      portfolioHash: tradePreflight().portfolioHash,
      marketHash: tradePreflight().marketHash,
      marketAsOf: TRADE_AS_OF,
      idempotencyKey: 'fixture:1',
    },
  ],
  'portfolio.applyJournalEvents': () => [{ events: journalEvents() }],
  'portfolio.journalOrderStates': () => [journalState()],
  'portfolio.reconcileExecution': () => [
    {
      journal: journalEvents(),
      ledger: ledger().state,
      sourceId: 'paper:main',
      fills: [],
      asOf: TRADE_AS_OF + 3_600_000,
      tolerance: { quantity: 1e-9, cashAmount: 0.01 },
    },
  ],
  'portfolio.requireGrantVariance': () => [
    'fixture',
    'variance',
    { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
  ],
  'portfolio.requirePreflightReport': () => ['fixture', 'preflight', tradePreflight()],
  'portfolio.requireAuthorizationGrant': () => ['fixture', 'grant', tradeGrant()],
  'portfolio.requireExecutionJournalEvent': () => ['fixture', 'event', journalEvents()[0]],
  'portfolio.requireExecutionOrderState': () => [
    'fixture',
    'order',
    journalState().orders[tradePlan().orders[0]!.orderId],
  ],
  'portfolio.requireExecutionJournalState': () => ['fixture', 'state', journalState()],
  'portfolio.requirePreflightInstrument': () => [
    'fixture',
    'instrument',
    { currency: 'USD', contractMultiplier: 100, assetClass: 'equity' },
  ],
  'portfolio.requirePreflightCostRates': () => [
    'fixture',
    'costs',
    { commissionBps: 5, commissionPerOrder: 1, spreadBps: 2, slippageBps: 10 },
  ],
  'portfolio.requireNormalizedFill': () => ['fixture', 'fill', normalizedFill()],
  'portfolio.portfolioEventsFromFill': () => [
    { fill: normalizedFill(), sourceId: 'fixture', recordedTimestampMs: Date.UTC(2026, 0, 10, 15) },
  ],
  'portfolio.applyPortfolioEvents': () => [
    { portfolio: { baseCurrency: 'USD' }, events: journey() },
  ],
  'portfolio.createPortfolioLedger': () => [
    { portfolioId: 'primary', baseCurrency: 'USD', events: journey() },
  ],
  'portfolio.readPortfolioLedgerSnapshot': () => [{ snapshot: ledger().toJSON() }],
  'portfolio.isPortfolioLedgerSnapshot': () => [ledger().toJSON()],
  'portfolio.portfolioLedgerContentHash': () => [ledger().toJSON()],
  'portfolio.portfolioEventContentHash': () => [journey()[0]],
  'portfolio.duplicateBoundaryKey': () => [journey()[0]],
  'portfolio.requirePortfolioEventEnvelope': () => ['fixture', 'envelope', journey()[1]],
  'portfolio.portfolioSnapshot': () => [
    {
      portfolio: applyPortfolioEvents({
        portfolio: { baseCurrency: 'USD' },
        events: journey() as never,
      }),
      asOf: Date.UTC(2026, 3, 1),
      market: market('2026-04-01', 162),
    },
  ],
  'portfolio.portfolioPnl': () => [
    {
      ledger: ledger(),
      from: { valuationDate: '2026-02-01', market: market('2026-02-01', 160) },
      to: { valuationDate: '2026-03-01', market: market('2026-03-01', 155) },
      instrumentClassification: {
        AAPL: { underlying: 'AAPL', assetClass: 'equity', strategy: 'core', tags: ['tech'] },
      },
    },
  ],
  'portfolio.portfolioTimeline': () => [
    {
      ledger: ledger(),
      valuationMarks: [
        { valuationDate: '2026-01-02', market: market('2026-01-02', 150) },
        { valuationDate: '2026-02-01', market: market('2026-02-01', 160) },
        { valuationDate: '2026-03-01', market: market('2026-03-01', 155) },
        { valuationDate: '2026-04-01', market: market('2026-04-01', 162) },
      ],
      instrumentClassification: {
        AAPL: { underlying: 'AAPL', assetClass: 'equity', strategy: 'core', tags: ['tech'] },
      },
    },
  ],
  'portfolio.reconcilePortfolio': () => [
    {
      portfolio: ledger().state,
      asOf: '2026-03-01',
      external: {
        asOf: '2026-03-01',
        source: 'fixture-broker',
        accounts: {
          main: {
            cash: { USD: { total: 100_000 } },
            positions: [
              { instrumentId: 'AAPL', quantity: 100, currency: 'USD', costBasis: 15_000 },
            ],
          },
        },
      },
      tolerance: { quantity: 1e-9, cashAmount: 0.01 },
    },
  ],
  'portfolio.createModelPortfolio': () => [modelDefinition()],
  'portfolio.isModelPortfolio': () => [createModelPortfolio(modelDefinition())],
  'portfolio.resolveModelTargets': () => [
    { model: createModelPortfolio(modelDefinition()), asOf: '2026-03-15' },
  ],
  'portfolio.monitorPortfolio': () => [
    {
      portfolio: ledger().state,
      market: market('2026-03-01', 155),
      asOf: '2026-03-01',
      policy: policy(),
      previousState: null,
    },
  ],
  'portfolio.monitorPortfolio#previous-state': () => {
    const first = monitorPortfolio({
      portfolio: ledger().state,
      market: market('2026-02-01', 160),
      asOf: '2026-02-01',
      policy: policy(),
      previousState: null,
    });
    return [
      {
        portfolio: ledger().state,
        market: market('2026-03-01', 155),
        asOf: '2026-03-01',
        policy: policy(),
        previousState: first.state,
      },
    ];
  },
  'portfolio.allocatePortfolio': () => [
    {
      policy: policy(),
      asOf: '2026-03-01',
      baseCurrency: 'USD',
      netAssetValue: 115_500,
      prices: { AAPL: { price: 155, currency: 'USD' } },
      currentHoldings: { AAPL: 100 },
      defaultLotSize: 1,
      minimumNotional: 100,
      transactionCosts: { commissionPerTrade: 1, spreadBasisPoints: 2, slippageBasisPoints: 3 },
    },
  ],
  'portfolio.proposePortfolioRebalance': () => [
    {
      portfolio: ledger().state,
      market: market('2026-03-01', 155),
      asOf: '2026-03-01',
      policy: policy(),
      scope: 'to-target',
      defaultLotSize: 1,
      minimumNotional: 100,
      transactionCosts: { commissionPerTrade: 1, spreadBasisPoints: 2, slippageBasisPoints: 3 },
    },
  ],
  'portfolio.portfolioPerformanceInputs': () => [
    {
      ledger: ledger(),
      valuationMarks: [
        { valuationDate: '2026-01-02', market: market('2026-01-02', 150) },
        { valuationDate: '2026-02-01', market: market('2026-02-01', 160) },
        { valuationDate: '2026-03-01', market: market('2026-03-01', 155) },
        { valuationDate: '2026-04-01', market: market('2026-04-01', 162) },
      ],
    },
  ],
};

/**
 * Branch variants for the sweeps' registry (`tools/first-touch/overflow-variants.ts`): the proposal
 * source of a plan (content-addressed, so the declaration builder cannot graft the arm) and the
 * monitor-state continuation whose `evaluationCount` is a resource coordinate.
 */
export const PORTFOLIO_TRADE_VARIANTS: Record<string, FixtureThunk> = {
  'portfolio.createAuthorizationGrant#proposal': () => {
    const plan = tradePlanFromProposal();
    const [base] = PORTFOLIO_FIXTURES['portfolio.createAuthorizationGrant']!() as [
      Record<string, unknown>,
    ];
    return [{ ...base, plan, preflight: preflightTradePlan(tradePreflightInput(plan) as never) }];
  },
  'portfolio.createAuthorizationGrant#prefix-keys': () => {
    const [base] = PORTFOLIO_FIXTURES['portfolio.createAuthorizationGrant']!() as [
      Record<string, unknown>,
    ];
    return [{ ...base, idempotencyKeys: { prefix: 'fixture', count: 3 } }];
  },
  'portfolio.verifyAuthorizationGrant#proposal': () => {
    const plan = tradePlanFromProposal();
    const preflight = preflightTradePlan(tradePreflightInput(plan) as never);
    const [base] = PORTFOLIO_FIXTURES['portfolio.createAuthorizationGrant']!() as [
      Record<string, unknown>,
    ];
    const grant = createAuthorizationGrant({ ...base, plan, preflight } as never);
    return [
      {
        grant,
        plan,
        now: TRADE_AS_OF + 1_800_000,
        portfolioHash: preflight.portfolioHash,
        marketHash: preflight.marketHash,
        marketAsOf: TRADE_AS_OF,
        idempotencyKey: 'fixture:1',
      },
    ];
  },
  'portfolio.applyJournalEvents#previous-state': () => {
    const events = journalEvents();
    const first = applyJournalEvents({ events: events.slice(0, 2) as never });
    return [{ events: events.slice(2), previousState: first.state }];
  },
  'portfolio.reconcileExecution#folded-journal': () => {
    const [base] = PORTFOLIO_FIXTURES['portfolio.reconcileExecution']!() as [
      Record<string, unknown>,
    ];
    return [{ ...base, journal: journalState() }];
  },
  'portfolio.reconcileExecution#external': () => {
    const [base] = PORTFOLIO_FIXTURES['portfolio.reconcileExecution']!() as [
      Record<string, unknown>,
    ];
    return [
      {
        ...base,
        external: {
          asOf: '2026-02-01T01:00:00Z',
          accounts: {
            main: {
              cash: { USD: { total: 85_000 } },
              positions: [{ instrumentId: 'AAPL', quantity: 100, currency: 'USD' }],
            },
          },
        },
      },
    ];
  },
  'portfolio.normalizeTradePlan#proposal': () => [
    {
      proposal: tradeProposal().plan,
      portfolio: tradeLedger().state,
      market: tradeMarket(),
      asOf: TRADE_AS_OF,
    },
  ],
  'portfolio.preflightTradePlan#proposal': () => [tradePreflightInput(tradePlanFromProposal())],
  'portfolio.preflightTradePlan#monitor-state': () => [
    {
      ...tradePreflightInput(),
      // the monitor moves forward in time: the continuation's state is an earlier evaluation
      monitorState: preflightTradePlan({
        ...tradePreflightInput(),
        asOf: TRADE_AS_OF - 3_600_000,
      } as never).monitorState,
    },
  ],
};
