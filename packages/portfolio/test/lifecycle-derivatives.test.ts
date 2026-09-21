/**
 * FC7 slice 5 — the derivative-lifecycle family (exercise, assignment, expiration, cash and
 * physical settlement, multiplier changes, variation margin, rolls) over the ONE reducer kernel a
 * fill uses. Every number is hand-computed in a comment first; the code is checked against the
 * paper, never the other way round.
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import type { DerivativeContractTerms, SettlementStyle } from '../src/events.js';
import {
  applyPortfolioEvents,
  createPortfolioLedger,
  portfolioLedgerContentHash,
  portfolioSnapshot,
  readPortfolioLedgerSnapshot,
  type LotReliefPolicy,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
  type PortfolioLedger,
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

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
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

// ---------------------------------------------------------------------------------------------------
// Instruments and fills
// ---------------------------------------------------------------------------------------------------

const CALL = 'AAPL 260320C200';
const PUT = 'AAPL 260320P200';
const CALL_210 = 'AAPL 260417C210';
const ESH6 = 'ESH6';
const ESM6 = 'ESM6';
const PERP = 'BTC-PERP';

const AAPL_200C: DerivativeContractTerms = {
  kind: 'option',
  underlyingInstrumentId: 'AAPL',
  type: 'call',
  strikePricePerUnit: 200,
  expiryTimestampMs: at(3, 20),
};
const AAPL_200P: DerivativeContractTerms = { ...AAPL_200C, type: 'put' };
const AAPL_210C: DerivativeContractTerms = {
  ...AAPL_200C,
  strikePricePerUnit: 210,
  expiryTimestampMs: at(4, 17),
};
const ES_MAR: DerivativeContractTerms = {
  kind: 'future',
  underlyingInstrumentId: 'ES',
  expiryTimestampMs: at(3, 20),
};
const ES_JUN: DerivativeContractTerms = { ...ES_MAR, expiryTimestampMs: at(6, 19) };
const BTC_PERP: DerivativeContractTerms = { kind: 'perpetual', underlyingInstrumentId: 'BTC' };

const DEPOSIT = envelope('dep-1', at(1, 2), 'main', {
  eventType: 'cash.deposit',
  amount: 100_000,
  currency: 'USD',
});

function shareFill(
  eventId: string,
  timestampMs: number,
  side: 'buy' | 'sell',
  quantity: number,
  pricePerUnit: number,
  instrumentId = 'AAPL',
): PortfolioEventEnvelope {
  return envelope(eventId, timestampMs, 'main', {
    eventType: 'trade.fill',
    instrumentId,
    side,
    quantity,
    pricePerUnit,
    currency: 'USD',
  });
}

function optionFill(
  eventId: string,
  timestampMs: number,
  instrumentId: string,
  side: 'buy' | 'sell',
  quantity: number,
  pricePerUnit: number,
  contract: DerivativeContractTerms,
  contractMultiplier = 100,
): PortfolioEventEnvelope {
  return envelope(eventId, timestampMs, 'main', {
    eventType: 'trade.fill',
    instrumentId,
    side,
    quantity,
    pricePerUnit,
    currency: 'USD',
    contractMultiplier,
    settlementStyle: 'cash-on-trade',
    contract,
  });
}

function marginFill(
  eventId: string,
  timestampMs: number,
  instrumentId: string,
  side: 'buy' | 'sell',
  quantity: number,
  pricePerUnit: number,
  contractMultiplier: number,
  contract: DerivativeContractTerms,
): PortfolioEventEnvelope {
  const settlementStyle: SettlementStyle = 'variation-margin';
  return envelope(eventId, timestampMs, 'main', {
    eventType: 'trade.fill',
    instrumentId,
    side,
    quantity,
    pricePerUnit,
    currency: 'USD',
    contractMultiplier,
    settlementStyle,
    contract,
  });
}

function variationMargin(
  eventId: string,
  timestampMs: number,
  instrumentId: string,
  settlementPricePerUnit: number,
): PortfolioEventEnvelope {
  return envelope(eventId, timestampMs, 'main', {
    eventType: 'derivative.variation-margin',
    instrumentId,
    settlementPricePerUnit,
  });
}

function ledgerOf(
  events: PortfolioEventEnvelope[],
  lotRelief: LotReliefPolicy = 'fifo',
): PortfolioLedger {
  return createPortfolioLedger({ baseCurrency: 'USD', lotRelief, events });
}

const main = (ledger: PortfolioLedger) => ledger.state.accounts['main']!;
const cashOf = (ledger: PortfolioLedger) => main(ledger).cashBalances['USD']!.totalAmount;
const realizedOf = (ledger: PortfolioLedger) => main(ledger).realizedPnl['USD'];
const realizedFor = (ledger: PortfolioLedger, instrumentId: string) =>
  main(ledger).realizedPnlByInstrument[instrumentId]?.['USD'];

// Buy 2 AAPL 200 calls @5 (multiplier 100): cash 100,000 − 2 × 5 × 100 = 99,000.
const BUY_CALLS = optionFill('opt-1', at(1, 10), CALL, 'buy', 2, 5, AAPL_200C);
// Sell 2 AAPL 200 calls @5: cash +1,000; a short lot with opening proceeds 5 per unit.
const SELL_CALLS = optionFill('opt-1', at(1, 10), CALL, 'sell', 2, 5, AAPL_200C);
// 200 AAPL @150: cash −30,000.
const BUY_SHARES = shareFill('sh-1', at(1, 5), 'buy', 200, 150);

// ---------------------------------------------------------------------------------------------------
// Exercise
// ---------------------------------------------------------------------------------------------------

describe('derivative.exercise — a long call takes delivery at the strike', () => {
  it("'realize': the premium is the option's realized loss; shares open at the strike; cash moves at the strike", () => {
    const ledger = ledgerOf([
      DEPOSIT,
      BUY_CALLS,
      envelope('ex-1', at(2, 1), 'main', {
        eventType: 'derivative.exercise',
        instrumentId: CALL,
        quantity: 2,
        settlement: { kind: 'physical' },
        premiumTreatment: 'realize',
        settleTimestampMs: at(2, 3),
      }),
    ]);
    const account = main(ledger);
    // Option lots relieved at 0: (0 − 5) × 2 × 100 = −1,000 realized on the option.
    expect(account.positions[CALL]).toBeUndefined();
    expect(realizedOf(ledger)).toBe(-1_000);
    expect(realizedFor(ledger, CALL)).toBe(-1_000);
    expect(realizedFor(ledger, 'AAPL')).toBeUndefined();
    // 2 × 100 = 200 shares at basis 200 (shares: multiplier 1, cash-on-trade, no terms).
    const shares = account.positions['AAPL']!;
    expect(shares.quantity).toBe(200);
    expect(shares.lots).toHaveLength(1);
    expect(shares.lots[0]).toMatchObject({
      quantity: 200,
      costBasisPerUnit: 200,
      openedByEventId: 'ex-1',
      openedTimestampMs: at(2, 1),
    });
    expect(shares.contractMultiplier).toBe(1);
    expect(shares.settlementStyle).toBe('cash-on-trade');
    expect(shares.contract).toBeUndefined();
    // Cash: 99,000 − 200 × 200 = 59,000, with the strike leg on the settlement schedule.
    expect(cashOf(ledger)).toBe(59_000);
    expect(account.cashBalances['USD']!.settlementSchedule).toEqual([
      { eventId: 'ex-1', amount: -40_000, settleTimestampMs: at(2, 3) },
    ]);
  });

  it("'fold-into-underlying-basis': realized 0, the premium (5 per share) joins the share basis: 205", () => {
    const ledger = ledgerOf([
      DEPOSIT,
      BUY_CALLS,
      envelope('ex-1', at(2, 1), 'main', {
        eventType: 'derivative.exercise',
        instrumentId: CALL,
        quantity: 2,
        settlement: { kind: 'physical' },
        premiumTreatment: 'fold-into-underlying-basis',
      }),
    ]);
    const account = main(ledger);
    expect(account.positions[CALL]).toBeUndefined();
    expect(realizedOf(ledger)).toBeUndefined();
    const shares = account.positions['AAPL']!;
    expect(shares.quantity).toBe(200);
    expect(shares.lots[0]!.costBasisPerUnit).toBe(205);
    // Total outlay 1,000 (premium) + 40,000 (strike) = 41,000 = 200 × 205 — basis is conserved.
    expect(shares.lots[0]!.quantity * shares.lots[0]!.costBasisPerUnit).toBe(41_000);
    // Cash still moves at the strike: 59,000 (the premium moved at the option fill).
    expect(cashOf(ledger)).toBe(59_000);
  });

  it('folds the relieved-quantity-weighted premium of mixed lots: (5 + 7) / 2 = 6 → basis 206', () => {
    const ledger = ledgerOf([
      DEPOSIT,
      optionFill('opt-1', at(1, 10), CALL, 'buy', 1, 5, AAPL_200C),
      optionFill('opt-2', at(1, 11), CALL, 'buy', 1, 7, AAPL_200C),
      envelope('ex-1', at(2, 1), 'main', {
        eventType: 'derivative.exercise',
        instrumentId: CALL,
        quantity: 2,
        settlement: { kind: 'physical' },
        premiumTreatment: 'fold-into-underlying-basis',
      }),
    ]);
    const shares = main(ledger).positions['AAPL']!;
    expect(shares.lots[0]!.costBasisPerUnit).toBe(206);
    // 100,000 − 500 − 700 − 40,000 = 58,800.
    expect(cashOf(ledger)).toBe(58_800);
  });

  it('under specific-lot, the named option lot is relieved: exercising the @7 lot folds 7 → basis 207', () => {
    const ledger = ledgerOf(
      [
        DEPOSIT,
        optionFill('opt-1', at(1, 10), CALL, 'buy', 1, 5, AAPL_200C), // lot-1
        optionFill('opt-2', at(1, 11), CALL, 'buy', 1, 7, AAPL_200C), // lot-2
        envelope('ex-1', at(2, 1), 'main', {
          eventType: 'derivative.exercise',
          instrumentId: CALL,
          quantity: 1,
          settlement: { kind: 'physical' },
          premiumTreatment: 'fold-into-underlying-basis',
          lotSelections: [{ lotId: 'lot-2', quantity: 1 }],
        }),
      ],
      'specific-lot',
    );
    const account = main(ledger);
    const option = account.positions[CALL]!;
    expect(option.quantity).toBe(1);
    expect(option.lots).toEqual([expect.objectContaining({ lotId: 'lot-1', costBasisPerUnit: 5 })]);
    const shares = account.positions['AAPL']!;
    expect(shares.quantity).toBe(100);
    expect(shares.lots[0]!.costBasisPerUnit).toBe(207);
    // 100,000 − 500 − 700 − 100 × 200 = 78,800.
    expect(cashOf(ledger)).toBe(78_800);
  });

  it('covers a short underlying first with the same lot law a fill uses', () => {
    const ledger = ledgerOf([
      DEPOSIT,
      // Short 100 AAPL @210: cash +21,000 → 121,000.
      shareFill('sh-1', at(1, 5), 'sell', 100, 210),
      // Buy 1 call @5: cash −500 → 120,500.
      optionFill('opt-1', at(1, 10), CALL, 'buy', 1, 5, AAPL_200C),
      envelope('ex-1', at(2, 1), 'main', {
        eventType: 'derivative.exercise',
        instrumentId: CALL,
        quantity: 1,
        settlement: { kind: 'physical' },
        premiumTreatment: 'realize',
      }),
    ]);
    const account = main(ledger);
    // Option: (0 − 5) × 1 × 100 = −500. Cover 100 @200 against the @210 short: (210 − 200) × 100 = +1,000.
    expect(realizedFor(ledger, CALL)).toBe(-500);
    expect(realizedFor(ledger, 'AAPL')).toBe(1_000);
    expect(realizedOf(ledger)).toBe(500);
    expect(account.positions['AAPL']).toBeUndefined();
    // 120,500 − 20,000 = 100,500 (= 100,000 + 500 realized).
    expect(cashOf(ledger)).toBe(100_500);
  });
});

describe('derivative.exercise — a long put delivers the underlying at the strike', () => {
  it("'fold': the premium (3) lowers proceeds to 197 → realized (197 − 150) × 200 = 9,400; cash +40,000", () => {
    const ledger = ledgerOf([
      DEPOSIT,
      BUY_SHARES, // 70,000
      optionFill('put-1', at(1, 10), PUT, 'buy', 2, 3, AAPL_200P), // −600 → 69,400
      envelope('ex-1', at(2, 1), 'main', {
        eventType: 'derivative.exercise',
        instrumentId: PUT,
        quantity: 2,
        settlement: { kind: 'physical' },
        premiumTreatment: 'fold-into-underlying-basis',
      }),
    ]);
    const account = main(ledger);
    expect(account.positions[PUT]).toBeUndefined();
    expect(account.positions['AAPL']).toBeUndefined();
    expect(realizedFor(ledger, 'AAPL')).toBe(9_400);
    expect(realizedFor(ledger, PUT)).toBeUndefined();
    expect(realizedOf(ledger)).toBe(9_400);
    // 69,400 + 200 × 200 = 109,400 — the journey's net gain is exactly the realized figure.
    expect(cashOf(ledger)).toBe(109_400);
    expect(cashOf(ledger) - 100_000).toBe(realizedOf(ledger)!);
  });

  it("'realize' with no shares held: the option loses its premium and a short share lot opens at the strike", () => {
    const ledger = ledgerOf([
      DEPOSIT,
      optionFill('put-1', at(1, 10), PUT, 'buy', 2, 3, AAPL_200P), // 99,400
      envelope('ex-1', at(2, 1), 'main', {
        eventType: 'derivative.exercise',
        instrumentId: PUT,
        quantity: 2,
        settlement: { kind: 'physical' },
        premiumTreatment: 'realize',
      }),
    ]);
    const account = main(ledger);
    // (0 − 3) × 2 × 100 = −600 on the option; 200 shares sold short at 200 → cash 99,400 + 40,000.
    expect(realizedFor(ledger, PUT)).toBe(-600);
    expect(account.positions['AAPL']!.quantity).toBe(-200);
    expect(account.positions['AAPL']!.lots[0]).toMatchObject({
      quantity: -200,
      costBasisPerUnit: 200,
    });
    expect(cashOf(ledger)).toBe(139_400);
  });
});

describe('derivative.exercise — cash settlement pays the intrinsic value', () => {
  const cashExercise = (
    instrumentId: string,
    settlementPricePerUnit: number,
    premiumTreatment: 'realize' | 'fold-into-underlying-basis' = 'realize',
    settleTimestampMs?: number,
  ) =>
    envelope('ex-1', at(2, 1), 'main', {
      eventType: 'derivative.exercise',
      instrumentId,
      quantity: 2,
      settlement: { kind: 'cash', settlementPricePerUnit },
      premiumTreatment,
      ...(settleTimestampMs !== undefined ? { settleTimestampMs } : {}),
    });

  it('a long call at S = 210 (I = 10): cash +2,000, realized (10 − 5) × 2 × 100 = 1,000, no shares', () => {
    const ledger = ledgerOf([DEPOSIT, BUY_CALLS, cashExercise(CALL, 210)]);
    const account = main(ledger);
    expect(account.positions[CALL]).toBeUndefined();
    expect(account.positions['AAPL']).toBeUndefined();
    expect(realizedOf(ledger)).toBe(1_000);
    expect(realizedFor(ledger, CALL)).toBe(1_000);
    expect(cashOf(ledger)).toBe(101_000);
  });

  it('out of the money (S = 195, I = 0): the premium is lost, no cash moves, and no zero leg is scheduled', () => {
    const ledger = ledgerOf([DEPOSIT, BUY_CALLS, cashExercise(CALL, 195, 'realize', at(2, 3))]);
    expect(realizedOf(ledger)).toBe(-1_000);
    expect(cashOf(ledger)).toBe(99_000);
    expect(main(ledger).cashBalances['USD']!.settlementSchedule).toEqual([]);
  });

  it('a long put at S = 190 (I = 10): realized (10 − 3) × 2 × 100 = 1,400, cash +2,000', () => {
    const ledger = ledgerOf([
      DEPOSIT,
      optionFill('put-1', at(1, 10), PUT, 'buy', 2, 3, AAPL_200P), // 99,400
      cashExercise(PUT, 190),
    ]);
    expect(realizedOf(ledger)).toBe(1_400);
    expect(cashOf(ledger)).toBe(101_400);
  });

  it("refuses 'fold-into-underlying-basis' — there is no underlying lot to fold the premium into", () => {
    const error = caught(() =>
      ledgerOf([DEPOSIT, BUY_CALLS, cashExercise(CALL, 210, 'fold-into-underlying-basis')]),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect((error as Error).message).toContain('fold-into-underlying-basis');
    expect((error as Error).message).toContain("'realize'");
  });
});

// ---------------------------------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------------------------------

describe('derivative.assignment — a short call delivers held shares at the strike', () => {
  const assign = (premiumTreatment: 'realize' | 'fold-into-underlying-basis') =>
    envelope('as-1', at(2, 1), 'main', {
      eventType: 'derivative.assignment',
      instrumentId: CALL,
      quantity: 2,
      settlement: { kind: 'physical' },
      premiumTreatment,
    });

  it("'fold': proceeds 205 → realized (205 − 150) × 200 = 11,000; option lots gone with 0 realized; cash +40,000", () => {
    // 100,000 − 30,000 + 1,000 = 71,000 before the assignment.
    const ledger = ledgerOf([
      DEPOSIT,
      BUY_SHARES,
      SELL_CALLS,
      assign('fold-into-underlying-basis'),
    ]);
    const account = main(ledger);
    expect(account.positions[CALL]).toBeUndefined();
    expect(account.positions['AAPL']).toBeUndefined();
    expect(realizedFor(ledger, 'AAPL')).toBe(11_000);
    expect(realizedFor(ledger, CALL)).toBeUndefined();
    expect(realizedOf(ledger)).toBe(11_000);
    expect(cashOf(ledger)).toBe(111_000);
  });

  it("'realize': the option keeps its premium (+1,000) and the shares sell at 200 (+10,000)", () => {
    const ledger = ledgerOf([DEPOSIT, BUY_SHARES, SELL_CALLS, assign('realize')]);
    // Short lot covered at 0: (5 − 0) × 2 × 100 = +1,000. Shares: (200 − 150) × 200 = 10,000.
    expect(realizedFor(ledger, CALL)).toBe(1_000);
    expect(realizedFor(ledger, 'AAPL')).toBe(10_000);
    expect(realizedOf(ledger)).toBe(11_000);
    expect(cashOf(ledger)).toBe(111_000);
  });

  it('with no shares held, a short share lot opens at the strike (naked call assigned)', () => {
    const ledger = ledgerOf([DEPOSIT, SELL_CALLS, assign('realize')]);
    const account = main(ledger);
    expect(realizedFor(ledger, CALL)).toBe(1_000);
    expect(account.positions['AAPL']!.quantity).toBe(-200);
    expect(account.positions['AAPL']!.lots[0]!.costBasisPerUnit).toBe(200);
    // 101,000 + 40,000.
    expect(cashOf(ledger)).toBe(141_000);
  });
});

describe('derivative.assignment — a short put takes delivery at the strike', () => {
  const SELL_PUTS = optionFill('put-1', at(1, 10), PUT, 'sell', 2, 5, AAPL_200P); // 101,000
  const assign = (
    settlement: { kind: 'physical' } | { kind: 'cash'; settlementPricePerUnit: number },
    premiumTreatment: 'realize' | 'fold-into-underlying-basis',
  ) =>
    envelope('as-1', at(2, 1), 'main', {
      eventType: 'derivative.assignment',
      instrumentId: PUT,
      quantity: 2,
      settlement,
      premiumTreatment,
    });

  it("'fold': 200 shares at basis 200 − 5 = 195; cash −40,000; nothing realized", () => {
    const ledger = ledgerOf([
      DEPOSIT,
      SELL_PUTS,
      assign({ kind: 'physical' }, 'fold-into-underlying-basis'),
    ]);
    const account = main(ledger);
    expect(account.positions[PUT]).toBeUndefined();
    const shares = account.positions['AAPL']!;
    expect(shares.quantity).toBe(200);
    expect(shares.lots[0]!.costBasisPerUnit).toBe(195);
    // Net outlay 40,000 − 1,000 = 39,000 = 200 × 195.
    expect(shares.lots[0]!.quantity * shares.lots[0]!.costBasisPerUnit).toBe(39_000);
    expect(realizedOf(ledger)).toBeUndefined();
    expect(cashOf(ledger)).toBe(61_000);
  });

  it("'realize': basis 200 and the option keeps its premium", () => {
    const ledger = ledgerOf([DEPOSIT, SELL_PUTS, assign({ kind: 'physical' }, 'realize')]);
    expect(main(ledger).positions['AAPL']!.lots[0]!.costBasisPerUnit).toBe(200);
    expect(realizedFor(ledger, PUT)).toBe(1_000);
    expect(cashOf(ledger)).toBe(61_000);
  });

  it('cash-settled at S = 190 (I = 10): the writer pays 2,000 and realizes (5 − 10) × 2 × 100 = −1,000', () => {
    const ledger = ledgerOf([
      DEPOSIT,
      SELL_PUTS,
      assign({ kind: 'cash', settlementPricePerUnit: 190 }, 'realize'),
    ]);
    expect(realizedOf(ledger)).toBe(-1_000);
    expect(cashOf(ledger)).toBe(99_000);
    expect(main(ledger).positions['AAPL']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------
// Expiration
// ---------------------------------------------------------------------------------------------------

describe('derivative.expiration — contracts are relieved at zero and no cash moves', () => {
  const expire = (quantity: number) =>
    envelope('exp-1', at(3, 20, 21), 'main', {
      eventType: 'derivative.expiration',
      instrumentId: CALL,
      quantity,
    });

  it('a long expires at a loss of its premium: −1,000', () => {
    const ledger = ledgerOf([DEPOSIT, BUY_CALLS, expire(2)]);
    expect(realizedOf(ledger)).toBe(-1_000);
    expect(cashOf(ledger)).toBe(99_000);
    expect(main(ledger).positions[CALL]).toBeUndefined();
  });

  it('a short keeps its premium: +1,000', () => {
    const ledger = ledgerOf([DEPOSIT, SELL_CALLS, expire(2)]);
    expect(realizedOf(ledger)).toBe(1_000);
    expect(cashOf(ledger)).toBe(101_000);
    expect(main(ledger).positions[CALL]).toBeUndefined();
  });

  it('a partial expiration leaves the rest of the lot', () => {
    const ledger = ledgerOf([DEPOSIT, BUY_CALLS, expire(1)]);
    expect(realizedOf(ledger)).toBe(-500);
    const option = main(ledger).positions[CALL]!;
    expect(option.quantity).toBe(1);
    expect(option.lots).toEqual([expect.objectContaining({ lotId: 'lot-1', quantity: 1 })]);
  });
});

describe('dated derivative chronology — expiry is an inclusive economic boundary', () => {
  const exerciseAt = (timestampMs: number) =>
    envelope('ex-time', timestampMs, 'main', {
      eventType: 'derivative.exercise',
      instrumentId: CALL,
      quantity: 2,
      settlement: { kind: 'physical' },
      premiumTreatment: 'realize',
    });

  it('allows exercise and expiration exactly at expiry', () => {
    expect(() =>
      ledgerOf([DEPOSIT, BUY_CALLS, exerciseAt(AAPL_200C.expiryTimestampMs)]),
    ).not.toThrow();
    expect(() =>
      ledgerOf([
        DEPOSIT,
        BUY_CALLS,
        envelope('exp-time', AAPL_200C.expiryTimestampMs, 'main', {
          eventType: 'derivative.expiration',
          instrumentId: CALL,
          quantity: 2,
        }),
      ]),
    ).not.toThrow();
  });

  it('refuses exercise after expiry and expiration before expiry', () => {
    const lateExercise = caught(() =>
      ledgerOf([DEPOSIT, BUY_CALLS, exerciseAt(AAPL_200C.expiryTimestampMs + 1)]),
    );
    expect(isQuantError(lateExercise, 'input.out_of_range')).toBe(true);
    expect((lateExercise as Error).message).toContain('after event.instrumentId expired');

    const earlyExpiration = caught(() =>
      ledgerOf([
        DEPOSIT,
        BUY_CALLS,
        envelope('exp-early', AAPL_200C.expiryTimestampMs - 1, 'main', {
          eventType: 'derivative.expiration',
          instrumentId: CALL,
          quantity: 2,
        }),
      ]),
    );
    expect(isQuantError(earlyExpiration, 'input.out_of_range')).toBe(true);
    expect((earlyExpiration as Error).message).toContain('before');
    expect((earlyExpiration as Error).message).toContain('expires');
  });

  it('refuses post-expiry adjustments, variation margin, and source rolls', () => {
    const late = AAPL_200C.expiryTimestampMs + 1;
    const multiplier = caught(() =>
      ledgerOf([
        DEPOSIT,
        BUY_CALLS,
        envelope('mult-late', late, 'main', {
          eventType: 'derivative.multiplier-change',
          instrumentId: CALL,
          contractMultiplierAfter: 200,
        }),
      ]),
    );
    expect(isQuantError(multiplier, 'input.out_of_range')).toBe(true);

    const futureOpen = marginFill('fut-time', at(1, 12), ESH6, 'buy', 1, 4_500, 50, ES_MAR);
    const futureLate = ES_MAR.expiryTimestampMs + 1;
    const margin = caught(() =>
      ledgerOf([DEPOSIT, futureOpen, variationMargin('vm-late', futureLate, ESH6, 4_510)]),
    );
    expect(isQuantError(margin, 'input.out_of_range')).toBe(true);
    const roll = caught(() =>
      ledgerOf([
        DEPOSIT,
        futureOpen,
        envelope('roll-late', futureLate, 'main', {
          eventType: 'derivative.roll',
          fromInstrumentId: ESH6,
          toInstrumentId: ESM6,
          quantity: 1,
          closePricePerUnit: 4_510,
          openPricePerUnit: 4_520,
          contract: ES_JUN,
        }),
      ]),
    );
    expect(isQuantError(roll, 'input.out_of_range')).toBe(true);
    expect((roll as Error).message).toContain('event.fromInstrumentId expired');
  });
});

// ---------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------

describe('option lifecycle refusals — every impossible settlement teaches', () => {
  const exercise = (
    instrumentId: string,
    quantity = 2,
    lotSelections?: { lotId: string; quantity: number }[],
  ) =>
    envelope('ex-1', at(2, 1), 'main', {
      eventType: 'derivative.exercise',
      instrumentId,
      quantity,
      settlement: { kind: 'physical' },
      premiumTreatment: 'fold-into-underlying-basis',
      ...(lotSelections !== undefined ? { lotSelections } : {}),
    });

  it('exercising a short position points at derivative.assignment', () => {
    const error = caught(() => ledgerOf([DEPOSIT, SELL_CALLS, exercise(CALL)]));
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect((error as Error).message).toContain('short position of 2');
    expect((error as Error).message).toContain('derivative.assignment');
  });

  it('assigning a long position points at derivative.exercise', () => {
    const error = caught(() =>
      ledgerOf([
        DEPOSIT,
        BUY_CALLS,
        envelope('as-1', at(2, 1), 'main', {
          eventType: 'derivative.assignment',
          instrumentId: CALL,
          quantity: 2,
          settlement: { kind: 'physical' },
          premiumTreatment: 'realize',
        }),
      ]),
    );
    expect(isQuantError(error, 'input.out_of_range')).toBe(true);
    expect((error as Error).message).toContain('long position of 2');
    expect((error as Error).message).toContain('derivative.exercise');
  });

  it('a non-option refuses, naming what is held: shares, then a future', () => {
    const shares = caught(() => ledgerOf([DEPOSIT, BUY_SHARES, exercise('AAPL', 200)]));
    expect(isQuantError(shares, 'input.out_of_range')).toBe(true);
    expect((shares as Error).message).toContain('no derivative terms');
    const future = caught(() =>
      ledgerOf([
        DEPOSIT,
        marginFill('fut-1', at(1, 12), ESH6, 'buy', 1, 4_500, 50, ES_MAR),
        exercise(ESH6, 1),
      ]),
    );
    expect(isQuantError(future, 'input.out_of_range')).toBe(true);
    expect((future as Error).message).toContain('is a future on ES');
    expect((future as Error).message).toContain('derivative.variation-margin');
    const expiring = caught(() =>
      ledgerOf([
        DEPOSIT,
        BUY_SHARES,
        envelope('exp-1', at(2, 1), 'main', {
          eventType: 'derivative.expiration',
          instrumentId: 'AAPL',
          quantity: 200,
        }),
      ]),
    );
    expect(isQuantError(expiring, 'input.out_of_range')).toBe(true);
  });

  it('more contracts than held, and a position the account does not hold', () => {
    const over = caught(() => ledgerOf([DEPOSIT, BUY_CALLS, exercise(CALL, 3)]));
    expect(isQuantError(over, 'input.out_of_range')).toBe(true);
    expect((over as Error).message).toContain('holds 2');
    const missing = caught(() => ledgerOf([DEPOSIT, exercise(CALL)]));
    expect(isQuantError(missing, 'input.out_of_range')).toBe(true);
    expect((missing as Error).message).toContain('holds no open position');
  });

  it('under specific-lot, a delivery that would relieve held underlying lots the event cannot name refuses', () => {
    // AAPL is lot-1, the puts are lot-2; the delivery would relieve the AAPL lot unnamed.
    const error = caught(() =>
      ledgerOf(
        [
          DEPOSIT,
          BUY_SHARES,
          optionFill('put-1', at(1, 10), PUT, 'buy', 2, 3, AAPL_200P),
          exercise(PUT, 2, [{ lotId: 'lot-2', quantity: 2 }]),
        ],
        'specific-lot',
      ),
    );
    expect(isQuantError(error, 'input.missing_field')).toBe(true);
    expect((error as Error).message).toContain("'specific-lot'");
    expect((error as Error).message).toContain('relieves 200');
  });
});

// ---------------------------------------------------------------------------------------------------
// Futures: variation margin
// ---------------------------------------------------------------------------------------------------

describe('derivative.variation-margin — a future settles daily and re-bases to the settlement price', () => {
  // Open 2 ES @4,500 (multiplier 50, variation margin): NO cash at the fill.
  const OPEN = marginFill('fut-1', at(1, 12), ESH6, 'buy', 2, 4_500, 50, ES_MAR);

  it('books no cash at the open, then +2,000 at 4,520 and −3,000 at 4,490; a closing fill realizes the rest', () => {
    const opened = ledgerOf([DEPOSIT, OPEN]);
    expect(cashOf(opened)).toBe(100_000);
    expect(main(opened).cashBalances['USD']!.settlementSchedule).toEqual([]);
    expect(main(opened).positions[ESH6]!.lots[0]!.costBasisPerUnit).toBe(4_500);

    // (4,520 − 4,500) × 2 × 50 = 2,000.
    const first = opened.apply([variationMargin('vm-1', at(1, 13), ESH6, 4_520)]);
    expect(cashOf(first)).toBe(102_000);
    expect(realizedOf(first)).toBe(2_000);
    expect(realizedFor(first, ESH6)).toBe(2_000);
    expect(main(first).positions[ESH6]!.lots[0]!.costBasisPerUnit).toBe(4_520);
    expect(main(first).positions[ESH6]!.quantity).toBe(2);

    // (4,490 − 4,520) × 2 × 50 = −3,000 → realized 2,000 − 3,000 = −1,000.
    const second = first.apply([variationMargin('vm-2', at(1, 14), ESH6, 4_490)]);
    expect(cashOf(second)).toBe(99_000);
    expect(realizedOf(second)).toBe(-1_000);
    expect(main(second).positions[ESH6]!.lots[0]!.costBasisPerUnit).toBe(4_490);

    // Sell 2 @4,500 through the fill reducer: (4,500 − 4,490) × 2 × 50 = +1,000 realized AND
    // booked as cash (variation-margin close) → cash 100,000, total realized 0.
    const closed = second.apply([
      marginFill('fut-2', at(1, 15), ESH6, 'sell', 2, 4_500, 50, ES_MAR),
    ]);
    expect(cashOf(closed)).toBe(100_000);
    expect(realizedOf(closed)).toBe(0);
    expect(realizedFor(closed, ESH6)).toBe(0);
    expect(main(closed).positions[ESH6]).toBeUndefined();
  });

  it('is deterministic: a second settlement at the same price realizes 0', () => {
    const ledger = ledgerOf([
      DEPOSIT,
      OPEN,
      variationMargin('vm-1', at(1, 13), ESH6, 4_520),
      variationMargin('vm-2', at(1, 14), ESH6, 4_520),
    ]);
    expect(realizedOf(ledger)).toBe(2_000);
    expect(cashOf(ledger)).toBe(102_000);
  });

  it('a short lot gains when the price falls: sell 1 @4,500, settle 4,480 → +1,000', () => {
    const ledger = ledgerOf([
      DEPOSIT,
      marginFill('fut-1', at(1, 12), ESH6, 'sell', 1, 4_500, 50, ES_MAR),
      variationMargin('vm-1', at(1, 13), ESH6, 4_480),
    ]);
    // (4,480 − 4,500) × (−1) × 50 = +1,000.
    expect(realizedOf(ledger)).toBe(1_000);
    expect(cashOf(ledger)).toBe(101_000);
    expect(main(ledger).positions[ESH6]!.lots[0]).toMatchObject({
      quantity: -1,
      costBasisPerUnit: 4_480,
    });
  });

  it('conserves NAV across a settlement at the same mark (portfolioSnapshot)', () => {
    const before = ledgerOf([DEPOSIT, OPEN]);
    const after = before.apply([variationMargin('vm-1', at(1, 13), ESH6, 4_520)]);
    const market = createMarketSnapshot({
      asOf: at(1, 20),
      observations: { spots: { [ESH6]: { price: 4_530, currency: 'USD' } } },
    });
    const valuedBefore = portfolioSnapshot({ portfolio: before.state, asOf: at(1, 20), market });
    const valuedAfter = portfolioSnapshot({ portfolio: after.state, asOf: at(1, 20), market });
    // Before: cash 100,000 + unsettled (4,530 − 4,500) × 2 × 50 = 3,000 → 103,000.
    // After:  cash 102,000 + unsettled (4,530 − 4,520) × 2 × 50 = 1,000 → 103,000.
    expect(valuedBefore.netAssetValue).toBe(103_000);
    expect(valuedAfter.netAssetValue).toBe(103_000);
    expect(valuedBefore.positions[0]).toMatchObject({
      instrumentId: ESH6,
      marketValue: 3_000,
      notionalValue: 453_000,
      costBasis: 0,
      settlementStyle: 'variation-margin',
    });
    expect(valuedAfter.positions[0]!.marketValue).toBe(1_000);
    expect(valuedAfter.positions[0]!.notionalValue).toBe(453_000);
  });

  it('refuses a cash-on-trade position (it marks through portfolioSnapshot) and an unheld one', () => {
    const shares = caught(() =>
      ledgerOf([DEPOSIT, BUY_SHARES, variationMargin('vm-1', at(1, 13), 'AAPL', 160)]),
    );
    expect(isQuantError(shares, 'input.out_of_range')).toBe(true);
    expect((shares as Error).message).toContain("'cash-on-trade'");
    expect((shares as Error).message).toContain('portfolioSnapshot');
    const missing = caught(() =>
      ledgerOf([DEPOSIT, variationMargin('vm-1', at(1, 13), ESH6, 4_520)]),
    );
    expect(isQuantError(missing, 'input.out_of_range')).toBe(true);
    expect((missing as Error).message).toContain('holds no open position');
  });
});

// ---------------------------------------------------------------------------------------------------
// Rolls
// ---------------------------------------------------------------------------------------------------

describe('derivative.roll — close the contract, open its successor, one provenance', () => {
  const OPEN = marginFill('fut-1', at(1, 12), ESH6, 'buy', 2, 4_500, 50, ES_MAR);
  const VM = variationMargin('vm-1', at(1, 13), ESH6, 4_520); // cash 102,000, realized 2,000
  const roll = (
    quantity: number,
    contract: DerivativeContractTerms | undefined,
    from = ESH6,
    to = ESM6,
    closePricePerUnit = 4_510,
    openPricePerUnit = 4_530,
  ) =>
    envelope('roll-1', at(2, 5), 'main', {
      eventType: 'derivative.roll',
      fromInstrumentId: from,
      toInstrumentId: to,
      quantity,
      closePricePerUnit,
      openPricePerUnit,
      ...(contract !== undefined ? { contract } : {}),
    });

  it('a variation-margin roll realizes the close against the re-based lots and opens the successor with no cash', () => {
    const ledger = ledgerOf([DEPOSIT, OPEN, VM, roll(2, ES_JUN)]);
    const account = main(ledger);
    // Close 2 @4,510 against basis 4,520: (4,510 − 4,520) × 2 × 50 = −1,000 → realized 1,000.
    expect(realizedFor(ledger, ESH6)).toBe(1_000);
    expect(realizedFor(ledger, ESM6)).toBeUndefined();
    expect(realizedOf(ledger)).toBe(1_000);
    // Cash: 102,000 − 1,000 (the realized close) + 0 (the open) = 101,000.
    expect(cashOf(ledger)).toBe(101_000);
    expect(account.positions[ESH6]).toBeUndefined();
    const successor = account.positions[ESM6]!;
    expect(successor.quantity).toBe(2);
    expect(successor.lots).toEqual([
      expect.objectContaining({ quantity: 2, costBasisPerUnit: 4_530, openedByEventId: 'roll-1' }),
    ]);
    expect(successor.contractMultiplier).toBe(50);
    expect(successor.settlementStyle).toBe('variation-margin');
    expect(successor.contract).toEqual(ES_JUN);
    expect(successor.currency).toBe('USD');
  });

  it('a partial roll leaves the rest of the from-contract; a short rolls short', () => {
    const partial = ledgerOf([DEPOSIT, OPEN, roll(1, ES_JUN)]);
    expect(main(partial).positions[ESH6]!.quantity).toBe(1);
    expect(main(partial).positions[ESM6]!.quantity).toBe(1);
    // Short 1 @4,500; roll close 4,480 open 4,500: (4,500 − 4,480) × 1 × 50 = +1,000.
    const short = ledgerOf([
      DEPOSIT,
      marginFill('fut-1', at(1, 12), ESH6, 'sell', 1, 4_500, 50, ES_MAR),
      roll(1, ES_JUN, ESH6, ESM6, 4_480, 4_500),
    ]);
    expect(realizedOf(short)).toBe(1_000);
    expect(cashOf(short)).toBe(101_000);
    expect(main(short).positions[ESM6]!.lots[0]).toMatchObject({
      quantity: -1,
      costBasisPerUnit: 4_500,
    });
  });

  it('a cash-on-trade roll books proceeds at the close and cost at the open (options)', () => {
    // 99,000 after the buy; close 2 @6 → +1,200 and realized (6 − 5) × 2 × 100 = 200; open 2 @4 → −800.
    const ledger = ledgerOf([DEPOSIT, BUY_CALLS, roll(2, AAPL_210C, CALL, CALL_210, 6, 4)]);
    expect(realizedFor(ledger, CALL)).toBe(200);
    expect(cashOf(ledger)).toBe(99_400);
    const successor = main(ledger).positions[CALL_210]!;
    expect(successor.quantity).toBe(2);
    expect(successor.lots[0]!.costBasisPerUnit).toBe(4);
    expect(successor.contractMultiplier).toBe(100);
    expect(successor.settlementStyle).toBe('cash-on-trade');
    expect(successor.contract).toEqual(AAPL_210C);
  });

  it('a perpetual carries its terms over (no expiry to differ)', () => {
    const ledger = ledgerOf([
      DEPOSIT,
      marginFill('perp-1', at(1, 12), 'BTC-PERP-A', 'buy', 0.5, 60_000, 1, BTC_PERP),
      roll(0.5, undefined, 'BTC-PERP-A', 'BTC-PERP-B', 60_100, 60_100),
    ]);
    // (60,100 − 60,000) × 0.5 = 50.
    expect(realizedOf(ledger)).toBe(50);
    expect(cashOf(ledger)).toBe(100_050);
    expect(main(ledger).positions['BTC-PERP-B']!.contract).toEqual(BTC_PERP);
  });

  it('refuses missing terms, kind/underlying/type changes, and more than is held', () => {
    const untermed = caught(() => ledgerOf([DEPOSIT, OPEN, roll(2, undefined)]));
    expect(isQuantError(untermed, 'input.missing_field')).toBe(true);
    expect((untermed as Error).message).toContain('its own expiry');
    const kind = caught(() => ledgerOf([DEPOSIT, OPEN, roll(2, AAPL_210C)]));
    expect(isQuantError(kind, 'input.out_of_range')).toBe(true);
    expect((kind as Error).message).toContain('SAME kind');
    const underlying = caught(() =>
      ledgerOf([DEPOSIT, OPEN, roll(2, { ...ES_JUN, underlyingInstrumentId: 'CL' })]),
    );
    expect(isQuantError(underlying, 'input.out_of_range')).toBe(true);
    expect((underlying as Error).message).toContain('changes the underlying');
    const right = caught(() =>
      ledgerOf([DEPOSIT, BUY_CALLS, roll(2, { ...AAPL_210C, type: 'put' }, CALL, CALL_210, 6, 4)]),
    );
    expect(isQuantError(right, 'input.out_of_range')).toBe(true);
    expect((right as Error).message).toContain('changes the option type');
    const over = caught(() => ledgerOf([DEPOSIT, OPEN, roll(3, ES_JUN)]));
    expect(isQuantError(over, 'input.out_of_range')).toBe(true);
    expect((over as Error).message).toContain('holds 2');
  });
});

// ---------------------------------------------------------------------------------------------------
// Multiplier change
// ---------------------------------------------------------------------------------------------------

describe('derivative.multiplier-change — total basis is preserved exactly', () => {
  const change = (contractMultiplierAfter: number, instrumentId = CALL) =>
    envelope('mult-1', at(2, 1), 'main', {
      eventType: 'derivative.multiplier-change',
      instrumentId,
      contractMultiplierAfter,
      reason: 'contract adjustment',
    });

  it('100 → 200 halves the per-unit basis: Σ q × basis × m stays 1,000 (toBe)', () => {
    const before = ledgerOf([DEPOSIT, BUY_CALLS]);
    const total = (ledger: PortfolioLedger) => {
      const position = main(ledger).positions[CALL]!;
      return position.lots.reduce(
        (sum, lot) => sum + lot.quantity * lot.costBasisPerUnit * position.contractMultiplier,
        0,
      );
    };
    expect(total(before)).toBe(1_000);
    const after = before.apply([change(200)]);
    const position = main(after).positions[CALL]!;
    expect(position.contractMultiplier).toBe(200);
    expect(position.lots[0]!.costBasisPerUnit).toBe(2.5);
    expect(position.quantity).toBe(2);
    expect(total(after)).toBe(1_000);
    // A later sale states the new multiplier: (3 − 2.5) × 2 × 200 = 200 realized, +1,200 cash.
    const sold = after.apply([optionFill('opt-2', at(2, 2), CALL, 'sell', 2, 3, AAPL_200C, 200)]);
    expect(realizedOf(sold)).toBe(200);
    expect(cashOf(sold)).toBe(100_200);
  });

  it('an odd ratio (100 → 150) preserves the total within floating point', () => {
    const ledger = ledgerOf([DEPOSIT, BUY_CALLS, change(150)]);
    const position = main(ledger).positions[CALL]!;
    expect(position.lots[0]!.costBasisPerUnit).toBeCloseTo(10 / 3, 12);
    expect(position.lots[0]!.quantity * position.lots[0]!.costBasisPerUnit * 150).toBeCloseTo(
      1_000,
      9,
    );
  });

  it('refuses an unchanged multiplier and an unheld instrument', () => {
    const same = caught(() => ledgerOf([DEPOSIT, BUY_CALLS, change(100)]));
    expect(isQuantError(same, 'input.out_of_range')).toBe(true);
    expect((same as Error).message).toContain('already carries');
    const missing = caught(() => ledgerOf([DEPOSIT, change(200, PUT)]));
    expect(isQuantError(missing, 'input.out_of_range')).toBe(true);
    expect((missing as Error).message).toContain('holds no open position');
  });
});

// ---------------------------------------------------------------------------------------------------
// A crypto perpetual journey through the existing families
// ---------------------------------------------------------------------------------------------------

describe('BTC-PERP journey — variation margin, funding paid and received, close', () => {
  const ledger = ledgerOf([
    DEPOSIT,
    // Long 0.5 @60,000 (multiplier 1, variation margin): no cash.
    marginFill('perp-1', at(1, 12), PERP, 'buy', 0.5, 60_000, 1, BTC_PERP),
    // (61,000 − 60,000) × 0.5 = +500 → cash 100,500; basis 61,000.
    variationMargin('vm-1', at(1, 13), PERP, 61_000),
    envelope('fund-1', at(1, 13, 16), 'main', {
      eventType: 'financing.charge',
      financingType: 'funding-payment',
      amount: 12,
      currency: 'USD',
      instrumentId: PERP,
    }), // 100,488
    envelope('fund-2', at(1, 14), 'main', {
      eventType: 'income.received',
      incomeType: 'funding-receipt',
      amount: 8,
      currency: 'USD',
      instrumentId: PERP,
    }), // 100,496
    // Close @60,500 against basis 61,000: (60,500 − 61,000) × 0.5 = −250 → cash 100,246.
    marginFill('perp-2', at(1, 15), PERP, 'sell', 0.5, 60_500, 1, BTC_PERP),
  ]);

  it('ends with cash 100,246, realized 250, income 8, financing 12, and no position', () => {
    const account = main(ledger);
    expect(cashOf(ledger)).toBe(100_246);
    expect(realizedOf(ledger)).toBe(250);
    expect(realizedFor(ledger, PERP)).toBe(250);
    expect(account.incomeReceived['USD']).toBe(8);
    expect(account.incomeByInstrument[PERP]!['USD']).toBe(8);
    expect(account.financingCosts['USD']).toBe(12);
    expect(account.positions[PERP]).toBeUndefined();
    // The cash identity: 100,000 + 250 + 8 − 12 = 100,246.
    expect(100_000 + 250 + 8 - 12).toBe(cashOf(ledger));
  });
});

// ---------------------------------------------------------------------------------------------------
// Replay determinism and the serialized round trip with the new families
// ---------------------------------------------------------------------------------------------------

/** One journey through every derivative family (hand-computed cash 111,400, realized 12,200). */
const JOURNEY: PortfolioEventEnvelope[] = [
  DEPOSIT, // 100,000
  BUY_SHARES, // 70,000
  SELL_CALLS, // 71,000 (short 2 calls @5)
  optionFill('put-1', at(1, 10, 16), PUT, 'buy', 1, 3, AAPL_200P), // 70,700
  marginFill('fut-1', at(1, 12), ESH6, 'buy', 2, 4_500, 50, ES_MAR), // no cash
  variationMargin('vm-1', at(1, 13), ESH6, 4_520), // +2,000 → 72,700; realized 2,000
  envelope('as-1', at(2, 1), 'main', {
    eventType: 'derivative.assignment',
    instrumentId: CALL,
    quantity: 2,
    settlement: { kind: 'physical' },
    premiumTreatment: 'fold-into-underlying-basis',
  }), // +40,000 → 112,700; realized (205 − 150) × 200 = 11,000
  envelope('roll-1', at(2, 5), 'main', {
    eventType: 'derivative.roll',
    fromInstrumentId: ESH6,
    toInstrumentId: ESM6,
    quantity: 2,
    closePricePerUnit: 4_510,
    openPricePerUnit: 4_530,
    contract: ES_JUN,
  }), // −1,000 → 111,700; realized −1,000
  marginFill('perp-1', at(2, 6), PERP, 'buy', 0.5, 60_000, 1, BTC_PERP), // no cash
  variationMargin('vm-2', at(2, 7), PERP, 61_000), // +500 → 112,200; realized +500
  optionFill('opt-2', at(2, 8), CALL_210, 'buy', 2, 4, AAPL_210C), // −800 → 111,400
  envelope('mult-1', at(2, 9), 'main', {
    eventType: 'derivative.multiplier-change',
    instrumentId: CALL_210,
    contractMultiplierAfter: 200,
  }),
  envelope('exp-1', AAPL_200P.expiryTimestampMs, 'main', {
    eventType: 'derivative.expiration',
    instrumentId: PUT,
    quantity: 1,
  }), // realized −300
];

