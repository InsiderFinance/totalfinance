/**
 * Stage 7B.2 slice 1 — the trade artifacts, normalization, the structured policy, and preflight:
 * an intent and a proposal normalize to the same grammar; free text is metadata; the plan is bound
 * by its content hash; preflight values the portfolio before and after through the ledger's own
 * fold and the monitor, never upgrades missing information, and every guard teaches.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { canonicalJsonOf, contentHash, createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  proposePortfolioRebalance,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';
import {
  decideFromChecks,
  EXECUTION_PLAN_KIND,
  type ExecutionPlan,
  mergeTradePolicies,
  normalizeTradePlan,
  referencePriceOf,
  preflightTradePlan,
  requireExecutionPlan,
  requireTradeIntent,
  requireTradeOrder,
  requireTradePolicy,
  TRADE_INTENT_KIND,
  type TradeIntent,
  type TradePolicy,
} from '@totalfinance/portfolio/trade';

const T0 = Date.UTC(2026, 0, 5, 21);
const DAY = 86_400_000;
const envelope = (
  eventId: string,
  at: number,
  event: Record<string, unknown>,
): PortfolioEventEnvelope =>
  ({
    eventId,
    schemaVersion: 1,
    eventType: event['eventType'],
    sourceId: 'fixture',
    accountId: 'main',
    effectiveTimestampMs: at,
    recordedTimestampMs: at,
    event,
    provenance: {},
  }) as unknown as PortfolioEventEnvelope;
const events = (): PortfolioEventEnvelope[] => [
  envelope('dep', T0, { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' }),
  envelope('fill', T0 + DAY, {
    eventType: 'trade.fill',
    instrumentId: 'AAA',
    side: 'buy',
    quantity: 100,
    pricePerUnit: 100,
    currency: 'USD',
  }),
];
const ledger = () =>
  createPortfolioLedger({ portfolioId: 'primary', baseCurrency: 'USD', events: events() });
const market = (asOf = T0 + 2 * DAY, aaa = 110, bbb = 50) =>
  createMarketSnapshot({
    asOf,
    observations: {
      spots: { AAA: { price: aaa, currency: 'USD' }, BBB: { price: bbb, currency: 'USD' } },
    },
  });
const intent = (overrides: Partial<TradeIntent> = {}): TradeIntent => ({
  kind: TRADE_INTENT_KIND,
  schemaVersion: 1,
  accountId: 'main',
  asOf: T0 + 2 * DAY,
  orders: [
    { instrumentId: 'BBB', side: 'buy', quantity: 200, type: 'market' },
    { instrumentId: 'AAA', side: 'sell', quantity: 20, type: 'limit', limitPrice: 112 },
  ],
  rationale: 'rotate a fifth of AAA into BBB',
  evidence: ['sha256:report'],
  ...overrides,
});
const policy = (overrides: Partial<TradePolicy> = {}): TradePolicy => ({
  mode: 'paper',
  limits: { maximumPositionWeight: 0.5, maximumGrossLeverage: 1 },
  maximumOrderNotional: 50_000,
  marketMaximumAgeMs: DAY,
  ...overrides,
});
const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('normalizeTradePlan', () => {
  it('normalizes an intent to the execution grammar, sizes a target weight at the mark, and hashes the body', () => {
    const state = ledger().state;
    const plan = normalizeTradePlan({
      intent: intent(),
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
    });
    expect(plan.kind).toBe(EXECUTION_PLAN_KIND);
    expect(plan.accountId).toBe('main');
    expect(plan.orders.map((o) => [o.instrumentId, o.side, o.quantity, o.type])).toEqual([
      ['BBB', 'buy', 200, 'market'],
      ['AAA', 'sell', 20, 'limit'],
    ]);
    expect(plan.orders[1]!.limitPrice).toBe(112);
    expect(plan.orders.every((o) => o.plannedTimestampMs === T0 + 2 * DAY)).toBe(true);
    expect(plan.trades[0]).toMatchObject({
      instrumentId: 'BBB',
      referencePricePerUnit: 50,
      estimatedNotional: 10_000,
      currency: 'USD',
    });
    expect(plan.source).toEqual({ kind: 'intent', intentHash: contentHash(intent()) });
    expect(plan.rationale).toBe('rotate a fifth of AAA into BBB');
    expect(plan.evidence).toEqual(['sha256:report']);
    const { contentHash: declared, ...body } = plan;
    expect(declared).toBe(contentHash(body));
    expect(Object.isFrozen(plan.orders)).toBe(true);
    // a target weight: 10% of NAV (90,000 cash after the fill + 100 × 110 = 101,000 → 10,100 / 50 = 202 units)
    const weighted = normalizeTradePlan({
      intent: intent({
        orders: [{ instrumentId: 'BBB', side: 'buy', notionalWeight: 0.1, type: 'market' }],
      }),
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
    });
    expect(weighted.orders[0]!.quantity).toBe(202);
    // free text is metadata: two intents that differ only in rationale normalize to the same orders and trades
    const quiet = normalizeTradePlan({
      intent: intent({ rationale: 'no reason' }),
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
    });
    expect(canonicalJsonOf(quiet.orders)).toBe(canonicalJsonOf(plan.orders));
    expect(canonicalJsonOf(quiet.trades)).toBe(canonicalJsonOf(plan.trades));
    expect(quiet.contentHash).not.toBe(plan.contentHash);
  });

  it('normalizes a rebalance proposal to the same grammar and names its source', () => {
    const state = ledger().state;
    const proposal = proposePortfolioRebalance({
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: {
        targets: [
          { group: { instrumentId: 'AAA' }, weight: 0.05 },
          { group: { assetClass: 'cash' }, weight: 0.95 },
        ],
      },
      scope: 'to-target',
    });
    expect(proposal.trades.length).toBeGreaterThan(0);
    const plan = normalizeTradePlan({
      proposal: proposal.plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
    });
    expect(plan.source).toEqual({
      kind: 'rebalance-proposal',
      planHash: proposal.plan.contentHash,
      policyContentHash: proposal.plan.policyContentHash,
    });
    expect(plan.orders[0]).toMatchObject({ instrumentId: 'AAA', side: 'sell', type: 'market' });
    expect(plan.trades[0]!.quantity).toBe(proposal.trades[0]!.quantity);
    expect(requireExecutionPlan('fixture', 'plan', plan)).toBe(plan);
  });

  it('teaches on every malformed intent, plan, and input', () => {
    const state = ledger().state;
    const base = { portfolio: state, market: market(), asOf: T0 + 2 * DAY };
    expect(failure(() => normalizeTradePlan({ ...base })).code).toBe(ErrorCode.InputMissingField);
    expect(
      failure(() => normalizeTradePlan({ ...base, intent: intent(), proposal: {} as never })).code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() => normalizeTradePlan({ ...base, intent: intent({ orders: [] }) })).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(
      failure(() =>
        normalizeTradePlan({
          ...base,
          intent: intent({
            orders: [
              {
                instrumentId: 'AAA',
                side: 'buy',
                quantity: 1,
                notionalWeight: 0.1,
                type: 'market',
              },
            ],
          }),
        }),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() =>
        normalizeTradePlan({
          ...base,
          intent: intent({
            orders: [{ instrumentId: 'AAA', side: 'buy', quantity: 1, type: 'limit' }],
          }),
        }),
      ).code,
    ).toBe(ErrorCode.InputMissingField);
    expect(
      failure(() =>
        normalizeTradePlan({
          ...base,
          intent: intent({
            orders: [{ instrumentId: 'ZZZ', side: 'buy', quantity: 1, type: 'market' }],
          }),
        }),
      ).code,
    ).toBe(ErrorCode.TradePlanInvalid);
    expect(
      failure(() =>
        normalizeTradePlan({
          ...base,
          intent: intent({
            orders: [
              { instrumentId: 'AAA', side: 'buy', quantity: 1, type: 'market' },
              { instrumentId: 'AAA', side: 'buy', quantity: 2, type: 'market' },
            ],
          }),
        }),
      ).code,
    ).toBe(ErrorCode.TradePlanInvalid);
    expect(
      failure(() =>
        normalizeTradePlan({
          ...base,
          intent: intent({
            orders: [{ instrumentId: 'ZZZ', side: 'buy', notionalWeight: 0.1, type: 'market' }],
          }),
        }),
      ).code,
    ).toBe(ErrorCode.PortfolioMarkUnavailable);
    expect(
      failure(() => normalizeTradePlan({ ...base, intent: intent(), accountId: 'other' })).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() => normalizeTradePlan({ ...base, intent: intent(), extra: 1 } as never)).code,
    ).toBe(ErrorCode.InputUnknownField);
    const plan = normalizeTradePlan({ ...base, intent: intent() });
    expect(
      failure(() =>
        requireExecutionPlan('fixture', 'plan', { ...plan, contentHash: 'sha256:edited' }),
      ).code,
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      failure(() =>
        requireExecutionPlan('fixture', 'plan', {
          ...plan,
          orders: [...plan.orders, plan.orders[0]],
        }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        requireTradeIntent('fixture', 'intent', { ...intent(), kind: 'totalfinance.trade' }),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      failure(() => requireTradeOrder('fixture', 'order', { ...plan.orders[0], stopPrice: 1 }))
        .code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        requireTradeOrder('fixture', 'order', { ...plan.orders[0], timeInForce: 'ioc' }),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
  });
});

describe('the policy', () => {
  it('refuses live, teaches on every malformed member, and merges to the stricter policy', () => {
    expect(failure(() => requireTradePolicy('fixture', 'policy', { mode: 'live' })).code).toBe(
      ErrorCode.TradeLiveUnavailable,
    );
    expect(
      failure(() =>
        requireTradePolicy('fixture', 'policy', { mode: 'paper', maximumParticipation: 2 }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        requireTradePolicy('fixture', 'policy', { mode: 'paper', allowedOrderTypes: ['ioc'] }),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      failure(() =>
        requireTradePolicy('fixture', 'policy', { mode: 'paper', onUnverifiable: 'ignore' }),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      failure(() =>
        requireTradePolicy('fixture', 'policy', { mode: 'paper', limits: { maximumDrawdown: 2 } }),
      ).code,
    ).toMatch(/^input\./);
    expect(
      failure(() => requireTradePolicy('fixture', 'policy', { mode: 'paper', extra: 1 })).code,
    ).toBe(ErrorCode.InputUnknownField);
    const merged = mergeTradePolicies({
      policies: [
        policy({
          allowedInstruments: ['AAA', 'BBB'],
          maximumOrderNotional: 50_000,
          onUnverifiable: 'require-approval',
          limits: { maximumPositionWeight: 0.5, minimumSettledCash: 1_000 },
        }),
        {
          mode: 'paper',
          allowedInstruments: ['BBB', 'CCC'],
          maximumOrderNotional: 20_000,
          onUnverifiable: 'deny',
          limits: { maximumPositionWeight: 0.3, minimumSettledCash: 5_000, maximumDrawdown: 0.1 },
          allowUndefinedRiskOptions: true,
        },
      ],
    });
    expect(merged).toEqual({
      mode: 'paper',
      limits: { maximumPositionWeight: 0.3, maximumDrawdown: 0.1, minimumSettledCash: 5_000 },
      allowedInstruments: ['BBB'],
      maximumOrderNotional: 20_000,
      marketMaximumAgeMs: DAY,
      allowUndefinedRiskOptions: false,
      onUnverifiable: 'deny',
    });
    expect(Object.isFrozen(merged)).toBe(true);
    expect(failure(() => mergeTradePolicies({ policies: [] })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
  });
});

describe('preflightTradePlan', () => {
  const setup = (overrides: Partial<TradeIntent> = {}) => {
    const state = ledger().state;
    const plan = normalizeTradePlan({
      intent: intent(overrides),
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
    });
    return { state, plan };
  };

  it('values the portfolio before and after through the ledger fold and allows a plan inside every limit', () => {
    const { state, plan } = setup();
    const report = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: policy(),
      costs: { commissionBps: 5, slippageBps: 10 },
    });
    expect(report.decision.verdict).toBe('allow');
    expect(report.planHash).toBe(plan.contentHash);
    expect(report.before.netAssetValue).toBeCloseTo(101_000, 6);
    // buys 200 BBB at 50 (+10 bps), sells 20 AAA at 112 limit (−10 bps): cash and holdings move, NAV moves by the costs only
    const after = report.after;
    expect(after.positions.find((p) => p.instrumentId === 'BBB')!.quantity).toBe(200);
    expect(after.positions.find((p) => p.instrumentId === 'AAA')!.quantity).toBe(80);
    expect(report.hypotheticalFills).toHaveLength(2);
    expect(report.hypotheticalEvents.length).toBeGreaterThanOrEqual(2);
    // the reference price is the spot (110), not the limit (112): the limit only stands in without a spot
    expect(report.estimates.tradedNotional).toBeCloseTo(10_000 + 20 * 110, 6);
    expect(report.estimates.commission).toBeCloseTo((10_000 + 2_200) * 0.0005, 9);
    expect(report.estimates.totalCost).toBeGreaterThan(report.estimates.commission);
    expect(report.checks.every((c) => c.verdict === 'pass')).toBe(true);
    expect(report.unverifiable).toEqual([]);
    expect(report.alerts).toEqual([]);
    expect(report.assumptions.costRates).toEqual({
      commissionBps: 5,
      commissionPerOrder: 0,
      spreadBps: 0,
      slippageBps: 10,
    });
    const { contentHash: declared, ...body } = report;
    expect(declared).toBe(contentHash(body));
    // the after-state is exactly the ledger's fold of the hypothetical events
    const folded = applyPortfolioEvents({
      previousState: state,
      events: report.hypotheticalEvents,
    });
    expect(folded.accounts['main']!.positions['BBB']!.quantity).toBe(200);
  });

  it('denies on a failed check, requires approval on an unverifiable one, and denies it under the stricter policy', () => {
    const { state, plan } = setup();
    const denied = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: policy({ maximumOrderNotional: 5_000 }),
    });
    expect(denied.decision.verdict).toBe('deny');
    expect(denied.checks.find((c) => c.name === 'orders[0].notional')!.verdict).toBe('fail');
    const stale = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(T0),
      asOf: T0 + 2 * DAY,
      policy: policy(),
    });
    expect(stale.checks.find((c) => c.name === 'market-age')!.verdict).toBe('fail');
    expect(stale.decision.verdict).toBe('deny');
    // participation needs volumes: without them the check is unverifiable, never an allow
    const approval = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: policy({ maximumParticipation: 0.1 }),
    });
    expect(approval.decision.verdict).toBe('require-approval');
    expect(approval.unverifiable).toEqual(['orders[0].participation', 'orders[1].participation']);
    const strict = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: policy({ maximumParticipation: 0.1, onUnverifiable: 'deny' }),
    });
    expect(strict.decision.verdict).toBe('deny');
    const verified = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: policy({ maximumParticipation: 0.1 }),
      averageDailyVolumes: { AAA: 1_000_000, BBB: 1_000_000 },
    });
    expect(verified.decision.verdict).toBe('allow');
    // above the approval threshold the decision is approval, with the scope named
    const large = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: policy({ requireApprovalAbove: { notional: 5_000 } }),
    });
    expect(large.decision).toMatchObject({
      verdict: 'require-approval',
      requiredScope: 'trade:approve',
    });
  });

  it('judges the after-state through the monitor: a concentration breach denies; cash may not go negative; a duplicate of an open order fails', () => {
    const { state, plan } = setup({
      orders: [{ instrumentId: 'BBB', side: 'buy', quantity: 1_500, type: 'market' }],
    });
    const concentrated = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: policy({ limits: { maximumPositionWeight: 0.5 } }),
    });
    expect(concentrated.decision.verdict).toBe('deny');
    expect(concentrated.alerts[0]!.family).toBe('concentration-limit');
    expect(
      concentrated.checks.some(
        (c) => c.name === 'limits.concentration-limit' && c.verdict === 'fail',
      ),
    ).toBe(true);
    const { plan: overdraft } = setup({
      orders: [{ instrumentId: 'BBB', side: 'buy', quantity: 3_000, type: 'market' }],
    });
    const broke = preflightTradePlan({
      plan: overdraft,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: { mode: 'paper' },
    });
    expect(broke.checks.find((c) => c.name === 'cash')!.verdict).toBe('fail');
    expect(broke.decision.verdict).toBe('deny');
    const duplicate = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: { mode: 'paper' },
      openOrders: [plan.orders[0]!],
    });
    expect(duplicate.checks.find((c) => c.name === 'orders[0].duplicate')!.verdict).toBe('fail');
    const halted = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: { mode: 'paper' },
      session: { open: true, halted: ['BBB'] },
    });
    expect(halted.checks.find((c) => c.name === 'orders[0].session')!.verdict).toBe('fail');
  });

  it('is deterministic and teaches on every malformed input', () => {
    const { state, plan } = setup();
    const a = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: policy(),
    });
    const b = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: T0 + 2 * DAY,
      policy: policy(),
    });
    expect(canonicalJsonOf(a)).toBe(canonicalJsonOf(b));
    expect(Object.isFrozen(a.checks)).toBe(true);
    const base = { plan, portfolio: state, market: market(), asOf: T0 + 2 * DAY, policy: policy() };
    expect(
      failure(() => preflightTradePlan({ ...base, plan: { ...plan, contentHash: 'sha256:x' } }))
        .code,
    ).toBe(ErrorCode.InputWrongShape);
    expect(
      failure(() => preflightTradePlan({ ...base, policy: { mode: 'live' } as never })).code,
    ).toBe(ErrorCode.TradeLiveUnavailable);
    expect(failure(() => preflightTradePlan({ ...base, costs: { commissionBps: -1 } })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      failure(() => preflightTradePlan({ ...base, session: { open: 'yes' } as never })).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() => preflightTradePlan({ ...base, openOrders: [{ orderId: 'x' }] } as never))
        .message,
    ).toContain('openOrders[0]');
    expect(failure(() => preflightTradePlan({ ...base, extra: 1 } as never)).code).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(failure(() => preflightTradePlan(null as never)).code).toBe(ErrorCode.InputWrongType);
    void (0 as unknown as ExecutionPlan);
  });
});

describe('the helpers read through typed doors (the enforcement gate, slice 1 landing)', () => {
  it('decideFromChecks refuses no checks, a malformed check, and an unknown onUnverifiable', () => {
    expect(() => decideFromChecks([], 'deny')).toThrow(/at least one check/);
    expect(() =>
      decideFromChecks(
        [{ name: 'x', verdict: 'maybe', value: 1, limit: 1, detail: 'd' } as never],
        'deny',
      ),
    ).toThrow(/checks\[0\]\.verdict/);
    expect(() =>
      decideFromChecks(
        [{ name: 'x', verdict: 'pass', value: 1, limit: 1, detail: 'd' }],
        'ignore' as never,
      ),
    ).toThrow(/onUnverifiable/);
    expect(
      decideFromChecks([{ name: 'x', verdict: 'pass', value: 1, limit: 1, detail: 'd' }], 'deny'),
    ).toEqual({
      verdict: 'allow',
      checks: [{ name: 'x', verdict: 'pass', value: 1, limit: 1, detail: 'd' }],
    });
  });

  it('referencePriceOf reads the market through its door and names the instrument', () => {
    expect(() => referencePriceOf({ bogus: true } as never, 'AAA')).toThrow();
    expect(() => referencePriceOf(market(), '' as never)).toThrow(/instrumentId/);
    expect(referencePriceOf(market(), 'AAA')).toEqual({ price: 110, currency: 'USD' });
    expect(referencePriceOf(market(), 'ZZZ')).toBeNull();
  });

  it('a null currencyConversions teaches instead of crashing', () => {
    expect(() =>
      normalizeTradePlan({
        intent: intent(),
        portfolio: ledger().state,
        market: market(),
        asOf: T0 + 2 * DAY,
        currencyConversions: null as never,
      }),
    ).toThrow(/currencyConversions/);
  });
});

describe('contract multipliers never fall back silently', () => {
  const OCC = 'AAPL260918C00200000';
  const optionMarket = () =>
    createMarketSnapshot({
      asOf: T0 + 2 * DAY,
      observations: {
        spots: {
          AAA: { price: 110, currency: 'USD' },
          BBB: { price: 50, currency: 'USD' },
          [OCC]: { price: 4.1, currency: 'USD' },
        },
      },
    });
  const occIntent = () =>
    intent({ orders: [{ instrumentId: OCC, side: 'buy', quantity: 2, type: 'market' }] });

  it('refuses an OCC option symbol known only from a market spot, naming the missing field', () => {
    const refusal = failure(() =>
      normalizeTradePlan({
        intent: occIntent(),
        portfolio: ledger().state,
        market: optionMarket(),
        asOf: T0 + 2 * DAY,
      }),
    );
    expect(refusal.code).toBe(ErrorCode.InputMissingField);
    expect(refusal.message).toContain(`instruments['${OCC}'].contractMultiplier`);
    expect(refusal.message).toContain('known only from a market spot');
  });

  it('refuses an OCC option symbol described without a multiplier, and prices it once declared', () => {
    const refusal = failure(() =>
      normalizeTradePlan({
        intent: occIntent(),
        portfolio: ledger().state,
        market: optionMarket(),
        asOf: T0 + 2 * DAY,
        instruments: { [OCC]: { currency: 'USD' } },
      }),
    );
    expect(refusal.code).toBe(ErrorCode.InputMissingField);
    expect(refusal.message).toContain('described without a contract multiplier');
    const plan = normalizeTradePlan({
      intent: occIntent(),
      portfolio: ledger().state,
      market: optionMarket(),
      asOf: T0 + 2 * DAY,
      instruments: { [OCC]: { currency: 'USD', contractMultiplier: 100 } },
    });
    // 2 contracts × 4.1 premium × 100 shares — the multiplier the estimate used rides the row.
    expect(plan.trades[0]).toMatchObject({
      instrumentId: OCC,
      referencePricePerUnit: 4.1,
      contractMultiplier: 100,
    });
    expect(plan.trades[0]!.estimatedNotional).toBeCloseTo(820, 9);
  });

  it('a plain instrument known only from a spot keeps the share multiplier and discloses it', () => {
    const plan = normalizeTradePlan({
      intent: intent(),
      portfolio: ledger().state,
      market: market(),
      asOf: T0 + 2 * DAY,
    });
    expect(plan.trades.map((t) => [t.instrumentId, t.contractMultiplier])).toEqual([
      ['BBB', 1],
      ['AAA', 1],
    ]);
  });

  it('preflight applies the same refusal under its own name', () => {
    const plan = normalizeTradePlan({
      intent: occIntent(),
      portfolio: ledger().state,
      market: optionMarket(),
      asOf: T0 + 2 * DAY,
      instruments: { [OCC]: { currency: 'USD', contractMultiplier: 100 } },
    });
    const refusal = failure(() =>
      preflightTradePlan({
        plan,
        portfolio: ledger().state,
        market: optionMarket(),
        asOf: T0 + 2 * DAY,
        policy: policy(),
      }),
    );
    expect(refusal.code).toBe(ErrorCode.InputMissingField);
    expect(refusal.message).toMatch(/^preflightTradePlan: instruments\['AAPL260918C00200000'\]/);
  });
});
