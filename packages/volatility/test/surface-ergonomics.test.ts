/**
 * Volatility-surface ergonomics (spec WS4.4): `shock`, `toRows`, and `toJSON`/`fromJSON` round-trips.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import {
  type OptionQuote,
  type OptionType,
  optionExpiryToMs,
  yearFraction,
} from '@totalfinance/core';
import { type HestonParameters } from '@totalfinance/options';
import { hestonImpliedVolatility } from '@totalfinance/options/heston';
import {
  SURFACE_SCHEMA_VERSION,
  type SVIParameters,
  type SurfaceModel,
  VolatilitySurface,
  volatilitySurface,
} from '@totalfinance/volatility';
import { sviVolatility } from '@totalfinance/volatility/svi';

const asOf = Date.UTC(2026, 0, 1);
const spot = 100;
const rate = 0.03;
const E0 = '2026-04-02';
const E1 = '2026-07-02';
const tOf = (e: string): number => yearFraction(asOf, optionExpiryToMs(e), 'ACT/365F');
const fwdOf = (timeToExpiryYears: number): number => spot * Math.exp(rate * timeToExpiryYears);

function quote(
  type: OptionType,
  strike: number,
  expiry: string,
  impliedVolatility: number,
): OptionQuote {
  return {
    contract: {
      underlying: 'X',
      type,
      style: 'european',
      strike,
      expiry,
      ...resolvedExpiry(expiry),
    },
    timestampMs: asOf,
    impliedVolatility,
    underlyingPrice: spot,
  };
}

const SVI_SHAPE: SVIParameters = { a: 0.01, b: 0.07, rho: -0.4, m: 0, sigma: 0.08 };
const STRIKES = [80, 85, 90, 95, 100, 105, 110, 115, 120];

function sviChain(expiries: string[] = [E0]): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const e of expiries) {
    const t = tOf(e);
    const F = fwdOf(t);
    for (const k of STRIKES)
      rows.push(quote('call', k, e, sviVolatility(SVI_SHAPE, Math.log(k / F), t)));
  }
  return rows;
}

const HESTON_TRUE: HestonParameters = { v0: 0.04, kappa: 1.5, theta: 0.045, sigma: 0.3, rho: -0.6 };
function hestonChain(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const e of [E0, E1]) {
    const t = tOf(e);
    for (const k of [90, 95, 100, 105, 110]) {
      const impliedVolatility = hestonImpliedVolatility({
        type: 'call',
        input: { spot, strike: k, timeToExpiryYears: t, riskFreeRate: rate, dividendYield: 0 },
        parameters: HESTON_TRUE,
      }).value;
      rows.push(quote('call', k, e, impliedVolatility));
    }
  }
  return rows;
}

describe('VolatilitySurface#shock', () => {
  it('parallel shift adds the constant to every stored IV (raw + interpolated), to ~1e-9', () => {
    for (const model of ['raw', 'interpolated'] as const) {
      const surf = volatilitySurface({
        quotes: sviChain(),
        market: { riskFreeRate: rate, asOf, spot },
        config: { model },
      });
      const shocked = surf.shock({ parallel: 0.02 });
      expect(shocked.model).toBe(model); // non-parametric model preserved
      for (const k of STRIKES) {
        expect(
          Math.abs(shocked.impliedVolatility(k, E0) - (surf.impliedVolatility(k, E0) + 0.02)),
        ).toBeLessThan(1e-9);
      }
      expect(shocked.assumptions.shock).toEqual({ parallel: 0.02, skewTilt: 0, sticky: 'strike' });
    }
  });

  it('skewTilt rotates the smile by tilt·ln(K/F) at each stored strike', () => {
    const surf = volatilitySurface({
      quotes: sviChain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'interpolated' },
    });
    const F = fwdOf(tOf(E0));
    const shocked = surf.shock({ skewTilt: 0.1 });
    for (const k of STRIKES) {
      const expected = surf.impliedVolatility(k, E0) + 0.1 * Math.log(k / F);
      expect(Math.abs(shocked.impliedVolatility(k, E0) - expected)).toBeLessThan(1e-9);
    }
  });

  it('does not mutate the source surface', () => {
    const surf = volatilitySurface({
      quotes: sviChain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'interpolated' },
    });
    const before = surf.impliedVolatility(100, E0);
    surf.shock({ parallel: 0.05 });
    expect(surf.impliedVolatility(100, E0)).toBe(before);
    expect(surf.assumptions.shock).toBeUndefined();
  });

  it('parametric models degrade to interpolated with a warn + assumptions echo', () => {
    for (const model of ['svi', 'sabr'] as const) {
      const surf = volatilitySurface({
        quotes: sviChain(),
        market: { riskFreeRate: rate, asOf, spot },
        config: { model },
      });
      const shocked = surf.shock({ parallel: 0.01 });
      expect(shocked.model).toBe('interpolated');
      expect(shocked.diagnostics.method).toBe('pchip+total-variance');
      const w = shocked.diagnostics.warnings.find(
        (x) => x.code === 'volatility.shock_degraded_to_interpolated',
      );
      expect(w).toBeDefined();
      expect(w!.severity).toBe('warn');
      expect(shocked.assumptions.shock).toEqual({ parallel: 0.01, skewTilt: 0, sticky: 'strike' });
      // sampled-and-shifted: at a stored strike the shocked IV is the fitted smile + 0.01
      for (const k of STRIKES) {
        expect(
          Math.abs(shocked.impliedVolatility(k, E0) - (surf.impliedVolatility(k, E0) + 0.01)),
        ).toBeLessThan(1e-9);
      }
    }
  });

  it('heston shock degrades to interpolated and samples the global smile', () => {
    const surf = volatilitySurface({
      quotes: hestonChain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'heston' },
    });
    const shocked = surf.shock({ parallel: 0.03 });
    expect(shocked.model).toBe('interpolated');
    expect(
      shocked.diagnostics.warnings.some(
        (x) => x.code === 'volatility.shock_degraded_to_interpolated',
      ),
    ).toBe(true);
    for (const k of [95, 100, 105]) {
      expect(
        Math.abs(shocked.impliedVolatility(k, E0) - (surf.impliedVolatility(k, E0) + 0.03)),
      ).toBeLessThan(1e-9);
    }
  });

  it('records the requested sticky mode in assumptions', () => {
    const surf = volatilitySurface({
      quotes: sviChain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'interpolated' },
    });
    const shocked = surf.shock({ parallel: 0.01 }, { sticky: 'moneyness' });
    expect(shocked.assumptions.shock?.sticky).toBe('moneyness');
  });
});

describe('VolatilitySurface#toRows', () => {
  it('emits one row per (slice, stored strike) with correct log-moneyness', () => {
    const surf = volatilitySurface({
      quotes: sviChain([E0, E1]),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'interpolated' },
    });
    const rows = surf.toRows();
    expect(rows.length).toBe(STRIKES.length * 2);
    const F = fwdOf(tOf(E0));
    const row = rows.find((r) => r.expiry === E0 && r.strike === 100)!;
    expect(row.logMoneyness).toBeCloseTo(Math.log(100 / F), 12);
    expect(typeof row.impliedVolatility).toBe('number');
    expect(typeof row.delta).toBe('number');
  });

  it('maps a non-finite stored impliedVolatility/delta to null (never NaN, never omitted)', () => {
    const surf = volatilitySurface({
      quotes: sviChain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'interpolated' },
    });
    surf.slices[0]!.impliedVolatilities[0] = NaN;
    surf.slices[0]!.deltas[0] = Number.POSITIVE_INFINITY;
    const rows = surf.toRows();
    expect(rows.length).toBe(STRIKES.length);
    const bad = rows.find((r) => r.strike === STRIKES[0])!;
    expect(bad.impliedVolatility).toBeNull();
    expect(bad.delta).toBeNull();
    expect(bad.strike).toBe(STRIKES[0]); // strike itself is always present
    // other rows remain finite numbers
    const good = rows.find((r) => r.strike === 100)!;
    expect(Number.isFinite(good.impliedVolatility)).toBe(true);
  });
});

describe('VolatilitySurface toJSON / fromJSON', () => {
  const cases: Array<{ model: SurfaceModel; chain: () => OptionQuote[] }> = [
    { model: 'raw', chain: () => sviChain([E0, E1]) },
    { model: 'interpolated', chain: () => sviChain([E0, E1]) },
    { model: 'smoothed', chain: () => sviChain([E0, E1]) },
    { model: 'svi', chain: () => sviChain([E0, E1]) },
    { model: 'sabr', chain: () => sviChain([E0, E1]) },
    { model: 'heston', chain: hestonChain },
  ];

  for (const { model, chain } of cases) {
    it(`restores '${model}' identically (impliedVolatility byte-for-byte)`, () => {
      const surf = volatilitySurface({
        quotes: chain(),
        market: { riskFreeRate: rate, asOf, spot },
        config: { model },
      });
      const snap = surf.toJSON();
      expect(snap.schemaVersion).toBe(SURFACE_SCHEMA_VERSION);
      expect(snap.model).toBe(model);

      const restored = VolatilitySurface.fromJSON(snap);
      for (const e of [E0, E1]) {
        for (const k of [92, 100, 108]) {
          expect(restored.impliedVolatility(k, e)).toBe(surf.impliedVolatility(k, e));
        }
      }

      // JSON-safe: a stringify/parse cycle leaks no closures and restores identically.
      const restored2 = VolatilitySurface.fromJSON(JSON.parse(JSON.stringify(snap)) as typeof snap);
      expect(restored2.impliedVolatility(100, E0)).toBe(surf.impliedVolatility(100, E0));
    });
  }

  it('preserves the global heston parameters on restore', () => {
    const surf = volatilitySurface({
      quotes: hestonChain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'heston' },
    });
    const restored = VolatilitySurface.fromJSON(surf.toJSON());
    expect(restored.heston).toEqual(surf.heston);
  });

  it('throws an InputError on a schema-version mismatch', () => {
    const surf = volatilitySurface({
      quotes: sviChain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'interpolated' },
    });
    const snap = surf.toJSON();
    const bad = { ...snap, schemaVersion: '999' };
    expect(() => VolatilitySurface.fromJSON(bad)).toThrow(/schemaVersion/i);
  });

  // Regression for an external-review finding: toJSON used a shallow `{ ...s }` spread, so the
  // snapshot's slice arrays and diagnostics were LIVE references to the surface's own state — mutating
  // the snapshot would corrupt the surface (and vice versa). The snapshot must be an independent value.
  it('toJSON returns an independent snapshot — no shared array / object references', () => {
    const surf = volatilitySurface({
      quotes: sviChain([E0, E1]),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
    const snap = surf.toJSON();

    // Deep copies, not the live surface's own references…
    expect(snap.slices[0]!.impliedVolatilities).not.toBe(surf.slices[0]!.impliedVolatilities);
    expect(snap.slices[0]!.strikes).not.toBe(surf.slices[0]!.strikes);
    expect(snap.slices[0]!.deltas).not.toBe(surf.slices[0]!.deltas);
    expect(snap.diagnostics).not.toBe(surf.diagnostics);
    expect(snap.diagnostics.warnings).not.toBe(surf.diagnostics.warnings);
    if (surf.slices[0]!.svi) expect(snap.slices[0]!.svi).not.toBe(surf.slices[0]!.svi);
    // …but faithful copies by value.
    expect(snap.slices[0]!.impliedVolatilities).toEqual(surf.slices[0]!.impliedVolatilities);

    // Mutating the snapshot cannot reach back into the live surface.
    snap.slices[0]!.impliedVolatilities[0] = 999;
    expect(surf.slices[0]!.impliedVolatilities[0]).not.toBe(999);
  });

  it('fromJSON yields a surface that owns its state (independent of the source snapshot)', () => {
    const surf = volatilitySurface({
      quotes: sviChain([E0, E1]),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
    const snap = surf.toJSON();
    const restored = VolatilitySurface.fromJSON(snap);
    expect(restored.slices[0]!.impliedVolatilities).not.toBe(snap.slices[0]!.impliedVolatilities);
    expect(restored.diagnostics.warnings).not.toBe(snap.diagnostics.warnings);
  });

  it('round-trips a shocked surface too', () => {
    const surf = volatilitySurface({
      quotes: sviChain([E0, E1]),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
    const shocked = surf.shock({ parallel: 0.02, skewTilt: 0.05 });
    const restored = VolatilitySurface.fromJSON(shocked.toJSON());
    for (const e of [E0, E1]) {
      for (const k of [92, 100, 108]) {
        expect(restored.impliedVolatility(k, e)).toBe(shocked.impliedVolatility(k, e));
      }
    }
    expect(restored.assumptions.shock).toEqual(shocked.assumptions.shock);
  });
});
