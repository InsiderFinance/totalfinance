/**
 * The structural mechanics every fitted-model / research-run adapter shares (Stage 4.5, Decisions
 * 5, 6, 9) — ONE engine for the parts that are not domain semantics:
 *
 * - {@link ARTIFACT_WORK_LIMITS} — Decision 9's bounded-work table (defaults a caller may lower,
 *   hard maxima never passed) and {@link requireWorkLimit}, its count-safe validator;
 * - {@link requireComparisonTolerance} — the explicit two-sided tolerance law (never defaulted);
 * - {@link applyReportMigrations} — Gate B's migration policy applied a SECOND time at the report
 *   level: a newer stored version refuses, an older one restores only through the caller's
 *   registry under the family-scoped kind, every step echoed, a missing link refused with the
 *   registration teaching (Decision 5);
 * - {@link verifyReferencedRows} — caller-supplied rows for a referenced table must hash to the
 *   stored handle, or replay would be a replay of a different run;
 * - {@link flattenSummaryParameters} and {@link residualStatistics} — the summary's flat parameter
 *   view and the residual statistic every projection reports.
 *
 * Domain packages (`@insiderfinance/totalfinance/volatility/artifacts`, `@insiderfinance/totalfinance/fixed-income/artifacts`,
 * `@insiderfinance/totalfinance/research/artifacts`) call these; none re-implements them.
 */

import { ErrorCode, InputError, isQuantError } from '../errors.js';
import { ensureKnownKeys, requireArgumentArray, requireArgumentObject } from '../invariants.js';
import type { ComparisonTolerance } from './comparison.js';
import { createArtifactMigrationRegistry } from './migration.js';
import type { AppliedMigration, ArtifactMigrationRegistry } from './migration.js';
import { requireFittedModelSummary, type FittedModelSummary } from './fitted-model-summary.js';
import { requireTableHandle, tableHandleForRows } from './table-handle.js';
import type { TableHandle } from './table-handle.js';

/** Decision 9's bounded-work table: what a caller may lower, and the hard maxima never passed. */
export const ARTIFACT_WORK_LIMITS = Object.freeze({
  maximumEmbeddedBytes: Object.freeze({ default: 1_048_576, maximum: 8_388_608 }),
  embeddedRowLimit: Object.freeze({ default: 5_000, maximum: 50_000 }),
  maximumDifferences: Object.freeze({ default: 1_000, maximum: 100_000 }),
  maximumLeaves: Object.freeze({ default: 2_000_000, maximum: 2_000_000 }),
  gridPoints: Object.freeze({ default: 256, maximum: 4_096 }),
  restarts: Object.freeze({ maximum: 64 }),
  holdoutEvaluations: Object.freeze({ maximum: 100_000 }),
  listedIds: Object.freeze({ default: 200, maximum: 10_000 }),
});

export interface WorkLimitLaw {
  default?: number;
  maximum: number;
}

function describe(value: unknown): string {
  return typeof value === 'number' ? String(value) : value === null ? 'null' : typeof value;
}

/** The kit's own door: every helper is public, so its request is closed and typed like any other. */
function requireKitRequest(
  functionName: string,
  input: unknown,
  keys: readonly string[],
  strings: readonly string[],
): Record<string, unknown> {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input as object, keys);
  const record = input as Record<string, unknown>;
  for (const field of strings) {
    const value = record[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new InputError(
        `${functionName}: input.${field} must be a non-empty string. Received ${describe(value)}.`,
        {
          code: value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
          context: { function: functionName, field: `input.${field}` },
        },
      );
    }
  }
  return record;
}

/** Structural check for the registry (a function-membered class instance, so no closed-keys walk). */
function isMigrationRegistry(value: unknown): value is ArtifactMigrationRegistry {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { upgrade?: unknown }).upgrade === 'function' &&
    typeof (value as { register?: unknown }).register === 'function'
  );
}

