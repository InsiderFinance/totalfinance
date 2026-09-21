/**
 * FC2 — forecasting compositions. No forecast extrapolates history by default: every driver is
 * explicit, can vary by period, and is echoed back. The three-statement projection reconciles by
 * CONSTRUCTION (the algebra is written out at the balance roll below), and the balancing item is
 * named — cash — never a plug hidden inside cash or debt.
 */

import {
  requireRepresentableResult,
  ErrorCode,
  InputError,
  ensureKnownKeys,
  requireArgumentObject,
  requireFiniteFields,
} from '@totalfinance/core';
import type { FinancialStatements } from '@totalfinance/fundamentals';
import { requireFinancialStatements } from '@totalfinance/fundamentals';
import { freeCashFlowToEquity, freeCashFlowToFirm } from './corporate-primitives.js';
import {
  type DiscountedCashFlowInput,
  type DiscountedCashFlowResult,
  discountedCashFlow,
} from './discounted-cash-flow.js';

// ---------------------------------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------------------------------

/** An explicit per-period amount, or an explicit fraction of that period's revenue. */
export type AmountDriver = { amount: number } | { fractionOfRevenue: number };

/** Revenue is stated directly or grown EXPLICITLY from the prior period — never extrapolated. */
export type RevenueDriver = { amount: number } | { growthRate: number };

function resolveDriver(
  functionName: string,
  path: string,
  driver: AmountDriver,
  revenue: number,
): number {
  requireArgumentObject(functionName, path, driver);
  const hasAmount = 'amount' in (driver as Record<string, unknown>);
  ensureKnownKeys(functionName, path, driver, hasAmount ? ['amount'] : ['fractionOfRevenue']);
  const value = hasAmount
    ? (driver as { amount: unknown }).amount
    : (driver as { fractionOfRevenue: unknown }).fractionOfRevenue;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${path}.${hasAmount ? 'amount' : 'fractionOfRevenue'} must be a finite number. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { field: path } },
    );
  }
  return hasAmount ? (value as number) : (value as number) * revenue;
}

function resolveRevenue(
  functionName: string,
  path: string,
  driver: RevenueDriver,
  priorRevenue: number,
): number {
  requireArgumentObject(functionName, path, driver);
  const hasAmount = 'amount' in (driver as Record<string, unknown>);
  ensureKnownKeys(functionName, path, driver, hasAmount ? ['amount'] : ['growthRate']);
  const value = hasAmount
    ? (driver as { amount: unknown }).amount
    : (driver as { growthRate: unknown }).growthRate;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InputError(
      `${functionName}: ${path}.${hasAmount ? 'amount' : 'growthRate'} must be a finite number. Received ${value === null ? 'null' : typeof value === 'number' ? String(value) : typeof value}.`,
      { code: ErrorCode.InputWrongType, context: { field: path } },
    );
  }
  return hasAmount ? (value as number) : priorRevenue * (1 + (value as number));
}

