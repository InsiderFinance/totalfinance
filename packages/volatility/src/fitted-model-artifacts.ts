/**
 * `@insiderfinance/totalfinance/volatility/artifacts` — the eight verbs of Stage 4.5 Decision 3 over the twelve
 * volatility families (Decision 2), riding the Gate B spine verbatim:
 *
 * - `fittedModelArtifact` projects a direct calibrator's result into the fitted-model report and
 *   saves it as ONE `AnalysisArtifact` (identity, not bulk, in `inputs`; the verbatim fit and
 *   calibration in `result`; a declared bulk row set may travel as a `TableHandle`);
 * - `readFittedModel` restores through `readAnalysisArtifact` and applies the caller's migration
 *   registry a second time at the REPORT level (Decision 5), returning both echo lists;
 * - `evaluateFittedModel` dispatches to the family's direct evaluator with the fit verbatim and
 *   discloses extrapolation (counted and warned, never silent);
 * - `replayFittedModel` re-issues the direct calibrator from the stored calibration (referenced
 *   rows re-verified by hash) and proves byte parity (Decision 7);
 * - `compareFittedModels` reports the typed deltas of Decision 6 plus a shared-grid evaluation
 *   difference through the direct evaluator, under a stated placement rule;
 * - `warmStartFrom`, `fittedModelStability`, `fittedModelHoldout` — Decision 8, through the direct
 *   calibrators and evaluators only.
 *
 * Nothing here computes a number a direct function would not compute; every request is closed,
 * every limit is count-safe, and every result is a deeply frozen Law-2 report or a spine envelope.
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
  flattenSummaryParameters,
  fromCanonicalJson,
  isTableHandle,
  readAnalysisArtifact,
  requireComparisonTolerance,
  requireFittedModelSummary,
  requireWorkLimit,
  residualStatistics,
  scanCanonicalData,
  tableHandleForRows,
  verifyReferencedRows,
  type AnalysisArtifact,
  type AppliedMigration,
  type ArtifactMigrationRegistry,
  type ArtifactReplayParity,
  type ComparisonLimits,
  type ComparisonTolerance,
  type FittedModelSummary,
  type TableHandle,
} from '@totalfinance/core/artifacts';
import { mulberry32 } from '@totalfinance/math';
import {
  FAMILY_SPECS,
  VOLATILITY_MODEL_FAMILIES,
  surfaceSnapshotOf,
  type CalibrationOf,
  type EvaluationOf,
  type FamilySpec,
  type FitOf,
  type StoredCalibrationOf,
  type VolatilityModelFamily,
  type WarmStartOf,
} from './fitted-model-families.js';
import type { VolatilitySurface } from './surface.js';

export const VOLATILITY_FITTED_MODEL_ARTIFACT_TYPE = 'volatility.fitted-model';

/** Decision 9's bounded-work table (core's `ARTIFACT_WORK_LIMITS`, re-exported for this subpath's callers). */
export const FITTED_MODEL_LIMITS = ARTIFACT_WORK_LIMITS;

export interface FittedModelArtifactLimits {
  maximumEmbeddedBytes?: number;
  embeddedRowLimit?: number;
}

/** The typed report every domain verb reads and writes — the artifact's `result`, verbatim. */
export type VolatilityFittedModelReport<F extends VolatilityModelFamily = VolatilityModelFamily> =
  Readonly<Record<string, unknown>> & {
    family: F;
    modelVersion: number;
    summary: FittedModelSummary;
    /** The direct calibrator's result, verbatim (the surface as its own `toJSON()` snapshot). */
    fit: FitOf<F>;
    /** The calibrator's input, verbatim, except that a referenced bulk row set is its `TableHandle`. */
    calibration: StoredCalibrationOf<F>;
    referencedData: Record<string, TableHandle>;
    assumptions: {
      conventionsVersion: string;
      family: F;
      modelVersion: number;
      calibrator: string;
      evaluator: string | null;
      inputPolicy: 'embedded' | 'referenced';
      projection: string;
    };
    diagnostics: {
      warnings: QuantWarning[];
      fitWarningCount: number;
      embeddedCalibrationBytes: number;
      referencedRowSets: string[];
    };
  };

export interface FittedModelArtifactInput<F extends VolatilityModelFamily> {
  family: F;
  /** The direct calibrator's result; for `volatility-surface` the live surface is accepted and snapshotted. */
  fit: F extends 'volatility-surface' ? FitOf<F> | VolatilitySurface : FitOf<F>;
  /** The calibrator's input with its rows — the adapter mints the handle for any row set named in `referenceRowSets`. */
  calibration: CalibrationOf<F>;
  /** Row sets (from the family descriptor's `referenceableRowSets`) to store by `TableHandle` instead of embedding. */
  referenceRowSets?: readonly string[];
  /** Storage locators to stamp on the minted handles, keyed by row set. */
  locators?: Record<string, string>;
  snapshotHash?: string;
  libraryVersion?: string;
  createdFrom?: string[];
  provenance?: Provenance;
  limits?: FittedModelArtifactLimits;
}

export interface ReadFittedModelResult<F extends VolatilityModelFamily = VolatilityModelFamily> {
  report: VolatilityFittedModelReport<F>;
  artifact: AnalysisArtifact;
  migrationsApplied: AppliedMigration[];
  modelMigrationsApplied: AppliedMigration[];
}

export interface FittedModelEvaluation<F extends VolatilityModelFamily = VolatilityModelFamily> {
  family: F;
  at: EvaluationOf<F>;
  values: (number | null)[];
  reasons: Array<{ index: number; reason: string }>;
  coordinates: Array<Record<string, number | string>>;
  unit: string;
  assumptions: {
    conventionsVersion: string;
    family: F;
    modelVersion: number;
    evaluator: string;
    options: Record<string, unknown>;
    extrapolation: string;
  };
  diagnostics: { warnings: QuantWarning[]; outsideCalibratedRange: number };
}

export interface FittedModelReplay<F extends VolatilityModelFamily = VolatilityModelFamily> {
  family: F;
  artifactId: string;
  recomputed: VolatilityFittedModelReport<F>;
  parity: ArtifactReplayParity;
  assumptions: {
    conventionsVersion: string;
    family: F;
    modelVersion: number;
    calibrator: string;
    libraryVersion: { saved: string | null; current: string | null };
    referencedRowSets: string[];
  };
  diagnostics: { warnings: QuantWarning[] };
}

export interface ParameterDelta {
  parameter: string;
  baselineValue: number | string;
  candidateValue: number | string;
  absoluteDelta: number | null;
  relativeDelta: number | null;
}

export interface FittedModelComparison<F extends VolatilityModelFamily = VolatilityModelFamily> {
  family: F;
  artifactIds: { baseline: string | null; candidate: string | null };
  sameMarket: boolean | null;
  sameCalibrationInput: boolean;
  parameters: ParameterDelta[];
  objective: {
    kind: string;
    unit: string;
    baselineValue: number | null;
    candidateValue: number | null;
    absoluteDelta: number | null;
  };
  convergence: { baseline: boolean; candidate: boolean };
  residuals: {
    baselineRootMeanSquare: number | null;
    candidateRootMeanSquare: number | null;
    absoluteDelta: number | null;
  };
  modelRisk: {
    baselineArbitrageFree: boolean | null;
    candidateArbitrageFree: boolean | null;
    changed: boolean;
  };
  fit: {
    differenceCount: number;
    retainedDifferences: number;
    addedPaths: string[];
    removedPaths: string[];
    truncated: boolean;
  };
  evaluation: {
    grid: Array<Record<string, number | string>>;
    unit: string;
    comparedCount: number;
    nullCount: number;
    maximumAbsoluteDifference: number | null;
    rootMeanSquareDifference: number | null;
    placement: string;
  } | null;
  withinTolerance: boolean | null;
  assumptions: {
    conventionsVersion: string;
    family: F;
    tolerance: ComparisonTolerance | null;
    limits: { maximumDifferences: number; maximumLeaves: number; gridPoints: number };
    evaluationReason: string | null;
  };
  diagnostics: { warnings: QuantWarning[] };
}

