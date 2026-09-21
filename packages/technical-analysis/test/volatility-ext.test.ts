import { describe, expect, it } from 'vitest';
import { type BarInput, type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const mixCloses = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.1);
const mixBars: BarInput[] = mixCloses.map((c, i) => ({
  open: c - 0.3,
  high: c + 1.5,
  low: c - 1.5,
  close: c,
  volume: 1000 + (i % 7) * 100,
}));
const trendBars: BarInput[] = Array.from({ length: 80 }, (_, i) => {
  const c = 100 + i * 0.8;
  return { open: c - 0.3, high: c + 1.5, low: c - 1.5, close: c, volume: 1000 };
});
const downBars: BarInput[] = Array.from({ length: 80 }, (_, i) => {
  const c = 200 - i * 0.8;
  return { open: c + 0.3, high: c + 1.5, low: c - 1.5, close: c, volume: 1000 };
});

describe('Aberration', () => {
  it('bands are ATR-symmetric around the SMA-of-HLC3 zero line', () => {
    const a = ta.aberration(mixBars, { period: 5, atrPeriod: 15 }).at(-1)!;
    expect(a.upperBand - a.zeroLine).toBeCloseTo(a.atr, 9);
    expect(a.zeroLine - a.lowerBand).toBeCloseTo(a.atr, 9);
    expect(a.upperBand).toBeGreaterThan(a.lowerBand);
  });
});

describe('Acceleration Bands', () => {
  it('on a constant bar, bands are the closed-form factors (closed form)', () => {
    // bar {high:110, low:90, close:100}, mult 4 → ratio = 4·20/200 = 0.4
    const bars: BarInput[] = Array.from({ length: 8 }, () => ({ high: 110, low: 90, close: 100 }));
    const out = ta.accelerationBands(bars, { period: 5, multiplier: 4 }).at(-1)!;
    expect(out.upper).toBeCloseTo(110 * 1.4, 9); // 154
    expect(out.middle).toBeCloseTo(100, 9);
    expect(out.lower).toBeCloseTo(90 * 0.6, 9); // 54
  });
  it('upper ≥ middle ≥ lower on real bars', () => {
    const out = ta.accelerationBands(mixBars, { period: 20 }).at(-1)!;
    expect(out.upper).toBeGreaterThanOrEqual(out.middle);
    expect(out.middle).toBeGreaterThanOrEqual(out.lower);
  });
});

describe('Holt-Winters Channel', () => {
  it('first bar seeds at the price with zero width', () => {
    const out = ta.holtWinterChannel.explain([50, 51, 52], {});
    expect(out.diagnostics.warmup).toBe(0);
    expect(out.value[0]).toEqual({ upper: 50, middle: 50, lower: 50 });
  });
  it('converges to a constant with a vanishing channel on a flat series', () => {
    const flat = Array.from({ length: 200 }, () => 50);
    const out = ta.holtWinterChannel(flat, {}).at(-1)!;
    expect(out.middle).toBeCloseTo(50, 6);
    expect(out.upper - out.lower).toBeCloseTo(0, 4);
  });
  it('upper ≥ middle ≥ lower on a real series', () => {
    const out = ta.holtWinterChannel(mixCloses, {}).at(-1)!;
    expect(out.upper).toBeGreaterThanOrEqual(out.middle);
    expect(out.middle).toBeGreaterThanOrEqual(out.lower);
  });
});

describe('Mass Index', () => {
  it('equals the summation window when the range is constant (ratio → 1)', () => {
    // high − low = 4 on every bar → ema1 = ema2 = 4 → ratio = 1 → sum of 25 ones = 25
    const bars: BarInput[] = mixCloses.map((c) => ({ high: c + 2, low: c - 2, close: c }));
    expect(ta.massIndex(bars, { fast: 9, slow: 25 }).at(-1)!).toBeCloseTo(25, 9);
  });
});

describe('Price Distance', () => {
  it('2·(H−L) + |open − previousClose| − |close − open| (closed form)', () => {
    const bars: BarInput[] = [
      { open: 10, high: 12, low: 8, close: 11 },
      { open: 11, high: 15, low: 9, close: 14 },
    ];
    const out = ta.priceDistance(bars, {});
    expect(out[0]).toBeNaN(); // warmup (needs the prior close)
    // 2·(15−9) + |11−11| − |14−11| = 12 + 0 − 3 = 9
    expect(out[1]!).toBeCloseTo(9, 9);
  });
});

describe("Elder's Market Thermometer", () => {
  it('thermo = max(|prevLow−low|, |high−prevHigh|); period-1 EMA makes ma = thermo', () => {
    const bars: BarInput[] = [
      { high: 12, low: 8, close: 10 },
      { high: 15, low: 9, close: 14 }, // thermoL=|8−9|=1, thermoH=|15−12|=3 → 3
      { high: 16, low: 12, close: 15 }, // thermoL=|9−12|=3, thermoH=|16−15|=1 → 3
    ];
    const out = ta.elderThermometer(bars, { period: 1, long: 2, short: 0.5 });
    expect(out[0]!.thermo).toBeNaN(); // seed bar → NaN-filled
    expect(out[1]!.thermo).toBe(3);
    expect(out[1]!.movingAverage).toBeCloseTo(3, 9); // period-1 EMA tracks instantly
    expect(out[1]!.long).toBe(1); // 3 < 3·2
    expect(out[1]!.short).toBe(1); // 3 > 3·0.5
  });
});

