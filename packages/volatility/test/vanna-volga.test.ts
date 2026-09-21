/**
 * Vanna–volga smile construction (`calibrateVannaVolga`). The defining property: the constructed smile reprices the
 * three market pillars (from `smileFromQuotes`) exactly. Also pinned: the full quote → smile → quote loop
 * closes through `riskReversalButterfly`, the interpolation is smooth, flat quotes give a flat smile, a
 * far-out-of-range strike where VV breaks down is a typed error (not a NaN / degenerate vol), and guards.
 */

import { describe, expect, it } from 'vitest';
import {
  calibrateVannaVolga,
  calibrateVannaVolga5,
  riskReversalButterfly,
} from '@totalfinance/volatility';
import {
  vannaVolgaApproximation,
  vannaVolgaDensity,
  vannaVolga5Density,
} from '@totalfinance/volatility/vanna-volga';

const BASE = {
  forward: 100,
  timeToExpiryYears: 0.5,
  atmVolatility: 0.2,
  riskReversal: -0.02,
  butterfly: 0.005,
} as const;

describe('calibrateVannaVolga', () => {
  it('reprices the three market pillars exactly', () => {
    const built = calibrateVannaVolga({ ...BASE, strikes: [95, 100, 105] });
    const { putStrike, putVolatility, atmStrike, atmVolatility, callStrike, callVolatility } =
      built.pillars;
    // ATM vol / RR / BF ⇒ pillars: put vol = ATM + BF + RR/2? no — put = ATM + BF − RR/2, call = ATM + BF + RR/2.
    expect(putVolatility).toBeCloseTo(
      BASE.atmVolatility + BASE.butterfly - BASE.riskReversal / 2,
      12,
    );
    expect(callVolatility).toBeCloseTo(
      BASE.atmVolatility + BASE.butterfly + BASE.riskReversal / 2,
      12,
    );
    expect(atmVolatility).toBe(BASE.atmVolatility);
    // Querying the pillar strikes returns the pillar volatilities to machine precision.
    const atPillars = calibrateVannaVolga({ ...BASE, strikes: [putStrike, atmStrike, callStrike] });
    expect(atPillars.volatilities[0]).toBeCloseTo(putVolatility, 6);
    expect(atPillars.volatilities[1]).toBeCloseTo(atmVolatility, 6);
    expect(atPillars.volatilities[2]).toBeCloseTo(callVolatility, 6);
  });

  it('closes the quote → smile → quote loop through riskReversalButterfly', () => {
    // Adapt the batch VV into a single-strike smile: RR/BF's root-find probes ±8σ (well past where VV is
    // valid). Out there VV throws; fall back to a flat ATM vol so brent's bracket endpoints stay valid.
    // The real 25-delta wing roots (~91, ~110) sit inside VV's valid range and use the true VV vol, so the
    // recovered quotes still come from the exact-repriced pillars.
    const smile = (K: number): number => {
      try {
        return calibrateVannaVolga({ ...BASE, strikes: [K] }).volatilities[0]!;
      } catch {
        return BASE.atmVolatility;
      }
    };
    const rb = riskReversalButterfly({
      forward: BASE.forward,
      timeToExpiryYears: BASE.timeToExpiryYears,
      smile,
    });
    expect(rb.atmVolatility).toBeCloseTo(BASE.atmVolatility, 4);
    expect(rb.riskReversal).toBeCloseTo(BASE.riskReversal, 4);
    expect(rb.butterfly).toBeCloseTo(BASE.butterfly, 4);
  });

  it('interpolates a smooth, down-skewed smile between the pillars', () => {
    const r = calibrateVannaVolga({ ...BASE, strikes: [85, 90, 95, 100, 105, 110, 115] });
    expect(r.volatilities).toHaveLength(7);
    expect(r.volatilities.every((v) => v > 0 && Number.isFinite(v))).toBe(true);
    // down-skew: the low-strike volatilities exceed the high-strike volatilities through the ATM.
    expect(r.volatilities[0]).toBeGreaterThan(r.volatilities[3]!); // K=85 > K=100
    expect(r.volatilities[3]).toBeGreaterThan(r.volatilities[5]!); // K=100 > K=110
  });

  it('gives a flat smile when RR = BF = 0', () => {
    const r = calibrateVannaVolga({
      ...BASE,
      riskReversal: 0,
      butterfly: 0,
      strikes: [90, 100, 110],
    });
    for (const v of r.volatilities) expect(v).toBeCloseTo(0.2, 6);
    expect(r.pillars.putVolatility).toBeCloseTo(0.2, 12);
    expect(r.pillars.callVolatility).toBeCloseTo(0.2, 12);
  });

  it('errors (typed) at a strike where the vanna–volga construction breaks down', () => {
    // Strikes far beyond the pillars drive the VV price outside the no-arbitrage bounds (or collapse
    // it to a degenerate ≈ 0 vol), which is a typed refusal rather than a fabricated wing vol.
    expect(() => calibrateVannaVolga({ ...BASE, strikes: [100, 20] })).toThrowError();
    expect(() => calibrateVannaVolga({ ...BASE, strikes: [100, 1e6] })).toThrowError();
  });

  it('guards a bad input, empty strikes, non-positive scalars, a bad delta, and a negative strike', () => {
    expect(() => calibrateVannaVolga(undefined as never)).toThrowError();
    expect(() => calibrateVannaVolga({ ...BASE, strikes: [] })).toThrowError();
    expect(() => calibrateVannaVolga({ ...BASE, strikes: undefined as never })).toThrowError();
    expect(() => calibrateVannaVolga({ ...BASE, forward: -1, strikes: [100] })).toThrowError();
    expect(() =>
      calibrateVannaVolga({ ...BASE, timeToExpiryYears: 0, strikes: [100] }),
    ).toThrowError();
    expect(() => calibrateVannaVolga({ ...BASE, atmVolatility: 0, strikes: [100] })).toThrowError();
    expect(() => calibrateVannaVolga({ ...BASE, delta: 0.6, strikes: [100] })).toThrowError();
    expect(() => calibrateVannaVolga({ ...BASE, strikes: [100, -5] })).toThrowError();
  });
});

