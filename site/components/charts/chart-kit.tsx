'use client';
import { scaleLinear } from 'd3-scale';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { formatTick, formatValue } from '@/src/format';
import type { Tone, ValueFormat } from '@/src/types';

/** Validated categorical slots (dataviz validator, both themes), in fixed order. Never cycled. */
export const SERIES_COLORS = Array.from(
  { length: 8 },
  (_, index) => `var(--color-series-${index + 1})`,
);
export const seriesColor = (index: number) =>
  SERIES_COLORS[Math.min(index, SERIES_COLORS.length - 1)]!;

export const toneColor = (tone: Tone | undefined): string =>
  tone === 'profit'
    ? 'var(--color-profit)'
    : tone === 'loss'
      ? 'var(--color-loss)'
      : tone === 'brand'
        ? 'var(--color-series-1)'
        : 'var(--color-chart-ink-muted)';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** Container width via ResizeObserver; a sensible width before measurement (static render). */
export function useWidth(initial = 720) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(Math.max(240, Math.floor(element.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Finite extent of values, padded, optionally forced to include zero; never degenerate. */
export function extent(
  values: Iterable<number>,
  { includeZero = false, pad = 0.06 } = {},
): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values)
    if (Number.isFinite(value)) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
  if (min === Infinity) return [0, 1];
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    const spread = Math.abs(min) * 0.05 || 1;
    return [min - spread, max + spread];
  }
  const span = max - min;
  return [
    includeZero && min === 0 ? 0 : min - span * pad,
    includeZero && max === 0 ? 0 : max + span * pad,
  ];
}

export function linear(domain: [number, number], range: [number, number], nice = true) {
  const scale = scaleLinear().domain(domain).range(range);
  return nice ? scale.nice() : scale;
}

/** Estimated label width, for tick density and margins (no DOM measurement during render). */
export const textWidth = (text: string, size = 11) => text.length * size * 0.6;

export function yMargin(ticks: number[], format: ValueFormat | undefined, step: number): number {
  const widest = Math.max(...ticks.map((tick) => textWidth(formatTick(tick, format, step))));
  return Math.ceil(Math.min(88, Math.max(36, widest + 14)));
}

export function YAxis({
  ticks,
  scale,
  width,
  left,
  format,
  label,
}: {
  ticks: number[];
  scale: (value: number) => number;
  width: number;
  left: number;
  format?: ValueFormat;
  label?: string;
}) {
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 0;
  return (
    <g aria-hidden="true">
      {ticks.map((tick) => (
        <g key={tick} transform={`translate(0 ${scale(tick)})`}>
          <line
            x1={left}
            x2={width}
            stroke="var(--color-chart-grid)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          <text x={left - 8} dy="0.32em" textAnchor="end" className="tf-chart-tick">
            {formatTick(tick, format, step)}
          </text>
        </g>
      ))}
      {label ? (
        <text x={left} y={10} className="tf-chart-axis-label">
          {label}
        </text>
      ) : null}
    </g>
  );
}

export function XAxis({
  ticks,
  scale,
  top,
  format,
  label,
  width,
  formatter,
}: {
  ticks: number[];
  scale: (value: number) => number;
  top: number;
  format?: ValueFormat;
  label?: string;
  width: number;
  formatter?: (value: number) => string;
}) {
  const step = ticks.length > 1 ? Math.abs(ticks[1]! - ticks[0]!) : 0;
  return (
    <g aria-hidden="true">
      <line
        x1={0}
        x2={width}
        y1={top}
        y2={top}
        stroke="var(--color-chart-axis)"
        strokeWidth={1}
        shapeRendering="crispEdges"
      />
      {ticks.map((tick) => {
        const text = formatter ? formatter(tick) : formatTick(tick, format, step);
        const x = scale(tick);
        const half = textWidth(text) / 2;
        // Keep edge labels inside the plot instead of clipping them.
        const anchor = x + half > width ? 'end' : x - half < 0 ? 'start' : 'middle';
        return (
          <text key={tick} x={x} y={top + 16} textAnchor={anchor} className="tf-chart-tick">
            {text}
          </text>
        );
      })}
      {label ? (
        <text x={width} y={top + 34} textAnchor="end" className="tf-chart-axis-label">
          {label}
        </text>
      ) : null}
    </g>
  );
}

/** Thin out ticks so labels never collide. */
export function fitTicks(
  ticks: number[],
  available: number,
  label: (tick: number) => string,
): number[] {
  if (ticks.length < 3) return ticks;
  const widest = Math.max(...ticks.map((tick) => textWidth(label(tick)))) + 14;
  const fits = Math.max(2, Math.floor(available / widest));
  if (ticks.length <= fits) return ticks;
  const every = Math.ceil(ticks.length / fits);
  return ticks.filter((_tick, index) => index % every === 0);
}

export interface TooltipRow {
  key: string;
  label: string;
  value: string;
  color?: string;
  dashed?: boolean;
}

