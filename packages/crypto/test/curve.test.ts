/**
 * Crypto carry curve (`carryCurve`). The term structure built from a spot + a set of futures: a
 * constant-carry curve is flat in both the per-expiry and the forward carries, a steepening contango
 * classifies `upward`, backwardation gives negative carries, the forward carries tile the curve, the
 * log-linear interpolation reproduces the nodes and is exact for constant carry, and the guards hold.
 */

import { describe, expect, it } from 'vitest';
import { PostconditionError } from '@totalfinance/core';
import { carryCurve, futuresBasis } from '@totalfinance/crypto';

const S = 60000;
const TS = [0.25, 0.5, 0.75, 1];
const constCarry = (c: number) =>
  TS.map((t) => ({ timeToExpiryYears: t, price: S * Math.exp(c * t) }));

describe('carryCurve', () => {
  it('a constant-carry curve is flat in both the per-expiry and the forward carries', () => {
    const r = carryCurve({ spot: S, futures: constCarry(0.08) });
    expect(r.value.points).toHaveLength(4);
    for (const p of r.value.points) expect(p.annualizedCarry).toBeCloseTo(0.08, 10);
    for (const f of r.value.forwards) expect(f.forwardCarry).toBeCloseTo(0.08, 10);
    expect(r.value.forwards).toHaveLength(4); // spot→F1, F1→F2, F2→F3, F3→F4
    expect(r.value.forwards[0]!.fromTenorYears).toBe(0); // the first window starts at spot
    expect(r.value.shape).toBe('flat');
    // Each point equals the standalone futuresBasis.
    expect(r.value.points[1]!.annualizedCarry).toBeCloseTo(
      futuresBasis({ spot: S, future: r.value.points[1]!.price, timeToExpiryYears: 0.5 }).value
        .annualizedLog,
      12,
    );
  });

  it('the first forward carry equals the nearest point carry (the forwards tile the curve)', () => {
    const r = carryCurve({ spot: S, futures: constCarry(0.05) });
    expect(r.value.forwards[0]!.forwardCarry).toBeCloseTo(r.value.points[0]!.annualizedCarry, 12);
  });

  it('classifies a steepening contango as upward, all points in contango', () => {
    const r = carryCurve({
      spot: S,
      futures: [
        { timeToExpiryYears: 0.25, price: S * 1.005 },
        { timeToExpiryYears: 0.5, price: S * 1.02 },
        { timeToExpiryYears: 0.75, price: S * 1.05 },
        { timeToExpiryYears: 1, price: S * 1.1 },
      ],
    });
    expect(r.value.shape).toBe('upward');
    for (const p of r.value.points) {
      expect(p.structure).toBe('contango');
      expect(p.annualizedCarry).toBeGreaterThan(0);
    }
    // Forward carries strictly increase.
    for (let i = 1; i < r.value.forwards.length; i++) {
      expect(r.value.forwards[i]!.forwardCarry).toBeGreaterThan(
        r.value.forwards[i - 1]!.forwardCarry,
      );
    }
  });

  it('reports negative carries and backwardation when futures trade below spot', () => {
    const r = carryCurve({
      spot: S,
      futures: [
        { timeToExpiryYears: 0.25, price: S * 0.99 },
        { timeToExpiryYears: 0.5, price: S * 0.97 },
        { timeToExpiryYears: 1, price: S * 0.9 },
      ],
    });
    for (const p of r.value.points) {
      expect(p.structure).toBe('backwardation');
      expect(p.annualizedCarry).toBeLessThan(0);
    }
  });

  it('interpolates log-linearly: reproduces the nodes and is exact for constant carry', () => {
    const r = carryCurve({ spot: S, futures: constCarry(0.08), queryTenors: [0.5, 0.6, 1.25] });
    expect(r.value.interpolated).toHaveLength(3);
    // At a node the implied forward equals that future's price.
    expect(r.value.interpolated![0]!.impliedForward).toBeCloseTo(S * Math.exp(0.08 * 0.5), 6);
    // Between nodes, constant carry ⇒ the interpolated carry is exactly c.
    expect(r.value.interpolated![1]!.annualizedCarry).toBeCloseTo(0.08, 10);
    // Beyond the last expiry, flat-forward extrapolation keeps the carry at c.
    expect(r.value.interpolated![2]!.annualizedCarry).toBeCloseTo(0.08, 10);
  });

  it('sorts unsorted futures by expiry and attaches cash-and-carry richness when financing is given', () => {
    const r = carryCurve({
      spot: S,
      futures: [
        { timeToExpiryYears: 1, price: S * 1.06 },
        { timeToExpiryYears: 0.25, price: S * 1.01 },
      ],
      financingRate: 0.05,
      coinYield: 0.01,
    });
    expect(r.value.points.map((p) => p.timeToExpiryYears)).toEqual([0.25, 1]); // sorted
    for (const p of r.value.points) expect(typeof p.richness).toBe('number');
    // richness matches the standalone futuresBasis.
    const fb = futuresBasis({
      spot: S,
      future: S * 1.01,
      timeToExpiryYears: 0.25,
      financingRate: 0.05,
      coinYield: 0.01,
    });
    expect(r.value.points[0]!.richness).toBeCloseTo(fb.value.richness!, 8);
  });

  it('classifies downward, humped, and mixed shapes from the forward-carry sequence', () => {
    // Build futures from a target forward-carry sequence (dt = 0.25 per step).
    const fromForwards = (fwds: number[]) => {
      const futures: { timeToExpiryYears: number; price: number }[] = [];
      let t = 0;
      let lnF = Math.log(S);
      for (const c of fwds) {
        t += 0.25;
        lnF += c * 0.25;
        futures.push({ timeToExpiryYears: t, price: Math.exp(lnF) });
      }
      return futures;
    };
    expect(carryCurve({ spot: S, futures: fromForwards([0.15, 0.05, 0.02]) }).value.shape).toBe(
      'downward',
    );
    expect(carryCurve({ spot: S, futures: fromForwards([0.02, 0.08, 0.03]) }).value.shape).toBe(
      'humped',
    );
    expect(carryCurve({ spot: S, futures: fromForwards([0.05, 0.02, 0.06]) }).value.shape).toBe(
      'mixed',
    );
    // Interior peak but the left side is non-monotone ⇒ not humped ⇒ mixed.
    expect(
      carryCurve({ spot: S, futures: fromForwards([0.03, 0.01, 0.08, 0.02]) }).value.shape,
    ).toBe('mixed');
  });

  it('a single future gives a flat shape (no forward window to slope)', () => {
    const r = carryCurve({ spot: S, futures: [{ timeToExpiryYears: 0.5, price: S * 1.02 }] });
    expect(r.value.shape).toBe('flat');
    expect(r.value.forwards).toHaveLength(1);
  });

  it('guards a bad input, empty/non-array futures, non-positive fields, duplicates, and a bad tenor', () => {
    expect(() => carryCurve(undefined as never)).toThrowError();
    expect(() => carryCurve({ spot: S, futures: [] })).toThrowError();
    expect(() => carryCurve({ spot: S, futures: undefined as never })).toThrowError();
    expect(() => carryCurve({ spot: 0, futures: constCarry(0.05) })).toThrowError();
    expect(() =>
      carryCurve({ spot: S, futures: [{ timeToExpiryYears: -1, price: 100 }] }),
    ).toThrowError();
    expect(() =>
      carryCurve({ spot: S, futures: [{ timeToExpiryYears: 0.5, price: 0 }] }),
    ).toThrowError();
    expect(() =>
      carryCurve({
        spot: S,
        futures: [
          { timeToExpiryYears: 0.5, price: 100 },
          { timeToExpiryYears: 0.5, price: 101 },
        ],
      }),
    ).toThrowError(); // duplicate expiry
    expect(() =>
      carryCurve({ spot: S, futures: constCarry(0.05), queryTenors: [-0.5] }),
    ).toThrowError();
  });
});