function requireFiniteNumber(functionName: string, field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${field} must be a finite number. Received ${describe(value)}.`,
      {
        code: value === undefined ? ErrorCode.InputMissingField : ErrorCode.InputWrongType,
        context: { function: functionName, field },
      },
    );
  }
  return value;
}

/**
 * Validate one work limit: a safe integer at or above `floor` (default 1), at or below the law's
 * hard maximum; `undefined` takes the law's default when it has one and refuses when it has none.
 */
export function requireWorkLimit(input: {
  functionName: string;
  field: string;
  /** The caller's raw value; omitted (undefined) takes the law's default. */
  value?: unknown;
  law: WorkLimitLaw;
  floor?: number;
}): number {
  const record = requireKitRequest(
    'requireWorkLimit',
    input,
    ['functionName', 'field', 'value', 'law', 'floor'],
    ['functionName', 'field'],
  );
  const functionName = record['functionName'] as string;
  const field = record['field'] as string;
  const value = record['value'];
  requireArgumentObject('requireWorkLimit', 'input.law', record['law']);
  ensureKnownKeys('requireWorkLimit', 'input.law', record['law'] as object, ['default', 'maximum']);
  const lawRecord = record['law'] as Record<string, unknown>;
  const law: WorkLimitLaw = {
    maximum: requireFiniteNumber('requireWorkLimit', 'input.law.maximum', lawRecord['maximum']),
    ...(lawRecord['default'] === undefined
      ? {}
      : {
          default: requireFiniteNumber(
            'requireWorkLimit',
            'input.law.default',
            lawRecord['default'],
          ),
        }),
  };
  const floor =
    record['floor'] === undefined
      ? 1
      : requireFiniteNumber('requireWorkLimit', 'input.floor', record['floor']);
  if (value === undefined) {
    if (law.default === undefined) {
      throw new InputError(`${functionName}: ${field} is required.`, {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field },
      });
    }
    return law.default;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < floor) {
    throw new InputError(
      `${functionName}: ${field} must be a safe integer ≥ ${floor} (${law.default !== undefined ? `default ${law.default}, ` : ''}maximum ${law.maximum}). Received ${describe(value)}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field } },
    );
  }
  if (value > law.maximum) {
    throw new InputError(
      `${functionName}: ${field} is ${value}, above the hard maximum ${law.maximum} — a caller may lower a limit or opt up to the maximum, never past it.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field, maximum: law.maximum },
      },
    );
  }
  return value;
}

/** The explicit two-sided tolerance law: both members finite and ≥ 0, or no tolerance at all. */
export function requireComparisonTolerance(input: {
  functionName: string;
  /** The caller's raw tolerance; omitted (undefined) means no tolerance — exact comparison. */
  tolerance?: unknown;
}): ComparisonTolerance | null {
  const request = requireKitRequest(
    'requireComparisonTolerance',
    input,
    ['functionName', 'tolerance'],
    ['functionName'],
  );
  const functionName = request['functionName'] as string;
  const tolerance = request['tolerance'];
  if (tolerance === undefined) return null;
  requireArgumentObject(functionName, 'tolerance', tolerance);
  ensureKnownKeys(functionName, 'tolerance', tolerance as object, ['absolute', 'relative']);
  const record = tolerance as Record<string, unknown>;
  for (const field of ['absolute', 'relative'] as const) {
    const value = record[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new InputError(
        `${functionName}: tolerance.${field} must be a finite number ≥ 0 — a tolerance is two-sided and explicit ({ absolute, relative }), never defaulted. Received ${describe(value)}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `tolerance.${field}` },
        },
      );
    }
  }
  return { absolute: record['absolute'] as number, relative: record['relative'] as number };
}

/**
 * Gate B's migration policy at the REPORT level (Decision 5). The report is presented to the
 * caller's registry through the envelope view `{ kind, schemaVersion: <stored version>, report }`,
 * so the one registry runs its one policy; the migrated `report` is returned with the target
 * version stamped and every applied step echoed.
 */
