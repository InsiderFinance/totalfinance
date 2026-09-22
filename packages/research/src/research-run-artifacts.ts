/**
 * `@insiderfinance/totalfinance/research/artifacts` — the four verbs of Stage 4.5 Decision 4 over the eleven FC3 run
 * kinds, riding the Gate B spine and the shared fitted-model kit in core: `researchRunArtifact`,
 * `readResearchRun`, `replayResearchRun`, `compareResearchRuns`. A screen is not a model: there is
 * no evaluator, warm start, stability, or holdout here.
 *
 * A run is the direct operation's result, VERBATIM, plus the input that reproduces it — bulk row
 * sets embedded under the row limit or referenced by content-hashed table handles — an optional
 * statistical-hygiene block the caller attaches (computed by `@insiderfinance/totalfinance/risk`, never here), and the
 * versioned `FactorRecipe` the caller says produced the factor. Replay re-issues the operation with
 * the stored input (referenced rows re-verified by hash) and compares canonical bytes; a run whose
 * input carried a caller function is recorded as non-replayable and refuses replay by name.
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
  requireWorkLimit,
  scanCanonicalData,
  tableHandleForRows,
  verifyReferencedRows,
  type AnalysisArtifact,
  type AppliedMigration,
  type ArtifactMigrationRegistry,
  type ArtifactReplayParity,
  type ComparisonLimits,
  type TableHandle,
} from '@totalfinance/core/artifacts';
import type { AverageAbnormalReturnRow } from './events.js';
import type { FactorRecipe } from './factors.js';
import { requireHygieneBlock, type ResearchHygieneBlock } from './research-hygiene.js';
import {
  KIND_SPECS,
  RESEARCH_RUN_KIND_LIST,
  pathOfLabel,
  resolveRowSets,
  withPath,
  type InputOf,
  type KindSpec,
  type ResearchRunKind,
  type RunIdentity,
  type RunOf,
} from './research-run-kinds.js';

export const RESEARCH_RUN_ARTIFACT_TYPE = 'research.run';

/** Decision 9's bounded-work table (core's `ARTIFACT_WORK_LIMITS`, re-exported for this subpath's callers). */
export const RESEARCH_RUN_LIMITS = ARTIFACT_WORK_LIMITS;

export interface ResearchRunArtifactLimits {
  maximumEmbeddedBytes?: number;
  embeddedRowLimit?: number;
}

/**
 * The stored form of an input: every bulk array may be a `TableHandle` instead of its rows, and a
 * caller function is never stored (the run is recorded non-replayable and the field omitted).
 */
export type Referenced<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends readonly (infer Element)[]
    ? readonly Referenced<Element>[] | TableHandle
    : T extends object
      ? { [P in keyof T]: Referenced<T[P]> }
      : T;

/** The typed report every verb reads and writes — the artifact's `result`, verbatim. */
export type ResearchRunReport<Kind extends ResearchRunKind = ResearchRunKind> = Readonly<
  Record<string, unknown>
> & {
  kind: Kind;
  runVersion: number;
  /** The direct operation's result, verbatim. */
  run: RunOf<Kind>;
  /** The operation's input with bulk rows either embedded or replaced by verified table references. */
  inputs: Referenced<InputOf<Kind>>;
  /** Table references for every bulk row set that was not embedded (Gate B TableHandle). */
  referencedData: Record<string, TableHandle>;
  /** Statistical-hygiene results the caller attached, verbatim — computed by @insiderfinance/totalfinance/risk, never here. */
  hygiene: ResearchHygieneBlock | null;
  /** The versioned recipe the caller says produced the factor, when one did. */
  recipe: FactorRecipe | null;
  assumptions: {
    conventionsVersion: string;
    kind: Kind;
    runVersion: number;
    operation: string;
    /** `false` exactly when a non-serializable callback participated. */
    replayable: boolean;
    /** The callback field that made the run non-replayable, when one did. */
    nonReplayableField: string | null;
    inputPolicy: 'embedded' | 'referenced';
    embeddedRowLimit: number;
    projection: string;
  };
  diagnostics: {
    warnings: QuantWarning[];
    embeddedRows: number;
    referencedRows: number;
    runWarningCount: number;
  };
};

export interface ResearchRunArtifactInput<Kind extends ResearchRunKind> {
  kind: Kind;
  /** The direct operation's result, verbatim. */
  run: RunOf<Kind>;
  /** The operation's input as it was called — rows included; a caller function is recorded and not stored. */
  input: InputOf<Kind>;
  /** Concrete row-set labels (`observations`, `horizons[0].forwardReturns`) to store by `TableHandle` instead of embedding. */
  referenceRowSets?: readonly string[];
  /** Storage locators to stamp on the minted handles, keyed by row-set label. */
  locators?: Record<string, string>;
  /** Up to six verbatim @insiderfinance/totalfinance/risk results — validated structurally, stored verbatim, never recomputed. */
  hygiene?: ResearchHygieneBlock;
  /** The versioned factor recipe that produced the factor, stored verbatim (covered by the artifact id). */
  recipe?: FactorRecipe;
  snapshotHash?: string;
  libraryVersion?: string;
  /** Parent artifact ids (a transform, a prior study, a portfolio set) so lineage is walkable. */
  createdFrom?: string[];
  provenance?: Provenance;
  limits?: ResearchRunArtifactLimits;
}

export interface ReadResearchRunResult<Kind extends ResearchRunKind = ResearchRunKind> {
  report: ResearchRunReport<Kind>;
  artifact: AnalysisArtifact;
  /** Envelope-level migrations applied by the Gate B read door. */
  migrationsApplied: AppliedMigration[];
  /** Report-level (run-version) migrations applied under `research.run:<kind>` — the same echo shape as the fitted-model read doors. */
  modelMigrationsApplied: AppliedMigration[];
}

export interface ResearchRunReplay<Kind extends ResearchRunKind = ResearchRunKind> {
  kind: Kind;
  artifactId: string;
  recomputed: ResearchRunReport<Kind>;
  parity: ArtifactReplayParity;
  assumptions: {
    conventionsVersion: string;
    kind: Kind;
    runVersion: number;
    operation: string;
    libraryVersion: { saved: string | null; current: string | null };
    referencedRowSets: string[];
  };
  diagnostics: { warnings: QuantWarning[] };
}

export interface IdListSection {
  count: number;
  /** Listed up to `limits.listedIds`; the remainder is counted. */
  ids: string[];
  remainderCount: number;
}

