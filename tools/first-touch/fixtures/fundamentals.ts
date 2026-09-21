/**
 * FC2 — first-touch fixtures for `@totalfinance/fundamentals`: the explain-bearing ratio heads and
 * the multi-arg statement guards. Every thunk builds FRESH objects per call (probes mutate what
 * they are given), so the statements are built by functions, never shared literals.
 */

import { type FixtureThunk } from '../inputs.js';

const AVAILABLE_PRIOR = Date.UTC(2025, 1, 24);
const AVAILABLE_CURRENT = Date.UTC(2026, 1, 23);

function period(fiscalYear: number, availableTimestampMs: number): Record<string, unknown> {
  return {
    periodStartDate: `${fiscalYear}-01-01`,
    periodEndDate: `${fiscalYear}-12-31`,
    fiscalYear,
    periodType: 'year',
    availableTimestampMs,
    currency: 'USD',
    monetaryScale: 1,
  };
}

/** A complete, internally consistent statement set (identities tie exactly). */
function statementsFor(fiscalYear: number, availableTimestampMs: number): Record<string, unknown> {
  return {
    income: {
      period: period(fiscalYear, availableTimestampMs),
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
      period: period(fiscalYear, availableTimestampMs),
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
      period: period(fiscalYear, availableTimestampMs),
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
}

const current = (): Record<string, unknown> => statementsFor(2025, AVAILABLE_CURRENT);
const prior = (): Record<string, unknown> => statementsFor(2024, AVAILABLE_PRIOR);
const market = (): Record<string, unknown> => ({
  observedTimestampMs: AVAILABLE_CURRENT + 24 * 60 * 60 * 1000,
  sharePrice: 20,
  sharesOutstanding: 98,
});

const priorPrior = (): Record<string, unknown> => statementsFor(2023, Date.UTC(2024, 1, 25));

/** Four consecutive FY2025 fiscal quarters (flows sum to plausible annual figures). */
function quarters(): Record<string, unknown>[] {
  return [1, 2, 3, 4].map((fiscalQuarter) => {
    const endMonth = String(fiscalQuarter * 3).padStart(2, '0');
    const endDay = fiscalQuarter === 2 || fiscalQuarter === 3 ? '30' : '31';
    const p = {
      periodEndDate: `2025-${endMonth}-${endDay}`,
      fiscalYear: 2025,
      fiscalQuarter,
      periodType: 'quarter',
      availableTimestampMs: Date.UTC(2025, fiscalQuarter * 3, 15),
      currency: 'USD',
      monetaryScale: 1,
    };
    return {
      income: {
        period: p,
        revenue: 250,
        operatingIncome: 45,
        netIncome: 33,
        dilutedSharesOutstanding: 98,
      },
      balance: {
        period: p,
        cashAndCashEquivalents: 140,
        totalAssets: 1_240,
        totalLiabilities: 560,
        totalEquity: 680,
      },
      cashFlow: {
        period: p,
        operatingCashFlow: 42,
        investingCashFlow: -25,
        financingCashFlow: -10,
        capitalExpenditure: 17,
      },
    };
  });
}

const single = (): unknown[] => [{ statements: current() }];
const pair = (): unknown[] => [{ current: current(), prior: prior() }];
const dayMetric = (): unknown[] => [{ current: current(), prior: prior(), periodDays: 365 }];
const multiple = (): unknown[] => [{ statements: current(), marketObservation: market() }];

export const FUNDAMENTALS_FIXTURES: Record<string, FixtureThunk> = {
  // Multi-arg statement guards — the vendor-adapter surface.
  'fundamentals.requireIncomeStatement': () => ['deepSweepProbe', current()['income']],
  'fundamentals.requireBalanceSheet': () => ['deepSweepProbe', current()['balance']],
  'fundamentals.requireCashFlowStatement': () => ['deepSweepProbe', current()['cashFlow']],
  'fundamentals.requireFinancialStatements': () => ['deepSweepProbe', current()],
  'fundamentals.requireMarketObservation': () => ['deepSweepProbe', market()],

  // Explain-bearing ratio heads: profitability.
  'fundamentals.grossMargin': single,
  'fundamentals.operatingMargin': single,
  'fundamentals.ebitdaMargin': single,
  'fundamentals.netProfitMargin': single,
  // Returns.
  'fundamentals.returnOnAssets': pair,
  'fundamentals.returnOnEquity': pair,
  'fundamentals.returnOnInvestedCapital': pair,
  'fundamentals.returnOnCapitalEmployed': pair,
  // Liquidity.
  'fundamentals.currentRatio': single,
  'fundamentals.quickRatio': single,
  'fundamentals.cashRatio': single,
  // Leverage and coverage.
  'fundamentals.debtToEquity': single,
  'fundamentals.debtToAssets': single,
  'fundamentals.netDebtToEbitda': single,
  'fundamentals.interestCoverage': single,
  'fundamentals.debtServiceCoverage': () => [{ statements: current(), debtServiceAmount: 60 }],
  // Efficiency and day metrics.
  'fundamentals.assetTurnover': pair,
  'fundamentals.inventoryTurnover': pair,
  'fundamentals.receivablesTurnover': pair,
  'fundamentals.payablesTurnover': pair,
  'fundamentals.daysInventoryOutstanding': dayMetric,
  'fundamentals.daysSalesOutstanding': dayMetric,
  'fundamentals.daysPayablesOutstanding': dayMetric,
  'fundamentals.cashConversionCycle': dayMetric,
  // Quality.
  'fundamentals.accrualRatio': pair,
  'fundamentals.cashFlowToNetIncome': single,
  'fundamentals.cashReturnOnAssets': pair,
  // Per-share.
  'fundamentals.earningsPerShare': single,
  'fundamentals.bookValuePerShare': single,
  'fundamentals.revenuePerShare': single,
  'fundamentals.freeCashFlowPerShare': single,
  // Valuation multiples (market side + the point-in-time law).
  'fundamentals.priceToEarnings': multiple,
  'fundamentals.priceToBook': multiple,
  'fundamentals.priceToSales': multiple,
  'fundamentals.enterpriseValueToRevenue': multiple,
  'fundamentals.enterpriseValueToEbitda': multiple,
  'fundamentals.freeCashFlowYield': multiple,
  'fundamentals.earningsYield': multiple,
  'fundamentals.dividendYield': multiple,

  // Analysis exports — the envelope/report fixtures the conformance sweep demands.
  'fundamentals.selectFundamentalSnapshot': () => [
    {
      series: { statements: [priorPrior(), prior(), current()] },
      asOf: Date.UTC(2026, 5, 1),
      restatementPolicy: 'latest-available',
    },
  ],
  'fundamentals.trailingTwelveMonthStatements': () => [{ statements: quarters() }],
  'fundamentals.fundamentalGrowth': () => [
    {
      observations: [
        { periodEndDate: '2024-12-31', amount: 900 },
        { periodEndDate: '2025-12-31', amount: 1_000 },
      ],
    },
  ],
  'fundamentals.commonSizeFinancialStatements': single,
  'fundamentals.reconcileFinancialStatements': () => [
    { statements: current(), priorStatements: prior() },
  ],
  'fundamentals.perShareFundamentals': single,
  'fundamentals.piotroskiFScore': () => [
    { current: current(), prior: prior(), priorPrior: priorPrior() },
  ],
  'fundamentals.altmanZScore': () => [{ statements: current(), variant: 'private-manufacturing' }],
  'fundamentals.beneishMScore': pair,
  'fundamentals.analyzeFundamentals': () => [
    {
      statements: [priorPrior(), prior(), current()],
      marketSnapshot: market(),
      asOf: Date.UTC(2026, 5, 1),
      restatementPolicy: 'latest-available',
      periodDays: 365,
    },
  ],
};
