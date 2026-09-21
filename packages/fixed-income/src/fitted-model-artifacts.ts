/**
 * `@totalfinance/fixed-income/artifacts` — the six verbs of Stage 4.5 Decision 3 that an exact
 * bootstrap can honour, over the four curve families (Decision 2), riding the Gate B spine and
 * the shared fitted-model kit in core: `fittedModelArtifact`, `readFittedModel`,
 * `evaluateFittedModel`, `replayFittedModel`, `compareFittedModels`, `fittedModelHoldout`.
 *
 * A bootstrap is exact by construction, so the family has no search to warm-start or perturb:
 * this subpath exports no `warmStartFrom` and no `fittedModelStability` (a verb that refuses
 * every input is a dead door, not shape parity — the descriptor's `warmStart: false` discloses
 * the absence with its reason), and `fittedModelHoldout` is the family's residual diagnostic — a
 * refit on the retained instruments and the repricing residuals of the held-out ones through the
 * package's public valuation.
 *
 * Curves are stored as their data (`YieldCurveData` / `SurvivalCurveData`) and restored EXACTLY
 * (`curve-data.ts`); a restored discount curve drops into `MarketSnapshot.observations.curves`
 * through `rateCurveFromYieldCurve` — Program 5's "used in a book/scenario calculation".
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
import {
  requireBuiltSurvivalCurve,
  requireBuiltYieldCurve,
  requireSurvivalCurveData,
  requireYieldCurveData,
  yieldCurveDataOf,
  yieldCurveFromData,
} from './curve-data.js';
import {
  CURVE_MODEL_FAMILIES,
  FAMILY_SPECS,
  type CalibrationOf,
  type CurveModelFamily,
  type EvaluationOf,
  type FamilySpec,
  type FitOf,
  type LiveFitOf,
  type StoredCalibrationOf,
} from './fitted-model-families.js';

export const FIXED_INCOME_FITTED_MODEL_ARTIFACT_TYPE = 'fixed-income.fitted-model';

export interface FittedModelArtifactLimits {
  maximumEmbeddedBytes?: number;
  embeddedRowLimit?: number;
}

/** The typed report every curve verb reads and writes — the artifact's `result`, verbatim. */
export type CurveFittedModelReport<F extends CurveModelFamily = CurveModelFamily> = Readonly<
  Record<string, unknown>
> & {
  family: F;
  modelVersion: number;
  summary: FittedModelSummary;
  /** The bootstrap's result as its own data (restored exactly by the public constructors). */
  fit: FitOf<F>;
  /** The bootstrap's input, verbatim, with live curves as their data and referenced row sets as handles. */
  calibration: StoredCalibrationOf<F>;
  referencedData: Record<string, TableHandle>;
  assumptions: {
    conventionsVersion: string;
    family: F;
    modelVersion: number;
    calibrator: string;
    evaluator: string | null;
    inputPolicy: 'embedded' | 'referenced';
    /** The curve's currency — a stored curve without a unit is a number without one. */
    currency: string;
    projection: string;
  };
  diagnostics: {
    warnings: QuantWarning[];
    fitWarningCount: number;
    embeddedCalibrationBytes: number;
    referencedRowSets: string[];
  };
};

export interface FittedModelArtifactInput<F extends CurveModelFamily> {
  family: F;
  /** The live result the bootstrap returned (a YieldCurve, a MultiCurve, a SurvivalCurve). */
  fit: LiveFitOf<F>;
  /** The bootstrap's input with its rows and live curves — the adapter stores curve data and mints handles. */
  calibration: CalibrationOf<F>;
  currency: string;
  referenceRowSets?: readonly string[];
  locators?: Record<string, string>;
  snapshotHash?: string;
  libraryVersion?: string;
  createdFrom?: string[];
  provenance?: Provenance;
  limits?: FittedModelArtifactLimits;
}

export interface ReadFittedModelResult<F extends CurveModelFamily = CurveModelFamily> {
  report: CurveFittedModelReport<F>;
  artifact: AnalysisArtifact;
  migrationsApplied: AppliedMigration[];
  modelMigrationsApplied: AppliedMigration[];
}

export interface FittedModelEvaluation<F extends CurveModelFamily = CurveModelFamily> {
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
    currency: string;
    evaluator: string;
    options: Record<string, unknown>;
    extrapolation: string;
  };
  diagnostics: { warnings: QuantWarning[]; outsideCalibratedRange: number };
}

