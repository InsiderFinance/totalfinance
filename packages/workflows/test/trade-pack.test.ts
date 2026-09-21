/**
 * Stage 7B.2 (AT5) slice 4 — the trade pack through the runtime: capabilities, stores, handles,
 * and the six operations composing the lifecycle end to end.
 */
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { ErrorCode } from '@totalfinance/core';
import { contentHash, createMarketSnapshot } from '@totalfinance/core/artifacts';
import type {
  AuthorizationGrant,
  ExecutionJournalEvent,
  ExecutionPlan,
  PreflightReport,
} from '@totalfinance/portfolio/trade';
import { createPortfolioLedger, type PortfolioEventEnvelope } from '@totalfinance/portfolio';
import {
  DEFAULT_CAPABILITIES,
  createMemoryArtifactStore,
  createMemoryAuthorizationStore,
  createMemoryExecutionJournalStore,
  createOperationRegistry,
  defaultPacks,
  journeyPacks,
  tradePack,
  toOperationError,
  type ExecutionJournalStore,
} from '../src/index.js';
import { registryForProfile } from '../src/local/index.js';

const T0 = Date.UTC(2026, 0, 5, 21);
const DAY = 86_400_000;
const NOW = T0 + 2 * DAY;
const CREATED = Date.parse('2026-09-06T12:00:00Z');
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
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const intent = () => ({
  kind: 'totalfinance.trade-intent',
  schemaVersion: 1,
  accountId: 'main',
  asOf: NOW,
  orders: [
    { instrumentId: 'BBB', side: 'buy', quantity: 200, type: 'market' },
    { instrumentId: 'AAA', side: 'sell', quantity: 20, type: 'limit', limitPrice: 112 },
  ],
  rationale: 'rotate a fifth of AAA into BBB',
});
const policy = () => ({
  mode: 'paper',
  limits: { maximumPositionWeight: 0.5, maximumGrossLeverage: 1 },
  maximumOrderNotional: 50_000,
  marketMaximumAgeMs: DAY,
});
const bar = (symbol: string, open: number, high: number, low: number, close: number) => ({
  kind: 'bar',
  bar: { symbol, timestampMs: NOW + 60_000, open, high, low, close, volume: 10_000 },
});
const failure = (
  fn: () => unknown,
): { code?: string; message: string; context?: Record<string, unknown> } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string; context?: Record<string, unknown> };
  }
  throw new Error('expected a refusal');
};
const ALL = [
  'portfolio:read',
  'analytics:run',
  'trade:propose',
  'trade:approve',
  'trade:paper',
  'portfolio:write',
];
const IDS = [
  'totalfinance.trade.preflight',
  'totalfinance.trade.authorize',
  'totalfinance.trade.submit',
  'totalfinance.trade.cancel',
  'totalfinance.trade.reconcile',
  'totalfinance.portfolio.record_events',
];

