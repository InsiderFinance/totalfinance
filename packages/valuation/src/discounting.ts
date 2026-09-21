/**
 * FC1 — discounting, accumulation, and rate conversion on the ONE `InterestCompounding` grammar.
 *
 * Every head is a Law 12 closed request with named fields; the convenience defaults
 * (`compounding: 'annual'` for ordinary flows, `dayCount: 'ACT/365F'` for dated flows) are
 * documented here and echoed by the `.explain()` reports of the solvers that consume them. The
 * spec's lowercase `'act/365f'` spelling resolves to core's one `DayCount` vocabulary — a second
 * casing would be a duplicated convention grammar, which the FC0 exit gate forbids.
 */

import {
  requireRepresentableResult,
  stableSum,
  compoundFactor,
  compoundingPeriodsPerYear,
  type DayCount,
  discountFactor,
  ensureKnownKeys,
  ErrorCode,
  InputError,
  type InterestCompounding,
  isoDateToEpochMs,
  requireArgumentObject,
  requireFiniteFields,
  yearFraction,
} from '@totalfinance/core';
import {
  type DatedCashFlow,
  type TimedCashFlow,
  requireDatedCashFlows,
  requireTimedCashFlows,
} from './flows.js';

const DAY_COUNTS: readonly DayCount[] = ['ACT/365F', 'ACT/360', '30/360'];

/** Shared when-present compounding ladder — the seven-form grammar, taught at the boundary. */
export function requireCompoundingWhenPresent(
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
      { code: ErrorCode.InputOutOfRange, context: { field: 'compounding' } },
    );
  }
  throw new InputError(
    `${functionName}: compounding must be 'simple' | 'continuous' | 'annual' | 'semiannual' | 'quarterly' | 'monthly' or { type: 'periodic', periodsPerYear } when provided. Received ${compounding === null ? 'null' : typeof compounding === 'number' ? `the retired bare number ${compounding} — pass { type: 'periodic', periodsPerYear: ${compounding} }` : JSON.stringify(compounding)}.`,
    { code: ErrorCode.InputInvalidEnum, context: { field: 'compounding' } },
  );
}

/** Shared when-present day-count ladder over core's ONE vocabulary. */
export function requireDayCountWhenPresent(
  functionName: string,
  dayCount: unknown,
): asserts dayCount is DayCount | undefined {
  if (dayCount === undefined) return;
  if (typeof dayCount === 'string' && (DAY_COUNTS as readonly string[]).includes(dayCount)) return;
  throw new InputError(
    `${functionName}: dayCount must be one of ${DAY_COUNTS.join(' | ')} when provided. Received ${dayCount === null ? 'null' : JSON.stringify(dayCount)}.`,
    { code: ErrorCode.InputInvalidEnum, context: { field: 'dayCount' } },
  );
}

// ---------------------------------------------------------------------------------------------------
// Present / future value
// ---------------------------------------------------------------------------------------------------

/** Input for {@link presentValue}: what one future amount is worth today. */
export interface PresentValueInput {
  /** The amount received at `timeYears`. */
  futureAmount: number;
  /** Annual rate (decimal, e.g. `0.08`). */
  annualInterestRate: number;
  timeYears: number;
  /** Default `'annual'` — the FC1 ordinary-flow convention, documented and echoed. */
  compounding?: InterestCompounding;
}

const PRESENT_VALUE_KEYS = [
  'futureAmount',
  'annualInterestRate',
  'timeYears',
  'compounding',
] as const;

/** Present value of one future amount: `futureAmount · discountFactor(rate, t, compounding)`. */
export function presentValue(input: PresentValueInput): number {
  requireArgumentObject('presentValue', 'input', input);
  ensureKnownKeys('presentValue', 'input', input, PRESENT_VALUE_KEYS);
  requireFiniteFields('presentValue', input, ['futureAmount', 'annualInterestRate', 'timeYears'], {
    exampleCall:
      "presentValue({ futureAmount: 1_000, annualInterestRate: 0.08, timeYears: 5, compounding: 'annual' })",
  });
  requireCompoundingWhenPresent('presentValue', input.compounding);
  requireNonNegativeTime('presentValue', input.timeYears);
  return requireRepresentableResult(
    'presentValue',
    input.futureAmount *
      discountFactor(input.annualInterestRate, input.timeYears, input.compounding ?? 'annual'),
  );
}

/** Input for {@link futureValue}: what one present amount grows to. */
export interface FutureValueInput {
  /** The amount held at time zero. */
  presentAmount: number;
  /** Annual rate (decimal). */
  annualInterestRate: number;
  timeYears: number;
  /** Default `'annual'` — the FC1 ordinary-flow convention, documented and echoed. */
  compounding?: InterestCompounding;
}

