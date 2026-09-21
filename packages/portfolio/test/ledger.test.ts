import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { createArtifactMigrationRegistry } from '@totalfinance/core/artifacts';
import {
  PORTFOLIO_LEDGER_KIND,
  PORTFOLIO_LEDGER_SCHEMA_VERSION,
  createPortfolioLedger,
  isPortfolioLedgerSnapshot,
  portfolioLedgerContentHash,
  readPortfolioLedgerSnapshot,
} from '@totalfinance/portfolio/ledger';
import type { PortfolioLedgerSnapshot } from '@totalfinance/portfolio/ledger';
import type { PortfolioEvent, PortfolioEventEnvelope } from '@totalfinance/portfolio/events';

function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  accountId: string,
  event: PortfolioEvent,
  overrides: Partial<PortfolioEventEnvelope> = {},
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
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
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
}

const T1 = Date.UTC(2026, 0, 5, 15);
const T2 = Date.UTC(2026, 0, 6, 15);
const T3 = Date.UTC(2026, 0, 7, 15);

const EVENTS: PortfolioEventEnvelope[] = [
  envelope('dep-1', T1, 'main', { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' }),
  envelope('fill-1', T2, 'main', {
    eventType: 'trade.fill',
    instrumentId: 'AAPL',
    side: 'buy',
    quantity: 100,
    pricePerUnit: 150,
    currency: 'USD',
  }),
];

describe('createPortfolioLedger — the immutable reusable artifact', () => {
  const ledger = createPortfolioLedger({
    portfolioId: 'primary',
    baseCurrency: 'USD',
    events: EVENTS,
  });

  it('derives state through the ONE reducer and echoes the policy', () => {
    expect(ledger.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(85_000);
    expect(ledger.lotRelief).toBe('fifo');
    expect(ledger.state.lotRelief).toBe('fifo');
    expect(ledger.portfolioId).toBe('primary');
  });

  it('apply() returns a NEW ledger and leaves this one untouched', () => {
    const more = [
      envelope('fill-2', T3, 'main', {
        eventType: 'trade.fill',
        instrumentId: 'AAPL',
        side: 'sell',
        quantity: 40,
        pricePerUnit: 170,
        currency: 'USD',
      }),
    ];
    const next = ledger.apply(more);
    expect(next).not.toBe(ledger);
    expect(next.events).toHaveLength(3);
    expect(ledger.events).toHaveLength(2);
    expect(ledger.state.accounts['main']!.positions['AAPL']!.quantity).toBe(100);
    expect(next.state.accounts['main']!.positions['AAPL']!.quantity).toBe(60);
    // FIFO realized on the new ledger only: (170−150)×40 = 800.
    expect(next.state.accounts['main']!.realizedPnl['USD']!).toBe(800);
    expect(Object.isFrozen(ledger)).toBe(true);
    expect(Object.isFrozen(next.events)).toBe(true);
  });

  it('applying an already-applied identical event is a no-op in state AND in the stored events', () => {
    const next = ledger.apply([EVENTS[0]!]);
    expect(next.events).toHaveLength(2);
    expect(next.state).toEqual(ledger.state);
    expect(portfolioLedgerContentHash(next.toJSON())).toBe(
      portfolioLedgerContentHash(ledger.toJSON()),
    );
  });

  it('stores an identical in-batch duplicate only once at creation', () => {
    const doubled = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [...EVENTS, { ...EVENTS[0]!, provenance: { provider: 'redelivery' } }],
    });
    expect(doubled.events).toHaveLength(2);
  });

  it('refuses live input accessors before events can disagree with derived state', () => {
    let reads = 0;
    const input = { baseCurrency: 'USD' } as Record<string, unknown>;
    Object.defineProperty(input, 'events', {
      enumerable: true,
      get(): PortfolioEventEnvelope[] {
        reads += 1;
        return reads < 3 ? [] : EVENTS;
      },
    });

    let caught: unknown;
    try {
      createPortfolioLedger(input as never);
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught)).toBe(true);
    expect(reads).toBe(0);
  });
});

