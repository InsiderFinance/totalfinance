/**
 * The 2026-08 hardening wave: three PROPERTY tables that hold for every member of a family, not
 * just for the one input a defect was found on.
 *
 *  1. VaR is monotone non-decreasing in confidence — across methods, across moment regimes. This is
 *     the property the ungated Cornish-Fisher expansion broke: a crash-day series reported a 1.5%
 *     VaR at 95% and exactly 0 at 99%, silently.
 *  2. Every Σ⁻¹ optimizer refuses to call an ill-conditioned solve "converged" — kelly, minVariance,
 *     maxSharpe, meanVariance, blackLitterman all share one gate, so the table has one row each.
 *  3. Margin cross-check: `optionsMargin` agrees with the naked-margin kernels leg-for-leg, and the
 *     cash-secured basis is the opt-in, not the default.
 */

import { describe, expect, it } from 'vitest';
import { normalInverseCdf } from '@totalfinance/math';
import {
  blackLitterman,
  kelly,
  maxSharpe,
  meanVariance,
  minVariance,
  nakedCallMargin,
  nakedPutMargin,
  optionsMargin,
  valueAtRiskReport,
  type VaRMethod,
} from '@totalfinance/risk';

// ─────────────────────────── 1. VaR monotonicity in confidence ───────────────────────────

/** Build a return series with a target shape by mixing a smooth wave with an outlier schedule. */
function regime(name: string, build: () => number[]): { name: string; returns: number[] } {
  return { name, returns: build() };
}

/** Five moment regimes: normal-ish, left-skewed, right-skewed, fat-tailed, and one crash day. */
const REGIMES = [
  regime('near-normal', () =>
    Array.from(
      { length: 500 },
      (_, i) => 0.0002 + 0.01 * Math.sin(i / 3.1) - 0.004 * Math.cos(i / 1.7),
    ),
  ),
  regime('left-skewed', () =>
    Array.from(
      { length: 500 },
      (_, i) => 0.0006 + 0.008 * Math.sin(i / 2.3) - (i % 17 === 0 ? 0.05 : 0),
    ),
  ),
  regime('right-skewed', () =>
    Array.from(
      { length: 500 },
      (_, i) => -0.0006 + 0.008 * Math.sin(i / 2.3) + (i % 17 === 0 ? 0.05 : 0),
    ),
  ),
  regime('fat-tailed', () =>
    Array.from(
      { length: 500 },
      (_, i) => 0.004 * Math.sin(i / 1.9) + (i % 23 === 0 ? (i % 46 === 0 ? 0.06 : -0.06) : 0),
    ),
  ),
  // The reviewed repro: 99 flat days and one −30% crash. skew ≈ −9.85, excess kurtosis ≈ 95.
  regime('crash-day', () => [...new Array<number>(99).fill(0.01), -0.3]),
];

const CONFIDENCES = [0.9, 0.925, 0.95, 0.975, 0.99, 0.995, 0.999];

describe('property: VaR is monotone non-decreasing in confidence', () => {
  for (const { name, returns } of REGIMES) {
    for (const method of ['parametric', 'historical', 'monteCarlo'] as const) {
      it(`${method} VaR never shrinks as confidence rises (${name})`, () => {
        let previous = -Infinity;
        for (const confidence of CONFIDENCES) {
          const v = valueAtRiskReport(returns, { method, confidence, samples: 20000 }).valueAtRisk;
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(previous);
          previous = v;
        }
      });
    }

    it(`Cornish-Fisher VaR never shrinks as confidence rises (${name})`, () => {
      let previous = -Infinity;
      for (const confidence of CONFIDENCES) {
        const r = valueAtRiskReport(returns, {
          method: 'parametric',
          cornishFisher: true,
          confidence,
        });
        // Whichever branch ran, the answer is finite and the branch is disclosed.
        expect(Number.isFinite(r.valueAtRisk)).toBe(true);
        if (!r.cornishFisher) {
          expect(r.diagnostics.warnings.map((w) => w.code)).toContain(
            'risk.cornish_fisher_out_of_domain',
          );
        }
        expect(r.valueAtRisk).toBeGreaterThanOrEqual(previous);
        previous = r.valueAtRisk;
      }
    });
  }

  it('holds past the 99.9% anchor too, where the CF domain gate flips over', () => {
    for (const { returns } of REGIMES) {
      let previous = -Infinity;
      for (const confidence of [0.999, 0.9995, 0.9999, 0.99999]) {
        const v = valueAtRiskReport(returns, {
          method: 'parametric',
          cornishFisher: true,
          confidence,
        }).valueAtRisk;
        expect(v).toBeGreaterThanOrEqual(previous);
        previous = v;
      }
    }
  });
});

