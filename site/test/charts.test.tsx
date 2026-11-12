import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chart } from '../components/charts/chart';
import { extent, fitTicks, nearestIndex } from '../components/charts/chart-kit';
import { heatStep } from '../components/charts/heatmap-chart';
import { binValues } from '../components/charts/histogram-chart';
import { playgrounds } from '../src/playgrounds/index';
import { defaultInput } from '../src/playgrounds/inputs';
import { formatControl, formatTick, formatValue } from '../src/format';
import type { Chart as ChartSpec } from '../src/types';

const render = (chart: ChartSpec) => renderToStaticMarkup(<Chart chart={chart} />);

describe('charts', () => {
  it.each(playgrounds.map((playground) => [playground.id, playground] as const))(
    '%s: every chart renders an accessible figure with its exact data and no NaN',
    (_id, playground) => {
      const calculation = playground.run(defaultInput(playground));
      for (const chart of [calculation.chart, ...(calculation.additionalCharts ?? [])]) {
        const html = render(chart);
        expect(html).toContain('role="img"');
        expect(html).toContain('Exact values are in the data table');
        expect(html).toContain('Show data');
        expect(html).not.toMatch(/\bNaN\b|undefined|Infinity/);
      }
    },
  );

  it('handles empty, flat and non-finite series without inventing values', () => {
    const empty = render({
      title: 'Empty',
      xLabel: 'x',
      yLabel: 'y',
      series: [{ name: 'none', points: [] }],
    });
    expect(empty).not.toMatch(/NaN/);
    const flat = render({
      title: 'Flat',
      xLabel: 'x',
      yLabel: 'y',
      series: [
        {
          name: 'flat',
          points: [
            { x: 1, y: 2 },
            { x: 1, y: 2 },
          ],
        },
      ],
    });
    expect(flat).not.toMatch(/NaN/);
    const gaps = render({
      title: 'Warmup gaps',
      xLabel: 'x',
      yLabel: 'y',
      series: [
        {
          name: 'gaps',
          points: [
            { x: 0, y: NaN },
            { x: 1, y: 2 },
            { x: 2, y: Infinity },
            { x: 3, y: 4 },
          ],
        },
      ],
    });
    expect(gaps).not.toMatch(/\bNaN\b/);
  });

  it('escapes untrusted labels (CSV headers, user text) as text', () => {
    const html = render({
      title: '<script>alert(1)</script>',
      xLabel: '<b>x</b>',
      yLabel: 'y',
      series: [
        {
          name: '"><img src=x>',
          points: [
            { x: 0, y: 1 },
            { x: 1, y: 2 },
          ],
        },
      ],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x>');
  });

  it('scales: extents never collapse, include zero on request, and ticks thin to fit', () => {
    expect(extent([5, 5])[0]).toBeLessThan(5);
    expect(extent([])).toEqual([0, 1]);
    expect(extent([2, 3], { includeZero: true })[0]).toBe(0);
    expect(extent([NaN, 1, 2])[0]).toBeLessThan(1);
    const ticks = Array.from({ length: 20 }, (_, index) => index * 1000);
    expect(fitTicks(ticks, 200, (tick) => String(tick)).length).toBeLessThan(ticks.length);
    expect(nearestIndex([1, 2, 4, 8], 5)).toBe(2);
    expect(nearestIndex([], 5)).toBe(-1);
  });

  it('heatmap steps: diverging is centred on zero, sequential spans the range', () => {
    expect(heatStep(0, -10, 10, 'diverging')).toBe(4);
    expect(heatStep(-10, -10, 10, 'diverging')).toBe(0);
    expect(heatStep(10, -2, 10, 'diverging')).toBe(8);
    expect(heatStep(5, 0, 10, 'sequential')).toBe(4);
    expect(heatStep(NaN, 0, 10, 'sequential')).toBe(-1);
  });

  it('histogram bins cover every observation exactly once', () => {
    const values = Array.from({ length: 500 }, (_, index) => Math.sin(index) * 0.03);
    const bins = binValues(values);
    expect(bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(500);
    expect(bins.length).toBeGreaterThanOrEqual(12);
    expect(bins.length).toBeLessThanOrEqual(60);
    expect(binValues([1, 1, 1])).toEqual([{ from: 0.5, to: 1.5, count: 3 }]);
    expect(binValues([NaN])).toEqual([]);
  });
});

describe('display formatting', () => {
  it('keeps units honest and never prints NaN or Infinity', () => {
    expect(formatValue(0.0525, 'decimal-percent')).toBe('5.25%');
    expect(formatValue(1234.5, 'currency')).toBe('$1,234.50');
    expect(formatValue(14_939_965, 'currency')).toBe('$14,939,965');
    expect(formatValue(Infinity)).toBe('Unbounded');
    expect(formatValue(-Infinity)).toBe('Unbounded loss');
    expect(formatValue(NaN)).toBe('Not defined');
    expect(formatValue(null)).toBe('Not defined');
    expect(formatValue(0.00001234)).toMatch(/E/);
    expect(formatTick(0.05, 'decimal-percent', 0.01)).toBe('5%');
    expect(formatTick(25000, 'currency', 5000)).toBe('25K');
    expect(formatControl(0.2, 'decimal-percent')).toBe('20%');
    expect(formatControl(0.25, 'years')).toBe('0.25 years');
  });
});
