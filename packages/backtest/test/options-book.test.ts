/**
 * Stage 4.6 slice 4 — `optionsBacktest` over a position book: the default book is the shipped
 * single-position engine (and reconciles to the ledger it now emits); several rules hold several
 * trades at once; calendars settle leg by leg; combo and legged fills; limits are pre-trade gates
 * with rows; intraday snapshots and quote freshness; split lineage; dividend evidence and early
 * assignment; the surface summary; determinism; every malformed request teaches.
 */
import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  isoDateToEpochMs,
  resolvedExpiry,
  usEquitySessionInstant,
  optionExpiryToMs,
} from '@totalfinance/core';
import { canonicalJsonOf } from '@totalfinance/core/artifacts';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import type { OptionQuote } from '@totalfinance/core';
import {
  optionsBacktest,
  type ChainSnapshot,
  type EntryRule,
  type OptionsBacktestConfig,
} from '@totalfinance/backtest/options';

const DAY = 86_400_000;
const YEAR = 365;

/** End-of-day chains are observed at the close; expiries settle at their own close instant. */
const instantOf = (date: string): number => usEquitySessionInstant(date, 'close');
function yearsBetween(a: number, b: string): number {
  return (optionExpiryToMs(b) - a) / (DAY * YEAR);
}
function addCalendarDays(start: string, days: number): string {
  return new Date(isoDateToEpochMs(start) + days * DAY).toISOString().slice(0, 10);
}

interface ChainOptions {
  volatility?: number;
  rate?: number;
  /** Stamp quotes below this strike `staleMs` before the snapshot. */
  staleBelow?: number;
  /** Stamp quotes at or above this strike `staleMs` before the snapshot. */
  staleAbove?: number;
  staleMs?: number;
  /** Override the snapshot instant (intraday). */
  asOf?: string | number;
  underlying?: string;
  step?: number;
}

