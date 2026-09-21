import { ErrorCode, InputError } from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import { definePricer, type Pricer, type PricerValuationResult } from '@totalfinance/core/pricing';
import { requireCurrencyCode } from '@totalfinance/foreign-exchange';
import {
  detachCanonicalData,
  describeInputValue,
  readPlainArrayLength,
  scanCanonicalData,
  snapshotClosedRecord,
  snapshotDenseArray,
} from './internal/data.js';
import { spotAssetPricer } from './spot-pricer.js';
import type {
  FullRevaluationScenarioTargetDescriptor,
  FullRevaluationScenarioTargetInput,
  ScenarioPricerDescriptor,
  ScenarioTarget,
  ScenarioTargetBuilders,
  ScenarioTargetDescriptor,
  SpotScenarioTargetInput,
  TaylorFactors,
  TaylorScenarioTargetDescriptor,
  TaylorScenarioTargetInput,
  TaylorSensitivities,
} from './types.js';

const TARGET_BRAND = Symbol('totalfinance.scenarios.target.brand');
const FULL_REVALUATION_BINDING = Symbol('totalfinance.scenarios.target.full-revaluation-binding');

const BASE_KEYS = [
  'id',
  'quantity',
  'contractMultiplier',
  'currency',
  'underlying',
  'strategy',
  'account',
  'book',
  'tags',
] as const;

const FULL_REVALUATION_INPUT_KEYS = [
  ...BASE_KEYS,
  'instrument',
  'instrumentDescriptor',
  'pricer',
] as const;
const TAYLOR_INPUT_KEYS = [...BASE_KEYS, 'baseValuePerUnit', 'greeks', 'factors'] as const;
const SPOT_INPUT_KEYS = [
  'id',
  'symbol',
  'quantity',
  'currency',
  'strategy',
  'account',
  'book',
  'tags',
] as const;

const SENSITIVITY_KEYS = [
  'delta',
  'gamma',
  'vega',
  'theta',
  'rho',
  'vanna',
  'vomma',
  'charm',
  'veta',
  'vera',
  'deltaRate',
  'thetaRate',
  'rhoConvexity',
  'thetaConvexity',
  'phi',
] as const satisfies readonly (keyof TaylorSensitivities)[];

const FACTOR_KEYS = [
  'spot',
  'volatility',
  'riskFreeRate',
  'dividend',
  'valuationInstant',
] as const satisfies readonly (keyof TaylorFactors)[];

const TARGET_BASE_DESCRIPTOR_KEYS = [
  'id',
  'quantity',
  'contractMultiplier',
  'currency',
  'underlying',
  'strategy',
  'account',
  'book',
  'tags',
  'targetDescriptorHash',
] as const;

interface FullRevaluationBinding {
  readonly instrument: unknown;
  readonly pricer: Pricer<unknown, PricerValuationResult>;
}

export interface ValidatedScenarioTarget {
  readonly target: ScenarioTarget;
  readonly descriptor: ScenarioTargetDescriptor;
  readonly binding: FullRevaluationBinding | null;
}

function targetError(
  functionName: string,
  field: string,
  message: string,
  code: string = ErrorCode.InputWrongType,
): never {
  throw new InputError(`${functionName}: ${field} ${message}`, {
    code,
    context: { function: functionName, field },
  });
}

function requireNonEmptyString(functionName: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    targetError(functionName, field, 'must be a non-empty string.');
  }
  return value;
}

function requireFiniteNumber(functionName: string, field: string, value: unknown): number {
  if (typeof value !== 'number') {
    targetError(
      functionName,
      field,
      `must be a finite number; received ${value === null ? 'null' : typeof value}.`,
    );
  }
  if (!Number.isFinite(value)) {
    targetError(
      functionName,
      field,
      `must be a finite number; received ${describeInputValue(value)}.`,
      Number.isNaN(value) ? ErrorCode.InputNaN : ErrorCode.InputNotFinite,
    );
  }
  return value;
}

function requireEpochMs(functionName: string, field: string, value: unknown): number {
  const epochMs = requireFiniteNumber(functionName, field, value);
  if (!Number.isSafeInteger(epochMs) || Math.abs(epochMs) > 8_640_000_000_000_000) {
    targetError(
      functionName,
      field,
      'must be a safe integer epoch-millisecond instant inside the ECMAScript date range.',
      ErrorCode.InputOutOfRange,
    );
  }
  return epochMs;
}