export interface FittedModelStabilityInput<F extends VolatilityModelFamily> {
  family: F;
  calibration: CalibrationOf<F>;
  restarts: number;
  perturbation: { relative: number };
  seed: number;
  tolerance?: ComparisonTolerance;
}

export interface FittedModelStabilityReport<
  F extends VolatilityModelFamily = VolatilityModelFamily,
> {
  family: F;
  restarts: number;
  parameters: Record<
    string,
    { baseline: number; minimum: number; maximum: number; standardDeviation: number }
  >;
  objective: {
    unit: string;
    baseline: number | null;
    minimum: number | null;
    maximum: number | null;
  };
  convergedCount: number;
  stable: boolean | null;
  assumptions: {
    conventionsVersion: string;
    family: F;
    modelVersion: number;
    seed: number;
    generator: 'mulberry32';
    perturbation: { relative: number };
    members: string[];
    tolerance: ComparisonTolerance | null;
  };
  diagnostics: { warnings: QuantWarning[] };
}

export type FittedModelHoldoutSelection =
  | { indices: number[] }
  | { everyNth: number; offset: number }
  | { lastCount: number };

export interface FittedModelHoldoutInput<F extends VolatilityModelFamily> {
  family: F;
  calibration: CalibrationOf<F>;
  holdout: FittedModelHoldoutSelection;
}

export interface FittedModelHoldoutReport<F extends VolatilityModelFamily = VolatilityModelFamily> {
  family: F;
  retainedCount: number;
  heldOutCount: number;
  inSample: { count: number; rootMeanSquare: number | null; maximumAbsolute: number | null };
  outOfSample: { count: number; rootMeanSquare: number | null; maximumAbsolute: number | null };
  unit: string;
  retainedFit: FittedModelSummary;
  assumptions: {
    conventionsVersion: string;
    family: F;
    modelVersion: number;
    holdout: FittedModelHoldoutSelection;
    residualSource: 'direct-evaluator';
    partition: 'cross-sectional points' | 'time-series prefix';
  };
  diagnostics: { warnings: QuantWarning[] };
}

// ───────────────────────────────────────────── helpers ─────────────────────────────────────────────

const REPORT_KEYS = [
  'family',
  'modelVersion',
  'summary',
  'fit',
  'calibration',
  'referencedData',
  'assumptions',
  'diagnostics',
] as const;
const ASSUMPTION_KEYS = [
  'conventionsVersion',
  'family',
  'modelVersion',
  'calibrator',
  'evaluator',
  'inputPolicy',
  'projection',
] as const;
const DIAGNOSTIC_KEYS = [
  'warnings',
  'fitWarningCount',
  'embeddedCalibrationBytes',
  'referencedRowSets',
] as const;

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

function requireFamily(functionName: string, value: unknown): VolatilityModelFamily {
  if (
    typeof value !== 'string' ||
    !(VOLATILITY_MODEL_FAMILIES as readonly string[]).includes(value)
  ) {
    fail(
      functionName,
      `family must be one of ${VOLATILITY_MODEL_FAMILIES.join(', ')}. Received ${typeof value === 'string' ? JSON.stringify(value) : value === null ? 'null' : typeof value}.`,
      ErrorCode.InputInvalidEnum,
      { field: 'family' },
    );
  }
  return value as VolatilityModelFamily;
}

function specOf<F extends VolatilityModelFamily>(family: F): FamilySpec<F> {
  return FAMILY_SPECS[family] as unknown as FamilySpec<F>;
}

function requireLimit(
  functionName: string,
  field: string,
  value: unknown,
  law: { default?: number; maximum: number },
  floor = 1,
): number {
  return requireWorkLimit({ functionName, field, value, law, floor });
}

function requireTolerance(functionName: string, tolerance: unknown): ComparisonTolerance | null {
  return requireComparisonTolerance({ functionName, tolerance });
}

function detach<T>(value: T): T {
  return fromCanonicalJson(canonicalJsonOf(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value as Record<string, unknown>)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

function readPath(record: Record<string, unknown>, path: readonly string[]): unknown {
  let cursor: unknown = record;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function withPath(
  record: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 1) return { ...record, [path[0]!]: value };
  const head = path[0]!;
  const inner = (record[head] ?? {}) as Record<string, unknown>;
  return { ...record, [head]: withPath(inner, path.slice(1), value) };
}

function isArtifact(value: unknown): value is AnalysisArtifact {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'totalfinance.analysis-artifact'
  );
}

const PROJECTION =
  'summary = pure projection of the verbatim fit (no field dropped, renamed, or recomputed); residuals come from the calibrator or from the family evaluator re-issued at the calibration points; nested parameters flatten to dot paths';

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
        `the embedded ${label} exceeds the embedded-input budget (${maximumEmbeddedBytes.toLocaleString()} work units ≈ canonical bytes) — reference the bulk row set (referenceRowSets) or raise limits.maximumEmbeddedBytes up to ${FITTED_MODEL_LIMITS.maximumEmbeddedBytes.maximum.toLocaleString()}.`,
        ErrorCode.ArtifactEmbeddedInputTooLarge,
        { field: label, maximumEmbeddedBytes },
      );
    }
    throw error;
  }
}

/** Build the report for a (family, fit, full calibration, stored calibration) — the one projection law. */
function buildReport<F extends VolatilityModelFamily>(
  functionName: string,
  family: F,
  fit: FitOf<F>,
  calibration: CalibrationOf<F>,
  stored: StoredCalibrationOf<F>,
  referencedData: Record<string, TableHandle>,
  snapshotHash: string | null,
  embeddedCalibrationBytes: number,
): VolatilityFittedModelReport<F> {
  const spec = specOf(family);
  const projection = spec.project(fit, calibration);
  const fitWarnings = (fit as { diagnostics?: { warnings?: unknown[] } }).diagnostics?.warnings;
  const fitWarningCount = Array.isArray(fitWarnings) ? fitWarnings.length : 0;
  const summary: FittedModelSummary = {
    family: spec.descriptor.qualifiedFamily,
    modelVersion: spec.descriptor.modelVersion,
    parameters: projection.parameters,
    objective: projection.objective,
    convergence: projection.convergence,
    residuals: projection.residuals,
    modelRisk: projection.modelRisk,
    weighting: projection.weighting,
    inputIdentity: { calibrationHash: contentHash(stored), snapshotHash },
    warningCount: fitWarningCount,
  };
  requireFittedModelSummary(functionName, 'summary', summary);
  const referencedRowSets = Object.keys(referencedData).sort();
  const report = {
    family,
    modelVersion: spec.descriptor.modelVersion,
    summary,
    fit,
    calibration: stored,
    referencedData,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      family,
      modelVersion: spec.descriptor.modelVersion,
      calibrator: spec.descriptor.calibrator,
      evaluator: spec.descriptor.evaluator,
      inputPolicy: referencedRowSets.length > 0 ? ('referenced' as const) : ('embedded' as const),
      projection: PROJECTION,
    },
    diagnostics: {
      warnings: [] as QuantWarning[],
      fitWarningCount,
      embeddedCalibrationBytes,
      referencedRowSets,
    },
  };
  return report as unknown as VolatilityFittedModelReport<F>;
}

