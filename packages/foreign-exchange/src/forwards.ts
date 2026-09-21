/**
 * FC5 — foreign-exchange forwards: covered interest parity, forward points, forward and swap
 * valuation, and non-deliverable forwards. Rate roles are FIXED and echoed: the DOMESTIC rate
 * belongs to the QUOTE currency (the currency the price is expressed in) and the FOREIGN rate to
 * the BASE currency. Valuation accepts an explicit quote-currency discount factor — never a rate —
 * so day-count and compounding conventions cannot mismatch silently (the matched-conventions law).
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  type InterestCompounding,
  compoundFactor,
  ensureEnum,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import { requireFiniteComputation } from './internal.js';
import {
  type CurrencyPairQuote,
  type ForeignExchangeDiagnostics,
  requireCurrencyCode,
  requireCurrencyPairQuote,
} from './spot.js';

// ---------------------------------------------------------------------------------------------------
// Shared boundary helpers
// ---------------------------------------------------------------------------------------------------

/**
 * The seven-form compounding ladder, taught at this package's boundary. Core owns the
 * {@link InterestCompounding} vocabulary and the factor arithmetic but exports no validator, and
 * the FC0 dependency graph forbids the `@totalfinance/valuation` edge that carries one — so the ladder
 * is restated here rather than imported.
 */
function requireCompoundingWhenPresent(
  functionName: string,
  compounding: unknown,
): asserts compounding is InterestCompounding | undefined {
  if (compounding === undefined) return;
  if (
    compounding === 'simple' ||
    compounding === 'continuous' ||
    compounding === 'annual' ||
    compounding === 'semiannual' ||
    compounding === 'quarterly' ||
    compounding === 'monthly'
  )
    return;
  if (
    typeof compounding === 'object' &&
    compounding !== null &&
    (compounding as { type?: unknown }).type === 'periodic'
  ) {
    const periods = (compounding as { periodsPerYear?: unknown }).periodsPerYear;
    if (typeof periods === 'number' && Number.isFinite(periods) && periods > 0) return;
    throw new InputError(
      `${functionName}: compounding.periodsPerYear must be a finite number > 0. Received ${String(periods)}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { function: functionName, field: 'compounding' },
      },
    );
  }
  throw new InputError(
    `${functionName}: compounding must be 'simple' | 'continuous' | 'annual' | 'semiannual' | 'quarterly' | 'monthly' or { type: 'periodic', periodsPerYear } when provided. Received ${compounding === null ? 'null' : JSON.stringify(compounding)}.`,
    { code: ErrorCode.InputInvalidEnum, context: { function: functionName, field: 'compounding' } },
  );
}

/** Both quotes must name the SAME pair in the SAME direction, else a teaching error. */
function requireSamePair(
  functionName: string,
  firstLabel: string,
  firstQuote: CurrencyPairQuote,
  secondLabel: string,
  secondQuote: CurrencyPairQuote,
): void {
  if (
    firstQuote.baseCurrency !== secondQuote.baseCurrency ||
    firstQuote.quoteCurrency !== secondQuote.quoteCurrency
  ) {
    throw new InputError(
      `${functionName}: ${firstLabel} (${firstQuote.baseCurrency}/${firstQuote.quoteCurrency}) and ${secondLabel} (${secondQuote.baseCurrency}/${secondQuote.quoteCurrency}) must quote the SAME currency pair in the SAME direction. Use invertCurrencyPairQuote to flip one explicitly first.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          [firstLabel]: `${firstQuote.baseCurrency}/${firstQuote.quoteCurrency}`,
          [secondLabel]: `${secondQuote.baseCurrency}/${secondQuote.quoteCurrency}`,
        },
      },
    );
  }
}

const PERSPECTIVES = ['buyer-of-base', 'seller-of-base'] as const;

/** The forward-value sign convention prose, shared by every valuation result below. */
const SIGN_CONVENTION =
  'buyer-of-base gains when the settlement-relevant rate exceeds the contracted rate: value = ±(rate − contractRate.quotePerBase) × notionalBaseAmount × discountFactorToSettlement, positive sign for buyer-of-base, negative for seller-of-base, in the quote currency';

