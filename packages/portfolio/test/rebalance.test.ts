/**
 * FC7 slice 4 — `proposePortfolioRebalance`: a plan, never an execution. Every number is
 * hand-computed in a comment beside the assertion; the lot-selection preview is proven against the
 * fold itself.
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { contentHash, createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  createPortfolioLedger,
  duplicateBoundaryKey,
  type LotReliefPolicy,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
} from '../src/index.js';
import { requireInvestmentPolicy, type InvestmentPolicy } from '../src/policy-grammar.js';
import {
  proposePortfolioRebalance,
  type ProposePortfolioRebalanceInput,
  type TradePlanArtifact,
} from '../src/rebalance.js';

function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  accountId: string,
  event: PortfolioEvent,
): PortfolioEventEnvelope {
  return {
    eventId,
    schemaVersion: 1,
    eventType: event.eventType,
    sourceId: 'test',
    accountId,
    effectiveTimestampMs,
    recordedTimestampMs: effectiveTimestampMs,
    event,
    provenance: {},
  };
}

function expectCode(fn: () => unknown, code: string, fragment?: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected a throw with code ${code}`).toBeDefined();
  expect(
    isQuantError(thrown, code),
    `expected code ${code}, got ${(thrown as Error).message}`,
  ).toBe(true);
  if (fragment !== undefined) expect((thrown as Error).message).toContain(fragment);
}

const at = (month: number, day: number, hour = 15) => Date.UTC(2026, month - 1, day, hour);
const AS_OF = '2026-08-29';
const AS_OF_MS = Date.UTC(2026, 7, 29);

const deposit = (eventId: string, accountId: string, amount: number, when = at(1, 2)) =>
  envelope(eventId, when, accountId, { eventType: 'cash.deposit', amount, currency: 'USD' });
const buy = (
  eventId: string,
  accountId: string,
  instrumentId: string,
  quantity: number,
  pricePerUnit: number,
  when: number,
) =>
  envelope(eventId, when, accountId, {
    eventType: 'trade.fill',
    instrumentId,
    side: 'buy',
    quantity,
    pricePerUnit,
    currency: 'USD',
  });

/**
 * The DRIFTED book (the accepted example's 0.66 / 0.26 / 0.08): deposit 89_000; 300 SPY @90
 * (27_000) + 250 SPY @112 (28_000); 260 AGG @100 (26_000); cash 8_000. Marked SPY 120, AGG 100:
 * SPY 66_000, AGG 26_000, cash 8_000 → NAV 100_000. Lots: lot-1 SPY 300@90, lot-2 SPY 250@112,
 * lot-3 AGG 260@100.
 */
const DRIFTED_EVENTS = [
  deposit('dep-1', 'main', 89_000),
  buy('fill-1', 'main', 'SPY', 300, 90, at(1, 5)),
  buy('fill-2', 'main', 'SPY', 250, 112, at(1, 6)),
  buy('fill-3', 'main', 'AGG', 260, 100, at(1, 7)),
];
const ledgerOf = (events: PortfolioEventEnvelope[], lotRelief?: LotReliefPolicy) =>
  createPortfolioLedger({
    portfolioId: 'p1',
    baseCurrency: 'USD',
    ...(lotRelief === undefined ? {} : { lotRelief }),
    events,
  });
const DRIFTED = ledgerOf(DRIFTED_EVENTS);
const MARKET = createMarketSnapshot({
  asOf: AS_OF,
  observations: {
    spots: { SPY: { price: 120, currency: 'USD' }, AGG: { price: 100, currency: 'USD' } },
  },
});

/** The BALANCED book: deposit 100_000; 600 SPY @100; 300 AGG @100; cash 10_000; marked flat → 0.6/0.3/0.1. */
const BALANCED = ledgerOf([
  deposit('dep-1', 'main', 100_000),
  buy('fill-1', 'main', 'SPY', 600, 100, at(1, 5)),
  buy('fill-2', 'main', 'AGG', 300, 100, at(1, 6)),
]);
/** The INSIDE-BAND book: deposit 100_000; 610 SPY @100; 300 AGG @100; cash 9_000 → 0.61/0.30/0.09. */
const INSIDE_BAND = ledgerOf([
  deposit('dep-1', 'main', 100_000),
  buy('fill-1', 'main', 'SPY', 610, 100, at(1, 5)),
  buy('fill-2', 'main', 'AGG', 300, 100, at(1, 6)),
]);
const FLAT_MARKET = createMarketSnapshot({
  asOf: AS_OF,
  observations: {
    spots: {
      SPY: { price: 100, currency: 'USD' },
      AGG: { price: 100, currency: 'USD' },
      XYZ: { price: 100, currency: 'USD' },
    },
  },
});

const POLICY: InvestmentPolicy = {
  targets: [
    { group: { tag: 'equity' }, weight: 0.6 },
    { group: { tag: 'fixed-income' }, weight: 0.3 },
    { group: { assetClass: 'cash' }, weight: 0.1 },
  ],
  driftBand: 0.03,
  maximumTurnover: 0.15,
  minimumCash: 5_000,
};
const CLASSIFICATION = { SPY: { tags: ['equity'] }, AGG: { tags: ['fixed-income'] } };

function propose(
  overrides: Partial<ProposePortfolioRebalanceInput> = {},
): ReturnType<typeof proposePortfolioRebalance> {
  return proposePortfolioRebalance({
    portfolio: DRIFTED.state,
    market: MARKET,
    asOf: AS_OF,
    scope: 'drift-only',
    policy: POLICY,
    instrumentClassification: CLASSIFICATION,
    defaultLotSize: 1,
    ...overrides,
  });
}

