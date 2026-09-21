import { describe, expect, it } from 'vitest';
import { UnsupportedError } from '@totalfinance/core';
import { engines, option } from '@totalfinance/options';
import { monteCarloPrice } from '@totalfinance/options/monte-carlo';
import { monteCarloEuropean } from '@totalfinance/options/monte-carlo';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import type {
  MonteCarloPriceResult,
  MonteCarloPriceOptions,
  OptionMarket,
} from '@totalfinance/options';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-07-01'; // ~181 days
const market: OptionMarket = {
  spot: 100,
  riskFreeRate: 0.04,
  dividendYield: 0.01,
  volatility: 0.25,
  asOf,
};

// time-to-expiry the engine will compute (ACT/365F)
const T = (Date.UTC(2026, 6, 1) - asOf) / (365 * 24 * 3600 * 1000);

describe('monteCarloEuropean kernel — convergence to Black–Scholes–Merton', () => {
  for (const type of ['call', 'put'] as const) {
    it(`${type} price is within a few standard errors of BSM`, () => {
      const ref = blackScholesPrice({
        type,
        spot: 100,
        strike: 105,
        timeToExpiryYears: T,
        riskFreeRate: 0.04,
        dividendYield: 0.01,
        volatility: 0.25,
      });
      const est = monteCarloEuropean({
        type,
        spot: 100,
        strike: 105,
        timeToExpiryYears: T,
        riskFreeRate: 0.04,
        dividendYield: 0.01,
        volatility: 0.25,
        options: {
          paths: 100_000,
          seed: 42,
        },
      });
      expect(est.converged).toBe(true);
      expect(est.standardError).toBeGreaterThan(0);
      expect(Math.abs(est.value - ref)).toBeLessThan(5 * est.standardError! + 1e-9);
      expect(Math.abs(est.value - ref)).toBeLessThan(0.03);
    });
  }

  it('the discounted-terminal control variate is applied and shrinks the standard error', () => {
    const withCv = monteCarloEuropean({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
      options: {
        paths: 40_000,
        seed: 7,
        antithetic: false,
      },
    });
    // Crude reference SE without any control variate: discounted-payoff sample stddev / sqrt(n).
    const df = Math.exp(-0.04 * T);
    const drift = (0.04 - 0.01 - 0.5 * 0.25 * 0.25) * T;
    const vol = 0.25 * Math.sqrt(T);
    let s = 0;
    let s2 = 0;
    const n = 40_000;
    // deterministic-ish payoff samples via the same family of normals is overkill here; use a fixed
    // lattice of normals to get a representative raw stddev.
    for (let i = 0; i < n; i++) {
      const z = (i + 0.5) / n; // uniform grid
      const norm = Math.sqrt(2) * erfInv(2 * z - 1);
      const ST = 100 * Math.exp(drift + vol * norm);
      const pay = df * Math.max(ST - 100, 0);
      s += pay;
      s2 += pay * pay;
    }
    const rawSe = Math.sqrt((s2 - (s * s) / n) / (n - 1) / n);
    expect(withCv.varianceReduction.controlVariate).toBe(true);
    expect(withCv.standardError).toBeLessThan(rawSe);
  });
});

describe('monteCarloEuropean — variance reduction methods', () => {
  it('Sobol QMC matches BSM and reports the method', () => {
    const ref = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
    });
    const est = monteCarloEuropean({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
      options: {
        paths: 16384,
        seed: 1,
        method: 'sobol',
      },
    });
    expect(est.method).toBe('sobol');
    expect(est.varianceReduction.antithetic).toBe(false); // QMC disables antithetic
    expect(Math.abs(est.value - ref)).toBeLessThan(0.02);
  });

  it('Halton QMC matches BSM', () => {
    const ref = blackScholesPrice({
      type: 'put',
      spot: 95,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.3,
    });
    const est = monteCarloEuropean({
      type: 'put',
      spot: 95,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.3,
      options: {
        paths: 20_000,
        seed: 3,
        method: 'halton',
      },
    });
    expect(est.method).toBe('halton');
    expect(Math.abs(est.value - ref)).toBeLessThan(0.03);
  });

  it('is fully reproducible given the same seed, and changes with the seed', () => {
    const a = monteCarloEuropean({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
      options: { paths: 5000, seed: 99 },
    });
    const b = monteCarloEuropean({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
      options: { paths: 5000, seed: 99 },
    });
    const c = monteCarloEuropean({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
      options: { paths: 5000, seed: 100 },
    });
    expect(b.value).toBe(a.value);
    expect(b.seed).toBe(99);
    expect(c.value).not.toBe(a.value);
  });
});