function requireRate(functionName: string, path: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new InputError(
      `${functionName}: ${path} must be a finite rate in [0, 1). Received ${value === null ? 'null' : String(value)}.`,
      { code: ErrorCode.InputOutOfRange, context: { field: path } },
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// operatingForecast
// ---------------------------------------------------------------------------------------------------

/** One forecast period's explicit drivers. */
export interface OperatingForecastPeriod {
  periodLabel: string;
  revenue: RevenueDriver;
  /** Operating income as a fraction of revenue. */
  operatingMargin: number;
  taxRate: number;
  depreciationAndAmortization: AmountDriver;
  capitalExpenditure: AmountDriver;
  increaseInNetWorkingCapital: AmountDriver;
  /** Enables the FCFE column (with interestExpense). */
  netBorrowing?: number;
  /** Enables net income and (with netBorrowing) FCFE. */
  interestExpense?: number;
}

/** Input for {@link operatingForecast}. */
export interface OperatingForecastInput {
  /** The revenue base the first growth-driven period grows FROM (the last historical revenue). */
  baseRevenue: number;
  periods: readonly OperatingForecastPeriod[];
}

/** One forecast row — every derived figure alongside the drivers that produced it. */
export interface OperatingForecastRow {
  periodLabel: string;
  revenue: number;
  operatingIncome: number;
  taxes: number;
  interestExpense?: number;
  netIncome?: number;
  netIncomeAbsentReason?: string;
  depreciationAndAmortization: number;
  capitalExpenditure: number;
  increaseInNetWorkingCapital: number;
  freeCashFlowToFirm: number;
  freeCashFlowToEquity?: number;
  freeCashFlowToEquityAbsentReason?: string;
}

/** Result of {@link operatingForecast}. */
export interface OperatingForecastResult {
  diagnostics: {
    /** One warning per row output disabled by an absent driver. */
    warnings: string[];
  };
  rows: OperatingForecastRow[];
  /** The drivers, echoed verbatim per period. */
  assumptions: { baseRevenue: number; periods: readonly OperatingForecastPeriod[] };
}

const FORECAST_EXAMPLE =
  "operatingForecast({ baseRevenue: 1_000, periods: [{ periodLabel: 'FY1', revenue: { growthRate: 0.08 }, operatingMargin: 0.18, taxRate: 0.21, depreciationAndAmortization: { fractionOfRevenue: 0.045 }, capitalExpenditure: { fractionOfRevenue: 0.07 }, increaseInNetWorkingCapital: { fractionOfRevenue: 0.01 } }] })";

/**
 * Revenue, margins, taxes, working capital, capital expenditure, depreciation, and the resulting
 * FCFF (and FCFE where the financing drivers are supplied) — from EXPLICIT per-period drivers.
 * FCFF taxes operating income at the period's rate (the {@link freeCashFlowToFirm} primitive);
 * net income and FCFE additionally need the period's interest expense, stated, never assumed zero.
 */
export function operatingForecast(input: OperatingForecastInput): OperatingForecastResult {
  requireArgumentObject('operatingForecast', 'input', input);
  ensureKnownKeys('operatingForecast', 'input', input, ['baseRevenue', 'periods']);
  requireFiniteFields(
    'operatingForecast',
    input as unknown as Record<string, unknown>,
    ['baseRevenue'],
    {
      exampleCall: FORECAST_EXAMPLE,
    },
  );
  if (!Array.isArray(input.periods) || input.periods.length === 0) {
    throw new InputError(
      `operatingForecast: periods must be a non-empty array of explicit driver sets.\n  e.g. ${FORECAST_EXAMPLE}`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'periods' } },
    );
  }
  let priorRevenue = input.baseRevenue;
  const rows: OperatingForecastRow[] = input.periods.map((period, index) => {
    const path = `periods[${index}]`;
    requireArgumentObject('operatingForecast', path, period);
    ensureKnownKeys('operatingForecast', path, period, [
      'periodLabel',
      'revenue',
      'operatingMargin',
      'taxRate',
      'depreciationAndAmortization',
      'capitalExpenditure',
      'increaseInNetWorkingCapital',
      'netBorrowing',
      'interestExpense',
    ]);
    if (typeof period.periodLabel !== 'string' || period.periodLabel.length === 0) {
      throw new InputError(`operatingForecast: ${path}.periodLabel must be a non-empty string.`, {
        code: ErrorCode.InputWrongType,
        context: { field: `${path}.periodLabel` },
      });
    }
    const revenue = resolveRevenue(
      'operatingForecast',
      `${path}.revenue`,
      period.revenue,
      priorRevenue,
    );
    priorRevenue = revenue;
    if (typeof period.operatingMargin !== 'number' || !Number.isFinite(period.operatingMargin)) {
      throw new InputError(
        `operatingForecast: ${path}.operatingMargin must be a finite fraction of revenue. Received ${period.operatingMargin === null ? 'null' : String(period.operatingMargin)}.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.operatingMargin` } },
      );
    }
    requireRate('operatingForecast', `${path}.taxRate`, period.taxRate);
    for (const field of ['netBorrowing', 'interestExpense'] as const) {
      const value = period[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new InputError(
          `operatingForecast: ${path}.${field} must be a finite number when provided. Received ${value === null ? 'null' : String(value)}.`,
          { code: ErrorCode.InputWrongType, context: { field: `${path}.${field}` } },
        );
      }
    }
    const operatingIncome = revenue * period.operatingMargin;
    const depreciationAndAmortization = resolveDriver(
      'operatingForecast',
      `${path}.depreciationAndAmortization`,
      period.depreciationAndAmortization,
      revenue,
    );
    const capitalExpenditure = resolveDriver(
      'operatingForecast',
      `${path}.capitalExpenditure`,
      period.capitalExpenditure,
      revenue,
    );
    const increaseInNetWorkingCapital = resolveDriver(
      'operatingForecast',
      `${path}.increaseInNetWorkingCapital`,
      period.increaseInNetWorkingCapital,
      revenue,
    );
    const firmFlow = freeCashFlowToFirm({
      operatingIncome,
      taxRate: period.taxRate,
      depreciationAndAmortization,
      capitalExpenditure,
      increaseInNetWorkingCapital,
    });
    const row: OperatingForecastRow = {
      periodLabel: period.periodLabel,
      revenue,
      operatingIncome,
      taxes: operatingIncome * period.taxRate,
      depreciationAndAmortization,
      capitalExpenditure,
      increaseInNetWorkingCapital,
      freeCashFlowToFirm: firmFlow,
    };
    if (period.interestExpense !== undefined) {
      row.interestExpense = period.interestExpense;
      const pretaxIncome = operatingIncome - period.interestExpense;
      row.netIncome = pretaxIncome * (1 - period.taxRate);
    } else {
      row.netIncomeAbsentReason =
        'interestExpense was not supplied — net income needs the financing cost, and zero is not assumed';
    }
    if (period.interestExpense !== undefined && period.netBorrowing !== undefined) {
      row.freeCashFlowToEquity = freeCashFlowToEquity({
        netIncome: row.netIncome!,
        depreciationAndAmortization,
        capitalExpenditure,
        increaseInNetWorkingCapital,
        netBorrowing: period.netBorrowing,
      });
    } else {
      row.freeCashFlowToEquityAbsentReason =
        'freeCashFlowToEquity needs both interestExpense and netBorrowing — neither is assumed zero';
    }
    return row;
  });
  const warnings: string[] = [];
  for (const row of rows) {
    if (row.netIncomeAbsentReason !== undefined) {
      warnings.push(`${row.periodLabel}: ${row.netIncomeAbsentReason}`);
    }
    if (row.freeCashFlowToEquityAbsentReason !== undefined) {
      warnings.push(`${row.periodLabel}: ${row.freeCashFlowToEquityAbsentReason}`);
    }
  }
  return {
    diagnostics: { warnings },
    rows,
    assumptions: { baseRevenue: input.baseRevenue, periods: input.periods },
  };
}