describe('proposePortfolioRebalance — the accepted drift example', () => {
  const proposal = propose();

  it('trades equity → fixed-income in drift-only: sell 50 SPY, buy 40 AGG, cash to 10,000', () => {
    // SPY target 60_000 ÷ 120 = 500 vs 550 held → sell 50 (6_000); AGG 30_000 ÷ 100 = 300 vs 260 → buy 40 (4_000).
    expect(proposal.asOf).toBe(AS_OF_MS);
    expect(proposal.netAssetValue).toBeCloseTo(100_000, 9);
    expect(proposal.netAssetValueAfterFlow).toBeCloseTo(100_000, 9);
    expect(proposal.trades).toHaveLength(2);
    const [agg, spy] = proposal.trades;
    expect(agg).toMatchObject({
      accountId: 'main',
      instrumentId: 'AGG',
      side: 'buy',
      quantity: 40,
      markPricePerUnit: 100,
      currency: 'USD',
      estimatedNotional: 4_000,
      reason: 'drift',
      lotSelection: null,
    });
    expect(agg!.lotSelectionReason).toContain('opens or extends');
    expect(spy).toMatchObject({
      accountId: 'main',
      instrumentId: 'SPY',
      side: 'sell',
      quantity: 50,
      markPricePerUnit: 120,
      estimatedNotional: 6_000,
      reason: 'drift',
      lotSelectionReason: null,
    });
    // fifo: lot-1 (300 @90) first → 50 relieved → realized (120 − 90) × 50 = 1_500.
    expect(spy!.lotSelection).toEqual({
      policy: 'fifo',
      lots: [{ lotId: 'lot-1', quantity: 50, costBasisPerUnit: 90, estimatedRealizedPnl: 1_500 }],
      estimatedRealizedPnl: 1_500,
    });
    expect(proposal.cash).toEqual({
      available: 8_000,
      raised: 6_000,
      used: 4_000,
      remainingReserve: 10_000,
      minimumReserve: 5_000,
    });
    expect(proposal.estimates).toEqual({
      commission: 0,
      spread: 0,
      slippage: 0,
      totalCost: 0,
      turnover: 0.1,
    });
    expect(proposal.feasible).toBe(true);
    expect(proposal.convergence).toEqual({ converged: true, iterations: 1 });
    expect(proposal.unresolvedTargets).toEqual([]);
    expect(proposal.unresolvedConstraints).toEqual([]);
    expect(proposal.dust).toEqual({ skipped: [], aggregateNotional: 0 });
  });

  it('reports current / target / post-trade weights per instrument, group, and cash with the band verdicts', () => {
    expect(proposal.weights.instruments).toEqual([
      {
        instrumentId: 'AGG',
        current: 0.26,
        target: 0.3,
        postTrade: 0.3,
        driftBand: 0.03,
        outsideBand: true,
        sourceGroups: ['tag:fixed-income'],
      },
      {
        instrumentId: 'SPY',
        current: 0.66,
        target: 0.6,
        postTrade: 0.6,
        driftBand: 0.03,
        outsideBand: true,
        sourceGroups: ['tag:equity'],
      },
    ]);
    expect(proposal.weights.groups).toEqual([
      {
        key: 'tag:equity',
        current: 0.66,
        target: 0.6,
        postTrade: 0.6,
        driftBand: 0.03,
        outsideBand: true,
      },
      {
        key: 'tag:fixed-income',
        current: 0.26,
        target: 0.3,
        postTrade: 0.3,
        driftBand: 0.03,
        outsideBand: true,
      },
    ]);
    expect(proposal.weights.cash).toEqual({ current: 0.08, target: 0.1, postTrade: 0.1 });
  });

  it('states the objective and the risk/concentration before and after', () => {
    // driftDistance before = (0.06 + 0.04 + 0.02) ÷ 2 = 0.06; after 0. No benchmark → tracking null.
    expect(proposal.objective.before.driftDistance).toBeCloseTo(0.06, 12);
    expect(proposal.objective.after.driftDistance).toBeCloseTo(0, 12);
    expect(proposal.objective.before.trackingDistance).toBeNull();
    expect(proposal.diagnostics.warnings).toContain(
      'trackingDistance is null: the policy declares no benchmark.',
    );
    // Before: weights 0.66 / 0.26 → max 0.66; HHI 0.4356 + 0.0676 = 0.5032; top3 0.92; gross 0.92.
    expect(proposal.risk.before.maximumPositionWeight).toBeCloseTo(0.66, 12);
    expect(proposal.risk.before.herfindahlIndex).toBeCloseTo(0.5032, 12);
    expect(proposal.risk.before.topThreeWeight).toBeCloseTo(0.92, 12);
    expect(proposal.risk.before.grossLeverage).toBeCloseTo(0.92, 12);
    expect(proposal.risk.before.cashWeight).toBeCloseTo(0.08, 12);
    // After: 0.6 / 0.3 → HHI 0.36 + 0.09 = 0.45; gross 0.9; cash 0.1.
    expect(proposal.risk.after.maximumPositionWeight).toBeCloseTo(0.6, 12);
    expect(proposal.risk.after.herfindahlIndex).toBeCloseTo(0.45, 12);
    expect(proposal.risk.after.topThreeWeight).toBeCloseTo(0.9, 12);
    expect(proposal.risk.after.grossLeverage).toBeCloseTo(0.9, 12);
    expect(proposal.risk.after.cashWeight).toBeCloseTo(0.1, 12);
  });

  it('carries a normalized, content-addressed TradePlanArtifact with no execution capability', () => {
    const plan = proposal.plan;
    expect(plan.kind).toBe('totalfinance.trade-plan');
    expect(plan.schemaVersion).toBe(1);
    expect(plan.asOf).toBe(AS_OF_MS);
    expect(plan.baseCurrency).toBe('USD');
    expect(plan.portfolioId).toBe('p1');
    expect(plan.trades).toEqual([
      {
        accountId: 'main',
        instrumentId: 'AGG',
        side: 'buy',
        quantity: 40,
        currency: 'USD',
        referencePricePerUnit: 100,
        contractMultiplier: 1,
        estimatedNotional: 4_000,
      },
      {
        accountId: 'main',
        instrumentId: 'SPY',
        side: 'sell',
        quantity: 50,
        currency: 'USD',
        referencePricePerUnit: 120,
        contractMultiplier: 1,
        estimatedNotional: 6_000,
      },
    ]);
    const { contentHash: hash, ...body } = plan;
    expect(hash).toBe(contentHash(body));
    expect(plan.policyContentHash).toBe(
      contentHash(requireInvestmentPolicy('test', 'policy', POLICY)),
    );
    expect(Object.keys(plan).sort()).toEqual([
      'asOf',
      'baseCurrency',
      'contentHash',
      'kind',
      'policyContentHash',
      'portfolioId',
      'schemaVersion',
      'trades',
    ]);
    for (const value of Object.values(plan)) expect(typeof value).not.toBe('function');
  });

  it('echoes the conventions: lot relief, target source, scope, flow handling, rounding, cost model', () => {
    expect(proposal.assumptions.lotRelief).toBe('fifo');
    expect(proposal.assumptions.targetSource).toBe('inline');
    expect(proposal.assumptions.scope).toBe('drift-only');
    expect(proposal.assumptions.flowHandling).toBe(
      'No external flow: the plan is funded from settled cash and sells.',
    );
    expect(proposal.assumptions.liquidityParticipationRate).toBe(0.1);
    expect(proposal.assumptions.rounding).toContain('TOWARD ZERO');
    expect(proposal.assumptions.costModel).toContain(
      'commissionPerTrade applies per proposed trade row',
    );
    expect(proposal.diagnostics).toMatchObject({
      accountsConsidered: ['main'],
      accountsExcluded: [],
      tradeCount: 2,
      dustCount: 0,
    });
  });
});

