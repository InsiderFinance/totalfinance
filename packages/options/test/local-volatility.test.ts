import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  type ImpliedVolatilityFunction,
  type LocalVolatilityFunction,
  dupireLocalVolatility,
  localVolatilityGrid,
  localVolatilityMonteCarloPrice,
} from '@totalfinance/options/local-volatility';

const market = { spot: 100, riskFreeRate: 0.03, dividendYield: 0.01 };

// A (level × time) grid for fast MC; spans the levels GBM realistically reaches over the test horizonYears.
const LEVELS = Array.from({ length: 41 }, (_, i) => 40 + i * 4); // 40 … 200
const TIMES = Array.from({ length: 25 }, (_, i) => 0.02 + i * 0.05); // 0.02 … 1.22
const onGrid = (lv: LocalVolatilityFunction): LocalVolatilityFunction =>
  localVolatilityGrid(lv, { levels: LEVELS, times: TIMES });

describe('Dupire local vol — flat implied surface', () => {
  it('recovers σ_loc ≡ σ everywhere (the Black–Scholes case)', () => {
    const flat: ImpliedVolatilityFunction = () => 0.22;
    const lv = dupireLocalVolatility({ impliedVolatility: flat, market });
    for (const S of [70, 90, 100, 115, 140]) {
      for (const t of [0.1, 0.5, 1, 2]) {
        expect(lv(S, t)).toBeCloseTo(0.22, 4);
      }
    }
  });

  it('local-volatility MC under a flat surface reproduces the BSM price', () => {
    const sigma = 0.22;
    const flat: ImpliedVolatilityFunction = () => sigma;
    const lv = onGrid(dupireLocalVolatility({ impliedVolatility: flat, market }));
    const T = 1;
    for (const [type, K] of [
      ['call', 100],
      ['put', 90],
      ['call', 115],
    ] as const) {
      const res = localVolatilityMonteCarloPrice({
        type,
        input: {
          spot: 100,
          strike: K,
          timeToExpiryYears: T,
          riskFreeRate: 0.03,
          dividendYield: 0.01,
        },
        localVolatility: lv,
        options: { paths: 24_000, seed: 31, steps: 50 },
      });
      const ref = blackScholesPrice({
        type,
        spot: 100,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: 0.03,
        dividendYield: 0.01,
        volatility: sigma,
      });
      expect(Math.abs(res.value - ref)).toBeLessThan(4 * res.monteCarlo.standardError! + 0.02);
    }
  });
});

describe('Dupire local vol — skewed surface', () => {
  // gentle, arbitrage-free skew: lower strikes carry higher implied vol
  const skew: ImpliedVolatilityFunction = (K) => {
    const v = 0.2 - 0.04 * Math.log(K / 100);
    return Math.min(0.5, Math.max(0.08, v));
  };

  it('produces a finite, positive local-volatility surface steeper than the implied skew', () => {
    const lv = dupireLocalVolatility({ impliedVolatility: skew, market });
    const loLevel = lv(85, 0.5);
    const hiLevel = lv(115, 0.5);
    expect(loLevel).toBeGreaterThan(0);
    expect(hiLevel).toBeGreaterThan(0);
    // local vol inherits the negative skew direction
    expect(loLevel).toBeGreaterThan(hiLevel);
  });

  it('reprices the surface it was calibrated to (Dupire reproduction)', () => {
    const lv: LocalVolatilityFunction = onGrid(
      dupireLocalVolatility({ impliedVolatility: skew, market }),
    );
    const T = 1;
    for (const [type, K] of [
      ['call', 100],
      ['put', 90],
      ['call', 110],
    ] as const) {
      const res = localVolatilityMonteCarloPrice({
        type,
        input: {
          spot: 100,
          strike: K,
          timeToExpiryYears: T,
          riskFreeRate: 0.03,
          dividendYield: 0.01,
        },
        localVolatility: lv,
        options: { paths: 40_000, seed: 5, steps: 64 },
      });
      const ref = blackScholesPrice({
        type,
        spot: 100,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: 0.03,
        dividendYield: 0.01,
        volatility: skew(K, T),
      });
      // combined Euler + finite-difference-Dupire + MC error
      expect(Math.abs(res.value - ref)).toBeLessThan(4 * res.monteCarlo.standardError! + 0.15);
    }
  });
});

describe('local-volatility — input validation', () => {
  it('rejects a non-function local-volatility argument', () => {
    expect(() =>
      localVolatilityMonteCarloPrice({
        type: 'call',
        input: { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.03 },
        localVolatility: undefined as unknown as LocalVolatilityFunction,
        options: { seed: 1 },
      }),
    ).toThrow(InputError);
  });

  it('rejects zero/negative finite-difference steps and a negative vol floor (PR review)', () => {
    const flat: ImpliedVolatilityFunction = () => 0.2;
    // logMoneynessStep = 0 would divide by zero and silently collapse a flat 20% surface to the floor.
    expect(() =>
      dupireLocalVolatility({ impliedVolatility: flat, market, options: { logMoneynessStep: 0 } }),
    ).toThrow(/logMoneynessStep/);
    expect(() =>
      dupireLocalVolatility({
        impliedVolatility: flat,
        market,
        options: { timeStepYears: -0.01 },
      }),
    ).toThrow(/timeStepYears/);
    expect(() =>
      dupireLocalVolatility({
        impliedVolatility: flat,
        market,
        options: { floorVolatility: -1 },
      }),
    ).toThrow(/floorVolatility/);
  });

  it('localVolatilityGrid enforces finite, strictly-ascending axes (PR review)', () => {
    const lv = dupireLocalVolatility({ impliedVolatility: () => 0.2, market });
    expect(() => localVolatilityGrid(lv, { levels: [100, 90, 110], times: TIMES })).toThrow(
      /ascending/,
    );
    expect(() =>
      localVolatilityGrid(lv, { levels: LEVELS, times: [0.1, Number.NaN, 0.3] }),
    ).toThrow(/finite/);
  });
});
