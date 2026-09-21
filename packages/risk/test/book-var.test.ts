/**
 * Greek-based book VaR (`bookVaR`) — a delta-gamma Value-at-Risk / CVaR over a book of strategy
 * positions. Verifies the parametric closed form, parametric↔Monte-Carlo agreement on a linear book,
 * the gamma effect (short gamma → fatter MC left tail), correlation, the component decomposition,
 * horizonPeriods √-scaling, vol-of-vol, determinism, and the envelope/guards.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { normalInverseCdf } from '@totalfinance/math';
import { strategy } from '@totalfinance/strategy';
import { bookVaR, type BookVaRPosition } from '@totalfinance/risk';

const EXPIRY = '2026-09-18';
const ASOF = '2026-05-01T00:00:00Z'; // a valuation instant names its time of day
const Z95 = -normalInverseCdf(0.05); // ≈ 1.6449

/** A pure-linear book: 100 shares of stock (δ = 100, γ = θ = vega = 0). */
function stockBook(spot = 100, underlying = 'XYZ'): BookVaRPosition[] {
  return [
    {
      position: strategy([{ kind: 'stock', price: spot, quantity: 100 }], {
        multiplier: 100,
        expiry: EXPIRY,
      }),
      market: { spot, riskFreeRate: 0.04, asOf: ASOF },
      underlying,
    },
  ];
}

/** A short ATM straddle: short gamma (negative convexity), ~zero delta. */
function shortStraddle(underlying = 'XYZ'): BookVaRPosition[] {
  return [
    {
      position: strategy(
        [
          { kind: 'call', strike: 100, quantity: -1, premium: 6, impliedVolatility: 0.3 },
          { kind: 'put', strike: 100, quantity: -1, premium: 6, impliedVolatility: 0.3 },
        ],
        { multiplier: 100, expiry: EXPIRY },
      ),
      market: { spot: 100, riskFreeRate: 0.04, asOf: ASOF },
      underlying,
    },
  ];
}

describe('bookVaR — parametric closed form (linear book)', () => {
  it('matches z·|δ|·σ·spot·√h for a pure-stock book, with zero drift', () => {
    const r = bookVaR(stockBook(), {
      factors: { XYZ: { spotReturnVolatility: 0.2 } },
      confidence: 0.95,
      horizonDays: 1,
      seed: 7,
      samples: 20_000,
    });
    const d = r.components[0]!.delta;
    const sd = 0.2 * 100 * Math.sqrt(1 / 252);
    expect(r.parametric!.valueAtRisk).toBeCloseTo(Z95 * Math.abs(d) * sd, 6);
    expect(r.parametric!.pnlMean).toBeCloseTo(0, 9); // no gamma / theta
    expect(r.parametric!.conditionalValueAtRisk).toBeGreaterThan(r.parametric!.valueAtRisk); // ES ≥ VaR
  });

  it('the Monte-Carlo VaR agrees with the parametric one on a linear book', () => {
    const r = bookVaR(stockBook(), {
      factors: { XYZ: { spotReturnVolatility: 0.2 } },
      seed: 11,
      samples: 40_000,
    });
    const rel =
      Math.abs(r.monteCarlo!.valueAtRisk - r.parametric!.valueAtRisk) / r.parametric!.valueAtRisk;
    expect(rel).toBeLessThan(0.05); // linear P&L is Gaussian → the two methods coincide
  });
});

describe('bookVaR — gamma', () => {
  it('a short-gamma book has a fatter MC left tail than the delta-normal parametric VaR', () => {
    const r = bookVaR(shortStraddle(), {
      factors: { XYZ: { spotReturnVolatility: 0.6 } },
      horizonDays: 5,
      seed: 3,
      samples: 40_000,
    });
    // Negative convexity → large moves lose disproportionately → MC captures a bigger loss than the
    // linear approximation, which sees almost no delta dispersion.
    expect(r.monteCarlo!.valueAtRisk).toBeGreaterThan(r.parametric!.valueAtRisk);
    // Both methods agree on the expected P&L (the gamma-convexity + theta drift), to within MC noise.
    const relMeanGap =
      Math.abs(r.monteCarlo!.pnlMean - r.parametric!.pnlMean) / Math.abs(r.parametric!.pnlMean);
    expect(relMeanGap).toBeLessThan(0.02);
  });
});

