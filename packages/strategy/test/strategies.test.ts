/**
 * Tests for the full named single-expiry strategy set (app OPC parity): leg composition (kind, sign,
 * strike, quantity) mirrors the InsiderFinance option profit calculator, plus payoff/greeks sanity on
 * representative structures.
 */

import { describe, expect, it } from 'vitest';
import { strategy } from '@totalfinance/strategy';
import type { Leg } from '@totalfinance/strategy';

/** Compact leg signature: signed contracts by (kind, strike) — a stock row reports its entry price. */
const sig = (legs: readonly Leg[]): Array<[string, number, number]> =>
  legs.map(
    (l) =>
      [l.kind, l.kind === 'stock' ? l.price : l.strike, l.quantity] as [string, number, number],
  );

const sl = (strike: number, premium = 1): { strike: number; premium: number } => ({
  strike,
  premium,
});

describe('single legs', () => {
  it('longCall / shortPut / cashSecuredPut', () => {
    expect(sig(strategy.longCall({ strike: 100, premium: 5 }).legs)).toEqual([['call', 100, 1]]);
    expect(sig(strategy.shortPut({ strike: 95, premium: 3 }).legs)).toEqual([['put', 95, -1]]);
    // cash-secured put has the same legs as a short put.
    expect(sig(strategy.cashSecuredPut({ strike: 95, premium: 3 }).legs)).toEqual([
      ['put', 95, -1],
    ]);
  });
});

describe('ladders', () => {
  const inp = { lower: sl(95), middle: sl(100), upper: sl(105) };
  it('bull call ladder = long lower, short middle + upper calls', () => {
    expect(sig(strategy.bullCallLadder(inp).legs)).toEqual([
      ['call', 95, 1],
      ['call', 100, -1],
      ['call', 105, -1],
    ]);
  });
  it('bear put ladder = long upper put, short middle + lower puts', () => {
    expect(sig(strategy.bearPutLadder(inp).legs)).toEqual([
      ['put', 105, 1],
      ['put', 100, -1],
      ['put', 95, -1],
    ]);
  });
});

describe('broken wings', () => {
  const inp = { lower: sl(95), middle: sl(100), upper: sl(110) };
  it('call broken wing = long/short2/long', () => {
    expect(sig(strategy.callBrokenWing(inp).legs)).toEqual([
      ['call', 95, 1],
      ['call', 100, -2],
      ['call', 110, 1],
    ]);
  });
  it('inverse put broken wing = short/long2/short', () => {
    expect(sig(strategy.inversePutBrokenWing(inp).legs)).toEqual([
      ['put', 95, -1],
      ['put', 100, 2],
      ['put', 110, -1],
    ]);
  });
});

describe('jade lizard / reverse', () => {
  it('jade lizard = short put + short call + long higher call, no upside risk when credit ≥ width', () => {
    // Net credit 3 across the 100/110 call spread (width 10) — still has upside risk, but bounded.
    const pos = strategy.jadeLizard({
      put: sl(90, 2),
      shortCall: sl(100, 2),
      longCall: sl(110, 1),
    });
    expect(sig(pos.legs)).toEqual([
      ['put', 90, -1],
      ['call', 100, -1],
      ['call', 110, 1],
    ]);
    // Upside is capped (long 110 call), so max loss is finite (not −∞).
    expect(Number.isFinite(pos.metrics().maxLoss)).toBe(true);
  });
  it('reverse jade lizard = short call + short put + long lower put', () => {
    expect(
      sig(strategy.reverseJadeLizard({ call: sl(110), shortPut: sl(100), longPut: sl(90) }).legs),
    ).toEqual([
      ['call', 110, -1],
      ['put', 100, -1],
      ['put', 90, 1],
    ]);
  });
});

describe('ratio spreads / backspreads', () => {
  it('call ratio spread (1×2) has unbounded upside risk', () => {
    const pos = strategy.callRatioSpread({ long: sl(100, 4), short: sl(110, 2) });
    expect(sig(pos.legs)).toEqual([
      ['call', 100, 1],
      ['call', 110, -2],
    ]);
    expect(pos.metrics().maxLoss).toBeNull(); // extra short call → unbounded upside loss
    expect(pos.metrics().bounded.loss).toBe(false);
  });
  it('call ratio backspread (1×2) has unbounded upside profit', () => {
    const pos = strategy.callRatioBackspread({ short: sl(100, 4), long: sl(110, 2) });
    expect(sig(pos.legs)).toEqual([
      ['call', 100, -1],
      ['call', 110, 2],
    ]);
    expect(pos.metrics().maxProfit).toBeNull();
    expect(pos.metrics().bounded.profit).toBe(false);
  });
});