function optionalString(functionName: string, field: string, value: unknown): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(functionName, field, value);
}

function requireTags(functionName: string, value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const count = readPlainArrayLength(value, functionName, 'input.tags');
  if (count > 128) {
    targetError(
      functionName,
      'input.tags',
      `may contain at most 128 tags; received ${count}.`,
      ErrorCode.InputOutOfRange,
    );
  }
  const raw = snapshotDenseArray(value, functionName, 'input.tags');
  const tags: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    const tag = requireNonEmptyString(functionName, `input.tags[${index}]`, raw[index]);
    if (seen.has(tag)) {
      targetError(
        functionName,
        `input.tags[${index}]`,
        `duplicates ${JSON.stringify(tag)} — target tags must be unique.`,
        ErrorCode.InputOutOfRange,
      );
    }
    seen.add(tag);
    tags.push(tag);
  }
  return Object.freeze(tags);
}

interface ValidatedBase {
  readonly id: string;
  readonly quantity: number;
  readonly contractMultiplier: number;
  readonly currency: string;
  readonly underlying?: string;
  readonly strategy?: string;
  readonly account?: string;
  readonly book?: string;
  readonly tags: readonly string[];
}

function validateBase(
  functionName: string,
  input: Readonly<Record<string, unknown>>,
): ValidatedBase {
  const id = requireNonEmptyString(functionName, 'input.id', input['id']);
  const quantity = requireFiniteNumber(functionName, 'input.quantity', input['quantity']);
  if (quantity === 0) {
    targetError(
      functionName,
      'input.quantity',
      'must be non-zero; positive is long and negative is short.',
      ErrorCode.InputOutOfRange,
    );
  }
  const contractMultiplier = requireFiniteNumber(
    functionName,
    'input.contractMultiplier',
    input['contractMultiplier'],
  );
  if (contractMultiplier <= 0) {
    targetError(
      functionName,
      'input.contractMultiplier',
      'must be strictly positive; contract scaling is never guessed.',
      ErrorCode.InputOutOfRange,
    );
  }
  const currency = input['currency'];
  requireCurrencyCode(functionName, 'input.currency', currency);
  return {
    id,
    quantity,
    contractMultiplier,
    currency,
    ...(optionalString(functionName, 'input.underlying', input['underlying']) !== undefined
      ? { underlying: input['underlying'] as string }
      : {}),
    ...(optionalString(functionName, 'input.strategy', input['strategy']) !== undefined
      ? { strategy: input['strategy'] as string }
      : {}),
    ...(optionalString(functionName, 'input.account', input['account']) !== undefined
      ? { account: input['account'] as string }
      : {}),
    ...(optionalString(functionName, 'input.book', input['book']) !== undefined
      ? { book: input['book'] as string }
      : {}),
    tags: requireTags(functionName, input['tags']),
  };
}

function descriptorOfPricer<TInstrument>(
  functionName: string,
  pricer: Pricer<TInstrument, PricerValuationResult>,
): {
  readonly descriptor: ScenarioPricerDescriptor;
  readonly pricer: Pricer<TInstrument, PricerValuationResult>;
} {
  const validated = definePricer(pricer);
  const descriptor = detachCanonicalData<ScenarioPricerDescriptor>(
    {
      name: validated.name,
      version: validated.version,
      capabilities: {
        greeks: validated.capabilities.greeks,
        randomness: validated.capabilities.randomness,
        batch: validated.capabilities.batch,
      },
    },
    {
      functionName,
      label: 'input.pricer descriptor',
      requireFiniteNumbers: true,
    },
  );
  return { descriptor, pricer: validated };
}

