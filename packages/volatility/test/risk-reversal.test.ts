/**
 * Risk reversal & butterfly (`riskReversalButterfly`, `smileFromQuotes`). Pins the δ-delta wing strikes
 * (their forward delta equals the target), the RR/BF signs on a skewed/convex smile, the flat-smile
 * degeneracy (RR = BF = 0), the machine-precise round-trip between the two functions, an unreachable-δ
 * error on an extreme smile, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { riskReversalButterfly, smileFromQuotes } from '@totalfinance/volatility';
import { normalCdf } from '@totalfinance/math';

const F = 100;
const T = 0.5;
const sqrtT = Math.sqrt(T);
/** A realistic down-skewed, convex smile in log-moneyness. */
const smile = (K: number): number => {
  const k = Math.log(K / F);
  return 0.2 - 0.1 * k + 0.3 * k * k;
};
/** Forward call-delta at (K, σ). */
const fwdCallDelta = (K: number, sigma: number): number =>
  normalCdf((Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT));

describe('riskReversalButterfly', () => {
  it('recovers wing strikes whose forward delta equals the target', () => {
    const r = riskReversalButterfly({ forward: F, timeToExpiryYears: T, smile, delta: 0.25 });
    expect(fwdCallDelta(r.callStrike, r.callVolatility)).toBeCloseTo(0.25, 8); // call Δ = δ
    expect(fwdCallDelta(r.putStrike, r.putVolatility) - 1).toBeCloseTo(-0.25, 8); // put Δ = −δ
    expect(r.atmVolatility).toBeCloseTo(smile(F), 12);
    expect(r.callVolatility).toBeCloseTo(smile(r.callStrike), 12);
    expect(r.putVolatility).toBeCloseTo(smile(r.putStrike), 12);
    expect(r.callStrike).toBeGreaterThan(F); // OTM call above forward
    expect(r.putStrike).toBeLessThan(F); // OTM put below forward
  });

  it('reports the skew (RR) and curvature (BF) with the right signs', () => {
    const r = riskReversalButterfly({ forward: F, timeToExpiryYears: T, smile });
    // negative skew (puts richer than calls) ⇒ RR < 0; convex smile ⇒ BF > 0.
    expect(r.riskReversal).toBeLessThan(0);
    expect(r.riskReversal).toBeCloseTo(r.callVolatility - r.putVolatility, 15);
    expect(r.butterfly).toBeGreaterThan(0);
    expect(r.butterfly).toBeCloseTo((r.callVolatility + r.putVolatility) / 2 - r.atmVolatility, 15);
  });

  it('gives RR = 0 and BF = 0 for a flat smile', () => {
    const r = riskReversalButterfly({ forward: F, timeToExpiryYears: T, smile: () => 0.2 });
    expect(r.riskReversal).toBeCloseTo(0, 12);
    expect(r.butterfly).toBeCloseTo(0, 12);
    expect(r.callVolatility).toBeCloseTo(0.2, 12);
    expect(r.putVolatility).toBeCloseTo(0.2, 12);
  });

  it('wider wings (10-delta) show more skew and curvature than 25-delta on a convex smile', () => {
    const d25 = riskReversalButterfly({ forward: F, timeToExpiryYears: T, smile, delta: 0.25 });
    const d10 = riskReversalButterfly({ forward: F, timeToExpiryYears: T, smile, delta: 0.1 });
    expect(Math.abs(d10.riskReversal)).toBeGreaterThan(Math.abs(d25.riskReversal));
    expect(d10.butterfly).toBeGreaterThan(d25.butterfly);
  });

  it('errors (typed) when the target delta is unreachable or the smile misbehaves during the search', () => {
    // Extreme convex smile: the wing vol blows up faster than the call delta decays.
    expect(() =>
      riskReversalButterfly({
        forward: F,
        timeToExpiryYears: T,
        smile: (K) => 0.2 + 5 * Math.log(K / F) ** 2,
      }),
    ).toThrowError();
    // A smile that returns a non-finite vol above the forward — the search hits NaN and cannot converge.
    expect(() =>
      riskReversalButterfly({
        forward: F,
        timeToExpiryYears: T,
        smile: (K) => (K > F ? Number.NaN : 0.2),
      }),
    ).toThrowError();
  });

  it('guards a non-object input, a non-function smile, a bad delta, and non-positive scalars', () => {
    expect(() => riskReversalButterfly(undefined as never)).toThrowError();
    expect(() =>
      riskReversalButterfly({ forward: F, timeToExpiryYears: T } as never),
    ).toThrowError(); // no smile
    expect(() =>
      riskReversalButterfly({ forward: F, timeToExpiryYears: T, smile, delta: 0.6 }),
    ).toThrowError();
    expect(() =>
      riskReversalButterfly({ forward: F, timeToExpiryYears: T, smile, delta: 0 }),
    ).toThrowError();
    expect(() =>
      riskReversalButterfly({ forward: -1, timeToExpiryYears: T, smile }),
    ).toThrowError();
    expect(() => riskReversalButterfly({ forward: F, timeToExpiryYears: 0, smile })).toThrowError();
  });
});

