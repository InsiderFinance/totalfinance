import { describe, expect, it } from 'vitest';
import { type Indicator } from '@totalfinance/technical-analysis';
import * as ta from '@totalfinance/technical-analysis';

// positive series (entropy needs positive values)
const series = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 3) * 10 + (i % 5) * 2);

describe('rolling quantile / rank', () => {
  it('rollingQuantile interpolates (closed form)', () => {
    expect(ta.rollingQuantile([1, 2, 3, 4, 5], { period: 5, quantile: 0.5 }).at(-1)!).toBeCloseTo(
      3,
      12,
    );
    expect(ta.rollingQuantile([1, 2, 3, 4, 5], { period: 5, quantile: 0.25 }).at(-1)!).toBeCloseTo(
      2,
      12,
    );
    expect(ta.rollingQuantile([1, 2, 3, 4], { period: 4, quantile: 0.5 }).at(-1)!).toBeCloseTo(
      2.5,
      12,
    );
  });
  it('rollingRank is the 1-based ordinal rank within the window', () => {
    expect(ta.rollingRank([1, 3, 2, 5, 4], { period: 5 }).at(-1)!).toBe(4); // 4 beats {1,3,2}
    expect(ta.rollingRank([5, 4, 3, 2, 1], { period: 5 }).at(-1)!).toBe(1); // 1 is the lowest
  });
  it('percentRank is the percentile position [0,100]', () => {
    expect(ta.percentRank([1, 3, 2, 5, 4], { period: 5 }).at(-1)!).toBeCloseTo(75, 12); // 3/4
    expect(ta.percentRank([1, 2, 3, 4, 5], { period: 5 }).at(-1)!).toBeCloseTo(100, 12); // top
  });
});

describe('winsorize', () => {
  it('clips the current value to the window quantiles (closed form)', () => {
    // window [1,2,3,4,100], upper q=0.8 → 23.2 ; current 100 clips to 23.2
    expect(
      ta.winsorize([1, 2, 3, 4, 100], { period: 5, lower: 0, upper: 0.8 }).at(-1)!,
    ).toBeCloseTo(23.2, 9);
  });
  it('leaves an in-range value unchanged', () => {
    expect(
      ta.winsorize([1, 2, 3, 4, 3], { period: 5, lower: 0.1, upper: 0.9 }).at(-1)!,
    ).toBeCloseTo(3, 12);
  });
  it('rejects lower > upper', () => {
    expect(() => ta.winsorize([1, 2, 3], { period: 3, lower: 0.9, upper: 0.1 })).toThrowError(
      /lower/,
    );
  });
});

describe('higher moments', () => {
  it('skew is 0 on a symmetric window, positive on a right-skewed one', () => {
    expect(ta.skew([1, 2, 3, 4, 5], { period: 5 }).at(-1)!).toBeCloseTo(0, 12);
    expect(ta.skew([1, 1, 1, 1, 10], { period: 5 }).at(-1)!).toBeGreaterThan(0);
  });
  it('kurtosis matches the scipy bias-corrected value (closed form)', () => {
    // scipy.stats.kurtosis([1,2,3,4,5], fisher=True, bias=False) = −1.2
    expect(ta.kurtosis([1, 2, 3, 4, 5], { period: 5 }).at(-1)!).toBeCloseTo(-1.2, 12);
  });
});

describe('entropy', () => {
  it('is maximal (log2 n) on a uniform window, lower when concentrated', () => {
    expect(ta.entropy([1, 1, 1, 1], { period: 4 }).at(-1)!).toBeCloseTo(2, 12); // log2(4)
    const concentrated = ta.entropy([3, 1, 1, 1], { period: 4 }).at(-1)!;
    expect(concentrated).toBeLessThan(2);
    expect(concentrated).toBeGreaterThan(0);
  });
});

describe('features-ext slice-2 parity & snapshots', () => {
  it('every transform matches its stream', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['rollingRank', { period: 20 }],
      ['percentRank', { period: 20 }],
      ['rollingQuantile', { period: 20, quantile: 0.3 }],
      ['winsorize', { period: 20, lower: 0.1, upper: 0.9 }],
      ['skew', { period: 20 }],
      ['kurtosis', { period: 20 }],
      ['entropy', { period: 14 }],
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
  it('skew and winsorize round-trip mid-stream', () => {
    for (const [name, parameters] of [
      ['skew', { period: 20 }],
      ['winsorize', { period: 20, lower: 0.1, upper: 0.9 }],
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
