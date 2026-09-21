import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import { InputError, type OptionQuote } from '@totalfinance/core';
import { type SVIParameters, sviVolatility } from '@totalfinance/volatility/svi';
import {
  type ArbitrageSlice,
  arbitrageReport,
  checkButterfly,
  checkCalendar,
  surfaceArbitrageReport,
} from '@totalfinance/volatility/arbitrage';
import { volatilitySurface } from '@totalfinance/volatility';

function sliceFrom(
  expiry: string,
  timeToExpiryYears: number,
  forward: number,
  p: SVIParameters,
  kLo = -0.4,
  kHi = 0.4,
): ArbitrageSlice {
  return {
    expiry,
    timeToExpiryYears,
    forward,
    impliedVolatility: (K: number) => sviVolatility(p, Math.log(K / forward), timeToExpiryYears),
    strikeRange: [forward * Math.exp(kLo), forward * Math.exp(kHi)],
  };
}

describe('surface arbitrage — clean surface', () => {
  it('passes both checks when total variance grows with maturity and each smile is convex', () => {
    const s1 = sliceFrom('2026-04-17', 0.25, 100, { a: 0.02, b: 0.1, rho: -0.3, m: 0, sigma: 0.1 });
    const s2 = sliceFrom('2026-07-17', 1.0, 100, {
      a: 0.06,
      b: 0.18,
      rho: -0.3,
      m: 0,
      sigma: 0.12,
    });
    const report = arbitrageReport([s1, s2]);
    expect(report.arbitrageFree).toBe(true);
    expect(report.checks.calendar).toBe(true);
    expect(report.checks.butterfly).toBe(true);
    expect(report.violations).toHaveLength(0);
  });
});

describe('surface arbitrage — calendar violation', () => {
  it('flags total variance that falls with maturity', () => {
    const short = sliceFrom('2026-04-17', 0.25, 100, {
      a: 0.1,
      b: 0.2,
      rho: -0.3,
      m: 0,
      sigma: 0.1,
    });
    const long = sliceFrom('2026-07-17', 1.0, 100, {
      a: 0.02,
      b: 0.1,
      rho: -0.3,
      m: 0,
      sigma: 0.1,
    });
    const report = arbitrageReport([short, long]);
    expect(report.checks.calendar).toBe(false);
    const v = report.violations.find((x) => x.kind === 'calendar');
    expect(v).toBeDefined();
    expect(v!.expiry).toBe('2026-07-17');
    expect(v!.magnitude).toBeGreaterThan(0);

    // the direct check agrees (envelope-shaped: the violations are the value)
    expect(checkCalendar([short, long]).value.length).toBeGreaterThan(0);
  });
});

describe('surface arbitrage — butterfly violation', () => {
  it('flags a smile whose implied density goes negative', () => {
    const bad = sliceFrom('2026-04-17', 0.5, 100, {
      a: 0.01,
      b: 2.5,
      rho: -0.9,
      m: 0,
      sigma: 0.02,
    });
    const report = arbitrageReport([bad]);
    expect(report.checks.butterfly).toBe(false);
    const v = report.violations.find((x) => x.kind === 'butterfly');
    expect(v).toBeDefined();
    expect(v!.magnitude).toBeLessThan(0); // most-negative g(k)

    expect(checkButterfly(bad).value.length).toBeGreaterThan(0);
  });

  it('a well-behaved smile passes the butterfly check', () => {
    const good = sliceFrom('2026-04-17', 0.5, 100, {
      a: 0.04,
      b: 0.4,
      rho: -0.4,
      m: 0.05,
      sigma: 0.15,
    });
    expect(checkButterfly(good).value).toHaveLength(0);
  });
});

describe('surface arbitrage — knob validation (no false passes)', () => {
  // a known butterfly-arbitrageable slice
  const bad = sliceFrom('2026-04-17', 0.5, 100, { a: 0.01, b: 2.5, rho: -0.9, m: 0, sigma: 0.02 });

  it('rejects degenerate knobs that would skip the violation', () => {
    expect(() => checkButterfly(bad, { step: 0 })).toThrow(InputError);
    expect(() => checkButterfly(bad, { butterflyPoints: 1 })).toThrow(InputError);
    expect(() => checkCalendar([bad, bad], { calendarPoints: 1 })).toThrow(InputError);
    expect(() => checkButterfly(bad, { tolerance: -1 })).toThrow(InputError);
    expect(() => arbitrageReport([bad], { step: Number.NaN })).toThrow(InputError);
  });

  it('rejects knobs from the other check instead of accepting an ignored option', () => {
    expect(() => checkButterfly(bad, { calendarPoints: 21 } as never)).toThrow(
      /unknown field.*calendarPoints/s,
    );
    expect(() => checkCalendar([bad, bad], { butterflyPoints: 40 } as never)).toThrow(
      /unknown field.*butterflyPoints/s,
    );
    // The combined report intentionally owns both controls.
    expect(() =>
      arbitrageReport([bad, bad], { butterflyPoints: 40, calendarPoints: 21 }),
    ).not.toThrow();
  });
});

describe('surfaceArbitrageReport — the report owns its warnings', () => {
  // Review finding: the report aliased the surface's LIVE diagnostics array, so pushing into
  // the report's warnings silently mutated the surface's own diagnostics. (Report grammar: the
  // carried-through surface warnings live in diagnostics.warnings.)
  it('mutating the report warnings does not mutate the surface diagnostics', () => {
    const asOf = Date.UTC(2026, 0, 1);
    const quotes: OptionQuote[] = [90, 95, 100, 105, 110].map((strike) => ({
      contract: {
        underlying: 'X',
        type: 'call',
        style: 'european',
        strike,
        expiry: '2026-04-17',
        ...resolvedExpiry('2026-04-17'),
      },
      timestampMs: asOf,
      impliedVolatility: 0.2 + Math.abs(strike - 100) * 0.002,
      underlyingPrice: 100,
    }));
    const surface = volatilitySurface({
      quotes,
      market: { spot: 100, riskFreeRate: 0.03, asOf },
    });
    const before = surface.diagnostics.warnings.length;
    const report = surfaceArbitrageReport(surface);
    expect(report.diagnostics.warnings).toEqual(surface.diagnostics.warnings); // same content…
    report.diagnostics.warnings.push({ code: 'test.mutation', message: 'probe', severity: 'info' });
    expect(surface.diagnostics.warnings.length).toBe(before); // …but not the same array
  });
});
