import { describe, expect, it } from 'vitest';
import { type BarInput, type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import {
  MovingAverageRibbonStream,
  RainbowMovingAverageStream,
} from '@totalfinance/technical-analysis/overlap';
import { T3Stream } from '@totalfinance/technical-analysis/moving-averages';

const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 6) * 8 + i * 0.1);
const bars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.3,
  high: c + 1.5,
  low: c - 1.5,
  close: c,
  volume: 1000 + (i % 7) * 100,
}));

describe('weighted moving averages', () => {
  const flat = Array.from({ length: 60 }, () => 50);
  it('windowed/cascade MAs of a constant series equal that constant exactly', () => {
    for (const name of ['fwma', 'sineWma', 'pascalWma', 'symmetricWma'] as const) {
      const out = (ta[name] as Indicator<{ period?: number }, number, number>)(flat, {
        period: 10,
      });
      expect(out.at(-1)!, name).toBeCloseTo(50, 6);
    }
    // rainbowMovingAverage cascades 10 SMAs (period 2 default) → warms ~Σ(period−1)·levels bars
    expect(ta.rainbowMovingAverage(flat, {}).at(-1)!).toBeCloseTo(50, 6);
  });
  it('recursive MAs (JMA, Holt-Winters) converge to a constant', () => {
    const longFlat = Array.from({ length: 300 }, () => 50);
    expect(ta.jma(longFlat, { period: 10 }).at(-1)!).toBeCloseTo(50, 4);
    expect(ta.holtWinterMovingAverage(longFlat, {}).at(-1)!).toBeCloseTo(50, 4);
  });
  it('fwma weights recent values more (closer to a ramp end than SMA)', () => {
    const ramp = Array.from({ length: 30 }, (_, i) => i);
    const last = ramp.at(-1)!;
    const fwmaLast = ta.fwma(ramp, { period: 10 }).at(-1)!;
    const smaLast = ta.sma(ramp, { period: 10 }).at(-1)!;
    expect(Math.abs(fwmaLast - last)).toBeLessThan(Math.abs(smaLast - last));
  });
  it('Pascal WMA on period 4 uses binomial weights [1,3,3,1]', () => {
    // (1*1 + 2*3 + 3*3 + 4*1)/8 = (1+6+9+4)/8 = 2.5
    expect(ta.pascalWma([1, 2, 3, 4], { period: 4 }).at(-1)!).toBeCloseTo(20 / 8, 12);
  });
  it('symmetricWma is the triangular MA', () => {
    expect(ta.symmetricWma([1, 2, 3], { period: 3 })).toEqual(ta.trima([1, 2, 3], { period: 3 }));
  });
});

describe('JMA & Holt-Winters', () => {
  it('JMA tracks a ramp (low lag) and accepts phase/power; rejects out-of-range phase', () => {
    const ramp = Array.from({ length: 80 }, (_, i) => i);
    const last = ta.jma(ramp, { period: 10 }).at(-1)!;
    // a smoother lags a ramp; JMA's lag is small — within a few points of the endpoint (79)
    expect(last).toBeGreaterThan(74);
    expect(last).toBeLessThanOrEqual(79 + 1e-9);
    expect(ta.jma(closes, { period: 10, phase: 50, power: 2 })).toHaveLength(closes.length);
    expect(() => ta.jma(closes, { period: 10, phase: 200 })).toThrowError(/phase/);
  });
  it('Holt-Winters MA tracks a linear trend', () => {
    const ramp = Array.from({ length: 60 }, (_, i) => 10 + 2 * i);
    expect(ta.holtWinterMovingAverage(ramp, {}).at(-1)!).toBeCloseTo(10 + 2 * 59, 0);
  });
});

