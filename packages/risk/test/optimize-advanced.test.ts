/**
 * Tests for the advanced optimizers (Black-Litterman, CVaR optimization) and the extended
 * constraints (sector/group caps, turnover budget, transaction costs).
 */

import { describe, expect, it } from 'vitest';
import {
  blackLitterman,
  conditionalValueAtRiskOptimize,
  kelly,
  minVariance,
  meanVariance,
} from '@totalfinance/risk/optimize';
import { dot, matVec, quadForm } from '../src/linalg.js';

const cov2: number[][] = [
  [0.04, 0.006],
  [0.006, 0.09],
];
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe('Black-Litterman', () => {
  it('reverse-engineers the equilibrium prior π = δ·Σ·w_mkt', () => {
    const wm = [0.6, 0.4];
    const delta = 2.5;
    const r = blackLitterman({
      covariance: cov2,
      marketWeights: wm,
      riskAversion: delta,
      views: [{ pick: [1, 0], view: 0.1 }],
    });
    const expectedPi = matVec(cov2, wm).map((x) => delta * x);
    expect(r.value.priorMean[0]).toBeCloseTo(expectedPi[0]!, 12);
    expect(r.value.priorMean[1]).toBeCloseTo(expectedPi[1]!, 12);
  });

  it('a near-zero-confidence (very uncertain) view leaves the posterior ≈ the prior', () => {
    const wm = [0.6, 0.4];
    const r = blackLitterman({
      covariance: cov2,
      marketWeights: wm,
      views: [{ pick: [1, 0], view: 0.5, confidence: 1e8 }], // essentially ignored
    });
    expect(r.value.posteriorMean[0]).toBeCloseTo(r.value.priorMean[0]!, 4);
    expect(r.value.posteriorMean[1]).toBeCloseTo(r.value.priorMean[1]!, 4);
  });

  it('a strong bullish view on asset 0 raises its posterior mean and tilts weight toward it', () => {
    const wm = [0.5, 0.5];
    const base = blackLitterman({
      covariance: cov2,
      marketWeights: wm,
      views: [{ pick: [1, 0], view: 0.0001, confidence: 1e8 }],
    });
    const bull = blackLitterman({
      covariance: cov2,
      marketWeights: wm,
      views: [{ pick: [1, 0], view: 0.3, confidence: 1e-4 }], // confident, very bullish on asset 0
      constraints: { longOnly: true },
    });
    expect(bull.value.posteriorMean[0]).toBeGreaterThan(base.value.posteriorMean[0]!);
    expect(bull.value.weights[0]).toBeGreaterThan(0.5);
    expect(sum(bull.value.weights)).toBeCloseTo(1, 6); // fully invested
  });

  it('returns the standard Computed envelope: silent defaults echoed, diagnostics carried (review fix)', () => {
    const r = blackLitterman({
      covariance: cov2,
      marketWeights: [0.6, 0.4],
      views: [{ pick: [1, -1], view: 0.02 }],
    });
    // the previously-silent defaults are now disclosed in assumptions
    expect(r.assumptions.tau).toBe(0.05);
    expect(r.assumptions.riskAversion).toBe(2.5);
    expect(r.assumptions.views).toBe(1);
    expect(r.assumptions.conventionsVersion).toBeDefined();
    // diagnostics live in the envelope, not hoisted onto the value
    expect(r.diagnostics.converged).toBe(true);
    expect(Array.isArray(r.diagnostics.warnings)).toBe(true);
    expect(r.value.weights).toHaveLength(2);
    expect(r.value.posteriorCovariance).toHaveLength(2);
    expect(r.value.priorMean).toHaveLength(2);
  });

  it('echoes an overridden tau/riskAversion and the view count', () => {
    const r = blackLitterman({
      covariance: cov2,
      marketWeights: [0.6, 0.4],
      tau: 0.1,
      riskAversion: 4,
      views: [
        { pick: [1, 0], view: 0.05 },
        { pick: [0, 1], view: 0.02 },
      ],
    });
    expect(r.assumptions.tau).toBe(0.1);
    expect(r.assumptions.riskAversion).toBe(4);
    expect(r.assumptions.views).toBe(2);
  });
});