/** A BSM-consistent chain snapshot: mid + delta from the pricer, so selection + MTM are coherent. */
function makeChain(
  date: string,
  spot: number,
  expiries: readonly string[],
  options: ChainOptions = {},
): ChainSnapshot {
  const vol = options.volatility ?? 0.2;
  const rate = options.rate ?? 0.04;
  const asOf = options.asOf ?? instantOf(date);
  const ts =
    typeof asOf === 'number'
      ? asOf
      : asOf.includes('T')
        ? Date.parse(asOf)
        : isoDateToEpochMs(asOf);
  const step = options.step ?? 5;
  const quotes: OptionQuote[] = [];
  for (const expiry of expiries) {
    const t = yearsBetween(ts, expiry);
    if (t <= 0) continue;
    const lo = Math.round((spot * 0.75) / step) * step;
    const hi = spot * 1.25;
    for (let k = lo; k <= hi; k += step) {
      for (const type of ['call', 'put'] as const) {
        const stale =
          (options.staleBelow !== undefined && k < options.staleBelow) ||
          (options.staleAbove !== undefined && k >= options.staleAbove);
        quotes.push({
          contract: {
            underlying: options.underlying ?? 'XYZ',
            type,
            style: 'european',
            strike: k,
            expiry,
            ...resolvedExpiry(expiry),
            multiplier: 100,
          },
          timestampMs: stale ? ts - (options.staleMs ?? DAY) : ts,
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
  return { asOf, underlyingPrice: spot, quotes };
}

const START = '2026-01-05';
const EXPIRIES = [
  addCalendarDays(START, 49),
  addCalendarDays(START, 84),
  addCalendarDays(START, 119),
];

/** A weekly series along a spot path with the three fixed expiries. */
function series(spots: readonly number[], options: ChainOptions = {}): ChainSnapshot[] {
  return spots.map((spot, i) => makeChain(addCalendarDays(START, i * 7), spot, EXPIRIES, options));
}

const PUT_SPREAD: EntryRule = {
  daysToExpiry: { target: 45, min: 30, max: 60 },
  structure: 'bullPutSpread',
  select: { shortDelta: 0.3, width: 5 },
};

const failure = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
};

describe('the default book is the shipped single-position engine, now reconciled to its ledger', () => {
  it('runs the P1 credit-spread program unchanged and emits the ledger it reconciles to', () => {
    const chains = series(new Array(14).fill(100));
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 0.5, daysToExpiry: 21 },
    });
    expect(result.assumptions.book).toEqual({
      maximumOpenPositions: 1,
      maximumPerUnderlying: null,
    });
    expect(result.assumptions.fillPolicy).toEqual({
      mode: 'combo',
      partialFill: 'reject',
      price: 'mid',
    });
    expect(result.assumptions.rules).toEqual([{ id: 'rule-0', structure: 'bullPutSpread' }]);
    expect(result.assumptions.replayable).toBe(true);
    expect(result.runId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades[0]!.exitReason).toBe('profit-target');
    expect(result.trades[0]!.tradeId).toBe(1);
    expect(result.trades[0]!.ruleId).toBe('rule-0');
    expect(result.trades[0]!.underlying).toBe('XYZ');
    expect(result.trades[0]!.legInstrumentIds).toHaveLength(2);
    expect(result.trades[0]!.legInstrumentIds[0]).toMatch(/^XYZ/);
    // never two trades open at once under the default book
    for (let i = 1; i < result.trades.length; i += 1) {
      expect(result.trades[i]!.entryAsOf).toBeGreaterThanOrEqual(
        result.trades[i - 1]!.exitAsOf ?? Infinity,
      );
    }
    // the ledger: a deposit, then a fill per leg per open and close, folding to the reported equity
    expect(result.ledger.events[0]!.eventType).toBe('cash.deposit');
    const fills = result.ledger.events.filter((e) => e.eventType === 'trade.fill');
    expect(fills.length).toBe(
      result.trades.reduce((n, t) => n + t.legs.length * (t.exitAsOf === null ? 1 : 2), 0),
    );
    expect(Math.abs(result.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-6);
    expect(result.timeline.rows.length).toBe(chains.length);
    expect(result.timeline.rows[result.timeline.rows.length - 1]!.netAssetValue).toBeCloseTo(
      result.finalValue,
      6,
    );
    expect(result.surface).toHaveLength(chains.length);
    expect(result.limitRejections).toEqual([]);
    expect(result.fillRejections).toEqual([]);
    expect(result.diagnostics.tradeCount).toBe(result.trades.length);
  });

  it('is deterministic and every settlement row names the OCC symbol and the underlying', () => {
    const chains = series(new Array(10).fill(100));
    const config: OptionsBacktestConfig = {
      chains,
      riskFreeRate: 0.04,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
    };
    const a = optionsBacktest(config);
    const b = optionsBacktest(config);
    expect(canonicalJsonOf(a)).toBe(canonicalJsonOf(b));
    expect(a.settlements.length).toBeGreaterThan(0);
    expect(a.settlements[0]!.underlying).toBe('XYZ');
    expect(a.settlements[0]!.symbol).toMatch(/^XYZ\d{6}[CP]\d{8}$/);
  });
});

describe('several rules, several trades', () => {
  it('holds overlapping trades up to the book capacity; a per-underlying cap binds first', () => {
    const chains = series(new Array(14).fill(100));
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      rules: [{ ...PUT_SPREAD, id: 'puts', when: 'always' }],
      exit: { profitTarget: 5 },
      book: { maximumOpenPositions: 3 },
    });
    // three trades open on the first snapshot, none more until one closes
    const openOnFirst = result.trades.filter((t) => t.entryAsOf === instantOf(START));
    expect(openOnFirst).toHaveLength(3);
    expect(openOnFirst.map((t) => t.tradeId)).toEqual([1, 2, 3]);
    expect(result.trades.every((t) => t.ruleId === 'puts')).toBe(true);
    const capped = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      rules: [{ ...PUT_SPREAD, id: 'puts', when: 'always' }],
      exit: { profitTarget: 5 },
      book: { maximumOpenPositions: 3, maximumPerUnderlying: 1 },
    });
    expect(capped.trades.filter((t) => t.entryAsOf === instantOf(START))).toHaveLength(1);
  });

  it('two rules each see the book; a predicate reads the open trades', () => {
    const chains = series(new Array(14).fill(100));
    const seen: number[] = [];
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      rules: [
        { ...PUT_SPREAD, id: 'puts' },
        {
          id: 'condor',
          daysToExpiry: { target: 45, min: 30, max: 60 },
          structure: 'ironCondor',
          select: { shortDelta: 0.2, wingWidth: 5 },
          when: (context) => {
            seen.push(context.openTrades.length);
            return context.flat && context.openTrades.length === 1;
          },
        },
      ],
      exit: { profitTarget: 5 },
      book: { maximumOpenPositions: 2 },
    });
    expect(result.assumptions.rules.map((r) => r.id)).toEqual(['puts', 'condor']);
    expect(result.assumptions.replayable).toBe(false);
    expect(seen[0]).toBe(1); // the condor rule saw the put spread already open
    const first = result.trades.filter((t) => t.entryAsOf === instantOf(START));
    expect(first.map((t) => t.ruleId).sort()).toEqual(['condor', 'puts']);
    expect(first.find((t) => t.ruleId === 'condor')!.structure).toBe('ironCondor');
  });
});

