/**
 * Inverse (coin-margined / Deribit-style) futures & the coin-delta hedge (`inverseFuture`, `inverseHedge`).
 * The coin PnL `s·Q·(1/entry − 1/mark)` and its coin greeks are pinned to a finite-difference (long &
 * short), the long inverse future is confirmed short-gamma-in-coin, and — the point of the feature — the
 * hedge is shown to neutralize a real `inverseOption` coin delta to exactly 0 (cross-package integration).
 */

import { describe, expect, it } from 'vitest';
import { PostconditionError } from '@totalfinance/core';
import { inverseFuture, inverseHedge } from '@totalfinance/crypto';
import { inverseOption } from '@totalfinance/options';

const BASE = { notionalUsd: 50000, entryPrice: 60000, markPrice: 62000 } as const;

describe('inverseFuture', () => {
  it('reports the coin PnL, usdPnl, and coin exposure with the side sign', () => {
    const long = inverseFuture(BASE);
    expect(long.value.coinPnl).toBeCloseTo(50000 * (1 / 60000 - 1 / 62000), 12);
    expect(long.value.usdPnl).toBeCloseTo(long.value.coinPnl * 62000, 8);
    expect(long.value.coinExposure).toBeCloseTo(50000 / 62000, 12); // ~0.806 BTC long
    // A short is the exact negative.
    const short = inverseFuture({ ...BASE, side: 'short' });
    expect(short.value.coinPnl).toBeCloseTo(-long.value.coinPnl, 12);
    expect(short.value.coinExposure).toBeCloseTo(-long.value.coinExposure, 12);
  });

  it('matches a finite-difference for coin delta and gamma, and is short gamma in coin when long', () => {
    for (const side of ['long', 'short'] as const) {
      const f = inverseFuture({ ...BASE, side });
      const pnl = (F: number) => inverseFuture({ ...BASE, side, markPrice: F }).value.coinPnl;
      const h = BASE.markPrice * 1e-6;
      const fdDelta = (pnl(BASE.markPrice + h) - pnl(BASE.markPrice - h)) / (2 * h);
      const fdGamma =
        (pnl(BASE.markPrice + h) - 2 * pnl(BASE.markPrice) + pnl(BASE.markPrice - h)) / (h * h);
      expect(Math.abs(f.value.coinDelta - fdDelta)).toBeLessThan(1e-4 * Math.abs(fdDelta) + 1e-13);
      expect(Math.abs(f.value.coinGamma - fdGamma)).toBeLessThan(1e-4 * Math.abs(fdGamma) + 1e-13);
    }
    // A LONG inverse future is short gamma in coin; a short is long gamma.
    expect(inverseFuture(BASE).value.coinGamma).toBeLessThan(0);
    expect(inverseFuture({ ...BASE, side: 'short' }).value.coinGamma).toBeGreaterThan(0);
  });

  it('has zero PnL at entry and a constant USD delta (Q/entry) despite the non-constant coin delta', () => {
    expect(inverseFuture({ ...BASE, markPrice: BASE.entryPrice }).value.coinPnl).toBe(0);
    // usdPnl(F) = Q(F/F0 − 1) ⇒ ∂/∂F = Q/F0, constant — the linear-vs-inverse contrast.
    const a = inverseFuture({ ...BASE, markPrice: 61000 }).value.usdPnl;
    const b = inverseFuture({ ...BASE, markPrice: 63000 }).value.usdPnl;
    expect((b - a) / 2000).toBeCloseTo(BASE.notionalUsd / BASE.entryPrice, 8);
  });

  it('guards a bad input, non-positive scalars, and a bad side', () => {
    expect(() => inverseFuture(undefined as never)).toThrowError();
    expect(() => inverseFuture({ ...BASE, notionalUsd: 0 })).toThrowError();
    expect(() => inverseFuture({ ...BASE, entryPrice: -1 })).toThrowError();
    expect(() => inverseFuture({ ...BASE, markPrice: 0 })).toThrowError();
    expect(() => inverseFuture({ ...BASE, side: 'sideways' as never })).toThrowError();
  });
});

