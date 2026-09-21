/**
 * The portfolio-backtest journeys as request builders — one per lifecycle kind, the declarative
 * model, the direct callback, external flows, and the margin policies — shared by the golden
 * journey test, the stepper-equivalence test (Stage 7B.1 slice 1), and the environment suites.
 * Every builder returns a fresh request so a test may mutate its copy freely.
 */
import { isoDateToEpochMs, resolvedExpiry, type Bar } from '@totalfinance/core';
import { execution } from '@totalfinance/backtest/execution';
import type { InstrumentAdapter, PortfolioBacktestRequest } from '@totalfinance/backtest/portfolio';

export const DAY = 86_400_000;
export const START = '2026-01-05';
export const at = (day: number, hour = 21): number =>
  isoDateToEpochMs(START) + day * DAY + hour * 3_600_000;
export const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** Daily bars along a spot path (one per calendar day from START). */
export function bars(symbol: string, spots: readonly number[], volume = 1_000_000): Bar[] {
  return spots.map((close, i) => ({
    symbol,
    timestampMs: at(i),
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume,
  }));
}

export const flatPath = (days: number, level: number): number[] => new Array(days).fill(level);
export const drift = (days: number, start: number, step: number): number[] =>
  Array.from({ length: days }, (_, i) => start + i * step);

const buyAtFirstSession =
  (
    orders: readonly {
      orderId: string;
      instrumentId: string;
      side: 'buy' | 'sell';
      quantity: number;
    }[],
  ) =>
  (c: { index: number; asOf: number }) =>
    c.index === 0
      ? orders.map((o) => ({ ...o, type: 'market' as const, submittedTimestampMs: c.asOf }))
      : [];

export const equityRequest = (
  overrides: Partial<PortfolioBacktestRequest> = {},
): PortfolioBacktestRequest => ({
  accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
  instruments: { AAA: { kind: 'equity', currency: 'USD' } },
  marketData: { bars: bars('AAA', drift(10, 100, 1)) },
  strategy: {
    model: [
      { group: { instrumentId: 'AAA' }, weight: 0.6 },
      { group: { assetClass: 'cash' }, weight: 0.4 },
    ],
    schedule: { frequency: 'monthly' },
  },
  ...overrides,
});

/** A caller adapter for the `custom` journey (marks at the bar close, no lifecycle). */
export const indexLevelAdapter = (): InstrumentAdapter => ({
  kind: 'index-level',
  version: '1',
  mark: (input) =>
    input.latest.bar === undefined
      ? { unavailable: 'missing' }
      : { pricePerUnit: input.latest.bar.close, source: 'bar.close' },
  lifecycle: () => [],
  fillTerms: () => ({ settlementStyle: 'cash-on-trade' }),
});

export const marginPolicy = (forcedLiquidation: 'none' | 'pro-rata' | 'close-largest-loss') =>
  execution.declared({
    label: `test margin ${forcedLiquidation}`,
    margin: {
      buyingPowerMultiplier: 2,
      initialMarginRate: 0.5,
      maintenanceMarginRate: 0.5,
      forcedLiquidation,
    },
  });

export const marginRequest = (
  forcedLiquidation: 'none' | 'pro-rata' | 'close-largest-loss',
): PortfolioBacktestRequest => ({
  accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
  instruments: {
    AAA: { kind: 'equity', currency: 'USD' },
    BBB: { kind: 'equity', currency: 'USD' },
  },
  // both fall hard: the equity drops below half the gross notional
  marketData: { bars: [...bars('AAA', drift(6, 100, -8)), ...bars('BBB', drift(6, 100, -12))] },
  execution: marginPolicy(forcedLiquidation),
  strategy: {
    onSession: buyAtFirstSession([
      { orderId: 'a', instrumentId: 'AAA', side: 'buy', quantity: 900 },
      { orderId: 'b', instrumentId: 'BBB', side: 'buy', quantity: 900 },
    ]),
  },
});

