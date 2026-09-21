import { describe, expect, it } from 'vitest';
import {
  type BarInput,
  candlestickNames,
  candlesticks,
  detectCandles,
} from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

/**
 * Twelve quiet bars (~1.0 range, ~0.4 body) so the candle averages have a sensible non-zero scale to
 * measure "long body", "short body", "long shadow" etc. against.
 */
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

describe('catalog integrity', () => {
  it('exposes the full TA-Lib catalog (~61 patterns), each a working indicator', () => {
    expect(candlestickNames.length).toBeGreaterThanOrEqual(61);
    for (const name of candlestickNames) {
      const ind = candlesticks[name]!;
      const out = ind(lead(), {});
      expect(out).toHaveLength(12);
      // every emitted value is one of −100 / 0 / 100 (or NaN during warmup)
      for (const x of out) {
        if (!Number.isNaN(x)) expect([-100, 0, 100]).toContain(x);
      }
    }
  });

  it('NaN during warmup (need length + 10 bars), defined thereafter', () => {
    const r = candlesticks['doji']!.explain(lead(), {});
    expect(r.diagnostics.warmup).toBe(10); // single-bar pattern + 10-bar average window
    expect(r.value[0]).toBeNaN();
    expect(Number.isNaN(r.value[10]!)).toBe(false);
  });
});

describe('single-bar shapes', () => {
  it('Doji fires on a tiny body with a wide range', () => {
    const bars = [...lead(), { open: 50, high: 53, low: 47, close: 50.01, volume: 100 }];
    expect(candlesticks['doji']!(bars, {}).at(-1)!).toBe(100);
  });
  it('Dragonfly vs Gravestone doji are signed by shadow side', () => {
    const dragon = [...lead(), { open: 50, high: 50.05, low: 47, close: 50.02, volume: 100 }];
    expect(candlesticks['dragonflyDoji']!(dragon, {}).at(-1)!).toBe(100);
    const grave = [...lead(), { open: 50, high: 53, low: 49.97, close: 49.99, volume: 100 }];
    expect(candlesticks['gravestoneDoji']!(grave, {}).at(-1)!).toBe(-100);
  });
  it('white Marubozu is +100, black Marubozu −100', () => {
    const white = [...lead(), { open: 48, high: 52, low: 48, close: 52, volume: 100 }];
    expect(candlesticks['marubozu']!(white, {}).at(-1)!).toBe(100);
    const black = [...lead(), { open: 52, high: 52, low: 48, close: 48, volume: 100 }];
    expect(candlesticks['marubozu']!(black, {}).at(-1)!).toBe(-100);
  });
  it('Hammer is +100; Shooting Star is −100', () => {
    // small body at the top, long lower shadow, negligible upper shadow
    const hammer = [...lead(), { open: 50.35, high: 50.45, low: 49, close: 50.4, volume: 100 }];
    expect(candlesticks['hammer']!(hammer, {}).at(-1)!).toBe(100);
    // small body at the bottom, long upper shadow, negligible lower shadow
    const star = [...lead(), { open: 49.8, high: 53, low: 49.78, close: 50, volume: 100 }];
    expect(candlesticks['shootingStar']!(star, {}).at(-1)!).toBe(-100);
  });
});

describe('two-bar reversals', () => {
  it('bullish Engulfing is +100, bearish −100', () => {
    const bull = [
      ...lead(),
      { open: 50, high: 50.2, low: 48, close: 48.2, volume: 100 },
      { open: 48, high: 50.5, low: 47.9, close: 50.4, volume: 100 },
    ];
    expect(candlesticks['engulfing']!(bull, {}).at(-1)!).toBe(100);
    const bear = [
      ...lead(),
      { open: 48, high: 50.2, low: 47.9, close: 50, volume: 100 },
      { open: 50.2, high: 50.4, low: 47.8, close: 47.9, volume: 100 },
    ];
    expect(candlesticks['engulfing']!(bear, {}).at(-1)!).toBe(-100);
  });
  it('Piercing line is +100', () => {
    const bars = [
      ...lead(),
      { open: 52, high: 52.2, low: 47.8, close: 48, volume: 100 }, // long black
      { open: 47.5, high: 50.5, low: 47.4, close: 50.3, volume: 100 }, // opens below low, closes above mid (50)
    ];
    expect(candlesticks['piercing']!(bars, {}).at(-1)!).toBe(100);
  });
});

