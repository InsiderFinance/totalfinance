/**
 * FC2 test fixture — three annual periods of one synthetic company, constructed so every
 * accounting identity ties EXACTLY and every golden below is recomputable by hand:
 *
 *   - balance identity:  totalAssets = totalLiabilities + totalEquity, every year;
 *   - articulation:      grossProfit = revenue - costOfRevenue and
 *                        operatingIncome = grossProfit - operatingExpenses, every year;
 *   - cash articulation: Δcash = operating + investing + financing, FY2024 and FY2025.
 */

import type { FinancialStatements } from '../src/statements.js';
import type { FundamentalPeriod } from '../src/index.js';

function annualPeriod(
  fiscalYear: number,
  availableTimestampMs: number,
  overrides: Partial<FundamentalPeriod> = {},
): FundamentalPeriod {
  return {
    periodStartDate: `${fiscalYear}-01-01`,
    periodEndDate: `${fiscalYear}-12-31`,
    fiscalYear,
    periodType: 'year',
    availableTimestampMs,
    currency: 'USD',
    monetaryScale: 1,
    ...overrides,
  };
}

/** Availability instants: each annual filing lands late February of the following year. */
export const AVAILABLE_2023 = Date.UTC(2024, 1, 25);
export const AVAILABLE_2024 = Date.UTC(2025, 1, 24);
export const AVAILABLE_2025 = Date.UTC(2026, 1, 23);

export const FY2023: FinancialStatements = {
  income: {
    period: annualPeriod(2023, AVAILABLE_2023),
    revenue: 800,
    costOfRevenue: 480,
    grossProfit: 320,
    operatingExpenses: 200,
    operatingIncome: 120,
    interestExpense: 10,
    incomeTaxExpense: 22,
    netIncome: 88,
    sellingGeneralAdministrativeExpense: 120,
    dilutedSharesOutstanding: 100,
  },
  balance: {
    period: annualPeriod(2023, AVAILABLE_2023),
    cashAndCashEquivalents: 100,
    shortTermInvestments: 20,
    accountsReceivable: 80,
    inventory: 60,
    currentAssets: 300,
    propertyPlantEquipmentNet: 400,
    totalAssets: 1_000,
    currentLiabilities: 150,
    accountsPayable: 40,
    shortTermDebt: 30,
    longTermDebt: 270,
    totalLiabilities: 500,
    totalEquity: 500,
    retainedEarnings: 200,
  },
  cashFlow: {
    period: annualPeriod(2023, AVAILABLE_2023),
    operatingCashFlow: 120,
    investingCashFlow: -80,
    financingCashFlow: -25,
    capitalExpenditure: 55,
    depreciationAndAmortization: 36,
    stockBasedCompensation: 9,
    dividendsPaid: 18,
    shareRepurchases: 0,
  },
};

export const FY2024: FinancialStatements = {
  income: {
    period: annualPeriod(2024, AVAILABLE_2024),
    revenue: 900,
    costOfRevenue: 530,
    grossProfit: 370,
    operatingExpenses: 220,
    operatingIncome: 150,
    interestExpense: 12,
    incomeTaxExpense: 27,
    netIncome: 111,
    sellingGeneralAdministrativeExpense: 130,
    dilutedSharesOutstanding: 100,
  },
  balance: {
    period: annualPeriod(2024, AVAILABLE_2024),
    cashAndCashEquivalents: 120,
    shortTermInvestments: 25,
    accountsReceivable: 95,
    inventory: 70,
    currentAssets: 340,
    propertyPlantEquipmentNet: 420,
    totalAssets: 1_100,
    currentLiabilities: 160,
    accountsPayable: 45,
    shortTermDebt: 35,
    longTermDebt: 265,
    totalLiabilities: 540,
    totalEquity: 560,
    retainedEarnings: 270,
  },
  cashFlow: {
    period: annualPeriod(2024, AVAILABLE_2024),
    // Δcash 2024 = 120 - 100 = 20 = 140 - 90 - 30.
    operatingCashFlow: 140,
    investingCashFlow: -90,
    financingCashFlow: -30,
    capitalExpenditure: 60,
    depreciationAndAmortization: 40,
    stockBasedCompensation: 10,
    dividendsPaid: 20,
    shareRepurchases: 0,
  },
};

export const FY2025: FinancialStatements = {
  income: {
    period: annualPeriod(2025, AVAILABLE_2025),
    revenue: 1_000,
    costOfRevenue: 580,
    grossProfit: 420,
    operatingExpenses: 240,
    operatingIncome: 180,
    interestExpense: 12,
    incomeTaxExpense: 36,
    netIncome: 132,
    sellingGeneralAdministrativeExpense: 140,
    dilutedSharesOutstanding: 98,
  },
  balance: {
    period: annualPeriod(2025, AVAILABLE_2025),
    cashAndCashEquivalents: 150,
    shortTermInvestments: 30,
    accountsReceivable: 100,
    inventory: 75,
    currentAssets: 380,
    propertyPlantEquipmentNet: 450,
    totalAssets: 1_250,
    currentLiabilities: 170,
    accountsPayable: 50,
    shortTermDebt: 30,
    longTermDebt: 250,
    totalLiabilities: 560,
    totalEquity: 690,
    retainedEarnings: 350,
  },
  cashFlow: {
    period: annualPeriod(2025, AVAILABLE_2025),
    // Δcash 2025 = 150 - 120 = 30 = 170 - 100 - 40.
    operatingCashFlow: 170,
    investingCashFlow: -100,
    financingCashFlow: -40,
    capitalExpenditure: 70,
    depreciationAndAmortization: 45,
    stockBasedCompensation: 12,
    dividendsPaid: 25,
    shareRepurchases: 15,
  },
};

/**
 * The SAME FY2025 economics reported in thousands — every amount divided by 1,000 with
 * `monetaryScale: 1_000`. Ratios must not move (the scale-invariance metamorphic law).
 */
export function scaledStatements(statements: FinancialStatements): FinancialStatements {
  const scaleStatement = <T extends { period: FundamentalPeriod }>(statement: T): T => {
    const scaled: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(statement)) {
      if (field === 'period') {
        scaled['period'] = { ...(value as FundamentalPeriod), monetaryScale: 1_000 };
      } else if (typeof value === 'number' && field !== 'dilutedSharesOutstanding') {
        // Share counts are counts, not monetary amounts — they do not rescale.
        scaled[field] = value / 1_000;
      } else {
        scaled[field] = value;
      }
    }
    return scaled as T;
  };
  return {
    income: scaleStatement(statements.income),
    balance: scaleStatement(statements.balance),
    cashFlow: scaleStatement(statements.cashFlow),
  };
}
