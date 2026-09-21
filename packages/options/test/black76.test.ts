import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ArbitrageError } from '@totalfinance/core';
import { black76 } from '@totalfinance/options';
import { black76ExtendedGreeks, black76Greeks, black76Price } from '@totalfinance/options/black76';

describe('Black-76 price', () => {
  it('matches a reference ATM value', () => {
    // F=K=100, T=1, r=5%, σ=20% → e^{-0.05}·100·(2Φ(0.1)-1) ≈ 7.57708
    expect(
      black76.call({
        forward: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.2,
      }),
    ).toBeCloseTo(7.57708, 4);
  });

  it('call equals put when F=K (parity, since C−P=e^{-rT}(F−K))', () => {
    const args = {
      forward: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.3,
    };
    expect(black76.call(args)).toBeCloseTo(black76.put(args), 10);
  });

  it('property: put–call parity C−P = e^{-rT}(F−K)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 20, max: 300, noNaN: true }),
        fc.double({ min: 20, max: 300, noNaN: true }),
        fc.double({ min: 0.05, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        (F, K, t, r, vol) => {
          const c = black76.call({
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            volatility: vol,
          });
          const p = black76.put({
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            volatility: vol,
          });
          expect(c - p).toBeCloseTo(Math.exp(-r * t) * (F - K), 7);
        },
      ),
    );
  });
});

describe('Black-76 Greeks agree with finite differences', () => {
  const base = {
    type: 'call' as const,
    forward: 100,
    strike: 105,
    timeToExpiryYears: 0.75,
    riskFreeRate: 0.04,
    volatility: 0.25,
  };
  const price = (o: typeof base) =>
    black76Price({
      type: o.type,
      forward: o.forward,
      strike: o.strike,
      timeToExpiryYears: o.timeToExpiryYears,
      riskFreeRate: o.riskFreeRate,
      volatility: o.volatility,
    });
  const g = black76.greeks(base);

  it('delta ≈ dP/dF', () => {
    const h = 1e-4;
    const fd =
      (price({ ...base, forward: base.forward + h }) -
        price({ ...base, forward: base.forward - h })) /
      (2 * h);
    expect(g.delta).toBeCloseTo(fd, 6);
  });
  it('gamma ≈ d²P/dF²', () => {
    const h = 1e-2;
    const fd =
      (price({ ...base, forward: base.forward + h }) -
        2 * price(base) +
        price({ ...base, forward: base.forward - h })) /
      (h * h);
    expect(g.gamma).toBeCloseTo(fd, 6);
  });
  it('vega (per 1%) ≈ dP/dσ / 100', () => {
    const h = 1e-5;
    const fd =
      (price({ ...base, volatility: base.volatility + h }) -
        price({ ...base, volatility: base.volatility - h })) /
      (2 * h);
    expect(g.vega).toBeCloseTo(fd / 100, 6);
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

describe('Black-76 implied volatility', () => {
  it('price → IV → price round trip', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 30, max: 200, noNaN: true }),
        fc.double({ min: 30, max: 200, noNaN: true }),
        fc.double({ min: 0.05, max: 2, noNaN: true }),
        fc.double({ min: 0, max: 0.08, noNaN: true }),
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.constantFrom('call' as const, 'put' as const),
        (F, K, t, r, vol, type) => {
          const price = black76Price({
            type,
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            volatility: vol,
          });
          fc.pre(price > 1e-3);
          const impliedVolatility = black76.impliedVolatility({
            price,
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            type,
          });
          const reprice = black76Price({
            type,
            forward: F,
            strike: K,
            timeToExpiryYears: t,
            riskFreeRate: r,
            volatility: impliedVolatility,
          });
          expect(Math.abs(reprice - price) / Math.max(1, price)).toBeLessThan(1e-6);
        },
      ),
    );
  });

  it('throws below intrinsic', () => {
    expect(() =>
      black76.impliedVolatility({
        price: 1e-6,
        forward: 200,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call',
      }),
    ).toThrowError(ArbitrageError);
  });
});

