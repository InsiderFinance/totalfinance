import {
  annualizedVolatility,
  equityCurve,
  maxDrawdownFromReturns,
  simpleReturns,
  underwater,
} from '@insiderfinance/totalfinance/performance';
import { valueAtRiskReport } from '@insiderfinance/totalfinance/risk';
import { RETURN_SAMPLES } from '../data/samples';
import type { Playground } from '../types';
import { dataInput, numberInput, stringInput } from './inputs';

export const risk: Playground = {
  id: 'measure-risk',
  title: 'Measure value at risk',
  introduction:
    'Estimate one-period value at risk and expected shortfall from a return series, then see where those losses sit in the distribution and how deep the drawdowns ran. Paste daily returns, or closing prices and they become simple returns.',
  controls: [
    {
      kind: 'data',
      name: 'data',
      label: 'Returns or prices',
      hint: 'One value per line, optionally with a date column. Returns are decimals: −0.012 means −1.2%.',
      format: 'series',
      meanings: ['returns', 'prices'],
      value: RETURN_SAMPLES[2]!.value,
      samples: RETURN_SAMPLES,
      minRows: 20,
      maxRows: 10000,
    },
    {
      name: 'confidence',
      label: 'Confidence level',
      unit: 'decimal · 0.95 = 95%',
      value: 0.95,
      min: 0.8,
      max: 0.999,
      step: 0.005,
      display: 'decimal-percent',
    },
    {
      kind: 'select',
      name: 'method',
      label: 'Estimation method',
      value: 'historical',
      options: [
        { value: 'historical', label: 'Historical (empirical quantile)' },
        { value: 'parametric', label: 'Parametric (Gaussian)' },
      ],
    },
    {
      name: 'periodsPerYear',
      label: 'Periods per year',
      unit: 'for annualized volatility · 252 daily, 52 weekly, 12 monthly',
      value: 252,
      min: 1,
      max: 365,
      step: 1,
      display: 'integer',
      slider: false,
    },
  ],
  run(input) {
    const dataset = dataInput(input, 'data');
    if (dataset.format !== 'series')
      throw new Error('Supply a numeric series of returns or prices.');
    const confidence = numberInput(input, 'confidence');
    const method =
      stringInput(input, 'method') === 'parametric'
        ? ('parametric' as const)
        : ('historical' as const);
    const periodsPerYear = numberInput(input, 'periodsPerYear');
    if (!Number.isInteger(periodsPerYear))
      throw new Error('Periods per year must be a whole number.');
    const returns = dataset.meaning === 'prices' ? simpleReturns(dataset.values) : dataset.values;
    const report = valueAtRiskReport(returns, { confidence, method, horizonPeriods: 1 });
    const volatility = annualizedVolatility(returns, { periodsPerYear });
    const drawdown = maxDrawdownFromReturns(returns);
    const drawdownPath = underwater(equityCurve(returns, 1));
    const result = { report, annualizedVolatility: volatility, drawdown, drawdownPath };
    const dates = dataset.dates
      ? dataset.meaning === 'prices'
        ? dataset.dates.slice(1)
        : dataset.dates
      : null;
    const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
    const setupCode =
      dataset.meaning === 'prices'
        ? `import { valueAtRiskReport } from '@insiderfinance/totalfinance/risk';\nimport { simpleReturns } from '@insiderfinance/totalfinance/performance';\n\n// ${dataset.label}\nconst prices = ${JSON.stringify(dataset.values)};\nconst returns = simpleReturns(prices);`
        : `import { valueAtRiskReport } from '@insiderfinance/totalfinance/risk';\n\n// ${dataset.label}: simple returns as decimals.\nconst returns = ${JSON.stringify(dataset.values)};`;
    const fullSetup = setupCode
      .replace(
        "import { valueAtRiskReport } from '@insiderfinance/totalfinance/risk';",
        `import { valueAtRiskReport } from '@insiderfinance/totalfinance/risk';\nimport {\n  annualizedVolatility,\n  equityCurve,\n  maxDrawdownFromReturns,\n${dataset.meaning === 'prices' ? '  simpleReturns,\n' : ''}  underwater,\n} from '@insiderfinance/totalfinance/performance';`,
      )
      .replace("\nimport { simpleReturns } from '@insiderfinance/totalfinance/performance';", '');
    const call = `valueAtRiskReport(returns, { confidence: ${confidence}, method: '${method}', horizonPeriods: 1 })`;
    return {
      metrics: [
        {
          label: `Value at risk · ${percent(confidence)}`,
          value: report.valueAtRisk,
          unit: 'one-period loss, as a decimal',
          format: 'decimal-percent',
          tone: 'loss',
        },
        {
          label: 'Expected shortfall',
          value: report.conditionalValueAtRisk,
          unit: 'mean loss beyond VaR',
          format: 'decimal-percent',
          tone: 'loss',
        },
        {
          label: 'Annualized volatility',
          value: volatility,
          unit: `${periodsPerYear} periods per year`,
          format: 'decimal-percent',
        },
        {
          label: 'Maximum drawdown',
          value: drawdown.maxDrawdown,
          unit: `${drawdown.troughIndex - drawdown.peakIndex} periods peak to trough`,
          format: 'decimal-percent',
          tone: 'loss',
        },
        { label: 'Observations', value: returns.length, unit: 'returns', format: 'integer' },
      ],
      chart: {
        kind: 'histogram',
        title: 'Distribution of one-period returns',
        caption: `The shaded tail holds the returns at or below −VaR. Expected shortfall is the average of that tail. ${dataset.label}.`,
        xLabel: 'Return per period',
        yLabel: 'Number of periods',
        xFormat: 'decimal-percent',
        values: returns,
        tailBelow: -report.valueAtRisk,
        markers: [
          { x: -report.valueAtRisk, label: `VaR ${percent(report.valueAtRisk)}`, tone: 'loss' },
          {
            x: -report.conditionalValueAtRisk,
            label: `ES ${percent(report.conditionalValueAtRisk)}`,
            tone: 'loss',
          },
          { x: 0, label: 'Zero', tone: 'neutral' },
        ],
      },
      additionalCharts: [
        {
          title: 'Drawdown of the compounded return path',
          caption:
            'Decline from the running peak of an investment that earns these returns in order.',
          xLabel: dates ? 'Period' : 'Period index',
          yLabel: 'Below peak',
          yFormat: 'decimal-percent',
          series: [
            {
              name: 'Drawdown',
              points: drawdownPath.slice(1).map((value, index) => ({ x: index + 1, y: -value })),
              style: 'area',
            },
          ],
        },
      ],
      assumptions: {
        valueAtRisk: report.assumptions,
        method,
        confidence,
        horizonPeriods: 1,
        returns:
          dataset.meaning === 'prices'
            ? 'simple returns computed from consecutive closing prices'
            : 'reader or sample returns as supplied',
        annualization: { periodsPerYear },
      },
      diagnostics: {
        valueAtRisk: report.diagnostics,
        dataNotice:
          dataset.origin === 'sample'
            ? 'Synthetic sample returns, not market history.'
            : 'Reader-supplied data, used exactly as provided.',
      },
      result,
      example: {
        description:
          'valueAtRiskReport returns valueAtRisk and conditionalValueAtRisk as positive loss magnitudes (decimals of the position), with the applied confidence, method and horizon echoed and any warnings in diagnostics.',
        setup: {
          description: `${dataset.values.length} ${dataset.meaning} from: ${dataset.label}. Preview: the first five values. Copy setup + call includes every value.`,
          preview: JSON.stringify(dataset.values.slice(0, 5)),
          code: setupCode,
        },
        code: `const report = ${call};\nconst result = {\n  valueAtRisk: report.valueAtRisk,\n  expectedShortfall: report.conditionalValueAtRisk,\n};\nconsole.log(result);`,
        result: {
          valueAtRisk: report.valueAtRisk,
          expectedShortfall: report.conditionalValueAtRisk,
        },
      },
      code: `${fullSetup}\nconst result = {\n  report: ${call},\n  annualizedVolatility: annualizedVolatility(returns, { periodsPerYear: ${periodsPerYear} }),\n  drawdown: maxDrawdownFromReturns(returns),\n  drawdownPath: underwater(equityCurve(returns, 1)),\n};\nconsole.log(result);`,
    };
  },
};
