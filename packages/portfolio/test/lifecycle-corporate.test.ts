/**
 * FC7 slice 5 — corporate actions, fixed-income redemptions, and position transfers over the ONE
 * reducer kernel. Every number is hand-computed in a comment; history is never approximated.
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  portfolioSnapshot,
  readPortfolioLedgerSnapshot,
  type LotReliefPolicy,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
  type TradeFillEvent,
} from '../src/index.js';

function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  accountId: string,
  event: PortfolioEvent,
  overrides: Partial<PortfolioEventEnvelope> = {},
): PortfolioEventEnvelope {
  return {
    eventId,
    schemaVersion: 1,
    eventType: event.eventType,
    sourceId: 'test',
    accountId,
    effectiveTimestampMs,
    recordedTimestampMs: effectiveTimestampMs,
    event,
    provenance: {},
    ...overrides,
  };
}

const at = (month: number, day: number, hour = 15) => Date.UTC(2026, month - 1, day, hour);

function fill(
  eventId: string,
  timestampMs: number,
  accountId: string,
  instrumentId: string,
  side: 'buy' | 'sell',
  quantity: number,
  pricePerUnit: number,
  extra: Partial<Omit<TradeFillEvent, 'eventType'>> = {},
): PortfolioEventEnvelope {
  return envelope(eventId, timestampMs, accountId, {
    eventType: 'trade.fill',
    instrumentId,
    side,
    quantity,
    pricePerUnit,
    currency: 'USD',
    ...extra,
  });
}

const reversal = (
  eventId: string,
  timestampMs: number,
  original: PortfolioEventEnvelope,
): PortfolioEventEnvelope =>
  envelope(
    eventId,
    timestampMs,
    original.accountId,
    { eventType: 'admin.reversal', original },
    { reversesEventId: original.eventId },
  );

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The refusal's code AND every teaching fragment — a typed error that does not teach is a defect. */
function expectRefusal(fn: () => unknown, code: string, ...fragments: string[]): void {
  const error = caught(fn);
  expect(error, `expected a throw with code ${code}`).toBeDefined();
  expect(isQuantError(error, code), `expected ${code}, got ${(error as Error).message}`).toBe(true);
  for (const fragment of fragments) expect((error as Error).message).toContain(fragment);
}

function ledgerOf(events: PortfolioEventEnvelope[], lotRelief?: LotReliefPolicy) {
  return createPortfolioLedger({
    baseCurrency: 'USD',
    ...(lotRelief !== undefined ? { lotRelief } : {}),
    events,
  });
}

/** Σ lot.quantity × lot.costBasisPerUnit — the capital a position still carries. */
const basisOf = (lots: readonly { quantity: number; costBasisPerUnit: number }[]): number =>
  lots.reduce((sum, lot) => sum + lot.quantity * lot.costBasisPerUnit, 0);

const DEPOSIT = envelope('dep-1', at(1, 2), 'main', {
  eventType: 'cash.deposit',
  amount: 100_000,
  currency: 'USD',
});
/** lot-1: 100 AAPL @150 → cash 85,000. */
const BUY = fill('fill-1', at(1, 10), 'main', 'AAPL', 'buy', 100, 150);
/** FIFO relief of 40 @170 against 150: realized (170 − 150) × 40 = 800; cash +6,800. */
const SELL_40 = fill('fill-2', at(1, 20), 'main', 'AAPL', 'sell', 40, 170);
const COMMISSION = envelope('cost-1', at(1, 21), 'main', {
  eventType: 'cost.charge',
  costType: 'commission',
  amount: 10,
  currency: 'USD',
  instrumentId: 'AAPL',
});
const DIVIDEND = envelope('div-1', at(2, 1), 'main', {
  eventType: 'income.received',
  incomeType: 'dividend',
  amount: 50,
  currency: 'USD',
  instrumentId: 'AAPL',
});
/** A variation-margin future: no capital basis to re-base or relieve. */
const BUY_FUTURE = fill('fill-fut', at(1, 10), 'main', 'ESZ6', 'buy', 2, 5_000, {
  contractMultiplier: 50,
  settlementStyle: 'variation-margin',
  contract: { kind: 'future', underlyingInstrumentId: 'ES', expiryTimestampMs: at(12, 18) },
});

// ---------------------------------------------------------------------------------------------------
// corporate.symbol-change
// ---------------------------------------------------------------------------------------------------

