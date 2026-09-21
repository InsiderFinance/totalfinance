import { ErrorCode, InputError, type RateCurve } from '@totalfinance/core';
import type { MarketObservation } from '@totalfinance/core/pricing';
import { readPlainArrayLength, snapshotClosedRecord, snapshotDenseArray } from './data.js';
import type {
  ScenarioBehaviorIdentity,
  ScenarioFactorHandler,
  ScenarioMarketResolver,
} from '../types.js';

interface StoredDescriptorSnapshot {
  readonly key: PropertyKey;
  readonly descriptor: PropertyDescriptor;
}

interface BehaviorSnapshotBase {
  readonly object: object;
  readonly identity: ScenarioBehaviorIdentity;
  readonly descriptors: readonly StoredDescriptorSnapshot[];
}

export interface ResolverSnapshot extends BehaviorSnapshotBase {
  readonly resolve: ScenarioMarketResolver['resolve'];
}

export interface FactorHandlerSnapshot extends BehaviorSnapshotBase {
  readonly factor: string;
  readonly apply: ScenarioFactorHandler['apply'];
}

function behaviorError(functionName: string, field: string, message: string): never {
  throw new InputError(`${functionName}: ${field} ${message}`, {
    code: ErrorCode.InputWrongType,
    context: { function: functionName, field },
  });
}

function requireNonEmptyString(functionName: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    behaviorError(functionName, field, 'must be a non-empty string.');
  }
  return value;
}

function snapshotDescriptors(object: object): readonly StoredDescriptorSnapshot[] {
  return Object.freeze(
    Reflect.ownKeys(object).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined) {
        throw new InputError('runScenarios: a behavior descriptor disappeared during preflight.', {
          code: ErrorCode.InputWrongType,
          context: { function: 'runScenarios' },
        });
      }
      return Object.freeze({ key, descriptor: Object.freeze({ ...descriptor }) });
    }),
  );
}

function descriptorsEqual(first: PropertyDescriptor, second: PropertyDescriptor): boolean {
  return (
    first.configurable === second.configurable &&
    first.enumerable === second.enumerable &&
    first.writable === second.writable &&
    first.value === second.value &&
    first.get === second.get &&
    first.set === second.set
  );
}

/** Refuse callback self-mutation after every invocation. */
export function assertBehaviorUnchanged(
  functionName: string,
  label: string,
  snapshot: BehaviorSnapshotBase,
): void {
  const keys = Reflect.ownKeys(snapshot.object);
  if (keys.length !== snapshot.descriptors.length) {
    behaviorError(
      functionName,
      label,
      'mutated its own field set while running — callbacks are snapshotted immutable definitions.',
    );
  }
  for (let index = 0; index < snapshot.descriptors.length; index++) {
    const expected = snapshot.descriptors[index]!;
    if (keys[index] !== expected.key) {
      behaviorError(functionName, label, 'changed or reordered its own fields while running.');
    }
    const actual = Object.getOwnPropertyDescriptor(snapshot.object, expected.key);
    if (actual === undefined || !descriptorsEqual(actual, expected.descriptor)) {
      behaviorError(
        functionName,
        label,
        `mutated ${String(expected.key)} while running — resolver/handler identity and behavior are immutable for one run.`,
      );
    }
  }
}