describe('Rainbow MA & MA ribbon', () => {
  it('rainbowMovingAverage averages the cascaded SMAs', () => {
    expect(
      Number.isFinite(ta.rainbowMovingAverage(closes, { period: 2, levels: 10 }).at(-1)!),
    ).toBe(true);
  });
  it('movingAverageRibbon returns one MA per requested period, longest-first warmup', () => {
    const r = ta.movingAverageRibbon.explain(closes, { periods: [5, 10, 20] });
    const last = r.value.at(-1)!;
    expect(last).toHaveLength(3);
    expect(last[0]!).toBeCloseTo(ta.sma(closes, { period: 5 }).at(-1)!, 12);
    expect(last[2]!).toBeCloseTo(ta.sma(closes, { period: 20 }).at(-1)!, 12);
    expect(r.diagnostics.warmup).toBe(19); // gated by the longest period
  });
  it('bounds eager parallel-stream allocation and rejects empty ribbons', () => {
    expect(() => ta.rainbowMovingAverage.stream({ period: 2, levels: 1_025 })).toThrowError(
      /1,024/,
    );
    expect(() => ta.movingAverageRibbon.stream({ periods: [] })).toThrowError(/periods\.length/);
    expect(() =>
      ta.movingAverageRibbon.stream({ periods: Array.from({ length: 1_025 }, () => 2) }),
    ).toThrowError(/1,024/);

    const periods = Array.from({ length: 1_025 }, () => 2);
    Object.defineProperty(periods, 0, {
      get: () => {
        throw new Error('period element was touched before the cardinality cap');
      },
    });
    expect(() => ta.movingAverageRibbon.stream({ periods })).toThrowError(/1,024/);
  });
});

describe('Gann HiLo & VWAP overlays', () => {
  it('Gann HiLo activator flips trend and tracks the SMA of lows/highs', () => {
    const up = bars.slice(0, 60);
    const g = ta.gannHighLowActivator(up, { period: 3 }).at(-1)!;
    expect([1, -1]).toContain(g.trend);
    expect(Number.isFinite(g.value)).toBe(true);
  });
  it('VWAP bands straddle the VWAP', () => {
    const v = ta.vwapBands(bars, { multiplier: 2 }).at(-1)!;
    expect(v.upper).toBeGreaterThanOrEqual(v.vwap);
    expect(v.lower).toBeLessThanOrEqual(v.vwap);
    // VWAP matches the cumulative VWAP
    expect(v.vwap).toBeCloseTo(ta.vwap(bars, {}).at(-1)!, 9);
  });
  it('session VWAP resets every N bars', () => {
    const sv = ta.sessionVwap(bars, { resetEvery: 20 });
    // at a reset boundary the session VWAP equals that bar's typical price
    const i = 20;
    const tp = (bars[i]!.high + bars[i]!.low + bars[i]!.close) / 3;
    expect(sv[i]!).toBeCloseTo(tp, 9);
  });
  it('rolling-anchored VWAP reports a sane anchor within the lookback', () => {
    const r = ta.rollingAnchoredVwap.explain(bars, { lookback: 30, anchor: 'low' }).value.at(-1)!;
    expect(r.anchorBarsAgo).toBeGreaterThanOrEqual(0);
    expect(r.anchorBarsAgo).toBeLessThan(30);
    expect(Number.isFinite(r.vwap)).toBe(true);
  });
});

describe('price-source aliases', () => {
  it('hl2/hlc3/ohlc4/wcp equal their canonical transforms; zlma === zlema', () => {
    expect(ta.hl2(bars, {})).toEqual(ta.medianPrice(bars, {}));
    expect(ta.hlc3(bars, {})).toEqual(ta.typicalPrice(bars, {}));
    expect(ta.ohlc4(bars, {})).toEqual(ta.averagePrice(bars, {}));
    expect(ta.wcp(bars, {})).toEqual(ta.weightedClose(bars, {}));
    expect(ta.zlma(closes, { period: 10 })).toEqual(ta.zlema(closes, { period: 10 }));
  });
});

