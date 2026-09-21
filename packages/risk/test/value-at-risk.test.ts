import { describe, expect, it } from 'vitest';
import { InputError } from '@totalfinance/core';
import { normalInverseCdf, normalPdf } from '@totalfinance/math';
import {
  valueAtRisk,
  expectedShortfall,
  valueAtRiskReport,
  portfolioVariance,
  portfolioVolatility,
  riskContributions,
  diversificationRatio,
  portfolioVaR,
} from '@totalfinance/risk/value-at-risk';

// a deterministic, mildly-skewed return series
const R: number[] = [];
for (let i = 0; i < 500; i++) {
  R.push(
    0.0004 + 0.012 * Math.sin(i / 3.1) - 0.006 * Math.cos(i / 1.7) + (i % 11 === 0 ? -0.02 : 0),
  );
}
const momentsOf = (r: number[]) => {
  const mu = r.reduce((s, x) => s + x, 0) / r.length;
  let m2 = 0;
  for (const x of r) m2 += (x - mu) ** 2;
  return { mu, sigma: Math.sqrt(m2 / r.length) };
};

describe('parametric VaR/CVaR (Gaussian closed form)', () => {
  it('VaR = σ·z − μ and CVaR = σ·φ(z)/α − μ', () => {
    const { mu, sigma } = momentsOf(R);
    const alpha = 0.05;
    const z = -normalInverseCdf(alpha); // 1.6449
    const expVar = Math.max(0, sigma * z - mu);
    const expCvar = (sigma * normalPdf(normalInverseCdf(alpha))) / alpha - mu;
    const rep = valueAtRiskReport(R, { method: 'parametric', confidence: 0.95 });
    expect(rep.valueAtRisk).toBeCloseTo(expVar, 12);
    expect(rep.conditionalValueAtRisk).toBeCloseTo(Math.max(expVar, expCvar), 12);
    expect(rep.conditionalValueAtRisk).toBeGreaterThanOrEqual(rep.valueAtRisk);
  });

  it('horizonPeriods scales μ·h and σ·√h', () => {
    const v1 = valueAtRiskReport(R, { method: 'parametric' }).valueAtRisk;
    const v4 = valueAtRiskReport(R, { method: 'parametric', horizonPeriods: 4 }).valueAtRisk;
    const { mu, sigma } = momentsOf(R);
    const z = -normalInverseCdf(0.05);
    expect(v4).toBeCloseTo(Math.max(0, sigma * 2 * z - mu * 4), 12);
    expect(v4).toBeGreaterThan(v1);
  });

  it('Cornish-Fisher widens VaR for a left-skewed series', () => {
    const plain = valueAtRiskReport(R, { method: 'parametric' }).valueAtRisk;
    const cf = valueAtRiskReport(R, { method: 'parametric', cornishFisher: true }).valueAtRisk;
    expect(cf).toBeGreaterThan(plain); // negative skew → fatter left tail
  });

  it('echoes cornishFisher and warns of the Gaussian-ES CVaR fallback exactly when CF is on (WS2.7c)', () => {
    const off = valueAtRiskReport(R, { method: 'parametric' });
    expect(off.cornishFisher).toBe(false);
    expect(off.diagnostics.warnings).toEqual([]);

    const on = valueAtRiskReport(R, { method: 'parametric', cornishFisher: true });
    expect(on.cornishFisher).toBe(true);
    expect(
      on.diagnostics.warnings.some(
        (w) => w.code === 'risk.cornish_fisher_conditional_value_at_risk_gaussian_fallback',
      ),
    ).toBe(true);

    // non-parametric methods never apply CF — and now SAY the flag was ignored instead of
    // silently no-op'ing it (a caller who asked for a skew/kurtosis correction and got an
    // empty warnings channel had no way to learn it never happened).
    const hist = valueAtRiskReport(R, { method: 'historical', cornishFisher: true });
    expect(hist.cornishFisher).toBe(false);
    const ignored = hist.diagnostics.warnings.find((w) =>
      /cornishFisher applies to/.test(w.message),
    );
    expect(ignored).toBeDefined();
    expect(ignored!.severity).toBe('info');
    expect(ignored!.code).toBe('model.limitation');
    // nothing else fires on this well-sampled series
    expect(hist.diagnostics.warnings).toHaveLength(1);
  });
});

