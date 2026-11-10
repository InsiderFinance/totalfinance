import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
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
  returnOnAssets,
  returnOnEquity,
  priceToEarnings,
} from '../src/index.js';
import { FY2023, FY2024 } from './fc2-fixture.js';

const incomeHeads = {
  grossMargin,
  operatingMargin,
  netProfitMargin,
  interestCoverage,
  debtServiceCoverage,
  earningsPerShare,
  revenuePerShare,
};
const balanceHeads = { currentRatio, quickRatio, cashRatio, debtToEquity, debtToAssets };
const at = (date: string) => Date.parse(`${date}T00:00:00Z`);
function staggered(base = FY2023) {
  const statements = structuredClone(base);
  statements.income.period.availableTimestampMs = at('2025-04-20');
  statements.balance.period.availableTimestampMs = at('2025-05-08');
  statements.cashFlow.period.availableTimestampMs = at('2025-05-01');
  return statements;
}

describe('review repair: availability and executable ratio recovery', () => {
  it('reports the complete set maximum for every selected head, while direct periods remain exact', () => {
    const statements = staggered();
    for (const [name, head] of Object.entries({ ...incomeHeads, ...balanceHeads })) {
      const control = name === 'debtServiceCoverage' ? { debtServiceAmount: 10 } : {};
      expect(
        head.explain({ statements, ...control } as never).assumptions.period.availableTimestampMs,
        name,
      ).toBe(at('2025-05-08'));
    }
    expect(
      grossMargin.explain({ income: statements.income }).assumptions.period.availableTimestampMs,
    ).toBe(at('2025-04-20'));
    expect(
      currentRatio.explain({ balance: statements.balance }).assumptions.period.availableTimestampMs,
    ).toBe(at('2025-05-08'));
    expect(
      priceToEarnings.explain({
        statements,
        marketObservation: {
          observedTimestampMs: at('2025-05-09'),
          sharePrice: 10,
          sharesOutstanding: 100,
        },
      }).assumptions.period.availableTimestampMs,
    ).toBe(at('2025-05-08'));
  });

  it('reports current and prior set availability separately, including later cash-flow publication', () => {
    const current = staggered(FY2024);
    current.cashFlow.period.availableTimestampMs = at('2025-05-12');
    const prior = staggered(FY2023);
    prior.balance.period.availableTimestampMs = at('2025-05-15');
    for (const head of [returnOnAssets, returnOnEquity]) {
      const report = head.explain({ current, prior });
      expect(report.assumptions.period.availableTimestampMs).toBe(at('2025-05-12'));
      expect(report.assumptions.priorPeriod?.availableTimestampMs).toBe(at('2025-05-15'));
    }
  });

  it.each([
    ['currentRatio', currentRatio, 'balance'],
    ['grossMargin', grossMargin, 'income'],
  ] as const)(
    '%s teaches the direct repair without accepting an incomplete full set',
    (name, head, kind) => {
      try {
        head({ statements: { income: FY2023.income, balance: FY2023.balance } } as never);
        throw new Error('incomplete full set accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(InputError);
        expect(error).toMatchObject({ code: 'input.wrong_type', context: { field: 'cashFlow' } });
        expect((error as Error).message).toContain(`${name}({ ${kind}`);
      }
    },
  );

  it('replaces a full-validator example with the supported head-specific repair', () => {
    const statements = structuredClone(FY2023);
    delete (statements.income as Partial<typeof statements.income>).netIncome;
    let message = '';
    try {
      currentRatio({ statements });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'input.missing_field',
        context: { field: 'income.netIncome' },
      });
      message = (error as Error).message;
    }
    const example = message.split('e.g. ')[1];
    expect(example).toBeDefined();
    expect(
      new Function('period', 'currentRatio', `return (${example});`)(
        FY2023.balance.period,
        currentRatio,
      ),
    ).toBe(2);
    expect(message).not.toContain('currentRatio({ income:');
  });

  for (const [kind, heads] of [
    ['income', incomeHeads],
    [
      'balance',
      {
        cashRatio,
        debtToEquity,
        debtToAssets,
      },
    ],
  ] as const) {
    for (const [name, head] of Object.entries(heads)) {
      it(`${name}: the missing-fact example is an executable call to its own head`, () => {
        let message = '';
        try {
          head({
            [kind]: { period: FY2023.income.period },
            ...(name === 'debtServiceCoverage' ? { debtServiceAmount: 10 } : {}),
          } as never);
        } catch (error) {
          expect(error).toMatchObject({ code: 'input.missing_field' });
          message = (error as Error).message;
        }
        const example = message.split('e.g. ')[1];
        expect(example).toBeDefined();
        const run = new Function('period', name, `return (${example});`);
        const result = run(FY2023.income.period, head) as number;
        expect(Number.isFinite(result)).toBe(true);
      });
    }
  }
});
