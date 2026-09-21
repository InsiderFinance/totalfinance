/**
 * `@totalfinance/fixed-income/artifacts` — Stage 4.5's fitted-model artifacts for the curve bootstraps
 * (spec `docs/specs/calibration-research-artifacts.md`, Decisions 1–3 and 5–9): discount,
 * projection, multi-curve, and hazard curves, stored as their data and restored exactly.
 *
 * A subpath on purpose (never the package root, never the umbrella): these verbs ride the Gate B
 * spine, and a bundle that only bootstraps must not pay for serialization.
 *
 * ```ts
 * import { curves, rateCurveFromYieldCurve } from '@totalfinance/fixed-income';
 * import { fittedModelArtifact, readFittedModel, evaluateFittedModel } from '@totalfinance/fixed-income/artifacts';
 *
 * const curve = curves.bootstrap(instruments, { referenceDate: '2026-01-01' });
 * const artifact = fittedModelArtifact({ family: 'discount-curve', fit: curve, calibration: { instruments, options: { referenceDate: '2026-01-01' } }, currency: 'USD' });
 * const { report } = readFittedModel({ artifact });
 * evaluateFittedModel({ model: report, at: { dates: ['2028-06-30'], measure: 'discount' } });
 * ```
 */

export {
  FIXED_INCOME_FITTED_MODEL_ARTIFACT_TYPE,
  compareFittedModels,
  evaluateFittedModel,
  fittedModelArtifact,
  fittedModelHoldout,
  readFittedModel,
  replayFittedModel,
} from './fitted-model-artifacts.js';
export type {
  CurveEvaluationDifference,
  CurveFittedModelReport,
  FittedModelArtifactInput,
  FittedModelArtifactLimits,
  FittedModelComparison,
  FittedModelEvaluation,
  FittedModelHoldoutInput,
  FittedModelHoldoutReport,
  FittedModelHoldoutSelection,
  FittedModelReplay,
  ParameterDelta,
  ReadFittedModelResult,
} from './fitted-model-artifacts.js';
export { CURVE_MODEL_FAMILIES, FITTED_MODEL_FAMILIES } from './fitted-model-families.js';
export type {
  CalibrationOf,
  CurveCalibrations,
  CurveEvaluations,
  CurveFits,
  CurveLiveFits,
  CurveModelFamily,
  CurveStoredCalibrations,
  EvaluationOf,
  FitOf,
  FittedModelFamilyDescriptor,
  LiveFitOf,
  StoredCalibrationOf,
  SurvivalCurveMeasure,
  YieldCurveMeasure,
} from './fitted-model-families.js';
export type { SurvivalCurveData, YieldCurveData, ZeroRateAtOrigin } from './curve-data.js';
