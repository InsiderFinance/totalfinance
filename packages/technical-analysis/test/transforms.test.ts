import { describe, expect, it } from 'vitest';
import { type BarInput } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { bar } from '@totalfinance/technical-analysis/transforms';

const bars: BarInput[] = [
  { open: 10, high: 12, low: 9, close: 11, volume: 100 },
  { open: 11, high: 13, low: 10.5, close: 10.8, volume: 120 },
  { open: 10.8, high: 11.2, low: 9.8, close: 10, volume: 90 },
  { open: 10, high: 10.5, low: 8.5, close: 9, volume: 200 },
];

describe('price transforms', () => {
  it('typical / median / weighted / average price match their formulas', () => {
    const b = bars[0]!;
    expect(ta.typicalPrice([b], {})[0]).toBeCloseTo((12 + 9 + 11) / 3, 12);
    expect(ta.medianPrice([b], {})[0]).toBeCloseTo((12 + 9) / 2, 12);
    expect(ta.weightedClose([b], {})[0]).toBeCloseTo((12 + 9 + 2 * 11) / 4, 12);
    expect(ta.averagePrice([b], {})[0]).toBeCloseTo((10 + 12 + 9 + 11) / 4, 12);
  });

  it('emits from the first bar (warmup 0)', () => {
    expect(ta.typicalPrice.explain(bars, {}).diagnostics.warmup).toBe(0);
  });

  it('open falls back to close when absent', () => {
    const hlc: BarInput = { high: 12, low: 9, close: 11 };
    // average price with open=close=11 → (11+12+9+11)/4
    expect(ta.averagePrice([hlc], {})[0]).toBeCloseTo((11 + 12 + 9 + 11) / 4, 12);
  });
});

describe('candle geometry', () => {
  it('real body is signed (close − open)', () => {
    expect(ta.realBody([bars[0]!], {})[0]).toBeCloseTo(1, 12); // 11 − 10
    expect(ta.realBody([bars[2]!], {})[0]).toBeCloseTo(-0.8, 12); // 10 − 10.8
  });
  it('shadows and range are non-negative and consistent', () => {
    const b = bars[1]!; // open 11, high 13, low 10.5, close 10.8
    expect(ta.upperShadow([b], {})[0]).toBeCloseTo(13 - 11, 12); // high − max(open, close)
    expect(ta.lowerShadow([b], {})[0]).toBeCloseTo(10.8 - 10.5, 12); // min(open, close) − low
    expect(ta.candleRange([b], {})[0]).toBeCloseTo(13 - 10.5, 12);
    // range = body + upper + lower shadows
    expect(Math.abs(bar.body(b)) + bar.upperShadow(b) + bar.lowerShadow(b)).toBeCloseTo(
      bar.range(b),
      12,
    );
  });
});

describe('true range & gap', () => {
  it('true range first bar is high − low, then includes prior close', () => {
    const r = ta.trueRange.explain(bars, {});
    expect(r.diagnostics.warmup).toBe(0);
    expect(r.value[0]).toBeCloseTo(12 - 9, 12);
    // bar1: max(13−10.5, |13−11|, |10.5−11|) = max(2.5, 2, 0.5) = 2.5
    expect(r.value[1]).toBeCloseTo(2.5, 12);
  });

  it('gap is open minus prior close (warmup 1)', () => {
    const r = ta.gap.explain(bars, {});
    expect(r.diagnostics.warmup).toBe(1);
    expect(r.value[0]).toBeNaN();
    expect(r.value[1]).toBeCloseTo(11 - 11, 12); // open1 − close0
    expect(r.value[3]).toBeCloseTo(10 - 10, 12); // open3 − close2
  });
});

describe('Heikin-Ashi', () => {
  it('first HA open is (open+close)/2 and HA close is the OHLC average', () => {
    const r = ta.heikinAshi(bars, {});
    expect(r[0]!.open).toBeCloseTo((10 + 11) / 2, 12);
    expect(r[0]!.close).toBeCloseTo((10 + 12 + 9 + 11) / 4, 12);
    // HA high/low envelope the HA body and the raw extreme
    expect(r[1]!.high).toBeGreaterThanOrEqual(Math.max(r[1]!.open, r[1]!.close));
    expect(r[1]!.low).toBeLessThanOrEqual(Math.min(r[1]!.open, r[1]!.close));
  });
});

describe('log returns', () => {
  it('match ln(p_t / p_{t-1})', () => {
    const r = ta.logReturns.explain([100, 110, 99], {});
    expect(r.diagnostics.warmup).toBe(1);
    expect(r.value[1]).toBeCloseTo(Math.log(110 / 100), 12);
    expect(r.value[2]).toBeCloseTo(Math.log(99 / 110), 12);
  });
});

describe('transforms streaming parity', () => {
  it('batch equals stream for typicalPrice / trueRange / gap / heikinAshi', () => {
    for (const name of ['typicalPrice', 'trueRange', 'gap'] as const) {
      const batch = ta[name].explain(bars, {});
      const stream = ta[name].stream({});
      for (let i = 0; i < bars.length; i++) {
        const emitted = stream.next(bars[i]!);
        if (i < batch.diagnostics.warmup) expect(emitted).toBeNull();
        else expect(emitted).toBeCloseTo(batch.value[i]!, 12);
      }
    }
    const haBatch = ta.heikinAshi.explain(bars, {});
    const haStream = ta.heikinAshi.stream({});
    for (let i = 0; i < bars.length; i++) {
      expect(haStream.next(bars[i]!)).toEqual(haBatch.value[i]);
    }
  });

  it('round-trips a snapshot (trueRange)', () => {
    const ref = ta.trueRange.stream({});
    const expected = bars.map((b) => ref.next(b));
    const part = ta.trueRange.stream({});
    part.next(bars[0]!);
    part.next(bars[1]!);
    const restored = ta.trueRange.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
    for (let i = 2; i < bars.length; i++) expect(restored.next(bars[i]!)).toBe(expected[i]);
  });
});
