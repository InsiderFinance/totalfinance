/**
 * FC3 — the point-in-time observation contracts research computes over. An observation is a row
 * of DECLARED features for one instrument at one availability instant; the declarations make the
 * open feature record checkable (every observation is validated against them, so an unknown field
 * or a unit-incompatible comparison is a teaching error, not a silent skip). The engine never
 * fetches or computes hidden fields — technical, fundamental, valuation, liquidity, options, and
 * caller-defined features are all ordinary declared fields.
 */

import {
  ensureKnownKeys,
  type EpochMs,
  ErrorCode,
  InputError,
  isoDateToEpochMs,
  requireArgumentObject,
} from '@totalfinance/core';

/**
 * The guard's own label is part of its contract: invoked without one, every error it teaches
 * would blame "undefined". Shared by every vendor-adapter guard in this package.
 */
export function requireBoundaryName(functionName: string): void {
  if (typeof functionName !== 'string' || functionName.length === 0) {
    throw new InputError(
      `requireBoundaryName: functionName must be a non-empty string (the public boundary being validated). Received ${functionName === null ? 'null' : functionName === undefined ? 'undefined' : typeof functionName}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'functionName' } },
    );
  }
}

/** A guard's PATH label (which field it is validating) is part of its contract too. */
export function requirePathLabel(functionName: string, parameterName: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InputError(
      `${functionName}: ${parameterName} must be a non-empty string (the field path the error will name). Received ${value === null ? 'null' : value === undefined ? 'undefined' : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { field: parameterName } },
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------------------------------

/** What kind of value a declared field carries. */
export type FieldKind = 'numeric' | 'category' | 'text' | 'boolean';

/** One declared feature: research fields are DECLARED, never guessed from the data. */
export interface FieldDefinition {
  fieldName: string;
  kind: FieldKind;
  /** The unit of a numeric field (e.g. 'decimal ratio', 'USD', 'days') — recorded and compared. */
  unit?: string;
  description?: string;
}

const FIELD_DEFINITION_KEYS = ['fieldName', 'kind', 'unit', 'description'] as const;

/** One observed value: a declared field's value, or `null` where the source had none. */
export type ObservedValue = number | string | boolean | null;

/**
 * One universe row: an instrument's declared features as of an availability instant.
 * `availableTimestampMs` controls point-in-time eligibility — the same law the fundamentals
 * package states for filings: what an observer could not yet see does not exist for them.
 */
export interface UniverseObservation {
  instrumentId: string;
  availableTimestampMs: EpochMs;
  /** Values for DECLARED fields only; a key with no declaration is a teaching error. */
  fields: Record<string, ObservedValue>;
}

const OBSERVATION_KEYS = ['instrumentId', 'availableTimestampMs', 'fields'] as const;

// ---------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------

/** Validate the field-definition list and return them keyed by name. */
export function requireFieldDefinitions(
  functionName: string,
  fieldDefinitions: readonly FieldDefinition[],
): Map<string, FieldDefinition> {
  requireBoundaryName(functionName);
  if (!Array.isArray(fieldDefinitions) || fieldDefinitions.length === 0) {
    throw new InputError(
      `${functionName}: fieldDefinitions must be a non-empty array — research fields are declared, never inferred from the data.\n  e.g. ${functionName}({ ..., fieldDefinitions: [{ fieldName: 'freeCashFlowYield', kind: 'numeric', unit: 'decimal ratio' }] })`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'fieldDefinitions' } },
    );
  }
  const byName = new Map<string, FieldDefinition>();
  fieldDefinitions.forEach((definition, index) => {
    const path = `fieldDefinitions[${index}]`;
    requireArgumentObject(functionName, path, definition);
    ensureKnownKeys(functionName, path, definition, FIELD_DEFINITION_KEYS);
    if (typeof definition.fieldName !== 'string' || definition.fieldName.length === 0) {
      throw new InputError(`${functionName}: ${path}.fieldName must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.fieldName` },
      });
    }
    if (
      definition.kind !== 'numeric' &&
      definition.kind !== 'category' &&
      definition.kind !== 'text' &&
      definition.kind !== 'boolean'
    ) {
      throw new InputError(
        `${functionName}: ${path}.kind must be 'numeric' | 'category' | 'text' | 'boolean'. Received ${definition.kind === null ? 'null' : JSON.stringify(definition.kind)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: `${path}.kind` } },
      );
    }
    for (const optional of ['unit', 'description'] as const) {
      const value = definition[optional];
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
        throw new InputError(
          `${functionName}: ${path}.${optional} must be a non-empty string when provided. Received ${value === null ? 'null' : typeof value}.`,
          { code: ErrorCode.InputWrongType, context: { field: `${path}.${optional}` } },
        );
      }
    }
    if (byName.has(definition.fieldName)) {
      throw new InputError(
        `${functionName}: ${path} redeclares field '${definition.fieldName}' — one declaration per field.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.fieldName` } },
      );
    }
    byName.set(definition.fieldName, definition);
  });
  return byName;
}

/** The definitions Map every declaration-aware guard consumes — typed, never assumed. */
export function requireDefinitionsMap(
  functionName: string,
  definitions: Map<string, FieldDefinition>,
): void {
  requireBoundaryName(functionName);
  if (!(definitions instanceof Map)) {
    throw new InputError(
      `${functionName}: definitions must be the Map produced by requireFieldDefinitions(...). Received ${definitions === null ? 'null' : typeof definitions}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'definitions' } },
    );
  }
}

