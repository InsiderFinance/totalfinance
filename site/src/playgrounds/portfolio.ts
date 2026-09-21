import {
  createPortfolioLedger,
  portfolioPnl,
  portfolioTimeline,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import type { Playground } from '../types.js';

export const portfolio: Playground = {
  id: 'track-portfolio-pnl',
  title: 'Track profit, not deposits',
  introduction:
    'A sample ledger holds one equity position. Change the closing mark or add a deposit: new cash changes account value, but it is not investment profit. USD throughout.',
  controls: [
    {
      name: 'quantity',
      label: 'Shares held',
      unit: 'shares',
      value: 100,
      min: 1,
      max: 500,
      step: 1,
    },
    {
      name: 'openingPrice',
      label: 'Opening price',
      unit: 'USD / share',
      value: 150,
      min: 1,
      max: 200,
      step: 1,
    },
    {
      name: 'closingPrice',
      label: 'Closing price',
      unit: 'USD / share',
      value: 165,
      min: 1,
      max: 1000,
      step: 1,
    },
    {
      name: 'deposit',
      label: 'Additional deposit',
      unit: 'USD · February 15',
      value: 5000,
      min: 0,
      max: 1000000,
      step: 100,
    },
  ],
  run(input) {
    const { quantity = 100, openingPrice = 150, closingPrice = 165, deposit = 5000 } = input;
    const shared = {
      schemaVersion: 1 as const,
      sourceId: 'sample',
      accountId: 'main',
      provenance: {},
    };
    const events: PortfolioEventEnvelope[] = [
      {
        ...shared,
        eventId: 'opening-deposit',
        eventType: 'cash.deposit',
        effectiveTimestampMs: Date.UTC(2026, 0, 1),
        recordedTimestampMs: Date.UTC(2026, 0, 1),
        event: { eventType: 'cash.deposit', amount: 100000, currency: 'USD' },
      },
      {
        ...shared,
        eventId: 'opening-fill',
        eventType: 'trade.fill',
        effectiveTimestampMs: Date.UTC(2026, 0, 2),
        recordedTimestampMs: Date.UTC(2026, 0, 2),
        event: {
          eventType: 'trade.fill',
          instrumentId: 'SAMPLE',
          side: 'buy',
          quantity,
          pricePerUnit: openingPrice,
          currency: 'USD',
        },
      },
      ...(deposit === 0
        ? []
        : [
            {
              ...shared,
              eventId: 'additional-deposit',
              eventType: 'cash.deposit' as const,
              effectiveTimestampMs: Date.UTC(2026, 1, 15),
              recordedTimestampMs: Date.UTC(2026, 1, 15),
              event: { eventType: 'cash.deposit' as const, amount: deposit, currency: 'USD' },
            },
          ]),
    ];
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events });
    const marks = Array.from({ length: 5 }, (_, index) => ({
      valuationDate: new Date(Date.UTC(2026, 1, 1 + index * 7)).toISOString().slice(0, 10),
      price: openingPrice + ((closingPrice - openingPrice) * index) / 4,
    }));
    const valuationMarks = marks.map((mark) => ({
      valuationDate: mark.valuationDate,
      market: createMarketSnapshot({
        asOf: mark.valuationDate,
        observations: { spots: { SAMPLE: { price: mark.price, currency: 'USD' } } },
      }),
    }));
    const pnl = portfolioPnl({ ledger, from: valuationMarks[0]!, to: valuationMarks.at(-1)! });
    const timeline = portfolioTimeline({ ledger, valuationMarks });
    const result = { pnl, timeline };
    return {
      metrics: [
        { label: 'Ending account value', value: pnl.to.netAssetValue, unit: 'USD' },
        { label: 'Investment P&L', value: pnl.investmentReturn, unit: 'USD' },
        { label: 'External cash flow', value: pnl.externalFlows, unit: 'USD · not profit' },
        { label: 'Reconciliation residual', value: pnl.residual, unit: 'USD' },
      ],
      chart: {
        title: 'Account value across sample weekly marks',
        xLabel: 'Days since February 1, 2026',
        yLabel: 'Net asset value · USD',
        series: [
          {
            name: 'Account value (includes deposits)',
            points: timeline.rows.map((row, index) => ({ x: index * 7, y: row.netAssetValue })),
          },
        ],
      },
      assumptions: {
        pnl: pnl.assumptions,
        timeline: timeline.assumptions,
        sample:
          'Linear hypothetical price path. No trading, fees, dividends, or FX during the measurement window.',
      },
      diagnostics: { pnl: pnl.diagnostics, timeline: timeline.diagnostics },
      result,
      example: {
        description:
          'portfolioPnl returns a report separating investment return from external cash flows. This example prints selected fields in USD. A timeline is optional: only the opening and closing marks are needed for this report.',
        setup: {
          description:
            'Sample inputs: a USD ledger with an opening deposit, a share purchase and an optional later deposit. The two market snapshots below are hypothetical marks, not a data connection. Copy setup + call includes the complete setup.',
          preview: JSON.stringify({ quantity, openingPrice, closingPrice, deposit }, null, 2),
          code: `import { createPortfolioLedger, portfolioPnl, type PortfolioEventEnvelope } from '@totalfinance/portfolio';\nimport { createMarketSnapshot } from '@totalfinance/core/artifacts';\n\nconst events: PortfolioEventEnvelope[] = ${JSON.stringify(events, null, 2)};\nconst ledger = createPortfolioLedger({ baseCurrency: 'USD', events });\nconst from = {\n  valuationDate: '${marks[0]!.valuationDate}',\n  market: createMarketSnapshot({\n    asOf: '${marks[0]!.valuationDate}',\n    observations: { spots: { SAMPLE: { price: ${openingPrice}, currency: 'USD' } } },\n  }),\n};\nconst to = {\n  valuationDate: '${marks.at(-1)!.valuationDate}',\n  market: createMarketSnapshot({\n    asOf: '${marks.at(-1)!.valuationDate}',\n    observations: { spots: { SAMPLE: { price: ${closingPrice}, currency: 'USD' } } },\n  }),\n};`,
        },
        code: `const pnl = portfolioPnl({ ledger, from, to });\nconst result = {\n  endingAccountValue: pnl.to.netAssetValue,\n  investmentReturn: pnl.investmentReturn,\n  externalFlows: pnl.externalFlows,\n  residual: pnl.residual,\n};\nconsole.log(result);`,
        result: {
          endingAccountValue: pnl.to.netAssetValue,
          investmentReturn: pnl.investmentReturn,
          externalFlows: pnl.externalFlows,
          residual: pnl.residual,
        },
      },
      code: `import { createPortfolioLedger, portfolioPnl, portfolioTimeline, type PortfolioEventEnvelope } from '@totalfinance/portfolio';\nimport { createMarketSnapshot } from '@totalfinance/core/artifacts';\n\nconst events: PortfolioEventEnvelope[] = ${JSON.stringify(events, null, 2)};\nconst ledger = createPortfolioLedger({ baseCurrency: 'USD', events });\nconst marks = ${JSON.stringify(marks, null, 2)};\nconst valuationMarks = marks.map(mark => ({\n  valuationDate: mark.valuationDate,\n  market: createMarketSnapshot({ asOf: mark.valuationDate, observations: { spots: { SAMPLE: { price: mark.price, currency: 'USD' } } } }),\n}));\nconst result = {\n  pnl: portfolioPnl({ ledger, from: valuationMarks[0]!, to: valuationMarks.at(-1)! }),\n  timeline: portfolioTimeline({ ledger, valuationMarks }),\n};\nconsole.log(result);`,
    };
  },
};
