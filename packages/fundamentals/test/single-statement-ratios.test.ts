import { describe, expect, it } from 'vitest';
import {
  grossMargin,
  operatingMargin,
  netProfitMargin,
  interestCoverage,
  debtServiceCoverage,
  earningsPerShare,
  revenuePerShare,
  currentRatio,
  quickRatio,
  cashRatio,
  debtToEquity,
  debtToAssets,
  ebitdaMargin,
  cashFlowToNetIncome,
  returnOnAssets,
} from '../src/index.js';
import type { DebtServiceRatioInput } from '../src/index.js';
import { FY2023, FY2024 } from './fc2-fixture.js';

describe('ratios from only the statement their formula consumes (DX-19)', () => {
  it('computes and explains an income-only gross margin without fabricating statements', () => {
    const income = structuredClone(FY2023.income);
    const before = structuredClone(income);
    const report = grossMargin.explain({ income });
    expect(report.value).toBe(0.4);
    expect(report.diagnostics.numerator).toEqual({ label: 'grossProfit', amount: 320 });
    expect(report.diagnostics.denominator).toEqual({ label: 'revenue', amount: 800 });
    expect(report.assumptions.period).toMatchObject({
      periodEndDate: '2023-12-31',
      currency: 'USD',
      monetaryScale: 1,
      availableTimestampMs: income.period.availableTimestampMs,
    });
    expect(income).toEqual(before);
    expect(report).toEqual(grossMargin.explain({ statements: FY2023 }));
  });

  it('computes a balance-only current ratio with no income or cash-flow prerequisite', () => {
    expect(currentRatio({ balance: FY2023.balance })).toBe(2);
    expect(currentRatio.explain({ balance: FY2023.balance })).toEqual(
      currentRatio.explain({ statements: FY2023 }),
    );
  });

  it('supports the directly applicable income and balance families', () => {
    const income = FY2023.income;
    const balance = FY2023.balance;
    for (const [ratio, expected] of [
      [operatingMargin, 0.15],
      [netProfitMargin, 0.11],
      [interestCoverage, 12],
      [earningsPerShare, 0.88],
      [revenuePerShare, 8],
    ] as const) {
      expect(ratio({ income })).toBeCloseTo(expected, 12);
      expect(ratio.explain({ income })).toEqual(ratio.explain({ statements: FY2023 }));
    }
    expect(debtServiceCoverage({ income, debtServiceAmount: 40 })).toBe(3);
    for (const [ratio, expected] of [
      [quickRatio, 1.6],
      [cashRatio, 2 / 3],
      [debtToEquity, 0.6],
      [debtToAssets, 0.3],
    ] as const) {
      expect(ratio({ balance })).toBeCloseTo(expected, 12);
      expect(ratio.explain({ balance })).toEqual(ratio.explain({ statements: FY2023 }));
    }
  });

  it('keeps currency/share scaling explicit and zero denominators honest', () => {
    const income = structuredClone(FY2023.income);
    income.period.monetaryScale = 1_000_000;
    expect(grossMargin({ income })).toBe(0.4);
    expect(earningsPerShare({ income })).toBe(880_000);
    income.revenue = 0;
    expect(grossMargin.explain({ income })).toMatchObject({
      value: null,
      diagnostics: { reason: 'revenue is zero — the ratio is undefined' },
    });
    const balance = { ...FY2023.balance, currentLiabilities: 0 };
    expect(currentRatio({ balance })).toBeNull();
  });

  it('retains strict full-set validation and cross-statement requirements', () => {
    expect(() => grossMargin({ statements: { income: FY2023.income } } as never)).toThrow(
      expect.objectContaining({ code: 'input.wrong_type' }),
    );
    for (const ratio of [ebitdaMargin, cashFlowToNetIncome]) {
      expect(() => ratio({ income: FY2023.income } as never)).toThrow(
        expect.objectContaining({ code: 'input.unknown_field' }),
      );
    }
    expect(() => currentRatio({ statements: { ...FY2023, cashFlow: FY2024.cashFlow } })).toThrow(
      expect.objectContaining({ code: 'input.wrong_shape' }),
    );
    expect(() =>
      returnOnAssets({ current: { income: FY2024.income }, prior: FY2023 } as never),
    ).toThrow(expect.objectContaining({ code: 'input.wrong_type' }));
  });

  it('rejects ambiguous sources, unknown keys, invalid values and unsupported periods', () => {
    expect(() => grossMargin({ income: FY2023.income, statements: FY2023 } as never)).toThrow(
      expect.objectContaining({ code: 'input.wrong_shape' }),
    );
    for (const input of [undefined, null, {}, { income: null }]) {
      expect(() => grossMargin(input as never)).toThrow(
        expect.objectContaining({ name: 'InputError' }),
      );
    }
    expect(() => grossMargin({ income: { ...FY2023.income, revenue: Infinity } })).toThrow(
      expect.objectContaining({ name: 'InputError' }),
    );
    expect(() => grossMargin({ income: { ...FY2023.income, revenues: 800 } } as never)).toThrow(
      expect.objectContaining({ code: 'input.unknown_field' }),
    );
    expect(() =>
      grossMargin({
        income: {
          ...FY2023.income,
          period: { ...FY2023.income.period, periodType: 'year-to-date' },
        },
      } as never),
    ).toThrow(expect.objectContaining({ code: 'input.invalid_enum' }));
  });
});

