/**
 * Composite (compo) options (`compo`). The price is exactly BSM on the composite `A₀ = S_f·X` with the
 * combined vol `σ_A`; put-call parity holds on the composite; the eight multi-factor greeks match a
 * central finite-difference of the closed form (and the compo is long correlation); the two-factor
 * Monte-Carlo converges to the analytic and is invariant to the (nuisance) foreign rate; and the guards
 * hold — including the degenerate zero-composite-vol case.
 */

import { describe, expect, it } from 'vitest';
import { compo, type OptionType } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { DEFAULT_GREEK_UNITS } from '@totalfinance/core';

const I = {
  spot: 100,
  fxSpot: 1.2,
  strike: 125,
  timeToExpiryYears: 0.5,
  domesticRate: 0.04,
  volatility: 0.2,
  fxVolatility: 0.1,
  correlation: 0.3,
  dividendYield: 0.01,
} as const;
const A0 = I.spot * I.fxSpot;
const sigA = Math.sqrt(
  I.volatility ** 2 + I.fxVolatility ** 2 + 2 * I.correlation * I.volatility * I.fxVolatility,
);
/** Closed-form compo price with the given factors, for finite-difference greeks. */
const px = (
  type: OptionType,
  s: number,
  x: number,
  timeToExpiryYears: number,
  r: number,
  vs: number,
  vx: number,
  rr: number,
): number =>
  blackScholesPrice({
    type,
    spot: s * x,
    strike: I.strike,
    timeToExpiryYears,
    riskFreeRate: r,
    dividendYield: I.dividendYield,
    volatility: Math.sqrt(vs * vs + vx * vx + 2 * rr * vs * vx),
  });

