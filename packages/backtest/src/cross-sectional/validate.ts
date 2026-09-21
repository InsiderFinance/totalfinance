/**
 * The closed guard for `crossSectionalBacktest` (Stage 4.6, FC8 Decision 4): every field of the
 * request is validated before a single session runs — unknown keys, `null` where omission is
 * meant, wrong types, invalid enums, non-finite numbers, undeclared fields, a signal that is not
 * exactly one of its four forms, a construction whose members contradict each other. Research owns
 * the observation, return, filter, and universe validators; the guard calls them.
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import {
  type FieldDefinition,
  requireFieldDefinitions,
  requireReturnObservations,
  requireScreenFilter,
  requireUniverseHistory,
  requireUniverseObservations,
} from '@totalfinance/research';
import { hasOwn, requireExecutionPolicy, requireLabeledModel } from '../execution/validate.js';
import type {
  CrossSectionalDataset,
  CrossSectionalSignal,
  Neutrality,
  PortfolioConstruction,
  RebalanceFrequency,
  RebalanceSchedule,
  WeightingMethod,
} from './types.js';

/** Decision 9: rows one run may read; larger inputs travel by handle to the job runner. */
export const CROSS_SECTIONAL_ROW_CEILING = 5_000_000;
/** Decision 9: open positions one construction may hold. */
export const CROSS_SECTIONAL_POSITION_CEILING = 50_000;

const REQUEST_KEYS = [
  'dataset',
  'universeHistory',
  'signal',
  'rebalanceSchedule',
  'portfolioConstruction',
  'execution',
  'transactionCostModel',
  'initialCapital',
  'baseCurrency',
  'window',
  'periodsPerYear',
  'riskFreeRate',
  'seed',
] as const;
const DATASET_KEYS = [
  'observations',
  'fieldDefinitions',
  'returns',
  'benchmarkReturns',
  'groups',
  'sizeField',
  'classification',
  'averageDailyVolumes',
  'betas',
] as const;
const SCHEDULE_KEYS = ['frequency', 'session', 'bufferBand'] as const;
const FREQUENCIES: readonly RebalanceFrequency[] = ['daily', 'weekly', 'monthly', 'quarterly'];
const CONSTRUCTION_KEYS = [
  'method',
  'long',
  'short',
  'neutrality',
  'neutralizeAgainst',
  'maximumPositions',
  'maximumPositionWeight',
  'minimumPositionWeight',
  'maximumTurnover',
  'maximumParticipation',
  'volatilityLookbackSessions',
  'suppliedWeights',
] as const;
const METHODS: readonly WeightingMethod[] = [
  'equal-weight',
  'score-weight',
  'inverse-volatility',
  'risk-budget',
  'supplied-weights',
];
const NEUTRALITIES: readonly Neutrality[] = ['none', 'dollar', 'sector', 'beta', 'factor'];
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

const EXAMPLE =
  "crossSectionalBacktest({ dataset: { observations, fieldDefinitions, returns }, universeHistory, signal: { factorRecipe: CANONICAL_FACTOR_RECIPES.value }, rebalanceSchedule: { frequency: 'monthly', session: 'close' }, portfolioConstruction: { method: 'equal-weight', long: { topQuantile: 0.2 } } })";

