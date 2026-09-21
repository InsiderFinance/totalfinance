/**
 * SSVI arbitrage-free surface (`calibrateSsvi`, `ssviVolatility`, `ssviTotalVariance`, `ssviArbitrageFree`).
 * Verifies the ATM identity `w(0,t)=θ`, that calibration recovers a known `(ρ,η,γ)` from a synthetic
 * surface and round-trips the input smiles, that the calibrated surface is calendar-arbitrage-free
 * (`w(k,·)` non-decreasing in `t`), that butterfly arbitrage is detected on a pathological slice and
 * cleared on a good one, the linear-in-`t` θ interpolation, the non-monotone-data clamp+warning, the
 * Heston φ, and the guards.
 */

import { describe, expect, it } from 'vitest';
import {
  type SSVICalibrationInput,
  type SSVIParameters,
  calibrateSsvi,
} from '@totalfinance/volatility';
import {
  ssviArbitrageFree,
  ssviTotalVariance,
  ssviVolatility,
} from '@totalfinance/volatility/ssvi';

/** SSVI total variance at a fixed θ — the reference formula the surface must reproduce. */
function ssviW(k: number, theta: number, rho: number, psi: number): number {
  return (theta / 2) * (1 + rho * psi * k + Math.sqrt((psi * k + rho) ** 2 + (1 - rho * rho)));
}
const phiPower = (theta: number, eta: number, gamma: number): number =>
  eta * Math.pow(theta, -gamma);

const KS = [-0.5, -0.3, -0.15, -0.05, 0, 0.05, 0.15, 0.3, 0.5];

/** A synthetic arbitrage-free equity surface generated from known SSVI parameters. */
function syntheticSurface(rho: number, eta: number, gamma: number): SSVICalibrationInput {
  const mats = [0.05, 0.15, 0.35, 0.7, 1.5];
  const atmVolatility = [0.32, 0.29, 0.27, 0.255, 0.24];
  return {
    slices: mats.map((t, i) => {
      const theta = atmVolatility[i]! * atmVolatility[i]! * t;
      const psi = phiPower(theta, eta, gamma);
      return {
        timeToExpiryYears: t,
        k: KS,
        impliedVolatility: KS.map((k) => Math.sqrt(ssviW(k, theta, rho, psi) / t)),
      };
    }),
  };
}

describe('SSVI — evaluation', () => {
  it('the ATM total variance equals θ, and θ interpolates linearly in t', () => {
    const parameters: SSVIParameters = {
      rho: -0.4,
      phi: { kind: 'power-law', eta: 1.5, gamma: 0.4 },
      thetaTerm: [
        { timeToExpiryYears: 0.25, theta: 0.02 },
        { timeToExpiryYears: 1, theta: 0.06 },
      ],
    };
    // w(0, t) = θ(t).
    expect(ssviTotalVariance(parameters, 0, 0.25)).toBeCloseTo(0.02, 12);
    expect(ssviTotalVariance(parameters, 0, 1)).toBeCloseTo(0.06, 12);
    // Midpoint in t → linear θ interpolation.
    expect(ssviTotalVariance(parameters, 0, 0.625)).toBeCloseTo(0.04, 12);
    // Below the first knot → θ(t) = θ₁·t/t₁, so θ(0.125) = 0.02·0.5 = 0.01.
    expect(ssviTotalVariance(parameters, 0, 0.125)).toBeCloseTo(0.01, 12);
    // Beyond the last knot → flat θ.
    expect(ssviTotalVariance(parameters, 0, 2)).toBeCloseTo(0.06, 12);
    // ssviVolatility = √(w/t).
    expect(ssviVolatility(parameters, 0, 1)).toBeCloseTo(Math.sqrt(0.06), 12);
  });
});

