/**
 * FC2 — the typed statement contracts. `@insiderfinance/totalfinance/fundamentals` owns historical statement truth:
 * these are the canonical, compute-facing declarations that valuation and research consume. Raw
 * vendor payloads stay at the data edge (`core.RawFundamentalsRecord`); a data adapter maps them
 * INTO these types, and no compute function ever reads an open field bag.
 *
 * Sign conventions are part of the contract, not a per-vendor accident:
 *   - Income-statement expense lines (`costOfRevenue`, `operatingExpenses`, `interestExpense`,
 *     `incomeTaxExpense`, `sellingGeneralAdministrativeExpense`) are POSITIVE magnitudes.
 *   - `operatingCashFlow` / `investingCashFlow` / `financingCashFlow` keep their natural signs.
 *   - `capitalExpenditure`, `acquisitions`, `dividendsPaid`, and `shareRepurchases` are POSITIVE
 *     magnitudes of cash spent — the statement says what was spent, a consumer decides the sign.
 *   - Income and balance amounts may be negative where the economics allow (losses, negative
 *     equity, negative working capital).
 *
 * All monetary amounts are in units of `period.monetaryScale` and `period.currency`.
 */

import { ErrorCode, InputError, ensureKnownKeys, requireArgumentObject } from '@totalfinance/core';
import { type FundamentalPeriod, requireFundamentalPeriod } from './periods.js';

// ---------------------------------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------------------------------

/** One reported income statement (flows over the period). */
export interface IncomeStatement {
  period: FundamentalPeriod;
  revenue: number;
  /** Positive magnitude. */
  costOfRevenue?: number;
  /** Reported gross profit; when absent, consumers may derive `revenue - costOfRevenue` and say so. */
  grossProfit?: number;
  /** Positive magnitude of total operating expenses below gross profit. */
  operatingExpenses?: number;
  operatingIncome: number;
  /** Positive magnitude. */
  interestExpense?: number;
  /** Positive magnitude (a net tax benefit is a negative amount and is stated as such). */
  incomeTaxExpense?: number;
  netIncome: number;
  /** When reported separately from `netIncome` (the Beneish accrual basis prefers it). */
  incomeFromContinuingOperations?: number;
  /** Positive magnitude (Beneish SGAI consumes it). */
  sellingGeneralAdministrativeExpense?: number;
  /** Split-adjusted weighted-average diluted shares for the period. */
  dilutedSharesOutstanding?: number;
  /** Source-specific extras, preserved verbatim and never consumed by compute functions. */
  metadata?: Record<string, unknown>;
}

/** One reported balance sheet (balances at `period.periodEndDate`). */
export interface BalanceSheet {
  period: FundamentalPeriod;
  cashAndCashEquivalents: number;
  shortTermInvestments?: number;
  accountsReceivable?: number;
  inventory?: number;
  currentAssets?: number;
  /** Net property, plant, and equipment. */
  propertyPlantEquipmentNet?: number;
  totalAssets: number;
  currentLiabilities?: number;
  accountsPayable?: number;
  /** Interest-bearing debt due within one year. */
  shortTermDebt?: number;
  /** Interest-bearing debt due beyond one year. */
  longTermDebt?: number;
  /**
   * Total interest-bearing debt. When absent and both maturities are present, consumers may derive
   * `shortTermDebt + longTermDebt` and say so; "debt" NEVER silently means total liabilities.
   */
  totalDebt?: number;
  totalLiabilities: number;
  preferredEquity?: number;
  minorityInterest?: number;
  totalEquity: number;
  retainedEarnings?: number;
  /** Source-specific extras, preserved verbatim and never consumed by compute functions. */
  metadata?: Record<string, unknown>;
}

/** One reported cash-flow statement (flows over the period). */
export interface CashFlowStatement {
  period: FundamentalPeriod;
  operatingCashFlow: number;
  investingCashFlow: number;
  financingCashFlow: number;
  /** Positive magnitude of cash spent on property, plant, and equipment. */
  capitalExpenditure?: number;
  depreciationAndAmortization?: number;
  stockBasedCompensation?: number;
  /** Positive magnitude of cash spent on acquisitions. */
  acquisitions?: number;
  /** Positive magnitude of cash paid out as dividends. */
  dividendsPaid?: number;
  /** Positive magnitude of cash spent repurchasing shares. */
  shareRepurchases?: number;
  /** Source-specific extras, preserved verbatim and never consumed by compute functions. */
  metadata?: Record<string, unknown>;
}

/**
 * The three statements of ONE period. The periods must agree on their identity — end date, type,
 * currency, and monetary scale — because every ratio that crosses statements assumes it; the set's
 * point-in-time availability is the LATEST of the three (a set is visible only when whole).
 */
export interface FinancialStatements {
  income: IncomeStatement;
  balance: BalanceSheet;
  cashFlow: CashFlowStatement;
}

/**
 * The full reported history of one entity, restatements included: ordered by period end ascending,
 * with a restatement appearing as a SECOND record for the same period carrying its own
 * `availableTimestampMs` and `restatementOf` provenance. Nothing is ever overwritten.
 */
