/**
 * SABR smile calibration (spec §10.1).
 *
 * Fits the three free SABR parameters `(α, ρ, ν)` — the backbone exponent `β` is fixed by the user
 * (0.5 for rates, ~1 for equities) since it is statistically hard to separate from `ρ` — to a single
 * expiry's market smile, using the Hagan implied-vol expansion from `@insiderfinance/totalfinance/options`. The fit is a
 * Levenberg–Marquardt least-squares over a reparameterization that keeps `α > 0`, `ρ ∈ (−1, 1)`,
 * `ν > 0` at every step; `α` is seeded from the at-the-money vol.
 */

import {
  type ClosedRequestSpecification,
  CONVENTIONS_VERSION,
  type Diagnostics,
  ErrorCode,
  InputError,
  type QuantWarning,
  WarningCode,
  ensurePositive,
  isQuantError,
  PostconditionError,
  validateClosedRequest,
  warning,
} from '@totalfinance/core';
import { levenbergMarquardt } from '@totalfinance/math';
import { type SabrParameters, type SabrVolatilityType } from '@totalfinance/options';
import { sabrVolatility } from '@totalfinance/options/sabr';
import { requireCalibrationIterationBudget } from './calibration-limits.js';
import { VALIDATION_SPECS } from './generated/validation-specs.js';

export interface SABRCalibrationOptions {
  /** Backbone exponent β ∈ [0, 1] (default 0.5). */
  beta?: number;
  /** Hagan expansion to fit against (default `'lognormal'`). */
  volatilityType?: SabrVolatilityType;
  /** LM iteration budget (default 200, maximum 10,000). */
  maximumIterations?: number;
  /** LM tolerance (default 1e-12). */
  tolerance?: number;
  /**
   * Warm start for the `(α, ρ, ν)` search (Stage 4.5); `β` stays an option and is never fitted.
   * Replaces the ATM-derived default start.
   */
  initialParameters?: { alpha: number; rho: number; nu: number };
}

export interface SABRCalibrationResult {
  parameters: SabrParameters;
  /** Root-mean-square implied-volatility error of the fit. */
  rmse: number;
  converged: boolean;
  iterations: number;
  /** Applied conventions, echoed (Law 2 report grammar). */
  assumptions: {
    conventionsVersion: string;
    beta: number;
    volatilityType: SabrVolatilityType;
    /** Whether the search began from a caller-supplied `initialParameters` or the ATM-derived default. */
    initialParameters: 'supplied' | 'default';
  };
  /** Structured warnings; a non-converged fit explains itself here. */
  diagnostics: Diagnostics;
}

/**
 * Generated closed-request specs (spec 3B.1b): allowlists projected from the declarations.
 * Resolved at module load so a stale key fails at import.
 */
function sabrSpecOf(key: string): ClosedRequestSpecification {
  const spec = VALIDATION_SPECS[key];
  if (spec === undefined) {
    throw new Error(
      `sabr: no generated validation spec for '${key}' — run \`pnpm validation:update\``,
    );
  }
  return spec;
}

const CALIBRATE_SABR_INPUT_SPEC = sabrSpecOf('calibrateSabrSmile#0');
const CALIBRATE_SABR_OPTIONS_SPEC = sabrSpecOf('calibrateSabrSmile#1');

const CALIBRATE_SABR_EXAMPLE = (): string =>
  'calibrateSabrSmile({ forward: 100, strikes: [90, 100, 110], ' +
  'impliedVolatilities: [0.22, 0.2, 0.21], timeToExpiryYears: 0.5 }, { beta: 0.5 })';

/**
 * Hagan's expansion is a small-time asymptotic: outside its validity region (`ρ² > 2/3` with a large
 * `ν²·T`, or a huge `α²/(F·K)^{1−β}` on a low shifted forward) its `1 + […]·T` bracket goes negative
 * and `sabrVolatility` REFUSES the point rather than returning a negative vol. The least-squares
 * search walks through parameter space, so it WILL probe such points — that must steer the optimizer,
 * not abort the calibration (and, before the options-side guard existed, must not be fitted against a
 * negative "volatility" either). Recognized by the guard's own `timeBracket` context.
 */
