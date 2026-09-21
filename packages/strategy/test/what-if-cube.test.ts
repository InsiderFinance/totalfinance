/**
 * What-if cube (`Position.whatIfCube`). Verifies the cube dimensions and row-major cell order (matching
 * the equivalent `scenarioTable`), the optimal-exit surface (a short-premium position optimally exits at
 * the latest day — decay helps; a long-premium ITM position at the earliest — decay hurts), the
 * `min-pnl` objective, the global `best`/`worst` extremes, the vol-floor disclosure, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { legs, strategy } from '@totalfinance/strategy';

const MARKET = {
  spot: 100,
  volatility: 0.25,
  riskFreeRate: 0.04,
  asOf: '2026-01-15T00:00:00Z',
  expiry: '2026-03-20',
};

const shortStrangle = () =>
  strategy(
    [
      legs.call({ strike: 110, premium: 2, quantity: -1 }),
      legs.put({ strike: 90, premium: 2, quantity: -1 }),
    ],
    { market: MARKET },
  );
const longCall = () =>
  strategy([legs.call({ strike: 100, premium: 5, quantity: 1 })], { market: MARKET });

describe('whatIfCube — structure', () => {
  it('spans the full spot × vol × time grid in row-major order, matching scenarioTable', () => {
    const prices = [90, 100, 110];
    const volatilityShocks = [-0.05, 0, 0.05];
    const daysForward = [0, 15, 30];
    const pos = shortStrangle();
    const cube = pos.whatIfCube({ prices, volatilityShocks, daysForward }).value;

    expect(cube.cells).toHaveLength(prices.length * volatilityShocks.length * daysForward.length);
    expect(cube.optimalExit).toHaveLength(prices.length * volatilityShocks.length);
    expect(cube.axes).toEqual({ prices, volatilityShocks, daysForward });

    // Row-major: price outer, vol middle, day inner ⇒ index = ((i·|vol|)+j)·|day|+k.
    const i = 2;
    const j = 0;
    const k = 1;
    const cell = cube.cells[(i * volatilityShocks.length + j) * daysForward.length + k]!;
    expect(cell.underlyingPrice).toBe(prices[i]);
    expect(cell.volatilityShock).toBe(volatilityShocks[j]);
    expect(cell.daysForward).toBe(daysForward[k]);

    // Same axes ⇒ the cells reproduce scenarioTable's rows exactly (it composes the same value() mark).
    const rows = pos.scenarioTable({ prices, volatilityShocks, daysForward }).value;
    expect(cube.cells.length).toBe(rows.length);
    cube.cells.forEach((c, idx) => {
      const r = rows[idx]!;
      expect(c.underlyingPrice).toBe(r.underlyingPrice);
      expect(c.volatilityShock).toBe(r.volatilityShock);
      expect(c.daysForward).toBe(r.daysForward);
      expect(c.pnl).toBeCloseTo(r.pnl, 10);
      expect(c.delta).toBeCloseTo(r.delta, 10);
    });
  });

  it('best/worst are the global P&L extremes across the cube', () => {
    const cube = shortStrangle().whatIfCube({
      prices: [90, 100, 110],
      volatilityShocks: [-0.05, 0, 0.05],
      daysForward: [0, 15, 30, 45],
    }).value;
    const pnls = cube.cells.map((c) => c.pnl);
    expect(cube.best.pnl).toBe(Math.max(...pnls));
    expect(cube.worst.pnl).toBe(Math.min(...pnls));
  });
});

describe('whatIfCube — optimal-exit surface', () => {
  it('a short-premium position optimally exits at the LATEST day (decay helps) everywhere', () => {
    const daysForward = [0, 15, 30, 45];
    const cube = shortStrangle().whatIfCube({
      prices: [90, 100, 110],
      volatilityShocks: [-0.05, 0, 0.05],
      daysForward,
    }).value;
    const lastDay = daysForward[daysForward.length - 1];
    expect(cube.optimalExit.every((e) => e.daysForward === lastDay)).toBe(true);
    // Each optimal point's P&L is the max over the day axis at that (spot, vol).
    for (const e of cube.optimalExit) {
      const alongTime = cube.cells.filter(
        (c) => c.underlyingPrice === e.underlyingPrice && c.volatilityShock === e.volatilityShock,
      );
      expect(e.pnl).toBe(Math.max(...alongTime.map((c) => c.pnl)));
    }
  });

  it('a long-premium ITM position optimally exits EARLIER (decay hurts)', () => {
    const cube = longCall().whatIfCube({
      prices: [110], // deep-ITM, mostly intrinsic + a little time value that decays
      volatilityShocks: [0],
      daysForward: [0, 15, 30, 45],
    }).value;
    expect(cube.optimalExit[0]!.daysForward).toBe(0);
  });

  it("the 'min-pnl' objective picks the worst day per (spot, vol)", () => {
    const daysForward = [0, 15, 30, 45];
    const cube = shortStrangle().whatIfCube({
      prices: [100],
      volatilityShocks: [0],
      daysForward,
      objective: 'min-pnl',
    }).value;
    // For a short-premium position the worst day is the earliest (least decay).
    expect(cube.optimalExit[0]!.daysForward).toBe(0);
    const alongTime = cube.cells.map((c) => c.pnl);
    expect(cube.optimalExit[0]!.pnl).toBe(Math.min(...alongTime));
  });
});

describe('whatIfCube — envelope & guards', () => {
  it('discloses vol-floored cells on a crushing negative shock', () => {
    const res = shortStrangle().whatIfCube({
      prices: [100],
      volatilityShocks: [-0.3], // 0.25 − 0.30 < 0 ⇒ floored below the 1e-6 floor
      daysForward: [0],
    });
    expect(res.diagnostics.warnings.some((w) => w.code === 'strategy.volatility_floored')).toBe(
      true,
    );
    expect(res.assumptions.marketSource).toBe('construction');
  });

  it('accepts a PriceRange for the price axis', () => {
    const cube = shortStrangle().whatIfCube({ prices: { from: 90, to: 110, steps: 5 } }).value;
    expect(cube.axes.prices).toEqual([90, 95, 100, 105, 110]);
    expect(cube.cells).toHaveLength(5); // 5 × 1 × 1
  });

  it('throws on a missing asOf, an empty axis, and a bad objective', () => {
    // A position built with no market and no call market can't advance time.
    const noMarket = strategy([
      legs.call({ strike: 100, premium: 5, expiry: '2026-03-20', quantity: 1 }),
    ]);
    try {
      noMarket.whatIfCube({ prices: [100] });
      expect.unreachable('missing asOf should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
    expect(() => shortStrangle().whatIfCube({ prices: [] })).toThrowError();
    expect(() =>
      shortStrangle().whatIfCube({ prices: [100], volatilityShocks: [] }),
    ).toThrowError();
    expect(() =>
      shortStrangle().whatIfCube({ prices: [100], objective: 'bogus' as never }),
    ).toThrowError();
  });
});
