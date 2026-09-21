/**
 * FC1 — capital budgeting and depreciation. Depreciation helpers require cost, salvage value,
 * useful life, and period; they never infer tax rules.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  type InterestCompounding,
  assertFiniteValue,
  discountFactor,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import { type TimedCashFlow, requireTimedCashFlows } from './flows.js';
import { requireCompoundingWhenPresent } from './discounting.js';
import { netPresentValue } from './discounting.js';

// ---------------------------------------------------------------------------------------------------
// Payback and project comparison
// ---------------------------------------------------------------------------------------------------

/** Input for {@link paybackPeriod}. */
export interface PaybackInput {
  cashFlows: readonly TimedCashFlow[];
}

/**
 * Input for {@link discountedPaybackPeriod}. A separate interface rather than optional fields on
 * {@link PaybackInput}: the discounted head REQUIRES its rate at runtime, and a shared type with
 * `annualDiscountRate?` would license a call the function refuses.
 */
export interface DiscountedPaybackInput {
  cashFlows: readonly TimedCashFlow[];
  /** Annual rate (decimal). */
  annualDiscountRate: number;
  /** Default `'annual'` — documented and echoed. */
  compounding?: InterestCompounding;
}

function paybackYears(
  functionName: string,
  flows: readonly { amount: number; timeYears: number }[],
): number | null {
  const ordered = [...flows].sort((a, b) => a.timeYears - b.timeYears);
  let cumulative = 0;
  let previousTime = 0;
  for (const flow of ordered) {
    const before = cumulative;
    cumulative += flow.amount;
    if (before < 0 && cumulative >= 0) {
      // Linear interpolation inside the recovering flow's interval.
      const fraction = flow.amount === 0 ? 0 : -before / flow.amount;
      return previousTime + (flow.timeYears - previousTime) * fraction;
    }
    previousTime = flow.timeYears;
  }
  return null; // never recovers
}

/**
 * Years until cumulative cash flow first reaches zero (linear interpolation within the
 * recovering interval), or `null` when the outlay is never recovered.
 */
export function paybackPeriod(input: PaybackInput): number | null {
  requireArgumentObject('paybackPeriod', 'input', input);
  ensureKnownKeys('paybackPeriod', 'input', input, ['cashFlows']);
  requireTimedCashFlows('paybackPeriod', input.cashFlows);
  return paybackYears('paybackPeriod', input.cashFlows);
}

/** {@link paybackPeriod} on DISCOUNTED flows — the recovery clock respects the time value. */
export function discountedPaybackPeriod(input: DiscountedPaybackInput): number | null {
  requireArgumentObject('discountedPaybackPeriod', 'input', input);
  ensureKnownKeys('discountedPaybackPeriod', 'input', input, [
    'cashFlows',
    'annualDiscountRate',
    'compounding',
  ]);
  requireFiniteFields('discountedPaybackPeriod', input, ['annualDiscountRate'], {
    exampleCall:
      'discountedPaybackPeriod({ cashFlows: [{ amount: -1_000, timeYears: 0 }, { amount: 600, timeYears: 1 }, { amount: 600, timeYears: 2 }], annualDiscountRate: 0.1 })',
  });
  requireTimedCashFlows('discountedPaybackPeriod', input.cashFlows);
  requireCompoundingWhenPresent('discountedPaybackPeriod', input.compounding);
  const compounding = input.compounding ?? 'annual';
  const discounted = input.cashFlows.map((flow) => ({
    amount: flow.amount * discountFactor(input.annualDiscountRate, flow.timeYears, compounding),
    timeYears: flow.timeYears,
  }));
  return paybackYears('discountedPaybackPeriod', discounted);
}

/** Input for {@link profitabilityIndex}. */
export interface ProfitabilityIndexInput {
  cashFlows: readonly TimedCashFlow[];
  annualDiscountRate: number;
  /** Default `'annual'`. */
  compounding?: InterestCompounding;
}

/**
 * PV of the positive flows ÷ PV of the outlays (positive magnitude): > 1 means value-creating at
 * the discount rate.
 */
