/**
 * Stage 4.6 slice 6 — the cross-engine property laws: no look-ahead (a fact dated after a decision
 * instant changes nothing before it; a later restatement never reaches an earlier decision),
 * permutation invariance (shuffled input rows → byte-identical results), the simplified execution
 * policy named in every result, and the FC7 replay law (the emitted events fold to the reported
 * state) — over the cross-sectional, options, and portfolio engines.
 */
import { describe, expect, it } from 'vitest';
import {
  isoDateToEpochMs,
  resolvedExpiry,
  type Bar,
  usEquitySessionInstant,
  optionExpiryToMs,
} from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import { applyPortfolioEvents, portfolioSnapshot } from '@totalfinance/portfolio';
import type { OptionQuote } from '@totalfinance/core';
import type {
  FieldDefinition,
  ReturnObservation,
  UniverseObservation,
} from '@totalfinance/research';
import { crossSectionalBacktest, type CrossSectionalBacktestRequest } from '@totalfinance/backtest';
import { optionsBacktest, type ChainSnapshot } from '@totalfinance/backtest/options';
import { portfolioBacktest, type PortfolioBacktestRequest } from '@totalfinance/backtest/portfolio';

const DAY = 86_400_000;

/** A seeded shuffle (deterministic, so the suite is itself replayable). */
function shuffled<T>(rows: readonly T[], seed: number): T[] {
  const out = [...rows];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ── cross-sectional ─────────────────────────────────────────────────────────────────────────────
const XS_NAMES = ['AAA', 'BBB', 'CCC', 'DDD'] as const;
const xsSessions = (count: number): string[] =>
  Array.from({ length: count }, (_, i) =>
    new Date(Date.UTC(2026, 0, 2) + i * 7 * DAY).toISOString().slice(0, 10),
  );
const xsReturns = (dates: readonly string[]): ReturnObservation[] =>
  XS_NAMES.flatMap((instrumentId, n) =>
    dates.map((tradingSessionDate, i) => ({
      instrumentId,
      tradingSessionDate,
      simpleReturn: (2 - n) * 0.01 + (i % 3) * 0.002,
    })),
  );
const xsObservations = (available: number, quality: readonly number[]): UniverseObservation[] =>
  XS_NAMES.map((instrumentId, n) => ({
    instrumentId,
    availableTimestampMs: available,
    fields: { quality: quality[n]! },
  }));
const fieldDefinitions: FieldDefinition[] = [{ fieldName: 'quality', kind: 'numeric' }];
const xsRequest = (
  observations: UniverseObservation[],
  sessions = 12,
): CrossSectionalBacktestRequest => ({
  dataset: { observations, fieldDefinitions, returns: xsReturns(xsSessions(sessions)) },
  universeHistory: {
    universeId: 'props',
    members: XS_NAMES.map((instrumentId) => ({
      instrumentId,
      fromTimestampMs: Date.UTC(2026, 0, 1),
    })),
  },
  signal: {
    score: {
      components: [
        { field: 'quality', weight: 1, direction: 'higher-is-better', standardization: 'z-score' },
      ],
      missingValuePolicy: 'exclude',
    },
  },
  rebalanceSchedule: { frequency: 'monthly', session: 'close' },
  portfolioConstruction: { method: 'equal-weight', long: { count: 2 } },
  initialCapital: 100_000,
});

// ── options ──────────────────────────────────────────────────────────────────────────────────────
const START = '2026-01-05';
const addDays = (start: string, days: number): string =>
  new Date(isoDateToEpochMs(start) + days * DAY).toISOString().slice(0, 10);
/** End-of-day chains are observed at the close; expiries settle at their own close instant. */
const instantOf = (date: string): number => usEquitySessionInstant(date, 'close');
function chain(date: string, spot: number, expiries: readonly string[]): ChainSnapshot {
  const ts = instantOf(date);
  const quotes: OptionQuote[] = [];
  for (const expiry of expiries) {
    const t = (optionExpiryToMs(expiry) - ts) / (DAY * 365);
    if (t <= 0) continue;
    for (let k = 80; k <= 120; k += 5) {
      for (const type of ['call', 'put'] as const) {
        quotes.push({
          contract: {
            underlying: 'XYZ',
            type,
            style: 'european',
            strike: k,
            expiry,
            ...resolvedExpiry(expiry),
            multiplier: 100,
          },
          timestampMs: ts,
          mid: blackScholesPrice({
            type,
            spot,
            strike: k,
            timeToExpiryYears: t,
            riskFreeRate: 0.04,
            dividendYield: 0,
            volatility: 0.2,
          }),
          impliedVolatility: 0.2,
          greeks: {
            delta: blackScholesGreeks({
              type,
              spot,
              strike: k,
              timeToExpiryYears: t,
              riskFreeRate: 0.04,
              dividendYield: 0,
              volatility: 0.2,
            }).delta,
          },
          underlyingPrice: spot,
        });
      }
    }
  }
  return { asOf: ts, underlyingPrice: spot, quotes };
}
const chains = (): ChainSnapshot[] =>
  Array.from({ length: 8 }, (_, i) =>
    chain(addDays(START, i * 7), 100, [addDays(START, 49), addDays(START, 84)]),
  );
const optionsConfig = (snapshots: ChainSnapshot[]) => ({
  chains: snapshots,
  riskFreeRate: 0.04,
  entry: {
    daysToExpiry: { target: 45, min: 30, max: 60 },
    structure: 'bullPutSpread' as const,
    select: { shortDelta: 0.3, width: 5 },
  },
  exit: { profitTarget: 0.5, daysToExpiry: 21 },
});

// ── portfolio ────────────────────────────────────────────────────────────────────────────────────
const at = (day: number): number => isoDateToEpochMs(START) + day * DAY + 21 * 3_600_000;
const bars = (symbol: string, spots: readonly number[]): Bar[] =>
  spots.map((close, i) => ({
    symbol,
    timestampMs: at(i),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1e6,
  }));
const portfolioRequest = (
  marketData: PortfolioBacktestRequest['marketData'],
): PortfolioBacktestRequest => ({
  accounting: { baseCurrency: 'USD', initialCash: [{ currency: 'USD', amount: 100_000 }] },
  instruments: {
    AAA: { kind: 'equity', currency: 'USD' },
    BBB: { kind: 'equity', currency: 'USD' },
  },
  marketData,
  strategy: {
    model: [
      { group: { instrumentId: 'AAA' }, weight: 0.4 },
      { group: { instrumentId: 'BBB' }, weight: 0.4 },
      { group: { assetClass: 'cash' }, weight: 0.2 },
    ],
    schedule: { frequency: 'weekly' },
  },
});
const portfolioData = (): PortfolioBacktestRequest['marketData'] => ({
  bars: [
    ...bars('AAA', [100, 101, 102, 103, 104, 105, 106, 107]),
    ...bars('BBB', [50, 50.5, 51, 51.5, 52, 52.5, 53, 53.5]),
  ],
  dividends: [{ instrumentId: 'AAA', exDate: addDays(START, 3), amount: 0.25 }],
});

describe('no look-ahead', () => {
  it('cross-sectional: a feature published after a decision instant is invisible to it, and a later restatement never reaches an earlier decision', () => {
    const before = xsRequest(xsObservations(Date.UTC(2026, 0, 1), [4, 3, 2, 1]));
    const base = crossSectionalBacktest(before);
    // the same features published one week after the first rebalance: the first decision cannot see them
    const late = crossSectionalBacktest(
      xsRequest(xsObservations(Date.UTC(2026, 0, 10), [4, 3, 2, 1])),
    );
    expect(late.rebalances[0]!.scoredCount).toBe(0);
    expect(base.rebalances[0]!.scoredCount).toBe(4);
    // a restatement (the same names re-published later with different values) changes only decisions after its availability
    const restated = crossSectionalBacktest(
      xsRequest([
        ...xsObservations(Date.UTC(2026, 0, 1), [4, 3, 2, 1]),
        ...xsObservations(Date.UTC(2026, 1, 3), [1, 2, 3, 4]),
      ]),
    );
    expect(
      restated.holdings.filter((h) => h.rebalanceIndex === 0).map((h) => h.instrumentId),
    ).toEqual(base.holdings.filter((h) => h.rebalanceIndex === 0).map((h) => h.instrumentId));
    expect(
      restated.holdings.filter((h) => h.rebalanceIndex === 1).map((h) => h.instrumentId),
    ).not.toEqual(base.holdings.filter((h) => h.rebalanceIndex === 1).map((h) => h.instrumentId));
  });

  it('portfolio: a dividend dated after the last instant, or a bar after the window, changes nothing', () => {
    const base = portfolioBacktest(portfolioRequest(portfolioData()));
    const future = portfolioBacktest(
      portfolioRequest({
        ...portfolioData(),
        dividends: [
          { instrumentId: 'AAA', exDate: addDays(START, 3), amount: 0.25 },
          { instrumentId: 'AAA', exDate: addDays(START, 30), amount: 5 },
        ],
      }),
    );
    expect(future.finalValue).toBe(base.finalValue);
    expect(future.events.length).toBe(base.events.length);
    const windowed = portfolioBacktest({
      ...portfolioRequest({
        ...portfolioData(),
        bars: [
          ...portfolioData().bars!,
          ...bars('AAA', [1, 1]).map((b, i) => ({ ...b, timestampMs: at(20 + i) })),
        ],
      }),
      window: { toTimestampMs: at(7) },
    });
    expect(windowed.finalValue).toBe(base.finalValue);
    expect(windowed.diagnostics.sessionCount).toBe(base.diagnostics.sessionCount);
  });
});

describe('permutation invariance', () => {
  it('cross-sectional: shuffled observations and returns give a byte-identical run', () => {
    const request = xsRequest(xsObservations(Date.UTC(2026, 0, 1), [4, 3, 2, 1]));
    const base = crossSectionalBacktest(request);
    const permuted = crossSectionalBacktest({
      ...request,
      dataset: {
        ...request.dataset,
        observations: shuffled(request.dataset.observations, 7),
        returns: shuffled(request.dataset.returns, 11),
      },
      universeHistory: {
        ...request.universeHistory,
        members: shuffled(request.universeHistory.members, 3),
      },
    });
    expect(canonicalJsonOf(permuted)).toBe(canonicalJsonOf(base));
  });

  it('options: shuffled chain snapshots and quotes give a byte-identical run', () => {
    const base = optionsBacktest(optionsConfig(chains()));
    const permuted = optionsBacktest(
      optionsConfig(
        shuffled(chains(), 5).map((snap) => ({ ...snap, quotes: shuffled(snap.quotes, 9) })),
      ),
    );
    expect(canonicalJsonOf(permuted)).toBe(canonicalJsonOf(base));
  });

  it('portfolio: shuffled bars and dividends give a byte-identical run', () => {
    const data = portfolioData();
    const base = portfolioBacktest(portfolioRequest(data));
    const permuted = portfolioBacktest(
      portfolioRequest({ bars: shuffled(data.bars!, 13), dividends: shuffled(data.dividends!, 2) }),
    );
    expect(canonicalJsonOf(permuted)).toBe(canonicalJsonOf(base));
  });
});

describe('the execution policy is named, and the events fold back', () => {
  it('every engine names the simplified default and its label', () => {
    const xs = crossSectionalBacktest(
      xsRequest(xsObservations(Date.UTC(2026, 0, 1), [4, 3, 2, 1])),
    );
    const op = optionsBacktest(optionsConfig(chains()));
    const pf = portfolioBacktest(portfolioRequest(portfolioData()));
    // The cross-sectional and portfolio engines fill through the execution layer and echo its description.
    for (const description of [xs.assumptions.execution, pf.assumptions.execution]) {
      expect(description.realism).toBe('simplified');
      expect(description.label.length).toBeGreaterThan(0);
    }
    // The options engine fills through its own declared fill policy and names it with its price source.
    expect(op.assumptions.fillPolicy).toEqual({
      mode: 'combo',
      partialFill: 'reject',
      price: 'mid',
    });
    expect(op.assumptions.priceSource).toBe('mid');
    expect(op.assumptions.commission).toBe('none');
    expect(op.assumptions.slippage).toBe('none');
  });

  it('the emitted events fold to the reported equity (the FC7 replay law), every engine', () => {
    const xs = crossSectionalBacktest(
      xsRequest(xsObservations(Date.UTC(2026, 0, 1), [4, 3, 2, 1])),
    );
    expect(Math.abs(xs.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-9);
    const op = optionsBacktest(optionsConfig(chains()));
    expect(Math.abs(op.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-9);
    const pf = portfolioBacktest(portfolioRequest(portfolioData()));
    const state = applyPortfolioEvents({
      portfolio: { baseCurrency: 'USD', lotRelief: pf.assumptions.lotRelief },
      events: pf.events,
    });
    const last = pf.valuationMarks[pf.valuationMarks.length - 1]!;
    expect(
      portfolioSnapshot({
        portfolio: state,
        asOf: isoDateToEpochMs(last.valuationDate),
        market: last.market,
      }).netAssetValue,
    ).toBeCloseTo(pf.finalValue, 9);
  });
});