describe('Ulcer Index', () => {
  it('is 0 on a monotonic up-trend (no drawdown) and positive on a decline', () => {
    const up = Array.from({ length: 40 }, (_, i) => 10 + i);
    expect(ta.ulcerIndex(up, { period: 14 }).at(-1)!).toBeCloseTo(0, 9);
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);
    expect(ta.ulcerIndex(down, { period: 14 }).at(-1)!).toBeGreaterThan(0);
  });
});

describe('ATR Bands', () => {
  it('SMA-centred, ATR-symmetric bands', () => {
    const out = ta.atrBands(mixBars, { period: 14, multiplier: 2 }).at(-1)!;
    const mid = ta.sma(mixCloses, { period: 14 }).at(-1)!;
    const atr = ta.atr(mixBars, { period: 14 }).at(-1)!;
    expect(out.middle).toBeCloseTo(mid, 9);
    expect(out.upper - out.middle).toBeCloseTo(2 * atr, 9);
    expect(out.middle - out.lower).toBeCloseTo(2 * atr, 9);
  });
});

describe('Percent ATR', () => {
  it('is 100·ATR/close', () => {
    const out = ta.percentAtr(mixBars, { period: 14 }).at(-1)!;
    const atr = ta.atr(mixBars, { period: 14 }).at(-1)!;
    expect(out).toBeCloseTo((100 * atr) / mixBars.at(-1)!.close, 9);
  });
});

describe('Volatility Stop', () => {
  it('trends +1 with the stop below price on an up-trend, −1 above on a down-trend', () => {
    const up = ta.volatilityStop(trendBars, { period: 20, multiplier: 2 }).at(-1)!;
    expect(up.trend).toBe(1);
    expect(up.stop).toBeLessThan(trendBars.at(-1)!.close);
    const down = ta.volatilityStop(downBars, { period: 20, multiplier: 2 }).at(-1)!;
    expect(down.trend).toBe(-1);
    expect(down.stop).toBeGreaterThan(downBars.at(-1)!.close);
  });
});

describe('volatility-ext streaming parity', () => {
  it('bar indicators match their streams', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['aberration', { period: 5, atrPeriod: 15 }],
      ['accelerationBands', { period: 20, multiplier: 4 }],
      ['massIndex', { fast: 9, slow: 25 }],
      ['priceDistance', {}],
      ['elderThermometer', { period: 20 }],
      ['atrBands', { period: 14, multiplier: 2 }],
      ['percentAtr', { period: 14 }],
      ['volatilityStop', { period: 20, multiplier: 2 }],
    ];
    for (const [name, parameters] of cases) {
      const ind = ta[name as keyof typeof ta] as Indicator<
        Record<string, unknown>,
        BarInput,
        unknown
      >;
      const batch = ind.explain(mixBars, parameters);
      const stream = ind.stream(parameters);
      for (let i = 0; i < mixBars.length; i++) {
        const e = stream.next(mixBars[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e, name).toEqual(batch.value[i]);
      }
    }
  });
  it('series indicators (holtWinterChannel, ulcerIndex) match their streams', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['holtWinterChannel', { scalar: 1 }],
      ['ulcerIndex', { period: 14 }],
    ];
    for (const [name, parameters] of cases) {
      const ind = ta[name as keyof typeof ta] as Indicator<
        Record<string, unknown>,
        number,
        unknown
      >;
      const batch = ind.explain(mixCloses, parameters);
      const stream = ind.stream(parameters);
      for (let i = 0; i < mixCloses.length; i++) {
        const e = stream.next(mixCloses[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e, name).toEqual(batch.value[i]);
      }
    }
  });
});

describe('volatility-ext snapshots round-trip', () => {
  it('Volatility Stop and Mass Index restore mid-stream', () => {
    for (const [name, parameters] of [
      ['volatilityStop', { period: 20, multiplier: 2 }],
      ['massIndex', { fast: 9, slow: 25 }],
    ] as const) {
      const ind = ta[name] as Indicator<Record<string, unknown>, BarInput, unknown>;
      const ref = ind.stream(parameters);
      const expected = mixBars.map((b) => ref.next(b));
      const part = ind.stream(parameters);
      for (let i = 0; i < 60; i++) part.next(mixBars[i]!);
      const restored = ind.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
      for (let i = 60; i < mixBars.length; i++) {
        expect(restored.next(mixBars[i]!), name).toEqual(expected[i]);
      }
    }
  });
  it('Holt-Winters Channel restores mid-stream', () => {
    const ref = ta.holtWinterChannel.stream({});
    const expected = mixCloses.map((c) => ref.next(c));
    const part = ta.holtWinterChannel.stream({});
    for (let i = 0; i < 60; i++) part.next(mixCloses[i]!);
    const restored = ta.holtWinterChannel.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
    for (let i = 60; i < mixCloses.length; i++) {
      expect(restored.next(mixCloses[i]!)).toEqual(expected[i]);
    }
  });
});
