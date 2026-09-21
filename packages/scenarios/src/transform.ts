import { ErrorCode, InputError, type RateCurve } from '@totalfinance/core';
import { canonicalJsonOf, contentHash } from '@totalfinance/core/artifacts';
import { validateMarketObservation, type MarketObservation } from '@totalfinance/core/pricing';
import type {
  ScenarioDefinition,
  ScenarioOverride,
  ScenarioShock,
} from '@totalfinance/core/artifacts';
import {
  assertBehaviorUnchanged,
  countCurvePillars,
  isThenable,
  type FactorHandlerSnapshot,
} from './internal/behaviors.js';
import {
  detachCanonicalData,
  detachProvenCanonicalData,
  readPlainArrayLength,
  scanCanonicalData,
  snapshotDenseArray,
} from './internal/data.js';
import { RESERVED_SCENARIO_FACTORS } from './work.js';
import type {
  ScenarioAppliedInstruction,
  ScenarioBehaviorIdentity,
  ScenarioTargetDescriptor,
} from './types.js';

export const MILLISECONDS_PER_YEAR = 31_536_000_000 as const;

export type ScenarioInstructionPhase = 'override' | 'shock';

export function instructionMatchKey(
  scenarioIndex: number,
  phase: ScenarioInstructionPhase,
  instructionIndex: number,
): string {
  return `${scenarioIndex}:${phase}:${instructionIndex}`;
}

interface InstructionRef {
  readonly phase: ScenarioInstructionPhase;
  readonly instructionIndex: number;
  readonly instruction: ScenarioOverride | ScenarioShock;
}

export interface FullRevaluationScenarioPlan {
  readonly observations: readonly MarketObservation[];
  readonly appliedInstructions: readonly ScenarioAppliedInstruction[];
  readonly factorHandlers: readonly ScenarioBehaviorIdentity[];
}

export interface FullRevaluationTransformationResult {
  readonly scenarios: readonly FullRevaluationScenarioPlan[];
  readonly matchedInstructions: ReadonlySet<string>;
  readonly handlerCalls: number;
  readonly returnedDataWorkUnits: number;
  readonly transformationWorkUnits: number;
}

function transformationError(
  message: string,
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new InputError(`runScenarios: ${message}`, {
    code: ErrorCode.InputOutOfRange,
    context: { function: 'runScenarios', ...context },
    ...(cause !== undefined ? { cause } : {}),
  });
}

function subjectOf(observation: MarketObservation): string {
  const requirement = observation.requirement;
  switch (requirement.kind) {
    case 'valuationInstant':
      return 'global';
    case 'spot':
    case 'forward':
    case 'impliedVolatility':
    case 'dividendYield':
      return requirement.symbol;
    case 'riskFreeRate':
      return requirement.currency;
    case 'discountCurve':
      return requirement.curveId;
  }
}

function factorOf(observation: MarketObservation): string {
  switch (observation.requirement.kind) {
    case 'valuationInstant':
      return 'time';
    case 'spot':
      return 'spot';
    case 'forward':
      return 'forward';
    case 'impliedVolatility':
      return 'volatility';
    case 'riskFreeRate':
      return 'riskFreeRate';
    case 'dividendYield':
      return 'dividend';
    case 'discountCurve':
      return 'discountCurve';
  }
}

function instructionMatches(
  instruction: ScenarioOverride | ScenarioShock,
  observation: MarketObservation,
): boolean {
  if (instruction.factor !== factorOf(observation)) return false;
  if (instruction.target === undefined) return true;
  return instruction.target === subjectOf(observation);
}

function validateEpochMs(value: number, context: Record<string, unknown>): number {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8_640_000_000_000_000) {
    transformationError(
      `time transformation produced ${String(value)}, not a safe integer epoch-millisecond instant inside the ECMAScript date range.`,
      context,
    );
  }
  return value;
}

