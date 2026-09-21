import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { analyze, omega, profitFactor, simpleReturns } from '@totalfinance/performance';

/**
 * Regression for an external-review finding: `analyze` propagated non-finite inputs and an invalid
 * annualization factor straight into NaN metrics, reported as if valid (no-silent-degradation law).
 */
describe('performance analyze — no silent NaN degradation', () => {
  it('rejects a non-finite value in the return series', () => {
    let caught: unknown;
    try {
      analyze({ returns: [0.01, NaN, 0.02] });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.not_finite')).toBe(true);
  });

  it('rejects a non-finite value in an equity curve', () => {
    expect(() => analyze({ equity: [100, Infinity, 102] })).toThrow(/non-finite value/);
  });

  it('rejects an invalid annualization factor', () => {
    expect(() => analyze({ returns: [0.01, 0.02, -0.01] }, { periodsPerYear: -5 })).toThrow(
      /periodsPerYear must be a positive finite/,
    );
    expect(() => analyze({ returns: [0.01, 0.02, -0.01] }, { periodsPerYear: 0 })).toThrow();
  });

  it('a clean series still summarizes', () => {
    const s = analyze({ returns: [0.01, 0.02, -0.01, 0.03] });
    expect(Number.isFinite(s.sharpe)).toBe(true);
    expect(s.periods).toBe(4);
  });
});

/**
 * [P3] An interior ZERO equity level: `simpleReturns` divided by it and emitted a silent NaN, which
 * surfaced hundreds of lines later as "annualizedReturn overflowed" — an error naming a function
 * the caller never called and a cause that was not the cause.
 */
describe('performance — an interior zero level is named where it happens', () => {
  it('analyze({ equity }) names the offending equity[i], not annualizedReturn', () => {
    let caught: unknown;
    try {
      analyze({ equity: [100, 0, 50] });
    } catch (e) {
      caught = e;
    }
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect((caught as Error).message).toMatch(/analyze: equity\[1\] is 0/);
    expect((caught as Error).message).not.toMatch(/annualizedReturn/);
    expect((caught as { context?: Record<string, unknown> }).context?.['index']).toBe(1);
  });

  it('simpleReturns names the offending prices[i] instead of returning NaN', () => {
    expect(() => simpleReturns([100, 0, 50])).toThrow(/simpleReturns: prices\[1\] is 0/);
    // Pre-fix this was `[-1, NaN]` — finite-looking output with a hole in it.
    expect(() => simpleReturns([100, 0, 50])).toThrow(/undefined/);
  });

  it('a TERMINAL zero is still legal — it is a −100% period, not a division by zero', () => {
    expect(simpleReturns([100, 50, 0])).toEqual([-0.5, -1]);
    const s = analyze({ equity: [100, 50, 0] });
    expect(s.periods).toBe(2);
    expect(s.totalReturn).toBeCloseTo(-1, 12);
  });
});

/**
 * [review-1] `profitFactor`/`omega` promised `Infinity` in their docs and returned `null` — the doc
 * is what changed (null-with-reason is the Law 7 answer), and the contract is pinned here.
 */
describe('performance — the unbounded-ratio contract is null with a reason', () => {
  const allWinners = [0.01, 0.02, 0.03];

  it('profitFactor: gains with no losses ⇒ null + an input.degenerate reason (never Infinity)', () => {
    expect(profitFactor(allWinners)).toBeNull();
    const explained = profitFactor.explain(allWinners);
    expect(explained.value).toBeNull();
    const w = explained.diagnostics.warnings.find((x) => x.code === 'input.degenerate');
    expect(w).toBeDefined();
    expect(w!.message).toMatch(/profitFactor: the metric is undefined/);
    expect(w!.message).toMatch(/reported as null \(never NaN\/Infinity\)/);
  });

  it('omega: the same contract at its threshold', () => {
    expect(omega(allWinners)).toBeNull();
    const explained = omega.explain(allWinners);
    expect(explained.value).toBeNull();
    expect(explained.diagnostics.warnings.map((x) => x.code)).toContain('input.degenerate');
    // a series with both sides still returns the finite ratio
    expect(omega([0.02, -0.01])).toBeCloseTo(2, 12);
  });
});
