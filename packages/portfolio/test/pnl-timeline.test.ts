/**
 * FC7 slice 2 — `portfolioPnl` and `portfolioTimeline` against a hand-computed multi-currency
 * journey. Every number below was worked on paper first; the code is checked against the paper,
 * never the other way round.
 *
 * Journey (base USD; EUR is the foreign currency):
 *   01-02 deposit 100,000 USD · 01-10 buy 100 AAPL @150 USD + 10 USD commission (AAPL) ·
 *   01-15 deposit 10,000 EUR · 01-20 buy 10 SAP @200 EUR
 *   ── mark A (02-01): AAPL 160, SAP 210, EURUSD 1.10 ──
 *   02-10 dividend 50 USD (AAPL) · 02-15 sell 40 AAPL @170 · 02-20 margin interest 14 USD ·
 *   02-22 convert 1,100 USD → 1,000 EUR · 02-25 withdraw 5,000 USD · 02-26 exchange fee 5 USD (no instrument)
 *   ── mark B (03-01): AAPL 155, SAP 220, EURUSD 1.05 ──
 *
 * At A: USD cash 84,990; AAPL 100 lots @150 → MV 16,000 (unrealized 1,000); EUR cash 8,000;
 *       SAP MV 2,100 (unrealized 100). NAV = 100,990 + 10,100 × 1.10 = 112,100.
 * At B: USD cash 85,721; AAPL 60 @150 → MV 9,300 (unrealized 300); EUR cash 9,000; SAP MV 2,200
 *       (unrealized 200). NAV = 95,021 + 11,200 × 1.05 = 106,781.
 * Identity over A→B: ΔNAV −5,319 − flows (−5,000) = −319
 *   = realized 800 + unrealized (−700 USD + 100 EUR × 1.05 = −595) + income 50 − costs 5
 *     − financing 14 + FX (10,100 EUR × (1.05 − 1.10) = −505; conversion 1,000 × 1.05 − 1,100 = −50 → −555)
 *   = −319, residual 0.
 */
import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import {
  PORTFOLIO_STATE_SCHEMA_VERSION,
  applyPortfolioEvents,
  createPortfolioLedger,
  portfolioPnl,
  portfolioTimeline,
  type InstrumentClassification,
  type PortfolioEvent,
  type PortfolioEventEnvelope,
  type PortfolioValuationMark,
} from '../src/index.js';

function envelope(
  eventId: string,
  effectiveTimestampMs: number,
  accountId: string,
  event: PortfolioEvent,
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
  };
}

const at = (month: number, day: number, hour = 15) => Date.UTC(2026, month - 1, day, hour);

const EVENTS: PortfolioEventEnvelope[] = [
  envelope('dep-1', at(1, 2), 'main', {
    eventType: 'cash.deposit',
    amount: 100_000,
    currency: 'USD',
  }),
  envelope('fill-1', at(1, 10), 'main', {
    eventType: 'trade.fill',
    instrumentId: 'AAPL',
    side: 'buy',
    quantity: 100,
    pricePerUnit: 150,
    currency: 'USD',
  }),
  envelope('cost-1', at(1, 10, 16), 'main', {
    eventType: 'cost.charge',
    costType: 'commission',
    amount: 10,
    currency: 'USD',
    instrumentId: 'AAPL',
  }),
  envelope('dep-eur', at(1, 15), 'main', {
    eventType: 'cash.deposit',
    amount: 10_000,
    currency: 'EUR',
  }),
  envelope('fill-sap', at(1, 20), 'main', {
    eventType: 'trade.fill',
    instrumentId: 'SAP',
    side: 'buy',
    quantity: 10,
    pricePerUnit: 200,
    currency: 'EUR',
  }),
  envelope('div-1', at(2, 10), 'main', {
    eventType: 'income.received',
    incomeType: 'dividend',
    amount: 50,
    currency: 'USD',
    instrumentId: 'AAPL',
  }),
  envelope('fill-2', at(2, 15), 'main', {
    eventType: 'trade.fill',
    instrumentId: 'AAPL',
    side: 'sell',
    quantity: 40,
    pricePerUnit: 170,
    currency: 'USD',
  }),
  envelope('fin-1', at(2, 20), 'main', {
    eventType: 'financing.charge',
    financingType: 'margin-interest',
    amount: 14,
    currency: 'USD',
  }),
  envelope('conv-1', at(2, 22), 'main', {
    eventType: 'cash.conversion',
    fromCurrency: 'USD',
    toCurrency: 'EUR',
    fromAmount: 1_100,
    toAmount: 1_000,
  }),
  envelope('wd-1', at(2, 25), 'main', {
    eventType: 'cash.withdrawal',
    amount: 5_000,
    currency: 'USD',
  }),
  envelope('cost-2', at(2, 26), 'main', {
    eventType: 'cost.charge',
    costType: 'exchange-fee',
    amount: 5,
    currency: 'USD',
  }),
];

