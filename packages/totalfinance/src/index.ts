/**
 * `totalfinance` — the umbrella package (spec DX4.1; topology finalized in alignment-spec P3.3).
 *
 * One install, ONE grammar: every domain is a namespace, and only the flagship options-pricing
 * gestures are hoisted to the top level. There is NO new API here — everything comes from a scoped
 * `@totalfinance/*` package, and the lean deep entrypoints (`totalfinance/options`, `totalfinance/technical-analysis`,
 * `@totalfinance/options/black-scholes`, …) remain the tree-shakeable path.
 *
 * ```ts
 * import { blackScholes, option, market, engines, technicalAnalysis, volatility } from 'totalfinance';
 *
 * blackScholes.price({ spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.05, volatility: 0.2, type: 'call' });
 * const c = option.usEquityCall({ underlying: 'AAPL', strike: 200, expiry: '2026-09-18' });
 * option.price({ contract: c, market: market({ spot: 195, riskFreeRate: 0.045, volatility: 0.24, asOf: '2026-07-20T10:30:00-04:00' }) });
 * technicalAnalysis.rsi.explain(closes, { period: 14 });
 * volatility.expectedMoveFromImpliedVolatility({ spot: 100, impliedVolatility: 0.2, timeToExpiryYears: 0.25 });
 * ```
 *
 * The flagship hoist is CURATED (spec §5.2): `blackScholes` (the beginner facade), `option` (contracts + pro
 * pricing), `market` (the market snapshot builder), `engines` (pricing-engine selection), and
 * `impliedVolatility` (the single-shot IV facade). Everything else on the options root — kernels,
 * exotics families, batch APIs — lives under the `options` namespace or its expert subpaths, so the
 * umbrella root stays a teachable surface instead of a 700-name flood.
 */

// Flagship hoist — the five ratified names (spec §5.2), nothing else.
export { blackScholes, option, market, engines, impliedVolatility } from '@totalfinance/options';

// Every domain is a namespace. `import { volatility } from 'totalfinance'` and
// `import * as volatility from 'totalfinance/volatility'` see the same surface.
// 3B.2 nameability: the parameter types of the callables this umbrella exposes, re-exported from
// the subpath that owns each one — `import type { SabrPriceRequest } from 'totalfinance'` must work
// with only the ONE package the consumer installed.
export type { SchemaCheckContext } from '@totalfinance/core/schema';
export type {
  BoxSpreadRateInput,
  ImpliedBorrowInput,
  ImpliedDividendYieldInput,
  ImpliedForwardInput,
} from '@totalfinance/options/parity';
export type {
  HestonCosineExpansionPriceInput,
  HestonMonteCarloEstimateInput,
  HestonPriceMonteCarloRequest,
  HestonPriceRequest,
} from '@totalfinance/options/heston';
export type {
  DupireLocalVolatilityInput,
  LocalVolatilityMonteCarloEstimateInput,
  LocalVolatilityPriceMonteCarloRequest,
} from '@totalfinance/options/local-volatility';
export type {
  SabrMonteCarloEstimateInput,
  SabrPriceMonteCarloRequest,
  SabrPriceRequest,
  SabrVolatilityRequest,
} from '@totalfinance/options/sabr';
export type {
  CdsBasisInput,
  CreditTriangleHazardInput,
  FlatHazardInput,
} from '@totalfinance/fixed-income/credit';
export type { FlatCurveInput } from '@totalfinance/fixed-income/curves';
export type { ExposureInput } from '@totalfinance/structure/exposure';
export type { GarchForecastInput } from '@totalfinance/volatility/forecast';
export type { HestonSurfaceCalibrationInput } from '@totalfinance/volatility/heston-surface';
export type { ImpliedVolatilityMetricInput } from '@totalfinance/volatility/metrics';
export type {
  LocalVolatilitySurfaceInput,
  SurfaceLocalVolatilityInput,
} from '@totalfinance/volatility/local-volatility';
export type { RealizedImpliedInput } from '@totalfinance/volatility/event';
export type { SabrBartlettGreeksInput } from '@totalfinance/volatility/sabr-delta';
export type { SkewInput } from '@totalfinance/volatility/skew';
export type { VolatilitySurfaceInput } from '@totalfinance/volatility/surface';
export type { KellyInput, MaxSharpeInput, MeanVarianceInput } from '@totalfinance/risk/optimize';
export type {
  MonteCarloPortfolioVaRInput,
  ParametricPortfolioVaRInput,
} from '@totalfinance/risk/value-at-risk';
export type { ScenarioGridInput } from '@totalfinance/risk/scenario';
export type { AlignToBarsInput } from '@totalfinance/technical-analysis/resample';
export type { DivergencesInput } from '@totalfinance/technical-analysis/divergence';
export type {
  FibExtensionInput,
  OpeningRangeParameters,
} from '@totalfinance/technical-analysis/price-action';
export type { MavpInput } from '@totalfinance/technical-analysis/statistics';
export * as options from '@totalfinance/options';
export * as core from '@totalfinance/core';
export * as math from '@totalfinance/math';
export * as crypto from '@totalfinance/crypto';
export * as calendars from '@totalfinance/calendars';
export * as fundamentals from '@totalfinance/fundamentals';
export * as valuation from '@totalfinance/valuation';
export * as research from '@totalfinance/research';
export * as foreignExchange from '@totalfinance/foreign-exchange';
export * as commodities from '@totalfinance/commodities';
export * as portfolio from '@totalfinance/portfolio';
export * as scenarios from '@totalfinance/scenarios';
export * as performance from '@totalfinance/performance';
export * as risk from '@totalfinance/risk';
export * as backtest from '@totalfinance/backtest';
export * as volatility from '@totalfinance/volatility';
export * as structure from '@totalfinance/structure';
export * as technicalAnalysis from '@totalfinance/technical-analysis';
export * as strategy from '@totalfinance/strategy';
export * as fixedIncome from '@totalfinance/fixed-income';
