import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bachelier } from '@totalfinance/options';
import {
  bachelierExtendedGreeks,
  bachelierGreeks,
  bachelierPrice,
} from '@totalfinance/options/bachelier';

describe('Bachelier (normal) price', () => {
  it('ATM call with r=0 equals σ√T·φ(0)', () => {
    // F=K=100, T=1, r=0, σ_N=10 → 10·1·0.39894 ≈ 3.9894
    expect(
      bachelier.call({
        forward: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0,
        normalVolatility: 10,
      }),
    ).toBeCloseTo(10 / Math.sqrt(2 * Math.PI), 8);
  });

  it('call equals put when ATM and r=0', () => {
    const args = {
      forward: 50,
      strike: 50,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0,
      normalVolatility: 5,
    };
    expect(bachelier.call(args)).toBeCloseTo(bachelier.put(args), 10);
  });

  it('property: put–call parity C−P = e^{-rT}(F−K)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 20, max: 300, noNaN: true }),
        fc.double({ min: 20, max: 300, noNaN: true }),
        fc.double({ min: 0.05, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 0.08, noNaN: true }),
        fc.double({ min: 0.5, max: 50, noNaN: true }),
        (F, K, t, r, vol) => {
          const c = bachelier.call({
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            normalVolatility: vol,
          });
          const p = bachelier.put({
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            normalVolatility: vol,
          });
          expect(c - p).toBeCloseTo(Math.exp(-r * t) * (F - K), 6);
        },
      ),
    );
  });
});

describe('Bachelier Greeks agree with finite differences', () => {
  const base = {
    type: 'call' as const,
    forward: 100,
    strike: 102,
    timeToExpiryYears: 0.75,
    riskFreeRate: 0.03,
    normalVolatility: 12,
  };
  const price = (o: typeof base) =>
    bachelierPrice({
      type: o.type,
      forward: o.forward,
      strike: o.strike,
      timeToExpiryYears: o.timeToExpiryYears,
      riskFreeRate: o.riskFreeRate,
      normalVolatility: o.normalVolatility,
    });
  const g = bachelier.greeks(base);

  it('delta ≈ dP/dF', () => {
    const h = 1e-3;
    const fd =
      (price({ ...base, forward: base.forward + h }) -
        price({ ...base, forward: base.forward - h })) /
      (2 * h);
    expect(g.delta).toBeCloseTo(fd, 6);
  });
  it('gamma ≈ d²P/dF²', () => {
    const h = 1e-1;
    const fd =
      (price({ ...base, forward: base.forward + h }) -
        2 * price(base) +
        price({ ...base, forward: base.forward - h })) /
      (h * h);
    expect(g.gamma).toBeCloseTo(fd, 5);
  });
  it('vega (per 1.00 normal vol) ≈ dP/dσ', () => {
    const h = 1e-4;
    const fd =
      (price({ ...base, normalVolatility: base.normalVolatility + h }) -
        price({ ...base, normalVolatility: base.normalVolatility - h })) /
      (2 * h);
    expect(g.vega).toBeCloseTo(fd, 6);
  });
  it('theta (per day) ≈ -dP/dT / 365', () => {
    const h = 1e-5;
    const fd =
      -(
        price({ ...base, timeToExpiryYears: base.timeToExpiryYears + h }) -
        price({ ...base, timeToExpiryYears: base.timeToExpiryYears - h })
      ) /
      (2 * h);
    expect(g.theta).toBeCloseTo(fd / 365, 5);
  });
  it('rho (per 1%) ≈ dP/dr / 100', () => {
    const h = 1e-6;
    const fd =
      (price({ ...base, riskFreeRate: base.riskFreeRate + h }) -
        price({ ...base, riskFreeRate: base.riskFreeRate - h })) /
      (2 * h);
    expect(g.rho).toBeCloseTo(fd / 100, 6);
  });
});

describe('Bachelier implied volatility', () => {
  it('price → IV → price round trip', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 30, max: 200, noNaN: true }),
        fc.double({ min: 30, max: 200, noNaN: true }),
        fc.double({ min: 0.05, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 0.06, noNaN: true }),
        fc.double({ min: 0.5, max: 40, noNaN: true }),
        fc.constantFrom('call' as const, 'put' as const),
        (F, K, t, r, vol, type) => {
          const price = bachelierPrice({
            type,
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            normalVolatility: vol,
          });
          fc.pre(price > 1e-3);
          const impliedVolatility = bachelier.impliedVolatility({
            price,
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            type,
          });
          const reprice = bachelierPrice({
            type,
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            normalVolatility: impliedVolatility,
          });
          expect(Math.abs(reprice - price) / Math.max(1, price)).toBeLessThan(1e-6);
        },
      ),
    );
  });

  it('reports vega units as perPoint in assumptions', () => {
    const ex = bachelier.greeks.explain({
      forward: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0,
      normalVolatility: 10,
      type: 'call',
    });
    expect(ex.assumptions.units?.vega).toBe('perPoint');
  });

  // WS1.19: the module advertises "trades through zero"; negative forward/strike must be accepted.
  it('prices and inverts IV at NEGATIVE forward and strike (rates convention)', () => {
    const F = -0.0025;
    const K = -0.005;
    const t = 0.5;
    const r = 0;
    const vol = 0.01; // normal vol in rate units
    for (const type of ['call', 'put'] as const) {
      const price = bachelierPrice({
        type,
        forward: F,
        strike: K,
        timeToExpiryYears: t,
        riskFreeRate: r,
        normalVolatility: vol,
      });
      expect(Number.isFinite(price)).toBe(true);
      expect(price).toBeGreaterThan(0);
      const impliedVolatility = bachelier.impliedVolatility({
        price,
        forward: F,
        strike: K,
        timeToExpiryYears: t,
        riskFreeRate: r,
        type,
      });
      expect(impliedVolatility).toBeCloseTo(vol, 6);
    }
  });

  it('facade call/put accept negative forward and strike', () => {
    const args = {
      forward: -0.0025,
      strike: -0.005,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0,
      normalVolatility: 0.01,
    };
    expect(Number.isFinite(bachelier.call(args))).toBe(true);
    expect(Number.isFinite(bachelier.put(args))).toBe(true);
  });
});

