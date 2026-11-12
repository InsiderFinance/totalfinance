'use client';
import { useState } from 'react';
import { formatValue } from '@/src/format';
import type { HeatmapChart as HeatmapSpec } from '@/src/types';
import { ChartFrame, textWidth, Tooltip, useWidth } from './chart-kit';

const STEPS = 9;

/** Quantize to one of nine ordered steps: one-hue sequential, or loss–neutral–profit diverging. */
export function heatStep(
  value: number,
  min: number,
  max: number,
  scale: HeatmapSpec['scale'],
): number {
  if (!Number.isFinite(value)) return -1;
  if (scale === 'diverging') {
    const magnitude = Math.max(Math.abs(min), Math.abs(max)) || 1;
    if (value === 0) return 4;
    return Math.max(0, Math.min(8, Math.round((value / magnitude) * 4) + 4));
  }
  if (max === min) return 4;
  return Math.max(0, Math.min(8, Math.round(((value - min) / (max - min)) * (STEPS - 1))));
}

export function HeatmapChart({ chart }: { chart: HeatmapSpec }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<{ row: number; column: number } | null>(null);
  const columns = chart.x.length;
  const rows = chart.y.length;
  const values = chart.values.flat().filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const yLabels = chart.y.map((value) => formatValue(value, chart.yFormat));
  const left = Math.ceil(Math.max(...yLabels.map((label) => textWidth(label))) + 18);
  const right = 8;
  const cellWidth = Math.max(8, (width - left - right) / columns);
  const cellHeight = Math.max(22, Math.min(40, 260 / rows));
  const top = 6;
  const height = top + rows * cellHeight + 44;
  const xLabels = chart.x.map((value) => formatValue(value, chart.xFormat));
  const labelEvery = Math.max(
    1,
    Math.ceil((Math.max(...xLabels.map((label) => textWidth(label))) + 10) / cellWidth),
  );
  const cellText = (value: number) => formatValue(value, chart.valueFormat ?? 'compact');
  const showText =
    cellWidth >=
      Math.max(...chart.values.flat().map((value) => textWidth(cellText(value), 10.5))) + 8 &&
    cellHeight >= 20;
  const prefix = chart.scale === 'diverging' ? 'tf-div' : 'tf-seq';

  const onKeyDown = (event: React.KeyboardEvent) => {
    const current = active ?? { row: 0, column: 0 };
    const moves: Record<string, { row: number; column: number }> = {
      ArrowRight: {
        row: current.row,
        column: Math.min(columns - 1, current.column + (active ? 1 : 0)),
      },
      ArrowLeft: { row: current.row, column: Math.max(0, current.column - (active ? 1 : 0)) },
      ArrowDown: {
        row: Math.min(rows - 1, current.row + (active ? 1 : 0)),
        column: current.column,
      },
      ArrowUp: { row: Math.max(0, current.row - (active ? 1 : 0)), column: current.column },
    };
    const next = moves[event.key];
    if (next) {
      event.preventDefault();
      setActive(next);
    } else if (event.key === 'Escape') setActive(null);
  };

  const activeValue = active ? chart.values[active.row]![active.column]! : null;
  return (
    <ChartFrame
      title={chart.title}
      {...(chart.caption ? { caption: chart.caption } : {})}
      table={{
        columns: [`${chart.yLabel} \\ ${chart.xLabel}`, ...xLabels],
        rows: chart.values.map((row, rowIndex) => [
          yLabels[rowIndex]!,
          ...row.map((value) => formatValue(value, chart.valueFormat ?? 'number')),
        ]),
      }}
      description={`${chart.valueLabel} for each combination of ${chart.yLabel} (rows) and ${chart.xLabel} (columns).`}
      toolbar={
        <div
          className="flex items-center gap-2 text-[0.6875rem] text-fd-muted-foreground"
          aria-hidden
        >
          <span>
            {chart.scale === 'diverging'
              ? 'Loss'
              : formatValue(min, chart.valueFormat ?? 'compact')}
          </span>
          <span className="flex overflow-hidden rounded">
            {Array.from({ length: STEPS }, (_, step) => (
              <span
                key={step}
                className="h-2.5 w-3.5"
                style={{ background: `var(--${prefix}-${step})` }}
              />
            ))}
          </span>
          <span>
            {chart.scale === 'diverging'
              ? 'Profit'
              : formatValue(max, chart.valueFormat ?? 'compact')}
          </span>
        </div>
      }
    >
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={height}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerLeave={() => setActive(null)}
          onBlur={() => setActive(null)}
          className="block outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2"
          aria-label={`${chart.title}: use arrow keys to move between cells`}
        >
          {chart.y.map((_y, row) => (
            <text
              key={`y-${row}`}
              x={left - 8}
              y={top + row * cellHeight + cellHeight / 2}
              dy="0.32em"
              textAnchor="end"
              className="tf-chart-tick"
            >
              {yLabels[row]}
            </text>
          ))}
          {chart.values.map((rowValues, row) =>
            rowValues.map((value, column) => {
              const step = heatStep(value, min, max, chart.scale);
              const x = left + column * cellWidth;
              const y = top + row * cellHeight;
              const highlighted =
                chart.highlight &&
                chart.x[column] === chart.highlight.x &&
                chart.y[row] === chart.highlight.y;
              return (
                <g key={`${row}-${column}`} onPointerEnter={() => setActive({ row, column })}>
                  <rect
                    x={x + 1}
                    y={y + 1}
                    width={Math.max(1, cellWidth - 2)}
                    height={Math.max(1, cellHeight - 2)}
                    rx={3}
                    fill={step < 0 ? 'var(--color-fd-muted)' : `var(--${prefix}-${step})`}
                  />
                  {highlighted ? (
                    <rect
                      x={x + 2}
                      y={y + 2}
                      width={cellWidth - 4}
                      height={cellHeight - 4}
                      rx={2.5}
                      fill="none"
                      stroke="var(--color-chart-ink)"
                      strokeWidth={2}
                    />
                  ) : null}
                  {showText ? (
                    <text
                      x={x + cellWidth / 2}
                      y={y + cellHeight / 2}
                      dy="0.34em"
                      textAnchor="middle"
                      className="tf-chart-cell"
                      style={{ fill: `var(--${prefix}-ink-${Math.max(0, step)})` }}
                    >
                      {cellText(value)}
                    </text>
                  ) : null}
                </g>
              );
            }),
          )}
          {active ? (
            <rect
              x={left + active.column * cellWidth + 1}
              y={top + active.row * cellHeight + 1}
              width={cellWidth - 2}
              height={cellHeight - 2}
              rx={3}
              fill="none"
              stroke="var(--color-fd-ring)"
              strokeWidth={2}
              pointerEvents="none"
            />
          ) : null}
          {chart.x.map((_x, column) =>
            column % labelEvery === 0 ? (
              <text
                key={`x-${column}`}
                x={left + column * cellWidth + cellWidth / 2}
                y={top + rows * cellHeight + 16}
                textAnchor="middle"
                className="tf-chart-tick"
              >
                {xLabels[column]}
              </text>
            ) : null,
          )}
          <text x={width - right} y={height - 6} textAnchor="end" className="tf-chart-axis-label">
            {chart.xLabel}
          </text>
          <text x={0} y={height - 6} className="tf-chart-axis-label">
            Rows: {chart.yLabel}
          </text>
        </svg>
        {active && activeValue !== null ? (
          <Tooltip
            x={left + active.column * cellWidth + cellWidth / 2}
            y={top + active.row * cellHeight + cellHeight}
            width={width}
            title={`${chart.yLabel} ${yLabels[active.row]} · ${chart.xLabel.split(' · ')[0]} ${xLabels[active.column]}`}
            rows={[
              {
                key: 'value',
                label: chart.valueLabel,
                value: formatValue(activeValue, chart.valueFormat ?? 'number'),
              },
            ]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
