/**
 * FC2 — the direct DCF analysis and its deterministic companions. One law above all: FCFF
 * produces ENTERPRISE value and FCFE produces EQUITY value, and the result never relabels one as
 * the other. Bridge fields are never silently zeroed — no bridge, no equity value; no shares, no
 * per-share value; each absence carries its reason.
 */

import {
  requireRepresentableResult,
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
import { requireCompoundingWhenPresent, requireDayCountWhenPresent } from './discounting.js';
import {
  type EnterpriseToEquityBridge,
  type TerminalValueMethod,
  enterpriseToEquityValue,
  requireEnterpriseToEquityBridge,
  requireTerminalValueMethod,
  terminalValue,
} from './corporate-primitives.js';

// ---------------------------------------------------------------------------------------------------
// Closed field contracts
// ---------------------------------------------------------------------------------------------------

/** Caller-supplied provenance, echoed verbatim — a closed contract, not a bag. */
export interface ValuationProvenance {
  /** Which forecast produced the projected flows (an id, label, or file reference). */
  forecastIdentity?: string;
  /** Which statement set (accession or label) grounded the analysis. */
  statementIdentity?: string;
  /** Which restatement version, when that distinction matters. */
  restatementIdentity?: string;
  /** Who or what prepared the inputs. */
  source?: string;
}

const PROVENANCE_KEYS = [
  'forecastIdentity',
  'statementIdentity',
  'restatementIdentity',
  'source',
] as const;

/** Every assumption the valuation rests on — closed and versioned. */
export interface DiscountedCashFlowAssumptions {
  /** The version of THIS assumptions contract. */
  contractVersion: 1;
  modelVersion: 1;
  valuationDate: string;
  currency: string;
  valuationBasis: 'firm' | 'equity';
  annualDiscountRate: number;
  /** Where the discount rate came from. This analysis never derives one: always user-supplied. */
  discountRateSource: 'user-supplied';
  compounding: InterestCompounding;
  dayCount: DayCount;
  terminalValueMethod: TerminalValueMethod;
  /** The perpetuity convention: the stated terminal flow is the FINAL forecast-period flow. */
  terminalCashFlowConvention: 'final-forecast-period-flow';
  /** How the equity bridge was decided. */
  bridgeDecision:
    | 'bridge-supplied'
    | 'no-bridge-supplied-equity-value-absent'
    | 'equity-basis-no-bridge-applicable';
  /** How the per-share denominator was decided. */
  shareCountDecision: 'diluted-shares-supplied' | 'no-shares-supplied-per-share-absent';
}

/** Diagnostics the valuation discloses — closed and versioned alongside the assumptions. */
export interface DiscountedCashFlowDiagnostics {
  projectedPeriodCount: number;
  /** Terminal value's share of the TOTAL present value — the classic sanity number. */
  terminalValueShareOfValue: number;
  warnings: string[];
  /** Inputs deliberately not used, each with the reason (empty when everything participated). */
  exclusions: string[];
}

/** One discounted projection row. */
export interface DiscountedProjectedCashFlowRow {
  cashFlowDate?: string;
  timeYears: number;
  cashFlowAmount: number;
  discountFactor: number;
  presentValue: number;
}

/** The shared core of a DCF result. */
export interface DiscountedCashFlowCommonResult {
  projectedCashFlows: DiscountedProjectedCashFlowRow[];
  projectedCashFlowPresentValue: number;
  terminalValue: number;
  terminalValuePresentValue: number;
  assumptions: DiscountedCashFlowAssumptions;
  diagnostics: DiscountedCashFlowDiagnostics;
  provenance?: ValuationProvenance;
}

/** The basis-discriminated DCF result: FCFF → firm, FCFE → equity, never relabeled. */
export type DiscountedCashFlowResult = DiscountedCashFlowCommonResult &
  (
    | {
        valuationBasis: 'firm';
        enterpriseValue: number;
        enterpriseToEquityBridge?: EnterpriseToEquityBridge;
        equityValue?: number;
        /** Present exactly when a bridge was supplied but equity value is still absent. */
        equityValueAbsentReason?: string;
        valuePerShare?: number;
        valuePerShareAbsentReason?: string;
      }
    | {
        valuationBasis: 'equity';
        equityValue: number;
        valuePerShare?: number;
        valuePerShareAbsentReason?: string;
      }
  );

// ---------------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------------

/** One projected cash flow: dated (with the valuation-date day count) or timed. */
export type ProjectedCashFlow =
  | { cashFlowDate: string; amount: number }
  | { timeYears: number; amount: number };

/**
 * One coherent projection time basis. A schedule is entirely dated or entirely year-fraction based;
 * the type rejects the mixed array the runtime has always refused.
 */
export type ProjectedCashFlowSchedule =
  | readonly { cashFlowDate: string; amount: number }[]
  | readonly { timeYears: number; amount: number }[];

/** Input for {@link discountedCashFlow}. */
export interface DiscountedCashFlowInput {
  /**
   * Which value the projected flows produce: `'firm'` for FCFF (enterprise value), `'equity'` for
   * FCFE (equity value). The basis is a statement about WHAT the flows are, so it is required.
   */
  valuationBasis: 'firm' | 'equity';
  /** Strict `YYYY-MM-DD`. Every dated flow discounts from here. */
  valuationDate: string;
  currency: string;
  projectedCashFlows: ProjectedCashFlowSchedule;
  /** Annual discount rate (decimal). A professional DCF never obtains one from a default. */
  annualDiscountRate: number;
  /** REQUIRED — a professional DCF states its convention. */
  compounding: InterestCompounding;
  /** REQUIRED when any flow is dated; rejected as unused when every flow is timed. */
  dayCount?: DayCount;
  terminalValueMethod: TerminalValueMethod;
  /** Firm basis only: enables the equity bridge. */
  enterpriseToEquityBridge?: EnterpriseToEquityBridge;
  /** Enables per-share value. */
  dilutedSharesOutstanding?: number;
  provenance?: ValuationProvenance;
}

const INPUT_KEYS = [
  'valuationBasis',
  'valuationDate',
  'currency',
  'projectedCashFlows',
  'annualDiscountRate',
  'compounding',
  'dayCount',
  'terminalValueMethod',
  'enterpriseToEquityBridge',
  'dilutedSharesOutstanding',
  'provenance',
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

/** A WORKING example for whichever head reached the shared validation — named per caller. */
function discountedCashFlowExample(functionName: string): string {
  const base =
    "{ valuationBasis: 'firm', valuationDate: '2026-12-31', currency: 'USD', projectedCashFlows: [{ cashFlowDate: '2027-12-31', amount: 120 }], annualDiscountRate: 0.09, compounding: 'annual', dayCount: 'ACT/365F', terminalValueMethod: { method: 'perpetual-growth', terminalCashFlow: 120, perpetualGrowthRate: 0.025 } }";
  return functionName === 'discountedCashFlow'
    ? `discountedCashFlow(${base})`
    : `${functionName}({ discountedCashFlowInput: ${base}, target: { variable: 'annual-discount-rate', searchRange: { from: 0.02, to: 0.3 } }, targetValue: 2_000 })`;
}

function validateProvenance(functionName: string, provenance: ValuationProvenance): void {
  requireArgumentObject(functionName, 'provenance', provenance);
  ensureKnownKeys(functionName, 'provenance', provenance, PROVENANCE_KEYS);
  for (const field of PROVENANCE_KEYS) {
    const value = provenance[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new InputError(
        `${functionName}: provenance.${field} must be a non-empty string when provided. Received ${value === null ? 'null' : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: `provenance.${field}` } },
      );
    }
  }
}

/**
 * Resolve every projection to { timeYears, amount, cashFlowDate? }, validating the shape of each
 * element and the coherence of the collection (dated and timed flows do not mix — the day count
 * would apply to half a schedule).
 */
function resolveProjections(
  functionName: string,
  input: DiscountedCashFlowInput,
): Array<{ timeYears: number; amount: number; cashFlowDate?: string }> {
  const flows = input.projectedCashFlows;
  if (!Array.isArray(flows) || flows.length === 0) {
    throw new InputError(
      `${functionName}: projectedCashFlows must be a non-empty array.\n  e.g. ${discountedCashFlowExample(functionName)}`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'projectedCashFlows' } },
    );
  }
  let sawDated = false;
  let sawTimed = false;
  const resolved = flows.map((flow, index) => {
    requireArgumentObject(functionName, `projectedCashFlows[${index}]`, flow);
    const dated = 'cashFlowDate' in (flow as Record<string, unknown>);
    if (dated) {
      sawDated = true;
      ensureKnownKeys(functionName, `projectedCashFlows[${index}]`, flow, [
        'cashFlowDate',
        'amount',
      ]);
    } else {
      sawTimed = true;
      ensureKnownKeys(functionName, `projectedCashFlows[${index}]`, flow, ['timeYears', 'amount']);
    }
    const amount = (flow as { amount: unknown }).amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new InputError(
        `${functionName}: projectedCashFlows[${index}].amount must be a finite number. Received ${amount === null ? 'null' : typeof amount === 'number' ? String(amount) : typeof amount}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: `projectedCashFlows[${index}].amount` },
        },
      );
    }
    if (dated) {
      const date = (flow as { cashFlowDate: unknown }).cashFlowDate;
      if (typeof date !== 'string' || !STRICT_DATE.test(date) || !isCalendarDate(date)) {
        throw new InputError(
          `${functionName}: projectedCashFlows[${index}].cashFlowDate must be a strict YYYY-MM-DD date. Received ${date === null ? 'null' : JSON.stringify(date)}.`,
          {
            code: ErrorCode.InputWrongType,
            context: { field: `projectedCashFlows[${index}].cashFlowDate` },
          },
        );
      }
      if (date <= input.valuationDate) {
        throw new InputError(
          `${functionName}: projectedCashFlows[${index}].cashFlowDate (${date}) must be AFTER the valuation date (${input.valuationDate}) — a projection is a future flow; realized flows belong in datedNetPresentValue.`,
          {
            code: ErrorCode.InputOutOfRange,
            context: { field: `projectedCashFlows[${index}].cashFlowDate` },
          },
        );
      }
      const timeYears = yearFraction(input.valuationDate, date, input.dayCount ?? 'ACT/365F');
      return { timeYears, amount, cashFlowDate: date };
    }
    const timeYears = (flow as { timeYears: unknown }).timeYears;
    if (typeof timeYears !== 'number' || !Number.isFinite(timeYears) || timeYears <= 0) {
      throw new InputError(
        `${functionName}: projectedCashFlows[${index}].timeYears must be a finite number > 0 — a projection is a future flow. Received ${timeYears === null ? 'null' : String(timeYears)}.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { field: `projectedCashFlows[${index}].timeYears` },
        },
      );
    }
    return { timeYears, amount };
  });
  if (sawDated && sawTimed) {
    throw new InputError(
      `${functionName}: projectedCashFlows mixes dated and timed flows — one schedule, one time basis. Use cashFlowDate for every flow, or timeYears for every flow.`,
      { code: ErrorCode.InputWrongShape, context: { field: 'projectedCashFlows' } },
    );
  }
  if (sawDated && input.dayCount === undefined) {
    throw new InputError(
      `${functionName}: dayCount is required when projectedCashFlows are dated — a professional DCF states its convention ('ACT/365F' | 'ACT/360' | '30/360').`,
      { code: ErrorCode.InputMissingField, context: { field: 'dayCount' } },
    );
  }
  if (sawTimed && input.dayCount !== undefined) {
    throw new InputError(
      `${functionName}: dayCount was supplied but every projected flow is timed — the convention would be silently unused, so it is rejected instead.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'dayCount' } },
    );
  }
  const times = resolved.map((flow) => flow.timeYears);
  for (let index = 1; index < times.length; index++) {
    if (times[index]! <= times[index - 1]!) {
      throw new InputError(
        `${functionName}: projectedCashFlows must be strictly ascending in time — flow[${index}] at ${times[index]} does not follow flow[${index - 1}] at ${times[index - 1]}.`,
        { code: ErrorCode.InputWrongShape, context: { field: `projectedCashFlows[${index}]` } },
      );
    }
  }
  return resolved;
}

