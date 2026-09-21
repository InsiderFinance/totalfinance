import { describe, expect, it } from 'vitest';
import {
  bootstrap,
  mean,
  mulberry32,
  normalSample,
  restoreRandomNumberGenerator,
  standardDeviation,
  uniformSamples,
  xoshiro128ss,
} from '@totalfinance/math';

describe('seeded RNG', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 5 }, () => a.next());
    const seqB = Array.from({ length: 5 }, () => b.next());
    expect(seqA).toEqual(seqB);
    expect(a.seed).toBe(42);
  });

  it('different seeds diverge', () => {
    expect(mulberry32(1).next()).not.toBe(mulberry32(2).next());
  });

  it('uniform samples stay in [0, 1)', () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const x = r.next();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('normalSample is approximately N(0,1) over many draws', () => {
    const r = mulberry32(123);
    const xs = Array.from({ length: 20000 }, () => normalSample(r));
    expect(mean(xs)).toBeCloseTo(0, 1);
    expect(standardDeviation(xs)).toBeCloseTo(1, 1);
  });
});

describe('bootstrap', () => {
  it('is reproducible given a seed and echoes it', () => {
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    const a = bootstrap(data, mean, { iterations: 500, seed: 99 });
    const b = bootstrap(data, mean, { iterations: 500, seed: 99 });
    expect(a.estimates).toEqual(b.estimates);
    expect(a.seed).toBe(99);
    expect(a.iterations).toBe(500);
  });

  it('estimates the sample mean with a sensible CI', () => {
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    const res = bootstrap(data, mean, { iterations: 2000, seed: 1 });
    expect(res.mean).toBeCloseTo(mean(data), 0);
    expect(res.confidenceInterval95[0]).toBeLessThanOrEqual(res.mean);
    expect(res.confidenceInterval95[1]).toBeGreaterThanOrEqual(res.mean);
  });

  it('throws on empty data, non-positive iterations, or a non-finite seed', () => {
    expect(() => bootstrap([], mean, { seed: 1 })).toThrow();
    expect(() => bootstrap([1, 2, 3], mean, { iterations: 0, seed: 1 })).toThrow();
    expect(() => bootstrap([1, 2, 3], mean, { iterations: 100, seed: NaN })).toThrow();
  });

  it('throws when the statistic returns a non-finite value (no all-NaN summary)', () => {
    expect(() => bootstrap([1, 2, 3], () => NaN, { seed: 1, iterations: 10 })).toThrow();
  });
});

describe('stochastic helper hardening', () => {
  it('restoreRandomNumberGenerator rejects malformed snapshots instead of degenerating silently', () => {
    // These deliberately pass shapes the DECLARATION forbids, because the guard exists for snapshots
    // that arrive from JSON or another process where the type system was never present. The casts
    // are the point of the test, not a workaround for it.
    expect(() =>
      restoreRandomNumberGenerator({
        algorithm: 'xoshiro128ss',
        state: [],
        seed: 1,
      } as never),
    ).toThrow();
    expect(() =>
      restoreRandomNumberGenerator({ algorithm: 'mulberry32', state: [NaN], seed: 1 }),
    ).toThrow();
    expect(() =>
      restoreRandomNumberGenerator({ algorithm: 'nope', state: [1], seed: 1 } as never),
    ).toThrow();
    // A state LONGER than the algorithm uses is refused too. This is the case the old
    // `length < count` check let through: four words restored a one-word generator and three were
    // silently discarded, which is a different generator answering to the same snapshot.
    expect(() =>
      restoreRandomNumberGenerator({
        algorithm: 'mulberry32',
        state: [1, 2, 3, 4],
        seed: 1,
      } as never),
    ).toThrow(/exactly 1 finite element/);
    // The unknown-algorithm refusal teaches the closed set rather than only naming the offender.
    expect(() =>
      restoreRandomNumberGenerator({ algorithm: 'mt19937', state: [1], seed: 1 } as never),
    ).toThrow(/mulberry32.*xoshiro128ss/);
    // A valid snapshot still round-trips.
    const randomNumberGenerator = xoshiro128ss(7);
    const restored = restoreRandomNumberGenerator(randomNumberGenerator.getState());
    expect(restored.next()).toBe(randomNumberGenerator.next());
  });

  it('uniformSamples rejects an invalid count (no raw RangeError)', () => {
    expect(() => uniformSamples(mulberry32(1), NaN)).toThrow();
    expect(() => uniformSamples(mulberry32(1), -3)).toThrow();
    expect(uniformSamples(mulberry32(1), 4)).toHaveLength(4);
  });
});
