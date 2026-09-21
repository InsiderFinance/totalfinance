import { ErrorCode, PostconditionError, QuantError, assertFiniteValue } from '@totalfinance/core';
import { detachCanonicalData, deepFreezeDetached, scanCanonicalData } from './data.js';
import type { ScenarioExecutionFailure, ScenarioValuationMethod } from '../types.js';

const MAXIMUM_FAILURE_CODE_LENGTH = 128;
const MAXIMUM_FAILURE_MESSAGE_LENGTH = 4_096;
const MAXIMUM_FAILURE_CONTEXT_DEPTH = 32;
const MAXIMUM_FAILURE_CONTEXT_WORK_UNITS = 256;

const UNSAFE_MESSAGE = 'Scenario cell execution failed without a safe error message.';
const OVERSIZED_MESSAGE =
  'Scenario cell execution failed with an error message longer than 4,096 UTF-16 code units.';

export interface ScenarioFailureCoordinates {
  readonly targetIndex: number;
  readonly targetId: string;
  readonly scenarioIndex: number | null;
  readonly scenarioName: string | null;
  readonly valuationMethod: ScenarioValuationMethod;
}

/** Exact conservative reserve for the largest legal failure at these runner-owned coordinates. */
export function failureSnapshotWorkLimit(coordinates: ScenarioFailureCoordinates): number {
  const baseline = scanCanonicalData(
    {
      code: 'x'.repeat(MAXIMUM_FAILURE_CODE_LENGTH),
      message: 'x'.repeat(MAXIMUM_FAILURE_MESSAGE_LENGTH),
      context: null,
      contextStatus: 'omitted-unsafe',
      targetIndex: coordinates.targetIndex,
      targetId: coordinates.targetId,
      scenarioIndex: coordinates.scenarioIndex,
      scenarioName: coordinates.scenarioName,
      valuationMethod: coordinates.valuationMethod,
    },
    {
      functionName: 'runScenarios',
      label: 'failure reserve',
      maximumDepth: MAXIMUM_FAILURE_CONTEXT_DEPTH + 1,
      requireFiniteNumbers: true,
    },
  );
  // The baseline's null context costs one unit; a preserved context can consume the full cap.
  return baseline - 1 + MAXIMUM_FAILURE_CONTEXT_WORK_UNITS;
}

type OwnDescriptorResult =
  | { readonly status: 'absent' }
  | { readonly status: 'data'; readonly value: unknown }
  | { readonly status: 'unsafe' };

function ownDescriptor(value: unknown, key: string): OwnDescriptorResult {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    return { status: 'absent' };
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { status: 'absent' };
    if (!('value' in descriptor)) return { status: 'unsafe' };
    return { status: 'data', value: descriptor.value };
  } catch {
    // A hostile Proxy may throw from getOwnPropertyDescriptor. It is never retained or retried.
    return { status: 'unsafe' };
  }
}

function isError(value: unknown): boolean {
  try {
    return value instanceof Error;
  } catch {
    // A hostile Proxy may throw from getPrototypeOf during instanceof.
    return false;
  }
}

function isQuantError(value: unknown): boolean {
  try {
    return value instanceof QuantError;
  } catch {
    // A hostile Proxy may throw from getPrototypeOf during instanceof.
    return false;
  }
}

function safeCode(thrown: unknown): string {
  if (!isQuantError(thrown)) return ErrorCode.ScenarioCellFailed;
  const descriptor = ownDescriptor(thrown, 'code');
  return descriptor.status === 'data' &&
    typeof descriptor.value === 'string' &&
    descriptor.value.length > 0 &&
    descriptor.value.length <= MAXIMUM_FAILURE_CODE_LENGTH
    ? descriptor.value
    : ErrorCode.ScenarioCellFailed;
}

