/**
 * Cost-aware Kelly sizing (`costAwareKelly`). Pins the net Kelly as the argmax of the cost-adjusted
 * log-growth `g(f) = f(μ−c) − ½f²σ²` (and `netGrowth` its maximum), the `c = holding + roundTrip/horizonPeriods`
 * cost model, the `grossGrowth − netGrowth` drag and the always-worse "ignore the costs" overbet, the
 * breakeven at `c = μ` (don't bet), the high-cost-drag flag, the returns⇄gaussian equivalence, and guards.
 */

import { describe, expect, it } from 'vitest';
import { costAwareKelly } from '@totalfinance/risk';

const EDGE = { gaussian: { mean: 0.012, variance: 0.04 } } as const;
const MU = 0.012;
const V = 0.04;

describe('costAwareKelly', () => {
  it('sizes to the argmax of the cost-adjusted log-growth, net of an amortized cost', () => {
    const r = costAwareKelly({
      edge: EDGE,
      holdingCost: 0.001,
      roundTripCost: 0.004,
      horizonPeriods: 10,
      fraction: 0.5,
    });
    // c = holding + roundTrip/horizonPeriods.
    expect(r.costPerPeriod).toBeCloseTo(0.001 + 0.004 / 10, 15);
    const c = r.costPerPeriod;
    // Numeric argmax of g(f) = f(μ−c) − ½f²σ² over f ≥ 0.
    let bestF = 0;
    let bestG = -Infinity;
    for (let f = 0; f <= 2; f += 0.0002) {
      const g = f * (MU - c) - 0.5 * f * f * V;
      if (g > bestG) {
        bestG = g;
        bestF = f;
      }
    }
    expect(r.netKelly!).toBeCloseTo(bestF, 3);
    expect(r.netKelly!).toBeCloseTo((MU - c) / V, 12);
    expect(r.netGrowth!).toBeCloseTo(bestG, 5);
    expect(r.recommendedFraction!).toBeCloseTo(0.5 * r.netKelly!, 15);
  });

  it('reports gross Kelly / growth and the drag costs impose', () => {
    const r = costAwareKelly({ edge: EDGE, holdingCost: 0.002, fraction: 1 });
    expect(r.grossKelly!).toBeCloseTo(MU / V, 12);
    expect(r.grossGrowth!).toBeCloseTo((MU * MU) / (2 * V), 12);
    expect(r.breakevenCost).toBe(MU);
    expect(r.growthDrag!).toBeCloseTo(r.grossGrowth! - r.netGrowth!, 15);
    // Naively betting gross Kelly while paying costs is an overbet: strictly worse than net Kelly.
    expect(r.ignoringCostsGrowth!).toBeLessThan(r.netGrowth!);
    expect(r.isProfitable).toBe(true);
  });

  it('refuses a bet when the cost meets or exceeds the edge', () => {
    for (const holdingCost of [MU, MU * 1.5]) {
      const r = costAwareKelly({ edge: EDGE, holdingCost });
      expect(r.netKelly!).toBe(0);
      expect(r.netGrowth!).toBe(0);
      expect(r.recommendedFraction!).toBe(0);
      expect(r.isProfitable).toBe(false);
      expect(r.diagnostics.warnings.some((w) => w.code === 'risk.cost_exceeds_edge')).toBe(true);
    }
  });

  it('flags a heavy cost drag while still profitable', () => {
    // c = 0.004 ⇒ drag/gross ≈ 56% (> 25% threshold) but c < μ.
    const r = costAwareKelly({ edge: EDGE, holdingCost: 0.004 });
    expect(r.isProfitable).toBe(true);
    expect(r.growthDrag! / r.grossGrowth!).toBeGreaterThan(0.25);
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.high_cost_drag')).toBe(true);
  });

  it('amortizes the round-trip cost over the horizonPeriods (longer hold ⇒ smaller drag)', () => {
    const short = costAwareKelly({ edge: EDGE, roundTripCost: 0.006, horizonPeriods: 5 });
    const long = costAwareKelly({ edge: EDGE, roundTripCost: 0.006, horizonPeriods: 30 });
    expect(short.costPerPeriod).toBeCloseTo(0.006 / 5, 15);
    expect(long.costPerPeriod).toBeCloseTo(0.006 / 30, 15);
    expect(long.netKelly).toBeGreaterThan(short.netKelly!); // amortized over more periods ⇒ bet more
  });

  it('the returns edge matches the Gaussian edge with the same μ, σ²', () => {
    const rets = [0.05, -0.03, 0.02, 0.04, -0.01, 0.03, -0.02, 0.01];
    const n = rets.length;
    const mu = rets.reduce((a, b) => a + b, 0) / n;
    const v = rets.reduce((a, b) => a + (b - mu) ** 2, 0) / n; // population variance
    const fromReturns = costAwareKelly({ edge: { returns: rets }, holdingCost: 0.002 });
    const fromGaussian = costAwareKelly({
      edge: { gaussian: { mean: mu, variance: v } },
      holdingCost: 0.002,
    });
    expect(fromReturns.mean).toBeCloseTo(mu, 12);
    expect(fromReturns.variance).toBeCloseTo(v, 12);
    expect(fromReturns.netKelly).toBeCloseTo(fromGaussian.netKelly!, 12);
    expect(fromReturns.assumptions.edgeType).toBe('returns');
  });

  it('guards a bad edge, negative costs, a round-trip without a horizonPeriods, and a bad fraction', () => {
    expect(() => costAwareKelly(undefined as never)).toThrowError();
    expect(() => costAwareKelly({ edge: {} as never })).toThrowError();
    expect(() =>
      costAwareKelly({ edge: { gaussian: { mean: 0.01, variance: -1 } } }),
    ).toThrowError();
    expect(() => costAwareKelly({ edge: { returns: [0.01] } })).toThrowError(); // < 2
    // C (hygiene): a zero-variance edge sizes to null with a diagnostic — see the zero-variance block
    expect(() => costAwareKelly({ edge: EDGE, holdingCost: -0.001 })).toThrowError();
    expect(() => costAwareKelly({ edge: EDGE, roundTripCost: 0.004 })).toThrowError(); // no horizonPeriods
    expect(() =>
      costAwareKelly({ edge: EDGE, roundTripCost: 0.004, horizonPeriods: 0 }),
    ).toThrowError();
    expect(() => costAwareKelly({ edge: EDGE, fraction: -1 })).toThrowError();
  });
});

describe('costAwareKelly — a zero-variance edge sizes to null with a diagnostic (C hygiene)', () => {
  it.each([
    ['returns', { returns: [0.02, 0.02, 0.02] }],
    ['gaussian', { gaussian: { mean: 0.02, variance: 0 } }],
  ] as const)(
    '%s edge: every size is null, the edge and costs are still reported',
    (_label, edge) => {
      const result = costAwareKelly({ edge, holdingCost: 0.001 });
      expect(result.grossKelly).toBeNull();
      expect(result.netKelly).toBeNull();
      expect(result.recommendedFraction).toBeNull();
      expect(result.grossGrowth).toBeNull();
      expect(result.netGrowth).toBeNull();
      expect(result.growthDrag).toBeNull();
      expect(result.ignoringCostsGrowth).toBeNull();
      expect(result.mean).toBeCloseTo(0.02, 12);
      expect(result.variance).toBe(0);
      expect(result.breakevenCost).toBeCloseTo(0.02, 12);
      expect(result.isProfitable).toBe(true);
      expect(result.rationale).toContain('zero variance');
      expect(result.diagnostics.warnings.map((w) => w.code)).toEqual(['risk.kelly_zero_variance']);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    },
  );
});
