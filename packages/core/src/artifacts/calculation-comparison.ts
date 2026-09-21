/** Financial migration comparison over the existing saved-analysis/replay substrate. */
import { CONVENTIONS_VERSION } from '../assumptions.js';
import { ErrorCode, InputError } from '../errors.js';
import { ensureKnownKeys, requireArgumentObject, ensureFiniteWhenPresent } from '../invariants.js';
import { type QuantWarning, warning, WarningCode } from '../diagnostics.js';
import { type AnalysisArtifact, readAnalysisArtifact } from './analysis-artifact.js';
import {
  artifactReplayParity,
  COMPARISON_LIMITS,
  type ArtifactReplayParity,
  type ComparisonLimits,
  type ComparisonTolerance,
} from './comparison.js';
import { scanCanonicalData } from './canonical-scan.js';
import { deepFreeze } from './deep-freeze.js';
import { compareFiniteNumbers } from './numeric-comparison.js';
import { requireWorkLimit } from './fitted-model-kit.js';

/** Own-property path relative to an artifact's `result`; components avoid ambiguous dotted keys. */
export interface CalculationMetricSelector {
  path: readonly (string | number)[];
  /** Exact caller-declared unit/basis, e.g. `USD/share` or `delta/share`. Never inferred or converted. */
  unit: string;
}

/** The same economic metric mapped explicitly across two (possibly different) result schemas. */
export interface CalculationMetric {
  name: string;
  baseline: CalculationMetricSelector;
  candidate: CalculationMetricSelector;
  /** Both absolute (in the declared unit) and relative (decimal fraction) are required. */
  tolerance: ComparisonTolerance;
}

export interface CompareCalculationArtifactsInput {
  baseline: AnalysisArtifact;
  candidate: AnalysisArtifact;
  /** At least one metric; at most 1,000. No implicit single dollar tolerance applied to Greeks. */
  metrics: readonly CalculationMetric[];
  /** Require identical operation names by default; cross-operation metric comparison is explicit. */
  operationPolicy?: CalculationOperationPolicy;
  /** maximumLeaves also bounds the combined control data (metrics, paths, units, policy and limits). */
  limits?: ComparisonLimits;
}

export type CalculationOperationPolicy = 'require-same' | 'compare-declared-metrics';

/** Preserved source diagnostics: consumed fields are validated; harmless metadata remains intact. */
export interface CalculationSourceDiagnostics {
  warnings: QuantWarning[];
  converged?: boolean;
  [key: string]: unknown;
}

export type CalculationMetricUnavailableReason = 'missing' | 'null' | 'non-numeric' | 'non-finite';

export interface CalculationMetricObservation {
  path: readonly (string | number)[];
  unit: string;
  value: number | null;
  unavailableReason: CalculationMetricUnavailableReason | null;
}

export interface CalculationMetricComparison {
  name: string;
  baseline: CalculationMetricObservation;
  candidate: CalculationMetricObservation;
  tolerance: ComparisonTolerance;
  sameUnit: boolean;
  /** Signed candidate minus baseline; null when units differ, unavailable, or not representable. */
  absoluteDelta: number | null;
  /** Signed change over |baseline|; null at a zero baseline or when unrepresentable/unavailable. */
  relativeDelta: number | null;
  /** Null when either value is unavailable or the declared units differ. */
  withinTolerance: boolean | null;
}

export type CalculationComparisonReason =
  | 'different-inputs'
  | 'unrecorded-inputs'
  | 'different-assumptions'
  | 'unrecorded-assumptions'
  | 'different-conventions'
  | 'different-operations'
  | 'source-failure'
  | 'different-units'
  | 'unavailable-metric'
  | 'metric-outside-tolerance'
  | 'truncated-context';

