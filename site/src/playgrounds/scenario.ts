import { legs, strategy } from '@insiderfinance/totalfinance/strategy';
import type { Playground } from '../types';
import { numberInput } from './inputs';

const VOLATILITY_SHOCKS = [-0.1, -0.05, 0, 0.05, 0.1];

export const scenarios: Playground = {
  id: 'explore-scenarios',
  title: 'Explore price and volatility scenarios',
  introduction:
    'Revalue a sample 100/110 bull call spread before expiry across underlying prices and volatility shocks. This is mark-to-market P&L, not an expiration payoff or a forecast.',
  controls: [
    {
      name: 'spot',
      label: 'Starting underlying price',
      unit: 'USD',
      value: 100,
      min: 50,
      max: 200,
      step: 1,
      display: 'currency',
    },
    {
      name: 'volatility',
      label: 'Starting volatility',
      unit: 'decimal · stays above 0.10 so every shock is valid',
      value: 0.25,
      min: 0.11,
      max: 2,
      step: 0.01,
      display: 'decimal-percent',
    },
    {
      name: 'daysForward',
      label: 'Advance valuation date',
      unit: 'calendar days · integer',
      value: 7,
      min: 0,
      max: 28,
      step: 1,
      display: 'days',
    },
    {
      name: 'riskFreeRate',
      label: 'Risk-free rate',
      unit: 'decimal',
      value: 0.04,
      min: -0.2,
      max: 0.5,
      step: 0.005,
      display: 'decimal-percent',
    },
  ],
  run(input) {
    const spot = numberInput(input, 'spot');
    const volatility = numberInput(input, 'volatility');
    const daysForward = numberInput(input, 'daysForward');
    const riskFreeRate = numberInput(input, 'riskFreeRate');
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
      prices: { from: 75, to: 135, steps: 25 },
      volatilityShocks: VOLATILITY_SHOCKS,
      daysForward: [daysForward],
    };
    const result = position.scenarioTable(configuration);
    const prices = [...new Set(result.value.map((row) => row.underlyingPrice))].sort(
      (a, b) => a - b,
    );
    const cell = (shock: number, price: number) =>
      result.value.find((row) => row.volatilityShock === shock && row.underlyingPrice === price)!
        .pnl;
    const values = result.value.map((row) => row.pnl);
    const shockLabel = (shock: number) =>
      shock === 0
        ? 'No volatility shock'
        : `${shock > 0 ? '+' : '−'}${Math.abs(shock * 100)} volatility points`;
    return {
      metrics: [
        { label: 'Scenario cells', value: result.value.length, format: 'integer' },
        {
          label: 'Lowest grid P&L',
          value: Math.min(...values),
          unit: 'USD · not maximum loss',
          format: 'currency',
          tone: 'loss',
        },
        {
          label: 'Highest grid P&L',
          value: Math.max(...values),
          unit: 'USD · not maximum profit',
          format: 'currency',
          tone: 'profit',
        },
        { label: 'Days forward', value: daysForward, format: 'integer' },
      ],
      chart: {
        kind: 'heatmap',
        title: 'Mark-to-market P&L by underlying price and volatility shock',
        caption:
          'Green cells make money and red cells lose it, relative to the model premiums paid today. Rows shift implied volatility; the valuation date advances by the chosen days.',
        xLabel: 'Scenario underlying price · USD',
        yLabel: 'Volatility shock',
        valueLabel: 'P&L · USD',
        xFormat: 'currency',
        yFormat: 'decimal-percent',
        valueFormat: 'currency',
        x: prices,
        y: VOLATILITY_SHOCKS,
        values: VOLATILITY_SHOCKS.map((shock) => prices.map((price) => cell(shock, price))),
        scale: 'diverging',
      },
      additionalCharts: [
        {
          title: 'P&L curves for three volatility shocks',
          xLabel: 'Scenario underlying price · USD',
          yLabel: 'P&L · USD',
          xFormat: 'currency',
          yFormat: 'currency',
          series: [-0.05, 0, 0.05].map((shock) => ({
            name: shockLabel(shock),
            points: prices.map((price) => ({ x: price, y: cell(shock, price) })),
            ...(shock === 0 ? {} : { style: 'dashed' as const }),
          })),
          markers: [
            { x: spot, label: `Starting price ${spot}`, tone: 'brand' },
            { y: 0, label: 'Break-even', tone: 'neutral' },
          ],
          includeZero: true,
        },
      ],
      assumptions: result.assumptions,
      diagnostics: result.diagnostics,
      result,
      example: {
        description:
          'Returns scenario rows in value, plus assumptions and diagnostics. Each row names its underlying price, volatility shock and P&L. These three price scenarios use the same market and time advance as the chart, with no volatility shock.',
        code: `import { legs, strategy } from '@insiderfinance/totalfinance/strategy';\n\nconst market = ${JSON.stringify(market, null, 2)};\nconst position = strategy([\n  legs.call({ strike: 100, quantity: 1 }),\n  legs.call({ strike: 110, quantity: -1 }),\n], { premiums: 'model', market, multiplier: 100 });\nconst underlyingPrices = [90, 100, 110];\nconst result = position.scenarioTable({\n  prices: underlyingPrices,\n  volatilityShocks: [0],\n  daysForward: [${daysForward}],\n});\nconsole.log(result);`,
        result: position.scenarioTable({
          prices: [90, 100, 110],
          volatilityShocks: [0],
          daysForward: [daysForward],
        }),
      },
      code: `import { legs, strategy } from '@insiderfinance/totalfinance/strategy';\n\nconst market = ${JSON.stringify(market, null, 2)};\nconst position = strategy(\n  [legs.call({ strike: 100, quantity: 1 }), legs.call({ strike: 110, quantity: -1 })],\n  { premiums: 'model', market, multiplier: 100 },\n);\nconst result = position.scenarioTable(${JSON.stringify(configuration, null, 2)});\nconsole.log(result);`,
    };
  },
};