export interface MembershipSection {
  entered: IdListSection;
  exited: IdListSection;
  kept: IdListSection;
}

export interface RankMove {
  instrumentId: string;
  baselineRank: number;
  candidateRank: number;
  /** candidate − baseline (positive = moved down the ranking). */
  delta: number;
}

export interface RankMovesSection {
  /** Instruments ranked on both sides whose rank changed. */
  movedCount: number;
  /** The largest movers by |delta|, listed up to `limits.listedIds`. */
  movers: RankMove[];
  remainderCount: number;
}

export interface ValueDelta {
  instrumentId: string;
  baselineValue: number;
  candidateValue: number;
  absoluteDelta: number;
}

export interface ScoreDeltasSection {
  /** Instruments scored on both sides. */
  count: number;
  meanAbsoluteDelta: number | null;
  maximumAbsoluteDelta: number | null;
  /** Per instrument by |delta| descending, listed up to `limits.listedIds`. */
  perInstrument: ValueDelta[];
  remainderCount: number;
}

export interface CountDelta {
  reason: string;
  baselineCount: number;
  candidateCount: number;
  delta: number;
}

export interface NamedDelta {
  name: string;
  baselineValue: number | null;
  candidateValue: number | null;
  absoluteDelta: number | null;
}

export interface KeyedDelta<Key> {
  key: Key;
  baselineValue: number | null;
  candidateValue: number | null;
  absoluteDelta: number | null;
}

export interface AbnormalReturnDelta {
  tradingSessionOffset: number;
  baselineAverageAbnormalReturn: number | null;
  candidateAverageAbnormalReturn: number | null;
  absoluteDelta: number | null;
  baselineCumulativeAverageAbnormalReturn: number | null;
  candidateCumulativeAverageAbnormalReturn: number | null;
  cumulativeAbsoluteDelta: number | null;
}

export interface PortfolioMembership {
  quantileIndex: number;
  membership: MembershipSection;
}

export interface HygieneVerdictSection {
  baseline: string;
  candidate: string;
  changed: boolean;
}

export interface ResearchRunComparison<Kind extends ResearchRunKind = ResearchRunKind> {
  kind: Kind;
  artifactIds: { baseline: string | null; candidate: string | null };
  sameUniverse: boolean | null;
  sameAsOf: boolean | null;
  sameFilter: boolean | null;
  sameRankBy: boolean | null;
  sameComponents: boolean | null;
  /** Whether the two stored inputs hash identically. */
  sameInputs: boolean;
  /** Each section is `null` where the kind has no such content. */
  membership: MembershipSection | null;
  rankMoves: RankMovesSection | null;
  scoreDeltas: ScoreDeltasSection | null;
  exclusionReasons: CountDelta[] | null;
  coefficients: NamedDelta[] | null;
  averageAbnormalReturns: AbnormalReturnDelta[] | null;
  quantiles: KeyedDelta<number>[] | null;
  horizons: KeyedDelta<string>[] | null;
  portfolios: PortfolioMembership[] | null;
  hygieneVerdict: HygieneVerdictSection | null;
  /** The structural diff of the two verbatim runs through the parity walk. */
  run: {
    differenceCount: number;
    retainedDifferences: number;
    addedPaths: string[];
    removedPaths: string[];
    truncated: boolean;
  };
  assumptions: {
    conventionsVersion: string;
    kind: Kind;
    limits: { maximumDifferences: number; maximumLeaves: number; listedIds: number };
  };
  diagnostics: { warnings: QuantWarning[] };
}

const REPORT_KEYS = [
  'kind',
  'runVersion',
  'run',
  'inputs',
  'referencedData',
  'hygiene',
  'recipe',
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
  'projection',
] as const;
const DIAGNOSTIC_KEYS = ['warnings', 'embeddedRows', 'referencedRows', 'runWarningCount'] as const;
const RECIPE_KEYS = [
  'recipeName',
  'recipeVersion',
  'disclosure',
  'direction',
  'features',
  'lagTradingSessions',
  'neutralization',
  'missingValuePolicy',
] as const;
const PROJECTION =
  'run = the direct operation result verbatim (no field dropped, renamed, or recomputed); inputs = the operation input with bulk row sets embedded or replaced by verified table handles and any caller function omitted; hygiene and recipe stored verbatim as the caller attached them';

function fail(
  functionName: string,
  message: string,
  code: ErrorCode,
  context: Record<string, unknown> = {},
): never {
  throw new InputError(`${functionName}: ${message}`, {
    code,
    context: { function: functionName, ...context },
  });
}

function requireKind(functionName: string, value: unknown): ResearchRunKind {
  if (typeof value !== 'string' || !(RESEARCH_RUN_KIND_LIST as readonly string[]).includes(value)) {
    fail(
      functionName,
      `kind must be one of ${RESEARCH_RUN_KIND_LIST.join(', ')}. Received ${typeof value === 'string' ? JSON.stringify(value) : value === null ? 'null' : typeof value}.`,
      value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputInvalidEnum,
      { field: 'kind' },
    );
  }
  return value as ResearchRunKind;
}

function specOf(kind: ResearchRunKind): KindSpec<ResearchRunKind> {
  return KIND_SPECS[kind] as unknown as KindSpec<ResearchRunKind>;
}

