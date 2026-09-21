import { describe, expect, it } from 'vitest';
import { type BarInput, type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.1);
const mixBars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.3,
  high: c + 1.5,
  low: c - 1.5,
  close: c,
  volume: 1000 + ((i * 37) % 500),
}));
// A clean up-trend with steady volume → OBV climbs monotonically.
const upBars: BarInput[] = Array.from({ length: 60 }, (_, i) => {
  const c = 100 + i;
  return { open: c - 0.3, high: c + 1, low: c - 1, close: c, volume: 1000 };
});

describe('Archer OBV', () => {
  it('exposes OBV plus its fast/slow EMAs and run signals', () => {
    const a = ta.archerObv(mixBars, { fast: 4, slow: 12, runLength: 2 }).at(-1)!;
    expect(a.obv).toBeCloseTo(ta.obv(mixBars, {}).at(-1)!, 9);
    expect([0, 1]).toContain(a.long);
    expect([0, 1]).toContain(a.short);
    expect(a.long + a.short).toBeLessThanOrEqual(1); // can't be both rising and falling
  });
  it('flags a long run on a sustained OBV up-trend', () => {
    const a = ta.archerObv(upBars, { fast: 4, slow: 12 }).at(-1)!;
    expect(a.long).toBe(1);
    expect(a.short).toBe(0);
  });
});

describe('Market Facilitation Index', () => {
  it('is (high − low) / volume (closed form), NaN when volume is 0', () => {
    const bars: BarInput[] = [
      { high: 12, low: 8, close: 10, volume: 4 },
      { high: 11, low: 10, close: 10, volume: 0 },
    ];
    const out = ta.marketFacilitationIndex(bars, {});
    expect(out[0]!).toBeCloseTo(1, 9); // (12−8)/4
    expect(out[1]!).toBeNaN(); // volume 0 → undefined
  });
});

describe('Price · Volume', () => {
  it('unsigned is close × volume (closed form)', () => {
    const bars: BarInput[] = [
      { high: 1, low: 1, close: 10, volume: 5 },
      { high: 1, low: 1, close: 12, volume: 5 },
      { high: 1, low: 1, close: 11, volume: 5 },
    ];
    expect(ta.priceVolume(bars, {})).toEqual([50, 60, 55]);
  });
  it('signed multiplies by the close-to-close direction (warmup 1)', () => {
    const bars: BarInput[] = [
      { high: 1, low: 1, close: 10, volume: 5 },
      { high: 1, low: 1, close: 12, volume: 5 }, // up → +60
      { high: 1, low: 1, close: 11, volume: 5 }, // down → −55
    ];
    expect(ta.priceVolume(bars, { signed: true })).toEqual([NaN, 60, -55]);
  });
});

describe('Price Volume Rank', () => {
  it('ranks the four price/volume direction combinations (closed form)', () => {
    const c = [10, 11, 12, 11, 10];
    const v = [100, 150, 120, 200, 90];
    const bars: BarInput[] = c.map((close, i) => ({
      high: close,
      low: close,
      close,
      volume: v[i]!,
    }));
    // b1 up/up→1, b2 up/down→2, b3 down/up→3, b4 down/down→4
    expect(ta.priceVolumeRank(bars, {})).toEqual([NaN, 1, 2, 3, 4]);
  });
});

describe('Volume Oscillator', () => {
  it('is 0 when volume is constant (fast EMA = slow EMA)', () => {
    const bars: BarInput[] = Array.from({ length: 40 }, (_, i) => ({
      high: 1,
      low: 1,
      close: 100 + i,
      volume: 1000,
    }));
    expect(ta.volumeOscillator(bars, { fast: 5, slow: 10 }).at(-1)!).toBeCloseTo(0, 9);
  });
  it('is positive when volume is rising (fast EMA leads)', () => {
    const bars: BarInput[] = Array.from({ length: 40 }, (_, i) => ({
      high: 1,
      low: 1,
      close: 100,
      volume: 1000 + i * 50,
    }));
    expect(ta.volumeOscillator(bars, { fast: 5, slow: 10 }).at(-1)!).toBeGreaterThan(0);
  });
});

describe('Williams Accumulation/Distribution', () => {
  it('accumulates close − true-low/high on up/down days (closed form)', () => {
    const bars: BarInput[] = [
      { high: 12, low: 8, close: 10 },
      { high: 13, low: 9, close: 12 }, // up: +(12 − min(9,10)) = +3
      { high: 11, low: 7, close: 8 }, // down: +(8 − max(11,12)) = −4
    ];
    expect(ta.williamsAd(bars, {})).toEqual([0, 3, -1]);
  });
});

describe('volume aliases', () => {
  it('efi/emv/kvo equal their canonical indicators', () => {
    expect(ta.efi(mixBars, { period: 13 })).toEqual(ta.forceIndex(mixBars, { period: 13 }));
    expect(ta.emv(mixBars, { period: 14 })).toEqual(ta.easeOfMovement(mixBars, { period: 14 }));
    expect(ta.kvo(mixBars, {})).toEqual(ta.klinger(mixBars, {}));
  });
});

describe('volume-ext streaming parity', () => {
  it('bar indicators match their streams', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['archerObv', { fast: 4, slow: 12, runLength: 2 }],
      ['marketFacilitationIndex', {}],
      ['priceVolume', { signed: true }],
      ['priceVolumeRank', {}],
      ['volumeOscillator', { fast: 5, slow: 10 }],
      ['williamsAd', {}],
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
});

describe('volume-ext snapshots round-trip', () => {
  it('Archer OBV, Williams AD and signed Price·Volume restore mid-stream', () => {
    for (const [name, parameters] of [
      ['archerObv', { fast: 4, slow: 12, runLength: 2 }],
      ['williamsAd', {}],
      ['priceVolume', { signed: true }],
    ] as const) {
      const ind = ta[name] as Indicator<Record<string, unknown>, BarInput, unknown>;
      const ref = ind.stream(parameters);
      const expected = mixBars.map((b) => ref.next(b));
      const part = ind.stream(parameters);
      for (let i = 0; i < 50; i++) part.next(mixBars[i]!);
      const restored = ind.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
      for (let i = 50; i < mixBars.length; i++) {
        expect(restored.next(mixBars[i]!), name).toEqual(expected[i]);
      }
    }
  });
});