describe('CVaR optimization (Rockafellar–Uryasev)', () => {
  // Asset A: mild ±1% wobble. Asset B: usually +2% but two catastrophic −30% scenarios.
  const scenarios: number[][] = Array.from({ length: 20 }, (_, i) => {
    const a = i % 2 === 0 ? 0.01 : -0.01;
    const b = i < 2 ? -0.3 : 0.02; // the tail lives entirely in asset B
    return [a, b];
  });

  it('shifts weight away from the fat-tailed asset and lowers CVaR vs equal weight', () => {
    const res = conditionalValueAtRiskOptimize(scenarios, { alpha: 0.9, longOnly: true });
    expect(res.diagnostics.converged).toBe(true);
    expect(sum(res.value.weights)).toBeCloseTo(1, 4);
    expect(res.value.weights[0]!).toBeGreaterThanOrEqual(-1e-6);
    expect(res.value.weights[1]!).toBeGreaterThanOrEqual(-1e-6);
    // the optimizer should underweight the catastrophic asset B
    expect(res.value.weights[1]!).toBeLessThan(0.5);
    // and achieve a CVaR no worse than the equal-weight book
    const cvarEqual = cvarManual(scenarios, [0.5, 0.5], 0.9);
    expect(res.value.conditionalValueAtRisk).toBeLessThanOrEqual(cvarEqual + 1e-6);
  });

  it('respects a long-only box and a minimum-return floor', () => {
    const res = conditionalValueAtRiskOptimize(scenarios, {
      alpha: 0.9,
      longOnly: true,
      minReturn: 0.005,
    });
    const mu = [
      scenarios.reduce((s, r) => s + r[0]!, 0) / scenarios.length,
      scenarios.reduce((s, r) => s + r[1]!, 0) / scenarios.length,
    ];
    expect(mu[0]! * res.value.weights[0]! + mu[1]! * res.value.weights[1]!).toBeGreaterThanOrEqual(
      0.005 - 1e-4,
    );
  });

  it('rejects bad alpha / too-few scenarios', () => {
    expect(() => conditionalValueAtRiskOptimize(scenarios, { alpha: 1.5 })).toThrow(/alpha/);
    expect(() => conditionalValueAtRiskOptimize([[0.1, 0.2]])).toThrow(/≥ 2 scenarios/);
  });

  it('[P3] reaches the true optimum on a DAILY-scale dominated-asset problem (step auto-scaling)', () => {
    // Asset 1 is asset 0 minus 0.5% in EVERY scenario, so the optimum is unambiguously w = [1, 0]
    // long-only. With α = 0.9 and S = 20 the tail is the 2 worst scenarios, so the optimal CVaR is
    // the mean of asset 0's two worst losses: (0.02 + 0.01)/2 = 0.015 exactly.
    const daily: number[][] = Array.from({ length: 20 }, (_, i) => {
      const a = i === 19 ? -0.02 : i === 18 ? -0.01 : 0.01;
      return [a, a - 0.005];
    });
    const res = conditionalValueAtRiskOptimize(daily, { alpha: 0.9, longOnly: true });
    // The default step used to be the constant 1, against a subgradient of ~0.015 on decimal
    // returns: each iterate moved ~1e-2·(1/√t) and the run settled far from [1, 0].
    expect(res.value.weights[0]!).toBeCloseTo(1, 3);
    expect(res.value.weights[1]!).toBeCloseTo(0, 3);
    expect(res.value.conditionalValueAtRisk).toBeCloseTo(0.015, 6);
    expect(res.diagnostics.converged).toBe(true);
    // an explicit `step` still overrides the scaling (the knob is not ignored)
    const crawl = conditionalValueAtRiskOptimize(daily, {
      alpha: 0.9,
      longOnly: true,
      step: 1e-9,
      maximumIterations: 50,
    });
    expect(crawl.value.weights[0]!).toBeLessThan(0.9);
  });

  it('reports max_iterations when cut short of the plateau, converges on a full budget (WS2.7a)', () => {
    // Fewer iterations than the plateau window ⇒ it cannot have settled ⇒ honest max_iterations.
    const short = conditionalValueAtRiskOptimize(scenarios, {
      alpha: 0.9,
      longOnly: true,
      maximumIterations: 5,
    });
    expect(short.diagnostics.converged).toBe(false);
    const notConverged = short.diagnostics.warnings.find(
      (w) => w.code === 'optimize.not_converged',
    );
    expect(notConverged?.context?.['reason']).toBe('max_iterations');
    expect(short.diagnostics.iterations).toBe(5);

    const full = conditionalValueAtRiskOptimize(scenarios, { alpha: 0.9, longOnly: true });
    expect(full.diagnostics.converged).toBe(true);
    expect(full.diagnostics.warnings.some((w) => w.code === 'optimize.not_converged')).toBe(false);
  });
});

