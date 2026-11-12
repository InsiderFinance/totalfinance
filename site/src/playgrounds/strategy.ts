import { blackScholes } from '@insiderfinance/totalfinance/options';
import { legs, strategy } from '@insiderfinance/totalfinance/strategy';
import type { Playground, TableRow } from '../types';
import { tableInput } from './inputs';

/**
 * Hypothetical preset premiums: Black–Scholes values at spot 100, 25% volatility, a 4% rate and 30
 * days to expiry, rounded to cents. They make the presets coherent; they are not market quotes.
 */
const presetPremium = (type: 'call' | 'put', strike: number) =>
  Math.round(
    blackScholes.price({
      type,
      spot: 100,
      strike,
      timeToExpiryYears: 30 / 365,
      volatility: 0.25,
      riskFreeRate: 0.04,
      dividendYield: 0,
    }) * 100,
  ) / 100;

const option = (type: 'call' | 'put', quantity: number, strike: number): TableRow => ({
  type,
  quantity,
  strike,
  premium: presetPremium(type, strike),
});
const stock = (quantity: number, price: number): TableRow => ({
  type: 'stock',
  quantity,
  strike: price,
  premium: 0,
});

const PRESETS = [
  {
    id: 'bull-call-spread',
    label: 'Bull call spread',
    rows: [option('call', 1, 100), option('call', -1, 110)],
  },
  {
    id: 'bear-put-spread',
    label: 'Bear put spread',
    rows: [option('put', 1, 100), option('put', -1, 90)],
  },
  {
    id: 'long-straddle',
    label: 'Long straddle',
    rows: [option('call', 1, 100), option('put', 1, 100)],
  },
  {
    id: 'short-strangle',
    label: 'Short strangle',
    rows: [option('call', -1, 110), option('put', -1, 90)],
  },
  {
    id: 'iron-condor',
    label: 'Iron condor',
    rows: [
      option('put', 1, 85),
      option('put', -1, 90),
      option('call', -1, 110),
      option('call', 1, 115),
    ],
  },
  {
    id: 'long-butterfly',
    label: 'Long call butterfly',
    rows: [option('call', 1, 95), option('call', -2, 100), option('call', 1, 105)],
  },
  { id: 'covered-call', label: 'Covered call', rows: [stock(100, 100), option('call', -1, 110)] },
  { id: 'protective-put', label: 'Protective put', rows: [stock(100, 100), option('put', 1, 95)] },
];

const legCode = (row: TableRow): string =>
  row['type'] === 'stock'
    ? `legs.stock({ price: ${row['strike']}, quantity: ${row['quantity']} })`
    : `legs.${row['type']}({ strike: ${row['strike']}, premium: ${row['premium']}, quantity: ${row['quantity']} })`;

