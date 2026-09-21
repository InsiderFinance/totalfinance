import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ArbitrageError } from '@totalfinance/core';
import { impliedVolatility } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { blackScholes } from '@totalfinance/options/black-scholes';

describe('IV suspicious-input warnings (F9)', () => {
  const codes = (timeToExpiryYears: number) =>
    impliedVolatility({
      price: 5,
      spot: 100,
      strike: 100,
      timeToExpiryYears,
      riskFreeRate: 0.05,
      type: 'call',
    }).diagnostics.warnings.map((w) => w.code);

  it('flags a t given in days (integer > 5) as a suspicious horizonYears', () => {
    // t=30 is almost certainly "30 days" (30/365), not a 30-year option; solving it silently would
    // return a nonsense IV. The warning rides even the no-arbitrage failure the bad t triggers.
    expect(codes(30)).toContain('input.suspicious_time');
  });

  it('a normal year-fraction t carries no suspicious-time warning', () => {
    expect(codes(0.5)).not.toContain('input.suspicious_time');
  });
});

describe('implied volatility', () => {
  it('round-trips a known price to the input vol', () => {
    const price = blackScholes.call({
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    });
    const impliedVolatility = blackScholes.impliedVolatility({
      price,
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      type: 'call',
    });
    expect(impliedVolatility).toBeCloseTo(0.2, 8);
  });

  it('property: price → IV → price round trip (call & put)', () => {
    // The well-posed invariant (spec §20.3): a recovered IV reprices to the original price.
    // Exact vol recovery is ill-conditioned for deep-OTM options (vanishing vega), so we assert the
    // price round-trip, which is what implied vol actually guarantees.
    fc.assert(
      fc.property(
        fc.double({ min: 40, max: 160, noNaN: true }),
        fc.double({ min: 40, max: 160, noNaN: true }),
        fc.double({ min: 0.05, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 0.08, noNaN: true }),
        fc.double({ min: 0.05, max: 1.2, noNaN: true }),
        fc.constantFrom('call' as const, 'put' as const),
        (spot, strike, t, rate, vol, type) => {
          const price = blackScholesPrice({
            type,
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            dividendYield: 0,
            volatility: vol,
          });
          fc.pre(price > 1e-3);
          const impliedVolatility = blackScholes.impliedVolatility({
            price,
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            type,
          });
          const reprice = blackScholesPrice({
            type,
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            dividendYield: 0,
            volatility: impliedVolatility,
          });
          // Relative tolerance tied to the solver's price tolerance (1e-8·max(1,price)); robust for
          // both interior roots and near-the-bound (time value below machine precision) cases.
          const relErr = Math.abs(reprice - price) / Math.max(1, Math.abs(price));
          expect(relErr).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('recovers the exact vol for a well-conditioned ATM option', () => {
    for (const type of ['call', 'put'] as const) {
      const price = blackScholesPrice({
        type,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.03,
        dividendYield: 0,
        volatility: 0.35,
      });
      const impliedVolatility = blackScholes.impliedVolatility({
        price,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.03,
        type,
      });
      expect(impliedVolatility).toBeCloseTo(0.35, 6);
    }
  });

  it('throws ArbitrageError when the price is below intrinsic', () => {
    expect(() =>
      blackScholes.impliedVolatility({
        price: 0.01,
        spot: 200,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call',
      }),
    ).toThrowError(ArbitrageError);
  });

  it('.explain reports converged:false instead of throwing (below intrinsic)', () => {
    const r = blackScholes.impliedVolatility.explain({
      price: 0.01,
      spot: 200,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      type: 'call',
    });
    expect(r.diagnostics.converged).toBe(false);
    expect(r.value).toBeNull();
    expect(r.diagnostics.warnings[0]?.code).toBe('implied_volatility.below_intrinsic');
    expect(r.diagnostics.warnings[0]?.severity).toBe('error');
  });
});
