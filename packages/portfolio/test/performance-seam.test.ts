import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { createMarketSnapshot } from '@totalfinance/core/artifacts';
import { moneyWeightedReturn, timeWeightedReturn } from '@totalfinance/performance';
import type { ExternalCashFlow, PortfolioValuation } from '@totalfinance/performance';
import { convertCurrency } from '@totalfinance/foreign-exchange';
import { createPortfolioLedger, portfolioPerformanceInputs } from '@totalfinance/portfolio';
import type {
  CurrencyPairQuote,
  PortfolioEvent,
  PortfolioEventEnvelope,
  PortfolioValuationMark,
} from '@totalfinance/portfolio';

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

function expectCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected a throw with code ${code}`).toBeDefined();
  expect(
    isQuantError(thrown, code),
    `expected code ${code}, got ${(thrown as Error).message}`,
  ).toBe(true);
}

function market(asOf: string, applePrice?: number) {
  return createMarketSnapshot({
    asOf,
    observations:
      applePrice === undefined ? {} : { spots: { AAPL: { price: applePrice, currency: 'USD' } } },
  });
}

const LEDGER = createPortfolioLedger({
  portfolioId: 'primary',
  baseCurrency: 'USD',
  events: [
    envelope('dep-1', Date.UTC(2026, 0, 1, 15), 'main', {
      eventType: 'cash.deposit',
      amount: 100_000,
      currency: 'USD',
    }),
    envelope('fill-1', Date.UTC(2026, 0, 10, 15), 'main', {
      eventType: 'trade.fill',
      instrumentId: 'AAPL',
      side: 'buy',
      quantity: 100,
      pricePerUnit: 150,
      currency: 'USD',
    }),
    envelope('dep-2', Date.UTC(2026, 1, 1, 12), 'main', {
      eventType: 'cash.deposit',
      amount: 20_000,
      currency: 'USD',
    }),
    envelope('wd-1', Date.UTC(2026, 2, 1, 12), 'main', {
      eventType: 'cash.withdrawal',
      amount: 5_000,
      currency: 'USD',
    }),
  ],
});

const MARKS: PortfolioValuationMark[] = [
  { valuationDate: '2026-01-02', market: market('2026-01-02') },
  { valuationDate: '2026-02-01', market: market('2026-02-01', 160) },
  { valuationDate: '2026-03-01', market: market('2026-03-01', 155) },
  { valuationDate: '2026-04-01', market: market('2026-04-01', 162) },
];

/** The SAME series, built by hand from the journey — every number recomputed on paper. */
const HAND_VALUATIONS: PortfolioValuation[] = [
  { valuationDate: '2026-01-02', netAssetValue: 100_000 },
  { valuationDate: '2026-02-01', netAssetValue: 101_000 }, // 85_000 + 100×160
  { valuationDate: '2026-03-01', netAssetValue: 120_500 }, // 105_000 + 100×155
  { valuationDate: '2026-04-01', netAssetValue: 116_200 }, // 100_000 + 100×162
];
const HAND_FLOWS: ExternalCashFlow[] = [
  { cashFlowDate: '2026-02-01', amount: 20_000, label: 'dep-2', accountId: 'main' },
  { cashFlowDate: '2026-03-01', amount: -5_000, label: 'wd-1', accountId: 'main' },
];

describe('portfolioPerformanceInputs — the ledger-derived FC4 series', () => {
  const series = portfolioPerformanceInputs({ ledger: LEDGER, valuationMarks: MARKS });

  it('derives EXACTLY the hand-built valuations and flows', () => {
    expect(series.valuations).toEqual(HAND_VALUATIONS);
    expect(series.externalCashFlows).toEqual(HAND_FLOWS);
  });

  it('marks BEFORE same-day flows: the mark instant is 00:00 UTC over a strict prefix', () => {
    // dep-2 lands 2026-02-01T12:00 — the 02-01 mark (101_000) excludes it; the deposit is a
    // subperiod-starting flow, exactly FC4's stated convention.
    expect(series.valuations[1]!.netAssetValue).toBe(101_000);
    expect(typeof series.assumptions.markInstant).toBe('string');
    expect(typeof series.assumptions.flowMapping).toBe('string');
  });

  it('excludes flows outside the mark window, counted and disclosed', () => {
    // dep-1 is dated 2026-01-01, before the first mark 2026-01-02.
    expect(series.diagnostics.excludedFlowCount).toBe(1);
    expect(series.diagnostics.warnings.some((w) => w.includes('outside the'))).toBe(true);
    expect(series.diagnostics.markCount).toBe(4);
    expect(series.diagnostics.flowCount).toBe(2);
  });

  it('returns a frozen result', () => {
    expect(Object.isFrozen(series)).toBe(true);
    expect(Object.isFrozen(series.valuations)).toBe(true);
  });
});

describe('the FC8 acceptance hook, closed early: TWR/MWR consume the exact ledger flows and marks', () => {
  const series = portfolioPerformanceInputs({ ledger: LEDGER, valuationMarks: MARKS });

  it('timeWeightedReturn(ledger series) === timeWeightedReturn(hand series), deep-equal', () => {
    const fromLedger = timeWeightedReturn({
      valuations: series.valuations,
      externalCashFlows: series.externalCashFlows,
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    const fromHand = timeWeightedReturn({
      valuations: HAND_VALUATIONS,
      externalCashFlows: HAND_FLOWS,
      flowTiming: 'at-flow-timestamp',
      annualization: 'none',
    });
    expect(fromLedger).toEqual(fromHand);
    expect(fromLedger.timeWeightedReturn).not.toBeNull();
    // The hand-linked figure under FC4's mark-first convention (a flow dated D lands AFTER the
    // mark dated D, so it enters the NEXT subperiod's opening base: r = end / (start + flow) − 1):
    // 1.01 × (120_500 / (101_000 + 20_000)) × (116_200 / (120_500 − 5_000)) − 1. The draft's
    // original figure encoded the pre-correction (end − flow) / start form the 2026-08-23 review
    // wave removed; the ledger and hand series still agree by construction — this pins the LAW.
    const expected = 1.01 * (120_500 / 121_000) * (116_200 / 115_500) - 1;
    expect(fromLedger.timeWeightedReturn!).toBeCloseTo(expected, 12);
    expect(fromLedger.diagnostics.gaps).toEqual([]);
  });

  it('moneyWeightedReturn(ledger series) === moneyWeightedReturn(hand series), deep-equal', () => {
    const fromLedger = moneyWeightedReturn({
      valuations: series.valuations,
      externalCashFlows: series.externalCashFlows,
    });
    const fromHand = moneyWeightedReturn({
      valuations: HAND_VALUATIONS,
      externalCashFlows: HAND_FLOWS,
    });
    expect(fromLedger).toEqual(fromHand);
    expect(fromLedger.moneyWeightedReturn).not.toBeNull();
  });
});

describe('multi-currency flows — converted at the same-date mark, FC5 arithmetic', () => {
  const EURUSD: CurrencyPairQuote = {
    baseCurrency: 'EUR',
    quoteCurrency: 'USD',
    quotePerBase: 1.08,
  };
  const ledger = LEDGER.apply([
    envelope('dep-eur', Date.UTC(2026, 3, 1, 12), 'main', {
      eventType: 'cash.deposit',
      amount: 3_000,
      currency: 'EUR',
    }),
  ]);

  it('converts a non-base flow with the mark-date quote, equal to convertCurrency exactly', () => {
    const marks: PortfolioValuationMark[] = [
      MARKS[0]!,
      MARKS[1]!,
      MARKS[2]!,
      {
        valuationDate: '2026-04-01',
        market: market('2026-04-01', 162),
        currencyConversions: [EURUSD],
      },
    ];
    const series = portfolioPerformanceInputs({ ledger, valuationMarks: marks });
    const eurFlow = series.externalCashFlows.find((flow) => flow.label === 'dep-eur')!;
    const viaForeignExchange = convertCurrency({
      amount: 3_000,
      fromCurrency: 'EUR',
      toCurrency: 'USD',
      spotRate: EURUSD,
    });
    expect(eurFlow.amount).toBe(viaForeignExchange.convertedAmount);
    // The 04-01 valuation now includes the EUR cash (deposit lands after the mark instant? No —
    // it lands 12:00 on 04-01, AFTER the 00:00 mark, so the mark excludes it. Verified:
    expect(series.valuations[3]!.netAssetValue).toBe(116_200);
  });

  it('refuses a non-base flow with no same-date mark to convert at', () => {
    const shifted = LEDGER.apply([
      envelope('dep-eur-2', Date.UTC(2026, 2, 15, 12), 'main', {
        eventType: 'cash.deposit',
        amount: 3_000,
        currency: 'EUR',
      }),
    ]);
    expectCode(
      () => portfolioPerformanceInputs({ ledger: shifted, valuationMarks: MARKS }),
      'portfolio.mark_unavailable',
    );
  });
});

describe('seam boundary — Law 12', () => {
  it('requires at least two strictly ascending marks', () => {
    expectCode(
      () => portfolioPerformanceInputs({ ledger: LEDGER, valuationMarks: [MARKS[0]!] }),
      'input.out_of_range',
    );
    expectCode(
      () => portfolioPerformanceInputs({ ledger: LEDGER, valuationMarks: [MARKS[1]!, MARKS[0]!] }),
      'input.out_of_range',
    );
  });

  it('refuses an unknown mark key and a sloppy date', () => {
    expectCode(
      () =>
        portfolioPerformanceInputs({
          ledger: LEDGER,
          valuationMarks: [
            MARKS[0]!,
            { ...MARKS[1]!, note: 'x' } as unknown as PortfolioValuationMark,
          ],
        }),
      'input.unknown_field',
    );
    expectCode(
      () =>
        portfolioPerformanceInputs({
          ledger: LEDGER,
          valuationMarks: [MARKS[0]!, { ...MARKS[1]!, valuationDate: '2026-2-1' }],
        }),
      'input.wrong_type',
    );
  });
});
