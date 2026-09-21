import { describe, expect, it } from 'vitest';
import { resolvedExpiry, WarningCode } from '@totalfinance/core';
import {
  createPortfolioStepper,
  portfolioBacktest,
  type PortfolioBacktestRequest,
} from '@totalfinance/backtest/portfolio';
import { at, bars, dateOf, equityRequest } from './portfolio-journeys.js';

const order = (instrumentId: string, quantity: number, index: number) => ({
  orderId: `${instrumentId}:${index}:${quantity}`,
  instrumentId,
  side: quantity > 0 ? ('buy' as const) : ('sell' as const),
  quantity: Math.abs(quantity),
  type: 'market' as const,
  submittedTimestampMs: at(index),
});
const stepperFor = ({ strategy: _strategy, ...request }: PortfolioBacktestRequest) =>
  createPortfolioStepper(request);
const openingBars = (id: string, close: number) =>
  bars(id, [100, 100, close, close]).map((bar, i) =>
    i === 2 ? { ...bar, open: 100, low: 100, high: Math.max(100, close) } : bar,
  );
const futureRequest = (close: number, expiry = at(2)): PortfolioBacktestRequest =>
  equityRequest({
    accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100 }] },
    instruments: {
      A: { kind: 'equity', currency: 'USD' },
      F: {
        kind: 'future',
        currency: 'USD',
        contract: { kind: 'future', underlyingInstrumentId: 'A', expiryTimestampMs: expiry },
      },
    },
    marketData: { bars: [...openingBars('A', 200), ...openingBars('F', close)] },
    strategy: {
      onSession: (c) =>
        c.index === 0 ? [order('F', 1, 0)] : c.index === 1 ? [order('A', 2, 1)] : [],
    },
  });

const optionRequest = (
  underlyingClose: number,
  missingExpiryQuote = true,
): PortfolioBacktestRequest => {
  const expiry = dateOf(at(2));
  return equityRequest({
    accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100 }] },
    instruments: {
      A: { kind: 'equity', currency: 'USD' },
      U: { kind: 'equity', currency: 'USD' },
      C: {
        kind: 'option',
        currency: 'USD',
        contractMultiplier: 1,
        contract: {
          kind: 'option',
          underlyingInstrumentId: 'U',
          type: 'call',
          strikePricePerUnit: 100,
          expiryTimestampMs: at(2),
        },
      },
    },
    marketData: {
      bars: [...openingBars('A', 200), ...openingBars('U', underlyingClose)],
      optionChains: [0, 1, 2, 3].map((i) => ({
        asOf: at(i),
        underlyingPrice: i < 2 ? 100 : underlyingClose,
        quotes:
          i >= 2 && missingExpiryQuote
            ? []
            : [
                {
                  contract: {
                    underlying: 'U',
                    type: 'call' as const,
                    style: 'european' as const,
                    strike: 100,
                    expiry,
                    ...resolvedExpiry(expiry),
                    multiplier: 1,
                  },
                  timestampMs: at(i),
                  mid: 10,
                  impliedVolatility: 0.2,
                  underlyingPrice: i < 2 ? 100 : underlyingClose,
                },
              ],
      })),
    },
    strategy: {
      onSession: (c) =>
        c.index === 0 ? [order('C', 1, 0)] : c.index === 1 ? [order('A', 2, 1)] : [],
    },
  });
};

