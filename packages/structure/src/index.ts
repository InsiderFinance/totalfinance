/**
 * `@insiderfinance/totalfinance/structure` — options market-structure analytics: dealer-positioning exposure
 * (GEX/DEX/vega/vanna/charm), levels (walls, zero-gamma, max pain, pin risk), scenario maps, and
 * options flow (aggressor/sweep/block/spread).
 *
 * Every positioning estimate echoes its position-sign conventions in `assumptions` and carries its
 * model limitations as `model.limitation` entries in `diagnostics.warnings` (R2). These analytics
 * infer positioning from open interest, prices, and conventions — they do not know true dealer
 * books. Consumes the canonical `OptionQuote[]` / `OptionTrade[]` from `@insiderfinance/totalfinance/core`.
 */

export {
  exposure,
  ExposureProfile,
  gammaExposure,
  deltaExposure,
  vegaExposure,
  thetaExposure,
  vannaExposure,
  charmExposure,
  vommaExposure,
  speedExposure,
  colorExposure,
} from './exposure.js';
export { exposureFromGreeks } from './supplied-exposure.js';
export type {
  SuppliedExposureGreeks,
  SuppliedExposureQuote,
  SuppliedExposurePositionConvention,
  SuppliedExposureConfig,
  SuppliedExposureMarket,
  SuppliedExposureInput,
  SuppliedExposureRequest,
  SuppliedExposureExclusion,
  SuppliedExposureContribution,
  SuppliedExposureTotals,
  SuppliedExposureAssumptions,
  SuppliedExposureReport,
  SuppliedExposureMetric,
  SuppliedExposureRequestGreeks,
  SuppliedExposureRequestQuote,
  SuppliedExposureRequestConfig,
  SuppliedExposureTotalsFor,
  SuppliedExposureContributionFor,
  SuppliedExposureAssumptionsFor,
  GuaranteedSuppliedExposureMetrics,
  PossibleSuppliedExposureMetrics,
} from './supplied-exposure.js';
export type {
  ExposureConvention,
  ExposureMarket,
  ExposureConfig,
  ExposureInput,
  ExposureShortcutInput,
  ExposureMetric,
  GuaranteedExposureMetrics,
  PossibleExposureMetrics,
  GammaUnit,
  ContractExposure,
  ContractExposureRow,
  ExposureTotals,
  ExposureAggregate,
  AtSpotExposure,
  GexSplit,
  StrikeRow,
  ExpiryRow,
  Levels,
  NetDrift,
  ScenarioMapOptions,
  ScenarioMap,
  ScenarioCell,
  DefaultScenarioMetric,
} from './exposure.js';

export { flow, FlowAnalysis, deltaAdjustedPremium, unusualness } from './flow.js';
export type {
  AggressorSide,
  FlowClassificationSource,
  FlowClassificationProvenance,
  OpenCloseEstimate,
  FlowOptions,
  ClassifiedTrade,
  Sweep,
  Spread,
  FlowGroupKey,
  FlowGroup,
  CallPutPremium,
  RankOptions,
  RankByKey,
  DirectionalFlowTrade,
  DeltaAdjustedPremium,
  Unusualness,
} from './flow.js';

/** Raw session trading-premium drift, distinct from ExposureProfile.netDrift (dealer hedging). */
export { optionFlowDrift } from './option-flow-drift.js';
export type {
  OptionFlowDriftTrade,
  OptionFlowDriftSession,
  OptionFlowPriceOverlay,
  OptionFlowDriftConfig,
  OptionFlowDriftInput,
  OptionFlowVolumeConfirmation,
  OptionFlowDriftHeuristic,
  OptionFlowDriftTotals,
  OptionFlowDriftPrint,
  OptionFlowDriftPrice,
  OptionFlowDriftBucket,
  OptionFlowDriftValue,
  OptionFlowDriftAssumptions,
  OptionFlowDriftResult,
} from './option-flow-drift.js';