describe('historical VaR/CVaR', () => {
  it('VaR is the negated lower-tail quantile; CVaR the mean of that tail', () => {
    const sorted = [...R].sort((a, b) => a - b);
    const k = Math.floor(0.05 * (sorted.length - 1));
    const rep = valueAtRiskReport(R, { method: 'historical', confidence: 0.95 });
    // VaR is positive and near the 5th-percentile loss
    expect(rep.valueAtRisk).toBeGreaterThan(0);
    expect(rep.valueAtRisk).toBeCloseTo(-sorted[k]!, 2);
    expect(rep.conditionalValueAtRisk).toBeGreaterThanOrEqual(rep.valueAtRisk);
  });

  it('[P2] discloses the estimator, and warns when the sample cannot resolve the tail', () => {
    // 100 observations at 99%: (1 − 0.99)·(100 − 1) = 0.99 < 1, so hyndman-fan-7 interpolates
    // BETWEEN the worst return and the second-worst — here onto a POSITIVE return, which the
    // max(0, ·) clamp then reported as a VaR of exactly 0 with no warning at all.
    const crash = [...new Array<number>(99).fill(0.01), -0.3];
    const rep = valueAtRiskReport(crash, { method: 'historical', confidence: 0.99 });
    expect(rep.assumptions['quantileEstimator']).toBe('hyndman-fan-7');
    const codes = rep.diagnostics.warnings.map((w) => w.code);
    expect(codes).toContain('risk.quantile_beyond_sample');
    const w = rep.diagnostics.warnings.find((x) => x.code === 'risk.quantile_beyond_sample')!;
    expect(w.context?.['observations']).toBe(100);
    // The number itself is unchanged — this is a disclosure fix, not a re-definition.
    expect(rep.valueAtRisk).toBe(0);
  });

  it('[P2] a mainstream 250-observation 99% VaR warns about nothing', () => {
    const daily = Array.from(
      { length: 250 },
      (_, i) => 0.0003 + 0.009 * Math.sin(i / 2.7) - 0.004 * Math.cos(i / 1.3),
    );
    const rep = valueAtRiskReport(daily, { method: 'historical', confidence: 0.99 });
    expect(rep.assumptions['quantileEstimator']).toBe('hyndman-fan-7');
    expect(rep.diagnostics.warnings).toEqual([]);
    expect(rep.valueAtRisk).toBeGreaterThan(0);
  });
});

describe('Monte-Carlo VaR', () => {
  it('is deterministic under a seed and converges to the parametric Gaussian VaR', () => {
    const a = valueAtRiskReport(R, { method: 'monteCarlo', seed: 7, samples: 40000 }).valueAtRisk;
    const b = valueAtRiskReport(R, { method: 'monteCarlo', seed: 7, samples: 40000 }).valueAtRisk;
    expect(a).toBe(b); // reproducible
    const p = valueAtRiskReport(R, { method: 'parametric' }).valueAtRisk;
    expect(a).toBeCloseTo(p, 2); // MC of a fitted normal ≈ parametric
  });

  it('[P2] discloses that the simulated law is the FITTED NORMAL, not the sample', () => {
    const rep = valueAtRiskReport(R, { method: 'monteCarlo', seed: 3, samples: 5000 });
    expect(rep.assumptions['distribution']).toBe('fitted-normal');
    expect(valueAtRisk.explain(R, { method: 'monteCarlo', seed: 3 }).assumptions.distribution).toBe(
      'fitted-normal',
    );
    // and the other methods do not claim a simulated distribution they never used
    expect(valueAtRiskReport(R, { method: 'historical' }).assumptions['distribution']).toBe(
      undefined,
    );
  });
});

