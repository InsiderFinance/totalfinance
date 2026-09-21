import { describe, expect, it } from 'vitest';
import {
  type BarInput,
  fibExtension,
  fibRetracement,
  gapFill,
  gaps,
  orbRetest,
  previousSessionLevels,
} from '@totalfinance/technical-analysis';

describe('fibRetracement', () => {
  it('retraces an up-move: price(r) = end + (start − end)·r (closed form)', () => {
    const out = fibRetracement(100, 110); // up-move 100 → 110
    expect(out).toHaveLength(7); // default 0…1 ladder
    const at = (r: number) => out.find((l) => l.ratio === r)!.price;
    expect(at(0)).toBeCloseTo(110, 9); // 0% line at the extreme
    expect(at(1)).toBeCloseTo(100, 9); // 100% back to the origin
    expect(at(0.5)).toBeCloseTo(105, 9);
    expect(at(0.382)).toBeCloseTo(106.18, 9);
  });
  it('is direction-agnostic (down-move retraces upward)', () => {
    const out = fibRetracement(110, 100); // down-move 110 → 100
    expect(out.find((l) => l.ratio === 0.5)!.price).toBeCloseTo(105, 9);
    expect(out.find((l) => l.ratio === 1)!.price).toBeCloseTo(110, 9);
  });
  it('accepts custom levels and rejects non-finite anchors', () => {
    expect(fibRetracement(0, 10, [0.5])).toEqual([{ ratio: 0.5, price: 5 }]);
    expect(() => fibRetracement(NaN, 10)).toThrowError(/start/);
  });
});

describe('fibExtension', () => {
  it('projects the a→b move from c: price(r) = c + (b − a)·r (closed form)', () => {
    const out = fibExtension({ start: 100, end: 110, projectFrom: 104 }); // AB = 10, projected from C = 104
    const at = (r: number) => out.find((l) => l.ratio === r)!.price;
    expect(at(1)).toBeCloseTo(114, 9); // 100% extension
    expect(at(1.618)).toBeCloseTo(120.18, 9);
    expect(at(0)).toBeCloseTo(104, 9);
  });
});

describe('previousSessionLevels', () => {
  it('aligns each bar to the prior completed session high/low/close', () => {
    const bars: BarInput[] = [
      { high: 10, low: 8, close: 9 },
      { high: 12, low: 9, close: 11 }, // session 0 → high 12, low 8, close 11
      { high: 13, low: 10, close: 12 },
      { high: 14, low: 11, close: 13 }, // session 1 → high 14, low 10, close 13
      { high: 15, low: 12, close: 14 }, // session 2
    ];
    const out = previousSessionLevels(bars, [0, 0, 1, 1, 2]);
    // H19: a first session has no prior session — structural absence is null, never three NaNs
    // (the C10 warm-up allowance covers declared warm-up positions, not missing structure).
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toEqual({ high: 12, low: 8, close: 11 }); // prior = session 0
    expect(out[3]).toEqual({ high: 12, low: 8, close: 11 });
    expect(out[4]).toEqual({ high: 14, low: 10, close: 13 }); // prior = session 1
  });
  it('throws on a length mismatch', () => {
    expect(() => previousSessionLevels([{ high: 1, low: 1, close: 1 }], [0, 1])).toThrowError(
      /length/,
    );
  });
});

describe('orbRetest', () => {
  it('flags a pullback to the broken opening-range high (closed form)', () => {
    const bars: BarInput[] = [
      { high: 10, low: 9, close: 9.5 },
      { high: 11, low: 9, close: 10 }, // OR (periods 2): high 11, low 9
      { high: 12, low: 10.5, close: 11.5 }, // close > 11 → arm up
      { high: 11.5, low: 10.8, close: 11.2 }, // low 10.8 ≤ 11 → retest
      { high: 11.3, low: 11.05, close: 11.1 }, // low 11.05 > 11 → no retest
    ];
    const out = orbRetest(bars, { periods: 2 });
    expect(out[0]).toBeNaN(); // opening-range bars
    expect(out[1]).toBeNaN();
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1);
    expect(out[4]).toBe(0);
  });
});

