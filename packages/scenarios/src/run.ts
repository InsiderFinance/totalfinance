import {
  CONVENTIONS_VERSION,
  ErrorCode,
  InputError,
  QuantError,
  UnsupportedError,
} from '@totalfinance/core';
import {
  contentHash,
  marketSnapshotContentHash,
  readMarketSnapshot,
  readScenarioSet,
  scenarioSetContentHash,
  type MarketSnapshot,
  type ScenarioSet,
} from '@totalfinance/core/artifacts';
import {
  requirementKey,
  validateMarketRequirement,
  type MarketRequirement,
} from '@totalfinance/core/pricing';
import { taylorPnl, type PositionGreeks } from '@totalfinance/risk';
import { buildScenarioAggregates } from './aggregates.js';
import {
  convertReportingValue,
  convertScenarioPositionValues,
  prepareCurrencyPlan,
  transformCurrencyPlan,
  type CurrencyConversionPlan,
  type CurrencyConversionTransformationResult,
} from './fx.js';
import {
  failureSnapshotWorkLimit,
  snapshotScenarioFailure,
  throwScenarioFailure,
  type ScenarioFailureCoordinates,
} from './internal/failures.js';
import {
  checkedAdd,
  deepFreezeDetached,
  describeInputValue,
  detachCanonicalData,
  detachProvenCanonicalData,
  readPlainArrayLength,
  scanCanonicalData,
  snapshotDenseArray,
} from './internal/data.js';
import { detachPricingResult, detachTaylorResult } from './internal/results.js';
import {
  resolveBuiltInRequirement,
  resolveRequirementSet,
  reservedCoordinateCount,
  type ResolvedRequirementSet,
} from './market-resolution.js';
import { validateScenarioTarget, type ValidatedScenarioTarget } from './targets.js';
import {
  instructionMatchKey,
  MILLISECONDS_PER_YEAR,
  transformFullRevaluationScenarios,
  type FullRevaluationTransformationResult,
} from './transform.js';
import {
  transformTaylorScenarios,
  validateTaylorBaseCoherence,
  type TaylorTransformationResult,
} from './taylor.js';
import {
  DEFAULT_MAXIMUM_VALUATION_CELLS,
  DEFAULT_MAXIMUM_WORK_UNITS,
  HARD_MAXIMUM_VALUATION_CELLS,
  HARD_MAXIMUM_WORK_UNITS,
  MAXIMUM_REQUIREMENTS_PER_TARGET,
  assertWithinLiveReservation,
  callbackObservationWorkLimit,
  estimateBarrierB,
  metric,
  runBarrierA,
  type BarrierAResult,
  type BarrierBTargetPlan,
} from './work.js';
import type {
  RunScenariosInput,
  ScenarioAppliedInstruction,
  ScenarioAxisRow,
  ScenarioBaseCell,
  ScenarioBehaviorIdentity,
  ScenarioCell,
  ScenarioExecutionFailure,
  ScenarioRunMetrics,
  ScenarioRunResult,
  ScenarioSuccessfulValueFields,
  ScenarioTargetAxisRow,
  ScenarioTargetDescriptor,
  FullRevaluationScenarioTargetDescriptor,
  TaylorScenarioTargetDescriptor,
} from './types.js';

type FullBinding = NonNullable<ValidatedScenarioTarget['binding']>;

interface PreparedTargetBase extends BarrierBTargetPlan {
  readonly targetIndex: number;
  readonly validated: ValidatedScenarioTarget;
  readonly effectiveSeed: number | null;
}

interface PreparedFullTarget extends PreparedTargetBase {
  readonly kind: 'full-revaluation';
  readonly descriptor: FullRevaluationScenarioTargetDescriptor;
  readonly binding: FullBinding;
  readonly requirementResultWorkLimits: readonly number[];
}

interface PreparedTaylorTarget extends PreparedTargetBase {
  readonly kind: 'taylor';
  readonly descriptor: TaylorScenarioTargetDescriptor;
  readonly binding: null;
}

type PreparedTarget = PreparedFullTarget | PreparedTaylorTarget;

interface RuntimeFullTarget extends PreparedFullTarget {
  readonly resolved: ResolvedRequirementSet;
  readonly transformed: FullRevaluationTransformationResult;
}

interface RuntimeTaylorTarget extends PreparedTaylorTarget {
  readonly transformed: TaylorTransformationResult;
}

type RuntimeTarget = RuntimeFullTarget | RuntimeTaylorTarget;

interface ExecutionCounters {
  pricerCalls: number;
  taylorCalls: number;
  resolverCalls: number;
  factorHandlerCalls: number;
  transformationWorkUnits: number;
  valuationResultWorkUnits: number;
  failureSnapshotWorkUnits: number;
  successfulCells: number;
  failedCells: number;
  blockedCells: number;
}

type Attempt<T> =
  | { readonly status: 'complete'; readonly value: T }
  | { readonly status: 'failed'; readonly failure: ScenarioExecutionFailure };

function requestFailure(
  message: string,
  code: string,
  context: Record<string, unknown>,
  cause?: unknown,
): never {
  throw new InputError(`runScenarios: ${message}`, {
    code,
    context: { function: 'runScenarios', ...context },
    ...(cause !== undefined ? { cause } : {}),
  });
}

function validateStaticInstructions(scenarioSet: ScenarioSet): void {
  for (let scenarioIndex = 0; scenarioIndex < scenarioSet.scenarios.length; scenarioIndex++) {
    const scenario = scenarioSet.scenarios[scenarioIndex]!;
    for (
      let instructionIndex = 0;
      instructionIndex < (scenario.overrides?.length ?? 0);
      instructionIndex++
    ) {
      const instruction = scenario.overrides![instructionIndex]!;
      if (instruction.factor === 'time' && instruction.target !== undefined) {
        requestFailure(
          'time is global and an override may not name target.',
          ErrorCode.InputOutOfRange,
          {
            scenarioIndex,
            scenarioName: scenario.name,
            phase: 'override',
            instructionIndex,
            target: instruction.target,
          },
        );
      }
    }
    for (let instructionIndex = 0; instructionIndex < scenario.shocks.length; instructionIndex++) {
      const instruction = scenario.shocks[instructionIndex]!;
      if (instruction.factor !== 'time') continue;
      if (instruction.target !== undefined) {
        requestFailure(
          'time is global and a shock may not name target.',
          ErrorCode.InputOutOfRange,
          {
            scenarioIndex,
            scenarioName: scenario.name,
            phase: 'shock',
            instructionIndex,
            target: instruction.target,
          },
        );
      }
      if (instruction.kind === 'percent') {
        requestFailure(
          'percent time shocks are undefined; use an absolute signed ACT/365F year shift.',
          ErrorCode.InputOutOfRange,
          { scenarioIndex, scenarioName: scenario.name, phase: 'shock', instructionIndex },
        );
      }
    }
  }
}

