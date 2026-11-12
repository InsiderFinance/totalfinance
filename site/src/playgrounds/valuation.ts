import {
  discountedCashFlow,
  discountedCashFlowSensitivityTable,
  type DiscountedCashFlowInput,
} from '@insiderfinance/totalfinance/valuation';
import type { Playground } from '../types';
import { numberInput } from './inputs';

/** Axis values around the base case, rounded to a millionth so they read as the rates they are. */
const around = (center: number, step: number) =>
  [-3, -2, -1, 0, 1, 2, 3].map((offset) => Math.round((center + offset * step) * 1e6) / 1e6);

/** The largest round step no bigger than `limit`, so every table cell keeps rate > growth. */
const niceStep = (limit: number, candidates: readonly number[]) =>
  candidates.find((step) => step <= limit) ?? candidates.at(-1)!;
const STEPS = [0.01, 0.005, 0.0025, 0.001, 0.0005, 0.00025] as const;

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
      display: 'currency',
    },
    {
      name: 'growthRate',
      label: 'Forecast growth',
      unit: 'decimal · each forecast year',
      value: 0.06,
      min: -0.5,
      max: 0.5,
      step: 0.01,
      display: 'decimal-percent',
    },
    {
      name: 'annualDiscountRate',
      label: 'Annual discount rate',
      unit: 'decimal · user assumption',
      value: 0.1,
      min: 0.005,
      max: 0.5,
      step: 0.005,
      display: 'decimal-percent',
    },
    {
      name: 'perpetualGrowthRate',
      label: 'Terminal growth',
      unit: 'decimal · below discount rate',
      value: 0.025,
      min: -0.1,
      max: 0.2,
      step: 0.005,
      display: 'decimal-percent',
    },
  ],
  run(input) {
    const firstCashFlow = numberInput(input, 'firstCashFlow');
    const growthRate = numberInput(input, 'growthRate');
    const annualDiscountRate = numberInput(input, 'annualDiscountRate');
    const perpetualGrowthRate = numberInput(input, 'perpetualGrowthRate');
    if (annualDiscountRate - perpetualGrowthRate < 0.005)
      throw new Error(
        'The discount rate must exceed terminal growth by at least half a percentage point; otherwise the perpetuity has no finite value.',
      );
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
    // Every cell must keep the discount rate above terminal growth: three steps either side of
    // each base value may consume at most half of the gap between them.
    const gap = annualDiscountRate - perpetualGrowthRate;
    const growthValues = around(perpetualGrowthRate, niceStep(Math.min(0.005, gap / 12), STEPS));
    const rateValues = around(annualDiscountRate, niceStep(Math.min(0.01, gap / 12), STEPS));
    const table = discountedCashFlowSensitivityTable({
      discountedCashFlowInput: request,
      rowAxis: { variable: 'annual-discount-rate', values: rateValues },
      columnAxis: { variable: 'perpetual-growth-rate', values: growthValues },
    });
    const valuationResult = { valuation: result, sensitivity: table };
    return {
      metrics: [
        {
          label: 'Enterprise value',
          value: result.enterpriseValue,
          unit: 'USD · not equity value',
          format: 'currency',
        },
        {
          label: 'Forecast present value',
          value: result.projectedCashFlowPresentValue,
          unit: 'USD',
          format: 'currency',
        },
        {
          label: 'Terminal present value',
          value: result.terminalValuePresentValue,
          unit: 'USD',
          format: 'currency',
        },
        {
          label: 'Terminal share of value',
          value: result.diagnostics.terminalValueShareOfValue,
          unit: 'of enterprise value',
          format: 'decimal-percent',
        },
      ],
      chart: {
        kind: 'heatmap',
        title: 'Enterprise value by discount rate and terminal growth',
        caption:
          'Each cell is a full discounted-cash-flow valuation with one row and one column value substituted. The outlined cell is your base case.',
        xLabel: 'Terminal growth',
        yLabel: 'Annual discount rate',
        valueLabel: 'Enterprise value · USD',
        xFormat: 'decimal-percent',
        yFormat: 'decimal-percent',
        valueFormat: 'compact',
        x: table.columnValues,
        y: table.rowValues,
        values: table.cells,
        scale: 'sequential',
        highlight: { x: growthValues[3]!, y: rateValues[3]! },
      },
      additionalCharts: [
        {
          title: 'Enterprise value along the discount-rate axis',
          caption:
            'The base-case terminal growth column of the table: value falls as the discount rate rises.',
          xLabel: 'Annual discount rate',
          yLabel: 'Enterprise value · USD',
          xFormat: 'decimal-percent',
          yFormat: 'compact',
          series: [
            {
              name: `Terminal growth ${(perpetualGrowthRate * 100).toFixed(1)}%`,
              points: table.rowValues.map((rate, row) => ({
                x: rate,
                y: table.cells[row]![3]!,
              })),
            },
          ],
          markers: [{ x: annualDiscountRate, label: 'Base case', tone: 'brand' }],
        },
      ],
      assumptions: { valuation: result.assumptions, sensitivity: table.assumptions },
      diagnostics: { valuation: result.diagnostics, sensitivity: table.diagnostics },
      result: valuationResult,
      example: {
        description:
          'Returns a valuation report. This example prints three selected fields from the firm-basis report, in USD. The sensitivity table is a separate set of full valuations, not a required conversion of the answer.',
        code: `import { discountedCashFlow, type DiscountedCashFlowInput } from '@insiderfinance/totalfinance/valuation';\n\nconst input: DiscountedCashFlowInput = ${JSON.stringify(request, null, 2)};\nconst valuation = discountedCashFlow(input);\nif (valuation.valuationBasis !== 'firm') throw new Error('Expected firm basis.');\nconst result = {\n  enterpriseValue: valuation.enterpriseValue,\n  projectedCashFlowPresentValue: valuation.projectedCashFlowPresentValue,\n  terminalValuePresentValue: valuation.terminalValuePresentValue,\n};\nconsole.log(result);`,
        result: {
          enterpriseValue: result.enterpriseValue,
          projectedCashFlowPresentValue: result.projectedCashFlowPresentValue,
          terminalValuePresentValue: result.terminalValuePresentValue,
        },
      },
      code: `import {\n  discountedCashFlow,\n  discountedCashFlowSensitivityTable,\n  type DiscountedCashFlowInput,\n} from '@insiderfinance/totalfinance/valuation';\n\nconst input: DiscountedCashFlowInput = ${JSON.stringify(request, null, 2)};\nconst valuation = discountedCashFlow(input);\n// Every cell is a direct discountedCashFlow call with one row and one column value substituted.\nconst sensitivity = discountedCashFlowSensitivityTable({\n  discountedCashFlowInput: input,\n  rowAxis: { variable: 'annual-discount-rate', values: ${JSON.stringify(rateValues)} },\n  columnAxis: { variable: 'perpetual-growth-rate', values: ${JSON.stringify(growthValues)} },\n});\nconst result = { valuation, sensitivity };\nconsole.log(result);`,
    };
  },
};
