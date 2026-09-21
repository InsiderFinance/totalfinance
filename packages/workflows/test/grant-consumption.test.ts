import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { createPortfolioLedger, type NormalizedFill } from '@totalfinance/portfolio';
import type {
  AuthorizationGrant,
  ExecutionPlan,
  PreflightReport,
} from '@totalfinance/portfolio/trade';
import {
  createMemoryAuthorizationStore,
  createMemoryExecutionJournalStore,
  createOperationRegistry,
  tradePack,
  type AuthorizationStore,
} from '../src/index.js';
import {
  createFileAuthorizationStore,
  createFileExecutionJournalStore,
} from '../src/local/index.js';
import { CREATED, grant } from './fixtures/store-values.js';

/**
 * Pre-publish interface repairs B6 — the authorization store consumes a grant on its first
 * successful submission and refuses replays into any journal.
 */
const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

describe.each([
  ['memory', () => createMemoryAuthorizationStore()],
  [
    'file',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'totalfinance-grant-consumption-'));
      directories.push(directory);
      return createFileAuthorizationStore({ directory });
    },
  ],
] as const)('the %s authorization store consumes a grant once', (_name, open) => {
  it('is unconsumed after put, consumed once, idempotent for the same receipt, and refuses any other', () => {
    const store: AuthorizationStore = open();
    const g = grant('one');
    const handle = store.put({ grant: g, createdTimestampMs: CREATED });
    expect(handle.createdTimestampMs).toBe(CREATED);
    expect(handle.expiresTimestampMs).toBe(g.expiresAt);
    expect(store.get(g.contentHash)?.consumed).toBeNull();
    const first = {
      hashOrUri: g.contentHash,
      journalStoreId: 'store-one',
      journalEvents: [],
      journalId: 'paper:main:journal',
      receiptId: 'paper:main:receipt:1',
      idempotencyKey: 'k1',
      consumedTimestampMs: CREATED + 1,
    };
    expect(store.consume(first)).toEqual({
      journalStoreId: 'store-one',
      journalEvents: [],
      journalId: 'paper:main:journal',
      receiptId: 'paper:main:receipt:1',
      idempotencyKey: 'k1',
      consumedTimestampMs: CREATED + 1,
    });
    // A retry records nothing new and keeps the original instant.
    expect(store.consume({ ...first, consumedTimestampMs: CREATED + 9 }).consumedTimestampMs).toBe(
      CREATED + 1,
    );
    expect(store.get(handle.uri)?.consumed).toMatchObject({ receiptId: 'paper:main:receipt:1' });
    expect(codeOf(() => store.consume({ ...first, receiptId: 'paper:main:receipt:2' }))).toBe(
      ErrorCode.TradeGrantConsumed,
    );
    expect(codeOf(() => store.consume({ ...first, journalId: 'paper:other:journal' }))).toBe(
      ErrorCode.TradeGrantConsumed,
    );
    expect(codeOf(() => store.consume({ ...first, journalStoreId: 'fresh-store' }))).toBe(
      ErrorCode.TradeGrantConsumed,
    );
    const snapshot = store.get(handle.uri)!.consumed!;
    snapshot.receiptId = 'tampered';
    expect(store.get(handle.uri)!.consumed!.receiptId).toBe(first.receiptId);
    const originalUri = handle.uri;
    handle.uri = 'edited-put-handle';
    store.get(originalUri)!.handle.uri = 'edited-get-handle';
    store.list()[0]!.uri = 'edited-list-handle';
    expect(store.list()[0]!.uri).toBe(originalUri);
    expect(codeOf(() => store.consume({ ...first, hashOrUri: 'sha256:unknown' }))).toBe(
      ErrorCode.OperationHandleUnknown,
    );
    expect(codeOf(() => store.consume({ ...first, consumedTimestampMs: 1.5 }))).toBe(
      ErrorCode.InputWrongShape,
    );
    expect(codeOf(() => store.consume({ ...first, extra: 1 } as never))).toBe(
      ErrorCode.InputUnknownField,
    );
    // The store survives a reopen with the consumption (file) or keeps it in memory.
    expect(store.get(g.contentHash)?.consumed?.receiptId).toBe('paper:main:receipt:1');
  });
});

