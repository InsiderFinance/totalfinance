import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  PORTFOLIO_EVENT_SCHEMA_VERSION,
  duplicateBoundaryKey,
  portfolioEventContentHash,
  requirePortfolioEventEnvelope,
} from '@totalfinance/portfolio/events';
import type { PortfolioEvent, PortfolioEventEnvelope } from '@totalfinance/portfolio/events';

/** Test envelope builder: valid by construction, overridable per case. */
function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  accountId: string,
  event: PortfolioEvent,
  overrides: Partial<PortfolioEventEnvelope> = {},
): PortfolioEventEnvelope {
  return {
    eventId,
    schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
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

const T0 = Date.UTC(2026, 0, 5, 15);

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

describe('requirePortfolioEventEnvelope — Law 12 teaching validation', () => {
  it('accepts every first-slice event family', () => {
    const cases: PortfolioEvent[] = [
      { eventType: 'cash.deposit', amount: 1_000, currency: 'USD' },
      { eventType: 'cash.withdrawal', amount: 500, currency: 'USD', settleTimestampMs: T0 + 1 },
      {
        eventType: 'cash.transfer',
        amount: 100,
        currency: 'USD',
        fromAccountId: 'main',
        toAccountId: 'ira',
      },
      {
        eventType: 'cash.conversion',
        fromCurrency: 'USD',
        toCurrency: 'EUR',
        fromAmount: 1_000,
        toAmount: 920,
      },
      {
        eventType: 'trade.fill',
        instrumentId: 'AAPL',
        side: 'buy',
        quantity: 10,
        pricePerUnit: 150,
        currency: 'USD',
      },
      { eventType: 'cost.charge', costType: 'commission', amount: 1, currency: 'USD' },
      { eventType: 'income.received', incomeType: 'dividend', amount: 12, currency: 'USD' },
      {
        eventType: 'financing.charge',
        financingType: 'margin-interest',
        amount: 3,
        currency: 'USD',
      },
      {
        eventType: 'corporate.split',
        instrumentId: 'AAPL',
        sharesAfterSplit: 2,
        sharesBeforeSplit: 1,
      },
    ];
    cases.forEach((event, index) => {
      expect(() =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope(`e-${index}`, T0, 'main', event),
        ),
      ).not.toThrow();
    });
  });

  it('refuses an unknown envelope key by name', () => {
    const bad = envelope('e1', T0, 'main', {
      eventType: 'cash.deposit',
      amount: 1,
      currency: 'USD',
    }) as PortfolioEventEnvelope & { extra?: number };
    bad.extra = 1;
    expectCode(() => requirePortfolioEventEnvelope('test', 'envelope', bad), 'input.unknown_field');
  });

  it('refuses an unknown event-payload key by name', () => {
    const event = {
      eventType: 'cash.deposit',
      amount: 1,
      currency: 'USD',
      note: 'x',
    } as unknown as PortfolioEvent;
    expectCode(
      () => requirePortfolioEventEnvelope('test', 'envelope', envelope('e1', T0, 'main', event)),
      'input.unknown_field',
    );
  });

  it('refuses Object.prototype discriminator names with a typed enum error', () => {
    for (const eventType of ['constructor', '__proto__', 'prototype']) {
      const event = { eventType } as unknown as PortfolioEvent;
      const candidate = envelope('hostile-discriminator', T0, 'main', event);
      expectCode(
        () => requirePortfolioEventEnvelope('test', 'envelope', candidate),
        'input.invalid_enum',
      );
    }
  });

  it('refuses inherited economic fields instead of validating bytes that will not be hashed', () => {
    Object.defineProperty(Object.prototype, 'amount', {
      configurable: true,
      enumerable: true,
      value: 100,
      writable: true,
    });
    try {
      const event = { eventType: 'cash.deposit', currency: 'USD' } as unknown as PortfolioEvent;
      expectCode(
        () =>
          requirePortfolioEventEnvelope(
            'test',
            'envelope',
            envelope('polluted', T0, 'main', event),
          ),
        'input.wrong_shape',
      );
    } finally {
      delete (Object.prototype as Record<string, unknown>)['amount'];
    }
  });

  it('rejects nested accessors without invoking them and inherited envelope fields', () => {
    let getterCalled = false;
    const hostileEvent = { currency: 'USD', amount: 1 } as Record<string, unknown>;
    Object.defineProperty(hostileEvent, 'eventType', {
      enumerable: true,
      get(): never {
        getterCalled = true;
        throw new Error('must not execute');
      },
    });
    const accessorEnvelope = envelope('accessor', T0, 'main', {
      eventType: 'cash.deposit',
      amount: 1,
      currency: 'USD',
    });
    accessorEnvelope.event = hostileEvent as unknown as PortfolioEvent;
    expectCode(
      () => requirePortfolioEventEnvelope('test', 'envelope', accessorEnvelope),
      'input.wrong_type',
    );
    expect(getterCalled).toBe(false);

    Object.defineProperty(Object.prototype, 'sourceId', {
      configurable: true,
      enumerable: true,
      value: 'polluted-source',
      writable: true,
    });
    try {
      const inheritedEnvelope = envelope('inherited', T0, 'main', {
        eventType: 'cash.deposit',
        amount: 1,
        currency: 'USD',
      });
      delete (inheritedEnvelope as Partial<PortfolioEventEnvelope>).sourceId;
      expectCode(
        () => requirePortfolioEventEnvelope('test', 'envelope', inheritedEnvelope),
        'input.wrong_shape',
      );
    } finally {
      delete (Object.prototype as Record<string, unknown>)['sourceId'];
    }
  });

  it('requires provenance (an empty object is a valid "no further detail")', () => {
    const bare = envelope('e1', T0, 'main', {
      eventType: 'cash.deposit',
      amount: 1,
      currency: 'USD',
    });
    delete (bare as Partial<PortfolioEventEnvelope>).provenance;
    expectCode(
      () => requirePortfolioEventEnvelope('test', 'envelope', bare),
      'input.missing_field',
    );
  });

  it('validates provenance warnings exactly as the reducer stores them', () => {
    const valid = envelope(
      'warning-valid',
      T0,
      'main',
      { eventType: 'cash.deposit', amount: 1, currency: 'USD' },
      {
        provenance: {
          provider: 'broker',
          warnings: [
            {
              code: 'broker.estimated_time',
              message: 'Execution time was estimated.',
              severity: 'warn',
              context: { fields: ['executedAt'], confidence: 0.9 },
            },
          ],
        },
      },
    );
    expect(() => requirePortfolioEventEnvelope('test', 'envelope', valid)).not.toThrow();
    expect(portfolioEventContentHash(valid)).toMatch(/^sha256:/);

    const sparseWarnings = new Array(1);
    const sparse = envelope(
      'warning-sparse',
      T0,
      'main',
      { eventType: 'cash.deposit', amount: 1, currency: 'USD' },
      { provenance: { warnings: sparseWarnings } as never },
    );
    expectCode(
      () => requirePortfolioEventEnvelope('test', 'envelope', sparse),
      'input.wrong_shape',
    );
    expectCode(() => portfolioEventContentHash(sparse), 'input.wrong_shape');
  });

  it('rejects a hostile warning severity without invoking coercion or toJSON', () => {
    let calls = 0;
    const severity = {
      toJSON(): never {
        calls += 1;
        throw new Error('must not execute warning.toJSON');
      },
      [Symbol.toPrimitive](): never {
        calls += 1;
        throw new Error('must not execute warning coercion');
      },
    };
    const hostile = envelope(
      'warning-hostile-severity',
      T0,
      'main',
      { eventType: 'cash.deposit', amount: 1, currency: 'USD' },
      {
        provenance: {
          warnings: [{ code: 'broker.warning', message: 'warning', severity: severity as never }],
        },
      },
    );
    expectCode(
      () => requirePortfolioEventEnvelope('test', 'envelope', hostile),
      'input.invalid_enum',
    );
    expectCode(() => portfolioEventContentHash(hostile), 'input.invalid_enum');
    expect(calls).toBe(0);
  });

  it('rejects behavior nested in provenance without invoking it', () => {
    let getterCalled = false;
    const context: Record<string, unknown> = {};
    Object.defineProperty(context, 'symbol', {
      enumerable: true,
      get(): never {
        getterCalled = true;
        throw new Error('must not execute provenance accessor');
      },
    });
    const hostile = envelope(
      'warning-accessor',
      T0,
      'main',
      { eventType: 'cash.deposit', amount: 1, currency: 'USD' },
      {
        provenance: {
          warnings: [{ code: 'broker.warning', message: 'warning', severity: 'warn', context }],
        },
      },
    );
    expectCode(
      () => requirePortfolioEventEnvelope('test', 'envelope', hostile),
      'input.wrong_type',
    );
    expect(getterCalled).toBe(false);
  });

  it('refuses a foreign schemaVersion with the migration teaching', () => {
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope(
            'e1',
            T0,
            'main',
            { eventType: 'cash.deposit', amount: 1, currency: 'USD' },
            { schemaVersion: 2 },
          ),
        ),
      'snapshot.unsupported_version',
    );
  });

  it('refuses an envelope/payload discriminator mismatch', () => {
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope(
            'e1',
            T0,
            'main',
            { eventType: 'cash.deposit', amount: 1, currency: 'USD' },
            { eventType: 'cash.withdrawal' },
          ),
        ),
      'input.out_of_range',
    );
  });

  it('teaches the uppercase fix for a lowercase currency code', () => {
    expect(() =>
      requirePortfolioEventEnvelope(
        'test',
        'envelope',
        envelope('e1', T0, 'main', {
          eventType: 'cash.deposit',
          amount: 1,
          currency: 'usd',
        } as unknown as PortfolioEvent),
      ),
    ).toThrowError(/write it as 'USD'/);
  });

  it('refuses non-positive amounts, zero costs, and a settle time before the effect', () => {
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'main', { eventType: 'cash.deposit', amount: 0, currency: 'USD' }),
        ),
      'input.out_of_range',
    );
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'main', {
            eventType: 'cost.charge',
            costType: 'commission',
            amount: 0,
            currency: 'USD',
          }),
        ),
      'input.out_of_range',
    );
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'main', {
            eventType: 'cash.deposit',
            amount: 1,
            currency: 'USD',
            settleTimestampMs: T0 - 1,
          }),
        ),
      'input.out_of_range',
    );
  });

  it('refuses a self-transfer, a transfer recorded against the wrong account, and a same-currency conversion', () => {
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'main', {
            eventType: 'cash.transfer',
            amount: 1,
            currency: 'USD',
            fromAccountId: 'main',
            toAccountId: 'main',
          }),
        ),
      'input.out_of_range',
    );
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'other', {
            eventType: 'cash.transfer',
            amount: 1,
            currency: 'USD',
            fromAccountId: 'main',
            toAccountId: 'ira',
          }),
        ),
      'input.out_of_range',
    );
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'main', {
            eventType: 'cash.conversion',
            fromCurrency: 'USD',
            toCurrency: 'USD',
            fromAmount: 1,
            toAmount: 1,
          }),
        ),
      'input.out_of_range',
    );
  });

  it('refuses bad enums and bad splits with the whole legal list named', () => {
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'main', {
            eventType: 'cost.charge',
            costType: 'spread',
            amount: 1,
            currency: 'USD',
          } as unknown as PortfolioEvent),
        ),
      'input.invalid_enum',
    );
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'main', {
            eventType: 'corporate.split',
            instrumentId: 'AAPL',
            sharesAfterSplit: 1.5,
            sharesBeforeSplit: 1,
          }),
        ),
      'input.out_of_range',
    );
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'main', {
            eventType: 'corporate.split',
            instrumentId: 'AAPL',
            sharesAfterSplit: 1,
            sharesBeforeSplit: 1,
          }),
        ),
      'input.out_of_range',
    );
  });

  it('refuses duplicate lotSelection lotIds', () => {
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('e1', T0, 'main', {
            eventType: 'trade.fill',
            instrumentId: 'AAPL',
            side: 'sell',
            quantity: 10,
            pricePerUnit: 100,
            currency: 'USD',
            lotSelections: [
              { lotId: 'lot-1', quantity: 5 },
              { lotId: 'lot-1', quantity: 5 },
            ],
          }),
        ),
      'input.out_of_range',
    );
  });

  it('refuses sparse lot selections and contracts opened or rolled after expiry', () => {
    const sparse = new Array<{ lotId: string; quantity: number }>(1);
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('sparse', T0, 'main', {
            eventType: 'trade.fill',
            instrumentId: 'AAPL',
            side: 'sell',
            quantity: 1,
            pricePerUnit: 100,
            currency: 'USD',
            lotSelections: sparse,
          }),
        ),
      'input.wrong_shape',
    );

    const expiredFuture = {
      kind: 'future' as const,
      underlyingInstrumentId: 'ES',
      expiryTimestampMs: T0 - 1,
    };
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('expired-fill', T0, 'main', {
            eventType: 'trade.fill',
            instrumentId: 'ESH6',
            side: 'buy',
            quantity: 1,
            pricePerUnit: 5_000,
            currency: 'USD',
            contractMultiplier: 50,
            settlementStyle: 'variation-margin',
            contract: expiredFuture,
          }),
        ),
      'input.out_of_range',
    );
    expectCode(
      () =>
        requirePortfolioEventEnvelope(
          'test',
          'envelope',
          envelope('expired-roll', T0, 'main', {
            eventType: 'derivative.roll',
            fromInstrumentId: 'ESH6',
            toInstrumentId: 'ESM6',
            quantity: 1,
            closePricePerUnit: 5_000,
            openPricePerUnit: 5_010,
            contract: expiredFuture,
          }),
        ),
      'input.out_of_range',
    );
  });
});

