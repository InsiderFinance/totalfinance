/**
 * 2026-08-23 review P0 — count/resource safety, library-wide wave.
 *
 * `Number.isInteger(1e308)` is `true`, and above 2^53 a loop counter stops advancing — so a public
 * workload control validated with `Number.isInteger` and then looped over or allocated against was
 * a non-terminating loop or an absurd allocation. This file pins the volatility guards: the GARCH
 * forecast horizon (safe int, capped at 100,000 — it sizes three materialized paths), the
 * Breeden-Litzenberger density grid (capped at 100,001 — note 999,999,999 is ODD, so the old
 * "odd integer" gate happily accepted it as unbounded work), the arbitrage scan resolutions
 * (capped at 10,000), Newey-West hacLags (capped at 1,000 — ols spins `lags` outer iterations
 * regardless of sample size), and the safe-integer discipline on the data-bounded counts.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { mulberry32, normalInverseCdf } from '@totalfinance/math';
import {
  arbitrageReport,
  calibrateEssvi,
  calibrateHestonSurface,
  calibrateSabrSmile,
  calibrateSsvi,
  calibrateSvi,
  checkButterfly,
  estimateVolatilitySpotBeta,
  fitGarch,
  fitHarRv,
  garchForecast,
  harRvForecast,
  surfacePCA,
  surfacePcaScenarios,
  volatilityCone,
} from '@totalfinance/volatility';
import { vannaVolgaDensity } from '@totalfinance/volatility/vanna-volga';
import type { ArbitrageSlice } from '@totalfinance/volatility';

/** Capture the thrown value (the guards must throw typed QuantErrors, never return). */
function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const UNSAFE_COUNTS = [2 ** 53, 1e308] as const;