function transformScalar(
  before: number,
  ref: InstructionRef,
  factor: string,
  context: Record<string, unknown>,
): number {
  const instruction = ref.instruction;
  if (ref.phase === 'override') {
    return factor === 'time' ? validateEpochMs(instruction.value, context) : instruction.value;
  }
  const shock = instruction as ScenarioShock;
  if (factor === 'time') {
    if (shock.kind === 'percent') {
      transformationError(
        'percent time shocks are undefined — use an absolute ACT/365F year shift.',
        context,
      );
    }
    return validateEpochMs(before + shock.value * MILLISECONDS_PER_YEAR, context);
  }
  return shock.kind === 'percent' ? before * (1 + shock.value) : before + shock.value;
}

function transformedCurve(
  before: RateCurve,
  ref: InstructionRef,
  context: Record<string, unknown>,
): RateCurve {
  const points = before.points.map((point) => {
    const zeroRate =
      ref.phase === 'override'
        ? ref.instruction.value
        : (ref.instruction as ScenarioShock).kind === 'percent'
          ? point.zeroRate * (1 + ref.instruction.value)
          : point.zeroRate + ref.instruction.value;
    return { ...point, zeroRate };
  });
  const candidate = { ...before, points };
  try {
    return validateMarketObservation('runScenarios', 'transformed discount curve', {
      requirement: { kind: 'discountCurve', curveId: 'validation', currency: before.currency },
      value: candidate,
    }).value as RateCurve;
  } catch (error) {
    throw new InputError(
      'runScenarios: discountCurve instruction produced an invalid curve after this ordered step — curves are revalidated after every override/shock and are never clamped.',
      {
        code: ErrorCode.PricerObservationInvalid,
        context: { function: 'runScenarios', ...context },
        cause: error,
      },
    );
  }
}

function transformObservation(
  observation: MarketObservation,
  ref: InstructionRef,
  target: ScenarioTargetDescriptor,
  scenarioIndex: number,
  scenarioName: string,
): { readonly observation: MarketObservation; readonly detail: ScenarioAppliedInstruction } {
  const subject = subjectOf(observation);
  const base = {
    phase: ref.phase,
    instructionIndex: ref.instructionIndex,
    factor: ref.instruction.factor,
    ...(ref.instruction.target !== undefined ? { target: ref.instruction.target } : {}),
    subject,
  } as const;
  const context = {
    targetId: target.id,
    scenarioIndex,
    scenarioName,
    phase: ref.phase,
    instructionIndex: ref.instructionIndex,
    factor: ref.instruction.factor,
    subject,
  };

  if (observation.requirement.kind === 'discountCurve') {
    const before = observation.value as RateCurve;
    const after = transformedCurve(before, ref, context);
    const candidate = validateMarketObservation('runScenarios', 'transformed observation', {
      requirement: observation.requirement,
      value: after,
    });
    return {
      observation: detachCanonicalData(candidate, {
        functionName: 'runScenarios',
        label: 'transformed discount-curve observation',
        requireFiniteNumbers: true,
      }) as MarketObservation,
      detail: Object.freeze({
        ...base,
        detail: 'discount-curve',
        pillarCount: before.points.length,
        beforeCurveHash: contentHash(before),
        afterCurveHash: contentHash(after),
      }),
    };
  }

  const before = observation.value as number;
  const after = transformScalar(before, ref, factorOf(observation), context);
  let candidate: MarketObservation;
  try {
    candidate = validateMarketObservation('runScenarios', 'transformed observation', {
      requirement: observation.requirement,
      value: after,
    });
  } catch (error) {
    throw new InputError(
      `runScenarios: ${ref.instruction.factor} instruction produced invalid value ${String(after)} after this ordered step; values are validated after every instruction and never clamped.`,
      {
        code:
          ref.instruction.factor === 'volatility'
            ? ErrorCode.InputNegativeVolatility
            : ErrorCode.PricerObservationInvalid,
        context,
        cause: error,
      },
    );
  }
  return {
    observation: detachCanonicalData(candidate, {
      functionName: 'runScenarios',
      label: 'transformed scalar observation',
      requireFiniteNumbers: true,
    }) as MarketObservation,
    detail: Object.freeze({ ...base, detail: 'scalar', before, after }),
  };
}

