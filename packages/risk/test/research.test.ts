import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { mulberry32, normalSample } from '@totalfinance/math';
import {
  type Split,
  adjustPValues,
  checkLeakage,
  deflatedSharpeRatio,
  parameterSweepDiagnostics,
  probabilisticSharpeRatio,
  probabilityOfBacktestOverfitting,
  purgedKFold,
  sharpeStatistics,
  survivorshipWarning,
  walkForwardSplits,
} from '@totalfinance/risk/research';

// a long, mildly-positive-Sharpe return series (deterministic)
function returns(n: number, mu: number, sigma: number, seed: number): number[] {
  const randomNumberGenerator = mulberry32(seed);
  return Array.from({ length: n }, () => mu + sigma * normalSample(randomNumberGenerator));
}

describe('probabilistic Sharpe ratio', () => {
  const r = returns(500, 0.001, 0.01, 11); // SR ≈ 0.1 per period
  const stats = sharpeStatistics(r);

  it('PSR against the observed Sharpe itself is exactly 0.5', () => {
    expect(probabilisticSharpeRatio(stats, stats.sharpe!)).toBeCloseTo(0.5, 12);
  });

  it('is high against a zero benchmark for a positive-Sharpe series, and monotone in the benchmark', () => {
    const psr0 = probabilisticSharpeRatio(stats, 0);
    expect(psr0).toBeGreaterThan(0.9);
    // The applied benchmark default is echoed on the explained companion (dx §2.4).
    expect(probabilisticSharpeRatio.explain(stats, 0).assumptions).toMatchObject({
      benchmarkSharpe: 0,
      observations: 500,
    });
    expect(probabilisticSharpeRatio(stats, stats.sharpe! * 0.5)).toBeLessThan(psr0!);
    expect(probabilisticSharpeRatio(stats, stats.sharpe! * 2)).toBeLessThan(0.5);
  });

  it('a zero-variance series has no Sharpe: null with a diagnostic, never a refusal (C hygiene)', () => {
    const flat = sharpeStatistics([0.01, 0.01, 0.01, 0.01]);
    expect(flat.sharpe).toBeNull();
    expect(flat.observations).toBe(4);
    expect(flat.diagnostics.warnings.map((w) => w.code)).toEqual(['risk.sharpe_undefined']);
    expect(probabilisticSharpeRatio(flat)).toBeNull();
    const explained = probabilisticSharpeRatio.explain(flat, 0.1);
    expect(explained.value).toBeNull();
    expect(explained.diagnostics.warnings[0]!.code).toBe('risk.sharpe_undefined');
    const deflated = deflatedSharpeRatio(flat, { trialCount: 5, varianceSharpe: 0.01 });
    expect(deflated.deflatedSharpe).toBeNull();
    expect(deflated.probabilisticSharpe).toBeNull();
    expect(deflated.diagnostics.warnings.map((w) => w.code)).toEqual(['risk.sharpe_undefined']);
  });
});

describe('deflated Sharpe ratio', () => {
  const stats = sharpeStatistics(returns(750, 0.0008, 0.01, 3));

  it('deflates below the un-deflated PSR and shrinks as the number of trials grows', () => {
    const trials = Array.from({ length: 50 }, (_, i) => 0.05 + 0.03 * Math.sin(i));
    const res = deflatedSharpeRatio(stats, { trialSharpes: trials });
    expect(res.deflatedSharpe).toBeLessThan(res.probabilisticSharpe!);
    expect(res.expectedMaxSharpe).toBeGreaterThan(0);

    // more trials ⇒ higher expected-max benchmark ⇒ lower deflated Sharpe
    const few = deflatedSharpeRatio(stats, { trialCount: 5, varianceSharpe: 0.01 });
    const many = deflatedSharpeRatio(stats, { trialCount: 500, varianceSharpe: 0.01 });
    expect(many.expectedMaxSharpe).toBeGreaterThan(few.expectedMaxSharpe);
    expect(many.deflatedSharpe).toBeLessThan(few.deflatedSharpe!);
  });

  it('parameterSweepDiagnostics reports the winner honestly', () => {
    const trials = [0.02, 0.05, 0.08, 0.12, 0.03, -0.01, 0.09, 0.04];
    const diag = parameterSweepDiagnostics(trials, stats);
    expect(diag.trialCount).toBe(8);
    expect(diag.bestSharpe).toBeCloseTo(0.12, 12);
    expect(diag.deflatedSharpe).toBeLessThanOrEqual(diag.probabilisticSharpe!);
  });

  it('rejects an impossible negative trial-Sharpe variance instead of clamping it to 0', () => {
    expect(() => deflatedSharpeRatio(stats, { trialCount: 10, varianceSharpe: -1 })).toThrow(
      InputError,
    );
    expect(() => deflatedSharpeRatio(stats, { trialCount: 1, varianceSharpe: 0.01 })).toThrow(
      InputError,
    );
  });

  it('Law 2 report grammar: echoes which trials branch was resolved and the sample sizes', () => {
    const trials = Array.from({ length: 50 }, (_, i) => 0.05 + 0.03 * Math.sin(i));
    const fromSharpes = deflatedSharpeRatio(stats, { trialSharpes: trials });
    expect(fromSharpes.assumptions.conventionsVersion).toBeTruthy();
    expect(fromSharpes.assumptions['trialsFrom']).toBe('trialSharpes');
    expect(fromSharpes.assumptions['trialCount']).toBe(50);
    expect(fromSharpes.assumptions['varianceSharpe']).toBeGreaterThan(0); // estimated for you
    expect(fromSharpes.assumptions['observations']).toBe(stats.observations);
    expect(fromSharpes.diagnostics.warnings).toEqual([]);
    expect('value' in fromSharpes).toBe(false); // report, not envelope

    const fromCounts = deflatedSharpeRatio(stats, { trialCount: 5, varianceSharpe: 0.01 });
    expect(fromCounts.assumptions['trialsFrom']).toBe('trialCount+varianceSharpe');
    expect(fromCounts.assumptions['varianceSharpe']).toBe(0.01); // supplied, echoed verbatim
  });
});