export type CalculationArtifactComparison = {
  /** Match covers declared metrics under the operation policy and matching inputs/assumptions, not universal equivalence. Source failures always mean insufficient evidence. */
  status: 'match' | 'mismatch' | 'not-comparable' | 'insufficient-evidence';
  reasons: CalculationComparisonReason[];
  artifactIds: { baseline: string; candidate: string };
  metrics: CalculationMetricComparison[];
  /** Numeric agreement alone does not certify matching economics. */
  numericAgreement: boolean | null;
  context: {
    inputs: 'same' | 'different' | 'unrecorded';
    /** Exact comparisons, never tolerance-smoothed. These expose model/day-count/source/etc. paths. */
    parameterComparison: ArtifactReplayParity;
    assumptionComparison: ArtifactReplayParity;
    sameSnapshotHash: boolean | null;
    sameConventionsVersion: boolean;
    sameOperation: boolean;
    operations: { baseline: string; candidate: string };
    sourceDiagnostics: {
      baseline: CalculationSourceDiagnostics;
      candidate: CalculationSourceDiagnostics;
    };
    libraryVersions: { baseline: string | null; candidate: string | null };
  };
  assumptions: {
    conventionsVersion: string;
    scope: string;
    units: string;
    comparison: string;
    operationPolicy: CalculationOperationPolicy;
    limits: {
      maximumMetrics: number;
      maximumPathComponents: number;
      maximumLeaves: number;
      maximumDifferences: number;
    };
  };
  diagnostics: { warnings: QuantWarning[] };
};

const FUNCTION_NAME = 'compareCalculationArtifacts';
const MAXIMUM_METRICS = 1_000;
const MAXIMUM_PATH_COMPONENTS = 64;

function fail(field: string, message: string, code: ErrorCode): never {
  throw new InputError(`${FUNCTION_NAME}: ${field} ${message}`, {
    code,
    context: { function: FUNCTION_NAME, field },
  });
}

function record(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (value === undefined) fail(field, 'is required.', ErrorCode.InputMissingField);
  requireArgumentObject(FUNCTION_NAME, field, value);
  ensureKnownKeys(FUNCTION_NAME, field, value as object, keys);
  return value as Record<string, unknown>;
}

/**
 * Bootstrap only the request and limits without reading accessor-backed fields. The shared
 * canonical scanner then proves and bounds the complete controls before metric parsing/copying.
 * Optional own undefined controls still mean omission; stored metrics must be canonical data.
 */
function controlRecord(
  value: unknown,
  field: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === undefined) fail(field, 'is required.', ErrorCode.InputMissingField);
  requireArgumentObject(FUNCTION_NAME, field, value);
  const object = value as object;
  const prototype: unknown = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null)
    fail(field, 'must be a plain data object.', ErrorCode.InputWrongShape);
  const ownKeys = Reflect.ownKeys(object);
  scanCanonicalData(ownKeys, {
    functionName: FUNCTION_NAME,
    label: `${field} keys`,
    maximumWorkUnits: COMPARISON_LIMITS.maximumLeaves.maximum,
  });
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
      fail(
        `${field}.${String(key)}`,
        'must be an enumerable own data property, not an accessor.',
        ErrorCode.InputWrongShape,
      );
  }
  return record(value, field, keys);
}

function text(value: unknown, field: string): string {
  if (value === undefined) fail(field, 'is required.', ErrorCode.InputMissingField);
  if (typeof value !== 'string') fail(field, 'must be a string.', ErrorCode.InputWrongType);
  if (value.trim().length === 0) fail(field, 'must not be blank.', ErrorCode.InputOutOfRange);
  return value;
}

function finite(value: unknown, field: string): number {
  if (value === undefined) fail(field, 'is required.', ErrorCode.InputMissingField);
  ensureFiniteWhenPresent(value, field, FUNCTION_NAME);
  return value as number;
}

function denseArray(value: unknown, field: string, maximum: number): readonly unknown[] {
  if (value === undefined) fail(field, 'is required.', ErrorCode.InputMissingField);
  if (!Array.isArray(value)) fail(field, 'must be an array.', ErrorCode.InputWrongType);
  if (value.length < 1 || value.length > maximum) {
    fail(field, `must have between 1 and ${maximum} entries.`, ErrorCode.InputOutOfRange);
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index))
      fail(`${field}[${index}]`, 'must not be a hole.', ErrorCode.InputWrongShape);
  }
  return value;
}