function validateTargetIdentities(targets: readonly ValidatedScenarioTarget[]): void {
  const seen = new Map<string, number>();
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
    const id = targets[targetIndex]!.descriptor.id;
    const first = seen.get(id);
    if (first !== undefined) {
      requestFailure(
        `targets[${targetIndex}].id duplicates targets[${first}].id (${JSON.stringify(id)}); target IDs must be unique within one run.`,
        ErrorCode.InputOutOfRange,
        { field: `targets[${targetIndex}].id`, targetId: id, firstTargetIndex: first, targetIndex },
      );
    }
    seen.set(id, targetIndex);
  }
}

function validateSeedDomain(
  barrier: BarrierAResult,
  targets: readonly ValidatedScenarioTarget[],
): boolean {
  const hasSeededPricer = targets.some(
    (target) =>
      target.descriptor.valuationMethod === 'full-revaluation' &&
      target.descriptor.pricer.capabilities.randomness === 'seeded',
  );
  if (hasSeededPricer && barrier.seed === null) {
    requestFailure(
      'options.seed is required because at least one target pricer declares randomness: seeded.',
      ErrorCode.InputMissingField,
      { field: 'options.seed' },
    );
  }
  if (
    barrier.seed !== null &&
    targets.length > 0 &&
    barrier.seed > Number.MAX_SAFE_INTEGER - (targets.length - 1)
  ) {
    requestFailure(
      `options.seed + targets.length - 1 exceeds Number.MAX_SAFE_INTEGER (${barrier.seed} + ${targets.length - 1}); use a smaller seed or split the run.`,
      ErrorCode.InputOutOfRange,
      { field: 'options.seed', seed: barrier.seed, targetCount: targets.length },
    );
  }
  return hasSeededPricer;
}

function callSupports(
  binding: FullBinding,
  descriptor: FullRevaluationScenarioTargetDescriptor,
): void {
  let answer: unknown;
  try {
    answer = binding.pricer.supports(binding.instrument);
  } catch (error) {
    requestFailure(
      `pricer ${descriptor.pricer.name}@${descriptor.pricer.version} threw from its one supports call for target ${JSON.stringify(descriptor.id)}.`,
      ErrorCode.PricerNonconformant,
      { targetId: descriptor.id, stage: 'supports', pricer: descriptor.pricer },
      error,
    );
  }
  if (answer === false) {
    throw new UnsupportedError(
      `runScenarios: pricer ${descriptor.pricer.name}@${descriptor.pricer.version} does not support target ${JSON.stringify(descriptor.id)}. Bind the instrument to a pricer whose supports() returns true.`,
      {
        code: ErrorCode.ScenarioTargetUnsupported,
        context: { function: 'runScenarios', targetId: descriptor.id, pricer: descriptor.pricer },
      },
    );
  }
  if (answer !== true) {
    requestFailure(
      `pricer ${descriptor.pricer.name}@${descriptor.pricer.version} returned ${describeInputValue(answer)} from supports for target ${JSON.stringify(descriptor.id)}; only literal true or false is conformant.`,
      ErrorCode.PricerNonconformant,
      { targetId: descriptor.id, stage: 'supports', received: typeof answer },
    );
  }
}

function callRequirements(
  binding: FullBinding,
  descriptor: FullRevaluationScenarioTargetDescriptor,
  maximumDescriptorWorkUnits: number,
): {
  readonly requirements: readonly MarketRequirement[];
  readonly workUnits: number;
  readonly workUnitsByRequirement: readonly number[];
} {
  let raw: unknown;
  try {
    raw = binding.pricer.requirements(binding.instrument);
  } catch (error) {
    requestFailure(
      `pricer ${descriptor.pricer.name}@${descriptor.pricer.version} threw from its one requirements call for target ${JSON.stringify(descriptor.id)}.`,
      ErrorCode.PricerNonconformant,
      { targetId: descriptor.id, stage: 'requirements', pricer: descriptor.pricer },
      error,
    );
  }
  let requirementCount: number;
  try {
    requirementCount = readPlainArrayLength(raw, 'runScenarios', `requirements(${descriptor.id})`);
  } catch (error) {
    requestFailure(
      `pricer ${descriptor.pricer.name}@${descriptor.pricer.version} requirements for target ${JSON.stringify(descriptor.id)} must return a plain dense array.`,
      ErrorCode.PricerNonconformant,
      { targetId: descriptor.id, stage: 'requirements' },
      error,
    );
  }
  if (requirementCount > MAXIMUM_REQUIREMENTS_PER_TARGET) {
    requestFailure(
      `target ${JSON.stringify(descriptor.id)} declares ${requirementCount} market requirements; the hard maximum is ${MAXIMUM_REQUIREMENTS_PER_TARGET}. Split the instrument or use a table handle instead of an unbounded descriptor list.`,
      ErrorCode.InputOutOfRange,
      { targetId: descriptor.id, requirementCount },
    );
  }
  const members = snapshotDenseArray(raw, 'runScenarios', `requirements(${descriptor.id})`);
  const requirements: MarketRequirement[] = [];
  const workUnitsByRequirement: number[] = [];
  const seen = new Map<string, number>();
  let workUnits = 0;
  for (let requirementIndex = 0; requirementIndex < members.length; requirementIndex++) {
    const member = members[requirementIndex];
    const memberWorkUnits = scanCanonicalData(member, {
      functionName: 'runScenarios',
      label: `requirements(${descriptor.id})[${requirementIndex}]`,
      maximumDepth: 64,
      maximumWorkUnits: maximumDescriptorWorkUnits - workUnits,
      requireFiniteNumbers: true,
    });
    workUnits = checkedAdd(
      'runScenarios',
      'requirement descriptor work',
      workUnits,
      memberWorkUnits,
    );
    workUnitsByRequirement.push(memberWorkUnits);
    const validated = validateMarketRequirement(
      'runScenarios',
      `requirements(${descriptor.id})[${requirementIndex}]`,
      member,
    );
    const key = requirementKey(validated);
    const first = seen.get(key);
    if (first !== undefined) {
      requestFailure(
        `target ${JSON.stringify(descriptor.id)} declares duplicate requirement ${key} at indices ${first} and ${requirementIndex}; optional and required forms identify the same coordinate.`,
        ErrorCode.PricerRequirementInvalid,
        {
          targetId: descriptor.id,
          requirement: key,
          firstRequirementIndex: first,
          requirementIndex,
        },
      );
    }
    seen.set(key, requirementIndex);
    requirements.push(detachProvenCanonicalData(validated) as MarketRequirement);
  }
  return {
    requirements: Object.freeze(requirements),
    workUnits,
    workUnitsByRequirement: Object.freeze(workUnitsByRequirement),
  };
}

