/**
 * Tests for the Heston (global) and smoothed surface models, and the moneyness/delta axis accessors
 * (spec §10.1).
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import {
  type OptionQuote,
  type OptionType,
  optionExpiryToMs,
  yearFraction,
} from '@totalfinance/core';
import { type HestonParameters } from '@totalfinance/options';
import { hestonImpliedVolatility } from '@totalfinance/options/heston';
import {
  type ESSVIParameters,
  type HestonSurfaceTarget,
  type SSVIParameters,
  type SVIParameters,
  VolatilitySurface,
  calibrateHestonSurface,
  volatilitySurface,
} from '@totalfinance/volatility';
import { essviVolatility } from '@totalfinance/volatility/essvi';
import { ssviVolatility } from '@totalfinance/volatility/ssvi';
import { sviVolatility } from '@totalfinance/volatility/svi';

const asOf = Date.UTC(2026, 0, 1);
const spot = 100;
const rate = 0.03;
const E0 = '2026-04-02';
const E1 = '2026-07-02';
const tOf = (e: string): number => yearFraction(asOf, optionExpiryToMs(e), 'ACT/365F');
const fwdOf = (timeToExpiryYears: number): number => spot * Math.exp(rate * timeToExpiryYears);

function quote(
  type: OptionType,
  strike: number,
  expiry: string,
  impliedVolatility: number,
): OptionQuote {
  return {
    contract: {
      underlying: 'X',
      type,
      style: 'european',
      strike,
      expiry,
      ...resolvedExpiry(expiry),
    },
    timestampMs: asOf,
    impliedVolatility,
    underlyingPrice: spot,
  };
}

describe('VolatilitySurface model: heston (global calibration)', () => {
  const trueParams: HestonParameters = {
    v0: 0.04,
    kappa: 1.5,
    theta: 0.045,
    sigma: 0.3,
    rho: -0.6,
  };
  const STRIKES = [90, 95, 100, 105, 110];
  const chain = (): OptionQuote[] => {
    const rows: OptionQuote[] = [];
    for (const e of [E0, E1]) {
      const t = tOf(e);
      for (const k of STRIKES) {
        const impliedVolatility = hestonImpliedVolatility({
          type: 'call',
          input: { spot, strike: k, timeToExpiryYears: t, riskFreeRate: rate, dividendYield: 0 },
          parameters: trueParams,
        }).value;
        rows.push(quote('call', k, e, impliedVolatility));
      }
    }
    return rows;
  };

  it('calibrates one global parameter set and reprices the Heston-generated surface', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'heston', cosineExpansionTerms: 128 },
    });
    expect(surf.diagnostics.method).toBe('heston-cos+total-variance');
    expect(surf.heston).toBeDefined();
    // since the data was generated from a Heston model, the fit should reprice it tightly
    for (const e of [E0, E1]) {
      const t = tOf(e);
      for (const k of [95, 100, 105]) {
        const target = hestonImpliedVolatility({
          type: 'call',
          input: { spot, strike: k, timeToExpiryYears: t, riskFreeRate: rate, dividendYield: 0 },
          parameters: trueParams,
        }).value;
        expect(surf.impliedVolatility(k, e)).toBeCloseTo(target, 2); // within 0.005 vol
      }
    }
  });
});

describe('VolatilitySurface model: smoothed', () => {
  const P: SVIParameters = { a: 0.01, b: 0.07, rho: -0.4, m: 0, sigma: 0.08 };
  const STRIKES = [80, 85, 90, 95, 100, 105, 110, 115, 120];
  const chain = (): OptionQuote[] => {
    const t = tOf(E0);
    const F = fwdOf(t);
    return STRIKES.map((k) => quote('call', k, E0, sviVolatility(P, Math.log(k / F), t)));
  };

  it('produces a smooth smile bounded by the data, ≈ATM at the forward', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'smoothed' },
    });
    expect(surf.diagnostics.method).toBe('gaussian-kernel+total-variance');
    const t = tOf(E0);
    const F = fwdOf(t);
    const impliedVolatilities = STRIKES.map((k) => sviVolatility(P, Math.log(k / F), t));
    const lo = Math.min(...impliedVolatilities);
    const hi = Math.max(...impliedVolatilities);
    for (const k of [88, 97, 103, 112]) {
      const v = surf.impliedVolatility(k, E0);
      expect(v).toBeGreaterThanOrEqual(lo - 1e-9); // kernel average stays within the data range
      expect(v).toBeLessThanOrEqual(hi + 1e-9);
    }
    // near the ATM-forward the smoothed vol is close to the ATM input
    expect(surf.impliedVolatility(Math.round(F), E0)).toBeCloseTo(
      sviVolatility(P, Math.log(Math.round(F) / F), t),
      1,
    );
  });
});

describe('VolatilitySurface axes: moneyness & delta', () => {
  const P: SVIParameters = { a: 0.01, b: 0.07, rho: -0.5, m: 0, sigma: 0.08 };
  const STRIKES = [80, 85, 90, 95, 100, 105, 110, 115, 120];
  const surf = (): ReturnType<typeof volatilitySurface> => {
    const t = tOf(E0);
    const F = fwdOf(t);
    const rows = STRIKES.map((k) => quote('call', k, E0, sviVolatility(P, Math.log(k / F), t)));
    return volatilitySurface({
      quotes: rows,
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
  };

  it('moneyness axis: spot- and forward-moneyness map to the right strikes', () => {
    const s = surf();
    expect(s.impliedVolatilityByMoneyness(1, E0)).toBeCloseTo(s.impliedVolatility(spot, E0), 10); // K/S = 1 ⇒ strike = spot
    const F = fwdOf(tOf(E0));
    expect(s.impliedVolatilityByMoneyness(1, E0, { forward: true })).toBeCloseTo(
      s.impliedVolatility(F, E0),
      10,
    );
    expect(() => s.impliedVolatilityByMoneyness(0, E0)).toThrow(/moneyness/);
  });

  it('delta axis: 25Δ call sits at a higher strike (lower vol on a downward skew) than 75Δ', () => {
    const s = surf();
    const iv25 = s.impliedVolatilityByDelta(0.25, E0);
    const iv75 = s.impliedVolatilityByDelta(0.75, E0);
    expect(Number.isFinite(iv25)).toBe(true);
    expect(Number.isFinite(iv75)).toBe(true);
    // downward (ρ<0) skew ⇒ the lower-strike 75Δ call has higher IV than the 25Δ call
    expect(iv75).toBeGreaterThan(iv25);
    expect(() => s.impliedVolatilityByDelta(1.5, E0)).toThrow(/callDelta/);
  });
});

describe('calibrateHestonSurface — convergence gate (WS2.10c)', () => {
  const trueParams: HestonParameters = {
    v0: 0.04,
    kappa: 1.5,
    theta: 0.045,
    sigma: 0.3,
    rho: -0.6,
  };
  const targets = (): HestonSurfaceTarget[] => {
    const rows: HestonSurfaceTarget[] = [];
    for (const e of [E0, E1]) {
      const t = tOf(e);
      const forward = fwdOf(t);
      for (const k of [95, 100, 105]) {
        const impliedVolatility = hestonImpliedVolatility({
          type: 'call',
          input: { spot, strike: k, timeToExpiryYears: t, riskFreeRate: rate, dividendYield: 0 },
          parameters: trueParams,
        }).value;
        rows.push({
          strike: k,
          timeToExpiryYears: t,
          impliedVolatility,
          forward,
        });
      }
    }
    return rows;
  };

  it('echoes the rmseTolerance the converged flag was gated on (default 0.02)', () => {
    const fit = calibrateHestonSurface({
      targets: targets(),
      market: { spot, riskFreeRate: rate, dividendYield: 0 },
      options: { terms: 96, maximumIterations: 200 },
    });
    expect(fit.rmseTolerance).toBe(0.02);
    // data generated from a Heston model ⇒ the fit reprices it well within the default tolerance
    expect(fit.rmse).toBeLessThan(0.02);
  });

  it('a stricter rmseTolerance is echoed and gates convergence', () => {
    const fit = calibrateHestonSurface({
      targets: targets(),
      market: { spot, riskFreeRate: rate, dividendYield: 0 },
      options: {
        terms: 96,
        maximumIterations: 200,
        rmseTolerance: 1e-9,
      },
    });
    expect(fit.rmseTolerance).toBe(1e-9);
    // an essentially-unreachable tolerance ⇒ converged is false even though the fit is good
    expect(fit.converged).toBe(false);
  });
});

describe('calibrateHestonSurface options hardening (deep-sweep boundary)', () => {
  it('rejects a null options bag instead of dying on the first option read', () => {
    // `null` slips past the `= {}` default parameter (only `undefined` triggers it).
    const targets: HestonSurfaceTarget[] = [
      { strike: 95, timeToExpiryYears: 0.25, impliedVolatility: 0.22, forward: 100.75 },
      { strike: 100, timeToExpiryYears: 0.25, impliedVolatility: 0.2, forward: 100.75 },
    ];
    expect(() =>
      calibrateHestonSurface({
        targets,
        market: { spot, riskFreeRate: rate, dividendYield: 0 },
        options: null as never,
      }),
    ).toThrow(/calibrateHestonSurface: options must be an object/);
  });
});

describe('VolatilitySurface model: ssvi (global arbitrage-free surface SVI)', () => {
  const trueParams: SSVIParameters = {
    rho: -0.3,
    phi: { kind: 'power-law', eta: 1, gamma: 0.5 },
    thetaTerm: [
      { timeToExpiryYears: tOf(E0), theta: 0.04 * tOf(E0) },
      { timeToExpiryYears: tOf(E1), theta: 0.04 * tOf(E1) },
    ],
  };
  const STRIKES = [85, 92, 100, 108, 116];
  const chain = (): OptionQuote[] => {
    const rows: OptionQuote[] = [];
    for (const e of [E0, E1]) {
      const t = tOf(e);
      const F = fwdOf(t);
      for (const K of STRIKES)
        rows.push(quote('call', K, e, ssviVolatility(trueParams, Math.log(K / F), t)));
    }
    return rows;
  };

  it('calibrates one global SSVI set, is a faithful wrapper, and recovers the surface', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'ssvi' },
    });
    expect(surf.diagnostics.method).toBe('ssvi-global+total-variance');
    expect(surf.ssvi).toBeDefined();
    expect(surf.diagnostics.converged).toBe(true);
    for (const e of [E0, E1]) {
      const t = tOf(e);
      const F = fwdOf(t);
      for (const K of STRIKES) {
        // The surface faithfully evaluates its own calibrated parameters...
        expect(surf.impliedVolatility(K, e)).toBeCloseTo(
          ssviVolatility(surf.ssvi!, Math.log(K / F), t),
          10,
        );
        // ...and the calibration reproduces the generating SSVI surface (within a few vol bp).
        expect(surf.impliedVolatility(K, e)).toBeCloseTo(
          ssviVolatility(trueParams, Math.log(K / F), t),
          2,
        );
      }
    }
  });

  it('is calendar-arbitrage-free (SSVI monotone-θ guarantee)', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'ssvi' },
    });
    expect(surf.arbitrage().checks.calendar).toBe(true);
    // θ knots are strictly increasing (the no-calendar-arb structure).
    const th = surf.ssvi!.thetaTerm;
    for (let i = 1; i < th.length; i++) expect(th[i]!.theta).toBeGreaterThan(th[i - 1]!.theta);
  });

  it('round-trips through toJSON/fromJSON impliedVolatility-identically (parameters deep-copied, not aliased)', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'ssvi' },
    });
    const restored = VolatilitySurface.fromJSON(surf.toJSON());
    expect(restored.ssvi).toBeDefined();
    expect(restored.diagnostics.method).toBe('ssvi-global+total-variance');
    for (const e of [E0, E1])
      for (const K of STRIKES)
        expect(restored.impliedVolatility(K, e)).toBe(surf.impliedVolatility(K, e));
    // The snapshot is an INDEPENDENT value: mutating the restored parameters must not touch the live surface.
    restored.ssvi!.thetaTerm[0]!.theta = 999;
    expect(surf.ssvi!.thetaTerm[0]!.theta).not.toBe(999);
  });

  it('shock degrades a parametric ssvi surface to interpolated, shifted', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'ssvi' },
    });
    const shocked = surf.shock({ parallel: 0.015 });
    expect(shocked.model).toBe('interpolated');
    expect(
      shocked.diagnostics.warnings.some(
        (w) => w.code === 'volatility.shock_degraded_to_interpolated',
      ),
    ).toBe(true);
    expect(shocked.impliedVolatility(100, E0) - surf.impliedVolatility(100, E0)).toBeCloseTo(
      0.015,
      6,
    );
  });

  it('accepts the heston curvature family via ssviPhi', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'ssvi', ssviPhi: 'heston' },
    });
    expect(surf.ssvi).toBeDefined();
    expect(surf.ssvi!.phi.kind).toBe('heston');
  });

  it('threads ssviWeight through to the calibration', () => {
    // A fat-wing chain (deep-OTM volatilities biased up) so vega weighting visibly changes the calibrated fit.
    const fatWing = (): OptionQuote[] => {
      const rows: OptionQuote[] = [];
      for (const e of [E0, E1]) {
        const t = tOf(e);
        const F = fwdOf(t);
        for (const K of [70, 85, 100, 118, 140]) {
          const k = Math.log(K / F);
          rows.push(
            quote('call', K, e, ssviVolatility(trueParams, k, t) + (Math.abs(k) >= 0.3 ? 0.03 : 0)),
          );
        }
      }
      return rows;
    };
    const uni = volatilitySurface({
      quotes: fatWing(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'ssvi' },
    });
    const veg = volatilitySurface({
      quotes: fatWing(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'ssvi', ssviWeight: 'vega' },
    });
    expect(veg.ssvi).toBeDefined();
    expect(veg.ssvi!.rho).not.toBe(uni.ssvi!.rho); // the weight flowed through and changed the fit
  });
});

describe('VolatilitySurface model: essvi (global, per-maturity skew)', () => {
  // A steep short-dated skew (ρ = −0.6) and a mild long-dated one (ρ = −0.2) — the eSSVI payoff.
  const EL = '2026-10-02';
  const tL = tOf(EL);
  const trueParams: ESSVIParameters = {
    phi: { kind: 'power-law', eta: 1, gamma: 0.5 },
    thetaTerm: [
      { timeToExpiryYears: tOf(E0), theta: 0.04 * tOf(E0), rho: -0.6 },
      { timeToExpiryYears: tL, theta: 0.04 * tL, rho: -0.2 },
    ],
  };
  const STRIKES = [82, 91, 100, 110, 120];
  const chain = (): OptionQuote[] => {
    const rows: OptionQuote[] = [];
    for (const e of [E0, EL]) {
      const t = tOf(e);
      const F = fwdOf(t);
      for (const K of STRIKES)
        rows.push(quote('call', K, e, essviVolatility(trueParams, Math.log(K / F), t)));
    }
    return rows;
  };

  it('calibrates one global eSSVI set, is a faithful wrapper, and recovers the per-maturity skew', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'essvi' },
    });
    expect(surf.diagnostics.method).toBe('essvi-global+total-variance');
    expect(surf.essvi).toBeDefined();
    expect(surf.diagnostics.converged).toBe(true);
    // The fitted skew term structure recovers the steep-short / mild-long ρ(θ).
    const rhos = surf.essvi!.thetaTerm.map((x) => x.rho);
    expect(rhos[0]).toBeCloseTo(-0.6, 1);
    expect(rhos[1]).toBeCloseTo(-0.2, 1);
    expect(rhos[0]).toBeLessThan(rhos[1]!); // short skew is steeper (more negative) than long
    for (const e of [E0, EL]) {
      const t = tOf(e);
      const F = fwdOf(t);
      for (const K of STRIKES) {
        expect(surf.impliedVolatility(K, e)).toBeCloseTo(
          essviVolatility(surf.essvi!, Math.log(K / F), t),
          10,
        ); // faithful
        expect(surf.impliedVolatility(K, e)).toBeCloseTo(
          essviVolatility(trueParams, Math.log(K / F), t),
          2,
        ); // recovers surface
      }
    }
  });

  it('fits a differing short/long skew better than a single-ρ ssvi surface on the same chain', () => {
    const essviSurf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'essvi' },
    });
    const ssviSurf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'ssvi' },
    });
    const sse = (surf: ReturnType<typeof volatilitySurface>): number => {
      let s = 0;
      for (const e of [E0, EL]) {
        const t = tOf(e);
        const F = fwdOf(t);
        for (const K of STRIKES)
          s +=
            (surf.impliedVolatility(K, e) - essviVolatility(trueParams, Math.log(K / F), t)) ** 2;
      }
      return s;
    };
    // The per-maturity skew captures the steep-short/mild-long structure a single global ρ cannot.
    expect(sse(essviSurf)).toBeLessThan(sse(ssviSurf));
  });

  it('round-trips through toJSON/fromJSON impliedVolatility-identically and shock-degrades to interpolated', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'essvi' },
    });
    const restored = VolatilitySurface.fromJSON(surf.toJSON());
    expect(restored.essvi).toBeDefined();
    for (const e of [E0, EL])
      for (const K of STRIKES)
        expect(restored.impliedVolatility(K, e)).toBe(surf.impliedVolatility(K, e));
    // Deep-copied, not aliased.
    restored.essvi!.thetaTerm[0]!.rho = 0.99;
    expect(surf.essvi!.thetaTerm[0]!.rho).not.toBe(0.99);
    // Shock degrades a parametric essvi surface to interpolated.
    const shocked = surf.shock({ parallel: 0.01 });
    expect(shocked.model).toBe('interpolated');
    expect(
      shocked.diagnostics.warnings.some(
        (w) => w.code === 'volatility.shock_degraded_to_interpolated',
      ),
    ).toBe(true);
  });

  it('accepts the heston curvature family via essviPhi', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'essvi', essviPhi: 'heston' },
    });
    expect(surf.essvi).toBeDefined();
    expect(surf.essvi!.phi.kind).toBe('heston');
  });

  it('threads essviWeight through to the calibration', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'essvi', essviWeight: 'vega' },
    });
    expect(surf.essvi).toBeDefined();
    expect(surf.diagnostics.method).toBe('essvi-global+total-variance');
  });
});