export function profitabilityIndex(input: ProfitabilityIndexInput): number {
  requireArgumentObject('profitabilityIndex', 'input', input);
  ensureKnownKeys('profitabilityIndex', 'input', input, [
    'cashFlows',
    'annualDiscountRate',
    'compounding',
  ]);
  requireFiniteFields('profitabilityIndex', input, ['annualDiscountRate'], {
    exampleCall:
      'profitabilityIndex({ cashFlows: [{ amount: -1_000, timeYears: 0 }, { amount: 700, timeYears: 1 }, { amount: 700, timeYears: 2 }], annualDiscountRate: 0.1 })',
  });
  requireTimedCashFlows('profitabilityIndex', input.cashFlows);
  requireCompoundingWhenPresent('profitabilityIndex', input.compounding);
  const compounding = input.compounding ?? 'annual';
  let inflowPresent = 0;
  let outlayPresent = 0;
  for (const flow of input.cashFlows) {
    const value =
      flow.amount * discountFactor(input.annualDiscountRate, flow.timeYears, compounding);
    if (value >= 0) inflowPresent += value;
    else outlayPresent += -value;
  }
  if (outlayPresent === 0) {
    throw new InputError(
      'profitabilityIndex: at least one outlay (negative flow) is required — with no investment there is no index.',
      { code: ErrorCode.InputOutOfRange, context: { field: 'cashFlows' } },
    );
  }
  return requireRepresentableResult('profitabilityIndex', inflowPresent / outlayPresent);
}

/** Input for {@link equivalentAnnualAnnuity}. */
export interface EquivalentAnnualAnnuityInput {
  cashFlows: readonly TimedCashFlow[];
  annualDiscountRate: number;
  /** Project length in years (the annuity horizon). */
  projectLifeYears: number;
  /** Default `'annual'`. */
  compounding?: InterestCompounding;
}

/**
 * The level annual amount whose PV over `projectLifeYears` equals the project NPV — the standard
 * yardstick for comparing projects of unequal length. The annuity factor honors the SAME declared
 * `compounding` convention the NPV used: it is `Σ discountFactor(rate, t, compounding)` over the
 * integer payment years `t = 1..projectLifeYears`, so discounting the returned annuity back over
 * the project life under that convention recovers the NPV exactly. (Under `'annual'` the sum
 * equals the classic closed-form annuity factor `(1 − (1 + r)^−L) / r`.)
 */