describe('scope', () => {
  it('proposes NOTHING for a book inside every band (0.61 / 0.30 / 0.09) in drift-only', () => {
    const proposal = propose({ portfolio: INSIDE_BAND.state, market: FLAT_MARKET });
    expect(proposal.trades).toEqual([]);
    expect(proposal.plan.trades).toEqual([]);
    expect(proposal.weights.instruments.map((w) => w.outsideBand)).toEqual([false, false]);
    // (0.01 + 0 + 0.01) ÷ 2
    expect(proposal.objective.before.driftDistance).toBeCloseTo(0.01, 12);
    expect(proposal.feasible).toBe(true);
    expect(proposal.estimates.turnover).toBe(0);
  });

  it('moves the same book to target in to-target: sell 10 SPY', () => {
    const proposal = propose({
      portfolio: INSIDE_BAND.state,
      market: FLAT_MARKET,
      scope: 'to-target',
    });
    // SPY 60_000 ÷ 100 = 600 vs 610 → sell 10 (1_000); AGG at target.
    expect(proposal.trades).toHaveLength(1);
    expect(proposal.trades[0]).toMatchObject({
      instrumentId: 'SPY',
      side: 'sell',
      quantity: 10,
      reason: 'to-target',
    });
    expect(proposal.cash.remainingReserve).toBeCloseTo(10_000, 9);
    expect(proposal.estimates.turnover).toBeCloseTo(0.01, 12);
    expect(proposal.objective.after.driftDistance).toBeCloseTo(0, 12);
  });
});