describe('vannaVolgaApproximation (Castagna–Mercurio)', () => {
  it('reprices the three pillars exactly, at both orders', () => {
    const built = calibrateVannaVolga({ ...BASE, strikes: [100] });
    const { putStrike, putVolatility, atmStrike, atmVolatility, callStrike, callVolatility } =
      built.pillars;
    for (const order of [1, 2] as const) {
      const r = vannaVolgaApproximation({
        ...BASE,
        order,
        strikes: [putStrike, atmStrike, callStrike],
      });
      expect(r.order).toBe(order);
      expect(r.volatilities[0]).toBeCloseTo(putVolatility, 8);
      expect(r.volatilities[1]).toBeCloseTo(atmVolatility, 8);
      expect(r.volatilities[2]).toBeCloseTo(callVolatility, 8);
    }
  });

  it('the 2nd order matches the exact vanna-volga smile to a few bp in the core', () => {
    const strikes = [94, 97, 100, 103, 106];
    const exact = calibrateVannaVolga({ ...BASE, strikes });
    const approx = vannaVolgaApproximation({ ...BASE, strikes }); // default order 2
    expect(approx.assumptions.method).toBe('castagna-mercurio');
    expect(approx.order).toBe(2); // default
    strikes.forEach((_, i) => {
      expect(approx.volatilities[i]).toBeCloseTo(exact.volatilities[i]!, 3); // < 5e-4 = 5 bp
    });
  });

  it('the 1st order is the log-strike interpolation — pillar-exact but rougher off-pillar than 2nd', () => {
    const strikes = [90, 95, 100, 105, 110];
    const exact = calibrateVannaVolga({ ...BASE, strikes });
    const o1 = vannaVolgaApproximation({ ...BASE, order: 1, strikes });
    const o2 = vannaVolgaApproximation({ ...BASE, order: 2, strikes });
    // The 2nd order is at least as close to the exact smile as the 1st, aggregated over the strikes.
    const err = (a: number[]): number =>
      a.reduce((s, v, i) => s + Math.abs(v - exact.volatilities[i]!), 0);
    expect(err(o2.volatilities)).toBeLessThan(err(o1.volatilities));
  });

  it('handles the d₁·d₂ → 0 strike (K = F·e^{½σ²T}) via the analytic limit', () => {
    // At this strike the 2nd-order denominator vanishes; the limit branch must return a finite vol
    // consistent with the exact smile.
    const kLimit =
      BASE.forward *
      Math.exp(0.5 * BASE.atmVolatility * BASE.atmVolatility * BASE.timeToExpiryYears);
    const approx = vannaVolgaApproximation({ ...BASE, strikes: [kLimit] });
    const exact = calibrateVannaVolga({ ...BASE, strikes: [kLimit] });
    expect(Number.isFinite(approx.volatilities[0]!)).toBe(true);
    expect(approx.volatilities[0]).toBeCloseTo(exact.volatilities[0]!, 3);
  });

  it('gives a flat smile when RR = BF = 0', () => {
    const r = vannaVolgaApproximation({
      ...BASE,
      riskReversal: 0,
      butterfly: 0,
      strikes: [90, 100, 110],
    });
    for (const v of r.volatilities) expect(v).toBeCloseTo(0.2, 8);
  });

  it('extrapolates where the exact vanna-volga refuses — the closed form is always defined', () => {
    // The exact calibrateVannaVolga throws at K = 20 (its VV price leaves the no-arb bounds; see the
    // sibling test above). The closed form has no Black inversion, so it extrapolates to a finite vol
    // there — the deliberate contrast between the two methods, not a bug.
    expect(() => calibrateVannaVolga({ ...BASE, strikes: [100, 20] })).toThrowError();
    const approx = vannaVolgaApproximation({ ...BASE, strikes: [100, 20] });
    expect(approx.volatilities.every((v) => v > 0 && Number.isFinite(v))).toBe(true);
    expect(approx.volatilities[1]).toBeGreaterThan(approx.pillars.atmVolatility); // far-wing vol above ATM
  });

  it('errors (typed) at a genuine breakdown and guards its inputs', () => {
    // The 2nd-order curvature form assumes a convex (butterfly > 0) smile. An inverted butterfly drives
    // the √ argument negative off the pillars — collected into a typed breakdown error, never a NaN vol.
    expect(() =>
      vannaVolgaApproximation({ ...BASE, riskReversal: 0, butterfly: -0.02, strikes: [130] }),
    ).toThrowError();
    expect(() =>
      vannaVolgaApproximation({ ...BASE, order: 3 as never, strikes: [100] }),
    ).toThrowError();
    expect(() => vannaVolgaApproximation(undefined as never)).toThrowError();
    expect(() => vannaVolgaApproximation({ ...BASE, strikes: [] })).toThrowError();
    expect(() =>
      vannaVolgaApproximation({ ...BASE, atmVolatility: 0, strikes: [100] }),
    ).toThrowError();
    expect(() => vannaVolgaApproximation({ ...BASE, delta: 0.6, strikes: [100] })).toThrowError();
  });
});