export function equivalentAnnualAnnuity(input: EquivalentAnnualAnnuityInput): number {
  requireArgumentObject('equivalentAnnualAnnuity', 'input', input);
  ensureKnownKeys('equivalentAnnualAnnuity', 'input', input, [
    'cashFlows',
    'annualDiscountRate',
    'projectLifeYears',
    'compounding',
  ]);
  requireFiniteFields(
    'equivalentAnnualAnnuity',
    input,
    ['annualDiscountRate', 'projectLifeYears'],
    {
      exampleCall:
        'equivalentAnnualAnnuity({ cashFlows: [{ amount: -1_000, timeYears: 0 }, { amount: 700, timeYears: 1 }], annualDiscountRate: 0.1, projectLifeYears: 1 })',
    },
  );
  requireTimedCashFlows('equivalentAnnualAnnuity', input.cashFlows);
  requireCompoundingWhenPresent('equivalentAnnualAnnuity', input.compounding);
  // Safe integer + a practical bound (2026-08-23 review wave): this horizon drives the annuity-
  // factor loop one year at a time, so an unsafe "integer" like 2^53 is a non-terminating loop and
  // 1e308 is a request for effectively infinite work. 100,000 years is beyond any project's life;
  // nothing real is refused.
  if (
    !Number.isSafeInteger(input.projectLifeYears) ||
    input.projectLifeYears < 1 ||
    input.projectLifeYears > 100_000
  ) {
    throw new InputError(
      `equivalentAnnualAnnuity: projectLifeYears must be an integer in [1, 100_000] (annual annuity horizon). Received ${input.projectLifeYears}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'projectLifeYears' } },
    );
  }
  const value = netPresentValue({
    cashFlows: input.cashFlows,
    annualDiscountRate: input.annualDiscountRate,
    ...(input.compounding !== undefined ? { compounding: input.compounding } : {}),
  });
  // The annuity factor under the SAME convention the NPV honored — never a hardcoded annual form:
  // Σ discountFactor(rate, t, compounding) over the integer payment years, so that
  // EAA × Σ df(t) = NPV exactly under the declared convention. (At rate 0 every factor is 1 and
  // the sum is projectLifeYears; under 'annual' the sum equals (1 − (1 + r)^−L) / r.)
  const compounding = input.compounding ?? 'annual';
  let annuityFactor = 0;
  for (let year = 1; year <= input.projectLifeYears; year++) {
    annuityFactor += discountFactor(input.annualDiscountRate, year, compounding);
  }
  const annuity = value / annuityFactor;
  // Law 7: a finite-input overflow must never leave here as a successful non-finite value.
  assertFiniteValue('equivalentAnnualAnnuity', annuity);
  return annuity;
}

// ---------------------------------------------------------------------------------------------------
// Depreciation — cost, salvage, life, period; never inferred tax rules
// ---------------------------------------------------------------------------------------------------

/** The explicit depreciation coordinates every method requires. */
export interface DepreciationInput {
  /** Acquisition cost (positive). */
  cost: number;
  /** Salvage (residual) value at the end of useful life; 0 ≤ salvage < cost. */
  salvageValue: number;
  /** Useful life in whole periods (≥ 1). */
  usefulLifePeriods: number;
  /** 1-based period being asked about. */
  period: number;
}

const DEPRECIATION_KEYS = ['cost', 'salvageValue', 'usefulLifePeriods', 'period'] as const;

/** Declining-balance adds its explicit rate multiplier. */
export interface DecliningBalanceInput extends DepreciationInput {
  /** The declining-balance factor (e.g. `1.5`); double-declining uses its own head. */
  factor: number;
}

function validateDepreciation(
  functionName: string,
  input: DepreciationInput,
  extraKeys: readonly string[] = [],
): void {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, [...DEPRECIATION_KEYS, ...extraKeys]);
  requireFiniteFields(
    functionName,
    input,
    ['cost', 'salvageValue', 'usefulLifePeriods', 'period'],
    {
      exampleCall: `${functionName}({ cost: 10_000, salvageValue: 1_000, usefulLifePeriods: 5, period: 2 })`,
    },
  );
  if (input.cost <= 0) {
    throw new InputError(`${functionName}: cost must be > 0. Received ${input.cost}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'cost' },
    });
  }
  if (input.salvageValue < 0 || input.salvageValue >= input.cost) {
    throw new InputError(
      `${functionName}: salvageValue must satisfy 0 ≤ salvageValue < cost. Received ${input.salvageValue}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'salvageValue' } },
    );
  }
  // Safe integer + a practical bound (2026-08-23 review wave): `Number.isInteger(1e308)` is
  // true, and above 2^53 a period counter stops advancing — an unsafe "integer" here is a
  // non-terminating declining-balance loop, not a long depreciation schedule. 100,000 periods is
  // monthly depreciation for 8,333 years; nothing real is refused.
  if (
    !Number.isSafeInteger(input.usefulLifePeriods) ||
    input.usefulLifePeriods < 1 ||
    input.usefulLifePeriods > 100_000
  ) {
    throw new InputError(
      `${functionName}: usefulLifePeriods must be an integer in [1, 100_000]. Received ${input.usefulLifePeriods}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'usefulLifePeriods' } },
    );
  }
  if (
    !Number.isSafeInteger(input.period) ||
    input.period < 1 ||
    input.period > input.usefulLifePeriods
  ) {
    throw new InputError(
      `${functionName}: period must be an integer in [1, usefulLifePeriods]. Received ${input.period}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'period' } },
    );
  }
}

/** Straight-line: the same charge every period, `(cost − salvage) / life`. */
export function straightLineDepreciation(input: DepreciationInput): number {
  validateDepreciation('straightLineDepreciation', input);
  return (input.cost - input.salvageValue) / input.usefulLifePeriods;
}

/** Declining-balance charge in `period` at the explicit `factor`, floored at salvage. */
export function decliningBalanceDepreciation(input: DecliningBalanceInput): number {
  validateDepreciation('decliningBalanceDepreciation', input, ['factor']);
  if (typeof input.factor !== 'number' || !Number.isFinite(input.factor) || input.factor <= 0) {
    throw new InputError(
      `decliningBalanceDepreciation: factor must be a finite number > 0 (e.g. 1.5). Received ${input.factor === null ? 'null' : String(input.factor)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'factor' } },
    );
  }
  const rate = input.factor / input.usefulLifePeriods;
  let bookValue = input.cost;
  let charge = 0;
  for (let currentPeriod = 1; currentPeriod <= input.period; currentPeriod++) {
    charge = Math.min(bookValue * rate, bookValue - input.salvageValue);
    if (charge < 0) charge = 0;
    bookValue -= charge;
  }
  return charge;
}

/** Double-declining balance: {@link decliningBalanceDepreciation} at factor 2. */
export function doubleDecliningBalanceDepreciation(input: DepreciationInput): number {
  validateDepreciation('doubleDecliningBalanceDepreciation', input);
  return decliningBalanceDepreciation({ ...input, factor: 2 });
}

/** Sum-of-years'-digits charge in `period`: `(cost − salvage) · remainingLife / Σ digits`. */
export function sumOfYearsDigitsDepreciation(input: DepreciationInput): number {
  validateDepreciation('sumOfYearsDigitsDepreciation', input);
  const life = input.usefulLifePeriods;
  const digitsSum = (life * (life + 1)) / 2;
  const remaining = life - input.period + 1;
  // Ratio first: `remaining / digitsSum` ≤ 1, so the charge can never overflow past the
  // depreciable base — `(base · remaining)` CAN, at near-MAX costs, and the true charge is
  // always representable (2026-08-23 review wave).
  return (input.cost - input.salvageValue) * (remaining / digitsSum);
}
