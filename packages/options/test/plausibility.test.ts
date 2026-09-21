import { describe, expect, it } from 'vitest';
import { bachelier, black76, blackScholes } from '@totalfinance/options';

/**
 * DX0 §2.4: the two classic quant footguns (percent-as-decimal vol, day-count-as-year-fraction time)
 * are surfaced as INFO warnings in `.explain()` diagnostics — the plain-value path stays
 * silent-and-correct (a 2200% vol is legal; the plain-number law holds).
 */

const base = {
  spot: 100,
  strike: 100,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.05,
  volatility: 0.2,
  type: 'call' as const,
};
const hasCode = (r: { diagnostics: { warnings: { code: string }[] } }, code: string): boolean =>
  r.diagnostics.warnings.some((w) => w.code === code);

describe('blackScholes.explain() plausibility warnings', () => {
  it('flags a percent-looking volatility while the plain path still returns a number', () => {
    const r = blackScholes.price.explain({ ...base, volatility: 22 });
    expect(hasCode(r, 'input.suspicious_volatility')).toBe(true);
    expect(Number.isFinite(blackScholes.price({ ...base, volatility: 22 }))).toBe(true);
  });

  it('does not warn on a legal decimal volatility', () => {
    expect(
      hasCode(
        blackScholes.price.explain({ ...base, volatility: 0.22 }),
        'input.suspicious_volatility',
      ),
    ).toBe(false);
  });

  it('flags a day-count-looking time on greeks too', () => {
    expect(
      hasCode(
        blackScholes.greeks.explain({ ...base, timeToExpiryYears: 30 }),
        'input.suspicious_time',
      ),
    ).toBe(true);
    expect(
      hasCode(
        blackScholes.greeks.explain({ ...base, timeToExpiryYears: 0.5 }),
        'input.suspicious_time',
      ),
    ).toBe(false);
  });

  it('flags a percent-looking rate while the plain path still returns a number (P1.6)', () => {
    const r = blackScholes.price.explain({ ...base, riskFreeRate: 4.5 });
    expect(hasCode(r, 'input.suspicious_risk_free_rate')).toBe(true);
    expect(Number.isFinite(blackScholes.price({ ...base, riskFreeRate: 4.5 }))).toBe(true);
    expect(
      hasCode(
        blackScholes.price.explain({ ...base, riskFreeRate: 0.045 }),
        'input.suspicious_risk_free_rate',
      ),
    ).toBe(false);
    // The IV solve path warns too — the unit mistake is most opaque there.
    const impliedVolatility = blackScholes.impliedVolatility.explain({
      price: 5,
      spot: 100,
      strike: 100,
      timeToExpiryYears: 0.5,
      riskFreeRate: 4.5,
      type: 'call' as const,
    });
    expect(hasCode(impliedVolatility, 'input.suspicious_risk_free_rate')).toBe(true);
  });

  it('blackScholes.impliedVolatility.explain runs the suspicious-time check like blackScholes.price.explain', () => {
    // t = 30 (integer years) is almost certainly a day count; the solve itself still converges.
    const t = 30;
    const price = blackScholes.call({
      spot: 100,
      strike: 100,
      timeToExpiryYears: t,
      riskFreeRate: 0.05,
      volatility: 0.2,
    });
    const r = blackScholes.impliedVolatility.explain({
      spot: 100,
      strike: 100,
      timeToExpiryYears: t,
      riskFreeRate: 0.05,
      price,
      type: 'call',
    });
    expect(r.diagnostics.converged).toBe(true);
    expect(hasCode(r, 'input.suspicious_time')).toBe(true);
    // blackScholes.price is the typed facade — blackScholes.call now rejects a user-supplied `type` (Law 12).
    const clean = blackScholes.impliedVolatility.explain({
      ...base,
      price: blackScholes.price(base),
    });
    expect(hasCode(clean, 'input.suspicious_time')).toBe(false);
  });
});

describe('black76.explain() plausibility warnings', () => {
  const b76 = {
    forward: 100,
    strike: 100,
    timeToExpiryYears: 0.5,
    riskFreeRate: 0.05,
    volatility: 0.2,
    type: 'call' as const,
  };

  it('flags a percent-looking volatility (same decimal footgun as bs)', () => {
    const r = black76.price.explain({ ...b76, volatility: 22 });
    expect(hasCode(r, 'input.suspicious_volatility')).toBe(true);
    expect(Number.isFinite(black76.price({ ...b76, volatility: 22 }))).toBe(true);
    expect(hasCode(black76.price.explain(b76), 'input.suspicious_volatility')).toBe(false);
  });

  it('flags a day-count-looking time across price/call/greeks/impliedVolatility explains', () => {
    expect(
      hasCode(black76.price.explain({ ...b76, timeToExpiryYears: 30 }), 'input.suspicious_time'),
    ).toBe(true);
    const { type: _b76Type, ...b76Untyped } = b76;
    expect(
      hasCode(
        black76.call.explain({ ...b76Untyped, timeToExpiryYears: 30 }),
        'input.suspicious_time',
      ),
    ).toBe(true);
    expect(
      hasCode(black76.greeks.explain({ ...b76, timeToExpiryYears: 30 }), 'input.suspicious_time'),
    ).toBe(true);
    const price = black76.call({ ...b76Untyped, timeToExpiryYears: 30 });
    const impliedVolatility = black76.impliedVolatility.explain({
      forward: 100,
      strike: 100,
      timeToExpiryYears: 30,
      riskFreeRate: 0.05,
      price,
      type: 'call',
    });
    expect(hasCode(impliedVolatility, 'input.suspicious_time')).toBe(true);
    expect(hasCode(black76.price.explain(b76), 'input.suspicious_time')).toBe(false);
  });
});

describe('bachelier.explain() plausibility warnings', () => {
  const bach = {
    forward: 100,
    strike: 100,
    timeToExpiryYears: 0.5,
    riskFreeRate: 0.05,
    normalVolatility: 15,
    type: 'call' as const,
  };

  it('flags a day-count-looking time but NOT a large normal vol (price units are legal)', () => {
    expect(
      hasCode(bachelier.price.explain({ ...bach, timeToExpiryYears: 30 }), 'input.suspicious_time'),
    ).toBe(true);
    expect(hasCode(bachelier.price.explain(bach), 'input.suspicious_time')).toBe(false);
    // Bachelier volatility is NORMAL, in price units — 22 points is not a percent typo, and the
    // dedicated field name (normalVolatility, Law 4) makes the lognormal heuristic structurally
    // inapplicable here.
    expect(
      hasCode(
        bachelier.price.explain({ ...bach, normalVolatility: 22 }),
        'input.suspicious_volatility',
      ),
    ).toBe(false);
    // The retired `vol` key teaches its unit story instead of being silently accepted.
    expect(() => bachelier.price({ ...bach, volatility: 22 } as never)).toThrow(
      /PRICE UNITS and the field is named normalVolatility/,
    );
  });

  it('bachelier.impliedVolatility.explain carries the suspicious-time warning too', () => {
    const { type: _bachType, ...bachUntyped } = bach;
    const price = bachelier.call({ ...bachUntyped, timeToExpiryYears: 30 });
    const impliedVolatility = bachelier.impliedVolatility.explain({
      forward: 100,
      strike: 100,
      timeToExpiryYears: 30,
      riskFreeRate: 0.05,
      price,
      type: 'call',
    });
    expect(hasCode(impliedVolatility, 'input.suspicious_time')).toBe(true);
  });
});
