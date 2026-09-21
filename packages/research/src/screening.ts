/**
 * FC3 — universe screening. The filter grammar is a CLOSED recursive union over declared fields
 * and operators: logical groups, comparisons, ranges, membership, and presence. It does not parse
 * source text, fetch data, or invent fields; an unknown field, unknown operator, or
 * unit-incompatible comparison is a teaching error. The one escape hatch — a caller predicate —
 * is explicit and classified non-serializable in the result's assumptions.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  type EpochMs,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import {
  type FieldDefinition,
  type ObservedValue,
  type UniverseObservation,
  requireBoundaryName,
  requireDefinitionsMap,
  requirePathLabel,
  requireFieldDefinitions,
  requireUniverseObservations,
} from './observations.js';
import { resolveLatestAvailableObservations } from './point-in-time.js';

export * from './universe.js';

// ---------------------------------------------------------------------------------------------------
// The filter grammar
// ---------------------------------------------------------------------------------------------------

/** Numeric ordering comparisons over one declared field. */
export type OrderingComparisonOperator =
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual';

/** Equality comparisons; runtime field declarations decide which value kind is compatible. */
export type IdentityComparisonOperator = 'equals' | 'notEquals';

/** Every comparison operator, retained as the convenient public vocabulary union. */
export type ComparisonOperator = OrderingComparisonOperator | IdentityComparisonOperator;

/** The closed, serializable filter grammar. */
export type ScreenFilter =
  | { all: readonly ScreenFilter[] }
  | { any: readonly ScreenFilter[] }
  | { not: ScreenFilter }
  | { field: string; operator: OrderingComparisonOperator; value: number }
  | { field: string; operator: IdentityComparisonOperator; value: number | string | boolean }
  | { field: string; operator: 'between'; from: number; to: number }
  | { field: string; operator: 'in' | 'notIn'; values: readonly (number | string)[] }
  | { field: string; operator: 'isPresent' | 'isMissing' };

const ORDERING_OPERATORS = new Set([
  'greaterThan',
  'greaterThanOrEqual',
  'lessThan',
  'lessThanOrEqual',
]);
const IDENTITY_OPERATORS = new Set(['equals', 'notEquals']);

/**
 * Validate a filter tree against the declarations: every field declared, every operator known,
 * every comparison kind-compatible (an ordering comparison of a category field is the classic
 * unit-incompatibility, and it teaches instead of silently failing every row).
 */
