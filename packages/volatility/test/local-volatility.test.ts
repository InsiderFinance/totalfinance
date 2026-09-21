/**
 * Tests for §10.1 Dupire local-volatility surface fitting: a flat implied surface yields a flat local
 * surface, a skewed implied surface yields a steeper local skew (Dupire's "rule of two"), the grid
 * cache reproduces the raw transform, and fitting works directly from a calibrated VolatilitySurface.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import type { OptionQuote } from '@totalfinance/core';
import {
  localVolatilitySurface,
  surfaceLocalVolatility,
  volatilitySurface,
} from '@totalfinance/volatility';

const market = { spot: 100, riskFreeRate: 0.02, dividendYield: 0 };

describe('localVolatilitySurface (Dupire)', () => {
  it('a flat implied surface gives a flat local surface ≈ the same vol', () => {
    const lv = localVolatilitySurface({ impliedVolatility: () => 0.2, market });
    for (const [K, t] of [
      [90, 0.5],
      [100, 1],
      [115, 1.5],
    ] as const) {
      expect(lv.localVolatility(K, t)).toBeCloseTo(0.2, 2);
    }
  });

  it('a downward implied skew produces a steeper local-volatility skew', () => {
    // σ_imp(K) decreasing in K (equity skew): local vol skew should be steeper than implied.
    const impl = (K: number): number => 0.2 - 0.1 * Math.log(K / 100);
    const lv = localVolatilitySurface({ impliedVolatility: (K) => impl(K), market });
    const t = 1;
    const localSkew = lv.localVolatility(90, t) - lv.localVolatility(110, t);
    const impliedSkew = impl(90) - impl(110);
    expect(localSkew).toBeGreaterThan(impliedSkew); // Dupire steepens the skew
  });

  it('the grid cache reproduces the raw transform at its knots', () => {
    const lv = localVolatilitySurface({
      impliedVolatility: (K) => 0.2 - 0.05 * Math.log(K / 100),
      market,
    });
    const levels = [80, 90, 100, 110, 120];
    const times = [0.5, 1, 2];
    const grid = lv.grid({ levels, times });
    for (const L of levels) {
      for (const t of times) {
        expect(grid(L, t)).toBeCloseTo(lv.localVolatility(L, t), 8);
      }
    }
  });

  it('fits directly from a calibrated VolatilitySurface', () => {
    const asOf = Date.UTC(2026, 0, 1);
    const quote = (strike: number, impliedVolatility: number): OptionQuote => ({
      contract: {
        underlying: 'X',
        type: 'call',
        style: 'european',
        strike,
        expiry: '2027-01-01',
        ...resolvedExpiry('2027-01-01'),
        multiplier: 100,
      },
      timestampMs: asOf,
      impliedVolatility,
      underlyingPrice: 100,
    });
    const surface = volatilitySurface({
      quotes: [quote(90, 0.24), quote(100, 0.2), quote(110, 0.18), quote(120, 0.17)],
      market: { asOf, spot: 100, riskFreeRate: 0.02 },
      config: { model: 'svi' },
    });
    const lv = surfaceLocalVolatility({ surface, market });
    expect(lv.localVolatility(100, 0.9)).toBeGreaterThan(0); // a finite, positive local vol
    expect(Number.isFinite(lv.localVolatility(95, 0.9))).toBe(true);
  });
});

describe('local-volatility options hardening (deep-sweep boundary)', () => {
  it('localVolatilitySurface and surfaceLocalVolatility reject a null options bag', () => {
    // `null` slips past the `= {}` default parameter (only `undefined` triggers it) and used to die
    // on the first option read inside the Dupire transform.
    expect(() =>
      localVolatilitySurface({
        impliedVolatility: () => 0.2,
        market,
        options: null as never,
      }),
    ).toThrow(/localVolatilitySurface: options must be an object/);
    const surf = volatilitySurface({
      quotes: [95, 100, 105].flatMap((strike) =>
        (['call', 'put'] as const).map((type) => ({
          contract: {
            underlying: 'X',
            type,
            style: 'european' as const,
            strike,
            expiry: '2026-07-02',
            ...resolvedExpiry('2026-07-02'),
          },
          timestampMs: Date.UTC(2026, 0, 2),
          impliedVolatility: 0.2,
          underlyingPrice: 100,
        })),
      ),
      market: { spot: 100, riskFreeRate: 0.02, asOf: Date.UTC(2026, 0, 2) },
    });
    expect(() => surfaceLocalVolatility({ surface: surf, market, options: null as never })).toThrow(
      /surfaceLocalVolatility: options must be an object/,
    );
  });
});