describe('Black-76 extended Greeks agree with finite differences', () => {
  for (const type of ['call', 'put'] as const) {
    it(`${type} higher-order greeks match FD of the first-order greeks`, () => {
      const b = {
        forward: 100,
        strike: 105,
        timeToExpiryYears: 0.75,
        riskFreeRate: 0.04,
        volatility: 0.25,
      };
      const x = black76ExtendedGreeks({
        type,
        forward: b.forward,
        strike: b.strike,
        timeToExpiryYears: b.timeToExpiryYears,
        riskFreeRate: b.riskFreeRate,
        volatility: b.volatility,
      });
      const g = (F = b.forward, sig = b.volatility, T = b.timeToExpiryYears) =>
        black76Greeks({
          type,
          forward: F,
          strike: b.strike,
          timeToExpiryYears: T,
          riskFreeRate: b.riskFreeRate,
          volatility: sig,
        });
      const P = () =>
        black76Price({
          type,
          forward: b.forward,
          strike: b.strike,
          timeToExpiryYears: b.timeToExpiryYears,
          riskFreeRate: b.riskFreeRate,
          volatility: b.volatility,
        });
      const X = (sig: number) =>
        black76ExtendedGreeks({
          type,
          forward: b.forward,
          strike: b.strike,
          timeToExpiryYears: b.timeToExpiryYears,
          riskFreeRate: b.riskFreeRate,
          volatility: sig,
        });
      const hF = b.forward * 1e-5,
        hV = 1e-5,
        timeStepYears = 1e-5;

      expect(x.vanna).toBeCloseTo(
        (g(b.forward, b.volatility + hV).delta - g(b.forward, b.volatility - hV).delta) / (2 * hV),
        5,
      );
      expect(x.vomma).toBeCloseTo(
        ((g(b.forward, b.volatility + hV).vega - g(b.forward, b.volatility - hV).vega) * 100) /
          (2 * hV),
        3,
      );
      expect(x.speed).toBeCloseTo(
        (g(b.forward + hF).gamma - g(b.forward - hF).gamma) / (2 * hF),
        5,
      );
      expect(x.charm).toBeCloseTo(
        (g(b.forward, b.volatility, b.timeToExpiryYears + timeStepYears).delta -
          g(b.forward, b.volatility, b.timeToExpiryYears - timeStepYears).delta) /
          (2 * timeStepYears),
        5,
      );
      expect(x.color).toBeCloseTo(
        (g(b.forward, b.volatility, b.timeToExpiryYears + timeStepYears).gamma -
          g(b.forward, b.volatility, b.timeToExpiryYears - timeStepYears).gamma) /
          (2 * timeStepYears),
        5,
      );
      expect(x.zomma).toBeCloseTo(
        (g(b.forward, b.volatility + hV).gamma - g(b.forward, b.volatility - hV).gamma) / (2 * hV),
        4,
      );
      expect(x.veta).toBeCloseTo(
        ((g(b.forward, b.volatility, b.timeToExpiryYears + timeStepYears).vega -
          g(b.forward, b.volatility, b.timeToExpiryYears - timeStepYears).vega) *
          100) /
          (2 * timeStepYears),
        2,
      );
      expect(x.vera).toBeCloseTo(
        ((g(b.forward, b.volatility + hV).rho - g(b.forward, b.volatility - hV).rho) * 100) /
          (2 * hV),
        4,
      );
      expect(x.ultima).toBeCloseTo(
        (X(b.volatility + hV).vomma - X(b.volatility - hV).vomma) / (2 * hV),
        2,
      );
      // forward model: no dividend yield; elasticity is Δ·F/V.
      expect(x.phi).toBe(0);
      expect(x.lambda).toBeCloseTo((g().delta * b.forward) / P(), 8);
    });
  }
});
