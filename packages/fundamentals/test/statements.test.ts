/**
 * FC2 — statement utilities: point-in-time selection and restatement policies, TTM composition
 * with chain verification, growth, common-size, reconciliation, and per-share normalization.
 */

import { describe, expect, it } from 'vitest';
import {
  commonSizeFinancialStatements,
  fundamentalGrowth,
  perShareFundamentals,
  reconcileFinancialStatements,
  selectFundamentalSnapshot,
  trailingTwelveMonthStatements,
} from '../src/statements.js';
import type { FinancialStatements } from '../src/statements.js';
import { requireFundamentalPeriod } from '../src/periods.js';
import type { FundamentalPeriod } from '../src/index.js';
import { AVAILABLE_2024, AVAILABLE_2025, FY2023, FY2024, FY2025 } from './fc2-fixture.js';

const SERIES = { statements: [FY2023, FY2024, FY2025] };

describe('selectFundamentalSnapshot — the point-in-time law', () => {
  it('availability, not period end, controls what an observer sees', () => {
    // The FY2025 period ENDED 2025-12-31, but it filed late February 2026: an observer on
    // 2026-01-15 sees only FY2023 and FY2024.
    const snapshot = selectFundamentalSnapshot({
      series: SERIES,
      asOf: Date.UTC(2026, 0, 15),
      restatementPolicy: 'latest-available',
    });
    expect(snapshot.statements.map((set) => set.income.period.fiscalYear)).toEqual([2023, 2024]);
  });

  it('a later asOf never sees fewer periods (point-in-time monotonicity)', () => {
    const instants = [
      Date.UTC(2024, 0, 1),
      AVAILABLE_2024,
      Date.UTC(2025, 6, 1),
      AVAILABLE_2025,
      Date.UTC(2026, 6, 1),
    ];
    let previousCount = -1;
    for (const asOf of instants) {
      const count = selectFundamentalSnapshot({
        series: SERIES,
        asOf,
        restatementPolicy: 'latest-available',
      }).statements.length;
      expect(count).toBeGreaterThanOrEqual(previousCount);
      previousCount = count;
    }
  });

  it('a restatement is a NEW version: invisible before its availability, policy-resolved after', () => {
    const restated: FinancialStatements = {
      ...FY2024,
      income: {
        ...FY2024.income,
        period: {
          ...FY2024.income.period,
          availableTimestampMs: Date.UTC(2025, 7, 1),
          accession: 'restated-2024',
          restatementOf: 'original-2024',
        },
        netIncome: 105, // the restatement revises earnings down
      },
      balance: {
        ...FY2024.balance,
        period: { ...FY2024.balance.period, availableTimestampMs: Date.UTC(2025, 7, 1) },
      },
      cashFlow: {
        ...FY2024.cashFlow,
        period: { ...FY2024.cashFlow.period, availableTimestampMs: Date.UTC(2025, 7, 1) },
      },
    };
    const series = { statements: [FY2023, FY2024, restated] };

    // Before the restatement is available: only the original, under EITHER policy.
    for (const restatementPolicy of ['latest-available', 'first-reported'] as const) {
      const before = selectFundamentalSnapshot({
        series,
        asOf: Date.UTC(2025, 5, 1),
        restatementPolicy,
      });
      const fy2024 = before.statements.find((set) => set.income.period.fiscalYear === 2024)!;
      expect(fy2024.income.netIncome).toBe(111);
    }

    // After: 'latest-available' takes the restated version; 'first-reported' keeps the original.
    const latest = selectFundamentalSnapshot({
      series,
      asOf: Date.UTC(2025, 8, 1),
      restatementPolicy: 'latest-available',
    });
    expect(
      latest.statements.find((set) => set.income.period.fiscalYear === 2024)!.income.netIncome,
    ).toBe(105);
    const first = selectFundamentalSnapshot({
      series,
      asOf: Date.UTC(2025, 8, 1),
      restatementPolicy: 'first-reported',
    });
    expect(
      first.statements.find((set) => set.income.period.fiscalYear === 2024)!.income.netIncome,
    ).toBe(111);
    // One resolved version per period either way.
    expect(latest.statements).toHaveLength(2);
    expect(first.statements).toHaveLength(2);
  });
});

