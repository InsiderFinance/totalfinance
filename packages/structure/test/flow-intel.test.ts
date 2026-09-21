/**
 * Tests for the directional flow-intelligence helpers (§11.6, product review §4): delta-adjusted
 * premium (bullish/bearish lean) and the unusualness z-score / percentile against a caller baseline.
 */

import { describe, expect, it } from 'vitest';
import {
  type DirectionalFlowTrade,
  deltaAdjustedPremium,
  unusualness,
} from '@totalfinance/structure';

describe('deltaAdjustedPremium', () => {
  it('weights premium by |delta| and classifies bullish vs bearish lean', () => {
    const trades: DirectionalFlowTrade[] = [
      { type: 'call', side: 'buy', premium: 100_000, delta: 0.6 }, // bullish 60k
      { type: 'put', side: 'sell', premium: 50_000, delta: -0.4 }, // bullish 20k
      { type: 'put', side: 'buy', premium: 80_000, delta: -0.5 }, // bearish 40k
      { type: 'call', side: 'sell', premium: 30_000, delta: 0.3 }, // bearish 9k
    ];
    const r = deltaAdjustedPremium(trades);
    expect(r.bullishPremium).toBeCloseTo(60_000 + 20_000, 6);
    expect(r.bearishPremium).toBeCloseTo(40_000 + 9_000, 6);
    expect(r.netDirectional).toBeCloseTo(80_000 - 49_000, 6);
    expect(r.totalDeltaAdjusted).toBeCloseTo(129_000, 6);
  });

  it('is empty-safe and validates enums/greeks', () => {
    expect(deltaAdjustedPremium([]).netDirectional).toBe(0);
    expect(() =>
      deltaAdjustedPremium([
        { type: 'x' as unknown as 'call', side: 'buy', premium: 1, delta: 0.1 },
      ]),
    ).toThrow(/type/);
    expect(() =>
      deltaAdjustedPremium([{ type: 'call', side: 'buy', premium: 1, delta: Number.NaN }]),
    ).toThrow(/delta/);
  });

  it('rejects an out-of-range |delta| > 1 rather than inflating the weight (PR review)', () => {
    expect(() =>
      deltaAdjustedPremium([{ type: 'call', side: 'buy', premium: 1000, delta: 2 }]),
    ).toThrow(/delta/);
    expect(() =>
      deltaAdjustedPremium([{ type: 'put', side: 'buy', premium: 1000, delta: -1.5 }]),
    ).toThrow(/delta/);
  });
});

describe('unusualness', () => {
  it('computes the z-score and percentile against a baseline', () => {
    const baseline = [100, 120, 110, 90, 130, 105, 115]; // mean 110
    const r = unusualness(200, baseline);
    expect(r.mean).toBeCloseTo(110, 6);
    expect(r.zScore).toBeGreaterThan(4); // 200 is far above the trailing history
    expect(r.percentile).toBe(100); // above every baseline reading
  });

  it('returns null z for a flat baseline (no defined spread), never a fabricated value', () => {
    const r = unusualness(5, [3, 3, 3, 3]);
    expect(r.zScore).toBeNull();
    expect(r.stdev).toBe(0);
    expect(r.percentile).toBe(100);
  });

  it('validates inputs', () => {
    expect(() => unusualness(1, [])).toThrow(/baseline/);
    expect(() => unusualness(Number.NaN, [1, 2])).toThrow(/value/);
    expect(() => unusualness(1, [1, Number.POSITIVE_INFINITY])).toThrow(/baseline/);
  });
});
