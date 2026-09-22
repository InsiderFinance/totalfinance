/**
 * Runnable examples for the Phase-5 completeness pass — benchmark-relative performance, Black-Litterman
 * & CVaR optimization with real constraints, portfolio-risk approximations, the Heston/term-structure
 * volatility surface, and event-vol decomposition. Executes in CI so the docs can't drift from the code.
 */

import { resolvedExpiry } from '@insiderfinance/totalfinance/core';
import { describe, expect, it } from 'vitest';
import { type OptionQuote, yearFraction } from '@insiderfinance/totalfinance/core';
import { type HestonParameters } from '@insiderfinance/totalfinance/options';
import { hestonImpliedVolatility } from '@insiderfinance/totalfinance/options/heston';
import { analyze, equityCurve } from '@insiderfinance/totalfinance/performance';
import {
  blackLitterman,
  concentration,
  conditionalValueAtRiskOptimize,
  minVariance,
} from '@insiderfinance/totalfinance/risk';
import {
  atmTermStructure,
  eventVolatilityDecomposition,
  forwardVolatility,
  volatilitySurface,
} from '@insiderfinance/totalfinance/volatility';

describe('docs: benchmark-relative performance', () => {
  it('analyze adds alpha/beta/tracking/IR when a benchmark is supplied', () => {
    const strat = [0.012, -0.004, 0.018, 0.003, -0.002, 0.01];
    const bench = [0.008, -0.003, 0.012, 0.002, -0.003, 0.006];
    const summary = analyze(
      { equity: equityCurve(strat, 100) },
      { periodsPerYear: 252, benchmark: bench },
    );
    expect(summary.beta).toBeGreaterThan(0);
    expect(summary.informationRatio).not.toBeUndefined();
    expect(summary.profitFactor).toBeGreaterThan(1); // more gains than losses
  });
});

describe('docs: optimization with views, tail risk, and constraints', () => {
  const covariance = [
    [0.04, 0.006, 0.002],
    [0.006, 0.05, 0.004],
    [0.002, 0.004, 0.06],
  ];

  it('Black-Litterman blends a market prior with a view', () => {
    const bl = blackLitterman({
      covariance,
      marketWeights: [0.4, 0.35, 0.25],
      views: [{ pick: [1, 0, -1], view: 0.02 }], // asset 0 outperforms asset 2 by 2%
      constraints: { longOnly: true },
    });
    expect(bl.value.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(bl.value.posteriorMean).toHaveLength(3);
  });

  it('CVaR optimization minimizes tail loss; min-variance honors a sector cap', () => {
    const scenarios = Array.from({ length: 40 }, (_, s) => [
      0.01 * Math.sin(s),
      s < 4 ? -0.25 : 0.015, // asset 1 carries the crash scenarios
      0.008 * Math.cos(s),
    ]);
    const conditionalValueAtRisk = conditionalValueAtRiskOptimize(scenarios, {
      alpha: 0.9,
      longOnly: true,
    });
    expect(conditionalValueAtRisk.value.weights[1]!).toBeLessThan(0.5); // underweight the fat-tailed name

    const capped = minVariance(covariance, {
      longOnly: true,
      groups: [{ members: [0, 1], max: 0.6 }],
    });
    expect(capped.value.weights[0]! + capped.value.weights[1]!).toBeLessThanOrEqual(0.6 + 1e-4);
  });

  it('concentration summarizes how diversified a book is', () => {
    const c = concentration([0.5, 0.3, 0.2]);
    expect(c.effectiveCount).toBeGreaterThan(1);
    expect(c.effectiveCount).toBeLessThan(3); // less than perfectly equal-weight
  });
});

describe('docs: Heston surface, term structure, and event vol', () => {
  const asOf = Date.UTC(2026, 0, 1);
  const spot = 100;
  const rate = 0.03;
  const E0 = '2026-04-02';
  const E1 = '2026-09-02';
  const parameters: HestonParameters = {
    v0: 0.04,
    kappa: 1.5,
    theta: 0.045,
    sigma: 0.3,
    rho: -0.6,
  };
  const chain = (): OptionQuote[] => {
    const rows: OptionQuote[] = [];
    for (const e of [E0, E1]) {
      const t = yearFraction(asOf, Date.parse(`${e}T00:00:00Z`), 'ACT/365F');
      for (const k of [90, 95, 100, 105, 110]) {
        const impliedVolatility = hestonImpliedVolatility({
          type: 'call',
          input: { spot, strike: k, timeToExpiryYears: t, riskFreeRate: rate, dividendYield: 0 },
          parameters,
        }).value;
        rows.push({
          contract: {
            underlying: 'X',
            type: 'call',
            style: 'european',
            strike: k,
            expiry: e,
            ...resolvedExpiry(e),
          },
          timestampMs: asOf,
          impliedVolatility,
          underlyingPrice: spot,
        });
      }
    }
    return rows;
  };

  it('fits a global Heston surface and reads its term structure', () => {
    const surf = volatilitySurface({
      quotes: chain(),
      market: { riskFreeRate: rate, asOf, spot },
      config: { model: 'heston' },
    });
    expect(surf.heston).toBeDefined();
    const ts = atmTermStructure(surf);
    expect(ts.points).toHaveLength(2);
    expect(forwardVolatility(surf, E0, E1)).toBeGreaterThan(0); // forward-starting ATM vol
  });

  it('decomposes an earnings-spanning vol into base + event jump', () => {
    const d = eventVolatilityDecomposition({
      atmVolatility: 0.6,
      timeToExpiryYears: 0.05,
      baseVolatility: 0.4,
    });
    expect(d.eventMove).toBeGreaterThan(0); // an implied earnings move was extracted
  });
});
