import { ErrorCode, InputError, type RateCurve } from '@totalfinance/core';
import { canonicalJsonOf, requireInstantMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  requirementKey,
  validateMarketObservation,
  type MarketObservation,
  type MarketRequirement,
} from '@totalfinance/core/pricing';
import type { MarketSnapshot } from '@totalfinance/core/artifacts';
import {
  assertBehaviorUnchanged,
  isThenable,
  type ResolverSnapshot,
} from './internal/behaviors.js';
import {
  detachCanonicalData,
  detachProvenCanonicalData,
  readPlainArrayLength,
  scanCanonicalData,
} from './internal/data.js';
import { SPOT_ASSET_PRICER_NAME, SPOT_ASSET_PRICER_VERSION } from './spot-pricer.js';
import type { ScenarioBehaviorIdentity, ScenarioTargetDescriptor } from './types.js';

export type BuiltInRequirementResolution =
  | {
      readonly status: 'resolved';
      readonly observation: MarketObservation;
    }
  | {
      readonly status: 'unavailable';
      readonly absence: 'genuinely-absent' | 'present-incompatible';
      readonly reason: string;
    };

function ownValue(record: object | undefined, key: string): unknown {
  if (record === undefined) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function hasOwn(record: object | undefined, key: string): boolean {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key);
}

function rateConventionIsGateCCompatible(market: MarketSnapshot): boolean {
  return (
    market.conventions.compounding === 'continuous' && market.conventions.dayCount === 'ACT/365F'
  );
}

function isFirstPartySpotValuedTarget(target: ScenarioTargetDescriptor): boolean {
  return (
    target.valuationMethod === 'full-revaluation' &&
    target.pricer.name === SPOT_ASSET_PRICER_NAME &&
    target.pricer.version === SPOT_ASSET_PRICER_VERSION
  );
}

function resolvedObservation(
  requirement: MarketRequirement,
  value: MarketObservation['value'],
): BuiltInRequirementResolution {
  return {
    status: 'resolved',
    observation: validateMarketObservation('runScenarios', 'resolved observation', {
      requirement,
      value,
    }),
  };
}

/** Project one Gate-B snapshot coordinate into the existing Gate-C observation grammar. */
export function resolveBuiltInRequirement(
  requirement: MarketRequirement,
  market: MarketSnapshot,
  target: ScenarioTargetDescriptor,
): BuiltInRequirementResolution {
  const observations = market.observations;
  switch (requirement.kind) {
    case 'valuationInstant':
      // An option pricer asked WHEN: a date-granular ledger snapshot cannot answer (00:00 UTC is
      // the previous ET evening); the guard names the fix.
      return resolvedObservation(requirement, requireInstantMarketSnapshot('runScenarios', market));
    case 'spot': {
      const raw = ownValue(observations.spots, requirement.symbol);
      if (raw === undefined) {
        return {
          status: 'unavailable',
          absence: 'genuinely-absent',
          reason: `market.observations.spots has no ${JSON.stringify(requirement.symbol)} observation`,
        };
      }
      const spot = raw as { price: number; currency?: string };
      if (
        isFirstPartySpotValuedTarget(target) &&
        spot.currency !== undefined &&
        spot.currency !== target.currency
      ) {
        return {
          status: 'unavailable',
          absence: 'present-incompatible',
          reason: `spot ${requirement.symbol} is stated in ${spot.currency}, while target ${target.id} is valued in ${target.currency}`,
        };
      }
      return resolvedObservation(requirement, spot.price);
    }
    case 'forward':
      return {
        status: 'unavailable',
        absence: 'genuinely-absent',
        reason:
          'MarketSnapshot has no flat forward section and TotalFinance never derives one silently',
      };
    case 'impliedVolatility': {
      const value = ownValue(observations.volatilities, requirement.symbol);
      return value === undefined
        ? {
            status: 'unavailable',
            absence: 'genuinely-absent',
            reason: `market.observations.volatilities has no flat ${JSON.stringify(requirement.symbol)} quote`,
          }
        : resolvedObservation(requirement, value as number);
    }
    case 'riskFreeRate': {
      const present = hasOwn(observations.riskFreeRates, requirement.currency);
      if (!present) {
        return {
          status: 'unavailable',
          absence: 'genuinely-absent',
          reason: `market.observations.riskFreeRates has no ${JSON.stringify(requirement.currency)} quote`,
        };
      }
      if (!rateConventionIsGateCCompatible(market)) {
        return {
          status: 'unavailable',
          absence: 'present-incompatible',
          reason:
            `the supplied ${requirement.currency} flat rate is quoted under ` +
            `${JSON.stringify(market.conventions.compounding ?? null)} / ${JSON.stringify(market.conventions.dayCount ?? null)}, ` +
            'not continuous / ACT/365F',
        };
      }
      return resolvedObservation(
        requirement,
        ownValue(observations.riskFreeRates, requirement.currency) as number,
      );
    }
    case 'dividendYield': {
      const present = hasOwn(observations.dividendYields, requirement.symbol);
      if (!present) {
        return {
          status: 'unavailable',
          absence: 'genuinely-absent',
          reason: `market.observations.dividendYields has no ${JSON.stringify(requirement.symbol)} quote`,
        };
      }
      if (!rateConventionIsGateCCompatible(market)) {
        return {
          status: 'unavailable',
          absence: 'present-incompatible',
          reason:
            `the supplied ${requirement.symbol} flat dividend yield is quoted under ` +
            `${JSON.stringify(market.conventions.compounding ?? null)} / ${JSON.stringify(market.conventions.dayCount ?? null)}, ` +
            'not continuous / ACT/365F',
        };
      }
      return resolvedObservation(
        requirement,
        ownValue(observations.dividendYields, requirement.symbol) as number,
      );
    }
    case 'discountCurve': {
      const raw = ownValue(observations.curves, requirement.curveId);
      if (raw === undefined) {
        return {
          status: 'unavailable',
          absence: 'genuinely-absent',
          reason: `market.observations.curves has no curve labeled ${JSON.stringify(requirement.curveId)}`,
        };
      }
      const curve = raw as RateCurve;
      if (curve.currency !== requirement.currency) {
        return {
          status: 'unavailable',
          absence: 'present-incompatible',
          reason: `curve ${requirement.curveId} declares ${curve.currency}, not required currency ${requirement.currency}`,
        };
      }
      return resolvedObservation(requirement, curve);
    }
  }
}