describe('calendars and diagonals settle leg by leg', () => {
  it('a put calendar settles its near leg at the near expiry and keeps marking the far leg', () => {
    const chains = series(new Array(14).fill(100));
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: {
        daysToExpiry: { target: 49 },
        structure: 'calendarPutSpread',
        select: {
          shortDelta: 0.5,
          nearDaysToExpiry: { target: 49, min: 40, max: 60 },
          farDaysToExpiry: { target: 84, min: 70, max: 100 },
        },
      },
      exit: { profitTarget: 50 },
    });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.structure).toBe('calendarPutSpread');
    expect(trade.legs).toHaveLength(2);
    expect(trade.legs.map((l) => l.expiry)).toEqual([EXPIRIES[0], EXPIRIES[1]]);
    expect(trade.legSettlements).toHaveLength(2);
    expect(trade.legSettlements[0]!.legIndex).toBe(0);
    expect(trade.legSettlements[0]!.settlement.timestampMs).toBe(instantOf(EXPIRIES[0]!));
    expect(trade.legSettlements[1]!.settlement.timestampMs).toBe(instantOf(EXPIRIES[1]!));
    expect(trade.exitAsOf).toBe(instantOf(EXPIRIES[1]!));
    expect(['expiry', 'assignment']).toContain(trade.exitReason);
    expect(trade.exitVolatilities[0]).toBeNull(); // the settled near leg
    expect(result.settlements).toHaveLength(2);
    expect(result.settlements[0]!.timestampMs).toBeLessThan(result.settlements[1]!.timestampMs);
    expect(Math.abs(result.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-6);
    const lifecycle = result.ledger.events.filter((e) => e.eventType.startsWith('derivative.'));
    expect(lifecycle).toHaveLength(2);
  });

  it('a call diagonal needs a width and a calendar refuses one', () => {
    const chains = series(new Array(3).fill(100));
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          entry: {
            daysToExpiry: { target: 49 },
            structure: 'calendarCallSpread',
            select: {
              shortDelta: 0.5,
              nearDaysToExpiry: { target: 49 },
              farDaysToExpiry: { target: 84 },
              width: 5,
            },
          },
          exit: {},
        }),
      ).code,
    ).toBe(ErrorCode.InputUnknownField);
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          entry: {
            daysToExpiry: { target: 49 },
            structure: 'diagonalCallSpread',
            select: {
              shortDelta: 0.5,
              nearDaysToExpiry: { target: 49 },
              farDaysToExpiry: { target: 84 },
            },
          },
          exit: {},
        }),
      ).code,
    ).toBe(ErrorCode.InputMissingField);
    const diagonal = optionsBacktest({
      riskFreeRate: 0.04,
      chains: series(new Array(14).fill(100)),
      entry: {
        daysToExpiry: { target: 49 },
        structure: 'diagonalCallSpread',
        select: {
          shortDelta: 0.4,
          nearDaysToExpiry: { target: 49, min: 40, max: 60 },
          farDaysToExpiry: { target: 84, min: 70, max: 100 },
          width: 5,
        },
      },
      exit: { profitTarget: 50 },
    });
    expect(diagonal.trades[0]!.structure).toBe('diagonalCallSpread');
    expect(diagonal.trades[0]!.legs[1]!.strike).toBe(diagonal.trades[0]!.legs[0]!.strike! + 5);
    const dd = optionsBacktest({
      riskFreeRate: 0.04,
      chains: series(new Array(14).fill(100)),
      entry: {
        daysToExpiry: { target: 49 },
        structure: 'doubleDiagonal',
        select: {
          shortDelta: 0.3,
          nearDaysToExpiry: { target: 49, min: 40, max: 60 },
          farDaysToExpiry: { target: 84, min: 70, max: 100 },
          width: 5,
        },
      },
      exit: { profitTarget: 50 },
    });
    expect(dd.trades[0]!.legs).toHaveLength(4);
  });
});

