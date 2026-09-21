/**
 * WS9.2 — variance forecasting (GARCH(1,1) + HAR-RV).
 *
 * Honesty note: we cannot run Python's `arch`, so the goldens are property / consistency based rather
 * than reference-number based:
 *   - GARCH: a returns series is generated DETERMINISTICALLY from a known GARCH(1,1) process with the
 *     seeded PRNG (`mulberry32` + `normalInverseCdf`); the fit must recover (ω,α,β) into a loose neighbourhood
 *     of the truth (MLE on finite samples is noisy). Forecast mean-reversion is an exact algebraic
 *     property. A degenerate series must report `converged: false`.
 *   - HAR-RV: an EXACT linear golden (`RVₜ = 0.1 + 0.3d + 0.3w + 0.3m`) recovers the coefficients to
 *     ~1e-6 with r² ≈ 1; a noisy variant lands r² strictly inside (0, 1).
 */

import { describe, expect, it } from 'vitest';
import { InputError, isQuantError } from '@totalfinance/core';
import { mulberry32, normalInverseCdf } from '@totalfinance/math';
import {
  type GarchFit,
  fitGarch,
  garchForecast,
  fitHarRv,
  harRvForecast,
} from '@totalfinance/volatility';

// ───────────────────────── deterministic GARCH(1,1) data generator ─────────────────────────

/** Simulate a GARCH(1,1) returns series with the seeded PRNG. Uses a burn-in to reach stationarity. */
function simulateGarch(
  count: number,
  omega: number,
  alpha: number,
  beta: number,
  seed: number,
): number[] {
  const randomNumberGenerator = mulberry32(seed);
  const lrv = omega / (1 - alpha - beta);
  let h = lrv;
  const burn = 1000;
  const out: number[] = [];
  for (let t = 0; t < count + burn; t++) {
    let u = randomNumberGenerator.next();
    if (u <= 0) u = 1e-16;
    else if (u >= 1) u = 1 - 1e-16;
    const z = normalInverseCdf(u);
    const rt = Math.sqrt(h) * z;
    if (t >= burn) out.push(rt);
    h = omega + alpha * rt * rt + beta * h;
  }
  return out;
}

// truth: daily long-run variance 5e-4 (≈ 2.24% daily vol), persistence 0.98
const TRUE_OMEGA = 1e-5;
const TRUE_ALPHA = 0.08;
const TRUE_BETA = 0.9;
const TRUE_PERSISTENCE = TRUE_ALPHA + TRUE_BETA;
const TRUE_LRV = TRUE_OMEGA / (1 - TRUE_PERSISTENCE);

describe('fitGarch — MLE recovery from a known GARCH(1,1) process (property golden)', () => {
  const returns = simulateGarch(5000, TRUE_OMEGA, TRUE_ALPHA, TRUE_BETA, 12345);
  const fit = fitGarch(returns);

  it('converges and recovers the persistence / long-run variance in a loose neighbourhood', () => {
    expect(fit.converged).toBe(true);
    // MLE on a finite sample is noisy — generous tolerances per the spec.
    expect(Math.abs(fit.persistence - TRUE_PERSISTENCE)).toBeLessThan(0.1);
    expect(fit.longRunVariance).toBeGreaterThan(TRUE_LRV * 0.7);
    expect(fit.longRunVariance).toBeLessThan(TRUE_LRV * 1.3);
  });

  it('reports internally-consistent, valid GARCH parameters', () => {
    expect(fit.omega).toBeGreaterThan(0);
    expect(fit.alpha).toBeGreaterThanOrEqual(0);
    expect(fit.beta).toBeGreaterThanOrEqual(0);
    expect(fit.persistence).toBeLessThan(1);
    expect(fit.persistence).toBeCloseTo(fit.alpha + fit.beta, 12);
    expect(fit.longRunVariance).toBeCloseTo(fit.omega / (1 - fit.persistence), 6);
    expect(Number.isFinite(fit.logLikelihood)).toBe(true);
    expect(fit.iterations).toBeGreaterThan(0);
  });

  it('de-meaning (mean: "sample") also recovers a valid, converged fit', () => {
    const shifted = returns.map((r) => r + 0.01); // inject a mean
    const f = fitGarch(shifted, { mean: 'sample' });
    expect(f.converged).toBe(true);
    expect(Math.abs(f.persistence - TRUE_PERSISTENCE)).toBeLessThan(0.1);
  });
});

