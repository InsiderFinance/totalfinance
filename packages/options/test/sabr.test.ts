import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { black76Price } from '@totalfinance/options/black76';
import {
  type SabrParameters,
  sabrPrice,
  sabrMonteCarloPrice,
  sabrVolatility,
} from '@totalfinance/options/sabr';

describe('Hagan SABR — the expansion domain (2026-08 defect-fix wave)', () => {
  // Hagan's `1 + […]·T` bracket carries (2 − 3ρ²)/24·ν²·T, which is NEGATIVE for ρ² > 2/3. At
  // ρ = −0.99, ν = 1.5, T = 30 that term is −2.6, the bracket goes through zero, and the formula
  // returned a NEGATIVE implied vol — and Black-76 a negative PRICE — under converged: true.
  const outOfDomain: SabrParameters = { alpha: 0.3, beta: 1, rho: -0.99, nu: 1.5 };

  it('a negative-volatility point refuses, naming the ν²T·ρ domain', () => {
    let thrown: { code?: string; message?: string } = {};
    try {
      sabrVolatility({
        input: { forward: 100, strike: 100, timeToExpiryYears: 30 },
        parameters: outOfDomain,
      });
      expect.unreachable('an out-of-domain Hagan point must not return a volatility');
    } catch (error) {
      thrown = error as { code?: string; message?: string };
    }
    expect(thrown.code).toBe('input.out_of_range');
    expect(thrown.message).toMatch(/out of domain/);
    expect(thrown.message).toMatch(/ρ² > 2\/3/);
    expect(thrown.message).toMatch(/ν²·T=67\.5/);
    expect(thrown.message).toMatch(/monteCarloPrice/);
  });

  it('the price path refuses too, instead of returning a negative premium', () => {
    expect(() =>
      sabrPrice({
        type: 'call',
        input: { forward: 100, strike: 100, timeToExpiryYears: 30, riskFreeRate: 0.02 },
        parameters: outOfDomain,
      }),
    ).toThrow(InputError);
    // The normal (Bachelier) expansion carries the same term and is guarded identically.
    expect(() =>
      sabrPrice({
        type: 'put',
        input: { forward: 100, strike: 90, timeToExpiryYears: 30, riskFreeRate: 0.02 },
        parameters: outOfDomain,
        options: { volatilityType: 'normal' },
      }),
    ).toThrow(/out of domain/);
  });

  it('clean cases are bit-identical — the guard never perturbs an in-domain point', () => {
    // Same parameters, a maturity inside the expansion's validity: ν²T = 2.25 rather than 67.5.
    const inDomain = sabrVolatility({
      input: { forward: 100, strike: 100, timeToExpiryYears: 1 },
      parameters: outOfDomain,
    });
    expect(inDomain).toBeGreaterThan(0);
    // The documented degenerate anchors are untouched (β=1, ν=0 ⇒ vol ≡ α, to the last bit).
    expect(
      sabrVolatility({
        input: { forward: 100, strike: 123.4, timeToExpiryYears: 7 },
        parameters: { alpha: 0.25, beta: 1, rho: 0, nu: 0 },
      }),
    ).toBe(0.25);
  });
});

describe('Hagan SABR implied vol — degenerate limits', () => {
  it('β=1, ν=0 ⇒ lognormal vol is exactly α (a flat smile)', () => {
    const p: SabrParameters = { alpha: 0.25, beta: 1, rho: 0, nu: 0 };
    for (const K of [80, 95, 100, 110, 130]) {
      expect(
        sabrVolatility({
          input: { forward: 100, strike: K, timeToExpiryYears: 0.5 },
          parameters: p,
          options: { volatilityType: 'lognormal' },
        }),
      ).toBeCloseTo(0.25, 12);
    }
  });

  it('β=0, ν=0 ⇒ normal vol is exactly α (a flat smile)', () => {
    const p: SabrParameters = { alpha: 1.5, beta: 0, rho: 0, nu: 0 };
    for (const K of [80, 95, 100, 110, 130]) {
      expect(
        sabrVolatility({
          input: { forward: 100, strike: K, timeToExpiryYears: 0.5 },
          parameters: p,
          options: { volatilityType: 'normal' },
        }),
      ).toBeCloseTo(1.5, 10);
    }
  });

  it('is continuous at the money (no 0/0 blow-up)', () => {
    const p: SabrParameters = { alpha: 0.3, beta: 0.7, rho: -0.3, nu: 0.5 };
    const atm = sabrVolatility({
      input: { forward: 100, strike: 100, timeToExpiryYears: 0.5 },
      parameters: p,
    });
    const nearAtm = sabrVolatility({
      input: { forward: 100, strike: 100.0001, timeToExpiryYears: 0.5 },
      parameters: p,
    });
    expect(Number.isFinite(atm)).toBe(true);
    expect(Math.abs(atm - nearAtm)).toBeLessThan(1e-4);
  });
});

