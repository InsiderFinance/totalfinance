import { describe, expect, it } from 'vitest';
import { blackScholes, digital, engines, market, option } from '@totalfinance/options';

/**
 * Alignment spec P2.2 (Law 7) — a valid deep-OTM input whose price underflows to zero must not
 * report a non-finite lambda inside a `converged: true` envelope. Elasticity Λ = Δ·S/V is
 * undefined at V = 0: it is `null`, the envelope stays converged (the PRICE is exact — 0), and a
 * `greeks.lambda_undefined` info warning discloses the hole. JSON-safe by construction.
 */

// Deep OTM: d2 ≈ -47 → price underflows to exactly 0 while delta is a denormal ≈ 0.
const DEEP_OTM = {
  spot: 100,
  strike: 10_000,
  timeToExpiryYears: 0.01,
  riskFreeRate: 0.02,
  volatility: 0.1,
  type: 'call',
} as const;

describe('lambda underflow → null + disclosure (P2.2, Law 7)', () => {
  it('blackScholes.extendedGreeks: plain path yields lambda null (never NaN/Infinity)', () => {
    expect(blackScholes.price(DEEP_OTM)).toBe(0);
    const g = blackScholes.extendedGreeks(DEEP_OTM);
    expect(g.lambda).toBeNull();
    for (const [k, v] of Object.entries(g)) {
      expect(v === null || Number.isFinite(v), `${k} must be finite or null`).toBe(true);
    }
  });

  it('blackScholes.extendedGreeks.explain: converged stays true with the disclosure warning', () => {
    const r = blackScholes.extendedGreeks.explain(DEEP_OTM);
    expect(r.value.lambda).toBeNull();
    expect(r.diagnostics.converged).toBe(true);
    expect(r.diagnostics.warnings.some((w) => w.code === 'greeks.lambda_undefined')).toBe(true);
    // JSON-safe end to end: no NaN/Infinity anywhere in the envelope.
    expect(JSON.parse(JSON.stringify(r)).value.lambda).toBeNull();
  });

  it('a normal contract keeps a finite lambda and no disclosure warning', () => {
    const near = { ...DEEP_OTM, strike: 105 };
    const r = blackScholes.extendedGreeks.explain(near);
    expect(Number.isFinite(r.value.lambda)).toBe(true);
    expect(r.diagnostics.warnings.some((w) => w.code === 'greeks.lambda_undefined')).toBe(false);
  });

  it('the pro path (option.price + extendedGreeks) discloses too', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 10_000,
      expiry: '2026-09-18',
      style: 'european',
    });
    const mkt = market({
      spot: 100,
      riskFreeRate: 0.02,
      volatility: 0.1,
      asOf: Date.UTC(2026, 8, 14),
    });
    const r = option.price({
      contract: c,
      market: mkt,
      engine: engines.blackScholesMerton(),
      extendedGreeks: true,
    });
    if ((r.greeks as { lambda?: number | null }).lambda === null) {
      expect(r.diagnostics.warnings.some((w) => w.code === 'greeks.lambda_undefined')).toBe(true);
    } else {
      // If this market doesn't underflow, the invariant still holds: finite or null.
      expect(Number.isFinite((r.greeks as { lambda: number }).lambda)).toBe(true);
    }
  });

  it('digital.extendedGreeks: disclosed null never flips converged to false', () => {
    const r = digital.extendedGreeks({
      type: 'call',
      kind: 'cash-or-nothing',
      spot: 100,
      strike: 10_000,
      timeToExpiryYears: 0.01,
      riskFreeRate: 0.02,
      volatility: 0.1,
      cash: 10,
    });
    for (const [k, v] of Object.entries(r.value)) {
      expect(v === null || Number.isFinite(v), `${k} must be finite or null`).toBe(true);
    }
    if (r.value.lambda === null) {
      expect(r.diagnostics.converged).toBe(true);
      expect(r.diagnostics.warnings.some((w) => w.code === 'greeks.lambda_undefined')).toBe(true);
    }
  });
});
