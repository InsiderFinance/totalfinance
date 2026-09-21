/**
 * `@totalfinance/backtest` — a vectorized research engine and an event-driven execution simulator
 * (spec §16). Both return the same `BacktestResult` with an `assumptions` echo (capital, fills,
 * costs, slippage, calendar — dx §2.5) and **implementation-risk diagnostics** (look-ahead,
 * alignment) so a backtest's hidden modelling assumptions are visible.
 *
 * Browser-safe; depends only on `@totalfinance/core`, `@totalfinance/math`, and `@totalfinance/performance`.
 */

export { vectorized, equityToReturns } from './vectorized.js';
export type { VectorizedOptions, RebalanceRule } from './vectorized.js';

export { gtSeries, ltSeries, crossOverSeries, crossUnderSeries, latchSeries } from './signals.js';
export type { EnvelopeSignal, SeriesSignal } from './signals.js';

// The eponymous `backtest` namespace object was DELETED (P3.3): it duplicated the module's
// own exports one level down (umbrella users saw `backtest.backtest`). Use the module namespace:
// `import * as backtest from '@totalfinance/backtest'`.
export { SimulatedBroker, brokers } from './broker.js';
// B6 — one order vocabulary: the side/type/time-in-force names are core's, re-exported here.
export type { OrderSide, OrderType, TimeInForce } from '@totalfinance/core';
export type {
  OrderRequest,
  Order,
  OrderStatus,
  CorporateAction,
  BrokerConfig,
  OptionContractSpecification,
  OptionSettlement,
  OptionSettlementStyle,
  ExerciseOptionInput,
} from './broker.js';

export { eventDriven, crossOver, crossUnder } from './event-driven.js';
export type {
  EventDrivenOptions,
  StrategyContext,
  TradeOptions,
  Indicator,
  IndicatorHandle,
  BarField,
} from './event-driven.js';

export { fees, slippage, borrow } from './costs.js';
export type { CostModel, SlippageModel, BorrowModel } from './costs.js';

export { walkForward } from './walk-forward.js';
export type {
  WalkForwardOptions,
  WalkForwardWindow,
  WalkForwardWindowResult,
  WalkForwardResult,
} from './walk-forward.js';

export { tearSheet, returnStatistics, attribution, monteCarloResample } from './tearsheet.js';
export type {
  TearSheet,
  TearSheetOptions,
  TradeStatistics,
  ReturnStatistics,
  ReturnStatisticsReport,
  SymbolAttribution,
  AttributionReport,
  MonteCarloResampleResult,
  MonteCarloResampleReport,
} from './tearsheet.js';

export { checkDataAlignment } from './diagnostics.js';

export { BENCHMARK_FIXTURE_VERSION, toEquityPoints } from './types.js';
export type {
  Bar,
  BacktestResult,
  BacktestAssumptions,
  EquityPoint,
  ImplementationRisk,
  Trade,
  Position,
} from './types.js';

// Stage 4.6 (FC8) — the point-in-time cross-sectional engine is the package's first-call verb; its
// grammar lives on `./cross-sectional` and the same function object is re-exported here.
export {
  crossSectionalBacktest,
  crossSectionalBacktestGrid,
  crossSectionalPurgedFolds,
  crossSectionalWalkForward,
} from './cross-sectional/index.js';
// Stage 4.6 slice 5 (FC8) — the ledger-backed multi-asset simulator; its grammar lives on `./portfolio`.
export { createPortfolioStepper, portfolioBacktest } from './portfolio/index.js';
// Stage 7B.1 (AT4) — the trading-agent environment over the portfolio engine; its grammar lives on `./environment`.
export {
  agentBaselines,
  createTradingEnvironment,
  environmentEpisode,
  runAgentBench,
  runEnvironmentEpisode,
  scoreAgentTranscript,
} from './environment/index.js';
export type {
  EnvironmentAction,
  EnvironmentObservation,
  AgentBenchReport,
  AgentTranscriptScore,
  EnvironmentEpisode,
  EnvironmentEpisodeInput,
  EnvironmentEpisodeResult,
  EnvironmentStepResult,
  TradingEnvironment,
  TradingEnvironmentDefinition,
} from './environment/index.js';
export type {
  PortfolioBacktestRequest,
  PortfolioBacktestResult,
  PortfolioStepper,
  PortfolioStepperRequest,
  PortfolioStepFrame,
  InstrumentSpecification,
  InstrumentAdapter,
} from './portfolio/index.js';
export type {
  CrossSectionalBacktestGridRequest,
  CrossSectionalBacktestGridResult,
  GridVariation,
  GridVariationRow,
  CrossSectionalOutOfSampleResult,
  CrossSectionalPurgedFoldsRequest,
  CrossSectionalWalkForwardRequest,
  OutOfSampleAssumptions,
  OutOfSampleDiagnostics,
  OutOfSampleHygiene,
  OutOfSampleWindowRow,
  SessionSpan,
  AttributionRow,
  BenchmarkComparison,
  CrossSectionalAssumptions,
  CrossSectionalAttribution,
  CrossSectionalBacktestRequest,
  CrossSectionalBacktestResult,
  CrossSectionalDataset,
  CrossSectionalDiagnostics,
  CrossSectionalSignal,
  HoldingReason,
  HoldingRow,
  Neutrality,
  PortfolioConstruction,
  RebalanceFrequency,
  RebalanceGoal,
  RebalanceRow,
  RebalanceSchedule,
  ShortSideSelection,
  SideSelection,
  SignalContext,
  SignalRow,
  WeightContext,
  WeightingMethod,
} from './cross-sectional/index.js';