describe('Hagan SABR — smile shape', () => {
  it('negative ρ produces a downward (left) skew: put-wing vol > call-wing vol', () => {
    const p: SabrParameters = { alpha: 0.3, beta: 0.9, rho: -0.4, nu: 0.6 };
    const lowK = sabrVolatility({
      input: { forward: 100, strike: 80, timeToExpiryYears: 0.5 },
      parameters: p,
    });
    const atm = sabrVolatility({
      input: { forward: 100, strike: 100, timeToExpiryYears: 0.5 },
      parameters: p,
    });
    const highK = sabrVolatility({
      input: { forward: 100, strike: 120, timeToExpiryYears: 0.5 },
      parameters: p,
    });
    expect(lowK).toBeGreaterThan(atm);
    expect(atm).toBeGreaterThan(highK);
  });

  it('ν controls convexity: more vol-of-vol ⇒ a more pronounced smile', () => {
    const flat: SabrParameters = { alpha: 0.3, beta: 1, rho: 0, nu: 0.1 };
    const curvy: SabrParameters = { alpha: 0.3, beta: 1, rho: 0, nu: 0.8 };
    const wingFlat =
      sabrVolatility({
        input: { forward: 100, strike: 130, timeToExpiryYears: 0.5 },
        parameters: flat,
      }) -
      sabrVolatility({
        input: { forward: 100, strike: 100, timeToExpiryYears: 0.5 },
        parameters: flat,
      });
    const wingCurvy =
      sabrVolatility({
        input: { forward: 100, strike: 130, timeToExpiryYears: 0.5 },
        parameters: curvy,
      }) -
      sabrVolatility({
        input: { forward: 100, strike: 100, timeToExpiryYears: 0.5 },
        parameters: curvy,
      });
    expect(wingCurvy).toBeGreaterThan(wingFlat);
  });
});

describe('sabrPrice', () => {
  it('β=1, ν=0 reproduces Black-76 with vol α exactly', () => {
    const p: SabrParameters = { alpha: 0.25, beta: 1, rho: 0, nu: 0 };
    for (const [type, K] of [
      ['call', 100],
      ['put', 110],
      ['call', 90],
    ] as const) {
      const res = sabrPrice({
        type,
        input: { forward: 100, strike: K, timeToExpiryYears: 0.75, riskFreeRate: 0.03 },
        parameters: p,
      });
      const ref = black76Price({
        type,
        forward: 100,
        strike: K,
        timeToExpiryYears: 0.75,
        riskFreeRate: 0.03,
        volatility: 0.25,
      });
      expect(res.value).toBeCloseTo(ref, 8);
    }
  });

  it('returns sensible Greeks and derives the forward from spot', () => {
    const p: SabrParameters = { alpha: 0.3, beta: 0.8, rho: -0.3, nu: 0.5 };
    const res = sabrPrice({
      type: 'call',
      input: {
        spot: 100,
        strike: 100,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.04,
        dividendYield: 0.01,
      },
      parameters: p,
    });
    expect(res.value).toBeGreaterThan(0);
    expect(res.greeks!.delta).toBeGreaterThan(0);
    expect(res.greeks!.delta).toBeLessThan(1);
    expect(res.greeks!.vega).toBeGreaterThan(0);
  });
});

