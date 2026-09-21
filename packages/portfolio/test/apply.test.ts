import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { applyPortfolioEvents } from '@totalfinance/portfolio';
import type {
  LotReliefPolicy,
  PortfolioEvent,
  PortfolioEventEnvelope,
  PortfolioState,
} from '@totalfinance/portfolio';

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

const T = {
  deposit: Date.UTC(2026, 0, 5, 15),
  buy1: Date.UTC(2026, 0, 6, 15),
  commission: Date.UTC(2026, 0, 6, 15, 1),
  buy2: Date.UTC(2026, 1, 2, 15),
  sell: Date.UTC(2026, 2, 2, 15),
  dividend: Date.UTC(2026, 2, 16, 12),
  financing: Date.UTC(2026, 3, 1, 12),
  split: Date.UTC(2026, 3, 15, 12),
  transfer: Date.UTC(2026, 4, 1, 12),
  conversion: Date.UTC(2026, 4, 4, 12),
  buyEur: Date.UTC(2026, 4, 5, 12),
  sell2: Date.UTC(2026, 4, 6, 15),
} as const;

/** The hand-computed golden journey, parameterized by the sell's relief instructions. */
function journey(sellOverrides: Partial<PortfolioEvent> = {}): PortfolioEventEnvelope[] {
  return [
    envelope('dep-1', T.deposit, 'main', {
      eventType: 'cash.deposit',
      amount: 100_000,
      currency: 'USD',
    }),
    envelope('fill-1', T.buy1, 'main', {
      eventType: 'trade.fill',
      instrumentId: 'AAPL',
      side: 'buy',
      quantity: 100,
      pricePerUnit: 150,
      currency: 'USD',
    }),
    envelope('cost-1', T.commission, 'main', {
      eventType: 'cost.charge',
      costType: 'commission',
      amount: 10,
      currency: 'USD',
      instrumentId: 'AAPL',
      relatesToEventId: 'fill-1',
    }),
    envelope('fill-2', T.buy2, 'main', {
      eventType: 'trade.fill',
      instrumentId: 'AAPL',
      side: 'buy',
      quantity: 50,
      pricePerUnit: 160,
      currency: 'USD',
    }),
    envelope('fill-3', T.sell, 'main', {
      eventType: 'trade.fill',
      instrumentId: 'AAPL',
      side: 'sell',
      quantity: 120,
      pricePerUnit: 170,
      currency: 'USD',
      ...sellOverrides,
    } as PortfolioEvent),
    envelope('div-1', T.dividend, 'main', {
      eventType: 'income.received',
      incomeType: 'dividend',
      amount: 24,
      currency: 'USD',
      instrumentId: 'AAPL',
    }),
    envelope('fin-1', T.financing, 'main', {
      eventType: 'financing.charge',
      financingType: 'margin-interest',
      amount: 14,
      currency: 'USD',
    }),
    envelope('split-1', T.split, 'main', {
      eventType: 'corporate.split',
      instrumentId: 'AAPL',
      sharesAfterSplit: 2,
      sharesBeforeSplit: 1,
    }),
    envelope('xfer-1', T.transfer, 'main', {
      eventType: 'cash.transfer',
      amount: 10_000,
      currency: 'USD',
      fromAccountId: 'main',
      toAccountId: 'ira',
    }),
    envelope('conv-1', T.conversion, 'ira', {
      eventType: 'cash.conversion',
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromAmount: 5_000,
      toAmount: 4_600,
    }),
    envelope('fill-eur', T.buyEur, 'ira', {
      eventType: 'trade.fill',
      instrumentId: 'SAP',
      side: 'buy',
      quantity: 10,
      pricePerUnit: 200,
      currency: 'EUR',
      settleTimestampMs: T.buyEur + 2 * 86_400_000,
    }),
    envelope('fill-4', T.sell2, 'main', {
      eventType: 'trade.fill',
      instrumentId: 'AAPL',
      side: 'sell',
      quantity: 20,
      pricePerUnit: 90,
      currency: 'USD',
    }),
  ];
}

function fold(
  events: PortfolioEventEnvelope[],
  lotRelief: LotReliefPolicy = 'fifo',
): PortfolioState {
  return applyPortfolioEvents({ portfolio: { baseCurrency: 'USD', lotRelief }, events });
}