describe('corporate.symbol-change — the position, its lots, and its history move to the new key', () => {
  const HISTORY = [DEPOSIT, BUY, SELL_40, COMMISSION, DIVIDEND];
  const RENAME = envelope('ren-1', at(2, 10), 'main', {
    eventType: 'corporate.symbol-change',
    fromInstrumentId: 'AAPL',
    toInstrumentId: 'AAPL2',
  });

  it('carries lots, lot ids, basis, profile, and per-instrument attribution; account totals are untouched', () => {
    const main = ledgerOf([...HISTORY, RENAME]).state.accounts['main']!;
    expect(main.positions['AAPL']).toBeUndefined();
    const renamed = main.positions['AAPL2']!;
    expect(renamed.instrumentId).toBe('AAPL2');
    expect(renamed.quantity).toBe(60);
    expect(renamed.lots).toEqual([
      {
        lotId: 'lot-1',
        openedByEventId: 'fill-1',
        openedTimestampMs: at(1, 10),
        quantity: 60,
        costBasisPerUnit: 150,
      },
    ]);
    expect(renamed.currency).toBe('USD');
    expect(renamed.contractMultiplier).toBe(1);
    expect(renamed.settlementStyle).toBe('cash-on-trade');
    // Realized 800, costs 10, income 50 — all now visible under the new key, nothing under the old.
    expect(main.realizedPnlByInstrument).toEqual({ AAPL2: { USD: 800 } });
    expect(main.incomeByInstrument).toEqual({ AAPL2: { USD: 50 } });
    expect(main.transactionCostsByInstrument).toEqual({ AAPL2: { USD: 10 } });
    expect(main.realizedPnl['USD']).toBe(800);
    // 100,000 − 15,000 + 6,800 − 10 + 50 = 91,840
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(91_840, 9);
  });

  it('reverses EXACTLY: the accounts deep-equal the pre-rename fold, and the link is recorded', () => {
    const before = ledgerOf(HISTORY).state.accounts;
    const reversed = ledgerOf([...HISTORY, RENAME]).apply([reversal('rev-ren', at(2, 11), RENAME)]);
    expect(reversed.state.accounts).toEqual(before);
    expect(reversed.state.reversals).toEqual({ '["test","ren-1"]': '["test","rev-ren"]' });
  });

  it('merge-adds attribution when the new key already carries history from a closed position', () => {
    // MSFT: buy 10 @300 (lot-1), sell 10 @310 → realized 100 under MSFT; the position closes.
    // AAPL: buy 100 @150 (lot-2), sell 40 @170 → realized 800 under AAPL. Rename AAPL → MSFT.
    const main = ledgerOf([
      DEPOSIT,
      fill('fill-m1', at(1, 5), 'main', 'MSFT', 'buy', 10, 300),
      fill('fill-m2', at(1, 6), 'main', 'MSFT', 'sell', 10, 310),
      BUY,
      SELL_40,
      envelope('ren-m', at(2, 10), 'main', {
        eventType: 'corporate.symbol-change',
        fromInstrumentId: 'AAPL',
        toInstrumentId: 'MSFT',
      }),
    ]).state.accounts['main']!;
    expect(main.positions['AAPL']).toBeUndefined();
    expect(main.positions['MSFT']!.lots.map((lot) => lot.lotId)).toEqual(['lot-2']);
    expect(main.realizedPnlByInstrument).toEqual({ MSFT: { USD: 900 } });
  });

  it('refuses a rename onto a held instrument (naming corporate.merger) and of an instrument not held', () => {
    expectRefusal(
      () =>
        ledgerOf([
          DEPOSIT,
          BUY,
          fill('fill-3', at(1, 11), 'main', 'MSFT', 'buy', 10, 300),
          envelope('ren-x', at(2, 10), 'main', {
            eventType: 'corporate.symbol-change',
            fromInstrumentId: 'AAPL',
            toInstrumentId: 'MSFT',
          }),
        ]),
      'input.out_of_range',
      'already holds 10 MSFT',
      'corporate.merger',
    );
    expectRefusal(
      () => ledgerOf([DEPOSIT, RENAME]),
      'input.out_of_range',
      'holds no open position',
    );
  });

  it('reversal refuses once the renamed position is gone, or the old id is held again', () => {
    const base = ledgerOf([...HISTORY, RENAME]);
    const renamedAgain = base.apply([
      envelope('ren-2', at(2, 12), 'main', {
        eventType: 'corporate.symbol-change',
        fromInstrumentId: 'AAPL2',
        toInstrumentId: 'AAPL3',
      }),
    ]);
    expectRefusal(
      () => renamedAgain.apply([reversal('rev-ren', at(2, 13), RENAME)]),
      'portfolio.reversal_infeasible',
      'no longer holds AAPL2',
    );
    const rebought = base.apply([fill('fill-4', at(2, 12), 'main', 'AAPL', 'buy', 5, 100)]);
    expectRefusal(
      () => rebought.apply([reversal('rev-ren', at(2, 13), RENAME)]),
      'portfolio.reversal_infeasible',
      'holds AAPL again',
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// corporate.merger
// ---------------------------------------------------------------------------------------------------

describe('corporate.merger — stock converts lots in place, cash relieves them, mixed re-bases then converts', () => {
  const STOCK = envelope('mrg-1', at(2, 5), 'main', {
    eventType: 'corporate.merger',
    fromInstrumentId: 'AAPL',
    toInstrumentId: 'NEWCO',
    sharesPerShare: 0.5,
  });
  const DEPOSIT_10K = envelope('dep-c', at(1, 2), 'main', {
    eventType: 'cash.deposit',
    amount: 10_000,
    currency: 'USD',
  });
  /** lot-1: 100 AAPL @25 → cash 7,500. */
  const BUY_25 = fill('fill-c', at(1, 10), 'main', 'AAPL', 'buy', 100, 25);
  const CASH = envelope('mrg-c', at(2, 5), 'main', {
    eventType: 'corporate.merger',
    fromInstrumentId: 'AAPL',
    cashPerShare: 30,
    currency: 'USD',
    settleTimestampMs: at(2, 7),
  });
  const MIXED = envelope('mrg-m', at(2, 5), 'main', {
    eventType: 'corporate.merger',
    fromInstrumentId: 'AAPL',
    toInstrumentId: 'NEWCO',
    sharesPerShare: 0.5,
    cashPerShare: 10,
    currency: 'USD',
  });

  it('stock 1:0.5 into a new id: 100 @150 becomes 50 @300, total basis 15,000 exactly, lot identity kept', () => {
    const main = ledgerOf([DEPOSIT, BUY, STOCK]).state.accounts['main']!;
    expect(main.positions['AAPL']).toBeUndefined();
    const newco = main.positions['NEWCO']!;
    expect(newco.quantity).toBe(50);
    expect(newco.lots).toEqual([
      {
        lotId: 'lot-1',
        openedByEventId: 'fill-1',
        openedTimestampMs: at(1, 10),
        quantity: 50,
        costBasisPerUnit: 300,
      },
    ]);
    // 50 × 300 = 15,000 = 100 × 150 — preserved exactly, not approximately.
    expect(basisOf(newco.lots)).toBe(15_000);
    expect(newco.currency).toBe('USD');
    expect(newco.contractMultiplier).toBe(1);
    expect(main.cashBalances['USD']!.totalAmount).toBe(85_000);
    expect(main.realizedPnl['USD']).toBeUndefined();

    // With history: after the sell lot-1 holds 60 @150 = 9,000 → 30 @300 = 9,000; attribution follows.
    const withHistory = ledgerOf([DEPOSIT, BUY, SELL_40, COMMISSION, STOCK]).state.accounts[
      'main'
    ]!;
    expect(withHistory.positions['NEWCO']!.quantity).toBe(30);
    expect(basisOf(withHistory.positions['NEWCO']!.lots)).toBe(9_000);
    expect(withHistory.realizedPnlByInstrument).toEqual({ NEWCO: { USD: 800 } });
    expect(withHistory.transactionCostsByInstrument).toEqual({ NEWCO: { USD: 10 } });
  });

  it('stock into an EXISTING position appends the converted lots after the ones already held', () => {
    // NEWCO first: 10 @280 (lot-1). Then AAPL 100 @150 (lot-2) → converts to 50 @300.
    const newco = ledgerOf([
      DEPOSIT,
      fill('fill-n', at(1, 5), 'main', 'NEWCO', 'buy', 10, 280),
      BUY,
      STOCK,
    ]).state.accounts['main']!.positions['NEWCO']!;
    expect(newco.quantity).toBe(60);
    expect(newco.lots.map((lot) => [lot.lotId, lot.quantity, lot.costBasisPerUnit])).toEqual([
      ['lot-1', 10, 280],
      ['lot-2', 50, 300],
    ]);
    // 10 × 280 + 50 × 300 = 2,800 + 15,000 = 17,800
    expect(basisOf(newco.lots)).toBe(17_800);
  });

  it('pure cash at 30 against basis 25: realized 500, cash +3,000 on the schedule, the position retired', () => {
    const main = ledgerOf([DEPOSIT_10K, BUY_25, CASH]).state.accounts['main']!;
    expect(main.positions['AAPL']).toBeUndefined();
    // (30 − 25) × 100 = 500
    expect(main.realizedPnl['USD']).toBe(500);
    expect(main.realizedPnlByInstrument).toEqual({ AAPL: { USD: 500 } });
    // 10,000 − 2,500 + 3,000 = 10,500
    expect(main.cashBalances['USD']!.totalAmount).toBe(10_500);
    expect(main.cashBalances['USD']!.settlementSchedule).toEqual([
      { eventId: 'mrg-c', amount: 3_000, settleTimestampMs: at(2, 7) },
    ]);
  });

  it('mixed consideration: the cash re-bases each lot first, the remainder converts; a lot below zero realizes the excess and floors', () => {
    // 100 @25; cash 10/share → +1,000 (cash 8,500); basis 25 − 10 = 15 → 50 NEWCO @30 = 1,500 = 2,500 − 1,000.
    const main = ledgerOf([DEPOSIT_10K, BUY_25, MIXED]).state.accounts['main']!;
    expect(main.cashBalances['USD']!.totalAmount).toBe(8_500);
    expect(main.positions['AAPL']).toBeUndefined();
    expect(main.positions['NEWCO']!.lots).toEqual([
      {
        lotId: 'lot-1',
        openedByEventId: 'fill-c',
        openedTimestampMs: at(1, 10),
        quantity: 50,
        costBasisPerUnit: 30,
      },
    ]);
    expect(basisOf(main.positions['NEWCO']!.lots)).toBe(1_500);
    expect(main.realizedPnl['USD']).toBeUndefined();

    // Floor: 100 @8 (cash 9,200); cash 10/share → +1,000 (10,200); 8 − 10 < 0 → realized 2 × 100 = 200,
    // the lot floors at 0 and converts to 50 NEWCO @0.
    const floored = ledgerOf([
      DEPOSIT_10K,
      fill('fill-f', at(1, 10), 'main', 'AAPL', 'buy', 100, 8),
      MIXED,
    ]).state.accounts['main']!;
    expect(floored.cashBalances['USD']!.totalAmount).toBe(10_200);
    expect(floored.realizedPnl['USD']).toBe(200);
    expect(floored.realizedPnlByInstrument).toEqual({ NEWCO: { USD: 200 } });
    expect(floored.positions['NEWCO']!.lots).toEqual([
      expect.objectContaining({ lotId: 'lot-1', quantity: 50, costBasisPerUnit: 0 }),
    ]);
  });

  it('refuses a short position (naming the deferral), a cash currency that is not the position’s, a variation-margin position, and a destination of the other sign', () => {
    expectRefusal(
      () => ledgerOf([fill('fill-s', at(1, 10), 'main', 'AAPL', 'sell', 100, 150), CASH]),
      'input.out_of_range',
      'SHORT 100',
      'deferred',
    );
    expectRefusal(
      () =>
        ledgerOf([
          DEPOSIT,
          BUY,
          envelope('mrg-e', at(2, 5), 'main', {
            eventType: 'corporate.merger',
            fromInstrumentId: 'AAPL',
            cashPerShare: 30,
            currency: 'EUR',
          }),
        ]),
      'input.out_of_range',
      'books EUR',
      'cash.conversion',
    );
    expectRefusal(
      () =>
        ledgerOf([
          BUY_FUTURE,
          envelope('mrg-v', at(2, 5), 'main', {
            eventType: 'corporate.merger',
            fromInstrumentId: 'ESZ6',
            toInstrumentId: 'ESH7',
            sharesPerShare: 1,
          }),
        ]),
      'input.out_of_range',
      "'variation-margin' position",
    );
    expectRefusal(
      () =>
        ledgerOf([
          DEPOSIT,
          BUY,
          fill('fill-ns', at(1, 11), 'main', 'NEWCO', 'sell', 10, 300),
          STOCK,
        ]),
      'input.out_of_range',
      'both signs',
    );
  });

  it('reversal is refused — converted or relieved lots have no exact inverse', () => {
    expectRefusal(
      () => ledgerOf([DEPOSIT, BUY, STOCK]).apply([reversal('rev-mrg', at(2, 6), STOCK)]),
      'portfolio.reversal_infeasible',
      'converted every AAPL lot into NEWCO',
    );
    expectRefusal(
      () => ledgerOf([DEPOSIT_10K, BUY_25, CASH]).apply([reversal('rev-mrg', at(2, 8), CASH)]),
      'portfolio.reversal_infeasible',
      'relieved every AAPL lot at 30',
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// corporate.spin-off
// ---------------------------------------------------------------------------------------------------

describe('corporate.spin-off — an explicit fraction of each parent lot’s basis becomes a child lot', () => {
  /** lot-1: 100 PARENT @50 → cash 95,000. */
  const BUY_PARENT = fill('fill-p', at(1, 10), 'main', 'PARENT', 'buy', 100, 50);
  const SPIN = envelope('spin-1', at(2, 5), 'main', {
    eventType: 'corporate.spin-off',
    parentInstrumentId: 'PARENT',
    childInstrumentId: 'CHILD',
    sharesPerParentShare: 2,
    basisAllocationFraction: 0.2,
  });

  it('1:2 with f = 0.2 on 100 @50: child 200 @5, parent 100 @40, 5,000 preserved exactly, holding period carried', () => {
    const main = ledgerOf([DEPOSIT, BUY_PARENT, SPIN]).state.accounts['main']!;
    const parent = main.positions['PARENT']!;
    const child = main.positions['CHILD']!;
    expect(parent.quantity).toBe(100);
    expect(parent.lots).toEqual([
      {
        lotId: 'lot-1',
        openedByEventId: 'fill-p',
        openedTimestampMs: at(1, 10),
        quantity: 100,
        costBasisPerUnit: 40,
      },
    ]);
    // Child basis per unit = (50 × 100 × 0.2) ÷ 200 = 5; the lot keeps the PARENT lot's opening
    // date under the spin-off's own event id.
    expect(child.lots).toEqual([
      {
        lotId: 'lot-2',
        openedByEventId: 'spin-1',
        openedTimestampMs: at(1, 10),
        quantity: 200,
        costBasisPerUnit: 5,
      },
    ]);
    expect(child.quantity).toBe(200);
    expect(child.currency).toBe('USD');
    expect(child.contractMultiplier).toBe(1);
    expect(child.settlementStyle).toBe('cash-on-trade');
    // 100 × 40 + 200 × 5 = 4,000 + 1,000 = 5,000 = 100 × 50
    expect(basisOf(parent.lots) + basisOf(child.lots)).toBe(5_000);
    expect(main.cashBalances['USD']!.totalAmount).toBe(95_000);
    expect(main.realizedPnl['USD']).toBeUndefined();
    expect(main.incomeReceived['USD']).toBeUndefined();
  });

  it('allocates per lot: two parent lots yield two child lots, each carrying its own parent date', () => {
    // lot-1 100 @50 (01-10), lot-2 50 @60 (01-15). Child lot-3 = 200 @ (50 × 100 × 0.2) ÷ 200 = 5;
    // child lot-4 = 100 @ (60 × 50 × 0.2) ÷ 100 = 6. Parent lots re-base to 40 and 48.
    // Total: 100 × 40 + 50 × 48 + 200 × 5 + 100 × 6 = 4,000 + 2,400 + 1,000 + 600 = 8,000 = 5,000 + 3,000.
    const main = ledgerOf([
      DEPOSIT,
      BUY_PARENT,
      fill('fill-p2', at(1, 15), 'main', 'PARENT', 'buy', 50, 60),
      SPIN,
    ]).state.accounts['main']!;
    const parent = main.positions['PARENT']!;
    const child = main.positions['CHILD']!;
    expect(child.lots).toEqual([
      {
        lotId: 'lot-3',
        openedByEventId: 'spin-1',
        openedTimestampMs: at(1, 10),
        quantity: 200,
        costBasisPerUnit: 5,
      },
      {
        lotId: 'lot-4',
        openedByEventId: 'spin-1',
        openedTimestampMs: at(1, 15),
        quantity: 100,
        costBasisPerUnit: 6,
      },
    ]);
    expect(parent.lots.map((lot) => lot.costBasisPerUnit)).toEqual([40, 48]);
    expect(basisOf(parent.lots) + basisOf(child.lots)).toBe(8_000);
  });

  it('refuses a short parent, a child position in another currency, a short child, and a variation-margin parent', () => {
    expectRefusal(
      () => ledgerOf([fill('fill-sp', at(1, 10), 'main', 'PARENT', 'sell', 100, 50), SPIN]),
      'input.out_of_range',
      'SHORT 100',
    );
    expectRefusal(
      () =>
        ledgerOf([
          DEPOSIT,
          BUY_PARENT,
          fill('fill-ce', at(1, 11), 'main', 'CHILD', 'buy', 10, 20, { currency: 'EUR' }),
          SPIN,
        ]),
      'input.out_of_range',
      'currency USD vs the open position',
    );
    expectRefusal(
      () =>
        ledgerOf([
          DEPOSIT,
          BUY_PARENT,
          fill('fill-cs', at(1, 11), 'main', 'CHILD', 'sell', 10, 20),
          SPIN,
        ]),
      'input.out_of_range',
      'both signs',
    );
    expectRefusal(
      () =>
        ledgerOf([
          BUY_FUTURE,
          envelope('spin-v', at(2, 5), 'main', {
            eventType: 'corporate.spin-off',
            parentInstrumentId: 'ESZ6',
            childInstrumentId: 'KID',
            sharesPerParentShare: 1,
            basisAllocationFraction: 0.5,
          }),
        ]),
      'input.out_of_range',
      "'variation-margin' position",
    );
  });

  it('reversal is refused — the fold keeps no per-lot record of the allocation', () => {
    expectRefusal(
      () => ledgerOf([DEPOSIT, BUY_PARENT, SPIN]).apply([reversal('rev-spin', at(2, 6), SPIN)]),
      'portfolio.reversal_infeasible',
      'spin-off re-based every PARENT lot',
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// corporate.return-of-capital
// ---------------------------------------------------------------------------------------------------

describe('corporate.return-of-capital — cash reduces basis, never income; excess over basis is realized', () => {
  /** lot-1: 100 AAPL @50 → cash 95,000. */
  const BUY_50 = fill('fill-r', at(1, 10), 'main', 'AAPL', 'buy', 100, 50);
  const ROC = envelope('roc-1', at(2, 5), 'main', {
    eventType: 'corporate.return-of-capital',
    instrumentId: 'AAPL',
    amountPerShare: 1.5,
    currency: 'USD',
    settleTimestampMs: at(2, 7),
  });

  it('1.5/share on basis 50: basis 48.5, cash +150 on the schedule, nothing realized, nothing as income', () => {
    const main = ledgerOf([DEPOSIT, BUY_50, ROC]).state.accounts['main']!;
    const position = main.positions['AAPL']!;
    expect(position.quantity).toBe(100);
    expect(position.lots[0]!.costBasisPerUnit).toBe(48.5);
    // 95,000 + 1.5 × 100 = 95,150
    expect(main.cashBalances['USD']!.totalAmount).toBe(95_150);
    expect(main.cashBalances['USD']!.settlementSchedule).toEqual([
      { eventId: 'roc-1', amount: 150, settleTimestampMs: at(2, 7) },
    ]);
    expect(main.incomeReceived['USD']).toBeUndefined();
    expect(main.incomeByInstrument).toEqual({});
    expect(main.realizedPnl['USD']).toBeUndefined();
  });

  it('floor: basis 1 with 1.5/share returned → basis 0 and 50 realized', () => {
    // 100 @1 (cash 99,900); +150 → 100,050; excess (1.5 − 1) × 100 = 50 realized.
    const main = ledgerOf([DEPOSIT, fill('fill-r1', at(1, 10), 'main', 'AAPL', 'buy', 100, 1), ROC])
      .state.accounts['main']!;
    expect(main.positions['AAPL']!.lots[0]!.costBasisPerUnit).toBe(0);
    expect(main.cashBalances['USD']!.totalAmount).toBe(100_050);
    expect(main.realizedPnl['USD']).toBe(50);
    expect(main.realizedPnlByInstrument).toEqual({ AAPL: { USD: 50 } });
    expect(main.incomeReceived['USD']).toBeUndefined();
  });

  it('refuses a short position (naming cost.charge), a currency mismatch, and a variation-margin position', () => {
    expectRefusal(
      () => ledgerOf([fill('fill-rs', at(1, 10), 'main', 'AAPL', 'sell', 100, 50), ROC]),
      'input.out_of_range',
      'SHORT 100',
      'cost.charge',
    );
    expectRefusal(
      () =>
        ledgerOf([
          DEPOSIT,
          BUY_50,
          envelope('roc-e', at(2, 5), 'main', {
            eventType: 'corporate.return-of-capital',
            instrumentId: 'AAPL',
            amountPerShare: 1.5,
            currency: 'EUR',
          }),
        ]),
      'input.out_of_range',
      'books EUR',
    );
    expectRefusal(
      () =>
        ledgerOf([
          BUY_FUTURE,
          envelope('roc-v', at(2, 5), 'main', {
            eventType: 'corporate.return-of-capital',
            instrumentId: 'ESZ6',
            amountPerShare: 1,
            currency: 'USD',
          }),
        ]),
      'input.out_of_range',
      "'variation-margin' position",
    );
  });

  it('reversal is refused in this build — the fold keeps no per-lot record of the reduction', () => {
    expectRefusal(
      () => ledgerOf([DEPOSIT, BUY_50, ROC]).apply([reversal('rev-roc', at(2, 8), ROC)]),
      'portfolio.reversal_infeasible',
      'return of capital re-based every AAPL lot',
      'cash.withdrawal',
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// corporate.cash-in-lieu
// ---------------------------------------------------------------------------------------------------

describe('corporate.cash-in-lieu — the surrendered fraction is relieved at amount ÷ quantity', () => {
  const BUY_50 = fill('fill-r', at(1, 10), 'main', 'AAPL', 'buy', 100, 50);
  const CIL = envelope('cil-1', at(2, 5), 'main', {
    eventType: 'corporate.cash-in-lieu',
    instrumentId: 'AAPL',
    quantity: 0.4,
    amount: 60,
    currency: 'USD',
    relatesToEventId: 'split-x',
  });

  it('0.4 shares for 60 against basis 50: realized 60 − 0.4 × 50 = 40, 99.6 remain, cash +60', () => {
    const main = ledgerOf([DEPOSIT, BUY_50, CIL]).state.accounts['main']!;
    const position = main.positions['AAPL']!;
    expect(position.quantity).toBeCloseTo(99.6, 9);
    expect(position.lots).toHaveLength(1);
    expect(position.lots[0]!.quantity).toBeCloseTo(99.6, 9);
    expect(position.lots[0]!.costBasisPerUnit).toBe(50);
    // Relief at 60 ÷ 0.4 = 150 per unit: (150 − 50) × 0.4 = 40.
    expect(main.realizedPnl['USD']).toBeCloseTo(40, 9);
    expect(main.realizedPnlByInstrument['AAPL']!['USD']).toBeCloseTo(40, 9);
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(95_060, 9);
    expect(main.incomeReceived['USD']).toBeUndefined();
  });

  it('refuses more than held, a currency mismatch, a short position, and a specific-lot ledger with several lots (naming trade.fill); one lot leaves nothing to choose', () => {
    expectRefusal(
      () => ledgerOf([DEPOSIT, fill('fill-one', at(1, 10), 'main', 'AAPL', 'buy', 0.3, 50), CIL]),
      'input.out_of_range',
      'holds 0.3',
    );
    expectRefusal(
      () =>
        ledgerOf([
          DEPOSIT,
          BUY_50,
          envelope('cil-e', at(2, 5), 'main', {
            eventType: 'corporate.cash-in-lieu',
            instrumentId: 'AAPL',
            quantity: 0.4,
            amount: 60,
            currency: 'EUR',
          }),
        ]),
      'input.out_of_range',
      'books EUR',
    );
    expectRefusal(
      () => ledgerOf([fill('fill-cs', at(1, 10), 'main', 'AAPL', 'sell', 100, 50), CIL]),
      'input.out_of_range',
      'SHORT 100',
    );
    expectRefusal(
      () =>
        ledgerOf(
          [DEPOSIT, BUY_50, fill('fill-r2', at(1, 11), 'main', 'AAPL', 'buy', 100, 52), CIL],
          'specific-lot',
        ),
      'input.missing_field',
      'trade.fill sell (quantity 0.4, pricePerUnit 150)',
    );
    const single = ledgerOf([DEPOSIT, BUY_50, CIL], 'specific-lot').state.accounts['main']!;
    expect(single.realizedPnl['USD']).toBeCloseTo(40, 9);
    expect(single.positions['AAPL']!.quantity).toBeCloseTo(99.6, 9);
  });

  it('reversal is refused — relieved lots cannot be restored exactly', () => {
    expectRefusal(
      () => ledgerOf([DEPOSIT, BUY_50, CIL]).apply([reversal('rev-cil', at(2, 6), CIL)]),
      'portfolio.reversal_infeasible',
      'cash-in-lieu relieved 0.4 AAPL',
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// fixed-income.redemption
// ---------------------------------------------------------------------------------------------------

describe('fixed-income.redemption — face units relieved at the redemption price; a maturity retires the instrument', () => {
  const DEPOSIT_20K = envelope('dep-b', at(1, 2), 'main', {
    eventType: 'cash.deposit',
    amount: 20_000,
    currency: 'USD',
  });
  /** lot-1: 10,000 face @0.98 → cash 20,000 − 9,800 = 10,200. */
  const BUY_BOND = fill('fill-b', at(1, 10), 'main', 'BOND', 'buy', 10_000, 0.98);
  const MATURITY = envelope('red-1', at(6, 1), 'main', {
    eventType: 'fixed-income.redemption',
    instrumentId: 'BOND',
    redemptionType: 'maturity',
    quantity: 10_000,
    pricePerUnit: 1,
    currency: 'USD',
  });

  it('maturity at par on 10,000 face @0.98: realized 200, cash +10,000, the position retired', () => {
    const main = ledgerOf([DEPOSIT_20K, BUY_BOND, MATURITY]).state.accounts['main']!;
    expect(main.positions['BOND']).toBeUndefined();
    // (1 − 0.98) × 10,000 = 200
    expect(main.realizedPnl['USD']).toBeCloseTo(200, 9);
    expect(main.realizedPnlByInstrument['BOND']!['USD']).toBeCloseTo(200, 9);
    // 10,200 + 10,000 = 20,200
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(20_200, 9);
    expect(main.incomeReceived['USD']).toBeUndefined();
  });

  it('a principal paydown relieves part of the face: 2,000 @1 → realized 40, 8,000 remain, cash +2,000 on the schedule', () => {
    const paydown = envelope('red-2', at(3, 1), 'main', {
      eventType: 'fixed-income.redemption',
      instrumentId: 'BOND',
      redemptionType: 'principal-paydown',
      quantity: 2_000,
      pricePerUnit: 1,
      currency: 'USD',
      settleTimestampMs: at(3, 3),
    });
    const main = ledgerOf([DEPOSIT_20K, BUY_BOND, paydown]).state.accounts['main']!;
    const bond = main.positions['BOND']!;
    expect(bond.quantity).toBe(8_000);
    expect(bond.lots).toEqual([
      expect.objectContaining({ lotId: 'lot-1', quantity: 8_000, costBasisPerUnit: 0.98 }),
    ]);
    // (1 − 0.98) × 2,000 = 40
    expect(main.realizedPnl['USD']).toBeCloseTo(40, 9);
    // 10,200 + 2,000 = 12,200
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(12_200, 9);
    expect(main.cashBalances['USD']!.settlementSchedule).toEqual([
      { eventId: 'red-2', amount: 2_000, settleTimestampMs: at(3, 3) },
    ]);
  });

  it('carries the contract multiplier: 10 units @98 × 100 called at 101 → realized 3,000, cash +101,000', () => {
    const main = ledgerOf([
      envelope('dep-x', at(1, 2), 'main', {
        eventType: 'cash.deposit',
        amount: 200_000,
        currency: 'USD',
      }),
      fill('fill-x', at(1, 10), 'main', 'BOND2', 'buy', 10, 98, { contractMultiplier: 100 }),
      envelope('red-x', at(4, 1), 'main', {
        eventType: 'fixed-income.redemption',
        instrumentId: 'BOND2',
        redemptionType: 'call',
        quantity: 10,
        pricePerUnit: 101,
        currency: 'USD',
      }),
    ]).state.accounts['main']!;
    // (101 − 98) × 10 × 100 = 3,000; cash 200,000 − 98,000 + 101,000 = 203,000
    expect(main.realizedPnl['USD']).toBe(3_000);
    expect(main.cashBalances['USD']!.totalAmount).toBe(203_000);
    expect(main.positions['BOND2']).toBeUndefined();
  });

  it('refuses a maturity of less than held (naming principal-paydown), more than held, a currency mismatch, and a variation-margin position', () => {
    const redemption = (
      eventId: string,
      overrides: Partial<Extract<PortfolioEvent, { eventType: 'fixed-income.redemption' }>>,
    ) =>
      envelope(eventId, at(6, 1), 'main', {
        ...(MATURITY.event as Extract<PortfolioEvent, { eventType: 'fixed-income.redemption' }>),
        ...overrides,
      });
    expectRefusal(
      () => ledgerOf([DEPOSIT_20K, BUY_BOND, redemption('red-p', { quantity: 5_000 })]),
      'input.out_of_range',
      'redeems 5000 of 10000 BOND',
      "'principal-paydown'",
    );
    expectRefusal(
      () => ledgerOf([DEPOSIT_20K, BUY_BOND, redemption('red-o', { quantity: 12_000 })]),
      'input.out_of_range',
      'holds 10000',
    );
    expectRefusal(
      () => ledgerOf([DEPOSIT_20K, BUY_BOND, redemption('red-e', { currency: 'EUR' })]),
      'input.out_of_range',
      'books EUR',
    );
    expectRefusal(
      () =>
        ledgerOf([
          BUY_FUTURE,
          redemption('red-v', { instrumentId: 'ESZ6', quantity: 2, pricePerUnit: 5_000 }),
        ]),
      'input.out_of_range',
      "'variation-margin' position",
    );
  });

  it('under specific-lot, lotSelections drive the relief; a whole-position maturity needs none; a partial without them refuses; names on a FIFO ledger refuse', () => {
    // lot-1 5,000 @0.97; lot-2 5,000 @0.99. Paydown 3,000 from lot-2 @1 → (1 − 0.99) × 3,000 = 30;
    // lot-2 keeps 2,000. Maturity of the remaining 7,000 @1 without selections →
    // (1 − 0.97) × 5,000 + (1 − 0.99) × 2,000 = 150 + 20 = 170. Total realized 200.
    const buys = [
      DEPOSIT_20K,
      fill('fill-b1', at(1, 10), 'main', 'BOND', 'buy', 5_000, 0.97),
      fill('fill-b2', at(1, 11), 'main', 'BOND', 'buy', 5_000, 0.99),
    ];
    const named = envelope('red-s', at(3, 1), 'main', {
      eventType: 'fixed-income.redemption',
      instrumentId: 'BOND',
      redemptionType: 'principal-paydown',
      quantity: 3_000,
      pricePerUnit: 1,
      currency: 'USD',
      lotSelections: [{ lotId: 'lot-2', quantity: 3_000 }],
    });
    const paidDown = ledgerOf([...buys, named], 'specific-lot');
    const bond = paidDown.state.accounts['main']!.positions['BOND']!;
    expect(bond.quantity).toBe(7_000);
    expect(bond.lots.map((lot) => [lot.lotId, lot.quantity])).toEqual([
      ['lot-1', 5_000],
      ['lot-2', 2_000],
    ]);
    expect(paidDown.state.accounts['main']!.realizedPnl['USD']).toBeCloseTo(30, 9);
    const matured = paidDown.apply([
      envelope('red-m', at(6, 1), 'main', {
        eventType: 'fixed-income.redemption',
        instrumentId: 'BOND',
        redemptionType: 'maturity',
        quantity: 7_000,
        pricePerUnit: 1,
        currency: 'USD',
      }),
    ]);
    expect(matured.state.accounts['main']!.positions['BOND']).toBeUndefined();
    expect(matured.state.accounts['main']!.realizedPnl['USD']).toBeCloseTo(200, 9);
    expectRefusal(
      () =>
        ledgerOf(
          [
            ...buys,
            envelope('red-n', at(3, 1), 'main', {
              eventType: 'fixed-income.redemption',
              instrumentId: 'BOND',
              redemptionType: 'principal-paydown',
              quantity: 3_000,
              pricePerUnit: 1,
              currency: 'USD',
            }),
          ],
          'specific-lot',
        ),
      'input.missing_field',
      'event.lotSelections must name the lots relieved',
    );
    expectRefusal(
      () => ledgerOf([...buys, named], 'fifo'),
      'input.out_of_range',
      'silently ignored',
    );
  });

  it('reversal is refused — relieved lots cannot be restored exactly', () => {
    expectRefusal(
      () =>
        ledgerOf([DEPOSIT_20K, BUY_BOND, MATURITY]).apply([
          reversal('rev-red', at(6, 2), MATURITY),
        ]),
      'portfolio.reversal_infeasible',
      'maturity redemption relieved 10000 BOND',
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// position.transfer
// ---------------------------------------------------------------------------------------------------

describe('position.transfer — lots MOVE between accounts; identity, dates, and basis travel with them', () => {
  /** lot-1: 40 AAPL @150 → cash 94,000. */
  const BUY_A = fill('fill-1', at(1, 10), 'main', 'AAPL', 'buy', 40, 150);
  /** lot-2: 60 AAPL @160 → cash 84,400. */
  const BUY_B = fill('fill-2', at(1, 12), 'main', 'AAPL', 'buy', 60, 160);
  const transfer = (
    eventId: string,
    quantity: number,
    lotSelections?: { lotId: string; quantity: number }[],
  ) =>
    envelope(eventId, at(2, 5), 'main', {
      eventType: 'position.transfer',
      instrumentId: 'AAPL',
      quantity,
      fromAccountId: 'main',
      toAccountId: 'ira',
      ...(lotSelections !== undefined ? { lotSelections } : {}),
    });
  const XFER_60 = transfer('xfer-1', 60);

  it('moves 60 of 100 FIFO across two lots: lot-1 travels whole, lot-2 splits; ids, dates, basis preserved; no cash, nothing realized', () => {
    const state = ledgerOf([DEPOSIT, BUY_A, BUY_B, XFER_60]).state;
    const main = state.accounts['main']!;
    const ira = state.accounts['ira']!;
    // FIFO: all 40 of lot-1, then 20 of lot-2. lot-2 keeps 40 in main.
    expect(main.positions['AAPL']!.quantity).toBe(40);
    expect(main.positions['AAPL']!.lots).toEqual([
      {
        lotId: 'lot-2',
        openedByEventId: 'fill-2',
        openedTimestampMs: at(1, 12),
        quantity: 40,
        costBasisPerUnit: 160,
      },
    ]);
    // The whole lot-1 keeps its id; the 20 split from lot-2 is a NEW lot carrying lot-2's date and event.
    const moved = ira.positions['AAPL']!;
    expect(moved.quantity).toBe(60);
    expect(moved.lots).toEqual([
      {
        lotId: 'lot-1',
        openedByEventId: 'fill-1',
        openedTimestampMs: at(1, 10),
        quantity: 40,
        costBasisPerUnit: 150,
      },
      {
        lotId: 'lot-3',
        openedByEventId: 'fill-2',
        openedTimestampMs: at(1, 12),
        quantity: 20,
        costBasisPerUnit: 160,
      },
    ]);
    expect(moved.currency).toBe('USD');
    expect(moved.contractMultiplier).toBe(1);
    expect(state.lotSequence).toBe(3);
    expect(main.cashBalances['USD']!.totalAmount).toBe(84_400);
    expect(ira.cashBalances).toEqual({});
    expect(main.realizedPnl).toEqual({});
    expect(ira.realizedPnl).toEqual({});
    // Total basis across both accounts is unchanged: 40 × 150 + 60 × 160 = 6,000 + 9,600 = 15,600.
    expect(basisOf(main.positions['AAPL']!.lots) + basisOf(moved.lots)).toBe(15_600);
  });

  it('specific-lot: named lots move; a whole position needs no names; a partial without names refuses; names on a FIFO ledger refuse; bad names teach', () => {
    const named = ledgerOf(
      [DEPOSIT, BUY_A, BUY_B, transfer('xfer-s', 30, [{ lotId: 'lot-2', quantity: 30 }])],
      'specific-lot',
    ).state;
    expect(
      named.accounts['main']!.positions['AAPL']!.lots.map((lot) => [lot.lotId, lot.quantity]),
    ).toEqual([
      ['lot-1', 40],
      ['lot-2', 30],
    ]);
    expect(named.accounts['ira']!.positions['AAPL']!.lots).toEqual([
      {
        lotId: 'lot-3',
        openedByEventId: 'fill-2',
        openedTimestampMs: at(1, 12),
        quantity: 30,
        costBasisPerUnit: 160,
      },
    ]);

    const whole = ledgerOf([DEPOSIT, BUY_A, BUY_B, transfer('xfer-w', 100)], 'specific-lot').state;
    expect(whole.accounts['main']!.positions['AAPL']).toBeUndefined();
    expect(whole.accounts['ira']!.positions['AAPL']!.lots.map((lot) => lot.lotId)).toEqual([
      'lot-1',
      'lot-2',
    ]);
    expect(whole.accounts['ira']!.positions['AAPL']!.quantity).toBe(100);

    expectRefusal(
      () => ledgerOf([DEPOSIT, BUY_A, BUY_B, transfer('xfer-n', 30)], 'specific-lot'),
      'input.missing_field',
      'event.lotSelections must name the lots moved',
    );
    expectRefusal(
      () =>
        ledgerOf(
          [DEPOSIT, BUY_A, BUY_B, transfer('xfer-f', 30, [{ lotId: 'lot-2', quantity: 30 }])],
          'fifo',
        ),
      'input.out_of_range',
      'silently ignored',
    );
    expectRefusal(
      () =>
        ledgerOf(
          [DEPOSIT, BUY_A, BUY_B, transfer('xfer-sum', 30, [{ lotId: 'lot-2', quantity: 20 }])],
          'specific-lot',
        ),
      'input.out_of_range',
      'sum to 20',
    );
    expectRefusal(
      () =>
        ledgerOf(
          [DEPOSIT, BUY_A, BUY_B, transfer('xfer-9', 30, [{ lotId: 'lot-9', quantity: 30 }])],
          'specific-lot',
        ),
      'portfolio.lot_unavailable',
      "lot 'lot-9'",
    );
    expectRefusal(
      () =>
        ledgerOf(
          [DEPOSIT, BUY_A, BUY_B, transfer('xfer-over', 41, [{ lotId: 'lot-1', quantity: 41 }])],
          'specific-lot',
        ),
      'portfolio.lot_unavailable',
      'holds only 40',
    );
  });

  it('a short position transfers its short lots', () => {
    // Sell 50 TSLA @300 to open (lot-1, −50). Move 20 → main keeps −30; ira receives lot-2 (−20 @300).
    const state = ledgerOf([
      fill('fill-sh', at(1, 10), 'main', 'TSLA', 'sell', 50, 300),
      envelope('xfer-sh', at(2, 5), 'main', {
        eventType: 'position.transfer',
        instrumentId: 'TSLA',
        quantity: 20,
        fromAccountId: 'main',
        toAccountId: 'ira',
      }),
    ]).state;
    expect(state.accounts['main']!.positions['TSLA']!.quantity).toBe(-30);
    expect(state.accounts['main']!.positions['TSLA']!.lots[0]).toMatchObject({
      lotId: 'lot-1',
      quantity: -30,
      costBasisPerUnit: 300,
    });
    expect(state.accounts['ira']!.positions['TSLA']!.quantity).toBe(-20);
    expect(state.accounts['ira']!.positions['TSLA']!.lots).toEqual([
      {
        lotId: 'lot-2',
        openedByEventId: 'fill-sh',
        openedTimestampMs: at(1, 10),
        quantity: -20,
        costBasisPerUnit: 300,
      },
    ]);
  });

  it('refuses more than held, a destination holding the instrument in another currency (named for the receiving account), and a destination of the other sign', () => {
    expectRefusal(
      () => ledgerOf([DEPOSIT, BUY_A, BUY_B, transfer('xfer-x', 150)]),
      'input.out_of_range',
      'holds 100',
    );
    expectRefusal(
      () =>
        ledgerOf([
          DEPOSIT,
          BUY_A,
          BUY_B,
          fill('fill-ira', at(1, 13), 'ira', 'AAPL', 'buy', 10, 140, { currency: 'EUR' }),
          XFER_60,
        ]),
      'input.out_of_range',
      "into account 'ira'",
      'in EUR, while the moving lots are in USD',
    );
    expectRefusal(
      () =>
        ledgerOf([
          DEPOSIT,
          BUY_A,
          BUY_B,
          fill('fill-ira-s', at(1, 13), 'ira', 'AAPL', 'sell', 10, 150),
          XFER_60,
        ]),
      'input.out_of_range',
      "into account 'ira'",
      'both signs',
    );
  });

  it('reversal is refused (lot identities changed) — the transfer back is the repair', () => {
    expectRefusal(
      () =>
        ledgerOf([DEPOSIT, BUY_A, BUY_B, XFER_60]).apply([reversal('rev-x', at(2, 6), XFER_60)]),
      'portfolio.reversal_infeasible',
      "position.transfer back from 'ira'",
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// The whole family: determinism, serialization, replay, valuation
// ---------------------------------------------------------------------------------------------------

describe('the family folds deterministically, serializes, restores by replay, and values', () => {
  // 1. deposit 100,000                                   cash 100,000
  // 2. buy 100 AAPL @150 (lot-1)                          cash 85,000
  // 3. buy 10,000 BOND @0.98 (lot-2)                      cash 75,200
  // 4. rename AAPL → AAPL2
  // 5. spin-off AAPL2 → KID 1:1, f = 0.1: KID lot-3 100 @ (150 × 100 × 0.1) ÷ 100 = 15; AAPL2 @135
  // 6. KID return of capital 0.5/share: +50 → 75,250; KID @14.5
  // 7. KID cash-in-lieu 0.5 for 8: price 16, realized (16 − 14.5) × 0.5 = 0.75; KID 99.5; cash 75,258
  // 8. AAPL2 → BIGCO 0.5 + cash 5: +500 → 75,758; basis 135 − 5 = 130 → BIGCO lot-1 50 @260
  // 9. BOND maturity @1: realized (1 − 0.98) × 10,000 = 200; +10,000 → 85,758
  // 10. BIGCO 30 main → ira: main lot-1 20 @260; ira lot-4 30 @260 (fill-1's date and event)
  const JOURNEY: PortfolioEventEnvelope[] = [
    DEPOSIT,
    BUY,
    fill('fill-2', at(1, 12), 'main', 'BOND', 'buy', 10_000, 0.98),
    envelope('ren-1', at(1, 15), 'main', {
      eventType: 'corporate.symbol-change',
      fromInstrumentId: 'AAPL',
      toInstrumentId: 'AAPL2',
    }),
    envelope('spin-1', at(1, 20), 'main', {
      eventType: 'corporate.spin-off',
      parentInstrumentId: 'AAPL2',
      childInstrumentId: 'KID',
      sharesPerParentShare: 1,
      basisAllocationFraction: 0.1,
    }),
    envelope('roc-1', at(1, 25), 'main', {
      eventType: 'corporate.return-of-capital',
      instrumentId: 'KID',
      amountPerShare: 0.5,
      currency: 'USD',
    }),
    envelope('cil-1', at(1, 26), 'main', {
      eventType: 'corporate.cash-in-lieu',
      instrumentId: 'KID',
      quantity: 0.5,
      amount: 8,
      currency: 'USD',
    }),
    envelope('mrg-1', at(2, 1), 'main', {
      eventType: 'corporate.merger',
      fromInstrumentId: 'AAPL2',
      toInstrumentId: 'BIGCO',
      sharesPerShare: 0.5,
      cashPerShare: 5,
      currency: 'USD',
    }),
    envelope('red-1', at(2, 10), 'main', {
      eventType: 'fixed-income.redemption',
      instrumentId: 'BOND',
      redemptionType: 'maturity',
      quantity: 10_000,
      pricePerUnit: 1,
      currency: 'USD',
    }),
    envelope('xfer-1', at(2, 15), 'main', {
      eventType: 'position.transfer',
      instrumentId: 'BIGCO',
      quantity: 30,
      fromAccountId: 'main',
      toAccountId: 'ira',
    }),
  ];

  it('reaches the hand-computed end state', () => {
    const state = ledgerOf(JOURNEY).state;
    const main = state.accounts['main']!;
    const ira = state.accounts['ira']!;
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(85_758, 9);
    expect(Object.keys(main.positions).sort()).toEqual(['BIGCO', 'KID']);
    expect(main.positions['BIGCO']!.lots).toEqual([
      {
        lotId: 'lot-1',
        openedByEventId: 'fill-1',
        openedTimestampMs: at(1, 10),
        quantity: 20,
        costBasisPerUnit: 260,
      },
    ]);
    expect(main.positions['KID']!.quantity).toBeCloseTo(99.5, 9);
    expect(main.positions['KID']!.lots[0]).toMatchObject({
      lotId: 'lot-3',
      openedByEventId: 'spin-1',
      openedTimestampMs: at(1, 10),
      costBasisPerUnit: 14.5,
    });
    expect(ira.positions['BIGCO']!.lots).toEqual([
      {
        lotId: 'lot-4',
        openedByEventId: 'fill-1',
        openedTimestampMs: at(1, 10),
        quantity: 30,
        costBasisPerUnit: 260,
      },
    ]);
    // 0.75 (cash-in-lieu) + 200 (maturity) = 200.75
    expect(main.realizedPnl['USD']).toBeCloseTo(200.75, 9);
    expect(main.realizedPnlByInstrument['KID']!['USD']).toBeCloseTo(0.75, 9);
    expect(main.realizedPnlByInstrument['BOND']!['USD']).toBeCloseTo(200, 9);
    expect(main.incomeReceived).toEqual({});
    expect(state.lotSequence).toBe(4);
    expect(state.eventCount).toBe(10);
  });

  it('same events → deep-equal state; incremental folding equals the one-shot fold', () => {
    const oneShot = applyPortfolioEvents({ portfolio: { baseCurrency: 'USD' }, events: JOURNEY });
    expect(applyPortfolioEvents({ portfolio: { baseCurrency: 'USD' }, events: JOURNEY })).toEqual(
      oneShot,
    );
    const first = applyPortfolioEvents({
      portfolio: { baseCurrency: 'USD' },
      events: JOURNEY.slice(0, 5),
    });
    const incremental = applyPortfolioEvents({ previousState: first, events: JOURNEY.slice(5) });
    expect(incremental).toEqual(oneShot);
    // An identical replay is a no-op.
    expect(applyPortfolioEvents({ previousState: oneShot, events: JOURNEY })).toEqual(oneShot);
  });

  it('round-trips through the ledger envelope: replay IS the deserializer', () => {
    const ledger = ledgerOf(JOURNEY);
    const restored = readPortfolioLedgerSnapshot({ snapshot: JSON.parse(JSON.stringify(ledger)) });
    expect(restored.ledger.state).toEqual(ledger.state);
    expect(restored.ledger.events.map((event) => event.eventId)).toEqual(
      JOURNEY.map((event) => event.eventId),
    );
    expect(restored.migrationsApplied).toEqual([]);
  });

  it('values the transformed positions with their carried profiles', () => {
    const market = createMarketSnapshot({
      asOf: at(3, 1),
      observations: {
        spots: { BIGCO: { price: 270, currency: 'USD' }, KID: { price: 16, currency: 'USD' } },
      },
    });
    const valued = portfolioSnapshot({
      portfolio: ledgerOf(JOURNEY).state,
      asOf: at(3, 1),
      market,
    });
    // Cash 85,758 + main BIGCO 20 × 270 = 5,400 + main KID 99.5 × 16 = 1,592 + ira BIGCO 30 × 270 = 8,100
    // = 100,850.
    expect(valued.netAssetValue).toBeCloseTo(100_850, 9);
    expect(
      valued.positions.map((row) => [
        row.accountId,
        row.instrumentId,
        row.costBasis,
        row.unrealizedPnl,
      ]),
    ).toEqual([
      ['ira', 'BIGCO', 7_800, 300],
      ['main', 'BIGCO', 5_200, 200],
      ['main', 'KID', 1_442.75, 149.25],
    ]);
  });
});