function instructionRefs(scenario: ScenarioDefinition): readonly InstructionRef[] {
  const refs: InstructionRef[] = [];
  for (let index = 0; index < (scenario.overrides?.length ?? 0); index++) {
    refs.push({
      phase: 'override',
      instructionIndex: index,
      instruction: scenario.overrides![index]!,
    });
  }
  for (let index = 0; index < scenario.shocks.length; index++) {
    refs.push({
      phase: 'shock',
      instructionIndex: index,
      instruction: scenario.shocks[index]!,
    });
  }
  return refs;
}

function validateHandlerReturn(
  value: unknown,
  before: readonly MarketObservation[],
  handler: FactorHandlerSnapshot,
  maximumWorkUnits: number,
): { readonly observations: readonly MarketObservation[]; readonly workUnits: number } {
  if (isThenable(value)) {
    transformationError(
      `factor handler ${handler.identity.name}@${handler.identity.version} returned a thenable — Stage 4.4b handlers are synchronous.`,
      { handler: handler.identity },
    );
  }
  const resultCount = readPlainArrayLength(value, 'runScenarios', 'factor handler result');
  if (resultCount !== before.length) {
    transformationError(
      `factor handler ${handler.identity.name}@${handler.identity.version} changed observation count from ${before.length} to ${resultCount}; handlers may transform values, never expand or remove requirements.`,
      { handler: handler.identity },
    );
  }
  const raw = snapshotDenseArray(value, 'runScenarios', 'factor handler result');
  const workUnits = scanCanonicalData(raw, {
    functionName: 'runScenarios',
    label: `factor handler ${handler.identity.name} result`,
    maximumWorkUnits,
    requireFiniteNumbers: true,
  });
  const observations = raw.map((member, index) => {
    const validated = validateMarketObservation(
      'runScenarios',
      `factor handler result[${index}]`,
      member,
    );
    if (canonicalJsonOf(validated.requirement) !== canonicalJsonOf(before[index]!.requirement)) {
      transformationError(
        `factor handler ${handler.identity.name}@${handler.identity.version} changed requirement identity at index ${index}; handlers may transform values only.`,
        { handler: handler.identity, observationIndex: index },
      );
    }
    if (
      validated.requirement.kind === 'discountCurve' &&
      (validated.value as RateCurve).points.length !==
        (before[index]!.requirement.kind === 'discountCurve'
          ? (before[index]!.value as RateCurve).points.length
          : -1)
    ) {
      transformationError(
        `factor handler ${handler.identity.name}@${handler.identity.version} changed a curve's pillar count at index ${index}.`,
        { handler: handler.identity, observationIndex: index },
      );
    }
    return detachProvenCanonicalData(validated) as MarketObservation;
  });
  return { observations: Object.freeze(observations), workUnits };
}

/**
 * Precompute all full-revaluation observation sets and instruction detail before the first price
 * call. Unmatched detection is aggregated by the runner across targets, Taylor factors, and FX.
 */
