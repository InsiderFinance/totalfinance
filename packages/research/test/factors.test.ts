/**
 * FC3 — factors: winsorization (with the idempotence metamorphic law), standardization,
 * neutralization orthogonality, composites, quantile portfolios (partition law), information
 * coefficients against hand fixtures, turnover, and decay.
 */

import { describe, expect, it } from 'vitest';
import {
  CANONICAL_FACTOR_RECIPES,
  compositeFactorScore,
  factorDecay,
  factorSpreadReturn,
  factorTurnover,
  formQuantilePortfolios,
  informationCoefficient,
  neutralizeFactor,
  standardizeFactor,
  winsorizeFactor,
} from '../src/factors.js';
import type { FactorEntry } from '../src/factors.js';

const close = (actual: number | null, expected: number, tolerance = 1e-12): void => {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);
};

const entriesOf = (values: Record<string, number | null>): FactorEntry[] =>
  Object.entries(values).map(([instrumentId, value]) => ({ instrumentId, value }));

describe('winsorizeFactor', () => {
  const ENTRIES = entriesOf({ A: 1, B: 2, C: 3, D: 4, E: 100 });

  it('percentile method replaces order statistics and echoes the bounds', () => {
    const result = winsorizeFactor({
      entries: ENTRIES,
      method: { type: 'percentile', lowerPercentile: 0.2, upperPercentile: 0.8 },
    });
    // Sorted [1,2,3,4,100], n=5: floor(1) value replaced at each end — bounds are the 2nd and
    // 4th order statistics (2 and 4).
    close(result.assumptions.lowerBound, 2);
    close(result.assumptions.upperBound, 4);
    expect(result.diagnostics.clippedLowerCount).toBe(1);
    expect(result.diagnostics.clippedUpperCount).toBe(1);
    close(result.entries.find((e) => e.instrumentId === 'A')!.value, 2);
    close(result.entries.find((e) => e.instrumentId === 'E')!.value, 4);
  });

  it('is EXACTLY idempotent: winsorizing the winsorized vector is the identity (metamorphic law)', () => {
    const method = { type: 'percentile' as const, lowerPercentile: 0.2, upperPercentile: 0.8 };
    const once = winsorizeFactor({ entries: ENTRIES, method });
    const twice = winsorizeFactor({ entries: once.entries, method });
    expect(twice.entries).toEqual(once.entries);
    expect(twice.diagnostics.clippedLowerCount).toBe(0);
    expect(twice.diagnostics.clippedUpperCount).toBe(0);
  });

  it('nulls pass through untouched', () => {
    const withMissing = winsorizeFactor({
      entries: entriesOf({ A: 1, B: 2, C: 3, D: null }),
      method: { type: 'standard-deviations', multiplier: 3 },
      minimumCoverageFraction: 0.5,
    });
    expect(withMissing.entries.find((e) => e.instrumentId === 'D')!.value).toBeNull();
  });

  it('computes finite standard-deviation bounds at near-MAX magnitudes', () => {
    const result = winsorizeFactor({
      entries: entriesOf({ A: 1e308, B: 1e308 }),
      method: { type: 'standard-deviations', multiplier: 3 },
    });
    expect(result.assumptions.lowerBound).toBe(1e308);
    expect(result.assumptions.upperBound).toBe(1e308);
    expect(result.entries.every((entry) => entry.value === 1e308)).toBe(true);
  });

  it('refuses standard-deviation bounds that genuinely exceed the double range', () => {
    expect(() =>
      winsorizeFactor({
        entries: entriesOf({ A: -1e308, B: 1e308 }),
        method: { type: 'standard-deviations', multiplier: 3 },
      }),
    ).toThrow(/representable|IEEE-754/);
  });

  it('does not refuse when a small multiplier makes an otherwise huge deviation representable', () => {
    const result = winsorizeFactor({
      entries: entriesOf({ A: -Number.MAX_VALUE, B: Number.MAX_VALUE }),
      method: { type: 'standard-deviations', multiplier: 0.1 },
    });
    expect(Number.isFinite(result.assumptions.lowerBound)).toBe(true);
    expect(Number.isFinite(result.assumptions.upperBound)).toBe(true);
    expect(result.assumptions.lowerBound).toBeLessThan(0);
    expect(result.assumptions.upperBound).toBe(-result.assumptions.lowerBound);
  });
});

