import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { createPortfolioLedger, type PortfolioEventEnvelope } from '@totalfinance/portfolio';
import {
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
  requireExecutionPlan,
  requireTradeIntent,
  verifyAuthorizationGrant,
  type PreflightInstrument,
  type TradeIntent,
  type TradePolicy,
} from '@totalfinance/portfolio/trade';

/**
 * Pre-publish interface repairs B5 — multi-leg orders are one order. An intent's lines may share a
 * `comboId`; the plan lists every combo with its legs and net limit; preflight judges undefined
 * risk on the combo's after-state; the grant binds the combo ids.
 */
const T0 = Date.UTC(2026, 0, 5, 21);
const DAY = 86_400_000;
const NOW = T0 + 2 * DAY;
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
const ledger = () =>
  createPortfolioLedger({
    portfolioId: 'primary',
    baseCurrency: 'USD',
    events: [
      envelope('dep', T0, { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' }),
      envelope('fill', T0 + DAY, {
        eventType: 'trade.fill',
        instrumentId: 'AAA',
        side: 'buy',
        quantity: 100,
        pricePerUnit: 100,
        currency: 'USD',
      }),
    ],
  });
const market = () =>
  createMarketSnapshot({
    asOf: NOW,
    observations: {
      spots: {
        AAA: { price: 110, currency: 'USD' },
        BBB: { price: 50, currency: 'USD' },
        C100: { price: 12, currency: 'USD' },
        C110: { price: 7, currency: 'USD' },
        C120: { price: 4, currency: 'USD' },
        P100: { price: 3, currency: 'USD' },
      },
    },
  });
const option = (
  type: 'call' | 'put',
  strike: number,
  expiry = NOW + 30 * DAY,
): PreflightInstrument => ({
  currency: 'USD',
  contractMultiplier: 100,
  assetClass: 'option',
  contract: {
    kind: 'option',
    underlyingInstrumentId: 'AAA',
    type,
    strikePricePerUnit: strike,
    expiryTimestampMs: expiry,
  },
});
const instruments = {
  C100: option('call', 100),
  C110: option('call', 110),
  C120: option('call', 120),
  P100: option('put', 100),
};
type IntentOverrides = Partial<Omit<TradeIntent, 'combos'>> & {
  /** `undefined` drops the combos entirely (exactOptionalPropertyTypes never lets a key hold it). */
  combos?: TradeIntent['combos'] | undefined;
};
const intent = (overrides: IntentOverrides = {}): TradeIntent => {
  const { combos, ...rest } = overrides;
  const withCombos = 'combos' in overrides ? combos : [{ comboId: 'pair', netLimitPrice: 390 }];
  return {
    kind: 'totalfinance.trade-intent',
    schemaVersion: 1,
    accountId: 'main',
    asOf: NOW,
    orders: [
      { instrumentId: 'BBB', side: 'buy', quantity: 200, type: 'market', comboId: 'pair' },
      {
        instrumentId: 'AAA',
        side: 'sell',
        quantity: 20,
        type: 'limit',
        limitPrice: 112,
        comboId: 'pair',
      },
    ],
    ...(withCombos === undefined ? {} : { combos: withCombos }),
    ...rest,
  };
};
const policy = (overrides: Partial<TradePolicy> = {}): TradePolicy => ({
  mode: 'paper',
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
const planOf = (i: TradeIntent) =>
  normalizeTradePlan({
    intent: i,
    portfolio: ledger().state,
    market: market(),
    asOf: NOW,
    instruments,
  });

describe('an intent with combos normalizes to a plan that lists them', () => {
  it('carries comboId on every leg and the combo with its legs in plan order and its net limit', () => {
    const plan = planOf(intent());
    expect(plan.orders.map((o) => o.comboId)).toEqual(['pair', 'pair']);
    expect(plan.combos).toEqual([
      { comboId: 'pair', orderIds: plan.orders.map((o) => o.orderId), netLimitPrice: 390 },
    ]);
    expect(plan.orders.every((o) => o.plannedTimestampMs === NOW)).toBe(true);
    expect(plan.orders.every((o) => o.submittedTimestampMs === undefined)).toBe(true);
    expect(() => requireExecutionPlan('t', 'plan', plan)).not.toThrow();
    // Without terms a combo has no net limit; without comboIds a plan has no combos.
    const untermed = planOf(intent({ combos: undefined }));
    expect(untermed.combos).toEqual([
      { comboId: 'pair', orderIds: untermed.orders.map((o) => o.orderId) },
    ]);
    const single = planOf(
      intent({
        orders: [{ instrumentId: 'BBB', side: 'buy', quantity: 200, type: 'market' }],
        combos: undefined,
      }),
    );
    expect(single.combos).toEqual([]);
  });

  it('refuses a one-leg combo, terms for an unnamed combo, a duplicate entry, and a bad net limit', () => {
    const base = intent();
    expect(
      failure(() =>
        requireTradeIntent('t', 'intent', {
          ...base,
          orders: [base.orders[0]!, { ...base.orders[1]!, comboId: undefined }],
        }),
      ),
    ).toMatchObject({
      code: ErrorCode.TradePlanInvalid,
      message: expect.stringContaining('one leg'),
    });
    expect(
      failure(() => requireTradeIntent('t', 'intent', { ...base, combos: [{ comboId: 'ghost' }] }))
        .message,
    ).toContain("'ghost' names no order");
    expect(
      failure(() =>
        requireTradeIntent('t', 'intent', {
          ...base,
          combos: [{ comboId: 'pair' }, { comboId: 'pair', netLimitPrice: 1 }],
        }),
      ).message,
    ).toContain('repeats');
    expect(
      failure(() =>
        requireTradeIntent('t', 'intent', {
          ...base,
          combos: [{ comboId: 'pair', netLimitPrice: NaN }],
        }),
      ).code,
    ).toMatch(/^input\./);
    expect(
      failure(() =>
        requireTradeIntent('t', 'intent', { ...base, combos: [{ comboId: 'pair', legs: 2 }] }),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
  });

  it('a plan is refused when its combos and legs disagree, or when an order carries a submission stamp', () => {
    const plan = planOf(intent());
    const body = (mutate: (draft: Record<string, unknown>) => void) => {
      const draft = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
      mutate(draft);
      return draft;
    };
    // The content hash guards the body, so every structural refusal is tested before the hash.
    const orders = plan.orders.map((o) => o.orderId);
    expect(
      failure(() =>
        requireExecutionPlan(
          't',
          'plan',
          body((d) => ((d['combos'] as unknown[])[0] = { comboId: 'pair', orderIds: [orders[0]] })),
        ),
      ).message,
    ).toContain('at least two orders');
    expect(
      failure(() =>
        requireExecutionPlan(
          't',
          'plan',
          body(
            (d) =>
              ((d['combos'] as unknown[])[0] = { comboId: 'pair', orderIds: [orders[0], 'nope'] }),
          ),
        ),
      ).message,
    ).toContain("'nope' is not an order of this plan");
    expect(
      failure(() =>
        requireExecutionPlan(
          't',
          'plan',
          body((d) => (d['combos'] = [])),
        ),
      ).message,
    ).toContain('no combo lists it');
    expect(
      failure(() =>
        requireExecutionPlan(
          't',
          'plan',
          body(
            (d) => ((d['orders'] as Record<string, unknown>[])[0]!['submittedTimestampMs'] = NOW),
          ),
        ),
      ).message,
    ).toContain('stamped by the broker');
    expect(
      failure(() =>
        requireExecutionPlan(
          't',
          'plan',
          body((d) => delete d['combos']),
        ),
      ).code,
    ).toBe(ErrorCode.InputWrongType);
  });
});

describe('preflight judges undefined risk on the combo after-state', () => {
  it.each([
    { stock: false, long: true },
    { stock: true, long: false },
  ])('never reuses one hedge for two different shorts (%j)', ({ stock, long }) => {
    const portfolio = createPortfolioLedger({
      baseCurrency: 'USD',
      events: ledger()
        .toJSON()
        .events.filter((event) => stock || event.eventType === 'cash.deposit'),
    }).state;
    const orders: TradeIntent['orders'] = [
      { instrumentId: 'C100', side: 'sell', quantity: 1, type: 'market', comboId: 'ratio' },
      { instrumentId: 'C110', side: 'sell', quantity: 1, type: 'market', comboId: 'ratio' },
      ...(long
        ? [
            {
              instrumentId: 'C120',
              side: 'buy' as const,
              quantity: 1,
              type: 'market' as const,
              comboId: 'ratio',
            },
          ]
        : []),
    ];
    const plan = normalizeTradePlan({
      intent: intent({ orders, combos: undefined }),
      portfolio,
      market: market(),
      asOf: NOW,
      instruments,
    });
    const report = preflightTradePlan({
      plan,
      portfolio,
      market: market(),
      asOf: NOW,
      policy: policy(),
      instruments,
    });
    expect(report.decision.verdict).toBe('deny');
    expect(
      report.checks.filter(
        (check) => check.name.endsWith('undefined-risk') && check.verdict === 'fail',
      ),
    ).toHaveLength(1);
  });
  it.each([false, true])(
    'allocates stock and option capacity once, independent of leg order (reverse=%s)',
    (reverse) => {
      const state = ledger().state; // 100 shares plus 100 long option units cannot cover 300 short units.
      const orders: TradeIntent['orders'] = [
        { instrumentId: 'C100', side: 'sell', quantity: 2, type: 'market', comboId: 'ratio' },
        { instrumentId: 'C110', side: 'sell', quantity: 1, type: 'market', comboId: 'ratio' },
        { instrumentId: 'C120', side: 'buy', quantity: 1, type: 'market', comboId: 'ratio' },
      ];
      const plan = planOf(
        intent({ orders: reverse ? [...orders].reverse() : orders, combos: undefined }),
      );
      const report = preflightTradePlan({
        plan,
        portfolio: state,
        market: market(),
        asOf: NOW,
        policy: policy(),
        instruments,
      });
      expect(report.decision.verdict).toBe('deny');
      expect(
        report.checks.filter(
          (check) => check.name.endsWith('undefined-risk') && check.verdict === 'fail',
        ),
      ).toHaveLength(1);
      const coveredOrders = orders.map((order) =>
        order.instrumentId === 'C100' ? { ...order, quantity: 1 } : order,
      );
      const covered = preflightTradePlan({
        plan: planOf(intent({ orders: coveredOrders, combos: undefined })),
        portfolio: state,
        market: market(),
        asOf: NOW,
        policy: policy(),
        instruments,
      });
      expect(
        covered.checks
          .filter((check) => check.name.endsWith('undefined-risk'))
          .every((check) => check.verdict === 'pass'),
      ).toBe(true);
    },
  );

  it('detects selling the stock hedge of an existing short call', () => {
    const base = ledger();
    const withShort = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [
        ...base.toJSON().events,
        envelope('short', NOW - 1_000, {
          eventType: 'trade.fill',
          instrumentId: 'C100',
          side: 'sell',
          quantity: 1,
          pricePerUnit: 12,
          currency: 'USD',
          contractMultiplier: 100,
          contract: instruments.C100.contract,
        }),
      ],
    });
    const plan = normalizeTradePlan({
      intent: intent({
        orders: [{ instrumentId: 'AAA', side: 'sell', quantity: 100, type: 'market' }],
        combos: undefined,
      }),
      portfolio: withShort.state,
      market: market(),
      asOf: NOW,
      instruments,
    });
    const report = preflightTradePlan({
      plan,
      portfolio: withShort.state,
      market: market(),
      asOf: NOW,
      policy: policy(),
      instruments,
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: expect.stringContaining('C100'),
        verdict: 'fail',
        detail: expect.stringContaining('uncovered'),
      }),
    );
  });
  // The ledger holds 100 AAA: two contracts (200 units) are more than the underlying covers.
  const vertical = (comboId: string | undefined) =>
    intent({
      orders: [
        {
          instrumentId: 'C100',
          side: 'sell',
          quantity: 2,
          type: 'market',
          ...(comboId ? { comboId } : {}),
        },
        {
          instrumentId: 'C120',
          side: 'buy',
          quantity: 2,
          type: 'market',
          ...(comboId ? { comboId } : {}),
        },
      ],
      combos: undefined,
    });
  const judge = (i: TradeIntent) => {
    const plan = planOf(i);
    const report = preflightTradePlan({
      plan,
      portfolio: ledger().state,
      market: market(),
      asOf: NOW,
      policy: policy(),
      instruments,
    });
    return report.checks.filter((c) => c.name.endsWith('undefined-risk'));
  };

  it('the same two legs: naked when they stand alone in this order, defined-risk as one combo', () => {
    const alone = judge(vertical(undefined));
    expect(alone).toMatchObject([{ name: 'orders[0].undefined-risk', verdict: 'fail' }]);
    const combo = judge(vertical('vertical'));
    expect(combo).toMatchObject([
      {
        name: 'orders[0].undefined-risk',
        verdict: 'pass',
        detail: expect.stringContaining('combo vertical'),
      },
    ]);
    expect(combo[0]!.detail).toContain('same-or-later-dated long calls');
  });

  it('a long of the other type, or an earlier expiry, does not define the risk; the underlying covers a call', () => {
    const wrongType = judge(
      intent({
        orders: [
          { instrumentId: 'C100', side: 'sell', quantity: 2, type: 'market', comboId: 'x' },
          { instrumentId: 'P100', side: 'buy', quantity: 2, type: 'market', comboId: 'x' },
        ],
        combos: undefined,
      }),
    );
    expect(wrongType).toMatchObject([{ verdict: 'fail' }]);
    const earlier = { ...instruments, C120: option('call', 120, NOW + 10 * DAY) };
    const plan = planOf(vertical('v'));
    const report = preflightTradePlan({
      plan,
      portfolio: ledger().state,
      market: market(),
      asOf: NOW,
      policy: policy(),
      instruments: earlier,
    });
    expect(report.checks.filter((c) => c.name.endsWith('undefined-risk'))).toMatchObject([
      { verdict: 'fail' },
    ]);
    // AAA is held 100 shares: a single short call (100 units) is covered by the underlying.
    const covered = judge(
      intent({
        orders: [{ instrumentId: 'C100', side: 'sell', quantity: 1, type: 'market' }],
        combos: undefined,
      }),
    );
    expect(covered).toMatchObject([
      { verdict: 'pass', detail: expect.stringContaining('underlying') },
    ]);
  });
});

describe('the grant binds the combo ids', () => {
  const authorize = (i: TradeIntent) => {
    const plan = planOf(i);
    const preflight = preflightTradePlan({
      plan,
      portfolio: ledger().state,
      market: market(),
      asOf: NOW,
      policy: policy(),
      instruments,
    });
    const grant = createAuthorizationGrant({
      plan,
      preflight,
      marketMaximumAgeMs: DAY,
      mode: 'paper',
      variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 1_000 },
      expiresAt: NOW + DAY,
      approvedBy: 'trey',
      idempotencyKeys: ['k1'],
      now: NOW,
    });
    return { plan, preflight, grant };
  };

  it('records the plan order combo ids, refuses a leg that leaves its combo, and names a combo mismatch', () => {
    const a = authorize(intent());
    expect(a.grant.comboIds).toEqual(['pair']);
    const ok = verifyAuthorizationGrant({
      grant: a.grant,
      plan: a.plan,
      now: NOW,
      portfolioHash: a.preflight.portfolioHash,
      marketHash: a.preflight.marketHash,
      marketAsOf: NOW,
      idempotencyKey: 'k1',
    });
    expect(ok.valid).toBe(true);
    expect(ok.diagnostics.bindingCount).toBe(10);
    const leftCombo = verifyAuthorizationGrant({
      grant: a.grant,
      plan: a.plan,
      now: NOW,
      portfolioHash: a.preflight.portfolioHash,
      marketHash: a.preflight.marketHash,
      marketAsOf: NOW,
      idempotencyKey: 'k1',
      orders: a.plan.orders.map((o, i) => {
        if (i !== 0) return o;
        const { comboId: _left, ...rest } = o;
        return rest;
      }),
    });
    expect(leftCombo.valid).toBe(false);
    expect(leftCombo.reasons).toMatchObject([
      { reason: 'order-mismatch', detail: expect.stringContaining('leave or join a combo') },
    ]);
    const plain = authorize(
      intent({
        orders: [{ instrumentId: 'BBB', side: 'buy', quantity: 200, type: 'market' }],
        combos: undefined,
      }),
    );
    const crossed = verifyAuthorizationGrant({
      grant: plain.grant,
      plan: a.plan,
      now: NOW,
      portfolioHash: a.preflight.portfolioHash,
      marketHash: a.preflight.marketHash,
      marketAsOf: NOW,
      idempotencyKey: 'k1',
    });
    expect(crossed.reasons.map((r) => r.reason)).toEqual(
      expect.arrayContaining(['plan-hash-mismatch', 'combo-mismatch']),
    );
  });
});
