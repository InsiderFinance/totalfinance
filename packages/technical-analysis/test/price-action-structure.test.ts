import { describe, expect, it } from 'vitest';
import { type BarInput, type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

// A series with genuine swings (sine pullbacks on an uptrend) for the structure tools.
const upCloses = Array.from({ length: 120 }, (_, i) => 100 + i * 0.6 + Math.sin(i / 3) * 5);
const downCloses = Array.from({ length: 120 }, (_, i) => 200 - i * 0.6 + Math.sin(i / 3) * 5);
const toBars = (cs: number[]): BarInput[] =>
  cs.map((c, i) => {
    const open = i === 0 ? c : cs[i - 1]!;
    return {
      open,
      high: Math.max(open, c) + 1 + (i % 4) * 0.3,
      low: Math.min(open, c) - 1 - (i % 3) * 0.3,
      close: c,
      volume: 1000 + ((i * 17) % 200),
    };
  });
const upBars = toBars(upCloses);
const downBars = toBars(downCloses);
const mixBars = toBars(Array.from({ length: 140 }, (_, i) => 100 + Math.sin(i / 4) * 12 + i * 0.1));

describe('ATR trailing stop', () => {
  it('trends +1 below price on an up-trend, −1 above on a down-trend', () => {
    const up = ta.atrTrailingStop(upBars, { period: 14, multiplier: 3 }).at(-1)!;
    expect(up.trend).toBe(1);
    expect(up.stop).toBeLessThan(upBars.at(-1)!.close);
    const down = ta.atrTrailingStop(downBars, { period: 14, multiplier: 3 }).at(-1)!;
    expect(down.trend).toBe(-1);
    expect(down.stop).toBeGreaterThan(downBars.at(-1)!.close);
  });
  it('the stop only ratchets within a leg (never loosens while long)', () => {
    const out = ta.atrTrailingStop(upBars, { period: 14, multiplier: 3 });
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      // while continuously long, the stop is non-decreasing
      if (a.trend === 1 && b.trend === 1) expect(b.stop).toBeGreaterThanOrEqual(a.stop - 1e-9);
    }
  });
});

describe('swing trailing stop', () => {
  it('trails the swing low (long) below price on an up-trend', () => {
    const r = ta.swingTrailingStop(upBars, { strength: 2 }).at(-1)!;
    expect(r.trend).toBe(1);
    expect(r.stop).toBeLessThan(upBars.at(-1)!.close);
  });
  it('warms up only once both a swing high and low are confirmed', () => {
    const ex = ta.swingTrailingStop.explain(upBars, { strength: 2 });
    expect(ex.diagnostics.warmup).toBeGreaterThanOrEqual(2); // needs ≥1 confirmed swing of each side
    expect(Number.isFinite(ex.value[ex.diagnostics.warmup]!.stop)).toBe(true);
  });
});

describe('equal highs / equal lows', () => {
  it('detects two near-equal swing highs within tolerance (closed form)', () => {
    // swing highs at bar 2 (14) and bar 6 (14.01); lows flat so no swing lows interfere
    const highs = [10, 11, 14, 11, 10, 11, 14.01, 11, 10];
    const bars: BarInput[] = highs.map((h) => ({ high: h, low: 5, close: 9, open: 9 }));
    const out = ta.equalHighs(bars, { strength: 2, tolerance: 0.001 });
    expect(out[0]!.detected).toBeNaN(); // warmup (2·strength)
    expect(out[4]).toEqual({ detected: 0, level: null, count: 0 }); // first swing high, nothing to match
    expect(out[8]!.detected).toBe(1); // |14.01−14| ≤ 0.001·14
    expect(out[8]!.count).toBe(2);
    expect(out[8]!.level).toBeCloseTo(14.005, 6);
  });
  it('does not flag swing highs outside tolerance', () => {
    const highs = [10, 11, 14, 11, 10, 11, 15, 11, 10]; // 15 vs 14 → 7% apart
    const bars: BarInput[] = highs.map((h) => ({ high: h, low: 5, close: 9, open: 9 }));
    expect(ta.equalHighs(bars, { strength: 2, tolerance: 0.001 })[8]!.detected).toBe(0);
  });
  it('equalLows is symmetric on swing lows', () => {
    const lows = [10, 9, 6, 9, 10, 9, 6.005, 9, 10];
    const bars: BarInput[] = lows.map((l) => ({ high: 20, low: l, close: 11, open: 11 }));
    const out = ta.equalLows(bars, { strength: 2, tolerance: 0.001 });
    expect(out[8]!.detected).toBe(1);
    expect(out[8]!.count).toBe(2);
    expect(out[8]!.level).toBeCloseTo(6.0025, 6);
  });
});

describe('price-action structure parity & snapshots', () => {
  it('streaming detectors match their streams', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['atrTrailingStop', { period: 14, multiplier: 3 }],
      ['swingTrailingStop', { strength: 2 }],
      ['equalHighs', { strength: 2, tolerance: 0.002 }],
      ['equalLows', { strength: 2, tolerance: 0.002 }],
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
  it('snapshots round-trip mid-stream', () => {
    for (const [name, parameters] of [
      ['atrTrailingStop', { period: 14, multiplier: 3 }],
      ['swingTrailingStop', { strength: 2 }],
      ['equalHighs', { strength: 2, tolerance: 0.002 }],
    ] as const) {
      const ind = ta[name] as Indicator<Record<string, unknown>, BarInput, unknown>;
      const ref = ind.stream(parameters);
      const expected = mixBars.map((b) => ref.next(b));
      const part = ind.stream(parameters);
      for (let i = 0; i < 70; i++) part.next(mixBars[i]!);
      const restored = ind.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
      for (let i = 70; i < mixBars.length; i++) {
        expect(restored.next(mixBars[i]!), name).toEqual(expected[i]);
      }
    }
  });
});
