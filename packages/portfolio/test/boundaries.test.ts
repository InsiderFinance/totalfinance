/**
 * Boundary laws landed at the serial landing (2026-08-28): the package joined every repo gate
 * (garbage, deep, magnitude, count-safety, unknown-key) and each conviction became a law with the
 * discriminating test its absence permitted.
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  duplicateBoundaryKey,
  portfolioEventContentHash,
  portfolioPerformanceInputs,
  portfolioSnapshot,
  readPortfolioLedgerSnapshot,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
} from '../src/index.js';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';

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

const T0 = Date.UTC(2026, 0, 5, 15);
const deposit = (amount: number) =>
  envelope('dep-1', T0, 'main', { eventType: 'cash.deposit', amount, currency: 'USD' });

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('economic inputs are the exact stored bytes', () => {
  it('prototype-polluted fields cannot hash, fold, or mutate a prior state', () => {
    const previousState = applyPortfolioEvents({
      portfolio: { baseCurrency: 'USD' },
      events: [],
    });
    Object.defineProperty(Object.prototype, 'amount', {
      configurable: true,
      enumerable: true,
      value: 100,
      writable: true,
    });
    try {
      const candidate = envelope('polluted', T0, 'main', {
        eventType: 'cash.deposit',
        currency: 'USD',
      } as PortfolioEvent);
      const hashError = caught(() => portfolioEventContentHash(candidate));
      expect(isQuantError(hashError, 'input.wrong_shape')).toBe(true);
      const foldError = caught(() => applyPortfolioEvents({ previousState, events: [candidate] }));
      expect(isQuantError(foldError, 'input.wrong_shape')).toBe(true);
      expect(previousState.eventCount).toBe(0);
      expect(previousState.accounts).toEqual({});
    } finally {
      delete (Object.prototype as Record<string, unknown>)['amount'];
    }
  });
});

describe('Law 7 — a fold that leaves IEEE-754 range refuses with the input-driven teaching', () => {
  it('a near-MAX fill refuses instead of returning a state carrying Infinity', () => {
    const error = caught(() =>
      applyPortfolioEvents({
        portfolio: { baseCurrency: 'USD' },
        events: [
          deposit(1e300),
          envelope('fill-1', T0 + 1, 'main', {
            eventType: 'trade.fill',
            instrumentId: 'AAPL',
            side: 'buy',
            quantity: 1.7e308,
            pricePerUnit: 1.7e308,
            currency: 'USD',
          }),
        ],
      }),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toMatch(/IEEE-754|representable/);
  });

  it('two near-MAX deposits refuse — the true balance is past Number.MAX_VALUE', () => {
    const error = caught(() =>
      createPortfolioLedger({
        baseCurrency: 'USD',
        events: [
          deposit(1.7e308),
          envelope('dep-2', T0 + 1, 'main', {
            eventType: 'cash.deposit',
            amount: 1.7e308,
            currency: 'USD',
          }),
        ],
      }),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
  });

  it('a large but representable book folds normally', () => {
    const state = applyPortfolioEvents({
      portfolio: { baseCurrency: 'USD' },
      events: [deposit(1e300)],
    });
    expect(state.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(1e300);
  });
});

describe('restored state must agree with itself', () => {
  const state = applyPortfolioEvents({
    portfolio: { baseCurrency: 'USD' },
    events: [deposit(100)],
  });
  const market = createMarketSnapshot({ asOf: '2026-01-06T00:00:00Z', observations: {} });

  it('rejects hostile state and ledger metadata without invoking coercion or toJSON', () => {
    let calls = 0;
    const hostile = {
      toJSON(): never {
        calls += 1;
        throw new Error('must not execute metadata.toJSON');
      },
      [Symbol.toPrimitive](): never {
        calls += 1;
        throw new Error('must not execute metadata coercion');
      },
    };
    for (const previousState of [
      { ...state, schemaVersion: hostile },
      { ...state, lotRelief: hostile },
    ]) {
      expect(
        isQuantError(
          caught(() => applyPortfolioEvents({ previousState: previousState as never, events: [] })),
        ),
      ).toBe(true);
    }

    const snapshot = createPortfolioLedger({ baseCurrency: 'USD', events: [deposit(1)] }).toJSON();
    for (const metadata of [
      { kind: hostile },
      { schemaVersion: hostile },
      { lotRelief: hostile },
    ]) {
      expect(
        isQuantError(
          caught(() =>
            readPortfolioLedgerSnapshot({ snapshot: { ...snapshot, ...metadata } as never }),
          ),
        ),
      ).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it('an eventCount that disagrees with the applied-event registry is refused, not folded from', () => {
    const tampered = { ...state, eventCount: 2 ** 32 };
    for (const fn of [
      () => applyPortfolioEvents({ previousState: tampered, events: [] }),
      () => portfolioSnapshot({ portfolio: tampered, asOf: Date.UTC(2026, 0, 6), market }),
    ]) {
      const error = caught(fn);
      expect(isQuantError(error, 'input.out_of_range')).toBe(true);
      expect(String((error as Error).message)).toContain('appliedEvents');
    }
  });

  it('counters past 2^53 are corrupt state, not big numbers', () => {
    const error = caught(() =>
      applyPortfolioEvents({ previousState: { ...state, lotSequence: 2 ** 53 }, events: [] }),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toContain('2^53');
  });

  it('audits nested cash, positions, lots, effects, and timestamps before any reducer reads them', () => {
    const withPosition = applyPortfolioEvents({
      previousState: state,
      events: [
        envelope('fill-1', T0 + 1, 'main', {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 1,
          pricePerUnit: 10,
          currency: 'USD',
        }),
      ],
    });
    const main = withPosition.accounts['main']!;
    const cases = [
      {
        ...withPosition,
        accounts: { ...withPosition.accounts, main: { ...main, cashBalances: null } },
      },
      {
        ...withPosition,
        accounts: {
          ...withPosition.accounts,
          main: {
            ...main,
            positions: {
              ...main.positions,
              AAPL: { ...main.positions['AAPL']!, quantity: 2 },
            },
          },
        },
      },
      {
        ...withPosition,
        fillEffects: {
          ...withPosition.fillEffects,
          '["test","fill-1"]': {
            ...withPosition.fillEffects['["test","fill-1"]']!,
            openedLotIds: null,
          },
        },
      },
      {
        ...withPosition,
        accounts: {
          ...withPosition.accounts,
          main: {
            ...main,
            positions: {
              ...main.positions,
              AAPL: {
                ...main.positions['AAPL']!,
                lots: [
                  {
                    ...main.positions['AAPL']!.lots[0]!,
                    openedTimestampMs: withPosition.lastEffectiveTimestampMs! + 1,
                  },
                ],
              },
            },
          },
        },
      },
      { ...withPosition, lastEffectiveTimestampMs: 1e100 },
    ];
    for (const tampered of cases) {
      const error = caught(() =>
        applyPortfolioEvents({ previousState: tampered as never, events: [] }),
      );
      expect(isQuantError(error), String((error as Error)?.message)).toBe(true);
    }
  });

  it('refuses accessors, hidden required fields, and accessor array elements before reading them', () => {
    const accessor = JSON.parse(JSON.stringify(state)) as typeof state;
    Object.defineProperty(accessor.accounts['main'], 'cashBalances', {
      enumerable: true,
      get(): never {
        throw new Error('the state validator must not execute caller code');
      },
    });

    const hidden = JSON.parse(JSON.stringify(state)) as typeof state;
    Object.defineProperty(hidden, 'accounts', {
      enumerable: false,
      value: hidden.accounts,
      writable: true,
    });

    const withPosition = applyPortfolioEvents({
      previousState: state,
      events: [
        envelope('fill-descriptor', T0 + 1, 'main', {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 1,
          pricePerUnit: 10,
          currency: 'USD',
        }),
      ],
    });
    const accessorArray = JSON.parse(JSON.stringify(withPosition)) as typeof withPosition;
    const lots = accessorArray.accounts['main']!.positions['AAPL']!.lots;
    Object.defineProperty(lots, '0', {
      enumerable: true,
      get(): never {
        throw new Error('the state validator must inspect descriptors before values');
      },
    });

    for (const tampered of [accessor, hidden, accessorArray]) {
      const error = caught(() =>
        applyPortfolioEvents({ previousState: tampered as never, events: [] }),
      );
      expect(isQuantError(error, 'input.wrong_type'), String((error as Error)?.message)).toBe(true);
    }
  });

  it('does not let a restored lot counter reuse the identity of a historically closed lot', () => {
    const closed = applyPortfolioEvents({
      previousState: state,
      events: [
        envelope('buy-then-close', T0 + 1, 'main', {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 1,
          pricePerUnit: 10,
          currency: 'USD',
        }),
        envelope('close-the-buy', T0 + 2, 'main', {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'sell',
          quantity: 1,
          pricePerUnit: 11,
          currency: 'USD',
        }),
      ],
    });
    expect(closed.accounts['main']!.positions).toEqual({});
    const error = caught(() =>
      applyPortfolioEvents({ previousState: { ...closed, lotSequence: 0 }, events: [] }),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toContain('historically recorded lot suffix');
  });

  it('requires migration markers to preserve fold order and stay behind the state clock', () => {
    const migrated = applyPortfolioEvents({
      previousState: state,
      events: [
        envelope('migration-1', T0 + 1, 'main', {
          eventType: 'admin.account-migration',
          fromAccountId: 'legacy-a',
          toAccountId: 'current-a',
        }),
        envelope('migration-2', T0 + 2, 'main', {
          eventType: 'admin.account-migration',
          fromAccountId: 'legacy-b',
          toAccountId: 'current-b',
        }),
      ],
    });
    for (const accountMigrations of [
      [...migrated.accountMigrations].reverse(),
      [
        {
          ...migrated.accountMigrations[0]!,
          effectiveTimestampMs: migrated.lastEffectiveTimestampMs! + 1,
        },
        migrated.accountMigrations[1]!,
      ],
    ]) {
      const error = caught(() =>
        applyPortfolioEvents({ previousState: { ...migrated, accountMigrations }, events: [] }),
      );
      expect(isQuantError(error, 'input.out_of_range')).toBe(true);
      expect(String((error as Error).message)).toContain('preserve fold order');
    }
  });

  it('a stored envelope whose schemaVersion is not a safe integer is refused', () => {
    const snapshot = createPortfolioLedger({ baseCurrency: 'USD', events: [deposit(1)] }).toJSON();
    const error = caught(() =>
      readPortfolioLedgerSnapshot({ snapshot: { ...snapshot, schemaVersion: 2 ** 53 } }),
    );
    expect(isQuantError(error)).toBe(true);
  });
});

describe('boundaries teach — never a raw TypeError', () => {
  it('duplicateBoundaryKey with no envelope is a typed refusal', () => {
    for (const bad of [undefined, null, 42, {}, { sourceId: 'a' }]) {
      const error = caught(() => duplicateBoundaryKey(bad as never));
      expect(isQuantError(error), `input ${String(bad)}`).toBe(true);
    }
  });

  it('split share counts must be safe integers', () => {
    const error = caught(() =>
      applyPortfolioEvents({
        portfolio: { baseCurrency: 'USD' },
        events: [
          envelope('split-1', T0, 'main', {
            eventType: 'corporate.split',
            instrumentId: 'AAPL',
            sharesAfterSplit: 2 ** 53,
            sharesBeforeSplit: 1,
          }),
        ],
      }),
    );
    expect(isQuantError(error)).toBe(true);
    expect(String((error as Error).message)).toContain('safe-integer');
  });

  it('settlement timestamps use the complete epoch-millisecond ladder', () => {
    const error = caught(() =>
      applyPortfolioEvents({
        portfolio: { baseCurrency: 'USD' },
        events: [
          envelope('dep-future', T0, 'main', {
            eventType: 'cash.deposit',
            amount: 1,
            currency: 'USD',
            settleTimestampMs: 1e100,
          }),
        ],
      }),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toContain('epoch-millisecond');
  });
});

describe('open identities are safe dictionary keys, including JavaScript legacy names', () => {
  it('supports hostile-looking account/instrument ids without touching Object.prototype', () => {
    expect(Object.prototype).not.toHaveProperty('USD');
    const state = applyPortfolioEvents({
      portfolio: { baseCurrency: 'USD' },
      events: [
        envelope('income-1', T0, '__proto__', {
          eventType: 'income.received',
          incomeType: 'dividend',
          amount: 7,
          currency: 'USD',
          instrumentId: '__proto__',
        }),
        envelope('fill-1', T0 + 1, '__proto__', {
          eventType: 'trade.fill',
          instrumentId: 'constructor',
          side: 'buy',
          quantity: 1,
          pricePerUnit: 3,
          currency: 'USD',
        }),
        envelope('rename-1', T0 + 2, '__proto__', {
          eventType: 'corporate.symbol-change',
          fromInstrumentId: 'constructor',
          toInstrumentId: 'prototype',
        }),
      ],
    });
    expect(Object.prototype).not.toHaveProperty('USD');
    expect(Object.hasOwn(state.accounts, '__proto__')).toBe(true);
    const account = state.accounts['__proto__']!;
    expect(Object.hasOwn(account.incomeByInstrument, '__proto__')).toBe(true);
    expect(account.incomeByInstrument['__proto__']!['USD']).toBe(7);
    expect(Object.hasOwn(account.positions, 'prototype')).toBe(true);
    expect(account.positions['prototype']!.quantity).toBe(1);
    expect(Object.hasOwn(account.positions, 'constructor')).toBe(false);

    const restored = applyPortfolioEvents({
      previousState: JSON.parse(JSON.stringify(state)) as never,
      events: [],
    });
    expect(restored).toEqual(state);
    expect(Object.prototype).not.toHaveProperty('USD');
  });
});

describe('value objects are re-validated at every door (enforcement harness, 2026-08-28)', () => {
  const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [deposit(100)] });
  const marks = [
    {
      valuationDate: '2026-01-06',
      market: createMarketSnapshot({ asOf: '2026-01-06T00:00:00Z', observations: {} }),
    },
    {
      valuationDate: '2026-01-07',
      market: createMarketSnapshot({ asOf: '2026-01-07T00:00:00Z', observations: {} }),
    },
  ];

  it('the performance seam refuses a ledger missing its own methods or with a nulled field', () => {
    const { apply: _apply, ...withoutApply } = ledger;
    for (const bad of [
      withoutApply,
      { ...ledger, baseCurrency: null },
      { ...ledger, lotRelief: null },
      { ...ledger, baseCurrency: 'EUR' },
    ]) {
      const error = caught(() =>
        portfolioPerformanceInputs({ ledger: bad as never, valuationMarks: marks }),
      );
      expect(isQuantError(error), JSON.stringify(Object.keys(bad))).toBe(true);
    }
  });

  it('the ledger reader refuses a null or non-registry migrations argument', () => {
    const snapshot = ledger.toJSON();
    for (const bad of [null, 42, {}, { register() {} }]) {
      const error = caught(() =>
        readPortfolioLedgerSnapshot({ snapshot, migrations: bad as never }),
      );
      expect(isQuantError(error, 'input.wrong_type'), String(bad)).toBe(true);
    }
    expect(readPortfolioLedgerSnapshot({ snapshot }).ledger.state.eventCount).toBe(1);
  });
});