describe('Bachelier extended Greeks agree with finite differences', () => {
  for (const type of ['call', 'put'] as const) {
    it(`${type} higher-order greeks match FD of the first-order greeks`, () => {
      // normal vol in price units; a slightly OTM strike to exercise the d≠0 terms.
      const b = {
        forward: 100,
        strike: 103,
        timeToExpiryYears: 0.75,
        riskFreeRate: 0.03,
        normalVolatility: 2.5,
      };
      const x = bachelierExtendedGreeks({
        type,
        forward: b.forward,
        strike: b.strike,
        timeToExpiryYears: b.timeToExpiryYears,
        riskFreeRate: b.riskFreeRate,
        normalVolatility: b.normalVolatility,
      });
      const g = (F = b.forward, sig = b.normalVolatility, T = b.timeToExpiryYears) =>
        bachelierGreeks({
          type,
          forward: F,
          strike: b.strike,
          timeToExpiryYears: T,
          riskFreeRate: b.riskFreeRate,
          normalVolatility: sig,
        });
      const P = () =>
        bachelierPrice({
          type,
          forward: b.forward,
          strike: b.strike,
          timeToExpiryYears: b.timeToExpiryYears,
          riskFreeRate: b.riskFreeRate,
          normalVolatility: b.normalVolatility,
        });
      const X = (sig: number) =>
        bachelierExtendedGreeks({
          type,
          forward: b.forward,
          strike: b.strike,
          timeToExpiryYears: b.timeToExpiryYears,
          riskFreeRate: b.riskFreeRate,
          normalVolatility: sig,
        });
      const hF = 0.01,
        hV = 1e-4,
        timeStepYears = 1e-5;

      expect(x.vanna).toBeCloseTo(
        (g(b.forward, b.normalVolatility + hV).delta -
          g(b.forward, b.normalVolatility - hV).delta) /
          (2 * hV),
        6,
      );
      expect(x.vomma).toBeCloseTo(
        (g(b.forward, b.normalVolatility + hV).vega - g(b.forward, b.normalVolatility - hV).vega) /
          (2 * hV),
        5,
      );
      expect(x.speed).toBeCloseTo(
        (g(b.forward + hF).gamma - g(b.forward - hF).gamma) / (2 * hF),
        5,
      );
      expect(x.charm).toBeCloseTo(
        (g(b.forward, b.normalVolatility, b.timeToExpiryYears + timeStepYears).delta -
          g(b.forward, b.normalVolatility, b.timeToExpiryYears - timeStepYears).delta) /
          (2 * timeStepYears),
        6,
      );
      expect(x.color).toBeCloseTo(
        (g(b.forward, b.normalVolatility, b.timeToExpiryYears + timeStepYears).gamma -
          g(b.forward, b.normalVolatility, b.timeToExpiryYears - timeStepYears).gamma) /
          (2 * timeStepYears),
        6,
      );
      expect(x.zomma).toBeCloseTo(
        (g(b.forward, b.normalVolatility + hV).gamma -
          g(b.forward, b.normalVolatility - hV).gamma) /
          (2 * hV),
        6,
      );
      expect(x.veta).toBeCloseTo(
        (g(b.forward, b.normalVolatility, b.timeToExpiryYears + timeStepYears).vega -
          g(b.forward, b.normalVolatility, b.timeToExpiryYears - timeStepYears).vega) /
          (2 * timeStepYears),
        5,
      );
      expect(x.vera).toBeCloseTo(
        ((g(b.forward, b.normalVolatility + hV).rho - g(b.forward, b.normalVolatility - hV).rho) *
          100) /
          (2 * hV),
        5,
      );
      expect(x.ultima).toBeCloseTo(
        (X(b.normalVolatility + hV).vomma - X(b.normalVolatility - hV).vomma) / (2 * hV),
        5,
      );
      expect(x.phi).toBe(0); // no dividend yield in the normal forward model
      expect(x.lambda).toBeCloseTo((g().delta * b.forward) / P(), 8);
    });
  }
});
