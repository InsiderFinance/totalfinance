import {
  CONVENTIONS_VERSION,
  facade,
  type Computed,
  ErrorCode,
  ensureKnownKeys,
  InputError,
  requireArgumentObject,
  requireFiniteFields,
  requireRepresentableResult,
  warning,
  WarningCode,
} from '@totalfinance/core';
import {
  type ConvertPriceLevelInput,
  type ReferencePriceLevelInput,
  requirePriceLevelInput,
} from './price-level-input.js';
import type {
  EsToSpyLevelInput,
  SpyToEsLevelInput,
  NqToQqqLevelInput,
  QqqToNqLevelInput,
  YmToDiaLevelInput,
  DiaToYmLevelInput,
  RtyToIwmLevelInput,
  IwmToRtyLevelInput,
  SpxToSpyLevelInput,
  SpyToSpxLevelInput,
  NdxToQqqLevelInput,
  QqqToNdxLevelInput,
  RutToIwmLevelInput,
  IwmToRutLevelInput,
  DjiaToDiaLevelInput,
  DiaToDjiaLevelInput,
} from './price-level-named-inputs.js';
export type * from './price-level-named-inputs.js';

export type {
  ConvertPriceLevelInput,
  PriceLevelCoordinates,
  ReferencePriceLevelInput,
  RatioPriceLevelInput,
} from './price-level-input.js';

/** Disclosures on {@link convertPriceLevel}'s `.explain()` companion. */
export type PriceLevelConversionAssumptions = {
  /** Copy of every supplied coordinate, reference or directed ratio, method, and unit label. */
  conversion: ConvertPriceLevelInput;
  /** Caller-supplied target unit label, or null when the caller did not label the result's units. */
  resultUnit: string | null;
  /** Target price units per one source price unit. */
  ratioDirection: 'target-price-per-source-price';
  /** The supplied proportional mapping is assumed valid at the requested price level. */
  mappingAssumption: string;
};

/** Decode a positive finite scalar into a binary significand and exponent without overflow. */
function binaryParts(value: number): { significand: number; exponent: number } {
  // log2(MAX_VALUE) rounds to 1024; clamp before exponentiation. Subnormals reach -1074.
  const exponent = Math.min(1023, Math.floor(Math.log2(value)));
  return { significand: value / 2 ** exponent, exponent };
}

/** Round the exact reference quotient once at the normal/subnormal and overflow boundaries. */
function boundaryReferenceLevel(input: ReferencePriceLevelInput): number {
  // Only extreme outputs allocate this scratch buffer/use BigInt. All three inputs have already
  // been validated as positive finite doubles. Express each exactly in Number.MIN_VALUE units.
  const view = new DataView(new ArrayBuffer(8));
  const units = (value: number): bigint => {
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    const exponent = Number(bits >> 52n);
    const fraction = bits & ((1n << 52n) - 1n);
    return exponent === 0 ? fraction : ((1n << 52n) | fraction) << BigInt(exponent - 1);
  };
  const numerator = units(input.sourcePriceLevel) * units(input.referenceTargetPrice);
  const denominator = units(input.referenceSourcePrice);
  // Their quotient is the result in MIN_VALUE units. Locate its binade with integer comparisons,
  // not a rounded intermediate product/ratio; then retain at most 53 significant binary digits.
  let exponent = numerator.toString(2).length - denominator.toString(2).length;
  if (
    exponent >= 0
      ? numerator < denominator << BigInt(exponent)
      : numerator << BigInt(-exponent) < denominator
  )
    exponent -= 1;
  const shift = Math.max(0, exponent - 52);
  const divisor = denominator << BigInt(shift);
  let significand = numerator / divisor;
  const twiceRemainder = 2n * (numerator % divisor);
  if (twiceRemainder > divisor || (twiceRemainder === divisor && (significand & 1n) === 1n))
    significand += 1n;
  // The integer is exactly representable, including a carry to 2^53. Multiplication by a power
  // of two is exact here unless the correctly rounded answer is Infinity. True underflow is 0.
  return Number(significand) * 2 ** (shift - 1074);
}

