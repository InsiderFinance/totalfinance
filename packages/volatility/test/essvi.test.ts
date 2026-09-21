/**
 * eSSVI — SSVI with a per-maturity skew `ρ(θ)` (`calibrateEssvi`, `essviTotalVariance`, `essviVolatility`,
 * `essviArbitrageFree`). A constant `ρ(θ)` reproduces SSVI exactly; the evaluators match a white-box
 * recomputation of the slice formula (verifying the θ/ρ interpolation); calibration recovers a known skew
 * term structure to machine precision and beats a global-ρ SSVI fit; the arbitrage scan flags a θ-monotone
 * surface that nonetheless crosses in maturity, and butterfly violations; and the guards hold.
 */

import { describe, expect, it } from 'vitest';
import { calibrateEssvi, calibrateSsvi, type ESSVIParameters } from '@totalfinance/volatility';
import {
  essviArbitrageFree,
  essviTotalVariance,
  essviVolatility,
} from '@totalfinance/volatility/essvi';
import { ssviTotalVariance } from '@totalfinance/volatility/ssvi';

const PHI = { kind: 'power-law' as const, eta: 1.5, gamma: 0.4 };

// ── white-box recomputation of the eSSVI slice, to verify the evaluators + interpolation ──
const phiVal = (theta: number) => PHI.eta * Math.pow(theta, -PHI.gamma);
function interp(
  term: ESSVIParameters['thetaTerm'],
  timeToExpiryYears: number,
  field: 'theta' | 'rho',
): number {
  const n = term.length;
  if (field === 'theta') {
    const first = term[0]!;
    if (timeToExpiryYears <= first.timeToExpiryYears)
      return (first.theta * timeToExpiryYears) / first.timeToExpiryYears;
    const last = term[n - 1]!;
    if (timeToExpiryYears >= last.timeToExpiryYears) return last.theta;
    for (let i = 1; i < n; i++) {
      const hi = term[i]!;
      if (timeToExpiryYears <= hi.timeToExpiryYears) {
        const lo = term[i - 1]!;
        return (
          lo.theta +
          ((timeToExpiryYears - lo.timeToExpiryYears) /
            (hi.timeToExpiryYears - lo.timeToExpiryYears)) *
            (hi.theta - lo.theta)
        );
      }
    }
    return last.theta;
  }
  if (timeToExpiryYears <= term[0]!.timeToExpiryYears) return term[0]!.rho;
  for (let i = 1; i < n; i++) {
    const hi = term[i]!;
    if (timeToExpiryYears <= hi.timeToExpiryYears) {
      const lo = term[i - 1]!;
      return (
        lo.rho +
        ((timeToExpiryYears - lo.timeToExpiryYears) /
          (hi.timeToExpiryYears - lo.timeToExpiryYears)) *
          (hi.rho - lo.rho)
      );
    }
  }
  return term[n - 1]!.rho;
}
function sliceW(parameters: ESSVIParameters, k: number, timeToExpiryYears: number): number {
  const theta = interp(parameters.thetaTerm, timeToExpiryYears, 'theta');
  const rho = interp(parameters.thetaTerm, timeToExpiryYears, 'rho');
  const psi = phiVal(theta);
  return (theta / 2) * (1 + rho * psi * k + Math.sqrt((psi * k + rho) ** 2 + (1 - rho * rho)));
}

const TRUTH: ESSVIParameters = {
  phi: PHI,
  thetaTerm: [
    { timeToExpiryYears: 0.1, theta: 0.02, rho: -0.75 },
    { timeToExpiryYears: 0.5, theta: 0.035, rho: -0.5 },
    { timeToExpiryYears: 2.0, theta: 0.06, rho: -0.18 },
  ],
};
const KS = [-0.4, -0.25, -0.12, -0.05, 0, 0.05, 0.12, 0.25, 0.4];
function slicesFrom(parameters: ESSVIParameters) {
  return parameters.thetaTerm.map((kn) => ({
    timeToExpiryYears: kn.timeToExpiryYears,
    k: KS,
    w: KS.map((k) => essviTotalVariance(parameters, k, kn.timeToExpiryYears)),
  }));
}