// ---------------------------------------------------------------------------------------------------
// projectFinancialStatements
// ---------------------------------------------------------------------------------------------------

/** One projected period's explicit drivers — operating AND balance-sheet. */
export interface StatementProjectionPeriod {
  periodLabel: string;
  revenue: RevenueDriver;
  operatingMargin: number;
  taxRate: number;
  /** Explicit financing cost for the period. */
  interestExpense: number;
  depreciationAndAmortization: AmountDriver;
  capitalExpenditure: AmountDriver;
  /** Operating working-capital balances (cash is NOT working capital here — it is the balancer). */
  accountsReceivable: AmountDriver;
  inventory: AmountDriver;
  accountsPayable: AmountDriver;
  /** New borrowing minus repayments. */
  netBorrowing: number;
  dividendsPaid: number;
}

/** One projected period's three articulated statements (a closed forecast contract). */
export interface ProjectedStatements {
  periodLabel: string;
  income: {
    revenue: number;
    operatingIncome: number;
    interestExpense: number;
    pretaxIncome: number;
    incomeTaxExpense: number;
    netIncome: number;
  };
  balance: {
    cashAndCashEquivalents: number;
    accountsReceivable: number;
    inventory: number;
    propertyPlantEquipmentNet: number;
    otherAssets: number;
    totalAssets: number;
    accountsPayable: number;
    totalDebt: number;
    otherLiabilities: number;
    totalLiabilities: number;
    totalEquity: number;
  };
  cashFlow: {
    netIncome: number;
    depreciationAndAmortization: number;
    increaseInNetWorkingCapital: number;
    operatingCashFlow: number;
    capitalExpenditure: number;
    investingCashFlow: number;
    netBorrowing: number;
    dividendsPaid: number;
    financingCashFlow: number;
    netChangeInCash: number;
  };
  freeCashFlowToFirm: number;
  freeCashFlowToEquity: number;
}

