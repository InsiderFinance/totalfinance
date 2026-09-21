import { bench, describe } from 'vitest';
import { conditionalValueAtRiskOptimize, minVariance } from '@totalfinance/risk/optimize';

/** Phase-5 acceleration-need benchmark for portfolio optimization (§19.4 candidates). */
const N = 20;
// a well-conditioned SPD covariance: diagonal dominance + a mild common factor
const cov: number[][] = Array.from({ length: N }, (_, i) =>
  Array.from({ length: N }, (_, j) => (i === j ? 0.04 + (i % 5) * 0.01 : 0.004)),
);

// 250 return scenarios × 20 assets for the CVaR optimizer
const S = 250;
const scenarios: number[][] = Array.from({ length: S }, (_, s) =>
  Array.from({ length: N }, (_, i) => 0.0005 * (i + 1) + 0.02 * Math.sin(s + i)),
);

describe('portfolio optimization (acceleration-need benchmark)', () => {
  bench('constrained min-variance (20 assets, long-only + sector cap)', () => {
    minVariance(cov, { longOnly: true, groups: [{ members: [0, 1, 2, 3, 4], max: 0.5 }] });
  });

  bench('CVaR optimization (250 scenarios × 20 assets)', () => {
    conditionalValueAtRiskOptimize(scenarios, {
      alpha: 0.95,
      longOnly: true,
      maximumIterations: 500,
    });
  });
});
