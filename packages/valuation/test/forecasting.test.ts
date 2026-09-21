/**
 * FC2 — forecasting: explicit-driver goldens, the three-statement reconciliation (identity ties
 * by construction, verified independently), and the acceptance law that a statement-driven DCF
 * reproduces a direct DCF from the emitted flows.
 */

import { describe, expect, it } from 'vitest';
import type { FinancialStatements } from '@totalfinance/fundamentals';
import {
  discountedCashFlow,
  discountedCashFlowFromStatements,
  operatingForecast,
  projectFinancialStatements,
} from '../src/index.js';

const close = (actual: number, expected: number, tolerance = 1e-10): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

describe('operatingForecast', () => {
  it('derives each row from its explicit drivers (hand golden)', () => {
    const result = operatingForecast({
      baseRevenue: 1_000,
      periods: [
        {
          periodLabel: 'FY1',
          revenue: { growthRate: 0.08 },
          operatingMargin: 0.18,
          taxRate: 0.25,
          depreciationAndAmortization: { fractionOfRevenue: 0.05 },
          capitalExpenditure: { fractionOfRevenue: 0.07 },
          increaseInNetWorkingCapital: { fractionOfRevenue: 0.01 },
          interestExpense: 12,
          netBorrowing: 10,
        },
      ],
    });
    const row = result.rows[0]!;
    close(row.revenue, 1_080);
    close(row.operatingIncome, 194.4);
    close(row.depreciationAndAmortization, 54);
    close(row.capitalExpenditure, 75.6);
    close(row.increaseInNetWorkingCapital, 10.8);
    // FCFF = 194.4 × 0.75 + 54 − 75.6 − 10.8.
    close(row.freeCashFlowToFirm, 194.4 * 0.75 + 54 - 75.6 - 10.8);
    // NI = (194.4 − 12) × 0.75; FCFE = NI + 54 − 75.6 − 10.8 + 10.
    close(row.netIncome!, 182.4 * 0.75);
    close(row.freeCashFlowToEquity!, 182.4 * 0.75 + 54 - 75.6 - 10.8 + 10);
  });

  it('nothing is assumed zero: absent financing drivers disable exactly their outputs', () => {
    const result = operatingForecast({
      baseRevenue: 1_000,
      periods: [
        {
          periodLabel: 'FY1',
          revenue: { amount: 1_100 },
          operatingMargin: 0.2,
          taxRate: 0.25,
          depreciationAndAmortization: { amount: 50 },
          capitalExpenditure: { amount: 80 },
          increaseInNetWorkingCapital: { amount: 10 },
        },
      ],
    });
    const row = result.rows[0]!;
    expect(row.netIncome).toBeUndefined();
    expect(row.netIncomeAbsentReason).toMatch(/zero is not assumed/);
    expect(row.freeCashFlowToEquity).toBeUndefined();
    expect(row.freeCashFlowToEquityAbsentReason).toMatch(/neither is assumed zero/);
    // FCFF needs no financing drivers.
    close(row.freeCashFlowToFirm, 220 * 0.75 + 50 - 80 - 10);
  });
});

/** A typed historical base whose lines the projection rolls forward. */
const BASE_STATEMENTS: FinancialStatements = {
  income: {
    period: {
      periodEndDate: '2025-12-31',
      fiscalYear: 2025,
      periodType: 'year',
      availableTimestampMs: Date.UTC(2026, 1, 23),
      currency: 'USD',
      monetaryScale: 1,
    },
    revenue: 1_000,
    operatingIncome: 180,
    netIncome: 132,
  },
  balance: {
    period: {
      periodEndDate: '2025-12-31',
      fiscalYear: 2025,
      periodType: 'year',
      availableTimestampMs: Date.UTC(2026, 1, 23),
      currency: 'USD',
      monetaryScale: 1,
    },
    cashAndCashEquivalents: 150,
    accountsReceivable: 100,
    inventory: 75,
    accountsPayable: 50,
    propertyPlantEquipmentNet: 450,
    totalAssets: 1_250,
    totalDebt: 280,
    totalLiabilities: 560,
    totalEquity: 690,
  },
  cashFlow: {
    period: {
      periodEndDate: '2025-12-31',
      fiscalYear: 2025,
      periodType: 'year',
      availableTimestampMs: Date.UTC(2026, 1, 23),
      currency: 'USD',
      monetaryScale: 1,
    },
    operatingCashFlow: 170,
    investingCashFlow: -100,
    financingCashFlow: -40,
  },
};