describe('three-bar stars', () => {
  it('Morning Star is +100, Evening Star −100', () => {
    const morning = [
      ...lead(),
      { open: 53, high: 53.2, low: 48.8, close: 49, volume: 100 }, // long black
      { open: 48.5, high: 48.7, low: 48.2, close: 48.4, volume: 100 }, // small body, gaps below
      { open: 49, high: 52, low: 48.9, close: 51.8, volume: 100 }, // long white closing above midpoint
    ];
    expect(candlesticks['morningStar']!(morning, {}).at(-1)!).toBe(100);
    const evening = [
      ...lead(),
      { open: 48, high: 52.2, low: 47.8, close: 52, volume: 100 }, // long white
      { open: 52.5, high: 52.8, low: 52.3, close: 52.6, volume: 100 }, // small body, gaps above
      { open: 52, high: 52.1, low: 48, close: 48.2, volume: 100 }, // long black below midpoint
    ];
    expect(candlesticks['eveningStar']!(evening, {}).at(-1)!).toBe(-100);
  });
  it('Three White Soldiers is +100, Three Black Crows −100', () => {
    const soldiers = [
      ...lead(),
      { open: 48, high: 50.1, low: 47.9, close: 50, volume: 100 },
      { open: 49, high: 51.1, low: 48.9, close: 51, volume: 100 },
      { open: 50, high: 52.1, low: 49.9, close: 52, volume: 100 },
    ];
    expect(candlesticks['threeWhiteSoldiers']!(soldiers, {}).at(-1)!).toBe(100);
    const crows = [
      ...lead(),
      { open: 52, high: 52.1, low: 49.9, close: 50, volume: 100 },
      { open: 51, high: 51.1, low: 48.9, close: 49, volume: 100 },
      { open: 50, high: 50.1, low: 47.9, close: 48, volume: 100 },
    ];
    expect(candlesticks['threeBlackCrows']!(crows, {}).at(-1)!).toBe(-100);
  });
});

describe('detectCandles convenience', () => {
  it('reports matched patterns per bar', () => {
    const bars = [...lead(), { open: 50, high: 53, low: 47, close: 50.01, volume: 100 }];
    const matches = detectCandles(bars);
    expect(matches.at(-1)!.some((m) => m.pattern === 'doji' && m.signal === 100)).toBe(true);
    // quiet lead bars produce no matches
    expect(matches[5]).toEqual([]);
  });
});

describe('engine streaming parity & serialization (whole catalog)', () => {
  const bars: BarInput[] = Array.from({ length: 60 }, (_, i) => {
    const base = 50 + Math.sin(i / 3) * 4;
    const up = i % 2 === 0;
    return {
      open: up ? base - 1 : base + 1,
      high: base + 2,
      low: base - 2,
      close: up ? base + 1 : base - 1,
      volume: 100,
    };
  });
  it('every pattern stream reproduces its batch output', () => {
    for (const name of candlestickNames) {
      const ind = candlesticks[name]!;
      const batch = ind.explain(bars, {});
      const stream = ind.stream({});
      for (let i = 0; i < bars.length; i++) {
        const e = stream.next(bars[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e, name).toBe(batch.value[i]);
      }
    }
  });
  it('snapshot round-trips an engulfing stream', () => {
    const ind = candlesticks['engulfing']!;
    const ref = ind.stream({});
    const expected = bars.map((b) => ref.next(b));
    const part = ind.stream({});
    for (let i = 0; i < 30; i++) part.next(bars[i]!);
    const restored = ind.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
    for (let i = 30; i < bars.length; i++) expect(restored.next(bars[i]!)).toBe(expected[i]);
  });
  it('is reachable through the ta namespace', () => {
    expect(typeof ta.candlesticks['doji']).toBe('function');
    expect(ta.candlestickNames.length).toBe(candlestickNames.length);
  });
});