function canonicalInstrumentDescriptor(
  functionName: string,
  instrument: unknown,
  supplied: unknown,
  wasSupplied: boolean,
): unknown {
  const descriptor = wasSupplied ? supplied : instrument;
  try {
    return detachCanonicalData(descriptor, {
      functionName,
      label: wasSupplied ? 'input.instrumentDescriptor' : 'input.instrument',
      requireFiniteNumbers: true,
    });
  } catch (error) {
    if (!wasSupplied) {
      throw new InputError(
        `${functionName}: input.instrument cannot be derived into a canonical replay descriptor — supply input.instrumentDescriptor as plain JSON-safe stored data. The runner retains behavior separately and never serializes it blindly.`,
        {
          code: ErrorCode.SerializationUnsupportedValue,
          context: { function: functionName, field: 'input.instrumentDescriptor' },
          cause: error,
        },
      );
    }
    throw error;
  }
}

function targetHashPayload<T>(descriptor: T): T {
  return descriptor;
}

function attachTarget(
  descriptor: ScenarioTargetDescriptor,
  binding: FullRevaluationBinding | null,
): ScenarioTarget {
  // `detachCanonicalData` has already deeply frozen every public nested value. Attach the two
  // private own-data slots to a fresh extensible shell, then freeze that shell; never thaw or
  // recursively traverse the caller-owned behavior binding.
  const target = { ...descriptor } as ScenarioTarget;
  Object.defineProperty(target, TARGET_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  if (binding !== null) {
    Object.defineProperty(target, FULL_REVALUATION_BINDING, {
      configurable: false,
      enumerable: false,
      value: Object.freeze(binding),
      writable: false,
    });
  }
  return Object.freeze(target);
}

function fullRevaluation<TInstrument>(
  rawInput: FullRevaluationScenarioTargetInput<TInstrument>,
): ScenarioTarget {
  const functionName = 'scenarioTarget.fullRevaluation';
  const input = snapshotClosedRecord(rawInput, {
    functionName,
    label: 'input',
    allowedKeys: FULL_REVALUATION_INPUT_KEYS,
    requiredKeys: ['id', 'quantity', 'contractMultiplier', 'currency', 'instrument', 'pricer'],
  });
  const base = validateBase(functionName, input);
  const { descriptor: pricerDescriptor, pricer } = descriptorOfPricer(
    functionName,
    input['pricer'] as Pricer<TInstrument, PricerValuationResult>,
  );
  const descriptorWasSupplied =
    Object.prototype.hasOwnProperty.call(input, 'instrumentDescriptor') &&
    input['instrumentDescriptor'] !== undefined;
  const instrumentDescriptor = canonicalInstrumentDescriptor(
    functionName,
    input['instrument'],
    input['instrumentDescriptor'],
    descriptorWasSupplied,
  );
  const instrumentDescriptorHash = contentHash(instrumentDescriptor);
  const withoutTargetHash = targetHashPayload({
    ...base,
    valuationMethod: 'full-revaluation',
    instrumentDescriptor,
    instrumentDescriptorHash,
    pricer: pricerDescriptor,
  } as Omit<FullRevaluationScenarioTargetDescriptor, 'targetDescriptorHash'>);
  const descriptor = detachCanonicalData<FullRevaluationScenarioTargetDescriptor>(
    { ...withoutTargetHash, targetDescriptorHash: contentHash(withoutTargetHash) },
    { functionName, label: 'target descriptor', requireFiniteNumbers: true },
  );
  return attachTarget(descriptor, {
    instrument: input['instrument'],
    pricer: pricer as unknown as Pricer<unknown, PricerValuationResult>,
  });
}

function requiredTaylorFactors(sensitivities: TaylorSensitivities): Set<keyof TaylorFactors> {
  const required = new Set<keyof TaylorFactors>();
  const add = (...factors: (keyof TaylorFactors)[]): void => {
    for (const factor of factors) required.add(factor);
  };
  if (sensitivities.delta !== undefined || sensitivities.gamma !== undefined) add('spot');
  if (sensitivities.vega !== undefined || sensitivities.vomma !== undefined) add('volatility');
  if (sensitivities.rho !== undefined || sensitivities.rhoConvexity !== undefined)
    add('riskFreeRate');
  if (sensitivities.theta !== undefined || sensitivities.thetaConvexity !== undefined)
    add('valuationInstant');
  if (sensitivities.vanna !== undefined) add('spot', 'volatility');
  if (sensitivities.charm !== undefined) add('spot', 'valuationInstant');
  if (sensitivities.veta !== undefined) add('volatility', 'valuationInstant');
  if (sensitivities.vera !== undefined) add('volatility', 'riskFreeRate');
  if (sensitivities.deltaRate !== undefined) add('spot', 'riskFreeRate');
  if (sensitivities.thetaRate !== undefined) add('valuationInstant', 'riskFreeRate');
  if (sensitivities.phi !== undefined) add('dividend');
  return required;
}

function validateTaylorData(
  functionName: string,
  rawGreeks: unknown,
  rawFactors: unknown,
): { readonly sensitivities: Readonly<TaylorSensitivities>; readonly factors: TaylorFactors } {
  const greekRecord = snapshotClosedRecord(rawGreeks, {
    functionName,
    label: 'input.greeks',
    allowedKeys: SENSITIVITY_KEYS,
  });
  const sensitivities: TaylorSensitivities = {};
  for (const key of SENSITIVITY_KEYS) {
    if (greekRecord[key] !== undefined) {
      sensitivities[key] = requireFiniteNumber(
        functionName,
        `input.greeks.${key}`,
        greekRecord[key],
      );
    }
  }
  if (Object.keys(sensitivities).length === 0) {
    targetError(
      functionName,
      'input.greeks',
      'must contain at least one finite Taylor sensitivity.',
      ErrorCode.InputMissingField,
    );
  }

  const factorRecord = snapshotClosedRecord(rawFactors, {
    functionName,
    label: 'input.factors',
    allowedKeys: FACTOR_KEYS,
  });
  const required = requiredTaylorFactors(sensitivities);
  const factors: Partial<Record<keyof TaylorFactors, unknown>> = {};
  for (const key of FACTOR_KEYS) {
    const value = factorRecord[key];
    if (value === undefined) {
      if (required.has(key)) {
        targetError(
          functionName,
          `input.factors.${key}`,
          'is required by the supplied sensitivities.',
          ErrorCode.InputMissingField,
        );
      }
      continue;
    }
    if (!required.has(key)) {
      targetError(
        functionName,
        `input.factors.${key}`,
        'has no supplied sensitivity that can consume it — remove the unused factor.',
        ErrorCode.InputUnknownField,
      );
    }
    if (key === 'valuationInstant') {
      const record = snapshotClosedRecord(value, {
        functionName,
        label: `input.factors.${key}`,
        allowedKeys: ['level'],
        requiredKeys: ['level'],
      });
      factors[key] = {
        level: requireEpochMs(functionName, `input.factors.${key}.level`, record['level']),
      };
    } else {
      const record = snapshotClosedRecord(value, {
        functionName,
        label: `input.factors.${key}`,
        allowedKeys: ['subject', 'level'],
        requiredKeys: ['subject', 'level'],
      });
      factors[key] = {
        subject: requireNonEmptyString(
          functionName,
          `input.factors.${key}.subject`,
          record['subject'],
        ),
        level: requireFiniteNumber(functionName, `input.factors.${key}.level`, record['level']),
      };
    }
  }
  return detachCanonicalData(
    { sensitivities, factors },
    { functionName, label: 'Taylor descriptor', requireFiniteNumbers: true },
  ) as { readonly sensitivities: Readonly<TaylorSensitivities>; readonly factors: TaylorFactors };
}

function taylor(rawInput: TaylorScenarioTargetInput): ScenarioTarget {
  const functionName = 'scenarioTarget.taylor';
  const input = snapshotClosedRecord(rawInput, {
    functionName,
    label: 'input',
    allowedKeys: TAYLOR_INPUT_KEYS,
    requiredKeys: [
      'id',
      'quantity',
      'contractMultiplier',
      'currency',
      'baseValuePerUnit',
      'greeks',
      'factors',
    ],
  });
  const base = validateBase(functionName, input);
  const baseValuePerUnit = requireFiniteNumber(
    functionName,
    'input.baseValuePerUnit',
    input['baseValuePerUnit'],
  );
  const { sensitivities, factors } = validateTaylorData(
    functionName,
    input['greeks'],
    input['factors'],
  );
  const taylorDescriptor = detachCanonicalData(
    { baseValuePerUnit, sensitivities, factors },
    { functionName, label: 'target taylor descriptor', requireFiniteNumbers: true },
  );
  const withoutTargetHash = targetHashPayload({
    ...base,
    valuationMethod: 'taylor',
    taylor: taylorDescriptor,
    taylorDescriptorHash: contentHash(taylorDescriptor),
  } as Omit<TaylorScenarioTargetDescriptor, 'targetDescriptorHash'>);
  const descriptor = detachCanonicalData<TaylorScenarioTargetDescriptor>(
    { ...withoutTargetHash, targetDescriptorHash: contentHash(withoutTargetHash) },
    { functionName, label: 'target descriptor', requireFiniteNumbers: true },
  );
  return attachTarget(descriptor, null);
}

function spot(rawInput: SpotScenarioTargetInput): ScenarioTarget {
  const functionName = 'scenarioTarget.spot';
  const input = snapshotClosedRecord(rawInput, {
    functionName,
    label: 'input',
    allowedKeys: SPOT_INPUT_KEYS,
    requiredKeys: ['id', 'symbol', 'quantity', 'currency'],
  });
  const symbol = requireNonEmptyString(functionName, 'input.symbol', input['symbol']);
  return fullRevaluation({
    id: requireNonEmptyString(functionName, 'input.id', input['id']),
    quantity: requireFiniteNumber(functionName, 'input.quantity', input['quantity']),
    contractMultiplier: 1,
    currency: input['currency'] as string,
    underlying: symbol,
    ...(input['strategy'] !== undefined ? { strategy: input['strategy'] as string } : {}),
    ...(input['account'] !== undefined ? { account: input['account'] as string } : {}),
    ...(input['book'] !== undefined ? { book: input['book'] as string } : {}),
    ...(input['tags'] !== undefined ? { tags: input['tags'] as readonly string[] } : {}),
    instrument: { symbol },
    instrumentDescriptor: { kind: 'spot-asset', symbol },
    pricer: spotAssetPricer(),
  } as FullRevaluationScenarioTargetInput<{ symbol: string }>);
}

/** Builder namespace for opaque, immutable scenario targets. */
export const scenarioTarget: ScenarioTargetBuilders = Object.freeze({
  fullRevaluation,
  taylor,
  spot,
});

function descriptorHashPayload(descriptor: ScenarioTargetDescriptor): unknown {
  const payload: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptor)) {
    if (typeof key !== 'string' || key === 'targetDescriptorHash') continue;
    const property = Object.getOwnPropertyDescriptor(descriptor, key);
    if (property !== undefined && 'value' in property) payload[key] = property.value;
  }
  return payload;
}

