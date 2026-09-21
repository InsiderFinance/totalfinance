import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import {
  InputError,
  type OptionQuote,
  type OptionType,
  optionExpiryToMs,
  yearFraction,
} from '@totalfinance/core';
import { type SabrParameters } from '@totalfinance/options';
import { sabrVolatility } from '@totalfinance/options/sabr';
import {
  type SVIParameters,
  type SurfaceConfig,
  volatilitySurface,
} from '@totalfinance/volatility';
import { sviVolatility } from '@totalfinance/volatility/svi';

const asOf = Date.UTC(2026, 0, 1);
const spot = 100;
const rate = 0.03;
const E0 = '2026-04-02';
const E1 = '2026-07-02';
const STRIKES = [80, 85, 90, 95, 100, 105, 110, 115, 120];

const tOf = (expiry: string): number => yearFraction(asOf, optionExpiryToMs(expiry), 'ACT/365F');
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

describe('VolatilitySurface model: svi', () => {
  // arbitrage-free SVI smiles, total variance growing with maturity (calendar-safe)
  const P: Record<string, SVIParameters> = {
    [E0]: { a: 0.008, b: 0.06, rho: -0.4, m: 0, sigma: 0.08 },
    [E1]: { a: 0.018, b: 0.1, rho: -0.4, m: 0, sigma: 0.1 },
  };
  const chain = (): OptionQuote[] => {
    const rows: OptionQuote[] = [];
    for (const e of [E0, E1]) {
      const t = tOf(e);
      const F = fwdOf(t);
      for (const k of STRIKES) {
        const impliedVolatility = sviVolatility(P[e]!, Math.log(k / F), t);
        rows.push(quote('call', k, e, impliedVolatility), quote('put', k, e, impliedVolatility));
      }
    }
    return rows;
  };

  it('fits and stores per-expiry SVI parameters and reprices the input smile', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
    expect(surf.diagnostics.method).toBe('svi+total-variance');
    const s0 = surf.slice(E0)!;
    expect(s0.svi).toBeDefined();

    const t0 = tOf(E0);
    const F0 = fwdOf(t0);
    for (const k of [85, 100, 115]) {
      expect(surf.impliedVolatility(k, E0)).toBeCloseTo(
        sviVolatility(P[E0]!, Math.log(k / F0), t0),
        4,
      );
    }
  });

  it('is arbitrage-free via the built-in report', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
    const report = surf.arbitrage();
    expect(report.checks.calendar).toBe(true);
    expect(report.checks.butterfly).toBe(true);
    expect(report.arbitrageFree).toBe(true);
  });

  it('builds a same-day 0DTE surface — a date-only expiry resolves to 16:00 ET, not UTC midnight', () => {
    // asOf sits *after* the expiry date's 00:00 UTC but *before* its 16:00 ET options close.
    const asOf0 = Date.UTC(2026, 0, 16, 14, 0, 0);
    const expiry = '2026-01-16';
    const t = yearFraction(asOf0, optionExpiryToMs(expiry), 'ACT/365F');
    expect(t).toBeGreaterThan(0); // positive time-to-expiry under the correct convention
    const F = spot * Math.exp(rate * t);
    const parameters: SVIParameters = { a: 0.0002, b: 0.02, rho: -0.3, m: 0, sigma: 0.05 };
    const rows: OptionQuote[] = [];
    for (const k of STRIKES) {
      const impliedVolatility = sviVolatility(parameters, Math.log(k / F), t);
      rows.push(
        quote('call', k, expiry, impliedVolatility),
        quote('put', k, expiry, impliedVolatility),
      );
    }
    // Under the old UTC-midnight rule every quote would be dropped as expired ⇒ volatilitySurface would throw
    // "no usable quotes". With the 16:00-ET convention the same-day chain builds normally.
    const surf = volatilitySurface({
      quotes: rows,
      market: { riskFreeRate: rate, asOf: asOf0, spot },
      config: { model: 'svi' },
    });
    expect(surf.impliedVolatility(spot, expiry)).toBeGreaterThan(0);
  });

  it('falls back to an interpolated smile (with a warning) when an expiry has too few strikes', () => {
    const t = tOf(E0);
    const F = fwdOf(t);
    const rows: OptionQuote[] = [95, 100, 105].map((k) =>
      quote('call', k, E0, sviVolatility(P[E0]!, Math.log(k / F), t)),
    );
    const surf = volatilitySurface({
      quotes: rows,
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'svi' },
    });
    expect(surf.slice(E0)!.svi).toBeUndefined();
    expect(
      surf.diagnostics.warnings.some((w) => w.code === 'volatility.fit_insufficient_data'),
    ).toBe(true);
    // it still produces a usable smile
    expect(surf.impliedVolatility(100, E0)).toBeGreaterThan(0);
  });
});

describe('VolatilitySurface model: sabr', () => {
  const truth: SabrParameters = { alpha: 0.2, beta: 1, rho: -0.4, nu: 0.5 };
  const chain = (): OptionQuote[] => {
    const rows: OptionQuote[] = [];
    for (const e of [E0, E1]) {
      const t = tOf(e);
      const F = fwdOf(t);
      for (const k of STRIKES) {
        rows.push(
          quote(
            'call',
            k,
            e,
            sabrVolatility({
              input: { forward: F, strike: k, timeToExpiryYears: t },
              parameters: truth,
            }),
          ),
          quote(
            'put',
            k,
            e,
            sabrVolatility({
              input: { forward: F, strike: k, timeToExpiryYears: t },
              parameters: truth,
            }),
          ),
        );
      }
    }
    return rows;
  };

  it('fits and stores per-expiry SABR parameters and reprices the input smile', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'sabr', sabrBeta: 1 },
    });
    expect(surf.diagnostics.method).toBe('sabr(β=1)+total-variance');
    const s0 = surf.slice(E0)!;
    expect(s0.sabr).toBeDefined();
    expect(s0.sabr!.beta).toBe(1);

    const t0 = tOf(E0);
    const F0 = fwdOf(t0);
    for (const k of [85, 100, 115]) {
      expect(surf.impliedVolatility(k, E0)).toBeCloseTo(
        sabrVolatility({
          input: { forward: F0, strike: k, timeToExpiryYears: t0 },
          parameters: truth,
        }),
        4,
      );
    }
  });
});

describe('VolatilitySurface — model validation', () => {
  it('rejects an unknown model instead of silently falling through to interpolation', () => {
    const t = tOf(E0);
    const F = fwdOf(t);
    const rows: OptionQuote[] = STRIKES.map((k) =>
      quote(
        'call',
        k,
        E0,
        sviVolatility({ a: 0.01, b: 0.06, rho: -0.4, m: 0, sigma: 0.08 }, Math.log(k / F), t),
      ),
    );
    expect(() =>
      volatilitySurface({
        quotes: rows,
        market: { riskFreeRate: rate, asOf, spot },
        config: { model: 'svii' } as unknown as SurfaceConfig,
      }),
    ).toThrow(InputError);
  });
});