const LEDGER = createPortfolioLedger({
  portfolioId: 'primary',
  baseCurrency: 'USD',
  events: EVENTS,
});

function mark(date: string, apple: number, sap: number, eurusd: number): PortfolioValuationMark {
  return {
    valuationDate: date,
    market: createMarketSnapshot({
      asOf: date,
      observations: {
        spots: { AAPL: { price: apple, currency: 'USD' }, SAP: { price: sap, currency: 'EUR' } },
      },
    }),
    currencyConversions: [{ baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: eurusd }],
  };
}

const A = mark('2026-02-01', 160, 210, 1.1);
const M1 = mark('2026-02-16', 165, 215, 1.08);
const M2 = mark('2026-02-25', 158, 218, 1.06);
const B = mark('2026-03-01', 155, 220, 1.05);

const CLASSIFICATION: Record<string, InstrumentClassification> = {
  AAPL: { underlying: 'AAPL', assetClass: 'equity', strategy: 'core', tags: ['tech', 'us'] },
  SAP: { assetClass: 'equity', strategy: 'satellite', tags: ['tech'] },
};

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('the fold attributes realized, income, and costs per instrument (state schema 2)', () => {
  it('carries the per-instrument maps and the schema version', () => {
    expect(PORTFOLIO_STATE_SCHEMA_VERSION).toBe(4);
    const main = LEDGER.state.accounts['main']!;
    expect(main.realizedPnlByInstrument['AAPL']!['USD']).toBeCloseTo(800, 9);
    expect(main.incomeByInstrument['AAPL']!['USD']).toBeCloseTo(50, 9);
    expect(main.transactionCostsByInstrument['AAPL']!['USD']).toBeCloseTo(10, 9);
    // The exchange fee named no instrument: account-level only.
    expect(main.transactionCosts['USD']).toBeCloseTo(15, 9);
    expect(Object.keys(main.transactionCostsByInstrument)).toEqual(['AAPL']);
  });
});

