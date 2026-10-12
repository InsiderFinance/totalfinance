import {
  CONVENTIONS_VERSION,
  facade,
  type Computed,
  ErrorCode,
  InputError,
  requireRepresentableResult,
  warning,
  WarningCode,
} from '@totalfinance/core';
import {
  type ConvertPriceLevelInput,
  type ReferencePriceLevelInput,
  requirePriceLevelInput,
} from './price-level-input.js';

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
  /** Caller-supplied target price unit; the numeric result uses this unit. */
  resultUnit: string;
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

function calculate(input: ConvertPriceLevelInput): number {
  requirePriceLevelInput(input);
  if (input.sourcePriceLevel === 0) return 0;
  const value =
    input.method === 'reference-prices'
      ? referenceLevel(input)
      : input.sourcePriceLevel * input.targetPricePerSourcePrice;
  requireRepresentableResult('convertPriceLevel', value);
  if (value === 0) {
    throw new InputError(
      'convertPriceLevel: the positive target price level rounds to zero in IEEE-754 double precision. Rescale the price units or reduce the ratio disparity and recompute.',
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: 'convertPriceLevel', field: 'targetPriceLevel' },
      },
    );
  }
  return value;
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
 * `.explain()` echoes the method, coordinates and units and assumes that the proportional
 * mapping remains valid at the requested level. This approximation is not a live quote,
 * predicted ETF open, arbitrage/fair-value result, option premium or notional/delta hedge.
 * The caller supplies comparable references, freshness policy and any instrument presets.
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
    conversion: { ...input },
    resultUnit: input.targetPriceUnit,
    ratioDirection: 'target-price-per-source-price',
    mappingAssumption:
      'The supplied proportional mapping remains valid at the requested price level.',
  },
  diagnostics: {
    method: input.method,
    warnings: [
      warning(
        WarningCode.ModelLimitation,
        'Approximate reference-price mapping only: not a live quote, predicted ETF open, arbitrage/fair-value result, option premium or notional/delta hedge equivalence. The caller owns reference comparability and freshness.',
        'info',
      ),
    ],
  },
}));
