import { describe, expect, it } from 'vitest';
import { type BarInput, type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';
import { type Pair, pairs } from '@totalfinance/technical-analysis/statistics';

// A trending leg followed by a choppy/mean-reverting leg.
const trendCloses = Array.from({ length: 80 }, (_, i) => 100 + i * 0.8);
const choppyCloses = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 1.5) * 6);
const mixCloses = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 8 + i * 0.1);
const toBars = (cs: number[]): BarInput[] =>
  cs.map((c, i) => ({
    open: c - 0.3,
    high: c + 1.5,
    low: c - 1.5,
    close: c,
    volume: 1000 + (i % 7) * 100,
  }));
const trendBars = toBars(trendCloses);
const choppyBars = toBars(choppyCloses);
const mixBars = toBars(mixCloses);

describe('Choppiness Index', () => {
  it('is low on a trend and higher on a choppy/range-bound market', () => {
    const trend = ta.choppinessIndex(trendBars, { period: 14 }).at(-1)!;
    const choppy = ta.choppinessIndex(choppyBars, { period: 14 }).at(-1)!;
    expect(Number.isFinite(trend)).toBe(true);
    expect(trend).toBeLessThan(choppy);
    expect(trend).toBeLessThan(50);
  });
  it('rejects period < 2 (log10(1) = 0 would divide by zero)', () => {
    expect(() => ta.choppinessIndex(trendBars, { period: 1 })).toThrowError(/period/);
  });
});

describe('Chande Kroll Stop', () => {
  it('long stop sits at/above the short stop and both are finite', () => {
    const c = ta.chandeKrollStop(trendBars, { atrPeriod: 10, multiplier: 1, period: 9 }).at(-1)!;
    expect(Number.isFinite(c.long)).toBe(true);
    expect(Number.isFinite(c.short)).toBe(true);
    expect(c.long).toBeGreaterThanOrEqual(c.short);
  });
  it('warmup waits for the ATR + both lookback stages', () => {
    const r = ta.chandeKrollStop.explain(trendBars, { atrPeriod: 10, period: 9 });
    expect(r.diagnostics.warmup).toBeGreaterThanOrEqual(10);
    expect(r.diagnostics.warmup).toBeLessThan(30);
  });
});

describe('Central Pivot Range', () => {
  it('computes pivot / tc / bc from the prior bar (closed form)', () => {
    const bars: BarInput[] = [
      { high: 120, low: 90, close: 100 },
      { high: 130, low: 100, close: 110 },
    ];
    const out = ta.centralPivotRange.explain(bars, {});
    expect(out.value[0]!.pivot).toBeNaN(); // first bar has no prior → NaN-filled
    expect(out.diagnostics.warmup).toBe(1);
    const cpr = out.value[1]!;
    // prior bar: pivot=(120+90+100)/3=103.333…, bc=(120+90)/2=105, tc=2*pivot−bc=101.666…
    expect(cpr.pivot).toBeCloseTo((120 + 90 + 100) / 3, 9);
    expect(cpr.bottomCentral).toBeCloseTo(105, 9);
    expect(cpr.topCentral).toBeCloseTo((2 * (120 + 90 + 100)) / 3 - 105, 9);
  });
});

describe('decay lines', () => {
  it('linearDecay falls no faster than 1/period and follows price up (closed form)', () => {
    // step = 1/5 = 0.2
    expect(ta.linearDecay([10, 5, 5, 20], { period: 5 })).toEqual([10, 9.8, 5, 20]);
  });
  it('exponentialDecay uses an exp(−period) step (decays slowly)', () => {
    const out = ta.exponentialDecay([10, 5, 5, 20], { period: 5 });
    expect(out[0]!).toBe(10);
    expect(out[1]!).toBeCloseTo(10 - Math.exp(-5), 12); // 9.99326…
    expect(out[2]!).toBe(5);
    expect(out[3]!).toBe(20);
  });
});

describe('increasing / decreasing', () => {
  it('non-strict compares the endpoints `period` bars apart', () => {
    expect(ta.increasing([1, 3, 2, 5], { period: 1 })).toEqual([NaN, 1, 0, 1]);
    expect(ta.decreasing([3, 2, 1], { period: 1 })).toEqual([NaN, 1, 1]);
  });
  it('strict requires every step to move the same way', () => {
    expect(ta.increasing([1, 2, 3], { period: 2, strict: true })).toEqual([NaN, NaN, 1]);
    expect(ta.increasing([1, 2, 1], { period: 2, strict: true })).toEqual([NaN, NaN, 0]);
  });
});

describe('long-run / short-run (two-series)', () => {
  const fast = [1, 2, 3, 4, 3, 2, 1];
  const slow = [1, 1.5, 2, 2.5, 2.4, 2.0, 1.6];
  it('longRun fires while both fast and slow rise; shortRun while both fall', () => {
    const lr = ta.longRun(pairs(fast, slow), { period: 2 });
    const sr = ta.shortRun(pairs(fast, slow), { period: 2 });
    // i2: fast 3>1 & slow 2>1 → long
    expect(lr[2]).toBe(1);
    // i6: fast 1<3 & slow 1.6<2.4 → short
    expect(sr[6]).toBe(1);
    expect(lr[6]).toBe(0);
  });
});