describe('open account/instrument identities cannot collide inside attribution or labels', () => {
  it('keeps NUL-separated pairs distinct and escapes slashes only where a label needs it', () => {
    const identities = [
      { accountId: 'desk\0book', instrumentId: 'leg', price: 10 },
      { accountId: 'desk', instrumentId: 'book\0leg', price: 20 },
      { accountId: 'desk/book', instrumentId: 'option', price: 30 },
      { accountId: 'desk', instrumentId: 'book/option', price: 40 },
    ];
    const events = identities.map(({ accountId, instrumentId, price }, index) =>
      envelope(`identity-fill-${index}`, at(1, 2, index), accountId, {
        eventType: 'trade.fill',
        instrumentId,
        side: 'buy',
        quantity: 1,
        pricePerUnit: price,
        currency: 'USD',
      }),
    );
    const ledger = createPortfolioLedger({ baseCurrency: 'USD', events });
    const spotsAt = (increment: number) =>
      Object.fromEntries(
        identities.map(({ instrumentId, price }) => [
          instrumentId,
          { price: price + increment, currency: 'USD' },
        ]),
      );
    const from: PortfolioValuationMark = {
      valuationDate: '2026-01-03',
      market: createMarketSnapshot({
        asOf: '2026-01-03T00:00:00Z',
        observations: { spots: spotsAt(0) },
      }),
    };
    const to: PortfolioValuationMark = {
      valuationDate: '2026-01-04',
      market: createMarketSnapshot({
        asOf: '2026-01-04T00:00:00Z',
        observations: { spots: spotsAt(1) },
      }),
    };
    const pnl = portfolioPnl({ ledger, from, to });
    const positions = pnl.groupings.find((group) => group.dimension === 'position')!;
    expect(positions.rows).toHaveLength(4);
    expect(new Set(positions.rows.map((row) => row.label)).size).toBe(4);
    expect(positions.rows.map((row) => row.label)).toEqual(
      expect.arrayContaining([
        'desk\\u0000book/leg',
        'desk/book\\u0000leg',
        'desk\\/book/option',
        'desk/book\\/option',
      ]),
    );
    expect(positions.rows.every((row) => row.unrealizedPnl === 1)).toBe(true);

    const timeline = portfolioTimeline({ ledger, valuationMarks: [from, to] });
    const timelinePositions = timeline.rows[1]!.exposureByGroup.find(
      (group) => group.dimension === 'position',
    )!;
    expect(timelinePositions.rows).toHaveLength(4);
    expect(new Set(timelinePositions.rows.map((row) => row.label)).size).toBe(4);
  });
});

