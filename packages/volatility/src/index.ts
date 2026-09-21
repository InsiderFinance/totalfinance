/**
 * `@totalfinance/volatility` — implied-volatility surfaces, skew/smile metrics, IV rank/percentile, and
 * event-volatility analytics. Browser-safe; builds on `@totalfinance/options` IV solving and
 * `@totalfinance/math` interpolation.
 *
 * Consumes a chain as `OptionQuote[]` from `@totalfinance/core` (re-use the canonical market-data type).
 * Surfaces come in six flavours — non-parametric `raw`/`interpolated`/`smoothed`, parametric
 * `svi`/`sabr` (per expiry), and a globally-calibrated `heston` — plus static no-arbitrage diagnostics,
 * skew + term structure, IV-rank, and event-vol facades.
 */

export { volatilitySurface, VolatilitySurface, SURFACE_SCHEMA_VERSION } from './surface.js';
export type {
  SurfaceModel,
  SurfaceMarket,
  SurfaceConfig,
  SurfaceSlice,
  SurfacePoint,
  SurfaceLookup,
  SurfaceRow,
  SurfaceShock,
  VolatilitySurfaceSnapshot,
} from './surface.js';

// Parametric smile calibration (spec §10.1).
// SVI evaluators/kernels live on '@totalfinance/volatility/svi' (C5 kernels-off-roots).
export { calibrateSvi } from './svi.js';
export type {
  SVIParameters,
  SVICalibrationOptions,
  SVICalibrationResult,
  SVISmileInput,
  SVIWarmStart,
} from './svi.js';
// Volatility-surface PCA — the level/slope/curvature modes of surface motion over time.
export { surfacePCA, surfacePcaScenarios } from './surface-pca.js';
export type {
  SurfacePcaInput,
  SurfaceMode,
  SurfacePcaResult,
  SurfacePcaScenarioInput,
  SurfaceScenario,
  SurfacePcaScenarios,
} from './surface-pca.js';
// Sticky-strike vs sticky-delta regime measurement (complements minimumVarianceDelta).
export { stickyRegime } from './sticky-regime.js';
export type { StickyRegimeInput, StickyRegime } from './sticky-regime.js';
// SSVI — Gatheral–Jacquier arbitrage-free surface SVI (calendar-arb-free by construction).
// SSVI evaluators live on '@totalfinance/volatility/ssvi' (C5 kernels-off-roots).
export { calibrateSsvi } from './ssvi.js';
export type {
  SSVIParameters,
  SSVIPhi,
  SSVISliceInput,
  SSVICalibrationInput,
  SSVICalibrationOptions,
  SSVIArbitrage,
  SSVICalibration,
} from './ssvi.js';
// eSSVI — SSVI extended with a per-maturity skew ρ(θ) (a strict superset of SSVI).
// eSSVI evaluators live on '@totalfinance/volatility/essvi' (C5 kernels-off-roots).
export { calibrateEssvi } from './essvi.js';
export type {
  ESSVIParameters,
  ESSVIArbitrage,
  ESSVISliceInput,
  ESSVICalibrationInput,
  ESSVICalibrationOptions,
  ESSVICalibration,
} from './essvi.js';
export { calibrateSabrSmile } from './sabr.js';
export type { SABRCalibrationOptions, SABRCalibrationResult, SABRSmileInput } from './sabr.js';
// Swaption cube — SABR-on-rates: per-node SABR calibration + bilinear (expiry×tenor) interpolation.
export { swaptionCube, swaptionCubeVolatility } from './swaption-cube.js';
export type {
  SwaptionCubeNode,
  SwaptionCubeInput,
  CalibratedSwaptionNode,
  SwaptionCube,
  SwaptionCubeVolatilityQuery,
  SwaptionCubeVolatilityResult,
} from './swaption-cube.js';
export { calibrateHestonSurface } from './heston-surface.js';
export type {
  HestonSurfaceFit,
  HestonSurfaceTarget,
  HestonSurfaceMarket,
} from './heston-surface.js';

