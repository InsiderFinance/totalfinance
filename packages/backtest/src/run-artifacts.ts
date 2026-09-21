/**
 * `@totalfinance/backtest/artifacts` (Stage 4.6, FC8 Decision 8): reproducible run artifacts over the
 * Stage 4.5 grammar — an `AnalysisArtifact` of type `totalfinance.backtest-run` whose `result` is the
 * typed {@link BacktestRunReport}: the run verbatim, the request with bulk row sets embedded or
 * referenced by `TableHandle`, every execution and accounting model recorded by its description,
 * the run's content hash, and the FC8 identity list (strategy and recipe version, dataset identity,
 * universe id and history hash, point-in-time policy, conventions and calendar, engine and model
 * labels/versions, seed, costs, benchmark, annualization). Four verbs: `backtestRunArtifact`,
 * `readBacktestRun`, `replayBacktestRun`, `compareBacktestRuns`. Nothing here computes a number a
 * run did not — the engine is the engine; the artifact is its record.
 */

import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  isQuantError,
  requireArgumentArray,
  requireArgumentObject,
  warning,
  type Provenance,
  type QuantWarning,
  WarningCode,
} from '@totalfinance/core';
import {
  ARTIFACT_WORK_LIMITS,
  applyReportMigrations,
  artifactReplayParity,
  canonicalJsonOf,
  contentHash,
  createAnalysisArtifact,
  fromCanonicalJson,
  isTableHandle,
  readAnalysisArtifact,
  requireComparisonTolerance,
  requireWorkLimit,
  scanCanonicalData,
  tableHandleForRows,
  verifyReferencedRows,
  type AnalysisArtifact,
  type AppliedMigration,
  type ArtifactMigrationRegistry,
  type ArtifactReplayParity,
  type ComparisonLimits,
  type ComparisonTolerance,
  type TableHandle,
} from '@totalfinance/core/artifacts';
import type { CostModel, SlippageModel } from './costs.js';
import { crossSectionalBacktest } from './cross-sectional/engine.js';
import {
  crossSectionalBacktestGrid,
  requireCrossSectionalBacktestGridRequest,
} from './cross-sectional/grid.js';
import type {
  CrossSectionalBacktestGridRequest,
  CrossSectionalBacktestGridResult,
} from './cross-sectional/grid.js';
import type {
  CrossSectionalBacktestRequest,
  CrossSectionalBacktestResult,
} from './cross-sectional/types.js';
import { requireCrossSectionalBacktestRequest } from './cross-sectional/validate.js';
import { describeExecutionPolicy, execution as executionPolicies } from './execution/policy.js';
import { optionsBacktest, requireOptionsBacktestConfig } from './options/engine.js';
import { portfolioBacktest } from './portfolio/engine.js';
import { requireEnvironmentEpisodeInput, runEnvironmentEpisode } from './environment/episode.js';
import type { EnvironmentEpisodeInput, EnvironmentEpisodeResult } from './environment/types.js';
import type { PortfolioBacktestRequest, PortfolioBacktestResult } from './portfolio/types.js';
import { requirePortfolioBacktestRequest } from './portfolio/validate.js';
import type { OptionsBacktestConfig, OptionsBacktestResult } from './options/types.js';
import type { ExecutionPolicy, ExecutionPolicyDescription } from './execution/types.js';

export const BACKTEST_RUN_ARTIFACT_TYPE = 'totalfinance.backtest-run';

/** Decision 9's bounded-work table (core's `ARTIFACT_WORK_LIMITS`, re-exported for this subpath's callers). */
export const BACKTEST_RUN_LIMITS = ARTIFACT_WORK_LIMITS;

/** The run kinds this subpath records. */
export type BacktestRunKind =
  | 'cross-sectional'
  | 'cross-sectional-grid'
  | 'options'
  | 'portfolio'
  | 'environment';

export interface BacktestRunInputs {
  'cross-sectional': CrossSectionalBacktestRequest;
  'cross-sectional-grid': CrossSectionalBacktestGridRequest;
  options: OptionsBacktestConfig;
  portfolio: PortfolioBacktestRequest;
  environment: EnvironmentEpisodeInput;
}
export interface BacktestRunResults {
  'cross-sectional': CrossSectionalBacktestResult;
  'cross-sectional-grid': CrossSectionalBacktestGridResult;
  options: OptionsBacktestResult;
  portfolio: PortfolioBacktestResult;
  environment: EnvironmentEpisodeResult;
}
export type InputOf<K extends BacktestRunKind> = BacktestRunInputs[K];
export type RunOf<K extends BacktestRunKind> = BacktestRunResults[K];

/** The frozen, data-only description of one run kind. */
export interface BacktestRunKindDescriptor {
  kind: BacktestRunKind;
  runVersion: number;
  /** The direct verb the run re-issues on replay. */
  operation: string;
  /** Bulk row sets of the request (dotted paths); each may be embedded or referenced by table handle. */
  inputRowSets: readonly string[];
  /** Bulk row sets of the run (dotted paths under `run.`); each may be embedded or referenced. */
  resultRowSets: readonly string[];
  /** Request fields that, when they carry a caller function, make the run non-replayable. */
  callbackFields: readonly string[];
  /** Request fields recorded by description (execution policy, cost models); replay takes them back as `models`. */
  modelFields: readonly string[];
}

export interface BacktestRunArtifactLimits {
  maximumEmbeddedBytes?: number;
  embeddedRowLimit?: number;
}

/** The research-hygiene verdicts a caller attaches to a single run — verbatim `@totalfinance/risk` results. */
export interface BacktestHygieneBlock {
  researchProtocol?: Record<string, unknown>;
  deflatedSharpe?: Record<string, unknown>;
  backtestOverfitting?: Record<string, unknown>;
}

/** The recorded models of a run: descriptions and labels, never functions. */
export interface RecordedModels {
  execution: ExecutionPolicyDescription | null;
  commission: string | null;
  slippage: string | null;
}

/** The FC8 identity list, read from the run's assumptions and the request — never recomputed. */
export interface BacktestRunIdentity {
  /** The engine's content-addressed run id (the sweep id for a grid). */
  runId: string;
  /** Every child run id, in variation order (grids only). */
  childRunIds: string[] | null;
  universeId: string;
  /** Content hash of the universe history's member rows. */
  universeHistoryHash: string;
  /** The signal as the engine disclosed it (`assumptions.signal`). */
  strategy: Record<string, unknown>;
  recipe: { recipeName: string; recipeVersion: number } | null;
  pointInTimePolicy: string;
  conventions: {
    conventionsVersion: string;
    sessionInstantConvention: string;
    pricing: string;
  };
  calendar: {
    sessions: number;
    firstMarkTimestampMs: number | null;
    lastMarkTimestampMs: number | null;
  };
  engine: { operation: string; runVersion: number };
  models: RecordedModels;
  seed: number | null;
  benchmark: boolean;
  annualization: { periodsPerYear: number; riskFreeRate: number };
  initialCapital: number;
  baseCurrency: string;
  /** The grid's axes (grids only). */
  variations: Array<{ path: string; values: unknown[] }> | null;
}

/** The typed report every verb reads and writes — the artifact's `result`, verbatim. */
export type BacktestRunReport<Kind extends BacktestRunKind = BacktestRunKind> = Readonly<
  Record<string, unknown>
> & {
  kind: Kind;
  runVersion: number;
  /** The verb's result verbatim, with referenced result row sets replaced by their table handles. */
  run: Record<string, unknown>;
  /** The request with bulk row sets embedded or referenced, callbacks omitted, models by description. */
  inputs: Record<string, unknown>;
  /** Table references for every row set that was not embedded, keyed by label (`dataset.returns`, `run.holdings`). */
  referencedData: Record<string, TableHandle>;
  /** `contentHash` of the stored run (the projection above) — the run's identity. */
  runHash: string;
  identity: BacktestRunIdentity;
  /** The caller's hygiene block (single runs) or the grid's own verdicts (grids), verbatim. */
  hygiene: BacktestHygieneBlock | null;
  /** Reserved (Decision 8): a cooperative checkpoint/resume lands in Stage 7B without changing the format. */
  execution: { completed: true };
  assumptions: {
    conventionsVersion: string;
    kind: Kind;
    runVersion: number;
    operation: string;
    /** `false` exactly when a caller function participated. */
    replayable: boolean;
    nonReplayableField: string | null;
    inputPolicy: 'embedded' | 'referenced';
    embeddedRowLimit: number;
    modelPolicy: string;
    projection: string;
  };
  diagnostics: {
    warnings: QuantWarning[];
    embeddedRows: number;
    referencedRows: number;
    runWarningCount: number;
  };
};

export interface BacktestRunArtifactInput<Kind extends BacktestRunKind> {
  kind: Kind;
  /** The verb's result, verbatim. */
  run: RunOf<Kind>;
  /** The request as it was called — rows included; callbacks recorded and not stored; models recorded by description. */
  input: InputOf<Kind>;
  /** Row-set labels (`dataset.returns`, `run.holdings`, `run.ledger.events`) to store by `TableHandle` instead of embedding. */
  referenceRowSets?: readonly string[];
  /** Storage locators to stamp on the minted handles, keyed by row-set label. */
  locators?: Record<string, string>;
  /** Verbatim `@totalfinance/risk` verdicts for a single run; a grid carries its own and refuses this. */
  hygiene?: BacktestHygieneBlock;
  snapshotHash?: string;
  libraryVersion?: string;
  createdFrom?: string[];
  provenance?: Provenance;
  limits?: BacktestRunArtifactLimits;
}

export interface ReadBacktestRunResult<Kind extends BacktestRunKind = BacktestRunKind> {
  report: BacktestRunReport<Kind>;
  artifact: AnalysisArtifact;
  migrationsApplied: AppliedMigration[];
  modelMigrationsApplied: AppliedMigration[];
  /** Labels whose referenced rows were supplied, verified by hash, and restored into `report`. */
  restoredRowSets: string[];
}

/** The models a replay takes back, each verified against the recorded description before the run. */
export interface ReplayModels {
  execution?: ExecutionPolicy;
  transactionCostModel?: { commission?: CostModel; slippage?: SlippageModel };
  /** The options kind's labeled models, keyed by their request path (`commission`, `slippage`, `hedge.commission`, `hedge.slippage`). */
  labeled?: Record<string, CostModel | SlippageModel>;
}

export interface BacktestRunReplay<Kind extends BacktestRunKind = BacktestRunKind> {
  kind: Kind;
  artifactId: string;
  /** The recomputed report (the same projection as the saved one). */
  recomputed: BacktestRunReport<Kind>;
  runHash: { saved: string; recomputed: string };
  /** `true` exactly when the recomputed run hash equals the saved one. */
  matches: boolean;
  parity: ArtifactReplayParity;
  assumptions: {
    conventionsVersion: string;
    kind: Kind;
    runVersion: number;
    operation: string;
    libraryVersion: { saved: string | null; current: string | null };
    referencedRowSets: string[];
    models: {
      execution: 'recorded-default' | 'supplied' | 'none';
      transactionCostModel: 'supplied' | 'none';
    };
  };
  diagnostics: { warnings: QuantWarning[] };
}

export interface IdListSection {
  count: number;
  ids: string[];
  remainderCount: number;
}
export interface MembershipSection {
  entered: IdListSection;
  exited: IdListSection;
  kept: IdListSection;
}
export interface NamedDelta {
  name: string;
  baselineValue: number | null;
  candidateValue: number | null;
  absoluteDelta: number | null;
  /** Under an explicit tolerance: whether the delta is within it; `null` without one. */
  withinTolerance: boolean | null;
}
export interface RebalanceDelta {
  rebalanceIndex: number;
  sessionDate: { baseline: string; candidate: string };
  turnover: { baseline: number; candidate: number; absoluteDelta: number };
  costs: { baseline: number; candidate: number; absoluteDelta: number };
  longCount: { baseline: number; candidate: number };
  shortCount: { baseline: number; candidate: number };
}
export interface VariationDelta {
  parameters: Record<string, unknown>;
  metric: string;
  baselineValue: number | null;
  candidateValue: number | null;
  absoluteDelta: number | null;
}

export interface BacktestRunComparison<Kind extends BacktestRunKind = BacktestRunKind> {
  kind: Kind;
  artifactIds: { baseline: string | null; candidate: string | null };
  runHashes: { baseline: string; candidate: string };
  identical: boolean;
  sameInputs: boolean;
  sameUniverse: boolean;
  sameStrategy: boolean;
  sameModels: boolean;
  sameConventions: boolean;
  /** The performance block and the run-level totals, name by name. */
  metrics: NamedDelta[];
  /** Final-holding membership (names held at the last rebalance) — single runs only. */
  holdings: MembershipSection | null;
  /** Rebalance-by-rebalance turnover and cost deltas over the shared index range, listed up to `listedIds`. */
  rebalances: { compared: number; rows: RebalanceDelta[]; remainderCount: number } | null;
  /** Per-variation deltas of the grid's selection metric, matched by parameters — grids only. */
  variations: {
    matched: number;
    baselineOnly: number;
    candidateOnly: number;
    rows: VariationDelta[];
    remainderCount: number;
    best: { baseline: number | null; candidate: number | null; moved: boolean };
  } | null;
  hygiene: { baseline: string | null; candidate: string | null; changed: boolean } | null;
  /** The structural diff of the two stored runs through the parity walk. */
  run: {
    differenceCount: number;
    retainedDifferences: number;
    addedPaths: string[];
    removedPaths: string[];
    truncated: boolean;
  };
  /** Under an explicit tolerance: every metric within it; `null` without one. */
  withinTolerance: boolean | null;
  assumptions: {
    conventionsVersion: string;
    kind: Kind;
    tolerance: ComparisonTolerance | null;
    limits: { maximumDifferences: number; maximumLeaves: number; listedIds: number };
  };
  diagnostics: { warnings: QuantWarning[] };
}

