/**
 * `@insiderfinance/totalfinance/volatility/artifacts` — Stage 4.5's fitted-model artifacts for every calibration this
 * package exports (spec `docs/specs/calibration-research-artifacts.md`, Decisions 1–3 and 5–9).
 *
 * A subpath on purpose (never the package root, never the umbrella): these verbs ride the Gate B
 * spine — canonical JSON, SHA-256 identity, envelope validation — and a compute bundle that only
 * calibrates must not pay for serialization. Import it beside the direct calibrator:
 *
 * ```ts
 * import { calibrateSsvi } from '@insiderfinance/totalfinance/volatility/ssvi';
 * import { fittedModelArtifact, readFittedModel, evaluateFittedModel } from '@insiderfinance/totalfinance/volatility/artifacts';
 * import { canonicalJsonOf, fromCanonicalJson } from '@insiderfinance/totalfinance/core/artifacts';
 *
 * const fit = calibrateSsvi(surface, { weight: 'vega' });                       // the direct call, unchanged
 * const artifact = fittedModelArtifact({ family: 'ssvi', fit, calibration: { surface, options: { weight: 'vega' } } });
 * const { report } = readFittedModel({ artifact: fromCanonicalJson(canonicalJsonOf(artifact)) });
 * evaluateFittedModel({ model: report, at: { logMoneyness: [-0.1, 0, 0.1], timeToExpiryYears: [0.5] } });
 * ```
 */

export {
  FITTED_MODEL_LIMITS,
  VOLATILITY_FITTED_MODEL_ARTIFACT_TYPE,
  compareFittedModels,
  evaluateFittedModel,
  fittedModelArtifact,
  fittedModelHoldout,
  fittedModelStability,
  readFittedModel,
  replayFittedModel,
  warmStartFrom,
} from './fitted-model-artifacts.js';
export type {
  FittedModelArtifactInput,
  FittedModelArtifactLimits,
  FittedModelComparison,
  FittedModelEvaluation,
  FittedModelHoldoutInput,
  FittedModelHoldoutReport,
  FittedModelHoldoutSelection,
  FittedModelReplay,
  FittedModelStabilityInput,
  FittedModelStabilityReport,
  ParameterDelta,
  ReadFittedModelResult,
  VolatilityFittedModelReport,
} from './fitted-model-artifacts.js';
export { FITTED_MODEL_FAMILIES, VOLATILITY_MODEL_FAMILIES } from './fitted-model-families.js';
export type {
  CalibrationOf,
  EvaluationOf,
  FitOf,
  FittedModelFamilyDescriptor,
  StoredCalibrationOf,
  VolatilityCalibrations,
  VolatilityEvaluations,
  VolatilityFits,
  VolatilityModelFamily,
  VolatilityStoredCalibrations,
  VolatilityWarmStarts,
  WarmStartOf,
} from './fitted-model-families.js';
