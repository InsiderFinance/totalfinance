import { blackScholes, vanillaIntrinsic } from '@insiderfinance/totalfinance/options';
import type { Playground } from '../types';
import { numberInput, stringInput } from './inputs';

/** 81 underlying prices from 60% to 140% of the current spot, the chart's x-axis. */
const SPOT_GRID = Array.from({ length: 81 }, (_, index) => 0.6 + index / 100);

export const options: Playground = {
  id: 'price-an-option',
  title: 'Price a European option',
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
      display: 'currency',
    },
    {
      kind: 'select',
      name: 'type',
      label: 'Option type',
      value: 'call',
      options: [
        { value: 'call', label: 'Call' },
        { value: 'put', label: 'Put' },
      ],
    },
    {
      name: 'strike',
      label: 'Strike price',
      unit: 'USD / share',
      value: 105,
      min: 1,
      max: 10000,
      step: 1,
      display: 'currency',
    },
    {
      name: 'timeToExpiryYears',
      label: 'Time to expiry',
      unit: 'years',
      value: 0.25,
      min: 0.001,
      max: 10,
      step: 0.01,
      display: 'years',
    },
    {
      name: 'volatility',
      label: 'Volatility',
      unit: 'decimal · 0.20 = 20%',
      value: 0.2,
      min: 0.001,
      max: 3,
      step: 0.01,
      display: 'decimal-percent',
    },
    {
      name: 'riskFreeRate',
      label: 'Risk-free rate',
      unit: 'decimal · 0.04 = 4%',
      value: 0.04,
      min: -0.2,
      max: 0.5,
      step: 0.005,
      display: 'decimal-percent',
    },
    {
      name: 'dividendYield',
      label: 'Dividend yield',
      unit: 'decimal · continuous',
      value: 0,
      min: 0,
      max: 0.5,
      step: 0.005,
      display: 'decimal-percent',
    },
  ],
  run(input) {
    const type = stringInput(input, 'type') === 'put' ? ('put' as const) : ('call' as const);
    const request = {
      type,
      spot: numberInput(input, 'spot'),
      strike: numberInput(input, 'strike'),
      timeToExpiryYears: numberInput(input, 'timeToExpiryYears'),
      volatility: numberInput(input, 'volatility'),
      riskFreeRate: numberInput(input, 'riskFreeRate'),
      dividendYield: numberInput(input, 'dividendYield'),
    };
    const price = blackScholes.price.explain(request);
    const greeks = blackScholes.greeks.explain(request);
    const curve = SPOT_GRID.map((multiple) => {
      const spot = request.spot * multiple;
      const scenario = blackScholes.greeks({ ...request, spot });
      return {
        spot,
        price: blackScholes.price({ ...request, spot }),
        intrinsic: vanillaIntrinsic({ type, underlyingPrice: spot, strike: request.strike }),
        delta: scenario.delta,
        gamma: scenario.gamma,
        vega: scenario.vega,
        theta: scenario.theta,
      };
    });
    const label = type === 'call' ? 'Call' : 'Put';
    const markers = [
      { x: request.strike, label: `Strike ${request.strike}`, tone: 'neutral' as const },
      { x: request.spot, label: `Spot ${request.spot}`, tone: 'brand' as const },
    ];
    const greekChart = (
      field: 'delta' | 'gamma' | 'vega' | 'theta',
      title: string,
      yLabel: string,
    ) => ({
      title,
      size: 'half' as const,
      xLabel: 'Underlying price · USD',
      yLabel,
      xFormat: 'currency' as const,
      series: [{ name: title, points: curve.map((point) => ({ x: point.spot, y: point[field] })) }],
      markers,
    });
    return {
      metrics: [
        { label: `${label} price`, value: price.value, unit: 'USD / share', format: 'currency' },
        { label: 'Delta', value: greeks.value.delta, unit: 'per 1 USD of underlying' },
        { label: 'Gamma', value: greeks.value.gamma, unit: 'delta per 1 USD' },
        { label: 'Vega', value: greeks.value.vega, unit: 'USD per 1% volatility' },
        { label: 'Theta', value: greeks.value.theta, unit: 'USD per calendar day' },
        { label: 'Rho', value: greeks.value.rho, unit: 'USD per 1% rate' },
      ],
      chart: {
        title: `${label} value across underlying prices`,
        caption: `Today's Black–Scholes value against the value at expiry (intrinsic). The gap between them is time value.`,
        xLabel: 'Underlying price · USD',
        yLabel: 'Option value · USD / share',
        xFormat: 'currency',
        yFormat: 'currency',
        series: [
          {
            name: `${label} value today`,
            points: curve.map((point) => ({ x: point.spot, y: point.price })),
            style: 'area',
          },
          {
            name: 'Value at expiry (intrinsic)',
            points: curve.map((point) => ({ x: point.spot, y: point.intrinsic })),
            style: 'dashed',
          },
        ],
        markers,
        includeZero: true,
      },
      additionalCharts: [
        greekChart('delta', 'Delta', 'Delta · per 1 USD'),
        greekChart('gamma', 'Gamma', 'Gamma · delta per 1 USD'),
        greekChart('vega', 'Vega', 'Vega · USD per 1% volatility'),
        greekChart('theta', 'Theta', 'Theta · USD per day'),
      ],
      assumptions: { price: price.assumptions, greeks: greeks.assumptions },
      diagnostics: { price: price.diagnostics, greeks: greeks.diagnostics },
      result: { price, greeks, curve },
      example: {
        description: `Returns a number: the ${type} price in USD per share. No array conversion or chart setup is needed. Use blackScholes.greeks(input) for a named Greeks object, or .explain(input) for assumptions and diagnostics.`,
        code: `import { blackScholes } from '@insiderfinance/totalfinance/options';\n\nconst input = ${JSON.stringify(request, null, 2)} as const;\nconst result = blackScholes.price(input);\nconsole.log(result);`,
        result: price.value,
      },
      code: `import { blackScholes, vanillaIntrinsic } from '@insiderfinance/totalfinance/options';\n\nconst input = ${JSON.stringify(request, null, 2)} as const;\n// 81 underlying prices from 60% to 140% of spot: the chart's x-axis.\nconst curve = Array.from({ length: 81 }, (_, index) => {\n  const spot = input.spot * (0.6 + index / 100);\n  const greeks = blackScholes.greeks({ ...input, spot });\n  return {\n    spot,\n    price: blackScholes.price({ ...input, spot }),\n    intrinsic: vanillaIntrinsic({ type: input.type, underlyingPrice: spot, strike: input.strike }),\n    delta: greeks.delta,\n    gamma: greeks.gamma,\n    vega: greeks.vega,\n    theta: greeks.theta,\n  };\n});\nconst result = {\n  price: blackScholes.price.explain(input),\n  greeks: blackScholes.greeks.explain(input),\n  curve,\n};\nconsole.log(result);`,
    };
  },
};
