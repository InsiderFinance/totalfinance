/**
 * Return attribution (`factorAttribution`, `brinsonAttribution`). The decompositions are pinned by
 * their exact reconstruction identities — factor: `totalReturn = specificReturn + Σ contributions` (OLS
 * residuals vanish); Brinson: `allocation + selection + interaction = activeReturn` (always for BHB, and
 * for BF at equal weights) — plus synthetic-beta recovery, the risk-free shift, the BF-vs-BHB relation,
 * the non-reconciling-weights disclosure, and the guards.
 */

import { describe, expect, it } from 'vitest';
import {
  brinsonAttribution,
  factorAttribution,
  linkAttribution,
  type AttributionPeriod,
} from '@totalfinance/risk';

/** Deterministic standard normals. */
function normals(n: number, seed: number): number[] {
  let s = seed >>> 0;
  const u = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 0) / 2 ** 32;
  };
  return Array.from(
    { length: n },
    () => Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u()),
  );
}

/** A subject built as α + β₁·f₁ + β₂·f₂ + noise from known parameters. */
function syntheticFactorSet(n: number) {
  const z = normals(n * 3, 11);
  const market = z.slice(0, n).map((x) => 0.0004 + 0.01 * x);
  const size = z.slice(n, 2 * n).map((x) => 0.006 * x);
  const noise = z.slice(2 * n, 3 * n);
  const returns = market.map((m, i) => 0.0002 + 1.2 * m - 0.5 * size[i]! + 0.001 * noise[i]!);
  return { returns, market, size };
}

describe('factorAttribution', () => {
  it('recovers the generating betas and reconstructs the total return exactly', () => {
    const { returns, market, size } = syntheticFactorSet(250);
    const r = factorAttribution({
      returns,
      factors: [
        { name: 'market', returns: market },
        { name: 'size', returns: size },
      ],
    });
    const [mkt, sz] = r.factors;
    expect(mkt!.name).toBe('market');
    expect(mkt!.beta).toBeCloseTo(1.2, 1);
    expect(sz!.beta).toBeCloseTo(-0.5, 1);
    expect(Math.abs(mkt!.tStatistic)).toBeGreaterThan(2); // a real, significant exposure
    expect(r.rSquared).toBeGreaterThan(0.9);
    expect(r.observations).toBe(250);

    // The exact identity: nothing is unattributed.
    const sumContrib = r.factors.reduce((s, f) => s + f.contribution, 0);
    expect(r.totalReturn).toBeCloseTo(r.specificReturn + sumContrib, 12);
    expect(r.specificReturn).toBeCloseTo(250 * r.alpha, 12);
  });

  it('a risk-free rate shifts alpha down by rf and leaves the betas unchanged', () => {
    const { returns, market, size } = syntheticFactorSet(250);
    const factors = [
      { name: 'market', returns: market },
      { name: 'size', returns: size },
    ];
    const base = factorAttribution({ returns, factors });
    const excess = factorAttribution({ returns, factors, riskFreeRate: 0.0003 });
    expect(excess.alpha).toBeCloseTo(base.alpha - 0.0003, 12);
    expect(excess.factors[0]!.beta).toBeCloseTo(base.factors[0]!.beta, 12);
    // The identity still holds on the excess series.
    const sumContrib = excess.factors.reduce((s, f) => s + f.contribution, 0);
    expect(excess.totalReturn).toBeCloseTo(excess.specificReturn + sumContrib, 12);
  });

  it('throws on a rank-deficient regression (collinear factors) and on bad shapes', () => {
    const { returns, market } = syntheticFactorSet(60);
    // Two identical factor columns ⇒ singular XᵀX ⇒ no finite betas.
    expect(() =>
      factorAttribution({
        returns,
        factors: [
          { name: 'a', returns: market },
          { name: 'b', returns: market },
        ],
      }),
    ).toThrowError();
    expect(() => factorAttribution(undefined as never)).toThrowError();
    expect(() => factorAttribution({ returns, factors: [] })).toThrowError(); // no factors
    expect(() =>
      factorAttribution({ returns: [0.1, 0.2], factors: [{ name: 'm', returns: [0.1] }] }),
    ).toThrowError(); // too few observations
    // Enough observations, but a factor series is a different length than the subject.
    expect(() =>
      factorAttribution({
        returns: market,
        factors: [{ name: 'm', returns: market.slice(0, 40) }],
      }),
    ).toThrowError();
  });
});

