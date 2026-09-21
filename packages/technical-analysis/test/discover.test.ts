/**
 * Targeted TA discovery (`describeIndicator`, `searchIndicators`, `indicatorWarmup`). Verifies the
 * single-indicator card (parameters/defaults/required/warmup/aliases and alias-aware resolution), that the
 * per-indicator warmup agrees with the bulk `indicatorWarmups`, that search matches names AND
 * cross-library aliases with correct pagination + `total`, and the guards.
 */

import { describe, expect, it } from 'vitest';
import {
  describeIndicator,
  indicatorWarmup,
  indicatorWarmups,
  listIndicators,
  searchIndicators,
} from '@totalfinance/technical-analysis';

describe('describeIndicator', () => {
  it('returns the full card for an indicator: parameters, defaults, required, warmup, aliases', () => {
    const d = describeIndicator('rsi');
    expect(d.name).toBe('rsi');
    expect(d.category).toBe('momentum');
    expect(d.inputs).toBe('series');
    expect(d.parameters).toContain('period');
    expect(d.defaults['period']).toBe(14);
    expect(d.required).toEqual([]); // period has a default
    expect(d.warmup).toBe(14);
    expect(d.aliases?.talib).toBe('RSI');
  });

  it('resolves an alias to the canonical indicator', () => {
    expect(describeIndicator('RSI').name).toBe('rsi'); // TA-Lib name → canonical
  });

  it('omits the aliases field for an indicator with no cross-library name', () => {
    const d = describeIndicator('realBody'); // a candlestick primitive with no TA-Lib/pandas alias
    expect(d.name).toBe('realBody');
    expect(d.aliases).toBeUndefined();
  });

  it('reports warmup: null when the warmup exceeds the probe window', () => {
    // rsi needs ~14 bars; a probe of 8 is too short to ever emit, so warmup is disclosed as null.
    expect(describeIndicator('rsi', 8).warmup).toBeNull();
  });

  it('throws on an unknown indicator and an empty name', () => {
    expect(() => describeIndicator('definitely-not-an-indicator')).toThrowError();
    expect(() => describeIndicator('')).toThrowError();
  });
});

describe('indicatorWarmup', () => {
  it('agrees with the bulk indicatorWarmups for a sample of indicators', () => {
    const bulk = new Map(indicatorWarmups().map((w) => [w.name, w.warmup]));
    for (const name of ['rsi', 'sma', 'macd', 'atr']) {
      expect(indicatorWarmup(name).warmup).toBe(bulk.get(name));
    }
  });

  it('guards an empty name and an out-of-range probeLength', () => {
    expect(() => indicatorWarmup('')).toThrowError();
    expect(() => indicatorWarmup('rsi', 4)).toThrowError(); // < 8
    expect(() => indicatorWarmup('rsi', 3.5)).toThrowError(); // non-integer
  });
});

describe('searchIndicators', () => {
  it('with no filter returns every indicator (total === returned)', () => {
    const all = searchIndicators();
    expect(all.total).toBe(listIndicators().length);
    expect(all.indicators.length).toBe(all.total);
    expect(all.limit).toBeNull();
  });

  it('matches a substring of the canonical name', () => {
    const r = searchIndicators({ query: 'stoch' });
    expect(r.total).toBeGreaterThanOrEqual(2);
    expect(r.indicators.every((i) => i.name.toLowerCase().includes('stoch'))).toBe(true);
  });

  it('matches a cross-library alias (TA-Lib name), not just the canonical name', () => {
    // "MACD" is the TA-Lib alias; the search must find the macd family via aliases.
    const r = searchIndicators({ query: 'MACD' });
    expect(r.indicators.some((i) => i.name === 'macd')).toBe(true);
  });

  it('filters by category', () => {
    const r = searchIndicators({ category: 'moving-average' });
    expect(r.total).toBeGreaterThan(0);
    expect(r.indicators.every((i) => i.category === 'moving-average')).toBe(true);
  });

  it('paginates with a correct total, and rows are stable/sorted for deterministic paging', () => {
    const total = searchIndicators().total;
    const page1 = searchIndicators({ limit: 10, offset: 0 });
    const page2 = searchIndicators({ limit: 10, offset: 10 });
    expect(page1.total).toBe(total);
    expect(page1.indicators.length).toBe(10);
    expect(page1.limit).toBe(10);
    // Sorted alphabetically ⇒ no overlap between consecutive pages.
    const names1 = new Set(page1.indicators.map((i) => i.name));
    expect(page2.indicators.some((i) => names1.has(i.name))).toBe(false);
    // The last page returns only the remainder.
    const last = searchIndicators({ limit: 10, offset: total - 3 });
    expect(last.indicators.length).toBe(3);
  });

  it('a row carries defaults + required (but not warmup — that is per-describe)', () => {
    const r = searchIndicators({ query: 'rsi' });
    const rsi = r.indicators.find((i) => i.name === 'rsi')!;
    expect(rsi.defaults['period']).toBe(14);
    expect(rsi.required).toEqual([]);
    expect('warmup' in rsi).toBe(false);
  });

  it('guards bad limit/offset/query', () => {
    expect(() => searchIndicators({ limit: -1 })).toThrowError();
    expect(() => searchIndicators({ limit: 2.5 })).toThrowError();
    expect(() => searchIndicators({ offset: -1 })).toThrowError();
    expect(() => searchIndicators({ query: 123 as never })).toThrowError();
    expect(() => searchIndicators(null as never)).toThrowError();
  });
});
