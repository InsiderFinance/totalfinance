import { ErrorCode, InputError, WarningCode, warning, type QuantWarning } from '@totalfinance/core';
import type {
  ScenarioDefinition,
  ScenarioOverride,
  ScenarioShock,
} from '@totalfinance/core/artifacts';
import {
  convertCurrency,
  requireCurrencyCode,
  requireCurrencyPairQuote,
  type CurrencyPairQuote,
} from '@totalfinance/foreign-exchange';
import {
  checkedAdd,
  deepFreezeDetached,
  detachCanonicalData,
  snapshotDenseArray,
} from './internal/data.js';
import { instructionMatchKey, type ScenarioInstructionPhase } from './transform.js';
import { MAXIMUM_CURRENCY_QUOTES } from './work.js';
import type {
  ScenarioAppliedScalarInstruction,
  ScenarioCurrencyConversionUse,
  ScenarioTargetDescriptor,
} from './types.js';

const FUNCTION_NAME = 'runScenarios';

/** Validated reporting-currency plan in target order and original quote order. */
export interface CurrencyConversionPlan {
  readonly reportingCurrency: string;
  readonly currencyConversions: readonly Readonly<CurrencyPairQuote>[];
  readonly conversionsByTarget: readonly (ScenarioCurrencyConversionUse | null)[];
  /** Barrier-B hook: identity targets contribute zero; every foreign target contributes one. */
  readonly targetCoordinateCounts: readonly number[];
  readonly usedSourceQuoteIndices: readonly number[];
  readonly unusedCurrencyConversions: readonly Readonly<CurrencyPairQuote>[];
  readonly warnings: readonly QuantWarning[];
}

/** One scenario's transformed reporting-currency quote bindings in target order. */
export interface ScenarioCurrencyConversionPlan {
  readonly conversionsByTarget: readonly (ScenarioCurrencyConversionUse | null)[];
  readonly appliedInstructionsByTarget: readonly (readonly ScenarioAppliedScalarInstruction[])[];
}

/** Precomputed FX transformations for every scenario, before valuation begins. */
export interface CurrencyConversionTransformationResult {
  readonly scenarios: readonly ScenarioCurrencyConversionPlan[];
  readonly matchedInstructions: ReadonlySet<string>;
  /** Actual bounded coordinate visits for comparison with Barrier B's transformation reserve. */
  readonly transformationWorkUnits: number;
}

interface InstructionRef {
  readonly phase: ScenarioInstructionPhase;
  readonly instructionIndex: number;
  readonly instruction: ScenarioOverride | ScenarioShock;
}

function fxError(
  field: string,
  message: string,
  code: string = ErrorCode.InputOutOfRange,
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new InputError(`${FUNCTION_NAME}: ${field} ${message}`, {
    code,
    context: { function: FUNCTION_NAME, field, ...context },
  });
}

function pairLabel(quote: Readonly<CurrencyPairQuote>): string {
  return `${quote.baseCurrency}/${quote.quoteCurrency}`;
}

function unorderedPairKey(firstCurrency: string, secondCurrency: string): string {
  return firstCurrency < secondCurrency
    ? `${firstCurrency}\u0000${secondCurrency}`
    : `${secondCurrency}\u0000${firstCurrency}`;
}

function connects(
  quote: Readonly<CurrencyPairQuote>,
  firstCurrency: string,
  secondCurrency: string,
): boolean {
  return (
    (quote.baseCurrency === firstCurrency && quote.quoteCurrency === secondCurrency) ||
    (quote.baseCurrency === secondCurrency && quote.quoteCurrency === firstCurrency)
  );
}

function orientationFor(
  quote: Readonly<CurrencyPairQuote>,
  fromCurrency: string,
  toCurrency: string,
): 'direct' | 'inverted' {
  if (!connects(quote, fromCurrency, toCurrency)) {
    fxError(
      'currencyConversions',
      `contains ${pairLabel(quote)}, which does not connect valuation currency ${fromCurrency} to reporting currency ${toCurrency}.`,
      ErrorCode.InputOutOfRange,
      { fromCurrency, toCurrency, quote: pairLabel(quote) },
    );
  }
  return quote.baseCurrency === fromCurrency ? 'direct' : 'inverted';
}

