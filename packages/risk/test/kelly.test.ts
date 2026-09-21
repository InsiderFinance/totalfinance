/**
 * Kelly bet-sizing pack (`kellyBet`). Verifies the growth-optimal fraction for each edge type
 * (binary closed form, Gaussian `μ/σ²`, exact empirical for outcomes/returns — cross-checked against a
 * brute-force log-growth maximization), the fractional-Kelly growth parabola `g(κ)=g_full·κ(2−κ)`, the
 * `b^(2/κ−1)` drawdown model (independently verified against a GBM first-passage Monte-Carlo in the
 * spec), each cap binding when it should, the honesty verdicts (no-edge / no-downside / over-Kelly /
 * fat-tail disclosure), the multi-period growth, a grounded rationale, and the guards.
 */

import { describe, expect, it } from 'vitest';
import { kellyBet } from '@totalfinance/risk';

/** Brute-force maximizer of a log-growth `g` over `(0, fMax)` — the reference for the empirical Kelly. */
function gridArgmax(g: (f: number) => number, fMax: number, n = 200_000): number {
  let bestF = 0;
  let bestG = -Infinity;
  for (let i = 1; i < n; i++) {
    const f = (fMax * i) / n;
    const v = g(f);
    if (Number.isFinite(v) && v > bestG) {
      bestG = v;
      bestF = f;
    }
  }
  return bestF;
}

describe('kellyBet — full Kelly per edge type', () => {
  it('binary 60% / 2:1 → f* = p/a − q/b = 0.40 (closed form matches a brute-force log-growth max)', () => {
    const r = kellyBet({ edge: { binary: { winProbability: 0.6, winAmount: 2, lossAmount: 1 } } });
    expect(r.fullKelly).toBeCloseTo(0.4, 10);
    // Independent check: the closed form is the argmax of g(f) = 0.6·ln(1+2f) + 0.4·ln(1−f).
    const g = (f: number) => 0.6 * Math.log(1 + 2 * f) + 0.4 * Math.log(1 - f);
    expect(r.fullKelly).toBeCloseTo(gridArgmax(g, 1), 4);
    expect(r.assumptions.edgeType).toBe('binary');
    expect(r.diagnostics.method).toBe('closed-form');
  });

  it('gaussian → f* = μ/σ² and growthRateFull = μ²/(2σ²)', () => {
    const r = kellyBet({ edge: { gaussian: { mean: 0.01, variance: 0.04 } }, fraction: 1 });
    expect(r.fullKelly).toBeCloseTo(0.25, 12);
    expect(r.growthRateFull).toBeCloseTo((0.01 * 0.01) / (2 * 0.04), 12);
  });

  it('outcomes → the exact empirical f* matches a brute-force grid search', () => {
    const outcomes = [
      { probability: 0.55, payoff: 1 },
      { probability: 0.45, payoff: -0.9 },
    ];
    const r = kellyBet({ edge: { outcomes }, fraction: 1 });
    const g = (f: number) => 0.55 * Math.log(1 + f) + 0.45 * Math.log(1 - 0.9 * f);
    expect(r.fullKelly).toBeCloseTo(gridArgmax(g, 1 / 0.9), 4);
    expect(r.diagnostics.method).toBe('brent');
  });

  it('returns → the exact empirical f* matches a grid search and reports the Gaussian μ/σ²', () => {
    const returns = [0.05, -0.03, 0.04, -0.02, 0.06, -0.04, 0.03, 0.05, -0.01, 0.02];
    const r = kellyBet({ edge: { returns }, fraction: 1 });
    const worst = Math.max(...returns.map((x) => -x));
    const g = (f: number) => returns.reduce((s, x) => s + Math.log(1 + f * x), 0) / returns.length;
    expect(r.fullKelly).toBeCloseTo(gridArgmax(g, 1 / worst), 3);
    expect(r.gaussianKelly).toBeDefined();
  });
});

