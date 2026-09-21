/**
 * Isolated-margin liquidation & bankruptcy prices (`liquidationPrice`) for inverse (coin-margined) and
 * linear (USDT-margined) leveraged perps. The core proof is DEFINITIONAL: at the reported liquidation
 * price, account equity exactly equals the maintenance margin (assessed at the mark); bankruptcy is where
 * equity hits 0. Longs liquidate below entry, shorts above; the price is size-independent.
 */

import { describe, expect, it } from 'vitest';
import { PostconditionError, isQuantError } from '@totalfinance/core';
import { liquidationPrice } from '@totalfinance/crypto';

const F0 = 50_000;
const L = 10;
const m = 0.005;

/** Coin equity of an inverse (coin-margined) position at mark F: IM(coin) + coinPnl. */
function inverseEquity(F: number, side: 'long' | 'short', Q: number): number {
  const s = side === 'long' ? 1 : -1;
  return Q / (F0 * L) + s * Q * (1 / F0 - 1 / F);
}
const inverseMM = (F: number, Q: number): number => (m * Q) / F;

/** USDT equity of a linear position (coin size q) at mark F: IM(usdt) + pnl. */
function linearEquity(F: number, side: 'long' | 'short', q: number): number {
  const s = side === 'long' ? 1 : -1;
  return (q * F0) / L + s * q * (F - F0);
}
const linearMM = (F: number, q: number): number => m * q * F;

describe('liquidationPrice — the definitional property (equity == maintenance margin at the mark)', () => {
  it('inverse (coin-margined) long & short land exactly where equity meets maintenance margin', () => {
    const Q = 1_000; // USD notional (the price is size-independent; used only to check equity == MM)
    for (const side of ['long', 'short'] as const) {
      const r = liquidationPrice({
        margin: 'inverse',
        entryPrice: F0,
        leverage: L,
        maintenanceMarginRate: m,
        side,
      });
      const F = r.value.liquidationPrice;
      expect(inverseEquity(F, side, Q)).toBeCloseTo(inverseMM(F, Q), 10);
      // Bankruptcy: equity == 0.
      expect(inverseEquity(r.value.bankruptcyPrice, side, Q)).toBeCloseTo(0, 10);
      // Direction: long liquidates below entry, short above.
      if (side === 'long') expect(F).toBeLessThan(F0);
      else expect(F).toBeGreaterThan(F0);
    }
  });

  it('linear (USDT-margined) long & short land exactly where equity meets maintenance margin', () => {
    const q = 1; // coin size
    for (const side of ['long', 'short'] as const) {
      const r = liquidationPrice({
        margin: 'linear',
        entryPrice: F0,
        leverage: L,
        maintenanceMarginRate: m,
        side,
      });
      const F = r.value.liquidationPrice;
      expect(linearEquity(F, side, q)).toBeCloseTo(linearMM(F, q), 8);
      expect(linearEquity(r.value.bankruptcyPrice, side, q)).toBeCloseTo(0, 8);
      if (side === 'long') expect(F).toBeLessThan(F0);
      else expect(F).toBeGreaterThan(F0);
    }
  });

  it('matches the closed forms and reports IMR + distance', () => {
    const invLong = liquidationPrice({
      margin: 'inverse',
      entryPrice: F0,
      leverage: L,
      maintenanceMarginRate: m,
    });
    expect(invLong.value.liquidationPrice).toBeCloseTo((F0 * (1 + m)) / (1 + 1 / L), 8); // 45681.82
    expect(invLong.value.initialMarginRate).toBeCloseTo(1 / L, 12); // 0.1
    expect(invLong.value.distanceToLiquidation).toBeCloseTo(
      (F0 - invLong.value.liquidationPrice) / F0,
      12,
    );

    const linShort = liquidationPrice({
      margin: 'linear',
      entryPrice: F0,
      leverage: L,
      maintenanceMarginRate: m,
      side: 'short',
    });
    expect(linShort.value.liquidationPrice).toBeCloseTo((F0 * (1 + 1 / L)) / (1 + m), 8); // 54726.37
  });

  it('the liquidation price sits between entry and bankruptcy (the maintenance buffer)', () => {
    // Long: entry > liquidation > bankruptcy (all as price falls). Short: mirror.
    const long = liquidationPrice({
      margin: 'inverse',
      entryPrice: F0,
      leverage: L,
      maintenanceMarginRate: m,
    });
    expect(long.value.liquidationPrice).toBeLessThan(F0);
    expect(long.value.bankruptcyPrice).toBeLessThan(long.value.liquidationPrice);

    const short = liquidationPrice({
      margin: 'linear',
      entryPrice: F0,
      leverage: L,
      maintenanceMarginRate: m,
      side: 'short',
    });
    expect(short.value.liquidationPrice).toBeGreaterThan(F0);
    expect(short.value.bankruptcyPrice).toBeGreaterThan(short.value.liquidationPrice);
  });

  it('is independent of position size and monotonic in leverage (higher L ⇒ closer liquidation)', () => {
    const at = (lev: number) =>
      liquidationPrice({
        margin: 'inverse',
        entryPrice: F0,
        leverage: lev,
        maintenanceMarginRate: m,
      }).value.distanceToLiquidation;
    expect(at(20)).toBeLessThan(at(10)); // 20× liquidates on a smaller move than 10×
    expect(at(10)).toBeLessThan(at(2));
  });
});