describe('golden journey — every figure hand-computed (FC7 exit-gate journey, first-slice families)', () => {
  const state = fold(journey());
  const main = state.accounts['main']!;
  const ira = state.accounts['ira']!;

  it('reconciles cash to the cent at the end of the journey', () => {
    // 100_000 − 15_000 − 10 − 8_000 + 20_400 + 24 − 14 − 10_000 + 1_800 = 89_200
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(89_200, 9);
    // ira: +10_000 − 5_000 (converted) = 5_000 USD; +4_600 − 2_000 = 2_600 EUR
    expect(ira.cashBalances['USD']!.totalAmount).toBeCloseTo(5_000, 9);
    expect(ira.cashBalances['EUR']!.totalAmount).toBeCloseTo(2_600, 9);
  });

  it('derives the FIFO position: 40 post-split shares at 80 basis, one lot', () => {
    const position = main.positions['AAPL']!;
    // FIFO sell of 120: all 100 of lot-1 @150, 20 of lot-2 @160 → lot-2 keeps 30 @160.
    // 2:1 split → 60 @ 80. Final sell of 20 @90 → 40 @ 80 remain.
    expect(position.quantity).toBeCloseTo(40, 9);
    expect(position.lots).toHaveLength(1);
    expect(position.lots[0]!.quantity).toBeCloseTo(40, 9);
    expect(position.lots[0]!.costBasisPerUnit).toBeCloseTo(80, 9);
    expect(position.currency).toBe('USD');
  });

  it('reconciles realized P&L under FIFO: 2_200 + 200 = 2_400', () => {
    // fill-3: (170−150)×100 + (170−160)×20 = 2_200; fill-4 post-split: (90−80)×20 = 200.
    expect(main.realizedPnl['USD']!).toBeCloseTo(2_400, 9);
  });

  it('keeps income, transaction costs, and financing as separate components', () => {
    expect(main.incomeReceived['USD']!).toBeCloseTo(24, 9);
    expect(main.transactionCosts['USD']!).toBeCloseTo(10, 9);
    expect(main.financingCosts['USD']!).toBeCloseTo(14, 9);
  });

  it('conserves acquired basis: realized proceeds − realized P&L + remaining basis = total cost', () => {
    // Pre-split acquisitions: 100×150 + 50×160 = 23_000. fill-3 relieves basis 18_200
    // (= 20_400 proceeds − 2_200 realized); post-split fill-4 relieves 20×80 = 1_600
    // (= 1_800 − 200). Remaining: 40×80 = 3_200. 18_200 + 1_600 + 3_200 = 23_000.
    const position = main.positions['AAPL']!;
    const remainingBasis = position.lots.reduce(
      (sum, lot) => sum + lot.quantity * lot.costBasisPerUnit,
      0,
    );
    const proceeds = 120 * 170 + 20 * 90;
    const realized = main.realizedPnl['USD']!;
    expect(proceeds - realized + remainingBasis).toBeCloseTo(23_000, 9);
  });

  it('nets internal transfers to zero across the portfolio (never an external flow effect)', () => {
    const totalUsd = main.cashBalances['USD']!.totalAmount + ira.cashBalances['USD']!.totalAmount;
    // The transfer moved 10_000 without changing the portfolio total.
    expect(totalUsd).toBeCloseTo(94_200, 9);
  });

  it('books the unsettled EUR fill leg on the settlement schedule', () => {
    const eur = ira.cashBalances['EUR']!;
    expect(eur.settlementSchedule).toHaveLength(1);
    expect(eur.settlementSchedule[0]!.amount).toBeCloseTo(-2_000, 9);
    expect(eur.settlementSchedule[0]!.eventId).toBe('fill-eur');
    expect(eur.settlementSchedule[0]!.settleTimestampMs).toBe(T.buyEur + 2 * 86_400_000);
  });

  it('preserves total basis exactly through the 2:1 split', () => {
    // At the split: lot-2 holds 30 @160 = 4_800 → 60 @80 = 4_800. Exact, not approximate.
    const preSplit = fold(journey().slice(0, 8));
    const position = preSplit.accounts['main']!.positions['AAPL']!;
    expect(position.quantity).toBe(60);
    expect(position.lots[0]!.quantity * position.lots[0]!.costBasisPerUnit).toBe(4_800);
  });

  it('every position quantity equals the sum of its lot quantities', () => {
    for (const account of Object.values(state.accounts)) {
      for (const position of Object.values(account.positions)) {
        const lotSum = position.lots.reduce((sum, lot) => sum + lot.quantity, 0);
        expect(position.quantity).toBeCloseTo(lotSum, 12);
      }
    }
  });
});