function requireLimit(
  functionName: string,
  field: string,
  value: unknown,
  law: { default?: number; maximum: number },
): number {
  return requireWorkLimit({ functionName, field, value, law });
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

/** A bounded scan whose budget refusal is THIS door's "too large" — re-voiced with the referencing teaching. */
function scanEmbedded(
  functionName: string,
  label: string,
  value: unknown,
  maximumEmbeddedBytes: number,
  requireFiniteNumbers: boolean,
): void {
  try {
    scanCanonicalData(value, {
      functionName,
      label,
      maximumWorkUnits: maximumEmbeddedBytes,
      requireFiniteNumbers,
    });
  } catch (error) {
    if (
      isQuantError(error, ErrorCode.InputOutOfRange) &&
      error.message.includes('data-work limit')
    ) {
      fail(
        functionName,
        `the embedded ${label} exceeds the embedded-input budget (${maximumEmbeddedBytes.toLocaleString()} work units ≈ canonical bytes) — reference the bulk row sets (referenceRowSets) or raise limits.maximumEmbeddedBytes up to ${RESEARCH_RUN_LIMITS.maximumEmbeddedBytes.maximum.toLocaleString()}.`,
        ErrorCode.ArtifactEmbeddedInputTooLarge,
        { field: label, maximumEmbeddedBytes },
      );
    }
    throw error;
  }
}

function requireRunShape(
  functionName: string,
  field: string,
  spec: KindSpec<ResearchRunKind>,
  value: unknown,
): void {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, spec.runKeys);
  for (const key of spec.runKeys) {
    if (spec.optionalRunKeys.includes(key)) continue;
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail(
        functionName,
        `${field}.${key} is missing — a '${spec.descriptor.kind}' run is the verbatim result of ${spec.descriptor.operation}, which always reports it.`,
        ErrorCode.InputMissingField,
        { field: `${field}.${key}` },
      );
    }
  }
  requireArgumentObject(functionName, `${field}.assumptions`, record['assumptions']);
  const assumptions = record['assumptions'] as Record<string, unknown>;
  for (const key of spec.requiredAssumptionKeys) {
    if (!Object.prototype.hasOwnProperty.call(assumptions, key)) {
      fail(
        functionName,
        `${field}.assumptions.${key} is missing — ${spec.descriptor.operation} always reports it, so this is not a '${spec.descriptor.kind}' run (a result of another operation cannot be saved under this kind).`,
        ErrorCode.InputMissingField,
        { field: `${field}.assumptions.${key}` },
      );
    }
  }
  requireArgumentObject(functionName, `${field}.diagnostics`, record['diagnostics']);
  if (!Array.isArray((record['diagnostics'] as Record<string, unknown>)['warnings'])) {
    fail(
      functionName,
      `${field}.diagnostics.warnings must be an array (the operation's own warnings, verbatim).`,
      ErrorCode.InputWrongType,
      { field: `${field}.diagnostics.warnings` },
    );
  }
}

function requireRecipe(functionName: string, field: string, value: unknown): FactorRecipe {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, RECIPE_KEYS);
  for (const key of ['recipeName', 'disclosure'] as const) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      fail(
        functionName,
        `${field}.${key} must be a non-empty string.`,
        record[key] === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
        { field: `${field}.${key}` },
      );
    }
  }
  for (const [key, floor] of [
    ['recipeVersion', 1],
    ['lagTradingSessions', 0],
  ] as const) {
    const number = record[key];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < floor) {
      fail(
        functionName,
        `${field}.${key} must be an integer ≥ ${floor}.`,
        number === undefined ? ErrorCode.InputMissingField : ErrorCode.InputOutOfRange,
        { field: `${field}.${key}` },
      );
    }
  }
  const enums: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['direction', ['higher-is-better', 'lower-is-better']],
    ['neutralization', ['none', 'sector', 'sector-and-size']],
    ['missingValuePolicy', ['exclude', 'renormalize-weights']],
  ];
  for (const [key, allowed] of enums) {
    if (typeof record[key] !== 'string' || !allowed.includes(record[key] as string)) {
      fail(
        functionName,
        `${field}.${key} must be one of ${allowed.join(', ')}.`,
        record[key] === undefined ? ErrorCode.InputMissingField : ErrorCode.InputInvalidEnum,
        { field: `${field}.${key}` },
      );
    }
  }
  requireArgumentArray(functionName, `${field}.features`, record['features']);
  (record['features'] as unknown[]).forEach((feature, index) => {
    const label = `${field}.features[${index}]`;
    requireArgumentObject(functionName, label, feature);
    const entry = feature as Record<string, unknown>;
    ensureKnownKeys(functionName, label, entry, ['field', 'transform', 'weight']);
    if (typeof entry['field'] !== 'string' || entry['field'].length === 0) {
      fail(
        functionName,
        `${label}.field must be a non-empty field name.`,
        ErrorCode.InputWrongType,
        {
          field: `${label}.field`,
        },
      );
    }
    const transforms = ['raw', 'winsorize-then-z-score', 'percentile-rank'];
    if (typeof entry['transform'] !== 'string' || !transforms.includes(entry['transform'])) {
      fail(
        functionName,
        `${label}.transform must be one of ${transforms.join(', ')}.`,
        ErrorCode.InputInvalidEnum,
        { field: `${label}.transform` },
      );
    }
    if (typeof entry['weight'] !== 'number' || !Number.isFinite(entry['weight'])) {
      fail(functionName, `${label}.weight must be a finite number.`, ErrorCode.InputWrongType, {
        field: `${label}.weight`,
      });
    }
  });
  return value as FactorRecipe;
}