describe('fitGarch — honesty on invalid / degenerate input', () => {
  it('throws on too few observations', () => {
    expect(() => fitGarch(new Array(20).fill(0.01))).toThrow(InputError);
  });

  it('throws on a non-finite return', () => {
    const bad = simulateGarch(60, TRUE_OMEGA, TRUE_ALPHA, TRUE_BETA, 7);
    bad[30] = Number.NaN;
    expect(() => fitGarch(bad)).toThrow(InputError);
  });

  it('reports converged:false on a degenerate (zero-variance) series rather than fabricating a fit', () => {
    const fit = fitGarch(new Array(200).fill(0));
    expect(fit.converged).toBe(false);
    expect(fit.iterations).toBe(0);
  });
});

// ───────────────────────── garchForecast — algebraic mean-reversion ─────────────────────────

const REVERT_FIT: GarchFit = {
  omega: TRUE_LRV * (1 - TRUE_PERSISTENCE),
  alpha: TRUE_ALPHA,
  beta: TRUE_BETA,
  persistence: TRUE_PERSISTENCE,
  longRunVariance: TRUE_LRV,
  logLikelihood: 0,
  converged: true,
  iterations: 1,
  assumptions: {
    conventionsVersion: '0.0.1',
    mean: 'zero',
    observations: 0,
    initialParameters: 'default',
  },
  diagnostics: { warnings: [] },
};

describe('garchForecast — multi-step variance path', () => {
  it('mean-reverts monotonically DOWN toward longRunVariance when starting above it', () => {
    const start = TRUE_LRV * 3;
    const { variancePath, volatilityPath, annualizedVolatility } = garchForecast({
      fit: REVERT_FIT,
      lastVariance: start,
      horizonPeriods: 40,
    });
    expect(variancePath).toHaveLength(40);
    for (let i = 1; i < variancePath.length; i++) {
      expect(variancePath[i]!).toBeLessThan(variancePath[i - 1]!);
      expect(variancePath[i]!).toBeGreaterThan(TRUE_LRV);
    }
    // first step matches the closed form exactly
    expect(variancePath[0]!).toBeCloseTo(TRUE_LRV + TRUE_PERSISTENCE * (start - TRUE_LRV), 12);
    // persistence 0.98 reverts slowly, but a long horizonPeriods converges to the long-run variance
    const long = garchForecast({
      fit: REVERT_FIT,
      lastVariance: start,
      horizonPeriods: 600,
    }).variancePath;
    expect(long[599]!).toBeCloseTo(TRUE_LRV, 6);
    expect(long[599]!).toBeGreaterThan(TRUE_LRV); // still approaching from above, never overshoots
    // derived paths are consistent
    expect(volatilityPath[0]!).toBeCloseTo(Math.sqrt(variancePath[0]!), 12);
    expect(annualizedVolatility[0]!).toBeCloseTo(Math.sqrt(variancePath[0]! * 252), 12);
  });

  it('mean-reverts monotonically UP toward longRunVariance when starting below it', () => {
    const start = TRUE_LRV * 0.25;
    const { variancePath } = garchForecast({
      fit: REVERT_FIT,
      lastVariance: start,
      horizonPeriods: 40,
    });
    for (let i = 1; i < variancePath.length; i++) {
      expect(variancePath[i]!).toBeGreaterThan(variancePath[i - 1]!);
      expect(variancePath[i]!).toBeLessThan(TRUE_LRV);
    }
  });

  it('stays flat at longRunVariance when started there', () => {
    const { variancePath, volatilityPath } = garchForecast({
      fit: REVERT_FIT,
      lastVariance: TRUE_LRV,
      horizonPeriods: 25,
    });
    for (const v of variancePath) expect(v).toBeCloseTo(TRUE_LRV, 12);
    for (const s of volatilityPath) expect(s).toBeCloseTo(Math.sqrt(TRUE_LRV), 12);
  });

  it('honours a custom periodsPerYear for annualization', () => {
    const { variancePath, annualizedVolatility } = garchForecast({
      fit: REVERT_FIT,
      lastVariance: TRUE_LRV * 2,
      horizonPeriods: 5,
      options: {
        periodsPerYear: 12,
      },
    });
    expect(annualizedVolatility[0]!).toBeCloseTo(Math.sqrt(variancePath[0]! * 12), 12);
  });

  it('rejects a non-positive horizonPeriods and a non-positive lastVariance', () => {
    expect(() =>
      garchForecast({ fit: REVERT_FIT, lastVariance: TRUE_LRV, horizonPeriods: 0 }),
    ).toThrow(InputError);
    expect(() => garchForecast({ fit: REVERT_FIT, lastVariance: -1, horizonPeriods: 5 })).toThrow(
      InputError,
    );
  });
});