export function requireScreenFilter(
  functionName: string,
  path: string,
  filter: ScreenFilter,
  definitions: Map<string, FieldDefinition>,
): void {
  requireBoundaryName(functionName);
  requirePathLabel(functionName, 'path', path);
  requireDefinitionsMap(functionName, definitions);
  requireArgumentObject(functionName, path, filter);
  const node = filter as Record<string, unknown>;
  if ('all' in node || 'any' in node) {
    const key = 'all' in node ? 'all' : 'any';
    ensureKnownKeys(functionName, path, filter, [key]);
    const children = node[key];
    if (!Array.isArray(children) || children.length === 0) {
      throw new InputError(
        `${functionName}: ${path}.${key} must be a non-empty array of filters.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.${key}` } },
      );
    }
    children.forEach((child, index) =>
      requireScreenFilter(
        functionName,
        `${path}.${key}[${index}]`,
        child as ScreenFilter,
        definitions,
      ),
    );
    return;
  }
  if ('not' in node) {
    ensureKnownKeys(functionName, path, filter, ['not']);
    requireScreenFilter(functionName, `${path}.not`, node['not'] as ScreenFilter, definitions);
    return;
  }
  const fieldName = node['field'];
  const operator = node['operator'];
  if (typeof fieldName !== 'string' || typeof operator !== 'string') {
    throw new InputError(
      `${functionName}: ${path} must be a group ({ all } | { any } | { not }) or a condition ({ field, operator, … }). Received keys [${Object.keys(node).join(', ')}].`,
      { code: ErrorCode.InputWrongShape, context: { field: path } },
    );
  }
  const definition = definitions.get(fieldName);
  if (definition === undefined) {
    const declared = [...definitions.keys()].slice(0, 6).join(', ');
    throw new InputError(
      `${functionName}: ${path}.field '${fieldName}' is not declared. Declared fields: ${declared}${definitions.size > 6 ? ', …' : ''}.`,
      { code: ErrorCode.InputUnknownField, context: { field: `${path}.field` } },
    );
  }
  if (ORDERING_OPERATORS.has(operator)) {
    ensureKnownKeys(functionName, path, filter, ['field', 'operator', 'value']);
    if (definition.kind !== 'numeric') {
      throw new InputError(
        `${functionName}: ${path} applies ordering operator '${operator}' to '${fieldName}', a ${definition.kind} field — order is only defined for numeric fields${definition.unit !== undefined ? ` (declared unit: ${definition.unit})` : ''}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.operator` } },
      );
    }
    requireFiniteFields(functionName, node, ['value'], {
      exampleCall: `${functionName}({ ..., filter: { field: '${fieldName}', operator: '${operator}', value: 0.15 } })`,
    });
    return;
  }
  if (IDENTITY_OPERATORS.has(operator)) {
    ensureKnownKeys(functionName, path, filter, ['field', 'operator', 'value']);
    const value = node['value'];
    const compatible =
      (definition.kind === 'numeric' && typeof value === 'number' && Number.isFinite(value)) ||
      (definition.kind === 'boolean' && typeof value === 'boolean') ||
      ((definition.kind === 'category' || definition.kind === 'text') && typeof value === 'string');
    if (!compatible) {
      throw new InputError(
        `${functionName}: ${path}.value must match '${fieldName}''s declared kind '${definition.kind}'. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.value` } },
      );
    }
    return;
  }
  if (operator === 'between') {
    ensureKnownKeys(functionName, path, filter, ['field', 'operator', 'from', 'to']);
    if (definition.kind !== 'numeric') {
      throw new InputError(
        `${functionName}: ${path} applies 'between' to '${fieldName}', a ${definition.kind} field — ranges are only defined for numeric fields.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.operator` } },
      );
    }
    requireFiniteFields(functionName, node, ['from', 'to'], {
      exampleCall: `${functionName}({ ..., filter: { field: '${fieldName}', operator: 'between', from: 0, to: 1 } })`,
    });
    if ((node['from'] as number) > (node['to'] as number)) {
      throw new InputError(
        `${functionName}: ${path} requires from ≤ to. Received from ${node['from']}, to ${node['to']}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.from` } },
      );
    }
    return;
  }
  if (operator === 'in' || operator === 'notIn') {
    ensureKnownKeys(functionName, path, filter, ['field', 'operator', 'values']);
    if (definition.kind === 'boolean') {
      throw new InputError(
        `${functionName}: ${path} applies '${operator}' to '${fieldName}', a boolean field — use equals instead.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.operator` } },
      );
    }
    const values = node['values'];
    if (!Array.isArray(values) || values.length === 0) {
      throw new InputError(`${functionName}: ${path}.values must be a non-empty array.`, {
        code: ErrorCode.InputOutOfRange,
        context: { field: `${path}.values` },
      });
    }
    values.forEach((value, index) => {
      const compatible =
        definition.kind === 'numeric'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'string';
      if (!compatible) {
        throw new InputError(
          `${functionName}: ${path}.values[${index}] must match '${fieldName}''s declared kind '${definition.kind}'. Received ${value === null ? 'null' : typeof value}.`,
          { code: ErrorCode.InputWrongType, context: { field: `${path}.values[${index}]` } },
        );
      }
    });
    return;
  }
  if (operator === 'isPresent' || operator === 'isMissing') {
    ensureKnownKeys(functionName, path, filter, ['field', 'operator']);
    return;
  }
  throw new InputError(
    `${functionName}: ${path}.operator '${operator}' is not in the grammar — greaterThan | greaterThanOrEqual | lessThan | lessThanOrEqual | equals | notEquals | between | in | notIn | isPresent | isMissing.`,
    { code: ErrorCode.InputInvalidEnum, context: { field: `${path}.operator` } },
  );
}

