/**
 * Extended (higher-order) Greeks through the pro `option.price({ contract: ..., market: { extendedGreeks: true } })` path.
 * The closed-form engines return their exact analytic set; the numerical (lattice/PDE/approximation)
 * engines return the full set by finite difference — verified to converge to the BSM analytic set on a
 * European contract, to be finite + sane on an American contract (Bjerksund–Stensland), and the flag
 * toggles between the 5 first-order and the full 16-greek set.
 */

import { describe, expect, it } from 'vitest';
import { engines, market, option, type ExtendedGreeks } from '@totalfinance/options';
import { blackScholesExtendedGreeks } from '@totalfinance/options/black-scholes';
import { black76ExtendedGreeks } from '@totalfinance/options/black76';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2027-01-01'; // T = 1
const KEYS = [
  'delta',
  'gamma',
  'theta',
  'vega',
  'rho',
  'vanna',
  'charm',
  'vomma',
  'speed',
  'color',
  'phi',
  'zomma',
  'veta',
  'vera',
  'ultima',
  'lambda',
] as const;

describe('option.price extendedGreeks — analytic engines return the exact closed form', () => {
  it('BSM (blackScholesMerton) matches blackScholesExtendedGreeks to machine precision', () => {
    const mkt = market({
      spot: 105,
      riskFreeRate: 0.04,
      volatility: 0.25,
      dividendYield: 0.01,
      asOf,
    });
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const res = option.price({
      contract: c,
      market: mkt,
      engine: engines.blackScholesMerton(),
      extendedGreeks: true,
    });
    const t = res.assumptions.timeToExpiryYears as number;
    const a = blackScholesExtendedGreeks({
      type: 'call',
      spot: 105,
      strike: 100,
      timeToExpiryYears: t,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      volatility: 0.25,
    });
    for (const k of KEYS) expect((res.greeks as ExtendedGreeks)[k]).toBeCloseTo(a[k]!, 10);
  });

  it('Black-76 matches black76ExtendedGreeks', () => {
    const mkt = market({ spot: 100, forward: 100, riskFreeRate: 0.04, volatility: 0.2, asOf });
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const res = option.price({
      contract: c,
      market: mkt,
      engine: engines.black76(),
      extendedGreeks: true,
    });
    const t = res.assumptions.timeToExpiryYears as number;
    const a = black76ExtendedGreeks({
      type: 'call',
      forward: 100,
      strike: 100,
      timeToExpiryYears: t,
      riskFreeRate: 0.04,
      volatility: 0.2,
    });
    for (const k of KEYS) expect((res.greeks as ExtendedGreeks)[k]).toBeCloseTo(a[k]!, 10);
  });
});

describe('option.price extendedGreeks — numerical engines (finite differences)', () => {
  const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });

  it('a European contract on a Leisen–Reimer lattice converges to the BSM analytic extended set', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const res = option.price({
      contract: c,
      market: mkt,
      engine: engines.binomial({ variant: 'leisen-reimer', steps: 999 }),
      extendedGreeks: true,
    });
    const g = res.greeks as ExtendedGreeks;
    const t = res.assumptions.timeToExpiryYears as number;
    const a = blackScholesExtendedGreeks({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: t,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.2,
    });
    // Relative closeness scaled by order — the lattice adds discretization noise the FD amplifies.
    const near = (got: number, exp: number, relTol: number): void =>
      expect(Math.abs(got - exp) / Math.max(Math.abs(exp), 1e-3)).toBeLessThan(relTol);
    // first-order
    near(g.delta, a.delta, 1e-3);
    near(g.gamma, a.gamma, 2e-3);
    near(g.vega, a.vega, 2e-3);
    near(g.theta, a.theta, 3e-3);
    near(g.rho, a.rho, 2e-3);
    near(g.phi, a.phi, 5e-3);
    near(g.lambda!, a.lambda!, 1e-3);
    // second-order
    near(g.vanna, a.vanna, 2e-2);
    near(g.vomma, a.vomma, 3e-2);
    near(g.charm, a.charm, 2e-2);
    near(g.zomma, a.zomma, 5e-2);
    near(g.veta, a.veta, 3e-2);
    near(g.vera, a.vera, 3e-2);
    // third-order are the noisiest; require only finiteness + the right sign.
    for (const k of KEYS) expect(Number.isFinite(g[k])).toBe(true);
    expect(Math.sign(g.speed)).toBe(Math.sign(a.speed));
    expect(Math.sign(g.ultima)).toBe(Math.sign(a.ultima));
  });

  it('Bjerksund–Stensland 2002 (American) returns a finite, sane full extended set', () => {
    const c = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const g = option.price({
      contract: c,
      market: mkt,
      engine: engines.bjerksundStensland2002(),
      extendedGreeks: true,
    }).greeks as ExtendedGreeks;
    for (const k of KEYS) expect(Number.isFinite(g[k])).toBe(true);
    // Sanity (not golden): an American put is negative-delta, positive-gamma, |delta| ≤ 1.
    expect(g.delta).toBeLessThan(0);
    expect(g.gamma).toBeGreaterThan(0);
    expect(Math.abs(g.delta)).toBeLessThanOrEqual(1 + 1e-9);
    expect(g.lambda).toBeLessThan(0); // levered short
  });

  it('the flag toggles the greek set: first-order-only vs the full 16', () => {
    const c = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const first = option.price({
      contract: c,
      market: mkt,
      engine: engines.bjerksundStensland2002(),
    }).greeks!;
    const full = option.price({
      contract: c,
      market: mkt,
      engine: engines.bjerksundStensland2002(),
      extendedGreeks: true,
    }).greeks!;
    expect('vanna' in first).toBe(false); // first-order only by default
    expect('vanna' in full).toBe(true);
    expect('ultima' in full).toBe(true);
    // the first-order values agree between the two paths (same FD engine, same base state).
    expect(full.delta).toBeCloseTo(first.delta, 6);
    expect(full.gamma).toBeCloseTo(first.gamma, 6);
  });
});

