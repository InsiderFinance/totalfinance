/**
 * E5 fixture tranche: happy-path fixtures for previously-unfixtured ANALYSIS exports
 * (see tools/first-touch/unfixtured-analysis.ts — the shrink-only ratchet these burn down).
 * Same contract as every shard: thunks return FRESH, valid argument lists; probes mutate them.
 *
 * Covers `@totalfinance/backtest` (both engines, walk-forward, the tear-sheet reports, and the
 * chain-driven options backtester) and all seven `@totalfinance/crypto` carry/inverse analytics.
 */

import {
  isoDateToEpochMs,
  resolvedExpiry,
  type Bar,
  usEquitySessionInstant,
  optionExpiryToMs,
} from '@totalfinance/core';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import type { OptionQuote } from '@totalfinance/core';
import {
  brokers,
  crossSectionalBacktest,
  crossSectionalBacktestGrid,
  fees,
  vectorized,
  type Trade,
} from '@totalfinance/backtest';
import { backtestRunArtifact, readBacktestRun } from '@totalfinance/backtest/artifacts';
import {
  instrumentAdapters,
  type PortfolioBacktestRequest,
  type PortfolioStepperRequest,
} from '@totalfinance/backtest/portfolio';
import { agentBaselines } from '@totalfinance/backtest/environment';
import {
  optionsBacktest,
  type ChainSnapshot,
  type OptionsBacktestConfig,
} from '@totalfinance/backtest/options';
import { RETURNS, type FixtureThunk } from '../inputs.js';

const DAY_MS = 86_400_000;
const T0 = isoDateToEpochMs('2026-01-05');

// ── backtest inputs ──────────────────────────────────────────────────────────────────────────────

/** Daily single-symbol bars with a gentle wave — enough structure to trade both ways. */
function BT_BARS(n = 60): Bar[] {
  const bars: Bar[] = [];
  let prev = 100;
  for (let i = 0; i < n; i++) {
    const close = 100 + Math.sin(i / 4) * 6 + i * 0.05;
    bars.push({
      symbol: 'QQQ',
      timestampMs: T0 + i * DAY_MS,
      open: prev,
      high: Math.max(prev, close) + 0.8,
      low: Math.min(prev, close) - 0.8,
      close,
      volume: 1_000 + ((i * 31) % 400),
    });
    prev = close;
  }
  return bars;
}

/** A long/flat block signal aligned to {@link BT_BARS} — flips produce real (win AND loss) trades. */
function BT_SIGNAL(n = 60): number[] {
  return Array.from({ length: n }, (_, i) => (Math.floor(i / 6) % 2 === 0 ? 1 : 0));
}

/** A fresh vectorized run (costs on, weekly rebalance) — the canonical BacktestResult input. */
function BT_RESULT(): ReturnType<typeof vectorized> {
  return vectorized({
    data: BT_BARS(),
    signal: BT_SIGNAL(),
    rebalance: 'weekly',
    fees: fees.bps(1),
    initialCapital: 10_000,
  });
}

/** A small blotter with full round trips (long X, short Y) for the attribution report. */
function BT_TRADES(): Trade[] {
  return [
    {
      symbol: 'X',
      timestampMs: T0,
      side: 'buy',
      quantity: 10,
      price: 100,
      commission: 1,
      slippage: 0.5,
      multiplier: 1,
    },
    {
      symbol: 'X',
      timestampMs: T0 + DAY_MS,
      side: 'sell',
      quantity: 10,
      price: 108,
      commission: 1,
      slippage: 0.5,
      multiplier: 1,
    },
    {
      symbol: 'Y',
      timestampMs: T0,
      side: 'sell',
      quantity: 5,
      price: 50,
      commission: 1,
      slippage: 0,
      multiplier: 1,
    },
    {
      symbol: 'Y',
      timestampMs: T0 + 2 * DAY_MS,
      side: 'buy',
      quantity: 5,
      price: 47,
      commission: 1,
      slippage: 0,
      multiplier: 1,
    },
  ];
}

// ── options-backtest inputs (BSM-consistent synthetic chains, mirroring the engine tests) ────────