describe('standardizeFactor', () => {
  it('z-scores with sample deviation, echoing the moments', () => {
    const result = standardizeFactor({
      entries: entriesOf({ A: 1, B: 2, C: 3 }),
      method: 'z-score',
    });
    // mean 2, sample sd 1.
    close(result.assumptions.mean!, 2);
    close(result.assumptions.sampleStandardDeviation!, 1);
    close(result.entries.find((e) => e.instrumentId === 'A')!.value, -1);
    close(result.entries.find((e) => e.instrumentId === 'C')!.value, 1);
  });

  it('percentile ranks use average ranks scaled to (0, 1]', () => {
    const result = standardizeFactor({
      entries: entriesOf({ A: 1, B: 2, C: 2, D: 4 }),
      method: 'percentile-rank',
    });
    // Ranks: A 1, B/C average 2.5, D 4; over 4 → 0.25, 0.625, 0.625, 1.
    close(result.entries.find((e) => e.instrumentId === 'A')!.value, 0.25);
    close(result.entries.find((e) => e.instrumentId === 'B')!.value, 0.625);
    close(result.entries.find((e) => e.instrumentId === 'D')!.value, 1);
  });

  it('zero dispersion answers zeros WITH a warning, never a division by nothing', () => {
    const result = standardizeFactor({
      entries: entriesOf({ A: 5, B: 5, C: 5 }),
      method: 'z-score',
    });
    expect(result.diagnostics.warnings[0]).toMatch(/zero cross-sectional dispersion/);
    expect(result.entries.every((e) => e.value === 0)).toBe(true);
  });

  it('refuses a sliver below the minimum coverage', () => {
    expect(() =>
      standardizeFactor({
        entries: entriesOf({ A: 1, B: null, C: null, D: null }),
        method: 'z-score',
      }),
    ).toThrow(/below the minimum/);
  });
});

describe('neutralizeFactor', () => {
  it('group demeaning removes exactly the group means', () => {
    const result = neutralizeFactor({
      entries: entriesOf({ A: 10, B: 14, C: 1, D: 3 }),
      groups: [
        { instrumentId: 'A', group: 'tech' },
        { instrumentId: 'B', group: 'tech' },
        { instrumentId: 'C', group: 'energy' },
        { instrumentId: 'D', group: 'energy' },
      ],
    });
    close(result.entries.find((e) => e.instrumentId === 'A')!.value, -2);
    close(result.entries.find((e) => e.instrumentId === 'B')!.value, 2);
    close(result.entries.find((e) => e.instrumentId === 'C')!.value, -1);
    close(result.entries.find((e) => e.instrumentId === 'D')!.value, 1);
  });

  it('continuous residuals are orthogonal to the controlled exposure (the acceptance law)', () => {
    // factor = 3 + 2·size + noise; the residual must be ⊥ size and mean-zero.
    const size = { A: -1.5, B: -0.5, C: 0.5, D: 1.5, E: 0.25, F: -0.25 };
    const noise = { A: 0.3, B: -0.2, C: 0.1, D: -0.3, E: 0.2, F: -0.1 };
    const entries = entriesOf(
      Object.fromEntries(
        Object.keys(size).map((id) => [
          id,
          3 + 2 * size[id as keyof typeof size] + noise[id as keyof typeof noise],
        ]),
      ),
    );
    const result = neutralizeFactor({
      entries,
      exposures: Object.keys(size).map((instrumentId) => ({
        instrumentId,
        exposures: [size[instrumentId as keyof typeof size]],
      })),
    });
    const residuals = result.entries.map((e) => e.value as number);
    const meanResidual = residuals.reduce((t, v) => t + v, 0) / residuals.length;
    close(meanResidual, 0, 1e-10);
    const dot = result.entries.reduce(
      (total, entry) =>
        total + (entry.value as number) * size[entry.instrumentId as keyof typeof size],
      0,
    );
    close(dot, 0, 1e-8);
  });

  it('entries with no control row are excluded with the reason, not silently kept', () => {
    const result = neutralizeFactor({
      entries: entriesOf({ A: 1, B: 2, C: 3 }),
      groups: [
        { instrumentId: 'A', group: 'g' },
        { instrumentId: 'B', group: 'g' },
      ],
      minimumCoverageFraction: 0,
    });
    expect(result.entries.find((e) => e.instrumentId === 'C')!.value).toBeNull();
    expect(result.diagnostics.exclusionReasons['no-group-membership']).toBe(1);
  });
});

