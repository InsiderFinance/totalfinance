import { describe, expect, it } from 'vitest';
import {
  analyze,
  annualizedReturn,
  cumulativeReturns,
  equityCurve,
  logReturns,
  maxDrawdown,
  maxDrawdownFromReturns,
  underwater,
  sharpe,
  simpleReturns,
  sortino,
} from '@totalfinance/performance';
import * as performance from '@totalfinance/performance';

describe('returns', () => {
  it('simple and log returns', () => {
    expect(simpleReturns([100, 110, 99])).toEqual([0.1, expect.closeTo(-0.1, 12)]);
    expect(logReturns([100, 110])[0]).toBeCloseTo(Math.log(1.1), 12);
  });
  it('cumulative returns compound', () => {
    expect(cumulativeReturns([0.1, 0.1]).at(-1)).toBeCloseTo(0.21, 12);
  });
  it('equityCurve compounds from a start value and includes the starting point', () => {
    const eq = equityCurve([0.1, -0.5, 1.0], 100);
    expect(eq).toHaveLength(4); // start + 3 returns
    expect(eq[0]).toBeCloseTo(100, 9); // starting capital
    expect(eq[1]).toBeCloseTo(110, 9);
    expect(eq[2]).toBeCloseTo(55, 9);
    expect(eq[3]).toBeCloseTo(110, 9);
  });

  it('analyze(equityCurve(returns)) round-trips every return (no dropped first period)', () => {
    const returns = [0.05, -0.02, 0.03];
    const summary = analyze({ equity: equityCurve(returns, 1) }, { periodsPerYear: 252 });
    expect(summary.periods).toBe(3); // all 3 returns survive
    expect(summary.totalReturn).toBeCloseTo(1.05 * 0.98 * 1.03 - 1, 12);
  });

  it('a single-period return analyzes as one period, not zero', () => {
    const summary = analyze({ equity: equityCurve([0.1]) }, { periodsPerYear: 252 });
    expect(summary.periods).toBe(1);
    expect(summary.totalReturn).toBeCloseTo(0.1, 12);
  });
});

describe('annualized metrics', () => {
  it('annualizedReturn of a constant daily return', () => {
    const r = new Array(252).fill(0.001);
    // (1.001)^252 - 1
    expect(annualizedReturn(r, { periodsPerYear: 252 })).toBeCloseTo(1.001 ** 252 - 1, 9);
  });

  it('Sharpe ratio is NULL for a truly zero-volatility series (Law 7)', () => {
    // 0.5 is exactly representable, so the variance is exactly 0 and the guard returns NaN.
    expect(sharpe([0.5, 0.5, 0.5, 0.5], { periodsPerYear: 252 })).toBeNull();
  });

  it('Sharpe ratio of a known series', () => {
    const r = [0.01, -0.005, 0.012, 0.003, -0.002, 0.008];
    const s = sharpe(r, { periodsPerYear: 252 });
    expect(Number.isFinite(s)).toBe(true);
    // matches the facade namespace
    expect(performance.sharpe(r, { periodsPerYear: 252 })).toBe(s);
  });

  it('Sortino only penalizes downside', () => {
    const r = [0.01, -0.005, 0.012, 0.003, -0.002, 0.008];
    const sortinoValue = sortino(r, { periodsPerYear: 252 });
    const sharpeValue = sharpe(r, { periodsPerYear: 252 });
    expect(sortinoValue!).toBeGreaterThan(sharpeValue!); // downside dev < total dev here
  });
});

describe('drawdown', () => {
  it('computes max drawdown and trough', () => {
    const eq = [100, 120, 90, 110, 80, 130];
    const dd = maxDrawdown(eq);
    // worst peak 120 → trough 80 = (120-80)/120 = 0.3333
    expect(dd.maxDrawdown).toBeCloseTo(1 / 3, 12);
    expect(dd.peakIndex).toBe(1);
    expect(dd.troughIndex).toBe(4);
    // recovery: first index after the trough (idx 4) to regain the pre-DD peak (120) is 130 at idx 5
    expect(dd.recoveryIndex).toBe(5);
  });

  it('recoveryIndex is absent while the curve is still underwater at the end (WS3.3c)', () => {
    // peak 120 at idx 1, never regained by the end ⇒ no recovery
    const dd = maxDrawdown([100, 120, 90, 110, 80]);
    expect(dd.recoveryIndex).toBeUndefined();
  });

  it('underwater is an input-aligned per-period drawdown series whose max is maxDrawdown (WS3.3c)', () => {
    const eq = [100, 120, 90, 110, 80, 130];
    const uw = underwater(eq);
    expect(uw).toHaveLength(eq.length);
    expect(uw[0]).toBe(0); // starts at a fresh high
    expect(uw[1]).toBe(0); // new high at 120
    expect(uw[4]).toBeCloseTo(1 / 3, 12); // deepest point (120→80)
    expect(Math.max(...uw)).toBeCloseTo(maxDrawdown(eq).maxDrawdown, 12);
    expect(uw.at(-1)).toBe(0); // fresh high at the end
  });
});

describe('analyze', () => {
  it('summarizes an equity curve', () => {
    const eq = equityCurve([0.01, -0.005, 0.012, 0.003, -0.002, 0.008], 100);
    const summary = analyze({ equity: eq }, { periodsPerYear: 252 });
    expect(summary.periods).toBe(6); // 7 equity points (start + 6 returns) → 6 return periods
    expect(summary.totalReturn).toBeCloseTo(eq.at(-1)! / eq[0]! - 1, 12);
    expect(summary.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(summary.sharpe)).toBe(true);
    expect(summary.warnings).toEqual([]); // a healthy equity curve is not flagged
  });
});

describe('analyze: returns-vs-equity input (WS3.3b)', () => {
  const returns = [0.01, -0.005, 0.012, 0.003, -0.002, 0.008];

  it('the { returns } path matches the { equity } path for the equivalent series', () => {
    const fromReturns = analyze({ returns }, { periodsPerYear: 252 });
    const fromEquity = analyze({ equity: equityCurve(returns, 1) }, { periodsPerYear: 252 });
    expect(fromReturns.periods).toBe(returns.length);
    expect(fromReturns.totalReturn).toBeCloseTo(fromEquity.totalReturn!, 12);
    expect(fromReturns.maxDrawdown).toBeCloseTo(fromEquity.maxDrawdown, 12);
    expect(fromReturns.sharpe).toBeCloseTo(fromEquity.sharpe!, 12);
    expect(fromReturns.warnings).toEqual([]); // returns input is never "suspicious equity"
  });

  it('warns performance.suspicious_equity_input when a returns series is passed as equity', () => {
    // returns include a negative value AND have a near-zero mean level ⇒ both heuristics fire
    const s = analyze({ equity: returns }, { periodsPerYear: 252 });
    expect(s.warnings.some((w) => w.code === 'performance.suspicious_equity_input')).toBe(true);
    expect(s.warnings[0]!.severity).toBe('info');
  });

  it('maxDrawdownFromReturns equals maxDrawdown of the reconstructed equity curve', () => {
    const a = maxDrawdownFromReturns(returns);
    const b = maxDrawdown(equityCurve(returns, 1));
    expect(a.maxDrawdown).toBeCloseTo(b.maxDrawdown, 12);
    expect(a.troughIndex).toBe(b.troughIndex);
  });
});
