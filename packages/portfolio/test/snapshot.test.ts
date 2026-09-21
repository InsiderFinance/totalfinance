import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { convertCurrency } from '@totalfinance/foreign-exchange';
import type { CurrencyPairQuote as ForeignExchangeCurrencyPairQuote } from '@totalfinance/foreign-exchange';
import { applyPortfolioEvents, portfolioSnapshot } from '@totalfinance/portfolio';
import type {
  CurrencyPairQuote,
  PortfolioEvent,
  PortfolioEventEnvelope,
} from '@totalfinance/portfolio';

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
const SETTLE = Date.UTC(2026, 0, 8, 21);
const AS_OF = Date.UTC(2026, 0, 7, 21);

/**
 * State: main holds 85_000 USD cash + 100 AAPL @150; ira holds 2_600 EUR cash (of which a
 * −2_000 leg settles at SETTLE) + 10 SAP @200 EUR (short journey, hand-computed).
 */
const STATE = applyPortfolioEvents({
  portfolio: { baseCurrency: 'USD' },
  events: [
    envelope('dep-1', T1, 'main', { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' }),
    envelope('dep-2', T1, 'ira', { eventType: 'cash.deposit', amount: 4_600, currency: 'EUR' }),
    envelope('fill-1', T2, 'main', {
      eventType: 'trade.fill',
      instrumentId: 'AAPL',
      side: 'buy',
      quantity: 100,
      pricePerUnit: 150,
      currency: 'USD',
    }),
    envelope('fill-2', T2, 'ira', {
      eventType: 'trade.fill',
      instrumentId: 'SAP',
      side: 'buy',
      quantity: 10,
      pricePerUnit: 200,
      currency: 'EUR',
      settleTimestampMs: SETTLE,
    }),
  ],
});

const EURUSD: CurrencyPairQuote = { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 };

const MARKET = createMarketSnapshot({
  asOf: AS_OF,
  observations: {
    spots: {
      AAPL: { price: 170, currency: 'USD' },
      SAP: { price: 210, currency: 'EUR' },
    },
  },
});

describe('portfolioSnapshot — explicit market/as-of valuation, every figure hand-computed', () => {
  const valued = portfolioSnapshot({
    portfolio: STATE,
    asOf: AS_OF,
    market: MARKET,
    currencyConversions: [EURUSD],
  });

  it('reconciles NAV = cash base value + position base value (the conservation identity)', () => {
    // Cash: 85_000 USD + 2_600 EUR × 1.08 = 85_000 + 2_808 = 87_808
    // Positions: 100×170 = 17_000 USD; 10×210 = 2_100 EUR × 1.08 = 2_268 → 19_268
    expect(valued.totalCashBaseCurrencyValue).toBeCloseTo(87_808, 9);
    expect(valued.totalPositionsBaseCurrencyValue).toBeCloseTo(19_268, 9);
    expect(valued.netAssetValue).toBeCloseTo(107_076, 9);
    expect(valued.netAssetValue).toBeCloseTo(
      valued.totalCashBaseCurrencyValue + valued.totalPositionsBaseCurrencyValue,
      12,
    );
  });

  it('classifies the unsettled buy leg as payable before settlement', () => {
    const iraEur = valued.cash.find((row) => row.accountId === 'ira' && row.currency === 'EUR')!;
    // AS_OF < SETTLE: the −2_000 leg has not settled — cash still counts as settled money
    // plus a payable of 2_000: settled = 2_600 − 0 + 2_000 = 4_600.
    expect(iraEur.totalAmount).toBeCloseTo(2_600, 9);
    expect(iraEur.unsettledPayable).toBeCloseTo(2_000, 9);
    expect(iraEur.unsettledReceivable).toBe(0);
    expect(iraEur.settledAmount).toBeCloseTo(4_600, 9);
    // The identity: totalAmount = settledAmount + receivable − payable.
    expect(iraEur.totalAmount).toBeCloseTo(
      iraEur.settledAmount + iraEur.unsettledReceivable - iraEur.unsettledPayable,
      12,
    );
  });

  it('classifies the same leg as settled once asOf passes settlement', () => {
    const later = portfolioSnapshot({
      portfolio: STATE,
      asOf: SETTLE,
      market: MARKET,
      currencyConversions: [EURUSD],
    });
    const iraEur = later.cash.find((row) => row.accountId === 'ira' && row.currency === 'EUR')!;
    expect(iraEur.unsettledPayable).toBe(0);
    expect(iraEur.settledAmount).toBeCloseTo(2_600, 9);
  });

  it('marks unrealized P&L per position in trading and base currency', () => {
    const aapl = valued.positions.find((row) => row.instrumentId === 'AAPL')!;
    expect(aapl.costBasis).toBeCloseTo(15_000, 9);
    expect(aapl.unrealizedPnl).toBeCloseTo(2_000, 9);
    expect(aapl.baseCurrencyUnrealizedPnl).toBeCloseTo(2_000, 9);
    const sap = valued.positions.find((row) => row.instrumentId === 'SAP')!;
    expect(sap.unrealizedPnl).toBeCloseTo(100, 9);
    expect(sap.baseCurrencyUnrealizedPnl).toBeCloseTo(108, 9);
  });

  it('echoes the policy, the conventions floor, and the quotes actually used', () => {
    expect(valued.assumptions.lotRelief).toBe('fifo');
    expect(typeof valued.assumptions.conventionsVersion).toBe('string');
    expect(valued.assumptions.currencyConversionsUsed).toEqual([EURUSD]);
    expect(typeof valued.assumptions.valuationConvention).toBe('string');
    expect(valued.diagnostics.warnings).toEqual([]);
    expect(Object.isFrozen(valued)).toBe(true);
    expect(Object.isFrozen(EURUSD)).toBe(false); // the caller's quote is never frozen
  });

  it('discloses a market observed at another instant', () => {
    const drifted = portfolioSnapshot({
      portfolio: STATE,
      asOf: AS_OF + 60_000,
      market: MARKET,
      currencyConversions: [EURUSD],
    });
    expect(
      drifted.diagnostics.warnings.some(
        (w) => w.includes('another instant') || w.includes('marks from another instant'),
      ),
    ).toBe(true);
  });
});

describe('unavailable marks are typed failures, never guesses', () => {
  it('refuses a held instrument with no spot', () => {
    const market = createMarketSnapshot({
      asOf: AS_OF,
      observations: { spots: { AAPL: { price: 170, currency: 'USD' } } },
    });
    expectCode(
      () =>
        portfolioSnapshot({
          portfolio: STATE,
          asOf: AS_OF,
          market,
          currencyConversions: [EURUSD],
        }),
      'portfolio.mark_unavailable',
    );
  });

  it('refuses a currency-less spot for a held position', () => {
    const market = createMarketSnapshot({
      asOf: AS_OF,
      observations: {
        spots: { AAPL: { price: 170 }, SAP: { price: 210, currency: 'EUR' } },
      },
    });
    expectCode(
      () =>
        portfolioSnapshot({
          portfolio: STATE,
          asOf: AS_OF,
          market,
          currencyConversions: [EURUSD],
        }),
      'input.missing_field',
    );
  });

  it('refuses a spot quoted in a different currency than the lots', () => {
    const market = createMarketSnapshot({
      asOf: AS_OF,
      observations: {
        spots: { AAPL: { price: 170, currency: 'USD' }, SAP: { price: 226.8, currency: 'USD' } },
      },
    });
    expectCode(
      () =>
        portfolioSnapshot({
          portfolio: STATE,
          asOf: AS_OF,
          market,
          currencyConversions: [EURUSD],
        }),
      'portfolio.mark_unavailable',
    );
  });

  it('refuses a missing pair quote and an ambiguous duplicate pair', () => {
    expectCode(
      () => portfolioSnapshot({ portfolio: STATE, asOf: AS_OF, market: MARKET }),
      'portfolio.mark_unavailable',
    );
    expectCode(
      () =>
        portfolioSnapshot({
          portfolio: STATE,
          asOf: AS_OF,
          market: MARKET,
          currencyConversions: [
            EURUSD,
            { baseCurrency: 'USD', quoteCurrency: 'EUR', quotePerBase: 1 / 1.08 },
          ],
        }),
      'input.out_of_range',
    );
  });
});

describe('FC5 vocabulary reuse — parity with @totalfinance/foreign-exchange (never invented FX math)', () => {
  it('the CurrencyPairQuote types are mutually assignable (compile-time parity)', () => {
    const portfolioQuote: CurrencyPairQuote = EURUSD;
    const foreignExchangeQuote: ForeignExchangeCurrencyPairQuote = portfolioQuote;
    const backAgain: CurrencyPairQuote = foreignExchangeQuote;
    expect(backAgain).toEqual(EURUSD);
  });

  it('valuation-time conversion equals convertCurrency exactly — direct orientation', () => {
    const valued = portfolioSnapshot({
      portfolio: STATE,
      asOf: AS_OF,
      market: MARKET,
      currencyConversions: [EURUSD],
    });
    const iraEur = valued.cash.find((row) => row.accountId === 'ira' && row.currency === 'EUR')!;
    const direct = convertCurrency({
      amount: iraEur.totalAmount,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      spotRate: EURUSD,
    });
    expect(direct.assumptions.orientation).toBe('direct');
    expect(iraEur.baseCurrencyValue).toBe(direct.convertedAmount);
  });

  it('valuation-time conversion equals convertCurrency exactly — inverted orientation', () => {
    const usdPerEurInverted: CurrencyPairQuote = {
      baseCurrency: 'USD',
      quoteCurrency: 'EUR',
      quotePerBase: 0.9259,
    };
    const valued = portfolioSnapshot({
      portfolio: STATE,
      asOf: AS_OF,
      market: MARKET,
      currencyConversions: [usdPerEurInverted],
    });
    const iraEur = valued.cash.find((row) => row.accountId === 'ira' && row.currency === 'EUR')!;
    const viaForeignExchange = convertCurrency({
      amount: iraEur.totalAmount,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      spotRate: usdPerEurInverted,
    });
    expect(viaForeignExchange.assumptions.orientation).toBe('inverted');
    expect(iraEur.baseCurrencyValue).toBe(viaForeignExchange.convertedAmount);
  });
});