/**
 * [review-1] `carryCurve` returned its envelope directly, bypassing `finalizeResult`. A tenor far
 * past the last expiry extrapolates `ln F` linearly, so `exp(...)` overflows — and the overflow used
 * to ship as a successful `impliedForward: Infinity` that `JSON.stringify` would flatten to `null`.
 */
describe('Law 7 postcondition — carryCurve is finalized', () => {
  const futures = [
    { timeToExpiryYears: 0.25, price: S * 1.02 },
    { timeToExpiryYears: 0.5, price: S * 1.08 },
  ];

  it('an extrapolated tenor that overflows fails loudly instead of returning Infinity', () => {
    let caught: unknown;
    try {
      carryCurve({ spot: S, futures, queryTenors: [1e5] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PostconditionError);
    expect((caught as Error).message).toMatch(/carryCurve/);
    expect((caught as Error).message).toMatch(/impliedForward/);
  });

  it('a sane extrapolation still returns, and per-point futuresBasis warnings are carried up', () => {
    const ok = carryCurve({ spot: S, futures, queryTenors: [0.75] });
    expect(Number.isFinite(ok.value.interpolated![0]!.impliedForward)).toBe(true);
    expect(ok.diagnostics.warnings).toEqual([]);

    // A financing rate far off the curve's implied carry ⇒ every point reports a cash-and-carry
    // edge. The composed tool used to drop those disclosures on the floor.
    const arb = carryCurve({ spot: S, futures, financingRate: 0.5 });
    const codes = arb.diagnostics.warnings.map((w) => w.code);
    expect(codes).toContain('crypto.carry_arbitrage');
    expect(arb.diagnostics.warnings[0]!.context?.['timeToExpiryYears']).toBe(0.25);
    expect(arb.diagnostics.warnings).toHaveLength(futures.length);
  });
});
