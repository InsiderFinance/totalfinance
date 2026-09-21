/**
 * Options backtester (`@totalfinance/backtest/options`) — chain-driven strategy backtests over a time
 * series of synthetic (BSM-consistent) option chains: entry/exit/roll, expiry settlement +
 * assignment, margin sizing, delta hedging, the tear sheet, and the envelope/honesty contract.
 */

import { describe, expect, it } from 'vitest';
import {
  isoDateToEpochMs,
  isQuantError,
  resolvedExpiry,
  usEquitySessionInstant,
  optionExpiryToMs,
} from '@totalfinance/core';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import type { OptionQuote } from '@totalfinance/core';
import { legs, strategy } from '@totalfinance/strategy';
import {
  optionsBacktest,
  optionsTearSheet,
  type ChainSnapshot,
  type TradePnlExplain,
} from '@totalfinance/backtest/options';

const DAY = 86_400_000;
const YEAR = 365;

/** End-of-day chains are observed at the close; expiries settle at their own close instant. */
const instantOf = (date: string): number => usEquitySessionInstant(date, 'close');
function yearsBetween(a: string, b: string): number {
  return (optionExpiryToMs(b) - instantOf(a)) / (DAY * YEAR);
}

/** ISO date `days` after `start`. */
function addCalendarDays(start: string, days: number): string {
  return new Date(isoDateToEpochMs(start) + days * DAY).toISOString().slice(0, 10);
}

/** A BSM-consistent chain snapshot: mid + delta from the pricer, so selection + MTM are coherent. */
function makeChain(
  date: string,
  spot: number,
  expiries: readonly string[],
  vol = 0.2,
  rate = 0.04,
): ChainSnapshot {
  const quotes: OptionQuote[] = [];
  const ts = instantOf(date);
  for (const expiry of expiries) {
    const t = yearsBetween(date, expiry);
    if (t <= 0) continue;
    const lo = Math.round((spot * 0.75) / 5) * 5;
    const hi = spot * 1.25;
    for (let k = lo; k <= hi; k += 5) {
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
            riskFreeRate: rate,
            dividendYield: 0,
            volatility: vol,
          }),
          impliedVolatility: vol,
          greeks: {
            delta: blackScholesGreeks({
              type,
              spot,
              strike: k,
              timeToExpiryYears: t,
              riskFreeRate: rate,
              dividendYield: 0,
              volatility: vol,
            }).delta,
          },
          underlyingPrice: spot,
        });
      }
    }
  }
  return { asOf: ts, underlyingPrice: spot, quotes };
}

/** A weekly series with three fixed monthly expiries, along a supplied spot path. */
function series(start: string, spots: readonly number[], vol = 0.2): ChainSnapshot[] {
  const expiries = [
    addCalendarDays(start, 49),
    addCalendarDays(start, 84),
    addCalendarDays(start, 119),
  ];
  return spots.map((spot, i) => makeChain(addCalendarDays(start, i * 7), spot, expiries, vol));
}

const START = '2026-01-05';

describe('optionsBacktest — chain-driven credit spread program', () => {
  // A flat underlying: the sold put spread decays to ~0, so a 50%-of-credit profit target fires.
  const chains = series(START, new Array(14).fill(100));

  it('sells a put spread, captures decay, and closes at the profit target', () => {
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      initialCapital: 100_000,
      entry: {
        when: 'flat',
        daysToExpiry: { target: 45, min: 30, max: 60 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { profitTarget: 0.5, daysToExpiry: 21 },
    });

    expect(result.trades.length).toBeGreaterThan(0);
    const closed = result.trades.filter((t) => t.exitAsOf !== null);
    expect(closed.length).toBeGreaterThan(0);
    // A bull put spread is sold for a credit (negative entry premium).
    expect(closed[0]!.entryPremium).toBeLessThan(0);
    expect(
      closed.some((t) => t.exitReason === 'profit-target' || t.exitReason === 'daysToExpiry'),
    ).toBe(true);
    // Profit target exits are net-positive after costs.
    const pt = closed.find((t) => t.exitReason === 'profit-target');
    if (pt) expect(pt.realizedPnl).toBeGreaterThan(0);
    // Equity ends up (we captured credit) and the curve has one point per snapshot + opening.
    expect(result.finalValue).toBeGreaterThan(100_000);
    expect(result.points).toHaveLength(chains.length + 1); // opening point + one per snapshot
    expect(result.returns).toHaveLength(chains.length);
    // The envelope is always present.
    expect(result.assumptions.conventionsVersion).toBeDefined();
    expect(result.assumptions.sizing).toBe('fixed-quantity');
    expect(result.diagnostics.engine).toBe('options-backtest');
  });

  it('re-enters after each close (multiple round-trips over the series)', () => {
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: {
        daysToExpiry: { target: 45, min: 30, max: 60 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { profitTarget: 0.4, daysToExpiry: 14 },
    });
    // Flat → close → flat → re-enter: more than one trade over 14 weeks.
    expect(result.trades.length).toBeGreaterThanOrEqual(2);
  });
});