/** Evaluate a validated filter. `null` (missing) makes any CONDITION on that field `'missing'`. */
function evaluateFilter(
  filter: ScreenFilter,
  fields: Record<string, ObservedValue>,
): true | false | 'missing' {
  const node = filter as Record<string, unknown>;
  if ('all' in node) {
    let sawMissing = false;
    for (const child of node['all'] as readonly ScreenFilter[]) {
      const verdict = evaluateFilter(child, fields);
      if (verdict === false) return false;
      if (verdict === 'missing') sawMissing = true;
    }
    return sawMissing ? 'missing' : true;
  }
  if ('any' in node) {
    let sawMissing = false;
    for (const child of node['any'] as readonly ScreenFilter[]) {
      const verdict = evaluateFilter(child, fields);
      if (verdict === true) return true;
      if (verdict === 'missing') sawMissing = true;
    }
    return sawMissing ? 'missing' : false;
  }
  if ('not' in node) {
    const verdict = evaluateFilter(node['not'] as ScreenFilter, fields);
    if (verdict === 'missing') return 'missing';
    return !verdict;
  }
  const fieldName = node['field'] as string;
  const operator = node['operator'] as string;
  const value = fieldName in fields ? fields[fieldName]! : null;
  if (operator === 'isPresent') return value !== null;
  if (operator === 'isMissing') return value === null;
  if (value === null) return 'missing';
  switch (operator) {
    case 'greaterThan':
      return (value as number) > (node['value'] as number);
    case 'greaterThanOrEqual':
      return (value as number) >= (node['value'] as number);
    case 'lessThan':
      return (value as number) < (node['value'] as number);
    case 'lessThanOrEqual':
      return (value as number) <= (node['value'] as number);
    case 'equals':
      return value === node['value'];
    case 'notEquals':
      return value !== node['value'];
    case 'between':
      return (
        (value as number) >= (node['from'] as number) && (value as number) <= (node['to'] as number)
      );
    case 'in':
      return (node['values'] as readonly ObservedValue[]).includes(value);
    case 'notIn':
      return !(node['values'] as readonly ObservedValue[]).includes(value);
    default:
      return false; // unreachable after validation
  }
}

// ---------------------------------------------------------------------------------------------------
// Shared eligibility resolution
// ---------------------------------------------------------------------------------------------------

/** How rows with a missing value at a consumed field are handled. `'exclude'` is the safe default. */
export type MissingValuePolicy = 'exclude' | 'evaluate-as-false';

interface EligibleRow {
  observation: UniverseObservation;
}

/**
 * Point-in-time eligibility and version resolution, shared by all three heads: rows available
 * AFTER `asOf` do not exist for the observer, and when several versions of one instrument are
 * visible the LATEST available wins (disclosed) — the same law the fundamentals selector states.
 */
function resolveEligible(
  observations: readonly UniverseObservation[],
  asOf: EpochMs,
  addExclusion: (reason: string) => void,
): EligibleRow[] {
  // ONE point-in-time law (Stage 4.6): the resolver lives in universe.ts so the simulators and the
  // three screening verbs cannot drift apart on availability or version resolution.
  return resolveLatestAvailableObservations(observations, asOf, addExclusion).map(
    (observation) => ({
      observation,
    }),
  );
}
// ---------------------------------------------------------------------------------------------------
// screenUniverse
// ---------------------------------------------------------------------------------------------------

/** One ordering key. */
export interface ScreenOrdering {
  field: string;
  direction: 'ascending' | 'descending';
}

/** Input for {@link screenUniverse}. */
export interface ScreenUniverseInput {
  /** The universe's identity, echoed — a screen without provenance is a number without a source. */
  universeId: string;
  asOf: EpochMs;
  observations: readonly UniverseObservation[];
  fieldDefinitions: readonly FieldDefinition[];
  /** The serializable filter. Omitted → every eligible row passes (ordering still applies). */
  filter?: ScreenFilter;
  /**
   * The explicit NON-SERIALIZABLE escape hatch: a caller predicate over the observation. Its
   * presence is classified in `assumptions.customPredicate` so a stored screen recipe cannot
   * silently claim reproducibility it does not have.
   */
  customPredicate?: (observation: UniverseObservation) => boolean;
  missingValuePolicy: MissingValuePolicy;
  /** Ordering keys; `instrumentId` ascending is ALWAYS appended as the stable final tie-breaker. */
  orderBy: readonly ScreenOrdering[];
  /** Keep at most this many rows after ordering; a non-negative safe integer. Omit for all rows. */
  limit?: number;
}

/** One screened row. */
export interface ScreenedRow {
  instrumentId: string;
  availableTimestampMs: EpochMs;
  fields: Record<string, ObservedValue>;
}

/** Result of {@link screenUniverse}. */
export interface ScreenUniverseResult {
  assumptions: {
    universeId: string;
    asOf: EpochMs;
    missingValuePolicy: MissingValuePolicy;
    orderBy: readonly ScreenOrdering[];
    /** The stable final ordering key, always applied — determinism under input permutation. */
    finalTieBreaker: 'instrumentId ascending';
    limit?: number;
    /** Present exactly when a caller predicate participated. */
    customPredicate?: 'non-serializable caller predicate';
    versionResolution: 'latest available at or before asOf per instrument';
  };
  diagnostics: {
    warnings: string[];
    suppliedCount: number;
    eligibleCount: number;
    includedCount: number;
    excludedCount: number;
    /** Every exclusion, tallied by reason. */
    exclusionReasons: Record<string, number>;
  };
  rows: ScreenedRow[];
}

