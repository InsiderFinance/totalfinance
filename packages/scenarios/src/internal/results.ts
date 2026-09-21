import { ErrorCode, QuantError } from '@totalfinance/core';
import type { TaylorPnlResult } from '@totalfinance/risk';
import { detachProvenCanonicalData, scanCanonicalData } from './data.js';
import type { ScenarioPricingResult, ScenarioValuationMethod } from '../types.js';

export interface ScenarioCellCoordinates {
  readonly targetIndex: number;
  readonly targetId: string;
  readonly scenarioIndex: number | null;
  readonly scenarioName: string | null;
  readonly valuationMethod: ScenarioValuationMethod;
}

export interface DetachedValuationResult<T> {
  readonly result: Readonly<T>;
  readonly workUnits: number;
}

function resultValidationFailure(coordinates: ScenarioCellCoordinates, cause: unknown): QuantError {
  return new QuantError(
    `runScenarios: ${coordinates.scenarioIndex === null ? 'base' : `scenario ${JSON.stringify(coordinates.scenarioName)}`} result for target ${JSON.stringify(coordinates.targetId)} is not a finite canonical Gate-C result.`,
    {
      code: ErrorCode.ScenarioCellFailed,
      context: { function: 'runScenarios', stage: 'result-validation', ...coordinates },
      cause,
    },
  );
}

function ownDataValue(object: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor !== undefined && descriptor.enumerable && 'value' in descriptor
    ? descriptor.value
    : undefined;
}

/** Validate and detach the complete Gate-C result without dropping domain-specific fields. */
export function detachPricingResult(
  value: unknown,
  coordinates: ScenarioCellCoordinates,
): DetachedValuationResult<ScenarioPricingResult> {
  try {
    const workUnits = scanCanonicalData(value, {
      functionName: 'runScenarios',
      label: 'pricer result',
      maximumDepth: 64,
      maximumWorkUnits: 1_024,
      requireFiniteNumbers: true,
    });
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('The pricer result must be a plain object.');
    }
    const resultValue = ownDataValue(value, 'value');
    if (typeof resultValue !== 'number' || !Number.isFinite(resultValue)) {
      throw new TypeError('The pricer result must carry an own finite numeric value.');
    }
    const assumptions = ownDataValue(value, 'assumptions');
    if (assumptions === null || typeof assumptions !== 'object' || Array.isArray(assumptions)) {
      throw new TypeError('The pricer result must carry an own assumptions record.');
    }
    const diagnostics = ownDataValue(value, 'diagnostics');
    if (diagnostics === null || typeof diagnostics !== 'object' || Array.isArray(diagnostics)) {
      throw new TypeError('The pricer result must carry an own diagnostics record.');
    }
    if (!Array.isArray(ownDataValue(diagnostics, 'warnings'))) {
      throw new TypeError('The pricer result diagnostics must carry an own warnings array.');
    }
    return {
      result: detachProvenCanonicalData(value as ScenarioPricingResult),
      workUnits,
    };
  } catch (error) {
    if (
      error instanceof QuantError &&
      error.code === ErrorCode.ScenarioCellFailed &&
      error.context?.['stage'] === 'result-validation'
    ) {
      throw error;
    }
    throw resultValidationFailure(coordinates, error);
  }
}

/** Validate and detach the complete direct `taylorPnl` attribution result. */
export function detachTaylorResult(
  value: unknown,
  coordinates: ScenarioCellCoordinates,
): DetachedValuationResult<TaylorPnlResult> {
  try {
    const workUnits = scanCanonicalData(value, {
      functionName: 'runScenarios',
      label: 'Taylor result',
      maximumDepth: 64,
      maximumWorkUnits: 1_024,
      requireFiniteNumbers: true,
    });
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('The Taylor result must be a plain object.');
    }
    const total = ownDataValue(value, 'total');
    if (typeof total !== 'number' || !Number.isFinite(total)) {
      throw new TypeError('The Taylor result must carry an own finite numeric total.');
    }
    const assumptions = ownDataValue(value, 'assumptions');
    const diagnostics = ownDataValue(value, 'diagnostics');
    if (
      assumptions === null ||
      typeof assumptions !== 'object' ||
      Array.isArray(assumptions) ||
      diagnostics === null ||
      typeof diagnostics !== 'object' ||
      Array.isArray(diagnostics) ||
      !Array.isArray(ownDataValue(diagnostics, 'warnings'))
    ) {
      throw new TypeError('The Taylor result must carry assumptions and diagnostics.warnings.');
    }
    return {
      result: detachProvenCanonicalData(value as TaylorPnlResult),
      workUnits,
    };
  } catch (error) {
    if (
      error instanceof QuantError &&
      error.code === ErrorCode.ScenarioCellFailed &&
      error.context?.['stage'] === 'result-validation'
    ) {
      throw error;
    }
    throw resultValidationFailure(coordinates, error);
  }
}