// ─────────────────────────────────────────── kinds ──────────────────────────────────────────────

type Path = readonly string[];
interface RowSetSpec {
  readonly label: string;
  readonly path: Path;
}
interface CallbackSpec {
  readonly field: string;
  readonly path: Path;
  /** The stored form: the function removed, a marker kept so a reader knows what was there. */
  readonly strip: (record: Record<string, unknown>) => Record<string, unknown>;
}
interface KindSpec<K extends BacktestRunKind> {
  readonly descriptor: BacktestRunKindDescriptor;
  readonly inputRowSets: readonly RowSetSpec[];
  readonly resultRowSets: readonly RowSetSpec[];
  readonly callbacks: readonly CallbackSpec[];
  /** Where the request's `execution` and `transactionCostModel` live (the cross-sectional kinds). */
  readonly modelRoot: Path;
  /** Labeled cost models recorded by label (the options kind): dotted paths in the request. */
  readonly labeledModels: readonly string[];
  /** Callback-bearing members that a fixed path cannot name (an entry array's rules). */
  readonly dynamicCallbacks: (record: Record<string, unknown>) => Array<{
    field: string;
    strip: (record: Record<string, unknown>) => Record<string, unknown>;
  }>;
  readonly runKeys: readonly string[];
  /** The verb's own closed request guard — the stored request must be one the verb accepts. */
  readonly requireInput: (functionName: string, label: string, value: unknown) => void;
  readonly run: (input: InputOf<K>) => RunOf<K>;
  readonly identity: (run: RunOf<K>, storedInput: Record<string, unknown>) => BacktestRunIdentity;
}

const rowSet = (label: string): RowSetSpec => ({ label, path: label.split('.') });
const resultRowSet = (label: string): RowSetSpec => ({
  label: `run.${label}`,
  path: label.split('.'),
});

const CROSS_SECTIONAL_INPUT_ROW_SETS = [
  'dataset.observations',
  'dataset.returns',
  'dataset.benchmarkReturns',
  'universeHistory.members',
] as const;
const CROSS_SECTIONAL_RESULT_ROW_SETS = [
  'rebalances',
  'holdings',
  'points',
  'returns',
  'trades',
  'fills',
  'ledger.events',
  'timeline.rows',
  'attribution.perRebalance',
] as const;
const CROSS_SECTIONAL_RUN_KEYS = [
  'rebalances',
  'holdings',
  'points',
  'returns',
  'trades',
  'fills',
  'ledger',
  'timeline',
  'attribution',
  'benchmark',
  'performance',
  'performanceConfidence',
  'finalValue',
  'runId',
  'assumptions',
  'diagnostics',
] as const;
const GRID_RUN_KEYS = [
  'sweepId',
  'variations',
  'runs',
  'best',
  'hygiene',
  'assumptions',
  'diagnostics',
] as const;

function callbackAt(
  field: string,
  marker: (record: Record<string, unknown>) => Record<string, unknown>,
): CallbackSpec {
  const path = field.split('.');
  return { field, path, strip: marker };
}

const SIGNAL_CALLBACK = (prefix: Path): CallbackSpec =>
  callbackAt(
    [...prefix, 'signal', 'callback'].join('.'),
    (record) =>
      withPath(record, [...prefix, 'signal'], {
        callback: '[caller function — not stored]',
      }) as Record<string, unknown>,
  );
const SUPPLIED_WEIGHTS_CALLBACK = (prefix: Path): CallbackSpec =>
  callbackAt([...prefix, 'portfolioConstruction', 'suppliedWeights'].join('.'), (record) => {
    const construction = {
      ...(readPath(record, [...prefix, 'portfolioConstruction']) as Record<string, unknown>),
    };
    delete construction['suppliedWeights'];
    return withPath(record, [...prefix, 'portfolioConstruction'], construction) as Record<
      string,
      unknown
    >;
  });

function crossSectionalIdentity(
  run: CrossSectionalBacktestResult,
  storedInput: Record<string, unknown>,
  extra: {
    runId: string;
    childRunIds: string[] | null;
    variations: BacktestRunIdentity['variations'];
    operation: string;
    runVersion: number;
  },
  requestRoot: Path,
): BacktestRunIdentity {
  const assumptions = run.assumptions;
  const members = readPath(storedInput, [...requestRoot, 'universeHistory', 'members']);
  const models = readPath(storedInput, requestRoot) as Record<string, unknown>;
  const costs = (models['transactionCostModel'] ?? null) as {
    commission?: string;
    slippage?: string;
  } | null;
  const signal = assumptions.signal as unknown as Record<string, unknown>;
  return {
    runId: extra.runId,
    childRunIds: extra.childRunIds,
    universeId: assumptions.universeId,
    universeHistoryHash: isTableHandle(members) ? members.contentHash : contentHash(members),
    strategy: { ...signal },
    recipe:
      signal['kind'] === 'factor-recipe'
        ? {
            recipeName: String(signal['recipeName']),
            recipeVersion: Number(signal['recipeVersion']),
          }
        : null,
    pointInTimePolicy:
      'a feature is visible to a decision instant only when availableTimestampMs ≤ the instant; a recipe lag counts trading sessions through the session index; universe membership is read at the instant',
    conventions: {
      conventionsVersion: assumptions.conventionsVersion,
      sessionInstantConvention: assumptions.sessionInstantConvention,
      pricing: assumptions.pricing,
    },
    calendar: {
      sessions: run.diagnostics.sessionCount,
      firstMarkTimestampMs: run.points.length > 0 ? run.points[0]!.timestampMs : null,
      lastMarkTimestampMs:
        run.points.length > 0 ? run.points[run.points.length - 1]!.timestampMs : null,
    },
    engine: { operation: extra.operation, runVersion: extra.runVersion },
    models: {
      execution: (models['execution'] as ExecutionPolicyDescription | undefined) ?? null,
      commission: costs?.commission ?? null,
      slippage: costs?.slippage ?? null,
    },
    seed: assumptions.seed,
    benchmark: run.benchmark !== null,
    annualization: {
      periodsPerYear: assumptions.periodsPerYear,
      riskFreeRate: assumptions.riskFreeRate,
    },
    initialCapital: assumptions.initialCapital,
    baseCurrency: assumptions.baseCurrency,
    variations: extra.variations,
  };
}

const CROSS_SECTIONAL_SPEC: KindSpec<'cross-sectional'> = {
  descriptor: Object.freeze({
    kind: 'cross-sectional',
    runVersion: 1,
    operation: 'crossSectionalBacktest',
    inputRowSets: CROSS_SECTIONAL_INPUT_ROW_SETS,
    resultRowSets: CROSS_SECTIONAL_RESULT_ROW_SETS.map((label) => `run.${label}`),
    callbackFields: ['signal.callback', 'portfolioConstruction.suppliedWeights'],
    modelFields: ['execution', 'transactionCostModel'],
  }),
  inputRowSets: CROSS_SECTIONAL_INPUT_ROW_SETS.map(rowSet),
  resultRowSets: CROSS_SECTIONAL_RESULT_ROW_SETS.map(resultRowSet),
  callbacks: [SIGNAL_CALLBACK([]), SUPPLIED_WEIGHTS_CALLBACK([])],
  modelRoot: [],
  labeledModels: [],
  dynamicCallbacks: () => [],
  runKeys: CROSS_SECTIONAL_RUN_KEYS,
  requireInput: (functionName, label, value) => {
    requireCrossSectionalBacktestRequest(functionName, label, value);
  },
  run: crossSectionalBacktest,
  identity: (run, storedInput) =>
    crossSectionalIdentity(
      run,
      storedInput,
      {
        runId: run.runId,
        childRunIds: null,
        variations: null,
        operation: 'crossSectionalBacktest',
        runVersion: 1,
      },
      [],
    ),
};

const GRID_SPEC: KindSpec<'cross-sectional-grid'> = {
  descriptor: Object.freeze({
    kind: 'cross-sectional-grid',
    runVersion: 1,
    operation: 'crossSectionalBacktestGrid',
    inputRowSets: CROSS_SECTIONAL_INPUT_ROW_SETS.map((label) => `request.${label}`),
    resultRowSets: ['run.runs', 'run.variations'],
    callbackFields: ['request.signal.callback', 'request.portfolioConstruction.suppliedWeights'],
    modelFields: ['request.execution', 'request.transactionCostModel'],
  }),
  inputRowSets: CROSS_SECTIONAL_INPUT_ROW_SETS.map((label) => rowSet(`request.${label}`)),
  resultRowSets: [resultRowSet('runs'), resultRowSet('variations')],
  callbacks: [SIGNAL_CALLBACK(['request']), SUPPLIED_WEIGHTS_CALLBACK(['request'])],
  modelRoot: ['request'],
  labeledModels: [],
  dynamicCallbacks: () => [],
  runKeys: GRID_RUN_KEYS,
  requireInput: (functionName, label, value) => {
    requireCrossSectionalBacktestGridRequest(functionName, label, value);
  },
  run: crossSectionalBacktestGrid,
  identity: (run, storedInput) => {
    const child = run.runs[0];
    if (child === undefined) {
      fail(
        'backtestRunArtifact',
        'run.runs is empty — a grid always holds at least one child run.',
        ErrorCode.InputOutOfRange,
        { field: 'run.runs' },
      );
    }
    const variations = (
      readPath(storedInput, ['variations']) as Array<{ path: string; values: unknown[] }>
    ).map((axis) => ({ path: axis.path, values: [...axis.values] }));
    return crossSectionalIdentity(
      child,
      storedInput,
      {
        runId: run.sweepId,
        childRunIds: run.variations.map((row) => row.runId),
        variations,
        operation: 'crossSectionalBacktestGrid',
        runVersion: 1,
      },
      ['request'],
    );
  },
};

const OPTIONS_INPUT_ROW_SETS = ['chains', 'corporateActions', 'dividends'] as const;
const OPTIONS_RESULT_ROW_SETS = [
  'points',
  'returns',
  'trades',
  'settlements',
  'fills',
  'limitRejections',
  'fillRejections',
  'surface',
  'ledger.events',
  'timeline.rows',
] as const;
const OPTIONS_RUN_KEYS = [
  'points',
  'returns',
  'trades',
  'settlements',
  'fills',
  'finalValue',
  'performance',
  'limitRejections',
  'fillRejections',
  'surface',
  'ledger',
  'timeline',
  'runId',
  'assumptions',
  'diagnostics',
] as const;

/** The options request's callback-bearing members: every rule's `build` / function `when`, `exit.when`, `roll.when.when`. */
function optionsCallbacks(record: Record<string, unknown>): Array<{
  field: string;
  strip: (record: Record<string, unknown>) => Record<string, unknown>;
}> {
  const found: Array<{
    field: string;
    strip: (record: Record<string, unknown>) => Record<string, unknown>;
  }> = [];
  const isBook = Array.isArray(record['rules']);
  const rules: unknown[] = isBook ? [...(record['rules'] as unknown[])] : [record['entry']];
  const marker = '[caller function — not stored]';
  rules.forEach((rule, index) => {
    if (rule === null || typeof rule !== 'object') return;
    const r = rule as Record<string, unknown>;
    const at =
      (key: string) =>
      (target: Record<string, unknown>): Record<string, unknown> => {
        if (isBook) {
          const list = [...(target['rules'] as unknown[])];
          list[index] = { ...(list[index] as Record<string, unknown>), [key]: marker };
          return { ...target, rules: list };
        }
        return {
          ...target,
          entry: { ...(target['entry'] as Record<string, unknown>), [key]: marker },
        };
      };
    const label = isBook ? `rules[${index}]` : 'entry';
    if (typeof r['build'] === 'function')
      found.push({ field: `${label}.build`, strip: at('build') });
    if (typeof r['when'] === 'function') found.push({ field: `${label}.when`, strip: at('when') });
  });
  const exit = record['exit'] as Record<string, unknown> | undefined;
  if (exit !== null && typeof exit === 'object' && typeof exit['when'] === 'function') {
    found.push({
      field: 'exit.when',
      strip: (target) => ({
        ...target,
        exit: { ...(target['exit'] as Record<string, unknown>), when: marker },
      }),
    });
  }
  const roll = record['roll'] as Record<string, unknown> | undefined;
  const rollWhen =
    roll !== null && typeof roll === 'object'
      ? (roll['when'] as Record<string, unknown> | undefined)
      : undefined;
  if (rollWhen !== null && typeof rollWhen === 'object' && typeof rollWhen['when'] === 'function') {
    found.push({
      field: 'roll.when.when',
      strip: (target) => ({
        ...target,
        roll: {
          ...(target['roll'] as Record<string, unknown>),
          when: { ...(rollWhen as Record<string, unknown>), when: marker },
        },
      }),
    });
  }
  return found;
}

