/**
 * Stage 4.5 slice 2 — warm starts on the direct calibrators (Decision 8):
 *
 * - every warm-startable calibrator accepts a closed `initialParameters` in its FREE start members,
 *   echoes `assumptions.initialParameters`, and refuses members the search cannot honor;
 * - a warm start changes where the search begins, never the objective: from the truth it lands on
 *   the truth, and SVI (which keeps its built-in starts) is never worse than a cold fit;
 * - the Heston `seed` and surface `hestonSeed` spellings are retired: the old keys are refused with
 *   the did-you-mean teaching, never silently ignored (naming law N9/N10).
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { mulberry32, normalInverseCdf } from '@totalfinance/math';
import { hestonImpliedVolatility } from '@totalfinance/options/heston';
import { sabrVolatility } from '@totalfinance/options/sabr';
import {
  calibrateEssvi,
  calibrateHestonSurface,
  calibrateSabrSmile,
  calibrateSsvi,
  calibrateSvi,
  fitGarch,
  volatilitySurface,
  type SSVICalibrationInput,
} from '@totalfinance/volatility';
import { sviTotalVariance, type SVIParameters } from '@totalfinance/volatility/svi';
import {
  optionExpiryToMs,
  resolvedExpiry,
  yearFraction,
  type OptionQuote,
} from '@totalfinance/core';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return isQuantError(error) ? error.code : `not a QuantError: ${String(error)}`;
  }
}

// ── SVI ─────────────────────────────────────────────────────────────────────────────────────────
const SVI_TRUE: SVIParameters = { a: 0.04, b: 0.4, rho: -0.4, m: 0.05, sigma: 0.15 };
const KS = [-0.5, -0.35, -0.2, -0.1, -0.03, 0, 0.05, 0.12, 0.22, 0.35, 0.5];
const W = KS.map((k) => sviTotalVariance(SVI_TRUE, k));

describe('calibrateSvi — initialParameters', () => {
  it('echoes the start and is never worse than a cold fit on the same objective', () => {
    const cold = calibrateSvi({ k: KS, w: W });
    const warm = calibrateSvi({ k: KS, w: W }, { initialParameters: { m: 0.05, sigma: 0.15 } });
    expect(cold.assumptions.initialParameters).toBe('default');
    expect(warm.assumptions.initialParameters).toBe('supplied');
    expect(warm.rmse).toBeLessThanOrEqual(cold.rmse + 1e-12);
    expect(warm.parameters.m).toBeCloseTo(SVI_TRUE.m, 4);
    expect(warm.parameters.sigma).toBeCloseTo(SVI_TRUE.sigma, 4);
  });

  it('refuses members the search cannot honor, and malformed starts', () => {
    expect(
      codeOf(() =>
        calibrateSvi({ k: KS, w: W }, {
          initialParameters: { m: 0, sigma: 0.1, a: 0.04 },
        } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() => calibrateSvi({ k: KS, w: W }, { initialParameters: { m: 0, sigma: 0 } })),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        calibrateSvi({ k: KS, w: W }, { initialParameters: { m: Number.NaN, sigma: 0.1 } }),
      ),
    ).toBe(ErrorCode.InputNaN);
    expect(
      codeOf(() => calibrateSvi({ k: KS, w: W }, { initialParameters: { sigma: 0.1 } } as never)),
    ).toBe(ErrorCode.InputMissingField);
  });
});

// ── SSVI / eSSVI ────────────────────────────────────────────────────────────────────────────────
function ssviW(k: number, theta: number, rho: number, psi: number): number {
  return (theta / 2) * (1 + rho * psi * k + Math.sqrt((psi * k + rho) ** 2 + (1 - rho * rho)));
}
const SKS = [-0.5, -0.3, -0.15, -0.05, 0, 0.05, 0.15, 0.3, 0.5];
function syntheticSurface(rho: number, eta: number, gamma: number): SSVICalibrationInput {
  const mats = [0.05, 0.15, 0.35, 0.7, 1.5];
  const atm = [0.32, 0.29, 0.27, 0.255, 0.24];
  return {
    slices: mats.map((t, i) => {
      const theta = atm[i]! * atm[i]! * t;
      const psi = eta * Math.pow(theta, -gamma);
      return {
        timeToExpiryYears: t,
        k: SKS,
        impliedVolatility: SKS.map((k) => Math.sqrt(ssviW(k, theta, rho, psi) / t)),
      };
    }),
  };
}
const SURFACE = syntheticSurface(-0.3, 1.2, 0.4);

describe('calibrateSsvi — initialParameters', () => {
  it('starts from the supplied (ρ, φ), echoes it, and lands on the truth', () => {
    const cold = calibrateSsvi(SURFACE);
    const warm = calibrateSsvi(SURFACE, {
      initialParameters: { rho: -0.3, phi: { kind: 'power-law', eta: 1.2, gamma: 0.4 } },
    });
    expect(cold.assumptions.initialParameters).toBe('default');
    expect(warm.assumptions.initialParameters).toBe('supplied');
    expect(warm.parameters.rho).toBeCloseTo(-0.3, 3);
    expect(warm.rmse).toBeLessThan(1e-5);
  });

  it('refuses a start in the other φ family and out-of-domain members', () => {
    expect(
      codeOf(() =>
        calibrateSsvi(SURFACE, {
          initialParameters: { rho: -0.3, phi: { kind: 'heston', lambda: 1 } },
        }),
      ),
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        calibrateSsvi(SURFACE, {
          initialParameters: { rho: 1.5, phi: { kind: 'power-law', eta: 1, gamma: 0.4 } },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        calibrateSsvi(SURFACE, {
          initialParameters: { rho: -0.3, phi: { kind: 'power-law', eta: 1, gamma: 1.5 } },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        calibrateSsvi(SURFACE, {
          phi: 'heston',
          initialParameters: { rho: -0.3, phi: { kind: 'heston', lambda: 0 } },
        }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
  });
});

describe('calibrateEssvi — initialParameters replaces the internal SSVI warm start', () => {
  it('broadcasts a scalar ρ, accepts one ρ per knot, and echoes which start ran', () => {
    const cold = calibrateEssvi(SURFACE);
    expect(cold.assumptions.initialParameters).toBe('ssvi-warm-start');
    expect(cold.diagnostics.method).toMatch(/^ssvi-warm-start/);
    const scalar = calibrateEssvi(SURFACE, {
      initialParameters: { rho: -0.3, phi: { kind: 'power-law', eta: 1.2, gamma: 0.4 } },
    });
    expect(scalar.assumptions.initialParameters).toBe('supplied');
    expect(scalar.diagnostics.method).toMatch(/^supplied-start/);
    expect(scalar.rmse).toBeLessThan(1e-4);
    const perKnot = calibrateEssvi(SURFACE, {
      initialParameters: {
        rho: [-0.3, -0.3, -0.3, -0.3, -0.3],
        phi: { kind: 'power-law', eta: 1.2, gamma: 0.4 },
      },
    });
    expect(perKnot.rmse).toBeLessThan(1e-4);
  });

  it('refuses a ρ vector whose length is not the knot count', () => {
    expect(
      codeOf(() =>
        calibrateEssvi(SURFACE, {
          initialParameters: {
            rho: [-0.3, -0.2],
            phi: { kind: 'power-law', eta: 1.2, gamma: 0.4 },
          },
        }),
      ),
    ).toBe(ErrorCode.InputLengthMismatch);
  });
});

// ── SABR ────────────────────────────────────────────────────────────────────────────────────────
describe('calibrateSabrSmile — initialParameters', () => {
  const F = 100;
  const T = 0.5;
  const STRIKES = [80, 88, 94, 98, 100, 103, 108, 115, 125];
  const truth = { alpha: 2.0, beta: 0.5, rho: -0.3, nu: 0.4 };
  const impliedVolatilities = STRIKES.map((K) =>
    sabrVolatility({ input: { forward: F, strike: K, timeToExpiryYears: T }, parameters: truth }),
  );
  const smile = { forward: F, strikes: STRIKES, impliedVolatilities, timeToExpiryYears: T };

  it('starts from the supplied (α, ρ, ν), echoes it, and recovers the truth', () => {
    const cold = calibrateSabrSmile(smile, { beta: 0.5 });
    const warm = calibrateSabrSmile(smile, {
      beta: 0.5,
      initialParameters: { alpha: 2, rho: -0.3, nu: 0.4 },
    });
    expect(cold.assumptions.initialParameters).toBe('default');
    expect(warm.assumptions.initialParameters).toBe('supplied');
    expect(warm.converged).toBe(true);
    expect(warm.parameters.alpha).toBeCloseTo(2, 3);
    expect(warm.parameters.nu).toBeCloseTo(0.4, 3);
    expect(warm.iterations).toBeLessThanOrEqual(cold.iterations);
  });

  it('refuses β as a start member and out-of-domain values', () => {
    expect(
      codeOf(() =>
        calibrateSabrSmile(smile, {
          initialParameters: { alpha: 2, rho: -0.3, nu: 0.4, beta: 0.5 },
        } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() =>
        calibrateSabrSmile(smile, { initialParameters: { alpha: -1, rho: -0.3, nu: 0.4 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      codeOf(() =>
        calibrateSabrSmile(smile, { initialParameters: { alpha: 2, rho: -1, nu: 0.4 } }),
      ),
    ).toBe(ErrorCode.InputOutOfRange);
  });
});

// ── Heston (the rename) ─────────────────────────────────────────────────────────────────────────
describe('calibrateHestonSurface — initialParameters (formerly seed)', () => {
  const market = { spot: 100, riskFreeRate: 0.03, dividendYield: 0 };
  const trueParameters = { v0: 0.04, kappa: 1.5, theta: 0.05, sigma: 0.4, rho: -0.6 };
  const targets = [0.25, 0.5, 1].flatMap((t) =>
    [85, 95, 100, 105, 115].map((strike) => ({
      strike,
      timeToExpiryYears: t,
      forward: 100 * Math.exp(0.03 * t),
      impliedVolatility: hestonImpliedVolatility({
        type: 'call',
        input: { spot: 100, strike, timeToExpiryYears: t, riskFreeRate: 0.03, dividendYield: 0 },
        parameters: trueParameters,
        options: { terms: 128, greeks: false },
      }).value,
    })),
  );

  it('accepts a partial pin, echoes it, and refuses the retired `seed` key with the teaching', () => {
    const warm = calibrateHestonSurface({
      targets,
      market,
      options: { initialParameters: trueParameters, terms: 128, maximumIterations: 40 },
    });
    expect(warm.assumptions.initialParameters).toBe('supplied');
    expect(warm.rmse).toBeLessThan(0.02);
    const partial = calibrateHestonSurface({
      targets,
      market,
      options: { initialParameters: { kappa: 1.5 }, terms: 64, maximumIterations: 5 },
    });
    expect(partial.assumptions.initialParameters).toBe('supplied');
    const cold = calibrateHestonSurface({
      targets,
      market,
      options: { terms: 64, maximumIterations: 5 },
    });
    expect(cold.assumptions.initialParameters).toBe('default');
    let message = '';
    try {
      calibrateHestonSurface({
        targets,
        market,
        options: { ['se' + 'ed']: trueParameters },
      } as never);
    } catch (error) {
      expect(isQuantError(error, ErrorCode.InputUnknownField)).toBe(true);
      message = (error as Error).message;
    }
    expect(message).toMatch(/initialParameters/);
  });
});

// ── volatilitySurface (the config rename) ───────────────────────────────────────────────────────
describe('volatilitySurface — hestonInitialParameters (formerly hestonSeed)', () => {
  const asOf = Date.UTC(2026, 0, 1);
  const spot = 100;
  const rate = 0.03;
  const expiries = ['2026-04-02', '2026-07-02'];
  const trueParameters = { v0: 0.04, kappa: 1.5, theta: 0.045, sigma: 0.3, rho: -0.6 };
  const quotes: OptionQuote[] = expiries.flatMap((expiry) => {
    const t = yearFraction(asOf, optionExpiryToMs(expiry), 'ACT/365F');
    return [90, 95, 100, 105, 110].map((strike) => ({
      contract: {
        underlying: 'X',
        type: 'call' as const,
        style: 'european' as const,
        strike,
        expiry,
        ...resolvedExpiry(expiry),
      },
      timestampMs: asOf,
      impliedVolatility: hestonImpliedVolatility({
        type: 'call',
        input: { spot, strike, timeToExpiryYears: t, riskFreeRate: rate, dividendYield: 0 },
        parameters: trueParameters,
        options: { terms: 128, greeks: false },
      }).value,
      underlyingPrice: spot,
    }));
  });

  it('threads the warm start and refuses the retired config key by name', () => {
    const surface = volatilitySurface({
      quotes,
      market: { spot, riskFreeRate: rate, asOf },
      config: {
        model: 'heston',
        hestonInitialParameters: trueParameters,
        cosineExpansionTerms: 64,
      },
    });
    expect(surface.model).toBe('heston');
    let message = '';
    try {
      volatilitySurface({
        quotes,
        market: { spot, riskFreeRate: rate, asOf },
        config: { model: 'heston', ['heston' + 'Seed']: trueParameters },
      } as never);
    } catch (error) {
      expect(isQuantError(error, ErrorCode.InputUnknownField)).toBe(true);
      message = (error as Error).message;
    }
    expect(message).toMatch(/hestonInitialParameters/);
  });
});

// ── GARCH ───────────────────────────────────────────────────────────────────────────────────────
describe('fitGarch — initialParameters', () => {
  function simulate(
    count: number,
    omega: number,
    alpha: number,
    beta: number,
    seed: number,
  ): number[] {
    const randomNumberGenerator = mulberry32(seed);
    let h = omega / (1 - alpha - beta);
    const out: number[] = [];
    let previous = 0;
    for (let t = 0; t < count + 500; t++) {
      h = omega + alpha * previous * previous + beta * h;
      const z = normalInverseCdf(randomNumberGenerator.next());
      previous = Math.sqrt(h) * z;
      if (t >= 500) out.push(previous);
    }
    return out;
  }
  const returns = simulate(1500, 2e-6, 0.08, 0.9, 7);

  it('replaces the primary start, keeps the seeded restarts, and echoes the start kind', () => {
    const cold = fitGarch(returns);
    const warm = fitGarch(returns, { initialParameters: { alpha: 0.08, beta: 0.9 } });
    expect(cold.assumptions.initialParameters).toBe('default');
    expect(warm.assumptions.initialParameters).toBe('supplied');
    expect(warm.converged).toBe(true);
    expect(Math.abs(warm.persistence - cold.persistence)).toBeLessThan(0.05);
    // The seed keeps its randomness meaning and still replays byte-for-byte.
    const replay = fitGarch(returns, { initialParameters: { alpha: 0.08, beta: 0.9 } });
    expect(replay).toEqual(warm);
  });

  it('refuses ω as a start member and a non-stationary start', () => {
    expect(
      codeOf(() =>
        fitGarch(returns, { initialParameters: { alpha: 0.08, beta: 0.9, omega: 1e-6 } } as never),
      ),
    ).toBe(ErrorCode.InputUnknownField);
    expect(codeOf(() => fitGarch(returns, { initialParameters: { alpha: 0.2, beta: 0.85 } }))).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(codeOf(() => fitGarch(returns, { initialParameters: { alpha: -0.1, beta: 0.9 } }))).toBe(
      ErrorCode.InputOutOfRange,
    );
  });
});