/** Input for {@link projectFinancialStatements}. */
export interface ProjectStatementsInput {
  /** The typed historical anchor — beginning balances come from HERE, not from an assumption. */
  baseStatements: FinancialStatements;
  periods: readonly StatementProjectionPeriod[];
}

/** Result of {@link projectFinancialStatements}. */
export interface ProjectStatementsResult {
  diagnostics: {
    /** Any period whose identity residual exceeds floating-point dust. */
    warnings: string[];
  };
  statements: ProjectedStatements[];
  /**
   * The named balancing item. CASH absorbs the residual of the articulated statements — the
   * identity `assets = liabilities + equity` then holds by construction, and the proof is the
   * per-period `identityDifference` (floating-point dust, gated in tests).
   */
  balancingItem: 'cash';
  reconciliation: Array<{ periodLabel: string; identityDifference: number }>;
  assumptions: { periods: readonly StatementProjectionPeriod[] };
}

/**
 * A three-statement projection from a typed historical base and explicit per-period drivers.
 *
 * The articulation, written out (Δ = period change):
 *
 *     ΔtotalAssets = Δcash + ΔAR + Δinventory + ΔPPE
 *                  = (CFO + CFI + CFF) + ΔAR + Δinventory + (capex − D&A)
 *                  = netIncome + ΔAP + netBorrowing − dividends
 *     ΔtotalLiabilities + Δequity = ΔAP + netBorrowing + netIncome − dividends
 *
 * — identical, so the balance sheet ties EXACTLY with cash as the named balancer. Other assets and
 * other liabilities are carried CONSTANT from the base (disclosed), never grown silently.
 */
