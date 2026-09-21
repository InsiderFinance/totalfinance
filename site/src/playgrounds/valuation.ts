import { discountedCashFlow, type DiscountedCashFlowInput } from '@totalfinance/valuation';
import type { Playground } from '../types.js';

export const valuation: Playground = {
  id: 'value-a-company',
  title: 'Value a company’s cash flows',
  introduction:
    'A five-year sample FCFF forecast produces enterprise value. A discount rate is a stated assumption—not a market fact. No debt/cash bridge or share count is silently invented.',
  controls: [
    {
      name: 'firstCashFlow',
      label: 'First-year free cash flow',
      unit: 'USD',
      value: 1000000,
      min: 1,
      max: 10000000000,
      step: 10000,
    },
    {
      name: 'growthRate',
      label: 'Forecast growth',
      unit: 'decimal · each forecast year',
      value: 0.06,
      min: -0.5,
      max: 0.5,
      step: 0.01,
    },
    {
      name: 'annualDiscountRate',
      label: 'Annual discount rate',
      unit: 'decimal · user assumption',
      value: 0.1,
      min: 0.005,
      max: 0.5,
      step: 0.005,
    },
    {
      name: 'perpetualGrowthRate',
      label: 'Terminal growth',
      unit: 'decimal · below discount rate',
      value: 0.025,
      min: -0.1,
      max: 0.2,
      step: 0.005,
    },
  ],
  run(input) {
    const {
      firstCashFlow = 1000000,
      growthRate = 0.06,
      annualDiscountRate = 0.1,
      perpetualGrowthRate = 0.025,
    } = input;
    const projectedCashFlows = Array.from({ length: 5 }, (_, index) => ({
      timeYears: index + 1,
      amount: firstCashFlow * (1 + growthRate) ** index,
    }));
    const request: DiscountedCashFlowInput = {
      valuationBasis: 'firm',
      valuationDate: '2026-01-01',
      currency: 'USD',
      projectedCashFlows,
      annualDiscountRate,
      compounding: 'annual',
      terminalValueMethod: {
        method: 'perpetual-growth',
        terminalCashFlow: projectedCashFlows.at(-1)!.amount,
        perpetualGrowthRate,
      },
    };
    const result = discountedCashFlow(request);
    if (result.valuationBasis !== 'firm') throw new Error('Expected a firm-basis valuation.');
    const rates = Array.from(
      { length: 21 },
      (_, index) =>
        Math.max(perpetualGrowthRate + 0.005, annualDiscountRate - 0.025) + index * 0.0025,
    );
    const sensitivity = rates.map((rate) => {
      const row = discountedCashFlow({ ...request, annualDiscountRate: rate });
      if (row.valuationBasis !== 'firm') throw new Error('Expected firm basis.');
      return { x: rate, y: row.enterpriseValue };
    });
    return {
      metrics: [
        {
          label: 'Enterprise value',
          value: result.enterpriseValue,
          unit: 'USD · not equity value',
        },
        {
          label: 'Forecast present value',
          value: result.projectedCashFlowPresentValue,
          unit: 'USD',
        },
        { label: 'Terminal present value', value: result.terminalValuePresentValue, unit: 'USD' },
        {
          label: 'Terminal share of value',
          value: result.diagnostics.terminalValueShareOfValue,
          unit: 'decimal fraction',
        },
      ],
      chart: {
        title: 'Sensitivity to the annual discount rate',
        xLabel: 'Annual discount rate · decimal',
        yLabel: 'Enterprise value · USD',
        series: [{ name: 'Five-year FCFF valuation', points: sensitivity }],
      },
      assumptions: result.assumptions,
      diagnostics: result.diagnostics,
      result: { valuation: result, sensitivity },
      example: {
        description:
          'Returns a valuation report. This example prints three selected fields from the firm-basis report, in USD. The sensitivity chart is a separate set of repeated valuations, not a required conversion of the answer.',
        code: `import { discountedCashFlow, type DiscountedCashFlowInput } from '@totalfinance/valuation';\n\nconst input: DiscountedCashFlowInput = ${JSON.stringify(request, null, 2)};\nconst valuation = discountedCashFlow(input);\nif (valuation.valuationBasis !== 'firm') throw new Error('Expected firm basis.');\nconst result = {\n  enterpriseValue: valuation.enterpriseValue,\n  projectedCashFlowPresentValue: valuation.projectedCashFlowPresentValue,\n  terminalValuePresentValue: valuation.terminalValuePresentValue,\n};\nconsole.log(result);`,
        result: {
          enterpriseValue: result.enterpriseValue,
          projectedCashFlowPresentValue: result.projectedCashFlowPresentValue,
          terminalValuePresentValue: result.terminalValuePresentValue,
        },
      },
      code: `import { discountedCashFlow, type DiscountedCashFlowInput } from '@totalfinance/valuation';\n\nconst input: DiscountedCashFlowInput = ${JSON.stringify(request, null, 2)};\nconst rates = Array.from({ length: 21 }, (_, index) => ${Math.max(perpetualGrowthRate + 0.005, annualDiscountRate - 0.025)} + index * 0.0025);\nconst sensitivity = rates.map(rate => {\n  const row = discountedCashFlow({ ...input, annualDiscountRate: rate });\n  if (row.valuationBasis !== 'firm') throw new Error('Expected firm basis.');\n  return { x: rate, y: row.enterpriseValue };\n});\n// Firm-basis cash flows produce enterprise value.\nconst result = { valuation: discountedCashFlow(input), sensitivity };\nconsole.log(result);`,
    };
  },
};