describe('the fill policy and quote freshness', () => {
  it('combo rejects an entry whose short leg is stale; legged with partial fills holds the long leg', () => {
    // the short put (the ~0.3-delta strike, 95) is stamped two days old; the long put (90) is fresh
    const chains = series(new Array(6).fill(100), { staleAbove: 93, staleMs: 2 * DAY });
    const combo = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
      quoteFreshness: { maximumQuoteAgeMs: DAY },
    });
    expect(combo.trades).toEqual([]);
    // five of six snapshots can build (day 21 has no expiry within the DTE window — a skip, not a rejection)
    expect(combo.fillRejections.length).toBe(5);
    expect(combo.fillRejections[0]!.mode).toBe('combo');
    expect(combo.fillRejections[0]!.unfilledLegs).toHaveLength(1);
    expect(combo.fillRejections[0]!.unfilledLegs[0]!.cause).toBe('stale');
    expect(combo.fillRejections[0]!.unfilledLegs[0]!.leg.quantity).toBeLessThan(0);
    expect(combo.fillRejections[0]!.code).toBe('backtest.combo_leg_unfilled');
    expect(combo.diagnostics.fillRejectionCount).toBe(5);
    // legged: the long put (first in the structure) fills, the stale short put stops the sequence
    const legged = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
      quoteFreshness: { maximumQuoteAgeMs: DAY },
      fillPolicy: { mode: 'legged', partialFill: 'allow' },
    });
    expect(legged.trades.length).toBeGreaterThan(0);
    expect(legged.trades[0]!.partial).toBe(true);
    expect(legged.trades[0]!.legs).toHaveLength(1);
    expect(legged.trades[0]!.legs[0]!.quantity).toBeGreaterThan(0);
    expect(legged.trades[0]!.unfilledLegs).toHaveLength(1);
    expect(legged.trades[0]!.unfilledLegs[0]!.leg.quantity).toBeLessThan(0);
    expect(legged.assumptions.fillPolicy.mode).toBe('legged');
    // legged with the default 'reject' partial policy is a rejection row, nothing held
    const rejected = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
      quoteFreshness: { maximumQuoteAgeMs: DAY },
      fillPolicy: { mode: 'legged' },
    });
    expect(rejected.trades).toEqual([]);
    expect(rejected.fillRejections[0]!.mode).toBe('legged');
    // fresh quotes fill as before
    const fresh = optionsBacktest({
      riskFreeRate: 0.04,
      chains: series(new Array(6).fill(100)),
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
      quoteFreshness: { maximumQuoteAgeMs: DAY },
    });
    expect(fresh.fillRejections).toEqual([]);
    expect(fresh.trades.length).toBeGreaterThan(0);
  });

  it('two snapshots within one day are two decision instants; the ledger marks once per date', () => {
    const chains = [
      makeChain(START, 100, EXPIRIES, { asOf: `${START}T15:00:00Z` }),
      makeChain(START, 101, EXPIRIES, { asOf: `${START}T20:00:00Z` }),
      makeChain(addCalendarDays(START, 1), 102, EXPIRIES, {
        asOf: `${addCalendarDays(START, 1)}T20:00:00Z`,
      }),
    ];
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      // one entry per decision instant: a predicate that refuses a second entry at the same instant
      entry: {
        ...PUT_SPREAD,
        when: (context) => context.openTrades.every((t) => t.entryAsOf !== context.asOf),
      },
      exit: { profitTarget: 5 },
      book: { maximumOpenPositions: 3 },
    });
    expect(result.points).toHaveLength(4); // the opening point and one per snapshot
    expect(result.trades.map((t) => t.entryAsOf)).toEqual([
      Date.parse(`${START}T15:00:00Z`),
      Date.parse(`${START}T20:00:00Z`),
      Date.parse(`${addCalendarDays(START, 1)}T20:00:00Z`),
    ]);
    expect(result.timeline.rows).toHaveLength(2);
    expect(Math.abs(result.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-6);
  });
});

