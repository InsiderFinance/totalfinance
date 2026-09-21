/**
 * FC7 slice 4 (Stage 4.4) — `efficientFrontier`: the constrained mean-variance frontier traced by
 * composing `minVariance` / `meanVariance` / `maxSharpe`.
 *
 * The analytic fixture: two UNCORRELATED assets, σ₁² = 0.04, σ₂² = 0.01, μ = [0.10, 0.05], budget
 * only (Σw = 1). With two assets the budget pins the whole frontier: for a target μ*,
 *   w₁ = (μ* − 0.05) / 0.05,  w₂ = 1 − w₁,  variance = w₁²·0.04 + w₂²·0.01.
 * The minimum-variance portfolio has w₁ = σ₂² / (σ₁² + σ₂²) = 0.01 / 0.05 = 0.2, return 0.06 and
 * variance 0.04·0.04 + 0.64·0.01 = 0.0016 + 0.0064 = 0.008. Long-only caps the return at 0.10
 * (all in asset 1). Every expected number below is derived in a comment.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError } from '@totalfinance/core';
import { efficientFrontier, meanVariance, minVariance } from '@totalfinance/risk';
import { efficientFrontier as fromOptimizeSubpath } from '@totalfinance/risk/optimize';

/** Capture the thrown value (the guards must throw typed QuantErrors, never return). */
function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const MEAN = [0.1, 0.05];
const COVARIANCE = [
  [0.04, 0],
  [0, 0.01],
];

/** The analytic two-asset frontier point for a target return. */
function analytic(target: number): { weights: number[]; variance: number } {
  const w1 = (target - 0.05) / 0.05;
  const w2 = 1 - w1;
  return { weights: [w1, w2], variance: w1 * w1 * 0.04 + w2 * w2 * 0.01 };
}

describe('efficientFrontier — target-return points on the analytic two-asset frontier', () => {
  const r = efficientFrontier({
    mean: MEAN,
    covariance: COVARIANCE,
    grid: { kind: 'target-return', values: [0.07, 0.08, 0.09] },
  });

  it('every target is hit to 1e-8 and the weights match the analytic frontier to 1e-6', () => {
    expect(r.value.points).toHaveLength(3);
    expect(r.value.solvedCount).toBe(3);
    expect(r.value.failedCount).toBe(0);
    for (const [i, target] of [0.07, 0.08, 0.09].entries()) {
      const point = r.value.points[i]!;
      const expected = analytic(target);
      expect(point.index).toBe(i);
      expect(point.requested).toEqual({ targetReturn: target });
      expect(point.feasible).toBe(true);
      expect(point.converged).toBe(true);
      expect(point.reason).toBeUndefined();
      expect(Math.abs(point.expectedReturn! - target)).toBeLessThan(1e-8);
      // 0.07 ⇒ w₁ = 0.4, variance 0.16·0.04 + 0.36·0.01 = 0.0064 + 0.0036 = 0.0100
      // 0.08 ⇒ w₁ = 0.6, variance 0.36·0.04 + 0.16·0.01 = 0.0144 + 0.0016 = 0.0160
      // 0.09 ⇒ w₁ = 0.8, variance 0.64·0.04 + 0.04·0.01 = 0.0256 + 0.0004 = 0.0260
      expect(Math.abs(point.weights![0]! - expected.weights[0]!)).toBeLessThan(1e-6);
      expect(Math.abs(point.weights![1]! - expected.weights[1]!)).toBeLessThan(1e-6);
      expect(point.variance).toBeCloseTo(expected.variance, 7);
      expect(point.volatility).toBeCloseTo(Math.sqrt(expected.variance), 7);
      // No risk-free rate ⇒ no Sharpe ratio.
      expect(point.sharpeRatio).toBeNull();
      expect(point.warnings).toEqual([]);
    }
    expect(r.value.points[1]!.variance).toBeCloseTo(0.016, 7);
  });

  it('the left endpoint is the minimum-variance portfolio: w₁ = 0.2, return 0.06, variance 0.008', () => {
    const mv = r.value.minimumVariance;
    expect(mv.weights![0]).toBeCloseTo(0.2, 8);
    expect(mv.weights![1]).toBeCloseTo(0.8, 8);
    expect(mv.expectedReturn).toBeCloseTo(0.06, 10);
    expect(mv.variance).toBeCloseTo(0.008, 10);
    expect(mv.converged).toBe(true);
    expect(mv.feasible).toBe(true);
    // Identical to calling minVariance directly under the same (empty) constraint set.
    const direct = minVariance(COVARIANCE).value.weights;
    expect(mv.weights![0]).toBe(direct[0]);
    expect(mv.weights![1]).toBe(direct[1]);
  });

  it('budget-only is unbounded above: the range reports null and the diagnostic says so', () => {
    expect(r.diagnostics.maximumReturnBounded).toBe(false);
    expect(r.value.expectedReturnRange.minimum).toBeCloseTo(0.06, 10);
    expect(r.value.expectedReturnRange.maximum).toBeNull();
    expect(r.value.tangency).toBeUndefined();
  });

  it('is monotone, converged, and carries the one-envelope grammar', () => {
    expect(r.diagnostics.monotone).toBe(true);
    expect(r.diagnostics.converged).toBe(true);
    expect(r.diagnostics.solvedCount).toBe(3);
    expect(r.diagnostics.failedCount).toBe(0);
    expect(r.diagnostics.warnings).toEqual([]);
    expect(r.diagnostics.iterations).toBeGreaterThanOrEqual(0);
    expect(r.assumptions.conventionsVersion).toEqual(expect.any(String));
    expect(r.assumptions.objective).toBe('mean-variance');
    expect(r.assumptions.budget).toBe(1);
    expect(r.assumptions.grid).toEqual({ kind: 'target-return', count: 3 });
    expect(r.assumptions.riskFreeRatePerPeriod).toBeUndefined();
    expect(typeof r.assumptions.constraintSummary).toBe('string');
    expect(r.assumptions.constraintSummary).toContain('budget 1');
    expect(r.assumptions.constraintSummary).toContain('unbounded');
  });

  it('a target below the minimum-variance return is a failed point naming the range; the rest still solve', () => {
    const below = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'target-return', values: [0.05, 0.08] },
    });
    const [failed, solved] = below.value.points;
    expect(failed!.feasible).toBe(false);
    expect(failed!.converged).toBe(false);
    expect(failed!.weights).toBeNull();
    expect(failed!.expectedReturn).toBeNull();
    expect(failed!.reason).toContain('0.06');
    expect(failed!.reason).toContain('unbounded');
    expect(solved!.feasible).toBe(true);
    expect(Math.abs(solved!.expectedReturn! - 0.08)).toBeLessThan(1e-8);
    expect(below.value.failedCount).toBe(1);
    expect(below.value.solvedCount).toBe(1);
    // Aggregate convergence is false when ANY requested point failed, even if every returned
    // portfolio converged. The old `solved.every(...)` spelling hid this failed request.
    expect(below.diagnostics.converged).toBe(false);
    expect(below.diagnostics.warnings.map((w) => w.code)).toEqual(['risk.frontier_points_failed']);
  });
});