function prepareTargets(
  barrier: BarrierAResult,
  market: MarketSnapshot,
  validatedTargets: readonly ValidatedScenarioTarget[],
  currencyPlan: CurrencyConversionPlan,
): readonly PreparedTarget[] {
  const prepared: PreparedTarget[] = [];
  const supportsReserve = validatedTargets.filter(
    ({ descriptor }) => descriptor.valuationMethod === 'full-revaluation',
  ).length;
  const fixedPreBarrierBWork = checkedAdd(
    'runScenarios',
    'pre-Barrier-B fixed work',
    checkedAdd(
      'runScenarios',
      'pre-Barrier-B input and cells',
      barrier.inputDataWorkUnits,
      barrier.valuationCells,
    ),
    supportsReserve,
  );
  let requirementDescriptorWork = 0;
  for (let targetIndex = 0; targetIndex < validatedTargets.length; targetIndex++) {
    const validated = validatedTargets[targetIndex]!;
    const descriptor = validated.descriptor;
    const effectiveSeed =
      descriptor.valuationMethod === 'full-revaluation' &&
      descriptor.pricer.capabilities.randomness === 'seeded'
        ? barrier.seed! + targetIndex
        : null;
    if (descriptor.valuationMethod === 'taylor') {
      validateTaylorBaseCoherence(descriptor, market);
      prepared.push({
        kind: 'taylor',
        targetIndex,
        validated,
        descriptor,
        binding: null,
        effectiveSeed,
        requirements: Object.freeze([]),
        requirementDescriptorWorkUnits: 0,
        coordinateCount: Object.keys(descriptor.taylor.factors).length,
        unresolvedRequirementCount: 0,
        usedForeignExchangeCoordinates: currencyPlan.targetCoordinateCounts[targetIndex]!,
        resolverReturnDataWorkReserve: 0,
        handlerReturnDataWorkLimit: 0,
      });
      continue;
    }
    const binding = validated.binding;
    if (binding === null) {
      requestFailure(
        `full-revaluation target ${JSON.stringify(descriptor.id)} has no behavior binding.`,
        ErrorCode.InputWrongShape,
        { targetId: descriptor.id },
      );
    }
    callSupports(binding, descriptor);
    const remainingRequirementWork =
      barrier.maximumWorkUnits - fixedPreBarrierBWork - requirementDescriptorWork;
    if (remainingRequirementWork <= 0) {
      requestFailure(
        'options.maximumWorkUnits is exhausted before all requirement descriptors can be validated.',
        ErrorCode.InputOutOfRange,
        { stage: 'requirements', targetId: descriptor.id },
      );
    }
    const declared = callRequirements(binding, descriptor, remainingRequirementWork);
    requirementDescriptorWork = checkedAdd(
      'runScenarios',
      'all requirement descriptor work',
      requirementDescriptorWork,
      declared.workUnits,
    );
    let coordinateCount = 0;
    let unresolvedRequirementCount = 0;
    let resolverReturnDataWorkReserve = 0;
    let handlerReturnDataWorkLimit = 64;
    const requirementResultWorkLimits: number[] = [];
    for (
      let requirementIndex = 0;
      requirementIndex < declared.requirements.length;
      requirementIndex++
    ) {
      const requirement = declared.requirements[requirementIndex]!;
      const resolution = resolveBuiltInRequirement(requirement, market, descriptor);
      const reservedCoordinates = reservedCoordinateCount(requirement, resolution);
      coordinateCount += reservedCoordinates;
      const resultWorkLimit = callbackObservationWorkLimit(
        declared.workUnitsByRequirement[requirementIndex]!,
        reservedCoordinates,
      );
      requirementResultWorkLimits.push(resultWorkLimit);
      handlerReturnDataWorkLimit = checkedAdd(
        'runScenarios',
        'handler result work limit',
        handlerReturnDataWorkLimit,
        resultWorkLimit,
      );
      if (resolution.status === 'unavailable') {
        unresolvedRequirementCount++;
        resolverReturnDataWorkReserve = checkedAdd(
          'runScenarios',
          'resolver result work reserve',
          resolverReturnDataWorkReserve,
          resultWorkLimit * barrier.resolvers.length,
        );
      }
    }
    prepared.push({
      kind: 'full-revaluation',
      targetIndex,
      validated,
      descriptor,
      binding,
      effectiveSeed,
      requirements: declared.requirements,
      requirementDescriptorWorkUnits: declared.workUnits,
      coordinateCount,
      unresolvedRequirementCount,
      usedForeignExchangeCoordinates: currencyPlan.targetCoordinateCounts[targetIndex]!,
      resolverReturnDataWorkReserve,
      handlerReturnDataWorkLimit,
      requirementResultWorkLimits: Object.freeze(requirementResultWorkLimits),
    });
  }
  return Object.freeze(prepared);
}

function precomputeRuntime(
  prepared: readonly PreparedTarget[],
  barrier: BarrierAResult,
  market: MarketSnapshot,
  scenarioSet: ScenarioSet,
  counters: ExecutionCounters,
): readonly RuntimeTarget[] {
  const runtime: RuntimeTarget[] = [];
  for (const target of prepared) {
    if (target.kind === 'taylor') {
      const transformed = transformTaylorScenarios({
        target: target.descriptor,
        scenarioDefinitions: scenarioSet.scenarios,
      });
      counters.transformationWorkUnits += transformed.transformationWorkUnits;
      runtime.push({ ...target, transformed });
      continue;
    }
    const resolved = resolveRequirementSet({
      requirements: target.requirements,
      market,
      target: target.descriptor,
      resolvers: barrier.resolvers,
      maximumResultWorkUnits: target.requirementResultWorkLimits,
    });
    counters.resolverCalls += resolved.resolverCalls;
    if (resolved.coordinateCount > target.coordinateCount) {
      requestFailure(
        `resolver results expanded target ${JSON.stringify(target.descriptor.id)} from ${target.coordinateCount} reserved coordinates to ${resolved.coordinateCount}.`,
        ErrorCode.InputOutOfRange,
        { targetId: target.descriptor.id, stage: 'resolver-result-shape' },
      );
    }
    const transformed = transformFullRevaluationScenarios({
      target: target.descriptor,
      baseObservations: resolved.observations,
      scenarioDefinitions: scenarioSet.scenarios,
      factorHandlers: barrier.factorHandlers,
      maximumHandlerResultWorkUnits: target.handlerReturnDataWorkLimit,
    });
    counters.factorHandlerCalls += transformed.handlerCalls;
    // The settled Barrier-B formula charges callback dispatches separately and transformation
    // work in observation/factor/curve coordinates. Canonical callback-return scans enforce the
    // reserved shape but are not re-added as a second, incompatible cost unit here.
    counters.transformationWorkUnits +=
      resolved.returnedDataWorkUnits +
      transformed.transformationWorkUnits +
      transformed.returnedDataWorkUnits;
    runtime.push({ ...target, resolved, transformed });
  }
  return Object.freeze(runtime);
}