function validateDcfInput(functionName: string, input: DiscountedCashFlowInput): void {
  requireArgumentObject(functionName, 'input', input);
  ensureKnownKeys(functionName, 'input', input, INPUT_KEYS);
  if (input.valuationBasis !== 'firm' && input.valuationBasis !== 'equity') {
    throw new InputError(
      `${functionName}: valuationBasis must be 'firm' (FCFF → enterprise value) | 'equity' (FCFE → equity value). The basis states WHAT the flows are; it is never inferred. Received ${input.valuationBasis === null ? 'null' : JSON.stringify(input.valuationBasis)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'valuationBasis' } },
    );
  }
  if (
    typeof input.valuationDate !== 'string' ||
    !STRICT_DATE.test(input.valuationDate) ||
    !isCalendarDate(input.valuationDate)
  ) {
    throw new InputError(
      `${functionName}: valuationDate must be a strict YYYY-MM-DD date. Received ${input.valuationDate === null ? 'null' : JSON.stringify(input.valuationDate)}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'valuationDate' } },
    );
  }
  if (typeof input.currency !== 'string' || input.currency.length === 0) {
    throw new InputError(
      `${functionName}: currency must be a non-empty ISO 4217 code. Received ${input.currency === null ? 'null' : typeof input.currency}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'currency' } },
    );
  }
  requireFiniteFields(
    functionName,
    input as unknown as Record<string, unknown>,
    ['annualDiscountRate'],
    {
      exampleCall: () => discountedCashFlowExample(functionName),
    },
  );
  if (input.compounding === undefined) {
    throw new InputError(
      `${functionName}: compounding is required — a professional DCF states its convention explicitly, it never obtains one from a default.\n  e.g. ${discountedCashFlowExample(functionName)}`,
      { code: ErrorCode.InputMissingField, context: { field: 'compounding' } },
    );
  }
  requireCompoundingWhenPresent(functionName, input.compounding);
  requireDayCountWhenPresent(functionName, input.dayCount);
  requireTerminalValueMethod(functionName, input.terminalValueMethod, input.annualDiscountRate);
  if (input.enterpriseToEquityBridge !== undefined) {
    if (input.valuationBasis === 'equity') {
      throw new InputError(
        `${functionName}: enterpriseToEquityBridge applies to the 'firm' basis only — an FCFE valuation IS equity value already, and accepting a bridge here would double-count the capital structure.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'enterpriseToEquityBridge' } },
      );
    }
    requireEnterpriseToEquityBridge(functionName, input.enterpriseToEquityBridge);
  }
  if (input.dilutedSharesOutstanding !== undefined) {
    if (
      typeof input.dilutedSharesOutstanding !== 'number' ||
      !Number.isFinite(input.dilutedSharesOutstanding) ||
      input.dilutedSharesOutstanding <= 0
    ) {
      throw new InputError(
        `${functionName}: dilutedSharesOutstanding must be a finite number > 0 when provided. Received ${input.dilutedSharesOutstanding === null ? 'null' : String(input.dilutedSharesOutstanding)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'dilutedSharesOutstanding' } },
      );
    }
  }
  if (input.provenance !== undefined) validateProvenance(functionName, input.provenance);
}

// ---------------------------------------------------------------------------------------------------
// discountedCashFlow
// ---------------------------------------------------------------------------------------------------

/**
 * The direct DCF: explicit projections, explicit conventions, explicit terminal method. The
 * top-level `annualDiscountRate` feeds the terminal primitive too, so a caller never repeats the
 * rate inside the terminal method. Firm basis returns enterprise value (equity only across a
 * supplied bridge); equity basis returns equity value directly.
 */
export function discountedCashFlow(input: DiscountedCashFlowInput): DiscountedCashFlowResult {
  validateDcfInput('discountedCashFlow', input);
  const projections = resolveProjections('discountedCashFlow', input);
  const warnings: string[] = [];
  const exclusions: string[] = [];

  const rows: DiscountedProjectedCashFlowRow[] = projections.map((flow) => {
    const factor = discountFactor(input.annualDiscountRate, flow.timeYears, input.compounding);
    return {
      ...(flow.cashFlowDate !== undefined ? { cashFlowDate: flow.cashFlowDate } : {}),
      timeYears: flow.timeYears,
      cashFlowAmount: flow.amount,
      discountFactor: factor,
      presentValue: flow.amount * factor,
    };
  });
  const projectedCashFlowPresentValue = rows.reduce((total, row) => total + row.presentValue, 0);

  const horizonYears = projections[projections.length - 1]!.timeYears;
  const terminal = terminalValue({
    terminalValueMethod: input.terminalValueMethod,
    annualDiscountRate: input.annualDiscountRate,
  });
  const terminalFactor = discountFactor(input.annualDiscountRate, horizonYears, input.compounding);
  const terminalValuePresentValue = terminal * terminalFactor;
  const totalPresentValue = projectedCashFlowPresentValue + terminalValuePresentValue;

  if (
    input.terminalValueMethod.method === 'perpetual-growth' &&
    Math.sign(input.terminalValueMethod.terminalCashFlow) !==
      Math.sign(projections[projections.length - 1]!.amount)
  ) {
    warnings.push(
      'the terminal cash flow and the final projected flow have different signs — confirm the terminal method describes the same stream',
    );
  }
  const terminalValueShareOfValue =
    totalPresentValue === 0 ? 0 : terminalValuePresentValue / totalPresentValue;
  if (terminalValueShareOfValue > 0.85) {
    warnings.push(
      `terminal value carries ${(terminalValueShareOfValue * 100).toFixed(1)}% of the total present value — the valuation is mostly the perpetuity assumption`,
    );
  }

  const assumptions: DiscountedCashFlowAssumptions = {
    contractVersion: 1,
    modelVersion: 1,
    valuationDate: input.valuationDate,
    currency: input.currency,
    valuationBasis: input.valuationBasis,
    annualDiscountRate: input.annualDiscountRate,
    discountRateSource: 'user-supplied',
    compounding: input.compounding,
    dayCount: input.dayCount ?? 'ACT/365F',
    terminalValueMethod: input.terminalValueMethod,
    terminalCashFlowConvention: 'final-forecast-period-flow',
    bridgeDecision:
      input.valuationBasis === 'equity'
        ? 'equity-basis-no-bridge-applicable'
        : input.enterpriseToEquityBridge !== undefined
          ? 'bridge-supplied'
          : 'no-bridge-supplied-equity-value-absent',
    shareCountDecision:
      input.dilutedSharesOutstanding !== undefined
        ? 'diluted-shares-supplied'
        : 'no-shares-supplied-per-share-absent',
  };
  const common: DiscountedCashFlowCommonResult = {
    projectedCashFlows: rows,
    projectedCashFlowPresentValue,
    terminalValue: terminal,
    terminalValuePresentValue,
    assumptions,
    diagnostics: {
      projectedPeriodCount: rows.length,
      terminalValueShareOfValue,
      warnings,
      exclusions,
    },
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  };

  const perShare = (
    equityValue: number,
  ): { valuePerShare?: number; valuePerShareAbsentReason?: string } =>
    input.dilutedSharesOutstanding !== undefined
      ? { valuePerShare: equityValue / input.dilutedSharesOutstanding }
      : {
          valuePerShareAbsentReason:
            'dilutedSharesOutstanding was not supplied — a per-share value needs the share count',
        };

  if (input.valuationBasis === 'equity') {
    return requireRepresentableResult('discountedCashFlow', {
      ...common,
      valuationBasis: 'equity',
      equityValue: totalPresentValue,
      ...perShare(totalPresentValue),
    });
  }

  const enterpriseValue = totalPresentValue;
  if (input.enterpriseToEquityBridge === undefined) {
    return requireRepresentableResult('discountedCashFlow', {
      ...common,
      valuationBasis: 'firm',
      enterpriseValue,
      equityValueAbsentReason:
        'no enterpriseToEquityBridge was supplied — bridge fields are never silently zeroed, so equity value is absent',
      ...(input.dilutedSharesOutstanding !== undefined
        ? {
            valuePerShareAbsentReason:
              'per-share value needs equity value, which is absent without a bridge',
          }
        : {
            valuePerShareAbsentReason:
              'dilutedSharesOutstanding was not supplied — a per-share value needs the share count',
          }),
    });
  }
  const equityValue = enterpriseToEquityValue({
    enterpriseValue,
    enterpriseToEquityBridge: input.enterpriseToEquityBridge,
  });
  return requireRepresentableResult('discountedCashFlow', {
    ...common,
    valuationBasis: 'firm',
    enterpriseValue,
    enterpriseToEquityBridge: input.enterpriseToEquityBridge,
    equityValue,
    ...perShare(equityValue),
  });
}

// ---------------------------------------------------------------------------------------------------
// reverseDiscountedCashFlow
// ---------------------------------------------------------------------------------------------------

/** The variable the reverse analysis solves for — an explicit discriminant. */
export type ReverseDiscountedCashFlowTarget =
  | {
      variable: 'perpetual-growth-rate';
      /** The bracket to search. Explicit — the admissible range is an economic statement. */
      searchRange: { from: number; to: number };
    }
  | {
      variable: 'annual-discount-rate';
      searchRange: { from: number; to: number };
    };

/** Input for {@link reverseDiscountedCashFlow}. */
export interface ReverseDiscountedCashFlowInput {
  /** The full direct-DCF input to hold fixed (except the solved variable). */
  discountedCashFlowInput: DiscountedCashFlowInput;
  target: ReverseDiscountedCashFlowTarget;
  /** The observed value to match: enterprise value on the firm basis, equity value on equity. */
  targetValue: number;
}

/** Result of {@link reverseDiscountedCashFlow}. */
export interface ReverseDiscountedCashFlowResult {
  assumptions: {
    variable: ReverseDiscountedCashFlowTarget['variable'];
    searchRange: { from: number; to: number };
    targetValue: number;
    method: 'bisection';
  };
  diagnostics: { warnings: string[] };
  variable: ReverseDiscountedCashFlowTarget['variable'];
  /** The implied value of the solved variable, or `null` when no root lies in the range. */
  impliedValue: number | null;
  /** Why `impliedValue` is null, when it is. */
  reason?: string;
  searchRange: { from: number; to: number };
  converged: boolean;
  iterations: number;
  /** |model(implied) − target| at the reported solution (absolute). */
  residual: number | null;
  /** The valuation the implied variable reproduces, for inspection. */
  impliedResult: DiscountedCashFlowResult | null;
}

function valueOnBasis(result: DiscountedCashFlowResult): number {
  if (result.valuationBasis === 'firm') return result.enterpriseValue;
  return result.equityValue;
}

/**
 * Solve for the stated variable so the DCF reproduces `targetValue` (enterprise value on the firm
 * basis, equity value on equity). Bisection over the EXPLICIT search range; bounds and convergence
 * are reported, and a no-root range answers `null` with the reason — never the nearest endpoint.
 */
export function reverseDiscountedCashFlow(
  input: ReverseDiscountedCashFlowInput,
): ReverseDiscountedCashFlowResult {
  requireArgumentObject('reverseDiscountedCashFlow', 'input', input);
  ensureKnownKeys('reverseDiscountedCashFlow', 'input', input, [
    'discountedCashFlowInput',
    'target',
    'targetValue',
  ]);
  requireFiniteFields(
    'reverseDiscountedCashFlow',
    input as unknown as Record<string, unknown>,
    ['targetValue'],
    {
      exampleCall:
        "reverseDiscountedCashFlow({ discountedCashFlowInput, target: { variable: 'annual-discount-rate', searchRange: { from: 0.02, to: 0.3 } }, targetValue: 2_000 })",
    },
  );
  requireArgumentObject('reverseDiscountedCashFlow', 'target', input.target);
  const variable = (input.target as { variable?: unknown }).variable;
  if (variable !== 'perpetual-growth-rate' && variable !== 'annual-discount-rate') {
    throw new InputError(
      `reverseDiscountedCashFlow: target.variable must be 'perpetual-growth-rate' | 'annual-discount-rate' (statement-driven targets — revenue growth, margin — solve through reverseOperatingForecast in the forecasting module). Received ${variable === null ? 'null' : JSON.stringify(variable)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'target.variable' } },
    );
  }
  ensureKnownKeys('reverseDiscountedCashFlow', 'target', input.target, ['variable', 'searchRange']);
  requireArgumentObject(
    'reverseDiscountedCashFlow',
    'target.searchRange',
    input.target.searchRange,
  );
  ensureKnownKeys('reverseDiscountedCashFlow', 'target.searchRange', input.target.searchRange, [
    'from',
    'to',
  ]);
  requireFiniteFields(
    'reverseDiscountedCashFlow',
    input.target.searchRange as unknown as Record<string, unknown>,
    ['from', 'to'],
    {
      exampleCall:
        "reverseDiscountedCashFlow({ discountedCashFlowInput, target: { variable: 'annual-discount-rate', searchRange: { from: 0.02, to: 0.3 } }, targetValue: 2_000 })",
    },
  );
  // The base input is validated ONCE, up front — before the terminal-method peek below and before
  // any endpoint evaluation, so a malformed base answers a typed rejection, never a masked null.
  // The projections too: their validation lives in the resolver, and leaving it to the endpoint
  // trials would let the domain-refusal catch below launder a malformed schedule into a null.
  validateDcfInput('reverseDiscountedCashFlow', input.discountedCashFlowInput);
  resolveProjections('reverseDiscountedCashFlow', input.discountedCashFlowInput);
  const { from, to } = input.target.searchRange;
  if (from >= to) {
    throw new InputError(
      `reverseDiscountedCashFlow: searchRange.from must be less than searchRange.to. Received from ${from}, to ${to}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'target.searchRange' } },
    );
  }
  if (
    variable === 'perpetual-growth-rate' &&
    input.discountedCashFlowInput.terminalValueMethod.method !== 'perpetual-growth'
  ) {
    throw new InputError(
      `reverseDiscountedCashFlow: solving for 'perpetual-growth-rate' requires a perpetual-growth terminal method — the supplied method is '${input.discountedCashFlowInput.terminalValueMethod.method}'.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'target.variable' } },
    );
  }

  const evaluate = (candidate: number): number => {
    const base = input.discountedCashFlowInput;
    const trial: DiscountedCashFlowInput =
      variable === 'annual-discount-rate'
        ? { ...base, annualDiscountRate: candidate }
        : {
            ...base,
            terminalValueMethod: {
              ...(base.terminalValueMethod as Extract<
                TerminalValueMethod,
                { method: 'perpetual-growth' }
              >),
              perpetualGrowthRate: candidate,
            },
          };
    return valueOnBasis(discountedCashFlow(trial)) - input.targetValue;
  };

  // The endpoints themselves may violate the model's own domain (e.g. growth ≥ rate). An endpoint
  // that cannot be evaluated is reported as such rather than silently clipped.
  let atFrom: number;
  let atTo: number;
  try {
    atFrom = evaluate(from);
    atTo = evaluate(to);
  } catch (error) {
    // Only the model's OWN domain refusals convert to a null-with-reason (e.g. a candidate growth
    // at or above the rate). Anything else is a defect and stays loud.
    if (!(error instanceof InputError)) throw error;
    return {
      assumptions: {
        variable,
        searchRange: { from, to },
        targetValue: input.targetValue,
        method: 'bisection',
      },
      diagnostics: { warnings: [] },
      variable,
      impliedValue: null,
      reason: `an endpoint of the search range is outside the model's domain: ${error.message}`,
      searchRange: { from, to },
      converged: false,
      iterations: 0,
      residual: null,
      impliedResult: null,
    };
  }
  if (atFrom === 0 || atTo === 0) {
    const implied = atFrom === 0 ? from : to;
    const impliedResult = discountedCashFlow(
      variable === 'annual-discount-rate'
        ? { ...input.discountedCashFlowInput, annualDiscountRate: implied }
        : {
            ...input.discountedCashFlowInput,
            terminalValueMethod: {
              ...(input.discountedCashFlowInput.terminalValueMethod as Extract<
                TerminalValueMethod,
                { method: 'perpetual-growth' }
              >),
              perpetualGrowthRate: implied,
            },
          },
    );
    return {
      assumptions: {
        variable,
        searchRange: { from, to },
        targetValue: input.targetValue,
        method: 'bisection',
      },
      diagnostics: { warnings: [] },
      variable,
      impliedValue: implied,
      searchRange: { from, to },
      converged: true,
      iterations: 0,
      residual: 0,
      impliedResult,
    };
  }
  if (Math.sign(atFrom) === Math.sign(atTo)) {
    return {
      assumptions: {
        variable,
        searchRange: { from, to },
        targetValue: input.targetValue,
        method: 'bisection',
      },
      diagnostics: { warnings: [] },
      variable,
      impliedValue: null,
      reason: `the target is not bracketed: the model value minus target has the same sign at both endpoints (${atFrom.toFixed(6)} at ${from}, ${atTo.toFixed(6)} at ${to}) — widen the range or reconsider the target`,
      searchRange: { from, to },
      converged: false,
      iterations: 0,
      residual: null,
      impliedResult: null,
    };
  }
  let low = from;
  let high = to;
  let lowValue = atFrom;
  let iterations = 0;
  const MAX_ITERATIONS = 200;
  while (iterations < MAX_ITERATIONS && high - low > 1e-12) {
    iterations += 1;
    const middle = (low + high) / 2;
    const atMiddle = evaluate(middle);
    if (atMiddle === 0) {
      low = middle;
      high = middle;
      break;
    }
    if (Math.sign(atMiddle) === Math.sign(lowValue)) {
      low = middle;
      lowValue = atMiddle;
    } else {
      high = middle;
    }
  }
  const implied = (low + high) / 2;
  const residual = Math.abs(evaluate(implied));
  const converged = high - low <= 1e-12;
  const impliedResult = discountedCashFlow(
    variable === 'annual-discount-rate'
      ? { ...input.discountedCashFlowInput, annualDiscountRate: implied }
      : {
          ...input.discountedCashFlowInput,
          terminalValueMethod: {
            ...(input.discountedCashFlowInput.terminalValueMethod as Extract<
              TerminalValueMethod,
              { method: 'perpetual-growth' }
            >),
            perpetualGrowthRate: implied,
          },
        },
  );
  return {
    assumptions: {
      variable,
      searchRange: { from, to },
      targetValue: input.targetValue,
      method: 'bisection',
    },
    diagnostics: { warnings: [] },
    variable,
    impliedValue: implied,
    searchRange: { from, to },
    converged,
    iterations,
    residual,
    impliedResult,
  };
}