export function projectFinancialStatements(input: ProjectStatementsInput): ProjectStatementsResult {
  requireArgumentObject('projectFinancialStatements', 'input', input);
  ensureKnownKeys('projectFinancialStatements', 'input', input, ['baseStatements', 'periods']);
  requireFinancialStatements('projectFinancialStatements', input.baseStatements);
  if (!Array.isArray(input.periods) || input.periods.length === 0) {
    throw new InputError(
      `projectFinancialStatements: periods must be a non-empty array of explicit driver sets.`,
      { code: ErrorCode.InputOutOfRange, context: { field: 'periods' } },
    );
  }
  const base = input.baseStatements;
  const need = (value: number | undefined, field: string): number => {
    if (value === undefined) {
      throw new InputError(
        `projectFinancialStatements: baseStatements.balance.${field} is required — the projection rolls forward from the reported balance, it does not invent one.`,
        {
          code: ErrorCode.InputMissingField,
          context: { field: `baseStatements.balance.${field}` },
        },
      );
    }
    return value;
  };
  let cash = base.balance.cashAndCashEquivalents;
  let accountsReceivable = need(base.balance.accountsReceivable, 'accountsReceivable');
  let inventory = need(base.balance.inventory, 'inventory');
  let accountsPayable = need(base.balance.accountsPayable, 'accountsPayable');
  let propertyPlantEquipment = need(
    base.balance.propertyPlantEquipmentNet,
    'propertyPlantEquipmentNet',
  );
  const baseDebt = (() => {
    if (base.balance.totalDebt !== undefined) return base.balance.totalDebt;
    if (base.balance.shortTermDebt !== undefined && base.balance.longTermDebt !== undefined) {
      return base.balance.shortTermDebt + base.balance.longTermDebt;
    }
    throw new InputError(
      `projectFinancialStatements: baseStatements.balance needs totalDebt (or both stated maturities) — the debt roll starts from the reported figure.`,
      { code: ErrorCode.InputMissingField, context: { field: 'baseStatements.balance.totalDebt' } },
    );
  })();
  let debt = baseDebt;
  let equity = base.balance.totalEquity;
  // Everything the drivers do not model is carried CONSTANT and disclosed as such.
  const otherAssets =
    base.balance.totalAssets - (cash + accountsReceivable + inventory + propertyPlantEquipment);
  const otherLiabilities = base.balance.totalLiabilities - (accountsPayable + baseDebt);
  let priorRevenue = base.income.revenue;

  const statements: ProjectedStatements[] = [];
  const reconciliation: ProjectStatementsResult['reconciliation'] = [];
  input.periods.forEach((period, index) => {
    const path = `periods[${index}]`;
    requireArgumentObject('projectFinancialStatements', path, period);
    ensureKnownKeys('projectFinancialStatements', path, period, [
      'periodLabel',
      'revenue',
      'operatingMargin',
      'taxRate',
      'interestExpense',
      'depreciationAndAmortization',
      'capitalExpenditure',
      'accountsReceivable',
      'inventory',
      'accountsPayable',
      'netBorrowing',
      'dividendsPaid',
    ]);
    if (typeof period.periodLabel !== 'string' || period.periodLabel.length === 0) {
      throw new InputError(
        `projectFinancialStatements: ${path}.periodLabel must be a non-empty string.`,
        { code: ErrorCode.InputWrongType, context: { field: `${path}.periodLabel` } },
      );
    }
    requireRate('projectFinancialStatements', `${path}.taxRate`, period.taxRate);
    for (const field of [
      'operatingMargin',
      'interestExpense',
      'netBorrowing',
      'dividendsPaid',
    ] as const) {
      const value = period[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new InputError(
          `projectFinancialStatements: ${path}.${field} must be a finite number. Received ${value === null ? 'null' : String(value)}.`,
          { code: ErrorCode.InputWrongType, context: { field: `${path}.${field}` } },
        );
      }
    }
    const revenue = resolveRevenue(
      'projectFinancialStatements',
      `${path}.revenue`,
      period.revenue,
      priorRevenue,
    );
    priorRevenue = revenue;
    const operatingIncome = revenue * period.operatingMargin;
    const pretaxIncome = operatingIncome - period.interestExpense;
    const incomeTaxExpense = pretaxIncome * period.taxRate;
    const netIncome = pretaxIncome - incomeTaxExpense;
    const depreciationAndAmortization = resolveDriver(
      'projectFinancialStatements',
      `${path}.depreciationAndAmortization`,
      period.depreciationAndAmortization,
      revenue,
    );
    const capitalExpenditure = resolveDriver(
      'projectFinancialStatements',
      `${path}.capitalExpenditure`,
      period.capitalExpenditure,
      revenue,
    );
    const nextReceivable = resolveDriver(
      'projectFinancialStatements',
      `${path}.accountsReceivable`,
      period.accountsReceivable,
      revenue,
    );
    const nextInventory = resolveDriver(
      'projectFinancialStatements',
      `${path}.inventory`,
      period.inventory,
      revenue,
    );
    const nextPayable = resolveDriver(
      'projectFinancialStatements',
      `${path}.accountsPayable`,
      period.accountsPayable,
      revenue,
    );
    const increaseInNetWorkingCapital =
      nextReceivable +
      nextInventory -
      nextPayable -
      (accountsReceivable + inventory - accountsPayable);
    const operatingCashFlow = netIncome + depreciationAndAmortization - increaseInNetWorkingCapital;
    const investingCashFlow = -capitalExpenditure;
    const financingCashFlow = period.netBorrowing - period.dividendsPaid;
    const netChangeInCash = operatingCashFlow + investingCashFlow + financingCashFlow;

    cash += netChangeInCash;
    accountsReceivable = nextReceivable;
    inventory = nextInventory;
    accountsPayable = nextPayable;
    propertyPlantEquipment += capitalExpenditure - depreciationAndAmortization;
    debt += period.netBorrowing;
    equity += netIncome - period.dividendsPaid;

    const totalAssets =
      cash + accountsReceivable + inventory + propertyPlantEquipment + otherAssets;
    const totalLiabilities = accountsPayable + debt + otherLiabilities;
    reconciliation.push({
      periodLabel: period.periodLabel,
      identityDifference: totalAssets - (totalLiabilities + equity),
    });
    statements.push({
      periodLabel: period.periodLabel,
      income: {
        revenue,
        operatingIncome,
        interestExpense: period.interestExpense,
        pretaxIncome,
        incomeTaxExpense,
        netIncome,
      },
      balance: {
        cashAndCashEquivalents: cash,
        accountsReceivable,
        inventory,
        propertyPlantEquipmentNet: propertyPlantEquipment,
        otherAssets,
        totalAssets,
        accountsPayable,
        totalDebt: debt,
        otherLiabilities,
        totalLiabilities,
        totalEquity: equity,
      },
      cashFlow: {
        netIncome,
        depreciationAndAmortization,
        increaseInNetWorkingCapital,
        operatingCashFlow,
        capitalExpenditure,
        investingCashFlow,
        netBorrowing: period.netBorrowing,
        dividendsPaid: period.dividendsPaid,
        financingCashFlow,
        netChangeInCash,
      },
      freeCashFlowToFirm: freeCashFlowToFirm({
        operatingIncome,
        taxRate: period.taxRate,
        depreciationAndAmortization,
        capitalExpenditure,
        increaseInNetWorkingCapital,
      }),
      freeCashFlowToEquity: freeCashFlowToEquity({
        netIncome,
        depreciationAndAmortization,
        capitalExpenditure,
        increaseInNetWorkingCapital,
        netBorrowing: period.netBorrowing,
      }),
    });
  });
  return requireRepresentableResult('projectFinancialStatements', {
    diagnostics: {
      warnings: reconciliation
        .filter((row) => Math.abs(row.identityDifference) > 1e-6)
        .map((row) => `${row.periodLabel}: identity residual ${row.identityDifference}`),
    },
    statements,
    balancingItem: 'cash',
    reconciliation,
    assumptions: { periods: input.periods },
  });
}

