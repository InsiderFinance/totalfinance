/**
 * WS2.6 — surface lookups must not silently fall back or drop warnings.
 *
 * (a) `impliedVolatilityByMoneyness(..., { forward: true })` on an expiry label that resolves no slice throws
 *     `volatility.forward_unavailable` instead of quietly answering the spot-moneyness question.
 * (b) `lookup()` carries the surface-construction warnings (e.g. `volatility.butterfly_arbitrage`) into its
 *     per-call diagnostics — a query on an arbitrageable slice never presents as clean.
 */

import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import {
  type OptionQuote,
  type OptionType,
  optionExpiryToMs,
  yearFraction,
} from '@totalfinance/core';
import { type SVIParameters, volatilitySurface } from '@totalfinance/volatility';
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

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

function chainFrom(parameters: Record<string, SVIParameters>): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const e of Object.keys(parameters)) {
    const t = tOf(e);
    const F = fwdOf(t);
    for (const k of STRIKES) {
      const impliedVolatility = sviVolatility(parameters[e]!, Math.log(k / F), t);
      rows.push(quote('call', k, e, impliedVolatility), quote('put', k, e, impliedVolatility));
    }
  }
  return rows;
}

// arbitrage-free SVI smiles (calendar-safe: total variance grows with maturity)
const CLEAN: Record<string, SVIParameters> = {
  [E0]: { a: 0.008, b: 0.06, rho: -0.4, m: 0, sigma: 0.08 },
  [E1]: { a: 0.018, b: 0.1, rho: -0.4, m: 0, sigma: 0.1 },
};

// A too-sparse chain: fewer strikes than SVI needs (5) ⇒ construction emits a
// `volatility.fit_insufficient_data` warning and falls back — a deterministic construction warning to
// verify the lookup-merge behavior (independent of any particular fit's arbitrage outcome).
function sparseChain(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const e of [E0, E1]) {
    const t = tOf(e);
    const F = fwdOf(t);
    for (const k of [92, 100, 108]) {
      const impliedVolatility = sviVolatility(CLEAN[e]!, Math.log(k / F), t);
      rows.push(quote('call', k, e, impliedVolatility), quote('put', k, e, impliedVolatility));
    }
  }
  return rows;
}

describe('WS2.6a — forward-moneyness on an unresolvable expiry throws', () => {
  const surf = volatilitySurface({
    quotes: chainFrom(CLEAN),
    market: { riskFreeRate: rate, asOf, spot },
    config: { model: 'svi' },
  });

  it('throws vol.forward_unavailable rather than silently using spot', () => {
    expect(() => surf.impliedVolatilityByMoneyness(1, '2099-12-31', { forward: true })).toThrow(
      /forward/i,
    );
    expect(
      codeOf(() => surf.impliedVolatilityByMoneyness(1, '2099-12-31', { forward: true })),
    ).toBe('volatility.forward_unavailable');
  });

  it('a resolvable expiry answers the forward-moneyness query', () => {
    const atmf = surf.impliedVolatilityByMoneyness(1, E0, { forward: true });
    expect(atmf).toBeGreaterThan(0);
  });
});

describe('WS2.6b — construction warnings taint every lookup', () => {
  const surf = volatilitySurface({
    quotes: sparseChain(),
    market: { riskFreeRate: rate, asOf, spot },
    config: { model: 'svi' },
  });

  it('the surface flagged a construction warning (insufficient data for SVI)', () => {
    expect(
      surf.diagnostics.warnings.some((w) => w.code === 'volatility.fit_insufficient_data'),
    ).toBe(true);
  });

  it('every construction warning is carried into a per-call lookup', () => {
    const construction = surf.diagnostics.warnings;
    expect(construction.length).toBeGreaterThan(0);
    const look = surf.lookup(100, E0);
    for (const w of construction) {
      expect(look.diagnostics.warnings).toContainEqual(w);
    }
    // and specifically the construction warning
    expect(
      look.diagnostics.warnings.some((w) => w.code === 'volatility.fit_insufficient_data'),
    ).toBe(true);
  });
});