describe('vannaVolgaDensity (Breeden–Litzenberger on the CM smile)', () => {
  // The density input drops `strikes` (it builds its own grid) — a clean quote-only base.
  const Q = { forward: 100, timeToExpiryYears: 0.5, atmVolatility: 0.2 } as const;

  // Analytic lognormal (forward-measure) density: S_T ~ LN(ln F − ½σ²T, σ²T).
  const lognormalPdf = (K: number, F: number, T: number, s: number): number => {
    const v = s * Math.sqrt(T);
    return (
      Math.exp(-((Math.log(K / F) + 0.5 * v * v) ** 2) / (2 * v * v)) /
      (K * v * Math.sqrt(2 * Math.PI))
    );
  };

  it('reproduces the analytic lognormal density and moments for a flat smile', () => {
    const d = vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0 });
    // Density matches the closed-form lognormal to finite-difference precision.
    for (const K of [80, 90, 100, 110, 120]) {
      const rel =
        Math.abs(d.density(K) - lognormalPdf(K, Q.forward, Q.timeToExpiryYears, Q.atmVolatility)) /
        lognormalPdf(K, Q.forward, Q.timeToExpiryYears, Q.atmVolatility);
      expect(rel).toBeLessThan(1e-3);
    }
    expect(d.moments.totalMass).toBeCloseTo(1, 2); // ∫f ≈ 1
    expect(d.moments.mean).toBeCloseTo(Q.forward, 1); // martingale: mean = forward
    expect(d.moments.variance).toBeCloseTo(
      Q.forward ** 2 * (Math.exp(Q.atmVolatility ** 2 * Q.timeToExpiryYears) - 1),
      1,
    );
    expect(d.diagnostics.warnings).toHaveLength(0);
    expect(d.diagnostics.converged).toBe(true);
    expect(d.assumptions.method).toBe('breeden-litzenberger');
    expect(d.assumptions.smile).toBe('castagna-mercurio');
    expect(d.order).toBe(2); // default
  });

  it('is a martingale (mean = forward) and echoes the pillars for a skewed smile', () => {
    const d = vannaVolgaDensity({ ...Q, riskReversal: -0.04, butterfly: 0.01 });
    expect(d.moments.totalMass).toBeCloseTo(1, 2);
    expect(d.moments.mean).toBeCloseTo(Q.forward, 1);
    // Pillars are the same three the smile is built from.
    const vv = calibrateVannaVolga({ ...Q, riskReversal: -0.04, butterfly: 0.01, strikes: [100] });
    expect(d.pillars.putVolatility).toBeCloseTo(vv.pillars.putVolatility, 10);
    expect(d.pillars.callVolatility).toBeCloseTo(vv.pillars.callVolatility, 10);
    // Grid is the sampled support: default 801 nodes with the ATM forward on the centre node.
    expect(d.grid.strikes).toHaveLength(801);
    expect(d.grid.strikes[400]).toBeCloseTo(Q.forward, 6);
    expect(d.grid.density).toHaveLength(801);
    expect(d.grid.cdf).toHaveLength(801);
  });

  it('implied skewness increases with the risk reversal and kurtosis with the butterfly', () => {
    const skew = (rr: number): number =>
      vannaVolgaDensity({ ...Q, riskReversal: rr, butterfly: 0.01 }).moments.skewness;
    // Monotone in RR (the lognormal baseline is itself right-skewed, so the ordering is the honest check).
    expect(skew(-0.04)).toBeLessThan(skew(0));
    expect(skew(0)).toBeLessThan(skew(0.04));
    // A larger butterfly fattens the tails.
    const kurt = (bf: number): number =>
      vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: bf }).moments.excessKurtosis;
    expect(kurt(0.02)).toBeGreaterThan(kurt(0.005));
  });

  it('gives a consistent CDF, inverse-CDF, and probability set', () => {
    const d = vannaVolgaDensity({ ...Q, riskReversal: -0.02, butterfly: 0.005 });
    // Inverse CDF round-trips through the CDF.
    for (const p of [0.1, 0.5, 0.9]) {
      expect(d.cdf(d.quantile(p))).toBeCloseTo(p, 4);
    }
    // The quantile is monotone increasing in p.
    expect(d.quantile(0.25)).toBeLessThan(d.quantile(0.75));
    // probabilityBetween = cdf(b) − cdf(a); below + above = 1.
    expect(d.probabilityBetween(90, 110)).toBeCloseTo(d.cdf(110) - d.cdf(90), 10);
    expect(d.probabilityBelow(100) + d.probabilityAbove(100)).toBeCloseTo(1, 10);
    // Out-of-range quantile probability is rejected.
    expect(() => d.quantile(0)).toThrowError();
    expect(() => d.quantile(1.5)).toThrowError();
  });

  it('warns (not throws) on grid truncation and residual butterfly arbitrage', () => {
    // A too-narrow grid captures < 100% of the mass → a disclosed mass warning + converged = false.
    const narrow = vannaVolgaDensity({
      ...Q,
      riskReversal: -0.02,
      butterfly: 0.005,
      widthStandardDeviations: 0.5,
    });
    expect(narrow.moments.totalMass).toBeLessThan(0.99);
    expect(narrow.diagnostics.warnings.some((w) => w.message.includes('mass'))).toBe(true);
    expect(narrow.diagnostics.converged).toBe(false);
    // A slightly wider (still narrow) grid additionally drifts the mean off the forward.
    const meanDrift = vannaVolgaDensity({
      ...Q,
      riskReversal: -0.02,
      butterfly: 0.005,
      widthStandardDeviations: 1.5,
    });
    expect(meanDrift.diagnostics.warnings.some((w) => w.message.includes('mean'))).toBe(true);
    // A large butterfly makes the smile arbitrageable → a non-monotone CDF is flagged (density still finite).
    const arb = vannaVolgaDensity({
      ...Q,
      riskReversal: 0,
      butterfly: 0.05,
      widthStandardDeviations: 4,
    });
    expect(arb.diagnostics.warnings.some((w) => w.message.includes('non-monotone'))).toBe(true);
  });

  it('accepts an explicit step and order, and errors on a smile too steep for the grid', () => {
    // Explicit grid controls flow through. order 1 is the rough log-strike interpolation — its unbounded
    // wing volatilities make the density looser than order 2's, so we assert a sensible density, not a tight mean.
    const d = vannaVolgaDensity({
      ...Q,
      riskReversal: -0.02,
      butterfly: 0.005,
      order: 1,
      step: 0.05,
      gridPoints: 401,
    });
    expect(d.order).toBe(1);
    expect(d.grid.strikes).toHaveLength(401);
    expect(d.moments.totalMass).toBeGreaterThan(0.9);
    expect(d.density(Q.forward)).toBeGreaterThan(0);
    expect(Math.abs(d.moments.mean - Q.forward)).toBeLessThan(2);
    // An inverted butterfly (CM undefined across the grid) is a hard typed error.
    expect(() => vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: -0.02 })).toThrowError();
  });

  it('guards its inputs', () => {
    expect(() => vannaVolgaDensity(undefined as never)).toThrowError();
    expect(() =>
      vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0, forward: -1 }),
    ).toThrowError();
    expect(() =>
      vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0, atmVolatility: 0 }),
    ).toThrowError();
    expect(() =>
      vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0, order: 3 as never }),
    ).toThrowError();
    expect(() =>
      vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0, gridPoints: 800 }),
    ).toThrowError(); // even
    expect(() =>
      vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0, gridPoints: 9 }),
    ).toThrowError(); // < 11
    expect(() =>
      vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0, widthStandardDeviations: 0 }),
    ).toThrowError();
    expect(() =>
      vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0, step: -1 }),
    ).toThrowError();
    expect(() =>
      vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0, delta: 0.6 }),
    ).toThrowError();
    for (const field of [
      'delta',
      'order',
      'gridPoints',
      'widthStandardDeviations',
      'step',
    ] as const) {
      expect(() =>
        vannaVolgaDensity({ ...Q, riskReversal: 0, butterfly: 0, [field]: null } as never),
      ).toThrowError();
    }
  });
});

