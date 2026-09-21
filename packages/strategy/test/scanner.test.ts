/**
 * Tests for the strategy scanner/optimizer (§12, product review §1): structure enumeration, ranking by
 * each objective, filters, liquidity scoring, premium synthesis from vol, and consistency with building
 * a ranked candidate directly.
 */

import { describe, expect, it } from 'vitest';
import { optionExpiryToMs, yearFraction } from '@totalfinance/core';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  SCAN_OBJECTIVES,
  type ScanQuoteRow,
  scanStrategies,
  strategy,
} from '@totalfinance/strategy';

const asOf = Date.UTC(2026, 0, 1);
const expiry = '2026-04-02';
/** Time-to-expiry exactly as the scanner derives it (16:00-ET date-only convention). */
const expiryT = (): number => yearFraction(asOf, optionExpiryToMs(expiry), 'ACT/365F');
const rate = 0.03;
const vol = 0.25;
const S = 100;
const strikes = [80, 85, 90, 95, 100, 105, 110, 115, 120];
const chain: ScanQuoteRow[] = strikes.map((strike) => ({ strike }));
const base = { spot: S, asOf, expiry, riskFreeRate: rate, volatility: vol, chain } as const;
const { volatility: _baseVolatility, ...baseNoVolatility } = base; // for smile-only / no-vol scans

