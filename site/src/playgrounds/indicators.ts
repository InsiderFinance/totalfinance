import { bbands, ema, macd, rsi, sma } from '@insiderfinance/totalfinance/technical-analysis';
import { OHLCV_SAMPLES } from '../data/samples';
import type { Playground } from '../types';
import { barsLiteral } from './backtest';
import { dataInput, numberInput, stringInput } from './inputs';

/** Number of leading warmup values (NaN) before an indicator has its first value. */
const warmupOf = (values: readonly number[]) => {
  const first = values.findIndex((value) => Number.isFinite(value));
  return first < 0 ? values.length : first;
};

const lastFinite = (values: readonly number[]) =>
  [...values].reverse().find((value) => Number.isFinite(value)) ?? null;

export const indicators: Playground = {
  id: 'chart-technical-indicators',
  title: 'Chart technical indicators',
  introduction:
    'Overlay a moving average or Bollinger Bands on your own price bars and add an RSI or MACD pane. Warmup values stay NaN: an indicator never invents a value before it has enough history.',
  controls: [
    {
      kind: 'data',
      name: 'data',
      label: 'Price data',
      hint: 'Daily OHLC bars, oldest first. Paste or upload CSV/TSV with date, open, high, low, close (volume optional).',
      format: 'ohlcv',
      value: OHLCV_SAMPLES[0]!.value,
      samples: OHLCV_SAMPLES,
      minRows: 30,
      maxRows: 5000,
    },
    {
      kind: 'select',
      name: 'overlay',
      label: 'Price overlay',
      value: 'bollinger',
      options: [
        { value: 'sma', label: 'Simple moving average' },
        { value: 'ema', label: 'Exponential moving average' },
        { value: 'bollinger', label: 'Bollinger Bands' },
      ],
    },
    {
      name: 'overlayPeriod',
      label: 'Overlay period',
      unit: 'bars · integer',
      value: 20,
      min: 2,
      max: 250,
      step: 1,
      display: 'integer',
    },
    {
      name: 'bandWidth',
      label: 'Band width',
      unit: 'standard deviations',
      value: 2,
      min: 0.5,
      max: 4,
      step: 0.5,
      when: { name: 'overlay', value: 'bollinger' },
    },
    {
      kind: 'select',
      name: 'oscillator',
      label: 'Oscillator pane',
      value: 'rsi',
      options: [
        { value: 'rsi', label: 'RSI (Wilder)' },
        { value: 'macd', label: 'MACD' },
      ],
    },
    {
      name: 'rsiPeriod',
      label: 'RSI period',
      unit: 'bars · integer',
      value: 14,
      min: 2,
      max: 100,
      step: 1,
      display: 'integer',
      when: { name: 'oscillator', value: 'rsi' },
    },
  ],
  run(input) {
    const dataset = dataInput(input, 'data');
    if (dataset.format !== 'ohlcv') throw new Error('Price data must be OHLC bars.');
    const overlay = stringInput(input, 'overlay');
    const oscillator = stringInput(input, 'oscillator');
    const overlayPeriod = numberInput(input, 'overlayPeriod');
    const bandWidth = numberInput(input, 'bandWidth');
    const rsiPeriod = numberInput(input, 'rsiPeriod');
    if (!Number.isInteger(overlayPeriod) || !Number.isInteger(rsiPeriod))
      throw new Error('Indicator periods must be whole numbers of bars.');
    if (dataset.bars.length <= Math.max(overlayPeriod, oscillator === 'rsi' ? rsiPeriod : 34))
      throw new Error(
        `${dataset.bars.length} bars are not enough to warm up these indicators. Supply more bars or shorten the periods.`,
      );
    const closes = dataset.bars.map((bar) => bar.close);
    const bands =
      overlay === 'bollinger'
        ? bbands(closes, { period: overlayPeriod, standardDeviation: bandWidth })
        : null;
    const average =
      overlay === 'ema'
        ? ema(closes, { period: overlayPeriod })
        : overlay === 'sma'
          ? sma(closes, { period: overlayPeriod })
          : null;
    const strength = oscillator === 'rsi' ? rsi(closes, { period: rsiPeriod }) : null;
    const convergence =
      oscillator === 'macd' ? macd(closes, { fast: 12, slow: 26, signal: 9 }) : null;
    const result = {
      ...(bands ? { bollinger: bands } : { movingAverage: average! }),
      ...(strength ? { rsi: strength } : { macd: convergence! }),
    };

    const overlayValues = bands ? bands.map((point) => point.middle) : average!;
    const oscillatorValues = strength ?? convergence!.map((point) => point.macd);
    const overlayName =
      overlay === 'bollinger'
        ? `Bollinger middle (SMA ${overlayPeriod})`
        : `${overlay.toUpperCase()} ${overlayPeriod}`;
    const overlayCall =
      overlay === 'bollinger'
        ? `bbands(closes, { period: ${overlayPeriod}, standardDeviation: ${bandWidth} })`
        : `${overlay}(closes, { period: ${overlayPeriod} })`;
    const oscillatorCall =
      oscillator === 'rsi'
        ? `rsi(closes, { period: ${rsiPeriod} })`
        : 'macd(closes, { fast: 12, slow: 26, signal: 9 })';
    const imports = [overlay === 'bollinger' ? 'bbands' : overlay, oscillator].sort().join(', ');
    const setupCode = `import { ${imports} } from '@insiderfinance/totalfinance/technical-analysis';\n\n// ${dataset.label}\nconst bars = ${barsLiteral(dataset.bars)};\nconst closes = bars.map((bar) => bar.close);`;
    const resultKeys = `${bands ? 'bollinger' : 'movingAverage'}: ${overlayCall},\n  ${strength ? 'rsi' : 'macd'}: ${oscillatorCall},`;

    return {
      metrics: [
        { label: 'Last close', value: dataset.bars.at(-1)!.close, unit: dataset.bars.at(-1)!.date },
        {
          label: overlayName,
          value: lastFinite(overlayValues),
          unit: `warmup: ${warmupOf(overlayValues)} bars`,
        },
        ...(bands
          ? [
              {
                label: 'Band width',
                value: lastFinite(bands.map((point) => point.bandwidth)),
                unit: '(upper − lower) ÷ middle',
              },
            ]
          : []),
        oscillator === 'rsi'
          ? {
              label: `RSI ${rsiPeriod}`,
              value: lastFinite(strength!),
              unit: `0–100 · warmup: ${warmupOf(strength!)} bars`,
            }
          : {
              label: 'MACD histogram',
              value: lastFinite(convergence!.map((point) => point.histogram)),
              unit: 'MACD − signal',
            },
      ],
      chart: {
        kind: 'candles',
        title: `${overlay === 'bollinger' ? 'Bollinger Bands' : overlayName} and ${oscillator === 'rsi' ? 'RSI' : 'MACD'}`,
        caption: `${dataset.label}. Gaps at the start of each indicator are warmup, not zeros.`,
        yLabel: 'Price',
        bars: dataset.bars.map((bar, index) => ({ ...bar, x: index })),
        overlays: [
          {
            name: overlayName,
            points: overlayValues.map((value, index) => ({ x: index, y: value })),
          },
        ],
        ...(bands
          ? {
              bands: [
                {
                  name: `${bandWidth}σ band`,
                  upper: bands.map((point, index) => ({ x: index, y: point.upper })),
                  lower: bands.map((point, index) => ({ x: index, y: point.lower })),
                },
              ],
            }
          : {}),
        panes: [
          strength
            ? {
                title: `RSI ${rsiPeriod}`,
                yLabel: 'RSI',
                series: [
                  {
                    name: `RSI ${rsiPeriod}`,
                    points: strength.map((value, index) => ({ x: index, y: value })),
                  },
                ],
                guides: [30, 70],
                domain: [0, 100] as [number, number],
              }
            : {
                title: 'MACD 12 · 26 · 9',
                yLabel: 'MACD',
                series: [
                  {
                    name: 'Histogram',
                    points: convergence!.map((point, index) => ({ x: index, y: point.histogram })),
                    style: 'histogram' as const,
                  },
                  {
                    name: 'MACD',
                    points: convergence!.map((point, index) => ({ x: index, y: point.macd })),
                  },
                  {
                    name: 'Signal',
                    points: convergence!.map((point, index) => ({ x: index, y: point.signal })),
                    style: 'dashed' as const,
                  },
                ],
                guides: [0],
              },
        ],
      },
      assumptions: {
        overlay: bands
          ? {
              indicator: 'bbands',
              period: overlayPeriod,
              standardDeviation: bandWidth,
              middle: 'simple moving average',
            }
          : { indicator: overlay, period: overlayPeriod },
        oscillator: strength
          ? { indicator: 'rsi', period: rsiPeriod, smoothing: 'Wilder' }
          : { indicator: 'macd', fast: 12, slow: 26, signal: 9 },
        input: 'closing prices, oldest first',
      },
      diagnostics: {
        warmupBars: { overlay: warmupOf(overlayValues), oscillator: warmupOf(oscillatorValues) },
        dataNotice:
          dataset.origin === 'sample'
            ? 'Synthetic sample data, not market history.'
            : 'Reader-supplied data, used exactly as provided.',
      },
      result,
      example: {
        description: `Every indicator returns an ordinary array aligned to the input: one value (or one named record, for Bollinger Bands and MACD) per bar, with NaN during warmup. This example prints the last value of each.`,
        setup: {
          description: `${dataset.bars.length} bars from: ${dataset.label}. Preview: the first three bars. Copy setup + call includes every bar.`,
          preview: JSON.stringify(dataset.bars.slice(0, 3), null, 2),
          code: setupCode,
        },
        code: `const overlay = ${overlayCall};\nconst oscillator = ${oscillatorCall};\nconst result = {\n  overlay: overlay.at(-1),\n  oscillator: oscillator.at(-1),\n};\nconsole.log(result);`,
        result: {
          overlay: (bands ?? average!).at(-1),
          oscillator: (strength ?? convergence!).at(-1),
        },
      },
      code: `${setupCode}\nconst result = {\n  ${resultKeys}\n};\nconsole.log(result);`,
    };
  },
};
