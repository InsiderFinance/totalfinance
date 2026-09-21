/**
 * FC1 — return solvers. The plain call returns `number | null` and NEVER chooses among multiple
 * economically admissible roots silently: `null` means "no root" or "ambiguous — read the
 * report". `.explain()` reports convergence, the bracket/search range, iterations, EVERY
 * admissible root found, and an ambiguity warning; callers select an explicit root from it.
 */

import {
  requireRepresentableResult,
  compoundFactor,
  CONVENTIONS_VERSION,
  type DayCount,
  discountFactor,
  ensureKnownKeys,
  ErrorCode,
  InputError,
  type InterestCompounding,
  isoDateToEpochMs,
  type QuantWarning,
  requireArgumentObject,
  requireFiniteFields,
  WarningCode,
  yearFraction,
} from '@totalfinance/core';
import {
  type DatedCashFlow,
  type TimedCashFlow,
  requireDatedCashFlows,
  requireTimedCashFlows,
} from './flows.js';
import { requireCompoundingWhenPresent, requireDayCountWhenPresent } from './discounting.js';

/** The admissible-rate floor: below −100% a periodic growth factor is not positive. */
const RATE_FLOOR = -0.999999;
const RATE_CEILING = 10; // 1,000% — beyond this an "IRR" is numerics, not economics
const SCAN_STEPS = 400;
const BISECTION_TOLERANCE = 1e-12;
const MAX_ITERATIONS = 200;

/** One admissible root with the residual NPV at that rate (≈ 0 by construction). */
export interface InternalRateRoot {
  annualRate: number;
  residualNetPresentValue: number;
}

/** The `.explain()` report shared by the IRR family (Law 2 envelope). */
export interface InternalRateOfReturnReport {
  assumptions: {
    conventionsVersion: string;
    compounding: InterestCompounding;
    /** Present only on the dated head. */
    dayCount?: DayCount;
    /** Present only on the dated head. */
    asOf?: string;
    searchRange: { from: number; to: number };
  };
  diagnostics: {
    method: 'scan-bisect';
    converged: boolean;
    iterations: number;
    warnings: QuantWarning[];
  };
  /** The plain call's answer: the single root, or null when none or many. */
  value: number | null;
  /** EVERY economically admissible root found in the search range. */
  roots: InternalRateRoot[];
}

interface SolveOutcome {
  roots: InternalRateRoot[];
  iterations: number;
  signChanges: number;
}

/** Scan the admissible range for sign changes, then bisect each to a root. */
function solveRoots(net: (rate: number) => number): SolveOutcome {
  const roots: InternalRateRoot[] = [];
  let iterations = 0;
  let signChanges = 0;
  let previousRate = RATE_FLOOR;
  let previousValue = net(previousRate);
  for (let step = 1; step <= SCAN_STEPS; step++) {
    const rate = RATE_FLOOR + ((RATE_CEILING - RATE_FLOOR) * step) / SCAN_STEPS;
    const value = net(rate);
    iterations++;
    if (previousValue === 0) {
      roots.push({ annualRate: previousRate, residualNetPresentValue: 0 });
      signChanges++;
    } else if (
      Number.isFinite(previousValue) &&
      Number.isFinite(value) &&
      previousValue * value < 0
    ) {
      signChanges++;
      let lowRate = previousRate;
      let highRate = rate;
      let lowValue = previousValue;
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        iterations++;
        const midRate = (lowRate + highRate) / 2;
        const midValue = net(midRate);
        if (Math.abs(midValue) < BISECTION_TOLERANCE || highRate - lowRate < BISECTION_TOLERANCE) {
          roots.push({ annualRate: midRate, residualNetPresentValue: midValue });
          break;
        }
        if (lowValue * midValue < 0) {
          highRate = midRate;
        } else {
          lowRate = midRate;
          lowValue = midValue;
        }
      }
    }
    previousRate = rate;
    previousValue = value;
  }
  // Deduplicate near-identical roots from adjacent scan cells.
  const deduped: InternalRateRoot[] = [];
  for (const root of roots) {
    if (!deduped.some((existing) => Math.abs(existing.annualRate - root.annualRate) < 1e-9)) {
      deduped.push(root);
    }
  }
  return { roots: deduped, iterations, signChanges };
}

function buildReport(
  compounding: InterestCompounding,
  outcome: SolveOutcome,
  extras: { dayCount?: DayCount; asOf?: string },
): InternalRateOfReturnReport {
  const warnings: QuantWarning[] = [];
  if (outcome.roots.length > 1) {
    warnings.push({
      code: WarningCode.DegenerateInput,
      message: `multiple economically admissible internal rates exist (${outcome.roots.length}) — the plain call returns null; select an explicit root from this report.`,
      severity: 'warn',
      context: { roots: outcome.roots.map((root) => root.annualRate) },
    });
  }
  if (outcome.roots.length === 0) {
    warnings.push({
      code: WarningCode.DegenerateInput,
      message:
        'no internal rate exists in the admissible search range — the NPV never crosses zero.',
      severity: 'warn',
      context: { searchRange: { from: RATE_FLOOR, to: RATE_CEILING } },
    });
  }
  return {
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      compounding,
      ...(extras.dayCount !== undefined ? { dayCount: extras.dayCount } : {}),
      ...(extras.asOf !== undefined ? { asOf: extras.asOf } : {}),
      searchRange: { from: RATE_FLOOR, to: RATE_CEILING },
    },
    diagnostics: {
      method: 'scan-bisect',
      converged: outcome.roots.length > 0,
      iterations: outcome.iterations,
      warnings,
    },
    value: outcome.roots.length === 1 ? outcome.roots[0]!.annualRate : null,
    roots: outcome.roots,
  };
}

