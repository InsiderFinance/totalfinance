/**
 * Tests for the §9.3 multi-asset & structured exotics: spread (Kirk vs Monte-Carlo), quanto
 * (closed-form limits), basket (Levy vs MC, single-asset anchor), rainbow (max/min ordering),
 * autocallable (deterministic redemption anchors), and variance/volatility swaps.
 */

import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import {
  autocallable,
  basket,
  quanto,
  rainbow,
  spread,
  varianceSwap,
  volatilitySwap,
} from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

const options = { seed: 12345, paths: 60_000 } as const;

describe('spread option (Kirk vs Monte-Carlo)', () => {
  const base = {
    spot1: 100,
    spot2: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.03,
    volatility1: 0.2,
    volatility2: 0.25,
    correlation: 0.5,
  };

  it('Kirk is exact (Margrabe) at K = 0 and agrees with MC', () => {
    const k = spread.price({ type: 'call', ...base, strike: 0 }).value;
    const monteCarlo = spread.monteCarloPrice({ type: 'call', ...base, strike: 0 }, options);
    expect(Math.abs(k - monteCarlo.value)).toBeLessThan(
      4 * monteCarlo.monteCarlo.standardError! + 0.02,
    );
  });

  it('Kirk ≈ MC for a positive strike', () => {
    const k = spread.price({ type: 'call', ...base, strike: 5 }).value;
    const monteCarlo = spread.monteCarloPrice({ type: 'call', ...base, strike: 5 }, options);
    expect(Math.abs(k - monteCarlo.value)).toBeLessThan(0.1);
  });

  it('satisfies spread put-call parity C − P = disc·(F1 − F2 − K)', () => {
    const input = { ...base, strike: 5 };
    const c = spread.price({ ...input, type: 'call' }).value;
    const p = spread.price({ ...input, type: 'put' }).value;
    const F1 = 100 * Math.exp(0.03);
    const F2 = 100 * Math.exp(0.03);
    expect(c - p).toBeCloseTo(Math.exp(-0.03) * (F1 - F2 - 5), 8);
  });
});

describe('quanto option', () => {
  const base = {
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    domesticRate: 0.04,
    foreignRate: 0.02,
    volatility: 0.25,
    fxVolatility: 0.1,
  };

  it('with zero correlation reduces to Black-76 on the foreign asset, discounted domestically', () => {
    const q = quanto.price({ type: 'call', ...base, correlation: 0 }).value;
    // No quanto drift adjustment ⇒ forward grows at the foreign rate; discount at the domestic rate.
    const F = 100 * Math.exp(0.02);
    const reference =
      blackScholesPrice({
        type: 'call',
        spot: F,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0,
        dividendYield: 0,
        volatility: 0.25,
      }) * Math.exp(-0.04);
    expect(q).toBeCloseTo(reference, 8);
  });

  it('a positive asset–FX correlation lowers the call (negative drift adjustment)', () => {
    const lo = quanto.price({ type: 'call', ...base, correlation: -0.5 }).value;
    const hi = quanto.price({ type: 'call', ...base, correlation: 0.5 }).value;
    expect(hi).toBeLessThan(lo);
  });

  it('satisfies put-call parity', () => {
    const c = quanto.price({ type: 'call', ...base, correlation: 0.3 }).value;
    const p = quanto.price({ type: 'put', ...base, correlation: 0.3 }).value;
    const muQ = 0.02 - 0.3 * 0.25 * 0.1;
    const F = 100 * Math.exp(muQ);
    expect(c - p).toBeCloseTo(Math.exp(-0.04) * (F - 100), 8);
  });
});

describe('basket option', () => {
  const two = {
    spots: [100, 100],
    volatilities: [0.2, 0.25],
    correlation: [
      [1, 0.3],
      [0.3, 1],
    ],
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.03,
  };

  it('Levy approximation collapses to Black-Scholes for a single-asset basket', () => {
    const levy = basket.approximatePrice({ type: 'call', ...two, weights: [1, 0] }).value;
    const F0 = 100 * Math.exp(0.03);
    const ref =
      blackScholesPrice({
        type: 'call',
        spot: F0,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0,
        dividendYield: 0,
        volatility: 0.2,
      }) * Math.exp(-0.03);
    expect(levy).toBeCloseTo(ref, 7);
  });

  it('Levy approximation agrees with Monte-Carlo', () => {
    const input = { ...two, weights: [0.5, 0.5] };
    const levy = basket.approximatePrice({ ...input, type: 'call' }).value;
    const monteCarlo = basket.monteCarloPrice({ ...input, type: 'call' }, options);
    expect(Math.abs(levy - monteCarlo.value)).toBeLessThan(0.15);
  });

  describe('the correlation matrix is validated on BOTH branches (2026-08 defect-fix wave)', () => {
    const withCorrelation = (correlation: number[][]) => ({
      ...two,
      correlation,
      weights: [0.5, 0.5],
      type: 'call' as const,
    });

    it('|ρ| > 1 is rejected by the analytic branch, exactly as the simulation always was', () => {
      // ρ = 1.8 used to price CONFIDENTLY through the Levy moment-match (the covariance term is just
      // exp(ρ·σᵢσⱼT)) while the MC branch threw on the Cholesky factorization.
      const impossible = withCorrelation([
        [1, 1.8],
        [1.8, 1],
      ]);
      expect(() => basket.approximatePrice(impossible)).toThrow(InputError);
      expect(() => basket.approximatePrice(impossible)).toThrow(/outside \[−1, 1\]/);
      expect(() => basket.monteCarloPrice(impossible, options)).toThrow(InputError);
    });

    it('an asymmetric, a non-unit-diagonal, and a non-PSD matrix are each rejected', () => {
      expect(() =>
        basket.approximatePrice(
          withCorrelation([
            [1, 0.3],
            [0.7, 1],
          ]),
        ),
      ).toThrow(/not symmetric/);
      expect(() =>
        basket.approximatePrice(
          withCorrelation([
            [0.9, 0.3],
            [0.3, 1],
          ]),
        ),
      ).toThrow(/must be exactly 1/);
      // Symmetric, unit diagonal, every entry inside [−1, 1] — but not positive definite.
      const threeAsset = {
        spots: [100, 100, 100],
        volatilities: [0.2, 0.2, 0.2],
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.03,
        weights: [1 / 3, 1 / 3, 1 / 3],
        type: 'call' as const,
        correlation: [
          [1, -0.9, 0.9],
          [-0.9, 1, 0.9],
          [0.9, 0.9, 1],
        ],
      };
      expect(() => basket.approximatePrice(threeAsset)).toThrow(/positive definite/);
      expect(() => basket.monteCarloPrice(threeAsset, options)).toThrow(/positive definite/);
    });

    it('a legitimate ρ = 0.5 is unchanged (the guard costs nothing to a valid matrix)', () => {
      const valid = withCorrelation([
        [1, 0.5],
        [0.5, 1],
      ]);
      const levy = basket.approximatePrice(valid).value;
      expect(levy).toBeGreaterThan(0);
      // The value is a pure function of the inputs; pinned against the Monte-Carlo it corroborates.
      const monteCarlo = basket.monteCarloPrice(valid, options);
      expect(Math.abs(levy - monteCarlo.value)).toBeLessThan(0.15);
    });
  });
});