/** Does an observed value match its declared kind? `null` is "declared but missing" everywhere. */
function valueMatchesKind(value: ObservedValue, kind: FieldKind): boolean {
  if (value === null) return true;
  if (kind === 'numeric') return typeof value === 'number' && Number.isFinite(value);
  if (kind === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string';
}

/**
 * Validate one observation against the declarations: closed keys at the row level, every field
 * key DECLARED, and every value matching its declared kind. `null` means "the source had no
 * value" and is legal for any declared field — the missing-value policy decides what happens
 * next, never the validator.
 */
export function requireUniverseObservation(
  functionName: string,
  path: string,
  observation: UniverseObservation,
  definitions: Map<string, FieldDefinition>,
): void {
  requireBoundaryName(functionName);
  requirePathLabel(functionName, 'path', path);
  requireDefinitionsMap(functionName, definitions);
  requireArgumentObject(functionName, path, observation);
  ensureKnownKeys(functionName, path, observation, OBSERVATION_KEYS);
  if (typeof observation.instrumentId !== 'string' || observation.instrumentId.length === 0) {
    throw new InputError(`${functionName}: ${path}.instrumentId must be a non-empty string.`, {
      code: ErrorCode.InputWrongType,
      context: { field: `${path}.instrumentId` },
    });
  }
  if (
    typeof observation.availableTimestampMs !== 'number' ||
    !Number.isFinite(observation.availableTimestampMs)
  ) {
    throw new InputError(
      `${functionName}: ${path}.availableTimestampMs must be a finite epoch-ms number — availability, not convenience, decides what a point-in-time screen can see. Received ${observation.availableTimestampMs === null ? 'null' : typeof observation.availableTimestampMs}.`,
      { code: ErrorCode.InputWrongType, context: { field: `${path}.availableTimestampMs` } },
    );
  }
  requireArgumentObject(functionName, `${path}.fields`, observation.fields);
  for (const [fieldName, value] of Object.entries(observation.fields)) {
    const definition = definitions.get(fieldName);
    if (definition === undefined) {
      const declared = [...definitions.keys()];
      const shown = declared.slice(0, 6).join(', ') + (declared.length > 6 ? ', …' : '');
      throw new InputError(
        `${functionName}: ${path}.fields carries undeclared field '${fieldName}'. Declared fields: ${shown}. Declare it in fieldDefinitions or remove it — hidden features are how two screens silently disagree.`,
        { code: ErrorCode.InputUnknownField, context: { field: `${path}.fields.${fieldName}` } },
      );
    }
    if (!valueMatchesKind(value, definition.kind)) {
      throw new InputError(
        `${functionName}: ${path}.fields.${fieldName} must be ${definition.kind === 'numeric' ? 'a finite number' : definition.kind === 'boolean' ? 'a boolean' : 'a string'} or null (declared '${definition.kind}'). Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.fields.${fieldName}` } },
      );
    }
  }
}