describe('efficientFrontier — points grid under long-only spans [minimum-variance, maximum]', () => {
  const r = efficientFrontier({
    mean: MEAN,
    covariance: COVARIANCE,
    grid: { kind: 'points', count: 5 },
    constraints: { longOnly: true },
  });

  it('five targets evenly spaced from 0.06 to 0.10 (all in asset 1), each on the analytic frontier', () => {
    // Long-only leaves the unconstrained minimum-variance point (w = [0.2, 0.8] ≥ 0) untouched, so
    // the range is [0.06, 0.10] and the targets are 0.06, 0.07, 0.08, 0.09, 0.10.
    expect(r.diagnostics.maximumReturnBounded).toBe(true);
    expect(r.value.expectedReturnRange.minimum).toBeCloseTo(0.06, 10);
    expect(r.value.expectedReturnRange.maximum).toBeCloseTo(0.1, 8);
    expect(r.value.points).toHaveLength(5);
    expect(r.value.solvedCount).toBe(5);
    expect(r.value.failedCount).toBe(0);
    const targets = [0.06, 0.07, 0.08, 0.09, 0.1];
    for (const [i, target] of targets.entries()) {
      const point = r.value.points[i]!;
      expect(point.requested.targetReturn).toBeCloseTo(target, 8);
      expect(point.feasible).toBe(true);
      expect(point.converged).toBe(true);
      expect(Math.abs(point.expectedReturn! - target)).toBeLessThan(1e-8);
      const expected = analytic(target);
      expect(Math.abs(point.weights![0]! - expected.weights[0]!)).toBeLessThan(1e-6);
      expect(Math.abs(point.weights![1]! - expected.weights[1]!)).toBeLessThan(1e-6);
      expect(point.variance).toBeCloseTo(expected.variance, 7);
      // Long-only is honored on every point.
      expect(point.weights![0]).toBeGreaterThanOrEqual(-1e-9);
      expect(point.weights![1]).toBeGreaterThanOrEqual(-1e-9);
    }
    // The endpoints ARE the endpoint solves: first = minimum-variance, last = all in asset 1.
    expect(r.value.points[0]!.weights![0]).toBeCloseTo(0.2, 8);
    expect(r.value.points[4]!.weights![0]).toBeCloseTo(1, 8);
    expect(r.value.points[4]!.weights![1]).toBeCloseTo(0, 8);
    expect(r.value.points[4]!.variance).toBeCloseTo(0.04, 8);
  });

  it('is monotone and converged with a long-only constraint summary', () => {
    expect(r.diagnostics.monotone).toBe(true);
    expect(r.diagnostics.converged).toBe(true);
    expect(r.diagnostics.warnings).toEqual([]);
    expect(r.assumptions.grid).toEqual({ kind: 'points', count: 5 });
    expect(r.assumptions.constraintSummary).toContain('long-only');
  });

  it('an infeasible target (0.5 under long-only) fails with the achievable range in its reason; the others solve', () => {
    const mixed = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'target-return', values: [0.07, 0.5, 0.09] },
      constraints: { longOnly: true },
    });
    expect(mixed.value.points).toHaveLength(3);
    const failed = mixed.value.points[1]!;
    expect(failed.feasible).toBe(false);
    expect(failed.converged).toBe(false);
    expect(failed.weights).toBeNull();
    expect(failed.requested).toEqual({ targetReturn: 0.5 });
    expect(failed.reason).toContain('0.5');
    expect(failed.reason).toContain('0.06');
    expect(failed.reason).toMatch(/0\.1\b|0\.0999999/);
    for (const i of [0, 2]) {
      expect(mixed.value.points[i]!.feasible).toBe(true);
      expect(mixed.value.points[i]!.converged).toBe(true);
    }
    expect(mixed.value.failedCount).toBe(1);
    expect(mixed.value.solvedCount).toBe(2);
    expect(mixed.diagnostics.failedCount).toBe(1);
    expect(mixed.diagnostics.warnings.map((w) => w.code)).toEqual(['risk.frontier_points_failed']);
    expect(mixed.diagnostics.warnings[0]!.context?.['failedIndices']).toEqual([1]);
  });

  it('the maximum-return endpoint is exactly the long-only vertex when the target equals the range top', () => {
    const top = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'target-return', values: [0.1] },
      constraints: { longOnly: true },
    });
    const point = top.value.points[0]!;
    expect(point.feasible).toBe(true);
    expect(point.weights![0]).toBeCloseTo(1, 8);
    expect(point.expectedReturn).toBeCloseTo(0.1, 8);
  });
});

