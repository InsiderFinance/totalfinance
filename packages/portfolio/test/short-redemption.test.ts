/** R03: redemption relieves signed lots through the existing kernel, without a synthetic cover. */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  createPortfolioLedger,
  portfolioSnapshot,
  type LotReliefPolicy,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
} from '@totalfinance/portfolio';

const envelope = (
  eventId: string,
  effectiveTimestampMs: number,
  event: PortfolioEvent,
): PortfolioEventEnvelope => ({
  eventId,
  schemaVersion: 1,
  eventType: event.eventType,
  sourceId: 'redemption-test',
  accountId: 'main',
  effectiveTimestampMs,
  recordedTimestampMs: effectiveTimestampMs,
  event,
  provenance: {},
});
const opening = (direction: 1 | -1): PortfolioEventEnvelope[] => [
  envelope('cash', 1, { eventType: 'cash.deposit', amount: 10_000, currency: 'USD' }),
  envelope('first', 2, {
    eventType: 'trade.fill',
    instrumentId: 'BOND',
    side: direction > 0 ? 'buy' : 'sell',
    quantity: 5,
    pricePerUnit: 98,
    currency: 'USD',
    contractMultiplier: 2,
  }),
  envelope('second', 3, {
    eventType: 'trade.fill',
    instrumentId: 'BOND',
    side: direction > 0 ? 'buy' : 'sell',
    quantity: 5,
    pricePerUnit: 102,
    currency: 'USD',
    contractMultiplier: 2,
  }),
];
const redemption = (
  quantity: number,
  pricePerUnit = 101,
  redemptionType: 'maturity' | 'principal-paydown' | 'call' | 'sinking-fund' = 'maturity',
  extra: { lotSelections?: { lotId: string; quantity: number }[] } = {},
) =>
  envelope('redeem', 4, {
    eventType: 'fixed-income.redemption',
    instrumentId: 'BOND',
    redemptionType,
    quantity,
    pricePerUnit,
    currency: 'USD',
    settleTimestampMs: 6,
    ...extra,
  });

describe('signed fixed-income redemption', () => {
  it.each<LotReliefPolicy>(['fifo', 'lifo', 'highest-cost', 'specific-lot'])(
    '%s fully redeems either direction, with opposing principal cash and realized P&L',
    (lotRelief) => {
      for (const direction of [1, -1] as const) {
        const event = redemption(10);
        const ledger = createPortfolioLedger({
          baseCurrency: 'USD',
          lotRelief,
          events: [...opening(direction), event],
        });
        const account = ledger.state.accounts['main']!;
        expect(account.positions).toEqual({});
        // Entry principal: 5*98*2 + 5*102*2 = 2,000. Redemption: 10*101*2 = 2,020.
        expect(account.cashBalances['USD']!.totalAmount).toBe(10_000 + direction * 20);
        expect(account.realizedPnl['USD']).toBe(direction * 20);
        expect(account.cashBalances['USD']!.settlementSchedule).toEqual([
          { eventId: 'redeem', amount: direction * 2_020, settleTimestampMs: 6 },
        ]);
        for (const asOf of [5, 6]) {
          const valued = portfolioSnapshot({
            portfolio: ledger.state,
            asOf,
            market: createMarketSnapshot({ asOf, observations: { spots: {} } }),
          });
          const cash = valued.cash[0]!;
          expect(cash.unsettledReceivable).toBe(asOf < 6 && direction > 0 ? 2_020 : 0);
          expect(cash.unsettledPayable).toBe(asOf < 6 && direction < 0 ? 2_020 : 0);
          expect(cash.settledAmount).toBe(
            asOf < 6 ? 10_000 - direction * 2_000 : 10_000 + direction * 20,
          );
          expect(valued.netAssetValue).toBe(10_000 + direction * 20);
        }
        // Ledger replay is idempotent; a delivery retry must not pay principal twice.
        const replayed = ledger.apply([event]);
        expect(replayed.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(
          10_000 + direction * 20,
        );
      }
    },
  );

  it.each(['principal-paydown', 'call', 'sinking-fund'] as const)(
    '%s partially relieves short lots without flipping their direction',
    (redemptionType) => {
      const ledger = createPortfolioLedger({
        baseCurrency: 'USD',
        events: [...opening(-1), redemption(3, 100, redemptionType)],
      });
      const account = ledger.state.accounts['main']!;
      const position = account.positions['BOND']!;
      expect(position.quantity).toBe(-7);
      expect(
        position.lots.map((lot) => ({ quantity: lot.quantity, basis: lot.costBasisPerUnit })),
      ).toEqual([
        { quantity: -2, basis: 98 },
        { quantity: -5, basis: 102 },
      ]);
      // FIFO pays 600 and realizes (98-100)*3*2 = -12.
      expect(account.cashBalances['USD']!.totalAmount).toBe(11_400);
      expect(account.realizedPnl['USD']).toBe(-12);
    },
  );

  it('specific-lot short paydown respects the selected opening proceeds', () => {
    const ledger = createPortfolioLedger({
      baseCurrency: 'USD',
      lotRelief: 'specific-lot',
      events: opening(-1),
    });
    const secondLot = ledger.state.accounts['main']!.positions['BOND']!.lots[1]!.lotId;
    const redeemed = ledger.apply([
      redemption(3, 100, 'principal-paydown', {
        lotSelections: [{ lotId: secondLot, quantity: 3 }],
      }),
    ]);
    const account = redeemed.state.accounts['main']!;
    expect(account.positions['BOND']!.lots.map((lot) => lot.quantity)).toEqual([-5, -2]);
    expect(account.realizedPnl['USD']).toBe(12); // (102-100)*3*2
  });

  it('keeps capacity, full-maturity, currency, and missing-position guards for shorts', () => {
    for (const event of [redemption(11), redemption(3)]) {
      expect(() =>
        createPortfolioLedger({ baseCurrency: 'USD', events: [...opening(-1), event] }),
      ).toThrowError(expect.objectContaining({ code: ErrorCode.InputOutOfRange }));
    }
    const wrongCurrency = redemption(10);
    if (wrongCurrency.event.eventType === 'fixed-income.redemption')
      wrongCurrency.event.currency = 'EUR';
    expect(() =>
      createPortfolioLedger({ baseCurrency: 'USD', events: [...opening(-1), wrongCurrency] }),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.InputOutOfRange }));
    expect(() =>
      createPortfolioLedger({ baseCurrency: 'USD', events: [redemption(10)] }),
    ).toThrow();
  });
});
