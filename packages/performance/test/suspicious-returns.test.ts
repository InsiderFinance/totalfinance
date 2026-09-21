import { describe, expect, it } from 'vitest';
import { analyze, sharpe, sortino } from '../src/index.js';

/**
 * DX WS-3/R6 — the prices-as-returns footgun. sharpe(prices) used to return 117.7 with zero
 * warnings; historical VaR on the same input returned 0, silently. The explain paths now flag it.
 */
const prices = Array.from({ length: 60 }, (_, i) => 100 + i); // a monotonic price series
const returns = Array.from({ length: 60 }, (_, i) => 0.01 * Math.sin(i)); // honest returns

describe('suspicious-returns guard (dx WS-3)', () => {
  it('sharpe.explain(prices) flags input.suspicious_returns; plain call stays silent-and-correct', () => {
    const r = sharpe.explain(prices);
    expect(r.diagnostics.warnings.map((w) => w.code)).toContain('input.suspicious_returns');
    expect(sharpe(prices)).toBeTypeOf('number'); // plain-value law: silent, computes as asked
  });

  it('honest returns carry no warning', () => {
    expect(sharpe.explain(returns).diagnostics.warnings).toEqual([]);
    expect(sortino.explain(returns).diagnostics.warnings).toEqual([]);
  });

  it('analyze({ returns: prices }) surfaces it through the summary and the explain envelope', () => {
    const summary = analyze({ returns: prices });
    expect(summary.sharpe).toBeTypeOf('number');
    const explained = analyze.explain({ returns: prices });
    expect(explained.assumptions.periodsPerYear).toBe(252);
    expect(explained.value.periods).toBe(prices.length);
  });
});