function validateAndDetachQuotes(
  value: readonly unknown[],
): readonly Readonly<CurrencyPairQuote>[] {
  const rawQuotes = snapshotDenseArray(value, FUNCTION_NAME, 'currencyConversions');
  if (rawQuotes.length > MAXIMUM_CURRENCY_QUOTES) {
    fxError(
      'currencyConversions',
      `may contain at most ${MAXIMUM_CURRENCY_QUOTES} quotes; received ${rawQuotes.length}.`,
    );
  }
  return Object.freeze(
    rawQuotes.map((member, sourceQuoteIndex) => {
      const label = `currencyConversions[${sourceQuoteIndex}]`;
      const detached = detachCanonicalData(member, {
        functionName: FUNCTION_NAME,
        label,
        requireFiniteNumbers: true,
      });
      requireCurrencyPairQuote(FUNCTION_NAME, label, detached as CurrencyPairQuote);
      return detached as Readonly<CurrencyPairQuote>;
    }),
  );
}

function resolveReportingCurrency(
  value: unknown,
  targets: readonly ScenarioTargetDescriptor[],
): string {
  const firstCurrency = targets[0]?.currency;
  if (firstCurrency === undefined) {
    fxError(
      'targets',
      'must contain at least one target before reporting currency can be inferred.',
      ErrorCode.InputMissingField,
    );
  }
  requireCurrencyCode(FUNCTION_NAME, 'targets[0].currency', firstCurrency);
  let allCurrenciesEqual = true;
  for (let targetIndex = 1; targetIndex < targets.length; targetIndex++) {
    const currency = targets[targetIndex]!.currency;
    requireCurrencyCode(FUNCTION_NAME, `targets[${targetIndex}].currency`, currency);
    if (currency !== firstCurrency) allCurrenciesEqual = false;
  }
  if (value === undefined) {
    if (!allCurrenciesEqual) {
      fxError(
        'reportingCurrency',
        'is required when targets use more than one valuation currency — name the one currency in which values and P&L should aggregate.',
        ErrorCode.InputMissingField,
      );
    }
    return firstCurrency;
  }
  requireCurrencyCode(FUNCTION_NAME, 'reportingCurrency', value);
  return value;
}

/**
 * Validate caller-supplied quotes and bind exactly one direct-or-inverted quote to each foreign
 * target. Selection is exact-pair only: there is no triangulation, vendor choice, or snapshot-spot
 * fallback. Extra valid quotes remain reusable input but are surfaced as diagnostics.
 */
