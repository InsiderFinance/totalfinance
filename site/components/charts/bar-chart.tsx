'use client';
import { useState } from 'react';
import { formatValue } from '@/src/format';
import type { BarChart as BarSpec } from '@/src/types';
import {
  ChartFrame,
  linear,
  textWidth,
  toneColor,
  Tooltip,
  useWidth,
  YAxis,
  yMargin,
} from './chart-kit';

export function BarChart({ chart }: { chart: BarSpec }) {
  const [ref, width] = useWidth();
  const [active, setActive] = useState<number | null>(null);
  const height = 260;
  const bottom = height - 40;
  const values = chart.bars.map((bar) => bar.value);
  const yScale = linear([Math.min(0, ...values), Math.max(0, ...values) * 1.08 || 1], [bottom, 18]);
  const ticks = yScale.ticks(5);
  const left = yMargin(ticks, chart.yFormat, ticks.length > 1 ? ticks[1]! - ticks[0]! : 0);
  const right = 10;
  const slot = (width - left - right) / Math.max(1, chart.bars.length);
  const barWidth = Math.max(1, Math.min(24, slot - 2));
  const zero = yScale(0);
  const labelEvery = Math.max(
    1,
    Math.ceil((Math.max(...chart.bars.map((bar) => textWidth(bar.label))) + 12) / slot),
  );
  return (
    <ChartFrame
      title={chart.title}
      {...(chart.caption ? { caption: chart.caption } : {})}
      legend={
        chart.bars.some((bar) => bar.tone === 'brand') &&
        chart.bars.some((bar) => bar.tone !== 'brand')
          ? [
              { label: 'Coupon', color: toneColor('neutral'), kind: 'rect' },
              { label: 'Coupon + principal', color: toneColor('brand'), kind: 'rect' },
            ]
          : undefined
      }
      table={{
        columns: [chart.xLabel, chart.yLabel],
        rows: chart.bars.map((bar) => [bar.label, formatValue(bar.value, chart.yFormat)]),
      }}
      description={`${chart.bars.length} bars of ${chart.yLabel} by ${chart.xLabel}.`}
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
          {chart.bars.map((bar, index) => {
            const center = left + slot * index + slot / 2;
            const y = yScale(bar.value);
            return (
              <g key={`${bar.label}-${index}`} onPointerEnter={() => setActive(index)}>
                <rect
                  x={center - slot / 2}
                  y={14}
                  width={slot}
                  height={bottom - 14}
                  fill="transparent"
                />
                <rect
                  x={center - barWidth / 2}
                  y={Math.min(y, zero)}
                  width={barWidth}
                  height={Math.max(1, Math.abs(zero - y))}
                  rx={Math.min(4, barWidth / 3)}
                  fill={toneColor(bar.tone ?? 'brand')}
                  opacity={active === null || active === index ? 0.9 : 0.45}
                />
                {index % labelEvery === 0 ? (
                  <text x={center} y={bottom + 16} textAnchor="middle" className="tf-chart-tick">
                    {bar.label}
                  </text>
                ) : null}
              </g>
            );
          })}
          <line
            x1={left}
            x2={width - right}
            y1={zero}
            y2={zero}
            stroke="var(--color-chart-axis)"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          <text x={width - right} y={height - 4} textAnchor="end" className="tf-chart-axis-label">
            {chart.xLabel}
          </text>
        </svg>
        {active !== null && chart.bars[active] ? (
          <Tooltip
            x={left + slot * active + slot / 2}
            y={20}
            width={width}
            title={chart.bars[active]!.label}
            rows={[
              {
                key: 'value',
                label: chart.yLabel,
                value: formatValue(chart.bars[active]!.value, chart.yFormat),
              },
            ]}
          />
        ) : null}
      </div>
    </ChartFrame>
  );
}
