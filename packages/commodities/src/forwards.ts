/**
 * FC6 — cost-of-carry forwards and their inverses. Three prices live in this module and the
 * functions never conflate them:
 *
 * - the QUOTED futures/forward price — a market observation the caller supplies;
 * - the THEORETICAL forward price — what cost of carry says the forward should be
 *   ({@link commodityForwardPrice});
 * - the CURRENT CONTRACT VALUE — what an already-struck forward position is worth today
 *   ({@link commodityForwardValue}).
 *
 * Every rate is an ANNUAL decimal and every compounding convention is EXPLICIT — a market
 * instrument never defaults its convention. Storage cost is a proportional annual rate of the
 * commodity's value in v1 (not a dollar amount per unit); the field name says so.
 */

import { requireFiniteComputation } from './internal.js';
import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  type InterestCompounding,
  compoundFactor,
  compoundingPeriodsPerYear,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';

// ---------------------------------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------------------------------

/**
 * The REQUIRED-compounding ladder. Valuation's `requireCompoundingWhenPresent` lets `undefined`
 * through because its callers document a default; a commodity forward has no default convention,
 * so absence is a missing field here, taught with the frozen first-touch call.
 */
function requireInterestCompounding(
  functionName: string,
  compounding: unknown,
  exampleCall: string,
): asserts compounding is InterestCompounding {
  if (compounding === undefined) {
    throw new InputError(
      `${functionName}: compounding is required — a market instrument never defaults its convention.\n  e.g. ${exampleCall}`,
      {
        code: ErrorCode.InputMissingField,
        context: { function: functionName, field: 'compounding' },
      },
    );
  }
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
    `${functionName}: compounding must be 'simple' | 'continuous' | 'annual' | 'semiannual' | 'quarterly' | 'monthly' or { type: 'periodic', periodsPerYear }. Received ${compounding === null ? 'null' : typeof compounding === 'number' ? `the retired bare number ${compounding} — pass { type: 'periodic', periodsPerYear: ${compounding} }` : JSON.stringify(compounding)}.`,
    { code: ErrorCode.InputInvalidEnum, context: { function: functionName, field: 'compounding' } },
  );
}

function requirePositive(functionName: string, field: string, value: number, why: string): void {
  if (value <= 0) {
    throw new InputError(`${functionName}: ${field} must be > 0 — ${why} Received ${value}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { function: functionName, field },
    });
  }
}

function requireNonNegative(functionName: string, field: string, value: number, why: string): void {
  if (value < 0) {
    throw new InputError(`${functionName}: ${field} must be ≥ 0 — ${why} Received ${value}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { function: functionName, field },
    });
  }
}

/**
 * Invert the compounding growth factor: the annual rate `r` with
 * `G(r, years) = growthFactor` under the stated convention. The exact inverse of core's
 * `compoundFactor`, form by form:
 *
 * - continuous: `r = ln(G) / years`
 * - simple: `r = (G − 1) / years`
 * - periodic with `m` periods per year: `r = m × (G^(1/(m·years)) − 1)`
 */
function annualRateFromGrowthFactor(
  growthFactor: number,
  years: number,
  compounding: InterestCompounding,
): number {
  const periods = compoundingPeriodsPerYear(compounding);
  if (periods === null) {
    return compounding === 'simple' ? (growthFactor - 1) / years : Math.log(growthFactor) / years;
  }
  return periods * (Math.pow(growthFactor, 1 / (periods * years)) - 1);
}

// ---------------------------------------------------------------------------------------------------
// Theoretical forward price
// ---------------------------------------------------------------------------------------------------

/** Input for {@link commodityForwardPrice} — the FROZEN first-touch field set. */
export interface CommodityForwardPriceInput {
  /** Spot price of the commodity, > 0, in the quote currency per unit. */
  spotPrice: number;
  /** Time to delivery in years, ≥ 0 (zero prices the forward at spot exactly). */
  timeToDeliveryYears: number;
  /** Annual financing (interest) rate, decimal. */
  annualFinancingRate: number;
  /**
   * Annual storage cost as a PROPORTIONAL rate of the commodity's value, decimal — not a dollar
   * amount per unit (v1 models storage as a continuous proportional drag, like a negative yield).
   */
  annualStorageCostRate: number;
  /** Annual convenience yield, decimal — the benefit of holding the physical commodity. */
  annualConvenienceYield: number;
  /** REQUIRED compounding convention — a market instrument never defaults its convention. */
  compounding: InterestCompounding;
}