describe('constraints — capped or violated, never silently relaxed', () => {
  it('scales every trade to the turnover cap and records the unmet goal', () => {
    const proposal = propose({ policy: { ...POLICY, maximumTurnover: 0.05 } });
    // Required 10_000 ÷ 100_000 = 0.10 → factor 0.5: sell 25 SPY (3_000), buy 20 AGG (2_000).
    expect(proposal.trades.map((t) => [t.instrumentId, t.side, t.quantity])).toEqual([
      ['AGG', 'buy', 20],
      ['SPY', 'sell', 25],
    ]);
    expect(proposal.estimates.turnover).toBeCloseTo(0.05, 12);
    expect(proposal.unresolvedConstraints).toHaveLength(1);
    const row = proposal.unresolvedConstraints[0]!;
    expect(row).toMatchObject({
      constraint: 'maximumTurnover',
      status: 'capped',
      value: 0.1,
      limit: 0.05,
    });
    expect(row.reason).toContain('targets need 0.1 turnover; capped at 0.05');
    expect(row.reason).toContain('residual drift');
    // Post: SPY 525 × 120 = 63_000 (0.63); AGG 280 × 100 = 28_000 (0.28); cash 9_000 (0.09).
    expect(proposal.weights.instruments.map((w) => w.postTrade)).toEqual([0.28, 0.63]);
    expect(proposal.weights.cash.postTrade).toBeCloseTo(0.09, 12);
    // (0.03 + 0.02 + 0.01) ÷ 2
    expect(proposal.objective.after.driftDistance).toBeCloseTo(0.03, 12);
    expect(proposal.convergence).toEqual({ converged: true, iterations: 2 });
    expect(proposal.feasible).toBe(true);
  });

  it('scales buys down to the cash floor and records the binding minimumCash', () => {
    const proposal = propose({ policy: { ...POLICY, minimumCash: 12_000 } });
    // available = 8_000 + 6_000 sells − 12_000 = 2_000 < 4_000 buys → factor 0.5 → buy 20 AGG.
    expect(proposal.trades.map((t) => [t.instrumentId, t.side, t.quantity])).toEqual([
      ['AGG', 'buy', 20],
      ['SPY', 'sell', 50],
    ]);
    expect(proposal.cash.remainingReserve).toBeCloseTo(12_000, 9);
    expect(proposal.cash.minimumReserve).toBe(12_000);
    expect(proposal.unresolvedConstraints).toHaveLength(1);
    expect(proposal.unresolvedConstraints[0]).toMatchObject({
      constraint: 'minimumCash',
      status: 'capped',
      value: 12_000,
      limit: 12_000,
    });
    expect(proposal.convergence).toEqual({ converged: true, iterations: 2 });
    expect(proposal.feasible).toBe(true);
    // minimumCashWeight is the alternative spelling; the larger binds.
    const byWeight = propose({
      policy: { ...POLICY, minimumCash: 1_000, minimumCashWeight: 0.12 },
    });
    expect(byWeight.cash.minimumReserve).toBeCloseTo(12_000, 9);
    expect(byWeight.trades.map((t) => t.quantity)).toEqual([20, 50]);
  });

  it('reports a post-trade hard limit the targets would break with feasible: false and the trades still listed', () => {
    const position = propose({ policy: { ...POLICY, limits: { maximumPositionWeight: 0.5 } } });
    expect(position.trades).toHaveLength(2);
    expect(position.unresolvedConstraints).toEqual([
      {
        constraint: 'maximumPositionWeight',
        status: 'violated',
        reason: expect.stringContaining("'SPY' would be 0.6 of NAV after the trades, above"),
        value: 0.6,
        limit: 0.5,
      },
    ]);
    expect(position.feasible).toBe(false);
    const group = propose({
      policy: {
        ...POLICY,
        limits: { maximumGroupWeights: [{ group: { tag: 'equity' }, maximumWeight: 0.5 }] },
      },
    });
    expect(group.unresolvedConstraints[0]).toMatchObject({
      constraint: 'maximumGroupWeights:tag:equity',
      status: 'violated',
      value: 0.6,
      limit: 0.5,
    });
    expect(group.feasible).toBe(false);
    const leverage = propose({ policy: { ...POLICY, limits: { maximumGrossLeverage: 0.85 } } });
    expect(leverage.unresolvedConstraints[0]).toMatchObject({
      constraint: 'maximumGrossLeverage',
      status: 'violated',
      value: expect.closeTo(0.9, 12) as number,
      limit: 0.85,
    });
    expect(leverage.feasible).toBe(false);
    const settled = propose({ policy: { ...POLICY, limits: { minimumSettledCash: 11_000 } } });
    expect(settled.unresolvedConstraints[0]).toMatchObject({
      constraint: 'minimumSettledCash',
      status: 'violated',
      value: 10_000,
      limit: 11_000,
    });
    const cost = propose({
      policy: { ...POLICY, maximumEstimatedTransactionCost: 5 },
      transactionCosts: { commissionPerTrade: 3 },
    });
    // Two trade rows × 3 = 6 > 5.
    expect(cost.estimates.commission).toBe(6);
    expect(cost.unresolvedConstraints[0]).toMatchObject({
      constraint: 'maximumEstimatedTransactionCost',
      status: 'violated',
      value: 6,
      limit: 5,
    });
  });

  it('evaluates days-to-liquidate at 10% participation and marks a missing volume unverifiable', () => {
    const proposal = propose({
      policy: { ...POLICY, limits: { maximumDaysToLiquidate: 2 } },
      averageDailyVolumes: { SPY: 1_000 },
    });
    // SPY post-trade 500 ÷ (1_000 × 0.1) = 5 days > 2; AGG has no volume row.
    expect(proposal.unresolvedConstraints).toHaveLength(2);
    expect(proposal.unresolvedConstraints[0]).toMatchObject({
      constraint: 'maximumDaysToLiquidate',
      status: 'violated',
      value: 5,
      limit: 2,
    });
    expect(proposal.unresolvedConstraints[1]).toMatchObject({
      constraint: 'maximumDaysToLiquidate',
      status: 'unverifiable',
      value: null,
      limit: 2,
    });
    expect(proposal.unresolvedConstraints[1]!.reason).toContain('AGG');
    expect(proposal.feasible).toBe(false);
  });
});