const OPTIONS_SPEC: KindSpec<'options'> = {
  descriptor: Object.freeze({
    kind: 'options',
    runVersion: 1,
    operation: 'optionsBacktest',
    inputRowSets: OPTIONS_INPUT_ROW_SETS,
    resultRowSets: OPTIONS_RESULT_ROW_SETS.map((label) => `run.${label}`),
    callbackFields: [
      'entry.build',
      'entry.when',
      'rules[].build',
      'rules[].when',
      'exit.when',
      'roll.when.when',
    ],
    modelFields: ['commission', 'slippage', 'hedge.commission', 'hedge.slippage'],
  }),
  inputRowSets: OPTIONS_INPUT_ROW_SETS.map(rowSet),
  resultRowSets: OPTIONS_RESULT_ROW_SETS.map(resultRowSet),
  callbacks: [],
  modelRoot: [],
  labeledModels: ['commission', 'slippage', 'hedge.commission', 'hedge.slippage'],
  dynamicCallbacks: optionsCallbacks,
  runKeys: OPTIONS_RUN_KEYS,
  requireInput: (functionName, label, value) => {
    requireOptionsBacktestConfig(functionName, label, value);
  },
  run: optionsBacktest,
  identity: (run, storedInput) => {
    const assumptions = run.assumptions;
    const chains = readPath(storedInput, ['chains']);
    const underlying = run.trades[0]?.underlying ?? run.settlements[0]?.underlying ?? 'UNDERLYING';
    return {
      runId: run.runId,
      childRunIds: null,
      universeId: underlying,
      universeHistoryHash: isTableHandle(chains) ? chains.contentHash : contentHash(chains),
      strategy: {
        kind: 'options-rules',
        rules: assumptions.rules,
        exit: readPath(storedInput, ['exit']) ?? null,
        roll: readPath(storedInput, ['roll']) ?? null,
      },
      recipe: null,
      pointInTimePolicy:
        'each snapshot sees only its own chain; a leg marks from its exact current-snapshot contract quote under the marking policy; fills read the selected price side of the current quote and refuse a stale one',
      conventions: {
        conventionsVersion: assumptions.conventionsVersion,
        sessionInstantConvention:
          'the snapshot asOf; the ledger marks at the following midnight, one mark per calendar date',
        pricing: `Black–Scholes marks from current quotes (${assumptions.marking.volatility}, missing mark: ${assumptions.marking.missingMark}); settlements at intrinsic`,
      },
      calendar: {
        sessions: run.diagnostics.snapshotCount,
        firstMarkTimestampMs: run.points.length > 0 ? run.points[0]!.timestampMs : null,
        lastMarkTimestampMs:
          run.points.length > 0 ? run.points[run.points.length - 1]!.timestampMs : null,
      },
      engine: { operation: 'optionsBacktest', runVersion: 1 },
      models: {
        execution: null,
        commission: assumptions.commission,
        slippage: assumptions.slippage,
      },
      seed: null,
      benchmark: false,
      annualization: {
        periodsPerYear: assumptions.periodsPerYear,
        riskFreeRate: assumptions.riskFreeRate,
      },
      initialCapital: assumptions.initialCapital,
      baseCurrency: assumptions.baseCurrency,
      variations: null,
    };
  },
};

const PORTFOLIO_INPUT_ROW_SETS = [
  'marketData.bars',
  'marketData.quotes',
  'marketData.trades',
  'marketData.orderBooks',
  'marketData.optionChains',
  'marketData.fxRates',
  'marketData.forwardRates',
  'marketData.fundingRates',
  'marketData.corporateActions',
  'marketData.dividends',
  'marketData.coupons',
  'externalFlows',
] as const;
const PORTFOLIO_RESULT_ROW_SETS = [
  'orders',
  'fills',
  'rejections',
  'liquidations',
  'events',
  'valuationMarks',
  'points',
  'returns',
  'ledger.events',
  'timeline.rows',
] as const;
const PORTFOLIO_RUN_KEYS = [
  'ledger',
  'timeline',
  'pnl',
  'orders',
  'fills',
  'rejections',
  'liquidations',
  'events',
  'valuationMarks',
  'points',
  'returns',
  'performance',
  'finalValue',
  'runId',
  'assumptions',
  'diagnostics',
] as const;

/** A custom instrument's adapter is a function-bearing object: recorded by kind and version, never stored. */
function portfolioCallbacks(record: Record<string, unknown>): Array<{
  field: string;
  strip: (record: Record<string, unknown>) => Record<string, unknown>;
}> {
  const found: Array<{
    field: string;
    strip: (record: Record<string, unknown>) => Record<string, unknown>;
  }> = [];
  const instruments = record['instruments'];
  if (instruments !== null && typeof instruments === 'object') {
    for (const [id, spec] of Object.entries(instruments as Record<string, unknown>)) {
      const adapter = (spec as { adapter?: unknown } | null)?.adapter;
      if (adapter === null || typeof adapter !== 'object') continue;
      found.push({
        field: `instruments.${id}.adapter`,
        strip: (target) => {
          const specs = { ...(target['instruments'] as Record<string, unknown>) };
          const own = specs[id] as Record<string, unknown>;
          const a = own['adapter'] as { kind?: unknown; version?: unknown };
          specs[id] = {
            ...own,
            adapter: {
              kind: a.kind,
              version: a.version,
              methods: '[caller functions — not stored]',
            },
          };
          return { ...target, instruments: specs };
        },
      });
    }
  }
  return found;
}

const PORTFOLIO_SPEC: KindSpec<'portfolio'> = {
  descriptor: Object.freeze({
    kind: 'portfolio',
    runVersion: 1,
    operation: 'portfolioBacktest',
    inputRowSets: PORTFOLIO_INPUT_ROW_SETS,
    resultRowSets: PORTFOLIO_RESULT_ROW_SETS.map((label) => `run.${label}`),
    callbackFields: ['strategy.onSession', 'instruments.<id>.adapter'],
    modelFields: ['execution'],
  }),
  inputRowSets: PORTFOLIO_INPUT_ROW_SETS.map(rowSet),
  resultRowSets: PORTFOLIO_RESULT_ROW_SETS.map(resultRowSet),
  callbacks: [
    callbackAt(
      'strategy.onSession',
      (record) =>
        withPath(record, ['strategy'], { onSession: '[caller function — not stored]' }) as Record<
          string,
          unknown
        >,
    ),
  ],
  modelRoot: [],
  labeledModels: [],
  dynamicCallbacks: portfolioCallbacks,
  runKeys: PORTFOLIO_RUN_KEYS,
  requireInput: (functionName, label, value) => {
    requirePortfolioBacktestRequest(functionName, label, value);
  },
  run: portfolioBacktest,
  identity: (run, storedInput) => {
    const assumptions = run.assumptions;
    const models = readPath(storedInput, []) as Record<string, unknown>;
    const instruments = readPath(storedInput, ['instruments']);
    return {
      runId: run.runId,
      childRunIds: null,
      universeId: `portfolio:${assumptions.instruments.length}`,
      universeHistoryHash: contentHash(instruments),
      strategy: { ...assumptions.strategy } as unknown as Record<string, unknown>,
      recipe: null,
      pointInTimePolicy: assumptions.sessionConvention,
      conventions: {
        conventionsVersion: assumptions.conventionsVersion,
        sessionInstantConvention: assumptions.sessionConvention,
        pricing: assumptions.markConvention,
      },
      calendar: {
        sessions: run.diagnostics.sessionCount,
        firstMarkTimestampMs: run.points.length > 0 ? run.points[0]!.timestampMs : null,
        lastMarkTimestampMs:
          run.points.length > 0 ? run.points[run.points.length - 1]!.timestampMs : null,
      },
      engine: { operation: 'portfolioBacktest', runVersion: 1 },
      models: {
        execution: (models['execution'] as ExecutionPolicyDescription | undefined) ?? null,
        commission: assumptions.execution.costs.commission,
        slippage: assumptions.execution.costs.slippage,
      },
      seed: assumptions.seed,
      benchmark: false,
      annualization: { periodsPerYear: assumptions.periodsPerYear, riskFreeRate: 0 },
      initialCapital: run.points.length > 0 ? run.points[0]!.equity : 0,
      baseCurrency: assumptions.baseCurrency,
      variations: null,
    };
  },
};

const ENVIRONMENT_INPUT_ROW_SETS = [
  ...PORTFOLIO_INPUT_ROW_SETS.map((label) => `definition.${label}`),
  'actions',
] as const;
const ENVIRONMENT_RESULT_ROW_SETS = [
  'steps',
  'rewards',
  ...PORTFOLIO_RESULT_ROW_SETS.map((label) => `result.${label}`),
] as const;
const ENVIRONMENT_RUN_KEYS = [
  'runId',
  'engineRunId',
  'definitionHash',
  'seed',
  'traceHash',
  'steps',
  'rewards',
  'rewardTotal',
  'terminated',
  'truncated',
  'reason',
  'result',
  'assumptions',
  'diagnostics',
] as const;

const ENVIRONMENT_SPEC: KindSpec<'environment'> = {
  descriptor: Object.freeze({
    kind: 'environment',
    runVersion: 1,
    operation: 'runEnvironmentEpisode',
    inputRowSets: ENVIRONMENT_INPUT_ROW_SETS,
    resultRowSets: ENVIRONMENT_RESULT_ROW_SETS.map((label) => `run.${label}`),
    callbackFields: ['definition.reward.goal', 'definition.instruments.<id>.adapter'],
    modelFields: ['definition.execution'],
  }),
  inputRowSets: ENVIRONMENT_INPUT_ROW_SETS.map(rowSet),
  resultRowSets: ENVIRONMENT_RESULT_ROW_SETS.map(resultRowSet),
  callbacks: [
    callbackAt('definition.reward.goal', (record) => {
      const reward = { ...(readPath(record, ['definition', 'reward']) as Record<string, unknown>) };
      reward['goal'] = '[caller function — not stored]';
      return withPath(record, ['definition', 'reward'], reward) as Record<string, unknown>;
    }),
  ],
  modelRoot: ['definition'],
  labeledModels: [],
  dynamicCallbacks: (record) => {
    const definition = record['definition'];
    if (definition === null || typeof definition !== 'object') return [];
    return portfolioCallbacks(definition as Record<string, unknown>).map((callback) => ({
      field: `definition.${callback.field}`,
      strip: (target) => ({
        ...target,
        definition: callback.strip(target['definition'] as Record<string, unknown>),
      }),
    }));
  },
  runKeys: ENVIRONMENT_RUN_KEYS,
  requireInput: (functionName, label, value) => {
    requireEnvironmentEpisodeInput(functionName, label, value);
  },
  run: runEnvironmentEpisode,
  identity: (run, storedInput) => {
    const engine = run.result.assumptions;
    const definition = readPath(storedInput, ['definition']) as Record<string, unknown>;
    return {
      runId: run.runId,
      childRunIds: [run.engineRunId],
      universeId: `environment:${engine.instruments.length}`,
      universeHistoryHash: contentHash(readPath(definition, ['instruments'])),
      strategy: { kind: 'environment', actions: run.steps.length, traceHash: run.traceHash },
      recipe: null,
      pointInTimePolicy: run.assumptions.nextObservationLaw,
      conventions: {
        conventionsVersion: run.assumptions.conventionsVersion,
        sessionInstantConvention: engine.sessionConvention,
        pricing: engine.markConvention,
      },
      calendar: {
        sessions: run.result.diagnostics.sessionCount,
        firstMarkTimestampMs:
          run.result.points.length > 0 ? run.result.points[0]!.timestampMs : null,
        lastMarkTimestampMs:
          run.result.points.length > 0
            ? run.result.points[run.result.points.length - 1]!.timestampMs
            : null,
      },
      engine: { operation: 'runEnvironmentEpisode', runVersion: 1 },
      models: {
        execution: (definition['execution'] as ExecutionPolicyDescription | undefined) ?? null,
        commission: engine.execution.costs.commission,
        slippage: engine.execution.costs.slippage,
      },
      seed: run.seed,
      benchmark:
        (definition['reward'] as { benchmark?: unknown } | undefined)?.benchmark !== undefined,
      annualization: { periodsPerYear: engine.periodsPerYear, riskFreeRate: 0 },
      initialCapital: run.result.points.length > 0 ? run.result.points[0]!.equity : 0,
      baseCurrency: engine.baseCurrency,
      variations: null,
    };
  },
};

const KIND_SPECS: { readonly [K in BacktestRunKind]: KindSpec<K> } = {
  'cross-sectional': CROSS_SECTIONAL_SPEC,
  'cross-sectional-grid': GRID_SPEC,
  options: OPTIONS_SPEC,
  portfolio: PORTFOLIO_SPEC,
  environment: ENVIRONMENT_SPEC,
};

export const BACKTEST_RUN_KIND_LIST: readonly BacktestRunKind[] = Object.freeze([
  'cross-sectional',
  'cross-sectional-grid',
  'options',
  'portfolio',
  'environment',
]);

/** The frozen data projection of the kind table — what an agent reads before choosing a kind. */
export const BACKTEST_RUN_KINDS: Readonly<Record<BacktestRunKind, BacktestRunKindDescriptor>> =
  Object.freeze({
    'cross-sectional': CROSS_SECTIONAL_SPEC.descriptor,
    'cross-sectional-grid': GRID_SPEC.descriptor,
    options: OPTIONS_SPEC.descriptor,
    portfolio: PORTFOLIO_SPEC.descriptor,
    environment: ENVIRONMENT_SPEC.descriptor,
  });

