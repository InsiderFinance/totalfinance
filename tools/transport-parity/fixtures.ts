/**
 * Parity fixtures for the 39 wire operations (Stage 7A slice 7).
 *
 * `PARITY_FIXTURES` holds ONE known-valid input thunk per operation id; `PARITY_MALFORMED` holds one
 * input per id that the operation's OWN `inputSchema` refuses in strict mode with an `input.*` code
 * (the code each entry expects is noted inline). Thunks build FRESH plain-JSON values on every call
 * (`JSON.parse(JSON.stringify(...))`), so a caller can never observe a shared or mutated fixture,
 * and every fixture serializes well under the 64 KiB transport budget
 * (`OPERATION_BUDGETS.maxInputBytes.transportDefault`), measured the way the runtime measures it
 * (`JSON.stringify` UTF-8 bytes).
 *
 * Sources (quoted and adapted, kept small):
 * - the operations' own `inputSchema`s in `packages/workflows/src/operations-{compute,analysis,journey}.ts`;
 * - `packages/mcp/test/{server,domain-tools,analysis-tools}.test.ts` (the MCP `tool(id).run({...})` inputs);
 * - `tools/first-touch/fixtures/workflows.ts` (`priceInput`);
 * - `packages/workflows/test/journey.test.ts` (ledger envelope, market snapshots, marks, policy,
 *   scenario set, research universe, analysis artifact, options-backtest chains).
 *
 * Nothing here uses `Math.sin`/`Math.random`/`Date.now()`: every series is an integer-modular pattern,
 * so the bytes are identical on every engine, every run.
 */

import { resolvedExpiry, usEquitySessionInstant, optionExpiryToMs } from '@totalfinance/core';
import {
  createAnalysisArtifact,
  createMarketSnapshot,
  createScenarioSet,
} from '@totalfinance/core/artifacts';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import { createPortfolioLedger } from '@totalfinance/portfolio';
import { createPaperBroker } from '@totalfinance/backtest/paper';
import {
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
} from '@totalfinance/portfolio/trade';

type Fixture = Record<string, unknown>;
type FixtureThunk = () => Fixture;

/** Plain JSON: what a wire carries (drops frozen prototypes, `undefined`, and class instances). */
const wire = (value: unknown): Fixture => JSON.parse(JSON.stringify(value)) as Fixture;

const DAY_MS = 86_400_000;

// ── option pricing (first-touch `priceInput` + MCP server.test.ts) ────────────────────────────

const priceInput = () => ({
  type: 'call',
  spot: 100,
  strike: 105,
  timeToExpiryYears: 0.25,
  riskFreeRate: 0.04,
  volatility: 0.2,
});

/** server.test.ts "solves implied volatility round-trip": the BSM ATM 1y call at 20% vol. */
const impliedVolatilityInput = () => ({
  price: 10.450583572185565,
  spot: 100,
  strike: 100,
  timeToExpiryYears: 1,
  riskFreeRate: 0.05,
  type: 'call',
  method: 'auto',
  fallback: true,
});

// ── technical analysis ────────────────────────────────────────────────────────────────────────

/** 40 closes on a deterministic saw-tooth around 100 (integer-modular, engine-independent). */
const closes = (): number[] =>
  Array.from({ length: 40 }, (_, index) => 100 + ((index * 7) % 11) - 5 + index * 0.25);

// ── strategy (analysis-tools.test.ts "named dispatch") ────────────────────────────────────────

const strategyMarket = () => ({
  spot: 100,
  volatility: 0.2,
  riskFreeRate: 0.04,
  asOf: '2026-01-02T00:00:00Z',
  expiry: '2026-06-19',
});

const strategyAnalyzeInput = () => ({
  strategy: 'ironCondor',
  input: { putLong: 90, putShort: 95, callShort: 110, callLong: 115 },
  premiums: 'model',
  probability: true,
  market: strategyMarket(),
});

// ── volatility (analysis-tools.test.ts "vol tools") ───────────────────────────────────────────

const surfaceChain = () => {
  const chain: { strike: number; expiry: string; type: 'call'; impliedVolatility: number }[] = [];
  for (const expiry of ['2026-06-19', '2026-09-18']) {
    for (const strike of [90, 100, 110]) {
      chain.push({ strike, expiry, type: 'call', impliedVolatility: 0.2 + (100 - strike) * 0.001 });
    }
  }
  return chain;
};

const surfaceInput = () => ({
  chain: surfaceChain(),
  spot: 100,
  riskFreeRate: 0.04,
  asOf: '2026-01-02T00:00:00Z',
  model: 'interpolated',
  underlying: 'XYZ',
  style: 'american',
});

/** 252 daily ATM IVs between 15% and 25%, integer-modular (no Math.sin). */
const volatilityHistory = (): number[] =>
  Array.from({ length: 252 }, (_, index) => 0.15 + ((index * 37) % 101) / 1000);

// ── structure (server.test.ts `sampleChain`, analysis-tools.test.ts "structure.flow") ─────────

const exposuresChain = () => {
  const rows: {
    strike: number;
    expiry: string;
    type: 'call' | 'put';
    openInterest: number;
    impliedVolatility: number;
  }[] = [];
  for (const strike of [90, 95, 100, 105, 110]) {
    rows.push({
      strike,
      expiry: '2026-08-21',
      type: 'call',
      openInterest: strike >= 105 ? 6000 : 2000,
      impliedVolatility: 0.25,
    });
    rows.push({
      strike,
      expiry: '2026-08-21',
      type: 'put',
      openInterest: strike <= 95 ? 6000 : 2000,
      impliedVolatility: 0.25,
    });
  }
  return rows;
};

const exposuresInput = () => ({
  chain: exposuresChain(),
  spot: 100,
  riskFreeRate: 0.045,
  asOf: '2026-07-13T00:00:00Z',
  convention: 'callsPositivePutsNegative',
  gammaUnit: 'per1PercentMove',
  underlying: 'XYZ',
  style: 'american',
  topStrikes: 5,
});

const FLOW_TS = Date.UTC(2026, 6, 6, 15); // 2026-07-06T15:00:00Z
const flowTrades = () => [
  {
    timestampMs: FLOW_TS,
    type: 'call',
    strike: 100,
    expiry: '2026-08-21',
    price: 2.6,
    size: 60,
    bid: 2.4,
    ask: 2.6,
  },
  {
    timestampMs: FLOW_TS + 50,
    type: 'call',
    strike: 100,
    expiry: '2026-08-21',
    price: 2.6,
    size: 80,
    bid: 2.4,
    ask: 2.6,
  },
  {
    timestampMs: FLOW_TS + 90,
    type: 'call',
    strike: 100,
    expiry: '2026-08-21',
    price: 2.65,
    size: 70,
    bid: 2.4,
    ask: 2.65,
  },
];