describe('brinsonAttribution', () => {
  const segs = [
    {
      name: 'Tech',
      portfolioWeight: 0.4,
      benchmarkWeight: 0.3,
      portfolioReturn: 0.12,
      benchmarkReturn: 0.1,
    },
    {
      name: 'Fin',
      portfolioWeight: 0.2,
      benchmarkWeight: 0.3,
      portfolioReturn: 0.05,
      benchmarkReturn: 0.06,
    },
    {
      name: 'Energy',
      portfolioWeight: 0.4,
      benchmarkWeight: 0.4,
      portfolioReturn: 0.08,
      benchmarkReturn: 0.07,
    },
  ];

  it('splits the active return into allocation + selection + interaction, exactly (Fachler, unit weights)', () => {
    const r = brinsonAttribution(segs);
    expect(r.method).toBe('brinson-fachler');
    expect(r.portfolioReturn).toBeCloseTo(0.09, 12);
    expect(r.benchmarkReturn).toBeCloseTo(0.076, 12);
    expect(r.activeReturn).toBeCloseTo(0.014, 12);
    expect(r.allocation + r.selection + r.interaction).toBeCloseTo(r.activeReturn, 12);
    // Per-segment effects sum to the totals and to each segment's own total.
    expect(r.segments.reduce((s, x) => s + x.allocation, 0)).toBeCloseTo(r.allocation, 12);
    expect(r.segments[0]!.total).toBeCloseTo(
      r.segments[0]!.allocation + r.segments[0]!.selection + r.segments[0]!.interaction,
      12,
    );
    expect(r.diagnostics.warnings).toHaveLength(0);
  });

  it('Brinson–Hood–Beebower reconciles for ANY weights (including non-unit)', () => {
    const nonUnit = [
      {
        name: 'A',
        portfolioWeight: 0.5,
        benchmarkWeight: 0.4,
        portfolioReturn: 0.1,
        benchmarkReturn: 0.08,
      },
      {
        name: 'B',
        portfolioWeight: 0.3,
        benchmarkWeight: 0.35,
        portfolioReturn: 0.04,
        benchmarkReturn: 0.05,
      },
    ];
    const bhb = brinsonAttribution(nonUnit, { method: 'brinson-hood-beebower' });
    expect(bhb.allocation + bhb.selection + bhb.interaction).toBeCloseTo(bhb.activeReturn, 12);
    expect(bhb.diagnostics.warnings).toHaveLength(0);
  });

  it('Fachler and BHB agree on the allocation total at unit weights (per-segment difference = Rb·(wp−wb))', () => {
    const bf = brinsonAttribution(segs, { method: 'brinson-fachler' });
    const bhb = brinsonAttribution(segs, { method: 'brinson-hood-beebower' });
    expect(bf.allocation).toBeCloseTo(bhb.allocation, 12);
    for (let i = 0; i < segs.length; i++) {
      const difference = bhb.segments[i]!.allocation - bf.segments[i]!.allocation;
      const expected = bf.benchmarkReturn * (segs[i]!.portfolioWeight - segs[i]!.benchmarkWeight);
      expect(difference).toBeCloseTo(expected, 12);
    }
  });

  it('discloses a non-reconciling Fachler decomposition when weights are unequal', () => {
    const nonUnit = [
      {
        name: 'A',
        portfolioWeight: 0.5,
        benchmarkWeight: 0.4,
        portfolioReturn: 0.1,
        benchmarkReturn: 0.08,
      },
      {
        name: 'B',
        portfolioWeight: 0.3,
        benchmarkWeight: 0.35,
        portfolioReturn: 0.04,
        benchmarkReturn: 0.05,
      },
    ];
    const bf = brinsonAttribution(nonUnit); // Fachler default
    expect(bf.diagnostics.warnings.some((w) => w.code === 'risk.brinson_weights')).toBe(true);
    // The residual is exactly Rb·(Σwp − Σwb).
    const residual = bf.activeReturn - (bf.allocation + bf.selection + bf.interaction);
    const expected = bf.benchmarkReturn * (0.5 + 0.3 - (0.4 + 0.35));
    expect(residual).toBeCloseTo(expected, 12);
  });

  it('throws on empty segments, a bad method, and non-finite inputs', () => {
    expect(() => brinsonAttribution([])).toThrowError();
    expect(() => brinsonAttribution(undefined as never)).toThrowError();
    expect(() => brinsonAttribution(segs, { method: 'bogus' as never })).toThrowError();
    expect(() => brinsonAttribution([{ ...segs[0]!, portfolioWeight: Number.NaN }])).toThrowError();
  });
});