describe('portfolioEventContentHash — the duplicate/conflict identity', () => {
  const base = envelope('e1', T0, 'main', {
    eventType: 'cash.deposit',
    amount: 1_000,
    currency: 'USD',
  });

  it('is stable across object key order (canonical JSON)', () => {
    const reordered = {
      provenance: {},
      event: { currency: 'USD', amount: 1_000, eventType: 'cash.deposit' },
      recordedTimestampMs: T0,
      effectiveTimestampMs: T0,
      accountId: 'main',
      sourceId: 'test',
      eventType: 'cash.deposit',
      schemaVersion: 1,
      eventId: 'e1',
    } as unknown as PortfolioEventEnvelope;
    expect(portfolioEventContentHash(reordered)).toBe(portfolioEventContentHash(base));
  });

  it('EXCLUDES provenance (two vendors delivering the same fact are the same event)', () => {
    const relabeled = envelope(
      'e1',
      T0,
      'main',
      { eventType: 'cash.deposit', amount: 1_000, currency: 'USD' },
      { provenance: { provider: 'broker-import', dataset: 'activity' } },
    );
    expect(portfolioEventContentHash(relabeled)).toBe(portfolioEventContentHash(base));
  });

  it('covers the economic body — any amount/timestamp/account change changes the hash', () => {
    const hash = portfolioEventContentHash(base);
    expect(
      portfolioEventContentHash(
        envelope('e1', T0, 'main', { eventType: 'cash.deposit', amount: 1_001, currency: 'USD' }),
      ),
    ).not.toBe(hash);
    expect(
      portfolioEventContentHash(
        envelope('e1', T0 + 1, 'main', {
          eventType: 'cash.deposit',
          amount: 1_000,
          currency: 'USD',
        }),
      ),
    ).not.toBe(hash);
    expect(
      portfolioEventContentHash(
        envelope('e1', T0, 'ira', { eventType: 'cash.deposit', amount: 1_000, currency: 'USD' }),
      ),
    ).not.toBe(hash);
  });

  it('refuses to hash a malformed envelope (no confident hash for bad data)', () => {
    expectCode(
      () => portfolioEventContentHash({ eventId: 'e1' } as unknown as PortfolioEventEnvelope),
      'input.wrong_type',
    );
  });
});

describe('duplicateBoundaryKey', () => {
  it('is the canonical (sourceId, eventId) pair — payload-independent', () => {
    const a = envelope('e1', T0, 'main', {
      eventType: 'cash.deposit',
      amount: 1,
      currency: 'USD',
    });
    const b = envelope(
      'e1',
      T0 + 5,
      'ira',
      { eventType: 'cash.withdrawal', amount: 2, currency: 'EUR' },
      {},
    );
    expect(duplicateBoundaryKey(a)).toBe(duplicateBoundaryKey(b));
    expect(duplicateBoundaryKey(a)).toBe('["test","e1"]');
  });
});