function isoDay(offsetDays: number): string {
  return new Date(T0 + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** One dated chain snapshot: mid + delta from the BSM pricer, so selection and MTM are coherent. */
function chainSnapshot(dayOffset: number, spot: number, expiry: string): ChainSnapshot {
  const date = isoDay(dayOffset);
  // An end-of-day chain is observed at the close (a valuation instant, never a bare date).
  const ts = usEquitySessionInstant(date, 'close');
  const t = (optionExpiryToMs(expiry) - ts) / (DAY_MS * 365);
  const vol = 0.2;
  const rate = 0.04;
  const quotes: OptionQuote[] = [];
  for (let strike = 80; strike <= 120; strike += 5) {
    for (const type of ['call', 'put'] as const) {
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
        mid: blackScholesPrice({
          type,
          spot,
          strike,
          timeToExpiryYears: t,
          riskFreeRate: rate,
          dividendYield: 0,
          volatility: vol,
        }),
        impliedVolatility: vol,
        greeks: {
          delta: blackScholesGreeks({
            type,
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            dividendYield: 0,
            volatility: vol,
          }).delta,
        },
        underlyingPrice: spot,
      });
    }
  }
  return { asOf: ts, underlyingPrice: spot, quotes };
}

/** Weekly snapshots over a flat underlying, one listed expiry at day 49 (a decaying credit trade). */
function OPTIONS_CHAINS(): ChainSnapshot[] {
  const expiry = isoDay(49);
  return Array.from({ length: 8 }, (_, i) => chainSnapshot(i * 7, 100, expiry));
}

/** A short put-spread program: enters near 45 DTE, exits at 50% of credit or 21 DTE. */
function OPTIONS_CONFIG(): OptionsBacktestConfig {
  return {
    chains: OPTIONS_CHAINS(),
    initialCapital: 100_000,
    riskFreeRate: 0.04,
    entry: {
      daysToExpiry: { target: 45, min: 30, max: 60 },
      structure: 'bullPutSpread',
      select: { shortDelta: 0.3, width: 5 },
    },
    exit: { profitTarget: 0.5, daysToExpiry: 21 },
    // Stage 4.6 slice 4 (2026-09-04): the book, the limits, the fill and freshness policies — every
    // declared count coordinate materialized by the primary fixture (the count sweep's law).
    book: { maximumOpenPositions: 2, maximumPerUnderlying: 1 },
    limits: {
      maximumMarginFraction: 0.5,
      maximumNetDelta: 10_000,
      maximumNetVega: 1_000_000,
      maximumConcentration: 0.5,
      scenarioLoss: { spotShocks: [-0.1, 0.1], volatilityShocks: [0.05], maximumLossFraction: 0.5 },
    },
    fillPolicy: { mode: 'combo', partialFill: 'reject', price: 'mid' },
    quoteFreshness: { maximumQuoteAgeMs: 86_400_000 },
    corporateActions: [],
    dividends: [],
    baseCurrency: 'USD',
  };
}

/** The strategy surface the event-driven fixture uses (structural, keeps the shard type-light). */
interface EventCtx {
  onBar(symbol: string, handler: () => void): void;
  position(symbol: string): { quantity: number };
  buy(symbol: string, opts?: { percent?: number }): string;
  close(symbol: string): void;
}

// ── the fixtures ─────────────────────────────────────────────────────────────────────────────────

// Stage 4.6 slice 1 (2026-09-03): the execution-reality heads on @totalfinance/backtest/execution —
// thunks return FRESH structures; probes mutate arguments.
const EXECUTION_T0 = Date.UTC(2026, 0, 5, 14, 30);
const EXECUTION_ORDER = () => ({
  orderId: 'o-1',
  instrumentId: 'XYZ',
  side: 'buy',
  quantity: 100,
  type: 'limit',
  limitPrice: 99,
  submittedTimestampMs: EXECUTION_T0 - 1,
});
const EXECUTION_BAR = () => ({ open: 100, high: 104, low: 97, close: 102 });
const EXECUTION_MARGIN = () => ({
  buyingPowerMultiplier: 2,
  initialMarginRate: 0.5,
  maintenanceMarginRate: 0.25,
  forcedLiquidation: 'none',
});
const EXECUTION_FILL_MODEL = () => ({
  label: 'fixture bar model',
  version: '1',
  observation: 'bar',
  fill: ({
    order,
    observation,
  }: {
    order: { quantity: number };
    observation: { kind: string; bar?: { open: number } };
  }) => ({
    outcome: 'filled',
    quantity: order.quantity,
    pricePerUnit: observation.kind === 'bar' && observation.bar ? observation.bar.open : 0,
    reference: 'bar.open',
    partial: false,
  }),
});

