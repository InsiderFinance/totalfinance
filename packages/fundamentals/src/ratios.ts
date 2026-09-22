/**
 * `@insiderfinance/totalfinance/fundamentals/ratios` — the direct ratio operations (FC2). Every head returns a
 * decimal ratio or `null`, and `.explain()` states the formula, the numerator and denominator it
 * actually used, every disclosed derivation, and the reason behind any `null`.
 */

export type {
  DayMetricRatioInput,
  DebtServiceRatioInput,
  EnterpriseMultipleRatioInput,
  InvestedCapitalRatioInput,
  MarketMultipleRatioInput,
  MarketObservation,
  PairRatioInput,
  RatioCategory,
  RatioFacade,
  RatioInput,
  RatioPeriodIdentity,
  RatioReport,
  SingleStatementRatioInput,
} from './ratio-internals.js';
export { requireMarketObservation } from './ratio-internals.js';
export * from './ratio-heads.js';