describe('bookVaR — correlation', () => {
  it('positive correlation raises book VaR vs independence (lost diversification)', () => {
    const book = [...stockBook(100, 'XYZ'), ...stockBook(100, 'ABC')];
    const factors = { XYZ: { spotReturnVolatility: 0.25 }, ABC: { spotReturnVolatility: 0.25 } };
    const indep = bookVaR(book, { factors, method: 'parametric' });
    const correlated = bookVaR(book, {
      factors,
      method: 'parametric',
      correlation: [
        [1, 0.9],
        [0.9, 1],
      ],
    });
    expect(correlated.parametric!.valueAtRisk).toBeGreaterThan(indep.parametric!.valueAtRisk);
  });
});

describe('bookVaR — per-underlying decomposition', () => {
  it('component VaR sums to z·σ_L; standalone ≥ component under diversification', () => {
    const book = [...stockBook(100, 'XYZ'), ...stockBook(120, 'ABC')];
    const r = bookVaR(book, {
      factors: { XYZ: { spotReturnVolatility: 0.25 }, ABC: { spotReturnVolatility: 0.35 } },
      method: 'parametric',
      correlation: [
        [1, 0.2],
        [0.2, 1],
      ],
    });
    const sumComponent = r.components.reduce((a, c) => a + c.componentVaR, 0);
    expect(sumComponent).toBeCloseTo(Z95 * r.parametric!.pnlStandardDeviation, 6); // Σ component = dispersion VaR
    for (const c of r.components)
      expect(c.standaloneVaR).toBeGreaterThanOrEqual(c.componentVaR - 1e-9);
    expect(r.assumptions.underlyings).toEqual(['ABC', 'XYZ']); // sorted (correlation row order)
  });
});

describe('bookVaR — horizonPeriods & vol-of-vol', () => {
  it('parametric VaR scales as √time for a linear book', () => {
    const one = bookVaR(stockBook(), {
      factors: { XYZ: { spotReturnVolatility: 0.2 } },
      horizonDays: 1,
      method: 'parametric',
    });
    const four = bookVaR(stockBook(), {
      factors: { XYZ: { spotReturnVolatility: 0.2 } },
      horizonDays: 4,
      method: 'parametric',
    });
    expect(four.parametric!.valueAtRisk / one.parametric!.valueAtRisk).toBeCloseTo(2, 6); // √4 = 2
  });

  it('adding vol-of-vol raises VaR on a vega-bearing book', () => {
    const noVega = bookVaR(shortStraddle(), {
      factors: { XYZ: { spotReturnVolatility: 0.3 } },
      method: 'parametric',
    });
    const withVega = bookVaR(shortStraddle(), {
      factors: { XYZ: { spotReturnVolatility: 0.3, volatilityOfVolatility: 0.4 } },
      method: 'parametric',
    });
    expect(withVega.parametric!.valueAtRisk).toBeGreaterThan(noVega.parametric!.valueAtRisk);
  });
});

describe('bookVaR — determinism', () => {
  it('the same seed reproduces the Monte-Carlo VaR exactly', () => {
    const options = {
      factors: { XYZ: { spotReturnVolatility: 0.4 } },
      seed: 42,
      samples: 5_000,
    } as const;
    const a = bookVaR(shortStraddle(), options);
    const b = bookVaR(shortStraddle(), options);
    expect(a.monteCarlo!.valueAtRisk).toBe(b.monteCarlo!.valueAtRisk);
    expect(a.assumptions.seed).toBe(42);
    expect(a.assumptions.samples).toBe(5_000);
  });
});

