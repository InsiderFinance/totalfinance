import { describe, expect, it } from 'vitest';
import { blackScholes, engines, impliedVolatility, market, option } from '@totalfinance/options';

/**
 * C8 — the flagship `@example` blocks (bs, option, market, engines, impliedVolatility) EXECUTE
 * here with value assertions. A doc example that stops compiling or starts lying fails CI; keep
 * this file in lock-step with the JSDoc in black-scholes.ts / pro.ts / market.ts / engines.ts /
 * iv.ts.
 */
describe('flagship @example blocks run and tell the truth', () => {
  it('bs example: plain price + explained greeks', () => {
    const p = blackScholes.price({
      spot: 100,
      strike: 105,
      timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045,
      volatility: 0.22,
      type: 'call',
    });
    expect(p).toBeCloseTo(0.898, 3);
    const { value, assumptions, diagnostics } = blackScholes.greeks.explain({
      spot: 100,
      strike: 105,
      timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045,
      volatility: 0.22,
      type: 'call',
    });
    expect(value.delta).toBeGreaterThan(0);
    expect(value.theta).toBeLessThan(0);
    expect(assumptions).toBeDefined();
    expect(diagnostics.warnings).toEqual([]);
  });

  it('option/market example: usEquityCall → price → .value (the documented field)', () => {
    const contract = option.usEquityCall({ underlying: 'AAPL', strike: 200, expiry: '2026-09-18' });
    const result = option.price({
      contract,
      market: market({
        spot: 195.3,
        riskFreeRate: 0.045,
        volatility: 0.24,
        asOf: '2026-07-20T10:30:00-04:00',
      }),
    });
    expect(result.value).toBeGreaterThan(0);
    expect(result.greeks?.delta).toBeGreaterThan(0);
    const impliedVolatility = option.impliedVolatility({
      contract,
      market: market({
        spot: 195.3,
        riskFreeRate: 0.045,
        price: 4.1,
        asOf: '2026-07-20T10:30:00-04:00',
      }),
    });
    expect(impliedVolatility.diagnostics.converged).toBe(true);
    expect(impliedVolatility.value).toBeGreaterThan(0);
  });

  it('engines example: explicit engine override + compareEngines', () => {
    const contract = option.usEquityCall({ underlying: 'AAPL', strike: 200, expiry: '2026-09-18' });
    const mkt = market({
      spot: 195,
      riskFreeRate: 0.045,
      volatility: 0.24,
      asOf: '2026-07-20T10:30:00-04:00',
    });
    const auto = option.price({ contract, market: mkt });
    const lattice = option.price({
      contract,
      market: mkt,
      engine: engines.binomial({ steps: 501 }),
    });
    expect(lattice.value).toBeCloseTo(auto.value, 2);
    const cmp = option.compareEngines({ contract, market: mkt });
    expect(cmp.rows.length).toBeGreaterThan(1);
  });

  it('impliedVolatility example: value + converged + method, as documented', () => {
    const solved = impliedVolatility({
      price: 2.31,
      spot: 100,
      strike: 105,
      timeToExpiryYears: 30 / 365,
      riskFreeRate: 0.045,
      type: 'call',
    });
    expect(solved.diagnostics.converged).toBe(true);
    expect(solved.value).toBeGreaterThan(0.1);
    expect(solved.diagnostics.method).toBeTypeOf('string');
  });
});