describe('SSVI — calibration', () => {
  it('recovers the generating (ρ, η, γ) from a synthetic surface and round-trips the smiles', () => {
    const cal = calibrateSsvi(syntheticSurface(-0.55, 1.8, 0.42));
    expect(cal.converged).toBe(true);
    expect(cal.parameters.rho).toBeCloseTo(-0.55, 3);
    const phi = cal.parameters.phi as { kind: 'power-law'; eta: number; gamma: number };
    expect(phi.eta).toBeCloseTo(1.8, 2);
    expect(phi.gamma).toBeCloseTo(0.42, 2);
    expect(cal.rmse).toBeLessThan(1e-6);
    // θ knots are increasing (calendar-arb-free), and every slice round-trips.
    for (let i = 1; i < cal.parameters.thetaTerm.length; i++) {
      expect(cal.parameters.thetaTerm[i]!.theta).toBeGreaterThan(
        cal.parameters.thetaTerm[i - 1]!.theta,
      );
    }
    expect(cal.perSliceRmse.every((s) => s.rmse < 1e-6)).toBe(true);
    expect(cal.arbitrage.calendarArbitrageFree).toBe(true);
    expect(cal.arbitrage.butterflyArbitrageFree).toBe(true);
  });

  it('the calibrated surface is calendar-arbitrage-free — w(k,·) is non-decreasing in t', () => {
    const cal = calibrateSsvi(syntheticSurface(-0.5, 2, 0.4));
    for (const k of [-0.4, -0.2, 0, 0.2, 0.4]) {
      let prev = -Infinity;
      for (let t = 0.05; t <= 1.5; t += 0.05) {
        const w = ssviTotalVariance(cal.parameters, k, t);
        expect(w).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = w;
      }
    }
  });

  it('a Heston φ calibrates and recovers its λ from a Heston-generated surface', () => {
    // Generate the surface from a Heston φ so the right family can recover it tightly.
    const phiHeston = (theta: number, lambda: number): number => {
      const lt = lambda * theta;
      return (1 / lt) * (1 - (1 - Math.exp(-lt)) / lt);
    };
    const mats = [0.05, 0.15, 0.35, 0.7, 1.5];
    const atmVolatility = [0.32, 0.29, 0.27, 0.255, 0.24];
    const rho = -0.5;
    const lambda = 3;
    const surface: SSVICalibrationInput = {
      slices: mats.map((t, i) => {
        const theta = atmVolatility[i]! * atmVolatility[i]! * t;
        const psi = phiHeston(theta, lambda);
        return {
          timeToExpiryYears: t,
          k: KS,
          impliedVolatility: KS.map((k) => Math.sqrt(ssviW(k, theta, rho, psi) / t)),
        };
      }),
    };
    const cal = calibrateSsvi(surface, { phi: 'heston' });
    expect(cal.assumptions.phi).toBe('heston');
    expect(cal.parameters.phi.kind).toBe('heston');
    expect(cal.parameters.rho).toBeCloseTo(rho, 2);
    expect((cal.parameters.phi as { kind: 'heston'; lambda: number }).lambda).toBeCloseTo(
      lambda,
      1,
    );
    expect(cal.rmse).toBeLessThan(1e-5);
  });

  it('accepts total-variance (w) input equivalently to impliedVolatility input', () => {
    const s = syntheticSurface(-0.5, 2, 0.4);
    const withW: SSVICalibrationInput = {
      slices: s.slices.map((sl) => ({
        timeToExpiryYears: sl.timeToExpiryYears,
        k: sl.k,
        w: sl.impliedVolatility!.map((v) => v * v * sl.timeToExpiryYears),
      })),
    };
    const a = calibrateSsvi(s);
    const b = calibrateSsvi(withW);
    expect(b.parameters.rho).toBeCloseTo(a.parameters.rho, 8);
    expect(b.rmse).toBeCloseTo(a.rmse, 8);
  });

  it('discloses butterfly arbitrage when the market data embeds it', () => {
    // Generate the surface from over-curved (arbitrageable) SSVI parameters; the fit recovers them and flags it.
    const rho = -0.5;
    const eta = 8;
    const gamma = 0.45;
    const mats = [0.05, 0.15, 0.35];
    const atmVolatility = [0.32, 0.29, 0.27];
    const surface: SSVICalibrationInput = {
      slices: mats.map((t, i) => {
        const theta = atmVolatility[i]! * atmVolatility[i]! * t;
        const psi = phiPower(theta, eta, gamma);
        return {
          timeToExpiryYears: t,
          k: KS,
          impliedVolatility: KS.map((k) => Math.sqrt(ssviW(k, theta, rho, psi) / t)),
        };
      }),
    };
    const cal = calibrateSsvi(surface);
    expect(cal.arbitrage.butterflyArbitrageFree).toBe(false);
    expect(cal.diagnostics.warnings.some((w) => w.code === 'volatility.ssvi_butterfly')).toBe(true);
  });

  it('clamps a non-monotone ATM term structure to its increasing hull and warns', () => {
    const bad: SSVICalibrationInput = {
      slices: [
        { timeToExpiryYears: 0.1, k: KS, impliedVolatility: KS.map(() => 0.3) }, // θ = 0.09·0.1 = 0.009
        { timeToExpiryYears: 0.3, k: KS, impliedVolatility: KS.map(() => 0.15) }, // θ = 0.0225·0.3 = 0.00675 < 0.009 (calendar arb)
      ],
    };
    const cal = calibrateSsvi(bad);
    expect(cal.parameters.thetaTerm[1]!.theta).toBeGreaterThanOrEqual(
      cal.parameters.thetaTerm[0]!.theta,
    );
    expect(cal.diagnostics.warnings.some((w) => w.code === 'volatility.ssvi_calendar_data')).toBe(
      true,
    );
  });
});

