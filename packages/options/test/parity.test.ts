import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import { InputError, type OptionQuote } from '@totalfinance/core';
import {
  boxSpreadRate,
  impliedBorrow,
  impliedDividendYield,
  impliedForward,
  ParityCode,
} from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

/**
 * Synthetic one-expiry chain priced from KNOWN {spot, r, q}. Parity is volatility-independent
 * (`C − P = e^(−rT)(F − K)` uses the same F/r/T for both legs), so a single vol suffices; each
 * quote's `mid` is set to the exact BSM price.
 */
const SPOT = 100;
const RATE = 0.03;
const DIV_YIELD = 0.015;
const SIGMA = 0.25;
const T = 0.5;

// A full ISO datetime expiry is parsed as-is by the option-expiry convention, so we can construct
// asOf such that ACT/365F time-to-expiry is exactly T = 0.5.
const EXPIRY = '2026-01-16T21:00:00.000Z';
const MS_PER_YEAR_365 = 365 * 86_400_000;
const EXPIRY_MS = Date.parse(EXPIRY);
const AS_OF = EXPIRY_MS - T * MS_PER_YEAR_365;

// F = S·e^((r−q)T).
const FORWARD = SPOT * Math.exp((RATE - DIV_YIELD) * T);

function makeChain(strikes: number[]): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const strike of strikes) {
    for (const type of ['call', 'put'] as const) {
      const price = blackScholesPrice({
        type,
        spot: SPOT,
        strike,
        timeToExpiryYears: T,
        riskFreeRate: RATE,
        dividendYield: DIV_YIELD,
        volatility: SIGMA,
      });
      rows.push({
        contract: {
          underlying: 'ACME',
          type,
          style: 'european',
          strike,
          expiry: EXPIRY,
          ...resolvedExpiry(EXPIRY),
        },
        timestampMs: AS_OF,
        mid: price,
      });
    }
  }
  return rows;
}

const STRIKES = [70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130];

describe('put-call parity — clean synthetic chain', () => {
  const rows = makeChain(STRIKES);

  it('impliedForward recovers F = S·e^((r−q)T) to 1e-6', () => {
    const res = impliedForward({
      quotes: rows,
      expiry: EXPIRY,
      options: { riskFreeRate: RATE, asOf: AS_OF },
    });
    expect(Math.abs(res.value - FORWARD)).toBeLessThan(1e-6);
    expect(res.diagnostics.converged).toBe(true);
    // A clean chain is never falsely trimmed.
    expect(res.diagnostics.trimmedCount).toBe(0);
    expect(res.diagnostics.trimmedStrikes).toEqual([]);
    expect(res.diagnostics.perStrike).toHaveLength(STRIKES.length);
    expect(res.diagnostics.rSquared).toBeGreaterThan(1 - 1e-9);
    // Regression-implied discount factor is e^(−rT).
    expect(res.diagnostics.impliedDiscountFactor).toBeCloseTo(Math.exp(-RATE * T), 10);
    expect(res.assumptions.timeToExpiryYears).toBeCloseTo(T, 12);
    expect(res.assumptions.priceSource).toBe('mid');
  });

  it('impliedDividendYield recovers q to 1e-6', () => {
    const res = impliedDividendYield({
      quotes: rows,
      expiry: EXPIRY,
      options: { riskFreeRate: RATE, spot: SPOT, asOf: AS_OF },
    });
    expect(Math.abs(res.value - DIV_YIELD)).toBeLessThan(1e-6);
    expect(res.assumptions.spot).toBe(SPOT);
  });

  it('impliedBorrow ≈ 0 when the true rate is supplied', () => {
    const res = impliedBorrow({
      quotes: rows,
      expiry: EXPIRY,
      options: { riskFreeRate: RATE, spot: SPOT, asOf: AS_OF },
    });
    expect(Math.abs(res.value)).toBeLessThan(1e-6);
    expect(res.diagnostics.impliedRate).toBeCloseTo(RATE, 8);
  });

  it('impliedBorrow reports the spread when the supplied rate is wrong', () => {
    const wrongRate = RATE + 0.02;
    const res = impliedBorrow({
      quotes: rows,
      expiry: EXPIRY,
      options: { riskFreeRate: wrongRate, spot: SPOT, asOf: AS_OF },
    });
    // Implied financing rate is the true RATE, so the spread is RATE − wrongRate = −0.02.
    expect(res.value).toBeCloseTo(RATE - wrongRate, 8);
  });
});