describe('essviTotalVariance / essviVolatility', () => {
  it('reduces to SSVI exactly when ρ(θ) is constant', () => {
    const RHO = -0.4;
    const flat: ESSVIParameters = {
      phi: PHI,
      thetaTerm: TRUTH.thetaTerm.map((kn) => ({ ...kn, rho: RHO })),
    };
    const ssviParams = {
      rho: RHO,
      phi: PHI,
      thetaTerm: TRUTH.thetaTerm.map((kn) => ({
        timeToExpiryYears: kn.timeToExpiryYears,
        theta: kn.theta,
      })),
    };
    for (const k of KS) {
      for (const t of [0.1, 0.3, 0.5, 1, 2, 3]) {
        expect(essviTotalVariance(flat, k, t)).toBeCloseTo(ssviTotalVariance(ssviParams, k, t), 14);
      }
    }
  });

  it('matches the white-box slice formula, exercising θ/ρ interpolation below/between/above knots', () => {
    for (const t of [0.05, 0.1, 0.3, 0.5, 1.2, 2.0, 3.0]) {
      for (const k of KS) {
        expect(essviTotalVariance(TRUTH, k, t)).toBeCloseTo(sliceW(TRUTH, k, t), 14);
        expect(essviVolatility(TRUTH, k, t)).toBeCloseTo(Math.sqrt(sliceW(TRUTH, k, t) / t), 14);
      }
    }
  });

  it('interpolates ρ linearly between knots', () => {
    // Hold θ (hence ψ) constant across the two knots so the ATM total-variance skew ∂w/∂k|₀ = θ·ρ·ψ is
    // driven by ρ alone. A linear ρ(t) then gives a linear skew(t), whose midpoint is the endpoint mean.
    const p: ESSVIParameters = {
      phi: PHI,
      thetaTerm: [
        { timeToExpiryYears: 0.2, theta: 0.04, rho: -0.8 },
        { timeToExpiryYears: 1.0, theta: 0.04, rho: -0.2 },
      ],
    };
    const skew = (t: number) => {
      const h = 1e-5;
      return (essviTotalVariance(p, h, t) - essviTotalVariance(p, -h, t)) / (2 * h);
    };
    const s02 = skew(0.2);
    const s06 = skew(0.6); // ρ(0.6) = −0.5, the midpoint
    const s10 = skew(1.0);
    expect(s06).toBeCloseTo((s02 + s10) / 2, 6);
    expect(s06).toBeGreaterThan(s02); // milder skew than the steep −0.8 knot
    expect(s06).toBeLessThan(s10); // steeper skew than the mild −0.2 knot
  });

  it('guards bad parameters, a non-finite k, and a non-positive t', () => {
    expect(() => essviTotalVariance(undefined as never, 0.1, 0.5)).toThrowError();
    expect(() =>
      essviTotalVariance({ thetaTerm: TRUTH.thetaTerm } as never, 0.1, 0.5),
    ).toThrowError(); // no phi
    expect(() => essviTotalVariance({ phi: PHI } as never, 0.1, 0.5)).toThrowError(); // no thetaTerm
    expect(() => essviTotalVariance({ phi: PHI, thetaTerm: [] }, 0.1, 0.5)).toThrowError(); // empty
    expect(() =>
      essviTotalVariance({ phi: PHI, thetaTerm: [null as never] }, 0.1, 0.5),
    ).toThrowError(); // non-object knot
    expect(() =>
      essviTotalVariance(
        { phi: PHI, thetaTerm: [{ timeToExpiryYears: 1, theta: 0.04, rho: NaN }] },
        0.1,
        0.5,
      ),
    ).toThrowError(); // non-finite ρ
    expect(() => essviTotalVariance(TRUTH, NaN, 0.5)).toThrowError(); // non-finite k
    expect(() => essviTotalVariance(TRUTH, 0.1, 0)).toThrowError(); // t ≤ 0
    expect(() => essviVolatility(TRUTH, 0.1, -1)).toThrowError();
  });
});

