import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import {
  americanImpliedVolatility,
  engines,
  impliedVolatility,
  impliedVolatilityMany,
  market,
  option,
} from '@totalfinance/options';

const asOf = Date.UTC(2026, 0, 1, 21);
const expiry = '2027-01-01'; // T = 1

describe('American implied volatility (WS4.2)', () => {
  it('round-trips: price an American put at σ=0.32, invert, recover 0.32', () => {
    const sigma = 0.32;
    const put = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const priced = engines.bjerksundStensland2002().price({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.05, volatility: sigma, asOf }),
    });
    const impliedVolatility = option.impliedVolatility({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.05, price: priced.value, asOf }),
    });
    expect(impliedVolatility.diagnostics.engine).toBe('bjerksund-stensland-2002');
    expect(impliedVolatility.diagnostics.method).toBe('brent');
    expect(impliedVolatility.diagnostics.converged).toBe(true);
    expect(impliedVolatility.value).toBeCloseTo(sigma, 6);
  });

  it('a deep-ITM American put AT intrinsic returns a failure, not a fabricated vol', () => {
    // spot 100, strike 200 → intrinsic 100; price exactly intrinsic (no time value).
    const put = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 200,
      expiry,
      style: 'american',
    });
    const impliedVolatility = option.impliedVolatility({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.05, price: 100, asOf }),
    });
    expect(impliedVolatility.diagnostics.converged).toBe(false);
    expect(impliedVolatility.value).toBeNull();
    expect(impliedVolatility.diagnostics.warnings.some((w) => w.severity === 'error')).toBe(true);
  });

  it('a below-intrinsic price fails with impliedVolatility.below_intrinsic (no fabricated vol)', () => {
    const put = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 200,
      expiry,
      style: 'american',
    });
    const impliedVolatility = option.impliedVolatility({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.05, price: 90, asOf }),
    });
    expect(impliedVolatility.diagnostics.converged).toBe(false);
    expect(impliedVolatility.diagnostics.warnings[0]?.code).toBe(
      'implied_volatility.below_intrinsic',
    );
    expect(impliedVolatility.value).toBeNull();
  });

  it('European contracts still invert via closed-form BSM (unchanged path)', () => {
    const call = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const priced = option.price({
      contract: call,
      market: market({ spot: 100, riskFreeRate: 0.05, volatility: 0.25, asOf }),
    });
    const impliedVolatility = option.impliedVolatility({
      contract: call,
      market: market({ spot: 100, riskFreeRate: 0.05, price: priced.value, asOf }),
    });
    expect(impliedVolatility.diagnostics.engine).toBe('black-scholes-merton');
    expect(impliedVolatility.value).toBeCloseTo(0.25, 8);
  });

  it('accepts an engine override (binomial) for the American inversion', () => {
    const sigma = 0.28;
    const put = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const engine = engines.binomial({ variant: 'leisen-reimer', steps: 301 });
    const priced = engine.price({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.05, volatility: sigma, asOf }),
    });
    const impliedVolatility = option.impliedVolatility({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.05, price: priced.value, asOf }),
      engine,
    });
    expect(impliedVolatility.diagnostics.engine).toBe('binomial-leisen-reimer');
    expect(impliedVolatility.value).toBeCloseTo(sigma, 4);
  });

  it('a European contract inverts a NAMED engine, and refuses the closed-form knobs beside it', () => {
    // A European call under a Leisen–Reimer lattice: the closed-form inverse would silently answer
    // a different model. With `engine` named, the lattice itself is inverted (the American path's
    // kernel, on the discounted European band) and the diagnostics say so.
    const sigma = 0.27;
    const call = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const engine = engines.binomial({ variant: 'leisen-reimer', steps: 301 });
    const priced = engine.price({
      contract: call,
      market: market({ spot: 100, riskFreeRate: 0.05, volatility: sigma, asOf }),
    });
    const solved = option.impliedVolatility({
      contract: call,
      market: market({ spot: 100, riskFreeRate: 0.05, price: priced.value, asOf }),
      engine,
    });
    expect(solved.diagnostics).toMatchObject({
      engine: 'binomial-leisen-reimer',
      method: 'brent',
      converged: true,
    });
    expect(solved.assumptions.engine).toBe('binomial-leisen-reimer');
    expect(solved.value).toBeCloseTo(sigma, 4);
    // The European band is the DISCOUNTED one: a price under the discounted intrinsic (but above
    // the undiscounted S − K) is refused as below the bound, never solved.
    const deep = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 80,
      expiry,
      style: 'european',
    });
    const belowBand = option.impliedVolatility({
      contract: deep,
      market: market({ spot: 100, riskFreeRate: 0.05, price: 21, asOf }),
      engine,
    });
    expect(belowBand.value).toBeNull();
    expect(belowBand.diagnostics.warnings[0]).toMatchObject({
      code: 'implied_volatility.below_intrinsic',
      message: expect.stringContaining('European no-arbitrage lower bound'),
    });
    // Solver knobs belong to the closed-form route: naming both teaches instead of dropping one.
    expect(() =>
      option.impliedVolatility({
        contract: call,
        market: market({ spot: 100, riskFreeRate: 0.05, price: priced.value, asOf }),
        engine,
        method: 'newton',
      }),
    ).toThrowError(/not supported when an "engine" is named/);
  });

  it('the American door refuses a European contract and names the right door', () => {
    const call = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    expect(() =>
      americanImpliedVolatility({
        contract: call,
        market: market({ spot: 100, riskFreeRate: 0.05, price: 8, asOf }),
      }),
    ).toThrowError(/inverts American exercise only/);
  });

  it('the flat Black–Scholes heads no longer accept an engine they could never honour', () => {
    const row = {
      price: 8,
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0,
      type: 'call' as const,
    };
    for (const fn of [
      () => impliedVolatility(row, { engine: engines.bjerksundStensland2002() } as never),
      () => impliedVolatilityMany([row], { engine: engines.bjerksundStensland2002() } as never),
    ]) {
      let caught: unknown;
      try {
        fn();
      } catch (error) {
        caught = error;
      }
      expect((caught as { code?: string }).code).toBe(ErrorCode.InputUnknownField);
      expect(String((caught as Error).message)).toContain('engine');
    }
  });

  it('americanImpliedVolatility is exported directly and matches the pro path', () => {
    const put = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 105,
      expiry,
      style: 'american',
    });
    const priced = engines.bjerksundStensland2002().price({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.04, volatility: 0.3, asOf }),
    });
    const direct = americanImpliedVolatility({
      contract: put,
      market: market({ spot: 100, riskFreeRate: 0.04, price: priced.value, asOf }),
    });
    expect(direct.value).toBeCloseTo(0.3, 6);
  });
});
