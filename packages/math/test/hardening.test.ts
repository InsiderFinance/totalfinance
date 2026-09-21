import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  correlation,
  covariance,
  medianAbsoluteDeviation,
  mean,
  normalCdf,
  normalInverseCdf,
  normalLogCdf,
  normalLogPdf,
  normalLogSurvivalFunction,
  normalPdf,
  normalSurvivalFunction,
  rollingCorrelation,
  rollingCovariance,
  trimmedMean,
  variance,
  welfordVariance,
  winsorize,
} from '@totalfinance/math';

describe('normal edge cases', () => {
  it('handles NaN and infinities', () => {
    expect(normalCdf(NaN)).toBeNaN();
    expect(normalInverseCdf(NaN)).toBeNaN();
    expect(normalCdf(Infinity)).toBe(1);
    expect(normalCdf(-Infinity)).toBe(0);
    expect(normalSurvivalFunction(Infinity)).toBe(0);
    expect(normalSurvivalFunction(-Infinity)).toBe(1);
  });

  it('logPdf matches log(pdf); sf = 1 - cdf', () => {
    for (const x of [-3, -1, 0, 1, 2.5]) {
      expect(normalLogPdf(x)).toBeCloseTo(Math.log(normalPdf(x)), 12);
      expect(normalSurvivalFunction(x)).toBeCloseTo(1 - normalCdf(x), 12);
    }
  });

  it('logCdf matches log(cdf) in the normal region', () => {
    for (const x of [-5, -2, 0, 2, 5]) {
      expect(normalLogCdf(x)).toBeCloseTo(Math.log(normalCdf(x)), 10);
    }
  });

  it('logCdf is finite and accurate in the far-left tail (where cdf underflows)', () => {
    expect(Number.isFinite(normalLogCdf(-50))).toBe(true);
    // leading asymptotic: log Φ(x) ≈ log φ(x) − log(−x)
    expect(normalLogCdf(-50)).toBeCloseTo(normalLogPdf(-50) - Math.log(50), 3);
    expect(normalLogSurvivalFunction(50)).toBeCloseTo(normalLogCdf(-50), 12);
    // continuous across the -20 threshold: the asymptotic path (just past -20) matches the
    // log(cdf) path at -20 (same point to within 1e-9).
    expect(normalLogCdf(-20 - 1e-9)).toBeCloseTo(normalLogCdf(-20), 6);
  });
});

describe('nanPolicy', () => {
  const xs = [1, 2, NaN, 4];
  it('propagate (default) yields NaN', () => {
    expect(mean(xs)).toBeNaN();
  });
  it('omit skips NaN', () => {
    expect(mean(xs, { nanPolicy: 'omit' })).toBeCloseTo(7 / 3, 12);
  });
  it('throw raises InputError', () => {
    expect(() => mean(xs, { nanPolicy: 'throw' })).toThrowError(/contains NaN/);
  });
});

describe('numerically stable variance', () => {
  it('handles huge constant offsets', () => {
    const offset = 1e9;
    const xs = [offset + 1, offset + 2, offset + 3, offset + 4, offset + 5];
    expect(variance(xs)).toBeCloseTo(2.5, 9);
    expect(welfordVariance(xs)).toBeCloseTo(2.5, 9);
  });

  it('Welford equals two-pass variance (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { minLength: 2, maxLength: 300 }),
        (data) => {
          const v = variance(data);
          const rel = Math.abs(welfordVariance(data) - v) / Math.max(1, Math.abs(v));
          expect(rel).toBeLessThan(1e-9);
        },
      ),
    );
  });
});

describe('two-series stats enforce equal length', () => {
  it('covariance / correlation throw on mismatch', () => {
    expect(() => covariance([1, 2, 3], [1, 2])).toThrowError(/equal length/);
    expect(() => correlation([1, 2, 3], [1, 2])).toThrowError(/equal length/);
  });
});

describe('rolling covariance & correlation', () => {
  const xs = [1, 2, 3, 4, 5, 6];
  const ys = [2, 4, 6, 8, 10, 12];
  it('rollingCorrelation of perfectly linear series is 1 after warmup', () => {
    const r = rollingCorrelation(xs, ys, 3);
    expect(r[0]).toBeNaN();
    expect(r[1]).toBeNaN();
    expect(r[2]).toBeCloseTo(1, 12);
    expect(r.at(-1)).toBeCloseTo(1, 12);
  });
  it('rollingCovariance matches windowed covariance', () => {
    const r = rollingCovariance(xs, ys, 3);
    expect(r[2]).toBeCloseTo(covariance([1, 2, 3], [2, 4, 6]), 12);
  });
});

describe('robust statistics', () => {
  it('MAD is robust to outliers', () => {
    const clean = [1, 2, 3, 4, 5];
    const withOutlier = [1, 2, 3, 4, 1000];
    expect(medianAbsoluteDeviation(clean)).toBeCloseTo(medianAbsoluteDeviation(withOutlier), 12); // median & deviations unchanged
  });
  it('winsorize clips the tails', () => {
    const w = winsorize([1, 2, 3, 4, 100], { lower: 0.2, upper: 0.2 });
    expect(Math.max(...w)).toBeLessThan(100);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(1);
  });
  it('trimmedMean drops tails', () => {
    expect(trimmedMean([1, 2, 3, 4, 1000], { fraction: 0.2 })).toBeCloseTo(3, 12);
  });
});
