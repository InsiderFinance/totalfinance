/**
 * Stage 4.6 slice 5 — `portfolioBacktest`: one golden journey per lifecycle kind, each reconciling
 * the reported equity to the ledger it emits; the declarative model on a schedule and the direct
 * callback; external flows; settlement lags; a foreign currency through dated FX quotes; forced
 * liquidation under both policies; the FC7 replay law; determinism; and every malformed request.
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode, isoDateToEpochMs, resolvedExpiry } from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { applyPortfolioEvents, portfolioSnapshot } from '@totalfinance/portfolio';
import { execution } from '@totalfinance/backtest/execution';
import {
  accruedFromTerms,
  adapterFor,
  assertInstrumentAdapterConformance,
  instrumentAdapters,
  portfolioBacktest,
  splitShares,
  type InstrumentAdapter,
  type PortfolioBacktestRequest,
} from '@totalfinance/backtest/portfolio';
import { at, bars, dateOf, drift, equityRequest, flatPath } from './portfolio-journeys.js';

const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

/** The reported equity must be the ledger's NAV at every mark, and the events must fold back to it. */
function expectReconciled(result: ReturnType<typeof portfolioBacktest>): void {
  expect(Math.abs(result.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-6);
  const state = applyPortfolioEvents({
    portfolio: {
      baseCurrency: result.assumptions.baseCurrency,
      lotRelief: result.assumptions.lotRelief,
    },
    events: result.events,
  });
  const last = result.valuationMarks[result.valuationMarks.length - 1]!;
  const nav = portfolioSnapshot({
    portfolio: state,
    asOf: isoDateToEpochMs(last.valuationDate),
    market: last.market,
    ...(last.currencyConversions !== undefined
      ? { currencyConversions: last.currencyConversions }
      : {}),
  }).netAssetValue;
  expect(nav).toBeCloseTo(result.finalValue, 6);
}

describe('the declarative strategy on a schedule', () => {
  it('decides at the first session, buys at the next, holds, marks daily, and reconciles to the ledger', () => {
    const result = portfolioBacktest(equityRequest());
    expect(result.diagnostics.sessionCount).toBe(10);
    expect(result.orders.length).toBeGreaterThan(0);
    expect(result.orders[0]).toMatchObject({
      instrumentId: 'AAA',
      side: 'buy',
      source: 'strategy',
      outcome: 'filled',
    });
    expect(result.fills[0]!.contractMultiplier).toBeUndefined();
    // T+1 by default for an equity: the fill's cash settles the next day
    expect(result.fills[0]!.settleTimestampMs).toBe(at(2));
    expect(result.ledger.events[0]!.eventType).toBe('cash.deposit');
    expect(result.valuationMarks).toHaveLength(10);
    expect(result.valuationMarks[0]!.valuationDate).toBe(dateOf(at(1)));
    expect(result.timeline?.rows).toHaveLength(10);
    expect(result.pnl?.investmentReturn).toBeGreaterThan(0);
    expect(result.finalValue).toBeGreaterThan(100_000);
    expect(result.points).toHaveLength(11);
    expect(result.returns).toHaveLength(10);
    expect(result.assumptions.strategy).toEqual({
      kind: 'model',
      modelId: null,
      targets: 2,
      frequency: 'monthly',
      scope: 'to-target',
    });
    expect(result.assumptions.replayable).toBe(true);
    expect(result.assumptions.settlement['AAA']).toBe('T+1');
    expect(result.runId).toMatch(/^sha256:/);
    expectReconciled(result);
    // one rebalance per month: the second month's first session trades again
    const twoMonths = portfolioBacktest(
      equityRequest({ marketData: { bars: bars('AAA', drift(40, 100, 1)) } }),
    );
    const rebalanceInstants = new Set(
      twoMonths.orders.filter((o) => o.source === 'strategy').map((o) => dateOf(o.asOf)),
    );
    expect(rebalanceInstants.size).toBe(2);
  });

  it('is deterministic and the FC7 events fold to the same state', () => {
    const a = portfolioBacktest(equityRequest());
    const b = portfolioBacktest(equityRequest());
    expect(canonicalJsonOf(a)).toBe(canonicalJsonOf(b));
  });
});

describe('the direct strategy', () => {
  it('sees the session, places orders, and is not replayable', () => {
    const seen: number[] = [];
    const result = portfolioBacktest(
      equityRequest({
        strategy: {
          onSession: (context) => {
            seen.push(context.netAssetValue);
            if (context.index !== 0) return [];
            return [
              {
                orderId: `o-${context.index}`,
                instrumentId: 'AAA',
                side: 'buy',
                quantity: 100,
                type: 'market',
                submittedTimestampMs: context.asOf,
              },
            ];
          },
        },
      }),
    );
    expect(seen).toHaveLength(9);
    expect(result.orders).toHaveLength(1);
    expect(result.fills[0]!.quantity).toBe(100);
    expect(result.assumptions.strategy).toEqual({ kind: 'callback', replayable: false });
    expect(result.assumptions.replayable).toBe(false);
    expectReconciled(result);
    // a malformed intent is refused by the order guard
    expect(
      failure(() =>
        portfolioBacktest(
          equityRequest({
            strategy: {
              onSession: () => [
                {
                  orderId: 'x',
                  instrumentId: 'AAA',
                  side: 'buy',
                  quantity: -1,
                  type: 'market',
                  submittedTimestampMs: 0,
                },
              ],
            },
          }),
        ),
      ).code,
    ).toBeDefined();
  });
});

describe('lifecycle journeys reconcile to the ledger', () => {
  it('equity: a dividend on the ex-date and a 2:1 split, with T+2 settlement', () => {
    const result = portfolioBacktest(
      equityRequest({
        accounting: {
          baseCurrency: 'USD',
          initialCash: [{ currency: 'USD', amount: 100_000 }],
          settlement: { equity: 'T+2' },
        },
        marketData: {
          bars: bars('AAA', [...flatPath(4, 100), ...flatPath(6, 50)]),
          dividends: [{ instrumentId: 'AAA', exDate: dateOf(at(2)), amount: 1 }],
          corporateActions: [
            { symbol: 'AAA', effectiveDate: dateOf(at(4)), type: 'split', ratio: 2 },
          ],
        },
        strategy: {
          onSession: (c) =>
            c.index === 0
              ? [
                  {
                    orderId: 'buy',
                    instrumentId: 'AAA',
                    side: 'buy',
                    quantity: 100,
                    type: 'market',
                    submittedTimestampMs: c.asOf,
                  },
                ]
              : [],
        },
      }),
    );
    expect(result.fills[0]!.settleTimestampMs).toBe(at(3));
    const income = result.events.filter((e) => e.eventType === 'income.received');
    expect(income).toHaveLength(1);
    expect((income[0]!.event as { amount: number }).amount).toBe(100);
    const split = result.events.find((e) => e.eventType === 'corporate.split');
    expect(split?.event).toMatchObject({ sharesAfterSplit: 2, sharesBeforeSplit: 1 });
    expect(result.diagnostics.lifecycleEventCount).toBe(2);
    // the position is 200 shares at 50 after the split — the equity is continuous
    const before = result.points[4]!.equity;
    const after = result.points[5]!.equity;
    expect(after).toBeCloseTo(before, 6);
    expectReconciled(result);
    expect(splitShares(1.5)).toEqual({ sharesAfterSplit: 3, sharesBeforeSplit: 2 });
    expect(splitShares(0.25)).toEqual({ sharesAfterSplit: 1, sharesBeforeSplit: 4 });
  });

  it('option: a held put settles at intrinsic from the underlying at expiry (assignment for the writer)', () => {
    const expiry = dateOf(at(5));
    const contractTerms = {
      kind: 'option' as const,
      underlyingInstrumentId: 'AAA',
      type: 'put' as const,
      strikePricePerUnit: 100,
      expiryTimestampMs: resolvedExpiry(expiry).expiresAt,
    };
    const chains = Array.from({ length: 8 }, (_, i) => ({
      asOf: at(i),
      underlyingPrice: 100 - i,
      quotes: [
        {
          contract: {
            underlying: 'AAA',
            type: 'put' as const,
            style: 'european' as const,
            strike: 100,
            expiry,
            ...resolvedExpiry(expiry),
            multiplier: 100,
          },
          timestampMs: at(i),
          mid: Math.max(100 - (100 - i), 0) + 1,
          impliedVolatility: 0.2,
          underlyingPrice: 100 - i,
        },
      ],
    }));
    const result = portfolioBacktest({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: {
        AAA: { kind: 'equity', currency: 'USD' },
        'AAA P100': {
          kind: 'option',
          currency: 'USD',
          contractMultiplier: 100,
          contract: contractTerms,
        },
      },
      marketData: { bars: bars('AAA', drift(8, 100, -1)), optionChains: chains },
      strategy: {
        onSession: (c) =>
          c.index === 0
            ? [
                {
                  orderId: 'write',
                  instrumentId: 'AAA P100',
                  side: 'sell',
                  quantity: 1,
                  type: 'market',
                  submittedTimestampMs: c.asOf,
                },
              ]
            : [],
      },
    });
    expect(result.fills[0]).toMatchObject({
      instrumentId: 'AAA P100',
      side: 'sell',
      contractMultiplier: 100,
    });
    const assignment = result.events.find((e) => e.eventType === 'derivative.assignment');
    expect(assignment).toBeDefined();
    expect(dateOf(assignment!.effectiveTimestampMs)).toBe(expiry);
    expect(result.assumptions.settlement['AAA P100']).toBe('T+1');
    expectReconciled(result);
  });

  it('future: variation margin daily, a declared roll, and expiry settlement', () => {
    const near = {
      kind: 'future' as const,
      underlyingInstrumentId: 'IDX',
      expiryTimestampMs: at(5),
    };
    const far = {
      kind: 'future' as const,
      underlyingInstrumentId: 'IDX',
      expiryTimestampMs: at(20),
    };
    const result = portfolioBacktest({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: {
        F1: {
          kind: 'future',
          currency: 'USD',
          contractMultiplier: 10,
          contract: near,
          roll: { toInstrumentId: 'F2', sessionsBeforeExpiry: 1 },
        },
        F2: { kind: 'future', currency: 'USD', contractMultiplier: 10, contract: far },
      },
      marketData: { bars: [...bars('F1', drift(6, 1000, 5)), ...bars('F2', drift(10, 1010, 5))] },
      strategy: {
        onSession: (c) =>
          c.index === 0
            ? [
                {
                  orderId: 'long',
                  instrumentId: 'F1',
                  side: 'buy',
                  quantity: 2,
                  type: 'market',
                  submittedTimestampMs: c.asOf,
                },
              ]
            : [],
      },
    });
    expect(result.fills[0]).toMatchObject({
      instrumentId: 'F1',
      settlementStyle: 'variation-margin',
      contractMultiplier: 10,
    });
    expect(
      result.events.filter((e) => e.eventType === 'derivative.variation-margin').length,
    ).toBeGreaterThan(2);
    const roll = result.events.find((e) => e.eventType === 'derivative.roll');
    expect(roll?.event).toMatchObject({
      fromInstrumentId: 'F1',
      toInstrumentId: 'F2',
      quantity: 2,
    });
    // after the roll the book holds F2 and no F1
    const last = result.valuationMarks[result.valuationMarks.length - 1]!;
    expect(Object.keys(last.market.observations.spots ?? {})).toContain('F2');
    expectReconciled(result);
  });

  it('crypto: spot buy-and-hold and a perpetual paying and receiving funding', () => {
    const result = portfolioBacktest({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 1_000_000 }] },
      instruments: {
        BTC: { kind: 'crypto-spot', currency: 'USD' },
        'BTC-PERP': {
          kind: 'crypto-perpetual',
          currency: 'USD',
          contract: { kind: 'perpetual', underlyingInstrumentId: 'BTC' },
        },
      },
      marketData: {
        bars: [...bars('BTC', drift(6, 30_000, 100)), ...bars('BTC-PERP', drift(6, 30_010, 100))],
        fundingRates: [
          { instrumentId: 'BTC-PERP', timestampMs: at(2), fundingRate: 0.0001 },
          { instrumentId: 'BTC-PERP', timestampMs: at(3), fundingRate: -0.0002 },
        ],
      },
      calendar: 'ALWAYS_OPEN',
      strategy: {
        onSession: (c) =>
          c.index === 0
            ? [
                {
                  orderId: 'spot',
                  instrumentId: 'BTC',
                  side: 'buy',
                  quantity: 1,
                  type: 'market',
                  submittedTimestampMs: c.asOf,
                },
                {
                  orderId: 'perp',
                  instrumentId: 'BTC-PERP',
                  side: 'buy',
                  quantity: 2,
                  type: 'market',
                  submittedTimestampMs: c.asOf,
                },
              ]
            : [],
      },
    });
    expect(result.assumptions.settlement['BTC']).toBe('T+0');
    const paid = result.events.filter((e) => e.eventType === 'financing.charge');
    const received = result.events.filter((e) => e.eventType === 'income.received');
    expect(paid).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect((paid[0]!.event as { financingType: string }).financingType).toBe('funding-payment');
    expect((received[0]!.event as { incomeType: string }).incomeType).toBe('funding-receipt');
    expectReconciled(result);
  });

  it('fx-forward: marks on the forward series and converts at maturity; the foreign cash is valued through dated quotes', () => {
    const maturity = at(4);
    const result = portfolioBacktest({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 1_000_000 }] },
      instruments: {
        'EURUSD-FWD': {
          kind: 'fx-forward',
          currency: 'USD',
          forward: {
            maturityTimestampMs: maturity,
            baseCurrency: 'EUR',
            quoteCurrency: 'USD',
            contractRate: 1.1,
          },
        },
      },
      marketData: {
        forwardRates: Array.from({ length: 7 }, (_, i) => ({
          instrumentId: 'EURUSD-FWD',
          timestampMs: at(i),
          forwardRate: 1.1 + i * 0.01,
        })),
        fxRates: Array.from({ length: 7 }, (_, i) => ({
          timestampMs: at(i),
          baseCurrency: 'EUR',
          quoteCurrency: 'USD',
          quotePerBase: 1.1 + i * 0.01,
        })),
      },
      strategy: {
        onSession: (c) =>
          c.index === 0
            ? [
                {
                  orderId: 'fwd',
                  instrumentId: 'EURUSD-FWD',
                  side: 'buy',
                  quantity: 100_000,
                  type: 'market',
                  submittedTimestampMs: c.asOf,
                },
              ]
            : [],
      },
    });
    // the forward's cash leg settles at maturity
    expect(result.fills[0]!.settleTimestampMs).toBe(maturity);
    const conversion = result.events.find((e) => e.eventType === 'cash.conversion');
    expect(conversion?.event).toMatchObject({ fromCurrency: 'USD', toCurrency: 'EUR' });
    expect((conversion?.event as { fromAmount: number }).fromAmount).toBeCloseTo(110_000, 6);
    expect((conversion?.event as { toAmount: number }).toAmount).toBeCloseTo(100_000, 6);
    // EUR cash after maturity, valued at the dated quote
    const last = result.valuationMarks[result.valuationMarks.length - 1]!;
    expect(last.currencyConversions?.some((q) => q.baseCurrency === 'EUR')).toBe(true);
    expect(result.finalValue).toBeGreaterThan(1_000_000);
    expectReconciled(result);
  });

  it('bond: accrued interest on the fill, a coupon, and redemption at maturity', () => {
    const maturity = dateOf(at(6));
    const result = portfolioBacktest({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 1_000_000 }] },
      instruments: {
        BOND: {
          kind: 'bond',
          currency: 'USD',
          coupon: {
            annualRate: 0.05,
            paymentsPerYear: 2,
            faceValuePerUnit: 100,
            issueDate: dateOf(at(-100)),
            maturityDate: maturity,
          },
        },
      },
      marketData: {
        bars: bars('BOND', flatPath(8, 99)),
        coupons: [{ instrumentId: 'BOND', paymentDate: dateOf(at(3)), amountPerUnit: 2.5 }],
      },
      strategy: {
        onSession: (c) =>
          c.index === 0
            ? [
                {
                  orderId: 'buy',
                  instrumentId: 'BOND',
                  side: 'buy',
                  quantity: 1000,
                  type: 'market',
                  submittedTimestampMs: c.asOf,
                },
              ]
            : [],
      },
    });
    expect(result.fills[0]!.accruedInterest).toBeGreaterThan(0);
    expect(result.events.some((e) => e.eventType === 'income.received')).toBe(true);
    const redemption = result.events.find((e) => e.eventType === 'fixed-income.redemption');
    expect(redemption?.event).toMatchObject({
      redemptionType: 'maturity',
      quantity: 1000,
      pricePerUnit: 100,
    });
    expectReconciled(result);
  });

  it('custom: a caller adapter proven by the conformance suite runs like a built-in', () => {
    const adapter: InstrumentAdapter = {
      kind: 'index-level',
      version: '1',
      mark: (input) =>
        input.latest.bar === undefined
          ? { unavailable: 'missing' }
          : { pricePerUnit: input.latest.bar.close, source: 'bar.close' },
      lifecycle: () => [],
      fillTerms: () => ({ settlementStyle: 'cash-on-trade' }),
    };
    const specification = { kind: 'custom' as const, currency: 'USD', adapter };
    const verdict = assertInstrumentAdapterConformance({
      adapter,
      fixtures: {
        mark: [
          {
            instrumentId: 'X',
            specification,
            asOf: at(0),
            latest: { bar: bars('X', [10])[0]! },
            previous: null,
          },
        ],
        lifecycle: [
          {
            instrumentId: 'X',
            specification,
            asOf: at(0),
            previousAsOf: null,
            held: { quantity: 1, contractMultiplier: 1 },
            mark: { pricePerUnit: 10, source: 'bar.close' },
            underlyingMark: null,
            facts: { dividends: [], coupons: [], fundingRates: [], corporateActions: [] },
            last: false,
          },
        ],
      },
    });
    expect(verdict).toEqual({ kind: 'index-level', version: '1', marks: 1, lifecycles: 1 });
    const result = portfolioBacktest({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: { X: specification },
      marketData: { bars: bars('X', drift(5, 10, 0.1)) },
      strategy: {
        onSession: (c) =>
          c.index === 0
            ? [
                {
                  orderId: 'buy',
                  instrumentId: 'X',
                  side: 'buy',
                  quantity: 100,
                  type: 'market',
                  submittedTimestampMs: c.asOf,
                },
              ]
            : [],
      },
    });
    expect(result.assumptions.instruments[0]!.adapter).toEqual({
      kind: 'index-level',
      version: '1',
    });
    expect(result.assumptions.replayable).toBe(false);
    expectReconciled(result);
    const bad = { ...adapter, mark: () => ({ pricePerUnit: Number.NaN, source: 'x' }) };
    expect(
      failure(() =>
        assertInstrumentAdapterConformance({
          adapter: bad,
          fixtures: {
            mark: [{ instrumentId: 'X', specification, asOf: at(0), latest: {}, previous: null }],
            lifecycle: [],
          },
        }),
      ).code,
    ).toBe(ErrorCode.BacktestAdapterNonconformant);
    for (const [kind, builtIn] of Object.entries(instrumentAdapters))
      expect(builtIn.kind).toBe(kind);
  });
});

