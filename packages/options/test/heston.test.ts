import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  type HestonInput,
  type HestonParameters,
  hestonCosineExpansionPrice,
  hestonImpliedVolatility,
  hestonPrice,
  hestonMonteCarloPrice,
} from '@totalfinance/options/heston';

describe('Heston COS — Black–Scholes limit (ξ→0, v0=θ=σ²)', () => {
  it('reproduces the BSM price when vol-of-vol vanishes', () => {
    const sigma = 0.2;
    const parameters: HestonParameters = {
      v0: sigma * sigma,
      kappa: 1.5,
      theta: sigma * sigma,
      sigma: 0.01,
      rho: 0,
    };
    for (const [S, K] of [
      [100, 90],
      [100, 100],
      [100, 115],
    ] as const) {
      for (const type of ['call', 'put'] as const) {
        const cos = hestonCosineExpansionPrice({
          type,
          spot: S,
          strike: K,
          timeToExpiryYears: 1,
          riskFreeRate: 0.03,
          dividendYield: 0.01,
          parameters,
        });
        const bsm = blackScholesPrice({
          type,
          spot: S,
          strike: K,
          timeToExpiryYears: 1,
          riskFreeRate: 0.03,
          dividendYield: 0.01,
          volatility: sigma,
        });
        expect(Math.abs(cos - bsm)).toBeLessThan(5e-3);
      }
    }
  });

  it('Greeks match BSM in the limit', () => {
    const sigma = 0.25;
    const parameters: HestonParameters = {
      v0: sigma * sigma,
      kappa: 2,
      theta: sigma * sigma,
      sigma: 0.01,
      rho: 0,
    };
    const input: HestonInput = {
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.75,
      riskFreeRate: 0.03,
      dividendYield: 0.0,
    };
    const res = hestonPrice({ type: 'call', input, parameters });
    const ref = blackScholesGreeks({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.75,
      riskFreeRate: 0.03,
      dividendYield: 0,
      volatility: sigma,
    });
    expect(res.greeks!.delta).toBeCloseTo(ref.delta, 2);
    expect(res.greeks!.vega).toBeCloseTo(ref.vega, 1);
    expect(res.greeks!.gamma).toBeGreaterThan(0);
  });
});

describe('Heston COS — internal consistency', () => {
  const parameters: HestonParameters = { v0: 0.04, kappa: 2, theta: 0.05, sigma: 0.5, rho: -0.7 };
  it('respects put–call parity to COS truncation accuracy', () => {
    const S = 100;
    const K = 105;
    const T = 1;
    const r = 0.04;
    const q = 0.015;
    const c = hestonCosineExpansionPrice({
      type: 'call',
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      parameters,
    });
    const p = hestonCosineExpansionPrice({
      type: 'put',
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: r,
      dividendYield: q,
      parameters,
    });
    // COS satisfies parity to series-truncation error (call/put integrate over different sub-domains),
    // not bit-exactly — ~1e-6 at 256 terms is excellent.
    expect(c - p).toBeCloseTo(S * Math.exp(-q * T) - K * Math.exp(-r * T), 4);
  });

  it('prices are positive and increase with maturity (more variance)', () => {
    const short = hestonCosineExpansionPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.25,
      riskFreeRate: 0.04,
      dividendYield: 0,
      parameters,
    });
    const long = hestonCosineExpansionPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1.0,
      riskFreeRate: 0.04,
      dividendYield: 0,
      parameters,
    });
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short);
  });
});

describe('Heston — COS cross-validated against independent QE Monte-Carlo', () => {
  const parameters: HestonParameters = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.6 };
  for (const [S, K, type] of [
    [100, 100, 'call'],
    [100, 90, 'put'],
    [100, 110, 'call'],
  ] as const) {
    it(`${type} S=${S} K=${K}: analytic COS agrees with QE-MC within Monte-Carlo error`, () => {
      const T = 1;
      const r = 0.03;
      const q = 0.01;
      const cos = hestonCosineExpansionPrice({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: T,
        riskFreeRate: r,
        dividendYield: q,
        parameters,
      });
      const monteCarlo = hestonMonteCarloPrice({
        type,
        input: { spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, dividendYield: q },
        parameters,
        options: { paths: 60_000, seed: 20260626, steps: 56 },
      });
      expect(monteCarlo.monteCarlo.standardError).toBeGreaterThan(0);
      expect(Math.abs(cos - monteCarlo.value)).toBeLessThan(
        4 * monteCarlo.monteCarlo.standardError! + 0.02,
      );
    });
  }
});

describe('Heston implied-vol surface bridge', () => {
  const parameters: HestonParameters = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.6, rho: -0.7 };
  it('produces a left-skewed smile (negative correlation lifts OTM put IV above ATM)', () => {
    const base = { spot: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.03 } as const;
    const atm = hestonImpliedVolatility({
      type: 'put',
      input: { ...base, strike: 100 },
      parameters,
    }).value;
    const otmPut = hestonImpliedVolatility({
      type: 'put',
      input: { ...base, strike: 85 },
      parameters,
    }).value;
    expect(atm).toBeGreaterThan(0);
    expect(otmPut).toBeGreaterThan(atm);
    // ATM IV is near √v0 = 0.2
    expect(atm).toBeGreaterThan(0.15);
    expect(atm).toBeLessThan(0.3);
  });
});