export function applyReportMigrations(input: {
  functionName: string;
  /** The family-scoped kind, e.g. `'volatility.fitted-model:ssvi'` or `'research.run:screen'`. */
  kind: string;
  report: Record<string, unknown>;
  storedVersion: unknown;
  currentVersion: number;
  /** The report's version field name (`'modelVersion'` or `'runVersion'`). */
  versionField: string;
  migrations?: ArtifactMigrationRegistry;
  /** What the stored report describes, for the teachings: `'ssvi report'`. */
  subject: string;
}): { report: Record<string, unknown>; modelMigrationsApplied: AppliedMigration[] } {
  const record = requireKitRequest(
    'applyReportMigrations',
    input,
    [
      'functionName',
      'kind',
      'report',
      'storedVersion',
      'currentVersion',
      'versionField',
      'migrations',
      'subject',
    ],
    ['functionName', 'kind', 'versionField', 'subject'],
  );
  const functionName = record['functionName'] as string;
  const kind = record['kind'] as string;
  const versionField = record['versionField'] as string;
  const subject = record['subject'] as string;
  requireArgumentObject('applyReportMigrations', 'input.report', record['report']);
  const report = record['report'] as Record<string, unknown>;
  const storedVersion = record['storedVersion'];
  const currentVersion = record['currentVersion'];
  if (
    typeof currentVersion !== 'number' ||
    !Number.isSafeInteger(currentVersion) ||
    currentVersion < 0
  ) {
    throw new InputError(
      `applyReportMigrations: input.currentVersion must be a non-negative integer (this build's ${versionField}). Received ${describe(currentVersion)}.`,
      {
        code:
          currentVersion === undefined ? ErrorCode.InputMissingField : ErrorCode.InputOutOfRange,
        context: { function: 'applyReportMigrations', field: 'input.currentVersion' },
      },
    );
  }
  if (record['migrations'] !== undefined && !isMigrationRegistry(record['migrations'])) {
    throw new InputError(
      'applyReportMigrations: input.migrations must be an ArtifactMigrationRegistry (createArtifactMigrationRegistry()).',
      {
        code: ErrorCode.InputWrongType,
        context: { function: 'applyReportMigrations', field: 'input.migrations' },
      },
    );
  }
  if (
    typeof storedVersion !== 'number' ||
    !Number.isSafeInteger(storedVersion) ||
    storedVersion < 0
  ) {
    throw new InputError(
      `${functionName}: the stored ${subject}'s ${versionField} must be a non-negative integer. Received ${describe(storedVersion)}.`,
      { code: ErrorCode.InputOutOfRange, context: { function: functionName, field: versionField } },
    );
  }
  if (storedVersion > currentVersion) {
    throw new InputError(
      `${functionName}: the stored ${subject} is version ${storedVersion}, newer than this build's ${currentVersion} — reading it under different semantics would be a silent wrong number. Upgrade the package to restore it.`,
      {
        code: ErrorCode.ArtifactModelVersionUnsupported,
        context: { function: functionName, kind, stored: storedVersion, current: currentVersion },
      },
    );
  }
  if (storedVersion === currentVersion) return { report, modelMigrationsApplied: [] };
  const registry =
    (record['migrations'] as ArtifactMigrationRegistry | undefined) ??
    createArtifactMigrationRegistry();
  try {
    const upgraded = registry.upgrade({
      envelope: { kind, schemaVersion: storedVersion, report },
      targetVersion: currentVersion,
    });
    const migrated = upgraded.envelope['report'];
    requireArgumentObject(functionName, `migrated ${subject}`, migrated);
    return {
      report: { ...(migrated as Record<string, unknown>), [versionField]: currentVersion },
      modelMigrationsApplied: upgraded.migrationsApplied,
    };
  } catch (error) {
    if (isQuantError(error, ErrorCode.ArtifactMigrationMissing)) {
      throw new InputError(
        `${functionName}: the stored ${subject} is version ${storedVersion} and this build reads ${currentVersion}; no report migration is registered under kind '${kind}' — register one (registry.register({ kind: '${kind}', fromVersion: ${storedVersion}, toVersion: ${storedVersion + 1}, description, migrate })) or recompute from the stored inputs. A migration rewrites shape; it never computes results.`,
        {
          code: ErrorCode.ArtifactModelVersionUnsupported,
          context: { function: functionName, kind, stored: storedVersion, current: currentVersion },
          cause: error,
        },
      );
    }
    throw error;
  }
}

