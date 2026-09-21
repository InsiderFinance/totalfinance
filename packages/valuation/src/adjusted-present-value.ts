/**
 * FC2 — adjusted present value (APV).
 *
 * Required semantics (spec, frozen): APV SEPARATES the unlevered operating value from each
 * financing side effect and their assumptions — the whole point of the method is that the
 * operating business and the financing consequences are discounted at rates that reflect their
 * own risk, and the decomposition is reported, never collapsed. Every side effect is labeled,
 * carries its own discount rate, and is echoed with its present value; the one compounding
 * convention covers every leg and is echoed.
 */

import {
  requireRepresentableResult,
  stableSum,
  ErrorCode,
  InputError,
  type InterestCompounding,
  discountFactor,
  ensureKnownKeys,
  requireArgumentArray,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import { type TimedCashFlow, requireTimedCashFlows } from './flows.js';
import { requireCompoundingWhenPresent } from './discounting.js';

/** One financing side effect: a labeled stream discounted at ITS OWN rate. */
export interface FinancingSideEffect {
  /** What this side effect IS (e.g. `'interest tax shield'`, `'issuance costs'`). */
  label: string;
  cashFlows: readonly TimedCashFlow[];
  /** Annual rate (decimal) reflecting THIS side effect's risk — never inherited silently. */
  annualDiscountRate: number;
}

/** Input for {@link adjustedPresentValue}. */
export interface AdjustedPresentValueInput {
  /** The unlevered (all-equity) operating cash flows, `timeYears: 0` being the valuation instant. */
  unleveredCashFlows: readonly TimedCashFlow[];
  /** Annual rate (decimal, > −1) for the UNLEVERED operating flows. */
  unleveredCostOfCapital: number;
  /** May be empty — "no side effects" is an explicit statement, not an omission. */
  financingSideEffects: readonly FinancingSideEffect[];
  /** Default `'annual'` — documented and echoed in `assumptions.compounding`. */
  compounding?: InterestCompounding;
}

/** One side effect echoed with its present value — the decomposition the method exists for. */
export interface FinancingSideEffectValue {
  label: string;
  presentValue: number;
  annualDiscountRate: number;
}

/** Result of {@link adjustedPresentValue}: the decomposition plus the echoed assumptions. */
export interface AdjustedPresentValueResult {
  diagnostics: { warnings: string[] };
  /** `unleveredValue + Σ side-effect present values`. */
  adjustedPresentValue: number;
  /** Present value of the unlevered operating flows at `unleveredCostOfCapital`. */
  unleveredValue: number;
  /** Each side effect's present value at ITS OWN rate, in input order. */
  financingSideEffects: FinancingSideEffectValue[];
  assumptions: {
    unleveredCostOfCapital: number;
    /** The one compounding convention every leg was discounted under. */
    compounding: InterestCompounding;
    sideEffectCount: number;
  };
}

const INPUT_KEYS = [
  'unleveredCashFlows',
  'unleveredCostOfCapital',
  'financingSideEffects',
  'compounding',
] as const;

const SIDE_EFFECT_KEYS = ['label', 'cashFlows', 'annualDiscountRate'] as const;

const EXAMPLE_CALL =
  "adjustedPresentValue({ unleveredCashFlows: [{ amount: 100, timeYears: 1 }, { amount: 110, timeYears: 2 }], unleveredCostOfCapital: 0.1, financingSideEffects: [{ label: 'interest tax shield', cashFlows: [{ amount: 8, timeYears: 1 }], annualDiscountRate: 0.05 }] })";

function requireRateAboveFloor(functionName: string, field: string, rate: number): void {
  if (rate <= -1) {
    throw new InputError(
      `${functionName}: ${field} must exceed −100% per year (an annual decimal, e.g. 0.1 for 10%) — at or below −100% the growth factor is not positive. Received ${rate}.`,
      { code: ErrorCode.InputOutOfRange, context: { field } },
    );
  }
}

function presentValueOfFlows(
  cashFlows: readonly TimedCashFlow[],
  annualRate: number,
  compounding: InterestCompounding,
): number {
  return stableSum(
    cashFlows.map((flow) => flow.amount * discountFactor(annualRate, flow.timeYears, compounding)),
  );
}

/**
 * Adjusted present value: the unlevered operating value at the unlevered cost of capital PLUS the
 * present value of each financing side effect at its own declared rate. The decomposition is the
 * result — nothing is netted away silently.
 */
export function adjustedPresentValue(input: AdjustedPresentValueInput): AdjustedPresentValueResult {
  const functionName = 'adjustedPresentValue';
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  requireFiniteFields(functionName, input, ['unleveredCostOfCapital'], {
    exampleCall: EXAMPLE_CALL,
    hints: { unleveredCostOfCapital: 'an annual decimal — 0.1 means 10%, not 10' },
  });
  requireRateAboveFloor(functionName, 'unleveredCostOfCapital', input.unleveredCostOfCapital);
  // The shared flow guards name their collection `cashFlows[i]`; the parenthetical names WHICH
  // collection in this two-collection request, so the error still points at one field.
  requireTimedCashFlows(`${functionName} (field unleveredCashFlows)`, input.unleveredCashFlows);
  requireCompoundingWhenPresent(functionName, input.compounding);
  requireArgumentArray(functionName, 'financingSideEffects', input.financingSideEffects);
  input.financingSideEffects.forEach((sideEffect, index) => {
    requireArgumentObject(functionName, `financingSideEffects[${index}]`, sideEffect);
    ensureKnownKeys(functionName, `financingSideEffects[${index}]`, sideEffect, SIDE_EFFECT_KEYS);
    if (typeof sideEffect.label !== 'string' || sideEffect.label.length === 0) {
      throw new InputError(
        `${functionName}: financingSideEffects[${index}].label must be a non-empty string — an unlabeled side effect cannot be audited in the decomposition. Received ${sideEffect.label === null ? 'null' : typeof sideEffect.label === 'string' ? "''" : typeof sideEffect.label}. e.g. ${EXAMPLE_CALL}`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: `financingSideEffects[${index}].label` },
        },
      );
    }
    requireFiniteFields(functionName, sideEffect, ['annualDiscountRate'], {
      exampleCall: EXAMPLE_CALL,
      path: `financingSideEffects[${index}]`,
    });
    requireRateAboveFloor(
      functionName,
      `financingSideEffects[${index}].annualDiscountRate`,
      sideEffect.annualDiscountRate,
    );
    requireTimedCashFlows(
      `${functionName} (field financingSideEffects[${index}].cashFlows)`,
      sideEffect.cashFlows,
    );
  });

  const compounding = input.compounding ?? 'annual';
  const unleveredValue = presentValueOfFlows(
    input.unleveredCashFlows,
    input.unleveredCostOfCapital,
    compounding,
  );
  const financingSideEffects: FinancingSideEffectValue[] = input.financingSideEffects.map(
    (sideEffect) => ({
      label: sideEffect.label,
      presentValue: presentValueOfFlows(
        sideEffect.cashFlows,
        sideEffect.annualDiscountRate,
        compounding,
      ),
      annualDiscountRate: sideEffect.annualDiscountRate,
    }),
  );
  const sideEffectTotal = stableSum(
    financingSideEffects.map((sideEffect) => sideEffect.presentValue),
  );

  return requireRepresentableResult('adjustedPresentValue', {
    diagnostics: { warnings: [] },
    adjustedPresentValue: stableSum([unleveredValue, sideEffectTotal]),
    unleveredValue,
    financingSideEffects,
    assumptions: {
      unleveredCostOfCapital: input.unleveredCostOfCapital,
      compounding,
      sideEffectCount: input.financingSideEffects.length,
    },
  });
}
