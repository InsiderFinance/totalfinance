/**
 * Global Heston calibration for the `model: 'heston'` volatility surface (spec §10.1).
 *
 * Unlike SVI/SABR (which fit each expiry independently), a single Heston parameter set
 * `(v0, κ, θ, σ, ρ)` generates the *entire* surface — both the smile and its term structure. This
 * calibrates those five parameters to all surface IVs at once by least squares (Nelder–Mead over a
 * bound-enforcing reparameterization), pricing each target with the COS Heston engine from
 * `@insiderfinance/totalfinance/options`.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type QuantWarning,
  validateClosedRequest,
  WarningCode,
} from '@totalfinance/core';
import { nelderMead } from '@totalfinance/math';
import { type HestonParameters } from '@totalfinance/options';
import { hestonImpliedVolatility } from '@totalfinance/options/heston';
import {
  requireCalibrationIterationBudget,
  requireHestonCosineTermCount,
} from './calibration-limits.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

/**
 * Generated closed-request spec (spec 3B.1b): the allowlist projected from the declaration.
 * Resolved at module load so a stale key fails at import.
 */
function hestonSurfaceSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `heston-surface: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const CALIBRATE_HESTON_SURFACE_SPEC = hestonSurfaceSpecOf('calibrateHestonSurface#0');

const CALIBRATE_HESTON_SURFACE_EXAMPLE = (): string =>
  'calibrateHestonSurface({ targets: [{ strike: 100, timeToExpiryYears: 0.25, ' +
  'impliedVolatility: 0.2, forward: 100.5 }], market: { spot: 100, riskFreeRate: 0.04, ' +
  'dividendYield: 0 } })';

export interface HestonSurfaceTarget {
  strike: number;
  timeToExpiryYears: number;
  impliedVolatility: number;
  forward: number;
}

export interface HestonSurfaceFit {
  parameters: HestonParameters;
  /** Root-mean-square IV error across all calibration targets. */
  rmse: number;
  /** The RMSE tolerance the `converged` flag was gated on (echoed for interpretability). */
  rmseTolerance: number;
  converged: boolean;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    targets: number;
    maximumIterations: number;
    /** Whether any starting member was caller-supplied (`initialParameters`) or all were data-derived. */
    initialParameters: 'supplied' | 'default';
  };
  /** Structured warnings; always present — a non-converged fit explains itself here. */
  diagnostics: { warnings: QuantWarning[] };
}

const clampRho = (r: number): number => Math.max(-0.999, Math.min(0.999, r));

/**
 * Calibrate one Heston parameter set to a set of `(strike, t, iv)` targets. Positives are fit in log
 * space and `ρ` through `tanh`, so the optimizer is unconstrained while the parameters stay valid.
 */
/** The state of the world for {@link calibrateHestonSurface}: spot and the carry rates. */
export interface HestonSurfaceMarket {
  spot: number;
  riskFreeRate: number;
  dividendYield: number;
}

export interface HestonSurfaceCalibrationInput {
  targets: readonly HestonSurfaceTarget[];
  market: HestonSurfaceMarket;
  options?: {
    /**
     * Warm start — a partial pin of the five parameters (Stage 4.5; formerly `seed`, retired: `seed`
     * names randomness everywhere else in the library). Unspecified members keep their data-derived
     * starts (ATM variance for `v0`/`theta`, κ = 2, σ = 0.5, ρ = −0.5).
     */
    initialParameters?: Partial<HestonParameters>;
    /** Heston COS expansion terms per target price (default 128, maximum 8,192). */
    terms?: number;
    /** Outer-search iteration budget (default 300, maximum 10,000). */
    maximumIterations?: number;
    /** Max RMSE the `converged` flag tolerates (default 0.02 IV points). */
    rmseTolerance?: number;
  };
}

export function calibrateHestonSurface(request: HestonSurfaceCalibrationInput): HestonSurfaceFit {
  validateClosedRequest('calibrateHestonSurface', request, CALIBRATE_HESTON_SURFACE_SPEC, {
    argumentName: 'request',
    subject: true,
    exampleCall: CALIBRATE_HESTON_SURFACE_EXAMPLE,
  });
  const { targets, market, options: options = {} } = request;
  requireCalibrationIterationBudget('calibrateHestonSurface', options.maximumIterations);
  requireHestonCosineTermCount('calibrateHestonSurface', options.terms);
  const { spot, riskFreeRate, dividendYield } = market;
  // ATM variance seed: the IV nearest each target's forward, squared (use the first target's scale).
  const atmVar = (() => {
    let best = targets[0]?.impliedVolatility ?? 0.2;
    let bestD = Infinity;
    for (const t of targets) {
      const d = Math.abs(t.strike - t.forward);
      if (d < bestD) {
        bestD = d;
        best = t.impliedVolatility;
      }
    }
    return Math.max(1e-4, best * best);
  })();

  const seedV0 = options.initialParameters?.v0 ?? atmVar;
  const seedTheta = options.initialParameters?.theta ?? atmVar;
  const seedKappa = options.initialParameters?.kappa ?? 2;
  const seedSigma = options.initialParameters?.sigma ?? 0.5;
  const seedRho = options.initialParameters?.rho ?? -0.5;
  const x0 = [
    Math.log(seedV0),
    Math.log(seedTheta),
    Math.log(seedKappa),
    Math.log(seedSigma),
    Math.atanh(clampRho(seedRho)),
  ];

  const cosOpts = { terms: options.terms ?? 128, greeks: false } as const;
  const toParams = (x: number[]): HestonParameters => ({
    v0: Math.exp(x[0]!),
    theta: Math.exp(x[1]!),
    kappa: Math.exp(x[2]!),
    sigma: Math.exp(x[3]!),
    rho: Math.tanh(x[4]!),
  });

  const objective = (x: number[]): number => {
    const p = toParams(x);
    let sse = 0;
    for (const tgt of targets) {
      let impliedVolatility;
      try {
        impliedVolatility = hestonImpliedVolatility({
          type: 'call',
          input: {
            spot,
            strike: tgt.strike,
            timeToExpiryYears: tgt.timeToExpiryYears,
            riskFreeRate,
            dividendYield,
          },
          parameters: p,
          options: cosOpts,
        });
      } catch {
        return 1e6;
      }
      // A non-converged inversion (below-intrinsic / unstable COS price) can't score the fit.
      if (
        !impliedVolatility.converged ||
        !Number.isFinite(impliedVolatility.value) ||
        impliedVolatility.value <= 0
      )
        return 1e6;
      sse += (impliedVolatility.value - tgt.impliedVolatility) ** 2;
    }
    return sse;
  };

  const rmseTolerance = options.rmseTolerance ?? 0.02;
  const maximumIterations = options.maximumIterations ?? 300;
  const res = nelderMead(objective, x0, { maximumIterations, tolerance: 1e-10 });
  const parameters = toParams(res.argMin);
  const rmse = Math.sqrt(res.minimum / targets.length);
  const converged = res.converged && rmse < rmseTolerance;
  const warnings: QuantWarning[] = [];
  if (!converged) {
    warnings.push({
      code: WarningCode.VolatilityCalibrationNotConverged,
      message: `calibrateHestonSurface: best-effort fit did not meet tolerance (rmse ${rmse.toExponential(
        3,
      )} vs rmseTolerance ${rmseTolerance}) — parameters are the best point found, gate on \`converged\` before trusting them.`,
      severity: 'warn',
      context: { rmse, rmseTolerance, maximumIterations },
    });
  }
  return {
    parameters,
    rmse,
    rmseTolerance,
    converged,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      targets: targets.length,
      maximumIterations,
      initialParameters: options.initialParameters !== undefined ? 'supplied' : 'default',
    },
    diagnostics: { warnings },
  };
}