describe('portfolioPnl — the identity holds exactly on a multi-currency journey', () => {
  const pnl = portfolioPnl({
    ledger: LEDGER,
    from: A,
    to: B,
    instrumentClassification: CLASSIFICATION,
  });

  it('values the two marks as hand-computed', () => {
    expect(pnl.from.netAssetValue).toBeCloseTo(112_100, 9);
    expect(pnl.to.netAssetValue).toBeCloseTo(106_781, 9);
    expect(pnl.netAssetValueChange).toBeCloseTo(-5_319, 9);
    expect(pnl.externalFlows).toBeCloseTo(-5_000, 9);
    expect(pnl.investmentReturn).toBeCloseTo(-319, 9);
  });

  it('decomposes exactly — every component to the paper figure, residual 0', () => {
    expect(pnl.components.realizedPnl).toBeCloseTo(800, 9);
    expect(pnl.components.unrealizedPnl).toBeCloseTo(-595, 9);
    expect(pnl.components.income).toBeCloseTo(50, 9);
    expect(pnl.components.transactionCosts).toBeCloseTo(5, 9);
    expect(pnl.components.financing).toBeCloseTo(14, 9);
    expect(pnl.components.foreignExchangePnl).toBeCloseTo(-555, 9);
    expect(pnl.components.totalPnl).toBeCloseTo(-319, 9);
    expect(Math.abs(pnl.residual)).toBeLessThan(1e-9);
    expect(pnl.diagnostics.residualWithinTolerance).toBe(true);
    expect(pnl.components.totalPnl + pnl.residual).toBeCloseTo(pnl.investmentReturn, 12);
  });

  it('shows the per-currency ledger behind the figures', () => {
    const eur = pnl.byCurrency.find((row) => row.currency === 'EUR')!;
    expect(eur.quoteAtStart).toBe(1.1);
    expect(eur.quoteAtEnd).toBe(1.05);
    expect(eur.openingLocalValue).toBeCloseTo(10_100, 9);
    expect(eur.closingLocalValue).toBeCloseTo(11_200, 9);
    expect(eur.conversionNet).toBeCloseTo(1_000, 9);
    expect(eur.translationEffectBaseCurrency).toBeCloseTo(-505, 9);
    const usd = pnl.byCurrency.find((row) => row.currency === 'USD')!;
    expect(usd.quoteAtEnd).toBe(1);
    expect(usd.externalFlows).toBeCloseTo(-5_000, 9);
    expect(usd.conversionNet).toBeCloseTo(-1_100, 9);
    expect(usd.translationEffectBaseCurrency).toBe(0);
  });

  it('groups by every dimension and reconciles every partitioning one to the total', () => {
    const byDimension = new Map(pnl.groupings.map((g) => [g.dimension, g]));
    expect([...byDimension.keys()].sort()).toEqual(
      [
        'account',
        'assetClass',
        'currency',
        'instrument',
        'position',
        'strategy',
        'tag',
        'underlying',
      ].sort(),
    );
    const instrument = byDimension.get('instrument')!;
    const apple = instrument.rows.find((row) => row.label === 'AAPL')!;
    expect(apple.realizedPnl).toBeCloseTo(800, 9);
    expect(apple.unrealizedPnl).toBeCloseTo(-700, 9);
    expect(apple.income).toBeCloseTo(50, 9);
    expect(apple.transactionCosts).toBe(0);
    expect(apple.totalPnl).toBeCloseTo(150, 9);
    const sap = instrument.rows.find((row) => row.label === 'SAP')!;
    expect(sap.unrealizedPnl).toBeCloseTo(105, 9);
    expect(sap.totalPnl).toBeCloseTo(105, 9);
    expect(instrument.unattributed.transactionCosts).toBeCloseTo(5, 9);
    expect(instrument.unattributed.financing).toBeCloseTo(14, 9);
    expect(instrument.unattributed.foreignExchangePnl).toBeCloseTo(-555, 9);
    expect(instrument.unattributed.totalPnl).toBeCloseTo(-574, 9);
    for (const dimension of [
      'position',
      'instrument',
      'account',
      'currency',
      'underlying',
      'assetClass',
      'strategy',
    ] as const) {
      const grouping = byDimension.get(dimension)!;
      expect(grouping.reconciles, dimension).toBe(true);
      expect(Math.abs(grouping.reconciliationResidual), dimension).toBeLessThan(1e-9);
    }
    expect(byDimension.get('underlying')!.rows.map((r) => r.label)).toEqual([
      'AAPL',
      'unclassified',
    ]);
    expect(byDimension.get('strategy')!.rows.map((r) => [r.label, r.totalPnl])).toEqual([
      ['core', expect.closeTo(150, 9)],
      ['satellite', expect.closeTo(105, 9)],
    ]);
    const tag = byDimension.get('tag')!;
    expect(tag.reconciles).toBe(false);
    expect(tag.reason).toContain('overlap');
    expect(tag.rows.find((r) => r.label === 'tech')!.totalPnl).toBeCloseTo(255, 9);
    expect(tag.rows.find((r) => r.label === 'us')!.totalPnl).toBeCloseTo(150, 9);
  });

  it('is frozen, states its identity and convention, and the artifact method is the same call', () => {
    expect(Object.isFrozen(pnl)).toBe(true);
    expect(pnl.assumptions.identity).toContain('ending NAV − beginning NAV − external flows');
    expect(pnl.assumptions.conversionConvention).toContain('CLOSING');
    expect(LEDGER.pnl({ from: A, to: B, instrumentClassification: CLASSIFICATION })).toEqual(pnl);
  });
});