describe('efficientFrontier — risk-free rate: Sharpe per point and the tangency portfolio', () => {
  const r = efficientFrontier({
    mean: MEAN,
    covariance: COVARIANCE,
    grid: { kind: 'target-return', values: [0.07, 0.08, 0.09] },
    riskFreeRatePerPeriod: 0.02,
  });

  it('each point reports (return − 0.02) / volatility', () => {
    // 0.08: variance 0.016 ⇒ Sharpe = 0.06 / √0.016.
    const middle = r.value.points[1]!;
    expect(middle.sharpeRatio).toBeCloseTo(0.06 / Math.sqrt(0.016), 7);
    for (const point of r.value.points) {
      expect(point.sharpeRatio).toBeCloseTo((point.expectedReturn! - 0.02) / point.volatility!, 12);
    }
    expect(r.assumptions.riskFreeRatePerPeriod).toBe(0.02);
  });

  it('the tangency portfolio is Σ⁻¹(μ − rf) normalized: [0.4, 0.6], return 0.07, Sharpe 0.5', () => {
    // Σ⁻¹(μ − rf) = [0.08 / 0.04, 0.03 / 0.01] = [2, 3] ⇒ w = [0.4, 0.6];
    // return = 0.04 + 0.03 = 0.07; variance = 0.16·0.04 + 0.36·0.01 = 0.0064 + 0.0036 = 0.01;
    // Sharpe = (0.07 − 0.02) / 0.1 = 0.5.
    const tangency = r.value.tangency!;
    expect(tangency.weights![0]).toBeCloseTo(0.4, 8);
    expect(tangency.weights![1]).toBeCloseTo(0.6, 8);
    expect(tangency.expectedReturn).toBeCloseTo(0.07, 10);
    expect(tangency.variance).toBeCloseTo(0.01, 10);
    expect(tangency.sharpeRatio).toBeCloseTo(0.5, 10);
    expect(tangency.converged).toBe(true);
    expect(tangency.feasible).toBe(true);
    // No frontier point beats the tangency Sharpe.
    for (const point of r.value.points) {
      expect(point.sharpeRatio!).toBeLessThanOrEqual(tangency.sharpeRatio! + 1e-9);
    }
    // The tangency point sits ON the frontier: the 0.07 target has the same weights.
    expect(Math.abs(r.value.points[0]!.weights![0]! - 0.4)).toBeLessThan(1e-6);
  });

  it('minimum-variance Sharpe is (0.06 − 0.02) / √0.008 and the sweep stays monotone', () => {
    expect(r.value.minimumVariance.sharpeRatio).toBeCloseTo(0.04 / Math.sqrt(0.008), 8);
    expect(r.diagnostics.monotone).toBe(true);
  });

  it('a non-finite rate refuses typed', () => {
    const caught = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
        riskFreeRatePerPeriod: NaN,
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputNotFinite)).toBe(true);
  });
});

