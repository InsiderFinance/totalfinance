/**
 * FC7 slice 5 — the instrument profile a position carries (contract multiplier, settlement style,
 * derivative terms), accrued interest on bond fills, valuation of multiplier and variation-margin
 * positions, and the fill reversal through its recorded cash delta. Every number is hand-computed.
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  PORTFOLIO_STATE_SCHEMA_VERSION,
  allocatePortfolio,
  createPortfolioLedger,
  portfolioSnapshot,
  portfolioTimeline,
  reconcilePortfolio,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
} from '../src/index.js';

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

const at = (month: number, day: number, hour = 15) => Date.UTC(2026, month - 1, day, hour);

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const DEPOSIT = envelope('dep-1', at(1, 2), 'main', {
  eventType: 'cash.deposit',
  amount: 100_000,
  currency: 'USD',
});

const CALL_TERMS = {
  kind: 'option' as const,
  underlyingInstrumentId: 'AAPL',
  type: 'call' as const,
  strikePricePerUnit: 200,
  expiryTimestampMs: at(6, 19),
};

/** Buy 2 AAPL 200 calls at 5.00 with a 100 multiplier: premium 2 × 5 × 100 = 1,000. */
const BUY_CALLS = envelope('opt-1', at(1, 10), 'main', {
  eventType: 'trade.fill',
  instrumentId: 'AAPL 2026-06-19 C200',
  side: 'buy',
  quantity: 2,
  pricePerUnit: 5,
  currency: 'USD',
  contractMultiplier: 100,
  contract: CALL_TERMS,
});

/** Buy 2 ES futures at 4,500 with a 50 multiplier: no cash at the fill. */
const BUY_FUTURES = envelope('fut-1', at(1, 12), 'main', {
  eventType: 'trade.fill',
  instrumentId: 'ESH6',
  side: 'buy',
  quantity: 2,
  pricePerUnit: 4_500,
  currency: 'USD',
  contractMultiplier: 50,
  settlementStyle: 'variation-margin',
  contract: { kind: 'future', underlyingInstrumentId: 'ES', expiryTimestampMs: at(3, 20) },
});

function market(asOf: string, spots: Record<string, number>) {
  return createMarketSnapshot({
    asOf,
    observations: {
      spots: Object.fromEntries(
        Object.entries(spots).map(([id, price]) => [id, { price, currency: 'USD' }]),
      ),
    },
  });
}

