import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { type SabrParameters } from '@totalfinance/options';
import { sabrVolatility } from '@totalfinance/options/sabr';
import { calibrateSabrSmile } from '@totalfinance/volatility/sabr';

const F = 100;
const T = 0.5;
const STRIKES = [80, 88, 94, 98, 100, 103, 108, 115, 125];

function smile(p: SabrParameters): number[] {
  return STRIKES.map((K) =>
    sabrVolatility({ input: { forward: F, strike: K, timeToExpiryYears: T }, parameters: p }),
  );
}

describe('calibrateSabrSmile — recovers SABR parameters from a generated smile', () => {
  it('β=0.5: recovers (α, ρ, ν) to tight tolerance', () => {
    const truth: SabrParameters = { alpha: 2.0, beta: 0.5, rho: -0.3, nu: 0.4 };
    const impliedVolatilities = smile(truth);
    const fit = calibrateSabrSmile(
      { forward: F, strikes: STRIKES, impliedVolatilities, timeToExpiryYears: T },
      { beta: 0.5 },
    );
    expect(fit.converged).toBe(true);
    expect(fit.rmse).toBeLessThan(1e-5);
    expect(fit.parameters.alpha).toBeCloseTo(truth.alpha, 3);
    expect(fit.parameters.rho).toBeCloseTo(truth.rho, 3);
    expect(fit.parameters.nu).toBeCloseTo(truth.nu, 3);
    expect(fit.parameters.beta).toBe(0.5);
  });

  it('β=1 (equity backbone): the fitted smile reprices the inputs', () => {
    const truth: SabrParameters = { alpha: 0.25, beta: 1, rho: -0.5, nu: 0.6 };
    const impliedVolatilities = smile(truth);
    const fit = calibrateSabrSmile(
      { forward: F, strikes: STRIKES, impliedVolatilities, timeToExpiryYears: T },
      { beta: 1 },
    );
    expect(fit.rmse).toBeLessThan(1e-5);
    for (let i = 0; i < STRIKES.length; i++) {
      expect(
        sabrVolatility({
          input: { forward: F, strike: STRIKES[i]!, timeToExpiryYears: T },
          parameters: fit.parameters,
        }),
      ).toBeCloseTo(impliedVolatilities[i]!, 5);
    }
  });

  it('fits a noisy smile with a small RMSE and a sensible (negative) skew', () => {
    const truth: SabrParameters = { alpha: 1.8, beta: 0.5, rho: -0.4, nu: 0.5 };
    const impliedVolatilities = smile(truth).map((v, i) => v * (1 + 0.005 * Math.cos(i * 1.7)));
    const fit = calibrateSabrSmile(
      { forward: F, strikes: STRIKES, impliedVolatilities, timeToExpiryYears: T },
      { beta: 0.5 },
    );
    expect(fit.rmse).toBeGreaterThan(0);
    expect(fit.rmse).toBeLessThan(5e-3);
    expect(fit.parameters.rho).toBeLessThan(0);
  });

  it('validates inputs', () => {
    expect(() =>
      calibrateSabrSmile({
        forward: F,
        strikes: [100, 105],
        impliedVolatilities: [0.2, 0.21],
        timeToExpiryYears: T,
      }),
    ).toThrow(InputError); // < 3 strikes
    expect(() =>
      calibrateSabrSmile(
        {
          forward: F,
          strikes: STRIKES,
          impliedVolatilities: smile({ alpha: 2, beta: 0.5, rho: -0.3, nu: 0.4 }),
          timeToExpiryYears: T,
        },
        {
          beta: 1.5,
        },
      ),
    ).toThrow(InputError);
  });

  it('rejects an unknown volatilityType instead of silently treating it as lognormal', () => {
    const impliedVolatilities = smile({ alpha: 2, beta: 0.5, rho: -0.3, nu: 0.4 });
    expect(() =>
      calibrateSabrSmile(
        { forward: F, strikes: STRIKES, impliedVolatilities, timeToExpiryYears: T },
        { beta: 0.5, volatilityType: 'bogus' as never },
      ),
    ).toThrow(InputError);
  });

  // Review finding: `strikes.length` was read straight after the object guard, so a natural wrong
  // key (`volatilities` instead of `impliedVolatilities`, or a missing `strikes`) crashed on a raw TypeError. The wrong
  // key now trips the Law 12 unknown-key guard, which names the real slots (`impliedVolatilities` among them).
  it('teaches the real slot names when strikes/impliedVolatilities are missing or not arrays', () => {
    const impliedVolatilities = smile({ alpha: 2, beta: 0.5, rho: -0.3, nu: 0.4 });
    expect(() =>
      calibrateSabrSmile({
        forward: F,
        strikes: STRIKES,
        volatilities: impliedVolatilities,
        timeToExpiryYears: T,
      } as never),
    ).toThrow(/unknown field "volatilities".*impliedVolatilities/);
    expect(
      () => calibrateSabrSmile({ forward: F, impliedVolatilities, timeToExpiryYears: T } as never),
      // Absent is MISSING (four-code matrix); the old array guard pinned wrong-type-for-absence.
    ).toThrow(/strikes is required/);
    expect(() =>
      calibrateSabrSmile({
        forward: F,
        strikes: 100 as never,
        impliedVolatilities,
        timeToExpiryYears: T,
      }),
    ).toThrow(InputError);
    expect(() => calibrateSabrSmile(undefined as never)).toThrow(InputError);
  });
});
