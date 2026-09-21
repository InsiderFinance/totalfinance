/**
 * Tests for the model-free vol analytics: Breeden–Litzenberger risk-neutral distribution (verified
 * against the lognormal under a flat smile), the realized-volatility cone, and the VIX-style
 * variance-swap fair vol (verified to recover a flat input vol).
 */

import { describe, expect, it } from 'vitest';
import { normalCdf } from '@totalfinance/math';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  riskNeutralDistribution,
  varianceSwapRate,
  volatilityCone,
} from '@totalfinance/volatility';

describe('Breeden–Litzenberger risk-neutral distribution', () => {
  const spot = 100;
  const t = 0.5;
  const rate = 0.03;
  const vol = 0.2;
  const dist = riskNeutralDistribution(() => vol, {
    spot,
    timeToExpiryYears: t,
    riskFreeRate: rate,
  });

  it('matches the lognormal CDF/PDF under a flat smile', () => {
    for (const K of [80, 95, 100, 110, 125]) {
      const d2 = (Math.log(spot / K) + (rate - 0.5 * vol * vol) * t) / (vol * Math.sqrt(t));
      expect(dist.cdf(K)).toBeCloseTo(normalCdf(-d2), 3); // P(S_T ≤ K)
    }
    // density integrates to a probability between two strikes consistently with the CDF
    expect(dist.probabilityBetween(95, 105)).toBeCloseTo(dist.cdf(105) - dist.cdf(95), 9);
    expect(dist.probabilityAbove(100) + dist.probabilityBelow(100)).toBeCloseTo(1, 6);
  });

  it('density is non-negative and the CDF is monotone', () => {
    let prev = 0;
    for (let K = 70; K <= 130; K += 5) {
      expect(dist.density(K)).toBeGreaterThanOrEqual(0);
      const c = dist.cdf(K);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = c;
    }
  });
});

describe('volatility cone', () => {
  it('reports per-window percentiles and a current reading within [min, max]', () => {
    // deterministic ±1% daily wiggle ⇒ a stable realized vol
    const returns = Array.from({ length: 300 }, (_, i) => 0.01 * Math.sin(i / 2));
    const cone = volatilityCone(returns, { windows: [10, 21, 63], periodsPerYear: 252 });
    expect(cone).toHaveLength(3);
    for (const row of cone) {
      expect(row.min).toBeLessThanOrEqual(row.median);
      expect(row.median).toBeLessThanOrEqual(row.max);
      expect(row.current).toBeGreaterThanOrEqual(row.min - 1e-9);
      expect(row.current).toBeLessThanOrEqual(row.max + 1e-9);
      expect(row.current).toBeGreaterThan(0);
    }
  });

  it('rejects a window < 2', () => {
    expect(() => volatilityCone([0.01, -0.01, 0.02], { windows: [1] })).toThrow(/window/);
  });

  it('throws when a window exceeds the history instead of emitting an all-NaN row (PR review)', () => {
    // 5 returns, a 10-day window ⇒ no complete rolling window exists.
    expect(() => volatilityCone([0.01, -0.02, 0.03, -0.01, 0.02], { windows: [10] })).toThrow(
      /exceeds|history/,
    );
  });

  // ── H27 — the cone facade explains its applied conventions ──
  it('volatilityCone.explain returns the same rows and discloses the annualization', () => {
    const returns = Array.from({ length: 300 }, (_, i) => 0.01 * Math.sin(i / 2));
    const windows = [10, 21, 63];
    const plain = volatilityCone(returns, { windows, periodsPerYear: 252 });
    const explained = volatilityCone.explain(returns, { windows, periodsPerYear: 252 });
    // the explained value IS the rows array, row for row
    expect(explained.value).toHaveLength(plain.length);
    for (let i = 0; i < plain.length; i++) {
      expect(explained.value[i]!.window).toBe(plain[i]!.window);
      expect(explained.value[i]!.median).toBeCloseTo(plain[i]!.median, 15);
      expect(explained.value[i]!.current).toBeCloseTo(plain[i]!.current, 15);
    }
    // assumptions echo the applied conventions: windows, periods, annualization basis
    expect(explained.assumptions.windows).toEqual(windows);
    expect(explained.assumptions.periodsPerYear).toBe(252);
    expect(explained.assumptions.annualization).toBe('sqrt-periods-per-year');
    expect(explained.assumptions.conventionsVersion.length).toBeGreaterThan(0);
    // diagnostics disclose the observation count and the √periodsPerYear scale factor
    const d = explained.diagnostics.decomposition!;
    expect(d['observationCount']!).toBe(returns.length);
    expect(d['annualizationFactor']!).toBeCloseTo(Math.sqrt(252), 12);
    expect(explained.diagnostics.warnings).toEqual([]);
    // the default periodsPerYear (252) is resolved and echoed too
    expect(explained.assumptions.periodsPerYear).toBe(
      volatilityCone.explain(returns, { windows }).assumptions.periodsPerYear,
    );
  });
});