describe('SSVI — arbitrage diagnosis', () => {
  it('flags butterfly arbitrage on a pathological (over-curved) slice', () => {
    const bad: SSVIParameters = {
      rho: -0.5,
      phi: { kind: 'power-law', eta: 8, gamma: 0.45 }, // huge curvature ⇒ negative density
      thetaTerm: [
        { timeToExpiryYears: 0.1, theta: 0.02 },
        { timeToExpiryYears: 0.5, theta: 0.05 },
      ],
    };
    const arb = ssviArbitrageFree(bad);
    expect(arb.butterflyArbitrageFree).toBe(false);
    expect(arb.minButterflyG).toBeLessThan(0);
    expect(arb.sufficientConditionsHold).toBe(false);
  });

  it('clears a well-behaved slice', () => {
    const good: SSVIParameters = {
      rho: -0.3,
      phi: { kind: 'power-law', eta: 1, gamma: 0.4 },
      thetaTerm: [
        { timeToExpiryYears: 0.1, theta: 0.02 },
        { timeToExpiryYears: 1, theta: 0.06 },
      ],
    };
    const arb = ssviArbitrageFree(good);
    expect(arb.calendarArbitrageFree).toBe(true);
    expect(arb.butterflyArbitrageFree).toBe(true);
    expect(arb.minButterflyG).toBeGreaterThan(0);
  });
});

