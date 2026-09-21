import { describe, expect, it } from 'vitest';
import { engines, market, option, type OptionMarket } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import { black76Price } from '@totalfinance/options/black76';

// 16:00 ET (21:00 UTC, EST) close: a date-only expiry one EST year later resolves to exactly T = 1.
const asOf = Date.UTC(2026, 0, 1, 21);
const expiry = '2027-01-01'; // T = 1 (2026 non-leap)
const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });

describe('engines.auto — European routing (WS4.1)', () => {
  it('routes a European contract to black-scholes-merton and matches the BSM price', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const r = engines.auto().price({ contract: c, market: mkt });
    expect(r.diagnostics.engine).toBe('black-scholes-merton');
    expect(r.diagnostics.autoReason).toBeTruthy();
    expect(r.value).toBeCloseTo(
      blackScholesPrice({
        type: 'call',
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        dividendYield: 0,
        volatility: 0.2,
      }),
      10,
    );
  });

  it('routes a forward-only European market (no spot) to black-76', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    // Forward supplied, spot omitted — the runtime-guarded Black-76 route (spot stays required on the
    // public type per WS3.2; a JS caller can still omit it).
    const fwdMkt = { forward: 105, riskFreeRate: 0.05, volatility: 0.2, asOf } as OptionMarket;
    const r = engines.auto().price({ contract: c, market: fwdMkt });
    expect(r.diagnostics.engine).toBe('black-76');
    expect(r.value).toBeCloseTo(
      black76Price({
        type: 'call',
        forward: 105,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.2,
      }),
      10,
    );
  });
});

describe('engines.auto — American routing (WS4.1)', () => {
  it('prices an American call with no dividends as the European BSM value', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const r = engines.auto().price({ contract: c, market: mkt });
    expect(r.diagnostics.engine).toBe('black-scholes-merton');
    expect(r.diagnostics.autoReason).toMatch(/early exercise/i);
    expect(r.value).toBeCloseTo(
      blackScholesPrice({
        type: 'call',
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        dividendYield: 0,
        volatility: 0.2,
      }),
      10,
    );
  });

  it('routes an American put to a 501-step Leisen–Reimer lattice under accuracy (default)', () => {
    const c = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const r = engines.auto().price({ contract: c, market: mkt });
    expect(r.diagnostics.engine).toBe('binomial-leisen-reimer');
    // The American put carries an early-exercise premium over the European put (r > 0).
    expect(r.value).toBeGreaterThan(
      blackScholesPrice({
        type: 'put',
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        dividendYield: 0,
        volatility: 0.2,
      }),
    );
  });

  it('routes an American put to Bjerksund–Stensland 2002 under objective:speed', () => {
    const c = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const r = engines.auto({ objective: 'speed' }).price({ contract: c, market: mkt });
    expect(r.diagnostics.engine).toBe('bjerksund-stensland-2002');
  });

  it('does NOT take the no-dividend shortcut for an American call WITH dividends', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const divMkt = market({
      spot: 100,
      riskFreeRate: 0.05,
      volatility: 0.2,
      dividendYield: 0.06,
      asOf,
    });
    const r = engines.auto().price({ contract: c, market: divMkt });
    expect(r.diagnostics.engine).toBe('binomial-leisen-reimer');
  });
});

describe('engines.auto — unsupported contract (WS4.1)', () => {
  it("'bermudan' is UNREPRESENTABLE: the builder rejects it with the style teaching error (P3.4)", () => {
    // No vanilla engine ever supported Bermudan exercise — a representable-but-unpriceable state
    // violated valid-by-construction, so the style union no longer admits it. Bermudan RATES
    // exercise lives where it is priced: fixed-income's bermudanSwaption with explicit dates.
    expect(() =>
      option.call({
        convention: 'us-equity-close',
        underlying: 'X',
        strike: 100,
        expiry,
        style: 'bermudan' as never,
      }),
    ).toThrow(/style is required — one of 'european' \| 'american'/);
  });
});

describe('engines.black76 (WS4.1)', () => {
  it('prices off the forward and matches the black76 kernel', () => {
    const c = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'european',
    });
    const fwdMkt = { forward: 98, riskFreeRate: 0.05, volatility: 0.25, asOf } as OptionMarket;
    const r = engines.black76().price({ contract: c, market: fwdMkt });
    expect(r.diagnostics.engine).toBe('black-76');
    expect(r.greeks).toBeDefined();
    expect(r.value).toBeCloseTo(
      black76Price({
        type: 'put',
        forward: 98,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        volatility: 0.25,
      }),
      12,
    );
  });
});

describe('option.price default engine (WS4.1)', () => {
  it('is byte-identical to the prior BSM default for European contracts', () => {
    const c = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 110,
      expiry,
      style: 'european',
    });
    const viaDefault = option.price({ contract: c, market: mkt }).value;
    const viaBsm = engines.blackScholesMerton().price({ contract: c, market: mkt }).value;
    expect(viaDefault).toBe(viaBsm);
  });

  it('now prices American contracts through the default engine (no throw)', () => {
    const c = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry,
      style: 'american',
    });
    const r = option.price({ contract: c, market: mkt });
    expect(Number.isFinite(r.value)).toBe(true);
    expect(r.value).toBeGreaterThan(0);
    expect(r.diagnostics.engine).toBe('binomial-leisen-reimer');
  });
});