// ───────────────────────── HAR-RV — exact + noisy goldens ─────────────────────────

const WEEKLY = 5;
const MONTHLY = 22;
const HAR_C = 0.1;
const HAR_D = 0.3;
const HAR_W = 0.3;
const HAR_M = 0.3;

function trailingMean(series: number[], end: number, window: number): number {
  let s = 0;
  for (let i = 0; i < window; i++) s += series[end - i]!;
  return s / window;
}

/** Build RV as an EXACT linear function of its daily/weekly/monthly lags. */
function makeExactHarSeries(length: number): number[] {
  const rv: number[] = [];
  for (let i = 0; i < MONTHLY; i++) {
    rv.push(1 + 0.6 * Math.sin(i * 1.1) + 0.3 * Math.cos(i * 2.3)); // varied, strictly positive
  }
  for (let t = MONTHLY; t < length; t++) {
    const d = rv[t - 1]!;
    const w = trailingMean(rv, t - 1, WEEKLY);
    const m = trailingMean(rv, t - 1, MONTHLY);
    rv.push(HAR_C + HAR_D * d + HAR_W * w + HAR_M * m);
  }
  return rv;
}

describe('fitHarRv — exact linear golden (OLS recovers the coefficients)', () => {
  const rv = makeExactHarSeries(90);
  const fit = fitHarRv(rv);

  it('recovers const/daily/weekly/monthly to ~1e-6 with r² ≈ 1', () => {
    expect(fit.coefficients.const).toBeCloseTo(HAR_C, 6);
    expect(fit.coefficients.daily).toBeCloseTo(HAR_D, 6);
    expect(fit.coefficients.weekly).toBeCloseTo(HAR_W, 6);
    expect(fit.coefficients.monthly).toBeCloseTo(HAR_M, 6);
    expect(fit.rSquared).toBeCloseTo(1, 8);
    expect(fit.observationCount).toBe(rv.length - MONTHLY);
    expect(fit.windows).toEqual({ weekly: WEEKLY, monthly: MONTHLY });
    for (const e of fit.residuals) expect(Math.abs(e)).toBeLessThan(1e-6);
  });

  it('one-step-ahead forecast matches the generating recursion', () => {
    const last = rv.length - 1;
    const truthNext =
      HAR_C +
      HAR_D * rv[last]! +
      HAR_W * trailingMean(rv, last, WEEKLY) +
      HAR_M * trailingMean(rv, last, MONTHLY);
    expect(harRvForecast(fit, rv)).toBeCloseTo(truthNext, 6);
  });

  // ── H24 — the forecast facade explains its regression arithmetic ──
  it('harRvForecast.explain returns the same scalar and its contributions sum to it', () => {
    const plain = harRvForecast(fit, rv);
    const explained = harRvForecast.explain(fit, rv);
    expect(explained.value).toBeCloseTo(plain, 15);
    const d = explained.diagnostics.decomposition!;
    // value = intercept + Σ coefficient·predictor — the disclosed terms reconstruct the forecast
    expect(explained.value).toBeCloseTo(
      d['interceptContribution']! +
        d['dailyContribution']! +
        d['weeklyContribution']! +
        d['monthlyContribution']!,
      12,
    );
    // the predictors are the trailing aggregates of the supplied history…
    const last = rv.length - 1;
    expect(d['dailyPredictor']!).toBe(rv[last]!);
    expect(d['weeklyPredictor']!).toBeCloseTo(trailingMean(rv, last, WEEKLY), 12);
    expect(d['monthlyPredictor']!).toBeCloseTo(trailingMean(rv, last, MONTHLY), 12);
    // …and each contribution is the fitted coefficient times its disclosed predictor
    expect(d['interceptContribution']!).toBe(fit.coefficients.const);
    expect(d['dailyContribution']!).toBeCloseTo(fit.coefficients.daily * d['dailyPredictor']!, 12);
    expect(d['weeklyContribution']!).toBeCloseTo(
      fit.coefficients.weekly * d['weeklyPredictor']!,
      12,
    );
    expect(d['monthlyContribution']!).toBeCloseTo(
      fit.coefficients.monthly * d['monthlyPredictor']!,
      12,
    );
    // assumptions echo the fitted windows the forecast reused
    expect(explained.assumptions.weekly).toBe(WEEKLY);
    expect(explained.assumptions.monthly).toBe(MONTHLY);
    expect(explained.assumptions.horizonKind).toBe('one-step-ahead');
    expect(explained.assumptions.conventionsVersion.length).toBeGreaterThan(0);
    expect(explained.diagnostics.warnings).toEqual([]);
  });
});

