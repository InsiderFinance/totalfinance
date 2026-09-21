import { describe, expect, it } from 'vitest';
import {
  type BarInput,
  CDL_ALIASES,
  candlesticks,
  candlestickNames,
  cdlInside,
  cdlPattern,
} from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

function lead(level = 50): BarInput[] {
  return Array.from({ length: 12 }, (_, i) => {
    const up = i % 2 === 0;
    return {
      open: up ? level - 0.2 : level + 0.2,
      high: level + 0.5,
      low: level - 0.5,
      close: up ? level + 0.2 : level - 0.2,
      volume: 100,
    };
  });
}

describe('cdlPattern + TA-Lib aliases', () => {
  it('runs a pattern by its TotalFinance name or TA-Lib CDL* alias (same result)', () => {
    const bars = [...lead(), { open: 50, high: 53, low: 47, close: 50.01, volume: 100 }];
    const byName = cdlPattern(bars, 'doji');
    const byTaLib = cdlPattern(bars, 'CDLDOJI');
    expect(byName).toEqual(byTaLib);
    expect(byName.at(-1)).toBe(100);
  });
  it("'all' scans the whole catalog", () => {
    const bars = [...lead(), { open: 50, high: 53, low: 47, close: 50.01, volume: 100 }];
    const matches = cdlPattern(bars, 'all');
    expect(matches).toHaveLength(bars.length);
    expect(matches.at(-1)!.some((m) => m.pattern === 'doji')).toBe(true);
  });
  it('rejects an unknown pattern name', () => {
    expect(() => cdlPattern(lead(), 'CDLNOTREAL')).toThrowError(/name/);
    expect(() => cdlPattern(lead(), 'bogus')).toThrowError(/name/);
  });
  it('the CDL alias map covers every catalog pattern (except the helper aliases)', () => {
    const mapped = new Set(Object.values(CDL_ALIASES));
    for (const name of candlestickNames) {
      expect(mapped.has(name), `missing TA-Lib alias for ${name}`).toBe(true);
    }
  });
});

describe('cdlInside (inside-bar pattern)', () => {
  it('fires only on a strict inside bar', () => {
    // a bar whose range is strictly inside the prior bar's range, bullish
    const inside = [
      ...lead(),
      { open: 49, high: 53, low: 47, close: 49, volume: 100 }, // wide prior bar
      { open: 49.5, high: 51, low: 48, close: 50, volume: 100 }, // strictly inside, white
    ];
    expect(cdlInside(inside, {}).at(-1)).toBe(100);
    // equal-range bars are NOT inside
    const flat = lead();
    expect(
      cdlInside(flat, {})
        .slice(2)
        .every((v) => v === 0 || Number.isNaN(v)),
    ).toBe(true);
  });
  it('is registered in the catalog and reachable via ta', () => {
    expect(candlestickNames).toContain('inside');
    expect(candlesticks['inside']).toBe(cdlInside);
    expect(ta.cdlInside).toBe(cdlInside);
    expect(typeof ta.cdlPattern).toBe('function');
  });
});