export function Tooltip({
  x,
  y,
  width,
  title,
  rows,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  rows: TooltipRow[];
}) {
  const left = x > width * 0.6;
  return (
    <div
      className="tf-chart-tooltip"
      style={{
        left: left ? undefined : x + 14,
        right: left ? width - x + 14 : undefined,
        top: Math.max(4, y),
      }}
      role="presentation"
    >
      <p className="mb-1 text-[0.6875rem] font-medium text-fd-muted-foreground">{title}</p>
      {rows.map((row) => (
        <p key={row.key} className="flex items-center gap-2 whitespace-nowrap text-xs">
          {row.color ? (
            <svg width="14" height="6" aria-hidden className="shrink-0">
              <line
                x1="1"
                x2="13"
                y1="3"
                y2="3"
                stroke={row.color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={row.dashed ? '3 3' : undefined}
              />
            </svg>
          ) : null}
          <span className="font-semibold tabular-nums text-fd-foreground">{row.value}</span>
          <span className="text-fd-muted-foreground">{row.label}</span>
        </p>
      ))}
    </div>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  kind?: 'line' | 'dashed' | 'area' | 'dot' | 'rect';
}

export function Legend({ items }: { items: LegendItem[] }) {
  if (items.length < 2) return null;
  return (
    <ul
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fd-muted-foreground"
      aria-label="Legend"
    >
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <svg width="16" height="10" aria-hidden className="shrink-0">
            {item.kind === 'rect' || item.kind === 'area' ? (
              <rect
                x="1"
                y="1"
                width="14"
                height="8"
                rx="2"
                fill={item.color}
                opacity={item.kind === 'area' ? 0.35 : 1}
              />
            ) : item.kind === 'dot' ? (
              <circle cx="8" cy="5" r="3.5" fill={item.color} />
            ) : (
              <line
                x1="1"
                x2="15"
                y1="5"
                y2="5"
                stroke={item.color}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={item.kind === 'dashed' ? '3 3' : undefined}
              />
            )}
          </svg>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Every chart: a titled figure with an accessible description, an optional legend, the plot, and
 * the exact values behind it (tooltips enhance; they never gate a value).
 */
export function ChartFrame({
  title,
  caption,
  legend,
  children,
  table,
  toolbar,
  description,
}: {
  title: string;
  caption?: string;
  legend?: LegendItem[];
  children: ReactNode;
  table: { columns: string[]; rows: (string | number)[][] };
  toolbar?: ReactNode;
  description: string;
}) {
  return (
    <figure className="tf-chart not-prose" aria-label={title}>
      <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <span className="min-w-0">
          <span className="block font-display text-[0.9375rem] font-semibold text-fd-foreground">
            {title}
          </span>
          {caption ? (
            <span className="mt-0.5 block max-w-3xl text-xs leading-5 text-fd-muted-foreground">
              {caption}
            </span>
          ) : null}
        </span>
        {toolbar}
      </figcaption>
      {legend ? (
        <div className="mb-2">
          <Legend items={legend} />
        </div>
      ) : null}
      <div role="img" aria-label={`${title}. ${description} Exact values are in the data table.`}>
        {children}
      </div>
      <ChartData table={table} />
    </figure>
  );
}

/** Exact values behind a chart. Large tables render only when opened, to keep the page light. */
function ChartData({ table }: { table: { columns: string[]; rows: (string | number)[][] } }) {
  const [open, setOpen] = useState(table.rows.length <= 400);
  return (
    <details
      className="tf-chart-data mt-2"
      onToggle={(event) => event.currentTarget.open && setOpen(true)}
    >
      <summary>Show data ({table.rows.length.toLocaleString('en-US')} rows)</summary>
      {open ? (
        <div className="tf-scrollbar mt-2 max-h-72 overflow-auto rounded-lg border border-fd-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-fd-muted text-left text-fd-muted-foreground">
              <tr>
                {table.columns.map((column) => (
                  <th key={column} className="px-3 py-1.5 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {table.rows.map((row, index) => (
                <tr key={index} className="border-t border-fd-border">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="px-3 py-1">
                      {typeof cell === 'number' ? formatValue(cell) : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </details>
  );
}

/** Index of the value nearest to `target` in an ascending array. */
export function nearestIndex(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  if (high < 0) return -1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (values[middle]! < target) low = middle;
    else high = middle;
  }
  return Math.abs(values[low]! - target) <= Math.abs(values[high]! - target) ? low : high;
}

/** Keyboard + pointer crosshair index over a sorted x array. */
export function useCrosshair(count: number) {
  const [index, setIndex] = useState<number | null>(null);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!count) return;
    const keys: Record<string, (current: number) => number> = {
      ArrowRight: (current) => Math.min(count - 1, current + 1),
      ArrowLeft: (current) => Math.max(0, current - 1),
      Home: () => 0,
      End: () => count - 1,
      PageUp: (current) => Math.min(count - 1, current + Math.ceil(count / 10)),
      PageDown: (current) => Math.max(0, current - Math.ceil(count / 10)),
    };
    const move = keys[event.key];
    if (move) {
      event.preventDefault();
      setIndex((current) => move(current ?? (event.key === 'ArrowLeft' ? count : -1)));
    } else if (event.key === 'Escape') setIndex(null);
  };
  return { index, setIndex, onKeyDown };
}