export interface FittedModelReplay<F extends CurveModelFamily = CurveModelFamily> {
  family: F;
  artifactId: string;
  recomputed: CurveFittedModelReport<F>;
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

export interface CurveEvaluationDifference {
  measure: string;
  unit: string;
  grid: Array<Record<string, number | string>>;
  comparedCount: number;
  nullCount: number;
  maximumAbsoluteDifference: number | null;
  rootMeanSquareDifference: number | null;
  placement: string;
}

export interface FittedModelComparison<F extends CurveModelFamily = CurveModelFamily> {
  family: F;
  artifactIds: { baseline: string | null; candidate: string | null };
  sameMarket: boolean | null;
  sameCalibrationInput: boolean;
  sameCurrency: boolean;
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
  fit: {
    differenceCount: number;
    retainedDifferences: number;
    addedPaths: string[];
    removedPaths: string[];
    truncated: boolean;
  };
  /** One section per measure on the union of both fits' pillar dates (Decision 6's curve rule). */
  evaluation: CurveEvaluationDifference[];
  withinTolerance: boolean | null;
  assumptions: {
    conventionsVersion: string;
    family: F;
    tolerance: ComparisonTolerance | null;
    limits: { maximumDifferences: number; maximumLeaves: number };
  };
  diagnostics: { warnings: QuantWarning[] };
}

export type FittedModelHoldoutSelection =
  | { indices: number[] }
  | { everyNth: number; offset: number };

export interface FittedModelHoldoutInput<F extends CurveModelFamily> {
  family: F;
  calibration: CalibrationOf<F>;
  holdout: FittedModelHoldoutSelection;
}

export interface FittedModelHoldoutReport<F extends CurveModelFamily = CurveModelFamily> {
  family: F;
  retainedCount: number;
  heldOutCount: number;
  inSample: { count: number; rootMeanSquare: number | null; maximumAbsolute: number | null };
  outOfSample: { count: number; rootMeanSquare: number | null; maximumAbsolute: number | null };
  /** Per held-out instrument: its index and its repricing residual (curve-implied − quoted). */
  heldOut: Array<{ index: number; residual: number }>;
  unit: string;
  retainedFit: FittedModelSummary;
  assumptions: {
    conventionsVersion: string;
    family: F;
    modelVersion: number;
    holdout: FittedModelHoldoutSelection;
    instruments: string;
    residualSource: 'direct-evaluator';
    partition: 'cross-sectional instruments';
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
  'currency',
  'projection',
] as const;
const DIAGNOSTIC_KEYS = [
  'warnings',
  'fitWarningCount',
  'embeddedCalibrationBytes',
  'referencedRowSets',
] as const;
const PROJECTION =
  'summary = pure projection of the curve data (pillar vectors as dot-path parameters); objective exact-bootstrap; residuals = repricing residuals of every calibration instrument through the public valuation (direct-evaluator)';

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

function requireFamily(functionName: string, value: unknown): CurveModelFamily {
  if (typeof value !== 'string' || !(CURVE_MODEL_FAMILIES as readonly string[]).includes(value)) {
    fail(
      functionName,
      `family must be one of ${CURVE_MODEL_FAMILIES.join(', ')}. Received ${typeof value === 'string' ? JSON.stringify(value) : value === null ? 'null' : typeof value}.`,
      ErrorCode.InputInvalidEnum,
      { field: 'family' },
    );
  }
  return value as CurveModelFamily;
}

function specOf<F extends CurveModelFamily>(family: F): FamilySpec<F> {
  return FAMILY_SPECS[family] as unknown as FamilySpec<F>;
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

function requireCurrency(functionName: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(
      functionName,
      `currency must be the curve's currency code (e.g. 'USD') — a stored curve without a currency is a number without a unit.`,
      ErrorCode.InputWrongType,
      { field: 'currency' },
    );
  }
  return value;
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
        `the embedded ${label} exceeds the embedded-input budget (${maximumEmbeddedBytes.toLocaleString()} work units ≈ canonical bytes) — reference the bulk row set (referenceRowSets) or raise limits.maximumEmbeddedBytes up to ${ARTIFACT_WORK_LIMITS.maximumEmbeddedBytes.maximum.toLocaleString()}.`,
        ErrorCode.ArtifactEmbeddedInputTooLarge,
        { field: label, maximumEmbeddedBytes },
      );
    }
    throw error;
  }
}

/** Replace live curves in a calibration by their data (validated as built curves first). */
function storedCalibrationOf<F extends CurveModelFamily>(
  functionName: string,
  spec: FamilySpec<F>,
  calibration: Record<string, unknown>,
): Record<string, unknown> {
  let stored = calibration;
  for (const path of spec.liveCurves) {
    const label = `calibration.${path.join('.')}`;
    const live = readPath(stored, path);
    const curve = requireBuiltYieldCurve(functionName, label, live);
    stored = withPath(stored, path, yieldCurveDataOf(curve));
  }
  return stored;
}

/** Rebuild the live calibration (curves restored exactly, referenced rows substituted) from a report. */
function liveCalibrationOf(
  functionName: string,
  report: CurveFittedModelReport,
  referencedData: Record<string, unknown[]> | undefined,
): CalibrationOf<CurveModelFamily> {
  const spec = specOf(report.family);
  let calibration = report.calibration as unknown as Record<string, unknown>;
  for (const path of spec.rowSets) {
    const label = path.join('.');
    if (!report.diagnostics.referencedRowSets.includes(label)) continue;
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
      path,
      detach(verifyReferencedRows({ functionName, label, handle, rows })),
    );
  }
  for (const path of spec.liveCurves) {
    const label = `calibration.${path.join('.')}`;
    const data = requireYieldCurveData(functionName, label, readPath(calibration, path));
    calibration = withPath(calibration, path, yieldCurveFromData(functionName, label, data));
  }
  return calibration as unknown as CalibrationOf<CurveModelFamily>;
}

