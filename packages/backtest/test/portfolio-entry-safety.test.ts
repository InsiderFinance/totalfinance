import { describe, expect, it } from 'vitest';
import { WarningCode } from '@totalfinance/core';
import { execution, fees } from '@totalfinance/backtest/execution';
import {
  createPortfolioStepper,
  portfolioBacktest,
  type PortfolioBacktestRequest,
} from '@totalfinance/backtest/portfolio';
import { at, bars, equityRequest } from './portfolio-journeys.js';

const buy = (quantity: number, asOf: number, orderId = 'buy') => ({
  orderId,
  instrumentId: 'AAA',
  side: 'buy' as const,
  quantity,
  type: 'market' as const,
  submittedTimestampMs: asOf,
});
const request = (quantity: number, overrides: Partial<PortfolioBacktestRequest> = {}) =>
  equityRequest({
    marketData: { bars: bars('AAA', [100, 100, 100]) },
    strategy: { onSession: (c) => (c.index === 0 ? [buy(quantity, c.asOf)] : []) },
    ...overrides,
  });

describe('completed-observation decisions are causal', () => {
  it.each(['market', 'limit', 'stop'] as const)(
    '%s decisions cannot exploit their own bar range/open',
    (type) => {
      const data = bars('AAA', [200, 220]);
      data[0] = { ...data[0]!, open: 100, low: 100, high: 200 };
      data[1] = { ...data[1]!, open: 220, low: 220, high: 220 };
      const seen: number[] = [];
      const result = portfolioBacktest(
        request(100, {
          marketData: { bars: data },
          strategy: {
            onSession: (c) => {
              seen.push(c.observations['AAA']!.bar!.close);
              return [
                {
                  ...buy(100, c.asOf),
                  type,
                  ...(type === 'limit' ? { limitPrice: 150 } : {}),
                  ...(type === 'stop' ? { stopPrice: 150 } : {}),
                },
              ];
            },
          },
        }),
      );
      expect(seen).toEqual([200]);
      if (type === 'limit') expect(result.fills).toHaveLength(0);
      else {
        expect(result.fills[0]!.filledTimestampMs).toBe(at(1));
        expect(result.fills[0]!.pricePerUnit).toBe(220);
      }
      expect(result.finalValue).toBe(100_000);
    },
  );

  it('makes prior fills visible to the next decision and does not call the strategy on the final bar', () => {
    const held: number[] = [];
    portfolioBacktest(
      request(100, {
        strategy: {
          onSession: (c) => {
            held.push(c.positions.find((p) => p.instrumentId === 'AAA')?.quantity ?? 0);
            return c.index === 0 ? [buy(100, c.asOf)] : [];
          },
        },
      }),
    );
    expect(held).toEqual([0, 100]);
  });

  it('the stepper refuses a same-observation order and does not replay a stale bar at a later clock tick', () => {
    const { strategy: _strategy, ...input } = request(100, {
      instruments: {
        AAA: { kind: 'equity', currency: 'USD' },
        BBB: { kind: 'equity', currency: 'USD' },
      },
      marketData: { bars: [bars('AAA', [100])[0]!, bars('BBB', [100, 100])[1]!] },
    });
    const stepper = createPortfolioStepper(input);
    stepper.open(0);
    const same = stepper.close(0, [buy(100, at(0))]);
    expect(same.fills).toHaveLength(0);
    expect(same.rejections[0]!.code).toBe(WarningCode.BacktestLookahead);
    stepper.open(1);
    const stale = stepper.close(1, [buy(100, at(0))]);
    expect(stale.fills).toHaveLength(0);
    expect(stale.rejections[0]!.code).toBe(WarningCode.BacktestLookahead);
  });
});