export interface FundamentalSeries {
  /** Optional entity label carried into diagnostics (a symbol, CIK, or internal id). */
  entity?: string;
  statements: readonly FinancialStatements[];
}

/** How {@link selectFundamentalSnapshot} resolves multiple visible versions of one period. */
export type RestatementPolicy = 'latest-available' | 'first-reported';

/**
 * The point-in-time view of a series: exactly the statement sets an observer at `asOf` could have
 * seen, one version per period under the stated restatement policy. This is what point-in-time
 * consumers (backtests, event studies, screens) iterate — never the raw series.
 */
export interface FundamentalSnapshot {
  entity?: string;
  asOf: number;
  restatementPolicy: RestatementPolicy;
  /** One resolved version per (periodType, periodEndDate), period end ascending. */
  statements: readonly FinancialStatements[];
}

// ---------------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------------

const INCOME_KEYS = [
  'period',
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
  'dilutedSharesOutstanding',
  'metadata',
] as const;

const BALANCE_KEYS = [
  'period',
  'cashAndCashEquivalents',
  'shortTermInvestments',
  'accountsReceivable',
  'inventory',
  'currentAssets',
  'propertyPlantEquipmentNet',
  'totalAssets',
  'currentLiabilities',
  'accountsPayable',
  'shortTermDebt',
  'longTermDebt',
  'totalDebt',
  'totalLiabilities',
  'preferredEquity',
  'minorityInterest',
  'totalEquity',
  'retainedEarnings',
  'metadata',
] as const;

const CASH_FLOW_KEYS = [
  'period',
  'operatingCashFlow',
  'investingCashFlow',
  'financingCashFlow',
  'capitalExpenditure',
  'depreciationAndAmortization',
  'stockBasedCompensation',
  'acquisitions',
  'dividendsPaid',
  'shareRepurchases',
  'metadata',
] as const;

/** Fields that are POSITIVE MAGNITUDES by contract (see the module header). */
const MAGNITUDE_FIELDS = new Set([
  'costOfRevenue',
  'operatingExpenses',
  'interestExpense',
  'sellingGeneralAdministrativeExpense',
  'dilutedSharesOutstanding',
  'capitalExpenditure',
  'acquisitions',
  'dividendsPaid',
  'shareRepurchases',
]);

function statementExample(functionName: string): string {
  return (
    `${functionName}({ income: { period, revenue: 1_000, operatingIncome: 200, netIncome: 150 }, ` +
    `balance: { period, cashAndCashEquivalents: 300, totalAssets: 2_000, totalLiabilities: 1_200, totalEquity: 800 }, ` +
    `cashFlow: { period, operatingCashFlow: 220, investingCashFlow: -80, financingCashFlow: -50 } })`
  );
}