// Stage 4.6 slice 2 (2026-09-03): the smallest honest cross-sectional universe — three names, four
// weekly sessions, one quality field published before the first close, monthly rebalances.
const XS_SESSIONS = ['2026-01-02', '2026-01-09', '2026-01-16', '2026-01-23'];
const XS_CLOSE = (date: string): number =>
  Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), 21);
const XS_REQUEST = () => ({
  dataset: {
    observations: [
      { instrumentId: 'AAA', availableTimestampMs: XS_CLOSE('2026-01-01'), fields: { quality: 3 } },
      { instrumentId: 'BBB', availableTimestampMs: XS_CLOSE('2026-01-01'), fields: { quality: 2 } },
      { instrumentId: 'CCC', availableTimestampMs: XS_CLOSE('2026-01-01'), fields: { quality: 1 } },
    ],
    fieldDefinitions: [{ fieldName: 'quality', kind: 'numeric' }],
    returns: ['AAA', 'BBB', 'CCC'].flatMap((instrumentId, n) =>
      XS_SESSIONS.map((tradingSessionDate, i) => ({
        instrumentId,
        tradingSessionDate,
        simpleReturn: (1 - n) * 0.01 + (i % 2 === 0 ? 0.001 : -0.001),
      })),
    ),
  },
  universeHistory: {
    universeId: 'fixture-3',
    members: ['AAA', 'BBB', 'CCC'].map((instrumentId) => ({
      instrumentId,
      fromTimestampMs: XS_CLOSE('2026-01-01'),
    })),
  },
  signal: {
    score: {
      components: [
        { field: 'quality', weight: 1, direction: 'higher-is-better', standardization: 'z-score' },
      ],
      missingValuePolicy: 'exclude',
    },
  },
  rebalanceSchedule: { frequency: 'monthly', session: 'close' },
  portfolioConstruction: {
    method: 'equal-weight',
    long: { count: 1 },
    short: { count: 1 },
    neutrality: 'dollar',
  },
  initialCapital: 100_000,
});

// Stage 4.6 slice 3 (2026-09-04): the grid over the same universe (two axes, four points) and the
// run artifacts of one run and one grid — fresh per call; the artifact thunks re-run the engine.
// Eight weekly sessions for the out-of-sample verbs: a four-session training span carries three
// returns (a Sharpe needs three), so every window chooses and every held-out span runs.
const XS_OOS_SESSIONS = [
  '2026-01-02',
  '2026-01-09',
  '2026-01-16',
  '2026-01-23',
  '2026-01-30',
  '2026-02-06',
  '2026-02-13',
  '2026-02-20',
];
const XS_OOS_REQUEST = () => {
  const base = XS_REQUEST();
  const names = [...new Set(base.dataset.returns.map((r) => r.instrumentId))];
  const drift: Record<string, number> = { AAA: 0.02, BBB: 0.005, CCC: -0.01, DDD: -0.02 };
  return {
    ...base,
    dataset: {
      ...base.dataset,
      returns: names.flatMap((instrumentId) =>
        XS_OOS_SESSIONS.map((tradingSessionDate, i) => ({
          instrumentId,
          tradingSessionDate,
          simpleReturn:
            (drift[instrumentId] ?? 0) + ((i * 7 + instrumentId.charCodeAt(0)) % 5) * 0.002 - 0.004,
        })),
      ),
    },
  };
};
const XS_WALK_FORWARD_REQUEST = () => ({
  ...XS_GRID_REQUEST(),
  request: XS_OOS_REQUEST(),
  trainSessions: 4,
  testSessions: 2,
});
const XS_PURGED_FOLDS_REQUEST = () => ({
  ...XS_GRID_REQUEST(),
  request: XS_OOS_REQUEST(),
  folds: 2,
});
const XS_GRID_REQUEST = () => ({
  request: XS_REQUEST(),
  variations: [
    { path: 'portfolioConstruction.long.count', values: [1, 2] },
    { path: 'rebalanceSchedule.session', values: ['close', 'open'] },
  ],
  hygiene: { splits: 4 },
});
const XS_RUN_ARTIFACT = (): unknown =>
  JSON.parse(
    JSON.stringify(
      backtestRunArtifact({
        kind: 'cross-sectional',
        run: crossSectionalBacktest(XS_REQUEST() as never),
        input: XS_REQUEST() as never,
      }),
    ),
  );