/** Scale the three named price coordinates before multiplying/dividing. */
function referenceLevel(input: ReferencePriceLevelInput): number {
  if (input.sourcePriceLevel === input.referenceSourcePrice) return input.referenceTargetPrice;
  if (input.referenceSourcePrice === input.referenceTargetPrice) return input.sourcePriceLevel;
  const source = binaryParts(input.sourcePriceLevel);
  const target = binaryParts(input.referenceTargetPrice);
  const reference = binaryParts(input.referenceSourcePrice);
  let significand = (source.significand * target.significand) / reference.significand;
  let exponent = source.exponent + target.exponent - reference.exponent;
  // log2 can round at powers of two, so normalize the bounded significand rather than its log.
  while (significand >= 2) {
    significand /= 2;
    exponent += 1;
  }
  while (significand < 1) {
    significand *= 2;
    exponent -= 1;
  }
  // A rounded significand can land on the wrong side of a range boundary. Recompute extreme
  // answers from the original doubles, including finite neighbors of MAX_VALUE and subnormals.
  if (exponent <= -1022 || exponent >= 1023) return boundaryReferenceLevel(input);
  return significand * 2 ** exponent;
}

/** Only the two validated facade paths below may call this shared arithmetic implementation. */
function calculateValidated(input: ConvertPriceLevelInput, functionName: string): number {
  if (input.sourcePriceLevel === 0) return 0;
  const value =
    input.method === 'reference-prices'
      ? referenceLevel(input)
      : input.sourcePriceLevel * input.targetPricePerSourcePrice;
  requireRepresentableResult(functionName, value);
  if (value === 0) {
    throw new InputError(
      `${functionName}: the positive target price level rounds to zero in IEEE-754 double precision. Rescale the price units or reduce the ratio disparity and recompute.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'targetPriceLevel' },
      },
    );
  }
  return value;
}

function calculate(input: ConvertPriceLevelInput): number {
  requirePriceLevelInput(input);
  return calculateValidated(input, 'convertPriceLevel');
}

function assumptions(input: ConvertPriceLevelInput): PriceLevelConversionAssumptions {
  const conversion = { ...input };
  // Optional metadata must not leave undefined properties in an otherwise JSON-safe explanation.
  if (conversion.sourcePriceUnit === undefined) delete conversion.sourcePriceUnit;
  if (conversion.targetPriceUnit === undefined) delete conversion.targetPriceUnit;
  return {
    conversion,
    resultUnit: input.targetPriceUnit ?? null,
    ratioDirection: 'target-price-per-source-price',
    mappingAssumption:
      'The supplied proportional mapping remains valid at the requested price level.',
  };
}

function diagnostics(method: ConvertPriceLevelInput['method']) {
  return {
    method,
    warnings: [
      warning(
        WarningCode.ModelLimitation,
        'Approximate reference-price mapping only: not a live quote, predicted ETF open, arbitrage/fair-value result, option premium or notional/delta hedge equivalence. The caller owns reference comparability and freshness.',
        'info',
      ),
    ],
  };
}

/**
 * Map a source price level to an approximate target level in the supplied target price unit.
 *
 * Reference mode: `sourcePriceLevel * referenceTargetPrice / referenceSourcePrice`.
 * Ratio mode: `sourcePriceLevel * targetPricePerSourcePrice` (target units per source unit).
 * To invert, swap source/target references and unit labels, or supply the reciprocal ratio.
 * Inputs are closed and validated on both calls; prices/ratios must be finite and positive,
 * except the requested level may be zero. No cents/tick rounding or instrument inference occurs.
 * Overflow and positive underflow to zero throw typed `input.out_of_range` errors.
 *
 * Unit labels are optional descriptive metadata, not financial defaults or conversion factors.
 * `.explain()` echoes supplied metadata; resultUnit is null when targetPriceUnit is omitted.
 * It assumes that the proportional
 * mapping remains valid at the requested level. This approximation is not a live quote,
 * predicted ETF open, arbitrage/fair-value result, option premium or notional/delta hedge.
 * The caller supplies comparable references and freshness policy. For named pairs, start with
 * helpers such as `esToSpyLevel` or `nqToQqqLevel`; they need only three named prices.
 *
 * @example
 * ```ts
 * import { convertPriceLevel } from '@insiderfinance/totalfinance/valuation/price-levels';
 * const estimatedSpy = convertPriceLevel({
 *   method: 'reference-prices', sourcePriceLevel: 6030,
 *   referenceSourcePrice: 6000, referenceTargetPrice: 596,
 *   sourcePriceUnit: 'ES index points', targetPriceUnit: 'USD per SPY share',
 * }); // approximately 598.98
 * ```
 */
export const convertPriceLevel: {
  (input: ConvertPriceLevelInput): number;
  /** Same closed input and arithmetic; echoes the method, units, references/ratio and limitations. */
  explain: (input: ConvertPriceLevelInput) => Computed<number, PriceLevelConversionAssumptions>;
} = /* @__PURE__ */ facade('convertPriceLevel', calculate, (input) => ({
  value: calculate(input),
  assumptions: {
    conventionsVersion: CONVENTIONS_VERSION,
    ...assumptions(input),
  },
  diagnostics: diagnostics(input.method),
}));

/** Named coordinates plus the explicit reference-price mapping supplied by a pair helper. */
export type NamedPriceLevelConversionAssumptions<Input> = {
  /** A copy of the three named coordinates exactly as supplied to the helper. */
  input: Input;
  /** The canonical mapping, with descriptive instrument labels; never a fixed market ratio. */
  conversion: ReferencePriceLevelInput & { sourcePriceUnit: string; targetPriceUnit: string };
  /** Known descriptive output unit fixed by the helper's name. */
  resultUnit: string;
  /** Target price units per one source price unit. */
  ratioDirection: 'target-price-per-source-price';
  /** The supplied proportional mapping is assumed valid at the requested level. */
  mappingAssumption: string;
};

/** Private, side-effect-free construction keeps unused named helpers tree-shakeable. */
function namedPriceLevel<Input extends object>(config: {
  functionName: string;
  levelField: keyof Input & string;
  sourceReferenceField: keyof Input & string;
  targetReferenceField: keyof Input & string;
  sourcePriceUnit: string;
  targetPriceUnit: string;
  example: string;
}) {
  const { functionName, levelField, sourceReferenceField, targetReferenceField } = config;
  const fields = [levelField, sourceReferenceField, targetReferenceField];
  function coordinates(input: Input): ReferencePriceLevelInput & {
    sourcePriceUnit: string;
    targetPriceUnit: string;
  } {
    requireArgumentObject(functionName, 'input', input);
    ensureKnownKeys(functionName, 'input', input, fields);
    requireFiniteFields(functionName, input, fields, { exampleCall: config.example });
    const values = input as Record<string, number>;
    for (const field of fields) {
      const value = values[field]!;
      if (field === levelField ? value < 0 : value <= 0) {
        throw new InputError(
          `${functionName}: ${field} must be ${field === levelField ? '>= 0' : '> 0'} in its instrument's price units.\n  e.g. ${config.example}`,
          { code: ErrorCode.InputOutOfRange, context: { function: functionName, field, value } },
        );
      }
    }
    return {
      method: 'reference-prices',
      sourcePriceLevel: values[levelField]!,
      referenceSourcePrice: values[sourceReferenceField]!,
      referenceTargetPrice: values[targetReferenceField]!,
      sourcePriceUnit: config.sourcePriceUnit,
      targetPriceUnit: config.targetPriceUnit,
    };
  }
  return facade(
    functionName,
    (input: Input) => calculateValidated(coordinates(input), functionName),
    (input: Input): Computed<number, NamedPriceLevelConversionAssumptions<Input>> => {
      const conversion = coordinates(input);
      return {
        value: calculateValidated(conversion, functionName),
        assumptions: {
          conventionsVersion: CONVENTIONS_VERSION,
          ...assumptions(conversion),
          input: { ...input },
          conversion,
          resultUnit: conversion.targetPriceUnit,
        },
        diagnostics: diagnostics('reference-prices'),
      };
    },
  );
}