/** Validate a restored report structurally (closed keys, known family/version, the summary grammar, handles). */
function requireReport(functionName: string, value: unknown): VolatilityFittedModelReport {
  requireArgumentObject(functionName, 'artifact.result', value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, 'artifact.result', record, REPORT_KEYS);
  for (const key of REPORT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail(
        functionName,
        `artifact.result.${key} is missing — this is not a volatility fitted-model report.`,
        ErrorCode.InputMissingField,
        { field: `artifact.result.${key}` },
      );
    }
  }
  const family = requireFamily(functionName, record['family']);
  requireFittedModelSummary(functionName, 'artifact.result.summary', record['summary']);
  requireArgumentObject(functionName, 'artifact.result.fit', record['fit']);
  requireArgumentObject(functionName, 'artifact.result.calibration', record['calibration']);
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
  const assumptions = record['assumptions'];
  requireArgumentObject(functionName, 'artifact.result.assumptions', assumptions);
  ensureKnownKeys(
    functionName,
    'artifact.result.assumptions',
    assumptions as object,
    ASSUMPTION_KEYS,
  );
  const a = assumptions as Record<string, unknown>;
  if (a['family'] !== family) {
    fail(
      functionName,
      `artifact.result.assumptions.family (${JSON.stringify(a['family'])}) does not name the report's family '${family}'.`,
      ErrorCode.InputWrongShape,
      { field: 'artifact.result.assumptions.family' },
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
  return record as unknown as VolatilityFittedModelReport;
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

// ──────────────────────────────────────────── the verbs ─────────────────────────────────────────────

/**
 * Describe a direct calibrator's result and save it as an identified, immutable artifact.
 *
 * @example
 * ```ts
 * const fit = calibrateSsvi(surface, { weight: 'vega' });
 * const artifact = fittedModelArtifact({
 *   family: 'ssvi',
 *   fit,
 *   calibration: { surface, options: { weight: 'vega' } },
 *   snapshotHash: marketSnapshotContentHash(snapshot),
 * });
 * ```
 */
export function fittedModelArtifact<F extends VolatilityModelFamily>(
  input: FittedModelArtifactInput<F>,
): AnalysisArtifact {
  const functionName = 'fittedModelArtifact';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, [
    'family',
    'fit',
    'calibration',
    'referenceRowSets',
    'locators',
    'snapshotHash',
    'libraryVersion',
    'createdFrom',
    'provenance',
    'limits',
  ]);
  const family = requireFamily(functionName, input.family) as F;
  const spec = specOf(family);
  const limits = input.limits;
  if (limits !== undefined) {
    requireArgumentObject(functionName, 'limits', limits);
    ensureKnownKeys(functionName, 'limits', limits, ['maximumEmbeddedBytes', 'embeddedRowLimit']);
  }
  const maximumEmbeddedBytes = requireLimit(
    functionName,
    'limits.maximumEmbeddedBytes',
    limits?.maximumEmbeddedBytes,
    FITTED_MODEL_LIMITS.maximumEmbeddedBytes,
  );
  const embeddedRowLimit = requireLimit(
    functionName,
    'limits.embeddedRowLimit',
    limits?.embeddedRowLimit,
    FITTED_MODEL_LIMITS.embeddedRowLimit,
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

  // The fit: a plain, acyclic, behavior-free value (disclosed non-finite numbers are legal in a RESULT).
  const rawFit = surfaceSnapshotOf(input.fit);
  requireArgumentObject(functionName, 'fit', rawFit);
  scanEmbedded(functionName, 'fit', rawFit, maximumEmbeddedBytes, false);
  const fit = detach(rawFit) as FitOf<F>;

  // The calibration: rows for the projection; the declared row set may be referenced by handle.
  requireArgumentObject(functionName, 'calibration', input.calibration);
  // null is NOT omission (C06): a null row-set list must teach, never coalesce into "embed everything".
  if (input.referenceRowSets !== undefined) {
    requireArgumentArray(functionName, 'referenceRowSets', input.referenceRowSets);
  }
  const referenceRowSets = input.referenceRowSets ?? [];
  const referenceable = spec.descriptor.referenceableRowSets;
  for (const name of referenceRowSets) {
    if (typeof name !== 'string' || !referenceable.includes(name)) {
      fail(
        functionName,
        `referenceRowSets names ${JSON.stringify(name)}, which the '${family}' family cannot reference — its referenceable row sets are ${referenceable.length > 0 ? referenceable.join(', ') : 'none'} (see FITTED_MODEL_FAMILIES['${family}'].referenceableRowSets).`,
        ErrorCode.InputInvalidEnum,
        { field: 'referenceRowSets', family },
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
  scanEmbedded(functionName, 'calibration', input.calibration, maximumEmbeddedBytes, true);
  const calibration = detach(input.calibration) as CalibrationOf<F>;
  let stored = calibration as unknown as Record<string, unknown>;
  const referencedData: Record<string, TableHandle> = {};
  if (spec.rowSet !== null) {
    const label = spec.rowSet.join('.');
    const rows = readPath(stored, spec.rowSet);
    if (!Array.isArray(rows)) {
      fail(
        functionName,
        `calibration.${label} must be the row array the calibrator consumed. Received ${rows === null ? 'null' : typeof rows}.`,
        ErrorCode.InputWrongType,
        { field: `calibration.${label}` },
      );
    }
    if (referenceRowSets.includes(label)) {
      const handle = tableHandleForRows({
        rows,
        ...(input.locators?.[label] !== undefined ? { locator: input.locators[label] } : {}),
      });
      referencedData[label] = handle;
      stored = withPath(stored, spec.rowSet, handle);
    } else if (rows.length > embeddedRowLimit) {
      fail(
        functionName,
        `calibration.${label} has ${rows.length} rows, above the embedded row limit ${embeddedRowLimit} — nothing is truncated silently. Either reference the row set (referenceRowSets: ['${label}'], which stores its content hash and row count and expects the rows again at replay) or raise limits.embeddedRowLimit up to ${FITTED_MODEL_LIMITS.embeddedRowLimit.maximum}.`,
        ErrorCode.ArtifactEmbeddedInputTooLarge,
        { field: `calibration.${label}`, rows: rows.length, embeddedRowLimit },
      );
    }
  }
  const storedBytes = canonicalJsonOf(stored).length;
  if (storedBytes > maximumEmbeddedBytes) {
    fail(
      functionName,
      `the embedded calibration is ${storedBytes.toLocaleString()} canonical bytes, above the limit ${maximumEmbeddedBytes.toLocaleString()} — reference the bulk row set (referenceRowSets) or raise limits.maximumEmbeddedBytes up to ${FITTED_MODEL_LIMITS.maximumEmbeddedBytes.maximum.toLocaleString()}.`,
      ErrorCode.ArtifactEmbeddedInputTooLarge,
      { field: 'calibration', bytes: storedBytes, maximumEmbeddedBytes },
    );
  }
  const report = buildReport(
    functionName,
    family,
    fit,
    calibration,
    stored as unknown as StoredCalibrationOf<F>,
    referencedData,
    snapshotHash,
    storedBytes,
  );
  return createAnalysisArtifact({
    artifactType: VOLATILITY_FITTED_MODEL_ARTIFACT_TYPE,
    producedBy: {
      operation: spec.descriptor.calibrator,
      ...(input.libraryVersion !== undefined ? { libraryVersion: input.libraryVersion } : {}),
    },
    inputs: {
      ...(snapshotHash !== null ? { snapshotHash } : {}),
      parameters: {
        family,
        modelVersion: spec.descriptor.modelVersion,
        calibrationHash: report.summary.inputIdentity.calibrationHash,
      },
    },
    ...(input.createdFrom !== undefined ? { createdFrom: input.createdFrom } : {}),
    result: report,
    ...(Object.keys(referencedData).length > 0 ? { tables: referencedData } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  });
}

/**
 * Restore a fitted-model artifact: Gate B's read door, a foreign-type refusal, then the caller's
 * registry applied a second time at the report level (Decision 5), then the report re-validated.
 */
export function readFittedModel(input: {
  /** The artifact as held OR as restored from JSON (`fromCanonicalJson`) — validated at runtime, never trusted by declaration. */
  artifact: unknown;
  migrations?: ArtifactMigrationRegistry;
}): ReadFittedModelResult {
  const functionName = 'readFittedModel';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['artifact', 'migrations']);
  const read = readAnalysisArtifact({
    artifact: input.artifact,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
  });
  const artifact = read.artifact;
  if (artifact.artifactType !== VOLATILITY_FITTED_MODEL_ARTIFACT_TYPE) {
    fail(
      functionName,
      `the artifact's type is '${artifact.artifactType}', not '${VOLATILITY_FITTED_MODEL_ARTIFACT_TYPE}' — this reader restores volatility fitted models only; ${artifact.artifactType.startsWith('fixed-income.') ? 'use @insiderfinance/totalfinance/fixed-income/artifacts' : artifact.artifactType.startsWith('research.') ? 'use @insiderfinance/totalfinance/research/artifacts' : 'read it with the package that owns that type'}.`,
      ErrorCode.ArtifactFamilyMismatch,
      { artifactType: artifact.artifactType },
    );
  }
  const raw = artifact.result as Record<string, unknown>;
  const family = requireFamily(functionName, raw['family']);
  const migrated = applyReportMigrations({
    functionName,
    kind: `${VOLATILITY_FITTED_MODEL_ARTIFACT_TYPE}:${family}`,
    report: raw,
    storedVersion: raw['modelVersion'],
    currentVersion: specOf(family).descriptor.modelVersion,
    versionField: 'modelVersion',
    subject: `'${family}' report`,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
  });
  const report = migrated.report;
  const modelMigrationsApplied = migrated.modelMigrationsApplied;
  const validated = requireReport(functionName, report);
  return {
    report: deepFreeze(detach(validated)),
    artifact,
    migrationsApplied: read.migrationsApplied,
    modelMigrationsApplied,
  };
}

function resolveModel(
  functionName: string,
  model: unknown,
  field = 'model',
): { report: VolatilityFittedModelReport; artifactId: string | null } {
  if (isArtifact(model)) {
    const read = readFittedModel({ artifact: model });
    return { report: read.report, artifactId: read.artifact.id };
  }
  requireArgumentObject(functionName, field, model);
  return { report: requireReport(functionName, model), artifactId: null };
}

/** The full calibration behind a report: embedded rows as stored, referenced rows supplied and re-verified. */
function fullCalibration(
  functionName: string,
  report: VolatilityFittedModelReport,
  referencedData: Record<string, unknown[]> | undefined,
): CalibrationOf<VolatilityModelFamily> {
  const spec = specOf(report.family);
  let calibration = report.calibration as unknown as Record<string, unknown>;
  for (const label of report.diagnostics.referencedRowSets) {
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
    calibration = withPath(
      calibration,
      spec.rowSet!,
      detach(verifyReferencedRows({ functionName, label, handle, rows })),
    );
  }
  return calibration as unknown as CalibrationOf<VolatilityModelFamily>;
}

/**
 * Evaluate a restored fitted model through its family's direct evaluator (Decision 3).
 */
export function evaluateFittedModel<F extends VolatilityModelFamily>(input: {
  model: VolatilityFittedModelReport<F> | AnalysisArtifact;
  at: EvaluationOf<F>;
}): FittedModelEvaluation<F> {
  const functionName = 'evaluateFittedModel';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['model', 'at']);
  const { report } = resolveModel(functionName, input.model);
  const spec = specOf(report.family);
  if (spec.evaluate === null) {
    fail(
      functionName,
      `the '${report.family}' family has no evaluator — ${spec.descriptor.supportedProducts}.`,
      ErrorCode.ArtifactOperationUnsupported,
      { family: report.family },
    );
  }
  requireArgumentObject(functionName, 'at', input.at);
  ensureKnownKeys(functionName, 'at', input.at as object, spec.evaluationKeys);
  const calibration = report.calibration as unknown as CalibrationOf<VolatilityModelFamily>;
  const answer = spec.evaluate(
    report.fit as never,
    calibration as never,
    input.at as never,
    report.summary.modelRisk.calibratedRange,
  );
  return deepFreeze({
    family: report.family as F,
    at: detach(input.at),
    values: answer.values,
    reasons: answer.reasons,
    coordinates: answer.coordinates,
    unit: answer.unit,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      family: report.family as F,
      modelVersion: report.modelVersion,
      evaluator: answer.evaluator,
      options: answer.options,
      extrapolation:
        'coordinates outside summary.modelRisk.calibratedRange are evaluated (the model is defined there), counted in diagnostics.outsideCalibratedRange, and warned — never refused and never silent',
    },
    diagnostics: {
      warnings: answer.warnings,
      outsideCalibratedRange: answer.outsideCalibratedRange,
    },
  });
}

/**
 * Re-issue the family's direct calibrator from the stored calibration and prove byte parity.
 */
export function replayFittedModel(input: {
  /** The artifact as held OR as restored from JSON (`fromCanonicalJson`) — validated at runtime, never trusted by declaration. */
  artifact: unknown;
  migrations?: ArtifactMigrationRegistry;
  referencedData?: Record<string, unknown[]>;
  libraryVersion?: string;
  limits?: ComparisonLimits;
}): FittedModelReplay {
  const functionName = 'replayFittedModel';
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
  const read = readFittedModel({
    artifact: input.artifact,
    ...(input.migrations !== undefined ? { migrations: input.migrations } : {}),
  });
  const report = read.report;
  const spec = specOf(report.family);
  const calibration = fullCalibration(functionName, report, input.referencedData);
  const recomputedFit = spec.calibrate(calibration as never) as FitOf<VolatilityModelFamily>;
  const recomputed = buildReport(
    functionName,
    report.family,
    detach(recomputedFit),
    calibration as never,
    report.calibration as never,
    { ...report.referencedData },
    report.summary.inputIdentity.snapshotHash,
    report.diagnostics.embeddedCalibrationBytes,
  );
  const parity = artifactReplayParity({
    saved: report.fit as unknown as Record<string, unknown>,
    recomputed: recomputed.fit as unknown as Record<string, unknown>,
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
        `${functionName}: replay parity FAILED for '${report.family}' — ${parity.differenceCount} difference${parity.differenceCount === 1 ? '' : 's'} between the saved fit and the recomputation (first at ${parity.differences[0]?.path ?? parity.addedPaths[0] ?? parity.removedPaths[0] ?? '(unknown)'}). A calibration is deterministic given its inputs, so this is a finding: a changed calibrator, dependency, or platform.`,
        'warn',
        { differenceCount: parity.differenceCount },
      ),
    );
  }
  return deepFreeze({
    family: report.family,
    artifactId: read.artifact.id,
    recomputed: deepFreeze(recomputed),
    parity,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      family: report.family,
      modelVersion: report.modelVersion,
      calibrator: spec.descriptor.calibrator,
      libraryVersion: { saved, current },
      referencedRowSets: [...report.diagnostics.referencedRowSets],
    },
    diagnostics: { warnings },
  });
}

function flattenParameters(summary: FittedModelSummary): Map<string, number | string> {
  return new Map(Object.entries(flattenSummaryParameters(summary)));
}

function uniformGrid(grid: { minimum: number; maximum: number; points: number }): number[] {
  const { minimum, maximum, points } = grid;
  if (points === 1 || maximum === minimum) return [minimum];
  const out: number[] = [];
  for (let index = 0; index < points; index++)
    out.push(minimum + ((maximum - minimum) * index) / (points - 1));
  return out;
}

function unionRange(
  a: { minimum: number; maximum: number } | undefined,
  b: { minimum: number; maximum: number } | undefined,
): { minimum: number; maximum: number } | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { minimum: Math.min(a.minimum, b.minimum), maximum: Math.max(a.maximum, b.maximum) };
}