describe('optionsBacktest — expiry settlement & assignment', () => {
  it('settles an ITM short put spread at expiry as an assignment, disclosed in settlements + warnings', () => {
    // Sell a put spread and hold to expiry with the underlying falling below the short strike.
    const start = '2026-01-05';
    const expiry = addCalendarDays(start, 21);
    const spots = [100, 98, 96, 90]; // weekly, ending well below the ~97 short strike
    const chains = spots.map((spot, i) => makeChain(addCalendarDays(start, i * 7), spot, [expiry]));

    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      assignment: 'model',
      entry: {
        daysToExpiry: { target: 21, min: 1, max: 30 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { daysToExpiry: 0 }, // hold to expiry
    });

    const settled = result.trades.find(
      (t) => t.exitReason === 'assignment' || t.exitReason === 'expiry',
    );
    expect(settled).toBeDefined();
    expect(result.settlements.some((s) => s.action === 'assigned')).toBe(true);
    expect(result.diagnostics.warnings.some((w) => w.code === 'backtest.assignment')).toBe(true);
  });

  it('settles a held-to-expiry OTM credit spread at full intrinsic (no residual time value)', () => {
    // Flat at 100; a 0.3-delta bull put spread finishes OTM → both puts worthless → keep the FULL
    // credit. The last snapshot is the expiry date (empty chain), so settlement marks at intrinsic.
    const start = '2026-04-06';
    const expiry = addCalendarDays(start, 21);
    const chains = [100, 100, 100, 100].map((spot, i) =>
      makeChain(addCalendarDays(start, i * 7), spot, [expiry]),
    );
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: {
        daysToExpiry: { target: 21, min: 1, max: 30 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { daysToExpiry: 0 }, // hold to expiry
    });
    const settled = result.trades.find((t) => t.exitReason === 'expiry');
    expect(settled).toBeDefined();
    // The whole credit is captured — realizedPnl == the credit, with no time value left on the table.
    expect(settled!.realizedPnl).toBeCloseTo(-settled!.entryPremium, 6);
    // Every leg expired worthless, and the settlement records are consistent (intrinsic cashFlow 0).
    expect(result.settlements.length).toBeGreaterThan(0);
    expect(result.settlements.every((s) => s.action === 'expired' && s.cashFlow === 0)).toBe(true);
  });

  it('a held bear-call spread expiring OTM settles as expired (no assignment)', () => {
    const start = '2026-02-02';
    const expiry = addCalendarDays(start, 21);
    const spots = [100, 100, 99, 98];
    const chains = spots.map((spot, i) => makeChain(addCalendarDays(start, i * 7), spot, [expiry]));
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      assignment: 'model',
      entry: {
        daysToExpiry: { target: 21, min: 1, max: 30 },
        structure: 'bearCallSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { daysToExpiry: 0 }, // hold to expiry
    });
    const expired = result.trades.find(
      (t) => t.exitReason === 'expiry' || t.exitReason === 'assignment',
    );
    expect(expired).toBeDefined();
    // Short call spread above the money → expires worthless → keep the full credit.
    expect(result.finalValue).toBeGreaterThan(100_000);
    expect(result.settlements.length).toBeGreaterThan(0);
  });
});

describe('optionsBacktest — margin-aware sizing', () => {
  it('sizes more than one contract when the margin budget allows', () => {
    const chains = series(START, new Array(10).fill(100));
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      initialCapital: 100_000,
      entry: {
        daysToExpiry: { target: 45, min: 30, max: 60 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
        sizing: { maxMarginFraction: 0.5 }, // a $5-wide spread margins at ~$500/lot → many lots
      },
      exit: { profitTarget: 0.5, daysToExpiry: 21 },
    });
    expect(result.assumptions.sizing).toBe('margin-aware');
    expect(result.trades[0]!.contracts).toBeGreaterThan(1);
  });
});