/**
 * Prove caller-supplied rows are the referenced table: they must be an array whose canonical
 * content hash equals the stored handle's. Returns the rows (as given) on success.
 */
export function verifyReferencedRows(input: {
  functionName: string;
  label: string;
  handle: TableHandle;
  rows: unknown;
}): unknown[] {
  const record = requireKitRequest(
    'verifyReferencedRows',
    input,
    ['functionName', 'label', 'handle', 'rows'],
    ['functionName', 'label'],
  );
  const functionName = record['functionName'] as string;
  const label = record['label'] as string;
  const handle = requireTableHandle('verifyReferencedRows', 'input.handle', record['handle']);
  const rows = record['rows'];
  requireArgumentArray(functionName, `referencedData.${label}`, rows);
  const minted = tableHandleForRows({ rows: rows as unknown[] });
  if (minted.rowCount !== handle.rowCount) {
    throw new InputError(
      `${functionName}: referencedData.${label} has ${minted.rowCount} rows but the artifact's table handle records ${handle.rowCount} — the handle does not describe these rows.`,
      {
        code: ErrorCode.ArtifactReferencedDataMismatch,
        context: {
          function: functionName,
          rowSet: label,
          supplied: minted.rowCount,
          stored: handle.rowCount,
        },
      },
    );
  }
  if (minted.contentHash !== handle.contentHash) {
    throw new InputError(
      `${functionName}: referencedData.${label} does not hash to the artifact's table handle (supplied ${minted.contentHash.slice(0, 18)}… over ${(rows as unknown[]).length} rows, stored ${handle.contentHash.slice(0, 18)}… over ${handle.rowCount} rows) — a replay over different data would be a replay of a different run.`,
      {
        code: ErrorCode.ArtifactReferencedDataMismatch,
        context: {
          function: functionName,
          rowSet: label,
          supplied: minted.contentHash,
          stored: handle.contentHash,
        },
      },
    );
  }
  return rows as unknown[];
}

/**
 * A validated summary's flat parameter view: arrays become indexed keys (`thetaTerm.theta[2]`).
 * Takes the whole summary (validated here, like every door) rather than a bare record, so the
 * parameters it flattens are the ones `requireFittedModelSummary` admits.
 */
export function flattenSummaryParameters(
  summary: FittedModelSummary,
): Record<string, number | string> {
  const { parameters } = requireFittedModelSummary('flattenSummaryParameters', 'summary', summary);
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (Array.isArray(value))
      value.forEach((element, index) => (out[`${key}[${index}]`] = element));
    else out[key] = value;
  }
  return out;
}

/** Count, root-mean-square, and maximum absolute value of a residual list (null statistics when empty). */
export function residualStatistics(residuals: readonly number[]): {
  count: number;
  rootMeanSquare: number | null;
  maximumAbsolute: number | null;
} {
  if (residuals.length === 0) return { count: 0, rootMeanSquare: null, maximumAbsolute: null };
  let sumSquares = 0;
  let maximumAbsolute = 0;
  for (const residual of residuals) {
    sumSquares += residual * residual;
    if (Math.abs(residual) > maximumAbsolute) maximumAbsolute = Math.abs(residual);
  }
  return {
    count: residuals.length,
    rootMeanSquare: Math.sqrt(sumSquares / residuals.length),
    maximumAbsolute,
  };
}