describe('efficientFrontier — risk-aversion grid composes meanVariance point by point', () => {
  it('λ ∈ {1, 2, 4} gives w₁ = 0.2 + 1/λ on the budget-only problem', () => {
    // Closed form: w = Σ⁻¹μ/λ + γ·Σ⁻¹1 with Σ⁻¹μ = [2.5, 5], Σ⁻¹1 = [25, 100], 1ᵀΣ⁻¹1 = 125,
    // γ = (1 − 7.5/λ) / 125 ⇒ w₁ = 2.5/λ + 25·γ = 2.5/λ + 0.2 − 1.5/λ = 0.2 + 1/λ.
    // λ = 1 ⇒ w₁ = 1.2 (return 0.11); λ = 2 ⇒ 0.7 (0.085); λ = 4 ⇒ 0.45 (0.0725).
    const r = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'risk-aversion', values: [1, 2, 4] },
    });
    const expectedW1 = [1.2, 0.7, 0.45];
    const expectedReturn = [0.11, 0.085, 0.0725];
    for (const [i, riskAversion] of [1, 2, 4].entries()) {
      const point = r.value.points[i]!;
      expect(point.requested).toEqual({ riskAversion });
      expect(point.weights![0]).toBeCloseTo(expectedW1[i]!, 10);
      expect(point.expectedReturn).toBeCloseTo(expectedReturn[i]!, 10);
      expect(point.converged).toBe(true);
      expect(point.feasible).toBe(true);
      // Bit-identical to the facade it composes.
      const direct = meanVariance({
        mean: MEAN,
        covariance: COVARIANCE,
        options: { riskAversion },
      }).value.weights;
      expect(point.weights![0]).toBe(direct[0]);
      expect(point.weights![1]).toBe(direct[1]);
    }
    // Returns fall with λ; volatility rises with return ⇒ monotone.
    expect(r.diagnostics.monotone).toBe(true);
    expect(r.assumptions.grid).toEqual({ kind: 'risk-aversion', count: 3 });
  });

  it('a non-positive or non-finite risk aversion refuses typed', () => {
    const zero = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'risk-aversion', values: [1, 0] },
      }),
    );
    expect(isQuantError(zero, ErrorCode.InputOutOfRange)).toBe(true);
    const nan = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'risk-aversion', values: [NaN] },
      }),
    );
    expect(isQuantError(nan, ErrorCode.InputNotFinite)).toBe(true);
  });

  it('invalid grid kinds remain serializable without executing caller hooks', () => {
    let calls = 0;
    const hostile = {
      toJSON(): never {
        calls += 1;
        throw new Error('toJSON must not execute');
      },
      [Symbol.toPrimitive](): never {
        calls += 1;
        throw new Error('Symbol.toPrimitive must not execute');
      },
    };
    const caught = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: hostile } as never,
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputInvalidEnum)).toBe(true);
    expect(() => JSON.stringify(caught)).not.toThrow();
    expect(calls).toBe(0);
  });
});

describe('efficientFrontier — boundedness normalization', () => {
  it('refuses when very large, finite expected returns overflow a composed solve', () => {
    const caught = catching(() =>
      efficientFrontier({
        mean: [Number.MAX_VALUE, Number.MAX_VALUE / 2],
        covariance: COVARIANCE,
        grid: { kind: 'risk-aversion', values: [1] },
        constraints: { longOnly: true },
      }),
    );

    expect(isQuantError(caught, ErrorCode.InputOutOfRange)).toBe(true);
    expect(String((caught as Error).message)).toContain('not representable');
  });

  it('finds the same exact endpoint when covariance is quoted at a huge scale', () => {
    const result = efficientFrontier({
      mean: MEAN,
      covariance: [
        [4e10, 0],
        [0, 1e10],
      ],
      grid: { kind: 'points', count: 3 },
      constraints: { longOnly: true },
    });

    expect(result.diagnostics.maximumReturnBounded).toBe(true);
    expect(result.value.expectedReturnRange.maximum).toBeCloseTo(0.1, 10);
    expect(result.value.points.at(-1)?.expectedReturn).toBeCloseTo(0.1, 10);
    expect(result.value.points[1]?.expectedReturn).toBeCloseTo(0.08, 8);
    expect(result.value.points.every((point) => point.converged)).toBe(true);
  });
});