describe('fitHarRv — noisy case + custom windows + validation', () => {
  it('lands r² strictly inside (0, 1) with a noisy response', () => {
    const rv = makeExactHarSeries(90);
    const noisy = rv.map((v, i) => v + 0.05 * Math.sin(i * 3.7) * Math.cos(i * 0.9));
    const fit = fitHarRv(noisy);
    expect(fit.rSquared).toBeGreaterThan(0);
    expect(fit.rSquared).toBeLessThan(1);
    // residuals are genuinely non-zero
    const maxAbs = Math.max(...fit.residuals.map((e) => Math.abs(e)));
    expect(maxAbs).toBeGreaterThan(1e-4);
  });

  it('honours custom weekly/monthly windows (stored on the fit and reused by the forecast)', () => {
    const rv = makeExactHarSeries(120).map((v, i) => v + 0.001 * i); // mild trend for variation
    const fit = fitHarRv(rv, { weekly: 3, monthly: 10 });
    expect(fit.windows).toEqual({ weekly: 3, monthly: 10 });
    expect(fit.observationCount).toBe(rv.length - 10);
    // forecast uses the fit's windows without extra config
    expect(Number.isFinite(harRvForecast(fit, rv))).toBe(true);
  });

  it('throws on too-few observations, a bad window, and a short forecast history', () => {
    expect(() => fitHarRv(new Array(20).fill(0.5))).toThrow(InputError);
    expect(() => fitHarRv(new Array(60).fill(0.5), { weekly: 0 })).toThrow(InputError);
    expect(() => fitHarRv(new Array(60).fill(0.5), { weekly: 10, monthly: 5 })).toThrow(InputError);
    const fit = fitHarRv(makeExactHarSeries(90));
    expect(() => harRvForecast(fit, [0.1, 0.2, 0.3])).toThrow(InputError);
  });

  // Regression for an external-review finding: a negative-RV probe produced coefficients ~1e15 and a
  // ~3.9e15 forecast. Realized variance is non-negative and a rank-deficient design has no OLS fit.
  it('rejects a negative realized variance instead of fitting blown-up coefficients', () => {
    const series = makeExactHarSeries(60);
    series[10] = -0.25; // variances cannot be negative
    let caught: unknown;
    try {
      fitHarRv(series);
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
  });

  it('rejects a degenerate (constant) series as rank-deficient, not a confident garbage fit', () => {
    let caught: unknown;
    try {
      fitHarRv(new Array(30).fill(0.5)); // all predictors collinear ⇒ singular least-squares system
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'linalg.singular')).toBe(true);
  });
});