const flowInput = () => ({
  trades: flowTrades(),
  underlying: 'XYZ',
  style: 'american',
  maxDetails: 10,
});

// ── risk / performance (server.test.ts `sampleReturns`, analysis-tools.test.ts) ───────────────

/** server.test.ts `sampleReturns`: 200 periods, a -5% every tenth period, +1% otherwise. */
const sampleReturns = (): number[] =>
  Array.from({ length: 200 }, (_, index) => (index % 10 === 0 ? -0.05 : 0.01));

const covariance = () => [
  [0.04, 0.01],
  [0.01, 0.09],
];

// ── calendar / crypto / fixed income (analysis-tools + domain-tools tests) ────────────────────

const calendarInput = () => ({
  calendar: 'NYSE',
  from: '2026-06-01',
  to: '2026-07-31',
  expirationKind: 'monthly',
});

const bondSpecification = () => ({
  issueDate: '2024-01-15',
  maturityDate: '2030-01-15',
  couponRate: 0.05,
  frequency: 'semiannual',
  faceValue: 100,
  dayCount: '30/360',
  settlementDate: '2026-01-15',
});

// ── vectorized backtest (analysis-tools.test.ts "backtest pack") ──────────────────────────────

const bars = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    symbol: 'XYZ',
    timestampMs: Date.UTC(2026, 0, 5) + index * DAY_MS,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1000,
  }));

const vectorizedInput = () => {
  const data = bars(40);
  return {
    data,
    signal: data.map((_, index) => (index >= 5 ? 1 : 0)),
    initialCapital: 100_000,
    feeBps: 2,
  };
};

// ── portfolio (journey.test.ts `ledgerEvents` / `ledger` / `market` / `marks` / `policy`) ─────

function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    eventId,
    schemaVersion: 1,
    eventType: event['eventType'],
    sourceId: 'journey',
    accountId: 'main',
    effectiveTimestampMs,
    recordedTimestampMs: effectiveTimestampMs,
    event,
    provenance: {},
  };
}

const ledgerEvents = () => [
  envelope('dep-1', Date.UTC(2026, 0, 1, 15), {
    eventType: 'cash.deposit',
    amount: 100_000,
    currency: 'USD',
  }),
  envelope('fill-1', Date.UTC(2026, 0, 10, 15), {
    eventType: 'trade.fill',
    instrumentId: 'AAPL',
    side: 'buy',
    quantity: 100,
    pricePerUnit: 150,
    currency: 'USD',
  }),
  envelope('dep-2', Date.UTC(2026, 1, 1, 12), {
    eventType: 'cash.deposit',
    amount: 20_000,
    currency: 'USD',
  }),
  envelope('wd-1', Date.UTC(2026, 2, 1, 12), {
    eventType: 'cash.withdrawal',
    amount: 5_000,
    currency: 'USD',
  }),
];

/** The serialized ledger envelope (`totalfinance.portfolio-ledger`) — re-hydrated by the read door. */
const ledgerEnvelope = (): Fixture =>
  wire(
    createPortfolioLedger({
      portfolioId: 'primary',
      baseCurrency: 'USD',
      events: ledgerEvents() as never,
    }).toJSON(),
  );

const market = (asOf: string, applePrice: number): Fixture =>
  wire(
    createMarketSnapshot({
      asOf,
      observations: { spots: { AAPL: { price: applePrice, currency: 'USD' } } },
    }),
  );

const marks = () => [
  { valuationDate: '2026-01-02', market: market('2026-01-02', 150) },
  { valuationDate: '2026-02-01', market: market('2026-02-01', 160) },
  { valuationDate: '2026-03-01', market: market('2026-03-01', 155) },
  { valuationDate: '2026-04-01', market: market('2026-04-01', 162) },
];

const instrumentClassification = () => ({ AAPL: { assetClass: 'equity', tags: ['tech'] } });

const policy = () => ({
  targets: [
    { group: { instrumentId: 'AAPL' }, weight: 0.2 },
    { group: { assetClass: 'cash' }, weight: 0.8 },
  ],
  driftBand: 0.03,
  minimumCash: 10_000,
  limits: { maximumPositionWeight: 0.25, maximumDrawdown: 0.2, maximumGrossLeverage: 1.5 },
});

const PORTFOLIO_AS_OF = '2026-03-01';

const portfolioSnapshotInput = () => ({
  portfolio: ledgerEnvelope(),
  asOf: PORTFOLIO_AS_OF,
  market: market(PORTFOLIO_AS_OF, 155),
});

const explainPnlInput = () => {
  const [, from, to] = marks();
  return {
    ledger: ledgerEnvelope(),
    from,
    to,
    instrumentClassification: instrumentClassification(),
  };
};

const portfolioAnalyzeInput = () => ({
  ledger: ledgerEnvelope(),
  asOf: PORTFOLIO_AS_OF,
  market: market(PORTFOLIO_AS_OF, 155),
  instrumentClassification: instrumentClassification(),
  marks: marks(),
  monitor: { policy: policy(), previousState: null },
});

// ── scenarios (journey.test.ts `scenarioSet` / `scenarioMarket` / spot + taylor targets) ──────

const SCENARIO_AS_OF = Date.UTC(2026, 7, 30);

const scenarioSet = (): Fixture =>
  wire(
    createScenarioSet({
      name: 'journey',
      scenarios: [
        { name: 'spot up 10%', shocks: [{ factor: 'spot', kind: 'percent', value: 0.1 }] },
        { name: 'spot down 20%', shocks: [{ factor: 'spot', kind: 'percent', value: -0.2 }] },
      ],
    }),
  );

const scenarioMarket = (): Fixture =>
  wire(
    createMarketSnapshot({
      asOf: SCENARIO_AS_OF,
      observations: { spots: { AAPL: { price: 100, currency: 'USD' } } },
    }),
  );

