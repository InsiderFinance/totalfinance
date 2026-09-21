/**
 * FC7 slice 4 (Stage 4.4) — `estimateExpectedReturns`: an explicit-method estimator whose
 * historical branch IS `meanReturns` (bit-for-bit), whose exponentially weighted branch is
 * hand-computable from three rows, whose capital-asset-pricing branch composes FC2's primitive,
 * and whose point-in-time screen excludes (and discloses) every row observed after `asOf`.
 * Every expected number below is derived in a comment next to the assertion.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode, isQuantError, resolveAsOf } from '@totalfinance/core';
import { capitalAssetPricingExpectedReturn } from '@totalfinance/valuation';
import { estimateExpectedReturns, meanReturns } from '@totalfinance/risk';

/** Capture the thrown value (the guards must throw typed QuantErrors, never return). */
function catching(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

// 4 periods × 2 assets, observations-major (rows = periods).
const RETURNS: number[][] = [
  [0.01, 0.02],
  [0.03, -0.01],
  [0.05, 0.04],
  [-0.02, 0.03],
];

describe('estimateExpectedReturns — historical-mean composes meanReturns', () => {
  it('per-period means are bit-identical to meanReturns and annualized: false', () => {
    const r = estimateExpectedReturns({ method: 'historical-mean', returns: RETURNS });
    const direct = meanReturns({ returns: RETURNS });
    expect(r.value.expectedReturns).toHaveLength(2);
    for (let k = 0; k < 2; k++) expect(r.value.expectedReturns[k]).toBe(direct[k]);
    // Hand check: asset 0 = (0.01 + 0.03 + 0.05 − 0.02) / 4 = 0.07 / 4 = 0.0175.
    expect(r.value.expectedReturns[0]).toBeCloseTo(0.0175, 15);
    expect(r.value.annualized).toBe(false);
    expect(r.assumptions.method).toBe('historical-mean');
    expect(r.assumptions.periodsPerYear).toBeUndefined();
    expect(r.assumptions.conventionsVersion).toEqual(expect.any(String));
    expect(typeof r.assumptions.estimationConvention).toBe('string');
    expect(r.assumptions.estimationConvention).toContain('per-period');
    expect(r.diagnostics.sampleSize).toBe(4);
    expect(r.diagnostics.warnings).toEqual([]);
    expect(r.diagnostics.effectiveSampleSize).toBeUndefined();
    expect(r.diagnostics.excludedAfterAsOf).toBeUndefined();
  });

  it('with periodsPerYear the means are bit-identical to meanReturns({ periodsPerYear }) and annualized: true', () => {
    const r = estimateExpectedReturns({
      method: 'historical-mean',
      returns: RETURNS,
      periodsPerYear: 12,
      assetIds: ['SPY', 'TLT'],
    });
    const direct = meanReturns({ returns: RETURNS, periodsPerYear: 12 });
    for (let k = 0; k < 2; k++) expect(r.value.expectedReturns[k]).toBe(direct[k]);
    // Hand check: 0.0175 × 12 = 0.21.
    expect(r.value.expectedReturns[0]).toBeCloseTo(0.21, 14);
    expect(r.value.annualized).toBe(true);
    expect(r.value.assetIds).toEqual(['SPY', 'TLT']);
    expect(r.assumptions.periodsPerYear).toBe(12);
    expect(r.assumptions.estimationConvention).toContain('periodsPerYear = 12');
  });

  it('periodsPerYear must be a positive finite number when present', () => {
    for (const bad of [0, -12, NaN, Infinity, null, '12']) {
      const caught = catching(() =>
        estimateExpectedReturns({
          method: 'historical-mean',
          returns: RETURNS,
          periodsPerYear: bad as never,
        }),
      );
      expect(isQuantError(caught, ErrorCode.InputOutOfRange), `periodsPerYear ${bad}`).toBe(true);
    }
  });
});

describe('estimateExpectedReturns — exponentially-weighted', () => {
  // 3 observations × 2 assets; halfLifePeriods 1 ⇒ raw weights 0.5^(2), 0.5^(1), 0.5^(0) = [0.25, 0.5, 1].
  const THREE: number[][] = [
    [0.01, 0.02],
    [0.03, -0.01],
    [0.05, 0.04],
  ];

  it('weights ∝ [0.25, 0.5, 1] (most recent heaviest), normalized to sum 1', () => {
    const r = estimateExpectedReturns({
      method: 'exponentially-weighted',
      returns: THREE,
      halfLifePeriods: 1,
    });
    // Σw = 1.75.
    // asset 0: (0.25·0.01 + 0.5·0.03 + 1·0.05) / 1.75 = (0.0025 + 0.015 + 0.05) / 1.75 = 0.0675 / 1.75
    // asset 1: (0.25·0.02 + 0.5·(−0.01) + 1·0.04) / 1.75 = (0.005 − 0.005 + 0.04) / 1.75 = 0.04 / 1.75
    expect(Math.abs(r.value.expectedReturns[0]! - 0.0675 / 1.75)).toBeLessThan(1e-12);
    expect(Math.abs(r.value.expectedReturns[1]! - 0.04 / 1.75)).toBeLessThan(1e-12);
    expect(r.value.annualized).toBe(false);
    // effectiveSampleSize = (Σw)² / Σw² = 1.75² / (0.0625 + 0.25 + 1) = 3.0625 / 1.3125.
    expect(Math.abs(r.diagnostics.effectiveSampleSize! - 3.0625 / 1.3125)).toBeLessThan(1e-12);
    expect(r.diagnostics.sampleSize).toBe(3);
    expect(r.assumptions.method).toBe('exponentially-weighted');
    expect(r.assumptions.halfLifePeriods).toBe(1);
    expect(r.assumptions.estimationConvention).toContain('0.5^((T − 1 − t) / 1)');
  });

  it('annualizes by periodsPerYear and says so', () => {
    const r = estimateExpectedReturns({
      method: 'exponentially-weighted',
      returns: THREE,
      halfLifePeriods: 1,
      periodsPerYear: 12,
    });
    // (0.0675 / 1.75) × 12 = 0.81 / 1.75.
    expect(Math.abs(r.value.expectedReturns[0]! - 0.81 / 1.75)).toBeLessThan(1e-12);
    expect(r.value.annualized).toBe(true);
    expect(r.assumptions.periodsPerYear).toBe(12);
  });

  it('a very long half-life converges to the equal-weight historical mean', () => {
    const r = estimateExpectedReturns({
      method: 'exponentially-weighted',
      returns: THREE,
      halfLifePeriods: 1e12,
    });
    const equal = meanReturns({ returns: THREE });
    for (let k = 0; k < 2; k++) {
      expect(Math.abs(r.value.expectedReturns[k]! - equal[k]!)).toBeLessThan(1e-12);
    }
    // All three weights ≈ 1 ⇒ effective sample size ≈ 3.
    expect(r.diagnostics.effectiveSampleSize).toBeCloseTo(3, 10);
  });

  it('halfLifePeriods is required (no secret default) and must be a finite number > 0', () => {
    const missing = catching(() =>
      estimateExpectedReturns({ method: 'exponentially-weighted', returns: THREE } as never),
    );
    expect(isQuantError(missing, ErrorCode.InputMissingField)).toBe(true);
    expect(String((missing as Error).message)).toContain('halfLifePeriods');
    for (const bad of [0, -1]) {
      const caught = catching(() =>
        estimateExpectedReturns({
          method: 'exponentially-weighted',
          returns: THREE,
          halfLifePeriods: bad,
        }),
      );
      expect(isQuantError(caught, ErrorCode.InputOutOfRange), `halfLifePeriods ${bad}`).toBe(true);
    }
    for (const bad of [NaN, Infinity, null, '5']) {
      const caught = catching(() =>
        estimateExpectedReturns({
          method: 'exponentially-weighted',
          returns: THREE,
          halfLifePeriods: bad as never,
        }),
      );
      expect(isQuantError(caught, ErrorCode.InputNotFinite), `halfLifePeriods ${bad}`).toBe(true);
    }
  });
});

describe('estimateExpectedReturns — capital-asset-pricing composes FC2', () => {
  it('equals capitalAssetPricingExpectedReturn per asset (toBe), annual by construction', () => {
    const betas = [0.8, 1.2, 1.5];
    const r = estimateExpectedReturns({
      method: 'capital-asset-pricing',
      betas,
      annualRiskFreeRate: 0.04,
      annualMarketRiskPremium: 0.05,
      assetIds: ['A', 'B', 'C'],
    });
    for (let k = 0; k < betas.length; k++) {
      expect(r.value.expectedReturns[k]).toBe(
        capitalAssetPricingExpectedReturn({
          annualRiskFreeRate: 0.04,
          beta: betas[k]!,
          annualMarketRiskPremium: 0.05,
        }),
      );
    }
    // Hand check: 0.04 + 0.8·0.05 = 0.08; 0.04 + 1.2·0.05 = 0.10; 0.04 + 1.5·0.05 = 0.115.
    expect(r.value.expectedReturns[0]).toBeCloseTo(0.08, 15);
    expect(r.value.expectedReturns[1]).toBeCloseTo(0.1, 15);
    expect(r.value.expectedReturns[2]).toBeCloseTo(0.115, 15);
    expect(r.value.annualized).toBe(true);
    expect(r.value.assetIds).toEqual(['A', 'B', 'C']);
    expect(r.assumptions.method).toBe('capital-asset-pricing');
    expect(r.assumptions.annualRiskFreeRate).toBe(0.04);
    expect(r.assumptions.annualMarketRiskPremium).toBe(0.05);
    expect(r.assumptions.periodsPerYear).toBeUndefined();
    expect(r.diagnostics.sampleSize).toBe(0);
  });

  it('periodsPerYear is not a key of this branch — an unknown-key teaching, not a silent no-op', () => {
    const caught = catching(() =>
      estimateExpectedReturns({
        method: 'capital-asset-pricing',
        betas: [1],
        annualRiskFreeRate: 0.04,
        annualMarketRiskPremium: 0.05,
        periodsPerYear: 252,
      } as never),
    );
    expect(isQuantError(caught, ErrorCode.InputUnknownField)).toBe(true);
    expect((caught as { context?: Record<string, unknown> }).context?.['key']).toBe(
      'periodsPerYear',
    );
  });

  it('refuses missing or non-finite rate fields and empty / non-finite betas', () => {
    const noRate = catching(() =>
      estimateExpectedReturns({
        method: 'capital-asset-pricing',
        betas: [1],
        annualMarketRiskPremium: 0.05,
      } as never),
    );
    expect(isQuantError(noRate, ErrorCode.InputMissingField)).toBe(true);
    const nanPremium = catching(() =>
      estimateExpectedReturns({
        method: 'capital-asset-pricing',
        betas: [1],
        annualRiskFreeRate: 0.04,
        annualMarketRiskPremium: NaN,
      }),
    );
    expect(isQuantError(nanPremium, ErrorCode.InputNotFinite)).toBe(true);
    const emptyBetas = catching(() =>
      estimateExpectedReturns({
        method: 'capital-asset-pricing',
        betas: [],
        annualRiskFreeRate: 0.04,
        annualMarketRiskPremium: 0.05,
      }),
    );
    expect(isQuantError(emptyBetas, ErrorCode.InputWrongShape)).toBe(true);
    const nanBeta = catching(() =>
      estimateExpectedReturns({
        method: 'capital-asset-pricing',
        betas: [1, Infinity],
        annualRiskFreeRate: 0.04,
        annualMarketRiskPremium: 0.05,
      }),
    );
    expect(isQuantError(nanBeta, ErrorCode.InputNotFinite)).toBe(true);
  });
});

describe('estimateExpectedReturns — supplied', () => {
  it('passes validated values through with the caller-declared annualization', () => {
    const r = estimateExpectedReturns({
      method: 'supplied',
      expectedReturns: [0.08, 0.1],
      annualized: true,
      assetIds: ['X', 'Y'],
    });
    expect(r.value.expectedReturns).toEqual([0.08, 0.1]);
    expect(r.value.annualized).toBe(true);
    expect(r.value.assetIds).toEqual(['X', 'Y']);
    expect(r.assumptions.method).toBe('supplied');
    expect(r.assumptions.estimationConvention).toContain('annual');
    expect(r.diagnostics.sampleSize).toBe(0);
    const perPeriod = estimateExpectedReturns({
      method: 'supplied',
      expectedReturns: [0.001],
      annualized: false,
    });
    expect(perPeriod.value.annualized).toBe(false);
    expect(perPeriod.assumptions.estimationConvention).toContain('per-period');
  });

  it('annualized is required and must be a boolean', () => {
    const missing = catching(() =>
      estimateExpectedReturns({ method: 'supplied', expectedReturns: [0.08] } as never),
    );
    expect(isQuantError(missing, ErrorCode.InputMissingField)).toBe(true);
    expect(String((missing as Error).message)).toContain('annualized');
    const wrong = catching(() =>
      estimateExpectedReturns({
        method: 'supplied',
        expectedReturns: [0.08],
        annualized: 'yes',
      } as never),
    );
    expect(isQuantError(wrong, ErrorCode.InputWrongType)).toBe(true);
  });

  it('refuses empty or non-finite expected returns and misaligned asset labels', () => {
    const empty = catching(() =>
      estimateExpectedReturns({ method: 'supplied', expectedReturns: [], annualized: true }),
    );
    expect(isQuantError(empty, ErrorCode.InputWrongShape)).toBe(true);
    const nan = catching(() =>
      estimateExpectedReturns({
        method: 'supplied',
        expectedReturns: [0.08, NaN],
        annualized: true,
      }),
    );
    expect(isQuantError(nan, ErrorCode.InputNotFinite)).toBe(true);
    const labels = catching(() =>
      estimateExpectedReturns({
        method: 'supplied',
        expectedReturns: [0.08, 0.1],
        annualized: true,
        assetIds: ['only-one'],
      }),
    );
    expect(isQuantError(labels, ErrorCode.InputLengthMismatch)).toBe(true);
    const nonString = catching(() =>
      estimateExpectedReturns({
        method: 'supplied',
        expectedReturns: [0.08, 0.1],
        annualized: true,
        assetIds: ['ok', 7] as never,
      }),
    );
    expect(isQuantError(nonString, ErrorCode.InputWrongType)).toBe(true);
  });
});

describe('estimateExpectedReturns — point-in-time law', () => {
  const TIMESTAMPS = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'];

  it('rows after asOf are excluded (asOf itself is included) and the count is disclosed', () => {
    const r = estimateExpectedReturns({
      method: 'historical-mean',
      returns: RETURNS,
      observationTimestamps: TIMESTAMPS,
      asOf: '2026-03-31',
    });
    // Rows 0..2 survive: asset 0 mean = (0.01 + 0.03 + 0.05) / 3 = 0.03 — bit-identical to
    // meanReturns over exactly those rows.
    const direct = meanReturns({ returns: RETURNS.slice(0, 3) });
    for (let k = 0; k < 2; k++) expect(r.value.expectedReturns[k]).toBe(direct[k]);
    expect(r.value.expectedReturns[0]).toBeCloseTo(0.03, 15);
    expect(r.diagnostics.sampleSize).toBe(3);
    expect(r.diagnostics.excludedAfterAsOf).toBe(1);
    expect(r.assumptions.asOf).toBe(resolveAsOf('2026-03-31'));
    expect(r.diagnostics.warnings).toEqual([]);
  });

  it('the screen also governs the exponentially weighted branch (weights re-anchor on the kept rows)', () => {
    const r = estimateExpectedReturns({
      method: 'exponentially-weighted',
      returns: RETURNS,
      halfLifePeriods: 1,
      observationTimestamps: TIMESTAMPS,
      asOf: '2026-03-31',
    });
    // Kept rows [0.01, 0.03, 0.05] with weights [0.25, 0.5, 1] ⇒ 0.0675 / 1.75 (same as the 3-row case).
    expect(Math.abs(r.value.expectedReturns[0]! - 0.0675 / 1.75)).toBeLessThan(1e-12);
    expect(r.diagnostics.sampleSize).toBe(3);
    expect(r.diagnostics.excludedAfterAsOf).toBe(1);
  });

  it('epoch-millisecond timestamps work the same way', () => {
    const r = estimateExpectedReturns({
      method: 'historical-mean',
      returns: RETURNS,
      observationTimestamps: TIMESTAMPS.map((d) => resolveAsOf(d)),
      asOf: resolveAsOf('2026-02-28'),
    });
    expect(r.diagnostics.sampleSize).toBe(2);
    expect(r.diagnostics.excludedAfterAsOf).toBe(2);
    // (0.01 + 0.03) / 2 = 0.02.
    expect(r.value.expectedReturns[0]).toBeCloseTo(0.02, 15);
  });

  it('timestamps without asOf: validated, nothing excluded, no disclosure field', () => {
    const r = estimateExpectedReturns({
      method: 'historical-mean',
      returns: RETURNS,
      observationTimestamps: TIMESTAMPS,
    });
    expect(r.diagnostics.sampleSize).toBe(4);
    expect(r.diagnostics.excludedAfterAsOf).toBeUndefined();
    expect(r.assumptions.asOf).toBeUndefined();
  });

  it('asOf without timestamps is echoed with a warning that no row could be screened', () => {
    const r = estimateExpectedReturns({
      method: 'historical-mean',
      returns: RETURNS,
      asOf: '2026-03-31',
    });
    expect(r.diagnostics.sampleSize).toBe(4);
    expect(r.diagnostics.excludedAfterAsOf).toBeUndefined();
    expect(r.assumptions.asOf).toBe(resolveAsOf('2026-03-31'));
    expect(r.diagnostics.warnings.map((w) => w.code)).toEqual(['risk.as_of_unscreened']);
    const direct = meanReturns({ returns: RETURNS });
    for (let k = 0; k < 2; k++) expect(r.value.expectedReturns[k]).toBe(direct[k]);
  });

  it('misaligned timestamps refuse (length mismatch)', () => {
    const caught = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: RETURNS,
        observationTimestamps: TIMESTAMPS.slice(0, 3),
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputLengthMismatch)).toBe(true);
    expect(String((caught as Error).message)).toContain('observationTimestamps');
  });

  it('non-monotone timestamps refuse, naming the offending row', () => {
    const caught = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: RETURNS,
        observationTimestamps: ['2026-01-31', '2026-03-31', '2026-02-28', '2026-04-30'],
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputOutOfRange)).toBe(true);
    expect(String((caught as Error).message)).toContain('row 2');
  });

  it('a non-finite or wrongly typed timestamp refuses typed', () => {
    const nan = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: RETURNS,
        observationTimestamps: [1, 2, NaN, 4],
      }),
    );
    expect(isQuantError(nan, ErrorCode.InputNotFinite)).toBe(true);
    const wrong = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: RETURNS,
        observationTimestamps: [1, 2, null, 4] as never,
      }),
    );
    expect(isQuantError(wrong, ErrorCode.InputWrongType)).toBe(true);
    const bare = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: RETURNS,
        observationTimestamps: ['2026-01-31', '2026-02-28', '2026-03-31T10:00:00', '2026-04-30'],
      }),
    );
    expect(isQuantError(bare, ErrorCode.InputWrongType)).toBe(true);
  });

  it('every row after asOf is a refusal, not an empty estimate', () => {
    const caught = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: RETURNS,
        observationTimestamps: TIMESTAMPS,
        asOf: '2025-12-31',
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputOutOfRange)).toBe(true);
    expect(String((caught as Error).message)).toContain('after asOf');
  });

  it('an unparseable asOf refuses through the core time grammar', () => {
    const caught = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: RETURNS,
        observationTimestamps: TIMESTAMPS,
        asOf: 'yesterday',
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputWrongType)).toBe(true);
  });
});