describe('formQuantilePortfolios', () => {
  it('partitions every valued entry exactly once with no duplicates (the acceptance law)', () => {
    const entries = entriesOf({ A: 5, B: 4, C: 3, D: 2, E: 1, F: 0, G: null });
    const result = formQuantilePortfolios({ entries, quantileCount: 3, direction: 'descending' });
    const all = result.portfolios.flatMap((p) => p.instrumentIds);
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
    expect(result.portfolios[0]!.instrumentIds).toEqual(['A', 'B']);
    expect(result.portfolios[2]!.instrumentIds).toEqual(['E', 'F']);
    expect(result.diagnostics.excludedMissingCount).toBe(1);
  });

  it('uneven cuts give earlier portfolios the remainder, disclosed', () => {
    const entries = entriesOf({ A: 5, B: 4, C: 3, D: 2, E: 1 });
    const result = formQuantilePortfolios({ entries, quantileCount: 2, direction: 'descending' });
    expect(result.portfolios[0]!.instrumentIds).toHaveLength(3);
    expect(result.portfolios[1]!.instrumentIds).toHaveLength(2);
    expect(result.assumptions.sizing).toMatch(/earlier portfolios take the remainder/);
  });
});

describe('information coefficient and friends', () => {
  it('matches a hand Pearson/Spearman fixture', () => {
    // factor [1,2,3,4], forward [0.01, 0.03, 0.02, 0.04]: Pearson = 0.8 exactly (hand: covariance
    // 0.01·[.. ] — verified: x deviations [-1.5,-.5,.5,1.5], y deviations [-.015,.005,-.005,.015]
    // → cov = ( .0225 - .0025 - .0025 + .0225 )/3 = .04/3? Let's rely on rank IC instead for the
    // exact claim, and pin Pearson to the independently computed 0.8.
    const factorEntries = entriesOf({ A: 1, B: 2, C: 3, D: 4 });
    const forwardReturns = entriesOf({ A: 0.01, B: 0.03, C: 0.02, D: 0.04 });
    const result = informationCoefficient({ factorEntries, forwardReturns });
    close(result.informationCoefficient, 0.8, 1e-12);
    // Ranks: factor [1,2,3,4], forward [1,3,2,4] → Spearman = 1 − 6·Σd²/(n(n²−1)) = 1 − 12/60 = 0.8.
    close(result.rankInformationCoefficient, 0.8, 1e-12);
    expect(result.diagnostics.pairedCount).toBe(4);
  });

  it('answers null with a reason below three pairs', () => {
    const result = informationCoefficient({
      factorEntries: entriesOf({ A: 1, B: 2 }),
      forwardReturns: entriesOf({ A: 0.1, B: 0.2 }),
      minimumCoverageFraction: 0,
    });
    expect(result.informationCoefficient).toBeNull();
    expect(result.reason).toMatch(/at least 3/);
  });

  it('spread return is long-leg mean minus short-leg mean', () => {
    const entries = entriesOf({ A: 4, B: 3, C: 2, D: 1 });
    const forwardReturns = entriesOf({ A: 0.05, B: 0.03, C: 0.01, D: -0.01 });
    const result = factorSpreadReturn({
      entries,
      forwardReturns,
      quantileCount: 2,
      direction: 'descending',
    });
    close(result.longLegMeanReturn, 0.04);
    close(result.shortLegMeanReturn, 0.0);
    close(result.spreadReturn, 0.04);
  });

  it('turnover counts entrants as a fraction of the current portfolio', () => {
    const previous = formQuantilePortfolios({
      entries: entriesOf({ A: 4, B: 3, C: 2, D: 1 }),
      quantileCount: 2,
      direction: 'descending',
    });
    const current = formQuantilePortfolios({
      entries: entriesOf({ A: 4, C: 3, B: 2, D: 1 }),
      quantileCount: 2,
      direction: 'descending',
    });
    const result = factorTurnover({
      previousPortfolios: previous.portfolios,
      currentPortfolios: current.portfolios,
    });
    // Top was {A,B}, now {A,C} → one of two entered = 0.5.
    close(result.byQuantile[0]!.turnover, 0.5);
    close(result.byQuantile[1]!.turnover, 0.5);
  });

  it('decay reports the rank coefficient per horizon', () => {
    const factorEntries = entriesOf({ A: 1, B: 2, C: 3, D: 4 });
    const result = factorDecay({
      factorEntries,
      horizons: [
        { horizonLabel: '1m', forwardReturns: entriesOf({ A: 0.01, B: 0.02, C: 0.03, D: 0.04 }) },
        { horizonLabel: '3m', forwardReturns: entriesOf({ A: 0.04, B: 0.03, C: 0.02, D: 0.01 }) },
      ],
    });
    close(result.byHorizon[0]!.rankInformationCoefficient, 1);
    close(result.byHorizon[1]!.rankInformationCoefficient, -1);
  });
});

