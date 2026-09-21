/**
 * Path-aware resource-control semantics shared by the magnitude and resource-safety mutants.
 *
 * A key-only regex could not distinguish `horizonPeriods` used as a continuous √time scale from the
 * same spelling used to size three forecast arrays, and its small vocabulary omitted `paths`,
 * `samples`, `iterations`, `window`, `lags`, `folds`, and `populationSize`. This classifier receives
 * the public head and complete fixture path, keeps the genuine continuous coordinates explicit, and
 * gives every workload coordinate one library-wide outer ceiling. Operation-specific caps remain
 * lower and more informative; the common ceiling guarantees that 2^32 is always a typed refusal,
 * never a raw allocation error or a multi-billion-iteration request.
 */

export const RESOURCE_SAFETY_CEILING = 2 ** 32;

export interface NumericCoordinate {
  head: string;
  path: readonly (string | number)[];
  key: string;
}

export interface NumericCoordinatePolicy {
  kind: 'resource' | 'magnitude';
  rationale: string;
  /** Every resource control must refuse this value; its own documented cap may be much lower. */
  safetyCeiling?: number;
}

const CONTINUOUS_HORIZON_HEADS = new Set([
  'risk.costAwareKelly',
  'risk.kellyBet',
  'risk.portfolioVaR',
  'risk.valueAtRiskReport',
  'strategy.optimizeStrategy',
]);

const EXACT_RESOURCE_COORDINATES = new Set([
  'risk.meanExcessPlot|gridSize',
  'options.americanExercise|boundaryPoints',
  'options.asian.geometricPrice|averagingPoints',
  'options.asian.monteCarloPrice|averagingPoints',
  'technical-analysis.RainbowMovingAverageStream.constructor|levels',
  'technical-analysis.rainbowMovingAverage|levels',
  'technical-analysis.rainbowMovingAverage.explain|levels',
  'technical-analysis.rainbowMovingAverage.stream|levels',
]);

/** TA convention names whose values are lookback counts even though the key omits period/window. */
const TECHNICAL_ANALYSIS_LOOKBACK_KEYS = new Set([
  'bars',
  'base',
  'conversion',
  'cycle',
  'displacement',
  'drift',
  'fast',
  'lines',
  'longRoc',
  'medium',
  'resetEvery',
  'reversal',
  'runLength',
  'shortRoc',
  'signal',
  'slow',
  'smooth',
  'smoothK',
  'spanB',
  'strength',
  'wma',
]);

/** `long`/`short` are period aliases only on these oscillators (Elder Thermometer uses thresholds). */
const TECHNICAL_ANALYSIS_LONG_SHORT_LOOKBACK_HEADS = new Set([
  'technical-analysis.SmiErgodicStream.constructor',
  'technical-analysis.TsiStream.constructor',
  'technical-analysis.UltimateStream.constructor',
  'technical-analysis.smiErgodic',
  'technical-analysis.smiErgodic.explain',
  'technical-analysis.smiErgodic.stream',
  'technical-analysis.tsi',
  'technical-analysis.tsi.explain',
  'technical-analysis.tsi.stream',
  'technical-analysis.ultimateOscillator',
  'technical-analysis.ultimateOscillator.explain',
  'technical-analysis.ultimateOscillator.stream',
]);