// A released interface remains extendable by existing 0.1.x consumers.
interface ConsumerDebtServiceRequest extends DebtServiceRatioInput {
  consumerLabel?: string;
}
it('preserves existing extendable full-set debt-service request types', () => {
  const request: ConsumerDebtServiceRequest = { statements: FY2023, debtServiceAmount: 40 };
  expect(debtServiceCoverage(request)).toBe(3);
});

it('requires only the monetary facts consumed by each direct ratio', () => {
  const period = FY2023.income.period;
  expect(grossMargin({ income: { period, revenue: 200, costOfRevenue: 120 } })).toBe(0.4);
  expect(operatingMargin({ income: { period, revenue: 200, operatingIncome: 30 } })).toBe(0.15);
  expect(netProfitMargin({ income: { period, revenue: 200, netIncome: 20 } })).toBe(0.1);
  expect(currentRatio({ balance: { period, currentAssets: 90, currentLiabilities: 45 } })).toBe(2);
  expect(
    quickRatio({ balance: { period, currentAssets: 90, inventory: 10, currentLiabilities: 40 } }),
  ).toBe(2);
  expect(
    cashRatio({ balance: { period, cashAndCashEquivalents: 30, currentLiabilities: 15 } }),
  ).toBe(2);
  expect(debtToEquity({ balance: { period, totalEquity: 80, totalDebt: 40 } })).toBe(0.5);
  expect(debtToAssets({ balance: { period, totalAssets: 100, totalDebt: 40 } })).toBe(0.4);
  expect(interestCoverage({ income: { period, operatingIncome: 30, interestExpense: 10 } })).toBe(
    3,
  );
  expect(
    debtServiceCoverage({ income: { period, operatingIncome: 30 }, debtServiceAmount: 10 }),
  ).toBe(3);
  expect(
    earningsPerShare({ income: { period, netIncome: 20, dilutedSharesOutstanding: 10 } }),
  ).toBe(2);
  expect(revenuePerShare({ income: { period, revenue: 200, dilutedSharesOutstanding: 10 } })).toBe(
    20,
  );
});

it('keeps explained derived debt overflow finite, with the unavailable amount disclosed', () => {
  const report = debtToEquity.explain({
    balance: {
      period: FY2023.balance.period,
      totalEquity: 80,
      shortTermDebt: 1e308,
      longTermDebt: 1e308,
    },
  });
  expect(report).toMatchObject({
    value: null,
    diagnostics: {
      numerator: null,
      denominator: { label: 'totalEquity', amount: 80 },
      reason: expect.stringContaining('derived amount overflows'),
    },
  });
  expect(JSON.parse(JSON.stringify(report))).toEqual(report);
});
