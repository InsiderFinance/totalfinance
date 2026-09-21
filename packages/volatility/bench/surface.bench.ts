import { bench, describe } from 'vitest';
import { type OptionQuote, yearFraction } from '@totalfinance/core';
import { option } from '@totalfinance/options';
import { volatilitySurface } from '@totalfinance/volatility';
import {
  calibrateEssvi,
  essviArbitrageFree,
  essviTotalVariance,
} from '@totalfinance/volatility/essvi';
import { calibrateSsvi, ssviArbitrageFree, ssviTotalVariance } from '@totalfinance/volatility/ssvi';

/**
 * Phase-5 acceleration-need benchmark for volatility-surface fitting (§19.4 candidate).
 *
 * Repaired at 3B.1b: the contract literal predated the ONE EXPIRY LAW (E2), which made `expiresAt`
 * and `expiryConvention` required — "an unresolved literal is not a contract; build one with the
 * option builders" — and `market.rate` was renamed `riskFreeRate`. Benchmarks were outside typecheck,
 * so neither showed up.
 */
const asOf = Date.UTC(2026, 0, 1);
const spot = 100;
const rate = 0.03;
const EXPIRIES = ['2026-04-02', '2026-07-02', '2026-10-02'];
const STRIKES = Array.from({ length: 15 }, (_, i) => 70 + i * 4);

function chain(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const expiry of EXPIRIES) {
    const t = yearFraction(asOf, Date.parse(`${expiry}T00:00:00Z`), 'ACT/365F');
    const F = spot * Math.exp(rate * t);
    for (const k of STRIKES) {
      const iv = 0.2 + 0.5 * Math.log(F / k) ** 2 + 0.05 * Math.log(F / k);
      rows.push({
        contract: option.european({
          underlying: 'X',
          type: 'call',
          strike: k,
          expiry,
          convention: 'us-equity-close',
        }),
        timestampMs: asOf,
        impliedVolatility: Math.max(0.05, iv),
        underlyingPrice: spot,
      });
    }
  }
  return rows;
}

