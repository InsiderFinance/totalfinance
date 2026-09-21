/**
 * Double no-touch / double one-touch (`doubleTouch`). The image-series double-barrier survival closed
 * form is pinned by its Monte-Carlo corroboration (both kinds), the exact `DNT + DOT = cash·e^{−rT}`
 * parity, monotonicity in the corridor width, cash scaling, the already-breached short-circuit, and guards.
 */

import { describe, expect, it } from 'vitest';
import { doubleTouch } from '@totalfinance/options';

const BASE = {
  spot: 100,
  lower: 90,
  upper: 110,
  timeToExpiryYears: 0.5,
  riskFreeRate: 0.03,
  volatility: 0.2,
  dividendYield: 0.0,
  cash: 1,
};

describe('doubleTouch', () => {
  it('the analytic matches the Monte-Carlo for both double-no-touch and double-one-touch', () => {
    // 150k×150 keeps a comfortable ~30× margin on the 5·SE bound while staying light enough to clear the
    // test timeout under coverage instrumentation (300k×200 occasionally timed out, not a correctness fail).
    const monteCarlo = { paths: 150_000, seed: 11, steps: 150 };
    for (const kind of ['double-no-touch', 'double-one-touch'] as const) {
      const a = doubleTouch.price({ ...BASE, kind }).value;
      const m = doubleTouch.monteCarloPrice({ ...BASE, kind }, monteCarlo);
      expect(Math.abs(m.value - a)).toBeLessThan(5 * m.monteCarlo.standardError!);
    }
  });

  it('DNT + DOT = cash·e^{−rT} exactly (one pays iff the other does not)', () => {
    const dnt = doubleTouch.price({ ...BASE, kind: 'double-no-touch' }).value;
    const dot = doubleTouch.price({ ...BASE, kind: 'double-one-touch' }).value;
    expect(dnt + dot).toBeCloseTo(
      BASE.cash * Math.exp(-BASE.riskFreeRate * BASE.timeToExpiryYears),
      12,
    );
  });

  it('the DNT falls and the DOT rises as the corridor tightens (monotone)', () => {
    const widths: Array<[number, number]> = [
      [80, 120],
      [90, 110],
      [95, 106],
    ];
    const dnts = widths.map(
      ([l, u]) => doubleTouch.price({ kind: 'double-no-touch', ...BASE, lower: l, upper: u }).value,
    );
    const dots = widths.map(
      ([l, u]) =>
        doubleTouch.price({ kind: 'double-one-touch', ...BASE, lower: l, upper: u }).value,
    );
    expect(dnts[0]).toBeGreaterThan(dnts[1]!);
    expect(dnts[1]).toBeGreaterThan(dnts[2]!);
    expect(dots[0]).toBeLessThan(dots[1]!);
    expect(dots[1]).toBeLessThan(dots[2]!);
  });

  it('scales with the cash payout', () => {
    const one = doubleTouch.price({ kind: 'double-no-touch', ...BASE, cash: 1 }).value;
    const hundred = doubleTouch.price({ kind: 'double-no-touch', ...BASE, cash: 100 }).value;
    expect(hundred).toBeCloseTo(100 * one, 10);
  });

  it('short-circuits an already-breached corridor (DNT = 0, DOT = cash·e^{−rT})', () => {
    const df = Math.exp(-BASE.riskFreeRate * BASE.timeToExpiryYears);
    for (const spot of [90, 89, 110, 111]) {
      const dnt = doubleTouch.price({ kind: 'double-no-touch', ...BASE, spot });
      const dot = doubleTouch.price({ kind: 'double-one-touch', ...BASE, spot });
      expect(dnt.value).toBe(0);
      expect(dot.value).toBeCloseTo(BASE.cash * df, 12);
      expect(dnt.diagnostics.method).toBe('already-breached');
    }
  });

  it('applies the defaults for dividendYield (0), cash (1), and MC steps (100)', () => {
    const minimal = {
      spot: 100,
      lower: 90,
      upper: 110,
      timeToExpiryYears: 0.5,
      riskFreeRate: 0.03,
      volatility: 0.2,
    };
    const a = doubleTouch.price({ ...minimal, kind: 'double-no-touch' });
    // cash defaults to 1 ⇒ same as the explicit-cash BASE with q = 0.
    expect(a.value).toBeCloseTo(doubleTouch.price({ ...BASE, kind: 'double-no-touch' }).value, 12);
    const m = doubleTouch.monteCarloPrice(
      { ...minimal, kind: 'double-no-touch' },
      { paths: 20_000, seed: 3 },
    ); // steps default 100
    expect(m.value).toBeGreaterThan(0);
    expect(Number.isFinite(m.value)).toBe(true);
  });

  it('guards a bad kind, an inverted corridor, and non-positive inputs', () => {
    expect(() => doubleTouch.price(undefined as never)).toThrowError();
    expect(() => doubleTouch.price({ ...BASE, kind: 'nope' } as never)).toThrowError();
    expect(() =>
      doubleTouch.price({ kind: 'double-no-touch', ...BASE, lower: 120, upper: 110 }),
    ).toThrowError();
    expect(() =>
      doubleTouch.price({ kind: 'double-no-touch', ...BASE, lower: 110, upper: 110 }),
    ).toThrowError();
    expect(() =>
      doubleTouch.price({ kind: 'double-no-touch', ...BASE, volatility: -0.1 }),
    ).toThrowError();
    expect(() => doubleTouch.price({ kind: 'double-no-touch', ...BASE, spot: -1 })).toThrowError();
    expect(() =>
      doubleTouch.price({ kind: 'double-no-touch', ...BASE, timeToExpiryYears: 0 }),
    ).toThrowError();
    expect(() =>
      doubleTouch.monteCarloPrice({ ...BASE, kind: 'double-no-touch' }, undefined as never),
    ).toThrowError();
  });
});
