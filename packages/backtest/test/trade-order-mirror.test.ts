import { describe, expect, it } from 'vitest';
import type { OrderIntent } from '@totalfinance/backtest/execution';
import type { OrderSide, OrderType, TimeInForce } from '@totalfinance/core';
import type { TradeOrder } from '@totalfinance/portfolio/trade';

/**
 * Stage 7B.2 (AT5), Decision 1, amended by the pre-publish repairs (B5/B6): `TradeOrder` in
 * `@totalfinance/portfolio/trade` carries the execution grammar's `OrderIntent` field for field — the
 * same `orderId`, `instrumentId`, `side`, `quantity`, `type`, prices and `timeInForce`, spelled with
 * core's one order vocabulary — plus what a PLAN knows and a fill model does not: when it was
 * planned (`plannedTimestampMs`), the combo it is a leg of (`comboId`), and, once a broker has
 * stamped it, `submittedTimestampMs`. The paper broker projects a submitted order onto the intent;
 * this is a type-level statement of that projection, so a drift fails the typecheck.
 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Flat<T> = { [K in keyof T]: T[K] };
/** The execution grammar's fields, as the trade grammar spells them. */
type OrderIntentView = Flat<
  Pick<
    Required<TradeOrder>,
    'orderId' | 'instrumentId' | 'side' | 'quantity' | 'type' | 'submittedTimestampMs'
  > &
    Pick<TradeOrder, 'limitPrice' | 'stopPrice' | 'timeInForce'>
>;

describe('TradeOrder carries OrderIntent (Stage 7B.2 Decision 1, repairs B5/B6)', () => {
  it('the execution view of a trade order is exactly an order intent', () => {
    const identical: Equal<OrderIntentView, OrderIntent> = true;
    const reverse: Equal<OrderIntent, OrderIntentView> = true;
    expect(identical && reverse).toBe(true);
  });

  it("the vocabulary is core's: side, type and time-in-force are one type on both sides", () => {
    const side: Equal<TradeOrder['side'], OrderSide> = true;
    const type: Equal<TradeOrder['type'], OrderType> = true;
    const tif: Equal<NonNullable<TradeOrder['timeInForce']>, TimeInForce> = true;
    const intentSide: Equal<OrderIntent['side'], OrderSide> = true;
    const intentType: Equal<OrderIntent['type'], OrderType> = true;
    expect(side && type && tif && intentSide && intentType).toBe(true);
  });

  it("a plan order becomes an order intent by the broker's stamp, and only then", () => {
    const planned: TradeOrder = {
      orderId: 'plan:1:SPY:buy',
      instrumentId: 'SPY',
      side: 'buy',
      quantity: 10,
      type: 'limit',
      limitPrice: 100,
      timeInForce: 'day',
      plannedTimestampMs: 1_700_000_000_000,
    };
    // Not yet an intent: the fill model needs the submission instant the broker stamps.
    // @ts-expect-error — submittedTimestampMs is optional on a plan's order and required on an intent
    const premature: OrderIntent = planned;
    const submitted = { ...planned, submittedTimestampMs: 1_700_000_060_000 };
    const { plannedTimestampMs: _planned, ...intent } = submitted;
    const asIntent: OrderIntent = intent;
    expect(asIntent.submittedTimestampMs).toBe(1_700_000_060_000);
    expect(premature.orderId).toBe(planned.orderId);
  });
});