type EvaluationRequest = Record<string, unknown>;

/** Decision 6's placement rule per family: the coordinates both fits are evaluated at. */
function comparisonRequests(
  family: VolatilityModelFamily,
  baseline: VolatilityFittedModelReport,
  candidate: VolatilityFittedModelReport,
  gridPoints: number,
  evaluation: Record<string, unknown> | undefined,
): { requests: EvaluationRequest[]; placement: string } | { reason: string } {
  const range = (key: string) =>
    unionRange(
      baseline.summary.modelRisk.calibratedRange[key],
      candidate.summary.modelRisk.calibratedRange[key],
    );
  switch (family) {
    case 'svi': {
      const k = range('logMoneyness');
      const t = (baseline.calibration as { options?: { timeToExpiryYears?: number } }).options
        ?.timeToExpiryYears;
      const tCandidate = (candidate.calibration as { options?: { timeToExpiryYears?: number } })
        .options?.timeToExpiryYears;
      if (k === undefined) return { reason: 'no calibrated log-moneyness range on the fits' };
      if (t === undefined || tCandidate === undefined)
        return {
          reason:
            'both SVI calibrations must carry options.timeToExpiryYears for an implied-volatility grid',
        };
      return {
        requests: [
          {
            logMoneyness: uniformGrid({
              minimum: k.minimum,
              maximum: k.maximum,
              points: gridPoints,
            }),
            timeToExpiryYears: t,
          },
        ],
        placement: `${gridPoints} points uniform in log-moneyness over the union of the calibrated ranges; each fit at its own calibration maturity`,
      };
    }
    case 'sabr-smile':
    case 'vanna-volga':
    case 'vanna-volga-5': {
      const strike = range('strike');
      if (strike === undefined) return { reason: 'no calibrated strike range on the fits' };
      return {
        requests: [
          {
            strikes: uniformGrid({
              minimum: strike.minimum,
              maximum: strike.maximum,
              points: gridPoints,
            }),
          },
        ],
        placement: `${gridPoints} strikes uniform over the union of the calibrated strike ranges; each fit at its own forward and maturity`,
      };
    }
    case 'ssvi':
    case 'essvi': {
      const k = range('logMoneyness');
      if (k === undefined) return { reason: 'no calibrated log-moneyness range on the fits' };
      const knots = (report: VolatilityFittedModelReport) =>
        (
          report.fit as { parameters: { thetaTerm: Array<{ timeToExpiryYears: number }> } }
        ).parameters.thetaTerm.map((knot) => knot.timeToExpiryYears);
      const maturities = [...new Set([...knots(baseline), ...knots(candidate)])].sort(
        (a, b) => a - b,
      );
      return {
        requests: [
          {
            logMoneyness: uniformGrid({
              minimum: k.minimum,
              maximum: k.maximum,
              points: gridPoints,
            }),
            timeToExpiryYears: maturities,
          },
        ],
        placement: `${gridPoints} points uniform in log-moneyness over the union of the calibrated ranges, crossed with the union of both fits' θ-knot maturities (${maturities.length})`,
      };
    }
    case 'heston-surface': {
      const strike = range('strike');
      const t = range('timeToExpiryYears');
      if (strike === undefined || t === undefined)
        return { reason: 'no calibrated strike/maturity ranges on the fits' };
      const maturities = [...new Set([t.minimum, t.maximum])];
      return {
        requests: [
          {
            type: 'call',
            strikes: uniformGrid({
              minimum: strike.minimum,
              maximum: strike.maximum,
              points: gridPoints,
            }),
            timeToExpiryYears: maturities,
          },
        ],
        placement: `${gridPoints} strikes uniform over the union of the calibrated strike ranges, at the union's shortest and longest calibrated maturities, call implied volatilities`,
      };
    }
    case 'event-volatility': {
      const expiries = (report: VolatilityFittedModelReport) =>
        (report.fit as { perExpiry: Array<{ expiry: string }> }).perExpiry.map((row) => row.expiry);
      const union = [...new Set([...expiries(baseline), ...expiries(candidate)])].sort();
      return {
        requests: [{ expiries: union }],
        placement: `the union of both fits' fitted expiries (${union.length})`,
      };
    }
    case 'volatility-surface': {
      const strike = range('strike');
      if (strike === undefined) return { reason: 'no calibrated strike range on the fits' };
      const expiries = (report: VolatilityFittedModelReport) =>
        (report.fit as { slices: Array<{ expiry: string }> }).slices.map((slice) => slice.expiry);
      const union = [...new Set([...expiries(baseline), ...expiries(candidate)])].sort();
      return {
        requests: union.map((expiry) => ({
          strikes: uniformGrid({
            minimum: strike.minimum,
            maximum: strike.maximum,
            points: gridPoints,
          }),
          expiry,
        })),
        placement: `${gridPoints} strikes uniform over the union of the calibrated strike ranges, at each of the union of both surfaces' expiries (${union.length})`,
      };
    }
    case 'garch': {
      if (evaluation === undefined)
        return {
          reason:
            "a GARCH comparison needs caller-supplied forecasting inputs — pass evaluation: { lastVariance, horizonPeriods: number[] } (the horizons are the caller's economics, never defaulted)",
        };
      const record = evaluation;
      const horizons = record['horizonPeriods'];
      if (
        !Array.isArray(horizons) ||
        horizons.length === 0 ||
        typeof record['lastVariance'] !== 'number'
      )
        return {
          reason: 'evaluation must be { lastVariance: number, horizonPeriods: number[] } for GARCH',
        };
      return {
        requests: horizons.map((horizonPeriods) => ({
          lastVariance: record['lastVariance'],
          horizonPeriods,
        })),
        placement: `caller-supplied horizons ${horizons.join(', ')} from lastVariance ${String(record['lastVariance'])}`,
      };
    }
    case 'har-rv': {
      if (evaluation === undefined || !Array.isArray(evaluation['history']))
        return {
          reason:
            'a HAR-RV comparison needs caller-supplied evaluation: { history: number[] } (one-step-ahead from that history)',
        };
      return {
        requests: [{ history: evaluation['history'] }],
        placement: `one-step-ahead forecasts from the caller-supplied history (${(evaluation['history'] as unknown[]).length} observations)`,
      };
    }
    case 'event-move':
      return { reason: 'the event-move family has no evaluator' };
  }
}

