import { vectorized, fees } from '@insiderfinance/totalfinance/backtest';
import { underwater } from '@insiderfinance/totalfinance/performance';
import { sma } from '@insiderfinance/totalfinance/technical-analysis';
import { OHLCV_SAMPLES } from '../data/samples';
import type { OhlcvBar, Playground } from '../types';
import { dataInput, numberInput, stringInput } from './inputs';

/** Literal bars as copied TypeScript: one bar per line, so a reader can inspect every value. */
export function barsLiteral(bars: readonly OhlcvBar[]): string {
  return `[\n${bars.map((bar) => `  ${JSON.stringify(bar)},`).join('\n')}\n]`;
}

const sampleBars = OHLCV_SAMPLES[0]!.value;

export const backtesting: Playground = {
  id: 'backtest-a-strategy',
  title: 'Backtest a moving-average rule',
  introduction:
    'Hold the asset while a moving-average rule is on. Signals execute on the next bar, commissions are charged on every fill, and every input is yours to change, including the price data. A research demonstration, not evidence of an investable edge.',
  controls: [
    {
      kind: 'data',
      name: 'data',
      label: 'Price data',
      hint: 'Daily OHLC bars, oldest first. Paste or upload CSV/TSV with date, open, high, low, close (volume optional).',
      format: 'ohlcv',
      value: sampleBars,
      samples: OHLCV_SAMPLES,
      minRows: 30,
      maxRows: 5000,
    },
    {
      kind: 'select',
      name: 'rule',
      label: 'Rule',
      value: 'price-above-average',
      options: [
        { value: 'price-above-average', label: 'Close above its moving average' },
        { value: 'average-crossover', label: 'Fast average above slow average' },
      ],
    },
    {
      name: 'fastPeriod',
      label: 'Moving-average period',
      unit: 'sessions · integer',
      value: 20,
      min: 2,
      max: 200,
      step: 1,
      display: 'integer',
    },
    {
      name: 'slowPeriod',
      label: 'Slow moving-average period',
      unit: 'sessions · integer',
      value: 50,
      min: 3,
      max: 400,
      step: 1,
      display: 'integer',
      when: { name: 'rule', value: 'average-crossover' },
    },
    {
      name: 'initialCapital',
      label: 'Initial capital',
      unit: 'USD',
      value: 10000,
      min: 100,
      max: 100000000,
      step: 100,
      display: 'currency',
    },
    {
      name: 'feeBasisPoints',
      label: 'Trading commission',
      unit: 'basis points · 10 = 0.1%',
      value: 10,
      min: 0,
      max: 1000,
      step: 1,
      display: 'basis-points',
    },
  ],
  run(input) {
    const dataset = dataInput(input, 'data');
    if (dataset.format !== 'ohlcv') throw new Error('Price data must be OHLC bars.');
    const crossover = stringInput(input, 'rule') === 'average-crossover';
    const fastPeriod = numberInput(input, 'fastPeriod');
    const slowPeriod = numberInput(input, 'slowPeriod');
    const initialCapital = numberInput(input, 'initialCapital');
    const feeBasisPoints = numberInput(input, 'feeBasisPoints');
    if (!Number.isInteger(fastPeriod) || !Number.isInteger(slowPeriod))
      throw new Error('Moving-average periods must be whole numbers of sessions.');
    if (crossover && fastPeriod >= slowPeriod)
      throw new Error('For a crossover, the fast period must be shorter than the slow period.');
    const longest = crossover ? slowPeriod : fastPeriod;
    if (dataset.bars.length < longest + 10)
      throw new Error(
        `${dataset.bars.length} bars cannot warm up a ${longest}-session average and still trade. Supply at least ${longest + 10} bars or shorten the period.`,
      );
    const data = dataset.bars.map((bar) => ({
      symbol: 'DATA',
      timestampMs: Date.parse(`${bar.date}T00:00:00Z`),
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
    }));
    const closes = data.map((bar) => bar.close);
    const fast = sma(closes, { period: fastPeriod });
    const slow = crossover ? sma(closes, { period: slowPeriod }) : [];
    // Warmup values are NaN: no position until the average exists.
    const signal = closes.map((close, index) =>
      crossover
        ? Number.isFinite(fast[index]) &&
          Number.isFinite(slow[index]) &&
          fast[index]! > slow[index]!
        : Number.isFinite(fast[index]) && close > fast[index]!,
    );
    const backtest = vectorized({
      data,
      signal,
      initialCapital,
      executionLag: 1,
      periodsPerYear: 252,
      fees: fees.bps(feeBasisPoints),
    });
    const drawdowns = underwater(backtest.points.map((point) => point.equity));
    const result = { backtest, drawdowns };

    // Position changes take effect one bar after the signal (executionLag 1).
    const changes: { x: number; side: 'buy' | 'sell'; label: string }[] = [];
    signal.forEach((on, index) => {
      const previous = index > 0 && signal[index - 1]!;
      if (on !== previous && index + 1 < data.length && (on || index > 0))
        changes.push({
          x: index + 1,
          side: on ? 'buy' : 'sell',
          label: `${on ? 'Enter' : 'Exit'} at the ${dataset.bars[index + 1]!.date} close (signal on ${dataset.bars[index]!.date})`,
        });
    });
    const entries = changes.filter((change) => change.side === 'buy').length;
    const fastName = `${crossover ? 'Fast' : ''} SMA ${fastPeriod}`.trim();

    const ruleCode = crossover
      ? `const fast = sma(closes, { period: ${fastPeriod} });\nconst slow = sma(closes, { period: ${slowPeriod} });\n// Warmup values are NaN: no position until both averages exist.\nconst signal = closes.map((_close, index) =>\n  Number.isFinite(fast[index]) && Number.isFinite(slow[index]) && fast[index]! > slow[index]!,\n);`
      : `const average = sma(closes, { period: ${fastPeriod} });\n// Warmup values are NaN: no position until the average exists.\nconst signal = closes.map((close, index) => Number.isFinite(average[index]) && close > average[index]!);`;
    const setupCode = `import { vectorized, fees } from '@insiderfinance/totalfinance/backtest';\nimport { sma } from '@insiderfinance/totalfinance/technical-analysis';\n\n// ${dataset.label}\nconst bars = ${barsLiteral(dataset.bars)};\nconst data = bars.map((bar) => ({\n  symbol: 'DATA',\n  timestampMs: Date.parse(\`\${bar.date}T00:00:00Z\`),\n  open: bar.open,\n  high: bar.high,\n  low: bar.low,\n  close: bar.close,\n}));\nconst closes = data.map((bar) => bar.close);`;
    const runCode = `${ruleCode}\nconst backtest = vectorized({\n  data,\n  signal,\n  initialCapital: ${initialCapital},\n  executionLag: 1, // Trade on the bar after the signal.\n  periodsPerYear: 252,\n  fees: fees.bps(${feeBasisPoints}),\n});`;
    return {
      metrics: [
        { label: 'Final value', value: backtest.finalValue, unit: 'USD', format: 'currency' },
        {
          label: 'Total return',
          value: backtest.performance.totalReturn,
          format: 'decimal-percent',
          tone: (backtest.performance.totalReturn ?? 0) >= 0 ? 'profit' : 'loss',
        },
        {
          label: 'Maximum drawdown',
          value: backtest.performance.maxDrawdown,
          unit: 'from the running peak',
          format: 'decimal-percent',
          tone: 'loss',
        },
        {
          label: 'Sharpe ratio',
          value: backtest.performance.sharpe,
          unit: 'annualized · 0% risk-free',
        },
        {
          label: 'Entries',
          value: entries,
          unit: `${backtest.trades.length} fills incl. rebalancing`,
          format: 'integer',
        },
      ],
      chart: {
        kind: 'candles',
        title: 'Price, signals, equity and drawdown',
        caption: `${dataset.label}. Entries and exits are drawn on the bar where they fill, one bar after the signal.`,
        yLabel: 'Price',
        bars: dataset.bars.map((bar, index) => ({ ...bar, x: index })),
        overlays: [
          { name: fastName, points: fast.map((value, index) => ({ x: index, y: value })) },
          ...(crossover
            ? [
                {
                  name: `Slow SMA ${slowPeriod}`,
                  points: slow.map((value, index) => ({ x: index, y: value })),
                  style: 'dashed' as const,
                },
              ]
            : []),
        ],
        signals: changes,
        panes: [
          {
            title: 'Equity',
            yLabel: 'USD',
            yFormat: 'currency',
            series: [
              {
                name: 'Strategy equity',
                points: data.map((_bar, index) => ({
                  x: index,
                  y: backtest.points[index + 1]!.equity,
                })),
                style: 'area',
              },
            ],
          },
          {
            title: 'Drawdown',
            yLabel: 'Below peak',
            yFormat: 'decimal-percent',
            series: [
              {
                name: 'Drawdown',
                points: data.map((_bar, index) => ({ x: index, y: -drawdowns[index + 1]! })),
                style: 'area',
              },
            ],
          },
        ],
      },
      assumptions: backtest.assumptions,
      diagnostics: {
        ...backtest.diagnostics,
        dataNotice:
          dataset.origin === 'sample'
            ? 'Synthetic sample data, not market history. 252 periods per year is a stated annualization assumption.'
            : 'Reader-supplied data, used exactly as provided. 252 periods per year is a stated annualization assumption.',
      },
      result,
      example: {
        description:
          'vectorized returns a backtest report with points, returns, trades, performance, assumptions and diagnostics. This example prints selected summary fields. The moving average returns an ordinary number array; warmup NaN values are deliberately excluded from signals.',
        setup: {
          description: `${dataset.bars.length} bars from: ${dataset.label}. Preview: the first three bars. Copy setup + call includes every bar. The 252-period annualization is a stated assumption, not a trading calendar.`,
          preview: JSON.stringify(dataset.bars.slice(0, 3), null, 2),
          code: setupCode,
        },
        code: `${runCode}\nconst result = {\n  finalValue: backtest.finalValue,\n  totalReturn: backtest.performance.totalReturn,\n  maxDrawdown: backtest.performance.maxDrawdown,\n  fills: backtest.trades.length,\n};\nconsole.log(result);`,
        result: {
          finalValue: backtest.finalValue,
          totalReturn: backtest.performance.totalReturn,
          maxDrawdown: backtest.performance.maxDrawdown,
          fills: backtest.trades.length,
        },
      },
      code: `${setupCode.replace(
        "import { sma } from '@insiderfinance/totalfinance/technical-analysis';",
        "import { sma } from '@insiderfinance/totalfinance/technical-analysis';\nimport { underwater } from '@insiderfinance/totalfinance/performance';",
      )}\n${runCode}\nconst result = { backtest, drawdowns: underwater(backtest.points.map((point) => point.equity)) };\nconsole.log(result);`,
    };
  },
};