// ---------------------------------------------------------------------------------------------------
// Sensitivity table
// ---------------------------------------------------------------------------------------------------

/** A sensitivity axis: which variable, and the explicit values to evaluate. */
export interface SensitivityAxis {
  variable: 'annual-discount-rate' | 'perpetual-growth-rate' | 'exit-multiple';
  /** Decimal rates for the rate variables; a plain multiple for 'exit-multiple'. */
  values: readonly number[];
}

/** Input for {@link discountedCashFlowSensitivityTable}. */
export interface SensitivityTableInput {
  discountedCashFlowInput: DiscountedCashFlowInput;
  rowAxis: SensitivityAxis;
  columnAxis: SensitivityAxis;
}

/** Result of {@link discountedCashFlowSensitivityTable}. */
export interface SensitivityTableResult {
  assumptions: {
    rowVariable: SensitivityAxis['variable'];
    rowUnit: string;
    columnVariable: SensitivityAxis['variable'];
    columnUnit: string;
    cellValue: 'enterpriseValue' | 'equityValue';
  };
  diagnostics: { warnings: string[] };
  /** The value each cell reports: enterprise value (firm basis) or equity value (equity basis). */
  cellValue: 'enterpriseValue' | 'equityValue';
  rowVariable: SensitivityAxis['variable'];
  /** The unit of the row/column values, stated. */
  rowUnit: string;
  columnVariable: SensitivityAxis['variable'];
  columnUnit: string;
  rowValues: number[];
  columnValues: number[];
  /** `cells[rowIndex][columnIndex]` — each PROVEN equal to a direct DCF call by construction. */
  cells: number[][];
  /** The unmodified base case, retained. */
  baseCase: DiscountedCashFlowResult;
}