describe('calibrateEssvi', () => {
  it('recovers a known skew term structure to machine precision and beats global-ρ SSVI', () => {
    const slices = slicesFrom(TRUTH);
    const ssvi = calibrateSsvi({ slices }, { phi: 'power-law' });
    const essvi = calibrateEssvi({ slices }, { phi: 'power-law' });
    expect(essvi.converged).toBe(true);
    // per-maturity ρ recovered
    expect(essvi.rhoTerm.map((r) => r.timeToExpiryYears)).toEqual([0.1, 0.5, 2.0]);
    expect(essvi.rhoTerm[0]!.rho).toBeCloseTo(-0.75, 4);
    expect(essvi.rhoTerm[1]!.rho).toBeCloseTo(-0.5, 4);
    expect(essvi.rhoTerm[2]!.rho).toBeCloseTo(-0.18, 4);
    // fits far better than a single global ρ can
    expect(essvi.rmse).toBeLessThan(1e-8);
    expect(essvi.rmse).toBeLessThan(ssvi.rmse / 100);
    // arbitrage-free + disclosed
    expect(essvi.arbitrage.calendarArbitrageFree).toBe(true);
    expect(essvi.arbitrage.butterflyArbitrageFree).toBe(true);
    expect(essvi.assumptions.skew).toBe('per-maturity');
    expect(essvi.diagnostics.engine).toBe('essvi');
    // per-slice RMSE all tiny
    for (const p of essvi.perSliceRmse) expect(p.rmse).toBeLessThan(1e-8);
  });

  it('reduces to a (near-)global ρ when the market has no skew term structure', () => {
    const flat: ESSVIParameters = {
      phi: PHI,
      thetaTerm: TRUTH.thetaTerm.map((kn) => ({ ...kn, rho: -0.4 })),
    };
    const essvi = calibrateEssvi({ slices: slicesFrom(flat) }, { phi: 'power-law' });
    for (const r of essvi.rhoTerm) expect(r.rho).toBeCloseTo(-0.4, 3);
    expect(essvi.rmse).toBeLessThan(1e-8);
  });

  it('fits with the Heston curvature family too', () => {
    // Build the market from a Heston-φ eSSVI so the Heston fit can recover it well.
    const hestonTruth: ESSVIParameters = {
      phi: { kind: 'heston', lambda: 1.2 },
      thetaTerm: [
        { timeToExpiryYears: 0.1, theta: 0.02, rho: -0.7 },
        { timeToExpiryYears: 1.0, theta: 0.05, rho: -0.3 },
      ],
    };
    const slices = hestonTruth.thetaTerm.map((kn) => ({
      timeToExpiryYears: kn.timeToExpiryYears,
      k: KS,
      w: KS.map((k) => essviTotalVariance(hestonTruth, k, kn.timeToExpiryYears)),
    }));
    const ssvi = calibrateSsvi({ slices }, { phi: 'heston' });
    const essvi = calibrateEssvi({ slices }, { phi: 'heston' });
    expect(essvi.assumptions.phi).toBe('heston');
    expect(essvi.diagnostics.method).toContain('heston');
    // Warm-started from the global SSVI heston fit, eSSVI is never worse (a strict superset).
    expect(essvi.rmse).toBeLessThanOrEqual(ssvi.rmse + 1e-12);
    expect(essvi.rmse).toBeLessThan(1e-3);
    expect(Number.isFinite(essvi.rhoTerm[0]!.rho)).toBe(true);
  });

  it('handles a steep single-signed skew surface (ρ near the boundary)', () => {
    const steep: ESSVIParameters = {
      phi: PHI,
      thetaTerm: [
        { timeToExpiryYears: 0.1, theta: 0.02, rho: -0.95 },
        { timeToExpiryYears: 1.0, theta: 0.05, rho: -0.9 },
      ],
    };
    const essvi = calibrateEssvi({ slices: slicesFrom(steep) }, { phi: 'power-law' });
    expect(essvi.rhoTerm[0]!.rho).toBeCloseTo(-0.95, 2);
    expect(Number.isFinite(essvi.rmse)).toBe(true);
  });

  it('clamps a non-monotone ATM data term structure and discloses it', () => {
    // Short slice with HIGHER ATM total variance than the long slice ⇒ a data calendar arbitrage.
    const shortHi: ESSVIParameters = {
      phi: PHI,
      thetaTerm: [
        { timeToExpiryYears: 0.25, theta: 0.05, rho: -0.5 },
        { timeToExpiryYears: 1.0, theta: 0.03, rho: -0.3 }, // θ decreases → non-monotone
      ],
    };
    const slices = shortHi.thetaTerm.map((kn) => ({
      timeToExpiryYears: kn.timeToExpiryYears,
      k: KS,
      w: KS.map((k) => essviTotalVariance(shortHi, k, kn.timeToExpiryYears)),
    }));
    const essvi = calibrateEssvi({ slices }, { phi: 'power-law' });
    expect(
      essvi.diagnostics.warnings.some((w) => w.code === 'volatility.essvi_calendar_data'),
    ).toBe(true);
    // clamped to a non-decreasing θ hull
    expect(essvi.parameters.thetaTerm[1]!.theta).toBeGreaterThanOrEqual(
      essvi.parameters.thetaTerm[0]!.theta,
    );
  });

  it('discloses a fit that did not converge', () => {
    const essvi = calibrateEssvi(
      { slices: slicesFrom(TRUTH) },
      { phi: 'power-law', maximumIterations: 1, tolerance: 1e-18 },
    );
    expect(essvi.converged).toBe(false);
    expect(
      essvi.diagnostics.warnings.some((w) => w.code === 'volatility.essvi_not_converged'),
    ).toBe(true);
  });

  it('warns when the fitted surface embeds butterfly arbitrage', () => {
    // Market built from a high-curvature (butterfly-violating) eSSVI ⇒ the fit reproduces it.
    const wild: ESSVIParameters = {
      phi: { kind: 'power-law', eta: 12, gamma: 0.05 },
      thetaTerm: [
        { timeToExpiryYears: 0.1, theta: 0.05, rho: -0.6 },
        { timeToExpiryYears: 1.0, theta: 0.08, rho: -0.4 },
      ],
    };
    expect(essviArbitrageFree(wild).butterflyArbitrageFree).toBe(false); // the truth itself violates
    const slices = wild.thetaTerm.map((kn) => ({
      timeToExpiryYears: kn.timeToExpiryYears,
      k: KS,
      w: KS.map((k) => essviTotalVariance(wild, k, kn.timeToExpiryYears)),
    }));
    const essvi = calibrateEssvi({ slices }, { phi: 'power-law' });
    expect(essvi.diagnostics.warnings.some((w) => w.code === 'volatility.essvi_butterfly')).toBe(
      true,
    );
  });

  it('guards an invalid phi family and a too-thin surface', () => {
    expect(() =>
      calibrateEssvi({ slices: slicesFrom(TRUTH) }, { phi: 'garbage' as never }),
    ).toThrowError();
    expect(() => calibrateEssvi(undefined as never)).toThrowError();
    expect(() => calibrateEssvi({ slices: [slicesFrom(TRUTH)[0]!] })).toThrowError(); // < 2 slices
  });

  it('accepts a vega weighting (echoed, default uniform) and threads it through the SSVI warm-start', () => {
    const slices = slicesFrom(TRUTH);
    expect(calibrateEssvi({ slices }).assumptions.weight).toBe('uniform'); // default
    const veg = calibrateEssvi({ slices }, { weight: 'vega' });
    expect(veg.assumptions.weight).toBe('vega');
    // Still recovers the per-maturity skew (the clean synthetic surface fits under either weighting).
    expect(veg.rhoTerm[0]!.rho).toBeCloseTo(-0.75, 2);
    expect(veg.rhoTerm[2]!.rho).toBeCloseTo(-0.18, 2);
    expect(() => calibrateEssvi({ slices }, { weight: 'bad' as never })).toThrowError();
  });
});

