import { describe, expect, it } from 'vitest';
import { indicatorWarmups, listIndicators, warmupMarkdown } from '@totalfinance/technical-analysis';

const infos = indicatorWarmups();
const byName = new Map(infos.map((i) => [i.name, i]));

describe('indicator warmups', () => {
  it('measures every registered indicator without throwing (canonical parameters cover the catalog)', () => {
    expect(infos.length).toBe(listIndicators().length);
    for (const i of infos) {
      if (i.warmup !== null) {
        expect(Number.isInteger(i.warmup), i.name).toBe(true);
        expect(i.warmup, i.name).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('every indicator emits within the probe at canonical parameters (no nulls)', () => {
    const nulls = infos.filter((i) => i.warmup === null).map((i) => i.name);
    expect(nulls, `did not warm up within the probe: ${nulls.join(', ')}`).toEqual([]);
  });

  it('matches known warmups from the canonical conventions', () => {
    expect(byName.get('sma')!.warmup).toBe(13); // period 14 → first at index 13
    expect(byName.get('ema')!.warmup).toBe(13);
    expect(byName.get('rsi')!.warmup).toBe(14); // Wilder: prev consumes bar 0, seed at period
    expect(byName.get('atr')!.warmup).toBe(13);
    expect(byName.get('macd')!.warmup).toBe(33); // slow 26 line + signal 9 chain: 25 + 8
    expect(byName.get('bbands')!.warmup).toBe(13); // canonical period 14
    expect(byName.get('williamsR')!.warmup).toBe(13);
    expect(byName.get('stochastic')!.warmup).toBe(15); // (14−1) + (3−1)
    expect(byName.get('cmo')!.warmup).toBe(14);
    expect(byName.get('roc')!.warmup).toBe(14);
    expect(byName.get('obv')!.warmup).toBe(0);
    expect(byName.get('bop')!.warmup).toBe(0);
    expect(byName.get('typicalPrice')!.warmup).toBe(0);
  });

  it('records the canonical parameters used per indicator', () => {
    expect(byName.get('sma')!.parameters).toEqual({ period: 14 });
    expect(byName.get('macd')!.parameters).toEqual({ fast: 12, slow: 26, signal: 9 });
    // the overloaded `anchor` param uses the per-indicator override (bar index, not 'high'/'low')
    expect(byName.get('anchoredVwap')!.parameters).toEqual({ anchor: 0 });
    expect(byName.get('rollingAnchoredVwap')!.parameters['anchor']).toBe('high');
  });

  it('warmupMarkdown renders a grouped table with the causality/displacement header', () => {
    const md = warmupMarkdown();
    expect(md).toContain('# TotalFinance indicator warmup');
    expect(md).toContain('**Lookahead: none.**');
    expect(md).toContain('**Displacement: none.**');
    expect(md).toContain('| Indicator | Inputs | Warmup | Canonical parameters |');
    expect(md).toContain('`rsi`');
  });
});
