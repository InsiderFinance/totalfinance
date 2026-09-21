/**
 * FC2 — comparable, APV, and LBO goldens, every number recomputable by hand (the year-1 LBO walk
 * is written out; later years are pinned to the closing laws and the exit bridge).
 */

import { describe, expect, it } from 'vitest';
import {
  adjustedPresentValue,
  comparableCompanyValuation,
  leveragedBuyoutAnalysis,
} from '../src/index.js';

const close = (actual: number, expected: number, tolerance = 1e-9): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
};

describe('comparableCompanyValuation', () => {
  // Sorted multiples [8, 9, 10, 30]: Q1 = 8.75, Q3 = 15 (type-7), IQR = 6.25, fences at
  // multiplier 1.5 → [−0.625, 24.375]: peer D (30) is excluded.
  const PEERS = [
    { peerName: 'A', multiple: 8 },
    { peerName: 'B', multiple: 9 },
    { peerName: 'C', multiple: 10 },
    { peerName: 'D', multiple: 30 },
  ];
  const BASE = {
    metricName: 'EV/EBITDA',
    metricDefinition: 'enterprise value over trailing-twelve-month EBITDA',
    period: 'TTM 2025-Q4',
    valuationBasis: 'enterprise' as const,
    subjectMetricAmount: 225,
    peers: PEERS,
    outlierPolicy: { method: 'interquartile-range' as const, multiplier: 1.5 },
  };

  it('IQR exclusion before aggregation, with the excluded peer named and reasoned', () => {
    const result = comparableCompanyValuation({ ...BASE, aggregation: 'median' });
    expect(result.peersExcluded).toHaveLength(1);
    expect(result.peersExcluded[0]!.peerName).toBe('D');
    expect(result.peersExcluded[0]!.reason).toMatch(/above the interquartile-range fence/);
    expect(result.peersUsed.map((peer) => peer.peerName)).toEqual(['A', 'B', 'C']);
    close(result.aggregatedMultiple, 9);
    close(result.impliedValue, 9 * 225);
    expect(result.valuationBasis).toBe('enterprise');
  });

  it('mean and weighted-mean over the SURVIVORS, weights renormalized and echoed', () => {
    close(comparableCompanyValuation({ ...BASE, aggregation: 'mean' }).aggregatedMultiple, 9);
    const weighted = comparableCompanyValuation({
      ...BASE,
      aggregation: 'weighted-mean',
      weights: [1, 2, 3, 4], // D's weight drops with D; survivors renormalize over 6
    });
    close(weighted.aggregatedMultiple, (8 * 1 + 9 * 2 + 10 * 3) / 6);
    expect(weighted.assumptions.weightsNormalized).toHaveLength(3);
    close(weighted.assumptions.weightsNormalized![2]!, 0.5);
  });

  it('refuses a weighted mean without weights, weights elsewhere, and empty-after-exclusion', () => {
    expect(() => comparableCompanyValuation({ ...BASE, aggregation: 'weighted-mean' })).toThrow(
      /weights is required when aggregation is 'weighted-mean'/,
    );
    expect(() =>
      comparableCompanyValuation({ ...BASE, aggregation: 'median', weights: [1, 1, 1, 1] }),
    ).toThrow(/weights/);
    expect(() =>
      comparableCompanyValuation({
        ...BASE,
        peers: [
          { peerName: 'low', multiple: 1 },
          { peerName: 'high', multiple: 100 },
        ],
        aggregation: 'median',
        outlierPolicy: { method: 'interquartile-range', multiplier: 0.1 },
      }),
    ).toThrow(/excluded every peer/);
  });
});

describe('adjustedPresentValue', () => {
  it('separates the unlevered value from each side effect at its OWN rate', () => {
    const result = adjustedPresentValue({
      unleveredCashFlows: [
        { amount: 100, timeYears: 1 },
        { amount: 110, timeYears: 2 },
      ],
      unleveredCostOfCapital: 0.1,
      financingSideEffects: [
        {
          label: 'interest tax shield',
          cashFlows: [
            { amount: 8, timeYears: 1 },
            { amount: 8, timeYears: 2 },
          ],
          annualDiscountRate: 0.05,
        },
        {
          label: 'issuance costs',
          cashFlows: [{ amount: -5, timeYears: 0 }],
          annualDiscountRate: 0.05,
        },
      ],
    });
    const unlevered = 100 / 1.1 + 110 / 1.1 ** 2;
    const shield = 8 / 1.05 + 8 / 1.05 ** 2;
    close(result.unleveredValue, unlevered);
    close(result.financingSideEffects[0]!.presentValue, shield);
    close(result.financingSideEffects[1]!.presentValue, -5);
    close(result.adjustedPresentValue, unlevered + shield - 5);
    expect(result.assumptions.compounding).toBe('annual');
    expect(result.assumptions.sideEffectCount).toBe(2);
  });
});

