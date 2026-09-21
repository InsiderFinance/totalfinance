import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import { type OptionQuote, isQuantError } from '@totalfinance/core';
import { impliedForward } from '@totalfinance/options';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';

/**
 * Regression for an external-review finding: put-call parity accepted American and mixed chains and
 * fit a confident-but-wrong forward (converged:true). It is a European, single-underlying relation.
 */
const SPOT = 100;
const RATE = 0.03;
const DIV = 0.015;
const SIGMA = 0.25;
const T = 0.5;
const EXPIRY = '2026-01-16T21:00:00.000Z';
const AS_OF = Date.parse(EXPIRY) - T * 365 * 86_400_000;
const STRIKES = [90, 95, 100, 105, 110];

function chain(
  style: 'european' | 'american',
  underlyingOf: (i: number) => string = () => 'ACME',
): OptionQuote[] {
  const rows: OptionQuote[] = [];
  STRIKES.forEach((strike, i) => {
    for (const type of ['call', 'put'] as const) {
      rows.push({
        contract: {
          underlying: underlyingOf(i),
          type,
          style,
          strike,
          expiry: EXPIRY,
          ...resolvedExpiry(EXPIRY),
        },
        timestampMs: AS_OF,
        mid: blackScholesPrice({
          type,
          spot: SPOT,
          strike,
          timeToExpiryYears: T,
          riskFreeRate: RATE,
          dividendYield: DIV,
          volatility: SIGMA,
        }),
      });
    }
  });
  return rows;
}

describe('put-call parity — European-only, single-underlying guard', () => {
  it('rejects an American chain (early-exercise premium biases the forward)', () => {
    let caught: unknown;
    try {
      impliedForward({
        quotes: chain('american'),
        expiry: EXPIRY,
        options: { riskFreeRate: RATE, asOf: AS_OF },
      });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.wrong_type')).toBe(true);
    expect((caught as Error).message).toMatch(/EUROPEAN options only/);
  });

  it('rejects a mixed-underlying chain', () => {
    const mixed = chain('european', (i) => (i === 0 ? 'OTHER' : 'ACME'));
    expect(() =>
      impliedForward({
        quotes: mixed,
        expiry: EXPIRY,
        options: { riskFreeRate: RATE, asOf: AS_OF },
      }),
    ).toThrow(/single underlying/);
  });

  it('still accepts a clean European single-underlying chain', () => {
    const res = impliedForward({
      quotes: chain('european'),
      expiry: EXPIRY,
      options: { riskFreeRate: RATE, asOf: AS_OF },
    });
    expect(res.value).toBeGreaterThan(0);
    expect(res.diagnostics.converged).toBe(true);
  });
});