describe('liquidationPrice — envelope & guards', () => {
  it('discloses the isolated / mark-based convention in assumptions', () => {
    const r = liquidationPrice({
      margin: 'inverse',
      entryPrice: F0,
      leverage: L,
      maintenanceMarginRate: m,
      side: 'short',
    });
    expect(r.assumptions.conventionsVersion).toBeTruthy();
    expect(r.assumptions.margin).toBe('inverse');
    expect(r.assumptions.side).toBe('short');
    expect(r.assumptions.maintenanceMarginRate).toBe(m);
    expect(r.assumptions.marginBasis).toMatch(/isolated/);
    expect(r.diagnostics.converged).toBe(true);
  });

  it('rejects garbage (typed errors, never a raw crash)', () => {
    expect(() => liquidationPrice(undefined as never)).toThrowError();
    // leverage must be > 1 (degenerate at ≤1×)
    expect(() =>
      liquidationPrice({
        margin: 'inverse',
        entryPrice: F0,
        leverage: 1,
        maintenanceMarginRate: m,
      }),
    ).toThrow(/leverage must be > 1/);
    // maintenance margin rate out of [0, 1)
    expect(() =>
      liquidationPrice({
        margin: 'inverse',
        entryPrice: F0,
        leverage: L,
        maintenanceMarginRate: 1,
      }),
    ).toThrow(/maintenanceMarginRate/);
    // unknown margin mode / unknown key / bad price
    expect(() =>
      liquidationPrice({
        margin: 'cross' as never,
        entryPrice: F0,
        leverage: L,
        maintenanceMarginRate: m,
      }),
    ).toThrow();
    expect(() =>
      liquidationPrice({
        margin: 'inverse',
        entryPrice: F0,
        leverage: L,
        maintenanceMarginRate: m,
        bogus: 1,
      } as never),
    ).toThrow();
    let caught: unknown;
    try {
      liquidationPrice({
        margin: 'inverse',
        entryPrice: -1,
        leverage: L,
        maintenanceMarginRate: m,
      });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught)).toBe(true);
  });
});

/**
 * [review-1] `liquidationPrice` returned its envelope directly, skipping `finalizeResult`. A linear
 * short multiplies the entry price by `(1 + 1/leverage)`, so an entry near the top of IEEE-754 range
 * overflows — and used to be reported as a successful `liquidationPrice: Infinity`.
 */
describe('Law 7 postcondition — liquidationPrice is finalized', () => {
  it('an overflowing liquidation price fails loudly instead of returning Infinity', () => {
    let caught: unknown;
    try {
      liquidationPrice({
        margin: 'linear',
        side: 'short',
        entryPrice: 1.5e308, // positive and finite; ×1.5 is not
        leverage: 2,
        maintenanceMarginRate: 0.005,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PostconditionError);
    expect((caught as Error).message).toMatch(/liquidationPrice/);
  });

  it('a normal position is unaffected', () => {
    const r = liquidationPrice({
      margin: 'linear',
      side: 'short',
      entryPrice: F0,
      leverage: L,
      maintenanceMarginRate: m,
    });
    expect(r.value.liquidationPrice).toBeGreaterThan(F0); // a short liquidates above entry
    expect(Number.isFinite(r.value.bankruptcyPrice)).toBe(true);
  });
});