/**
 * Compare two fits of one family: named parameter deltas, objective/convergence/residual deltas,
 * arbitrage-status change, market and calibration identity, the structural fit diff, and a
 * shared-grid evaluation difference through the direct evaluator (Decision 6).
 */
export function compareFittedModels<F extends VolatilityModelFamily>(input: {
  baseline: VolatilityFittedModelReport<F> | AnalysisArtifact;
  candidate: VolatilityFittedModelReport<F> | AnalysisArtifact;
  tolerance?: ComparisonTolerance;
  evaluation?: Record<string, unknown>;
  limits?: ComparisonLimits & { gridPoints?: number };
}): FittedModelComparison<F> {
  const functionName = 'compareFittedModels';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, [
    'baseline',
    'candidate',
    'tolerance',
    'evaluation',
    'limits',
  ]);
  const tolerance = requireTolerance(functionName, input.tolerance);
  if (input.limits !== undefined) {
    requireArgumentObject(functionName, 'limits', input.limits);
    ensureKnownKeys(functionName, 'limits', input.limits, [
      'maximumDifferences',
      'maximumLeaves',
      'gridPoints',
    ]);
  }
  const maximumDifferences = requireLimit(
    functionName,
    'limits.maximumDifferences',
    input.limits?.maximumDifferences,
    FITTED_MODEL_LIMITS.maximumDifferences,
  );
  const maximumLeaves = requireLimit(
    functionName,
    'limits.maximumLeaves',
    input.limits?.maximumLeaves,
    FITTED_MODEL_LIMITS.maximumLeaves,
  );
  const gridPoints = requireLimit(
    functionName,
    'limits.gridPoints',
    input.limits?.gridPoints,
    FITTED_MODEL_LIMITS.gridPoints,
  );
  if (input.evaluation !== undefined)
    requireArgumentObject(functionName, 'evaluation', input.evaluation);
  const baseline = resolveModel(functionName, input.baseline, 'baseline');
  const candidate = resolveModel(functionName, input.candidate, 'candidate');
  if (baseline.report.family !== candidate.report.family) {
    fail(
      functionName,
      `the fits belong to different families — baseline is '${baseline.report.family}', candidate is '${candidate.report.family}'; their objectives and parameters do not share units. For a structural diff of two artifacts of one type use compareAnalysisArtifacts.`,
      ErrorCode.ArtifactFamilyMismatch,
      { baseline: baseline.report.family, candidate: candidate.report.family },
    );
  }
  const family = baseline.report.family as F;
  const spec = specOf(family);
  const warnings: QuantWarning[] = [];
  const baselineSnapshot = baseline.report.summary.inputIdentity.snapshotHash;
  const candidateSnapshot = candidate.report.summary.inputIdentity.snapshotHash;
  const sameMarket =
    baselineSnapshot === null || candidateSnapshot === null
      ? null
      : baselineSnapshot === candidateSnapshot;
  if (sameMarket === false) {
    warnings.push(
      warning(
        WarningCode.ArtifactComparisonDifferentMarket,
        `${functionName}: the two fits were calibrated under different market snapshots — still comparable, but the market moved between them.`,
        'warn',
        { baseline: baselineSnapshot, candidate: candidateSnapshot },
      ),
    );
  }
  // Parameters, named.
  const baselineParameters = flattenParameters(baseline.report.summary);
  const candidateParameters = flattenParameters(candidate.report.summary);
  const parameters: ParameterDelta[] = [];
  for (const key of [
    ...new Set([...baselineParameters.keys(), ...candidateParameters.keys()]),
  ].sort()) {
    const b = baselineParameters.get(key);
    const c = candidateParameters.get(key);
    if (b === undefined || c === undefined) {
      parameters.push({
        parameter: key,
        baselineValue: b ?? '(absent)',
        candidateValue: c ?? '(absent)',
        absoluteDelta: null,
        relativeDelta: null,
      });
      continue;
    }
    if (typeof b === 'number' && typeof c === 'number') {
      if (b === c) continue;
      const absoluteDelta = c - b;
      parameters.push({
        parameter: key,
        baselineValue: b,
        candidateValue: c,
        absoluteDelta,
        relativeDelta: b === 0 ? null : absoluteDelta / Math.abs(b),
      });
    } else if (b !== c) {
      parameters.push({
        parameter: key,
        baselineValue: b,
        candidateValue: c,
        absoluteDelta: null,
        relativeDelta: null,
      });
    }
  }
  const bo = baseline.report.summary.objective;
  const co = candidate.report.summary.objective;
  const br = baseline.report.summary.residuals?.rootMeanSquare ?? null;
  const cr = candidate.report.summary.residuals?.rootMeanSquare ?? null;
  const ba = baseline.report.summary.modelRisk.arbitrageFree;
  const ca = candidate.report.summary.modelRisk.arbitrageFree;
  if (ba === true && ca === false) {
    warnings.push(
      warning(
        WarningCode.VolatilityButterflyArbitrage,
        `${functionName}: the baseline fit was arbitrage-free and the candidate is not — a named finding, not a parameter delta.`,
        'warn',
        {},
      ),
    );
  }
  const fitDiff = artifactReplayParity({
    saved: baseline.report.fit as unknown as Record<string, unknown>,
    recomputed: candidate.report.fit as unknown as Record<string, unknown>,
    limits: { maximumDifferences, maximumLeaves },
  });
  // Shared-grid evaluation.
  let evaluation: FittedModelComparison['evaluation'] = null;
  let evaluationReason: string | null = null;
  if (spec.evaluate === null) evaluationReason = 'the family has no evaluator';
  else {
    const placement = comparisonRequests(
      family,
      baseline.report,
      candidate.report,
      gridPoints,
      input.evaluation,
    );
    if ('reason' in placement) evaluationReason = placement.reason;
    else {
      const grid: Array<Record<string, number | string>> = [];
      const differences: number[] = [];
      let nullCount = 0;
      let unit = '';
      for (const request of placement.requests) {
        const b = spec.evaluate(
          baseline.report.fit as never,
          baseline.report.calibration as never,
          request as never,
          baseline.report.summary.modelRisk.calibratedRange,
        );
        const c = spec.evaluate(
          candidate.report.fit as never,
          candidate.report.calibration as never,
          request as never,
          candidate.report.summary.modelRisk.calibratedRange,
        );
        unit = b.unit;
        // Forecasting families answer a path; compare the last point (the requested horizon).
        const bv = family === 'garch' ? [b.values[b.values.length - 1] ?? null] : b.values;
        const cv = family === 'garch' ? [c.values[c.values.length - 1] ?? null] : c.values;
        const coordinates =
          family === 'garch' ? [b.coordinates[b.coordinates.length - 1] ?? {}] : b.coordinates;
        bv.forEach((value, index) => {
          const other = cv[index] ?? null;
          grid.push(coordinates[index] ?? {});
          if (value === null || other === null) nullCount += 1;
          else differences.push(other - value);
        });
      }
      let maximumAbsoluteDifference: number | null = null;
      let rootMeanSquareDifference: number | null = null;
      if (differences.length > 0) {
        maximumAbsoluteDifference = Math.max(
          ...differences.map((difference) => Math.abs(difference)),
        );
        rootMeanSquareDifference = Math.sqrt(
          differences.reduce((sum, difference) => sum + difference * difference, 0) /
            differences.length,
        );
      }
      evaluation = {
        grid,
        unit,
        comparedCount: differences.length,
        nullCount,
        maximumAbsoluteDifference,
        rootMeanSquareDifference,
        placement: placement.placement,
      };
    }
  }
  let withinTolerance: boolean | null = null;
  if (tolerance !== null) {
    withinTolerance =
      parameters.every(
        (delta) =>
          delta.absoluteDelta !== null &&
          typeof delta.baselineValue === 'number' &&
          Math.abs(delta.absoluteDelta) <=
            tolerance.absolute + tolerance.relative * Math.abs(delta.baselineValue),
      ) &&
      (evaluation === null ||
        evaluation.maximumAbsoluteDifference === null ||
        evaluation.maximumAbsoluteDifference <= tolerance.absolute);
  }
  return deepFreeze({
    family,
    artifactIds: { baseline: baseline.artifactId, candidate: candidate.artifactId },
    sameMarket,
    sameCalibrationInput:
      baseline.report.summary.inputIdentity.calibrationHash ===
      candidate.report.summary.inputIdentity.calibrationHash,
    parameters,
    objective: {
      kind: bo.kind,
      unit: bo.unit,
      baselineValue: bo.value,
      candidateValue: co.value,
      absoluteDelta: bo.value !== null && co.value !== null ? co.value - bo.value : null,
    },
    convergence: {
      baseline: baseline.report.summary.convergence.converged,
      candidate: candidate.report.summary.convergence.converged,
    },
    residuals: {
      baselineRootMeanSquare: br,
      candidateRootMeanSquare: cr,
      absoluteDelta: br !== null && cr !== null ? cr - br : null,
    },
    modelRisk: { baselineArbitrageFree: ba, candidateArbitrageFree: ca, changed: ba !== ca },
    fit: {
      differenceCount: fitDiff.differenceCount,
      retainedDifferences: fitDiff.differences.length,
      addedPaths: fitDiff.addedPaths,
      removedPaths: fitDiff.removedPaths,
      truncated: fitDiff.truncated,
    },
    evaluation,
    withinTolerance,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      family,
      tolerance,
      limits: { maximumDifferences, maximumLeaves, gridPoints },
      evaluationReason,
    },
    diagnostics: { warnings },
  });
}