describe('serialization rides the Gate B spine — replay is the deserializer', () => {
  const ledger = createPortfolioLedger({
    portfolioId: 'primary',
    baseCurrency: 'USD',
    events: EVENTS,
    provenance: { provider: 'broker-import' },
  });

  it('toJSON() is the versioned envelope, and JSON.stringify(ledger) emits it', () => {
    const snapshot = ledger.toJSON();
    expect(snapshot.kind).toBe(PORTFOLIO_LEDGER_KIND);
    expect(snapshot.schemaVersion).toBe(PORTFOLIO_LEDGER_SCHEMA_VERSION);
    expect(snapshot.lotRelief).toBe('fifo');
    expect(isPortfolioLedgerSnapshot(snapshot)).toBe(true);
    expect(JSON.stringify(ledger)).toBe(JSON.stringify(snapshot));
    // The envelope stores EVENTS, never derived state — a second truth cannot exist.
    expect('state' in snapshot).toBe(false);
  });

  it('snapshot predicates and readers refuse accessors without executing them', () => {
    let reads = 0;
    const hostile = { ...ledger.toJSON() } as Record<string, unknown>;
    Object.defineProperty(hostile, 'kind', {
      enumerable: true,
      get(): never {
        reads += 1;
        throw new Error('snapshot getter must not execute');
      },
    });

    expect(isPortfolioLedgerSnapshot(hostile)).toBe(false);
    let caught: unknown;
    try {
      readPortfolioLedgerSnapshot({ snapshot: hostile });
    } catch (error) {
      caught = error;
    }
    expect(isQuantError(caught)).toBe(true);
    expect(reads).toBe(0);
  });

  it('round-trips: create → JSON → read re-folds to a deep-equal state and identical hash', () => {
    const stored = JSON.stringify(ledger);
    const { ledger: restored, migrationsApplied } = readPortfolioLedgerSnapshot({
      snapshot: JSON.parse(stored),
    });
    expect(migrationsApplied).toEqual([]);
    expect(restored.state).toEqual(ledger.state);
    expect(restored.events).toEqual(ledger.events);
    expect(portfolioLedgerContentHash(restored.toJSON())).toBe(
      portfolioLedgerContentHash(ledger.toJSON()),
    );
  });

  it('identity excludes provenance at BOTH levels and covers the economics', () => {
    const hash = portfolioLedgerContentHash(ledger.toJSON());
    const relabeledLedger = createPortfolioLedger({
      portfolioId: 'primary',
      baseCurrency: 'USD',
      events: EVENTS.map((event) => ({ ...event, provenance: { provider: 'other-vendor' } })),
      provenance: { provider: 'other-vendor' },
    });
    expect(portfolioLedgerContentHash(relabeledLedger.toJSON())).toBe(hash);

    const changedAmount = createPortfolioLedger({
      portfolioId: 'primary',
      baseCurrency: 'USD',
      events: [
        envelope('dep-1', T1, 'main', {
          eventType: 'cash.deposit',
          amount: 99_000,
          currency: 'USD',
        }),
        EVENTS[1]!,
      ],
    });
    expect(portfolioLedgerContentHash(changedAmount.toJSON())).not.toBe(hash);

    const changedRelief = createPortfolioLedger({
      portfolioId: 'primary',
      baseCurrency: 'USD',
      lotRelief: 'lifo',
      events: EVENTS,
    });
    expect(portfolioLedgerContentHash(changedRelief.toJSON())).not.toBe(hash);

    const changedId = createPortfolioLedger({
      portfolioId: 'secondary',
      baseCurrency: 'USD',
      events: EVENTS,
    });
    expect(portfolioLedgerContentHash(changedId.toJSON())).not.toBe(hash);
  });

  it('hashing is stable across envelope key order', () => {
    const snapshot = ledger.toJSON();
    const reordered = JSON.parse(
      JSON.stringify({
        provenance: snapshot.provenance,
        events: snapshot.events,
        lotRelief: snapshot.lotRelief,
        baseCurrency: snapshot.baseCurrency,
        portfolioId: snapshot.portfolioId,
        schemaVersion: snapshot.schemaVersion,
        kind: snapshot.kind,
      }),
    ) as PortfolioLedgerSnapshot;
    expect(portfolioLedgerContentHash(reordered)).toBe(portfolioLedgerContentHash(snapshot));
  });
});

describe('the migration policy — explicit, never silent (Gate B Decision 7)', () => {
  const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: EVENTS });

  it('refuses a NEWER stored version outright', () => {
    const future = { ...ledger.toJSON(), schemaVersion: PORTFOLIO_LEDGER_SCHEMA_VERSION + 1 };
    expectCode(
      () => readPortfolioLedgerSnapshot({ snapshot: future }),
      'snapshot.unsupported_version',
    );
  });

  it('refuses an OLDER version without a registered migration', () => {
    const stored = { ...ledger.toJSON(), schemaVersion: 0 };
    expectCode(
      () => readPortfolioLedgerSnapshot({ snapshot: stored }),
      'artifact.migration_missing',
    );
  });

  it('restores an older version through a registered single-step migration, reported', () => {
    const stored = { ...ledger.toJSON(), schemaVersion: 0 };
    const migrations = createArtifactMigrationRegistry();
    migrations.register({
      kind: PORTFOLIO_LEDGER_KIND,
      fromVersion: 0,
      toVersion: 1,
      description: 'test fixture: v0 and v1 share one shape; the step only stamps the version',
      migrate: (stored0) => ({ ...stored0, schemaVersion: 1 }),
    });
    const { ledger: restored, migrationsApplied } = readPortfolioLedgerSnapshot({
      snapshot: stored,
      migrations,
    });
    expect(migrationsApplied).toEqual([
      {
        kind: PORTFOLIO_LEDGER_KIND,
        fromVersion: 0,
        toVersion: 1,
        description: 'test fixture: v0 and v1 share one shape; the step only stamps the version',
      },
    ]);
    expect(restored.state).toEqual(ledger.state);
  });

  it('teaches on a wrong kind, an unknown envelope key, and a policy-less envelope', () => {
    expectCode(
      () =>
        readPortfolioLedgerSnapshot({
          snapshot: { ...ledger.toJSON(), kind: 'totalfinance.market-snapshot' },
        }),
      'snapshot.kind_mismatch',
    );
    expectCode(
      () => readPortfolioLedgerSnapshot({ snapshot: { ...ledger.toJSON(), extra: 1 } }),
      'input.unknown_field',
    );
    const bare = { ...ledger.toJSON() } as Record<string, unknown>;
    delete bare['lotRelief'];
    expectCode(() => readPortfolioLedgerSnapshot({ snapshot: bare }), 'input.missing_field');
    expectCode(() => readPortfolioLedgerSnapshot({ snapshot: 42 }), 'snapshot.wrong_shape');
  });

  it('never hashes a malformed envelope (the Gate B lesson)', () => {
    const tampered = { ...ledger.toJSON(), extra: 1 } as unknown as PortfolioLedgerSnapshot;
    expectCode(() => portfolioLedgerContentHash(tampered), 'input.unknown_field');
  });
});