// ---------------------------------------------------------------------------------------------------
// internalRateOfReturn
// ---------------------------------------------------------------------------------------------------

/** Input for {@link internalRateOfReturn}. */
export interface InternalRateOfReturnInput {
  cashFlows: readonly TimedCashFlow[];
  /** Default `'annual'` — documented and echoed in `.explain()`. */
  compounding?: InterestCompounding;
}

const IRR_KEYS = ['cashFlows', 'compounding'] as const;

function validateIrrInput(
  functionName: string,
  input: InternalRateOfReturnInput,
): InterestCompounding {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, IRR_KEYS);
  requireTimedCashFlows(functionName, input.cashFlows);
  requireCompoundingWhenPresent(functionName, input.compounding);
  const hasPositive = input.cashFlows.some((flow) => flow.amount > 0);
  const hasNegative = input.cashFlows.some((flow) => flow.amount < 0);
  if (!hasPositive || !hasNegative) {
    throw new InputError(
      `${functionName}: an internal rate needs at least one inflow AND one outflow — all-one-sign cash flows have no crossing NPV.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'cashFlows' } },
    );
  }
  return input.compounding ?? 'annual';
}

function explainInternalRateOfReturn(input: InternalRateOfReturnInput): InternalRateOfReturnReport {
  const compounding = validateIrrInput('internalRateOfReturn.explain', input);
  const outcome = solveRoots((rate) => {
    let total = 0;
    for (const flow of input.cashFlows) {
      total += flow.amount * discountFactor(rate, flow.timeYears, compounding);
    }
    return total;
  });
  return buildReport(compounding, outcome, {});
}

/**
 * The internal rate of return of explicit timed flows, or `null` when no admissible root exists
 * or MORE THAN ONE does — an ambiguous IRR is never chosen silently. `.explain()` carries every
 * root and the ambiguity warning.
 */
export const internalRateOfReturn = Object.assign(
  (input: InternalRateOfReturnInput): number | null => {
    const compounding = validateIrrInput('internalRateOfReturn', input);
    const outcome = solveRoots((rate) => {
      let total = 0;
      for (const flow of input.cashFlows) {
        total += flow.amount * discountFactor(rate, flow.timeYears, compounding);
      }
      return total;
    });
    return outcome.roots.length === 1 ? outcome.roots[0]!.annualRate : null;
  },
  { explain: explainInternalRateOfReturn },
);

// ---------------------------------------------------------------------------------------------------
// datedInternalRateOfReturn
// ---------------------------------------------------------------------------------------------------

/** Input for {@link datedInternalRateOfReturn}. */
export interface DatedInternalRateOfReturnInput {
  cashFlows: readonly DatedCashFlow[];
  /** Strict `YYYY-MM-DD` valuation date; flows before it ACCUMULATE forward, never drop. */
  asOf: string;
  /** Default `'annual'` — documented and echoed in `.explain()`. */
  compounding?: InterestCompounding;
  /** Default `'ACT/365F'` — documented and echoed in `.explain()`. */
  dayCount?: DayCount;
}

const DATED_IRR_KEYS = ['cashFlows', 'asOf', 'compounding', 'dayCount'] as const;
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

function validateDatedIrrInput(
  functionName: string,
  input: DatedInternalRateOfReturnInput,
): { compounding: InterestCompounding; dayCount: DayCount } {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, DATED_IRR_KEYS);
  requireDatedCashFlows(functionName, input.cashFlows);
  if (
    typeof input.asOf !== 'string' ||
    !STRICT_DATE.test(input.asOf) ||
    !isCalendarDate(input.asOf)
  ) {
    throw new InputError(
      `${functionName}: asOf must be a strict YYYY-MM-DD calendar date. Received ${input.asOf === null ? 'null' : JSON.stringify(input.asOf)}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'asOf' } },
    );
  }
  requireCompoundingWhenPresent(functionName, input.compounding);
  requireDayCountWhenPresent(functionName, input.dayCount);
  const hasPositive = input.cashFlows.some((flow) => flow.amount > 0);
  const hasNegative = input.cashFlows.some((flow) => flow.amount < 0);
  if (!hasPositive || !hasNegative) {
    throw new InputError(
      `${functionName}: an internal rate needs at least one inflow AND one outflow — all-one-sign cash flows have no crossing NPV.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'cashFlows' } },
    );
  }
  return { compounding: input.compounding ?? 'annual', dayCount: input.dayCount ?? 'ACT/365F' };
}

function datedNet(
  input: DatedInternalRateOfReturnInput,
  compounding: InterestCompounding,
  dayCount: DayCount,
): (rate: number) => number {
  const offsets = input.cashFlows.map((flow) =>
    yearFraction(input.asOf, flow.cashFlowDate, dayCount),
  );
  return (rate) => {
    let total = 0;
    for (let i = 0; i < input.cashFlows.length; i++) {
      const years = offsets[i]!;
      total +=
        years >= 0
          ? input.cashFlows[i]!.amount * discountFactor(rate, years, compounding)
          : input.cashFlows[i]!.amount * compoundFactor(rate, -years, compounding);
    }
    return total;
  };
}

function explainDatedInternalRateOfReturn(
  input: DatedInternalRateOfReturnInput,
): InternalRateOfReturnReport {
  const { compounding, dayCount } = validateDatedIrrInput(
    'datedInternalRateOfReturn.explain',
    input,
  );
  const outcome = solveRoots(datedNet(input, compounding, dayCount));
  return buildReport(compounding, outcome, { dayCount, asOf: input.asOf });
}

/**
 * The dated internal rate of return AT `asOf` — historical flows accumulate forward, future
 * flows discount back, under one declared convention. `null` on no root or ambiguity;
 * `.explain()` carries every root.
 */
export const datedInternalRateOfReturn = Object.assign(
  (input: DatedInternalRateOfReturnInput): number | null => {
    const { compounding, dayCount } = validateDatedIrrInput('datedInternalRateOfReturn', input);
    const outcome = solveRoots(datedNet(input, compounding, dayCount));
    return outcome.roots.length === 1 ? outcome.roots[0]!.annualRate : null;
  },
  { explain: explainDatedInternalRateOfReturn },
);

// ---------------------------------------------------------------------------------------------------
// modifiedInternalRateOfReturn
// ---------------------------------------------------------------------------------------------------

/** Input for {@link modifiedInternalRateOfReturn}. */
export interface ModifiedInternalRateOfReturnInput {
  cashFlows: readonly TimedCashFlow[];
  /** Annual rate financing the negative flows (decimal). */
  financeRate: number;
  /** Annual rate reinvesting the positive flows (decimal). */
  reinvestmentRate: number;
  /** Default `'annual'` — documented and echoed. */
  compounding?: InterestCompounding;
}

const MIRR_KEYS = ['cashFlows', 'financeRate', 'reinvestmentRate', 'compounding'] as const;

/**
 * Modified IRR: negative flows discount to time zero at `financeRate`; positive flows compound to
 * the horizon at `reinvestmentRate`; the MIRR is the single rate equating them over the horizon.
 * Deterministic — no root ambiguity exists, so the plain call returns a number.
 */
export function modifiedInternalRateOfReturn(input: ModifiedInternalRateOfReturnInput): number {
  requireArgumentObject('modifiedInternalRateOfReturn', 'input', input);
  ensureKnownKeys('modifiedInternalRateOfReturn', 'input', input, MIRR_KEYS);
  requireFiniteFields('modifiedInternalRateOfReturn', input, ['financeRate', 'reinvestmentRate'], {
    exampleCall:
      'modifiedInternalRateOfReturn({ cashFlows: [{ amount: -1_000, timeYears: 0 }, { amount: 600, timeYears: 1 }, { amount: 600, timeYears: 2 }], financeRate: 0.08, reinvestmentRate: 0.05 })',
  });
  requireTimedCashFlows('modifiedInternalRateOfReturn', input.cashFlows);
  requireCompoundingWhenPresent('modifiedInternalRateOfReturn', input.compounding);
  const compounding = input.compounding ?? 'annual';
  const horizon = Math.max(...input.cashFlows.map((flow) => flow.timeYears));
  if (horizon <= 0) {
    throw new InputError(
      'modifiedInternalRateOfReturn: the latest cash flow must be after time zero — a zero-length horizon has no periodic return.',
      { code: ErrorCode.InputOutOfRange, context: { field: 'cashFlows' } },
    );
  }
  let financedPresent = 0;
  let reinvestedTerminal = 0;
  for (const flow of input.cashFlows) {
    if (flow.amount < 0) {
      financedPresent +=
        -flow.amount * discountFactor(input.financeRate, flow.timeYears, compounding);
    } else if (flow.amount > 0) {
      reinvestedTerminal +=
        flow.amount * compoundFactor(input.reinvestmentRate, horizon - flow.timeYears, compounding);
    }
  }
  if (financedPresent === 0 || reinvestedTerminal === 0) {
    throw new InputError(
      'modifiedInternalRateOfReturn: needs at least one negative AND one positive cash flow.',
      { code: ErrorCode.InputOutOfRange, context: { field: 'cashFlows' } },
    );
  }
  return requireRepresentableResult(
    'modifiedInternalRateOfReturn',
    Math.pow(reinvestedTerminal / financedPresent, 1 / horizon) - 1,
  );
}