describe('rainbow option (max / min of assets)', () => {
  const input = {
    spots: [100, 100],
    volatilities: [0.2, 0.2],
    correlation: [
      [1, 0.3],
      [0.3, 1],
    ],
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.03,
  };

  it('max-call ≥ a single-asset call ≥ min-call', () => {
    const single = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.03,
      dividendYield: 0,
      volatility: 0.2,
    });
    const maxCall = rainbow.monteCarloPrice({ ...input, type: 'call', kind: 'max' }, options).value;
    const minCall = rainbow.monteCarloPrice({ ...input, type: 'call', kind: 'min' }, options).value;
    expect(maxCall).toBeGreaterThan(single);
    expect(minCall).toBeLessThan(single);
  });
});

describe('autocallable note', () => {
  it('with an unreachable autocall + zero knock-in returns the notional at maturity', () => {
    // autocallBarrier far above spot (never triggers); knockInBarrier ~0 (never knocked in).
    const price = autocallable.monteCarloPrice(
      {
        spot: 100,
        observationTimes: [0.5, 1],
        riskFreeRate: 0.05,
        volatility: 0.2,
        autocallBarrier: 1e9,
        couponRate: 0.05,
        knockInBarrier: 1e-9,
        notional: 100,
      },
      options,
    );
    expect(price.value).toBeCloseTo(100 * Math.exp(-0.05 * 1), 1); // notional discounted to maturity
  });

  it('with an always-knocked-in downside (no autocall, q=0) is worth ≈ the notional', () => {
    // knockInBarrier huge ⇒ always "in" ⇒ payoff notional·S_T/S_0; E[S_T/S_0]·e^{-rT} = 1 when q=0.
    const price = autocallable.monteCarloPrice(
      {
        spot: 100,
        observationTimes: [1],
        riskFreeRate: 0.05,
        volatility: 0.2,
        autocallBarrier: 1e9,
        couponRate: 0,
        knockInBarrier: 1e9,
        notional: 100,
      },
      options,
    );
    expect(price.value).toBeGreaterThan(95);
    expect(price.value).toBeLessThan(105);
  });
});

describe('variance & volatility swaps', () => {
  it('Heston fair variance interpolates v0 → theta with maturity', () => {
    const p = { v0: 0.04, kappa: 1.5, theta: 0.09 };
    const short = varianceSwap.hestonFairVariance(p, 0.01);
    const long = varianceSwap.hestonFairVariance(p, 50);
    expect(short).toBeCloseTo(0.04, 3); // T→0 ⇒ v0
    expect(long).toBeCloseTo(0.09, 2); // T→∞ ⇒ theta
  });

  it('variance-swap PV has the right sign and the vol swap applies a downward convexity adjustment', () => {
    expect(
      varianceSwap.value({
        realizedVariance: 0.05,
        strikeVariance: 0.04,
        riskFreeRate: 0.03,
        timeToExpiryYears: 1,
      }),
    ).toBeGreaterThan(0);
    const plain = volatilitySwap.approximateFairVolatility({ fairVariance: 0.04 });
    const adjusted = volatilitySwap.approximateFairVolatility({
      fairVariance: 0.04,
      varianceOfVariance: 0.0005,
    });
    expect(plain).toBeCloseTo(0.2, 12); // √0.04
    expect(adjusted).toBeLessThan(plain); // Jensen gap
  });

  it('variance-swap value rejects a NaN notional instead of leaking NaN (PR review)', () => {
    expect(() =>
      varianceSwap.value({
        realizedVariance: 0.05,
        strikeVariance: 0.04,
        varianceNotional: Number.NaN,
        riskFreeRate: 0.03,
        timeToExpiryYears: 1,
      }),
    ).toThrow(/varianceNotional/);
  });

  it('vol-swap approximateFairVolatility throws when variance-of-variance leaves the valid region (PR review)', () => {
    // varVar/(8·K_var²) ≥ 1 would return a ≤0 "fair vol"; refuse instead of emitting a negative vol.
    expect(() =>
      volatilitySwap.approximateFairVolatility({ fairVariance: 0.04, varianceOfVariance: 0.02 }),
    ).toThrow(/valid region|varianceOfVariance/);
  });
});
