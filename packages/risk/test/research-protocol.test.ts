/**
 * Research-protocol pack (`researchProtocol`). Verifies the three-way verdict: a strong strategy that
 * survives deflation + out-of-sample reads `significant`; the best of many trials collapses under
 * deflation to `likely-overfit` (even though the un-deflated PSR looks great); deflation-without-OOS is
 * `inconclusive`; a vanished OOS edge is `likely-overfit`; MinTRL and the un-deflated-≥-deflated
 * relation; the rationale carries the numbers; guards.
 */

import { describe, expect, it } from 'vitest';
import { researchProtocol } from '@totalfinance/risk';

/** A deterministic return series with a known per-observation Sharpe ≈ mean/sd (skew 0). */
function series(mean: number, sd: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => mean + (i % 2 === 0 ? sd : -sd));
}

describe('researchProtocol — verdict', () => {
  it('a strong strategy surviving deflation AND out-of-sample reads significant', () => {
    const r = researchProtocol({
      returns: series(0.001, 0.005, 252), // per-obs Sharpe ≈ 0.20, annualized ≈ 3.2
      outOfSampleReturns: series(0.0009, 0.005, 126), // ≈ 0.18 → ~10% degradation
    });
    expect(r.verdict).toBe('significant');
    expect(r.deflatedSharpe).toBeGreaterThanOrEqual(0.95);
    expect(r.outOfSample!.sharpe).toBeGreaterThan(0);
    expect(r.outOfSample!.degradation).toBeLessThan(0.5);
    expect(r.rationale).toContain('Significant');
  });

  it('the best of many trials collapses under deflation → likely-overfit (PSR would have lied)', () => {
    // 40 trial Sharpes spanning ±0.1 → a large expected-max-by-chance benchmark SR₀.
    const trialSharpes = Array.from({ length: 40 }, (_, i) => -0.1 + (0.2 * i) / 39);
    const r = researchProtocol({
      returns: series(0.0006, 0.01, 252), // a modest per-obs Sharpe ≈ 0.06
      trials: { trialSharpes },
    });
    expect(r.verdict).toBe('likely-overfit');
    expect(r.deflatedSharpe).toBeLessThan(0.95);
    // The naive (un-deflated) PSR looks far better than the deflated one — that's the whole point.
    expect(r.probabilisticSharpe).toBeGreaterThan(r.deflatedSharpe!);
    expect(r.trialCount).toBe(40);
    expect(r.rationale).toContain('selection');
  });

  it('deflation passes but no out-of-sample given → inconclusive (disclosed)', () => {
    const r = researchProtocol({ returns: series(0.001, 0.005, 252) });
    expect(r.verdict).toBe('inconclusive');
    expect(r.deflatedSharpe).toBeGreaterThanOrEqual(0.95);
    expect(r.outOfSample).toBeUndefined();
    expect(r.rationale).toContain('out-of-sample');
  });

  it('a zero-variance out-of-sample series has no Sharpe → inconclusive, never a verdict', () => {
    // C (hygiene): a constant series is evidence of nothing. It must not read as a vanished edge
    // (`likely-overfit`) or survive as `significant`; the OOS block reports null and the verdict
    // is inconclusive regardless of how well the in-sample deflation went.
    const r = researchProtocol({
      returns: series(0.001, 0.005, 252),
      outOfSampleReturns: Array.from({ length: 126 }, () => 0.0005),
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.deflatedSharpe).toBeGreaterThanOrEqual(0.95);
    expect(r.outOfSample).toEqual({ sharpe: null, annualizedSharpe: null, degradation: null });
  });

  it('a vanished out-of-sample edge → likely-overfit', () => {
    const r = researchProtocol({
      returns: series(0.001, 0.005, 252),
      outOfSampleReturns: series(-0.0005, 0.005, 126), // negative OOS Sharpe
    });
    expect(r.verdict).toBe('likely-overfit');
    expect(r.outOfSample!.sharpe).toBeLessThan(0);
    expect(r.rationale).toContain('out-of-sample');
  });

  it('a positive-but-more-than-halved out-of-sample edge → inconclusive (caution)', () => {
    const r = researchProtocol({
      returns: series(0.001, 0.005, 252), // per-obs Sharpe ≈ 0.20
      outOfSampleReturns: series(0.0004, 0.005, 126), // ≈ 0.08 → ~60% degradation, still positive
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.outOfSample!.sharpe).toBeGreaterThan(0);
    expect(r.outOfSample!.degradation).toBeGreaterThan(0.5);
    expect(r.rationale).toContain('degrades');
    expect(r.rationale).toContain('caution');
  });
});

describe('researchProtocol — statistics', () => {
  it('MinTRL is finite when SR > SR₀ and the un-deflated PSR ≥ the deflated one', () => {
    const single = researchProtocol({ returns: series(0.0004, 0.01, 300) }); // small positive Sharpe, no trials
    expect(Number.isFinite(single.minTrackRecordLength)).toBe(true);
    expect(single.minTrackRecordLength).toBeGreaterThan(single.inSample.observations);
    expect(single.probabilisticSharpe).toBeGreaterThanOrEqual(single.deflatedSharpe! - 1e-12);
    // A single hypothesis has no selection penalty: SR₀ = 0, deflated = PSR.
    expect(single.expectedMaxSharpe).toBe(0);
    expect(single.trialCount).toBe(1);
  });

  it('the annualized Sharpe scales the per-observation Sharpe by √periodsPerYear', () => {
    const r = researchProtocol({ returns: series(0.001, 0.005, 252), periodsPerYear: 252 });
    expect(r.inSample.annualizedSharpe).toBeCloseTo(r.inSample.sharpe! * Math.sqrt(252), 10);
  });

  it('a positive risk-free rate lowers the excess Sharpe', () => {
    const gross = researchProtocol({ returns: series(0.001, 0.005, 252) });
    const net = researchProtocol({ returns: series(0.001, 0.005, 252), riskFreeRate: 0.0004 });
    expect(net.inSample.sharpe).toBeLessThan(gross.inSample.sharpe!);
  });

  it('a losing in-sample strategy is likely-overfit; degradation is not computed off a non-positive base', () => {
    const r = researchProtocol({
      returns: series(-0.0005, 0.005, 252), // negative in-sample Sharpe
      outOfSampleReturns: series(0.0003, 0.005, 126), // positive OOS
    });
    expect(r.inSample.sharpe).toBeLessThan(0);
    expect(r.verdict).toBe('likely-overfit'); // deflation cannot pass a negative Sharpe
    expect(r.outOfSample!.degradation).toBe(0); // guarded: no divide-by-non-positive
  });

  it('when both in- and out-of-sample are losing, degradation reads as total (1)', () => {
    const r = researchProtocol({
      returns: series(-0.0005, 0.005, 252),
      outOfSampleReturns: series(-0.0004, 0.005, 126),
    });
    expect(r.verdict).toBe('likely-overfit');
    expect(r.outOfSample!.degradation).toBe(1);
  });
});

describe('researchProtocol — envelope & guards', () => {
  it('the rationale carries real numbers, no NaN/undefined', () => {
    const r = researchProtocol({ returns: series(0.001, 0.005, 252) });
    expect(r.rationale).not.toContain('NaN');
    expect(r.rationale).not.toContain('undefined');
    expect(r.diagnostics.engine).toBe('research-protocol');
  });

  it('throws on garbage, too-few returns, a bad confidence, and a bad periodsPerYear', () => {
    expect(() => researchProtocol(undefined as never)).toThrowError();
    expect(() => researchProtocol({ returns: [0.01, 0.02] })).toThrowError(); // < 3
    expect(() =>
      researchProtocol({ returns: series(0.001, 0.005, 50), confidence: 1.5 }),
    ).toThrowError();
    expect(() =>
      researchProtocol({ returns: series(0.001, 0.005, 50), periodsPerYear: 0 }),
    ).toThrowError();
    expect(() =>
      researchProtocol({ returns: series(0.001, 0.005, 50), periodsPerYear: Infinity }),
    ).toThrowError();
  });
});