const COMMODITY_FORWARD_PRICE_EXAMPLE =
  "commodityForwardPrice({ spotPrice: 72, timeToDeliveryYears: 0.5, annualFinancingRate: 0.05, annualStorageCostRate: 0.02, annualConvenienceYield: 0.01, compounding: 'continuous' })";

/**
 * THEORETICAL cost-of-carry forward price: `spotPrice × G(netCarryRate, timeToDeliveryYears)`
 * where `netCarryRate = annualFinancingRate + annualStorageCostRate − annualConvenienceYield` and
 * `G` is the compounding growth factor. For `'continuous'` compounding that is exactly
 * `spotPrice × e^((f + s − c) × t)`.
 *
 * A bare-number primitive (like valuation's `freeCashFlowToFirm`): what carry says the forward
 * SHOULD be, not a quoted futures price and not a contract value.
 */
export function commodityForwardPrice(input: CommodityForwardPriceInput): number {
  requireArgumentObject('commodityForwardPrice', 'input', input);
  ensureKnownKeys('commodityForwardPrice', 'input', input, [
    'spotPrice',
    'timeToDeliveryYears',
    'annualFinancingRate',
    'annualStorageCostRate',
    'annualConvenienceYield',
    'compounding',
  ]);
  requireFiniteFields(
    'commodityForwardPrice',
    input as unknown as Record<string, unknown>,
    [
      'spotPrice',
      'timeToDeliveryYears',
      'annualFinancingRate',
      'annualStorageCostRate',
      'annualConvenienceYield',
    ],
    { exampleCall: COMMODITY_FORWARD_PRICE_EXAMPLE },
  );
  requirePositive(
    'commodityForwardPrice',
    'spotPrice',
    input.spotPrice,
    'a non-positive spot has no cost-of-carry forward.',
  );
  requireNonNegative(
    'commodityForwardPrice',
    'timeToDeliveryYears',
    input.timeToDeliveryYears,
    'delivery cannot precede the valuation instant.',
  );
  requireInterestCompounding(
    'commodityForwardPrice',
    input.compounding,
    COMMODITY_FORWARD_PRICE_EXAMPLE,
  );
  const netCarryRate =
    input.annualFinancingRate + input.annualStorageCostRate - input.annualConvenienceYield;
  return requireFiniteComputation(
    'commodityForwardPrice',
    input.spotPrice * compoundFactor(netCarryRate, input.timeToDeliveryYears, input.compounding),
  );
}

// ---------------------------------------------------------------------------------------------------
// Current contract value
// ---------------------------------------------------------------------------------------------------

/** Input for {@link commodityForwardValue}. */
export interface CommodityForwardValueInput {
  /** The forward price STRUCK on the existing contract (the delivery price agreed at inception). */
  contractForwardPrice: number;
  /**
   * The CURRENT forward price for the same delivery date — a market quote or a theoretical price
   * from {@link commodityForwardPrice}; either way, a forward PRICE, not a contract value.
   */
  currentForwardPrice: number;
  /** Number of units underlying the contract, > 0. */
  quantity: number;
  /**
   * EXPLICIT discount factor from the delivery date back to the valuation instant, > 0 — the
   * matched-conventions law: the factor carries its own curve, day count, and compounding, so this
   * function never re-derives one from a rate it would have to guess conventions for.
   */
  discountFactorToDelivery: number;
  /** Which side of the contract is being valued. */
  perspective: 'long' | 'short';
}

/** Result of {@link commodityForwardValue}. */
export interface CommodityForwardValueResult {
  /** The CURRENT VALUE of the existing contract to the stated side (quote currency). */
  contractValue: number;
  assumptions: {
    perspective: 'long' | 'short';
    /** The factor as supplied — its conventions belong to the caller's curve. */
    discountFactorToDelivery: number;
    /** The fixed valuation prose: ±(current − contract) × quantity × factor, long positive. */
    valuationConvention: string;
  };
  diagnostics: { warnings: string[] };
}

/**
 * CURRENT VALUE of an existing forward contract:
 * `±(currentForwardPrice − contractForwardPrice) × quantity × discountFactorToDelivery`, positive
 * for `'long'` and negated for `'short'`.
 *
 * The three quantities this module keeps distinct meet here: `contractForwardPrice` is the price
 * STRUCK on the contract, `currentForwardPrice` is today's forward PRICE (quoted or theoretical),
 * and the result is the contract's VALUE — zero at inception when struck at the fair forward.
 */
