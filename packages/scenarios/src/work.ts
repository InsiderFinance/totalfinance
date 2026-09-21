import { ErrorCode, InputError } from '@totalfinance/core';
import type {
  MarketSnapshot,
  ScenarioDefinition,
  ScenarioOverride,
  ScenarioSet,
  ScenarioShock,
} from '@totalfinance/core/artifacts';
import { contentHash } from '@totalfinance/core/artifacts';
import type { MarketRequirement } from '@totalfinance/core/pricing';
import type { CurrencyPairQuote } from '@totalfinance/foreign-exchange';
import {
  snapshotFactorHandlers,
  snapshotResolvers,
  type FactorHandlerSnapshot,
  type ResolverSnapshot,
} from './internal/behaviors.js';
import {
  checkedAdd,
  checkedMultiply,
  describeInputValue,
  readPlainArrayLength,
  scanCanonicalData,
  snapshotClosedRecord,
  snapshotDenseArray,
} from './internal/data.js';
import { scenarioTargetPrivateSymbols } from './targets.js';
import { failureSnapshotWorkLimit } from './internal/failures.js';
import { estimateScenarioAggregateWork } from './aggregates.js';
import type {
  RunScenariosInput,
  ScenarioMetric,
  ScenarioTargetDescriptor,
  TaylorScenarioTargetDescriptor,
} from './types.js';

export const DEFAULT_MAXIMUM_VALUATION_CELLS = 10_000;
export const HARD_MAXIMUM_VALUATION_CELLS = 50_000;
export const DEFAULT_MAXIMUM_WORK_UNITS = 20_000_000;
export const HARD_MAXIMUM_WORK_UNITS = 100_000_000;
export const MAXIMUM_REQUIREMENTS_PER_TARGET = 256;
export const MAXIMUM_CURRENCY_QUOTES = 256;
export const VALUATION_RESULT_WORK_UNITS = 1_024;
export const CALLBACK_RESULT_BASE_WORK_UNITS = 64;
export const CALLBACK_RESULT_WORK_UNITS_PER_COORDINATE = 128;
export const CALLBACK_REQUIREMENT_WORK_MULTIPLIER = 4;

export const RESERVED_SCENARIO_FACTORS: ReadonlySet<string> = new Set([
  'spot',
  'forward',
  'volatility',
  'riskFreeRate',
  'dividend',
  'time',
  'discountCurve',
  'foreignExchangeRate',
]);

interface ParsedRunOptions {
  readonly failureMode: 'fail-fast' | 'collect';
  readonly seed: number | null;
  readonly maximumValuationCells: number;
  readonly maximumWorkUnits: number;
  readonly resolvers: readonly ResolverSnapshot[];
  readonly factorHandlers: readonly FactorHandlerSnapshot[];
}

export interface BarrierAResult extends ParsedRunOptions {
  readonly rawScenarioSet: ScenarioSet;
  readonly rawMarket: MarketSnapshot;
  readonly rawTargets: readonly unknown[];
  readonly rawCurrencyConversions: readonly unknown[];
  readonly reportingCurrency: unknown;
  readonly scenarioCount: number;
  readonly targetCount: number;
  readonly valuationCells: number;
  readonly inputDataWorkUnits: number;
}

function workError(
  field: string,
  message: string,
  code: string = ErrorCode.InputOutOfRange,
): never {
  throw new InputError(`runScenarios: ${field} ${message}`, {
    code,
    context: { function: 'runScenarios', field },
  });
}

function positiveSafeInteger(
  field: string,
  value: unknown,
  defaultValue: number,
  hardMaximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    workError(field, `must be a positive safe integer; received ${describeInputValue(value)}.`);
  }
  if (value > hardMaximum) {
    workError(
      field,
      `may not exceed the hard maximum ${hardMaximum}; received ${value}. Split the run instead.`,
    );
  }
  return value;
}

