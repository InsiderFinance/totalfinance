import { describe, expect, it } from 'vitest';
import { engines, market, option, priceMany, type OptionBatchColumns } from '@totalfinance/options';
import { blackScholesPriceMany, blackScholesPriceManyInto } from '@totalfinance/options/batch';
import {
  blackScholes,
  blackScholesGreeks,
  blackScholesPrice,
} from '@totalfinance/options/black-scholes';

/** Phase 3A: changing argument grammar must not change economics at any shipped execution layer. */
describe('named-request parity across BSM layers', () => {
  // Monday 2026-01-05 16:00 ET → Tuesday 2027-01-05 16:00 ET is exactly 365 days,
  // avoiding weekend/holiday roll while making the artifact layer's ACT/365F `t` exactly 1.
  const asOf = Date.UTC(2026, 0, 5, 21);
  const rawInput = {
    type: 'call' as const,
    spot: 100,
    strike: 105,
    timeToExpiryYears: 1,
    riskFreeRate: 0.04,
    dividendYield: 0.01,
    volatility: 0.22,
  };

  const contract = option.call({
    convention: 'us-equity-close',
    underlying: 'XYZ',
    strike: rawInput.strike,
    expiry: '2027-01-05',
    style: 'european',
  });
  const optionMarket = market({
    spot: rawInput.spot,
    riskFreeRate: rawInput.riskFreeRate,
    dividendYield: rawInput.dividendYield,
    volatility: rawInput.volatility,
    asOf,
  });
  const columns: OptionBatchColumns = {
    spot: Float64Array.of(rawInput.spot),
    strike: Float64Array.of(rawInput.strike),
    timeToExpiryYears: Float64Array.of(rawInput.timeToExpiryYears),
    riskFreeRate: Float64Array.of(rawInput.riskFreeRate),
    dividendYield: Float64Array.of(rawInput.dividendYield),
    volatility: Float64Array.of(rawInput.volatility),
    type: Int8Array.of(1),
  };

  it('raw, facade, explain, engine, pro, row-batch, and columnar batch prices agree', () => {
    const raw = blackScholesPrice(rawInput);
    const facadeInput = {
      spot: rawInput.spot,
      strike: rawInput.strike,
      timeToExpiryYears: rawInput.timeToExpiryYears,
      riskFreeRate: rawInput.riskFreeRate,
      dividendYield: rawInput.dividendYield,
      volatility: rawInput.volatility,
    };
    const facade = blackScholes.call(facadeInput);
    const explained = blackScholes.call.explain(facadeInput).value;
    const engine = engines.blackScholesMerton().price({ contract, market: optionMarket }).value;
    const professional = option.price({
      contract,
      market: optionMarket,
      engine: engines.blackScholesMerton(),
    }).value;
    const rowBatch = priceMany({ contracts: [contract], market: optionMarket })[0]!.value;
    const columnar = blackScholesPriceMany(columns).price[0]!;
    const into = new Float64Array(1);
    blackScholesPriceManyInto(columns, into);

    for (const value of [facade, explained, engine, professional, rowBatch, columnar, into[0]!]) {
      expect(value).toBeCloseTo(raw, 12);
    }
  });

  it('raw, facade, professional, and columnar Greeks use the same units and values', () => {
    const raw = blackScholesGreeks(rawInput);
    const facade = blackScholes.greeks(rawInput);
    const professional = option.price({
      contract,
      market: optionMarket,
      engine: engines.blackScholesMerton(),
    }).greeks!;
    const columnar = blackScholesPriceMany(columns, { greeks: true });

    expect(facade).toEqual(raw);
    expect(professional.delta).toBeCloseTo(raw.delta, 12);
    expect(professional.gamma).toBeCloseTo(raw.gamma, 12);
    expect(professional.theta).toBeCloseTo(raw.theta, 12);
    expect(professional.vega).toBeCloseTo(raw.vega, 12);
    expect(professional.rho).toBeCloseTo(raw.rho, 12);
    expect(columnar.delta![0]).toBeCloseTo(raw.delta, 12);
    expect(columnar.gamma![0]).toBeCloseTo(raw.gamma, 12);
    expect(columnar.theta![0]).toBeCloseTo(raw.theta, 12);
    expect(columnar.vega![0]).toBeCloseTo(raw.vega, 12);
    expect(columnar.rho![0]).toBeCloseTo(raw.rho, 12);
  });
});