// Cross-expiry term structure (spec §10.2).
export { atmTermStructure, forwardVolatility, calendarSkew, forwardSkew } from './term.js';
export type {
  AtmTermPoint,
  AtmTermStructure,
  ForwardVolatilityAssumptions,
  ForwardVolatilityFacade,
  CalendarSkewAssumptions,
  CalendarSkewFacade,
  ForwardSkewAssumptions,
  ForwardSkewFacade,
} from './term.js';

// Model-free analytics (spec §10): Breeden–Litzenberger probabilities, vol cone, variance-swap vol.
export { riskNeutralDistribution, volatilityCone, varianceSwapRate } from './analytics.js';
export type {
  RiskNeutralOptions,
  RiskNeutralDistribution,
  VolatilityConeWindow,
  VolatilityConeAssumptions,
  VolatilityConeFacade,
  VarianceSwapResult,
} from './analytics.js';

// §10.x VIX-style model-free variance index + VRP term structure (chain → constant-maturity vol).
export { varianceIndex, varianceRiskPremiumTermStructure } from './variance-index.js';
export type {
  VarianceIndexOptions,
  ExpiryVariance,
  VarianceIndexResult,
  VarianceRiskPremiumTermStructureOptions,
  VarianceRiskPremiumPoint,
  VarianceRiskPremiumTermStructureResult,
} from './variance-index.js';

// §10.3 Earnings / event-vol modeling (term-structure fit + implied-vs-realized calibration).
export {
  calibrateEventVolatility,
  calibrateEventMove,
  eventVolatilityAtExpiry,
} from './earnings.js';
export type {
  AtmVolatilityPoint,
  FitEventVolatilityOptions,
  FittedExpiry,
  EventVolatilityCalibration,
  EventMoveObservation,
  CalibratedEvent,
  EventMoveCalibration,
  EventVolatilityAtExpiryResult,
  EventVolatilityAtExpiryRow,
} from './earnings.js';

// §10.x Minimum-variance (smile-adjusted) delta — the hedge ratio that accounts for vol–spot co-movement.
export { minimumVarianceDelta } from './min-variance-delta.js';
export type {
  MinimumVarianceDeltaOptions,
  MinimumVarianceDeltaResult,
} from './min-variance-delta.js';

// §10.x SABR Bartlett (minimum-variance) delta & vega — the model-consistent hedge under correlated SABR
// forward/vol dynamics (the SABR realization of `minimumVarianceDelta`).
export { sabrBartlettGreeks } from './sabr-delta.js';
export type { SabrBartlettGreeks, SabrBartlettOptions } from './sabr-delta.js';

// §10.x Empirical vol–spot β (the leverage effect) — the regression of IV changes on spot changes; the
// empirical `∂σ/∂S` that `minimumVarianceDelta({ volatilitySpotBeta })` consumes.
export { estimateVolatilitySpotBeta } from './volatility-spot-beta.js';
export type { VolatilitySpotBeta, VolatilitySpotBetaInput } from './volatility-spot-beta.js';

// §10.x SKEW-style tail-risk index — model-free risk-neutral skewness / excess kurtosis from the chain.
export { tailRiskIndex } from './tail-risk.js';
export type { TailRiskOptions, ExpiryTailRisk, TailRiskResult } from './tail-risk.js';

// §10.1 Dupire local-volatility surface fitting (derived from the implied surface).
export { localVolatilitySurface, surfaceLocalVolatility } from './local-volatility.js';
export type {
  LocalVolatilitySurface,
  DupireOptions,
  LocalVolatilityFunction,
  LocalVolatilityGridSpecification,
  LocalVolatilityMarket,
} from './local-volatility.js';