describe('monteCarloPrice — pro envelope', () => {
  it('prices a contract with MC stats, assumptions, and CRN Greeks close to BSM', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'TEST',
      strike: 100,
      expiry,
      style: 'european',
    });
    const res: MonteCarloPriceResult = monteCarloPrice({
      contract,
      market,
      options: {
        paths: 80_000,
        seed: 11,
        method: 'sobol',
        greeks: true, // Monte-Carlo defaults Greeks OFF (WS1.12); opt in for the CRN-FD comparison.
      },
    });
    const refPrice = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
    });
    const refGreeks = blackScholesGreeks({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: T,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
    });

    expect(Math.abs(res.value - refPrice)).toBeLessThan(0.03);
    expect(res.monteCarlo.seed).toBe(11);
    expect(res.monteCarlo.method).toBe('sobol');
    expect(res.diagnostics.engine).toBe('monte-carlo');
    expect(res.assumptions.dividendModel).toBe('continuousYield');

    // CRN finite-difference Greeks line up with the analytic ones.
    expect(res.greeks!.delta).toBeCloseTo(refGreeks.delta, 2);
    expect(res.greeks!.vega).toBeCloseTo(refGreeks.vega, 1);
  });

  it('Monte-Carlo omits Greeks by default and reports their absence (WS1.12)', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'TEST',
      strike: 100,
      expiry,
      style: 'european',
    });
    const res = monteCarloPrice({
      contract,
      market,
      options: { paths: 20_000, seed: 5 },
    });
    expect(res.greeks).toBeUndefined(); // never fabricated zeros
    expect(res.diagnostics.warnings.some((w) => w.code === 'greeks.not_computed')).toBe(true);
  });

  it('plugs into option.price / engines.monteCarlo and supports only European', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'TEST',
      strike: 100,
      expiry,
      style: 'european',
    });
    const eng = engines.monteCarlo({ paths: 40_000, seed: 5, method: 'sobol' });
    const res = option.price({ contract, market, engine: eng });
    expect(
      Math.abs(
        res.value -
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

    const american = option.call({
      convention: 'us-equity-close',
      underlying: 'TEST',
      strike: 100,
      expiry,
      style: 'american',
    });
    expect(eng.supports(american)).toBe(false);
    expect(() =>
      monteCarloPrice({ contract: american, market, options: { paths: 1000, seed: 1 } }),
    ).toThrow(UnsupportedError);
  });

  it('rejects missing market fields', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'TEST',
      strike: 100,
      expiry,
      style: 'european',
    });
    expect(() =>
      monteCarloPrice({
        contract,
        market: { riskFreeRate: 0.04, asOf } as OptionMarket,
        options: { seed: 1 },
      }),
    ).toThrow();
    expect(() =>
      monteCarloPrice({
        contract,
        market: { spot: 100, volatility: 0.2, asOf } as OptionMarket,
        options: { seed: 1 },
      }),
    ).toThrow();
  });

  it('rejects an unknown sampling method through the public pricer', () => {
    // invalid runtime method must throw, not default to Halton
    const badOpts = { paths: 1000, seed: 1, method: 'x' } as unknown as MonteCarloPriceOptions;
    expect(() =>
      monteCarloEuropean({
        type: 'call',
        spot: 100,
        strike: 100,
        timeToExpiryYears: T,
        riskFreeRate: 0.04,
        dividendYield: 0.01,
        volatility: 0.25,
        options: badOpts,
      }),
    ).toThrow();
  });
});

// Inverse error function (Winitzki approximation + one Newton step) — test-only helper.
function erfInv(x: number): number {
  const a = 0.147;
  const ln = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln / 2;
  let y = Math.sign(x) * Math.sqrt(Math.sqrt(t1 * t1 - ln / a) - t1);
  // one Newton refinement against erf
  const erf = (z: number): number => {
    const t = 1 / (1 + 0.3275911 * Math.abs(z));
    const y2 =
      1 -
      ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
        t *
        Math.exp(-z * z);
    return Math.sign(z) * y2;
  };
  y -= (erf(y) - x) / ((2 / Math.sqrt(Math.PI)) * Math.exp(-y * y));
  return y;
}