describe('the instrument profile a position carries (state schema 4)', () => {
  it('a multiplier fill books quantity × price × multiplier and the position remembers its profile', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY_CALLS] });
    const main = ledger.state.accounts['main']!;
    expect(ledger.state.schemaVersion).toBe(PORTFOLIO_STATE_SCHEMA_VERSION);
    expect(main.cashBalances['USD']!.totalAmount).toBe(99_000);
    const position = main.positions['AAPL 2026-06-19 C200']!;
    expect(position.contractMultiplier).toBe(100);
    expect(position.settlementStyle).toBe('cash-on-trade');
    expect(position.contract).toEqual(CALL_TERMS);
    // The lot basis stays PER UNIT (5 per share of deliverable), never per contract.
    expect(position.lots[0]!.costBasisPerUnit).toBe(5);
    expect(ledger.state.fillEffects['["test","opt-1"]']!.cashDelta).toBe(-1_000);
    // A plain equity fill carries the neutral profile.
    const shares = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [
        DEPOSIT,
        envelope('fill-1', at(1, 5), 'main', {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 10,
          pricePerUnit: 150,
          currency: 'USD',
        }),
      ],
    });
    expect(shares.state.accounts['main']!.positions['AAPL']).toMatchObject({
      contractMultiplier: 1,
      settlementStyle: 'cash-on-trade',
    });
  });

  it('a variation-margin fill books no cash, and a later fill must agree with the profile', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY_FUTURES] });
    expect(ledger.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(100_000);
    expect(ledger.state.accounts['main']!.positions['ESH6']!.settlementStyle).toBe(
      'variation-margin',
    );
    // Same instrument, different multiplier → one profile per open position.
    const disagreeing = caught(() =>
      ledger.apply([
        envelope('fut-2', at(1, 13), 'main', {
          eventType: 'trade.fill',
          instrumentId: 'ESH6',
          side: 'buy',
          quantity: 1,
          pricePerUnit: 4_510,
          currency: 'USD',
          contractMultiplier: 20,
          settlementStyle: 'variation-margin',
          contract: { kind: 'future', underlyingInstrumentId: 'ES', expiryTimestampMs: at(3, 20) },
        }),
      ]),
    );
    expect(isQuantError(disagreeing, 'input.out_of_range')).toBe(true);
    expect((disagreeing as Error).message).toContain('contractMultiplier 20');
    // Closing half at 4,530 realizes (4,530 − 4,500) × 1 × 50 = 1,500 in cash (the fill reducer).
    const closed = ledger.apply([
      envelope('fut-3', at(1, 14), 'main', {
        eventType: 'trade.fill',
        instrumentId: 'ESH6',
        side: 'sell',
        quantity: 1,
        pricePerUnit: 4_530,
        currency: 'USD',
        contractMultiplier: 50,
        settlementStyle: 'variation-margin',
        contract: { kind: 'future', underlyingInstrumentId: 'ES', expiryTimestampMs: at(3, 20) },
      }),
    ]);
    expect(closed.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(101_500);
    expect(closed.state.accounts['main']!.realizedPnl['USD']).toBe(1_500);
    expect(closed.state.fillEffects['["test","fut-3"]']!.cashDelta).toBe(1_500);

    const datedOpen = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [
        envelope('fut-dated', at(1, 12), 'margin', {
          eventType: 'trade.fill',
          instrumentId: 'ESH6',
          side: 'buy',
          quantity: 2,
          pricePerUnit: 4_500,
          currency: 'USD',
          contractMultiplier: 50,
          settlementStyle: 'variation-margin',
          contract: { kind: 'future', underlyingInstrumentId: 'ES', expiryTimestampMs: at(3, 20) },
          settleTimestampMs: at(1, 14),
        }),
      ],
    });
    expect(datedOpen.state.accounts['margin']!.cashBalances).toEqual({});
    const original = datedOpen.events[0]!;
    const reversed = datedOpen.apply([
      envelope(
        'reverse-zero-cash-fill',
        at(1, 15),
        'margin',
        { eventType: 'admin.reversal', original },
        { reversesEventId: original.eventId },
      ),
    ]);
    expect(reversed.state.accounts['margin']!.cashBalances).toEqual({});
    expect(reversed.state.accounts['margin']!.positions).toEqual({});
  });

  it('derivative-only lifecycle events refuse an ordinary cash instrument with a multiplier', () => {
    const shares = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [
        DEPOSIT,
        envelope('shares-1', at(1, 5), 'main', {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 10,
          pricePerUnit: 150,
          currency: 'USD',
          contractMultiplier: 2,
        }),
      ],
    });
    for (const event of [
      {
        eventType: 'derivative.multiplier-change' as const,
        instrumentId: 'AAPL',
        contractMultiplierAfter: 3,
      },
      {
        eventType: 'derivative.roll' as const,
        fromInstrumentId: 'AAPL',
        toInstrumentId: 'AAPL-NEXT',
        quantity: 1,
        closePricePerUnit: 151,
        openPricePerUnit: 152,
      },
    ]) {
      const error = caught(() =>
        shares.apply([envelope(`bad-${event.eventType}`, at(1, 6), 'main', event)]),
      );
      expect(isQuantError(error, 'input.out_of_range')).toBe(true);
      expect((error as Error).message).toContain('explicit contract terms');
    }
  });

  it('accrued interest on a bond fill is an income adjustment, never basis', () => {
    // Buy 10,000 face at 0.98 (m 1) with 125 accrued: cash −9,800 − 125; income −125; basis 0.98.
    const ledger = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [
        DEPOSIT,
        envelope('bond-1', at(1, 6), 'main', {
          eventType: 'trade.fill',
          instrumentId: 'UST-2031',
          side: 'buy',
          quantity: 10_000,
          pricePerUnit: 0.98,
          currency: 'USD',
          accruedInterest: 125,
        }),
      ],
    });
    const main = ledger.state.accounts['main']!;
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(100_000 - 9_800 - 125, 9);
    expect(main.incomeReceived['USD']).toBe(-125);
    expect(main.incomeByInstrument['UST-2031']!['USD']).toBe(-125);
    expect(main.positions['UST-2031']!.lots[0]!.costBasisPerUnit).toBe(0.98);
    // The next coupon makes net income 350 − 125 = 225 over the holding.
    const withCoupon = ledger.apply([
      envelope('cpn-1', at(2, 15), 'main', {
        eventType: 'income.received',
        incomeType: 'coupon',
        amount: 350,
        currency: 'USD',
        instrumentId: 'UST-2031',
      }),
    ]);
    expect(withCoupon.state.accounts['main']!.incomeByInstrument['UST-2031']!['USD']).toBe(225);
    // Reversing the fill restores cash and the income adjustment exactly.
    const reversed = withCoupon.apply([
      envelope(
        'rev-bond',
        at(2, 16),
        'main',
        { eventType: 'admin.reversal', original: ledger.events[1]! },
        { reversesEventId: 'bond-1' },
      ),
    ]);
    expect(reversed.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBeCloseTo(
      100_350,
      9,
    );
    expect(reversed.state.accounts['main']!.incomeByInstrument['UST-2031']!['USD']).toBe(350);
    expect(reversed.state.accounts['main']!.positions['UST-2031']).toBeUndefined();
  });

  it('the fill grammar refuses an incoherent profile with a teaching', () => {
    const refuse = (event: Record<string, unknown>, code: string, fragment: string): void => {
      const error = caught(() =>
        createPortfolioLedger({
          baseCurrency: 'USD',
          events: [envelope('x', at(1, 3), 'main', event as unknown as PortfolioEvent)],
        }),
      );
      expect(isQuantError(error, code), String((error as Error)?.message)).toBe(true);
      expect((error as Error).message).toContain(fragment);
    };
    const base = {
      eventType: 'trade.fill',
      instrumentId: 'X',
      side: 'buy',
      quantity: 1,
      pricePerUnit: 10,
      currency: 'USD',
    };
    refuse(
      { ...base, contract: CALL_TERMS },
      'input.missing_field',
      'contractMultiplier is required',
    );
    refuse(
      {
        ...base,
        contractMultiplier: 50,
        contract: { kind: 'future', underlyingInstrumentId: 'ES', expiryTimestampMs: at(3, 20) },
      },
      'input.out_of_range',
      "must be 'variation-margin'",
    );
    refuse(
      {
        ...base,
        contractMultiplier: 100,
        settlementStyle: 'variation-margin',
        contract: CALL_TERMS,
      },
      'input.out_of_range',
      "must be 'cash-on-trade'",
    );
    refuse(
      { ...base, settlementStyle: 'variation-margin' },
      'input.missing_field',
      'contract is required',
    );
    refuse(
      { ...base, contractMultiplier: 50, settlementStyle: 'variation-margin' },
      'input.missing_field',
      'contract is required',
    );
    refuse({ ...base, contractMultiplier: 0 }, 'input.out_of_range', 'contractMultiplier');
    refuse({ ...base, accruedInterest: -5 }, 'input.out_of_range', 'unsigned');
    refuse(
      { ...base, contractMultiplier: 100, contract: { ...CALL_TERMS, kind: 'warrant' } },
      'input.invalid_enum',
      'kind',
    );
  });
});

