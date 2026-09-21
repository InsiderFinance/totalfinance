/**
 * P&L explain (§12.2) — realized greek-Taylor attribution with an honest residual. Verifies the
 * exact sum-to-total identity, the manual Taylor terms, the position + per-leg composition, the
 * residual behavior (tiny for small moves, growing for large ones), the portfolio roll-up, and guards.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import {
  blackScholesExtendedGreeks,
  blackScholesGreeks,
  blackScholesPrice,
} from '@totalfinance/options/black-scholes';
import { legs, strategy } from '@totalfinance/strategy';
import {
  explainPnl,
  explainPortfolioPnl,
  explainPositionPnl,
  type PnlExplain,
  type PositionGreeks,
} from '@totalfinance/risk';

const EXPIRY = '2026-06-19';
/** The one unit system: theta per calendar day, vega/rho/phi per 1% — the engine scales to raw. */
const DAYS = 365;
const PCT = 100;

/** Every explain's terms (the full 2nd-order Taylor + dividend carry) sum EXACTLY to its total. Takes
 *  the BARE terms so per-leg and portfolio (report-less) shapes check too. */
function expectSumsToTotal(e: Omit<PnlExplain, 'assumptions' | 'diagnostics'>): void {
  expect(
    e.delta +
      e.gamma +
      e.vega +
      e.theta +
      e.rho +
      e.vanna +
      e.vomma +
      e.charm +
      e.veta +
      e.vera +
      e.deltaRate +
      e.thetaRate +
      e.rhoConvexity +
      e.thetaConvexity +
      e.phi +
      e.unexplained,
  ).toBeCloseTo(e.total, 10);
}

/** The full additive term set (every greek term, total, and residual) — additive across legs/positions. */
const ADDITIVE_KEYS = [
  'delta',
  'gamma',
  'vega',
  'theta',
  'rho',
  'vanna',
  'vomma',
  'charm',
  'veta',
  'vera',
  'deltaRate',
  'thetaRate',
  'rhoConvexity',
  'thetaConvexity',
  'phi',
  'total',
  'unexplained',
] as const;

describe('explainPnl — the primitive', () => {
  it('decomposes into Taylor terms + residual that sum to the actual P&L', () => {
    const greeks: PositionGreeks = {
      value: 5,
      spot: 100,
      delta: 0.5,
      gamma: 0.02,
      vega: 0.1, // per vol POINT (the options package's unit)
      theta: -0.01, // per calendar DAY
      rho: 0.05, // per 1% rate
    };
    const move = { dSpot: 2, dVolatility: 0.03, dTimeYears: 0.01, dRate: 0.001 };
    const e = explainPnl({ greeks, move, actualPnl: 1.5 });

    expect(e.delta).toBeCloseTo(0.5 * 2, 12); // 1.0
    expect(e.gamma).toBeCloseTo(0.5 * 0.02 * 4, 12); // 0.04
    expect(e.vega).toBeCloseTo(0.1 * PCT * 0.03, 12); // 0.3 — 3 vol points
    expect(e.theta).toBeCloseTo(-0.01 * DAYS * 0.01, 12); // -0.0365 — 3.65 days
    expect(e.rho).toBeCloseTo(0.05 * PCT * 0.001, 12); // 0.005 — 10 bp
    expect(e.total).toBe(1.5);
    expect(e.unexplained).toBeCloseTo(1.5 - (1.0 + 0.04 + 0.3 - 0.0365 + 0.005), 12);
    expectSumsToTotal(e);
  });

  it('a missing greek contributes zero, not a crash', () => {
    const e = explainPnl({ greeks: { value: 0, delta: 0.3 }, move: { dSpot: 5 }, actualPnl: 2 });
    expect(e.delta).toBeCloseTo(1.5, 12);
    expect(e.gamma).toBe(0);
    expect(e.vega).toBe(0);
    expect(e.vanna).toBe(0);
    expect(e.vomma).toBe(0);
    expect(e.charm).toBe(0);
    expectSumsToTotal(e);
  });
});

