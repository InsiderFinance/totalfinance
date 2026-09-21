/**
 * FC2 — statement utilities: the point-in-time selector, trailing-twelve-month composition,
 * growth, common-size, accounting reconciliation, and per-share normalization. Every derivation is
 * disclosed; nothing extrapolates, plugs, or guesses.
 */

import {
  requireRepresentableResult,
  stableSum,
  ensureKnownKeys,
  type EpochMs,
  ErrorCode,
  InputError,
  isoDateToEpochMs,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import { type FundamentalPeriod } from './periods.js';
import {
  type BalanceSheet,
  type CashFlowStatement,
  type FinancialStatements,
  type FundamentalSeries,
  type FundamentalSnapshot,
  type IncomeStatement,
  type RestatementPolicy,
  availabilityOf,
  requireFinancialStatements,
} from './statement-contracts.js';

// ---------------------------------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------------------------------

function requireStatementsArray(
  functionName: string,
  statements: readonly FinancialStatements[],
  minimum: number,
): void {
  if (!Array.isArray(statements)) {
    throw new InputError(
      `${functionName}: statements must be an array of FinancialStatements sets. Received ${statements === null ? 'null' : typeof statements}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'statements' } },
    );
  }
  if (statements.length < minimum) {
    throw new InputError(
      `${functionName}: statements needs at least ${minimum} period${minimum === 1 ? '' : 's'}. Received ${statements.length}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'statements' } },
    );
  }
  statements.forEach((set, index) => {
    try {
      requireFinancialStatements(functionName, set);
    } catch (error) {
      if (error instanceof InputError) {
        // Same code and detail, with the failing ROW named — a 40-period series pointing at
        // "statements" instead of "statements[17]" makes the caller bisect by hand.
        throw new InputError(
          `${functionName}: statements[${index}]: ${error.message.replace(`${functionName}: `, '')}`,
          {
            code: error.code,
            context: { ...error.context, field: `statements[${index}]` },
            cause: error,
          },
        );
      }
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// selectFundamentalSnapshot
// ---------------------------------------------------------------------------------------------------

/** Input for {@link selectFundamentalSnapshot}. */
export interface SelectFundamentalSnapshotInput {
  series: FundamentalSeries;
  /** The observation instant (epoch ms). Only sets whose availability is at or before it qualify. */
  asOf: EpochMs;
  /** How multiple visible versions of one period resolve. */
  restatementPolicy: RestatementPolicy;
}

/**
 * The point-in-time view of a series: availability-gated by `statementsAvailableTimestampMs` (never
 * by period end), then resolved to ONE version per (periodType, periodEndDate) under the stated
 * restatement policy — `'latest-available'` takes the newest visible version, `'first-reported'`
 * takes the original filing and ignores restatements entirely.
 */
export function selectFundamentalSnapshot(
  input: SelectFundamentalSnapshotInput,
): FundamentalSnapshot {
  requireArgumentObject('selectFundamentalSnapshot', 'input', input);
  ensureKnownKeys('selectFundamentalSnapshot', 'input', input, [
    'series',
    'asOf',
    'restatementPolicy',
  ]);
  requireArgumentObject('selectFundamentalSnapshot', 'input.series', input.series);
  ensureKnownKeys('selectFundamentalSnapshot', 'input.series', input.series, [
    'entity',
    'statements',
  ]);
  if (
    input.series.entity !== undefined &&
    (typeof input.series.entity !== 'string' || input.series.entity.length === 0)
  ) {
    throw new InputError(
      `selectFundamentalSnapshot: series.entity must be a non-empty string when provided (a label carried into diagnostics). Received ${input.series.entity === null ? 'null' : typeof input.series.entity}.`,
      { code: ErrorCode.InputWrongType, context: { field: 'series.entity' } },
    );
  }
  if (
    input.restatementPolicy !== 'latest-available' &&
    input.restatementPolicy !== 'first-reported'
  ) {
    throw new InputError(
      `selectFundamentalSnapshot: restatementPolicy must be 'latest-available' | 'first-reported'. Received ${input.restatementPolicy === null ? 'null' : JSON.stringify(input.restatementPolicy)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'restatementPolicy' } },
    );
  }
  requireFiniteFields(
    'selectFundamentalSnapshot',
    input as unknown as Record<string, unknown>,
    ['asOf'],
    {
      exampleCall:
        "selectFundamentalSnapshot({ series, asOf: Date.UTC(2026, 7, 12), restatementPolicy: 'latest-available' })",
    },
  );
  requireStatementsArray('selectFundamentalSnapshot', input.series.statements, 0);

  const visible = input.series.statements.filter((set) => availabilityOf(set) <= input.asOf);
  const byPeriod = new Map<string, FinancialStatements[]>();
  for (const set of visible) {
    const key = `${set.income.period.periodType}|${set.income.period.periodEndDate}`;
    const bucket = byPeriod.get(key);
    if (bucket) bucket.push(set);
    else byPeriod.set(key, [set]);
  }
  const resolved: FinancialStatements[] = [];
  for (const versions of byPeriod.values()) {
    const ordered = [...versions].sort((a, b) => availabilityOf(a) - availabilityOf(b));
    resolved.push(
      input.restatementPolicy === 'latest-available' ? ordered[ordered.length - 1]! : ordered[0]!,
    );
  }
  resolved.sort((a, b) => (a.income.period.periodEndDate < b.income.period.periodEndDate ? -1 : 1));
  return {
    ...(input.series.entity !== undefined ? { entity: input.series.entity } : {}),
    asOf: input.asOf,
    restatementPolicy: input.restatementPolicy,
    statements: resolved,
  };
}

// ---------------------------------------------------------------------------------------------------
// trailingTwelveMonthStatements
// ---------------------------------------------------------------------------------------------------

/** Input for {@link trailingTwelveMonthStatements}. */
export interface TrailingTwelveMonthInput {
  /** Exactly four consecutive fiscal quarters, period end ascending. */
  statements: readonly FinancialStatements[];
}

const INCOME_FLOW_FIELDS = [
  'revenue',
  'costOfRevenue',
  'grossProfit',
  'operatingExpenses',
  'operatingIncome',
  'interestExpense',
  'incomeTaxExpense',
  'netIncome',
  'incomeFromContinuingOperations',
  'sellingGeneralAdministrativeExpense',
] as const;

const CASH_FLOW_FLOW_FIELDS = [
  'operatingCashFlow',
  'investingCashFlow',
  'financingCashFlow',
  'capitalExpenditure',
  'depreciationAndAmortization',
  'stockBasedCompensation',
  'acquisitions',
  'dividendsPaid',
  'shareRepurchases',
] as const;

/** Sum an optional flow field across quarters: absent anywhere → absent in the TTM (no zero-fill). */
function sumOptional<K extends string>(
  rows: readonly Record<K, number | undefined>[],
  field: K,
): number | undefined {
  const values: number[] = [];
  for (const row of rows) {
    const value = row[field];
    if (value === undefined) return undefined;
    values.push(value);
  }
  return stableSum(values);
}

/**
 * Compose four consecutive fiscal quarters into one trailing-twelve-months set: income and
 * cash-flow FLOWS sum; BALANCES are the latest quarter's (a balance is a point, not a flow);
 * `dilutedSharesOutstanding` is the four-quarter arithmetic mean (disclosed convention). The
 * quarter chain is verified — a gap or an overlap is an error naming the break, never a silent
 * annualization.
 */
export function trailingTwelveMonthStatements(
  input: TrailingTwelveMonthInput,
): FinancialStatements {
  requireArgumentObject('trailingTwelveMonthStatements', 'input', input);
  ensureKnownKeys('trailingTwelveMonthStatements', 'input', input, ['statements']);
  requireStatementsArray('trailingTwelveMonthStatements', input.statements, 4);
  if (input.statements.length !== 4) {
    throw new InputError(
      `trailingTwelveMonthStatements: exactly four quarters compose a trailing twelve months. Received ${input.statements.length}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'statements' } },
    );
  }
  const quarters = input.statements.map((set) => set.income.period);
  quarters.forEach((period, index) => {
    if (period.periodType !== 'quarter' || period.fiscalQuarter === undefined) {
      throw new InputError(
        `trailingTwelveMonthStatements: statements[${index}] must be a fiscal quarter with fiscalQuarter set (a ${period.periodType} period cannot enter a quarter chain).`,
        { code: ErrorCode.InputWrongShape, context: { field: `statements[${index}]` } },
      );
    }
  });
  for (let index = 1; index < quarters.length; index++) {
    const prior = quarters[index - 1]!;
    const current = quarters[index]!;
    const expectedQuarter = prior.fiscalQuarter === 4 ? 1 : prior.fiscalQuarter! + 1;
    const expectedYear = prior.fiscalQuarter === 4 ? prior.fiscalYear + 1 : prior.fiscalYear;
    if (current.fiscalQuarter !== expectedQuarter || current.fiscalYear !== expectedYear) {
      throw new InputError(
        `trailingTwelveMonthStatements: the quarter chain breaks between statements[${index - 1}] (FY${prior.fiscalYear} Q${prior.fiscalQuarter}) and statements[${index}] (FY${current.fiscalYear} Q${current.fiscalQuarter}) — expected FY${expectedYear} Q${expectedQuarter}. A gap or overlap is reported, never annualized over.`,
        { code: ErrorCode.InputWrongShape, context: { field: `statements[${index}]` } },
      );
    }
    if (current.periodEndDate <= prior.periodEndDate) {
      throw new InputError(
        `trailingTwelveMonthStatements: period ends must be strictly ascending — statements[${index}] ends ${current.periodEndDate}, not after ${prior.periodEndDate}.`,
        { code: ErrorCode.InputWrongShape, context: { field: `statements[${index}]` } },
      );
    }
    if (current.currency !== prior.currency || current.monetaryScale !== prior.monetaryScale) {
      throw new InputError(
        `trailingTwelveMonthStatements: quarters must share one currency and monetary scale — statements[${index}] is ${current.currency} at scale ${current.monetaryScale}, prior is ${prior.currency} at scale ${prior.monetaryScale}.`,
        { code: ErrorCode.InputWrongShape, context: { field: `statements[${index}]` } },
      );
    }
  }

  const first = quarters[0]!;
  const last = quarters[3]!;
  const latest = input.statements[3]!;
  const availableTimestampMs = Math.max(...input.statements.map((set) => availabilityOf(set)));
  const period: FundamentalPeriod = {
    ...(first.periodStartDate !== undefined ? { periodStartDate: first.periodStartDate } : {}),
    periodEndDate: last.periodEndDate,
    fiscalYear: last.fiscalYear,
    periodType: 'trailing-twelve-months',
    availableTimestampMs,
    currency: last.currency,
    monetaryScale: last.monetaryScale,
  };

  const incomes = input.statements.map((set) => set.income);
  const cashFlows = input.statements.map((set) => set.cashFlow);

  const income: IncomeStatement = {
    period,
    revenue: stableSum(incomes.map((row) => row.revenue)),
    operatingIncome: stableSum(incomes.map((row) => row.operatingIncome)),
    netIncome: stableSum(incomes.map((row) => row.netIncome)),
  };
  for (const field of INCOME_FLOW_FIELDS) {
    if (field === 'revenue' || field === 'operatingIncome' || field === 'netIncome') continue;
    const total = sumOptional(
      incomes as unknown as readonly Record<string, number | undefined>[],
      field,
    );
    if (total !== undefined) (income as unknown as Record<string, unknown>)[field] = total;
  }
  const shares = sumOptional(
    incomes as unknown as readonly Record<string, number | undefined>[],
    'dilutedSharesOutstanding',
  );
  if (shares !== undefined) income.dilutedSharesOutstanding = shares / 4;

  const cashFlow: CashFlowStatement = {
    period,
    operatingCashFlow: stableSum(cashFlows.map((row) => row.operatingCashFlow)),
    investingCashFlow: stableSum(cashFlows.map((row) => row.investingCashFlow)),
    financingCashFlow: stableSum(cashFlows.map((row) => row.financingCashFlow)),
  };
  for (const field of CASH_FLOW_FLOW_FIELDS) {
    if (
      field === 'operatingCashFlow' ||
      field === 'investingCashFlow' ||
      field === 'financingCashFlow'
    )
      continue;
    const total = sumOptional(
      cashFlows as unknown as readonly Record<string, number | undefined>[],
      field,
    );
    if (total !== undefined) (cashFlow as unknown as Record<string, unknown>)[field] = total;
  }

  const balance: BalanceSheet = { ...latest.balance, period };
  delete (balance as unknown as Record<string, unknown>)['metadata'];
  return requireRepresentableResult('trailingTwelveMonthStatements', {
    income,
    balance,
    cashFlow,
  });
}

// ---------------------------------------------------------------------------------------------------
// fundamentalGrowth
// ---------------------------------------------------------------------------------------------------

/** Input for {@link fundamentalGrowth}. */
export interface FundamentalGrowthInput {
  /** At least two observations of one amount, period end ascending. */
  observations: readonly { periodEndDate: string; amount: number }[];
}

/** Result of {@link fundamentalGrowth} — the one analysis report grammar. */
export interface FundamentalGrowthResult {
  assumptions: {
    /** Elapsed time between period ends is an ACT/365F year fraction (a label, not a literal). */
    elapsedYearsBasis: string;
    observationCount: number;
  };
  diagnostics: {
    /** Every null growth's reason surfaces here too, so a reader scans one place. */
    warnings: string[];
  };
  /**
   * One row per adjacent pair: fractional growth `current / prior - 1`, or `null` with the reason
   * when the prior amount is zero or the pair crosses sign (a growth rate through zero has no
   * meaningful magnitude).
   */
  periodOverPeriod: Array<{
    fromPeriodEndDate: string;
    toPeriodEndDate: string;
    growth: number | null;
    reason?: string;
  }>;
  /**
   * Compound annual growth from the first to the last observation over the ACTUAL elapsed years
   * (ACT/365F between the period ends), or `null` with the reason when the endpoints make the
   * exponent meaningless (non-positive start, sign change, or zero elapsed time).
   */
  compoundAnnualGrowthRate: number | null;
  compoundAnnualGrowthReason?: string;
  elapsedYears: number;
}

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

function yearsBetween(fromDate: string, toDate: string): number {
  const from = Date.UTC(
    Number(fromDate.slice(0, 4)),
    Number(fromDate.slice(5, 7)) - 1,
    Number(fromDate.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(toDate.slice(0, 4)),
    Number(toDate.slice(5, 7)) - 1,
    Number(toDate.slice(8, 10)),
  );
  return (to - from) / (365 * 24 * 60 * 60 * 1000);
}

/** Period-over-period and compound annual growth of one fundamental amount. */
export function fundamentalGrowth(input: FundamentalGrowthInput): FundamentalGrowthResult {
  requireArgumentObject('fundamentalGrowth', 'input', input);
  ensureKnownKeys('fundamentalGrowth', 'input', input, ['observations']);
  if (!Array.isArray(input.observations) || input.observations.length < 2) {
    throw new InputError(
      `fundamentalGrowth: observations needs at least two rows.\n  e.g. fundamentalGrowth({ observations: [{ periodEndDate: '2024-12-31', amount: 100 }, { periodEndDate: '2025-12-31', amount: 120 }] })`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'observations' } },
    );
  }
  input.observations.forEach((row, index) => {
    requireArgumentObject('fundamentalGrowth', `observations[${index}]`, row);
    ensureKnownKeys('fundamentalGrowth', `observations[${index}]`, row, [
      'periodEndDate',
      'amount',
    ]);
    if (
      typeof row.periodEndDate !== 'string' ||
      !STRICT_DATE.test(row.periodEndDate) ||
      !isCalendarDate(row.periodEndDate)
    ) {
      throw new InputError(
        `fundamentalGrowth: observations[${index}].periodEndDate must be a strict YYYY-MM-DD calendar date. Received ${row.periodEndDate === null ? 'null' : JSON.stringify(row.periodEndDate)}.`,
        {
          code: ErrorCode.InputWrongType,
          context: { field: `observations[${index}].periodEndDate` },
        },
      );
    }
    if (typeof row.amount !== 'number' || !Number.isFinite(row.amount)) {
      throw new InputError(
        `fundamentalGrowth: observations[${index}].amount must be a finite number. Received ${row.amount === null ? 'null' : typeof row.amount === 'number' ? String(row.amount) : typeof row.amount}.`,
        { code: ErrorCode.InputWrongType, context: { field: `observations[${index}].amount` } },
      );
    }
    if (index > 0 && row.periodEndDate <= input.observations[index - 1]!.periodEndDate) {
      throw new InputError(
        `fundamentalGrowth: observations must be strictly ascending by periodEndDate — observations[${index}] (${row.periodEndDate}) does not follow ${input.observations[index - 1]!.periodEndDate}.`,
        { code: ErrorCode.InputWrongShape, context: { field: `observations[${index}]` } },
      );
    }
  });

  const periodOverPeriod: FundamentalGrowthResult['periodOverPeriod'] = [];
  for (let index = 1; index < input.observations.length; index++) {
    const prior = input.observations[index - 1]!;
    const current = input.observations[index]!;
    if (prior.amount === 0) {
      periodOverPeriod.push({
        fromPeriodEndDate: prior.periodEndDate,
        toPeriodEndDate: current.periodEndDate,
        growth: null,
        reason: 'prior amount is zero — growth from zero has no defined rate',
      });
    } else if (prior.amount < 0 !== current.amount < 0 && current.amount !== 0) {
      periodOverPeriod.push({
        fromPeriodEndDate: prior.periodEndDate,
        toPeriodEndDate: current.periodEndDate,
        growth: null,
        reason: 'the amounts cross sign — a growth rate through zero has no meaningful magnitude',
      });
    } else {
      periodOverPeriod.push({
        fromPeriodEndDate: prior.periodEndDate,
        toPeriodEndDate: current.periodEndDate,
        growth: current.amount / prior.amount - 1,
      });
    }
  }

  const first = input.observations[0]!;
  const last = input.observations[input.observations.length - 1]!;
  const elapsedYears = yearsBetween(first.periodEndDate, last.periodEndDate);
  let compoundAnnualGrowthRate: number | null = null;
  let compoundAnnualGrowthReason: string | undefined;
  if (first.amount <= 0) {
    compoundAnnualGrowthReason =
      'the beginning amount is not positive — a compound rate needs a positive base';
  } else if (last.amount < 0) {
    compoundAnnualGrowthReason =
      'the ending amount is negative — the endpoints cross sign and no real compound rate exists';
  } else if (elapsedYears <= 0) {
    compoundAnnualGrowthReason = 'no time elapsed between the first and last observations';
  } else {
    compoundAnnualGrowthRate = Math.pow(last.amount / first.amount, 1 / elapsedYears) - 1;
  }
  const warnings = periodOverPeriod
    .filter((row) => row.reason !== undefined)
    .map((row) => `${row.fromPeriodEndDate} → ${row.toPeriodEndDate}: ${row.reason}`);
  if (compoundAnnualGrowthReason !== undefined) {
    warnings.push(`compound annual growth: ${compoundAnnualGrowthReason}`);
  }
  return requireRepresentableResult('fundamentalGrowth', {
    assumptions: {
      elapsedYearsBasis: 'ACT/365F between period end dates',
      observationCount: input.observations.length,
    },
    diagnostics: { warnings },
    periodOverPeriod,
    compoundAnnualGrowthRate,
    ...(compoundAnnualGrowthReason !== undefined ? { compoundAnnualGrowthReason } : {}),
    elapsedYears,
  });
}