/** Numeric values carried inside an input artifact that describe prior work; they do not size this call. */
const DATA_BOUNDED_OR_METADATA_COORDINATES = new Map<string, string>([
  [
    'research.screenUniverse|0.limit',
    'the screen filters and sorts the supplied universe before slicing, so observation count bounds all work regardless of the requested page size',
  ],
  [
    'structure.FlowAnalysis#rank|1.limit',
    'rank filters and sorts the supplied groups before slicing, so group count bounds all work regardless of the requested result limit',
  ],
  [
    'technical-analysis.searchIndicators|0.limit',
    'searchIndicators filters the fixed indicator registry before slicing; the registry size, not the requested page size, bounds work and output',
  ],
  [
    'technical-analysis.searchIndicators|0.offset',
    'searchIndicators slices the fixed indicator registry; a large safe offset performs no proportional iteration or allocation',
  ],
  [
    'technical-analysis.kagi|1.reversal',
    'Kagi reversal is a continuous absolute-price or percentage threshold; bar count bounds the single-pass calculation',
  ],
  [
    'technical-analysis.charts.kagi|1.reversal',
    'Kagi reversal is a continuous absolute-price or percentage threshold; bar count bounds the single-pass calculation',
  ],
  [
    'options.ControlVariate#estimate|0.0',
    'normalDraws is supplied numeric sample data; array length bounds the estimator and each element is a magnitude, not a requested draw count',
  ],
  [
    'options.EquityLattice#spotAt|1',
    'upMoveCount is a coordinate into an already-built lattice, not a loop or allocation budget for this call',
  ],
  [
    'risk.deflatedSharpeRatio|1.trialCount',
    'trialCount is a closed-form multiple-testing model parameter; the calculation does not iterate or allocate from it',
  ],
  [
    'risk.researchProtocol|0.trials.trialCount',
    'trialCount is metadata consumed by a closed-form deflated-Sharpe calculation, not a workload budget',
  ],
  [
    'portfolio.applyPortfolioEvents|0.previousState.eventCount',
    'a restored fold-state event count is an echo of the appliedEvents registry (validated to match it exactly); the reducer folds the supplied events array, never this counter',
  ],
  [
    'portfolio.portfolioSnapshot|0.portfolio.eventCount',
    'the fold-state event count is an echo of the appliedEvents registry (validated to match it exactly); valuation iterates positions and cash, never this counter',
  ],
  [
    'portfolio.reconcilePortfolio|0.portfolio.eventCount',
    'the fold-state event count is an echo of the appliedEvents registry (validated to match it exactly); reconciliation walks accounts, currencies, and positions, never this counter',
  ],
  [
    'portfolio.portfolioPnl|0.ledger.state.eventCount',
    'the ledger state event count is an echo of the appliedEvents registry (validated to match it exactly); the P&L folds the ledger events array between two marks, never this counter',
  ],
  [
    'portfolio.portfolioTimeline|0.ledger.state.eventCount',
    'the ledger state event count is an echo of the appliedEvents registry (validated to match it exactly); the timeline folds the ledger events array through the marks, never this counter',
  ],
  [
    'portfolio.portfolioPerformanceInputs|0.ledger.state.eventCount',
    'the ledger state event count is an echo of the appliedEvents registry (validated to match it exactly); the seam folds the ledger events array, never this counter',
  ],
  [
    'portfolio.proposePortfolioRebalance|0.portfolio.eventCount',
    'the fold-state event count is an echo of the appliedEvents registry (validated to match it exactly); the proposal walks accounts, positions, and targets, never this counter',
  ],
  [
    'portfolio.monitorPortfolio|0.portfolio.eventCount',
    'the fold-state event count is an echo of the appliedEvents registry (validated to match it exactly); the monitor walks accounts, positions, and rules, never this counter',
  ],
  [
    'portfolio.monitorPortfolio|0.pnl.diagnostics.eventCount',
    'the companion P&L report’s event count is report metadata echoed from the ledger; the monitor reads the report’s totals, never this counter',
  ],
  [
    'portfolio.monitorPortfolio|0.reconciliation.diagnostics.externalAccountCount',
    'the companion reconciliation report’s account count is report metadata; the monitor reads its verdict and difference counts as values, never as a loop bound',
  ],
  [
    'portfolio.monitorPortfolio|0.reconciliation.diagnostics.ledgerAccountCount',
    'the companion reconciliation report’s account count is report metadata; the monitor reads its verdict and difference counts as values, never as a loop bound',
  ],
  [
    'portfolio.monitorPortfolio|0.reconciliation.differenceCount',
    'the companion reconciliation report’s difference count is a closed-form VALUE the reconciliation-difference family compares (differenceCount − explainedCount against 0); the monitor never iterates or allocates from it, and a count that disagrees with the reconciled flag is refused as edited',
  ],
  [
    'portfolio.monitorPortfolio|0.reconciliation.explainedCount',
    'the companion reconciliation report’s explained count is a closed-form VALUE the reconciliation-difference family compares; never a loop bound',
  ],
  [
    'portfolio.monitorPortfolio|0.previousState.evaluationCount',
    'the prior monitor state’s evaluation count is carried metadata (validated safe-int, incremented by one); the monitor never loops or allocates from it',
  ],
  [
    'portfolio.preflightTradePlan|0.monitorState.evaluationCount',
    'the prior monitor state handed to preflight is the same carried metadata: preflight passes it to monitorPortfolio as previousState (validated safe-int there, incremented by one) and never loops or allocates from it (Stage 7B.2 slice 1, 2026-09-06)',
  ],
  [
    'backtest.tearSheet|0.performance.periods',
    'the completed backtest period count is report metadata; tearSheet does not loop or allocate from it',
  ],
  [
    'backtest.tearSheet|0.performance.drawdown.longestDurationPeriods',
    'the completed drawdown duration is report metadata; tearSheet only echoes it',
  ],
  [
    'backtest.optionsTearSheet|0.performance.periods',
    'the completed backtest period count is report metadata; optionsTearSheet does not size work from it',
  ],
  [
    'backtest.optionsTearSheet|0.performance.drawdown.longestDurationPeriods',
    'the completed drawdown duration is report metadata; optionsTearSheet only echoes it',
  ],
  [
    'risk.factorExposure|1.factorCount',
    'the requested retained-factor count is clamped to the already-computed matrix rank, so input size bounds all work and output allocation',
  ],
  [
    'volatility.garchForecast|0.fit.iterations',
    'the optimizer iteration count is metadata from the supplied fit; the forecast does not loop on it',
  ],
  [
    'volatility.harRvForecast|0.observationCount',
    'the observation count is metadata from the supplied fit; history length and fitted windows bound forecast work',
  ],
  [
    'volatility.harRvForecast.explain|0.observationCount',
    'the observation count is metadata from the supplied fit; history length and fitted windows bound forecast work',
  ],
  [
    'volatility.HarRvForecastFacade#explain|0.observationCount',
    'the observation count is metadata from the supplied fit; history length and fitted windows bound forecast work',
  ],
  [
    'math.monteCarlo|1.minPaths',
    'minPaths is a stopping threshold inside the separately bounded paths budget; raising it cannot make monteCarlo exceed paths',
  ],
  [
    'math.rollingMean|1',
    'the supplied series length bounds rollingMean work and output; a larger safe window exits without proportional iteration or allocation',
  ],
  [
    'math.rollingStandardDeviation|1',
    'the supplied series length bounds rollingStandardDeviation work and output; a larger safe window exits without proportional iteration or allocation',
  ],
  [
    'math.rollingCovariance|2',
    'the supplied series lengths bound rollingCovariance work and output; a larger safe window exits without proportional iteration or allocation',
  ],
  [
    'math.rollingCorrelation|2',
    'the supplied series lengths bound rollingCorrelation work and output; a larger safe window exits without proportional iteration or allocation',
  ],
]);

