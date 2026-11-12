'use client';
import { area as areaShape, line as lineShape } from 'd3-shape';
import { useId } from 'react';
import { formatTick, formatValue } from '@/src/format';
import type { LineChart as LineChartSpec, LineSeries, Point } from '@/src/types';
import {
  ChartFrame,
  extent,
  fitTicks,
  linear,
  nearestIndex,
  seriesColor,
  toneColor,
  Tooltip,
  useCrosshair,
  useWidth,
  XAxis,
  YAxis,
  yMargin,
  textWidth,
  type LegendItem,
  type TooltipRow,
} from './chart-kit';

const finite = (point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y);

function colorOf(series: LineSeries, index: number): string {
  if (series.style === 'muted') return 'var(--color-chart-ink-muted)';
  return seriesColor(index);
}

export function LineChart({ chart }: { chart: LineChartSpec }) {
  const [ref, width] = useWidth();
  const clip = useId().replace(/:/g, '');
  const height = chart.size === 'half' ? 210 : 300;
  const all = chart.series.flatMap((series) => series.points.filter(finite));
  const xs = all.map((point) => point.x);
  const ys = [
    ...all.map((point) => point.y),
    ...(chart.markers ?? []).flatMap((marker) => (marker.y === undefined ? [] : [marker.y])),
  ];
  const minY = Math.min(...ys.filter(Number.isFinite));
  const maxY = Math.max(...ys.filter(Number.isFinite));
  const includeZero = chart.includeZero ?? (minY <= 0 && maxY >= 0);
  const yScale0 = linear(extent(ys, { includeZero }), [height - 34, 14]);
  const yTicks = yScale0.ticks(chart.size === 'half' ? 4 : 6);
  const yStep = yTicks.length > 1 ? yTicks[1]! - yTicks[0]! : 0;
  const left = yMargin(yTicks, chart.yFormat, yStep);
  const right = 14;
  const xDomain = extent(xs, { pad: 0 });
  const xScale = linear(xDomain, [left, width - right], false);
  const yScale = yScale0;
  const xStep = (xDomain[1] - xDomain[0]) / 6;
  const xTicks = fitTicks(
    xScale.ticks(Math.max(2, Math.floor((width - left) / 90))),
    width - left,
    (tick) => formatTick(tick, chart.xFormat, xStep),
  );
  const plotBottom = height - 34;
  const zeroY = yScale.domain()[0]! <= 0 && yScale.domain()[1]! >= 0 ? yScale(0) : plotBottom;

  // The crosshair snaps to the union of x positions across series.
  const grid = [...new Set(xs)].sort((a, b) => a - b);
  const { index, setIndex, onKeyDown } = useCrosshair(grid.length);
  const activeX = index === null ? null : grid[index]!;

  const line = lineShape<Point>()
    .defined(finite)
    .x((point) => xScale(point.x))
    .y((point) => yScale(point.y));
  const fill = areaShape<Point>()
    .defined(finite)
    .x((point) => xScale(point.x))
    .y0(zeroY)
    .y1((point) => yScale(point.y));

  const rows: TooltipRow[] =
    activeX === null
      ? []
      : chart.series.flatMap((series, seriesIndex) => {
          const points = series.points.filter(finite);
          const nearest =
            points[
              nearestIndex(
                points.map((point) => point.x),
                activeX,
              )
            ];
          if (!nearest || (series.style === 'points' && nearest.x !== activeX)) return [];
          return [
            {
              key: series.name,
              label: series.name,
              value: formatValue(nearest.y, chart.yFormat),
              color: colorOf(series, seriesIndex),
              dashed: series.style === 'dashed',
            },
          ];
        });

  const legend: LegendItem[] = chart.series.map((series, seriesIndex) => ({
    label: series.name,
    color: colorOf(series, seriesIndex),
    kind:
      series.style === 'dashed'
        ? 'dashed'
        : series.style === 'points'
          ? 'dot'
          : series.style === 'area'
            ? 'line'
            : 'line',
  }));
  const hasPnl = chart.series.some((series) => series.style === 'pnl');
  if (hasPnl)
    legend.push(
      { label: 'Profit', color: 'var(--color-profit)', kind: 'area' },
      { label: 'Loss', color: 'var(--color-loss)', kind: 'area' },
    );

  const sameGrid = chart.series.every(
    (series) =>
      series.points.length === chart.series[0]!.points.length &&
      series.points.every((point, i) => point.x === chart.series[0]!.points[i]!.x),
  );
  const table = sameGrid
    ? {
        columns: [chart.xLabel, ...chart.series.map((series) => series.name)],
        rows: chart.series[0]!.points.map((point, i) => [
          formatValue(point.x, chart.xFormat),
          ...chart.series.map((series) => formatValue(series.points[i]!.y, chart.yFormat)),
        ]),
      }
    : {
        columns: ['Series', chart.xLabel, chart.yLabel],
        rows: chart.series.flatMap((series) =>
          series.points.map((point) => [
            series.name,
            formatValue(point.x, chart.xFormat),
            formatValue(point.y, chart.yFormat),
          ]),
        ),
      };

  const pointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = xScale.invert(event.clientX - bounds.left);
    setIndex(nearestIndex(grid, x));
  };

  return (
    <ChartFrame
      title={chart.title}
      {...(chart.caption ? { caption: chart.caption } : {})}
      legend={legend}
      table={table}
      description={`${chart.yLabel} against ${chart.xLabel}.`}
    >
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={height}
          className="block touch-pan-y overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2"
          tabIndex={0}
          onPointerMove={pointer}
          onPointerDown={pointer}
          onPointerLeave={() => setIndex(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setIndex(null)}
          aria-label={`${chart.title}: use arrow keys to read values`}
        >
          <defs>
            <clipPath id={`${clip}-above`}>
              <rect x={0} y={0} width={width} height={Math.max(0, zeroY)} />
            </clipPath>
            <clipPath id={`${clip}-below`}>
              <rect x={0} y={zeroY} width={width} height={Math.max(0, height - zeroY)} />
            </clipPath>
          </defs>
          <YAxis
            ticks={yTicks}
            scale={yScale}
            width={width - right}
            left={left}
            {...(chart.yFormat ? { format: chart.yFormat } : {})}
            label={chart.yLabel}
          />
          {zeroY !== plotBottom ? (
            <line
              x1={left}
              x2={width - right}
              y1={zeroY}
              y2={zeroY}
              stroke="var(--color-chart-axis)"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          ) : null}
          {chart.series.map((series, seriesIndex) => {
            const points = series.points;
            const color = colorOf(series, seriesIndex);
            if (series.style === 'points')
              return (
                <g key={series.name}>
                  {points.filter(finite).map((point) => (
                    <circle
                      key={`${point.x}-${point.y}`}
                      cx={xScale(point.x)}
                      cy={yScale(point.y)}
                      r={4.5}
                      fill={color}
                      stroke="var(--color-chart-surface)"
                      strokeWidth={2}
                    />
                  ))}
                </g>
              );
            if (series.style === 'pnl')
              return (
                <g key={series.name}>
                  <path
                    d={fill(points) ?? ''}
                    fill="var(--color-profit)"
                    opacity={0.14}
                    clipPath={`url(#${clip}-above)`}
                  />
                  <path
                    d={fill(points) ?? ''}
                    fill="var(--color-loss)"
                    opacity={0.14}
                    clipPath={`url(#${clip}-below)`}
                  />
                  <path
                    d={line(points) ?? ''}
                    fill="none"
                    stroke="var(--color-profit)"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    clipPath={`url(#${clip}-above)`}
                  />
                  <path
                    d={line(points) ?? ''}
                    fill="none"
                    stroke="var(--color-loss)"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    clipPath={`url(#${clip}-below)`}
                  />
                </g>
              );
            return (
              <g key={series.name}>
                {series.style === 'area' ? (
                  <path d={fill(points) ?? ''} fill={color} opacity={0.1} />
                ) : null}
                <path
                  d={line(points) ?? ''}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray={series.style === 'dashed' ? '6 5' : undefined}
                />
              </g>
            );
          })}
          {(() => {
            // Vertical marker labels stack into rows instead of overlapping.
            const rowsEnd: number[] = [];
            const vertical = (chart.markers ?? [])
              .filter(
                (marker) =>
                  marker.x !== undefined && marker.x >= xDomain[0] && marker.x <= xDomain[1],
              )
              .sort((a, b) => a.x! - b.x!)
              .map((marker) => {
                const x = xScale(marker.x!);
                const labelWidth = textWidth(marker.label, 11) + 10;
                const anchorEnd = x + labelWidth > width - right;
                const start = anchorEnd ? x - labelWidth : x;
                let row = rowsEnd.findIndex((end) => start > end + 4);
                if (row === -1) row = rowsEnd.length;
                rowsEnd[row] = start + labelWidth;
                return { marker, x, anchorEnd, row };
              });
            return vertical.map(({ marker, x, anchorEnd, row }) => (
              <g key={`x-${marker.label}`}>
                <line
                  x1={x}
                  x2={x}
                  y1={14}
                  y2={plotBottom}
                  stroke={toneColor(marker.tone)}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <text
                  x={anchorEnd ? x - 5 : x + 5}
                  y={22 + row * 14}
                  textAnchor={anchorEnd ? 'end' : 'start'}
                  className="tf-chart-marker"
                  style={{ fill: 'var(--color-chart-ink-secondary)' }}
                >
                  {marker.label}
                </text>
              </g>
            ));
          })()}
          {(chart.markers ?? [])
            .filter((marker) => marker.x === undefined && marker.y !== undefined)
            .map((marker) => {
              const y = yScale(marker.y!);
              if (y < 10 || y > plotBottom) return null;
              return (
                <g key={`y-${marker.label}`}>
                  <line
                    x1={left}
                    x2={width - right}
                    y1={y}
                    y2={y}
                    stroke={toneColor(marker.tone)}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                  />
                  <text
                    x={width - right - 4}
                    y={y - 5}
                    textAnchor="end"
                    className="tf-chart-marker"
                    style={{ fill: 'var(--color-chart-ink-secondary)' }}
                  >
                    {marker.label}
                  </text>
                </g>
              );
            })}
          <XAxis
            ticks={xTicks}
            scale={xScale}
            top={plotBottom}
            {...(chart.xFormat ? { format: chart.xFormat } : {})}
            label={chart.xLabel}
            width={width - right}
          />
          {activeX !== null ? (
            <g pointerEvents="none">
              <line
                x1={xScale(activeX)}
                x2={xScale(activeX)}
                y1={14}
                y2={plotBottom}
                stroke="var(--color-chart-ink-muted)"
                strokeWidth={1}
              />
              {chart.series.map((series, seriesIndex) => {
                const points = series.points.filter(finite);
                const nearest =
                  points[
                    nearestIndex(
                      points.map((point) => point.x),
                      activeX,
                    )
                  ];
                if (!nearest || series.style === 'points') return null;
                return (
                  <circle
                    key={series.name}
                    cx={xScale(nearest.x)}
                    cy={yScale(nearest.y)}
                    r={4}
                    fill={
                      series.style === 'pnl'
                        ? nearest.y >= 0
                          ? 'var(--color-profit)'
                          : 'var(--color-loss)'
                        : colorOf(series, seriesIndex)
                    }
                    stroke="var(--color-chart-surface)"
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          ) : null}
        </svg>
        {activeX !== null && rows.length ? (
          <Tooltip
            x={xScale(activeX)}
            y={18}
            width={width}
            title={`${chart.xLabel.split(' · ')[0]}: ${formatValue(activeX, chart.xFormat)}`}
            rows={rows}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