describe('[P2] Cornish-Fisher over a multi-period horizon (iid moment scaling)', () => {
  it('scales skew by 1/√h and excess kurtosis by 1/h, and says so', () => {
    const h = 10;
    const plain = valueAtRiskReport(R, { method: 'parametric', horizonPeriods: h }).valueAtRisk;
    const scaled = valueAtRiskReport(R, {
      method: 'parametric',
      cornishFisher: true,
      horizonPeriods: h,
    });
    // The one-period CF correction applied to a √h-scaled quantile (what this used to do): compute
    // it here from the one-period CF quantile shift, scaled to the horizon.
    const one = valueAtRiskReport(R, { method: 'parametric', cornishFisher: true }).valueAtRisk;
    const onePeriodPlain = valueAtRiskReport(R, { method: 'parametric' }).valueAtRisk;
    const mu = R.reduce((s, x) => s + x, 0) / R.length;
    // demeaned CF widening at one period, √h-scaled — the naive (over-corrected) number
    const naive = plain + Math.sqrt(h) * (one - onePeriodPlain);

    expect(scaled.cornishFisher).toBe(true);
    expect(scaled.assumptions['momentScaling']).toBe('iid');
    // R is left-skewed ⇒ CF widens the loss, but by LESS than the one-period asymmetry once the
    // moments are aggregated to the horizon.
    expect(scaled.valueAtRisk).toBeGreaterThan(plain);
    expect(scaled.valueAtRisk).toBeLessThan(naive);
    expect(mu).toBeLessThan(0.01); // sanity: these are decimal per-period returns
  });

  it('h = 1 is unchanged and carries no moment-scaling claim', () => {
    const rep = valueAtRiskReport(R, { method: 'parametric', cornishFisher: true });
    expect(rep.assumptions['momentScaling']).toBe(undefined);
  });
});

