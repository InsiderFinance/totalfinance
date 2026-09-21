/**
 * Empirical vol–spot β (`estimateVolatilitySpotBeta`) — the leverage effect. The defining property: on a synthetic
 * log-leverage series `σ = σ₀ + b·ln(S/S₀)` the log-basis slope recovers `b` (R² = 1) and `volatilitySpotBeta`
 * equals `b/S_ref = ∂σ/∂S` at the reference spot. Also pinned: the round-trip into `minimumVarianceDelta`,
 * the level basis, the HAC path, the significance / small-sample / dropped warnings, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { estimateVolatilitySpotBeta, minimumVarianceDelta } from '@totalfinance/volatility';

// A deterministic log-leverage history: σₜ = σ₀ + b·ln(Sₜ/S₀), b = −0.5 (pure leverage, no noise).
const S0 = 100;
const B_TRUE = -0.5;
const spot: number[] = [];
const impliedVolatility: number[] = [];
for (let t = 0; t < 120; t++) {
  const S = S0 * (1 + 0.002 * t + 0.03 * Math.sin(t / 3) + 0.02 * Math.cos(t / 7));
  spot.push(S);
  impliedVolatility.push(0.2 + B_TRUE * Math.log(S / S0));
}

describe('estimateVolatilitySpotBeta', () => {
  it('recovers a known leverage β and converts ∂σ/∂ln S → ∂σ/∂S at the reference spot', () => {
    const r = estimateVolatilitySpotBeta({ spot, impliedVolatility });
    // Log-basis slope recovers b exactly; R² = 1; correlation = −1 (pure leverage).
    expect(r.value.slope).toBeCloseTo(B_TRUE, 8);
    expect(r.value.rSquared).toBeCloseTo(1, 8);
    expect(r.value.correlation).toBeCloseTo(-1, 6);
    // β = ∂σ/∂S = b / S_ref (S_ref = latest spot by default).
    const sRef = spot[spot.length - 1]!;
    expect(r.value.referenceSpot).toBeCloseTo(sRef, 8);
    expect(r.value.volatilitySpotBeta).toBeCloseTo(B_TRUE / sRef, 10);
    expect(r.value.observationCount).toBe(119);
    expect(r.value.dropped).toBe(0);
    expect(r.diagnostics.warnings).toHaveLength(0);
    expect(r.assumptions.measure).toBe('real-world-hedge');
    expect(r.assumptions.basis).toBe('log');
    // A supplied reference spot is used for the conversion.
    const rSquared = estimateVolatilitySpotBeta({
      spot,
      impliedVolatility,
      referenceSpot: 100,
    });
    expect(rSquared.value.volatilitySpotBeta).toBeCloseTo(B_TRUE / 100, 10);
  });

  it('produces a β that feeds minimumVarianceDelta', () => {
    const beta = estimateVolatilitySpotBeta({ spot, impliedVolatility }).value.volatilitySpotBeta;
    const sNow = spot[spot.length - 1]!;
    const volatilityNow = impliedVolatility[impliedVolatility.length - 1]!;
    const mv = minimumVarianceDelta({
      type: 'call',
      spot: sNow,
      strike: Math.round(sNow), // ~ATM ⇒ vega (and the skew adjustment) is meaningful
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.03,
      volatility: volatilityNow,
      volatilitySpotBeta: beta,
    });
    // The MV delta applies exactly the skew adjustment vega·β (leverage ⇒ below the BSM delta for a call).
    expect(mv.value.volatilitySpotBeta).toBe(beta);
    expect(mv.value.minimumVarianceDelta).toBeCloseTo(
      mv.value.blackScholesDelta + mv.value.skewAdjustment,
      12,
    );
    expect(mv.value.skewAdjustment).toBeLessThan(0);
    expect(mv.value.minimumVarianceDelta).toBeLessThan(mv.value.blackScholesDelta);
  });

  it('the level basis gives ∂σ/∂S directly (a sample-average slope)', () => {
    const r = estimateVolatilitySpotBeta({ spot, impliedVolatility, basis: 'level' });
    expect(r.assumptions.basis).toBe('level');
    // For level basis the slope IS β; it is negative (leverage) and near b/S over the sample.
    expect(r.value.volatilitySpotBeta).toBe(r.value.slope);
    expect(r.value.volatilitySpotBeta).toBeLessThan(0);
    expect(r.value.volatilitySpotBeta).toBeGreaterThan(B_TRUE / S0); // between b/Smax and b/Smin
  });

  it('supports Newey–West HAC standard errors', () => {
    const impliedVolatilityNoisy = impliedVolatility.map((v, i) => v + 0.001 * Math.sin(i * 1.7));
    const r = estimateVolatilitySpotBeta({
      spot,
      impliedVolatility: impliedVolatilityNoisy,
      hacLags: 4,
    });
    expect(r.assumptions.hacLags).toBe(4);
    expect(r.value.slope).toBeCloseTo(B_TRUE, 2); // still recovers b within noise
    expect(Math.abs(r.value.slopeTStatistic)).toBeGreaterThan(2); // significant
  });

  it('warns on a small sample, an insignificant slope, and dropped observations', () => {
    // (a) A short series with a bad (negative) spot ⇒ dropped pairs + small-sample warnings.
    const bad = estimateVolatilitySpotBeta({
      spot: [100, 102, 101, 103, -1, 104, 99, 105, 98, 106],
      impliedVolatility: [0.2, 0.19, 0.21, 0.2, 0.198, 0.197, 0.196, 0.195, 0.194, 0.193],
    });
    expect(bad.value.dropped).toBeGreaterThan(0);
    expect(bad.diagnostics.warnings.some((w) => w.message.includes('dropped'))).toBe(true);
    expect(bad.diagnostics.warnings.some((w) => w.message.includes('low-power'))).toBe(true);

    // (b) Returns ⊥ IV changes by construction (log-return pattern ±d, IV-change pattern +,+,−,−) ⇒ slope
    // exactly 0 ⇒ t = 0 ⇒ the insignificance warning fires.
    const d = 0.02;
    const c = 0.005;
    const rPat = [d, -d, d, -d, d, -d, d, -d];
    const dPat = [c, c, -c, -c, c, c, -c, -c];
    const s = [100];
    const v = [0.2];
    for (let i = 0; i < rPat.length; i++) {
      s.push(s[i]! * Math.exp(rPat[i]!));
      v.push(v[i]! + dPat[i]!);
    }
    const insig = estimateVolatilitySpotBeta({ spot: s, impliedVolatility: v });
    expect(Math.abs(insig.value.slopeTStatistic)).toBeLessThan(2);
    expect(insig.diagnostics.warnings.some((w) => w.message.includes('insignificant'))).toBe(true);
  });

  it('guards its inputs', () => {
    expect(() => estimateVolatilitySpotBeta(undefined as never)).toThrowError();
    expect(() =>
      estimateVolatilitySpotBeta({ spot: [1, 2, 3], impliedVolatility: [0.2, 0.2] }),
    ).toThrowError(); // length
    expect(() =>
      estimateVolatilitySpotBeta({ spot: [100, 101], impliedVolatility: [0.2, 0.21] }),
    ).toThrowError(); // < 3 changes
    expect(() =>
      estimateVolatilitySpotBeta({ spot, impliedVolatility, basis: 'quad' as never }),
    ).toThrowError();
    expect(() =>
      estimateVolatilitySpotBeta({ spot, impliedVolatility, hacLags: -1 }),
    ).toThrowError();
    expect(() =>
      estimateVolatilitySpotBeta({ spot, impliedVolatility, hacLags: 1.5 }),
    ).toThrowError();
    expect(() =>
      estimateVolatilitySpotBeta({ spot, impliedVolatility, referenceSpot: -5 }),
    ).toThrowError();
    expect(() =>
      estimateVolatilitySpotBeta({ spot: undefined as never, impliedVolatility }),
    ).toThrowError();
  });
});
