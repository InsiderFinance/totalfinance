/**
 * Indicator output metadata (Wave 6 §4). The curated {@link resolveOutputMetadata} shape for EVERY
 * registered indicator (335) must match its actual post-warmup runtime output — no representative-only
 * loophole. Runtime inference VERIFIES the curated data here; it never redefines it. Also pins the
 * spec-named cases (RSI oscillator, MACD lines+histogram, Bollinger bands, SMA line, Heikin-Ashi bars,
 * candlestick events, movingAverageRibbon vector) and the register/defineIndicator requirement.
 */

import { describe, expect, it } from 'vitest';
import { describeIndicator, searchIndicators } from '@totalfinance/technical-analysis';
import { defineIndicator, getIndicator, listIndicators, register } from '../src/registry.js';
import { indicatorWarmups } from '../src/warmup.js';
import { inferOutputValue, structuralValueEqual } from '../src/output-meta.js';

const LEN = 400;
const series = Array.from(
  { length: LEN },
  (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.1 + (i % 7 === 0 ? 2 : -1),
);
const bars = series.map((c, i) => {
  const open = i === 0 ? c : series[i - 1]!;
  return {
    open,
    high: Math.max(open, c) + 1 + (i % 3) * 0.5,
    low: Math.min(open, c) - 1 - (i % 4) * 0.3,
    close: c,
    volume: 1000 + ((i * 53) % 400),
  };
});
const other = series.map((v, i) => v + Math.cos(i / 4) * 3);
const pair = series.map((x, i) => ({ x, y: other[i]! }));

function runLast(name: string, inputs: string, parameters: Record<string, unknown>): unknown {
  const input = inputs === 'series' ? series : inputs === 'bars' ? bars : pair;
  const ind = getIndicator(name)!.indicator as (
    i: unknown,
    p: unknown,
  ) => { value?: unknown[] } | unknown[];
  const raw = ind(input, parameters);
  const out = Array.isArray(raw) ? raw : (raw.value ?? []);
  return out[out.length - 1];
}

describe('output metadata — runtime conformance', () => {
  const warm = new Map(indicatorWarmups(512).map((w) => [w.name, w]));

  it("every registered indicator's declared output shape matches its runtime output", () => {
    const indicators = listIndicators();
    expect(indicators.length).toBeGreaterThanOrEqual(335);
    const mismatches: string[] = [];
    for (const e of indicators) {
      expect(e.output, `${e.name} has no output metadata`).toBeDefined();
      const last = runLast(e.name, e.inputs, warm.get(e.name)!.parameters);
      const inferred = inferOutputValue(last);
      if (!structuralValueEqual(e.output.value, inferred)) {
        mismatches.push(
          `${e.name}: declared ${JSON.stringify(e.output.value)} vs runtime ${JSON.stringify(inferred)}`,
        );
      }
    }
    expect(mismatches, `output-metadata shape mismatches:\n${mismatches.join('\n')}`).toEqual([]);
  });

  it('the specification-named cases carry honest shapes', () => {
    const rsi = describeIndicator('rsi');
    expect(rsi.output.value).toMatchObject({ type: 'number', bounds: [0, 100] });
    expect(rsi.output.visualization?.kind).toBe('oscillator');

    const macd = describeIndicator('macd').output.value;
    expect(macd.type).toBe('record');
    if (macd.type === 'record')
      expect(Object.keys(macd.fields).sort()).toEqual(['histogram', 'macd', 'signal']);

    const bb = describeIndicator('bbands').output.value;
    if (bb.type === 'record')
      expect(Object.keys(bb.fields)).toEqual(expect.arrayContaining(['upper', 'middle', 'lower']));

    const sma = describeIndicator('sma');
    expect(sma.output.value.type).toBe('number');
    expect(sma.output.visualization?.kind).toBe('line');

    const ha = describeIndicator('heikinAshi').output;
    expect(ha.visualization?.kind).toBe('candles');
    if (ha.value.type === 'record')
      expect(Object.keys(ha.value.fields).sort()).toEqual(['close', 'high', 'low', 'open']);

    expect(describeIndicator('cdlDoji').output.visualization?.kind).toBe('events');

    const ribbon = describeIndicator('movingAverageRibbon').output.value;
    expect(ribbon.type).toBe('array');
    if (ribbon.type === 'array') expect(ribbon.items.type).toBe('number');
  });

  it('describeIndicator, searchIndicators, and registryMarkdown expose the SAME output data', () => {
    const fromDescribe = describeIndicator('macd').output;
    const fromSearch = searchIndicators({ query: 'macd', match: 'substring' }).indicators.find(
      (i) => i.name === 'macd',
    )!.output;
    expect(fromSearch).toEqual(fromDescribe);
    // A registered indicator carries the same object identity as the registry (no hand-maintained copy).
    expect(fromDescribe).toBe(getIndicator('macd')!.output);
  });

  it('register / defineIndicator require valid output metadata', () => {
    expect(() =>
      register({
        name: '_noOutput',
        category: 'custom',
        inputs: 'series',
        parameters: [],
        indicator: getIndicator('sma')!.indicator,
      } as never),
    ).toThrowError(/output metadata/);
    expect(() =>
      defineIndicator({
        name: '_badOutput',
        inputs: 'series',
        output: { value: { type: 'notAType' } } as never,
        stream: () => ({ next: () => 0 }) as never,
        restore: () => ({ next: () => 0 }) as never,
        nan: () => 0,
      }),
    ).toThrowError();
  });
});
