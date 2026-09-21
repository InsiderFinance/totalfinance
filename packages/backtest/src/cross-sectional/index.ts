/**
 * `@totalfinance/backtest/cross-sectional` — point-in-time cross-sectional strategies (Stage 4.6, FC8
 * Decision 4). One verb, {@link crossSectionalBacktest}, over a returns dataset, a universe
 * history, one signal, a rebalance schedule, and a portfolio construction; every decision is a
 * `@totalfinance/research` call, every quantity `@totalfinance/portfolio`'s allocator, every fill a
 * `NormalizedFill` folded by the FC7 reducer, every performance number `@totalfinance/performance`.
 * `crossSectionalBacktestGrid` runs the cartesian product of declarative variations as independent
 * calls of the same function and composes the research-hygiene verdicts; the run artifacts live in
 * `@totalfinance/backtest/artifacts`.
 */

export { crossSectionalBacktest } from './engine.js';
export {
  CROSS_SECTIONAL_GRID_CEILING,
  CROSS_SECTIONAL_GRID_DEFAULT_MAXIMUM,
  crossSectionalBacktestGrid,
  requireCrossSectionalBacktestGridRequest,
} from './grid.js';
export type {
  CrossSectionalBacktestGridRequest,
  CrossSectionalBacktestGridResult,
  GridAssumptions,
  GridDiagnostics,
  GridHygiene,
  GridSelectionMetric,
  GridSummaryMetrics,
  GridVariation,
  GridVariationRow,
} from './grid.js';
export {
  CROSS_SECTIONAL_WINDOW_CEILING,
  crossSectionalPurgedFolds,
  crossSectionalWalkForward,
  requireCrossSectionalPurgedFoldsRequest,
  requireCrossSectionalWalkForwardRequest,
} from './folds.js';
export type {
  CrossSectionalOutOfSampleResult,
  CrossSectionalPurgedFoldsRequest,
  CrossSectionalWalkForwardRequest,
  OutOfSampleAssumptions,
  OutOfSampleDiagnostics,
  OutOfSampleHygiene,
  OutOfSampleWindowRow,
  SessionSpan,
} from './folds.js';
export {
  CROSS_SECTIONAL_POSITION_CEILING,
  CROSS_SECTIONAL_ROW_CEILING,
  requireCrossSectionalBacktestRequest,
} from './validate.js';
export type {
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
} from './types.js';