export function coordinateCountForObservation(observation: MarketObservation): number {
  return observation.requirement.kind === 'discountCurve'
    ? 1 + (observation.value as RateCurve).points.length
    : 1;
}

export function reservedCoordinateCount(
  requirement: MarketRequirement,
  resolution: BuiltInRequirementResolution,
): number {
  if (resolution.status === 'resolved')
    return coordinateCountForObservation(resolution.observation);
  return requirement.kind === 'discountCurve' ? 4_097 : 1;
}

export interface ResolvedRequirementSet {
  readonly observations: readonly MarketObservation[];
  readonly resolvers: readonly ScenarioBehaviorIdentity[];
  readonly resolverCalls: number;
  readonly returnedDataWorkUnits: number;
  readonly coordinateCount: number;
}

function resolverResultError(
  target: ScenarioTargetDescriptor,
  requirement: MarketRequirement,
  message: string,
  cause?: unknown,
): never {
  throw new InputError(
    `runScenarios: resolver result for target ${JSON.stringify(target.id)} and ${requirementKey(requirement)} ${message}`,
    {
      code: ErrorCode.PricerObservationInvalid,
      context: { targetId: target.id, requirement: requirementKey(requirement) },
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

function unsatisfiedRequirement(
  target: ScenarioTargetDescriptor,
  requirement: MarketRequirement,
  resolution: Extract<BuiltInRequirementResolution, { status: 'unavailable' }>,
): never {
  const correction =
    requirement.kind === 'riskFreeRate' || requirement.kind === 'dividendYield'
      ? 'Supply a continuous ACT/365F snapshot quote or one per-call resolver that returns an explicitly normalized Gate-C observation.'
      : 'Supply the matching snapshot observation or one explicit per-call resolver.';
  throw new InputError(
    `runScenarios: target ${JSON.stringify(target.id)} cannot satisfy ${requirementKey(requirement)} — ${resolution.reason}. ${correction}`,
    {
      code: ErrorCode.PricerRequirementUnsatisfied,
      context: {
        targetId: target.id,
        requirement: requirementKey(requirement),
        absence: resolution.absence,
      },
    },
  );
}

/** Resolve one target's snapshotted requirements after Barrier B has accepted the complete plan. */
export function resolveRequirementSet(input: {
  readonly requirements: readonly MarketRequirement[];
  readonly market: MarketSnapshot;
  readonly target: ScenarioTargetDescriptor;
  readonly resolvers: readonly ResolverSnapshot[];
  readonly maximumResultWorkUnits?: readonly number[];
}): ResolvedRequirementSet {
  const observations: MarketObservation[] = [];
  const usedResolvers: ScenarioBehaviorIdentity[] = [];
  let resolverCalls = 0;
  let returnedDataWorkUnits = 0;
  let coordinateCount = 0;

  for (let requirementIndex = 0; requirementIndex < input.requirements.length; requirementIndex++) {
    const requirement = input.requirements[requirementIndex]!;
    const builtIn = resolveBuiltInRequirement(requirement, input.market, input.target);
    if (builtIn.status === 'resolved') {
      const detached = detachCanonicalData(builtIn.observation, {
        functionName: 'runScenarios',
        label: `resolved observations[${observations.length}]`,
        requireFiniteNumbers: true,
      }) as MarketObservation;
      observations.push(detached);
      coordinateCount += coordinateCountForObservation(detached);
      continue;
    }

    const answers: Array<{
      readonly observation: MarketObservation;
      readonly resolver: ResolverSnapshot;
      readonly workUnits: number;
    }> = [];
    for (let resolverIndex = 0; resolverIndex < input.resolvers.length; resolverIndex++) {
      const resolver = input.resolvers[resolverIndex]!;
      const callInput = Object.freeze({
        requirement,
        market: input.market,
        target: input.target,
      });
      let answer: unknown;
      try {
        resolverCalls++;
        answer = Reflect.apply(resolver.resolve, undefined, [callInput]);
      } catch (error) {
        resolverResultError(
          input.target,
          requirement,
          `threw from ${resolver.identity.name}@${resolver.identity.version}; fix the resolver or remove it from this run.`,
          error,
        );
      } finally {
        assertBehaviorUnchanged(
          'runScenarios',
          `options.marketResolvers[${resolverIndex}]`,
          resolver,
        );
      }
      if (isThenable(answer)) {
        resolverResultError(
          input.target,
          requirement,
          'is thenable — Stage 4.4b resolvers are synchronous; resolve data before calling runScenarios.',
        );
      }
      if (answer === undefined) continue;
      if (requirement.kind === 'discountCurve') {
        const answerObject =
          answer !== null && typeof answer === 'object' && !Array.isArray(answer) ? answer : null;
        const valueDescriptor =
          answerObject === null
            ? undefined
            : Object.getOwnPropertyDescriptor(answerObject, 'value');
        const curve =
          valueDescriptor !== undefined && 'value' in valueDescriptor
            ? valueDescriptor.value
            : null;
        const pointsDescriptor =
          curve !== null && typeof curve === 'object' && !Array.isArray(curve)
            ? Object.getOwnPropertyDescriptor(curve, 'points')
            : undefined;
        if (pointsDescriptor !== undefined && 'value' in pointsDescriptor) {
          let pillarCount: number | null = null;
          try {
            pillarCount = readPlainArrayLength(
              pointsDescriptor.value,
              'runScenarios',
              `resolver ${resolver.identity.name} curve points`,
            );
          } catch {
            // The complete canonical scan/MarketObservation validator below owns malformed shapes.
          }
          if (pillarCount !== null && pillarCount > 4_096) {
            resolverResultError(
              input.target,
              requirement,
              `contains ${pillarCount} curve pillars; the resolver hard maximum is 4,096.`,
            );
          }
        }
      }
      const workUnits = scanCanonicalData(answer, {
        functionName: 'runScenarios',
        label: `resolver ${resolver.identity.name} result`,
        maximumDepth: 64,
        maximumWorkUnits: input.maximumResultWorkUnits?.[requirementIndex] ?? 1_000_000,
        requireFiniteNumbers: true,
      });
      let validated: MarketObservation;
      try {
        validated = validateMarketObservation(
          'runScenarios',
          `resolver ${resolver.identity.name} result`,
          answer,
        );
      } catch (error) {
        resolverResultError(input.target, requirement, 'is not a valid MarketObservation.', error);
      }
      if (canonicalJsonOf(validated.requirement) !== canonicalJsonOf(requirement)) {
        resolverResultError(
          input.target,
          requirement,
          `carries descriptor ${requirementKey(validated.requirement)} instead of the exact requested descriptor.`,
        );
      }
      if (
        validated.requirement.kind === 'discountCurve' &&
        (validated.value as RateCurve).points.length > 4_096
      ) {
        resolverResultError(
          input.target,
          requirement,
          `contains ${(validated.value as RateCurve).points.length} curve pillars; the resolver hard maximum is 4,096.`,
        );
      }
      answers.push({
        observation: detachProvenCanonicalData(validated) as MarketObservation,
        resolver,
        workUnits,
      });
    }

    if (answers.length > 1) {
      throw new InputError(
        `runScenarios: ${answers.length} resolvers answered ${requirementKey(requirement)} for target ${JSON.stringify(input.target.id)} (${answers.map((answer) => `${answer.resolver.identity.name}@${answer.resolver.identity.version}`).join(', ')}) — resolution is ambiguous; keep exactly one answer.`,
        {
          code: ErrorCode.PricerObservationInvalid,
          context: {
            targetId: input.target.id,
            requirement: requirementKey(requirement),
            resolvers: answers.map((answer) => answer.resolver.identity),
          },
        },
      );
    }
    if (answers.length === 0) {
      if (requirement.optional === true && builtIn.absence === 'genuinely-absent') continue;
      unsatisfiedRequirement(input.target, requirement, builtIn);
    }
    const accepted = answers[0]!;
    observations.push(accepted.observation);
    if (
      !usedResolvers.some(
        (identity) =>
          identity.name === accepted.resolver.identity.name &&
          identity.version === accepted.resolver.identity.version,
      )
    ) {
      usedResolvers.push(accepted.resolver.identity);
    }
    returnedDataWorkUnits += accepted.workUnits;
    coordinateCount += coordinateCountForObservation(accepted.observation);
  }

  return {
    observations: Object.freeze(observations),
    resolvers: Object.freeze(usedResolvers),
    resolverCalls,
    returnedDataWorkUnits,
    coordinateCount,
  };
}
