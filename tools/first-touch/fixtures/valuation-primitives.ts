/**
 * Fixtures for the single-argument valuation primitives (FC1/FC2 heads).
 *
 * Added 2026-08-23 (third external review): these 30 heads were governed by the Law-7 overflow
 * mutant's population rule but silently absent from it — the deep-sweep fixture-completeness gate
 * only requires fixtures for multi-argument or explain-bearing callables, so the single-object
 * primitives never got one, and `overflow-sweep.test.ts` skipped what it could not feed. The sweep
 * now REFUSES to pass with a governed head missing, and these fixtures are what feeds it.
 *
 * Values are the functions' own documented example calls wherever one exists.
 */
import type { FixtureThunk } from '../inputs.js';

const FLOWS = () => [
  { amount: -1_000, timeYears: 0 },
  { amount: 600, timeYears: 1 },
  { amount: 600, timeYears: 2 },
];

const LOAN = {
  principal: 250_000,
  periodicInterestRate: 0.06 / 12,
  numberOfPeriods: 360,
  paymentTiming: 'end',
};

export const VALUATION_PRIMITIVES_FIXTURES: Record<string, FixtureThunk> = {
  'valuation.esToSpyLevel': () => [
    { esPriceLevel: 6030, referenceEsPrice: 6000, referenceSpyPrice: 596 },
  ],
  'valuation.spyToEsLevel': () => [
    { spyPriceLevel: 598.98, referenceSpyPrice: 596, referenceEsPrice: 6000 },
  ],
  'valuation.nqToQqqLevel': () => [
    { nqPriceLevel: 20250, referenceNqPrice: 20000, referenceQqqPrice: 500 },
  ],
  'valuation.qqqToNqLevel': () => [
    { qqqPriceLevel: 506.25, referenceQqqPrice: 500, referenceNqPrice: 20000 },
  ],
  'valuation.ymToDiaLevel': () => [
    { ymPriceLevel: 40400, referenceYmPrice: 40000, referenceDiaPrice: 398 },
  ],
  'valuation.diaToYmLevel': () => [
    { diaPriceLevel: 401.98, referenceDiaPrice: 398, referenceYmPrice: 40000 },
  ],
  'valuation.rtyToIwmLevel': () => [
    { rtyPriceLevel: 2020, referenceRtyPrice: 2000, referenceIwmPrice: 198 },
  ],
  'valuation.iwmToRtyLevel': () => [
    { iwmPriceLevel: 199.98, referenceIwmPrice: 198, referenceRtyPrice: 2000 },
  ],
  'valuation.spxToSpyLevel': () => [
    { spxPriceLevel: 6030, referenceSpxPrice: 6000, referenceSpyPrice: 596 },
  ],
  'valuation.spyToSpxLevel': () => [
    { spyPriceLevel: 598.98, referenceSpyPrice: 596, referenceSpxPrice: 6000 },
  ],
  'valuation.ndxToQqqLevel': () => [
    { ndxPriceLevel: 20250, referenceNdxPrice: 20000, referenceQqqPrice: 500 },
  ],
  'valuation.qqqToNdxLevel': () => [
    { qqqPriceLevel: 506.25, referenceQqqPrice: 500, referenceNdxPrice: 20000 },
  ],
  'valuation.rutToIwmLevel': () => [
    { rutPriceLevel: 2020, referenceRutPrice: 2000, referenceIwmPrice: 198 },
  ],
  'valuation.iwmToRutLevel': () => [
    { iwmPriceLevel: 199.98, referenceIwmPrice: 198, referenceRutPrice: 2000 },
  ],
  'valuation.djiaToDiaLevel': () => [
    { djiaPriceLevel: 40400, referenceDjiaPrice: 40000, referenceDiaPrice: 398 },
  ],
  'valuation.diaToDjiaLevel': () => [
    { diaPriceLevel: 401.98, referenceDiaPrice: 398, referenceDjiaPrice: 40000 },
  ],
  'valuation.convertPriceLevel': () => [
    {
      method: 'reference-prices',
      sourcePriceLevel: 6030,
      referenceSourcePrice: 6000,
      referenceTargetPrice: 596,
      sourcePriceUnit: 'ES index points',
      targetPriceUnit: 'USD per SPY share',
    },
  ],
  // discounting.ts
  'valuation.presentValue': () => [
    { futureAmount: 1_000, annualInterestRate: 0.08, timeYears: 5, compounding: 'annual' },
  ],
  'valuation.futureValue': () => [
    { presentAmount: 1_000, annualInterestRate: 0.08, timeYears: 5, compounding: 'annual' },
  ],
  'valuation.effectiveAnnualRate': () => [{ nominalAnnualRate: 0.12, compounding: 'monthly' }],
  'valuation.nominalAnnualRate': () => [{ effectiveAnnualRate: 0.1268, compounding: 'monthly' }],
  'valuation.equivalentInterestRate': () => [
    { annualInterestRate: 0.12, fromCompounding: 'monthly', toCompounding: 'continuous' },
  ],

  // cash-flow NPV family
  'valuation.netPresentValue': () => [{ cashFlows: FLOWS(), annualDiscountRate: 0.1 }],
  'valuation.datedNetPresentValue': () => [
    {
      cashFlows: [
        { amount: -1_000, cashFlowDate: '2026-01-01' },
        { amount: 1_100, cashFlowDate: '2027-01-01' },
      ],
      asOf: '2026-01-01',
      annualDiscountRate: 0.1,
    },
  ],
  'valuation.modifiedInternalRateOfReturn': () => [
    { cashFlows: FLOWS(), financeRate: 0.08, reinvestmentRate: 0.05 },
  ],

  // capital budgeting
  'valuation.paybackPeriod': () => [{ cashFlows: FLOWS() }],
  'valuation.discountedPaybackPeriod': () => [{ cashFlows: FLOWS(), annualDiscountRate: 0.1 }],
  'valuation.profitabilityIndex': () => [{ cashFlows: FLOWS(), annualDiscountRate: 0.1 }],
  'valuation.equivalentAnnualAnnuity': () => [
    { cashFlows: FLOWS(), annualDiscountRate: 0.1, projectLifeYears: 2 },
  ],

  // loans
  'valuation.annuityPayment': () => [{ ...LOAN }],
  'valuation.amortizationSchedule': () => [{ ...LOAN }],
  'valuation.loanInterestPayment': () => [{ ...LOAN, period: 12 }],
  'valuation.loanPrincipalPayment': () => [{ ...LOAN, period: 12 }],
  'valuation.loanNumberOfPeriods': () => [
    {
      principal: 250_000,
      periodicInterestRate: 0.06 / 12,
      payment: 1_498.88,
      paymentTiming: 'end',
    },
  ],
  'valuation.loanPeriodicInterestRate': () => [
    { principal: 250_000, numberOfPeriods: 360, payment: 1_498.88, paymentTiming: 'end' },
  ],
  'valuation.cumulativeLoanInterest': () => [{ ...LOAN, fromPeriod: 1, toPeriod: 12 }],
  'valuation.cumulativeLoanPrincipal': () => [{ ...LOAN, fromPeriod: 1, toPeriod: 12 }],

  // depreciation
  'valuation.straightLineDepreciation': () => [
    { cost: 10_000, salvageValue: 1_000, usefulLifePeriods: 5, period: 2 },
  ],
  'valuation.decliningBalanceDepreciation': () => [
    { cost: 10_000, salvageValue: 1_000, usefulLifePeriods: 5, period: 2, factor: 1.5 },
  ],
  'valuation.doubleDecliningBalanceDepreciation': () => [
    { cost: 10_000, salvageValue: 1_000, usefulLifePeriods: 5, period: 2 },
  ],
  'valuation.sumOfYearsDigitsDepreciation': () => [
    { cost: 10_000, salvageValue: 1_000, usefulLifePeriods: 5, period: 2 },
  ],

  // cost of capital + corporate primitives
  'valuation.capitalAssetPricingExpectedReturn': () => [
    { annualRiskFreeRate: 0.04, beta: 1.2, annualMarketRiskPremium: 0.05 },
  ],
  'valuation.costOfEquity': () => [
    {
      method: 'capital-asset-pricing',
      annualRiskFreeRate: 0.04,
      beta: 1.2,
      annualMarketRiskPremium: 0.05,
    },
  ],
  'valuation.afterTaxCostOfDebt': () => [{ annualPreTaxCostOfDebt: 0.06, marginalTaxRate: 0.21 }],
  'valuation.freeCashFlowToFirm': () => [
    {
      operatingIncome: 180,
      taxRate: 0.21,
      depreciationAndAmortization: 45,
      capitalExpenditure: 70,
      increaseInNetWorkingCapital: 15,
    },
  ],
  'valuation.freeCashFlowToEquity': () => [
    {
      netIncome: 132,
      depreciationAndAmortization: 45,
      capitalExpenditure: 70,
      increaseInNetWorkingCapital: 15,
      netBorrowing: 10,
    },
  ],
  'valuation.terminalValue': () => [
    {
      terminalValueMethod: {
        method: 'perpetual-growth',
        terminalCashFlow: 135,
        perpetualGrowthRate: 0.025,
      },
      annualDiscountRate: 0.09,
    },
  ],
  'valuation.enterpriseToEquityValue': () => [
    {
      enterpriseValue: 2_090,
      enterpriseToEquityBridge: {
        cashAndCashEquivalents: 150,
        totalDebt: 280,
        preferredEquity: 0,
        minorityInterest: 0,
        nonOperatingAssets: 0,
      },
    },
  ],
};