/** The warm-start option a saved fit fills for the next calibration (Decision 8). */
export function warmStartFrom<F extends VolatilityModelFamily>(input: {
  model: VolatilityFittedModelReport<F> | AnalysisArtifact;
}): WarmStartOf<F> {
  const functionName = 'warmStartFrom';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['model']);
  const { report } = resolveModel(functionName, input.model);
  const spec = specOf(report.family);
  if (spec.warmStart === null) {
    fail(
      functionName,
      `the '${report.family}' family has no starting point to warm-start — ${spec.descriptor.costClass === 'closed-form' ? 'an exact or closed-form fit has no search' : 'its calibrator takes no initial parameters'}.`,
      ErrorCode.ArtifactOperationUnsupported,
      { family: report.family },
    );
  }
  return deepFreeze(detach(spec.warmStart(report.fit as never))) as WarmStartOf<F>;
}

function clampToDomain(
  value: number,
  domain: 'correlation' | 'positive' | 'unit' | 'free',
): number {
  switch (domain) {
    case 'correlation':
      return Math.max(-0.999, Math.min(0.999, value));
    case 'positive':
      return Math.max(1e-12, value);
    case 'unit':
      return Math.max(1e-6, Math.min(1 - 1e-6, value));
    case 'free':
      return value;
  }
}