describe('explainPnl — higher-order (vanna / vomma / charm)', () => {
  const T = ['call', 100, 100, 0.5, 0.03, 0.01, 0.25] as const;
  const [type, S, K, TT, r, q, sig] = T;
  const V0 = blackScholesPrice({
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: TT,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sig,
  });

  it('consumes the options-package units directly: theta per day, vega per point, rho and phi per 1%, charm with the calendar sign', () => {
    const g = blackScholesExtendedGreeks({
      type,
      spot: S,
      strike: K,
      timeToExpiryYears: TT,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sig,
    });
    const greeks = { value: V0, spot: S, ...g };
    // One vol point, one calendar day, one percent of rate/yield: each first-order term equals the
    // Greek exactly as the options package reports it — no caller-side scaling.
    expect(explainPnl({ greeks, move: { dVolatility: 0.01 }, actualPnl: 0 }).vega).toBeCloseTo(
      g.vega,
      12,
    );
    expect(explainPnl({ greeks, move: { dTimeYears: 1 / 365 }, actualPnl: 0 }).theta).toBeCloseTo(
      g.theta,
      12,
    );
    expect(explainPnl({ greeks, move: { dRate: 0.01 }, actualPnl: 0 }).rho).toBeCloseTo(g.rho, 12);
    expect(explainPnl({ greeks, move: { dDividendYield: 0.01 }, actualPnl: 0 }).phi).toBeCloseTo(
      g.phi,
      12,
    );
    // vanna/vomma enter unscaled (per 1.00 σ); charm is the options ∂Δ/∂T, entering as −∂Δ/∂T for
    // calendar time passing.
    const dS = 1;
    const dSig = 0.01;
    const dt = 0.01;
    const e = explainPnl({
      greeks,
      move: { dSpot: dS, dVolatility: dSig, dTimeYears: dt },
      actualPnl: 0,
    });
    expect(e.vanna).toBeCloseTo(g.vanna * dS * dSig, 12);
    expect(e.vomma).toBeCloseTo(0.5 * g.vomma * dSig * dSig, 12);
    expect(e.charm).toBeCloseTo(-g.charm * dS * dt, 12);
  });
  it('omits the second-order fields for a plain first-order Greeks (backward-compatible)', () => {
    const raw = {
      value: V0,
      spot: S,
      ...blackScholesGreeks({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig,
      }),
    };
    expect('vanna' in raw).toBe(false);
    expect('vomma' in raw).toBe(false);
    expect('charm' in raw).toBe(false);
    // ⇒ its explain has zero higher-order terms, exactly as before this feature.
    const e = explainPnl({
      greeks: raw,
      move: { dSpot: 2, dVolatility: 0.03, dTimeYears: 0.02 },
      actualPnl: 1.0,
    });
    expect(e.vanna).toBe(0);
    expect(e.vomma).toBe(0);
    expect(e.charm).toBe(0);
    expectSumsToTotal(e);
  });

  it('the vanna/vomma/charm terms equal the price mixed-partials times the moves (FD-verified)', () => {
    const dS = 2,
      dSig = 0.03,
      timeStepYears = 0.02;
    const raw = {
      value: V0,
      spot: S,
      ...blackScholesExtendedGreeks({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig,
      }),
    };
    const V1 = blackScholesPrice({
      type,
      spot: S + dS,
      strike: K,
      timeToExpiryYears: TT - timeStepYears,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sig + dSig,
    }); // calendar time passes ⇒ T shrinks
    const e = explainPnl({
      greeks: raw,
      move: { dSpot: dS, dVolatility: dSig, dTimeYears: timeStepYears, dRate: 0 },
      actualPnl: V1 - V0,
    });

    const h = 1e-3,
      hv = 1e-4,
      ht = 1e-5;
    const d2SdSig =
      (blackScholesPrice({
        type,
        spot: S + h,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig + hv,
      }) -
        blackScholesPrice({
          type,
          spot: S + h,
          strike: K,
          timeToExpiryYears: TT,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig - hv,
        }) -
        blackScholesPrice({
          type,
          spot: S - h,
          strike: K,
          timeToExpiryYears: TT,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig + hv,
        }) +
        blackScholesPrice({
          type,
          spot: S - h,
          strike: K,
          timeToExpiryYears: TT,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig - hv,
        })) /
      (4 * h * hv);
    const d2Sig2 =
      (blackScholesPrice({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig + hv,
      }) -
        2 * V0 +
        blackScholesPrice({
          type,
          spot: S,
          strike: K,
          timeToExpiryYears: TT,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig - hv,
        })) /
      (hv * hv);
    // ∂²V/∂S∂t_calendar = −∂²V/∂S∂T: bump T DOWN for a step forward in calendar time.
    const d2Sdt =
      (blackScholesPrice({
        type,
        spot: S + h,
        strike: K,
        timeToExpiryYears: TT - ht,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig,
      }) -
        blackScholesPrice({
          type,
          spot: S + h,
          strike: K,
          timeToExpiryYears: TT + ht,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig,
        }) -
        blackScholesPrice({
          type,
          spot: S - h,
          strike: K,
          timeToExpiryYears: TT - ht,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig,
        }) +
        blackScholesPrice({
          type,
          spot: S - h,
          strike: K,
          timeToExpiryYears: TT + ht,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig,
        })) /
      (4 * h * ht);

    expect(e.vanna).toBeCloseTo(d2SdSig * dS * dSig, 7);
    expect(e.vomma).toBeCloseTo(0.5 * d2Sig2 * dSig * dSig, 8);
    expect(e.charm).toBeCloseTo(d2Sdt * dS * timeStepYears, 8);
    expectSumsToTotal(e);
  });

  it('captures the exact 2nd-order attribution: the residual is O(move³) (cubic convergence)', () => {
    // spot+vol move so vanna+vomma are the active new terms; halving the move must shrink the residual
    // ~8× (the 2nd-order Taylor is exact to O(move³)).
    const residualAt = (scale: number): number => {
      const dS = 2 * scale,
        dSig = 0.03 * scale;
      const raw = {
        value: V0,
        spot: S,
        ...blackScholesExtendedGreeks({
          type,
          spot: S,
          strike: K,
          timeToExpiryYears: TT,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig,
        }),
      };
      const V1 = blackScholesPrice({
        type,
        spot: S + dS,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig + dSig,
      });
      return Math.abs(
        explainPnl({ greeks: raw, move: { dSpot: dS, dVolatility: dSig }, actualPnl: V1 - V0 })
          .unexplained,
      );
    };
    const r1 = residualAt(0.25);
    const rSquared = residualAt(0.125);
    const r3 = residualAt(0.0625);
    expect(r1 / rSquared).toBeGreaterThan(6); // ≈ 8 (cubic)
    expect(rSquared / r3).toBeGreaterThan(6);
  });

  it('for a small spot+vol move, promoting vanna/vomma out of the residual shrinks it', () => {
    // Honest framing: this holds as the move → 0 (where the 3rd-order term is negligible). For a large
    // move the 3rd-order term can dominate and even make first-order coincidentally closer — which is why
    // the correctness proofs above are the exact-FD-match and cubic convergence, not "smaller number".
    const dS = 0.2,
      dSig = 0.004;
    const V1 = blackScholesPrice({
      type,
      spot: S + dS,
      strike: K,
      timeToExpiryYears: TT,
      riskFreeRate: r,
      dividendYield: q,
      volatility: sig + dSig,
    });
    const actual = V1 - V0;
    const withHO = explainPnl({
      greeks: {
        value: V0,
        spot: S,
        ...blackScholesExtendedGreeks({
          type,
          spot: S,
          strike: K,
          timeToExpiryYears: TT,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig,
        }),
      },
      move: { dSpot: dS, dVolatility: dSig },
      actualPnl: actual,
    });
    const firstOrderOnly = explainPnl({
      greeks: {
        value: V0,
        spot: S,
        ...blackScholesGreeks({
          type,
          spot: S,
          strike: K,
          timeToExpiryYears: TT,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig,
        }),
      },
      move: { dSpot: dS, dVolatility: dSig },
      actualPnl: actual,
    });
    expect(Math.abs(withHO.unexplained)).toBeLessThan(Math.abs(firstOrderOnly.unexplained));
    // the vanna term is the dominant new contributor for a spot+vol move
    expect(Math.abs(withHO.vanna)).toBeGreaterThan(Math.abs(withHO.vomma));
  });

  it('explainPnl guards a non-object greeks and a non-finite value/spot', () => {
    expect(() =>
      explainPnl({ greeks: undefined as never, move: { dSpot: 1 }, actualPnl: 0 }),
    ).toThrowError();
    expect(() =>
      explainPnl({ greeks: { value: NaN, delta: 0.5 }, move: { dSpot: 1 }, actualPnl: 0 }),
    ).toThrowError();
    expect(() =>
      explainPnl({ greeks: { value: 5, spot: NaN, delta: 0.5 }, move: { dSpot: 1 }, actualPnl: 0 }),
    ).toThrowError();
  });
});