describe('constrained Kelly re-solves the log-growth quadratic (WS2.7b)', () => {
  const mean = [0.12, 0.05, 0.03];
  const covariance: number[][] = [
    [0.05, 0.01, 0.0],
    [0.01, 0.03, 0.0],
    [0.0, 0.0, 0.02],
  ];
  // log-growth quadratic approximation μᵀw − ½·wᵀΣw (the objective Kelly maximizes)
  const logGrowth = (w: number[]): number => dot(mean, w) - 0.5 * quadForm(covariance, w);
  const bounds: [number, number][] = [
    [0, 0.4], // binds on the high-mean asset
    [0, 1],
    [0, 1],
  ];

  it('beats a projected unconstrained Kelly on the log-growth objective, respecting the box', () => {
    const constrained = kelly({
      mean,
      covariance,
      options: { bounds, budget: 1 },
    });

    // "projected Kelly": clip the unconstrained growth-optimal weights to the box, renormalize to 1
    const unconstrained = kelly({ mean, covariance }).value.weights; // Σ⁻¹μ
    const clipped = unconstrained.map((w, i) =>
      Math.min(bounds[i]![1], Math.max(bounds[i]![0], w)),
    );
    const s = clipped.reduce((a, b) => a + b, 0);
    const projected = clipped.map((w) => w / s);

    // the re-solved QP is the constrained maximizer, so it is at least as good as any feasible point
    expect(logGrowth(constrained.value.weights)).toBeGreaterThanOrEqual(
      logGrowth(projected) - 1e-9,
    );
    // and it honors the box + budget
    expect(sum(constrained.value.weights)).toBeCloseTo(1, 6);
    constrained.value.weights.forEach((w, i) => {
      expect(w).toBeGreaterThanOrEqual(bounds[i]![0] - 1e-6);
      expect(w).toBeLessThanOrEqual(bounds[i]![1] + 1e-6);
    });
  });

  it('requires a positive fraction under constraints', () => {
    expect(() => kelly({ mean, covariance, options: { bounds, fraction: 0 } })).toThrow(/fraction/);
  });
});

describe('extended constraints', () => {
  const cov3: number[][] = [
    [0.04, 0.002, 0.001],
    [0.002, 0.05, 0.003],
    [0.001, 0.003, 0.06],
  ];

  it('honors a sector/group cap on aggregate weight', () => {
    const r = minVariance(cov3, { longOnly: true, groups: [{ members: [0, 1], max: 0.5 }] });
    expect(r.value.weights[0]! + r.value.weights[1]!).toBeLessThanOrEqual(0.5 + 1e-4);
    expect(sum(r.value.weights)).toBeCloseTo(1, 4);
  });

  it('honors a turnover budget against a base portfolio', () => {
    const prev = [1, 0, 0];
    const r = minVariance(cov3, { longOnly: true, turnover: { previousWeights: prev, max: 0.4 } });
    const turn = r.value.weights.reduce((s, w, i) => s + Math.abs(w - prev[i]!), 0);
    expect(turn).toBeLessThanOrEqual(0.4 + 1e-3);
    expect(sum(r.value.weights)).toBeCloseTo(1, 4);
  });

  it('transaction costs pull the solution toward the base portfolio (less turnover)', () => {
    const mu = [0.03, 0.05, 0.02];
    const prev = [0, 1, 0];
    const noCost = meanVariance({
      mean: mu,
      covariance: cov3,
      options: { longOnly: true, riskAversion: 3 },
    });
    const withCost = meanVariance({
      mean: mu,
      covariance: cov3,
      options: {
        longOnly: true,
        riskAversion: 3,
        transactionCosts: { perUnitTurnover: 0.05, previousWeights: prev },
      },
    });
    const turnNo = noCost.value.weights.reduce((s, w, i) => s + Math.abs(w - prev[i]!), 0);
    const turnCost = withCost.value.weights.reduce((s, w, i) => s + Math.abs(w - prev[i]!), 0);
    expect(turnCost).toBeLessThanOrEqual(turnNo + 1e-9);
    expect(sum(withCost.value.weights)).toBeCloseTo(1, 4);
  });

  it('rejects an infeasible group specification (min > max)', () => {
    expect(() => minVariance(cov3, { groups: [{ members: [0], min: 0.8, max: 0.2 }] })).toThrow(
      /min/,
    );
  });
});

/** Reference empirical CVaR for the test assertions. */
function cvarManual(scenarios: number[][], w: number[], alpha: number): number {
  const losses = scenarios.map((r) => -(r[0]! * w[0]! + r[1]! * w[1]!)).sort((a, b) => b - a);
  const k = Math.max(1, Math.ceil((1 - alpha) * scenarios.length));
  return losses.slice(0, k).reduce((s, l) => s + l, 0) / k;
}