/**
 * Re-run the direct calibrator from seeded, deterministic perturbations of the base fit's free
 * start members and report the parameter spread (Decision 8).
 */
export function fittedModelStability<F extends VolatilityModelFamily>(
  input: FittedModelStabilityInput<F>,
): FittedModelStabilityReport<F> {
  const functionName = 'fittedModelStability';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, [
    'family',
    'calibration',
    'restarts',
    'perturbation',
    'seed',
    'tolerance',
  ]);
  const family = requireFamily(functionName, input.family) as F;
  const spec = specOf(family);
  if (spec.freeStart === null) {
    fail(
      functionName,
      `the '${family}' family has no free start members to perturb — stability is measured for the warm-startable families only (${VOLATILITY_MODEL_FAMILIES.filter((name) => FAMILY_SPECS[name].freeStart !== null).join(', ')}).`,
      ErrorCode.ArtifactOperationUnsupported,
      { family },
    );
  }
  const restarts = requireLimit(
    functionName,
    'restarts',
    input.restarts,
    FITTED_MODEL_LIMITS.restarts,
  );
  requireArgumentObject(functionName, 'perturbation', input.perturbation);
  ensureKnownKeys(functionName, 'perturbation', input.perturbation, ['relative']);
  const relative = input.perturbation.relative;
  if (typeof relative !== 'number' || !(relative > 0 && relative < 1)) {
    fail(
      functionName,
      `perturbation.relative must be a fraction in (0, 1) — each free start member is jittered by ×(1 + relative·u), u ∈ [−1, 1). Received ${String(relative)}.`,
      ErrorCode.InputOutOfRange,
      { field: 'perturbation.relative' },
    );
  }
  if (typeof input.seed !== 'number' || !Number.isSafeInteger(input.seed)) {
    fail(
      functionName,
      `seed is REQUIRED and must be a safe integer — a stability run is stochastic and must be reproducible (lovability rule 8).`,
      ErrorCode.InputOutOfRange,
      { field: 'seed' },
    );
  }
  const tolerance = requireTolerance(functionName, input.tolerance);
  requireArgumentObject(functionName, 'calibration', input.calibration);
  scanCanonicalData(input.calibration, {
    functionName,
    label: 'calibration',
    maximumWorkUnits: FITTED_MODEL_LIMITS.maximumEmbeddedBytes.maximum,
    requireFiniteNumbers: true,
  });
  const calibration = detach(input.calibration) as CalibrationOf<F>;
  const baseFit = spec.calibrate(calibration);
  const baseVector = spec.freeStart.read(baseFit);
  const baseProjection = spec.project(baseFit, calibration);
  const baseParameters = flattenParameters(
    summaryOf(functionName, spec, baseProjection, calibration, baseFit),
  );
  const generator = mulberry32(input.seed);
  const samples = new Map<string, number[]>();
  const objectives: number[] = [];
  let convergedCount = 0;
  const warnings: QuantWarning[] = [];
  for (let restart = 0; restart < restarts; restart++) {
    const vector = baseVector.map((value, index) =>
      clampToDomain(
        value * (1 + relative * (2 * generator.next() - 1)),
        spec.freeStart!.domains[index] ?? 'free',
      ),
    );
    const perturbed = spec.freeStart.apply(calibration, vector);
    const fit = spec.calibrate(perturbed);
    const projection = spec.project(fit, perturbed);
    if (projection.convergence.converged) convergedCount += 1;
    if (projection.objective.value !== null) objectives.push(projection.objective.value);
    for (const [key, value] of flattenParameters(
      summaryOf(functionName, spec, projection, perturbed, fit),
    )) {
      if (typeof value !== 'number') continue;
      const list = samples.get(key) ?? [];
      list.push(value);
      samples.set(key, list);
    }
  }
  const parameters: FittedModelStabilityReport['parameters'] = {};
  let stable: boolean | null = tolerance === null ? null : true;
  for (const [key, values] of [...samples.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const base = baseParameters.get(key);
    if (typeof base !== 'number') continue;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    parameters[key] = { baseline: base, minimum, maximum, standardDeviation: Math.sqrt(variance) };
    if (
      tolerance !== null &&
      maximum - minimum > tolerance.absolute + tolerance.relative * Math.abs(base)
    )
      stable = false;
  }
  if (convergedCount < restarts) {
    warnings.push(
      warning(
        WarningCode.VolatilityCalibrationNotConverged,
        `${functionName}: ${restarts - convergedCount} of ${restarts} perturbed restarts did not converge — their parameters are included in the spread; gate on convergedCount before trusting it.`,
        'warn',
        { restarts, convergedCount },
      ),
    );
  }
  return deepFreeze({
    family,
    restarts,
    parameters,
    objective: {
      unit: baseProjection.objective.unit,
      baseline: baseProjection.objective.value,
      minimum: objectives.length > 0 ? Math.min(...objectives) : null,
      maximum: objectives.length > 0 ? Math.max(...objectives) : null,
    },
    convergedCount,
    stable,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      family,
      modelVersion: spec.descriptor.modelVersion,
      seed: input.seed,
      generator: 'mulberry32' as const,
      perturbation: { relative },
      members: [...spec.freeStart.members],
      tolerance,
    },
    diagnostics: { warnings },
  });
}

/**
 * Fit on the retained points through the direct calibrator, evaluate the direct evaluator on the
 * held-out points, and report in-sample and out-of-sample residuals (Decision 8).
 */
