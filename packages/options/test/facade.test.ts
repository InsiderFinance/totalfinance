import { describe, expect, it } from 'vitest';
import { InputError, UnsupportedError } from '@totalfinance/core';
import { defineOptionPricingEngine, engines, market, option } from '@totalfinance/options';
import { blackScholes } from '@totalfinance/options/black-scholes';

describe('facade shape', () => {
  const input = {
    spot: 100,
    strike: 105,
    timeToExpiryYears: 30 / 365,
    riskFreeRate: 0.045,
    volatility: 0.22,
  };

  it('blackScholes.call returns a plain number; .explain returns the rich envelope', () => {
    const v = blackScholes.call(input);
    expect(typeof v).toBe('number');

    const ex = blackScholes.call.explain(input);
    expect(ex.value).toBe(v);
    expect(ex.assumptions.model).toBe('black-scholes-merton');
    expect(ex.assumptions.dayCount).toBe('ACT/365F');
    expect(ex.assumptions.compounding).toBe('continuous');
    expect(ex.assumptions.units).toEqual({
      theta: 'perDay',
      vega: 'per1Percent',
      rho: 'per1Percent',
    });
    expect(ex.assumptions.timeToExpiryYears).toBeCloseTo(30 / 365, 12);
    expect(ex.diagnostics.method).toBe('closed-form');
    expect(ex.diagnostics.converged).toBe(true);
    expect(ex.diagnostics.warnings).toEqual([]);
  });

  it('echoes dividendModel based on the dividend yield', () => {
    expect(blackScholes.call.explain(input).assumptions.dividendModel).toBe('none');
    expect(
      blackScholes.call.explain({ ...input, dividendYield: 0.01 }).assumptions.dividendModel,
    ).toBe('continuousYield');
  });

  it('throws InputError with a stable code on negative spot', () => {
    let caught: unknown;
    try {
      blackScholes.call({
        spot: -1,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.2,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InputError);
    expect((caught as InputError).code).toBe('input.negative_spot');
    expect((caught as InputError).message).toMatch(/spot must be > 0/);
  });
});

describe('pro API agrees with the facade', () => {
  // 16:00 ET (21:00 UTC, EST) close: a date-only expiry one EST year later resolves to exactly T = 1.
  const asOf = Date.UTC(2026, 0, 1, 21);
  const facadeParams = {
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    volatility: 0.2,
  };

  it('option.price (t=1 exactly) equals blackScholes.price and carries assumptions/Greeks', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'european',
    });
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
    const pro = option.price({ contract, market: mkt, engine: engines.blackScholes() });

    expect(pro.assumptions.timeToExpiryYears).toBeCloseTo(1, 12);
    expect(pro.assumptions.asOf).toBe(asOf);
    expect(pro.value).toBeCloseTo(blackScholes.call(facadeParams), 10);
    expect(pro.greeks!.delta).toBeCloseTo(
      blackScholes.greeks({ ...facadeParams, type: 'call' }).delta,
      10,
    );
    expect(pro.diagnostics.engine).toBe('black-scholes');
  });

  it('option.price now prices an American contract via the auto default engine (WS4.1)', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'american',
    });
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
    // The default engine is now engines.auto(): an American call with no dividends is priced as the
    // European BSM value (early exercise is never optimal), with the delegate + reason in diagnostics.
    const r = option.price({ contract, market: mkt });
    expect(Number.isFinite(r.value)).toBe(true);
    expect(r.value).toBeGreaterThan(0);
    expect(r.diagnostics.engine).toBe('black-scholes-merton');
    expect(r.diagnostics.autoReason).toMatch(/early exercise/i);
  });

  it('option.impliedVolatility returns a rich, converged envelope', () => {
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'european',
    });
    const price = blackScholes.call(facadeParams);
    const mkt = market({ spot: 100, riskFreeRate: 0.05, price, asOf });
    const r = option.impliedVolatility({ contract, market: mkt });
    expect(r.diagnostics.converged).toBe(true);
    expect(r.value).toBeCloseTo(0.2, 8);
  });

  it('enforces a custom engine.supports() — unsupported contracts throw UnsupportedError', () => {
    const europeanOnly = defineOptionPricingEngine({
      name: 'test.european-only',
      version: '1.0.0',
      capabilities: {
        styles: ['european'] as const,
        dividends: ['none'] as const,
        greeks: 'none',
        extendedGreeks: false,
        deterministic: true,
      } as const,
      supports: (c) => c.style === 'european',
      price: ({ contract, market }) => engines.blackScholes().price({ contract, market }),
    });
    const american = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'american',
    });
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });

    let caught: unknown;
    try {
      option.price({ contract: american, market: mkt, engine: europeanOnly });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnsupportedError);
    expect((caught as UnsupportedError).code).toBe('engine.unsupported_contract');
    expect((caught as UnsupportedError).context).toMatchObject({ engine: 'test.european-only' });
  });
});

describe('date-only expiry resolves to the market close (0DTE intraday)', () => {
  it('a same-day date-only expiry priced intraday stays alive (positive time-to-expiry)', () => {
    const asOf = Date.UTC(2026, 1, 2, 14); // 14:00 UTC, before the 21:00 UTC (EST) close
    const contract = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2026-02-02',
      style: 'european',
    });
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
    const r = option.price({ contract, market: mkt });
    expect(r.assumptions.timeToExpiryYears).toBeGreaterThan(0); // not collapsed to ≤0 → no "expired" throw
    expect(r.value).toBeGreaterThan(0);
  });

  it('accepts a full datetime expiry (no longer rejected)', () => {
    const asOf = Date.UTC(2026, 1, 2, 14);
    const contract = option.call({
      underlying: 'X',
      strike: 100,
      expiry: '2026-02-02T21:00:00Z',
      style: 'european',
    });
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
    expect(option.price({ contract, market: mkt }).assumptions.timeToExpiryYears).toBeGreaterThan(
      0,
    );
  });
});
