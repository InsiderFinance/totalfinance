/**
 * `@insiderfinance/totalfinance/backtest/portfolio` — the ledger-backed multi-asset simulator (Stage 4.6, FC8
 * Decision 6). `portfolioBacktest` folds every fill, flow, lifecycle fact, and liquidation through
 * `@insiderfinance/totalfinance/portfolio`'s reducer; the eight built-in instrument adapters (and a caller's own,
 * proven by `assertInstrumentAdapterConformance`) say how each kind marks, what lifecycle facts it
 * emits, and how its fills settle.
 */

export { createPortfolioStepper, portfolioBacktest } from './engine.js';
export {
  accruedFromTerms,
  adapterFor,
  assertInstrumentAdapterConformance,
  instrumentAdapters,
  splitShares,
} from './adapters.js';
export {
  PORTFOLIO_CALENDARS,
  PORTFOLIO_INSTRUMENT_CEILING,
  PORTFOLIO_ROW_CEILING,
  requireAccountingPolicy,
  requireInstrumentSpecification,
  requirePortfolioBacktestRequest,
  requirePortfolioMarketData,
  requirePortfolioStepperRequest,
} from './validate.js';
export type {
  AccountingPolicy,
  AssetClass,
  CouponRecord,
  CouponTerms,
  DatedCurrencyPairQuote,
  DividendRecord,
  ExternalFlowRecord,
  FillTerms,
  ForwardRateRecord,
  ForwardTerms,
  FundingRateRecord,
  InstrumentAdapter,
  InstrumentKind,
  InstrumentSpecification,
  LatestObservations,
  LifecycleFacts,
  LifecycleInput,
  LiquidationRow,
  MarkInput,
  MarkOutcome,
  OrderRecord,
  OrderSource,
  PortfolioBacktestAssumptions,
  PortfolioBacktestDiagnostics,
  PortfolioBacktestRequest,
  PortfolioBacktestResult,
  PortfolioMarketData,
  PortfolioStepFrame,
  PortfolioStepper,
  PortfolioStepperRequest,
  PortfolioStrategy,
  RebalanceSchedule,
  RejectionRow,
  RollTerms,
  SessionContext,
  SessionPosition,
} from './types.js';