/** Validate a restored report structurally (closed keys, known kind/version, the run shape, handles, block, recipe). */
function requireReport(functionName: string, value: unknown): ResearchRunReport {
  requireArgumentObject(functionName, 'artifact.result', value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, 'artifact.result', record, REPORT_KEYS);
  for (const key of REPORT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail(
        functionName,
        `artifact.result.${key} is missing — this is not a research-run report.`,
        ErrorCode.InputMissingField,
        { field: `artifact.result.${key}` },
      );
    }
  }
  const kind = requireKind(functionName, record['kind']);
  const spec = specOf(kind);
  if (record['runVersion'] !== spec.descriptor.runVersion) {
    fail(
      functionName,
      `artifact.result.runVersion is ${String(record['runVersion'])}; this build reads '${kind}' runs at version ${spec.descriptor.runVersion}.`,
      ErrorCode.ArtifactModelVersionUnsupported,
      { field: 'artifact.result.runVersion' },
    );
  }
  requireRunShape(functionName, 'artifact.result.run', spec, record['run']);
  requireArgumentObject(functionName, 'artifact.result.inputs', record['inputs']);
  requireArgumentObject(functionName, 'artifact.result.referencedData', record['referencedData']);
  for (const [name, handle] of Object.entries(
    record['referencedData'] as Record<string, unknown>,
  )) {
    if (!isTableHandle(handle)) {
      fail(
        functionName,
        `artifact.result.referencedData.${name} is not a table handle.`,
        ErrorCode.InputWrongType,
        { field: `artifact.result.referencedData.${name}` },
      );
    }
  }
  if (record['hygiene'] !== null)
    requireHygieneBlock(functionName, 'artifact.result.hygiene', record['hygiene']);
  if (record['recipe'] !== null)
    requireRecipe(functionName, 'artifact.result.recipe', record['recipe']);
  const assumptions = record['assumptions'];
  requireArgumentObject(functionName, 'artifact.result.assumptions', assumptions);
  ensureKnownKeys(
    functionName,
    'artifact.result.assumptions',
    assumptions as object,
    ASSUMPTION_KEYS,
  );
  const a = assumptions as Record<string, unknown>;
  if (a['kind'] !== kind) {
    fail(
      functionName,
      `artifact.result.assumptions.kind (${JSON.stringify(a['kind'])}) does not name the report's kind '${kind}'.`,
      ErrorCode.InputWrongShape,
      { field: 'artifact.result.assumptions.kind' },
    );
  }
  if (typeof a['replayable'] !== 'boolean') {
    fail(
      functionName,
      `artifact.result.assumptions.replayable must be a boolean.`,
      ErrorCode.InputWrongType,
      { field: 'artifact.result.assumptions.replayable' },
    );
  }
  if (
    a['nonReplayableField'] !== null &&
    (typeof a['nonReplayableField'] !== 'string' || a['nonReplayableField'].length === 0)
  ) {
    fail(
      functionName,
      `artifact.result.assumptions.nonReplayableField must be null or the callback field's name.`,
      ErrorCode.InputWrongType,
      { field: 'artifact.result.assumptions.nonReplayableField' },
    );
  }
  if ((a['replayable'] === true) !== (a['nonReplayableField'] === null)) {
    fail(
      functionName,
      `artifact.result.assumptions.replayable and nonReplayableField disagree — a run is non-replayable exactly when a callback field is named.`,
      ErrorCode.InputWrongShape,
      { field: 'artifact.result.assumptions.replayable' },
    );
  }
  if (a['inputPolicy'] !== 'embedded' && a['inputPolicy'] !== 'referenced') {
    fail(
      functionName,
      `artifact.result.assumptions.inputPolicy must be 'embedded' or 'referenced'.`,
      ErrorCode.InputInvalidEnum,
      { field: 'artifact.result.assumptions.inputPolicy' },
    );
  }
  const diagnostics = record['diagnostics'];
  requireArgumentObject(functionName, 'artifact.result.diagnostics', diagnostics);
  ensureKnownKeys(
    functionName,
    'artifact.result.diagnostics',
    diagnostics as object,
    DIAGNOSTIC_KEYS,
  );
  if (!Array.isArray((diagnostics as Record<string, unknown>)['warnings'])) {
    fail(
      functionName,
      `artifact.result.diagnostics.warnings must be an array.`,
      ErrorCode.InputWrongType,
      { field: 'artifact.result.diagnostics.warnings' },
    );
  }
  return record as unknown as ResearchRunReport;
}

function requireSnapshotHash(functionName: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail(
      functionName,
      `snapshotHash must be a 'sha256:<64 hex>' string — use marketSnapshotContentHash(snapshot).`,
      ErrorCode.InputWrongType,
      { field: 'snapshotHash' },
    );
  }
  return value;
}

interface BuiltReport {
  report: ResearchRunReport;
  inputsHash: string;
}

/** Build the report for a (kind, run, stored input, handles) — the one projection law. */
function buildReport(
  functionName: string,
  spec: KindSpec<ResearchRunKind>,
  run: RunOf<ResearchRunKind>,
  stored: Record<string, unknown>,
  referencedData: Record<string, TableHandle>,
  hygiene: ResearchHygieneBlock | null,
  recipe: FactorRecipe | null,
  nonReplayableField: string | null,
  embeddedRows: number,
  embeddedRowLimit: number,
): BuiltReport {
  const runWarnings = (run as { diagnostics?: { warnings?: unknown[] } }).diagnostics?.warnings;
  const referencedRowSets = Object.keys(referencedData).sort();
  const referencedRows = referencedRowSets.reduce(
    (total, label) => total + referencedData[label]!.rowCount,
    0,
  );
  const report = {
    kind: spec.descriptor.kind,
    runVersion: spec.descriptor.runVersion,
    run,
    inputs: stored,
    referencedData,
    hygiene,
    recipe,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      kind: spec.descriptor.kind,
      runVersion: spec.descriptor.runVersion,
      operation: spec.descriptor.operation,
      replayable: nonReplayableField === null,
      nonReplayableField,
      inputPolicy: referencedRowSets.length > 0 ? ('referenced' as const) : ('embedded' as const),
      embeddedRowLimit,
      projection: PROJECTION,
    },
    diagnostics: {
      warnings: [] as QuantWarning[],
      embeddedRows,
      referencedRows,
      runWarningCount: Array.isArray(runWarnings) ? runWarnings.length : 0,
    },
  };
  void functionName;
  return { report: report as unknown as ResearchRunReport, inputsHash: contentHash(stored) };
}

// ──────────────────────────────────────────── the verbs ─────────────────────────────────────────────

/**
 * Describe a direct research operation's result and save it as an identified, immutable artifact.
 *
 * @example
 * ```ts
 * const run = screenUniverse(input);
 * const artifact = researchRunArtifact({ kind: 'screen', run, input, referenceRowSets: ['observations'] });
 * ```
 */
