/** R03/R04: independently priced signed obligations, entitlement and maturity cash balances. */
import { describe, expect, it } from 'vitest';
import { ErrorCode, isoDateToEpochMs, type Bar } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { applyPortfolioEvents, portfolioSnapshot } from '@totalfinance/portfolio';
import {
  instrumentAdapters,
  portfolioBacktest,
  requirePortfolioMarketData,
  type LifecycleInput,
  type PortfolioBacktestResult,
  type PortfolioMarketData,
} from '@totalfinance/backtest/portfolio';

const DAY = 86_400_000;
const at = (i: number) => isoDateToEpochMs('2026-01-05') + i * DAY + 15 * 3_600_000;
const date = (i: number) => new Date(at(i)).toISOString().slice(0, 10);
const bars = (symbol: string): Bar[] =>
  Array.from({ length: 8 }, (_, i) => ({
    symbol,
    timestampMs: at(i),
    open: 100,
    high: 100,
    low: 100,
    close: 100,
  }));
const input = (quantity: number | null): LifecycleInput => ({
  instrumentId: 'AAA',
  specification: { kind: 'equity', currency: 'USD' },
  asOf: at(3),
  previousAsOf: at(2),
  held: quantity === null ? null : { quantity, contractMultiplier: 2 },
  mark: { pricePerUnit: 100, source: 'test' },
  underlyingMark: null,
  last: false,
  facts: { dividends: [], corporateActions: [], coupons: [], fundingRates: [] },
});

function snapshot(
  result: PortfolioBacktestResult,
  asOf: number,
  spots: Record<string, number>,
  fxRate?: number,
) {
  const state = applyPortfolioEvents({
    portfolio: { baseCurrency: 'USD' },
    events: result.events.filter((e) => e.effectiveTimestampMs <= asOf),
  });
  return portfolioSnapshot({
    portfolio: state,
    asOf,
    market: createMarketSnapshot({
      asOf,
      observations: {
        spots: Object.fromEntries(
          Object.entries(spots).map(([id, price]) => [id, { price, currency: 'USD' }]),
        ),
      },
    }),
    ...(fxRate === undefined
      ? {}
      : {
          currencyConversions: [
            { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: fxRate },
          ],
        }),
  });
}

const dividendData = (
  path: 'dividends' | 'corporateActions',
  payDate?: string,
): PortfolioMarketData =>
  path === 'dividends'
    ? {
        dividends: [
          {
            instrumentId: 'AAA',
            exDate: date(3),
            amount: 1,
            ...(payDate === undefined ? {} : { payDate }),
          },
        ],
      }
    : {
        corporateActions: [
          {
            symbol: 'AAA',
            effectiveDate: date(3),
            type: 'dividend',
            cash: 1,
            ...(payDate === undefined ? {} : { details: { payDate } }),
          },
        ],
      };

function equity(
  path: 'dividends' | 'corporateActions',
  direction: 1 | -1,
  payDate?: string,
  entryIndex = 0,
  closeIndex?: number,
) {
  return portfolioBacktest({
    accounting: {
      baseCurrency: 'USD',
      initialCash: [{ currency: 'USD', amount: 100_000 }],
      settlement: { equity: 'T+0' },
    },
    instruments: { AAA: { kind: 'equity', currency: 'USD' } },
    marketData: { bars: bars('AAA'), ...dividendData(path, payDate) },
    strategy: {
      onSession: (c) => {
        if (c.index !== entryIndex && c.index !== closeIndex) return [];
        const side = (c.index === entryIndex) === (direction === 1) ? 'buy' : 'sell';
        return [
          {
            orderId: `order-${c.index}`,
            instrumentId: 'AAA',
            side,
            quantity: 100,
            type: 'market',
            submittedTimestampMs: c.asOf,
          },
        ];
      },
    },
  });
}