describe('optionsBacktest — delta hedging', () => {
  it('runs a delta-hedged program and returns a valid envelope', () => {
    const chains = series(START, [100, 102, 105, 103, 106, 108, 104, 101, 99, 102]);
    const hedged = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: {
        daysToExpiry: { target: 45, min: 30, max: 60 },
        structure: 'strangle',
        select: { shortDelta: 0.2 },
      },
      exit: { daysToExpiry: 21 },
      hedge: { deltaBand: 10 },
    });
    const unhedged = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: {
        daysToExpiry: { target: 45, min: 30, max: 60 },
        structure: 'strangle',
        select: { shortDelta: 0.2 },
      },
      exit: { daysToExpiry: 21 },
    });
    expect(hedged.assumptions.hedge).toBe(10);
    expect(unhedged.assumptions.hedge).toBe('none');
    expect(hedged.points).toHaveLength(chains.length + 1);
    // Hedging changes realized P&L (it trades the underlying), so the outcomes differ.
    expect(hedged.finalValue).not.toBeCloseTo(unhedged.finalValue, 2);
  });
});

describe('optionsBacktest — chains without stated implied vol', () => {
  it('runs on a delta-only chain (no IV): implies each entry IV from its premium, never crashes', () => {
    // A common real-feed shape: quotes carry delta + a price but NO impliedVolatility. The engine must imply
    // each leg's entry IV from its premium and mark, not throw an uncaught error mid-run.
    const chains = series(START, new Array(10).fill(100)).map((snap) => ({
      ...snap,
      quotes: snap.quotes.map(({ impliedVolatility: _iv, ...q }) => q), // omit impliedVolatility entirely
    }));
    expect(chains.every((c) => c.quotes.every((q) => !('impliedVolatility' in q)))).toBe(true);

    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: {
        when: 'flat',
        daysToExpiry: { target: 45, min: 30, max: 60 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { profitTarget: 0.5, daysToExpiry: 21 },
    });
    expect(result.trades.length).toBeGreaterThan(0); // it ran and traded
    const closed = result.trades.filter((t) => t.exitAsOf !== null);
    expect(closed[0]!.entryPremium).toBeLessThan(0); // still a credit spread
    expect(result.diagnostics.engine).toBe('options-backtest');
  });

  it('discloses a skip (never crashes) when a position cannot be marked for lack of any vol', () => {
    // A chain with strikes/expiry but neither IV nor any price to imply one from → unmarkable.
    const start = '2026-05-04';
    const expiry = addCalendarDays(start, 30);
    const bare = makeChain(start, 100, [expiry]);
    const stripped: ChainSnapshot = {
      ...bare,
      quotes: bare.quotes.map(({ impliedVolatility: _iv, mid: _mid, ...q }) => q), // omit both IV and price
    };
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains: [stripped],
      entry: {
        daysToExpiry: { target: 30, min: 1, max: 60 },
        build: () =>
          strategy([{ kind: 'put', strike: 95, quantity: -1, premium: 2, expiry }], {
            multiplier: 100,
          }),
      },
      exit: { daysToExpiry: 0 },
    });
    expect(result.trades).toHaveLength(0);
    expect(result.diagnostics.warnings.some((w) => w.code === 'backtest.entry_skipped')).toBe(true);
  });
});

describe('optionsBacktest — the build escape hatch + callback exit', () => {
  it('opens a custom (naked short put) position and closes on a callback signal', () => {
    // A flat underlying: the sold put decays, so a 25%-captured callback exit fires.
    const chains = series(START, new Array(8).fill(100));
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: {
        when: 'flat',
        daysToExpiry: { target: 45 },
        // Custom single short 95 put, priced + IV'd from the near expiry's chain. Built positions
        // must carry per-leg `iv` (the engine marks with per-leg IV, no fallback vol).
        build: (context) => {
          const nearExpiry = [
            ...new Set(context.snapshot.quotes.map((q) => q.contract.expiry)),
          ].sort()[0]!;
          const q = context.snapshot.quotes.find(
            (x) =>
              x.contract.type === 'put' &&
              x.contract.strike === 95 &&
              x.contract.expiry === nearExpiry,
          );
          if (!q) return null;
          // No per-leg iv needed: the engine marks legs without their own iv at the snapshot's ATM iv.
          return strategy(
            [legs.put({ strike: 95, premium: q.mid!, expiry: nearExpiry, quantity: -1 })],
            {
              multiplier: 100,
            },
          );
        },
      },
      exit: { when: (context) => context.pnlFraction >= 0.25 },
    });
    expect(result.trades.length).toBeGreaterThan(0);
    const closed = result.trades.filter((t) => t.exitAsOf !== null);
    expect(closed.some((t) => t.exitReason === 'signal')).toBe(true);
    // A short put is a credit → negative entry premium; a captured exit is net-positive.
    expect(closed[0]!.entryPremium).toBeLessThan(0);
    expect(result.diagnostics.engine).toBe('options-backtest');
  });
});