/**
 * Approximate SPY level corresponding to the supplied ES level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * esToSpyLevel({ esPriceLevel: 6030, referenceEsPrice: 6000, referenceSpyPrice: 596 }); // ≈ 598.98
 */
export const esToSpyLevel: {
  (input: EsToSpyLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: EsToSpyLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<EsToSpyLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<EsToSpyLevelInput>({
  functionName: 'esToSpyLevel',
  levelField: 'esPriceLevel',
  sourceReferenceField: 'referenceEsPrice',
  targetReferenceField: 'referenceSpyPrice',
  sourcePriceUnit: 'ES index points',
  targetPriceUnit: 'USD per SPY share',
  example: 'esToSpyLevel({ esPriceLevel: 6030, referenceEsPrice: 6000, referenceSpyPrice: 596 })',
});

/**
 * Approximate ES level corresponding to the supplied SPY level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * spyToEsLevel({ spyPriceLevel: 598.98, referenceSpyPrice: 596, referenceEsPrice: 6000 }); // ≈ 6030
 */
export const spyToEsLevel: {
  (input: SpyToEsLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: SpyToEsLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<SpyToEsLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<SpyToEsLevelInput>({
  functionName: 'spyToEsLevel',
  levelField: 'spyPriceLevel',
  sourceReferenceField: 'referenceSpyPrice',
  targetReferenceField: 'referenceEsPrice',
  sourcePriceUnit: 'USD per SPY share',
  targetPriceUnit: 'ES index points',
  example:
    'spyToEsLevel({ spyPriceLevel: 598.98, referenceSpyPrice: 596, referenceEsPrice: 6000 })',
});

/**
 * Approximate QQQ level corresponding to the supplied NQ level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * nqToQqqLevel({ nqPriceLevel: 20250, referenceNqPrice: 20000, referenceQqqPrice: 500 }); // ≈ 506.25
 */
export const nqToQqqLevel: {
  (input: NqToQqqLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: NqToQqqLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<NqToQqqLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<NqToQqqLevelInput>({
  functionName: 'nqToQqqLevel',
  levelField: 'nqPriceLevel',
  sourceReferenceField: 'referenceNqPrice',
  targetReferenceField: 'referenceQqqPrice',
  sourcePriceUnit: 'NQ index points',
  targetPriceUnit: 'USD per QQQ share',
  example: 'nqToQqqLevel({ nqPriceLevel: 20250, referenceNqPrice: 20000, referenceQqqPrice: 500 })',
});

/**
 * Approximate NQ level corresponding to the supplied QQQ level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * qqqToNqLevel({ qqqPriceLevel: 506.25, referenceQqqPrice: 500, referenceNqPrice: 20000 }); // ≈ 20250
 */
export const qqqToNqLevel: {
  (input: QqqToNqLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: QqqToNqLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<QqqToNqLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<QqqToNqLevelInput>({
  functionName: 'qqqToNqLevel',
  levelField: 'qqqPriceLevel',
  sourceReferenceField: 'referenceQqqPrice',
  targetReferenceField: 'referenceNqPrice',
  sourcePriceUnit: 'USD per QQQ share',
  targetPriceUnit: 'NQ index points',
  example:
    'qqqToNqLevel({ qqqPriceLevel: 506.25, referenceQqqPrice: 500, referenceNqPrice: 20000 })',
});

/**
 * Approximate DIA level corresponding to the supplied YM level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * ymToDiaLevel({ ymPriceLevel: 40400, referenceYmPrice: 40000, referenceDiaPrice: 398 }); // ≈ 401.98
 */
export const ymToDiaLevel: {
  (input: YmToDiaLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: YmToDiaLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<YmToDiaLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<YmToDiaLevelInput>({
  functionName: 'ymToDiaLevel',
  levelField: 'ymPriceLevel',
  sourceReferenceField: 'referenceYmPrice',
  targetReferenceField: 'referenceDiaPrice',
  sourcePriceUnit: 'YM index points',
  targetPriceUnit: 'USD per DIA share',
  example: 'ymToDiaLevel({ ymPriceLevel: 40400, referenceYmPrice: 40000, referenceDiaPrice: 398 })',
});

/**
 * Approximate YM level corresponding to the supplied DIA level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * diaToYmLevel({ diaPriceLevel: 401.98, referenceDiaPrice: 398, referenceYmPrice: 40000 }); // ≈ 40400
 */
export const diaToYmLevel: {
  (input: DiaToYmLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: DiaToYmLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<DiaToYmLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<DiaToYmLevelInput>({
  functionName: 'diaToYmLevel',
  levelField: 'diaPriceLevel',
  sourceReferenceField: 'referenceDiaPrice',
  targetReferenceField: 'referenceYmPrice',
  sourcePriceUnit: 'USD per DIA share',
  targetPriceUnit: 'YM index points',
  example:
    'diaToYmLevel({ diaPriceLevel: 401.98, referenceDiaPrice: 398, referenceYmPrice: 40000 })',
});

/**
 * Approximate IWM level corresponding to the supplied RTY level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * rtyToIwmLevel({ rtyPriceLevel: 2020, referenceRtyPrice: 2000, referenceIwmPrice: 198 }); // ≈ 199.98
 */
export const rtyToIwmLevel: {
  (input: RtyToIwmLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: RtyToIwmLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<RtyToIwmLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<RtyToIwmLevelInput>({
  functionName: 'rtyToIwmLevel',
  levelField: 'rtyPriceLevel',
  sourceReferenceField: 'referenceRtyPrice',
  targetReferenceField: 'referenceIwmPrice',
  sourcePriceUnit: 'RTY index points',
  targetPriceUnit: 'USD per IWM share',
  example:
    'rtyToIwmLevel({ rtyPriceLevel: 2020, referenceRtyPrice: 2000, referenceIwmPrice: 198 })',
});

/**
 * Approximate RTY level corresponding to the supplied IWM level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * iwmToRtyLevel({ iwmPriceLevel: 199.98, referenceIwmPrice: 198, referenceRtyPrice: 2000 }); // ≈ 2020
 */
export const iwmToRtyLevel: {
  (input: IwmToRtyLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: IwmToRtyLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<IwmToRtyLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<IwmToRtyLevelInput>({
  functionName: 'iwmToRtyLevel',
  levelField: 'iwmPriceLevel',
  sourceReferenceField: 'referenceIwmPrice',
  targetReferenceField: 'referenceRtyPrice',
  sourcePriceUnit: 'USD per IWM share',
  targetPriceUnit: 'RTY index points',
  example:
    'iwmToRtyLevel({ iwmPriceLevel: 199.98, referenceIwmPrice: 198, referenceRtyPrice: 2000 })',
});

/**
 * Approximate SPY level corresponding to the supplied SPX level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * spxToSpyLevel({ spxPriceLevel: 6030, referenceSpxPrice: 6000, referenceSpyPrice: 596 }); // ≈ 598.98
 */
export const spxToSpyLevel: {
  (input: SpxToSpyLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: SpxToSpyLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<SpxToSpyLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<SpxToSpyLevelInput>({
  functionName: 'spxToSpyLevel',
  levelField: 'spxPriceLevel',
  sourceReferenceField: 'referenceSpxPrice',
  targetReferenceField: 'referenceSpyPrice',
  sourcePriceUnit: 'SPX index points',
  targetPriceUnit: 'USD per SPY share',
  example:
    'spxToSpyLevel({ spxPriceLevel: 6030, referenceSpxPrice: 6000, referenceSpyPrice: 596 })',
});

/**
 * Approximate SPX level corresponding to the supplied SPY level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * spyToSpxLevel({ spyPriceLevel: 598.98, referenceSpyPrice: 596, referenceSpxPrice: 6000 }); // ≈ 6030
 */
export const spyToSpxLevel: {
  (input: SpyToSpxLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: SpyToSpxLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<SpyToSpxLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<SpyToSpxLevelInput>({
  functionName: 'spyToSpxLevel',
  levelField: 'spyPriceLevel',
  sourceReferenceField: 'referenceSpyPrice',
  targetReferenceField: 'referenceSpxPrice',
  sourcePriceUnit: 'USD per SPY share',
  targetPriceUnit: 'SPX index points',
  example:
    'spyToSpxLevel({ spyPriceLevel: 598.98, referenceSpyPrice: 596, referenceSpxPrice: 6000 })',
});

/**
 * Approximate QQQ level corresponding to the supplied NDX level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * ndxToQqqLevel({ ndxPriceLevel: 20250, referenceNdxPrice: 20000, referenceQqqPrice: 500 }); // ≈ 506.25
 */
export const ndxToQqqLevel: {
  (input: NdxToQqqLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: NdxToQqqLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<NdxToQqqLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<NdxToQqqLevelInput>({
  functionName: 'ndxToQqqLevel',
  levelField: 'ndxPriceLevel',
  sourceReferenceField: 'referenceNdxPrice',
  targetReferenceField: 'referenceQqqPrice',
  sourcePriceUnit: 'NDX index points',
  targetPriceUnit: 'USD per QQQ share',
  example:
    'ndxToQqqLevel({ ndxPriceLevel: 20250, referenceNdxPrice: 20000, referenceQqqPrice: 500 })',
});

/**
 * Approximate NDX level corresponding to the supplied QQQ level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * qqqToNdxLevel({ qqqPriceLevel: 506.25, referenceQqqPrice: 500, referenceNdxPrice: 20000 }); // ≈ 20250
 */
export const qqqToNdxLevel: {
  (input: QqqToNdxLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: QqqToNdxLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<QqqToNdxLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<QqqToNdxLevelInput>({
  functionName: 'qqqToNdxLevel',
  levelField: 'qqqPriceLevel',
  sourceReferenceField: 'referenceQqqPrice',
  targetReferenceField: 'referenceNdxPrice',
  sourcePriceUnit: 'USD per QQQ share',
  targetPriceUnit: 'NDX index points',
  example:
    'qqqToNdxLevel({ qqqPriceLevel: 506.25, referenceQqqPrice: 500, referenceNdxPrice: 20000 })',
});

/**
 * Approximate IWM level corresponding to the supplied RUT level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * rutToIwmLevel({ rutPriceLevel: 2020, referenceRutPrice: 2000, referenceIwmPrice: 198 }); // ≈ 199.98
 */
export const rutToIwmLevel: {
  (input: RutToIwmLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: RutToIwmLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<RutToIwmLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<RutToIwmLevelInput>({
  functionName: 'rutToIwmLevel',
  levelField: 'rutPriceLevel',
  sourceReferenceField: 'referenceRutPrice',
  targetReferenceField: 'referenceIwmPrice',
  sourcePriceUnit: 'RUT index points',
  targetPriceUnit: 'USD per IWM share',
  example:
    'rutToIwmLevel({ rutPriceLevel: 2020, referenceRutPrice: 2000, referenceIwmPrice: 198 })',
});

/**
 * Approximate RUT level corresponding to the supplied IWM level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * iwmToRutLevel({ iwmPriceLevel: 199.98, referenceIwmPrice: 198, referenceRutPrice: 2000 }); // ≈ 2020
 */
export const iwmToRutLevel: {
  (input: IwmToRutLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: IwmToRutLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<IwmToRutLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<IwmToRutLevelInput>({
  functionName: 'iwmToRutLevel',
  levelField: 'iwmPriceLevel',
  sourceReferenceField: 'referenceIwmPrice',
  targetReferenceField: 'referenceRutPrice',
  sourcePriceUnit: 'USD per IWM share',
  targetPriceUnit: 'RUT index points',
  example:
    'iwmToRutLevel({ iwmPriceLevel: 199.98, referenceIwmPrice: 198, referenceRutPrice: 2000 })',
});

/**
 * Approximate DIA level corresponding to the supplied DJIA level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * djiaToDiaLevel({ djiaPriceLevel: 40400, referenceDjiaPrice: 40000, referenceDiaPrice: 398 }); // ≈ 401.98
 */
export const djiaToDiaLevel: {
  (input: DjiaToDiaLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: DjiaToDiaLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<DjiaToDiaLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<DjiaToDiaLevelInput>({
  functionName: 'djiaToDiaLevel',
  levelField: 'djiaPriceLevel',
  sourceReferenceField: 'referenceDjiaPrice',
  targetReferenceField: 'referenceDiaPrice',
  sourcePriceUnit: 'DJIA index points (full Dow Jones Industrial Average)',
  targetPriceUnit: 'USD per DIA share',
  example:
    'djiaToDiaLevel({ djiaPriceLevel: 40400, referenceDjiaPrice: 40000, referenceDiaPrice: 398 })',
});

/**
 * Approximate DJIA level corresponding to the supplied DIA level and reference prices.
 * Assumes the proportional mapping holds; not a quote, forecast, fair value or hedge ratio.
 * No fixed ratio, contract multiplier or tick rounding. Caller owns reference comparability.
 * @example
 * diaToDjiaLevel({ diaPriceLevel: 401.98, referenceDiaPrice: 398, referenceDjiaPrice: 40000 }); // ≈ 40400
 */
export const diaToDjiaLevel: {
  (input: DiaToDjiaLevelInput): number;
  /** Same calculation with original coordinates, named units and mapping limitations. */
  explain: (
    input: DiaToDjiaLevelInput,
  ) => Computed<number, NamedPriceLevelConversionAssumptions<DiaToDjiaLevelInput>>;
} = /* @__PURE__ */ namedPriceLevel<DiaToDjiaLevelInput>({
  functionName: 'diaToDjiaLevel',
  levelField: 'diaPriceLevel',
  sourceReferenceField: 'referenceDiaPrice',
  targetReferenceField: 'referenceDjiaPrice',
  sourcePriceUnit: 'USD per DIA share',
  targetPriceUnit: 'DJIA index points (full Dow Jones Industrial Average)',
  example:
    'diaToDjiaLevel({ diaPriceLevel: 401.98, referenceDiaPrice: 398, referenceDjiaPrice: 40000 })',
});
