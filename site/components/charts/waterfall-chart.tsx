'use client';
import { useState } from 'react';
import { formatValue } from '@/src/format';
import type { WaterfallChart as WaterfallSpec } from '@/src/types';
import { ChartFrame, linear, textWidth, Tooltip, useWidth, YAxis, yMargin } from './chart-kit';

export function WaterfallChart({ chart }: { chart: WaterfallSpec }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const height = 300;
  const bottom = height - 48;
  let running = 0;
  const bars = chart.steps.map((step) => {
    if (step.kind === 'delta') {
      const from = running;
      running += step.value;
      return { ...step, from, to: running };
    }
    running = step.value;
    return { ...step, from: null as number | null, to: step.value };
  });
  const levels = bars.flatMap((bar) => (bar.from === null ? [bar.to] : [bar.from, bar.to]));
  const low = Math.min(...levels);
  const high = Math.max(...levels);
  // A waterfall of large balances with small changes would hide the changes against zero, so the
  // axis starts near the lowest level; the caption says so whenever it does not start at zero.
  const spread = high - low || Math.abs(high) * 0.05 || 1;
  const floor = low > 0 && spread / high < 0.5 ? low - spread * 0.6 : Math.min(0, low);
  const yScale = linear([floor, high + spread * 0.25], [bottom, 22]);
  const ticks = yScale.ticks(5);
  const left = yMargin(ticks, chart.yFormat, ticks.length > 1 ? ticks[1]! - ticks[0]! : 0);
  const right = 10;
  const slot = (width - left - right) / bars.length;
  const barWidth = Math.min(64, slot * 0.6);
  const domainFloor = yScale.domain()[0]!;
  const truncated = domainFloor > 0;
  return (
    <ChartFrame
      title={chart.title}
      caption={`${chart.caption ?? ''}${truncated ? ` The axis starts at ${formatValue(domainFloor, chart.yFormat)}, not zero, so the changes stay visible.` : ''}`.trim()}
      table={{
        columns: ['Step', chart.yLabel, 'Running total'],
        rows: bars.map((bar) => [
          bar.label,
          formatValue(bar.value, chart.yFormat),
          formatValue(bar.to, chart.yFormat),
        ]),
      }}
      description={`Steps from ${bars[0]?.label ?? 'start'} to ${bars.at(-1)?.label ?? 'end'}.`}
    >
      <div ref={ref} className="relative">
        <svg width={width} height={height} className="block" onPointerLeave={() => setActive(null)}>
          <YAxis
            ticks={ticks}
            scale={yScale}
            width={width - right}
            left={left}
            {...(chart.yFormat ? { format: chart.yFormat } : {})}
            label={chart.yLabel}
          />
          {bars.map((bar, index) => {
            const center = left + slot * index + slot / 2;
            const y0 = bar.from === null ? yScale(domainFloor) : yScale(bar.from);
            const y1 = yScale(bar.to);
            const top = Math.min(y0, y1);
            const color =
              bar.kind === 'delta'
                ? bar.value >= 0
                  ? 'var(--color-profit)'
                  : 'var(--color-loss)'
                : 'var(--color-series-1)';
            const valueLabel =
              bar.kind === 'delta'
                ? `${bar.value >= 0 ? '+' : '−'}${formatValue(Math.abs(bar.value), chart.yFormat)}`
                : formatValue(bar.value, chart.yFormat);
            const next = bars[index + 1];
            const words = bar.label.split(' ');
            const lines =
              textWidth(bar.label, 11) > slot - 6 && words.length > 1
                ? [
                    words.slice(0, Math.ceil(words.length / 2)).join(' '),
                    words.slice(Math.ceil(words.length / 2)).join(' '),
                  ]
                : [bar.label];
            return (
              <g key={`${bar.label}-${index}`} onPointerEnter={() => setActive(index)}>
                <rect
                  x={center - slot / 2}
                  y={20}
                  width={slot}
                  height={bottom - 20}
                  fill="transparent"
                />
                <rect
                  x={center - barWidth / 2}
                  y={top}
                  width={barWidth}
                  height={Math.max(1.5, Math.abs(y1 - y0))}
                  rx={3}
                  fill={color}
                  opacity={active === null || active === index ? 0.9 : 0.5}
                />
                {next ? (
                  <line
                    x1={center + barWidth / 2}
                    x2={center + slot - barWidth / 2}
                    y1={y1}
                    y2={y1}
                    stroke="var(--color-chart-ink-muted)"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                  />
                ) : null}
                <text
                  x={center}
                  y={top - 6}
                  textAnchor="middle"
                  className="tf-chart-marker"
                  style={{ fill: 'var(--color-chart-ink)' }}
                >
                  {valueLabel}
                </text>
                {lines.map((line, lineIndex) => (
                  <text
                    key={line}
                    x={center}
                    y={bottom + 16 + lineIndex * 13}
                    textAnchor="middle"
                    className="tf-chart-tick"
                  >
                    {line}
                  </text>
                ))}
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
        </svg>
        {active !== null && bars[active] ? (
          <Tooltip
            x={left + slot * active + slot / 2}
            y={24}
            width={width}
            title={bars[active]!.label}
            rows={[
              {
                key: 'value',
                label: bars[active]!.kind === 'delta' ? 'change' : 'balance',
                value: formatValue(bars[active]!.value, chart.yFormat),
              },
              ...(bars[active]!.kind === 'delta'
                ? [
                    {
                      key: 'total',
                      label: 'running total',
                      value: formatValue(bars[active]!.to, chart.yFormat),
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
