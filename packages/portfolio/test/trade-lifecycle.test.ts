/**
 * Stage 7B.2 (AT5) slice 2 — the authorization grant, the execution journal, reconciliation.
 * Every check here is the contract's: a grant binds the plan, the preflight, the snapshots, the
 * mode, the account, the variance, the expiry, and the key set; the journal's transition table is
 * enforced with late fills and duplicate deliveries handled; reconciliation joins the journal to the
 * ledger's fills and composes reconcilePortfolio verbatim.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { contentHash, createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  type ExternalPortfolioSnapshot,
  type NormalizedFill,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';
import {
  applyJournalEvents,
  AUTHORIZATION_GRANT_KIND,
  createAuthorizationGrant,
  EXECUTION_JOURNAL_EVENT_CEILING,
  type ExecutionJournalEvent,
  type ExecutionJournalEventType,
  type ExecutionJournalDetail,
  journalOrderStates,
  normalizeTradePlan,
  preflightTradePlan,
  RECONCILIATION_REPORT_KIND,
  reconcileExecution,
  requireAuthorizationGrant,
  requireExecutionJournalEvent,
  type TradeIntent,
  type TradePolicy,
  verifyAuthorizationGrant,
} from '@totalfinance/portfolio/trade';

const T0 = Date.UTC(2026, 0, 5, 21);
const DAY = 86_400_000;
const NOW = T0 + 2 * DAY;
const envelope = (
  eventId: string,
  at: number,
  event: Record<string, unknown>,
  sourceId = 'fixture',
  correlationId?: string,
): PortfolioEventEnvelope =>
  ({
    eventId,
    schemaVersion: 1,
    eventType: event['eventType'],
    sourceId,
    accountId: 'main',
    effectiveTimestampMs: at,
    recordedTimestampMs: at,
    ...(correlationId === undefined ? {} : { correlationId }),
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

const setup = (overrides: Partial<TradeIntent> = {}) => {
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
    costs: { commissionBps: 5, slippageBps: 10 },
  });
  return { state, plan, preflight };
};
const grantInput = (s: ReturnType<typeof setup>) => ({
  plan: s.plan,
  preflight: s.preflight,
  marketMaximumAgeMs: DAY,
  mode: 'paper' as const,
  variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
  expiresAt: NOW + DAY,
  approvedBy: 'trey',
  idempotencyKeys: { prefix: 'run', count: 3 },
  now: NOW,
});
const verifyInput = (
  s: ReturnType<typeof setup>,
  grant: ReturnType<typeof createAuthorizationGrant>,
) => ({
  grant,
  plan: s.plan,
  now: NOW + 1_000,
  portfolioHash: s.preflight.portfolioHash,
  marketHash: s.preflight.marketHash,
  marketAsOf: NOW,
  idempotencyKey: 'run:1',
});

describe('createAuthorizationGrant', () => {
  it('binds the plan, the preflight, the snapshots, the account, the variance, the expiry, and the key set', () => {
    const s = setup();
    const grant = createAuthorizationGrant(grantInput(s));
    expect(grant.kind).toBe(AUTHORIZATION_GRANT_KIND);
    expect(grant.planHash).toBe(s.plan.contentHash);
    expect(grant.preflightHash).toBe(s.preflight.contentHash);
    expect(grant.portfolioHash).toBe(s.preflight.portfolioHash);
    expect(grant.marketHash).toBe(s.preflight.marketHash);
    expect(grant.marketAsOf).toBe(NOW);
    expect(grant.accountId).toBe('main');
    expect(grant.orderIds).toEqual(s.plan.orders.map((o) => o.orderId));
    expect(grant.idempotencyKeys).toEqual(['run:1', 'run:2', 'run:3']);
    expect(grant.requiredScope).toBeNull();
    expect(grant.grantId).toBe(`grant:${s.plan.contentHash.slice(0, 16)}:${NOW}`);
    const { contentHash: declared, ...body } = grant;
    expect(declared).toBe(contentHash(body));
    expect(Object.isFrozen(grant.variance)).toBe(true);
    expect(requireAuthorizationGrant('t', 'grant', grant)).toBe(grant);
    // the same inputs mint the same grant
    expect(createAuthorizationGrant(grantInput(s))).toEqual(grant);
  });

  it('carries the approval scope a require-approval preflight asked for', () => {
    const state = ledger().state;
    const plan = normalizeTradePlan({
      intent: intent(),
      portfolio: state,
      market: market(),
      asOf: NOW,
    });
    const preflight = preflightTradePlan({
      plan,
      portfolio: state,
      market: market(),
      asOf: NOW,
      policy: policy({ requireApprovalAbove: { notional: 5_000 } }),
    });
    expect(preflight.decision.verdict).toBe('require-approval');
    const grant = createAuthorizationGrant(grantInput({ state, plan, preflight }));
    expect(grant.requiredScope).toBe('trade:approve');
  });

  it('refuses a denied preflight, a plan the preflight did not judge, a stale expiry, live, and a foreign account', () => {
    const s = setup();
    const denied = preflightTradePlan({
      plan: s.plan,
      portfolio: s.state,
      market: market(),
      asOf: NOW,
      policy: policy({ maximumOrderNotional: 1_000 }),
    });
    expect(denied.decision.verdict).toBe('deny');
    const deniedRefusal = failure(() =>
      createAuthorizationGrant({ ...grantInput(s), preflight: denied }),
    );
    expect(deniedRefusal.code).toBe(ErrorCode.TradePreflightDenied);
    expect(deniedRefusal.message).toMatch(/failed: .*notional/);
    const other = setup({ rationale: 'another plan' });
    const mismatch = failure(() =>
      createAuthorizationGrant({ ...grantInput(s), plan: other.plan }),
    );
    expect(mismatch.code).toBe(ErrorCode.TradeGrantInvalid);
    expect(mismatch.message).toContain('planHash');
    const expired = failure(() => createAuthorizationGrant({ ...grantInput(s), expiresAt: NOW }));
    expect(expired.code).toBe(ErrorCode.TradeGrantExpired);
    const live = failure(() =>
      createAuthorizationGrant({ ...grantInput(s), mode: 'live' as never }),
    );
    expect(live.code).toBe(ErrorCode.TradeLiveUnavailable);
    const account = failure(() => createAuthorizationGrant({ ...grantInput(s), account: 'other' }));
    expect(account.code).toBe(ErrorCode.TradeGrantInvalid);
    const portfolioHash = failure(() =>
      createAuthorizationGrant({ ...grantInput(s), portfolioHash: 'sha256:other' }),
    );
    expect(portfolioHash.code).toBe(ErrorCode.TradeGrantInvalid);
    expect(
      failure(() => createAuthorizationGrant({ ...grantInput(s), idempotencyKeys: [] })).message,
    ).toContain('at least one');
    expect(
      failure(() => createAuthorizationGrant({ ...grantInput(s), idempotencyKeys: ['a', 'a'] }))
        .message,
    ).toContain('duplicates');
    expect(
      failure(() =>
        createAuthorizationGrant({
          ...grantInput(s),
          variance: { maximumQuantityRatio: -1 } as never,
        }),
      ).message,
    ).toContain('variance');
    expect(
      failure(() => createAuthorizationGrant({ ...grantInput(s), extra: 1 } as never)).message,
    ).toContain('extra');
    // a tampered grant is refused at the door
    const grant = createAuthorizationGrant(grantInput(s));
    const tampered = { ...grant, expiresAt: grant.expiresAt + DAY };
    expect(failure(() => requireAuthorizationGrant('t', 'grant', tampered)).message).toContain(
      'contentHash',
    );
  });
});

describe('verifyAuthorizationGrant', () => {
  it('requires full plan membership even for independent orders; an empty submission never consumes authority', () => {
    const s = setup();
    const grant = createAuthorizationGrant(grantInput(s));
    const omitted = verifyAuthorizationGrant({
      ...verifyInput(s, grant),
      orders: [s.plan.orders[0]!],
    });
    expect(omitted.valid).toBe(false);
    expect(omitted.reasons).toContainEqual(
      expect.objectContaining({ reason: 'order-mismatch', orderId: s.plan.orders[1]!.orderId }),
    );
    expect(() => verifyAuthorizationGrant({ ...verifyInput(s, grant), orders: [] })).toThrowError(
      expect.objectContaining({ code: ErrorCode.InputOutOfRange }),
    );
  });
  it('does not treat execution type or time-in-force changes as quantity variance', () => {
    const s = setup();
    const grant = createAuthorizationGrant(grantInput(s));
    const order = s.plan.orders[0]!;
    for (const replacement of [
      { ...order, type: 'limit' as const, limitPrice: 50 },
      { ...order, timeInForce: 'gtc' as const },
    ]) {
      const report = verifyAuthorizationGrant({ ...verifyInput(s, grant), orders: [replacement] });
      expect(report.reasons).toContainEqual(expect.objectContaining({ reason: 'order-mismatch' }));
    }
  });
  it('accepts the bound plan under the bound snapshots with a licensed key, and lists every failed binding', () => {
    const s = setup();
    const grant = createAuthorizationGrant(grantInput(s));
    const ok = verifyAuthorizationGrant(verifyInput(s, grant));
    expect(ok).toMatchObject({
      valid: true,
      reasons: [],
      grantHash: grant.contentHash,
      planHash: s.plan.contentHash,
      checkedAt: NOW + 1_000,
      assumptions: { mode: 'paper', marketAgeMs: 1_000, ordersJudged: 'plan' },
      diagnostics: { engine: 'grant-verification', warnings: [], reasonCount: 0, orderCount: 2 },
    });
    const other = setup({ rationale: 'another plan' });
    const everything = verifyAuthorizationGrant({
      ...verifyInput(s, grant),
      plan: other.plan,
      now: NOW + 2 * DAY,
      portfolioHash: 'sha256:moved',
      marketHash: 'sha256:moved',
      marketAsOf: NOW - DAY,
      idempotencyKey: 'run:9',
    });
    expect(everything.valid).toBe(false);
    expect(everything.reasons.map((r) => r.reason)).toEqual([
      'expired',
      'plan-hash-mismatch',
      'portfolio-hash-mismatch',
      'market-hash-mismatch',
      'market-stale',
      'idempotency-key-unknown',
    ]);
  });

  it('judges the market by age and by instant, and re-checks on every call', () => {
    const s = setup();
    const grant = createAuthorizationGrant(grantInput(s));
    const tooOld = verifyAuthorizationGrant({
      ...verifyInput(s, grant),
      now: NOW + DAY - 1,
      marketAsOf: NOW - 2,
    });
    expect(tooOld.reasons.map((r) => r.reason)).toEqual(['market-stale']);
    expect(tooOld.reasons[0]!.detail).toContain('older');
    const aged = verifyAuthorizationGrant({
      ...verifyInput(s, grant),
      now: NOW + DAY - 1,
      marketAsOf: NOW,
    });
    expect(aged.valid).toBe(true);
    const beyond = verifyAuthorizationGrant({
      ...verifyInput(s, grant),
      now: NOW + DAY + 1,
      marketAsOf: NOW,
    });
    expect(beyond.reasons.map((r) => r.reason)).toEqual(['expired', 'market-stale']);
    const early = verifyAuthorizationGrant({ ...verifyInput(s, grant), now: NOW - 1 });
    expect(early.reasons.map((r) => r.reason)).toEqual(['premature']);
  });

  it('holds executed orders inside the variance envelope', () => {
    const s = setup();
    const grant = createAuthorizationGrant(grantInput(s));
    const [buy, sell] = s.plan.orders;
    const within = verifyAuthorizationGrant({
      ...verifyInput(s, grant),
      orders: [
        { ...buy!, quantity: 210 },
        { ...sell!, limitPrice: 110.5 },
      ],
    });
    expect(within.valid).toBe(true);
    const outside = verifyAuthorizationGrant({
      ...verifyInput(s, grant),
      orders: [
        { ...buy!, quantity: 250 },
        { ...sell!, limitPrice: 120 },
        { ...sell!, orderId: 'plan:9:ZZZ:sell' },
        { ...buy!, side: 'sell' },
      ],
    });
    expect(outside.reasons.map((r) => [r.reason, r.orderId])).toEqual([
      ['quantity-variance', buy!.orderId],
      ['notional-variance', buy!.orderId],
      ['slippage-variance', sell!.orderId],
      ['order-unknown', 'plan:9:ZZZ:sell'],
      ['order-mismatch', buy!.orderId], // duplicate ID is independently refused
      ['order-mismatch', buy!.orderId],
    ]);
    expect(
      failure(() => verifyAuthorizationGrant({ ...verifyInput(s, grant), mode: 'live' as never }))
        .code,
    ).toBe(ErrorCode.TradeLiveUnavailable);
    expect(
      failure(() => verifyAuthorizationGrant({ ...verifyInput(s, grant), idempotencyKey: '' }))
        .message,
    ).toContain('idempotencyKey');
    expect(
      failure(() => verifyAuthorizationGrant({ ...verifyInput(s, grant), orders: 'x' as never }))
        .message,
    ).toContain('orders');
  });
});

const PLAN = 'sha256:plan';
let sequence = 0;
const je = (
  orderId: string,
  eventType: ExecutionJournalEventType,
  detail: ExecutionJournalDetail = {},
  overrides: Partial<ExecutionJournalEvent> = {},
): ExecutionJournalEvent => {
  sequence += 1;
  return {
    eventId: `e${sequence}`,
    journalId: 'j1',
    timestampMs: NOW + sequence * 1_000,
    orderId,
    planHash: PLAN,
    eventType,
    detail,
    sourceId: 'paper:main',
    provenance: {},
    ...overrides,
  };
};

describe('applyJournalEvents', () => {
  it('folds the lifecycle with the transition table, the average price, and the cancel flag', () => {
    const list = [
      je('o1', 'proposed', { artifactHash: 'sha256:intent' }),
      je('o1', 'preflighted'),
      je('o1', 'authorized'),
      je('o1', 'submitted', { quantity: 100 }, { idempotencyKey: 'run:1' }),
      je('o1', 'acknowledged'),
      je('o1', 'partially-filled', { fillId: 'f1', quantity: 40, pricePerUnit: 10 }),
      je('o1', 'cancel-requested'),
      je('o1', 'filled', { fillId: 'f2', quantity: 60, pricePerUnit: 11 }),
      je('o2', 'submitted', { quantity: 5 }),
      je('o2', 'replaced', { replacementOrderId: 'o3' }),
      je('o3', 'submitted', { quantity: 5 }),
      je('o3', 'rejected', { reason: 'insufficient buying power' }),
      je('o4', 'submitted', { quantity: 7 }),
      je('o4', 'expired'),
      je('o5', 'proposed'),
    ];
    const result = applyJournalEvents({ events: list });
    expect(result.applied).toBe(list.length);
    expect(result.duplicates).toEqual([]);
    expect(result.lateFills).toEqual([]);
    const o1 = result.state.orders['o1']!;
    expect(o1.state).toBe('filled');
    expect(o1.terminal).toBe(true);
    expect(o1.cancelRequested).toBe(true);
    expect(o1.filledQuantity).toBe(100);
    expect(o1.remainingQuantity).toBe(0);
    expect(o1.averageFillPrice).toBeCloseTo(10.6, 12);
    expect(o1.fillIds).toEqual(['f1', 'f2']);
    expect(result.state.orders['o2']).toMatchObject({
      state: 'cancelled',
      replacedBy: 'o3',
      terminal: true,
    });
    expect(result.state.orders['o3']).toMatchObject({
      state: 'rejected',
      reason: 'insufficient buying power',
    });
    expect(result.state.orders['o4']).toMatchObject({ state: 'expired', terminal: true });
    expect(result.state.preSubmission).toEqual({ o5: ['proposed'] });
    expect(result.diagnostics).toMatchObject({
      orderCount: 4,
      duplicateCount: 0,
      lateFillCount: 0,
      unresolvedCount: 0,
    });
    expect(result.diagnostics.warnings).toEqual(['1 order journaled only before submission']);
    expect(journalOrderStates(result.state).map((o) => o.orderId)).toEqual([
      'o1',
      'o2',
      'o3',
      'o4',
    ]);
    expect(Object.isFrozen(result.state.orders['o1'])).toBe(true);
    // incremental folds equal the one-shot fold
    const first = applyJournalEvents({ events: list.slice(0, 6) });
    const second = applyJournalEvents({ events: list.slice(6), previousState: first.state });
    expect(second.state).toEqual(result.state);
  });

  it('skips a duplicate delivery and records a late fill as unresolved', () => {
    const submitted = je('o1', 'submitted', { quantity: 10 });
    const cancelled = je('o1', 'cancelled', { reason: 'user' });
    const late = je('o1', 'filled', { fillId: 'f9', quantity: 10, pricePerUnit: 3 });
    const result = applyJournalEvents({ events: [submitted, cancelled, cancelled, late, late] });
    expect(result.duplicates).toEqual([cancelled.eventId, late.eventId]);
    expect(result.state.duplicateEventIds).toEqual([cancelled.eventId, late.eventId]);
    expect(result.lateFills).toEqual([{ orderId: 'o1', fillId: 'f9', eventId: late.eventId }]);
    const o1 = result.state.orders['o1']!;
    expect(o1.state).toBe('unresolved');
    expect(o1.terminal).toBe(true);
    expect(o1.reason).toContain('late fill after cancelled');
    expect(o1.fillIds).toEqual(['f9']);
    expect(o1.lateFillIds).toEqual(['f9']);
    expect(o1.filledQuantity).toBe(10);
    expect(result.diagnostics.warnings.some((w) => w.includes('duplicate'))).toBe(true);
    expect(result.diagnostics.unresolvedCount).toBe(1);
    // reconciled marks it; unresolved closes any order with a reason
    const marked = applyJournalEvents({
      events: [je('o1', 'reconciled')],
      previousState: result.state,
    });
    expect(marked.state.orders['o1']!.reconciledEventId).toBe(marked.state.eventIds.at(-1));
  });

  it('refuses every invalid transition with trade.journal_transition_invalid', () => {
    const cases: [string, ExecutionJournalEvent[]][] = [
      ['no submitted event precedes', [je('x', 'acknowledged')]],
      [
        'already submitted',
        [je('x', 'submitted', { quantity: 1 }), je('x', 'submitted', { quantity: 1 })],
      ],
      ['already submitted', [je('x', 'submitted', { quantity: 1 }), je('x', 'proposed')]],
      [
        'acknowledged follows submitted once',
        [je('x', 'submitted', { quantity: 1 }), je('x', 'acknowledged'), je('x', 'acknowledged')],
      ],
      [
        'journal it as filled',
        [
          je('x', 'submitted', { quantity: 1 }),
          je('x', 'partially-filled', { fillId: 'a', quantity: 1 }),
        ],
      ],
      [
        'journal a partial fill',
        [je('x', 'submitted', { quantity: 2 }), je('x', 'filled', { fillId: 'a', quantity: 1 })],
      ],
      [
        'over-fill',
        [
          je('x', 'submitted', { quantity: 1 }),
          je('x', 'filled', { fillId: 'a', quantity: 1 }),
          je('x', 'filled', { fillId: 'b', quantity: 1 }),
        ],
      ],
      [
        'already journaled on this order',
        [
          je('x', 'submitted', { quantity: 2 }),
          je('x', 'partially-filled', { fillId: 'a', quantity: 1 }),
          je('x', 'partially-filled', { fillId: 'a', quantity: 0.5 }),
        ],
      ],
      ['detail.quantity', [je('x', 'submitted')]],
      [
        'detail.fillId',
        [je('x', 'submitted', { quantity: 1 }), je('x', 'filled', { quantity: 1 })],
      ],
      ['replacementOrderId', [je('x', 'submitted', { quantity: 1 }), je('x', 'replaced')]],
      [
        'already rejected',
        [
          je('x', 'submitted', { quantity: 1 }),
          je('x', 'rejected', { reason: 'r' }),
          je('x', 'cancelled'),
        ],
      ],
      [
        'belongs to plan',
        [
          je('x', 'submitted', { quantity: 1 }),
          je('x', 'acknowledged', {}, { planHash: 'sha256:other' }),
        ],
      ],
    ];
    for (const [needle, list] of cases) {
      const refusal = failure(() => applyJournalEvents({ events: list }));
      expect(refusal.code, needle).toBe(ErrorCode.TradeJournalTransitionInvalid);
      expect(refusal.message, needle).toContain(needle);
    }
    const journals = failure(() =>
      applyJournalEvents({
        events: [
          je('x', 'submitted', { quantity: 1 }),
          je('x', 'acknowledged', {}, { journalId: 'j2' }),
        ],
      }),
    );
    expect(journals.code).toBe(ErrorCode.InputWrongShape);
    expect(
      failure(() =>
        applyJournalEvents({
          events: [{ ...je('x', 'submitted', { quantity: 1 }), extra: 1 } as never],
        }),
      ).message,
    ).toContain('extra');
    expect(
      failure(() =>
        applyJournalEvents({ events: [je('x', 'submitted', { quantity: 1, bogus: 1 } as never)] }),
      ).message,
    ).toContain('bogus');
    expect(failure(() => applyJournalEvents({ events: 'x' as never })).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      failure(() =>
        requireExecutionJournalEvent(
          't',
          'e',
          je('x', 'submitted', {}, { eventType: 'teleported' as never }),
        ),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    const full = {
      ...applyJournalEvents({ events: [] }).state,
      eventCount: EXECUTION_JOURNAL_EVENT_CEILING,
    };
    expect(
      failure(() =>
        applyJournalEvents({
          events: [je('x', 'submitted', { quantity: 1 })],
          previousState: full,
        }),
      ).message,
    ).toContain(String(EXECUTION_JOURNAL_EVENT_CEILING));
  });
});

describe('reconcileExecution', () => {
  const paperFill = (
    fillId: string,
    instrumentId: string,
    side: 'buy' | 'sell',
    quantity: number,
    pricePerUnit: number,
    orderId: string,
  ) =>
    envelope(
      fillId,
      NOW,
      { eventType: 'trade.fill', instrumentId, side, quantity, pricePerUnit, currency: 'USD' },
      'paper:main',
      orderId,
    );
  const fill = (
    fillId: string,
    instrumentId: string,
    side: 'buy' | 'sell',
    quantity: number,
    pricePerUnit: number,
    orderId: string,
  ): NormalizedFill => ({
    fillId,
    accountId: 'main',
    instrumentId,
    side,
    quantity,
    pricePerUnit,
    currency: 'USD',
    filledTimestampMs: NOW,
    orderId,
  });
  const executed = () => {
    const s = setup();
    const [buy, sell] = s.plan.orders;
    const ledgerAfter = applyPortfolioEvents({
      previousState: s.state,
      events: [
        paperFill('f1', 'BBB', 'buy', 200, 50, buy!.orderId),
        paperFill('f2', 'AAA', 'sell', 20, 112, sell!.orderId),
      ],
    });
    const journal = [
      je(buy!.orderId, 'submitted', { quantity: 200 }, { planHash: s.plan.contentHash }),
      je(
        buy!.orderId,
        'filled',
        { fillId: 'f1', quantity: 200, pricePerUnit: 50 },
        { planHash: s.plan.contentHash },
      ),
      je(sell!.orderId, 'submitted', { quantity: 20 }, { planHash: s.plan.contentHash }),
      je(
        sell!.orderId,
        'filled',
        { fillId: 'f2', quantity: 20, pricePerUnit: 112 },
        { planHash: s.plan.contentHash },
      ),
    ];
    const fills = [
      fill('f1', 'BBB', 'buy', 200, 50, buy!.orderId),
      fill('f2', 'AAA', 'sell', 20, 112, sell!.orderId),
    ];
    return { s, buy: buy!, sell: sell!, ledgerAfter, journal, fills };
  };
  const tolerance = { quantity: 1e-9, cashAmount: 0.01 };

  it('reconciles a journal whose fills are the ledger fills, and composes reconcilePortfolio for an external snapshot', () => {
    const { s, ledgerAfter, journal, fills } = executed();
    const report = reconcileExecution({
      journal,
      ledger: ledgerAfter,
      sourceId: 'paper:main',
      fills,
      asOf: NOW,
      tolerance,
      planHash: s.plan.contentHash,
    });
    expect(report.kind).toBe(RECONCILIATION_REPORT_KIND);
    expect(report.reconciled).toBe(true);
    expect(report.journaledNotInLedger).toEqual([]);
    expect(report.ledgerNotJournaled).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.portfolio).toBeNull();
    expect(report.orderChecks.every((c) => c.withinTolerance && c.difference === 0)).toBe(true);
    expect(report.fills.map((f) => [f.fillId, f.journaled, f.inLedger])).toEqual([
      ['f1', true, true],
      ['f2', true, true],
    ]);
    expect(report.diagnostics).toMatchObject({
      orderCount: 2,
      openCount: 0,
      fillCount: 2,
      ledgerFillCount: 2,
      differenceCount: 0,
    });
    const { contentHash: declared, ...body } = report;
    expect(declared).toBe(contentHash(body));
    // the same inputs, folded first, give the same report
    const folded = applyJournalEvents({ events: journal }).state;
    expect(
      reconcileExecution({
        journal: folded,
        ledger: ledgerAfter,
        sourceId: 'paper:main',
        fills,
        asOf: NOW,
        tolerance,
        planHash: s.plan.contentHash,
      }),
    ).toEqual(report);
    // an external snapshot that agrees reconciles; one that differs does not, and the drafts are reconcilePortfolio's
    const external: ExternalPortfolioSnapshot = {
      asOf: NOW,
      accounts: {
        main: {
          cash: { USD: { total: 100_000 - 10_000 - 10_000 + 2_240 } },
          positions: [
            { instrumentId: 'AAA', quantity: 80, currency: 'USD' },
            { instrumentId: 'BBB', quantity: 200, currency: 'USD' },
          ],
        },
      },
    };
    const agreed = reconcileExecution({
      journal,
      ledger: ledgerAfter,
      sourceId: 'paper:main',
      fills,
      asOf: NOW,
      tolerance,
      external,
    });
    expect(agreed.reconciled).toBe(true);
    expect(agreed.portfolio!.reconciled).toBe(true);
    const disagreed = reconcileExecution({
      journal,
      ledger: ledgerAfter,
      sourceId: 'paper:main',
      fills,
      asOf: NOW,
      tolerance,
      external: {
        ...external,
        accounts: { main: { ...external.accounts['main']!, cash: { USD: { total: 80_000 } } } },
      },
    });
    expect(disagreed.reconciled).toBe(false);
    expect(disagreed.portfolio!.reconciled).toBe(false);
    expect(disagreed.portfolio!.suggestedCorrections.length).toBeGreaterThan(0);
    expect(disagreed.portfolio!.suggestedCorrections[0]!.sourceId).toBe(
      'reconciliation:paper:main',
    );
  });

  it('names a journaled fill the ledger lacks, a ledger fill the journal lacks, a quantity outside tolerance, and an unresolved order', () => {
    const { s, buy, sell, ledgerAfter, journal, fills } = executed();
    const missingInLedger = reconcileExecution({
      journal,
      ledger: s.state,
      sourceId: 'paper:main',
      fills,
      asOf: NOW,
      tolerance,
    });
    expect(missingInLedger.reconciled).toBe(false);
    expect(missingInLedger.journaledNotInLedger).toEqual(['f1', 'f2']);
    expect(missingInLedger.fills.map((f) => f.inLedger)).toEqual([false, false]);
    const notJournaled = reconcileExecution({
      journal: journal.slice(0, 2),
      ledger: ledgerAfter,
      sourceId: 'paper:main',
      fills: fills.slice(0, 1),
      asOf: NOW,
      tolerance,
    });
    expect(notJournaled.reconciled).toBe(false);
    expect(notJournaled.ledgerNotJournaled).toEqual(['f2']);
    const shortFill = reconcileExecution({
      journal,
      ledger: ledgerAfter,
      sourceId: 'paper:main',
      fills: [fills[0]!, { ...fills[1]!, quantity: 19 }],
      asOf: NOW,
      tolerance,
    });
    expect(shortFill.reconciled).toBe(false);
    expect(shortFill.orderChecks.find((c) => c.orderId === sell.orderId)).toMatchObject({
      journaledQuantity: 20,
      fillQuantity: 19,
      difference: -1,
      withinTolerance: false,
    });
    expect(
      reconcileExecution({
        journal,
        ledger: ledgerAfter,
        sourceId: 'paper:main',
        fills: [fills[0]!, { ...fills[1]!, quantity: 19 }],
        asOf: NOW,
        tolerance: { ...tolerance, quantity: 1 },
      }).reconciled,
    ).toBe(true);
    const unresolvedJournal = [
      ...journal,
      je(
        buy.orderId,
        'unresolved',
        { reason: 'broker reports a different fill' },
        { planHash: s.plan.contentHash },
      ),
    ];
    const unresolved = reconcileExecution({
      journal: unresolvedJournal,
      ledger: ledgerAfter,
      sourceId: 'paper:main',
      fills,
      asOf: NOW,
      tolerance,
    });
    expect(unresolved.reconciled).toBe(false);
    expect(unresolved.unresolved).toEqual([
      { orderId: buy.orderId, reason: 'broker reports a different fill' },
    ]);
    // another source's fills are not this execution's
    const otherSource = reconcileExecution({
      journal,
      ledger: ledgerAfter,
      sourceId: 'paper:other',
      fills,
      asOf: NOW,
      tolerance,
    });
    expect(otherSource.journaledNotInLedger).toEqual(['f1', 'f2']);
    expect(otherSource.diagnostics.ledgerFillCount).toBe(0);
    // a plan filter leaves other plans out and says so
    const filtered = reconcileExecution({
      journal,
      ledger: ledgerAfter,
      sourceId: 'paper:main',
      fills,
      asOf: NOW,
      tolerance,
      planHash: 'sha256:another',
    });
    expect(filtered.orders).toEqual([]);
    expect(filtered.diagnostics.warnings[0]).toContain('other plans');
    expect(
      failure(() =>
        reconcileExecution({
          journal,
          ledger: ledgerAfter,
          sourceId: 'paper:main',
          fills,
          asOf: NOW,
        } as never),
      ).message,
    ).toContain('tolerance');
    expect(
      failure(() =>
        reconcileExecution({
          journal,
          ledger: ledgerAfter,
          sourceId: 'paper:main',
          fills: [fills[0]!, fills[0]!],
          asOf: NOW,
          tolerance,
        }),
      ).message,
    ).toContain('duplicates');
  });
});