// Four consecutive FY2025 fiscal quarters that SUM to the FY2025 annual figures.
function quarter(
  fiscalQuarter: 1 | 2 | 3 | 4,
  end: string,
  revenue: number,
  netIncome: number,
): FinancialStatements {
  const period: FundamentalPeriod = {
    periodEndDate: end,
    fiscalYear: 2025,
    fiscalQuarter,
    periodType: 'quarter',
    availableTimestampMs: Date.UTC(2025, fiscalQuarter * 3, 15),
    currency: 'USD',
    monetaryScale: 1,
  };
  return {
    income: {
      period,
      revenue,
      operatingIncome: netIncome + 12,
      netIncome,
      dilutedSharesOutstanding: 98,
    },
    balance: {
      period,
      cashAndCashEquivalents: 100 + fiscalQuarter * 10,
      totalAssets: 1_200 + fiscalQuarter * 10,
      totalLiabilities: 555,
      totalEquity: 645 + fiscalQuarter * 10,
    },
    cashFlow: {
      period,
      operatingCashFlow: netIncome + 10,
      investingCashFlow: -20,
      financingCashFlow: -5,
      capitalExpenditure: 17.5,
    },
  };
}

const Q1 = quarter(1, '2025-03-31', 230, 30);
const Q2 = quarter(2, '2025-06-30', 245, 32);
const Q3 = quarter(3, '2025-09-30', 255, 34);
const Q4 = quarter(4, '2025-12-31', 270, 36);

describe('trailingTwelveMonthStatements', () => {
  it('flows sum, balances are the latest quarter, shares average, availability is the max', () => {
    const ttm = trailingTwelveMonthStatements({ statements: [Q1, Q2, Q3, Q4] });
    expect(ttm.income.period.periodType).toBe('trailing-twelve-months');
    expect(ttm.income.period.periodEndDate).toBe('2025-12-31');
    expect(ttm.income.revenue).toBe(230 + 245 + 255 + 270);
    expect(ttm.income.netIncome).toBe(30 + 32 + 34 + 36);
    expect(ttm.cashFlow.operatingCashFlow).toBe(40 + 42 + 44 + 46);
    expect(ttm.cashFlow.capitalExpenditure).toBe(70);
    // A balance is a point, not a flow.
    expect(ttm.balance.totalAssets).toBe(1_240);
    expect(ttm.balance.cashAndCashEquivalents).toBe(140);
    // Disclosed convention: four-quarter arithmetic mean.
    expect(ttm.income.dilutedSharesOutstanding).toBe(98);
    expect(ttm.income.period.availableTimestampMs).toBe(
      Math.max(Q1.income.period.availableTimestampMs, Q4.income.period.availableTimestampMs),
    );
  });

  it('an optional flow absent in ANY quarter is absent in the TTM — no zero-fill', () => {
    const withoutCapex: FinancialStatements = {
      ...Q2,
      cashFlow: (() => {
        const { capitalExpenditure: _dropped, ...rest } = Q2.cashFlow;
        return rest;
      })(),
    };
    const ttm = trailingTwelveMonthStatements({ statements: [Q1, withoutCapex, Q3, Q4] });
    expect(ttm.cashFlow.capitalExpenditure).toBeUndefined();
  });

  it('a gap in the quarter chain is an error naming the break, never annualized over', () => {
    expect(() => trailingTwelveMonthStatements({ statements: [Q1, Q2, Q4, Q4] })).toThrow(
      /chain breaks between statements\[1\] \(FY2025 Q2\) and statements\[2\] \(FY2025 Q4\)/,
    );
  });

  it('a non-quarter period cannot enter the chain', () => {
    expect(() => trailingTwelveMonthStatements({ statements: [Q1, Q2, Q3, FY2025] })).toThrow(
      /statements\[3\] must be a fiscal quarter/,
    );
  });
});

describe('fundamentalGrowth', () => {
  it('reports period-over-period rows and CAGR over the actual elapsed years', () => {
    const growth = fundamentalGrowth({
      observations: [
        { periodEndDate: '2023-12-31', amount: 800 },
        { periodEndDate: '2024-12-31', amount: 900 },
        { periodEndDate: '2025-12-31', amount: 1_000 },
      ],
    });
    expect(growth.periodOverPeriod).toHaveLength(2);
    expect(growth.periodOverPeriod[0]!.growth).toBeCloseTo(900 / 800 - 1, 12);
    expect(growth.periodOverPeriod[1]!.growth).toBeCloseTo(1_000 / 900 - 1, 12);
    // 731 actual days ACT/365F.
    const elapsedYears = 731 / 365;
    expect(growth.elapsedYears).toBeCloseTo(elapsedYears, 12);
    expect(growth.compoundAnnualGrowthRate).toBeCloseTo(
      Math.pow(1_000 / 800, 1 / elapsedYears) - 1,
      12,
    );
  });

  it('growth through zero or across signs is null WITH the reason, never a magnitude', () => {
    const growth = fundamentalGrowth({
      observations: [
        { periodEndDate: '2023-12-31', amount: -50 },
        { periodEndDate: '2024-12-31', amount: 100 },
      ],
    });
    expect(growth.periodOverPeriod[0]!.growth).toBeNull();
    expect(growth.periodOverPeriod[0]!.reason).toMatch(/cross sign/);
    expect(growth.compoundAnnualGrowthRate).toBeNull();
    expect(growth.compoundAnnualGrowthReason).toMatch(/not positive/);
  });
});