function parseOptions(value: unknown): ParsedRunOptions {
  const options: Readonly<Record<string, unknown>> =
    value === undefined
      ? Object.freeze({})
      : snapshotClosedRecord(value, {
          functionName: 'runScenarios',
          label: 'options',
          allowedKeys: [
            'failureMode',
            'seed',
            'maximumValuationCells',
            'maximumWorkUnits',
            'marketResolvers',
            'factorHandlers',
          ],
        });
  const failureMode = options['failureMode'] === undefined ? 'fail-fast' : options['failureMode'];
  if (failureMode !== 'fail-fast' && failureMode !== 'collect') {
    workError(
      'options.failureMode',
      `must be 'fail-fast' or 'collect'; received ${describeInputValue(failureMode)}.`,
      ErrorCode.InputInvalidEnum,
    );
  }
  const rawSeed = options['seed'];
  if (
    rawSeed !== undefined &&
    (typeof rawSeed !== 'number' || !Number.isSafeInteger(rawSeed) || rawSeed < 0)
  ) {
    workError(
      'options.seed',
      `must be a non-negative safe integer; received ${describeInputValue(rawSeed)}.`,
    );
  }
  return {
    failureMode,
    seed: rawSeed === undefined ? null : (rawSeed as number),
    maximumValuationCells: positiveSafeInteger(
      'options.maximumValuationCells',
      options['maximumValuationCells'],
      DEFAULT_MAXIMUM_VALUATION_CELLS,
      HARD_MAXIMUM_VALUATION_CELLS,
    ),
    maximumWorkUnits: positiveSafeInteger(
      'options.maximumWorkUnits',
      options['maximumWorkUnits'],
      DEFAULT_MAXIMUM_WORK_UNITS,
      HARD_MAXIMUM_WORK_UNITS,
    ),
    resolvers: snapshotResolvers(options['marketResolvers']),
    factorHandlers: snapshotFactorHandlers(options['factorHandlers']),
  };
}

/** Barrier A: safe lengths and complete stored-data work before Gate-B readers or behavior. */
export function runBarrierA(rawInput: RunScenariosInput): BarrierAResult {
  const input = snapshotClosedRecord(rawInput, {
    functionName: 'runScenarios',
    label: 'input',
    allowedKeys: [
      'scenarioSet',
      'market',
      'targets',
      'reportingCurrency',
      'currencyConversions',
      'options',
    ],
    requiredKeys: ['scenarioSet', 'market', 'targets'],
  });
  const targetCount = readPlainArrayLength(input['targets'], 'runScenarios', 'targets');
  if (targetCount === 0) {
    workError(
      'targets',
      'must contain at least one builder-produced target — an empty run answers no question.',
    );
  }
  const rawScenarioEnvelope = snapshotClosedRecord(input['scenarioSet'], {
    functionName: 'runScenarios',
    label: 'scenarioSet',
    allowedKeys: ['kind', 'schemaVersion', 'name', 'scenarios', 'provenance'],
    requiredKeys: ['kind', 'schemaVersion', 'name', 'scenarios'],
  });
  const scenarioCount = readPlainArrayLength(
    rawScenarioEnvelope['scenarios'],
    'runScenarios',
    'scenarioSet.scenarios',
  );
  const parsed = parseOptions(input['options']);
  const valuationCells = checkedMultiply(
    'runScenarios',
    'valuationCells',
    targetCount,
    checkedAdd('runScenarios', 'scenarioCount + base', scenarioCount, 1),
  );
  if (valuationCells > parsed.maximumValuationCells) {
    workError(
      'targets × (scenarios + 1)',
      `requires ${valuationCells} valuation cells, above the configured maximum ${parsed.maximumValuationCells} (default ${DEFAULT_MAXIMUM_VALUATION_CELLS}, hard maximum ${HARD_MAXIMUM_VALUATION_CELLS}). Split the targets/scenarios or raise maximumValuationCells explicitly.`,
    );
  }
  // Only after the cell cap proves these axes safe to materialize do we snapshot their slots.
  const rawTargets = snapshotDenseArray(input['targets'], 'runScenarios', 'targets');
  const currencyConversionCount =
    input['currencyConversions'] === undefined
      ? 0
      : readPlainArrayLength(input['currencyConversions'], 'runScenarios', 'currencyConversions');
  if (currencyConversionCount > MAXIMUM_CURRENCY_QUOTES) {
    workError(
      'currencyConversions',
      `may contain at most ${MAXIMUM_CURRENCY_QUOTES} quotes; received ${currencyConversionCount}.`,
    );
  }
  const rawCurrencyConversions =
    input['currencyConversions'] === undefined
      ? Object.freeze([])
      : snapshotDenseArray(input['currencyConversions'], 'runScenarios', 'currencyConversions');
  for (let index = 0; index < parsed.factorHandlers.length; index++) {
    const handler = parsed.factorHandlers[index]!;
    if (RESERVED_SCENARIO_FACTORS.has(handler.factor)) {
      workError(
        `options.factorHandlers[${index}].factor`,
        `${JSON.stringify(handler.factor)} is a first-party reserved factor and cannot be overridden by a custom handler.`,
      );
    }
  }

  const knownFullRevaluationTargets = rawTargets.filter((target) => {
    if (target === null || typeof target !== 'object') return false;
    const descriptor = Object.getOwnPropertyDescriptor(target, 'valuationMethod');
    return (
      descriptor !== undefined && 'value' in descriptor && descriptor.value === 'full-revaluation'
    );
  }).length;
  if (knownFullRevaluationTargets > parsed.maximumWorkUnits) {
    workError(
      'options.maximumWorkUnits',
      `is exhausted by ${knownFullRevaluationTargets} required supports dispatches before stored data can be validated.`,
    );
  }
  const maximumDataCost = Math.floor((parsed.maximumWorkUnits - knownFullRevaluationTargets) / 6);
  const scanOptions = {
    functionName: 'runScenarios',
    maximumDepth: 64,
    requireFiniteNumbers: true,
  } as const;
  let dataCost = 0;
  const addScan = (value: unknown, label: string, ignoredSymbols?: ReadonlySet<symbol>): void => {
    const remaining = maximumDataCost - dataCost;
    dataCost = checkedAdd(
      'runScenarios',
      'input data work',
      dataCost,
      scanCanonicalData(value, {
        ...scanOptions,
        label,
        maximumWorkUnits: remaining,
        ...(ignoredSymbols ? { ignoredSymbols } : {}),
      }),
    );
  };
  addScan(input['scenarioSet'], 'scenarioSet');
  addScan(input['market'], 'market');
  addScan(rawCurrencyConversions, 'currencyConversions');
  addScan(rawTargets, 'targets', scenarioTargetPrivateSymbols);
  addScan(
    {
      ...(input['reportingCurrency'] !== undefined
        ? { reportingCurrency: input['reportingCurrency'] }
        : {}),
      options: {
        failureMode: parsed.failureMode,
        seed: parsed.seed,
        maximumValuationCells: parsed.maximumValuationCells,
        maximumWorkUnits: parsed.maximumWorkUnits,
        marketResolvers: parsed.resolvers.map((resolver) => resolver.identity),
        factorHandlers: parsed.factorHandlers.map((handler) => ({
          factor: handler.factor,
          ...handler.identity,
        })),
      },
    },
    'run options and behavior identities',
  );
  const inputDataWorkUnits = checkedMultiply('runScenarios', 'inputDataWorkUnits', 6, dataCost);
  if (
    checkedAdd(
      'runScenarios',
      'Barrier A supports reserve',
      inputDataWorkUnits,
      knownFullRevaluationTargets,
    ) > parsed.maximumWorkUnits
  ) {
    workError(
      'options.maximumWorkUnits',
      `is exhausted by Barrier A (${inputDataWorkUnits} input units plus ${knownFullRevaluationTargets} supports dispatches) before any behavior may run.`,
    );
  }

  return {
    ...parsed,
    rawScenarioSet: input['scenarioSet'] as ScenarioSet,
    rawMarket: input['market'] as MarketSnapshot,
    rawTargets,
    rawCurrencyConversions,
    reportingCurrency: input['reportingCurrency'],
    scenarioCount,
    targetCount,
    valuationCells,
    inputDataWorkUnits,
  };
}

