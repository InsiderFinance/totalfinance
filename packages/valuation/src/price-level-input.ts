import {
  ensureKnownKeys,
  ErrorCode,
  InputError,
  missingFieldError,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';

/** Coordinates shared by both methods of {@link convertPriceLevel}. */
export interface PriceLevelCoordinates {
  /** Finite nonnegative level in `sourcePriceUnit`; zero maps to zero. */
  sourcePriceLevel: number;
  /** Nonblank caller-supplied unit label, e.g. 'ES index points'. No instrument inference. */
  sourcePriceUnit: string;
  /** Nonblank caller-supplied unit label, e.g. 'USD per SPY share'; also the result unit. */
  targetPriceUnit: string;
}

/** Proportional mapping from a pair of caller-supplied reference prices. */
export interface ReferencePriceLevelInput extends PriceLevelCoordinates {
  /** Use `sourcePriceLevel * referenceTargetPrice / referenceSourcePrice`. */
  method: 'reference-prices';
  /** Finite price > 0 in `sourcePriceUnit`; the reference denominator. */
  referenceSourcePrice: number;
  /** Finite price > 0 in `targetPriceUnit`; caller owns comparability and freshness. */
  referenceTargetPrice: number;
}

/** Proportional mapping from an explicit directed ratio. */
export interface RatioPriceLevelInput extends PriceLevelCoordinates {
  /** Use `sourcePriceLevel * targetPricePerSourcePrice`. */
  method: 'ratio';
  /** Finite ratio > 0: target price units per ONE source price unit, never the reciprocal. */
  targetPricePerSourcePrice: number;
}

/** Select exactly one method; ratio and reference fields cannot be mixed at runtime. */
export type ConvertPriceLevelInput = ReferencePriceLevelInput | RatioPriceLevelInput;

const REFERENCE_EXAMPLE =
  "convertPriceLevel({ method: 'reference-prices', sourcePriceLevel: 6030, referenceSourcePrice: 6000, referenceTargetPrice: 596, sourcePriceUnit: 'ES index points', targetPriceUnit: 'USD per SPY share' })";
const RATIO_EXAMPLE =
  "convertPriceLevel({ method: 'ratio', sourcePriceLevel: 20250, targetPricePerSourcePrice: 0.025, sourcePriceUnit: 'NQ index points', targetPriceUnit: 'USD per QQQ share' })";
const COMMON_KEYS = ['method', 'sourcePriceLevel', 'sourcePriceUnit', 'targetPriceUnit'];

/** Shared private boundary law for both facade calls. */
export function requirePriceLevelInput(input: ConvertPriceLevelInput): void {
  const functionName = 'convertPriceLevel';
  requireArgumentObject(functionName, 'input', input);
  if (input.method === undefined)
    throw missingFieldError(functionName, 'method', REFERENCE_EXAMPLE);
  if (typeof input.method !== 'string') {
    throw new InputError(
      `${functionName}: method must be a string selecting 'reference-prices' or 'ratio'.\n  e.g. ${REFERENCE_EXAMPLE}`,
      {
        code: ErrorCode.InputWrongType,
        context: { function: functionName, field: 'method' },
      },
    );
  }
  if (input.method !== 'reference-prices' && input.method !== 'ratio') {
    throw new InputError(
      `${functionName}: method must be 'reference-prices' or 'ratio'; select one explicitly.\n  e.g. ${REFERENCE_EXAMPLE}`,
      { code: ErrorCode.InputInvalidEnum, context: { function: functionName, field: 'method' } },
    );
  }
  const example = input.method === 'ratio' ? RATIO_EXAMPLE : REFERENCE_EXAMPLE;
  const numericFields =
    input.method === 'reference-prices'
      ? ['sourcePriceLevel', 'referenceSourcePrice', 'referenceTargetPrice']
      : ['sourcePriceLevel', 'targetPricePerSourcePrice'];
  ensureKnownKeys(functionName, 'input', input, [...COMMON_KEYS, ...numericFields.slice(1)]);
  requireFiniteFields(functionName, input, numericFields, { exampleCall: example });
  const record = input as unknown as Record<string, unknown>;
  for (const field of numericFields) {
    const value = record[field] as number;
    if (field === 'sourcePriceLevel' ? value < 0 : value <= 0) {
      throw new InputError(
        `${functionName}: ${field} must be ${field === 'sourcePriceLevel' ? '>= 0 in source price units' : '> 0 in the declared price units or target-per-source ratio units'}.\n  e.g. ${example}`,
        { code: ErrorCode.InputOutOfRange, context: { function: functionName, field, value } },
      );
    }
  }
  for (const field of ['sourcePriceUnit', 'targetPriceUnit'] as const) {
    const value = input[field];
    if (value === undefined) throw missingFieldError(functionName, field, example);
    if (typeof value !== 'string') {
      throw new InputError(
        `${functionName}: ${field} must be a nonblank unit-label string.\n  e.g. ${example}`,
        {
          code: ErrorCode.InputWrongType,
          context: { function: functionName, field },
        },
      );
    }
    if (value.trim().length === 0) {
      throw new InputError(
        `${functionName}: ${field} must name the price unit.\n  e.g. ${example}`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { function: functionName, field },
        },
      );
    }
  }
}