export function researchRunArtifact<Kind extends ResearchRunKind>(
  input: ResearchRunArtifactInput<Kind>,
): AnalysisArtifact {
  const functionName = 'researchRunArtifact';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, [
    'kind',
    'run',
    'input',
    'referenceRowSets',
    'locators',
    'hygiene',
    'recipe',
    'snapshotHash',
    'libraryVersion',
    'createdFrom',
    'provenance',
    'limits',
  ]);
  const kind = requireKind(functionName, input.kind);
  const spec = specOf(kind);
  const limits = input.limits;
  if (limits !== undefined) {
    requireArgumentObject(functionName, 'limits', limits);
    ensureKnownKeys(functionName, 'limits', limits, ['maximumEmbeddedBytes', 'embeddedRowLimit']);
  }
  const maximumEmbeddedBytes = requireLimit(
    functionName,
    'limits.maximumEmbeddedBytes',
    limits?.maximumEmbeddedBytes,
    RESEARCH_RUN_LIMITS.maximumEmbeddedBytes,
  );
  const embeddedRowLimit = requireLimit(
    functionName,
    'limits.embeddedRowLimit',
    limits?.embeddedRowLimit,
    RESEARCH_RUN_LIMITS.embeddedRowLimit,
  );
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
  if (input.createdFrom !== undefined) {
    requireArgumentArray(functionName, 'createdFrom', input.createdFrom);
  }

  // The run: the operation's result, a plain acyclic value (a null coefficient is a legal RESULT).
  requireRunShape(functionName, 'run', spec, input.run);
  scanEmbedded(functionName, 'run', input.run, maximumEmbeddedBytes, false);
  const run = detach(input.run) as RunOf<Kind>;

  // The input: callbacks recorded and stripped, rows embedded or referenced, the rest verbatim.
  requireArgumentObject(functionName, 'input', input.input);
  let working = { ...(input.input as unknown as Record<string, unknown>) };
  let nonReplayableField: string | null = null;
  for (const callback of spec.callbacks) {
    if (!callback.isPresent(working)) continue;
    const value = callback.read(working);
    if (typeof value !== 'function') {
      fail(
        functionName,
        `input.${callback.field} is present but not a function — ${spec.descriptor.operation} would have refused this input, so it cannot be the input that produced the run.`,
        ErrorCode.InputWrongType,
        { field: `input.${callback.field}` },
      );
    }
    nonReplayableField = callback.field;
    working = callback.strip(working);
  }
  scanEmbedded(functionName, 'input', working, maximumEmbeddedBytes, true);
  const resolved = resolveRowSets(functionName, spec, working);
  const labels = resolved.map((rowSet) => rowSet.label);
  if (input.referenceRowSets !== undefined) {
    requireArgumentArray(functionName, 'referenceRowSets', input.referenceRowSets);
  }
  const referenceRowSets = input.referenceRowSets ?? [];
  for (const name of referenceRowSets) {
    if (typeof name !== 'string' || !labels.includes(name)) {
      fail(
        functionName,
        `referenceRowSets names ${JSON.stringify(name)}, which is not a bulk row set of this '${kind}' input — its row sets are ${labels.length > 0 ? labels.join(', ') : 'none'} (patterns: ${spec.descriptor.bulkRowSets.join(', ')}).`,
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
  let stored: Record<string, unknown> = detach(working);
  const referencedData: Record<string, TableHandle> = {};
  let embeddedRows = 0;
  for (const rowSet of resolved) {
    if (!Array.isArray(rowSet.rows)) {
      fail(
        functionName,
        `input.${rowSet.label} must be the row array ${spec.descriptor.operation} consumed. Received ${rowSet.rows === null ? 'null' : typeof rowSet.rows}.`,
        ErrorCode.InputWrongType,
        { field: `input.${rowSet.label}` },
      );
    }
    if (referenceRowSets.includes(rowSet.label)) {
      const handle = tableHandleForRows({
        rows: rowSet.rows,
        ...(input.locators?.[rowSet.label] !== undefined
          ? { locator: input.locators[rowSet.label] }
          : {}),
      });
      referencedData[rowSet.label] = handle;
      stored = withPath(stored, rowSet.path, handle) as Record<string, unknown>;
    } else if (rowSet.rows.length > embeddedRowLimit) {
      fail(
        functionName,
        `input.${rowSet.label} has ${rowSet.rows.length} rows, above the embedded row limit ${embeddedRowLimit} — nothing is truncated silently. Either reference the row set (referenceRowSets: ['${rowSet.label}'], which stores its content hash and row count and expects the rows again at replay) or raise limits.embeddedRowLimit up to ${RESEARCH_RUN_LIMITS.embeddedRowLimit.maximum}.`,
        ErrorCode.ArtifactEmbeddedInputTooLarge,
        { field: `input.${rowSet.label}`, rows: rowSet.rows.length, embeddedRowLimit },
      );
    } else {
      embeddedRows += rowSet.rows.length;
    }
  }
  const storedBytes = canonicalJsonOf(stored).length;
  if (storedBytes > maximumEmbeddedBytes) {
    fail(
      functionName,
      `the embedded input is ${storedBytes.toLocaleString()} canonical bytes, above the limit ${maximumEmbeddedBytes.toLocaleString()} — reference the bulk row sets (referenceRowSets) or raise limits.maximumEmbeddedBytes up to ${RESEARCH_RUN_LIMITS.maximumEmbeddedBytes.maximum.toLocaleString()}.`,
      ErrorCode.ArtifactEmbeddedInputTooLarge,
      { field: 'input', bytes: storedBytes, maximumEmbeddedBytes },
    );
  }
  // The hygiene block and the recipe: validated structurally, stored verbatim. null is NOT omission.
  const hygiene =
    input.hygiene === undefined
      ? null
      : detach(requireHygieneBlock(functionName, 'hygiene', input.hygiene));
  const recipe =
    input.recipe === undefined ? null : detach(requireRecipe(functionName, 'recipe', input.recipe));
  const built = buildReport(
    functionName,
    spec,
    run,
    stored,
    referencedData,
    hygiene,
    recipe,
    nonReplayableField,
    embeddedRows,
    embeddedRowLimit,
  );
  const referenced = Object.fromEntries(
    Object.keys(referencedData)
      .sort()
      .map((label) => [label, referencedData[label]!.contentHash]),
  );
  return createAnalysisArtifact({
    artifactType: RESEARCH_RUN_ARTIFACT_TYPE,
    producedBy: {
      operation: spec.descriptor.operation,
      ...(input.libraryVersion !== undefined ? { libraryVersion: input.libraryVersion } : {}),
    },
    inputs: {
      ...(snapshotHash !== null ? { snapshotHash } : {}),
      parameters: {
        kind,
        runVersion: spec.descriptor.runVersion,
        inputsHash: built.inputsHash,
        referenced,
      },
    },
    ...(input.createdFrom !== undefined ? { createdFrom: input.createdFrom } : {}),
    result: built.report,
    ...(Object.keys(referencedData).length > 0 ? { tables: referencedData } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  });
}

/**
 * Restore a research-run artifact: Gate B's read door, a foreign-type refusal, then the caller's
 * registry applied a second time at the run level under `research.run:<kind>` (Decision 5), then
 * the report re-validated.
 */
export function readResearchRun(input: {
  /** The artifact as held OR as restored from JSON (`fromCanonicalJson`) — validated at runtime, never trusted by declaration. */
  artifact: unknown;
  migrations?: ArtifactMigrationRegistry;
}): ReadResearchRunResult {
  const functionName = 'readResearchRun';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['artifact', 'migrations']);
  const read = readAnalysisArtifact({
    artifact: input.artifact,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
  });
  const artifact = read.artifact;
  if (artifact.artifactType !== RESEARCH_RUN_ARTIFACT_TYPE) {
    fail(
      functionName,
      `the artifact's type is '${artifact.artifactType}', not '${RESEARCH_RUN_ARTIFACT_TYPE}' — this reader restores research runs only; ${artifact.artifactType.startsWith('volatility.') ? 'use @insiderfinance/totalfinance/volatility/artifacts' : artifact.artifactType.startsWith('fixed-income.') ? 'use @insiderfinance/totalfinance/fixed-income/artifacts' : 'read it with the package that owns that type'}.`,
      ErrorCode.ArtifactFamilyMismatch,
      { artifactType: artifact.artifactType },
    );
  }
  const raw = artifact.result as Record<string, unknown>;
  const kind = requireKind(functionName, raw['kind']);
  const migrated = applyReportMigrations({
    functionName,
    kind: `${RESEARCH_RUN_ARTIFACT_TYPE}:${kind}`,
    report: raw,
    storedVersion: raw['runVersion'],
    currentVersion: specOf(kind).descriptor.runVersion,
    versionField: 'runVersion',
    subject: `'${kind}' run`,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
  });
  const validated = requireReport(functionName, migrated.report);
  return {
    report: deepFreeze(detach(validated)),
    artifact,
    migrationsApplied: read.migrationsApplied,
    modelMigrationsApplied: migrated.modelMigrationsApplied,
  };
}

function resolveRun(
  functionName: string,
  value: unknown,
  field: string,
): { report: ResearchRunReport; artifactId: string | null } {
  if (isArtifact(value)) {
    const read = readResearchRun({ artifact: value });
    return { report: read.report, artifactId: read.artifact.id };
  }
  requireArgumentObject(functionName, field, value);
  return { report: requireReport(functionName, value), artifactId: null };
}

/** The full input behind a report: embedded rows as stored, referenced rows supplied and re-verified. */
function fullInput(
  functionName: string,
  report: ResearchRunReport,
  referencedData: Record<string, unknown[]> | undefined,
): Record<string, unknown> {
  let inputs = report.inputs as unknown as Record<string, unknown>;
  for (const label of Object.keys(report.referencedData).sort()) {
    const handle = report.referencedData[label]!;
    const rows = referencedData?.[label];
    if (rows === undefined) {
      fail(
        functionName,
        `the artifact references its '${label}' row set by table handle (${handle.rowCount} rows, ${handle.contentHash.slice(0, 18)}…) — supply the rows as referencedData.${label} to replay.`,
        ErrorCode.InputMissingField,
        { field: `referencedData.${label}` },
      );
    }
    inputs = withPath(
      inputs,
      pathOfLabel(label),
      detach(verifyReferencedRows({ functionName, label, handle, rows })),
    ) as Record<string, unknown>;
  }
  return inputs;
}

/**
 * Re-issue the run's direct operation from the stored input and compare canonical bytes with the
 * saved run (Decision 7). Referenced row sets must be supplied and re-verify by hash; a run that
 * recorded a caller callback refuses by name.
 */
export function replayResearchRun(input: {
  /** The artifact as held OR as restored from JSON (`fromCanonicalJson`) — validated at runtime, never trusted by declaration. */
  artifact: unknown;
  migrations?: ArtifactMigrationRegistry;
  referencedData?: Record<string, unknown[]>;
  libraryVersion?: string;
  limits?: ComparisonLimits;
}): ResearchRunReplay {
  const functionName = 'replayResearchRun';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, [
    'artifact',
    'migrations',
    'referencedData',
    'libraryVersion',
    'limits',
  ]);
  if (input.referencedData !== undefined)
    requireArgumentObject(functionName, 'referencedData', input.referencedData);
  const read = readResearchRun({
    artifact: input.artifact,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
  });
  const report = read.report;
  const spec = specOf(report.kind);
  if (!report.assumptions.replayable) {
    fail(
      functionName,
      `the '${report.kind}' run is not replayable: its input carried a caller function at ${report.assumptions.nonReplayableField ?? '(unrecorded)'} that no artifact can store — re-run ${spec.descriptor.operation} with the serializable form of that input and save that run.`,
      ErrorCode.ArtifactNotReplayable,
      { kind: report.kind, field: report.assumptions.nonReplayableField },
    );
  }
  const inputs = fullInput(functionName, report, input.referencedData);
  const recomputedRun = spec.run(inputs as never) as RunOf<ResearchRunKind>;
  const recomputed = buildReport(
    functionName,
    spec,
    detach(recomputedRun),
    report.inputs as unknown as Record<string, unknown>,
    { ...report.referencedData },
    report.hygiene,
    report.recipe,
    report.assumptions.nonReplayableField,
    report.diagnostics.embeddedRows,
    report.assumptions.embeddedRowLimit,
  );
  const parity = artifactReplayParity({
    saved: report.run as unknown as Record<string, unknown>,
    recomputed: recomputed.report.run as unknown as Record<string, unknown>,
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
        `${functionName}: replay parity FAILED for '${report.kind}' — ${parity.differenceCount} difference${parity.differenceCount === 1 ? '' : 's'} between the saved run and the recomputation (first at ${parity.differences[0]?.path ?? parity.addedPaths[0] ?? parity.removedPaths[0] ?? '(unknown)'}). A research operation is deterministic given its inputs, so this is a finding: a changed operation, dependency, or platform.`,
        'warn',
        { differenceCount: parity.differenceCount },
      ),
    );
  }
  return deepFreeze({
    kind: report.kind,
    artifactId: read.artifact.id,
    recomputed: deepFreeze(recomputed.report),
    parity,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      kind: report.kind,
      runVersion: report.runVersion,
      operation: spec.descriptor.operation,
      libraryVersion: { saved, current },
      referencedRowSets: Object.keys(report.referencedData).sort(),
    },
    diagnostics: { warnings },
  });
}