// ─────────────────────────────────────────── helpers ────────────────────────────────────────────

const REPORT_KEYS = [
  'kind',
  'runVersion',
  'run',
  'inputs',
  'referencedData',
  'runHash',
  'identity',
  'hygiene',
  'execution',
  'assumptions',
  'diagnostics',
] as const;
const ASSUMPTION_KEYS = [
  'conventionsVersion',
  'kind',
  'runVersion',
  'operation',
  'replayable',
  'nonReplayableField',
  'inputPolicy',
  'embeddedRowLimit',
  'modelPolicy',
  'projection',
] as const;
const DIAGNOSTIC_KEYS = ['warnings', 'embeddedRows', 'referencedRows', 'runWarningCount'] as const;
const HYGIENE_KEYS = ['researchProtocol', 'deflatedSharpe', 'backtestOverfitting'] as const;
const HYGIENE_REQUIRED: Record<(typeof HYGIENE_KEYS)[number], string> = {
  researchProtocol: 'deflatedSharpe',
  deflatedSharpe: 'deflatedSharpe',
  backtestOverfitting: 'backtestOverfittingProbability',
};
const MODEL_POLICY =
  'execution is stored as describeExecutionPolicy(policy); commission and slippage as their labels; replay takes the live models back as `models` and verifies each against its recorded description before the run';
const PROJECTION =
  'run = the verb result verbatim with referenced result row sets replaced by table handles; inputs = the request with bulk row sets embedded or replaced by verified table handles, caller functions omitted (recorded as nonReplayableField), and models by description';
const METRIC_NAMES = [
  'totalReturn',
  'annualizedReturn',
  'annualizedVolatility',
  'sharpe',
  'sortino',
  'calmar',
  'maxDrawdown',
  'hitRate',
  'profitFactor',
  'finalValue',
  'meanTurnover',
  'totalCosts',
] as const;

function fail(
  functionName: string,
  message: string,
  code: string,
  context: Record<string, unknown> = {},
): never {
  throw new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, ...context },
  });
}

function detach<T>(value: T): T {
  return fromCanonicalJson(canonicalJsonOf(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
  }
  return value;
}

function isArtifact(value: unknown): value is AnalysisArtifact {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'totalfinance.analysis-artifact'
  );
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readPath(record: unknown, path: Path): unknown {
  let cursor: unknown = record;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Copy-on-write along one path; every other reference is shared. */
function withPath(record: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const base =
    record !== null && typeof record === 'object' && !Array.isArray(record)
      ? (record as Record<string, unknown>)
      : {};
  return { ...base, [head!]: withPath(base[head!], rest, value) };
}

function scanEmbedded(
  functionName: string,
  label: string,
  value: unknown,
  maximumEmbeddedBytes: number,
): void {
  try {
    scanCanonicalData(value, {
      functionName,
      label,
      maximumWorkUnits: maximumEmbeddedBytes,
      requireFiniteNumbers: true,
    });
  } catch (error) {
    if (
      isQuantError(error, ErrorCode.InputOutOfRange) &&
      error.message.includes('data-work limit')
    ) {
      fail(
        functionName,
        `the embedded ${label} exceeds the embedded budget (${maximumEmbeddedBytes.toLocaleString()} work units ≈ canonical bytes) — reference its bulk row sets (referenceRowSets) or raise limits.maximumEmbeddedBytes up to ${BACKTEST_RUN_LIMITS.maximumEmbeddedBytes.maximum.toLocaleString()}.`,
        ErrorCode.ArtifactEmbeddedInputTooLarge,
        { field: label, maximumEmbeddedBytes },
      );
    }
    throw error;
  }
}

function requireKind(functionName: string, value: unknown): BacktestRunKind {
  if (typeof value !== 'string' || !(value in KIND_SPECS)) {
    fail(
      functionName,
      `kind must be one of ${BACKTEST_RUN_KIND_LIST.map((k) => `'${k}'`).join(' | ')}. Received ${value === null ? 'null' : JSON.stringify(value)}.`,
      ErrorCode.InputInvalidEnum,
      { field: 'kind' },
    );
  }
  return value as BacktestRunKind;
}

function specOf<K extends BacktestRunKind>(kind: K): KindSpec<K> {
  return KIND_SPECS[kind] as unknown as KindSpec<K>;
}

function requireSnapshotHash(functionName: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.startsWith('sha256:')) {
    fail(
      functionName,
      'snapshotHash must be a `sha256:` content hash when present.',
      ErrorCode.InputWrongType,
      { field: 'snapshotHash' },
    );
  }
  return value;
}

function requireHygieneBlock(
  functionName: string,
  field: string,
  value: unknown,
): BacktestHygieneBlock {
  requireArgumentObject(functionName, field, value);
  const block = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, block, HYGIENE_KEYS);
  for (const key of HYGIENE_KEYS) {
    if (!hasOwn(block, key)) continue;
    const member = block[key];
    requireArgumentObject(functionName, `${field}.${key}`, member);
    const required = HYGIENE_REQUIRED[key];
    const probe = (member as Record<string, unknown>)[required];
    if (typeof probe !== 'number' || !Number.isFinite(probe)) {
      fail(
        functionName,
        `${field}.${key}.${required} must be the finite number the @totalfinance/risk verb reported — attach the verdict verbatim.`,
        ErrorCode.InputWrongType,
        { field: `${field}.${key}.${required}` },
      );
    }
  }
  return value as BacktestHygieneBlock;
}

function requireRunShape(
  functionName: string,
  field: string,
  spec: KindSpec<BacktestRunKind>,
  value: unknown,
): void {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, spec.runKeys);
  for (const key of spec.runKeys) {
    if (!hasOwn(record, key)) {
      fail(
        functionName,
        `${field}.${key} is missing — a '${spec.descriptor.kind}' run is the verbatim result of ${spec.descriptor.operation}, which always reports it.`,
        ErrorCode.InputMissingField,
        { field: `${field}.${key}` },
      );
    }
  }
  requireArgumentObject(functionName, `${field}.assumptions`, record['assumptions']);
  requireArgumentObject(functionName, `${field}.diagnostics`, record['diagnostics']);
}

/** Models → descriptions and labels. Present-but-invalid models are refused (they could not have produced the run). */
function recordModels(
  functionName: string,
  input: Record<string, unknown>,
  root: Path,
): Record<string, unknown> {
  const request = readPath(input, root) as Record<string, unknown>;
  let working = { ...request };
  if (hasOwn(working, 'execution') && working['execution'] !== undefined) {
    const policy = working['execution'];
    if (
      policy === null ||
      typeof policy !== 'object' ||
      typeof (policy as { label?: unknown }).label !== 'string'
    ) {
      fail(
        functionName,
        `input.${[...root, 'execution'].join('.')} must be an execution policy (execution.simplified() or execution.declared(...)).`,
        ErrorCode.InputWrongType,
        { field: 'input.execution' },
      );
    }
    working = { ...working, execution: describeExecutionPolicy(policy as ExecutionPolicy) };
  }
  if (hasOwn(working, 'transactionCostModel') && working['transactionCostModel'] !== undefined) {
    const models = working['transactionCostModel'];
    requireArgumentObject(
      functionName,
      `input.${[...root, 'transactionCostModel'].join('.')}`,
      models,
    );
    const record = models as Record<string, unknown>;
    const labels: Record<string, string> = {};
    for (const key of ['commission', 'slippage'] as const) {
      if (!hasOwn(record, key) || record[key] === undefined) continue;
      const label = (record[key] as { label?: unknown } | null)?.label;
      if (typeof label !== 'string' || label.length === 0) {
        fail(
          functionName,
          `input.${[...root, 'transactionCostModel', key].join('.')} must be a labeled ${key} model (fees.* / slippage.*).`,
          ErrorCode.InputWrongType,
          { field: `input.transactionCostModel.${key}` },
        );
      }
      labels[key] = label;
    }
    working = { ...working, transactionCostModel: labels };
  }
  return withPath(input, root, working) as Record<string, unknown>;
}

/** Labeled cost models (fees.* / slippage.*) → their labels, at the kind's dotted paths. */
function recordLabeledModels(
  functionName: string,
  input: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  let working = input;
  for (const dotted of paths) {
    const path = dotted.split('.');
    const model = readPath(working, path);
    if (model === undefined) continue;
    const label = (model as { label?: unknown } | null)?.label;
    if (typeof label !== 'string' || label.length === 0) {
      fail(
        functionName,
        `input.${dotted} must be a labeled cost model (fees.* / slippage.*).`,
        ErrorCode.InputWrongType,
        { field: `input.${dotted}` },
      );
    }
    working = withPath(working, path, { label }) as Record<string, unknown>;
  }
  return working;
}

function projectRun(
  run: Record<string, unknown>,
  spec: KindSpec<BacktestRunKind>,
  referenced: readonly string[],
  locators: Record<string, string> | undefined,
): {
  stored: Record<string, unknown>;
  handles: Record<string, TableHandle>;
  embeddedRows: number;
  rowCounts: Record<string, number>;
} {
  let stored: Record<string, unknown> = run;
  const handles: Record<string, TableHandle> = {};
  const rowCounts: Record<string, number> = {};
  let embeddedRows = 0;
  for (const set of spec.resultRowSets) {
    const rows = readPath(run, set.path);
    if (!Array.isArray(rows)) continue;
    rowCounts[set.label] = rows.length;
    if (referenced.includes(set.label)) {
      const handle = tableHandleForRows({
        rows,
        ...(locators?.[set.label] !== undefined ? { locator: locators[set.label]! } : {}),
      });
      handles[set.label] = handle;
      stored = withPath(stored, set.path, handle) as Record<string, unknown>;
    } else {
      embeddedRows += rows.length;
    }
  }
  return { stored, handles, embeddedRows, rowCounts };
}

function buildReport(input: {
  spec: KindSpec<BacktestRunKind>;
  run: Record<string, unknown>;
  storedRun: Record<string, unknown>;
  storedInput: Record<string, unknown>;
  referencedData: Record<string, TableHandle>;
  hygiene: BacktestHygieneBlock | null;
  nonReplayableField: string | null;
  embeddedRows: number;
  embeddedRowLimit: number;
}): BacktestRunReport {
  const { spec } = input;
  const runHash = contentHash(input.storedRun);
  const referencedRows = Object.values(input.referencedData).reduce(
    (sum, handle) => sum + handle.rowCount,
    0,
  );
  const runWarnings = (input.run['diagnostics'] as { warnings?: unknown[] }).warnings;
  return {
    kind: spec.descriptor.kind,
    runVersion: spec.descriptor.runVersion,
    run: input.storedRun,
    inputs: input.storedInput,
    referencedData: input.referencedData,
    runHash,
    identity: spec.identity(input.run as never, input.storedInput),
    hygiene: input.hygiene,
    execution: { completed: true },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      kind: spec.descriptor.kind,
      runVersion: spec.descriptor.runVersion,
      operation: spec.descriptor.operation,
      replayable: input.nonReplayableField === null,
      nonReplayableField: input.nonReplayableField,
      inputPolicy: Object.keys(input.referencedData).length > 0 ? 'referenced' : 'embedded',
      embeddedRowLimit: input.embeddedRowLimit,
      modelPolicy: MODEL_POLICY,
      projection: PROJECTION,
    },
    diagnostics: {
      warnings: [],
      embeddedRows: input.embeddedRows,
      referencedRows,
      runWarningCount: Array.isArray(runWarnings) ? runWarnings.length : 0,
    },
  };
}

const IDENTITY_KEYS = [
  'runId',
  'childRunIds',
  'universeId',
  'universeHistoryHash',
  'strategy',
  'recipe',
  'pointInTimePolicy',
  'conventions',
  'calendar',
  'engine',
  'models',
  'seed',
  'benchmark',
  'annualization',
  'initialCapital',
  'baseCurrency',
  'variations',
] as const;