export interface BarrierBTargetPlan {
  readonly descriptor: ScenarioTargetDescriptor;
  readonly requirements: readonly MarketRequirement[];
  readonly requirementDescriptorWorkUnits: number;
  readonly coordinateCount: number;
  readonly unresolvedRequirementCount: number;
  readonly usedForeignExchangeCoordinates: number;
  /** Complete canonical callback-return reserve for the resolver panel for this target. */
  readonly resolverReturnDataWorkReserve: number;
  /** Maximum canonical work accepted from one same-shape factor-handler return. */
  readonly handlerReturnDataWorkLimit: number;
}

export interface BarrierBEstimate {
  readonly workUnits: number;
  readonly supportsDispatches: number;
  readonly requirementsDispatches: number;
  readonly resolverDispatches: number;
  readonly handlerDispatches: number;
  readonly requirementDescriptorWork: number;
  readonly aggregateMemberships: number;
  readonly instructionApplications: number;
  readonly customInstructionCount: number;
  readonly estimatedPricerCalls: number;
  readonly estimatedTaylorCalls: number;
  readonly failureSnapshotReserve: number;
  readonly valuationResultReserve: number;
  readonly resultEnvelopeReserve: number;
  readonly instructionDetailReserve: number;
  readonly aggregateResultReserve: number;
  readonly axisReserve: number;
  readonly transformationReserve: number;
  readonly callbackReturnDataReserve: number;
  readonly resultMetadataReserve: number;
}