// ---------------------------------------------------------------------------------------------------
// discountedCashFlowFromStatements
// ---------------------------------------------------------------------------------------------------

/** Input for {@link discountedCashFlowFromStatements}. */
export interface DiscountedCashFlowFromStatementsInput {
  /** The statement projection (see {@link projectFinancialStatements}). */
  projection: ProjectStatementsInput;
  /** Everything the direct DCF needs EXCEPT the flows — those come from the projection. */
  valuation: Omit<DiscountedCashFlowInput, 'projectedCashFlows'>;
}

/** Result of {@link discountedCashFlowFromStatements}. */
export interface DiscountedCashFlowFromStatementsResult {
  assumptions: {
    /** Which flow column fed the valuation, decided by the basis — never relabeled. */
    cashFlowsUsed: 'freeCashFlowToFirm' | 'freeCashFlowToEquity';
    projectedPeriodCount: number;
  };
  diagnostics: { warnings: string[] };
  projection: ProjectStatementsResult;
  /** Which flow column fed the valuation, decided by the valuation basis — never relabeled. */
  cashFlowsUsed: 'freeCashFlowToFirm' | 'freeCashFlowToEquity';
  valuation: DiscountedCashFlowResult;
}

/**
 * The composition the acceptance law names: project the statements, take the emitted FCFF (firm
 * basis) or FCFE (equity basis) at whole-year offsets, and hand them to the direct
 * {@link discountedCashFlow} — so the composed valuation IS a direct valuation of the projected
 * flows, reproducible by construction.
 */
export function discountedCashFlowFromStatements(
  input: DiscountedCashFlowFromStatementsInput,
): DiscountedCashFlowFromStatementsResult {
  requireArgumentObject('discountedCashFlowFromStatements', 'input', input);
  ensureKnownKeys('discountedCashFlowFromStatements', 'input', input, ['projection', 'valuation']);
  const projection = projectFinancialStatements(input.projection);
  requireArgumentObject('discountedCashFlowFromStatements', 'valuation', input.valuation);
  const basis = (input.valuation as { valuationBasis?: unknown }).valuationBasis;
  if (basis !== 'firm' && basis !== 'equity') {
    throw new InputError(
      `discountedCashFlowFromStatements: valuation.valuationBasis must be 'firm' (uses the projected FCFF) | 'equity' (uses the projected FCFE). Received ${basis === null ? 'null' : JSON.stringify(basis)}.`,
      { code: ErrorCode.InputInvalidEnum, context: { field: 'valuation.valuationBasis' } },
    );
  }
  const cashFlowsUsed = basis === 'firm' ? 'freeCashFlowToFirm' : 'freeCashFlowToEquity';
  const projectedCashFlows = projection.statements.map((period, index) => ({
    timeYears: index + 1,
    amount: period[cashFlowsUsed],
  }));
  const valuation = discountedCashFlow({
    ...(input.valuation as DiscountedCashFlowInput),
    projectedCashFlows,
  });
  return requireRepresentableResult('discountedCashFlowFromStatements', {
    assumptions: { cashFlowsUsed, projectedPeriodCount: projection.statements.length },
    diagnostics: { warnings: [] },
    projection,
    cashFlowsUsed,
    valuation,
  });
}