/** Validate a whole observation array, naming the failing row. */
export function requireUniverseObservations(
  functionName: string,
  observations: readonly UniverseObservation[],
  definitions: Map<string, FieldDefinition>,
): void {
  requireBoundaryName(functionName);
  requireDefinitionsMap(functionName, definitions);
  if (!Array.isArray(observations)) {
    throw new InputError(
      `${functionName}: observations must be an array of universe rows. Received ${observations === null ? 'null' : typeof observations}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'observations' } },
    );
  }
  observations.forEach((observation, index) =>
    requireUniverseObservation(functionName, `observations[${index}]`, observation, definitions),
  );
}

// ---------------------------------------------------------------------------------------------------
// Market events (spec-frozen contract) and return observations
// ---------------------------------------------------------------------------------------------------

/** One market event (FC3 frozen contract) — announcement time is the information instant. */
export interface MarketEvent {
  eventId: string;
  instrumentId: string;
  /** A caller vocabulary ('earnings', 'guidance', …) — recorded, never interpreted. */
  eventType: string;
  announcedTimestampMs: EpochMs;
  /** When the event takes economic effect, where that differs from the announcement. */
  effectiveTimestampMs?: EpochMs;
  /** Source-specific extras, preserved verbatim and never consumed by compute functions. */
  metadata?: Record<string, unknown>;
}

const MARKET_EVENT_KEYS = [
  'eventId',
  'instrumentId',
  'eventType',
  'announcedTimestampMs',
  'effectiveTimestampMs',
  'metadata',
] as const;

/** Validate one {@link MarketEvent} at a public boundary. */
export function requireMarketEvent(functionName: string, path: string, event: MarketEvent): void {
  requireBoundaryName(functionName);
  requirePathLabel(functionName, 'path', path);
  requireArgumentObject(functionName, path, event);
  ensureKnownKeys(functionName, path, event, MARKET_EVENT_KEYS);
  for (const field of ['eventId', 'instrumentId', 'eventType'] as const) {
    if (typeof event[field] !== 'string' || event[field].length === 0) {
      throw new InputError(`${functionName}: ${path}.${field} must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.${field}` },
      });
    }
  }
  if (
    typeof event.announcedTimestampMs !== 'number' ||
    !Number.isFinite(event.announcedTimestampMs)
  ) {
    throw new InputError(
      `${functionName}: ${path}.announcedTimestampMs must be a finite epoch-ms number — the announcement instant is when the information exists. Received ${event.announcedTimestampMs === null ? 'null' : typeof event.announcedTimestampMs}.`,
      { code: ErrorCode.InputWrongType, context: { field: `${path}.announcedTimestampMs` } },
    );
  }
  if (
    event.effectiveTimestampMs !== undefined &&
    (typeof event.effectiveTimestampMs !== 'number' || !Number.isFinite(event.effectiveTimestampMs))
  ) {
    throw new InputError(
      `${functionName}: ${path}.effectiveTimestampMs must be a finite epoch-ms number when provided. Received ${event.effectiveTimestampMs === null ? 'null' : typeof event.effectiveTimestampMs}.`,
      { code: ErrorCode.InputWrongType, context: { field: `${path}.effectiveTimestampMs` } },
    );
  }
  if (
    event.metadata !== undefined &&
    (typeof event.metadata !== 'object' || event.metadata === null || Array.isArray(event.metadata))
  ) {
    throw new InputError(
      `${functionName}: ${path}.metadata must be a plain object when provided. Received ${event.metadata === null ? 'null' : Array.isArray(event.metadata) ? 'an array' : typeof event.metadata}.`,
      { code: ErrorCode.InputWrongType, context: { field: `${path}.metadata` } },
    );
  }
}

/** One per-session simple return for one instrument — the event-study raw material. */
export interface ReturnObservation {
  instrumentId: string;
  /** Strict `YYYY-MM-DD` trading-session date. */
  tradingSessionDate: string;
  /** Simple (arithmetic) return over the session, as a decimal. */
  simpleReturn: number;
}

const RETURN_OBSERVATION_KEYS = ['instrumentId', 'tradingSessionDate', 'simpleReturn'] as const;
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

/** Validate a return-observation array, naming the failing row. */
export function requireReturnObservations(
  functionName: string,
  label: string,
  observations: readonly ReturnObservation[],
): void {
  requireBoundaryName(functionName);
  requirePathLabel(functionName, 'label', label);
  if (!Array.isArray(observations) || observations.length === 0) {
    throw new InputError(
      `${functionName}: ${label} must be a non-empty array of { instrumentId, tradingSessionDate, simpleReturn } rows.`,
      { code: ErrorCode.InputOutOfRange, context: { field: label } },
    );
  }
  observations.forEach((row, index) => {
    const path = `${label}[${index}]`;
    requireArgumentObject(functionName, path, row);
    ensureKnownKeys(functionName, path, row, RETURN_OBSERVATION_KEYS);
    if (typeof row.instrumentId !== 'string' || row.instrumentId.length === 0) {
      throw new InputError(`${functionName}: ${path}.instrumentId must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.instrumentId` },
      });
    }
    if (
      typeof row.tradingSessionDate !== 'string' ||
      !STRICT_DATE.test(row.tradingSessionDate) ||
      !isCalendarDate(row.tradingSessionDate)
    ) {
      throw new InputError(
        `${functionName}: ${path}.tradingSessionDate must be a strict YYYY-MM-DD calendar date. Received ${row.tradingSessionDate === null ? 'null' : JSON.stringify(row.tradingSessionDate)}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.tradingSessionDate` } },
      );
    }
    if (typeof row.simpleReturn !== 'number' || !Number.isFinite(row.simpleReturn)) {
      throw new InputError(
        `${functionName}: ${path}.simpleReturn must be a finite decimal return. Received ${row.simpleReturn === null ? 'null' : typeof row.simpleReturn === 'number' ? String(row.simpleReturn) : typeof row.simpleReturn}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.simpleReturn` } },
      );
    }
  });
}