function applyAxis(
  input: DiscountedCashFlowInput,
  axis: SensitivityAxis,
  value: number,
): DiscountedCashFlowInput {
  if (axis.variable === 'annual-discount-rate') return { ...input, annualDiscountRate: value };
  if (axis.variable === 'perpetual-growth-rate') {
    if (input.terminalValueMethod.method !== 'perpetual-growth') {
      throw new InputError(
        `discountedCashFlowSensitivityTable: the 'perpetual-growth-rate' axis requires a perpetual-growth terminal method — the supplied method is '${input.terminalValueMethod.method}'.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'terminalValueMethod' } },
      );
    }
    return {
      ...input,
      terminalValueMethod: { ...input.terminalValueMethod, perpetualGrowthRate: value },
    };
  }
  if (input.terminalValueMethod.method !== 'exit-multiple') {
    throw new InputError(
      `discountedCashFlowSensitivityTable: the 'exit-multiple' axis requires an exit-multiple terminal method — the supplied method is '${input.terminalValueMethod.method}'.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'terminalValueMethod' } },
    );
  }
  return { ...input, terminalValueMethod: { ...input.terminalValueMethod, exitMultiple: value } };
}

function validateAxis(label: string, axis: SensitivityAxis): void {
  requireArgumentObject('discountedCashFlowSensitivityTable', label, axis);
  ensureKnownKeys('discountedCashFlowSensitivityTable', label, axis, ['variable', 'values']);
  if (
    axis.variable !== 'annual-discount-rate' &&
    axis.variable !== 'perpetual-growth-rate' &&
    axis.variable !== 'exit-multiple'
  ) {
    throw new InputError(
      `discountedCashFlowSensitivityTable: ${label}.variable must be 'annual-discount-rate' | 'perpetual-growth-rate' | 'exit-multiple'. Received ${JSON.stringify(axis.variable)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: `${label}.variable` } },
    );
  }
  if (!Array.isArray(axis.values) || axis.values.length === 0) {
    throw new InputError(
      `discountedCashFlowSensitivityTable: ${label}.values must be a non-empty array of numbers.`,
      { code: ErrorCode.InputOutOfRange, context: { field: `${label}.values` } },
    );
  }
  axis.values.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InputError(
        `discountedCashFlowSensitivityTable: ${label}.values[${index}] must be a finite number. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${label}.values[${index}]` } },
      );
    }
  });
}

const AXIS_UNITS: Record<SensitivityAxis['variable'], string> = {
  'annual-discount-rate': 'annual decimal rate',
  'perpetual-growth-rate': 'annual decimal rate',
  'exit-multiple': 'multiple of the terminal metric',
};

/**
 * A two-axis sensitivity table where EVERY cell is a direct {@link discountedCashFlow} call with
 * exactly one row and one column value substituted — no incremental shortcuts, so the equality the
 * acceptance law demands holds by construction. The base case is retained unmodified.
 */
export function discountedCashFlowSensitivityTable(
  input: SensitivityTableInput,
): SensitivityTableResult {
  requireArgumentObject('discountedCashFlowSensitivityTable', 'input', input);
  ensureKnownKeys('discountedCashFlowSensitivityTable', 'input', input, [
    'discountedCashFlowInput',
    'rowAxis',
    'columnAxis',
  ]);
  validateAxis('rowAxis', input.rowAxis);
  validateAxis('columnAxis', input.columnAxis);
  if (input.rowAxis.variable === input.columnAxis.variable) {
    throw new InputError(
      `discountedCashFlowSensitivityTable: rowAxis and columnAxis name the same variable ('${input.rowAxis.variable}') — a table over one variable is a list, and the second axis would silently win.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'columnAxis.variable' } },
    );
  }
  const baseCase = discountedCashFlow(input.discountedCashFlowInput);
  const cells = input.rowAxis.values.map((rowValue) =>
    input.columnAxis.values.map((columnValue) => {
      const trial = applyAxis(
        applyAxis(input.discountedCashFlowInput, input.rowAxis, rowValue),
        input.columnAxis,
        columnValue,
      );
      const result = discountedCashFlow(trial);
      return result.valuationBasis === 'firm' ? result.enterpriseValue : result.equityValue;
    }),
  );
  const cellValue: 'enterpriseValue' | 'equityValue' =
    baseCase.valuationBasis === 'firm' ? 'enterpriseValue' : 'equityValue';
  return requireRepresentableResult('discountedCashFlowSensitivityTable', {
    assumptions: {
      rowVariable: input.rowAxis.variable,
      rowUnit: AXIS_UNITS[input.rowAxis.variable],
      columnVariable: input.columnAxis.variable,
      columnUnit: AXIS_UNITS[input.columnAxis.variable],
      cellValue,
    },
    diagnostics: { warnings: [] },
    cellValue,
    rowVariable: input.rowAxis.variable,
    rowUnit: AXIS_UNITS[input.rowAxis.variable],
    columnVariable: input.columnAxis.variable,
    columnUnit: AXIS_UNITS[input.columnAxis.variable],
    rowValues: [...input.rowAxis.values],
    columnValues: [...input.columnAxis.values],
    cells,
    baseCase,
  });
}

