import { describe, expect, it } from 'vitest';
import { type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

const series = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 4) * 8 + i * 0.2);

describe('lag operators', () => {
  it('shift lags by `period` (closed form); lag is the same indicator', () => {
    expect(ta.shift([1, 2, 3, 4, 5], { period: 2 })).toEqual([NaN, NaN, 1, 2, 3]);
    expect(ta.lag([1, 2, 3, 4, 5], { period: 2 })).toEqual(
      ta.shift([1, 2, 3, 4, 5], { period: 2 }),
    );
  });
  it('diff is the discrete difference; change is the same', () => {
    expect(ta.difference([1, 3, 6, 10], { period: 1 })).toEqual([NaN, 2, 3, 4]);
    expect(ta.difference([1, 3, 6, 10], { period: 2 })).toEqual([NaN, NaN, 5, 7]);
    expect(ta.change([1, 3, 6, 10], {})).toEqual(ta.difference([1, 3, 6, 10], {}));
  });
  it('fractionalChange is the fractional change', () => {
    const out = ta.fractionalChange([100, 110, 99], { period: 1 });
    expect(out[0]).toBeNaN();
    expect(out[1]!).toBeCloseTo(0.1, 12);
    expect(out[2]!).toBeCloseTo(-0.1, 12);
  });
  it('cum is the running sum (warmup 0)', () => {
    expect(ta.cumulativeSum([1, 2, 3, 4], {})).toEqual([1, 3, 6, 10]);
  });
});

describe('rolling standardization', () => {
  it('zScore is (value − mean)/populationStd over the window (closed form)', () => {
    // window [1,2,3]: mean 2, std √(2/3) ≈ 0.8165 → z = 1/0.8165 ≈ 1.2247
    expect(ta.zScore([1, 2, 3], { period: 3 }).at(-1)!).toBeCloseTo(1 / Math.sqrt(2 / 3), 12);
    expect(ta.zScore([5, 5, 5], { period: 3 }).at(-1)!).toBe(0); // flat window
  });
  it('normalize maps to [0,1] within the window (midpoint on a flat window)', () => {
    expect(ta.normalize([10, 20, 30], { period: 3 }).at(-1)!).toBeCloseTo(1, 12);
    expect(ta.normalize([10, 30, 20], { period: 3 }).at(-1)!).toBeCloseTo(0.5, 12); // (20−10)/20
    expect(ta.normalize([7, 7, 7], { period: 3 }).at(-1)!).toBe(0.5); // flat
  });
  it('rescale stretches the normalized value into [min, max]', () => {
    expect(ta.rescale([10, 20, 30], { period: 3, min: 0, max: 100 }).at(-1)!).toBeCloseTo(100, 9);
    expect(ta.rescale([10, 30, 20], { period: 3, min: -1, max: 1 }).at(-1)!).toBeCloseTo(0, 9);
  });
});

describe('rolling dispersion', () => {
  it('rollingMedian (odd and even windows)', () => {
    expect(ta.rollingMedian([1, 2, 3, 4, 5], { period: 3 })).toEqual([NaN, NaN, 2, 3, 4]);
    expect(ta.rollingMedian([1, 2, 3, 4], { period: 4 }).at(-1)!).toBeCloseTo(2.5, 12);
  });
  it('mad is the mean absolute deviation', () => {
    // window [1,2,3]: mean 2, Σ|x−2| = 2, /3 = 0.6667
    expect(ta.rollingMeanAbsoluteDeviation([1, 2, 3], { period: 3 }).at(-1)!).toBeCloseTo(
      2 / 3,
      12,
    );
  });
  it('standardError is sampleStd/√n', () => {
    // window [1,2,3]: sampleStd = √((1+0+1)/2) = 1 → SEM = 1/√3
    expect(ta.standardError([1, 2, 3], { period: 3 }).at(-1)!).toBeCloseTo(1 / Math.sqrt(3), 12);
  });
});

describe('features-ext streaming parity & snapshots', () => {
  it('every transform matches its stream', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['shift', { period: 3 }],
      ['difference', { period: 2 }],
      ['fractionalChange', { period: 1 }],
      ['cumulativeSum', {}],
      ['zScore', { period: 20 }],
      ['normalize', { period: 20 }],
      ['rescale', { period: 20, min: -1, max: 1 }],
      ['rollingMedian', { period: 15 }],
      ['rollingMeanAbsoluteDeviation', { period: 20 }],
      ['standardError', { period: 20 }],
    ];
    for (const [name, parameters] of cases) {
      const ind = ta[name as keyof typeof ta] as Indicator<Record<string, unknown>, number, number>;
      const batch = ind.explain(series, parameters);
      const stream = ind.stream(parameters);
      for (let i = 0; i < series.length; i++) {
        const e = stream.next(series[i]!);
        if (i < batch.diagnostics.warmup) expect(e, name).toBeNull();
        else expect(e as number, name).toBeCloseTo(batch.value[i] as number, 9);
      }
    }
  });
  it('cumulativeSum and zScore round-trip mid-stream', () => {
    for (const [name, parameters] of [
      ['cumulativeSum', {}],
      ['zScore', { period: 20 }],
    ] as const) {
      const ind = ta[name] as Indicator<Record<string, unknown>, number, number>;
      const ref = ind.stream(parameters);
      const expected = series.map((v) => ref.next(v));
      const part = ind.stream(parameters);
      for (let i = 0; i < 40; i++) part.next(series[i]!);
      const restored = ind.fromJSON(JSON.parse(JSON.stringify(part.toJSON())));
      for (let i = 40; i < series.length; i++) {
        expect(restored.next(series[i]!) as number, name).toBeCloseTo(expected[i] as number, 9);
      }
    }
  });
});