function requireIdentity(functionName: string, identity: Record<string, unknown>): void {
  ensureKnownKeys(functionName, 'report.identity', identity, IDENTITY_KEYS);
  for (const key of IDENTITY_KEYS) {
    if (!hasOwn(identity, key))
      fail(functionName, `report.identity.${key} is missing.`, ErrorCode.InputMissingField, {
        field: `report.identity.${key}`,
      });
  }
  const nonEmpty = (key: string): void => {
    if (typeof identity[key] !== 'string' || (identity[key] as string).length === 0) {
      fail(
        functionName,
        `report.identity.${key} must be a non-empty string. Received ${identity[key] === null ? 'null' : typeof identity[key]}.`,
        ErrorCode.InputWrongType,
        { field: `report.identity.${key}` },
      );
    }
  };
  for (const key of [
    'runId',
    'universeId',
    'universeHistoryHash',
    'pointInTimePolicy',
    'baseCurrency',
  ])
    nonEmpty(key);
  if (
    !(identity['runId'] as string).startsWith('sha256:') ||
    !(identity['universeHistoryHash'] as string).startsWith('sha256:')
  ) {
    fail(
      functionName,
      'report.identity.runId and universeHistoryHash must be `sha256:` content hashes.',
      ErrorCode.InputWrongType,
      { field: 'report.identity.runId' },
    );
  }
  const objectOrNull = (key: string, nullable: boolean): void => {
    const value = identity[key];
    if (value === null && nullable) return;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(
        functionName,
        `report.identity.${key} must be an object${nullable ? ' or null' : ''}. Received ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}.`,
        ErrorCode.InputWrongType,
        { field: `report.identity.${key}` },
      );
    }
  };
  for (const key of ['strategy', 'conventions', 'calendar', 'engine', 'models', 'annualization'])
    objectOrNull(key, false);
  objectOrNull('recipe', true);
  for (const key of ['childRunIds', 'variations']) {
    const value = identity[key];
    if (value !== null && !Array.isArray(value))
      fail(
        functionName,
        `report.identity.${key} must be an array or null.`,
        ErrorCode.InputWrongType,
        { field: `report.identity.${key}` },
      );
  }
  if (identity['seed'] !== null && !Number.isSafeInteger(identity['seed']))
    fail(
      functionName,
      'report.identity.seed must be a safe integer or null.',
      ErrorCode.InputWrongType,
      { field: 'report.identity.seed' },
    );
  if (typeof identity['benchmark'] !== 'boolean')
    fail(functionName, 'report.identity.benchmark must be a boolean.', ErrorCode.InputWrongType, {
      field: 'report.identity.benchmark',
    });
  if (
    typeof identity['initialCapital'] !== 'number' ||
    !Number.isFinite(identity['initialCapital']) ||
    (identity['initialCapital'] as number) <= 0
  ) {
    fail(
      functionName,
      'report.identity.initialCapital must be a positive finite number.',
      ErrorCode.InputOutOfRange,
      { field: 'report.identity.initialCapital' },
    );
  }
  const conventions = identity['conventions'] as Record<string, unknown>;
  ensureKnownKeys(functionName, 'report.identity.conventions', conventions, [
    'conventionsVersion',
    'sessionInstantConvention',
    'pricing',
  ]);
  for (const key of ['conventionsVersion', 'sessionInstantConvention', 'pricing']) {
    if (typeof conventions[key] !== 'string' || (conventions[key] as string).length === 0)
      fail(
        functionName,
        `report.identity.conventions.${key} must be a non-empty string.`,
        ErrorCode.InputWrongType,
        { field: `report.identity.conventions.${key}` },
      );
  }
  const engine = identity['engine'] as Record<string, unknown>;
  ensureKnownKeys(functionName, 'report.identity.engine', engine, ['operation', 'runVersion']);
  if (typeof engine['operation'] !== 'string' || !Number.isSafeInteger(engine['runVersion']))
    fail(
      functionName,
      'report.identity.engine must carry the operation name and an integer runVersion.',
      ErrorCode.InputWrongType,
      { field: 'report.identity.engine' },
    );
  const calendar = identity['calendar'] as Record<string, unknown>;
  ensureKnownKeys(functionName, 'report.identity.calendar', calendar, [
    'sessions',
    'firstMarkTimestampMs',
    'lastMarkTimestampMs',
  ]);
  if (!Number.isSafeInteger(calendar['sessions']) || (calendar['sessions'] as number) < 0)
    fail(
      functionName,
      'report.identity.calendar.sessions must be a non-negative safe integer.',
      ErrorCode.InputOutOfRange,
      { field: 'report.identity.calendar.sessions' },
    );
  for (const key of ['firstMarkTimestampMs', 'lastMarkTimestampMs']) {
    const value = calendar[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value)))
      fail(
        functionName,
        `report.identity.calendar.${key} must be a finite number or null.`,
        ErrorCode.InputWrongType,
        { field: `report.identity.calendar.${key}` },
      );
  }
  const annualization = identity['annualization'] as Record<string, unknown>;
  ensureKnownKeys(functionName, 'report.identity.annualization', annualization, [
    'periodsPerYear',
    'riskFreeRate',
  ]);
  if (
    typeof annualization['periodsPerYear'] !== 'number' ||
    !(annualization['periodsPerYear'] > 0) ||
    typeof annualization['riskFreeRate'] !== 'number' ||
    !Number.isFinite(annualization['riskFreeRate'])
  ) {
    fail(
      functionName,
      'report.identity.annualization must carry a positive periodsPerYear and a finite riskFreeRate.',
      ErrorCode.InputOutOfRange,
      { field: 'report.identity.annualization' },
    );
  }
  const models = identity['models'] as Record<string, unknown>;
  ensureKnownKeys(functionName, 'report.identity.models', models, [
    'execution',
    'commission',
    'slippage',
  ]);
  for (const key of ['commission', 'slippage']) {
    const value = models[key];
    if (value !== null && (typeof value !== 'string' || value.length === 0))
      fail(
        functionName,
        `report.identity.models.${key} must be a label or null.`,
        ErrorCode.InputWrongType,
        { field: `report.identity.models.${key}` },
      );
  }
  if (
    models['execution'] !== null &&
    (typeof models['execution'] !== 'object' || Array.isArray(models['execution']))
  )
    fail(
      functionName,
      'report.identity.models.execution must be an execution-policy description or null.',
      ErrorCode.InputWrongType,
      { field: 'report.identity.models.execution' },
    );
}

function requireReport(functionName: string, value: unknown): BacktestRunReport {
  requireArgumentObject(functionName, 'report', value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, 'report', record, REPORT_KEYS);
  for (const key of REPORT_KEYS) {
    if (!hasOwn(record, key))
      fail(
        functionName,
        `report.${key} is missing — not a backtest-run report.`,
        ErrorCode.InputMissingField,
        { field: `report.${key}` },
      );
  }
  const kind = requireKind(functionName, record['kind']);
  const spec = specOf(kind);
  if (record['runVersion'] !== spec.descriptor.runVersion) {
    fail(
      functionName,
      `report.runVersion is ${String(record['runVersion'])}; this library reads '${kind}' runs at version ${spec.descriptor.runVersion} — register a migration.`,
      ErrorCode.InputOutOfRange,
      { field: 'report.runVersion' },
    );
  }
  requireArgumentObject(functionName, 'report.run', record['run']);
  ensureKnownKeys(functionName, 'report.run', record['run'] as object, spec.runKeys);
  requireArgumentObject(functionName, 'report.inputs', record['inputs']);
  requireArgumentObject(functionName, 'report.referencedData', record['referencedData']);
  for (const [label, handle] of Object.entries(
    record['referencedData'] as Record<string, unknown>,
  )) {
    if (!isTableHandle(handle))
      fail(
        functionName,
        `report.referencedData.${label} is not a table handle.`,
        ErrorCode.InputWrongType,
        { field: `report.referencedData.${label}` },
      );
  }
  if (typeof record['runHash'] !== 'string' || !record['runHash'].startsWith('sha256:')) {
    fail(
      functionName,
      'report.runHash must be a `sha256:` content hash.',
      ErrorCode.InputWrongType,
      { field: 'report.runHash' },
    );
  }
  // The hash is the stored projection's: a report whose referenced result rows were restored by
  // the read door still verifies, because the handles stand in for the rows again here.
  let projection = record['run'] as Record<string, unknown>;
  for (const [label, handle] of Object.entries(
    record['referencedData'] as Record<string, TableHandle>,
  )) {
    const set = spec.resultRowSets.find((candidate) => candidate.label === label);
    if (set !== undefined && !isTableHandle(readPath(projection, set.path))) {
      projection = withPath(projection, set.path, handle) as Record<string, unknown>;
    }
  }
  const recomputedHash = contentHash(projection);
  if (recomputedHash !== record['runHash']) {
    fail(
      functionName,
      `report.runHash (${(record['runHash'] as string).slice(0, 18)}…) does not match the stored run (${recomputedHash.slice(0, 18)}…) — the report was altered after it was written.`,
      ErrorCode.ArtifactIdMismatch,
      { field: 'report.runHash' },
    );
  }
  requireArgumentObject(functionName, 'report.identity', record['identity']);
  requireIdentity(functionName, record['identity'] as Record<string, unknown>);
  if (record['hygiene'] !== null)
    requireHygieneBlock(functionName, 'report.hygiene', record['hygiene']);
  requireArgumentObject(functionName, 'report.execution', record['execution']);
  ensureKnownKeys(functionName, 'report.execution', record['execution'] as object, ['completed']);
  if ((record['execution'] as { completed?: unknown }).completed !== true) {
    fail(
      functionName,
      'report.execution.completed must be true — a partial run is a Stage 7B format and cannot be read yet.',
      ErrorCode.InputOutOfRange,
      { field: 'report.execution.completed' },
    );
  }
  requireArgumentObject(functionName, 'report.assumptions', record['assumptions']);
  ensureKnownKeys(
    functionName,
    'report.assumptions',
    record['assumptions'] as object,
    ASSUMPTION_KEYS,
  );
  const assumptions = record['assumptions'] as Record<string, unknown>;
  for (const key of ASSUMPTION_KEYS) {
    if (!hasOwn(assumptions, key))
      fail(functionName, `report.assumptions.${key} is missing.`, ErrorCode.InputMissingField, {
        field: `report.assumptions.${key}`,
      });
  }
  for (const key of ['conventionsVersion', 'operation', 'modelPolicy', 'projection'] as const) {
    if (typeof assumptions[key] !== 'string' || (assumptions[key] as string).length === 0) {
      fail(
        functionName,
        `report.assumptions.${key} must be a non-empty string. Received ${assumptions[key] === null ? 'null' : typeof assumptions[key]}.`,
        ErrorCode.InputWrongType,
        { field: `report.assumptions.${key}` },
      );
    }
  }
  if (assumptions['kind'] !== kind)
    fail(
      functionName,
      `report.assumptions.kind must repeat report.kind ('${kind}').`,
      ErrorCode.InputOutOfRange,
      { field: 'report.assumptions.kind' },
    );
  if (assumptions['runVersion'] !== record['runVersion'])
    fail(
      functionName,
      'report.assumptions.runVersion must repeat report.runVersion.',
      ErrorCode.InputOutOfRange,
      { field: 'report.assumptions.runVersion' },
    );
  if (assumptions['operation'] !== spec.descriptor.operation)
    fail(
      functionName,
      `report.assumptions.operation must be '${spec.descriptor.operation}' for a '${kind}' run.`,
      ErrorCode.InputOutOfRange,
      { field: 'report.assumptions.operation' },
    );
  if (typeof assumptions['replayable'] !== 'boolean')
    fail(
      functionName,
      'report.assumptions.replayable must be a boolean.',
      ErrorCode.InputWrongType,
      { field: 'report.assumptions.replayable' },
    );
  if (
    assumptions['nonReplayableField'] !== null &&
    (typeof assumptions['nonReplayableField'] !== 'string' ||
      (assumptions['nonReplayableField'] as string).length === 0)
  ) {
    fail(
      functionName,
      'report.assumptions.nonReplayableField must be a field path or null.',
      ErrorCode.InputWrongType,
      { field: 'report.assumptions.nonReplayableField' },
    );
  }
  if ((assumptions['replayable'] === true) !== (assumptions['nonReplayableField'] === null)) {
    fail(
      functionName,
      'report.assumptions.replayable contradicts nonReplayableField — a run is replayable exactly when no callback field is recorded.',
      ErrorCode.InputOutOfRange,
      { field: 'report.assumptions.replayable' },
    );
  }
  if (assumptions['inputPolicy'] !== 'embedded' && assumptions['inputPolicy'] !== 'referenced') {
    fail(
      functionName,
      `report.assumptions.inputPolicy must be 'embedded' | 'referenced'. Received ${JSON.stringify(assumptions['inputPolicy'])}.`,
      ErrorCode.InputInvalidEnum,
      { field: 'report.assumptions.inputPolicy' },
    );
  }
  if (
    (assumptions['inputPolicy'] === 'referenced') !==
    Object.keys(record['referencedData'] as object).length > 0
  ) {
    fail(
      functionName,
      'report.assumptions.inputPolicy contradicts referencedData — the policy is referenced exactly when a row set travels by handle.',
      ErrorCode.InputOutOfRange,
      { field: 'report.assumptions.inputPolicy' },
    );
  }
  requireArgumentObject(functionName, 'report.diagnostics', record['diagnostics']);
  const diagnostics = record['diagnostics'] as Record<string, unknown>;
  ensureKnownKeys(functionName, 'report.diagnostics', diagnostics, DIAGNOSTIC_KEYS);
  for (const key of ['embeddedRows', 'referencedRows', 'runWarningCount'] as const) {
    const count = diagnostics[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      fail(
        functionName,
        `report.diagnostics.${key} must be a non-negative safe integer. Received ${count === null ? 'null' : String(count)}.`,
        ErrorCode.InputOutOfRange,
        { field: `report.diagnostics.${key}` },
      );
    }
  }
  if (!Array.isArray(diagnostics['warnings'])) {
    fail(functionName, 'report.diagnostics.warnings must be an array.', ErrorCode.InputWrongType, {
      field: 'report.diagnostics.warnings',
    });
  }
  const embeddedRowLimit = assumptions['embeddedRowLimit'];
  if (!Number.isSafeInteger(embeddedRowLimit) || (embeddedRowLimit as number) < 1) {
    fail(
      functionName,
      `report.assumptions.embeddedRowLimit must be a positive safe integer. Received ${embeddedRowLimit === null ? 'null' : String(embeddedRowLimit)}.`,
      ErrorCode.InputOutOfRange,
      { field: 'report.assumptions.embeddedRowLimit' },
    );
  }
  return value as BacktestRunReport;
}