describe('compo', () => {
  it('prices exactly as BSM on the composite spot with the combined volatility', () => {
    for (const type of ['call', 'put'] as const) {
      expect(compo.price({ ...I, type }).value).toBeCloseTo(
        blackScholesPrice({
          type,
          spot: A0,
          strike: I.strike,
          timeToExpiryYears: I.timeToExpiryYears,
          riskFreeRate: I.domesticRate,
          dividendYield: I.dividendYield,
          volatility: sigA,
        }),
        12,
      );
    }
    // Put-call parity on the composite: C − P = A₀·e^{−qT} − K·e^{−rT}.
    const c = compo.price({ ...I, type: 'call' }).value;
    const p = compo.price({ ...I, type: 'put' }).value;
    expect(c - p).toBeCloseTo(
      A0 * Math.exp(-I.dividendYield * I.timeToExpiryYears) -
        I.strike * Math.exp(-I.domesticRate * I.timeToExpiryYears),
      10,
    );
  });

  it('reports the multi-factor greeks, each matching a central finite-difference', () => {
    const g = compo.greeks({ ...I, type: 'call' });
    const spotStep = I.spot * 1e-4;
    const hX = I.fxSpot * 1e-4;
    const P = (s: number, x: number, t: number, r: number, vs: number, vx: number, rr: number) =>
      px('call', s, x, t, r, vs, vx, rr);
    const fd = {
      assetDelta:
        (P(
          I.spot + spotStep,
          I.fxSpot,
          I.timeToExpiryYears,
          I.domesticRate,
          I.volatility,
          I.fxVolatility,
          I.correlation,
        ) -
          P(
            I.spot - spotStep,
            I.fxSpot,
            I.timeToExpiryYears,
            I.domesticRate,
            I.volatility,
            I.fxVolatility,
            I.correlation,
          )) /
        (2 * spotStep),
      fxDelta:
        (P(
          I.spot,
          I.fxSpot + hX,
          I.timeToExpiryYears,
          I.domesticRate,
          I.volatility,
          I.fxVolatility,
          I.correlation,
        ) -
          P(
            I.spot,
            I.fxSpot - hX,
            I.timeToExpiryYears,
            I.domesticRate,
            I.volatility,
            I.fxVolatility,
            I.correlation,
          )) /
        (2 * hX),
      assetGamma:
        (P(
          I.spot + spotStep,
          I.fxSpot,
          I.timeToExpiryYears,
          I.domesticRate,
          I.volatility,
          I.fxVolatility,
          I.correlation,
        ) -
          2 *
            P(
              I.spot,
              I.fxSpot,
              I.timeToExpiryYears,
              I.domesticRate,
              I.volatility,
              I.fxVolatility,
              I.correlation,
            ) +
          P(
            I.spot - spotStep,
            I.fxSpot,
            I.timeToExpiryYears,
            I.domesticRate,
            I.volatility,
            I.fxVolatility,
            I.correlation,
          )) /
        (spotStep * spotStep),
      assetVega:
        (P(
          I.spot,
          I.fxSpot,
          I.timeToExpiryYears,
          I.domesticRate,
          I.volatility + 1e-4,
          I.fxVolatility,
          I.correlation,
        ) -
          P(
            I.spot,
            I.fxSpot,
            I.timeToExpiryYears,
            I.domesticRate,
            I.volatility - 1e-4,
            I.fxVolatility,
            I.correlation,
          )) /
        2e-4 /
        100,
      fxVega:
        (P(
          I.spot,
          I.fxSpot,
          I.timeToExpiryYears,
          I.domesticRate,
          I.volatility,
          I.fxVolatility + 1e-4,
          I.correlation,
        ) -
          P(
            I.spot,
            I.fxSpot,
            I.timeToExpiryYears,
            I.domesticRate,
            I.volatility,
            I.fxVolatility - 1e-4,
            I.correlation,
          )) /
        2e-4 /
        100,
      correlationVega:
        (P(
          I.spot,
          I.fxSpot,
          I.timeToExpiryYears,
          I.domesticRate,
          I.volatility,
          I.fxVolatility,
          I.correlation + 1e-4,
        ) -
          P(
            I.spot,
            I.fxSpot,
            I.timeToExpiryYears,
            I.domesticRate,
            I.volatility,
            I.fxVolatility,
            I.correlation - 1e-4,
          )) /
        2e-4 /
        100,
      theta:
        -(
          P(
            I.spot,
            I.fxSpot,
            I.timeToExpiryYears + 1e-4,
            I.domesticRate,
            I.volatility,
            I.fxVolatility,
            I.correlation,
          ) -
          P(
            I.spot,
            I.fxSpot,
            I.timeToExpiryYears - 1e-4,
            I.domesticRate,
            I.volatility,
            I.fxVolatility,
            I.correlation,
          )
        ) /
        2e-4 /
        365,
      rho:
        (P(
          I.spot,
          I.fxSpot,
          I.timeToExpiryYears,
          I.domesticRate + 1e-5,
          I.volatility,
          I.fxVolatility,
          I.correlation,
        ) -
          P(
            I.spot,
            I.fxSpot,
            I.timeToExpiryYears,
            I.domesticRate - 1e-5,
            I.volatility,
            I.fxVolatility,
            I.correlation,
          )) /
        2e-5 /
        100,
    };
    for (const k of Object.keys(fd) as (keyof typeof fd)[]) {
      expect(g.value[k]).toBeCloseTo(fd[k], 4);
    }
    expect(g.value.correlationVega).toBeGreaterThan(0); // a compo is long correlation
    expect(g.assumptions.units).toEqual(DEFAULT_GREEK_UNITS);
  });

  it('is long correlation: a higher ρ raises the call value', () => {
    const low = compo.price({ type: 'call', ...I, correlation: -0.5 }).value;
    const high = compo.price({ type: 'call', ...I, correlation: 0.8 }).value;
    expect(high).toBeGreaterThan(low);
  });

  it('the two-factor Monte-Carlo converges to the analytic and is invariant to the foreign rate', () => {
    const analytic = compo.price({ ...I, type: 'call' }).value;
    const a = compo.monteCarloPrice(
      { ...I, type: 'call' },
      { paths: 400_000, seed: 5, foreignRate: 0.01 },
    );
    const b = compo.monteCarloPrice(
      { ...I, type: 'call' },
      { paths: 400_000, seed: 5, foreignRate: 0.09 },
    );
    expect(Math.abs(a.value - analytic)).toBeLessThan(5 * a.monteCarlo.standardError!);
    expect(a.value).toBeCloseTo(b.value, 9); // the price does not depend on r_f
  });

  it('defaults the dividend yield to 0 and the MC foreign rate to the domestic rate (put path)', () => {
    const { dividendYield: _omit, ...noDiv } = I;
    expect(compo.price({ ...noDiv, type: 'call' }).value).toBeCloseTo(
      blackScholesPrice({
        type: 'call',
        spot: A0,
        strike: I.strike,
        timeToExpiryYears: I.timeToExpiryYears,
        riskFreeRate: I.domesticRate,
        dividendYield: 0,
        volatility: sigA,
      }),
      12,
    );
    // Put MC with no foreignRate (defaults to domesticRate) converges to the put analytic.
    const analyticPut = compo.price({ ...I, type: 'put' }).value;
    const monteCarlo = compo.monteCarloPrice({ ...I, type: 'put' }, { paths: 400_000, seed: 8 });
    expect(Math.abs(monteCarlo.value - analyticPut)).toBeLessThan(
      5 * monteCarlo.monteCarlo.standardError!,
    );
  });

  it('guards a bad type, non-positive inputs, a bad correlation, and a degenerate composite vol', () => {
    expect(() => compo.price(undefined as never)).toThrowError();
    expect(() => compo.price({ ...I, type: 'nope' } as never)).toThrowError();
    expect(() => compo.price({ type: 'call', ...I, fxSpot: -1 })).toThrowError();
    expect(() => compo.price({ type: 'call', ...I, spot: 0 })).toThrowError();
    expect(() => compo.price({ type: 'call', ...I, fxVolatility: -0.1 })).toThrowError();
    expect(() => compo.price({ type: 'call', ...I, correlation: 1.5 })).toThrowError();
    // ρ = −1 with equal volatilities ⇒ the composite is riskless (σ_A = 0) ⇒ typed error, not a NaN.
    expect(() =>
      compo.price({ type: 'call', ...I, volatility: 0.1, fxVolatility: 0.1, correlation: -1 }),
    ).toThrowError();
    expect(() =>
      compo.greeks({ type: 'call', ...I, volatility: 0.1, fxVolatility: 0.1, correlation: -1 }),
    ).toThrowError();
    expect(() => compo.monteCarloPrice({ ...I, type: 'call' }, undefined as never)).toThrowError();
  });
});