function selector(value: unknown, field: string): CalculationMetricSelector {
  const item = record(value, field, ['path', 'unit']);
  const path = denseArray(item['path'], `${field}.path`, MAXIMUM_PATH_COMPONENTS).map(
    (part, index) => {
      const label = `${field}.path[${index}]`;
      if (typeof part === 'string') return text(part, label);
      const number = finite(part, label);
      if (!Number.isSafeInteger(number) || number < 0)
        fail(label, 'must be a non-negative safe integer array index.', ErrorCode.InputOutOfRange);
      return number;
    },
  );
  return { path, unit: text(item['unit'], `${field}.unit`) };
}

function metrics(value: unknown): CalculationMetric[] {
  const names = new Set<string>();
  return denseArray(value, 'input.metrics', MAXIMUM_METRICS).map((raw, index) => {
    const field = `input.metrics[${index}]`;
    const item = record(raw, field, ['name', 'baseline', 'candidate', 'tolerance']);
    const name = text(item['name'], `${field}.name`);
    if (names.has(name))
      fail(`${field}.name`, 'duplicates another metric name.', ErrorCode.InputOutOfRange);
    names.add(name);
    const toleranceValue = record(item['tolerance'], `${field}.tolerance`, [
      'absolute',
      'relative',
    ]);
    const absolute = finite(toleranceValue['absolute'], `${field}.tolerance.absolute`);
    const relative = finite(toleranceValue['relative'], `${field}.tolerance.relative`);
    if (absolute < 0)
      fail(`${field}.tolerance.absolute`, 'must be non-negative.', ErrorCode.InputOutOfRange);
    if (relative < 0)
      fail(`${field}.tolerance.relative`, 'must be non-negative.', ErrorCode.InputOutOfRange);
    return {
      name,
      baseline: selector(item['baseline'], `${field}.baseline`),
      candidate: selector(item['candidate'], `${field}.candidate`),
      tolerance: { absolute, relative },
    };
  });
}

function observation(input: {
  result: Record<string, unknown>;
  selector: CalculationMetricSelector;
}): CalculationMetricObservation {
  let value: unknown = input.result;
  let missing = false;
  for (const component of input.selector.path) {
    if (
      value === null ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, component) ||
      (typeof component === 'number' && !Array.isArray(value))
    ) {
      missing = true;
      break;
    }
    value = (value as Record<string | number, unknown>)[component];
  }
  const unavailableReason: CalculationMetricUnavailableReason | null = missing
    ? 'missing'
    : value === null
      ? 'null'
      : typeof value !== 'number'
        ? 'non-numeric'
        : !Number.isFinite(value)
          ? 'non-finite'
          : null;
  return {
    ...input.selector,
    value: unavailableReason === null ? (value as number) : null,
    unavailableReason,
  };
}

function sourceDiagnostics(
  artifact: AnalysisArtifact,
  side: 'baseline' | 'candidate',
): CalculationSourceDiagnostics {
  const field = `input.${side}.result.diagnostics`;
  const value = artifact.result['diagnostics'];
  requireArgumentObject(FUNCTION_NAME, field, value);
  // Artifacts can carry disclosed non-finite result metrics. Diagnostics copied verbatim into
  // this successful report must themselves be finite, rather than losing data through JSON.
  scanCanonicalData(value, {
    functionName: FUNCTION_NAME,
    label: field,
    requireFiniteNumbers: true,
    maximumWorkUnits: COMPARISON_LIMITS.maximumLeaves.maximum,
  });
  const diagnostics = value as Record<string, unknown>;
  for (const [label, converged] of [
    [`${field}.converged`, diagnostics['converged']],
    [`input.${side}.result.converged`, artifact.result['converged']],
  ] as const) {
    if (converged !== undefined && typeof converged !== 'boolean')
      fail(label, 'must be a boolean when present.', ErrorCode.InputWrongType);
  }
  const warnings = diagnostics['warnings'];
  if (!Array.isArray(warnings))
    fail(`${field}.warnings`, 'must be an array.', ErrorCode.InputWrongType);
  for (let index = 0; index < warnings.length; index++) {
    const label = `${field}.warnings[${index}]`;
    const entry: unknown = warnings[index];
    requireArgumentObject(FUNCTION_NAME, label, entry);
    const item = entry as Record<string, unknown>;
    text(item['code'], `${label}.code`);
    if (typeof item['message'] !== 'string')
      fail(`${label}.message`, 'must be a string.', ErrorCode.InputWrongType);
    if (item['severity'] !== 'info' && item['severity'] !== 'warn' && item['severity'] !== 'error')
      fail(`${label}.severity`, 'must be info, warn or error.', ErrorCode.InputInvalidEnum);
    if (item['context'] !== undefined)
      requireArgumentObject(FUNCTION_NAME, `${label}.context`, item['context']);
  }
  return diagnostics as CalculationSourceDiagnostics;
}