describe('portfolioTimeline — NAV, flows, exposure, drawdown, and P&L through time', () => {
  const timeline = portfolioTimeline({
    ledger: LEDGER,
    valuationMarks: [A, M1, M2, B],
    instrumentClassification: CLASSIFICATION,
  });

  it('marks exactly what portfolioPnl and the FC4 seam see', () => {
    expect(timeline.rows.map((row) => row.valuationDate)).toEqual([
      '2026-02-01',
      '2026-02-16',
      '2026-02-25',
      '2026-03-01',
    ]);
    expect(timeline.rows[0]!.netAssetValue).toBeCloseTo(112_100, 9);
    expect(timeline.rows[3]!.netAssetValue).toBeCloseTo(106_781, 9);
    expect(timeline.valuations.map((v) => v.netAssetValue)).toEqual(
      timeline.rows.map((row) => row.netAssetValue),
    );
    expect(timeline.rows[0]!.pnlSincePrior).toBeNull();
    expect(timeline.rows[0]!.externalFlowsSincePrior).toBe(0);
    // The withdrawal lands on 02-25 AFTER the 02-25 mark, so it belongs to the last step.
    expect(timeline.rows[3]!.externalFlowsSincePrior).toBeCloseTo(-5_000, 9);
  });

  it('the steps telescope: Σ step totals equals the whole-window investment return', () => {
    const whole = portfolioPnl({ ledger: LEDGER, from: A, to: B });
    expect(timeline.cumulativePnl.totalPnl).toBeCloseTo(whole.investmentReturn, 9);
    expect(timeline.cumulativePnl.totalPnl).toBeCloseTo(-319, 9);
    expect(Math.abs(timeline.cumulativePnl.residual)).toBeLessThan(1e-9);
    // Local components that never cross a quote agree step-by-step too.
    expect(timeline.cumulativePnl.realizedPnl).toBeCloseTo(800, 9);
    expect(timeline.cumulativePnl.income).toBeCloseTo(50, 9);
    expect(timeline.cumulativePnl.financing).toBeCloseTo(14, 9);
  });

  it('exposure is position value only, and every partitioning group reconciles', () => {
    const first = timeline.rows[0]!;
    expect(first.exposure.long).toBeCloseTo(16_000 + 2_100 * 1.1, 9);
    expect(first.exposure.short).toBe(0);
    expect(first.exposure.gross).toBeCloseTo(first.exposure.long + first.exposure.short, 12);
    expect(first.exposure.net).toBeCloseTo(first.exposure.long - first.exposure.short, 12);
    expect(first.exposure.grossLeverage).toBeCloseTo(
      first.exposure.gross / first.netAssetValue,
      12,
    );
    for (const grouping of first.exposureByGroup) {
      if (grouping.dimension === 'tag') {
        expect(grouping.reconciles).toBe(false);
        continue;
      }
      expect(grouping.reconciles, grouping.dimension).toBe(true);
    }
    const byCurrency = first.exposureByGroup.find((g) => g.dimension === 'currency')!;
    expect(byCurrency.rows).toEqual([
      { label: 'EUR', baseCurrencyNotionalValue: expect.closeTo(2_310, 9) },
      { label: 'USD', baseCurrencyNotionalValue: 16_000 },
    ]);
  });

  it('composes the FC4 return index and a flow-adjusted drawdown', () => {
    expect(timeline.diagnostics.indexWithheldReason).toBeUndefined();
    expect(timeline.rows[0]!.indexValue).toBe(1);
    for (const row of timeline.rows) {
      expect(row.indexValue).not.toBeNull();
      expect(row.drawdown).not.toBeNull();
      expect(row.drawdown!).toBeGreaterThanOrEqual(0);
    }
    expect(timeline.maxDrawdown).toBeCloseTo(
      Math.max(...timeline.rows.map((r) => r.drawdown!)),
      12,
    );
    expect(Object.isFrozen(timeline)).toBe(true);
    expect(
      LEDGER.timeline({ valuationMarks: [A, M1, M2, B], instrumentClassification: CLASSIFICATION }),
    ).toEqual(timeline);
  });

  it('withholds the index with a reason when a flow date has no mark — never forward-filled', () => {
    const sparse = portfolioTimeline({ ledger: LEDGER, valuationMarks: [A, B] });
    expect(sparse.diagnostics.indexWithheldReason).toBeDefined();
    expect(sparse.rows.every((row) => row.indexValue === null && row.drawdown === null)).toBe(true);
    expect(sparse.maxDrawdown).toBeNull();
    expect(sparse.diagnostics.gaps.length).toBeGreaterThan(0);
    // The P&L steps do not depend on the index.
    expect(sparse.rows[1]!.pnlSincePrior!.totalPnl).toBeCloseTo(-319, 9);
  });
});