function mergeMatchedInstructions(
  runtime: readonly RuntimeTarget[],
  currencyTransformation: CurrencyConversionTransformationResult,
): ReadonlySet<string> {
  const matched = new Set(currencyTransformation.matchedInstructions);
  for (const target of runtime) {
    for (const key of target.transformed.matchedInstructions) matched.add(key);
  }
  return matched;
}

function assertEveryInstructionMatched(
  scenarioSet: ScenarioSet,
  matched: ReadonlySet<string>,
): void {
  for (let scenarioIndex = 0; scenarioIndex < scenarioSet.scenarios.length; scenarioIndex++) {
    const scenario = scenarioSet.scenarios[scenarioIndex]!;
    for (
      let instructionIndex = 0;
      instructionIndex < (scenario.overrides?.length ?? 0);
      instructionIndex++
    ) {
      const instruction = scenario.overrides![instructionIndex]!;
      if (!matched.has(instructionMatchKey(scenarioIndex, 'override', instructionIndex))) {
        throw new InputError(
          `runScenarios: scenario ${JSON.stringify(scenario.name)} override[${instructionIndex}] (${instruction.factor}${instruction.target === undefined ? '' : ` target=${instruction.target}`}) matched no used observation, Taylor factor, reporting-currency quote, or custom handler. Fix the factor/target typo or remove the instruction.`,
          {
            code: ErrorCode.ScenarioInstructionUnmatched,
            context: {
              function: 'runScenarios',
              scenarioIndex,
              scenarioName: scenario.name,
              phase: 'override',
              instructionIndex,
              factor: instruction.factor,
              ...(instruction.target !== undefined ? { target: instruction.target } : {}),
            },
          },
        );
      }
    }
    for (let instructionIndex = 0; instructionIndex < scenario.shocks.length; instructionIndex++) {
      const instruction = scenario.shocks[instructionIndex]!;
      if (!matched.has(instructionMatchKey(scenarioIndex, 'shock', instructionIndex))) {
        throw new InputError(
          `runScenarios: scenario ${JSON.stringify(scenario.name)} shock[${instructionIndex}] (${instruction.factor}${instruction.target === undefined ? '' : ` target=${instruction.target}`}) matched no used observation, Taylor factor, reporting-currency quote, or custom handler. Fix the factor/target typo or remove the instruction.`,
          {
            code: ErrorCode.ScenarioInstructionUnmatched,
            context: {
              function: 'runScenarios',
              scenarioIndex,
              scenarioName: scenario.name,
              phase: 'shock',
              instructionIndex,
              factor: instruction.factor,
              ...(instruction.target !== undefined ? { target: instruction.target } : {}),
            },
          },
        );
      }
    }
  }
}

function finiteCellNumber(
  value: number,
  field: string,
  coordinates: ScenarioFailureCoordinates,
): number {
  if (!Number.isFinite(value)) {
    throw new QuantError(
      `runScenarios: ${field} for target ${JSON.stringify(coordinates.targetId)} is not representable as a finite number.`,
      {
        code: ErrorCode.ScenarioCellFailed,
        context: { function: 'runScenarios', stage: 'position-scaling', field, ...coordinates },
      },
    );
  }
  return value;
}

function positionValue(
  valuePerUnit: number,
  target: ScenarioTargetDescriptor,
  coordinates: ScenarioFailureCoordinates,
): number {
  return finiteCellNumber(
    valuePerUnit * target.quantity * target.contractMultiplier,
    'positionValue',
    coordinates,
  );
}

function mergeAppliedInstructions(
  first: readonly ScenarioAppliedInstruction[],
  second: readonly ScenarioAppliedInstruction[],
): readonly ScenarioAppliedInstruction[] {
  return Object.freeze(
    [...first, ...second].sort((left, right) => {
      const phase = left.phase === right.phase ? 0 : left.phase === 'override' ? -1 : 1;
      return phase !== 0 ? phase : left.instructionIndex - right.instructionIndex;
    }),
  );
}

function attemptCell<T>(
  coordinates: ScenarioFailureCoordinates,
  failureMode: 'fail-fast' | 'collect',
  counters: ExecutionCounters,
  failures: ScenarioExecutionFailure[],
  task: () => T,
): Attempt<T> {
  try {
    const value = task();
    counters.successfulCells++;
    return { status: 'complete', value };
  } catch (cause) {
    const failure = snapshotScenarioFailure(cause, coordinates);
    const failureWork = scanCanonicalData(failure, {
      functionName: 'runScenarios',
      label: 'scenario failure snapshot',
      maximumDepth: 32,
      maximumWorkUnits: failureSnapshotWorkLimit(coordinates),
      requireFiniteNumbers: true,
    });
    counters.failureSnapshotWorkUnits += failureWork;
    if (failureMode === 'fail-fast') throwScenarioFailure(failure, cause);
    failures.push(failure);
    counters.failedCells++;
    return { status: 'failed', failure };
  }
}