describe('SSVI — guards', () => {
  it('throws on garbage and malformed surfaces', () => {
    expect(() => calibrateSsvi(undefined as never)).toThrowError();
    expect(() => calibrateSsvi({ slices: [] })).toThrowError(); // < 2 slices
    expect(() =>
      calibrateSsvi({
        slices: [
          { timeToExpiryYears: 0.1, k: [0, 0.1], impliedVolatility: [0.3, 0.3] },
          { timeToExpiryYears: 0.2, k: [0, 0.1], impliedVolatility: [0.3, 0.3] },
        ],
      }),
    ).toThrowError(); // < 3 points
    expect(() =>
      calibrateSsvi({
        slices: [
          { timeToExpiryYears: 0.1, k: [0, 0.1, 0.2], impliedVolatility: [0.3, 0.3] }, // misaligned k/impliedVolatility
          { timeToExpiryYears: 0.2, k: KS, impliedVolatility: KS.map(() => 0.3) },
        ],
      }),
    ).toThrowError();
    expect(() =>
      calibrateSsvi({
        slices: [
          { timeToExpiryYears: 0.1, k: KS },
          { timeToExpiryYears: 0.2, k: KS },
        ] as never,
      }),
    ).toThrowError(); // no w or impliedVolatility
    expect(() =>
      calibrateSsvi(syntheticSurface(-0.5, 2, 0.4), { phi: 'bogus' as never }),
    ).toThrowError();
    expect(() =>
      calibrateSsvi({
        slices: [
          { timeToExpiryYears: -1, k: KS, impliedVolatility: KS.map(() => 0.3) },
          { timeToExpiryYears: 0.2, k: KS, impliedVolatility: KS.map(() => 0.3) },
        ],
      }),
    ).toThrowError(); // t ≤ 0
    expect(() =>
      calibrateSsvi({
        slices: [
          { timeToExpiryYears: 0.1, k: [-0.1, 0, 0.1], w: [-0.01, 0.02, 0.02] }, // non-positive total variance
          { timeToExpiryYears: 0.2, k: KS, impliedVolatility: KS.map(() => 0.3) },
        ],
      }),
    ).toThrowError();
  });

  it('ssviTotalVariance/ssviVolatility guard bad parameters and non-positive t', () => {
    const p: SSVIParameters = {
      rho: -0.3,
      phi: { kind: 'power-law', eta: 1, gamma: 0.4 },
      thetaTerm: [{ timeToExpiryYears: 1, theta: 0.05 }],
    };
    expect(() => ssviTotalVariance(undefined as never, 0, 1)).toThrowError();
    expect(() => ssviTotalVariance(p, 0, 0)).toThrowError(); // t ≤ 0
    expect(() => ssviTotalVariance(p, Number.NaN, 1)).toThrowError();
    expect(() => ssviTotalVariance({ ...p, thetaTerm: [] }, 0, 1)).toThrowError(); // no knots
  });
});

describe('SSVI — vega-weighted calibration', () => {
  // A fat-wing surface: the core (|k| ≤ 0.15) is a clean SSVI; the wings (|k| ≥ 0.3) are biased up (a common
  // bad-data pattern that pulls an unweighted fit off the liquid strikes).
  const base = syntheticSurface(-0.35, 1.2, 0.5);
  const distorted: SSVICalibrationInput = {
    slices: base.slices.map((sl) => ({
      timeToExpiryYears: sl.timeToExpiryYears,
      k: sl.k,
      impliedVolatility: sl.impliedVolatility!.map(
        (v, j) => v + (Math.abs(sl.k[j]!) >= 0.3 ? 0.03 : 0),
      ),
    })),
  };
  // Core-fit RMSE: fitted vol vs the (clean, undistorted) core input at |k| ≤ 0.15.
  const coreRMSE = (p: SSVIParameters): number => {
    let s = 0;
    let n = 0;
    base.slices.forEach((sl) => {
      sl.k.forEach((k, j) => {
        if (Math.abs(k) > 0.15) return;
        s += (ssviVolatility(p, k, sl.timeToExpiryYears) - sl.impliedVolatility![j]!) ** 2;
        n++;
      });
    });
    return Math.sqrt(s / n);
  };

  it('tightens the fit where liquidity concentrates (the ATM core) vs uniform', () => {
    const uni = calibrateSsvi(distorted, { weight: 'uniform' });
    const veg = calibrateSsvi(distorted, { weight: 'vega' });
    expect(uni.assumptions.weight).toBe('uniform');
    expect(veg.assumptions.weight).toBe('vega');
    // The vega fit is not pulled off the clean, high-vega core by the fat wings.
    expect(coreRMSE(veg.parameters)).toBeLessThan(coreRMSE(uni.parameters));
  });

  it('defaults to uniform (backward-compatible) and rejects a bad weight', () => {
    const def = calibrateSsvi(distorted);
    expect(def.assumptions.weight).toBe('uniform');
    // Omitting the weight is byte-identical to weight: 'uniform'.
    expect(def.parameters.rho).toBe(calibrateSsvi(distorted, { weight: 'uniform' }).parameters.rho);
    expect(() => calibrateSsvi(distorted, { weight: 'bad' as never })).toThrowError();
  });
});