describe('a single-currency book: step components sum exactly to the whole window', () => {
  const usdOnly = createPortfolioLedger({
    baseCurrency: 'USD',
    events: EVENTS.filter((e) => !['dep-eur', 'fill-sap', 'conv-1'].includes(e.eventId)),
  });
  const usdMark = (date: string, apple: number): PortfolioValuationMark => ({
    valuationDate: date,
    market: createMarketSnapshot({
      asOf: date,
      observations: { spots: { AAPL: { price: apple, currency: 'USD' } } },
    }),
  });
  it('every component telescopes', () => {
    const marks = [
      usdMark('2026-02-01', 160),
      usdMark('2026-02-16', 165),
      usdMark('2026-02-25', 158),
      usdMark('2026-03-01', 155),
    ];
    const timeline = portfolioTimeline({ ledger: usdOnly, valuationMarks: marks });
    const whole = portfolioPnl({ ledger: usdOnly, from: marks[0]!, to: marks[3]! });
    for (const key of [
      'realizedPnl',
      'unrealizedPnl',
      'income',
      'transactionCosts',
      'financing',
      'foreignExchangePnl',
      'totalPnl',
    ] as const) {
      expect(timeline.cumulativePnl[key], key).toBeCloseTo(whole.components[key], 9);
    }
    expect(whole.components.foreignExchangePnl).toBe(0);
  });
});

describe('boundaries teach', () => {
  it('refuses a missing from/to, unsorted marks, and junk classification', () => {
    expect(
      isQuantError(
        caught(() => portfolioPnl({ ledger: LEDGER, from: A } as never)),
        'input.missing_field',
      ),
    ).toBe(true);
    expect(
      isQuantError(
        caught(() => portfolioPnl({ ledger: LEDGER, from: B, to: A })),
        'input.out_of_range',
      ),
    ).toBe(true);
    expect(
      isQuantError(
        caught(() =>
          portfolioPnl({
            ledger: LEDGER,
            from: A,
            to: B,
            instrumentClassification: { AAPL: { tags: 'tech' } } as never,
          }),
        ),
        'input.wrong_type',
      ),
    ).toBe(true);
    expect(
      isQuantError(
        caught(() =>
          portfolioPnl({
            ledger: LEDGER,
            from: A,
            to: B,
            instrumentClassification: { AAPL: { sector: 'x' } } as never,
          }),
        ),
        'input.unknown_field',
      ),
    ).toBe(true);
  });

  it('a timeline needs two marks and a real ledger', () => {
    expect(
      isQuantError(
        caught(() => portfolioTimeline({ ledger: LEDGER, valuationMarks: [A] })),
        'input.out_of_range',
      ),
    ).toBe(true);
    const { apply: _apply, ...notALedger } = LEDGER;
    expect(
      isQuantError(
        caught(() => portfolioTimeline({ ledger: notALedger as never, valuationMarks: [A, B] })),
      ),
    ).toBe(true);
  });

  it('a mark that cannot value the book is a typed failure, not a forward-fill', () => {
    const noSap: PortfolioValuationMark = {
      valuationDate: '2026-03-01',
      market: createMarketSnapshot({
        asOf: '2026-03-01T00:00:00Z',
        observations: { spots: { AAPL: { price: 155, currency: 'USD' } } },
      }),
      currencyConversions: [{ baseCurrency: 'EUR', quoteCurrency: 'USD', quotePerBase: 1.05 }],
    };
    expect(
      isQuantError(
        caught(() => portfolioPnl({ ledger: LEDGER, from: A, to: noSap })),
        'portfolio.mark_unavailable',
      ),
    ).toBe(true);
  });

  it('a state from the previous schema is refused with the re-fold teaching', () => {
    const state = applyPortfolioEvents({
      portfolio: { baseCurrency: 'USD' },
      events: [EVENTS[0]!],
    });
    const error = caught(() =>
      applyPortfolioEvents({ previousState: { ...state, schemaVersion: 1 }, events: [] }),
    );
    expect(isQuantError(error, 'snapshot.unsupported_version')).toBe(true);
  });
});
