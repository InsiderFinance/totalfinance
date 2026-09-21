import { describe, expect, it, vi } from 'vitest';
import { ErrorCode, type Computed } from '@totalfinance/core';
import { analyticAssumptions, facade, impliedVolatilityFacadePair } from '../src/facade-util.js';

/** The analytic-model PURE annotations promise construction, never evaluation or registration. */
describe('analytic facade construction is lazy', () => {
  const explained = (): Computed<number> => ({
    value: 2,
    assumptions: analyticAssumptions({ model: 'test', timeToExpiryYears: 1 }),
    diagnostics: { engine: 'test', converged: true, warnings: [] },
  });

  it('only allocates a pair; neither callback runs until the corresponding method is used', () => {
    const calculate = vi.fn(() => 2);
    const explain = vi.fn(explained);
    const pair = facade('test.price', calculate, explain);
    expect(calculate).not.toHaveBeenCalled();
    expect(explain).not.toHaveBeenCalled();
    expect(pair({})).toBe(2);
    expect(calculate).toHaveBeenCalledOnce();
    expect(explain).not.toHaveBeenCalled();
    expect(pair.explain({}).value).toBe(2);
    expect(explain).toHaveBeenCalledOnce();
  });

  it('the implied-volatility pair does not invoke its solver at construction', () => {
    const solve = vi.fn(explained);
    const pair = impliedVolatilityFacadePair(
      'test.impliedVolatility',
      solve,
      [ErrorCode.ImpliedVolatilityBelowIntrinsic],
      'test.impliedVolatility: no convergence',
    );
    expect(solve).not.toHaveBeenCalled();
    expect(pair({})).toBe(2);
    expect(solve).toHaveBeenCalledOnce();
    expect(pair.explain({}).value).toBe(2);
    expect(solve).toHaveBeenCalledTimes(2);
  });
});