/** Every journey by name; the keys are the golden file's keys. */
export function portfolioJourneys(): Record<string, PortfolioBacktestRequest> {
  const expiry = dateOf(at(5));
  const putTerms = {
    kind: 'option' as const,
    underlyingInstrumentId: 'AAA',
    type: 'put' as const,
    strikePricePerUnit: 100,
    expiryTimestampMs: resolvedExpiry(expiry).expiresAt,
  };
  const chains = Array.from({ length: 8 }, (_, i) => ({
    asOf: at(i),
    underlyingPrice: 100 - i,
    quotes: [
      {
        contract: {
          underlying: 'AAA',
          type: 'put' as const,
          style: 'european' as const,
          strike: 100,
          expiry,
          ...resolvedExpiry(expiry),
          multiplier: 100,
        },
        timestampMs: at(i),
        mid: Math.max(100 - (100 - i), 0) + 1,
        impliedVolatility: 0.2,
        underlyingPrice: 100 - i,
      },
    ],
  }));
  const near = { kind: 'future' as const, underlyingInstrumentId: 'IDX', expiryTimestampMs: at(5) };
  const far = { kind: 'future' as const, underlyingInstrumentId: 'IDX', expiryTimestampMs: at(20) };
  const maturity = at(4);
  const bondMaturity = dateOf(at(6));
  return {
    'model-monthly': equityRequest(),
    'direct-callback': equityRequest({
      strategy: {
        onSession: buyAtFirstSession([
          { orderId: 'buy', instrumentId: 'AAA', side: 'buy', quantity: 100 },
        ]),
      },
    }),
    'equity-dividend-split-t2': equityRequest({
      accounting: {
        baseCurrency: 'USD',
        initialCash: [{ currency: 'USD', amount: 100_000 }],
        settlement: { equity: 'T+2' },
      },
      marketData: {
        bars: bars('AAA', [...flatPath(4, 100), ...flatPath(6, 50)]),
        dividends: [{ instrumentId: 'AAA', exDate: dateOf(at(2)), amount: 1 }],
        corporateActions: [
          { symbol: 'AAA', effectiveDate: dateOf(at(4)), type: 'split', ratio: 2 },
        ],
      },
      strategy: {
        onSession: buyAtFirstSession([
          { orderId: 'buy', instrumentId: 'AAA', side: 'buy', quantity: 100 },
        ]),
      },
    }),
    'option-assignment': {
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: {
        AAA: { kind: 'equity', currency: 'USD' },
        'AAA P100': {
          kind: 'option',
          currency: 'USD',
          contractMultiplier: 100,
          contract: putTerms,
        },
      },
      marketData: { bars: bars('AAA', drift(8, 100, -1)), optionChains: chains },
      strategy: {
        onSession: buyAtFirstSession([
          { orderId: 'write', instrumentId: 'AAA P100', side: 'sell', quantity: 1 },
        ]),
      },
    },
    'future-roll-expiry': {
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: {
        F1: {
          kind: 'future',
          currency: 'USD',
          contractMultiplier: 10,
          contract: near,
          roll: { toInstrumentId: 'F2', sessionsBeforeExpiry: 1 },
        },
        F2: { kind: 'future', currency: 'USD', contractMultiplier: 10, contract: far },
      },
      marketData: { bars: [...bars('F1', drift(6, 1000, 5)), ...bars('F2', drift(10, 1010, 5))] },
      strategy: {
        onSession: buyAtFirstSession([
          { orderId: 'long', instrumentId: 'F1', side: 'buy', quantity: 2 },
        ]),
      },
    },
    'crypto-funding': {
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 1_000_000 }] },
      instruments: {
        BTC: { kind: 'crypto-spot', currency: 'USD' },
        'BTC-PERP': {
          kind: 'crypto-perpetual',
          currency: 'USD',
          contract: { kind: 'perpetual', underlyingInstrumentId: 'BTC' },
        },
      },
      marketData: {
        bars: [...bars('BTC', drift(6, 30_000, 100)), ...bars('BTC-PERP', drift(6, 30_010, 100))],
        fundingRates: [
          { instrumentId: 'BTC-PERP', timestampMs: at(1), fundingRate: 0.0001 },
          { instrumentId: 'BTC-PERP', timestampMs: at(3), fundingRate: -0.0002 },
        ],
      },
      calendar: 'ALWAYS_OPEN',
      strategy: {
        onSession: buyAtFirstSession([
          { orderId: 'spot', instrumentId: 'BTC', side: 'buy', quantity: 1 },
          { orderId: 'perp', instrumentId: 'BTC-PERP', side: 'buy', quantity: 2 },
        ]),
      },
    },
    'fx-forward-maturity': {
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 1_000_000 }] },
      instruments: {
        'EURUSD-FWD': {
          kind: 'fx-forward',
          currency: 'USD',
          forward: {
            maturityTimestampMs: maturity,
            baseCurrency: 'EUR',
            quoteCurrency: 'USD',
            contractRate: 1.1,
          },
        },
      },
      marketData: {
        forwardRates: Array.from({ length: 7 }, (_, i) => ({
          instrumentId: 'EURUSD-FWD',
          timestampMs: at(i),
          forwardRate: 1.1 + i * 0.01,
        })),
        fxRates: Array.from({ length: 7 }, (_, i) => ({
          timestampMs: at(i),
          baseCurrency: 'EUR',
          quoteCurrency: 'USD',
          quotePerBase: 1.1 + i * 0.01,
        })),
      },
      strategy: {
        onSession: buyAtFirstSession([
          { orderId: 'fwd', instrumentId: 'EURUSD-FWD', side: 'buy', quantity: 100_000 },
        ]),
      },
    },
    'bond-coupon-redemption': {
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 1_000_000 }] },
      instruments: {
        BOND: {
          kind: 'bond',
          currency: 'USD',
          coupon: {
            annualRate: 0.05,
            paymentsPerYear: 2,
            faceValuePerUnit: 100,
            issueDate: dateOf(at(-100)),
            maturityDate: bondMaturity,
          },
        },
      },
      marketData: {
        bars: bars('BOND', flatPath(8, 99)),
        coupons: [{ instrumentId: 'BOND', paymentDate: dateOf(at(3)), amountPerUnit: 2.5 }],
      },
      strategy: {
        onSession: buyAtFirstSession([
          { orderId: 'buy', instrumentId: 'BOND', side: 'buy', quantity: 1000 },
        ]),
      },
    },
    'custom-adapter': {
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: { X: { kind: 'custom', currency: 'USD', adapter: indexLevelAdapter() } },
      marketData: { bars: bars('X', drift(5, 10, 0.1)) },
      strategy: {
        onSession: buyAtFirstSession([
          { orderId: 'buy', instrumentId: 'X', side: 'buy', quantity: 100 },
        ]),
      },
    },
    'external-flows': equityRequest({
      externalFlows: [
        { timestampMs: at(2), amount: 50_000, currency: 'USD' },
        { timestampMs: at(5), amount: -20_000, currency: 'USD' },
      ],
    }),
    'margin-none': marginRequest('none'),
    'margin-pro-rata': marginRequest('pro-rata'),
    'margin-close-largest-loss': marginRequest('close-largest-loss'),
  };
}