// ─────────────────────────────────────────── the verbs ──────────────────────────────────────────

/**
 * Describe a run and save it as an identified, immutable artifact.
 *
 * @example
 * ```ts
 * const run = crossSectionalBacktest(request);
 * const artifact = backtestRunArtifact({
 *   kind: 'cross-sectional',
 *   run,
 *   input: request,
 *   referenceRowSets: ['dataset.returns', 'run.ledger.events'],
 * });
 * ```
 */
export function backtestRunArtifact<Kind extends BacktestRunKind>(
  input: BacktestRunArtifactInput<Kind>,
): AnalysisArtifact {
  const functionName = 'backtestRunArtifact';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, [
    'kind',
    'run',
    'input',
    'referenceRowSets',
    'locators',
    'hygiene',
    'snapshotHash',
    'libraryVersion',
    'createdFrom',
    'provenance',
    'limits',
  ]);
  const kind = requireKind(functionName, input.kind);
  const spec = specOf(kind) as KindSpec<BacktestRunKind>;
  if (input.limits !== undefined) {
    requireArgumentObject(functionName, 'limits', input.limits);
    ensureKnownKeys(functionName, 'limits', input.limits, [
      'maximumEmbeddedBytes',
      'embeddedRowLimit',
    ]);
  }
  const maximumEmbeddedBytes = requireWorkLimit({
    functionName,
    field: 'limits.maximumEmbeddedBytes',
    value: input.limits?.maximumEmbeddedBytes,
    law: BACKTEST_RUN_LIMITS.maximumEmbeddedBytes,
  });
  const embeddedRowLimit = requireWorkLimit({
    functionName,
    field: 'limits.embeddedRowLimit',
    value: input.limits?.embeddedRowLimit,
    law: BACKTEST_RUN_LIMITS.embeddedRowLimit,
  });
  const snapshotHash = requireSnapshotHash(functionName, input.snapshotHash);
  if (
    input.libraryVersion !== undefined &&
    (typeof input.libraryVersion !== 'string' || input.libraryVersion.length === 0)
  ) {
    fail(
      functionName,
      'libraryVersion must be a non-empty version string when present.',
      ErrorCode.InputWrongType,
      { field: 'libraryVersion' },
    );
  }
  if (input.createdFrom !== undefined)
    requireArgumentArray(functionName, 'createdFrom', input.createdFrom);
  if (input.referenceRowSets !== undefined)
    requireArgumentArray(functionName, 'referenceRowSets', input.referenceRowSets);
  const referenceRowSets = input.referenceRowSets ?? [];
  const knownLabels = [
    ...spec.inputRowSets.map((s) => s.label),
    ...spec.resultRowSets.map((s) => s.label),
  ];
  for (const name of referenceRowSets) {
    if (typeof name !== 'string' || !knownLabels.includes(name)) {
      fail(
        functionName,
        `referenceRowSets names ${JSON.stringify(name)}, which is not a bulk row set of a '${kind}' run — its row sets are ${knownLabels.join(', ')}.`,
        ErrorCode.InputInvalidEnum,
        { field: 'referenceRowSets', kind },
      );
    }
  }
  if (input.locators !== undefined) {
    requireArgumentObject(functionName, 'locators', input.locators);
    for (const [name, locator] of Object.entries(input.locators)) {
      if (!referenceRowSets.includes(name))
        fail(
          functionName,
          `locators.${name} names a row set that is not being referenced — list it in referenceRowSets.`,
          ErrorCode.InputUnknownField,
          { field: `locators.${name}` },
        );
      if (typeof locator !== 'string' || locator.length === 0)
        fail(
          functionName,
          `locators.${name} must be a non-empty storage locator string.`,
          ErrorCode.InputWrongType,
          { field: `locators.${name}` },
        );
    }
  }

  // The run: the verb's result, a plain acyclic finite value.
  requireRunShape(functionName, 'run', spec, input.run);
  const projected = projectRun(
    input.run as unknown as Record<string, unknown>,
    spec,
    referenceRowSets,
    input.locators,
  );
  for (const [label, count] of Object.entries(projected.rowCounts)) {
    if (!referenceRowSets.includes(label) && count > embeddedRowLimit) {
      fail(
        functionName,
        `${label} has ${count} rows, above the embedded row limit ${embeddedRowLimit} — nothing is truncated silently. Reference the row set (referenceRowSets: ['${label}'], which stores its content hash and row count) or raise limits.embeddedRowLimit up to ${BACKTEST_RUN_LIMITS.embeddedRowLimit.maximum}.`,
        ErrorCode.ArtifactEmbeddedInputTooLarge,
        { field: label, rows: count, embeddedRowLimit },
      );
    }
  }
  scanEmbedded(functionName, 'run', projected.stored, maximumEmbeddedBytes);
  const storedRun = detach(projected.stored);

  // The request: the verb's own guard first (an artifact stores only a request the verb accepts),
  // then callbacks recorded and stripped, models by description, rows embedded or referenced.
  requireArgumentObject(functionName, 'input', input.input);
  spec.requireInput(functionName, 'input', input.input);
  let working = { ...(input.input as unknown as Record<string, unknown>) };
  let nonReplayableField: string | null = null;
  for (const callback of spec.callbacks) {
    const value = readPath(working, callback.path);
    if (value === undefined) continue;
    if (typeof value !== 'function') {
      fail(
        functionName,
        `input.${callback.field} is present but not a function — ${spec.descriptor.operation} would have refused this request, so it cannot be the request that produced the run.`,
        ErrorCode.InputWrongType,
        { field: `input.${callback.field}` },
      );
    }
    nonReplayableField = nonReplayableField ?? callback.field;
    working = callback.strip(working);
  }
  for (const callback of spec.dynamicCallbacks(working)) {
    nonReplayableField = nonReplayableField ?? callback.field;
    working = callback.strip(working);
  }
  working = recordModels(functionName, working, spec.modelRoot);
  working = recordLabeledModels(functionName, working, spec.labeledModels);
  scanEmbedded(functionName, 'input', working, maximumEmbeddedBytes);
  let storedInput: Record<string, unknown> = detach(working);
  const referencedData: Record<string, TableHandle> = { ...projected.handles };
  let embeddedRows = projected.embeddedRows;
  for (const set of spec.inputRowSets) {
    const rows = readPath(storedInput, set.path);
    if (rows === undefined) {
      if (referenceRowSets.includes(set.label))
        fail(
          functionName,
          `referenceRowSets names '${set.label}', which this request does not carry.`,
          ErrorCode.InputInvalidEnum,
          { field: 'referenceRowSets' },
        );
      continue;
    }
    if (!Array.isArray(rows))
      fail(
        functionName,
        `input.${set.label} must be the row array ${spec.descriptor.operation} consumed. Received ${rows === null ? 'null' : typeof rows}.`,
        ErrorCode.InputWrongType,
        { field: `input.${set.label}` },
      );
    if (referenceRowSets.includes(set.label)) {
      const handle = tableHandleForRows({
        rows,
        ...(input.locators?.[set.label] !== undefined
          ? { locator: input.locators[set.label]! }
          : {}),
      });
      referencedData[set.label] = handle;
      storedInput = withPath(storedInput, set.path, handle) as Record<string, unknown>;
    } else if (rows.length > embeddedRowLimit) {
      fail(
        functionName,
        `input.${set.label} has ${rows.length} rows, above the embedded row limit ${embeddedRowLimit} — nothing is truncated silently. Reference the row set (referenceRowSets: ['${set.label}']) or raise limits.embeddedRowLimit up to ${BACKTEST_RUN_LIMITS.embeddedRowLimit.maximum}.`,
        ErrorCode.ArtifactEmbeddedInputTooLarge,
        { field: `input.${set.label}`, rows: rows.length, embeddedRowLimit },
      );
    } else {
      embeddedRows += rows.length;
    }
  }
  const storedBytes = canonicalJsonOf(storedInput).length + canonicalJsonOf(storedRun).length;
  if (storedBytes > maximumEmbeddedBytes) {
    fail(
      functionName,
      `the embedded request and run are ${storedBytes.toLocaleString()} canonical bytes, above the limit ${maximumEmbeddedBytes.toLocaleString()} — reference the bulk row sets (referenceRowSets) or raise limits.maximumEmbeddedBytes up to ${BACKTEST_RUN_LIMITS.maximumEmbeddedBytes.maximum.toLocaleString()}.`,
      ErrorCode.ArtifactEmbeddedInputTooLarge,
      { field: 'input', bytes: storedBytes, maximumEmbeddedBytes },
    );
  }

  // Hygiene: a single run takes the caller's verdicts verbatim; a grid carries its own.
  let hygiene: BacktestHygieneBlock | null = null;
  if (kind === 'cross-sectional-grid') {
    if (input.hygiene !== undefined)
      fail(
        functionName,
        "a 'cross-sectional-grid' run carries its own hygiene at run.hygiene — omit input.hygiene.",
        ErrorCode.InputUnknownField,
        { field: 'hygiene' },
      );
    const own = (input.run as unknown as CrossSectionalBacktestGridResult).hygiene;
    const block: BacktestHygieneBlock = {
      ...(own.researchProtocol !== null
        ? { researchProtocol: detach(own.researchProtocol) as unknown as Record<string, unknown> }
        : {}),
      ...(own.deflatedSharpe !== null
        ? { deflatedSharpe: detach(own.deflatedSharpe) as unknown as Record<string, unknown> }
        : {}),
      ...(own.backtestOverfitting !== null
        ? {
            backtestOverfitting: detach(own.backtestOverfitting) as unknown as Record<
              string,
              unknown
            >,
          }
        : {}),
    };
    hygiene = Object.keys(block).length > 0 ? block : null;
  } else if (input.hygiene !== undefined) {
    hygiene = detach(requireHygieneBlock(functionName, 'hygiene', input.hygiene));
  }

  const report = buildReport({
    spec,
    run: input.run as unknown as Record<string, unknown>,
    storedRun,
    storedInput,
    referencedData,
    hygiene,
    nonReplayableField,
    embeddedRows,
    embeddedRowLimit,
  });
  const referenced = Object.fromEntries(
    Object.keys(referencedData)
      .sort()
      .map((label) => [label, referencedData[label]!.contentHash]),
  );
  return createAnalysisArtifact({
    artifactType: BACKTEST_RUN_ARTIFACT_TYPE,
    producedBy: {
      operation: spec.descriptor.operation,
      ...(input.libraryVersion !== undefined ? { libraryVersion: input.libraryVersion } : {}),
    },
    inputs: {
      ...(snapshotHash !== null ? { snapshotHash } : {}),
      parameters: {
        kind,
        runVersion: spec.descriptor.runVersion,
        runHash: report.runHash,
        runId: report.identity.runId,
        referenced,
      },
    },
    ...(input.createdFrom !== undefined ? { createdFrom: input.createdFrom } : {}),
    result: report,
    ...(Object.keys(referencedData).length > 0 ? { tables: referencedData } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  });
}

/** Restore referenced row sets into a report from supplied rows, each verified against its handle. */
function restoreRows(
  functionName: string,
  report: BacktestRunReport,
  referencedData: Record<string, readonly unknown[]> | undefined,
  required: boolean,
): { report: BacktestRunReport; restored: string[] } {
  const spec = specOf(report.kind);
  let run = report.run;
  let inputs = report.inputs;
  const restored: string[] = [];
  for (const label of Object.keys(report.referencedData).sort()) {
    const handle = report.referencedData[label]!;
    const rows = referencedData?.[label];
    if (rows === undefined) {
      if (required && !label.startsWith('run.'))
        fail(
          functionName,
          `the artifact references its '${label}' row set by table handle (${handle.rowCount} rows, ${handle.contentHash.slice(0, 18)}…) — supply the rows as referencedData['${label}'] to replay.`,
          ErrorCode.InputMissingField,
          { field: `referencedData.${label}` },
        );
      continue;
    }
    const verified = detach(verifyReferencedRows({ functionName, label, handle, rows }));
    const resultSet = spec.resultRowSets.find((s) => s.label === label);
    if (resultSet !== undefined)
      run = withPath(run, resultSet.path, verified) as Record<string, unknown>;
    else {
      const inputSet = spec.inputRowSets.find((s) => s.label === label)!;
      inputs = withPath(inputs, inputSet.path, verified) as Record<string, unknown>;
    }
    restored.push(label);
  }
  if (referencedData !== undefined) {
    for (const label of Object.keys(referencedData)) {
      if (!(label in report.referencedData))
        fail(
          functionName,
          `referencedData['${label}'] names a row set the artifact does not reference — its referenced row sets are ${Object.keys(report.referencedData).sort().join(', ') || 'none'}.`,
          ErrorCode.InputUnknownField,
          { field: `referencedData.${label}` },
        );
    }
  }
  return { report: { ...report, run, inputs }, restored };
}

/**
 * Restore a run artifact: Gate B's read door, a foreign-type refusal, the run-level migration policy,
 * the report re-validated (its run hash recomputed), and any supplied referenced rows verified by
 * hash and restored into the report.
 */
