import { describe, expect, it } from 'vitest';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  createPortfolioLedger,
  portfolioEventsFromFill,
  type NormalizedFill,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';
import { normalizeTradePlan, preflightTradePlan } from '@totalfinance/portfolio/trade';
import { SimulatedBroker } from '@totalfinance/backtest';
import {
  execution,
  fees,
  fillOrderWithPolicy,
  normalizedFillsFromBacktest,
  slippage,
} from '@totalfinance/backtest/execution';

const NOW = Date.UTC(2026, 0, 7, 15);
const deposit: PortfolioEventEnvelope = {
  eventId: 'deposit',
  sourceId: 'funding',
  schemaVersion: 1,
  accountId: 'main',
  effectiveTimestampMs: NOW - 1,
  recordedTimestampMs: NOW - 1,
  eventType: 'cash.deposit',
  event: { eventType: 'cash.deposit', amount: 100_000, currency: 'USD' },
  provenance: {},
};
const bar = (timestampMs: number) => ({
  symbol: 'X',
  timestampMs,
  open: 100,
  high: 105,
  low: 95,
  close: 100,
  volume: 10_000,
});
const eventsOf = (fills: NormalizedFill[]) =>
  fills.flatMap((fill) =>
    portfolioEventsFromFill({
      fill,
      sourceId: 'execution',
      recordedTimestampMs: fill.filledTimestampMs,
    }),
  );
const cashOf = (fills: NormalizedFill[]) =>
  createPortfolioLedger({ baseCurrency: 'USD', events: [deposit, ...eventsOf(fills)] }).state
    .accounts['main']!.cashBalances['USD']!.totalAmount;

describe('execution accounting charges embedded price costs once', () => {
  it.each([1, 100])(
    'bridges a buy/sell round trip with fees and slippage, multiplier=%s',
    (multiplier) => {
      const broker = new SimulatedBroker({
        cash: 100_000,
        slippage: slippage.bps(100),
        commission: fees.perShare(0.1),
      });
      if (multiplier !== 1)
        broker.registerOption('X', {
          underlying: 'AAA',
          type: 'call',
          strike: 100,
          expiresAt: NOW + 86_400_000,
          multiplier,
          settlement: 'cash',
          style: 'european',
        });
      for (const [index, side] of (['buy', 'sell'] as const).entries()) {
        broker.submit({ symbol: 'X', side, quantity: 2 });
        broker.processBar(bar(NOW + index));
        const fills = normalizedFillsFromBacktest({
          trades: broker.trades,
          accountId: 'main',
          currency: 'USD',
          sourceId: 'run',
        });
        expect(cashOf(fills)).toBeCloseTo(broker.cash, 8);
        expect(fills.every((fill) => fill.costs?.slippageAdjustment === undefined)).toBe(true);
        expect(fills[0]!.executionPriceAdjustment).toBeCloseTo(2 * multiplier, 8);
      }
      expect(broker.cash).toBeCloseTo(100_000 - 4 * multiplier - 0.4, 8);
    },
  );

  it.each([1, 100])(
    'the paper/portfolio fill path books only actual execution cash, multiplier=%s',
    (multiplier) => {
      const policy = execution.declared({
        label: 'cash-parity',
        costs: { commission: fees.perShare(0.1), slippage: slippage.bps(100) },
      });
      const fills: NormalizedFill[] = [];
      for (const [index, side] of (['buy', 'sell'] as const).entries()) {
        const filled = fillOrderWithPolicy({
          policy,
          order: {
            orderId: `order:${index}`,
            instrumentId: 'X',
            side,
            quantity: 2,
            type: 'market',
            submittedTimestampMs: NOW,
          },
          observation: { kind: 'bar', bar: bar(NOW + index) },
          asOf: NOW + index,
          accountId: 'main',
          currency: 'USD',
          fillId: `fill:${index}`,
          terms: { contractMultiplier: multiplier },
        });
        expect(filled.outcome).toBe('filled');
        if (filled.outcome !== 'filled') throw new Error('expected fill');
        fills.push(filled.fill);
        expect(filled.fill.executionPriceAdjustment).toBeCloseTo(2 * multiplier, 8);
      }
      expect(cashOf(fills)).toBeCloseTo(100_000 - 4 * multiplier - 0.4, 8);
      expect(eventsOf(fills).filter((event) => event.eventType === 'cost.charge')).toHaveLength(2);
    },
  );

  it('preflight includes spread and slippage once in the after-state, and reconciles its cost estimate', () => {
    const portfolio = createPortfolioLedger({ baseCurrency: 'USD', events: [deposit] }).state;
    const market = createMarketSnapshot({
      asOf: NOW,
      observations: { spots: { X: { price: 100, currency: 'USD' } } },
    });
    const plan = normalizeTradePlan({
      intent: {
        kind: 'totalfinance.trade-intent',
        schemaVersion: 1,
        accountId: 'main',
        asOf: NOW,
        orders: [{ instrumentId: 'X', side: 'buy', quantity: 10, type: 'market' }],
      },
      portfolio,
      market,
      asOf: NOW,
    });
    const report = preflightTradePlan({
      plan,
      portfolio,
      market,
      asOf: NOW,
      policy: { mode: 'paper' },
      costs: { commissionPerOrder: 1, slippageBps: 100, spreadBps: 50 },
    });
    expect(report.estimates.totalCost).toBeCloseTo(16, 8);
    expect(report.after.totalCashBaseCurrencyValue).toBeCloseTo(98_984, 8);
    expect(report.hypotheticalFills[0]!.pricePerUnit).toBeCloseTo(101.5, 8);
    expect(report.hypotheticalFills[0]!.costs).toEqual({ commission: 1 });
    expect(report.hypotheticalFills[0]!.executionPriceAdjustment).toBeCloseTo(15, 8);
  });
});