describe('scanStrategies', () => {
  it('RV11 — the rankBy error lists EXACTLY the accepted values, generated from them', () => {
    /**
     * The message used to be hand-written prose: `rankBy must be pop|ev|return|expectedValuePerRisk`.
     * When `'pop'` and `'ev'` were renamed, the quoted literals in the validation array moved and the
     * prose did not, because prose is invisible to a rename of quoted literals. The error then taught
     * two values the function would reject — the worst kind of error, one that hands you a wrong fix.
     *
     * It is now derived from `SCAN_OBJECTIVES` with `.join(', ')`, and this asserts the derivation
     * rather than the string: every accepted value must appear, and the retired spellings must not.
     * A future rename cannot separate them again without failing here.
     */
    let message = '';
    try {
      scanStrategies({ ...base, rankBy: 'nope' as never });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, 'an invalid rankBy must throw').toContain('rankBy must be one of');
    for (const objective of SCAN_OBJECTIVES) {
      expect(message, `${objective} is accepted, so the error must offer it`).toContain(objective);
    }
    // The retired spellings, written split so a future sweep cannot rewrite them into the survivors.
    expect(message).not.toContain('p' + 'op|');
    expect(message).not.toContain('|e' + 'v|');
    expect(message).not.toContain("'re" + "turn'");
    // And the rename is real: the objective that ranks by return-on-risk says so.
    expect([...SCAN_OBJECTIVES]).toContain('returnOnRisk');
    expect([...SCAN_OBJECTIVES]).not.toContain('re' + 'turn');
  });

  it('ranks by returnOnRisk under the name the candidate reports it by', () => {
    // Law N5, the reason for the rename: `rankBy: 'return'` sorted on a number the candidate output
    // already called `returnOnRisk`. One quantity may not carry two public names.
    const ranked = scanStrategies({ ...base, rankBy: 'returnOnRisk', top: 10 }).candidates;
    expect(ranked.length).toBeGreaterThan(1);
    // A defined ratio never ranks below an undefined (`null`) one, and defined ratios descend.
    const rank = (value: number | null): number => (value === null ? -Infinity : value);
    for (let i = 1; i < ranked.length; i++) {
      expect(rank(ranked[i - 1]!.returnOnRisk)).toBeGreaterThanOrEqual(
        rank(ranked[i]!.returnOnRisk),
      );
    }
  });

  it('enumerates only the requested structures and honors top-N', () => {
    const res = scanStrategies({
      ...base,
      structures: ['bullCallSpread'],
      rankBy: 'probabilityOfProfit',
      top: 5,
    }).candidates;
    expect(res.length).toBeLessThanOrEqual(5);
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((c) => c.structure === 'bullCallSpread')).toBe(true);
    // Ranked descending by the objective.
    for (let i = 1; i < res.length; i++) {
      expect(res[i - 1]!.score ?? -Infinity).toBeGreaterThanOrEqual(res[i]!.score ?? -Infinity);
    }
  });

  it("a ranked candidate's metrics reproduce building that structure directly", () => {
    const [top] = scanStrategies({
      ...base,
      structures: ['bullCallSpread'],
      rankBy: 'expectedValue',
      top: 1,
    }).candidates;
    const [lo, hi] = top!.strikes as [number, number];
    const pos = strategy.bullCallSpread({
      long: {
        strike: lo,
        premium: blackScholesPrice({
          type: 'call',
          spot: S,
          strike: lo,
          timeToExpiryYears: expiryT(),
          riskFreeRate: rate,
          dividendYield: 0,
          volatility: vol,
        }),
      },
      short: {
        strike: hi,
        premium: blackScholesPrice({
          type: 'call',
          spot: S,
          strike: hi,
          timeToExpiryYears: expiryT(),
          riskFreeRate: rate,
          dividendYield: 0,
          volatility: vol,
        }),
      },
    });
    const prob = pos.probability({ spot: S, asOf, expiry, volatility: vol, riskFreeRate: rate });
    expect(top!.probabilityOfProfit).toBeCloseTo(prob.probabilityOfProfit, 10);
    expect(top!.expectedValue).toBeCloseTo(prob.expectedValue, 8);
    expect(top!.maxLoss).toBeCloseTo(pos.metrics().maxLoss!, 8);
  });

  it('ranks by POP when asked, and the top candidate has the highest POP', () => {
    const res = scanStrategies({ ...base, rankBy: 'probabilityOfProfit', top: 50 }).candidates;
    const maxPop = Math.max(...res.map((c) => c.probabilityOfProfit));
    expect(res[0]!.probabilityOfProfit).toBeCloseTo(maxPop, 12);
  });

  it('ranks every enumerated structure kind when structures is left default', () => {
    const res = scanStrategies({ ...base, top: 200 }).candidates;
    const kinds = new Set(res.map((c) => c.structure));
    expect(kinds.size).toBeGreaterThan(3); // multiple structure families surfaced
  });

  it('applies the minProbabilityOfProfit and maxRisk filters', () => {
    // Metrics are per contract (100× multiplier), so maxRisk is in dollars-per-contract.
    const res = scanStrategies({
      ...base,
      minProbabilityOfProfit: 0.5,
      maxRisk: 320,
      top: 100,
    }).candidates;
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((c) => c.probabilityOfProfit >= 0.5)).toBe(true);
    expect(res.every((c) => Math.abs(c.maxLoss!) <= 320 + 1e-9)).toBe(true);
    // An unsatisfiable POP filter yields nothing (never a fabricated candidate).
    expect(
      scanStrategies({ ...base, minProbabilityOfProfit: 0.999, top: 100 }).candidates,
    ).toHaveLength(0);
  });

  it('scores a liquidity in [0,1] from bid/ask, null when unpriced', () => {
    const tight: ScanQuoteRow[] = strikes.map((strike) => {
      const c = blackScholesPrice({
        type: 'call',
        spot: S,
        strike,
        timeToExpiryYears: expiryT(),
        riskFreeRate: rate,
        dividendYield: 0,
        volatility: vol,
      });
      const p = blackScholesPrice({
        type: 'put',
        spot: S,
        strike,
        timeToExpiryYears: expiryT(),
        riskFreeRate: rate,
        dividendYield: 0,
        volatility: vol,
      });
      return {
        strike,
        call: c,
        put: p,
        callBid: c - 0.02,
        callAsk: c + 0.02,
        putBid: p - 0.02,
        putAsk: p + 0.02,
      };
    });
    const withLiq = scanStrategies({
      ...base,
      chain: tight,
      structures: ['bullCallSpread'],
      top: 3,
    }).candidates;
    expect(withLiq.every((c) => c.liquidity !== null && c.liquidity > 0 && c.liquidity <= 1)).toBe(
      true,
    );
    const noLiq = scanStrategies({ ...base, structures: ['bullCallSpread'], top: 3 }).candidates;
    expect(noLiq.every((c) => c.liquidity === null)).toBe(true);
  });

  it('prices missing premiums from a per-strike smile', () => {
    const smile = (strike: number): number => 0.25 + 0.0015 * (100 - strike);
    const res = scanStrategies({
      ...baseNoVolatility,
      smile,
      structures: ['ironCondor'],
      top: 3,
    }).candidates;
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((c) => c.structure === 'ironCondor' && c.strikes.length === 4)).toBe(true);
  });

  it('validates inputs', () => {
    expect(() => scanStrategies({ ...base, chain: [{ strike: 100 }] })).toThrow(/2 strikes/);
    expect(() => scanStrategies({ ...baseNoVolatility, chain })).toThrow(/volatility/);
    expect(() => scanStrategies({ ...base, top: 0 })).toThrow(/top/);
    // An unknown structure name (config/UI typo) throws rather than silently returning nothing.
    expect(() =>
      scanStrategies({ ...base, structures: ['bullCallSpred' as unknown as 'bullCallSpread'] }),
    ).toThrow(/unknown structure/);
    // Out-of-range / NaN filters throw instead of silently returning misleading results.
    expect(() => scanStrategies({ ...base, minProbabilityOfProfit: Number.NaN })).toThrow(
      /minProbabilityOfProfit/,
    );
    expect(() => scanStrategies({ ...base, minProbabilityOfProfit: 2 })).toThrow(
      /minProbabilityOfProfit/,
    );
    expect(() => scanStrategies({ ...base, maxRisk: -1 })).toThrow(/maxRisk/);
    expect(() => scanStrategies({ ...base, maxWidth: -1 })).toThrow(/maxWidth/);
    // A smile returning a non-finite vol throws a clear volatility error, not a downstream premium one.
    expect(() =>
      scanStrategies({ ...baseNoVolatility, smile: () => Number.POSITIVE_INFINITY }),
    ).toThrow(/volatility/);
  });

  it('validates the chain container and rows (teaching errors, never raw TypeErrors)', () => {
    const { chain: _omit, ...noChain } = base;
    // Missing chain: previously "Cannot read properties of undefined (reading 'length')".
    expect(() => scanStrategies(noChain as never)).toThrow(/chain must be an array, got undefined/);
    // A non-array chain: previously "options.chain is not iterable".
    expect(() => scanStrategies({ ...base, chain: {} as never })).toThrow(
      /chain must be an array, got object/,
    );
    // A null row: previously "Cannot read properties of null (reading 'strike')" in the sort.
    expect(() => scanStrategies({ ...base, chain: [null, { strike: 100 }] as never })).toThrow(
      /chain\[0\] must be a ScanQuoteRow/,
    );
    // A row without a numeric strike teaches the row shape — wherever it sits in the chain.
    let caught: unknown;
    try {
      scanStrategies({ ...base, chain: [{ strike: 100 }, { call: 3 }] as never });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toMatch(/chain\[1\] must be a ScanQuoteRow/);
    expect((caught as Error).message).toContain('callBid');
    expect(caught instanceof TypeError).toBe(false);
  });
});
