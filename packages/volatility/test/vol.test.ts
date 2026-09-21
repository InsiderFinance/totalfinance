import { resolvedExpiry } from '@totalfinance/core';
import { describe, expect, it } from 'vitest';
import {
  InputError,
  type OptionQuote,
  type OptionType,
  optionExpiryToMs,
  yearFraction,
} from '@totalfinance/core';
import { mulberry32, normalSample } from '@totalfinance/math';
import { blackScholesPrice } from '@totalfinance/options/black-scholes';
import {
  expectedMoveFromImpliedVolatility,
  expectedMoveFromStraddle,
  impliedVolatilityPercentile,
  impliedVolatilityRank,
  impliedVolatilityStatistics,
  probabilityInTheMoney,
  probabilityOfTouch,
  skew,
  volatilitySurface,
} from '@totalfinance/volatility';

const asOf = Date.UTC(2026, 0, 1);
const spot = 100;
const rate = 0.03;
const E0 = '2026-04-02'; // ~0.25y
const E1 = '2026-07-02'; // ~0.5y

// A put-skewed smile with convexity: IV rises for low strikes (equity skew) and curves up in the wings.
function smileImpliedVolatility(strike: number): number {
  const m = 100 - strike;
  return 0.2 + 0.0015 * m + 0.00004 * m * m;
}

function quote(
  type: OptionType,
  strike: number,
  expiry: string,
  impliedVolatility: number,
  oi = 0,
): OptionQuote {
  return {
    contract: {
      underlying: 'X',
      type,
      style: 'european',
      strike,
      expiry,
      ...resolvedExpiry(expiry),
    },
    timestampMs: asOf,
    impliedVolatility,
    openInterest: oi,
    underlyingPrice: spot,
  };
}

function chain(): OptionQuote[] {
  const rows: OptionQuote[] = [];
  for (const expiry of [E0, E1]) {
    for (let k = 80; k <= 120; k += 5) {
      const impliedVolatility = smileImpliedVolatility(k);
      rows.push(quote('call', k, expiry, impliedVolatility, 500));
      rows.push(quote('put', k, expiry, impliedVolatility, 500));
    }
  }
  return rows;
}

describe('vol surface', () => {
  it('recovers the input smile at fitted points and interpolates between them', () => {
    const surf = volatilitySurface({ quotes: chain(), market: { riskFreeRate: rate, asOf, spot } });
    expect(surf.expiries()).toEqual([E0, E1]);
    expect(surf.impliedVolatility(100, E0)).toBeCloseTo(smileImpliedVolatility(100), 6);
    expect(surf.impliedVolatility(85, E0)).toBeCloseTo(smileImpliedVolatility(85), 6);
    // Interpolated mid-strike is between neighbors (monotone PCHIP, no overshoot).
    const v = surf.impliedVolatility(92.5, E0);
    expect(v).toBeGreaterThan(smileImpliedVolatility(95));
    expect(v).toBeLessThan(smileImpliedVolatility(90));
  });

  it('interpolates across expiries in total variance and flags extrapolation', () => {
    const surf = volatilitySurface({ quotes: chain(), market: { riskFreeRate: rate, asOf, spot } });
    const mid = surf.lookup(100, '2026-05-17'); // between E0 and E1
    expect(mid.value).toBeGreaterThan(0.15);
    expect(mid.extrapolated).toBe(false);
    const beyond = surf.lookup(100, '2027-01-01'); // past the last expiry
    expect(beyond.extrapolated).toBe(true);
    expect(
      beyond.diagnostics.warnings.some((w) => w.code === 'volatility.surface_extrapolated'),
    ).toBe(true);
  });

  it('rejects impossible lookup coordinates (no converged:true on NaN/negative queries)', () => {
    const surf = volatilitySurface({ quotes: chain(), market: { riskFreeRate: rate, asOf, spot } });
    expect(() => surf.lookup(NaN, E0)).toThrow();
    expect(() => surf.lookup(-10, E0)).toThrow();
    expect(() => surf.lookup(100, -1)).toThrow();
    expect(() => surf.impliedVolatility(100, NaN)).toThrow();
  });

  it('solves IV from mid prices when the quote has no impliedVolatility', () => {
    const rows: OptionQuote[] = [];
    // Build the round-trip price at the *same* time-to-expiry the surface derives from E0 (16:00 ET),
    // so the price→IV inversion recovers smileImpliedVolatility exactly rather than off by a fraction of a day.
    const tE0 = yearFraction(asOf, optionExpiryToMs(E0), 'ACT/365F');
    for (let k = 90; k <= 110; k += 5) {
      const impliedVolatility = smileImpliedVolatility(k);
      const callMid = blackScholesPrice({
        type: 'call',
        spot,
        strike: k,
        timeToExpiryYears: tE0,
        riskFreeRate: rate,
        dividendYield: 0,
        volatility: impliedVolatility,
      });
      rows.push({
        contract: {
          underlying: 'X',
          type: 'call',
          style: 'european',
          strike: k,
          expiry: E0,
          ...resolvedExpiry(E0),
        },
        timestampMs: asOf,
        mid: callMid,
        underlyingPrice: spot,
      });
    }
    const surf = volatilitySurface({ quotes: rows, market: { riskFreeRate: rate, asOf, spot } });
    expect(surf.impliedVolatility(100, E0)).toBeCloseTo(smileImpliedVolatility(100), 3);
  });
});