function liveFitOf<F extends CurveModelFamily>(
  functionName: string,
  report: CurveFittedModelReport<F>,
): LiveFitOf<F> {
  return specOf(report.family).fitFromData(functionName, report.fit);
}

function buildReport<F extends CurveModelFamily>(
  functionName: string,
  family: F,
  liveFit: LiveFitOf<F>,
  calibration: CalibrationOf<F>,
  stored: StoredCalibrationOf<F>,
  referencedData: Record<string, TableHandle>,
  snapshotHash: string | null,
  currency: string,
  embeddedCalibrationBytes: number,
): CurveFittedModelReport<F> {
  const spec = specOf(family);
  const data = spec.fitDataOf(liveFit);
  const projection = spec.project(liveFit, data, calibration);
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
    warningCount: 0,
  };
  requireFittedModelSummary(functionName, 'summary', summary);
  const referencedRowSets = Object.keys(referencedData).sort();
  return {
    family,
    modelVersion: spec.descriptor.modelVersion,
    summary,
    fit: data,
    calibration: stored,
    referencedData,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      family,
      modelVersion: spec.descriptor.modelVersion,
      calibrator: spec.descriptor.calibrator,
      evaluator: spec.descriptor.evaluator,
      inputPolicy: referencedRowSets.length > 0 ? ('referenced' as const) : ('embedded' as const),
      currency,
      projection: PROJECTION,
    },
    diagnostics: {
      warnings: [] as QuantWarning[],
      fitWarningCount: 0,
      embeddedCalibrationBytes,
      referencedRowSets,
    },
  } as unknown as CurveFittedModelReport<F>;
}

function requireReport(functionName: string, value: unknown): CurveFittedModelReport {
  requireArgumentObject(functionName, 'artifact.result', value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, 'artifact.result', record, REPORT_KEYS);
  for (const key of REPORT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key))
      fail(
        functionName,
        `artifact.result.${key} is missing — this is not a fixed-income fitted-model report.`,
        ErrorCode.InputMissingField,
        { field: `artifact.result.${key}` },
      );
  }
  const family = requireFamily(functionName, record['family']);
  requireFittedModelSummary(functionName, 'artifact.result.summary', record['summary']);
  if (family === 'multi-curve') {
    requireArgumentObject(functionName, 'artifact.result.fit', record['fit']);
    ensureKnownKeys(functionName, 'artifact.result.fit', record['fit'] as object, [
      'discountCurve',
      'forecastCurve',
    ]);
    requireYieldCurveData(
      functionName,
      'artifact.result.fit.discountCurve',
      (record['fit'] as Record<string, unknown>)['discountCurve'],
    );
    requireYieldCurveData(
      functionName,
      'artifact.result.fit.forecastCurve',
      (record['fit'] as Record<string, unknown>)['forecastCurve'],
    );
  } else if (family === 'hazard-curve')
    requireSurvivalCurveData(functionName, 'artifact.result.fit', record['fit']);
  else requireYieldCurveData(functionName, 'artifact.result.fit', record['fit']);
  requireArgumentObject(functionName, 'artifact.result.calibration', record['calibration']);
  requireArgumentObject(functionName, 'artifact.result.referencedData', record['referencedData']);
  for (const [name, handle] of Object.entries(
    record['referencedData'] as Record<string, unknown>,
  )) {
    if (!isTableHandle(handle))
      fail(
        functionName,
        `artifact.result.referencedData.${name} is not a table handle.`,
        ErrorCode.InputWrongType,
        { field: `artifact.result.referencedData.${name}` },
      );
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
  if (a['family'] !== family)
    fail(
      functionName,
      `artifact.result.assumptions.family (${JSON.stringify(a['family'])}) does not name the report's family '${family}'.`,
      ErrorCode.InputWrongShape,
      { field: 'artifact.result.assumptions.family' },
    );
  if (a['inputPolicy'] !== 'embedded' && a['inputPolicy'] !== 'referenced')
    fail(
      functionName,
      `artifact.result.assumptions.inputPolicy must be 'embedded' or 'referenced'.`,
      ErrorCode.InputInvalidEnum,
      { field: 'artifact.result.assumptions.inputPolicy' },
    );
  requireCurrency(functionName, a['currency']);
  const diagnostics = record['diagnostics'];
  requireArgumentObject(functionName, 'artifact.result.diagnostics', diagnostics);
  ensureKnownKeys(
    functionName,
    'artifact.result.diagnostics',
    diagnostics as object,
    DIAGNOSTIC_KEYS,
  );
  if (!Array.isArray((diagnostics as Record<string, unknown>)['warnings']))
    fail(
      functionName,
      `artifact.result.diagnostics.warnings must be an array.`,
      ErrorCode.InputWrongType,
      { field: 'artifact.result.diagnostics.warnings' },
    );
  return record as unknown as CurveFittedModelReport;
}