describe('limits are pre-trade gates with rows', () => {
  it('a margin fraction the book cannot meet rejects every entry, nothing is scaled', () => {
    const chains = series(new Array(6).fill(100));
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
      limits: { maximumMarginFraction: 0.001 },
    });
    expect(result.trades).toEqual([]);
    expect(result.limitRejections).toHaveLength(5); // day 21 has no expiry in the DTE window
    expect(result.limitRejections[0]).toMatchObject({
      ruleId: 'rule-0',
      structure: 'bullPutSpread',
      limit: 'maximumMarginFraction',
      code: 'backtest.limit_rejected',
    });
    expect(result.limitRejections[0]!.value).toBeGreaterThan(result.limitRejections[0]!.bound);
    expect(result.diagnostics.warnings.some((w) => w.code === 'backtest.limit_rejected')).toBe(
      true,
    );
    expect(result.assumptions.limits.maximumMarginFraction).toBe(0.001);
  });

  it('net delta, concentration, and the scenario loss each name their bound', () => {
    const chains = series(new Array(4).fill(100));
    const delta = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
      limits: { maximumNetDelta: 0 },
    });
    expect(delta.limitRejections[0]!.limit).toBe('maximumNetDelta');
    const concentration = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
      limits: { maximumConcentration: 0.0001 },
    });
    expect(concentration.limitRejections[0]!.limit).toBe('maximumConcentration');
    const scenario = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
      limits: {
        scenarioLoss: {
          spotShocks: [-0.2, 0, 0.2],
          volatilityShocks: [0, 0.1],
          maximumLossFraction: 0.0001,
        },
      },
    });
    expect(scenario.limitRejections[0]!.limit).toBe('scenarioLoss');
    expect(scenario.limitRejections[0]!.value).toBeGreaterThan(0);
    const permissive = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
      limits: {
        maximumNetDelta: 1e6,
        maximumNetVega: 1e9,
        maximumConcentration: 1,
        maximumMarginFraction: 1,
        scenarioLoss: { spotShocks: [-0.2, 0.2], volatilityShocks: [0.1], maximumLossFraction: 1 },
      },
    });
    expect(permissive.limitRejections).toEqual([]);
    expect(permissive.trades.length).toBeGreaterThan(0);
  });
});

describe('corporate actions and dividends', () => {
  it('a reverse split adjusts open legs with lineage and the ledger records the multiplier change', () => {
    const splitDate = addCalendarDays(START, 14);
    const chains = [
      ...series([100, 100]),
      ...[2, 3, 4, 5].map((i) =>
        makeChain(addCalendarDays(START, i * 7), 200, EXPIRIES, { step: 10 }),
      ),
    ];
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 50 },
      corporateActions: [
        { symbol: 'XYZ', effectiveDate: splitDate, type: 'reverseSplit', ratio: 0.5 },
      ],
    });
    const trade = result.trades[0]!;
    expect(trade.lineage).toHaveLength(1);
    expect(trade.lineage[0]).toMatchObject({
      action: 'reverseSplit',
      effectiveDate: splitDate,
      previous: { multiplier: 100 },
      adjusted: { multiplier: 50 },
    });
    expect(trade.lineage[0]!.adjusted.strikes).toEqual(
      trade.lineage[0]!.previous.strikes.map((k) => k * 2),
    );
    expect(
      result.ledger.events.filter((e) => e.eventType === 'derivative.multiplier-change'),
    ).toHaveLength(2);
    expect(result.diagnostics.corporateActionsApplied).toBe(1);
    expect(Math.abs(result.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-6);
    // the equity curve is continuous across the split (the exposure did not change)
    const before = result.points[1]!.equity;
    const after = result.points[2]!.equity;
    expect(Math.abs(after - before) / before).toBeLessThan(0.05);
    const merger = failure(() =>
      optionsBacktest({
        riskFreeRate: 0.04,
        chains: series(new Array(4).fill(100)),
        entry: PUT_SPREAD,
        exit: { profitTarget: 50 },
        corporateActions: [
          { symbol: 'XYZ', effectiveDate: addCalendarDays(START, 7), type: 'merger' },
        ],
      }),
    );
    expect(merger.code).toBe(ErrorCode.BacktestUnsupportedCorporateAction);
    expect(merger.message).toContain('merger');
  });

  it('a dividend larger than a short call’s extrinsic value is evidence, and an early assignment under the model', () => {
    const exDate = addCalendarDays(START, 10);
    const chains = series(new Array(6).fill(100));
    const rule: EntryRule = {
      daysToExpiry: { target: 45, min: 30, max: 60 },
      structure: 'coveredCall',
      select: { shortDelta: 0.95 },
    };
    const evidence = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: rule,
      exit: { profitTarget: 50 },
      dividends: [{ underlying: 'XYZ', exDate, amount: 5 }],
    });
    const row = evidence.surface[1]!.dividendRisk;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({
      tradeId: 1,
      underlying: 'XYZ',
      exDate,
      dividend: 5,
      atRisk: true,
    });
    expect(evidence.diagnostics.earlyAssignmentCount).toBe(0);
    const modelled = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: rule,
      exit: { profitTarget: 50 },
      dividends: [{ underlying: 'XYZ', exDate, amount: 5 }],
      assignment: 'model',
    });
    expect(modelled.diagnostics.earlyAssignmentCount).toBe(1);
    const early = modelled.settlements.find((s) => s.early === true);
    expect(early).toBeDefined();
    expect(early!.reason).toBe('dividend');
    expect(early!.action).toBe('assigned');
    expect(early!.timestampMs).toBe(instantOf(addCalendarDays(START, 7)));
    expect(Math.abs(modelled.diagnostics.reconciliationResidual)).toBeLessThanOrEqual(1e-6);
  });
});