describe('R03: both dividend input paths share signed entitlement', () => {
  it.each([100, -100, 0, null])(
    'equivalent paths emit identical events for quantity %s',
    (quantity) => {
      const fixture = input(quantity);
      const explicit = instrumentAdapters.equity.lifecycle({
        ...fixture,
        facts: { ...fixture.facts, ...dividendData('dividends', date(6)) },
      });
      const corporate = instrumentAdapters.equity.lifecycle({
        ...fixture,
        facts: { ...fixture.facts, ...dividendData('corporateActions', date(6)) },
      });
      expect(corporate).toEqual(explicit);
      expect(explicit).toEqual(
        quantity === null || quantity === 0
          ? []
          : [
              {
                eventType: 'income.received',
                incomeType: 'dividend',
                amount: quantity * 2,
                currency: 'USD',
                instrumentId: 'AAA',
                settleTimestampMs: isoDateToEpochMs(date(6)),
              },
            ],
      );
    },
  );

  it.each(['dividends', 'corporateActions'] as const)(
    '%s: long earns 100, short owes 100, and delayed payment preserves entitlement after closing',
    (path) => {
      for (const direction of [1, -1] as const) {
        const result = equity(path, direction, date(6), 0, 3);
        expect(result.rejections).toEqual([]);
        expect(result.events.filter((e) => e.eventType === 'income.received')).toHaveLength(1);
        expect(result.finalValue).toBeCloseTo(100_000 + direction * 100, 8);
        const pending = snapshot(result, at(3), { AAA: 100 }).cash[0]!;
        expect(pending.unsettledReceivable).toBe(direction > 0 ? 100 : 0);
        expect(pending.unsettledPayable).toBe(direction < 0 ? 100 : 0);
        const paid = snapshot(result, at(7), { AAA: 100 });
        expect(paid.positions).toEqual([]);
        expect(paid.cash[0]).toMatchObject({
          totalAmount: 100_000 + direction * 100,
          settledAmount: 100_000 + direction * 100,
          unsettledReceivable: 0,
          unsettledPayable: 0,
        });
        expect(paid.netAssetValue).toBeCloseTo(result.finalValue, 8);
      }
    },
  );

  it.each(['dividends', 'corporateActions'] as const)(
    '%s: omitted/same-day pay dates settle immediately for either direction',
    (path) => {
      for (const direction of [1, -1] as const) {
        for (const payDate of [undefined, date(3)]) {
          const result = equity(path, direction, payDate);
          expect(result.finalValue).toBe(100_000 + direction * 100);
          const earned = result.events.find((e) => e.eventType === 'income.received')!;
          expect(earned.event).not.toHaveProperty('settleTimestampMs');
          expect(snapshot(result, at(3), { AAA: 100 }).cash[0]).toMatchObject({
            unsettledReceivable: 0,
            unsettledPayable: 0,
          });
        }
      }
    },
  );

  it.each(['dividends', 'corporateActions'] as const)(
    '%s: opening at/after ex-date earns nothing; closing before ex-date owes nothing',
    (path) => {
      for (const direction of [1, -1] as const) {
        for (const result of [
          equity(path, direction, date(6), 3),
          equity(path, direction, date(6), 0, 1),
        ]) {
          expect(result.events.filter((e) => e.eventType === 'income.received')).toEqual([]);
          expect(result.finalValue).toBe(100_000);
        }
      }
    },
  );

  it.each(['dividends', 'corporateActions'] as const)(
    '%s: refuses a payment preceding entitlement',
    (path) => {
      expect(() =>
        requirePortfolioMarketData('test', 'marketData', dividendData(path, date(2))),
      ).toThrowError(expect.objectContaining({ code: ErrorCode.InputOutOfRange }));
    },
  );

  it('ETF dividends inherit the same signed obligation; unrelated facts are ignored', () => {
    const fixture = input(-3);
    fixture.facts.dividends = [
      { instrumentId: 'OTHER', exDate: date(3), amount: 10 },
      { instrumentId: 'AAA', exDate: date(3), amount: 2 },
    ];
    expect(instrumentAdapters.etf.lifecycle(fixture)).toEqual([
      {
        eventType: 'income.received',
        incomeType: 'dividend',
        amount: -12,
        currency: 'USD',
        instrumentId: 'AAA',
      },
    ]);
  });
});