export function commodityForwardValue(
  input: CommodityForwardValueInput,
): CommodityForwardValueResult {
  requireArgumentObject('commodityForwardValue', 'input', input);
  ensureKnownKeys('commodityForwardValue', 'input', input, [
    'contractForwardPrice',
    'currentForwardPrice',
    'quantity',
    'discountFactorToDelivery',
    'perspective',
  ]);
  requireFiniteFields(
    'commodityForwardValue',
    input as unknown as Record<string, unknown>,
    ['contractForwardPrice', 'currentForwardPrice', 'quantity', 'discountFactorToDelivery'],
    {
      exampleCall:
        "commodityForwardValue({ contractForwardPrice: 70, currentForwardPrice: 74, quantity: 1000, discountFactorToDelivery: 0.98, perspective: 'long' })",
    },
  );
  requirePositive(
    'commodityForwardValue',
    'quantity',
    input.quantity,
    'value a short position with perspective, not a negative quantity.',
  );
  requirePositive(
    'commodityForwardValue',
    'discountFactorToDelivery',
    input.discountFactorToDelivery,
    'a discount factor is a positive price of future money.',
  );
  if (input.perspective !== 'long' && input.perspective !== 'short') {
    const received = (input as { perspective?: unknown }).perspective;
    throw new InputError(
      `commodityForwardValue: perspective must be 'long' | 'short'. Received ${received === null ? 'null' : JSON.stringify(received)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'perspective' } },
    );
  }
  const sign = input.perspective === 'long' ? 1 : -1;
  return requireRepresentableResult('commodityForwardValue', {
    contractValue:
      sign *
      (input.currentForwardPrice - input.contractForwardPrice) *
      input.quantity *
      input.discountFactorToDelivery,
    assumptions: {
      perspective: input.perspective,
      discountFactorToDelivery: input.discountFactorToDelivery,
      valuationConvention:
        'contractValue = ±(currentForwardPrice − contractForwardPrice) × quantity × discountFactorToDelivery; positive sign for the long side',
    },
    diagnostics: { warnings: [] },
  });
}

// ---------------------------------------------------------------------------------------------------
// Implied carry and its components
// ---------------------------------------------------------------------------------------------------

/** Input for {@link commodityCarry}. */
export interface CommodityCarryInput {
  /** Spot price, > 0. */
  spotPrice: number;
  /** The observed forward (or futures) price for the delivery date, > 0. */
  forwardPrice: number;
  /** Time to delivery in years, > 0 — carry over zero time is undefined, not zero. */
  timeToDeliveryYears: number;
  /** REQUIRED compounding convention used to annualize the implied carry. */
  compounding: InterestCompounding;
  /** Optional supplied component: annual financing rate, decimal. */
  annualFinancingRate?: number;
  /** Optional supplied component: annual proportional storage cost rate, decimal. */
  annualStorageCostRate?: number;
  /** Optional supplied component: annual convenience yield, decimal. */
  annualConvenienceYield?: number;
}

/** Result of {@link commodityCarry}. */
export interface CommodityCarryResult {
  /**
   * The annualized total carry implied by the spot/forward pair: the rate `r` with
   * `spotPrice × G(r, timeToDeliveryYears) = forwardPrice` (for `'continuous'`,
   * `ln(forwardPrice / spotPrice) / timeToDeliveryYears`).
   */
  annualizedCarryRate: number;
  /** The supplied components, echoed — present when at least one was supplied. */
  components?: {
    annualFinancingRate?: number;
    annualStorageCostRate?: number;
    annualConvenienceYield?: number;
  };
  /**
   * `annualizedCarryRate − (financing + storage − convenience)` — the cost-of-carry parity law
   * made visible. Present exactly when all three components were supplied.
   */
  impliedResidual?: number;
  assumptions: {
    compounding: InterestCompounding;
    /** The fixed carry definition prose: the rate whose growth factor maps spot to forward. */
    carryDefinition: string;
  };
  diagnostics: { warnings: string[] };
}

const COMMODITY_CARRY_EXAMPLE =
  "commodityCarry({ spotPrice: 72, forwardPrice: 74.19, timeToDeliveryYears: 0.5, compounding: 'continuous', annualFinancingRate: 0.05, annualStorageCostRate: 0.02, annualConvenienceYield: 0.01 })";

/**
 * The annualized TOTAL carry a spot/forward pair implies, by inverting the compounding growth
 * factor. When all three components (financing, storage, convenience) are supplied, the result
 * also reports `impliedResidual = annualizedCarryRate − (f + s − c)` and warns when the residual
 * exceeds 1e-9 — a parity-priced forward has residual zero, and a nonzero residual is the parity
 * law made visible, never silently absorbed into a component.
 */
export function commodityCarry(input: CommodityCarryInput): CommodityCarryResult {
  requireArgumentObject('commodityCarry', 'input', input);
  ensureKnownKeys('commodityCarry', 'input', input, [
    'spotPrice',
    'forwardPrice',
    'timeToDeliveryYears',
    'compounding',
    'annualFinancingRate',
    'annualStorageCostRate',
    'annualConvenienceYield',
  ]);
  requireFiniteFields(
    'commodityCarry',
    input as unknown as Record<string, unknown>,
    ['spotPrice', 'forwardPrice', 'timeToDeliveryYears'],
    { exampleCall: COMMODITY_CARRY_EXAMPLE },
  );
  requirePositive('commodityCarry', 'spotPrice', input.spotPrice, 'carry needs a positive spot.');
  requirePositive(
    'commodityCarry',
    'forwardPrice',
    input.forwardPrice,
    'carry needs a positive forward.',
  );
  requirePositive(
    'commodityCarry',
    'timeToDeliveryYears',
    input.timeToDeliveryYears,
    'carry over zero time is undefined, not zero.',
  );
  requireInterestCompounding('commodityCarry', input.compounding, COMMODITY_CARRY_EXAMPLE);
  const componentFields = [
    'annualFinancingRate',
    'annualStorageCostRate',
    'annualConvenienceYield',
  ] as const;
  for (const field of componentFields) {
    const value = input[field];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new InputError(
        `commodityCarry: ${field} must be a finite decimal when provided. Received ${value === null ? 'null' : String(value)}.`,
        { code: ErrorCode.InputWrongType, context: { field } },
      );
    }
  }
  const annualizedCarryRate = annualRateFromGrowthFactor(
    input.forwardPrice / input.spotPrice,
    input.timeToDeliveryYears,
    input.compounding,
  );
  const suppliedCount = componentFields.filter((field) => input[field] !== undefined).length;
  const warnings: string[] = [];
  const result: CommodityCarryResult = {
    annualizedCarryRate,
    assumptions: {
      compounding: input.compounding,
      carryDefinition:
        'annualizedCarryRate solves spotPrice × G(rate, timeToDeliveryYears) = forwardPrice under the stated compounding; positive carry means the forward stands above spot',
    },
    diagnostics: { warnings },
  };
  if (suppliedCount > 0) {
    result.components = {
      ...(input.annualFinancingRate !== undefined
        ? { annualFinancingRate: input.annualFinancingRate }
        : {}),
      ...(input.annualStorageCostRate !== undefined
        ? { annualStorageCostRate: input.annualStorageCostRate }
        : {}),
      ...(input.annualConvenienceYield !== undefined
        ? { annualConvenienceYield: input.annualConvenienceYield }
        : {}),
    };
  }
  if (suppliedCount === 3) {
    const impliedResidual =
      annualizedCarryRate -
      (input.annualFinancingRate! + input.annualStorageCostRate! - input.annualConvenienceYield!);
    result.impliedResidual = impliedResidual;
    if (Math.abs(impliedResidual) > 1e-9) {
      warnings.push(
        `impliedResidual ${impliedResidual} exceeds 1e-9 — the observed forward is not parity-priced by the supplied financing/storage/convenience components (cost-of-carry parity made visible).`,
      );
    }
  } else if (suppliedCount > 0) {
    warnings.push(
      'impliedResidual is absent: the carry decomposition needs all three of annualFinancingRate, annualStorageCostRate, and annualConvenienceYield — a residual against a partial component set would silently blame the missing component.',
    );
  }
  return requireRepresentableResult('commodityCarry', result);
}

/** Input for {@link impliedConvenienceYield}. */
export interface ImpliedConvenienceYieldInput {
  /** Spot price, > 0. */
  spotPrice: number;
  /** The observed forward (or futures) price, > 0. */
  forwardPrice: number;
  /** Time to delivery in years, > 0. */
  timeToDeliveryYears: number;
  /** Annual financing rate, decimal. */
  annualFinancingRate: number;
  /** Annual proportional storage cost rate, decimal. */
  annualStorageCostRate: number;
  /** REQUIRED compounding convention. */
  compounding: InterestCompounding;
}

/** Result of {@link impliedConvenienceYield}. */
export interface ImpliedConvenienceYieldResult {
  /** `annualFinancingRate + annualStorageCostRate − annualizedCarry` — the yield the pair implies. */
  impliedAnnualConvenienceYield: number;
  assumptions: {
    compounding: InterestCompounding;
    /** The fixed inversion prose: convenience = financing + storage − implied carry. */
    inversion: string;
  };
  diagnostics: { warnings: string[] };
}

const IMPLIED_CONVENIENCE_YIELD_EXAMPLE =
  "impliedConvenienceYield({ spotPrice: 72, forwardPrice: 74.19, timeToDeliveryYears: 0.5, annualFinancingRate: 0.05, annualStorageCostRate: 0.02, compounding: 'continuous' })";

/**
 * The convenience yield the spot/forward pair implies, given the other carry components — the
 * inverse of {@link commodityForwardPrice} solved for `annualConvenienceYield`. The remaining
 * inputs identify it uniquely: `c = f + s − annualizedCarry`.
 */
export function impliedConvenienceYield(
  input: ImpliedConvenienceYieldInput,
): ImpliedConvenienceYieldResult {
  requireArgumentObject('impliedConvenienceYield', 'input', input);
  ensureKnownKeys('impliedConvenienceYield', 'input', input, [
    'spotPrice',
    'forwardPrice',
    'timeToDeliveryYears',
    'annualFinancingRate',
    'annualStorageCostRate',
    'compounding',
  ]);
  requireFiniteFields(
    'impliedConvenienceYield',
    input as unknown as Record<string, unknown>,
    [
      'spotPrice',
      'forwardPrice',
      'timeToDeliveryYears',
      'annualFinancingRate',
      'annualStorageCostRate',
    ],
    { exampleCall: IMPLIED_CONVENIENCE_YIELD_EXAMPLE },
  );
  requirePositive(
    'impliedConvenienceYield',
    'spotPrice',
    input.spotPrice,
    'the inversion needs a positive spot.',
  );
  requirePositive(
    'impliedConvenienceYield',
    'forwardPrice',
    input.forwardPrice,
    'the inversion needs a positive forward.',
  );
  requirePositive(
    'impliedConvenienceYield',
    'timeToDeliveryYears',
    input.timeToDeliveryYears,
    'carry over zero time is undefined, not zero.',
  );
  requireInterestCompounding(
    'impliedConvenienceYield',
    input.compounding,
    IMPLIED_CONVENIENCE_YIELD_EXAMPLE,
  );
  const annualizedCarry = annualRateFromGrowthFactor(
    input.forwardPrice / input.spotPrice,
    input.timeToDeliveryYears,
    input.compounding,
  );
  return requireRepresentableResult('impliedConvenienceYield', {
    impliedAnnualConvenienceYield:
      input.annualFinancingRate + input.annualStorageCostRate - annualizedCarry,
    assumptions: {
      compounding: input.compounding,
      inversion:
        'impliedAnnualConvenienceYield = annualFinancingRate + annualStorageCostRate − annualizedCarry, where annualizedCarry inverts spotPrice × G(rate, timeToDeliveryYears) = forwardPrice',
    },
    diagnostics: { warnings: [] },
  });
}

/** Input for {@link impliedStorageCost}. */
export interface ImpliedStorageCostInput {
  /** Spot price, > 0. */
  spotPrice: number;
  /** The observed forward (or futures) price, > 0. */
  forwardPrice: number;
  /** Time to delivery in years, > 0. */
  timeToDeliveryYears: number;
  /** Annual financing rate, decimal. */
  annualFinancingRate: number;
  /** Annual convenience yield, decimal. */
  annualConvenienceYield: number;
  /** REQUIRED compounding convention. */
  compounding: InterestCompounding;
}

/** Result of {@link impliedStorageCost}. */
export interface ImpliedStorageCostResult {
  /** `annualizedCarry − annualFinancingRate + annualConvenienceYield` — the rate the pair implies. */
  impliedAnnualStorageCostRate: number;
  assumptions: {
    compounding: InterestCompounding;
    /** The fixed inversion prose: storage = implied carry − financing + convenience. */
    inversion: string;
  };
  diagnostics: { warnings: string[] };
}

const IMPLIED_STORAGE_COST_EXAMPLE =
  "impliedStorageCost({ spotPrice: 72, forwardPrice: 74.19, timeToDeliveryYears: 0.5, annualFinancingRate: 0.05, annualConvenienceYield: 0.01, compounding: 'continuous' })";

/**
 * The proportional storage cost rate the spot/forward pair implies, given the other carry
 * components — the spec's "when the remaining inputs identify it uniquely", which these do:
 * `s = annualizedCarry − f + c`.
 */
export function impliedStorageCost(input: ImpliedStorageCostInput): ImpliedStorageCostResult {
  requireArgumentObject('impliedStorageCost', 'input', input);
  ensureKnownKeys('impliedStorageCost', 'input', input, [
    'spotPrice',
    'forwardPrice',
    'timeToDeliveryYears',
    'annualFinancingRate',
    'annualConvenienceYield',
    'compounding',
  ]);
  requireFiniteFields(
    'impliedStorageCost',
    input as unknown as Record<string, unknown>,
    [
      'spotPrice',
      'forwardPrice',
      'timeToDeliveryYears',
      'annualFinancingRate',
      'annualConvenienceYield',
    ],
    { exampleCall: IMPLIED_STORAGE_COST_EXAMPLE },
  );
  requirePositive(
    'impliedStorageCost',
    'spotPrice',
    input.spotPrice,
    'the inversion needs a positive spot.',
  );
  requirePositive(
    'impliedStorageCost',
    'forwardPrice',
    input.forwardPrice,
    'the inversion needs a positive forward.',
  );
  requirePositive(
    'impliedStorageCost',
    'timeToDeliveryYears',
    input.timeToDeliveryYears,
    'carry over zero time is undefined, not zero.',
  );
  requireInterestCompounding('impliedStorageCost', input.compounding, IMPLIED_STORAGE_COST_EXAMPLE);
  const annualizedCarry = annualRateFromGrowthFactor(
    input.forwardPrice / input.spotPrice,
    input.timeToDeliveryYears,
    input.compounding,
  );
  return requireRepresentableResult('impliedStorageCost', {
    impliedAnnualStorageCostRate:
      annualizedCarry - input.annualFinancingRate + input.annualConvenienceYield,
    assumptions: {
      compounding: input.compounding,
      inversion:
        'impliedAnnualStorageCostRate = annualizedCarry − annualFinancingRate + annualConvenienceYield, where annualizedCarry inverts spotPrice × G(rate, timeToDeliveryYears) = forwardPrice',
    },
    diagnostics: { warnings: [] },
  });
}

// ---------------------------------------------------------------------------------------------------
// Hedge ratio and basis
// ---------------------------------------------------------------------------------------------------

/** Input for {@link futuresHedgeRatio}. */
export interface FuturesHedgeRatioInput {
  /** The exposure being hedged, in commodity units (sign carries the direction). */
  exposureQuantity: number;
  /** Units of the commodity per futures contract, > 0. */
  futuresContractSize: number;
  /**
   * The minimum-variance hedge ratio (a regression beta or hedge effectiveness), default 1 — a
   * one-to-one hedge, echoed as such in the assumptions.
   */
  betaOrHedgeEffectiveness?: number;
}

/** Result of {@link futuresHedgeRatio}. */
export interface FuturesHedgeRatioResult {
  /**
   * `exposureQuantity × betaOrHedgeEffectiveness / futuresContractSize` — a REAL number, not
   * rounded: rounding to whole contracts is the caller's execution decision, disclosed in the
   * assumptions rather than taken silently.
   */
  contractsRequired: number;
  assumptions: {
    betaOrHedgeEffectiveness: number;
    hedgeRatioBasis: 'one-to-one' | 'caller-supplied beta or hedge effectiveness';
    /** The fixed rounding prose: the count is real-valued; rounding is the caller's decision. */
    rounding: string;
  };
  diagnostics: { warnings: string[] };
}

/**
 * Futures contracts required to hedge an exposure:
 * `exposureQuantity × betaOrHedgeEffectiveness / futuresContractSize`. The count is NOT rounded —
 * whether to round up, down, or trade the fraction via a mini contract is an execution decision
 * that belongs to the caller, and the assumptions say so.
 */
export function futuresHedgeRatio(input: FuturesHedgeRatioInput): FuturesHedgeRatioResult {
  requireArgumentObject('futuresHedgeRatio', 'input', input);
  ensureKnownKeys('futuresHedgeRatio', 'input', input, [
    'exposureQuantity',
    'futuresContractSize',
    'betaOrHedgeEffectiveness',
  ]);
  requireFiniteFields(
    'futuresHedgeRatio',
    input as unknown as Record<string, unknown>,
    ['exposureQuantity', 'futuresContractSize'],
    {
      exampleCall:
        'futuresHedgeRatio({ exposureQuantity: 25_000, futuresContractSize: 1_000, betaOrHedgeEffectiveness: 0.92 })',
    },
  );
  requirePositive(
    'futuresHedgeRatio',
    'futuresContractSize',
    input.futuresContractSize,
    'a contract covers a positive quantity.',
  );
  if (
    input.betaOrHedgeEffectiveness !== undefined &&
    (typeof input.betaOrHedgeEffectiveness !== 'number' ||
      !Number.isFinite(input.betaOrHedgeEffectiveness))
  ) {
    throw new InputError(
      `futuresHedgeRatio: betaOrHedgeEffectiveness must be a finite number when provided. Received ${input.betaOrHedgeEffectiveness === null ? 'null' : String(input.betaOrHedgeEffectiveness)}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'betaOrHedgeEffectiveness' } },
    );
  }
  const beta = input.betaOrHedgeEffectiveness ?? 1;
  return requireRepresentableResult('futuresHedgeRatio', {
    contractsRequired: (input.exposureQuantity * beta) / input.futuresContractSize,
    assumptions: {
      betaOrHedgeEffectiveness: beta,
      hedgeRatioBasis:
        input.betaOrHedgeEffectiveness === undefined
          ? 'one-to-one'
          : 'caller-supplied beta or hedge effectiveness',
      rounding:
        'contractsRequired is a real number; rounding to whole contracts is the caller’s execution decision',
    },
    diagnostics: { warnings: [] },
  });
}