describe('overlap-ext streaming parity & snapshots', () => {
  it('series MAs match their streams', () => {
    for (const name of [
      'fwma',
      'sineWma',
      'pascalWma',
      'jma',
      'holtWinterMovingAverage',
      'rainbowMovingAverage',
    ] as const) {
      const ind = ta[name] as Indicator<object, number, number>;
      // holtWinterMovingAverage is smoothing-parameterized (levelSmoothing/trendSmoothing/accelerationSmoothing), not period-parameterized (Law 12).
      const parameters =
        name === 'holtWinterMovingAverage'
          ? { levelSmoothing: 0.3, trendSmoothing: 0.2, accelerationSmoothing: 0.1 }
          : { period: 10 };
      const batch = ind.explain(closes, parameters);
      const stream = ind.stream(parameters);
      for (let i = 0; i < closes.length; i++) {
        const e = stream.next(closes[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e as number, name).toBeCloseTo(batch.value[i] as number, 9);
      }
    }
  });
  it('bar overlays match their streams', () => {
    for (const [name, parameters] of [
      ['gannHighLowActivator', { period: 3 }],
      ['vwapBands', { multiplier: 2 }],
      ['sessionVwap', { resetEvery: 20 }],
      ['rollingAnchoredVwap', { lookback: 30 }],
    ] as const) {
      const batch = ta[name].explain(bars, parameters as never);
      const stream = ta[name].stream(parameters as never);
      for (let i = 0; i < bars.length; i++) {
        const e = stream.next(bars[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e, name).toEqual(batch.value[i]);
      }
    }
  });
  it('snapshot round-trips JMA and the MA ribbon', () => {
    const refJ = ta.jma.stream({ period: 10 });
    const expJ = closes.map((c) => refJ.next(c));
    const partJ = ta.jma.stream({ period: 10 });
    for (let i = 0; i < 60; i++) partJ.next(closes[i]!);
    const restoredJ = ta.jma.fromJSON(JSON.parse(JSON.stringify(partJ.toJSON())));
    for (let i = 60; i < closes.length; i++) {
      expect(restoredJ.next(closes[i]!) as number).toBeCloseTo(expJ[i] as number, 9);
    }
    const refR = ta.movingAverageRibbon.stream({ periods: [5, 10, 20] });
    const expR = closes.map((c) => refR.next(c));
    const partR = ta.movingAverageRibbon.stream({ periods: [5, 10, 20] });
    for (let i = 0; i < 40; i++) partR.next(closes[i]!);
    const restoredR = ta.movingAverageRibbon.fromJSON(JSON.parse(JSON.stringify(partR.toJSON())));
    for (let i = 40; i < closes.length; i++) {
      const got = restoredR.next(closes[i]!);
      if (expR[i] === null) expect(got).toBeNull();
      else expect(got).toEqual(expR[i]);
    }
  });
  it('rejects malformed or allocation-sized nested-stream snapshot arrays before restoring', () => {
    const ribbon = ta.movingAverageRibbon.stream({ periods: [5, 10] }).toJSON() as unknown as {
      state: { smas: unknown[] };
    };
    ribbon.state.smas = [];
    expect(() => MovingAverageRibbonStream.fromJSON(ribbon as never)).toThrowError(/at least 1/);

    const rainbow = ta.rainbowMovingAverage
      .stream({ period: 2, levels: 1 })
      .toJSON() as unknown as {
      state: { smas: unknown[] };
    };
    rainbow.state.smas = Array.from({ length: 1_025 }, () => rainbow.state.smas[0]);
    Object.defineProperty(rainbow.state.smas, 0, {
      get: () => {
        throw new Error('snapshot child was touched before the cardinality cap');
      },
    });
    expect(() => RainbowMovingAverageStream.fromJSON(rainbow as never)).toThrowError(
      /at most 1,024/,
    );

    const t3 = ta.t3.stream({ period: 5 }).toJSON() as unknown as {
      state: { e: unknown[] };
    };
    t3.state.e.pop();
    expect(() => T3Stream.fromJSON(t3 as never)).toThrowError(/exactly 6/);
  });
});
