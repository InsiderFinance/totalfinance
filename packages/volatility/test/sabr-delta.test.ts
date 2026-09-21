/**
 * SABR Bartlett (minimum-variance) greeks (`sabrBartlettGreeks`). The defining property: the Bartlett delta
 * and vega equal the finite difference of the SABR reprice under the *correlated* forward/vol bump implied by
 * ρ — the minimum-variance hedges. Also pinned: the ρ-sign of the adjustment (equity skew lowers a call's
 * delta), ρ = 0 ⇒ Bartlett = naive, the normal (Bachelier) backbone, the decomposition, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { sabrBartlettGreeks } from '@totalfinance/volatility';
import { sabrPrice } from '@totalfinance/options/sabr';

const PARAMS = { alpha: 0.2 * Math.sqrt(100), beta: 0.5, rho: -0.3, nu: 0.4 } as const;
const INPUT = { forward: 100, strike: 100, timeToExpiryYears: 1.0 } as const;

// A correlated-bump SABR reprice: bump F by δF and α by (ρν/F^β)·δF together, then finite-difference.
const correlatedBumpDelta = (
  input: { forward: number; strike: number; timeToExpiryYears: number },
  parameters: { alpha: number; beta: number; rho: number; nu: number },
  volatilityType: 'lognormal' | 'normal' = 'lognormal',
): number => {
  const F = input.forward;
  const dF = F * 1e-4;
  const couple = (parameters.rho * parameters.nu) / Math.pow(F, parameters.beta);
  const price = (f: number, a: number): number =>
    sabrPrice({
      type: 'call',
      input: { ...input, forward: f },
      parameters: { ...parameters, alpha: a },
      options: { volatilityType, greeks: false },
    }).value;
  return (
    (price(F + dF, parameters.alpha + couple * dF) -
      price(F - dF, parameters.alpha - couple * dF)) /
    (2 * dF)
  );
};

describe('sabrBartlettGreeks', () => {
  it('the Bartlett delta equals the correlated-bump SABR reprice', () => {
    const r = sabrBartlettGreeks({ type: 'call', input: INPUT, parameters: PARAMS });
    const fd = correlatedBumpDelta(INPUT, PARAMS);
    expect(r.value.bartlettDelta).toBeCloseTo(fd, 6);
    // The naive (parameters-fixed) delta is materially different from the min-variance one.
    expect(Math.abs(r.value.sabrDelta - r.value.bartlettDelta)).toBeGreaterThan(1e-3);
    // Decomposition invariant.
    expect(r.value.deltaAdjustment).toBeCloseTo(r.value.bartlettDelta - r.value.sabrDelta, 12);
    expect(r.value.vegaAdjustment).toBeCloseTo(r.value.bartlettVega - r.value.sabrVega, 12);
    expect(r.assumptions.measure).toBe('min-variance-hedge');
    expect(r.assumptions.model).toBe('sabr');
    expect(r.assumptions.volatilityType).toBe('lognormal');
  });

  it('the Bartlett vega equals the correlated-bump α reprice', () => {
    const r = sabrBartlettGreeks({ type: 'call', input: INPUT, parameters: PARAMS });
    // Bump α by δα, co-move F by (ρF^β/ν)·δα, finite-difference. Compare in raw (per 1.00 α) units.
    const F = INPUT.forward;
    const dA = 1e-4;
    const coupleF = (PARAMS.rho * Math.pow(F, PARAMS.beta)) / PARAMS.nu;
    const price = (f: number, a: number): number =>
      sabrPrice({
        type: 'call',
        input: { ...INPUT, forward: f },
        parameters: { ...PARAMS, alpha: a },
        options: { greeks: false },
      }).value;
    const fdRaw =
      (price(F + coupleF * dA, PARAMS.alpha + dA) - price(F - coupleF * dA, PARAMS.alpha - dA)) /
      (2 * dA);
    expect(r.value.bartlettVega * 100).toBeCloseTo(fdRaw, 4); // display → raw
  });

  it('the Bartlett gamma equals the analytic total derivative along the correlated path', () => {
    // Independent cross-check: Γ_B = V_FF + 2c·V_Fα + c²·V_αα + V_α·(dc/dF), c = ρν/F^β, dc/dF = −βc/F.
    const analyticBartlettGamma = (
      F: number,
      K: number,
      T: number,
      p: { alpha: number; beta: number; rho: number; nu: number },
    ): number => {
      const price = (f: number, a: number): number =>
        sabrPrice({
          type: 'call',
          input: { forward: f, strike: K, timeToExpiryYears: T },
          parameters: { ...p, alpha: a },
          options: { greeks: false },
        }).value;
      const c = (p.rho * p.nu) / Math.pow(F, p.beta);
      const dc = (-p.beta * c) / F;
      const hF = F * 1e-3;
      const hA = 1e-3;
      const vFF =
        (price(F + hF, p.alpha) - 2 * price(F, p.alpha) + price(F - hF, p.alpha)) / (hF * hF);
      const vA = (price(F, p.alpha + hA) - price(F, p.alpha - hA)) / (2 * hA);
      const vAA =
        (price(F, p.alpha + hA) - 2 * price(F, p.alpha) + price(F, p.alpha - hA)) / (hA * hA);
      const vFA =
        (price(F + hF, p.alpha + hA) -
          price(F + hF, p.alpha - hA) -
          price(F - hF, p.alpha + hA) +
          price(F - hF, p.alpha - hA)) /
        (4 * hF * hA);
      return vFF + 2 * c * vFA + c * c * vAA + vA * dc;
    };
    for (const K of [80, 100, 120]) {
      const r = sabrBartlettGreeks({
        type: 'call',
        input: { forward: 100, strike: K, timeToExpiryYears: 1.0 },
        parameters: PARAMS,
      });
      const analytic = analyticBartlettGamma(100, K, 1.0, PARAMS);
      expect(Math.abs(r.value.bartlettGamma - analytic) / Math.abs(analytic)).toBeLessThan(1e-3);
      // Decomposition invariant.
      expect(r.value.gammaAdjustment).toBeCloseTo(r.value.bartlettGamma - r.value.sabrGamma, 15);
    }
    // β = 1 uses the log path (no 1/(1−β) blow-up) and stays finite.
    const b1 = sabrBartlettGreeks({
      type: 'call',
      input: { forward: 100, strike: 90, timeToExpiryYears: 1.0 },
      parameters: {
        alpha: 0.2,
        beta: 1,
        rho: -0.4,
        nu: 0.5,
      },
    });
    expect(Number.isFinite(b1.value.bartlettGamma)).toBe(true);
    expect(b1.value.bartlettGamma).toBeGreaterThan(0);
  });

  it('the gamma adjustment is ≈ 0 at the money and material in the wings', () => {
    const adj = (K: number): number => {
      const r = sabrBartlettGreeks({
        type: 'call',
        input: { forward: 100, strike: K, timeToExpiryYears: 1.0 },
        parameters: PARAMS,
      });
      return r.value.gammaAdjustment / r.value.sabrGamma;
    };
    // At the money the correlated-path convexity correction cancels (gamma is at its symmetric peak).
    expect(Math.abs(adj(100))).toBeLessThan(0.01);
    // In the wings it is material and ρ-signed: for ρ < 0, below the forward the Bartlett gamma exceeds the
    // naive gamma, above it falls short.
    expect(adj(80)).toBeGreaterThan(0.1);
    expect(adj(120)).toBeLessThan(-0.1);
  });

  it('the adjustment tracks ρ and vanishes at ρ = 0', () => {
    const delta = (rho: number): { sabr: number; bartlett: number } => {
      const r = sabrBartlettGreeks({ type: 'call', input: INPUT, parameters: { ...PARAMS, rho } });
      return { sabr: r.value.sabrDelta, bartlett: r.value.bartlettDelta };
    };
    const neg = delta(-0.5);
    const zero = delta(0);
    const pos = delta(0.5);
    // Equity skew (ρ < 0) lowers a call's effective delta; ρ > 0 raises it.
    expect(neg.bartlett).toBeLessThan(neg.sabr);
    expect(pos.bartlett).toBeGreaterThan(pos.sabr);
    // No correlation ⇒ no adjustment (Bartlett = naive).
    expect(zero.bartlett).toBeCloseTo(zero.sabr, 12);
  });

  it('supports the normal (Bachelier) backbone and resolves a forward from spot', () => {
    const r = sabrBartlettGreeks({
      type: 'call',
      input: { forward: 100, strike: 100, timeToExpiryYears: 1.0 },
      parameters: { alpha: 2, beta: 0, rho: -0.3, nu: 0.4 },
      options: { volatilityType: 'normal' },
    });
    expect(r.assumptions.volatilityType).toBe('normal');
    expect(r.value.bartlettDelta).toBeCloseTo(
      correlatedBumpDelta(
        { forward: 100, strike: 100, timeToExpiryYears: 1.0 },
        { alpha: 2, beta: 0, rho: -0.3, nu: 0.4 },
        'normal',
      ),
      5,
    );
    // spot (+ rate) resolves to a forward.
    const rs = sabrBartlettGreeks({
      type: 'call',
      input: { spot: 100, riskFreeRate: 0.05, timeToExpiryYears: 1.0, strike: 105 },
      parameters: PARAMS,
    });
    expect(Number.isFinite(rs.value.bartlettDelta)).toBe(true);
    expect(rs.value.impliedVolatility).toBeGreaterThan(0);
  });

  it('guards its inputs', () => {
    expect(() =>
      sabrBartlettGreeks({ type: 'buy' as never, input: INPUT, parameters: PARAMS }),
    ).toThrowError();
    expect(() =>
      sabrBartlettGreeks({ type: 'call', input: undefined as never, parameters: PARAMS }),
    ).toThrowError();
    expect(() =>
      sabrBartlettGreeks({ type: 'call', input: INPUT, parameters: undefined as never }),
    ).toThrowError();
    // ν = 0: no vol-of-vol ⇒ no min-variance coupling; a typed error, not a divide-by-zero.
    expect(() =>
      sabrBartlettGreeks({ type: 'call', input: INPUT, parameters: { ...PARAMS, nu: 0 } }),
    ).toThrowError();
    // Neither forward nor spot.
    expect(() =>
      sabrBartlettGreeks({
        type: 'call',
        input: { strike: 100, timeToExpiryYears: 1.0 } as never,
        parameters: PARAMS,
      }),
    ).toThrowError();
    // Bad SABR parameters flow through to sabrPrice/sabrVolatility validation.
    expect(() =>
      sabrBartlettGreeks({ type: 'call', input: INPUT, parameters: { ...PARAMS, rho: 1.5 } }),
    ).toThrowError();
    // A garbage (non-object) options must not raw-crash — it falls back to the default volatilityType.
    expect(
      () =>
        sabrBartlettGreeks({
          type: 'call',
          input: INPUT,
          parameters: PARAMS,
          options: null as never,
        }),
      // Null is not omission (the 350c2796 ruling): this assertion used to pin null-as-absent in
      // place, which is how the class survived.
    ).toThrow(/options must be an object/);
  });
});