describe('essviArbitrageFree', () => {
  it('flags a θ-monotone surface that still crosses in maturity (ρ varying)', () => {
    const crossing: ESSVIParameters = {
      phi: { kind: 'power-law', eta: 2, gamma: 0.5 },
      thetaTerm: [
        { timeToExpiryYears: 0.1, theta: 0.02, rho: -0.9 },
        { timeToExpiryYears: 1.0, theta: 0.021, rho: -0.1 }, // θ barely increases, skew flattens sharply
      ],
    };
    const arb = essviArbitrageFree(crossing);
    expect(arb.calendarArbitrageFree).toBe(false);
    expect(arb.minCalendarSlope).toBeLessThan(0);
  });

  it('passes a well-ordered surface and reports positive slack', () => {
    const arb = essviArbitrageFree(TRUTH);
    expect(arb.calendarArbitrageFree).toBe(true);
    expect(arb.butterflyArbitrageFree).toBe(true);
    expect(arb.minCalendarSlope).toBeGreaterThanOrEqual(0);
    expect(arb.minButterflyG).toBeGreaterThan(0);
  });

  it('accepts custom k and t grids', () => {
    const arb = essviArbitrageFree(TRUTH, { grid: [-0.2, 0, 0.2], maturityGrid: [0.1, 0.5, 1, 2] });
    expect(typeof arb.calendarArbitrageFree).toBe('boolean');
    expect(Number.isFinite(arb.minButterflyG)).toBe(true);
  });

  it('guards bad parameters and non-object options', () => {
    expect(() => essviArbitrageFree(undefined as never)).toThrowError();
    expect(() => essviArbitrageFree(TRUTH, null as never)).toThrowError();
  });
});