const XS_RUN_REPORT = (): unknown =>
  JSON.parse(JSON.stringify(readBacktestRun({ artifact: XS_RUN_ARTIFACT() as never }).report));
const XS_GRID_ARTIFACT = (): unknown =>
  JSON.parse(
    JSON.stringify(
      backtestRunArtifact({
        kind: 'cross-sectional-grid',
        run: crossSectionalBacktestGrid(XS_GRID_REQUEST() as never),
        input: XS_GRID_REQUEST() as never,
      }),
    ),
  );

// Stage 4.6 slice 5 (2026-09-04): the smallest honest multi-asset run — one equity over six daily
// bars, a monthly model, T+1 settlement, every declared count coordinate materialized.
const PF_BARS = (symbol: string, count: number, level: number): Bar[] =>
  Array.from({ length: count }, (_, i) => ({
    symbol,
    timestampMs: T0 + i * DAY_MS,
    open: level + i,
    high: level + i + 1,
    low: level + i - 1,
    close: level + i,
    volume: 1_000_000,
  }));
const PF_REQUEST = (): PortfolioBacktestRequest => ({
  accounting: {
    baseCurrency: 'USD',
    initialCash: [{ currency: 'USD', amount: 100_000 }],
    lotRelief: 'fifo',
    settlement: { equity: 'T+1' },
  },
  instruments: {
    AAA: { kind: 'equity', currency: 'USD', contractMultiplier: 1, assetClass: 'equity' },
    FUT: {
      kind: 'future',
      currency: 'USD',
      contractMultiplier: 10,
      contract: {
        kind: 'future',
        underlyingInstrumentId: 'AAA',
        expiryTimestampMs: T0 + 30 * DAY_MS,
      },
      roll: { toInstrumentId: 'FUT2', sessionsBeforeExpiry: 1 },
    },
    FUT2: {
      kind: 'future',
      currency: 'USD',
      contractMultiplier: 10,
      contract: {
        kind: 'future',
        underlyingInstrumentId: 'AAA',
        expiryTimestampMs: T0 + 60 * DAY_MS,
      },
    },
    BOND: {
      kind: 'bond',
      currency: 'USD',
      coupon: {
        annualRate: 0.05,
        paymentsPerYear: 2,
        faceValuePerUnit: 100,
        dayCount: 'ACT/365F',
        issueDate: '2025-07-01',
        maturityDate: '2027-07-01',
      },
    },
  },
  marketData: {
    bars: [
      ...PF_BARS('AAA', 6, 100),
      ...PF_BARS('FUT', 6, 1000),
      ...PF_BARS('FUT2', 6, 1010),
      ...PF_BARS('BOND', 6, 99),
    ],
    dividends: [{ instrumentId: 'AAA', exDate: '2026-01-07', amount: 0.5, payDate: '2026-01-08' }],
    coupons: [{ instrumentId: 'BOND', paymentDate: '2026-01-08', amountPerUnit: 2.5 }],
    corporateActions: [],
    fundingRates: [],
    fxRates: [],
    forwardRates: [],
  },
  strategy: {
    model: [
      { group: { instrumentId: 'AAA' }, weight: 0.5 },
      { group: { assetClass: 'cash' }, weight: 0.5 },
    ],
    schedule: { frequency: 'monthly' },
    scope: 'to-target',
  },
  externalFlows: [{ timestampMs: T0 + 2 * DAY_MS, amount: 10_000, currency: 'USD' }],
  calendar: 'NYSE',
  periodsPerYear: 252,
});
const PF_MARK_INPUT = () => ({
  instrumentId: 'AAA',
  specification: { kind: 'equity' as const, currency: 'USD' },
  asOf: T0,
  latest: { bar: PF_BARS('AAA', 1, 100)[0]! },
  previous: null,
});
const PF_LIFECYCLE_INPUT = () => ({
  instrumentId: 'AAA',
  specification: { kind: 'equity' as const, currency: 'USD' },
  asOf: T0 + DAY_MS,
  previousAsOf: T0,
  held: { quantity: 100, contractMultiplier: 1 },
  mark: { pricePerUnit: 100, source: 'bar.close' },
  underlyingMark: null,
  facts: {
    dividends: [{ instrumentId: 'AAA', exDate: '2026-01-06', amount: 0.5 }],
    coupons: [],
    fundingRates: [],
    corporateActions: [],
  },
  last: false,
});

