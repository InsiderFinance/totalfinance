/**
 * Stage 4.6 slice 1 — the normalized fill is the audited bridge from an execution fact to the
 * ledger's economic events: deterministic ids, the same fold as hand-written events, one fold for
 * a replayed fill, and a teaching refusal for every malformed field.
 */
import { describe, expect, it } from 'vitest';
import {
  NORMALIZED_FILL_KEYS,
  PORTFOLIO_EVENT_SCHEMA_VERSION,
  createPortfolioLedger,
  portfolioEventsFromFill,
  requireNormalizedFill,
  type NormalizedFill,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';

const T0 = Date.UTC(2026, 0, 5, 15);

function fill(
  overrides: Partial<NormalizedFill> = {},
  without: (keyof NormalizedFill)[] = [],
): NormalizedFill {
  const built: NormalizedFill = {
    fillId: 'f-1',
    accountId: 'main',
    instrumentId: 'AAPL',
    side: 'buy',
    quantity: 100,
    pricePerUnit: 150,
    currency: 'USD',
    filledTimestampMs: T0,
    orderId: 'o-1',
    costs: { commission: 1.5, exchangeFees: 0.25, regulatoryFees: 0, slippageAdjustment: 0.5 },
    ...overrides,
  };
  for (const key of without) delete (built as unknown as Record<string, unknown>)[key];
  return built;
}

function deposit(): PortfolioEventEnvelope {
  return {
    eventId: 'dep-1',
    schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
    eventType: 'cash.deposit',
    sourceId: 'test',
    accountId: 'main',
    effectiveTimestampMs: T0 - 86_400_000,
    recordedTimestampMs: T0 - 86_400_000,
    event: { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' },
    provenance: {},
  };
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('portfolioEventsFromFill — the bridge', () => {
  it('maps one fill to one trade.fill and one cost.charge per non-zero component, in a fixed order', () => {
    const events = portfolioEventsFromFill({
      fill: fill(),
      sourceId: 'backtest:run-1',
      recordedTimestampMs: T0 + 1,
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'trade.fill',
      'cost.charge',
      'cost.charge',
      'cost.charge',
    ]);
    expect(events.map((e) => e.eventId)).toEqual([
      'f-1',
      'f-1:cost:commission',
      'f-1:cost:exchangeFees',
      'f-1:cost:slippageAdjustment',
    ]);
    const charges = events
      .slice(1)
      .map((e) => e.event as { costType: string; amount: number; relatesToEventId?: string });
    expect(charges.map((c) => [c.costType, c.amount, c.relatesToEventId])).toEqual([
      ['commission', 1.5, 'f-1'],
      ['exchange-fee', 0.25, 'f-1'],
      ['slippage-adjustment', 0.5, 'f-1'],
    ]);
    for (const event of events) {
      expect(event.sourceId).toBe('backtest:run-1');
      expect(event.accountId).toBe('main');
      expect(event.effectiveTimestampMs).toBe(T0);
      expect(event.recordedTimestampMs).toBe(T0 + 1);
      expect(event.correlationId).toBe('o-1');
      expect(event.provenance).toEqual({});
    }
    expect(events[1]!.causationId).toBe('f-1');
  });

  it('folds to the same state as hand-written events, and a replayed fill folds once', () => {
    const fromFill = portfolioEventsFromFill({
      fill: fill(),
      sourceId: 'sim',
      recordedTimestampMs: T0,
    });
    const byHand: PortfolioEventEnvelope[] = [
      {
        eventId: 'f-1',
        schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
        eventType: 'trade.fill',
        sourceId: 'sim',
        accountId: 'main',
        effectiveTimestampMs: T0,
        recordedTimestampMs: T0,
        correlationId: 'o-1',
        event: {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 100,
          pricePerUnit: 150,
          currency: 'USD',
        },
        provenance: {},
      },
      ...(['commission', 'exchangeFees', 'slippageAdjustment'] as const).map(
        (component, i): PortfolioEventEnvelope => ({
          eventId: `f-1:cost:${component}`,
          schemaVersion: PORTFOLIO_EVENT_SCHEMA_VERSION,
          eventType: 'cost.charge',
          sourceId: 'sim',
          accountId: 'main',
          effectiveTimestampMs: T0,
          recordedTimestampMs: T0,
          correlationId: 'o-1',
          causationId: 'f-1',
          event: {
            eventType: 'cost.charge',
            costType: (['commission', 'exchange-fee', 'slippage-adjustment'] as const)[i]!,
            amount: [1.5, 0.25, 0.5][i]!,
            currency: 'USD',
            instrumentId: 'AAPL',
            relatesToEventId: 'f-1',
          },
          provenance: {},
        }),
      ),
    ];
    const a = createPortfolioLedger({ baseCurrency: 'USD', events: [deposit(), ...fromFill] });
    const b = createPortfolioLedger({ baseCurrency: 'USD', events: [deposit(), ...byHand] });
    expect(a.state).toEqual(b.state);
    expect(a.state.accounts['main']!.positions['AAPL']!.quantity).toBe(100);
    expect(a.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBeCloseTo(
      100_000 - 15_000 - 2.25,
      9,
    );
    // replay: the identical envelopes fold once (the ledger's duplicate boundary)
    const replayed = a.apply(fromFill);
    expect(replayed.state).toEqual(a.state);
    expect(replayed.events).toHaveLength(a.events.length);
  });

  it('carries derivative terms, settlement, accrued interest, and provenance through to the events', () => {
    const events = portfolioEventsFromFill({
      fill: fill(
        {
          instrumentId: 'ESZ6',
          contractMultiplier: 50,
          settlementStyle: 'variation-margin',
          contract: {
            kind: 'future',
            underlyingInstrumentId: 'ES',
            expiryTimestampMs: Date.UTC(2026, 11, 18, 14, 30),
          },
          settleTimestampMs: T0 + 3_600_000,
        },
        ['costs'],
      ),
      sourceId: 'sim',
      recordedTimestampMs: T0,
      provenance: { provider: 'fixture', dataset: 'unit' },
    });
    expect(events).toHaveLength(1);
    const event = events[0]!.event as unknown as Record<string, unknown>;
    expect(event['contractMultiplier']).toBe(50);
    expect(event['settlementStyle']).toBe('variation-margin');
    expect(event['contract']).toEqual({
      kind: 'future',
      underlyingInstrumentId: 'ES',
      expiryTimestampMs: Date.UTC(2026, 11, 18, 14, 30),
    });
    expect(event['settleTimestampMs']).toBe(T0 + 3_600_000);
    expect(events[0]!.provenance).toEqual({ provider: 'fixture', dataset: 'unit' });
    const bond = portfolioEventsFromFill({
      fill: fill({ instrumentId: 'T-2036', accruedInterest: 123.45 }, ['costs']),
      sourceId: 'sim',
      recordedTimestampMs: T0,
    });
    expect((bond[0]!.event as { accruedInterest?: number }).accruedInterest).toBe(123.45);
  });

  it('never mutates the fill and returns fresh events each call', () => {
    const input = fill();
    const snapshot = JSON.stringify(input);
    const first = portfolioEventsFromFill({
      fill: input,
      sourceId: 'sim',
      recordedTimestampMs: T0,
    });
    const second = portfolioEventsFromFill({
      fill: input,
      sourceId: 'sim',
      recordedTimestampMs: T0,
    });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(first).toEqual(second);
    expect(first[0]).not.toBe(second[0]);
  });

  it('teaches: every malformed field is a typed refusal that names the field', () => {
    const run = (overrides: Partial<NormalizedFill> | Record<string, unknown>) =>
      codeOf(() =>
        portfolioEventsFromFill({
          fill: { ...fill(), ...overrides } as NormalizedFill,
          sourceId: 'sim',
          recordedTimestampMs: T0,
        }),
      );
    expect(run({ extra: 1 })).toBe('input.unknown_field');
    expect(run({ side: 'long' })).toBe('input.invalid_enum');
    expect(run({ quantity: 0 })).toBe('input.out_of_range');
    expect(run({ quantity: -5 })).toBe('input.out_of_range');
    expect(run({ pricePerUnit: Number.NaN })).toBe('input.not_finite');
    expect(run({ settleTimestampMs: T0 - 1 })).toBe('input.out_of_range');
    expect(
      run({ contract: { kind: 'future', underlyingInstrumentId: 'ES', expiryTimestampMs: T0 } }),
    ).toBe('input.missing_field');
    expect(run({ costs: { commission: -1 } })).toBe('input.out_of_range');
    expect(run({ executionPriceAdjustment: -1 })).toBe('input.out_of_range');
    expect(run({ executionPriceAdjustment: NaN })).toBe('input.not_finite');
    expect(run({ executionPriceAdjustment: null })).toBe('input.wrong_type');
    expect(run({ costs: { rebate: 1 } as never })).toBe('input.unknown_field');
    expect(run({ liquidity: 'passive' as never })).toBe('input.invalid_enum');
    expect(run({ settlementStyle: 'net' as never })).toBe('input.invalid_enum');
    expect(
      codeOf(() =>
        portfolioEventsFromFill({ fill: fill(), sourceId: '', recordedTimestampMs: T0 }),
      ),
    ).toBe('input.wrong_type');
    expect(
      codeOf(() =>
        portfolioEventsFromFill({ fill: fill(), sourceId: 'sim', recordedTimestampMs: Number.NaN }),
      ),
    ).toBe('input.not_finite');
    expect(
      codeOf(() =>
        portfolioEventsFromFill({
          fill: fill(),
          sourceId: 'sim',
          recordedTimestampMs: T0,
          provenance: { vendor: 'x' } as never,
        }),
      ),
    ).toBe('input.unknown_field');
    expect(codeOf(() => requireNormalizedFill('t', 'fill', Object.create({ hidden: 1 })))).toBe(
      'input.wrong_type',
    );
  });

  it('the key list is the closed grammar', () => {
    expect([...NORMALIZED_FILL_KEYS]).toEqual([
      'fillId',
      'accountId',
      'instrumentId',
      'side',
      'quantity',
      'pricePerUnit',
      'currency',
      'filledTimestampMs',
      'settleTimestampMs',
      'contractMultiplier',
      'settlementStyle',
      'contract',
      'accruedInterest',
      'costs',
      'executionPriceAdjustment',
      'orderId',
      'venue',
      'liquidity',
    ]);
  });
});