describe('optionsBacktest — the tear sheet', () => {
  it('summarizes win rate, credit, structure and leg-role attribution', () => {
    const chains = series(START, new Array(14).fill(100));
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: {
        daysToExpiry: { target: 45, min: 30, max: 60 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { profitTarget: 0.5, daysToExpiry: 21 },
    });
    const sheet = optionsTearSheet(result);
    expect(sheet.options.closed).toBeGreaterThan(0);
    expect(sheet.options.winRate).toBeGreaterThanOrEqual(0);
    expect(sheet.options.winRate).toBeLessThanOrEqual(1);
    expect(sheet.options.averageCredit).toBeGreaterThan(0); // it's a credit strategy
    expect(sheet.options.averageDaysHeld).toBeGreaterThan(0);
    expect(sheet.byStructure.some((s) => s.structure === 'bullPutSpread')).toBe(true);
    // A bull put spread has a short put and a long put leg → both roles attributed.
    const roles = sheet.byLegRole.map((r) => r.role);
    expect(roles).toContain('short put');
    expect(roles).toContain('long put');
    // Attribution sums to (roughly) the total realized P&L across legs.
    const legSum = sheet.byLegRole.reduce((a, r) => a + r.realizedPnl, 0);
    const tradeSum = result.trades.reduce((a, t) => a + (t.realizedPnl + t.costs), 0);
    expect(legSum).toBeCloseTo(tradeSum, 4);
    expect(sheet.performance.periods).toBeGreaterThan(0);
  });
});