/** The portfolio request without its strategy — the stepper's request (Stage 7B.1). */
const PF_STEPPER_REQUEST = (): PortfolioStepperRequest =>
  Object.fromEntries(
    Object.entries(PF_REQUEST()).filter(([key]) => key !== 'strategy'),
  ) as unknown as PortfolioStepperRequest;

export const ANALYSIS_BACKTEST_CRYPTO_FIXTURES: Record<string, FixtureThunk> = {
  'backtest.portfolioBacktest': () => [PF_REQUEST()],
  'backtest.createPortfolioStepper': () => [PF_STEPPER_REQUEST()],
  'backtest.createTradingEnvironment': () => [
    {
      ...PF_STEPPER_REQUEST(),
      maximumSteps: 5,
      limits: { maximumPositionWeight: 0.5, maximumGrossLeverage: 2, maximumDrawdown: 0.5 },
      reward: { pnl: 1, drawdown: -2, turnover: -0.1, riskViolation: -10 },
      features: {
        lookbackReturns: [1, 5],
        realizedVolatility: { lookbacks: [5], annualization: 252 },
        drawdown: true,
      },
    },
  ],
  'backtest.runEnvironmentEpisode': () => [
    {
      definition: { ...PF_STEPPER_REQUEST(), maximumSteps: 5 },
      seed: 7,
      actions: [
        {
          kind: 'orders',
          orders: [
            { orderId: 'a', instrumentId: 'AAA', side: 'buy', quantity: 10, type: 'market' },
          ],
        },
        { kind: 'hold' },
      ],
    },
  ],
  'backtest.requireEnvironmentEpisodeInput': () => [
    'fixture',
    'input',
    { definition: { ...PF_STEPPER_REQUEST(), maximumSteps: 5 }, actions: [{ kind: 'hold' }] },
  ],
  'backtest.environmentEpisode': () => [{ id: 'trending', seed: 7 }],
  'backtest.agentBaselines.holdCash': () => [],
  'backtest.agentBaselines.buyAndHold': () => [{ weights: { AAA: 0.5, FUT: 0.1 } }],
  'backtest.agentBaselines.periodicRebalance': () => [{ everySessions: 5, weights: { AAA: 0.6 } }],
  'backtest.agentBaselines.randomValidAction': () => [7],
  'backtest.agentBaselines.riskParity': () => [{ lookback: 20, everySessions: 10 }],
  'backtest.agentBaselines.momentumCrossover': () => [{ fast: 5, slow: 20 }],
  'backtest.runAgentBench': () => [
    {
      policy: agentBaselines.holdCash(),
      episodes: [{ id: 'fixture', definition: { ...PF_STEPPER_REQUEST(), maximumSteps: 5 } }],
      seeds: [1],
    },
  ],
  'backtest.scoreAgentTranscript': () => [
    {
      transcript: {
        calls: [
          {
            operation: 'totalfinance.portfolio.snapshot',
            arguments: {},
            ok: true,
            result: { ok: 1 },
          },
        ],
        answer: { text: 'done', citedArtifactIds: [] },
      },
      expected: { operations: ['totalfinance.portfolio.snapshot'] },
    },
  ],
  'backtest.listEnvironmentEpisodes': () => [],
  'backtest.requireEnvironmentLimits': () => [
    'fixture',
    'limits',
    {
      maximumPositionWeight: 0.5,
      maximumGrossLeverage: 2,
      maximumDrawdown: 0.25,
      maximumDailyLoss: 0.1,
      minimumSettledCash: 0,
      allowUndefinedRiskOptions: false,
      maximumPositionNotional: 50_000,
      onBreach: 'terminate',
    },
  ],
  'backtest.requireRewardComposition': () => [
    'fixture',
    'reward',
    {
      pnl: 1,
      drawdown: -2,
      turnover: -0.1,
      cost: -1,
      concentration: -0.5,
      leverage: -0.5,
      riskViolation: -10,
      benchmark: { weight: 0.5, instrumentId: 'AAA' },
    },
  ],
  'backtest.requireFeatureRecipes': () => [
    'fixture',
    'features',
    {
      lookbackReturns: [1, 5, 20],
      realizedVolatility: { lookbacks: [20], annualization: 252 },
      drawdown: true,
    },
  ],
  'backtest.requireTradingEnvironmentDefinition': () => [
    'fixture',
    'definition',
    { ...PF_STEPPER_REQUEST(), maximumSteps: 5 },
  ],
  'backtest.requireEnvironmentAction': () => [
    'fixture',
    'action',
    {
      kind: 'orders',
      orders: [{ instrumentId: 'AAA', side: 'buy', quantity: 10, type: 'market' }],
      rationale: 'fixture',
    },
  ],
  'backtest.requireEnvironmentOrder': () => [
    'fixture',
    'order',
    { orderId: 'o1', instrumentId: 'AAA', side: 'buy', quantity: 10, type: 'market' },
  ],
  'backtest.requirePortfolioBacktestRequest': () => ['fixture', 'request', PF_REQUEST()],
  'backtest.requirePortfolioStepperRequest': () => ['fixture', 'request', PF_STEPPER_REQUEST()],
  'backtest.requireAccountingPolicy': () => ['fixture', 'accounting', PF_REQUEST().accounting],
  'backtest.requireInstrumentSpecification': () => [
    'fixture',
    'instrument',
    PF_REQUEST().instruments['FUT'],
  ],
  'backtest.requirePortfolioMarketData': () => ['fixture', 'marketData', PF_REQUEST().marketData],
  'backtest.assertInstrumentAdapterConformance': () => [
    {
      adapter: instrumentAdapters.equity,
      fixtures: { mark: [PF_MARK_INPUT()], lifecycle: [PF_LIFECYCLE_INPUT()] },
    },
  ],
  'backtest.adapterFor': () => ['AAA', { kind: 'equity', currency: 'USD' }],
  'backtest.accruedFromTerms': () => [
    {
      annualRate: 0.05,
      paymentsPerYear: 2,
      faceValuePerUnit: 100,
      issueDate: '2025-07-01',
      maturityDate: '2027-07-01',
    },
    T0,
  ],
  'backtest.splitShares': () => [1.5],
  'backtest.crossSectionalBacktest': () => [XS_REQUEST()],
  'backtest.requireCrossSectionalBacktestRequest': () => ['fixture', 'request', XS_REQUEST()],
  'backtest.crossSectionalBacktestGrid': () => [XS_GRID_REQUEST()],
  'backtest.requireCrossSectionalBacktestGridRequest': () => [
    'fixture',
    'request',
    XS_GRID_REQUEST(),
  ],
  'backtest.crossSectionalWalkForward': () => [XS_WALK_FORWARD_REQUEST()],
  'backtest.crossSectionalPurgedFolds': () => [XS_PURGED_FOLDS_REQUEST()],
  'backtest.requireCrossSectionalWalkForwardRequest': () => [
    'fixture',
    'request',
    XS_WALK_FORWARD_REQUEST(),
  ],
  'backtest.requireCrossSectionalPurgedFoldsRequest': () => [
    'fixture',
    'request',
    XS_PURGED_FOLDS_REQUEST(),
  ],
  'backtest.backtestRunArtifact': () => [
    {
      kind: 'cross-sectional',
      run: crossSectionalBacktest(XS_REQUEST() as never),
      input: XS_REQUEST(),
      libraryVersion: '0.0.1',
    },
  ],
  'backtest.backtestRunArtifact#grid': () => [
    {
      kind: 'cross-sectional-grid',
      run: crossSectionalBacktestGrid(XS_GRID_REQUEST() as never),
      input: XS_GRID_REQUEST(),
    },
  ],
  'backtest.readBacktestRun': () => [{ artifact: XS_RUN_ARTIFACT() }],
  'backtest.replayBacktestRun': () => [{ artifact: XS_RUN_ARTIFACT(), libraryVersion: '0.0.1' }],
  'backtest.compareBacktestRuns': () => [
    { baseline: XS_RUN_REPORT(), candidate: XS_RUN_REPORT(), limits: { listedIds: 50 } },
  ],
  'backtest.compareBacktestRuns#grid': () => [
    { baseline: XS_GRID_ARTIFACT(), candidate: XS_GRID_ARTIFACT() },
  ],
  'backtest.barTriggerPrice': () => [{ order: EXECUTION_ORDER(), bar: EXECUTION_BAR() }],
  'backtest.orderTouchSequence': () => [
    {
      bar: EXECUTION_BAR(),
      touches: [
        { orderId: 'take-profit', triggerPrice: 103, favorable: true },
        { orderId: 'stop-loss', triggerPrice: 98, favorable: false },
      ],
      policy: 'deterministic-path',
    },
  ],
  'backtest.assertFillModelConformance': () => [{ fillModel: EXECUTION_FILL_MODEL() }],
  'backtest.normalizedFillFromDecision': () => [
    {
      decision: {
        outcome: 'filled',
        quantity: 100,
        pricePerUnit: 99,
        reference: 'bar.touch:limit',
        partial: false,
      },
      order: EXECUTION_ORDER(),
      accountId: 'main',
      currency: 'USD',
      filledTimestampMs: EXECUTION_T0,
      costs: { commission: 1 },
    },
  ],
  'backtest.describeExecutionPolicy': () => [
    {
      label: 'fixture',
      realism: 'declared',
      observation: 'bar',
      fill: EXECUTION_FILL_MODEL(),
      ambiguity: 'deterministic-path',
      costs: {
        commission: { label: 'none', commission: () => 0 },
        slippage: { label: 'none', fill: (i: { referencePrice: number }) => i.referencePrice },
      },
      staleQuotes: { maximumAgeMs: null, behavior: 'fill-at-last' },
      lockedCrossed: 'fill-at-mid',
      partialFills: 'allow',
      queue: { model: 'none' },
      timeInForce: { default: 'day', expireAtSessionClose: true },
      margin: EXECUTION_MARGIN(),
    },
  ],
  'backtest.requireMarginPolicy': () => ['fixture', 'policy', EXECUTION_MARGIN()],
  'backtest.requireOrderIntent': () => ['fixture', 'order', EXECUTION_ORDER()],
  'backtest.requireFillDecision': () => [
    'fixture',
    'decision',
    {
      outcome: 'filled',
      quantity: 100,
      pricePerUnit: 99,
      reference: 'bar.touch:limit',
      partial: false,
    },
  ],
  'backtest.requireMarketObservation': () => [
    'fixture',
    'observation',
    {
      kind: 'bar',
      bar: { symbol: 'XYZ', timestampMs: EXECUTION_T0, ...EXECUTION_BAR(), volume: 1_000 },
    },
  ],
  'backtest.requireFillContext': () => [
    'fixture',
    'context',
    {
      asOf: EXECUTION_T0,
      partialFills: 'allow',
      staleQuotes: { maximumAgeMs: null, behavior: 'fill-at-last' },
      lockedCrossed: 'fill-at-mid',
      queue: { model: 'none' },
    },
  ],
  'backtest.requireExecutionPolicy': () => [
    'fixture',
    'policy',
    {
      label: 'fixture',
      realism: 'declared',
      observation: 'bar',
      fill: EXECUTION_FILL_MODEL(),
      ambiguity: 'deterministic-path',
      costs: {
        commission: { label: 'none', commission: () => 0 },
        slippage: { label: 'none', fill: (i: { referencePrice: number }) => i.referencePrice },
      },
      staleQuotes: { maximumAgeMs: null, behavior: 'fill-at-last' },
      lockedCrossed: 'fill-at-mid',
      partialFills: 'allow',
      queue: { model: 'none' },
      timeInForce: { default: 'day', expireAtSessionClose: true },
      margin: EXECUTION_MARGIN(),
    },
  ],
  'backtest.requiredInitialMargin': () => [{ notional: 10_000, policy: EXECUTION_MARGIN() }],
  'backtest.maintenanceMarginBreached': () => [
    { equity: 2_000, grossNotional: 10_000, policy: EXECUTION_MARGIN() },
  ],
  // @totalfinance/backtest
  'backtest.vectorized': () => [
    {
      data: BT_BARS(),
      signal: BT_SIGNAL(),
      rebalance: 'weekly',
      fees: fees.bps(1),
      initialCapital: 10_000,
    },
  ],
  'backtest.eventDriven': () => [
    {
      data: BT_BARS(),
      broker: brokers.simulated({ cash: 100_000 }),
      strategy(ctx: EventCtx) {
        let i = 0;
        ctx.onBar('QQQ', () => {
          i += 1;
          const pos = ctx.position('QQQ').quantity;
          if (i % 8 === 0 && pos !== 0) ctx.close('QQQ');
          else if (i % 3 === 0 && pos === 0) ctx.buy('QQQ', { percent: 0.9 });
        });
      },
    },
  ],
  'backtest.walkForward': () => [
    {
      data: BT_BARS(),
      trainSize: 20,
      testSize: 10,
      run: ({ test }: { test: Bar[] }) => vectorized({ data: test, signal: test.map(() => true) }),
    },
  ],
  'backtest.tearSheet': () => [BT_RESULT(), { monteCarlo: { iterations: 200, seed: 7 } }],
  'backtest.returnStatistics': () => [RETURNS()],
  'backtest.attribution': () => [BT_TRADES()],
  'backtest.monteCarloResample': () => [RETURNS(), { iterations: 200, seed: 3 }],
  'backtest.optionsBacktest': () => [OPTIONS_CONFIG()],
  'backtest.requireOptionsBacktestConfig': () => ['fixture', 'config', OPTIONS_CONFIG()],
  'backtest.optionsTearSheet': () => [optionsBacktest(OPTIONS_CONFIG())],

  // @totalfinance/crypto
  'crypto.perpetualFunding': () => [
    { markPrice: 30_100, indexPrice: 30_000, fundingRate: 0.0001, intervalHours: 8 },
  ],
  'crypto.futuresBasis': () => [
    { spot: 30_000, future: 30_450, timeToExpiryYears: 0.25, financingRate: 0.05, coinYield: 0 },
  ],
  'crypto.predictedFunding': () => [
    { premium: 0.0002, interestRate: 0.0001, clamp: 0.0005, cap: 0.0075 },
  ],
  'crypto.fundingBasisSpread': () => [
    {
      fundingRate: 0.0001,
      intervalHours: 8,
      spot: 30_000,
      future: 30_450,
      timeToExpiryYears: 0.25,
    },
  ],
  'crypto.optionsBasisSpread': () => [
    {
      spot: 30_000,
      strike: 30_000,
      call: 2_600,
      put: 2_150,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.05,
      future: 30_450,
    },
  ],
  'crypto.carryCurve': () => [
    {
      spot: 30_000,
      futures: [
        { timeToExpiryYears: 0.25, price: 30_450 },
        { timeToExpiryYears: 0.5, price: 30_900 },
        { timeToExpiryYears: 1, price: 31_800 },
      ],
      financingRate: 0.05,
      queryTenors: [0.75],
    },
  ],
  'crypto.inverseFuture': () => [
    { notionalUsd: 50_000, entryPrice: 30_000, markPrice: 31_000, side: 'long' },
  ],
  'crypto.inverseHedge': () => [{ coinDelta: 0.85, markPrice: 30_000, coinGamma: -0.0001 }],
  'crypto.liquidationPrice': () => [
    {
      margin: 'inverse',
      entryPrice: 30_000,
      leverage: 10,
      maintenanceMarginRate: 0.005,
      side: 'long',
    },
  ],
};
