import { describe, expect, it } from 'vitest';
import {
  alpha,
  annualizedReturn,
  annualizedVolatility,
  calmar,
  informationRatio,
  sharpe,
  sortino,
  trackingError,
  treynor,
} from '@totalfinance/performance';

/**
 * DX1.3 — performance metrics are facades: plain call → bare number; `.explain()` → the `Computed`
 * envelope disclosing the conventions actually applied. A defaulted `periodsPerYear: 252` is echoed,
 * never hidden (this is what makes the DX0 default honest).
 */

const returns = Array.from(
  { length: 120 },
  (_, i) => 0.0004 + 0.01 * Math.sin(i / 5) - (i % 7) * 0.001,
);
const bench = Array.from({ length: 120 }, (_, i) => 0.0003 + 0.008 * Math.sin(i / 6));

describe('performance facades expose .explain()', () => {
  it('plain call returns a number; .explain() returns the matching Computed envelope', () => {
    expect(typeof sharpe(returns)).toBe('number');
    const e = sharpe.explain(returns);
    expect(e.value).toBe(sharpe(returns));
    expect(e.assumptions.periodsPerYear).toBe(252);
    expect(e.assumptions.riskFreeRate).toBe(0);
    expect(e.diagnostics.warnings).toEqual([]);
  });

  it('echoes overridden conventions', () => {
    const e = sharpe.explain(returns, { periodsPerYear: 12, riskFreeRate: 0.02 });
    expect(e.assumptions.periodsPerYear).toBe(12);
    expect(e.assumptions.riskFreeRate).toBe(0.02);
    expect(e.value).toBe(sharpe(returns, { periodsPerYear: 12, riskFreeRate: 0.02 }));
  });

  it('annualization-only metrics disclose periodsPerYear', () => {
    expect(annualizedVolatility.explain(returns).assumptions.periodsPerYear).toBe(252);
    expect(annualizedReturn.explain(returns).assumptions.periodsPerYear).toBe(252);
    expect(calmar.explain(returns).assumptions.periodsPerYear).toBe(252);
    expect(trackingError.explain(returns, bench).assumptions.periodsPerYear).toBe(252);
    expect(informationRatio.explain(returns, bench).assumptions.periodsPerYear).toBe(252);
  });

  it('risk-adjusted metrics disclose periodsPerYear + riskFreeRate, value matches the plain call', () => {
    const s = sortino.explain(returns);
    expect(s.assumptions.periodsPerYear).toBe(252);
    expect(s.assumptions.riskFreeRate).toBe(0);
    expect(alpha.explain(returns, bench).assumptions.riskFreeRate).toBe(0);
    expect(treynor.explain(returns, bench).assumptions.riskFreeRate).toBe(0);
    expect(alpha(returns, bench)).toBe(alpha.explain(returns, bench).value);
    expect(treynor(returns, bench)).toBe(treynor.explain(returns, bench).value);
  });
});