describe('the surface summary', () => {
  it('reports the ATM volatility per expiry, a flat skew, and the mark sources of every snapshot', () => {
    const chains = series(new Array(4).fill(100), { volatility: 0.25 });
    const result = optionsBacktest({
      riskFreeRate: 0.04,
      chains,
      entry: PUT_SPREAD,
      exit: { profitTarget: 5 },
    });
    expect(result.surface).toHaveLength(4);
    for (const row of result.surface) {
      expect(Object.keys(row.atTheMoneyVolatilityByExpiry)).toEqual(EXPIRIES);
      for (const v of Object.values(row.atTheMoneyVolatilityByExpiry))
        expect(v).toBeCloseTo(0.25, 9);
      expect(row.skew25Delta).toBeCloseTo(0, 9);
    }
    expect(result.surface[1]!.markSources.currentQuote).toBe(2);
    expect(result.surface[0]!.markSources.snapshots).toBe(1);
  });
});

describe('refusals', () => {
  it('teaches on a duplicate rule id, an empty book, a book above the ceiling, and a bad limit', () => {
    const chains = series(new Array(3).fill(100));
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          rules: [
            { ...PUT_SPREAD, id: 'a' },
            { ...PUT_SPREAD, id: 'a' },
          ],
          exit: {},
        }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() => optionsBacktest({ riskFreeRate: 0.04, chains, rules: [], exit: {} })).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          entry: PUT_SPREAD,
          exit: {},
          book: { maximumOpenPositions: 0 },
        }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          entry: PUT_SPREAD,
          exit: {},
          book: { maximumOpenPositions: 10_001 },
        }),
      ).code,
    ).toBe(ErrorCode.BacktestBookTooLarge);
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          entry: PUT_SPREAD,
          exit: {},
          limits: { maximumMarginFraction: 2 },
        }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          entry: PUT_SPREAD,
          exit: {},
          quoteFreshness: { maximumQuoteAgeMs: -1 },
        }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          entry: PUT_SPREAD,
          exit: {},
          dividends: [{ underlying: 'XYZ', exDate: START, amount: 0 }],
        }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          entry: PUT_SPREAD,
          exit: {},
          corporateActions: [{ symbol: 'XYZ', effectiveDate: START, type: 'split' }],
        }),
      ).code,
    ).toBe(ErrorCode.InputOutOfRange);
    expect(
      failure(() =>
        optionsBacktest({
          riskFreeRate: 0.04,
          chains,
          entry: PUT_SPREAD,
          exit: {},
          fillPolicy: { mode: 'sequential' },
        } as never),
      ).code,
    ).toBeDefined();
  });
});
