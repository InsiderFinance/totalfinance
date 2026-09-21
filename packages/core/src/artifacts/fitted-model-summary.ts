/**
 * The fitted-model summary grammar (Stage 4.5 Decision 2) — the ONE standard description of a
 * calibrated model that every domain adapter projects from its direct calibrator's result:
 * parameters, objective, convergence, residuals, model risk, weighting, input identity, and the
 * family's integer model version. Structural and model-agnostic: core knows no calibrator, so this
 * module validates SHAPE and honesty (a null objective carries a reason; a range has a minimum at
 * or below its maximum; hashes are hashes) and nothing about what the numbers mean.
 *
 * The summary is a PROJECTION — the domain report beside it carries the verbatim fit, and replay
 * compares the fit, never the summary.
 */

import { ErrorCode, InputError } from '../errors.js';
import { ensureKnownKeys, requireArgumentObject } from '../invariants.js';
import { scanCanonicalData } from './canonical-scan.js';
import { isContentHashString } from './content-hash.js';

export type FittedModelObjectiveKind =
  | 'root-mean-square-error'
  | 'log-likelihood'
  | 'r-squared'
  | 'exact-fit'
  | 'exact-bootstrap'
  | 'not-applicable';

export type FittedModelResidualSource = 'reported-by-calibrator' | 'direct-evaluator';

export interface FittedModelSummary {
  /** Dot-namespaced family, e.g. `'volatility.ssvi'` or `'fixed-income.discount-curve'`. */
  family: string;
  /** The family's integer semantics/shape version; bumps when the calibrator's result shape or meaning changes. */
  modelVersion: number;
  /** Flat, named, JSON-safe parameters — the numbers a reader would want to diff (dot paths for nested members). */
  parameters: Record<string, number | number[] | string>;
  objective: {
    kind: FittedModelObjectiveKind;
    value: number | null;
    /** The objective's unit or basis, e.g. `'total variance'`, `'implied volatility'`, `'log-likelihood'`. */
    unit: string;
    /** Required exactly when `value` is null. */
    reason?: string;
  };
  convergence: { converged: boolean; iterations: number | null; reason?: string };
  /** Null when the family has no per-point residual (with the reason in `modelRisk.notes`). */
  residuals: {
    count: number;
    rootMeanSquare: number | null;
    maximumAbsolute: number | null;
    unit: string;
    source: FittedModelResidualSource;
  } | null;
  modelRisk: {
    /** Butterfly/calendar freedom for smiles and surfaces; null where the notion does not apply. */
    arbitrageFree: boolean | null;
    /** The coordinate range the fit was calibrated over; evaluation outside it warns. */
    calibratedRange: Record<string, { minimum: number; maximum: number }>;
    notes: string[];
  };
  /** The weighting the calibrator applied, when it applied one; null otherwise. */
  weighting: string | null;
  /** Identity of what was fitted: the calibration input's content hash, and the market snapshot's when one was read. */
  inputIdentity: { calibrationHash: string; snapshotHash: string | null };
  warningCount: number;
}

const SUMMARY_KEYS = [
  'family',
  'modelVersion',
  'parameters',
  'objective',
  'convergence',
  'residuals',
  'modelRisk',
  'weighting',
  'inputIdentity',
  'warningCount',
] as const;

const OBJECTIVE_KINDS: readonly FittedModelObjectiveKind[] = [
  'root-mean-square-error',
  'log-likelihood',
  'r-squared',
  'exact-fit',
  'exact-bootstrap',
  'not-applicable',
];

const RESIDUAL_SOURCES: readonly FittedModelResidualSource[] = [
  'reported-by-calibrator',
  'direct-evaluator',
];

const FAMILY_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  return typeof value;
}

function fail(functionName: string, path: string, message: string, code: ErrorCode): never {
  throw new InputError(`${functionName}: ${path} ${message}`, {
    code,
    context: { function: functionName, field: path },
  });
}

function requireString(functionName: string, path: string, value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(
      functionName,
      path,
      `must be ${what} (a non-empty string). Received ${describe(value)}.`,
      ErrorCode.InputWrongType,
    );
  }
  return value;
}

function requireFiniteNumber(functionName: string, path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(
      functionName,
      path,
      `must be a finite number. Received ${describe(value)}.`,
      typeof value === 'number'
        ? Number.isNaN(value)
          ? ErrorCode.InputNaN
          : ErrorCode.InputNotFinite
        : ErrorCode.InputWrongType,
    );
  }
  return value;
}

function requireFiniteOrNull(functionName: string, path: string, value: unknown): number | null {
  if (value === null) return null;
  return requireFiniteNumber(functionName, path, value);
}

function requireNonNegativeInteger(functionName: string, path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(
      functionName,
      path,
      `must be a non-negative safe integer. Received ${describe(value)}.`,
      ErrorCode.InputOutOfRange,
    );
  }
  return value;
}

function requireBoolean(functionName: string, path: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    fail(
      functionName,
      path,
      `must be a boolean. Received ${describe(value)}.`,
      ErrorCode.InputWrongType,
    );
  }
  return value;
}