// ─────────────────────────────────────── comparison sections ─────────────────────────────────────

function idList(ids: readonly string[], listedIds: number): IdListSection {
  const sorted = [...ids].sort();
  return {
    count: sorted.length,
    ids: sorted.slice(0, listedIds),
    remainderCount: Math.max(0, sorted.length - listedIds),
  };
}

function membershipOf(
  baseline: readonly string[],
  candidate: readonly string[],
  listedIds: number,
): MembershipSection {
  const before = new Set(baseline);
  const after = new Set(candidate);
  return {
    entered: idList(
      [...after].filter((id) => !before.has(id)),
      listedIds,
    ),
    exited: idList(
      [...before].filter((id) => !after.has(id)),
      listedIds,
    ),
    kept: idList(
      [...after].filter((id) => before.has(id)),
      listedIds,
    ),
  };
}

function rankMovesOf(
  baseline: ReadonlyMap<string, number>,
  candidate: ReadonlyMap<string, number>,
  listedIds: number,
): RankMovesSection {
  const moves: RankMove[] = [];
  for (const [instrumentId, baselineRank] of baseline) {
    const candidateRank = candidate.get(instrumentId);
    if (candidateRank === undefined || candidateRank === baselineRank) continue;
    moves.push({ instrumentId, baselineRank, candidateRank, delta: candidateRank - baselineRank });
  }
  moves.sort(
    (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.instrumentId.localeCompare(b.instrumentId),
  );
  return {
    movedCount: moves.length,
    movers: moves.slice(0, listedIds),
    remainderCount: Math.max(0, moves.length - listedIds),
  };
}

function scoreDeltasOf(
  baseline: ReadonlyMap<string, number>,
  candidate: ReadonlyMap<string, number>,
  listedIds: number,
): ScoreDeltasSection {
  const deltas: ValueDelta[] = [];
  for (const [instrumentId, baselineValue] of baseline) {
    const candidateValue = candidate.get(instrumentId);
    if (candidateValue === undefined) continue;
    deltas.push({
      instrumentId,
      baselineValue,
      candidateValue,
      absoluteDelta: candidateValue - baselineValue,
    });
  }
  deltas.sort(
    (a, b) =>
      Math.abs(b.absoluteDelta) - Math.abs(a.absoluteDelta) ||
      a.instrumentId.localeCompare(b.instrumentId),
  );
  const magnitudes = deltas.map((delta) => Math.abs(delta.absoluteDelta));
  return {
    count: deltas.length,
    meanAbsoluteDelta:
      magnitudes.length === 0 ? null : magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length,
    maximumAbsoluteDelta: magnitudes.length === 0 ? null : Math.max(...magnitudes),
    perInstrument: deltas.slice(0, listedIds),
    remainderCount: Math.max(0, deltas.length - listedIds),
  };
}

function countDeltasOf(
  baseline: Readonly<Record<string, number>>,
  candidate: Readonly<Record<string, number>>,
): CountDelta[] {
  const reasons = [...new Set([...Object.keys(baseline), ...Object.keys(candidate)])].sort();
  return reasons.map((reason) => {
    const baselineCount = baseline[reason] ?? 0;
    const candidateCount = candidate[reason] ?? 0;
    return { reason, baselineCount, candidateCount, delta: candidateCount - baselineCount };
  });
}

const delta = (a: number | null | undefined, b: number | null | undefined): number | null =>
  typeof a === 'number' && typeof b === 'number' ? b - a : null;

function namedDeltasOf(
  baseline: Readonly<Record<string, number | null>>,
  candidate: Readonly<Record<string, number | null>>,
): NamedDelta[] {
  return Object.keys(baseline).map((name) => ({
    name,
    baselineValue: baseline[name] ?? null,
    candidateValue: candidate[name] ?? null,
    absoluteDelta: delta(baseline[name], candidate[name]),
  }));
}

function keyedDeltasOf<Key extends string | number>(
  baseline: readonly { key: Key; value: number | null }[],
  candidate: readonly { key: Key; value: number | null }[],
): KeyedDelta<Key>[] {
  const before = new Map(baseline.map((row) => [row.key, row.value]));
  const after = new Map(candidate.map((row) => [row.key, row.value]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b)),
  );
  return keys.map((key) => ({
    key,
    baselineValue: before.get(key) ?? null,
    candidateValue: after.get(key) ?? null,
    absoluteDelta: delta(before.get(key), after.get(key)),
  }));
}

