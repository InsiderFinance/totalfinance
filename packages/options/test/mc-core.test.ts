import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { SOBOL_MAX_DIMENSIONS } from '@totalfinance/math';
import { monteCarloEstimate, type ControlVariate } from '../src/mc/core.js';

// E[e^Z] for Z ~ N(0,1) is e^{1/2} = 1.6487212707...
const TARGET = Math.exp(0.5);

describe('monteCarloEstimate — the shared Monte-Carlo estimator', () => {
  it('estimates a known expectation with a correct confidence interval', () => {
    const est = monteCarloEstimate({
      dimensions: 1,
      payoff: (z) => Math.exp(z[0]!),
      options: { paths: 200_000, seed: 1 },
    });
    expect(est.converged).toBe(true);
    expect(Math.abs(est.value - TARGET)).toBeLessThan(5 * est.standardError!);
    // 95% interval brackets the truth
    expect(est.confidenceInterval![0]).toBeLessThan(TARGET);
    expect(est.confidenceInterval![1]).toBeGreaterThan(TARGET);
  });

  it('a positively-correlated control variate reduces the standard error', () => {
    // control = Z (mean 0); cov(e^Z, Z) > 0
    const control: ControlVariate = { estimate: (z) => z[0]!, mean: 0 };
    const plain = monteCarloEstimate({
      dimensions: 1,
      payoff: (z) => Math.exp(z[0]!),
      options: {
        paths: 50_000,
        seed: 4,
        antithetic: false,
      },
    });
    const cv = monteCarloEstimate({
      dimensions: 1,
      payoff: (z) => Math.exp(z[0]!),
      options: { paths: 50_000, seed: 4, antithetic: false },
      controlVariate: control,
    });
    expect(cv.varianceReduction.controlVariate).toBe(true);
    expect(cv.standardError!).toBeLessThan(plain.standardError!);
    expect(Math.abs(cv.value - TARGET)).toBeLessThan(5 * cv.standardError!);
  });

  it('antithetic sampling is applied by default in pseudo mode', () => {
    const est = monteCarloEstimate({
      dimensions: 1,
      payoff: (z) => Math.exp(z[0]!),
      options: { paths: 10_000, seed: 2 },
    });
    expect(est.varianceReduction.antithetic).toBe(true);
  });

  it('Sobol QMC converges and disables antithetic', () => {
    const est = monteCarloEstimate({
      dimensions: 1,
      payoff: (z) => Math.exp(z[0]!),
      options: { paths: 16384, seed: 1, method: 'sobol' },
    });
    expect(est.method).toBe('sobol');
    expect(est.varianceReduction.antithetic).toBe(false);
    expect(Math.abs(est.value - TARGET)).toBeLessThan(0.01);
  });

  it('keeps using Sobol well past the legacy 13-dimensions table (WS9.5b generated direction numbers)', () => {
    // The direction-number table used to stop at 13 dimensions; WS9.5b generates primitive
    // polynomials up to SOBOL_MAX_DIM, so a 20-dim integrand is now genuine QMC — no silent
    // degradation to pseudo.
    const est = monteCarloEstimate({
      dimensions: 20,
      payoff: (z) => z.reduce((s, x) => s + x * x, 0) / z.length,
      options: {
        paths: 4000,
        seed: 1,
        method: 'sobol',
      },
    });
    expect(est.method).toBe('sobol');
    expect(
      est.warnings.some((w) => w.code === 'monte_carlo.quasi_monte_carlo_dimension_fallback'),
    ).toBe(false);
  });

  it('falls back to pseudo with a reported warning when QMC dimension exceeds the sequence limit', () => {
    const est = monteCarloEstimate({
      dimensions: SOBOL_MAX_DIMENSIONS + 1,
      payoff: (z) => z.reduce((s, x) => s + x * x, 0) / z.length,
      options: {
        paths: 256,
        seed: 1,
        method: 'sobol',
      },
    });
    expect(est.method).toBe('pseudo'); // beyond the generated Sobol dimension limit
    expect(
      est.warnings.some((w) => w.code === 'monte_carlo.quasi_monte_carlo_dimension_fallback'),
    ).toBe(true);
  });

  it('Brownian-bridge re-ordering is recorded for QMC path sampling', () => {
    const est = monteCarloEstimate({
      dimensions: 8,
      payoff: (z) => z.reduce((s, x) => s + x, 0),
      options: {
        paths: 2000,
        seed: 1,
        method: 'sobol',
        brownianBridge: true,
      },
    });
    expect(est.varianceReduction.brownianBridge).toBe(true);
  });

  it('a quasi-random estimate reports NO standard error (an iid formula does not apply)', () => {
    // √(s²/n) assumes independent draws. Sobol points are deterministic and negatively correlated,
    // so that formula overstated the true deviation by ~75× — a "confidence interval" that was
    // neither. It is reported as null, with the reason, rather than as a plausible number.
    for (const method of ['sobol', 'halton'] as const) {
      const est = monteCarloEstimate({
        dimensions: 1,
        payoff: (z) => Math.exp(z[0]!),
        options: { paths: 16384, seed: 1, method },
      });
      expect(est.method).toBe(method);
      expect(est.standardError, method).toBeNull();
      expect(est.confidenceInterval, method).toBeNull();
      expect(est.converged, method).toBe(true); // a null error is not a failure
      const note = est.warnings.find((w) => w.code === 'model.limitation');
      expect(note, `${method} must say why`).toBeDefined();
      expect(note!.message).toMatch(/quasi-random/);
      expect(note!.message).toMatch(/randomized/i);
      // The estimate itself is still accurate — this is about the ERROR BAR, not the value.
      expect(Math.abs(est.value - TARGET)).toBeLessThan(0.01);
    }
  });

  it('pseudo-random sampling is unchanged: a real standard error and a real interval', () => {
    const est = monteCarloEstimate({
      dimensions: 1,
      payoff: (z) => Math.exp(z[0]!),
      options: { paths: 20_000, seed: 3 },
    });
    expect(est.method).toBe('pseudo');
    expect(est.standardError).toBeGreaterThan(0);
    expect(est.confidenceInterval![0]).toBeLessThan(est.value);
    expect(est.confidenceInterval![1]).toBeGreaterThan(est.value);
    expect(est.warnings.some((w) => w.code === 'model.limitation')).toBe(false);
  });

  it('throws on a non-finite payoff rather than returning a successful-looking estimate', () => {
    expect(() =>
      monteCarloEstimate({ dimensions: 1, payoff: () => NaN, options: { paths: 100, seed: 1 } }),
    ).toThrow();
  });

  it('rejects an unknown sampling method or randomNumberGenerator instead of silently defaulting', () => {
    expect(() =>
      monteCarloEstimate({
        dimensions: 1,
        payoff: (z) => z[0]!,
        // @ts-expect-error — unknown methods must not fall through to a bogus converged result
        options: { paths: 100, seed: 1, method: 'bogus' },
      }),
    ).toThrow(InputError);
    expect(() =>
      monteCarloEstimate({
        dimensions: 1,
        payoff: (z) => z[0]!,
        // @ts-expect-error — exercising the runtime guard with an invalid RNG
        options: { paths: 100, seed: 1, randomNumberGenerator: 'pcg' },
      }),
    ).toThrow(InputError);
  });
});