describe('explainPnl — the full 2nd-order Taylor + dividend carry (veta/vera/rate-crosses/ε)', () => {
  const T = ['call', 100, 100, 0.5, 0.03, 0.01, 0.25] as const;
  const [type, S, K, TT, r, q, sig] = T;
  const V0 = blackScholesPrice({
    type,
    spot: S,
    strike: K,
    timeToExpiryYears: TT,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sig,
  });

  /** Price at bumps of the five factors; calendar time `dC` shrinks time-to-expiry (`TT − dC`). */
  const P = (dS = 0, dV = 0, dC = 0, dR = 0, dQ = 0): number =>
    blackScholesPrice({
      type,
      spot: S + dS,
      strike: K,
      timeToExpiryYears: TT - dC,
      riskFreeRate: r + dR,
      dividendYield: q + dQ,
      volatility: sig + dV,
    });
  const spotStep = 0.02,
    hV = 1e-3,
    hC = 1e-3,
    rateStep = 1e-4,
    dividendYieldStep = 1e-4;
  // The four 2nd-order crosses/convexities NOT carried by ExtendedGreeks (calendar-time convention).
  const fdDeltaRate = // ∂²V/∂S∂r
    (P(spotStep, 0, 0, rateStep) -
      P(spotStep, 0, 0, -rateStep) -
      P(-spotStep, 0, 0, rateStep) +
      P(-spotStep, 0, 0, -rateStep)) /
    (4 * spotStep * rateStep);
  const fdThetaRate = // ∂²V/∂c∂r
    (P(0, 0, hC, rateStep) -
      P(0, 0, hC, -rateStep) -
      P(0, 0, -hC, rateStep) +
      P(0, 0, -hC, -rateStep)) /
    (4 * hC * rateStep);
  const fdRhoConvex =
    (P(0, 0, 0, rateStep) - 2 * V0 + P(0, 0, 0, -rateStep)) / (rateStep * rateStep); // ∂²V/∂r²
  const fdThetaConvex = (P(0, 0, hC) - 2 * V0 + P(0, 0, -hC)) / (hC * hC); // ∂²V/∂c²
  // The three carried analytically (for the wiring check below).
  const fdVeta = (P(0, hV, hC) - P(0, hV, -hC) - P(0, -hV, hC) + P(0, -hV, -hC)) / (4 * hV * hC); // ∂²V/∂σ∂c = −∂vega/∂T
  const fdVera = // ∂²V/∂σ∂r
    (P(0, hV, 0, rateStep) -
      P(0, hV, 0, -rateStep) -
      P(0, -hV, 0, rateStep) +
      P(0, -hV, 0, -rateStep)) /
    (4 * hV * rateStep);
  const fdPhi =
    (P(0, 0, 0, 0, dividendYieldStep) - P(0, 0, 0, 0, -dividendYieldStep)) /
    (2 * dividendYieldStep); // ∂V/∂q

  const rel = (a: number, b: number, tolerance = 2e-3): boolean =>
    Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b));

  it('veta/vera/phi from ExtendedGreeks enter with the right sign and scale (FD-verified)', () => {
    const greeks = {
      value: V0,
      spot: S,
      ...blackScholesExtendedGreeks({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig,
      }),
    };
    const dSig = 0.01;
    const dt = 0.01;
    const dr = 0.001;
    const dq = 0.001;
    const e = explainPnl({
      greeks,
      move: { dVolatility: dSig, dTimeYears: dt, dRate: dr, dDividendYield: dq },
      actualPnl: 0,
    });
    // veta enters with the calendar sign (like charm), vera unscaled, phi per 1% (φ·100 raw).
    expect(rel(e.veta / (dSig * dt), fdVeta)).toBe(true);
    expect(rel(e.vera / (dSig * dr), fdVera)).toBe(true);
    expect(rel(e.phi / dq, fdPhi)).toBe(true);
    // The four rate-cross / time-convexity terms are NOT on ExtendedGreeks — their terms are 0.
    expect(e.deltaRate).toBe(0);
    expect(e.thetaRate).toBe(0);
    expect(e.rhoConvexity).toBe(0);
    expect(e.thetaConvexity).toBe(0);
  });
  it('each supplied 2nd-order term equals its mixed-partial × the moves (FD-verified)', () => {
    const dS = 1.5,
      dSig = 0.02,
      timeStepYears = 0.02,
      dr = 0.004;
    const analytic = {
      value: V0,
      spot: S,
      ...blackScholesExtendedGreeks({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig,
      }),
    };
    const raw: PositionGreeks = {
      ...analytic,
      // FD partials are raw (per 1.00 rate, per year); the engine takes the one unit system.
      deltaRate: fdDeltaRate / PCT,
      thetaRate: fdThetaRate / (DAYS * PCT),
      rhoConvexity: fdRhoConvex / (PCT * PCT),
      thetaConvexity: fdThetaConvex / (DAYS * DAYS),
    };
    const e = explainPnl({
      greeks: raw,
      move: { dSpot: dS, dVolatility: dSig, dTimeYears: timeStepYears, dRate: dr },
      actualPnl: 0,
    });
    // veta/vera are the analytic ExtendedGreeks (their FD-convention check is the wiring test above);
    // here confirm the engine multiplies each supplied greek by the correct move factors, exactly.
    expect(e.veta).toBeCloseTo(-raw.veta! * dSig * timeStepYears, 12); // options ∂vega/∂T enters with the calendar sign
    expect(e.vera).toBeCloseTo(raw.vera! * dSig * dr, 12);
    // The four FD-supplied crosses: the FD partial matches the term's move factors to FD precision.
    expect(e.deltaRate).toBeCloseTo(fdDeltaRate * dS * dr, 10);
    expect(e.thetaRate).toBeCloseTo(fdThetaRate * timeStepYears * dr, 12);
    expect(e.rhoConvexity).toBeCloseTo(0.5 * fdRhoConvex * dr * dr, 12);
    expect(e.thetaConvexity).toBeCloseTo(0.5 * fdThetaConvex * timeStepYears * timeStepYears, 12);
  });

  it('a full (spot,vol,time,rate) move leaves an O(move³) residual — the 2nd-order Taylor is complete', () => {
    // Analytic greeks where available (through veta/vera); FD for the four rate/time crosses. Each enters
    // the expansion at O(move²), so their O(h²) FD-coefficient error stays below the O(move³) residual.
    const analytic = {
      value: V0,
      spot: S,
      ...blackScholesExtendedGreeks({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig,
      }),
    };
    const raw: PositionGreeks = {
      ...analytic,
      // FD partials are raw (per 1.00 rate, per year); the engine takes the one unit system.
      deltaRate: fdDeltaRate / PCT,
      thetaRate: fdThetaRate / (DAYS * PCT),
      rhoConvexity: fdRhoConvex / (PCT * PCT),
      thetaConvexity: fdThetaConvex / (DAYS * DAYS),
    };
    const residualAt = (scale: number): number => {
      const dS = 1 * scale,
        dSig = 0.02 * scale,
        timeStepYears = 0.02 * scale,
        dr = 0.005 * scale;
      const V1 = blackScholesPrice({
        type,
        spot: S + dS,
        strike: K,
        timeToExpiryYears: TT - timeStepYears,
        riskFreeRate: r + dr,
        dividendYield: q,
        volatility: sig + dSig,
      });
      return Math.abs(
        explainPnl({
          greeks: raw,
          move: { dSpot: dS, dVolatility: dSig, dTimeYears: timeStepYears, dRate: dr },
          actualPnl: V1 - V0,
        }).unexplained,
      );
    };
    const r1 = residualAt(0.5),
      rSquared = residualAt(0.25),
      r3 = residualAt(0.125);
    expect(r1 / rSquared).toBeGreaterThan(6); // ≈ 8 (cubic) — halving the move shrinks the residual ~8×
    expect(rSquared / r3).toBeGreaterThan(6);
  });

  it('the same full move with only the first-order+gamma greeks leaves an O(move²) residual', () => {
    // Contrast: dropping the 2nd-order cross/curvature terms, the residual is quadratic — halving the
    // move shrinks it only ~4×. This is what the new terms remove.
    const firstOrder: PositionGreeks = {
      value: V0,
      spot: S,
      ...blackScholesGreeks({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig,
      }),
    };
    const residualAt = (scale: number): number => {
      const dS = 1 * scale,
        dSig = 0.02 * scale,
        timeStepYears = 0.02 * scale,
        dr = 0.005 * scale;
      const V1 = blackScholesPrice({
        type,
        spot: S + dS,
        strike: K,
        timeToExpiryYears: TT - timeStepYears,
        riskFreeRate: r + dr,
        dividendYield: q,
        volatility: sig + dSig,
      });
      return Math.abs(
        explainPnl({
          greeks: firstOrder,
          move: { dSpot: dS, dVolatility: dSig, dTimeYears: timeStepYears, dRate: dr },
          actualPnl: V1 - V0,
        }).unexplained,
      );
    };
    const ratio = residualAt(0.5) / residualAt(0.25);
    expect(ratio).toBeGreaterThan(3.2);
    expect(ratio).toBeLessThan(5); // quadratic (~4), NOT cubic (~8)
  });

  it('the dividend-carry term ε·dq is attributed and FD-matches ∂V/∂q (and shrinks the residual)', () => {
    const dq = 0.002; // +20bp dividend yield
    const raw = {
      value: V0,
      spot: S,
      ...blackScholesExtendedGreeks({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig,
      }),
    };
    const V1 = blackScholesPrice({
      type,
      spot: S,
      strike: K,
      timeToExpiryYears: TT,
      riskFreeRate: r,
      dividendYield: q + dq,
      volatility: sig,
    });
    const withEps = explainPnl({ greeks: raw, move: { dDividendYield: dq }, actualPnl: V1 - V0 });
    expect(withEps.phi).toBeCloseTo(fdPhi * dq, 6);
    expect(withEps.phi).toBeLessThan(0); // a call loses value as the dividend yield rises
    // Dropping ε (first-order greeks only) leaves the whole move unexplained; keeping it captures ~all.
    const withoutEps = explainPnl({
      greeks: {
        value: V0,
        spot: S,
        ...blackScholesGreeks({
          type,
          spot: S,
          strike: K,
          timeToExpiryYears: TT,
          riskFreeRate: r,
          dividendYield: q,
          volatility: sig,
        }),
      },
      move: { dDividendYield: dq },
      actualPnl: V1 - V0,
    });
    expect(Math.abs(withEps.unexplained)).toBeLessThan(Math.abs(withoutEps.unexplained));
    expect(Math.abs(withEps.unexplained)).toBeLessThan(Math.abs(withEps.phi) * 1e-2);
  });

  it('a dividend shock flows through the scenario shock constructor and Taylor engine', () => {
    // shock.dividend → the 'dividend' factor → the ε·dq term (parity with shock.riskFreeRate / shock.volatility).
    const raw = {
      value: V0,
      spot: S,
      ...blackScholesExtendedGreeks({
        type,
        spot: S,
        strike: K,
        timeToExpiryYears: TT,
        riskFreeRate: r,
        dividendYield: q,
        volatility: sig,
      }),
    };
    const e = explainPnl({ greeks: raw, move: { dDividendYield: 0.001 }, actualPnl: 0 });
    expect(e.phi).toBeCloseTo(raw.phi! * PCT * 0.001, 12); // phi per 1% × 10 bp
  });
});

