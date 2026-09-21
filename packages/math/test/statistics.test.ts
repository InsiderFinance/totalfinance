import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  correlation,
  kurtosis,
  max,
  mean,
  median,
  min,
  quantile,
  rollingMean,
  rollingStandardDeviation,
  skewness,
  standardDeviation,
  variance,
} from '@totalfinance/math';

const D = [1, 2, 3, 4, 5];

describe('descriptive stats', () => {
  it('mean / min / max / median', () => {
    expect(mean(D)).toBe(3);
    expect(min(D)).toBe(1);
    expect(max(D)).toBe(5);
    expect(median(D)).toBe(3);
  });

  it('variance defaults to sample (÷n-1); population on request', () => {
    expect(variance(D)).toBeCloseTo(2.5, 12);
    expect(variance(D, { population: true })).toBeCloseTo(2, 12);
    expect(standardDeviation(D)).toBeCloseTo(Math.sqrt(2.5), 12);
  });

  it('quantiles (type-7)', () => {
    expect(quantile(D, 0.25)).toBeCloseTo(2, 12);
    expect(quantile(D, 0.5)).toBeCloseTo(3, 12);
    expect(quantile(D, 0.75)).toBeCloseTo(4, 12);
    expect(quantile(D, 0)).toBe(1);
    expect(quantile(D, 1)).toBe(5);
  });

  it('symmetric data has ~zero skew; excess kurtosis defined', () => {
    expect(skewness([-2, -1, 0, 1, 2])).toBeCloseTo(0, 12);
    expect(Number.isFinite(kurtosis([-2, -1, 0, 1, 2]))).toBe(true);
  });

  it('correlation of perfectly linear series is 1', () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
  });
});

describe('rolling stats (aligned, NaN warmup)', () => {
  it('rollingMean', () => {
    const r = rollingMean(D, 3);
    expect(r.length).toBe(D.length);
    expect(r[0]).toBeNaN();
    expect(r[1]).toBeNaN();
    expect(r.slice(2)).toEqual([2, 3, 4]);
  });

  it('rollingStandardDeviation matches windowed standardDeviation', () => {
    const r = rollingStandardDeviation(D, 3);
    expect(r[0]).toBeNaN();
    expect(r[2]).toBeCloseTo(standardDeviation([1, 2, 3]), 12);
    expect(r[4]).toBeCloseTo(standardDeviation([3, 4, 5]), 12);
  });

  it('rejects fractional or non-positive windows (no corrupted array shape)', () => {
    for (const w of [1.5, 0, -2, NaN]) {
      expect(() => rollingMean(D, w)).toThrow();
      expect(() => rollingStandardDeviation(D, w)).toThrow();
    }
    // A fractional window must not write stray non-integer index properties onto the array.
    let out: number[] = [];
    try {
      out = rollingStandardDeviation([1, 2, 3, 4], 1.5);
    } catch {
      out = [];
    }
    expect(Object.keys(out).every((k) => Number.isInteger(Number(k)))).toBe(true);
  });
});

describe('properties', () => {
  const arr = fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), {
    minLength: 2,
    maxLength: 200,
  });

  it('variance is non-negative and mean lies within [min, max]', () => {
    fc.assert(
      fc.property(arr, (xs) => {
        expect(variance(xs)).toBeGreaterThanOrEqual(-1e-6);
        const m = mean(xs);
        expect(m).toBeGreaterThanOrEqual(min(xs) - 1e-6);
        expect(m).toBeLessThanOrEqual(max(xs) + 1e-6);
      }),
    );
  });

  it('quantile is monotonic in p', () => {
    fc.assert(
      fc.property(arr, (xs) => {
        expect(quantile(xs, 0.25)).toBeLessThanOrEqual(quantile(xs, 0.75) + 1e-6);
      }),
    );
  });
});

describe('R3 honesty fixes', () => {
  it('quantile throws on the percentile-vs-fraction mistake instead of silently returning max', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(() => quantile(xs, 95)).toThrowError(/p is a fraction in \[0, 1\] — use 0\.95, not 95/);
    expect(() => quantile(xs, -0.1)).toThrowError(/fraction/);
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(100);
    expect(quantile(xs, 0.95)).toBeCloseTo(95.05, 10);
  });

  it('rollingMean recovers after ±Infinity leaves the window, like it does for NaN', () => {
    const out = rollingMean([1, Infinity, 2, 3, 4, 5], 2);
    expect(out[1]).toBeNaN();
    expect(out[2]).toBeNaN();
    expect(out[3]).toBeCloseTo(2.5, 12);
    expect(out[4]).toBeCloseTo(3.5, 12);
    expect(out[5]).toBeCloseTo(4.5, 12);
  });
});