const FUTURE_VALUE_KEYS = [
  'presentAmount',
  'annualInterestRate',
  'timeYears',
  'compounding',
] as const;

/** Future value of one present amount: `presentAmount · compoundFactor(rate, t, compounding)`. */
export function futureValue(input: FutureValueInput): number {
  requireArgumentObject('futureValue', 'input', input);
  ensureKnownKeys('futureValue', 'input', input, FUTURE_VALUE_KEYS);
  requireFiniteFields('futureValue', input, ['presentAmount', 'annualInterestRate', 'timeYears'], {
    exampleCall:
      "futureValue({ presentAmount: 1_000, annualInterestRate: 0.08, timeYears: 5, compounding: 'annual' })",
  });
  requireCompoundingWhenPresent('futureValue', input.compounding);
  requireNonNegativeTime('futureValue', input.timeYears);
  return requireRepresentableResult(
    'futureValue',
    input.presentAmount *
      compoundFactor(input.annualInterestRate, input.timeYears, input.compounding ?? 'annual'),
  );
}

function requireNonNegativeTime(functionName: string, timeYears: number): void {
  if (timeYears < 0) {
    throw new InputError(
      `${functionName}: timeYears must be ≥ 0 — historical flows belong in the dated forms with an explicit asOf. Received ${timeYears}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'timeYears' } },
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// Cash-flow discounting
// ---------------------------------------------------------------------------------------------------

/** Input for {@link discountCashFlows}: per-flow present values plus their total. */
export interface DiscountCashFlowsInput {
  cashFlows: readonly TimedCashFlow[];
  /** Annual discount rate (decimal). */
  annualDiscountRate: number;
  /** Default `'annual'` — documented and echoed. */
  compounding?: InterestCompounding;
}

const DISCOUNT_CASH_FLOWS_KEYS = ['cashFlows', 'annualDiscountRate', 'compounding'] as const;

/** One discounted flow: the input flow plus its discount factor and present value. */
export interface DiscountedCashFlowRow {
  amount: number;
  timeYears: number;
  label?: string;
  discountFactor: number;
  presentValue: number;
}

/**
 * Discount each flow individually (a supplied time-zero flow discounts by exactly 1 — included
 * once, never inferred). Rows preserve input order; `presentValueTotal` is their sum.
 */
export function discountCashFlows(input: DiscountCashFlowsInput): {
  rows: DiscountedCashFlowRow[];
  presentValueTotal: number;
} {
  requireArgumentObject('discountCashFlows', 'input', input);
  ensureKnownKeys('discountCashFlows', 'input', input, DISCOUNT_CASH_FLOWS_KEYS);
  requireFiniteFields('discountCashFlows', input, ['annualDiscountRate'], {
    exampleCall:
      'discountCashFlows({ cashFlows: [{ amount: -1_000, timeYears: 0 }, { amount: 600, timeYears: 1 }], annualDiscountRate: 0.1 })',
  });
  requireTimedCashFlows('discountCashFlows', input.cashFlows);
  requireCompoundingWhenPresent('discountCashFlows', input.compounding);
  const compounding = input.compounding ?? 'annual';
  let presentValueTotal = 0;
  const rows = input.cashFlows.map((flow) => {
    const factor = discountFactor(input.annualDiscountRate, flow.timeYears, compounding);
    const value = flow.amount * factor;
    presentValueTotal += value;
    return {
      amount: flow.amount,
      timeYears: flow.timeYears,
      ...(flow.label !== undefined ? { label: flow.label } : {}),
      discountFactor: factor,
      presentValue: value,
    };
  });
  return { rows, presentValueTotal };
}

/** Input for {@link netPresentValue}. */
export interface NetPresentValueInput {
  cashFlows: readonly TimedCashFlow[];
  /** Annual discount rate (decimal). */
  annualDiscountRate: number;
  /** Default `'annual'` — documented and echoed. */
  compounding?: InterestCompounding;
}

/**
 * Net present value of explicit timed flows. A supplied `timeYears: 0` flow is included exactly
 * once at face value; no time-zero flow is ever inferred.
 */
export function netPresentValue(input: NetPresentValueInput): number {
  requireArgumentObject('netPresentValue', 'input', input);
  ensureKnownKeys('netPresentValue', 'input', input, DISCOUNT_CASH_FLOWS_KEYS);
  requireFiniteFields('netPresentValue', input, ['annualDiscountRate'], {
    exampleCall:
      'netPresentValue({ cashFlows: [{ amount: -1_000, timeYears: 0 }, { amount: 600, timeYears: 1 }, { amount: 600, timeYears: 2 }], annualDiscountRate: 0.1 })',
  });
  requireTimedCashFlows('netPresentValue', input.cashFlows);
  requireCompoundingWhenPresent('netPresentValue', input.compounding);
  const compounding = input.compounding ?? 'annual';
  // stableSum over the discounted terms: four time-zero flows summing to 0 must return 0, not a
  // refusal born of the left-to-right partial sum (2026-08-23, fourth review).
  const terms = input.cashFlows.map(
    (flow) => flow.amount * discountFactor(input.annualDiscountRate, flow.timeYears, compounding),
  );
  return requireRepresentableResult('netPresentValue', stableSum(terms));
}

/** Input for {@link datedNetPresentValue}. */
export interface DatedNetPresentValueInput {
  cashFlows: readonly DatedCashFlow[];
  /** Strict `YYYY-MM-DD` valuation date. */
  asOf: string;
  /** Annual discount rate (decimal). */
  annualDiscountRate: number;
  /** Default `'annual'` — documented and echoed. */
  compounding?: InterestCompounding;
  /** Default `'ACT/365F'` — documented and echoed. */
  dayCount?: DayCount;
}

const DATED_NPV_KEYS = [
  'cashFlows',
  'asOf',
  'annualDiscountRate',
  'compounding',
  'dayCount',
] as const;

const STRICT_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shape via the regex, then the REAL calendar: `2025-02-30` must teach, never normalize. */
const isCalendarDate = (value: string): boolean => {
  try {
    isoDateToEpochMs(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Dated net present value AT `asOf`. Future flows discount back and HISTORICAL flows accumulate
 * forward under the same declared convention — a realized flow is never discarded merely because
 * it precedes the valuation date. A flow ON `asOf` enters at face value, exactly once.
 */
export function datedNetPresentValue(input: DatedNetPresentValueInput): number {
  requireArgumentObject('datedNetPresentValue', 'input', input);
  ensureKnownKeys('datedNetPresentValue', 'input', input, DATED_NPV_KEYS);
  requireFiniteFields('datedNetPresentValue', input, ['annualDiscountRate'], {
    exampleCall:
      "datedNetPresentValue({ cashFlows: [{ amount: -1_000, cashFlowDate: '2026-01-01' }, { amount: 1_100, cashFlowDate: '2027-01-01' }], asOf: '2026-01-01', annualDiscountRate: 0.1 })",
  });
  requireDatedCashFlows('datedNetPresentValue', input.cashFlows);
  if (
    typeof input.asOf !== 'string' ||
    !STRICT_DATE.test(input.asOf) ||
    !isCalendarDate(input.asOf)
  ) {
    throw new InputError(
      `datedNetPresentValue: asOf must be a strict YYYY-MM-DD calendar date. Received ${input.asOf === null ? 'null' : JSON.stringify(input.asOf)}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'asOf' } },
    );
  }
  requireCompoundingWhenPresent('datedNetPresentValue', input.compounding);
  requireDayCountWhenPresent('datedNetPresentValue', input.dayCount);
  const compounding = input.compounding ?? 'annual';
  const dayCount = input.dayCount ?? 'ACT/365F';
  const terms = input.cashFlows.map((flow) => {
    const years = yearFraction(input.asOf, flow.cashFlowDate, dayCount);
    // years > 0 → future flow, discount back; years < 0 → realized flow, accumulate forward.
    return years >= 0
      ? flow.amount * discountFactor(input.annualDiscountRate, years, compounding)
      : flow.amount * compoundFactor(input.annualDiscountRate, -years, compounding);
  });
  return requireRepresentableResult('datedNetPresentValue', stableSum(terms));
}

