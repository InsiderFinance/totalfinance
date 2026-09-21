import { ErrorCode, InputError } from '@totalfinance/core';
import {
  contentHash,
  type MarketSnapshot,
  type ScenarioDefinition,
} from '@totalfinance/core/artifacts';
import type { Scenario } from '@totalfinance/risk';
import { detachCanonicalData } from './internal/data.js';
import { instructionMatchKey, MILLISECONDS_PER_YEAR } from './transform.js';
import type {
  ScenarioAppliedInstruction,
  TaylorFactors,
  TaylorScenarioTargetDescriptor,
} from './types.js';

export interface TaylorScenarioPlan {
  readonly factors: TaylorFactors;
  readonly factorSetHash: string;
  readonly scenario: Scenario;
  readonly appliedInstructions: readonly ScenarioAppliedInstruction[];
}

export interface TaylorTransformationResult {
  readonly baseFactorSetHash: string;
  readonly scenarios: readonly TaylorScenarioPlan[];
  readonly matchedInstructions: ReadonlySet<string>;
  readonly transformationWorkUnits: number;
}

function taylorError(message: string, context: Record<string, unknown> = {}): never {
  throw new InputError(`runScenarios: ${message}`, {
    code: ErrorCode.InputOutOfRange,
    context: { function: 'runScenarios', ...context },
  });
}