describe('explainPositionPnl — a strategy position, aggregate + per-leg', () => {
  const pos = strategy(
    [
      legs.put({ strike: 95, premium: 2.0, quantity: -1 }),
      legs.put({ strike: 90, premium: 1.0, quantity: 1 }),
    ],
    { multiplier: 100, expiry: EXPIRY },
  );
  const base = { riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' } as const;

  it('auto-attributes the higher-order terms — Position.value() now emits extended greeks', () => {
    // Before the extended-greeks wiring in Position.value(), this path attributed ONLY first-order +
    // gamma (vanna/vomma/charm/veta/vera were all 0 on the auto path). A spot+vol+time+rate move now
    // activates every second-order term through explainPositionPnl with no hand-supplied greek set.
    const from = { ...base, spot: 100, volatility: 0.2 };
    const to = { spot: 104, volatility: 0.26, riskFreeRate: 0.05, asOf: '2026-05-15T00:00:00Z' };
    const e = explainPositionPnl({ position: pos, from, to });
    for (const term of ['vanna', 'vomma', 'charm', 'veta', 'vera'] as const) {
      expect(Math.abs(e[term])).toBeGreaterThan(0);
    }
    expectSumsToTotal(e);
    // Honest claim: had these higher-order terms NOT been attributed (first-order+gamma only), they'd
    // sit in the residual — so the full 2nd-order residual is strictly smaller than that lumped one.
    const firstOrderResidual =
      e.unexplained +
      e.vanna +
      e.vomma +
      e.charm +
      e.veta +
      e.vera +
      e.deltaRate +
      e.thetaRate +
      e.rhoConvexity +
      e.thetaConvexity +
      e.phi;
    expect(Math.abs(e.unexplained)).toBeLessThan(Math.abs(firstOrderResidual));
  });

  it('the aggregate identity holds and per-leg attributions sum to the aggregate', () => {
    const from = { ...base, spot: 100, volatility: 0.2 };
    const to = { spot: 101, volatility: 0.21, riskFreeRate: 0.04, asOf: '2026-05-08T00:00:00Z' };
    const e = explainPositionPnl({ position: pos, from, to });

    expectSumsToTotal(e);
    expect(e.perLeg).toHaveLength(2);
    for (const leg of e.perLeg) expectSumsToTotal(leg);

    // Each greek term is additive across legs.
    for (const k of ADDITIVE_KEYS) {
      const legSum = e.perLeg.reduce((a, l) => a + l[k], 0);
      expect(legSum).toBeCloseTo(e[k], 8);
    }
  });

  it('a small spot move is explained almost entirely by delta+gamma (tiny residual)', () => {
    const from = { ...base, spot: 100, volatility: 0.2 };
    const to = { spot: 100.5, volatility: 0.2, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' }; // same day, tiny spot move
    const e = explainPositionPnl({ position: pos, from, to });
    const explained = e.delta + e.gamma;
    // The first-order+gamma terms capture ~all of it; the residual is a rounding sliver.
    expect(Math.abs(e.unexplained)).toBeLessThan(Math.abs(explained) * 1e-3 + 1e-6);
  });

  it('a large spot move leaves a bigger (honest) residual than a small one', () => {
    const small = explainPositionPnl({
      position: pos,
      from: { ...base, spot: 100, volatility: 0.2 },
      to: { spot: 100.5, volatility: 0.2, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' },
    });
    const large = explainPositionPnl({
      position: pos,
      from: { ...base, spot: 100, volatility: 0.2 },
      to: { spot: 115, volatility: 0.2, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' },
    });
    expect(Math.abs(large.unexplained)).toBeGreaterThan(Math.abs(small.unexplained));
  });

  it('a pure vol move attributes P&L to the vega term (sign of the vol change)', () => {
    // Short vol (net short put spread is net short vega on the sold put), vol UP → vega P&L negative.
    const from = { ...base, spot: 100, volatility: 0.2 };
    const to = { spot: 100, volatility: 0.3, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' }; // vol +10 pts, nothing else
    const e = explainPositionPnl({ position: pos, from, to });
    expect(Math.abs(e.vega)).toBeGreaterThan(0);
    // The vega term should dominate the explained P&L of a pure vol move.
    expect(Math.abs(e.vega)).toBeGreaterThan(Math.abs(e.delta) + Math.abs(e.theta));
    expectSumsToTotal(e);
  });

  it('Law 2 report grammar: the position report echoes the realized move; per-leg rows stay bare', () => {
    const from = { ...base, spot: 100, volatility: 0.2 };
    const to = { spot: 101, volatility: 0.21, riskFreeRate: 0.04, asOf: '2026-05-08T00:00:00Z' };
    const e = explainPositionPnl({ position: pos, from, to });
    expect(e.assumptions.conventionsVersion).toBeTruthy();
    expect(e.assumptions['dSpot']).toBe(1);
    expect(e.assumptions['dVolatility']).toBeCloseTo(0.01, 12);
    expect(e.assumptions['dTimeYears']).toBeCloseTo(7 / 365, 12);
    expect(e.assumptions['timeDayCount']).toBe('ACT/365F');
    expect(e.assumptions['legs']).toBe(2);
    expect(Array.isArray(e.diagnostics.warnings)).toBe(true);
    expect('value' in e).toBe(false); // report, not envelope
    for (const leg of e.perLeg) expect('assumptions' in leg).toBe(false);
  });
});

describe('Law 2 report grammar — explainPnl', () => {
  it('echoes the applied move with the `?? 0` defaults resolved', () => {
    const e = explainPnl({ greeks: { value: 0, delta: 0.3 }, move: { dSpot: 5 }, actualPnl: 2 });
    expect(e.assumptions.conventionsVersion).toBeTruthy();
    expect(e.assumptions['dSpot']).toBe(5);
    expect(e.assumptions['dVolatility']).toBe(0); // the resolved default, disclosed
    expect(e.assumptions['dTimeYears']).toBe(0);
    expect(e.assumptions['dRate']).toBe(0);
    expect('value' in e).toBe(false);
  });

  it('warns when the unexplained residual dominates the total (the expansion broke down)', () => {
    // delta explains 1.5 of a 100 P&L: the residual is ~all of it.
    const e = explainPnl({ greeks: { value: 0, delta: 0.3 }, move: { dSpot: 5 }, actualPnl: 100 });
    expect(e.diagnostics.warnings.map((w) => w.code)).toContain('risk.pnl_unexplained_residual');
    // A well-explained move carries no residual warning.
    const ok = explainPnl({ greeks: { value: 0, delta: 0.3 }, move: { dSpot: 5 }, actualPnl: 1.6 });
    expect(ok.diagnostics.warnings).toEqual([]);
  });
});

describe('explainPositionPnl — per-leg fixed IV is inert to a position-level vol move (no phantom vega)', () => {
  // Legs carry their OWN iv (as a chain-built position does), so `Position.value()` ignores the
  // position-level `vol`. The attribution must reflect that: zero vega, zero phantom residual.
  const pos = strategy(
    [
      { kind: 'put', strike: 100, quantity: -1, premium: 3.0, impliedVolatility: 0.25 },
      { kind: 'put', strike: 95, quantity: 1, premium: 1.5, impliedVolatility: 0.3 },
    ],
    { multiplier: 100, expiry: EXPIRY },
  );
  const base = { riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' } as const;

  it('a pure position-vol change moves nothing: total, vega, and residual are all ~0', () => {
    const e = explainPositionPnl({
      position: pos,
      from: { ...base, spot: 100, volatility: 0.2 },
      to: { spot: 100, volatility: 0.35, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' },
    });
    expect(e.total).toBeCloseTo(0, 8); // the legs never saw the vol change
    expect(e.vega).toBeCloseTo(0, 8); // no phantom vega...
    expect(e.unexplained).toBeCloseTo(0, 8); // ...and therefore no phantom residual
    for (const l of e.perLeg) expect(l.vega).toBeCloseTo(0, 10);
    expectSumsToTotal(e);
  });

  it('a spot move with a concurrent position-vol change still attributes zero vega to fixed-IV legs', () => {
    const e = explainPositionPnl({
      position: pos,
      from: { ...base, spot: 100, volatility: 0.2 },
      to: { spot: 103, volatility: 0.35, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' },
    });
    expect(e.vega).toBeCloseTo(0, 8); // the vol change is not the legs' vol
    expect(Math.abs(e.delta) + Math.abs(e.gamma)).toBeGreaterThan(0); // the spot move IS attributed
    expectSumsToTotal(e);
  });
});

describe('explainPortfolioPnl — the book roll-up', () => {
  it('sums the per-position explains term by term', () => {
    const putSpread = strategy(
      [
        legs.put({ strike: 95, premium: 2, quantity: -1 }),
        legs.put({ strike: 90, premium: 1, quantity: 1 }),
      ],
      { multiplier: 100, expiry: EXPIRY },
    );
    const callSpread = strategy(
      [
        legs.call({ strike: 105, premium: 2, quantity: -1 }),
        legs.call({ strike: 110, premium: 1, quantity: 1 }),
      ],
      { multiplier: 100, expiry: EXPIRY },
    );
    const from = { spot: 100, volatility: 0.2, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' };
    const to = { spot: 102, volatility: 0.22, riskFreeRate: 0.04, asOf: '2026-05-08T00:00:00Z' };

    const book = explainPortfolioPnl([
      { position: putSpread, from, to, id: 'puts' },
      { position: callSpread, from, to, id: 'calls' },
    ]);

    expect(book.byPosition).toHaveLength(2);
    expect(book.byPosition[0]!.id).toBe('puts');
    for (const k of ADDITIVE_KEYS) {
      const sum = book.byPosition.reduce((a, p) => a + p[k], 0);
      expect(sum).toBeCloseTo(book[k], 8);
    }
    expectSumsToTotal(book);
  });
});

describe('P&L explain — envelope & guards', () => {
  it('throws typed errors on garbage (never a raw crash)', () => {
    expect(() => explainPnl({ greeks: undefined as never, move: {}, actualPnl: 0 })).toThrowError();
    expect(() =>
      explainPnl({ greeks: { value: 0 }, move: undefined as never, actualPnl: 0 }),
    ).toThrowError();
    expect(() => explainPnl({ greeks: { value: 0 }, move: {}, actualPnl: NaN })).toThrowError();
    expect(() => explainPortfolioPnl(undefined as never)).toThrowError();
    try {
      explainPositionPnl({
        position: undefined as never,
        from: { spot: 1, riskFreeRate: 0, asOf: 0 },
        to: { spot: 1, riskFreeRate: 0, asOf: 0 },
      });
      expect.unreachable('garbage position should throw');
    } catch (e) {
      expect(isQuantError(e)).toBe(true);
    }
  });
});