export function readBacktestRun(input: {
  /** The artifact as held OR as restored from JSON (`fromCanonicalJson`) — validated at runtime, never trusted by declaration. */
  artifact: unknown;
  migrations?: ArtifactMigrationRegistry;
  /** Rows for referenced row sets, keyed by label; each is verified against its handle before it is restored. */
  referencedData?: Record<string, readonly unknown[]>;
}): ReadBacktestRunResult {
  const functionName = 'readBacktestRun';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['artifact', 'migrations', 'referencedData']);
  if (input.referencedData !== undefined)
    requireArgumentObject(functionName, 'referencedData', input.referencedData);
  const read = readAnalysisArtifact({
    artifact: input.artifact,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
  });
  const artifact = read.artifact;
  if (artifact.artifactType !== BACKTEST_RUN_ARTIFACT_TYPE) {
    fail(
      functionName,
      `the artifact's type is '${artifact.artifactType}', not '${BACKTEST_RUN_ARTIFACT_TYPE}' — this reader restores backtest runs only; ${artifact.artifactType.startsWith('research.') ? 'use @totalfinance/research/artifacts' : artifact.artifactType.startsWith('volatility.') ? 'use @totalfinance/volatility/artifacts' : artifact.artifactType.startsWith('fixed-income.') ? 'use @totalfinance/fixed-income/artifacts' : 'read it with the package that owns that type'}.`,
      ErrorCode.ArtifactFamilyMismatch,
      { artifactType: artifact.artifactType },
    );
  }
  const raw = artifact.result as Record<string, unknown>;
  const kind = requireKind(functionName, raw['kind']);
  const migrated = applyReportMigrations({
    functionName,
    kind: `${BACKTEST_RUN_ARTIFACT_TYPE}:${kind}`,
    report: raw,
    storedVersion: raw['runVersion'],
    currentVersion: specOf(kind).descriptor.runVersion,
    versionField: 'runVersion',
    subject: `'${kind}' run`,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
  });
  const validated = requireReport(functionName, migrated.report);
  const { report, restored } = restoreRows(
    functionName,
    detach(validated),
    input.referencedData,
    false,
  );
  return {
    report: deepFreeze(report),
    artifact,
    migrationsApplied: read.migrationsApplied,
    modelMigrationsApplied: migrated.modelMigrationsApplied,
    restoredRowSets: restored,
  };
}

function liveModels(
  functionName: string,
  report: BacktestRunReport,
  models: ReplayModels | undefined,
): {
  request: Record<string, unknown>;
  execution: 'recorded-default' | 'supplied' | 'none';
  transactionCostModel: 'supplied' | 'none';
} {
  const spec = specOf(report.kind);
  let request = report.inputs;
  const recorded = readPath(request, spec.modelRoot) as Record<string, unknown>;
  let executionMode: 'recorded-default' | 'supplied' | 'none' = 'none';
  let costMode: 'supplied' | 'none' = 'none';
  if (models !== undefined) {
    requireArgumentObject(functionName, 'models', models);
    ensureKnownKeys(functionName, 'models', models, [
      'execution',
      'transactionCostModel',
      'labeled',
    ]);
  }
  // The options kind's labeled models: each recorded label must be supplied by a model carrying it.
  const labeledSupplied = models?.labeled ?? {};
  if (models?.labeled !== undefined)
    requireArgumentObject(functionName, 'models.labeled', models.labeled);
  for (const dotted of spec.labeledModels) {
    const recordedLabel = (readPath(request, dotted.split('.')) as { label?: unknown } | undefined)
      ?.label;
    const model = labeledSupplied[dotted];
    if (recordedLabel === undefined) {
      if (model !== undefined)
        fail(
          functionName,
          `models.labeled['${dotted}'] was supplied but the run recorded no model there — omit it.`,
          ErrorCode.InputUnknownField,
          { field: `models.labeled.${dotted}` },
        );
      continue;
    }
    if (model === undefined)
      fail(
        functionName,
        `the run recorded the model '${String(recordedLabel)}' at ${dotted} that no artifact can carry — supply the live model as models.labeled['${dotted}']; its label is verified before the run.`,
        ErrorCode.InputMissingField,
        { field: `models.labeled.${dotted}`, label: recordedLabel },
      );
    if (model.label !== recordedLabel)
      fail(
        functionName,
        `models.labeled['${dotted}'] is '${model.label}'; the run recorded '${String(recordedLabel)}'. A replay runs the models the run ran.`,
        ErrorCode.BacktestAdapterNonconformant,
        { field: `models.labeled.${dotted}`, recorded: recordedLabel, supplied: model.label },
      );
    request = withPath(request, dotted.split('.'), model) as Record<string, unknown>;
  }
  for (const key of Object.keys(labeledSupplied)) {
    if (!spec.labeledModels.includes(key))
      fail(
        functionName,
        `models.labeled['${key}'] names no model path of a '${report.kind}' run — its model paths are ${spec.labeledModels.join(', ') || 'none'}.`,
        ErrorCode.InputUnknownField,
        { field: `models.labeled.${key}` },
      );
  }
  const executionField = [...spec.modelRoot, 'execution'].join('.');
  if (recorded['execution'] !== undefined) {
    const description = recorded['execution'] as ExecutionPolicyDescription;
    let policy: ExecutionPolicy;
    if (models?.execution !== undefined) {
      policy = models.execution;
      executionMode = 'supplied';
    } else if (description.realism === 'simplified') {
      policy = executionPolicies.simplified();
      executionMode = 'recorded-default';
    } else {
      fail(
        functionName,
        `the run recorded a declared execution policy ('${description.label}') that no artifact can carry — supply the live policy as models.execution; it is verified against the recorded description before the run.`,
        ErrorCode.InputMissingField,
        { field: 'models.execution', label: description.label },
      );
    }
    const supplied = describeExecutionPolicy(policy);
    if (canonicalJsonOf(supplied) !== canonicalJsonOf(description)) {
      fail(
        functionName,
        `models.execution does not match the recorded execution policy — recorded '${description.label}' (${description.realism}), supplied '${supplied.label}' (${supplied.realism}). A replay runs the policy the run ran.`,
        ErrorCode.BacktestAdapterNonconformant,
        { field: 'models.execution', recorded: description.label, supplied: supplied.label },
      );
    }
    request = withPath(request, [...spec.modelRoot, 'execution'], policy) as Record<
      string,
      unknown
    >;
  } else if (models?.execution !== undefined) {
    fail(
      functionName,
      `models.execution was supplied but the run recorded no execution policy at ${executionField} (it ran the simplified default) — omit models.execution.`,
      ErrorCode.InputUnknownField,
      { field: 'models.execution' },
    );
  }
  if (recorded['transactionCostModel'] !== undefined) {
    const labels = recorded['transactionCostModel'] as Record<string, string>;
    const supplied = models?.transactionCostModel;
    if (supplied === undefined) {
      fail(
        functionName,
        `the run recorded transaction-cost models by label (${Object.entries(labels)
          .map(([k, v]) => `${k}: ${v}`)
          .join(
            ', ',
          )}) that no artifact can carry — supply the live models as models.transactionCostModel; each label is verified before the run.`,
        ErrorCode.InputMissingField,
        { field: 'models.transactionCostModel', labels },
      );
    }
    requireArgumentObject(functionName, 'models.transactionCostModel', supplied);
    ensureKnownKeys(functionName, 'models.transactionCostModel', supplied as object, [
      'commission',
      'slippage',
    ]);
    const live: Record<string, unknown> = {};
    for (const key of ['commission', 'slippage'] as const) {
      const recordedLabel = labels[key];
      const model = supplied[key];
      if (recordedLabel === undefined) {
        if (model !== undefined)
          fail(
            functionName,
            `models.transactionCostModel.${key} was supplied but the run recorded no ${key} model — omit it.`,
            ErrorCode.InputUnknownField,
            { field: `models.transactionCostModel.${key}` },
          );
        continue;
      }
      if (model === undefined)
        fail(
          functionName,
          `models.transactionCostModel.${key} is missing — the run recorded '${recordedLabel}'.`,
          ErrorCode.InputMissingField,
          { field: `models.transactionCostModel.${key}` },
        );
      if (model.label !== recordedLabel)
        fail(
          functionName,
          `models.transactionCostModel.${key} is '${model.label}'; the run recorded '${recordedLabel}'. A replay runs the models the run ran.`,
          ErrorCode.BacktestAdapterNonconformant,
          {
            field: `models.transactionCostModel.${key}`,
            recorded: recordedLabel,
            supplied: model.label,
          },
        );
      live[key] = model;
    }
    request = withPath(request, [...spec.modelRoot, 'transactionCostModel'], live) as Record<
      string,
      unknown
    >;
    costMode = 'supplied';
  } else if (models?.transactionCostModel !== undefined) {
    fail(
      functionName,
      'models.transactionCostModel was supplied but the run recorded no transaction-cost models — omit it.',
      ErrorCode.InputUnknownField,
      { field: 'models.transactionCostModel' },
    );
  }
  return { request, execution: executionMode, transactionCostModel: costMode };
}

/**
 * Re-issue the run's verb from the stored request (referenced rows supplied and re-verified, models
 * taken back and verified against their recorded descriptions) and compare the recomputed run hash
 * with the saved one. A run that recorded a caller function refuses by name.
 */
export function replayBacktestRun(input: {
  artifact: unknown;
  migrations?: ArtifactMigrationRegistry;
  referencedData?: Record<string, readonly unknown[]>;
  models?: ReplayModels;
  libraryVersion?: string;
  limits?: ComparisonLimits;
}): BacktestRunReplay {
  const functionName = 'replayBacktestRun';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, [
    'artifact',
    'migrations',
    'referencedData',
    'models',
    'libraryVersion',
    'limits',
  ]);
  if (input.referencedData !== undefined)
    requireArgumentObject(functionName, 'referencedData', input.referencedData);
  const read = readBacktestRun({
    artifact: input.artifact,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
  });
  const report = read.report;
  const spec = specOf(report.kind) as KindSpec<BacktestRunKind>;
  if (!report.assumptions.replayable) {
    fail(
      functionName,
      `the '${report.kind}' run is not replayable: its request carried a caller function at ${report.assumptions.nonReplayableField ?? '(unrecorded)'} that no artifact can store — re-run ${spec.descriptor.operation} with the declarative form of that input and save that run.`,
      ErrorCode.ArtifactNotReplayable,
      { kind: report.kind, field: report.assumptions.nonReplayableField },
    );
  }
  const restored = restoreRows(functionName, report, input.referencedData, true).report;
  const referencedResultSets = Object.keys(report.referencedData).filter((label) =>
    label.startsWith('run.'),
  );
  const models = liveModels(functionName, restored, input.models);
  const recomputedRun = spec.run(models.request as never) as unknown as Record<string, unknown>;
  const projected = projectRun(recomputedRun, spec, referencedResultSets, undefined);
  const recomputedReport = buildReport({
    spec,
    run: recomputedRun,
    storedRun: detach(projected.stored),
    storedInput: report.inputs,
    referencedData: { ...report.referencedData, ...projected.handles },
    hygiene: report.hygiene,
    nonReplayableField: report.assumptions.nonReplayableField,
    embeddedRows: report.diagnostics.embeddedRows,
    embeddedRowLimit: report.assumptions.embeddedRowLimit,
  });
  const parity = artifactReplayParity({
    saved: report.run,
    recomputed: recomputedReport.run,
    ...(input.limits !== undefined ? { limits: input.limits } : {}),
  });
  const warnings: QuantWarning[] = [];
  const saved = read.artifact.producedBy.libraryVersion ?? null;
  const current = input.libraryVersion ?? null;
  if (saved !== null && current !== null && saved !== current) {
    warnings.push(
      warning(
        WarningCode.ArtifactLibraryVersionDiffers,
        `${functionName}: the artifact was produced by library version ${saved}; this replay runs ${current} — a parity difference may be a library change rather than a data change.`,
        'warn',
        { saved, current },
      ),
    );
  }
  if (!parity.identical) {
    warnings.push(
      warning(
        WarningCode.ArtifactLibraryVersionDiffers,
        `${functionName}: replay parity FAILED for '${report.kind}' — ${parity.differenceCount} difference${parity.differenceCount === 1 ? '' : 's'} between the saved run and the recomputation (first at ${parity.differences[0]?.path ?? parity.addedPaths[0] ?? parity.removedPaths[0] ?? '(unknown)'}). An engine is deterministic given its inputs, so this is a finding: a changed engine, dependency, model, or platform.`,
        'warn',
        { differenceCount: parity.differenceCount },
      ),
    );
  }
  return deepFreeze({
    kind: report.kind,
    artifactId: read.artifact.id,
    recomputed: deepFreeze(recomputedReport),
    runHash: { saved: report.runHash, recomputed: recomputedReport.runHash },
    matches: report.runHash === recomputedReport.runHash,
    parity,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      kind: report.kind,
      runVersion: report.runVersion,
      operation: spec.descriptor.operation,
      libraryVersion: { saved, current },
      referencedRowSets: Object.keys(report.referencedData).sort(),
      models: { execution: models.execution, transactionCostModel: models.transactionCostModel },
    },
    diagnostics: { warnings },
  });
}

// ─────────────────────────────────────────── comparison ─────────────────────────────────────────

function resolveRun(
  functionName: string,
  value: unknown,
  field: string,
): { report: BacktestRunReport; artifactId: string | null } {
  if (isArtifact(value)) {
    const read = readBacktestRun({ artifact: value });
    return { report: read.report, artifactId: read.artifact.id };
  }
  requireArgumentObject(functionName, field, value);
  return { report: requireReport(functionName, value), artifactId: null };
}