function resolveModel(
  functionName: string,
  model: unknown,
  field = 'model',
): { report: CurveFittedModelReport; artifactId: string | null } {
  if (isArtifact(model)) {
    const read = readFittedModel({ artifact: model });
    return { report: read.report, artifactId: read.artifact.id };
  }
  requireArgumentObject(functionName, field, model);
  return { report: requireReport(functionName, model), artifactId: null };
}

// ──────────────────────────────────────────── the verbs ─────────────────────────────────────────────

/**
 * Describe a bootstrap's result and save it as an identified, immutable artifact.
 *
 * @example
 * ```ts
 * const curve = curves.bootstrap(instruments, { referenceDate: '2026-01-01' });
 * const artifact = fittedModelArtifact({
 *   family: 'discount-curve',
 *   fit: curve,
 *   calibration: { instruments, options: { referenceDate: '2026-01-01' } },
 *   currency: 'USD',
 * });
 * ```
 */
export function fittedModelArtifact<F extends CurveModelFamily>(
  input: FittedModelArtifactInput<F>,
): AnalysisArtifact {
  const functionName = 'fittedModelArtifact';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, [
    'family',
    'fit',
    'calibration',
    'currency',
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
  const currency = requireCurrency(functionName, input.currency);
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
    law: ARTIFACT_WORK_LIMITS.maximumEmbeddedBytes,
  });
  const embeddedRowLimit = requireWorkLimit({
    functionName,
    field: 'limits.embeddedRowLimit',
    value: input.limits?.embeddedRowLimit,
    law: ARTIFACT_WORK_LIMITS.embeddedRowLimit,
  });
  const snapshotHash = requireSnapshotHash(functionName, input.snapshotHash);
  if (
    input.libraryVersion !== undefined &&
    (typeof input.libraryVersion !== 'string' || input.libraryVersion.length === 0)
  )
    fail(
      functionName,
      'libraryVersion must be a non-empty version string when present.',
      ErrorCode.InputWrongType,
      { field: 'libraryVersion' },
    );
  // The live fit: proven complete, then reduced to its data.
  const liveFit = (
    family === 'multi-curve'
      ? (() => {
          requireArgumentObject(functionName, 'fit', input.fit);
          ensureKnownKeys(functionName, 'fit', input.fit as object, [
            'discountCurve',
            'forecastCurve',
          ]);
          return {
            discountCurve: requireBuiltYieldCurve(
              functionName,
              'fit.discountCurve',
              (input.fit as unknown as Record<string, unknown>)['discountCurve'],
            ),
            forecastCurve: requireBuiltYieldCurve(
              functionName,
              'fit.forecastCurve',
              (input.fit as unknown as Record<string, unknown>)['forecastCurve'],
            ),
          };
        })()
      : family === 'hazard-curve'
        ? requireBuiltSurvivalCurve(functionName, 'fit', input.fit)
        : requireBuiltYieldCurve(functionName, 'fit', input.fit)
  ) as LiveFitOf<F>;
  // The calibration: live curves → data, rows → embedded or referenced.
  requireArgumentObject(functionName, 'calibration', input.calibration);
  if (input.referenceRowSets !== undefined)
    requireArgumentArray(functionName, 'referenceRowSets', input.referenceRowSets);
  const referenceRowSets = input.referenceRowSets ?? [];
  const referenceable = spec.descriptor.referenceableRowSets;
  for (const name of referenceRowSets) {
    if (typeof name !== 'string' || !referenceable.includes(name))
      fail(
        functionName,
        `referenceRowSets names ${JSON.stringify(name)}, which the '${family}' family cannot reference — its referenceable row sets are ${referenceable.join(', ')}.`,
        ErrorCode.InputInvalidEnum,
        { field: 'referenceRowSets', family },
      );
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
  const asStored = storedCalibrationOf(
    functionName,
    spec,
    input.calibration as unknown as Record<string, unknown>,
  );
  scanEmbedded(functionName, 'calibration', asStored, maximumEmbeddedBytes, true);
  let stored = detach(asStored);
  const calibration = { ...(input.calibration as object) } as CalibrationOf<F>;
  const referencedData: Record<string, TableHandle> = {};
  for (const path of spec.rowSets) {
    const label = path.join('.');
    const rows = readPath(stored, path);
    if (!Array.isArray(rows))
      fail(
        functionName,
        `calibration.${label} must be the row array the bootstrap consumed. Received ${rows === null ? 'null' : typeof rows}.`,
        ErrorCode.InputWrongType,
        { field: `calibration.${label}` },
      );
    if (referenceRowSets.includes(label)) {
      const handle = tableHandleForRows({
        rows,
        ...(input.locators?.[label] !== undefined ? { locator: input.locators[label] } : {}),
      });
      referencedData[label] = handle;
      stored = withPath(stored, path, handle);
    } else if (rows.length > embeddedRowLimit) {
      fail(
        functionName,
        `calibration.${label} has ${rows.length} rows, above the embedded row limit ${embeddedRowLimit} — nothing is truncated silently. Either reference the row set (referenceRowSets: ['${label}']) or raise limits.embeddedRowLimit up to ${ARTIFACT_WORK_LIMITS.embeddedRowLimit.maximum}.`,
        ErrorCode.ArtifactEmbeddedInputTooLarge,
        { field: `calibration.${label}`, rows: rows.length, embeddedRowLimit },
      );
    }
  }
  const storedBytes = canonicalJsonOf(stored).length;
  if (storedBytes > maximumEmbeddedBytes)
    fail(
      functionName,
      `the embedded calibration is ${storedBytes.toLocaleString()} canonical bytes, above the limit ${maximumEmbeddedBytes.toLocaleString()} — reference the bulk row set (referenceRowSets) or raise limits.maximumEmbeddedBytes up to ${ARTIFACT_WORK_LIMITS.maximumEmbeddedBytes.maximum.toLocaleString()}.`,
      ErrorCode.ArtifactEmbeddedInputTooLarge,
      { field: 'calibration', bytes: storedBytes, maximumEmbeddedBytes },
    );
  const report = buildReport(
    functionName,
    family,
    liveFit,
    calibration,
    stored as unknown as StoredCalibrationOf<F>,
    referencedData,
    snapshotHash,
    currency,
    storedBytes,
  );
  return createAnalysisArtifact({
    artifactType: FIXED_INCOME_FITTED_MODEL_ARTIFACT_TYPE,
    producedBy: {
      operation: spec.descriptor.calibrator,
      ...(input.libraryVersion !== undefined ? { libraryVersion: input.libraryVersion } : {}),
    },
    inputs: {
      ...(snapshotHash !== null ? { snapshotHash } : {}),
      parameters: {
        family,
        modelVersion: spec.descriptor.modelVersion,
        currency,
        calibrationHash: report.summary.inputIdentity.calibrationHash,
      },
    },
    ...(input.createdFrom !== undefined ? { createdFrom: input.createdFrom } : {}),
    result: report,
    ...(Object.keys(referencedData).length > 0 ? { tables: referencedData } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  });
}

/** Restore a curve artifact: Gate B's read door, a foreign-type refusal, the report-level migration policy, report re-validation. */
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
  if (artifact.artifactType !== FIXED_INCOME_FITTED_MODEL_ARTIFACT_TYPE) {
    fail(
      functionName,
      `the artifact's type is '${artifact.artifactType}', not '${FIXED_INCOME_FITTED_MODEL_ARTIFACT_TYPE}' — this reader restores fixed-income curve models only; ${artifact.artifactType.startsWith('volatility.') ? 'use @totalfinance/volatility/artifacts' : artifact.artifactType.startsWith('research.') ? 'use @totalfinance/research/artifacts' : 'read it with the package that owns that type'}.`,
      ErrorCode.ArtifactFamilyMismatch,
      { artifactType: artifact.artifactType },
    );
  }
  const raw = artifact.result as Record<string, unknown>;
  const family = requireFamily(functionName, raw['family']);
  const migrated = applyReportMigrations({
    functionName,
    kind: `${FIXED_INCOME_FITTED_MODEL_ARTIFACT_TYPE}:${family}`,
    report: raw,
    storedVersion: raw['modelVersion'],
    currentVersion: specOf(family).descriptor.modelVersion,
    versionField: 'modelVersion',
    subject: `'${family}' report`,
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

/** Evaluate a restored curve through its own methods, at dates, in one stated measure. */
export function evaluateFittedModel<F extends CurveModelFamily>(input: {
  model: CurveFittedModelReport<F> | AnalysisArtifact;
  at: EvaluationOf<F>;
}): FittedModelEvaluation<F> {
  const functionName = 'evaluateFittedModel';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['model', 'at']);
  const { report } = resolveModel(functionName, input.model);
  const spec = specOf(report.family);
  requireArgumentObject(functionName, 'at', input.at);
  ensureKnownKeys(functionName, 'at', input.at as object, spec.evaluationKeys);
  const live = liveFitOf(functionName, report);
  const answer = spec.evaluate(
    live as never,
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
      currency: report.assumptions.currency,
      evaluator: answer.evaluator,
      options: answer.options,
      extrapolation:
        "dates outside the calibrated pillar range are answered under the curve's stored extrapolation policy (a 'throw' curve refuses on its own), counted in diagnostics.outsideCalibratedRange, and warned — never silent",
    },
    diagnostics: {
      warnings: answer.warnings,
      outsideCalibratedRange: answer.outsideCalibratedRange,
    },
  });
}