describe('[P0] Cornish-Fisher VaR on a crash-day series (reviewed repro)', () => {
  // 99 × +1% and a single −30% day: mean 0.0069, σ ≈ 0.030845, skew ≈ −9.85, excess kurtosis ≈ 95.
  const crash = [...new Array<number>(99).fill(0.01), -0.3];
  const mean = crash.reduce((s, x) => s + x, 0) / crash.length;
  const sigma = Math.sqrt(crash.reduce((s, x) => s + (x - mean) ** 2, 0) / crash.length);

  it('refuses the out-of-domain expansion instead of reporting 0 at 99% (was: 1.49% @95%, 0.00% @99%)', () => {
    const at95 = valueAtRiskReport(crash, {
      method: 'parametric',
      cornishFisher: true,
      confidence: 0.95,
    });
    const at99 = valueAtRiskReport(crash, {
      method: 'parametric',
      cornishFisher: true,
      confidence: 0.99,
    });

    // Pre-fix the raw expansion produced z(95%) = −0.705 ⇒ VaR 1.485%, and z(99%) = +4.73 — a
    // "loss" of −15%, clamped to exactly 0. Both were reported with no warning at all.
    for (const r of [at95, at99]) {
      expect(r.cornishFisher).toBe(false);
      expect(r.diagnostics.warnings.map((w) => w.code)).toContain(
        'risk.cornish_fisher_out_of_domain',
      );
    }
    // The reported numbers are now the plain parametric quantiles.
    expect(at95.valueAtRisk).toBeCloseTo(-(mean + sigma * normalInverseCdf(0.05)), 6);
    expect(at99.valueAtRisk).toBeCloseTo(-(mean + sigma * normalInverseCdf(0.01)), 6);
    expect(at99.valueAtRisk).toBeGreaterThanOrEqual(at95.valueAtRisk);
    expect(at99.valueAtRisk).toBeGreaterThan(0.05);
  });

  it('a mildly skewed series still gets the CF correction (the gate rejects breakdown, not skew)', () => {
    const mild = Array.from(
      { length: 500 },
      (_, i) =>
        0.0004 + 0.012 * Math.sin(i / 3.1) - 0.006 * Math.cos(i / 1.7) + (i % 11 === 0 ? -0.02 : 0),
    );
    const on = valueAtRiskReport(mild, { method: 'parametric', cornishFisher: true });
    const off = valueAtRiskReport(mild, { method: 'parametric' });
    expect(on.cornishFisher).toBe(true);
    expect(on.valueAtRisk).toBeGreaterThan(off.valueAtRisk); // negative skew ⇒ fatter left tail
  });

  it('the 0 clamp is disclosed on every method, never shipped as a bare number', () => {
    // A strictly profitable series: the 90% "loss" quantile is a gain, so VaR clamps to 0.
    const winners = Array.from({ length: 200 }, (_, i) => 0.01 + 0.001 * Math.sin(i));
    for (const method of ['parametric', 'historical', 'monteCarlo'] as VaRMethod[]) {
      const r = valueAtRiskReport(winners, { method, confidence: 0.9 });
      expect(r.valueAtRisk).toBe(0);
      expect(r.diagnostics.warnings.map((w) => w.code)).toContain('risk.quantile_beyond_sample');
    }
  });
});

// ─────────────────────────── 2. conditioning table across the optimizers ───────────────────────────

/** κ ≈ 2e10: positive definite (cholesky succeeds), but Σ⁻¹ has ~6 digits of signal left. */
const NEAR_SINGULAR: number[][] = [
  [0.04, 0.04 - 4e-12],
  [0.04 - 4e-12, 0.04],
];
/** The same pair of assets with an honest 0.15 correlation — κ ≈ 1.35. */
const WELL_CONDITIONED: number[][] = [
  [0.04, 0.006],
  [0.006, 0.09],
];
const MEAN = [0.1, 0.08];

const ILL_CONDITIONED = 'risk.ill_conditioned_covariance';

describe('property: no Σ⁻¹ optimizer reports a converged solve on an ill-conditioned covariance', () => {
  const table: { name: string; run: (covariance: number[][]) => ReturnType<typeof minVariance> }[] =
    [
      { name: 'minVariance', run: (c) => minVariance(c) },
      { name: 'maxSharpe', run: (c) => maxSharpe({ mean: MEAN, covariance: c }) },
      { name: 'meanVariance', run: (c) => meanVariance({ mean: MEAN, covariance: c }) },
      { name: 'kelly', run: (c) => kelly({ mean: MEAN, covariance: c }) },
      {
        name: 'blackLitterman',
        run: (c) =>
          blackLitterman({
            covariance: c,
            marketWeights: [0.5, 0.5],
            views: [{ pick: [1, -1], view: 0.02 }],
          }) as unknown as ReturnType<typeof minVariance>,
      },
    ];

  for (const { name, run } of table) {
    it(`${name}: near-singular Σ ⇒ warning + converged:false, weights still returned and finite`, () => {
      const r = run(NEAR_SINGULAR);
      expect(r.diagnostics.converged).toBe(false);
      const w = r.diagnostics.warnings.find((x) => x.code === ILL_CONDITIONED);
      expect(w).toBeDefined();
      expect(w!.context?.['conditionNumber']).toBeGreaterThan(1e10);
      // The weights are still handed back (they ARE the solution of the stated problem) — the
      // point is that nobody can read them as trustworthy.
      const weights = (r.value as { weights: number[] }).weights;
      expect(weights).toHaveLength(2);
      for (const wi of weights) expect(Number.isFinite(wi)).toBe(true);
    });

    it(`${name}: a well-conditioned Σ is untouched — converged, no conditioning warning`, () => {
      const r = run(WELL_CONDITIONED);
      expect(r.diagnostics.converged).toBe(true);
      expect(r.diagnostics.warnings.some((x) => x.code === ILL_CONDITIONED)).toBe(false);
    });
  }

  it('kelly on the reviewed repro: the ±millions-times leverage is flagged, not silently returned', () => {
    const r = kelly({ mean: MEAN, covariance: NEAR_SINGULAR });
    const leverage = r.value.weights.reduce((s, w) => s + Math.abs(w), 0);
    expect(leverage).toBeGreaterThan(1e6); // the arithmetic is unchanged …
    expect(r.diagnostics.converged).toBe(false); // … the CLAIM about it is
    expect(r.diagnostics.warnings.map((w) => w.code)).toContain(ILL_CONDITIONED);
    expect(r.diagnostics.warnings.map((w) => w.code)).toContain('optimize.not_converged');
  });

  it('minVariance on a near-rank-1 (collinear) covariance: same verdict', () => {
    const rank1: number[][] = [
      [1, 1 - 1e-11],
      [1 - 1e-11, 1],
    ];
    const r = minVariance(rank1);
    expect(r.diagnostics.converged).toBe(false);
    expect(r.diagnostics.warnings.map((w) => w.code)).toContain(ILL_CONDITIONED);
  });
});

