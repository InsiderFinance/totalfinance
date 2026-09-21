/**
 * The FROZEN fundamental-period contract (FC0). These names and units are final and enter the
 * Phase 3B naming/field ratchets with this slice — statements, snapshots, and ratio inputs (FC2)
 * attach to a `FundamentalPeriod`, and every point-in-time consumer gates on
 * `availableTimestampMs`, never on the period end.
 */

import {
  ensureKnownKeys,
  type EpochMs,
  ErrorCode,
  InputError,
  isoDateToEpochMs,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';

/** One reported fundamental period, point-in-time aware (FC0 — frozen). */
export interface FundamentalPeriod {
  /** Strict `YYYY-MM-DD` calendar date; optional because some sources report only period ends. */
  periodStartDate?: string;
  /** Strict `YYYY-MM-DD` calendar date the period ends on. */
  periodEndDate: string;
  fiscalYear: number;
  fiscalQuarter?: 1 | 2 | 3 | 4;
  periodType: 'quarter' | 'year' | 'trailing-twelve-months';
  /** When the filing was made, when known. */
  filedTimestampMs?: EpochMs;
  /**
   * When the data became AVAILABLE to an observer — the point-in-time eligibility instant. A
   * backtest or event study must not see this period before this time; `periodEndDate` never
   * controls eligibility.
   */
  availableTimestampMs: EpochMs;
  /** ISO 4217 currency of the monetary figures. */
  currency: string;
  /** Monetary figures are reported in units of this scale. */
  monetaryScale: 1 | 1_000 | 1_000_000;
  /** Source form (e.g. `10-Q`), when known. */
  form?: string;
  /** Source accession identifier, when known. */
  accession?: string;
  /** When this record restates an earlier one, the accession (or identifier) it restates. */
  restatementOf?: string;
}

/** {@link FundamentalPeriod} keys (Law 12 — mirrors the interface above; keep in sync). */
const FUNDAMENTAL_PERIOD_KEYS = [
  'periodStartDate',
  'periodEndDate',
  'fiscalYear',
  'fiscalQuarter',
  'periodType',
  'filedTimestampMs',
  'availableTimestampMs',
  'currency',
  'monetaryScale',
  'form',
  'accession',
  'restatementOf',
] as const;

const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shape via the regex, then the REAL calendar: `2025-02-30` must teach, never normalize. */
const isCalendarDate = (value: string): boolean => {
  try {
    isoDateToEpochMs(value);
    return true;
  } catch {
    return false;
  }
};

/** A complete period literal — the shared guard DERIVES each example from the reported name. */
const EXAMPLE_PERIOD =
  "{ periodEndDate: '2026-03-31', fiscalYear: 2026, fiscalQuarter: 1, periodType: 'quarter', availableTimestampMs: 1746057600000, currency: 'USD', monetaryScale: 1_000_000 }";
const exampleFor = (functionName: string): string => `${functionName}(${EXAMPLE_PERIOD})`;

/**
 * Validate a {@link FundamentalPeriod} at a public boundary (Law 12 closed request): presence,
 * types, the strict date grammar, the literal domains, and the ordering facts a period must obey.
 */
export function requireFundamentalPeriod(
  functionName: string,
  period: FundamentalPeriod,
): asserts period is FundamentalPeriod {
  // The guard's own label is part of its contract: invoked without one, every error it teaches
  // would blame "undefined".
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new InputError(
      `requireFundamentalPeriod: functionName must be a non-empty string (the public boundary being validated). Received ${functionName === null ? 'null' : functionName === undefined ? 'undefined' : typeof functionName}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'functionName' } },
    );
  }
  requireArgumentObject(functionName, 'period', period);
  ensureKnownKeys(functionName, 'period', period, FUNDAMENTAL_PERIOD_KEYS);
  requireFiniteFields(
    functionName,
    period as unknown as Record<string, unknown>,
    ['fiscalYear', 'availableTimestampMs', 'monetaryScale'],
    { exampleCall: () => exampleFor(functionName) },
  );
  for (const dateField of ['periodStartDate', 'periodEndDate'] as const) {
    const value = period[dateField];
    if (dateField === 'periodEndDate' && value === undefined) {
      throw new InputError(
        `${functionName}: periodEndDate is required.\n  e.g. ${exampleFor(functionName)}`,
        {
          code: ErrorCode.InputMissingField,
          context: { field: 'periodEndDate' },
        },
      );
    }
    if (
      value !== undefined &&
      (typeof value !== 'string' || !STRICT_DATE.test(value) || !isCalendarDate(value))
    ) {
      throw new InputError(
        `${functionName}: ${dateField} must be a strict YYYY-MM-DD calendar date. Received ${value === null ? 'null' : JSON.stringify(value)}.`,
        { code: ErrorCode.InputWrongType, context: { field: dateField } },
      );
    }
  }
  if (
    period.periodType !== 'quarter' &&
    period.periodType !== 'year' &&
    period.periodType !== 'trailing-twelve-months'
  ) {
    throw new InputError(
      `${functionName}: periodType must be 'quarter' | 'year' | 'trailing-twelve-months'. Received ${period.periodType === null ? 'null' : JSON.stringify(period.periodType)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'periodType' } },
    );
  }
  if (
    period.fiscalQuarter !== undefined &&
    period.fiscalQuarter !== 1 &&
    period.fiscalQuarter !== 2 &&
    period.fiscalQuarter !== 3 &&
    period.fiscalQuarter !== 4
  ) {
    throw new InputError(
      `${functionName}: fiscalQuarter must be 1 | 2 | 3 | 4 when provided. Received ${period.fiscalQuarter === null ? 'null' : JSON.stringify(period.fiscalQuarter)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'fiscalQuarter' } },
    );
  }
  if (
    period.monetaryScale !== 1 &&
    period.monetaryScale !== 1_000 &&
    period.monetaryScale !== 1_000_000
  ) {
    throw new InputError(
      `${functionName}: monetaryScale must be 1 | 1000 | 1000000. Received ${JSON.stringify(period.monetaryScale)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'monetaryScale' } },
    );
  }
  if (typeof period.currency !== 'string' || period.currency.length === 0) {
    throw new InputError(
      `${functionName}: currency must be a non-empty ISO 4217 code. Received ${period.currency === null ? 'null' : typeof period.currency}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'currency' } },
    );
  }
  for (const provenanceField of ['form', 'accession', 'restatementOf'] as const) {
    const value = period[provenanceField];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new InputError(
        `${functionName}: ${provenanceField} must be a non-empty string when provided. Received ${value === null ? 'null' : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: provenanceField } },
      );
    }
  }
  if (
    period.filedTimestampMs !== undefined &&
    (typeof period.filedTimestampMs !== 'number' || !Number.isFinite(period.filedTimestampMs))
  ) {
    throw new InputError(
      `${functionName}: filedTimestampMs must be a finite epoch-ms number when provided. Received ${period.filedTimestampMs === null ? 'null' : typeof period.filedTimestampMs}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'filedTimestampMs' } },
    );
  }
}

/**
 * Point-in-time eligibility: whether `period` was AVAILABLE to an observer at `asOf` (epoch ms).
 * `availableTimestampMs`, not `periodEndDate`, controls eligibility — a restatement is a NEW
 * version with its own availability and provenance, so a backtest never sees it early.
 */
export function isPeriodAvailableAt(period: FundamentalPeriod, asOf: EpochMs): boolean {
  requireFundamentalPeriod('isPeriodAvailableAt', period);
  if (typeof asOf !== 'number' || !Number.isFinite(asOf)) {
    throw new InputError(
      `isPeriodAvailableAt: asOf must be a finite epoch-ms number. Received ${asOf === null ? 'null' : typeof asOf}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'asOf' } },
    );
  }
  return period.availableTimestampMs <= asOf;
}