function refuse(
  functionName: string,
  field: string,
  message: string,
  code: string = ErrorCode.InputOutOfRange,
): never {
  throw new InputError(`${functionName}: ${field} ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

function finiteNumber(functionName: string, field: string, value: unknown): number {
  if (typeof value !== 'number') {
    refuse(
      functionName,
      field,
      `must be a finite number. Received ${value === null ? 'null' : typeof value}.`,
      ErrorCode.InputWrongType,
    );
  }
  if (!Number.isFinite(value))
    refuse(
      functionName,
      field,
      `must be finite. Received ${String(value)}.`,
      ErrorCode.InputNotFinite,
    );
  return value;
}

function safeInteger(
  functionName: string,
  field: string,
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    refuse(
      functionName,
      field,
      `must be an integer in [${minimum}, ${maximum}]. Received ${value === null ? 'null' : String(value)}.`,
    );
  }
  return value as number;
}

function enumValue<T extends string>(
  functionName: string,
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T)) {
    refuse(
      functionName,
      field,
      `must be one of ${allowed.map((v) => `'${v}'`).join(' | ')}. Received ${value === null ? 'null' : JSON.stringify(value)}.`,
      ErrorCode.InputInvalidEnum,
    );
  }
  return value as T;
}

function nonEmptyString(functionName: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    refuse(
      functionName,
      field,
      `must be a non-empty string. Received ${value === null ? 'null' : typeof value}.`,
      ErrorCode.InputWrongType,
    );
  }
  return value;
}

function presentNotNull(functionName: string, record: object, key: string, field: string): boolean {
  if (!hasOwn(record, key)) return false;
  if ((record as Record<string, unknown>)[key] === null) {
    refuse(
      functionName,
      field,
      'is null — omit the field to leave it unset; null is not a value here.',
      ErrorCode.InputWrongType,
    );
  }
  return true;
}

function requireNumericField(
  functionName: string,
  field: string,
  name: unknown,
  definitions: Map<string, FieldDefinition>,
): string {
  const fieldName = nonEmptyString(functionName, field, name);
  const definition = definitions.get(fieldName);
  if (definition === undefined) {
    refuse(
      functionName,
      field,
      `names '${fieldName}', which is not a declared field. Declared: ${[...definitions.keys()].slice(0, 8).join(', ')}.`,
      ErrorCode.InputUnknownField,
    );
  }
  if (definition.kind !== 'numeric') {
    refuse(
      functionName,
      field,
      `names '${fieldName}', a ${definition.kind} field — a signal feature must be numeric.`,
    );
  }
  return fieldName;
}

function requireFiniteRecord(
  functionName: string,
  field: string,
  value: unknown,
  options: { nonNegative?: boolean } = {},
): void {
  requireArgumentObject(functionName, field, value);
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    nonEmptyString(functionName, `${field} key`, key);
    const n = finiteNumber(functionName, `${field}.${key}`, entry);
    if (options.nonNegative && n < 0)
      refuse(functionName, `${field}.${key}`, `must be ≥ 0. Received ${n}.`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------------

export function requireCrossSectionalDataset(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is CrossSectionalDataset {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, DATASET_KEYS);
  const dataset = value as Record<string, unknown>;
  const definitions = requireFieldDefinitions(
    functionName,
    dataset['fieldDefinitions'] as FieldDefinition[],
  );
  if (!Array.isArray(dataset['observations'])) {
    refuse(
      functionName,
      `${label}.observations`,
      'must be an array of universe observations (it may be empty for a callback signal).',
      ErrorCode.InputWrongType,
    );
  }
  if ((dataset['observations'] as unknown[]).length > 0) {
    requireUniverseObservations(functionName, dataset['observations'] as never, definitions);
  }
  requireReturnObservations(functionName, `${label}.returns`, dataset['returns'] as never);
  const rows =
    (dataset['observations'] as unknown[]).length + (dataset['returns'] as unknown[]).length;
  if (rows > CROSS_SECTIONAL_ROW_CEILING) {
    throw new InputError(
      `${functionName}: ${label} carries ${rows.toLocaleString('en-US')} rows (observations + returns), above the ${CROSS_SECTIONAL_ROW_CEILING.toLocaleString('en-US')}-row ceiling one run may read; split the run or hand the rows to the job runner by handle.`,
      {
        code: ErrorCode.BacktestInputTooLarge,
        context: { function: functionName, field: label, rows },
      },
    );
  }
  if (presentNotNull(functionName, dataset, 'benchmarkReturns', `${label}.benchmarkReturns`)) {
    requireReturnObservations(
      functionName,
      `${label}.benchmarkReturns`,
      dataset['benchmarkReturns'] as never,
    );
    const ids = new Set(
      (dataset['benchmarkReturns'] as { instrumentId: string }[]).map((r) => r.instrumentId),
    );
    if (ids.size !== 1) {
      refuse(
        functionName,
        `${label}.benchmarkReturns`,
        `must carry exactly one instrumentId (the benchmark); received ${ids.size}.`,
      );
    }
  }
  if (presentNotNull(functionName, dataset, 'groups', `${label}.groups`)) {
    requireArgumentObject(functionName, `${label}.groups`, dataset['groups']);
    for (const [key, group] of Object.entries(dataset['groups'] as Record<string, unknown>)) {
      nonEmptyString(functionName, `${label}.groups.${key}`, group);
    }
  }
  if (presentNotNull(functionName, dataset, 'sizeField', `${label}.sizeField`)) {
    requireNumericField(functionName, `${label}.sizeField`, dataset['sizeField'], definitions);
  }
  if (presentNotNull(functionName, dataset, 'classification', `${label}.classification`)) {
    requireArgumentObject(functionName, `${label}.classification`, dataset['classification']);
    for (const [key, entry] of Object.entries(
      dataset['classification'] as Record<string, unknown>,
    )) {
      requireArgumentObject(functionName, `${label}.classification.${key}`, entry);
      ensureKnownKeys(functionName, `${label}.classification.${key}`, entry as object, [
        'underlying',
        'assetClass',
        'strategy',
        'tags',
      ]);
    }
  }
  if (
    presentNotNull(functionName, dataset, 'averageDailyVolumes', `${label}.averageDailyVolumes`)
  ) {
    requireFiniteRecord(
      functionName,
      `${label}.averageDailyVolumes`,
      dataset['averageDailyVolumes'],
      { nonNegative: true },
    );
  }
  if (presentNotNull(functionName, dataset, 'betas', `${label}.betas`)) {
    requireFiniteRecord(functionName, `${label}.betas`, dataset['betas']);
  }
}

export function requireCrossSectionalSignal(
  functionName: string,
  label: string,
  value: unknown,
  definitions: Map<string, FieldDefinition>,
): asserts value is CrossSectionalSignal {
  requireArgumentObject(functionName, label, value);
  const signal = value as Record<string, unknown>;
  const forms = ['factorRecipe', 'score', 'screen', 'callback'] as const;
  ensureKnownKeys(functionName, label, signal, forms);
  const present = forms.filter((form) => hasOwn(signal, form));
  if (present.length !== 1) {
    refuse(
      functionName,
      label,
      `must be exactly one of { factorRecipe } | { score } | { screen } | { callback }; received ${present.length === 0 ? 'none' : present.join(' + ')}.\n  e.g. ${EXAMPLE}`,
      ErrorCode.InputMissingField,
    );
  }
  const form = present[0]!;
  const body = signal[form];
  if (form === 'callback') {
    if (typeof body !== 'function')
      refuse(
        functionName,
        `${label}.callback`,
        'must be a function (context) → SignalRow[].',
        ErrorCode.InputWrongType,
      );
    return;
  }
  requireArgumentObject(functionName, `${label}.${form}`, body);
  const record = body as Record<string, unknown>;
  if (form === 'factorRecipe') {
    ensureKnownKeys(functionName, `${label}.factorRecipe`, record, RECIPE_KEYS);
    nonEmptyString(functionName, `${label}.factorRecipe.recipeName`, record['recipeName']);
    safeInteger(
      functionName,
      `${label}.factorRecipe.recipeVersion`,
      record['recipeVersion'],
      1,
      1_000_000,
    );
    nonEmptyString(functionName, `${label}.factorRecipe.disclosure`, record['disclosure']);
    enumValue(functionName, `${label}.factorRecipe.direction`, record['direction'], [
      'higher-is-better',
      'lower-is-better',
    ] as const);
    if (!Array.isArray(record['features']) || record['features'].length === 0) {
      refuse(
        functionName,
        `${label}.factorRecipe.features`,
        'must be a non-empty array of { field, transform, weight }.',
        ErrorCode.InputWrongType,
      );
    }
    (record['features'] as unknown[]).forEach((feature, index) => {
      const path = `${label}.factorRecipe.features[${index}]`;
      requireArgumentObject(functionName, path, feature);
      ensureKnownKeys(functionName, path, feature as object, ['field', 'transform', 'weight']);
      const f = feature as Record<string, unknown>;
      requireNumericField(functionName, `${path}.field`, f['field'], definitions);
      enumValue(functionName, `${path}.transform`, f['transform'], [
        'raw',
        'winsorize-then-z-score',
        'percentile-rank',
      ] as const);
      const weight = finiteNumber(functionName, `${path}.weight`, f['weight']);
      if (!(weight > 0)) refuse(functionName, `${path}.weight`, `must be > 0. Received ${weight}.`);
    });
    safeInteger(
      functionName,
      `${label}.factorRecipe.lagTradingSessions`,
      record['lagTradingSessions'],
      0,
      100_000,
    );
    enumValue(functionName, `${label}.factorRecipe.neutralization`, record['neutralization'], [
      'none',
      'sector',
      'sector-and-size',
    ] as const);
    enumValue(
      functionName,
      `${label}.factorRecipe.missingValuePolicy`,
      record['missingValuePolicy'],
      ['exclude', 'renormalize-weights'] as const,
    );
    return;
  }
  if (form === 'score') {
    ensureKnownKeys(functionName, `${label}.score`, record, ['components', 'missingValuePolicy']);
    if (!Array.isArray(record['components']) || record['components'].length === 0) {
      refuse(
        functionName,
        `${label}.score.components`,
        'must be a non-empty array of score components.',
        ErrorCode.InputWrongType,
      );
    }
    (record['components'] as unknown[]).forEach((component, index) => {
      const path = `${label}.score.components[${index}]`;
      requireArgumentObject(functionName, path, component);
      ensureKnownKeys(functionName, path, component as object, [
        'field',
        'weight',
        'direction',
        'standardization',
      ]);
      const c = component as Record<string, unknown>;
      requireNumericField(functionName, `${path}.field`, c['field'], definitions);
      const weight = finiteNumber(functionName, `${path}.weight`, c['weight']);
      if (!(weight > 0)) refuse(functionName, `${path}.weight`, `must be > 0. Received ${weight}.`);
      enumValue(functionName, `${path}.direction`, c['direction'], [
        'higher-is-better',
        'lower-is-better',
      ] as const);
      enumValue(functionName, `${path}.standardization`, c['standardization'], [
        'z-score',
        'percentile-rank',
      ] as const);
    });
    enumValue(functionName, `${label}.score.missingValuePolicy`, record['missingValuePolicy'], [
      'exclude',
      'renormalize-weights',
    ] as const);
    return;
  }
  // screen
  ensureKnownKeys(functionName, `${label}.screen`, record, [
    'filter',
    'orderBy',
    'missingValuePolicy',
  ]);
  if (presentNotNull(functionName, record, 'filter', `${label}.screen.filter`)) {
    requireScreenFilter(
      functionName,
      `${label}.screen.filter`,
      record['filter'] as never,
      definitions,
    );
  }
  if (!Array.isArray(record['orderBy']) || record['orderBy'].length === 0) {
    refuse(
      functionName,
      `${label}.screen.orderBy`,
      'must be a non-empty array of { field, direction } — the screen ranks by it, first key first.',
      ErrorCode.InputWrongType,
    );
  }
  (record['orderBy'] as unknown[]).forEach((key, index) => {
    const path = `${label}.screen.orderBy[${index}]`;
    requireArgumentObject(functionName, path, key);
    ensureKnownKeys(functionName, path, key as object, ['field', 'direction']);
    const k = key as Record<string, unknown>;
    const fieldName = nonEmptyString(functionName, `${path}.field`, k['field']);
    if (!definitions.has(fieldName))
      refuse(
        functionName,
        `${path}.field`,
        `names '${fieldName}', which is not a declared field.`,
        ErrorCode.InputUnknownField,
      );
    enumValue(functionName, `${path}.direction`, k['direction'], [
      'ascending',
      'descending',
    ] as const);
  });
  enumValue(functionName, `${label}.screen.missingValuePolicy`, record['missingValuePolicy'], [
    'exclude',
    'evaluate-as-false',
  ] as const);
}

export function requireRebalanceSchedule(
  functionName: string,
  label: string,
  value: unknown,
): asserts value is RebalanceSchedule {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, SCHEDULE_KEYS);
  const schedule = value as Record<string, unknown>;
  enumValue(functionName, `${label}.frequency`, schedule['frequency'], FREQUENCIES);
  enumValue(functionName, `${label}.session`, schedule['session'], ['open', 'close'] as const);
  if (presentNotNull(functionName, schedule, 'bufferBand', `${label}.bufferBand`)) {
    const band = finiteNumber(functionName, `${label}.bufferBand`, schedule['bufferBand']);
    if (band < 0 || band > 1)
      refuse(
        functionName,
        `${label}.bufferBand`,
        `is a fraction of the selection threshold in [0, 1]. Received ${band}.`,
      );
  }
}

function requireSideSelection(
  functionName: string,
  field: string,
  value: unknown,
  quantileKey: 'topQuantile' | 'bottomQuantile',
): void {
  requireArgumentObject(functionName, field, value);
  const record = value as Record<string, unknown>;
  ensureKnownKeys(functionName, field, record, [quantileKey, 'count', 'fraction']);
  const keys = Object.keys(record);
  if (keys.length !== 1) {
    refuse(
      functionName,
      field,
      `must be exactly one of { ${quantileKey} } | { count } | { fraction }; received ${keys.length === 0 ? 'none' : keys.join(' + ')}.`,
      ErrorCode.InputMissingField,
    );
  }
  const key = keys[0]!;
  if (key === 'count')
    safeInteger(
      functionName,
      `${field}.count`,
      record['count'],
      1,
      CROSS_SECTIONAL_POSITION_CEILING,
    );
  else {
    const fraction = finiteNumber(functionName, `${field}.${key}`, record[key]);
    if (!(fraction > 0) || fraction > 1)
      refuse(functionName, `${field}.${key}`, `is a fraction in (0, 1]. Received ${fraction}.`);
  }
}

export function requirePortfolioConstruction(
  functionName: string,
  label: string,
  value: unknown,
  definitions: Map<string, FieldDefinition>,
  dataset: CrossSectionalDataset,
): asserts value is PortfolioConstruction {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, CONSTRUCTION_KEYS);
  const construction = value as Record<string, unknown>;
  const method = enumValue(functionName, `${label}.method`, construction['method'], METHODS);
  requireSideSelection(functionName, `${label}.long`, construction['long'], 'topQuantile');
  const hasShort = presentNotNull(functionName, construction, 'short', `${label}.short`);
  if (hasShort)
    requireSideSelection(functionName, `${label}.short`, construction['short'], 'bottomQuantile');
  let neutrality: Neutrality = 'none';
  if (presentNotNull(functionName, construction, 'neutrality', `${label}.neutrality`)) {
    neutrality = enumValue(
      functionName,
      `${label}.neutrality`,
      construction['neutrality'],
      NEUTRALITIES,
    );
  }
  if (neutrality !== 'none' && !hasShort) {
    refuse(
      functionName,
      `${label}.neutrality`,
      `'${neutrality}' needs a short side — add ${label}.short or choose 'none'.`,
    );
  }
  if (neutrality === 'sector' && dataset.groups === undefined) {
    refuse(
      functionName,
      `${label}.neutrality`,
      "'sector' needs dataset.groups (instrumentId → group).",
      ErrorCode.InputMissingField,
    );
  }
  if (neutrality === 'beta' && dataset.betas === undefined) {
    refuse(
      functionName,
      `${label}.neutrality`,
      "'beta' needs dataset.betas (instrumentId → beta).",
      ErrorCode.InputMissingField,
    );
  }
  if (
    presentNotNull(functionName, construction, 'neutralizeAgainst', `${label}.neutralizeAgainst`)
  ) {
    requireArgumentObject(
      functionName,
      `${label}.neutralizeAgainst`,
      construction['neutralizeAgainst'],
    );
    ensureKnownKeys(
      functionName,
      `${label}.neutralizeAgainst`,
      construction['neutralizeAgainst'] as object,
      ['field'],
    );
    requireNumericField(
      functionName,
      `${label}.neutralizeAgainst.field`,
      (construction['neutralizeAgainst'] as Record<string, unknown>)['field'],
      definitions,
    );
    if (neutrality !== 'factor')
      refuse(
        functionName,
        `${label}.neutralizeAgainst`,
        "is given but neutrality is not 'factor'.",
      );
  } else if (neutrality === 'factor') {
    refuse(
      functionName,
      `${label}.neutralizeAgainst`,
      "is required for neutrality 'factor' — the declared numeric field the weights are residualized against.",
      ErrorCode.InputMissingField,
    );
  }
  if (presentNotNull(functionName, construction, 'maximumPositions', `${label}.maximumPositions`)) {
    safeInteger(
      functionName,
      `${label}.maximumPositions`,
      construction['maximumPositions'],
      1,
      CROSS_SECTIONAL_POSITION_CEILING,
    );
  }
  if (
    presentNotNull(
      functionName,
      construction,
      'maximumPositionWeight',
      `${label}.maximumPositionWeight`,
    )
  ) {
    const w = finiteNumber(
      functionName,
      `${label}.maximumPositionWeight`,
      construction['maximumPositionWeight'],
    );
    if (!(w > 0) || w > 1)
      refuse(
        functionName,
        `${label}.maximumPositionWeight`,
        `is a fraction of net asset value in (0, 1]. Received ${w}.`,
      );
  }
  if (
    presentNotNull(
      functionName,
      construction,
      'minimumPositionWeight',
      `${label}.minimumPositionWeight`,
    )
  ) {
    const w = finiteNumber(
      functionName,
      `${label}.minimumPositionWeight`,
      construction['minimumPositionWeight'],
    );
    if (w < 0 || w >= 1)
      refuse(
        functionName,
        `${label}.minimumPositionWeight`,
        `is a fraction of net asset value in [0, 1). Received ${w}.`,
      );
  }
  if (presentNotNull(functionName, construction, 'maximumTurnover', `${label}.maximumTurnover`)) {
    const t = finiteNumber(
      functionName,
      `${label}.maximumTurnover`,
      construction['maximumTurnover'],
    );
    if (!(t > 0) || t > 4)
      refuse(
        functionName,
        `${label}.maximumTurnover`,
        `is a fraction of net asset value traded per rebalance in (0, 4]. Received ${t}.`,
      );
  }
  if (
    presentNotNull(
      functionName,
      construction,
      'maximumParticipation',
      `${label}.maximumParticipation`,
    )
  ) {
    const p = finiteNumber(
      functionName,
      `${label}.maximumParticipation`,
      construction['maximumParticipation'],
    );
    if (!(p > 0) || p > 1)
      refuse(
        functionName,
        `${label}.maximumParticipation`,
        `is a fraction of average daily volume in (0, 1]. Received ${p}.`,
      );
    if (dataset.averageDailyVolumes === undefined) {
      refuse(
        functionName,
        `${label}.maximumParticipation`,
        'needs dataset.averageDailyVolumes.',
        ErrorCode.InputMissingField,
      );
    }
  }
  if (
    presentNotNull(
      functionName,
      construction,
      'volatilityLookbackSessions',
      `${label}.volatilityLookbackSessions`,
    )
  ) {
    safeInteger(
      functionName,
      `${label}.volatilityLookbackSessions`,
      construction['volatilityLookbackSessions'],
      2,
      5_000,
    );
  }
  const hasSupplied = presentNotNull(
    functionName,
    construction,
    'suppliedWeights',
    `${label}.suppliedWeights`,
  );
  if (hasSupplied && typeof construction['suppliedWeights'] !== 'function') {
    refuse(
      functionName,
      `${label}.suppliedWeights`,
      'must be a function (context) → Record<instrumentId, weight>.',
      ErrorCode.InputWrongType,
    );
  }
  if (method === 'supplied-weights' && !hasSupplied) {
    refuse(
      functionName,
      `${label}.suppliedWeights`,
      "is required for method 'supplied-weights'.",
      ErrorCode.InputMissingField,
    );
  }
  if (method !== 'supplied-weights' && hasSupplied) {
    refuse(
      functionName,
      `${label}.suppliedWeights`,
      `is given but method is '${method}' — choose 'supplied-weights' or omit it.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------------

/** Validate the whole request; returns the declared field definitions for the engine's reuse. */
export function requireCrossSectionalBacktestRequest(
  functionName: string,
  label: string,
  value: unknown,
): Map<string, FieldDefinition> {
  requireArgumentObject(functionName, label, value);
  ensureKnownKeys(functionName, label, value as object, REQUEST_KEYS);
  const request = value as Record<string, unknown>;
  requireCrossSectionalDataset(functionName, `${label}.dataset`, request['dataset']);
  const dataset = request['dataset'] as CrossSectionalDataset;
  const definitions = requireFieldDefinitions(functionName, dataset.fieldDefinitions);
  requireUniverseHistory(
    functionName,
    `${label}.universeHistory`,
    request['universeHistory'] as never,
  );
  requireCrossSectionalSignal(functionName, `${label}.signal`, request['signal'], definitions);
  const signal = request['signal'] as CrossSectionalSignal;
  if ('factorRecipe' in signal) {
    const recipe = signal.factorRecipe;
    if (recipe.neutralization !== 'none' && dataset.groups === undefined) {
      refuse(
        functionName,
        `${label}.signal.factorRecipe.neutralization`,
        `'${recipe.neutralization}' needs dataset.groups (instrumentId → sector group).`,
        ErrorCode.InputMissingField,
      );
    }
    if (recipe.neutralization === 'sector-and-size' && dataset.sizeField === undefined) {
      refuse(
        functionName,
        `${label}.signal.factorRecipe.neutralization`,
        "'sector-and-size' needs dataset.sizeField (the declared numeric size field).",
        ErrorCode.InputMissingField,
      );
    }
  }
  requireRebalanceSchedule(
    functionName,
    `${label}.rebalanceSchedule`,
    request['rebalanceSchedule'],
  );
  requirePortfolioConstruction(
    functionName,
    `${label}.portfolioConstruction`,
    request['portfolioConstruction'],
    definitions,
    dataset,
  );
  if (presentNotNull(functionName, request, 'execution', `${label}.execution`)) {
    requireExecutionPolicy(functionName, `${label}.execution`, request['execution']);
  }
  if (
    presentNotNull(functionName, request, 'transactionCostModel', `${label}.transactionCostModel`)
  ) {
    requireArgumentObject(
      functionName,
      `${label}.transactionCostModel`,
      request['transactionCostModel'],
    );
    const costs = request['transactionCostModel'] as Record<string, unknown>;
    ensureKnownKeys(functionName, `${label}.transactionCostModel`, costs, [
      'commission',
      'slippage',
    ]);
    if (
      presentNotNull(functionName, costs, 'commission', `${label}.transactionCostModel.commission`)
    ) {
      requireLabeledModel(
        functionName,
        `${label}.transactionCostModel.commission`,
        costs['commission'],
        'commission',
      );
    }
    if (presentNotNull(functionName, costs, 'slippage', `${label}.transactionCostModel.slippage`)) {
      requireLabeledModel(
        functionName,
        `${label}.transactionCostModel.slippage`,
        costs['slippage'],
        'fill',
      );
    }
  }
  if (presentNotNull(functionName, request, 'initialCapital', `${label}.initialCapital`)) {
    const capital = finiteNumber(
      functionName,
      `${label}.initialCapital`,
      request['initialCapital'],
    );
    if (!(capital > 0))
      refuse(functionName, `${label}.initialCapital`, `must be > 0. Received ${capital}.`);
  }
  if (presentNotNull(functionName, request, 'baseCurrency', `${label}.baseCurrency`)) {
    const currency = nonEmptyString(functionName, `${label}.baseCurrency`, request['baseCurrency']);
    if (!/^[A-Z]{3}$/.test(currency))
      refuse(
        functionName,
        `${label}.baseCurrency`,
        `must be a three-letter ISO 4217 code. Received '${currency}'.`,
      );
  }
  if (presentNotNull(functionName, request, 'window', `${label}.window`)) {
    requireArgumentObject(functionName, `${label}.window`, request['window']);
    const window = request['window'] as Record<string, unknown>;
    ensureKnownKeys(functionName, `${label}.window`, window, ['fromTimestampMs', 'toTimestampMs']);
    let from: number | undefined;
    let to: number | undefined;
    if (presentNotNull(functionName, window, 'fromTimestampMs', `${label}.window.fromTimestampMs`))
      from = finiteNumber(
        functionName,
        `${label}.window.fromTimestampMs`,
        window['fromTimestampMs'],
      );
    if (presentNotNull(functionName, window, 'toTimestampMs', `${label}.window.toTimestampMs`))
      to = finiteNumber(functionName, `${label}.window.toTimestampMs`, window['toTimestampMs']);
    if (from !== undefined && to !== undefined && to < from)
      refuse(functionName, `${label}.window`, `ends (${to}) before it starts (${from}).`);
  }
  if (presentNotNull(functionName, request, 'periodsPerYear', `${label}.periodsPerYear`)) {
    safeInteger(functionName, `${label}.periodsPerYear`, request['periodsPerYear'], 1, 100_000);
  }
  if (presentNotNull(functionName, request, 'riskFreeRate', `${label}.riskFreeRate`)) {
    finiteNumber(functionName, `${label}.riskFreeRate`, request['riskFreeRate']);
  }
  if (presentNotNull(functionName, request, 'seed', `${label}.seed`)) {
    safeInteger(functionName, `${label}.seed`, request['seed'], 0, Number.MAX_SAFE_INTEGER);
  }
  return definitions;
}

export { EXAMPLE as CROSS_SECTIONAL_EXAMPLE };