export function prepareCurrencyPlan(input: {
  readonly reportingCurrency: unknown;
  readonly currencyConversions: readonly unknown[];
  readonly targets: readonly ScenarioTargetDescriptor[];
}): CurrencyConversionPlan {
  const reportingCurrency = resolveReportingCurrency(input.reportingCurrency, input.targets);
  const currencyConversions = validateAndDetachQuotes(input.currencyConversions);
  const quoteIndicesByPair = new Map<string, number[]>();
  for (
    let sourceQuoteIndex = 0;
    sourceQuoteIndex < currencyConversions.length;
    sourceQuoteIndex++
  ) {
    const quote = currencyConversions[sourceQuoteIndex]!;
    const key = unorderedPairKey(quote.baseCurrency, quote.quoteCurrency);
    const indices = quoteIndicesByPair.get(key);
    if (indices === undefined) quoteIndicesByPair.set(key, [sourceQuoteIndex]);
    else indices.push(sourceQuoteIndex);
  }

  const usedSourceQuoteIndices = new Set<number>();
  const conversionsByTarget: Array<ScenarioCurrencyConversionUse | null> = [];
  const targetCoordinateCounts: number[] = [];
  for (let targetIndex = 0; targetIndex < input.targets.length; targetIndex++) {
    const target = input.targets[targetIndex]!;
    requireCurrencyCode(FUNCTION_NAME, `targets[${targetIndex}].currency`, target.currency);
    if (target.currency === reportingCurrency) {
      conversionsByTarget.push(null);
      targetCoordinateCounts.push(0);
      continue;
    }
    const pairKey = unorderedPairKey(target.currency, reportingCurrency);
    const candidateIndices = quoteIndicesByPair.get(pairKey) ?? [];
    if (candidateIndices.length === 0) {
      fxError(
        'currencyConversions',
        `must contain one quote connecting target '${target.id}' valuation currency ${target.currency} to reporting currency ${reportingCurrency}, in either orientation. No triangulation or market-snapshot fallback is performed.`,
        ErrorCode.InputMissingField,
        { targetIndex, targetId: target.id, targetCurrency: target.currency, reportingCurrency },
      );
    }
    if (candidateIndices.length > 1) {
      fxError(
        'currencyConversions',
        `contains ${candidateIndices.length} quotes connecting ${target.currency} and ${reportingCurrency} at source indices ${candidateIndices.join(', ')}. The runner cannot choose among duplicate or ambiguous quotes; supply exactly one.`,
        ErrorCode.InputOutOfRange,
        {
          targetIndex,
          targetId: target.id,
          targetCurrency: target.currency,
          reportingCurrency,
          sourceQuoteIndices: Object.freeze([...candidateIndices]),
        },
      );
    }
    const sourceQuoteIndex = candidateIndices[0]!;
    const quote = currencyConversions[sourceQuoteIndex]!;
    const conversion = deepFreezeDetached<ScenarioCurrencyConversionUse>({
      sourceQuoteIndex,
      orientation: orientationFor(quote, target.currency, reportingCurrency),
      quote,
    });
    conversionsByTarget.push(conversion);
    targetCoordinateCounts.push(1);
    usedSourceQuoteIndices.add(sourceQuoteIndex);
  }

  const usedIndices = Object.freeze(
    [...usedSourceQuoteIndices].sort((first, second) => first - second),
  );
  const unusedCurrencyConversions: Readonly<CurrencyPairQuote>[] = [];
  const warnings: QuantWarning[] = [];
  for (
    let sourceQuoteIndex = 0;
    sourceQuoteIndex < currencyConversions.length;
    sourceQuoteIndex++
  ) {
    if (usedSourceQuoteIndices.has(sourceQuoteIndex)) continue;
    const quote = currencyConversions[sourceQuoteIndex]!;
    unusedCurrencyConversions.push(quote);
    warnings.push(
      warning(
        WarningCode.ScenarioUnusedCurrencyConversion,
        `currencyConversions[${sourceQuoteIndex}] (${pairLabel(quote)}) was valid but no target required it for reporting in ${reportingCurrency}.`,
        'warn',
        {
          sourceQuoteIndex,
          baseCurrency: quote.baseCurrency,
          quoteCurrency: quote.quoteCurrency,
          reportingCurrency,
        },
      ),
    );
  }

  return deepFreezeDetached({
    reportingCurrency,
    currencyConversions,
    conversionsByTarget: Object.freeze(conversionsByTarget),
    targetCoordinateCounts: Object.freeze(targetCoordinateCounts),
    usedSourceQuoteIndices: usedIndices,
    unusedCurrencyConversions: Object.freeze(unusedCurrencyConversions),
    warnings: Object.freeze(warnings),
  });
}

function instructionRefs(scenario: ScenarioDefinition): readonly InstructionRef[] {
  const refs: InstructionRef[] = [];
  for (
    let instructionIndex = 0;
    instructionIndex < (scenario.overrides?.length ?? 0);
    instructionIndex++
  ) {
    refs.push({
      phase: 'override',
      instructionIndex,
      instruction: scenario.overrides![instructionIndex]!,
    });
  }
  for (let instructionIndex = 0; instructionIndex < scenario.shocks.length; instructionIndex++) {
    refs.push({
      phase: 'shock',
      instructionIndex,
      instruction: scenario.shocks[instructionIndex]!,
    });
  }
  return refs;
}