// ---------------------------------------------------------------------------------------------------
// Rate conversion
// ---------------------------------------------------------------------------------------------------

/** Input for {@link effectiveAnnualRate}: the EAR of a nominal rate under its compounding. */
export interface EffectiveAnnualRateInput {
  /** Nominal (stated) annual rate (decimal). */
  nominalAnnualRate: number;
  /** REQUIRED — a rate conversion never guesses its convention. */
  compounding: InterestCompounding;
}

/** Input for {@link nominalAnnualRate}: the nominal rate whose EAR is the given effective rate. */
export interface NominalAnnualRateInput {
  /** Effective annual rate (decimal). */
  effectiveAnnualRate: number;
  /** REQUIRED — a rate conversion never guesses its convention. */
  compounding: InterestCompounding;
}

/** Input for {@link equivalentInterestRate}: re-express a rate in another convention. */
export interface EquivalentInterestRateInput {
  /** Annual rate (decimal) quoted in `fromCompounding`. */
  annualInterestRate: number;
  /** REQUIRED source convention. */
  fromCompounding: InterestCompounding;
  /** REQUIRED target convention. */
  toCompounding: InterestCompounding;
}

function requireCompoundingRequired(
  functionName: string,
  field: string,
  compounding: unknown,
): asserts compounding is InterestCompounding {
  if (compounding === undefined) {
    throw new InputError(
      `${functionName}: ${field} is required — a rate conversion never guesses its convention.\n  e.g. ${functionName}({ ...request, ${field}: 'monthly' })`,
      { code: ErrorCode.InputMissingField, context: { field } },
    );
  }
  requireCompoundingWhenPresent(functionName, compounding);
}

