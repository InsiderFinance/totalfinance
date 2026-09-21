/**
 * `@totalfinance/performance` — return and performance metrics. Depends only on `@totalfinance/core` and
 * `@totalfinance/math`; importing `performance.sharpe` never drags in option pricing or other heavy
 * packages (spec §15.1).
 */

import { maxDrawdown, maxDrawdownFromReturns, underwater } from './drawdown.js';
import { annualizedReturn, calmar, sortino } from './metrics.js';
import { cumulativeReturns, equityCurve, logReturns, simpleReturns } from './returns.js';
import { annualizedVolatility, sharpe } from './sharpe.js';
import { analyze } from './analyze.js';
import { expectancy, hitRate, omega, profitFactor, winLossStatistics } from './ratios.js';
import { alpha, beta, informationRatio, trackingError, treynor } from './relative.js';
import { exposure, turnover } from './activity.js';
import { rollingReturn, rollingSharpe, rollingVolatility } from './rolling.js';

export {
  simpleReturns,
  logReturns,
  cumulativeReturns,
  equityCurve,
  annualizedVolatility,
  annualizedReturn,
  maxDrawdown,
  maxDrawdownFromReturns,
  underwater,
  analyze,
  omega,
  hitRate,
  profitFactor,
  expectancy,
  winLossStatistics,
  beta,
  alpha,
  trackingError,
  informationRatio,
  turnover,
  exposure,
  rollingVolatility,
  rollingSharpe,
  rollingReturn,
};

// Bare canonical ratio names (DX2.3): the form users type first, matching `performance.sharpe(...)`.
// C (hygiene): the suffixed `sharpeRatio`/`sortinoRatio`/`calmarRatio`/`treynorRatio` aliases are
// gone — one name per ratio; `informationRatio` stays descriptive (there is no bare form of it).
export { sharpe, sortino, calmar, treynor };

export * from './flow-aware.js';
export { sectorPerformance, sectorPerformanceSnapshot } from './sector-performance.js';
export type {
  SectorPerformanceMember,
  SectorPerformanceMemberResult,
  SectorPerformanceInput,
  SectorPerformanceSectorResult,
  SectorPerformanceAssumptions,
  SectorPerformanceReport,
  SectorPerformanceUniverseMember,
  SectorPerformanceCompletedSession,
  SectorClassificationObservation,
  SectorPerformanceCloseObservation,
  SectorPerformanceCutoffs,
  SectorPerformanceTaxonomy,
  SectorPerformanceSnapshotInput,
  SectorPerformanceSnapshotAssumptions,
  SectorPerformanceSessionLineage,
  SectorPerformanceClassificationLineage,
  SectorPerformanceAssignedClassificationLineage,
  SectorPerformanceCloseLineage,
  SectorPerformanceSnapshotMemberResult,
  SectorPerformanceExclusionReason,
  SectorPerformanceExclusion,
  SectorPerformanceSnapshotSectorResult,
  SectorPerformanceBlocker,
  SectorPerformanceReasonCount,
  SectorPerformanceSnapshotDiagnostics,
  SectorPerformanceSnapshotReport,
} from './sector-performance.js';

export type { SharpeOptions, AnnualizationOptions } from './sharpe.js';
export type { SortinoOptions } from './metrics.js';
export type { DrawdownResult } from './drawdown.js';
export type { PerformanceSummary, AnalyzeOptions, AnalyzeInput } from './analyze.js';
export type { WinLossStatistics } from './ratios.js';
export type { ExposureResult } from './activity.js';

// The eponymous `performance` namespace object was DELETED (P3.3): it duplicated the module's
// own exports one level down (umbrella users saw `performance.performance`). Use the module namespace:
// `import * as performance from '@totalfinance/performance'`.