describe('variance-swap fair vol (VIX-style)', () => {
  it('recovers a flat input vol from a fine OTM strip', () => {
    const spot = 100;
    const t = 30 / 365;
    const rate = 0.02;
    const vol = 0.22;
    const forward = spot * Math.exp(rate * t);
    const strikes: number[] = [];
    const otmPrices: number[] = [];
    for (let K = 50; K <= 160; K += 1) {
      strikes.push(K);
      // OTM: puts below the forward, calls above
      const type = K < forward ? 'put' : 'call';
      otmPrices.push(
        blackScholesPrice({
          type,
          spot,
          strike: K,
          timeToExpiryYears: t,
          riskFreeRate: rate,
          dividendYield: 0,
          volatility: vol,
        }),
      );
    }
    const swap = varianceSwapRate({
      strikes,
      otmPrices,
      forward,
      riskFreeRate: rate,
      timeToExpiryYears: t,
    });
    expect(swap.value.fairVolatility).toBeCloseTo(vol, 2); // within ~0.005 of the 22% input
    // the model-free fair vol is a risk-neutral replication estimate — echoed as such
    expect(swap.assumptions.measure).toBe('risk-neutral');
    expect(swap.diagnostics.warnings.some((w) => w.code === 'estimate.risk_neutral')).toBe(true);
  });

  it('rejects too few strikes / mismatched lengths', () => {
    expect(() =>
      varianceSwapRate({
        strikes: [90, 100],
        otmPrices: [1, 1],
        forward: 100,
        riskFreeRate: 0,
        timeToExpiryYears: 0.1,
      }),
    ).toThrow(/≥ 3 strikes/);
  });

  // Review finding: a garbage strip could return { variance: −x, fairVolatility: 0 } silently — an
  // inconsistent pair with no hint that a negative fair variance means arbitrageable inputs.
  it('discloses a negative fair variance instead of silently pairing it with fairVolatility 0', () => {
    // Worthless OTM prices far below the forward: the strip sum is 0 but (F/K₀ − 1)² > 0.
    const res = varianceSwapRate({
      strikes: [50, 60, 70],
      otmPrices: [0, 0, 0],
      forward: 100,
      riskFreeRate: 0,
      timeToExpiryYears: 0.1,
    });
    expect(res.value.variance).toBeLessThan(0); // reported as computed, not clamped
    expect(Number.isNaN(res.value.fairVolatility)).toBe(true); // √(negative) has no real value — never a fabricated 0
    // The negative-variance caveat specifically (the strip also carries the put-only K₀ disclosure).
    const caveat = res.diagnostics.warnings.find(
      (w) => w.code === 'model.limitation' && /negative/.test(w.message),
    );
    expect(caveat).toBeDefined();
    expect(caveat!.context?.['variance']).toBe(res.value.variance);
  });

  it('a consistent strip carries no negative-variance caveat and fairVolatility = √variance', () => {
    const res = varianceSwapRate({
      strikes: [90, 100, 110],
      otmPrices: [1, 4, 1],
      forward: 100,
      riskFreeRate: 0,
      timeToExpiryYears: 0.25,
    });
    expect(res.value.variance).toBeGreaterThan(0);
    expect(res.value.fairVolatility).toBeCloseTo(Math.sqrt(res.value.variance), 12);
    // No NEGATIVE-variance caveat …
    expect(
      res.diagnostics.warnings.some(
        (w) => w.code === 'model.limitation' && /negative/.test(w.message),
      ),
    ).toBe(false);
    // … but the put-only K₀ convention IS disclosed (no boundaryCallPrice was supplied), quantified.
    const boundary = res.diagnostics.warnings.find((w) => /boundaryCallPrice/.test(w.message));
    expect(boundary).toBeDefined();
    expect(boundary!.context?.['boundaryStrike']).toBe(100);
    expect(typeof boundary!.context?.['varianceBias']).toBe('number');
  });
});

describe('analytics input hardening (fail loudly on malformed inputs)', () => {
  const flatSmile = () => 0.2;

  it('riskNeutralDistribution rejects a zero/NaN step and a NaN dividend yield', () => {
    expect(() =>
      riskNeutralDistribution(flatSmile, {
        spot: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.03,
        step: 0,
      }),
    ).toThrow(/step/);
    expect(() =>
      riskNeutralDistribution(flatSmile, {
        spot: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.03,
        step: NaN,
      }),
    ).toThrow(/step/);
    expect(() =>
      riskNeutralDistribution(flatSmile, {
        spot: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.03,
        dividendYield: NaN,
      }),
    ).toThrow(/dividendYield/);
  });

  it('volatilityCone rejects a non-finite return rather than poisoning the cone', () => {
    const returns = [0.01, -0.02, NaN, 0.005, 0.0, -0.01];
    expect(() => volatilityCone(returns, { windows: [3] })).toThrow(/returns/);
  });

  it('varianceSwapRate validates strikes, prices, rate, duplicates, and a sub-forward K0', () => {
    const base = {
      strikes: [90, 100, 110],
      otmPrices: [1, 2, 1],
      forward: 100,
      riskFreeRate: 0.02,
      timeToExpiryYears: 0.1,
    };
    expect(() => varianceSwapRate({ ...base, strikes: [90, 100, NaN] })).toThrow(/strikes/);
    expect(() => varianceSwapRate({ ...base, otmPrices: [1, -2, 1] })).toThrow(/otmPrices/);
    expect(() => varianceSwapRate({ ...base, riskFreeRate: NaN })).toThrow(/riskFreeRate/);
    expect(() => varianceSwapRate({ ...base, strikes: [100, 100, 110] })).toThrow(/duplicate/);
    // No strike at or below the forward ⇒ K0 is undefined.
    expect(() => varianceSwapRate({ ...base, forward: 80 })).toThrow(/at or below the forward/);
  });
});

describe('volatilityCone input hardening (deep-sweep boundary)', () => {
  const returns = Array.from({ length: 40 }, (_, i) => 0.001 * Math.sin(i));

  it('names a missing/scalar windows list instead of dying on .map', () => {
    // Absent is MISSING (four-code matrix); present-but-scalar stays the type error.
    expect(() => volatilityCone(returns, {} as never)).toThrow(
      /volatilityCone: options\.windows is required/,
    );
    expect(() => volatilityCone(returns, { windows: 10 } as never)).toThrow(
      /volatilityCone: options\.windows must be an array/,
    );
  });
});