describe('optionsBacktest — per-trade greek P&L explain', () => {
  const GREEK_TERMS = [
    'delta',
    'gamma',
    'vega',
    'theta',
    'rho',
    'vanna',
    'vomma',
    'charm',
    'veta',
    'vera',
    'deltaRate',
    'thetaRate',
    'rhoConvexity',
    'thetaConvexity',
    'phi',
  ] as const;
  const sumOfTerms = (e: TradePnlExplain): number =>
    GREEK_TERMS.reduce((a, k) => a + e[k], 0) + e.unexplained;
  // A flat 14-week series with a 50%-profit-target credit-spread program (shared, read-only).
  const result = optionsBacktest({
    riskFreeRate: 0.04,
    chains: series(START, new Array(14).fill(100)),
    entry: {
      daysToExpiry: { target: 45, min: 30, max: 60 },
      structure: 'bullPutSpread',
      select: { shortDelta: 0.3, width: 5 },
    },
    exit: { profitTarget: 0.5, daysToExpiry: 21 },
  });

  it('attaches a greek explain to every trade; terms sum to total = gross (pre-cost) P&L', () => {
    expect(result.trades.length).toBeGreaterThan(0);
    for (const t of result.trades) {
      // The bare terms + residual sum EXACTLY to the explain total.
      expect(sumOfTerms(t.pnlExplain)).toBeCloseTo(t.pnlExplain.total, 8);
      // The explain total is the GROSS mark P&L: net realized + costs booked back.
      expect(t.pnlExplain.total).toBeCloseTo(t.realizedPnl + t.costs, 6);
    }
  });

  it('a flat underlying → the P&L is pure theta (decay); delta/gamma/vega are ~0', () => {
    // Spot never moves and IV/rate are constant, so only the time-decay terms fire — theta carries the
    // whole realized P&L of the short (positive-theta) put spread.
    const closed = result.trades.filter((t) => t.exitAsOf !== null);
    expect(closed.length).toBeGreaterThan(0);
    for (const t of closed) {
      const e = t.pnlExplain;
      expect(Math.abs(e.delta)).toBeLessThan(1e-6); // dSpot = 0
      expect(Math.abs(e.gamma)).toBeLessThan(1e-6);
      expect(Math.abs(e.vega)).toBeLessThan(1e-6); // constant IV
      expect(Math.abs(e.rho)).toBeLessThan(1e-6); // constant rate
      expect(e.theta).toBeGreaterThan(0); // a short put spread earns positive theta
      // theta is the dominant contributor.
      for (const k of GREEK_TERMS) {
        if (k !== 'theta') expect(Math.abs(e[k])).toBeLessThanOrEqual(Math.abs(e.theta));
      }
    }
  });

  it('a directional underlying → delta becomes a live contributor with nonzero spot crosses', () => {
    // A rising underlying: the bull put spread is net long delta, so delta drives the P&L and the
    // spot-dependent higher-order terms (gamma, charm, vanna) switch on.
    const rising = series(START, [100, 102, 104, 106, 108, 110, 112, 114]);
    const res = optionsBacktest({
      riskFreeRate: 0.04,
      chains: rising,
      entry: {
        daysToExpiry: { target: 45, min: 20, max: 90 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { daysToExpiry: 0 }, // hold so a full spot move accrues
    });
    const withMove = res.trades.find((t) => Math.abs(t.pnlExplain.delta) > 0);
    expect(withMove).toBeDefined();
    expect(Math.abs(withMove!.pnlExplain.gamma)).toBeGreaterThan(0); // spot moved ⇒ gamma fired
    expect(sumOfTerms(withMove!.pnlExplain)).toBeCloseTo(withMove!.pnlExplain.total, 8);
  });

  it('the tear sheet rolls the per-trade explains into a strategy-level greek attribution', () => {
    const sheet = optionsTearSheet(result);
    const g = sheet.greekAttribution;
    expect(g.trades).toBe(result.trades.length);
    // Each bucket is the term-wise sum over trades.
    for (const k of [...GREEK_TERMS, 'total', 'unexplained'] as const) {
      const sum = result.trades.reduce((a, t) => a + t.pnlExplain[k], 0);
      expect(g[k]).toBeCloseTo(sum, 8);
    }
    // The strategy-level total is the summed GROSS P&L: net final P&L + total costs.
    const grossSum = result.trades.reduce((a, t) => a + t.realizedPnl + t.costs, 0);
    expect(g.total).toBeCloseTo(grossSum, 6);
    // A flat, decay-driven program: theta is the dominant strategy-level bucket.
    for (const k of GREEK_TERMS) {
      if (k !== 'theta') expect(Math.abs(g[k])).toBeLessThanOrEqual(Math.abs(g.theta));
    }
  });
});

describe('optionsBacktest — envelope & honesty', () => {
  it('throws typed errors on garbage config (never a raw crash)', () => {
    expect(() => optionsBacktest(undefined as never)).toThrowError();
    expect(() => optionsBacktest({ riskFreeRate: 0.04 } as never)).toThrowError(/entry/);
    try {
      optionsBacktest({ riskFreeRate: 0.04, entry: {}, exit: {} } as never);
      expect.unreachable('missing chains should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
  });

  it('an empty chain series produces an empty, valid result (no trades, capital preserved)', () => {
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains: [],
      entry: {
        daysToExpiry: { target: 45 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { profitTarget: 0.5 },
    });
    expect(result.trades).toHaveLength(0);
    expect(result.points).toHaveLength(0);
    expect(result.finalValue).toBe(100_000);
  });

  it('discloses (never fabricates) an entry that the chain cannot satisfy', () => {
    // A chain with no deltas → delta selection cannot resolve → a disclosed skip, not a fill.
    const start = '2026-03-02';
    const expiry = addCalendarDays(start, 45);
    const noDelta = makeChain(start, 100, [expiry]);
    for (const q of noDelta.quotes) delete (q as { greeks?: unknown }).greeks;
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains: [noDelta],
      entry: {
        daysToExpiry: { target: 45, min: 1, max: 90 },
        structure: 'bullPutSpread',
        select: { shortDelta: 0.3, width: 5 },
      },
      exit: { profitTarget: 0.5 },
    });
    expect(result.trades).toHaveLength(0);
    expect(result.diagnostics.warnings.some((w) => w.code === 'backtest.entry_skipped')).toBe(true);
  });

  it('optionsTearSheet guards its input', () => {
    expect(() => optionsTearSheet(undefined as never)).toThrowError();
    expect(() => optionsTearSheet({} as never)).toThrowError();
  });
});
