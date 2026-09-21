import { describe, expect, it } from 'vitest';
import { engines, market, option, priceMany, type OptionBatchColumns } from '@totalfinance/options';
import { isQuantError } from '@totalfinance/core';
import { blackScholesGreeks, blackScholesPrice } from '@totalfinance/options/black-scholes';
import { blackScholesPriceMany, blackScholesPriceManyInto } from '@totalfinance/options/batch';

function makeColumns(): OptionBatchColumns {
  const spot = Float64Array.from([100, 100, 95, 110]);
  const strike = Float64Array.from([100, 105, 100, 100]);
  const vol = Float64Array.from([0.2, 0.25, 0.18, 0.3]);
  const rate = Float64Array.from([0.05, 0.04, 0.05, 0.03]);
  const t = Float64Array.from([1, 0.5, 0.25, 2]);
  const type = Int8Array.from([1, -1, 1, -1]); // call, put, call, put
  const dividendYield = Float64Array.from([0, 0.01, 0, 0.02]);
  return {
    spot,
    strike,
    volatility: vol,
    riskFreeRate: rate,
    timeToExpiryYears: t,
    type,
    dividendYield,
  };
}

describe('columnar batch', () => {
  it('blackScholesPriceMany matches scalar blackScholesPrice per row', () => {
    const cols = makeColumns();
    const res = blackScholesPriceMany(cols, { greeks: true });
    for (let i = 0; i < cols.spot.length; i++) {
      const type = cols.type[i]! > 0 ? 'call' : 'put';
      const q = cols.dividendYield![i]!;
      const expected = blackScholesPrice({
        type,
        spot: cols.spot[i]!,
        strike: cols.strike[i]!,
        timeToExpiryYears: cols.timeToExpiryYears[i]!,
        riskFreeRate: cols.riskFreeRate[i]!,
        dividendYield: q,
        volatility: cols.volatility[i]!,
      });
      expect(res.price[i]).toBeCloseTo(expected, 12);
      const g = blackScholesGreeks({
        type,
        spot: cols.spot[i]!,
        strike: cols.strike[i]!,
        timeToExpiryYears: cols.timeToExpiryYears[i]!,
        riskFreeRate: cols.riskFreeRate[i]!,
        dividendYield: q,
        volatility: cols.volatility[i]!,
      });
      expect(res.delta![i]).toBeCloseTo(g.delta, 12);
      expect(res.vega![i]).toBeCloseTo(g.vega, 12);
    }
  });

  it('blackScholesPriceManyInto writes into a provided buffer', () => {
    const cols = makeColumns();
    const out = new Float64Array(cols.spot.length);
    blackScholesPriceManyInto(cols, out);
    const ref = blackScholesPriceMany(cols).price;
    expect(Array.from(out)).toEqual(Array.from(ref));
  });

  it('rejects mismatched column shapes instead of silently producing NaN/dropped rows', () => {
    const cols = makeColumns();
    const short = { ...cols, strike: Float64Array.from([100, 105]) }; // wrong length
    expect(() => blackScholesPriceMany(short)).toThrow();
    // A too-small out buffer would silently drop rows — reject it.
    expect(() => blackScholesPriceManyInto(cols, new Float64Array(2))).toThrow();
  });

  it('blackScholesPriceMany rejects per-row bad values (no silent NaN row)', () => {
    const bad = makeColumns();
    bad.spot[1] = NaN;
    expect(() => blackScholesPriceMany(bad)).toThrow();
    const neg = makeColumns();
    neg.spot[1] = -1;
    expect(() => blackScholesPriceMany(neg)).toThrow();
  });
});

describe('rows batch', () => {
  it('priceMany matches individual option.price', () => {
    const asOf = Date.UTC(2026, 0, 1);
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
    const contracts = [
      option.call({
        convention: 'us-equity-close',
        underlying: 'X',
        strike: 95,
        expiry: '2027-01-01',
        style: 'european',
      }),
      option.call({
        convention: 'us-equity-close',
        underlying: 'X',
        strike: 100,
        expiry: '2027-01-01',
        style: 'european',
      }),
      option.put({
        convention: 'us-equity-close',
        underlying: 'X',
        strike: 105,
        expiry: '2027-01-01',
        style: 'european',
      }),
    ];
    const engine = engines.blackScholes();
    const batch = priceMany({ contracts, market: mkt, engine });
    expect(batch).toHaveLength(3);
    batch.forEach((r, i) => {
      expect(r.value).toBeCloseTo(
        option.price({ contract: contracts[i]!, market: mkt, engine }).value,
        12,
      );
    });
  });

  it('defaults to the auto engine, so American rows price exactly as scalar option.price', () => {
    const asOf = Date.UTC(2026, 0, 1);
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
    const american = option.put({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 105,
      expiry: '2027-01-01',
      style: 'american',
    });
    const european = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'european',
    });
    // Before: the batch default was the European-only BSM engine, so a chain with American rows
    // was refused (or, worse, a caller reached for BSM and priced early exercise away). The batch
    // now shares scalar `option.price`'s auto default and agrees with it row for row.
    const batch = priceMany({ contracts: [american, european], market: mkt });
    expect(batch.map((r) => r.diagnostics.engine)).toEqual([
      option.price({ contract: american, market: mkt }).diagnostics.engine,
      option.price({ contract: european, market: mkt }).diagnostics.engine,
    ]);
    expect(batch[0]!.value).toBeCloseTo(
      option.price({ contract: american, market: mkt }).value,
      12,
    );
    expect(batch[1]!.value).toBeCloseTo(
      option.price({ contract: european, market: mkt }).value,
      12,
    );
  });

  it('enforces the engine support contract like scalar option.price', () => {
    const asOf = Date.UTC(2026, 0, 1);
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
    // The textbook Black–Scholes engine supports European only; an American contract must be rejected
    // in batch exactly as scalar option.price rejects it.
    const american = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'american',
    });
    const engine = engines.blackScholes();
    expect(() => option.price({ contract: american, market: mkt, engine })).toThrow();
    expect(() => priceMany({ contracts: [american], market: mkt, engine })).toThrow();
  });

  it('H06: a failing row names its INDEX, same code and class as the scalar path', () => {
    const asOf = Date.UTC(2026, 0, 1);
    const mkt = market({ spot: 100, riskFreeRate: 0.05, volatility: 0.2, asOf });
    const european = (strike: number) =>
      option.call({
        convention: 'us-equity-close',
        underlying: 'X',
        strike,
        expiry: '2027-01-01',
        style: 'european',
      });
    const american = option.call({
      convention: 'us-equity-close',
      underlying: 'X',
      strike: 100,
      expiry: '2027-01-01',
      style: 'american',
    });
    const engine = engines.blackScholes();
    // A 10,000-row batch whose error says only "this contract" is a needle hunt: the failure
    // must say WHICH row, without changing the code or class a caller branches on.
    let caught: unknown;
    try {
      priceMany({ contracts: [european(95), american, european(105)], market: mkt, engine });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'engine.unsupported_contract')).toBe(true);
    const quantError = caught as { message: string; context?: Record<string, unknown> };
    expect(quantError.message).toContain('contracts[1]');
    expect(quantError.context?.['contractIndex']).toBe(1);
  });
});