// ---------------------------------------------------------------------------------------------------
// Scenario analysis
// ---------------------------------------------------------------------------------------------------

/** One named deterministic scenario: explicit overrides of the base input, nothing invented. */
export interface DiscountedCashFlowScenario {
  scenarioName: string;
  overrides: Partial<
    Pick<
      DiscountedCashFlowInput,
      'annualDiscountRate' | 'terminalValueMethod' | 'projectedCashFlows' | 'dayCount'
    >
  >;
}

/** Input for {@link discountedCashFlowScenarioAnalysis}. */
export interface ScenarioAnalysisInput {
  discountedCashFlowInput: DiscountedCashFlowInput;
  scenarios: readonly DiscountedCashFlowScenario[];
}

/** Result of {@link discountedCashFlowScenarioAnalysis}. */
export interface ScenarioAnalysisResult {
  assumptions: { scenarioNames: string[] };
  diagnostics: { warnings: string[] };
  baseCase: DiscountedCashFlowResult;
  scenarios: Array<{
    scenarioName: string;
    /** Exactly which fields this scenario overrode. */
    overriddenFields: string[];
    result: DiscountedCashFlowResult;
  }>;
}

/**
 * Named deterministic assumption sets over one base case. Each scenario is the base input with
 * ONLY its stated overrides replaced — scenario values are supplied, never invented — and each
 * result is a direct {@link discountedCashFlow} call.
 */
