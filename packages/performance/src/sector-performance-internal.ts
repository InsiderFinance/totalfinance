/** Private shared boundaries and aggregation; not a package entrypoint. */
import {
  ensureFiniteWhenPresent,
  ErrorCode,
  InputError,
  isoDateToEpochMs,
  missingFieldError,
  requireArgumentObject,
  stableSum,
  type QuantWarning,
} from '@totalfinance/core';

export const POLICY_VERSION = 'sector-performance-v1' as const;
export const AGGREGATION_ASSUMPTIONS = Object.freeze({
  policyVersion: POLICY_VERSION,
  weighting:
    'Arithmetic mean of unrounded decimal member returns, one equal weight per stable security identity.',
  rounding:
    'Only sector means are rounded to the nearest eight-decimal value of the actual IEEE-754 number, exact ties away from zero, without an epsilon nudge; negative zero is normalized.',
  rankingAndTies:
    'Descending rounded returns with competition ranks (1, 1, 3); ties use sectorId then sectorName in code-unit order.',
});

/** A synchronous call may consume at most one million rows in total, checked before element access. */
const MAXIMUM_ROWS = 1_000_000;

export function sectorBoundary(functionName: string, exampleCall: string) {
  function requireObject<T extends object = Record<string, unknown>>(
    path: string,
    value: unknown,
  ): T & Record<string, unknown> {
    requireArgumentObject(functionName, path, value);
    return value as T & Record<string, unknown>;
  }

  function requireFields(
    value: Record<string, unknown>,
    path: string,
    fields: readonly string[],
  ): void {
    for (const field of fields) {
      if (!Object.prototype.hasOwnProperty.call(value, field) || value[field] === undefined) {
        throw missingFieldError(functionName, `${path}.${field}`, exampleCall);
      }
    }
  }

  function requireNumber(path: string, value: unknown): number {
    if (value === undefined) throw missingFieldError(functionName, path, exampleCall);
    ensureFiniteWhenPresent(value, path, functionName);
    return value as number;
  }

  function requireTimestamp(path: string, value: unknown): number {
    const result = requireNumber(path, value);
    if (!Number.isSafeInteger(result) || result < 0) {
      throw new InputError(
        `${functionName}: ${path} must be a non-negative safe-integer epoch-millisecond value.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: path, value: result },
        },
      );
    }
    return result;
  }

  function requireNonEmptyString(path: string, value: unknown): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new InputError(`${functionName}: ${path} must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: path },
      });
    }
    return value;
  }

  function requireDate(path: string, value: unknown): string {
    const result = requireNonEmptyString(path, value);
    try {
      isoDateToEpochMs(result);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      throw new InputError(
        `${functionName}: ${path} must be a strict YYYY-MM-DD calendar date. ${error.message}`,
        {
          code: error.code,
          context: { function: functionName, field: path, value: result },
        },
      );
    }
    return result;
  }

  function boundedArrays(
    value: Record<string, unknown>,
    fields: readonly string[],
  ): Record<string, readonly unknown[]> {
    const arrays: Record<string, readonly unknown[]> = {};
    let total = 0;
    for (const field of fields) {
      const array = value[field];
      const path = `input.${field}`;
      if (!Array.isArray(array)) {
        throw new InputError(`${functionName}: ${path} must be an array.`, {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field: path },
        });
      }
      total += array.length;
      if (total > MAXIMUM_ROWS) {
        throw new InputError(
          `${functionName}: ${path} exceeds the shared ${MAXIMUM_ROWS}-row input budget; supply only the relevant universe and history.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: {
              function: functionName,
              field: path,
              maximumRows: MAXIMUM_ROWS,
              totalRows: total,
            },
          },
        );
      }
      arrays[field] = array;
    }
    return arrays;
  }

  function mapRows<T>(
    rows: readonly unknown[],
    path: string,
    parse: (row: unknown, index: number) => T,
  ): T[] {
    const result: T[] = [];
    for (let index = 0; index < rows.length; index++) {
      // An inherited element cannot fill a sparse own slot. Do not use map/forEach: they skip holes.
      if (!Object.prototype.hasOwnProperty.call(rows, index)) {
        requireArgumentObject(functionName, `${path}[${index}]`, undefined);
      }
      result.push(parse(rows[index], index));
    }
    return result;
  }

  function requireUnique<T>(rows: readonly T[], path: string, identity: (row: T) => string): void {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      const key = identity(row);
      if (seen.has(key)) {
        throw new InputError(
          `${functionName}: ${path}[${index}] duplicates the identity ${JSON.stringify(
            key,
          )}; ambiguous inputs fail closed.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { function: functionName, field: `${path}[${index}]`, identity: key },
          },
        );
      }
      seen.add(key);
    });
  }

  return {
    requireObject,
    requireFields,
    requireNumber,
    requireTimestamp,
    requireNonEmptyString,
    requireDate,
    boundedArrays,
    mapRows,
    requireUnique,
  };
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Preserve the historical stable sum, rescaling only when a finite collection's sum overflows. */
function stableMean(values: readonly number[]): number {
  const total = stableSum(values);
  if (Number.isFinite(total)) return total / values.length;
  let scale = 0;
  for (const value of values) scale = Math.max(scale, Math.abs(value));
  const normalizedTotal = stableSum(values.map((value) => value / scale));
  const normalizedMean = normalizedTotal / values.length;
  return normalizedMean !== 0 || normalizedTotal === 0
    ? normalizedMean * scale
    : normalizedTotal * (scale / values.length);
}