/**
 * Compare selected financial metrics without confusing numerical closeness with matching economics.
 * Uses existing AnalysisArtifact validation/hashes and exact replay for recorded inputs/assumptions.
 * Different result schemas are supported only through explicit per-side metric paths. No unit
 * conversion, field-name guessing, engine execution, I/O or causal attribution is performed.
 *
 * @example
 * ```ts
 * const comparison = compareCalculationArtifacts({
 *   baseline, candidate,
 *   metrics: [{ name: 'premium',
 *     baseline: { path: ['value'], unit: 'USD/share' },
 *     candidate: { path: ['value'], unit: 'USD/share' },
 *     tolerance: { absolute: 0.0001, relative: 0 },
 *   }],
 * });
 * comparison.status; // 'match', 'mismatch', 'not-comparable', or 'insufficient-evidence'
 * ```
 */
export function compareCalculationArtifacts(
  input: CompareCalculationArtifactsInput,
): CalculationArtifactComparison {
  const value = controlRecord(input, 'input', [
    'baseline',
    'candidate',
    'metrics',
    'limits',
    'operationPolicy',
  ]);
  const suppliedLimits =
    value['limits'] === undefined
      ? {}
      : controlRecord(value['limits'], 'input.limits', ['maximumLeaves', 'maximumDifferences']);
  // Preserve the existing optional-limit omission contract without admitting undefined into
  // canonical stored metric data. These two fields were descriptor-checked above.
  const rawLimits = {
    ...(suppliedLimits['maximumLeaves'] === undefined
      ? {}
      : { maximumLeaves: suppliedLimits['maximumLeaves'] }),
    ...(suppliedLimits['maximumDifferences'] === undefined
      ? {}
      : { maximumDifferences: suppliedLimits['maximumDifferences'] }),
  };
  scanCanonicalData(rawLimits, {
    functionName: FUNCTION_NAME,
    label: 'input.limits',
    maximumWorkUnits: COMPARISON_LIMITS.maximumLeaves.maximum,
  });
  const limits = {
    maximumLeaves: requireWorkLimit({
      functionName: FUNCTION_NAME,
      field: 'input.limits.maximumLeaves',
      value: rawLimits['maximumLeaves'],
      law: COMPARISON_LIMITS.maximumLeaves,
    }),
    maximumDifferences: requireWorkLimit({
      functionName: FUNCTION_NAME,
      field: 'input.limits.maximumDifferences',
      value: rawLimits['maximumDifferences'],
      law: COMPARISON_LIMITS.maximumDifferences,
    }),
  };
  // Array cardinality is refused before inspecting entries; all nested controls (including
  // every character of names, units and paths) join the work budget before .map(), .trim(),
  // validation error stringification or output copies can run.
  denseArray(value['metrics'], 'input.metrics', MAXIMUM_METRICS);
  scanCanonicalData(
    {
      metrics: value['metrics'],
      limits: rawLimits,
      ...(value['operationPolicy'] === undefined
        ? {}
        : { operationPolicy: value['operationPolicy'] }),
    },
    {
      functionName: FUNCTION_NAME,
      label: 'input',
      maximumWorkUnits: limits.maximumLeaves,
    },
  );
  const selectedMetrics = metrics(value['metrics']);
  const operationPolicy =
    value['operationPolicy'] === undefined ? 'require-same' : value['operationPolicy'];
  if (operationPolicy !== 'require-same' && operationPolicy !== 'compare-declared-metrics')
    fail(
      'input.operationPolicy',
      'must be require-same or compare-declared-metrics.',
      ErrorCode.InputInvalidEnum,
    );
  for (const side of ['baseline', 'candidate'] as const) {
    if (value[side] === undefined)
      fail(`input.${side}`, 'is required.', ErrorCode.InputMissingField);
    scanCanonicalData(value[side], {
      functionName: FUNCTION_NAME,
      label: `input.${side}`,
      maximumWorkUnits: limits.maximumLeaves,
    });
  }
  const baseline = readAnalysisArtifact({ artifact: input.baseline }).artifact;
  const candidate = readAnalysisArtifact({ artifact: input.candidate }).artifact;
  const sources = {
    baseline: sourceDiagnostics(baseline, 'baseline'),
    candidate: sourceDiagnostics(candidate, 'candidate'),
  };
  const sourceFailed = (
    artifact: AnalysisArtifact,
    diagnostics: CalculationSourceDiagnostics,
  ): boolean =>
    artifact.result['converged'] === false ||
    diagnostics.converged === false ||
    diagnostics.warnings.some((item) => item.severity === 'error');
  const hasSourceFailure =
    sourceFailed(baseline, sources.baseline) || sourceFailed(candidate, sources.candidate);
  const operations = {
    baseline: baseline.producedBy.operation,
    candidate: candidate.producedBy.operation,
  };
  const sameOperation = operations.baseline === operations.candidate;
  const parameterComparison = artifactReplayParity({
    saved: { parameters: baseline.inputs.parameters ?? null },
    recomputed: { parameters: candidate.inputs.parameters ?? null },
    limits,
  });
  const assumptionComparison = artifactReplayParity({
    saved: baseline.result['assumptions'] as Record<string, unknown>,
    recomputed: candidate.result['assumptions'] as Record<string, unknown>,
    limits,
  });
  const hasInputs = (artifact: AnalysisArtifact): boolean => {
    if (artifact.inputs.snapshotHash !== undefined) return true;
    const parameters = artifact.inputs.parameters;
    return (
      parameters !== undefined &&
      parameters !== null &&
      (typeof parameters !== 'object' || Object.keys(parameters).length > 0)
    );
  };
  const inputs =
    !hasInputs(baseline) || !hasInputs(candidate)
      ? 'unrecorded'
      : baseline.inputs.inputsHash === candidate.inputs.inputsHash
        ? 'same'
        : 'different';
  const sameSnapshotHash =
    baseline.inputs.snapshotHash === undefined || candidate.inputs.snapshotHash === undefined
      ? null
      : baseline.inputs.snapshotHash === candidate.inputs.snapshotHash;
  const sameConventionsVersion = baseline.conventionsVersion === candidate.conventionsVersion;
  const rows: CalculationMetricComparison[] = selectedMetrics.map((metric) => {
    const baselineValue = observation({ result: baseline.result, selector: metric.baseline });
    const candidateValue = observation({ result: candidate.result, selector: metric.candidate });
    const sameUnit = baselineValue.unit === candidateValue.unit;
    const comparison =
      !sameUnit || baselineValue.value === null || candidateValue.value === null
        ? { absoluteDelta: null, relativeDelta: null, withinTolerance: null }
        : compareFiniteNumbers({
            baseline: baselineValue.value,
            candidate: candidateValue.value,
            tolerance: metric.tolerance,
          });
    return {
      name: metric.name,
      baseline: baselineValue,
      candidate: candidateValue,
      tolerance: metric.tolerance,
      sameUnit,
      ...comparison,
    };
  });
  const reasons: CalculationComparisonReason[] = [];
  if (inputs === 'different') reasons.push('different-inputs');
  if (inputs === 'unrecorded') reasons.push('unrecorded-inputs');
  if (!assumptionComparison.identical) reasons.push('different-assumptions');
  if (
    Object.keys(baseline.result['assumptions'] as object).length === 0 ||
    Object.keys(candidate.result['assumptions'] as object).length === 0
  )
    reasons.push('unrecorded-assumptions');
  if (!sameConventionsVersion) reasons.push('different-conventions');
  if (!sameOperation) reasons.push('different-operations');
  if (hasSourceFailure) reasons.push('source-failure');
  if (rows.some((row) => !row.sameUnit)) reasons.push('different-units');
  if (
    rows.some(
      (row) => row.baseline.unavailableReason !== null || row.candidate.unavailableReason !== null,
    )
  )
    reasons.push('unavailable-metric');
  if (rows.some((row) => row.withinTolerance === false)) reasons.push('metric-outside-tolerance');
  if (parameterComparison.truncated || assumptionComparison.truncated)
    reasons.push('truncated-context');
  const numericAgreement = rows.some((row) => row.withinTolerance === false)
    ? false
    : rows.some((row) => row.withinTolerance === null)
      ? null
      : true;
  const notComparable = reasons.some(
    (reason) =>
      reason === 'different-inputs' ||
      reason === 'different-assumptions' ||
      reason === 'different-conventions' ||
      (reason === 'different-operations' && operationPolicy === 'require-same') ||
      reason === 'different-units',
  );
  const insufficient = reasons.some(
    (reason) =>
      reason === 'unrecorded-inputs' ||
      reason === 'unrecorded-assumptions' ||
      reason === 'unavailable-metric' ||
      reason === 'truncated-context',
  );
  const status = hasSourceFailure
    ? 'insufficient-evidence'
    : notComparable
      ? 'not-comparable'
      : insufficient
        ? 'insufficient-evidence'
        : numericAgreement
          ? 'match'
          : 'mismatch';
  const libraryVersions = {
    baseline: baseline.producedBy.libraryVersion ?? null,
    candidate: candidate.producedBy.libraryVersion ?? null,
  };
  const warnings: QuantWarning[] =
    reasons.length === 0
      ? []
      : [
          warning(
            WarningCode.ModelLimitation,
            `${FUNCTION_NAME}: ${reasons.join(
              ', ',
            )}. Numeric agreement alone is not evidence of equivalent economics; review the recorded input and assumption differences.`,
            'warn',
            { reasons },
          ),
        ];
  if (!sameOperation)
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `Recorded operations differ: baseline ${operations.baseline}, candidate ${
          operations.candidate
        }. Policy ${operationPolicy} ${
          operationPolicy === 'require-same'
            ? 'requires the same operation'
            : 'compares only the declared metrics; it does not establish operation or model equivalence'
        }.`,
        'warn',
        { operations, operationPolicy },
      ),
    );
  for (const side of ['baseline', 'candidate'] as const) {
    const artifact = side === 'baseline' ? baseline : candidate;
    for (const item of sources[side].warnings)
      warnings.push({
        ...item,
        context: { sourceSide: side, artifactId: artifact.id, sourceContext: item.context ?? null },
      });
    if (sources[side].converged === false || artifact.result['converged'] === false)
      warnings.push(
        warning(
          WarningCode.ModelLimitation,
          `The ${side} source reports converged: false in its result or diagnostics; numeric agreement is insufficient evidence.`,
          'error',
          { sourceSide: side, artifactId: artifact.id },
        ),
      );
  }
  if (
    libraryVersions.baseline !== null &&
    libraryVersions.candidate !== null &&
    libraryVersions.baseline !== libraryVersions.candidate
  )
    warnings.push(
      warning(
        WarningCode.ArtifactLibraryVersionDiffers,
        'The recorded library versions differ; this comparison does not identify the cause of a numerical change.',
      ),
    );
  return deepFreeze({
    status,
    reasons,
    artifactIds: { baseline: baseline.id, candidate: candidate.id },
    metrics: rows,
    numericAgreement,
    context: {
      inputs,
      parameterComparison,
      assumptionComparison,
      sameSnapshotHash,
      sameConventionsVersion,
      sameOperation,
      operations,
      sourceDiagnostics: sources,
      libraryVersions,
    },
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      scope:
        'Only explicitly mapped metrics are compared. Matching recorded context is not proof that callers recorded every economic assumption or that either calculation is correct.',
      units:
        'Exact caller-declared unit/basis labels; no inference or automatic conversion. Normalize deliberately before saving artifacts when units differ.',
      comparison:
        'Inputs and disclosed assumptions compare exactly; metric |candidate - baseline| <= absolute + relative * |baseline| is decided exactly on the supplied IEEE values. Deltas are rounded; overflow is null. Source non-convergence or error warnings make evidence insufficient.',
      operationPolicy,
      limits: {
        maximumMetrics: MAXIMUM_METRICS,
        maximumPathComponents: MAXIMUM_PATH_COMPONENTS,
        ...limits,
      },
    },
    diagnostics: { warnings },
  });
}