describe('estimateExpectedReturns — refusals at the boundary', () => {
  it('an unknown method literal is an invalid-enum refusal naming the domain', () => {
    const caught = catching(() =>
      estimateExpectedReturns({ method: 'garch', returns: RETURNS } as never),
    );
    expect(isQuantError(caught, ErrorCode.InputInvalidEnum)).toBe(true);
    expect(String((caught as Error).message)).toContain("'historical-mean'");
    expect(String((caught as Error).message)).toContain("'supplied'");
  });

  it('a missing method is a missing-field refusal with an example call', () => {
    const caught = catching(() => estimateExpectedReturns({ returns: RETURNS } as never));
    expect(isQuantError(caught, ErrorCode.InputMissingField)).toBe(true);
    expect(String((caught as Error).message)).toContain('estimateExpectedReturns({');
  });

  it('unknown keys refuse with a did-you-mean teaching (Law 12)', () => {
    const caught = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: RETURNS,
        periodsPerYr: 12,
      } as never),
    );
    expect(isQuantError(caught, ErrorCode.InputUnknownField)).toBe(true);
    expect(String((caught as Error).message)).toContain('did you mean "periodsPerYear"');
    const supplied = catching(() =>
      estimateExpectedReturns({
        method: 'supplied',
        expectedReturns: [0.1],
        annualized: true,
        returns: RETURNS,
      } as never),
    );
    expect(isQuantError(supplied, ErrorCode.InputUnknownField)).toBe(true);
  });

  it('NaN / Infinity in returns, ragged rows, and empty inputs refuse typed', () => {
    const nan = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: [
          [0.01, NaN],
          [0.02, 0.03],
        ],
      }),
    );
    expect(isQuantError(nan, ErrorCode.InputNotFinite)).toBe(true);
    const infinity = catching(() =>
      estimateExpectedReturns({
        method: 'exponentially-weighted',
        returns: [[Infinity], [0.02]],
        halfLifePeriods: 2,
      }),
    );
    expect(isQuantError(infinity, ErrorCode.InputNotFinite)).toBe(true);
    const ragged = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: [[0.01, 0.02], [0.03]],
      }),
    );
    expect(isQuantError(ragged, ErrorCode.InputLengthMismatch)).toBe(true);
    const empty = catching(() =>
      estimateExpectedReturns({ method: 'historical-mean', returns: [] }),
    );
    expect(isQuantError(empty, ErrorCode.InputWrongShape)).toBe(true);
  });

  it('null / non-object / array inputs refuse typed, never a raw TypeError', () => {
    for (const garbage of [null, undefined, 42, 'returns', [RETURNS]]) {
      const caught = catching(() => estimateExpectedReturns(garbage as never));
      expect(isQuantError(caught, ErrorCode.InputWrongType), String(garbage)).toBe(true);
    }
  });

  it('an annualization that overflows double precision is a typed refusal, not a warning beside Infinity', () => {
    const caught = catching(() =>
      estimateExpectedReturns({
        method: 'historical-mean',
        returns: [[1e308], [1e308]],
        periodsPerYear: 1e10,
      }),
    );
    expect(isQuantError(caught, ErrorCode.InputOutOfRange)).toBe(true);
    expect(String((caught as Error).message)).toContain('not representable');
  });
});