describe('opening execution precedes close-derived derivative lifecycle', () => {
  it.each([
    { close: 200, expiry: at(2), value: 200, name: 'expiry gain' },
    { close: 100, expiry: at(2), value: 100, name: 'no-gain expiry control' },
    { close: 200, expiry: at(10), value: 200, name: 'ordinary variation margin' },
  ])(
    '$name cannot finance two 100-dollar shares with 100-dollar opening capital',
    ({ close, expiry, value }) => {
      const result = portfolioBacktest(futureRequest(close, expiry));
      expect(result.fills.map((f) => f.instrumentId)).toEqual(['F']);
      expect(result.rejections).toEqual([
        expect.objectContaining({ orderId: 'A:1:2', code: WarningCode.BacktestLimitRejected }),
      ]);
      expect(result.finalValue).toBe(value);
      expect(result.diagnostics.reconciliationResidual).toBeCloseTo(0, 12);
    },
  );

  it('retains the expiring future and its opening collateral until after the entry verdict', () => {
    const sim = stepperFor(futureRequest(200));
    sim.open(0);
    sim.close(0, []);
    sim.open(1);
    sim.close(1, [order('F', 1, 0)]);
    const opening = sim.open(2);
    expect(opening.netAssetValue).toBe(100);
    expect(opening.cash).toEqual([{ currency: 'USD', amount: 100 }]);
    expect(opening.positions).toEqual([
      expect.objectContaining({ instrumentId: 'F', quantity: 1, markPricePerUnit: 100 }),
    ]);
    const frame = sim.close(2, [order('A', 2, 1)]);
    expect(frame.rejections).toHaveLength(1);
    expect(frame.netAssetValue).toBe(200);
    expect(sim.context().positions).toEqual([]);
    expect(sim.valuation().snapshot.netAssetValue).toBe(200);
  });

  it.each([1, -1])(
    'settles an expiry-day future acquired at open (%s), exactly once',
    (quantity) => {
      const request = futureRequest(150);
      request.strategy = { onSession: (c) => (c.index === 1 ? [order('F', quantity, 1)] : []) };
      const result = portfolioBacktest(request);
      expect(result.fills).toHaveLength(1);
      expect(result.fills[0]!.pricePerUnit).toBe(100);
      expect(
        result.events.filter((e) => e.eventType === 'derivative.variation-margin'),
      ).toHaveLength(1);
      expect(result.events.filter((e) => e.eventType === 'trade.fill')).toHaveLength(2);
      expect(result.finalValue).toBe(100 + quantity * 50);
      expect(result.diagnostics.reconciliationResidual).toBeCloseTo(0, 12);
    },
  );

  it('settles remaining post-fill quantity, not the position before a partial opening exit', () => {
    const request = futureRequest(200);
    request.strategy = {
      onSession: (c) =>
        c.index === 0 ? [order('F', 1, 0)] : c.index === 1 ? [order('F', -0.5, 1)] : [],
    };
    const result = portfolioBacktest(request);
    expect(result.finalValue).toBe(150);
    expect(result.events.filter((e) => e.eventType === 'trade.fill').at(-1)!.event).toMatchObject({
      quantity: 0.5,
      side: 'sell',
      pricePerUnit: 200,
    });
    expect(result.diagnostics.reconciliationResidual).toBeCloseTo(0, 12);
  });

  it.each([300, 100])(
    'does not spend option expiry intrinsic before opening (underlying close %s)',
    (underlyingClose) => {
      const result = portfolioBacktest(optionRequest(underlyingClose));
      expect(result.fills.map((f) => f.instrumentId)).toEqual(['C']);
      expect(result.rejections[0]!.code).toBe(WarningCode.BacktestLimitRejected);
      // $100 less the $10 premium, plus max(S-100, 0), multiplier one.
      expect(result.finalValue).toBe(90 + Math.max(underlyingClose - 100, 0));
      expect(result.diagnostics.reconciliationResidual).toBeCloseTo(0, 12);
    },
  );

  it('uses an identified prior option quote for open(), then actual intrinsic after expiry close', () => {
    const sim = stepperFor(optionRequest(300));
    sim.open(0);
    sim.close(0, []);
    sim.open(1);
    sim.close(1, [order('C', 1, 0)]);
    const opening = sim.open(2);
    expect(opening.marks['C']).toEqual({ pricePerUnit: 10, source: 'last-completed' });
    expect(opening.netAssetValue).toBe(100);
    expect(opening.positions[0]!.quantity).toBe(1);
    const frame = sim.close(2, [order('A', 2, 1)]);
    expect(frame.rejections).toHaveLength(1);
    expect(frame.events.filter((e) => e.eventType === 'derivative.exercise')).toHaveLength(1);
    expect(frame.netAssetValue).toBe(290);
    expect(sim.context().positions).toEqual([]);
    expect(sim.context().marks['C']).toBeNull();
    expect(sim.valuation().snapshot.netAssetValue).toBe(290);
  });

  it.each([1, -1])(
    'settles a same-day option acquisition (%s) at close after its premium fill',
    (quantity) => {
      const request = optionRequest(120, false);
      request.strategy = { onSession: (c) => (c.index === 1 ? [order('C', quantity, 1)] : []) };
      const result = portfolioBacktest(request);
      expect(
        result.events.filter(
          (e) => e.eventType === 'derivative.exercise' || e.eventType === 'derivative.assignment',
        ),
      ).toHaveLength(1);
      expect(result.fills).toHaveLength(1);
      expect(result.finalValue).toBe(100 + quantity * (20 - 10));
      expect(result.diagnostics.reconciliationResidual).toBeCloseTo(0, 12);
    },
  );

  it('does not consume funding in the pre-open phase or spend its close receipt at the open', () => {
    const request = futureRequest(100);
    request.instruments = {
      ...request.instruments,
      F: {
        kind: 'crypto-perpetual',
        currency: 'USD',
        contract: { kind: 'perpetual', underlyingInstrumentId: 'A' },
      },
    };
    request.marketData = {
      ...request.marketData,
      fundingRates: [{ instrumentId: 'F', timestampMs: at(2), fundingRate: -1 }],
    };
    const result = portfolioBacktest(request);
    expect(result.fills.map((f) => f.instrumentId)).toEqual(['F']);
    expect(result.rejections[0]!.code).toBe(WarningCode.BacktestLimitRejected);
    expect(
      result.events.filter((e) => e.eventType === 'income.received').map((e) => e.event),
    ).toEqual([expect.objectContaining({ incomeType: 'funding-receipt', amount: 100 })]);
    expect(result.finalValue).toBe(200);
    expect(result.diagnostics.reconciliationResidual).toBeCloseTo(0, 12);
  });

  it('processes a roll after the queued opening trade, using post-fill remaining quantity', () => {
    const request = futureRequest(200, at(3));
    request.instruments = {
      ...request.instruments,
      F: {
        ...request.instruments['F']!,
        roll: { toInstrumentId: 'NEXT', sessionsBeforeExpiry: 0 },
      },
      NEXT: {
        kind: 'future',
        currency: 'USD',
        contract: { kind: 'future', underlyingInstrumentId: 'A', expiryTimestampMs: at(10) },
      },
    };
    request.marketData = {
      bars: [...request.marketData.bars!, ...bars('NEXT', [200, 200, 200, 200])],
    };
    request.strategy = {
      onSession: (c) =>
        c.index === 0 ? [order('F', 1, 0)] : c.index === 1 ? [order('F', -0.5, 1)] : [],
    };
    const result = portfolioBacktest(request);
    expect(
      result.events.filter((e) => e.eventType === 'derivative.roll').map((e) => e.event),
    ).toEqual([expect.objectContaining({ quantity: 0.5 })]);
    expect(result.finalValue).toBe(150);
    expect(result.diagnostics.reconciliationResidual).toBeCloseTo(0, 12);
  });

  it.each([50, -50])(
    'does not release FX-forward collateral before maturity close (%s)',
    (quantity) => {
      const request = futureRequest(100);
      request.instruments = {
        A: request.instruments['A']!,
        F: {
          kind: 'fx-forward',
          currency: 'USD',
          forward: {
            maturityTimestampMs: at(2),
            baseCurrency: 'EUR',
            quoteCurrency: 'USD',
            contractRate: 1,
          },
        },
      };
      request.marketData = {
        bars: bars('A', [100, 100, 100, 100]),
        forwardRates: [0, 1, 2, 3].map((i) => ({
          instrumentId: 'F',
          timestampMs: at(i),
          forwardRate: 1,
        })),
        fxRates: [0, 1, 2, 3].map((i) => ({
          timestampMs: at(i),
          baseCurrency: 'EUR',
          quoteCurrency: 'USD',
          quotePerBase: 1,
        })),
      };
      request.strategy = {
        onSession: (c) =>
          c.index === 0 ? [order('F', quantity, 0)] : c.index === 1 ? [order('A', 1, 1)] : [],
      };
      const sim = stepperFor(request);
      sim.open(0);
      sim.close(0, []);
      sim.open(1);
      sim.close(1, [order('F', quantity, 0)]);
      expect(sim.open(2).positions[0]).toMatchObject({ instrumentId: 'F', quantity });
      const frame = sim.close(2, [order('A', 1, 1)]);
      expect(frame.fills).toEqual([]);
      expect(frame.rejections[0]!.code).toBe(WarningCode.BacktestLimitRejected);
      expect(frame.events.filter((e) => e.eventType === 'cash.conversion')).toHaveLength(1);
      expect(frame.events.filter((e) => e.eventType === 'trade.fill')).toHaveLength(1);
      expect(sim.context().positions).toEqual([]);
      expect(frame.netAssetValue).toBe(100);
      expect(portfolioBacktest(request).finalValue).toBe(100);

      // A new maturity-day forward must also convert and close, without a duplicate close.
      request.strategy = { onSession: (c) => (c.index === 1 ? [order('F', quantity, 1)] : []) };
      const acquired = portfolioBacktest(request);
      expect(acquired.fills).toHaveLength(1);
      expect(acquired.events.filter((e) => e.eventType === 'cash.conversion')).toHaveLength(1);
      expect(acquired.events.filter((e) => e.eventType === 'trade.fill')).toHaveLength(2);
      expect(acquired.finalValue).toBe(100);
      expect(acquired.diagnostics.reconciliationResidual).toBeCloseTo(0, 12);
    },
  );
});