describe('R03: short bond coupon and redemption', () => {
  it.each([1, -1] as const)(
    'quantity direction %i receives/pays coupons and principal exactly once',
    (direction) => {
      const dates = [
        '2026-01-01',
        '2026-01-01',
        '2026-07-01',
        '2026-12-31',
        '2027-01-01',
        '2027-01-02',
      ];
      const result = portfolioBacktest({
        accounting: {
          baseCurrency: 'USD',
          initialCash: [{ currency: 'USD', amount: 100_000 }],
          settlement: { bond: 'T+0' },
        },
        instruments: {
          BOND: {
            kind: 'bond',
            currency: 'USD',
            contractMultiplier: 2,
            coupon: {
              annualRate: 0.06,
              paymentsPerYear: 2,
              faceValuePerUnit: 100,
              dayCount: '30/360',
              issueDate: '2026-01-01',
              maturityDate: '2027-01-01',
            },
          },
        },
        marketData: {
          bars: dates.map((d, i) => ({
            symbol: 'BOND',
            timestampMs: isoDateToEpochMs(d) + (10 + i) * 3_600_000,
            open: 100,
            high: 100,
            low: 100,
            close: 100,
          })),
          coupons: ['2026-07-01', '2027-01-01'].map((paymentDate) => ({
            instrumentId: 'BOND',
            paymentDate,
            amountPerUnit: 3,
          })),
        },
        strategy: {
          onSession: (c) =>
            c.index === 0
              ? [
                  {
                    orderId: 'bond-entry',
                    instrumentId: 'BOND',
                    side: direction > 0 ? 'buy' : 'sell',
                    quantity: 10,
                    type: 'market',
                    submittedTimestampMs: c.asOf,
                  },
                ]
              : [],
        },
      });
      expect(result.rejections).toEqual([]);
      const coupons = result.events
        .filter((e) => e.eventType === 'income.received')
        .map((e) => e.event);
      expect(coupons).toEqual([
        expect.objectContaining({ incomeType: 'coupon', amount: direction * 60 }),
        expect.objectContaining({ incomeType: 'coupon', amount: direction * 60 }),
      ]);
      expect(
        result.events.filter((e) => e.eventType === 'fixed-income.redemption').map((e) => e.event),
      ).toEqual([
        {
          eventType: 'fixed-income.redemption',
          instrumentId: 'BOND',
          redemptionType: 'maturity',
          quantity: 10,
          pricePerUnit: 100,
          currency: 'USD',
        },
      ]);
      const final = snapshot(result, isoDateToEpochMs('2027-01-03'), {});
      expect(final.positions).toEqual([]);
      // 20 face-100 bonds opened at par: principal nets to zero; two 3/unit coupons remain.
      expect(final.cash[0]!.totalAmount).toBe(100_000 + direction * 120);
      expect(result.finalValue).toBe(100_000 + direction * 120);
    },
  );
});