describe('PMax (MA-based Supertrend)', () => {
  it('reports +1 on an uptrend (stop below) and −1 on a downtrend (stop above)', () => {
    const up = ta.pMax(trendBars, { period: 10, multiplier: 3 }).at(-1)!;
    expect(up.trend).toBe(1);
    expect(up.pmax).toBeLessThan(trendBars.at(-1)!.close);
    const downBars = toBars(trendCloses.map((_, i) => 200 - i * 0.8));
    const down = ta.pMax(downBars, { period: 10, multiplier: 3 }).at(-1)!;
    expect(down.trend).toBe(-1);
    expect(down.pmax).toBeGreaterThan(downBars.at(-1)!.close);
  });
});

describe('Q Stick', () => {
  it('is the SMA of (close − open) (closed form)', () => {
    const bars: BarInput[] = [
      { open: 10, high: 13, low: 9, close: 12 },
      { open: 12, high: 13, low: 10, close: 11 },
      { open: 11, high: 15, low: 10, close: 14 },
    ];
    // bodies [2, −1, 3]; SMA(2): [NaN, 0.5, 1] (warmup NaN-filled)
    expect(ta.qstick(bars, { period: 2 })).toEqual([NaN, 0.5, 1]);
  });
});

describe('TTM Trend', () => {
  it('is +1 when close is above the SMA of HL2, −1 below', () => {
    const up = ta.ttmTrend(trendBars, { period: 6 }).at(-1)!;
    expect(up).toBe(1);
    const downBars = toBars(trendCloses.map((_, i) => 200 - i * 0.8));
    expect(ta.ttmTrend(downBars, { period: 6 }).at(-1)!).toBe(-1);
  });
});

describe('Vertical Horizontal Filter', () => {
  it('range / summed-absolute-change (closed form)', () => {
    // closes 1..5, period 4 → window [2,3,4,5]: num=3, diffs=[1,1,1,1] sum=4 → 0.75
    const out = ta.verticalHorizontalFilter([1, 2, 3, 4, 5], { period: 4 });
    expect(out[3]).toBeNaN(); // warmup
    expect(out[4]!).toBeCloseTo(0.75, 12);
  });
  it('is higher on a clean trend than on a sawtooth', () => {
    const trend = ta.verticalHorizontalFilter(trendCloses, { period: 28 }).at(-1)!;
    const choppy = ta.verticalHorizontalFilter(choppyCloses, { period: 28 }).at(-1)!;
    expect(trend).toBeGreaterThan(choppy);
  });
});

describe('trend / cross signal state machines', () => {
  it('trendSignals flags entries and exits on a 0/1 trend series', () => {
    const out = ta.trendSignals([0, 0, 1, 1, 0, 1], {});
    expect(out.map((o) => o!.entry)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(out.map((o) => o!.exit)).toEqual([0, 0, 0, 0, 1, 0]);
    expect(out.map((o) => o!.trend)).toEqual([0, 0, 1, 1, 0, 1]);
  });
  it('crossSignals goes long crossing above and exits crossing below', () => {
    const out = ta.crossSignals([-1, 1, 2, -1, -2, 1], { above: 0, below: 0 });
    expect(out[0]!.trend).toBeNaN(); // needs a prior value to detect a cross → warmup
    expect(out.slice(1).map((o) => o!.entry)).toEqual([1, 0, 0, 0, 1]);
    expect(out.slice(1).map((o) => o!.exit)).toEqual([0, 0, 1, 0, 0]);
    expect(out.slice(1).map((o) => o!.trend)).toEqual([1, 1, 0, 0, 1]);
  });
});

describe('trend-ext streaming parity', () => {
  it('series indicators match their streams', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['linearDecay', { period: 5 }],
      ['exponentialDecay', { period: 5 }],
      ['increasing', { period: 3 }],
      ['decreasing', { period: 3, strict: true }],
      ['verticalHorizontalFilter', { period: 14 }],
      ['trendSignals', {}],
      ['crossSignals', { above: 105, below: 100 }],
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
  it('bar indicators match their streams', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['choppinessIndex', { period: 14 }],
      ['chandeKrollStop', { atrPeriod: 10, period: 9 }],
      ['centralPivotRange', {}],
      ['pMax', { period: 10, multiplier: 3 }],
      ['qstick', { period: 10 }],
      ['ttmTrend', { period: 6 }],
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
  it('pair indicators (longRun/shortRun) match their streams', () => {
    const ps = pairs(
      mixCloses,
      ta.sma(mixCloses, { period: 10 }).map((v) => v ?? 0),
    );
    for (const name of ['longRun', 'shortRun'] as const) {
      const ind = ta[name] as Indicator<{ period?: number }, Pair, number>;
      const batch = ind.explain(ps, { period: 2 });
      const stream = ind.stream({ period: 2 });
      for (let i = 0; i < ps.length; i++) {
        const e = stream.next(ps[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e, name).toEqual(batch.value[i]);
      }
    }
  });
});

describe('trend-ext snapshots round-trip', () => {
  it('PMax and Chande Kroll Stop restore mid-stream and continue identically', () => {
    for (const [name, parameters] of [
      ['pMax', { period: 10, multiplier: 3 }],
      ['chandeKrollStop', { atrPeriod: 10, period: 9 }],
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
