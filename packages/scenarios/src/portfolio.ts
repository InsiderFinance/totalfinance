import { ErrorCode, InputError, isQuantError } from '@totalfinance/core';
import { contentHash } from '@totalfinance/core/artifacts';
import { definePricer, type Pricer, type PricerValuationResult } from '@totalfinance/core/pricing';
import {
  applyPortfolioEvents,
  type PortfolioState,
  type PositionState,
} from '@totalfinance/portfolio';
import {
  detachCanonicalData,
  readPlainArrayLength,
  scanCanonicalData,
  snapshotClosedRecord,
  snapshotDenseArray,
} from './internal/data.js';
import { scenarioTarget } from './targets.js';
import type {
  FullRevaluationScenarioPortfolioBindingDescriptor,
  FullRevaluationScenarioPortfolioBindingInput,
  ScenarioPortfolioBinding,
  ScenarioPortfolioBindingBuilders,
  ScenarioPortfolioBindingDescriptor,
  ScenarioPricerDescriptor,
  ScenarioTarget,
  ScenarioTargetsFromPortfolioInput,
  TaylorScenarioPortfolioBindingDescriptor,
  TaylorScenarioPortfolioBindingInput,
} from './types.js';

export type {
  FullRevaluationScenarioPortfolioBindingDescriptor,
  FullRevaluationScenarioPortfolioBindingInput,
  ScenarioPortfolioBinding,
  ScenarioPortfolioBindingBaseInput,
  ScenarioPortfolioBindingBuilders,
  ScenarioPortfolioBindingDescriptor,
  ScenarioPortfolioBindingDescriptorBase,
  ScenarioTargetsFromPortfolioInput,
  TaylorScenarioPortfolioBindingDescriptor,
  TaylorScenarioPortfolioBindingInput,
} from './types.js';

const PORTFOLIO_BINDING_BRAND = Symbol('totalfinance.scenarios.portfolio-binding.brand');
const FULL_REVALUATION_BEHAVIOR = Symbol(
  'totalfinance.scenarios.portfolio-binding.full-revaluation-behavior',
);

const BASE_INPUT_KEYS = ['id', 'accountId', 'instrumentId', 'strategy', 'book', 'tags'] as const;
const FULL_REVALUATION_INPUT_KEYS = [
  ...BASE_INPUT_KEYS,
  'instrument',
  'instrumentDescriptor',
  'pricer',
] as const;
const TAYLOR_INPUT_KEYS = [...BASE_INPUT_KEYS, 'baseValuePerUnit', 'greeks', 'factors'] as const;
const ADAPTER_INPUT_KEYS = ['state', 'bindings'] as const;

const BASE_DESCRIPTOR_KEYS = [
  'id',
  'accountId',
  'instrumentId',
  'strategy',
  'book',
  'tags',
  'bindingDescriptorHash',
] as const;
const FULL_REVALUATION_DESCRIPTOR_KEYS = [
  ...BASE_DESCRIPTOR_KEYS,
  'valuationMethod',
  'instrumentDescriptor',
  'instrumentDescriptorHash',
  'pricer',
] as const;
const TAYLOR_DESCRIPTOR_KEYS = [
  ...BASE_DESCRIPTOR_KEYS,
  'valuationMethod',
  'taylor',
  'taylorDescriptorHash',
] as const;

interface FullRevaluationBehavior {
  readonly instrument: unknown;
  readonly pricer: Pricer<unknown, PricerValuationResult>;
}

interface ValidatedPortfolioBinding {
  readonly descriptor: ScenarioPortfolioBindingDescriptor;
  readonly behavior: FullRevaluationBehavior | null;
}

interface ValidatedBindingBase {
  readonly id: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly strategy?: string;
  readonly book?: string;
  readonly tags: readonly string[];
}

function bindingError(
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
    bindingError(functionName, field, 'must be a non-empty string.');
  }
  return value;
}

function optionalString(functionName: string, field: string, value: unknown): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(functionName, field, value);
}