/** The run as stored: referenced result row sets as their handles (a hydrated report projects back). */
function storedProjection(report: BacktestRunReport): Record<string, unknown> {
  const spec = specOf(report.kind);
  let projection = report.run;
  for (const [label, handle] of Object.entries(report.referencedData)) {
    const set = spec.resultRowSets.find((candidate) => candidate.label === label);
    if (set !== undefined && !isTableHandle(readPath(projection, set.path))) {
      projection = withPath(projection, set.path, handle) as Record<string, unknown>;
    }
  }
  return projection;
}

function idList(ids: readonly string[], listedIds: number): IdListSection {
  const sorted = [...ids].sort();
  return {
    count: sorted.length,
    ids: sorted.slice(0, listedIds),
    remainderCount: Math.max(0, sorted.length - listedIds),
  };
}

function membership(
  baseline: readonly string[],
  candidate: readonly string[],
  listedIds: number,
): MembershipSection {
  const left = new Set(baseline);
  const right = new Set(candidate);
  return {
    entered: idList(
      [...right].filter((id) => !left.has(id)),
      listedIds,
    ),
    exited: idList(
      [...left].filter((id) => !right.has(id)),
      listedIds,
    ),
    kept: idList(
      [...left].filter((id) => right.has(id)),
      listedIds,
    ),
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metricsOf(report: BacktestRunReport): Record<string, number | null> {
  const run = report.run;
  if (report.kind === 'cross-sectional-grid') {
    const best = run['best'] as { index: number; value: number } | null;
    const variations = run['variations'];
    const row =
      best !== null && Array.isArray(variations)
        ? (variations[best.index] as { metrics?: Record<string, unknown> } | undefined)
        : undefined;
    const metrics = row?.metrics ?? {};
    return Object.fromEntries(METRIC_NAMES.map((name) => [name, finiteOrNull(metrics[name])]));
  }
  // an environment episode carries the engine's own result under `result`
  const root =
    report.kind === 'environment' ? ((run['result'] ?? {}) as Record<string, unknown>) : run;
  const performance = (root['performance'] ?? {}) as Record<string, unknown>;
  const rebalances = root['rebalances'];
  let turnover: number | null = null;
  let costs: number | null = null;
  if (Array.isArray(rebalances)) {
    let t = 0;
    let c = 0;
    for (const r of rebalances as Array<{ turnover?: number; costs?: number }>) {
      t += finiteOrNull(r.turnover) ?? 0;
      c += finiteOrNull(r.costs) ?? 0;
    }
    turnover = rebalances.length > 0 ? t / rebalances.length : null;
    costs = c;
  }
  return {
    ...Object.fromEntries(
      METRIC_NAMES.filter(
        (n) => n !== 'finalValue' && n !== 'meanTurnover' && n !== 'totalCosts',
      ).map((name) => [name, finiteOrNull(performance[name])]),
    ),
    finalValue: finiteOrNull(root['finalValue']),
    meanTurnover: turnover,
    totalCosts: costs,
  };
}

function finalHoldings(report: BacktestRunReport): string[] | null {
  const holdings = report.run['holdings'];
  const rebalances = report.run['rebalances'];
  if (!Array.isArray(holdings) || !Array.isArray(rebalances) || rebalances.length === 0)
    return null;
  const last = rebalances.length - 1;
  return (holdings as Array<{ rebalanceIndex: number; instrumentId: string; quantity: number }>)
    .filter((h) => h.rebalanceIndex === last && h.quantity !== 0)
    .map((h) => h.instrumentId);
}

function hygieneVerdict(report: BacktestRunReport): string | null {
  const verdict = report.hygiene?.researchProtocol?.['verdict'];
  return typeof verdict === 'string' ? verdict : null;
}

/** Compare two runs of one kind: metric deltas, holdings membership, rebalance-by-rebalance turnover and cost deltas, grid variation deltas, the hygiene verdict, and the structural diff. */
export function compareBacktestRuns<Kind extends BacktestRunKind>(input: {
  baseline: BacktestRunReport<Kind> | AnalysisArtifact;
  candidate: BacktestRunReport<Kind> | AnalysisArtifact;
  tolerance?: ComparisonTolerance;
  limits?: ComparisonLimits & { listedIds?: number };
}): BacktestRunComparison<Kind> {
  const functionName = 'compareBacktestRuns';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['baseline', 'candidate', 'tolerance', 'limits']);
  const tolerance = requireComparisonTolerance({ functionName, tolerance: input.tolerance });
  if (input.limits !== undefined) {
    requireArgumentObject(functionName, 'limits', input.limits);
    ensureKnownKeys(functionName, 'limits', input.limits, [
      'maximumDifferences',
      'maximumLeaves',
      'listedIds',
    ]);
  }
  const listedIds = requireWorkLimit({
    functionName,
    field: 'limits.listedIds',
    value: input.limits?.listedIds,
    law: BACKTEST_RUN_LIMITS.listedIds,
  });
  const maximumDifferences = requireWorkLimit({
    functionName,
    field: 'limits.maximumDifferences',
    value: input.limits?.maximumDifferences,
    law: BACKTEST_RUN_LIMITS.maximumDifferences,
  });
  const maximumLeaves = requireWorkLimit({
    functionName,
    field: 'limits.maximumLeaves',
    value: input.limits?.maximumLeaves,
    law: BACKTEST_RUN_LIMITS.maximumLeaves,
  });
  const left = resolveRun(functionName, input.baseline, 'baseline');
  const right = resolveRun(functionName, input.candidate, 'candidate');
  if (left.report.kind !== right.report.kind) {
    fail(
      functionName,
      `baseline is a '${left.report.kind}' run and candidate a '${right.report.kind}' run — compare runs of one kind.`,
      ErrorCode.InputOutOfRange,
      { baseline: left.report.kind, candidate: right.report.kind },
    );
  }
  const kind = left.report.kind as Kind;
  const warnings: QuantWarning[] = [];
  const within = (delta: number | null, base: number | null): boolean | null => {
    if (tolerance === null) return null;
    if (delta === null) return base === null;
    return Math.abs(delta) <= tolerance.absolute + tolerance.relative * Math.abs(base ?? 0);
  };
  const leftMetrics = metricsOf(left.report);
  const rightMetrics = metricsOf(right.report);
  const metrics: NamedDelta[] = METRIC_NAMES.map((name) => {
    const b = leftMetrics[name] ?? null;
    const c = rightMetrics[name] ?? null;
    const delta = b !== null && c !== null ? c - b : null;
    return {
      name,
      baselineValue: b,
      candidateValue: c,
      absoluteDelta: delta,
      withinTolerance:
        b === null && c === null ? (tolerance === null ? null : true) : within(delta, b),
    };
  });
  let holdings: MembershipSection | null = null;
  let rebalances: BacktestRunComparison['rebalances'] = null;
  let variations: BacktestRunComparison['variations'] = null;
  if (kind === 'cross-sectional') {
    const b = finalHoldings(left.report);
    const c = finalHoldings(right.report);
    holdings = b !== null && c !== null ? membership(b, c, listedIds) : null;
    const lb = left.report.run['rebalances'];
    const rb = right.report.run['rebalances'];
    if (Array.isArray(lb) && Array.isArray(rb)) {
      const compared = Math.min(lb.length, rb.length);
      const rows: RebalanceDelta[] = [];
      for (let i = 0; i < compared; i += 1) {
        const x = lb[i] as {
          sessionDate: string;
          turnover: number;
          costs: number;
          longCount: number;
          shortCount: number;
        };
        const y = rb[i] as {
          sessionDate: string;
          turnover: number;
          costs: number;
          longCount: number;
          shortCount: number;
        };
        rows.push({
          rebalanceIndex: i,
          sessionDate: { baseline: x.sessionDate, candidate: y.sessionDate },
          turnover: {
            baseline: x.turnover,
            candidate: y.turnover,
            absoluteDelta: y.turnover - x.turnover,
          },
          costs: { baseline: x.costs, candidate: y.costs, absoluteDelta: y.costs - x.costs },
          longCount: { baseline: x.longCount, candidate: y.longCount },
          shortCount: { baseline: x.shortCount, candidate: y.shortCount },
        });
      }
      rebalances = {
        compared,
        rows: rows.slice(0, listedIds),
        remainderCount: Math.max(0, rows.length - listedIds),
      };
      if (lb.length !== rb.length)
        warnings.push(
          warning(
            WarningCode.ArtifactLibraryVersionDiffers,
            `${functionName}: the runs have ${lb.length} and ${rb.length} rebalances; the first ${compared} were compared index by index.`,
            'info',
            { baseline: lb.length, candidate: rb.length },
          ),
        );
    } else {
      warnings.push(
        warning(
          WarningCode.ArtifactLibraryVersionDiffers,
          `${functionName}: a rebalance row set is referenced by table handle on at least one side — supply it through readBacktestRun's referencedData to compare rebalance by rebalance.`,
          'info',
          {},
        ),
      );
    }
  } else {
    const lv = left.report.run['variations'];
    const rv = right.report.run['variations'];
    const metric = String(
      (left.report.run['assumptions'] as { selectionMetric?: string }).selectionMetric ?? 'sharpe',
    );
    if (Array.isArray(lv) && Array.isArray(rv)) {
      const key = (row: { parameters: Record<string, unknown> }): string =>
        canonicalJsonOf(row.parameters);
      const rightByKey = new Map(
        (
          rv as Array<{ parameters: Record<string, unknown>; metrics: Record<string, unknown> }>
        ).map((row) => [key(row), row]),
      );
      const rows: VariationDelta[] = [];
      let matched = 0;
      for (const row of lv as Array<{
        parameters: Record<string, unknown>;
        metrics: Record<string, unknown>;
      }>) {
        const other = rightByKey.get(key(row));
        if (other === undefined) continue;
        matched += 1;
        const b = finiteOrNull(row.metrics[metric]);
        const c = finiteOrNull(other.metrics[metric]);
        rows.push({
          parameters: row.parameters,
          metric,
          baselineValue: b,
          candidateValue: c,
          absoluteDelta: b !== null && c !== null ? c - b : null,
        });
      }
      rows.sort(
        (x, y) =>
          Math.abs(y.absoluteDelta ?? 0) - Math.abs(x.absoluteDelta ?? 0) ||
          canonicalJsonOf(x.parameters).localeCompare(canonicalJsonOf(y.parameters)),
      );
      const lbest = left.report.run['best'] as { index: number } | null;
      const rbest = right.report.run['best'] as { index: number } | null;
      const lkey =
        lbest === null
          ? null
          : key((lv as Array<{ parameters: Record<string, unknown> }>)[lbest.index]!);
      const rkey =
        rbest === null
          ? null
          : key((rv as Array<{ parameters: Record<string, unknown> }>)[rbest.index]!);
      variations = {
        matched,
        baselineOnly: lv.length - matched,
        candidateOnly: rv.length - matched,
        rows: rows.slice(0, listedIds),
        remainderCount: Math.max(0, rows.length - listedIds),
        best: {
          baseline: lbest?.index ?? null,
          candidate: rbest?.index ?? null,
          moved: lkey !== rkey,
        },
      };
    } else {
      warnings.push(
        warning(
          WarningCode.ArtifactLibraryVersionDiffers,
          `${functionName}: the variations row set is referenced by table handle on at least one side — supply it through readBacktestRun's referencedData to compare variation by variation.`,
          'info',
          {},
        ),
      );
    }
  }
  const lv = hygieneVerdict(left.report);
  const rv = hygieneVerdict(right.report);
  const hygiene =
    lv === null && rv === null ? null : { baseline: lv, candidate: rv, changed: lv !== rv };
  const parity = artifactReplayParity({
    saved: storedProjection(left.report),
    recomputed: storedProjection(right.report),
    limits: { maximumDifferences, maximumLeaves },
  });
  const li = left.report.identity;
  const ri = right.report.identity;
  const same = (a: unknown, b: unknown): boolean => canonicalJsonOf(a) === canonicalJsonOf(b);
  return deepFreeze({
    kind,
    artifactIds: { baseline: left.artifactId, candidate: right.artifactId },
    runHashes: { baseline: left.report.runHash, candidate: right.report.runHash },
    identical: left.report.runHash === right.report.runHash,
    sameInputs:
      same(left.report.inputs, right.report.inputs) &&
      same(left.report.referencedData, right.report.referencedData),
    sameUniverse:
      li.universeId === ri.universeId && li.universeHistoryHash === ri.universeHistoryHash,
    sameStrategy: same(li.strategy, ri.strategy),
    sameModels: same(li.models, ri.models),
    sameConventions: same(li.conventions, ri.conventions),
    metrics,
    holdings,
    rebalances,
    variations,
    hygiene,
    run: {
      differenceCount: parity.differenceCount,
      retainedDifferences: parity.differences.length,
      addedPaths: parity.addedPaths,
      removedPaths: parity.removedPaths,
      truncated: parity.truncated,
    },
    withinTolerance: tolerance === null ? null : metrics.every((m) => m.withinTolerance === true),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      kind,
      tolerance,
      limits: { maximumDifferences, maximumLeaves, listedIds },
    },
    diagnostics: { warnings },
  });
}