const PROJECTION_PERIODS = [
  {
    periodLabel: 'FY2026',
    revenue: { amount: 1_100 },
    operatingMargin: 0.2,
    taxRate: 0.25,
    interestExpense: 20,
    depreciationAndAmortization: { amount: 50 },
    capitalExpenditure: { amount: 80 },
    accountsReceivable: { amount: 110 },
    inventory: { amount: 80 },
    accountsPayable: { amount: 55 },
    netBorrowing: 0,
    dividendsPaid: 30,
  },
  {
    periodLabel: 'FY2027',
    revenue: { growthRate: 0.1 },
    operatingMargin: 0.21,
    taxRate: 0.25,
    interestExpense: 20,
    depreciationAndAmortization: { amount: 55 },
    capitalExpenditure: { amount: 85 },
    accountsReceivable: { fractionOfRevenue: 0.1 },
    inventory: { fractionOfRevenue: 0.075 },
    accountsPayable: { fractionOfRevenue: 0.05 },
    netBorrowing: 25,
    dividendsPaid: 35,
  },
];

describe('projectFinancialStatements', () => {
  it('FY2026, walked by hand: income, working capital, cash, and the identity', () => {
    const result = projectFinancialStatements({
      baseStatements: BASE_STATEMENTS,
      periods: PROJECTION_PERIODS,
    });
    const year = result.statements[0]!;
    // OI 220, pretax 200, taxes 50, NI 150.
    close(year.income.operatingIncome, 220);
    close(year.income.netIncome, 150);
    // ΔNWC = (110 + 80 − 55) − (100 + 75 − 50) = 10; CFO = 150 + 50 − 10 = 190.
    close(year.cashFlow.increaseInNetWorkingCapital, 10);
    close(year.cashFlow.operatingCashFlow, 190);
    close(year.cashFlow.financingCashFlow, -30);
    // Δcash = 190 − 80 − 30 = 80 → cash 230; PP&E 450 + 80 − 50 = 480; equity 690 + 150 − 30 = 810.
    close(year.cashFlow.netChangeInCash, 80);
    close(year.balance.cashAndCashEquivalents, 230);
    close(year.balance.propertyPlantEquipmentNet, 480);
    close(year.balance.totalEquity, 810);
    // otherAssets = 1,250 − (150+100+75+450) = 475 carried constant; TA = 230+110+80+480+475.
    close(year.balance.otherAssets, 475);
    close(year.balance.totalAssets, 1_375);
    close(year.balance.totalLiabilities, 55 + 280 + 230);
    // FCFF = 220×0.75 + 50 − 80 − 10 = 125; FCFE = 150 + 50 − 80 − 10 + 0 = 110.
    close(year.freeCashFlowToFirm, 125);
    close(year.freeCashFlowToEquity, 110);
  });

  it('the balance sheet ties EVERY period, and the balancing item is named', () => {
    const result = projectFinancialStatements({
      baseStatements: BASE_STATEMENTS,
      periods: PROJECTION_PERIODS,
    });
    expect(result.balancingItem).toBe('cash');
    for (const row of result.reconciliation) {
      expect(Math.abs(row.identityDifference)).toBeLessThanOrEqual(1e-9);
    }
    // Independent check on the last period, not just the reported difference.
    const last = result.statements[result.statements.length - 1]!;
    close(last.balance.totalAssets, last.balance.totalLiabilities + last.balance.totalEquity, 1e-9);
  });
});

describe('discountedCashFlowFromStatements', () => {
  it('reproduces a direct DCF from the emitted cash flows (the acceptance law)', () => {
    const composed = discountedCashFlowFromStatements({
      projection: { baseStatements: BASE_STATEMENTS, periods: PROJECTION_PERIODS },
      valuation: {
        valuationBasis: 'firm',
        valuationDate: '2025-12-31',
        currency: 'USD',
        annualDiscountRate: 0.09,
        compounding: 'annual',
        terminalValueMethod: {
          method: 'exit-multiple',
          terminalMetricAmount: 300,
          exitMultiple: 8,
        },
      },
    });
    expect(composed.cashFlowsUsed).toBe('freeCashFlowToFirm');
    const direct = discountedCashFlow({
      valuationBasis: 'firm',
      valuationDate: '2025-12-31',
      currency: 'USD',
      projectedCashFlows: composed.projection.statements.map((period, index) => ({
        timeYears: index + 1,
        amount: period.freeCashFlowToFirm,
      })),
      annualDiscountRate: 0.09,
      compounding: 'annual',
      terminalValueMethod: { method: 'exit-multiple', terminalMetricAmount: 300, exitMultiple: 8 },
    });
    if (composed.valuation.valuationBasis !== 'firm' || direct.valuationBasis !== 'firm') {
      throw new Error('basis');
    }
    close(composed.valuation.enterpriseValue, direct.enterpriseValue, 1e-12);
    // The equity basis uses the OTHER column — never relabeled.
    const equity = discountedCashFlowFromStatements({
      projection: { baseStatements: BASE_STATEMENTS, periods: PROJECTION_PERIODS },
      valuation: {
        valuationBasis: 'equity',
        valuationDate: '2025-12-31',
        currency: 'USD',
        annualDiscountRate: 0.1,
        compounding: 'annual',
        terminalValueMethod: {
          method: 'exit-multiple',
          terminalMetricAmount: 150,
          exitMultiple: 10,
        },
      },
    });
    expect(equity.cashFlowsUsed).toBe('freeCashFlowToEquity');
  });
});