function ownValue(record: object | undefined, key: string): unknown {
  if (record === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

/** Prove explicit Taylor base levels describe the same market snapshot used by the run. */
export function validateTaylorBaseCoherence(
  target: TaylorScenarioTargetDescriptor,
  market: MarketSnapshot,
): void {
  const factors = target.taylor.factors;
  if (factors.valuationInstant !== undefined && factors.valuationInstant.level !== market.asOf) {
    taylorError(
      `Taylor target ${JSON.stringify(target.id)} was measured at valuationInstant ${factors.valuationInstant.level}, but market.asOf is ${market.asOf}. Rebuild the sensitivities at this snapshot or run them separately.`,
      { targetId: target.id, factor: 'valuationInstant' },
    );
  }
  const compareFlat = (
    factor: 'spot' | 'volatility' | 'riskFreeRate' | 'dividend',
    snapshotLevel: unknown,
    explicitLevel: number,
  ): void => {
    if (snapshotLevel === undefined) return;
    if (snapshotLevel !== explicitLevel) {
      taylorError(
        `Taylor target ${JSON.stringify(target.id)} has ${factor} base level ${explicitLevel}, while the matching market snapshot quote is ${String(snapshotLevel)}. Rebuild the sensitivities at this snapshot or run them separately.`,
        { targetId: target.id, factor, explicitLevel, snapshotLevel },
      );
    }
  };
  if (factors.spot !== undefined) {
    const spot = ownValue(market.observations.spots, factors.spot.subject) as
      | { price: number }
      | undefined;
    compareFlat('spot', spot?.price, factors.spot.level);
  }
  if (factors.volatility !== undefined) {
    if (factors.volatility.level < 0) {
      taylorError(
        `Taylor target ${JSON.stringify(target.id)} has negative volatility base level ${factors.volatility.level}; volatility is a non-negative magnitude.`,
        { targetId: target.id, factor: 'volatility' },
      );
    }
    compareFlat(
      'volatility',
      ownValue(market.observations.volatilities, factors.volatility.subject),
      factors.volatility.level,
    );
  }
  for (const factor of ['riskFreeRate', 'dividend'] as const) {
    const level = factors[factor];
    if (level === undefined) continue;
    const section =
      factor === 'riskFreeRate'
        ? market.observations.riskFreeRates
        : market.observations.dividendYields;
    const snapshotLevel = ownValue(section, level.subject);
    if (snapshotLevel === undefined) continue;
    if (
      market.conventions.compounding !== 'continuous' ||
      market.conventions.dayCount !== 'ACT/365F'
    ) {
      taylorError(
        `Taylor target ${JSON.stringify(target.id)} has a matching ${factor} snapshot quote under ${JSON.stringify(market.conventions.compounding ?? null)} / ${JSON.stringify(market.conventions.dayCount ?? null)}. It cannot be compared with a raw continuous ACT/365F Taylor level; normalize the snapshot explicitly or run separately.`,
        { targetId: target.id, factor },
      );
    }
    compareFlat(factor, snapshotLevel, level.level);
  }
}

function factorSubject(factors: TaylorFactors, factor: string): string | undefined {
  if (factor === 'time') return factors.valuationInstant === undefined ? undefined : 'global';
  if (factor === 'spot') return factors.spot?.subject;
  if (factor === 'volatility') return factors.volatility?.subject;
  if (factor === 'riskFreeRate') return factors.riskFreeRate?.subject;
  if (factor === 'dividend') return factors.dividend?.subject;
  return undefined;
}

function readLevel(factors: TaylorFactors, factor: string): number | undefined {
  if (factor === 'time') return factors.valuationInstant?.level;
  if (factor === 'spot') return factors.spot?.level;
  if (factor === 'volatility') return factors.volatility?.level;
  if (factor === 'riskFreeRate') return factors.riskFreeRate?.level;
  if (factor === 'dividend') return factors.dividend?.level;
  return undefined;
}

function writeLevel(factors: TaylorFactors, factor: string, level: number): TaylorFactors {
  if (factor === 'time') return { ...factors, valuationInstant: { level } };
  const key = factor as 'spot' | 'volatility' | 'riskFreeRate' | 'dividend';
  const previous = factors[key]!;
  return { ...factors, [key]: { subject: previous.subject, level } };
}

function validateLevel(
  target: TaylorScenarioTargetDescriptor,
  factor: string,
  level: number,
  context: Record<string, unknown>,
): number {
  if (!Number.isFinite(level)) {
    taylorError(
      `Taylor target ${JSON.stringify(target.id)} produced non-finite ${factor} level ${String(level)}.`,
      context,
    );
  }
  if (factor === 'volatility' && level < 0) {
    throw new InputError(
      `runScenarios: Taylor target ${JSON.stringify(target.id)} produced negative volatility ${level}; volatility is validated after every ordered instruction and never clamped.`,
      {
        code: ErrorCode.InputNegativeVolatility,
        context: { function: 'runScenarios', targetId: target.id, ...context },
      },
    );
  }
  if (
    factor === 'time' &&
    (!Number.isSafeInteger(level) || Math.abs(level) > 8_640_000_000_000_000)
  ) {
    taylorError(
      `Taylor target ${JSON.stringify(target.id)} produced an invalid epoch-millisecond valuation instant ${String(level)}.`,
      context,
    );
  }
  return level;
}

/** Resolve Taylor factor levels and direct `taylorPnl` scenarios without reimplementing its math. */
export function transformTaylorScenarios(input: {
  readonly target: TaylorScenarioTargetDescriptor;
  readonly scenarioDefinitions: readonly ScenarioDefinition[];
}): TaylorTransformationResult {
  const baseFactors = input.target.taylor.factors;
  const plans: TaylorScenarioPlan[] = [];
  const matched = new Set<string>();
  let transformationWorkUnits = Object.keys(baseFactors).length;

  for (let scenarioIndex = 0; scenarioIndex < input.scenarioDefinitions.length; scenarioIndex++) {
    const definition = input.scenarioDefinitions[scenarioIndex]!;
    let factors = baseFactors;
    const applied: ScenarioAppliedInstruction[] = [];
    const process = (
      phase: 'override' | 'shock',
      instructionIndex: number,
      instruction:
        | ScenarioDefinition['shocks'][number]
        | NonNullable<ScenarioDefinition['overrides']>[number],
    ): void => {
      const subject = factorSubject(factors, instruction.factor);
      const before = readLevel(factors, instruction.factor);
      transformationWorkUnits++;
      if (
        subject === undefined ||
        (instruction.target !== undefined && instruction.target !== subject)
      ) {
        return;
      }
      if (instruction.factor === 'time' && instruction.target !== undefined) {
        taylorError('time is global and never accepts an instruction target.', {
          scenarioIndex,
          phase,
          instructionIndex,
        });
      }
      let after: number;
      if (phase === 'override') {
        after = instruction.value;
      } else if (instruction.factor === 'time') {
        const shock = instruction as ScenarioDefinition['shocks'][number];
        if (shock.kind === 'percent') {
          taylorError('percent time shocks are undefined; use an absolute ACT/365F year shift.', {
            scenarioIndex,
            phase,
            instructionIndex,
          });
        }
        after = before! + shock.value * MILLISECONDS_PER_YEAR;
      } else {
        const shock = instruction as ScenarioDefinition['shocks'][number];
        after = shock.kind === 'percent' ? before! * (1 + shock.value) : before! + shock.value;
      }
      after = validateLevel(input.target, instruction.factor, after, {
        scenarioIndex,
        phase,
        instructionIndex,
        factor: instruction.factor,
      });
      factors = writeLevel(factors, instruction.factor, after);
      matched.add(instructionMatchKey(scenarioIndex, phase, instructionIndex));
      applied.push(
        Object.freeze({
          phase,
          instructionIndex,
          factor: instruction.factor,
          ...(instruction.target !== undefined ? { target: instruction.target } : {}),
          subject,
          detail: 'scalar',
          before: before!,
          after,
        }),
      );
    };
    for (let index = 0; index < (definition.overrides?.length ?? 0); index++) {
      process('override', index, definition.overrides![index]!);
    }
    for (let index = 0; index < definition.shocks.length; index++) {
      process('shock', index, definition.shocks[index]!);
    }
    const detachedFactors = detachCanonicalData(factors, {
      functionName: 'runScenarios',
      label: `Taylor factors for ${input.target.id}/${definition.name}`,
      requireFiniteNumbers: true,
    }) as TaylorFactors;
    const shocks: Scenario['shocks'] = [];
    const addMove = (
      factor: 'spot' | 'volatility' | 'riskFreeRate' | 'time' | 'dividend',
      base: number | undefined,
      scenarioLevel: number | undefined,
    ): void => {
      if (base === undefined || scenarioLevel === undefined) return;
      const value =
        factor === 'time' ? (scenarioLevel - base) / MILLISECONDS_PER_YEAR : scenarioLevel - base;
      shocks.push({ factor, kind: 'absolute', value });
    };
    addMove('spot', baseFactors.spot?.level, detachedFactors.spot?.level);
    addMove('volatility', baseFactors.volatility?.level, detachedFactors.volatility?.level);
    addMove('riskFreeRate', baseFactors.riskFreeRate?.level, detachedFactors.riskFreeRate?.level);
    addMove('time', baseFactors.valuationInstant?.level, detachedFactors.valuationInstant?.level);
    addMove('dividend', baseFactors.dividend?.level, detachedFactors.dividend?.level);
    plans.push(
      Object.freeze({
        factors: detachedFactors,
        factorSetHash: contentHash(detachedFactors),
        scenario: Object.freeze({
          name: definition.name,
          shocks: Object.freeze(shocks),
        }) as unknown as Scenario,
        appliedInstructions: Object.freeze(applied),
      }),
    );
  }
  return {
    baseFactorSetHash: contentHash(baseFactors),
    scenarios: Object.freeze(plans),
    matchedInstructions: matched,
    transformationWorkUnits,
  };
}