describe('calibrateVannaVolga5 (5-pillar 10Δ smile)', () => {
  // A benign, arbitrage-free five-quote set.
  const Q5 = {
    forward: 100,
    timeToExpiryYears: 0.5,
    atmVolatility: 0.2,
    riskReversal25: -0.02,
    butterfly25: 0.005,
    riskReversal10: -0.03,
    butterfly10: 0.01,
  } as const;

  it('reprices all five market pillars exactly', () => {
    const seed = calibrateVannaVolga5({ ...Q5, strikes: [100] });
    expect(seed.pillars).toHaveLength(5);
    // Pillars are ascending in strike and carry their delta/kind.
    for (let i = 1; i < seed.pillars.length; i++) {
      expect(seed.pillars[i]!.strike).toBeGreaterThan(seed.pillars[i - 1]!.strike);
    }
    expect(seed.pillars.map((p) => p.kind)).toEqual(['put', 'put', 'atm', 'call', 'call']);
    expect(seed.pillars.map((p) => p.delta)).toEqual([0.1, 0.25, 0.5, 0.25, 0.1]);
    // Querying the five pillar strikes returns their quoted volatilities to machine precision.
    const at = calibrateVannaVolga5({ ...Q5, strikes: seed.pillars.map((p) => p.strike) });
    at.pillars.forEach((p, i) => expect(at.volatilities[i]).toBeCloseTo(p.volatility, 10));
    expect(at.assumptions.method).toBe('vanna-volga-5');
    expect(at.assumptions.interpolation).toBe('pchip-total-variance');
    expect(at.diagnostics.warnings).toHaveLength(0);
    expect(at.diagnostics.converged).toBe(true);
  });

  it('agrees with the 3-pillar smile at the shared pillars but pins the 10Δ wings to real quotes', () => {
    const seed = calibrateVannaVolga5({ ...Q5, strikes: [100] });
    const strikes = seed.pillars.map((p) => p.strike);
    const five = calibrateVannaVolga5({ ...Q5, strikes });
    const cm = (K: number): number =>
      vannaVolgaApproximation({
        forward: 100,
        timeToExpiryYears: 0.5,
        atmVolatility: 0.2,
        riskReversal: -0.02,
        butterfly: 0.005,
        strikes: [K],
      }).volatilities[0]!;
    seed.pillars.forEach((p, i) => {
      const diffBp = Math.abs(five.volatilities[i]! - cm(p.strike)) * 1e4;
      if (p.delta === 0.25 || p.kind === 'atm') {
        expect(diffBp).toBeLessThan(1); // both reprice the ATM / 25Δ pillars ⇒ ~0 bp
      } else {
        expect(diffBp).toBeGreaterThan(10); // the 10Δ wings use the real quote, not an extrapolation
      }
    });
  });

  it('flat vs linear wing extrapolation beyond the 10Δ pillars', () => {
    // A non-flat call wing (10Δc vol ≠ 25Δc vol) so the endpoint slope is non-zero and linear ≠ flat.
    const q = { ...Q5, riskReversal10: -0.035, butterfly10: 0.015 };
    const flat = calibrateVannaVolga5({ ...q, wingExtrapolation: 'flat', strikes: [150] });
    const linear = calibrateVannaVolga5({ ...q, wingExtrapolation: 'linear', strikes: [150] });
    expect(flat.assumptions.wingExtrapolation).toBe('flat');
    expect(linear.assumptions.wingExtrapolation).toBe('linear');
    expect(flat.volatilities[0]).toBeGreaterThan(0);
    expect(linear.volatilities[0]).toBeGreaterThan(0);
    // Flat holds the 10Δ-call vol; linear continues its slope — the two differ far out of range.
    expect(flat.volatilities[0]).not.toBeCloseTo(linear.volatilities[0]!, 4);
  });

  it('flags an over-convex butterfly as an arbitrage but stays quiet on a benign smile', () => {
    // A huge butterfly makes the call-price curve locally concave between the pillars ⇒ negative density.
    const arb = calibrateVannaVolga5({
      ...Q5,
      riskReversal25: 0,
      butterfly25: 0.04,
      riskReversal10: 0,
      butterfly10: 0.08,
      strikes: [100],
    });
    expect(arb.diagnostics.warnings.some((w) => w.message.includes('butterfly arbitrage'))).toBe(
      true,
    );
    expect(arb.diagnostics.converged).toBe(false);
    // A steep (but not over-convex) 10Δ wing is arbitrage-free — the boundary kink is excluded from the scan.
    const steepWing = calibrateVannaVolga5({
      ...Q5,
      riskReversal10: -0.045,
      butterfly10: 0.02,
      strikes: [100],
    });
    expect(steepWing.diagnostics.warnings).toHaveLength(0);
  });

  it('errors on a linear wing driven to non-positive variance and on non-monotone pillar strikes', () => {
    // Far out on a down-sloping linear wing, total variance crosses zero — a typed error, not an NaN vol.
    expect(() =>
      calibrateVannaVolga5({
        forward: 100,
        timeToExpiryYears: 0.5,
        atmVolatility: 0.2,
        riskReversal25: -0.02,
        butterfly25: 0.01,
        riskReversal10: -0.06,
        butterfly10: 0.01,
        wingExtrapolation: 'linear',
        strikes: [100, 100000],
      }),
    ).toThrowError();
    // An enormous butterfly pushes the 10Δ strikes past the 25Δ strikes — the pillars cross, a typed error.
    expect(() =>
      calibrateVannaVolga5({
        forward: 100,
        timeToExpiryYears: 0.5,
        atmVolatility: 0.2,
        riskReversal25: 0,
        butterfly25: 0.005,
        riskReversal10: 0,
        butterfly10: 4,
        strikes: [100],
      }),
    ).toThrowError();
  });

  it('guards its inputs', () => {
    expect(() => calibrateVannaVolga5(undefined as never)).toThrowError();
    expect(() => calibrateVannaVolga5({ ...Q5, forward: -1, strikes: [100] })).toThrowError();
    expect(() => calibrateVannaVolga5({ ...Q5, atmVolatility: 0, strikes: [100] })).toThrowError();
    expect(() =>
      calibrateVannaVolga5({ ...Q5, riskReversal10: NaN, strikes: [100] }),
    ).toThrowError();
    expect(() => calibrateVannaVolga5({ ...Q5, strikes: [] })).toThrowError();
    expect(() => calibrateVannaVolga5({ ...Q5, strikes: [100, -5] })).toThrowError();
    // Delta ordering: 0 < outer < inner < 0.5.
    expect(() => calibrateVannaVolga5({ ...Q5, outerDelta: -0.1, strikes: [100] })).toThrowError();
    expect(() =>
      calibrateVannaVolga5({ ...Q5, outerDelta: 0.4, innerDelta: 0.3, strikes: [100] }),
    ).toThrowError();
    expect(() => calibrateVannaVolga5({ ...Q5, innerDelta: 0.7, strikes: [100] })).toThrowError();
    expect(() =>
      calibrateVannaVolga5({ ...Q5, wingExtrapolation: 'quadratic' as never, strikes: [100] }),
    ).toThrowError();
  });
});