describe('inverseHedge', () => {
  it('sizes the future to |D|·F² and reports an equal-and-opposite coin delta', () => {
    const D = 6.27e-6;
    const F = 60000;
    const h = inverseHedge({ coinDelta: D, markPrice: F });
    expect(h.value.notionalUsd).toBeCloseTo(D * F * F, 6);
    expect(h.value.side).toBe('short'); // positive delta ⇒ sell the future
    expect(h.value.hedgeCoinDelta).toBeCloseTo(-D, 15);
    // A negative delta flips the side to long.
    expect(inverseHedge({ coinDelta: -D, markPrice: F }).value.side).toBe('long');
  });

  it('reports the residual coin gamma after the delta hedge when the position gamma is supplied', () => {
    const D = 6.27e-6,
      G = 1.2e-11,
      F = 60000;
    const h = inverseHedge({ coinDelta: D, markPrice: F, coinGamma: G });
    // The sold future adds +gamma (a short inverse future is long gamma), so the residual exceeds G.
    const hedgeGamma = h.value.residualCoinGamma! - G;
    expect(hedgeGamma).toBeGreaterThan(0);
    expect(h.value.residualCoinGamma).toBeGreaterThan(G);
  });

  it('is a no-op for a zero coin delta', () => {
    const h = inverseHedge({ coinDelta: 0, markPrice: 60000 });
    expect(h.value.notionalUsd).toBe(0);
    expect(h.value.hedgeCoinDelta).toBe(0);
    expect(h.value.side).toBe('long'); // arbitrary sign choice for the zero case, disclosed
  });

  it('neutralizes a real inverse-option coin delta to zero (cross-package hedge)', () => {
    const opt = {
      spot: 60000,
      strike: 65000,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.05,
      coinYield: 0.01,
      volatility: 0.7,
    };
    for (const type of ['call', 'put'] as const) {
      const g = inverseOption.greeks({ ...opt, type }).value;
      const h = inverseHedge({
        coinDelta: g.coin.delta,
        markPrice: opt.spot,
        coinGamma: g.coin.gamma,
      });
      // Combined coin delta after adding the sized hedge is exactly zero.
      expect(g.coin.delta + h.value.hedgeCoinDelta).toBeCloseTo(0, 18);
      expect(h.value.residualCoinGamma).toBeDefined();
    }
  });

  it('guards a bad input, a non-finite delta/gamma, and a non-positive mark', () => {
    expect(() => inverseHedge(undefined as never)).toThrowError();
    expect(() => inverseHedge({ coinDelta: NaN, markPrice: 60000 })).toThrowError();
    expect(() => inverseHedge({ coinDelta: 1e-6, markPrice: 0 })).toThrowError();
    expect(() =>
      inverseHedge({ coinDelta: 1e-6, markPrice: 60000, coinGamma: Infinity }),
    ).toThrowError();
  });
});

/**
 * [review-1] Both inverse facades returned their envelope directly, skipping `finalizeResult`. The
 * coin greeks divide by `mark²`/`mark³`, so an accepted-but-extreme quote overflows — and used to
 * be reported as a successful `coinGamma: Infinity`.
 */
describe('Law 7 postcondition — the inverse facades are finalized', () => {
  it('inverseFuture: an overflowing coin gamma fails loudly', () => {
    let caught: unknown;
    try {
      // Every input passes its own guard (all positive, all finite): 1e300 USD of notional against
      // a $0.001 mark makes coinGamma = 2Q/F³ = 2e309 — outside IEEE-754 range.
      inverseFuture({ notionalUsd: 1e300, entryPrice: 1, markPrice: 1e-3 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PostconditionError);
    expect((caught as Error).message).toMatch(/inverseFuture/);
    expect((caught as Error).message).toMatch(/coinGamma/);
  });

  it('inverseHedge: an overflowing hedge notional fails loudly', () => {
    expect(() => inverseHedge({ coinDelta: 1e300, markPrice: 1e10 })).toThrow(PostconditionError);
  });

  it('ordinary quotes are unaffected by the postcondition', () => {
    expect(inverseFuture(BASE).value.coinGamma).toBeLessThan(0); // long ⇒ short gamma in coin
    expect(inverseHedge({ coinDelta: 0.5, markPrice: 60000 }).value.notionalUsd).toBeCloseTo(
      0.5 * 60000 * 60000,
      6,
    );
  });
});