const scenarioRunInput = () => ({
  scenarioSet: scenarioSet(),
  market: scenarioMarket(),
  targets: [
    {
      kind: 'spot',
      id: 'aapl-stock',
      symbol: 'AAPL',
      quantity: 2,
      currency: 'USD',
      tags: ['equity'],
    },
    {
      kind: 'taylor',
      id: 'aapl-delta-one',
      quantity: 3,
      contractMultiplier: 1,
      currency: 'USD',
      underlying: 'AAPL',
      baseValuePerUnit: 100,
      greeks: { delta: 1 },
      factors: { spot: { subject: 'AAPL', level: 100 } },
    },
  ],
  reportingCurrency: 'USD',
  // Explicit seed: the schema accepts one, so the parity run never depends on the runtime's default.
  options: { failureMode: 'fail-fast', seed: 7 },
});

// ── research (journey.test.ts `universe` and the event-study series) ──────────────────────────

const RESEARCH_AS_OF = Date.UTC(2026, 0, 31);

const universe = () => ({
  universeId: 'fixture',
  asOf: RESEARCH_AS_OF,
  observations: [
    {
      instrumentId: 'AAA',
      availableTimestampMs: RESEARCH_AS_OF - 1,
      fields: { momentum: 0.12, value: 3.1, sector: 'tech' },
    },
    {
      instrumentId: 'BBB',
      availableTimestampMs: RESEARCH_AS_OF - 1,
      fields: { momentum: -0.04, value: 1.2, sector: 'energy' },
    },
    {
      instrumentId: 'CCC',
      availableTimestampMs: RESEARCH_AS_OF - 1,
      fields: { momentum: 0.31, value: null, sector: 'tech' },
    },
    {
      instrumentId: 'DDD',
      availableTimestampMs: RESEARCH_AS_OF - 1,
      fields: { momentum: 0.05, value: 2.2, sector: 'health' },
    },
  ],
  fieldDefinitions: [
    { fieldName: 'momentum', kind: 'numeric', unit: 'decimal ratio' },
    { fieldName: 'value', kind: 'numeric' },
    { fieldName: 'sector', kind: 'category' },
  ],
});

const screenInput = () => ({
  ...universe(),
  filter: {
    all: [
      { field: 'momentum', operator: 'greaterThan', value: 0 },
      { field: 'sector', operator: 'equals', value: 'tech' },
    ],
  },
  missingValuePolicy: 'exclude',
  orderBy: [{ field: 'momentum', direction: 'descending' }],
  limit: 5,
});

const rankInput = () => ({
  ...universe(),
  rankBy: { field: 'momentum', direction: 'descending' },
  tiePolicy: 'competition',
  missingValuePolicy: 'exclude',
});

const scoreInput = () => ({
  ...universe(),
  components: [
    { field: 'momentum', weight: 2, direction: 'higher-is-better', standardization: 'z-score' },
    { field: 'value', weight: 1, direction: 'lower-is-better', standardization: 'percentile-rank' },
  ],
  missingValuePolicy: 'renormalize-weights',
});

