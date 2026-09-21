import { describe, expect, it } from 'vitest';
import { usEquitySessionInstant } from '@totalfinance/core';
import { engines, market, option } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

// 16:00 ET (21:00 UTC, EST) close: a date-only expiry one EST year later resolves to exactly T = 1.
const asOf = Date.UTC(2026, 0, 1, 21);
const expiry = '2027-01-01'; // T = 1
const divs = [{ exDate: '2026-06-01', amount: 3 }];

describe('discrete dividends are honored consistently (no silent ignore on the BSM path)', () => {
  const call = option.call({
    convention: 'us-equity-close',
    underlying: 'X',
    strike: 100,
    expiry,
    style: 'european',
  });
  const noDiv = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
  const withDiv = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf, dividends: divs });

  it('the default pro path lowers a call and labels the model discreteSchedule', () => {
    const a = option.price({ contract: call, market: noDiv });
    const b = option.price({ contract: call, market: withDiv });
    expect(b.value).toBeLessThan(a.value);
    expect(a.assumptions.dividendModel).toBe('none');
    expect(b.assumptions.dividendModel).toBe('discreteSchedule');
  });

  it('the BSM escrowed price equals pricing on the escrowed spot', () => {
    // PV of a $3 dividend at t≈0.42y discounted at 5%. A date-only ex-date resolves to the market
    // OPEN (09:30 ET on every session, from core's shared table) — not the option-expiry close —
    // so the reference recomputes it that way.
    const t = (usEquitySessionInstant('2026-06-01', 'open') - asOf) / (365 * 24 * 3600 * 1000);
    const pv = 3 * Math.exp(-0.05 * t);
    const expected = blackScholesPrice({
      type: 'call',
      spot: 100 - pv,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.2,
    });
    expect(option.price({ contract: call, market: withDiv }).value).toBeCloseTo(expected, 6);
  });

  it('implied volatility inverts through the same escrowed spot (round-trips)', () => {
    const priced = option.price({ contract: call, market: withDiv }).value;
    const impliedVolatility = option.impliedVolatility({
      contract: call,
      market: market({ spot: 100, riskFreeRate: 0.05, asOf, price: priced, dividends: divs }),
    });
    expect(impliedVolatility.value).toBeCloseTo(0.2, 6);
    expect(impliedVolatility.assumptions.dividendModel).toBe('discreteSchedule');
  });

  it('the textbook black-scholes engine ignores dividends by design', () => {
    const e = engines.blackScholes();
    expect(e.price({ contract: call, market: withDiv }).value).toBeCloseTo(
      e.price({ contract: call, market: noDiv }).value,
      12,
    );
  });

  it('the BSM (European) escrowed call agrees with the American engine when early exercise is moot', () => {
    // A no-yield American call is never exercised early, so it equals the European escrowed price.
    const euro = option.price({ contract: call, market: withDiv }).value;
    const amer = engines.binomial({ variant: 'leisen-reimer', steps: 600 }).price({
      contract: option.call({
        convention: 'us-equity-close',
        underlying: 'X',
        strike: 100,
        expiry,
        style: 'american',
      }),
      market: withDiv,
    }).value;
    expect(amer).toBeCloseTo(euro, 1);
  });

  it('rejects a malformed dividend schedule instead of returning NaN with converged:true', () => {
    const amer = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const bad = (amount: number) =>
      market({
        spot: 100,
        riskFreeRate: 0.05,
        volatility: 0.2,
        asOf,
        dividends: [{ exDate: '2026-06-01', amount }],
      });
    // NaN amount, negative amount, and a dividend PV exceeding spot must all throw — never NaN.
    for (const amount of [NaN, -3, 150]) {
      expect(() => option.price({ contract: call, market: bad(amount) })).toThrow();
      expect(() =>
        engines.binomial({ steps: 100 }).price({ contract: amer, market: bad(amount) }),
      ).toThrow();
    }
    // A valid schedule still prices and stays converged.
    const ok = option.price({ contract: call, market: bad(3) });
    expect(Number.isFinite(ok.value)).toBe(true);
    expect(ok.diagnostics.converged).toBe(true);
  });
});
