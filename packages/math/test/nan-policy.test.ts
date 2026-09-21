/**
 * WS1.3: `nanPolicy` must be applied uniformly across the stats module. Under the default
 * `propagate`, NaN in ⇒ NaN out (never swallowed by a comparison or a partial sort); `omit` drops
 * NaN; `throw` throws. Rolling functions apply the policy per window and recover.
 */

import { describe, expect, it } from 'vitest';
import {
  correlation,
  covariance,
  medianAbsoluteDeviation,
  max,
  min,
  quantile,
  rollingMean,
  trimmedMean,
  winsorize,
} from '@totalfinance/math';

describe('nanPolicy propagates through order statistics (WS1.3)', () => {
  it('min/max do not let a NaN slip past the comparison', () => {
    expect(min([1, NaN, 0])).toBeNaN(); // old code returned 0
    expect(max([1, NaN, 0])).toBeNaN(); // old code returned 1
    expect(min([1, NaN, 0], { nanPolicy: 'omit' })).toBe(0);
    expect(max([1, NaN, 0], { nanPolicy: 'omit' })).toBe(1);
    expect(() => min([1, NaN, 0], { nanPolicy: 'throw' })).toThrow();
  });

  it('quantile/median do not compute from a NaN-corrupted sort', () => {
    expect(quantile([3, NaN, 1, 2], 0.5)).toBeNaN(); // old code returned garbage
    expect(quantile([3, NaN, 1, 2], 0.5, { nanPolicy: 'omit' })).toBeCloseTo(2, 12);
    expect(() => quantile([3, NaN, 1, 2], 0.5, { nanPolicy: 'throw' })).toThrow();
  });

  it('covariance actually applies the policy it advertises', () => {
    const x = [1, 2, 3, NaN, 5];
    const y = [2, 4, 6, 8, 10];
    expect(covariance(x, y)).toBeNaN(); // old code ignored nanPolicy entirely
    expect(covariance(x, y, { nanPolicy: 'omit' })).toBeGreaterThan(0); // pairwise deletion
    expect(() => covariance(x, y, { nanPolicy: 'throw' })).toThrow();
  });

  it('correlation, medianAbsoluteDeviation, winsorize, trimmedMean all honor propagate', () => {
    expect(correlation([1, 2, NaN], [1, 2, 3])).toBeNaN();
    expect(medianAbsoluteDeviation([1, 2, NaN, 4])).toBeNaN();
    expect(winsorize([1, NaN, 3])).toEqual([NaN, NaN, NaN]); // all-NaN of input length
    expect(trimmedMean([1, 2, NaN, 4, 5])).toBeNaN();
  });

  it('rolling mean marks NaN windows and RECOVERS once the NaN leaves the window', () => {
    const out = rollingMean([1, 2, NaN, 4, 5], 2);
    // windows: [1,2]=1.5, [2,NaN]=NaN, [NaN,4]=NaN, [4,5]=4.5
    expect(out[0]).toBeNaN(); // warmup
    expect(out[1]).toBeCloseTo(1.5, 12);
    expect(out[2]).toBeNaN();
    expect(out[3]).toBeNaN();
    expect(out[4]).toBeCloseTo(4.5, 12); // recovered
  });
});

describe('policy is a no-op on NaN-free inputs (WS1.3 property)', () => {
  it('all three policies agree when there is no NaN', () => {
    const xs = [5, 1, 4, 2, 3, 9, 7];
    const ys = [2, 3, 1, 5, 4, 8, 6];
    for (const p of ['propagate', 'omit', 'throw'] as const) {
      expect(min(xs, { nanPolicy: p })).toBe(1);
      expect(max(xs, { nanPolicy: p })).toBe(9);
      expect(quantile(xs, 0.5, { nanPolicy: p })).toBeCloseTo(4, 12);
      expect(covariance(xs, ys, { nanPolicy: p })).toBeCloseTo(covariance(xs, ys), 12);
      expect(correlation(xs, ys, { nanPolicy: p })).toBeCloseTo(correlation(xs, ys), 12);
    }
  });
});
