import { describe, expect, it } from 'vitest';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

describe('moving averages (golden)', () => {
  it('SMA aligns output with NaN warmup', () => {
    const r = ta.sma.explain([1, 2, 3, 4, 5], { period: 3 });
    expect(r.diagnostics.warmup).toBe(2);
    expect(r.value[0]).toBeNaN();
    expect(r.value.slice(2)).toEqual([2, 3, 4]);
  });

  it('EMA seeds with the SMA of the first period', () => {
    expect(ta.ema([1, 2, 3, 4, 5], { period: 3 })).toEqual([NaN, NaN, 2, 3, 4]);
  });

  it('WMA weights recent values more', () => {
    expect(ta.wma([1, 2, 3], { period: 3 })[2]).toBeCloseTo(14 / 6, 12);
  });
});

describe('RSI (Wilder, canonical example)', () => {
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
    46.28,
  ];

  it('first value ≈ 70.46', () => {
    const r = ta.rsi.explain(closes, { period: 14 });
    expect(r.diagnostics.warmup).toBe(14);
    expect(r.value[14]).toBeCloseTo(70.46, 1);
  });

  it('is 100 for a strictly rising series and 0 for a strictly falling one', () => {
    expect(ta.rsi([1, 2, 3, 4, 5, 6], { period: 3 }).at(-1)).toBe(100);
    expect(ta.rsi([6, 5, 4, 3, 2, 1], { period: 3 }).at(-1)).toBe(0);
  });

  it('stays within [0, 100]', () => {
    const noisy = [10, 11, 9, 12, 8, 13, 7, 14, 6, 15, 5, 16];
    for (const v of ta.rsi(noisy, { period: 4 })) {
      if (!Number.isNaN(v)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('MACD', () => {
  it('histogram equals macd − signal after warmup', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const r = ta.macd.explain(closes, { fast: 12, slow: 26, signal: 9 });
    const last = r.value.at(-1)!;
    expect(last.histogram).toBeCloseTo(last.macd - last.signal, 12);
    expect(Number.isNaN(r.value[0]!.macd)).toBe(true);
  });
});

describe('Bollinger Bands', () => {
  it('middle is the SMA; bands are symmetric', () => {
    const closes = [10, 12, 11, 13, 12, 14, 13, 15];
    const r = ta.bbands(closes, { period: 5, standardDeviation: 2 });
    const p = r.at(-1)!;
    expect(p.middle).toBeCloseTo(ta.sma(closes, { period: 5 }).at(-1)!, 12);
    expect(p.upper - p.middle).toBeCloseTo(p.middle - p.lower, 12);
  });
});

const bars: BarInput[] = [
  { high: 10, low: 8, close: 9, volume: 100 },
  { high: 11, low: 9, close: 10.5, volume: 150 },
  { high: 12, low: 10, close: 11, volume: 120 },
  { high: 11.5, low: 9.5, close: 10, volume: 200 },
  { high: 13, low: 11, close: 12.5, volume: 180 },
  { high: 14, low: 12, close: 13.5, volume: 220 },
  { high: 13, low: 11.5, close: 12, volume: 160 },
];

describe('bar indicators', () => {
  it('ATR is positive after warmup', () => {
    const r = ta.atr.explain(bars, { period: 3 });
    expect(r.value.at(-1)!).toBeGreaterThan(0);
    expect(r.value[0]).toBeNaN();
  });

  it('Stochastic %K and %D are within [0, 100]', () => {
    const r = ta.stochastic(bars, { kPeriod: 3, dPeriod: 2 });
    for (const p of r) {
      if (!Number.isNaN(p.k)) {
        expect(p.k).toBeGreaterThanOrEqual(0);
        expect(p.k).toBeLessThanOrEqual(100);
        expect(p.d).toBeGreaterThanOrEqual(0);
        expect(p.d).toBeLessThanOrEqual(100);
      }
    }
  });

  it('ADX and DI are within [0, 100]', () => {
    const many: BarInput[] = Array.from({ length: 40 }, (_, i) => ({
      high: 100 + i + 1,
      low: 100 + i - 1,
      close: 100 + i,
    }));
    const r = ta.adx(many, { period: 5 });
    const last = r.at(-1)!;
    expect(last.adx).toBeGreaterThanOrEqual(0);
    expect(last.adx).toBeLessThanOrEqual(100);
    // a clean uptrend → +DI dominates −DI
    expect(last.plusDI).toBeGreaterThan(last.minusDI);
  });

  it('VWAP equals cumulative typical-price-weighted average', () => {
    const r = ta.vwap(bars, {});
    const tp0 = (10 + 8 + 9) / 3;
    expect(r[0]).toBeCloseTo(tp0, 12); // first bar VWAP = its typical price
  });

  it('OBV accumulates signed volume', () => {
    const r = ta.obv(bars, {});
    // bar0: 0; bar1 close up → +150; bar2 up → +120 → 270; bar3 down → -200 → 70
    expect(r[0]).toBe(0);
    expect(r[1]).toBe(150);
    expect(r[2]).toBe(270);
    expect(r[3]).toBe(70);
  });
});

describe('returns & rolling volatility', () => {
  it('returns match simple returns', () => {
    expect(ta.returns([100, 110, 99], {})).toEqual([
      NaN,
      expect.closeTo(0.1, 12),
      expect.closeTo(-0.1, 12),
    ]);
  });
  it('rolling volatility is non-negative', () => {
    const closes = [100, 101, 99, 102, 98, 103, 97];
    for (const v of ta.rollingVolatility(closes, { period: 3, annualization: 1 })) {
      if (!Number.isNaN(v)) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});