function outOfDomainBracket(error: unknown): number | undefined {
  // Narrow on BOTH the code and the guard's own `timeBracket` context: a plain out-of-range error
  // (a bad forward, a non-positive strike) is a real defect and must still surface.
  if (!isQuantError(error, ErrorCode.InputOutOfRange)) return undefined;
  const bracket = error.context?.['timeBracket'];
  return typeof bracket === 'number' ? bracket : undefined;
}

/** A parameter point the search evaluated with every strike inside Hagan's validity region. */
interface InDomainPoint {
  x: number[];
  sumSquared: number;
}

/** At-the-money implied vol: the market IV at the strike closest to the forward. */
function atmVolatility(forward: number, strikes: number[], impliedVolatilities: number[]): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const dist = Math.abs(Math.log(strikes[i]! / forward));
    if (dist < bestDist) {
      bestDist = dist;
      best = impliedVolatilities[i]!;
    }
  }
  return best;
}

/**
 * Calibrate `(α, ρ, ν)` of a SABR smile to market implied volatilities at a single expiry. Needs at least 3
 * strikes. Returns the full {@link SabrParameters} (including the fixed `β`), the fit RMSE, and convergence.
 */
/** Market smile input for {@link calibrateSabrSmile}: the forward, and aligned strikes/impliedVolatilities at one expiry. */
export interface SABRSmileInput {
  forward: number;
  strikes: number[];
  /** Implied volatilities aligned to `strikes` (annualized decimals). */
  impliedVolatilities: number[];
  /** Time to expiry in years. */
  timeToExpiryYears: number;
}