describe('SABR — Hagan formula cross-validated against SDE Monte-Carlo (short maturity)', () => {
  const p: SabrParameters = { alpha: 0.25, beta: 1, rho: -0.3, nu: 0.4 };
  for (const [K, type] of [
    [100, 'call'],
    [110, 'call'],
    [90, 'put'],
  ] as const) {
    it(`${type} K=${K}: Hagan price agrees with Euler MC of the SDE`, () => {
      const input = { forward: 100, strike: K, timeToExpiryYears: 0.25, riskFreeRate: 0.02 };
      const hagan = sabrPrice({ type, input, parameters: p }).value;
      const monteCarlo = sabrMonteCarloPrice({
        type,
        input,
        parameters: p,
        options: { paths: 40_000, seed: 7, steps: 64 },
      });
      expect(monteCarlo.monteCarlo.standardError).toBeGreaterThan(0);
      expect(Math.abs(hagan - monteCarlo.value)).toBeLessThan(
        4 * monteCarlo.monteCarlo.standardError! + 0.05,
      );
    });
  }
});

describe('SABR — input validation', () => {
  const input = { forward: 100, strike: 100, timeToExpiryYears: 1 };
  it('rejects β outside [0,1], |ρ| ≥ 1, and ν < 0', () => {
    expect(() =>
      sabrPrice({
        type: 'call',
        input,
        parameters: { alpha: 0.3, beta: 1.2, rho: 0, nu: 0.3 },
      }),
    ).toThrow(InputError);
    expect(() =>
      sabrPrice({
        type: 'call',
        input,
        parameters: { alpha: 0.3, beta: 0.5, rho: 1, nu: 0.3 },
      }),
    ).toThrow(InputError);
    expect(() =>
      sabrPrice({
        type: 'call',
        input,
        parameters: { alpha: 0.3, beta: 0.5, rho: 0, nu: -0.1 },
      }),
    ).toThrow(InputError);
  });

  it('rejects an unknown volatilityType instead of silently treating it as lognormal', () => {
    const p: SabrParameters = { alpha: 0.3, beta: 0.5, rho: -0.3, nu: 0.4 };
    expect(() =>
      sabrVolatility({
        input: { forward: 100, strike: 100, timeToExpiryYears: 1 },
        parameters: p,
        // @ts-expect-error — invalid runtime volatilityType must throw at the SABR chokepoint
        options: { volatilityType: 'bogus' },
      }),
    ).toThrow(InputError);
    expect(() =>
      sabrPrice({
        type: 'call',
        input,
        parameters: p,
        // @ts-expect-error — and through the public pricer
        options: { volatilityType: 'bogus' },
      }),
    ).toThrow(InputError);
  });

  it('sabrVolatility rejects a missing alpha instead of returning a silent NaN', () => {
    expect(() =>
      sabrVolatility({
        input: { forward: 100, strike: 100, timeToExpiryYears: 1 },
        // @ts-expect-error — missing alpha must throw a typed error, not evaluate to NaN
        parameters: { beta: 1, rho: 0, nu: 0 },
      }),
    ).toThrow(InputError);
  });

  it('sabrVolatility validates the smile point (forward/strike/t must be positive finite)', () => {
    const p: SabrParameters = { alpha: 0.3, beta: 0.5, rho: -0.3, nu: 0.4 };
    expect(() =>
      sabrVolatility({
        input: { forward: -100, strike: 100, timeToExpiryYears: 1 },
        parameters: p,
      }),
    ).toThrow(InputError);
    expect(() =>
      sabrVolatility({ input: { forward: 100, strike: 0, timeToExpiryYears: 1 }, parameters: p }),
    ).toThrow(InputError);
    expect(() =>
      sabrVolatility({
        input: { forward: 100, strike: 100, timeToExpiryYears: NaN },
        parameters: p,
      }),
    ).toThrow(InputError);
  });

  it('rejects a mistyped option type instead of silently pricing the other leg', () => {
    const p: SabrParameters = { alpha: 0.3, beta: 0.5, rho: -0.3, nu: 0.4 };
    expect(() =>
      sabrPrice({
        // @ts-expect-error — 'Call' must throw, not price the put
        type: 'Call',
        input,
        parameters: p,
      }),
    ).toThrow(InputError);
    expect(() =>
      sabrMonteCarloPrice({
        // @ts-expect-error — same through the Monte-Carlo pricer
        type: 'Call',
        input,
        parameters: p,
        options: { paths: 100, seed: 1 },
      }),
    ).toThrow(InputError);
  });
});