/** Re-issue the bootstrap from the stored calibration (curves restored exactly, referenced rows verified) and prove byte parity. */
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
  const calibration = liveCalibrationOf(functionName, report, input.referencedData);
  const recomputedLive = spec.calibrate(calibration as never) as LiveFitOf<CurveModelFamily>;
  const recomputed = buildReport(
    functionName,
    report.family,
    recomputedLive as never,
    calibration as never,
    report.calibration as never,
    { ...report.referencedData },
    report.summary.inputIdentity.snapshotHash,
    report.assumptions.currency,
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
  if (saved !== null && current !== null && saved !== current)
    warnings.push(
      warning(
        WarningCode.ArtifactLibraryVersionDiffers,
        `${functionName}: the artifact was produced by library version ${saved}; this replay runs ${current} — a parity difference may be a library change rather than a data change.`,
        'warn',
        { saved, current },
      ),
    );
  if (!parity.identical)
    warnings.push(
      warning(
        WarningCode.ArtifactLibraryVersionDiffers,
        `${functionName}: replay parity FAILED for '${report.family}' — ${parity.differenceCount} difference${parity.differenceCount === 1 ? '' : 's'} between the saved curve data and the recomputation (first at ${parity.differences[0]?.path ?? parity.addedPaths[0] ?? parity.removedPaths[0] ?? '(unknown)'}). A bootstrap is deterministic given its inputs, so this is a finding.`,
        'warn',
        { differenceCount: parity.differenceCount },
      ),
    );
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

function pillarDates(report: CurveFittedModelReport): string[] {
  const fit = report.fit as unknown as Record<string, unknown>;
  const lists =
    report.family === 'multi-curve'
      ? [
          (fit['discountCurve'] as { pillars: Array<{ date: string }> }).pillars,
          (fit['forecastCurve'] as { pillars: Array<{ date: string }> }).pillars,
        ]
      : [(fit as { pillars: Array<{ date: string }> }).pillars];
  return lists.flatMap((pillars) => pillars.map((pillar) => pillar.date));
}

/** Decision 6's curve rule: the maximum and RMS differences per measure on the union of pillar dates. */
function evaluationDifferences(
  baseline: CurveFittedModelReport,
  candidate: CurveFittedModelReport,
): CurveEvaluationDifference[] {
  const dates = [...new Set([...pillarDates(baseline), ...pillarDates(candidate)])].sort();
  const family = baseline.family;
  const measures: Array<{ at: Record<string, unknown>; measure: string }> =
    family === 'hazard-curve'
      ? [
          { at: { dates, measure: 'survival' }, measure: 'survival' },
          { at: { dates, measure: 'hazard' }, measure: 'hazard' },
        ]
      : family === 'multi-curve'
        ? [
            {
              at: { curve: 'discountCurve', dates, measure: 'discount' },
              measure: 'discountCurve.discount',
            },
            {
              at: { curve: 'discountCurve', dates, measure: 'zeroRate' },
              measure: 'discountCurve.zeroRate',
            },
            {
              at: { curve: 'forecastCurve', dates, measure: 'discount' },
              measure: 'forecastCurve.discount',
            },
            {
              at: { curve: 'forecastCurve', dates, measure: 'zeroRate' },
              measure: 'forecastCurve.zeroRate',
            },
          ]
        : [
            { at: { dates, measure: 'discount' }, measure: 'discount' },
            { at: { dates, measure: 'zeroRate' }, measure: 'zeroRate' },
          ];
  const spec = specOf(family);
  const liveBaseline = liveFitOf('compareFittedModels', baseline);
  const liveCandidate = liveFitOf('compareFittedModels', candidate);
  return measures.map(({ at, measure }) => {
    const b = spec.evaluate(
      liveBaseline as never,
      at as never,
      baseline.summary.modelRisk.calibratedRange,
    );
    const c = spec.evaluate(
      liveCandidate as never,
      at as never,
      candidate.summary.modelRisk.calibratedRange,
    );
    const differences: number[] = [];
    let nullCount = 0;
    b.values.forEach((value, index) => {
      const other = c.values[index] ?? null;
      if (value === null || other === null) nullCount += 1;
      else differences.push(other - value);
    });
    return {
      measure,
      unit: b.unit,
      grid: b.coordinates,
      comparedCount: differences.length,
      nullCount,
      maximumAbsoluteDifference:
        differences.length > 0
          ? Math.max(...differences.map((difference) => Math.abs(difference)))
          : null,
      rootMeanSquareDifference:
        differences.length > 0
          ? Math.sqrt(
              differences.reduce((sum, difference) => sum + difference * difference, 0) /
                differences.length,
            )
          : null,
      placement: `the union of both fits' pillar dates (${dates.length}); each fit answers under its own stored interpolation and extrapolation`,
    };
  });
}

/** Compare two curve fits of one family (Decision 6). */
export function compareFittedModels<F extends CurveModelFamily>(input: {
  baseline: CurveFittedModelReport<F> | AnalysisArtifact;
  candidate: CurveFittedModelReport<F> | AnalysisArtifact;
  tolerance?: ComparisonTolerance;
  limits?: ComparisonLimits;
}): FittedModelComparison<F> {
  const functionName = 'compareFittedModels';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['baseline', 'candidate', 'tolerance', 'limits']);
  const tolerance = requireComparisonTolerance({ functionName, tolerance: input.tolerance });
  if (input.limits !== undefined) {
    requireArgumentObject(functionName, 'limits', input.limits);
    ensureKnownKeys(functionName, 'limits', input.limits, ['maximumDifferences', 'maximumLeaves']);
  }
  const maximumDifferences = requireWorkLimit({
    functionName,
    field: 'limits.maximumDifferences',
    value: input.limits?.maximumDifferences,
    law: ARTIFACT_WORK_LIMITS.maximumDifferences,
  });
  const maximumLeaves = requireWorkLimit({
    functionName,
    field: 'limits.maximumLeaves',
    value: input.limits?.maximumLeaves,
    law: ARTIFACT_WORK_LIMITS.maximumLeaves,
  });
  const baseline = resolveModel(functionName, input.baseline, 'baseline');
  const candidate = resolveModel(functionName, input.candidate, 'candidate');
  if (baseline.report.family !== candidate.report.family)
    fail(
      functionName,
      `the fits belong to different families — baseline is '${baseline.report.family}', candidate is '${candidate.report.family}'. For a structural diff of two artifacts of one type use compareAnalysisArtifacts.`,
      ErrorCode.ArtifactFamilyMismatch,
      { baseline: baseline.report.family, candidate: candidate.report.family },
    );
  const family = baseline.report.family as F;
  const warnings: QuantWarning[] = [];
  const bs = baseline.report.summary.inputIdentity.snapshotHash;
  const cs = candidate.report.summary.inputIdentity.snapshotHash;
  const sameMarket = bs === null || cs === null ? null : bs === cs;
  if (sameMarket === false)
    warnings.push(
      warning(
        WarningCode.ArtifactComparisonDifferentMarket,
        `${functionName}: the two curves were bootstrapped under different market snapshots — still comparable, but the market moved between them.`,
        'warn',
        { baseline: bs, candidate: cs },
      ),
    );
  const sameCurrency =
    baseline.report.assumptions.currency === candidate.report.assumptions.currency;
  if (!sameCurrency)
    warnings.push(
      warning(
        WarningCode.ArtifactComparisonDifferentMarket,
        `${functionName}: the curves are in different currencies (${baseline.report.assumptions.currency} vs ${candidate.report.assumptions.currency}) — their rates are not the same quantity.`,
        'warn',
        {},
      ),
    );
  const bp = flattenSummaryParameters(baseline.report.summary);
  const cp = flattenSummaryParameters(candidate.report.summary);
  const parameters: ParameterDelta[] = [];
  for (const key of [...new Set([...Object.keys(bp), ...Object.keys(cp)])].sort()) {
    const b = bp[key];
    const c = cp[key];
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
    } else if (b !== c)
      parameters.push({
        parameter: key,
        baselineValue: b,
        candidateValue: c,
        absoluteDelta: null,
        relativeDelta: null,
      });
  }
  const bo = baseline.report.summary.objective;
  const co = candidate.report.summary.objective;
  const br = baseline.report.summary.residuals?.rootMeanSquare ?? null;
  const cr = candidate.report.summary.residuals?.rootMeanSquare ?? null;
  const fitDiff = artifactReplayParity({
    saved: baseline.report.fit as unknown as Record<string, unknown>,
    recomputed: candidate.report.fit as unknown as Record<string, unknown>,
    limits: { maximumDifferences, maximumLeaves },
  });
  const evaluation = evaluationDifferences(baseline.report, candidate.report);
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
      evaluation.every(
        (section) =>
          section.maximumAbsoluteDifference === null ||
          section.maximumAbsoluteDifference <= tolerance.absolute,
      );
  }
  return deepFreeze({
    family,
    artifactIds: { baseline: baseline.artifactId, candidate: candidate.artifactId },
    sameMarket,
    sameCalibrationInput:
      baseline.report.summary.inputIdentity.calibrationHash ===
      candidate.report.summary.inputIdentity.calibrationHash,
    sameCurrency,
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
      limits: { maximumDifferences, maximumLeaves },
    },
    diagnostics: { warnings },
  });
}