export function fittedModelHoldout<F extends VolatilityModelFamily>(
  input: FittedModelHoldoutInput<F>,
): FittedModelHoldoutReport<F> {
  const functionName = 'fittedModelHoldout';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['family', 'calibration', 'holdout']);
  const family = requireFamily(functionName, input.family) as F;
  const spec = specOf(family);
  if (spec.points === null && spec.timeSeries === null) {
    fail(
      functionName,
      `the '${family}' family has no holdout evaluation — ${family === 'garch' ? 'the direct fit exposes no conditional-variance path, so an out-of-sample forecast residual would need a second recursion' : family === 'event-move' ? 'a historical statistic has nothing to evaluate out of sample' : 'an exact pillar construction reprices its pillars by definition'}.`,
      ErrorCode.ArtifactOperationUnsupported,
      { family },
    );
  }
  requireArgumentObject(functionName, 'holdout', input.holdout);
  const holdout = input.holdout as Record<string, unknown>;
  requireArgumentObject(functionName, 'calibration', input.calibration);
  scanCanonicalData(input.calibration, {
    functionName,
    label: 'calibration',
    maximumWorkUnits: FITTED_MODEL_LIMITS.maximumEmbeddedBytes.maximum,
    requireFiniteNumbers: true,
  });
  const calibration = detach(input.calibration) as CalibrationOf<F>;
  const warnings: QuantWarning[] = [];

  if (spec.timeSeries !== null) {
    ensureKnownKeys(functionName, 'holdout', holdout, ['lastCount']);
    const count = spec.timeSeries.count(calibration);
    const lastCount = requireLimit(functionName, 'holdout.lastCount', holdout['lastCount'], {
      maximum: FITTED_MODEL_LIMITS.holdoutEvaluations.maximum,
    });
    if (lastCount >= count)
      fail(
        functionName,
        `holdout.lastCount (${lastCount}) must leave at least one observation to fit on (the series has ${count}).`,
        ErrorCode.InputOutOfRange,
        { field: 'holdout.lastCount', count },
      );
    const retained = spec.timeSeries.prefix(calibration, count - lastCount);
    const fit = spec.calibrate(retained);
    const projection = spec.project(fit, retained);
    const outOfSample = spec.timeSeries.forecastResiduals(fit, calibration, count - lastCount);
    const summary = summaryOf(functionName, spec, projection, retained, fit);
    return deepFreeze({
      family,
      retainedCount: count - lastCount,
      heldOutCount: lastCount,
      inSample: {
        count: projection.residuals?.count ?? 0,
        rootMeanSquare: projection.residuals?.rootMeanSquare ?? null,
        maximumAbsolute: projection.residuals?.maximumAbsolute ?? null,
      },
      outOfSample: residualStatistics(outOfSample),
      unit: spec.timeSeries.unit,
      retainedFit: summary,
      assumptions: {
        conventionsVersion: CONVENTIONS_VERSION,
        family,
        modelVersion: spec.descriptor.modelVersion,
        holdout: { lastCount },
        residualSource: 'direct-evaluator' as const,
        partition: 'time-series prefix' as const,
      },
      diagnostics: { warnings },
    });
  }

  const points = spec.points!;
  const count = points.count(calibration);
  const keep: boolean[] = new Array<boolean>(count).fill(true);
  let selection: FittedModelHoldoutSelection;
  if (Object.prototype.hasOwnProperty.call(holdout, 'indices')) {
    ensureKnownKeys(functionName, 'holdout', holdout, ['indices']);
    requireArgumentArray(functionName, 'holdout.indices', holdout['indices']);
    const indices = holdout['indices'] as unknown[];
    if (indices.length > FITTED_MODEL_LIMITS.holdoutEvaluations.maximum)
      fail(
        functionName,
        `holdout.indices lists ${indices.length} points, above the hard maximum ${FITTED_MODEL_LIMITS.holdoutEvaluations.maximum}.`,
        ErrorCode.InputOutOfRange,
        { field: 'holdout.indices' },
      );
    for (const index of indices) {
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= count)
        fail(
          functionName,
          `holdout.indices must name calibration points in [0, ${count}). Received ${String(index)}.`,
          ErrorCode.InputOutOfRange,
          { field: 'holdout.indices', count },
        );
      keep[index as number] = false;
    }
    selection = { indices: [...new Set(indices as number[])].sort((a, b) => a - b) };
  } else if (Object.prototype.hasOwnProperty.call(holdout, 'everyNth')) {
    ensureKnownKeys(functionName, 'holdout', holdout, ['everyNth', 'offset']);
    const everyNth = requireLimit(
      functionName,
      'holdout.everyNth',
      holdout['everyNth'],
      { maximum: FITTED_MODEL_LIMITS.holdoutEvaluations.maximum },
      2,
    );
    const offset = requireLimit(
      functionName,
      'holdout.offset',
      holdout['offset'],
      { maximum: FITTED_MODEL_LIMITS.holdoutEvaluations.maximum },
      0,
    );
    if (offset >= everyNth)
      fail(
        functionName,
        `holdout.offset (${offset}) must be below holdout.everyNth (${everyNth}).`,
        ErrorCode.InputOutOfRange,
        { field: 'holdout.offset' },
      );
    for (let index = offset; index < count; index += everyNth) keep[index] = false;
    selection = { everyNth, offset };
  } else {
    fail(
      functionName,
      `holdout must be { indices }, { everyNth, offset }, or (time-series families) { lastCount } — a deterministic split, never a random one without an explicit seed and never a default.`,
      ErrorCode.InputMissingField,
      { field: 'holdout' },
    );
  }
  const heldOut = keep.map((kept, index) => (kept ? -1 : index)).filter((index) => index >= 0);
  const retainedCount = count - heldOut.length;
  if (heldOut.length === 0)
    fail(functionName, 'the holdout selection holds out no points.', ErrorCode.InputOutOfRange, {
      field: 'holdout',
    });
  if (retainedCount === 0)
    fail(
      functionName,
      'the holdout selection retains no points to fit on.',
      ErrorCode.InputOutOfRange,
      { field: 'holdout' },
    );
  const retained = points.subset(calibration, keep);
  const fit = spec.calibrate(retained);
  const projection = spec.project(fit, retained);
  const outOfSample = points.residuals(fit, calibration, heldOut);
  if (outOfSample.length < heldOut.length) {
    warnings.push(
      warning(
        WarningCode.VolatilityCalibrationNotConverged,
        `${functionName}: ${heldOut.length - outOfSample.length} held-out point${heldOut.length - outOfSample.length === 1 ? '' : 's'} could not be evaluated (the direct evaluator answered null there) and are excluded from the out-of-sample statistics.`,
        'warn',
        { heldOut: heldOut.length, evaluated: outOfSample.length },
      ),
    );
  }
  const summary = summaryOf(functionName, spec, projection, retained, fit);
  return deepFreeze({
    family,
    retainedCount,
    heldOutCount: heldOut.length,
    inSample: {
      count: projection.residuals?.count ?? 0,
      rootMeanSquare: projection.residuals?.rootMeanSquare ?? null,
      maximumAbsolute: projection.residuals?.maximumAbsolute ?? null,
    },
    outOfSample: residualStatistics(outOfSample),
    unit: points.unit,
    retainedFit: summary,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      family,
      modelVersion: spec.descriptor.modelVersion,
      holdout: selection,
      residualSource: 'direct-evaluator' as const,
      partition: 'cross-sectional points' as const,
    },
    diagnostics: { warnings },
  });
}

function summaryOf<F extends VolatilityModelFamily>(
  functionName: string,
  spec: FamilySpec<F>,
  projection: ReturnType<FamilySpec<F>['project']>,
  calibration: CalibrationOf<F>,
  fit: FitOf<F>,
): FittedModelSummary {
  const fitWarnings = (fit as { diagnostics?: { warnings?: unknown[] } }).diagnostics?.warnings;
  const summary: FittedModelSummary = {
    family: spec.descriptor.qualifiedFamily,
    modelVersion: spec.descriptor.modelVersion,
    parameters: projection.parameters,
    objective: projection.objective,
    convergence: projection.convergence,
    residuals: projection.residuals,
    modelRisk: projection.modelRisk,
    weighting: projection.weighting,
    inputIdentity: { calibrationHash: contentHash(calibration), snapshotHash: null },
    warningCount: Array.isArray(fitWarnings) ? fitWarnings.length : 0,
  };
  return requireFittedModelSummary(functionName, 'retainedFit', detach(summary));
}