describe('the replay law holds for the derivative families', () => {
  it('folds the journey to the hand-computed totals', () => {
    const ledger = ledgerOf(JOURNEY);
    expect(cashOf(ledger)).toBe(111_400);
    // 2,000 + 11,000 − 300 − 1,000 + 500 = 12,200.
    expect(realizedOf(ledger)).toBe(12_200);
    expect(Object.keys(main(ledger).positions).sort()).toEqual([CALL_210, PERP, ESM6].sort());
    expect(main(ledger).positions[CALL_210]!.contractMultiplier).toBe(200);
  });

  it('same events → deep-equal state, one-shot or incremental', () => {
    const oneShot = applyPortfolioEvents({ portfolio: { baseCurrency: 'USD' }, events: JOURNEY });
    expect(applyPortfolioEvents({ portfolio: { baseCurrency: 'USD' }, events: JOURNEY })).toEqual(
      oneShot,
    );
    let incremental = applyPortfolioEvents({
      portfolio: { baseCurrency: 'USD' },
      events: JOURNEY.slice(0, 6),
    });
    incremental = applyPortfolioEvents({ previousState: incremental, events: JOURNEY.slice(6, 9) });
    incremental = applyPortfolioEvents({ previousState: incremental, events: JOURNEY.slice(9) });
    expect(incremental).toEqual(oneShot);
    // An identical replay is a no-op.
    expect(applyPortfolioEvents({ previousState: oneShot, events: JOURNEY })).toEqual(oneShot);
  });

  it('serializes and restores by replay with an identical content hash', () => {
    const ledger = ledgerOf(JOURNEY);
    const restored = readPortfolioLedgerSnapshot({
      snapshot: JSON.parse(JSON.stringify(ledger)) as unknown,
    });
    expect(restored.ledger.state).toEqual(ledger.state);
    expect(restored.migrationsApplied).toEqual([]);
    expect(portfolioLedgerContentHash(restored.ledger.toJSON())).toBe(
      portfolioLedgerContentHash(ledger.toJSON()),
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// Reversal refusals
// ---------------------------------------------------------------------------------------------------

describe('admin.reversal — every derivative family refuses with the family and the correcting event', () => {
  const cases: { name: string; events: PortfolioEventEnvelope[]; teaching: string }[] = [
    {
      name: 'derivative.exercise',
      events: [
        DEPOSIT,
        BUY_CALLS,
        envelope('ex-1', at(2, 1), 'main', {
          eventType: 'derivative.exercise',
          instrumentId: CALL,
          quantity: 2,
          settlement: { kind: 'physical' },
          premiumTreatment: 'realize',
        }),
      ],
      teaching: 'delivered the underlying',
    },
    {
      name: 'derivative.assignment',
      events: [
        DEPOSIT,
        SELL_CALLS,
        envelope('as-1', at(2, 1), 'main', {
          eventType: 'derivative.assignment',
          instrumentId: CALL,
          quantity: 2,
          settlement: { kind: 'cash', settlementPricePerUnit: 210 },
          premiumTreatment: 'realize',
        }),
      ],
      teaching: 'settled their intrinsic value in cash',
    },
    {
      name: 'derivative.expiration',
      events: [
        DEPOSIT,
        BUY_CALLS,
        envelope('exp-1', AAPL_200C.expiryTimestampMs, 'main', {
          eventType: 'derivative.expiration',
          instrumentId: CALL,
          quantity: 2,
        }),
      ],
      teaching: 'relieved 2',
    },
    {
      name: 'derivative.multiplier-change',
      events: [
        DEPOSIT,
        BUY_CALLS,
        envelope('mult-1', at(2, 1), 'main', {
          eventType: 'derivative.multiplier-change',
          instrumentId: CALL,
          contractMultiplierAfter: 200,
        }),
      ],
      teaching: 'back to the prior multiplier',
    },
    {
      name: 'derivative.variation-margin',
      events: [
        DEPOSIT,
        marginFill('fut-1', at(1, 12), ESH6, 'buy', 2, 4_500, 50, ES_MAR),
        variationMargin('vm-1', at(1, 13), ESH6, 4_520),
      ],
      teaching: 're-based every',
    },
    {
      name: 'derivative.roll',
      events: [
        DEPOSIT,
        marginFill('fut-1', at(1, 12), ESH6, 'buy', 2, 4_500, 50, ES_MAR),
        envelope('roll-1', at(2, 5), 'main', {
          eventType: 'derivative.roll',
          fromInstrumentId: ESH6,
          toInstrumentId: ESM6,
          quantity: 2,
          closePricePerUnit: 4_510,
          openPricePerUnit: 4_530,
          contract: ES_JUN,
        }),
      ],
      teaching: 'opened ESM6',
    },
  ];

  for (const { name, events, teaching } of cases) {
    it(`${name} is infeasible, and the state is untouched`, () => {
      const ledger = ledgerOf(events);
      const original = events[events.length - 1]!;
      const before = JSON.stringify(ledger.state);
      const error = caught(() => ledger.apply([reversal('rev-1', at(7, 1), original)]));
      expect(isQuantError(error, 'portfolio.reversal_infeasible')).toBe(true);
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).toContain(teaching);
      expect((error as Error).message).toContain('record the correcting economic event');
      expect(JSON.stringify(ledger.state)).toBe(before);
    });
  }

  it('a correction of a derivative fact is refused the same way (it reverses first)', () => {
    const exercise = envelope('ex-1', at(2, 1), 'main', {
      eventType: 'derivative.exercise',
      instrumentId: CALL,
      quantity: 2,
      settlement: { kind: 'physical' },
      premiumTreatment: 'realize',
    });
    const ledger = ledgerOf([DEPOSIT, BUY_CALLS, exercise]);
    const correction = envelope(
      'corr-1',
      at(2, 2),
      'main',
      {
        eventType: 'admin.correction',
        original: exercise,
        replacement: { ...exercise.event, premiumTreatment: 'fold-into-underlying-basis' } as never,
      },
      { reversesEventId: 'ex-1' },
    );
    const error = caught(() => ledger.apply([correction]));
    expect(isQuantError(error, 'portfolio.reversal_infeasible')).toBe(true);
    expect((error as Error).message).toContain('derivative.exercise');
  });
});