export const strategies: Playground = {
  id: 'analyze-a-strategy',
  title: 'Analyze an option strategy',
  introduction:
    'Edit the legs or start from a preset. The chart is net profit or loss at expiration, not option value before expiry. Premiums are per share; the option contract multiplier is 100.',
  controls: [
    {
      kind: 'table',
      name: 'legs',
      label: 'Legs',
      hint: 'Positive quantity is long, negative is short. Options trade in contracts of 100 shares; stock quantity is shares, with its entry price in the strike/price column.',
      columns: [
        {
          name: 'type',
          label: 'Type',
          type: 'select',
          options: [
            { value: 'call', label: 'Call' },
            { value: 'put', label: 'Put' },
            { value: 'stock', label: 'Stock' },
          ],
        },
        {
          name: 'quantity',
          label: 'Quantity',
          unit: 'contracts or shares',
          type: 'number',
          min: -1000,
          max: 1000,
          step: 1,
        },
        {
          name: 'strike',
          label: 'Strike / price',
          unit: 'USD / share',
          type: 'number',
          min: 0.01,
          max: 100000,
          step: 1,
        },
        {
          name: 'premium',
          label: 'Premium',
          unit: 'USD / share',
          type: 'number',
          min: 0,
          max: 100000,
          step: 0.05,
        },
      ],
      value: PRESETS[0]!.rows,
      minRows: 1,
      maxRows: 8,
      newRow: { type: 'call', quantity: 1, strike: 100, premium: presetPremium('call', 100) },
      presets: PRESETS,
    },
  ],
  run(input) {
    const rows = tableInput(input, 'legs');
    rows.forEach((row, index) => {
      const quantity = row['quantity'] as number;
      if (!Number.isInteger(quantity) || quantity === 0)
        throw new Error(
          `Leg ${index + 1}: quantity must be a nonzero whole number (negative for short).`,
        );
      if (row['type'] === 'stock' && row['premium'] !== 0)
        throw new Error(
          `Leg ${index + 1}: a stock leg has no premium. Enter its entry price in Strike / price and set Premium to 0.`,
        );
    });
    const positionLegs = rows.map((row) =>
      row['type'] === 'stock'
        ? legs.stock({ price: row['strike'] as number, quantity: row['quantity'] as number })
        : (row['type'] === 'put' ? legs.put : legs.call)({
            strike: row['strike'] as number,
            premium: row['premium'] as number,
            quantity: row['quantity'] as number,
          }),
    );
    const levels = rows.map((row) => row['strike'] as number);
    const from = Math.min(...levels) * 0.7;
    const to = Math.max(...levels) * 1.3;
    const position = strategy(positionLegs, { multiplier: 100 });
    const result = position.payoff({ prices: { from, to, steps: 121 } });
    const samplePrices = [...new Set([from, ...levels, to])].sort((a, b) => a - b);
    const legLines = rows.map((row) => `  ${legCode(row)},`).join('\n');
    return {
      metrics: [
        result.netDebit >= 0
          ? {
              label: 'Net debit',
              value: result.netDebit,
              unit: 'USD paid to open',
              format: 'currency',
            }
          : {
              label: 'Net credit',
              value: result.netCredit,
              unit: 'USD received to open',
              format: 'currency',
            },
        {
          label: 'Maximum profit',
          value: result.maxProfit ?? 'Unbounded',
          unit: 'USD at expiration',
          format: 'currency',
          tone: 'profit',
        },
        {
          label: 'Maximum loss',
          value: result.maxLoss ?? 'Unbounded',
          unit: 'USD at expiration',
          format: 'currency',
          tone: 'loss',
        },
        {
          label: result.breakevens.length === 1 ? 'Break-even' : 'Break-evens',
          value: result.breakevens.length
            ? result.breakevens.map((value) => value.toFixed(2)).join(' · ')
            : 'None in range',
          unit: 'USD underlying',
        },
      ],
      chart: {
        title: 'Profit or loss at expiration',
        caption:
          'Shaded green where the position makes money at expiration and red where it loses, including the premiums paid and received.',
        xLabel: 'Underlying price at expiration · USD',
        yLabel: 'Net P&L · USD',
        xFormat: 'currency',
        yFormat: 'currency',
        series: [
          {
            name: 'Net P&L at expiration',
            points: result.points.map((point) => ({ x: point.underlyingPrice, y: point.pnl })),
            style: 'pnl',
          },
        ],
        markers: result.breakevens.map((value) => ({
          x: value,
          label: `Break-even ${value.toFixed(2)}`,
          tone: 'neutral' as const,
        })),
        includeZero: true,
      },
      assumptions: {
        model: 'piecewise-linear expiration payoff',
        contractMultiplier: 100,
        stockQuantity: 'shares, not scaled by the multiplier',
        premiums: 'caller-supplied, per share',
        costs: 'no commissions or slippage included',
        currency: 'USD',
      },
      diagnostics: {
        warnings: [
          'Preset premiums are hypothetical Black–Scholes values, not market quotes. Expiration payoff is not the mark-to-market value before expiration.',
        ],
        bounded: result.bounded,
      },
      result,
      example: {
        description:
          'Returns a payoff report with named summary fields (netDebit, maxProfit, maxLoss, breakevens) and an ordinary points array. Each point has underlyingPrice and pnl; amounts include the 100-share multiplier and premiums. These explicit prices sample the same position as the chart.',
        code: `import { legs, strategy } from '@insiderfinance/totalfinance/strategy';\n\nconst position = strategy([\n${legLines}\n], { multiplier: 100 });\nconst underlyingPrices = ${JSON.stringify(samplePrices)};\nconst result = position.payoff({ prices: underlyingPrices });\nconsole.log(result);`,
        result: position.payoff({ prices: samplePrices }),
      },
      code: `import { legs, strategy } from '@insiderfinance/totalfinance/strategy';\n\nconst position = strategy([\n${legLines}\n], { multiplier: 100 });\n// 121 evenly spaced prices from 70% of the lowest strike to 130% of the highest.\nconst result = position.payoff({ prices: { from: ${from}, to: ${to}, steps: 121 } });\nconsole.log(result);`,
    };
  },
};