describe('kellyBet — growth & drawdown', () => {
  it('the fractional-Kelly growth is the parabola g(κ) = g_full·κ(2−κ)', () => {
    const r = kellyBet({ edge: { gaussian: { mean: 0.01, variance: 0.04 } }, fraction: 0.5 });
    expect(r.appliedFraction).toBeCloseTo(0.5, 12);
    // κ=0.5 ⇒ κ(2−κ) = 0.75 of the full-Kelly growth rate.
    expect(r.growthRate).toBeCloseTo(r.growthRateFull! * 0.75, 12);
    expect(r.bindingConstraint).toBe('fraction');
  });

  it('the drawdown probability follows b^(2/κ−1): full Kelly → b, half Kelly → b³', () => {
    const full = kellyBet({ edge: { binary: { winProbability: 0.6, winAmount: 2 } }, fraction: 1 });
    expect(full.appliedFraction).toBeCloseTo(1, 12);
    expect(full.drawdownRisk.toFraction).toBe(0.5);
    expect(full.drawdownRisk.probability).toBeCloseTo(0.5, 10); // 0.5^(2/1−1) = 0.5

    const half = kellyBet({
      edge: { binary: { winProbability: 0.6, winAmount: 2 } },
      fraction: 0.5,
    });
    expect(half.drawdownRisk.probability).toBeCloseTo(0.125, 10); // 0.5^(2/0.5−1) = 0.5³
  });

  it('periodsToDouble = ln2 / growthRate', () => {
    const r = kellyBet({ edge: { gaussian: { mean: 0.01, variance: 0.04 } }, fraction: 1 });
    expect(r.periodsToDouble).toBeCloseTo(Math.LN2 / r.growthRate!, 8);
  });

  it('a horizonPeriods projects the median growth multiple exp(horizonPeriods·g)', () => {
    const r = kellyBet({ edge: { gaussian: { mean: 0.01, variance: 0.04 } }, horizonPeriods: 100 });
    expect(r.horizonGrowth!.horizonPeriods).toBe(100);
    expect(r.horizonGrowth!.growthMultiple).toBeCloseTo(Math.exp(100 * r.growthRate!), 8);
  });
});

describe('kellyBet — the binding cap', () => {
  it('a drawdown budget binds and lands the probability at the target', () => {
    const r = kellyBet({
      edge: { binary: { winProbability: 0.6, winAmount: 2 } }, // f* = 0.4
      fraction: 1,
      drawdownLimit: { toFraction: 0.7, maxProbability: 0.15 },
    });
    expect(r.bindingConstraint).toBe('drawdown-limit');
    expect(r.recommendedFraction).toBeLessThan(0.4);
    // The constraint is active: at the recommended size the drawdown probability equals the budget.
    expect(r.drawdownRisk.toFraction).toBe(0.7);
    expect(r.drawdownRisk.probability).toBeCloseTo(0.15, 6);
  });

  it('a hard maxFraction binds when it is the tightest cap', () => {
    const r = kellyBet({
      edge: { gaussian: { mean: 0.008, variance: 0.0016 } }, // f* = 5
      fraction: 1,
      maxFraction: 1,
    });
    expect(r.bindingConstraint).toBe('max-fraction');
    expect(r.recommendedFraction).toBe(1);
  });

  it('half-Kelly is the disclosed default and the fractional cap binds', () => {
    const r = kellyBet({ edge: { binary: { winProbability: 0.6, winAmount: 2 } } });
    expect(r.assumptions.fraction).toBe(0.5);
    expect(r.recommendedFraction).toBeCloseTo(0.2, 10);
    expect(r.bindingConstraint).toBe('fraction');
  });
});

