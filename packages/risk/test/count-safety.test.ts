/**
 * 2026-08-23 review P0 — count/resource safety, library-wide wave.
 *
 * `Number.isInteger(1e308)` is `true`, and above 2^53 a loop counter stops advancing — so a public
 * workload control validated with `Number.isInteger` and then looped over or allocated against was
 * a non-terminating loop or an absurd allocation. Every guard this file exercises now requires
 * `Number.isSafeInteger`, and every count that drives synchronous loops/allocation additionally
 * carries an operation-appropriate cap. These tests are the discriminators whose absence permitted
 * the defect: for each capped site — `2^53` refused typed, `1e308` refused typed, `cap + 1` refused
 * naming the bound, a realistic value accepted; for safe-int-only (data/domain-bounded) sites —
 * `2^53` refused and non-integers still refused.
 */

import { describe, expect, it } from 'vitest';
import { isQuantError } from '@totalfinance/core';
import { strategy } from '@totalfinance/strategy';
import {
  bookVaR,
  type BookVaRPosition,
  conditionalValueAtRiskOptimize,
  deflatedSharpeRatio,
  factorExposure,
  meanExcessPlot,
  minVariance,
  portfolioVaR,
  probabilityOfBacktestOverfitting,
  purgedKFold,
  sharpeStatistics,
  valueAtRiskReport,
  walkForwardSplits,
} from '@totalfinance/risk';

/** Capture the thrown value (the guards must throw typed QuantErrors, never return). */
function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

const UNSAFE_COUNTS = [2 ** 53, 1e308] as const;

/** A deterministic 400-observation return series with real dispersion. */
const RETURNS = Array.from({ length: 400 }, (_, i) => 0.01 * Math.sin(i / 3) + 0.002 * Math.cos(i));

const COV_2 = [
  [0.04, 0.01],
  [0.01, 0.09],
];