/** Validate the shared notional/discount-factor block and return the warning list it seeds. */
function requireValuationAmounts(
  functionName: string,
  input: { notionalBaseAmount: number; discountFactorToSettlement: number },
  exampleCall: string,
): string[] {
  requireFiniteFields(functionName, input, ['notionalBaseAmount', 'discountFactorToSettlement'], {
    exampleCall,
    hints: {
      discountFactorToSettlement:
        'an explicit QUOTE-currency discount factor to the settlement date — a factor, not a rate, so conventions cannot mismatch silently',
    },
  });
  if (input.notionalBaseAmount <= 0) {
    throw new InputError(
      `${functionName}: notionalBaseAmount must be > 0 — direction is carried by perspective ('buyer-of-base' | 'seller-of-base'), never by a signed notional. Received ${input.notionalBaseAmount}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'notionalBaseAmount',
          value: input.notionalBaseAmount,
        },
      },
    );
  }
  if (input.discountFactorToSettlement <= 0) {
    throw new InputError(
      `${functionName}: discountFactorToSettlement must be > 0 (a discount factor, e.g. 0.97). Received ${input.discountFactorToSettlement}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: functionName,
          field: 'discountFactorToSettlement',
          value: input.discountFactorToSettlement,
        },
      },
    );
  }
  const warnings: string[] = [];
  if (input.discountFactorToSettlement > 1) {
    warnings.push(
      `discountFactorToSettlement ${input.discountFactorToSettlement} exceeds 1 — consistent only with a negative quote-currency rate to settlement; verify the factor.`,
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------------------------------
// Covered interest parity
// ---------------------------------------------------------------------------------------------------

/** Input for {@link coveredInterestParityForward}. */
export interface CoveredInterestParityForwardInput {
  spotRate: CurrencyPairQuote;
  /** Annual rate (decimal) of the QUOTE currency — the 'domestic' leg (USD in EUR/USD). */
  domesticAnnualRate: number;
  /** Annual rate (decimal) of the BASE currency — the 'foreign' leg (EUR in EUR/USD). */
  foreignAnnualRate: number;
  timeYears: number;
  /** Default `'annual'` — the FC1 ordinary-flow convention, echoed in the assumptions. */
  compounding?: InterestCompounding;
}

/** Result of {@link coveredInterestParityForward}. */
export interface CoveredInterestParityForwardResult {
  /** The parity forward for the SAME pair as the spot quote. */
  forwardRate: CurrencyPairQuote;
  assumptions: {
    rateRoles: 'domestic = quote currency, foreign = base currency';
    compounding: InterestCompounding;
    timeYears: number;
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const COVERED_INTEREST_PARITY_KEYS = [
  'spotRate',
  'domesticAnnualRate',
  'foreignAnnualRate',
  'timeYears',
  'compounding',
] as const;

const COVERED_INTEREST_PARITY_EXAMPLE =
  "coveredInterestParityForward({ spotRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 }, domesticAnnualRate: 0.05, foreignAnnualRate: 0.03, timeYears: 0.75, compounding: 'continuous' })";

/**
 * The no-arbitrage forward: `forward = spot × growthFactor(domestic) / growthFactor(foreign)`. The
 * DOMESTIC rate is the QUOTE currency's rate and the FOREIGN rate is the BASE currency's rate —
 * investing the converted amount at the domestic rate must equal investing one base unit at the
 * foreign rate and converting at this forward (the covered-interest-parity round trip, tested at
 * 1e-12). Under continuous compounding this is exactly `spot × e^((domestic − foreign) × t)`.
 */
export function coveredInterestParityForward(
  input: CoveredInterestParityForwardInput,
): CoveredInterestParityForwardResult {
  requireArgumentObject('coveredInterestParityForward', 'input', input);
  ensureKnownKeys('coveredInterestParityForward', 'input', input, COVERED_INTEREST_PARITY_KEYS);
  requireCurrencyPairQuote('coveredInterestParityForward', 'spotRate', input.spotRate);
  requireFiniteFields(
    'coveredInterestParityForward',
    input,
    ['domesticAnnualRate', 'foreignAnnualRate', 'timeYears'],
    {
      exampleCall: COVERED_INTEREST_PARITY_EXAMPLE,
      hints: {
        domesticAnnualRate: "the QUOTE currency's annual rate (decimal) — USD in EUR/USD",
        foreignAnnualRate: "the BASE currency's annual rate (decimal) — EUR in EUR/USD",
      },
    },
  );
  if (input.timeYears < 0) {
    throw new InputError(
      `coveredInterestParityForward: timeYears must be >= 0. Received ${input.timeYears}.`,
      {
        code: ErrorCode.InputNegativeTime,
        context: {
          function: 'coveredInterestParityForward',
          field: 'timeYears',
          value: input.timeYears,
        },
      },
    );
  }
  requireCompoundingWhenPresent('coveredInterestParityForward', input.compounding);
  const compounding: InterestCompounding =
    input.compounding === undefined ? 'annual' : input.compounding;
  const quotePerBase =
    (input.spotRate.quotePerBase *
      compoundFactor(input.domesticAnnualRate, input.timeYears, compounding)) /
    compoundFactor(input.foreignAnnualRate, input.timeYears, compounding);
  return requireFiniteComputation('coveredInterestParityForward', {
    forwardRate: {
      baseCurrency: input.spotRate.baseCurrency,
      quoteCurrency: input.spotRate.quoteCurrency,
      quotePerBase,
    },
    assumptions: {
      rateRoles: 'domestic = quote currency, foreign = base currency',
      compounding,
      timeYears: input.timeYears,
    },
    diagnostics: { warnings: [] },
  });
}

// ---------------------------------------------------------------------------------------------------
// Forward points
// ---------------------------------------------------------------------------------------------------

/** Input for {@link foreignExchangeForwardPoints}. */
export interface ForeignExchangeForwardPointsInput {
  spotRate: CurrencyPairQuote;
  /** The forward for the SAME pair in the SAME direction. */
  forwardRate: CurrencyPairQuote;
  /** The size of one point in quotePerBase units (e.g. `0.0001` for EUR/USD). REQUIRED — never guessed. */
  pointSize: number;
}

/** Result of {@link foreignExchangeForwardPoints}. */
export interface ForeignExchangeForwardPointsResult {
  forwardPoints: number;
  assumptions: {
    pointSize: number;
    pointSizeSource: 'explicit';
    formula: 'forwardPoints = (forwardRate.quotePerBase − spotRate.quotePerBase) / pointSize';
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const FORWARD_POINTS_KEYS = ['spotRate', 'forwardRate', 'pointSize'] as const;

const FORWARD_POINTS_EXAMPLE =
  "foreignExchangeForwardPoints({ spotRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 }, forwardRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.0952 }, pointSize: 0.0001 })";

/**
 * Forward points: `(forward − spot) / pointSize`. Positive when the base currency trades at a
 * forward premium. `pointSize` is always explicit — a symbol's spelling never decides it.
 */
export function foreignExchangeForwardPoints(
  input: ForeignExchangeForwardPointsInput,
): ForeignExchangeForwardPointsResult {
  requireArgumentObject('foreignExchangeForwardPoints', 'input', input);
  ensureKnownKeys('foreignExchangeForwardPoints', 'input', input, FORWARD_POINTS_KEYS);
  requireCurrencyPairQuote('foreignExchangeForwardPoints', 'spotRate', input.spotRate);
  requireCurrencyPairQuote('foreignExchangeForwardPoints', 'forwardRate', input.forwardRate);
  requireSamePair(
    'foreignExchangeForwardPoints',
    'spotRate',
    input.spotRate,
    'forwardRate',
    input.forwardRate,
  );
  requireFiniteFields('foreignExchangeForwardPoints', input, ['pointSize'], {
    exampleCall: FORWARD_POINTS_EXAMPLE,
    hints: {
      pointSize:
        'quotePerBase units per point — e.g. 0.0001 for EUR/USD; never guessed from symbol spelling',
    },
  });
  if (input.pointSize <= 0) {
    throw new InputError(
      `foreignExchangeForwardPoints: pointSize must be > 0 (quotePerBase units per point — e.g. 0.0001 for EUR/USD). Received ${input.pointSize}.`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'foreignExchangeForwardPoints',
          field: 'pointSize',
          value: input.pointSize,
        },
      },
    );
  }
  return requireRepresentableResult('foreignExchangeForwardPoints', {
    forwardPoints: (input.forwardRate.quotePerBase - input.spotRate.quotePerBase) / input.pointSize,
    assumptions: {
      pointSize: input.pointSize,
      pointSizeSource: 'explicit',
      formula: 'forwardPoints = (forwardRate.quotePerBase − spotRate.quotePerBase) / pointSize',
    },
    diagnostics: { warnings: [] },
  });
}

// ---------------------------------------------------------------------------------------------------
// Forward valuation
// ---------------------------------------------------------------------------------------------------

/** Input for {@link foreignExchangeForwardValue} — also one leg of {@link foreignExchangeSwapValue}. */
export interface ForeignExchangeForwardValueInput {
  /** The rate contracted at inception, for the pair being valued. */
  contractRate: CurrencyPairQuote;
  /** Today's forward to the SAME settlement date, SAME pair, SAME direction. */
  currentForwardRate: CurrencyPairQuote;
  /** Contract size in BASE-currency units; direction is carried by `perspective`, so this is > 0. */
  notionalBaseAmount: number;
  /**
   * An explicit discount factor in the QUOTE currency to the settlement date. A factor, not a
   * rate — the matched-conventions law: accepting a rate here would let day-count and compounding
   * conventions mismatch silently against the forward's own quotation.
   */
  discountFactorToSettlement: number;
  /** Which side is being valued: the buyer of the base currency, or the seller. */
  perspective: 'buyer-of-base' | 'seller-of-base';
}

/** Result of {@link foreignExchangeForwardValue}. */
export interface ForeignExchangeForwardValueResult {
  /** Present value of the position in the QUOTE currency; zero at the contracted fair forward. */
  forwardValueInQuoteCurrency: number;
  assumptions: {
    perspective: 'buyer-of-base' | 'seller-of-base';
    signConvention: string;
    discountFactorSource: 'caller-supplied quote-currency discount factor to the settlement date';
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const FORWARD_VALUE_KEYS = [
  'contractRate',
  'currentForwardRate',
  'notionalBaseAmount',
  'discountFactorToSettlement',
  'perspective',
] as const;

const FORWARD_VALUE_EXAMPLE =
  "foreignExchangeForwardValue({ contractRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.08 }, currentForwardRate: { baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.0952 }, notionalBaseAmount: 1_000_000, discountFactorToSettlement: 0.97, perspective: 'buyer-of-base' })";

/**
 * Mark-to-market of an outstanding forward: `±(currentForward − contract) × notionalBase ×
 * discountFactorToSettlement`, positive sign for `'buyer-of-base'`, negative for
 * `'seller-of-base'`, in the QUOTE currency. At `currentForwardRate === contractRate` the value is
 * exactly zero under unchanged inputs (the FC5 acceptance law).
 */
export function foreignExchangeForwardValue(
  input: ForeignExchangeForwardValueInput,
): ForeignExchangeForwardValueResult {
  requireArgumentObject('foreignExchangeForwardValue', 'input', input);
  ensureKnownKeys('foreignExchangeForwardValue', 'input', input, FORWARD_VALUE_KEYS);
  requireCurrencyPairQuote('foreignExchangeForwardValue', 'contractRate', input.contractRate);
  requireCurrencyPairQuote(
    'foreignExchangeForwardValue',
    'currentForwardRate',
    input.currentForwardRate,
  );
  requireSamePair(
    'foreignExchangeForwardValue',
    'contractRate',
    input.contractRate,
    'currentForwardRate',
    input.currentForwardRate,
  );
  const warnings = requireValuationAmounts(
    'foreignExchangeForwardValue',
    input,
    FORWARD_VALUE_EXAMPLE,
  );
  ensureEnum(input.perspective, PERSPECTIVES, 'perspective', 'foreignExchangeForwardValue');
  const sign = input.perspective === 'buyer-of-base' ? 1 : -1;
  const forwardValueInQuoteCurrency =
    sign *
    (input.currentForwardRate.quotePerBase - input.contractRate.quotePerBase) *
    input.notionalBaseAmount *
    input.discountFactorToSettlement;
  return requireFiniteComputation('foreignExchangeForwardValue', {
    forwardValueInQuoteCurrency,
    assumptions: {
      perspective: input.perspective,
      signConvention: SIGN_CONVENTION,
      discountFactorSource: 'caller-supplied quote-currency discount factor to the settlement date',
    },
    diagnostics: { warnings },
  });
}

// ---------------------------------------------------------------------------------------------------
// Swap valuation
// ---------------------------------------------------------------------------------------------------

/** Input for {@link foreignExchangeSwapValue}: two forward legs on the SAME pair. */
export interface ForeignExchangeSwapValueInput {
  nearLeg: ForeignExchangeForwardValueInput;
  farLeg: ForeignExchangeForwardValueInput;
}

/** Result of {@link foreignExchangeSwapValue}. */
export interface ForeignExchangeSwapValueResult {
  /** `nearLegValue + farLegValue`, in the pair's QUOTE currency. */
  swapValueInQuoteCurrency: number;
  nearLegValue: number;
  farLegValue: number;
  assumptions: {
    composition: 'swapValueInQuoteCurrency = nearLegValue + farLegValue; each leg valued with foreignExchangeForwardValue under its own perspective and discount factor';
    nearLegPerspective: 'buyer-of-base' | 'seller-of-base';
    farLegPerspective: 'buyer-of-base' | 'seller-of-base';
    signConvention: string;
  };
  diagnostics: ForeignExchangeDiagnostics;
}

/**
 * Value of a foreign-exchange swap as the sum of its two forward legs, each valued with
 * {@link foreignExchangeForwardValue} (composed, not copied). Both legs must quote the SAME pair;
 * a classic swap holds opposite perspectives on the two legs, but that is the caller's economics
 * and is not enforced — each leg's perspective is echoed.
 */
export function foreignExchangeSwapValue(
  input: ForeignExchangeSwapValueInput,
): ForeignExchangeSwapValueResult {
  requireArgumentObject('foreignExchangeSwapValue', 'input', input);
  ensureKnownKeys('foreignExchangeSwapValue', 'input', input, ['nearLeg', 'farLeg']);
  requireArgumentObject('foreignExchangeSwapValue', 'nearLeg', input.nearLeg);
  requireArgumentObject('foreignExchangeSwapValue', 'farLeg', input.farLeg);
  const nearLeg = foreignExchangeForwardValue(input.nearLeg);
  const farLeg = foreignExchangeForwardValue(input.farLeg);
  requireSamePair(
    'foreignExchangeSwapValue',
    'nearLeg.contractRate',
    input.nearLeg.contractRate,
    'farLeg.contractRate',
    input.farLeg.contractRate,
  );
  const nearLegValue = nearLeg.forwardValueInQuoteCurrency;
  const farLegValue = farLeg.forwardValueInQuoteCurrency;
  return requireFiniteComputation('foreignExchangeSwapValue', {
    swapValueInQuoteCurrency: nearLegValue + farLegValue,
    nearLegValue,
    farLegValue,
    assumptions: {
      composition:
        'swapValueInQuoteCurrency = nearLegValue + farLegValue; each leg valued with foreignExchangeForwardValue under its own perspective and discount factor',
      nearLegPerspective: input.nearLeg.perspective,
      farLegPerspective: input.farLeg.perspective,
      signConvention: SIGN_CONVENTION,
    },
    diagnostics: {
      warnings: [
        ...nearLeg.diagnostics.warnings.map((message) => `nearLeg: ${message}`),
        ...farLeg.diagnostics.warnings.map((message) => `farLeg: ${message}`),
      ],
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// Non-deliverable forwards
// ---------------------------------------------------------------------------------------------------

/** Input for {@link nonDeliverableForwardValue}. */
export interface NonDeliverableForwardValueInput {
  /** The rate contracted at inception. */
  contractRate: CurrencyPairQuote;
  /** The OBSERVED fixing for the SAME pair — caller-supplied, never fetched or guessed. */
  fixingRate: CurrencyPairQuote;
  /** Contract size in BASE-currency units; direction is carried by `perspective`, so this is > 0. */
  notionalBaseAmount: number;
  /** Where cash settles. v1 supports ONLY the pair's quote currency; anything else is rejected. */
  settlementCurrency: string;
  /** An explicit discount factor in the settlement (quote) currency to the settlement date. */
  discountFactorToSettlement: number;
  perspective: 'buyer-of-base' | 'seller-of-base';
}

/** Result of {@link nonDeliverableForwardValue}. */
export interface NonDeliverableForwardValueResult {
  /** The discounted cash settlement, in the settlement (= quote) currency. */
  nonDeliverableForwardValueInSettlementCurrency: number;
  assumptions: {
    fixingSource: 'caller-supplied fixing rate';
    settlementCurrency: string;
    /** The fixed v1 constraint prose: settlement in the pair's quote currency only. */
    settlementConstraint: string;
    perspective: 'buyer-of-base' | 'seller-of-base';
    signConvention: string;
  };
  diagnostics: ForeignExchangeDiagnostics;
}

const NON_DELIVERABLE_FORWARD_KEYS = [
  'contractRate',
  'fixingRate',
  'notionalBaseAmount',
  'settlementCurrency',
  'discountFactorToSettlement',
  'perspective',
] as const;

const NON_DELIVERABLE_FORWARD_EXAMPLE =
  "nonDeliverableForwardValue({ contractRate: { baseCurrency: 'BRL', quoteCurrency: 'USD', quotePerBase: 0.185 }, fixingRate: { baseCurrency: 'BRL', quoteCurrency: 'USD', quotePerBase: 0.19 }, notionalBaseAmount: 1_000_000, settlementCurrency: 'USD', discountFactorToSettlement: 0.98, perspective: 'buyer-of-base' })";

/**
 * Cash-settled value of a non-deliverable forward at its OBSERVED fixing: `±(fixing − contract) ×
 * notionalBase × discountFactorToSettlement`, in the settlement currency. The fixing is the
 * caller's — this function never selects a fixing source. v1 settles only in the pair's quote
 * currency; other settlement currencies are rejected with the constraint named.
 */
export function nonDeliverableForwardValue(
  input: NonDeliverableForwardValueInput,
): NonDeliverableForwardValueResult {
  requireArgumentObject('nonDeliverableForwardValue', 'input', input);
  ensureKnownKeys('nonDeliverableForwardValue', 'input', input, NON_DELIVERABLE_FORWARD_KEYS);
  requireCurrencyPairQuote('nonDeliverableForwardValue', 'contractRate', input.contractRate);
  requireCurrencyPairQuote('nonDeliverableForwardValue', 'fixingRate', input.fixingRate);
  requireSamePair(
    'nonDeliverableForwardValue',
    'contractRate',
    input.contractRate,
    'fixingRate',
    input.fixingRate,
  );
  requireCurrencyCode('nonDeliverableForwardValue', 'settlementCurrency', input.settlementCurrency);
  if (input.settlementCurrency !== input.contractRate.quoteCurrency) {
    throw new InputError(
      `nonDeliverableForwardValue: v1 settles in the pair's quote currency only — '${input.contractRate.quoteCurrency}' for ${input.contractRate.baseCurrency}/${input.contractRate.quoteCurrency}. Received settlementCurrency '${input.settlementCurrency}'. Convert the settled amount explicitly with convertCurrency if another currency is needed.\n  e.g. ${NON_DELIVERABLE_FORWARD_EXAMPLE}`,
      {
        code: ErrorCode.InputOutOfRange,
        context: {
          function: 'nonDeliverableForwardValue',
          field: 'settlementCurrency',
          value: input.settlementCurrency,
          required: input.contractRate.quoteCurrency,
        },
      },
    );
  }
  const warnings = requireValuationAmounts(
    'nonDeliverableForwardValue',
    input,
    NON_DELIVERABLE_FORWARD_EXAMPLE,
  );
  ensureEnum(input.perspective, PERSPECTIVES, 'perspective', 'nonDeliverableForwardValue');
  const sign = input.perspective === 'buyer-of-base' ? 1 : -1;
  const nonDeliverableForwardValueInSettlementCurrency =
    sign *
    (input.fixingRate.quotePerBase - input.contractRate.quotePerBase) *
    input.notionalBaseAmount *
    input.discountFactorToSettlement;
  return requireFiniteComputation('nonDeliverableForwardValue', {
    nonDeliverableForwardValueInSettlementCurrency,
    assumptions: {
      fixingSource: 'caller-supplied fixing rate',
      settlementCurrency: input.settlementCurrency,
      settlementConstraint: "v1 settles in the pair's quote currency only",
      perspective: input.perspective,
      signConvention: SIGN_CONVENTION,
    },
    diagnostics: { warnings },
  });
}