describe('skew', () => {
  it('reports a put skew: 25d put IV > 25d call IV, RR<0 (callMinusPut), BF>0', () => {
    const r = skew({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { expiry: E0 },
    });
    const m = r.value;
    expect(m.atmImpliedVolatility).toBeCloseTo(0.2, 2);
    expect(m.put25DeltaImpliedVolatility).toBeGreaterThan(m.call25DeltaImpliedVolatility);
    expect(m.put10DeltaImpliedVolatility).toBeGreaterThan(m.put25DeltaImpliedVolatility); // wing steepens
    expect(m.riskReversal25Delta).toBeLessThan(0); // call minus put, put skew
    expect(m.butterfly25Delta).toBeGreaterThan(0); // convex smile
    expect(m.skewSlope).toBeLessThan(0); // IV falls as strike rises
    expect(m.smileCurvature).toBeGreaterThan(0);
  });

  it('flips the risk-reversal sign under putMinusCall', () => {
    const a = skew({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { expiry: E0, riskReversalConvention: 'callMinusPut' },
    });
    const b = skew({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { expiry: E0, riskReversalConvention: 'putMinusCall' },
    });
    expect(b.value.riskReversal25Delta).toBeCloseTo(-a.value.riskReversal25Delta, 12);
  });

  // Review finding: a forgotten third argument died on a raw `.riskReversalConvention` TypeError.
  it('rejects a missing config argument with a teaching error, not a raw TypeError', () => {
    expect(() =>
      skew({
        quotes: chain(),
        market: { riskFreeRate: rate, asOf, spot },
        config: undefined as never,
      }),
    ).toThrow(InputError);
    expect(() =>
      skew({
        quotes: chain(),
        market: { riskFreeRate: rate, asOf, spot },
        config: undefined as never,
      }),
    ).toThrow(/config/);
  });
});

describe('IV rank / percentile', () => {
  const history = [0.15, 0.18, 0.2, 0.22, 0.25, 0.3];
  it('ranks within the trailing min/max range', () => {
    expect(impliedVolatilityRank.explain({ current: 0.225, history }).value).toBeCloseTo(
      ((0.225 - 0.15) / (0.3 - 0.15)) * 100,
      9,
    );
    expect(impliedVolatilityRank.explain({ current: 0.3, history }).value).toBe(100);
    expect(impliedVolatilityRank.explain({ current: 0.15, history }).value).toBe(0);
    // the empirical metric echoes its sample window and method
    expect(impliedVolatilityRank.explain({ current: 0.225, history }).assumptions.window).toBe(
      history.length,
    );
    expect(impliedVolatilityRank.explain({ current: 0.225, history }).assumptions.method).toBe(
      'rank',
    );
  });
  it('percentile counts observations below current', () => {
    expect(impliedVolatilityPercentile.explain({ current: 0.22, history }).value).toBeCloseTo(
      (3 / 6) * 100,
      9,
    );
  });
  it('throws on empty history; NULL rank + caveat when flat (Law 7: JSON-safe, never NaN)', () => {
    expect(() => impliedVolatilityRank({ current: 0.2, history: [] })).toThrow();
    const flat = impliedVolatilityRank.explain({ current: 0.2, history: [0.2, 0.2, 0.2] });
    expect(flat.value).toBeNull();
    // null only alongside an explicit warning naming the reason (design law #4 + Law 7)
    expect(
      flat.diagnostics.warnings.some((w) => w.code === 'implied_volatility.flat_history'),
    ).toBe(true);
    // and the envelope survives JSON round-tripping without silent corruption
    expect(JSON.parse(JSON.stringify(flat)).value).toBeNull();
  });
  it('rejects NaN current or NaN in history rather than silently returning NaN (PR review)', () => {
    expect(() => impliedVolatilityRank({ current: Number.NaN, history })).toThrow(/current|finite/);
    expect(() => impliedVolatilityRank({ current: 0.2, history: [0.15, Number.NaN, 0.3] })).toThrow(
      /finite/,
    );
    expect(() =>
      impliedVolatilityPercentile({ current: 0.2, history: [0.15, Number.POSITIVE_INFINITY] }),
    ).toThrow(/finite/);
  });
  it('impliedVolatilityRank/impliedVolatilityPercentile/impliedVolatilityStatistics share one guard set: impliedVolatilityStatistics rejects the same bad inputs', () => {
    expect(() => impliedVolatilityStatistics({ current: Number.NaN, history })).toThrow(/current/);
    expect(() =>
      impliedVolatilityStatistics({ current: 0.2, history: [0.15, Number.NaN, 0.3] }),
    ).toThrow(/finite/);
    expect(() => impliedVolatilityStatistics({ current: 0.2, history: [] })).toThrow(/non-empty/);
    expect(() =>
      impliedVolatilityStatistics({ current: 0.2, history: undefined as never }),
    ).toThrow(/history must be an array/);
  });
  it('impliedVolatilityStatistics bundles rank/percentile with the sample window echoed', () => {
    const s = impliedVolatilityStatistics.explain({ current: 0.225, history });
    expect(s.value.rank).toBeCloseTo(
      impliedVolatilityRank.explain({ current: 0.225, history }).value!,
      12,
    );
    expect(s.value.percentile).toBeCloseTo(
      impliedVolatilityPercentile.explain({ current: 0.225, history }).value,
      12,
    );
    expect(s.value.observations).toBe(history.length);
    expect(s.assumptions.window).toBe(history.length);
    expect(s.assumptions.method).toBe('stats');
  });
});

