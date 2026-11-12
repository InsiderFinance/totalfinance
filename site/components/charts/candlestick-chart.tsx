'use client';
import { area as areaShape, line as lineShape } from 'd3-shape';
import { useState } from 'react';
import { formatValue } from '@/src/format';
import type { CandlestickChart as CandlestickSpec, LineSeries, Point } from '@/src/types';
import {
  ChartFrame,
  extent,
  fitTicks,
  linear,
  seriesColor,
  Tooltip,
  useCrosshair,
  useWidth,
  YAxis,
  yMargin,
  type LegendItem,
  type TooltipRow,
} from './chart-kit';

const PRICE_HEIGHT = 300;
const PANE_HEIGHT = 112;
const PANE_GAP = 26;
const AXIS_HEIGHT = 30;

const RANGES = [
  { label: '3M', bars: 63 },
  { label: '6M', bars: 126 },
  { label: '1Y', bars: 252 },
  { label: '2Y', bars: 504 },
];

type PaneSeries = NonNullable<CandlestickSpec['panes']>[number]['series'][number];

const valueAt = (points: readonly Point[], x: number): number | undefined => {
  const point = points[x];
  return point && point.x === x ? point.y : points.find((candidate) => candidate.x === x)?.y;
};

export function CandlestickChart({ chart }: { chart: CandlestickSpec }) {
  const [ref, width] = useWidth();
  const total = chart.bars.length;
  const [visible, setVisible] = useState(Math.min(total, 252));
  const start = Math.max(0, total - visible);
  const bars = chart.bars.slice(start);
  const panes = chart.panes ?? [];
  const overlays = chart.overlays ?? [];
  const bands = chart.bands ?? [];
  const height =
    PRICE_HEIGHT + panes.reduce((sum) => sum + PANE_GAP + PANE_HEIGHT, 0) + AXIS_HEIGHT;

  const inView = (point: Point) => point.x >= start && Number.isFinite(point.y);
  const priceValues = [
    ...bars.flatMap((bar) => [bar.low, bar.high]),
    ...overlays.flatMap((series) => series.points.filter(inView).map((point) => point.y)),
    ...bands.flatMap((band) =>
      [...band.upper, ...band.lower].filter(inView).map((point) => point.y),
    ),
  ];
  const priceScale = linear(extent(priceValues, { pad: 0.04 }), [PRICE_HEIGHT - 8, 12]);
  const priceTicks = priceScale.ticks(6);
  const paneScales = panes.map((pane, paneIndex) => {
    const top = PRICE_HEIGHT + PANE_GAP + paneIndex * (PANE_GAP + PANE_HEIGHT);
    const values = pane.series.flatMap((series) =>
      series.points.filter(inView).map((point) => point.y),
    );
    const hasHistogram = pane.series.some((series) => series.style === 'histogram');
    const domain =
      pane.domain ??
      extent([...values, ...(pane.guides ?? [])], { includeZero: hasHistogram, pad: 0.08 });
    const scale = linear(domain, [top + PANE_HEIGHT - 4, top + 8], !pane.domain);
    return { top, scale, ticks: scale.ticks(3) };
  });
  const left = Math.max(
    yMargin(priceTicks, undefined, priceTicks.length > 1 ? priceTicks[1]! - priceTicks[0]! : 0),
    ...paneScales.map((pane, index) =>
      yMargin(
        pane.ticks,
        panes[index]!.yFormat,
        pane.ticks.length > 1 ? pane.ticks[1]! - pane.ticks[0]! : 0,
      ),
    ),
  );
  const right = 14;
  const plotWidth = width - left - right;
  const step = plotWidth / Math.max(1, bars.length);
  const xOf = (x: number) => left + (x - start + 0.5) * step;
  const candleWidth = Math.max(1, Math.min(11, step * 0.62));
  const bottom = height - AXIS_HEIGHT;

  const { index, setIndex, onKeyDown } = useCrosshair(bars.length);
  const active = index === null ? null : bars[index]!;

  const line = (scale: (value: number) => number) =>
    lineShape<Point>()
      .defined(inView)
      .x((point) => xOf(point.x))
      .y((point) => scale(point.y));

  const dateTicks = fitTicks(
    bars.map((bar) => bar.x).filter((_x, i) => i % Math.max(1, Math.round(bars.length / 8)) === 0),
    plotWidth,
    () => '2026-01-01',
  );

  const tooltipRows: TooltipRow[] = active
    ? [
        { key: 'o', label: 'open', value: formatValue(active.open) },
        { key: 'h', label: 'high', value: formatValue(active.high) },
        { key: 'l', label: 'low', value: formatValue(active.low) },
        {
          key: 'c',
          label: 'close',
          value: formatValue(active.close),
          color: active.close >= active.open ? 'var(--color-profit)' : 'var(--color-loss)',
        },
        ...overlays.flatMap((series, seriesIndex) => {
          const value = valueAt(series.points, active.x);
          return value !== undefined && Number.isFinite(value)
            ? [
                {
                  key: series.name,
                  label: series.name,
                  value: formatValue(value),
                  color: seriesColor(seriesIndex),
                  dashed: series.style === 'dashed',
                },
              ]
            : [];
        }),
        ...panes.flatMap((pane) =>
          pane.series.flatMap((series) => {
            const value = valueAt(series.points, active.x);
            return value !== undefined && Number.isFinite(value)
              ? [
                  {
                    key: `${pane.title}-${series.name}`,
                    label: series.name,
                    value: formatValue(value, pane.yFormat),
                  },
                ]
              : [];
          }),
        ),
        ...(chart.signals ?? [])
          .filter((signal) => signal.x === active.x)
          .map((signal) => ({
            key: `signal-${signal.x}`,
            label: signal.label,
            value: signal.side === 'buy' ? '▲' : '▼',
            color: signal.side === 'buy' ? 'var(--color-profit)' : 'var(--color-loss)',
          })),
      ]
    : [];

  const legend: LegendItem[] = [
    { label: 'Up bar (hollow)', color: 'var(--color-profit)', kind: 'rect' },
    { label: 'Down bar (filled)', color: 'var(--color-loss)', kind: 'rect' },
    ...overlays.map((series, seriesIndex) => ({
      label: series.name,
      color: seriesColor(seriesIndex),
      kind: series.style === 'dashed' ? ('dashed' as const) : ('line' as const),
    })),
    ...bands.map((band) => ({
      label: band.name,
      color: 'var(--color-series-1)',
      kind: 'area' as const,
    })),
  ];

  const columns = [
    'Date',
    'Open',
    'High',
    'Low',
    'Close',
    ...overlays.map((series) => series.name),
    ...bands.flatMap((band) => [`${band.name} upper`, `${band.name} lower`]),
    ...panes.flatMap((pane) => pane.series.map((series) => `${pane.title}: ${series.name}`)),
  ];
  const table = {
    columns,
    rows: chart.bars.map((bar) => [
      bar.date,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      ...overlays.map((series) => formatValue(valueAt(series.points, bar.x) ?? NaN)),
      ...bands.flatMap((band) => [
        formatValue(valueAt(band.upper, bar.x) ?? NaN),
        formatValue(valueAt(band.lower, bar.x) ?? NaN),
      ]),
      ...panes.flatMap((pane) =>
        pane.series.map((series) =>
          formatValue(valueAt(series.points, bar.x) ?? NaN, pane.yFormat),
        ),
      ),
    ]),
  };

  const pointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const position = Math.floor((event.clientX - bounds.left - left) / step);
    setIndex(Math.max(0, Math.min(bars.length - 1, position)));
  };

  const renderPaneSeries = (
    series: PaneSeries,
    scale: (value: number) => number,
    seriesIndex: number,
    paneTop: number,
    paneBottom: number,
  ) => {
    const points = series.points;
    if (series.style === 'histogram') {
      const zero = scale(0);
      return (
        <g key={series.name}>
          {points.filter(inView).map((point) => {
            const y = scale(point.y);
            return (
              <rect
                key={point.x}
                x={xOf(point.x) - candleWidth / 2}
                width={candleWidth}
                y={Math.min(y, zero)}
                height={Math.max(1, Math.abs(zero - y))}
                fill={point.y >= 0 ? 'var(--color-profit)' : 'var(--color-loss)'}
                opacity={0.55}
              />
            );
          })}
        </g>
      );
    }
    const color = series.name === 'Drawdown' ? 'var(--color-loss)' : seriesColor(seriesIndex);
    // Fill toward zero when zero is inside the pane, otherwise toward the pane's bottom edge.
    const zero = scale(0);
    const base = Number.isFinite(zero) ? Math.min(paneBottom, Math.max(paneTop, zero)) : paneBottom;
    const fill = areaShape<Point>()
      .defined(inView)
      .x((point) => xOf(point.x))
      .y0(base)
      .y1((point) => scale(point.y));
    return (
      <g key={series.name}>
        {series.style === 'area' ? (
          <path d={fill(points) ?? ''} fill={color} opacity={0.12} />
        ) : null}
        <path
          d={line(scale)(points) ?? ''}
          fill="none"
          stroke={color}
          strokeWidth={series.style === 'dashed' ? 1.5 : 2}
          strokeDasharray={series.style === 'dashed' ? '5 4' : undefined}
          strokeLinejoin="round"
        />
      </g>
    );
  };

  const toolbar =
    total > RANGES[0]!.bars ? (
      <div
        role="group"
        aria-label="Visible range"
        className="flex rounded-lg bg-fd-secondary p-0.5 text-xs"
      >
        {[...RANGES.filter((range) => range.bars < total), { label: 'All', bars: total }].map(
          (range) => (
            <button
              key={range.label}
              type="button"
              onClick={() => {
                setVisible(range.bars);
                setIndex(null);
              }}
              aria-pressed={visible === range.bars}
              className={`rounded-md px-2.5 py-1 font-medium ${visible === range.bars ? 'bg-fd-background text-fd-foreground shadow-xs' : 'text-fd-muted-foreground hover:text-fd-foreground'}`}
            >
              {range.label}
            </button>
          ),
        )}
      </div>
    ) : undefined;

  return (
    <ChartFrame
      title={chart.title}
      {...(chart.caption ? { caption: chart.caption } : {})}
      legend={legend}
      table={table}
      toolbar={toolbar}
      description={`Daily price bars with ${overlays.map((series) => series.name).join(', ') || 'no overlays'}${panes.length ? ` and panes for ${panes.map((pane) => pane.title).join(', ')}` : ''}.`}
    >
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={height}
          tabIndex={0}
          className="block touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2"
          onPointerMove={pointer}
          onPointerDown={pointer}
          onPointerLeave={() => setIndex(null)}
          onKeyDown={onKeyDown}
          onBlur={() => setIndex(null)}
          aria-label={`${chart.title}: use arrow keys to step through bars`}
        >
          <YAxis
            ticks={priceTicks}
            scale={priceScale}
            width={width - right}
            left={left}
            label={chart.yLabel}
          />
          {bands.map((band) => {
            const lower = new Map(band.lower.map((point) => [point.x, point.y]));
            const fill = areaShape<Point>()
              .defined((point) => inView(point) && Number.isFinite(lower.get(point.x)))
              .x((point) => xOf(point.x))
              .y0((point) => priceScale(lower.get(point.x)!))
              .y1((point) => priceScale(point.y));
            return (
              <g key={band.name}>
                <path d={fill(band.upper) ?? ''} fill="var(--color-series-1)" opacity={0.08} />
                <path
                  d={line(priceScale)(band.upper) ?? ''}
                  fill="none"
                  stroke="var(--color-series-1)"
                  strokeOpacity={0.45}
                  strokeWidth={1}
                />
                <path
                  d={line(priceScale)(band.lower) ?? ''}
                  fill="none"
                  stroke="var(--color-series-1)"
                  strokeOpacity={0.45}
                  strokeWidth={1}
                />
              </g>
            );
          })}
          <g>
            {bars.map((bar) => {
              const up = bar.close >= bar.open;
              const x = xOf(bar.x);
              const top = priceScale(Math.max(bar.open, bar.close));
              const bodyBottom = priceScale(Math.min(bar.open, bar.close));
              const color = up ? 'var(--color-profit)' : 'var(--color-loss)';
              return (
                <g key={bar.x}>
                  <line
                    x1={x}
                    x2={x}
                    y1={priceScale(bar.high)}
                    y2={priceScale(bar.low)}
                    stroke={color}
                    strokeWidth={1}
                  />
                  <rect
                    x={x - candleWidth / 2}
                    y={top}
                    width={candleWidth}
                    height={Math.max(1, bodyBottom - top)}
                    fill={up ? 'var(--color-chart-surface)' : color}
                    stroke={color}
                    strokeWidth={candleWidth > 3 ? 1 : 0}
                  />
                </g>
              );
            })}
          </g>
          {overlays.map((series: LineSeries, seriesIndex) => (
            <path
              key={series.name}
              d={line(priceScale)(series.points) ?? ''}
              fill="none"
              stroke={seriesColor(seriesIndex)}
              strokeWidth={2}
              strokeDasharray={series.style === 'dashed' ? '6 5' : undefined}
              strokeLinejoin="round"
            />
          ))}
          {(chart.signals ?? [])
            .filter((signal) => signal.x >= start)
            .map((signal) => {
              const bar = chart.bars[signal.x]!;
              const x = xOf(signal.x);
              const buy = signal.side === 'buy';
              const y = buy ? priceScale(bar.low) + 10 : priceScale(bar.high) - 10;
              const size = 5;
              return (
                <path
                  key={`${signal.side}-${signal.x}`}
                  d={
                    buy
                      ? `M${x},${y - size} L${x + size},${y + size} L${x - size},${y + size} Z`
                      : `M${x},${y + size} L${x + size},${y - size} L${x - size},${y - size} Z`
                  }
                  fill={buy ? 'var(--color-profit)' : 'var(--color-loss)'}
                  stroke="var(--color-chart-surface)"
                  strokeWidth={1.5}
                >
                  <title>{signal.label}</title>
                </path>
              );
            })}
          {panes.map((pane, paneIndex) => {
            const { top, scale, ticks } = paneScales[paneIndex]!;
            return (
              <g key={pane.title}>
                <text x={left} y={top - 8} className="tf-chart-axis-label">
                  {pane.title}
                </text>
                <YAxis
                  ticks={ticks}
                  scale={scale}
                  width={width - right}
                  left={left}
                  {...(pane.yFormat ? { format: pane.yFormat } : {})}
                />
                {(pane.guides ?? []).map((guide) => (
                  <line
                    key={guide}
                    x1={left}
                    x2={width - right}
                    y1={scale(guide)}
                    y2={scale(guide)}
                    stroke="var(--color-chart-ink-muted)"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                  />
                ))}
                {pane.series.map((series, seriesIndex) =>
                  renderPaneSeries(series, scale, seriesIndex, top + 8, top + PANE_HEIGHT - 4),
                )}
              </g>
            );
          })}
          <line
            x1={left}
            x2={width - right}
            y1={bottom}
            y2={bottom}
            stroke="var(--color-chart-axis)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          {dateTicks.map((x) => {
            const position = xOf(x);
            const anchor =
              position + 34 > width - right ? 'end' : position - 34 < left ? 'start' : 'middle';
            return (
              <text
                key={x}
                x={position}
                y={bottom + 16}
                textAnchor={anchor}
                className="tf-chart-tick"
              >
                {chart.bars[x]!.date}
              </text>
            );
          })}
          {active ? (
            <line
              x1={xOf(active.x)}
              x2={xOf(active.x)}
              y1={8}
              y2={bottom}
              stroke="var(--color-chart-ink-muted)"
              strokeWidth={1}
              pointerEvents="none"
            />
          ) : null}
        </svg>
        {active ? (
          <Tooltip x={xOf(active.x)} y={16} width={width} title={active.date} rows={tooltipRows} />
        ) : null}
      </div>
    </ChartFrame>
  );
}
