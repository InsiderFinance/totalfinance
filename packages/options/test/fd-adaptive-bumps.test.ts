import { describe, expect, it } from 'vitest';
import { engines, market, option } from '@totalfinance/options';
import { resolveFdSteps } from '../src/engines/fd-greeks.js';
import { sabrPrice } from '@totalfinance/options/sabr';
import { hestonPrice } from '@totalfinance/options/heston';

/**
 * Spec P2.3 — adaptive finite-difference bumps near boundaries, with the ACTUAL bump sizes
 * disclosed in `diagnostics.finiteDifferenceBumps`. The failure this prevents: a fixed `volatilityStep = 1e-3` bumping a
 * tiny vol NEGATIVE (σ − h < 0), handing the pricer an impossible state mid-difference.
 */

const CONTRACT = option.usEquityCall({ underlying: 'X', strike: 100, expiry: '2026-12-18' });
const mkt = (volatility: number) =>
  market({ spot: 100, riskFreeRate: 0.04, volatility, asOf: '2026-07-20T00:00:00Z' });

describe('resolveFdSteps (the one source of truth)', () => {
  const base = { spot: 100, T: 0.5, r: 0.04, q: 0 };

  it('caps the vol bump at σ/100 below σ = 0.1 and keeps 1e-3 above it', () => {
    expect(resolveFdSteps({ ...base, sigma: 0.2 }).volatilityStep).toBe(1e-3);
    expect(resolveFdSteps({ ...base, sigma: 0.05 }).volatilityStep).toBeCloseTo(5e-4, 18);
    expect(resolveFdSteps({ ...base, sigma: 2e-3 }).volatilityStep).toBeCloseTo(2e-5, 18);
    // σ − volatilityStep stays strictly positive at any positive level.
    const tiny = resolveFdSteps({ ...base, sigma: 1e-6 });
    expect(1e-6 - tiny.volatilityStep).toBeGreaterThan(0);
  });

  it('caps the spot bump at a hundredth of the terminal standard deviation S·σ√T', () => {
    // Ordinary contracts keep the S·1e-3 reference (σ√T/100 = 1.4e-3 > 1e-3 here).
    expect(resolveFdSteps({ ...base, sigma: 0.2 }).spotStep).toBeCloseTo(0.1, 15);
    // One day at 1% vol: S·σ√T ≈ 0.0523, so the bump is 5.23e-4 instead of 0.1 (twice the width).
    const oneDay = resolveFdSteps({ ...base, T: 1 / 365, sigma: 0.01 });
    expect(oneDay.spotStep).toBeCloseTo((100 * 0.01 * Math.sqrt(1 / 365)) / 100, 15);
    // Scale invariance: the relative bump depends on σ√T only (equal to rounding).
    const millionSpot = resolveFdSteps({ ...base, spot: 1e6, T: 1 / 365, sigma: 0.01 });
    expect(millionSpot.spotStep / 1e6).toBeCloseTo(oneDay.spotStep / 100, 18);
    // The roundoff floor (1e-8 of the spot) binds only at an essentially deterministic σ√T.
    expect(resolveFdSteps({ ...base, T: 1e-6, sigma: 1e-4 }).spotStep).toBeCloseTo(1e-6, 18);
    // Shift mode (σ = 0) carries no width: the reference bump stays.
    expect(resolveFdSteps({ ...base, sigma: 0 }).spotStep).toBeCloseTo(0.1, 15);
  });

  it('caps the rate and carry bumps at a hundredth of σ/√T, the one-standard-deviation drift', () => {
    expect(resolveFdSteps({ ...base, sigma: 0.2 }).rateStep).toBe(1e-4);
    expect(resolveFdSteps({ ...base, sigma: 0.2 }).dividendYieldStep).toBe(1e-5);
    const longLowVol = resolveFdSteps({ ...base, T: 10, sigma: 0.01 });
    expect(longLowVol.rateStep).toBeCloseTo(0.01 / Math.sqrt(10) / 100, 18);
    expect(longLowVol.dividendYieldStep).toBe(1e-5);
    expect(resolveFdSteps({ ...base, sigma: 0 }).rateStep).toBe(1e-4);
  });

  it('caps the time bump at T/100 under its ceiling; explicit steps always win', () => {
    expect(resolveFdSteps({ ...base, T: 1e-3, sigma: 0.2 }).timeStepYears).toBeCloseTo(1e-5, 18);
    expect(resolveFdSteps({ ...base, sigma: 0.2 }).timeStepYears).toBe(1e-3);
    expect(
      resolveFdSteps({ ...base, sigma: 0.2 }, {}, { maximumTimeStepYears: 1e-4 }).timeStepYears,
    ).toBe(1e-4);
    expect(resolveFdSteps({ ...base, sigma: 0.2 }, { volatilityStep: 7e-4 }).volatilityStep).toBe(
      7e-4,
    );
    expect(
      resolveFdSteps({ ...base, T: 1e-3, sigma: 0.2 }, { timeStepYears: 2e-4 }).timeStepYears,
    ).toBe(2e-4);
  });
});

