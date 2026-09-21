import { describe, expect, it } from 'vitest';
import { ErrorCode, isComputed, resolvedExpiry, type OptionQuote } from '@totalfinance/core';
import { chainGreeks, engines, priceOption } from '@totalfinance/options';

/**
 * Pre-publish interface repairs B7 — `chainGreeks` is the Greeks call that exists. A chain row is
 * core `OptionQuote`; this call solves each row's implied volatility from its observed price with
 * the same style routing as `option.impliedVolatility`, prices at that volatility, and stamps
 * `impliedVolatility` and display-unit `greeks` with provenance. Per row it never throws.
 */

const AS_OF = '2026-01-02T15:30:00-05:00';
const EXPIRY = '2026-06-19';
const MARKET = { spot: 105, riskFreeRate: 0.04, dividendYield: 0.01, asOf: AS_OF };
const SIGMA = 0.24;

function contract(strike: number, type: 'call' | 'put', style: 'european' | 'american') {
  return {
    underlying: 'ACME',
    type,
    style,
    strike,
    expiry: EXPIRY,
    ...resolvedExpiry(EXPIRY),
  } as OptionQuote['contract'];
}

/**
 * A row whose mid is the exact model price at SIGMA, so the solve must recover SIGMA. An American
 * row is priced with the engine `chainGreeks` routes to (Bjerksund–Stensland 2002), so the
 * round trip is exact rather than approximation-vs-lattice.
 */
function exactRow(
  strike: number,
  type: 'call' | 'put',
  style: 'european' | 'american',
): OptionQuote {
  const c = contract(strike, type, style);
  const engine = style === 'american' ? { engine: engines.bjerksundStensland2002() } : {};
  const price = priceOption({
    contract: c,
    market: { ...MARKET, volatility: SIGMA },
    ...engine,
  }).value;
  return {
    contract: c,
    timestampMs: Date.UTC(2026, 0, 2, 20, 30),
    bid: price - 0.05,
    ask: price + 0.05,
    underlyingPrice: 105,
  };
}

