/**
 * Stage 4.5 slice 3 — first-touch fixtures for `@totalfinance/volatility/artifacts`: the eight verbs
 * over an SVI fit (the cheapest family), fresh per call. Thunks return FRESH, valid argument lists;
 * probes mutate them.
 */

import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';
import { fittedModelArtifact } from '@totalfinance/volatility/artifacts';
import { calibrateSvi, sviTotalVariance, type SVIParameters } from '@totalfinance/volatility/svi';
import type { FixtureThunk } from '../inputs.js';

const SVI_TRUE: SVIParameters = { a: 0.04, b: 0.4, rho: -0.4, m: 0.05, sigma: 0.15 };
const SVI_KS = [-0.5, -0.35, -0.2, -0.1, -0.03, 0, 0.05, 0.12, 0.22, 0.35, 0.5];

const sviCalibration = () => ({
  smile: { k: [...SVI_KS], w: SVI_KS.map((k) => sviTotalVariance(SVI_TRUE, k)) },
  options: { timeToExpiryYears: 0.5 },
});

const sviArtifact = () => {
  const calibration = sviCalibration();
  return fittedModelArtifact({
    family: 'svi',
    fit: calibrateSvi(calibration.smile, calibration.options),
    calibration,
  });
};

/** A persisted copy: exactly what a caller's storage hands back. */
const persisted = () => fromCanonicalJson(canonicalJsonOf(sviArtifact()));

export const VOLATILITY_ARTIFACTS_FIXTURES: Record<string, FixtureThunk> = {
  'volatility.fittedModelArtifact': () => {
    const calibration = sviCalibration();
    return [
      { family: 'svi', fit: calibrateSvi(calibration.smile, calibration.options), calibration },
    ];
  },
  'volatility.readFittedModel': () => [{ artifact: persisted() }],
  'volatility.evaluateFittedModel': () => [
    { model: persisted(), at: { logMoneyness: [-0.2, 0, 0.2], timeToExpiryYears: 0.5 } },
  ],
  'volatility.replayFittedModel': () => [
    { artifact: persisted(), limits: { maximumDifferences: 50 } },
  ],
  'volatility.compareFittedModels': () => [
    {
      baseline: persisted(),
      candidate: persisted(),
      tolerance: { absolute: 1e-9, relative: 1e-9 },
      limits: { gridPoints: 8 },
    },
  ],
  'volatility.warmStartFrom': () => [{ model: persisted() }],
  'volatility.fittedModelStability': () => [
    {
      family: 'svi',
      calibration: sviCalibration(),
      restarts: 2,
      perturbation: { relative: 0.1 },
      seed: 7,
      tolerance: { absolute: 1e-3, relative: 1e-2 },
    },
  ],
  'volatility.fittedModelHoldout': () => [
    { family: 'svi', calibration: sviCalibration(), holdout: { everyNth: 3, offset: 0 } },
  ],
};
