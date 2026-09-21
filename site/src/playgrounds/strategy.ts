import { legs, strategy } from '@totalfinance/strategy';
import type { Playground } from '../types.js';

export const strategies: Playground = {
  id: 'analyze-a-strategy',
  title: 'Analyze a bull call spread',
  introduction:
    'Two explicitly priced legs, one expiry. The chart is net profit or loss, not option value. Premiums are per share; the contract multiplier is 100.',
  controls: [
    {
      name: 'longStrike',
      label: 'Long-call strike',
      unit: 'USD',
      value: 100,
      min: 1,
      max: 10000,
      step: 1,
    },
    {
      name: 'shortStrike',
      label: 'Short-call strike',
      unit: 'USD · above long strike',
      value: 110,
      min: 1,
      max: 10000,
      step: 1,
    },
    {
      name: 'longPremium',
      label: 'Long-call premium paid',
      unit: 'USD / share',
      value: 6,
      min: 0,
      max: 1000,
      step: 0.1,
    },
    {
      name: 'shortPremium',
      label: 'Short-call premium received',
      unit: 'USD / share',
      value: 2,
      min: 0,
      max: 1000,
      step: 0.1,
    },
  ],
  run(input) {
    const { longStrike = 100, shortStrike = 110, longPremium = 6, shortPremium = 2 } = input;
    if (shortStrike <= longStrike)
      throw new Error(
        'Short-call strike must be above the long-call strike for this bull call spread.',
      );
    const legInputs = [
      legs.call({ strike: longStrike, premium: longPremium, quantity: 1 }),
      legs.call({ strike: shortStrike, premium: shortPremium, quantity: -1 }),
    ];
    const position = strategy(legInputs, { multiplier: 100 });
    const result = position.payoff({
      prices: { from: longStrike * 0.8, to: shortStrike * 1.2, steps: 101 },
    });
    return {
      metrics: [
        { label: 'Net debit', value: result.netDebit, unit: 'USD / spread' },
        { label: 'Maximum profit', value: result.maxProfit ?? 'unbounded', unit: 'USD' },
        { label: 'Maximum loss', value: result.maxLoss ?? 'unbounded', unit: 'USD' },
        { label: 'Break-even', value: result.breakevens.join(', '), unit: 'USD underlying' },
      ],
      chart: {
        title: 'Profit / loss at expiration',
        xLabel: 'Underlying price · USD',
        yLabel: 'Net P&L · USD / spread',
        series: [
          {
            name: 'Bull call spread',
            points: result.points.map((point) => ({ x: point.underlyingPrice, y: point.pnl })),
          },
        ],
      },
      assumptions: {
        model: 'piecewise-linear expiration payoff',
        contractMultiplier: 100,
        premiums: 'user-supplied',
        costs: 'no commissions or slippage included',
        currency: 'USD',
      },
      diagnostics: {
        warnings: [
          'Sample premiums are hypothetical, not market quotes. Expiration payoff is not the mark-to-market value before expiration.',
        ],
      },
      result,
      example: {
        description:
          'Returns a payoff report with named summary fields and an ordinary points array. Each point has underlyingPrice and pnl; amounts include the 100-share multiplier and premiums. These five explicit prices sample the same position as the chart.',
        code: `import { legs, strategy } from '@totalfinance/strategy';\n\nconst position = strategy([\n  legs.call({ strike: ${longStrike}, premium: ${longPremium}, quantity: 1 }),\n  legs.call({ strike: ${shortStrike}, premium: ${shortPremium}, quantity: -1 }),\n], { multiplier: 100 });\nconst underlyingPrices = ${JSON.stringify([longStrike * 0.8, longStrike * 0.9, longStrike, shortStrike, shortStrike * 1.2])};\nconst result = position.payoff({ prices: underlyingPrices });\nconsole.log(result);`,
        result: position.payoff({
          prices: [longStrike * 0.8, longStrike * 0.9, longStrike, shortStrike, shortStrike * 1.2],
        }),
      },
      code: `import { legs, strategy } from '@totalfinance/strategy';\n\nconst position = strategy([\n  legs.call({ strike: ${longStrike}, premium: ${longPremium}, quantity: 1 }),\n  legs.call({ strike: ${shortStrike}, premium: ${shortPremium}, quantity: -1 }),\n], { multiplier: 100 });\nconst result = position.payoff({ prices: { from: ${longStrike * 0.8}, to: ${shortStrike * 1.2}, steps: 101 } });\nconsole.log(result);`,
    };
  },
};