describe('multiple-testing correction', () => {
  const p = [0.01, 0.02, 0.5];

  it('Bonferroni multiplies by the number of tests (capped at 1)', () => {
    const res = adjustPValues(p, { method: 'bonferroni', alpha: 0.05 });
    expect(res.adjusted).toEqual([0.03, 0.06, 1]);
    expect(res.rejected).toEqual([true, false, false]);
  });

  it('Šidák uses 1 − (1 − p)^m', () => {
    const res = adjustPValues(p, { method: 'sidak' });
    expect(res.adjusted[0]).toBeCloseTo(1 - 0.99 ** 3, 12);
  });

  it('Benjamini–Hochberg matches the hand-computed step-up values', () => {
    const res = adjustPValues([0.01, 0.02, 0.05], { method: 'benjaminiHochberg' });
    // q_(3)=0.05, q_(2)=min(0.05, 0.02·3/2=0.03)=0.03, q_(1)=min(0.03, 0.01·3=0.03)=0.03
    expect(res.adjusted[0]).toBeCloseTo(0.03, 12);
    expect(res.adjusted[1]).toBeCloseTo(0.03, 12);
    expect(res.adjusted[2]).toBeCloseTo(0.05, 12);
  });

  it('Holm is at least as strict as BH and preserves input order', () => {
    const holm = adjustPValues([0.04, 0.005, 0.5], { method: 'holm' });
    // sorted: 0.005,0.04,0.5 → adj 0.015, 0.08, 0.5 → mapped back to input order
    expect(holm.adjusted[1]).toBeCloseTo(0.015, 12);
    expect(holm.adjusted[0]).toBeCloseTo(0.08, 12);
    expect(holm.adjusted[2]).toBeCloseTo(0.5, 12);
  });

  it('rejects out-of-range p-values, an unknown method, or an invalid alpha', () => {
    expect(() => adjustPValues([0.1, 1.2])).toThrow(InputError);
    // @ts-expect-error — unknown method must throw, not silently behave as BH
    expect(() => adjustPValues([0.1, 0.2], { method: 'bogus' })).toThrow(InputError);
    expect(() => adjustPValues([0.1, 0.2], { alpha: null } as never)).toThrow(InputError);
    expect(() => adjustPValues([0.1, 0.2], { alpha: 0.05, typo: true } as never)).toThrow(
      InputError,
    );
    expect(() => adjustPValues([0.1, 0.2], { alpha: Number.NaN })).toThrow(InputError);
    expect(() => adjustPValues([0.1, 0.2], { alpha: 1.5 })).toThrow(InputError);
  });
});