function abnormalReturnDeltasOf(
  baseline: readonly AverageAbnormalReturnRow[],
  candidate: readonly AverageAbnormalReturnRow[],
): AbnormalReturnDelta[] {
  const before = new Map(baseline.map((row) => [row.tradingSessionOffset, row]));
  const after = new Map(candidate.map((row) => [row.tradingSessionOffset, row]));
  const offsets = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  return offsets.map((tradingSessionOffset) => {
    const b = before.get(tradingSessionOffset);
    const c = after.get(tradingSessionOffset);
    return {
      tradingSessionOffset,
      baselineAverageAbnormalReturn: b?.averageAbnormalReturn ?? null,
      candidateAverageAbnormalReturn: c?.averageAbnormalReturn ?? null,
      absoluteDelta: delta(b?.averageAbnormalReturn, c?.averageAbnormalReturn),
      baselineCumulativeAverageAbnormalReturn: b?.cumulativeAverageAbnormalReturn ?? null,
      candidateCumulativeAverageAbnormalReturn: c?.cumulativeAverageAbnormalReturn ?? null,
      cumulativeAbsoluteDelta: delta(
        b?.cumulativeAverageAbnormalReturn,
        c?.cumulativeAverageAbnormalReturn,
      ),
    };
  });
}

function portfoliosOf(
  baseline: readonly { quantileIndex: number; instrumentIds: readonly string[] }[],
  candidate: readonly { quantileIndex: number; instrumentIds: readonly string[] }[],
  listedIds: number,
): PortfolioMembership[] {
  const before = new Map(
    baseline.map((portfolio) => [portfolio.quantileIndex, portfolio.instrumentIds]),
  );
  const after = new Map(
    candidate.map((portfolio) => [portfolio.quantileIndex, portfolio.instrumentIds]),
  );
  const indices = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  return indices.map((quantileIndex) => ({
    quantileIndex,
    membership: membershipOf(
      before.get(quantileIndex) ?? [],
      after.get(quantileIndex) ?? [],
      listedIds,
    ),
  }));
}

const sameCanonical = (a: unknown, b: unknown): boolean | null =>
  a === null || a === undefined || b === null || b === undefined
    ? a === b
      ? null
      : false
    : canonicalJsonOf(a) === canonicalJsonOf(b);

/**
 * Compare two research runs of one kind: identity (universe, as-of, filter / rank field /
 * components), membership, rank moves, score deltas, exclusion-reason deltas, coefficient deltas,
 * abnormal-return deltas per session offset, per-quantile and per-horizon deltas, the hygiene
 * verdict change, and the structural diff of the two verbatim runs (Decision 6). Baseline and
 * candidate are named, never "a" and "b"; nothing is a single similarity score.
 */
