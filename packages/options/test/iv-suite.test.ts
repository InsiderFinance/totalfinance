import { describe, expect, it } from 'vitest';
import {
  impliedVolatility,
  impliedVolatilityMany,
  market,
  option,
  type ImpliedVolatilityMethod,
} from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

const METHODS: ImpliedVolatilityMethod[] = ['brent', 'newton', 'halley', 'householder', 'auto'];

describe('IV method suite: round-trips across regimes', () => {
  const moneyness = [0.7, 0.85, 1.0, 1.15, 1.3];
  const expiries = [0.05, 0.5, 2];
  const rates = [0, 0.05];
  const volatilities = [0.1, 0.3, 0.8];
  const S = 100;

  for (const method of METHODS) {
    it(`method "${method}" reprices within tolerance across the grid`, () => {
      let checked = 0;
      for (const m of moneyness) {
        for (const T of expiries) {
          for (const r of rates) {
            for (const vol of volatilities) {
              for (const type of ['call', 'put'] as const) {
                const K = S * m;
                const price = blackScholesPrice({
                  type,
                  spot: S,
                  strike: K,
                  timeToExpiryYears: T,
                  riskFreeRate: r,
                  dividendYield: 0,
                  volatility: vol,
                });
                if (price < 1e-3) continue;
                const res = impliedVolatility(
                  { price, spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: r, type },
                  { method },
                );
                expect(res.diagnostics.converged).toBe(true);
                expect(res.value).not.toBeNull();
                const reprice = blackScholesPrice({
                  type,
                  spot: S,
                  strike: K,
                  timeToExpiryYears: T,
                  riskFreeRate: r,
                  dividendYield: 0,
                  volatility: res.value!,
                });
                expect(Math.abs(reprice - price) / Math.max(1, price)).toBeLessThan(1e-6);
                checked++;
              }
            }
          }
        }
      }
      expect(checked).toBeGreaterThan(50);
    });
  }
});

describe('IV diagnostics', () => {
  const base = {
    price: 0,
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    type: 'call' as const,
  };
  base.price = blackScholesPrice({
    type: 'call',
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    dividendYield: 0,
    volatility: 0.25,
  });

  it('auto reports the method actually used', () => {
    const res = impliedVolatility(base, { method: 'auto' });
    expect(res.diagnostics.converged).toBe(true);
    expect(['householder', 'brent']).toContain(res.diagnostics.method);
    expect(res.value).toBeCloseTo(0.25, 6);
  });

  it('detects a price above the no-arbitrage upper bound', () => {
    const res = impliedVolatility({ ...base, price: 200 }, { method: 'auto' });
    expect(res.diagnostics.converged).toBe(false);
    expect(res.diagnostics.warnings[0]?.code).toBe('implied_volatility.above_max_bound');
  });

  it('detects a price below intrinsic', () => {
    const res = impliedVolatility(
      {
        price: 0.0001,
        spot: 200,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call',
      },
      { method: 'auto' },
    );
    expect(res.diagnostics.converged).toBe(false);
    expect(res.diagnostics.warnings[0]?.code).toBe('implied_volatility.below_intrinsic');
  });

  it('warns on ill-conditioned (low-vega) inverses', () => {
    // very short-dated deep OTM: tiny but non-zero time value, near-zero vega
    const type = 'call' as const;
    const S = 100;
    const K = 160;
    const T = 0.02;
    const vol = 0.6;
    const price = blackScholesPrice({
      type,
      spot: S,
      strike: K,
      timeToExpiryYears: T,
      riskFreeRate: 0.01,
      dividendYield: 0,
      volatility: vol,
    });
    const res = impliedVolatility(
      { price, spot: S, strike: K, timeToExpiryYears: T, riskFreeRate: 0.01, type },
      { method: 'auto' },
    );
    if (res.diagnostics.converged) {
      expect(res.diagnostics.warnings.some((w) => w.code === 'implied_volatility.low_vega')).toBe(
        true,
      );
    }
  });
});