function requireStatementNumbers(
  functionName: string,
  label: 'income' | 'balance' | 'cashFlow',
  statement: Record<string, unknown>,
  required: readonly string[],
  known: readonly string[],
): void {
  for (const field of known) {
    if (field === 'period' || field === 'metadata') continue;
    const value = statement[field];
    if (value === undefined) {
      if (!required.includes(field)) continue;
      throw new InputError(
        `${functionName}: ${label}.${field} is required.\n  e.g. ${statementExample(functionName)}`,
        { code: ErrorCode.InputMissingField, context: { field: `${label}.${field}` } },
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InputError(
        `${functionName}: ${label}.${field} must be a finite number in units of period.monetaryScale. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${label}.${field}` } },
      );
    }
    if (MAGNITUDE_FIELDS.has(field) && value < 0) {
      throw new InputError(
        `${functionName}: ${label}.${field} is a POSITIVE magnitude by contract (the statement says what was spent; a consumer decides the sign). Received ${value}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: `${label}.${field}` } },
      );
    }
  }
  const metadata = statement['metadata'];
  if (
    metadata !== undefined &&
    (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))
  ) {
    throw new InputError(
      `${functionName}: ${label}.metadata must be a plain object when provided. Received ${metadata === null ? 'null' : Array.isArray(metadata) ? 'an array' : typeof metadata}.`,
      { code: ErrorCode.InputWrongType, context: { field: `${label}.metadata` } },
    );
  }
}

/** Validate one {@link IncomeStatement} at a public boundary. */
export function requireIncomeStatement(functionName: string, income: IncomeStatement): void {
  requireArgumentObject(functionName, 'income', income);
  ensureKnownKeys(functionName, 'income', income, INCOME_KEYS);
  requireFundamentalPeriod(functionName, income.period);
  requireStatementNumbers(
    functionName,
    'income',
    income as unknown as Record<string, unknown>,
    ['revenue', 'operatingIncome', 'netIncome'],
    INCOME_KEYS,
  );
}

/** Validate one {@link BalanceSheet} at a public boundary. */
export function requireBalanceSheet(functionName: string, balance: BalanceSheet): void {
  requireArgumentObject(functionName, 'balance', balance);
  ensureKnownKeys(functionName, 'balance', balance, BALANCE_KEYS);
  requireFundamentalPeriod(functionName, balance.period);
  requireStatementNumbers(
    functionName,
    'balance',
    balance as unknown as Record<string, unknown>,
    ['cashAndCashEquivalents', 'totalAssets', 'totalLiabilities', 'totalEquity'],
    BALANCE_KEYS,
  );
}

/** Validate one {@link CashFlowStatement} at a public boundary. */
export function requireCashFlowStatement(functionName: string, cashFlow: CashFlowStatement): void {
  requireArgumentObject(functionName, 'cashFlow', cashFlow);
  ensureKnownKeys(functionName, 'cashFlow', cashFlow, CASH_FLOW_KEYS);
  requireFundamentalPeriod(functionName, cashFlow.period);
  requireStatementNumbers(
    functionName,
    'cashFlow',
    cashFlow as unknown as Record<string, unknown>,
    ['operatingCashFlow', 'investingCashFlow', 'financingCashFlow'],
    CASH_FLOW_KEYS,
  );
}

/**
 * Validate a {@link FinancialStatements} set: each statement, then the identity agreement — the
 * three periods must share `periodEndDate`, `periodType`, `currency`, and `monetaryScale`, because
 * every cross-statement ratio assumes one period and one unit.
 */
export function requireFinancialStatements(
  functionName: string,
  statements: FinancialStatements,
): void {
  requireArgumentObject(functionName, 'statements', statements);
  ensureKnownKeys(functionName, 'statements', statements, ['income', 'balance', 'cashFlow']);
  requireIncomeStatement(functionName, statements.income);
  requireBalanceSheet(functionName, statements.balance);
  requireCashFlowStatement(functionName, statements.cashFlow);
  const identity = (period: FundamentalPeriod): string =>
    `${period.periodType} ending ${period.periodEndDate} in ${period.currency} at scale ${period.monetaryScale}`;
  const reference = statements.income.period;
  for (const [label, period] of [
    ['balance', statements.balance.period],
    ['cashFlow', statements.cashFlow.period],
  ] as const) {
    if (
      period.periodEndDate !== reference.periodEndDate ||
      period.periodType !== reference.periodType ||
      period.currency !== reference.currency ||
      period.monetaryScale !== reference.monetaryScale
    ) {
      throw new InputError(
        `${functionName}: the three statements must describe ONE period — income is ${identity(reference)}, but ${label} is ${identity(period)}.`,
        { code: ErrorCode.InputWrongShape, context: { field: `statements.${label}.period` } },
      );
    }
  }
}

/**
 * INTERNAL fast path: the availability maximum with no validation. Callers that already validated
 * the set (the snapshot selector's loop, the ratio kernel) use this; the public boundary below
 * validates in full. Not re-exported by the `./statements` entry.
 */
export function availabilityOf(statements: FinancialStatements): number {
  return Math.max(
    statements.income.period.availableTimestampMs,
    statements.balance.period.availableTimestampMs,
    statements.cashFlow.period.availableTimestampMs,
  );
}

/**
 * The point-in-time availability of a statement SET: the latest of the three statements'
 * `availableTimestampMs` — a set is visible only when every statement in it is. The set is
 * validated IN FULL: a helper that answers an eligibility instant from a malformed set would
 * smuggle that malformation into every point-in-time decision built on it.
 */
export function statementsAvailableTimestampMs(statements: FinancialStatements): number {
  requireFinancialStatements('statementsAvailableTimestampMs', statements);
  return availabilityOf(statements);
}

/**
 * Gross profit under the canonical mapping: the reported figure when present, else derived
 * `revenue - costOfRevenue` (the derivation is disclosed by every consumer that uses it), else
 * `null` — never a guess.
 */
export function resolveGrossProfit(income: IncomeStatement): {
  grossProfit: number | null;
  derived: boolean;
} {
  if (income.grossProfit !== undefined) return { grossProfit: income.grossProfit, derived: false };
  if (income.costOfRevenue !== undefined) {
    return { grossProfit: income.revenue - income.costOfRevenue, derived: true };
  }
  return { grossProfit: null, derived: false };
}

/**
 * Interest-bearing debt under the canonical mapping: the reported total when present, else derived
 * `shortTermDebt + longTermDebt` when both maturities are present, else a single stated maturity
 * alone, else `null`. "Debt" never silently means total liabilities.
 */
export function resolveTotalDebt(balance: BalanceSheet): {
  totalDebt: number | null;
  derived: boolean;
} {
  if (balance.totalDebt !== undefined) return { totalDebt: balance.totalDebt, derived: false };
  const short = balance.shortTermDebt;
  const long = balance.longTermDebt;
  if (short !== undefined && long !== undefined) return { totalDebt: short + long, derived: true };
  if (short !== undefined) return { totalDebt: short, derived: true };
  if (long !== undefined) return { totalDebt: long, derived: true };
  return { totalDebt: null, derived: false };
}