function requireRecord(
  functionName: string,
  path: string,
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      functionName,
      path,
      `must be a plain object. Received ${describe(value)}.`,
      ErrorCode.InputWrongType,
    );
  }
  return value as Record<string, unknown>;
}

function requireLiteral<T extends string>(
  functionName: string,
  path: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(
      functionName,
      path,
      `must be one of ${allowed.join(', ')}. Received ${describe(value)}.`,
      ErrorCode.InputInvalidEnum,
    );
  }
  return value as T;
}

function requireOptionalReason(functionName: string, path: string, value: unknown): void {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
    fail(
      functionName,
      path,
      `must be a non-empty prose reason when present. Received ${describe(value)}.`,
      ErrorCode.InputWrongType,
    );
  }
}

/**
 * The FULL summary validator — closed keys at every level, typed and finite fields, and the
 * honesty rules (a null objective or residual statistic needs its reason; a calibrated range is
 * ordered; identity fields are content hashes). Shared by the domain adapters (which project a
 * summary and then prove it here) and by {@link isFittedModelSummary}. Returns the validated value.
 */
export function requireFittedModelSummary(
  functionName: string,
  label: string,
  value: unknown,
): FittedModelSummary {
  requireArgumentObject(functionName, label, value);
  // Hostile shapes (accessors, cycles, class instances) are refused before any field is read.
  scanCanonicalData(value, { functionName, label, maximumDepth: 8, requireFiniteNumbers: true });
  const summary = value as Record<string, unknown>;
  ensureKnownKeys(functionName, label, summary, SUMMARY_KEYS);
  for (const key of SUMMARY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(summary, key)) {
      fail(
        functionName,
        `${label}.${key}`,
        'is required — a fitted-model summary states every field, with null where a notion does not apply.',
        ErrorCode.InputMissingField,
      );
    }
  }

  const family = requireString(
    functionName,
    `${label}.family`,
    summary['family'],
    'a dot-namespaced family',
  );
  if (!FAMILY_PATTERN.test(family)) {
    fail(
      functionName,
      `${label}.family`,
      `must be '<package>.<family>' in lower-case kebab words, e.g. 'volatility.ssvi'. Received ${JSON.stringify(family)}.`,
      ErrorCode.InputWrongShape,
    );
  }
  const modelVersion = summary['modelVersion'];
  if (typeof modelVersion !== 'number' || !Number.isSafeInteger(modelVersion) || modelVersion < 1) {
    fail(
      functionName,
      `${label}.modelVersion`,
      `must be a positive integer model version. Received ${describe(modelVersion)}.`,
      ErrorCode.InputOutOfRange,
    );
  }

  const parameters = requireRecord(functionName, `${label}.parameters`, summary['parameters']);
  for (const [name, parameter] of Object.entries(parameters)) {
    const path = `${label}.parameters.${name}`;
    if (name.length === 0)
      fail(
        functionName,
        `${label}.parameters`,
        'has an empty parameter name.',
        ErrorCode.InputWrongShape,
      );
    if (typeof parameter === 'string') {
      if (parameter.length === 0)
        fail(
          functionName,
          path,
          'must be a non-empty string when a parameter is a label.',
          ErrorCode.InputWrongType,
        );
      continue;
    }
    if (Array.isArray(parameter)) {
      parameter.forEach((element, index) =>
        requireFiniteNumber(functionName, `${path}[${index}]`, element),
      );
      continue;
    }
    if (typeof parameter !== 'number') {
      fail(
        functionName,
        path,
        `must be a finite number, an array of finite numbers, or a string label. Received ${describe(parameter)}.`,
        ErrorCode.InputWrongType,
      );
    }
    requireFiniteNumber(functionName, path, parameter);
  }

  const objective = requireRecord(functionName, `${label}.objective`, summary['objective']);
  ensureKnownKeys(functionName, `${label}.objective`, objective, [
    'kind',
    'value',
    'unit',
    'reason',
  ]);
  requireLiteral(functionName, `${label}.objective.kind`, objective['kind'], OBJECTIVE_KINDS);
  const objectiveValue = requireFiniteOrNull(
    functionName,
    `${label}.objective.value`,
    objective['value'],
  );
  requireString(
    functionName,
    `${label}.objective.unit`,
    objective['unit'],
    "the objective's unit or basis",
  );
  requireOptionalReason(functionName, `${label}.objective.reason`, objective['reason']);
  if (objectiveValue === null && objective['reason'] === undefined) {
    fail(
      functionName,
      `${label}.objective.reason`,
      'is required when objective.value is null — an undefined objective states why (law 7: null with a reason, never a bare null).',
      ErrorCode.InputMissingField,
    );
  }
  if (objectiveValue !== null && objective['reason'] !== undefined) {
    fail(
      functionName,
      `${label}.objective.reason`,
      'is present although objective.value is a number — a reason accompanies a null value only.',
      ErrorCode.InputWrongShape,
    );
  }

  const convergence = requireRecord(functionName, `${label}.convergence`, summary['convergence']);
  ensureKnownKeys(functionName, `${label}.convergence`, convergence, [
    'converged',
    'iterations',
    'reason',
  ]);
  requireBoolean(functionName, `${label}.convergence.converged`, convergence['converged']);
  if (convergence['iterations'] !== null) {
    requireNonNegativeInteger(
      functionName,
      `${label}.convergence.iterations`,
      convergence['iterations'],
    );
  }
  requireOptionalReason(functionName, `${label}.convergence.reason`, convergence['reason']);

  if (summary['residuals'] !== null) {
    const residuals = requireRecord(functionName, `${label}.residuals`, summary['residuals']);
    ensureKnownKeys(functionName, `${label}.residuals`, residuals, [
      'count',
      'rootMeanSquare',
      'maximumAbsolute',
      'unit',
      'source',
    ]);
    requireNonNegativeInteger(functionName, `${label}.residuals.count`, residuals['count']);
    for (const field of ['rootMeanSquare', 'maximumAbsolute'] as const) {
      const statistic = requireFiniteOrNull(
        functionName,
        `${label}.residuals.${field}`,
        residuals[field],
      );
      if (statistic !== null && statistic < 0) {
        fail(
          functionName,
          `${label}.residuals.${field}`,
          `must be ≥ 0 (a magnitude). Received ${statistic}.`,
          ErrorCode.InputOutOfRange,
        );
      }
    }
    requireString(
      functionName,
      `${label}.residuals.unit`,
      residuals['unit'],
      "the residuals' unit",
    );
    requireLiteral(
      functionName,
      `${label}.residuals.source`,
      residuals['source'],
      RESIDUAL_SOURCES,
    );
  }

  const modelRisk = requireRecord(functionName, `${label}.modelRisk`, summary['modelRisk']);
  ensureKnownKeys(functionName, `${label}.modelRisk`, modelRisk, [
    'arbitrageFree',
    'calibratedRange',
    'notes',
  ]);
  if (modelRisk['arbitrageFree'] !== null) {
    requireBoolean(functionName, `${label}.modelRisk.arbitrageFree`, modelRisk['arbitrageFree']);
  }
  const ranges = requireRecord(
    functionName,
    `${label}.modelRisk.calibratedRange`,
    modelRisk['calibratedRange'],
  );
  for (const [coordinate, range] of Object.entries(ranges)) {
    const path = `${label}.modelRisk.calibratedRange.${coordinate}`;
    const record = requireRecord(functionName, path, range);
    ensureKnownKeys(functionName, path, record, ['minimum', 'maximum']);
    const minimum = requireFiniteNumber(functionName, `${path}.minimum`, record['minimum']);
    const maximum = requireFiniteNumber(functionName, `${path}.maximum`, record['maximum']);
    if (minimum > maximum) {
      fail(
        functionName,
        path,
        `must be ordered: minimum ${minimum} is above maximum ${maximum}.`,
        ErrorCode.InputOutOfRange,
      );
    }
  }
  const notes = modelRisk['notes'];
  if (
    !Array.isArray(notes) ||
    notes.some((note) => typeof note !== 'string' || note.length === 0)
  ) {
    fail(
      functionName,
      `${label}.modelRisk.notes`,
      'must be an array of non-empty prose notes (empty is fine, absent is not).',
      ErrorCode.InputWrongType,
    );
  }

  if (summary['weighting'] !== null) {
    requireString(
      functionName,
      `${label}.weighting`,
      summary['weighting'],
      "the calibrator's weighting",
    );
  }

  const identity = requireRecord(functionName, `${label}.inputIdentity`, summary['inputIdentity']);
  ensureKnownKeys(functionName, `${label}.inputIdentity`, identity, [
    'calibrationHash',
    'snapshotHash',
  ]);
  if (!isContentHashString(identity['calibrationHash'])) {
    fail(
      functionName,
      `${label}.inputIdentity.calibrationHash`,
      `must be a 'sha256:<64 hex>' content hash of the calibration input — build it with contentHash(calibration). Received ${describe(identity['calibrationHash'])}.`,
      ErrorCode.InputWrongType,
    );
  }
  if (identity['snapshotHash'] !== null && !isContentHashString(identity['snapshotHash'])) {
    fail(
      functionName,
      `${label}.inputIdentity.snapshotHash`,
      `must be a 'sha256:<64 hex>' market-snapshot hash or null. Received ${describe(identity['snapshotHash'])}.`,
      ErrorCode.InputWrongType,
    );
  }
  requireNonNegativeInteger(functionName, `${label}.warningCount`, summary['warningCount']);
  return value as FittedModelSummary;
}

/**
 * Sound structural predicate for a fitted-model summary: the COMPLETE {@link requireFittedModelSummary}
 * validation behind a boolean door, so `value is FittedModelSummary` is a claim every consumer can act on.
 */
export function isFittedModelSummary(value: unknown): value is FittedModelSummary {
  try {
    requireFittedModelSummary('isFittedModelSummary', 'value', value);
    return true;
  } catch {
    return false;
  }
}
