import { legs, strategy } from '@totalfinance/strategy';
import type { Playground } from '../types.js';

export const scenarios: Playground = {
  id: 'explore-scenarios',
  title: 'Explore price and volatility scenarios',
  introduction:
    'Revalue a sample bull call spread before expiry. Each line applies a different volatility shock. This is mark-to-market P&L, not an expiration payoff or a forecast.',
  controls: [
    {
      name: 'spot',
      label: 'Starting underlying price',
      unit: 'USD',
      value: 100,
      min: 50,
      max: 200,
      step: 1,
    },
    {
      name: 'volatility',
      label: 'Starting volatility',
      unit: 'decimal',
      value: 0.25,
      min: 0.06,
      max: 2,
      step: 0.01,
    },
    {
      name: 'daysForward',
      label: 'Advance valuation date',
      unit: 'calendar days · integer',
      value: 7,
      min: 0,
      max: 28,
      step: 1,
    },
    {
      name: 'riskFreeRate',
      label: 'Risk-free rate',
      unit: 'decimal',
      value: 0.04,
      min: -0.2,
      max: 0.5,
      step: 0.005,
    },
  ],
  run(input) {
    const { spot = 100, volatility = 0.25, daysForward = 7, riskFreeRate = 0.04 } = input;
    if (!Number.isInteger(daysForward))
      throw new Error('Days forward must be a whole number of calendar days.');
    const market = {
      spot,
      volatility,
      riskFreeRate,
      asOf: '2026-01-02T21:00:00Z',
      expiry: '2026-02-20T21:00:00Z',
    };
    const position = strategy(
      [legs.call({ strike: 100, quantity: 1 }), legs.call({ strike: 110, quantity: -1 })],
      {
        premiums: 'model',
        market,
        multiplier: 100,
      },
    );
    const configuration = {
      prices: { from: 75, to: 135, steps: 41 },
      volatilityShocks: [-0.05, 0, 0.05],
      daysForward: [daysForward],
    };
    const result = position.scenarioTable(configuration);
    const values = result.value.map((row) => row.pnl);
    return {
      metrics: [
        { label: 'Scenario cells', value: result.value.length },
        { label: 'Lowest grid P&L', value: Math.min(...values), unit: 'USD · not maximum loss' },
        { label: 'Highest grid P&L', value: Math.max(...values), unit: 'USD · not maximum profit' },
        { label: 'Days forward', value: daysForward },
      ],
      chart: {
        title: 'Mark-to-market P&L under volatility shocks',
        xLabel: 'Scenario underlying price · USD',
        yLabel: 'P&L · USD / spread',
        series: configuration.volatilityShocks.map((shock) => ({
          name: `${shock > 0 ? '+' : ''}${shock * 100} volatility points`,
          points: result.value
            .filter((row) => row.volatilityShock === shock)
            .map((row) => ({ x: row.underlyingPrice, y: row.pnl })),
        })),
      },
      assumptions: result.assumptions,
      diagnostics: result.diagnostics,
      result,
      example: {
        description:
          'Returns scenario rows in value, plus assumptions and diagnostics. Each row names its underlying price, volatility shock and P&L. These three price scenarios use the same market and time advance as the chart, with no volatility shock.',
        code: `import { legs, strategy } from '@totalfinance/strategy';\n\nconst market = ${JSON.stringify(market, null, 2)};\nconst position = strategy([\n  legs.call({ strike: 100, quantity: 1 }),\n  legs.call({ strike: 110, quantity: -1 }),\n], { premiums: 'model', market, multiplier: 100 });\nconst underlyingPrices = [90, 100, 110];\nconst result = position.scenarioTable({\n  prices: underlyingPrices,\n  volatilityShocks: [0],\n  daysForward: [${daysForward}],\n});\nconsole.log(result);`,
        result: position.scenarioTable({
          prices: [90, 100, 110],
          volatilityShocks: [0],
          daysForward: [daysForward],
        }),
      },
      code: `import { legs, strategy } from '@totalfinance/strategy';\n\nconst market = ${JSON.stringify(market, null, 2)};\nconst position = strategy([legs.call({ strike: 100, quantity: 1 }), legs.call({ strike: 110, quantity: -1 })], { premiums: 'model', market, multiplier: 100 });\nconst result = position.scenarioTable(${JSON.stringify(configuration, null, 2)});\nconsole.log(result);`,
    };
  },
};