describe('kellyBet — honesty verdicts', () => {
  it('a non-positive edge → do not bet (recommended 0, no-edge, warned)', () => {
    const r = kellyBet({ edge: { binary: { winProbability: 0.45, winAmount: 1 } } });
    expect(r.fullKelly).toBeLessThanOrEqual(0);
    expect(r.recommendedFraction).toBe(0);
    expect(r.bindingConstraint).toBe('no-edge');
    expect(r.drawdownRisk.probability).toBe(0);
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_no_edge')).toBe(true);
    expect(r.rationale).toContain('do not bet');
  });

  it('an edge with no downside → full Kelly is null (finite-success law), sized to maxFraction', () => {
    const r = kellyBet({
      edge: {
        outcomes: [
          { probability: 0.5, payoff: 0.1 },
          { probability: 0.5, payoff: 0.3 },
        ],
      },
      maxFraction: 1,
    });
    // Finite-success law: no finite unconstrained optimum ⇒ null, never Infinity.
    expect(r.fullKelly).toBeNull();
    expect(r.growthRateFull).toBeNull();
    expect(r.appliedFraction).toBeNull();
    // A finite recommendation still requires an explicit cap — here maxFraction binds.
    expect(r.recommendedFraction).toBe(1);
    expect(r.bindingConstraint).toBe('max-fraction');
    expect(r.drawdownRisk.probability).toBe(0); // no losing outcome ⇒ never draws down
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_unbounded')).toBe(true);
  });

  it('a no-downside edge with no cap → null recommendation + discriminant, not a fabricated number', () => {
    const r = kellyBet({ edge: { returns: [0.01, 0.02, 0.03, 0.015] } }); // all positive, no maxFraction
    expect(r.fullKelly).toBeNull();
    expect(r.recommendedFraction).toBeNull(); // never Infinity — no finite recommendation without a cap
    expect(r.growthRate).toBeNull();
    expect(r.periodsToDouble).toBeNull();
    expect(r.bindingConstraint).toBe('no-downside');
    expect(r.gaussianKelly).toBeDefined();
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_unbounded')).toBe(true);
    expect(r.rationale).toContain('no finite Kelly optimum');
  });

  it('over-betting (fraction > 1) is flagged as severe', () => {
    const r = kellyBet({
      edge: { binary: { winProbability: 0.6, winAmount: 2 } },
      fraction: 1.5,
      maxFraction: 5,
    });
    expect(r.appliedFraction).toBeCloseTo(1.5, 10);
    expect(r.drawdownRisk.probability).toBeGreaterThan(0.5);
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_over')).toBe(true);
  });

  it('a negative-EV discrete distribution → no-edge (the numeric maximizer bottoms out at 0)', () => {
    const r = kellyBet({
      edge: {
        outcomes: [
          { probability: 0.4, payoff: 1 },
          { probability: 0.6, payoff: -1 },
        ],
      }, // E[payoff] = −0.2
    });
    expect(r.fullKelly).toBe(0);
    expect(r.bindingConstraint).toBe('no-edge');
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_no_edge')).toBe(true);
  });

  it('a zero-probability outcome is handled without breaking the log-growth', () => {
    const r = kellyBet({
      edge: {
        outcomes: [
          { probability: 0.6, payoff: 1 },
          { probability: 0.4, payoff: -0.5 },
          { probability: 0, payoff: 10 }, // impossible outcome — must be skipped, not blow up
        ],
      },
      fraction: 1,
    });
    expect(Number.isFinite(r.fullKelly)).toBe(true);
    expect(r.fullKelly).toBeGreaterThan(0);
  });

  it('betting ≥ 2× full Kelly has non-positive growth — the doubling time goes to infinity', () => {
    const r = kellyBet({
      edge: { binary: { winProbability: 0.55, winAmount: 2 } }, // f* = 0.325
      fraction: 2.5, // κ = 2.5 ≥ 2 — past the growth-optimal point, into ruin territory
      maxFraction: 5,
    });
    expect(r.appliedFraction).toBeCloseTo(2.5, 6);
    expect(r.growthRate).toBeLessThan(0);
    expect(r.periodsToDouble).toBe(Infinity);
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_over')).toBe(true);
  });

  it('fat left tails cut the empirical Kelly below the Gaussian estimate, and it is disclosed', () => {
    // 99 small gains + 1 catastrophic loss: μ/σ² ≈ 1.06 but the exact empirical f* = 0.65
    // (solving 0.0099/(1+0.01f) = 0.006/(1−0.6f) ⟹ 0.0039 = 0.006f ⟹ f = 0.65).
    const returns = [...Array(99).fill(0.01), -0.6];
    const r = kellyBet({ edge: { returns }, fraction: 1 });
    expect(r.gaussianKelly!).toBeGreaterThan(r.fullKelly!);
    expect(r.fullKelly).toBeCloseTo(0.65, 3);
    expect(r.gaussianKelly!).toBeCloseTo(1.059, 2);
    expect(r.diagnostics.warnings.some((w) => w.code === 'risk.kelly_fat_tails')).toBe(true);
    expect(r.rationale).toContain('tails');
  });
});

