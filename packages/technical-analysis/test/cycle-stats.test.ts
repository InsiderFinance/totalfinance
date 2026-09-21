import { describe, expect, it } from 'vitest';
import { type BarInput, type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { pairs } from '@totalfinance/technical-analysis/statistics';

const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 10 + i * 0.05);
const bars: BarInput[] = closes.map((c, i) => ({
  open: c - 0.3,
  high: c + 1.5,
  low: c - 1.5,
  close: c,
  volume: 100 + (i % 5) * 10,
}));

describe('Hilbert-transform cycle family', () => {
  it('htDcPeriod is finite after warmup and settles into [6, 50] once stabilized', () => {
    const dc = ta.htDcPeriod.explain(closes, {});
    for (let i = dc.diagnostics.warmup; i < closes.length; i++)
      expect(Number.isFinite(dc.value[i]!)).toBe(true);
    // SmoothPeriod ramps from 0 over the unstable period; bound it once stabilized (~40 bars)
    for (let i = 40; i < closes.length; i++) {
      expect(dc.value[i]!).toBeGreaterThanOrEqual(6 - 1e-9);
      expect(dc.value[i]!).toBeLessThanOrEqual(50 + 1e-9);
    }
    expect(Number.isFinite(ta.htTrendline(closes, {}).at(-1)!)).toBe(true);
  });
  it('htSine components are bounded in [-1, 1]; htTrendMode is 0 or 1', () => {
    for (const p of ta.htSine(closes, {})) {
      if (!Number.isNaN(p.sine)) {
        expect(Math.abs(p.sine)).toBeLessThanOrEqual(1 + 1e-12);
        expect(Math.abs(p.leadSine)).toBeLessThanOrEqual(1 + 1e-12);
      }
    }
    for (const m of ta.htTrendMode(closes, {})) {
      if (!Number.isNaN(m)) expect([0, 1]).toContain(m);
    }
  });
  it('htPhasor exposes inPhase & quadrature and matches batch≡stream', () => {
    const batch = ta.htPhasor.explain(closes, {});
    const stream = ta.htPhasor.stream({});
    for (let i = 0; i < closes.length; i++) {
      const e = stream.next(closes[i]!);
      if (i < batch.diagnostics.warmup) expect(e).toBeNull();
      else expect(e).toEqual(batch.value[i]);
    }
  });
  it('scalar HT streams match batch and round-trip a snapshot', () => {
    for (const name of ['htDcPeriod', 'htDcPhase', 'htTrendline', 'htTrendMode'] as const) {
      const ind = ta[name];
      const batch = ind.explain(closes, {});
      const stream = ind.stream({});
      for (let i = 0; i < closes.length; i++) {
        const e = stream.next(closes[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e as number, name).toBeCloseTo(batch.value[i] as number, 9);
      }
    }
    const ref = ta.htDcPeriod.stream({});
    const expected = closes.map((c) => ref.next(c));
    const part = ta.htDcPeriod.stream({});
    for (let i = 0; i < 60; i++) part.next(closes[i]!);
    const restored = ta.htDcPeriod.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
    for (let i = 60; i < closes.length; i++) {
      const got = restored.next(closes[i]!);
      if (expected[i] === null) expect(got).toBeNull();
      else expect(got as number).toBeCloseTo(expected[i] as number, 9);
    }
  });
});

describe('overlap / operators', () => {
  it('ma dispatches to the named MA', () => {
    const i = closes.length - 1;
    expect(ta.movingAverage(closes, { period: 10, movingAverageType: 'ema' })[i]!).toBeCloseTo(
      ta.ema(closes, { period: 10 })[i]!,
      12,
    );
    expect(ta.movingAverage(closes, { period: 10, movingAverageType: 'wma' })[i]!).toBeCloseTo(
      ta.wma(closes, { period: 10 })[i]!,
      12,
    );
    // default is SMA
    expect(ta.movingAverage(closes, { period: 10 })[i]!).toBeCloseTo(
      ta.sma(closes, { period: 10 })[i]!,
      12,
    );
  });
  it('mavp selects the per-bar period MA', () => {
    const periods = closes.map(() => 5);
    const out = ta.mavp({ series: closes, periods, parameters: { movingAverageType: 'sma' } });
    const sma5 = ta.sma(closes, { period: 5 });
    const i = closes.length - 1;
    expect(out[i]!).toBeCloseTo(sma5[i]!, 12);
  });
  it('midpoint / midprice match their definitions', () => {
    expect(ta.midpoint([1, 2, 3, 4, 5], { period: 3 }).at(-1)!).toBe(4); // (5+3)/2
    const r = ta.midprice(bars, { period: 10 }).at(-1)!;
    const hh = Math.max(...bars.slice(-10).map((b) => b.high));
    const ll = Math.min(...bars.slice(-10).map((b) => b.low));
    expect(r).toBeCloseTo((hh + ll) / 2, 12);
  });
  it('bop ∈ [-1, 1]; stochFast equals stochastic', () => {
    for (const v of ta.bop(bars, {})) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
    const fast = ta.stochFast(bars, { kPeriod: 5, dPeriod: 3 });
    const stoch = ta.stochastic(bars, { kPeriod: 5, dPeriod: 3 });
    expect(fast).toEqual(stoch);
  });
});

describe('statistics — beta / correl', () => {
  it('beta of a series against itself is 1', () => {
    const p = pairs(closes, closes);
    expect(ta.beta(p, { period: 20 }).at(-1)!).toBeCloseTo(1, 9);
  });
  it('correl is +1 for identical series and −1 for mirrored', () => {
    expect(ta.correl(pairs(closes, closes), { period: 20 }).at(-1)!).toBeCloseTo(1, 9);
    const mirror = closes.map((c) => 500 - c);
    expect(ta.correl(pairs(closes, mirror), { period: 20 }).at(-1)!).toBeCloseTo(-1, 9);
  });
});

describe('rolling operators', () => {
  const xs = [1, 2, 3, 4, 5];
  it('rollingMin/Max/Sum are exact', () => {
    expect(ta.rollingMin(xs, { period: 3 }).at(-1)!).toBe(3);
    expect(ta.rollingMax(xs, { period: 3 }).at(-1)!).toBe(5);
    expect(ta.rollingSum(xs, { period: 3 }).at(-1)!).toBe(12);
  });
  it('rollingMin/MaxIndex report bars-ago of the window extreme', () => {
    // window [3,4,5]: min=3 is 2 bars ago, max=5 is 0 bars ago
    expect(ta.rollingMinIndex(xs, { period: 3 }).at(-1)!).toBe(2);
    expect(ta.rollingMaxIndex(xs, { period: 3 }).at(-1)!).toBe(0);
  });
  it('rollingMinMax / rollingMinMaxIndex combine both', () => {
    expect(ta.rollingMinMax(xs, { period: 3 }).at(-1)!).toEqual({ min: 3, max: 5 });
    expect(ta.rollingMinMaxIndex(xs, { period: 3 }).at(-1)!).toEqual({ minIndex: 2, maxIndex: 0 });
  });
  it('streaming parity for the scalar operators', () => {
    for (const name of ['rollingMin', 'rollingMax', 'rollingSum', 'midpoint'] as const) {
      const ind = ta[name] as Indicator<{ period: number }, number, number>;
      const batch = ind.explain(closes, { period: 8 });
      const stream = ind.stream({ period: 8 });
      for (let i = 0; i < closes.length; i++) {
        const e = stream.next(closes[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e as number, name).toBeCloseTo(batch.value[i] as number, 12);
      }
    }
  });
});
