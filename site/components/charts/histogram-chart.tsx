'use client';
import { useState } from 'react';
import { formatTick, formatValue } from '@/src/format';
import type { HistogramChart as HistogramSpec } from '@/src/types';
import {
  ChartFrame,
  fitTicks,
  linear,
  textWidth,
  toneColor,
  Tooltip,
  useWidth,
  XAxis,
  YAxis,
  yMargin,
} from './chart-kit';

export interface Bin {
  from: number;
  to: number;
  count: number;
}

/** Display-only binning (Freedman–Diaconis, clamped). The observations themselves are unchanged. */
export function binValues(values: readonly number[], target?: number): Bin[] {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return [];
  const min = finite[0]!;
  const max = finite.at(-1)!;
  if (min === max) return [{ from: min - 0.5, to: max + 0.5, count: finite.length }];
  const quantile = (q: number) => {
    const position = (finite.length - 1) * q;
    const lower = Math.floor(position);
    return (
      finite[lower]! +
      (finite[Math.min(finite.length - 1, lower + 1)]! - finite[lower]!) * (position - lower)
    );
  };
  const width = 2 * (quantile(0.75) - quantile(0.25)) * Math.cbrt(1 / finite.length);
  const count =
    target ?? Math.max(12, Math.min(60, width > 0 ? Math.ceil((max - min) / width) : 20));
  const step = (max - min) / count;
  const bins: Bin[] = Array.from({ length: count }, (_, index) => ({
    from: min + index * step,
    to: index === count - 1 ? max : min + (index + 1) * step,
    count: 0,
  }));
  for (const value of finite)
    bins[Math.min(count - 1, Math.floor((value - min) / step))]!.count += 1;
  return bins;
}

export function HistogramChart({ chart }: { chart: HistogramSpec }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const bins = binValues(chart.values, chart.binCount);
  const height = 300;
  const bottom = height - 34;
  const maxCount = Math.max(1, ...bins.map((bin) => bin.count));
  const yScale = linear([0, maxCount * 1.08], [bottom, 40]);
  const yTicks = yScale.ticks(5).filter((tick) => Number.isInteger(tick));
  const left = yMargin(yTicks, 'integer', 1);
  const right = 14;
  const markerValues = (chart.markers ?? []).flatMap((marker) =>
    marker.x === undefined ? [] : [marker.x],
  );
  const domain: [number, number] = [
    Math.min(bins[0]?.from ?? 0, ...markerValues),
    Math.max(bins.at(-1)?.to ?? 1, ...markerValues),
  ];
  const xScale = linear(domain, [left, width - right], false);
  const xStep = (domain[1] - domain[0]) / 6;
  const xTicks = fitTicks(xScale.ticks(7), width - left, (tick) =>
    formatTick(tick, chart.xFormat, xStep),
  );
  const total = chart.values.filter(Number.isFinite).length;
  const inTail = (bin: Bin) =>
    chart.tailBelow !== undefined && (bin.from + bin.to) / 2 <= chart.tailBelow;
  return (
    <ChartFrame
      title={chart.title}
      {...(chart.caption ? { caption: chart.caption } : {})}
      legend={
        chart.tailBelow !== undefined
          ? [
              { label: 'Observations', color: 'var(--color-series-1)', kind: 'rect' },
              { label: 'Loss tail', color: 'var(--color-loss)', kind: 'rect' },
            ]
          : undefined
      }
      table={{
        columns: ['From', 'To', chart.yLabel],
        rows: bins.map((bin) => [
          formatValue(bin.from, chart.xFormat),
          formatValue(bin.to, chart.xFormat),
          bin.count,
        ]),
      }}
      description={`${total} observations of ${chart.xLabel}, grouped into ${bins.length} bins.`}
    >
      <div ref={ref} className="relative">
        <svg width={width} height={height} className="block" onPointerLeave={() => setActive(null)}>
          <YAxis
            ticks={yTicks}
            scale={yScale}
            width={width - right}
            left={left}
            format="integer"
            label={chart.yLabel}
          />
          {bins.map((bin, index) => {
            const x0 = xScale(bin.from);
            const x1 = xScale(bin.to);
            const y = yScale(bin.count);
            return (
              <g key={index} onPointerEnter={() => setActive(index)}>
                <rect
                  x={x0}
                  y={26}
                  width={Math.max(1, x1 - x0)}
                  height={bottom - 26}
                  fill="transparent"
                />
                {bin.count > 0 ? (
                  <rect
                    x={x0 + 1}
                    y={y}
                    width={Math.max(1, x1 - x0 - 2)}
                    height={Math.max(1, bottom - y)}
                    rx={Math.min(3, (x1 - x0) / 4)}
                    fill={inTail(bin) ? 'var(--color-loss)' : 'var(--color-series-1)'}
                    opacity={active === null || active === index ? (inTail(bin) ? 0.85 : 0.7) : 0.4}
                  />
                ) : null}
              </g>
            );
          })}
          {(() => {
            const rowsEnd: number[] = [];
            return (chart.markers ?? [])
              .filter((marker) => marker.x !== undefined)
              .sort((a, b) => a.x! - b.x!)
              .map((marker) => {
                const x = xScale(marker.x!);
                const labelWidth = textWidth(marker.label, 11) + 10;
                const anchorEnd = x + labelWidth > width - right;
                const start = anchorEnd ? x - labelWidth : x;
                let row = rowsEnd.findIndex((end) => start > end + 4);
                if (row === -1) row = rowsEnd.length;
                rowsEnd[row] = start + labelWidth;
                return (
                  <g key={marker.label} pointerEvents="none">
                    <line
                      x1={x}
                      x2={x}
                      y1={10 + row * 13}
                      y2={bottom}
                      stroke={toneColor(marker.tone)}
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                    <text
                      x={anchorEnd ? x - 5 : x + 5}
                      y={16 + row * 13}
                      textAnchor={anchorEnd ? 'end' : 'start'}
                      className="tf-chart-marker"
                      style={{ fill: 'var(--color-chart-ink-secondary)' }}
                    >
                      {marker.label}
                    </text>
                  </g>
                );
              });
          })()}
          <XAxis
            ticks={xTicks}
            scale={xScale}
            top={bottom}
            {...(chart.xFormat ? { format: chart.xFormat } : {})}
            label={chart.xLabel}
            width={width - right}
          />
        </svg>
        {active !== null && bins[active] ? (
          <Tooltip
            x={(xScale(bins[active]!.from) + xScale(bins[active]!.to)) / 2}
            y={20}
            width={width}
            title={`${formatValue(bins[active]!.from, chart.xFormat)} to ${formatValue(bins[active]!.to, chart.xFormat)}`}
            rows={[
              {
                key: 'count',
                label: `periods (${((bins[active]!.count / Math.max(1, total)) * 100).toFixed(1)}%)`,
                value: String(bins[active]!.count),
              },
            ]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