describe('external flows, margin, and refusals', () => {
  it('contributions and withdrawals are flows, never returns; the timeline separates them', () => {
    const result = portfolioBacktest(
      equityRequest({
        externalFlows: [
          { timestampMs: at(2), amount: 50_000, currency: 'USD' },
          { timestampMs: at(5), amount: -20_000, currency: 'USD' },
        ],
      }),
    );
    expect(result.diagnostics.externalFlowCount).toBe(2);
    expect(result.events.filter((e) => e.eventType === 'cash.deposit')).toHaveLength(2);
    expect(result.events.filter((e) => e.eventType === 'cash.withdrawal')).toHaveLength(1);
    expect(result.pnl?.externalFlows).toBeCloseTo(30_000, 6);
    expectReconciled(result);
  });

  it('a maintenance breach warns under forcedLiquidation none, and liquidates under pro-rata and close-largest-loss', () => {
    const margin = (forcedLiquidation: 'none' | 'pro-rata' | 'close-largest-loss') =>
      execution.declared({
        label: `test margin ${forcedLiquidation}`,
        margin: {
          buyingPowerMultiplier: 2,
          initialMarginRate: 0.5,
          maintenanceMarginRate: 0.5,
          forcedLiquidation,
        },
      });
    const request = (
      forcedLiquidation: 'none' | 'pro-rata' | 'close-largest-loss',
    ): PortfolioBacktestRequest => ({
      accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
      instruments: {
        AAA: { kind: 'equity', currency: 'USD' },
        BBB: { kind: 'equity', currency: 'USD' },
      },
      // both fall hard: the equity drops below half the gross notional
      marketData: { bars: [...bars('AAA', drift(6, 100, -8)), ...bars('BBB', drift(6, 100, -12))] },
      execution: margin(forcedLiquidation),
      strategy: {
        onSession: (c) =>
          c.index === 0
            ? [
                {
                  orderId: 'a',
                  instrumentId: 'AAA',
                  side: 'buy',
                  quantity: 900,
                  type: 'market',
                  submittedTimestampMs: c.asOf,
                },
                {
                  orderId: 'b',
                  instrumentId: 'BBB',
                  side: 'buy',
                  quantity: 900,
                  type: 'market',
                  submittedTimestampMs: c.asOf,
                },
              ]
            : [],
      },
    });
    const none = portfolioBacktest(request('none'));
    expect(none.liquidations).toEqual([]);
    expect(none.diagnostics.warnings.some((w) => w.code === 'backtest.margin_breach')).toBe(true);
    const proRata = portfolioBacktest(request('pro-rata'));
    expect(proRata.liquidations.length).toBeGreaterThan(0);
    expect(proRata.liquidations[0]!.policy).toBe('pro-rata');
    expect(proRata.orders.some((o) => o.source === 'liquidation')).toBe(true);
    expectReconciled(proRata);
    const largest = portfolioBacktest(request('close-largest-loss'));
    expect(largest.liquidations[0]!.instrumentId).toBe('BBB');
    expect(largest.liquidations[0]!.code).toBe('backtest.forced_liquidation');
    expectReconciled(largest);
  });

  it('teaches on every malformed request', () => {
    const base = equityRequest();
    const bad =
      (patch: Record<string, unknown>): (() => unknown) =>
      () =>
        portfolioBacktest({ ...base, ...patch } as never);
    expect(
      failure(
        bad({ accounting: { baseCurrency: 'usd', initialCash: [{ currency: 'USD', amount: 1 }] } }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(failure(bad({ accounting: { baseCurrency: 'USD', initialCash: [] } })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(failure(bad({ instruments: {} })).code).toBe(ErrorCode.InputOutOfRange);
    expect(failure(bad({ instruments: { AAA: { kind: 'option', currency: 'USD' } } })).code).toBe(
      ErrorCode.InputMissingField,
    );
    expect(
      failure(
        bad({
          instruments: {
            AAA: { kind: 'equity', currency: 'USD', adapter: instrumentAdapters.equity },
          },
        }),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(failure(bad({ instruments: { AAA: { kind: 'custom', currency: 'USD' } } })).code).toBe(
      ErrorCode.InputMissingField,
    );
    expect(failure(bad({ instruments: { AAA: { kind: 'equity', currency: 'EUR' } } })).code).toBe(
      ErrorCode.InputMissingField,
    );
    expect(failure(bad({ strategy: { model: [], schedule: { frequency: 'monthly' } } })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      failure(
        bad({
          strategy: {
            model: base.strategy && 'model' in base.strategy ? base.strategy.model : [],
            schedule: { frequency: 'yearly' },
          },
        }),
      ).code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(failure(bad({ strategy: { onSession: () => [], model: [] } })).code).toBe(
      ErrorCode.InputUnknownField,
    );
    expect(failure(bad({ calendar: 'XNYS' })).code).toBe(ErrorCode.InputInvalidEnum);
    expect(failure(bad({ window: { fromTimestampMs: at(5), toTimestampMs: at(1) } })).code).toBe(
      ErrorCode.InputOutOfRange,
    );
    expect(
      failure(bad({ externalFlows: [{ timestampMs: at(1), amount: 0, currency: 'USD' }] })).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(
        bad({
          marketData: {
            bars: bars('AAA', [100]),
            dividends: [{ instrumentId: 'AAA', exDate: 'soon', amount: 1 }],
          },
        }),
      ).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(failure(bad({ periodsPerYear: -1 })).code).toBe(ErrorCode.InputOutOfRange);
    expect(failure(bad({ extra: true })).code).toBe(ErrorCode.InputUnknownField);
    // a held instrument without a mark is a typed refusal, never a guess: the option's contract
    // vanishes from the next chain snapshot
    const expiry = dateOf(at(10));
    const terms = {
      kind: 'option' as const,
      underlyingInstrumentId: 'AAA',
      type: 'call' as const,
      strikePricePerUnit: 100,
      expiryTimestampMs: resolvedExpiry(expiry).expiresAt,
    };
    const quote = (i: number) => ({
      contract: {
        underlying: 'AAA',
        type: 'call' as const,
        style: 'european' as const,
        strike: 100,
        expiry,
        ...resolvedExpiry(expiry),
        multiplier: 100,
      },
      timestampMs: at(i),
      mid: 2,
      impliedVolatility: 0.2,
      underlyingPrice: 100,
    });
    expect(
      failure(() =>
        portfolioBacktest({
          accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
          instruments: {
            AAA: { kind: 'equity', currency: 'USD' },
            'AAA C100': {
              kind: 'option',
              currency: 'USD',
              contractMultiplier: 100,
              contract: terms,
            },
          },
          marketData: {
            bars: bars('AAA', [100, 100, 100]),
            optionChains: [
              { asOf: at(0), underlyingPrice: 100, quotes: [quote(0)] },
              { asOf: at(1), underlyingPrice: 100, quotes: [quote(1)] },
              { asOf: at(2), underlyingPrice: 100, quotes: [] },
            ],
          },
          strategy: {
            onSession: (c) =>
              c.index === 0
                ? [
                    {
                      orderId: 'buy',
                      instrumentId: 'AAA C100',
                      side: 'buy',
                      quantity: 1,
                      type: 'market',
                      submittedTimestampMs: c.asOf,
                    },
                  ]
                : [],
          },
        }),
      ).code,
    ).toBe(ErrorCode.BacktestMarkUnavailable);
    // the hardened helper boundaries (enforcement 2026-09-04: three defective rows → zero)
    const couponTerms = {
      annualRate: 0.05,
      paymentsPerYear: 2,
      faceValuePerUnit: 100,
      issueDate: '2025-07-01',
      maturityDate: '2027-07-01',
    };
    expect(
      failure(() => accruedFromTerms({ ...couponTerms, extra: 1 } as never, Date.UTC(2026, 0, 2)))
        .code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() =>
        accruedFromTerms({ ...couponTerms, annualRate: 'high' } as never, Date.UTC(2026, 0, 2)),
      ).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(failure(() => accruedFromTerms(couponTerms, Number.NaN)).code).toBe(
      ErrorCode.InputNotFinite,
    );
    expect(failure(() => adapterFor('', { kind: 'equity', currency: 'USD' })).code).toBe(
      ErrorCode.InputWrongType,
    );
    expect(
      failure(() => adapterFor('AAA', { kind: 'equity', currency: 'USD', bogus: 1 } as never)).code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() =>
        assertInstrumentAdapterConformance({
          adapter: instrumentAdapters.equity,
          fixtures: { mark: [], lifecycle: [] },
          extra: true,
        } as never),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() =>
        assertInstrumentAdapterConformance({
          adapter: { ...instrumentAdapters.equity, accrued: 1 } as never,
          fixtures: { mark: [], lifecycle: [] },
        }),
      ).code,
    ).toBe(ErrorCode.InputWrongType);
    expect(
      failure(() =>
        assertInstrumentAdapterConformance({
          adapter: instrumentAdapters.equity,
          fixtures: { mark: 'none', lifecycle: [] } as never,
        }),
      ).code,
    ).toBe(ErrorCode.InputWrongType);
  });
});