// Regression for a review finding: the forecast entrypoints dereferenced `fit` unchecked, so a
// missing/hand-rolled fit died on a raw TypeError instead of a teaching InputError.
describe('forecast fit-object guards (teach the shape, never a raw TypeError)', () => {
  it('garchForecast rejects a missing fit and names the missing field on a wrong-shaped one', () => {
    expect(() =>
      garchForecast({ fit: undefined as never, lastVariance: TRUE_LRV, horizonPeriods: 5 }),
    ).toThrow(InputError);
    expect(() =>
      garchForecast({ fit: undefined as never, lastVariance: TRUE_LRV, horizonPeriods: 5 }),
    ).toThrow(/fit/);
    // The fit fixture must satisfy the declared shape for the DOMAIN probe to be the thing
    // tested — an empty fit now fails on its first declared field (alpha), which is correct but a
    // different question.
    expect(() =>
      garchForecast({ fit: {} as GarchFit, lastVariance: TRUE_LRV, horizonPeriods: 5 }),
    ).toThrow(/fit\.alpha/);
    // A REAL fit with only the probed field poisoned, so the domain check is the thing tested.
    const realFit = fitGarch(simulateGarch(5000, TRUE_OMEGA, TRUE_ALPHA, TRUE_BETA, 12345));
    expect(() =>
      garchForecast({
        fit: { ...realFit, longRunVariance: Number.NaN } as GarchFit,
        lastVariance: TRUE_LRV,
        horizonPeriods: 5,
      }),
    ).toThrow(/longRunVariance/);
  });

  it('harRvForecast rejects a missing fit', () => {
    const history = makeExactHarSeries(60);
    expect(() => harRvForecast(undefined as never, history)).toThrow(InputError);
    expect(() => harRvForecast(undefined as never, history)).toThrow(/fit/);
  });

  it('harRvForecast teaches the HarRvFit shape — pass the result of fitHarRv()', () => {
    const history = makeExactHarSeries(60);
    // a hand-rolled fit without windows previously crashed on the `fit.windows` destructure
    const noWindows = { coefficients: { const: 0.1, daily: 0.3, weekly: 0.3, monthly: 0.3 } };
    expect(() => harRvForecast(noWindows as never, history)).toThrow(InputError);
    expect(() => harRvForecast(noWindows as never, history)).toThrow(/fitHarRv/);
    // windows present but coefficients missing would crash later reading `.const` — same teaching error
    const noCoefficients = { windows: { weekly: WEEKLY, monthly: MONTHLY } };
    expect(() => harRvForecast(noCoefficients as never, history)).toThrow(/fitHarRv/);
    // non-numeric windows are the same wrong shape
    const badWindows = { ...noWindows, windows: { weekly: '5', monthly: MONTHLY } };
    expect(() => harRvForecast(badWindows as never, history)).toThrow(/fitHarRv/);
  });
});

describe('garchForecast options hardening (deep-sweep boundary)', () => {
  it('rejects a null options bag instead of dying on the first option read', () => {
    // `null` slips past the `= {}` default parameter (only `undefined` triggers it).
    const fit: GarchFit = {
      omega: 4e-6,
      alpha: 0.09,
      beta: 0.88,
      persistence: 0.97,
      longRunVariance: 4e-6 / (1 - 0.97),
      logLikelihood: -480.5,
      converged: true,
      iterations: 42,
      assumptions: {
        conventionsVersion: '0.0.1',
        mean: 'zero',
        observations: 200,
        initialParameters: 'default',
      },
      diagnostics: { warnings: [] },
    };
    expect(() =>
      garchForecast({ fit, lastVariance: 1.2e-4, horizonPeriods: 5, options: null as never }),
    ).toThrow(/garchForecast: options must be an object/);
    // A valid call still works with and without the bag.
    expect(
      garchForecast({ fit, lastVariance: 1.2e-4, horizonPeriods: 5 }).variancePath,
    ).toHaveLength(5);
  });
});