describe('smileFromQuotes', () => {
  it('is the exact inverse of riskReversalButterfly (volatilities and strikes round-trip)', () => {
    for (const delta of [0.25, 0.1]) {
      const decomp = riskReversalButterfly({ forward: F, timeToExpiryYears: T, smile, delta });
      const anchors = smileFromQuotes({
        forward: F,
        timeToExpiryYears: T,
        atmVolatility: decomp.atmVolatility,
        riskReversal: decomp.riskReversal,
        butterfly: decomp.butterfly,
        delta,
      });
      expect(anchors.callVolatility).toBeCloseTo(decomp.callVolatility, 12);
      expect(anchors.putVolatility).toBeCloseTo(decomp.putVolatility, 12);
      expect(anchors.callStrike).toBeCloseTo(decomp.callStrike, 6);
      expect(anchors.putStrike).toBeCloseTo(decomp.putStrike, 6);
      expect(anchors.atmStrike).toBe(F);
    }
  });

  it('sets the wing volatilities to ATM + BF ± RR/2 and the strikes to the target delta', () => {
    const a = smileFromQuotes({
      forward: F,
      timeToExpiryYears: T,
      atmVolatility: 0.2,
      riskReversal: -0.02,
      butterfly: 0.005,
    });
    expect(a.callVolatility).toBeCloseTo(0.2 + 0.005 - 0.01, 15);
    expect(a.putVolatility).toBeCloseTo(0.2 + 0.005 + 0.01, 15);
    expect(fwdCallDelta(a.callStrike, a.callVolatility)).toBeCloseTo(0.25, 8);
    expect(fwdCallDelta(a.putStrike, a.putVolatility) - 1).toBeCloseTo(-0.25, 8);
  });

  it('guards a bad input and quotes implying a non-positive wing vol', () => {
    expect(() => smileFromQuotes(undefined as never)).toThrowError();
    expect(() =>
      smileFromQuotes({
        forward: F,
        timeToExpiryYears: T,
        atmVolatility: -0.2,
        riskReversal: 0,
        butterfly: 0,
      }),
    ).toThrowError();
    expect(() =>
      smileFromQuotes({
        forward: F,
        timeToExpiryYears: T,
        atmVolatility: 0.2,
        riskReversal: Number.NaN,
        butterfly: 0,
      }),
    ).toThrowError();
    // BF so negative it drives a wing vol ≤ 0.
    expect(() =>
      smileFromQuotes({
        forward: F,
        timeToExpiryYears: T,
        atmVolatility: 0.05,
        riskReversal: 0,
        butterfly: -0.1,
      }),
    ).toThrowError();
    expect(() =>
      smileFromQuotes({
        forward: F,
        timeToExpiryYears: T,
        atmVolatility: 0.2,
        riskReversal: 0,
        butterfly: 0,
        delta: 0.6,
      }),
    ).toThrowError();
  });
});