describe('walk-forward splits', () => {
  it('rolling: train window slides forward; test windows tile and never overlap train', () => {
    const splits = walkForwardSplits(100, { trainSize: 50, testSize: 10, step: 10 });
    expect(splits).toHaveLength(5);
    expect(splits[0]).toEqual({ train: range(0, 50), test: range(50, 60) });
    expect(splits[1]!.train[0]).toBe(10); // slid forward by step
    for (const s of splits) {
      expect(new Set(s.train.filter((i) => s.test.includes(i))).size).toBe(0);
    }
  });

  it('anchored: train always starts at 0 and grows', () => {
    const splits = walkForwardSplits(100, {
      trainSize: 30,
      testSize: 20,
      step: 20,
      mode: 'anchored',
    });
    expect(splits.every((s) => s.train[0] === 0)).toBe(true);
    expect(splits[1]!.train.length).toBeGreaterThan(splits[0]!.train.length);
  });

  it('rejects an unknown mode instead of silently behaving as rolling', () => {
    expect(() =>
      // @ts-expect-error — invalid mode must throw
      walkForwardSplits(100, { trainSize: 50, testSize: 10, mode: 'sliding' }),
    ).toThrow(InputError);
  });
});

describe('purged & embargoed K-fold', () => {
  it('produces leakage-free folds that cover every index in test exactly once', () => {
    const splits = purgedKFold(100, { folds: 5, embargo: 0.02, purgeGap: 2 });
    expect(splits).toHaveLength(5);
    const covered = new Set<number>();
    for (const s of splits) {
      for (const i of s.test) covered.add(i);
      // train and test never share an index
      expect(s.train.some((i) => s.test.includes(i))).toBe(false);
    }
    expect(covered.size).toBe(100); // tests tile the whole sample
    const leakage = checkLeakage(splits);
    expect(leakage.clean).toBe(true);
    expect(leakage.leaks).toHaveLength(0);
    expect(leakage.diagnostics.warnings).toHaveLength(0);
  });

  it('purges the gap around the test block and embargoes the window after it', () => {
    const [first] = purgedKFold(100, { folds: 5, embargo: 0.05, purgeGap: 3 });
    // fold 0 test = [0,20); embargo 5 → train excludes [20,25); purge 3 → excludes [20,23) too
    expect(first!.train.includes(20)).toBe(false);
    expect(first!.train.includes(24)).toBe(false);
    expect(first!.train.includes(25)).toBe(true); // first kept index after the embargo
  });

  it('validates folds and embargo', () => {
    expect(() => purgedKFold(100, { folds: 1 })).toThrow(InputError);
    expect(() => purgedKFold(100, { folds: 5, embargo: 1.5 })).toThrow(InputError);
  });

  it('[P3] a purgeGap that empties a training set throws, teaching the largest viable one', () => {
    // n=100, folds=5 ⇒ fold span 20. The middle fold's train set is [0, 40−gap) ∪ [60+gap, 100),
    // so any gap ≥ 40 purges it to nothing. This used to return five splits whose `train` arrays
    // were silently empty — a cross-validation that fits on zero rows.
    expect(() => purgedKFold(100, { folds: 5, purgeGap: 80 })).toThrow(InputError);
    expect(() => purgedKFold(100, { folds: 5, purgeGap: 80 })).toThrow(
      /largest viable purgeGap for folds=5, embargo=0 is 39/,
    );
    expect(() => purgedKFold(100, { folds: 5, purgeGap: 40 })).toThrow(/EMPTY training set/);

    // 39 is genuinely viable — the boundary is exact, not a rounded-off guard.
    const splits = purgedKFold(100, { folds: 5, purgeGap: 39 });
    expect(splits).toHaveLength(5);
    for (const s of splits) expect(s.train.length).toBeGreaterThan(0);

    // the typed context carries the number a caller would need to fix the call
    try {
      purgedKFold(100, { folds: 5, purgeGap: 80 });
      expect.unreachable('purgedKFold should have thrown');
    } catch (e) {
      expect((e as InputError).code).toBe('input.out_of_range');
      expect((e as InputError).context?.['maxViablePurgeGap']).toBe(39);
    }
  });
});

describe('leakage & survivorship diagnostics', () => {
  it('checkLeakage flags overlapping train/test indices', () => {
    const bad: Split = { train: [0, 1, 2, 3], test: [3, 4, 5] };
    const r = checkLeakage([bad]);
    expect(r.clean).toBe(false);
    expect(r.leaks).toHaveLength(1);
    expect(r.leaks[0]!).toMatchObject({ split: 0, overlapCount: 1, sample: [3] });
    const w = r.diagnostics.warnings;
    expect(w).toHaveLength(1);
    expect(w[0]!.code).toBe('research.train_test_leakage');
    expect(w[0]!.severity).toBe('error');
  });

  it('survivorshipWarning fires only when the universe is biased', () => {
    expect(survivorshipWarning({ includesDelisted: true, pointInTimeUniverse: true })).toBeNull();
    const w = survivorshipWarning({ includesDelisted: false });
    expect(w).not.toBeNull();
    expect(w!.code).toBe('research.survivorship_bias');
  });
});