describe('efficientFrontier — unbounded points grid falls back to a λ grid, never throws', () => {
  it('budget-only with a points grid: warning, maximumReturnBounded false, λ-requested points', () => {
    const r = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'points', count: 4 },
    });
    expect(r.diagnostics.maximumReturnBounded).toBe(false);
    expect(r.diagnostics.warnings.map((w) => w.code)).toEqual(['risk.frontier_unbounded_return']);
    expect(r.value.points).toHaveLength(4);
    expect(r.value.solvedCount).toBe(4);
    // Descending λ over [1e-2, 1e2] ⇒ expected return rises left to right.
    const lambdas = r.value.points.map((p) => p.requested.riskAversion!);
    expect(lambdas[0]).toBeCloseTo(100, 10);
    expect(lambdas[3]).toBeCloseTo(0.01, 10);
    for (let i = 1; i < 4; i++) {
      expect(r.value.points[i]!.expectedReturn!).toBeGreaterThan(
        r.value.points[i - 1]!.expectedReturn!,
      );
    }
    expect(r.assumptions.grid).toEqual({ kind: 'risk-aversion', count: 4 });
    expect(r.diagnostics.monotone).toBe(true);
  });

  it('a turnover budget bounds the range even without a box', () => {
    const r = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'points', count: 3 },
      constraints: { turnover: { previousWeights: [0.5, 0.5], max: 0.4 } },
    });
    expect(r.diagnostics.maximumReturnBounded).toBe(true);
    expect(r.value.expectedReturnRange.maximum).not.toBeNull();
    // Σ|w − 0.5| ≤ 0.4 with Σw = 1 ⇒ w₁ ≤ 0.7 ⇒ maximum return 0.05 + 0.05·0.7 = 0.085.
    expect(r.value.expectedReturnRange.maximum).toBeCloseTo(0.085, 6);
  });

  it('singleton group limits bound the return exactly like per-asset bounds', () => {
    const r = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'points', count: 3 },
      constraints: {
        groups: [
          { members: [0], min: 0, max: 1 },
          { members: [1], min: 0, max: 1 },
        ],
      },
    });
    expect(r.diagnostics.maximumReturnBounded).toBe(true);
    expect(r.value.expectedReturnRange.maximum).toBeCloseTo(0.1, 8);
    expect(r.assumptions.grid.kind).toBe('points');
    expect(r.value.points.every((point) => point.feasible && point.converged)).toBe(true);
  });

  it('keeps a points grid for common long-only aggregate sector caps', () => {
    const r = efficientFrontier({
      mean: [0.1, 0.08, 0.02],
      covariance: [
        [0.04, 0, 0],
        [0, 0.03, 0],
        [0, 0, 0.02],
      ],
      grid: { kind: 'points', count: 3 },
      constraints: { longOnly: true, groups: [{ members: [0, 1], max: 0.7 }] },
    });

    // The sector can hold 0.7, all assigned to its higher-return member; asset 2 holds 0.3.
    expect(r.diagnostics.maximumReturnBounded).toBe(true);
    expect(r.value.expectedReturnRange.maximum).toBeCloseTo(0.076, 9);
    expect(r.assumptions.grid.kind).toBe('points');
    expect(r.value.points.every((point) => point.feasible && point.converged)).toBe(true);
  });

  it('solves overlapping group caps as one linear endpoint, not independent guesses', () => {
    const r = efficientFrontier({
      mean: [0.1, 0.09, 0.08],
      covariance: [
        [0.04, 0, 0],
        [0, 0.03, 0],
        [0, 0, 0.02],
      ],
      grid: { kind: 'points', count: 2 },
      constraints: {
        longOnly: true,
        groups: [
          { members: [0, 1], max: 0.6 },
          { members: [0, 2], max: 0.7 },
        ],
      },
    });

    // Both caps bind at w = [0.3, 0.3, 0.4], return 0.089.
    expect(r.value.expectedReturnRange.maximum).toBeCloseTo(0.089, 9);
    const weights = r.value.points.at(-1)?.weights;
    expect(weights?.[0]).toBeCloseTo(0.3, 9);
    expect(weights?.[1]).toBeCloseTo(0.3, 9);
    expect(weights?.[2]).toBeCloseTo(0.4, 9);
  });

  it('certifies a turnover endpoint when the base itself is off budget', () => {
    const r = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'points', count: 3 },
      constraints: { turnover: { previousWeights: [0.4, 0.4], max: 0.4 } },
    });

    expect(r.diagnostics.maximumReturnBounded).toBe(true);
    // Correcting the base's 0.2 budget shortfall consumes 0.2 turnover; the remaining 0.2 moves
    // 0.1 from asset 2 to asset 1, so w = [0.7, 0.3] and return = 0.085.
    expect(r.value.expectedReturnRange.maximum).toBeCloseTo(0.085, 9);
    expect(r.assumptions.grid.kind).toBe('points');
  });

  it('reports aggregate-group boundedness as unknown rather than guessing unbounded', () => {
    const r = efficientFrontier({
      mean: [0.1, 0.05, 0.02],
      covariance: [
        [0.04, 0, 0],
        [0, 0.03, 0],
        [0, 0, 0.02],
      ],
      grid: { kind: 'points', count: 3 },
      constraints: {
        groups: [
          { members: [0, 1], min: 0, max: 1 },
          { members: [0, 2], min: 0, max: 1 },
          { members: [1, 2], min: 0, max: 1 },
        ],
      },
    });

    expect(r.diagnostics.maximumReturnBounded).toBeNull();
    expect(r.value.expectedReturnRange.maximum).toBeNull();
    expect(r.assumptions.grid.kind).toBe('risk-aversion');
    expect(r.diagnostics.warnings.map((item) => item.code)).toContain(
      'risk.frontier_return_range_unknown',
    );
  });
});