/**
 * Fit on the retained instruments and reprice the held-out ones with the restored curve through
 * the package's public valuation (Decision 8 — Program 5's residuals for an exact bootstrap).
 */
export function fittedModelHoldout<F extends CurveModelFamily>(
  input: FittedModelHoldoutInput<F>,
): FittedModelHoldoutReport<F> {
  const functionName = 'fittedModelHoldout';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, ['family', 'calibration', 'holdout']);
  const family = requireFamily(functionName, input.family) as F;
  const spec = specOf(family);
  requireArgumentObject(functionName, 'holdout', input.holdout);
  const holdout = input.holdout as Record<string, unknown>;
  // The vocabulary is closed before the shape is chosen, so `{ lastCount }` (the time-series split
  // the volatility families accept) reads as an unknown field here, not as a missing one.
  ensureKnownKeys(functionName, 'holdout', holdout, ['indices', 'everyNth', 'offset']);
  requireArgumentObject(functionName, 'calibration', input.calibration);
  // Live curves inside the calibration are behavior objects: validate them as built curves, scan the rest.
  const asStored = storedCalibrationOf(
    functionName,
    spec,
    input.calibration as unknown as Record<string, unknown>,
  );
  scanEmbedded(
    functionName,
    'calibration',
    asStored,
    ARTIFACT_WORK_LIMITS.maximumEmbeddedBytes.maximum,
    true,
  );
  const calibration = input.calibration;
  const count = spec.points.count(calibration);
  const keep: boolean[] = new Array<boolean>(count).fill(true);
  let selection: FittedModelHoldoutSelection;
  if (Object.prototype.hasOwnProperty.call(holdout, 'indices')) {
    ensureKnownKeys(functionName, 'holdout', holdout, ['indices']);
    requireArgumentArray(functionName, 'holdout.indices', holdout['indices']);
    const indices = holdout['indices'] as unknown[];
    if (indices.length > ARTIFACT_WORK_LIMITS.holdoutEvaluations.maximum)
      fail(
        functionName,
        `holdout.indices lists ${indices.length} instruments, above the hard maximum ${ARTIFACT_WORK_LIMITS.holdoutEvaluations.maximum}.`,
        ErrorCode.InputOutOfRange,
        { field: 'holdout.indices' },
      );
    for (const index of indices) {
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= count)
        fail(
          functionName,
          `holdout.indices must name calibration instruments in [0, ${count}). Received ${String(index)}.`,
          ErrorCode.InputOutOfRange,
          { field: 'holdout.indices', count },
        );
      keep[index as number] = false;
    }
    selection = { indices: [...new Set(indices as number[])].sort((a, b) => a - b) };
  } else if (Object.prototype.hasOwnProperty.call(holdout, 'everyNth')) {
    ensureKnownKeys(functionName, 'holdout', holdout, ['everyNth', 'offset']);
    const everyNth = requireWorkLimit({
      functionName,
      field: 'holdout.everyNth',
      value: holdout['everyNth'],
      law: { maximum: ARTIFACT_WORK_LIMITS.holdoutEvaluations.maximum },
      floor: 2,
    });
    const offset = requireWorkLimit({
      functionName,
      field: 'holdout.offset',
      value: holdout['offset'],
      law: { maximum: ARTIFACT_WORK_LIMITS.holdoutEvaluations.maximum },
      floor: 0,
    });
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
      `holdout must be { indices } or { everyNth, offset } — a deterministic split over the calibration instruments, never a random one and never a default.`,
      ErrorCode.InputMissingField,
      { field: 'holdout' },
    );
  }
  const heldOut = keep.map((kept, index) => (kept ? -1 : index)).filter((index) => index >= 0);
  const retainedCount = count - heldOut.length;
  if (heldOut.length === 0)
    fail(
      functionName,
      'the holdout selection holds out no instruments.',
      ErrorCode.InputOutOfRange,
      { field: 'holdout' },
    );
  if (retainedCount === 0)
    fail(
      functionName,
      'the holdout selection retains no instruments to bootstrap from.',
      ErrorCode.InputOutOfRange,
      { field: 'holdout' },
    );
  const retained = spec.points.subset(calibration, keep);
  const fit = spec.calibrate(retained);
  const data = spec.fitDataOf(fit);
  const projection = spec.project(fit, data, retained);
  const outOfSample = spec.points.residuals(fit, calibration, heldOut);
  const summary: FittedModelSummary = {
    family: spec.descriptor.qualifiedFamily,
    modelVersion: spec.descriptor.modelVersion,
    parameters: projection.parameters,
    objective: projection.objective,
    convergence: projection.convergence,
    residuals: projection.residuals,
    modelRisk: projection.modelRisk,
    weighting: projection.weighting,
    inputIdentity: {
      calibrationHash: contentHash(
        storedCalibrationOf(functionName, spec, retained as unknown as Record<string, unknown>),
      ),
      snapshotHash: null,
    },
    warningCount: 0,
  };
  requireFittedModelSummary(functionName, 'retainedFit', detach(summary));
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
    heldOut: heldOut.map((index, position) => ({ index, residual: outOfSample[position]! })),
    unit: spec.residualUnit,
    retainedFit: detach(summary),
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      family,
      modelVersion: spec.descriptor.modelVersion,
      holdout: selection,
      instruments: spec.points.label,
      residualSource: 'direct-evaluator' as const,
      partition: 'cross-sectional instruments' as const,
    },
    diagnostics: { warnings: [] },
  });
}
