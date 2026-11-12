import { resolvedExpiry } from '@insiderfinance/totalfinance/core';
import { volatilitySurface } from '@insiderfinance/totalfinance/volatility';
import type { Playground, TableRow } from '../types';
import { numberInput, stringInput, tableInput } from './inputs';

const AS_OF = '2026-01-02T21:00:00Z';
const EXPIRY = '2026-03-20';

/** Hypothetical skewed equity smile: put wing richer than the call wing. Not market quotes. */
const SAMPLE_QUOTES: TableRow[] = [
  { strike: 80, impliedVolatility: 0.32 },
  { strike: 90, impliedVolatility: 0.27 },
  { strike: 95, impliedVolatility: 0.245 },
  { strike: 100, impliedVolatility: 0.225 },
  { strike: 105, impliedVolatility: 0.21 },
  { strike: 110, impliedVolatility: 0.205 },
  { strike: 120, impliedVolatility: 0.21 },
];

const FLAT_QUOTES: TableRow[] = SAMPLE_QUOTES.map((row) => ({ ...row, impliedVolatility: 0.22 }));
const SMILE_QUOTES: TableRow[] = [
  { strike: 80, impliedVolatility: 0.3 },
  { strike: 90, impliedVolatility: 0.25 },
  { strike: 95, impliedVolatility: 0.23 },
  { strike: 100, impliedVolatility: 0.22 },
  { strike: 105, impliedVolatility: 0.225 },
  { strike: 110, impliedVolatility: 0.24 },
  { strike: 120, impliedVolatility: 0.28 },
];