describe('the trade pack in the registry', () => {
  const registry = createOperationRegistry({
    packs: [...defaultPacks(), ...journeyPacks(), tradePack()],
  });

  it('registers the six operations with honest effects, authorization, idempotency, and capabilities', () => {
    const ids = registry.list().map((d) => d.id);
    for (const id of IDS) expect(ids).toContain(id);
    const byId = Object.fromEntries(registry.list().map((d) => [d.id, d]));
    expect(byId['totalfinance.trade.preflight']).toMatchObject({
      sideEffect: 'none',
      authorization: 'none',
      idempotency: 'not-applicable',
      // B6: judging a trade is proposing one — a default capability, but a named one.
      requiredCapabilities: ['trade:propose'],
    });
    expect(byId['totalfinance.trade.authorize']).toMatchObject({
      sideEffect: 'none',
      authorization: 'human',
      requiredCapabilities: ['trade:approve'],
    });
    expect(byId['totalfinance.trade.submit']).toMatchObject({
      sideEffect: 'external-order',
      authorization: 'policy',
      idempotency: 'required',
      requiredCapabilities: ['trade:paper'],
    });
    expect(byId['totalfinance.trade.cancel']).toMatchObject({
      sideEffect: 'external-order',
      authorization: 'policy',
      idempotency: 'optional',
      requiredCapabilities: ['trade:paper'],
    });
    expect(byId['totalfinance.trade.reconcile']).toMatchObject({
      sideEffect: 'none',
      requiredCapabilities: ['trade:paper'],
    });
    expect(byId['totalfinance.portfolio.record_events']).toMatchObject({
      sideEffect: 'portfolio-state',
      idempotency: 'required',
      requiredCapabilities: ['portfolio:write'],
    });
    // annotations derive from the effect fields
    expect(byId['totalfinance.trade.submit']!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(byId['totalfinance.portfolio.record_events']!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(byId['totalfinance.trade.preflight']!.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(
      registryForProfile({ profile: 'full' })
        .list()
        .map((d) => d.id),
    ).toEqual(expect.arrayContaining(IDS));
    expect(DEFAULT_CAPABILITIES).toEqual(['portfolio:read', 'analytics:run', 'trade:propose']);
  });

  it('refuses a write operation without its capability BEFORE parsing the input, on every transport-shaped call', () => {
    const refused = failure(() =>
      registry.run({ id: 'totalfinance.trade.authorize', input: { garbage: true } }),
    );
    expect(refused.code).toBe(ErrorCode.OperationCapabilityMissing);
    expect(refused.message).toContain("'trade:approve'");
    expect(refused.context).toMatchObject({
      missing: ['trade:approve'],
      held: [...DEFAULT_CAPABILITIES],
    });
    const mapped = toOperationError(refused, registry.require('totalfinance.trade.authorize'));
    expect(mapped.code).toBe('operation.capability_missing');
    // with the capability, the same garbage is an INPUT refusal — the gate ran first
    const parsed = failure(() =>
      registry.run({
        id: 'totalfinance.trade.authorize',
        input: { garbage: true },
        capabilities: ['trade:approve'],
      }),
    );
    expect(parsed.code?.startsWith('input.')).toBe(true);
    expect(
      failure(() =>
        registry.run({ id: 'totalfinance.trade.preflight', input: {}, capabilities: ['nope'] }),
      ).message,
    ).toContain("'scope:action'");
    expect(
      failure(() =>
        registry.run({
          id: 'totalfinance.trade.preflight',
          input: {},
          stores: { bogus: 1 } as never,
        }),
      ).message,
    ).toContain('bogus');
  });

  it('runs the lifecycle: preflight → authorize (store) → submit with observations → record_events (handle) → reconcile', () => {
    const artifacts = createMemoryArtifactStore();
    const stores = {
      authorization: createMemoryAuthorizationStore(),
      journal: createMemoryExecutionJournalStore(),
    };
    const run = (id: string, input: unknown) => {
      const inputValidator = new AjvJsonSchemaValidator().getValidator(
        registry.require(id).inputSchema.toJSONSchema(),
      );
      expect(inputValidator(wire(input))).toMatchObject({ valid: true });
      const result = registry.run({
        id,
        input,
        artifacts,
        stores,
        capabilities: ALL,
        createdTimestampMs: CREATED,
        maxInputBytes: 16_777_216,
      });
      const validate = new AjvJsonSchemaValidator().getValidator(
        registry.require(id).outputSchema!,
      );
      expect(validate(wire(result.structured))).toMatchObject({ valid: true });
      return result;
    };
    const ledgerHandle = artifacts.put({
      value: wire(ledger().toJSON()) as never,
      kind: 'portfolio',
      createdTimestampMs: CREATED,
    });
    // 1. preflight by handle
    const preflight = run('totalfinance.trade.preflight', {
      intent: intent(),
      portfolio: ledgerHandle.uri,
      market: wire(market()),
      asOf: NOW,
      policy: policy(),
      costs: { commissionBps: 5, slippageBps: 10 },
    }).structured as {
      decision: { verdict: string };
      plan: { contentHash: string; orders: { orderId: string }[] };
      portfolioHash: string;
      marketHash: string;
      kind: string;
    };
    expect(preflight.kind).toBe('totalfinance.preflight-report');
    expect(preflight.decision.verdict).toBe('allow');
    const { plan, ...report } = preflight;
    // 2. authorize into the store
    const authorized = run('totalfinance.trade.authorize', {
      plan,
      preflight: report,
      approvedBy: 'trey',
      expiresAt: NOW + DAY,
      now: NOW,
      variance: { maximumQuantityRatio: 0.1, maximumNotionalRatio: 0.1, maximumSlippageBps: 50 },
      marketMaximumAgeMs: DAY,
      idempotencyKeys: { prefix: 'run', count: 3 },
      createdTimestampMs: CREATED,
    });
    const { grant, handle } = authorized.structured as {
      grant: { contentHash: string };
      handle: { uri: string; kind: string };
    };
    expect(handle.kind).toBe('authorization');
    expect(handle.uri).toBe(`totalfinance://authorizations/${grant.contentHash}`);
    expect(stores.authorization.get(grant.contentHash)!.grant.contentHash).toBe(grant.contentHash);
    expect(authorized.artifacts?.map((h) => h.uri)).toEqual([handle.uri]);
    // 3. submit by grant hash, with observations; the journal store continues the broker
    const submission = {
      plan,
      grantHash: grant.contentHash,
      idempotencyKey: 'run:1',
      now: NOW + 1_000,
      portfolioHash: preflight.portfolioHash,
      marketHash: preflight.marketHash,
      marketAsOf: NOW,
      sourceId: 'paper:main',
      accountId: 'main',
      baseCurrency: 'USD',
      instruments: { AAA: { currency: 'USD' }, BBB: { currency: 'USD' } },
      observations: { BBB: bar('BBB', 50, 51, 49, 50.5), AAA: bar('AAA', 110, 115, 109, 114) },
      asOf: NOW + 60_000,
    };
    const submitted = run('totalfinance.trade.submit', submission).structured as {
      receipt: { contentHash: string; orders: unknown[] };
      retried: boolean;
      fills: { fillId: string; orderId: string; quantity: number }[];
      events: PortfolioEventEnvelope[];
      journal: { journalId: string; appended: number; total: number };
      open: string[];
    };
    expect(submitted.retried).toBe(false);
    expect(submitted.fills.map((f) => f.quantity)).toEqual([200, 20]);
    expect(submitted.open).toEqual([]);
    expect(submitted.journal).toEqual({ journalId: 'paper:main:journal', appended: 6, total: 6 });
    expect(stores.journal.read('paper:main:journal')).toHaveLength(6);
    // a retry (the client never saw the receipt): the same receipt, no second order, nothing appended
    const retried = run('totalfinance.trade.submit', {
      ...submission,
      now: NOW + 5_000,
      observations: undefined,
    }).structured as {
      receipt: { contentHash: string };
      retried: boolean;
      journal: { appended: number; total: number };
    };
    expect(retried.retried).toBe(true);
    expect(retried.receipt.contentHash).toBe(submitted.receipt.contentHash);
    expect(retried.journal).toMatchObject({ appended: 0, total: 6 });
    // the same key with another plan is a conflict; a cancel of a filled order is not accepted
    const other = run('totalfinance.trade.preflight', {
      intent: {
        ...intent(),
        orders: [{ instrumentId: 'BBB', side: 'buy', quantity: 10, type: 'market' }],
      },
      portfolio: ledgerHandle.uri,
      market: wire(market()),
      asOf: NOW,
      policy: policy(),
    }).structured as { plan: unknown };
    const conflict = failure(() =>
      run('totalfinance.trade.submit', {
        ...submission,
        plan: other.plan,
        observations: undefined,
      }),
    );
    expect(conflict.code).toBe(ErrorCode.TradeIdempotencyConflict);
    const cancelled = run('totalfinance.trade.cancel', {
      orderId: plan.orders[0]!.orderId,
      now: NOW + 70_000,
      sourceId: 'paper:main',
      accountId: 'main',
      baseCurrency: 'USD',
    }).structured as { accepted: boolean };
    expect(cancelled.accepted).toBe(false);
    // 4. record the fills onto the ledger — a new content-addressed portfolio handle
    const recorded = run('totalfinance.portfolio.record_events', {
      portfolio: ledgerHandle.uri,
      events: submitted.events,
      createdTimestampMs: CREATED,
    }).structured as { handle: { uri: string; kind: string }; applied: number; eventCount: number };
    expect(recorded.handle.kind).toBe('portfolio');
    expect(recorded.handle.uri).not.toBe(ledgerHandle.uri);
    expect(recorded.eventCount).toBe(2 + submitted.events.length);
    // idempotent: recording the same events onto the same ledger is the same handle
    expect(
      (
        run('totalfinance.portfolio.record_events', {
          portfolio: ledgerHandle.uri,
          events: submitted.events,
          createdTimestampMs: CREATED,
        }).structured as { handle: { uri: string } }
      ).handle.uri,
    ).toBe(recorded.handle.uri);
    // 5. reconcile from the journal store against the new ledger
    const reconciled = run('totalfinance.trade.reconcile', {
      journalId: 'paper:main:journal',
      ledger: recorded.handle.uri,
      sourceId: 'paper:main',
      fills: submitted.fills,
      asOf: NOW + 120_000,
      tolerance: { quantity: 1e-9, cashAmount: 0.01 },
      planHash: plan.contentHash,
    }).structured as { reconciled: boolean; unresolved: unknown[]; journaledNotInLedger: string[] };
    expect(reconciled.reconciled).toBe(true);
    expect(reconciled.journaledNotInLedger).toEqual([]);
    // without the stores the operations teach
    expect(
      failure(() =>
        registry.run({
          id: 'totalfinance.trade.authorize',
          input: {
            plan,
            preflight: report,
            approvedBy: 'x',
            expiresAt: NOW + DAY,
            now: NOW,
            variance: { maximumQuantityRatio: 0, maximumNotionalRatio: 0, maximumSlippageBps: 0 },
            marketMaximumAgeMs: DAY,
            idempotencyKeys: ['k'],
            createdTimestampMs: CREATED,
          },
          capabilities: ALL,
        }),
      ).code,
    ).toBe(ErrorCode.OperationHandleStoreMissing);
    expect(
      failure(() =>
        registry.run({
          id: 'totalfinance.portfolio.record_events',
          input: {
            portfolio: wire(ledger().toJSON()),
            events: submitted.events,
            createdTimestampMs: CREATED,
          },
          capabilities: ALL,
        }),
      ).code,
    ).toBe(ErrorCode.OperationHandleStoreMissing);
    expect(
      failure(() =>
        run('totalfinance.trade.submit', {
          ...submission,
          grantHash: 'sha256:unknown',
          idempotencyKey: 'run:2',
          observations: undefined,
        }),
      ).code,
    ).toBe(ErrorCode.OperationHandleUnknown);
  });
});

describe('trade approval and authoritative journal boundaries (R10/R08)', () => {
  function setup() {
    const registry = createOperationRegistry({ packs: [tradePack()] });
    const stores = {
      authorization: createMemoryAuthorizationStore(),
      journal: createMemoryExecutionJournalStore(),
    };
    const preflight = registry.run({
      id: IDS[0]!,
      input: {
        intent: intent(),
        portfolio: wire(ledger().toJSON()),
        market: wire(market()),
        asOf: NOW,
        policy: policy(),
      },
    }).structured as unknown as PreflightReport & { plan: ExecutionPlan };
    const { plan, ...report } = preflight;
    const authorizeInput = {
      plan,
      preflight: report,
      approvedBy: 'approver',
      expiresAt: NOW + DAY,
      now: NOW,
      variance: { maximumQuantityRatio: 0, maximumNotionalRatio: 0, maximumSlippageBps: 1000 },
      marketMaximumAgeMs: DAY,
      idempotencyKeys: ['safe'],
      createdTimestampMs: CREATED,
    };
    const grant = registry.run({
      id: IDS[1]!,
      input: authorizeInput,
      stores,
      capabilities: ['trade:approve'],
    }).structured['grant'] as AuthorizationGrant;
    const submission = {
      plan,
      grant,
      idempotencyKey: 'safe',
      now: NOW + 1000,
      portfolioHash: report.portfolioHash,
      marketHash: report.marketHash,
      marketAsOf: NOW,
      sourceId: 'paper:main',
      accountId: 'main',
      baseCurrency: 'USD',
    };
    const submit = (input: unknown = submission, journal: ExecutionJournalStore = stores.journal) =>
      registry.run({
        id: IDS[2]!,
        input,
        stores: { ...stores, journal },
        capabilities: ['trade:paper'],
      });
    return { registry, stores, authorizeInput, grant, submission, submit };
  }

  it('accepts byte-equivalent approved inline grants, and separates approve-only from paper-only capabilities', () => {
    const { registry, stores, authorizeInput, submission, submit } = setup();
    expect(submit().structured['retried']).toBe(false);
    const reordered = Object.fromEntries(Object.entries(submission.grant).reverse());
    expect(submit({ ...submission, grant: reordered }).structured['retried']).toBe(true);
    expect(
      failure(() =>
        registry.run({ id: IDS[1]!, input: authorizeInput, stores, capabilities: ['trade:paper'] }),
      ).code,
    ).toBe(ErrorCode.OperationCapabilityMissing);
    expect(
      failure(() =>
        registry.run({ id: IDS[2]!, input: submission, stores, capabilities: ['trade:approve'] }),
      ).code,
    ).toBe(ErrorCode.OperationCapabilityMissing);
  });

  it.each(['approvedBy', 'expiresAt', 'idempotencyKeys', 'variance'] as const)(
    'rejects a rehashed inline edit of %s by a paper-only caller',
    (field) => {
      const { grant, submission, submit, stores } = setup();
      const { contentHash: _old, ...body } = grant;
      const edits = {
        approvedBy: 'self-issued',
        expiresAt: NOW + 2 * DAY,
        idempotencyKeys: ['forged'],
        variance: {
          maximumQuantityRatio: 100,
          maximumNotionalRatio: 100,
          maximumSlippageBps: 10000,
        },
      };
      const modified = { ...body, [field]: edits[field] };
      const forged = { ...modified, contentHash: contentHash(modified) };
      expect(
        failure(() =>
          submit({
            ...submission,
            grant: forged,
            ...(field === 'idempotencyKeys' ? { idempotencyKey: 'forged' } : {}),
          }),
        ).code,
      ).toBe(ErrorCode.OperationHandleUnknown);
      expect(
        failure(() => submit({ ...submission, grant: forged, grantHash: grant.contentHash })).code,
      ).toBe(ErrorCode.TradeGrantInvalid);
      expect(stores.journal.list()).toEqual([]);
    },
  );

  it('requires trusted authorization and journal stores even with complete inline inputs', () => {
    const { registry, stores, submission } = setup();
    for (const configured of [
      { journal: stores.journal },
      { authorization: stores.authorization },
    ]) {
      expect(
        failure(() =>
          registry.run({
            id: IDS[2]!,
            input: { ...submission, journal: [] },
            stores: configured,
            capabilities: ['trade:paper'],
          }),
        ).code,
      ).toBe(ErrorCode.OperationHandleStoreMissing);
    }
    expect(
      failure(() =>
        registry.run({
          id: IDS[3]!,
          input: {
            sourceId: 'paper:main',
            accountId: 'main',
            baseCurrency: 'USD',
            orderId: 'missing',
            now: NOW,
            journal: [],
          },
          capabilities: ['trade:paper'],
        }),
      ).code,
    ).toBe(ErrorCode.OperationHandleStoreMissing);
    expect(
      failure(() =>
        registry.run({
          id: IDS[2]!,
          input: submission,
          stores: { ...stores, authorization: createMemoryAuthorizationStore() },
          capabilities: ['trade:paper'],
        }),
      ).code,
    ).toBe(ErrorCode.OperationHandleUnknown);
  });

  it('restores, submits and allocates IDs inside transact; commits before exposing success', () => {
    const { stores, submit } = setup();
    let committed = false;
    let executions = 0;
    const transactional: ExecutionJournalStore = {
      storeId: stores.journal.storeId,
      read() {
        throw new Error('workflow must not read outside transaction');
      },
      append() {
        throw new Error('workflow must not append outside transaction');
      },
      list: () => [],
      transact(input) {
        executions++;
        const result = stores.journal.transact(input);
        committed = true;
        return result;
      },
    };
    expect(submit(undefined, transactional).structured['retried']).toBe(false);
    expect(committed).toBe(true);
    expect(stores.journal.read('paper:main:journal')).toHaveLength(4);
    expect(submit(undefined, transactional).structured['retried']).toBe(true);
    expect(executions).toBe(2);
    const failing: ExecutionJournalStore = {
      ...transactional,
      transact(input) {
        input.execute([]);
        throw new Error('commit failed');
      },
    };
    expect(() => submit(undefined, failing)).toThrow('commit failed');
    expect(stores.journal.read('paper:main:journal')).toHaveLength(4);
  });

  it('does not let omitted/stale/altered inline history overwrite authoritative orders or bypass retries/cancel', () => {
    const { registry, stores, submission, submit } = setup();
    submit();
    const history = stores.journal.read('paper:main:journal');
    expect(
      failure(() =>
        submit({ ...submission, journal: history }, createMemoryExecutionJournalStore()),
      ).code,
    ).toBe(ErrorCode.TradeGrantConsumed);
    for (const inline of [
      [],
      history.slice(0, 2),
      history.map((e, i) => (i === 0 ? { ...e, provenance: { provider: 'edited' } } : e)),
    ]) {
      expect(failure(() => submit({ ...submission, journal: inline })).code).toBe(
        ErrorCode.TradeJournalTransitionInvalid,
      );
      expect(
        failure(() =>
          registry.run({
            id: IDS[3]!,
            input: {
              sourceId: 'paper:main',
              accountId: 'main',
              baseCurrency: 'USD',
              orderId: submission.plan.orders[0]!.orderId,
              now: NOW + 2000,
              journal: inline,
            },
            stores,
            capabilities: ['trade:paper'],
          }),
        ).code,
      ).toBe(ErrorCode.TradeJournalTransitionInvalid);
    }
    expect(submit({ ...submission, journal: wire(history) }).structured['retried']).toBe(true);
    const cancelled = registry.run({
      id: IDS[3]!,
      input: {
        sourceId: 'paper:main',
        accountId: 'main',
        baseCurrency: 'USD',
        orderId: submission.plan.orders[0]!.orderId,
        now: NOW + 2000,
        journal: history,
      },
      stores,
      capabilities: ['trade:paper'],
    });
    expect(cancelled.structured['accepted']).toBe(true);
    expect(stores.journal.read('paper:main:journal')).toHaveLength(6);
  });

  it('rolls back all submission events when observations fail, and resumes persisted limit orders on a retry', () => {
    const { stores, submission, submit } = setup();
    expect(() =>
      submit({
        ...submission,
        observations: { BBB: bar('BBB', 50, 49, 51, 50) },
        asOf: NOW + 60000,
      }),
    ).toThrow();
    expect(stores.journal.read('paper:main:journal')).toEqual([]);
    const first = submit({
      ...submission,
      observations: { AAA: bar('AAA', 110, 111, 109, 110) },
      asOf: NOW + 60000,
    });
    expect(first.structured['open']).toHaveLength(2);
    const second = submit({
      ...submission,
      observations: {
        AAA: {
          ...bar('AAA', 112, 115, 111, 114),
          bar: { ...bar('AAA', 112, 115, 111, 114).bar, timestampMs: NOW + 120000 },
        },
      },
      asOf: NOW + 120000,
    });
    expect(second.structured['retried']).toBe(true);
    expect(second.structured['fills']).toMatchObject([{ instrumentId: 'AAA', quantity: 20 }]);
    const persisted: ExecutionJournalEvent[] = stores.journal.read('paper:main:journal');
    expect(persisted.find((e) => e.eventType === 'filled')?.detail.fill?.quantity).toBe(20);
  });
});
