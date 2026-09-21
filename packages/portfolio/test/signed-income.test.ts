/** R03: negative dividends/coupons are short obligations, not financing or external flows. */
import { describe, expect, it } from 'vitest';
import { ErrorCode, isoDateToEpochMs } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  createPortfolioLedger,
  portfolioPnl,
  portfolioSnapshot,
  readPortfolioLedgerSnapshot,
  type IncomeType,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';

const envelope = (eventId: string, at: number, event: PortfolioEvent): PortfolioEventEnvelope => ({
  eventId,
  schemaVersion: 1,
  eventType: event.eventType,
  sourceId: 'signed-income',
  accountId: 'main',
  effectiveTimestampMs: at,
  recordedTimestampMs: at,
  event,
  provenance: {},
});
const deposit = envelope('deposit', 1, {
  eventType: 'cash.deposit',
  amount: 1_000,
  currency: 'USD',
});
const income = (incomeType: IncomeType, amount: number) =>
  envelope('income', 2, {
    eventType: 'income.received',
    incomeType,
    amount,
    currency: 'USD',
    instrumentId: 'HELD',
    settleTimestampMs: 4,
  });

describe('signed dividend and coupon ledger obligations', () => {
  it.each(['dividend', 'coupon'] as const)(
    '%s: P&L reports negative income and its reversal without financing or external flows',
    (incomeType) => {
      const mark = (valuationDate: string) => ({
        valuationDate,
        market: createMarketSnapshot({ asOf: valuationDate, observations: { spots: {} } }),
      });
      const event = envelope('owed', isoDateToEpochMs('2026-01-03'), {
        eventType: 'income.received',
        incomeType,
        amount: -100,
        currency: 'USD',
        instrumentId: 'HELD',
        settleTimestampMs: isoDateToEpochMs('2026-01-05'),
      });
      const ledger = createPortfolioLedger({
        baseCurrency: 'USD',
        events: [
          envelope('capital', isoDateToEpochMs('2026-01-01'), {
            eventType: 'cash.deposit',
            amount: 1_000,
            currency: 'USD',
          }),
          event,
        ],
      });
      const owed = portfolioPnl({ ledger, from: mark('2026-01-02'), to: mark('2026-01-04') });
      expect(owed.components).toEqual({
        income: -100,
        realizedPnl: 0,
        unrealizedPnl: 0,
        transactionCosts: 0,
        financing: 0,
        foreignExchangePnl: 0,
        totalPnl: -100,
      });
      expect(owed.externalFlows).toBe(0);
      expect(owed.investmentReturn).toBe(-100);
      expect(owed.residual).toBe(0);
      expect(owed.groupings.find((group) => group.dimension === 'instrument')!.rows).toEqual([
        expect.objectContaining({ label: 'HELD', income: -100, totalPnl: -100 }),
      ]);
      const reversed = ledger.apply([
        {
          ...envelope('reverse', isoDateToEpochMs('2026-01-06'), {
            eventType: 'admin.reversal',
            original: event,
          }),
          reversesEventId: event.eventId,
        },
      ]);
      const corrected = portfolioPnl({
        ledger: reversed,
        from: mark('2026-01-04'),
        to: mark('2026-01-07'),
      });
      expect(corrected.components.income).toBe(100);
      expect(corrected.investmentReturn).toBe(100);
      expect(corrected.externalFlows).toBe(0);
      expect(corrected.residual).toBe(0);
    },
  );

  it.each(['dividend', 'coupon'] as const)(
    '%s: either sign accrues to income and settles with no new external flow',
    (incomeType) => {
      for (const amount of [-100, 100]) {
        const event = income(incomeType, amount);
        const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [deposit, event] });
        const account = ledger.state.accounts['main']!;
        expect(account.incomeReceived['USD']).toBe(amount);
        expect(account.incomeByInstrument['HELD']?.['USD']).toBe(amount);
        expect(account.financingCosts).toEqual({});
        expect(account.transactionCosts).toEqual({});
        for (const asOf of [3, 4]) {
          const valued = portfolioSnapshot({
            portfolio: ledger.state,
            asOf,
            market: createMarketSnapshot({ asOf, observations: { spots: {} } }),
          });
          expect(valued.netAssetValue).toBe(1_000 + amount);
          expect(valued.cash[0]).toMatchObject({
            totalAmount: 1_000 + amount,
            settledAmount: asOf < 4 ? 1_000 : 1_000 + amount,
            unsettledPayable: asOf < 4 && amount < 0 ? 100 : 0,
            unsettledReceivable: asOf < 4 && amount > 0 ? 100 : 0,
          });
        }
        const restored = readPortfolioLedgerSnapshot({
          snapshot: JSON.parse(JSON.stringify(ledger.toJSON())),
        }).ledger;
        expect(restored.state).toEqual(ledger.state);
        expect(ledger.apply([event]).state).toEqual(ledger.state);
        const reversed = restored.apply([
          {
            ...envelope('reverse', 5, { eventType: 'admin.reversal', original: event }),
            reversesEventId: event.eventId,
          },
        ]);
        expect(reversed.state.accounts['main']!.cashBalances['USD']).toEqual({
          totalAmount: 1_000,
          settlementSchedule: [],
        });
        expect(reversed.state.accounts['main']!.incomeReceived['USD'] ?? 0).toBe(0);
        expect(reversed.state.accounts['main']!.incomeByInstrument['HELD']?.['USD'] ?? 0).toBe(0);
      }
    },
  );

  it.each(['interest', 'staking-reward', 'funding-receipt'] as const)(
    '%s still requires a positive receipt',
    (incomeType) => {
      expect(() =>
        createPortfolioLedger({ baseCurrency: 'USD', events: [deposit, income(incomeType, -1)] }),
      ).toThrowError(expect.objectContaining({ code: ErrorCode.InputOutOfRange }));
      expect(
        createPortfolioLedger({ baseCurrency: 'USD', events: [deposit, income(incomeType, 1)] })
          .state.accounts['main']!.incomeReceived['USD'],
      ).toBe(1);
    },
  );

  it.each(['dividend', 'coupon'] as const)(
    '%s refuses zero and nonfinite amounts',
    (incomeType) => {
      for (const amount of [0, Number.NaN, Infinity, -Infinity]) {
        expect(() =>
          createPortfolioLedger({
            baseCurrency: 'USD',
            events: [deposit, income(incomeType, amount)],
          }),
        ).toThrow();
      }
    },
  );
});