/**
 * Sector policy, deliberately independent of core's display-oriented epsilon-nudged round.
 * toFixed rounds the actual double to a decimal grid without first multiplying by 1e8 (which
 * could itself round a just-below-half input onto the tie). Its magnitude tie rule is away from
 * zero for either sign. At >=1e21 it emits the unchanged number's round-tripping representation:
 * every such double is already integral. MAX_VALUE therefore survives, and subnormals become 0.
 */
function roundSectorReturn(value: number): number {
  const rounded = Number(value.toFixed(8));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Named financial operands; private to sector implementation/tests, not a package entrypoint.
 * Subtract before dividing to preserve small price moves. Valid public closes are positive, so
 * their difference cannot overflow; the split fallback also keeps this helper correct for finite
 * signed operands whose difference overflows but whose ratio/return is representable.
 * Unrepresentable returns remain non-finite here and are refused by the audited public boundary.
 */
export function sectorSimpleReturn({
  targetClose,
  previousClose,
}: {
  targetClose: number;
  previousClose: number;
}): number {
  const difference = targetClose - previousClose;
  const value = Number.isFinite(difference)
    ? difference / previousClose
    : targetClose / previousClose - 1;
  return Object.is(value, -0) ? 0 : value;
}

export interface SectorGroup<T> {
  sectorId: string;
  sectorName: string;
  eligibleSecurityCount: number;
  members: T[];
}

/** Both APIs share the same mean, rounding, identity ordering, coverage counts and rank assignment. */
export function aggregateSectors<T>(input: {
  groups: Iterable<SectorGroup<T>>;
  memberReturn: (member: T) => number;
}) {
  const sectors = [...input.groups]
    .filter((group) => group.members.length > 0)
    .map((group) => {
      const rounded = roundSectorReturn(stableMean(group.members.map(input.memberReturn)));
      return {
        sectorId: group.sectorId,
        sectorName: group.sectorName,
        periodReturn: Object.is(rounded, -0) ? 0 : rounded,
        rank: 0,
        eligibleSecurityCount: group.eligibleSecurityCount,
        includedSecurityCount: group.members.length,
        excludedSecurityCount: group.eligibleSecurityCount - group.members.length,
        members: group.members,
      };
    })
    .sort(
      (left, right) =>
        right.periodReturn - left.periodReturn ||
        compareText(left.sectorId, right.sectorId) ||
        compareText(left.sectorName, right.sectorName),
    );
  let rank = 0;
  let previous: number | undefined;
  sectors.forEach((sector, index) => {
    if (previous === undefined || sector.periodReturn !== previous) rank = index + 1;
    sector.rank = rank;
    previous = sector.periodReturn;
  });
  return sectors;
}

/** Summaries use existing detailed blocker/reason discriminants as stable warning codes. */
export function sectorWarnings(input: {
  blockers: readonly string[];
  reasons?: readonly { reason: string; count: number }[];
}): QuantWarning[] {
  return [
    ...input.blockers.map(
      (blocker): QuantWarning => ({
        code: `performance.${blocker}`,
        message: `No sector returns: ${blocker}.`,
        severity: 'warn',
      }),
    ),
    ...(input.reasons ?? []).map(
      ({ reason, count }): QuantWarning => ({
        code: `performance.${reason}`,
        message: `${count} security exclusions: ${reason}.`,
        severity: 'warn',
        context: { count },
      }),
    ),
  ];
}