describe('value-at-risk — Monte-Carlo samples are safe integers capped at 1,000,000', () => {
  it('valueAtRiskReport refuses 2^53 / 1e308 / cap + 1 samples typed, and accepts a realistic count', () => {
    for (const bad of [...UNSAFE_COUNTS, 1_000_001, 2.5]) {
      const caught = catching(() =>
        valueAtRiskReport(RETURNS, { method: 'monteCarlo', samples: bad }),
      );
      expect(isQuantError(caught, 'input.out_of_range'), `samples ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('samples');
    }
    // The refusal just above the cap teaches the bound and the work it prices.
    const atCapPlusOne = catching(() =>
      valueAtRiskReport(RETURNS, { method: 'monteCarlo', samples: 1_000_001 }),
    );
    expect(String((atCapPlusOne as Error).message)).toContain('1,000,000');
    const accepted = valueAtRiskReport(RETURNS, { method: 'monteCarlo', samples: 5_000, seed: 7 });
    expect(accepted.valueAtRisk).toBeGreaterThan(0);
  });

  it('monteCarloPortfolioVaR refuses 2^53 / 1e308 / cap + 1 samples typed, and accepts a realistic count', () => {
    const base = { weights: [0.5, 0.5], covariance: COV_2 };
    for (const bad of [...UNSAFE_COUNTS, 1_000_001, 2.5]) {
      const caught = catching(() =>
        portfolioVaR({ method: 'monteCarlo', ...base, options: { samples: bad } }),
      );
      expect(isQuantError(caught, 'input.out_of_range'), `samples ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('samples');
    }
    const atCapPlusOne = catching(() =>
      portfolioVaR({ method: 'monteCarlo', ...base, options: { samples: 1_000_001 } }),
    );
    expect(String((atCapPlusOne as Error).message)).toContain('1,000,000');
    const accepted = portfolioVaR({
      method: 'monteCarlo',
      ...base,
      options: { samples: 4_000, seed: 3 },
    });
    expect(accepted.valueAtRisk).toBeGreaterThan(0);
  });

  it('every seed gate (shared entry, MC branch, portfolio MC) refuses a 2^53 seed — adjacent "different" seeds collide up there', () => {
    // Shared entry: the seed is validated even when the method never consumes it.
    for (const bad of [2 ** 53, 1.5]) {
      const historical = catching(() => valueAtRiskReport(RETURNS, { seed: bad }));
      expect(isQuantError(historical, 'input.out_of_range'), `shared-entry seed ${bad}`).toBe(true);
      const monteCarlo = catching(() =>
        valueAtRiskReport(RETURNS, { method: 'monteCarlo', seed: bad }),
      );
      expect(isQuantError(monteCarlo, 'input.out_of_range'), `MC seed ${bad}`).toBe(true);
      const portfolio = catching(() =>
        portfolioVaR({
          method: 'monteCarlo',
          weights: [0.5, 0.5],
          covariance: COV_2,
          options: { seed: bad },
        }),
      );
      expect(isQuantError(portfolio, 'input.out_of_range'), `portfolio seed ${bad}`).toBe(true);
    }
  });
});

describe('bookVaR — samples/seed are safe integers, the 1,000,000 cap teaches its price', () => {
  const book: BookVaRPosition[] = [
    {
      position: strategy([{ kind: 'stock', price: 100, quantity: 100 }], {
        multiplier: 100,
        expiry: '2026-09-18',
      }),
      market: { spot: 100, riskFreeRate: 0.04, asOf: '2026-05-01T00:00:00Z' },
      underlying: 'XYZ',
    },
  ];
  const factors = { XYZ: { spotReturnVolatility: 0.2 } };

  it('refuses 2^53 / 1e308 / cap + 1 samples typed and accepts a realistic count', () => {
    for (const bad of [...UNSAFE_COUNTS, 1_000_001, 2.5]) {
      const caught = catching(() => bookVaR(book, { factors, samples: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `samples ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('samples');
    }
    const atCapPlusOne = catching(() => bookVaR(book, { factors, samples: 1_000_001 }));
    expect(String((atCapPlusOne as Error).message)).toContain('1,000,000');
    const accepted = bookVaR(book, { factors, samples: 2_000, seed: 7 });
    expect(accepted.monteCarlo!.valueAtRisk).toBeGreaterThan(0);
  });

  it('refuses a 2^53 or fractional seed typed', () => {
    for (const bad of [2 ** 53, 7.5]) {
      const caught = catching(() => bookVaR(book, { factors, samples: 100, seed: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `seed ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('seed');
    }
  });
});

describe('research splitters — per-count safe integers plus a 50,000,000 product bound on materialized entries', () => {
  it('walkForwardSplits refuses 2^53 / 1e308 / fractional counts typed on every parameter', () => {
    const options = { trainSize: 10, testSize: 5 };
    for (const bad of [...UNSAFE_COUNTS, 10.5]) {
      expect(
        isQuantError(
          catching(() => walkForwardSplits(bad, options)),
          'input.out_of_range',
        ),
        `observationCount ${bad}`,
      ).toBe(true);
      expect(
        isQuantError(
          catching(() => walkForwardSplits(100, { trainSize: bad, testSize: 5 })),
          'input.out_of_range',
        ),
        `trainSize ${bad}`,
      ).toBe(true);
      expect(
        isQuantError(
          catching(() => walkForwardSplits(100, { trainSize: 10, testSize: bad })),
          'input.out_of_range',
        ),
        `testSize ${bad}`,
      ).toBe(true);
      expect(
        isQuantError(
          catching(() => walkForwardSplits(100, { trainSize: 10, testSize: 5, step: bad })),
          'input.out_of_range',
        ),
        `step ${bad}`,
      ).toBe(true);
    }
  });

  it('walkForwardSplits refuses a safe-integer request whose PRODUCT would materialize > 50,000,000 entries — computed closed-form, before any loop', () => {
    // 10^8 observations, 3-entry windows, step 1: ~3·10^8 index entries. Each factor is a safe
    // integer; only the product is absurd. The refusal must be instant (arithmetic, not a loop).
    const start = Date.now();
    const caught = catching(() =>
      walkForwardSplits(100_000_000, { trainSize: 1, testSize: 2, step: 1 }),
    );
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toContain('50,000,000');
    // A realistic request still works.
    const splits = walkForwardSplits(1_000, { trainSize: 100, testSize: 50 });
    expect(splits.length).toBeGreaterThan(0);
    expect(splits[0]!.train).toHaveLength(100);
  });

  it('purgedKFold refuses 2^53 folds/purgeGap typed and a > 50,000,000 folds × observationCount product', () => {
    for (const bad of [...UNSAFE_COUNTS, 5.5]) {
      expect(
        isQuantError(
          catching(() => purgedKFold(100, { folds: bad })),
          'input.out_of_range',
        ),
        `folds ${bad}`,
      ).toBe(true);
      expect(
        isQuantError(
          catching(() => purgedKFold(100, { folds: 5, purgeGap: bad })),
          'input.out_of_range',
        ),
        `purgeGap ${bad}`,
      ).toBe(true);
    }
    // folds and observationCount individually plausible; the product (10^8) is the absurdity.
    const start = Date.now();
    const caught = catching(() => purgedKFold(1_000_000, { folds: 100 }));
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
    expect(String((caught as Error).message)).toContain('50,000,000');
    // A realistic request still works.
    const splits = purgedKFold(500, { folds: 5, purgeGap: 2 });
    expect(splits).toHaveLength(5);
  });
});

describe('deflatedSharpeRatio / probabilityOfBacktestOverfitting — exact counts', () => {
  const stats = sharpeStatistics(RETURNS);

  it('deflatedSharpeRatio refuses a 2^53 or fractional trialCount typed (closed-form use, but the count must be exact)', () => {
    for (const bad of [2 ** 53, 1e308, 5.5]) {
      const caught = catching(() =>
        deflatedSharpeRatio(stats, { trialCount: bad, varianceSharpe: 0.01 }),
      );
      expect(isQuantError(caught, 'input.out_of_range'), `trialCount ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('trialCount');
    }
    expect(
      deflatedSharpeRatio(stats, { trialCount: 50, varianceSharpe: 0.01 }).expectedMaxSharpe,
    ).toBeGreaterThan(0);
  });

  it('probabilityOfBacktestOverfitting refuses 2^53 / fractional splits typed (the [4, 16] range already bounds the partitions)', () => {
    const matrix = Array.from({ length: 16 }, (_, t) => [
      Math.sin(t),
      Math.cos(t),
      Math.sin(t / 2),
    ]);
    for (const bad of [2 ** 53, 1e308, 4.5]) {
      const caught = catching(() => probabilityOfBacktestOverfitting(matrix, { splits: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `splits ${bad}`).toBe(true);
    }
    const r = probabilityOfBacktestOverfitting(matrix, { splits: 4 });
    expect(r.backtestOverfittingProbability).toBeGreaterThanOrEqual(0);
    expect(r.backtestOverfittingProbability).toBeLessThanOrEqual(1);
  });
});

describe('meanExcessPlot — gridSize is a safe integer capped at 10,000 (each point rescans the losses twice)', () => {
  const returns = Array.from({ length: 300 }, (_, i) => -((i % 120) + 1) / 1000);

  it('refuses 2^53 / 1e308 / cap + 1 typed naming the bound, and accepts a realistic grid', () => {
    for (const bad of [...UNSAFE_COUNTS, 10_001, 25.5]) {
      const caught = catching(() => meanExcessPlot(returns, { gridSize: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `gridSize ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('gridSize');
    }
    const atCapPlusOne = catching(() => meanExcessPlot(returns, { gridSize: 10_001 }));
    expect(String((atCapPlusOne as Error).message)).toContain('10,000');
    expect(meanExcessPlot(returns, { gridSize: 50 }).points.length).toBeGreaterThan(0);
    // minExceedances is data-bounded but must be an exact count.
    expect(
      isQuantError(
        catching(() => meanExcessPlot(returns, { minExceedances: 2 ** 53 })),
        'input.out_of_range',
      ),
    ).toBe(true);
  });
});

describe('optimizers — iteration budgets are safe integers capped at 1,000,000', () => {
  it('minVariance refuses 2^53 / 1e308 / cap + 1 maximumIterations typed, and accepts a realistic budget', () => {
    for (const bad of [...UNSAFE_COUNTS, 1_000_001, 100.5]) {
      const caught = catching(() => minVariance(COV_2, { maximumIterations: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `maximumIterations ${bad}`).toBe(true);
      expect(String((caught as Error).message)).toContain('maximumIterations');
    }
    const atCapPlusOne = catching(() => minVariance(COV_2, { maximumIterations: 1_000_001 }));
    expect(String((atCapPlusOne as Error).message)).toContain('1,000,000');
    const r = minVariance(COV_2, { longOnly: true, maximumIterations: 2_000 });
    expect(r.value.weights[0]! + r.value.weights[1]!).toBeCloseTo(1, 4);
  });

  it('conditionalValueAtRiskOptimize refuses 2^53 / 1e308 / cap + 1 budgets typed, and accepts a realistic budget', () => {
    const scenarios: number[][] = Array.from({ length: 20 }, (_, i) => [
      i % 2 === 0 ? 0.01 : -0.01,
      i < 2 ? -0.3 : 0.02,
    ]);
    for (const bad of [...UNSAFE_COUNTS, 1_000_001, 40.5]) {
      const caught = catching(() =>
        conditionalValueAtRiskOptimize(scenarios, {
          maximumIterations: bad,
        }),
      );
      expect(isQuantError(caught, 'input.out_of_range'), `maximumIterations ${bad}`).toBe(true);
    }
    const atCapPlusOne = catching(() =>
      conditionalValueAtRiskOptimize(scenarios, {
        maximumIterations: 1_000_001,
      }),
    );
    expect(String((atCapPlusOne as Error).message)).toContain('1,000,000');
    const res = conditionalValueAtRiskOptimize(scenarios, {
      alpha: 0.9,
      longOnly: true,
      maximumIterations: 500,
    });
    expect(Number.isFinite(res.value.conditionalValueAtRisk)).toBe(true);
  });

  it('group member indices must be safe integers (data-bounded when the asset count is known)', () => {
    const caught = catching(() =>
      minVariance(COV_2, { longOnly: true, groups: [{ members: [2 ** 53], max: 0.5 }] }),
    );
    expect(isQuantError(caught, 'input.out_of_range')).toBe(true);
  });
});

describe('factorExposure — factorCount is a safe integer (Math.min keeps it data-bounded)', () => {
  it('refuses 2^53 / fractional factorCount typed and accepts a realistic one', () => {
    for (const bad of [2 ** 53, 1e308, 1.5]) {
      const caught = catching(() => factorExposure(COV_2, { factorCount: bad }));
      expect(isQuantError(caught, 'input.out_of_range'), `factorCount ${bad}`).toBe(true);
    }
    expect(factorExposure(COV_2, { factorCount: 1 }).factors).toHaveLength(1);
  });
});
