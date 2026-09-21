/**
 * The FROZEN cash-flow contracts (FC0, encoded with FC1 — the owner package's first slice) and
 * their boundary guards. One monetary unit per collection; general helpers never infer a time-zero
 * flow; duplicate times/dates aggregate deterministically without mutating input order.
 */

import {
  ensureKnownKeys,
  ErrorCode,
  InputError,
  isoDateToEpochMs,
  requireArgumentArray,
  requireArgumentObject,
} from '@totalfinance/core';

/** One cash flow at a year offset from the valuation instant (`timeYears: 0`). */
export interface TimedCashFlow {
  /** Positive inflow, negative outflow. */
  amount: number;
  /** Years from the valuation instant; `0` IS the valuation instant. */
  timeYears: number;
  label?: string;
}

/** One cash flow on a strict `YYYY-MM-DD` calendar date. */
export interface DatedCashFlow {
  /** Positive inflow, negative outflow. */
  amount: number;
  /** Strict `YYYY-MM-DD` calendar date. */
  cashFlowDate: string;
  label?: string;
}

const TIMED_KEYS = ['amount', 'timeYears', 'label'] as const;
const DATED_KEYS = ['amount', 'cashFlowDate', 'label'] as const;
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

/** Validate one {@link TimedCashFlow} element, naming its index (Law 12 closed request). */
export function requireTimedCashFlow(
  functionName: string,
  flow: TimedCashFlow,
  index: number,
): void {
  requireArgumentObject(functionName, `cashFlows[${index}]`, flow);
  ensureKnownKeys(functionName, `cashFlows[${index}]`, flow, TIMED_KEYS);
  if (typeof flow.amount !== 'number' || !Number.isFinite(flow.amount)) {
    throw new InputError(
      `${functionName}: cashFlows[${index}].amount must be a finite number (positive inflow, negative outflow). Received ${flow.amount === null ? 'null' : typeof flow.amount}.`,
      { code: ErrorCode.InputWrongType, context: { field: `cashFlows[${index}].amount` } },
    );
  }
  if (typeof flow.timeYears !== 'number' || !Number.isFinite(flow.timeYears)) {
    throw new InputError(
      `${functionName}: cashFlows[${index}].timeYears must be a finite number of years (0 is the valuation instant). Received ${flow.timeYears === null ? 'null' : typeof flow.timeYears}.`,
      { code: ErrorCode.InputWrongType, context: { field: `cashFlows[${index}].timeYears` } },
    );
  }
  if (flow.timeYears < 0) {
    // Ordinary discounting is forward-looking; historical flows use the DATED forms with an
    // explicit valuation policy — negative times are never smuggled into pricing helpers.
    throw new InputError(
      `${functionName}: cashFlows[${index}].timeYears must be ≥ 0 — historical flows belong in the dated form (datedNetPresentValue / datedInternalRateOfReturn) with an explicit asOf. Received ${flow.timeYears}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: `cashFlows[${index}].timeYears` } },
    );
  }
  if (flow.label !== undefined && typeof flow.label !== 'string') {
    throw new InputError(
      `${functionName}: cashFlows[${index}].label must be a string when provided. Received ${flow.label === null ? 'null' : typeof flow.label}.`,
      { code: ErrorCode.InputWrongType, context: { field: `cashFlows[${index}].label` } },
    );
  }
}

/** Validate one {@link DatedCashFlow} element, naming its index (Law 12 closed request). */
export function requireDatedCashFlow(
  functionName: string,
  flow: DatedCashFlow,
  index: number,
): void {
  requireArgumentObject(functionName, `cashFlows[${index}]`, flow);
  ensureKnownKeys(functionName, `cashFlows[${index}]`, flow, DATED_KEYS);
  if (typeof flow.amount !== 'number' || !Number.isFinite(flow.amount)) {
    throw new InputError(
      `${functionName}: cashFlows[${index}].amount must be a finite number (positive inflow, negative outflow). Received ${flow.amount === null ? 'null' : typeof flow.amount}.`,
      { code: ErrorCode.InputWrongType, context: { field: `cashFlows[${index}].amount` } },
    );
  }
  if (
    typeof flow.cashFlowDate !== 'string' ||
    !STRICT_DATE.test(flow.cashFlowDate) ||
    !isCalendarDate(flow.cashFlowDate)
  ) {
    throw new InputError(
      `${functionName}: cashFlows[${index}].cashFlowDate must be a strict YYYY-MM-DD calendar date. Received ${flow.cashFlowDate === null ? 'null' : JSON.stringify(flow.cashFlowDate)}.`,
      { code: ErrorCode.InputWrongType, context: { field: `cashFlows[${index}].cashFlowDate` } },
    );
  }
  if (flow.label !== undefined && typeof flow.label !== 'string') {
    throw new InputError(
      `${functionName}: cashFlows[${index}].label must be a string when provided. Received ${flow.label === null ? 'null' : typeof flow.label}.`,
      { code: ErrorCode.InputWrongType, context: { field: `cashFlows[${index}].label` } },
    );
  }
}

/** Validate a non-empty timed collection, every element index-named. */
export function requireTimedCashFlows(
  functionName: string,
  cashFlows: readonly TimedCashFlow[],
): void {
  requireArgumentArray(functionName, 'cashFlows', cashFlows);
  if (cashFlows.length === 0) {
    throw new InputError(`${functionName}: cashFlows must not be empty.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'cashFlows' },
    });
  }
  cashFlows.forEach((flow, index) => requireTimedCashFlow(functionName, flow, index));
}

/** Validate a non-empty dated collection, every element index-named. */
export function requireDatedCashFlows(
  functionName: string,
  cashFlows: readonly DatedCashFlow[],
): void {
  requireArgumentArray(functionName, 'cashFlows', cashFlows);
  if (cashFlows.length === 0) {
    throw new InputError(`${functionName}: cashFlows must not be empty.`, {
      code: ErrorCode.InputOutOfRange,
      context: { field: 'cashFlows' },
    });
  }
  cashFlows.forEach((flow, index) => requireDatedCashFlow(functionName, flow, index));
}