/** Validate one opaque target and recover its private behavior binding for the runner. */
export function validateScenarioTarget(
  value: unknown,
  targetIndex: number,
): ValidatedScenarioTarget {
  const functionName = 'runScenarios';
  const label = `targets[${targetIndex}]`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    targetError(functionName, label, 'must be produced by scenarioTarget.*.');
  }
  const object = value as object;
  if (Object.getPrototypeOf(object) !== Object.prototype || !Object.isFrozen(object)) {
    targetError(
      functionName,
      label,
      'must be the frozen opaque value returned by scenarioTarget.*; hand-assembled targets are not accepted.',
    );
  }
  const brand = Object.getOwnPropertyDescriptor(object, TARGET_BRAND);
  if (
    brand === undefined ||
    brand.enumerable ||
    brand.configurable ||
    !('value' in brand) ||
    brand.value !== true ||
    brand.writable
  ) {
    targetError(functionName, label, 'does not carry an intact builder-owned target brand.');
  }
  const publicKeys: string[] = [];
  for (const key of Reflect.ownKeys(object)) {
    if (key === TARGET_BRAND || key === FULL_REVALUATION_BINDING) continue;
    if (typeof key !== 'string') {
      targetError(functionName, label, `contains an unrecognized symbol ${String(key)}.`);
    }
    const property = Object.getOwnPropertyDescriptor(object, key);
    if (property === undefined || !property.enumerable || !('value' in property)) {
      targetError(functionName, `${label}.${key}`, 'must be an enumerable own stored-data field.');
    }
    publicKeys.push(key);
  }
  const methodProperty = Object.getOwnPropertyDescriptor(object, 'valuationMethod');
  const method =
    methodProperty !== undefined && 'value' in methodProperty ? methodProperty.value : undefined;
  const allowed =
    method === 'full-revaluation'
      ? [
          ...TARGET_BASE_DESCRIPTOR_KEYS,
          'valuationMethod',
          'instrumentDescriptor',
          'instrumentDescriptorHash',
          'pricer',
        ]
      : method === 'taylor'
        ? [...TARGET_BASE_DESCRIPTOR_KEYS, 'valuationMethod', 'taylor', 'taylorDescriptorHash']
        : [];
  const unknown = publicKeys.filter((key) => !allowed.includes(key as never));
  const missing = allowed.filter((key) => !publicKeys.includes(key));
  for (const optional of ['underlying', 'strategy', 'account', 'book']) {
    const index = missing.indexOf(optional);
    if (index >= 0) missing.splice(index, 1);
  }
  if (unknown.length > 0 || missing.length > 0) {
    targetError(
      functionName,
      label,
      `has descriptor-key drift (unknown: ${unknown.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}).`,
      unknown.length > 0 ? ErrorCode.InputUnknownField : ErrorCode.InputMissingField,
    );
  }

  const target = value as ScenarioTarget;
  scanCanonicalData(target, {
    functionName,
    label,
    ignoredSymbols: new Set([TARGET_BRAND, FULL_REVALUATION_BINDING]),
    requireFiniteNumbers: true,
  });
  validateBase(functionName, target as unknown as Record<string, unknown>);
  const expectedTargetHash = contentHash(descriptorHashPayload(target));
  if (target.targetDescriptorHash !== expectedTargetHash) {
    targetError(
      functionName,
      `${label}.targetDescriptorHash`,
      'does not match the complete public descriptor — rebuild the target with scenarioTarget.*.',
      ErrorCode.InputOutOfRange,
    );
  }
  // The opaque target shell intentionally carries two private symbols. Everything handed to
  // resolvers, handlers, axes, and replay is a separate behavior-free public descriptor.
  const publicDescriptor = detachCanonicalData<ScenarioTargetDescriptor>(
    { ...target },
    { functionName, label: `${label} public descriptor`, requireFiniteNumbers: true },
  );

  if (target.valuationMethod === 'taylor') {
    if (contentHash(target.taylor) !== target.taylorDescriptorHash) {
      targetError(
        functionName,
        `${label}.taylorDescriptorHash`,
        'does not match target.taylor.',
        ErrorCode.InputOutOfRange,
      );
    }
    validateTaylorData(functionName, target.taylor.sensitivities, target.taylor.factors);
    return { target, descriptor: publicDescriptor, binding: null };
  }

  if (contentHash(target.instrumentDescriptor) !== target.instrumentDescriptorHash) {
    targetError(
      functionName,
      `${label}.instrumentDescriptorHash`,
      'does not match target.instrumentDescriptor.',
      ErrorCode.InputOutOfRange,
    );
  }
  const bindingProperty = Object.getOwnPropertyDescriptor(object, FULL_REVALUATION_BINDING);
  if (
    bindingProperty === undefined ||
    bindingProperty.enumerable ||
    bindingProperty.configurable ||
    !('value' in bindingProperty) ||
    bindingProperty.writable ||
    bindingProperty.value === null ||
    typeof bindingProperty.value !== 'object' ||
    !Object.isFrozen(bindingProperty.value)
  ) {
    targetError(functionName, label, 'does not carry an intact full-revaluation behavior binding.');
  }
  const binding = bindingProperty.value as FullRevaluationBinding;
  if (
    binding.pricer.name !== target.pricer.name ||
    binding.pricer.version !== target.pricer.version ||
    contentHash(binding.pricer.capabilities) !== contentHash(target.pricer.capabilities)
  ) {
    targetError(
      functionName,
      label,
      'has a pricer binding whose identity or capabilities differ from its public descriptor.',
      ErrorCode.InputOutOfRange,
    );
  }
  return { target, descriptor: publicDescriptor, binding };
}

export const scenarioTargetPrivateSymbols: ReadonlySet<symbol> = new Set([
  TARGET_BRAND,
  FULL_REVALUATION_BINDING,
]);
