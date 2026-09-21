/**
 * Runnable Phase-5 advanced-quant examples (spec §21.2). Each documented snippet executes in CI with
 * assertions, so the stochastic-model and exotic docs cannot drift from working code.
 */

import { describe, expect, it } from 'vitest';
import {
  dupireLocalVolatility,
  localVolatilityGrid,
  localVolatilityMonteCarloPrice,
} from '@totalfinance/options/local-volatility';
import { hestonImpliedVolatility, hestonPrice } from '@totalfinance/options/heston';
import { sabrVolatility } from '@totalfinance/options/sabr';
import {
  asian,
  barrier,
  option,
  type ImpliedVolatilityFunction,
  type OptionMarket,
} from '@totalfinance/options';
import { monteCarloPrice } from '@totalfinance/options/monte-carlo';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

const asOf = Date.UTC(2026, 0, 1);

describe('docs: Monte-Carlo / QMC European pricing', () => {
  it('converges to Black–Scholes–Merton and reports its error bars', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'AAPL',
      strike: 100,
      expiry: '2027-01-01',
      style: 'european',
    });
    const market: OptionMarket = {
      spot: 100,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
      asOf,
    };

    const monteCarlo = monteCarloPrice({
      contract,
      market,
      options: { paths: 50_000, seed: 42, method: 'sobol' },
    });

    expect(monteCarlo.value).toBeGreaterThan(0);
    expect(monteCarlo.monteCarlo.seed).toBe(42); // every stochastic API echoes its seed
    // Sobol is a DETERMINISTIC low-discrepancy sequence, so the iid standard-error formula
    // does not apply to it (it overstated the interval ~75x). QMC reports null and says why;
    // the pseudo-random path below is where the error bars come from.
    expect(monteCarlo.monteCarlo.standardError).toBeNull();
    expect(monteCarlo.diagnostics.warnings.map((w) => w.code)).toContain('model.limitation');

    const pseudo = monteCarloPrice({
      contract,
      market,
      options: { paths: 50_000, seed: 42 },
    });
    expect(pseudo.monteCarlo.standardError).toBeGreaterThan(0);
    // within Monte-Carlo error of the closed form (the MC pricer is the reference path engine)
    const T = (Date.UTC(2027, 0, 1) - asOf) / (365 * 24 * 3600 * 1000);
    expect(
      Math.abs(
        monteCarlo.value -
          blackScholesPrice({
            type: 'call',
            spot: 100,
            strike: 100,
            timeToExpiryYears: T,
            riskFreeRate: 0.04,
            dividendYield: 0.01,
            volatility: 0.25,
          }),
      ),
    ).toBeLessThan(0.05);
  });
});

describe('docs: Heston stochastic volatility (COS)', () => {
  it('prices and produces a left-skewed implied-vol smile', () => {
    const parameters = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.6, rho: -0.7 };
    const base = { spot: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.03 } as const;

    const atmImpliedVolatility = hestonImpliedVolatility({
      type: 'put',
      input: { ...base, strike: 100 },
      parameters,
    }).value;
    const otmPutImpliedVolatility = hestonImpliedVolatility({
      type: 'put',
      input: { ...base, strike: 85 },
      parameters,
    }).value;
    expect(otmPutImpliedVolatility).toBeGreaterThan(atmImpliedVolatility); // negative correlation lifts the put wing

    const price = hestonPrice({
      type: 'call',
      input: { ...base, strike: 100 },
      parameters,
    }).value;
    expect(price).toBeGreaterThan(0);
  });
});

describe('docs: SABR smile', () => {
  it('fits a smile with four intuitive parameters', () => {
    const parameters = { alpha: 0.3, beta: 0.9, rho: -0.4, nu: 0.6 };
    const lowStrike = sabrVolatility({
      input: { forward: 100, strike: 80, timeToExpiryYears: 0.5 },
      parameters,
    });
    const atm = sabrVolatility({
      input: { forward: 100, strike: 100, timeToExpiryYears: 0.5 },
      parameters,
    });
    expect(lowStrike).toBeGreaterThan(atm); // downward skew from negative rho
  });
});

describe('docs: Dupire local volatility', () => {
  it('extracts a local-volatility surface and reprices a flat surface as Black–Scholes', () => {
    const flat: ImpliedVolatilityFunction = () => 0.2;
    const local = localVolatilityGrid(
      dupireLocalVolatility({ impliedVolatility: flat, market: { spot: 100, riskFreeRate: 0.03 } }),
      {
        levels: [60, 80, 100, 120, 140],
        times: [0.1, 0.5, 1],
      },
    );
    expect(local(100, 0.5)).toBeCloseTo(0.2, 3); // flat implied ⇒ flat local

    const monteCarlo = localVolatilityMonteCarloPrice({
      type: 'call',
      input: { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.03 },
      localVolatility: local,
      options: {
        paths: 30_000,
        seed: 1,
      },
    });
    expect(
      Math.abs(
        monteCarlo.value -
          blackScholesPrice({
            type: 'call',
            spot: 100,
            strike: 100,
            timeToExpiryYears: 1,
            riskFreeRate: 0.03,
            dividendYield: 0,
            volatility: 0.2,
          }),
      ),
    ).toBeLessThan(0.1);
  });
});

describe('docs: exotics', () => {
  it('barrier knock-in + knock-out = vanilla', () => {
    const input = {
      spot: 100,
      strike: 100,
      barrier: 90,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.25,
    };
    const di = barrier.price({ ...input, type: 'call', barrierType: 'down-in' }).value;
    const dout = barrier.price({ ...input, type: 'call', barrierType: 'down-out' }).value;
    expect(di + dout).toBeCloseTo(
      blackScholesPrice({
        type: 'call',
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        dividendYield: 0,
        volatility: 0.25,
      }),
      8,
    );
  });

  it('an arithmetic Asian sits between its geometric counterpart and the vanilla', () => {
    const input = {
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.25,
    };
    const geo = asian.geometricPrice({ ...input, type: 'call', averagingPoints: 12 }).value;
    const arith = asian.monteCarloPrice(
      { ...input, type: 'call' },
      { paths: 30_000, seed: 3, averagingPoints: 12 },
    ).value;
    const vanilla = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.25,
    });
    expect(arith).toBeGreaterThan(geo - 1e-6);
    expect(arith).toBeLessThan(vanilla);
  });
});
