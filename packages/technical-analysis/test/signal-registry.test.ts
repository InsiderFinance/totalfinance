import { describe, expect, it } from 'vitest';
import { type BarInput, snapshotOf } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import {
  defineIndicator,
  getIndicator,
  hasIndicator,
  indicatorCategories,
  listIndicators,
  registryMarkdown,
} from '@totalfinance/technical-analysis/registry';
import {
  type IndicatorStream,
  type TechnicalAnalysisSnapshot,
} from '@totalfinance/technical-analysis/framework';

describe('indicator registry', () => {
  it('auto-registers the whole catalog with metadata', () => {
    const all = listIndicators();
    expect(all.length).toBeGreaterThan(120);
    const rsi = getIndicator('rsi');
    expect(rsi?.inputs).toBe('series');
    expect(rsi?.parameters).toContain('period');
    expect(rsi?.category).toBe('momentum');
    expect(getIndicator('atr')?.inputs).toBe('bars');
    // the candlestick catalog is registered too
    expect(getIndicator('engulfing')?.category).toBe('candlestick');
    expect(indicatorCategories()).toContain('volatility');
  });

  it('the registered facade is the working indicator', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const reg = getIndicator('sma')!.indicator;
    expect(reg(closes, { period: 5 })).toEqual(ta.sma(closes, { period: 5 }));
  });

  it('defineIndicator builds and registers a custom indicator', () => {
    class ScaleStream implements IndicatorStream<number, number> {
      value: number | null = null;
      constructor(private readonly k: number) {}
      next(v: number): number | null {
        this.value = v * this.k;
        return this.value;
      }
      toJSON(): TechnicalAnalysisSnapshot {
        return snapshotOf('scale', { k: this.k, value: this.value });
      }
    }
    if (!hasIndicator('scale2x')) {
      const scale2x = defineIndicator<{ k: number }, number, number>({
        name: 'scale2x',
        category: 'custom',
        inputs: 'series',
        output: { value: { type: 'number' } },
        parameters: ['k'],
        stream: (p) => new ScaleStream(p.k),
        restore: (s) => {
          const x = new ScaleStream(s.state['k'] as number);
          x.value = s.state['value'] as number | null;
          return x;
        },
        nan: () => NaN,
      });
      expect(scale2x([1, 2, 3], { k: 2 })).toEqual([2, 4, 6]);
    }
    expect(hasIndicator('scale2x')).toBe(true);
    expect(getIndicator('scale2x')?.category).toBe('custom');
  });

  it('renders a Markdown reference covering every category', () => {
    const md = registryMarkdown();
    expect(md).toContain('# TotalFinance indicator registry');
    expect(md).toContain('## moving-average');
    expect(md).toContain('`rsi`');
    expect(md).toContain('## candlestick');
  });
});

describe('signal DSL', () => {
  // decline then rally → the fast SMA crosses up through the slow SMA
  const closes = [20, 18, 16, 14, 12, 10, 9, 10, 12, 14, 16, 18, 20, 22, 24, 26];
  const bars: BarInput[] = closes.map((c) => ({
    open: c,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: 100,
  }));

  it('emits a label when the fast SMA crosses the slow SMA', () => {
    const sig = ta
      .signal(bars)
      .sma('close', { period: 3 }, { as: 'fast' })
      .sma('close', { period: 6 }, { as: 'slow' })
      .when(ta.crossOver('fast', 'slow'))
      .emit('long')
      .when(ta.crossUnder('fast', 'slow'))
      .emit('flat');
    const out = sig.signals();
    expect(out).toHaveLength(bars.length);
    expect(out).toContain('long'); // the up-cross during the rally
    const events = sig.events();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => out[e.index] === e.label)).toBe(true);
  });

  it('combines conditions with and/or and constants', () => {
    const out = ta
      .signal(bars)
      .sma('close', { period: 3 }, { as: 'fast' })
      .rsi('close', { period: 5 }, { as: 'momentum' })
      .when(ta.gt('fast', 15))
      .and(ta.gt('momentum', 50))
      .emit('strong')
      .signals();
    // by the end of the rally both fast SMA > 15 and RSI > 50
    expect(out.at(-1)).toBe('strong');
  });

  it('references a record column injected as a feature', () => {
    const out = ta
      .signal(bars)
      .feature('macd', ta.macd(closes, { fast: 2, slow: 4, signal: 2 }))
      .when(ta.gt('macd.histogram', 0)) // dotted access into the record column
      .emit('up')
      .signals();
    expect(out.some((x) => x === 'up')).toBe(true);
  });

  it('exposes the computed feature columns', () => {
    const sig = ta.signal(bars).sma('close', { period: 3 }, { as: 'fast' });
    expect(Object.keys(sig.columns())).toContain('fast');
  });
});

describe('feature pipeline expansion', () => {
  const bars: BarInput[] = Array.from({ length: 30 }, (_, i) => ({
    open: 100 + i,
    high: 100 + i + 1,
    low: 100 + i - 1,
    close: 100 + i,
    volume: 100 + i,
  }));
  it('repeated auto-named indicators disambiguate; duplicate explicit aliases throw', () => {
    const cols = ta
      .features(bars)
      .sma('close', { period: 10 })
      .sma('close', { period: 10 })
      .sma('close', { period: 10 })
      .toColumns();
    expect(Object.keys(cols)).toEqual(['sma_close_10', 'sma_close_10_2', 'sma_close_10_3']);
    expect(() =>
      ta
        .features(bars)
        .sma('close', { period: 10 }, { as: 'x' })
        .ema('close', { period: 5 }, { as: 'x' }),
    ).toThrowError(/Duplicate pipeline alias/);
  });

  it('applySeries / applyBars reach any indicator; column injects precomputed', () => {
    const cols = ta
      .features(bars)
      .applySeries('close', ta.kama, { period: 10 }, { as: 'kama' })
      .applyBars(ta.cci, { period: 14 }, { as: 'cci' })
      .column(
        'ones',
        bars.map(() => 1),
      )
      .toColumns();
    expect(Object.keys(cols)).toEqual(['kama', 'cci', 'ones']);
    expect(cols['kama']).toHaveLength(bars.length);
    expect((cols['ones'] as number[])[0]).toBe(1);
  });
});
