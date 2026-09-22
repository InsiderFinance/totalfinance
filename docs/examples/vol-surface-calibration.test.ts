/**
 * Runnable vol-surface calibration examples (spec §10.1). Each snippet executes in CI with
 * assertions so the SVI/SABR calibration and arbitrage-check docs cannot drift from working code.
 */

import { describe, expect, it } from 'vitest';
import { sabrVolatility } from '@insiderfinance/totalfinance/options/sabr';
import {
  type SVIParameters,
  calibrateSabrSmile,
  calibrateSvi,
} from '@insiderfinance/totalfinance/volatility';
import {
  sviButterflyFree,
  sviTotalVariance,
  sviVolatility,
} from '@insiderfinance/totalfinance/volatility/svi';

describe('docs: raw-SVI smile calibration', () => {
  it('fits five intuitive parameters to a market smile and stays arbitrage-free', () => {
    // observed total variance w = σ²·t at a set of log-moneyness points k = ln(K/F)
    const truth: SVIParameters = { a: 0.04, b: 0.4, rho: -0.4, m: 0.05, sigma: 0.15 };
    const k = [-0.5, -0.3, -0.15, -0.05, 0, 0.05, 0.15, 0.3, 0.5];
    const w = k.map((ki) => sviTotalVariance(truth, ki));

    const fit = calibrateSvi({ k, w });
    expect(fit.converged).toBe(true);
    expect(fit.rmse).toBeLessThan(1e-6);

    // the fitted slice prices a 25-delta-ish wing and is free of butterfly arbitrage
    expect(sviVolatility(fit.parameters, -0.2, 0.5)).toBeGreaterThan(
      sviVolatility(fit.parameters, 0, 0.5),
    ); // put skew
    expect(sviButterflyFree(fit.parameters)).toBe(true);
  });
});

describe('docs: SABR smile calibration', () => {
  it('recovers (α, ρ, ν) for a fixed backbone β', () => {
    const F = 100;
    const t = 0.5;
    const strikes = [80, 90, 95, 100, 105, 110, 120];
    const truth = { alpha: 0.25, beta: 1, rho: -0.5, nu: 0.6 };
    const impliedVolatilities = strikes.map((K) =>
      sabrVolatility({ input: { forward: F, strike: K, timeToExpiryYears: t }, parameters: truth }),
    );

    const fit = calibrateSabrSmile(
      { forward: F, strikes, impliedVolatilities, timeToExpiryYears: t },
      { beta: 1 },
    );
    expect(fit.rmse).toBeLessThan(1e-5);
    expect(fit.parameters.rho).toBeCloseTo(-0.5, 2);
  });
});
