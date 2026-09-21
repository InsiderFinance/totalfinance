/**
 * Stage 7B.2 (AT5) slice 3 — the paper broker and the hazard suite; Journey 4 as a test.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { contentHash, createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  type PortfolioEventEnvelope,
  type PortfolioState,
} from '@totalfinance/portfolio';
import {
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
  reconcileExecution,
  type ExecutionJournalEvent,
  type TradeIntent,
  type TradePolicy,
} from '@totalfinance/portfolio/trade';
import { execution, fees, fillOrderWithPolicy, slippage } from '@totalfinance/backtest/execution';
import type { MarketObservation } from '@totalfinance/backtest/execution';
import { createPaperBroker, EXECUTION_RECEIPT_KIND } from '@totalfinance/backtest/paper';

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
const market = (asOf = NOW, aaa = 110, bbb = 50) =>
  createMarketSnapshot({
    asOf,
    observations: {
      spots: { AAA: { price: aaa, currency: 'USD' }, BBB: { price: bbb, currency: 'USD' } },
    },
  });
const intent = (overrides: Partial<TradeIntent> = {}): TradeIntent => ({
  kind: 'totalfinance.trade-intent',
  schemaVersion: 1,
  accountId: 'main',
  asOf: NOW,
  orders: [
    { instrumentId: 'BBB', side: 'buy', quantity: 200, type: 'market' },
    { instrumentId: 'AAA', side: 'sell', quantity: 20, type: 'limit', limitPrice: 112 },
  ],
  rationale: 'rotate a fifth of AAA into BBB',
  ...overrides,
});
const policy = (overrides: Partial<TradePolicy> = {}): TradePolicy => ({
  mode: 'paper',
  limits: { maximumPositionWeight: 0.5, maximumGrossLeverage: 1 },
  maximumOrderNotional: 50_000,
  marketMaximumAgeMs: DAY,
  ...overrides,
});
const bar = (
  symbol: string,
  open: number,
  high: number,
  low: number,
  close: number,
  at = NOW,
  volume = 10_000,
): MarketObservation => ({
  kind: 'bar',
  bar: { symbol, timestampMs: at, open, high, low, close, volume },
});
const failure = (
  fn: () => unknown,
): { code?: string; message: string; context?: Record<string, unknown> } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

const authorized = (overrides: Partial<TradeIntent> = {}) => {
  const state = ledger().state;
  const plan = normalizeTradePlan({
    intent: intent(overrides),
    portfolio: state,
    market: market(),
    asOf: NOW,
  });
  const preflight = preflightTradePlan({
    plan,
    portfolio: state,
    market: market(),
    asOf: NOW,
    policy: policy(),
  });
  const grant = createAuthorizationGrant({
    plan,
    preflight,
    marketMaximumAgeMs: DAY,
    mode: 'paper',
    variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
    expiresAt: NOW + DAY,
    approvedBy: 'trey',
    idempotencyKeys: { prefix: 'run', count: 3 },
    now: NOW,
  });
  return { state, plan, preflight, grant };
};
const broker = (_state: PortfolioState, extra: Record<string, unknown> = {}) =>
  createPaperBroker({
    baseCurrency: 'USD',
    sourceId: 'paper:main',
    accountId: 'main',
    instruments: { AAA: { currency: 'USD' }, BBB: { currency: 'USD' } },
    ...extra,
  });
// B6: the paper broker never fills against an observation older than the submission, so the
// fixture submits AT the market instant its observations carry.
const submission = (a: ReturnType<typeof authorized>, key = 'run:1', now = NOW) => ({
  plan: a.plan,
  grant: a.grant,
  idempotencyKey: key,
  now,
  portfolioHash: a.preflight.portfolioHash,
  marketHash: a.preflight.marketHash,
  marketAsOf: NOW,
});

describe('createPaperBroker.submit', () => {
  it('verifies the grant, journals submitted and acknowledged, and returns the same receipt for a retry', () => {
    const a = authorized();
    const b = broker(a.state);
    const receipt = b.submit(submission(a));
    expect(receipt.kind).toBe(EXECUTION_RECEIPT_KIND);
    expect(receipt.planHash).toBe(a.plan.contentHash);
    expect(receipt.grantHash).toBe(a.grant.contentHash);
    expect(receipt.adapter).toBe('paper');
    expect(receipt.orders.map((o) => [o.orderId, o.state])).toEqual(
      a.plan.orders.map((o) => [o.orderId, 'acknowledged']),
    );
    expect(receipt.journalEventIds).toHaveLength(4);
    expect(receipt.fills).toEqual([]);
    expect(receipt.assumptions.execution.label).toContain('simplified');
    const { contentHash: declared, ...body } = receipt;
    expect(declared).toBe(contentHash(body));
    // a retry is not a second order
    expect(b.submit(submission(a, 'run:1', NOW + 5_000))).toBe(receipt);
    expect(b.journal()).toHaveLength(4);
    expect(b.receipts()).toHaveLength(1);
    expect(b.openOrders().map((o) => o.orderId)).toEqual(
      [...a.plan.orders.map((o) => o.orderId)].sort(),
    );
    expect(b.describe()).toMatchObject({
      adapter: 'paper',
      halted: false,
      openOrderCount: 2,
      eventCount: 4,
      receiptCount: 1,
    });
  });

  it('refuses the same key with another plan, an unauthorized submission, a foreign account, and every malformed input', () => {
    const a = authorized();
    const b = broker(a.state);
    b.submit(submission(a));
    const other = authorized({ rationale: 'another plan' });
    const conflict = failure(() => b.submit({ ...submission(other), idempotencyKey: 'run:1' }));
    expect(conflict.code).toBe(ErrorCode.TradeIdempotencyConflict);
    const expired = failure(() => broker(a.state).submit(submission(a, 'run:2', NOW + 2 * DAY)));
    expect(expired.code).toBe(ErrorCode.TradeGrantExpired);
    const drifted = failure(() =>
      broker(a.state).submit({ ...submission(a, 'run:2'), portfolioHash: 'sha256:moved' }),
    );
    expect(drifted.code).toBe(ErrorCode.TradeGrantInvalid);
    expect(drifted.message).toContain('portfolio-hash-mismatch');
    const unknownKey = failure(() => broker(a.state).submit(submission(a, 'run:9')));
    expect(unknownKey.code).toBe(ErrorCode.TradeGrantInvalid);
    const foreign = failure(() =>
      createPaperBroker({
        baseCurrency: 'USD',
        sourceId: 'paper:x',
        accountId: 'other',
      }).submit(submission(a)),
    );
    expect(foreign.message).toContain('accountId');
    expect(
      failure(() => b.submit({ ...submission(a, 'run:2'), extra: 1 } as never)).message,
    ).toContain('extra');
    expect(
      failure(() => b.submit({ ...submission(a, 'run:2'), grant: { ...a.grant, expiresAt: 0 } }))
        .message,
    ).toContain('contentHash');
    expect(
      failure(() =>
        createPaperBroker({
          baseCurrency: 'USD',
          sourceId: '',
          accountId: 'main',
        }),
      ).message,
    ).toContain('sourceId');
    expect(
      failure(() =>
        createPaperBroker({
          baseCurrency: 'USD',
          sourceId: 'p',
          accountId: 'main',
          instruments: { AAA: { currency: 'USD', settlementLag: 5 } } as never,
        }),
      ).message,
    ).toContain('settlementLag');
  });
});

describe('createPaperBroker.step', () => {
  it('meets open orders with the market through the fill path and returns fills, ledger events, and journal events', () => {
    const a = authorized();
    const b = broker(a.state);
    b.submit(submission(a));
    const [buy, sell] = a.plan.orders;
    const result = b.step({
      observations: { BBB: bar('BBB', 50, 51, 49, 50.5), AAA: bar('AAA', 110, 115, 109, 114) },
      asOf: NOW + 60_000,
    });
    expect(result.fills.map((f) => [f.orderId, f.side, f.quantity, f.pricePerUnit])).toEqual([
      [buy!.orderId, 'buy', 200, 50],
      [sell!.orderId, 'sell', 20, 112],
    ]);
    expect(result.journal.map((e) => e.eventType)).toEqual(['filled', 'filled']);
    expect(result.open).toEqual([]);
    expect(result.expired).toEqual([]);
    expect(result.unfilled).toEqual([]);
    // the ledger folds the events exactly
    const after = applyPortfolioEvents({ previousState: a.state, events: result.events });
    expect(after.accounts['main']!.positions['BBB']!.quantity).toBe(200);
    expect(after.accounts['main']!.positions['AAA']!.quantity).toBe(80);
    expect(b.openOrders()).toEqual([]);
    expect(b.state().orders[buy!.orderId]).toMatchObject({
      state: 'filled',
      filledQuantity: 200,
      terminal: true,
    });
  });

  it('leaves an order open without an observation, fills partially under a participation cap, and expires a day order', () => {
    const a = authorized();
    const capped = execution.declared({
      label: 'capped: 1% of bar volume per fill',
      costs: { commission: fees.none(), slippage: slippage.none(), participation: 0.01 },
    });
    const b = broker(a.state, { execution: capped });
    b.submit(submission(a));
    const [buy, sell] = a.plan.orders;
    const first = b.step({
      observations: { BBB: bar('BBB', 50, 51, 49, 50.5, NOW + 60_000, 10_000) },
      asOf: NOW + 60_000,
    });
    expect(first.fills.map((f) => [f.orderId, f.quantity])).toEqual([[buy!.orderId, 100]]);
    expect(first.journal.map((e) => e.eventType)).toEqual(['partially-filled']);
    expect(first.unfilled).toEqual([
      { orderId: sell!.orderId, reason: 'no-observation', detail: expect.stringContaining('AAA') },
    ]);
    expect(first.open).toEqual([buy!.orderId, sell!.orderId].sort());
    expect(b.state().orders[buy!.orderId]).toMatchObject({
      state: 'partially-filled',
      filledQuantity: 100,
      remainingQuantity: 100,
    });
    const second = b.step({
      observations: { BBB: bar('BBB', 50, 51, 49, 50.5, NOW + 120_000, 10_000) },
      asOf: NOW + 120_000,
    });
    expect(second.fills.map((f) => [f.orderId, f.quantity])).toEqual([[buy!.orderId, 100]]);
    expect(second.journal.map((e) => e.eventType)).toEqual(['filled']);
    expect(b.state().orders[buy!.orderId]!.fillIds).toEqual([
      'paper:main:fill:1',
      'paper:main:fill:2',
    ]);
    const third = b.step({ observations: {}, asOf: NOW + 1_000 + DAY });
    expect(third.expired).toEqual([sell!.orderId]);
    expect(b.state().orders[sell!.orderId]).toMatchObject({ state: 'expired', terminal: true });
    expect(b.openOrders()).toEqual([]);
  });
});

describe('the hazard suite', () => {
  it('cancellation: journals cancel-requested then cancelled; a terminal order is not cancelled twice', () => {
    const a = authorized();
    const b = broker(a.state);
    b.submit(submission(a));
    const [buy] = a.plan.orders;
    const cancelled = b.cancel({ orderId: buy!.orderId, now: NOW + 2_000 });
    expect(cancelled.accepted).toBe(true);
    expect(cancelled.journal.map((e) => e.eventType)).toEqual(['cancel-requested', 'cancelled']);
    expect(cancelled.state).toMatchObject({
      state: 'cancelled',
      cancelRequested: true,
      terminal: true,
    });
    const again = b.cancel({ orderId: buy!.orderId, now: NOW + 3_000 });
    expect(again.accepted).toBe(false);
    expect(again.journal).toEqual([]);
    expect(failure(() => b.cancel({ orderId: 'nope', now: NOW })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
  });

  it('late fill: a fill delivered after the cancellation is journaled, reaches the ledger, and leaves the order unresolved', () => {
    const a = authorized();
    const b = broker(a.state);
    b.submit(submission(a));
    const [buy] = a.plan.orders;
    b.cancel({ orderId: buy!.orderId, now: NOW + 2_000 });
    const late: ExecutionJournalEvent = {
      eventId: 'paper:main:journal:external-1',
      journalId: 'paper:main:journal',
      timestampMs: NOW + 4_000,
      orderId: buy!.orderId,
      planHash: a.plan.contentHash,
      eventType: 'filled',
      detail: { fillId: 'venue:late-1', quantity: 200, pricePerUnit: 50 },
      sourceId: 'paper:main',
      provenance: {},
    };
    const delivered = b.deliver({ event: late });
    expect(delivered).toMatchObject({ applied: true, duplicate: false, lateFill: true });
    expect(delivered.fill).toMatchObject({
      fillId: 'venue:late-1',
      instrumentId: 'BBB',
      side: 'buy',
      quantity: 200,
    });
    expect(delivered.events.length).toBeGreaterThan(0);
    expect(delivered.state).toMatchObject({
      state: 'unresolved',
      terminal: true,
      lateFillIds: ['venue:late-1'],
    });
    // the ledger takes the late fill; reconciliation names the unresolved order
    const after = applyPortfolioEvents({ previousState: a.state, events: delivered.events });
    expect(after.accounts['main']!.positions['BBB']!.quantity).toBe(200);
    const report = reconcileExecution({
      journal: b.journal(),
      ledger: after,
      sourceId: 'paper:main',
      fills: [delivered.fill!],
      asOf: NOW + 5_000,
      tolerance: { quantity: 1e-9, cashAmount: 0.01 },
    });
    expect(report.reconciled).toBe(false);
    expect(report.unresolved.map((u) => u.orderId)).toEqual([buy!.orderId]);
    expect(report.journaledNotInLedger).toEqual([]);
  });

  it('duplicate delivery is recorded once; an asynchronous rejection closes the order; a foreign journal is refused', () => {
    const a = authorized();
    const b = broker(a.state);
    b.submit(submission(a));
    const [buy, sell] = a.plan.orders;
    const existing = b.journal()[0]!;
    const dup = b.deliver({ event: existing });
    expect(dup).toMatchObject({
      applied: false,
      duplicate: true,
      lateFill: false,
      events: [],
      fill: null,
    });
    expect(b.journal()).toHaveLength(4);
    const rejection = b.deliver({
      event: {
        eventId: 'paper:main:journal:external-2',
        journalId: 'paper:main:journal',
        timestampMs: NOW + 3_000,
        orderId: sell!.orderId,
        planHash: a.plan.contentHash,
        eventType: 'rejected',
        detail: { reason: 'venue: instrument halted' },
        sourceId: 'paper:main',
        provenance: {},
      },
    });
    expect(rejection.state).toMatchObject({
      state: 'rejected',
      reason: 'venue: instrument halted',
      terminal: true,
    });
    expect(b.openOrders().map((o) => o.orderId)).toEqual([buy!.orderId]);
    const foreign = failure(() =>
      b.deliver({ event: { ...existing, eventId: 'x', journalId: 'other' } }),
    );
    expect(foreign.code).toBe(ErrorCode.InputWrongShape);
    const invalid = failure(() =>
      b.deliver({
        event: { ...existing, eventId: 'y', eventType: 'submitted', detail: { quantity: 1 } },
      }),
    );
    expect(invalid.code).toBe(ErrorCode.TradeJournalTransitionInvalid);
  });

  it('kill switch: halt cancels every open order and refuses submits until resume', () => {
    const a = authorized();
    const b = broker(a.state);
    b.submit(submission(a));
    const halted = b.halt({ reason: 'operator kill switch', now: NOW + 2_000 });
    expect(halted.cancelled).toEqual([...a.plan.orders.map((o) => o.orderId)].sort());
    expect(halted.journal.map((e) => e.eventType)).toEqual([
      'cancel-requested',
      'cancelled',
      'cancel-requested',
      'cancelled',
    ]);
    expect(b.openOrders()).toEqual([]);
    expect(b.describe()).toMatchObject({ halted: true, haltReason: 'operator kill switch' });
    // the same economic intent submits once: a new rationale does not make a new order
    const sameIntent = authorized({ rationale: 'after the halt' });
    const other = authorized({
      orders: [{ instrumentId: 'BBB', side: 'buy', quantity: 150, type: 'market' }],
    });
    const refused = failure(() => b.submit(submission(other, 'run:2')));
    expect(refused.code).toBe(ErrorCode.TradeHalted);
    expect(b.resume({ now: NOW + 3_000 })).toEqual({ halted: false });
    expect(failure(() => b.submit(submission(sameIntent, 'run:2'))).code).toBe(
      ErrorCode.TradeIdempotencyConflict,
    );
    expect(b.submit(submission(other, 'run:2')).orders).toHaveLength(1);
  });

  it('continues from a prior journal and is deterministic', () => {
    const a = authorized();
    const first = broker(a.state);
    first.submit(submission(a));
    first.step({ observations: { BBB: bar('BBB', 50, 51, 49, 50.5) }, asOf: NOW + 60_000 });
    const resumed = broker(a.state, { journal: first.journal() });
    expect(resumed.state()).toEqual(first.state());
    expect(resumed.describe().eventCount).toBe(first.journal().length);
    expect(
      failure(() => broker(a.state, { journal: [{ ...first.journal()[0]!, journalId: 'other' }] }))
        .code,
    ).toBe(ErrorCode.InputWrongShape);
    const twin = broker(a.state);
    twin.submit(submission(a));
    twin.step({ observations: { BBB: bar('BBB', 50, 51, 49, 50.5) }, asOf: NOW + 60_000 });
    expect(twin.journal()).toEqual(first.journal());
    expect(twin.receipts()).toEqual(first.receipts());
  });
});

describe('Journey 4 — safe paper trade', () => {
  it('authorize → submit → timeout/retry, partial fill, cancellation, late fill → reconcile: one economic trade per intent, unresolved state visible', () => {
    const a = authorized();
    const capped = execution.declared({
      label: 'capped: 1% of bar volume per fill',
      costs: { commission: fees.none(), slippage: slippage.none(), participation: 0.01 },
    });
    const b = broker(a.state, { execution: capped });
    const [buy, sell] = a.plan.orders;
    // 1–2. authorize an exact plan hash with bounded slippage and expiry; submit with a key
    const receipt = b.submit(submission(a));
    // 3a. timeout/retry: the client did not see the receipt and retries the same key — no second order
    expect(b.submit(submission(a, 'run:1', NOW + 30_000))).toBe(receipt);
    // 3b. partial fill
    const partial = b.step({
      observations: { BBB: bar('BBB', 50, 51, 49, 50.5, NOW + 60_000, 10_000) },
      asOf: NOW + 60_000,
    });
    expect(partial.journal.map((e) => e.eventType)).toEqual(['partially-filled']);
    // 3c. cancellation of the remainder and of the sell
    b.cancel({ orderId: buy!.orderId, now: NOW + 90_000 });
    b.cancel({ orderId: sell!.orderId, now: NOW + 90_000 });
    // 3d. a late fill for the cancelled remainder arrives from the venue
    const late = b.deliver({
      event: {
        eventId: 'paper:main:journal:venue-late',
        journalId: 'paper:main:journal',
        timestampMs: NOW + 120_000,
        orderId: buy!.orderId,
        planHash: a.plan.contentHash,
        eventType: 'filled',
        detail: { fillId: 'venue:late', quantity: 100, pricePerUnit: 50.25 },
        sourceId: 'paper:main',
        provenance: {},
      },
    });
    expect(late.lateFill).toBe(true);
    // 4. reconcile journal, fills, cash, holdings
    let state = applyPortfolioEvents({ previousState: a.state, events: partial.events });
    state = applyPortfolioEvents({ previousState: state, events: late.events });
    const fills = [...partial.fills, late.fill!];
    const report = reconcileExecution({
      journal: b.journal(),
      ledger: state,
      sourceId: 'paper:main',
      fills,
      asOf: NOW + 180_000,
      tolerance: { quantity: 1e-9, cashAmount: 0.01 },
      planHash: a.plan.contentHash,
      external: {
        asOf: NOW + 180_000,
        accounts: {
          main: {
            cash: { USD: { total: 100_000 - 10_000 - 100 * 50 - 100 * 50.25 } },
            positions: [
              { instrumentId: 'AAA', quantity: 100, currency: 'USD' },
              { instrumentId: 'BBB', quantity: 200, currency: 'USD' },
            ],
          },
        },
      },
    });
    // no duplicate economic trade: 200 BBB bought once across the partial and the late fill
    expect(state.accounts['main']!.positions['BBB']!.quantity).toBe(200);
    expect(b.receipts()).toHaveLength(1);
    expect(report.journaledNotInLedger).toEqual([]);
    expect(report.ledgerNotJournaled).toEqual([]);
    expect(report.portfolio!.reconciled).toBe(true);
    // unresolved state remains visible
    expect(report.reconciled).toBe(false);
    expect(report.unresolved).toEqual([
      { orderId: buy!.orderId, reason: expect.stringContaining('late fill after cancelled') },
    ]);
  });
});

describe('fillOrderWithPolicy', () => {
  it('is the engine arithmetic: slippage, commission, and the normalized fill; an unfilled decision returns its reason', () => {
    const declared = execution.declared({
      label: 'bps costs',
      costs: { commission: fees.perShare(0.01), slippage: slippage.bps(10) },
    });
    const order = {
      orderId: 'o1',
      instrumentId: 'BBB',
      side: 'buy' as const,
      quantity: 100,
      type: 'market' as const,
      submittedTimestampMs: NOW,
    };
    const filled = fillOrderWithPolicy({
      policy: declared,
      order,
      observation: bar('BBB', 50, 51, 49, 50.5),
      asOf: NOW,
      accountId: 'main',
      currency: 'USD',
      fillId: 'f1',
    });
    expect(filled.outcome).toBe('filled');
    if (filled.outcome !== 'filled') throw new Error('unreachable');
    expect(filled.price).toBeCloseTo(50 * 1.001, 12);
    expect(filled.commission).toBeCloseTo(1, 12);
    expect(filled.slippageAdjustment).toBeCloseTo(0.05 * 100, 9);
    expect(filled.fill).toMatchObject({
      fillId: 'f1',
      orderId: 'o1',
      quantity: 100,
      currency: 'USD',
      costs: { commission: 1 },
    });
    const unfilled = fillOrderWithPolicy({
      policy: declared,
      order: { ...order, type: 'limit', limitPrice: 40 },
      observation: bar('BBB', 50, 51, 49, 50.5),
      asOf: NOW,
      accountId: 'main',
      currency: 'USD',
      fillId: 'f2',
    });
    expect(unfilled).toMatchObject({ outcome: 'unfilled', reason: 'not-triggered' });
    expect(
      failure(() =>
        fillOrderWithPolicy({
          policy: declared,
          order,
          observation: { kind: 'bar' } as never,
          asOf: NOW,
          accountId: 'main',
          currency: 'USD',
          fillId: 'f3',
        }),
      ).message,
    ).toContain('observation');
    expect(
      failure(() =>
        fillOrderWithPolicy({
          policy: declared,
          order,
          observation: bar('BBB', 50, 51, 49, 50.5),
          asOf: NOW,
          accountId: 'main',
          currency: 'USD',
          fillId: 'f3',
          extra: 1,
        } as never),
      ).message,
    ).toContain('extra');
  });
});

describe('the paper broker never fills an OCC option symbol at the share multiplier', () => {
  const OCC = 'AAPL260918C00200000';
  const optionMarket = () =>
    createMarketSnapshot({
      asOf: NOW,
      observations: {
        spots: {
          AAA: { price: 110, currency: 'USD' },
          BBB: { price: 50, currency: 'USD' },
          [OCC]: { price: 4.1, currency: 'USD' },
        },
      },
    });
  const authorizedOption = () => {
    const state = ledger().state;
    const instruments = { [OCC]: { currency: 'USD', contractMultiplier: 100 } };
    const plan = normalizeTradePlan({
      intent: intent({ orders: [{ instrumentId: OCC, side: 'buy', quantity: 2, type: 'market' }] }),
      portfolio: state,
      market: optionMarket(),
      asOf: NOW,
      instruments,
    });
    const preflight = preflightTradePlan({
      plan,
      portfolio: state,
      market: optionMarket(),
      asOf: NOW,
      policy: policy(),
      instruments,
    });
    const grant = createAuthorizationGrant({
      plan,
      preflight,
      marketMaximumAgeMs: DAY,
      mode: 'paper',
      variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
      expiresAt: NOW + DAY,
      approvedBy: 'trey',
      idempotencyKeys: { prefix: 'run', count: 3 },
      now: NOW,
    });
    return { state, plan, preflight, grant };
  };

  it('refuses OCC-keyed instrument terms that omit the multiplier at creation', () => {
    const refusal = failure(() =>
      createPaperBroker({
        baseCurrency: 'USD',
        sourceId: 'paper:main',
        accountId: 'main',
        instruments: { [OCC]: { currency: 'USD' } },
      }),
    );
    expect(refusal.code).toBe(ErrorCode.InputMissingField);
    expect(refusal.message).toContain(`input.instruments["${OCC}"].contractMultiplier`);
    expect(refusal.message).toContain('described without a contract multiplier');
  });

  it('refuses to submit an OCC order the broker has no terms for, before journaling anything', () => {
    const a = authorizedOption();
    const b = broker(a.state);
    const refusal = failure(() => b.submit(submission(a)));
    expect(refusal.code).toBe(ErrorCode.InputMissingField);
    expect(refusal.message).toContain(`input.instruments["${OCC}"].contractMultiplier`);
    expect(refusal.message).toContain('with no instrument terms');
    expect(b.journal()).toEqual([]);
  });

  it('fills at the declared multiplier once the terms say so', () => {
    const a = authorizedOption();
    const b = broker(a.state, {
      instruments: {
        AAA: { currency: 'USD' },
        [OCC]: { currency: 'USD', contractMultiplier: 100 },
      },
    });
    b.submit(submission(a));
    const step = b.step({
      observations: { [OCC]: bar(OCC, 4.1, 4.2, 4.0, 4.1) },
      asOf: NOW + 1_000,
    });
    expect(step.fills).toHaveLength(1);
    expect(step.fills[0]).toMatchObject({ quantity: 2, contractMultiplier: 100 });
  });
});