describe('commonSizeFinancialStatements', () => {
  it('income and cash-flow lines over revenue, balance lines over totalAssets — fractions', () => {
    const commonSize = commonSizeFinancialStatements({ statements: FY2025 });
    expect(commonSize.income.basis).toBe('revenue');
    expect(commonSize.income.lines['grossProfit']).toBeCloseTo(0.42, 12);
    expect(commonSize.income.lines['netIncome']).toBeCloseTo(0.132, 12);
    expect(commonSize.balance.basis).toBe('totalAssets');
    expect(commonSize.balance.lines['totalEquity']).toBeCloseTo(690 / 1_250, 12);
    expect(commonSize.cashFlow.lines['operatingCashFlow']).toBeCloseTo(0.17, 12);
  });
});

describe('reconcileFinancialStatements', () => {
  it('the fixture ties on every identity, including cash articulation with the prior period', () => {
    const result = reconcileFinancialStatements({
      statements: FY2025,
      priorStatements: FY2024,
    });
    expect(result.reconciles).toBe(true);
    expect(result.toleranceAmount).toBe(1);
    const cash = result.checks.find((check) => check.name === 'cash articulation')!;
    expect(cash.difference).toBe(0);
  });

  it('a broken balance-sheet identity is reported with the exact difference', () => {
    const broken: FinancialStatements = {
      ...FY2025,
      balance: { ...FY2025.balance, totalEquity: 700 },
    };
    const result = reconcileFinancialStatements({ statements: broken });
    expect(result.reconciles).toBe(false);
    const identity = result.checks.find((check) => check.name === 'balance-sheet identity')!;
    expect(identity.difference).toBe(1_250 - (560 + 700));
    expect(identity.withinTolerance).toBe(false);
  });

  it('a check whose fields are absent reports null — never a silent pass presented as proof', () => {
    const sparse: FinancialStatements = {
      ...FY2025,
      income: (() => {
        const { grossProfit: _g, costOfRevenue: _c, ...rest } = FY2025.income;
        return rest;
      })(),
    };
    const result = reconcileFinancialStatements({ statements: sparse });
    const articulation = result.checks.find((check) => check.name === 'gross-profit articulation')!;
    expect(articulation.withinTolerance).toBeNull();
    expect(articulation.detail).toMatch(/not evaluable/);
  });
});

describe('perShareFundamentals', () => {
  it('normalizes with the split factor and echoes the shares used', () => {
    const perShare = perShareFundamentals({ statements: FY2025, splitFactorSincePeriod: 2 });
    expect(perShare.dilutedSharesUsed).toBe(196);
    expect(perShare.earningsPerShare).toBeCloseTo(132 / 196, 12);
    expect(perShare.bookValuePerShare).toBeCloseTo(690 / 196, 12);
    expect(perShare.freeCashFlowPerShare).toBeCloseTo((170 - 70) / 196, 12);
  });

  it('absent shares is an error naming the field, never a NaN', () => {
    const sparse: FinancialStatements = {
      ...FY2025,
      income: (() => {
        const { dilutedSharesOutstanding: _s, ...rest } = FY2025.income;
        return rest;
      })(),
    };
    expect(() => perShareFundamentals({ statements: sparse })).toThrow(
      /dilutedSharesOutstanding must be present/,
    );
  });
});

describe('impossible calendar dates are refused (review finding)', () => {
  it('2025-02-30 as a period end teaches, never normalizes into March', () => {
    expect(() =>
      requireFundamentalPeriod('probe', {
        periodEndDate: '2025-02-30',
        fiscalYear: 2025,
        fiscalQuarter: 1,
        periodType: 'quarter',
        availableTimestampMs: Date.UTC(2025, 3, 28),
        currency: 'USD',
        monetaryScale: 1,
      }),
    ).toThrowError(/calendar date/);
  });
});