function ensureUniqueIdentities(
  functionName: string,
  label: string,
  identities: readonly ScenarioBehaviorIdentity[],
): void {
  const seen = new Set<string>();
  for (let index = 0; index < identities.length; index++) {
    const identity = identities[index]!;
    const key = `${identity.name}\u0000${identity.version}`;
    if (seen.has(key)) {
      throw new InputError(
        `${functionName}: ${label}[${index}] duplicates behavior identity ${JSON.stringify(identity.name)} @ ${JSON.stringify(identity.version)} — names and versions must identify one callback per run.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `${label}[${index}]`, ...identity },
        },
      );
    }
    seen.add(key);
  }
}

/** Snapshot and validate all per-call market resolvers without invoking them. */
export function snapshotResolvers(
  value: unknown,
  functionName = 'runScenarios',
): readonly ResolverSnapshot[] {
  if (value === undefined) return Object.freeze([]);
  const count = readPlainArrayLength(value, functionName, 'options.marketResolvers');
  if (count > 32) {
    throw new InputError(
      `${functionName}: options.marketResolvers may contain at most 32 resolvers; received ${count}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'options.marketResolvers', count },
      },
    );
  }
  const list = snapshotDenseArray(value, functionName, 'options.marketResolvers');
  const snapshots = list.map((valueAtIndex, index): ResolverSnapshot => {
    const label = `options.marketResolvers[${index}]`;
    const record = snapshotClosedRecord(valueAtIndex, {
      functionName,
      label,
      allowedKeys: ['name', 'version', 'resolve'],
      requiredKeys: ['name', 'version', 'resolve'],
    });
    const name = requireNonEmptyString(functionName, `${label}.name`, record['name']);
    const version = requireNonEmptyString(functionName, `${label}.version`, record['version']);
    if (typeof record['resolve'] !== 'function') {
      behaviorError(functionName, `${label}.resolve`, 'must be a synchronous function.');
    }
    const object = valueAtIndex as object;
    return Object.freeze({
      object,
      identity: Object.freeze({ name, version }),
      descriptors: snapshotDescriptors(object),
      resolve: record['resolve'] as ScenarioMarketResolver['resolve'],
    });
  });
  ensureUniqueIdentities(
    functionName,
    'options.marketResolvers',
    snapshots.map((snapshot) => snapshot.identity),
  );
  return Object.freeze(snapshots);
}

/** Snapshot and validate all per-call custom factor handlers without invoking them. */
export function snapshotFactorHandlers(
  value: unknown,
  functionName = 'runScenarios',
): readonly FactorHandlerSnapshot[] {
  if (value === undefined) return Object.freeze([]);
  const count = readPlainArrayLength(value, functionName, 'options.factorHandlers');
  if (count > 32) {
    throw new InputError(
      `${functionName}: options.factorHandlers may contain at most 32 handlers; received ${count}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'options.factorHandlers', count },
      },
    );
  }
  const list = snapshotDenseArray(value, functionName, 'options.factorHandlers');
  const snapshots = list.map((valueAtIndex, index): FactorHandlerSnapshot => {
    const label = `options.factorHandlers[${index}]`;
    const record = snapshotClosedRecord(valueAtIndex, {
      functionName,
      label,
      allowedKeys: ['factor', 'name', 'version', 'apply'],
      requiredKeys: ['factor', 'name', 'version', 'apply'],
    });
    const factor = requireNonEmptyString(functionName, `${label}.factor`, record['factor']);
    const name = requireNonEmptyString(functionName, `${label}.name`, record['name']);
    const version = requireNonEmptyString(functionName, `${label}.version`, record['version']);
    if (typeof record['apply'] !== 'function') {
      behaviorError(functionName, `${label}.apply`, 'must be a synchronous function.');
    }
    const object = valueAtIndex as object;
    return Object.freeze({
      object,
      factor,
      identity: Object.freeze({ name, version }),
      descriptors: snapshotDescriptors(object),
      apply: record['apply'] as ScenarioFactorHandler['apply'],
    });
  });
  ensureUniqueIdentities(
    functionName,
    'options.factorHandlers',
    snapshots.map((snapshot) => snapshot.identity),
  );
  const byFactor = new Set<string>();
  for (let index = 0; index < snapshots.length; index++) {
    const handler = snapshots[index]!;
    if (byFactor.has(handler.factor)) {
      throw new InputError(
        `${functionName}: options.factorHandlers[${index}] is a second owner for factor ${JSON.stringify(handler.factor)} — one custom factor has exactly one handler.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field: `options.factorHandlers[${index}].factor` },
        },
      );
    }
    byFactor.add(handler.factor);
  }
  return Object.freeze(snapshots);
}

export function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  let object: object | null = value as object;
  while (object !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(object, 'then');
    if (descriptor !== undefined) {
      return 'value' in descriptor && typeof descriptor.value === 'function';
    }
    object = Object.getPrototypeOf(object) as object | null;
  }
  return false;
}

export function countCurvePillars(observations: readonly MarketObservation[]): readonly number[] {
  return observations.map((observation) =>
    observation.requirement.kind === 'discountCurve'
      ? (observation.value as RateCurve).points.length
      : 0,
  );
}