describe('chainGreeks — solves every row from its observed price', () => {
  it('recovers the volatility behind each European row and stamps display-unit Greeks', () => {
    const quotes = [95, 105, 115].map((k) => exactRow(k, 'call', 'european'));
    const result = chainGreeks({ quotes, market: MARKET });
    expect(isComputed(result)).toBe(true);
    expect(result.value).toHaveLength(3);
    expect(result.diagnostics.solvedCount).toBe(3);
    expect(result.diagnostics.skippedCount).toBe(0);
    expect(result.diagnostics.warnings).toEqual([]);
    for (const [i, row] of result.value.entries()) {
      expect(row.impliedVolatility).toBeCloseTo(SIGMA, 6);
      const expected = priceOption({
        contract: row.contract,
        market: { ...MARKET, volatility: row.impliedVolatility! },
        greeks: true,
      }).greeks!;
      expect(result.diagnostics.rows[i]!.engine).toBe('black-scholes-merton');
      expect(row.greeks?.delta).toBeCloseTo(expected.delta, 10);
      expect(row.greeks?.gamma).toBeCloseTo(expected.gamma, 10);
      expect(row.greeks?.theta).toBeCloseTo(expected.theta, 10);
      expect(row.greeks?.vega).toBeCloseTo(expected.vega, 10);
      expect(row.greeks?.rho).toBeCloseTo(expected.rho, 10);
      expect(row.greeks?.provenance).toEqual({
        source: 'chainGreeks',
        model: result.diagnostics.rows[i]!.engine,
        timestampMs: result.assumptions.asOf,
      });
      expect(result.diagnostics.rows[i]).toEqual({
        index: i,
        status: 'solved',
        engine: expect.any(String),
        reason: null,
        message: null,
      });
      // The input row is untouched: rows are returned as new objects.
      expect(quotes[i]!.greeks).toBeUndefined();
      expect(quotes[i]!.impliedVolatility).toBeUndefined();
    }
  });

  it('routes an American row through the American engine and a European row through BSM', () => {
    const result = chainGreeks({
      quotes: [exactRow(100, 'put', 'american'), exactRow(100, 'put', 'european')],
      market: MARKET,
    });
    const [american, european] = result.diagnostics.rows;
    expect(american!.engine).toBe(engines.bjerksundStensland2002().name);
    expect(european!.engine).not.toBe(american!.engine);
    expect(result.value[0]!.impliedVolatility).toBeCloseTo(SIGMA, 6);
    expect(result.value[1]!.impliedVolatility).toBeCloseTo(SIGMA, 6);
    // The Greeks of the American row come from the engine that solved it.
    const expected = priceOption({
      contract: result.value[0]!.contract,
      market: { ...MARKET, volatility: result.value[0]!.impliedVolatility! },
      greeks: true,
      engine: engines.bjerksundStensland2002(),
    }).greeks!;
    expect(result.value[0]!.greeks?.delta).toBeCloseTo(expected.delta, 10);
    expect(result.value[0]!.greeks?.provenance?.model).toBe(american!.engine);
    expect(result.assumptions.engines).toEqual({
      european: 'black-scholes-merton',
      american: 'bjerksund-stensland-2002',
    });
  });

  it('honours priceSource and never falls back across sources', () => {
    const row = exactRow(105, 'call', 'european');
    const mid = chainGreeks({ quotes: [row], market: MARKET }).value[0]!.impliedVolatility!;
    const bid = chainGreeks({ quotes: [row], market: MARKET, priceSource: 'bid' }).value[0]!
      .impliedVolatility!;
    const ask = chainGreeks({ quotes: [row], market: MARKET, priceSource: 'ask' }).value[0]!
      .impliedVolatility!;
    expect(bid).toBeLessThan(mid);
    expect(mid).toBeLessThan(ask);
    // `last` was never quoted on this row: the row is skipped, not solved from the mid.
    const last = chainGreeks({ quotes: [row], market: MARKET, priceSource: 'last' });
    expect(last.value[0]).toBe(row);
    expect(last.diagnostics.rows[0]).toMatchObject({
      status: 'skipped',
      reason: 'chain_greeks.no_price',
    });
    expect(last.assumptions.priceSource).toBe('last');
  });

  it('a row the pricer refuses is reported and returned unchanged; the chain still comes back', () => {
    const good = exactRow(105, 'call', 'european');
    const belowIntrinsic: OptionQuote = {
      contract: contract(80, 'call', 'european'),
      timestampMs: Date.UTC(2026, 0, 2),
      mid: 1, // intrinsic is 25: no volatility reproduces this price
    };
    const noPrice: OptionQuote = { contract: contract(110, 'put', 'european'), timestampMs: 1 };
    const expired: OptionQuote = {
      contract: {
        ...contract(100, 'call', 'european'),
        expiry: '2025-12-19',
        ...resolvedExpiry('2025-12-19'),
      },
      timestampMs: 1,
      mid: 5,
    };
    const result = chainGreeks({
      quotes: [good, belowIntrinsic, noPrice, expired],
      market: MARKET,
    });
    expect(result.value[0]!.greeks).toBeDefined();
    expect(result.value[1]).toBe(belowIntrinsic);
    expect(result.value[2]).toBe(noPrice);
    expect(result.value[3]).toBe(expired);
    expect(result.diagnostics.rows.map((r) => r.status)).toEqual([
      'solved',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(result.diagnostics.rows[1]!.reason).toMatch(/intrinsic|arbitrage|bound/);
    expect(result.diagnostics.rows[2]!.reason).toBe('chain_greeks.no_price');
    expect(result.diagnostics.rows[3]!.reason).toBeTruthy();
    expect(result.diagnostics.rows[3]!.message).toMatch(/expir/i);
    expect(result.diagnostics.solvedCount).toBe(1);
    expect(result.diagnostics.skippedCount).toBe(3);
    expect(result.diagnostics.warnings).toHaveLength(1);
    expect(result.diagnostics.warnings[0]).toMatchObject({
      code: 'chain_greeks.rows_skipped',
      severity: 'warn',
      context: { skippedCount: 3, rowCount: 4 },
    });
  });

  it('an empty chain is an empty envelope, not an error', () => {
    const result = chainGreeks({ quotes: [], market: MARKET });
    expect(result.value).toEqual([]);
    expect(result.diagnostics).toMatchObject({ solvedCount: 0, skippedCount: 0, warnings: [] });
  });
});

describe('chainGreeks — the request is validated like every other door', () => {
  const quotes = [exactRow(105, 'call', 'european')];

  it('a row that is not a quote is a typed error, not a skipped row', () => {
    expect(() => chainGreeks({ quotes: [5 as never], market: MARKET })).toThrow(
      /input\.quotes\[0\]/,
    );
    expect(() => chainGreeks({ quotes: [{ timestampMs: 1 } as never], market: MARKET })).toThrow(
      /input\.quotes\[0\]\.contract/,
    );
  });

  it('refuses an unknown key, a bad price source, and a bare-date valuation instant', () => {
    expect(() => chainGreeks({ quotes, market: MARKET, source: 'mid' } as never)).toThrow(/source/);
    expect(() => chainGreeks({ quotes, market: MARKET, priceSource: 'close' as never })).toThrow(
      /priceSource/,
    );
    expect(() => chainGreeks({ quotes, market: { ...MARKET, asOf: '2026-01-02' } })).toThrow(
      /instant|asOf/,
    );
  });

  it('refuses a missing or non-positive spot with the typed code', () => {
    let code = '';
    try {
      chainGreeks({ quotes, market: { ...MARKET, spot: -1 } });
    } catch (error) {
      code = (error as { code: string }).code;
    }
    expect(code).toBe(ErrorCode.InputNegativeSpot);
    expect(() =>
      chainGreeks({ quotes, market: { riskFreeRate: 0.04, asOf: AS_OF } as never }),
    ).toThrow(/spot/);
  });

  it('echoes every assumption in the envelope', () => {
    const { assumptions } = chainGreeks({ quotes, market: MARKET });
    expect(assumptions).toMatchObject({
      dayCount: 'ACT/365F',
      compounding: 'continuous',
      priceSource: 'mid',
      provenanceSource: 'chainGreeks',
      spot: 105,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
    });
    expect(typeof assumptions.asOf).toBe('number');
    expect(assumptions.units).toBeDefined();
  });
});