describe('contributions and withdrawals', () => {
  const investing: InvestmentPolicy = { ...POLICY, contributionHandling: 'invest-to-targets' };

  it('invests a contribution into underweights first — no sell, lower turnover than rebalancing without it', () => {
    const proposal = propose({
      scope: 'to-target',
      policy: investing,
      externalFlow: { amount: 10_000, currency: 'USD' },
    });
    // NAV′ 110_000: SPY 66_000 ÷ 120 = 550 = held → no trade; AGG 33_000 ÷ 100 = 330 → buy 70 (7_000).
    expect(proposal.netAssetValueAfterFlow).toBeCloseTo(110_000, 9);
    expect(proposal.trades).toHaveLength(1);
    expect(proposal.trades[0]).toMatchObject({
      instrumentId: 'AGG',
      side: 'buy',
      quantity: 70,
      reason: 'contribution',
    });
    // Cash: 8_000 + 10_000 − 7_000 = 11_000 = 0.1 of 110_000.
    expect(proposal.cash).toEqual({
      available: 18_000,
      raised: 0,
      used: 7_000,
      remainingReserve: 11_000,
      minimumReserve: 5_000,
    });
    expect(proposal.weights.cash.postTrade).toBeCloseTo(0.1, 12);
    expect(proposal.weights.instruments.map((w) => w.postTrade)).toEqual([0.3, 0.6]);
    expect(proposal.objective.after.driftDistance).toBeCloseTo(0, 12);
    // 7_000 ÷ 110_000 = 0.0636… < 0.10 without the contribution.
    expect(proposal.estimates.turnover).toBeCloseTo(7_000 / 110_000, 12);
    expect(propose({ scope: 'to-target' }).estimates.turnover).toBeCloseTo(0.1, 12);
    expect(proposal.assumptions.flowHandling).toContain('invest-to-targets');
    expect(proposal.feasible).toBe(true);
  });

  it('in drift-only, the contribution buys are capped at the contribution and the remainder stays in cash', () => {
    const proposal = propose({
      policy: investing,
      externalFlow: { amount: 10_000, currency: 'USD' },
    });
    expect(proposal.trades.map((t) => [t.instrumentId, t.side, t.quantity, t.reason])).toEqual([
      ['AGG', 'buy', 70, 'contribution'],
    ]);
    expect(proposal.diagnostics.warnings.join('\n')).toContain(
      'the contribution exceeds the underweight buys by 3000',
    );
    // A contribution too small for the whole buy is trimmed to the lot: NAV′ 102_550 → AGG target
    // 30_765 ÷ 100 = 307 → buy 47 (4_700) > 2_550 → trimmed to 2_550 ÷ 100 = 25. SPY is still
    // outside its band: 61_530 ÷ 120 = 512.75 → 512 → its drift sell of 38 (4_560) runs too.
    const small = propose({
      policy: investing,
      externalFlow: { amount: 2_550, currency: 'USD' },
    });
    expect(small.trades.map((t) => [t.instrumentId, t.quantity, t.reason])).toEqual([
      ['AGG', 25, 'contribution'],
      ['SPY', 38, 'drift'],
    ]);
    // Cash 8_000 + 2_550 − 2_500 + 4_560 = 12_610; the 50 the lot rounding left unspent is said.
    expect(small.cash.remainingReserve).toBeCloseTo(12_610, 9);
    expect(small.diagnostics.warnings.join('\n')).toContain(
      'the contribution exceeds the underweight buys by 50 USD',
    );
  });

  it('holds a contribution as cash: no trades, the flow lands in cash', () => {
    const proposal = propose({
      portfolio: BALANCED.state,
      market: FLAT_MARKET,
      policy: { ...POLICY, contributionHandling: 'hold-as-cash' },
      externalFlow: { amount: 10_000, currency: 'USD' },
    });
    expect(proposal.trades).toEqual([]);
    expect(proposal.netAssetValueAfterFlow).toBeCloseTo(110_000, 9);
    // Cash 20_000 ÷ 110_000; SPY 60_000 ÷ 110_000.
    expect(proposal.weights.cash.postTrade).toBeCloseTo(20_000 / 110_000, 12);
    expect(
      proposal.weights.instruments.find((w) => w.instrumentId === 'SPY')!.postTrade,
    ).toBeCloseTo(60_000 / 110_000, 12);
    expect(proposal.assumptions.flowHandling).toContain('held as cash');
    expect(proposal.feasible).toBe(true);
  });

  it('raises a withdrawal from settled cash above the floor first, then from the most overweight holding', () => {
    const proposal = propose({
      portfolio: BALANCED.state,
      market: FLAT_MARKET,
      policy: { ...POLICY, withdrawalHandling: 'raise-from-overweights' },
      externalFlow: { amount: -10_000, currency: 'USD' },
    });
    // NAV′ 90_000; nothing outside its band; to raise = 10_000 + floor 5_000 − settled 10_000 = 5_000.
    // On the post-flow basis SPY (60_000 ÷ 90_000 = 0.667 vs 0.6) is the most overweight: its
    // to-target sell of 60 (6_000) is trimmed to 5_000 ÷ 100 = 50.
    expect(proposal.netAssetValueAfterFlow).toBeCloseTo(90_000, 9);
    expect(proposal.trades.map((t) => [t.instrumentId, t.side, t.quantity, t.reason])).toEqual([
      ['SPY', 'sell', 50, 'withdrawal'],
    ]);
    expect(proposal.cash).toEqual({
      available: 0,
      raised: 5_000,
      used: 0,
      remainingReserve: 5_000,
      minimumReserve: 5_000,
    });
    expect(proposal.feasible).toBe(true);
    expect(proposal.unresolvedConstraints).toEqual([]);
  });

  it('raises a withdrawal pro-rata across every holding', () => {
    const proposal = propose({
      portfolio: BALANCED.state,
      market: FLAT_MARKET,
      policy: { ...POLICY, minimumCash: 6_000, withdrawalHandling: 'pro-rata' },
      externalFlow: { amount: -10_000, currency: 'USD' },
    });
    // To raise = 10_000 + 6_000 − 10_000 = 6_000 over SPY 60_000 : AGG 30_000 → 4_000 (40) : 2_000 (20).
    expect(proposal.trades.map((t) => [t.instrumentId, t.side, t.quantity, t.reason])).toEqual([
      ['AGG', 'sell', 20, 'withdrawal'],
      ['SPY', 'sell', 40, 'withdrawal'],
    ]);
    expect(proposal.cash.remainingReserve).toBeCloseTo(6_000, 9);
    expect(proposal.trades[0]!.lotSelection).toEqual({
      policy: 'fifo',
      lots: [{ lotId: 'lot-2', quantity: 20, costBasisPerUnit: 100, estimatedRealizedPnl: 0 }],
      estimatedRealizedPnl: 0,
    });
    expect(proposal.feasible).toBe(true);
  });

  it('labels the sells that raise a withdrawal in to-target scope', () => {
    const proposal = propose({
      scope: 'to-target',
      policy: { ...POLICY, withdrawalHandling: 'raise-from-overweights' },
      externalFlow: { amount: -5_000, currency: 'USD' },
    });
    // NAV′ 95_000: SPY 57_000 ÷ 120 = 475 → sell 75 (9_000); AGG 28_500 ÷ 100 = 285 → buy 25.
    expect(proposal.trades.map((t) => [t.instrumentId, t.side, t.quantity, t.reason])).toEqual([
      ['AGG', 'buy', 25, 'to-target'],
      ['SPY', 'sell', 75, 'withdrawal'],
    ]);
    // Cash 8_000 − 5_000 + 9_000 − 2_500 = 9_500 = 0.1 of 95_000.
    expect(proposal.cash.remainingReserve).toBeCloseTo(9_500, 9);
    expect(proposal.weights.cash.postTrade).toBeCloseTo(0.1, 12);
  });

  it('refuses a flow the policy declares no handling for, a foreign-currency flow, and a withdrawal beyond the NAV', () => {
    expectCode(
      () => propose({ externalFlow: { amount: 10_000, currency: 'USD' } }),
      'input.missing_field',
      'policy declares no contributionHandling',
    );
    expectCode(
      () => propose({ externalFlow: { amount: -10_000, currency: 'USD' } }),
      'input.missing_field',
      'policy declares no withdrawalHandling',
    );
    expectCode(
      () => propose({ policy: investing, externalFlow: { amount: 10_000, currency: 'EUR' } }),
      'input.out_of_range',
      'base currency only',
    );
    expectCode(
      () => propose({ policy: investing, externalFlow: { amount: 0, currency: 'USD' } }),
      'input.out_of_range',
      'externalFlow.amount must be non-zero',
    );
    expectCode(
      () =>
        propose({
          policy: { ...POLICY, withdrawalHandling: 'pro-rata' },
          externalFlow: { amount: -200_000, currency: 'USD' },
        }),
      'input.out_of_range',
      'exceeds the managed net asset value',
    );
    expectCode(
      () => propose({ externalFlow: { amount: 1, currency: 'USD', memo: 'x' } as never }),
      'input.unknown_field',
      'externalFlow',
    );
  });
});