export const smile: Playground = {
  id: 'fit-a-volatility-smile',
  title: 'Fit a volatility smile',
  introduction:
    'Enter implied volatilities by strike for one expiry and fit a smooth smile with SVI, SABR or monotone interpolation. Read off the at-the-money level and wings, and check the fit for butterfly arbitrage.',
  controls: [
    {
      name: 'spot',
      label: 'Underlying price',
      unit: 'USD',
      value: 100,
      min: 1,
      max: 100000,
      step: 1,
      display: 'currency',
    },
    {
      kind: 'select',
      name: 'model',
      label: 'Smile model',
      value: 'svi',
      options: [
        { value: 'svi', label: 'SVI (raw, Gatheral)' },
        { value: 'sabr', label: 'SABR (β = 0.5)' },
        { value: 'interpolated', label: 'Monotone interpolation (PCHIP)' },
      ],
    },
    {
      kind: 'table',
      name: 'quotes',
      label: 'Implied volatility quotes',
      hint: `One expiry (${EXPIRY}), valued at ${AS_OF}. Volatilities are decimals: 0.25 = 25%. SVI needs at least five strikes.`,
      columns: [
        {
          name: 'strike',
          label: 'Strike',
          unit: 'USD',
          type: 'number',
          min: 0.01,
          max: 1000000,
          step: 1,
        },
        {
          name: 'impliedVolatility',
          label: 'Implied vol',
          unit: 'decimal',
          type: 'number',
          min: 0.01,
          max: 5,
          step: 0.005,
        },
      ],
      value: SAMPLE_QUOTES,
      minRows: 3,
      maxRows: 40,
      newRow: { strike: 130, impliedVolatility: 0.22 },
      presets: [
        { id: 'skew', label: 'Equity skew', rows: SAMPLE_QUOTES },
        { id: 'smile', label: 'Symmetric smile', rows: SMILE_QUOTES },
        { id: 'flat', label: 'Flat volatility', rows: FLAT_QUOTES },
      ],
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
    const model = stringInput(input, 'model');
    const riskFreeRate = numberInput(input, 'riskFreeRate');
    if (model !== 'svi' && model !== 'sabr' && model !== 'interpolated')
      throw new Error('Choose svi, sabr or interpolated.');
    const rows = [...tableInput(input, 'quotes')].sort(
      (a, b) => (a['strike'] as number) - (b['strike'] as number),
    );
    const strikes = rows.map((row) => row['strike'] as number);
    if (new Set(strikes).size !== strikes.length)
      throw new Error('Each strike may appear only once.');
    if (model === 'svi' && rows.length < 5)
      throw new Error('SVI has five parameters: supply at least five strikes.');
    const table = rows.map((row) => ({
      strike: row['strike'] as number,
      impliedVolatility: row['impliedVolatility'] as number,
    }));
    const quotes = table.map((row) => ({
      contract: {
        underlying: 'SAMPLE',
        type: row.strike >= spot ? ('call' as const) : ('put' as const),
        style: 'european' as const,
        strike: row.strike,
        expiry: EXPIRY,
        ...resolvedExpiry(EXPIRY),
      },
      timestampMs: Date.parse(AS_OF),
      impliedVolatility: row.impliedVolatility,
      underlyingPrice: spot,
    }));
    const surface = volatilitySurface({
      quotes,
      market: { spot, riskFreeRate, dividendYield: 0, asOf: AS_OF },
      config: { model },
    });
    const low = strikes[0]! * 0.9;
    const high = strikes.at(-1)! * 1.1;
    const fitted = Array.from({ length: 61 }, (_, index) => {
      const strike = low + ((high - low) * index) / 60;
      return { strike, impliedVolatility: surface.impliedVolatility(strike, EXPIRY) };
    });
    const arbitrage = surface.arbitrage();
    const slice = surface.slices[0]!;
    const result = {
      atTheMoney: surface.impliedVolatility(spot, EXPIRY),
      fitted,
      slice,
      arbitrage,
      diagnostics: surface.diagnostics,
    };
    const quotesCode = `const table = ${JSON.stringify(table, null, 2)};\nconst quotes = table.map((row) => ({\n  contract: {\n    underlying: 'SAMPLE',\n    type: row.strike >= ${spot} ? ('call' as const) : ('put' as const),\n    style: 'european' as const,\n    strike: row.strike,\n    expiry: '${EXPIRY}',\n    ...resolvedExpiry('${EXPIRY}'),\n  },\n  timestampMs: Date.parse('${AS_OF}'),\n  impliedVolatility: row.impliedVolatility,\n  underlyingPrice: ${spot},\n}));\nconst surface = volatilitySurface({\n  quotes,\n  market: { spot: ${spot}, riskFreeRate: ${riskFreeRate}, dividendYield: 0, asOf: '${AS_OF}' },\n  config: { model: '${model}' },\n});`;
    const imports = `import { resolvedExpiry } from '@insiderfinance/totalfinance/core';\nimport { volatilitySurface } from '@insiderfinance/totalfinance/volatility';`;
    const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
    return {
      metrics: [
        {
          label: 'At-the-money volatility',
          value: result.atTheMoney,
          unit: `at ${spot}`,
          format: 'decimal-percent',
        },
        {
          label: 'Lowest-strike wing',
          value: fitted[0]!.impliedVolatility,
          unit: `at ${low.toFixed(2)}`,
          format: 'decimal-percent',
        },
        {
          label: 'Highest-strike wing',
          value: fitted.at(-1)!.impliedVolatility,
          unit: `at ${high.toFixed(2)}`,
          format: 'decimal-percent',
        },
        {
          label: 'Butterfly arbitrage',
          value: arbitrage.checks.butterfly ? 'None found' : 'Violation',
          unit: `${arbitrage.violations.length} violation${arbitrage.violations.length === 1 ? '' : 's'} on the check grid`,
          tone: arbitrage.checks.butterfly ? 'profit' : 'loss',
        },
      ],
      chart: {
        title: `${model === 'interpolated' ? 'Interpolated' : model.toUpperCase()} smile for ${EXPIRY}`,
        caption: `Dots are your quotes; the line is the fitted smile, extended 10% beyond the outermost strikes. At the money: ${percent(result.atTheMoney)}.`,
        xLabel: 'Strike · USD',
        yLabel: 'Implied volatility',
        xFormat: 'currency',
        yFormat: 'decimal-percent',
        series: [
          {
            name: 'Fitted smile',
            points: fitted.map((point) => ({ x: point.strike, y: point.impliedVolatility })),
          },
          {
            name: 'Quotes',
            points: table.map((row) => ({ x: row.strike, y: row.impliedVolatility })),
            style: 'points',
          },
        ],
        markers: [{ x: spot, label: `Spot ${spot}`, tone: 'brand' }],
      },
      assumptions: surface.assumptions,
      diagnostics: { surface: surface.diagnostics, arbitrage: arbitrage.diagnostics },
      result,
      example: {
        description:
          'volatilitySurface fits a smile per expiry from quotes and returns a VolatilitySurface. impliedVolatility(strike, expiry) reads the fitted smile; slices expose the fitted parameters; arbitrage() checks butterfly and calendar conditions.',
        setup: {
          description: `${table.length} hypothetical implied-volatility quotes for one expiry. Copy setup + call includes the quotes and the fit.`,
          preview: JSON.stringify(table.slice(0, 3), null, 2),
          code: `${imports}\n\n${quotesCode}`,
        },
        code: `const result = {\n  atTheMoney: surface.impliedVolatility(${spot}, '${EXPIRY}'),\n  butterflyFree: surface.arbitrage().checks.butterfly,\n};\nconsole.log(result);`,
        result: { atTheMoney: result.atTheMoney, butterflyFree: arbitrage.checks.butterfly },
      },
      code: `${imports}\n\n${quotesCode}\n// 61 strikes from 10% below the lowest quote to 10% above the highest.\nconst fitted = Array.from({ length: 61 }, (_, index) => {\n  const strike = ${low} + ((${high} - ${low}) * index) / 60;\n  return { strike, impliedVolatility: surface.impliedVolatility(strike, '${EXPIRY}') };\n});\nconst result = {\n  atTheMoney: surface.impliedVolatility(${spot}, '${EXPIRY}'),\n  fitted,\n  slice: surface.slices[0]!,\n  arbitrage: surface.arbitrage(),\n  diagnostics: surface.diagnostics,\n};\nconsole.log(result);`,
    };
  },
};
