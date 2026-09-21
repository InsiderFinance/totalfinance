/**
 * Preview P1 — marking truthfulness (`docs/specs/options-backtest.md`, "Preview P1 amendment"): open
 * legs re-mark from the exact current-snapshot contract quote; a missing mark is a typed failure by
 * default or a named, counted fallback; the policy is echoed; the fixtures the gate names.
 */

import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  isoDateToEpochMs,
  isQuantError,
  optionExpiryToMs,
  resolvedExpiry,
  usEquitySessionInstant,
} from '@totalfinance/core';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import type { OptionQuote } from '@totalfinance/core';
import { optionsBacktest, type ChainSnapshot } from '@totalfinance/backtest/options';

const DAY = 86_400_000;

function codeOf(
  fn: () => unknown,
): { code: string; message: string; context: unknown } | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (isQuantError(error))
      return { code: error.code, message: error.message, context: error.context };
    throw error;
  }
}

function addDays(start: string, days: number): string {
  return new Date(isoDateToEpochMs(start) + days * DAY).toISOString().slice(0, 10);
}
/** End-of-day chains are observed at the close; expiries settle at their own close instant. */
const instantOf = (date: string): number => usEquitySessionInstant(date, 'close');

function quote(
  date: string,
  spot: number,
  type: 'call' | 'put',
  strike: number,
  expiry: string,
  vol: number,
  options: { impliedVolatility?: boolean; timestampMs?: number; priceOverride?: number } = {},
): OptionQuote {
  // Price at the contract's expiry INSTANT so a price-implied volatility round-trips exactly.
  const t = (optionExpiryToMs(expiry) - instantOf(date)) / (365 * DAY);
  const common = {
    type,
    spot,
    strike,
    timeToExpiryYears: t,
    riskFreeRate: 0.04,
    dividendYield: 0,
    volatility: vol,
  };
  return {
    contract: {
      underlying: 'XYZ',
      type,
      style: 'european',
      strike,
      expiry,
      ...resolvedExpiry(expiry),
      multiplier: 100,
    },
    timestampMs: options.timestampMs ?? instantOf(date),
    mid: options.priceOverride ?? blackScholesPrice(common),
    ...(options.impliedVolatility === false ? {} : { impliedVolatility: vol }),
    greeks: { delta: blackScholesGreeks(common).delta },
    underlyingPrice: spot,
  };
}

function chain(
  date: string,
  spot: number,
  expiry: string,
  vol: number,
  options: {
    impliedVolatility?: boolean;
    omit?: (type: string, strike: number) => boolean;
    duplicate?: (type: string, strike: number) => boolean;
    timestampMs?: number;
    priceAboveBound?: (type: string, strike: number) => boolean;
  } = {},
): ChainSnapshot {
  const quotes: OptionQuote[] = [];
  for (let k = 75; k <= 125; k += 5) {
    for (const type of ['call', 'put'] as const) {
      if (options.omit?.(type, k)) continue;
      const q = quote(date, spot, type, k, expiry, vol, {
        ...(options.impliedVolatility === false ? { impliedVolatility: false } : {}),
        ...(options.timestampMs !== undefined ? { timestampMs: options.timestampMs } : {}),
        ...(options.priceAboveBound?.(type, k)
          ? { priceOverride: k + 1, impliedVolatility: false } // above any no-arbitrage bound
          : {}),
      });
      quotes.push(q);
      if (options.duplicate?.(type, k)) quotes.push({ ...q });
    }
  }
  return { asOf: instantOf(date), underlyingPrice: spot, quotes };
}

const START = '2026-01-05';
const EXPIRY = addDays(START, 45);
const ENTRY = {
  when: 'flat' as const,
  daysToExpiry: { target: 45, min: 30, max: 60 },
  structure: 'bullPutSpread' as const,
  select: { shortDelta: 0.3, width: 5 },
};
const EXIT = { profitTarget: 0.9, daysToExpiry: 1 };