/** The Stage 4.5 fitted-model verbs that receive a fit, a report, or an artifact as input. */
const FITTED_MODEL_VERB_HEADS = new Set([
  'volatility.fittedModelArtifact',
  'volatility.readFittedModel',
  'volatility.evaluateFittedModel',
  'volatility.replayFittedModel',
  'volatility.compareFittedModels',
  'volatility.warmStartFrom',
  'fixed-income.fittedModelArtifact',
  'fixed-income.readFittedModel',
  'fixed-income.evaluateFittedModel',
  'fixed-income.replayFittedModel',
  'fixed-income.compareFittedModels',
  'research.researchRunArtifact',
  'research.readResearchRun',
  'research.replayResearchRun',
  'research.compareResearchRuns',
  // Stage 4.6 slice 3 (2026-09-04): the backtest-run artifact verbs receive a verbatim run, the
  // request that produced it, a report, or a whole artifact — the same law.
  'backtest.backtestRunArtifact',
  'backtest.readBacktestRun',
  'backtest.replayBacktestRun',
  'backtest.compareBacktestRuns',
]);

/** Exact data/magnitude spellings that contain a resource-looking suffix but do not drive work. */
const MAGNITUDE_KEYS = new Set([
  'periodsPerYear',
  'riskFreeRatePerPeriod',
  'costPerPeriod',
  'splitFactorSincePeriod',
  'principalByPeriod',
  // A decay half-life in periods is a continuous exponent (`0.5^((T − 1 − t) / halfLifePeriods)`);
  // the observation count bounds the work, and 2.5 periods is a legitimate half-life.
  'halfLifePeriods',
]);