describe('linkAttribution — multi-period Cariño linking', () => {
  // Three quarters whose effects reconcile to each period's active return; Q3 is flat-active (P == B).
  const periods: AttributionPeriod[] = [
    {
      portfolioReturn: 0.05,
      benchmarkReturn: 0.03,
      allocation: 0.008,
      selection: 0.01,
      interaction: 0.002,
      label: 'Q1',
    },
    {
      portfolioReturn: -0.02,
      benchmarkReturn: 0.01,
      allocation: -0.015,
      selection: -0.01,
      interaction: -0.005,
      label: 'Q2',
    },
    {
      portfolioReturn: 0.04,
      benchmarkReturn: 0.04,
      allocation: 0,
      selection: 0,
      interaction: 0,
      label: 'Q3',
    },
  ];
  const compound = (key: 'portfolioReturn' | 'benchmarkReturn') =>
    periods.reduce((acc, p) => acc * (1 + p[key]), 1) - 1;

  it('links so the effects sum EXACTLY to the compounded (geometric) active return', () => {
    const r = linkAttribution(periods);
    expect(r.portfolioReturn).toBeCloseTo(compound('portfolioReturn'), 12);
    expect(r.benchmarkReturn).toBeCloseTo(compound('benchmarkReturn'), 12);
    expect(r.activeReturn).toBeCloseTo(r.portfolioReturn - r.benchmarkReturn, 12);
    // The headline identity — the naive arithmetic sum does NOT reconcile.
    expect(r.allocation + r.selection + r.interaction).toBeCloseTo(r.activeReturn, 12);
    // Every linking coefficient is finite (the flat-active Q3 uses the L'Hôpital limit) and labeled.
    expect(r.linkingCoefficients.every((c) => Number.isFinite(c.coefficient))).toBe(true);
    expect(r.linkingCoefficients.map((c) => c.label)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(r.assumptions.periods).toBe(3);
  });

  it('genuinely differs from the naive arithmetic sum (the problem linking solves)', () => {
    const r = linkAttribution(periods);
    const naive = periods.reduce((s, p) => s + p.allocation + p.selection + p.interaction, 0);
    expect(Math.abs(r.activeReturn - naive)).toBeGreaterThan(1e-4);
  });

  it('reduces to the input effects with coefficient 1 for a single period', () => {
    const r = linkAttribution([periods[0]!]);
    expect(r.linkingCoefficients[0]!.coefficient).toBeCloseTo(1, 12);
    expect(r.allocation).toBeCloseTo(periods[0]!.allocation, 12);
    expect(r.selection).toBeCloseTo(periods[0]!.selection, 12);
    expect(r.activeReturn).toBeCloseTo(
      periods[0]!.portfolioReturn - periods[0]!.benchmarkReturn,
      12,
    );
  });

  it('handles a flat-active TOTAL (R_P == R_B) via the limit — finite coefficients, zero active', () => {
    // Symmetric quarters compound to the same P and B ⇒ total active return is exactly 0.
    const sym: AttributionPeriod[] = [
      {
        portfolioReturn: 0.05,
        benchmarkReturn: 0.03,
        allocation: 0.02,
        selection: 0,
        interaction: 0,
      },
      {
        portfolioReturn: 0.03,
        benchmarkReturn: 0.05,
        allocation: -0.02,
        selection: 0,
        interaction: 0,
      },
    ];
    const r = linkAttribution(sym);
    expect(r.activeReturn).toBeCloseTo(0, 12);
    expect(r.linkingCoefficients.every((c) => Number.isFinite(c.coefficient))).toBe(true);
    expect(r.allocation + r.selection + r.interaction).toBeCloseTo(0, 12);
  });

  it('links a sequence of real brinsonAttribution results, with a reconciling segment breakdown', () => {
    const q = (pw: number, pr1: number, pr2: number) =>
      brinsonAttribution(
        [
          {
            name: 'Tech',
            portfolioWeight: pw,
            benchmarkWeight: 0.5,
            portfolioReturn: pr1,
            benchmarkReturn: 0.08,
          },
          {
            name: 'Fin',
            portfolioWeight: 1 - pw,
            benchmarkWeight: 0.5,
            portfolioReturn: pr2,
            benchmarkReturn: 0.04,
          },
        ],
        { method: 'brinson-hood-beebower' }, // BHB always reconciles a+s+i = active
      );
    const r = linkAttribution([q(0.6, 0.1, 0.05), q(0.4, 0.09, 0.06), q(0.7, 0.11, 0.03)]);
    // The linked effects still reconcile to the geometric active return.
    expect(r.allocation + r.selection + r.interaction).toBeCloseTo(r.activeReturn, 10);
    // The segment breakdown is present and sums to the cumulative effects.
    expect(r.segments).toBeDefined();
    const segNames = r.segments!.map((s) => s.name).sort();
    expect(segNames).toEqual(['Fin', 'Tech']);
    for (const s of r.segments!)
      expect(s.total).toBeCloseTo(s.allocation + s.selection + s.interaction, 12);
    expect(r.segments!.reduce((a, s) => a + s.allocation, 0)).toBeCloseTo(r.allocation, 10);
    expect(r.segments!.reduce((a, s) => a + s.total, 0)).toBeCloseTo(r.activeReturn, 10);
  });

  it('omits the segment breakdown unless every period supplies segments', () => {
    const withSegs = brinsonAttribution(
      [
        {
          name: 'A',
          portfolioWeight: 1,
          benchmarkWeight: 1,
          portfolioReturn: 0.1,
          benchmarkReturn: 0.08,
        },
      ],
      { method: 'brinson-hood-beebower' },
    );
    const noSegs: AttributionPeriod = {
      portfolioReturn: 0.03,
      benchmarkReturn: 0.02,
      allocation: 0.01,
      selection: 0,
      interaction: 0,
    };
    expect(linkAttribution([withSegs, noSegs]).segments).toBeUndefined();
  });

  it('guards empty/non-array periods, non-finite or ≤ −100% returns, a bad method, and a bad period', () => {
    expect(() => linkAttribution([])).toThrowError();
    expect(() => linkAttribution(undefined as never)).toThrowError();
    expect(() => linkAttribution([undefined as never])).toThrowError();
    expect(() => linkAttribution([{ ...periods[0]!, portfolioReturn: Number.NaN }])).toThrowError();
    expect(() => linkAttribution([{ ...periods[0]!, portfolioReturn: -1 }])).toThrowError(); // −100%
    expect(() => linkAttribution([{ ...periods[0]!, benchmarkReturn: -1.5 }])).toThrowError(); // < −100%
    expect(() => linkAttribution(periods, { method: 'menchero' as never })).toThrowError();
  });
});