describe('Preview P1 — current-quote marking', () => {
  it('fixture 1: unchanged spot and time, implied volatility 0.20 → 0.25 — the mark change is the exact direct-pricer vega P&L and the explain carries a live vega', () => {
    const snap1 = chain(START, 100, EXPIRY, 0.2);
    const snap2 = chain(START, 100, EXPIRY, 0.25); // same asOf, same spot: only volatility moved
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains: [snap1, snap2],
      initialCapital: 100_000,
      entry: ENTRY,
      exit: EXIT,
    });
    expect(result.assumptions.marking).toEqual({
      volatility: 'current-quote',
      missingMark: 'refuse',
      maximumQuoteAgeMs: null,
    });
    const trade = result.trades[0]!;
    expect(trade.marks.snapshots).toBe(2);
    expect(trade.marks.currentQuote).toBe(4); // two legs × two snapshots
    expect(trade.marks.entryVolatility + trade.marks.carried + trade.marks.impliedFromPrice).toBe(
      0,
    );
    expect(trade.exitVolatilities).toEqual([0.25, 0.25]);
    // Exact direct-pricer vega: Σ quantity × multiplier × (BS(σ=0.25) − BS(σ=0.20)) at the same spot/time.
    // The engine prices at the contract's expiry INSTANT (16:00 ET), the one expiry law.
    const t = (optionExpiryToMs(EXPIRY) - instantOf(START)) / (365 * DAY);
    const expected = trade.legs.reduce((sum, leg) => {
      if (leg.kind !== 'call' && leg.kind !== 'put') return sum;
      const type = leg.kind;
      const price = (volatility: number) =>
        blackScholesPrice({
          type,
          spot: 100,
          strike: leg.strike,
          timeToExpiryYears: t,
          riskFreeRate: 0.04,
          dividendYield: 0,
          volatility,
        });
      return sum + leg.quantity * 100 * (price(0.25) - price(0.2));
    }, 0);
    // The last equity point moves from the previous one by exactly that amount (no time, no spot, no costs).
    const equity = result.points.map((point) => point.equity);
    expect(equity.at(-1)! - equity.at(-2)!).toBeCloseTo(expected, 6);
    expect(trade.pnlExplain.vega).not.toBe(0);
    expect(Math.abs(trade.pnlExplain.delta)).toBeLessThan(1e-9);
    expect(Math.abs(trade.pnlExplain.theta)).toBeLessThan(1e-9);
  });

  it('fixture 2: on a constant-volatility chain the current-quote and entry policies mark identically', () => {
    const chains = [0, 7, 14, 21, 28].map((d) =>
      chain(addDays(START, d), 100 + d / 7, EXPIRY, 0.2),
    );
    const current = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      initialCapital: 100_000,
      entry: ENTRY,
      exit: EXIT,
    });
    const entry = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      initialCapital: 100_000,
      entry: ENTRY,
      exit: EXIT,
      marking: { volatility: 'entry' },
    });
    expect(current.points.map((p) => p.equity)).toEqual(entry.points.map((p) => p.equity));
    expect(current.trades.map((t) => t.realizedPnl)).toEqual(
      entry.trades.map((t) => t.realizedPnl),
    );
    expect(entry.assumptions.marking.volatility).toBe('entry');
    expect(entry.trades[0]!.marks.currentQuote).toBe(0);
    expect(current.trades[0]!.marks.currentQuote).toBeGreaterThan(0);
  });

  it('fixture 3: a missing contract refuses by default with the leg, snapshot, and cause; each named fallback runs, counts, and warns once', () => {
    const snap1 = chain(START, 100, EXPIRY, 0.2);
    const first = optionsBacktest({
      riskFreeRate: 0.04,
      chains: [snap1],
      initialCapital: 100_000,
      entry: ENTRY,
      exit: EXIT,
    });
    const shortStrike = first.trades[0]!.legs.find((l) => l.quantity < 0)!.strike;
    const snap2 = chain(addDays(START, 7), 100, EXPIRY, 0.2, {
      omit: (type, k) => type === 'put' && k === shortStrike,
    });
    const snap3 = chain(addDays(START, 14), 100, EXPIRY, 0.2);
    const refused = codeOf(() =>
      optionsBacktest({
        riskFreeRate: 0.04,
        chains: [snap1, snap2, snap3],
        initialCapital: 100_000,
        entry: ENTRY,
        exit: EXIT,
      }),
    );
    expect(refused?.code).toBe(ErrorCode.BacktestMarkUnavailable);
    expect(refused?.message).toContain(`put ${shortStrike}`);
    expect(refused?.message).toContain('no quote for this contract');
    expect(refused?.context).toMatchObject({
      cause: 'missing',
      asOf: instantOf(addDays(START, 7)),
      missingMark: 'refuse',
    });

    const fallback = optionsBacktest({
      riskFreeRate: 0.04,
      chains: [snap1, snap2, snap3],
      initialCapital: 100_000,
      entry: ENTRY,
      exit: EXIT,
      marking: { missingMark: 'entry-volatility' },
    });
    expect(fallback.trades[0]!.marks.entryVolatility).toBe(1);
    expect(fallback.trades[0]!.marks.currentQuote).toBe(5);
    const warnings = fallback.diagnostics.warnings.filter(
      (w) => w.code === 'backtest.mark_fallback',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.severity).toBe('warn');
    expect(warnings[0]!.context).toMatchObject({
      cause: 'missing',
      legSnapshots: 1,
      missingMark: 'entry-volatility',
    });

    const carried = optionsBacktest({
      riskFreeRate: 0.04,
      chains: [snap1, snap2, snap3],
      initialCapital: 100_000,
      entry: ENTRY,
      exit: EXIT,
      marking: { missingMark: 'carry-last-volatility' },
    });
    expect(carried.trades[0]!.marks.carried).toBe(1);
    expect(carried.assumptions.marking.missingMark).toBe('carry-last-volatility');
  });

  it('fixture 4: ambiguous, stale, and unpriceable contracts refuse with their cause', () => {
    const snap1 = chain(START, 100, EXPIRY, 0.2);
    const first = optionsBacktest({
      riskFreeRate: 0.04,
      chains: [snap1],
      initialCapital: 100_000,
      entry: ENTRY,
      exit: EXIT,
    });
    const shortStrike = first.trades[0]!.legs.find((l) => l.quantity < 0)!.strike;
    const run = (snap2: ChainSnapshot, marking?: { maximumQuoteAgeMs?: number }) =>
      codeOf(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains: [snap1, snap2],
          initialCapital: 100_000,
          entry: ENTRY,
          exit: EXIT,
          ...(marking ? { marking } : {}),
        }),
      );
    const ambiguous = run(
      chain(addDays(START, 7), 100, EXPIRY, 0.2, {
        duplicate: (type, k) => type === 'put' && k === shortStrike,
      }),
    );
    expect(ambiguous?.code).toBe(ErrorCode.BacktestMarkUnavailable);
    expect(ambiguous?.context).toMatchObject({ cause: 'ambiguous' });
    const stale = run(
      chain(addDays(START, 7), 100, EXPIRY, 0.2, { timestampMs: instantOf(START) }),
      { maximumQuoteAgeMs: DAY },
    );
    expect(stale?.context).toMatchObject({ cause: 'stale' });
    // Without a threshold the same aged quotes are current by the snapshot's definition.
    expect(
      run(chain(addDays(START, 7), 100, EXPIRY, 0.2, { timestampMs: instantOf(START) })),
    ).toBeUndefined();
    const unpriceable = run(
      chain(addDays(START, 7), 100, EXPIRY, 0.2, {
        priceAboveBound: (type, k) => type === 'put' && k === shortStrike,
      }),
    );
    expect(unpriceable?.context).toMatchObject({ cause: 'unpriceable' });
  });

  it('fixture 5: a delta-only feed re-marks from current prices, and a price-driven volatility change moves the mark', () => {
    const snap1 = chain(START, 100, EXPIRY, 0.2, { impliedVolatility: false });
    const snap2 = chain(START, 100, EXPIRY, 0.25, { impliedVolatility: false });
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains: [snap1, snap2],
      initialCapital: 100_000,
      entry: ENTRY,
      exit: EXIT,
    });
    const trade = result.trades[0]!;
    expect(trade.marks.impliedFromPrice).toBe(4);
    expect(trade.marks.currentQuote).toBe(0);
    for (const v of trade.exitVolatilities) expect(v).toBeCloseTo(0.25, 6);
    expect(result.points.at(-1)!.equity).not.toBe(result.points.at(-2)!.equity);
  });

  it('fixture 6: the policy is a closed request member and the function identity is unchanged', () => {
    const snap1 = chain(START, 100, EXPIRY, 0.2);
    expect(
      codeOf(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains: [snap1],
          entry: ENTRY,
          exit: EXIT,
          marking: { volatility: 'mid' } as never,
        }),
      )?.code,
    ).toBe(ErrorCode.InputInvalidEnum);
    expect(
      codeOf(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains: [snap1],
          entry: ENTRY,
          exit: EXIT,
          marking: { volatility: 'entry', extra: 1 } as never,
        }),
      )?.code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      codeOf(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains: [snap1],
          entry: ENTRY,
          exit: EXIT,
          marking: { maximumQuoteAgeMs: -1 },
        }),
      )?.code,
    ).toBeDefined();
    expect(typeof optionsBacktest).toBe('function');
  });
});