/** Camel-case word boundaries, deliberately case-sensitive so `discount` is never `…Count`. */
const RESOURCE_KEY =
  /(^counts?$|Counts?$|^periods?$|(?<!Per)Periods?$|^steps$|Steps$|^stepsPerYear$|^numberOf[A-Z]|LifeYears$|^paths$|Paths$|^samples$|Samples$|^iterations$|Iterations$|^maxGenerations$|Generations$|^populationSize$|PopulationSize$|^folds$|Folds$|^lags$|Lags$|^windows?$|Windows?$|^lookbacks?$|Lookbacks?$|^bins$|Bins$|^dimensions$|Dimensions$|^nodeCount$|NodeCount$|^probeLength$|ProbeLength$|^horizons?$|Horizons?$|^terms$|^simulations$|Simulations$|^replications$|Replications$|^draws$|Draws$|^(?:grid|butterfly|calendar)Points$)/;

/**
 * A fixture variant appends `#arm`, while real public method IDs also contain `#` (for example
 * `structure.FlowAnalysis#rank`). Check the exact ID first and peel only trailing suffixes, one at a
 * time, so the real method ID remains a candidate when a method fixture also has a branch suffix.
 */
const candidateHeads = (head: string): readonly string[] => {
  const candidates = [head];
  let candidate = head;
  for (;;) {
    const suffix = candidate.lastIndexOf('#');
    if (suffix < 0) return candidates;
    candidate = candidate.slice(0, suffix);
    candidates.push(candidate);
  }
};

