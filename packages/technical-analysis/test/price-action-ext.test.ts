import { describe, expect, it } from 'vitest';
import { type BarInput, type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 4) * 9 + i * 0.15);
const mixBars: BarInput[] = closes.map((c, i) => {
  const open = i === 0 ? c : closes[i - 1]!;
  return {
    open,
    high: Math.max(open, c) + 1 + (i % 5) * 0.4,
    low: Math.min(open, c) - 1 - (i % 4) * 0.5,
    close: c,
    volume: 1000 + ((i * 31) % 300),
  };
});

describe('Fair Value Gaps', () => {
  it('detects a bullish 3-bar imbalance (closed form)', () => {
    // low[i] > high[i−2]: gap zone [high0, low2] = [10, 11]
    const bars: BarInput[] = [
      { high: 10, low: 8, close: 9 },
      { high: 14, low: 11, close: 13 },
      { high: 15, low: 11, close: 14 },
    ];
    const out = ta.fairValueGaps(bars, {});
    expect(out[0]!.direction).toBeNaN(); // warmup
    expect(out[1]!.direction).toBeNaN();
    expect(out[2]).toEqual({ direction: 1, top: 11, bottom: 10, mid: 10.5 });
  });
  it('detects a bearish imbalance (closed form)', () => {
    // high[i] < low[i−2]: gap zone [high2, low0] = [11, 12]
    const bars: BarInput[] = [
      { high: 15, low: 12, close: 13 },
      { high: 11, low: 8, close: 9 },
      { high: 11, low: 6, close: 7 },
    ];
    expect(ta.fairValueGaps(bars, {})[2]).toEqual({
      direction: -1,
      top: 12,
      bottom: 11,
      mid: 11.5,
    });
  });
  it('minimumGapPercent filters gaps smaller than the threshold', () => {
    const bars: BarInput[] = [
      { high: 100, low: 99, close: 99.5 },
      { high: 101, low: 100.2, close: 100.8 },
      { high: 101, low: 100.05, close: 100.5 },
    ];
    // gap [100, 100.05] ≈ 0.05% of mid — below a 1% floor
    expect(ta.fairValueGaps(bars, { minimumGapPercent: 1 })[2]!.direction).toBe(0);
    expect(ta.fairValueGaps(bars, {})[2]!.direction).toBe(1);
  });
});

describe('Order Blocks', () => {
  it('flags a bullish OB at the last down candle before an up-break (closed form)', () => {
    const bars: BarInput[] = [
      { open: 12, high: 13, low: 10, close: 11 }, // bearish → bullish-OB origin
      { open: 11, high: 16, low: 11, close: 15 }, // close 15 > origin high 13 → break
    ];
    const out = ta.orderBlocks(bars, { lookback: 5 });
    expect(out[0]!.direction).toBe(0); // no event yet (warmup 0)
    expect(out[1]).toEqual({ direction: 1, top: 13, bottom: 10, mid: 11.5 });
  });
  it('flags a bearish OB at the last up candle before a down-break (closed form)', () => {
    const bars: BarInput[] = [
      { open: 10, high: 13, low: 9, close: 12 }, // bullish → bearish-OB origin
      { open: 11, high: 11, low: 6, close: 7 }, // close 7 < origin low 9 → break
    ];
    expect(ta.orderBlocks(bars, { lookback: 5 })[1]).toEqual({
      direction: -1,
      top: 13,
      bottom: 9,
      mid: 11,
    });
  });
  it('does not flag once the origin is older than lookback', () => {
    const bars: BarInput[] = [
      { open: 12, high: 13, low: 10, close: 11 }, // down origin at index 0
      { open: 11, high: 12, low: 10.5, close: 11.5 }, // small bars that never break 13...
      { open: 11.5, high: 12, low: 11, close: 11.8 },
      { open: 11.8, high: 16, low: 11, close: 15 }, // break at index 3, but lookback 2 → too old
    ];
    expect(ta.orderBlocks(bars, { lookback: 2 })[3]!.direction).toBe(0);
  });
});

describe('Liquidity Sweeps', () => {
  it('flags a buy-side sweep: prior high taken then rejected (closed form)', () => {
    const bars: BarInput[] = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
      { high: 10, low: 8, close: 9 },
      { high: 13, low: 9, close: 10 }, // high 13 > window high 11, close 10 < 11 → sweep
    ];
    const out = ta.liquiditySweeps(bars, { lookback: 3 });
    expect(out[0]!.direction).toBeNaN(); // warmup
    expect(out[2]!.direction).toBeNaN();
    expect(out[3]).toEqual({ direction: 1, level: 11 });
  });
  it('flags a sell-side sweep: prior low taken then rejected (closed form)', () => {
    const bars: BarInput[] = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 7, close: 9 },
      { high: 10, low: 8, close: 9 },
      { high: 10, low: 5, close: 9 }, // low 5 < window low 7, close 9 > 7 → sweep
    ];
    expect(ta.liquiditySweeps(bars, { lookback: 3 })[3]).toEqual({ direction: -1, level: 7 });
  });
  it('no sweep when price closes through the level (a real breakout)', () => {
    const bars: BarInput[] = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
      { high: 10, low: 8, close: 9 },
      { high: 13, low: 9, close: 12.5 }, // high 13 > 11 but close 12.5 > 11 → breakout, not sweep
    ];
    expect(ta.liquiditySweeps(bars, { lookback: 3 })[3]!.direction).toBe(0);
  });
});

describe('price-action-ext streaming parity & snapshots', () => {
  it('detectors match their streams', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['fairValueGaps', {}],
      ['orderBlocks', { lookback: 5 }],
      ['liquiditySweeps', { lookback: 20 }],
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
  it('orderBlocks and liquiditySweeps restore mid-stream', () => {
    for (const [name, parameters] of [
      ['orderBlocks', { lookback: 5 }],
      ['liquiditySweeps', { lookback: 20 }],
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
  it('produces real events on a realistic series (not all neutral)', () => {
    const fvgEvents = ta.fairValueGaps(mixBars, {}).filter((r) => r.direction !== 0).length;
    const sweepEvents = ta
      .liquiditySweeps(mixBars, { lookback: 20 })
      .filter((r) => r.direction !== 0).length;
    expect(fvgEvents + sweepEvents).toBeGreaterThan(0);
  });
});