// ---------------------------------------------------------------------------------------------------
// commonSizeFinancialStatements
// ---------------------------------------------------------------------------------------------------

/** Input for {@link commonSizeFinancialStatements}. */
export interface CommonSizeInput {
  statements: FinancialStatements;
}

/** Result of {@link commonSizeFinancialStatements}: each line as a FRACTION of its stated base. */
export interface CommonSizeResult {
  assumptions: {
    incomeBasis: 'revenue';
    balanceBasis: 'totalAssets';
    cashFlowBasis: 'revenue';
  };
  diagnostics: { warnings: string[] };
  /** Income lines over `revenue`. */
  income: { basis: 'revenue'; lines: Record<string, number> };
  /** Balance lines over `totalAssets`. */
  balance: { basis: 'totalAssets'; lines: Record<string, number> };
  /** Cash-flow lines over `revenue`. */
  cashFlow: { basis: 'revenue'; lines: Record<string, number> };
}

/**
 * Common-size statements: every reported numeric line divided by its conventional base — income
 * and cash-flow lines by revenue, balance lines by total assets. Fractions, never display
 * percentages. A zero base is an error naming itself, not an Infinity.
 */
export function commonSizeFinancialStatements(input: CommonSizeInput): CommonSizeResult {
  requireArgumentObject('commonSizeFinancialStatements', 'input', input);
  ensureKnownKeys('commonSizeFinancialStatements', 'input', input, ['statements']);
  requireFinancialStatements('commonSizeFinancialStatements', input.statements);
  const { income, balance, cashFlow } = input.statements;
  if (income.revenue === 0) {
    throw new InputError(
      'commonSizeFinancialStatements: revenue is zero — income and cash-flow lines have no common-size base.',
      { code: ErrorCode.InputOutOfRange, context: { field: 'statements.income.revenue' } },
    );
  }
  if (balance.totalAssets === 0) {
    throw new InputError(
      'commonSizeFinancialStatements: totalAssets is zero — balance lines have no common-size base.',
      { code: ErrorCode.InputOutOfRange, context: { field: 'statements.balance.totalAssets' } },
    );
  }
  const over = (statement: Record<string, unknown>, base: number): Record<string, number> => {
    const lines: Record<string, number> = {};
    for (const [field, value] of Object.entries(statement)) {
      if (field === 'period' || field === 'metadata') continue;
      if (typeof value === 'number') lines[field] = value / base;
    }
    return lines;
  };
  return requireRepresentableResult('commonSizeFinancialStatements', {
    assumptions: { incomeBasis: 'revenue', balanceBasis: 'totalAssets', cashFlowBasis: 'revenue' },
    diagnostics: { warnings: [] },
    income: {
      basis: 'revenue',
      lines: over(income as unknown as Record<string, unknown>, income.revenue),
    },
    balance: {
      basis: 'totalAssets',
      lines: over(balance as unknown as Record<string, unknown>, balance.totalAssets),
    },
    cashFlow: {
      basis: 'revenue',
      lines: over(cashFlow as unknown as Record<string, unknown>, income.revenue),
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// reconcileFinancialStatements
// ---------------------------------------------------------------------------------------------------

/** Input for {@link reconcileFinancialStatements}. */
export interface ReconcileStatementsInput {
  statements: FinancialStatements;
  /** The immediately prior period, enabling the cash-articulation check across the two. */
  priorStatements?: FinancialStatements;
  /**
   * Absolute tolerance in reported units (period.monetaryScale). Default `1` — one reported unit,
   * the rounding a scaled filing can legitimately carry. Documented and echoed in the result.
   */
  toleranceAmount?: number;
}

/** One accounting-identity check. */
export interface ReconciliationCheck {
  name: string;
  /** `left - right` in reported units; `null` when a required field is absent. */
  difference: number | null;
  withinTolerance: boolean | null;
  detail: string;
}

/** Result of {@link reconcileFinancialStatements}. */
export interface ReconciliationResult {
  assumptions: {
    /** Absolute tolerance in reported units, echoed (default 1). */
    toleranceAmount: number;
  };
  diagnostics: {
    /** One warning per failed or unevaluable check. */
    warnings: string[];
  };
  checks: ReconciliationCheck[];
  toleranceAmount: number;
  /** True when every evaluable check is within tolerance. */
  reconciles: boolean;
}

/**
 * Accounting-identity diagnostics: the balance-sheet identity, gross-profit articulation,
 * current-versus-total containment, and — with the prior period — cash articulation
 * (`Δcash = operating + investing + financing`). A check whose fields are absent reports `null`,
 * never a silent pass presented as proof.
 */
export function reconcileFinancialStatements(
  input: ReconcileStatementsInput,
): ReconciliationResult {
  requireArgumentObject('reconcileFinancialStatements', 'input', input);
  ensureKnownKeys('reconcileFinancialStatements', 'input', input, [
    'statements',
    'priorStatements',
    'toleranceAmount',
  ]);
  requireFinancialStatements('reconcileFinancialStatements', input.statements);
  if (input.priorStatements !== undefined) {
    requireFinancialStatements('reconcileFinancialStatements', input.priorStatements);
  }
  if (
    input.toleranceAmount !== undefined &&
    (typeof input.toleranceAmount !== 'number' ||
      !Number.isFinite(input.toleranceAmount) ||
      input.toleranceAmount < 0)
  ) {
    throw new InputError(
      `reconcileFinancialStatements: toleranceAmount must be a finite number ≥ 0 in reported units. Received ${input.toleranceAmount === null ? 'null' : String(input.toleranceAmount)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'toleranceAmount' } },
    );
  }
  const toleranceAmount = input.toleranceAmount ?? 1;
  const { income, balance, cashFlow } = input.statements;
  const checks: ReconciliationCheck[] = [];
  const push = (
    name: string,
    left: number | undefined,
    right: number | undefined,
    detail: string,
  ): void => {
    if (left === undefined || right === undefined) {
      checks.push({
        name,
        difference: null,
        withinTolerance: null,
        detail: `${detail} — not evaluable: a required field is absent`,
      });
      return;
    }
    const difference = left - right;
    checks.push({
      name,
      difference,
      withinTolerance: Math.abs(difference) <= toleranceAmount,
      detail,
    });
  };

  push(
    'balance-sheet identity',
    balance.totalAssets,
    stableSum([balance.totalLiabilities, balance.totalEquity]),
    'totalAssets = totalLiabilities + totalEquity',
  );
  push(
    'gross-profit articulation',
    income.grossProfit,
    income.costOfRevenue === undefined
      ? undefined
      : stableSum([income.revenue, -income.costOfRevenue]),
    'grossProfit = revenue - costOfRevenue',
  );
  push(
    'operating-income articulation',
    income.grossProfit === undefined || income.operatingExpenses === undefined
      ? undefined
      : income.grossProfit - income.operatingExpenses,
    income.operatingIncome,
    'grossProfit - operatingExpenses = operatingIncome',
  );
  if (
    balance.currentAssets !== undefined &&
    balance.currentAssets > balance.totalAssets + toleranceAmount
  ) {
    checks.push({
      name: 'current-assets containment',
      difference: balance.currentAssets - balance.totalAssets,
      withinTolerance: false,
      detail: 'currentAssets must not exceed totalAssets',
    });
  }
  if (input.priorStatements !== undefined) {
    push(
      'cash articulation',
      balance.cashAndCashEquivalents - input.priorStatements.balance.cashAndCashEquivalents,
      stableSum([
        cashFlow.operatingCashFlow,
        cashFlow.investingCashFlow,
        cashFlow.financingCashFlow,
      ]),
      'Δ cashAndCashEquivalents = operating + investing + financing cash flow (no FX translation supplied)',
    );
  }
  const evaluable = checks.filter((check) => check.withinTolerance !== null);
  const warnings = checks
    .filter((check) => check.withinTolerance !== true)
    .map((check) =>
      check.withinTolerance === null
        ? `${check.name}: not evaluable (a required field is absent)`
        : `${check.name}: off by ${check.difference} (beyond tolerance ${toleranceAmount})`,
    );
  return requireRepresentableResult('reconcileFinancialStatements', {
    assumptions: { toleranceAmount },
    diagnostics: { warnings },
    checks,
    toleranceAmount,
    reconciles: evaluable.every((check) => check.withinTolerance === true),
  });
}

// ---------------------------------------------------------------------------------------------------
// perShareFundamentals
// ---------------------------------------------------------------------------------------------------

/** Input for {@link perShareFundamentals}. */
export interface PerShareFundamentalsInput {
  statements: FinancialStatements;
  /**
   * Cumulative split factor between the period and the observer's share basis (e.g. `2` after a
   * 2-for-1 split since the period end). Default `1` — no split; the factor used is echoed.
   */
  splitFactorSincePeriod?: number;
}

/** Result of {@link perShareFundamentals}. */
export interface PerShareFundamentalsResult {
  assumptions: {
    splitFactorSincePeriod: number;
    dilutedSharesUsed: number;
    /** Per-share values are ABSOLUTE currency per share (amount × monetaryScale / shares). */
    unitBasis: 'absolute currency per share';
  };
  diagnostics: { warnings: string[] };
  /** Split-adjusted diluted shares actually used as the denominator. */
  dilutedSharesUsed: number;
  splitFactorSincePeriod: number;
  earningsPerShare: number;
  revenuePerShare: number;
  bookValuePerShare: number;
  /** `operatingCashFlow - capitalExpenditure` per share; `null` when capex is absent. */
  freeCashFlowPerShare: number | null;
  freeCashFlowPerShareReason?: string;
}

/**
 * Split-aware per-share normalization: the period's diluted shares are multiplied by the supplied
 * cumulative split factor so a pre-split period and a post-split observer meet on one basis. The
 * factor and the shares used are echoed; shares absent or non-positive is an error, never a NaN.
 */
export function perShareFundamentals(input: PerShareFundamentalsInput): PerShareFundamentalsResult {
  requireArgumentObject('perShareFundamentals', 'input', input);
  ensureKnownKeys('perShareFundamentals', 'input', input, ['statements', 'splitFactorSincePeriod']);
  requireFinancialStatements('perShareFundamentals', input.statements);
  if (
    input.splitFactorSincePeriod !== undefined &&
    (typeof input.splitFactorSincePeriod !== 'number' ||
      !Number.isFinite(input.splitFactorSincePeriod) ||
      input.splitFactorSincePeriod <= 0)
  ) {
    throw new InputError(
      `perShareFundamentals: splitFactorSincePeriod must be a finite number > 0 (e.g. 2 after a 2-for-1 split). Received ${input.splitFactorSincePeriod === null ? 'null' : String(input.splitFactorSincePeriod)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'splitFactorSincePeriod' } },
    );
  }
  const splitFactorSincePeriod = input.splitFactorSincePeriod ?? 1;
  const reportedShares = input.statements.income.dilutedSharesOutstanding;
  if (reportedShares === undefined || reportedShares <= 0) {
    throw new InputError(
      `perShareFundamentals: income.dilutedSharesOutstanding must be present and > 0 — per-share metrics require split-adjusted diluted shares for the period. Received ${reportedShares === undefined ? 'absent' : String(reportedShares)}.`,
      {
        code:
          reportedShares === undefined ? ErrorCode.InputMissingField : ErrorCode.InputOutOfRange,
        context: { field: 'statements.income.dilutedSharesOutstanding' },
      },
    );
  }
  const dilutedSharesUsed = reportedShares * splitFactorSincePeriod;
  const { income, balance, cashFlow } = input.statements;
  const capitalExpenditure = cashFlow.capitalExpenditure;
  // Per-share values are ABSOLUTE currency per share — a share count is a count, so the amount
  // side carries the reporting scale.
  const scale = income.period.monetaryScale;
  return requireRepresentableResult('perShareFundamentals', {
    assumptions: {
      splitFactorSincePeriod,
      dilutedSharesUsed,
      unitBasis: 'absolute currency per share',
    },
    diagnostics: {
      warnings:
        capitalExpenditure === undefined
          ? ['capitalExpenditure is absent — free cash flow per share cannot be formed']
          : [],
    },
    dilutedSharesUsed,
    splitFactorSincePeriod,
    earningsPerShare: (income.netIncome * scale) / dilutedSharesUsed,
    revenuePerShare: (income.revenue * scale) / dilutedSharesUsed,
    bookValuePerShare: (balance.totalEquity * scale) / dilutedSharesUsed,
    freeCashFlowPerShare:
      capitalExpenditure === undefined
        ? null
        : ((cashFlow.operatingCashFlow - capitalExpenditure) * scale) / dilutedSharesUsed,
    ...(capitalExpenditure === undefined
      ? {
          freeCashFlowPerShareReason:
            'capitalExpenditure is absent — free cash flow (operatingCashFlow - capitalExpenditure) cannot be formed',
        }
      : {}),
  });
}