export function numericCoordinatePolicy(coordinate: NumericCoordinate): NumericCoordinatePolicy {
  const heads = candidateHeads(coordinate.head);
  const path = coordinate.path.join('.');
  // Stage 4.5 (2026-09-02): the fitted-model verbs RECEIVE a direct calibrator's verbatim fit, a
  // report, or a whole artifact. Every count inside those (a fit's `iterations`, a report's
  // `warningCount` / `fitWarningCount` / `residuals.count`, an artifact's `result.*`) is a fact the
  // producing call reported — the verb reads it as a value and never loops or allocates from it.
  // The verbs' own budgets (`limits.*`, `restarts`, `gridPoints`, `holdout.*`) stay resources.
  if (
    (heads.some((head) => FITTED_MODEL_VERB_HEADS.has(head)) &&
      /^0\.(fit|model|run|baseline|candidate|artifact)\./.test(path)) ||
    (heads.includes('core.flattenSummaryParameters') && /^0\./.test(path)) ||
    (heads.includes('research.researchRunArtifact') && /^0\.hygiene\./.test(path)) ||
    // Stage 4.6 slice 3: the stored REQUEST's counts (a side's `count`, a lookback) are validated by
    // the producing verb's own closed guard inside backtestRunArtifact and then stored as facts —
    // the artifact verb neither selects nor allocates from them; the hygiene block likewise.
    (heads.includes('backtest.backtestRunArtifact') && /^0\.(input|hygiene)\./.test(path)) ||
    // Stage 4.6 slice 4: the options tear sheet receives a whole optionsBacktest RESULT — its
    // diagnostics counts (rejections, early assignments, open-at-end, snapshots) are facts the
    // engine reported, as are the ledger's, the timeline's, the surface's, and the rejection rows';
    // the tear sheet summarizes trades and settlements and never loops or allocates from them.
    (heads.includes('backtest.optionsTearSheet') &&
      /^0\.(diagnostics|timeline|ledger|surface|limitRejections|fillRejections|assumptions)\./.test(
        path,
      ))
  ) {
    return {
      kind: 'magnitude',
      rationale:
        'a count carried on the supplied fit / run / report / artifact / hygiene block (Stage 4.5) — reported by the producing call, read as a value, never a loop or allocation bound',
    };
  }
  // Stage 7B.2 slice 2 (2026-09-06): a grant is minted FROM a whole preflight REPORT. Every count
  // inside it (the before/after snapshots' lot counts, the monitor state's evaluation count, the
  // diagnostics' check counts) is a fact preflight reported; the grant reads the report's decision,
  // hashes, and instant and never loops or allocates from those counts. The grant's own budget
  // (`idempotencyKeys.count`) stays a resource.
  if (heads.includes('portfolio.createAuthorizationGrant') && /^0\.preflight\./.test(path)) {
    return {
      kind: 'magnitude',
      rationale:
        'a count carried on the supplied preflight report (Stage 7B.2) — reported by preflightTradePlan, read as a value by the grant, never a loop or allocation bound',
    };
  }
  if (
    heads.some((head) => head.endsWith('.createTableHandle')) &&
    (coordinate.key === 'rowCount' || coordinate.key === 'columnCount')
  ) {
    return {
      kind: 'magnitude',
      rationale:
        'table-handle row/column counts describe an already-materialized external table; createTableHandle validates exactness but allocates or iterates over neither count',
    };
  }
  if (heads.some((head) => head.endsWith('.controlVariateEstimate')) && path.startsWith('0.')) {
    return {
      kind: 'magnitude',
      rationale:
        'controlVariateEstimate.samples is supplied numeric observation data; array length bounds work and each element is a magnitude, not a requested sample count',
    };
  }
  if (heads.includes('technical-analysis.mavp') && path.startsWith('0.periods.')) {
    return {
      kind: 'magnitude',
      rationale:
        'each MAVP periods value is finite selector data that is rounded and clamped to the separately bounded minPeriod/maxPeriod range; series length bounds the selector count',
    };
  }
  if (heads.includes('volatility.surfacePCA') && path.startsWith('0.gridPoints.')) {
    return {
      kind: 'magnitude',
      rationale:
        'surfacePCA.gridPoints is an array of numeric grid coordinates aligned to the snapshots, not a requested point count',
    };
  }
  for (const head of heads) {
    const rationale = DATA_BOUNDED_OR_METADATA_COORDINATES.get(`${head}|${path}`);
    if (rationale !== undefined) return { kind: 'magnitude', rationale };
  }
  if (
    coordinate.key === 'iterations' &&
    coordinate.path.some(
      (step, index) => step === 'diagnostics' && coordinate.path[index + 1] === 'iterations',
    )
  ) {
    return {
      kind: 'magnitude',
      rationale: `${coordinate.head}:${path} is diagnostic metadata describing completed work, not a budget consumed by this call`,
    };
  }
  if (MAGNITUDE_KEYS.has(coordinate.key) || coordinate.key.endsWith('PerPeriod')) {
    return {
      kind: 'magnitude',
      rationale: `${coordinate.key} is a rate/factor coordinate, not a loop or allocation bound`,
    };
  }
  const continuousHead = heads.find((head) => CONTINUOUS_HORIZON_HEADS.has(head));
  if (coordinate.key === 'horizonPeriods' && continuousHead !== undefined) {
    return {
      kind: 'magnitude',
      rationale: `${continuousHead}.${coordinate.key} is a positive continuous horizon used for √time or growth scaling`,
    };
  }
  if (
    heads.some((head) => EXACT_RESOURCE_COORDINATES.has(`${head}|${coordinate.key}`)) ||
    (heads.some((head) => head.startsWith('technical-analysis.')) &&
      TECHNICAL_ANALYSIS_LOOKBACK_KEYS.has(coordinate.key)) ||
    (heads.some((head) => TECHNICAL_ANALYSIS_LONG_SHORT_LOOKBACK_HEADS.has(head)) &&
      (coordinate.key === 'long' || coordinate.key === 'short')) ||
    RESOURCE_KEY.test(coordinate.key)
  ) {
    return {
      kind: 'resource',
      rationale: `${coordinate.head}:${path} controls iteration, allocation, paging, or window size`,
      safetyCeiling: RESOURCE_SAFETY_CEILING,
    };
  }
  return {
    kind: 'magnitude',
    rationale: `${coordinate.head}:${path} is ordinary numeric data, a rate, or a monetary/model coordinate`,
  };
}

export const isResourceCoordinate = (coordinate: NumericCoordinate): boolean =>
  numericCoordinatePolicy(coordinate).kind === 'resource';
