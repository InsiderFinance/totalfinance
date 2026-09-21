/**
 * Touch & double-touch greeks (`touch.greeks`, `doubleTouch.greeks`). First-order greeks by central
 * finite-difference of the exact price. The defining checks are the two EXACT identities — a one-touch
 * (pay-at-expiry) and a no-touch greek sum to the `cash·e^{−rT}` greeks, and DNT + DOT do too — which pin
 * the differenced greeks with no room for a silent error; plus the delta signs, the vol exposure, a bumped
 * Monte-Carlo delta cross-check, units, and guards.
 */

import { describe, expect, it } from 'vitest';
import { touch, doubleTouch } from '@totalfinance/options';
import { DEFAULT_GREEK_UNITS } from '@totalfinance/core';

const T = {
  spot: 100,
  barrier: 90,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.05,
  volatility: 0.25,
  dividendYield: 0.01,
  cash: 1,
};
const df = Math.exp(-T.riskFreeRate * T.timeToExpiryYears);
// Greeks of the constant cash·e^{−rT}: delta = gamma = vega = 0; theta = r·cash·df/365; rho = −T·cash·df/100.
const cashDfGreeks = {
  delta: 0,
  gamma: 0,
  vega: 0,
  theta: (T.riskFreeRate * df) / 365,
  rho: (-T.timeToExpiryYears * df) / 100,
};

describe('touch.greeks', () => {
  it('one-touch (pay-at-expiry) + no-touch greeks sum to the cash·e^{−rT} greeks (exact identity)', () => {
    const ot = touch.greeks({ ...T, kind: 'one-touch' }).value;
    const nt = touch.greeks({ ...T, kind: 'no-touch' }).value;
    for (const k of ['delta', 'gamma', 'vega', 'theta', 'rho'] as const) {
      expect(ot[k] + nt[k]).toBeCloseTo(cashDfGreeks[k], 6);
    }
  });

  it('has the right delta signs: a down-barrier one-touch is short delta, the no-touch long', () => {
    // Spot 100 above barrier 90: moving up (away) lowers the touch probability.
    expect(touch.greeks({ ...T, kind: 'one-touch' }).value.delta).toBeLessThan(0);
    expect(touch.greeks({ ...T, kind: 'no-touch' }).value.delta).toBeGreaterThan(0);
    // Up-barrier one-touch (barrier 110 above spot): moving up raises the touch probability ⇒ long delta.
    expect(touch.greeks({ kind: 'one-touch', ...T, barrier: 110 }).value.delta).toBeGreaterThan(0);
  });

  it('a one-touch is long vol and a no-touch is short vol (more vol ⇒ more likely to touch)', () => {
    expect(touch.greeks({ ...T, kind: 'one-touch' }).value.vega).toBeGreaterThan(0);
    expect(touch.greeks({ ...T, kind: 'no-touch' }).value.vega).toBeLessThan(0);
  });

  it('matches a bumped Monte-Carlo delta for the one-touch (independent check)', () => {
    const analytic = touch.greeks({ ...T, kind: 'one-touch' }).value.delta;
    const h = 1;
    // Common random numbers (same seed for both bumps) make the differenced delta low-variance, so a
    // modest path count suffices — and keeps the test light under CI load.
    const monteCarlo = (s: number) =>
      touch.monteCarloPrice(
        { kind: 'one-touch', ...T, spot: s },
        { paths: 120_000, seed: 5, steps: 80 },
      ).value;
    const monteCarloDelta = (monteCarlo(T.spot + h) - monteCarlo(T.spot - h)) / (2 * h);
    expect(monteCarloDelta).toBeCloseTo(analytic, 2); // ~1e-2 agreement (MC noise + discrete monitoring)
  });

  it('echoes package units and the finite-difference method; honours payAt and its guards', () => {
    const g = touch.greeks({ ...T, kind: 'one-touch' });
    expect(g.assumptions.units).toEqual(DEFAULT_GREEK_UNITS);
    expect(g.diagnostics.method).toBe('finite-difference');
    // pay-at-hit returns finite greeks…
    const hit = touch.greeks({ kind: 'one-touch', ...T, payAt: 'hit' }).value;
    expect(Object.values(hit).every((x) => Number.isFinite(x))).toBe(true);
    // …but a no-touch with payAt:'hit' is rejected, and bad inputs throw.
    expect(() => touch.greeks({ kind: 'no-touch', ...T, payAt: 'hit' })).toThrowError();
    expect(() => touch.greeks({ ...T, kind: 'nope' } as never)).toThrowError();
    expect(() => touch.greeks({ kind: 'one-touch', ...T, volatility: 0 })).toThrowError();
  });

  it('stays finite (no zero-bump NaN) when the spot sits exactly on the barrier', () => {
    // Degenerate point — greeks there are not meaningful, but the fallback bump keeps them finite.
    const g = touch.greeks({ kind: 'one-touch', ...T, spot: T.barrier }).value;
    expect(Object.values(g).every((x) => Number.isFinite(x))).toBe(true);
  });
});

const D = {
  spot: 100,
  lower: 90,
  upper: 115,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.05,
  volatility: 0.2,
  dividendYield: 0.01,
  cash: 1,
};

describe('doubleTouch.greeks', () => {
  it('double-no-touch + double-one-touch greeks sum to the cash·e^{−rT} greeks (exact identity)', () => {
    const dfD = Math.exp(-D.riskFreeRate * D.timeToExpiryYears);
    const target = {
      delta: 0,
      gamma: 0,
      vega: 0,
      theta: (D.riskFreeRate * dfD) / 365,
      rho: (-D.timeToExpiryYears * dfD) / 100,
    };
    const dnt = doubleTouch.greeks({ ...D, kind: 'double-no-touch' }).value;
    const dot = doubleTouch.greeks({ ...D, kind: 'double-one-touch' }).value;
    for (const k of ['delta', 'gamma', 'vega', 'theta', 'rho'] as const) {
      expect(dnt[k] + dot[k]).toBeCloseTo(target[k], 6);
    }
  });

  it('a double-no-touch is short vol (more vol ⇒ more likely to leave the corridor)', () => {
    expect(doubleTouch.greeks({ ...D, kind: 'double-no-touch' }).value.vega).toBeLessThan(0);
    expect(doubleTouch.greeks({ ...D, kind: 'double-one-touch' }).value.vega).toBeGreaterThan(0);
  });

  it('near the upper barrier the double-no-touch delta is negative (a rise risks breaching)', () => {
    // Spot 113, corridor (90,115): the binding risk is the upper barrier, so a rise hurts the DNT.
    expect(
      doubleTouch.greeks({ kind: 'double-no-touch', ...D, spot: 113 }).value.delta,
    ).toBeLessThan(0);
  });

  it('echoes package units and the finite-difference method, and guards bad inputs', () => {
    const g = doubleTouch.greeks({ ...D, kind: 'double-no-touch' });
    expect(g.assumptions.units).toEqual(DEFAULT_GREEK_UNITS);
    expect(g.diagnostics.method).toBe('finite-difference');
    expect(() => doubleTouch.greeks({ ...D, kind: 'nope' } as never)).toThrowError();
    expect(() => doubleTouch.greeks({ kind: 'double-no-touch', ...D, lower: 120 })).toThrowError(); // lower ≥ upper
    expect(() => doubleTouch.greeks(undefined as never)).toThrowError();
  });
});
