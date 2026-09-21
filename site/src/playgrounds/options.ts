import { blackScholes } from '@totalfinance/options';
import type { Playground } from '../types.js';

export const options: Playground = {
  id: 'price-an-option',
  title: 'Price a European call',
  introduction:
    'Change a sample market input. Price and Greeks use Black–Scholes–Merton, with explicit decimal rates and years to expiry.',
  controls: [
    {
      name: 'spot',
      label: 'Underlying price',
      unit: 'USD / share',
      value: 100,
      min: 1,
      max: 10000,
      step: 1,
    },
    {
      name: 'strike',
      label: 'Strike price',
      unit: 'USD / share',
      value: 105,
      min: 1,
      max: 10000,
      step: 1,
    },
    {
      name: 'timeToExpiryYears',
      label: 'Time to expiry',
      unit: 'years',
      value: 0.25,
      min: 0.001,
      max: 10,
      step: 0.01,
    },
    {
      name: 'volatility',
      label: 'Volatility',
      unit: 'decimal · 0.20 = 20%',
      value: 0.2,
      min: 0.001,
      max: 3,
      step: 0.01,
    },
    {
      name: 'riskFreeRate',
      label: 'Risk-free rate',
      unit: 'decimal · 0.04 = 4%',
      value: 0.04,
      min: -0.2,
      max: 0.5,
      step: 0.005,
    },
    {
      name: 'dividendYield',
      label: 'Dividend yield',
      unit: 'decimal',
      value: 0,
      min: 0,
      max: 0.5,
      step: 0.005,
    },
  ],
  run(input) {
    const request = {
      type: 'call' as const,
      spot: input['spot']!,
      strike: input['strike']!,
      timeToExpiryYears: input['timeToExpiryYears']!,
      volatility: input['volatility']!,
      riskFreeRate: input['riskFreeRate']!,
      dividendYield: input['dividendYield']!,
    };
    const price = blackScholes.price.explain(request);
    const greeks = blackScholes.greeks.explain(request);
    const priceCurve = Array.from({ length: 61 }, (_, index) => {
      const spot = request.spot * (0.7 + index / 100);
      return { x: spot, y: blackScholes.price({ ...request, spot }) };
    });
    return {
      metrics: [
        { label: 'Call price', value: price.value, unit: 'USD / share' },
        { label: 'Delta', value: greeks.value.delta },
        { label: 'Gamma', value: greeks.value.gamma },
        { label: 'Vega', value: greeks.value.vega, unit: 'per 1% volatility' },
      ],
      chart: {
        title: 'Price across underlying prices',
        xLabel: 'Underlying price · USD',
        yLabel: 'Option price · USD / share',
        series: [{ name: 'European call', points: priceCurve }],
      },
      assumptions: { price: price.assumptions, greeks: greeks.assumptions },
      diagnostics: { price: price.diagnostics, greeks: greeks.diagnostics },
      result: { price, greeks, priceCurve },
      example: {
        description:
          'Returns a number: the option price in USD per share. No array conversion or chart setup is needed. Use blackScholes.greeks(input) for a named Greeks object, or .explain(input) for assumptions and diagnostics.',
        code: `import { blackScholes } from '@totalfinance/options';\n\nconst input = ${JSON.stringify(request, null, 2)} as const;\nconst result = blackScholes.price(input);\nconsole.log(result);`,
        result: price.value,
      },
      code: `import { blackScholes } from '@totalfinance/options';\n\nconst input = ${JSON.stringify(request, null, 2)} as const;\nconst priceCurve = Array.from({ length: 61 }, (_, index) => {\n  const spot = input.spot * (0.7 + index / 100);\n  return { x: spot, y: blackScholes.price({ ...input, spot }) };\n});\nconst result = {\n  price: blackScholes.price.explain(input),\n  greeks: blackScholes.greeks.explain(input),\n  priceCurve,\n};\nconsole.log(result);`,
    };
  },
};