describe('an OCC-style adjustment restates the strike with the multiplier', () => {
  it('carries the adjusted strike onto the position and preserves total basis; a future has no strike', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY_CALLS] });
    // 2-for-1 on the underlying: 100 → 200 deliverable, strike 200 → 100; basis 5 → 2.5 per unit.
    const adjusted = ledger.apply([
      envelope('adj-1', at(1, 20), 'main', {
        eventType: 'derivative.multiplier-change',
        instrumentId: 'AAPL 2026-06-19 C200',
        contractMultiplierAfter: 200,
        strikePricePerUnitAfter: 100,
        reason: '2-for-1 split of AAPL',
      }),
    ]);
    const position = adjusted.state.accounts['main']!.positions['AAPL 2026-06-19 C200']!;
    expect(position.contractMultiplier).toBe(200);
    expect(position.contract).toEqual({ ...CALL_TERMS, strikePricePerUnit: 100 });
    expect(position.lots[0]!.costBasisPerUnit).toBe(2.5);
    expect(position.lots[0]!.quantity * position.lots[0]!.costBasisPerUnit * 200).toBe(1_000);
    const futures = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY_FUTURES] });
    const noStrike = caught(() =>
      futures.apply([
        envelope('adj-2', at(1, 20), 'main', {
          eventType: 'derivative.multiplier-change',
          instrumentId: 'ESH6',
          contractMultiplierAfter: 25,
          strikePricePerUnitAfter: 100,
        }),
      ]),
    );
    expect(isQuantError(noStrike, 'input.out_of_range')).toBe(true);
    expect((noStrike as Error).message).toContain('only an option has a strike');
  });
});

