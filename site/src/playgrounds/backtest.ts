import { vectorized, fees } from '@totalfinance/backtest';
import { sma } from '@totalfinance/technical-analysis';
import { underwater } from '@totalfinance/performance';
import type { Playground } from '../types.js';

export const backtesting: Playground = {
  id: 'backtest-a-strategy',
  title: 'Backtest a moving-average signal',
  introduction:
    'A deterministic, synthetic 120-session series. Hold the asset when its close is above its moving average. Signals execute with a one-bar lag; this is a research demonstration, not evidence of an investable edge.',
  controls: [
    {
      name: 'period',
      label: 'Moving-average period',
      unit: 'sessions · integer',
      value: 20,
      min: 2,
      max: 60,
      step: 1,
    },
    {
      name: 'initialCapital',
      label: 'Initial capital',
      unit: 'USD',
      value: 10000,
      min: 100,
      max: 100000000,
      step: 100,
    },
    {
      name: 'feeBasisPoints',
      label: 'Trading commission',
      unit: 'basis points · 10 = 0.1%',
      value: 10,
      min: 0,
      max: 1000,
      step: 1,
    },
  ],
  run(input) {
    const { period = 20, initialCapital = 10000, feeBasisPoints = 10 } = input;
    if (!Number.isInteger(period))
      throw new Error('Moving-average period must be a whole number of sessions.');
    const data = Array.from({ length: 120 }, (_, index) => {
      const close = 100 + index * 0.08 + Math.sin(index / 7) * 5 + Math.cos(index / 3) * 1.2;
      return {
        symbol: 'SAMPLE',
        timestampMs: Date.UTC(2026, 0, 1) + index * 86400000,
        open: close,
        high: close,
        low: close,
        close,
      };
    });
    const averages = sma(
      data.map((bar) => bar.close),
      { period },
    );
    const signal = data.map(
      (bar, index) => Number.isFinite(averages[index]) && bar.close > averages[index]!,
    );
    const result = vectorized({
      data,
      signal,
      initialCapital,
      executionLag: 1,
      periodsPerYear: 252,
      fees: fees.bps(feeBasisPoints),
    });
    const drawdowns = underwater(result.points.map((point) => point.equity));
    return {
      metrics: [
        { label: 'Final value', value: result.finalValue, unit: 'USD' },
        {
          label: 'Maximum drawdown',
          value: result.performance.maxDrawdown,
          unit: 'decimal fraction',
        },
        { label: 'Trades', value: result.trades.length },
        { label: 'Execution lag', value: 1, unit: 'bar · no same-bar signal fill' },
      ],
      chart: {
        title: 'Equity on the synthetic price series',
        xLabel: 'Observation index',
        yLabel: 'Portfolio equity · USD',
        series: [
          {
            name: 'Moving-average strategy',
            points: result.points.map((point, index) => ({ x: index, y: point.equity })),
          },
        ],
      },
      additionalCharts: [
        {
          title: 'Drawdown from the running equity peak',
          xLabel: 'Observation index',
          yLabel: 'Drawdown · decimal fraction',
          series: [
            {
              name: 'Drawdown (positive = below peak)',
              points: drawdowns.map((value, index) => ({ x: index, y: value })),
            },
          ],
        },
      ],
      assumptions: result.assumptions,
      diagnostics: {
        ...result.diagnostics,
        sampleNotice:
          'Synthetic observations; 252 periods/year is an explicit annualization assumption, not a real trading-calendar dataset.',
      },
      result: { backtest: result, drawdowns },
      example: {
        description:
          'vectorized returns a backtest report with points, returns, trades, performance, assumptions and diagnostics. This example prints selected summary fields. The moving average returns an ordinary number array; warmup NaN values are deliberately excluded from signals.',
        setup: {
          description:
            '120 synthetic observations, not historical market data. Preview: the first three bars. Expand for the complete literal dataset and imports; Copy setup + call includes all of it. The 252-period annualization is a stated assumption, not a trading calendar.',
          preview: JSON.stringify(data.slice(0, 3), null, 2),
          code: `import { vectorized, fees } from '@totalfinance/backtest';\nimport { sma } from '@totalfinance/technical-analysis';\n\n// Synthetic sample data, not market history.\nconst data = [\n${data.map((bar) => `  ${JSON.stringify(bar)},`).join('\n')}\n];`,
        },
        code: `const averages = sma(data.map(bar => bar.close), { period: ${period} });\nconst signal = data.map((bar, index) =>\n  Number.isFinite(averages[index]) && bar.close > averages[index]!\n);\nconst backtest = vectorized({\n  data,\n  signal,\n  initialCapital: ${initialCapital},\n  executionLag: 1, // Execute the previous bar's signal.\n  periodsPerYear: 252,\n  fees: fees.bps(${feeBasisPoints}),\n});\nconst result = {\n  finalValue: backtest.finalValue,\n  maxDrawdown: backtest.performance.maxDrawdown,\n  tradeCount: backtest.trades.length,\n};\nconsole.log(result);`,
        result: {
          finalValue: result.finalValue,
          maxDrawdown: result.performance.maxDrawdown,
          tradeCount: result.trades.length,
        },
      },
      code: `import { vectorized, fees } from '@totalfinance/backtest';\nimport { sma } from '@totalfinance/technical-analysis';\nimport { underwater } from '@totalfinance/performance';\n\n// Synthetic data, not a historical market series.\nconst data = Array.from({ length: 120 }, (_, index) => {\n  const close = 100 + index * 0.08 + Math.sin(index / 7) * 5 + Math.cos(index / 3) * 1.2;\n  return { symbol: 'SAMPLE', timestampMs: Date.UTC(2026, 0, 1) + index * 86400000, open: close, high: close, low: close, close };\n});\nconst averages = sma(data.map(bar => bar.close), { period: ${period} });\nconst signal = data.map((bar, index) => Number.isFinite(averages[index]) && bar.close > averages[index]!);\nconst backtest = vectorized({ data, signal, initialCapital: ${initialCapital}, executionLag: 1, periodsPerYear: 252, fees: fees.bps(${feeBasisPoints}) });\nconst result = { backtest, drawdowns: underwater(backtest.points.map(point => point.equity)) };\nconsole.log(result);`,
    };
  },
};