describe('Heston — input validation', () => {
  const input: HestonInput = { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.03 };
  it('rejects |rho| > 1 and non-positive variances', () => {
    expect(() =>
      hestonPrice({
        type: 'call',
        input,
        parameters: { v0: 0.04, kappa: 1, theta: 0.04, sigma: 0.3, rho: 1.5 },
      }),
    ).toThrow(InputError);
    expect(() =>
      hestonPrice({
        type: 'call',
        input,
        parameters: { v0: -0.04, kappa: 1, theta: 0.04, sigma: 0.3, rho: 0 },
      }),
    ).toThrow(InputError);
  });

  it('flags a Feller-condition violation as an info diagnostic (but still prices)', () => {
    // 2κθ = 2·1·0.04 = 0.08 < ξ² = 0.36
    const res = hestonPrice({
      type: 'call',
      input,
      parameters: {
        v0: 0.04,
        kappa: 1,
        theta: 0.04,
        sigma: 0.6,
        rho: -0.5,
      },
    });
    expect(res.value).toBeGreaterThan(0);
    expect(res.diagnostics.warnings.some((w) => w.code === 'heston.feller_violated')).toBe(true);
  });
});

describe('Heston — the ξ→0 limit and COS truncation (2026-08 defect-fix wave)', () => {
  // σ̄² = θ + (v₀ − θ)(1 − e^{−κT})/(κT): the time-average of the mean-reverting variance, which is
  // EXACTLY what Heston becomes as the vol-of-vol vanishes.
  const integratedVolatility = (p: HestonParameters, T: number): number =>
    Math.sqrt(p.theta + ((p.v0 - p.theta) * (1 - Math.exp(-p.kappa * T))) / (p.kappa * T));

  it('reproduces the documented BSM anchor at ξ = 1e-3 and 1e-4, at T = 1 and T = 10', () => {
    // The COS characteristic function divides by ξ² twice; below ξ²T ≈ 1e-6 the price is pure
    // cancellation noise (it was +8.8% at ξ=1e-4/T=10, and +3275% at ξ=1e-5/T=10). Each cell here
    // must land on the ξ→0 limit within 0.1%.
    for (const T of [1, 10]) {
      for (const xi of [1e-3, 1e-4]) {
        const parameters: HestonParameters = {
          v0: 0.04,
          kappa: 1.5,
          theta: 0.05,
          sigma: xi,
          rho: -0.6,
        };
        const bar = integratedVolatility(parameters, T);
        for (const type of ['call', 'put'] as const) {
          const cos = hestonCosineExpansionPrice({
            type,
            spot: 100,
            strike: 100,
            timeToExpiryYears: T,
            riskFreeRate: 0.03,
            dividendYield: 0.01,
            parameters,
          });
          const bsm = blackScholesPrice({
            type,
            spot: 100,
            strike: 100,
            timeToExpiryYears: T,
            riskFreeRate: 0.03,
            dividendYield: 0.01,
            volatility: bar,
          });
          expect(Math.abs(cos - bsm) / bsm, `${type} T=${T} ξ=${xi}`).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('discloses WHICH method priced it when the deterministic limit takes over', () => {
    const limit = hestonPrice({
      type: 'call',
      input: { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.03 },
      parameters: { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 1e-4, rho: -0.6 },
      options: { greeks: false },
    });
    expect(limit.diagnostics.method).toBe('bsm-deterministic-variance-limit');
    expect(limit.diagnostics.converged).toBe(true);
    expect(limit.diagnostics.warnings.some((w) => w.code === 'model.limitation')).toBe(true);
    // A normal vol-of-vol still goes through the expansion, and says so.
    const cos = hestonPrice({
      type: 'call',
      input: { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.03 },
      parameters: { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.6 },
      options: { greeks: false },
    });
    expect(cos.diagnostics.method).toBe('cos');
  });

  it('a Feller-violating long-dated set agrees with the QE-MC or is flagged unconverged', () => {
    // 2κθ = 0.09 ≪ ξ² = 1.44 at T = 5. The COS series converges beautifully to the WRONG number here
    // (23.81 at L=12, 23.12 at L=8, 25.16 at L=16) because the cumulants understate this variance
    // process's tail; the QE Monte-Carlo is stable at ~21.5 across 100→1600 steps. The engine must
    // therefore either match the MC or say it did not converge — silently returning 23.81 is the
    // defect. (The PUT at the same parameters IS range-stable and matches the MC through parity.)
    const parameters: HestonParameters = {
      v0: 0.005,
      kappa: 0.5,
      theta: 0.09,
      sigma: 1.2,
      rho: -0.9,
    };
    const input: HestonInput = {
      spot: 100,
      strike: 100,
      timeToExpiryYears: 5,
      riskFreeRate: 0.03,
      dividendYield: 0,
    };
    const analytic = hestonPrice({ type: 'call', input, parameters, options: { greeks: false } });
    const monteCarlo = hestonMonteCarloPrice({
      type: 'call',
      input,
      parameters,
      options: { paths: 60_000, seed: 20260802, steps: 100 },
    });
    const withinMonteCarloError =
      Math.abs(analytic.value - monteCarlo.value) < 3 * monteCarlo.monteCarlo.standardError!;
    expect(
      withinMonteCarloError || analytic.diagnostics.converged === false,
      `COS ${analytic.value} vs QE-MC ${monteCarlo.value} ± ${monteCarlo.monteCarlo.standardError}`,
    ).toBe(true);
    expect(analytic.diagnostics.warnings.some((w) => w.code === 'heston.feller_violated')).toBe(
      true,
    );
    if (!withinMonteCarloError) {
      expect(
        analytic.diagnostics.warnings.some((w) => w.code === 'engine.discretization_inadequate'),
      ).toBe(true);
    }
  });

  it('a well-behaved parameter set is NOT flagged by the range-stability check', () => {
    for (const T of [1, 10]) {
      for (const type of ['call', 'put'] as const) {
        const res = hestonPrice({
          type,
          input: { spot: 100, strike: 100, timeToExpiryYears: T, riskFreeRate: 0.03 },
          parameters: { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.6 },
          options: { greeks: false },
        });
        expect(res.diagnostics.converged, `${type} T=${T}`).toBe(true);
        expect(
          res.diagnostics.warnings.some((w) => w.code === 'engine.discretization_inadequate'),
        ).toBe(false);
      }
    }
  });

  it('the Feller warning names the engine that IS reliable there', () => {
    const res = hestonPrice({
      type: 'call',
      input: { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.03 },
      parameters: { v0: 0.04, kappa: 1, theta: 0.04, sigma: 0.6, rho: -0.5 },
      options: { greeks: false },
    });
    const feller = res.diagnostics.warnings.find((w) => w.code === 'heston.feller_violated')!;
    expect(feller.message).toMatch(/monteCarloPrice/);
    // It must NOT claim the COS expansion handles the regime — that was the false part.
    expect(feller.message).not.toMatch(/the QE scheme and CF both handle it/);
  });

  it('an absurd truncation width is caught, never returned as a plausible positive number', () => {
    // L = 40 at T = 10 used to sum to +9.5e4 for a contract capped at S = 100.
    const res = hestonPrice({
      type: 'call',
      input: { spot: 100, strike: 100, timeToExpiryYears: 10, riskFreeRate: 0.03 },
      parameters: { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.6 },
      options: { greeks: false, truncation: 40 },
    });
    expect(res.diagnostics.converged).toBe(false);
    expect(res.value).toBeLessThanOrEqual(100); // inside the no-arbitrage ceiling
    expect(res.diagnostics.warnings.length).toBeGreaterThan(0);
  });
});

describe('Heston — edge honesty (WS2.10)', () => {
  const parameters: HestonParameters = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.6, rho: -0.7 };

  it('hestonImpliedVolatility returns the standard IV envelope (value + converged + reason)', () => {
    const impliedVolatility = hestonImpliedVolatility({
      type: 'put',
      input: { spot: 100, strike: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.03 },
      parameters,
    });
    expect(impliedVolatility.converged).toBe(true);
    expect(impliedVolatility.value).toBeGreaterThan(0);
    expect(impliedVolatility.reason).toBeUndefined();
  });

  it('a blown-up COS sum is reported as converged:false + heston.cosine_expansion_unstable, not a clean 0', () => {
    // Extreme vol-of-vol + near-perfect negative correlation, priced with far too few COS terms and a
    // narrow truncation at a very short, deep-OTM contract: the cosine reconstruction oscillates below
    // zero. The clamp keeps the value ≥ 0, but the price must NOT present as converged.
    const wild: HestonParameters = { v0: 0.5, kappa: 0.2, theta: 0.5, sigma: 3, rho: -0.99 };
    const res = hestonPrice({
      type: 'call',
      input: { spot: 100, strike: 300, timeToExpiryYears: 0.02, riskFreeRate: 0.03 },
      parameters: wild,
      options: {
        terms: 8,
        truncation: 2,
        greeks: false,
      },
    });
    expect(res.value).toBeGreaterThanOrEqual(0); // clamp holds
    expect(res.diagnostics.converged).toBe(false);
    expect(
      res.diagnostics.warnings.some((w) => w.code === 'heston.cosine_expansion_unstable'),
    ).toBe(true);
  });

  it('a well-conditioned COS price is converged with no instability flag', () => {
    const res = hestonPrice({
      type: 'call',
      input: { spot: 100, strike: 100, timeToExpiryYears: 0.5, riskFreeRate: 0.03 },
      parameters,
      options: {
        greeks: false,
      },
    });
    expect(res.diagnostics.converged).toBe(true);
    expect(
      res.diagnostics.warnings.some((w) => w.code === 'heston.cosine_expansion_unstable'),
    ).toBe(false);
  });
});