describe('batch IV', () => {
  it('tolerates bad rows without aborting the chain', () => {
    const good = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.2,
    });
    const rows = [
      {
        price: good,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call' as const,
      },
      {
        price: 999,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call' as const,
      }, // above max
      {
        price: blackScholesPrice({
          type: 'put',
          spot: 100,
          strike: 110,
          timeToExpiryYears: 0.5,
          riskFreeRate: 0.03,
          dividendYield: 0,
          volatility: 0.3,
        }),
        spot: 100,
        strike: 110,
        timeToExpiryYears: 0.5,
        riskFreeRate: 0.03,
        type: 'put' as const,
      },
    ];
    const batch = impliedVolatilityMany(rows);
    const results = batch.results;
    expect(results[0]!.diagnostics.converged).toBe(true);
    expect(results[0]!.value).toBeCloseTo(0.2, 6);
    expect(results[1]!.diagnostics.converged).toBe(false);
    expect(results[2]!.diagnostics.converged).toBe(true);
    // Batch-level report grammar: rows echoed, non-convergence summarized (per-row detail stays).
    expect(batch.assumptions.rows).toBe(3);
    expect(batch.diagnostics.converged).toBe(false);
    expect(batch.diagnostics.warnings[0]?.code).toBe('implied_volatility.no_convergence');
  });

  it('failFast rethrows on an invalid row', () => {
    expect(() =>
      impliedVolatilityMany(
        [
          {
            price: -1,
            spot: 100,
            strike: 100,
            timeToExpiryYears: 1,
            riskFreeRate: 0.05,
            type: 'call',
          },
        ],
        {
          failFast: true,
        },
      ),
    ).toThrowError();
  });

  it('a null row yields a non-converged result — the recovery path itself never crashes', () => {
    const good = blackScholesPrice({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      dividendYield: 0,
      volatility: 0.2,
    });
    const rows = [
      null,
      {
        price: good,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call' as const,
      },
    ];
    const results = impliedVolatilityMany(rows as never).results;
    expect(results).toHaveLength(2);
    expect(results[0]!.diagnostics.converged).toBe(false);
    expect(results[0]!.value).toBeNull();
    // The chain is not aborted: the good row still solves.
    expect(results[1]!.diagnostics.converged).toBe(true);
    expect(results[1]!.value).toBeCloseTo(0.2, 6);
  });

  it("preserves the original error's typed code instead of re-coding everything out_of_range", () => {
    const rows = [
      {
        price: 5,
        spot: -100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.05,
        type: 'call' as const,
      }, // negative spot
      {
        price: 5,
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: Infinity,
        type: 'call' as const,
      }, // non-finite rate
    ];
    const results = impliedVolatilityMany(rows).results;
    expect(results[0]!.diagnostics.warnings[0]!.code).toBe('input.negative_spot');
    expect(results[1]!.diagnostics.warnings[0]!.code).toBe('input.not_finite');
  });
});

describe('pro option.impliedVolatility routes through the method suite', () => {
  // 16:00 ET (21:00 UTC, EST) close: a date-only expiry one EST year later resolves to exactly T = 1.
  const asOf = Date.UTC(2026, 0, 1, 21);
  const expiry = '2027-01-01'; // T = 1
  const price = blackScholesPrice({
    type: 'call',
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    riskFreeRate: 0.05,
    dividendYield: 0,
    volatility: 0.2,
  });
  const contract = option.call({
    convention: 'us-equity-close',
    underlying: 'X',
    strike: 100,
    expiry,
    style: 'european',
  });
  const mkt = market({ spot: 100, riskFreeRate: 0.05, asOf, price });

  it('defaults to auto (Householder) and reports the method used + asOf assumption', () => {
    const r = option.impliedVolatility({ contract, market: mkt });
    expect(r.value).toBeCloseTo(0.2, 8);
    expect(r.diagnostics.converged).toBe(true);
    expect(r.diagnostics.method).toBe('householder');
    expect(r.assumptions.asOf).toBe(asOf); // pro envelope is preserved, not the suite's bare one
  });

  it('honors an explicit method and reports it', () => {
    for (const method of ['brent', 'newton', 'halley', 'householder'] as const) {
      const r = option.impliedVolatility({ contract, market: mkt, method });
      expect(r.value).toBeCloseTo(0.2, 8);
      expect(r.diagnostics.method).toBe(method);
    }
  });

  it('exposes the IV-solve diagnostics (iterations / fallback) on the return type (WS3.4)', () => {
    const r = option.impliedVolatility({ contract, market: mkt });
    // These fields live on ImpliedVolatilityDiagnostics, not the base Diagnostics — the return type is now
    // ImpliedVolatilitySolveResult, so consumers can read them without a cast (types-only regression guard).
    expect(typeof r.diagnostics.iterations).toBe('number');
    expect(typeof r.diagnostics.fallback).toBe('boolean');
    expect(r.diagnostics.iterations).toBeGreaterThanOrEqual(0);
  });
});
