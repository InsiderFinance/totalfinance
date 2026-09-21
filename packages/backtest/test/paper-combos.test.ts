import { describe, expect, it } from 'vitest';
import { ErrorCode, InputError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { createPortfolioLedger, type PortfolioEventEnvelope } from '@totalfinance/portfolio';
import {
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
  type TradeIntent,
} from '@totalfinance/portfolio/trade';
import { SimulatedBroker } from '@totalfinance/backtest';
import {
  normalizedFillsFromBacktest,
  type MarketObservation,
} from '@totalfinance/backtest/execution';
import { createPaperBroker } from '@totalfinance/backtest/paper';

/**
 * Pre-publish interface repairs B5/B6 in the paper broker: a combo fills all-or-none against one
 * observation instant and only within its net limit; the broker stamps `submittedTimestampMs` at
 * submission and never fills against an observation older than it.
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
      spots: { AAA: { price: 110, currency: 'USD' }, BBB: { price: 50, currency: 'USD' } },
    },
  });
const intent = (netLimitPrice?: number): TradeIntent => ({
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
  ...(netLimitPrice === undefined ? {} : { combos: [{ comboId: 'pair', netLimitPrice }] }),
});
const bar = (
  symbol: string,
  open: number,
  high: number,
  low: number,
  close: number,
  at = NOW,
): MarketObservation => ({
  kind: 'bar',
  bar: { symbol, timestampMs: at, open, high, low, close, volume: 10_000 },
});
const authorized = (netLimitPrice?: number, quantities: readonly number[] = [200, 20]) => {
  const state = ledger().state;
  const proposed = intent(netLimitPrice);
  const plan = normalizeTradePlan({
    intent: {
      ...proposed,
      orders: proposed.orders.map((order, index) => ({ ...order, quantity: quantities[index]! })),
    },
    portfolio: state,
    market: market(),
    asOf: NOW,
  });
  const preflight = preflightTradePlan({
    plan,
    portfolio: state,
    market: market(),
    asOf: NOW,
    policy: { mode: 'paper', marketMaximumAgeMs: DAY },
  });
  const grant = createAuthorizationGrant({
    plan,
    preflight,
    marketMaximumAgeMs: DAY,
    mode: 'paper',
    variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 1_000 },
    expiresAt: NOW + DAY,
    approvedBy: 'trey',
    idempotencyKeys: { prefix: 'run', count: 3 },
    now: NOW,
  });
  return { state, plan, preflight, grant };
};
const broker = (journal?: ReturnType<ReturnType<typeof createPaperBroker>['journal']>) =>
  createPaperBroker({
    baseCurrency: 'USD',
    sourceId: 'paper:main',
    accountId: 'main',
    instruments: { AAA: { currency: 'USD' }, BBB: { currency: 'USD' } },
    ...(journal === undefined ? {} : { journal }),
  });
const submission = (a: ReturnType<typeof authorized>, key = 'run:1', now = NOW) => ({
  plan: a.plan,
  grant: a.grant,
  idempotencyKey: key,
  now,
  portfolioHash: a.preflight.portfolioHash,
  marketHash: a.preflight.marketHash,
  marketAsOf: NOW,
});
/** Both legs at one instant: the buy fills at the open (50), the sell limit at 112. */
const both = (at = NOW + 60_000) => ({
  BBB: bar('BBB', 50, 51, 49, 50.5, at),
  AAA: bar('AAA', 110, 115, 109, 114, at),
});

describe('a combo is one order to the paper broker', () => {
  it('refuses a missing leg, duplicate leg, or ratio drift before journaling anything', () => {
    const a = authorized();
    for (const orders of [
      [a.plan.orders[0]!],
      [...a.plan.orders, a.plan.orders[0]!],
      a.plan.orders.map((order, i) => (i === 0 ? { ...order, quantity: 190 } : order)),
    ]) {
      const b = broker();
      expect(() => b.submit({ ...submission(a), orders })).toThrowError(
        expect.objectContaining({ code: ErrorCode.TradeGrantInvalid }),
      );
      expect(b.journal()).toEqual([]);
    }
    const b = broker();
    const orders = a.plan.orders.map((order) => ({ ...order, quantity: order.quantity * 0.95 }));
    expect(b.submit({ ...submission(a), orders }).orders).toHaveLength(2);
  });

  it.each([false, true])(
    'cancels the entire combo and no orphan fills (restored=%s)',
    (restore) => {
      const a = authorized();
      let b = broker();
      b.submit(submission(a));
      if (restore) b = broker(b.journal());
      const cancelled = b.cancel({ orderId: a.plan.orders[0]!.orderId, now: NOW + 1_000 });
      expect(
        cancelled.journal
          .filter((event) => event.eventType === 'cancelled')
          .map((event) => event.orderId),
      ).toEqual(a.plan.orders.map((order) => order.orderId));
      expect(b.openOrders()).toEqual([]);
      expect(b.step({ observations: both(), asOf: NOW + 60_000 }).fills).toEqual([]);
      expect(b.cancel({ orderId: a.plan.orders[1]!.orderId, now: NOW + 2_000 }).accepted).toBe(
        false,
      );
    },
  );

  it.each([false, true])(
    'isolates same-named combos in different plans, including cancellation (restored=%s)',
    (restore) => {
      const allowed = authorized(390);
      const blocked = authorized(380);
      let b = broker();
      b.submit(submission(allowed));
      b.submit(submission(blocked, 'run:2'));
      if (restore) b = broker(b.journal());
      const step = b.step({ observations: both(), asOf: NOW + 60_000 });
      expect(step.fills.map((fill) => fill.orderId).sort()).toEqual(
        allowed.plan.orders.map((order) => order.orderId).sort(),
      );
      expect(
        b
          .openOrders()
          .map((order) => order.orderId)
          .sort(),
      ).toEqual(blocked.plan.orders.map((order) => order.orderId).sort());
      b.cancel({ orderId: blocked.plan.orders[0]!.orderId, now: NOW + 60_001 });
      expect(b.openOrders()).toEqual([]);
    },
  );

  it('validates every cancellation timestamp before mutating a combo and blocks an externally closed leg', () => {
    const a = authorized();
    const b = broker();
    b.submit(submission(a));
    const later = b.journal().find((event) => event.orderId === a.plan.orders[1]!.orderId)!;
    b.deliver({
      event: {
        ...later,
        eventId: 'external-cancel-request',
        eventType: 'cancel-requested',
        timestampMs: NOW + 5_000,
        detail: {},
      },
    });
    const prior = b.journal();
    expect(() => b.cancel({ orderId: a.plan.orders[0]!.orderId, now: NOW + 1_000 })).toThrowError(
      expect.objectContaining({ code: ErrorCode.InputOutOfRange }),
    );
    expect(b.journal()).toEqual(prior);
    expect(b.openOrders()).toHaveLength(2);
    b.deliver({
      event: {
        ...later,
        eventId: 'external-cancel',
        eventType: 'cancelled',
        timestampMs: NOW + 6_000,
        detail: {},
      },
    });
    const step = b.step({ observations: both(), asOf: NOW + 60_000 });
    expect(step.fills).toEqual([]);
    expect(step.unfilled).toMatchObject([{ reason: 'combo-leg-unfilled' }]);
    b.cancel({ orderId: a.plan.orders[0]!.orderId, now: NOW + 60_001 });
    expect(b.openOrders()).toEqual([]);
  });

  it('journals the combo on every submitted leg and stamps the submission instant on the order', () => {
    const a = authorized(390);
    const b = broker();
    b.submit(submission(a, 'run:1', NOW + 1_000));
    const submitted = b.journal().filter((e) => e.eventType === 'submitted');
    expect(submitted.map((e) => e.detail.comboId)).toEqual(['pair', 'pair']);
    expect(submitted.map((e) => e.detail.netLimitPrice)).toEqual([390, 390]);
    expect(submitted.map((e) => e.detail.order?.submittedTimestampMs)).toEqual([
      NOW + 1_000,
      NOW + 1_000,
    ]);
    expect(submitted.map((e) => e.detail.order?.plannedTimestampMs)).toEqual([NOW, NOW]);
  });

  it('fills all-or-none: no leg fills while a leg lacks an observation, and no fill id is consumed', () => {
    const a = authorized();
    const b = broker();
    b.submit(submission(a));
    const [buy, sell] = a.plan.orders;
    const partial = b.step({
      observations: { BBB: bar('BBB', 50, 51, 49, 50.5, NOW + 60_000) },
      asOf: NOW + 60_000,
    });
    expect(partial.fills).toEqual([]);
    expect(partial.journal).toEqual([]);
    expect(partial.unfilled).toEqual([
      { orderId: sell!.orderId, reason: 'no-observation', detail: expect.stringContaining('AAA') },
      {
        orderId: buy!.orderId,
        reason: 'combo-leg-unfilled',
        detail: expect.stringContaining('all-or-none'),
      },
    ]);
    expect([...partial.open].sort()).toEqual([buy!.orderId, sell!.orderId].sort());
    const split = b.step({
      observations: {
        BBB: bar('BBB', 50, 51, 49, 50.5, NOW + 120_000),
        AAA: bar('AAA', 110, 115, 109, 114, NOW + 90_000),
      },
      asOf: NOW + 120_000,
    });
    expect(split.fills).toEqual([]);
    expect(split.unfilled.map((u) => u.reason)).toEqual([
      'combo-leg-unfilled',
      'combo-leg-unfilled',
    ]);
    expect(split.unfilled[0]!.detail).toContain('one observation instant');
    const filled = b.step({ observations: both(NOW + 180_000), asOf: NOW + 180_000 });
    expect(filled.fills.map((f) => [f.orderId, f.quantity, f.pricePerUnit, f.fillId])).toEqual([
      [buy!.orderId, 200, 50, 'paper:main:fill:1'],
      [sell!.orderId, 20, 112, 'paper:main:fill:2'],
    ]);
    expect(filled.journal.map((e) => e.eventType)).toEqual(['filled', 'filled']);
    expect(filled.open).toEqual([]);
  });

  it('meets the net limit per combo unit (debit positive, credit negative) or fills nothing', () => {
    // Quantities 200 and 20 → a unit is 10 BBB against 1 AAA: net = 10 × 50 − 1 × 112 = 388.
    const tight = authorized(380);
    const b = broker();
    b.submit(submission(tight));
    const refused = b.step({ observations: both(), asOf: NOW + 60_000 });
    expect(refused.fills).toEqual([]);
    expect(refused.unfilled.map((u) => u.reason)).toEqual(['combo-net-limit', 'combo-net-limit']);
    expect(refused.unfilled[0]!.detail).toContain('net 388 per combo unit');
    // The same market at a later instant with a workable limit fills both legs.
    const loose = authorized(390);
    const c = broker();
    c.submit(submission(loose));
    const filled = c.step({ observations: both(), asOf: NOW + 60_000 });
    expect(filled.fills).toHaveLength(2);
    expect(filled.unfilled).toEqual([]);
  });

  it('survives a restart: a broker rebuilt from the journal still fills the combo all-or-none', () => {
    const a = authorized(390);
    const first = broker();
    first.submit(submission(a));
    const restored = broker(first.journal());
    const partial = restored.step({
      observations: { BBB: bar('BBB', 50, 51, 49, 50.5, NOW + 60_000) },
      asOf: NOW + 60_000,
    });
    expect(partial.fills).toEqual([]);
    expect(partial.unfilled.map((u) => u.reason).sort()).toEqual([
      'combo-leg-unfilled',
      'no-observation',
    ]);
    const filled = restored.step({ observations: both(NOW + 120_000), asOf: NOW + 120_000 });
    expect(filled.fills).toHaveLength(2);
  });

  it.each([
    { quantities: [5, 2], limit: 25, fills: 0 },
    { quantities: [5, 2], limit: 27, fills: 2 },
    { quantities: [2, 3], limit: -238, fills: 0 },
    { quantities: [2, 3], limit: -234, fills: 2 },
  ])(
    'retains the authorized net-limit economics when quantities scale: $quantities / $limit',
    ({ quantities, limit, fills }) => {
      const a = authorized(limit, quantities);
      for (const scale of [1, 0.95]) {
        for (const restart of [false, true]) {
          const initial = broker();
          initial.submit({
            ...submission(a),
            orders: a.plan.orders.map((order) => ({ ...order, quantity: order.quantity * scale })),
          });
          const active = restart ? broker(initial.journal()) : initial;
          const result = active.step({ observations: both(), asOf: NOW + 60_000 });
          expect(result.fills, `scale=${scale}, restart=${restart}`).toHaveLength(fills);
          if (fills === 0)
            expect(result.unfilled.every((order) => order.reason === 'combo-net-limit')).toBe(true);
        }
      }
    },
  );
});

describe('the submission stamp (B6)', () => {
  it('never fills against an observation older than the submission', () => {
    const a = authorized();
    const b = broker();
    b.submit(submission(a, 'run:1', NOW + 30_000));
    const stale = b.step({ observations: both(NOW), asOf: NOW + 60_000 });
    expect(stale.fills).toEqual([]);
    expect(stale.unfilled.map((u) => u.reason)).toEqual([
      'observation-before-submission',
      'observation-before-submission',
    ]);
    expect(stale.unfilled[0]!.detail).toContain(`precedes the submission at ${NOW + 30_000}`);
    const fresh = b.step({ observations: both(NOW + 30_000), asOf: NOW + 60_000 });
    expect(fresh.fills).toHaveLength(2);
  });

  it('a retry with the plan orders re-supplied is still the same receipt (the stamp is the broker’s)', () => {
    const a = authorized();
    const b = broker();
    const receipt = b.submit(submission(a));
    expect(b.submit({ ...submission(a, 'run:1', NOW + 5_000), orders: a.plan.orders })).toBe(
      receipt,
    );
  });

  it('a journal without the stamp cannot be restored — it needs migration from the original facts', () => {
    const a = authorized();
    const b = broker();
    b.submit(submission(a));
    const legacy = b.journal().map((e) =>
      e.eventType === 'submitted'
        ? {
            ...e,
            detail: {
              ...e.detail,
              order: (({ submittedTimestampMs: _s, ...rest }) => rest)(e.detail.order!),
            },
          }
        : e,
    );
    let error: unknown;
    try {
      broker(legacy);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InputError);
    expect((error as InputError).code).toBe(ErrorCode.InputMissingField);
  });
});

describe('the bar broker speaks the same vocabulary', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const xbar = (i: number, o: number, h: number, l: number, c: number) => ({
    symbol: 'X',
    timestampMs: t0 + i * DAY,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1_000,
  });

  it('market-on-open fills at the open, market-on-close at the close; the retired camelCase is refused', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, type: 'market-on-open' });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10, type: 'market-on-close' });
    const fills = b.processBar(xbar(0, 50, 52, 49, 51));
    expect(fills.map((f) => f.price)).toEqual([50, 51]);
    expect(() =>
      b.submit({ symbol: 'X', side: 'buy', quantity: 10, type: 'stopLimit' as never }),
    ).toThrow(/stop-limit/);
    expect(() =>
      b.submit({ symbol: 'X', side: 'buy', quantity: 10, type: 'stopLimit' as never }),
    ).not.toThrow(/stopLimit,/);
  });

  it('normalizedFillsFromBacktest carries every trade to the ledger with its multiplier and costs', () => {
    const b = new SimulatedBroker({ cash: 100_000 });
    b.submit({ symbol: 'X', side: 'buy', quantity: 10 });
    b.processBar(xbar(0, 50, 52, 49, 51));
    b.submit({ symbol: 'X', side: 'sell', quantity: 4 });
    b.processBar(xbar(1, 55, 56, 54, 55));
    const fills = normalizedFillsFromBacktest({
      trades: b.trades,
      accountId: 'main',
      currency: 'USD',
      sourceId: 'backtest:demo',
    });
    expect(
      fills.map((f) => [f.fillId, f.instrumentId, f.side, f.quantity, f.pricePerUnit]),
    ).toEqual([
      ['backtest:demo:fill:1', 'X', 'buy', 10, 50],
      ['backtest:demo:fill:2', 'X', 'sell', 4, 55],
    ]);
    expect(fills[0]!.contractMultiplier).toBeUndefined();
    const option = normalizedFillsFromBacktest({
      trades: [
        {
          symbol: 'X260918C00050000',
          timestampMs: t0,
          side: 'buy',
          quantity: 2,
          price: 3,
          commission: 1.3,
          slippage: 0.02,
          multiplier: 100,
        },
      ],
      accountId: 'main',
      currency: 'USD',
      sourceId: 'backtest:demo',
      instruments: {
        X260918C00050000: {
          contract: {
            kind: 'option',
            underlyingInstrumentId: 'X',
            type: 'call',
            strikePricePerUnit: 50,
            expiryTimestampMs: t0 + 30 * DAY,
          },
        },
      },
    });
    expect(option[0]).toMatchObject({
      contractMultiplier: 100,
      contract: { kind: 'option', type: 'call' },
      costs: { commission: 1.3 },
      executionPriceAdjustment: 0.02,
    });
    expect(() =>
      normalizedFillsFromBacktest({ trades: [], accountId: '', currency: 'USD', sourceId: 's' }),
    ).toThrow(/accountId/);
  });
});