describe('kellyBet — envelope & guards', () => {
  it('the rationale carries real numbers, no NaN/undefined', () => {
    const r = kellyBet({ edge: { binary: { winProbability: 0.6, winAmount: 2 } } });
    expect(r.rationale).not.toContain('NaN');
    expect(r.rationale).not.toContain('undefined');
    expect(r.assumptions.drawdownModel).toBe('continuous-gbm');
    expect(r.diagnostics.engine).toBe('kelly-bet');
  });

  it('throws on garbage, a missing/ambiguous edge, and out-of-range parameters', () => {
    expect(() => kellyBet(undefined as never)).toThrowError();
    expect(() => kellyBet({ edge: {} as never })).toThrowError(); // no edge key
    expect(() =>
      kellyBet({ edge: { binary: { winProbability: 1.2, winAmount: 2 } } }),
    ).toThrowError(); // prob out of range
    expect(() =>
      kellyBet({ edge: { binary: { winProbability: 0.6, winAmount: -1 } } }),
    ).toThrowError(); // non-positive amount
    expect(() => kellyBet({ edge: { gaussian: { mean: 0.01, variance: -1 } } })).toThrowError(); // negative variance
    expect(() => kellyBet({ edge: { returns: [0.01] } })).toThrowError(); // < 2 returns
    // C (hygiene): a zero-variance edge is a diagnostic, not a refusal — see the zero-variance block
    expect(() =>
      kellyBet({ edge: { outcomes: [{ probability: 1, payoff: 0.1 }] } }),
    ).toThrowError(); // < 2 outcomes
    expect(() =>
      kellyBet({
        edge: {
          outcomes: [
            { probability: -0.1, payoff: 1 },
            { probability: 1.1, payoff: -1 },
          ],
        },
      }),
    ).toThrowError(); // negative outcome probability
    expect(() =>
      kellyBet({
        edge: {
          outcomes: [
            { probability: 0.5, payoff: 1 },
            { probability: 0.3, payoff: -1 },
          ],
        },
      }),
    ).toThrowError(); // probabilities don't sum to 1
    expect(() =>
      kellyBet({ edge: { binary: { winProbability: 0.6, winAmount: 2 } }, fraction: 0 }),
    ).toThrowError(); // non-positive fraction
    expect(() =>
      kellyBet({ edge: { binary: { winProbability: 0.6, winAmount: 2 } }, maxFraction: -1 }),
    ).toThrowError(); // non-positive maxFraction
    expect(() =>
      kellyBet({ edge: { binary: { winProbability: 0.6, winAmount: 2 } }, horizonPeriods: -5 }),
    ).toThrowError(); // non-positive horizonPeriods
    expect(() =>
      kellyBet({
        edge: { binary: { winProbability: 0.6, winAmount: 2 } },
        drawdownLimit: { toFraction: 1.5, maxProbability: 0.1 },
      }),
    ).toThrowError(); // toFraction out of range
    expect(() =>
      kellyBet({
        edge: { binary: { winProbability: 0.6, winAmount: 2 } },
        drawdownLimit: { toFraction: 0.5, maxProbability: 1.5 },
      }),
    ).toThrowError(); // maxProbability out of range
  });
});

describe('kellyBet — a zero-variance edge is a diagnostic, never a refusal (C hygiene)', () => {
  it('every return equal and positive: no downside, so the size is the cap and the Gaussian read is omitted', () => {
    const flat = kellyBet({ edge: { returns: [0.01, 0.01, 0.01] }, maxFraction: 2 });
    expect(flat.gaussianKelly).toBeUndefined();
    expect(flat.bindingConstraint).toBe('max-fraction');
    expect(flat.diagnostics.warnings.map((w) => w.code)).toEqual([
      'risk.kelly_zero_variance',
      'risk.kelly_unbounded',
    ]);
  });

  it('every return equal and negative: no edge, sized to nothing, with the same diagnostic', () => {
    const losing = kellyBet({ edge: { returns: [-0.01, -0.01, -0.01] } });
    expect(losing.gaussianKelly).toBeUndefined();
    expect(losing.bindingConstraint).toBe('no-edge');
    expect(losing.diagnostics.warnings.some((w) => w.code === 'risk.kelly_zero_variance')).toBe(
      true,
    );
  });
});