describe('valuation, exposure, sizing, and reconciliation carry the multiplier', () => {
  it('a cash-on-trade option values at quantity × mark × multiplier; a future contributes unsettled P&L but exposes its notional', () => {
    const ledger = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [DEPOSIT, BUY_CALLS, BUY_FUTURES],
    });
    const valued = portfolioSnapshot({
      portfolio: ledger.state,
      asOf: '2026-02-01T00:00:00Z',
      market: market('2026-02-01', { 'AAPL 2026-06-19 C200': 7, ESH6: 4_520 }),
    });
    const calls = valued.positions.find((p) => p.instrumentId === 'AAPL 2026-06-19 C200')!;
    // 2 × 7 × 100 = 1,400 market value; basis 2 × 5 × 100 = 1,000; unrealized 400.
    expect(calls.marketValue).toBe(1_400);
    expect(calls.notionalValue).toBe(1_400);
    expect(calls.costBasis).toBe(1_000);
    expect(calls.unrealizedPnl).toBe(400);
    expect(calls.contractMultiplier).toBe(100);
    const futures = valued.positions.find((p) => p.instrumentId === 'ESH6')!;
    // Unsettled P&L (4,520 − 4,500) × 2 × 50 = 2,000; notional 2 × 4,520 × 50 = 452,000.
    expect(futures.marketValue).toBe(2_000);
    expect(futures.costBasis).toBe(0);
    expect(futures.unrealizedPnl).toBe(2_000);
    expect(futures.notionalValue).toBe(452_000);
    expect(futures.settlementStyle).toBe('variation-margin');
    // NAV = 99,000 cash + 1,400 + 2,000.
    expect(valued.netAssetValue).toBe(102_400);
    // Exposure is notional: long 1,400 + 452,000.
    const timeline = portfolioTimeline({
      ledger,
      valuationMarks: [
        {
          valuationDate: '2026-01-15',
          market: market('2026-01-15', { 'AAPL 2026-06-19 C200': 5, ESH6: 4_500 }),
        },
        {
          valuationDate: '2026-02-01',
          market: market('2026-02-01', { 'AAPL 2026-06-19 C200': 7, ESH6: 4_520 }),
        },
      ],
    });
    // At the second mark: long exposure 1,400 + 452,000 = 453,400 over NAV 102,400.
    expect(timeline.rows[1]!.exposure.long).toBe(453_400);
    expect(timeline.rows[1]!.exposure.grossLeverage).toBeCloseTo(453_400 / 102_400, 12);
    // At the first mark the future has no unsettled P&L: NAV = 99,000 + 1,000 + 0.
    expect(timeline.rows[0]!.netAssetValue).toBe(100_000);
  });

  it('allocation sizes against price × multiplier and reconciliation compares basis × multiplier', () => {
    const plan = allocatePortfolio({
      policy: {
        targets: [
          { group: { instrumentId: 'AAPL 2026-06-19 C200' }, weight: 0.014 },
          { group: { assetClass: 'cash' }, weight: 0.986 },
        ],
      },
      asOf: '2026-02-01T00:00:00Z',
      baseCurrency: 'USD',
      netAssetValue: 100_000,
      prices: { 'AAPL 2026-06-19 C200': { price: 7, currency: 'USD' } },
      currentHoldings: { 'AAPL 2026-06-19 C200': 1 },
      contractMultipliers: { 'AAPL 2026-06-19 C200': 100 },
      defaultLotSize: 1,
    });
    // Target notional 1,400 ÷ (7 × 100) = 2 contracts; held 1 → buy 1 for 700.
    const row = plan.allocations[0]!;
    expect(row.contractMultiplier).toBe(100);
    expect(row.targetQuantity).toBe(2);
    expect(row.tradeQuantity).toBe(1);
    expect(row.tradeNotional).toBe(700);
    expect(row.currentQuantity).toBe(1);
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY_CALLS] });
    const report = reconcilePortfolio({
      portfolio: ledger.state,
      asOf: '2026-02-01T00:00:00Z',
      external: {
        asOf: '2026-02-01T00:00:00Z',
        accounts: {
          main: {
            cash: { USD: { total: 99_000 } },
            positions: [
              // The broker states basis in currency terms: 2 × 5 × 100 = 1,000.
              {
                instrumentId: 'AAPL 2026-06-19 C200',
                quantity: 2,
                currency: 'USD',
                costBasis: 1_000,
              },
            ],
          },
        },
      },
      tolerance: { quantity: 1e-9, cashAmount: 0.01 },
    });
    expect(report.reconciled).toBe(true);
    expect(report.accounts[0]!.positions[0]!.costBasis?.difference ?? 0).toBe(0);
  });
});