describe('R04: signed FX forward maturity as one economic transaction', () => {
  it.each([false, true])(
    'long/short currency balances through maturity (flat rates=%s)',
    (flat) => {
      for (const direction of [1, -1] as const) {
        const rates = flat
          ? [1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1]
          : [1.1, 1.1, 1.12, 1.13, 1.14, 1.15, 1.16];
        const result = portfolioBacktest({
          accounting: {
            baseCurrency: 'USD',
            initialCash: [{ currency: 'USD', amount: 1_000_000 }],
          },
          instruments: {
            FWD: {
              kind: 'fx-forward',
              currency: 'USD',
              forward: {
                baseCurrency: 'EUR',
                quoteCurrency: 'USD',
                contractRate: 1.1,
                maturityTimestampMs: at(4),
              },
            },
          },
          marketData: {
            forwardRates: rates.map((forwardRate, i) => ({
              instrumentId: 'FWD',
              timestampMs: at(i),
              forwardRate,
            })),
            fxRates: rates.map((quotePerBase, i) => ({
              timestampMs: at(i),
              baseCurrency: 'EUR',
              quoteCurrency: 'USD',
              quotePerBase,
            })),
          },
          strategy: {
            onSession: (c) =>
              c.index === 0
                ? [
                    {
                      orderId: 'fx-entry',
                      instrumentId: 'FWD',
                      side: direction > 0 ? 'buy' : 'sell',
                      quantity: 100_000,
                      type: 'market',
                      submittedTimestampMs: c.asOf,
                    },
                  ]
                : [],
          },
        });
        expect(result.rejections).toEqual([]);
        const before = snapshot(result, at(2), { FWD: rates[2]! }, rates[2]);
        expect(before.positions[0]!.quantity).toBe(direction * 100_000);
        expect(before.cash[0]!.settledAmount).toBeCloseTo(1_000_000, 8);
        expect(before.cash[0]!.unsettledPayable).toBeCloseTo(direction > 0 ? 110_000 : 0, 8);
        expect(before.cash[0]!.unsettledReceivable).toBeCloseTo(direction < 0 ? 110_000 : 0, 8);
        expect(before.netAssetValue).toBeCloseTo(1_000_000 + direction * (flat ? 0 : 2_000), 8);
        const conversion = result.events.filter((e) => e.eventType === 'cash.conversion');
        expect(conversion).toHaveLength(1);
        expect(conversion[0]!.event).toMatchObject(
          direction > 0
            ? { fromCurrency: 'USD', toCurrency: 'EUR', toAmount: 100_000 }
            : { fromCurrency: 'EUR', toCurrency: 'USD', fromAmount: 100_000 },
        );
        const closes = result.events.filter(
          (e) => e.eventType === 'trade.fill' && e.effectiveTimestampMs === at(4),
        );
        expect(closes).toHaveLength(1);
        expect(closes[0]!.event).toMatchObject({
          side: direction > 0 ? 'sell' : 'buy',
          quantity: 100_000,
          pricePerUnit: 1.1,
        });
        for (const i of [4, 6]) {
          const matured = snapshot(result, at(i), {}, rates[i]);
          expect(matured.positions).toEqual([]);
          const usd = matured.cash.find((r) => r.currency === 'USD')!;
          const eur = matured.cash.find((r) => r.currency === 'EUR')!;
          expect(usd.totalAmount).toBeCloseTo(1_000_000 - direction * 110_000, 8);
          expect(eur.totalAmount).toBe(direction * 100_000);
          for (const balance of matured.cash) {
            expect(balance.unsettledPayable).toBe(0);
            expect(balance.unsettledReceivable).toBe(0);
            expect(balance.settledAmount).toBe(balance.totalAmount);
          }
          expect(matured.netAssetValue).toBeCloseTo(
            1_000_000 + direction * (flat ? 0 : i === 4 ? 4_000 : 6_000),
            8,
          );
        }
        expect(result.finalValue).toBeCloseTo(1_000_000 + direction * (flat ? 0 : 6_000), 8);
      }
    },
  );

  it('emits no maturity event when flat, before maturity, or when maturity was already processed', () => {
    const fixture: LifecycleInput = {
      ...input(-100),
      specification: {
        kind: 'fx-forward',
        currency: 'USD',
        forward: {
          baseCurrency: 'EUR',
          quoteCurrency: 'USD',
          contractRate: 1.1,
          maturityTimestampMs: at(4),
        },
      },
    };
    expect(instrumentAdapters['fx-forward'].lifecycle(fixture)).toEqual([]);
    expect(
      instrumentAdapters['fx-forward'].lifecycle({ ...fixture, asOf: at(5), previousAsOf: at(4) }),
    ).toEqual([]);
    for (const held of [null, { quantity: 0, contractMultiplier: 1 }]) {
      expect(instrumentAdapters['fx-forward'].lifecycle({ ...fixture, asOf: at(4), held })).toEqual(
        [],
      );
    }
  });
});