describe('trade.submit consumes the grant', () => {
  const T0 = Date.UTC(2026, 0, 5, 21);
  const DAY = 86_400_000;
  const NOW = T0 + 2 * DAY;
  const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const ledger = () =>
    createPortfolioLedger({
      baseCurrency: 'USD',
      events: [
        {
          eventId: 'deposit',
          schemaVersion: 1,
          sourceId: 'funding',
          accountId: 'main',
          effectiveTimestampMs: T0,
          recordedTimestampMs: T0,
          eventType: 'cash.deposit',
          event: { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' },
          provenance: {},
        },
      ],
    });
  const registry = createOperationRegistry({ packs: [tradePack()] });
  let stores = {
    authorization: createMemoryAuthorizationStore(),
    journal: createMemoryExecutionJournalStore(),
  };
  beforeEach(() => {
    stores = {
      authorization: createMemoryAuthorizationStore(),
      journal: createMemoryExecutionJournalStore(),
    };
  });
  const ALL = ['portfolio:read', 'analytics:run', 'trade:propose', 'trade:approve', 'trade:paper'];
  const run = (id: string, input: unknown) =>
    registry.run({
      id,
      input: wire(input),
      stores,
      capabilities: ALL,
      createdTimestampMs: CREATED,
    });
  const approve = (keys: string[], quantity = 10, limitPrice?: number) => {
    const { plan, ...preflight } = run('totalfinance.trade.preflight', {
      intent: {
        kind: 'totalfinance.trade-intent',
        schemaVersion: 1,
        accountId: 'main',
        asOf: NOW,
        orders: [
          {
            instrumentId: 'AAA',
            side: 'buy',
            quantity,
            type: limitPrice === undefined ? 'market' : 'limit',
            ...(limitPrice === undefined ? {} : { limitPrice }),
          },
        ],
      },
      portfolio: ledger().toJSON(),
      market: createMarketSnapshot({
        asOf: NOW,
        observations: { spots: { AAA: { price: 100, currency: 'USD' } } },
      }),
      asOf: NOW,
      policy: { mode: 'paper', marketMaximumAgeMs: DAY },
    }).structured as unknown as PreflightReport & { plan: ExecutionPlan };
    const { grant: g } = run('totalfinance.trade.authorize', {
      plan,
      preflight,
      now: NOW,
      expiresAt: NOW + DAY,
      approvedBy: 'trey',
      marketMaximumAgeMs: DAY,
      variance: { maximumQuantityRatio: 0, maximumNotionalRatio: 0, maximumSlippageBps: 100 },
      idempotencyKeys: keys,
      createdTimestampMs: CREATED,
    }).structured as { grant: AuthorizationGrant };
    return { plan, preflight, grant: g };
  };
  const submit = (a: ReturnType<typeof approve>, key: string, sourceId = 'paper:main') =>
    run('totalfinance.trade.submit', {
      plan: a.plan,
      grantHash: a.grant.contentHash,
      idempotencyKey: key,
      now: NOW + 1_000,
      portfolioHash: a.preflight.portfolioHash,
      marketHash: a.preflight.marketHash,
      marketAsOf: a.preflight.marketAsOf,
      sourceId,
      accountId: 'main',
      baseCurrency: 'USD',
      instruments: { AAA: { currency: 'USD' } },
      observations: {
        AAA: {
          kind: 'bar',
          bar: {
            symbol: 'AAA',
            timestampMs: NOW + 1_000,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1_000,
          },
        },
      },
    }).structured as {
      receipt: { receiptId: string };
      retried: boolean;
      fills: NormalizedFill[];
      recovery: { fills: NormalizedFill[] };
    };

  it('refuses the same key and source against a fresh journal store', () => {
    const a = approve(['k1']);
    submit(a, 'k1');
    stores.journal = createMemoryExecutionJournalStore();
    expect(codeOf(() => submit(a, 'k1'))).toBe(ErrorCode.TradeGrantConsumed);
    expect(stores.journal.list()).toEqual([]);
  });

  it('does not commit any order when the authorization write fails; a clean retry works', () => {
    const a = approve(['k1']);
    const authorization = stores.authorization;
    stores.authorization = {
      ...authorization,
      consume() {
        throw new Error('authorization write failed');
      },
    };
    expect(() => submit(a, 'k1')).toThrow('authorization write failed');
    expect(stores.journal.list()).toEqual([]);
    expect(authorization.get(a.grant.contentHash)!.consumed).toBeNull();
    stores.authorization = authorization;
    expect(submit(a, 'k1').fills).toHaveLength(1);
  });

  it('does not spend authority on an invalid submission', () => {
    const a = approve(['k1']);
    expect(() => submit(a, 'unlicensed')).toThrow();
    expect(stores.journal.list()).toEqual([]);
    expect(stores.authorization.get(a.grant.contentHash)!.consumed).toBeNull();
    expect(submit(a, 'k1').retried).toBe(false);
  });

  it.each(['memory', 'file'] as const)(
    'recovers an exact write-ahead batch after journal commit failure (%s)',
    (kind) => {
      const directory =
        kind === 'file' ? mkdtempSync(join(tmpdir(), 'totalfinance-write-ahead-')) : undefined;
      if (directory !== undefined) {
        directories.push(directory);
        stores = {
          authorization: createFileAuthorizationStore({ directory }),
          journal: createFileExecutionJournalStore({ directory }),
        };
      }
      const a = approve(['k1', 'k2']);
      const journal = stores.journal;
      stores.journal = {
        ...journal,
        transact(input) {
          input.execute(journal.read(input.journalId));
          throw new Error('journal commit failed');
        },
      };
      expect(() => submit(a, 'k1')).toThrow('journal commit failed');
      expect(journal.list()).toEqual([]);
      const prepared = stores.authorization.get(a.grant.contentHash)!.consumed!;
      expect(prepared.journalEvents.map((event) => event.eventType)).toEqual([
        'submitted',
        'acknowledged',
        'filled',
      ]);
      if (directory !== undefined) {
        stores = {
          authorization: createFileAuthorizationStore({ directory }),
          journal: createFileExecutionJournalStore({ directory }),
        };
      } else stores.journal = journal;
      expect(stores.journal.storeId).toBe(journal.storeId);
      expect(codeOf(() => submit(a, 'k2'))).toBe(ErrorCode.TradeGrantConsumed);
      const retry = submit(a, 'k1');
      expect(retry.retried).toBe(true);
      expect(retry.fills).toEqual([]);
      expect(retry.recovery.fills).toHaveLength(1);
      expect(stores.journal.read('paper:main:journal')).toEqual(prepared.journalEvents);
      expect(submit(a, 'k1').receipt).toEqual(retry.receipt);
    },
  );

  it('recovers when authorization persisted but its response failed', () => {
    const a = approve(['k1']);
    const authorization = stores.authorization;
    stores.authorization = {
      ...authorization,
      consume(input) {
        authorization.consume(input);
        throw new Error('lost authorization response');
      },
    };
    expect(() => submit(a, 'k1')).toThrow('lost authorization response');
    expect(stores.journal.list()).toEqual([]);
    stores.authorization = authorization;
    const retry = submit(a, 'k1');
    expect(retry.retried).toBe(true);
    expect(retry.recovery.fills).toHaveLength(1);
  });

  it('recovers earlier pending grants before another submission allocates IDs, including chained failures', () => {
    const a = approve(['a'], 10);
    const b = approve(['b'], 20);
    const c = approve(['c'], 30);
    const journal = stores.journal;
    stores.journal = {
      ...journal,
      transact(input) {
        input.execute(journal.read(input.journalId));
        throw new Error('commit failed');
      },
    };
    expect(() => submit(a, 'a')).toThrow('commit failed');
    expect(() => submit(b, 'b')).toThrow('commit failed');
    expect(journal.list()).toEqual([]);
    stores.journal = journal;
    expect(submit(c, 'c').retried).toBe(false);
    const history = journal.read('paper:main:journal');
    expect(history).toHaveLength(9);
    expect(new Set(history.map((event) => event.eventId)).size).toBe(9);
    expect(
      history.filter((event) => event.eventType === 'filled').map((event) => event.detail.quantity),
    ).toEqual([10, 20, 30]);
    expect(submit(a, 'a').recovery.fills).toHaveLength(1);
    expect(submit(b, 'b').recovery.fills).toHaveLength(1);
    const detached = stores.authorization.get(a.grant.contentHash)!.consumed!;
    (detached.journalEvents as unknown[]).length = 0;
    expect(stores.authorization.get(a.grant.contentHash)!.consumed!.journalEvents).toHaveLength(3);
  });

  it('cancellation recovers a pending open submission before allocating its own journal events', () => {
    const a = approve(['a'], 10, 90);
    const journal = stores.journal;
    stores.journal = {
      ...journal,
      transact(input) {
        input.execute([]);
        throw new Error('commit failed');
      },
    };
    expect(() => submit(a, 'a')).toThrow('commit failed');
    stores.journal = journal;
    const cancelled = run('totalfinance.trade.cancel', {
      orderId: a.plan.orders[0]!.orderId,
      now: NOW + 2_000,
      sourceId: 'paper:main',
      accountId: 'main',
      baseCurrency: 'USD',
    }).structured;
    expect(cancelled['accepted']).toBe(true);
    expect(journal.read('paper:main:journal').map((event) => event.eventType)).toEqual([
      'submitted',
      'acknowledged',
      'cancel-requested',
      'cancelled',
    ]);
    expect(submit(a, 'a').recovery.fills).toEqual([]);
  });

  it('the first successful submission consumes it; a same-key retry reads the receipt; every other use is refused', () => {
    const a = approve(['k1', 'k2']);
    const first = submit(a, 'k1');
    expect(first.retried).toBe(false);
    expect(stores.authorization.get(a.grant.contentHash)?.consumed).toMatchObject({
      journalId: 'paper:main:journal',
      receiptId: first.receipt.receiptId,
      idempotencyKey: 'k1',
      consumedTimestampMs: NOW + 1_000,
    });
    const retry = submit(a, 'k1');
    expect(retry.retried).toBe(true);
    expect(retry.receipt.receiptId).toBe(first.receipt.receiptId);
    // A second licensed key is a second submission of the same authority: refused.
    expect(codeOf(() => submit(a, 'k2'))).toBe(ErrorCode.TradeGrantConsumed);
    // The same key into another journal is a replay: refused before any journal is touched.
    expect(codeOf(() => submit(a, 'k1', 'paper:elsewhere'))).toBe(ErrorCode.TradeGrantConsumed);
    expect(stores.journal.list()).toEqual(['paper:main:journal']);
    // Fresh authority submits again.
    const b = approve(['k3']);
    expect(submit(b, 'k3', 'paper:elsewhere').retried).toBe(false);
  });
});