export function calibrateSabrSmile(
  input: SABRSmileInput,
  options: SABRCalibrationOptions = {},
): SABRCalibrationResult {
  // A natural wrong key ({ volatilities: … }) must teach the real slot names (did-you-mean
  // "impliedVolatilities"), not crash on `.length` — the spec rejects unknown keys first, then
  // enforces presence, types, and finiteness.
  validateClosedRequest('calibrateSabrSmile', input, CALIBRATE_SABR_INPUT_SPEC, {
    exampleCall: CALIBRATE_SABR_EXAMPLE,
  });
  // `null` slips past the `= {}` default and would die on the first option read — reject it typed.
  validateClosedRequest('calibrateSabrSmile', options, CALIBRATE_SABR_OPTIONS_SPEC, {
    argumentName: 'options',
    exampleCall: CALIBRATE_SABR_EXAMPLE,
  });
  requireCalibrationIterationBudget('calibrateSabrSmile', options.maximumIterations);
  const { forward, strikes, impliedVolatilities, timeToExpiryYears } = input;
  const functionName = 'calibrateSabrSmile';
  ensurePositive(forward, 'forward', functionName);
  ensurePositive(timeToExpiryYears, 'timeToExpiryYears', functionName);
  const n = strikes.length;
  if (n !== impliedVolatilities.length) {
    throw new InputError(
      `${functionName}: strikes and impliedVolatilities must have the same length (${n} vs ${impliedVolatilities.length}).`,
      {
        code: ErrorCode.InputOutOfRange,
        context: { strikes: n, impliedVolatilities: impliedVolatilities.length },
      },
    );
  }
  if (n < 3) {
    throw new InputError(`${functionName}: need ≥ 3 strikes to identify (α, ρ, ν), got ${n}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { strikes: n },
    });
  }
  for (let i = 0; i < n; i++) {
    ensurePositive(strikes[i]!, `strikes[${i}]`, functionName);
    ensurePositive(impliedVolatilities[i]!, `impliedVolatilities[${i}]`, functionName);
  }
  const beta = options.beta ?? 0.5;
  if (beta < 0 || beta > 1) {
    throw new InputError(`${functionName}: beta must be in [0, 1], got ${beta}.`, {
      code: ErrorCode.InputOutOfRange,
      context: { beta },
    });
  }
  const volatilityType = options.volatilityType ?? 'lognormal';

  // Seed α from the ATM vol, in the convention being fitted: Hagan's ATM lognormal is σ ≈ α/F^{1−β}
  // (⇒ α ≈ σ·F^{1−β}), but the ATM NORMAL is σ_N ≈ α·F^β (⇒ α ≈ σ_N/F^β). Using the lognormal
  // relation for a Bachelier fit is wrong by F^{1−2β} — a factor of 100 on a $100 forward at β=0.5 —
  // which starts the search deep outside Hagan's validity region.
  const atm = atmVolatility(forward, strikes, impliedVolatilities);
  const alpha0 =
    volatilityType === 'normal'
      ? Math.max(1e-8, atm / Math.pow(forward, beta))
      : Math.max(1e-4, atm * Math.pow(forward, 1 - beta));
  // Reparameterize so constraints hold for free: α=e^{x0}, ρ=tanh(x1), ν=e^{x2} — with the OPEN
  // interval enforced. `Math.tanh` saturates to exactly ±1 in IEEE-754 for |x| ≳ 19, and SABR requires
  // ρ ∈ (−1, 1) strictly: an LM step that far out made the pricer reject its own trial point
  // ("rho must be in (-1, 1), got -1") and killed the whole calibration. Same for α/ν, where
  // `Math.exp` overflows to Infinity (and underflows to 0) well inside the search's reach.
  const RHO_LIMIT = 1 - 1e-9;
  const clampToRange = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const toParams = (x: number[]): SabrParameters => ({
    alpha: clampToRange(Math.exp(x[0]!), 1e-12, 1e12),
    beta,
    rho: clampToRange(Math.tanh(x[1]!), -RHO_LIMIT, RHO_LIMIT),
    nu: clampToRange(Math.exp(x[2]!), 1e-12, 1e12),
  });
  // The residual SCALE (market vol units) sets the out-of-domain penalty: it must dwarf any real
  // residual so the optimizer leaves the region, while staying finite and monotone in how far out of
  // domain the point is (a flat penalty has no gradient and can strand the search on the boundary).
  const volatilityScale = Math.max(1e-4, impliedVolatilities.reduce((s, v) => s + v, 0) / n);
  const penaltyFor = (bracket: number): number =>
    10 * volatilityScale * (1 + Math.log1p(Math.max(0, 1 - bracket)));

  /** Model vols at `p`, or `undefined` when any strike is outside Hagan's validity region. */
  const modelVols = (p: SabrParameters): number[] | undefined => {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      try {
        out[i] = sabrVolatility({
          input: { forward, strike: strikes[i]!, timeToExpiryYears },
          parameters: p,
          options: { volatilityType },
        });
      } catch (e) {
        if (outOfDomainBracket(e) !== undefined) return undefined;
        throw e;
      }
    }
    return out;
  };

  // Best point the search actually EVALUATED inside the domain — the fallback if LM's final iterate
  // lands outside it, so this function never hands back parameters its own smile cannot evaluate.
  const bestInDomain: { point: InDomainPoint | null } = { point: null };
  let outOfDomainProbes = 0;
  const residuals = (x: number[]): number[] => {
    const p = toParams(x);
    let sumSquared = 0;
    let inDomain = true;
    const out = strikes.map((K, i) => {
      let model: number;
      try {
        model = sabrVolatility({
          input: { forward, strike: K, timeToExpiryYears },
          parameters: p,
          options: { volatilityType },
        });
      } catch (e) {
        const bracket = outOfDomainBracket(e);
        if (bracket === undefined) throw e;
        if (inDomain) outOfDomainProbes++; // count PARAMETER SETS, not strikes
        inDomain = false;
        return penaltyFor(bracket);
      }
      const r = model - impliedVolatilities[i]!;
      sumSquared += r * r;
      return r;
    });
    if (inDomain && (bestInDomain.point === null || sumSquared < bestInDomain.point.sumSquared)) {
      bestInDomain.point = { x: [...x], sumSquared };
    }
    return out;
  };

  const start = options.initialParameters;
  if (start !== undefined) {
    ensurePositive(start.alpha, 'initialParameters.alpha', functionName);
    ensurePositive(start.nu, 'initialParameters.nu', functionName);
    if (!Number.isFinite(start.rho) || !(Math.abs(start.rho) < 1)) {
      throw new InputError(
        `${functionName}: initialParameters.rho must be a finite correlation in (−1, 1). Received ${String(start.rho)}.`,
        { code: ErrorCode.InputOutOfRange, context: { field: 'initialParameters.rho' } },
      );
    }
  }
  const x0 =
    start !== undefined
      ? [Math.log(start.alpha), Math.atanh(start.rho), Math.log(start.nu)]
      : [Math.log(alpha0), Math.atanh(-0.3), Math.log(0.5)];
  const res = levenbergMarquardt(residuals, x0, {
    maximumIterations: options.maximumIterations ?? 200,
    tolerance: options.tolerance ?? 1e-12,
  });

  const warnings: QuantWarning[] = [];
  let parameters = toParams(res.parameters);
  const lmVols = modelVols(parameters);
  let vols: number[];
  let converged = res.converged;
  if (lmVols !== undefined) {
    vols = lmVols;
  } else {
    // LM finished outside Hagan's domain. Returning those parameters would hand back a smile that
    // THROWS when evaluated (or, worse, a negative vol on an older options build) — fall back to the
    // best in-domain point the search saw and say the fit did not converge.
    const feasible = bestInDomain.point;
    if (feasible === null) {
      throw new InputError(
        `${functionName}: every parameter set the search visited fell outside Hagan's ${volatilityType} expansion domain (its 1 + […]·T bracket goes non-positive), so no SABR smile can be fitted to this quote set. Shorten timeToExpiryYears, lower the quoted vols, or fit with volatilityType: '${volatilityType === 'normal' ? 'lognormal' : 'normal'}'.`,
        {
          code: ErrorCode.InputOutOfRange,
          context: { forward, timeToExpiryYears, beta, volatilityType },
        },
      );
    }
    parameters = toParams(feasible.x);
    const fallbackVols = modelVols(parameters);
    // `feasible` was recorded BECAUSE every strike evaluated there; a re-evaluation that now fails
    // would mean the pricer is not a pure function of its inputs.
    if (fallbackVols === undefined) {
      throw new PostconditionError(
        `${functionName}: a parameter set that evaluated inside Hagan's domain during the search no longer does on re-evaluation — this is a TotalFinance defect; please report it with these inputs.`,
        {
          code: ErrorCode.PostconditionNonFinite,
          context: { forward, timeToExpiryYears, beta, volatilityType },
        },
      );
    }
    vols = fallbackVols;
    converged = false;
    warnings.push(
      warning(
        WarningCode.VolatilityCalibrationNotConverged,
        `calibrateSabrSmile: the Levenberg–Marquardt search ended outside Hagan's ${volatilityType} expansion domain; the returned parameters are the best point it visited INSIDE the domain. Gate on \`converged\` before trusting them.`,
        'warn',
        { iterations: res.iterations, volatilityType },
      ),
    );
  }
  if (!converged && warnings.length === 0) {
    warnings.push(
      warning(
        WarningCode.VolatilityCalibrationNotConverged,
        `calibrateSabrSmile: the Levenberg–Marquardt fit stopped without converging — parameters are the best point found; gate on \`converged\` before trusting them.`,
        'warn',
        { iterations: res.iterations },
      ),
    );
  }
  if (outOfDomainProbes > 0) {
    // Disclosed, not silent: the search ran near (or through) the edge of Hagan's validity region.
    // The returned parameters are inside it, but a fit that had to be fenced away from the boundary
    // is a fit the caller should look at twice.
    warnings.push(
      warning(
        WarningCode.ModelLimitation,
        `calibrateSabrSmile: ${outOfDomainProbes} trial parameter set(s) fell outside Hagan's ${volatilityType} expansion domain and were penalized rather than fitted; the returned parameters are inside it.`,
        'info',
        { outOfDomainProbes, volatilityType },
      ),
    );
  }
  // RMSE from the RETURNED parameters (not the optimizer's last norm): after a domain fall-back those
  // are different points, and the reported error must describe what the caller actually gets.
  const rmse = Math.sqrt(vols.reduce((s, v, i) => s + (v - impliedVolatilities[i]!) ** 2, 0) / n);
  return {
    parameters,
    rmse,
    converged,
    iterations: res.iterations,
    assumptions: {
      conventionsVersion: CONVENTIONS_VERSION,
      beta,
      volatilityType,
      initialParameters: start !== undefined ? 'supplied' : 'default',
    },
    diagnostics: {
      engine: 'sabr',
      method: 'levenberg-marquardt + hagan',
      converged,
      iterations: res.iterations,
      warnings,
    },
  };
}