describe('event volatility', () => {
  it('expected move from IV and from straddle agree on the expected absolute move', () => {
    const t = 0.25;
    const impliedVolatility = 0.2;
    const em = expectedMoveFromImpliedVolatility.explain({
      spot,
      impliedVolatility: impliedVolatility,
      timeToExpiryYears: t,
    });
    expect(em.value.oneSigma).toBeCloseTo(spot * impliedVolatility * Math.sqrt(t), 9);
    // the estimate carries its risk-neutral, lognormal-1σ caveat
    expect(em.diagnostics.warnings.some((w) => w.code === 'estimate.risk_neutral')).toBe(true);
    expect(em.assumptions.measure).toBe('risk-neutral');
    // ATM straddle ≈ expected absolute move; round-tripping recovers the same 1-σ.
    const straddle = em.value.expectedAbsolute;
    const em2 = expectedMoveFromStraddle.explain({ spot, straddlePrice: straddle });
    expect(em2.value.oneSigma).toBeCloseTo(em.value.oneSigma, 9);
  });

  it('probability ITM: ATM call ≈ 0.5 (slightly below for positive carry drift on log)', () => {
    const p = probabilityInTheMoney({
      type: 'call',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.03,
      volatility: 0.2,
    });
    expect(p).toBeGreaterThan(0.45);
    expect(p).toBeLessThan(0.6);
    // Call ITM + put ITM at the same strike sum to 1.
    const pp = probabilityInTheMoney({
      type: 'put',
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.03,
      volatility: 0.2,
    });
    expect(p + pp).toBeCloseTo(1, 12);
    // the risk-neutral caveat is present
    expect(
      probabilityInTheMoney.explain({
        type: 'call',
        spot: 100,
        strike: 100,
        timeToExpiryYears: 1,
        riskFreeRate: 0.03,
        volatility: 0.2,
      }).diagnostics.warnings[0]?.code,
    ).toBe('estimate.risk_neutral');
  });

  // Review finding: `type` was never validated, so `type: 'Call'` fell through the ternary to the
  // PUT branch and silently returned the COMPLEMENT of the right probability.
  it('probabilityInTheMoney rejects a mis-cased/unknown type instead of returning the complement', () => {
    const base = {
      spot: 100,
      strike: 90,
      timeToExpiryYears: 1,
      riskFreeRate: 0.03,
      volatility: 0.2,
    };
    expect(() => probabilityInTheMoney({ ...base, type: 'Call' as never })).toThrow(InputError);
    expect(() => probabilityInTheMoney({ ...base, type: 'Call' as never })).toThrow(
      /type must be one of call, put/,
    );
    expect(() => probabilityInTheMoney({ ...base, type: undefined as never })).toThrow(InputError);
    // and the two valid enum values remain complementary at the same strike
    const pCall = probabilityInTheMoney({ ...base, type: 'call' });
    const pPut = probabilityInTheMoney({ ...base, type: 'put' });
    expect(pCall + pPut).toBeCloseTo(1, 12);
  });

  it('probability of touch matches a Monte Carlo first-passage simulation', () => {
    const S = 100;
    const H = 110;
    const t = 0.5;
    const r = 0.03;
    const vol = 0.25;
    const analytic = probabilityOfTouch({
      spot: S,
      barrier: H,
      timeToExpiryYears: t,
      riskFreeRate: r,
      volatility: vol,
    });

    const steps = 250;
    const timeStepYears = t / steps;
    const drift = (r - 0.5 * vol * vol) * timeStepYears;
    const difference = vol * Math.sqrt(timeStepYears);
    const randomNumberGenerator = mulberry32(7);
    let touched = 0;
    const paths = 40000;
    for (let p = 0; p < paths; p++) {
      let x = S;
      for (let s = 0; s < steps; s++) {
        x *= Math.exp(drift + difference * normalSample(randomNumberGenerator));
        if (x >= H) {
          touched++;
          break;
        }
      }
    }
    const monteCarlo = touched / paths;
    expect(analytic).toBeCloseTo(monteCarlo, 1); // within ~0.05
    expect(analytic).toBeGreaterThan(0);
    expect(analytic).toBeLessThan(1);
  });
});