// Static no-arbitrage diagnostics (spec §10.1).
export {
  surfaceArbitrageReport,
  arbitrageReport,
  checkCalendar,
  checkButterfly,
} from './arbitrage.js';
export type {
  ArbitrageSlice,
  ArbitrageKind,
  ArbitrageViolation,
  ArbitrageReport,
  ArbitrageCheckOptions,
  ButterflyCheckOptions,
  CalendarCheckOptions,
} from './arbitrage.js';

export { skew } from './skew.js';
export type {
  SkewMarket,
  SkewConfig,
  SkewMetrics,
  SkewResult,
  RiskReversalConvention,
} from './skew.js';

// Observed vendor-IV/delta sampling, deliberately separate from fitted/model-derived skew.
export { observedSkew } from './observed-skew.js';
export type {
  ObservedSkewConfig,
  ObservedSkewInput,
  ObservedSkewUnavailableReason,
  ObservedSkewObservation,
  ObservedSkewAtm,
  ObservedSkewWing,
  ObservedSkewSmilePoint,
  ObservedSkewMetrics,
  ObservedSkewAssumptions,
  ObservedSkewResult,
} from './observed-skew.js';

// The scalar-tier estimates are standard `Computed` envelopes (DX1): warnings live under
// `diagnostics.warnings`; the one-envelope law holds: results are plain `Computed`.
export { RISK_NEUTRAL_ESTIMATE } from './estimate.js';

export {
  impliedVolatilityRank,
  impliedVolatilityPercentile,
  impliedVolatilityStatistics,
} from './metrics.js';
export type { ImpliedVolatilityStatistics } from './metrics.js';

export {
  expectedMoveFromImpliedVolatility,
  expectedMoveFromStraddle,
  probabilityInTheMoney,
  probabilityOfTouch,
  realizedImpliedSpread,
  varianceRiskPremium,
  eventVolatilityDecomposition,
  eventStrippedVolatility,
} from './event.js';
export type {
  ExpectedMove,
  EventVolatilityDecomposition,
  ExpectedMoveImpliedVolatilityInput,
  ExpectedMoveStraddleInput,
  ProbabilityInTheMoneyInput,
  ProbabilityOfTouchInput,
} from './event.js';

// Variance forecasting (spec §10.2): GARCH(1,1) MLE + HAR-RV (Corsi) OLS.
export { fitGarch, garchForecast, fitHarRv, harRvForecast } from './forecast.js';
export type {
  GarchFit,
  GarchFitOptions,
  GarchForecast,
  GarchForecastOptions,
  HarRvFit,
  HarRvCoefficients,
  HarRvOptions,
  HarRvForecastAssumptions,
  HarRvForecastFacade,
} from './forecast.js';

// Risk reversal & butterfly — the FX/crypto smile-quoting decomposition and its exact inverse.
export { riskReversalButterfly, smileFromQuotes } from './risk-reversal.js';
export type {
  RiskReversalButterflyInput,
  RiskReversalButterfly,
  SmileFromQuotesInput,
  SmileAnchors,
} from './risk-reversal.js';

// Vanna–volga — the FX/crypto smile constructed from ATM + 25Δ RR/BF (reprices the three pillars exactly),
// its Castagna–Mercurio closed-form approximation, the risk-neutral density it implies, the 5-pillar
// (ATM + 25Δ + 10Δ) exact-repricing smile, and the risk-neutral density that 5-pillar smile implies.
// The evaluator/density kernels live on '@totalfinance/volatility/vanna-volga' (C5 kernels-off-roots).
export { calibrateVannaVolga, calibrateVannaVolga5 } from './vanna-volga.js';
export type {
  VannaVolgaInput,
  VannaVolgaSmile,
  VannaVolgaApproximationInput,
  VannaVolgaApproximationSmile,
  VannaVolgaDensityInput,
  VannaVolgaDensity,
  VannaVolga5Input,
  VannaVolga5Pillar,
  VannaVolga5Smile,
  VannaVolga5DensityInput,
  VannaVolga5Density,
} from './vanna-volga.js';