function commonSuccessFields(input: {
  readonly target: RuntimeTarget;
  readonly valuePerUnit: number;
  readonly positionValue: number;
  readonly reportingPositionValue: number;
  readonly reportingCurrency: string;
  readonly currencyConversion: ScenarioSuccessfulValueFields['currencyConversion'];
  readonly observationOrFactorSetHash: string;
  readonly appliedInstructions: readonly ScenarioAppliedInstruction[];
  readonly resolvers: readonly ScenarioBehaviorIdentity[];
  readonly factorHandlers: readonly ScenarioBehaviorIdentity[];
}): ScenarioSuccessfulValueFields {
  return {
    targetIndex: input.target.targetIndex,
    targetId: input.target.descriptor.id,
    quantity: input.target.descriptor.quantity,
    contractMultiplier: input.target.descriptor.contractMultiplier,
    valuationCurrency: input.target.descriptor.currency,
    reportingCurrency: input.reportingCurrency,
    valuePerUnit: input.valuePerUnit,
    positionValue: input.positionValue,
    reportingPositionValue: input.reportingPositionValue,
    currencyConversion: input.currencyConversion,
    observationOrFactorSetHash: input.observationOrFactorSetHash,
    appliedInstructions: input.appliedInstructions,
    resolvers: input.resolvers,
    factorHandlers: input.factorHandlers,
    effectiveSeed: input.target.effectiveSeed,
  };
}

function buildAxes(
  scenarioSet: ScenarioSet,
  targets: readonly RuntimeTarget[],
): {
  readonly scenarioAxis: readonly ScenarioAxisRow[];
  readonly targetAxis: readonly ScenarioTargetAxisRow[];
} {
  const scenarioAxis = scenarioSet.scenarios.map((scenario, scenarioIndex) =>
    detachCanonicalData<ScenarioAxisRow>(
      {
        scenarioIndex,
        name: scenario.name,
        scenarioHash: contentHash(scenario),
        overrideCount: scenario.overrides?.length ?? 0,
        shockCount: scenario.shocks.length,
      },
      {
        functionName: 'runScenarios',
        label: `scenarioAxis[${scenarioIndex}]`,
        requireFiniteNumbers: true,
      },
    ),
  );
  const targetAxis = targets.map((target, targetIndex) =>
    detachCanonicalData<ScenarioTargetAxisRow>(
      { ...target.descriptor, targetIndex },
      {
        functionName: 'runScenarios',
        label: `targetAxis[${targetIndex}]`,
        requireFiniteNumbers: true,
      },
    ),
  );
  return { scenarioAxis: Object.freeze(scenarioAxis), targetAxis: Object.freeze(targetAxis) };
}

const CELL_ENVELOPE_EXCLUDED_KEYS = new Set([
  'pricingResult',
  'taylorResult',
  'failure',
  'blockedByBaseFailure',
  'appliedInstructions',
  'resolvers',
  'factorHandlers',
]);

function retainedCellWork(cell: ScenarioBaseCell | ScenarioCell): {
  readonly envelope: number;
  readonly instructionDetails: number;
  readonly behaviorIdentities: number;
  readonly failure: number;
} {
  const envelope: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(cell)) {
    if (typeof key !== 'string' || CELL_ENVELOPE_EXCLUDED_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(cell, key);
    if (descriptor !== undefined && 'value' in descriptor) envelope[key] = descriptor.value;
  }
  let instructionDetails = 0;
  let behaviorIdentities = 0;
  let failure = 0;
  if (cell.status === 'complete') {
    instructionDetails = scanCanonicalData(cell.appliedInstructions, {
      functionName: 'runScenarios',
      label: 'retained applied instructions',
      requireFiniteNumbers: true,
    });
    behaviorIdentities =
      scanCanonicalData(cell.resolvers, {
        functionName: 'runScenarios',
        label: 'retained resolver identities',
        requireFiniteNumbers: true,
      }) +
      scanCanonicalData(cell.factorHandlers, {
        functionName: 'runScenarios',
        label: 'retained factor-handler identities',
        requireFiniteNumbers: true,
      });
  } else {
    const retainedFailure =
      cell.kind === 'base'
        ? cell.failure
        : cell.status === 'failed'
          ? cell.failure
          : cell.blockedByBaseFailure;
    failure = scanCanonicalData(retainedFailure, {
      functionName: 'runScenarios',
      label: 'retained scenario failure',
      requireFiniteNumbers: true,
    });
  }
  return {
    envelope: scanCanonicalData(envelope, {
      functionName: 'runScenarios',
      label: 'retained result cell envelope',
      requireFiniteNumbers: true,
    }),
    instructionDetails,
    behaviorIdentities,
    failure,
  };
}

function scenarioCoordinates(
  target: RuntimeTarget,
  scenarioIndex: number | null,
  scenarioName: string | null,
): ScenarioFailureCoordinates {
  return {
    targetIndex: target.targetIndex,
    targetId: target.descriptor.id,
    scenarioIndex,
    scenarioName,
    valuationMethod: target.descriptor.valuationMethod,
  };
}