describe('vol surface fit (acceleration-need benchmark)', () => {
  const quotes = chain();
  bench('SVI calibration (3 expiries × 15 strikes)', () => {
    volatilitySurface({
      quotes,
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
  });
});

/**
 * SSVI / eSSVI — the paths the review found uncovered.
 *
 * These are where guarded-vs-unchecked matters most: the calibration objective evaluates the slice
 * function once per quoted strike per optimizer iteration, and the arbitrage diagnostics sweep a
 * log-moneyness grid crossed with maturities. Before 3B.1b's routing fix those loops called the
 * GUARDED `ssviSliceW`, so every evaluation re-validated four fields to do six multiplications —
 * a tight-loop A/B put the guard at roughly 13x the arithmetic it protects.
 *
 * Evaluation and calibration are benchmarked separately: the first is the raw per-call cost the
 * routing changed, the second is the end-to-end number a caller actually experiences.
 */
const SSVI_PARAMS = {
  rho: -0.3,
  phi: { kind: 'power-law' as const, eta: 1.0, gamma: 0.5 },
  thetaTerm: [
    { timeToExpiryYears: 0.25, theta: 0.01 },
    { timeToExpiryYears: 0.5, theta: 0.02 },
    { timeToExpiryYears: 1.0, theta: 0.04 },
  ],
};

const ESSVI_PARAMS = {
  phi: { kind: 'power-law' as const, eta: 1.0, gamma: 0.5 },
  thetaTerm: [
    { timeToExpiryYears: 0.25, theta: 0.01, rho: -0.4 },
    { timeToExpiryYears: 0.5, theta: 0.02, rho: -0.3 },
    { timeToExpiryYears: 1.0, theta: 0.04, rho: -0.2 },
  ],
};

let sink = 0;

const K_GRID = Array.from({ length: 41 }, (_, i) => -1 + (2 * i) / 40);

describe('SSVI / eSSVI surface evaluation', () => {
  bench('ssviTotalVariance over a 41-point grid x 3 maturities', () => {
    let acc = 0;
    for (const t of [0.25, 0.5, 1.0])
      for (const k of K_GRID) acc += ssviTotalVariance(SSVI_PARAMS, k, t);
    sink = acc;
  });

  bench('essviTotalVariance over a 41-point grid x 3 maturities', () => {
    let acc = 0;
    for (const t of [0.25, 0.5, 1.0])
      for (const k of K_GRID) acc += essviTotalVariance(ESSVI_PARAMS, k, t);
    sink = acc;
  });

  bench('ssviArbitrageFree (butterfly + calendar sweep)', () => {
    sink = ssviArbitrageFree(SSVI_PARAMS).minButterflyG;
  });

  bench('essviArbitrageFree (grid-crossing calendar scan)', () => {
    sink = essviArbitrageFree(ESSVI_PARAMS).minButterflyG;
  });
});

void sink;

/**
 * CALIBRATION, not evaluation.
 *
 * The suite above times `ssviTotalVariance` / `essviTotalVariance` — closed-form evaluations that run
 * once per point. The optimizer objective is the path that actually runs thousands of times per fit,
 * and it was the reason RV1 introduced unchecked kernels in the first place. Benchmarking only the
 * evaluators left the claim resting on the one path nobody measured: a regression inside the
 * objective would not have moved a single number on this file.
 *
 * The surface below is synthetic and arbitrage-free by construction, so every fit converges and the
 * timings compare like with like across runs.
 */
const CAL_MATURITIES = [0.08, 0.25, 0.5, 1, 1.5, 2];
const CAL_STRIKES = Array.from({ length: 21 }, (_, i) => -0.5 + i * 0.05);

/**
 * EACH FIT GETS A SURFACE ITS OWN FAMILY CAN REPRODUCE.
 *
 * The first version generated one power-law surface and fed it to every fit, including the
 * Heston-phi one — which cannot represent a power-law curvature term and therefore did not converge:
 * `converged: false`, rmse 3.59e-2, warning `volatility.ssvi_not_converged`. Nothing checked, so a
 * benchmark whose comment promised convergence was timing the optimizer grinding to its iteration
 * cap. That is a slower and much noisier path than a real fit, so the number it reported was not the
 * quantity it claimed to measure.
 *
 * `psiOf` makes the generating curvature explicit, and the assertion below refuses to benchmark any
 * configuration that does not actually solve.
 */
function syntheticSlices(psiOf: (theta: number) => number, rho: number) {
  return CAL_MATURITIES.map((t) => {
    const theta = 0.04 * t;
    const psi = psiOf(theta);
    const w = CAL_STRIKES.map((k) => {
      const phiK = psi * k;
      return (theta / 2) * (1 + rho * phiK + Math.sqrt((phiK + rho) ** 2 + (1 - rho * rho)));
    });
    return { timeToExpiryYears: t, k: CAL_STRIKES, w };
  });
}

/** φ(θ) = η·θ^(−γ) — the family `phi: 'power-law'` fits. */
const POWER_LAW_SLICES = syntheticSlices((theta) => 1.8 * Math.pow(theta, -0.42), -0.55);

/** φ(θ) = (1/λθ)·(1 − (1 − e^(−λθ))/λθ) — the family `phi: 'heston'` fits. */
const HESTON_SLICES = syntheticSlices((theta) => {
  const lt = 1.5 * theta;
  return (1 / lt) * (1 - (1 - Math.exp(-lt)) / lt);
}, -0.55);

const CALIBRATIONS = [
  {
    label: 'calibrateSsvi — power-law phi',
    run: () => calibrateSsvi({ slices: POWER_LAW_SLICES }, { phi: 'power-law' }),
  },
  {
    label: 'calibrateSsvi — heston phi',
    run: () => calibrateSsvi({ slices: HESTON_SLICES }, { phi: 'heston' }),
  },
  {
    label: 'calibrateSsvi — vega-weighted residuals',
    run: () => calibrateSsvi({ slices: POWER_LAW_SLICES }, { phi: 'power-law', weight: 'vega' }),
  },
  {
    label: 'calibrateEssvi — per-maturity skew',
    run: () => calibrateEssvi({ slices: POWER_LAW_SLICES }),
  },
] as const;

// Refuse to time a fit that does not converge — the same rule the IV benchmark applies to its 5,000
// rows. A non-converging fit runs to the iteration cap, which is neither the workload being claimed
// nor a stable basis for comparison across runs.
for (const { label, run } of CALIBRATIONS) {
  const result = run();
  if (!result.converged) {
    throw new Error(
      `calibration benchmark "${label}" does not converge (rmse ${result.rmse.toExponential(3)}) — ` +
        `it would time the optimizer hitting its iteration cap, not a fit.`,
    );
  }
}

describe('SSVI / eSSVI calibration (optimizer objective, 6 maturities x 21 strikes)', () => {
  for (const { label, run } of CALIBRATIONS) {
    bench(label, () => {
      run();
    });
  }
});
