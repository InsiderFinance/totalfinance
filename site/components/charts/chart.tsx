'use client';
import type { Chart as ChartSpec } from '@/src/types';
import { BarChart } from './bar-chart';
import { CandlestickChart } from './candlestick-chart';
import { HeatmapChart } from './heatmap-chart';
import { HistogramChart } from './histogram-chart';
import { LineChart } from './line-chart';
import { WaterfallChart } from './waterfall-chart';

export function Chart({ chart }: { chart: ChartSpec }) {
  switch (chart.kind) {
    case 'candles':
      return <CandlestickChart chart={chart} />;
    case 'heatmap':
      return <HeatmapChart chart={chart} />;
    case 'histogram':
      return <HistogramChart chart={chart} />;
    case 'waterfall':
      return <WaterfallChart chart={chart} />;
    case 'bars':
      return <BarChart chart={chart} />;
    default:
      return <LineChart chart={chart} />;
  }
}