describe('volatility calibrations — public optimizer budgets are capped at 10,000', () => {
  const sviInput = {
    k: [-0.2, -0.1, 0, 0.1, 0.2],
    w: [0.045, 0.042, 0.04, 0.041, 0.044],
  };
  const sabrInput = {
    forward: 100,
    strikes: [90, 100, 110],
    impliedVolatilities: [0.22, 0.2, 0.21],
    timeToExpiryYears: 0.5,
  };
  const surface = {
    slices: [
      { timeToExpiryYears: 0.5, k: [-0.1, 0, 0.1], w: [0.024, 0.02, 0.022] },
      { timeToExpiryYears: 1, k: [-0.1, 0, 0.1], w: [0.046, 0.04, 0.043] },
    ],
  };
  const calls: Array<[string, (maximumIterations: number) => unknown]> = [
    ['calibrateSvi', (maximumIterations) => calibrateSvi(sviInput, { maximumIterations })],
    [
      'calibrateSabrSmile',
      (maximumIterations) => calibrateSabrSmile(sabrInput, { maximumIterations }),
    ],
    ['calibrateSsvi', (maximumIterations) => calibrateSsvi(surface, { maximumIterations })],
    ['calibrateEssvi', (maximumIterations) => calibrateEssvi(surface, { maximumIterations })],
    [
      'calibrateHestonSurface',
      (maximumIterations) =>
        calibrateHestonSurface({
          targets: [{ strike: 100, timeToExpiryYears: 0.5, impliedVolatility: 0.2, forward: 101 }],
          market: { spot: 100, riskFreeRate: 0.04, dividendYield: 0 },
          options: { maximumIterations },
        }),
    ],
  ];

  it('refuses unsafe, fractional, non-positive, and above-cap budgets before optimization', () => {
    for (const [name, call] of calls) {
      for (const bad of [2 ** 32, ...UNSAFE_COUNTS, 2.5, 0, 10_001]) {
        const error = catching(() => call(bad));
        expect(isQuantError(error, 'input.out_of_range'), `${name} ${bad}`).toBe(true);
        expect(String((error as Error).message)).toContain('maximumIterations');
      }
      expect(String((catching(() => call(10_001)) as Error).message)).toContain('10,000');
    }
  });

  it('calibrateHestonSurface also refuses an unbounded COS term request before its objective', () => {
    const error = catching(() =>
      calibrateHestonSurface({
        targets: [{ strike: 100, timeToExpiryYears: 0.5, impliedVolatility: 0.2, forward: 101 }],
        market: { spot: 100, riskFreeRate: 0.04, dividendYield: 0 },
        options: { terms: 8_193 },
      }),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect(String((error as Error).message)).toContain('8,192');
  });
});

/** Simulate a stationary GARCH(1,1) series so fitGarch produces a real fit. */
function simulateGarch(count: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const omega = 1e-5;
  const alpha = 0.08;
  const beta = 0.9;
  let h = omega / (1 - alpha - beta);
  const out: number[] = [];
  for (let t = 0; t < count + 500; t++) {
    let u = rng.next();
    if (u <= 0) u = 1e-16;
    else if (u >= 1) u = 1 - 1e-16;
    const r = Math.sqrt(h) * normalInverseCdf(u);
    if (t >= 500) out.push(r);
    h = omega + alpha * r * r + beta * h;
  }
  return out;
}

describe('garchForecast — horizonPeriods is a safe integer capped at 100,000 (it sizes three path arrays)', () => {
  const fit = fitGarch(simulateGarch(800, 12345));

  it('refuses 2^53 / 1e308 / cap + 1 typed naming the bound, and accepts a realistic horizon', () => {
    for (const bad of [...UNSAFE_COUNTS, 100_001, 10.5]) {
      const caught = catching(() =>
        garchForecast({ fit, lastVariance: fit.longRunVariance, horizonPeriods: bad }),
      );
      expect(isQuantError(caught, 'input.out_of_range'), `horizonPeriods ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('horizonPeriods');
    }
    const atCapPlusOne = catching(() =>
      garchForecast({ fit, lastVariance: fit.longRunVariance, horizonPeriods: 100_001 }),
    );
    expect(String((atCapPlusOne as Error).message)).toContain('100,000');
    const accepted = garchForecast({
      fit,
      lastVariance: fit.longRunVariance,
      horizonPeriods: 20,
    });
    expect(accepted.variancePath).toHaveLength(20);
  });
});

describe('HAR-RV windows — safe integers (the observation-count requirement keeps them data-bounded)', () => {
  // A noisy (non-degenerate) realized-variance series so the HAR OLS system is identifiable.
  const rvRng = mulberry32(777);
  const rvs = Array.from({ length: 60 }, () => 4e-4 * (0.5 + rvRng.next()));

  it('fitHarRv refuses 2^53 / fractional weekly and monthly windows typed', () => {
    for (const bad of [...UNSAFE_COUNTS, 5.5]) {
      expect(
        isQuantError(
          catching(() => fitHarRv(rvs, { weekly: bad })),
          'input.out_of_range',
        ),
        `weekly ${bad}`,
      ).toBe(true);
      expect(
        isQuantError(
          catching(() => fitHarRv(rvs, { monthly: bad })),
          'input.out_of_range',
        ),
        `monthly ${bad}`,
      ).toBe(true);
    }
    expect(fitHarRv(rvs).windows).toEqual({ weekly: 5, monthly: 22 });
  });

  it('harRvForecast refuses 2^53 windows smuggled inside a hand-edited fit', () => {
    const fit = fitHarRv(rvs);
    const tampered = { ...fit, windows: { weekly: 2 ** 53, monthly: 2 ** 53 } };
    const caught = catching(() => harRvForecast(tampered, rvs));
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(Number.isFinite(harRvForecast(fit, rvs))).toBe(true);
  });
});

describe('vannaVolgaDensity — gridPoints is a safe integer capped at 100,001', () => {
  const base = {
    forward: 100,
    timeToExpiryYears: 0.5,
    atmVolatility: 0.2,
    riskReversal: -0.02,
    butterfly: 0.005,
  };

  it('refuses a huge ODD count (the real regression — parity never rejected it), 2^53, 1e308, and cap + 2; accepts a realistic grid', () => {
    // 999,999,999 is odd and < 2^53: the old "odd integer ≥ 11" gate ACCEPTED it — a ~10^9-point
    // grid of Black-Scholes evaluations. (Every representable double ≥ 2^53 happens to be even,
    // so parity masked the unsafe range; the cap is what actually bounds the work.)
    for (const bad of [999_999_999, ...UNSAFE_COUNTS, 100_003, 51.5]) {
      const caught = catching(() => vannaVolgaDensity({ ...base, gridPoints: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `gridPoints ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('gridPoints');
    }
    const justAboveCap = catching(() => vannaVolgaDensity({ ...base, gridPoints: 100_003 }));
    expect(String((justAboveCap as Error).message)).toContain('100,001');
    const accepted = vannaVolgaDensity({ ...base, gridPoints: 101 });
    expect(accepted.grid.strikes).toHaveLength(101);
  });
});

describe('arbitrage scans — butterflyPoints/calendarPoints are safe integers capped at 10,000', () => {
  const slice = (expiry: string, t: number, level: number): ArbitrageSlice => ({
    expiry,
    timeToExpiryYears: t,
    forward: 100,
    impliedVolatility: () => level,
    strikeRange: [80, 125],
  });
  const slices = [slice('2026-04-17', 0.25, 0.2), slice('2026-07-17', 1.0, 0.22)];

  it('refuses 2^53 / 1e308 / cap + 1 typed naming the bound on both knobs, and a realistic scan runs', () => {
    for (const bad of [...UNSAFE_COUNTS, 10_001, 40.5]) {
      expect(
        isQuantError(
          catching(() => arbitrageReport(slices, { butterflyPoints: bad })),
          'input.out_of_range',
        ),
        `butterflyPoints ${bad}`,
      ).toBe(true);
      expect(
        isQuantError(
          catching(() => arbitrageReport(slices, { calendarPoints: bad })),
          'input.out_of_range',
        ),
        `calendarPoints ${bad}`,
      ).toBe(true);
    }
    const butterflyAboveCap = catching(() => arbitrageReport(slices, { butterflyPoints: 10_001 }));
    expect(String((butterflyAboveCap as Error).message)).toContain('10,000');
    const calendarAboveCap = catching(() => arbitrageReport(slices, { calendarPoints: 10_001 }));
    expect(String((calendarAboveCap as Error).message)).toContain('10,000');
    const report = arbitrageReport(slices, { butterflyPoints: 51, calendarPoints: 21 });
    expect(report.checks.calendar).toBe(true);
    // The single-slice entry shares the same guard.
    expect(
      isQuantError(
        catching(() => checkButterfly(slices[0]!, { butterflyPoints: 2 ** 53 })),
        'input.out_of_range',
      ),
    ).toBe(true);
  });
});

describe('surfacePCA — retained-count knobs are safe integers (Math.min keeps them data-bounded)', () => {
  const snapshots = Array.from({ length: 8 }, (_, t) => [
    0.2 + 0.002 * t,
    0.22 + 0.003 * Math.sin(t),
    0.25 - 0.001 * t,
  ]);

  it('surfacePCA refuses 2^53 / fractional maxComponents typed, surfacePcaScenarios the same for maxModes', () => {
    for (const bad of [...UNSAFE_COUNTS, 1.5]) {
      expect(
        isQuantError(
          catching(() => surfacePCA({ snapshots, maxComponents: bad })),
          'input.out_of_range',
        ),
        `maxComponents ${bad}`,
      ).toBe(true);
    }
    const pca = surfacePCA({ snapshots, maxComponents: 2 });
    expect(pca.modes.length).toBeLessThanOrEqual(2);
    for (const bad of [...UNSAFE_COUNTS, 1.5]) {
      expect(
        isQuantError(
          catching(() => surfacePcaScenarios({ pca, base: [0.2, 0.22, 0.25], maxModes: bad })),
          'input.out_of_range',
        ),
        `maxModes ${bad}`,
      ).toBe(true);
    }
    expect(
      surfacePcaScenarios({ pca, base: [0.2, 0.22, 0.25], maxModes: 1 }).scenarios.length,
    ).toBeGreaterThan(0);
  });
});

describe('volatilityCone — windows are safe integers (the rolling loop is bounded by the sample)', () => {
  const returns = Array.from({ length: 120 }, (_, i) => 0.01 * Math.sin(i / 2));

  it('refuses 2^53 / fractional windows typed and computes a realistic cone', () => {
    for (const bad of [...UNSAFE_COUNTS, 10.5]) {
      const caught = catching(() => volatilityCone(returns, { windows: [bad] }));
      expect(isQuantError(caught, 'input.out_of_range'), `window ${bad}`).toBe(true);
    }
    expect(volatilityCone(returns, { windows: [10, 21] })).toHaveLength(2);
  });
});

describe('estimateVolatilitySpotBeta — hacLags is a safe integer capped at 1,000 (ols spins `lags` outer passes regardless of n)', () => {
  // Varying log-returns (a constant increment would be collinear with the OLS intercept).
  const spot: number[] = [100];
  for (let i = 1; i < 40; i++) {
    spot.push(spot[i - 1]! * Math.exp(0.01 * Math.sin(i) + 0.004 * Math.cos(3 * i)));
  }
  const impliedVolatility = spot.map(
    (s, i) => 0.4 - 0.05 * Math.log(s / 100) + 0.001 * Math.sin(7 * i),
  );

  it('refuses 2^53 / 1e308 / cap + 1 typed naming the bound, and accepts a realistic bandwidth', () => {
    for (const bad of [...UNSAFE_COUNTS, 1_001, 3.5]) {
      const caught = catching(() =>
        estimateVolatilitySpotBeta({ spot, impliedVolatility, hacLags: bad }),
      );
      expect(isQuantError(caught, 'input.out_of_range'), `hacLags ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('hacLags');
    }
    const atCapPlusOne = catching(() =>
      estimateVolatilitySpotBeta({ spot, impliedVolatility, hacLags: 1_001 }),
    );
    expect(String((atCapPlusOne as Error).message)).toContain('1,000');
    const accepted = estimateVolatilitySpotBeta({ spot, impliedVolatility, hacLags: 3 });
    expect(Number.isFinite(accepted.value.slope)).toBe(true);
  });
});
