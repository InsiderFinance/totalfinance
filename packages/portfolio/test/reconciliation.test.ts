/**
 * FC7 slice 3 — the administration family (exact reversal, correction, migration marker) and
 * `reconcilePortfolio`. Every number is hand-computed; history is never rewritten, only linked.
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  PORTFOLIO_STATE_SCHEMA_VERSION,
  createPortfolioLedger,
  portfolioSnapshot,
  readPortfolioLedgerSnapshot,
  reconcilePortfolio,
  type ExternalPortfolioSnapshot,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
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

const DEPOSIT = envelope('dep-1', at(1, 2), 'main', {
  eventType: 'cash.deposit',
  amount: 100_000,
  currency: 'USD',
});
const BUY = envelope('fill-1', at(1, 10), 'main', {
  eventType: 'trade.fill',
  instrumentId: 'AAPL',
  side: 'buy',
  quantity: 100,
  pricePerUnit: 150,
  currency: 'USD',
  settleTimestampMs: at(1, 12),
});
const COMMISSION = envelope('cost-1', at(1, 10, 16), 'main', {
  eventType: 'cost.charge',
  costType: 'commission',
  amount: 10,
  currency: 'USD',
  instrumentId: 'AAPL',
});
const DIVIDEND = envelope('div-1', at(2, 10), 'main', {
  eventType: 'income.received',
  incomeType: 'dividend',
  amount: 50,
  currency: 'USD',
  instrumentId: 'AAPL',
});
const SELL = envelope('fill-2', at(2, 15), 'main', {
  eventType: 'trade.fill',
  instrumentId: 'AAPL',
  side: 'sell',
  quantity: 40,
  pricePerUnit: 170,
  currency: 'USD',
});

const reversal = (
  eventId: string,
  timestampMs: number,
  original: PortfolioEventEnvelope,
  overrides: Partial<PortfolioEventEnvelope> = {},
): PortfolioEventEnvelope =>
  envelope(
    eventId,
    timestampMs,
    original.accountId,
    { eventType: 'admin.reversal', original },
    {
      reversesEventId: original.eventId,
      ...overrides,
    },
  );

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('admin.reversal — an applied fact is reversed EXACTLY, and the link is recorded', () => {
  it('reverses a buy while its lots are intact: cash back, lots gone, effect record removed, link kept', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY] });
    const before = ledger.state;
    expect(before.accounts['main']!.positions['AAPL']!.quantity).toBe(100);
    expect(before.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(85_000);
    expect(before.accounts['main']!.cashBalances['USD']!.settlementSchedule).toHaveLength(1);

    const reversed = ledger.apply([reversal('rev-1', at(1, 20), BUY)]);
    const main = reversed.state.accounts['main']!;
    expect(main.positions['AAPL']).toBeUndefined();
    expect(main.cashBalances['USD']!.totalAmount).toBe(100_000);
    expect(main.cashBalances['USD']!.settlementSchedule).toEqual([]);
    expect(Object.keys(reversed.state.fillEffects)).toEqual([]);
    expect(Object.values(reversed.state.reversals)).toHaveLength(1);
    // History is linked, not rewritten: the original stays in the registry beside the reversal.
    expect(Object.keys(reversed.state.appliedEvents)).toHaveLength(3);
    expect(reversed.events.map((e) => e.eventId)).toEqual(['dep-1', 'fill-1', 'rev-1']);
    expect(reversed.state.schemaVersion).toBe(PORTFOLIO_STATE_SCHEMA_VERSION);
  });

  it('reverses cash, cost, income, and financing facts exactly', () => {
    const financing = envelope('fin-1', at(2, 20), 'main', {
      eventType: 'financing.charge',
      financingType: 'margin-interest',
      amount: 14,
      currency: 'USD',
    });
    const ledger = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [DEPOSIT, BUY, COMMISSION, DIVIDEND, financing],
    });
    const main0 = ledger.state.accounts['main']!;
    expect(main0.cashBalances['USD']!.totalAmount).toBeCloseTo(100_000 - 15_000 - 10 + 50 - 14, 9);
    const reversed = ledger.apply([
      reversal('rev-cost', at(3, 1), COMMISSION),
      reversal('rev-div', at(3, 1, 16), DIVIDEND),
      reversal('rev-fin', at(3, 1, 17), financing),
    ]);
    const main = reversed.state.accounts['main']!;
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(85_000, 9);
    expect(main.transactionCosts['USD']).toBe(0);
    expect(main.transactionCostsByInstrument['AAPL']!['USD']).toBe(0);
    expect(main.incomeReceived['USD']).toBe(0);
    expect(main.incomeByInstrument['AAPL']!['USD']).toBe(0);
    expect(main.financingCosts['USD']).toBe(0);
    // The deposit itself reverses too — cash may go negative (margin), never a guess.
    const gone = reversed.apply([reversal('rev-dep', at(3, 2), DEPOSIT)]);
    expect(gone.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBeCloseTo(-15_000, 9);
  });

  it('removes exactly one dated leg when two sources reuse the same eventId', () => {
    const first = envelope(
      'shared-id',
      at(1, 2),
      'main',
      {
        eventType: 'cash.deposit',
        amount: 100,
        currency: 'USD',
        settleTimestampMs: at(1, 5),
      },
      { sourceId: 'source-a' },
    );
    const second = envelope(
      'shared-id',
      at(1, 3),
      'main',
      {
        eventType: 'cash.deposit',
        amount: 200,
        currency: 'USD',
        settleTimestampMs: at(1, 6),
      },
      { sourceId: 'source-b' },
    );
    const reversed = createPortfolioLedger({ baseCurrency: 'USD', events: [first, second] }).apply([
      reversal('reverse-source-a', at(1, 10), first),
    ]);
    const cash = reversed.state.accounts['main']!.cashBalances['USD']!;
    expect(cash.totalAmount).toBe(200);
    expect(cash.settlementSchedule).toEqual([
      { eventId: 'shared-id', amount: 200, settleTimestampMs: at(1, 6) },
    ]);
  });

  it('reverses a transfer and a conversion exactly, on both sides of each', () => {
    const transfer = envelope('xfer-1', at(1, 5), 'main', {
      eventType: 'cash.transfer',
      amount: 30_000,
      currency: 'USD',
      fromAccountId: 'main',
      toAccountId: 'ira',
    });
    const conversion = envelope('fx-1', at(1, 6), 'main', {
      eventType: 'cash.conversion',
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      fromAmount: 10_000,
      toAmount: 9_200,
    });
    const ledger = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [DEPOSIT, transfer, conversion],
    });
    expect(ledger.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(60_000);
    expect(ledger.state.accounts['main']!.cashBalances['EUR']!.totalAmount).toBe(9_200);
    expect(ledger.state.accounts['ira']!.cashBalances['USD']!.totalAmount).toBe(30_000);

    const reversed = ledger.apply([
      reversal('rev-fx', at(1, 7), conversion),
      reversal('rev-xfer', at(1, 8), transfer),
    ]);
    const main = reversed.state.accounts['main']!;
    expect(main.cashBalances['USD']!.totalAmount).toBe(100_000);
    expect(main.cashBalances['EUR']!.totalAmount).toBe(0);
    expect(reversed.state.accounts['ira']!.cashBalances['USD']!.totalAmount).toBe(0);
    expect(Object.keys(reversed.state.reversals).sort()).toEqual([
      '["test","fx-1"]',
      '["test","xfer-1"]',
    ]);
  });

  it('refuses when the fill relieved prior lots — relieved lots cannot be restored exactly', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY, SELL] });
    const error = caught(() => ledger.apply([reversal('rev-sell', at(3, 1), SELL)]));
    expect(isQuantError(error, 'portfolio.reversal_infeasible')).toBe(true);
    expect(String((error as Error).message)).toContain('relieved 40');
  });

  it('refuses when the lots the fill opened were partially relieved by later fills', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY, SELL] });
    const error = caught(() => ledger.apply([reversal('rev-buy', at(3, 1), BUY)]));
    expect(isQuantError(error, 'portfolio.reversal_infeasible')).toBe(true);
    expect(String((error as Error).message)).toContain('lot-1');
  });

  it('refuses a double reversal, a tampered original, and an unapplied target', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY] });
    const once = ledger.apply([reversal('rev-1', at(1, 20), BUY)]);
    // An identical replay of the same reversal is a no-op; a DIFFERENT reversal of the same fact is a conflict.
    expect(once.apply([reversal('rev-1', at(1, 20), BUY)]).state).toEqual(once.state);
    const twice = caught(() => once.apply([reversal('rev-2', at(1, 21), BUY)]));
    expect(isQuantError(twice, 'portfolio.reversal_infeasible')).toBe(true);
    expect(String((twice as Error).message)).toContain('already reversed');

    const tampered = {
      ...BUY,
      event: { ...BUY.event, pricePerUnit: 151 },
    } as PortfolioEventEnvelope;
    const mismatch = caught(() => ledger.apply([reversal('rev-x', at(1, 20), tampered)]));
    expect(isQuantError(mismatch, 'portfolio.reversal_infeasible')).toBe(true);
    expect(String((mismatch as Error).message)).toContain('hashes differently');

    const phantom = { ...BUY, eventId: 'fill-9' };
    const missing = caught(() => ledger.apply([reversal('rev-y', at(1, 20), phantom)]));
    expect(isQuantError(missing, 'portfolio.reversal_target_missing')).toBe(true);
  });

  it('refuses a split reversal in this build, with the counter-split teaching', () => {
    const split = envelope('split-1', at(1, 15), 'main', {
      eventType: 'corporate.split',
      instrumentId: 'AAPL',
      sharesAfterSplit: 2,
      sharesBeforeSplit: 1,
    });
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY, split] });
    const error = caught(() => ledger.apply([reversal('rev-split', at(1, 20), split)]));
    expect(isQuantError(error, 'portfolio.reversal_infeasible')).toBe(true);
    expect(String((error as Error).message)).toContain('counter-split');
  });

  it('serializes and replays the linked history deterministically', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY] }).apply([
      reversal('rev-1', at(1, 20), BUY),
    ]);
    const restored = readPortfolioLedgerSnapshot({ snapshot: ledger.toJSON() });
    expect(restored.ledger.state).toEqual(ledger.state);
    expect(restored.ledger.state.reversals).toEqual(ledger.state.reversals);
  });
});

describe('admin.correction — reverse and replace atomically, at the original instant', () => {
  const correction = envelope(
    'corr-1',
    at(1, 20),
    'main',
    {
      eventType: 'admin.correction',
      original: BUY,
      replacement: { ...BUY.event, pricePerUnit: 151 } as never,
      reason: 'broker confirm shows 151',
    },
    { reversesEventId: 'fill-1' },
  );

  it('the replacement lot carries the ORIGINAL timing and the correction identity', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY] }).apply([
      correction,
    ]);
    const main = ledger.state.accounts['main']!;
    expect(main.cashBalances['USD']!.totalAmount).toBeCloseTo(100_000 - 15_100, 9);
    const position = main.positions['AAPL']!;
    expect(position.quantity).toBe(100);
    expect(position.lots).toHaveLength(1);
    expect(position.lots[0]!.costBasisPerUnit).toBe(151);
    expect(position.lots[0]!.openedTimestampMs).toBe(BUY.effectiveTimestampMs);
    expect(position.lots[0]!.openedByEventId).toBe('corr-1');
    // The settlement leg is re-booked under the correction; the original's is gone.
    expect(main.cashBalances['USD']!.settlementSchedule.map((leg) => leg.eventId)).toEqual([
      'corr-1',
    ]);
    expect(Object.keys(ledger.state.fillEffects)).toHaveLength(1);
  });

  it('later relief sees the corrected basis, and the correction is itself reversible while intact', () => {
    const corrected = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY] }).apply([
      correction,
    ]);
    const sold = corrected.apply([SELL]);
    // 40 × (170 − 151) = 760, not 800.
    expect(sold.state.accounts['main']!.realizedPnl['USD']).toBeCloseTo(760, 9);

    // Reversing the correction undoes the replacement AND re-applies the original fact.
    const undone = corrected.apply([reversal('rev-corr', at(1, 25), correction)]);
    const position = undone.state.accounts['main']!.positions['AAPL']!;
    expect(position.quantity).toBe(100);
    expect(position.lots).toHaveLength(1);
    expect(position.lots[0]!.costBasisPerUnit).toBe(150);
    expect(undone.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(85_000);
    // The original is live again (no longer listed as reversed); the correction is.
    expect(Object.keys(undone.state.reversals)).toEqual(['["test","corr-1"]']);
  });

  it('corrects a cash fact: the replacement amount folds at the original instant', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY] });
    const corrected = ledger.apply([
      envelope(
        'corr-dep',
        at(1, 20),
        'main',
        {
          eventType: 'admin.correction',
          original: DEPOSIT,
          replacement: { eventType: 'cash.deposit', amount: 90_000, currency: 'USD' },
          reason: 'statement shows 90,000',
        },
        { reversesEventId: DEPOSIT.eventId },
      ),
    ]);
    const main = corrected.state.accounts['main']!;
    expect(main.cashBalances['USD']!.totalAmount).toBe(75_000);
    expect(main.positions['AAPL']!.quantity).toBe(100);
    expect(Object.keys(corrected.state.reversals)).toEqual(['["test","dep-1"]']);
  });

  it('refuses a correction after relief, exactly like a reversal', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY, SELL] });
    const late = { ...correction, effectiveTimestampMs: at(3, 1), recordedTimestampMs: at(3, 1) };
    expect(
      isQuantError(
        caught(() => ledger.apply([late])),
        'portfolio.reversal_infeasible',
      ),
    ).toBe(true);
  });
});

describe('the envelope grammar for repairs', () => {
  const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY] });

  it('only administration events carry reversesEventId, and repairs must carry it', () => {
    const linkedFill = envelope('fill-3', at(1, 20), 'main', BUY.event, {
      reversesEventId: 'fill-1',
    });
    expect(
      isQuantError(
        caught(() => ledger.apply([linkedFill])),
        'input.out_of_range',
      ),
    ).toBe(true);
    const unlinked = envelope('rev-u', at(1, 20), 'main', {
      eventType: 'admin.reversal',
      original: BUY,
    });
    expect(
      isQuantError(
        caught(() => ledger.apply([unlinked])),
        'input.missing_field',
      ),
    ).toBe(true);
    const wrongLink = reversal('rev-w', at(1, 20), BUY, { reversesEventId: 'dep-1' });
    expect(
      isQuantError(
        caught(() => ledger.apply([wrongLink])),
        'input.out_of_range',
      ),
    ).toBe(true);
  });

  it('a repair is recorded on the account it repairs; a reversal of a repair re-applies, a correction never targets one', () => {
    const otherAccount = reversal('rev-o', at(1, 20), BUY, { accountId: 'ira' });
    expect(
      isQuantError(
        caught(() => ledger.apply([otherAccount])),
        'input.out_of_range',
      ),
    ).toBe(true);
    // A reversal of a reversal re-applies the fact — a wrong repair is recoverable.
    const first = reversal('rev-1', at(1, 20), BUY);
    const ofRepair = reversal('rev-of-rev', at(1, 21), first);
    const reapplied = ledger.apply([first]).apply([ofRepair]);
    expect(reapplied.state.accounts['main']!.positions['AAPL']!.quantity).toBe(100);
    expect(reapplied.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(85_000);
    expect(reapplied.state.reversals).toEqual({ '["test","rev-1"]': '["test","rev-of-rev"]' });
    // ...but a correction never targets a repair.
    const correctingARepair = envelope(
      'corr-of-rev',
      at(1, 22),
      'main',
      { eventType: 'admin.correction', original: first, replacement: BUY.event as never },
      { reversesEventId: 'rev-1' },
    );
    expect(
      isQuantError(
        caught(() => ledger.apply([first]).apply([correctingARepair])),
        'input.out_of_range',
      ),
    ).toBe(true);
    const badReplacement = envelope(
      'corr-bad',
      at(1, 20),
      'main',
      {
        eventType: 'admin.correction',
        original: BUY,
        replacement: { eventType: 'admin.reversal', original: BUY } as never,
      },
      { reversesEventId: 'fill-1' },
    );
    expect(
      isQuantError(
        caught(() => ledger.apply([badReplacement])),
        'input.invalid_enum',
      ),
    ).toBe(true);
  });
});

describe('admin.account-migration — the marker is the fact', () => {
  it('records the marker with no economic effect and refuses a self-migration', () => {
    const marker = envelope('mig-1', at(2, 1), 'main', {
      eventType: 'admin.account-migration',
      fromAccountId: 'main',
      toAccountId: 'main-2',
      reason: 'custodian re-keyed the account',
    });
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY, marker] });
    expect(ledger.state.accountMigrations).toEqual([
      {
        eventId: 'mig-1',
        fromAccountId: 'main',
        toAccountId: 'main-2',
        effectiveTimestampMs: at(2, 1),
      },
    ]);
    expect(ledger.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBe(85_000);
    const self = envelope('mig-2', at(2, 2), 'main', {
      eventType: 'admin.account-migration',
      fromAccountId: 'main',
      toAccountId: 'main',
    });
    expect(
      isQuantError(
        caught(() => ledger.apply([self])),
        'input.out_of_range',
      ),
    ).toBe(true);
  });
});

describe('reconcilePortfolio — every difference reported, nothing mutated, drafts never applied', () => {
  const ledger = createPortfolioLedger({
    baseCurrency: 'USD',
    events: [DEPOSIT, BUY, COMMISSION, DIVIDEND, SELL],
  });
  // After the journey: USD cash 100,000 − 15,000 − 10 + 50 + 6,800 = 91,840; AAPL 60 @150.
  const exact: ExternalPortfolioSnapshot = {
    asOf: '2026-03-01T00:00:00Z',
    source: 'broker-a',
    accounts: {
      main: {
        cash: { USD: { total: 91_840 } },
        positions: [{ instrumentId: 'AAPL', quantity: 60, currency: 'USD', costBasis: 9_000 }],
      },
    },
  };
  const tolerance = { quantity: 1e-9, cashAmount: 0.01 };

  it('an exact statement reconciles with no differences and no drafts', () => {
    const report = reconcilePortfolio({
      portfolio: ledger.state,
      external: exact,
      asOf: '2026-03-01T00:00:00Z',
      tolerance,
    });
    expect(report.reconciled).toBe(true);
    expect(report.differenceCount).toBe(0);
    expect(report.suggestedCorrections).toEqual([]);
    expect(report.accounts[0]!.positions[0]).toMatchObject({
      instrumentId: 'AAPL',
      kind: 'matched',
      costBasis: { ledger: 9_000, external: 9_000, difference: 0, withinTolerance: true },
    });
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('a cash gap drafts a validated deposit that a SEPARATE apply brings into agreement', () => {
    const external: ExternalPortfolioSnapshot = {
      ...exact,
      accounts: { main: { ...exact.accounts['main']!, cash: { USD: { total: 92_840 } } } },
    };
    const stateBefore = JSON.stringify(ledger.state);
    const report = reconcilePortfolio({
      portfolio: ledger.state,
      external,
      asOf: '2026-03-01T00:00:00Z',
      tolerance,
    });
    expect(report.reconciled).toBe(false);
    expect(report.differenceCount).toBe(1);
    expect(report.accounts[0]!.cash[0]!.totalDifference).toBeCloseTo(1_000, 9);
    expect(report.suggestedCorrections).toHaveLength(1);
    const draft = report.suggestedCorrections[0]!;
    expect(draft.sourceId).toBe('reconciliation');
    expect(draft.event).toEqual({ eventType: 'cash.deposit', amount: 1_000, currency: 'USD' });
    expect(draft.provenance.provider).toBe('broker-a');
    // Nothing was applied by the reconciliation itself.
    expect(JSON.stringify(ledger.state)).toBe(stateBefore);
    const applied = ledger.apply(report.suggestedCorrections);
    expect(applied.state.accounts['main']!.cashBalances['USD']!.totalAmount).toBeCloseTo(92_840, 9);
    expect(
      reconcilePortfolio({
        portfolio: applied.state,
        external,
        asOf: '2026-03-01T00:00:00Z',
        tolerance,
      }).reconciled,
    ).toBe(true);
  });

  it('explains a settled-only statement by the ledger’s own unsettled legs (pending settlement)', () => {
    const lateSettle = createPortfolioLedger({
      baseCurrency: 'USD',
      events: [
        DEPOSIT,
        envelope('fill-s', at(2, 27), 'main', {
          eventType: 'trade.fill',
          instrumentId: 'AAPL',
          side: 'buy',
          quantity: 10,
          pricePerUnit: 150,
          currency: 'USD',
          settleTimestampMs: at(3, 3),
        }),
      ],
    });
    // Booked cash 98,500; settled at 03-01 is still 100,000 (the −1,500 leg settles 03-03).
    const external: ExternalPortfolioSnapshot = {
      asOf: '2026-03-01T00:00:00Z',
      accounts: {
        main: {
          cash: { USD: { total: 100_000 } },
          positions: [{ instrumentId: 'AAPL', quantity: 10 }],
        },
      },
    };
    const report = reconcilePortfolio({
      portfolio: lateSettle.state,
      external,
      asOf: '2026-03-01T00:00:00Z',
      tolerance,
    });
    const cash = report.accounts[0]!.cash[0]!;
    expect(cash.ledgerTotal).toBe(98_500);
    expect(cash.ledgerSettled).toBe(100_000);
    expect(cash.ledgerUnsettledPayable).toBe(1_500);
    expect(cash.explanation?.kind).toBe('pending-settlement');
    expect(cash.withinTolerance).toBe(true);
    expect(report.reconciled).toBe(true);
    expect(report.explainedCount).toBe(1);
    expect(report.suggestedCorrections).toEqual([]);
  });

  it('reports missing and extra positions, drafting priced fills only when a price exists', () => {
    const external: ExternalPortfolioSnapshot = {
      asOf: '2026-03-01T00:00:00Z',
      accounts: {
        main: {
          cash: { USD: { total: 91_840 } },
          positions: [
            { instrumentId: 'MSFT', quantity: 5, currency: 'USD', costBasis: 2_000 },
            { instrumentId: 'NVDA', quantity: 3, currency: 'USD' },
          ],
        },
      },
    };
    const report = reconcilePortfolio({
      portfolio: ledger.state,
      external,
      asOf: '2026-03-01T00:00:00Z',
      tolerance,
    });
    const byInstrument = new Map(
      report.accounts[0]!.positions.map((row) => [row.instrumentId, row]),
    );
    expect(byInstrument.get('AAPL')!.kind).toBe('missing-in-external');
    expect(byInstrument.get('MSFT')!.kind).toBe('extra-in-external');
    expect(byInstrument.get('NVDA')!.kind).toBe('extra-in-external');
    const drafts = new Map(report.suggestedCorrections.map((d) => [d.eventId, d.event]));
    // AAPL: sell the 60 the source no longer shows, at the ledger's own basis per unit (150).
    expect(drafts.get('reconcile:2026-03-01:main:position:AAPL')).toEqual({
      eventType: 'trade.fill',
      instrumentId: 'AAPL',
      side: 'sell',
      quantity: 60,
      pricePerUnit: 150,
      currency: 'USD',
    });
    // MSFT: buy 5 at the supplied basis per unit (400).
    expect(drafts.get('reconcile:2026-03-01:main:position:MSFT')).toMatchObject({
      side: 'buy',
      quantity: 5,
      pricePerUnit: 400,
    });
    // NVDA: no basis → no draft, with the reason.
    expect(drafts.has('reconcile:2026-03-01:main:position:NVDA')).toBe(false);
    expect(report.undraftable).toEqual([
      expect.objectContaining({
        accountId: 'main',
        subject: 'NVDA',
        reason: expect.stringContaining('no cost basis'),
      }),
    ]);
    expect(report.reconciled).toBe(false);
  });

  it('flags a whole-number quantity ratio as a corporate-action candidate, not a correction', () => {
    const external: ExternalPortfolioSnapshot = {
      asOf: '2026-03-01T00:00:00Z',
      accounts: {
        main: {
          cash: { USD: { total: 91_840 } },
          positions: [{ instrumentId: 'AAPL', quantity: 120 }],
        },
      },
    };
    const report = reconcilePortfolio({
      portfolio: ledger.state,
      external,
      asOf: '2026-03-01T00:00:00Z',
      tolerance,
    });
    const row = report.accounts[0]!.positions[0]!;
    expect(row.kind).toBe('quantity-difference');
    expect(row.explanation).toMatchObject({ kind: 'corporate-action-candidate', ratio: 2 });
    expect(report.suggestedCorrections).toEqual([]);
    expect(report.reconciled).toBe(true);
    expect(report.explainedCount).toBe(1);
  });

  it('cost-basis and currency disagreements are reported even when quantities match', () => {
    const external: ExternalPortfolioSnapshot = {
      asOf: '2026-03-01T00:00:00Z',
      accounts: {
        main: {
          cash: { USD: { total: 91_840 } },
          positions: [{ instrumentId: 'AAPL', quantity: 60, currency: 'EUR', costBasis: 9_500 }],
        },
      },
    };
    const report = reconcilePortfolio({
      portfolio: ledger.state,
      external,
      asOf: '2026-03-01T00:00:00Z',
      tolerance,
    });
    const row = report.accounts[0]!.positions[0]!;
    expect(row.kind).toBe('matched');
    expect(row.withinTolerance).toBe(false);
    expect(row.currencyMismatch).toEqual({ ledger: 'USD', external: 'EUR' });
    expect(row.costBasis).toMatchObject({
      ledger: 9_000,
      external: 9_500,
      difference: 500,
      withinTolerance: false,
    });
    expect(report.reconciled).toBe(false);
  });

  it('accounts present on one side only are reported as such', () => {
    const external: ExternalPortfolioSnapshot = {
      asOf: '2026-03-01T00:00:00Z',
      accounts: { ira: { cash: { EUR: { total: 250 } }, positions: [] } },
    };
    const report = reconcilePortfolio({
      portfolio: ledger.state,
      external,
      asOf: '2026-03-01T00:00:00Z',
      tolerance,
    });
    expect(
      report.accounts.map((a) => [a.accountId, a.presentInLedger, a.presentInExternal]),
    ).toEqual([
      ['ira', false, true],
      ['main', true, false],
    ]);
    expect(report.suggestedCorrections.map((d) => d.accountId)).toEqual(
      expect.arrayContaining(['ira', 'main']),
    );
  });

  it('refuses an explicit null correctionSourceId instead of silently taking the default', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY] });
    const external: ExternalPortfolioSnapshot = {
      asOf: '2026-01-20T00:00:00Z',
      accounts: { main: { cash: { USD: { total: 85_000 } }, positions: [] } },
    };
    const error = caught(() =>
      reconcilePortfolio({
        portfolio: ledger.state,
        external,
        asOf: '2026-01-20T00:00:00Z',
        tolerance: { quantity: 1e-9, cashAmount: 0.01 },
        correctionSourceId: null as never,
      }),
    );
    expect(isQuantError(error, 'input.wrong_type')).toBe(true);
    expect((error as Error).message).toContain('correctionSourceId');
  });

  it('an asOf outside the instants a Date represents is a typed refusal on either side', () => {
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events: [DEPOSIT, BUY] });
    const external: ExternalPortfolioSnapshot = {
      asOf: '2026-01-20T00:00:00Z',
      accounts: { main: { cash: { USD: { total: 85_000 } }, positions: [] } },
    };
    const tolerance = { quantity: 1e-9, cashAmount: 0.01 };
    const tooLate = caught(() =>
      reconcilePortfolio({ portfolio: ledger.state, external, asOf: 1e300, tolerance }),
    );
    expect(isQuantError(tooLate, 'input.out_of_range')).toBe(true);
    expect((tooLate as Error).message).toContain('asOf');
    const externalTooEarly = caught(() =>
      reconcilePortfolio({
        portfolio: ledger.state,
        external: { ...external, asOf: -1.7e308 },
        asOf: '2026-01-20T00:00:00Z',
        tolerance,
      }),
    );
    expect(isQuantError(externalTooEarly, 'input.out_of_range')).toBe(true);
    expect((externalTooEarly as Error).message).toContain('external.asOf');
    // The valuation snapshot shares the one as-of law (integer epoch ms inside the Date range).
    const market = createMarketSnapshot({
      asOf: '2026-01-20T00:00:00Z',
      observations: { spots: { AAPL: { price: 160, currency: 'USD' } } },
    });
    const fractional = caught(() =>
      portfolioSnapshot({ portfolio: ledger.state, asOf: at(1, 20) + 0.5, market }),
    );
    expect(isQuantError(fractional, 'input.out_of_range')).toBe(true);
    expect((fractional as Error).message).toContain('asOf');
  });

  it('tolerance is explicit, and the boundaries teach', () => {
    expect(
      isQuantError(
        caught(() =>
          reconcilePortfolio({
            portfolio: ledger.state,
            external: exact,
            asOf: '2026-03-01T00:00:00Z',
          } as never),
        ),
        'input.missing_field',
      ),
    ).toBe(true);
    expect(
      isQuantError(
        caught(() =>
          reconcilePortfolio({
            portfolio: ledger.state,
            external: exact,
            asOf: '2026-03-01T00:00:00Z',
            tolerance: { quantity: -1, cashAmount: 0 },
          }),
        ),
        'input.out_of_range',
      ),
    ).toBe(true);
    const duplicate: ExternalPortfolioSnapshot = {
      asOf: '2026-03-01T00:00:00Z',
      accounts: {
        main: {
          cash: {},
          positions: [
            { instrumentId: 'AAPL', quantity: 30 },
            { instrumentId: 'AAPL', quantity: 30 },
          ],
        },
      },
    };
    expect(
      isQuantError(
        caught(() =>
          reconcilePortfolio({
            portfolio: ledger.state,
            external: duplicate,
            asOf: '2026-03-01T00:00:00Z',
            tolerance,
          }),
        ),
        'input.out_of_range',
      ),
    ).toBe(true);
    const shifted = reconcilePortfolio({
      portfolio: ledger.state,
      external: { ...exact, asOf: '2026-03-02T00:00:00Z' },
      asOf: '2026-03-01T00:00:00Z',
      tolerance,
    });
    expect(shifted.diagnostics.warnings.some((w) => w.includes('another instant'))).toBe(true);
  });
});
