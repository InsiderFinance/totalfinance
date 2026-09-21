/**
 * Runnable research-hygiene examples (spec §15.5). Each snippet executes in CI with assertions so the
 * deflated-Sharpe / multiple-testing / cross-validation docs cannot drift from working code.
 */

import { describe, expect, it } from 'vitest';
import {
  adjustPValues,
  deflatedSharpeRatio,
  purgedKFold,
  sharpeStatistics,
} from '@totalfinance/risk/research';

describe('docs: is the best backtest real, or the luckiest of many?', () => {
  it('deflates a selected strategy Sharpe by the number of trials', () => {
    // the winning config's daily returns (here, a clean positive-drift series)
    const winner = Array.from({ length: 756 }, (_, i) => 0.0006 + 0.01 * Math.sin(i / 3));
    const stats = sharpeStatistics(winner);

    // 200 parameter combinations were tried; pass their Sharpes so the dispersion is known
    const trialSharpes = Array.from({ length: 200 }, (_, i) => 0.02 + 0.05 * Math.cos(i));
    const { deflatedSharpe, probabilisticSharpe, expectedMaxSharpe } = deflatedSharpeRatio(stats, {
      trialSharpes,
    });

    expect(probabilisticSharpe).toBeGreaterThan(0); // PSR vs a zero benchmark
    expect(expectedMaxSharpe).toBeGreaterThan(0); // the best-of-N chance level
    expect(deflatedSharpe).toBeLessThanOrEqual(probabilisticSharpe!); // selection penalty applied
  });
});

describe('docs: control false discoveries across many signals', () => {
  it('Benjamini–Hochberg flags the truly significant p-values at a 5% FDR', () => {
    const pValues = [0.001, 0.008, 0.02, 0.04, 0.2, 0.6];
    const { rejected } = adjustPValues(pValues, { method: 'benjaminiHochberg', alpha: 0.05 });
    expect(rejected.filter(Boolean).length).toBeGreaterThan(0);
    expect(rejected[5]).toBe(false); // the obviously-null signal is not rejected
  });
});

describe('docs: leakage-free time-series cross-validation', () => {
  it('purged & embargoed K-fold keeps train and test disjoint', () => {
    const folds = purgedKFold(1000, { folds: 6, embargo: 0.01, purgeGap: 5 });
    expect(folds).toHaveLength(6);
    for (const { train, test } of folds) {
      const testSet = new Set(test);
      expect(train.some((i) => testSet.has(i))).toBe(false);
    }
  });
});