export function compareResearchRuns<Kind extends ResearchRunKind>(input: {
  baseline: ResearchRunReport<Kind> | AnalysisArtifact;
  candidate: ResearchRunReport<Kind> | AnalysisArtifact;
  limits?: ComparisonLimits & { listedIds?: number };
}): ResearchRunComparison<Kind> {
  const functionName = 'compareResearchRuns';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['baseline', 'candidate', 'limits']);
  if (input.limits !== undefined) {
    requireArgumentObject(functionName, 'limits', input.limits);
    ensureKnownKeys(functionName, 'limits', input.limits, [
      'maximumDifferences',
      'maximumLeaves',
      'listedIds',
    ]);
  }
  const maximumDifferences = requireLimit(
    functionName,
    'limits.maximumDifferences',
    input.limits?.maximumDifferences,
    RESEARCH_RUN_LIMITS.maximumDifferences,
  );
  const maximumLeaves = requireLimit(
    functionName,
    'limits.maximumLeaves',
    input.limits?.maximumLeaves,
    RESEARCH_RUN_LIMITS.maximumLeaves,
  );
  const listedIds = requireLimit(
    functionName,
    'limits.listedIds',
    input.limits?.listedIds,
    RESEARCH_RUN_LIMITS.listedIds,
  );
  const baseline = resolveRun(functionName, input.baseline, 'baseline');
  const candidate = resolveRun(functionName, input.candidate, 'candidate');
  if (baseline.report.kind !== candidate.report.kind) {
    fail(
      functionName,
      `the runs are of different kinds — baseline is '${baseline.report.kind}', candidate is '${candidate.report.kind}'; their sections do not share a meaning. For a structural diff of two artifacts of one type use compareAnalysisArtifacts.`,
      ErrorCode.ArtifactFamilyMismatch,
      { baseline: baseline.report.kind, candidate: candidate.report.kind },
    );
  }
  const kind = baseline.report.kind as Kind;
  const spec = specOf(kind);
  const warnings: QuantWarning[] = [];
  const baselineIdentity: RunIdentity = spec.identity(
    baseline.report.inputs as unknown as Record<string, unknown>,
  );
  const candidateIdentity: RunIdentity = spec.identity(
    candidate.report.inputs as unknown as Record<string, unknown>,
  );
  const sameUniverse =
    baselineIdentity.universe === null || candidateIdentity.universe === null
      ? null
      : baselineIdentity.universe === candidateIdentity.universe;
  const sameAsOf =
    baselineIdentity.asOf === null || candidateIdentity.asOf === null
      ? null
      : baselineIdentity.asOf === candidateIdentity.asOf;
  if (sameUniverse === false || sameAsOf === false) {
    warnings.push(
      warning(
        WarningCode.ArtifactComparisonDifferentUniverse,
        `${functionName}: the runs were computed over ${sameUniverse === false ? `different universes ('${baselineIdentity.universe}' vs '${candidateIdentity.universe}')` : 'the same universe'}${sameAsOf === false ? ` and different as-of dates (${baselineIdentity.asOf} vs ${candidateIdentity.asOf})` : ''} — membership and rank moves below mix a population change with a signal change.`,
        'warn',
        {
          baselineUniverse: baselineIdentity.universe,
          candidateUniverse: candidateIdentity.universe,
          baselineAsOf: baselineIdentity.asOf,
          candidateAsOf: candidateIdentity.asOf,
        },
      ),
    );
  }
  const baselineRun = baseline.report.run as RunOf<ResearchRunKind>;
  const candidateRun = candidate.report.run as RunOf<ResearchRunKind>;
  const baselineProtocol = baseline.report.hygiene?.protocol?.verdict ?? null;
  const candidateProtocol = candidate.report.hygiene?.protocol?.verdict ?? null;
  const runDiff = artifactReplayParity({
    saved: baselineRun as unknown as Record<string, unknown>,
    recomputed: candidateRun as unknown as Record<string, unknown>,
    limits: { maximumDifferences, maximumLeaves },
  });
  return deepFreeze({
    kind,
    artifactIds: { baseline: baseline.artifactId, candidate: candidate.artifactId },
    sameUniverse,
    sameAsOf,
    sameFilter: sameCanonical(baselineIdentity.filter, candidateIdentity.filter),
    sameRankBy: sameCanonical(baselineIdentity.rankBy, candidateIdentity.rankBy),
    sameComponents: sameCanonical(baselineIdentity.components, candidateIdentity.components),
    sameInputs: contentHash(baseline.report.inputs) === contentHash(candidate.report.inputs),
    membership:
      spec.members === null
        ? null
        : membershipOf(spec.members(baselineRun), spec.members(candidateRun), listedIds),
    rankMoves:
      spec.ranks === null
        ? null
        : rankMovesOf(spec.ranks(baselineRun), spec.ranks(candidateRun), listedIds),
    scoreDeltas:
      spec.scores === null
        ? null
        : scoreDeltasOf(spec.scores(baselineRun), spec.scores(candidateRun), listedIds),
    exclusionReasons:
      spec.exclusionReasons === null
        ? null
        : countDeltasOf(spec.exclusionReasons(baselineRun), spec.exclusionReasons(candidateRun)),
    coefficients:
      spec.coefficients === null
        ? null
        : namedDeltasOf(spec.coefficients(baselineRun), spec.coefficients(candidateRun)),
    averageAbnormalReturns:
      spec.abnormalReturns === null
        ? null
        : abnormalReturnDeltasOf(
            spec.abnormalReturns(baselineRun),
            spec.abnormalReturns(candidateRun),
          ),
    quantiles:
      spec.quantiles === null
        ? null
        : keyedDeltasOf(spec.quantiles(baselineRun), spec.quantiles(candidateRun)),
    horizons:
      spec.horizons === null
        ? null
        : keyedDeltasOf(spec.horizons(baselineRun), spec.horizons(candidateRun)),
    portfolios:
      spec.portfolios === null
        ? null
        : portfoliosOf(spec.portfolios(baselineRun), spec.portfolios(candidateRun), listedIds),
    hygieneVerdict:
      baselineProtocol === null || candidateProtocol === null
        ? null
        : {
            baseline: baselineProtocol,
            candidate: candidateProtocol,
            changed: baselineProtocol !== candidateProtocol,
          },
    run: {
      differenceCount: runDiff.differenceCount,
      retainedDifferences: runDiff.differences.length,
      addedPaths: runDiff.addedPaths,
      removedPaths: runDiff.removedPaths,
      truncated: runDiff.truncated,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      kind,
      limits: { maximumDifferences, maximumLeaves, listedIds },
    },
    diagnostics: { warnings },
  });
}
