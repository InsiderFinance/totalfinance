import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blackScholes } from '@totalfinance/options/black-scholes';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

/**
 * Golden case (textbook): S=K=100, T=1, r=5%, σ=20%, no dividends.
 * The European call is the canonical 10.4506 reference.
 */
const G = { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, volatility: 0.2 };

describe('BSM price: golden vectors', () => {
  it('prices the canonical European call (≈ 10.4506)', () => {
    expect(blackScholes.call(G)).toBeCloseTo(10.4506, 4);
  });

  it('prices the canonical European put (≈ 5.5735)', () => {
    // Put = Call - S + K e^{-rT} = 10.4506 - 100 + 100 e^{-0.05} = 5.5735
    expect(blackScholes.put(G)).toBeCloseTo(5.573526022239441, 6);
  });

  it('honors a continuous dividend yield (lowers the call; parity holds)', () => {
    const parameters = {
      spot: 100,
      strike: 95,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.04,
      volatility: 0.25,
    };
    const withDiv = blackScholes.call({ ...parameters, dividendYield: 0.02 });
    const noDiv = blackScholes.call({ ...parameters, dividendYield: 0 });
    expect(withDiv).toBeLessThan(noDiv);
    const put = blackScholes.put({ ...parameters, dividendYield: 0.02 });
    const parity = 100 * Math.exp(-0.02 * 0.5) - 95 * Math.exp(-0.04 * 0.5);
    expect(withDiv - put).toBeCloseTo(parity, 8);
  });

  it('deep ITM call approaches forward intrinsic', () => {
    const v = blackScholes.call({
      spot: 200,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
    });
    const intrinsic = 200 - 100 * Math.exp(-0.05);
    expect(v).toBeGreaterThan(intrinsic);
    expect(v).toBeCloseTo(intrinsic, 1);
  });
});

describe('BSM Greeks: reference values for the golden call', () => {
  const g = blackScholes.greeks({ ...G, type: 'call' });

  it('delta = Φ(d1) ≈ 0.6368', () => {
    expect(g.delta).toBeCloseTo(0.6368306511756191, 6);
  });
  it('gamma ≈ 0.018762', () => {
    expect(g.gamma).toBeCloseTo(0.018762017345846895, 6);
  });
  it('vega per 1% ≈ 0.37524', () => {
    expect(g.vega).toBeCloseTo(0.3752403469169379, 6);
  });
  it('theta per day ≈ -0.01757', () => {
    expect(g.theta).toBeCloseTo(-0.017572803993610154, 5);
  });
  it('rho per 1% ≈ 0.53232', () => {
    expect(g.rho).toBeCloseTo(0.5323248154537634, 6);
  });
});

describe('BSM Greeks: agree with finite differences', () => {
  const base = { ...G, type: 'call' as const };
  const price = (o: typeof base) =>
    blackScholesPrice({
      type: o.type,
      spot: o.spot,
      strike: o.strike,
      timeToExpiryYears: o.timeToExpiryYears,
      riskFreeRate: o.riskFreeRate,
      dividendYield: 0,
      volatility: o.volatility,
    });

  it('delta ≈ dPrice/dSpot', () => {
    const h = 1e-4;
    const fd =
      (price({ ...base, spot: base.spot + h }) - price({ ...base, spot: base.spot - h })) / (2 * h);
    expect(blackScholes.greeks(base).delta).toBeCloseTo(fd, 6);
  });

  it('gamma ≈ d²Price/dSpot²', () => {
    const h = 1e-2;
    const fd =
      (price({ ...base, spot: base.spot + h }) -
        2 * price(base) +
        price({ ...base, spot: base.spot - h })) /
      (h * h);
    expect(blackScholes.greeks(base).gamma).toBeCloseTo(fd, 6);
  });

  it('vega (per 1%) ≈ dPrice/dVolatility / 100', () => {
    const h = 1e-5;
    const fd =
      (price({ ...base, volatility: base.volatility + h }) -
        price({ ...base, volatility: base.volatility - h })) /
      (2 * h);
    expect(blackScholes.greeks(base).vega).toBeCloseTo(fd / 100, 6);
  });

  it('rho (per 1%) ≈ dPrice/dRate / 100', () => {
    const h = 1e-6;
    const fd =
      (price({ ...base, riskFreeRate: base.riskFreeRate + h }) -
        price({ ...base, riskFreeRate: base.riskFreeRate - h })) /
      (2 * h);
    expect(blackScholes.greeks(base).rho).toBeCloseTo(fd / 100, 6);
  });
});

describe('BSM properties', () => {
  const arb = {
    spot: fc.double({ min: 20, max: 300, noNaN: true }),
    strike: fc.double({ min: 20, max: 300, noNaN: true }),
    timeToExpiryYears: fc.double({ min: 0.02, max: 3, noNaN: true }),
    riskFreeRate: fc.double({ min: -0.02, max: 0.12, noNaN: true }),
    volatility: fc.double({ min: 0.02, max: 1.5, noNaN: true }),
    q: fc.double({ min: 0, max: 0.06, noNaN: true }),
  };

  it('property: put–call parity C − P = S e^{-qT} − K e^{-rT}', () => {
    fc.assert(
      fc.property(
        arb.spot,
        arb.strike,
        arb.timeToExpiryYears,
        arb.riskFreeRate,
        arb.volatility,
        arb.q,
        (spot, strike, t, rate, vol, q) => {
          const c = blackScholes.call({
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            volatility: vol,
            dividendYield: q,
          });
          const p = blackScholes.put({
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            volatility: vol,
            dividendYield: q,
          });
          const rhs = spot * Math.exp(-q * t) - strike * Math.exp(-rate * t);
          expect(c - p).toBeCloseTo(rhs, 8);
        },
      ),
    );
  });

  it('property: call is monotonic increasing in spot', () => {
    fc.assert(
      fc.property(
        arb.spot,
        arb.strike,
        arb.timeToExpiryYears,
        arb.riskFreeRate,
        arb.volatility,
        (spot, strike, t, rate, vol) => {
          const lo = blackScholes.call({
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            volatility: vol,
          });
          const hi = blackScholes.call({
            spot: spot + 1,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            volatility: vol,
          });
          expect(hi).toBeGreaterThanOrEqual(lo - 1e-9);
        },
      ),
    );
  });

  it('property: gamma is non-negative', () => {
    fc.assert(
      fc.property(
        arb.spot,
        arb.strike,
        arb.timeToExpiryYears,
        arb.riskFreeRate,
        arb.volatility,
        (spot, strike, t, rate, vol) => {
          expect(
            blackScholes.greeks({
              spot,
              strike,
              timeToExpiryYears: t,
              riskFreeRate: rate,
              volatility: vol,
              type: 'call',
            }).gamma,
          ).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('property: price is monotonic increasing in volatility', () => {
    fc.assert(
      fc.property(
        arb.spot,
        arb.strike,
        arb.timeToExpiryYears,
        arb.riskFreeRate,
        arb.volatility,
        (spot, strike, t, rate, vol) => {
          const lo = blackScholes.call({
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            volatility: vol,
          });
          const hi = blackScholes.call({
            spot,
            strike,
            timeToExpiryYears: t,
            riskFreeRate: rate,
            volatility: vol + 0.01,
          });
          expect(hi).toBeGreaterThanOrEqual(lo - 1e-9);
        },
      ),
    );
  });
});