// ─────────────────────────── 3. margin cross-check table ───────────────────────────

describe('property: optionsMargin agrees with the naked-margin kernels leg for leg', () => {
  const spot = 100;

  const rows = [
    {
      name: 'single uncovered short put',
      legs: [{ type: 'put' as const, quantity: -1, strike: 95, premium: 2 }],
      expected: () => nakedPutMargin({ spot, strike: 95, premium: 2 }),
      method: 'reg-t-naked-put' as const,
    },
    {
      name: 'two uncovered short puts (per-contract scaling)',
      legs: [{ type: 'put' as const, quantity: -2, strike: 95, premium: 2 }],
      expected: () => 2 * nakedPutMargin({ spot, strike: 95, premium: 2 }),
      method: 'reg-t-naked-put' as const,
    },
    {
      name: 'single naked short call',
      legs: [{ type: 'call' as const, quantity: -1, strike: 105, premium: 2 }],
      expected: () => nakedCallMargin({ spot, strike: 105, premium: 2 }),
      method: 'reg-t-naked' as const,
    },
    {
      name: 'short strangle (naked call + naked put)',
      legs: [
        { type: 'call' as const, quantity: -1, strike: 110, premium: 1.5 },
        { type: 'put' as const, quantity: -1, strike: 90, premium: 1.2 },
      ],
      expected: () =>
        nakedCallMargin({ spot, strike: 110, premium: 1.5 }) +
        nakedPutMargin({ spot, strike: 90, premium: 1.2 }),
      method: 'reg-t-naked' as const,
    },
  ];

  for (const row of rows) {
    it(`${row.name}: initialMargin = Σ kernel requirement`, () => {
      const r = optionsMargin(row.legs, { spot });
      expect(r.method).toBe(row.method);
      expect(r.initialMargin).toBeCloseTo(row.expected(), 9);
      expect(r.assumptions['putMarginBasis']).toBe('reg-t-naked');
    });
  }

  it('a 2×1 put ratio charges only the genuinely uncovered contract', () => {
    const legs = [
      { type: 'put' as const, quantity: -2, strike: 95, premium: 2 },
      { type: 'put' as const, quantity: 1, strike: 90, premium: 0.8 },
    ];
    const r = optionsMargin(legs, { spot });
    expect(r.method).toBe('reg-t-naked-put');
    // one naked short 95 put + the capped 95/90 spread that remains
    const spreadMaxLoss = (95 - 90 - (2 - 0.8)) * 100;
    expect(r.initialMargin).toBeCloseTo(
      nakedPutMargin({ spot, strike: 95, premium: 2 }) + spreadMaxLoss,
      9,
    );
  });

  it('covered spreads are untouched by the naked-put routing', () => {
    const bullPut = optionsMargin(
      [
        { type: 'put', quantity: -1, strike: 95, premium: 2 },
        { type: 'put', quantity: 1, strike: 90, premium: 0.8 },
      ],
      { spot },
    );
    expect(bullPut.method).toBe('defined-risk-max-loss');
    expect(bullPut.initialMargin).toBeCloseTo(380, 9);

    const ironCondor = optionsMargin(
      [
        { type: 'put', quantity: 1, strike: 85, premium: 0.4 },
        { type: 'put', quantity: -1, strike: 90, premium: 1.0 },
        { type: 'call', quantity: -1, strike: 110, premium: 1.0 },
        { type: 'call', quantity: 1, strike: 115, premium: 0.4 },
      ],
      { spot },
    );
    expect(ironCondor.method).toBe('defined-risk-max-loss');
    expect(ironCondor.initialMargin).toBeCloseTo((5 - 1.2) * 100, 9);
  });
});
