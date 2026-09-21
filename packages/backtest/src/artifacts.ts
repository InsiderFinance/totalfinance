/**
 * `@totalfinance/backtest/artifacts` — Stage 4.6's reproducible run artifacts (spec
 * `docs/specs/portfolio-scale-backtesting.md`, Decision 8): a `crossSectionalBacktest` or
 * `crossSectionalBacktestGrid` result saved as an identified, immutable `AnalysisArtifact` with its
 * request (bulk row sets embedded or referenced by table handle, models by description), its run
 * hash, and the FC8 identity list; read back, replayed to a hash, and compared run to run.
 *
 * A subpath on purpose (never the package root, never the umbrella): a bundle that only backtests
 * must not pay for serialization.
 *
 * ```ts
 * import { crossSectionalBacktest } from '@totalfinance/backtest';
 * import { backtestRunArtifact, readBacktestRun, replayBacktestRun } from '@totalfinance/backtest/artifacts';
 *
 * const run = crossSectionalBacktest(request);
 * const artifact = backtestRunArtifact({ kind: 'cross-sectional', run, input: request, referenceRowSets: ['dataset.returns'] });
 * const { report } = readBacktestRun({ artifact });
 * replayBacktestRun({ artifact, referencedData: { 'dataset.returns': request.dataset.returns } }).matches; // true
 * ```
 */

export {
  BACKTEST_RUN_ARTIFACT_TYPE,
  BACKTEST_RUN_KINDS,
  BACKTEST_RUN_KIND_LIST,
  BACKTEST_RUN_LIMITS,
  backtestRunArtifact,
  compareBacktestRuns,
  readBacktestRun,
  replayBacktestRun,
} from './run-artifacts.js';
export type {
  BacktestHygieneBlock,
  BacktestRunArtifactInput,
  BacktestRunArtifactLimits,
  BacktestRunComparison,
  BacktestRunIdentity,
  BacktestRunInputs,
  BacktestRunKind,
  BacktestRunKindDescriptor,
  BacktestRunReplay,
  BacktestRunReport,
  BacktestRunResults,
  IdListSection,
  InputOf,
  MembershipSection,
  NamedDelta,
  ReadBacktestRunResult,
  RebalanceDelta,
  RecordedModels,
  ReplayModels,
  RunOf,
  VariationDelta,
} from './run-artifacts.js';