/** One-year growth factor of `rate` under `compounding` — the EAR bridge both conversions share. */
function annualGrowthFactor(
  functionName: string,
  rate: number,
  compounding: InterestCompounding,
): number {
  return compoundFactor(rate, 1, compounding);
}

/** Effective annual rate: the one-year growth of the nominal rate under its convention, minus 1. */
export function effectiveAnnualRate(input: EffectiveAnnualRateInput): number {
  requireArgumentObject('effectiveAnnualRate', 'input', input);
  ensureKnownKeys('effectiveAnnualRate', 'input', input, ['nominalAnnualRate', 'compounding']);
  requireFiniteFields('effectiveAnnualRate', input, ['nominalAnnualRate'], {
    exampleCall: "effectiveAnnualRate({ nominalAnnualRate: 0.12, compounding: 'monthly' })",
  });
  requireCompoundingRequired('effectiveAnnualRate', 'compounding', input.compounding);
  return requireRepresentableResult(
    'effectiveAnnualRate',
    annualGrowthFactor('effectiveAnnualRate', input.nominalAnnualRate, input.compounding) - 1,
  );
}

/** Nominal annual rate whose EAR under `compounding` equals the given effective rate. */
export function nominalAnnualRate(input: NominalAnnualRateInput): number {
  requireArgumentObject('nominalAnnualRate', 'input', input);
  ensureKnownKeys('nominalAnnualRate', 'input', input, ['effectiveAnnualRate', 'compounding']);
  requireFiniteFields('nominalAnnualRate', input, ['effectiveAnnualRate'], {
    exampleCall: "nominalAnnualRate({ effectiveAnnualRate: 0.1268, compounding: 'monthly' })",
  });
  requireCompoundingRequired('nominalAnnualRate', 'compounding', input.compounding);
  const growth = 1 + input.effectiveAnnualRate;
  if (growth <= 0) {
    throw new InputError(
      `nominalAnnualRate: effectiveAnnualRate must exceed −100% (the one-year growth factor must be positive). Received ${input.effectiveAnnualRate}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'effectiveAnnualRate' } },
    );
  }
  const periods = compoundingPeriodsPerYear(input.compounding);
  if (periods === null) {
    if (input.compounding === 'continuous') return Math.log(growth);
    return growth - 1; // simple over one year: 1 + r = growth
  }
  return requireRepresentableResult(
    'nominalAnnualRate',
    periods * (Math.pow(growth, 1 / periods) - 1),
  );
}

/** Re-express a rate in another convention so both produce the SAME one-year growth. */
export function equivalentInterestRate(input: EquivalentInterestRateInput): number {
  requireArgumentObject('equivalentInterestRate', 'input', input);
  ensureKnownKeys('equivalentInterestRate', 'input', input, [
    'annualInterestRate',
    'fromCompounding',
    'toCompounding',
  ]);
  requireFiniteFields('equivalentInterestRate', input, ['annualInterestRate'], {
    exampleCall:
      "equivalentInterestRate({ annualInterestRate: 0.12, fromCompounding: 'monthly', toCompounding: 'continuous' })",
  });
  requireCompoundingRequired('equivalentInterestRate', 'fromCompounding', input.fromCompounding);
  requireCompoundingRequired('equivalentInterestRate', 'toCompounding', input.toCompounding);
  const effective =
    annualGrowthFactor('equivalentInterestRate', input.annualInterestRate, input.fromCompounding) -
    1;
  return requireRepresentableResult(
    'equivalentInterestRate',
    nominalAnnualRate({ effectiveAnnualRate: effective, compounding: input.toCompounding }),
  );
}