describe('FD engines at a tiny vol (the σ − h > 0 law)', () => {
  // The extended-Greek probes below run on Leisen–Reimer rather than the CRR default for two
  // independent reasons, both established by the 2026-08 defect-fix wave: (1) a spot-anchored CRR
  // lattice at σ = 5e-4 with r = 4% has a risk-neutral probability of 1.79 — it now REFUSES to price
  // (asserted directly below) instead of rolling back a meaningless sum; (2) only the strike-anchored
  // LR lattice still claims `extendedGreeks`. The bump law under test is unchanged.
  const tinyVolEngine = engines.binomial({ variant: 'leisen-reimer' });

  it('binomial extended Greeks at σ = 5e-4 are all finite (no negative-vol pricer calls)', () => {
    const r = tinyVolEngine.price({
      contract: CONTRACT,
      market: mkt(5e-4),
      options: { extendedGreeks: true },
    });
    const g = r.greeks as unknown as Record<string, number | null>;
    for (const [name, v] of Object.entries(g)) {
      if (v === null) continue; // lambda may be null by contract — never NaN
      expect(Number.isFinite(v), `${name}=${String(v)}`).toBe(true);
    }
  });

  it('the spot-anchored CRR lattice refuses that same σ instead of rolling back an unstable tree', () => {
    // |r − q|·√dt = 0.04·0.032 ≫ σ = 5e-4 ⇒ p = 1.79. Pre-fix this returned a finite "price".
    expect(() =>
      engines
        .binomial()
        .price({ contract: CONTRACT, market: mkt(5e-4), options: { greeks: false } }),
    ).toThrow(/probability p=1\.79/);
  });

  it('the actually-used bumps ride diagnostics.finiteDifferenceBumps and honor the boundary rule', () => {
    const vol = 2e-3;
    const r = tinyVolEngine.price({
      contract: CONTRACT,
      market: mkt(vol),
      options: { extendedGreeks: true },
    });
    const bumps = r.diagnostics.finiteDifferenceBumps!;
    expect(bumps).toBeDefined();
    expect(bumps['volatilityStep']).toBeCloseTo(vol / 100, 18);
    expect(bumps['spotStep']).toBeGreaterThan(0);
    expect(bumps['timeStepYears']).toBeGreaterThan(0);
    expect(bumps['dividendYieldStep']).toBeDefined(); // extended set bumps the carry too
    // A comfortable vol keeps the reference 1e-3 bump — and says so.
    const rSquared = engines
      .binomial()
      .price({ contract: CONTRACT, market: mkt(0.2), options: { greeks: true } });
    expect(rSquared.diagnostics.finiteDifferenceBumps!['volatilityStep']).toBe(1e-3);
    expect(rSquared.diagnostics.finiteDifferenceBumps!['dividendYieldStep']).toBeUndefined(); // first-order set never bumps q
    // CRR's spot Greeks are NATIVE now, so no spot/time bump is taken — and none is claimed.
    expect(rSquared.diagnostics.finiteDifferenceBumps!['spotStep']).toBeUndefined();
  });

  it('greeks: false reports no finiteDifferenceBumps (nothing was differenced)', () => {
    const r = engines
      .binomial()
      .price({ contract: CONTRACT, market: mkt(0.2), options: { greeks: false } });
    expect(r.diagnostics.finiteDifferenceBumps).toBeUndefined();
  });

  it('vega is continuous through the adaptive-bump boundary (no regime jump at σ = 0.1)', () => {
    // At-the-FORWARD strike: as σ → 0, d₁ → σ√T/2 ≈ 0, so vega ≈ S√T·φ(0)/100 stays at a stable,
    // meaningful scale — away from the forward, tiny-vol vega underflows toward 0 and a relative
    // jump metric measures numeric noise, not the bump-size regime.
    const T =
      (Date.parse('2026-12-18T21:00:00Z') - Date.parse('2026-07-20')) / (365.25 * 86_400_000);
    const kFwd = 100 * Math.exp(0.04 * T);
    const atFwd = option.european({
      convention: 'us-equity-close',
      type: 'call',
      underlying: 'X',
      strike: kFwd,
      expiry: '2026-12-18',
    });
    const vega = (volatility: number) =>
      (
        engines
          .binomial()
          .price({ contract: atFwd, market: mkt(volatility), options: { greeks: true } })
          .greeks as { vega: number }
      ).vega;
    // Sample across the volatilityStep switch point (σ/100 below 0.1, fixed 1e-3 above it), and
    // through the tiny-vol range where the bump is a hundredth of the level.
    const volatilities = [3.6e-3, 4.0e-3, 4.4e-3, 0.09, 0.095, 0.1, 0.105, 0.11];
    const vegas = volatilities.map(vega);
    for (const v of vegas) expect(Number.isFinite(v)).toBe(true);
    for (let i = 1; i < vegas.length; i++) {
      const step = Math.abs(vegas[i]! - vegas[i - 1]!);
      const scale = Math.max(Math.abs(vegas[i]!), Math.abs(vegas[i - 1]!), 1e-12);
      expect(
        step / scale,
        `jump between σ=${volatilities[i - 1]} and σ=${volatilities[i]}`,
      ).toBeLessThan(0.1);
    }
  });
});

