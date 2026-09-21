/**
 * WS2.1 — every stochastic risk API echoes the PRNG seed (and sample count) it actually used, so a
 * serialized VaR result is reproducible, and non-stochastic methods leave those fields absent.
 */

import { describe, expect, it } from 'vitest';
import { portfolioVaR, valueAtRiskReport } from '@totalfinance/risk/value-at-risk';

// deterministic, mildly-skewed return series
const R: number[] = [];
for (let i = 0; i < 400; i++) {
  R.push(
    0.0004 + 0.012 * Math.sin(i / 3.1) - 0.006 * Math.cos(i / 1.7) + (i % 11 === 0 ? -0.02 : 0),
  );
}

describe('WS2.1 — valueAtRiskReport seed/samples echo', () => {
  it('echoes the seed and sample count for method: monteCarlo', () => {
    const res = valueAtRiskReport(R, { method: 'monteCarlo', seed: 42, samples: 5000 });
    expect(res.seed).toBe(42);
    expect(res.samples).toBe(5000);
  });

  it('defaults the seed to 1 and the sample count to 10000, and echoes them', () => {
    const res = valueAtRiskReport(R, { method: 'monteCarlo' });
    expect(res.seed).toBe(1);
    expect(res.samples).toBe(10000);
  });

  it('leaves seed/samples absent for the non-stochastic methods', () => {
    for (const method of ['parametric', 'historical'] as const) {
      const res = valueAtRiskReport(R, { method });
      expect(res.seed).toBeUndefined();
      expect(res.samples).toBeUndefined();
    }
  });

  it('same seed → deep-equal result (reproducible)', () => {
    const a = valueAtRiskReport(R, { method: 'monteCarlo', seed: 7, samples: 4000 });
    const b = valueAtRiskReport(R, { method: 'monteCarlo', seed: 7, samples: 4000 });
    expect(b).toEqual(a);
  });

  it('a different seed generally moves the estimate', () => {
    const a = valueAtRiskReport(R, { method: 'monteCarlo', seed: 1, samples: 4000 });
    const b = valueAtRiskReport(R, { method: 'monteCarlo', seed: 999, samples: 4000 });
    expect(a.valueAtRisk).not.toBe(b.valueAtRisk);
  });
});

describe('WS2.1 — monteCarloPortfolioVaR seed/samples echo', () => {
  const covariance = [
    [0.04, 0.01],
    [0.01, 0.09],
  ];
  const w = [0.6, 0.4];

  it('echoes seed + samples and is reproducible', () => {
    const res = portfolioVaR({
      method: 'monteCarlo',
      weights: w,
      covariance,
      options: { seed: 123, samples: 3000 },
    });
    expect(res.seed).toBe(123);
    expect(res.samples).toBe(3000);
    expect(res.method).toBe('monteCarlo');
    const again = portfolioVaR({
      method: 'monteCarlo',
      weights: w,
      covariance,
      options: { seed: 123, samples: 3000 },
    });
    expect(again).toEqual(res);
  });

  it('defaults are echoed (seed 1, samples 10000)', () => {
    const res = portfolioVaR({ method: 'monteCarlo', weights: w, covariance, options: {} });
    expect(res.seed).toBe(1);
    expect(res.samples).toBe(10000);
  });
});