describe('option.price extendedGreeks — stochastic engines (finite differences)', () => {
  const near = (got: number, exp: number, relTol: number): void =>
    expect(Math.abs(got - exp) / Math.max(Math.abs(exp), 1e-3)).toBeLessThan(relTol);

  it('SABR (β=1, ν=0) matches the Black-76 analytic extended set — α is the vol level', () => {
    // With ν=0, β=1 the SABR vol is exactly α, so the model IS Black-76 at vol=α.
    const mkt = market({ spot: 100, forward: 100, riskFreeRate: 0.03, asOf });
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const res = option.price({
      contract: c,
      market: mkt,
      engine: engines.sabr({ alpha: 0.2, beta: 1, rho: 0, nu: 0 }),
      extendedGreeks: true,
    });
    const g = res.greeks as ExtendedGreeks;
    const t = res.assumptions.timeToExpiryYears as number;
    const a = black76ExtendedGreeks({
      type: 'call',
      forward: 100,
      strike: 100,
      timeToExpiryYears: t,
      riskFreeRate: 0.03,
      volatility: 0.2,
    });
    for (const k of KEYS) {
      if (k === 'phi') continue; // forward model: no dividend yield
      near(g[k]!, a[k]!, 5e-3);
    }
    expect(g.phi).toBe(0);
  });

  it('Heston returns a finite full extended set, consistent with its first-order path', () => {
    const mkt = market({ spot: 100, riskFreeRate: 0.03, asOf });
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 105,
      expiry,
      style: 'european',
    });
    const parameters = { v0: 0.04, kappa: 1.5, theta: 0.04, sigma: 0.5, rho: -0.6 };
    const full = option.price({
      contract: c,
      market: mkt,
      engine: engines.heston(parameters),
      extendedGreeks: true,
    }).greeks as ExtendedGreeks;
    const first = option.price({
      contract: c,
      market: mkt,
      engine: engines.heston(parameters),
    }).greeks!;
    for (const k of KEYS) expect(Number.isFinite(full[k])).toBe(true);
    // the extended path's first-order greeks agree with the standalone first-order path (both FD, but
    // with slightly different step sizes — agree to ~1e-4, not machine precision).
    near(full.delta, first.delta, 1e-4);
    near(full.gamma, first.gamma, 1e-3);
    near(full.vega, first.vega, 1e-3);
    expect('vanna' in first).toBe(false);
    expect('ultima' in full).toBe(true);
  });

  it('Monte-Carlo (GBM) matches the BSM analytic extended set by common-random-number FD', () => {
    const mkt = market({ spot: 100, riskFreeRate: 0.03, volatility: 0.2, asOf });
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const res = option.price({
      contract: c,
      market: mkt,
      engine: engines.monteCarlo({ paths: 400_000, seed: 12345, method: 'sobol' }),
      extendedGreeks: true,
    });
    const g = res.greeks as ExtendedGreeks;
    const t = res.assumptions.timeToExpiryYears as number;
    const a = blackScholesExtendedGreeks({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: t,
      riskFreeRate: 0.03,
      dividendYield: 0,
      volatility: 0.2,
    });
    // first/second order tight; third-order (speed/color/ultima) carries MC noise → sign only.
    near(g.delta, a.delta, 5e-3);
    near(g.gamma, a.gamma, 1e-2);
    near(g.vega, a.vega, 5e-3);
    near(g.rho, a.rho, 5e-3);
    near(g.phi, a.phi, 5e-3);
    near(g.vanna, a.vanna, 3e-2);
    near(g.vomma, a.vomma, 2e-2);
    near(g.charm, a.charm, 2e-2);
    near(g.lambda!, a.lambda!, 5e-3);
    for (const k of KEYS) expect(Number.isFinite(g[k])).toBe(true);
    expect(Math.sign(g.speed)).toBe(Math.sign(a.speed));
  });
});