describe('engine-specific rate floors still override the scale-aware rate bump', () => {
  it('Jarrow–Rudd differences rho across at least one node spacing: σ/√(steps·T)', () => {
    const steps = 501;
    const contract = option.usEquityPut({ underlying: 'X', strike: 100, expiry: '2026-12-18' });
    for (const volatility of [0.2, 0.002]) {
      const result = engines
        .binomial({ variant: 'jarrow-rudd', steps })
        .price({ contract, market: mkt(volatility), options: { greeks: true } });
      const T = result.assumptions.timeToExpiryYears!;
      const floor = volatility / Math.sqrt(steps * T);
      const scaleAware = Math.min(1e-4, volatility / Math.sqrt(T) / 100);
      expect(floor).toBeGreaterThan(scaleAware);
      expect(result.diagnostics.finiteDifferenceBumps!['rateStep']).toBe(floor);
    }
  });
});

describe('shift-mode models scale the vol bump to their own level', () => {
  it('SABR extended Greeks with a tiny α stay finite (α + shift never crosses zero)', () => {
    const r = sabrPrice({
      type: 'call',
      input: { forward: 100, strike: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.04 },
      parameters: { alpha: 2e-3, beta: 1, rho: -0.2, nu: 0.4 },
      options: { extendedGreeks: true },
    });
    const g = r.greeks as unknown as Record<string, number | null>;
    expect(g).toBeDefined();
    for (const [name, v] of Object.entries(g)) {
      if (v === null) continue;
      expect(Number.isFinite(v), `${name}=${String(v)}`).toBe(true);
    }
  });

  it('Heston at a TINY vol level actually triggers the scaled bump (√v₀/4 < 1e-3) and stays finite', () => {
    // √v₀ = √(1e-5) ≈ 3.16e-3 < 4e-3, so the level-scaled bump (√v₀/4 ≈ 7.9e-4) is SMALLER than
    // the 1e-3 default — this exercises the adaptation itself, not just the default path, and
    // the actually-used size is disclosed in diagnostics.finiteDifferenceBumps.
    const v0 = 1e-5;
    const r = hestonPrice({
      type: 'call',
      input: { spot: 100, strike: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.02 },
      parameters: { v0, theta: v0, kappa: 1.5, sigma: 0.2, rho: -0.5 },
      options: { extendedGreeks: true },
    });
    const g = r.greeks as unknown as Record<string, number | null>;
    expect(g).toBeDefined();
    for (const [name, v] of Object.entries(g)) {
      if (v === null) continue;
      expect(Number.isFinite(v), `${name}=${String(v)}`).toBe(true);
    }
    const expected = Math.sqrt(v0) / 4;
    expect(expected).toBeLessThan(1e-3); // the adaptation is genuinely in play
    expect(r.diagnostics.finiteDifferenceBumps!['volatilityStep']).toBeCloseTo(expected, 12);
    // √v₀ + shift stays strictly positive under the disclosed bump.
    expect(Math.sqrt(v0) - r.diagnostics.finiteDifferenceBumps!['volatilityStep']!).toBeGreaterThan(
      0,
    );
  });

  it('SABR and Monte-Carlo disclose their actually-used bumps too (P2.3 completeness)', () => {
    const sr = sabrPrice({
      type: 'call',
      input: { forward: 100, strike: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.04 },
      parameters: { alpha: 2e-3, beta: 1, rho: -0.2, nu: 0.4 },
      options: { extendedGreeks: true },
    });
    expect(sr.diagnostics.finiteDifferenceBumps).toBeDefined();
    // SABR keeps its own α-scaled rule (α/4); it does not use the shared resolver.
    expect(sr.diagnostics.finiteDifferenceBumps!['volatilityStep']).toBeCloseTo(2e-3 / 4, 15);

    const euroContract = option.european({
      convention: 'us-equity-close',
      type: 'call',
      underlying: 'X',
      strike: 100,
      expiry: '2026-12-18',
    });
    const monteCarlo = engines
      .monteCarlo({ paths: 2_000, seed: 7, greeks: true })
      .price({ contract: euroContract, market: mkt(2e-3), options: { greeks: true } });
    expect(monteCarlo.diagnostics.finiteDifferenceBumps).toBeDefined();
    // Monte Carlo keeps the variance-limited reference policy (referenceFdSteps): σ/4 here.
    expect(monteCarlo.diagnostics.finiteDifferenceBumps!['volatilityStep']).toBeCloseTo(
      2e-3 / 4,
      15,
    );
  });
});