describe('restricted instruments, dust, and benchmarks', () => {
  it('sells a restricted holding to zero and excludes it from its group', () => {
    const ledger = ledgerOf([
      deposit('dep-1', 'main', 100_000),
      buy('fill-1', 'main', 'SPY', 600, 100, at(1, 5)),
      buy('fill-2', 'main', 'AGG', 300, 100, at(1, 6)),
      buy('fill-3', 'main', 'XYZ', 50, 100, at(1, 7)),
    ]);
    const proposal = propose({
      portfolio: ledger.state,
      market: FLAT_MARKET,
      policy: { ...POLICY, restrictedInstruments: ['XYZ'] },
      instrumentClassification: { ...CLASSIFICATION, XYZ: { tags: ['equity'] } },
    });
    // XYZ 5_000 ÷ 100_000 = 0.05 vs target 0 (band 0.03) → outside → sell 50; SPY keeps the whole 0.6.
    expect(proposal.trades.map((t) => [t.instrumentId, t.side, t.quantity, t.reason])).toEqual([
      ['XYZ', 'sell', 50, 'drift'],
    ]);
    expect(proposal.weights.instruments.find((w) => w.instrumentId === 'XYZ')).toEqual({
      instrumentId: 'XYZ',
      current: 0.05,
      target: 0,
      postTrade: 0,
      driftBand: 0.03,
      outsideBand: true,
      sourceGroups: ['policy:restrictedInstruments'],
    });
    expect(proposal.weights.groups.find((g) => g.key === 'tag:equity')!.current).toBeCloseTo(
      0.6,
      12,
    );
    expect(proposal.diagnostics.warnings.join('\n')).toContain(
      "'XYZ' is in policy.restrictedInstruments",
    );
    expect(proposal.cash.remainingReserve).toBeCloseTo(10_000, 9);
    expect(proposal.feasible).toBe(true);
  });

  it('reports a held instrument outside allowedInstruments as unresolved and never trades it', () => {
    const proposal = propose({ policy: { ...POLICY, allowedInstruments: ['SPY'] } });
    expect(proposal.unresolvedTargets.map((u) => u.key)).toEqual([
      'instrumentId:AGG',
      'tag:fixed-income',
    ]);
    expect(proposal.unresolvedTargets[0]!.reason).toContain('not in policy.allowedInstruments');
    expect(proposal.trades.map((t) => t.instrumentId)).toEqual(['SPY']);
    expect(proposal.weights.instruments.find((w) => w.instrumentId === 'AGG')!.target).toBeNull();
    expect(proposal.feasible).toBe(false);
  });

  it('skips dust below minimumNotional and reports its aggregate cash effect', () => {
    const proposal = propose({ minimumNotional: 5_000 });
    // The 4_000 AGG buy is dust; the 6_000 SPY sell runs; cash 8_000 + 6_000 = 14_000.
    expect(proposal.trades.map((t) => [t.instrumentId, t.quantity])).toEqual([['SPY', 50]]);
    expect(proposal.dust.skipped).toHaveLength(1);
    expect(proposal.dust.skipped[0]).toMatchObject({ instrumentId: 'AGG', tradeNotional: 4_000 });
    expect(proposal.dust.aggregateNotional).toBe(4_000);
    expect(proposal.cash.remainingReserve).toBeCloseTo(14_000, 9);
    // (0 + 0.04 + 0.04) ÷ 2
    expect(proposal.objective.after.driftDistance).toBeCloseTo(0.04, 12);
    expect(proposal.diagnostics.dustCount).toBe(1);
    expect(proposal.feasible).toBe(true);
  });

  it('measures the active share against the benchmark constituents before and after', () => {
    const proposal = propose({
      policy: {
        ...POLICY,
        benchmark: {
          benchmarkId: 'blend',
          constituents: [
            { instrumentId: 'SPY', weight: 0.6 },
            { instrumentId: 'AGG', weight: 0.4 },
          ],
        },
      },
    });
    // Before: (|0.66 − 0.6| + |0.26 − 0.4| + 0.08 cash) ÷ 2 = 0.14; after: (0 + 0.1 + 0.1) ÷ 2 = 0.1.
    expect(proposal.objective.before.trackingDistance).toBeCloseTo(0.14, 12);
    expect(proposal.objective.after.trackingDistance).toBeCloseTo(0.1, 12);
  });
});