/** Forty consecutive weekdays from Monday 2026-01-05 (journey.test.ts "event study"). */
const weekdays = (): string[] => {
  const dates: string[] = [];
  for (let day = 0; dates.length < 40; day += 1) {
    const date = new Date(Date.UTC(2026, 0, 5 + day));
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
};

const eventStudyInput = () => ({
  events: [
    {
      eventId: 'e1',
      instrumentId: 'AAA',
      eventType: 'earnings',
      announcedTimestampMs: Date.UTC(2026, 1, 16) + 1, // a Monday inside the series
    },
  ],
  returnObservations: weekdays().map((tradingSessionDate, index) => ({
    instrumentId: 'AAA',
    tradingSessionDate,
    simpleReturn: 0.001 * ((index % 7) - 3),
  })),
  eventWindow: { startTradingSessionOffset: -1, endTradingSessionOffset: 1 },
  estimationWindow: { startTradingSessionOffset: -20, endTradingSessionOffset: -5 },
  expectedReturnModel: { model: 'mean-adjusted' },
  overlappingEventPolicy: 'reject',
  cumulativeConvention: 'sum',
});

// ── artifacts (journey.test.ts `artifactOf`) ──────────────────────────────────────────────────

const artifactOf = (value: number): Fixture =>
  wire(
    createAnalysisArtifact({
      artifactType: 'options.chain-analysis',
      producedBy: { operation: 'analyzeChain' },
      inputs: { parameters: { minOpenInterest: 100 } },
      result: {
        value,
        rows: [1, 2, 3],
        nested: { a: 1 },
        label: 'x'.repeat(300),
        flag: true,
        nothing: null,
        assumptions: { conventionsVersion: 'fixture', method: 'fixture' },
        diagnostics: { warnings: [] },
      },
    }),
  );

// ── options backtest (journey.test.ts `chainSnapshot` / `chains`) ─────────────────────────────

const T0 = Date.UTC(2026, 0, 5);
const isoDay = (offsetDays: number): string =>
  new Date(T0 + offsetDays * DAY_MS).toISOString().slice(0, 10);

/** One dated chain snapshot: mid + delta from the BSM pricer, so selection and marking are coherent. */
function chainSnapshot(dayOffset: number, spot: number, expiry: string) {
  const date = isoDay(dayOffset);
  // An end-of-day chain is observed at the close (a valuation instant, never a bare date).
  const ts = usEquitySessionInstant(date, 'close');
  const t = (optionExpiryToMs(expiry) - ts) / (DAY_MS * 365);
  const vol = 0.2;
  const rate = 0.04;
  const quotes: Record<string, unknown>[] = [];
  for (let strike = 80; strike <= 120; strike += 5) {
    for (const type of ['call', 'put'] as const) {
      const pricing = {
        type,
        spot,
        strike,
        timeToExpiryYears: t,
        riskFreeRate: rate,
        dividendYield: 0,
        volatility: vol,
      };
      quotes.push({
        contract: {
          underlying: 'XYZ',
          type,
          style: 'european',
          strike,
          expiry,
          ...resolvedExpiry(expiry),
          multiplier: 100,
        },
        timestampMs: ts,
        mid: blackScholesPrice(pricing),
        impliedVolatility: vol,
        greeks: { delta: blackScholesGreeks(pricing).delta },
        underlyingPrice: spot,
      });
    }
  }
  return { asOf: ts, underlyingPrice: spot, quotes };
}

/**
 * Eight weekly snapshots over a flat underlying; the listed expiry (day 56) sits past the last
 * snapshot (day 49), so every quote prices. 8 × 9 strikes × 2 types = 144 quotes.
 */
const chains = () => {
  const expiry = isoDay(56);
  return Array.from({ length: 8 }, (_, index) => chainSnapshot(index * 7, 100, expiry));
};

const optionsRunInput = () => ({
  chains: chains(),
  initialCapital: 100_000,
  riskFreeRate: 0.04,
  entry: {
    daysToExpiry: { target: 45, min: 30, max: 60 },
    structure: 'bullPutSpread',
    select: { shortDelta: 0.3, width: 5 },
  },
  exit: { profitTarget: 0.5, daysToExpiry: 21 },
  marking: { volatility: 'current-quote', missingMark: 'entry-volatility' },
  commission: { model: 'bps', bps: 2 },
  slippage: { model: 'spread', spread: 0.01 },
});

// ── cross-sectional backtest (Stage 4.6 slice 3; cross-sectional.test.ts universe) ────────────

const crossSectionalInput = () => {
  const sessions = [
    '2026-01-02',
    '2026-01-09',
    '2026-01-16',
    '2026-01-23',
    '2026-01-30',
    '2026-02-06',
  ];
  const names = ['AAA', 'BBB', 'CCC'];
  const drift: Record<string, number> = { AAA: 0.02, BBB: 0, CCC: -0.02 };
  const returns = names.flatMap((instrumentId) =>
    sessions.map((tradingSessionDate, index) => ({
      instrumentId,
      tradingSessionDate,
      simpleReturn: drift[instrumentId]! + (index % 2 === 0 ? 0.001 : -0.001),
    })),
  );
  const quality: Record<string, number> = { AAA: 3, BBB: 2, CCC: 1 };
  return {
    dataset: {
      observations: names.map((instrumentId) => ({
        instrumentId,
        availableTimestampMs: Date.UTC(2026, 0, 1, 21),
        fields: { quality: quality[instrumentId]! },
      })),
      fieldDefinitions: [{ fieldName: 'quality', kind: 'numeric' }],
      returns,
    },
    universeHistory: {
      universeId: 'parity-3',
      members: names.map((instrumentId) => ({
        instrumentId,
        fromTimestampMs: Date.UTC(2026, 0, 1),
      })),
    },
    signal: {
      score: {
        components: [
          {
            field: 'quality',
            weight: 1,
            direction: 'higher-is-better',
            standardization: 'z-score',
          },
        ],
        missingValuePolicy: 'exclude',
      },
    },
    rebalanceSchedule: { frequency: 'monthly', session: 'close' },
    portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
    initialCapital: 100_000,
  };
};

// ── slice 6: the portfolio backtest over the wire ──────────────────────────────────────────────
// Two equities, ten daily bars, a monthly equal-weight model on a schedule; every row set is plain
// JSON. The malformed twin sends an `onSession` string — a strategy callback is SDK-only.
const portfolioRunInput = () => {
  const days = [
    '2026-01-02',
    '2026-01-05',
    '2026-01-06',
    '2026-01-07',
    '2026-01-08',
    '2026-01-09',
    '2026-01-12',
    '2026-01-13',
    '2026-01-14',
    '2026-01-15',
  ];
  const closeOf = (date: string): number => Date.parse(`${date}T21:00:00Z`);
  const bars = days.flatMap((date, i) =>
    (['AAA', 'BBB'] as const).map((symbol) => {
      const close = (symbol === 'AAA' ? 100 : 50) * (1 + i * (symbol === 'AAA' ? 0.004 : -0.002));
      return {
        symbol,
        timestampMs: closeOf(date),
        open: close * 0.995,
        high: close * 1.01,
        low: close * 0.99,
        close,
        volume: 1_000_000,
      };
    }),
  );
  return {
    accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
    instruments: {
      AAA: { kind: 'equity', currency: 'USD' },
      BBB: { kind: 'equity', currency: 'USD' },
    },
    marketData: { bars },
    strategy: {
      model: [
        { group: { instrumentId: 'AAA' }, weight: 0.5 },
        { group: { instrumentId: 'BBB' }, weight: 0.5 },
      ],
      schedule: { frequency: 'weekly' },
    },
    calendar: 'NYSE',
  };
};

// ── Stage 4.7 slice 2: the company valuation and the rebalance proposal over the wire ─────────
// The valuation fixture is the forecasting suite's hand-walked statements (packages/valuation/test/
// forecasting.test.ts) under an exit-multiple terminal value; the rebalance fixture reuses the
// portfolio pack's ledger, market, and policy.
const valuationCompanyInput = () => ({
  projection: {
    baseStatements: {
      income: {
        period: {
          periodEndDate: '2025-12-31',
          fiscalYear: 2025,
          periodType: 'year',
          availableTimestampMs: Date.UTC(2026, 1, 23),
          currency: 'USD',
          monetaryScale: 1,
        },
        revenue: 1_000,
        operatingIncome: 180,
        netIncome: 132,
      },
      balance: {
        period: {
          periodEndDate: '2025-12-31',
          fiscalYear: 2025,
          periodType: 'year',
          availableTimestampMs: Date.UTC(2026, 1, 23),
          currency: 'USD',
          monetaryScale: 1,
        },
        cashAndCashEquivalents: 150,
        accountsReceivable: 100,
        inventory: 75,
        accountsPayable: 50,
        propertyPlantEquipmentNet: 450,
        totalAssets: 1_250,
        totalDebt: 280,
        totalLiabilities: 560,
        totalEquity: 690,
      },
      cashFlow: {
        period: {
          periodEndDate: '2025-12-31',
          fiscalYear: 2025,
          periodType: 'year',
          availableTimestampMs: Date.UTC(2026, 1, 23),
          currency: 'USD',
          monetaryScale: 1,
        },
        operatingCashFlow: 170,
        investingCashFlow: -100,
        financingCashFlow: -40,
      },
    },
    periods: [
      {
        periodLabel: 'FY2026',
        revenue: { amount: 1_100 },
        operatingMargin: 0.2,
        taxRate: 0.25,
        interestExpense: 20,
        depreciationAndAmortization: { amount: 50 },
        capitalExpenditure: { amount: 80 },
        accountsReceivable: { amount: 110 },
        inventory: { amount: 80 },
        accountsPayable: { amount: 55 },
        netBorrowing: 0,
        dividendsPaid: 30,
      },
      {
        periodLabel: 'FY2027',
        revenue: { growthRate: 0.1 },
        operatingMargin: 0.21,
        taxRate: 0.25,
        interestExpense: 20,
        depreciationAndAmortization: { amount: 55 },
        capitalExpenditure: { amount: 85 },
        accountsReceivable: { fractionOfRevenue: 0.1 },
        inventory: { fractionOfRevenue: 0.075 },
        accountsPayable: { fractionOfRevenue: 0.05 },
        netBorrowing: 25,
        dividendsPaid: 35,
      },
    ],
  },
  valuation: {
    valuationBasis: 'firm',
    valuationDate: '2025-12-31',
    currency: 'USD',
    annualDiscountRate: 0.09,
    compounding: 'annual',
    terminalValueMethod: { method: 'exit-multiple', terminalMetricAmount: 300, exitMultiple: 8 },
  },
  sensitivity: {
    rowAxis: { variable: 'annual-discount-rate', values: [0.08, 0.09, 0.1] },
    columnAxis: { variable: 'exit-multiple', values: [7, 8, 9] },
  },
});

const rebalanceProposalInput = () => ({
  ledger: ledgerEnvelope(),
  asOf: PORTFOLIO_AS_OF,
  market: market(PORTFOLIO_AS_OF, 155),
  policy: policy(),
  scope: 'to-target',
});

// ── the exported tables ───────────────────────────────────────────────────────────────────────

/** One known-valid input per operation id (fresh plain JSON per call). */
const TRADE_T0 = Date.UTC(2026, 0, 5, 21);
const TRADE_NOW = TRADE_T0 + 2 * DAY_MS;
const TRADE_CREATED = Date.parse('2026-09-06T12:00:00Z');
const tradeEnvelope = (eventId: string, at: number, event: Record<string, unknown>) => ({
  eventId,
  schemaVersion: 1,
  eventType: event['eventType'],
  sourceId: 'fixture',
  accountId: 'main',
  effectiveTimestampMs: at,
  recordedTimestampMs: at,
  event,
  provenance: {},
});
const tradeLedger = () =>
  createPortfolioLedger({
    portfolioId: 'primary',
    baseCurrency: 'USD',
    events: [
      tradeEnvelope('dep', TRADE_T0, {
        eventType: 'cash.deposit',
        amount: 100_000,
        currency: 'USD',
      }),
      tradeEnvelope('fill', TRADE_T0 + DAY_MS, {
        eventType: 'trade.fill',
        instrumentId: 'AAA',
        side: 'buy',
        quantity: 100,
        pricePerUnit: 100,
        currency: 'USD',
      }),
    ] as never,
  });
const tradeMarket = () =>
  createMarketSnapshot({
    asOf: TRADE_NOW,
    observations: {
      spots: { AAA: { price: 110, currency: 'USD' }, BBB: { price: 50, currency: 'USD' } },
    },
  });
const tradeIntent = () => ({
  kind: 'totalfinance.trade-intent',
  schemaVersion: 1,
  accountId: 'main',
  asOf: TRADE_NOW,
  orders: [
    { instrumentId: 'BBB', side: 'buy', quantity: 200, type: 'market' },
    { instrumentId: 'AAA', side: 'sell', quantity: 20, type: 'limit', limitPrice: 112 },
  ],
  rationale: 'rotate a fifth of AAA into BBB',
});
const tradePolicy = () => ({
  mode: 'paper',
  limits: { maximumPositionWeight: 0.5, maximumGrossLeverage: 1 },
  maximumOrderNotional: 50_000,
  marketMaximumAgeMs: DAY_MS,
});
const tradePlan = () =>
  normalizeTradePlan({
    intent: tradeIntent() as never,
    portfolio: tradeLedger().state,
    market: tradeMarket(),
    asOf: TRADE_NOW,
  });
const tradePreflight = () =>
  preflightTradePlan({
    plan: tradePlan(),
    portfolio: tradeLedger().state,
    market: tradeMarket(),
    asOf: TRADE_NOW,
    policy: tradePolicy() as never,
  });
// B6: a grant is consumed by its first successful submission, so each scenario that submits
// mints its own grant (the grant id is part of the content hash).
const tradeGrant = (grantId?: string) =>
  createAuthorizationGrant({
    plan: tradePlan(),
    preflight: tradePreflight(),
    marketMaximumAgeMs: DAY_MS,
    mode: 'paper',
    variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
    expiresAt: TRADE_NOW + DAY_MS,
    approvedBy: 'parity',
    idempotencyKeys: { prefix: 'parity', count: 2 },
    now: TRADE_NOW,
    ...(grantId === undefined ? {} : { grantId }),
  });
const tradeBar = (symbol: string, open: number, high: number, low: number, close: number) => ({
  kind: 'bar',
  bar: { symbol, timestampMs: TRADE_NOW + 60_000, open, high, low, close, volume: 10_000 },
});
const tradeSubmitInput = (grantId?: string) => ({
  plan: tradePlan(),
  grant: tradeGrant(grantId),
  idempotencyKey: 'parity:1',
  now: TRADE_NOW + 1_000,
  portfolioHash: tradePreflight().portfolioHash,
  marketHash: tradePreflight().marketHash,
  marketAsOf: TRADE_NOW,
  sourceId: 'paper:parity',
  accountId: 'main',
  baseCurrency: 'USD',
  instruments: { AAA: { currency: 'USD' }, BBB: { currency: 'USD' } },
  observations: {
    BBB: tradeBar('BBB', 50, 51, 49, 50.5),
    AAA: tradeBar('AAA', 110, 115, 109, 114),
  },
  asOf: TRADE_NOW + 60_000,
});
// A restart fixture must carry the broker's complete, persisted context, not a handwritten subset.
const tradeJournalEvents = (
  sourceId = 'paper:parity',
  idempotencyKey = 'parity:1',
  grantId?: string,
) => {
  const input = tradeSubmitInput(grantId);
  const broker = createPaperBroker({
    sourceId,
    accountId: input.accountId,
    baseCurrency: input.baseCurrency,
    instruments: input.instruments,
  });
  broker.submit({
    plan: input.plan,
    grant: input.grant,
    idempotencyKey,
    now: input.now,
    portfolioHash: input.portfolioHash,
    marketHash: input.marketHash,
    marketAsOf: input.marketAsOf,
  });
  return broker.journal();
};

/** Real prerequisite operations, executed separately through EACH transport's trusted stores. */
export const PARITY_PREREQUISITES: Record<string, () => { id: string; input: Fixture }[]> = {
  'totalfinance.trade.submit': () => [
    {
      id: 'totalfinance.trade.authorize',
      input: PARITY_FIXTURES['totalfinance.trade.authorize']!(),
    },
  ],
  'totalfinance.trade.cancel': () => [
    {
      id: 'totalfinance.trade.authorize',
      input: wire({
        ...(PARITY_FIXTURES['totalfinance.trade.authorize']!() as Record<string, unknown>),
        grantId: 'grant:parity-cancel',
      }),
    },
    {
      id: 'totalfinance.trade.submit',
      input: wire({
        ...tradeSubmitInput('grant:parity-cancel'),
        sourceId: 'paper:parity-cancel',
        idempotencyKey: 'parity:2',
        observations: undefined,
        asOf: undefined,
      }),
    },
  ],
};

export const PARITY_FIXTURES: Record<string, FixtureThunk> = {
  // trade pack (Stage 7B.2 slice 4) — the lifecycle's six operations
  'totalfinance.trade.preflight': () =>
    wire({
      intent: tradeIntent(),
      portfolio: tradeLedger().toJSON(),
      market: tradeMarket(),
      asOf: TRADE_NOW,
      policy: tradePolicy(),
      costs: { commissionBps: 5, slippageBps: 10 },
    }),
  'totalfinance.trade.authorize': () =>
    wire({
      plan: tradePlan(),
      preflight: tradePreflight(),
      approvedBy: 'parity',
      expiresAt: TRADE_NOW + DAY_MS,
      now: TRADE_NOW,
      variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
      marketMaximumAgeMs: DAY_MS,
      idempotencyKeys: { prefix: 'parity', count: 2 },
      createdTimestampMs: TRADE_CREATED,
    }),
  'totalfinance.trade.submit': () => wire(tradeSubmitInput()),
  'totalfinance.trade.cancel': () =>
    wire({
      journal: tradeJournalEvents('paper:parity-cancel', 'parity:2', 'grant:parity-cancel'),
      orderId: tradePlan().orders[0]!.orderId,
      now: TRADE_NOW + 2_000,
      sourceId: 'paper:parity-cancel',
      accountId: 'main',
      baseCurrency: 'USD',
    }),
  'totalfinance.trade.reconcile': () =>
    wire({
      journal: tradeJournalEvents(),
      ledger: tradeLedger().toJSON(),
      sourceId: 'paper:parity',
      fills: [],
      asOf: TRADE_NOW + 120_000,
      tolerance: { quantity: 1e-9, cashAmount: 0.01 },
    }),
  'totalfinance.portfolio.record_events': () =>
    wire({
      portfolio: tradeLedger().toJSON(),
      events: [
        tradeEnvelope('dep-2', TRADE_NOW, {
          eventType: 'cash.deposit',
          amount: 1_000,
          currency: 'USD',
        }),
      ],
      createdTimestampMs: TRADE_CREATED,
    }),

  // options pack — first-touch `priceInput`; server.test.ts IV round-trip
  'totalfinance.option.price': () => wire(priceInput()),
  'totalfinance.option.greeks': () => wire({ ...priceInput(), type: 'put', dividendYield: 0.01 }),
  'totalfinance.option.implied_volatility': () => wire(impliedVolatilityInput()),

  // technical_analysis pack — registry: rsi (series, default period 14); server.test.ts list/describe
  'totalfinance.technical_analysis.calculate': () =>
    wire({ indicator: 'rsi', closes: closes(), parameters: { period: 14 } }),
  'totalfinance.technical_analysis.list': () =>
    wire({ category: 'momentum', search: 'rsi', limit: 5, offset: 0 }),
  'totalfinance.technical_analysis.describe': () => wire({ name: 'rsi' }),

  // strategy pack — analysis-tools.test.ts named dispatch / catalog
  'totalfinance.strategy.analyze': () => wire(strategyAnalyzeInput()),
  'totalfinance.strategy.list': () => wire({ multiExpiry: false }),

  // volatility pack — compute-file schemas; analysis-tools.test.ts vol tools
  'totalfinance.volatility.expected_move': () =>
    wire({ spot: 100, impliedVolatility: 0.2, timeToExpiryYears: 30 / 365 }),
  'totalfinance.volatility.probability_in_the_money': () =>
    wire({
      type: 'call',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    }),
  'totalfinance.volatility.probability_of_touch': () =>
    wire({ spot: 100, barrier: 110, timeToExpiryYears: 0.25, riskFreeRate: 0.04, volatility: 0.2 }),
  'totalfinance.volatility.surface': () => wire(surfaceInput()),
  'totalfinance.volatility.metrics': () => wire({ current: 0.22, history: volatilityHistory() }),
  'totalfinance.volatility.event': () =>
    wire({
      atmVolatility: 0.6,
      baseVolatility: 0.3,
      timeToExpiryYears: 5 / 365,
      realizedVolatility: 0.4,
    }),

  // structure pack — server.test.ts `sampleChain`; analysis-tools.test.ts flow prints
  'totalfinance.structure.exposures': () => wire(exposuresInput()),
  'totalfinance.structure.flow': () => wire(flowInput()),

  // risk pack — server.test.ts `sampleReturns` (monteCarlo WITH an explicit seed); analysis-tools optimize
  'totalfinance.risk.value_at_risk': () =>
    wire({
      returns: sampleReturns(),
      confidence: 0.95,
      method: 'monteCarlo',
      horizonPeriods: 1,
      samples: 5000,
      seed: 7,
    }),
  'totalfinance.risk.optimize': () =>
    wire({ objective: 'minVariance', covariance: covariance(), longOnly: true, budget: 1 }),

  // performance / calendar / crypto / fixed_income packs — analysis-tools + domain-tools tests
  'totalfinance.performance.analyze': () =>
    wire({ returns: sampleReturns(), periodsPerYear: 252, riskFreeRate: 0.02 }),
  'totalfinance.calendar.sessions': () => wire(calendarInput()),
  'totalfinance.crypto.perpetual_funding': () =>
    wire({ markPrice: 101, indexPrice: 100, fundingRate: 0.0001, intervalHours: 8 }),
  'totalfinance.crypto.futures_basis': () =>
    wire({ spot: 100, future: 104, timeToExpiryYears: 0.5, financingRate: 0.01 }),
  'totalfinance.fixed_income.bond_analytics': () => wire({ ...bondSpecification(), yield: 0.045 }),

  // backtest pack (opt-in) — analysis-tools.test.ts bars; journey.test.ts chains
  'totalfinance.backtest.vectorized_run': () => wire(vectorizedInput()),
  'totalfinance.backtest.options_run': () => wire(optionsRunInput()),
  'totalfinance.backtest.cross_sectional_run': () => wire(crossSectionalInput()),
  'totalfinance.backtest.portfolio_run': () => wire(portfolioRunInput()),
  'totalfinance.backtest.environment_episode': () =>
    wire({ episode: 'range-bound', policy: { baseline: 'buyAndHold' }, seed: 7 }),

  // portfolio pack — journey.test.ts ledger / marks / policy
  'totalfinance.portfolio.snapshot': () => wire(portfolioSnapshotInput()),
  'totalfinance.portfolio.explain_pnl': () => wire(explainPnlInput()),
  'totalfinance.portfolio.analyze': () => wire(portfolioAnalyzeInput()),
  'totalfinance.portfolio.rebalance_proposal': () => wire(rebalanceProposalInput()),

  // valuation pack — the forecasting suite's statements under an exit multiple
  'totalfinance.valuation.company': () => wire(valuationCompanyInput()),

  // scenario pack — journey.test.ts spot + taylor targets
  'totalfinance.scenario.run': () => wire(scenarioRunInput()),

  // research pack — journey.test.ts universe / event study
  'totalfinance.research.screen': () => wire(screenInput()),
  'totalfinance.research.rank': () => wire(rankInput()),
  'totalfinance.research.score': () => wire(scoreInput()),
  'totalfinance.research.event_study': () => wire(eventStudyInput()),

  // artifact pack — journey.test.ts `artifactOf`
  'totalfinance.artifact.read': () => wire({ artifact: artifactOf(1.5) }),
  'totalfinance.artifact.compare': () =>
    wire({
      baseline: artifactOf(1.5),
      candidate: artifactOf(1.5005),
      tolerance: { absolute: 0.001, relative: 0 },
    }),
};

/**
 * One malformed input per id, refused by the operation's OWN `inputSchema` under
 * `safeParse(input, { mode: 'strict' })` (the runtime's parse) with the `input.*` code noted on each
 * line. Each is a single, deliberate defect on top of the valid fixture — never a second fixture.
 */
export const PARITY_MALFORMED: Record<string, FixtureThunk> = {
  'totalfinance.trade.preflight': () =>
    wire({
      intent: tradeIntent(),
      portfolio: tradeLedger().toJSON(),
      market: tradeMarket(),
      asOf: 'yesterday',
      policy: tradePolicy(),
    }),
  'totalfinance.trade.authorize': () =>
    wire({
      plan: tradePlan(),
      preflight: tradePreflight(),
      approvedBy: '',
      expiresAt: TRADE_NOW + DAY_MS,
      now: TRADE_NOW,
      variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
      marketMaximumAgeMs: DAY_MS,
      idempotencyKeys: ['k'],
      createdTimestampMs: TRADE_CREATED,
    }),
  'totalfinance.trade.submit': () => wire({ ...tradeSubmitInput(), idempotencyKey: 7 }),
  'totalfinance.trade.cancel': () =>
    wire({
      orderId: 'x',
      now: 'now',
      sourceId: 'paper:parity',
      accountId: 'main',
      baseCurrency: 'USD',
    }),
  'totalfinance.trade.reconcile': () =>
    wire({
      journal: tradeJournalEvents(),
      ledger: tradeLedger().toJSON(),
      sourceId: 'paper:parity',
      fills: [],
      asOf: TRADE_NOW,
      tolerance: { quantity: -1, cashAmount: 0.01 },
    }),
  'totalfinance.portfolio.record_events': () =>
    wire({ portfolio: tradeLedger().toJSON(), events: [], createdTimestampMs: TRADE_CREATED }),

  // input.out_of_range — `spot` is `.positive()`
  'totalfinance.option.price': () => wire({ ...priceInput(), spot: -100 }),
  // input.missing_field — `type` is required
  'totalfinance.option.greeks': () => {
    const { type: _type, ...rest } = priceInput();
    return wire(rest);
  },
  // input.out_of_range — `price` is `.positive()`
  'totalfinance.option.implied_volatility': () => wire({ ...impliedVolatilityInput(), price: -1 }),

  // input.invalid_enum — `indicator` is the registry enum
  'totalfinance.technical_analysis.calculate': () =>
    wire({ indicator: 'not_an_indicator', closes: closes() }),
  // input.out_of_range — `limit` is `.integer().positive()`
  'totalfinance.technical_analysis.list': () => wire({ limit: -1 }),
  // input.missing_field — `name` is required
  'totalfinance.technical_analysis.describe': () => wire({}),

  // input.out_of_range — `market.spot` is `.positive()`
  'totalfinance.strategy.analyze': () =>
    wire({ ...strategyAnalyzeInput(), market: { ...strategyMarket(), spot: -100 } }),
  // input.wrong_type — `multiExpiry` is a boolean
  'totalfinance.strategy.list': () => wire({ multiExpiry: 'yes' }),

  // input.out_of_range — `spot` is `.positive()`
  'totalfinance.volatility.expected_move': () =>
    wire({ spot: -100, impliedVolatility: 0.2, timeToExpiryYears: 30 / 365 }),
  // input.invalid_enum — `type` is call | put
  'totalfinance.volatility.probability_in_the_money': () =>
    wire({
      type: 'straddle',
      spot: 100,
      strike: 105,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      volatility: 0.2,
    }),
  // input.missing_field — `volatility` is required
  'totalfinance.volatility.probability_of_touch': () =>
    wire({ spot: 100, barrier: 110, timeToExpiryYears: 0.25, riskFreeRate: 0.04 }),
  // input.invalid_enum — `model` is interpolated | raw | smoothed | svi | sabr
  'totalfinance.volatility.surface': () => wire({ ...surfaceInput(), model: 'cubic' }),
  // input.missing_field — `history` is required
  'totalfinance.volatility.metrics': () => wire({ current: 0.22 }),
  // input.out_of_range — `atmVolatility` is `.positive()`
  'totalfinance.volatility.event': () =>
    wire({ atmVolatility: -0.6, baseVolatility: 0.3, timeToExpiryYears: 5 / 365 }),

  // input.missing_field — `asOf` is required
  'totalfinance.structure.exposures': () => {
    const { asOf: _asOf, ...rest } = exposuresInput();
    return wire(rest);
  },
  // input.out_of_range — a print `size` is `.positive()`
  'totalfinance.structure.flow': () => {
    const [first, ...rest] = flowTrades();
    return wire({ ...flowInput(), trades: [{ ...first, size: -60 }, ...rest] });
  },

  // input.out_of_range — `samples` is capped at 1,000,000 by the schema (bounded BEFORE work starts)
  'totalfinance.risk.value_at_risk': () =>
    wire({ returns: sampleReturns(), method: 'monteCarlo', seed: 7, samples: 5_000_000 }),
  // input.invalid_enum — `objective` is the six-member enum
  'totalfinance.risk.optimize': () => wire({ objective: 'maxDrawdown', covariance: covariance() }),

  // input.out_of_range — `periodsPerYear` is `.positive()`
  'totalfinance.performance.analyze': () =>
    wire({ returns: sampleReturns(), periodsPerYear: -252 }),
  // input.invalid_enum — `calendar` is NYSE | CBOE | crypto24x7
  'totalfinance.calendar.sessions': () => wire({ ...calendarInput(), calendar: 'LSE' }),
  // input.missing_field — `fundingRate` is required
  'totalfinance.crypto.perpetual_funding': () => wire({ markPrice: 101, indexPrice: 100 }),
  // input.out_of_range — `timeToExpiryYears` is `.positive()`
  'totalfinance.crypto.futures_basis': () =>
    wire({ spot: 100, future: 104, timeToExpiryYears: -0.5 }),
  // input.invalid_enum — `frequency` is annual | semiannual | quarterly | monthly
  'totalfinance.fixed_income.bond_analytics': () =>
    wire({ ...bondSpecification(), frequency: 'biweekly', yield: 0.045 }),

  // input.unknown_field — closed object: `leverage` is not a wire field
  'totalfinance.backtest.vectorized_run': () => wire({ ...vectorizedInput(), leverage: 2 }),
  // input.unknown_field — an exit `when` predicate is SDK-only (journey.test.ts "callbacks are not wire values")
  'totalfinance.backtest.options_run': () =>
    wire({ ...optionsRunInput(), exit: { profitTarget: 0.5, when: 'never' } }),
  // input.unknown_field — a signal callback is SDK-only (the wire signal is a recipe, a score, or a screen)
  'totalfinance.backtest.cross_sectional_run': () =>
    wire({ ...crossSectionalInput(), signal: { callback: 'rank by quality' } }),
  // input.unknown_field — a session callback is SDK-only (the wire strategy is a model on a schedule)
  'totalfinance.backtest.portfolio_run': () =>
    wire({ ...portfolioRunInput(), strategy: { onSession: 'buy the dip' } }),
  // input.invalid_enum — a TypeScript policy is SDK-only; the wire names a maintained baseline
  'totalfinance.backtest.environment_episode': () =>
    wire({ episode: 'range-bound', policy: { baseline: 'myPolicy' }, seed: 7 }),

  // input.missing_field — `market` is required
  'totalfinance.portfolio.snapshot': () => {
    const { market: _market, ...rest } = portfolioSnapshotInput();
    return wire(rest);
  },
  // input.out_of_range — `from.valuationDate` is a strict `.date()` (YYYY-MM-DD)
  'totalfinance.portfolio.explain_pnl': () => {
    const input = explainPnlInput();
    return wire({ ...input, from: { ...input.from, valuationDate: '2026/02/01' } });
  },
  // input.missing_field — `monitor.previousState` is required exactly as monitorPortfolio requires it
  'totalfinance.portfolio.analyze': () =>
    wire({ ...portfolioAnalyzeInput(), monitor: { policy: policy() } }),
  // input.invalid_enum — `scope` is 'to-target' | 'drift-only'
  'totalfinance.portfolio.rebalance_proposal': () =>
    wire({ ...rebalanceProposalInput(), scope: 'everything' }),
  // input.missing_field — the discount rate is REQUIRED and explicit (FC0: never a default)
  'totalfinance.valuation.company': () => {
    const input = valuationCompanyInput();
    const { annualDiscountRate: _rate, ...valuation } = input.valuation;
    return wire({ ...input, valuation });
  },

  // input.unknown_field — `options.marketResolvers` is an SDK-only callback field (journey.test.ts)
  'totalfinance.scenario.run': () =>
    wire({
      ...scenarioRunInput(),
      options: { failureMode: 'fail-fast', seed: 7, marketResolvers: [] },
    }),

  // input.unknown_field — a caller predicate is not a wire field (journey.test.ts)
  'totalfinance.research.screen': () => wire({ ...screenInput(), customPredicate: true }),
  // input.invalid_enum — `tiePolicy` is competition | dense | ordinal
  'totalfinance.research.rank': () => wire({ ...rankInput(), tiePolicy: 'random' }),
  // input.out_of_range — `components` is `.min(1)`
  'totalfinance.research.score': () => wire({ ...scoreInput(), components: [] }),
  // input.missing_field — `overlappingEventPolicy` is required
  'totalfinance.research.event_study': () => {
    const { overlappingEventPolicy: _policy, ...rest } = eventStudyInput();
    return wire(rest);
  },

  // input.invalid_enum — `artifact.kind` is the literal 'totalfinance.analysis-artifact'
  'totalfinance.artifact.read': () =>
    wire({ artifact: { ...artifactOf(1.5), kind: 'totalfinance.market-snapshot' } }),
  // input.out_of_range — `tolerance.absolute` is `.nonnegative()`
  'totalfinance.artifact.compare': () =>
    wire({
      baseline: artifactOf(1.5),
      candidate: artifactOf(1.5005),
      tolerance: { absolute: -0.001, relative: 0 },
    }),
};

/**
 * Ids whose VALID fixture serializes above the 64 KiB transport budget
 * (`OPERATION_BUDGETS.maxInputBytes.transportDefault` = 65,536 bytes, measured as `JSON.stringify`
 * UTF-8). Empty: every fixture measured under the budget — see the measurement note at the bottom.
 */
export const PARITY_LARGE_INPUT_IDS: readonly string[] = [];

/** Every id in the fixture tables, in pack order — a parity harness iterates this. */
export const PARITY_OPERATION_IDS: readonly string[] = Object.keys(PARITY_FIXTURES);