describe('portfolio risk decomposition', () => {
  // 3-asset covariance (annualized-ish), positive definite
  const covariance = [
    [0.04, 0.006, 0.0],
    [0.006, 0.09, -0.01],
    [0.0, -0.01, 0.0225],
  ];
  const w = [0.5, 0.3, 0.2];

  it('portfolio variance = wᵀΣw and volatility its root', () => {
    let q = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) q += w[i]! * covariance[i]![j]! * w[j]!;
    expect(portfolioVariance(w, covariance)).toBeCloseTo(q, 12);
    expect(portfolioVolatility(w, covariance)).toBeCloseTo(Math.sqrt(q), 12);
  });

  it('component risk contributions sum to portfolio volatility (H10 report)', () => {
    const rc = riskContributions(w, covariance);
    const total = rc.contributions.reduce((s, c) => s + c.component!, 0);
    expect(total).toBeCloseTo(portfolioVolatility(w, covariance), 10);
    expect(rc.contributions.reduce((s, c) => s + c.fraction!, 0)).toBeCloseTo(1, 10);
    expect(rc.portfolioVolatility).toBeCloseTo(portfolioVolatility(w, covariance), 12);
    expect(rc.assumptions.assets).toBe(w.length);
    expect(rc.diagnostics.warnings).toEqual([]);
  });

  it('H10: a zero-volatility book reports null rows with a degenerate-input warning, never zeros', () => {
    const zeroCov = [
      [0, 0],
      [0, 0],
    ];
    const rc = riskContributions([0.5, 0.5], zeroCov);
    expect(rc.portfolioVolatility).toBe(0);
    for (const row of rc.contributions) {
      expect(row.marginal).toBeNull();
      expect(row.component).toBeNull();
      expect(row.fraction).toBeNull();
    }
    expect(rc.diagnostics.warnings[0]?.code).toBe('input.degenerate');
  });

  it('diversification ratio ≥ 1 (and = 1 for a single asset)', () => {
    expect(diversificationRatio(w, covariance)).toBeGreaterThan(1);
    expect(diversificationRatio([1], [[0.04]])).toBeCloseTo(1, 12);
  });

  it('Euler decomposition: Σ component VaR = total VaR (zero mean)', () => {
    const r = portfolioVaR({
      method: 'parametric',
      weights: w,
      covariance,
      options: { confidence: 0.99 },
    });
    if (!('componentVaR' in r)) throw new Error('parametric VaR carries component VaR');
    const sum = r.componentVaR.reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(r.valueAtRisk, 10);
  });

  it('MC portfolio VaR ≈ parametric portfolio VaR for Gaussian assets', () => {
    const p = portfolioVaR({
      method: 'parametric',
      weights: w,
      covariance,
      options: { confidence: 0.95 },
    }).valueAtRisk;
    const m = portfolioVaR({
      method: 'monteCarlo',
      weights: w,
      covariance,
      options: { confidence: 0.95, samples: 60000, seed: 3 },
    }).valueAtRisk;
    expect(m).toBeCloseTo(p, 2);
  });

  it('Law 2 report grammar: both portfolio VaRs echo the applied defaults + a warnings channel', () => {
    const p = portfolioVaR({ method: 'parametric', weights: w, covariance });
    expect(p.assumptions.conventionsVersion).toBeTruthy();
    expect(p.assumptions['confidence']).toBe(0.95); // the applied default, disclosed
    expect(p.assumptions['horizonPeriods']).toBe(1);
    expect(p.assumptions['assets']).toBe(w.length);
    expect(p.assumptions['mean']).toBe('zero');
    expect(p.diagnostics.warnings).toEqual([]);
    expect('value' in p).toBe(false); // report, not envelope

    const m = portfolioVaR({ method: 'monteCarlo', weights: w, covariance });
    expect(m.assumptions['confidence']).toBe(0.95);
    expect(m.assumptions['samples']).toBe(10000); // MC defaults, disclosed for reproducibility
    expect(m.assumptions['seed']).toBe(1);
    expect(m.assumptions['mean']).toBe('zero');
    expect(m.diagnostics.warnings).toEqual([]);
    expect('value' in m).toBe(false);

    const withMean = portfolioVaR({
      method: 'parametric',
      weights: w,
      covariance,
      options: { mean: w.map(() => 0.01) },
    });
    expect(withMean.assumptions['mean']).toBe('provided');
  });
});

describe('horizonPeriods scaling is √-time (not linear) across all methods', () => {
  // The demeaned quantile scales by √h while the mean drifts by ·h. Since the one-period VaR is −q,
  // a 4-period VaR must equal 2·v1 − 2·μ — NOT 4·v1 (the linear-scaling bug this guards against).
  const { mu } = momentsOf(R);
  for (const method of ['historical', 'monteCarlo'] as const) {
    it(`${method}: 4-period VaR scales the demeaned quantile by √h`, () => {
      const v1 = valueAtRiskReport(R, { method, seed: 7, samples: 60000 }).valueAtRisk;
      const v4 = valueAtRiskReport(R, {
        method,
        horizonPeriods: 4,
        seed: 7,
        samples: 60000,
      }).valueAtRisk;
      expect(v4).toBeCloseTo(2 * v1 - 2 * mu, 6); // √-time, exact relationship
      expect(Math.abs(v4 - 4 * v1)).toBeGreaterThan(0.01 * v1); // explicitly not linear ·h
    });
  }
});