describe('condors / butterflies', () => {
  it('long call condor = long/short/short/long', () => {
    const pos = strategy.longCallCondor({ k1: sl(90), k2: sl(95), k3: sl(105), k4: sl(110) });
    expect(sig(pos.legs)).toEqual([
      ['call', 90, 1],
      ['call', 95, -1],
      ['call', 105, -1],
      ['call', 110, 1],
    ]);
    expect(Number.isFinite(pos.metrics().maxLoss)).toBe(true); // defined risk
    expect(Number.isFinite(pos.metrics().maxProfit)).toBe(true);
  });
  it('long put butterfly = long/short2/long, defined risk', () => {
    const pos = strategy.longPutButterfly({ lower: sl(90), middle: sl(100), upper: sl(110) });
    expect(sig(pos.legs)).toEqual([
      ['put', 90, 1],
      ['put', 100, -2],
      ['put', 110, 1],
    ]);
    expect(Number.isFinite(pos.metrics().maxLoss)).toBe(true);
  });
});

describe('iron variants', () => {
  it('iron butterfly = long put wing / short body put+call / long call wing', () => {
    const pos = strategy.ironButterfly({
      body: { strike: 100, callPremium: 3, putPremium: 3 },
      putWing: sl(90, 1),
      callWing: sl(110, 1),
    });
    expect(sig(pos.legs)).toEqual([
      ['put', 90, 1],
      ['put', 100, -1],
      ['call', 100, -1],
      ['call', 110, 1],
    ]);
  });
  it('inverse iron condor = short outer / long inner', () => {
    const pos = strategy.inverseIronCondor({
      putLong: sl(90),
      putShort: sl(95),
      callShort: sl(105),
      callLong: sl(110),
    });
    expect(sig(pos.legs)).toEqual([
      ['put', 90, -1],
      ['put', 95, 1],
      ['call', 105, 1],
      ['call', 110, -1],
    ]);
  });
});

describe('synthetics / combos / guts / strips', () => {
  it('long synthetic future ≈ long stock (positive delta, same-strike call/put)', () => {
    const pos = strategy.longSyntheticFuture({ strike: 100, callPremium: 3, putPremium: 3 });
    expect(sig(pos.legs)).toEqual([
      ['call', 100, 1],
      ['put', 100, -1],
    ]);
    const g = pos.value({
      spot: 100,
      asOf: Date.UTC(2026, 0, 1),
      expiry: '2026-04-02',
      volatility: 0.25,
      riskFreeRate: 0.03,
    });
    expect(g.greeks.delta).toBeGreaterThan(90); // ≈ +100 (1 contract of synthetic long)
  });
  it('strip = long 1 call + long 2 puts; strap = long 2 calls + long 1 put', () => {
    expect(sig(strategy.strip({ strike: 100, callPremium: 4, putPremium: 4 }).legs)).toEqual([
      ['call', 100, 1],
      ['put', 100, 2],
    ]);
    expect(sig(strategy.strap({ strike: 100, callPremium: 4, putPremium: 4 }).legs)).toEqual([
      ['call', 100, 2],
      ['put', 100, 1],
    ]);
  });
  it('long guts = long ITM call (lower) + long ITM put (upper)', () => {
    expect(sig(strategy.guts({ lower: sl(95), upper: sl(105) }).legs)).toEqual([
      ['call', 95, 1],
      ['put', 105, 1],
    ]);
  });
});

describe('stock + option combinations', () => {
  it('covered call = long 100 shares + short 1 call', () => {
    const pos = strategy.coveredCall({ stockPrice: 100, strike: 105, premium: 2 });
    expect(sig(pos.legs)).toEqual([
      ['stock', 100, 100],
      ['call', 105, -1],
    ]);
    // Upside capped above the short strike ⇒ finite max profit.
    expect(Number.isFinite(pos.metrics().maxProfit)).toBe(true);
  });
  it('collar = long stock + long put + short call', () => {
    const pos = strategy.collar({ stockPrice: 100, put: sl(95, 2), call: sl(105, 2) });
    expect(sig(pos.legs)).toEqual([
      ['stock', 100, 100],
      ['put', 95, 1],
      ['call', 105, -1],
    ]);
    // Fully bounded both ways.
    expect(Number.isFinite(pos.metrics().maxLoss)).toBe(true);
    expect(Number.isFinite(pos.metrics().maxProfit)).toBe(true);
  });
  it('protective put = long stock + long put; covered short straddle = stock + short call + short put', () => {
    expect(sig(strategy.protectivePut({ stockPrice: 100, strike: 95, premium: 2 }).legs)).toEqual([
      ['stock', 100, 100],
      ['put', 95, 1],
    ]);
    expect(
      sig(
        strategy.coveredShortStraddle({
          stockPrice: 100,
          strike: 100,
          callPremium: 3,
          putPremium: 3,
        }).legs,
      ),
    ).toEqual([
      ['stock', 100, 100],
      ['call', 100, -1],
      ['put', 100, -1],
    ]);
  });
});

describe('quantity scaling', () => {
  it('every leg scales with quantity', () => {
    const pos = strategy.longCallButterfly({
      lower: sl(90),
      middle: sl(100),
      upper: sl(110),
      quantity: 5,
    });
    expect(sig(pos.legs)).toEqual([
      ['call', 90, 5],
      ['call', 100, -10],
      ['call', 110, 5],
    ]);
  });
});