const SCREEN_KEYS = [
  'universeId',
  'asOf',
  'observations',
  'fieldDefinitions',
  'filter',
  'customPredicate',
  'missingValuePolicy',
  'orderBy',
  'limit',
] as const;

function requireOrdering(
  functionName: string,
  orderBy: readonly ScreenOrdering[],
  definitions: Map<string, FieldDefinition>,
): void {
  if (!Array.isArray(orderBy)) {
    throw new InputError(
      `${functionName}: orderBy must be an array of { field, direction } keys (possibly empty).`,
      { code: ErrorCode.InputWrongType, context: { field: 'orderBy' } },
    );
  }
  orderBy.forEach((key, index) => {
    const path = `orderBy[${index}]`;
    requireArgumentObject(functionName, path, key);
    ensureKnownKeys(functionName, path, key, ['field', 'direction']);
    const definition = definitions.get(key.field);
    if (definition === undefined) {
      throw new InputError(`${functionName}: ${path}.field '${key.field}' is not declared.`, {
        code: ErrorCode.InputUnknownField,
        context: { field: `${path}.field` },
      });
    }
    if (definition.kind === 'boolean') {
      throw new InputError(
        `${functionName}: ${path} orders by '${key.field}', a boolean field — a two-value ordering is a filter wearing a sort.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.field` } },
      );
    }
    if (key.direction !== 'ascending' && key.direction !== 'descending') {
      throw new InputError(
        `${functionName}: ${path}.direction must be 'ascending' | 'descending'. Received ${key.direction === null ? 'null' : JSON.stringify(key.direction)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: `${path}.direction` } },
      );
    }
  });
}

/**
 * A point-in-time screen: eligibility, version resolution, filter, ordering with the always-on
 * stable tie-breaker, and the honest exclusion ledger. Deterministic under input permutation by
 * construction.
 */
export function screenUniverse(input: ScreenUniverseInput): ScreenUniverseResult {
  requireArgumentObject('screenUniverse', 'input', input);
  ensureKnownKeys('screenUniverse', 'input', input, SCREEN_KEYS);
  if (typeof input.universeId !== 'string' || input.universeId.length === 0) {
    throw new InputError(`screenUniverse: universeId must be a non-empty string.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'universeId' },
    });
  }
  requireFiniteFields('screenUniverse', input as unknown as Record<string, unknown>, ['asOf'], {
    exampleCall:
      "screenUniverse({ universeId: 'us-large-cap@2026-08-12', asOf: Date.UTC(2026, 7, 12), observations, fieldDefinitions, missingValuePolicy: 'exclude', orderBy: [{ field: 'freeCashFlowYield', direction: 'descending' }] })",
  });
  const definitions = requireFieldDefinitions('screenUniverse', input.fieldDefinitions);
  requireUniverseObservations('screenUniverse', input.observations, definitions);
  if (input.filter !== undefined) {
    requireScreenFilter('screenUniverse', 'filter', input.filter, definitions);
  }
  if (input.customPredicate !== undefined && typeof input.customPredicate !== 'function') {
    throw new InputError(
      `screenUniverse: customPredicate must be a function when provided — it is the explicit non-serializable escape hatch. Received ${input.customPredicate === null ? 'null' : typeof input.customPredicate}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'customPredicate' } },
    );
  }
  if (input.missingValuePolicy !== 'exclude' && input.missingValuePolicy !== 'evaluate-as-false') {
    throw new InputError(
      `screenUniverse: missingValuePolicy must be 'exclude' (the safe default — a row is dropped WITH a reason when the filter touches a missing value) | 'evaluate-as-false'. No financial value is ever imputed. Received ${input.missingValuePolicy === null ? 'null' : JSON.stringify(input.missingValuePolicy)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'missingValuePolicy' } },
    );
  }
  requireOrdering('screenUniverse', input.orderBy, definitions);
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) || (input.limit as number) < 0)
  ) {
    throw new InputError(
      `screenUniverse: limit must be a non-negative safe integer when provided; omit it to return every match. Received ${input.limit === null ? 'null' : String(input.limit)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { field: 'limit', limit: input.limit },
      },
    );
  }

  const exclusionReasons: Record<string, number> = {};
  const addExclusion = (reason: string): void => {
    exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
  };
  const eligible = resolveEligible(input.observations, input.asOf, addExclusion);

  const passed: UniverseObservation[] = [];
  for (const { observation } of eligible) {
    let verdict: true | false | 'missing' = true;
    if (input.filter !== undefined) {
      verdict = evaluateFilter(input.filter, observation.fields);
    }
    if (verdict === 'missing') {
      if (input.missingValuePolicy === 'exclude') {
        addExclusion('missing-value-at-filtered-field');
        continue;
      }
      verdict = false;
    }
    if (verdict === false) {
      addExclusion('filtered-out');
      continue;
    }
    if (input.customPredicate !== undefined && !input.customPredicate(observation)) {
      addExclusion('custom-predicate');
      continue;
    }
    // A row missing an ORDERING field cannot be placed honestly.
    const missingOrderField = input.orderBy.find(
      (key) => (observation.fields[key.field] ?? null) === null,
    );
    if (missingOrderField !== undefined) {
      // Under EITHER policy an unplaceable row is excluded — there is no honest position in an
      // ordering for a value that does not exist — and the reason is recorded.
      addExclusion('missing-value-at-ordering-field');
      continue;
    }
    passed.push(observation);
  }

  const compare = (a: UniverseObservation, b: UniverseObservation): number => {
    for (const key of input.orderBy) {
      const left = a.fields[key.field] as number | string;
      const right = b.fields[key.field] as number | string;
      if (left === right) continue;
      const ordered = left < right ? -1 : 1;
      return key.direction === 'ascending' ? ordered : -ordered;
    }
    return a.instrumentId < b.instrumentId ? -1 : 1;
  };
  passed.sort(compare);
  const limited = input.limit !== undefined ? passed.slice(0, input.limit) : passed;
  if (input.limit !== undefined && passed.length > input.limit) {
    exclusionReasons['beyond-limit'] = passed.length - input.limit;
  }

  const excludedCount = Object.values(exclusionReasons).reduce((total, count) => total + count, 0);
  return {
    assumptions: {
      universeId: input.universeId,
      asOf: input.asOf,
      missingValuePolicy: input.missingValuePolicy,
      orderBy: input.orderBy,
      finalTieBreaker: 'instrumentId ascending',
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.customPredicate !== undefined
        ? { customPredicate: 'non-serializable caller predicate' as const }
        : {}),
      versionResolution: 'latest available at or before asOf per instrument',
    },
    diagnostics: {
      warnings:
        input.customPredicate !== undefined
          ? [
              'a non-serializable caller predicate participated — this screen is not reproducible from its serialized form',
            ]
          : [],
      suppliedCount: input.observations.length,
      eligibleCount: eligible.length,
      includedCount: limited.length,
      excludedCount,
      exclusionReasons,
    },
    rows: limited.map(({ instrumentId, availableTimestampMs, fields }) => ({
      instrumentId,
      availableTimestampMs,
      fields,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------
// rankUniverse
// ---------------------------------------------------------------------------------------------------

/** How tied values rank. Every policy is stable (ties enumerate by instrumentId ascending). */
export type RankTiePolicy = 'competition' | 'dense' | 'ordinal';

/** Input for {@link rankUniverse}. */
export interface RankUniverseInput {
  universeId: string;
  asOf: EpochMs;
  observations: readonly UniverseObservation[];
  fieldDefinitions: readonly FieldDefinition[];
  rankBy: { field: string; direction: 'ascending' | 'descending' };
  tiePolicy: RankTiePolicy;
  missingValuePolicy: MissingValuePolicy;
}

/** Result of {@link rankUniverse}. */
export interface RankUniverseResult {
  assumptions: {
    universeId: string;
    asOf: EpochMs;
    rankBy: { field: string; direction: 'ascending' | 'descending' };
    tiePolicy: RankTiePolicy;
    missingValuePolicy: MissingValuePolicy;
    finalTieBreaker: 'instrumentId ascending';
    versionResolution: 'latest available at or before asOf per instrument';
  };
  diagnostics: {
    warnings: string[];
    suppliedCount: number;
    eligibleCount: number;
    rankedCount: number;
    excludedCount: number;
    exclusionReasons: Record<string, number>;
  };
  rows: Array<{ instrumentId: string; value: number; rank: number }>;
}

/** Rank one declared numeric field across the point-in-time universe. */
export function rankUniverse(input: RankUniverseInput): RankUniverseResult {
  requireArgumentObject('rankUniverse', 'input', input);
  ensureKnownKeys('rankUniverse', 'input', input, [
    'universeId',
    'asOf',
    'observations',
    'fieldDefinitions',
    'rankBy',
    'tiePolicy',
    'missingValuePolicy',
  ]);
  if (typeof input.universeId !== 'string' || input.universeId.length === 0) {
    throw new InputError(`rankUniverse: universeId must be a non-empty string.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'universeId' },
    });
  }
  requireFiniteFields('rankUniverse', input as unknown as Record<string, unknown>, ['asOf'], {
    exampleCall:
      "rankUniverse({ universeId: 'u', asOf: Date.UTC(2026, 7, 12), observations, fieldDefinitions, rankBy: { field: 'momentum', direction: 'descending' }, tiePolicy: 'competition', missingValuePolicy: 'exclude' })",
  });
  const definitions = requireFieldDefinitions('rankUniverse', input.fieldDefinitions);
  requireUniverseObservations('rankUniverse', input.observations, definitions);
  requireArgumentObject('rankUniverse', 'rankBy', input.rankBy);
  ensureKnownKeys('rankUniverse', 'rankBy', input.rankBy, ['field', 'direction']);
  const definition = definitions.get(input.rankBy.field);
  if (definition === undefined || definition.kind !== 'numeric') {
    throw new InputError(
      `rankUniverse: rankBy.field '${input.rankBy.field}' must be a DECLARED numeric field${definition !== undefined ? ` (declared '${definition.kind}')` : ''}.`,
      {
        code: definition === undefined ? ErrorCode.InputUnknownField : ErrorCode.InputOutOfRange,
        context: { field: 'rankBy.field' },
      },
    );
  }
  if (input.rankBy.direction !== 'ascending' && input.rankBy.direction !== 'descending') {
    throw new InputError(
      `rankUniverse: rankBy.direction must be 'ascending' | 'descending'. Received ${JSON.stringify(input.rankBy.direction)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'rankBy.direction' } },
    );
  }
  if (
    input.tiePolicy !== 'competition' &&
    input.tiePolicy !== 'dense' &&
    input.tiePolicy !== 'ordinal'
  ) {
    throw new InputError(
      `rankUniverse: tiePolicy must be 'competition' | 'dense' | 'ordinal' — how ties rank is a decision, not a default. Received ${input.tiePolicy === null ? 'null' : JSON.stringify(input.tiePolicy)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'tiePolicy' } },
    );
  }
  if (input.missingValuePolicy !== 'exclude' && input.missingValuePolicy !== 'evaluate-as-false') {
    throw new InputError(
      `rankUniverse: missingValuePolicy must be 'exclude' | 'evaluate-as-false' (either way a row with no value cannot be ranked; the policy is echoed). Received ${JSON.stringify(input.missingValuePolicy)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'missingValuePolicy' } },
    );
  }

  const exclusionReasons: Record<string, number> = {};
  const addExclusion = (reason: string): void => {
    exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
  };
  const eligible = resolveEligible(input.observations, input.asOf, addExclusion);
  const valued: Array<{ instrumentId: string; value: number }> = [];
  for (const { observation } of eligible) {
    const value = observation.fields[input.rankBy.field] ?? null;
    if (value === null) {
      addExclusion('missing-value-at-rank-field');
      continue;
    }
    valued.push({ instrumentId: observation.instrumentId, value: value as number });
  }
  valued.sort((a, b) => {
    if (a.value !== b.value) {
      const ordered = a.value < b.value ? -1 : 1;
      return input.rankBy.direction === 'ascending' ? ordered : -ordered;
    }
    return a.instrumentId < b.instrumentId ? -1 : 1;
  });

  const rows: RankUniverseResult['rows'] = [];
  let previousValue: number | undefined;
  let competitionRank = 0;
  let denseRank = 0;
  valued.forEach((entry, index) => {
    if (previousValue === undefined || entry.value !== previousValue) {
      competitionRank = index + 1;
      denseRank += 1;
      previousValue = entry.value;
    }
    const rank =
      input.tiePolicy === 'ordinal'
        ? index + 1
        : input.tiePolicy === 'competition'
          ? competitionRank
          : denseRank;
    rows.push({ instrumentId: entry.instrumentId, value: entry.value, rank });
  });

  const excludedCount = Object.values(exclusionReasons).reduce((total, count) => total + count, 0);
  return {
    assumptions: {
      universeId: input.universeId,
      asOf: input.asOf,
      rankBy: input.rankBy,
      tiePolicy: input.tiePolicy,
      missingValuePolicy: input.missingValuePolicy,
      finalTieBreaker: 'instrumentId ascending',
      versionResolution: 'latest available at or before asOf per instrument',
    },
    diagnostics: {
      warnings: [],
      suppliedCount: input.observations.length,
      eligibleCount: eligible.length,
      rankedCount: rows.length,
      excludedCount,
      exclusionReasons,
    },
    rows,
  };
}

// ---------------------------------------------------------------------------------------------------
// scoreUniverse
// ---------------------------------------------------------------------------------------------------

/** One weighted component of a composite score. */
export interface ScoreComponent {
  field: string;
  /** Positive weight; the component set is normalized and the normalized weights echoed. */
  weight: number;
  direction: 'higher-is-better' | 'lower-is-better';
  standardization: 'z-score' | 'percentile-rank';
}

/** Input for {@link scoreUniverse}. */
export interface ScoreUniverseInput {
  universeId: string;
  asOf: EpochMs;
  observations: readonly UniverseObservation[];
  fieldDefinitions: readonly FieldDefinition[];
  components: readonly ScoreComponent[];
  /**
   * `'exclude'`: a row missing ANY component is dropped with the reason.
   * `'renormalize-weights'`: the row scores over its PRESENT components with weights renormalized
   * — disclosed per policy, never per row silently.
   */
  missingValuePolicy: 'exclude' | 'renormalize-weights';
}

/** Result of {@link scoreUniverse}. */
export interface ScoreUniverseResult {
  assumptions: {
    universeId: string;
    asOf: EpochMs;
    components: Array<ScoreComponent & { normalizedWeight: number }>;
    missingValuePolicy: 'exclude' | 'renormalize-weights';
    finalTieBreaker: 'instrumentId ascending';
    versionResolution: 'latest available at or before asOf per instrument';
  };
  diagnostics: {
    warnings: string[];
    suppliedCount: number;
    eligibleCount: number;
    scoredCount: number;
    excludedCount: number;
    exclusionReasons: Record<string, number>;
  };
  rows: Array<{ instrumentId: string; score: number; componentsUsed: number }>;
}

/**
 * Weighted composite scoring over standardized declared fields. Standardization is computed over
 * the rows that carry the component; direction flips the sign so higher is always better in the
 * composite.
 */
export function scoreUniverse(input: ScoreUniverseInput): ScoreUniverseResult {
  requireArgumentObject('scoreUniverse', 'input', input);
  ensureKnownKeys('scoreUniverse', 'input', input, [
    'universeId',
    'asOf',
    'observations',
    'fieldDefinitions',
    'components',
    'missingValuePolicy',
  ]);
  if (typeof input.universeId !== 'string' || input.universeId.length === 0) {
    throw new InputError(`scoreUniverse: universeId must be a non-empty string.`, {
      code: ErrorCode.InputWrongType,
      context: { field: 'universeId' },
    });
  }
  requireFiniteFields('scoreUniverse', input as unknown as Record<string, unknown>, ['asOf'], {
    exampleCall:
      "scoreUniverse({ universeId: 'u', asOf: Date.UTC(2026, 7, 12), observations, fieldDefinitions, components: [{ field: 'quality', weight: 1, direction: 'higher-is-better', standardization: 'z-score' }], missingValuePolicy: 'exclude' })",
  });
  const definitions = requireFieldDefinitions('scoreUniverse', input.fieldDefinitions);
  requireUniverseObservations('scoreUniverse', input.observations, definitions);
  if (!Array.isArray(input.components) || input.components.length === 0) {
    throw new InputError(`scoreUniverse: components must be a non-empty array.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'components' },
    });
  }
  input.components.forEach((component, index) => {
    const path = `components[${index}]`;
    requireArgumentObject('scoreUniverse', path, component);
    ensureKnownKeys('scoreUniverse', path, component, [
      'field',
      'weight',
      'direction',
      'standardization',
    ]);
    const definition = definitions.get(component.field);
    if (definition === undefined || definition.kind !== 'numeric') {
      throw new InputError(
        `scoreUniverse: ${path}.field '${component.field}' must be a DECLARED numeric field.`,
        {
          code: definition === undefined ? ErrorCode.InputUnknownField : ErrorCode.InputOutOfRange,
          context: { field: `${path}.field` },
        },
      );
    }
    if (
      typeof component.weight !== 'number' ||
      !Number.isFinite(component.weight) ||
      component.weight <= 0
    ) {
      throw new InputError(
        `scoreUniverse: ${path}.weight must be a finite number > 0 (weights are normalized and echoed). Received ${component.weight === null ? 'null' : String(component.weight)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${path}.weight` } },
      );
    }
    if (component.direction !== 'higher-is-better' && component.direction !== 'lower-is-better') {
      throw new InputError(
        `scoreUniverse: ${path}.direction must be 'higher-is-better' | 'lower-is-better'. Received ${JSON.stringify(component.direction)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: `${path}.direction` } },
      );
    }
    if (
      component.standardization !== 'z-score' &&
      component.standardization !== 'percentile-rank'
    ) {
      throw new InputError(
        `scoreUniverse: ${path}.standardization must be 'z-score' | 'percentile-rank'. Received ${JSON.stringify(component.standardization)}.`,
        { code: ErrorCode.InputInvalidEnum, context: { field: `${path}.standardization` } },
      );
    }
  });
  if (
    input.missingValuePolicy !== 'exclude' &&
    input.missingValuePolicy !== 'renormalize-weights'
  ) {
    throw new InputError(
      `scoreUniverse: missingValuePolicy must be 'exclude' | 'renormalize-weights'. Received ${input.missingValuePolicy === null ? 'null' : JSON.stringify(input.missingValuePolicy)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'missingValuePolicy' } },
    );
  }

  const exclusionReasons: Record<string, number> = {};
  const addExclusion = (reason: string): void => {
    exclusionReasons[reason] = (exclusionReasons[reason] ?? 0) + 1;
  };
  const eligible = resolveEligible(input.observations, input.asOf, addExclusion);

  const totalWeight = input.components.reduce((total, component) => total + component.weight, 0);
  const componentsEchoed = input.components.map((component) => ({
    ...component,
    normalizedWeight: component.weight / totalWeight,
  }));

  // Standardize each component over the rows that CARRY it.
  const standardizedByComponent: Array<Map<string, number>> = input.components.map((component) => {
    const carriers = eligible
      .map(({ observation }) => ({
        instrumentId: observation.instrumentId,
        value: (observation.fields[component.field] ?? null) as number | null,
      }))
      .filter((entry): entry is { instrumentId: string; value: number } => entry.value !== null);
    const map = new Map<string, number>();
    if (carriers.length === 0) return map;
    if (component.standardization === 'z-score') {
      const mean = carriers.reduce((total, entry) => total + entry.value, 0) / carriers.length;
      const variance =
        carriers.length === 1
          ? 0
          : carriers.reduce((total, entry) => total + (entry.value - mean) ** 2, 0) /
            (carriers.length - 1);
      const deviation = Math.sqrt(variance);
      for (const entry of carriers) {
        map.set(entry.instrumentId, deviation === 0 ? 0 : (entry.value - mean) / deviation);
      }
    } else {
      const sorted = [...carriers].sort((a, b) => a.value - b.value);
      // Average rank for ties, scaled to (0, 1].
      let index = 0;
      while (index < sorted.length) {
        let end = index;
        while (end + 1 < sorted.length && sorted[end + 1]!.value === sorted[index]!.value) end += 1;
        const averageRank = (index + end + 2) / 2; // 1-based average of the tied span
        for (let position = index; position <= end; position++) {
          map.set(sorted[position]!.instrumentId, averageRank / sorted.length);
        }
        index = end + 1;
      }
    }
    const sign = component.direction === 'higher-is-better' ? 1 : -1;
    if (sign === -1) for (const [key, value] of map) map.set(key, -value);
    return map;
  });

  const rows: ScoreUniverseResult['rows'] = [];
  for (const { observation } of eligible) {
    let weighted = 0;
    let usedWeight = 0;
    let used = 0;
    let missing = false;
    input.components.forEach((component, index) => {
      const standardized = standardizedByComponent[index]!.get(observation.instrumentId);
      if (standardized === undefined) {
        missing = true;
        return;
      }
      weighted += standardized * component.weight;
      usedWeight += component.weight;
      used += 1;
    });
    if (used === 0 || (missing && input.missingValuePolicy === 'exclude')) {
      addExclusion(used === 0 ? 'missing-every-component' : 'missing-component-value');
      continue;
    }
    rows.push({
      instrumentId: observation.instrumentId,
      score: weighted / usedWeight,
      componentsUsed: used,
    });
  }
  rows.sort((a, b) =>
    a.score !== b.score ? b.score - a.score : a.instrumentId < b.instrumentId ? -1 : 1,
  );

  const excludedCount = Object.values(exclusionReasons).reduce((total, count) => total + count, 0);
  return requireRepresentableResult('scoreUniverse', {
    assumptions: {
      universeId: input.universeId,
      asOf: input.asOf,
      components: componentsEchoed,
      missingValuePolicy: input.missingValuePolicy,
      finalTieBreaker: 'instrumentId ascending',
      versionResolution: 'latest available at or before asOf per instrument',
    },
    diagnostics: {
      warnings: [],
      suppliedCount: input.observations.length,
      eligibleCount: eligible.length,
      scoredCount: rows.length,
      excludedCount,
      exclusionReasons,
    },
    rows,
  });
}
