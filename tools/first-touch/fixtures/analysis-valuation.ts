/**
 * FC2 — analysis fixtures for `@totalfinance/valuation`: happy-path argument lists for every
 * analysis-role export, so the conformance sweep checks each one's report claim. Thunks build
 * FRESH inputs per call; probes mutate what they are given.
 */

import { type FixtureThunk } from '../inputs.js';

/** The direct-DCF input every DCF-family fixture starts from. */
const dcfInput = (): Record<string, unknown> => ({
  valuationBasis: 'firm',
  valuationDate: '2026-12-31',
  currency: 'USD',
  projectedCashFlows: [
    { timeYears: 1, amount: 120 },
    { timeYears: 2, amount: 135 },
  ],
  annualDiscountRate: 0.09,
  compounding: 'annual',
  terminalValueMethod: {
    method: 'perpetual-growth',
    terminalCashFlow: 135,
    perpetualGrowthRate: 0.025,
  },
});

const baseStatements = (): Record<string, unknown> => {
  const period = {
    periodEndDate: '2025-12-31',
    fiscalYear: 2025,
    periodType: 'year',
    availableTimestampMs: Date.UTC(2026, 1, 23),
    currency: 'USD',
    monetaryScale: 1,
  };
  return {
    income: { period, revenue: 1_000, operatingIncome: 180, netIncome: 132 },
    balance: {
      period,
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
    cashFlow: { period, operatingCashFlow: 170, investingCashFlow: -100, financingCashFlow: -40 },
  };
};

const projectionPeriods = (): Record<string, unknown>[] => [
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
];

export const ANALYSIS_VALUATION_FIXTURES: Record<string, FixtureThunk> = {
  'valuation.weightedAverageCostOfCapital': () => [
    {
      components: [
        { label: 'equity', marketValue: 700, annualCostOfCapital: 0.1 },
        { label: 'debt', marketValue: 300, annualCostOfCapital: 0.045 },
      ],
    },
  ],
  'valuation.discountedCashFlow': () => [dcfInput()],
  'valuation.reverseDiscountedCashFlow': () => [
    {
      discountedCashFlowInput: dcfInput(),
      target: { variable: 'annual-discount-rate', searchRange: { from: 0.03, to: 0.3 } },
      targetValue: 2_000,
    },
  ],
  'valuation.discountedCashFlowSensitivityTable': () => [
    {
      discountedCashFlowInput: dcfInput(),
      rowAxis: { variable: 'annual-discount-rate', values: [0.08, 0.09] },
      columnAxis: { variable: 'perpetual-growth-rate', values: [0.02, 0.025] },
    },
  ],
  'valuation.discountedCashFlowScenarioAnalysis': () => [
    {
      discountedCashFlowInput: dcfInput(),
      scenarios: [{ scenarioName: 'bear', overrides: { annualDiscountRate: 0.12 } }],
    },
  ],
  'valuation.probabilisticDiscountedCashFlow': () => [
    {
      discountedCashFlowInput: dcfInput(),
      distributions: [
        {
          variable: 'annual-discount-rate',
          distribution: { type: 'normal', mean: 0.09, standardDeviation: 0.005 },
        },
      ],
      sampleCount: 64,
      seed: 7,
    },
  ],
  'valuation.dividendDiscountValuation': () => [
    {
      projectedDividendsPerShare: [{ amount: 2, timeYears: 1 }],
      annualCostOfEquity: 0.09,
      terminalValueMethod: {
        method: 'perpetual-growth',
        terminalCashFlow: 2,
        perpetualGrowthRate: 0.03,
      },
    },
  ],
  'valuation.residualIncomeValuation': () => [
    {
      beginningBookValuePerShare: 20,
      annualCostOfEquity: 0.1,
      projections: [{ earningsPerShare: 3, dividendsPerShare: 1 }],
      terminalResidualIncome: { method: 'none' },
    },
  ],
  'valuation.comparableCompanyValuation': () => [
    {
      metricName: 'EV/EBITDA',
      metricDefinition: 'enterprise value over trailing-twelve-month EBITDA',
      period: 'TTM 2025-Q4',
      valuationBasis: 'enterprise',
      subjectMetricAmount: 225,
      peers: [
        { peerName: 'Peer A', multiple: 8 },
        { peerName: 'Peer B', multiple: 9 },
        { peerName: 'Peer C', multiple: 10 },
      ],
      aggregation: 'median',
      outlierPolicy: { method: 'none' },
    },
  ],
  'valuation.adjustedPresentValue': () => [
    {
      unleveredCashFlows: [
        { amount: 100, timeYears: 1 },
        { amount: 110, timeYears: 2 },
      ],
      unleveredCostOfCapital: 0.1,
      financingSideEffects: [
        {
          label: 'interest tax shield',
          cashFlows: [{ amount: 8, timeYears: 1 }],
          annualDiscountRate: 0.05,
        },
      ],
    },
  ],
  'valuation.leveragedBuyoutAnalysis': () => [
    {
      transaction: { purchaseEnterpriseValue: 1_000, transactionFees: 20, cashToBalanceSheet: 10 },
      sources: {
        sponsorEquity: 430,
        tranches: [
          {
            trancheName: 'Term Loan A',
            principal: 600,
            annualInterestRate: 0.07,
            mandatoryAmortizationFraction: 0.05,
            cashSweepPriority: 1,
          },
        ],
      },
      operatingForecast: [
        {
          year: 1,
          ebitda: 150,
          capitalExpenditure: 30,
          increaseInNetWorkingCapital: 5,
          taxRate: 0.25,
        },
      ],
      cashSweepFraction: 0.5,
      exit: { year: 1, exitEbitdaMultiple: 8, exitFees: 15 },
    },
  ],
  'valuation.operatingForecast': () => [
    {
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
        },
      ],
    },
  ],
  'valuation.projectFinancialStatements': () => [
    { baseStatements: baseStatements(), periods: projectionPeriods() },
  ],
  'valuation.discountedCashFlowFromStatements': () => [
    {
      projection: { baseStatements: baseStatements(), periods: projectionPeriods() },
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
    },
  ],
};