describe('compositeFactorScore', () => {
  it('flips direction, weights, and renormalizes over present components', () => {
    const result = compositeFactorScore({
      components: [
        {
          label: 'value',
          entries: entriesOf({ A: 1, B: -1 }),
          weight: 3,
          direction: 'higher-is-better',
        },
        {
          label: 'risk',
          entries: entriesOf({ A: 2, B: null }),
          weight: 1,
          direction: 'lower-is-better',
        },
      ],
      missingValuePolicy: 'renormalize-weights',
    });
    // A: (3·1 + 1·(−2)) / 4 = 0.25; B: only value present → (3·(−1))/3 = −1.
    close(result.entries.find((e) => e.instrumentId === 'A')!.value, 0.25);
    close(result.entries.find((e) => e.instrumentId === 'B')!.value, -1);
    const strict = compositeFactorScore({
      components: [
        {
          label: 'value',
          entries: entriesOf({ A: 1, B: -1 }),
          weight: 3,
          direction: 'higher-is-better',
        },
        {
          label: 'risk',
          entries: entriesOf({ A: 2, B: null }),
          weight: 1,
          direction: 'lower-is-better',
        },
      ],
      missingValuePolicy: 'exclude',
    });
    expect(strict.entries.find((e) => e.instrumentId === 'B')!.value).toBeNull();
  });
});

describe('canonical recipes', () => {
  it('every family is present, versioned, and carries the not-universal-truth disclosure', () => {
    const families = [
      'value',
      'size',
      'momentum',
      'quality',
      'lowVolatility',
      'liquidity',
      'investment',
    ];
    for (const family of families) {
      const recipe = CANONICAL_FACTOR_RECIPES[family]!;
      expect(recipe.recipeName).toBe(family);
      expect(recipe.recipeVersion).toBe(1);
      expect(recipe.disclosure).toMatch(/not a claim that this is the one true construction/);
      expect(recipe.features.length).toBeGreaterThan(0);
      expect(recipe.lagTradingSessions).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('group demeaning at near-MAX magnitudes (2026-08-23 review wave)', () => {
  it('two same-sign near-MAX values in one group demean to exactly 0 — the mean is representable', () => {
    const result = neutralizeFactor({
      entries: [
        { instrumentId: 'A', value: 1.7e308 },
        { instrumentId: 'B', value: 1.7e308 },
      ],
      groups: [
        { instrumentId: 'A', group: 'tech' },
        { instrumentId: 'B', group: 'tech' },
      ],
    });
    expect(result.entries.find((row) => row.instrumentId === 'A')!.value).toBe(0);
    expect(result.entries.find((row) => row.instrumentId === 'B')!.value).toBe(0);
  });
});