function requireTags(functionName: string, value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  const count = readPlainArrayLength(value, functionName, 'input.tags');
  if (count > 128) {
    bindingError(
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
      bindingError(
        functionName,
        `input.tags[${index}]`,
        `duplicates ${JSON.stringify(tag)} — binding tags must be unique.`,
        ErrorCode.InputOutOfRange,
      );
    }
    seen.add(tag);
    tags.push(tag);
  }
  return Object.freeze(tags);
}

function validateBase(
  functionName: string,
  input: Readonly<Record<string, unknown>>,
): ValidatedBindingBase {
  const strategy = optionalString(functionName, 'input.strategy', input['strategy']);
  const book = optionalString(functionName, 'input.book', input['book']);
  return {
    id: requireNonEmptyString(functionName, 'input.id', input['id']),
    accountId: requireNonEmptyString(functionName, 'input.accountId', input['accountId']),
    instrumentId: requireNonEmptyString(functionName, 'input.instrumentId', input['instrumentId']),
    ...(strategy !== undefined ? { strategy } : {}),
    ...(book !== undefined ? { book } : {}),
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
  try {
    return detachCanonicalData(wasSupplied ? supplied : instrument, {
      functionName,
      label: wasSupplied ? 'input.instrumentDescriptor' : 'input.instrument',
      requireFiniteNumbers: true,
    });
  } catch (error) {
    if (!wasSupplied) {
      throw new InputError(
        `${functionName}: input.instrument cannot be derived into a canonical replay descriptor — supply input.instrumentDescriptor as plain JSON-safe stored data. The binding retains behavior separately and never serializes it blindly.`,
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

function attachBinding(
  descriptor: ScenarioPortfolioBindingDescriptor,
  behavior: FullRevaluationBehavior | null,
): ScenarioPortfolioBinding {
  const binding = { ...descriptor } as ScenarioPortfolioBinding;
  Object.defineProperty(binding, PORTFOLIO_BINDING_BRAND, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  if (behavior !== null) {
    Object.defineProperty(binding, FULL_REVALUATION_BEHAVIOR, {
      configurable: false,
      enumerable: false,
      value: Object.freeze(behavior),
      writable: false,
    });
  }
  return Object.freeze(binding);
}

function fullRevaluation<TInstrument>(
  rawInput: FullRevaluationScenarioPortfolioBindingInput<TInstrument>,
): ScenarioPortfolioBinding {
  const functionName = 'scenarioPortfolioBinding.fullRevaluation';
  const input = snapshotClosedRecord(rawInput, {
    functionName,
    label: 'input',
    allowedKeys: FULL_REVALUATION_INPUT_KEYS,
    requiredKeys: ['id', 'accountId', 'instrumentId', 'instrument', 'pricer'],
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
  const withoutBindingHash = {
    ...base,
    valuationMethod: 'full-revaluation' as const,
    instrumentDescriptor,
    instrumentDescriptorHash,
    pricer: pricerDescriptor,
  };
  const descriptor = detachCanonicalData<FullRevaluationScenarioPortfolioBindingDescriptor>(
    {
      ...withoutBindingHash,
      bindingDescriptorHash: contentHash(withoutBindingHash),
    },
    { functionName, label: 'binding descriptor', requireFiniteNumbers: true },
  );
  return attachBinding(descriptor, {
    instrument: input['instrument'],
    pricer: pricer as unknown as Pricer<unknown, PricerValuationResult>,
  });
}

function taylor(rawInput: TaylorScenarioPortfolioBindingInput): ScenarioPortfolioBinding {
  const functionName = 'scenarioPortfolioBinding.taylor';
  const input = snapshotClosedRecord(rawInput, {
    functionName,
    label: 'input',
    allowedKeys: TAYLOR_INPUT_KEYS,
    requiredKeys: ['id', 'accountId', 'instrumentId', 'baseValuePerUnit', 'greeks', 'factors'],
  });
  const base = validateBase(functionName, input);
  let target: ScenarioTarget;
  try {
    target = scenarioTarget.taylor({
      id: base.id,
      quantity: 1,
      contractMultiplier: 1,
      currency: 'USD',
      baseValuePerUnit: input['baseValuePerUnit'] as number,
      greeks: input['greeks'] as TaylorScenarioPortfolioBindingInput['greeks'],
      factors: input['factors'] as TaylorScenarioPortfolioBindingInput['factors'],
    });
  } catch (error) {
    if (isQuantError(error)) {
      throw new InputError(error.message.replace(/^scenarioTarget\.taylor:/, `${functionName}:`), {
        code: error.code,
        context: { ...error.context, function: functionName },
        cause: error,
      });
    }
    throw error;
  }
  if (target.valuationMethod !== 'taylor') {
    bindingError(functionName, 'input', 'failed to produce a Taylor descriptor.');
  }
  const taylorDescriptor = target.taylor;
  const withoutBindingHash = {
    ...base,
    valuationMethod: 'taylor' as const,
    taylor: taylorDescriptor,
    taylorDescriptorHash: target.taylorDescriptorHash,
  };
  const descriptor = detachCanonicalData<TaylorScenarioPortfolioBindingDescriptor>(
    {
      ...withoutBindingHash,
      bindingDescriptorHash: contentHash(withoutBindingHash),
    },
    { functionName, label: 'binding descriptor', requireFiniteNumbers: true },
  );
  return attachBinding(descriptor, null);
}

/** Opaque builder namespace for durable portfolio-to-scenario bindings. */
export const scenarioPortfolioBinding: ScenarioPortfolioBindingBuilders = Object.freeze({
  fullRevaluation,
  taylor,
});

function descriptorHashPayload(descriptor: ScenarioPortfolioBindingDescriptor): unknown {
  const payload: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptor)) {
    if (typeof key !== 'string' || key === 'bindingDescriptorHash') continue;
    const property = Object.getOwnPropertyDescriptor(descriptor, key);
    if (property !== undefined && 'value' in property) payload[key] = property.value;
  }
  return payload;
}

function requirePrivateStoredProperty(
  object: object,
  symbol: symbol,
  functionName: string,
  label: string,
): unknown {
  const property = Object.getOwnPropertyDescriptor(object, symbol);
  if (
    property === undefined ||
    property.enumerable ||
    property.configurable ||
    !('value' in property) ||
    property.writable
  ) {
    bindingError(functionName, label, 'does not carry an intact builder-owned binding.');
  }
  return property.value;
}

function validatePortfolioBinding(value: unknown, bindingIndex: number): ValidatedPortfolioBinding {
  const functionName = 'scenarioTargetsFromPortfolio';
  const label = `bindings[${bindingIndex}]`;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    bindingError(functionName, label, 'must be produced by scenarioPortfolioBinding.*.');
  }
  const object = value as object;
  if (Object.getPrototypeOf(object) !== Object.prototype || !Object.isFrozen(object)) {
    bindingError(
      functionName,
      label,
      'must be the frozen opaque value returned by scenarioPortfolioBinding.*.',
    );
  }
  if (requirePrivateStoredProperty(object, PORTFOLIO_BINDING_BRAND, functionName, label) !== true) {
    bindingError(functionName, label, 'does not carry an intact builder-owned binding brand.');
  }

  const methodProperty = Object.getOwnPropertyDescriptor(object, 'valuationMethod');
  const method =
    methodProperty !== undefined && 'value' in methodProperty ? methodProperty.value : undefined;
  const allowed =
    method === 'full-revaluation'
      ? FULL_REVALUATION_DESCRIPTOR_KEYS
      : method === 'taylor'
        ? TAYLOR_DESCRIPTOR_KEYS
        : [];
  const publicKeys: string[] = [];
  for (const key of Reflect.ownKeys(object)) {
    if (key === PORTFOLIO_BINDING_BRAND || key === FULL_REVALUATION_BEHAVIOR) continue;
    if (typeof key !== 'string') {
      bindingError(functionName, label, `contains an unrecognized symbol ${String(key)}.`);
    }
    const property = Object.getOwnPropertyDescriptor(object, key);
    if (property === undefined || !property.enumerable || !('value' in property)) {
      bindingError(functionName, `${label}.${key}`, 'must be an enumerable own stored-data field.');
    }
    publicKeys.push(key);
  }
  const unknown = publicKeys.filter((key) => !allowed.includes(key as never));
  const missing: string[] = allowed.filter((key) => !publicKeys.includes(key));
  for (const optional of ['strategy', 'book']) {
    const index = missing.indexOf(optional);
    if (index >= 0) missing.splice(index, 1);
  }
  if (unknown.length > 0 || missing.length > 0) {
    bindingError(
      functionName,
      label,
      `has descriptor-key drift (unknown: ${unknown.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}).`,
      unknown.length > 0 ? ErrorCode.InputUnknownField : ErrorCode.InputMissingField,
    );
  }

  const descriptor = value as ScenarioPortfolioBinding;
  scanCanonicalData(descriptor, {
    functionName,
    label,
    ignoredSymbols: new Set([PORTFOLIO_BINDING_BRAND, FULL_REVALUATION_BEHAVIOR]),
    requireFiniteNumbers: true,
  });
  validateBase(functionName, descriptor as unknown as Readonly<Record<string, unknown>>);
  if (contentHash(descriptorHashPayload(descriptor)) !== descriptor.bindingDescriptorHash) {
    bindingError(
      functionName,
      `${label}.bindingDescriptorHash`,
      'does not match the complete public descriptor — rebuild the binding with scenarioPortfolioBinding.*.',
      ErrorCode.InputOutOfRange,
    );
  }

  if (descriptor.valuationMethod === 'taylor') {
    if (Object.prototype.hasOwnProperty.call(object, FULL_REVALUATION_BEHAVIOR)) {
      bindingError(functionName, label, 'a Taylor binding cannot carry full-revaluation behavior.');
    }
    if (contentHash(descriptor.taylor) !== descriptor.taylorDescriptorHash) {
      bindingError(
        functionName,
        `${label}.taylorDescriptorHash`,
        'does not match its Taylor descriptor.',
        ErrorCode.InputOutOfRange,
      );
    }
    return { descriptor, behavior: null };
  }

  if (contentHash(descriptor.instrumentDescriptor) !== descriptor.instrumentDescriptorHash) {
    bindingError(
      functionName,
      `${label}.instrumentDescriptorHash`,
      'does not match its instrument descriptor.',
      ErrorCode.InputOutOfRange,
    );
  }
  const rawBehavior = requirePrivateStoredProperty(
    object,
    FULL_REVALUATION_BEHAVIOR,
    functionName,
    label,
  );
  if (rawBehavior === null || typeof rawBehavior !== 'object' || !Object.isFrozen(rawBehavior)) {
    bindingError(functionName, label, 'does not carry an intact full-revaluation behavior pair.');
  }
  const behavior = rawBehavior as FullRevaluationBehavior;
  if (
    behavior.pricer.name !== descriptor.pricer.name ||
    behavior.pricer.version !== descriptor.pricer.version ||
    contentHash(behavior.pricer.capabilities) !== contentHash(descriptor.pricer.capabilities)
  ) {
    bindingError(
      functionName,
      label,
      'has a pricer behavior whose identity or capabilities differ from its public descriptor.',
      ErrorCode.InputOutOfRange,
    );
  }
  return { descriptor, behavior };
}

function pairKey(accountId: string, instrumentId: string): string {
  return JSON.stringify([accountId, instrumentId]);
}

function positionEntries(state: PortfolioState): readonly {
  readonly accountId: string;
  readonly instrumentId: string;
  readonly position: PositionState;
}[] {
  const entries: Array<{
    accountId: string;
    instrumentId: string;
    position: PositionState;
  }> = [];
  for (const accountId of Object.keys(state.accounts).sort()) {
    const account = state.accounts[accountId]!;
    for (const instrumentId of Object.keys(account.positions).sort()) {
      entries.push({ accountId, instrumentId, position: account.positions[instrumentId]! });
    }
  }
  return entries;
}

/**
 * Convert every open position in one validated durable portfolio snapshot into exactly one opaque
 * scenario target. Ledger facts remain authoritative; bindings contribute only identity,
 * valuation behavior, and optional strategy/book/tag metadata.
 */
export function scenarioTargetsFromPortfolio(
  rawInput: ScenarioTargetsFromPortfolioInput,
): readonly ScenarioTarget[] {
  const functionName = 'scenarioTargetsFromPortfolio';
  const input = snapshotClosedRecord(rawInput, {
    functionName,
    label: 'input',
    allowedKeys: ADAPTER_INPUT_KEYS,
    requiredKeys: ['state', 'bindings'],
  });

  // This public empty fold is FC7's canonical, complete PortfolioState validation and detachment
  // door. Never inspect the caller's original nested state before or after this call.
  const state = applyPortfolioEvents({
    previousState: input['state'] as PortfolioState,
    events: [],
  });
  const positions = positionEntries(state);
  const bindingCount = readPlainArrayLength(input['bindings'], functionName, 'input.bindings');
  if (bindingCount !== positions.length) {
    bindingError(
      functionName,
      'input.bindings',
      `must contain exactly one binding for each of the ${positions.length} open positions; received ${bindingCount}.`,
      bindingCount < positions.length ? ErrorCode.InputMissingField : ErrorCode.InputOutOfRange,
    );
  }
  const rawBindings = snapshotDenseArray(input['bindings'], functionName, 'input.bindings');
  const openPairs = new Set(
    positions.map(({ accountId, instrumentId }) => pairKey(accountId, instrumentId)),
  );
  const byPair = new Map<string, ValidatedPortfolioBinding>();
  const targetIds = new Set<string>();

  for (let index = 0; index < rawBindings.length; index++) {
    const binding = validatePortfolioBinding(rawBindings[index], index);
    const { accountId, instrumentId, id } = binding.descriptor;
    const key = pairKey(accountId, instrumentId);
    if (byPair.has(key)) {
      bindingError(
        functionName,
        `input.bindings[${index}]`,
        `duplicates the binding for open position (${JSON.stringify(accountId)}, ${JSON.stringify(instrumentId)}); exactly one binding is required per position.`,
        ErrorCode.InputOutOfRange,
      );
    }
    if (targetIds.has(id)) {
      bindingError(
        functionName,
        `input.bindings[${index}].id`,
        `duplicates target ID ${JSON.stringify(id)}; scenario target IDs must be unique.`,
        ErrorCode.InputOutOfRange,
      );
    }
    if (!openPairs.has(key)) {
      bindingError(
        functionName,
        `input.bindings[${index}]`,
        `names unknown or closed position (${JSON.stringify(accountId)}, ${JSON.stringify(instrumentId)}); bindings may name only open positions in the supplied state.`,
        ErrorCode.InputOutOfRange,
      );
    }
    byPair.set(key, binding);
    targetIds.add(id);
  }

  const targets: ScenarioTarget[] = [];
  for (const { accountId, instrumentId, position } of positions) {
    const binding = byPair.get(pairKey(accountId, instrumentId));
    if (binding === undefined) {
      bindingError(
        functionName,
        'input.bindings',
        `is missing the binding for open position (${JSON.stringify(accountId)}, ${JSON.stringify(instrumentId)}); supply exactly one scenarioPortfolioBinding.* value for every open position.`,
        ErrorCode.InputMissingField,
      );
    }
    const descriptor = binding.descriptor;
    const base = {
      id: descriptor.id,
      quantity: position.quantity,
      contractMultiplier: position.contractMultiplier,
      currency: position.currency,
      underlying: position.contract?.underlyingInstrumentId ?? instrumentId,
      account: accountId,
      ...(descriptor.strategy !== undefined ? { strategy: descriptor.strategy } : {}),
      ...(descriptor.book !== undefined ? { book: descriptor.book } : {}),
      tags: descriptor.tags,
    };
    if (descriptor.valuationMethod === 'taylor') {
      targets.push(
        scenarioTarget.taylor({
          ...base,
          baseValuePerUnit: descriptor.taylor.baseValuePerUnit,
          greeks: descriptor.taylor.sensitivities,
          factors: descriptor.taylor.factors,
        }),
      );
      continue;
    }
    if (binding.behavior === null) {
      bindingError(
        functionName,
        `binding ${JSON.stringify(descriptor.id)}`,
        'lost its full-revaluation behavior pair.',
      );
    }
    targets.push(
      scenarioTarget.fullRevaluation({
        ...base,
        instrument: binding.behavior.instrument,
        instrumentDescriptor: descriptor.instrumentDescriptor,
        pricer: binding.behavior.pricer,
      }),
    );
  }
  return Object.freeze(targets);
}
