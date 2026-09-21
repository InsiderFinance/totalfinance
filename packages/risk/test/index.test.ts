import { describe, expect, it } from 'vitest';
import * as risk from '@totalfinance/risk';

/**
 * Umbrella smoke test: the top-level entry re-exports every pillar (VaR, scenario, factor, optimize)
 * and they interoperate on a single book. Performance metrics live in `@totalfinance/performance`
 * (the nested namespace re-export was removed in P3.3 — one namespace level per concept).
 */
describe('@totalfinance/risk umbrella', () => {
  it('exposes the four pillars (and no nested performance namespace)', () => {
    for (const fn of [
      'valueAtRisk',
      'expectedShortfall',
      'portfolioVaR',
      'riskContributions',
      'shock',
      'scenario',
      'stressTest',
      'pca',
      'factorExposure',
      'minVariance',
      'maxSharpe',
      'meanVariance',
      'riskParity',
      'hrp',
      'kelly',
    ] as const) {
      expect(typeof risk[fn], fn).not.toBe('undefined');
    }
    // P3.3: performance metrics are NOT nested here — import '@totalfinance/performance' directly.
    expect('performance' in risk).toBe(false);
  });

  it('end-to-end: optimize → decompose → VaR → stress on one covariance', () => {
    const covariance = [
      [0.04, 0.006, 0.0],
      [0.006, 0.09, -0.01],
      [0.0, -0.01, 0.0225],
    ];
    const w = risk.minVariance(covariance, { longOnly: true }).value.weights;
    const rc = risk.riskContributions(w, covariance);
    // H10: the report's fractions sum to 1 (renamed from percent).
    expect(rc.contributions.reduce((s, c) => s + c.fraction!, 0)).toBeCloseTo(1, 8);
    const v = risk.portfolioVaR({
      method: 'parametric',
      weights: w,
      covariance,
      options: { confidence: 0.95 },
    });
    expect(v.valueAtRisk).toBeGreaterThan(0);
    if (!('componentVaR' in v)) throw new Error('parametric VaR carries component VaR');
    expect(v.componentVaR.reduce((s, x) => s + x, 0)).toBeCloseTo(v.valueAtRisk, 8);
    const stress = risk.stressTest({
      positions: [
        // vega per vol point (the options package's unit): 0.2 per point = 20 per 1.00 σ.
        { id: 'book', greeks: { value: 100, spot: 100, delta: 1, gamma: 0.05, vega: 0.2 } },
      ],
      scenarios: [risk.scenario('crash', risk.shock.spot('-8%'), risk.shock.volatility('+15pts'))],
    });
    expect(stress.scenarios[0]!.pnl).toBeLessThan(0); // long delta into a sell-off
  });
});