describe('entry buying power is enforced before committing a fill', () => {
  it('requires trading-currency funding and values opening foreign cash as capital, not profit', () => {
    const foreign = request(100, {
      instruments: { AAA: { kind: 'equity', currency: 'EUR' } },
      marketData: {
        bars: bars('AAA', [100, 100, 100]),
        fxRates: [0, 1, 2].map((i) => ({
          timestampMs: at(i),
          baseCurrency: 'EUR',
          quoteCurrency: 'USD',
          quotePerBase: 1.1,
        })),
      },
    });
    expect(portfolioBacktest(foreign).fills).toHaveLength(0);
    const funded = portfolioBacktest({
      ...foreign,
      accounting: {
        baseCurrency: 'USD',
        initialCash: [
          { currency: 'USD', amount: 89_000 },
          { currency: 'EUR', amount: 10_000 },
        ],
      },
    });
    expect(funded.fills).toHaveLength(1);
    expect(funded.points[0]!.equity).toBe(100_000);
    expect(funded.finalValue).toBe(100_000);
    expect(funded.returns.every((r) => r === 0)).toBe(true);
  });

  it('rejects an oversized cash-account order without creating any fill or cash debit', () => {
    const result = portfolioBacktest(request(2_000));
    expect(result.fills).toHaveLength(0);
    expect(result.rejections[0]!.code).toBe(WarningCode.BacktestLimitRejected);
    expect(result.events.filter((e) => e.eventType === 'trade.fill')).toHaveLength(0);
    expect(result.finalValue).toBe(100_000);
  });

  it('includes fees and existing/unsettled commitments, and does not resize silently', () => {
    const result = portfolioBacktest(
      request(1_000, {
        execution: execution.declared({
          label: 'cash, $1 commission',
          costs: { commission: fees.fixed(1) },
        }),
        strategy: {
          onSession: (c) =>
            c.index === 0 ? [buy(999, c.asOf, 'first'), buy(1, c.asOf, 'second')] : [],
        },
      }),
    );
    expect(result.fills.map((f) => f.quantity)).toEqual([999]);
    expect(result.rejections[0]).toMatchObject({
      orderId: 'second',
      code: WarningCode.BacktestLimitRejected,
    });
    expect(result.finalValue).toBe(99_999);
  });

  it('allows declared leverage but refuses the next order above its initial-margin budget', () => {
    const result = portfolioBacktest(
      request(1_500, {
        execution: execution.declared({
          label: '50% initial margin',
          margin: {
            buyingPowerMultiplier: 2,
            initialMarginRate: 0.5,
            maintenanceMarginRate: 0,
            forcedLiquidation: 'none',
          },
        }),
        strategy: {
          onSession: (c) =>
            c.index === 0 ? [buy(1_500, c.asOf, 'first'), buy(600, c.asOf, 'second')] : [],
        },
      }),
    );
    expect(result.fills.map((f) => f.quantity)).toEqual([1_500]);
    expect(result.rejections[0]!.code).toBe(WarningCode.BacktestLimitRejected);
  });

  it.each([
    { multiplier: 1, quantity: 1_500 },
    { multiplier: 3, quantity: 2_500 },
  ])(
    'enforces the leverage cap and initial margin independently ($multiplier multiplier)',
    ({ multiplier, quantity }) => {
      const result = portfolioBacktest(
        request(quantity, {
          execution: execution.declared({
            label: 'independent caps',
            margin: {
              buyingPowerMultiplier: multiplier,
              initialMarginRate: 0.5,
              maintenanceMarginRate: 0,
              forcedLiquidation: 'none',
            },
          }),
        }),
      );
      expect(result.fills).toHaveLength(0);
      expect(result.rejections[0]!.code).toBe(WarningCode.BacktestLimitRejected);
    },
  );

  it('does not use the execution bar close to finance a next-open order', () => {
    const data = bars('AAA', [100, 1_000]);
    data[1] = { ...data[1]!, open: 100, low: 100 };
    const result = portfolioBacktest(request(2_000, { marketData: { bars: data } }));
    expect(result.fills).toHaveLength(0);
    expect(result.finalValue).toBe(100_000);
  });

  it('allows a risk-reducing exit after a price loss', () => {
    const result = portfolioBacktest(
      request(1_000, {
        marketData: { bars: bars('AAA', [100, 100, 50]) },
        strategy: {
          onSession: (c) =>
            c.index === 0
              ? [buy(1_000, c.asOf)]
              : [{ ...buy(1_000, c.asOf, 'exit'), side: 'sell' }],
        },
      }),
    );
    expect(result.fills.map((f) => f.side)).toEqual(['buy', 'sell']);
    expect(result.finalValue).toBe(50_000);
  });

  it('does not spend sale proceeds until settlement, then permits the funded entry', () => {
    const result = portfolioBacktest(
      request(1_000, {
        marketData: { bars: bars('AAA', [100, 100, 100, 100, 100]) },
        strategy: {
          onSession: (c) => {
            if (c.index === 0) return [buy(1_000, c.asOf, 'initial')];
            if (c.index === 1)
              return [
                { ...buy(1_000, c.asOf, 'sell'), side: 'sell' },
                buy(1_000, c.asOf, 'unsettled-reentry'),
              ];
            return c.index === 3 ? [buy(1_000, c.asOf, 'settled-reentry')] : [];
          },
        },
      }),
    );
    expect(result.fills.map((fill) => [fill.orderId, fill.filledTimestampMs])).toEqual([
      ['initial', at(1)],
      ['sell', at(2)],
      ['settled-reentry', at(4)],
    ]);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        orderId: 'unsettled-reentry',
        code: WarningCode.BacktestLimitRejected,
      }),
    ]);
    expect(result.finalValue).toBe(100_000);
  });
});