describe('lot selection — the preview IS what the fold would relieve', () => {
  it('reports null with the reason under specific-lot relief', () => {
    const proposal = propose({ portfolio: ledgerOf(DRIFTED_EVENTS, 'specific-lot').state });
    const spy = proposal.trades.find((t) => t.instrumentId === 'SPY')!;
    expect(spy.lotSelection).toBeNull();
    expect(spy.lotSelectionReason).toContain('specific-lot relief needs caller lot selections');
    expect(proposal.assumptions.lotRelief).toBe('specific-lot');
  });

  it.each([
    // fifo relieves lot-1 (300 @90): (120 − 90) × 50 = 1_500; highest-cost and lifo relieve lot-2 (250 @112): (120 − 112) × 50 = 400.
    ['fifo' as const, 'lot-1', 90, 1_500, 250],
    ['highest-cost' as const, 'lot-2', 112, 400, 200],
    ['lifo' as const, 'lot-2', 112, 400, 200],
  ])(
    'matches applyPortfolioEvents under %s: same lot, same realized P&L',
    (lotRelief, lotId, basis, realized, remainingInLot) => {
      const ledger = ledgerOf(DRIFTED_EVENTS, lotRelief);
      const proposal = propose({ portfolio: ledger.state });
      const spy = proposal.trades.find((t) => t.instrumentId === 'SPY')!;
      expect(spy.lotSelection).toEqual({
        policy: lotRelief,
        lots: [{ lotId, quantity: 50, costBasisPerUnit: basis, estimatedRealizedPnl: realized }],
        estimatedRealizedPnl: realized,
      });
      // Apply the proposed sell as a fill at the mark and compare with the fold's own relief.
      const fill = envelope('sell-1', at(8, 29, 16), 'main', {
        eventType: 'trade.fill',
        instrumentId: 'SPY',
        side: 'sell',
        quantity: spy.quantity,
        pricePerUnit: spy.markPricePerUnit,
        currency: 'USD',
      });
      const applied = ledger.apply([fill]).state;
      const main = applied.accounts['main']!;
      expect(main.realizedPnl['USD']).toBeCloseTo(realized, 9);
      expect(main.realizedPnlByInstrument['SPY']!['USD']).toBeCloseTo(realized, 9);
      const effect = applied.fillEffects[duplicateBoundaryKey(fill)]!;
      expect(effect.relievedQuantity).toBe(50);
      expect(effect.realizedPnl).toBeCloseTo(realized, 9);
      const relieved = main.positions['SPY']!.lots.find((lot) => lot.lotId === lotId)!;
      expect(relieved.quantity).toBe(remainingInLot);
      const untouched = main.positions['SPY']!.lots.find((lot) => lot.lotId !== lotId)!;
      expect(untouched.quantity).toBe(lotId === 'lot-1' ? 250 : 300);
      expect(main.positions['SPY']!.quantity).toBe(500);
    },
  );

  it('previews relief across two lots when the sell spans them', () => {
    // Sell 320 SPY under fifo: lot-1 (300 @90) fully → 9_000; then 20 of lot-2 (@112) → 160.
    const proposal = propose({
      scope: 'to-target',
      policy: {
        targets: [
          { group: { instrumentId: 'SPY' }, weight: 0.276 },
          { group: { instrumentId: 'AGG' }, weight: 0.26 },
          { group: { assetClass: 'cash' }, weight: 0.464 },
        ],
      },
    });
    // SPY 27_600 ÷ 120 = 230 → sell 320.
    const spy = proposal.trades.find((t) => t.instrumentId === 'SPY')!;
    expect(spy.quantity).toBe(320);
    expect(spy.lotSelection).toEqual({
      policy: 'fifo',
      lots: [
        { lotId: 'lot-1', quantity: 300, costBasisPerUnit: 90, estimatedRealizedPnl: 9_000 },
        { lotId: 'lot-2', quantity: 20, costBasisPerUnit: 112, estimatedRealizedPnl: 160 },
      ],
      estimatedRealizedPnl: 9_160,
    });
  });
});