describe('box spread', () => {
  const rows = makeChain(STRIKES);

  it('recovers the financing rate r to 1e-6', () => {
    const res = boxSpreadRate({
      quotes: rows,
      expiry: EXPIRY,
      lowerStrike: 90,
      upperStrike: 110,
      options: { asOf: AS_OF },
    });
    expect(Math.abs(res.value - RATE)).toBeLessThan(1e-6);
    expect(res.diagnostics.width).toBe(20);
    expect(res.diagnostics.discountFactor).toBeCloseTo(Math.exp(-RATE * T), 10);
    expect(res.diagnostics.converged).toBe(true);
  });

  it('throws parity.strike_unavailable when a leg is missing', () => {
    // 137.5 is not in the grid, so the box legs at that strike cannot be resolved.
    expect(() =>
      boxSpreadRate({
        quotes: rows,
        expiry: EXPIRY,
        lowerStrike: 90,
        upperStrike: 137.5,
        options: { asOf: AS_OF },
      }),
    ).toThrowError(InputError);
    try {
      boxSpreadRate({
        quotes: rows,
        expiry: EXPIRY,
        lowerStrike: 90,
        upperStrike: 137.5,
        options: { asOf: AS_OF },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).code).toBe(ParityCode.StrikeUnavailable);
    }
  });

  it('rejects k1 >= k2', () => {
    expect(() =>
      boxSpreadRate({
        quotes: rows,
        expiry: EXPIRY,
        lowerStrike: 110,
        upperStrike: 90,
        options: { asOf: AS_OF },
      }),
    ).toThrowError(InputError);
  });

  it('guards its containers like its siblings: undefined rows / missing options teach, not crash', () => {
    // Missing rows must be a typed InputError, not `undefined.find` deep in leg resolution.
    expect(() =>
      boxSpreadRate({
        quotes: undefined as never,
        expiry: EXPIRY,
        lowerStrike: 90,
        upperStrike: 110,
        options: { asOf: AS_OF },
      }),
    ).toThrowError(InputError);
    try {
      boxSpreadRate({
        quotes: undefined as never,
        expiry: EXPIRY,
        lowerStrike: 90,
        upperStrike: 110,
        options: { asOf: AS_OF },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).code).toBe('input.wrong_type');
    }
    // Missing options must be a typed InputError, not `undefined.source`.
    expect(() =>
      boxSpreadRate({
        quotes: rows,
        expiry: EXPIRY,
        lowerStrike: 90,
        upperStrike: 110,
        options: undefined as never,
      }),
    ).toThrowError(InputError);
    try {
      boxSpreadRate({
        quotes: rows,
        expiry: EXPIRY,
        lowerStrike: 90,
        upperStrike: 110,
        options: undefined as never,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).code).toBe('input.wrong_type');
    }
  });
});

describe('robustness — MAD outlier trimming', () => {
  it('recovers F despite one corrupted quote and echoes the trimmed strike', () => {
    const rows = makeChain(STRIKES);
    const badStrike = 100;
    // Corrupt the call mid at one interior strike with a gross error.
    const target = rows.find((r) => r.contract.strike === badStrike && r.contract.type === 'call');
    expect(target).toBeDefined();
    target!.mid = (target!.mid ?? 0) + 5;

    const res = impliedForward({
      quotes: rows,
      expiry: EXPIRY,
      options: { riskFreeRate: RATE, asOf: AS_OF },
    });

    // The corrupted strike is trimmed and echoed in diagnostics.
    expect(res.diagnostics.trimmedCount).toBeGreaterThanOrEqual(1);
    expect(res.diagnostics.trimmedStrikes).toContain(badStrike);
    const flagged = res.diagnostics.perStrike.find((p) => p.strike === badStrike);
    expect(flagged?.trimmed).toBe(true);

    // Trimmed regression still recovers F within a loose tolerance.
    expect(Math.abs(res.value - FORWARD)).toBeLessThan(1e-3);
  });

  it('dividend yield stays accurate after trimming a corrupted put', () => {
    const rows = makeChain(STRIKES);
    const badStrike = 95;
    const target = rows.find((r) => r.contract.strike === badStrike && r.contract.type === 'put');
    target!.mid = (target!.mid ?? 0) - 4;

    const res = impliedDividendYield({
      quotes: rows,
      expiry: EXPIRY,
      options: { riskFreeRate: RATE, spot: SPOT, asOf: AS_OF },
    });
    expect(res.diagnostics.trimmedStrikes).toContain(badStrike);
    expect(Math.abs(res.value - DIV_YIELD)).toBeLessThan(1e-3);
  });
});
