/**
 * Stage 4.5 slice 4 — first-touch fixtures for `@totalfinance/fixed-income/artifacts`: the eight verbs
 * over a discount-curve bootstrap (the cheapest family), fresh per call.
 */

import { canonicalJsonOf, fromCanonicalJson } from '@totalfinance/core/artifacts';
import { curves, type BootstrapInstrument } from '@totalfinance/fixed-income';
import { fittedModelArtifact } from '@totalfinance/fixed-income/artifacts';
import type { FixtureThunk } from '../inputs.js';

const REFERENCE_DATE = '2026-01-01';
const instruments = (): BootstrapInstrument[] => [
  { type: 'deposit', maturity: '2026-07-01', rate: 0.03 },
  { type: 'swap', maturity: '2028-01-01', rate: 0.032, fixedFrequency: 'semiannual' },
  { type: 'swap', maturity: '2031-01-01', rate: 0.035, fixedFrequency: 'semiannual' },
];
const calibration = () => ({
  instruments: instruments(),
  options: { referenceDate: REFERENCE_DATE },
});
const artifact = () => {
  const input = calibration();
  return fittedModelArtifact({
    family: 'discount-curve',
    fit: curves.bootstrap(input.instruments, input.options),
    calibration: input,
    currency: 'USD',
  });
};
const persisted = () => fromCanonicalJson(canonicalJsonOf(artifact()));

export const FIXED_INCOME_ARTIFACTS_FIXTURES: Record<string, FixtureThunk> = {
  'fixed-income.fittedModelArtifact': () => {
    const input = calibration();
    return [
      {
        family: 'discount-curve',
        fit: curves.bootstrap(input.instruments, input.options),
        calibration: input,
        currency: 'USD',
      },
    ];
  },
  'fixed-income.readFittedModel': () => [{ artifact: persisted() }],
  'fixed-income.evaluateFittedModel': () => [
    { model: persisted(), at: { dates: ['2027-01-01', '2029-06-30'], measure: 'discount' } },
  ],
  'fixed-income.replayFittedModel': () => [
    { artifact: persisted(), limits: { maximumDifferences: 50 } },
  ],
  'fixed-income.compareFittedModels': () => [
    {
      baseline: persisted(),
      candidate: persisted(),
      tolerance: { absolute: 1e-9, relative: 1e-9 },
    },
  ],
  'fixed-income.fittedModelHoldout': () => [
    { family: 'discount-curve', calibration: calibration(), holdout: { indices: [2] } },
  ],
};