/** Run one validated ScenarioSet over heterogeneous builder-owned targets and one market snapshot. */
export function runScenarios(rawInput: RunScenariosInput): ScenarioRunResult {
  const barrier = runBarrierA(rawInput);
  const { scenarioSet } = readScenarioSet({ scenarioSet: barrier.rawScenarioSet });
  const { snapshot: market } = readMarketSnapshot({ snapshot: barrier.rawMarket });
  if (
    scenarioSet.scenarios.length !== barrier.scenarioCount ||
    barrier.rawTargets.length !== barrier.targetCount
  ) {
    requestFailure(
      'the validated input axes drifted after Barrier A; do not mutate a request while runScenarios is executing.',
      ErrorCode.InputWrongShape,
      { stage: 'post-read-axis-check' },
    );
  }
  validateStaticInstructions(scenarioSet);
  const validatedTargets = barrier.rawTargets.map((target, targetIndex) =>
    validateScenarioTarget(target, targetIndex),
  );
  validateTargetIdentities(validatedTargets);
  const hasSeededPricer = validateSeedDomain(barrier, validatedTargets);
  const currencyPlan = prepareCurrencyPlan({
    reportingCurrency: barrier.reportingCurrency,
    currencyConversions: barrier.rawCurrencyConversions,
    targets: validatedTargets.map((target) => target.descriptor),
  });

  const prepared = prepareTargets(barrier, market, validatedTargets, currencyPlan);
  const estimate = estimateBarrierB({
    barrierA: barrier,
    scenarioSet,
    targets: prepared,
    reportingCurrency: currencyPlan.reportingCurrency,
  });
  const counters: ExecutionCounters = {
    pricerCalls: 0,
    taylorCalls: 0,
    resolverCalls: 0,
    factorHandlerCalls: 0,
    transformationWorkUnits: 0,
    valuationResultWorkUnits: 0,
    failureSnapshotWorkUnits: 0,
    successfulCells: 0,
    failedCells: 0,
    blockedCells: 0,
  };
  const runtime = precomputeRuntime(prepared, barrier, market, scenarioSet, counters);
  const currencyTransformation = transformCurrencyPlan({
    plan: currencyPlan,
    scenarioDefinitions: scenarioSet.scenarios,
  });
  counters.transformationWorkUnits += currencyTransformation.transformationWorkUnits;
  assertEveryInstructionMatched(
    scenarioSet,
    mergeMatchedInstructions(runtime, currencyTransformation),
  );
  assertWithinLiveReservation(
    counters.transformationWorkUnits,
    estimate.transformationReserve,
    'transformationWorkUnits',
  );

  const { scenarioAxis, targetAxis } = buildAxes(scenarioSet, runtime);
  const failures: ScenarioExecutionFailure[] = [];
  const base: ScenarioBaseCell[] = [];

  for (const target of runtime) {
    const coordinates = scenarioCoordinates(target, null, null);
    const attempted = attemptCell(
      coordinates,
      barrier.failureMode,
      counters,
      failures,
      (): ScenarioBaseCell => {
        const conversion = currencyPlan.conversionsByTarget[target.targetIndex]!;
        if (target.kind === 'full-revaluation') {
          counters.pricerCalls++;
          const raw = target.binding.pricer.price({
            instrument: target.binding.instrument,
            observations: target.resolved.observations,
            ...(target.effectiveSeed !== null ? { request: { seed: target.effectiveSeed } } : {}),
          });
          const detached = detachPricingResult(raw, coordinates);
          counters.valuationResultWorkUnits += detached.workUnits;
          const valuePerUnit = detached.result.value;
          const localPositionValue = positionValue(valuePerUnit, target.descriptor, coordinates);
          const reportingPositionValue = convertReportingValue({
            amount: localPositionValue,
            valuationCurrency: target.descriptor.currency,
            reportingCurrency: currencyPlan.reportingCurrency,
            currencyConversion: conversion,
          });
          return {
            kind: 'base',
            status: 'complete',
            ...commonSuccessFields({
              target,
              valuePerUnit,
              positionValue: localPositionValue,
              reportingPositionValue,
              reportingCurrency: currencyPlan.reportingCurrency,
              currencyConversion: conversion,
              observationOrFactorSetHash: contentHash(target.resolved.observations),
              appliedInstructions: Object.freeze([]),
              resolvers: target.resolved.resolvers,
              factorHandlers: Object.freeze([]),
            }),
            valuationMethod: 'full-revaluation',
            pricer: target.descriptor.pricer,
            pricingResult: detached.result,
          };
        }
        const valuePerUnit = target.descriptor.taylor.baseValuePerUnit;
        const localPositionValue = positionValue(valuePerUnit, target.descriptor, coordinates);
        const reportingPositionValue = convertReportingValue({
          amount: localPositionValue,
          valuationCurrency: target.descriptor.currency,
          reportingCurrency: currencyPlan.reportingCurrency,
          currencyConversion: conversion,
        });
        return {
          kind: 'base',
          status: 'complete',
          ...commonSuccessFields({
            target,
            valuePerUnit,
            positionValue: localPositionValue,
            reportingPositionValue,
            reportingCurrency: currencyPlan.reportingCurrency,
            currencyConversion: conversion,
            observationOrFactorSetHash: target.transformed.baseFactorSetHash,
            appliedInstructions: Object.freeze([]),
            resolvers: Object.freeze([]),
            factorHandlers: Object.freeze([]),
          }),
          valuationMethod: 'taylor',
          baseValueSource: 'supplied-base-value-per-unit',
        };
      },
    );
    if (attempted.status === 'complete') base.push(attempted.value);
    else {
      base.push({
        kind: 'base',
        status: 'failed',
        targetIndex: target.targetIndex,
        targetId: target.descriptor.id,
        valuationMethod: target.descriptor.valuationMethod,
        valuePerUnit: null,
        positionValue: null,
        reportingPositionValue: null,
        failure: attempted.failure,
      });
    }
  }

  const cells: ScenarioCell[] = [];
  for (let scenarioIndex = 0; scenarioIndex < scenarioSet.scenarios.length; scenarioIndex++) {
    const scenario = scenarioSet.scenarios[scenarioIndex]!;
    const fxScenario = currencyTransformation.scenarios[scenarioIndex]!;
    for (const target of runtime) {
      const baseCell = base[target.targetIndex]!;
      const coordinates = scenarioCoordinates(target, scenarioIndex, scenario.name);
      if (baseCell.status === 'failed') {
        counters.blockedCells++;
        cells.push({
          kind: 'scenario',
          status: 'blocked',
          targetIndex: target.targetIndex,
          targetId: target.descriptor.id,
          scenarioIndex,
          scenarioName: scenario.name,
          valuationMethod: target.descriptor.valuationMethod,
          valuePerUnit: null,
          positionValue: null,
          reportingPositionValue: null,
          localPnl: null,
          reportingPnl: null,
          blockedByBaseFailure: baseCell.failure,
        });
        continue;
      }
      const attempted = attemptCell(
        coordinates,
        barrier.failureMode,
        counters,
        failures,
        (): ScenarioCell => {
          const scenarioConversion = fxScenario.conversionsByTarget[target.targetIndex]!;
          const baseConversion = currencyPlan.conversionsByTarget[target.targetIndex]!;
          const fxInstructions = fxScenario.appliedInstructionsByTarget[target.targetIndex]!;
          if (target.kind === 'full-revaluation') {
            const transformed = target.transformed.scenarios[scenarioIndex]!;
            counters.pricerCalls++;
            const raw = target.binding.pricer.price({
              instrument: target.binding.instrument,
              observations: transformed.observations,
              ...(target.effectiveSeed !== null ? { request: { seed: target.effectiveSeed } } : {}),
            });
            const detached = detachPricingResult(raw, coordinates);
            counters.valuationResultWorkUnits += detached.workUnits;
            const valuePerUnit = detached.result.value;
            const localPositionValue = positionValue(valuePerUnit, target.descriptor, coordinates);
            const localPnl = finiteCellNumber(
              localPositionValue - baseCell.positionValue,
              'localPnl',
              coordinates,
            );
            const converted = convertScenarioPositionValues({
              basePositionValue: baseCell.positionValue,
              scenarioPositionValue: localPositionValue,
              valuationCurrency: target.descriptor.currency,
              reportingCurrency: currencyPlan.reportingCurrency,
              baseCurrencyConversion: baseConversion,
              scenarioCurrencyConversion: scenarioConversion,
            });
            return {
              kind: 'scenario',
              status: 'complete',
              scenarioIndex,
              scenarioName: scenario.name,
              localPnl,
              reportingPnl: converted.reportingPnl,
              ...commonSuccessFields({
                target,
                valuePerUnit,
                positionValue: localPositionValue,
                reportingPositionValue: converted.scenarioReportingPositionValue,
                reportingCurrency: currencyPlan.reportingCurrency,
                currencyConversion: scenarioConversion,
                observationOrFactorSetHash: contentHash(transformed.observations),
                appliedInstructions: mergeAppliedInstructions(
                  transformed.appliedInstructions,
                  fxInstructions,
                ),
                resolvers: target.resolved.resolvers,
                factorHandlers: transformed.factorHandlers,
              }),
              valuationMethod: 'full-revaluation',
              pricer: target.descriptor.pricer,
              pricingResult: detached.result,
            };
          }
          const transformed = target.transformed.scenarios[scenarioIndex]!;
          const greekInput: PositionGreeks = {
            value: target.descriptor.taylor.baseValuePerUnit,
            ...(target.descriptor.taylor.factors.spot !== undefined
              ? { spot: target.descriptor.taylor.factors.spot.level }
              : {}),
            ...target.descriptor.taylor.sensitivities,
          };
          counters.taylorCalls++;
          const detached = detachTaylorResult(
            taylorPnl(greekInput, transformed.scenario),
            coordinates,
          );
          counters.valuationResultWorkUnits += detached.workUnits;
          const valuePerUnit = finiteCellNumber(
            target.descriptor.taylor.baseValuePerUnit + detached.result.total,
            'valuePerUnit',
            coordinates,
          );
          const localPositionValue = positionValue(valuePerUnit, target.descriptor, coordinates);
          const localPnl = finiteCellNumber(
            localPositionValue - baseCell.positionValue,
            'localPnl',
            coordinates,
          );
          const converted = convertScenarioPositionValues({
            basePositionValue: baseCell.positionValue,
            scenarioPositionValue: localPositionValue,
            valuationCurrency: target.descriptor.currency,
            reportingCurrency: currencyPlan.reportingCurrency,
            baseCurrencyConversion: baseConversion,
            scenarioCurrencyConversion: scenarioConversion,
          });
          return {
            kind: 'scenario',
            status: 'complete',
            scenarioIndex,
            scenarioName: scenario.name,
            localPnl,
            reportingPnl: converted.reportingPnl,
            ...commonSuccessFields({
              target,
              valuePerUnit,
              positionValue: localPositionValue,
              reportingPositionValue: converted.scenarioReportingPositionValue,
              reportingCurrency: currencyPlan.reportingCurrency,
              currencyConversion: scenarioConversion,
              observationOrFactorSetHash: transformed.factorSetHash,
              appliedInstructions: mergeAppliedInstructions(
                transformed.appliedInstructions,
                fxInstructions,
              ),
              resolvers: Object.freeze([]),
              factorHandlers: Object.freeze([]),
            }),
            valuationMethod: 'taylor',
            taylorResult: detached.result,
          };
        },
      );
      if (attempted.status === 'complete') cells.push(attempted.value);
      else {
        cells.push({
          kind: 'scenario',
          status: 'failed',
          targetIndex: target.targetIndex,
          targetId: target.descriptor.id,
          scenarioIndex,
          scenarioName: scenario.name,
          valuationMethod: target.descriptor.valuationMethod,
          valuePerUnit: null,
          positionValue: null,
          reportingPositionValue: null,
          localPnl: null,
          reportingPnl: null,
          failure: attempted.failure,
        });
      }
    }
  }

  const aggregates = buildScenarioAggregates({
    targets: targetAxis,
    scenarioAxis,
    base,
    cells,
    reportingCurrency: currencyPlan.reportingCurrency,
  });
  const requirementCount = prepared.reduce((sum, target) => sum + target.requirements.length, 0);
  const requirementWork = prepared.reduce(
    (sum, target) => sum + target.requirementDescriptorWorkUnits,
    0,
  );
  assertWithinLiveReservation(
    counters.valuationResultWorkUnits,
    estimate.valuationResultReserve,
    'valuationResultWorkUnits',
  );
  let resultEnvelopeActual = base.length + cells.length;
  let instructionDetailActual = 0;
  let failureSnapshotActual = failures.length;
  for (const cell of [...base, ...cells]) {
    const retained = retainedCellWork(cell);
    resultEnvelopeActual = checkedAdd(
      'runScenarios',
      'retained result envelope work',
      resultEnvelopeActual,
      retained.envelope + retained.behaviorIdentities,
    );
    instructionDetailActual = checkedAdd(
      'runScenarios',
      'retained instruction detail work',
      instructionDetailActual,
      retained.instructionDetails,
    );
    failureSnapshotActual = checkedAdd(
      'runScenarios',
      'retained failure work',
      failureSnapshotActual,
      retained.failure,
    );
  }
  for (const failure of failures) {
    failureSnapshotActual = checkedAdd(
      'runScenarios',
      'diagnostic failure retention work',
      failureSnapshotActual,
      scanCanonicalData(failure, {
        functionName: 'runScenarios',
        label: 'diagnostic failure retention',
        requireFiniteNumbers: true,
      }),
    );
  }
  assertWithinLiveReservation(
    resultEnvelopeActual,
    estimate.resultEnvelopeReserve,
    'resultEnvelopeWorkUnits',
  );
  assertWithinLiveReservation(
    instructionDetailActual,
    estimate.instructionDetailReserve,
    'instructionDetailWorkUnits',
  );
  assertWithinLiveReservation(
    failureSnapshotActual,
    estimate.failureSnapshotReserve,
    'failureSnapshotWorkUnits',
  );
  const axisActual = scanCanonicalData(
    { scenarioAxis, targetAxis },
    {
      functionName: 'runScenarios',
      label: 'result axes',
      requireFiniteNumbers: true,
    },
  );
  const aggregateActual = scanCanonicalData(aggregates, {
    functionName: 'runScenarios',
    label: 'result aggregates',
    requireFiniteNumbers: true,
  });
  assertWithinLiveReservation(axisActual, estimate.axisReserve, 'axisWorkUnits');
  assertWithinLiveReservation(
    aggregateActual,
    estimate.aggregateResultReserve,
    'aggregateResultWorkUnits',
  );

  const resolverIdentities = barrier.resolvers.map((resolver) => resolver.identity);
  const handlerIdentities = barrier.factorHandlers.map((handler) => handler.identity);
  const replayParameters = {
    reportingCurrency: currencyPlan.reportingCurrency,
    currencyConversions: currencyPlan.currencyConversions,
    failureMode: barrier.failureMode,
    seed: barrier.seed,
    maximumValuationCells: barrier.maximumValuationCells,
    maximumWorkUnits: barrier.maximumWorkUnits,
    resolvers: resolverIdentities,
    factorHandlers: handlerIdentities,
    timeShockDayCount: 'ACT/365F' as const,
    millisecondsPerYear: MILLISECONDS_PER_YEAR,
    resultLayout: 'scenario-major-v1' as const,
  };
  const layout = {
    order: 'scenario-major-v1' as const,
    targetCount: runtime.length,
    scenarioCount: scenarioSet.scenarios.length,
    cellsPerScenario: runtime.length,
    cellCount: cells.length,
    indexFormula: 'scenarioIndex * targetCount + targetIndex' as const,
  };
  const assumptions = {
    conventionsVersion: CONVENTIONS_VERSION,
    scenarioSetName: scenarioSet.name,
    scenarioSetHash: scenarioSetContentHash(scenarioSet),
    marketSnapshotHash: marketSnapshotContentHash(market),
    marketAsOf: market.asOf,
    inputRateDayCount: market.conventions.dayCount ?? null,
    inputRateCompounding: market.conventions.compounding ?? null,
    resolvedScalarRateDayCount: 'ACT/365F' as const,
    resolvedScalarRateCompounding: 'continuous' as const,
    reportingCurrency: currencyPlan.reportingCurrency,
    currencyConversionPolicy: 'direct-or-inverse-only' as const,
    tagAggregationPolicy: 'overlapping-non-additive; grand total is target-based' as const,
    valuationUnitScaling: 'valuePerUnit * quantity * contractMultiplier' as const,
    timeShockDayCount: 'ACT/365F' as const,
    millisecondsPerYear: MILLISECONDS_PER_YEAR,
    failureMode: barrier.failureMode,
    baseSeed: hasSeededPricer ? barrier.seed : null,
    seedDerivation: hasSeededPricer
      ? ('seed + targetIndex; common across base and scenarios' as const)
      : null,
    resolvers: resolverIdentities,
    factorHandlers: handlerIdentities,
    resultLayout: 'scenario-major-v1' as const,
    workBudgets: {
      valuationCells: {
        configured: barrier.maximumValuationCells,
        default: DEFAULT_MAXIMUM_VALUATION_CELLS,
        hardMaximum: HARD_MAXIMUM_VALUATION_CELLS,
      },
      workUnits: {
        configured: barrier.maximumWorkUnits,
        default: DEFAULT_MAXIMUM_WORK_UNITS,
        hardMaximum: HARD_MAXIMUM_WORK_UNITS,
      },
    } as const,
    replayParameters,
  };
  const metricsFor = (totalActual: number): ScenarioRunMetrics => ({
    valuationCells: metric(barrier.valuationCells, barrier.valuationCells),
    pricerCalls: metric(estimate.estimatedPricerCalls, counters.pricerCalls),
    taylorCalls: metric(estimate.estimatedTaylorCalls, counters.taylorCalls),
    supportsCalls: metric(estimate.supportsDispatches, estimate.supportsDispatches),
    requirements: metric(requirementCount, requirementCount),
    resolverCalls: metric(estimate.resolverDispatches, counters.resolverCalls),
    factorHandlerCalls: metric(estimate.handlerDispatches, counters.factorHandlerCalls),
    inputDataWorkUnits: metric(barrier.inputDataWorkUnits, barrier.inputDataWorkUnits),
    transformationWorkUnits: metric(
      estimate.transformationReserve,
      counters.transformationWorkUnits,
    ),
    valuationResultWorkUnits: metric(
      estimate.valuationResultReserve,
      counters.valuationResultWorkUnits,
    ),
    resultEnvelopeWorkUnits: metric(estimate.resultEnvelopeReserve, resultEnvelopeActual),
    failureSnapshotWorkUnits: metric(estimate.failureSnapshotReserve, failureSnapshotActual),
    totalWorkUnits: metric(estimate.workUnits, totalActual),
    successfulCells: metric(barrier.valuationCells, counters.successfulCells),
    failedCells: metric(0, counters.failedCells),
    blockedCells: metric(0, counters.blockedCells),
  });
  const metadataActual = scanCanonicalData(
    {
      layout,
      scenarioAxis: [],
      targetAxis: [],
      base: [],
      cells: [],
      aggregates: {},
      assumptions,
      diagnostics: {
        warnings: currencyPlan.warnings,
        failures: [],
        unusedCurrencyConversions: currencyPlan.unusedCurrencyConversions,
        metrics: metricsFor(0),
      },
    },
    {
      functionName: 'runScenarios',
      label: 'ScenarioRunResult metadata',
      maximumDepth: 64,
      maximumWorkUnits: estimate.resultMetadataReserve,
      requireFiniteNumbers: true,
    },
  );
  assertWithinLiveReservation(
    metadataActual,
    estimate.resultMetadataReserve,
    'resultMetadataWorkUnits',
  );
  const totalActual =
    barrier.inputDataWorkUnits +
    requirementWork +
    barrier.valuationCells +
    estimate.supportsDispatches +
    estimate.requirementsDispatches +
    counters.resolverCalls +
    counters.factorHandlerCalls +
    failureSnapshotActual +
    counters.valuationResultWorkUnits +
    resultEnvelopeActual +
    instructionDetailActual +
    counters.transformationWorkUnits +
    axisActual +
    aggregateActual +
    metadataActual;
  assertWithinLiveReservation(totalActual, estimate.workUnits, 'totalWorkUnits');
  const metrics = metricsFor(totalActual);
  const result: ScenarioRunResult = {
    layout,
    scenarioAxis,
    targetAxis,
    base: Object.freeze(base),
    cells: Object.freeze(cells),
    aggregates,
    assumptions,
    diagnostics: {
      warnings: currencyPlan.warnings,
      failures: Object.freeze(failures),
      unusedCurrencyConversions: currencyPlan.unusedCurrencyConversions,
      metrics,
    },
  };
  const retainedResultReserve =
    estimate.valuationResultReserve +
    estimate.failureSnapshotReserve +
    estimate.resultEnvelopeReserve +
    estimate.instructionDetailReserve +
    estimate.aggregateResultReserve +
    estimate.axisReserve +
    estimate.resultMetadataReserve;
  scanCanonicalData(result, {
    functionName: 'runScenarios',
    label: 'ScenarioRunResult',
    maximumDepth: 64,
    maximumWorkUnits: retainedResultReserve,
    requireFiniteNumbers: true,
  });
  return deepFreezeDetached(result) as ScenarioRunResult;
}