describe('gapFill', () => {
  it('shares its event universe with gaps() — the sibling contract', () => {
    // gapFill used to fire on ANY open that differed from the prior close, which on a real tape is
    // essentially every bar: on the 500-bar walk below, gaps() found 0 events and gapFill found 499.
    // A sibling pair that shares an options type, a unit, and a docstring must detect the same events.
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const bars: BarInput[] = [];
    let price = 100;
    for (let i = 0; i < 500; i++) {
      const open = price * (1 + (rand() - 0.5) * 0.004); // drifts off the close, rarely leaves the range
      const close = open * (1 + (rand() - 0.5) * 0.02);
      bars.push({
        open,
        high: Math.max(open, close) * 1.004,
        low: Math.min(open, close) * 0.996,
        close,
      });
      price = close;
    }
    // Inject three unmistakable gaps so the assertion is about agreement, not about both being empty.
    for (const i of [100, 250, 400]) {
      bars[i]!.open = bars[i - 1]!.high * 1.03;
      bars[i]!.high = Math.max(bars[i]!.high, bars[i]!.open * 1.005);
    }
    const detected = gaps(bars, { minSizeFraction: 0 }).gaps;
    const filled = gapFill(bars, { minSizeFraction: 0 }).events;
    expect(detected.length).toBeGreaterThanOrEqual(3);
    expect(filled.map((e) => e.index)).toEqual(detected.map((g) => g.index));
    expect(filled.map((e) => e.direction)).toEqual(detected.map((g) => g.direction));
    filled.forEach((event, i) => {
      expect(event.sizeFraction).toBeCloseTo(detected[i]!.sizeFraction, 12);
    });
  });

  it('rejects a negative size floor instead of matching every gap', () => {
    const bars: BarInput[] = [
      { high: 10, low: 9, close: 10, open: 9.5 },
      { high: 14, low: 12, close: 13, open: 12 },
    ];
    for (const call of [
      () => gaps(bars, { minSizeFraction: -0.5 }),
      () => gapFill(bars, { minSizeFraction: -0.5 }),
    ]) {
      expect(call).toThrowError(/minSizeFraction/);
    }
  });

  it('detects a gap-up and the bar that fills it (closed form)', () => {
    const bars: BarInput[] = [
      { high: 10, low: 9, close: 10, open: 9.5 },
      { high: 13, low: 11.5, close: 12, open: 11.5 }, // open 11.5 > prior close 10 → gap up
      { high: 12, low: 9, close: 9.5, open: 12 }, // open == prior close (no new gap); low 9 ≤ 10 fills
    ];
    const out = gapFill(bars).events;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      index: 1,
      direction: 1,
      gapFrom: 10,
      gapTo: 11.5,
      filled: true,
      fillIndex: 2,
    });
    expect(out[0]!.sizeFraction).toBeCloseTo(0.15, 9);
  });
  it('reports an unfilled gap and respects minSizeFraction', () => {
    const bars: BarInput[] = [
      { high: 10, low: 9, close: 10, open: 9.5 },
      { high: 14, low: 12, close: 13, open: 12 }, // gap up to 12, never returns to 10
    ];
    const out = gapFill(bars).events;
    expect(out[0]!.filled).toBe(false);
    expect(out[0]!.fillIndex).toBe(-1);
    // a 20% gap is filtered out by a 50% floor
    expect(gapFill(bars, { minSizeFraction: 0.5 }).events).toEqual([]);
  });
  it('detects a gap-down', () => {
    const bars: BarInput[] = [
      { high: 10, low: 9, close: 10, open: 9.5 },
      { high: 9, low: 7, close: 8, open: 8.5 }, // open 8.5 < prior close 10 → gap down
    ];
    const out = gapFill(bars).events;
    expect(out[0]).toMatchObject({ index: 1, direction: -1, gapFrom: 8.5, gapTo: 10 });
  });
});