function add(current: number, label: string, increment: number): number {
  return checkedAdd('runScenarios', label, current, increment);
}

function multiply(label: string, first: number, second: number): number {
  return checkedMultiply('runScenarios', label, first, second);
}

function canonicalWork(value: unknown, label: string): number {
  return scanCanonicalData(value, {
    functionName: 'runScenarios',
    label,
    requireFiniteNumbers: true,
  });
}

type ScenarioInstruction = ScenarioOverride | ScenarioShock;

function scenarioInstructions(scenario: ScenarioDefinition): readonly {
  readonly phase: 'override' | 'shock';
  readonly instructionIndex: number;
  readonly instruction: ScenarioInstruction;
}[] {
  const result: Array<{
    phase: 'override' | 'shock';
    instructionIndex: number;
    instruction: ScenarioInstruction;
  }> = [];
  for (let index = 0; index < (scenario.overrides?.length ?? 0); index++) {
    result.push({
      phase: 'override',
      instructionIndex: index,
      instruction: scenario.overrides![index]!,
    });
  }
  for (let index = 0; index < scenario.shocks.length; index++) {
    result.push({ phase: 'shock', instructionIndex: index, instruction: scenario.shocks[index]! });
  }
  return result;
}

function requirementFactor(requirement: MarketRequirement): string {
  switch (requirement.kind) {
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

function requirementSubject(requirement: MarketRequirement): string {
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

function instructionMatchesSubject(instruction: ScenarioInstruction, subject: string): boolean {
  return instruction.target === undefined || instruction.target === subject;
}

const RESERVE_HASH = `sha256:${'0'.repeat(64)}`;

function scalarInstructionDetail(
  phase: 'override' | 'shock',
  instructionIndex: number,
  instruction: ScenarioInstruction,
  subject: string,
): unknown {
  return {
    phase,
    instructionIndex,
    factor: instruction.factor,
    ...(instruction.target !== undefined ? { target: instruction.target } : {}),
    subject,
    detail: instruction.factor === 'foreignExchangeRate' ? 'foreign-exchange-rate' : 'scalar',
    before: 0,
    after: 0,
  };
}

function curveInstructionDetail(
  phase: 'override' | 'shock',
  instructionIndex: number,
  instruction: ScenarioInstruction,
  subject: string,
): unknown {
  return {
    phase,
    instructionIndex,
    factor: instruction.factor,
    ...(instruction.target !== undefined ? { target: instruction.target } : {}),
    subject,
    detail: 'discount-curve',
    pillarCount: 4_096,
    beforeCurveHash: RESERVE_HASH,
    afterCurveHash: RESERVE_HASH,
  };
}

function customInstructionDetail(
  phase: 'override' | 'shock',
  instructionIndex: number,
  instruction: ScenarioInstruction,
  targetId: string,
  identity: { readonly name: string; readonly version: string },
): unknown {
  return {
    phase,
    instructionIndex,
    factor: instruction.factor,
    ...(instruction.target !== undefined ? { target: instruction.target } : {}),
    subject: targetId,
    detail: 'custom',
    handler: identity,
    beforeObservationsHash: RESERVE_HASH,
    afterObservationsHash: RESERVE_HASH,
  };
}

function taylorFactorSubject(
  descriptor: TaylorScenarioTargetDescriptor,
  factor: string,
): string | null {
  const key = factor === 'time' ? 'valuationInstant' : factor;
  if (
    key !== 'spot' &&
    key !== 'volatility' &&
    key !== 'riskFreeRate' &&
    key !== 'dividend' &&
    key !== 'valuationInstant'
  )
    return null;
  const value = descriptor.taylor.factors[key];
  if (value === undefined) return null;
  return key === 'valuationInstant' || !('subject' in value) ? 'global' : value.subject;
}

function estimateInstructionDetailReserve(input: {
  readonly barrierA: BarrierAResult;
  readonly scenarioSet: ScenarioSet;
  readonly targets: readonly BarrierBTargetPlan[];
  readonly reportingCurrency: string;
}): number {
  // Every successful base cell carries one empty appliedInstructions array.
  let reserve = input.targets.length;
  for (const scenario of input.scenarioSet.scenarios) {
    for (const target of input.targets) {
      let rowCount = 0;
      let rowWork = 0;
      for (const ref of scenarioInstructions(scenario)) {
        const instruction = ref.instruction;
        if (instruction.factor === 'foreignExchangeRate') {
          if (target.usedForeignExchangeCoordinates > 0) {
            const direct = `${target.descriptor.currency}/${input.reportingCurrency}`;
            const inverse = `${input.reportingCurrency}/${target.descriptor.currency}`;
            if (
              instruction.target === undefined ||
              instruction.target === direct ||
              instruction.target === inverse
            ) {
              rowCount++;
              rowWork = add(
                rowWork,
                'FX instruction detail reserve',
                canonicalWork(
                  scalarInstructionDetail(ref.phase, ref.instructionIndex, instruction, direct),
                  'FX instruction detail reserve',
                ),
              );
            }
          }
          continue;
        }
        if (target.descriptor.valuationMethod === 'taylor') {
          const subject = taylorFactorSubject(target.descriptor, instruction.factor);
          if (subject !== null && instructionMatchesSubject(instruction, subject)) {
            rowCount++;
            rowWork = add(
              rowWork,
              'Taylor instruction detail reserve',
              canonicalWork(
                scalarInstructionDetail(ref.phase, ref.instructionIndex, instruction, subject),
                'Taylor instruction detail reserve',
              ),
            );
          }
          continue;
        }
        if (RESERVED_SCENARIO_FACTORS.has(instruction.factor)) {
          for (const requirement of target.requirements) {
            const subject = requirementSubject(requirement);
            if (
              requirementFactor(requirement) !== instruction.factor ||
              !instructionMatchesSubject(instruction, subject)
            )
              continue;
            rowCount++;
            rowWork = add(
              rowWork,
              'full-revaluation instruction detail reserve',
              canonicalWork(
                requirement.kind === 'discountCurve'
                  ? curveInstructionDetail(ref.phase, ref.instructionIndex, instruction, subject)
                  : scalarInstructionDetail(ref.phase, ref.instructionIndex, instruction, subject),
                'full-revaluation instruction detail reserve',
              ),
            );
          }
          continue;
        }
        const handler = input.barrierA.factorHandlers.find(
          (candidate) => candidate.factor === instruction.factor,
        );
        if (handler !== undefined) {
          rowCount++;
          rowWork = add(
            rowWork,
            'custom instruction detail reserve',
            canonicalWork(
              customInstructionDetail(
                ref.phase,
                ref.instructionIndex,
                instruction,
                target.descriptor.id,
                handler.identity,
              ),
              'custom instruction detail reserve',
            ),
          );
        }
      }
      // Array container + dense-slot cost + complete detail rows.
      reserve = add(reserve, 'instruction detail reserve', 1 + rowCount + rowWork);
    }
  }
  return reserve;
}

function conversionReserve(
  descriptor: ScenarioTargetDescriptor,
  reportingCurrency: string,
): unknown {
  return descriptor.currency === reportingCurrency
    ? null
    : {
        sourceQuoteIndex: 0,
        orientation: 'direct',
        quote: {
          baseCurrency: descriptor.currency,
          quoteCurrency: reportingCurrency,
          quotePerBase: 1,
        },
      };
}

function successfulEnvelopeBase(
  target: BarrierBTargetPlan,
  targetIndex: number,
  reportingCurrency: string,
): Record<string, unknown> {
  const descriptor = target.descriptor;
  return {
    targetIndex,
    targetId: descriptor.id,
    quantity: descriptor.quantity,
    contractMultiplier: descriptor.contractMultiplier,
    valuationCurrency: descriptor.currency,
    reportingCurrency,
    valuePerUnit: 0,
    positionValue: 0,
    reportingPositionValue: 0,
    currencyConversion: conversionReserve(descriptor, reportingCurrency),
    observationOrFactorSetHash: RESERVE_HASH,
    effectiveSeed: null,
  };
}

function estimateResultEnvelopeReserve(input: {
  readonly barrierA: BarrierAResult;
  readonly scenarioSet: ScenarioSet;
  readonly targets: readonly BarrierBTargetPlan[];
  readonly reportingCurrency: string;
}): number {
  const resolverIdentities = input.barrierA.resolvers.map((resolver) => resolver.identity);
  const handlerIdentities = input.barrierA.factorHandlers.map((handler) => handler.identity);
  const emptyIdentityArrays = canonicalWork([], 'empty behavior identity array') * 2;
  // Dense base/cell arrays charge one slot unit per retained valuation cell.
  let reserve = input.barrierA.valuationCells;
  for (let targetIndex = 0; targetIndex < input.targets.length; targetIndex++) {
    const target = input.targets[targetIndex]!;
    const descriptor = target.descriptor;
    const common = successfulEnvelopeBase(target, targetIndex, input.reportingCurrency);
    const baseSuccess =
      descriptor.valuationMethod === 'full-revaluation'
        ? {
            kind: 'base',
            status: 'complete',
            ...common,
            valuationMethod: 'full-revaluation',
            pricer: descriptor.pricer,
          }
        : {
            kind: 'base',
            status: 'complete',
            ...common,
            valuationMethod: 'taylor',
            baseValueSource: 'supplied-base-value-per-unit',
          };
    const failedBase = {
      kind: 'base',
      status: 'failed',
      targetIndex,
      targetId: descriptor.id,
      valuationMethod: descriptor.valuationMethod,
      valuePerUnit: null,
      positionValue: null,
      reportingPositionValue: null,
    };
    const baseIdentityWork =
      descriptor.valuationMethod === 'full-revaluation'
        ? canonicalWork(resolverIdentities, 'base resolver identities') +
          canonicalWork([], 'base factor-handler identities')
        : emptyIdentityArrays;
    reserve = add(
      reserve,
      'base result envelope reserve',
      Math.max(
        canonicalWork(baseSuccess, 'base result envelope') + baseIdentityWork,
        canonicalWork(failedBase, 'failed base result envelope'),
      ),
    );

    for (
      let scenarioIndex = 0;
      scenarioIndex < input.scenarioSet.scenarios.length;
      scenarioIndex++
    ) {
      const scenarioName = input.scenarioSet.scenarios[scenarioIndex]!.name;
      const scenarioSuccess = {
        kind: 'scenario',
        status: 'complete',
        scenarioIndex,
        scenarioName,
        localPnl: 0,
        reportingPnl: 0,
        ...common,
        valuationMethod: descriptor.valuationMethod,
        ...(descriptor.valuationMethod === 'full-revaluation' ? { pricer: descriptor.pricer } : {}),
      };
      const failedScenario = {
        kind: 'scenario',
        status: 'blocked',
        targetIndex,
        targetId: descriptor.id,
        scenarioIndex,
        scenarioName,
        valuationMethod: descriptor.valuationMethod,
        valuePerUnit: null,
        positionValue: null,
        reportingPositionValue: null,
        localPnl: null,
        reportingPnl: null,
      };
      const scenarioIdentityWork =
        descriptor.valuationMethod === 'full-revaluation'
          ? canonicalWork(resolverIdentities, 'scenario resolver identities') +
            canonicalWork(handlerIdentities, 'scenario factor-handler identities')
          : emptyIdentityArrays;
      reserve = add(
        reserve,
        'scenario result envelope reserve',
        Math.max(
          canonicalWork(scenarioSuccess, 'scenario result envelope') + scenarioIdentityWork,
          canonicalWork(failedScenario, 'failed scenario result envelope'),
        ),
      );
    }
  }
  return reserve;
}

/** Barrier B's exact conservative estimate after one supports/requirements pass per full target. */
export function estimateBarrierB(input: {
  readonly barrierA: BarrierAResult;
  readonly scenarioSet: ScenarioSet;
  readonly targets: readonly BarrierBTargetPlan[];
  readonly reportingCurrency: string;
}): BarrierBEstimate {
  const fullTargets = input.targets.filter(
    (target) => target.descriptor.valuationMethod === 'full-revaluation',
  ).length;
  const taylorTargets = input.targets.length - fullTargets;
  let totalInstructions = 0;
  let customInstructionCount = 0;
  for (const scenario of input.scenarioSet.scenarios) {
    const instructions = [...(scenario.overrides ?? []), ...scenario.shocks];
    totalInstructions = add(totalInstructions, 'scenario instruction count', instructions.length);
    customInstructionCount = add(
      customInstructionCount,
      'custom instruction count',
      instructions.filter((instruction) => !RESERVED_SCENARIO_FACTORS.has(instruction.factor))
        .length,
    );
  }
  const instructionApplications = multiply(
    'instructionApplications',
    input.targets.length,
    totalInstructions,
  );
  let aggregateMemberships = 0;
  for (const target of input.targets) {
    const descriptor = target.descriptor;
    aggregateMemberships = add(aggregateMemberships, 'aggregate memberships', 2);
    if (descriptor.underlying !== undefined)
      aggregateMemberships = add(aggregateMemberships, 'aggregate memberships', 1);
    if (descriptor.strategy !== undefined)
      aggregateMemberships = add(aggregateMemberships, 'aggregate memberships', 1);
    if (descriptor.account !== undefined)
      aggregateMemberships = add(aggregateMemberships, 'aggregate memberships', 1);
    if (descriptor.book !== undefined)
      aggregateMemberships = add(aggregateMemberships, 'aggregate memberships', 1);
    aggregateMemberships = add(
      aggregateMemberships,
      'aggregate memberships',
      descriptor.tags.length,
    );
  }
  const supportsDispatches = fullTargets;
  const requirementsDispatches = fullTargets;
  const resolverDispatches = multiply(
    'resolverDispatches',
    input.targets.reduce((sum, target) => sum + target.unresolvedRequirementCount, 0),
    input.barrierA.resolvers.length,
  );
  const handlerDispatches = multiply('handlerDispatches', fullTargets, customInstructionCount);
  let failureSnapshotReserve = 0;
  for (let targetIndex = 0; targetIndex < input.targets.length; targetIndex++) {
    const target = input.targets[targetIndex]!;
    const baseLimit = failureSnapshotWorkLimit({
      targetIndex,
      targetId: target.descriptor.id,
      scenarioIndex: null,
      scenarioName: null,
      valuationMethod: target.descriptor.valuationMethod,
    });
    let scenarioFailureReserve = 0;
    let maximumScenarioLimit = 0;
    for (
      let scenarioIndex = 0;
      scenarioIndex < input.scenarioSet.scenarios.length;
      scenarioIndex++
    ) {
      const scenarioLimit = failureSnapshotWorkLimit({
        targetIndex,
        targetId: target.descriptor.id,
        scenarioIndex,
        scenarioName: input.scenarioSet.scenarios[scenarioIndex]!.name,
        valuationMethod: target.descriptor.valuationMethod,
      });
      maximumScenarioLimit = Math.max(maximumScenarioLimit, scenarioLimit);
      scenarioFailureReserve = add(
        scenarioFailureReserve,
        'scenario failure retention reserve',
        multiply('cell plus diagnostics failure retention', scenarioLimit, 2),
      );
    }
    if (input.barrierA.failureMode === 'collect') {
      const blockedByBaseReserve = multiply(
        'base failure plus diagnostics and blocked-cell retention',
        baseLimit,
        input.scenarioSet.scenarios.length + 2,
      );
      failureSnapshotReserve = add(
        failureSnapshotReserve,
        'failure snapshot reserve',
        Math.max(blockedByBaseReserve, scenarioFailureReserve),
      );
    } else {
      failureSnapshotReserve = Math.max(failureSnapshotReserve, baseLimit, maximumScenarioLimit);
    }
  }
  const valuationResultReserve = multiply(
    'valuationResultReserve',
    input.barrierA.valuationCells,
    VALUATION_RESULT_WORK_UNITS,
  );
  const resultEnvelopeReserve = estimateResultEnvelopeReserve(input);
  const instructionDetailReserve = estimateInstructionDetailReserve(input);
  // Complete top-level assumptions/diagnostics/replay metadata is a generated subset of the
  // already-proved input plus fixed runner strings. Six times the input's canonical cost is the
  // same conservative multi-walk reserve used by Barrier A and prevents an unbounded final scan.
  const resultMetadataReserve = input.barrierA.inputDataWorkUnits;
  const targetAxis = input.targets.map((target, targetIndex) => ({
    ...target.descriptor,
    targetIndex,
  }));
  const scenarioAxis = input.scenarioSet.scenarios.map((scenario, scenarioIndex) => ({
    scenarioIndex,
    name: scenario.name,
    scenarioHash: contentHash(scenario),
    overrideCount: scenario.overrides?.length ?? 0,
    shockCount: scenario.shocks.length,
  }));
  const aggregateResultReserve = estimateScenarioAggregateWork({
    targets: targetAxis,
    scenarioNames: input.scenarioSet.scenarios.map((scenario) => scenario.name),
    reportingCurrency: input.reportingCurrency,
  });
  const axisReserve = scanCanonicalData(
    { scenarioAxis, targetAxis },
    {
      functionName: 'runScenarios',
      label: 'result axes reserve',
      requireFiniteNumbers: true,
    },
  );
  const requirementDescriptorWork = input.targets.reduce(
    (sum, target) => add(sum, 'requirement descriptor work', target.requirementDescriptorWorkUnits),
    0,
  );
  const coordinateTotal = input.targets.reduce(
    (sum, target) =>
      add(sum, 'coordinate count', target.coordinateCount + target.usedForeignExchangeCoordinates),
    0,
  );
  let transformationReserve = coordinateTotal;
  for (const scenario of input.scenarioSet.scenarios) {
    const multiplier = 2 + (scenario.overrides?.length ?? 0) + scenario.shocks.length;
    for (const target of input.targets) {
      transformationReserve = add(
        transformationReserve,
        'transformation reserve',
        multiply(
          'target transformation reserve',
          target.coordinateCount + target.usedForeignExchangeCoordinates,
          multiplier,
        ),
      );
    }
  }
  transformationReserve = add(
    transformationReserve,
    'aggregate transformation reserve',
    multiply(
      'aggregate memberships execution',
      aggregateMemberships,
      input.scenarioSet.scenarios.length + 1,
    ),
  );
  const callbackReturnDataReserve = input.targets.reduce(
    (sum, target) =>
      add(
        sum,
        'callback return data reserve',
        add(
          target.resolverReturnDataWorkReserve,
          'target callback return data reserve',
          multiply(
            'handler callback return reserve',
            target.handlerReturnDataWorkLimit,
            target.descriptor.valuationMethod === 'full-revaluation' ? customInstructionCount : 0,
          ),
        ),
      ),
    0,
  );
  transformationReserve = add(
    transformationReserve,
    'transformation and callback-return reserve',
    callbackReturnDataReserve,
  );

  const estimatedPricerCalls = multiply(
    'estimated pricer calls',
    fullTargets,
    input.scenarioSet.scenarios.length + 1,
  );
  const estimatedTaylorCalls = multiply(
    'estimated Taylor calls',
    taylorTargets,
    input.scenarioSet.scenarios.length,
  );

  let workUnits = input.barrierA.inputDataWorkUnits;
  for (const [label, increment] of [
    ['requirement descriptors', requirementDescriptorWork],
    ['valuation cells', input.barrierA.valuationCells],
    ['supports dispatches', supportsDispatches],
    ['requirements dispatches', requirementsDispatches],
    ['resolver dispatches', resolverDispatches],
    ['handler dispatches', handlerDispatches],
    ['failure snapshots', failureSnapshotReserve],
    ['valuation results', valuationResultReserve],
    ['result envelopes', resultEnvelopeReserve],
    ['instruction detail', instructionDetailReserve],
    ['aggregate results', aggregateResultReserve],
    ['axes', axisReserve],
    ['result metadata', resultMetadataReserve],
    ['transformations', transformationReserve],
  ] as const) {
    workUnits = add(workUnits, `work estimate: ${label}`, increment);
  }
  if (workUnits > input.barrierA.maximumWorkUnits) {
    workError(
      'options.maximumWorkUnits',
      `is ${input.barrierA.maximumWorkUnits}, but the complete Barrier-B execution plan requires ${workUnits} conservative work units (default ${DEFAULT_MAXIMUM_WORK_UNITS}, hard maximum ${HARD_MAXIMUM_WORK_UNITS}). Split the run or raise the option explicitly.`,
    );
  }
  return {
    workUnits,
    supportsDispatches,
    requirementsDispatches,
    resolverDispatches,
    handlerDispatches,
    requirementDescriptorWork,
    aggregateMemberships,
    instructionApplications,
    customInstructionCount,
    estimatedPricerCalls,
    estimatedTaylorCalls,
    failureSnapshotReserve,
    valuationResultReserve,
    resultEnvelopeReserve,
    instructionDetailReserve,
    aggregateResultReserve,
    axisReserve,
    transformationReserve,
    callbackReturnDataReserve,
    resultMetadataReserve,
  };
}

/** Conservative canonical-data cap for one resolver/handler observation result. */
export function callbackObservationWorkLimit(
  requirementDescriptorWorkUnits: number,
  reservedCoordinates: number,
): number {
  return add(
    CALLBACK_RESULT_BASE_WORK_UNITS,
    'callback observation work limit',
    add(
      multiply(
        'callback requirement work',
        requirementDescriptorWorkUnits,
        CALLBACK_REQUIREMENT_WORK_MULTIPLIER,
      ),
      'callback observation coordinate work',
      multiply(
        'callback coordinate work',
        reservedCoordinates,
        CALLBACK_RESULT_WORK_UNITS_PER_COORDINATE,
      ),
    ),
  );
}

export function metric(estimated: number, actual: number | null): ScenarioMetric {
  return Object.freeze({
    estimated,
    actual,
    unavailableReason: actual === null ? 'unavailable before execution completed' : null,
  });
}

export function assertWithinLiveReservation(
  actual: number,
  reservation: number,
  label: string,
): void {
  if (actual > reservation) {
    workError(
      label,
      `consumed ${actual} units, above its preflight reservation ${reservation}; the callback expanded work beyond its declared shape.`,
    );
  }
}

export type ValidCurrencyConversions = readonly Readonly<CurrencyPairQuote>[];
