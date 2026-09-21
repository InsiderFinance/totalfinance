/** R06/R07: durable paper order state and accounting identity, with independent economic checks. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { contentHash, createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  portfolioEventsFromFill,
} from '@totalfinance/portfolio';
import {
  applyJournalEvents,
  createAuthorizationGrant,
  normalizeTradePlan,
  preflightTradePlan,
  requireExecutionJournalEvent,
  type ExecutionJournalEvent,
  type TradeIntentOrder,
} from '@totalfinance/portfolio/trade';
import {
  execution,
  fees,
  fillModels,
  type ExecutionPolicy,
  type MarketObservation,
} from '@totalfinance/backtest/execution';
import {
  createPaperBroker,
  type CreatePaperBrokerInput,
  type ExecutionReceipt,
  type PaperBroker,
  type PaperStepResult,
} from '@totalfinance/backtest/paper';

const NOW = Date.UTC(2026, 8, 1, 14);
const DAY = 86_400_000;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const market = createMarketSnapshot({
  asOf: NOW,
  observations: {
    spots: { AAA: { price: 100, currency: 'USD' }, BBB: { price: 100, currency: 'USD' } },
  },
});
const ledger = createPortfolioLedger({
  portfolioId: 'primary',
  baseCurrency: 'USD',
  events: [
    {
      eventId: 'deposit',
      schemaVersion: 1,
      sourceId: 'fixture',
      accountId: 'main',
      effectiveTimestampMs: NOW - DAY,
      recordedTimestampMs: NOW - DAY,
      eventType: 'cash.deposit',
      event: { eventType: 'cash.deposit', currency: 'USD', amount: 100_000 },
      provenance: {},
    },
  ],
});
const order = (overrides: Partial<TradeIntentOrder> = {}): TradeIntentOrder => ({
  instrumentId: 'AAA',
  side: 'buy',
  quantity: 12,
  type: 'market',
  timeInForce: 'gtc',
  ...overrides,
});
const authorized = (orders = [order()], key = 'run:1') => {
  const plan = normalizeTradePlan({
    intent: {
      kind: 'totalfinance.trade-intent',
      schemaVersion: 1,
      accountId: 'main',
      asOf: NOW,
      orders,
    },
    portfolio: ledger.state,
    market,
    asOf: NOW,
  });
  const preflight = preflightTradePlan({
    plan,
    portfolio: ledger.state,
    market,
    asOf: NOW,
    policy: { mode: 'paper' },
  });
  const grant = createAuthorizationGrant({
    plan,
    preflight,
    now: NOW,
    expiresAt: NOW + DAY,
    marketMaximumAgeMs: DAY,
    mode: 'paper',
    variance: { maximumQuantityRatio: 0.2, maximumNotionalRatio: 0.2, maximumSlippageBps: 100 },
    approvedBy: 'test-operator',
    idempotencyKeys: { prefix: 'run', count: 4 },
  });
  return {
    plan,
    grant,
    now: NOW,
    idempotencyKey: key,
    portfolioHash: preflight.portfolioHash,
    marketHash: preflight.marketHash,
    marketAsOf: NOW,
  };
};
const capped = () =>
  execution.declared({ label: 'quarter volume', costs: { participation: 0.25 } });
const broker = (extra: Partial<CreatePaperBrokerInput> = {}) =>
  createPaperBroker({
    baseCurrency: 'USD',
    accountId: 'main',
    sourceId: 'paper:main',
    ...extra,
  });
const restart = (previous: PaperBroker, extra: Partial<CreatePaperBrokerInput> = {}) =>
  broker({ journal: clone(previous.journal()), ...extra });
const bar = (timestampMs: number, price = 100): MarketObservation => ({
  kind: 'bar',
  bar: {
    symbol: 'AAA',
    timestampMs,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 20,
  },
});
const step = (asOf: number, price = 100) => ({ asOf, observations: { AAA: bar(asOf, price) } });
const delivered = (
  submission: ReturnType<typeof authorized>,
  overrides: Partial<ExecutionJournalEvent> = {},
): ExecutionJournalEvent => ({
  eventId: 'venue:event:1',
  journalId: 'paper:main:journal',
  sourceId: 'paper:main',
  orderId: submission.plan.orders[0]!.orderId,
  planHash: submission.plan.contentHash,
  timestampMs: NOW + 3,
  eventType: 'filled',
  detail: { quantity: 12, pricePerUnit: 100, fillId: 'venue:fill:1' },
  provenance: {},
  ...overrides,
});

describe('paper journal restoration (R06)', () => {
  it('resumes a submission made without observations with identical receipt and honest open listings', () => {
    const request = authorized();
    const first = broker();
    const receipt = first.submit(request);
    const next = restart(first);
    expect(next.submit({ ...request, now: NOW + 2 * DAY })).toEqual(receipt);
    expect(next.openOrders()).toEqual(first.openOrders());
    expect(next.describe().openOrderCount).toBe(1);
    const result = next.step(step(NOW + 2 * DAY));
    expect(result.fills[0]).toMatchObject({ quantity: 12, pricePerUnit: 100 });
    expect(result.open).toEqual([]);
    expect(next.openOrders()).toEqual([]);
  });

  it('resumes an unmatched limit and retains its price, side, type and accepted timestamp', () => {
    const request = authorized([order({ type: 'limit', limitPrice: 90 })]);
    const first = broker();
    first.submit(request);
    expect(first.step(step(NOW + 1)).fills).toEqual([]);
    const next = restart(first);
    expect(next.step({ observations: {}, asOf: NOW + 2 }).open).toEqual([
      request.plan.orders[0]!.orderId,
    ]);
    expect(next.step(step(NOW + 3, 90)).fills[0]).toMatchObject({
      quantity: 12,
      side: 'buy',
      pricePerUnit: 90,
    });
  });

  it('consumes each observation once across partial fills and retries, returning only new accounting events', () => {
    const request = authorized();
    const first = broker({ execution: capped() });
    const receipt = first.submit(request);
    const partial = first.step(step(NOW + 1));
    const next = restart(first, { execution: capped() });
    expect(next.submit(request)).toEqual(receipt);
    for (const input of [
      step(NOW + 1),
      { ...step(NOW + 1), asOf: NOW + 2 },
      { asOf: NOW + 2, observations: { AAA: bar(NOW, 90) } },
    ]) {
      const retry = next.step(input);
      expect(retry.fills).toEqual([]);
      expect(retry.events).toEqual([]);
      expect(retry.journal).toEqual([]);
      expect(retry.unfilled[0]!.reason).toBe('already-observed');
      expect(retry.open).toHaveLength(1);
    }
    const second = next.step(step(NOW + 3));
    const last = restart(next, { execution: capped() });
    expect(last.step(step(NOW + 1))).toMatchObject({ fills: [], events: [], journal: [] });
    const third = last.step(step(NOW + 4));
    expect([partial, second, third].map((result) => result.fills[0]!.quantity)).toEqual([5, 5, 2]);
    const events = [partial, second, third].flatMap((result) => result.events);
    const account = applyPortfolioEvents({ previousState: ledger.state, events }).accounts['main']!;
    expect(account.positions['AAA']!.quantity).toBe(12);
    expect(last.openOrders()).toEqual([]);
    // Every returned accounting fact can also be recovered exactly after a lost response.
    const recovered = last.journal().flatMap((event) =>
      event.detail.fill === undefined
        ? []
        : portfolioEventsFromFill({
            fill: event.detail.fill,
            sourceId: event.sourceId,
            recordedTimestampMs: event.timestampMs,
          }),
    );
    expect(recovered).toEqual(events);
    expect(
      applyPortfolioEvents({ previousState: ledger.state, events: [...events, ...recovered] }),
    ).toEqual(applyPortfolioEvents({ previousState: ledger.state, events }));
  });

  it.each(['quote', 'order-book'] as const)(
    'restores partial %s fills without reusing snapshot liquidity',
    (kind) => {
      const policy = execution.declared({
        label: `${kind} quarter volume`,
        observation: kind,
        costs: { participation: 0.25 },
      });
      const observation = (timestampMs: number): MarketObservation =>
        kind === 'quote'
          ? {
              kind,
              quote: { symbol: 'AAA', timestampMs, bid: 99, ask: 100, bidSize: 20, askSize: 20 },
            }
          : {
              kind,
              book: {
                symbol: 'AAA',
                timestampMs,
                bids: [{ price: 99, size: 20 }],
                asks: [{ price: 100, size: 20 }],
              },
            };
      const first = broker({ execution: policy });
      first.submit(authorized());
      const input = { asOf: NOW + 1, observations: { AAA: observation(NOW + 1) } };
      expect(first.step(input).fills[0]!.quantity).toBe(5);
      const next = restart(first, { execution: policy });
      expect(next.step({ ...input, asOf: NOW + 2 }).fills).toEqual([]);
      expect(
        next.step({ asOf: NOW + 3, observations: { AAA: observation(NOW + 3) } }).fills[0]!
          .quantity,
      ).toBe(5);
    },
  );

  it.each(['open', 'partial'] as const)(
    'expires a restored %s day order before meeting the next observation',
    (status) => {
      const first = broker({ execution: capped() });
      const request = authorized([order({ timeInForce: 'day' })]);
      first.submit(request);
      if (status === 'partial') first.step(step(NOW + 1));
      const next = restart(first, { execution: capped() });
      const expired = next.step(step(NOW + DAY));
      expect(expired.expired).toEqual([request.plan.orders[0]!.orderId]);
      expect(expired.fills).toEqual([]);
      expect(expired.open).toEqual([]);
      expect(
        restart(next, { execution: capped() }).state().orders[request.plan.orders[0]!.orderId]!
          .state,
      ).toBe('expired');
    },
  );

  it('honors disabled day expiration and does not turn a persisted gtc into a day order', () => {
    const policy = execution.declared({
      label: 'no automatic expiry',
      timeInForce: { default: 'day', expireAtSessionClose: false },
    });
    const first = broker({ execution: policy });
    first.submit(authorized([order({ timeInForce: 'day' })]));
    expect(restart(first, { execution: policy }).step(step(NOW + 2 * DAY)).fills).toHaveLength(1);
  });

  it('cancels a restored partial remainder exactly once; late fills after restart still reach the ledger', () => {
    const request = authorized();
    const first = broker({ execution: capped() });
    first.submit(request);
    const partial = first.step(step(NOW + 1));
    const next = restart(first, { execution: capped() });
    const cancel = { orderId: request.plan.orders[0]!.orderId, now: NOW + 2 };
    expect(next.cancel(cancel).accepted).toBe(true);
    const last = restart(next, { execution: capped() });
    expect(last.cancel(cancel)).toMatchObject({ accepted: false, journal: [] });
    expect(last.step(step(NOW + 3)).fills).toEqual([]);
    const event = delivered(request, {
      detail: { quantity: 7, pricePerUnit: 101, fillId: 'venue:remainder' },
    });
    const late = last.deliver({ event });
    expect(late).toMatchObject({
      lateFill: true,
      fill: { side: 'buy', instrumentId: 'AAA', quantity: 7 },
    });
    const restored = restart(last, { execution: capped() });
    expect(restored.deliver({ event })).toMatchObject({ duplicate: true, fill: null, events: [] });
    expect(restored.openOrders()).toEqual([]);
    expect(restored.describe().openOrderCount).toBe(0);
    expect(restored.state().orders[cancel.orderId]).toMatchObject({
      state: 'unresolved',
      terminal: true,
      filledQuantity: 12,
    });
    expect(
      applyPortfolioEvents({
        previousState: ledger.state,
        events: [...partial.events, ...late.events],
      }).accounts['main']!.positions['AAA']!.quantity,
    ).toBe(12);
  });

  it('preserves instrument currency, multiplier, derivative contract and settlement lag without resupplying them', () => {
    const request = authorized();
    const instrument = {
      currency: 'CAD',
      contractMultiplier: 100,
      settlementLag: 2 as const,
      contract: {
        kind: 'option' as const,
        underlyingInstrumentId: 'STOCK',
        type: 'call' as const,
        strikePricePerUnit: 100,
        expiryTimestampMs: NOW + 30 * DAY,
      },
    };
    const first = broker({ instruments: { AAA: instrument } });
    first.submit(request);
    instrument.currency = 'EUR'; // caller-owned objects cannot mutate an accepted order
    const next = restart(first);
    const fill = next.step(step(NOW + 1)).fills[0]!;
    expect(fill).toMatchObject({
      currency: 'CAD',
      contractMultiplier: 100,
      contract: instrument.contract,
      settleTimestampMs: NOW + 1 + 2 * DAY,
    });
    expect(() => restart(first, { instruments: { AAA: { currency: 'USD' } } })).toThrow(
      /persisted terms/,
    );
    expect(() => restart(first, { accountId: 'other' })).toThrow(/account/);
    expect(() => restart(first, { baseCurrency: 'EUR' })).toThrow(/base currency/);
  });

  it('uses the persisted instrument lag and normalized costs on a late delivery after expiry', () => {
    const request = authorized([order({ timeInForce: 'day' })]);
    const first = broker({ instruments: { AAA: { currency: 'USD', settlementLag: 2 } } });
    first.submit(request);
    first.step({ asOf: NOW + DAY, observations: {} });
    const next = restart(first);
    const event = delivered(request, { timestampMs: NOW + DAY + 1 });
    event.detail.fill = {
      fillId: event.detail.fillId!,
      orderId: event.orderId,
      accountId: 'main',
      instrumentId: 'AAA',
      side: 'buy',
      currency: 'USD',
      quantity: 12,
      pricePerUnit: 100,
      filledTimestampMs: event.timestampMs,
      settleTimestampMs: NOW + 3 * DAY + 1,
      costs: { commission: 3 },
    };
    const late = next.deliver({ event });
    expect(late.lateFill).toBe(true);
    expect(late.fill!.settleTimestampMs).toBe(NOW + 3 * DAY + 1);
    expect(late.fill!.costs!.commission).toBe(3);
    expect(late.events).toHaveLength(2);
    expect(restart(next).deliver({ event }).duplicate).toBe(true);
    const corrupt = clone(next.journal());
    corrupt.at(-1)!.detail.fill!.currency = 'EUR';
    expect(() => broker({ journal: corrupt })).toThrow(/submitted instrument/);
  });

  it('refuses incomplete legacy submitted/fill records instead of discarding outstanding state', () => {
    const first = broker();
    first.submit(authorized());
    for (const field of [
      'order',
      'instrument',
      'accountId',
      'baseCurrency',
      'executionPolicyHash',
      'artifactHash',
      'note',
    ] as const) {
      const journal = clone(first.journal());
      delete journal[0]!.detail[field];
      expect(() => broker({ journal })).toThrow(/incomplete/);
    }
    first.step(step(NOW + 1));
    const journal = clone(first.journal());
    delete journal[2]!.detail.fill;
    expect(() => broker({ journal })).toThrow(/incomplete paper fill/);
  });

  it('requires matching declared callback identity and full session data, not only counts or labels', () => {
    const original = execution.declared({
      label: 'custom',
      costs: { commission: fees.perShare(0.1) },
      sessions: { halts: [{ fromTimestampMs: NOW + DAY, toTimestampMs: NOW + 2 * DAY }] },
    });
    const first = broker({ execution: original });
    first.submit(authorized());
    expect(() => restart(first)).toThrow(/same declared policy identity/);
    for (const changed of [
      execution.declared({
        label: 'custom',
        costs: { commission: fees.perShare(0.2) },
        sessions: original.sessions!,
      }),
      execution.declared({
        label: 'custom',
        costs: original.costs,
        sessions: { halts: [{ fromTimestampMs: NOW + 3 * DAY, toTimestampMs: NOW + 4 * DAY }] },
      }),
      { ...original, fill: { ...original.fill, version: 'different-version' } },
    ])
      expect(() => restart(first, { execution: changed })).toThrow(/same declared policy identity/);
    expect(
      restart(first, { execution: original }).step(step(NOW + 1)).fills[0]!.costs!.commission,
    ).toBeCloseTo(1.2);
  });

  it('binds retries to submitted overrides instead of silently amending remaining quantity', () => {
    const request = authorized();
    const first = broker();
    const orders = request.plan.orders.map((row) => ({ ...row, quantity: 11 }));
    const receipt = first.submit({ ...request, orders });
    const next = restart(first);
    expect(next.submit({ ...request, orders })).toEqual(receipt);
    expect(() => next.submit({ ...request, orders: request.plan.orders })).toThrow(/cannot amend/);
    expect(next.step(step(NOW + 1)).fills[0]!.quantity).toBe(11);
  });

  it('halt cancellation survives restart but the process-local halt flag does not claim durable account protection', () => {
    const request = authorized();
    const first = broker();
    first.submit(request);
    const next = restart(first);
    expect(next.halt({ reason: 'operator', now: NOW + 1 }).cancelled).toHaveLength(1);
    expect(() => next.submit(request)).toThrow(/halted/);
    const last = restart(next);
    expect(last.describe()).toMatchObject({ halted: false, openOrderCount: 0 });
    expect(last.step(step(NOW + 2)).fills).toEqual([]);
    expect(last.resume({ now: NOW + 3 })).toEqual({ halted: false });
    expect(last.openOrders()).toEqual([]);
    const empty = broker();
    empty.halt({ reason: 'operator', now: NOW });
    expect(empty.journal()).toEqual([]);
    expect(restart(empty).describe().halted).toBe(false);
  });
});

describe('durable identities and atomic hazards (R07)', () => {
  it('allocates distinct fill/event identities across independent processes, new plans and partial retries', () => {
    const run = (
      request: ReturnType<typeof authorized>,
      at: number,
      journal: ExecutionJournalEvent[] = [],
    ) => {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(new URL('./paper-restart-worker.ts', import.meta.url))],
        {
          cwd: fileURLToPath(new URL('../../../', import.meta.url)),
          encoding: 'utf8',
          input: JSON.stringify({ journal, submit: request, step: step(at) }),
        },
      );
      expect(child.stderr).toBe('');
      expect(child.status).toBe(0);
      return JSON.parse(child.stdout) as {
        receipt: ExecutionReceipt;
        result: PaperStepResult;
        journal: ExecutionJournalEvent[];
      };
    };
    const request = authorized();
    const first = run(request, NOW + 1);
    const retry = run(request, NOW + 1, first.journal);
    expect(retry.result.fills).toEqual([]);
    expect(retry.receipt).toEqual(first.receipt);
    const second = run(request, NOW + 2, retry.journal);
    const third = run(request, NOW + 3, second.journal);
    const other = run(authorized([order({ quantity: 4 })], 'run:2'), NOW + 4, third.journal);
    const fills = [first, second, third, other].flatMap((result) => result.result.fills);
    expect(fills.map((fill) => fill.fillId)).toEqual(
      [1, 2, 3, 4].map((n) => `paper:main:fill:${n}`),
    );
    expect(new Set(other.journal.map((event) => event.eventId)).size).toBe(other.journal.length);
    const events = [first, second, third, other].flatMap((result) => result.result.events);
    expect(
      applyPortfolioEvents({ previousState: ledger.state, events }).accounts['main']!.positions[
        'AAA'
      ]!.quantity,
    ).toBe(16);
  });

  it('advances past external numeric identities and duplicate journal deliveries, not journal length', () => {
    const request = authorized();
    const first = broker();
    first.submit(request);
    first.deliver({
      event: delivered(request, {
        eventId: 'paper:main:journal:900',
        detail: { fillId: 'paper:main:fill:700', quantity: 12, pricePerUnit: 100 },
      }),
    });
    const next = broker({ journal: [...first.journal(), first.journal()[0]!] });
    next.submit(authorized([order({ quantity: 3 })], 'run:2'));
    const result = next.step(step(NOW + 4));
    expect(result.fills[0]!.fillId).toBe('paper:main:fill:701');
    expect(result.journal[0]!.eventId).toBe('paper:main:journal:903');
    expect(next.receipts()).toHaveLength(2);
  });

  it('refuses different-body event-id collisions and journal-wide reused fill ids without mutation', () => {
    const request = authorized([order(), order({ instrumentId: 'BBB' })]);
    const first = broker();
    first.submit(request);
    const before = first.journal();
    expect(() =>
      first.deliver({
        event: { ...before[0]!, detail: { ...before[0]!.detail, note: 'altered' } },
      }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.TradeIdempotencyConflict }));
    expect(first.journal()).toEqual(before);
    first.deliver({ event: delivered(request) });
    const duplicate = delivered(request, {
      orderId: request.plan.orders[1]!.orderId,
      eventId: 'venue:event:2',
    });
    expect(() => first.deliver({ event: duplicate })).toThrow(/already journaled/);
    expect(() => applyJournalEvents({ events: [...first.journal(), duplicate] })).toThrow(
      /already journaled/,
    );
    expect(first.openOrders()).toHaveLength(1);
  });

  it('refuses unpriced/mismatched deliveries before journaling and accepts a corrected retry', () => {
    const request = authorized();
    const first = broker();
    first.submit(request);
    const before = first.journal();
    const event = delivered(request);
    const unpriced = clone(event);
    delete unpriced.detail.pricePerUnit;
    expect(() => first.deliver({ event: unpriced })).toThrow(/pricePerUnit/);
    expect(first.journal()).toEqual(before);
    const result = first.deliver({ event });
    expect(result.fill).not.toBeNull();
    const bad = clone(first.journal().at(-1)!);
    bad.detail.fill!.quantity = 11;
    expect(() => requireExecutionJournalEvent('test', 'event', bad)).toThrow(/must match/);
    expect(result.events).toHaveLength(1);
  });

  it('a later fill-model failure does not remove an earlier order from the live open map', () => {
    const base = fillModels.bar();
    let fail = true;
    let count = 0;
    const policy: ExecutionPolicy = execution.declared({
      label: 'test failure',
      fill: {
        ...base,
        label: 'test failure',
        fill: (request) => {
          count += 1;
          if (fail && count === 2) throw new Error('fixture fill failure');
          return base.fill(request);
        },
      },
    });
    const request = authorized([order(), order({ instrumentId: 'BBB' })]);
    const first = broker({ execution: policy });
    first.submit(request);
    const before = first.journal();
    const input = {
      asOf: NOW + 1,
      observations: {
        AAA: bar(NOW + 1),
        BBB: {
          kind: 'bar' as const,
          bar: {
            ...(bar(NOW + 1) as Extract<MarketObservation, { kind: 'bar' }>).bar,
            symbol: 'BBB',
          },
        },
      },
    };
    expect(() => first.step(input)).toThrow('fixture fill failure');
    expect(first.journal()).toEqual(before);
    expect(first.describe().openOrderCount).toBe(2);
    expect(first.openOrders()).toHaveLength(2);
    fail = false;
    expect(first.step(input).fills).toHaveLength(2);
  });

  it('refuses future observations and backwards step/cancel/halt clocks without losing open state', () => {
    const request = authorized();
    const first = broker({ execution: capped() });
    first.submit(request);
    expect(() => first.step({ ...step(NOW + 1), asOf: NOW })).toThrow(/after input.asOf/);
    first.step(step(NOW + 2));
    const before = first.journal();
    expect(() => first.step({ observations: {}, asOf: NOW + 1 })).toThrow(/precedes/);
    expect(() => first.cancel({ orderId: request.plan.orders[0]!.orderId, now: NOW + 1 })).toThrow(
      /precedes/,
    );
    expect(() => first.halt({ reason: 'operator', now: NOW + 1 })).toThrow(/precedes/);
    expect(first.journal()).toEqual(before);
    expect(first.describe().openOrderCount).toBe(1);
  });

  it('validates closed persisted instrument/order/observation fields', () => {
    const first = broker();
    first.submit(authorized());
    const event = first.journal()[0]!;
    for (const detail of [
      { ...event.detail, instrument: { currency: 'USD', settlementLag: 3 } },
      { ...event.detail, instrument: { currency: 'USD', surprise: true } },
      {
        ...event.detail,
        instrument: {
          currency: 'USD',
          contractMultiplier: 100,
          contract: {
            kind: 'option',
            underlyingInstrumentId: 'AAA',
            type: 'call',
            strikePricePerUnit: 100,
            expiryTimestampMs: NOW + DAY,
            surprise: true,
          },
        },
      },
      { ...event.detail, order: { ...event.detail.order, orderId: 'different' } },
    ])
      expect(() => requireExecutionJournalEvent('test', 'event', { ...event, detail })).toThrow();
    first.step(step(NOW + 1));
    const fill = first.journal().at(-1)!;
    expect(() =>
      requireExecutionJournalEvent('test', 'event', {
        ...fill,
        detail: { ...fill.detail, observationTimestampMs: NOW + 2 },
      }),
    ).toThrow(/no later/);
    expect(() => broker({ journal: [{ ...event, sourceId: 'foreign' }] })).toThrow();
    expect(contentHash(first.journal())).toBe(contentHash(restart(first).journal()));
  });
});