describe('lot relief policies — the decided set, each hand-computed', () => {
  it('LIFO relieves the newest lot first: realized 1_900, lot-1 keeps 30 @150', () => {
    const state = fold(journey().slice(0, 5), 'lifo');
    const main = state.accounts['main']!;
    // 50 from lot-2: (170−160)×50 = 500; 70 from lot-1: (170−150)×70 = 1_400.
    expect(main.realizedPnl['USD']!).toBeCloseTo(1_900, 9);
    const position = main.positions['AAPL']!;
    expect(position.lots).toHaveLength(1);
    expect(position.lots[0]!.costBasisPerUnit).toBe(150);
    expect(position.lots[0]!.quantity).toBeCloseTo(30, 9);
  });

  it('highest-cost relieves the priciest basis first (minimizing the gain)', () => {
    const state = fold(journey().slice(0, 5), 'highest-cost');
    const main = state.accounts['main']!;
    // lot-2 @160 first (50), then lot-1 @150 (70) → same arithmetic as LIFO here.
    expect(main.realizedPnl['USD']!).toBeCloseTo(1_900, 9);
    expect(main.positions['AAPL']!.lots[0]!.costBasisPerUnit).toBe(150);
  });

  it('specific-lot relieves exactly the named lots', () => {
    const state = fold(
      journey({
        lotSelections: [
          { lotId: 'lot-2', quantity: 50 },
          { lotId: 'lot-1', quantity: 70 },
        ],
      } as Partial<PortfolioEvent>).slice(0, 5),
      'specific-lot',
    );
    const main = state.accounts['main']!;
    expect(main.realizedPnl['USD']!).toBeCloseTo(1_900, 9);
    const position = main.positions['AAPL']!;
    expect(position.lots).toHaveLength(1);
    expect(position.lots[0]!.lotId).toBe('lot-1');
    expect(position.lots[0]!.quantity).toBeCloseTo(30, 9);
  });

  it('specific-lot refuses a missing selection, a bad sum, an unknown lot, and an overdrawn lot', () => {
    const base = journey().slice(0, 5);
    expectCode(() => fold(base, 'specific-lot'), 'input.missing_field');
    expectCode(
      () =>
        fold(
          journey({
            lotSelections: [{ lotId: 'lot-1', quantity: 100 }],
          } as Partial<PortfolioEvent>).slice(0, 5),
          'specific-lot',
        ),
      'input.out_of_range',
    );
    expectCode(
      () =>
        fold(
          journey({
            lotSelections: [
              { lotId: 'lot-9', quantity: 70 },
              { lotId: 'lot-2', quantity: 50 },
            ],
          } as Partial<PortfolioEvent>).slice(0, 5),
          'specific-lot',
        ),
      'portfolio.lot_unavailable',
    );
    expectCode(
      () =>
        fold(
          journey({
            lotSelections: [
              { lotId: 'lot-2', quantity: 70 },
              { lotId: 'lot-1', quantity: 50 },
            ],
          } as Partial<PortfolioEvent>).slice(0, 5),
          'specific-lot',
        ),
      'portfolio.lot_unavailable',
    );
  });

  it('refuses lotSelections under any other policy, and on a pure open under specific-lot', () => {
    expectCode(
      () =>
        fold(
          journey({
            lotSelections: [{ lotId: 'lot-1', quantity: 120 }],
          } as Partial<PortfolioEvent>).slice(0, 5),
          'fifo',
        ),
      'input.out_of_range',
    );
    expectCode(
      () =>
        applyPortfolioEvents({
          portfolio: { baseCurrency: 'USD', lotRelief: 'specific-lot' },
          events: [
            envelope('open-1', T.buy1, 'main', {
              eventType: 'trade.fill',
              instrumentId: 'AAPL',
              side: 'buy',
              quantity: 10,
              pricePerUnit: 100,
              currency: 'USD',
              lotSelections: [{ lotId: 'lot-1', quantity: 10 }],
            }),
          ],
        }),
      'input.out_of_range',
    );
  });
});

describe('short positions — sell to open, buy to cover, cross through zero', () => {
  const events = [
    envelope('s-1', T.deposit, 'main', {
      eventType: 'trade.fill',
      instrumentId: 'TSLA',
      side: 'sell',
      quantity: 50,
      pricePerUnit: 300,
      currency: 'USD',
    }),
    envelope('s-2', T.buy1, 'main', {
      eventType: 'trade.fill',
      instrumentId: 'TSLA',
      side: 'buy',
      quantity: 20,
      pricePerUnit: 280,
      currency: 'USD',
    }),
    envelope('s-3', T.buy2, 'main', {
      eventType: 'trade.fill',
      instrumentId: 'TSLA',
      side: 'buy',
      quantity: 40,
      pricePerUnit: 310,
      currency: 'USD',
    }),
  ];
  const state = fold(events);
  const main = state.accounts['main']!;

  it('realizes short P&L on cover and crosses into a long lot', () => {
    // Cover 20 @280: (300−280)×20 = 400. Cover 30 @310: (300−310)×30 = −300. Net +100.
    expect(main.realizedPnl['USD']!).toBeCloseTo(100, 9);
    const position = main.positions['TSLA']!;
    expect(position.quantity).toBeCloseTo(10, 9);
    expect(position.lots).toHaveLength(1);
    expect(position.lots[0]!.quantity).toBeCloseTo(10, 9);
    expect(position.lots[0]!.costBasisPerUnit).toBe(310);
  });

  it('reconciles cash: proceeds in, covers out', () => {
    // +15_000 − 5_600 − 12_400 = −3_000
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(-3_000, 9);
  });
});