function safeMessage(thrown: unknown): string {
  if (!isError(thrown)) return UNSAFE_MESSAGE;
  const descriptor = ownDescriptor(thrown, 'message');
  if (descriptor.status !== 'data' || typeof descriptor.value !== 'string') {
    return UNSAFE_MESSAGE;
  }
  return descriptor.value.length <= MAXIMUM_FAILURE_MESSAGE_LENGTH
    ? descriptor.value
    : OVERSIZED_MESSAGE;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function snapshotContext(
  thrown: unknown,
): Pick<ScenarioExecutionFailure, 'context' | 'contextStatus'> {
  const descriptor = ownDescriptor(thrown, 'context');
  if (descriptor.status === 'absent') {
    return { context: null, contextStatus: 'absent' };
  }
  if (descriptor.status !== 'data' || !isPlainRecord(descriptor.value)) {
    return { context: null, contextStatus: 'omitted-unsafe' };
  }

  try {
    const context = detachCanonicalData(descriptor.value, {
      functionName: 'snapshotScenarioFailure',
      label: 'error.context',
      maximumDepth: MAXIMUM_FAILURE_CONTEXT_DEPTH,
      maximumWorkUnits: MAXIMUM_FAILURE_CONTEXT_WORK_UNITS,
      requireFiniteNumbers: true,
    }) as Readonly<Record<string, unknown>>;
    return { context, contextStatus: 'preserved' };
  } catch {
    return { context: null, contextStatus: 'omitted-unsafe' };
  }
}

function validateCoordinates(coordinates: ScenarioFailureCoordinates): void {
  const validTargetIndex =
    Number.isSafeInteger(coordinates.targetIndex) && coordinates.targetIndex >= 0;
  const validScenarioIndex =
    coordinates.scenarioIndex === null ||
    (Number.isSafeInteger(coordinates.scenarioIndex) && coordinates.scenarioIndex >= 0);
  const validScenarioPair =
    (coordinates.scenarioIndex === null && coordinates.scenarioName === null) ||
    (coordinates.scenarioIndex !== null &&
      typeof coordinates.scenarioName === 'string' &&
      coordinates.scenarioName.length > 0);
  if (
    !validTargetIndex ||
    typeof coordinates.targetId !== 'string' ||
    coordinates.targetId.length === 0 ||
    !validScenarioIndex ||
    !validScenarioPair ||
    (coordinates.valuationMethod !== 'full-revaluation' && coordinates.valuationMethod !== 'taylor')
  ) {
    throw new PostconditionError(
      'snapshotScenarioFailure: runner supplied invalid target/scenario failure coordinates.',
      {
        code: ErrorCode.PostconditionNonFinite,
        context: {
          function: 'snapshotScenarioFailure',
          targetIndex: coordinates.targetIndex,
          scenarioIndex: coordinates.scenarioIndex,
        },
      },
    );
  }
}

/**
 * Convert an arbitrary thrown value into the only behavior-free failure shape retained by a run.
 * Only the selected own `code`, `message`, and `context` descriptors are inspected.
 */
export function snapshotScenarioFailure(
  thrown: unknown,
  coordinates: ScenarioFailureCoordinates,
): ScenarioExecutionFailure {
  validateCoordinates(coordinates);
  const context = snapshotContext(thrown);
  const failure: ScenarioExecutionFailure = {
    code: safeCode(thrown),
    message: safeMessage(thrown),
    context: context.context,
    contextStatus: context.contextStatus,
    targetIndex: coordinates.targetIndex,
    targetId: coordinates.targetId,
    scenarioIndex: coordinates.scenarioIndex,
    scenarioName: coordinates.scenarioName,
    valuationMethod: coordinates.valuationMethod,
  };

  // This second validation walks only data constructed by this module and the already-detached
  // context. No behavior from the original thrown value remains reachable.
  assertFiniteValue('snapshotScenarioFailure', failure);
  return deepFreezeDetached(failure) as ScenarioExecutionFailure;
}

/** Throw the fail-fast wrapper while retaining the exact original thrown value as its cause. */
export function throwScenarioFailure(snapshot: ScenarioExecutionFailure, cause: unknown): never {
  const context = deepFreezeDetached({
    targetIndex: snapshot.targetIndex,
    targetId: snapshot.targetId,
    scenarioIndex: snapshot.scenarioIndex,
    scenarioName: snapshot.scenarioName,
    valuationMethod: snapshot.valuationMethod,
    context: snapshot.context,
    contextStatus: snapshot.contextStatus,
  }) as Record<string, unknown>;
  throw new QuantError(snapshot.message, {
    code: snapshot.code,
    context,
    cause,
  });
}