describe('validation', () => {
  it('rejects bad confidence, empty/non-finite returns, dimension mismatch', () => {
    expect(() => valueAtRisk(R, { confidence: 1.2 })).toThrow(InputError);
    expect(() => valueAtRisk([])).toThrow(InputError);
    expect(() => valueAtRisk([0.1, NaN, 0.2])).toThrow(InputError);
    expect(() => portfolioVolatility([0.5, 0.5], [[0.04]])).toThrow(InputError);
    expect(() => expectedShortfall(R, { horizonPeriods: -1 })).toThrow(InputError);
  });

  it('rejects an unknown VaR method instead of silently treating it as Monte Carlo', () => {
    // @ts-expect-error — exercising the runtime guard with an invalid method
    expect(() => valueAtRisk(R, { method: 'gaussian' })).toThrow(InputError);
  });

  it('rejects a non-positive Monte-Carlo sample count', () => {
    expect(() => valueAtRisk(R, { method: 'monteCarlo', samples: 0 })).toThrow(InputError);
  });

  it('rejects a portfolio mean vector whose length does not match the assets', () => {
    const covariance = [
      [0.04, 0.0],
      [0.0, 0.09],
    ];
    expect(() =>
      portfolioVaR({
        method: 'parametric',
        weights: [0.5, 0.5],
        covariance,
        options: { mean: [0.01] },
      }),
    ).toThrow(InputError);
    expect(() =>
      portfolioVaR({
        method: 'monteCarlo',
        weights: [0.5, 0.5],
        covariance,
        options: { mean: [0.01] },
      }),
    ).toThrow(InputError);
  });

  it('monteCarloPortfolioVaR validates horizonPeriods and seed like its siblings (review fix)', () => {
    const covariance = [
      [0.04, 0.0],
      [0.0, 0.09],
    ];
    // horizonPeriods:-1 used to √-scale into a silent NaN; a fractional seed silently broke reproducibility
    expect(() =>
      portfolioVaR({
        method: 'monteCarlo',
        weights: [0.5, 0.5],
        covariance,
        options: { horizonPeriods: -1 },
      }),
    ).toThrow(/horizonPeriods/);
    expect(() =>
      portfolioVaR({
        method: 'monteCarlo',
        weights: [0.5, 0.5],
        covariance,
        options: { horizonPeriods: NaN },
      }),
    ).toThrow(/horizonPeriods/);
    expect(() =>
      portfolioVaR({
        method: 'monteCarlo',
        weights: [0.5, 0.5],
        covariance,
        options: { horizonPeriods: Infinity },
      }),
    ).toThrow(/horizonPeriods/);
    expect(() =>
      portfolioVaR({
        method: 'monteCarlo',
        weights: [0.5, 0.5],
        covariance,
        options: { seed: 1.5 },
      }),
    ).toThrow(/seed/);
    // a valid call stays reproducible under the same seed
    const a = portfolioVaR({
      method: 'monteCarlo',
      weights: [0.5, 0.5],
      covariance,
      options: { seed: 7, samples: 5000, horizonPeriods: 4 },
    });
    const b = portfolioVaR({
      method: 'monteCarlo',
      weights: [0.5, 0.5],
      covariance,
      options: { seed: 7, samples: 5000, horizonPeriods: 4 },
    });
    expect(a).toEqual(b);
    expect(a.valueAtRisk).toBeGreaterThan(0);
    expect(a.conditionalValueAtRisk).toBeGreaterThanOrEqual(a.valueAtRisk);
  });
});

describe('portfolio VaR options hardening (deep-sweep boundary)', () => {
  const w = [0.5, 0.5];
  const covariance = [
    [0.04, 0.006],
    [0.006, 0.09],
  ];

  it('parametricPortfolioVaR and monteCarloPortfolioVaR reject a null options bag', () => {
    // `null` slips past the `= {}` default parameter (only `undefined` triggers it) and used to die
    // on the first option read (raw TypeError).
    expect(() =>
      portfolioVaR({ method: 'parametric', weights: w, covariance, options: null as never }),
    ).toThrow(/portfolioVaR: options must be an object/);
    expect(() =>
      portfolioVaR({ method: 'monteCarlo', weights: w, covariance, options: null as never }),
    ).toThrow(/portfolioVaR: options must be an object/);
    expect(() =>
      portfolioVaR({ method: 'parametric', weights: w, covariance, options: null as never }),
    ).toThrow(InputError);
    // A valid call still works with and without the bag.
    expect(
      portfolioVaR({ method: 'parametric', weights: w, covariance }).valueAtRisk,
    ).toBeGreaterThan(0);
  });
});