describe('the replay law — a ledger is a fold over its events', () => {
  const events = journey();

  it('same events → deep-equal state (two independent folds)', () => {
    expect(fold(events)).toEqual(fold(events));
  });

  it('incremental folding (previousState) equals the one-shot fold', () => {
    const oneShot = fold(events);
    let incremental = applyPortfolioEvents({
      portfolio: { baseCurrency: 'USD', lotRelief: 'fifo' },
      events: events.slice(0, 4),
    });
    incremental = applyPortfolioEvents({ previousState: incremental, events: events.slice(4, 9) });
    incremental = applyPortfolioEvents({ previousState: incremental, events: events.slice(9) });
    expect(incremental).toEqual(oneShot);
  });

  it('an identical replay is a no-op — event by event and as a whole batch', () => {
    const once = fold(events);
    const replayed = applyPortfolioEvents({ previousState: once, events });
    expect(replayed).toEqual(once);
  });

  it('a provenance-only change is still the same event (no-op, not a conflict)', () => {
    const once = fold(events);
    const relabeled = events.map((event) => ({
      ...event,
      provenance: { provider: 'second-vendor' },
    }));
    expect(applyPortfolioEvents({ previousState: once, events: relabeled })).toEqual(once);
  });

  it('a changed payload under the same (sourceId, eventId) is a typed conflict', () => {
    const once = fold(events);
    const conflicting = envelope('dep-1', T.deposit, 'main', {
      eventType: 'cash.deposit',
      amount: 99_999,
      currency: 'USD',
    });
    expectCode(
      () => applyPortfolioEvents({ previousState: once, events: [conflicting] }),
      'portfolio.duplicate_event_conflict',
    );
  });

  it('refuses an out-of-order batch with the sorting teaching', () => {
    const swapped = [events[1]!, events[0]!];
    expectCode(() => fold(swapped), 'input.out_of_range');
  });
});

describe('reducer boundary — Law 12 and immutability', () => {
  const events = journey();

  it('requires exactly one of portfolio / previousState', () => {
    expectCode(() => applyPortfolioEvents({ events } as never), 'input.missing_field');
    const state = fold(events);
    expectCode(
      () =>
        applyPortfolioEvents({
          portfolio: { baseCurrency: 'USD' },
          previousState: state,
          events,
        }),
      'input.out_of_range',
    );
  });

  it('defaults lotRelief to fifo and echoes the policy on the state', () => {
    const state = applyPortfolioEvents({ portfolio: { baseCurrency: 'USD' }, events: [] });
    expect(state.lotRelief).toBe('fifo');
    expect(state.baseCurrency).toBe('USD');
    expect(state.eventCount).toBe(0);
  });

  it('never mutates inputs and returns a deeply frozen state', () => {
    const frozenEvents = journey().map((event) => Object.freeze(event));
    const before = JSON.stringify(frozenEvents);
    const state = fold(frozenEvents as unknown as PortfolioEventEnvelope[]);
    expect(JSON.stringify(frozenEvents)).toBe(before);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.accounts['main'])).toBe(true);
    expect(Object.isFrozen(state.accounts['main']!.positions['AAPL']!.lots[0])).toBe(true);
    const previous = state;
    const snapshotBefore = JSON.stringify(previous);
    applyPortfolioEvents({
      previousState: previous,
      events: [
        envelope('extra-1', T.sell2 + 1, 'main', {
          eventType: 'cash.deposit',
          amount: 1,
          currency: 'USD',
        }),
      ],
    });
    expect(JSON.stringify(previous)).toBe(snapshotBefore);
  });

  it('refuses a mixed-currency fill into an open position', () => {
    expectCode(
      () =>
        fold([
          envelope('f-1', T.buy1, 'main', {
            eventType: 'trade.fill',
            instrumentId: 'SAP',
            side: 'buy',
            quantity: 10,
            pricePerUnit: 200,
            currency: 'EUR',
          }),
          envelope('f-2', T.buy2, 'main', {
            eventType: 'trade.fill',
            instrumentId: 'SAP',
            side: 'buy',
            quantity: 10,
            pricePerUnit: 220,
            currency: 'USD',
          }),
        ]),
      'input.out_of_range',
    );
  });

  it('refuses a split on an instrument the account does not hold', () => {
    expectCode(
      () =>
        fold([
          envelope('split-x', T.split, 'main', {
            eventType: 'corporate.split',
            instrumentId: 'MSFT',
            sharesAfterSplit: 2,
            sharesBeforeSplit: 1,
          }),
        ]),
      'input.out_of_range',
    );
  });
});