export function transformFullRevaluationScenarios(input: {
  readonly target: ScenarioTargetDescriptor;
  readonly baseObservations: readonly MarketObservation[];
  readonly scenarioDefinitions: readonly ScenarioDefinition[];
  readonly factorHandlers: readonly FactorHandlerSnapshot[];
  readonly maximumHandlerResultWorkUnits: number;
}): FullRevaluationTransformationResult {
  const handlerByFactor = new Map(
    input.factorHandlers.map((handler) => [handler.factor, handler] as const),
  );
  const plans: FullRevaluationScenarioPlan[] = [];
  const matchedInstructions = new Set<string>();
  let handlerCalls = 0;
  let returnedDataWorkUnits = 0;
  let transformationWorkUnits = 0;

  for (let scenarioIndex = 0; scenarioIndex < input.scenarioDefinitions.length; scenarioIndex++) {
    const scenario = input.scenarioDefinitions[scenarioIndex]!;
    let observations = input.baseObservations;
    const applied: ScenarioAppliedInstruction[] = [];
    const usedHandlers: ScenarioBehaviorIdentity[] = [];
    for (const ref of instructionRefs(scenario)) {
      const key = instructionMatchKey(scenarioIndex, ref.phase, ref.instructionIndex);
      if (ref.instruction.factor === 'foreignExchangeRate') continue;
      if (RESERVED_SCENARIO_FACTORS.has(ref.instruction.factor)) {
        const next = [...observations];
        let matched = false;
        for (let observationIndex = 0; observationIndex < observations.length; observationIndex++) {
          const observation = observations[observationIndex]!;
          transformationWorkUnits += 1;
          if (!instructionMatches(ref.instruction, observation)) continue;
          const transformed = transformObservation(
            observation,
            ref,
            input.target,
            scenarioIndex,
            scenario.name,
          );
          next[observationIndex] = transformed.observation;
          applied.push(transformed.detail);
          matched = true;
        }
        if (matched) matchedInstructions.add(key);
        observations = Object.freeze(next);
        continue;
      }

      const handler = handlerByFactor.get(ref.instruction.factor);
      if (handler === undefined) continue;
      const beforeHash = contentHash(observations);
      const callbackInput = Object.freeze({
        instruction: ref.instruction,
        observations,
        target: input.target,
      });
      let answer: unknown;
      try {
        handlerCalls++;
        answer = Reflect.apply(handler.apply, undefined, [callbackInput]);
      } catch (error) {
        transformationError(
          `factor handler ${handler.identity.name}@${handler.identity.version} threw while applying ${JSON.stringify(ref.instruction.factor)}; fix the handler or remove it from this run.`,
          { handler: handler.identity, factor: ref.instruction.factor },
          error,
        );
      } finally {
        assertBehaviorUnchanged(
          'runScenarios',
          `factor handler ${handler.identity.name}@${handler.identity.version}`,
          handler,
        );
      }
      if (contentHash(observations) !== beforeHash) {
        transformationError(
          `factor handler ${handler.identity.name}@${handler.identity.version} mutated its frozen observation input.`,
          { handler: handler.identity },
        );
      }
      if (answer === undefined) continue;
      const validated = validateHandlerReturn(
        answer,
        observations,
        handler,
        input.maximumHandlerResultWorkUnits,
      );
      const afterHash = contentHash(validated.observations);
      observations = validated.observations;
      returnedDataWorkUnits += validated.workUnits;
      matchedInstructions.add(key);
      if (
        !usedHandlers.some(
          (identity) => canonicalJsonOf(identity) === canonicalJsonOf(handler.identity),
        )
      ) {
        usedHandlers.push(handler.identity);
      }
      applied.push(
        Object.freeze({
          phase: ref.phase,
          instructionIndex: ref.instructionIndex,
          factor: ref.instruction.factor,
          ...(ref.instruction.target !== undefined ? { target: ref.instruction.target } : {}),
          subject: input.target.id,
          detail: 'custom',
          handler: handler.identity,
          beforeObservationsHash: beforeHash,
          afterObservationsHash: afterHash,
        }),
      );
      transformationWorkUnits +=
        observations.length + countCurvePillars(observations).reduce((a, b) => a + b, 0);
    }
    plans.push(
      Object.freeze({
        observations,
        appliedInstructions: Object.freeze(applied),
        factorHandlers: Object.freeze(usedHandlers),
      }),
    );
  }

  return {
    scenarios: Object.freeze(plans),
    matchedInstructions,
    handlerCalls,
    returnedDataWorkUnits,
    transformationWorkUnits,
  };
}