describe('vannaVolga5Density (density from the 5-pillar smile)', () => {
  const Q5 = {
    forward: 100,
    timeToExpiryYears: 0.5,
    atmVolatility: 0.2,
    riskReversal25: -0.02,
    butterfly25: 0.005,
    riskReversal10: -0.035,
    butterfly10: 0.015,
  } as const;

  it('is a martingale (mean = forward), integrates to 1, and reprices the five pillars', () => {
    const d = vannaVolga5Density({ ...Q5 });
    expect(d.moments.totalMass).toBeCloseTo(1, 2);
    expect(d.moments.mean).toBeCloseTo(Q5.forward, 1); // martingale
    expect(d.pillars).toHaveLength(5);
    expect(d.assumptions.smile).toBe('vanna-volga-5');
    expect(d.diagnostics.warnings).toHaveLength(0);
    expect(d.diagnostics.converged).toBe(true);
    // The density's underlying (linear-wing) smile reprices the five quoted pillars exactly.
    const smile = calibrateVannaVolga5({
      ...Q5,
      wingExtrapolation: 'linear',
      strikes: d.pillars.map((p) => p.strike),
    });
    d.pillars.forEach((p, i) => expect(smile.volatilities[i]).toBeCloseTo(p.volatility, 10));
  });

  it('gives a sharper core than the 3-pillar density where the 10Δ quotes bite', () => {
    const d5 = vannaVolga5Density({ ...Q5 });
    const d3 = vannaVolgaDensity({
      forward: 100,
      timeToExpiryYears: 0.5,
      atmVolatility: 0.2,
      riskReversal: -0.02,
      butterfly: 0.005,
    });
    // Inside the quoted [10Δp, 10Δc] range the two CDFs differ (the 5-pillar uses the real 10Δ quotes).
    const maxDiffBp = [95, 100, 105].reduce(
      (m, K) => Math.max(m, Math.abs(d5.cdf(K) - d3.cdf(K)) * 1e4),
      0,
    );
    expect(maxDiffBp).toBeGreaterThan(10);
    // Both remain valid distributions (mean = forward).
    expect(d5.moments.mean).toBeCloseTo(100, 1);
    expect(d3.moments.mean).toBeCloseTo(100, 1);
  });

  it('has a consistent CDF / inverse-CDF / probability set', () => {
    const d = vannaVolga5Density({ ...Q5 });
    for (const p of [0.1, 0.5, 0.9]) expect(d.cdf(d.quantile(p))).toBeCloseTo(p, 4);
    expect(d.probabilityBetween(90, 110)).toBeCloseTo(d.cdf(110) - d.cdf(90), 10);
    expect(d.probabilityBelow(100) + d.probabilityAbove(100)).toBeCloseTo(1, 10);
    expect(d.density(100)).toBeGreaterThan(0);
  });

  it('flags an over-convex butterfly and errors on a wing too steep for the grid', () => {
    // A huge butterfly makes the interior density go negative ⇒ a non-monotone CDF is flagged.
    const arb = vannaVolga5Density({
      ...Q5,
      riskReversal25: 0,
      butterfly25: 0.04,
      riskReversal10: 0,
      butterfly10: 0.08,
    });
    expect(arb.diagnostics.warnings.some((w) => w.message.includes('non-monotone'))).toBe(true);
    // A down-sloping call wing extrapolated linearly to ±6σ drives total variance ≤ 0 — a typed error.
    expect(() =>
      vannaVolga5Density({
        ...Q5,
        riskReversal25: -0.02,
        butterfly25: 0.01,
        riskReversal10: -0.06,
        butterfly10: 0.005,
      }),
    ).toThrowError();
  });

  it('guards its inputs', () => {
    expect(() => vannaVolga5Density(undefined as never)).toThrowError();
    expect(() => vannaVolga5Density({ ...Q5, forward: -1 })).toThrowError();
    expect(() => vannaVolga5Density({ ...Q5, atmVolatility: 0 })).toThrowError();
    expect(() => vannaVolga5Density({ ...Q5, gridPoints: 800 })).toThrowError(); // even
    expect(() => vannaVolga5Density({ ...Q5, widthStandardDeviations: 0 })).toThrowError();
    expect(() => vannaVolga5Density({ ...Q5, outerDelta: 0.4, innerDelta: 0.3 })).toThrowError();
  });
});