describe('bookVaR — envelope & guards', () => {
  it('an empty book returns a valid zero envelope', () => {
    const r = bookVaR([], { factors: {} });
    expect(r.parametric!.valueAtRisk).toBe(0);
    expect(r.monteCarlo!.valueAtRisk).toBe(0);
    expect(r.components).toHaveLength(0);
    expect(r.assumptions.conventionsVersion).toBeDefined();
    expect(r.diagnostics.engine).toBe('book-var');
  });

  it('throws typed errors on garbage, a missing factor, bad confidence, and a bad correlation', () => {
    expect(() => bookVaR(undefined as never, { factors: {} })).toThrowError();
    // Missing risk factor for the book's underlying.
    try {
      bookVaR(stockBook(), { factors: {} });
      expect.unreachable('a missing factor should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
    // Confidence out of (0, 1).
    expect(() =>
      bookVaR(stockBook(), { factors: { XYZ: { spotReturnVolatility: 0.2 } }, confidence: 1.5 }),
    ).toThrowError();
    // A non-Position.
    try {
      bookVaR([{ position: {}, market: { spot: 1, riskFreeRate: 0, asOf: 0 } } as never], {
        factors: { 'position-0': { spotReturnVolatility: 0.2 } },
      });
      expect.unreachable('a raw object should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
    // Correlation of the wrong shape.
    expect(() =>
      bookVaR(stockBook(), {
        factors: { XYZ: { spotReturnVolatility: 0.2 } },
        correlation: [[1, 0]],
      }),
    ).toThrowError();
  });

  it('rejects an oversized Monte-Carlo request before running it', () => {
    expect(() =>
      bookVaR(stockBook(), { factors: { XYZ: { spotReturnVolatility: 0.2 } }, samples: 5_000_000 }),
    ).toThrowError(/samples/);
  });
});

describe('bookVaR — review-fix regressions', () => {
  it('rejects a non-PSD correlation on the parametric path (no silent clamp to 0)', () => {
    const book = [...stockBook(100, 'A'), ...stockBook(100, 'B'), ...stockBook(100, 'C')];
    const factors = {
      A: { spotReturnVolatility: 0.3 },
      B: { spotReturnVolatility: 0.3 },
      C: { spotReturnVolatility: 0.3 },
    };
    // All pairwise −0.6 → eigenvalue 1 + 2(−0.6) = −0.2 on (1,1,1) → non-PSD.
    const bad = [
      [1, -0.6, -0.6],
      [-0.6, 1, -0.6],
      [-0.6, -0.6, 1],
    ];
    expect(() => bookVaR(book, { factors, correlation: bad, method: 'parametric' })).toThrowError();
    expect(() => bookVaR(book, { factors, correlation: bad, method: 'both' })).toThrowError();
    // A valid PSD correlation still works and is not zero.
    const good = [
      [1, 0.3, 0.3],
      [0.3, 1, 0.3],
      [0.3, 0.3, 1],
    ];
    expect(
      bookVaR(book, { factors, correlation: good, method: 'parametric' }).parametric!.valueAtRisk,
    ).toBeGreaterThan(0);
  });

  it('long-gamma book: standaloneVaR ≥ componentVaR and Σ componentVaR = the parametric VaR', () => {
    const longStraddle = strategy(
      [
        { kind: 'call', strike: 100, quantity: 1, premium: 6, impliedVolatility: 0.3 },
        { kind: 'put', strike: 100, quantity: 1, premium: 6, impliedVolatility: 0.3 },
      ],
      { multiplier: 100, expiry: EXPIRY },
    );
    const book: BookVaRPosition[] = [
      {
        position: longStraddle,
        market: { spot: 100, riskFreeRate: 0.04, asOf: ASOF },
        underlying: 'OPT',
      },
      ...stockBook(120, 'STK'),
    ];
    const r = bookVaR(book, {
      factors: { OPT: { spotReturnVolatility: 0.6 }, STK: { spotReturnVolatility: 0.25 } },
      method: 'parametric',
      correlation: [
        [1, 0.3],
        [0.3, 1],
      ],
      horizonDays: 10,
    });
    // The invariant now holds even for a positive-drift (long-gamma) name (was false before the fix).
    for (const c of r.components) {
      expect(c.standaloneVaR).toBeGreaterThanOrEqual(c.componentVaR - 1e-9);
    }
    // Components decompose the FULL book VaR (drift included), not just the dispersion.
    const sumComponent = r.components.reduce((a, c) => a + c.componentVaR, 0);
    expect(sumComponent).toBeCloseTo(r.parametric!.valueAtRisk, 6);
  });

  it('warns when the same underlying is marked at different spots', () => {
    const a = stockBook(100, 'DUP')[0]!;
    const b = stockBook(200, 'DUP')[0]!;
    const r = bookVaR([a, b], {
      factors: { DUP: { spotReturnVolatility: 0.2 } },
      method: 'parametric',
    });
    expect(r.diagnostics.warnings.some((w) => w.message.includes('different spots'))).toBe(true);
  });
});

/** A delta-dominated book: 50 shares of stock + 1 short straddle — mild (in-domain) short gamma. */
function mixedBook(underlying = 'XYZ'): BookVaRPosition[] {
  return [
    {
      position: strategy([{ kind: 'stock', price: 100, quantity: 50 }], {
        multiplier: 100,
        expiry: EXPIRY,
      }),
      market: { spot: 100, riskFreeRate: 0.04, asOf: ASOF },
      underlying,
    },
    ...shortStraddle(underlying),
  ];
}

/** A long ATM straddle scaled by `qty` — long gamma (positive convexity). */
function longStraddle(qty: number, impliedVolatility = 0.3, underlying = 'XYZ'): BookVaRPosition[] {
  return [
    {
      position: strategy(
        [
          {
            kind: 'call',
            strike: 100,
            quantity: qty,
            premium: 6,
            impliedVolatility,
          },
          {
            kind: 'put',
            strike: 100,
            quantity: qty,
            premium: 6,
            impliedVolatility,
          },
        ],
        { multiplier: 100, expiry: EXPIRY },
      ),
      market: { spot: 100, riskFreeRate: 0.04, asOf: ASOF },
      underlying,
    },
  ];
}

describe('bookVaR — Cornish-Fisher gamma-adjusted VaR', () => {
  it('reduces to the delta-normal VaR when there is no gamma (a linear book)', () => {
    const r = bookVaR(stockBook(), {
      factors: { XYZ: { spotReturnVolatility: 0.2 } },
      method: 'parametric',
    });
    expect(r.cornishFisher).toBeDefined();
    expect(r.cornishFisher!.valueAtRisk).toBeCloseTo(r.parametric!.valueAtRisk, 9);
    expect(r.cornishFisher!.skewness).toBeCloseTo(0, 9);
    expect(r.cornishFisher!.excessKurtosis).toBeCloseTo(0, 9);
  });

  it('tracks the Monte-Carlo delta-gamma VaR far better than the delta-normal (moderate gamma)', () => {
    const r = bookVaR(mixedBook(), {
      factors: { XYZ: { spotReturnVolatility: 0.3 } },
      confidence: 0.95,
      horizonDays: 1,
      samples: 600_000,
      seed: 11,
    });
    expect(r.cornishFisher).toBeDefined();
    // Short gamma fattens the LEFT (loss) tail ⇒ negative P&L skewness and a VaR above the delta-normal.
    expect(r.cornishFisher!.skewness).toBeLessThan(0);
    expect(r.cornishFisher!.valueAtRisk).toBeGreaterThan(r.parametric!.valueAtRisk);
    // The CF VaR is much closer to the (exact) Monte-Carlo than the linear parametric one.
    const cfErr = Math.abs(r.cornishFisher!.valueAtRisk - r.monteCarlo!.valueAtRisk);
    const paramErr = Math.abs(r.parametric!.valueAtRisk - r.monteCarlo!.valueAtRisk);
    expect(cfErr).toBeLessThan(paramErr);
    expect(cfErr).toBeLessThan(0.05 * r.monteCarlo!.valueAtRisk); // within ~5% of the MC
  });

  it('discloses the gamma-induced moments and keeps CVaR ≥ VaR', () => {
    const r = bookVaR(mixedBook(), {
      factors: { XYZ: { spotReturnVolatility: 0.3 } },
      horizonDays: 1,
      method: 'parametric',
    });
    expect(typeof r.cornishFisher!.skewness).toBe('number');
    expect(typeof r.cornishFisher!.excessKurtosis).toBe('number');
    expect(r.cornishFisher!.excessKurtosis).toBeGreaterThan(0); // gamma adds kurtosis
    expect(r.cornishFisher!.conditionalValueAtRisk).toBeGreaterThanOrEqual(
      r.cornishFisher!.valueAtRisk,
    );
  });

  it('omits the CF result and warns when a very convex book pushes it out of domain', () => {
    // A large long straddle over a long horizonPeriods at high vol ⇒ extreme positive skew ⇒ CF invalid.
    const r = bookVaR(longStraddle(80), {
      factors: { XYZ: { spotReturnVolatility: 0.9 } },
      horizonDays: 30,
      samples: 20_000,
      seed: 3,
    });
    expect(r.cornishFisher).toBeUndefined();
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.cornish_fisher_out_of_domain')).toBe(
      true,
    );
    // The Monte-Carlo VaR is still there for this book.
    expect(r.monteCarlo).toBeDefined();
  });

  it('is a zero-variance CF (skew 0) for a riskless book (zero spot vol)', () => {
    // A non-empty book with a zero risk factor ⇒ zero P&L variance ⇒ CF present with zero moments.
    const r = bookVaR(stockBook(), {
      factors: { XYZ: { spotReturnVolatility: 0 } },
      method: 'parametric',
    });
    expect(r.cornishFisher!.valueAtRisk).toBe(0);
    expect(r.cornishFisher!.skewness).toBe(0);
    expect(r.cornishFisher!.excessKurtosis).toBe(0);
  });

  it('is present (zero) for an empty book and absent when method is monteCarlo', () => {
    const empty = bookVaR([], { factors: {}, method: 'parametric' });
    expect(empty.cornishFisher).toBeDefined();
    expect(empty.cornishFisher!.valueAtRisk).toBe(0);
    const monteCarloOnly = bookVaR(shortStraddle(), {
      factors: { XYZ: { spotReturnVolatility: 0.3 } },
      method: 'monteCarlo',
      samples: 5_000,
    });
    expect(monteCarloOnly.cornishFisher).toBeUndefined();
  });
});