describe('leveragedBuyoutAnalysis', () => {
  // Sources 380 + 400 + 250 = 1,030 = uses 1,000 + 20 + 10.
  const INPUT = {
    transaction: { purchaseEnterpriseValue: 1_000, transactionFees: 20, cashToBalanceSheet: 10 },
    sources: {
      sponsorEquity: 380,
      tranches: [
        {
          trancheName: 'Term Loan A',
          principal: 400,
          annualInterestRate: 0.06,
          mandatoryAmortizationFraction: 0.1,
          cashSweepPriority: 1,
        },
        {
          trancheName: 'Term Loan B',
          principal: 250,
          annualInterestRate: 0.09,
          mandatoryAmortizationFraction: 0,
          cashSweepPriority: 2,
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
      {
        year: 2,
        ebitda: 165,
        capitalExpenditure: 32,
        increaseInNetWorkingCapital: 5,
        taxRate: 0.25,
      },
      {
        year: 3,
        ebitda: 180,
        capitalExpenditure: 34,
        increaseInNetWorkingCapital: 6,
        taxRate: 0.25,
      },
    ],
    cashSweepFraction: 0.5,
    exit: { year: 3, exitEbitdaMultiple: 8, exitFees: 15 },
  };

  it('year 1, walked by hand: interest, taxes, free cash flow, amortization, sweep, cash', () => {
    const result = leveragedBuyoutAnalysis(INPUT);
    const year1 = result.annualSchedule[0]!;
    // Interest 400×6% + 250×9% = 24 + 22.5 = 46.5; taxable 103.5 → taxes 25.875;
    // FCF = 150 − 25.875 − 30 − 5 − 46.5 = 42.625; mandatory 40 (TLA only);
    // sweep = (42.625 − 40) × 0.5 = 1.3125 to TLA; cash = 10 + 42.625 − 40 − 1.3125.
    close(year1.interest, 46.5);
    close(year1.taxes, 25.875);
    close(year1.freeCashFlow, 42.625);
    close(year1.cashSweptToDebt, 1.3125);
    close(year1.cashAccumulated, 11.3125);
    const termLoanA = year1.trancheRows.find((row) => row.trancheName === 'Term Loan A')!;
    close(termLoanA.mandatoryAmortization, 40);
    close(termLoanA.cashSweep, 1.3125);
    close(termLoanA.endingBalance, 400 - 40 - 1.3125);
    const termLoanB = year1.trancheRows.find((row) => row.trancheName === 'Term Loan B')!;
    close(termLoanB.mandatoryAmortization, 0);
    close(termLoanB.endingBalance, 250);
  });

  it('every tranche-year CLOSES and cash accumulates consistently across the schedule', () => {
    const result = leveragedBuyoutAnalysis(INPUT);
    expect(result.annualSchedule).toHaveLength(3);
    for (const year of result.annualSchedule) {
      for (const row of year.trancheRows) {
        close(
          row.endingBalance,
          row.beginningBalance - row.mandatoryAmortization - row.cashSweep,
          1e-12,
        );
        expect(row.endingBalance).toBeGreaterThanOrEqual(0);
      }
    }
    // Chaining: year N+1 beginning balances are year N ending balances.
    for (let index = 1; index < result.annualSchedule.length; index++) {
      for (const row of result.annualSchedule[index]!.trancheRows) {
        const prior = result.annualSchedule[index - 1]!.trancheRows.find(
          (priorRow) => priorRow.trancheName === row.trancheName,
        )!;
        close(row.beginningBalance, prior.endingBalance, 1e-12);
      }
    }
  });

  it('the exit bridge reconciles to MOIC and the IRR satisfies its own compounding identity', () => {
    const result = leveragedBuyoutAnalysis(INPUT);
    const bridge = result.exitBridge;
    close(bridge.enterpriseValue, 180 * 8);
    const finalYear = result.annualSchedule[2]!;
    const remainingDebt = finalYear.trancheRows.reduce((sum, row) => sum + row.endingBalance, 0);
    close(bridge.netDebtAtExit, remainingDebt - finalYear.cashAccumulated, 1e-12);
    close(bridge.equityProceeds, bridge.enterpriseValue - bridge.netDebtAtExit - 15, 1e-12);
    close(result.multipleOnInvestedCapital, bridge.equityProceeds / 380, 1e-12);
    expect(result.equityCashFlows).toEqual([
      { amount: -380, timeYears: 0 },
      { amount: bridge.equityProceeds, timeYears: 3 },
    ]);
    // Two flows, three years: (1 + irr)³ = proceeds / equity, exactly.
    const irr = result.internalRateOfReturn!;
    expect(irr).not.toBeNull();
    close(Math.pow(bridge.equityProceeds / 380, 1 / 3) - 1, irr, 1e-9);
    expect(result.assumptions.disclosedSimplifications.length).toBeGreaterThanOrEqual(5);
  });

  it('refuses an unbalanced structure with BOTH sides stated', () => {
    expect(() =>
      leveragedBuyoutAnalysis({
        ...INPUT,
        sources: { ...INPUT.sources, sponsorEquity: 300 },
      }),
    ).toThrow(/sources total 950 .* uses total 1030/);
  });
});