describe('calendar entitlements remain pre-open', () => {
  it.each([1, -1])(
    'pays the prior holder (%s), not a new ex-date buyer, before the opening exit',
    (quantity) => {
      const request = equityRequest({
        accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100 }] },
        marketData: {
          bars: bars('AAA', [100, 100, 100]),
          dividends: [{ instrumentId: 'AAA', exDate: dateOf(at(2)), amount: 5 }],
        },
        strategy: {
          onSession: (c) =>
            c.index === 0 ? [order('AAA', quantity, 0)] : [order('AAA', -quantity, 1)],
        },
      });
      const result = portfolioBacktest(request);
      expect(
        result.events.filter((e) => e.eventType === 'income.received').map((e) => e.event),
      ).toEqual([expect.objectContaining({ amount: quantity * 5 })]);
      expect(result.finalValue).toBe(100 + quantity * 5);
      request.strategy = { onSession: (c) => (c.index === 1 ? [order('AAA', quantity, 1)] : []) };
      expect(
        portfolioBacktest(request).events.filter((e) => e.eventType === 'income.received'),
      ).toEqual([]);
    },
  );

  it('allows an explicit pre-open deposit to fund entry', () => {
    const request = futureRequest(100);
    request.strategy = { onSession: (c) => (c.index === 1 ? [order('A', 2, 1)] : []) };
    request.externalFlows = [{ timestampMs: at(2), currency: 'USD', amount: 100 }];
    const result = portfolioBacktest(request);
    expect(result.fills).toHaveLength(1);
    expect(result.rejections).toEqual([]);
    expect(result.finalValue).toBe(400);
  });

  it.each([10, -10.2])(
    'uses dirty, not clean, bond exposure in the opening budget (%s)',
    (quantity) => {
      const instants = [28, 29, 30].map((day) => Date.UTC(2026, 5, day, 21));
      const result = portfolioBacktest(
        equityRequest({
          accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 1000 }] },
          instruments: {
            B: {
              kind: 'bond',
              currency: 'USD',
              coupon: {
                annualRate: 0.06,
                paymentsPerYear: 2,
                faceValuePerUnit: 100,
                dayCount: '30/360',
                issueDate: '2026-01-01',
                maturityDate: '2028-01-01',
              },
            },
          },
          marketData: {
            bars: bars('B', [100, 100, 100]).map((bar, i) => ({
              ...bar,
              timestampMs: instants[i]!,
            })),
          },
          strategy: {
            onSession: (c) =>
              c.index === 1 ? [{ ...order('B', quantity, 1), submittedTimestampMs: c.asOf }] : [],
          },
        }),
      );
      // June 30: accrued = 100 * .06 * 179/360. Short 10.2 has dirty liability 1050.43,
      // not clean liability 1020 offset by fictitious equity from its 30.43 accrued proceeds.
      expect(Math.abs(quantity) * (100 + (6 * 179) / 360)).toBeGreaterThan(1000);
      expect(result.fills).toEqual([]);
      expect(result.rejections[0]!.code).toBe(WarningCode.BacktestLimitRejected);
      expect(result.finalValue).toBe(1000);
    },
  );
});