function transformQuote(
  quote: Readonly<CurrencyPairQuote>,
  ref: InstructionRef,
  scenarioIndex: number,
  scenarioName: string,
): {
  readonly quote: Readonly<CurrencyPairQuote>;
  readonly detail: ScenarioAppliedScalarInstruction;
} {
  const before = quote.quotePerBase;
  const after =
    ref.phase === 'override'
      ? ref.instruction.value
      : (ref.instruction as ScenarioShock).kind === 'percent'
        ? before * (1 + ref.instruction.value)
        : before + ref.instruction.value;
  const candidate = {
    baseCurrency: quote.baseCurrency,
    quoteCurrency: quote.quoteCurrency,
    quotePerBase: after,
  };
  try {
    requireCurrencyPairQuote(FUNCTION_NAME, 'transformed currency conversion', candidate);
  } catch (error) {
    throw new InputError(
      `${FUNCTION_NAME}: foreignExchangeRate instruction produced invalid ${pairLabel(quote)} quotePerBase ${String(after)} after this ordered step; FX quotes must remain finite and strictly positive and are never clamped.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: FUNCTION_NAME,
          scenarioIndex,
          scenarioName,
          phase: ref.phase,
          instructionIndex: ref.instructionIndex,
          factor: 'foreignExchangeRate',
          subject: pairLabel(quote),
          before,
          after,
        },
        cause: error,
      },
    );
  }
  const transformed = detachCanonicalData(candidate, {
    functionName: FUNCTION_NAME,
    label: 'transformed currency conversion',
    requireFiniteNumbers: true,
  }) as Readonly<CurrencyPairQuote>;
  return {
    quote: transformed,
    detail: deepFreezeDetached({
      phase: ref.phase,
      instructionIndex: ref.instructionIndex,
      factor: 'foreignExchangeRate',
      ...(ref.instruction.target !== undefined ? { target: ref.instruction.target } : {}),
      subject: pairLabel(quote),
      detail: 'foreign-exchange-rate',
      before,
      after,
    }),
  };
}

/**
 * Apply FX instructions to used quotes only. All scenarios are precomputed so the runner can merge
 * unmatched-instruction evidence before the first pricer call.
 */
export function transformCurrencyPlan(input: {
  readonly plan: CurrencyConversionPlan;
  readonly scenarioDefinitions: readonly ScenarioDefinition[];
}): CurrencyConversionTransformationResult {
  const baseUseBySourceIndex = new Map<number, ScenarioCurrencyConversionUse>();
  for (const conversion of input.plan.conversionsByTarget) {
    if (conversion !== null && !baseUseBySourceIndex.has(conversion.sourceQuoteIndex)) {
      baseUseBySourceIndex.set(conversion.sourceQuoteIndex, conversion);
    }
  }
  const matchedInstructions = new Set<string>();
  const scenarioPlans: ScenarioCurrencyConversionPlan[] = [];
  let transformationWorkUnits = 0;

  for (let scenarioIndex = 0; scenarioIndex < input.scenarioDefinitions.length; scenarioIndex++) {
    const scenario = input.scenarioDefinitions[scenarioIndex]!;
    const quoteBySourceIndex = new Map<number, Readonly<CurrencyPairQuote>>();
    const detailsBySourceIndex = new Map<number, ScenarioAppliedScalarInstruction[]>();
    for (const sourceQuoteIndex of input.plan.usedSourceQuoteIndices) {
      quoteBySourceIndex.set(sourceQuoteIndex, baseUseBySourceIndex.get(sourceQuoteIndex)!.quote);
      detailsBySourceIndex.set(sourceQuoteIndex, []);
    }

    for (const ref of instructionRefs(scenario)) {
      if (ref.instruction.factor !== 'foreignExchangeRate') continue;
      const matchKey = instructionMatchKey(scenarioIndex, ref.phase, ref.instructionIndex);
      for (const sourceQuoteIndex of input.plan.usedSourceQuoteIndices) {
        transformationWorkUnits = checkedAdd(
          FUNCTION_NAME,
          'FX transformation work',
          transformationWorkUnits,
          1,
        );
        const quote = quoteBySourceIndex.get(sourceQuoteIndex)!;
        const subject = pairLabel(quote);
        if (ref.instruction.target !== undefined && ref.instruction.target !== subject) continue;
        const transformed = transformQuote(quote, ref, scenarioIndex, scenario.name);
        quoteBySourceIndex.set(sourceQuoteIndex, transformed.quote);
        detailsBySourceIndex.get(sourceQuoteIndex)!.push(transformed.detail);
        matchedInstructions.add(matchKey);
      }
    }

    const conversionsByTarget: Array<ScenarioCurrencyConversionUse | null> = [];
    const appliedInstructionsByTarget: Array<readonly ScenarioAppliedScalarInstruction[]> = [];
    for (const baseConversion of input.plan.conversionsByTarget) {
      if (baseConversion === null) {
        conversionsByTarget.push(null);
        appliedInstructionsByTarget.push([]);
        continue;
      }
      transformationWorkUnits = checkedAdd(
        FUNCTION_NAME,
        'FX transformation work',
        transformationWorkUnits,
        1,
      );
      conversionsByTarget.push(
        deepFreezeDetached({
          sourceQuoteIndex: baseConversion.sourceQuoteIndex,
          orientation: baseConversion.orientation,
          quote: quoteBySourceIndex.get(baseConversion.sourceQuoteIndex)!,
        }),
      );
      appliedInstructionsByTarget.push(
        Object.freeze([...detailsBySourceIndex.get(baseConversion.sourceQuoteIndex)!]),
      );
    }
    scenarioPlans.push(
      deepFreezeDetached({
        conversionsByTarget: Object.freeze(conversionsByTarget),
        appliedInstructionsByTarget: Object.freeze(appliedInstructionsByTarget),
      }),
    );
  }

  return Object.freeze({
    scenarios: Object.freeze(scenarioPlans),
    matchedInstructions,
    transformationWorkUnits,
  });
}

/** Convert one local-currency position value, delegating all orientation arithmetic to FC5. */
export function convertReportingValue(input: {
  readonly amount: number;
  readonly valuationCurrency: string;
  readonly reportingCurrency: string;
  readonly currencyConversion: ScenarioCurrencyConversionUse | null;
}): number {
  if (!Number.isFinite(input.amount)) {
    fxError(
      'positionValue',
      `must be finite before currency conversion; received ${String(input.amount)}.`,
      Number.isNaN(input.amount) ? ErrorCode.InputNaN : ErrorCode.InputNotFinite,
    );
  }
  requireCurrencyCode(FUNCTION_NAME, 'valuationCurrency', input.valuationCurrency);
  requireCurrencyCode(FUNCTION_NAME, 'reportingCurrency', input.reportingCurrency);
  if (input.valuationCurrency === input.reportingCurrency) {
    if (input.currencyConversion !== null) {
      fxError(
        'currencyConversion',
        `must be null for identity conversion in ${input.reportingCurrency}; same-currency values need no quote.`,
      );
    }
    return input.amount;
  }
  if (input.currencyConversion === null) {
    fxError(
      'currencyConversion',
      `is required to convert ${input.valuationCurrency} into ${input.reportingCurrency}.`,
      ErrorCode.InputMissingField,
    );
  }
  if (
    !Number.isSafeInteger(input.currencyConversion.sourceQuoteIndex) ||
    input.currencyConversion.sourceQuoteIndex < 0
  ) {
    fxError(
      'currencyConversion.sourceQuoteIndex',
      `must be a non-negative safe integer; received ${String(input.currencyConversion.sourceQuoteIndex)}.`,
    );
  }
  const result = convertCurrency({
    amount: input.amount,
    fromCurrency: input.valuationCurrency,
    toCurrency: input.reportingCurrency,
    spotRate: input.currencyConversion.quote as CurrencyPairQuote,
  });
  if (result.assumptions.orientation !== input.currencyConversion.orientation) {
    fxError(
      'currencyConversion.orientation',
      `is ${input.currencyConversion.orientation}, but FC5 resolved the supplied quote as ${result.assumptions.orientation}. The conversion plan is internally inconsistent.`,
      ErrorCode.InputOutOfRange,
    );
  }
  return result.convertedAmount;
}

/**
 * Convert base and scenario position values independently, then subtract in reporting currency.
 * This intentionally preserves FX-only P&L; converting local P&L once would erase it.
 */
export function convertScenarioPositionValues(input: {
  readonly basePositionValue: number;
  readonly scenarioPositionValue: number;
  readonly valuationCurrency: string;
  readonly reportingCurrency: string;
  readonly baseCurrencyConversion: ScenarioCurrencyConversionUse | null;
  readonly scenarioCurrencyConversion: ScenarioCurrencyConversionUse | null;
}): Readonly<{
  baseReportingPositionValue: number;
  scenarioReportingPositionValue: number;
  reportingPnl: number;
}> {
  if (input.valuationCurrency !== input.reportingCurrency) {
    if (
      input.baseCurrencyConversion === null ||
      input.scenarioCurrencyConversion === null ||
      input.baseCurrencyConversion.sourceQuoteIndex !==
        input.scenarioCurrencyConversion.sourceQuoteIndex ||
      input.baseCurrencyConversion.orientation !== input.scenarioCurrencyConversion.orientation
    ) {
      fxError(
        'scenarioCurrencyConversion',
        'must preserve the base conversion quote identity and orientation; a scenario may transform quotePerBase but cannot switch quote sources or pair direction.',
      );
    }
  }
  const baseReportingPositionValue = convertReportingValue({
    amount: input.basePositionValue,
    valuationCurrency: input.valuationCurrency,
    reportingCurrency: input.reportingCurrency,
    currencyConversion: input.baseCurrencyConversion,
  });
  const scenarioReportingPositionValue = convertReportingValue({
    amount: input.scenarioPositionValue,
    valuationCurrency: input.valuationCurrency,
    reportingCurrency: input.reportingCurrency,
    currencyConversion: input.scenarioCurrencyConversion,
  });
  const reportingPnl = scenarioReportingPositionValue - baseReportingPositionValue;
  if (!Number.isFinite(reportingPnl)) {
    fxError(
      'reportingPnl',
      'is not representable after subtracting the converted scenario and base position values.',
      ErrorCode.InputNotFinite,
    );
  }
  return Object.freeze({
    baseReportingPositionValue,
    scenarioReportingPositionValue,
    reportingPnl,
  });
}
