import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import {
  type SVIParameters,
  calibrateSvi,
  sviButterflyFree,
  sviG,
  sviMinG,
  sviTotalVariance,
  sviVolatility,
} from '@totalfinance/volatility/svi';

// a realistic, arbitrage-free equity smile (negative skew)
const TRUE: SVIParameters = { a: 0.04, b: 0.4, rho: -0.4, m: 0.05, sigma: 0.15 };
const KS = [-0.5, -0.35, -0.2, -0.1, -0.03, 0, 0.05, 0.12, 0.22, 0.35, 0.5];
const W = KS.map((k) => sviTotalVariance(TRUE, k));

describe('raw SVI total variance / vol', () => {
  it('is positive, smooth, and convex in the wings', () => {
    expect(sviTotalVariance(TRUE, 0)).toBeGreaterThan(0);
    // minimum near the centre, rising into both wings
    const wMid = sviTotalVariance(TRUE, TRUE.m);
    expect(sviTotalVariance(TRUE, -0.5)).toBeGreaterThan(wMid);
    expect(sviTotalVariance(TRUE, 0.5)).toBeGreaterThan(wMid);
    // sviVolatility = √(w/t)
    expect(sviVolatility(TRUE, 0, 0.5)).toBeCloseTo(Math.sqrt(sviTotalVariance(TRUE, 0) / 0.5), 12);
  });
});

describe('calibrateSvi — Zeliade quasi-explicit calibration', () => {
  it('recovers the generating parameters from clean data (tiny RMSE)', () => {
    const fit = calibrateSvi({ k: KS, w: W });
    expect(fit.converged).toBe(true);
    expect(fit.rmse).toBeLessThan(1e-6);
    // the fitted curve matches the truth across the whole range
    for (const k of [-0.4, -0.1, 0, 0.15, 0.4]) {
      expect(sviTotalVariance(fit.parameters, k)).toBeCloseTo(sviTotalVariance(TRUE, k), 6);
    }
  });

  it('fits noisy data with a small but non-zero RMSE and stays arbitrage-free', () => {
    // deterministic pseudo-noise
    const wn = W.map((w, i) => w * (1 + 0.01 * Math.sin(i * 2.3)));
    const fit = calibrateSvi({ k: KS, w: wn });
    expect(fit.rmse).toBeGreaterThan(0);
    expect(fit.rmse).toBeLessThan(5e-3);
    expect(sviButterflyFree(fit.parameters)).toBe(true);
  });

  it('drives an arbitrageable target to an arbitrage-free fit and reports it honestly', () => {
    // sample total variance from a *butterfly-arbitrageable* SVI (steep skew), then refit:
    const bad: SVIParameters = { a: 0.02, b: 0.6, rho: -0.85, m: 0, sigma: 0.05 };
    expect(sviButterflyFree(bad)).toBe(false); // the target itself is arbitrageable
    const wn = KS.map((k) => sviTotalVariance(bad, k));
    const fit = calibrateSvi({ k: KS, w: wn });
    // the penalized calibration + 5-parameter refinement return an arbitrage-free slice
    expect(fit.butterflyFree).toBe(true);
    expect(fit.minButterflyG).toBeGreaterThanOrEqual(-1e-8);
    expect(fit.butterflyFree).toBe(sviButterflyFree(fit.parameters)); // result is self-consistent
  });

  it('reports butterflyFree=true for a clean arbitrage-free fit', () => {
    const fit = calibrateSvi({ k: KS, w: W });
    expect(fit.butterflyFree).toBe(true);
    expect(fit.minButterflyG).toBeGreaterThan(0);
  });

  it('rejects too few points or mismatched lengths', () => {
    expect(() => calibrateSvi({ k: [0, 0.1, 0.2], w: [0.04, 0.04, 0.05] })).toThrow(InputError);
    expect(() => calibrateSvi({ k: KS, w: W.slice(0, 5) })).toThrow(InputError);
  });
});

describe('Gatheral g(k) butterfly check', () => {
  it('is non-negative everywhere for an arbitrage-free slice', () => {
    for (const k of [-1, -0.5, 0, 0.5, 1]) expect(sviG(TRUE, k)).toBeGreaterThan(0);
    expect(sviButterflyFree(TRUE)).toBe(true);
  });

  it('detects a butterfly-arbitrageable slice (excessive curvature)', () => {
    // a huge b with tiny sigma creates a sharp kink → negative density near the centre
    const bad: SVIParameters = { a: 0.01, b: 2.5, rho: -0.9, m: 0, sigma: 0.02 };
    expect(sviButterflyFree(bad)).toBe(false);
  });
});

describe('WS2.11 — butterfly check spans the calibrated slice, not a fixed ±1 grid', () => {
  // g(k) is ≥ 0 across [-1, 1] but dips negative at k ≈ 1.1 (a wing density trough).
  const wingBad: SVIParameters = { a: 0.06, b: 0.584, rho: 0.4356, m: 0.288, sigma: 0.33 };
  const wideGrid = Array.from({ length: 200 }, (_, i) => -1.5 + (3 * i) / 199);

  it('the fixed ±1 grid misses a wing violation that a data-spanning grid catches', () => {
    // default ±1 grid: no violation seen (the honesty bug)
    expect(sviButterflyFree(wingBad)).toBe(true);
    expect(sviMinG(wingBad)).toBeGreaterThanOrEqual(-1e-8);
    // a grid that reaches the wing finds g(k) < 0
    expect(sviButterflyFree(wingBad, wideGrid)).toBe(false);
    expect(sviMinG(wingBad, wideGrid)).toBeLessThan(0);
  });

  it('calibrateSvi to a WIDE slice penalizes the wing trough (grid follows the data)', () => {
    // sample the arbitrageable slice out to |k| = 1.5 — the calibration grid now spans that range,
    // so the fit is driven arbitrage-free across the FULL data span (old code checked only ±1 and
    // would have left the wing trough in place while still reporting butterflyFree: true).
    const ks = Array.from({ length: 15 }, (_, i) => -1.5 + (3 * i) / 14);
    const ws = ks.map((k) => sviTotalVariance(wingBad, k));
    const fit = calibrateSvi({ k: ks, w: ws }, { maximumIterations: 600 });
    expect(fit.butterflyFree).toBe(true);
    // genuinely free across the wide data range, not just in [-1, 1]
    expect(sviMinG(fit.parameters, wideGrid)).toBeGreaterThanOrEqual(-1e-6);
  });

  it('a clean wide slice still calibrates butterfly-free', () => {
    const clean: SVIParameters = { a: 0.03, b: 0.12, rho: -0.3, m: 0, sigma: 0.25 };
    const ks = Array.from({ length: 13 }, (_, i) => -1.4 + (2.8 * i) / 12);
    const ws = ks.map((k) => sviTotalVariance(clean, k));
    const fit = calibrateSvi({ k: ks, w: ws });
    expect(fit.butterflyFree).toBe(true);
    expect(fit.minButterflyG).toBeGreaterThanOrEqual(-1e-8);
  });
});