describe('efficientFrontier — count safety (a count is a work budget, never a hang)', () => {
  it('refuses 2^32, 2^53 + 2, 1e308, −5, 2.5, 1 with a typed out-of-range teaching naming count', () => {
    for (const bad of [2 ** 32, 2 ** 53 + 2, 1e308, -5, 2.5, 1, 0, NaN, Infinity]) {
      const caught = catching(() =>
        efficientFrontier({
          mean: MEAN,
          covariance: COVARIANCE,
          grid: { kind: 'points', count: bad },
        }),
      );
      expect(isQuantError(caught, ErrorCode.InputOutOfRange), `count ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('count');
    }
  });

  it('the refusal just above the cap teaches the bound, and the cap itself is the grammar', () => {
    const caught = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 10_001 },
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputOutOfRange)).toBe(true);
    expect(String((caught as Error).message)).toContain('10,000');
    const tooMany = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'risk-aversion', values: new Array<number>(10_001).fill(1) },
      }),
    );
    expect(isQuantError(tooMany, ErrorCode.InputOutOfRange)).toBe(true);
  });

  it('count 2 is the smallest grid: exactly the two endpoints', () => {
    const r = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'points', count: 2 },
      constraints: { longOnly: true },
    });
    expect(r.value.points).toHaveLength(2);
    expect(r.value.points[0]!.expectedReturn).toBeCloseTo(0.06, 10);
    expect(r.value.points[1]!.expectedReturn).toBeCloseTo(0.1, 8);
  });

  it('does not charge a two-endpoint grid for interior bisections that never run', () => {
    const result = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'points', count: 2 },
      constraints: { longOnly: true, maximumIterations: 1_000_000 },
    });
    expect(result.value.points).toHaveLength(2);
  });

  it('refuses the combined interior bisection × per-solve iteration budget before the sweep', () => {
    const caught = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 4 },
        constraints: { longOnly: true, maximumIterations: 1_000_000 },
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputOutOfRange)).toBe(true);
    expect(String((caught as Error).message)).toContain('aggregate budget');
    expect(String((caught as Error).message)).toContain('maximumIterations');
  });

  it('allows a representative two-endpoint sector request but refuses costly interior sweeps', () => {
    const assets = 20;
    const covariance = Array.from({ length: assets }, (_, row) =>
      Array.from({ length: assets }, (_, column) => (row === column ? 0.04 : 0)),
    );
    const input = {
      mean: Array.from({ length: assets }, (_, index) => 0.05 + index / 1_000),
      covariance,
      constraints: {
        longOnly: true,
        groups: [{ members: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], max: 0.5 }],
      },
    };
    const endpoints = efficientFrontier({ ...input, grid: { kind: 'points', count: 2 } });
    expect(endpoints.value.points).toHaveLength(2);

    const caught = catching(() =>
      efficientFrontier({ ...input, grid: { kind: 'points', count: 4 } }),
    );
    expect(isQuantError(caught, ErrorCode.InputOutOfRange)).toBe(true);
    expect(String((caught as Error).message)).toContain('Dykstra');
    expect(String((caught as Error).message)).toContain('asset dimension');
  });
});

describe('efficientFrontier — refusals at the boundary (Law 12 and shape)', () => {
  it('rejects transaction costs because they do not define one coherent gross frontier', () => {
    const caught = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
        constraints: {
          longOnly: true,
          transactionCosts: { perUnitTurnover: 0.001, previousWeights: [0.5, 0.5] },
        },
      } as never),
    );
    expect(isQuantError(caught, ErrorCode.InputOutOfRange)).toBe(true);
    expect(String((caught as Error).message)).toContain('meanVariance directly');
    expect(String((caught as Error).message)).toContain('coherent frontier');
  });

  it('grid is required and its kind must be one of the three', () => {
    const missing = catching(() =>
      efficientFrontier({ mean: MEAN, covariance: COVARIANCE } as never),
    );
    expect(isQuantError(missing, ErrorCode.InputMissingField)).toBe(true);
    const unknownKind = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'lambda', values: [1] },
      } as never),
    );
    expect(isQuantError(unknownKind, ErrorCode.InputInvalidEnum)).toBe(true);
    expect(String((unknownKind as Error).message)).toContain("'risk-aversion'");
    const noKind = catching(() =>
      efficientFrontier({ mean: MEAN, covariance: COVARIANCE, grid: { count: 3 } } as never),
    );
    expect(isQuantError(noKind, ErrorCode.InputMissingField)).toBe(true);
    const noValues = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'target-return' },
      } as never),
    );
    expect(isQuantError(noValues, ErrorCode.InputMissingField)).toBe(true);
    const emptyValues = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'target-return', values: [] },
      }),
    );
    expect(isQuantError(emptyValues, ErrorCode.InputWrongShape)).toBe(true);
  });

  it('unknown keys refuse at every object level: input, grid, constraints', () => {
    const input = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
        riskFreeRate: 0.02,
      } as never),
    );
    expect(isQuantError(input, ErrorCode.InputUnknownField)).toBe(true);
    // `riskFreeRate` is too far from `riskFreeRatePerPeriod` for the edit-distance suggestion, so
    // the teaching is the allowed-field list — which names the per-period spelling.
    expect(String((input as Error).message)).toContain('unknown field "riskFreeRate"');
    expect(String((input as Error).message)).toContain('riskFreeRatePerPeriod');
    expect((input as { context?: Record<string, unknown> }).context?.['key']).toBe('riskFreeRate');
    const grid = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3, values: [1] },
      } as never),
    );
    expect(isQuantError(grid, ErrorCode.InputUnknownField)).toBe(true);
    const constraints = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
        constraints: { longonly: true },
      } as never),
    );
    expect(isQuantError(constraints, ErrorCode.InputUnknownField)).toBe(true);
    expect(String((constraints as Error).message)).toContain('did you mean "longOnly"');
  });

  it('constraint-grammar refusals surface under the frontier name with the optimizer code preserved', () => {
    const caught = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
        constraints: { bounds: [[0, 1]] },
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputOutOfRange)).toBe(true);
    expect(String((caught as Error).message)).toMatch(/^efficientFrontier: /);
    expect(String((caught as Error).message)).toContain('bounds length');
    const nullConstraints = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
        constraints: null,
      } as never),
    );
    expect(isQuantError(nullConstraints, ErrorCode.InputWrongType)).toBe(true);
  });

  it('mean / covariance shape and finiteness refuse typed', () => {
    const shortMean = catching(() =>
      efficientFrontier({
        mean: [0.1],
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
      }),
    );
    expect(isQuantError(shortMean, ErrorCode.InputOutOfRange)).toBe(true);
    const nanMean = catching(() =>
      efficientFrontier({
        mean: [0.1, NaN],
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
      }),
    );
    expect(isQuantError(nanMean, ErrorCode.InputNotFinite)).toBe(true);
    const numericString = catching(() =>
      efficientFrontier({
        mean: ['0.1', 0.05] as never,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
      }),
    );
    expect(isQuantError(numericString, ErrorCode.InputWrongType)).toBe(true);
    let valueOfCalled = false;
    const coercionTrap = {
      valueOf(): number {
        valueOfCalled = true;
        throw new Error('must not execute caller coercion');
      },
    };
    const objectMean = catching(() =>
      efficientFrontier({
        mean: [coercionTrap, 0.05] as never,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
      }),
    );
    expect(isQuantError(objectMean, ErrorCode.InputWrongType)).toBe(true);
    expect(valueOfCalled).toBe(false);
    let getterCalled = false;
    const accessorMean = [0.1, 0.05];
    Object.defineProperty(accessorMean, '0', {
      enumerable: true,
      get(): never {
        getterCalled = true;
        throw new Error('must not execute caller accessor');
      },
    });
    const accessor = catching(() =>
      efficientFrontier({
        mean: accessorMean,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 3 },
      }),
    );
    expect(isQuantError(accessor, ErrorCode.InputWrongShape)).toBe(true);
    expect(getterCalled).toBe(false);
    expect(
      efficientFrontier({
        mean: new Float64Array(MEAN),
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 2 },
        constraints: { longOnly: true },
      }).value.points,
    ).toHaveLength(2);
    expect(
      efficientFrontier({
        mean: { 0: MEAN[0]!, 1: MEAN[1]!, length: 2 },
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 2 },
        constraints: { longOnly: true },
      }).value.points,
    ).toHaveLength(2);

    let typedLengthGetterCalled = false;
    const typedMean = new Float64Array(MEAN);
    Object.defineProperty(typedMean, 'length', {
      configurable: true,
      get(): never {
        typedLengthGetterCalled = true;
        throw new Error('must not execute typed-array length accessor');
      },
    });
    expect(
      efficientFrontier({
        mean: typedMean,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 2 },
        constraints: { longOnly: true },
      }).value.points,
    ).toHaveLength(2);
    expect(typedLengthGetterCalled).toBe(false);

    let recordIndexGetterCalled = false;
    const recordMean = { 1: MEAN[1]!, length: 2 } as unknown as ArrayLike<number>;
    Object.defineProperty(recordMean, '0', {
      enumerable: true,
      get(): never {
        recordIndexGetterCalled = true;
        throw new Error('must not execute record index accessor');
      },
    });
    const accessorRecord = catching(() =>
      efficientFrontier({
        mean: recordMean,
        covariance: COVARIANCE,
        grid: { kind: 'points', count: 2 },
      }),
    );
    expect(isQuantError(accessorRecord, ErrorCode.InputWrongShape)).toBe(true);
    expect(recordIndexGetterCalled).toBe(false);
    const ragged = catching(() =>
      efficientFrontier({
        mean: MEAN,
        covariance: [[0.04, 0], [0]],
        grid: { kind: 'points', count: 3 },
      }),
    );
    expect(isQuantError(ragged, ErrorCode.InputOutOfRange)).toBe(true);
    const empty = catching(() =>
      efficientFrontier({ mean: [], covariance: [], grid: { kind: 'points', count: 3 } }),
    );
    expect(isQuantError(empty, ErrorCode.InputWrongShape)).toBe(true);
  });

  it('rejects hostile grid and rate values without invoking coercion or toJSON', () => {
    let calls = 0;
    const hostile = {
      toJSON(): never {
        calls += 1;
        throw new Error('must not execute toJSON');
      },
      [Symbol.toPrimitive](): never {
        calls += 1;
        throw new Error('must not execute Symbol.toPrimitive');
      },
    };
    for (const run of [
      () =>
        efficientFrontier({
          mean: MEAN,
          covariance: COVARIANCE,
          grid: { kind: 'points', count: hostile },
        } as never),
      () =>
        efficientFrontier({
          mean: MEAN,
          covariance: COVARIANCE,
          grid: { kind: 'target-return', values: [hostile] },
        } as never),
      () =>
        efficientFrontier({
          mean: MEAN,
          covariance: COVARIANCE,
          grid: { kind: 'points', count: 2 },
          riskFreeRatePerPeriod: hostile,
        } as never),
    ]) {
      expect(isQuantError(catching(run))).toBe(true);
    }
    expect(calls).toBe(0);
  });

  it('null / non-object inputs refuse typed, never a raw TypeError', () => {
    for (const garbage of [null, undefined, 42, 'frontier', [MEAN]]) {
      const caught = catching(() => efficientFrontier(garbage as never));
      expect(isQuantError(caught, ErrorCode.InputWrongType), String(garbage)).toBe(true);
    }
  });

  it('an empty box (bounds that cannot sum to the budget) fails every point, never throws', () => {
    const r = efficientFrontier({
      mean: MEAN,
      covariance: COVARIANCE,
      grid: { kind: 'target-return', values: [0.07] },
      constraints: {
        bounds: [
          [0, 0.4],
          [0, 0.4],
        ],
      },
    });
    expect(r.value.minimumVariance.feasible).toBe(false);
    expect(r.value.minimumVariance.converged).toBe(false);
    expect(r.value.points[0]!.feasible).toBe(false);
    expect(r.value.points[0]!.weights).toBeNull();
    expect(r.value.failedCount).toBe(1);
    expect(r.diagnostics.converged).toBe(false);
  });
});

describe('efficientFrontier — entrypoints', () => {
  it('is the same function on the root and on @totalfinance/risk/optimize', () => {
    expect(fromOptimizeSubpath).toBe(efficientFrontier);
  });
});