describe('probabilityOfBacktestOverfitting (CSCV)', () => {
  /** A T×N returns matrix where every cell is `f(row, col)`. */
  const matrix = (T: number, N: number, f: (r: number, c: number) => number): number[][] =>
    Array.from({ length: T }, (_, r) => Array.from({ length: N }, (_, c) => f(r, c)));

  it('a genuinely persistent edge is NOT flagged as overfit (PBO ≈ 0, median logit > 0)', () => {
    // Config 0 has a real high Sharpe in EVERY block (high mean, low variance); the rest are zero-mean
    // noise. The IS-best is always config 0, and it stays OOS-best ⇒ never below the OOS median.
    const randomNumberGenerator = mulberry32(1);
    const M = matrix(240, 8, (r, c) =>
      c === 0 ? 0.02 + 0.001 * Math.sin(r) : 0.01 * normalSample(randomNumberGenerator),
    );
    const res = probabilityOfBacktestOverfitting(M, { splits: 8 });
    expect(res.backtestOverfittingProbability).toBe(0);
    expect(res.medianLogit).toBeGreaterThan(0);
    expect(res.combinations).toBe(70); // C(8,4)
    expect(res.splits).toBe(8);
    expect(res.observations).toBe(240);
    expect(res.trials).toBe(8);
    expect(res.assumptions.conventionsVersion).toBeTruthy();
  });

  it('pure noise gives a non-degenerate PBO (the selection is worthless out of sample)', () => {
    // No config has an edge ⇒ the IS winner's OOS rank is ~uniform ⇒ PBO well away from 0 and 1.
    const randomNumberGenerator = mulberry32(42);
    const M = matrix(320, 12, () => normalSample(randomNumberGenerator) * 0.01);
    const res = probabilityOfBacktestOverfitting(M, { splits: 10 });
    expect(res.combinations).toBe(252); // C(10,5)
    expect(res.backtestOverfittingProbability).toBeGreaterThan(0.2);
    expect(res.backtestOverfittingProbability).toBeLessThan(0.8);
  });

  it('trims T to a multiple of S and discloses it; defaults to 16 splits', () => {
    const M = matrix(103, 5, (r, c) => 0.001 * ((r % 7) - 3) + 0.0003 * c);
    const res = probabilityOfBacktestOverfitting(M); // default splits = 16
    expect(res.splits).toBe(16);
    expect(res.observations).toBe(96); // 103 → 6×16
    expect(res.combinations).toBe(12870); // C(16,8)
    expect(res.diagnostics.warnings.map((w) => w.code)).toContain(
      'research.backtest_overfitting_probability_trimmed',
    );
    expect(res.backtestOverfittingProbability).toBeGreaterThanOrEqual(0);
    expect(res.backtestOverfittingProbability).toBeLessThanOrEqual(1);
  });

  it('guards the matrix shape, the split count, and unknown options', () => {
    const ok = matrix(40, 4, (r, c) => 0.001 * (r + c));
    expect(() => probabilityOfBacktestOverfitting(undefined as never)).toThrow(InputError);
    // odd / out-of-range splits
    expect(() => probabilityOfBacktestOverfitting(ok, { splits: 7 })).toThrow(/even integer/);
    expect(() => probabilityOfBacktestOverfitting(ok, { splits: 2 })).toThrow(/\[4, 16\]/);
    expect(() => probabilityOfBacktestOverfitting(ok, { splits: 18 })).toThrow(/\[4, 16\]/);
    // fewer rows than splits, and a single-column matrix (nothing to rank)
    expect(() =>
      probabilityOfBacktestOverfitting(
        matrix(4, 4, () => 0),
        { splits: 8 },
      ),
    ).toThrow(/at least/);
    expect(() =>
      probabilityOfBacktestOverfitting(
        matrix(20, 1, () => 0),
        { splits: 4 },
      ),
    ).toThrow(/at least 2/);
    // ragged matrix + non-finite cell
    const ragged = [[0.1, 0.2], [0.1]] as number[][];
    expect(() => probabilityOfBacktestOverfitting(ragged, { splits: 4 } as never)).toThrow();
    const nan = matrix(8, 4, (r, c) => (r === 3 && c === 1 ? NaN : 0.001));
    expect(() => probabilityOfBacktestOverfitting(nan, { splits: 4 })).toThrow();
    // unknown option key
    expect(() => probabilityOfBacktestOverfitting(ok, { splits: 4, bogus: 1 } as never)).toThrow();
  });
});

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, i) => start + i);
}