export function discountedCashFlowScenarioAnalysis(
  input: ScenarioAnalysisInput,
): ScenarioAnalysisResult {
  requireArgumentObject('discountedCashFlowScenarioAnalysis', 'input', input);
  ensureKnownKeys('discountedCashFlowScenarioAnalysis', 'input', input, [
    'discountedCashFlowInput',
    'scenarios',
  ]);
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) {
    throw new InputError(
      `discountedCashFlowScenarioAnalysis: scenarios must be a non-empty array of named assumption sets.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'scenarios' } },
    );
  }
  const seen = new Set<string>();
  input.scenarios.forEach((scenario, index) => {
    requireArgumentObject('discountedCashFlowScenarioAnalysis', `scenarios[${index}]`, scenario);
    ensureKnownKeys('discountedCashFlowScenarioAnalysis', `scenarios[${index}]`, scenario, [
      'scenarioName',
      'overrides',
    ]);
    if (typeof scenario.scenarioName !== 'string' || scenario.scenarioName.length === 0) {
      throw new InputError(
        `discountedCashFlowScenarioAnalysis: scenarios[${index}].scenarioName must be a non-empty string.`,
        { code: ErrorCode.InputWrongType, context: { field: `scenarios[${index}].scenarioName` } },
      );
    }
    if (seen.has(scenario.scenarioName)) {
      throw new InputError(
        `discountedCashFlowScenarioAnalysis: scenario name '${scenario.scenarioName}' appears twice — a comparison needs distinct names.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `scenarios[${index}].scenarioName` } },
      );
    }
    seen.add(scenario.scenarioName);
    requireArgumentObject(
      'discountedCashFlowScenarioAnalysis',
      `scenarios[${index}].overrides`,
      scenario.overrides,
    );
    ensureKnownKeys(
      'discountedCashFlowScenarioAnalysis',
      `scenarios[${index}].overrides`,
      scenario.overrides,
      ['annualDiscountRate', 'terminalValueMethod', 'projectedCashFlows', 'dayCount'],
    );
    if (Object.keys(scenario.overrides).length === 0) {
      throw new InputError(
        `discountedCashFlowScenarioAnalysis: scenarios[${index}] ('${scenario.scenarioName}') overrides nothing — an empty scenario is the base case wearing a name.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `scenarios[${index}].overrides` } },
      );
    }
  });
  const baseCase = discountedCashFlow(input.discountedCashFlowInput);
  const scenarios = input.scenarios.map((scenario) => ({
    scenarioName: scenario.scenarioName,
    overriddenFields: Object.keys(scenario.overrides),
    result: discountedCashFlow({ ...input.discountedCashFlowInput, ...scenario.overrides }),
  }));
  return requireRepresentableResult('discountedCashFlowScenarioAnalysis', {
    assumptions: { scenarioNames: scenarios.map((scenario) => scenario.scenarioName) },
    diagnostics: { warnings: [] },
    baseCase,
    scenarios,
  });
}