/** Input for {@link commodityBasis}. */
export interface CommodityBasisInput {
  /** Spot price, > 0. */
  spotPrice: number;
  /** The quoted futures price, > 0. */
  futuresPrice: number;
}

/** Result of {@link commodityBasis}. */
export interface CommodityBasisResult {
  /** `spotPrice − futuresPrice` — the basis in price units. */
  basis: number;
  /** `spotPrice / futuresPrice − 1` — the basis as a fraction of the futures price. */
  basisFraction: number;
  assumptions: {
    /** The fixed basis definition prose: price difference and fraction, both named. */
    definition: string;
  };
  diagnostics: { warnings: string[] };
}

/**
 * The basis between spot and a quoted futures price. `basis` (a price difference) and
 * `basisFraction` (a dimensionless ratio) are DIFFERENT quantities and both deserve names — the
 * library's naming law already blesses exactly this pair.
 */
export function commodityBasis(input: CommodityBasisInput): CommodityBasisResult {
  requireArgumentObject('commodityBasis', 'input', input);
  ensureKnownKeys('commodityBasis', 'input', input, ['spotPrice', 'futuresPrice']);
  requireFiniteFields(
    'commodityBasis',
    input as unknown as Record<string, unknown>,
    ['spotPrice', 'futuresPrice'],
    { exampleCall: 'commodityBasis({ spotPrice: 72, futuresPrice: 73.5 })' },
  );
  requirePositive('commodityBasis', 'spotPrice', input.spotPrice, 'basis needs a positive spot.');
  requirePositive(
    'commodityBasis',
    'futuresPrice',
    input.futuresPrice,
    'basis needs a positive futures price.',
  );
  return requireRepresentableResult('commodityBasis', {
    basis: input.spotPrice - input.futuresPrice,
    basisFraction: input.spotPrice / input.futuresPrice - 1,
    assumptions: {
      definition:
        'basis = spotPrice − futuresPrice (positive when spot trades above the future); basisFraction = spotPrice / futuresPrice − 1 — two DIFFERENT quantities, both named',
    },
    diagnostics: { warnings: [] },
  });
}