describe('accounts', () => {
  /** Two accounts: taxable holds SPY (300 @90 + 250 @112) + 8_000 cash; ira holds 260 AGG @100 — the DRIFTED book split. */
  const SPLIT = ledgerOf([
    deposit('dep-1', 'taxable', 63_000),
    deposit('dep-2', 'ira', 26_000),
    buy('fill-1', 'taxable', 'SPY', 300, 90, at(1, 5)),
    buy('fill-2', 'taxable', 'SPY', 250, 112, at(1, 6)),
    buy('fill-3', 'ira', 'AGG', 260, 100, at(1, 7)),
  ]);

  it('requires a trading account for buys when the managed book spans several accounts', () => {
    expectCode(
      () => propose({ portfolio: SPLIT.state }),
      'input.missing_field',
      'tradingAccountId is required',
    );
    expectCode(
      () => propose({ portfolio: SPLIT.state, tradingAccountId: 'other' }),
      'input.out_of_range',
      "tradingAccountId 'other' is not one of the managed accounts",
    );
    expectCode(
      () => propose({ tradingAccountId: 'other' }),
      'input.out_of_range',
      "is not the managed account ('main')",
    );
  });

  it('books buys to the trading account and sells to the account holding the position', () => {
    const proposal = propose({ portfolio: SPLIT.state, tradingAccountId: 'ira' });
    expect(proposal.diagnostics.accountsConsidered).toEqual(['ira', 'taxable']);
    expect(proposal.trades.map((t) => [t.accountId, t.instrumentId, t.side, t.quantity])).toEqual([
      ['ira', 'AGG', 'buy', 40],
      ['taxable', 'SPY', 'sell', 50],
    ]);
    expect(proposal.trades[1]!.lotSelection!.lots[0]!.lotId).toBe('lot-1');
    // The buy lands in an account whose own settled cash (0) cannot fund it: said, not hidden.
    expect(proposal.diagnostics.warnings.join('\n')).toContain("buys booked to 'ira'");
    expect(proposal.plan.trades.map((t) => t.accountId)).toEqual(['ira', 'taxable']);
    expect(proposal.feasible).toBe(true);
  });

  it('excludes accounts outside policy.allowedAccounts from the managed NAV and never trades them', () => {
    const proposal = propose({
      portfolio: SPLIT.state,
      policy: { ...POLICY, allowedAccounts: ['taxable'] },
    });
    // Managed NAV = 66_000 SPY + 8_000 cash = 74_000; ira's 260 AGG is reported, not traded.
    expect(proposal.netAssetValue).toBeCloseTo(74_000, 9);
    expect(proposal.diagnostics.accountsConsidered).toEqual(['taxable']);
    expect(proposal.diagnostics.accountsExcluded).toEqual(['ira']);
    expect(proposal.diagnostics.warnings.join('\n')).toContain("260 AGG in 'ira'");
    expect(proposal.trades.every((t) => t.accountId === 'taxable')).toBe(true);
    // No managed instrument carries fixed-income → that target is unresolved, never defaulted.
    expect(proposal.unresolvedTargets.map((u) => u.key)).toEqual(['tag:fixed-income']);
    expect(proposal.feasible).toBe(false);
  });
});

describe('determinism, immutability, and closed boundaries', () => {
  it('is deterministic (deep-equal on repeat, same plan hash) and deeply frozen', () => {
    const first = propose({ transactionCosts: { commissionPerTrade: 1, spreadBasisPoints: 2 } });
    const second = propose({ transactionCosts: { commissionPerTrade: 1, spreadBasisPoints: 2 } });
    expect(second).toEqual(first);
    expect(second.plan.contentHash).toBe(first.plan.contentHash);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.trades)).toBe(true);
    expect(Object.isFrozen(first.trades[0])).toBe(true);
    expect(Object.isFrozen(first.trades[1]!.lotSelection)).toBe(true);
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(Object.isFrozen(first.weights.instruments[0])).toBe(true);
    // Different trades → a different plan hash.
    expect(
      propose({ scope: 'to-target', policy: { ...POLICY, maximumTurnover: 0.05 } }).plan
        .contentHash,
    ).not.toBe(first.plan.contentHash);
    const plan: TradePlanArtifact = first.plan;
    expect(plan.contentHash.startsWith('sha256:')).toBe(true);
  });

  it('rejects unknown keys at every level and names the missing goals', () => {
    expectCode(
      () => propose({ scopes: 'drift-only' } as never),
      'input.unknown_field',
      'did you mean "scope"',
    );
    expectCode(
      () => propose({ scope: undefined } as never),
      'input.missing_field',
      'scope is required',
    );
    expectCode(
      () => propose({ scope: 'all' } as never),
      'input.out_of_range',
      "'to-target' or 'drift-only'",
    );
    expectCode(
      () => propose({ asOf: undefined } as never),
      'input.missing_field',
      'asOf is required',
    );
    expectCode(
      () => propose({ policy: undefined } as never),
      'input.missing_field',
      'policy is required',
    );
    expectCode(
      () => propose({ policy: { driftBand: 0.03 } }),
      'input.missing_field',
      'policy declares no targets',
    );
    expectCode(
      () => propose({ policy: { ...POLICY, band: 1 } as never }),
      'input.unknown_field',
      'driftBand',
    );
    expectCode(
      () => propose({ policy: { ...POLICY, limits: { maxPositionWeight: 1 } } as never }),
      'input.unknown_field',
      'maximumPositionWeight',
    );
    expectCode(
      () => propose({ instrumentClassification: { SPY: { sector: 'tech' } } as never }),
      'input.unknown_field',
      'instrumentClassification',
    );
    expectCode(
      () => propose({ averageDailyVolumes: { SPY: 0 } }),
      'input.out_of_range',
      "averageDailyVolumes['SPY']",
    );
    expectCode(() => propose({ lotSizes: { SPY: -1 } }), 'input.out_of_range', "lotSizes['SPY']");
    expectCode(
      () => propose({ transactionCosts: { fee: 1 } as never }),
      'input.unknown_field',
      'commissionPerTrade',
    );
    expectCode(
      () => propose({ portfolio: { ...DRIFTED.state, extra: 1 } as never }),
      'input.unknown_field',
    );
    expectCode(
      () => propose({ market: { ...MARKET, kind: 'totalfinance.other' } as never }),
      'snapshot.kind_mismatch',
    );
    expectCode(
      () =>
        propose({
          policy: { ...POLICY, allowedAccounts: ['ghost'] },
        }),
      'input.out_of_range',
      'matches no account',
    );
  });

  it('refuses a mark the snapshot does not carry (never a guess)', () => {
    expectCode(
      () =>
        propose({
          market: createMarketSnapshot({
            asOf: AS_OF,
            observations: { spots: { SPY: { price: 120, currency: 'USD' } } },
          }),
        }),
      'portfolio.mark_unavailable',
      "observations.spots['AGG']",
    );
  });
});
